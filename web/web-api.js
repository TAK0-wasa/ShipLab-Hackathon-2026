// MeetForMe — Web版の土台
// デスクトップ版の main.js / preload.js が受け持っている仕事（設定と個室データの保存、共有ストアとAIサーバーへの通信）を、
// ブラウザの中だけで行う。画面（src/app.js）と会議の処理（src/engine.js）は、デスクトップ版と同じものをそのまま使う。
// ・設定と代理人との会話は、このブラウザ（localStorage）にだけ保存する
// ・AIは会議のサーバー（Supabase の Edge Function「claude」）経由だけで使う。ClaudeのAPIキーはブラウザに置かない
/* global sampleAi */
(function () {
  const VERSION = '__APP_VERSION__';
  const DEFAULT_MODEL = 'claude-sonnet-5-5';
  const REPO_URL = 'https://github.com/TAK0-wasa/ShipLab-Hackathon-2026';
  // デスクトップ版と同じ接続先（公開してよい種類のキー）。会議の中身は、会議の番号を知っている人しか読み書きできない（supabase_setup.sql）
  const BUILTIN_DB = { url: 'https://slezcxntyiyajxxxmwoe.supabase.co', key: 'sb_publishable_jqAZ8vb35FO5shCLOy-lWg_l83h9eLZ' };
  const P = 'kawarini:';
  const qs = new URLSearchParams(location.search);
  // テスト用: ?db=none で接続先なし（このブラウザの中だけ）、?profile=b で別人として動かす（1台で複数人分を試す用）
  const profile = (qs.get('profile') || '').replace(/[^\w-]/g, '');
  const K = (name) => P + (profile ? profile + ':' : '') + name;
  const safeName = (s) => String(s || 'default').replace(/[^\w-]/g, '_').slice(0, 60);

  const readJson = (key, fallback) => {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  };
  const writeJson = (key, data) => {
    try {
      localStorage.setItem(key, JSON.stringify(data));
    } catch (e) {
      throw new Error('このブラウザに保存できませんでした。プライベートブラウズを切るか、空き容量を確かめてください。');
    }
  };
  const dbDefault = () => (qs.get('db') === 'none' ? null : BUILTIN_DB);

  // ---------- 設定 ----------
  function loadConfig() {
    const raw = readJson(K('config'), {});
    const cfg = { model: DEFAULT_MODEL, ...raw, apiKey: '' };
    cfg.rooms = Array.isArray(raw.rooms) ? raw.rooms.filter((r) => r && r.room) : [];
    return cfg;
  }
  function saveConfigRaw(patch) {
    const cur = loadConfig();
    const { removeRoom, roomTitle, apiKey, clearApiKey, ...rest } = patch || {}; // APIキーはブラウザに保存しない
    const next = { ...cur, ...rest };
    delete next.apiKey;
    if (!next.memberId) next.memberId = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    let rooms = cur.rooms.slice();
    if (removeRoom) {
      rooms = rooms.filter((r) => r.room !== removeRoom);
      if (next.room === removeRoom) next.room = rest.room && rest.room !== removeRoom ? rest.room : rooms.length ? rooms[0].room : '';
    }
    if (next.room) {
      const hit = rooms.find((r) => r.room === next.room);
      if (hit && rest.supabaseUrl === undefined) {
        next.supabaseUrl = hit.supabaseUrl || '';
        next.supabaseKey = hit.supabaseKey || '';
      } else if (hit) {
        hit.supabaseUrl = next.supabaseUrl || '';
        hit.supabaseKey = next.supabaseKey || '';
      } else {
        rooms.push({ room: next.room, supabaseUrl: next.supabaseUrl || '', supabaseKey: next.supabaseKey || '', title: '', joinedAt: Date.now() });
      }
      if (roomTitle !== undefined) rooms.find((r) => r.room === next.room).title = String(roomTitle || '').slice(0, 80);
    }
    next.rooms = rooms;
    writeJson(K('config'), next);
  }

  // ---------- AIサーバー ----------
  const srvCache = {};
  const serverUrl = (cfg) => (cfg.supabaseUrl && cfg.supabaseKey ? String(cfg.supabaseUrl).replace(/\/+$/, '') + '/functions/v1/claude' : '');
  const serverHeaders = (cfg) => ({ 'content-type': 'application/json', apikey: cfg.supabaseKey, authorization: 'Bearer ' + cfg.supabaseKey });
  const serverKnown = (cfg) => {
    const u = serverUrl(cfg);
    return !!(u && srvCache[u] && srvCache[u].ok);
  };
  const limit = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${ms / 1000}秒待っても応答がありません`)), ms))]);
  async function probeServer(cfg) {
    const u = serverUrl(cfg);
    if (!u) return false;
    const hit = srvCache[u];
    if (hit && Date.now() - hit.at < (hit.ok ? 300000 : 30000)) return hit.ok;
    let ok = false;
    try {
      const res = await limit(fetch(u, { method: 'POST', headers: serverHeaders(cfg), body: JSON.stringify({ ping: true }) }), 5000);
      const data = res.ok ? await res.json() : null;
      ok = !!(data && data.ok && data.ready);
    } catch (e) {}
    srvCache[u] = { ok, at: Date.now() };
    return ok;
  }
  // ---------- 会議をサーバーで進める（関数「meeting」。入っていなければ、これまでどおり画面側で進める） ----------
  const meetCache = {};
  const meetUrl = (cfg) => serverUrl(cfg).replace(/claude$/, 'meeting');
  const meetKnown = (cfg) => {
    const u = meetUrl(cfg);
    return !!(u && meetCache[u] && meetCache[u].ok);
  };
  async function probeMeeting(cfg) {
    const u = meetUrl(cfg);
    if (!u || cfg.demo) return false;
    const hit = meetCache[u];
    if (hit && Date.now() - hit.at < (hit.ok ? 300000 : 600000)) return hit.ok;
    let ok = false;
    try {
      const res = await limit(fetch(u, { method: 'POST', headers: serverHeaders(cfg), body: JSON.stringify({ ping: true }) }), 4000);
      const data = res.ok ? await res.json() : null;
      ok = !!(data && data.ok && data.ready);
    } catch (e) {}
    meetCache[u] = { ok, at: Date.now() };
    return ok;
  }
  async function kickMeeting() {
    const cfg = loadConfig();
    if (!cfg.room || !(await probeMeeting(cfg))) return { ok: false };
    try {
      const res = await limit(fetch(meetUrl(cfg), { method: 'POST', headers: serverHeaders(cfg), body: JSON.stringify({ room: cfg.room }) }), 15000);
      const data = await res.json().catch(() => null);
      return res.ok && data ? data : { ok: false, status: res.status };
    } catch (e) {
      return { ok: false };
    }
  }
  function publicConfig(cfg) {
    const { apiKey, rooms, ...rest } = cfg;
    const ua = navigator.userAgent || '';
    const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'その他';
    return {
      ...rest,
      rooms: (rooms || []).map((r) => ({ room: r.room, title: r.title || '' })),
      hasApiKey: false,
      serverAi: serverKnown(cfg),
      serverMeeting: meetKnown(cfg),
      dbDefault: dbDefault(),
      demo: !!cfg.demo,
      profile,
      appVersion: VERSION,
      platform: 'Web版 ' + os,
      repoUrl: REPO_URL,
      sharedMode: cfg.supabaseUrl && cfg.supabaseKey ? 'supabase' : 'local',
    };
  }

  // ---------- 共有ストア（Supabase または このブラウザの中だけ） ----------
  function supa(cfg) {
    const base = cfg.supabaseUrl.replace(/\/+$/, '') + '/rest/v1/docs';
    const headers = { apikey: cfg.supabaseKey, Authorization: 'Bearer ' + cfg.supabaseKey, 'content-type': 'application/json', 'x-room': String(cfg.room || '') };
    return { base, headers };
  }
  async function supaCheck(res) {
    if (res.ok) return;
    let msg = '';
    try {
      msg = (await res.json()).message || '';
    } catch (e) {}
    throw new Error(`共有データベースのエラー (${res.status}) ${msg}`);
  }
  const net = async (url, opts) => {
    try {
      return await fetch(url, opts);
    } catch (e) {
      throw new Error('ネットワークにつながりません');
    }
  };
  const sharedKey = (room) => P + 'shared:' + safeName(room); // 別人として開いたタブ（?profile=）とも共有する
  const currentConn = () => {
    const cfg = loadConfig();
    return { room: cfg.room, supabaseUrl: cfg.supabaseUrl, supabaseKey: cfg.supabaseKey };
  };
  async function storeAll(conn) {
    const cfg = conn || currentConn();
    if (!cfg.room) return [];
    if (cfg.supabaseUrl && cfg.supabaseKey) {
      const { base, headers } = supa(cfg);
      const res = await net(`${base}?room=eq.${encodeURIComponent(cfg.room)}&select=kind,id,data`, { headers });
      await supaCheck(res);
      return res.json();
    }
    const all = readJson(sharedKey(cfg.room), {});
    return Object.entries(all).map(([k, data]) => {
      const i = k.indexOf('/');
      return { kind: k.slice(0, i), id: k.slice(i + 1), data };
    });
  }
  async function storePut(kind, id, data) {
    const cfg = currentConn();
    if (!cfg.room) throw new Error('会議が選ばれていません');
    if (cfg.supabaseUrl && cfg.supabaseKey) {
      const { base, headers } = supa(cfg);
      const res = await net(`${base}?on_conflict=room,kind,id`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ room: cfg.room, kind, id, data, updated_at: new Date().toISOString() }]),
      });
      await supaCheck(res);
      return true;
    }
    const all = readJson(sharedKey(cfg.room), {});
    all[`${kind}/${id}`] = data;
    writeJson(sharedKey(cfg.room), all);
    return true;
  }
  async function storeDel(kind, id) {
    const cfg = currentConn();
    if (!cfg.room) return true;
    if (cfg.supabaseUrl && cfg.supabaseKey) {
      const { base, headers } = supa(cfg);
      const q = `room=eq.${encodeURIComponent(cfg.room)}&kind=eq.${encodeURIComponent(kind)}&id=eq.${encodeURIComponent(id)}`;
      const res = await net(`${base}?${q}`, { method: 'DELETE', headers });
      await supaCheck(res);
      return true;
    }
    const all = readJson(sharedKey(cfg.room), {});
    delete all[`${kind}/${id}`];
    writeJson(sharedKey(cfg.room), all);
    return true;
  }
  async function testDb(url, key) {
    if (!/^https?:\/\//.test(url || '')) return { ok: false, msg: 'Project URL は https:// で始まるURLを入れてください。' };
    if (!key) return { ok: false, msg: 'APIキー（publishable または anon）を入れてください。' };
    const explain = async (res, doing) => {
      let body = {};
      try {
        body = await res.json();
      } catch (e) {}
      const m = `${body.message || ''} ${body.code || ''} ${body.hint || ''}`;
      if (res.status === 404 || /PGRST205|does not exist|Could not find the table/i.test(m)) return '接続はできましたが、保存用の表（docs）がまだありません。Supabase の SQL Editor で supabase_setup.sql の中身を実行してください。';
      if (res.status === 401 || res.status === 403 || /42501|row-level security|permission denied/i.test(m)) {
        return doing === 'read' ? 'APIキーが違うか、読む権限がありません。Supabase の publishable（または anon）キーを貼り付けてください。' : '読むことはできますが、書き込みが許可されていません。supabase_setup.sql を最後の行まで実行してください。';
      }
      return `共有データベースのエラー (${res.status}) ${body.message || ''}`;
    };
    try {
      const { base, headers } = supa({ supabaseUrl: url, supabaseKey: key, room: '__check__' });
      let res = await fetch(`${base}?select=room&limit=1`, { headers });
      if (!res.ok) return { ok: false, msg: await explain(res, 'read') };
      const id = 'ping-' + Date.now().toString(36);
      res = await fetch(`${base}?on_conflict=room,kind,id`, { method: 'POST', headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ room: '__check__', kind: 'ping', id, data: { at: Date.now() }, updated_at: new Date().toISOString() }]) });
      if (!res.ok) return { ok: false, msg: await explain(res, 'write') };
      res = await fetch(`${base}?room=eq.__check__&kind=eq.ping&id=eq.${id}`, { method: 'DELETE', headers });
      if (!res.ok) return { ok: false, msg: await explain(res, 'write') };
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: `共有データベースに届きませんでした。URLとネットワークを確かめてください。（${e.message}）` };
    }
  }

  // ---------- AI ----------
  async function callClaude({ system, messages, maxTokens, search }) {
    if (window.__mockLlm) return window.__mockLlm({ system, messages, maxTokens, search }); // テスト専用
    const cfg = loadConfig();
    if (cfg.demo) return sampleAi({ system, messages }); // 見本モード: AIを呼ばない
    if (!(await probeServer(cfg))) throw new Error('AIのサーバーが未設定です（この会議ではAIを使えません。代表者に確かめてください）');
    let useSearch = !!search && cfg.webSearch !== false;
    const post = async (msgs) => {
      const body = { model: cfg.model || DEFAULT_MODEL, max_tokens: maxTokens || 2000, system, messages: msgs, room: cfg.room };
      if (useSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }];
      const res = await net(serverUrl(cfg), { method: 'POST', headers: serverHeaders(cfg), body: JSON.stringify(body) });
      let data = null;
      try {
        data = await res.json();
      } catch (e) {}
      return { res, data };
    };
    let msgs = messages;
    const texts = [];
    const sources = [];
    for (let turn = 0; turn < 4; turn++) {
      let { res, data } = await post(msgs);
      if (!res.ok && useSearch && res.status === 400) {
        useSearch = false;
        ({ res, data } = await post(msgs));
      }
      if (!res.ok) {
        const detail = data && data.error && data.error.message ? data.error.message : '';
        throw new Error(`AIサーバー エラー (${res.status}) ${detail}`);
      }
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
  }

  // ---------- 接続の診断 ----------
  async function diagnose() {
    const cfg = loadConfig();
    const steps = [];
    const step = async (label, fn, hint) => {
      const t = Date.now();
      try {
        const r = (await fn()) || {};
        steps.push({ label, ok: r.ok !== false, skip: !!r.skip, detail: r.detail || '', hint: r.ok === false ? r.hint || hint || '' : '', ms: Date.now() - t });
        return r.ok !== false;
      } catch (e) {
        steps.push({ label, ok: false, detail: String((e && e.message) || e), hint: hint || '', ms: Date.now() - t });
        return false;
      }
    };
    const shared = !!(cfg.room && cfg.supabaseUrl && cfg.supabaseKey);
    await step('ネットワーク', async () => (navigator.onLine === false ? { ok: false, detail: 'オフラインです', hint: 'Wi-Fiやモバイル通信を確かめてください。' } : { detail: 'ブラウザはオンラインです' }));
    if (!shared) {
      steps.push({ label: '共有データベース', ok: true, skip: true, detail: 'この会議は「このブラウザだけ」なので、使いません', hint: '', ms: 0 });
    } else {
      const dbHint = 'ネットワーク（Wi-Fi・プロキシ）を確かめてください。別のネットワーク（スマホのテザリングなど）で通るなら、会場のネットワークが原因です。';
      const readOk = await step('共有データベースを読む', async () => ({ detail: `${(await limit(storeAll(), 12000)).length}件のデータを読めました` }), dbHint);
      if (readOk) {
        await step('共有データベースに書く', async () => {
          const id = 'diag-' + (cfg.memberId || 'x');
          await limit(storePut('ping', id, { at: Date.now() }), 12000);
          await limit(storeDel('ping', id), 12000);
          return { detail: '書き込みと取り消しができました' };
        }, '読めるのに書けないときは、データベースの設定（supabase_setup.sql）が古い可能性があります。');
      }
      await step('AIのサーバー', async () => {
        const res = await limit(net(serverUrl(cfg), { method: 'POST', headers: serverHeaders(cfg), body: JSON.stringify({ ping: true }) }), 12000);
        if (res.status === 404) return { ok: false, detail: 'この会議のサーバーには、AIの中継（関数 claude）がありません', hint: '代表者に、Supabase に関数「claude」を公開してもらってください。' };
        const data = res.ok ? await res.json() : null;
        if (!data || !data.ok) return { ok: false, detail: `応答がおかしいです（${res.status}）`, hint: dbHint };
        if (!data.ready) return { ok: false, detail: 'サーバーにClaudeのAPIキーが登録されていません', hint: 'Supabase の Edge Functions → Secrets に ANTHROPIC_API_KEY を登録してください。' };
        return { detail: 'つながりました（APIキーも登録済み）' };
      }, dbHint);
    }
    if (cfg.demo) {
      steps.push({ label: 'AIの応答', ok: true, skip: true, detail: '見本モードなので、本物のAIは呼びません', hint: '', ms: 0 });
    } else {
      await step('AIの応答', async () => {
        const out = await limit(callClaude({ system: '指示された一言だけを返す。', messages: [{ role: 'user', content: '「OK」とだけ返してください。' }], maxTokens: 20 }), 40000);
        return { detail: `応答がありました（サーバー経由）：「${String(out).split('§SRC§')[0].trim().slice(0, 20)}」` };
      }, '「上限に達しました」と出るときは、今日の利用回数を使い切っています。それ以外は、少し待ってもう一度試してください。');
    }
    return { steps, ok: steps.every((x) => x.ok), at: Date.now() };
  }

  // このブラウザに保存した内容（名前、参加している会議の一覧、代理人との会話）を消して、最初の状態で開き直す
  function wipeLocal() {
    for (const k of Object.keys(localStorage)) {
      if (k === K('config') || k.startsWith(K('private:'))) localStorage.removeItem(k);
    }
    if (!window.__noReload) location.reload();
    return true;
  }

  const withProbe = async () => {
    const cfg = loadConfig();
    await Promise.all([probeServer(cfg), probeMeeting(cfg)]);
    return publicConfig(cfg);
  };
  window.WEB = true;
  window.api = {
    getConfig: () => withProbe(),
    saveConfig: async (patch) => {
      saveConfigRaw(patch || {});
      return withProbe();
    },
    getPrivate: async (room) => readJson(K('private:' + safeName(room)), {}),
    savePrivate: async (room, data) => {
      writeJson(K('private:' + safeName(room)), data || {});
      return true;
    },
    llm: (req) => callClaude(req || {}),
    kickMeeting: () => kickMeeting(),
    diagnose: () => diagnose(),
    wipeLocal: async () => wipeLocal(),
    testDb: (url, key) => testDb(url, key),
    peekRoom: async (room) => {
      const conn = loadConfig().rooms.find((r) => r.room === room) || null;
      return conn ? storeAll(conn) : [];
    },
    store: { all: () => storeAll(), put: (kind, id, data) => storePut(kind, id, data), del: (kind, id) => storeDel(kind, id) },
  };
})();
