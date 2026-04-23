// MeetScribe options page

const fields = ['deepgramKey', 'anthropicKey', 'slackWebhook'];

function $(id) { return document.getElementById(id); }

// ── Load saved values ──────────────────────────────────────────────────────────

chrome.storage.sync.get(fields, (data) => {
  fields.forEach((f) => {
    const el = $(f);
    if (el && data[f]) el.value = data[f];
  });
});

// ── Save ───────────────────────────────────────────────────────────────────────

$('saveBtn').addEventListener('click', () => {
  const values = {};
  fields.forEach((f) => {
    const val = $(f)?.value.trim();
    if (val) values[f] = val;
  });

  chrome.storage.sync.set(values, () => {
    showToast('Settings saved!');
  });
});

// ── Clear data ─────────────────────────────────────────────────────────────────

$('clearDataBtn').addEventListener('click', () => {
  if (!confirm('Delete all saved meeting data? This cannot be undone.')) return;
  chrome.storage.local.remove('meetings', () => {
    showToast('Meeting data cleared.');
  });
});

// ── Toggle password visibility ─────────────────────────────────────────────────

document.querySelectorAll('.toggle-vis').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.target);
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
  });
});

// ── Toast ──────────────────────────────────────────────────────────────────────

function showToast(msg) {
  const toast = $('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
}
