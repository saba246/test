// MeetScribe popup script

const $ = (id) => document.getElementById(id);

let meetings = [];
let expandedCards = new Set();
let activeTabIds = new Set();

// ── Init ───────────────────────────────────────────────────────────────────────

async function init() {
  await loadMeetings();
  await checkActiveRecording();
  render();

  $('settingsBtn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Refresh every 5s in case a recording is active
  setInterval(async () => {
    await loadMeetings();
    await checkActiveRecording();
    render();
  }, 5000);
}

async function loadMeetings() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_MEETINGS' }, (res) => {
      meetings = res?.meetings || [];
      resolve();
    });
  });
}

async function checkActiveRecording() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
      if (!tabs || tabs.length === 0) {
        activeTabIds.clear();
        resolve();
        return;
      }
      let pending = tabs.length;
      activeTabIds.clear();
      tabs.forEach((tab) => {
        chrome.runtime.sendMessage({ type: 'GET_STATUS', tabId: tab.id }, (res) => {
          if (res?.active) activeTabIds.add(tab.id);
          pending--;
          if (pending === 0) resolve();
        });
      });
    });
  });
}

// ── Render ─────────────────────────────────────────────────────────────────────

function render() {
  const isRecording = activeTabIds.size > 0;
  const badge = $('recordingBadge');
  badge.classList.toggle('active', isRecording);

  const statusBar = $('statusBar');
  if (isRecording) {
    statusBar.classList.add('visible');
    statusBar.innerHTML = `<strong>Recording active</strong> — transcript is being captured in ${activeTabIds.size} meeting${activeTabIds.size > 1 ? 's' : ''}.`;
  } else {
    statusBar.classList.remove('visible');
  }

  const emptyState = $('emptyState');
  const list = $('meetingsList');

  if (meetings.length === 0) {
    emptyState.style.display = 'flex';
    list.innerHTML = '';
    return;
  }

  emptyState.style.display = 'none';
  list.innerHTML = '';
  meetings.forEach((m) => list.appendChild(buildCard(m)));
}

function buildCard(meeting) {
  const card = document.createElement('div');
  card.className = 'meeting-card' + (expandedCards.has(meeting.id) ? ' expanded' : '');
  card.dataset.id = meeting.id;

  const start = new Date(meeting.startTime);
  const durationMin = meeting.endTime
    ? Math.round((meeting.endTime - meeting.startTime) / 60000)
    : null;

  const meetCode = meeting.url?.match(/meet\.google\.com\/([a-z-]+)/)?.[1] || 'Meeting';

  const header = document.createElement('div');
  header.className = 'meeting-header';
  header.innerHTML = `
    <div class="meeting-meta">
      <div class="meeting-date">${formatDate(start)}</div>
      <div class="meeting-title">${escHtml(meetCode)}</div>
      <div class="meeting-stats">
        ${durationMin !== null ? `<span class="stat-chip">${durationMin}m</span>` : ''}
        ${meeting.transcript ? `<span class="stat-chip">${meeting.transcript.length} lines</span>` : ''}
        ${meeting.summary ? '<span class="stat-chip">Summarized</span>' : ''}
        ${meeting.error ? '<span class="stat-chip" style="color:#fca5a5;border-color:#7f1d1d">Error</span>' : ''}
      </div>
    </div>
    <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;">
      <button class="delete-btn" title="Delete">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>
          <path d="M9 6V4h6v2"/>
        </svg>
      </button>
      <svg class="card-toggle" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </div>
  `;

  header.querySelector('.delete-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    deleteMeeting(meeting.id);
  });

  header.addEventListener('click', (e) => {
    if (e.target.closest('.delete-btn')) return;
    toggleCard(meeting.id, card);
  });

  const body = document.createElement('div');
  body.className = 'meeting-body';
  body.appendChild(buildBody(meeting));

  card.appendChild(header);
  card.appendChild(body);
  return card;
}

