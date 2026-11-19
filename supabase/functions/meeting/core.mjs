// MeetForMe: 会議をサーバー側で進めるための中身（Supabase Edge Function「meeting」から使う）
// ねらい: 代表者やメンバーの画面が開いていなくても、会議と「預ける締切」での自動開始が進むようにする。
// この中身は実行環境に依存しない（fetch と設定を外から受け取る）ので、Node のテストでもそのまま動かせる。
//
// 進め方:
//  - 画面からの合図（{ room }）か、1分ごとの見回り（{ tick: true }）で呼ばれる。
//  - 会議を進めるべき状況か（全員が預けた・締切を過ぎた・やり直しが要る・途中で区切った続きがある）は、
//    画面と同じ決まり（Engine.autoMode）で判断する。
//  - 1回の実行に使える時間は限られるので、budgetMs を過ぎたら次のAI呼び出しの前で区切り、
//    自分自身をもう一度呼んで続きから進める（進み具合は会議の state.ck に残っている）。
//  - ClaudeのAPIキーはサーバーの Secrets にだけあり、画面には渡らない。回数の上限（relay_take）も「claude」と同じものを使う。

const MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'];

export function createMeetingServer({ Engine, fetch, env, now = () => Date.now(), budgetMs = 100000, lockWait, retryWait }) {
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const anthropicKey = env.ANTHROPIC_API_KEY || '';
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || '';
  const anthropicUrl = env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages';

  const restHeaders = (apikey, room) => ({ apikey, authorization: `Bearer ${apikey}`, 'x-room': room, 'content-type': 'application/json' });
  const check = async (res, doing) => {
    if (res.ok) return;
    let detail = '';
    try {
      detail = (await res.json()).message || '';
    } catch (e) {}
    throw new Error(`保存先のエラー（${doing}・${res.status}）${detail}`);
  };

  // 会議の保存先（画面と同じ表を、同じ権限で読み書きする）
  function makeStore(apikey, room) {
    const h = restHeaders(apikey, room);
    const q = (kind, id) => `room=eq.${encodeURIComponent(room)}&kind=eq.${encodeURIComponent(kind)}&id=eq.${encodeURIComponent(id)}`;
    return {
      all: async () => {
        const res = await fetch(`${base}/rest/v1/docs?select=kind,id,data&room=eq.${encodeURIComponent(room)}`, { headers: h });
        await check(res, '読む');
        return res.json();
      },
      put: async (kind, id, data) => {
        const res = await fetch(`${base}/rest/v1/docs?on_conflict=room,kind,id`, {
          method: 'POST',
          headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify([{ room, kind, id, data, updated_at: new Date(now()).toISOString() }]),
        });
        await check(res, '書く');
        return true;
      },
      del: async (kind, id) => {
        const res = await fetch(`${base}/rest/v1/docs?${q(kind, id)}`, { method: 'DELETE', headers: h });
        await check(res, '消す');
        return true;
      },
    };
  }

  // AIを呼ぶ。1回ごとに回数を数え、上限を超えたら止める。Web検索の途中で区切られた応答は続きを取りに行く
  function makeLlm(apikey, room, model) {
    return async ({ system, messages, maxTokens, search }) => {
      const take = await fetch(`${base}/rest/v1/rpc/relay_take`, { method: 'POST', headers: restHeaders(apikey, room), body: JSON.stringify({ p_room: room }) });
      const allowed = take.ok ? await take.json() : null;
      if (allowed !== true) throw new Error(take.ok ? '今日のAIの利用回数の上限に達しました（会議ごと1日200回・全体1日1000回）' : `利用回数を確認できませんでした (${take.status})`);
      let useSearch = !!search;
      const post = (msgs) => {
        const body = { model, max_tokens: Math.min(Number(maxTokens) || 2000, 16000), system, messages: msgs };
        if (useSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }];
        return fetch(anthropicUrl, {
          method: 'POST',
          headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      };
      let msgs = messages;
      const texts = [];
      const sources = [];
      for (let turn = 0; turn < 4; turn++) {
        let res = await post(msgs);
        if (!res.ok && useSearch && res.status === 400) {
          useSearch = false;
          res = await post(msgs);
        }
        let data = null;
        try {
          data = await res.json();
        } catch (e) {}
        if (!res.ok) throw new Error(`AIサーバー エラー (${res.status}) ${(data && data.error && data.error.message) || ''}`);
        for (const b of (data && data.content) || []) {
          if (b.type === 'text') texts.push(b.text);
          if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
            for (const r of b.content) if (r && r.url && !sources.includes(r.url)) sources.push(r.url);
          }
        }
        if (!data || data.stop_reason !== 'pause_turn') break;
        msgs = messages.concat([{ role: 'assistant', content: data.content }]);
      }
      return texts.join('') + (sources.length ? '§SRC§' + sources.slice(0, 8).join(' ') : '');
    };
  }

  // 1つの会議を、時間の許すところまで進める。区切ったときは { paused: true } を返す
  async function runRoom(apikey, room) {
    const store = makeStore(apikey, room);
    const snap = await Engine.snapshot(store);
    const auto = Engine.autoMode(snap, now());
    if (!auto) return { started: false };
    const r = (snap.room && snap.room.main) || {};
    const model = MODELS.includes(r.model) ? r.model : MODELS[0];
    const ctx = { store, llm: makeLlm(apikey, room, model), me: { id: 'server', name: 'サーバー' }, stopAt: now() + budgetMs };
    if (lockWait !== undefined) ctx.lockWait = lockWait;
    if (retryWait !== undefined) ctx.retryWait = retryWait;
    try {
      const out = await Engine.runMeeting(ctx, { mode: auto.mode });
      return { started: true, mode: auto.mode, paused: !!(out && out.paused) };
    } catch (e) {
      // 失敗は会議の state.error に残り、画面に「会議が途中で止まりました」と出る（そこから人が再開できる）
      return { started: true, mode: auto.mode, error: String((e && e.message) || e) };
    }
  }

  // 見回り: 最近動きのあった会議のうち、進めるべきものを1つだけ進める（1回の実行時間に収めるため）
  async function tick() {
    if (!serviceKey) return { ok: false, message: 'SUPABASE_SERVICE_ROLE_KEY がありません' };
    const since = new Date(now() - 7 * 24 * 3600 * 1000).toISOString();
    const res = await fetch(`${base}/rest/v1/docs?select=room&kind=in.(brief,state,room)&updated_at=gte.${encodeURIComponent(since)}&order=updated_at.desc&limit=300`, {
      headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
    });
    await check(res, '見回り');
    const rooms = [...new Set((await res.json()).map((x) => x.room))].filter((x) => x && x !== '__check__').slice(0, 40);
    for (const room of rooms) {
      const snap = await Engine.snapshot(makeStore(serviceKey, room));
      if (!Engine.autoMode(snap, now())) continue;
      const out = await runRoom(serviceKey, room);
      return { ok: true, room, ...out };
    }
    return { ok: true, started: false, checked: rooms.length };
  }

  // 呼び出しの入口。background(promise) には、応答を返したあとも続けたい処理を渡す（Edge Function では EdgeRuntime.waitUntil）
  // chain(body, headers) は、自分自身をもう一度呼ぶ関数
  return async function handle({ body, headers, background, chain }) {
    const b = body || {};
    if (b.ping) return { status: 200, body: { ok: true, ready: !!anthropicKey && !!base } };
    if (!anthropicKey) return { status: 500, body: { error: { message: 'サーバーにClaudeのAPIキーが登録されていません（Secrets の ANTHROPIC_API_KEY）' } } };
    const auth = String(headers.authorization || '').replace(/^Bearer\s+/i, '');

    const after = (job, again) =>
      background(
        job().then(async (out) => {
          if (out && out.paused && chain) await chain(again).catch(() => {});
          return out;
        })
      );

    if (b.tick) {
      if (!serviceKey || auth !== serviceKey) return { status: 403, body: { error: { message: '見回りは、サーバーの鍵でだけ呼べます' } } };
      after(() => tick().then((o) => ({ ...o, paused: !!o.paused })), { body: { tick: true }, headers: { authorization: `Bearer ${serviceKey}` } });
      return { status: 202, body: { ok: true } };
    }

    const room = String(b.room || '');
    const apikey = String(headers.apikey || '');
    if (!room || !apikey || room.length > 100) return { status: 403, body: { error: { message: '会議が指定されていません' } } };
    let snap;
    try {
      snap = await Engine.snapshot(makeStore(apikey, room));
    } catch (e) {
      return { status: 403, body: { error: { message: '会議を確認できませんでした' } } };
    }
    if (!snap.room || !snap.room.main) return { status: 403, body: { error: { message: 'この会議は見つかりません' } } };
    const auto = Engine.autoMode(snap, now());
    if (!auto) return { status: 200, body: { ok: true, started: false } };
    after(() => runRoom(apikey, room), { body: { room }, headers: { apikey, authorization: `Bearer ${apikey}` } });
    return { status: 202, body: { ok: true, started: true, mode: auto.mode } };
  };
}
