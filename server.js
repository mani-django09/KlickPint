const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const axios      = require('axios');
const cheerio    = require('cheerio');
const rateLimit  = require('express-rate-limit');
const helmet     = require('helmet');
const compression = require('compression');
const morgan     = require('morgan');

const app  = express();
const PORT = process.env.PORT || 3020;

// ── Security & Performance ─────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(morgan('combined'));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

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
// All users: 30 fetches per hour per IP (server protection only)
const fetchLimiter = rateLimit({
  windowMs : 60 * 60 * 1000,
  max      : 30,
  keyGenerator: (req) => req.ip,
  handler  : (req, res) => {
    res.status(429).json({
      error   : 'RATE_LIMIT',
      message : 'Too many requests. Please wait an hour and try again.',
    });
  }
});

// Global limiter: 300 req/min (bot protection)
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max     : 300,
  message : { error: 'Too many requests. Please wait.' }
});

app.use(globalLimiter);

// ── Quality & Scraping Helpers ─────────────────────────────────────────────
const BROWSER_HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Sec-Fetch-Dest' : 'document',
  'Sec-Fetch-Mode' : 'navigate',
  'Upgrade-Insecure-Requests': '1',
};

const QUALITY_MAP = {
  V_1080P : { label: '1080p', tag: 'Full HD',   order: 1 },
  V_720P  : { label: '720p',  tag: 'HD',        order: 2 },
  V_480P  : { label: '480p',  tag: 'Standard',  order: 3 },
  V_360P  : { label: '360p',  tag: 'Low',       order: 4 },
};

function detectQualityFromUrl(url) {
  if (/V_1080P|1080/i.test(url)) return '1080p';
  if (/V_720P|720/i.test(url))   return '720p';
  if (/V_480P|480/i.test(url))   return '480p';
  if (/V_360P|360/i.test(url))   return '360p';
  return 'Video';
}

function deduplicateAndSort(videos) {
  const seen = new Set();
  const ORDER = { '1080p':1,'720p':2,'480p':3,'360p':4,'HD':5,'Video':6 };
  return videos
    .filter(v => { if (!v.url || seen.has(v.url)) return false; seen.add(v.url); return true; })
    .sort((a,b) => (ORDER[a.label]||99) - (ORDER[b.label]||99));
}

function extractVideosFromObj(obj, out) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) { obj.forEach(i => extractVideosFromObj(i, out)); return; }
  if (obj.video_list && typeof obj.video_list === 'object') {
    for (const [key, meta] of Object.entries(QUALITY_MAP)) {
      const v = obj.video_list[key];
      if (v?.url && !out.find(x => x.url === v.url)) {
        out.push({ label: meta.label, tag: meta.tag, sub: `${meta.label} · MP4`, url: v.url, type: 'video', order: meta.order });
      }
    }
  }
  for (const val of Object.values(obj)) extractVideosFromObj(val, out);
}

// ── Resolve short/shared URLs ──────────────────────────────────────────────
async function resolveUrl(url) {
  const direct = url.match(/pinterest\.[a-z.]+\/pin\/(\d+)/);
  if (direct) return { pinId: direct[1], cleanUrl: `https://www.pinterest.com/pin/${direct[1]}/` };
  try {
    const resp = await axios.get(url, {
      maxRedirects: 10, timeout: 12000,
      headers: BROWSER_HEADERS, validateStatus: () => true,
    });
    const finalUrl = resp.request?.res?.responseUrl || resp.config?.url || url;
    const m = finalUrl.match(/\/pin\/(\d+)/);
    if (m) return { pinId: m[1], cleanUrl: `https://www.pinterest.com/pin/${m[1]}/` };
  } catch(e) { console.error('Resolve:', e.message); }
  throw new Error('Could not extract Pin ID. Please use a direct pinterest.com link.');
}

// ── Pinterest API ──────────────────────────────────────────────────────────
async function fetchViaAPI(pinId) {
  const url = `https://www.pinterest.com/resource/PinResource/get/?source_url=%2Fpin%2F${pinId}%2F&data=%7B%22options%22%3A%7B%22id%22%3A%22${pinId}%22%2C%22field_set_key%22%3A%22detailed%22%7D%7D`;
  const resp = await axios.get(url, {
    timeout: 15000,
    headers: { ...BROWSER_HEADERS, 'Accept':'application/json, text/javascript, */*; q=0.01', 'Referer':`https://www.pinterest.com/pin/${pinId}/`, 'X-Requested-With':'XMLHttpRequest', 'X-APP-VERSION':'a18b04b', 'X-Pinterest-AppState':'active' },
  });
  const data = resp.data?.resource_response?.data;
  if (!data) throw new Error('API returned empty data');
  return data;
}

