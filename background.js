// MeetScribe background service worker

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

// State per Meet tab
const meetingSessions = new Map(); // tabId -> session object

// ── Tab lifecycle ──────────────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.url || !tab.url.startsWith('https://meet.google.com/')) return;

  if (changeInfo.status === 'complete') {
    if (!meetingSessions.has(tabId)) {
      startSession(tabId, tab.url);
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (meetingSessions.has(tabId)) {
    endSession(tabId, 'tab_closed');
  }
});

// Messages from content script and popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Content scripts supply sender.tab.id; popup supplies msg.tabId explicitly.
  const tabId = msg.tabId ?? sender.tab?.id;

  if (msg.type === 'MEET_JOINED' && tabId) {
    if (!meetingSessions.has(tabId)) {
      startSession(tabId, sender.tab.url);
    }
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
    const { tabId: recordTabId, streamId } = msg;
    getKeys().then(async (keys) => {
      if (!keys.deepgramKey) {
        sendResponse({ ok: false, error: 'No Deepgram API key — add it in Settings.' });
        return;
      }
      if (!meetingSessions.has(recordTabId)) {
        const tab = await new Promise((r) => chrome.tabs.get(recordTabId, r));
        startSession(recordTabId, tab?.url || '');
      }
      const session = meetingSessions.get(recordTabId);
      await ensureOffscreenDocument();
      chrome.runtime.sendMessage({
        type: 'START_CAPTURE',
        tabId: recordTabId,
        streamId,
        deepgramKey: keys.deepgramKey,
      });
      session.capturing = true;
      sendResponse({ ok: true });
    });
    return true; // async
  }

  if (msg.type === 'STOP_RECORDING') {
    const session = meetingSessions.get(msg.tabId);
    if (session) stopCapture(session);
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
  const session = {
    tabId,
    url,
    startTime: Date.now(),
    transcript: [],
    capturing: false,
  };
  meetingSessions.set(tabId, session);
}

async function endSession(tabId, reason) {
  const session = meetingSessions.get(tabId);
  if (!session) return;

  stopCapture(session);
  meetingSessions.delete(tabId);

  console.log(`[MeetScribe] Session ended (${reason}) — ${session.transcript.length} transcript lines`);

  if (session.transcript.length === 0) {
    console.log('[MeetScribe] No transcript captured, nothing to summarize');
    return;
  }

  const keys = await getKeys();

  if (!keys.anthropicKey) {
    console.warn('[MeetScribe] No Anthropic API key configured');
    await saveMeeting({
      id: `mtg_${Date.now()}`,
      url: session.url,
      startTime: session.startTime,
      endTime: Date.now(),
      transcript: session.transcript,
      summary: null,
      stepErrors: { summarization: 'No Anthropic API key — add it in Settings.' },
    });
    return;
  }

  let result;
  try {
    result = await summarize(session, keys.anthropicKey);
    console.log('[MeetScribe] Summarization OK — keys:', Object.keys(result).join(', '));
  } catch (err) {
    console.error('[MeetScribe] Summarization failed:', err);
    await saveMeeting({
      id: `mtg_${Date.now()}`,
      url: session.url,
      startTime: session.startTime,
      endTime: Date.now(),
      transcript: session.transcript,
      summary: null,
      stepErrors: { summarization: String(err) },
    });
    return;
  }

  const stepErrors = {};

  if (!keys.slackWebhook) {
    console.log('[MeetScribe] No Slack webhook configured — skipping');
  } else if (!result.slackDigest) {
    const msg = 'Claude response is missing the slackDigest field';
    console.warn('[MeetScribe]', msg);
    stepErrors.slack = msg;
  } else {
    console.log('[MeetScribe] Posting to Slack...');
    const slackErr = await postSlack(keys.slackWebhook, result.slackDigest, session.url);
    if (slackErr) {
      console.error('[MeetScribe] Slack delivery failed:', slackErr);
      stepErrors.slack = slackErr;
    } else {
      console.log('[MeetScribe] Slack delivery OK');
    }
  }

  await saveMeeting({
    id: `mtg_${Date.now()}`,
    url: session.url,
    startTime: session.startTime,
    endTime: Date.now(),
    transcript: session.transcript,
    ...result,
    stepErrors,
  });
}

function serializeSession(session) {
  if (!session) return null;
  return {
    tabId: session.tabId,
    url: session.url,
    startTime: session.startTime,
    capturing: session.capturing,
    lineCount: session.transcript.length,
  };
}

