import { updateClock } from "./modules/utils.js";

let _autoTimer = null;

// -- Helpers ----------------------------------------------------------

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtTime(epoch) {
  if (!epoch) return '--';
  return new Date(epoch * 1000).toLocaleTimeString('sv-SE');
}

// -- Fetch ------------------------------------------------------------

async function runTests() {
  const r = await fetch('/api/test/run');
  return r.json();
}

// -- Render -----------------------------------------------------------

function render(data) {
  const page = document.getElementById('page');
  page.innerHTML = '';

  const s = data.sammanfattning;

  // Summary bar
  const summary = document.createElement('div');
  summary.className = 'summary';
  summary.innerHTML = `
    <div class="summary-pill ok">
      <span class="count">${s.ok}</span>
      <span class="label">OK</span>
    </div>
    <div class="summary-pill warn">
      <span class="count">${s.warn}</span>
      <span class="label">Varningar</span>
    </div>
    <div class="summary-pill fail">
      <span class="count">${s.fail}</span>
      <span class="label">Fel</span>
    </div>
    <div class="summary-pill">
      <span class="count count-total">${s.totalt}</span>
      <span class="label">Totalt</span>
    </div>
  `;
  page.appendChild(summary);

  // Category cards
  for (const kat of data.kategorier) {
    page.appendChild(buildCategory(kat));
  }

  // Timestamp
  const ts = document.createElement('div');
  ts.className = 'timestamp';
  ts.textContent = 'Testat: ' + fmtTime(data.tidpunkt);
  page.appendChild(ts);
}

function buildCategory(kat) {
  const checks = kat.kontroller;
  const okCount = checks.filter(c => c.status === 'ok').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;
  const failCount = checks.filter(c => c.status === 'fail').length;

  const card = document.createElement('div');
  card.className = 'card';

  // Auto-collapse categories where everything is OK
  if (failCount === 0 && warnCount === 0) {
    card.classList.add('collapsed');
  }

  const header = document.createElement('div');
  header.className = 'card-header';

  let metaParts = [];
  if (okCount > 0) metaParts.push(okCount + ' ok');
  if (warnCount > 0) metaParts.push(warnCount + ' varningar');
  if (failCount > 0) metaParts.push(failCount + ' fel');

  header.innerHTML = `
    <span class="arrow">&#9660;</span>
    <h2>${esc(kat.namn)}</h2>
    <span class="meta">${metaParts.join(' / ')}</span>
  `;
  header.addEventListener('click', () => {
    card.classList.toggle('collapsed');
  });

  const body = document.createElement('div');
  body.className = 'card-body';

  for (const check of checks) {
    const row = document.createElement('div');
    row.className = 'check-row';
    const msgClass = check.status === 'fail' ? 'fail' : check.status === 'warn' ? 'warn' : '';
    row.innerHTML = `
      <span class="check-dot ${check.status}"></span>
      <span class="check-namn">${esc(check.namn)}</span>
      <span class="check-msg ${msgClass}">${esc(check.meddelande)}</span>
    `;
    if (check.detaljer) {
      const toggle = document.createElement('span');
      toggle.className = 'detail-toggle';
      toggle.textContent = 'detaljer';
      const detail = document.createElement('div');
      detail.className = 'check-detail hidden';
      detail.textContent = JSON.stringify(check.detaljer, null, 2);
      toggle.addEventListener('click', () => {
        detail.classList.toggle('hidden');
      });
      row.appendChild(toggle);
      row.appendChild(detail);
    }
    body.appendChild(row);
  }

  card.appendChild(header);
  card.appendChild(body);
  return card;
}

// -- Main loop --------------------------------------------------------

async function refresh() {
  const page = document.getElementById('page');
  try {
    const data = await runTests();
    render(data);
  } catch (e) {
    page.innerHTML = `<div class="error-msg">Fel: ${esc(String(e))}</div>`;
  }
}

// Refresh button
document.getElementById('refresh-btn').addEventListener('click', refresh);

// Auto-refresh toggle
const autoCheckbox = document.getElementById('auto-refresh');
autoCheckbox.addEventListener('change', () => {
  if (autoCheckbox.checked) {
    _autoTimer = setInterval(refresh, 30000);
  } else {
    clearInterval(_autoTimer);
    _autoTimer = null;
  }
});

// Clock
const clockEl = document.getElementById('clock');
setInterval(() => updateClock(clockEl), 1000);
updateClock(clockEl);

// Initial run
refresh();