// ── HTML Scrape fallback ───────────────────────────────────────────────────
async function fetchViaHTML(cleanUrl) {
  const resp = await axios.get(cleanUrl, {
    timeout: 15000,
    headers: { ...BROWSER_HEADERS, 'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  });
  const $ = cheerio.load(resp.data);
  const result = { videos: [], title: '', thumbnail: '' };
  result.title     = $('meta[property="og:title"]').attr('content') || $('title').text() || 'Pinterest Video';
  result.thumbnail = $('meta[property="og:image"]').attr('content') || '';
  const ogVid = $('meta[property="og:video"]').attr('content') || $('meta[property="og:video:url"]').attr('content');
  if (ogVid) result.videos.push({ label:'HD', tag:'High', sub:'HD · MP4', url:ogVid, type:'video' });
  $('script').each((_, el) => {
    const txt = $(el).html() || '';
    if (txt.includes('video_list') || txt.includes('V_720P') || txt.includes('V_1080P')) {
      try { extractVideosFromObj(JSON.parse(txt.replace(/^[^{[]*/, '').replace(/[^}\]]*$/, '')), result.videos); } catch(_) {}
    }
    if (result.videos.length === 0) {
      (txt.match(/https?:\\?\/\\?\/[^"' \\]*?\.mp4[^"' \\]*/g) || []).forEach(raw => {
        const u = raw.replace(/\\u002F/g, '/').replace(/\\\//g, '/');
        if (!u.includes('thumbnail') && !result.videos.find(v => v.url === u)) {
          const lbl = detectQualityFromUrl(u);
          result.videos.push({ label:lbl, tag:lbl, sub:`${lbl} · MP4`, url:u, type:'video' });
        }
      });
    }
  });
  result.videos = deduplicateAndSort(result.videos);
  return result;
}

// ── Main fetch orchestrator ────────────────────────────────────────────────
async function getPinInfo(rawUrl) {
  const { pinId, cleanUrl } = await resolveUrl(rawUrl);
  let title='Pinterest Video', thumbnail='', qualities=[], duration=0;

  try {
    const pinData = await fetchViaAPI(pinId);
    for (const [key, meta] of Object.entries(QUALITY_MAP)) {
      const v = pinData?.videos?.video_list?.[key];
      if (v?.url) qualities.push({ label:meta.label, tag:meta.tag, sub:`${meta.label} · MP4`, url:v.url, type:'video', order:meta.order });
    }
    title     = pinData.title || pinData.description || title;
    thumbnail = pinData.images?.orig?.url || pinData.images?.['736x']?.url || '';
    const vl  = pinData.videos?.video_list || {};
    duration  = vl.V_720P?.duration || vl.V_480P?.duration || vl.V_1080P?.duration || 0;
  } catch(e) {
    console.warn('API fail:', e.message);
    try {
      const scraped = await fetchViaHTML(cleanUrl);
      qualities = scraped.videos;
      title     = scraped.title || title;
      thumbnail = scraped.thumbnail || thumbnail;
    } catch(e2) { console.error('HTML fail:', e2.message); }
  }

  qualities = deduplicateAndSort(qualities);

  // All qualities are available — no restrictions
  qualities = qualities.map(q => ({ ...q, locked: false }));

  const mins = Math.floor(duration / 60);
  const secs = String(Math.floor(duration % 60)).padStart(2, '0');

  return { pinId, title: (title||'Pinterest Video').substring(0,100), thumbnail, duration: duration?`${mins}:${secs}`:'', qualities };
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/fetch', fetchLimiter, async (req, res) => {
  const { url } = req.body;
  if (!url || (!url.includes('pinterest') && !url.includes('pin.it')))
    return res.status(400).json({ error: 'Please enter a valid Pinterest URL' });

  const ip = req.ip;
  const ipData = stats.ipDownloads.get(ip) || { count:0, date:new Date().toDateString() };
  if (ipData.date !== new Date().toDateString()) { ipData.count = 0; ipData.date = new Date().toDateString(); }
  ipData.count++;
  stats.ipDownloads.set(ip, ipData);
  stats.totalDownloads++;
  stats.todayDownloads++;

  try {
    const data = await getPinInfo(url);
    if (!data.qualities.length)
      return res.status(404).json({ error: 'No video found in this pin. It may be an image pin or private.' });
    res.json({ success:true, data });
  } catch(err) {
    console.error('Fetch error:', err.message);
    res.status(500).json({ error: err.message || 'Could not fetch video.' });
  }
});

app.get('/api/download', async (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const response = await axios({ method:'GET', url:decodeURIComponent(url), responseType:'stream', timeout:60000, headers:{...BROWSER_HEADERS, Referer:'https://www.pinterest.com/'} });
    const fn = filename || 'klickpint.mp4';
    res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
    if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
    response.data.pipe(res);
  } catch(err) {
    console.error('Download error:', err.message);
    res.status(500).json({ error:'Download failed', details:err.message });
  }
});

app.get('/api/stats', (req, res) => {
  res.json({ totalDownloads: stats.totalDownloads, todayDownloads: stats.todayDownloads, activeIPs: stats.ipDownloads.size });
});

app.get('/api/health', (_,res) => res.json({ status:'OK', uptime: process.uptime() }));
app.get('*', (_,res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`\n🚀 KlickPint running at http://localhost:${PORT}\n`));