// ── Audio capture ──────────────────────────────────────────────────────────────

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL('offscreen.html');
  try {
    // hasDocument is available in Chrome 116+; fall back gracefully
    if (chrome.offscreen?.hasDocument) {
      const exists = await chrome.offscreen.hasDocument();
      if (exists) return;
    }
    await chrome.offscreen.createDocument({
      url,
      reasons: ['USER_MEDIA'],
      justification: 'Capture Meet tab audio for transcription',
    });
  } catch (e) {
    // "Only a single offscreen document may be created" — already exists, fine
  }
}

function stopCapture(session) {
  if (!session.capturing) return;
  chrome.runtime.sendMessage({ type: 'STOP_CAPTURE', tabId: session.tabId });
  session.capturing = false;
}

// Receive transcript lines from offscreen doc
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TRANSCRIPT_LINE') {
    const session = meetingSessions.get(msg.tabId);
    if (!session) return;
    const preview = msg.text.length > 80 ? msg.text.slice(0, 80) + '…' : msg.text;
    console.log(`[MeetScribe] Transcript [tab ${msg.tabId}] ${msg.speaker}: "${preview}"`);
    session.transcript.push({
      speaker: msg.speaker || 'Unknown',
      text: msg.text,
      timestamp: msg.timestamp,
    });
  }
});

// ── Summarization ──────────────────────────────────────────────────────────────

async function summarize(session, apiKey) {
  const duration = Math.round((Date.now() - session.startTime) / 60000);
  const transcriptText = session.transcript
    .map((l) => `[${formatTime(l.timestamp - session.startTime)}] ${l.speaker}: ${l.text}`)
    .join('\n');

  console.log(`[MeetScribe] Summarize: ${session.transcript.length} lines, ${transcriptText.length} chars, ~${duration} min`);

  const prompt = `You are a meeting assistant. Analyze the following meeting transcript and provide a structured response in JSON format.

Meeting URL: ${session.url}
Duration: ~${duration} minutes
Transcript:
${transcriptText}

Return a JSON object with exactly these keys:
{
  "summary": ["bullet1", "bullet2", "bullet3"],  // 3-5 bullet point summary
  "cleanTranscript": "...",  // cleaned-up, readable version of the transcript
  "actionItems": [  // array, may be empty
    { "item": "...", "owner": "...", "deadline": "..." }
  ],
  "slackDigest": "..."  // 5-line Slack-friendly summary starting with meeting title/date
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

  console.log(`[MeetScribe] Claude HTTP status: ${response.status}`);

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

// Returns null on success, or an error string on failure.
async function postSlack(webhookUrl, digest, meetUrl) {
  const payload = {
    text: `*MeetScribe Summary*\n${digest}\n<${meetUrl}|View Meeting>`,
  };
  // Mask the per-workspace token portion for safe logging
  const maskedUrl = webhookUrl.replace(/(\/services\/[^/]+\/[^/]+\/).*$/, '$1***');
  console.log(`[MeetScribe] Slack POST → ${maskedUrl}`);
  console.log(`[MeetScribe] Slack payload: ${JSON.stringify(payload).slice(0, 300)}`);
  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await resp.text();
    console.log(`[MeetScribe] Slack response — HTTP ${resp.status}, body: "${body}"`);
    if (!resp.ok) {
      return `HTTP ${resp.status}: "${body}"`;
    }
    return null; // success
  } catch (err) {
    console.error('[MeetScribe] Slack fetch threw:', err);
    return String(err);
  }
}

// ── Storage helpers ────────────────────────────────────────────────────────────

async function getKeys() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      ['deepgramKey', 'anthropicKey', 'slackWebhook'],
      resolve
    );
  });
}

async function getMeetings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['meetings'], (data) => {
      resolve(data.meetings || []);
    });
  });
}

async function saveMeeting(meeting) {
  const meetings = await getMeetings();
  meetings.unshift(meeting);
  // Keep last 50 meetings
  if (meetings.length > 50) meetings.splice(50);
  return new Promise((resolve) => {
    chrome.storage.local.set({ meetings }, resolve);
  });
}

async function deleteMeeting(id) {
  const meetings = await getMeetings();
  const filtered = meetings.filter((m) => m.id !== id);
  return new Promise((resolve) => {
    chrome.storage.local.set({ meetings: filtered }, resolve);
  });
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function formatTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
  const s = (totalSec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
