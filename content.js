// Content script injected into meet.google.com pages
// Detects join/leave events and notifies background service worker.

(function () {
  'use strict';

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
    chrome.runtime.sendMessage({ type: 'MEET_LEFT' });
    if (leaveObserver) {
      leaveObserver.disconnect();
      leaveObserver = null;
    }
  }

  // Detect join: the "Leave call" button appears once inside the meeting
  function checkJoinState() {
    // Google Meet renders a leave/hang-up button with aria-label containing "Leave"
    const leaveBtn = document.querySelector(
      '[aria-label*="Leave call"], [data-tooltip*="Leave call"], [aria-label*="leave"], button[jsname="CQylAd"]'
    );
    if (leaveBtn) {
      notifyJoined();
    }
  }

  // Watch for the leave button to disappear (meeting ended) or URL change
  function watchForLeave() {
    leaveObserver = new MutationObserver(() => {
      const leaveBtn = document.querySelector(
        '[aria-label*="Leave call"], [data-tooltip*="Leave call"], [aria-label*="leave"], button[jsname="CQylAd"]'
      );
      if (!leaveBtn && hasJoined) {
        notifyLeft();
      }
    });
    leaveObserver.observe(document.body, { childList: true, subtree: true });
  }

  // Poll initially because the DOM may not have the button yet
  const pollInterval = setInterval(() => {
    checkJoinState();
    if (hasJoined) clearInterval(pollInterval);
  }, 1500);

  // Also observe DOM changes for SPA navigation within meet.google.com
  const joinObserver = new MutationObserver(() => {
    if (!hasJoined) checkJoinState();
  });
  joinObserver.observe(document.body, { childList: true, subtree: true });

  // Clean up on page unload
  window.addEventListener('beforeunload', () => {
    if (hasJoined) notifyLeft();
    clearInterval(pollInterval);
    joinObserver.disconnect();
    if (leaveObserver) leaveObserver.disconnect();
  });
})();
