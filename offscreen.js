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
  } catch (err) {
    console.error('MeetScribe offscreen getUserMedia error:', err);
    return;
  }

  const audioCtx = new AudioContext({ sampleRate: 16000 });
  const source = audioCtx.createMediaStreamSource(stream);

  await audioCtx.audioWorklet.addModule(chrome.runtime.getURL('pcm-processor.js'));
  const workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor');

  const ws = openDeepgramSocket(tabId, deepgramKey, audioCtx.sampleRate);

  workletNode.port.onmessage = (e) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const int16 = floatTo16BitPCM(e.data); // e.data is the transferred Float32Array
    ws.send(int16.buffer);
  };

  source.connect(workletNode);
  workletNode.connect(audioCtx.destination); // keeps the audio graph active

  activeCaptures.set(tabId, { stream, audioCtx, ws, workletNode, source });
}

function stopCapture(tabId) {
  const cap = activeCaptures.get(tabId);
  if (!cap) return;
  try {
    cap.workletNode.port.onmessage = null;
    cap.workletNode.disconnect();
    cap.source.disconnect();
    cap.audioCtx.close();
    cap.stream.getTracks().forEach((t) => t.stop());
    if (cap.ws.readyState === WebSocket.OPEN) cap.ws.close();
  } catch (e) {
    // ignore cleanup errors
  }
  activeCaptures.delete(tabId);
}

function openDeepgramSocket(tabId, apiKey, sampleRate) {
  const params = new URLSearchParams({
    encoding: 'linear16',
    sample_rate: sampleRate,
    channels: 1,
    model: 'nova-2',
    diarize: 'true',
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'false',
  });

  const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, [
    'token',
    apiKey,
  ]);

  ws.onopen = () => console.log('MeetScribe: Deepgram connected for tab', tabId);

  ws.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    const alt = data?.channel?.alternatives?.[0];
    if (!alt || !alt.transcript || alt.transcript.trim() === '') return;
    if (data.is_final === false) return;

    const words = alt.words || [];
    const speaker = words.length > 0 ? `Speaker ${words[0].speaker ?? 0}` : 'Unknown';

    chrome.runtime.sendMessage({
      type: 'TRANSCRIPT_LINE',
      tabId,
      speaker,
      text: alt.transcript.trim(),
      timestamp: Date.now(),
    });
  };

  ws.onerror = (e) => console.error('MeetScribe: Deepgram WS error', e);
  ws.onclose = (e) => console.log('MeetScribe: Deepgram WS closed', e.code, e.reason);

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
