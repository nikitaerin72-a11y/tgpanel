const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_KEY = process.env.UPLOAD_KEY || 'change_me_upload';
const VIEW_KEY = process.env.VIEW_KEY || 'change_me_view';

const SAVE_DIR = path.join(__dirname, 'dumps');
if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SAVE_DIR),
  filename: (req, file, cb) => cb(null, `dump_${Date.now()}.zip`)
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

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

app.get('/', (req, res) => {
  if (req.query.key !== VIEW_KEY) return res.status(403).send('forbidden');

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

  const cards = files.map((f, i) => `
    <div class="card" style="animation-delay:${i * 40}ms">
      <div class="card-head">
        <div class="dot"></div>
        <div class="device">${f.device}</div>
        <div class="time">${new Date(f.ts).toLocaleString('ru-RU')}</div>
      </div>
      <div class="card-body">
        <div class="row"><span>Android</span><b>${f.android}</b></div>
        <div class="row"><span>Размер</span><b>${(f.size/1024).toFixed(1)} KB</b></div>
        <div class="row"><span>IP</span><b>${f.ip}</b></div>
      </div>
      <a class="btn" href="/download/${f.filename}?key=${VIEW_KEY}">Скачать</a>
    </div>`).join('');

  res.send(`<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Панель</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  background:radial-gradient(ellipse at top,#1a1f2e 0%,#0a0d14 60%);
  color:#e6edf3;min-height:100vh;padding:24px 16px 60px;
}
.header{max-width:1100px;margin:0 auto 28px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
.logo{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:700;letter-spacing:-0.3px}
.logo-icon{
  width:34px;height:34px;border-radius:10px;
  background:linear-gradient(135deg,#58a6ff,#a371f7);
  display:grid;place-items:center;font-size:18px;
  box-shadow:0 0 24px rgba(88,166,255,.4);
}
.count{
  font-size:13px;padding:6px 12px;border-radius:20px;
  background:rgba(88,166,255,.12);color:#58a6ff;
  border:1px solid rgba(88,166,255,.25);font-weight:600;
}
.grid{
  max-width:1100px;margin:0 auto;
  display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;
}
.empty{
  max-width:1100px;margin:0 auto;text-align:center;padding:80px 20px;
  color:#6e7681;
}
.empty-icon{font-size:56px;margin-bottom:16px;opacity:.5}
.card{
  background:linear-gradient(180deg,rgba(22,27,34,.9),rgba(13,17,23,.9));
  border:1px solid #21262d;border-radius:14px;padding:16px;
  backdrop-filter:blur(10px);
  transition:all .25s cubic-bezier(.4,0,.2,1);
  opacity:0;animation:fadeIn .4s forwards;
}
.card:hover{
  border-color:#58a6ff;transform:translateY(-2px);
  box-shadow:0 8px 30px rgba(88,166,255,.15);
}
@keyframes fadeIn{to{opacity:1}}
.card-head{display:flex;align-items:center;gap:8px;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #21262d}
.dot{width:8px;height:8px;border-radius:50%;background:#3fb950;box-shadow:0 0 8px #3fb950;flex-shrink:0}
.device{font-weight:600;font-size:14px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.time{font-size:11px;color:#6e7681;flex-shrink:0}
.card-body{display:flex;flex-direction:column;gap:8px;margin-bottom:14px}
.row{display:flex;justify-content:space-between;font-size:13px}
.row span{color:#6e7681}
.row b{color:#e6edf3;font-weight:500}
.btn{
  display:block;text-align:center;padding:10px;border-radius:10px;
  background:linear-gradient(135deg,#238636,#2ea043);
  color:#fff;text-decoration:none;font-weight:600;font-size:13px;
  transition:all .2s;
}
.btn:hover{filter:brightness(1.1);transform:scale(1.02)}
.btn:active{transform:scale(.98)}
</style></head><body>

<div class="header">
  <div class="logo">
    <div class="logo-icon">⚡</div>
    <div>Панель</div>
  </div>
  <div class="count">${files.length} дампов</div>
</div>

${files.length === 0 
  ? `<div class="empty"><div class="empty-icon">📭</div><div>Пока пусто</div></div>` 
  : `<div class="grid">${cards}</div>`}

</body></html>`);
});

app.get('/download/:name', (req, res) => {
  if (req.query.key !== VIEW_KEY) return res.status(403).send('forbidden');
  const p = path.join(SAVE_DIR, req.params.name);
  if (!fs.existsSync(p)) return res.status(404).send('not found');
  res.download(p);
});

app.get('/health', (req, res) => res.send('ok'));

app.listen(PORT, () => console.log('server on ' + PORT));