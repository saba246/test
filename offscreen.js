// Offscreen document: captures tab audio + microphone, mixes them with
// AudioContext, records the mix with MediaRecorder, then on STOP_CAPTURE
// encodes the full blob to base64 and sends AUDIO_COMPLETE to the background.

let activeCaptures = new Map(); // tabId -> { tabStream, micStream, audioCtx, mediaRecorder, chunks }

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START_CAPTURE') {
    startCapture(msg.tabId, msg.streamId);
    sendResponse({ ok: true });
  }
  if (msg.type === 'STOP_CAPTURE') {
    stopCapture(msg.tabId);
    sendResponse({ ok: true });
  }
});

async function startCapture(tabId, streamId) {
  if (activeCaptures.has(tabId)) return;

  // ── Tab audio ────────────────────────────────────────────────────────────────
  let tabStream;
  try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
      },
      video: false,
    });
    console.log(`[MeetScribe] Tab stream OK [tab ${tabId}]`, tabStream.getAudioTracks()[0]?.getSettings());
  } catch (err) {
    console.error(`[MeetScribe] Tab getUserMedia FAILED [tab ${tabId}]:`, err.name, err.message);
    return;
  }

  // ── Microphone audio ─────────────────────────────────────────────────────────
  let micStream = null;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    console.log(`[MeetScribe] Mic stream OK [tab ${tabId}]`, micStream.getAudioTracks()[0]?.getSettings());
  } catch (err) {
    // Mic permission denied or unavailable — continue with tab audio only
    console.warn(`[MeetScribe] Mic getUserMedia failed [tab ${tabId}] (${err.name}): recording tab audio only`);
  }

  // ── Mix both sources with AudioContext ───────────────────────────────────────
  const audioCtx = new AudioContext();
  const destination = audioCtx.createMediaStreamDestination();

  audioCtx.createMediaStreamSource(tabStream).connect(destination);
  if (micStream) {
    audioCtx.createMediaStreamSource(micStream).connect(destination);
  }
  console.log(`[MeetScribe] AudioContext mixing: tab${micStream ? ' + mic' : ' only'}`);

  // ── Record the mixed stream ──────────────────────────────────────────────────
  const mimeType = pickMimeType();
  console.log(`[MeetScribe] MediaRecorder mimeType: ${mimeType || '(browser default)'}`);

  const options = mimeType ? { mimeType } : {};
  const mediaRecorder = new MediaRecorder(destination.stream, options);
  const chunks = [];

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    const finalMime = mediaRecorder.mimeType || mimeType;
    const blob = new Blob(chunks, { type: finalMime });
    console.log(`[MeetScribe] Recording done [tab ${tabId}]: ${(blob.size / 1024).toFixed(1)} KB, ${blob.type}`);

    const audioBase64 = await blobToBase64(blob);
    console.log(`[MeetScribe] Sending AUDIO_COMPLETE [tab ${tabId}]`);
    chrome.runtime.sendMessage({
      type: 'AUDIO_COMPLETE',
      tabId,
      audioBase64,
      mimeType: blob.type,
    });
  };

  // Collect a chunk every 10 s so we have data even if onstop fires late
  mediaRecorder.start(10_000);
  console.log(`[MeetScribe] MediaRecorder started [tab ${tabId}]`);

  activeCaptures.set(tabId, { tabStream, micStream, audioCtx, mediaRecorder, chunks });
}

function stopCapture(tabId) {
  const cap = activeCaptures.get(tabId);
  if (!cap) return;
  console.log(`[MeetScribe] Stopping MediaRecorder [tab ${tabId}]`);
  cap.mediaRecorder.requestData();
  cap.mediaRecorder.stop();
  cap.tabStream.getTracks().forEach((t) => t.stop());
  cap.micStream?.getTracks().forEach((t) => t.stop());
  cap.audioCtx.close();
  activeCaptures.delete(tabId);
}

function pickMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]); // strip data:...;base64, prefix
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
