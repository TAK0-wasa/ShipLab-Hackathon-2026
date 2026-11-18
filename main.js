// MeetForMe — Electron メインプロセス
// 役割: ウィンドウ表示 / 設定と個室データのローカル保存 / Claude API と共有ストア(Supabase)への通信
const { app, BrowserWindow, ipcMain, net, safeStorage, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const sampleAi = require('./sample-ai.js');

// --profile=b のように起動すると、別人として動かせる（1台で複数人分を試す用）
const profArg = process.argv.find((a) => a.startsWith('--profile='));
const profile = profArg ? profArg.split('=')[1].replace(/[^\w-]/g, '') : '';
if (profile) {
  app.setPath('userData', path.join(app.getPath('appData'), 'ai-dairinin-kaigi-' + profile));
}

// アプリ名を変えても、これまでの設定（名前・会議の一覧・APIキー）を引き継げるように、保存先は以前の名前のままにする
// （インストールしたアプリでも開発中でも、同じ場所を使うように、ここで決め打ちする）
if (!profile) {
  app.setPath('userData', path.join(app.getPath('appData'), 'AI代理人会議'));
}
const userFile = (name) => path.join(app.getPath('userData'), name);
const safeName = (s) => String(s || 'default').replace(/[^\w-]/g, '_').slice(0, 60);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---------- 設定 ----------
// rooms: 参加している会議の一覧（Slackのチャンネルのように複数持てる）。room: いま開いている会議
function loadConfig() {
  const raw = readJson(userFile('config.json'), {});
  const cfg = { model: DEFAULT_MODEL, ...raw };
  if (raw.apiKeyEnc) {
    try {
      cfg.apiKey = safeStorage.decryptString(Buffer.from(raw.apiKeyEnc, 'base64'));
    } catch {
      cfg.apiKey = '';
    }
  }
  delete cfg.apiKeyEnc;
  // 見本モードは、ふだんは切っておく。以前の版で入れたままになっているPCも、この版で1回だけ切る
  if (!cfg.demoOffV27) {
    cfg.demo = false;
    cfg.demoOffV27 = true;
  }
  cfg.rooms = Array.isArray(raw.rooms) ? raw.rooms.filter((r) => r && r.room) : [];
  // 以前の版（会議は1つだけ）の設定を引き継ぐ
  if (cfg.room && !cfg.rooms.some((r) => r.room === cfg.room)) {
    cfg.rooms.push({ room: cfg.room, supabaseUrl: cfg.supabaseUrl || '', supabaseKey: cfg.supabaseKey || '', title: '', joinedAt: Date.now() });
  }
  return cfg;
}
function saveConfig(patch) {
  const cur = loadConfig();
  const { removeRoom, roomTitle, ...rest } = patch || {};
  const next = { ...cur, ...rest };
  if (rest.clearApiKey) next.apiKey = ''; // 保存してあるキーを消す
  else if (!rest.apiKey) next.apiKey = cur.apiKey || ''; // 空欄なら今のキーを保持
  delete next.clearApiKey;
  if (!next.memberId) next.memberId = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  let rooms = cur.rooms.slice();
  if (removeRoom) {
    rooms = rooms.filter((r) => r.room !== removeRoom);
    if (next.room === removeRoom) next.room = rest.room && rest.room !== removeRoom ? rest.room : rooms.length ? rooms[0].room : '';
  }
  if (next.room) {
    const hit = rooms.find((r) => r.room === next.room);
    if (hit && rest.supabaseUrl === undefined) {
      // 一覧にある会議へ切り替え: その会議の接続先を使う
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
  const out = { ...next };
  if (out.apiKey && safeStorage.isEncryptionAvailable()) {
    out.apiKeyEnc = safeStorage.encryptString(out.apiKey).toString('base64');
    delete out.apiKey;
  }
  writeJson(userFile('config.json'), out);
  return publicConfig(loadConfig());
}
// 幹事用: このフォルダに shared-db.local.json（{"url":"…","key":"…"}）があれば、
// 「会議を作る」の共有データベース欄にあらかじめ入れておく（メンバーは招待コードで受け取るので不要）
// 探す場所: 設定の保存先フォルダ → （インストールしたアプリなら）アプリの .exe と同じフォルダ → 開発用のこのフォルダ
function localFile(name) {
  const dirs = [app.getPath('userData'), app.isPackaged ? path.dirname(process.execPath) : __dirname];
  for (const d of dirs) {
    const f = path.join(d, name);
    if (fs.existsSync(f)) return f;
  }
  return path.join(dirs[dirs.length - 1], name);
}
// 何も置いていなければ、アプリに入っている接続先（BUILTIN_DB）を使う。これがあるので、招待コードは会議の番号（8文字）だけで済む。
// ここに入れているのは公開してよい種類のキー（publishable）。会議の中身は、会議の番号を知っている人しか読み書きできない（supabase_setup.sql）
const BUILTIN_DB = { url: 'https://slezcxntyiyajxxxmwoe.supabase.co', key: 'sb_publishable_jqAZ8vb35FO5shCLOy-lWg_l83h9eLZ' };
function dbDefault() {
  const d = readJson(localFile('shared-db.local.json'), null);
  if (d && d.url && d.key) return { url: String(d.url), key: String(d.key) };
  const env = process.env.KAWARINI_DB; // テスト用: "none" で接続先なし、"URL|キー" で差し替え
  if (env === 'none') return null;
  if (env && env.includes('|')) return { url: env.split('|')[0], key: env.split('|')[1] };
  return BUILTIN_DB;
}

// ---------- AIサーバー（Supabase の Edge Function「claude」）----------
// 会議の共有データベースと同じ Supabase に関数があれば、APIキーを持たないPCでも、サーバー経由でAIを使える。
// Claude のAPIキーはサーバーだけが持ち、アプリやフォルダには入らない
const srvCache = {}; // 関数のURL → { ok, at }
function serverUrl(cfg) {
  return cfg.supabaseUrl && cfg.supabaseKey ? String(cfg.supabaseUrl).replace(/\/+$/, '') + '/functions/v1/claude' : '';
}
const serverHeaders = (cfg) => ({ 'content-type': 'application/json', apikey: cfg.supabaseKey, authorization: 'Bearer ' + cfg.supabaseKey });
const serverKnown = (cfg) => {
  const u = serverUrl(cfg);
  return !!(u && srvCache[u] && srvCache[u].ok);
};
async function probeServer(cfg) {
  const u = serverUrl(cfg);
  if (!u) return false;
  const hit = srvCache[u];
  if (hit && Date.now() - hit.at < (hit.ok ? 300000 : 30000)) return hit.ok;
  let ok = false;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const res = await net.fetch(u, { method: 'POST', headers: serverHeaders(cfg), body: JSON.stringify({ ping: true }), signal: ctl.signal });
    clearTimeout(timer);
    const data = res.ok ? await res.json() : null;
    ok = !!(data && data.ok && data.ready);
  } catch {}
  srvCache[u] = { ok, at: Date.now() };
  return ok;
}

// 画面側にはAPIキーそのものを渡さない。ほかの会議の接続先も渡さない（名前だけ）
function publicConfig(cfg) {
  const { apiKey, rooms, ...rest } = cfg;
  return {
    ...rest,
    rooms: (rooms || []).map((r) => ({ room: r.room, title: r.title || '' })),
    hasApiKey: !!apiKey,
    serverAi: serverKnown(cfg),
    dbDefault: dbDefault(),
    demo: !!cfg.demo,
    profile,
    appVersion: app.getVersion(),
    platform: `${process.platform} ${require('os').release()}`,
    repoUrl: REPO_URL,
    sharedMode: cfg.supabaseUrl && cfg.supabaseKey ? 'supabase' : 'local',
  };
}

// ---------- 共有ストア（Supabase または 同じPC内のお試し用ファイル） ----------
function supa(cfg) {
  const base = cfg.supabaseUrl.replace(/\/+$/, '') + '/rest/v1/docs';
  const headers = {
    apikey: cfg.supabaseKey,
    Authorization: 'Bearer ' + cfg.supabaseKey,
    'content-type': 'application/json',
    // 会議の番号。データベース側は、この番号の会議の行だけを読み書きさせる
    'x-room': String(cfg.room || ''),
  };
  return { base, headers };
}
async function supaCheck(res) {
  if (res.ok) return;
  let msg = '';
  try {
    msg = (await res.json()).message || '';
  } catch {}
  throw new Error(`共有データベースのエラー (${res.status}) ${msg}`);
}
const localSharedFile = (room) => path.join(app.getPath('appData'), 'ai-dairinin-kaigi-shared', safeName(room) + '.json');

const currentConn = () => {
  const cfg = loadConfig();
  return { room: cfg.room, supabaseUrl: cfg.supabaseUrl, supabaseKey: cfg.supabaseKey };
};
const connOf = (room) => loadConfig().rooms.find((r) => r.room === room) || null;

async function storeAll(conn) {
  const cfg = conn || currentConn();
  if (!cfg.room) return [];
  if (cfg.supabaseUrl && cfg.supabaseKey) {
    const { base, headers } = supa(cfg);
    const res = await net.fetch(`${base}?room=eq.${encodeURIComponent(cfg.room)}&select=kind,id,data`, { headers });
    await supaCheck(res);
    return res.json();
  }
  const all = readJson(localSharedFile(cfg.room), {});
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
    const res = await net.fetch(`${base}?on_conflict=room,kind,id`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ room: cfg.room, kind, id, data, updated_at: new Date().toISOString() }]),
    });
    await supaCheck(res);
    return true;
  }
  const file = localSharedFile(cfg.room);
  const all = readJson(file, {});
  all[`${kind}/${id}`] = data;
  writeJson(file, all);
  return true;
}
async function storeDel(kind, id) {
  const cfg = currentConn();
  if (!cfg.room) return true;
  if (cfg.supabaseUrl && cfg.supabaseKey) {
    const { base, headers } = supa(cfg);
    const q = `room=eq.${encodeURIComponent(cfg.room)}&kind=eq.${encodeURIComponent(kind)}&id=eq.${encodeURIComponent(id)}`;
    const res = await net.fetch(`${base}?${q}`, { method: 'DELETE', headers });
    await supaCheck(res);
    return true;
  }
  const file = localSharedFile(cfg.room);
  const all = readJson(file, {});
  delete all[`${kind}/${id}`];
  writeJson(file, all);
  return true;
}

