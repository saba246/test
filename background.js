// MeetScribe background service worker

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const DEEPGRAM_REST_URL  = 'https://api.deepgram.com/v1/listen';
const CLAUDE_MODEL       = 'claude-sonnet-4-20250514';

const meetingSessions      = new Map(); // tabId -> session (while tab is live)
const pendingTranscriptions = new Map(); // tabId -> snapshot (awaiting AUDIO_COMPLETE)

// ── Tab lifecycle ──────────────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.url || !tab.url.startsWith('https://meet.google.com/')) return;
  if (changeInfo.status === 'complete' && !meetingSessions.has(tabId)) {
    startSession(tabId, tab.url);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (meetingSessions.has(tabId)) endSession(tabId, 'tab_closed');
});

// ── Messages ───────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = msg.tabId ?? sender.tab?.id;

  if (msg.type === 'MEET_JOINED' && tabId) {
    if (!meetingSessions.has(tabId)) startSession(tabId, sender.tab.url);
    sendResponse({ ok: true });
  }

  if (msg.type === 'MEET_LEFT' && tabId) {
    endSession(tabId, 'user_left');
    sendResponse({ ok: true });
  }

  if (msg.type === 'GET_STATUS') {
    sendResponse({
      active: meetingSessions.has(tabId),
      session: tabId ? serializeSession(meetingSessions.get(tabId)) : null,
    });
  }

  if (msg.type === 'START_RECORDING') {
    const { tabId: tid, streamId } = msg;
    (async () => {
      if (!meetingSessions.has(tid)) {
        const tab = await new Promise((r) => chrome.tabs.get(tid, r));
        startSession(tid, tab?.url || '');
      }
      const session = meetingSessions.get(tid);
      session.startTime = Date.now(); // reset to actual recording start
      await ensureOffscreenDocument();
      chrome.runtime.sendMessage({ type: 'START_CAPTURE', tabId: tid, streamId });
      session.capturing = true;
      console.log(`[MeetScribe] Recording started [tab ${tid}]`);
      sendResponse({ ok: true });
    })();
    return true; // async
  }

  if (msg.type === 'STOP_RECORDING') {
    // Trigger the full pipeline; endSession handles everything
    endSession(msg.tabId, 'user_stopped');
    sendResponse({ ok: true });
  }

  if (msg.type === 'AUDIO_COMPLETE') {
    const { tabId: audioTabId, audioBase64, mimeType } = msg;
    const sizeKB = Math.round(audioBase64.length * 0.75 / 1024);
    console.log(`[MeetScribe] AUDIO_COMPLETE [tab ${audioTabId}]: ~${sizeKB} KB, ${mimeType}`);

    const snap = pendingTranscriptions.get(audioTabId);
    if (!snap) {
      console.warn(`[MeetScribe] No pending session for tab ${audioTabId}`);
      sendResponse({ ok: true });
      return;
    }
    pendingTranscriptions.delete(audioTabId);
    processRecording(snap, audioBase64, mimeType); // async, fire-and-forget
    sendResponse({ ok: true });
  }

  if (msg.type === 'GET_MEETINGS') {
    getMeetings().then((meetings) => sendResponse({ meetings }));
    return true; // async
  }

  if (msg.type === 'DELETE_MEETING') {
    deleteMeeting(msg.id).then(() => sendResponse({ ok: true }));
    return true;
  }

  return true;
});

// ── Session management ─────────────────────────────────────────────────────────

function startSession(tabId, url) {
  meetingSessions.set(tabId, { tabId, url, startTime: Date.now(), capturing: false });
}

function endSession(tabId, reason) {
  const session = meetingSessions.get(tabId);
  if (!session) return;

  meetingSessions.delete(tabId);
  console.log(`[MeetScribe] Session ended (${reason}) — capturing: ${session.capturing}`);

  if (!session.capturing) {
    console.log('[MeetScribe] Was not recording — nothing to process');
    return;
  }

  // Stash snapshot; processRecording() picks it up once AUDIO_COMPLETE arrives
  pendingTranscriptions.set(tabId, { url: session.url, startTime: session.startTime });
  stopCapture(session);
}

function serializeSession(session) {
  if (!session) return null;
  return { tabId: session.tabId, url: session.url, startTime: session.startTime, capturing: session.capturing };
}

// ── Audio capture (offscreen document) ────────────────────────────────────────

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL('offscreen.html');
  try {
    if (chrome.offscreen?.hasDocument) {
      if (await chrome.offscreen.hasDocument()) return;
    }
    await chrome.offscreen.createDocument({
      url,
      reasons: ['USER_MEDIA'],
      justification: 'Record Meet tab audio for batch transcription',
    });
  } catch (e) {
    // "Only a single offscreen document may be created" — already open, fine
  }
}

