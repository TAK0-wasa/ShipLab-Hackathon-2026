// 2台のPCに見立てた通し確認。Supabase の代わりに、同じ形で応答する簡易サーバーを立てる。
// 幹事のアプリと、メンバーのアプリを、保存先を完全に分けて起動し、招待コードだけで同じ会議に入れるかを見る。
// 実行: node test/smoke-two-pc.js
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const rows = new Map(); // room|kind|id → data
const stats = { get: 0, post: 0, del: 0, denied: 0 };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const eq = (k) => (u.searchParams.get(k) || '').replace(/^eq\./, '');
  if (u.pathname.startsWith('/functions/')) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{}'); } // AIサーバーは無い、という想定
  if (!u.pathname.endsWith('/rest/v1/docs') || !req.headers.apikey || req.headers.authorization !== 'Bearer ' + req.headers.apikey) {
    stats.denied++;
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ message: 'No API key found' }));
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const xroom = req.headers['x-room'] || ''; // 本物と同じく、x-room の会議の行だけを読み書きさせる
    if (req.method === 'GET') {
      stats.get++;
      const out = [...rows.entries()].filter(([k]) => k.startsWith(eq('room') + '|') && eq('room') === xroom).map(([k, data]) => ({ kind: k.split('|')[1], id: k.split('|').slice(2).join('|'), data }));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
    if (req.method === 'POST') {
      stats.post++;
      if (u.searchParams.get('on_conflict') !== 'room,kind,id' || !/merge-duplicates/.test(req.headers.prefer || '')) { res.writeHead(400); return res.end(JSON.stringify({ message: 'upsert の指定がない' })); }
      const list = JSON.parse(body);
      if (list.some((r) => r.room !== xroom)) { stats.denied++; res.writeHead(403, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ message: 'new row violates row-level security policy', code: '42501' })); }
      for (const r of list) rows.set(`${r.room}|${r.kind}|${r.id}`, r.data);
      res.writeHead(201);
      return res.end();
    }
    if (req.method === 'DELETE') {
      stats.del++;
      if (eq('room') === xroom) rows.delete(`${eq('room')}|${eq('kind')}|${eq('id')}`);
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(405);
    res.end();
  });
});

server.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  const dir = process.env.SMOKE_OUT ? path.resolve(process.env.SMOKE_OUT) : fs.mkdtempSync(path.join(os.tmpdir(), 'adk-two-'));
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['code.txt', 'ok-leader', 'ok-member', 'member-saw-decided', 'leader', 'member']) fs.rmSync(path.join(dir, f), { force: true, recursive: true });
  const electron = require('electron');
  const run = (role) =>
    new Promise((resolve) => {
      const p = spawn(electron, ['--no-sandbox', '--disable-gpu', path.join(__dirname, 'two-pc-main.js')], { env: { ...process.env, ROLE: role, TWO_PC_DIR: dir, FAKE_DB_URL: url }, stdio: ['ignore', 'pipe', 'pipe'] });
      const show = (d) => String(d).split('\n').filter((l) => l.includes(`[${role}]`)).forEach((l) => console.log(l));
      p.stdout.on('data', show);
      p.stderr.on('data', show);
      p.on('exit', (code) => resolve(code));
    });
  const leader = run('leader');
  for (let i = 0; i < 200 && !fs.existsSync(path.join(dir, 'code.txt')); i++) await new Promise((r) => setTimeout(r, 300));
  if (!fs.existsSync(path.join(dir, 'code.txt'))) { console.error('TWO-PC SMOKE NG: 招待コードが作られない'); process.exit(1); }
  const member = run('member');
  const codes = await Promise.all([leader, member]);
  server.close();
  const rooms = new Set([...rows.keys()].map((k) => k.split('|')[0]));
  console.log(`サーバーへの通信: 読み${stats.get}回・書き${stats.post}回・消し${stats.del}回・拒否${stats.denied}回 ／ 削除後に残った会議の数: ${rooms.size} ／ 文書の数: ${rows.size}`);
  if (codes.every((c) => c === 0) && rooms.size === 0 && rows.size === 0 && stats.denied === 0 && stats.post > 20) {
    console.log('TWO-PC SMOKE OK', dir);
    process.exit(0);
  }
  console.error('TWO-PC SMOKE NG', codes);
  process.exit(1);
});
