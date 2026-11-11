/* KlickPint — downloader */
'use strict';

const $ = (id) => document.getElementById(id);

/* ── UI strings ────────────────────────────────────────────────────────────
   The page's <html lang> picks the table. Server errors carry a `code`, which
   is translated here; the server's English `error` text is the fallback. */
const STRINGS = {
  en: {
    clipEmpty: 'Clipboard is empty', pasted: 'Link pasted', pasteKeys: 'Press Ctrl+V / ⌘V to paste',
    fetching: 'Fetching video…', getVideo: 'Get Video',
    needLink: 'Paste a Pinterest link first.',
    notPin: "That doesn't look like a Pinterest link. Use a pinterest.com or pin.it URL.",
    failed: (s) => `Request failed (${s}). Please try again.`,
    ready: 'Ready to download', timeout: 'Request timed out. Please try again.',
    offline: 'Cannot reach the server. Check your connection and try again.',
    sub: { '1080p': 'Full HD', '720p': 'HD Ready', '480p': 'Standard', '360p': 'Data saver', HD: 'High quality' },
    previewNA: 'Preview unavailable for this video', untitled: 'Pinterest Video', thumbAlt: 'thumbnail',
    fullHd: 'Full HD available', hd: 'HD available', image: 'Image',
    chooseQ: 'Choose a quality', chooseS: 'Choose a size',
    options: (n) => n + (n === 1 ? ' option' : ' options'),
    video: 'Video', animated: 'Animated',
    dlLabel: (l, k) => `Download ${l} ${k}`, copyLabel: (l) => `Copy direct link for ${l}`, copyTitle: 'Copy direct link',
    copied: 'Direct link copied', copyFail: 'Could not copy. Long-press the download button instead.',
    saved: (l) => `${l} saved`, busy: 'A download is already running', noLink: 'Download link unavailable',
    downloading: (l) => `Downloading ${l}…`, savedDevice: 'Saved to your device',
    opening: 'Opening download…', startedBrowser: 'Download started in your browser',
    errors: {},
  },
  pt: {
    clipEmpty: 'A área de transferência está vazia', pasted: 'Link colado', pasteKeys: 'Pressione Ctrl+V / ⌘V para colar',
    fetching: 'Buscando vídeo…', getVideo: 'Baixar Vídeo',
    needLink: 'Cole um link do Pinterest primeiro.',
    notPin: 'Isso não parece um link do Pinterest. Use um link pinterest.com ou pin.it.',
    failed: (s) => `A solicitação falhou (${s}). Tente novamente.`,
    ready: 'Pronto para baixar', timeout: 'O tempo da solicitação esgotou. Tente novamente.',
    offline: 'Não foi possível conectar ao servidor. Verifique sua internet e tente novamente.',
    sub: { '1080p': 'Full HD', '720p': 'HD', '480p': 'Padrão', '360p': 'Economia de dados', HD: 'Alta qualidade' },
    previewNA: 'Prévia indisponível para este vídeo', untitled: 'Vídeo do Pinterest', thumbAlt: 'miniatura',
    fullHd: 'Full HD disponível', hd: 'HD disponível', image: 'Imagem',
    chooseQ: 'Escolha a qualidade', chooseS: 'Escolha o tamanho',
    options: (n) => n + (n === 1 ? ' opção' : ' opções'),
    video: 'Vídeo', animated: 'Animado',
    dlLabel: (l, k) => `Baixar ${l} ${k}`, copyLabel: (l) => `Copiar link direto de ${l}`, copyTitle: 'Copiar link direto',
    copied: 'Link direto copiado', copyFail: 'Não foi possível copiar. Mantenha pressionado o botão de download.',
    saved: (l) => `${l} salvo`, busy: 'Já existe um download em andamento', noLink: 'Link de download indisponível',
    downloading: (l) => `Baixando ${l}…`, savedDevice: 'Salvo no seu dispositivo',
    opening: 'Abrindo download…', startedBrowser: 'Download iniciado no navegador',
    errors: {
      INVALID_URL      : 'Digite um link válido do Pinterest.',
      NO_MEDIA         : 'Este pin não tem vídeo ou imagem para baixar. Ele pode ser privado ou só de texto.',
      PINTEREST_BLOCKED: 'O Pinterest recusou a solicitação. O pin pode ser privado ou o Pinterest está limitando o acesso. Tente de novo em alguns minutos.',
      TIMEOUT          : 'O Pinterest demorou demais para responder. Tente novamente.',
      FETCH_FAILED     : 'Não foi possível buscar este pin. Tente novamente.',
      RATE_LIMIT       : (j) => `Você atingiu o limite por hora. Tente novamente em ${Math.ceil((j.retryAfter || 3600) / 60)} min.`,
    },
  },
};
const T = STRINGS[(document.documentElement.lang || 'en').slice(0, 2).toLowerCase()] || STRINGS.en;