function buildBody(meeting) {
  const wrap = document.createElement('div');

  if (meeting.error && !meeting.summary) {
    wrap.innerHTML = `<div class="tab-content"><div class="error-note">${escHtml(meeting.error)}</div></div>`;
    return wrap;
  }

  const tabs = [
    { id: 'summary', label: 'Summary' },
    { id: 'actions', label: 'Actions' },
    { id: 'transcript', label: 'Transcript' },
    { id: 'slack', label: 'Slack' },
  ];

  const tabBar = document.createElement('div');
  tabBar.className = 'tab-bar';

  const contentArea = document.createElement('div');
  contentArea.className = 'tab-content';

  tabs.forEach((t, i) => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (i === 0 ? ' active' : '');
    btn.textContent = t.label;
    btn.dataset.tab = t.id;
    btn.addEventListener('click', () => {
      tabBar.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      contentArea.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      contentArea.querySelector(`[data-panel="${t.id}"]`)?.classList.add('active');
    });
    tabBar.appendChild(btn);
  });

  // Summary panel
  const summaryPanel = document.createElement('div');
  summaryPanel.className = 'tab-panel active';
  summaryPanel.dataset.panel = 'summary';
  if (meeting.summary?.length) {
    summaryPanel.innerHTML = `<div class="section-label">Summary</div>
      <ul class="bullet-list">${meeting.summary.map((b) => `<li>${escHtml(b)}</li>`).join('')}</ul>`;
    summaryPanel.appendChild(copyBtn('Copy Summary', meeting.summary.map((b) => `• ${b}`).join('\n')));
  } else {
    summaryPanel.innerHTML = '<div style="color:#475569;font-size:12px;">No summary available.</div>';
  }

  // Actions panel
  const actionsPanel = document.createElement('div');
  actionsPanel.className = 'tab-panel';
  actionsPanel.dataset.panel = 'actions';
  if (meeting.actionItems?.length) {
    const items = meeting.actionItems.map((a) => `
      <div class="action-item">
        <div class="ai-text">${escHtml(a.item || '')}</div>
        <div class="ai-meta">
          ${a.owner ? `Owner: ${escHtml(a.owner)}` : ''}
          ${a.owner && a.deadline ? ' · ' : ''}
          ${a.deadline ? `Due: ${escHtml(a.deadline)}` : ''}
        </div>
      </div>`).join('');
    actionsPanel.innerHTML = `<div class="section-label">Action Items</div>${items}`;
    const copyText = meeting.actionItems
      .map((a) => `☐ ${a.item}${a.owner ? ` (${a.owner})` : ''}${a.deadline ? ` — ${a.deadline}` : ''}`)
      .join('\n');
    actionsPanel.appendChild(copyBtn('Copy Action Items', copyText));
  } else {
    actionsPanel.innerHTML = '<div style="color:#475569;font-size:12px;">No action items found.</div>';
  }

  // Transcript panel
  const transcriptPanel = document.createElement('div');
  transcriptPanel.className = 'tab-panel';
  transcriptPanel.dataset.panel = 'transcript';
  const cleanTx = meeting.cleanTranscript || formatRawTranscript(meeting.transcript);
  transcriptPanel.innerHTML = `<div class="section-label">Transcript</div>
    <div class="transcript-box">${escHtml(cleanTx)}</div>`;
  transcriptPanel.appendChild(copyBtn('Copy Transcript', cleanTx));

  // Slack panel
  const slackPanel = document.createElement('div');
  slackPanel.className = 'tab-panel';
  slackPanel.dataset.panel = 'slack';
  if (meeting.slackDigest) {
    slackPanel.innerHTML = `<div class="section-label">Slack Digest</div>
      <div class="slack-box">${escHtml(meeting.slackDigest)}</div>`;
    slackPanel.appendChild(copyBtn('Copy Slack Digest', meeting.slackDigest));
  } else {
    slackPanel.innerHTML = '<div style="color:#475569;font-size:12px;">No Slack digest available.</div>';
  }

  contentArea.append(summaryPanel, actionsPanel, transcriptPanel, slackPanel);
  wrap.appendChild(tabBar);
  wrap.appendChild(contentArea);
  return wrap;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function copyBtn(label, text) {
  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg> ${label}`;
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(text).then(() => {
      btn.classList.add('copied');
      btn.textContent = 'Copied!';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg> ${label}`;
      }, 2000);
    });
  });
  return btn;
}

function toggleCard(id, cardEl) {
  if (expandedCards.has(id)) {
    expandedCards.delete(id);
    cardEl.classList.remove('expanded');
  } else {
    expandedCards.add(id);
    cardEl.classList.add('expanded');
  }
}

function deleteMeeting(id) {
  chrome.runtime.sendMessage({ type: 'DELETE_MEETING', id }, () => {
    meetings = meetings.filter((m) => m.id !== id);
    expandedCards.delete(id);
    render();
  });
}

function formatDate(date) {
  return date.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatRawTranscript(lines) {
  if (!lines?.length) return 'No transcript captured.';
  return lines.map((l) => `[${formatTimestamp(l.timestamp)}] ${l.speaker}: ${l.text}`).join('\n');
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

init();
