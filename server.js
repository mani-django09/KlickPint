'use strict';

const express     = require('express');
const cors        = require('cors');
const path        = require('path');
const axios       = require('axios');
const cheerio     = require('cheerio');
const rateLimit   = require('express-rate-limit');
const helmet      = require('helmet');
const compression = require('compression');
const morgan      = require('morgan');

const app  = express();
const PORT = process.env.PORT || 3020;

// ══════════════════════════════════════════════════════════════════
//  ANTI-BAN: User-Agent Pool — rotate per request so Pinterest
//  doesn't see the same UA hammering from one IP
// ══════════════════════════════════════════════════════════════════
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36',
];

const UA_MOBILE = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.88 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36',
];

function randomUA(mobile = false) {
  const pool = mobile ? UA_MOBILE : UA_POOL;
  return pool[Math.floor(Math.random() * pool.length)];
}

function randomDelay(min = 200, max = 800) {
  return new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min) + min)));
}

// ── Rotate Accept-Language too for extra stealth ──────────────────
const ACCEPT_LANGS = [
  'en-US,en;q=0.9',
  'en-GB,en;q=0.9',
  'en-US,en;q=0.8,hi;q=0.6',
  'en-US,en;q=0.9,fr;q=0.7',
];
function randomLang() {
  return ACCEPT_LANGS[Math.floor(Math.random() * ACCEPT_LANGS.length)];
}

function buildHeaders(mobile = false) {
  return {
    'User-Agent'               : randomUA(mobile),
    'Accept-Language'          : randomLang(),
    'Accept'                   : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Encoding'          : 'gzip, deflate, br',
    'Sec-Fetch-Dest'           : 'document',
    'Sec-Fetch-Mode'           : 'navigate',
    'Sec-Fetch-Site'           : 'none',
    'Sec-Fetch-User'           : '?1',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control'            : 'max-age=0',
  };
}

// ══════════════════════════════════════════════════════════════════
//  ANTI-BAN: Pinterest block detector
//  Track consecutive failures → cool-down if Pinterest blocks us
// ══════════════════════════════════════════════════════════════════
const pinterestHealth = {
  failures       : 0,
  lastFailTime   : 0,
  cooldownUntil  : 0,   // epoch ms
  FAIL_THRESHOLD : 8,   // consecutive failures before cool-down
  COOLDOWN_MS    : 5 * 60 * 1000,  // 5 min cool-down
};

function pinterestOk() {
  if (Date.now() < pinterestHealth.cooldownUntil) return false;
  return true;
}

function recordPinterestSuccess() {
  pinterestHealth.failures = 0;
}

function recordPinterestFailure() {
  pinterestHealth.failures++;
  pinterestHealth.lastFailTime = Date.now();
  if (pinterestHealth.failures >= pinterestHealth.FAIL_THRESHOLD) {
    pinterestHealth.cooldownUntil = Date.now() + pinterestHealth.COOLDOWN_MS;
    console.warn(`[WARN] Pinterest blocked? Starting ${pinterestHealth.COOLDOWN_MS / 1000}s cool-down.`);
    pinterestHealth.failures = 0;
  }
}

