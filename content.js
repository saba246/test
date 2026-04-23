// Content script injected into meet.google.com pages.
// Detects join/leave events and handles microphone recording on demand.

(function () {
  'use strict';

  let hasJoined = false;
  let leaveObserver = null;

  // ── Mic recording state ────────────────────────────────────────────────────────
  let micStream = null;
  let mediaRecorder = null;
  let audioChunks = [];
  let recordingMimeType = '';

  // ── Message listener ───────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'START_MIC_CAPTURE') {
      startMicCapture()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => {
          console.error('[MeetScribe] startMicCapture error:', err);
          sendResponse({ error: err.message });
        });
      return true; // async
    }
    if (msg.type === 'STOP_MIC_CAPTURE') {
      stopMicCapture();
      sendResponse({ ok: true });
    }
  });

  async function startMicCapture() {
    if (mediaRecorder) {
      console.log('[MeetScribe] Already recording mic');
      return;
    }

    console.log('[MeetScribe] Requesting mic access...');
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    console.log('[MeetScribe] Mic access granted', micStream.getAudioTracks()[0]?.getSettings());

    recordingMimeType = pickMimeType();
    console.log(`[MeetScribe] MediaRecorder mimeType: ${recordingMimeType || '(browser default)'}`);

    const options = recordingMimeType ? { mimeType: recordingMimeType } : {};
    mediaRecorder = new MediaRecorder(micStream, options);
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      const finalMime = mediaRecorder.mimeType || recordingMimeType;
      const blob = new Blob(audioChunks, { type: finalMime });
      console.log(`[MeetScribe] Mic recording done: ${(blob.size / 1024).toFixed(1)} KB, ${blob.type}`);

      const audioBase64 = await blobToBase64(blob);
      chrome.runtime.sendMessage({ type: 'AUDIO_COMPLETE', audioBase64, mimeType: blob.type });

      micStream = null;
      mediaRecorder = null;
      audioChunks = [];
    };

    mediaRecorder.start(10_000);
    console.log('[MeetScribe] Mic MediaRecorder started');
  }

  function stopMicCapture() {
    if (!mediaRecorder) {
      console.log('[MeetScribe] stopMicCapture: no active recorder');
      return;
    }
    console.log('[MeetScribe] Stopping mic MediaRecorder');
    mediaRecorder.requestData();
    mediaRecorder.stop();
    micStream?.getTracks().forEach((t) => t.stop());
  }

  function pickMimeType() {
    return (
      ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(
        (t) => MediaRecorder.isTypeSupported(t)
      ) || ''
    );
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // ── Join/leave detection ───────────────────────────────────────────────────────

  function notifyJoined() {
    if (hasJoined) return;
    hasJoined = true;
    chrome.runtime.sendMessage({ type: 'MEET_JOINED' });
    watchForLeave();
  }

  function notifyLeft() {
    if (!hasJoined) return;
    hasJoined = false;
    chrome.runtime.sendMessage({ type: 'MEET_LEFT' });
    if (leaveObserver) {
      leaveObserver.disconnect();
      leaveObserver = null;
    }
  }

  function checkJoinState() {
    const leaveBtn = document.querySelector(
      '[aria-label*="Leave call"], [data-tooltip*="Leave call"], [aria-label*="leave"], button[jsname="CQylAd"]'
    );
    if (leaveBtn) notifyJoined();
  }

  function watchForLeave() {
    leaveObserver = new MutationObserver(() => {
      const leaveBtn = document.querySelector(
        '[aria-label*="Leave call"], [data-tooltip*="Leave call"], [aria-label*="leave"], button[jsname="CQylAd"]'
      );
      if (!leaveBtn && hasJoined) notifyLeft();
    });
    leaveObserver.observe(document.body, { childList: true, subtree: true });
  }

  const pollInterval = setInterval(() => {
    checkJoinState();
    if (hasJoined) clearInterval(pollInterval);
  }, 1500);

  const joinObserver = new MutationObserver(() => {
    if (!hasJoined) checkJoinState();
  });
  joinObserver.observe(document.body, { childList: true, subtree: true });

  window.addEventListener('beforeunload', () => {
    if (hasJoined) notifyLeft();
    clearInterval(pollInterval);
    joinObserver.disconnect();
    if (leaveObserver) leaveObserver.disconnect();
  });
})();
