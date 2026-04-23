// Content script injected into meet.google.com pages.
// Detects join/leave events, runs SpeechRecognition, and relays transcript lines
// to the background service worker.

(function () {
  'use strict';

  // ── Meeting detection ────────────────────────────────────────────────────────

  let hasJoined = false;
  let leaveObserver = null;

  function notifyJoined() {
    if (hasJoined) return;
    hasJoined = true;
    chrome.runtime.sendMessage({ type: 'MEET_JOINED' });
    watchForLeave();
  }

  function notifyLeft() {
    if (!hasJoined) return;
    hasJoined = false;
    stopTranscription();
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

  // ── SpeechRecognition ────────────────────────────────────────────────────────

  let recognition = null;
  let isTranscribing = false;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'START_SPEECH_REC') {
      const err = startTranscription();
      sendResponse(err ? { ok: false, error: err } : { ok: true });
    }
    if (msg.type === 'STOP_SPEECH_REC') {
      stopTranscription();
      sendResponse({ ok: true });
    }
  });

  function startTranscription() {
    if (isTranscribing) return null;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      const msg = 'SpeechRecognition is not available in this browser.';
      console.error('[MeetScribe]', msg);
      return msg;
    }

    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      isTranscribing = true;
      console.log('[MeetScribe] SpeechRecognition started');
    };

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (!event.results[i].isFinal) continue;
        const text = event.results[i][0].transcript.trim();
        if (!text) continue;
        console.log(`[MeetScribe] Speech result: "${text.slice(0, 80)}"`);
        chrome.runtime.sendMessage({
          type: 'TRANSCRIPT_LINE',
          speaker: 'You',
          text,
          timestamp: Date.now(),
        });
      }
    };

    recognition.onerror = (event) => {
      console.error('[MeetScribe] SpeechRecognition error:', event.error);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        // Microphone permission denied — stop trying
        isTranscribing = false;
        recognition = null;
        chrome.runtime.sendMessage({
          type: 'SPEECH_REC_ERROR',
          error: 'Microphone access denied. Allow the microphone for meet.google.com.',
        });
      }
      // For no-speech, aborted, network — onend will auto-restart
    };

    recognition.onend = () => {
      console.log('[MeetScribe] SpeechRecognition ended (isTranscribing=' + isTranscribing + ')');
      // SpeechRecognition stops on silence; restart if we're still recording
      if (isTranscribing) {
        try {
          recognition.start();
        } catch (e) {
          console.warn('[MeetScribe] Could not restart SpeechRecognition:', e.message);
        }
      }
    };

    try {
      recognition.start();
      return null; // no error
    } catch (e) {
      recognition = null;
      return e.message;
    }
  }

  function stopTranscription() {
    isTranscribing = false;
    if (recognition) {
      try { recognition.stop(); } catch (_) {}
      recognition = null;
    }
    console.log('[MeetScribe] SpeechRecognition stopped');
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────────

  window.addEventListener('beforeunload', () => {
    if (hasJoined) notifyLeft();
    clearInterval(pollInterval);
    joinObserver.disconnect();
    if (leaveObserver) leaveObserver.disconnect();
    stopTranscription();
  });
})();
