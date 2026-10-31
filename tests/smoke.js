// Смоук-тест панели: гоняет все роуты и проверяет, что ничего не отвалилось.
const BASE = process.env.BASE || 'http://127.0.0.1:7999';
const VK = process.env.VK || 'testview';
const UK = process.env.UK || 'testup';

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra) {
  if (cond) { pass++; results.push('  ok   ' + name); }
  else { fail++; results.push('  FAIL ' + name + (extra ? '  ->  ' + String(extra).slice(0, 300) : '')); }
}

let cookie = '';
async function req(path, opts = {}) {
  const headers = Object.assign({}, opts.headers);
  if (opts.cookie !== false && cookie) headers.cookie = cookie;
  const r = await fetch(BASE + path, Object.assign({}, opts, { headers, redirect: 'manual' }));
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) cookie = sc[0].split(';')[0];
  return r;
}
async function text(path, opts) { const r = await req(path, opts); return { status: r.status, body: await r.text(), headers: r.headers }; }
async function json(path, opts) { const r = await req(path, opts); let b = null; try { b = await r.json(); } catch (e) {} return { status: r.status, body: b }; }

(async () => {
  // ── базовая доступность ───────────────────────────────────────────────────
  let r = await text('/health');
  ok('GET /health = 200 ok', r.status === 200 && r.body.trim() === 'ok', r.body);

  r = await text('/');
  ok('GET / без ключа = 403', r.status === 403, r.status);
  ok('заголовок Referrer-Policy', r.headers.get('referrer-policy') === 'no-referrer', r.headers.get('referrer-policy'));
  ok('нет X-Frame-Options (HF Spaces грузит панель в iframe)', r.headers.get('x-frame-options') === null, r.headers.get('x-frame-options'));

  cookie = '';
  r = await text('/?key=' + VK);
  ok('GET /?key= = 200', r.status === 200, r.status);
  ok('ключ выдал cookie pk', cookie.indexOf('pk=') === 0, cookie);
  ok('cookie HttpOnly', (r.headers.getSetCookie() || []).join(' ').includes('HttpOnly'));
  ok('страница содержит обзор', r.body.includes('data-live="overview"'));

  const withCookie = cookie;
  cookie = withCookie;
  r = await text('/');
  ok('GET / только с cookie = 200', r.status === 200, r.status);

  r = await text('/?key=wrong', { cookie: false });
  ok('GET / с неверным ключом = 403', r.status === 403, r.status);

  const badCookie = cookie;
  cookie = 'pk=wrongvalue';
  r = await text('/');
  ok('GET / с чужим cookie = 403', r.status === 403, r.status);
  cookie = badCookie;

  // ── api/state ─────────────────────────────────────────────────────────────
  r = await json('/api/state');
  ok('/api/state = 200', r.status === 200 && r.body && r.body.ok === true, JSON.stringify(r.body).slice(0, 120));
  ok('/api/state отдаёт overview', !!(r.body && typeof r.body.overview === 'string' && r.body.overview.length > 100));

  const savedCookie = cookie; cookie = '';
  r = await json('/api/state', { cookie: false });
  ok('/api/state без авторизации = 403', r.status === 403, r.status);
  cookie = savedCookie;

  // ── /media закрыт ─────────────────────────────────────────────────────────
  cookie = '';
  r = await text('/media/whatever.png', { cookie: false });
  ok('/media без ключа = 403', r.status === 403, r.status);
  cookie = savedCookie;
  r = await text('/media/whatever.png');
  ok('/media с cookie = 404 (файла нет)', r.status === 404, r.status);

  // ── /sounds: превью звуков ────────────────────────────────────────────────
  cookie = '';
  r = await req('/sounds/arbuz.mp3', { cookie: false });
  ok('/sounds без ключа = 403', r.status === 403, r.status);
  cookie = savedCookie;

  r = await req('/sounds/arbuz.mp3');
  const sndType = r.headers.get('content-type') || '';
  ok('/sounds с cookie = 200 audio', r.status === 200 && sndType.includes('audio'), r.status + ' ' + sndType);
  await r.body.cancel();

  r = await req('/sounds/no_such.mp3');
  ok('/sounds несуществующий = 404', r.status === 404, r.status);
  await r.body.cancel();

  // ── path traversal ────────────────────────────────────────────────────────
  r = await text('/download/' + encodeURIComponent('../package.json') + '?key=' + VK);
  ok('traversal /download = 400', r.status === 400, r.status);
  r = await text('/delete/' + encodeURIComponent('../../package.json') + '?key=' + VK);
  ok('traversal /delete = 400', r.status === 400, r.status);

  // ── устройство: /ping + /log ──────────────────────────────────────────────
  const dev = 'dev_test_1';
  r = await json('/ping', {
    method: 'POST',
    headers: { 'x-key': UK, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: dev, device: 'Pixel 8 Pro', android: '14', sdk: 34, sounds: ['arbuz', 'svinka'] })
  });
  ok('/ping = ok', r.status === 200 && r.body.ok === true, r.status);

  r = await json('/log', {
    method: 'POST',
    headers: { 'x-key': UK, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: dev, device: 'Pixel 8 Pro', android: '14', sdk: 34, ok: true, note: 'started <script>alert(1)</script>' })
  });
  ok('/log = ok', r.status === 200 && r.body.ok === true, r.status);

  r = await json('/log', { method: 'POST', headers: { 'x-key': 'nope', 'content-type': 'application/json' }, body: '{}' });
  ok('/log с плохим ключом = 403', r.status === 403, r.status);

  r = await text('/?key=' + VK + '&tab=logs');
  ok('лог экранирует XSS', !r.body.includes('<script>alert(1)</script>') && r.body.includes('&lt;script&gt;'), 'raw script leaked');
  ok('устройство видно на обзоре', r.body.includes('Pixel 8 Pro'));

  // ── команды: очередь, long-poll, отмена ───────────────────────────────────
  r = await text('/cmd/send?key=' + VK + '&device=' + dev + '&cmd=screenshot');
  ok('/cmd/send = 302', r.status === 302, r.status);

  r = await text('/cmd/send?key=' + VK + '&device=' + dev + '&cmd=sound&name=arbuz');
  ok('/cmd/send sound = 302', r.status === 302, r.status);

  r = await text('/?key=' + VK + '&tab=control&device=' + dev);
  ok('страница девайса показывает очередь', r.body.includes('Очередь команд'), 'no queue block');
  ok('панель показывает звуки с сервера', r.body.includes('data-preview="ayyy-scream"'), 'no server sound in list');
  ok('панель даёт плеер', r.body.includes('id="snd-preview"'), 'no audio player');
  ok('кнопка перезагрузки на месте', r.body.includes('cmd=reboot'), 'no reboot card');
  ok('кнопка блока экрана на месте', r.body.includes('cmd=screenlock'), 'no lock card');
  ok('блок «Картинка на экран»', r.body.includes('Картинка на экран'), 'no image panel');
  ok('кнопка «Убрать с экрана»', r.body.includes('cmd=imagehide'), 'no imagehide');

  // картинка: загрузка с панели + раздача устройству по x-key
  const png1x1 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');

  const fdBad = new FormData();
  fdBad.append('file', new Blob([png1x1], { type: 'image/png' }), 'probe.png');
  ok('/images/upload без ключа = 403', (await req('/images/upload', { method: 'POST', body: fdBad, cookie: false })).status === 403, 'no auth');

  const fdImg = new FormData();
  fdImg.append('key', VK);
  fdImg.append('device', dev);
  fdImg.append('file', new Blob([png1x1], { type: 'image/png' }), 'probe.png');
  r = await req('/images/upload', { method: 'POST', body: fdImg });
  ok('/images/upload с ключом = 302', r.status === 302, r.status);

  const imgPage = await text('/?key=' + VK + '&tab=control&device=' + dev);
  const imgMatch = imgPage.body.match(/\/media\/([^"]*probe\.png)/);
  ok('загруженная картинка видна в панели', !!imgMatch, 'not listed');

  if (imgMatch) {
    const wallName = imgMatch[1];
    ok('/wall без ключа = 403', (await req('/wall/' + wallName, { cookie: false })).status === 403, 'public');
    const wall = await req('/wall/' + wallName, { headers: { 'x-key': UK }, cookie: false });
    ok('/wall по x-key = 200', wall.status === 200, wall.status);
    ok('/wall отдаёт png', (wall.headers.get('content-type') || '').includes('image/png'), wall.headers.get('content-type'));

    await text('/images/delete/' + encodeURIComponent(wallName) + '?key=' + VK + '&device=' + dev);
    ok('/wall после удаления = 404', (await req('/wall/' + wallName, { headers: { 'x-key': UK }, cookie: false })).status === 404, 'still there');
  }

  r = await json('/cmd/poll', {
    method: 'POST',
    headers: { 'x-key': UK, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: dev, wait: 1 })
  });
  ok('/cmd/poll отдал первую команду', r.body && r.body.ok && r.body.cmd && r.body.cmd.cmd === 'screenshot', JSON.stringify(r.body).slice(0, 120));

  r = await json('/cmd/poll', {
    method: 'POST',
    headers: { 'x-key': UK, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: dev, wait: 1 })
  });
  ok('/cmd/poll отдал вторую команду с name', r.body && r.body.cmd && r.body.cmd.cmd === 'sound' && r.body.cmd.name === 'arbuz', JSON.stringify(r.body).slice(0, 120));

  r = await text('/cmd/send?key=' + VK + '&device=' + dev + '&cmd=streamstart');
  r = await text('/cmd/cancel?key=' + VK + '&device=' + dev + '&i=0');
  ok('/cmd/cancel = 302', r.status === 302, r.status);

  r = await json('/cmd/poll', {
    method: 'POST',
    headers: { 'x-key': UK, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: dev, wait: 1 })
  });
  ok('снятая команда не приходит', !(r.body && r.body.cmd), JSON.stringify(r.body).slice(0, 120));

  // ── лимит очереди ─────────────────────────────────────────────────────────
  for (let i = 0; i < 60; i++) await text('/cmd/send?key=' + VK + '&device=' + dev + '&cmd=stopsound');
  r = await text('/?key=' + VK + '&tab=control&device=' + dev);
  const pend = (r.body.match(/Снять команду\?/g) || []).length;
  ok('очередь ограничена 50', pend === 50, 'в очереди ' + pend);

  // ── загрузка дампа ────────────────────────────────────────────────────────
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('PK\x05\x06' + '\0'.repeat(18))], { type: 'application/zip' }), 'test.zip');
  r = await json('/upload', { method: 'POST', headers: { 'x-key': UK, 'x-device': 'Pixel 8 Pro' }, body: fd });
  ok('/upload = ok', r.status === 200 && r.body.ok === true, JSON.stringify(r.body).slice(0, 120));

  r = await text('/?key=' + VK + '&tab=dumps');
  ok('дамп виден в списке', /dump_\d+\.zip/.test(r.body), 'no dump row');
  const dumpFile = (r.body.match(/dump_\d+\.zip/) || [])[0];

  r = await text('/download/' + dumpFile + '?key=' + VK);
  ok('/download существующего = 200', r.status === 200, r.status);

  r = await text('/delete/' + dumpFile + '?key=' + VK);
  ok('/delete = 302', r.status === 302, r.status);

  // ── поток кадров ──────────────────────────────────────────────────────────
  r = await json('/stream/frame', {
    method: 'POST',
    headers: { 'x-key': UK, 'x-device-id': dev, 'content-type': 'image/jpeg' },
    body: Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  });
  ok('/stream/frame = ok', r.status === 200 && r.body.ok === true, r.status);

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 1200);
  let mjpegStatus = 0, mjpegType = '';
  try {
    const mr = await fetch(BASE + '/stream/' + dev + '?key=' + VK, { signal: ac.signal });
    mjpegStatus = mr.status;
    mjpegType = mr.headers.get('content-type') || '';
    await mr.body.cancel();
  } catch (e) { /* abort — это нормально, поток не кончается */ }
  clearTimeout(t);
  ok('/stream/:device = 200 MJPEG', mjpegStatus === 200 && mjpegType.includes('multipart/x-mixed-replace'), mjpegStatus + ' ' + mjpegType);

  r = await text('/stream/stop?key=' + VK + '&device=' + dev, { method: 'POST' });
  ok('/stream/stop = ok', r.status === 200, r.status);

  // ── настройки ─────────────────────────────────────────────────────────────
  const body = new URLSearchParams();
  body.set('key', VK); body.set('theme', 'terminal'); body.set('density', 'dense');
  body.set('fontSize', '16'); body.set('pageSize', '100'); body.set('autoRefresh', '0');
  body.set('startTab', 'control'); body.set('showThumb', 'on');
  r = await text('/settings', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  ok('/settings = 302', r.status === 302, r.status);

  r = await text('/?key=' + VK);
  ok('тема применилась', r.body.includes('t-terminal') && r.body.includes('is-dense'), 'theme not applied');

  r = await text('/theme/mono?key=' + VK);
  ok('/theme/:id = 302', r.status === 302, r.status);

  // ── очистка логов ─────────────────────────────────────────────────────────
  r = await text('/clearlogs?key=' + VK);
  ok('/clearlogs = 302', r.status === 302, r.status);
  r = await text('/clearuploadlogs?key=' + VK);
  ok('/clearuploadlogs = 302', r.status === 302, r.status);
  r = await text('/clear?key=' + VK);
  ok('/clear = 302', r.status === 302, r.status);

  // ── вкладки рендерятся ────────────────────────────────────────────────────
  for (const tab of ['overview', 'dumps', 'control', 'screen', 'logs', 'uploadlog', 'settings']) {
    const t = await text('/?key=' + VK + '&tab=' + tab);
    ok('вкладка ' + tab + ' = 200', t.status === 200 && t.body.includes('</html>'), t.status);
  }

  const tScreen = await text('/?key=' + VK + '&tab=screen&device=' + dev);
  ok('вкладка screen с девайсом = 200', tScreen.status === 200 && tScreen.body.includes('data-stream'), tScreen.status);

  console.log(results.join('\n'));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });