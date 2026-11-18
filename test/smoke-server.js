// AIをサーバー経由で呼ぶ確認。Supabase の代わりに、同じ形で応答する簡易サーバー（データベース＋関数「claude」）を立てる。
// 実行: npx electron test/smoke-server.js
const { app, BrowserWindow } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-srv-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'user'));

const rows = new Map();
const calls = [];
let ready = true;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const eq = (k) => (u.searchParams.get(k) || '').replace(/^eq\./, '');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
    if (u.pathname === '/functions/v1/claude') {
      const b = JSON.parse(body || '{}');
      if (b.ping) return send(200, { ok: true, ready });
      calls.push({ headers: req.headers, body: b });
      if (![...rows.keys()].some((k) => k === `${b.room}|room|main`)) return send(403, { error: { message: 'この会議は見つかりません' } });
      return send(200, { content: [{ type: 'text', text: 'サーバー経由の応答です' }], stop_reason: 'end_turn' });
    }
    if (!u.pathname.endsWith('/rest/v1/docs')) return send(404, {});
    if (req.method === 'GET') return send(200, [...rows.entries()].filter(([k]) => k.startsWith(eq('room') + '|')).map(([k, data]) => ({ kind: k.split('|')[1], id: k.split('|').slice(2).join('|'), data })));
    if (req.method === 'POST') { for (const r of JSON.parse(body)) rows.set(`${r.room}|${r.kind}|${r.id}`, r.data); return send(201); }
    if (req.method === 'DELETE') { rows.delete(`${eq('room')}|${eq('kind')}|${eq('id')}`); return send(204); }
    send(405, {});
  });
});

server.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  process.env.KAWARINI_DB = process.env.KAWARINI_DB || 'none'; // アプリに入っている接続先は使わない
require('../main.js');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  app.whenReady().then(async () => {
    await sleep(1500);
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    const js = (code) => wc.executeJavaScript(code);
    const must = (ok, msg) => { if (!ok) throw new Error(msg); };
    try {
      let c = await js(`window.api.getConfig()`);
      must(!c.hasApiKey && !c.serverAi, '会議が無いのにAIが使えることになっている');
      c = await js(`window.api.saveConfig({ name: 'てすと', room: 'r1', supabaseUrl: ${JSON.stringify(url)}, supabaseKey: 'sb_publishable_test' })`);
      must(c.serverAi && !c.hasApiKey, 'サーバー経由のAIが見つからない');
      // 会議がまだサーバーに無いうちは断られる
      const denied = await js(`window.api.llm({ system: 's', messages: [{ role: 'user', content: 'こんにちは' }] }).then(() => 'ok', (e) => String(e.message || e))`);
      must(denied.includes('この会議は見つかりません'), '実在しない会議からの呼び出しが通った: ' + denied);
      await js(`window.api.store.put('room', 'main', { theme: 'てすと', teamSize: 3 })`);
      const out = await js(`window.api.llm({ system: 's', messages: [{ role: 'user', content: 'こんにちは' }], maxTokens: 500 })`);
      must(out === 'サーバー経由の応答です', '応答が違う: ' + out);
      const last = calls[calls.length - 1];
      must(last.body.room === 'r1' && last.body.max_tokens === 500 && last.body.system === 's', 'サーバーに渡した内容が違う');
      must(!last.headers['x-api-key'] && last.headers.apikey === 'sb_publishable_test', 'ヘッダーが違う');
      // 画面: キーなしでも代理人と会話できる表示になる
      await js(`location.reload()`); await sleep(2000);
      const who = await js(`document.querySelector('#who').innerText`);
      must(who.includes('AI：サーバー経由'), 'ヘッダーに表示が出ない: ' + who);
      console.log('SERVER SMOKE OK');
      app.exit(0);
    } catch (e) {
      console.log('SERVER SMOKE FAILED: ' + e.message);
      app.exit(1);
    }
  });
});