function stopCapture(session) {
  if (!session.capturing) return;
  chrome.runtime.sendMessage({ type: 'STOP_CAPTURE', tabId: session.tabId });
  session.capturing = false;
}

// ── Transcription pipeline ─────────────────────────────────────────────────────

async function processRecording(snap, audioBase64, mimeType) {
  const keys = await getKeys();
  const base = {
    id: `mtg_${Date.now()}`,
    url: snap.url,
    startTime: snap.startTime,
    endTime: Date.now(),
    transcript: [],
  };

  if (!keys.deepgramKey) {
    console.warn('[MeetScribe] No Deepgram API key');
    await saveMeeting({ ...base, summary: null, stepErrors: { transcription: 'No Deepgram API key — add it in Settings.' } });
    return;
  }

  let transcript;
  try {
    transcript = await transcribeAudio(audioBase64, mimeType, keys.deepgramKey, snap.startTime);
    console.log(`[MeetScribe] Transcription: ${transcript.length} utterances`);
  } catch (err) {
    console.error('[MeetScribe] Transcription failed:', err);
    await saveMeeting({ ...base, summary: null, stepErrors: { transcription: String(err) } });
    return;
  }

  if (!transcript.length) {
    console.log('[MeetScribe] No speech detected in recording');
    await saveMeeting({ ...base, summary: null, stepErrors: {} });
    return;
  }

  if (!keys.anthropicKey) {
    console.warn('[MeetScribe] No Anthropic API key');
    await saveMeeting({ ...base, transcript, summary: null, stepErrors: { summarization: 'No Anthropic API key — add it in Settings.' } });
    return;
  }

  let result;
  try {
    result = await summarize({ url: snap.url, startTime: snap.startTime, transcript }, keys.anthropicKey);
    console.log('[MeetScribe] Summarization OK — keys:', Object.keys(result).join(', '));
  } catch (err) {
    console.error('[MeetScribe] Summarization failed:', err);
    await saveMeeting({ ...base, transcript, summary: null, stepErrors: { summarization: String(err) } });
    return;
  }

  const stepErrors = {};
  if (!keys.slackWebhook) {
    console.log('[MeetScribe] No Slack webhook — skipping');
  } else if (!result.slackDigest) {
    const m = 'Claude response missing slackDigest field';
    console.warn('[MeetScribe]', m);
    stepErrors.slack = m;
  } else {
    console.log('[MeetScribe] Posting to Slack...');
    const slackErr = await postSlack(keys.slackWebhook, result.slackDigest, snap.url);
    if (slackErr) {
      console.error('[MeetScribe] Slack failed:', slackErr);
      stepErrors.slack = slackErr;
    } else {
      console.log('[MeetScribe] Slack OK');
    }
  }

  await saveMeeting({ ...base, transcript, ...result, stepErrors });
}

// Converts a base64 audio blob to a Deepgram transcript utterance array.
async function transcribeAudio(audioBase64, mimeType, apiKey, sessionStartTime) {
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const sizeKB = Math.round(bytes.length / 1024);
  console.log(`[MeetScribe] Deepgram REST: POSTing ${sizeKB} KB of ${mimeType}`);

  const params = new URLSearchParams({
    model: 'nova-2',
    diarize: 'true',
    punctuate: 'true',
    smart_format: 'true',
  });

  let response;
  try {
    response = await fetch(`${DEEPGRAM_REST_URL}?${params}`, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': mimeType,
      },
      body: bytes,
    });
  } catch (fetchErr) {
    console.error('[MeetScribe] Deepgram fetch threw (network error):', fetchErr);
    throw fetchErr;
  }

  console.log(`[MeetScribe] Deepgram HTTP status: ${response.status} ${response.statusText}`);
  console.log('[MeetScribe] Deepgram response headers:', Object.fromEntries(response.headers.entries()));

  const rawBody = await response.text();
  console.log(`[MeetScribe] Deepgram raw response body (first 2000 chars):\n${rawBody.slice(0, 2000)}`);

  if (!response.ok) {
    console.error(`[MeetScribe] Deepgram error — status ${response.status}, body: ${rawBody}`);
    throw new Error(`Deepgram ${response.status}: ${rawBody.slice(0, 200)}`);
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (parseErr) {
    console.error('[MeetScribe] Deepgram response is not valid JSON:', parseErr);
    throw new Error(`Deepgram response parse error: ${parseErr.message}`);
  }

  console.log('[MeetScribe] Deepgram metadata:', JSON.stringify(data.metadata ?? {}));
  console.log('[MeetScribe] Deepgram results.channels length:', data.results?.channels?.length ?? 'undefined');

  const alt = data.results?.channels?.[0]?.alternatives?.[0];
  console.log('[MeetScribe] Deepgram first alternative keys:', alt ? Object.keys(alt).join(', ') : 'undefined');
  console.log('[MeetScribe] Deepgram transcript text:', alt?.transcript ?? '(none)');

  const words = alt?.words || [];
  console.log(`[MeetScribe] Deepgram: ${words.length} words returned`);
  if (words.length > 0) {
    console.log('[MeetScribe] Deepgram first word sample:', JSON.stringify(words[0]));
  }

  return wordsToUtterances(words, sessionStartTime);
}

