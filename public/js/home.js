/* KlickPint — downloader */
'use strict';

const $ = (id) => document.getElementById(id);

const urlInput = $('urlInput');
const clearBtn = $('clearBtn');
const pasteBtn = $('pasteBtn');
const fetchBtn = $('fetchBtn');
const alertBox = $('alertBox');
const alertMsg = $('alertMsg');
const result   = $('result');

let busy = false;          // a download is running
let inflight = null;       // AbortController for the current /api/fetch

const PIN_RE = /(?:pinterest\.[a-z.]+|pin\.it)\//i;

/* ── Input helpers ─────────────────────────────────────────────────────── */
function hideAlert() { alertBox.classList.remove('show'); }
function showAlert(msg) {
  alertMsg.textContent = msg;
  alertBox.classList.add('show');
}

urlInput.addEventListener('input', () => {
  clearBtn.style.display = urlInput.value ? 'flex' : 'none';
  hideAlert();
});

clearBtn.addEventListener('click', () => {
  urlInput.value = '';
  clearBtn.style.display = 'none';
  hideAlert();
  urlInput.focus();
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); fetchBtn.click(); }
});

pasteBtn.addEventListener('click', async () => {
  try {
    const text = (await navigator.clipboard.readText() || '').trim();
    if (!text) return toast('Clipboard is empty', 'err');
    urlInput.value = text;
    clearBtn.style.display = 'flex';
    hideAlert();
    toast('Link pasted', 'ok');
    // A disabled button never fires a synthetic click, so if a fetch is
    // already running this would silently no-op — the link sits in the
    // input with no feedback that auto-submit didn't happen.
    if (PIN_RE.test(text) && !fetchBtn.disabled) fetchBtn.click();
  } catch (_) {
    urlInput.focus();
    toast('Press Ctrl+V / ⌘V to paste', 'err');
  }
});

function setLoading(on) {
  fetchBtn.disabled = on;
  fetchBtn.classList.toggle('is-loading', on);
  $('btnText').textContent = on ? 'Fetching video…' : 'Get Video';
}

/* ── Fetch ─────────────────────────────────────────────────────────────── */
fetchBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  hideAlert();

  if (!url) {
    showAlert('Paste a Pinterest link first.');
    urlInput.focus();
    return;
  }
  if (!PIN_RE.test(url)) {
    showAlert("That doesn't look like a Pinterest link. Use a pinterest.com or pin.it URL.");
    return;
  }

  if (inflight) inflight.abort();
  inflight = new AbortController();
  const timer = setTimeout(() => inflight && inflight.abort(), 30000);

  setLoading(true);
  result.classList.remove('show');

  try {
    const res = await fetch('/api/fetch', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ url }),
      signal : inflight.signal,
    });

    let json = {};
    try { json = await res.json(); } catch (_) {}

    if (!res.ok || !json.success) {
      showAlert(json.error || `Request failed (${res.status}). Please try again.`);
      return;
    }

    render(json.data);
    toast('Video ready', 'ok');
  } catch (err) {
    if (err.name === 'AbortError') showAlert('Request timed out. Please try again.');
    else showAlert('Cannot reach the server. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
    inflight = null;
    setLoading(false);
  }
});

/* ── Render result ─────────────────────────────────────────────────────── */
const SUBTITLE = {
  '1080p': 'Full HD',
  '720p' : 'HD Ready',
  '480p' : 'Standard',
  '360p' : 'Data saver',
  'HD'   : 'High quality',
};

