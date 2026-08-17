/* KlickPint — admin dashboard */
'use strict';

const $ = (id) => document.getElementById(id);
const loginWrap = $('loginWrap');
const admin     = $('admin');

let autoTimer = null;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showLogin() {
  loginWrap.style.display = 'flex';
  admin.classList.remove('ready');
  clearInterval(autoTimer);
}

function showAdmin() {
  loginWrap.style.display = 'none';
  admin.classList.add('ready');
  loadAll();
  scheduleAuto();
}

/* ── Auth ──────────────────────────────────────────────────────────────── */
async function checkSession() {
  try {
    const r = await fetch('/api/admin/session');
    const j = await r.json();
    if (j.authenticated) showAdmin(); else showLogin();
  } catch (_) {
    showLogin();
  }
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('loginBtn');
  const err = $('loginErr');
  err.classList.remove('show');
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    const r = await fetch('/api/admin/login', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ password: $('pw').value }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      err.textContent = j.error || 'Sign-in failed.';
      err.classList.add('show');
      return;
    }
    $('pw').value = '';
    showAdmin();
  } catch (_) {
    err.textContent = 'Cannot reach the server.';
    err.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

$('logoutBtn').addEventListener('click', async () => {
  try { await fetch('/api/admin/logout', { method: 'POST' }); } catch (_) {}
  showLogin();
});

/* ── Data loading ──────────────────────────────────────────────────────── */
async function loadSummary() {
  const r = await fetch('/api/admin/summary');
  if (r.status === 401) return showLogin();
  const s = await r.json();

  $('statTotal').textContent   = s.totalDownloads.toLocaleString();
  $('statToday').textContent   = s.todayDownloads.toLocaleString();
  $('statFetches').textContent = s.todayFetches.toLocaleString();
  $('statIPs').textContent     = s.activeIPs.toLocaleString();
  $('statBanned').textContent = s.bannedIPs.toLocaleString();
  $('statCache').textContent  = `${s.cache.size}/${s.cache.maxSize}`;
  $('statMem').textContent    = s.memory;

  const st = $('pinterestStatus');
  if (s.pinterestHealth.ok) {
    st.innerHTML = '<span class="dot ok"></span> Pinterest OK';
  } else {
    st.innerHTML = `<span class="dot down"></span> Cooling down (${s.pinterestHealth.cooldownLeft}s left)`;
  }
}

function buildQuery() {
  const params = new URLSearchParams();
  const q = $('fSearch').value.trim();
  const event = $('fEvent').value;
  const success = $('fSuccess').value;
  if (q) params.set('q', q);
  if (event) params.set('event', event);
  if (success) params.set('success', success);
  params.set('limit', '150');
  return params.toString();
}

async function loadActivity() {
  const r = await fetch('/api/admin/activity?' + buildQuery());
  if (r.status === 401) return showLogin();
  const { total, entries } = await r.json();

  $('actCount').textContent = `${entries.length} shown of ${total} matching`;
  $('actEmpty').style.display = entries.length ? 'none' : 'block';

  $('actBody').innerHTML = entries.map(rowHtml).join('');
}

function rowHtml(e) {
  const time = new Date(e.ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const eventBadge = e.event === 'download'
    ? '<span class="badge badge-event download">Download</span>'
    : '<span class="badge badge-event">Fetch</span>';
  const outcome = e.success
    ? '<span class="badge badge-ok">OK</span>'
    : `<span class="badge badge-fail" title="${esc(e.error || '')}">Failed</span>`;
  const pinLink = e.pinId
    ? `<a href="https://www.pinterest.com/pin/${esc(e.pinId)}/" target="_blank" rel="noopener noreferrer">#${esc(e.pinId)}</a>`
    : '<span style="color:var(--text-3)">—</span>';

  return `<tr>
    <td class="ts">${esc(time)}</td>
    <td>${eventBadge}</td>
    <td class="ip">${esc(e.ip || '—')}</td>
    <td class="pin">${pinLink}</td>
    <td class="title">${esc(e.title || (e.event === 'download' ? '' : '') || '—')}</td>
    <td>${esc(e.label || (e.qualities != null ? e.qualities + ' options' : '—'))}</td>
    <td>${outcome}</td>
  </tr>`;
}

async function loadAll() {
  try {
    await Promise.all([loadSummary(), loadActivity()]);
  } catch (_) {
    toast('Failed to load admin data', 'err');
  }
}

/* ── Filters + auto-refresh ───────────────────────────────────────────── */
let searchDebounce;
$('fSearch').addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(loadActivity, 300);
});
$('fEvent').addEventListener('change', loadActivity);
$('fSuccess').addEventListener('change', loadActivity);
$('refreshBtn').addEventListener('click', loadAll);

function scheduleAuto() {
  clearInterval(autoTimer);
  if (!$('fAuto').checked) return;
  autoTimer = setInterval(() => {
    if (document.visibilityState === 'visible') loadAll();
  }, 8000);
}
$('fAuto').addEventListener('change', scheduleAuto);

checkSession();
