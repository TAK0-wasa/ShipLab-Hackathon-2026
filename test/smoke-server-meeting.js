// Web版 ＋ 会議をサーバーで進める関数「meeting」の通し確認。
// Supabase の代わりの簡易サーバーに、本物と同じ中身（supabase/functions/meeting/core.mjs）を載せて、
// 「画面はAIを呼ばず、合図を送るだけ。会議はサーバーが進める」ことを確かめる。
// 実行: node web/build.js のあと npx electron test/smoke-server-meeting.js
const { app, BrowserWindow } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Engine = require('../src/engine.js');
const { mockLlm } = require('./mocks.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-srv-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'user'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ANON = 'anon-key';
const rows = new Map();
const stats = { kicks: 0, pings: 0, llm: 0, claudeCalls: 0 };

app.whenReady().then(async () => {
  const { createMeetingServer } = await import('../supabase/functions/meeting/core.mjs');
  const answer = mockLlm({});
  const json = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
  // 関数の中から保存先とClaudeを呼ぶ部分（同じ rows を直接読み書きする）
  const innerFetch = async (url, opt = {}) => {
    const u = new URL(url);
    const h = Object.fromEntries(Object.entries(opt.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (u.host === 'claude.test') {
      stats.llm++;
      await sleep(30);
      const body = JSON.parse(opt.body);
      return json(200, { content: [{ type: 'text', text: await answer({ system: body.system, messages: body.messages, search: !!body.tools }) }], stop_reason: 'end_turn' });
    }
    const eq = (k) => (u.searchParams.get(k) || '').replace(/^eq\./, '');
    if (u.pathname === '/rest/v1/rpc/relay_take') return json(200, true);
    const method = opt.method || 'GET';
    if (method === 'GET') return json(200, [...rows.entries()].filter(([k]) => k.startsWith(eq('room') + '|') && eq('room') === h['x-room']).map(([k, data]) => ({ kind: k.split('|')[1], id: k.split('|').slice(2).join('|'), data })));
    if (method === 'POST') { for (const r of JSON.parse(opt.body)) rows.set(`${r.room}|${r.kind}|${r.id}`, r.data); return json(201, {}); }
    if (method === 'DELETE') { rows.delete(`${eq('room')}|${eq('kind')}|${eq('id')}`); return json(204, {}); }
    return json(405, {});
  };
  let self = '';
  // 1回の実行時間をわざと短くして、区切り → 自分を呼び直す → 続きから、も通す
  const handle = createMeetingServer({ Engine, fetch: innerFetch, env: { SUPABASE_URL: 'http://db.test', ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_URL: 'http://claude.test/v1/messages' }, budgetMs: 200, lockWait: 0, retryWait: 0 });
  const corsH = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, corsH); return res.end(); }
    const u = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const send = (status, data) => { res.writeHead(status, { ...corsH, 'content-type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
      const eq = (k) => (u.searchParams.get(k) || '').replace(/^eq\./, '');
      if (u.pathname === '/functions/v1/claude') {
        const b = JSON.parse(body || '{}');
        if (!b.ping) stats.claudeCalls++;
        return send(200, { ok: true, ready: false }); // 画面からAIを呼ぶ道は使えない、という想定
      }
      if (u.pathname === '/functions/v1/meeting') {
        const b = JSON.parse(body || '{}');
        if (b.ping) stats.pings++; else stats.kicks++;
        const out = await handle({
          body: b,
          headers: { apikey: req.headers.apikey || '', authorization: req.headers.authorization || '' },
          background: (p) => void p.catch(() => {}),
          chain: (again) => new Promise((resolve) => {
            const r = http.request(self + '/functions/v1/meeting', { method: 'POST', headers: { 'content-type': 'application/json', ...again.headers } }, (x) => { x.resume(); x.on('end', resolve); });
            r.end(JSON.stringify(again.body));
          }),
        });
        return send(out.status, out.body);
      }
      if (u.pathname !== '/rest/v1/docs' || req.headers.apikey !== ANON) return send(401, { message: 'No API key found' });
      const xroom = req.headers['x-room'] || '';
      if (req.method === 'GET') return send(200, [...rows.entries()].filter(([k]) => k.startsWith(eq('room') + '|') && eq('room') === xroom).map(([k, data]) => ({ kind: k.split('|')[1], id: k.split('|').slice(2).join('|'), data })));
      if (req.method === 'POST') { for (const r of JSON.parse(body)) rows.set(`${r.room}|${r.kind}|${r.id}`, r.data); return send(201); }
      if (req.method === 'DELETE') { rows.delete(`${eq('room')}|${eq('kind')}|${eq('id')}`); return send(204); }
      send(405);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  self = `http://127.0.0.1:${server.address().port}`;

  // Web版のページ。本物は https にしかつながらない設定なので、この確認の間だけ手元のサーバーにつなげるようにした写しを使う
  const src = path.join(__dirname, '..', 'web');
  const page = path.join(tmp, 'web');
  fs.mkdirSync(page);
  fs.writeFileSync(path.join(page, 'index.html'), fs.readFileSync(path.join(src, 'index.html'), 'utf8').replace('connect-src https:', 'connect-src http://127.0.0.1:*'));
  fs.copyFileSync(path.join(src, 'app.js'), path.join(page, 'app.js'));

  const win = new BrowserWindow({ width: 1180, height: 820, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const wc = win.webContents;
  const errors = [];
  wc.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) errors.push(e.message); });
  const js = (code) => wc.executeJavaScript(code);
  const until = async (fn, label, ms) => { for (let i = 0; i < (ms || 40000) / 250; i++) { if (await fn()) return; await sleep(250); } throw new Error('待っても変わらない: ' + label); };
  const state = (room) => rows.get(`${room}|state|main`) || {};
  try {
    await win.loadFile(path.join(page, 'index.html'), { query: { db: 'none' } });
    await sleep(600);
    // 会議に参加した状態を作る（接続先は手元のサーバー）。代表者を含めて3人、うち2人はすでに預けている
    const room = 'SRVTEST1';
    rows.set(`${room}|room|main`, { theme: 'かゆいところに手が届くアプリ', criteria: 'テーマに合っているか\n新しさ ×2', teamSize: 3, leaderId: 'someone-else' });
    const brief = (t) => Engine.normalizeBrief({ ideas: [{ title: t, summary: t + 'の説明', target: { text: '学生', by: 'me' }, problem: { text: '', by: 'ai' }, feature: '目玉', push: 'push' }], likes: '好き', worries: '不安', mustHaves: ['動くこと'] });
    for (const [id, name, t] of [['m-aoi', 'あおい', '講義メモ'], ['m-kenta', 'けんた', 'レシート割り勘']]) {
      rows.set(`${room}|member|${id}`, { name, deposited: true });
      rows.set(`${room}|brief|${id}`, brief(t));
    }
    await js(`window.api.saveConfig({ name: 'りょうま', room: ${JSON.stringify(room)}, supabaseUrl: ${JSON.stringify(self)}, supabaseKey: ${JSON.stringify(ANON)} }).then(() => true)`);
    await win.loadFile(path.join(page, 'index.html'), { query: { db: 'none' } });
    await until(async () => js(`window.api.getConfig().then((c) => c.serverMeeting === true && c.serverAi === false)`), '関数「meeting」が使えることを見分けられない', 10000);
    await until(async () => (await js(`(document.querySelector('#who') || {}).innerText || ''`)).includes('りょうま'), '会議に入れない', 10000);
    if (stats.kicks) throw new Error('全員が預ける前に、会議を始める合図を送っている');
    // 自分（代表者ではないメンバー）が預ける → 画面はAIを呼べないが、合図だけでサーバーが会議を最後まで進める
    const me = await js(`window.api.getConfig().then((c) => c.memberId)`);
    await js(`(async () => { await api.store.put('brief', ${JSON.stringify(me)}, ${JSON.stringify(brief('集まらなくても決まるアプリ'))}); await api.store.put('member', ${JSON.stringify(me)}, { name: 'りょうま', deposited: true }); })()`);
    await until(async () => state(room).phase === 'review', 'サーバーが会議を進めない: ' + JSON.stringify([stats, state(room).phase, state(room).error]), 60000);
    if (!stats.kicks) throw new Error('画面から合図が送られていない');
    if (stats.claudeCalls) throw new Error('画面からAIを呼んでいる（サーバーに任せていない）');
    if (!stats.llm) throw new Error('サーバーがAIを呼んでいない');
    if (state(room).runner) throw new Error('終わったのに、進行役が残っている');
    const sysMsgs = [...rows.entries()].filter(([k]) => k.startsWith(room + '|msg|')).map(([, d]) => d).filter((m) => m.type === 'system').map((m) => m.text);
    if (sysMsgs.some((t) => t.includes('止まったところから'))) throw new Error('時間の区切りが、止まったこととしてログに出ている: ' + sysMsgs.join(' / '));
    // 画面にも推薦案が出る
    await js(`document.querySelectorAll('#nav button')[1].click()`);
    await until(async () => (await js(`document.querySelector('#view').innerText`)).includes('この案を承認する'), '画面に推薦案が出ない', 15000);
    if (errors.length) throw new Error('コンソールエラー: ' + errors.join(' / '));
    console.log(`SERVER-MEETING SMOKE OK（合図 ${stats.kicks} 回・サーバーのAI呼び出し ${stats.llm} 回・画面からのAI呼び出し ${stats.claudeCalls} 回）`);
    app.exit(0);
  } catch (e) {
    console.error('SERVER-MEETING SMOKE NG', e.message, errors);
    app.exit(1);
  }
});
