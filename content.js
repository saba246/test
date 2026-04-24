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

    console.log('[MeetScribe] Calling getUserMedia({audio: true})...');
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    const tracks = micStream.getAudioTracks();
    console.log(`[MeetScribe] getUserMedia OK — ${tracks.length} audio track(s)`);
    tracks.forEach((t, i) =>
      console.log(`[MeetScribe]   track[${i}]: label="${t.label}", readyState=${t.readyState}, muted=${t.muted}`, t.getSettings())
    );

    // Prefer opus; fall back only if truly unsupported
    const preferredMime = 'audio/webm;codecs=opus';
    recordingMimeType = MediaRecorder.isTypeSupported(preferredMime)
      ? preferredMime
      : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
    console.log(`[MeetScribe] MediaRecorder mimeType: "${recordingMimeType || '(browser default)'}"`);

    const options = recordingMimeType ? { mimeType: recordingMimeType } : {};
    mediaRecorder = new MediaRecorder(micStream, options);
    audioChunks = [];
    let chunkIndex = 0;

    mediaRecorder.ondataavailable = (e) => {
      console.log(`[MeetScribe] ondataavailable chunk[${chunkIndex}]: ${e.data.size} bytes`);
      if (e.data.size > 0) audioChunks.push(e.data);
      chunkIndex++;
    };

    mediaRecorder.onstop = async () => {
      const finalMime = mediaRecorder.mimeType || recordingMimeType;
      const totalBytes = audioChunks.reduce((s, c) => s + c.size, 0);
      const blob = new Blob(audioChunks, { type: finalMime });
      console.log(`[MeetScribe] Recording stopped — ${audioChunks.length} chunks, ${totalBytes} bytes raw, blob.size=${blob.size} bytes (${(blob.size / 1024).toFixed(1)} KB), type="${blob.type}"`);

      const audioBase64 = await blobToBase64(blob);
      console.log(`[MeetScribe] base64 length: ${audioBase64.length} chars — waiting 2s for service worker to wake...`);

      // Service worker may be dormant; give it time to wake before sending.
      await new Promise((resolve) => setTimeout(resolve, 2000));

      console.log('[MeetScribe] Sending AUDIO_COMPLETE to background...');
      chrome.runtime.sendMessage(
        { type: 'AUDIO_COMPLETE', audioBase64, mimeType: blob.type },
        (res) => {
          if (chrome.runtime.lastError) {
            console.error('[MeetScribe] AUDIO_COMPLETE send failed:', chrome.runtime.lastError.message);
          } else {
            console.log('[MeetScribe] AUDIO_COMPLETE acknowledged by background:', res);
          }
        }
      );

      micStream = null;
      mediaRecorder = null;
      audioChunks = [];
    };

    // 1-second timeslice so ondataavailable fires every second for visibility
    mediaRecorder.start(1000);
    console.log('[MeetScribe] MediaRecorder started (1s timeslice), state:', mediaRecorder.state);
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
