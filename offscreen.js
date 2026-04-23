// Offscreen document: handles getUserMedia from tabCapture streamId,
// feeds PCM audio to Deepgram WebSocket, relays transcript back to background.

let activeCaptures = new Map(); // tabId -> { stream, audioCtx, ws, workletNode, source }

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START_CAPTURE') {
    startCapture(msg.tabId, msg.streamId, msg.deepgramKey);
    sendResponse({ ok: true });
  }
  if (msg.type === 'STOP_CAPTURE') {
    stopCapture(msg.tabId);
    sendResponse({ ok: true });
  }
});

async function startCapture(tabId, streamId, deepgramKey) {
  if (activeCaptures.has(tabId)) return;

  console.log(`[MeetScribe] startCapture [tab ${tabId}] streamId: ${streamId}`);

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
    const track = stream.getAudioTracks()[0];
    console.log(`[MeetScribe] getUserMedia OK [tab ${tabId}] — track: "${track?.label}", settings:`, track?.getSettings());
  } catch (err) {
    console.error(`[MeetScribe] getUserMedia FAILED [tab ${tabId}]:`, err.name, err.message);
    return;
  }

  const audioCtx = new AudioContext({ sampleRate: 16000 });
  console.log(`[MeetScribe] AudioContext sampleRate: ${audioCtx.sampleRate} Hz (requested 16000)`);

  const source = audioCtx.createMediaStreamSource(stream);

  await audioCtx.audioWorklet.addModule(chrome.runtime.getURL('pcm-processor.js'));
  const workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor');
  console.log(`[MeetScribe] AudioWorkletNode created [tab ${tabId}]`);

  const ws = openDeepgramSocket(tabId, deepgramKey, audioCtx.sampleRate);

  let chunksSent = 0;
  let bytesTotal = 0;
  let lastLogTime = Date.now();

  workletNode.port.onmessage = (e) => {
    if (ws.readyState !== WebSocket.OPEN) {
      // Log at most once every 2s while waiting for the socket to open
      const now = Date.now();
      if (now - lastLogTime > 2000) {
        console.log(`[MeetScribe] Audio chunk ready but WS not open (state=${ws.readyState}) [tab ${tabId}]`);
        lastLogTime = now;
      }
      return;
    }
    const int16 = floatTo16BitPCM(e.data);
    ws.send(int16.buffer);
    chunksSent++;
    bytesTotal += int16.byteLength;
    // Log first chunk, then every 20th (~5 s at 256 ms/chunk)
    if (chunksSent === 1 || chunksSent % 20 === 0) {
      console.log(`[MeetScribe] Sent chunk #${chunksSent} — ${int16.byteLength} B (total ${(bytesTotal / 1024).toFixed(1)} KB) [tab ${tabId}]`);
    }
  };

  source.connect(workletNode);
  workletNode.connect(audioCtx.destination); // keeps audio graph alive

  activeCaptures.set(tabId, { stream, audioCtx, ws, workletNode, source });
  console.log(`[MeetScribe] Capture pipeline ready [tab ${tabId}]`);
}

function stopCapture(tabId) {
  const cap = activeCaptures.get(tabId);
  if (!cap) return;
  console.log(`[MeetScribe] stopCapture [tab ${tabId}]`);
  try {
    cap.workletNode.port.onmessage = null;
    cap.workletNode.disconnect();
    cap.source.disconnect();
    cap.audioCtx.close();
    cap.stream.getTracks().forEach((t) => t.stop());
    if (cap.ws.readyState === WebSocket.OPEN) cap.ws.close(1000, 'Recording stopped');
  } catch (e) {
    // ignore cleanup errors
  }
  activeCaptures.delete(tabId);
}

// Human-readable WebSocket close codes for diagnostics
const WS_CLOSE_REASONS = {
  1000: 'Normal closure',
  1001: 'Going away',
  1002: 'Protocol error',
  1003: 'Unsupported data type',
  1006: 'Abnormal closure (no close frame — likely network or auth failure)',
  1007: 'Invalid frame payload',
  1008: 'Policy violation',
  1009: 'Message too large',
  1011: 'Internal server error',
  1015: 'TLS handshake failure',
};

function openDeepgramSocket(tabId, apiKey, sampleRate) {
  // IMPORTANT: Browser WebSockets cannot send custom headers (no Authorization header),
  // so the API key must go in the URL as a `token` query parameter.
  // Passing it as a WebSocket subprotocol (['token', key]) does NOT authenticate.
  const params = new URLSearchParams({
    token: apiKey,
    encoding: 'linear16',
    sample_rate: String(sampleRate),
    channels: '1',
    model: 'nova-2',
    diarize: 'true',
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'false',
  });

  const url = `wss://api.deepgram.com/v1/listen?${params}`;
  const maskedUrl = url.replace(/token=[^&]+/, 'token=***');
  console.log(`[MeetScribe] Deepgram URL [tab ${tabId}]: ${maskedUrl}`);

  // No subprotocol array — auth is handled by the token query param above
  const ws = new WebSocket(url);

  ws.binaryType = 'arraybuffer'; // send/receive raw binary

  ws.onopen = () => {
    console.log(`[MeetScribe] Deepgram WS OPEN [tab ${tabId}] — readyState: ${ws.readyState}`);
  };

  ws.onmessage = (event) => {
    const raw = typeof event.data === 'string' ? event.data : `[binary ${event.data.byteLength} B]`;
    console.log(`[MeetScribe] Deepgram message [tab ${tabId}]: ${raw.slice(0, 400)}`);

    if (typeof event.data !== 'string') return; // ignore binary frames

    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      console.warn(`[MeetScribe] Deepgram non-JSON [tab ${tabId}]:`, event.data);
      return;
    }

    // Surface any error or metadata messages (type != "Results")
    if (data.type && data.type !== 'Results') {
      console.warn(`[MeetScribe] Deepgram message type="${data.type}" [tab ${tabId}]:`, JSON.stringify(data));
      return;
    }

    const alt = data?.channel?.alternatives?.[0];
    if (!alt || !alt.transcript || alt.transcript.trim() === '') return;
    if (data.is_final === false) return;

    const words = alt.words || [];
    const speaker = words.length > 0 ? `Speaker ${words[0].speaker ?? 0}` : 'Unknown';
    const preview = alt.transcript.length > 80 ? alt.transcript.slice(0, 80) + '…' : alt.transcript;
    console.log(`[MeetScribe] Deepgram FINAL [tab ${tabId}] ${speaker}: "${preview}"`);

    chrome.runtime.sendMessage({
      type: 'TRANSCRIPT_LINE',
      tabId,
      speaker,
      text: alt.transcript.trim(),
      timestamp: Date.now(),
    });
  };

  ws.onerror = (e) => {
    // WebSocket error events carry no useful detail in browsers; the close event has the code
    console.error(`[MeetScribe] Deepgram WS ERROR [tab ${tabId}]`, e);
  };

  ws.onclose = (e) => {
    const desc = WS_CLOSE_REASONS[e.code] || 'Unknown';
    console.log(
      `[MeetScribe] Deepgram WS CLOSED [tab ${tabId}]` +
      ` — code: ${e.code} (${desc}), reason: "${e.reason}", wasClean: ${e.wasClean}`
    );
    if (e.code === 1006) {
      console.error('[MeetScribe] Code 1006 usually means the connection was refused or the API key is invalid.');
    }
    if (e.code === 1008) {
      console.error('[MeetScribe] Code 1008 (Policy violation) — API key is likely wrong or expired.');
    }
  };

  return ws;
}

function floatTo16BitPCM(float32Array) {
  const buf = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    buf[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return buf;
}