// ══════════════════════════════════════════════════════════════════
//  ANTI-BAN: Retry with exponential back-off
// ══════════════════════════════════════════════════════════════════
async function withRetry(fn, maxAttempts = 3, baseDelay = 1000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === maxAttempts;
      const is429  = err.response?.status === 429;
      const is403  = err.response?.status === 403;

      if (isLast) {
        // Record exactly once per failed operation, right before giving up
        // — not on every intermediate attempt. This used to fire on every
        // non-final retry AND again in getPinInfo's outer catch, so a single
        // pin that got 429'd for all 3 attempts counted as 2-3 failures
        // toward pinterestHealth.FAIL_THRESHOLD (8). In practice that meant
        // 2-3 unlucky requests — not 8 — could trip the site-wide 5-minute
        // "Pinterest rate-limited us" cooldown for every visitor.
        if (is429 || is403) recordPinterestFailure();
        throw err;
      }

      const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 500;
      console.warn(`[Retry ${attempt}/${maxAttempts}] ${err.message} — waiting ${Math.round(delay)}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ══════════════════════════════════════════════════════════════════
//  ABUSE PROTECTION: auto-ban IPs that hammer the server
// ══════════════════════════════════════════════════════════════════
const abuseTracker = new Map();   // ip → { count, firstSeen, banned }
const ABUSE_WINDOW  = 60 * 1000; // 1 minute window
const ABUSE_MAX     = 20;        // max 20 requests per minute per IP
const BAN_DURATION  = 30 * 60 * 1000; // 30 min ban

function checkAbuse(ip) {
  const now  = Date.now();
  const data = abuseTracker.get(ip) || { count: 0, firstSeen: now, bannedUntil: 0 };

  // Still banned?
  if (data.bannedUntil > now) return false;

  // Reset window if expired
  if (now - data.firstSeen > ABUSE_WINDOW) {
    data.count     = 1;
    data.firstSeen = now;
    abuseTracker.set(ip, data);
    return true;
  }

  data.count++;
  if (data.count > ABUSE_MAX) {
    data.bannedUntil = now + BAN_DURATION;
    console.warn(`[ABUSE] IP ${ip} auto-banned for ${BAN_DURATION / 60000} minutes (${data.count} req/min)`);
    abuseTracker.set(ip, data);
    return false;
  }

  abuseTracker.set(ip, data);
  return true;
}

// Clean up abuse tracker every 10 min to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of abuseTracker) {
    if (now - data.firstSeen > BAN_DURATION && data.bannedUntil < now) {
      abuseTracker.delete(ip);
    }
  }
}, 10 * 60 * 1000);

// ── Security & Performance ─────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());

// Log the path only — never the query string. /api/download carries the
// Pinterest CDN URL as a query param and the privacy policy promises we do
// not retain submitted URLs, so it must not land in the access log.
morgan.token('pathonly', req => req.originalUrl.split('?')[0]);
app.use(morgan(':remote-addr :method :pathonly :status :res[content-length] - :response-time ms'));
app.use(cors());
app.use(express.json({ limit: '10kb' }));  // prevent large body attacks
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge     : '1d',
  etag       : true,
  extensions : ['html'],   // /privacy → privacy.html, /terms → terms.html etc.
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      // Short cache + ETag revalidation, NOT the 1-day default below.
      // JS/CSS carry bug fixes — a 24h max-age means a returning visitor's
      // browser would keep running an already-fixed bug for up to a day
      // with no way to notice, since a hard max-age skips the revalidation
      // request entirely (unlike ETag-based 304s, which are near-free).
      res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    }
  }
}));

// Trust proxy (important when behind Nginx/Cloudflare)
app.set('trust proxy', 1);

// ── In-memory analytics ────────────────────────────────────────────────────
const stats = {
  totalDownloads : 0,
  todayDownloads : 0,
  lastReset      : new Date().toDateString(),
  ipDownloads    : new Map(),
};

setInterval(() => {
  const today = new Date().toDateString();
  if (stats.lastReset !== today) {
    stats.todayDownloads = 0;
    stats.lastReset = today;
    stats.ipDownloads.clear();
    console.log('[Stats] Daily reset done');
  }
}, 60 * 1000);

// ── Rate Limiters ──────────────────────────────────────────────────────────
// Per-IP: 25 fetches per hour
const fetchLimiter = rateLimit({
  windowMs : 60 * 60 * 1000,
  max      : 25,
  // No custom keyGenerator: express-rate-limit's default already keys on the
  // (proxy-aware) IP and normalises IPv6 into /56 subnets. A hand-rolled
  // `req.ip` key lets a single IPv6 client rotate addresses past the limit.
  standardHeaders: true,
  legacyHeaders  : false,
  handler: (req, res) => {
    console.warn(`[RATELIMIT] ${req.ip} hit hourly limit`);
    res.status(429).json({
      error   : 'RATE_LIMIT',
      message : 'You have reached the hourly limit. Please try again later.',
    });
  },
});

// Global: 200 req/min (hard cap, bot protection)
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max     : 200,
  standardHeaders: true,
  legacyHeaders  : false,
  message : { error: 'Too many requests. Slow down.' },
});

app.use(globalLimiter);

// ── Abuse middleware ───────────────────────────────────────────────────────
app.use((req, res, next) => {
  const ip = req.ip;
  if (!checkAbuse(ip)) {
    return res.status(429).json({
      error   : 'ABUSE_DETECTED',
      message : 'Too many requests. Your IP has been temporarily blocked.',
    });
  }
  next();
});

// ══════════════════════════════════════════════════════════════════
//  VIDEO URL CACHE — same pin ke liye Pinterest API baar baar
//  call nahi hogi. 30 min cache = 80% fewer Pinterest requests.
// ══════════════════════════════════════════════════════════════════
const videoCache = new Map();          // pinId → { data, expiresAt }
const CACHE_TTL  = 30 * 60 * 1000;   // 30 minutes
const CACHE_MAX  = 500;               // max entries (memory guard)

function cacheGet(pinId) {
  const entry = videoCache.get(pinId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { videoCache.delete(pinId); return null; }
  return entry.data;
}

function cacheSet(pinId, data) {
  // Evict oldest if at limit
  if (videoCache.size >= CACHE_MAX) {
    const firstKey = videoCache.keys().next().value;
    videoCache.delete(firstKey);
  }
  videoCache.set(pinId, { data, expiresAt: Date.now() + CACHE_TTL });
}

// Clean expired entries every 10 min
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of videoCache)
    if (now > entry.expiresAt) videoCache.delete(id);
}, 10 * 60 * 1000);

// ══════════════════════════════════════════════════════════════════
//  QUALITY MAP & HELPERS
// ══════════════════════════════════════════════════════════════════
const QUALITY_MAP = {
  V_1080P : { label: '1080p', tag: 'Full HD',  order: 1 },
  V_720P  : { label: '720p',  tag: 'HD',       order: 2 },
  V_480P  : { label: '480p',  tag: 'Standard', order: 3 },
  V_360P  : { label: '360p',  tag: 'Low',      order: 4 },
};

function detectQualityFromUrl(url) {
  if (/V_1080P|1080/i.test(url)) return '1080p';
  if (/V_720P|720/i.test(url))   return '720p';
  if (/V_480P|480/i.test(url))   return '480p';
  if (/V_360P|360/i.test(url))   return '360p';
  return 'Video';
}

// Pinterest reports video_list durations in MILLISECONDS. Older pins
// occasionally carry seconds instead, so normalise both into seconds —
// without this a 30 s clip renders as "500:00".
function normalizeDuration(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1000 ? Math.round(n / 1000) : Math.round(n);
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

// Dedup by LABEL, not URL. The HTML fallback below walks the *entire* page
// JSON recursively, which includes related-pins / "more like this" carousel
// data — each of those pins has its own video_list with a different CDN URL
// at the same resolution. URL-based dedup let five different "720p" videos
// (from five different pins) through as if they were five real options for
// the one video the user asked for.
function deduplicateAndSort(videos) {
  const seen = new Set();
  const ORDER = { '1080p':1,'720p':2,'480p':3,'360p':4,'HD':5,'Video':6 };
  return videos
    .filter(v => { if (!v.url || !v.label || seen.has(v.label)) return false; seen.add(v.label); return true; })
    .sort((a, b) => (ORDER[a.label] || 99) - (ORDER[b.label] || 99));
}

// Only the FIRST video_list found in the page JSON belongs to the pin the
// user asked for — it appears earliest in Pinterest's initial-state blob,
// ahead of any related-pins data. Stop recursing the moment one is consumed
// so we never mix in another pin's qualities.
function extractVideosFromObj(obj, out, state = { done: false }) {
  if (state.done || !obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) { extractVideosFromObj(item, out, state); if (state.done) return; }
    return;
  }
  if (obj.video_list && typeof obj.video_list === 'object') {
    let added = false;
    for (const [key, meta] of Object.entries(QUALITY_MAP)) {
      const v = obj.video_list[key];
      if (v?.url && !out.find(x => x.label === meta.label)) {
        out.push({ label: meta.label, tag: meta.tag, url: v.url, type: 'video', order: meta.order });
        added = true;
      }
    }
    if (added) { state.done = true; return; }
  }
  for (const val of Object.values(obj)) { extractVideosFromObj(val, out, state); if (state.done) return; }
}

// Fixed, literal domain list — deliberately NOT a generic "ends with
// pinterest.<anything>" pattern. A pattern like /pinterest\.[a-z.]+$/ also
// matches "pinterest.evil.com" (the SLD there is "evil", "pinterest" is just
// a subdomain label), which would let an attacker point our server at an
// internal/private address. Each entry below is checked as an exact host or
// a "ends with '.' + entry" subdomain match, so "pinterest.com" can never
// match "notpinterest.com" or "pinterest.com.evil.net" either.
const PINTEREST_DOMAINS = [
  'pin.it', 'pinterest.com',
  'pinterest.co.uk', 'pinterest.de', 'pinterest.fr', 'pinterest.it',
  'pinterest.es', 'pinterest.ca', 'pinterest.com.au', 'pinterest.co.nz',
  'pinterest.co.kr', 'pinterest.jp', 'pinterest.ru', 'pinterest.se',
  'pinterest.dk', 'pinterest.at', 'pinterest.ch', 'pinterest.ie',
  'pinterest.pt', 'pinterest.nl', 'pinterest.com.mx', 'pinterest.ph',
  'pinterest.co.in', 'pinterest.com.br', 'pinterest.pl',
];

function isPinterestHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return PINTEREST_DOMAINS.some(d => h === d || h.endsWith('.' + d));
}

// ── Resolve short/shared URLs ──────────────────────────────────────────────
async function resolveUrl(rawUrl) {
  const direct = rawUrl.match(/pinterest\.[a-z.]+\/pin\/(\d+)/);
  if (direct) return { pinId: direct[1], cleanUrl: `https://www.pinterest.com/pin/${direct[1]}/` };

  // SSRF guard: without this, ANY string merely containing the substring
  // "pinterest" or "pin.it" (checked by the route handler) reaches this
  // point and gets fetched verbatim — e.g. "https://evil.example/?pinterest"
  // or an internal address disguised the same way. Only actually resolve
  // URLs whose host is a real Pinterest domain.
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    throw new Error('Please enter a valid Pinterest URL.');
  }
  if (!isPinterestHost(parsed.hostname)) {
    throw new Error('Please enter a valid Pinterest URL.');
  }

  const resp = await withRetry(() =>
    axios.get(rawUrl, {
      maxRedirects : 10,
      timeout      : 12000,
      headers      : buildHeaders(),
      validateStatus: () => true,
    })
  );
  const finalUrl = resp.request?.res?.responseUrl || resp.config?.url || rawUrl;
  const m = finalUrl.match(/\/pin\/(\d+)/);
  if (m) return { pinId: m[1], cleanUrl: `https://www.pinterest.com/pin/${m[1]}/` };
  throw new Error('Could not extract Pin ID. Please use a direct pinterest.com link.');
}

