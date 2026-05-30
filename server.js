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

      if (isLast) throw err;
      if (is429 || is403) recordPinterestFailure();

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
app.use(morgan('combined'));
app.use(cors());
app.use(express.json({ limit: '10kb' }));  // prevent large body attacks
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge     : '1d',
  etag       : true,
  extensions : ['html'],   // /privacy → privacy.html, /terms → terms.html etc.
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
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
  keyGenerator: req => req.ip,
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

function deduplicateAndSort(videos) {
  const seen  = new Set();
  const ORDER = { '1080p':1,'720p':2,'480p':3,'360p':4,'HD':5,'Video':6 };
  return videos
    .filter(v => { if (!v.url || seen.has(v.url)) return false; seen.add(v.url); return true; })
    .sort((a, b) => (ORDER[a.label] || 99) - (ORDER[b.label] || 99));
}

function extractVideosFromObj(obj, out) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) { obj.forEach(i => extractVideosFromObj(i, out)); return; }
  if (obj.video_list && typeof obj.video_list === 'object') {
    for (const [key, meta] of Object.entries(QUALITY_MAP)) {
      const v = obj.video_list[key];
      if (v?.url && !out.find(x => x.url === v.url)) {
        out.push({ label: meta.label, tag: meta.tag, url: v.url, type: 'video', order: meta.order });
      }
    }
  }
  for (const val of Object.values(obj)) extractVideosFromObj(val, out);
}

// ── Resolve short/shared URLs ──────────────────────────────────────────────
async function resolveUrl(rawUrl) {
  const direct = rawUrl.match(/pinterest\.[a-z.]+\/pin\/(\d+)/);
  if (direct) return { pinId: direct[1], cleanUrl: `https://www.pinterest.com/pin/${direct[1]}/` };

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

  $('script').each((_, el) => {
    const txt = $(el).html() || '';
    if (txt.includes('video_list') || txt.includes('V_720P') || txt.includes('V_1080P')) {
      try {
        extractVideosFromObj(JSON.parse(txt.replace(/^[^{[]*/, '').replace(/[^}\]]*$/, '')), result.videos);
      } catch (_) {}
    }
    if (result.videos.length === 0) {
      (txt.match(/https?:\\?\/\\?\/[^"' \\]*?\.mp4[^"' \\]*/g) || []).forEach(raw => {
        const u = raw.replace(/\\u002F/g, '/').replace(/\\\//g, '/');
        if (!u.includes('thumbnail') && !result.videos.find(v => v.url === u)) {
          const lbl = detectQualityFromUrl(u);
          result.videos.push({ label: lbl, tag: lbl, url: u, type: 'video' });
        }
      });
    }
  });

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
    console.warn('[API fail]', e.message);
    recordPinterestFailure();
    try {
      const scraped = await fetchViaHTML(cleanUrl);
      qualities = scraped.videos;
      title     = scraped.title     || title;
      thumbnail = scraped.thumbnail || thumbnail;
      if (scraped.videos.length > 0) recordPinterestSuccess();
    } catch (e2) {
      console.error('[HTML fail]', e2.message);
      recordPinterestFailure();
    }
  }

  qualities = deduplicateAndSort(qualities).map(q => ({ ...q, locked: false }));

  const mins = Math.floor(duration / 60);
  const secs = String(Math.floor(duration % 60)).padStart(2, '0');

  const result = {
    pinId,
    title    : (title || 'Pinterest Video').substring(0, 100),
    thumbnail,
    duration : duration ? `${mins}:${secs}` : '',
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
  if (!url.includes('pinterest') && !url.includes('pin.it'))
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

// ── Download — Direct redirect (zero VPS bandwidth) ──────────────────────
// Video file goes Pinterest CDN → User directly. VPS only sends a 302.
app.get('/api/download', (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const decoded = decodeURIComponent(url);
  // Only allow Pinterest CDN domains
  if (!/pinimg\.com|pinterest\.com/i.test(decoded))
    return res.status(403).json({ error: 'Invalid download source' });

  const fn = (filename || 'klickpint.mp4').replace(/[^a-z0-9_.\-]/gi, '_');

  // Tell browser to download (not open) + set filename
  res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
  res.redirect(302, decoded);  // User downloads directly from Pinterest CDN
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

// ── SPA fallback ──────────────────────────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   🚀 KlickPint running on port ${PORT}   ║
║   Anti-ban: UA rotation ON             ║
║   Abuse protection: ON                 ║
║   Retry logic: ON (3 attempts)         ║
╚════════════════════════════════════════╝
`);
});
