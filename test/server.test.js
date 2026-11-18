// 会議をサーバー側で進める中身（supabase/functions/meeting/core.mjs）のテスト。
// Supabase と Claude の代わりに、同じ形で応答する見本の fetch を渡して確かめる。実行: node test/server.test.js
const assert = require('assert');
const Engine = require('../src/engine.js');
const { mockLlm, calls } = require('./mocks.js');

(async () => {
  const { createMeetingServer } = await import('../supabase/functions/meeting/core.mjs');
  const rows = new Map(); // room|kind|id → { data, updated_at }
  const usage = { n: 0, limit: 1000 };
  const SERVICE = 'service-key';
  const ANON = 'anon-key';
  let llmDelay = 0; // 見本のAIが1回答えるのにかかる時間（時間の区切りを起こすため）
  const answer = mockLlm({});
  const json = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
  const fakeFetch = async (url, opt = {}) => {
    const u = new URL(url);
    const h = Object.fromEntries(Object.entries(opt.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (u.host === 'claude.test') {
      assert.strictEqual(h['x-api-key'], 'sk-test', 'Claudeの鍵はサーバーからだけ送られる');
      const body = JSON.parse(opt.body);
      if (llmDelay) await new Promise((r) => setTimeout(r, llmDelay));
      return json(200, { content: [{ type: 'text', text: await answer({ system: body.system, messages: body.messages, search: !!body.tools }) }], stop_reason: 'end_turn' });
    }
    const eq = (k) => (u.searchParams.get(k) || '').replace(/^eq\./, '');
    const service = h.apikey === SERVICE;
    if (h.apikey !== ANON && !service) return json(401, { message: 'No API key found' });
    if (u.pathname === '/rest/v1/rpc/relay_take') return json(200, ++usage.n <= usage.limit);
    if (u.pathname !== '/rest/v1/docs') return json(404, {});
    const xroom = h['x-room'] || '';
    const method = opt.method || 'GET';
    if (method === 'GET') {
      if (!eq('room')) {
        assert.ok(service, '会議をまたいだ一覧は、サーバーの鍵でしか読めない');
        return json(200, [...rows.keys()].map((k) => ({ room: k.split('|')[0] })));
      }
      if (!service && eq('room') !== xroom) return json(200, []);
      return json(200, [...rows.entries()].filter(([k]) => k.startsWith(eq('room') + '|')).map(([k, v]) => ({ kind: k.split('|')[1], id: k.split('|').slice(2).join('|'), data: v.data })));
    }
    if (method === 'POST') {
      for (const r of JSON.parse(opt.body)) {
        if (!service && r.room !== xroom) return json(403, { message: 'row-level security' });
        rows.set(`${r.room}|${r.kind}|${r.id}`, { data: r.data });
      }
      return json(201, {});
    }
    if (method === 'DELETE') {
      rows.delete(`${eq('room')}|${eq('kind')}|${eq('id')}`);
      return json(204, {});
    }
    return json(405, {});
  };
  const env = { SUPABASE_URL: 'http://db.test', SUPABASE_SERVICE_ROLE_KEY: SERVICE, ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_URL: 'http://claude.test/v1/messages' };
  const mk = (budgetMs) => createMeetingServer({ Engine, fetch: fakeFetch, env, budgetMs, lockWait: 0, retryWait: 0 });
  const put = (room, kind, id, data) => rows.set(`${room}|${kind}|${id}`, { data });
  const state = (room) => (rows.get(`${room}|state|main`) || {}).data || {};
  const seed = (room, n, extra) => {
    put(room, 'room', 'main', { theme: 'かゆいところに手が届くアプリ', criteria: 'テーマに合っているか\n新しさ ×2', teamSize: 3, leaderId: 'm1', ...(extra || {}) });
    for (let i = 1; i <= n; i++) {
      put(room, 'member', 'm' + i, { name: 'P' + i, deposited: true });
      put(room, 'brief', 'm' + i, Engine.normalizeBrief({ ideas: [{ title: `P${i}の案`, summary: '概要', target: { text: '学生', by: 'me' }, problem: { text: '', by: 'ai' }, feature: '目玉', push: 'push' }], likes: '好き', worries: '不安', mustHaves: ['動くこと'] }));
    }
  };
  // 呼び出しを、本物と同じ「応答を返したあとも裏で進む・区切ったら自分を呼び直す」形で動かす
  const jobs = [];
  let chained = 0;
  const call = async (handle, body, headers) => {
    const out = await handle({
      body,
      headers,
      background: (p) => void jobs.push(p),
      chain: async (again) => { chained++; await call(handle, again.body, again.headers); },
    });
    return out;
  };
  const drain = async () => { while (jobs.length) await jobs.shift(); };
  const anon = { apikey: ANON, authorization: 'Bearer ' + ANON };

  // 1. 準備の確認（ping）と、会議の指定がない・見つからないとき
  let handle = mk(100000);
  assert.deepStrictEqual((await call(handle, { ping: true }, {})).body, { ok: true, ready: true });
  assert.strictEqual((await call(handle, {}, anon)).status, 403);
  assert.strictEqual((await call(handle, { room: 'NOPE' }, anon)).status, 403);
  assert.strictEqual((await call(handle, { room: 'R1' }, { apikey: 'wrong' })).status, 403);

  // 2. まだ全員が預けていないときは始めない
  seed('R1', 2);
  let out = await call(handle, { room: 'R1' }, anon);
  assert.deepStrictEqual([out.status, out.body.started], [200, false]);

  // 3. 全員が預けたら、画面が開いていなくてもサーバーが最後まで進める
  seed('R1', 3);
  calls.length = 0;
  out = await call(handle, { room: 'R1' }, anon);
  assert.deepStrictEqual([out.status, out.body.started, out.body.mode], [202, true, 'full']);
  await drain();
  assert.strictEqual(state('R1').phase, 'review', '推薦案まで進む: ' + JSON.stringify(state('R1').error || ''));
  assert.ok(state('R1').recommendation && state('R1').recommendation.topId);
  assert.strictEqual(state('R1').runner, null);
  assert.strictEqual(chained, 0, '時間内に終わるなら呼び直さない');
  assert.strictEqual(usage.n, calls.length, 'AIを呼ぶたびに回数を数える');
  const fullCalls = calls.length;
  // 進めることがなくなったら、もう一度呼ばれても何もしない
  out = await call(handle, { room: 'R1' }, anon);
  assert.strictEqual(out.body.started, false);

  // 4. 1回の実行時間に収まらないときは、区切って自分を呼び直し、続きから最後まで進める（同じ段階をやり直さない）
  seed('R2', 3);
  handle = mk(120);
  llmDelay = 50;
  calls.length = 0;
  out = await call(handle, { room: 'R2' }, anon);
  assert.strictEqual(out.status, 202);
  await drain();
  llmDelay = 0;
  assert.strictEqual(state('R2').phase, 'review', '区切りをまたいでも推薦案まで進む: ' + JSON.stringify(state('R2').error || ''));
  assert.ok(chained >= 2, '区切るたびに呼び直す: ' + chained);
  assert.ok(!state('R2').paused, '終わったら区切りの印は消える');
  assert.ok(calls.length <= fullCalls + chained, `済んだ段階はやり直さない（呼び出し ${calls.length} 回 / 通しで ${fullCalls} 回 / 区切り ${chained} 回）`);

  // 5. 見回り: 預ける締切を過ぎた会議を、だれの画面も開いていなくても、預けた人だけで始める
  seed('R3', 2, { deadlineAt: Date.now() - 1000 });
  handle = mk(100000);
  assert.strictEqual((await call(handle, { tick: true }, anon)).status, 403, '見回りは、サーバーの鍵でしか呼べない');
  out = await call(handle, { tick: true }, { authorization: 'Bearer ' + SERVICE });
  assert.strictEqual(out.status, 202);
  await drain();
  assert.strictEqual(state('R3').phase, 'review');
  assert.deepStrictEqual(state('R3').participants.sort(), ['m1', 'm2']);
  assert.strictEqual(state('R3').runnerName, '');

  // 6. 回数の上限に達したら止まり、会議の画面に理由が出る（自動では繰り返さない）
  seed('R4', 3);
  usage.limit = usage.n + 2;
  out = await call(handle, { room: 'R4' }, anon);
  await drain();
  assert.ok(/上限/.test(state('R4').error || ''), '止まった理由が残る: ' + JSON.stringify(state('R4')));
  out = await call(handle, { room: 'R4' }, anon);
  assert.strictEqual(out.body.started, false, '止まったままのときは自動で繰り返さない');

  console.log('OK: サーバー側の会議のテストに通りました');
})().catch((e) => {
  console.error('NG:', e);
  process.exit(1);
});