// 会議を作る前に、共有データベースに読み書きできるかを確かめる（原因が分かる言葉で返す）
async function testDb(url, key) {
  if (!/^https?:\/\//.test(url || '')) return { ok: false, msg: 'Project URL は https:// で始まるURLを入れてください。' };
  if (!key) return { ok: false, msg: 'APIキー（publishable または anon）を入れてください。' };
  const explain = async (res, doing) => {
    let body = {};
    try {
      body = await res.json();
    } catch {}
    const m = `${body.message || ''} ${body.code || ''} ${body.hint || ''}`;
    if (res.status === 404 || /PGRST205|does not exist|Could not find the table/i.test(m)) return '接続はできましたが、保存用の表（docs）がまだありません。Supabase の SQL Editor で supabase_setup.sql の中身を実行してください。';
    if (res.status === 401 || res.status === 403 || /42501|row-level security|permission denied/i.test(m)) {
      return doing === 'read' ? 'APIキーが違うか、読む権限がありません。Supabase の publishable（または anon）キーを貼り付けてください。' : '読むことはできますが、書き込みが許可されていません。supabase_setup.sql を最後の行まで実行してください。';
    }
    return `共有データベースのエラー (${res.status}) ${body.message || ''}`;
  };
  try {
    const { base, headers } = supa({ supabaseUrl: url, supabaseKey: key, room: '__check__' });
    let res = await net.fetch(`${base}?select=room&limit=1`, { headers });
    if (!res.ok) return { ok: false, msg: await explain(res, 'read') };
    const id = 'ping-' + Date.now().toString(36);
    res = await net.fetch(`${base}?on_conflict=room,kind,id`, { method: 'POST', headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ room: '__check__', kind: 'ping', id, data: { at: Date.now() }, updated_at: new Date().toISOString() }]) });
    if (!res.ok) return { ok: false, msg: await explain(res, 'write') };
    res = await net.fetch(`${base}?room=eq.__check__&kind=eq.ping&id=eq.${id}`, { method: 'DELETE', headers });
    if (!res.ok) return { ok: false, msg: await explain(res, 'write') };
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: `共有データベースに届きませんでした。URLとネットワークを確かめてください。（${e.message}）` };
  }
}

