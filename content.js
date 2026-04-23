// Content script injected into meet.google.com pages.
// Detects join/leave events and notifies the background service worker.

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