// Groups consecutive same-speaker words into utterances.
function wordsToUtterances(words, sessionStartTime) {
  if (!words.length) return [];

  const utterances = [];
  let currSpeaker = words[0].speaker ?? 0;
  let currWords   = [];
  let currStart   = words[0].start ?? 0;

  for (const word of words) {
    const speaker = word.speaker ?? 0;
    if (speaker !== currSpeaker) {
      utterances.push({
        speaker: `Speaker ${currSpeaker}`,
        text: currWords.join(' '),
        timestamp: sessionStartTime + Math.round(currStart * 1000),
      });
      currSpeaker = speaker;
      currWords   = [word.punctuated_word || word.word];
      currStart   = word.start ?? 0;
    } else {
      currWords.push(word.punctuated_word || word.word);
    }
  }
  if (currWords.length) {
    utterances.push({
      speaker: `Speaker ${currSpeaker}`,
      text: currWords.join(' '),
      timestamp: sessionStartTime + Math.round(currStart * 1000),
    });
  }
  return utterances;
}

// ── Summarization ──────────────────────────────────────────────────────────────

async function summarize(session, apiKey) {
  const duration = Math.round((Date.now() - session.startTime) / 60000);
  const transcriptText = session.transcript
    .map((l) => `[${formatTime(l.timestamp - session.startTime)}] ${l.speaker}: ${l.text}`)
    .join('\n');

  console.log(`[MeetScribe] Summarize: ${session.transcript.length} utterances, ~${duration} min`);

  const prompt = `You are a meeting assistant. Analyze the following meeting transcript and provide a structured response in JSON format.

Meeting URL: ${session.url}
Duration: ~${duration} minutes
Transcript:
${transcriptText}

Return a JSON object with exactly these keys:
{
  "summary": ["bullet1", "bullet2", "bullet3"],
  "cleanTranscript": "...",
  "actionItems": [
    { "item": "...", "owner": "...", "deadline": "..." }
  ],
  "slackDigest": "..."
}

Return ONLY valid JSON, no markdown code fences.`;

  console.log(`[MeetScribe] Claude fetch — model: ${CLAUDE_MODEL}, prompt: ${prompt.length} chars`);

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  console.log(`[MeetScribe] Claude HTTP: ${response.status}`);

  if (!response.ok) {
    const err = await response.text();
    console.error('[MeetScribe] Claude error body:', err);
    throw new Error(`Anthropic API ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data.content[0]?.text || '';
  console.log(`[MeetScribe] Claude response (first 300 chars): ${text.slice(0, 300)}`);

  try {
    const result = JSON.parse(text);
    console.log('[MeetScribe] JSON parse OK — keys:', Object.keys(result).join(', '));
    return result;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      console.log('[MeetScribe] JSON extracted from surrounding text');
      return JSON.parse(match[0]);
    }
    throw new Error('Could not parse Claude response as JSON');
  }
}

// ── Slack delivery ─────────────────────────────────────────────────────────────

async function postSlack(webhookUrl, digest, meetUrl) {
  const payload = { text: `*MeetScribe Summary*\n${digest}\n<${meetUrl}|View Meeting>` };
  const maskedUrl = webhookUrl.replace(/(\/services\/[^/]+\/[^/]+\/).*$/, '$1***');
  console.log(`[MeetScribe] Slack POST → ${maskedUrl}`);
  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await resp.text();
    console.log(`[MeetScribe] Slack response — HTTP ${resp.status}, body: "${body}"`);
    return resp.ok ? null : `HTTP ${resp.status}: "${body}"`;
  } catch (err) {
    console.error('[MeetScribe] Slack fetch threw:', err);
    return String(err);
  }
}

// ── Storage helpers ────────────────────────────────────────────────────────────

async function getKeys() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['deepgramKey', 'anthropicKey', 'slackWebhook'], resolve);
  });
}

async function getMeetings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['meetings'], (data) => resolve(data.meetings || []));
  });
}

async function saveMeeting(meeting) {
  const meetings = await getMeetings();
  meetings.unshift(meeting);
  if (meetings.length > 50) meetings.splice(50);
  return new Promise((resolve) => chrome.storage.local.set({ meetings }, resolve));
}

async function deleteMeeting(id) {
  const meetings = await getMeetings();
  const filtered = meetings.filter((m) => m.id !== id);
  return new Promise((resolve) => chrome.storage.local.set({ meetings: filtered }, resolve));
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function formatTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
  const s = (totalSec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