// ---------- Claude API ----------
async function callClaude({ system, messages, maxTokens, search }) {
  if (global.__mockLlm) return global.__mockLlm({ system, messages, maxTokens, search }); // テスト専用（test/smoke-main.js）
  const cfg = loadConfig();
  if (!cfg.apiKey && cfg.demo) return sampleAi({ system, messages }); // 見本モード: APIを呼ばない
  // このPCにキーが無ければ、会議のサーバー経由で呼ぶ（キーはサーバーだけが持つ）
  const viaServer = !cfg.apiKey && (await probeServer(cfg));
  if (!cfg.apiKey && !viaServer) throw new Error('Claude APIキーが未設定です（「設定」タブで入力してください）');
  // search: true のとき（実現性の検討）は、Web検索を使わせる。設定で切れる。検索は1回ごとに追加の費用がかかる
  let useSearch = !!search && cfg.webSearch !== false;
  const post = async (msgs) => {
    const body = { model: cfg.model || DEFAULT_MODEL, max_tokens: maxTokens || 2000, system, messages: msgs };
    if (useSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }];
    if (viaServer) body.room = cfg.room;
    const res = await net.fetch(viaServer ? serverUrl(cfg) : 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: viaServer ? serverHeaders(cfg) : { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {}
    return { res, data };
  };
  let msgs = messages;
  const texts = [];
  const sources = [];
  for (let turn = 0; turn < 4; turn++) {
    let { res, data } = await post(msgs);
    if (!res.ok && useSearch && res.status === 400) {
      // この環境やモデルで検索が使えないときは、検索なしでやり直す
      useSearch = false;
      ({ res, data } = await post(msgs));
    }
    if (!res.ok) {
      const detail = data && data.error && data.error.message ? data.error.message : '';
      throw new Error(`${viaServer ? 'AIサーバー' : 'Claude API'} エラー (${res.status}) ${detail}`);
    }
    for (const b of data.content || []) {
      if (b.type === 'text') texts.push(b.text);
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        for (const r of b.content) if (r && r.url && !sources.includes(r.url)) sources.push(r.url);
      }
    }
    // 検索の途中でいったん返ってきたら、続きを頼む
    if (data.stop_reason !== 'pause_turn') break;
    msgs = messages.concat([{ role: 'assistant', content: data.content }]);
  }
  return texts.join('') + (sources.length ? '§SRC§' + sources.slice(0, 8).join(' ') : '');
}