// ── Pinterest API (primary method) ────────────────────────────────────────
async function fetchViaAPI(pinId) {
  await randomDelay(150, 600); // human-like delay

  const url = `https://www.pinterest.com/resource/PinResource/get/?source_url=%2Fpin%2F${pinId}%2F&data=%7B%22options%22%3A%7B%22id%22%3A%22${pinId}%22%2C%22field_set_key%22%3A%22detailed%22%7D%7D`;

  const resp = await withRetry(() =>
    axios.get(url, {
      timeout: 15000,
      headers: {
        ...buildHeaders(),
        'Accept'           : 'application/json, text/javascript, */*; q=0.01',
        'Referer'          : `https://www.pinterest.com/pin/${pinId}/`,
        'X-Requested-With' : 'XMLHttpRequest',
        'X-APP-VERSION'    : 'a18b04b',
        'X-Pinterest-AppState': 'active',
      },
    })
  );

  const data = resp.data?.resource_response?.data;
  if (!data) throw new Error('Pinterest API returned empty data');
  recordPinterestSuccess();
  return data;
}

// ── HTML Scrape (fallback) ─────────────────────────────────────────────────
async function fetchViaHTML(cleanUrl) {
  await randomDelay(300, 900);

  const resp = await withRetry(() =>
    axios.get(cleanUrl, {
      timeout: 15000,
      headers: buildHeaders(true),  // mobile UA for fallback
    })
  );

  const $      = cheerio.load(resp.data);
  const result = { videos: [], title: '', thumbnail: '' };

  result.title     = $('meta[property="og:title"]').attr('content')  || $('title').text() || 'Pinterest Video';
  result.thumbnail = $('meta[property="og:image"]').attr('content')  || '';

  const ogVid = $('meta[property="og:video"]').attr('content') || $('meta[property="og:video:url"]').attr('content');
  if (ogVid) result.videos.push({ label: 'HD', tag: 'High', url: ogVid, type: 'video' });

  // Shared across every <script> tag, not reset per-tag — otherwise the
  // "only regex-scan if nothing found yet" check below only ever looked at
  // the current tag's contribution and re-triggered on every later tag too.
  const state = { done: result.videos.length > 0 };

  $('script').each((_, el) => {
    if (state.done) return;
    const txt = $(el).html() || '';
    if (txt.includes('video_list') || txt.includes('V_720P') || txt.includes('V_1080P')) {
      try {
        extractVideosFromObj(JSON.parse(txt.replace(/^[^{[]*/, '').replace(/[^}\]]*$/, '')), result.videos, state);
      } catch (_) {}
    }
  });

  if (result.videos.length === 0) {
    $('script').each((_, el) => {
      if (result.videos.length > 0) return;
      const txt = $(el).html() || '';
      (txt.match(/https?:\\?\/\\?\/[^"' \\]*?\.mp4[^"' \\]*/g) || []).forEach(raw => {
        const u = raw.replace(/\\u002F/g, '/').replace(/\\\//g, '/');
        if (!u.includes('thumbnail') && !result.videos.find(v => v.url === u)) {
          const lbl = detectQualityFromUrl(u);
          result.videos.push({ label: lbl, tag: lbl, url: u, type: 'video' });
        }
      });
    });
  }

  result.videos = deduplicateAndSort(result.videos);
  return result;
}

// ── Main orchestrator ──────────────────────────────────────────────────────
async function getPinInfo(rawUrl) {
  // Check Pinterest cool-down
  if (!pinterestOk()) {
    throw new Error('Service temporarily unavailable. Pinterest rate-limited us. Please try again in a few minutes.');
  }

  const { pinId, cleanUrl } = await resolveUrl(rawUrl);

  // ── Cache hit? Return instantly, no Pinterest API call ────────────────
  const cached = cacheGet(pinId);
  if (cached) {
    console.log(`[Cache HIT] pin/${pinId}`);
    return cached;
  }
  let title = 'Pinterest Video', thumbnail = '', qualities = [], duration = 0;

  try {
    const pinData = await fetchViaAPI(pinId);
    for (const [key, meta] of Object.entries(QUALITY_MAP)) {
      const v = pinData?.videos?.video_list?.[key];
      if (v?.url) qualities.push({ label: meta.label, tag: meta.tag, url: v.url, type: 'video', order: meta.order });
    }
    title     = pinData.title || pinData.description || title;
    thumbnail = pinData.images?.orig?.url || pinData.images?.['736x']?.url || '';
    const vl  = pinData.videos?.video_list || {};
    duration  = vl.V_720P?.duration || vl.V_480P?.duration || vl.V_1080P?.duration || 0;
  } catch (e) {
    // NOT recordPinterestFailure() here — withRetry() already records it,
    // exactly once, but only for real 429/403 responses. This catch also
    // fires for things that have nothing to do with Pinterest blocking us
    // (a deleted/private pin, a malformed API response, a timeout on our
    // side) — those used to count toward the SAME cooldown counter, so a
    // batch of users pasting normal dead links could falsely trip a
    // site-wide "Pinterest rate-limited us" error for everyone.
    console.warn('[API fail]', e.message);
    try {
      const scraped = await fetchViaHTML(cleanUrl);
      qualities = scraped.videos;
      title     = scraped.title     || title;
      thumbnail = scraped.thumbnail || thumbnail;
      if (scraped.videos.length > 0) recordPinterestSuccess();
    } catch (e2) {
      console.error('[HTML fail]', e2.message);
    }
  }

  qualities = deduplicateAndSort(qualities).map(q => ({ ...q, locked: false }));

  const result = {
    pinId,
    title    : (title || 'Pinterest Video').substring(0, 100),
    thumbnail,
    duration : formatDuration(normalizeDuration(duration)),
    qualities,
  };

  // ── Cache result for 30 min ───────────────────────────────────────────
  if (qualities.length > 0) {
    cacheSet(pinId, result);
    console.log(`[Cache SET] pin/${pinId} — ${qualities.length} qualities`);
  }

  return result;
}

// ══════════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════════

// ── Fetch video info ───────────────────────────────────────────────────────
app.post('/api/fetch', fetchLimiter, async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string' || url.length > 500)
    return res.status(400).json({ error: 'Please enter a valid Pinterest URL' });
  // Case-insensitive substring check — the old version used a plain
  // case-sensitive .includes(), which rejected otherwise-valid links pasted
  // or typed in mixed case (e.g. "Pinterest.com/..."), even though the
  // client-side check (PIN_RE, /i flag) already let them through. This is a
  // cheap pre-filter only; resolveUrl() does the real host-allowlist check
  // before any outbound request is made.
  if (!/pinterest|pin\.it/i.test(url))
    return res.status(400).json({ error: 'Please enter a valid Pinterest URL' });

  // Track stats
  const ip     = req.ip;
  const ipData = stats.ipDownloads.get(ip) || { count: 0, date: new Date().toDateString() };
  if (ipData.date !== new Date().toDateString()) { ipData.count = 0; ipData.date = new Date().toDateString(); }
  ipData.count++;
  stats.ipDownloads.set(ip, ipData);
  stats.totalDownloads++;
  stats.todayDownloads++;

  try {
    const data = await getPinInfo(url);
    if (!data.qualities.length)
      return res.status(404).json({ error: 'No video found in this pin. It may be an image pin or a private pin.' });
    res.json({ success: true, data });
  } catch (err) {
    console.error('[Fetch error]', err.message);
    const isCooldown = err.message.includes('temporarily unavailable');
    res.status(isCooldown ? 503 : 500).json({ error: err.message || 'Could not fetch video. Please try again.' });
  }
});

// ── Download ──────────────────────────────────────────────────────────────
// Default: 302 straight to the Pinterest CDN, so the video bytes never touch
// this VPS. The browser follows the redirect (or the front-end reads it with
// fetch() to draw a real progress bar and name the file itself).
//
// ?proxy=1: stream the file through this server instead. Only used as a
// fallback when the CDN refuses the cross-origin read, because a plain
// redirect drops Content-Disposition — the header cannot survive a hop to a
// different origin, so the browser would open the video instead of saving it.
const ALLOWED_DOWNLOAD_HOSTS = /(^|\.)(pinimg\.com|pinterest\.com)$/i;

function parseDownloadTarget(raw) {
  let target;
  try {
    target = new URL(raw);
  } catch (_) {
    return { error: 'Malformed download URL' };
  }
  // Host must be checked on the parsed hostname. A substring test would let
  // https://evil.example/?x=pinimg.com through and turn this into an open
  // redirect / SSRF hop.
  if (target.protocol !== 'https:' && target.protocol !== 'http:')
    return { error: 'Invalid download source' };
  if (!ALLOWED_DOWNLOAD_HOSTS.test(target.hostname))
    return { error: 'Invalid download source' };
  return { target };
}

function safeFilename(filename) {
  const fn = String(filename || 'klickpint.mp4')
    .replace(/[^a-z0-9_.\-]/gi, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return fn || 'klickpint.mp4';
}

app.get('/api/download', async (req, res) => {
  const { url, filename, proxy } = req.query;
  if (!url || typeof url !== 'string')
    return res.status(400).json({ error: 'URL required' });

  const { target, error } = parseDownloadTarget(url);
  if (error) return res.status(403).json({ error });

  const fn = safeFilename(filename);
  res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);

  if (proxy !== '1') {
    return res.redirect(302, target.href);  // zero VPS bandwidth
  }

  try {
    const upstream = await axios.get(target.href, {
      responseType : 'stream',
      timeout      : 20000,
      maxRedirects : 3,
      headers      : { 'User-Agent': randomUA(), 'Referer': 'https://www.pinterest.com/' },
    });

    res.setHeader('Content-Type', upstream.headers['content-type'] || 'video/mp4');
    if (upstream.headers['content-length'])
      res.setHeader('Content-Length', upstream.headers['content-length']);

    upstream.data.on('error', () => res.destroy());
    req.on('close', () => upstream.data.destroy());
    upstream.data.pipe(res);
  } catch (err) {
    console.error('[Proxy download failed]', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Could not fetch the video file.' });
    else res.destroy();
  }
});

// ── Health + Stats ─────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({
  status       : 'OK',
  uptime       : Math.round(process.uptime()),
  pinterestOk  : pinterestOk(),
  cooldownLeft : Math.max(0, Math.round((pinterestHealth.cooldownUntil - Date.now()) / 1000)),
  cache        : { size: videoCache.size, maxSize: CACHE_MAX },
  memory       : `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
  pid          : process.pid,
}));

app.get('/api/stats', (req, res) => {
  // Only allow local/internal access
  const ip = req.ip;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1')
    return res.status(403).json({ error: 'Forbidden' });
  res.json({
    totalDownloads : stats.totalDownloads,
    todayDownloads : stats.todayDownloads,
    activeIPs      : stats.ipDownloads.size,
    bannedIPs      : [...abuseTracker.values()].filter(d => d.bannedUntil > Date.now()).length,
    pinterestHealth: {
      ok          : pinterestOk(),
      failures    : pinterestHealth.failures,
      cooldownLeft: Math.max(0, Math.round((pinterestHealth.cooldownUntil - Date.now()) / 1000)),
    },
  });
});

// Browsers ask for /favicon.ico unprompted; point them at the SVG instead of
// letting the request fall through and download a full 404 HTML page.
app.get('/favicon.ico', (_, res) => res.redirect(301, '/favicon.svg'));

// ── 404 ───────────────────────────────────────────────────────────────────
// This is a static site, not an SPA. Serving index.html with a 200 for every
// unknown path creates soft 404s: Google indexes /whatever-random-path as a
// duplicate of the homepage. Answer with a real 404 instead.
app.use((req, res) => {
  if (req.path.startsWith('/api/'))
    return res.status(404).json({ error: 'Not found' });
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// ── Error handler ─────────────────────────────────────────────────────────
// Catches body-parser failures (malformed JSON, >10kb body) as well as any
// synchronous throw in a route. Body-parser errors carry a real 4xx status
// (400/413) — reporting all of them as a blanket 500 mislabels a client
// mistake as a server failure.
app.use((err, _req, res, _next) => {
  console.error('[Unhandled]', err.message);
  if (res.headersSent) return;
  const status = (err.status || err.statusCode) >= 400 && (err.status || err.statusCode) < 500
    ? (err.status || err.statusCode)
    : 500;
  res.status(status).json({
    error: status < 500 ? (err.message || 'Bad request') : 'Something went wrong. Please try again.',
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   🚀 KlickPint running on port ${PORT}   ║
║   Anti-ban: UA rotation ON             ║
║   Abuse protection: ON                 ║
║   Retry logic: ON (3 attempts)         ║
╚════════════════════════════════════════╝
`);
  // ecosystem.config.js sets wait_ready:true. Without this signal PM2 waits
  // out listen_timeout on every worker and can flag the app as errored.
  if (process.send) process.send('ready');
});

// Graceful shutdown so in-flight downloads finish on reload/restart.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[${sig}] shutting down…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 4500).unref();
  });
}