function errorText(json, status) {
  const e = json && json.code && T.errors[json.code];
  if (e) return typeof e === 'function' ? e(json) : e;
  return (json && (json.error && json.error !== 'ABUSE_DETECTED' ? json.error : json.message)) || T.failed(status);
}

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
    if (!text) return toast(T.clipEmpty, 'err');
    urlInput.value = text;
    clearBtn.style.display = 'flex';
    hideAlert();
    toast(T.pasted, 'ok');
    // A disabled button never fires a synthetic click, so if a fetch is
    // already running this would silently no-op — the link sits in the
    // input with no feedback that auto-submit didn't happen.
    if (PIN_RE.test(text) && !fetchBtn.disabled) fetchBtn.click();
  } catch (_) {
    urlInput.focus();
    toast(T.pasteKeys, 'err');
  }
});

// The page's own button text ("Get Video", "Get Image", "Get GIF") is the idle
// label; a page can also set data-busy for the loading text.
const BTN_IDLE = $('btnText').textContent.trim() || T.getVideo;
const BTN_BUSY = fetchBtn.dataset.busy || T.fetching;

function setLoading(on) {
  fetchBtn.disabled = on;
  fetchBtn.classList.toggle('is-loading', on);
  $('btnText').textContent = on ? BTN_BUSY : BTN_IDLE;
}

/* ── Fetch ─────────────────────────────────────────────────────────────── */
fetchBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  hideAlert();

  if (!url) {
    showAlert(T.needLink);
    urlInput.focus();
    return;
  }
  if (!PIN_RE.test(url)) {
    showAlert(T.notPin);
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
      showAlert(errorText(json, res.status));
      return;
    }

    render(json.data);
    toast(T.ready, 'ok');
  } catch (err) {
    if (err.name === 'AbortError') showAlert(T.timeout);
    else showAlert(T.offline);
  } finally {
    clearTimeout(timer);
    inflight = null;
    setLoading(false);
  }
});

/* ── Render result ─────────────────────────────────────────────────────── */
const SUBTITLE = T.sub;

function formatSize(bytes) {
  if (!bytes) return '';
  return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

const MIME = { mp4: 'video/mp4', gif: 'image/gif', png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

const previewBtn   = $('previewBtn');
const previewVideo = $('previewVideo');

function resetPreview() {
  previewVideo.pause();
  previewVideo.removeAttribute('src');
  previewVideo.load();
  previewVideo.style.display = 'none';
}

previewBtn.addEventListener('click', () => {
  const src = previewBtn.dataset.src;
  if (!src) return;
  previewVideo.src = src;
  previewVideo.style.display = 'block';
  previewBtn.style.display = 'none';
  previewVideo.play().catch(() => {});
});

previewVideo.addEventListener('error', () => {
  resetPreview();
  previewBtn.style.display = 'none';
  toast(T.previewNA, 'err');
});

function render(d) {
  $('resultTitle').textContent = d.title || T.untitled;
  const isVideo = d.mediaType === 'video';
  const first   = d.qualities[0];

  /* tags */
  const tags = [];
  if (isVideo && d.qualities.some((q) => q.label === '1080p')) tags.push(['pill-ok', T.fullHd]);
  else if (isVideo && d.qualities.some((q) => q.label === '720p')) tags.push(['pill-ok', T.hd]);
  if (d.duration) tags.push(['', d.duration]);
  tags.push(['', d.mediaType === 'gif' ? 'GIF' : isVideo ? 'MP4' : T.image]);
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
    img.alt = (d.title || T.untitled) + ' ' + T.thumbAlt;
    img.src = d.thumbnail;
  } else {
    img.removeAttribute('src');
    img.style.display = 'none';
    empty.style.display = 'flex';
  }

  /* preview: the smallest video file, so it starts fast */
  resetPreview();
  const previewQ = isVideo ? (d.qualities.find((q) => q.label === '480p') || d.qualities[d.qualities.length - 1]) : null;
  previewBtn.dataset.src = previewQ ? previewQ.url : '';
  previewBtn.style.display = previewQ ? 'flex' : 'none';
  if (previewQ && !d.thumbnail) empty.style.display = 'none';

  /* quality buttons */
  const grid = $('qualGrid');
  grid.innerHTML = '';
  document.querySelector('.qual-head .t').textContent = isVideo ? T.chooseQ : T.chooseS;
  $('qualCount').textContent = T.options(d.qualities.length);

  d.qualities.forEach((q, i) => {
    const kind = (q.ext || 'mp4').toUpperCase();
    const desc = isVideo ? (SUBTITLE[q.label] || T.video) : (q.tag || (q.type === 'gif' ? T.animated : T.image));
    const sub  = [desc, kind, formatSize(q.size)].filter(Boolean).join(' · ');

    const wrap = document.createElement('div');
    wrap.className = 'q-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'q' + (i === 0 ? ' best' : '');
    btn.setAttribute('aria-label', T.dlLabel(q.label, kind));
    btn.innerHTML =
      `<span><span class="l">${esc(q.label)}</span>` +
      `<span class="s">${esc(sub)}</span></span>` +
      `<span class="ic" aria-hidden="true">` +
      `<svg viewBox="0 0 24 24"><path d="M12 3v13"/><path d="m7 12 5 5 5-5"/><path d="M4 21h16"/></svg>` +
      `</span>`;
    btn.addEventListener('click', () => download(q, d));

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'q-copy';
    copy.setAttribute('aria-label', T.copyLabel(q.label));
    copy.title = T.copyTitle;
    copy.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(q.url);
        toast(T.copied, 'ok');
      } catch (_) {
        toast(T.copyFail, 'err');
      }
    });

    wrap.append(btn, copy);
    grid.appendChild(wrap);
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
  if (label) toast(T.saved(label), 'ok');
  setTimeout(() => { prog.classList.remove('show'); busy = false; }, 2800);
}