// ---------- 接続の診断（設定の「困ったとき・デモ用」から）----------
// ネットワーク → 共有データベース（読む・書く）→ AIのサーバー → AIの応答 の順に試し、どこまで通るかを返す
async function diagnose() {
  const cfg = loadConfig();
  const steps = [];
  const limit = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${ms / 1000}秒待っても応答がありません`)), ms))]);
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
  await step('ネットワーク', async () => {
    let proxy = '';
    try {
      proxy = await session.defaultSession.resolveProxy(shared ? cfg.supabaseUrl : 'https://api.anthropic.com');
    } catch {}
    return { detail: /PROXY|SOCKS|HTTPS/i.test(proxy) ? `プロキシ経由でつなぎます（${proxy}）` : 'プロキシなしで直接つなぎます' };
  });
  if (!shared) {
    steps.push({ label: '共有データベース', ok: true, skip: true, detail: 'この会議は「このPCだけ」なので、使いません', hint: '', ms: 0 });
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
      const res = await limit(net.fetch(serverUrl(cfg), { method: 'POST', headers: serverHeaders(cfg), body: JSON.stringify({ ping: true }) }), 12000);
      if (res.status === 404) return { ok: false, detail: 'この会議のサーバーには、AIの中継（関数 claude）がありません', hint: 'Supabase に関数「claude」を公開するか、「上級者向けの設定」に自分のAPIキーを入れてください。' };
      const data = res.ok ? await res.json() : null;
      if (!data || !data.ok) return { ok: false, detail: `応答がおかしいです（${res.status}）`, hint: dbHint };
      if (!data.ready) return { ok: false, detail: 'サーバーにClaudeのAPIキーが登録されていません', hint: 'Supabase の Edge Functions → Secrets に ANTHROPIC_API_KEY を登録してください。' };
      return { detail: 'つながりました（APIキーも登録済み）' };
    }, dbHint);
  }
  if (!cfg.apiKey && cfg.demo) {
    steps.push({ label: 'AIの応答', ok: true, skip: true, detail: '見本モードなので、本物のAIは呼びません', hint: '', ms: 0 });
  } else {
    await step('AIの応答', async () => {
      const out = await limit(callClaude({ system: '指示された一言だけを返す。', messages: [{ role: 'user', content: '「OK」とだけ返してください。' }], maxTokens: 20 }), 40000);
      return { detail: `応答がありました（${cfg.apiKey ? '自分のAPIキー' : 'サーバー経由'}）：「${String(out).split('§SRC§')[0].trim().slice(0, 20)}」` };
    }, '「上限に達しました」と出るときは、今日の利用回数を使い切っています。それ以外は、少し待ってもう一度試すか、「上級者向けの設定」に自分のAPIキーを入れてください。');
  }
  return { steps, ok: steps.every((x) => x.ok), at: Date.now() };
}

// ---------- 音声入力 ----------
// Windows に入っている音声入力（Windowsキー＋H）を、チャット欄のマイクボタンから起動する。
// アプリ自身は音声を録音も送信もしない。聞き取りは Windows の機能が行い、結果が入力欄に文字として入る
function startDictation(win) {
  if (global.__mockVoice) return Promise.resolve(global.__mockVoice());
  const manual = 'チャット欄をクリックしてから、キーボードの「Windowsキー＋H」を押すと、音声入力を始められます。';
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, msg: 'マイクボタンは、いまのところWindowsだけで使えます。' });
  try {
    if (win && !win.isDestroyed()) {
      win.focus();
      win.webContents.focus();
    }
  } catch {}
  // Windowsキー＋H を押したことにする（user32 の keybd_event）
  const script =
    "$sig='[DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);';" +
    '$k=Add-Type -MemberDefinition $sig -Name KbdEvt -Namespace KawariniKaigi -PassThru;' +
    '$z=[System.UIntPtr]::Zero;' +
    '$k::keybd_event(0x5B,0,0,$z);$k::keybd_event(0x48,0,0,$z);Start-Sleep -Milliseconds 60;$k::keybd_event(0x48,0,2,$z);$k::keybd_event(0x5B,0,2,$z)';
  return new Promise((resolve) => {
    try {
      // 引用符の受け渡しで崩れないように、命令は符号化して渡す
      require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000 }, (err) => {
        resolve(err ? { ok: false, msg: '音声入力を自動で起動できませんでした。' + manual } : { ok: true });
      });
    } catch (e) {
      resolve({ ok: false, msg: '音声入力を自動で起動できませんでした。' + manual });
    }
  });
}

// ---------- 更新の確認 ----------
// GitHub の Releases にある最新版の番号（タグ v1.2.3）と、このアプリの番号を比べる。開く先は、決め打ちの Releases のページだけ
const REPO = 'TAK0-wasa/ShipLab-Hackathon-2026';
const REPO_URL = 'https://github.com/' + REPO;
const verNum = (v) => String(v || '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
const newerThan = (a, b) => {
  const x = verNum(a);
  const y = verNum(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
async function checkUpdate() {
  const current = app.getVersion();
  try {
    if (global.__mockUpdate) return global.__mockUpdate(current, newerThan);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' }, signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, current, msg: res.status === 404 ? '公開されている版がまだありません。' : `確認できませんでした（${res.status}）` };
    const latest = String((await res.json()).tag_name || '').replace(/^v/i, '');
    if (!/^\d+\.\d+\.\d+$/.test(latest)) return { ok: false, current, msg: '最新版の番号を読み取れませんでした。' };
    return { ok: true, current, latest, newer: newerThan(latest, current), url: REPO_URL + '/releases/latest' };
  } catch (e) {
    return { ok: false, current, msg: '確認できませんでした（ネットワークを確かめてください）。' };
  }
}

// このPCに保存した内容（名前、参加している会議の一覧、代理人との会話、自分のAPIキー）をすべて消して、最初の状態で起動し直す
function wipeLocal() {
  const dir = app.getPath('userData');
  for (const f of fs.readdirSync(dir)) {
    if (f === 'config.json' || /^private-.*\.json$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  }
  if (!global.__noRelaunch) {
    app.relaunch();
    app.exit(0);
  }
  return true;
}

// ---------- IPC ----------
// 設定を返す前に、会議のサーバーでAIが使えるかを確かめておく（結果は数分おぼえる）
ipcMain.handle('config:get', async () => {
  const cfg = loadConfig();
  if (!cfg.apiKey) await probeServer(cfg);
  return publicConfig(cfg);
});
ipcMain.handle('config:save', async (_e, patch) => {
  saveConfig(patch || {});
  const cfg = loadConfig();
  if (!cfg.apiKey) await probeServer(cfg);
  return publicConfig(cfg);
});
ipcMain.handle('private:get', (_e, room) => readJson(userFile(`private-${safeName(room)}.json`), {}));
ipcMain.handle('private:save', (_e, room, data) => {
  writeJson(userFile(`private-${safeName(room)}.json`), data || {});
  return true;
});
ipcMain.handle('llm', (_e, req) => callClaude(req || {}));
ipcMain.handle('voice:start', (e) => startDictation(BrowserWindow.fromWebContents(e.sender)));
ipcMain.handle('update:check', () => checkUpdate());
ipcMain.handle('app:wipe', () => wipeLocal());
ipcMain.handle('diag:run', () => (global.__mockDiag ? global.__mockDiag() : diagnose()));
ipcMain.handle('store:test', (_e, url, key) => testDb(url, key));
ipcMain.handle('store:all', () => storeAll());
// 一覧にある別の会議の状況を読む（「あなたの番」の印を付けるため。書き込みはしない）
ipcMain.handle('store:peek', async (_e, room) => {
  const conn = connOf(room);
  return conn ? storeAll(conn) : [];
});
ipcMain.handle('store:put', (_e, kind, id, data) => storePut(kind, id, data));
ipcMain.handle('store:del', (_e, kind, id) => storeDel(kind, id));

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'MeetForMe' + (profile ? `（${profile}）` : ''),
    backgroundColor: '#f6f8f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.setAppUserModelId('jp.developershub.ai-dairinin-kaigi'); // Windowsで通知を出すために必要
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
