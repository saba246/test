// Offscreen document: captures tab audio via getUserMedia, records it with
// MediaRecorder, then on STOP_CAPTURE encodes the full blob to base64 and
// sends AUDIO_COMPLETE to the background service worker.

let activeCaptures = new Map(); // tabId -> { stream, mediaRecorder, chunks }

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

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
      },
      video: false,
    });
    const settings = stream.getAudioTracks()[0]?.getSettings();
    console.log(`[MeetScribe] getUserMedia OK [tab ${tabId}]`, settings);
  } catch (err) {
    console.error(`[MeetScribe] getUserMedia FAILED [tab ${tabId}]:`, err.name, err.message);
    return;
  }

  const mimeType = pickMimeType();
  console.log(`[MeetScribe] MediaRecorder mimeType: ${mimeType || '(browser default)'}`);

  const options = mimeType ? { mimeType } : {};
  const mediaRecorder = new MediaRecorder(stream, options);
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

  activeCaptures.set(tabId, { stream, mediaRecorder, chunks });
}

function stopCapture(tabId) {
  const cap = activeCaptures.get(tabId);
  if (!cap) return;
  console.log(`[MeetScribe] Stopping MediaRecorder [tab ${tabId}]`);
  // Request any buffered data before stopping
  cap.mediaRecorder.requestData();
  cap.mediaRecorder.stop();
  cap.stream.getTracks().forEach((t) => t.stop());
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