function render(d) {
  $('resultTitle').textContent = d.title || 'Pinterest Video';

  /* tags */
  const tags = [];
  if (d.qualities.some((q) => q.label === '1080p')) tags.push(['pill-ok', 'Full HD available']);
  else if (d.qualities.some((q) => q.label === '720p')) tags.push(['pill-ok', 'HD available']);
  if (d.duration) tags.push(['', d.duration]);
  tags.push(['', 'MP4']);
  $('resultTags').innerHTML =
    '<span class="pill pill-brand">Pinterest</span>' +
    tags.map(([cls, txt]) => `<span class="pill ${cls}">${esc(txt)}</span>`).join('');

  /* thumbnail */
  const img   = $('thumbImg');
  const empty = $('thumbEmpty');
  const badge = $('thumbBadge');
  badge.style.display = d.duration ? 'block' : 'none';
  badge.textContent   = d.duration || '';
  img.onerror = () => { img.style.display = 'none'; empty.style.display = 'flex'; };
  if (d.thumbnail) {
    img.style.display = 'block';
    empty.style.display = 'none';
    img.alt = (d.title || 'Pinterest video') + ' thumbnail';
    img.src = d.thumbnail;
  } else {
    img.removeAttribute('src');
    img.style.display = 'none';
    empty.style.display = 'flex';
  }

  /* quality buttons */
  const grid = $('qualGrid');
  grid.innerHTML = '';
  $('qualCount').textContent = d.qualities.length + (d.qualities.length === 1 ? ' option' : ' options');

  d.qualities.forEach((q, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'q' + (i === 0 ? ' best' : '');
    btn.setAttribute('aria-label', `Download ${q.label} MP4`);
    btn.innerHTML =
      `<span><span class="l">${esc(q.label)}</span>` +
      `<span class="s">${esc(SUBTITLE[q.label] || 'Video')} · MP4</span></span>` +
      `<span class="ic" aria-hidden="true">` +
      `<svg viewBox="0 0 24 24"><path d="M12 3v13"/><path d="m7 12 5 5 5-5"/><path d="M4 21h16"/></svg>` +
      `</span>`;
    btn.addEventListener('click', () => download(q, d));
    grid.appendChild(btn);
  });

  result.classList.add('show');
  requestAnimationFrame(() => {
    result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ── Download ──────────────────────────────────────────────────────────── */
const prog       = $('prog');
const progFill   = $('progFill');
const progPct    = $('progPct');
const progStatus = $('progStatus');
const progTrack  = document.querySelector('.prog-track');

function setPct(p) {
  const v = Math.max(0, Math.min(100, Math.round(p)));
  progFill.classList.remove('indet');
  progFill.style.width = v + '%';
  progPct.textContent  = v + '%';
  progTrack.setAttribute('aria-valuenow', String(v));
}

function setIndeterminate() {
  progFill.classList.add('indet');
  progPct.textContent = '';
  progTrack.removeAttribute('aria-valuenow');
}

function finish(msg, label) {
  progFill.classList.remove('indet');
  progFill.classList.add('done');
  progFill.style.width = '100%';
  progPct.textContent  = '100%';
  progTrack.setAttribute('aria-valuenow', '100');
  progStatus.textContent = msg;
  if (label) toast(`${label} saved`, 'ok');
  setTimeout(() => { prog.classList.remove('show'); busy = false; }, 2800);
}

function buildFilename(title, label) {
  const slug = (title || 'pinterest-video')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'pinterest-video';
  return `klickpint-${slug}-${label}.mp4`;
}

function saveBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60000);
}

// Reads a fetch() Response body into a Blob while updating the progress
// bar from real byte counts. Throws if the response isn't OK/streamable —
// callers decide what to do next.
async function streamToBlob(endpoint, label) {
  const res = await fetch(endpoint);
  if (!res.ok || !res.body) throw new Error(`stream unavailable (${res.status})`);

  const total  = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;

  if (!total) setIndeterminate();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) setPct((received / total) * 100);
    else progStatus.textContent = `Downloading ${label}… ${(received / 1048576).toFixed(1)} MB`;
  }

  return new Blob(chunks, { type: 'video/mp4' });
}

async function download(q, d) {
  if (busy) return toast('A download is already running');
  if (!q.url) return toast('Download link unavailable', 'err');

  busy = true;
  const filename = buildFilename(d.title, q.label);
  const base    = `/api/download?url=${encodeURIComponent(q.url)}&filename=${encodeURIComponent(filename)}`;
  // Default: a 302 straight to Pinterest's CDN — zero bytes through our
  // server. fetch() can only read progress from it if the CDN allows a
  // cross-origin body read; if that's blocked, ?proxy=1 streams the same
  // file through our own server instead (always same-origin, so it always
  // works, at the cost of using our bandwidth for that one file).
  const direct  = base;
  const proxied = `${base}&proxy=1`;

  progFill.classList.remove('done');
  progFill.style.width = '0%';
  progStatus.textContent = `Downloading ${q.label}…`;
  setPct(0);
  prog.classList.add('show');

  try {
    let blob;
    try {
      blob = await streamToBlob(direct, q.label);
    } catch (_) {
      setPct(0);
      blob = await streamToBlob(proxied, q.label);
    }
    saveBlob(blob, filename);
    finish('Saved to your device', q.label);
  } catch (_) {
    // Last resort: hand the URL to the browser's own download manager.
    // Never throws in a way that leaves `busy` stuck — the timeout below
    // always runs and always calls finish().
    try {
      setIndeterminate();
      progStatus.textContent = 'Opening download…';
      const a = document.createElement('a');
      a.href = direct;
      a.rel = 'noopener';
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      console.error('download fallback failed', err);
    } finally {
      setTimeout(() => finish('Download started in your browser', q.label), 1600);
    }
  }
}
