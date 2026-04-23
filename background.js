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

// Messages from content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

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
    transcript: [], // { speaker, text, timestamp }
    rawLines: [],
    mediaStream: null,
    audioContext: null,
    processor: null,
    ws: null,
    capturing: false,
  };
  meetingSessions.set(tabId, session);
  beginCapture(tabId);
}

async function endSession(tabId, reason) {
  const session = meetingSessions.get(tabId);
  if (!session) return;

  stopCapture(session);
  meetingSessions.delete(tabId);

  if (session.transcript.length === 0) return;

  const keys = await getKeys();
  if (!keys.anthropicKey) {
    saveMeeting({
      id: `mtg_${Date.now()}`,
      url: session.url,
      startTime: session.startTime,
      endTime: Date.now(),
      transcript: session.transcript,
      summary: null,
      error: 'No Anthropic API key configured',
    });
    return;
  }

  try {
    const result = await summarize(session, keys.anthropicKey);
    const meeting = {
      id: `mtg_${Date.now()}`,
      url: session.url,
      startTime: session.startTime,
      endTime: Date.now(),
      transcript: session.transcript,
      ...result,
    };
    await saveMeeting(meeting);

    if (keys.slackWebhook && result.slackDigest) {
      await postSlack(keys.slackWebhook, result.slackDigest, session.url);
    }
  } catch (err) {
    console.error('MeetScribe summarize error:', err);
    saveMeeting({
      id: `mtg_${Date.now()}`,
      url: session.url,
      startTime: session.startTime,
      endTime: Date.now(),
      transcript: session.transcript,
      summary: null,
      error: String(err),
    });
  }
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

async function beginCapture(tabId) {
  const session = meetingSessions.get(tabId);
  if (!session) return;

  const keys = await getKeys();
  if (!keys.deepgramKey) {
    console.warn('MeetScribe: no Deepgram key, skipping capture for tab', tabId);
    return;
  }

  try {
    // tabCapture must be called from a user-gesture context or via getMediaStreamId
    // In MV3 we use chrome.tabCapture.getMediaStreamId then pass to offscreen doc
    const streamId = await getTabCaptureStreamId(tabId);
    if (!streamId) return;

    // Open/reuse offscreen document for audio processing
    await ensureOffscreenDocument();

    chrome.runtime.sendMessage({
      type: 'START_CAPTURE',
      tabId,
      streamId,
      deepgramKey: keys.deepgramKey,
    });

    session.capturing = true;
  } catch (err) {
    console.error('MeetScribe capture error:', err);
  }
}

function getTabCaptureStreamId(tabId) {
  return new Promise((resolve) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      resolve(streamId || null);
    });
  });
}

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

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data.content[0]?.text || '';

  try {
    return JSON.parse(text);
  } catch {
    // Try to extract JSON from text
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Could not parse Claude response as JSON');
  }
}

// ── Slack delivery ─────────────────────────────────────────────────────────────

async function postSlack(webhookUrl, digest, meetUrl) {
  const body = {
    text: `*MeetScribe Summary*\n${digest}\n<${meetUrl}|View Meeting>`,
  };
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('MeetScribe Slack post error:', err);
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