function buildFilename(title, label, ext) {
  const slug = (title || 'pinterest-video')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'pinterest-video';
  return `klickpint-${slug}-${label.toLowerCase()}.${ext || 'mp4'}`;
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
async function streamToBlob(endpoint, label, mime) {
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
    else progStatus.textContent = `${T.downloading(label)} ${(received / 1048576).toFixed(1)} MB`;
  }

  return new Blob(chunks, { type: mime });
}

async function download(q, d) {
  if (busy) return toast(T.busy);
  if (!q.url) return toast(T.noLink, 'err');

  busy = true;
  const mime     = MIME[q.ext] || 'application/octet-stream';
  const filename = buildFilename(d.title, q.label, q.ext);
  const base    = `/api/download?url=${encodeURIComponent(q.url)}&filename=${encodeURIComponent(filename)}`
    + (d.pinId ? `&pinId=${encodeURIComponent(d.pinId)}` : '')
    + `&label=${encodeURIComponent(q.label)}`;
  // Default: a 302 straight to Pinterest's CDN — zero bytes through our
  // server. fetch() can only read progress from it if the CDN allows a
  // cross-origin body read; if that's blocked, ?proxy=1 streams the same
  // file through our own server instead (always same-origin, so it always
  // works, at the cost of using our bandwidth for that one file).
  const direct  = base;
  const proxied = `${base}&proxy=1`;

  progFill.classList.remove('done');
  progFill.style.width = '0%';
  progStatus.textContent = T.downloading(q.label);
  setPct(0);
  prog.classList.add('show');

  try {
    let blob;
    try {
      blob = await streamToBlob(direct, q.label, mime);
    } catch (_) {
      setPct(0);
      blob = await streamToBlob(proxied, q.label, mime);
    }
    saveBlob(blob, filename);
    finish(T.savedDevice, q.label);
  } catch (_) {
    // Last resort: hand the URL to the browser's own download manager.
    // Never throws in a way that leaves `busy` stuck — the timeout below
    // always runs and always calls finish().
    try {
      setIndeterminate();
      progStatus.textContent = T.opening;
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
      setTimeout(() => finish(T.startedBrowser, q.label), 1600);
    }
  }
}

/* ── Download another ──────────────────────────────────────────────────── */
$('anotherBtn').addEventListener('click', () => {
  resetPreview();
  result.classList.remove('show');
  urlInput.value = '';
  clearBtn.style.display = 'none';
  hideAlert();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  urlInput.focus();
});

/* ── Share target / ?url= ──────────────────────────────────────────────────
   The PWA manifest registers KlickPint as a share target, so sharing a pin
   from the Pinterest app opens /?url=...&text=.... Pull the first Pinterest
   link out of whichever field carries it and fetch it straight away. */
(function fromShare() {
  const params = new URLSearchParams(location.search);
  const blob   = ['url', 'text', 'title'].map((k) => params.get(k) || '').join(' ');
  const match  = blob.match(/https?:\/\/(?:[a-z0-9-]+\.)*(?:pinterest\.[a-z.]+|pin\.it)\/\S+/i);
  if (!match) return;
  urlInput.value = match[0];
  clearBtn.style.display = 'flex';
  history.replaceState(null, '', location.pathname);
  fetchBtn.click();
})();
