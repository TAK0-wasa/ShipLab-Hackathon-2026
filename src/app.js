// MeetForMe — 画面
/* global Engine, api */
(function () {
  const S = { cfg: {}, priv: {}, snap: null, tab: 'room', busy: '', progress: '', error: '', notice: '', drafts: {}, dirty: false, teamSize: 3 };
  const $ = (id) => document.getElementById(id);
  const GREETING = (name) =>
    `こんにちは、${name}さんの代理人です。ここで話したことは、${name}さんと代理人だけのものです。\nまず、考えている案を教えてください。一言ずつでも、まだ固まっていない「こんな感じのやつ」でも大丈夫です。`;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === false || kid == null) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  // 通知を出す。スマホのブラウザには new Notification が使えないものがあるので、失敗しても何も起こさない
  const canNotify = () => !!window.Notification && Notification.permission === 'granted';
  const notifyUser = (title, body) => {
    try {
      new Notification(title, { body });
    } catch (e) {}
  };
  const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const me = () => ({ id: S.cfg.memberId, name: S.cfg.name });
  const ctx = () => ({
    store: api.store,
    llm: api.llm,
    me: me(),
    onProgress: (t) => {
      S.progress = t;
      renderStatus();
    },
    onLive: (l) => {
      S.live = l;
      updateLive();
    },
  });
  const ready = () => !!(S.cfg.name && S.cfg.room && S.cfg.memberId);
  // AIを呼べるか（APIキーがある、または見本モード）。呼べない人はフォームで預け、会議は代表者のアプリが進める
  const canAI = () => !!(S.cfg.hasApiKey || S.cfg.demo || S.cfg.serverAi);
  const roomInfo = () => (S.snap && S.snap.room && S.snap.room.main) || {};
  const isLeader = () => !roomInfo().leaderId || roomInfo().leaderId === S.cfg.memberId;
  const state = () => (S.snap && S.snap.state.main) || { phase: 'collecting', round: 0 };
  const myOpenQuestions = () =>
    S.snap
      ? Object.entries(S.snap.question)
          .filter(([, q]) => q.memberId === S.cfg.memberId && q.status === 'open')
          .map(([id, q]) => ({ id, ...q }))
          .sort((a, b) => a.at - b.at)
      : [];

  const isRunning = () => {
    const st = state();
    return !!(st.runner && Date.now() - (st.runnerAt || 0) < Engine.LOCK_MS);
  };
  // 自分がいまやること（あなたの番）
  function todosOf(snap, meId) {
    const out = [];
    if (!snap) return out;
    const st = snap.state.main || { phase: 'collecting', round: 0 };
    const running = !!(st.runner && Date.now() - (st.runnerAt || 0) < Engine.LOCK_MS);
    const me = meId || S.cfg.memberId;
    const others = Object.keys(snap.brief).filter((id) => id !== me && snap.member[id]).length;
    if (!snap.brief[me] && st.phase !== 'decided') {
      out.push({ key: 'deposit', urgent: others > 0, tab: 'room', target: '', text: others ? `ほかの${others}人は預け済みです。「① 考えを預ける」であなたの考えを預けてください。` : '「① 考えを預ける」で代理人に考えを預けてください。' });
    }
    const qs = Object.entries(snap.question).filter(([, q]) => q.memberId === me && q.status === 'open').map(([id]) => id).sort();
    if (qs.length) out.push({ key: 'q:' + qs.join(','), urgent: true, tab: 'meeting', target: 'sec-q', text: `代理人からの確認質問が${qs.length}件あります。` });
    const rec = st.recommendation;
    const a = snap.approval[me];
    if (st.phase === 'review' && !running && rec && snap.cand[rec.topId] && (st.participants || []).includes(me) && !(a && a.ok && a.round === st.round)) {
      out.push({ key: 'approve:' + st.round, urgent: true, tab: 'meeting', target: 'sec-rec', text: `推薦案「${snap.cand[rec.topId].title}」が出ました。承認するか、一言返してください。` });
    }
    return out;
  }
  const myTodos = () => (S.snap && ready() ? todosOf(S.snap) : []);
  // 自分の番でないとき、誰を待っているか
  function waitingText() {
    if (!S.snap || !ready()) return '';
    const snap = S.snap;
    const st = state();
    const name = (id) => (snap.member[id] || {}).name || '?';
    if (isRunning()) return '代理人どうしが会議中です。';
    if (st.phase === 'decided') return snap.cand[st.decidedCandId] ? `「${snap.cand[st.decidedCandId].title}」に決まりました。` : '';
    if (st.error) return canAI() ? '会議が途中で止まっています。「② 会議と結果」の「続きから再開する」で進められます。' : '会議が途中で止まっています。代表者が再開するのを待っています。';
    if (st.phase === 'review') {
      const parts = st.participants || [];
      const wait = parts.filter((id) => !(snap.approval[id] && snap.approval[id].ok && snap.approval[id].round === st.round));
      return wait.length ? `${wait.map(name).join('さん・')}さんの承認を待っています。` + (window.PROTO ? '（この試作では、承認の欄のボタンから人を切り替えて承認します）' : '') : '';
    }
    const wait = Object.keys(snap.member).filter((id) => !snap.brief[id]);
    const notJoined = Math.max(0, S.teamSize - Object.keys(snap.member).length);
    if (wait.length) return `${wait.map(name).join('さん・')}さんが預けるのを待っています。` + (window.PROTO ? '（この試作では、下のボタンから人を切り替えて入力します）' : '') + (notJoined ? `（ほかに、まだ参加していない人が${notJoined}人います）` : '');
    if (notJoined) return `まだ参加していない人が${notJoined}人います。全員が預けると、会議が自動で始まります。`;
    return '全員が預けました。まもなく会議が始まります。';
  }
  // 新しく自分の番になったら、OSの通知を出す（デスクトップ版。アプリを最小化していても届く）
  function checkTurn() {
    const urgent = myTodos().filter((t) => t.urgent);
    const seen = S.seenTodo || new Set();
    const fresh = urgent.filter((t) => !seen.has(t.key));
    if (S.todoInit && fresh.length) {
      try {
        if (canNotify() && (document.hidden || !document.hasFocus())) {
          notifyUser('MeetForMe：あなたの番です', fresh[0].text);
        }
      } catch (e) {}
    }
    if (S.todoInit) fresh.forEach((t) => addAlert(t.text));
    S.seenTodo = new Set(urgent.map((t) => t.key));
    S.todoInit = true;
  }
  function goTo(tab, target) {
    S.tab = tab;
    render();
    const el = target && document.getElementById(target);
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    else $('view').scrollTop = 0;
  }
  function renderTurn() {
    const el = $('turn');
    el.className = '';
    el.replaceChildren();
    if (!ready() || S.tab === 'settings' || S.startMode) return;
    const todos = myTodos();
    if (todos.length) {
      const t = todos.find((x) => x.urgent) || todos[0];
      el.className = 'show' + (t.urgent ? ' urgent' : '');
      el.append(h('b', {}, 'あなたの番'), h('span', {}, t.text + (todos.length > 1 ? `（ほか${todos.length - 1}件）` : '')), h('button', { class: 'btn small', onclick: () => goTo(t.tab, t.target) }, '開く'));
    } else {
      const w = waitingText();
      const decided = state().phase === 'decided';
      if (w) {
        el.className = 'show ' + (decided ? 'done' : 'wait');
        el.append(...[h('b', {}, decided ? '決定' : 'いまは待ち'), h('span', {}, w), decided ? h('button', { class: 'btn small ghost', onclick: () => goTo('meeting', 'sec-rec') }, '見る') : null].filter(Boolean));
      }
    }
  }
  // ---------- 参加している会議の一覧（Slackのチャンネルのように切り替える） ----------
  const roomList = () => S.cfg.rooms || [];
  const roomTitle = (r) => r.title || '（名前のない会議）';
  function resetView() {
    S.drafts = {};
    S.open = {};
    S.editTopic = false;
    S.takeLink = '';
    S.edit = null;
    S.formIdeas = 1;
    S.autoSig = '';
    S.todoInit = false;
    S.seenTodo = null;
    S.live = null;
    S.error = '';
    S.notice = '';
    S.phaseSeen = undefined;
  }
  async function switchRoom(room) {
    if (S.busy) {
      S.notice = '会議を進めている途中です。終わってから切り替えてください。';
      return renderStatus();
    }
    S.startMode = '';
    if (room !== S.cfg.room) {
      S.cfg = await api.saveConfig({ room });
      resetView();
      await enterRoom();
      S.tab = S.snap && S.snap.brief[S.cfg.memberId] ? 'meeting' : 'room';
    }
    render();
    pollOthers();
  }
  // ほかの会議で自分の番が来ていないかを見る（印を付ける。新しく番が来たら通知する）
  async function pollOthers() {
    if (!api.peekRoom || !roomList().length) return;
    S.peek = S.peek || {};
    for (const r of roomList()) {
      if (r.room === S.cfg.room) continue;
      try {
        const docs = await api.peekRoom(r.room);
        const snap = await Engine.snapshot({ all: async () => docs });
        const urgent = todosOf(snap, r.memberId).filter((t) => t.urgent);
        const prev = S.peek[r.room];
        const keys = urgent.map((t) => t.key).join('|');
        if (prev && keys && keys !== prev.keys) {
          try {
            if (canNotify()) notifyUser('MeetForMe：あなたの番です', `「${roomTitle(r)}」${urgent[0].text}`);
          } catch (e) {}
        }
        S.peek[r.room] = { n: urgent.length, keys, decided: (snap.state.main || {}).phase === 'decided' };
      } catch (e) {
        S.peek[r.room] = S.peek[r.room] || { n: 0, keys: '' };
      }
    }
    renderSide();
  }
  // 会議の切り替えは、ヘッダーの「会議：◯◯」から開くメニューで行う
  function renderSide() {
    const el = $('switch');
    if (!el) return;
    el.replaceChildren();
    if (!S.cfg.rooms || !roomList().length) return; // Web版や、まだ会議が無いときは出さない
    const curEntry = roomList().find((r) => r.room === S.cfg.room);
    const peekOf = (r) => (S.peek && S.peek[r.room]) || { n: 0, decided: false };
    const otherTurns = roomList().filter((r) => r.room !== S.cfg.room).reduce((t, r) => t + peekOf(r).n, 0);
    const open = (mode) => {
      S.menuOpen = false;
      S.startMode = mode;
      S.error = '';
      render();
    };
    el.append(
      h(
        'button',
        { class: 'swbtn', title: '会議を切り替える', onclick: (e) => { e.stopPropagation(); S.menuOpen = !S.menuOpen; renderSide(); } },
        h('span', { class: 'swlabel' }, '会議：'),
        h('span', { class: 'swname' }, curEntry ? roomTitle(curEntry) : '（選んでいません）'),
        otherTurns ? h('span', { class: 'dot', title: 'ほかの会議であなたの番です' }, otherTurns) : null,
        h('span', { class: 'caret' }, S.menuOpen ? '▴' : '▾')
      )
    );
    if (!S.menuOpen) return;
    const mineNow = myTodos().filter((t) => t.urgent).length;
    el.append(
      h(
        'div',
        { class: 'swmenu', onclick: (e) => e.stopPropagation() },
        h('div', { class: 'swhead' }, '参加している会議'),
        roomList().map((r) => {
          const cur = r.room === S.cfg.room;
          const n = cur ? mineNow : peekOf(r).n;
          const decided = cur ? state().phase === 'decided' : peekOf(r).decided;
          return h(
            'button',
            { class: 'mitem' + (cur ? ' on' : ''), onclick: () => { S.menuOpen = false; switchRoom(r.room); } },
            h('span', { class: 'nm' }, roomTitle(r)),
            decided ? h('span', { class: 'tag push' }, '決定') : null,
            n ? h('span', { class: 'dot', title: 'あなたの番です' }, n) : null,
            cur ? h('span', { class: 'hint' }, '表示中') : null
          );
        }),
        h('div', { class: 'swfoot' }, h('button', { class: 'btn small', disabled: !!S.busy, onclick: () => open('create') }, '新しい会議を作る'), h('button', { class: 'btn small ghost', disabled: !!S.busy, onclick: () => open('join') }, '招待コードで参加する'), window.WEB ? h('button', { class: 'btn small ghost', disabled: !!S.busy, onclick: () => open('login') }, '別の会議にログイン') : null)
      )
    );
  }
  document.addEventListener('click', () => {
    if (S.menuOpen) {
      S.menuOpen = false;
      renderSide();
    }
  });

  // 折りたたみ（開閉の状態は描き直しをまたいで保つ）
  function fold(key, title, defaultOpen, ...kids) {
    S.open = S.open || {};
    const open = S.open[key] === undefined ? !!defaultOpen : S.open[key];
    const d = h('details', { class: 'card fold', open }, h('summary', {}, title), ...kids);
    d.addEventListener('toggle', () => { S.open[key] = d.open; });
    return d;
  }

  // 入力中の文字を、画面の描き直しをまたいで保持する
  function draftArea(key, attrs) {
    return h('textarea', { ...attrs, value: S.drafts[key] || '', oninput: (e) => (S.drafts[key] = e.target.value) });
  }

  // ---------- 端末の引き継ぎ ----------
  // 代理人との会話と預かりメモは、ふだんはこの端末にだけある。「引き継ぎリンク」を作ると、それを暗号化して共有の保存先に置き、
  // リンクを開いた別の端末で続きができる。鍵はリンクの中にだけあり、保存先には暗号文しか置かない（ほかのメンバーも運営者も読めない）
  const WEB_BASE = 'https://meetforme.vercel.app/';
  const b64enc = (buf) => {
    const u = new Uint8Array(buf);
    let t = '';
    for (let i = 0; i < u.length; i += 8192) t += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
    return btoa(t).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const b64dec = (str) => Uint8Array.from(atob(String(str).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const canSync = () => !!(window.crypto && crypto.subtle);
  const syncCryptoKey = (k) => crypto.subtle.importKey('raw', b64dec(k), 'AES-GCM', false, ['encrypt', 'decrypt']);
  function syncBody() {
    const { syncKey, syncAt, ...rest } = S.priv;
    return { ...rest, chat: (rest.chat || []).slice(-40) };
  }
  let syncTimer = null;
  function queueSync() {
    if (!S.priv || !S.priv.syncKey || !canSync()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => pushSync().catch(() => {}), 800);
  }
  async function pushSync() {
    if (!S.priv || !S.priv.syncKey || !canSync()) return false;
    const room = S.cfg.room;
    const key = await syncCryptoKey(S.priv.syncKey);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const at = Date.now();
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(syncBody())));
    S.priv.syncAt = at;
    await api.savePrivate(room, S.priv);
    await api.store.put('priv', S.cfg.memberId, { v: 1, iv: b64enc(iv), ct: b64enc(ct), at });
    return true;
  }
  // 別の端末で進んだ内容があれば取り込む（新しいほうが勝つ）
  async function pullSync() {
    const d = S.priv && S.priv.syncKey && S.snap && S.snap.priv && S.snap.priv[S.cfg.memberId];
    if (!d || !(d.at > (S.priv.syncAt || 0)) || S.busy || !canSync()) return false;
    try {
      const key = await syncCryptoKey(S.priv.syncKey);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64dec(d.iv) }, key, b64dec(d.ct));
      const body = JSON.parse(new TextDecoder().decode(pt));
      S.priv = { ...body, syncKey: S.priv.syncKey, syncAt: d.at };
      if (!Array.isArray(S.priv.chat) || !S.priv.chat.length) S.priv.chat = [{ role: 'assistant', content: GREETING(S.cfg.name) }];
      await api.savePrivate(S.cfg.room, S.priv);
      return true;
    } catch (e) {
      return false;
    }
  }
  async function makeTakeLink() {
    if (!canSync()) throw new Error('この環境では暗号化が使えないため、引き継ぎリンクを作れません。');
    if (!S.priv.syncKey) S.priv.syncKey = b64enc(crypto.getRandomValues(new Uint8Array(32)));
    await pushSync();
    const o = { r: S.cfg.room, m: S.cfg.memberId, n: S.cfg.name, k: S.priv.syncKey };
    if (!(S.cfg.dbDefault && S.cfg.dbDefault.url === S.cfg.supabaseUrl)) Object.assign(o, { u: S.cfg.supabaseUrl || '', s: S.cfg.supabaseKey || '' });
    const base = window.WEB ? location.origin + location.pathname : WEB_BASE;
    return base + '#take=' + b64enc(new TextEncoder().encode(JSON.stringify(o)));
  }
  // 引き継ぎリンクから開いたとき: 同じ人として会議に入り、暗号化された会話を取り込む
  async function takeOver(code) {
    let o;
    try {
      o = JSON.parse(new TextDecoder().decode(b64dec(code)));
    } catch (e) {
      o = null;
    }
    if (!o || !o.r || !o.m || !o.k) return fail('引き継ぎのリンクを読めませんでした。もう一度、元の端末でリンクを作り直してください。');
    if (!window.WEB) return fail('引き継ぎのリンクは、ブラウザ（Web版）で開いてください。');
    const db = o.u !== undefined ? { url: o.u, key: o.s || '' } : S.cfg.dbDefault || { url: '', key: '' };
    S.cfg = await api.saveConfig({ memberId: o.m, name: o.n || S.cfg.name || '', room: o.r, supabaseUrl: db.url, supabaseKey: db.key });
    const cur = (await api.getPrivate(o.r)) || {};
    await api.savePrivate(o.r, { ...cur, syncKey: o.k, syncAt: cur.syncKey === o.k ? cur.syncAt || 0 : 0 });
    resetView();
    await enterRoom();
    S.startMode = '';
    S.tab = 'room';
    S.notice = S.netError ? '' : 'この端末に引き継ぎました。続きから話せます。どちらの端末で進めても、もう一方に反映されます。';
  }

  async function savePriv() {
    await api.savePrivate(S.cfg.room, S.priv);
    queueSync();
  }

  // 決定のあとは共有の保存先から本音を消している。決定が取り消されたら、この端末に残っている自分の預かりメモを預け直す
  async function restoreBrief() {
    const me = S.cfg && S.cfg.memberId;
    const b = me && S.snap && S.snap.brief[me];
    const st = (S.snap && S.snap.state && S.snap.state.main) || {};
    if (!b || !b.scrubbed || st.phase === 'decided' || !S.priv || !S.priv.brief) return;
    await api.store.put('brief', me, S.priv.brief);
    S.snap.brief[me] = S.priv.brief;
  }
  async function refresh() {
    try {
      S.snap = await Engine.snapshot(api.store);
      const room = S.snap.room && S.snap.room.main;
      if (room && room.teamSize) S.teamSize = room.teamSize;
      const entry = (S.cfg.rooms || []).find((r) => r.room === S.cfg.room);
      if (entry && room && room.theme && entry.title !== room.theme) {
        entry.title = room.theme;
        api.saveConfig({ roomTitle: room.theme }).then((c) => { if (c.room === S.cfg.room) S.cfg = c; renderSide(); });
      }
      S.netError = '';
      await restoreBrief();
      await pullSync();
    } catch (e) {
      S.netError = errText(e);
      if (!S.snap) S.snap = await Engine.snapshot({ all: async () => [] });
    }
  }

  async function enterRoom() {
    S.priv = (await api.getPrivate(S.cfg.room)) || {};
    if (!Array.isArray(S.priv.chat) || !S.priv.chat.length) S.priv.chat = [{ role: 'assistant', content: GREETING(S.cfg.name) }];
    await refresh();
    if (S.netError) return;
    // 代表者に外された人は、メンバーの一覧に自分を入れ直さない（入り直すときは、招待コードで参加する）
    const rm0 = S.snap.room && S.snap.room.main;
    if (rm0 && (rm0.removed || []).includes(S.cfg.memberId)) return;
    const cur = S.snap.member[S.cfg.memberId];
    if (!cur || cur.name !== S.cfg.name) {
      await api.store.put('member', S.cfg.memberId, { joinedAt: Date.now(), ...(cur || {}), name: S.cfg.name });
      await refresh();
    }
  }

  // ---------- 操作 ----------
  async function run(kind, fn) {
    if (S.busy) return;
    S.busy = kind;
    S.error = '';
    S.notice = '';
    render();
    let liveTimer = null;
    if (kind === 'meeting') {
      let last = '';
      liveTimer = setInterval(async () => {
        await refresh();
        const sig = JSON.stringify([S.snap.msg, S.snap.state]);
        if (sig !== last && S.busy === 'meeting' && S.tab === 'meeting') {
          last = sig;
          render();
        }
      }, 1000);
    }
    try {
      await fn();
    } catch (e) {
      S.error = errText(e);
    }
    clearInterval(liveTimer);
    S.live = null;
    S.busy = '';
    S.progress = '';
    await refresh();
    if (kind === 'meeting') checkEvents();
    render();
  }

  function sendChat(picked) {
    const text = (typeof picked === 'string' ? picked : S.drafts.chat || '').trim();
    if (!text || S.busy) return;
    if (typeof picked !== 'string') S.drafts.chat = '';
    S.priv.choices = [];
    S.priv.chat.push({ role: 'user', content: text });
    run('chat', async () => {
      await savePriv();
      const msgs = S.priv.chat.slice(-40);
      while (msgs.length && msgs[0].role !== 'user') msgs.shift();
      const reply = await api.llm({
        system: Engine.interviewSystem(S.cfg.name, Engine.interviewContext(S.snap, S.cfg.memberId)),
        messages: msgs.map((m) => ({ role: m.role, content: m.content })),
        maxTokens: 4000,
      });
      const sp = Engine.splitCovered(reply);
      if (sp.covered) S.priv.covered = [...new Set([...(S.priv.covered || []), ...sp.covered])];
      S.priv.chat.push({ role: 'assistant', content: sp.text || '（応答が空でした）' });
      S.priv.choices = sp.choices || [];
      await savePriv();
    });
  }

  function makeBrief() {
    run('brief', async () => {
      S.progress = '会話から預かりメモを作っています';
      renderStatus();
      S.priv.pendingBrief = await Engine.extractBrief(api.llm, S.cfg.name, S.priv.chat);
      await savePriv();
    });
  }

  // 別の案もこの会議に預ける。いまの案は残したまま、代理人にもう1つの案を話し、あとでまとめて預け直す
  async function addIdea() {
    if (S.busy) return;
    delete S.priv.pendingBrief;
    S.edit = null;
    S.priv.choices = [];
    S.priv.chat.push({ role: 'assistant', content: 'もう1つ、別の案も預けられます。いまの案はそのまま残します。追加したい案を、名前と一言で教えてください。話し終えたら「預ける内容を確認する」で、2つの案をまとめて預けます。' });
    await savePriv();
    S.tab = 'room';
    render();
    setTimeout(() => { const b = $('chatInput'); if (b) b.focus(); }, 50);
  }

  function confirmDeposit() {
    run('meeting', async () => {
      const brief = { ...S.priv.pendingBrief, updates: S.priv.pendingBrief.updates || [] };
      await api.store.put('brief', S.cfg.memberId, brief);
      await api.store.put('member', S.cfg.memberId, { ...(S.snap.member[S.cfg.memberId] || {}), name: S.cfg.name, deposited: true, depositedAt: Date.now() });
      S.priv.brief = brief;
      delete S.priv.pendingBrief;
      await savePriv();
      await refresh();
      const deposited = Object.keys(S.snap.brief).filter((id) => S.snap.member[id]).length;
      const hadMeeting = Object.keys(S.snap.cand).length > 0;
      if (!canAI()) {
        S.tab = 'meeting';
        S.notice = `預けました（いま ${deposited} / ${S.teamSize} 人）。全員が預けると、代表者のアプリが開いているときに会議が進みます。`;
      } else if (deposited >= 2 && (deposited >= S.teamSize || hadMeeting)) {
        S.tab = 'meeting';
        render();
        // サーバーで進められるときは合図だけ送る（この画面を閉じても会議は進む）。だめなら、これまでどおりこの画面で進める
        const kicked = S.cfg.serverMeeting && api.kickMeeting && !window.PROTO ? await api.kickMeeting() : null;
        if (kicked && kicked.ok !== false) {
          S.kickAt = Date.now();
          S.notice = '預けました。会議はサーバーで進みます。この画面を閉じても大丈夫です。';
        } else await Engine.runMeeting(ctx(), { mode: 'full' });
      } else {
        S.tab = 'meeting';
      }
    });
  }

  function startMeeting(mode) {
    S.tab = 'meeting';
    run('meeting', () => Engine.runMeeting(ctx(), { mode }));
  }

  function answer(q) {
    const key = 'q:' + q.id;
    const text = (S.drafts[key] || '').trim();
    if (!text) return;
    // 「答える」ボタンが薄くなるのは、答えを保存しているあいだだけにする（議論のやり直しは、保存が終わってから始める）
    let left = null;
    run('answer', async () => {
      left = await Engine.answerQuestion(ctx(), q.id, text);
      delete S.drafts[key];
      if (left === 0 && !canAI()) S.notice = '答えを代理人に伝えました。代表者のアプリが開いているときに、議論をやり直します。';
    }).then(() => {
      if (left === 0 && canAI()) {
        S.tab = 'meeting';
        startMeeting('rerun');
      }
    });
  }

  // 推薦とは別の案を、この案に選び直す（承認はやり直し）
  function adoptCand(c) {
    S.wantConfirm = '';
    run('meeting', async () => {
      await Engine.adoptOther(ctx(), c.id);
      S.tab = 'meeting';
      S.notice = `「${c.title}」を採用案に選びました。ほかの人の承認を待っています。`;
    });
  }
  // 推薦以外で、選べる案
  function otherPickable() {
    const snap = S.snap;
    const st = state();
    const rec = st.recommendation;
    if (!rec || st.phase !== 'review' || !(st.participants || []).includes(S.cfg.memberId)) return [];
    const table = Object.fromEntries((rec.table || []).map((t) => [t.candId, t]));
    return Object.values(snap.cand).filter((c) => c.id !== rec.topId && !c.dropped && !(table[c.id] && table[c.id].excluded) && table[c.id]);
  }

  // 推薦とは別の案にしたいとき：その案を推すと代理人に伝えて、議論をやり直す
  function wantCand(c) {
    S.wantConfirm = '';
    run('meeting', async () => {
      await Engine.addUpdate(ctx(), `推薦案ではなく、「${c.title}」にしたいです。この案を推します。`);
      if (canAI()) {
        S.tab = 'meeting';
        await Engine.runMeeting(ctx(), { mode: 'rerun' });
      } else {
        S.notice = '「' + c.title + '」にしたいと伝えました。代表者のアプリが開いているときに、議論をやり直します。';
      }
    });
  }

  function tellAgent(key) {
    const text = (S.drafts[key] || '').trim();
    if (!text) return;
    run('meeting', async () => {
      await Engine.addUpdate(ctx(), text);
      delete S.drafts[key];
      if (Object.keys(S.snap.cand).length && canAI()) {
        S.tab = 'meeting';
        await Engine.runMeeting(ctx(), { mode: 'rerun' });
      } else {
        S.notice = Object.keys(S.snap.cand).length ? '代理人に伝えました。代表者のアプリが開いているときに、議論をやり直します。' : '代理人に伝えました。';
      }
    });
  }

  function approve() {
    run('approve', async () => {
      const decided = await Engine.approve(ctx());
      S.notice = decided ? '' : window.PROTO ? '承認しました。下のボタンで、残りの人に切り替えて承認してください。' : '承認しました。ほかのメンバーの承認を待っています。';
    });
  }

  // ---------- 表示部品 ----------
  function byTag(part) {
    if (!part || typeof part !== 'object') return null;
    return part.by === 'me' ? h('span', { class: 'tag me' }, '本人') : h('span', { class: 'tag ai' }, 'AIが補完');
  }
  function partsView(c) {
    const row = (label, p) => [h('dt', {}, label), h('dd', {}, Engine.partText(p) || '—', Engine.partText(p) ? byTag(p) : null)];
    return h('dl', { class: 'parts' }, row('誰向けか', c.target), row('何を解決するか', c.problem), row('目玉機能', c.feature));
  }
  function briefView(b) {
    const kv = (label, v) => h('div', { class: 'kv' }, h('b', {}, label + '： '), v || '（聞けていません）');
    return h(
      'div',
      {},
      h('h3', {}, '会議で公開される内容（案）'),
      b.ideas.map((i) =>
        h(
          'div',
          { class: 'idea' },
          h('div', { class: 'ttl' }, i.title, i.push === 'push' ? h('span', { class: 'tag push' }, '推し') : null, i.push === 'drop' ? h('span', { class: 'tag ai' }, '無しでいい') : null),
          i.summary ? h('div', { class: 'hint' }, i.summary) : null,
          partsView(i)
        )
      ),
      h('h3', {}, 'あなたの代理人だけが持つ内容'),
      h('div', { class: 'hint' }, 'ここは会議ではそのまま出さず、代理人が理由を言い換えて伝えます。ほかのメンバーの画面にも出ません。ただし試作の段階では、会議を進めるために共有の保存先に置かれるので、保存先を直接見られる人には読めます。'),
      kv('好きな点', b.likes),
      kv('不安な点', b.worries),
      kv('外したくない条件（無いと反対）', b.mustHaves && b.mustHaves.length ? b.mustHaves.join(' ／ ') : '（特になし）'),
      kv('実装でできること', b.impl),
      kv('取り入れたい部分', b.wantFromOthers),
      kv('納得の条件（あれば賛成できる）', b.acceptCondition),
      b.updates && b.updates.length ? h('div', { class: 'kv' }, h('b', {}, 'あとから伝えたこと： '), h('ul', { class: 'plain' }, b.updates.map((u) => h('li', {}, u.text)))) : null
    );
  }
  // ---------- 預けた内容の手直し ----------
  const E_KEYS = ['likes', 'worries', 'must', 'impl', 'want', 'accept'];
  function clearEditDrafts() {
    Object.keys(S.drafts).forEach((k) => { if (k.startsWith('e:')) delete S.drafts[k]; });
  }
  function openEdit(src) {
    const b = src === 'pending' ? S.priv.pendingBrief : S.priv.brief;
    if (!b) return;
    clearEditDrafts();
    b.ideas.forEach((i, n) => {
      S.drafts['e:title' + n] = i.title || '';
      S.drafts['e:sum' + n] = i.summary || '';
      S.drafts['e:target' + n] = Engine.partText(i.target) || '';
      S.drafts['e:problem' + n] = Engine.partText(i.problem) || '';
      S.drafts['e:feature' + n] = Engine.partText(i.feature) || '';
    });
    S.drafts['e:likes'] = b.likes || '';
    S.drafts['e:worries'] = b.worries || '';
    S.drafts['e:must'] = (b.mustHaves || []).join('\n');
    S.drafts['e:impl'] = b.impl || '';
    S.drafts['e:want'] = b.wantFromOthers || '';
    S.drafts['e:accept'] = b.acceptCondition || '';
    S.edit = { src, n: Math.max(1, b.ideas.length), push: b.ideas.map((i) => i.push || 'normal'), removed: [] };
    S.error = '';
    render();
  }
  function closeEdit() {
    S.edit = null;
    clearEditDrafts();
    S.error = '';
    render();
  }
  function saveEdit() {
    const ed = S.edit;
    const base = ed.src === 'pending' ? S.priv.pendingBrief : S.priv.brief;
    const v = (k) => (S.drafts['e:' + k] || '').trim();
    const ideas = [];
    for (let i = 0; i < ed.n; i++) {
      if (ed.removed.includes(i)) continue;
      const title = v('title' + i);
      const summary = v('sum' + i);
      if (!title && !summary) continue;
      const orig = base.ideas[i] || {};
      // 書き換えたところは「本人」になる。触っていないところは元のまま（AIが補完した印も残る）
      const part = (k) => {
        const text = v(k + i);
        const o = orig[k];
        if (o && typeof o === 'object' && Engine.partText(o) === text) return o;
        return { text, by: text ? 'me' : 'ai' };
      };
      ideas.push({ title: title || summary.slice(0, 16), summary, target: part('target'), problem: part('problem'), feature: part('feature'), push: ed.push[i] || 'normal' });
    }
    if (!ideas.length) {
      S.error = '案を1つ以上残してください（名前か説明のどちらかだけでも大丈夫です）。';
      return renderStatus();
    }
    const next = Engine.normalizeBrief({ ideas, likes: v('likes'), worries: v('worries'), mustHaves: v('must').split(/\n+/), wantFromOthers: v('want'), acceptCondition: v('accept'), impl: v('impl') });
    next.updates = base.updates || [];
    const same = JSON.stringify({ ...next, editedAt: 0 }) === JSON.stringify({ ...Engine.normalizeBrief(base), updates: base.updates || [], editedAt: 0 });
    S.edit = null;
    clearEditDrafts();
    S.error = '';
    if (same) {
      S.notice = '変更はありませんでした。';
      return render();
    }
    if (ed.src === 'saved') next.editedAt = Date.now(); // 預け直しの印（代表者のアプリが議論をやり直す合図）
    else if (base.editedAt) next.editedAt = base.editedAt;
    S.priv.pendingBrief = next;
    S.notice = ed.src === 'saved' ? '手直しした内容です。「この内容で預ける」を押すと、預け直します。' : '';
    savePriv();
    render();
  }
  function editCard() {
    const ed = S.edit;
    const one = { style: 'min-height:40px;height:40px' };
    const shown = Array.from({ length: ed.n }, (_, i) => i).filter((i) => !ed.removed.includes(i));
    const pushBtn = (i, val, label) => h('button', { class: 'btn small' + ((ed.push[i] || 'normal') === val ? '' : ' ghost'), onclick: () => { ed.push[i] = val; render(); } }, label);
    const ideaBlock = (i, no) => [
      h('div', { class: 'row', style: 'margin-top:14px;align-items:center' }, h('h3', { style: 'margin:0;flex:1' }, shown.length > 1 ? `案${no + 1}` : '案'), shown.length > 1 ? h('button', { class: 'btn ghost small', onclick: () => { ed.removed.push(i); render(); } }, 'この案を消す') : null),
      h('label', {}, '案の名前'),
      draftArea('e:title' + i, { ...one, id: 'e-title' + i }),
      h('label', {}, 'どんな案か'),
      draftArea('e:sum' + i, { id: 'e-sum' + i }),
      h('label', {}, '誰向けか'),
      draftArea('e:target' + i, one),
      h('label', {}, '何を解決するか'),
      draftArea('e:problem' + i, one),
      h('label', {}, '目玉機能'),
      draftArea('e:feature' + i, one),
      h('label', {}, 'この案への気持ち'),
      h('div', { class: 'row' }, pushBtn(i, 'push', '推し'), pushBtn(i, 'normal', 'ふつう'), pushBtn(i, 'drop', '無しでいい')),
    ];
    return h(
      'div',
      { class: 'card', id: 'sec-edit' },
      h('h2', {}, '預ける内容を手直しする'),
      h('div', { class: 'hint' }, '書き換えたところは「本人」の内容として扱われます。空欄にした「誰向けか・何を解決するか・目玉機能」は、会議で代理人が仮に補います。'),
      shown.map((i, no) => ideaBlock(i, no)),
      shown.length < 3 ? h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn ghost small', onclick: () => { ed.n += 1; render(); } }, '案をもう1つ足す')) : null,
      h('h3', { style: 'margin-top:16px' }, 'あなたの代理人だけが持つ内容'),
      h('label', {}, '好きな点'),
      draftArea('e:likes', {}),
      h('label', {}, '不安な点'),
      draftArea('e:worries', {}),
      h('label', {}, `外したくない条件（1行に1つ、${Engine.MAX_MUST}つまで）`),
      h('div', { class: 'hint' }, 'これが無い案には反対する、という条件です。例：スマホで動くこと'),
      draftArea('e:must', {}),
      h('label', {}, '実装でできること'),
      draftArea('e:impl', {}),
      h('label', {}, '取り入れたい部分'),
      draftArea('e:want', one),
      h('label', {}, '納得の条件'),
      h('div', { class: 'hint' }, '自分の案が選ばれなくても、これが入っていれば賛成できること。例：デザインを担当できる'),
      draftArea('e:accept', one),
      h('div', { class: 'row end', style: 'margin-top:12px' }, h('button', { class: 'btn ghost', onclick: closeEdit }, 'やめる'), h('button', { class: 'btn', disabled: !!S.busy, onclick: saveEdit }, '手直しを反映する'))
    );
  }

  function questionsBox() {
    const qs = myOpenQuestions();
    if (!qs.length) return null;
    return h(
      'div',
      { class: 'card', id: 'sec-q' },
      h('h2', {}, `あなたへの確認（${qs.length}件）`),
      h('div', { class: 'hint', style: 'margin-bottom:10px' }, 'あなたの代理人が、預かった考えからは判断しにくかった点です。答えは代理人だけに伝わり、全部答えると議論をやり直します。'),
      qs.map((q) => {
        const c = q.candId && S.snap.cand[q.candId];
        return h(
          'div',
          { class: 'q' },
          c ? h('div', { class: 'hint' }, `「${c.title}」について`) : null,
          h('p', {}, q.text),
          draftArea('q:' + q.id, { placeholder: '一言でOKです' }),
          h('div', { class: 'row end' }, h('button', { class: 'btn small', disabled: S.busy === 'answer', onclick: () => answer(q) }, '答える'))
        );
      })
    );
  }

  // ---------- 個室（APIキーなしのメンバー用の入力フォーム） ----------
  function formToBrief() {
    const d = S.drafts;
    const v = (k) => (d[k] || '').trim();
    const ideas = [];
    for (let i = 0; i < (S.formIdeas || 1); i++) {
      const title = v('f:title' + i);
      const summary = v('f:sum' + i);
      if (!title && !summary) continue;
      const part = (k) => ({ text: v(k + i), by: v(k + i) ? 'me' : 'ai' });
      ideas.push({ title: title || summary.slice(0, 16), summary, target: part('f:target'), problem: { text: '', by: 'ai' }, feature: part('f:feature'), push: 'normal' });
    }
    if (!ideas.length) {
      S.error = '案を1つ以上入力してください（名前か説明のどちらかだけでも大丈夫です）。';
      return renderStatus();
    }
    S.error = '';
    S.priv.pendingBrief = Engine.normalizeBrief({ ideas, likes: v('f:likes'), worries: v('f:worries'), mustHaves: v('f:must').split(/\n+/), wantFromOthers: '', acceptCondition: '', impl: v('f:impl') });
    savePriv();
    render();
  }
  function formPane() {
    const n = S.formIdeas || 1;
    const one = { style: 'min-height:40px;height:40px' };
    const ideaBlock = (i) => [
      h('h3', {}, n > 1 ? `案${i + 1}` : '案'),
      h('label', {}, '案の名前'),
      draftArea('f:title' + i, { ...one, placeholder: '例：講義メモ自動停止' }),
      h('label', {}, 'どんな案か'),
      draftArea('f:sum' + i, { placeholder: '一言でも、まだ固まっていなくても大丈夫です' }),
      h('label', {}, '誰向けか（任意）'),
      draftArea('f:target' + i, { ...one, placeholder: '空欄なら、会議で代理人が仮に補います' }),
      h('label', {}, '目玉機能（任意）'),
      draftArea('f:feature' + i, { ...one, placeholder: '空欄でも大丈夫です' }),
    ];
    return h(
      'div',
      { class: 'chat' },
      h('div', { class: 'chat-head' }, h('b', {}, `${S.cfg.name}さんの代理人と話す`), h('div', { class: 'hint' }, 'この会議ではAIのサーバーが使えないので、代理人との会話の代わりに、このフォームで考えを預けます。入力した内容はこのPCに下書きとして残り、預けるまで他のメンバーには見えません。')),
      h(
        'div',
        { class: 'msgs formbody' },
        Array.from({ length: n }, (_, i) => ideaBlock(i)),
        n < 3 ? h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn ghost small', onclick: () => { S.formIdeas = n + 1; render(); } }, '案をもう1つ足す')) : null,
        h('h3', {}, 'あなたの考え'),
        h('label', {}, '案の好きなところ'),
        draftArea('f:likes', {}),
        h('label', {}, '不安なところ'),
        draftArea('f:worries', {}),
        h('label', {}, '外したくない条件（1行に1つ、3つまで。無ければ空欄）'),
        h('div', { class: 'hint' }, 'これが無い案には反対する、という条件です。'),
        draftArea('f:must', { placeholder: '例：締切までに確実に動くこと' }),
        h('label', {}, '実装でできること（担当できる部分、使える時間）'),
        draftArea('f:impl', {})
      ),
      h('div', { class: 'composer' }, h('span', { class: 'hint', style: 'flex:1;align-self:center' }, '預ける前に、右側で内容を確認できます。'), h('button', { class: 'btn', disabled: !!S.busy, onclick: formToBrief }, '内容を確認する'))
    );
  }

  // ---------- はじめての人向けの案内（Webプロトタイプ） ----------
  // 1つの画面で3人分を試すので、「ほかの人を待つ」場面では、その人に切り替えるボタンを出す
  async function actAs(id, tab) {
    if (S.busy) return;
    if (tab) S.tab = tab;
    await switchMember(id);
  }
  async function fillRest() {
    if (S.busy) return;
    const n = window.PROTO.fillSamples();
    S.cfg = await api.getConfig();
    await enterRoom();
    S.notice = n ? `まだの${n}人にサンプルの考えを入れました。まもなく会議が始まります。` : 'サンプルを入れられる人がいませんでした。人を切り替えて入力してください。';
    render();
  }
  function protoWaitHelp(yet) {
    if (!window.PROTO || !yet.length) return null;
    return h(
      'div',
      { class: 'q', style: 'margin-top:12px' },
      h('p', {}, 'この試作では、1つの画面で3人分を操作します。まだの人の分は、その人に切り替えて入力するか、サンプルの考えを入れてください。'),
      h('div', { class: 'row' }, yet.map((m) => h('button', { class: 'btn small', disabled: !!S.busy, onclick: () => actAs(m.id, 'room') }, `${m.name}として入力する`)), h('button', { class: 'btn ghost small', disabled: !!S.busy, onclick: fillRest }, 'まだの人にサンプルを入れる'))
    );
  }
  function protoApproveHelp(st) {
    if (!window.PROTO || st.phase !== 'review') return null;
    const snap = S.snap;
    const yet = (st.participants || []).filter((id) => id !== S.cfg.memberId && !(snap.approval[id] && snap.approval[id].ok && snap.approval[id].round === st.round));
    if (!yet.length) return null;
    return h(
      'div',
      { class: 'q', style: 'margin-top:10px' },
      h('p', {}, 'この試作では、ほかの人の承認も自分で行います。下のボタンでその人に切り替えて、「この案を承認する」を押してください。全員が承認すると決定です。'),
      h('div', { class: 'row' }, yet.map((id) => h('button', { class: 'btn small', disabled: !!S.busy, onclick: () => actAs(id, 'meeting') }, `${(snap.member[id] || {}).name || '?'}として承認する`)))
    );
  }
  // 評価基準が空のまま会議が始まらないように、預ける前に知らせる
  function critNote() {
    const st = state();
    const r = roomInfo();
    if (st.phase !== 'collecting' || isRunning() || !isLeader() || String(r.criteria || '').trim()) return null;
    return h(
      'div',
      { class: 'q' },
      h('p', {}, '評価基準がまだ入っていません。入れておくと、代理人と進行役AIがその基準ごとに案を採点します。会議が始まる前（全員が預ける前）に入れるのがおすすめです。'),
      h('div', { class: 'row' }, h('button', { class: 'btn small', disabled: !!S.busy, onclick: () => { S.tab = 'meeting'; S.editTopic = true; S.drafts['t:theme'] = r.theme || ''; S.drafts['t:criteria'] = r.criteria || ''; S.drafts['t:conditions'] = r.conditions || ''; S.drafts['t:deadline'] = toLocalInput(r.deadlineAt); render(); const ta = document.querySelector('details.fold textarea'); if (ta) ta.scrollIntoView({ block: 'center' }); } }, '評価基準を入れる'))
    );
  }

  // 「いまやること」: 聞き取りの進み具合と、預けるための主ボタンを1か所にまとめる
  function todoCard(said, left, covered) {
    return h(
      'div',
      { class: 'card todo' },
      h('span', { class: 'pill' }, 'いまやること'),
      h('div', { class: 'todo-t' }, !canAI() ? 'フォームに考えを書く' : !said ? '代理人に案を話す' : left === 0 ? '内容を確認して預ける' : '代理人の質問に答える'),
      h('div', { class: 'hint' }, !canAI() ? '左のフォームに入力して「内容を確認する」を押すと、ここに預ける内容が出ます。' : !said ? 'チャットに、考えている案を一言書いてください。' : left === 0 ? '聞き取りが終わりました。' : `あと${left}問で聞き取りが終わります。`),
      canAI() ? h('ul', { class: 'checks' }, Engine.INTERVIEW_ITEMS.map((name, i) => h('li', { class: covered.includes(i + 1) ? 'ok' : '' }, h('span', { class: 'ck' }, covered.includes(i + 1) ? '✓' : ''), name))) : null,
      canAI() ? h('button', { class: 'btn big block', disabled: !!S.busy || !said, onclick: makeBrief }, '預ける内容を確認する') : null,
      canAI() ? h('div', { class: 'hint center' }, '途中でも預けられます。足りない所は代理人が推測します。') : null
    );
  }
  // 推薦案の点数と実現性を、数字のタイルで見せる
  // 次点との点差が、どの項目でついたか（点数からそのまま計算。AIの文章ではない）
  function gapView(rec) {
    const g = Engine.compareTop(rec);
    if (!g) return null;
    const sign = (x) => (x > 0 ? '+' : '') + x;
    const up = g.rows.filter((x) => x.pts > 0);
    const down = g.rows.filter((x) => x.pts < 0);
    const row = (x) => h('li', {}, h('b', {}, x.label), ` ${sign(x.pts)}点`, h('span', { class: 'gapsub' }, `（この案 ${x.a} ／ 次点 ${x.b}）`));
    return h(
      'div',
      { class: 'gap' },
      h('div', { class: 'gap-h' }, `次点「${g.title}」との差：`, h('b', {}, `${sign(g.diff)}点`), h('span', { class: 'gapsub' }, '点数からそのまま計算した内訳です')),
      up.length ? h('div', {}, h('span', { class: 'gap-l' }, 'この案が上だった項目'), h('ul', { class: 'plain' }, up.map(row))) : null,
      down.length ? h('div', {}, h('span', { class: 'gap-l' }, '次点が上だった項目'), h('ul', { class: 'plain' }, down.map(row))) : null,
      !up.length && !down.length ? h('div', { class: 'hint' }, 'どの項目も同じ点でした。') : null,
      h('div', { class: 'hint', style: 'margin-top:6px' }, rec.judgedTimes > 1 ? '基準の点は、進行役AIが同じ採点を2回行った平均です（ぶれを減らすため）。2回のどちらか片方だけで決めると1位が変わる場合と、1.5点未満の差は「僅差」として扱い、上位2案を全員にもう一度聞きます。' : '基準の点はAIが付けるので、会議をやり直すと変わることがあります。1.5点未満の差は「僅差」として扱い、上位2案を全員にもう一度聞きます。'),
      scoreRule()
    );
  }
  // 点の決め方と、その重みにしている理由
  function scoreRule() {
    return h(
      'details',
      { class: 'rule' },
      h('summary', {}, '点の決め方と、この重みにしている理由'),
      h('ul', { class: 'plain' },
        h('li', {}, h('b', {}, '評価基準への合い方 70点： '), '代表者が決めた基準に合うかを、進行役AIが案の中身だけを見て採点します（誰の案かは知らせません）。審査や目的に合う案を選ぶ会議なので、こちらを主にしています。'),
        h('li', {}, h('b', {}, 'メンバーの支持 30点： '), '基準の点が高くても、作る本人たちが乗り気でない案は進みません。そのための歯止めとして3割を充てています。'),
        h('li', {}, h('b', {}, '代理人の推測は重み半分： '), '本人が言っていないことを代理人が推し量った評価は、本人の言葉より軽く扱います。推測だけで案が落ちないよう、低い推測が付いたときは本人に確かめます。'),
        h('li', {}, h('b', {}, '本人が「嫌」と言った案は対象外： '), '点数で押し切らないためです。')
      ),
      h('div', { class: 'hint' }, 'この配分は、このアプリが決めた目安です。基準ごとの重みは、代表者が「新しさ ×2」のように変えられます。')
    );
  }
  // 理由の最初の1文だけを取り出す
  function firstSentence(text) {
    const t = Engine.cleanText(text, S.snap && S.snap.cand).replace(/\s+/g, ' ').trim();
    const sents = (t.match(/[^。！？!?]+[。！？!?]*/g) || [t]).map((x) => x.trim()).filter(Boolean);
    // 「〜を推薦します。」「合計◯点で〜」のような前置きは飛ばし、決め手を言っている文を出す
    const key = sents.find((x) => /決め手|理由は|強みは|からです/.test(x));
    const body = key || sents.find((x) => !/推薦(します|です|は)|^合計[\d.]+点/.test(x)) || sents[0] || '';
    return body.length > 110 ? body.slice(0, 108) + '…' : body;
  }
  // 次点との差を1行で
  function gapLine(rec) {
    const g = Engine.compareTop(rec);
    if (!g) return null;
    const best = g.rows.filter((x) => x.pts > 0).sort((a, b) => b.pts - a.pts)[0];
    return h('div', { class: 'gap1' }, `次点は「${g.title}」（${g.diff > 0 ? '+' : ''}${g.diff}点の差）`, best ? h('span', { class: 'gapsub' }, `いちばん差がついたのは「${best.label}」`) : null);
  }
  function scoreTiles(rec, top) {
    const t = (rec.table || []).find((x) => x.candId === rec.topId);
    const tile = (label, v, unit, main) => h('div', { class: 'tile' }, h('span', { class: 'tl' }, label), h('span', { class: 'tv' + (main ? ' main' : '') }, String(v), h('small', {}, unit)));
    const tiles = [];
    if (t && t.total !== undefined) {
      tiles.push(tile('合計', t.total, ' / 100点', true));
      if (t.crit !== null && t.crit !== undefined) tiles.push(tile('評価基準への合い方', t.crit, ' / 70'), tile('メンバーの支持', t.support, ' / 30'));
      else tiles.push(h('div', { class: 'tile' }, h('span', { class: 'tl' }, '内訳'), h('span', { class: 'tv s' }, '支持のみ（評価基準が未設定）')));
    } else if (t && t.score !== undefined) tiles.push(tile('点数', t.score, '点', true));
    if (top.feas) tiles.push(h('div', { class: 'tile feas-' + top.feas.verdict }, h('span', { class: 'tl' }, '実現性'), h('span', { class: 'tv s' }, Engine.FEAS_LABEL[top.feas.verdict] || '—')));
    return tiles.length ? h('div', { class: 'tiles' }, tiles) : null;
  }

  // ---------- 個室 ----------
  function viewRoom() {
    const chatBusy = S.busy === 'chat';
    const covered = S.priv.covered || [];
    const left = Engine.INTERVIEW_ITEMS.length - covered.length;
    const said = S.priv.chat.some((m) => m.role === 'user');
    const msgs = h(
      'div',
      { class: 'msgs', id: 'msgs' },
      S.priv.chat.map((m) => h('div', { class: 'bubble ' + m.role }, m.content)),
      chatBusy ? h('div', { class: 'bubble assistant' }, '…') : null
    );
    const input = draftArea('chat', {
      id: 'chatInput',
      placeholder: '代理人に話す（Enterで送信）', title: 'Enterで送信／Shift+Enterで改行',
      onkeydown: (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          sendChat();
        }
      },
    });
    const chat = h(
      'div',
      { class: 'chat' },
      h(
        'div',
        { class: 'chat-head' },
        h('div', { class: 'agenthead' }, avatar(S.cfg.memberId), h('div', {}, h('b', {}, `${S.cfg.name}さんの代理人`), h('div', { class: 'hint' }, 'この会話はこのPCにだけ保存されます。預けるのはまとめたメモだけで、本音の部分（好きな点・不安な点・条件）は、ほかのメンバーの画面に出ません。')))
      ),
      msgs,
      // 代理人の質問に、押すだけで答えられる選択肢。自分の言葉で書きたいときは下の入力欄を使う
      !chatBusy && (S.priv.choices || []).length && !S.priv.pendingBrief
        ? h('div', { class: 'quick', id: 'quick' }, h('span', { class: 'hint' }, '押して答える：'), S.priv.choices.map((c) => h('button', { class: 'chip', disabled: !!S.busy, onclick: () => sendChat(c) }, c)))
        : null,
      h(
        'div',
        { class: 'composer' },
        input,
        // 声で入力（デスクトップ版）: Windows の音声入力を起動し、聞き取った文字が入力欄に入る。送信は自分で押す
        api.voiceStart && !window.PROTO
          ? h(
              'button',
              {
                class: 'btn ghost mic',
                id: 'micBtn',
                title: '声で入力する（Windowsの音声入力を使います）',
                disabled: !!S.busy,
                onclick: async () => {
                  const box = $('chatInput');
                  if (box) box.focus();
                  const r = await api.voiceStart();
                  S.error = '';
                  S.notice = r && r.ok ? '音声入力を始めました。話した内容が入力欄に入るので、確かめてから「送信」を押してください。止めるときは、もう一度マイクを押します。' : (r && r.msg) || '音声入力を起動できませんでした。';
                  renderStatus();
                  const again = $('chatInput');
                  if (again) again.focus();
                },
              },
              (() => {
                const ic = h('span', { class: 'mic-ic' });
                ic.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/></svg>';
                return ic;
              })(),
              '声で入力'
            )
          : null,
        h('button', { class: 'btn', disabled: !!S.busy, onclick: () => sendChat() }, '送信')
      )
    );

    const side = h('div', { class: 'side' });
    const cn = critNote();
    if (cn) side.append(cn);
    // 代理人からの確認に答える場所は「② 会議と結果」の1か所だけ（推薦案を見ながら答えられる）。ここには案内だけを出す
    const nq = myOpenQuestions().length;
    if (nq) {
      side.append(
        h(
          'div',
          { class: 'card qlink', id: 'sec-qlink' },
          h('h2', {}, `代理人から確認が${nq}件あります`),
          h('div', { class: 'hint' }, '推薦案を見ながら答えられるように、確認は「② 会議と結果」にまとめています。左のチャットに書いても、確認への答えにはなりません。'),
          h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn', onclick: () => goTo('meeting', 'sec-q') }, '確認に答える'))
        )
      );
    }
    if (S.edit && (S.edit.src === 'pending' ? S.priv.pendingBrief : S.priv.brief)) {
      side.append(editCard());
    } else if (S.priv.pendingBrief) {
      side.append(
        h(
          'div',
          { class: 'card' },
          h('h2', {}, '預ける内容の確認'),
          h('div', { class: 'hint' }, '「本人」はあなたが言ったこと、「AIが補完」は代理人が仮で埋めたところです。違っていたら「手直しする」で直接書き換えられます。「やめる」を押して、代理人とのチャットで言い直すこともできます。'),
          briefView(S.priv.pendingBrief),
          h(
            'div',
            { class: 'row end' },
            h('button', { class: 'btn ghost', disabled: !!S.busy, onclick: () => { delete S.priv.pendingBrief; savePriv(); render(); } }, 'やめる'),
            h('button', { class: 'btn ghost', disabled: !!S.busy, onclick: addIdea }, '別の案も足す'),
            h('button', { class: 'btn ghost', disabled: !!S.busy, onclick: () => openEdit('pending') }, '手直しする'),
            h('button', { class: 'btn', disabled: !!S.busy, onclick: confirmDeposit }, 'この内容で預ける')
          )
        )
      );
    } else if (S.priv.brief) {
      const wc = waitCard(true);
      if (wc) side.append(wc);
      side.append(
        h(
          'div',
          { class: 'card' },
          h('div', { class: 'row', style: 'align-items:center' }, h('h2', { style: 'margin:0;flex:1' }, '代理人に預け済み'), state().phase === 'decided' ? null : h('button', { class: 'btn ghost small', disabled: !!S.busy, onclick: () => openEdit('saved') }, '手直しする')),
          briefView(S.priv.brief),
          h('label', {}, 'やっぱりこう思う（代理人に追加で伝える）'),
          draftArea('tell', { placeholder: '例：実装が間に合うなら、Bさんの案でもいいと思ってきた' }),
          h(
            'div',
            { class: 'row end' },
            canAI() ? h('button', { class: 'btn small', disabled: !!S.busy, onclick: addIdea }, '別の案も預ける') : null,
            canAI() ? h('button', { class: 'btn ghost small', disabled: !!S.busy, onclick: makeBrief }, '会話から作り直して預け直す') : h('span', { class: 'hint' }, '案そのものを変えるときは、上の「手直しする」か、左のフォームを直して「内容を確認する」を押してください。'),
            h('button', { class: 'btn small', disabled: !!S.busy, onclick: () => tellAgent('tell') }, '伝えて議論をやり直す')
          )
        )
      );
    } else {
      side.append(
        todoCard(said, left, covered)
      );
    }
    return h('div', { class: 'room' }, canAI() ? chat : formPane(), side);
  }

  // ---------- 会議のライブ表示 ----------
  const STAGES = [['round1', '意見を出す'], ['merge', '合体案・新案'], ['feas', '作れるか調べる'], ['round2', '評価し直す'], ['explain', '推薦をまとめる']];
  // 文章を段落ごとに分けて表示する
  const paras = (text) => {
    // 前の版で保存された文章にも、案の内部の番号や引用の印が残っていることがあるので、表示のときにも取り除く
    const ps = Engine.paragraphs(Engine.cleanText(text, S.snap && S.snap.cand));
    return ps.length ? ps.map((p) => h('p', { class: 'para' }, p)) : [text || ''];
  };

  // 発言を、人のアイコン付きの吹き出しで表示する
  function speakerIdOf(name) {
    if (name === '進行役AI') return 'facilitator';
    const hit = Object.entries(S.snap.member).find(([, m]) => `${m.name}さんの代理人` === name);
    return hit ? hit[0] : '';
  }
  function avatar(speakerId) {
    if (speakerId === 'facilitator') return h('span', { class: 'av fac', title: '進行役AI' }, 'AI');
    const idx = Math.max(0, Object.keys(S.snap.member).sort().indexOf(speakerId));
    return h('span', { class: 'av c' + (idx % 6) }, h('i', {}));
  }
  function bubbleRow(speakerId, name, text, typing) {
    const mine = speakerId === S.cfg.memberId;
    const fac = speakerId === 'facilitator';
    return h(
      'div',
      { class: 'brow' + (mine ? ' mine' : '') + (fac ? ' fac' : '') + (typing ? ' typing' : '') },
      avatar(speakerId),
      h('div', { class: 'bcol' }, h('div', { class: 'bname', id: typing ? 'liveName' : null }, name + (mine ? '（あなたの代理人）' : '')), h('div', { class: 'bub', id: typing ? 'liveText' : null }, paras(text)))
    );
  }
  function msgRow(m) {
    if (m.type === 'system') return h('div', { class: 'm system' }, m.text);
    return bubbleRow(m.speaker, m.speakerName, m.text, false);
  }
  // 経過時間を「1分20秒」の形にする
  const fmtSpan = (ms) => {
    const sec = Math.max(0, Math.round(ms / 1000));
    return sec < 60 ? `${sec}秒` : `${Math.floor(sec / 60)}分${sec % 60 ? (sec % 60) + '秒' : ''}`;
  };
  // 会議中の「開始から◯分◯秒」を1秒ごとに進める（画面全体は描き直さない）
  setInterval(() => {
    const el = $('liveElapsed');
    const st = S.snap && S.snap.state && S.snap.state.main;
    if (el && st && st.runStartedAt) el.textContent = fmtSpan(Date.now() - st.runStartedAt);
    const left = $('liveLeft');
    if (left && st && st.runStartedAt) left.textContent = leftText(st);
  }, 1000);
  // 会議の残り時間の目安。前回の実績があればそれを、なければ人数から見積もる（3人で約4分の実測に合わせた式）
  function estimateMs(st) {
    if (st.lastRunMs) return st.lastRunMs;
    const n = Math.max(2, (st.participants || []).length || Object.keys((S.snap && S.snap.brief) || {}).length);
    return (60 + 65 * n) * 1000;
  }
  function leftText(st) {
    const left = estimateMs(st) - (Date.now() - st.runStartedAt);
    if (left <= 20000) return 'まもなく終わります';
    return `あと約${Math.max(1, Math.round(left / 60000))}分`;
  }
  function liveCard(st) {
    const idx = STAGES.findIndex((x) => x[0] === st.stage);
    const msgs = Engine.sortedMsgs(S.snap).filter((m) => m.round === st.round);
    const speaker = (S.live && S.live.speakerName) || st.speaker || '';
    S.liveShown = speaker;
    const text = (S.live && S.live.text) || '';
    return h(
      'div',
      { class: 'card live' },
      h('h2', {}, h('span', { class: 'livedot' }), `会議中（第${st.round || 1}回・リアルタイム）`),
      h('div', { class: 'steps' }, STAGES.map((x, i) => h('span', { class: 'step' + (idx >= 0 && i < idx ? ' done' : i === idx ? ' now' : '') }, `${i + 1}. ${x[1]}`))),
      h(
        'div',
        { class: 'livetime' },
        h('span', {}, idx >= 0 ? `いま ${idx + 1} / ${STAGES.length} 段階め` : '準備中'),
        st.runStartedAt ? h('span', {}, '開始から ', h('b', { id: 'liveElapsed' }, fmtSpan(Date.now() - st.runStartedAt))) : null,
        st.runStartedAt ? h('b', { id: 'liveLeft', class: 'liveleft' }, leftText(st)) : null,
        h('span', {}, st.lastRunMs ? `前回の会議は${fmtSpan(st.lastRunMs)}で終わりました` : `ふつう${Math.max(2, Math.round(estimateMs(st) / 60000) - 1)}〜${Math.round(estimateMs(st) / 60000) + 1}分で終わります`)
      ),
      h(
        'div',
        { class: 'log livelog', id: 'livelog' },
        msgs.map(msgRow),
        speaker ? bubbleRow(speakerIdOf(speaker), speaker, text || '考えています…', true) : h('div', { class: 'm system' }, (st.progress || '準備しています') + '…')
      ),
      h('div', { class: 'hint', style: 'margin-top:8px' }, st.runner === S.cfg.memberId ? '発言が出るたびにここへ流れます。終わると下に推薦案が出ます。会議が終わるまでこの画面を開いたままにしてください。' : st.runner === 'server' ? 'サーバーが会議を進めています。発言が1つ終わるたびにここへ出ます。この画面を閉じても会議は進みます。' : `${st.runnerName || 'ほかのメンバー'}さんのアプリが会議を進めています。発言が出るたびにここへ流れます。`)
    );
  }
  // 話している途中の文章だけを差し替える（画面全体は描き直さない）
  function updateLive() {
    if (S.tab !== 'meeting') return;
    const text = $('liveText');
    // 話す人が替わったら描き直す（アイコンと位置が変わるため）
    if (S.live && (!text || S.live.speakerName !== S.liveShown)) return render();
    if (S.live && S.live.text && text) text.replaceChildren(...paras(S.live.text));
    const box = $('livelog');
    if (box) box.scrollTop = box.scrollHeight;
  }

  // ---------- お題と評価基準 ----------
  function topicCard() {
    const r = (S.snap.room && S.snap.room.main) || {};
    const set = Engine.hasTopic(S.snap);
    if (!S.editTopic) {
      const crit = String(r.criteria || '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
      return fold(
        'topic',
        'お題と評価基準' + (crit.length ? '' : '（評価基準がまだ入っていません）'),
        !crit.length,
        set
          ? [
              h('div', { class: 'kv' }, h('b', {}, 'テーマ： '), r.theme || '（未設定）'),
              h('div', { class: 'kv' }, h('b', {}, '評価基準： '), crit.length ? h('ul', { class: 'plain' }, crit.map((c) => h('li', {}, c))) : '（未設定。入れると、この基準ごとの採点が点数の70点分になります）'),
              r.deadlineAt ? h('div', { class: 'kv' }, h('b', {}, '預ける締切： '), `${fmtDeadline(r.deadlineAt)}（${fmtLeft(r.deadlineAt - Date.now())}）`) : null,
              r.conditions ? h('div', { class: 'kv' }, h('b', {}, 'そのほかの条件： '), r.conditions) : null,
            ]
          : h('div', { class: 'hint' }, 'まだ設定されていません。テーマと評価基準を入れると、代理人と進行役AIがそれに沿って案を評価します。'),
        isLeader()
          ? h('div', { class: 'row end' }, h('button', { class: 'btn ghost small', disabled: !!S.busy, onclick: () => { S.editTopic = true; S.drafts['t:theme'] = r.theme || ''; S.drafts['t:criteria'] = r.criteria || ''; S.drafts['t:conditions'] = r.conditions || ''; S.drafts['t:deadline'] = toLocalInput(r.deadlineAt); render(); } }, set ? '編集する' : '設定する'))
          : h('div', { class: 'hint', style: 'margin-top:6px' }, 'お題と評価基準は、代表者が設定します。')
      );
    }
    const save = () =>
      run('topic', async () => {
        const cur = (S.snap.room && S.snap.room.main) || {};
        await api.store.put('room', 'main', { ...cur, theme: (S.drafts['t:theme'] || '').trim(), criteria: (S.drafts['t:criteria'] || '').trim(), conditions: (S.drafts['t:conditions'] || '').trim(), deadlineAt: fromLocalInput(S.drafts['t:deadline'] || '') });
        S.editTopic = false;
    S.edit = null;
        S.notice = Object.keys(S.snap.cand).length ? '保存しました。いまの会議結果に反映するには、ログの下の「最初から会議をやり直す」を押してください。' : '保存しました。チーム全員の会議に反映されます。';
      });
    S.open = S.open || {};
    S.open.topic = true;
    return fold(
      'topic',
      'お題と評価基準',
      true,
      h('div', { class: 'hint' }, 'チーム全員で共有されます。'),
      h('label', {}, 'テーマ'),
      draftArea('t:theme', { placeholder: '例：かゆいところに手が届くアプリ', style: 'min-height:40px;height:40px' }),
      h('label', {}, '評価基準（1行に1つ。重みを付けたい基準は、行の最後に「×2」のように書く）'),
      draftArea('t:criteria', { placeholder: '例：\nテーマに合っているか\n新しさがあるか ×2\n完成度・実際に動くか\nプレゼンで伝わるか', style: 'min-height:110px' }),
      critTemplateRow((text) => { S.drafts['t:criteria'] = text; render(); }),
      h('label', { for: 't-deadline' }, '預ける締切（任意）'),
      h('input', { id: 't-deadline', type: 'datetime-local', value: S.drafts['t:deadline'] || '', oninput: (e) => { S.drafts['t:deadline'] = e.target.value; } }),
      h('div', { class: 'hint' }, 'この時刻になると、預けた人だけ（2人以上）で会議を自動で始めます。空欄なら全員を待ちます。'),
      h('label', {}, 'そのほかの条件'),
      draftArea('t:conditions', { placeholder: '例：3人チーム、11/19（木）20時 提出締切', style: 'min-height:40px;height:40px' }),
      h('div', { class: 'row end' }, h('button', { class: 'btn ghost small', onclick: () => { S.editTopic = false; render(); } }, 'やめる'), h('button', { class: 'btn small', disabled: !!S.busy, onclick: save }, '保存する'))
    );
  }

  // ---------- 実行記録（AIの呼び出しごとの時間と、渡した情報） ----------
  const TASK_LABEL = { round1: '意見を出す', merge: '合体案・新案を作る', feas: '技術的に作れるか調べる', round2: '評価し直す', rerun: '評価を見直す', judge: '評価基準で採点', explain: '推薦の説明' };
  function callsFold() {
    const calls = Object.entries(S.snap.call || {}).map(([id, c]) => ({ id, ...c })).sort((a, b) => a.at - b.at);
    if (!calls.length) return null;
    const st = state();
    const cur = calls.filter((c) => c.round === st.round);
    const sec = (ms) => (ms / 1000).toFixed(1);
    const total = cur.reduce((t, c) => t + c.ms, 0);
    const who = (c) => (c.owner === 'facilitator' ? '進行役AI' : `${(S.snap.member[c.owner] || {}).name || '?'}さんの代理人`);
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify({ app: 'MeetForMe', exportedAt: new Date().toISOString(), snapshot: S.snap }, null, 1));
        S.notice = '会議の記録をコピーしました。メモ帳などに貼り付けて保存できます。';
      } catch (e) {
        S.error = 'コピーできませんでした。';
      }
      renderStatus();
    };
    return fold(
      'calls',
      `実行記録（第${st.round}回：AIの呼び出し${cur.length}回・合計${sec(total)}秒）`,
      false,
      h('div', { class: 'hint' }, '呼び出しごとの所要時間と文字数です。「渡した情報」は、進行役AIの分と、自分の代理人の分だけ開けます（ほかの人の本音が入っているため）。'),
      h(
        'div',
        { class: 'calls' },
        cur.map((c) => {
          const mine = c.owner === 'facilitator' || c.owner === S.cfg.memberId;
          return h(
            'div',
            { class: 'call' },
            h('div', { class: 'callrow' }, h('span', {}, `${c.no}. ${who(c)}`), h('span', {}, TASK_LABEL[c.task] || c.task), h('span', {}, `${sec(c.ms)}秒`), h('span', { class: 'hint' }, `入力${(c.system + c.user).length}字／出力${(c.out || '').length}字`)),
            mine ? h('details', { class: 'more' }, h('summary', {}, 'この呼び出しに渡した情報を見る'), h('pre', { class: 'prompt' }, c.user)) : null
          );
        })
      ),
      h('div', { class: 'row end' }, h('button', { class: 'btn ghost small', onclick: copy }, '会議の記録をコピー'))
    );
  }

  // ---------- 承認の進み具合と、決定 ----------
  const fmtTime = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  // 誰が承認したかを、アイコンとチェックで見せる
  function approvalRow(st) {
    const parts = st.participants || [];
    const okOf = (id) => {
      const a = S.snap.approval[id];
      return !!(a && a.ok && a.round === st.round);
    };
    const done = parts.filter(okOf).length;
    return h(
      'div',
      { class: 'approvals' },
      h('div', { class: 'apbar' }, h('span', { style: `width:${parts.length ? Math.round((done / parts.length) * 100) : 0}%` })),
      h('div', { class: 'aplist' }, parts.map((id) => h('div', { class: 'ap' + (okOf(id) ? ' ok' : '') }, avatar(id), h('span', { class: 'apname' }, (S.snap.member[id] || {}).name || '?'), h('span', { class: 'apmark' }, okOf(id) ? '✓ 承認' : '未承認')))),
      h('div', { class: 'hint' }, st.phase === 'decided' ? `全員（${parts.length}人）が承認しました。` : `承認 ${done} / ${parts.length} 人。全員が承認すると決定になります。`)
    );
  }
  function decisionText(st) {
    const snap = S.snap;
    const c = snap.cand[st.decidedCandId] || {};
    const rec = st.recommendation || {};
    const t = (rec.table || []).find((x) => x.candId === st.decidedCandId);
    const names = (st.participants || []).map((id) => (snap.member[id] || {}).name || '?');
    const lines = [`【決定】${roomInfo().theme || 'MeetForMe'}`, '', `決まった案：${c.title || ''}`];
    if (c.summary) lines.push(c.summary);
    lines.push('', `誰向けか：${Engine.partText(c.target) || '-'}`, `何を解決するか：${Engine.partText(c.problem) || '-'}`, `目玉機能：${Engine.partText(c.feature) || '-'}`);
    if (t && t.total !== undefined) lines.push('', `点数：${pointsText(t)}`);
    if (c.feas) {
      lines.push('', `技術的に作れるか：${Engine.FEAS_LABEL[c.feas.verdict] || ''}（${c.feas.searched ? 'Web検索で確認' : 'AIの知識による判断'}）`, `締切までに作れる範囲：${c.feas.mvp || '-'}`);
      if (c.feas.later) lines.push(`後回しにする範囲：${c.feas.later}`);
      if (c.feas.risk) lines.push(`つまずきそうな点：${c.feas.risk}`);
    }
    if (rec.reason) lines.push('', '理由：', rec.reason);
    if (rec.plan && (rec.plan.steps || (rec.plan.roles || []).length)) {
      lines.push('', '実装の進め方（案）：');
      if (rec.plan.steps) lines.push(rec.plan.steps);
      for (const r of rec.plan.roles || []) lines.push(`・${r.name}：${r.role}`);
    }
    lines.push('', `承認：${names.join('・')}（全員）　${st.decidedAt ? fmtTime(st.decidedAt) : ''}`);
    return lines.join('\n');
  }
  function decidedCard(st) {
    const c = S.snap.cand[st.decidedCandId];
    const rec = st.recommendation || {};
    const t = (rec.table || []).find((x) => x.candId === st.decidedCandId);
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(decisionText(st));
        S.notice = '決定内容をコピーしました。SlackやNotionに貼り付けられます。';
      } catch (e) {
        S.error = 'コピーできませんでした。';
      }
      renderStatus();
    };
    S.open = S.open || {};
    const more = h(
      'details',
      { class: 'more', open: !!S.open.decmore },
      h('summary', {}, 'くわしく見る（案の中身・誰の意見が効いたか・実装の進め方）'),
      partsView(c),
      rec.influences && rec.influences.length ? h('div', {}, h('h3', {}, '誰のどの意見が効いたか'), h('ul', { class: 'plain' }, rec.influences.map((i) => h('li', {}, h('b', {}, i.name + '： '), i.point)))) : null,
      rec.plan && (rec.plan.steps || (rec.plan.roles || []).length)
        ? h('div', {}, h('h3', {}, '実装の進め方（案）'), rec.plan.steps ? h('div', { style: 'line-height:1.7' }, rec.plan.steps) : null, (rec.plan.roles || []).length ? h('ul', { class: 'plain' }, rec.plan.roles.map((r) => h('li', {}, h('b', {}, r.name + '： '), r.role))) : null)
        : null
    );
    more.addEventListener('toggle', () => { S.open.decmore = more.open; });
    return h(
      'div',
      { class: 'card decidedcard', id: 'sec-rec' },
      h('div', { class: 'stamp' }, '決定'),
      h('div', { class: 'dlabel' }, `全員が承認して決定しました${st.decidedAt ? '　' + fmtTime(st.decidedAt) : ''}`),
      h('div', { class: 'dtitle' }, c.title, c.origin === 'merged' ? h('span', { class: 'tag mix' }, '合体案') : null, c.origin === 'ai' ? h('span', { class: 'tag new' }, 'AIの新案') : null),
      c.summary ? h('div', { class: 'dsum' }, c.summary) : null,
      t && t.total !== undefined ? h('div', { class: 'pts' }, pointsText(t)) : null,
      approvalRow(st),
      rec.reason ? h('div', {}, h('h3', {}, 'なぜこの案か'), h('div', { class: 'reason' }, paras(rec.reason))) : null,
      feasView(c, false),
      isLeader()
        ? h(
            'div',
            { class: 'row', style: 'margin-top:14px;align-items:center;flex-wrap:wrap', id: 'sec-reopen' },
            S.confirmReopen
              ? [h('span', { class: 'hint' }, '全員の承認が取り消されます。'), h('button', { class: 'btn small danger', disabled: !!S.busy, onclick: reopen }, '本当に取り消す'), h('button', { class: 'btn ghost small', onclick: () => { S.confirmReopen = false; render(); } }, 'やめる')]
              : h('button', { class: 'btn ghost small', disabled: !!S.busy, onclick: () => { S.confirmReopen = true; render(); } }, '決定を取り消して、話し合いに戻す')
          )
        : null,
      h('div', { class: 'row', style: 'margin-top:14px;align-items:center' }, h('button', { class: 'btn', onclick: copy }, '決定内容をコピー'), h('span', { class: 'hint' }, '案・理由・点数・担当の案を文章にして、チームのチャットに貼れます。')),
      more
    );
  }
  // 決定した瞬間を、画面いっぱいに知らせる（開いている全員の画面に出る）
  function showDecided(st) {
    const c = S.snap.cand[st.decidedCandId];
    const el = $('overlay');
    if (!c || !el) return;
    const names = (st.participants || []).map((id) => (S.snap.member[id] || {}).name || '?');
    const colors = ['#0b6b6b', '#c2643a', '#4a67b8', '#e0a800', '#8a5fb0', '#5d8a3a'];
    const close = () => { el.className = ''; el.replaceChildren(); };
    el.replaceChildren(
      h('div', { class: 'confetti' }, Array.from({ length: 36 }, (_, i) => h('i', { style: `left:${(i * 2.77) % 100}%;background:${colors[i % colors.length]};animation-delay:${(i % 9) * 0.12}s;animation-duration:${2.2 + (i % 5) * 0.35}s` }))),
      h(
        'div',
        { class: 'decidedbox' },
        h('div', { class: 'stamp big' }, '決定'),
        h('div', { class: 'dlabel' }, roomInfo().theme || ''),
        h('div', { class: 'dtitle' }, c.title),
        h('div', { class: 'dsum' }, `${names.join('さん・')}さんの全員が承認しました。`),
        h('div', { class: 'row', style: 'justify-content:center;margin-top:18px' }, h('button', { class: 'btn', onclick: () => { close(); goTo('meeting', 'sec-rec'); } }, '決定内容を見る'))
      )
    );
    el.className = 'show';
    el.onclick = (e) => { if (e.target === el) close(); };
    try {
      if (canNotify() && (document.hidden || !document.hasFocus())) notifyUser('MeetForMe：決定しました', `「${c.title}」に決まりました。`);
    } catch (e) {}
  }
  // ---------- お知らせ一覧（ベルマーク） ----------
  function loadAlerts() {
    try {
      S.alerts = JSON.parse(localStorage.getItem('mfm-alerts') || '[]');
      S.alertsRead = Number(localStorage.getItem('mfm-alerts-read') || 0);
    } catch (e) {
      S.alerts = [];
      S.alertsRead = 0;
    }
  }
  function saveAlerts() {
    try {
      localStorage.setItem('mfm-alerts', JSON.stringify((S.alerts || []).slice(-30)));
      localStorage.setItem('mfm-alerts-read', String(S.alertsRead || 0));
    } catch (e) {}
  }
  function addAlert(text) {
    S.alerts = (S.alerts || []).concat({ t: Date.now(), text }).slice(-30);
    saveAlerts();
    renderBell();
  }
  function renderBell() {
    const n = (S.alerts || []).filter((a) => a.t > (S.alertsRead || 0)).length;
    const el = $('bellN');
    if (el) el.textContent = n ? String(n) : '';
    if (S.bellOpen) renderBellPanel();
  }
  function renderBellPanel() {
    const el = $('bellpanel');
    const list = (S.alerts || []).slice().reverse();
    const fmt = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
    el.className = 'show';
    el.replaceChildren(
      h('div', { class: 'bh' }, 'お知らせ'),
      ...(list.length
        ? list.map((a) => h('div', { class: 'bi' + (a.t > (S.bellPrev || 0) ? ' new' : '') }, h('span', { class: 'bt' }, fmt(a.t)), a.text))
        : [h('div', { class: 'be' }, 'お知らせはまだありません。新しい人が参加したときや、会議が終わったときに、ここに出ます。')])
    );
  }
  function closeBell() {
    S.bellOpen = false;
    const el = $('bellpanel');
    if (el) el.className = '';
  }
  function setupBell() {
    loadAlerts();
    $('bell').addEventListener('click', (e) => {
      e.stopPropagation();
      if (S.bellOpen) return closeBell();
      S.bellOpen = true;
      S.bellPrev = S.alertsRead || 0;
      S.alertsRead = Date.now();
      saveAlerts();
      renderBell();
      renderBellPanel();
    });
    document.addEventListener('click', (e) => { if (S.bellOpen && !$('bellpanel').contains(e.target)) closeBell(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.bellOpen) closeBell(); });
    renderBell();
  }

  // お知らせ: 新しい人が参加したとき・会議が終わったときに、画面の上に出す（決定は別の画面で出る）
  function checkEvents() {
    if (!ready() || !S.snap) return;
    const ids = Object.keys(S.snap.member || {});
    const st = state();
    if (S.evRoom !== S.cfg.room || !S.evMembers) {
      S.evRoom = S.cfg.room;
      S.evMembers = ids;
      S.evRunAt = st.lastRunAt || 0;
      return;
    }
    const msgs = [];
    ids.filter((id) => !S.evMembers.includes(id) && id !== S.cfg.memberId).forEach((id) => msgs.push(`${(S.snap.member[id] || {}).name || '新しいメンバー'}さんが参加しました。`));
    S.evMembers = ids;
    if (st.phase === 'review' && !isRunning() && (st.lastRunAt || 0) > (S.evRunAt || 0)) msgs.push('会議が終わりました。推薦案を見て、承認してください。');
    S.evRunAt = st.lastRunAt || 0;
    if (!msgs.length) return;
    msgs.forEach(addAlert);
    S.notice = msgs.join(' ');
    try {
      if (canNotify() && (document.hidden || !document.hasFocus())) notifyUser('MeetForMe', msgs[0]);
    } catch (e) {}
    renderStatus();
  }
  function checkDecided() {
    if (!ready() || !S.snap) return;
    const st = state();
    if (S.phaseRoom !== S.cfg.room || S.phaseSeen === undefined) {
      S.phaseRoom = S.cfg.room;
      S.phaseSeen = st.phase;
      return;
    }
    const was = S.phaseSeen;
    S.phaseSeen = st.phase;
    if (st.phase === 'decided' && was !== 'decided') {
      const dc = S.snap.cand[st.decidedCandId];
      addAlert(dc ? `「${dc.title}」に決まりました。` : '決定しました。');
      showDecided(st);
    }
  }

  // 技術的な実現性（進行役AIの検討）
  function feasView(c, compact) {
    const f = c && c.feas;
    if (!f) return null;
    const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u; } };
    return h(
      'div',
      { class: 'feas ' + f.verdict },
      h('div', { class: 'feashead' }, h('b', {}, '技術的に作れるか'), h('span', { class: 'fv ' + f.verdict }, Engine.FEAS_LABEL[f.verdict] || ''), h('span', { class: 'hint' }, f.searched ? 'Web検索で確認' : 'AIの知識による判断（検索なし）')),
      h('div', { class: 'kv' }, h('b', {}, '締切までに作れる範囲： '), f.mvp || '—'),
      f.later ? h('div', { class: 'kv' }, h('b', {}, '後回しにする範囲： '), f.later) : null,
      compact ? null : f.needs ? h('div', { class: 'kv' }, h('b', {}, '必要なもの： '), f.needs) : null,
      f.risk ? h('div', { class: 'kv' }, h('b', {}, 'つまずきそうな点： '), f.risk) : null,
      !compact && f.sources && f.sources.length ? h('div', { class: 'hint' }, '調べた先： ', f.sources.map((u, i) => [i ? '、' : '', h('a', { href: u, target: '_blank', rel: 'noopener' }, host(u))])) : null
    );
  }

  // 点数の内訳を一言で（以前の形式で保存された会議結果は合計だけ）
  function pointsText(t) {
    if (t.total === undefined) return `${t.score}点`;
    return t.crit === null || t.crit === undefined ? `${t.total}点（支持のみ。評価基準が未設定）` : `${t.total}点（基準 ${t.crit}/70 ＋ 支持 ${t.support}/30）`;
  }

  // ---------- 会議室 ----------
  // ---------- 預けたあとの「待ち」の表示 ----------
  // 預けてから会議が始まるまで、いま何を待っていて、次に何が起きるかを見せる
  function waitCard(inRoom) {
    const snap = S.snap;
    const st = state();
    const me = S.cfg.memberId;
    if (!snap || !snap.brief[me] || st.phase !== 'collecting' || isRunning() || S.busy === 'meeting' || st.error) return null; // 止まっているときは、止まった案内のほうを出す
    const members = Object.entries(snap.member).map(([id, m]) => ({ id, ...m }));
    const total = Math.max(S.teamSize, members.length);
    const done = members.filter((m) => snap.brief[m.id]);
    const yet = members.filter((m) => !snap.brief[m.id]);
    const notJoined = Math.max(0, total - members.length);
    const all = done.length >= total;
    const theme = roomInfo().theme || '';
    const stepNow = all ? 2 : 1;
    const steps = ['考えを預ける', '全員がそろうのを待つ', '代理人どうしの会議', '結果を確認して承認'];
    const dl = roomInfo().deadlineAt || 0;
    const remind = async () => {
      const names = yet.map((m) => m.name + 'さん').join('、');
      const text = `【MeetForMe】${theme ? '「' + theme + '」の会議で、' : ''}${names ? names + 'の' : 'まだの人の'}入力を待っています。アプリを開いて、「① 考えを預ける」で考えを預けてください（5分ほどです）。全員が預けると、AIの代理人どうしの会議が自動で始まります。${dl ? `締切は${fmtDeadline(dl)}です。締切になると、預けた人だけで会議を始めます。` : ''}`;
      try {
        await navigator.clipboard.writeText(text);
        S.notice = 'お願いの文をコピーしました。チャットに貼り付けて送ってください。';
      } catch (e) {
        S.error = 'コピーできませんでした。';
      }
      renderStatus();
    };
    const person = (m, ok) => h('div', { class: 'wp' + (ok ? ' ok' : '') }, avatar(m.id), h('span', { class: 'nm' }, m.name + (m.id === me ? '（自分）' : '')), h('span', { class: 'st' }, ok ? '✓ 預け済み' : '入力待ち'));
    return h(
      'div',
      { class: 'card waitcard', id: 'sec-wait' },
      h('div', { class: 'whead' }, h('span', { class: 'wcheck' }, '✓'), h('div', {}, h('h2', { style: 'margin:0' }, 'あなたの考えを預かりました'), h('div', { class: 'hint' }, all ? '全員がそろいました。まもなく会議が始まります。' : `あと${yet.length + notJoined}人が預けると、代理人どうしの会議が自動で始まります。`))),
      h('div', { class: 'wsteps' }, steps.map((t, i) => h('span', { class: 'wstep' + (i < stepNow ? ' done' : i === stepNow ? ' now' : '') }, (i < stepNow ? '✓ ' : `${i + 1}. `) + t))),
      h('div', { class: 'wpeople' }, done.map((m) => person(m, true)), yet.map((m) => person(m, false)), Array.from({ length: notJoined }, () => h('div', { class: 'wp' }, h('span', { class: 'av none' }, '?'), h('span', { class: 'nm' }, 'まだ参加していない人'), h('span', { class: 'st' }, '招待待ち')))),
      dl && !all ? h('div', { class: 'wdead' }, h('b', {}, `預ける締切：${fmtDeadline(dl)}`), `（${fmtLeft(dl - Date.now())}）`, h('span', {}, dl > Date.now() ? '締切になると、預けた人だけで会議を始めます。' : '代表者のアプリが開いていれば、預けた人だけでまもなく始まります。')) : !all && isLeader() ? h('div', { class: 'hint' }, '待ちが長くなりそうなら、「② 会議と結果」の「お題と評価基準」で預ける締切を決められます。') : null,
      protoWaitHelp(yet),
      window.WEB && window.Notification && Notification.permission === 'default' ? h('div', { class: 'row', style: 'margin:8px 0' }, h('button', { class: 'btn ghost small', onclick: () => { try { Notification.requestPermission().then(() => render()); } catch (e) {} } }, '自分の番が来たら通知を受け取る'), h('span', { class: 'hint' }, 'このページを開いている間だけ届きます。')) : null,
      window.PROTO && yet.length ? null : h('div', { class: 'wlive' }, h('span', { class: 'pulse' }), 'ほかの人の状況を数秒ごとに自動で確認しています。この画面のまま待っていて大丈夫です。'),
      h(
        'div',
        { class: 'wnext' },
        h('b', {}, '待っている間にできること'),
        h(
          'ul',
          { class: 'plain' },
          h('li', {}, '会議が始まると、この画面に代理人どうしのやり取りが流れます。あなたの番が来たら、画面上部の帯' + (canNotify() && !window.PROTO ? 'と通知' : '') + 'でお知らせします。'),
          h('li', {}, '預けた内容は、会議が始まる前ならいつでも直せます。'),
          notJoined ? h('li', {}, isLeader() ? `まだ参加していない人が${notJoined}人います。「設定・招待」の招待コードを送ってください。` : `まだ参加していない人が${notJoined}人います。代表者が招待コードを送るのを待っています。`) : null
        )
      ),
      h(
        'div',
        { class: 'row', style: 'margin-top:12px;flex-wrap:wrap' },
        inRoom ? h('button', { class: 'btn small', onclick: () => { S.tab = 'meeting'; render(); } }, '「② 会議と結果」で様子を見る') : h('button', { class: 'btn small', onclick: () => { S.tab = 'room'; render(); } }, '預けた内容を見直す・手直しする'),
        yet.length || notJoined ? h('button', { class: 'btn ghost small', onclick: remind }, 'まだの人へのお願い文をコピー') : null
      )
    );
  }

  // ---------- データの扱い（はじめの画面と設定に出す） ----------
  function dataNote() {
    return h(
      'ul',
      { class: 'plain datanote', id: 'datanote' },
      h('li', {}, h('b', {}, 'AIに送られるもの：'), '代理人に話した内容と、会議のやり取りは、AIに考えさせるために Anthropic（Claude）へ送られます。'),
      h('li', {}, h('b', {}, '共有されるもの：'), '会議に必要な内容（案、預けた考え、代理人の発言、採点、決定）は、共有の保存先（Supabase）に置かれます。招待コードを知っている人は読めるので、招待コードはメンバー以外に渡さないでください。'),
      h('li', {}, h('b', {}, '決まったら消えるもの：'), '全員が承認して決定すると、預けた本音（好きな点・不安な点・外したくない条件・実装でできること）と、代理人からの確認のやり取りは、共有の保存先から自動で消えます。残るのは、会議で公開された案・発言・採点・決定だけです。'),
      h('li', {}, h('b', {}, 'このPCだけに残るもの：'), '代理人との会話そのものと、名前などの設定は、このPCにだけ保存されます。'),
      h('li', {}, h('b', {}, '消し方：'), '代表者は「設定・招待」から、会議のデータをすべて削除できます。このPCに残った内容は「このPCのデータを消す」で消せます。'),
      h('li', {}, h('b', {}, '入れないでほしいもの：'), 'パスワード、クレジットカード番号、他人の個人情報などは入力しないでください。')
    );
  }

  // 代表者: 決定を取り消して、話し合い（承認待ち）に戻す
  function reopen() {
    run('approve', async () => {
      const st = state();
      if (st.phase !== 'decided') return;
      for (const id of Object.keys(S.snap.approval)) await api.store.del('approval', id);
      await api.store.put('state', 'main', { ...st, phase: 'review', decidedAt: null, decidedCandId: null });
      await api.store.put('msg', 'g' + Date.now().toString(36), { round: st.round, at: Date.now(), speaker: 'system', speakerName: 'システム', type: 'system', text: '代表者が決定を取り消しました。もう一度、承認するか一言返してください。' });
      S.confirmReopen = false;
      S.notice = '決定を取り消しました。全員がもう一度、承認するか一言返せます。';
    });
  }

  // ---------- 会議が途中で止まったとき ----------
  function failCard() {
    const st = state();
    if (!st.error || isRunning() || S.busy === 'meeting' || st.phase === 'decided') return null;
    const resumable = Engine.canResume(S.snap);
    const n = st.ck ? (st.ck.r1 || []).length + (st.ck.merge ? 1 : 0) + (st.ck.feas ? 1 : 0) + (st.ck.r2 || []).length : 0;
    return h(
      'div',
      { class: 'card failcard', id: 'sec-fail' },
      h('h2', {}, '会議が途中で止まりました'),
      h('div', { class: 'kv' }, h('b', {}, '理由： '), st.error),
      h('div', { class: 'hint', style: 'margin-top:6px' }, resumable ? `ここまでの進み（${n}段階）は残っています。「続きから再開する」を押すと、止まったところから進めます。` : st.phase === 'review' ? '前回の推薦案はそのまま残っています。' : '「最初からやり直す」で、会議をもう一度始められます。'),
      canAI()
        ? h(
            'div',
            { class: 'row', style: 'margin-top:12px;flex-wrap:wrap' },
            resumable ? h('button', { class: 'btn', disabled: !!S.busy, onclick: () => startMeeting('resume') }, '続きから再開する') : null,
            !resumable && st.phase === 'review' ? h('button', { class: 'btn', disabled: !!S.busy, onclick: () => startMeeting('rerun') }, 'もう一度試す') : null,
            h('button', { class: 'btn' + (resumable || st.phase === 'review' ? ' ghost' : ''), disabled: !!S.busy, onclick: () => startMeeting('full') }, '最初からやり直す'),
            h('button', { class: 'btn ghost', disabled: !!S.busy, onclick: () => { S.tab = 'settings'; S.openTools = true; render(); } }, '接続を診断する')
          )
        : h('div', { class: 'hint', style: 'margin-top:8px' }, '代表者のアプリで「続きから再開する」を押すと進みます。')
    );
  }

  function viewMeeting() {
    const snap = S.snap;
    const st = state();
    const members = Object.entries(snap.member).map(([id, m]) => ({ id, ...m }));
    const deposited = members.filter((m) => snap.brief[m.id]);
    const wrap = h('div', { class: 'wrap' });
    const running = st.runner && Date.now() - (st.runnerAt || 0) < Engine.LOCK_MS;

    // 決定
    if (st.phase === 'decided' && snap.cand[st.decidedCandId]) wrap.append(decidedCard(st));

    if (running) wrap.append(liveCard(st));
    const fc = failCard();
    if (fc) wrap.append(fc);

    const qb = questionsBox();
    if (qb) wrap.append(qb);

    // いまの状況（メンバー）
    const statusCard = h(
      'div',
      { class: 'card' },
      h('h2', {}, `メンバー（預けた人 ${deposited.length} / ${Math.max(S.teamSize, members.length)}）`),
      h('div', { class: 'members' }, members.map((m) => h('span', { class: 'chip' + (snap.brief[m.id] ? ' ok' : '') }, `${m.name}${m.id === S.cfg.memberId ? '（自分）' : ''}：${snap.brief[m.id] ? '預け済み' : 'まだ'}`))),
      st.phase === 'collecting' && !running
        ? h(
            'div',
            { class: 'row', style: 'margin-top:12px;align-items:center' },
            h('button', { class: 'btn', disabled: !!S.busy || deposited.length < 2, onclick: () => startMeeting('full') }, deposited.length >= S.teamSize ? '会議を始める' : `預けた${deposited.length}人だけで会議を始める`),
            h('span', { class: 'hint' }, deposited.length < 2 ? '2人以上が預けると始められます。' : '全員が預けると自動で始まります。待てないときは今いる人だけで始められます。')
          )
        : null
    );
    if (st.phase === 'collecting') {
      const wc = waitCard(false);
      if (wc) wrap.append(wc);
      wrap.append(statusCard);
      wrap.append(topicCard());
    }

    // 推薦
    const rec = st.recommendation;
    if (rec && snap.cand[rec.topId] && st.phase !== 'collecting' && st.phase !== 'decided') {
      const top = snap.cand[rec.topId];
      const parts = st.participants || [];
      const myOk = snap.approval[S.cfg.memberId] && snap.approval[S.cfg.memberId].round === st.round;
      const iAmIn = parts.includes(S.cfg.memberId);
      wrap.append(
        h(
          'div',
          { class: 'card rec', id: 'sec-rec' },
          h(
            'div',
            { class: 'recgrid' },
            h(
              'div',
              { class: 'recmain' },
              h('div', { class: 'eyebrow' }, `代理人たちの推薦案（第${st.round}回の議論）`),
              h('div', { class: 'big' }, top.title, top.origin === 'merged' ? h('span', { class: 'tag mix' }, '合体案') : null, top.origin === 'ai' ? h('span', { class: 'tag new' }, 'AIの新案') : null),
              h('div', { class: 'recsum' }, top.summary),
              scoreTiles(rec, top),
              // 結論だけを先に見せる。理由は最初の1文、次点との差は1行。くわしい内訳は下の「くわしく見る」に入れる
              h('div', { class: 'reason1' }, h('b', {}, '理由： '), firstSentence(rec.reason)),
              gapLine(rec),
              rec.tie && snap.cand[rec.runnerUpId] ? h('div', { class: 'q', style: 'margin-top:10px' }, h('p', {}, rec.unstable ? `2回の採点で、「${snap.cand[rec.runnerUpId].title}」と1位が入れ替わりました。僅差として扱います。` : `「${snap.cand[rec.runnerUpId].title}」と評価が並んでいます。${rec.conflict ? '対立点：' + rec.conflict : ''}`)) : null
            ),
            h(
              'div',
              { class: 'recside' },
              st.phase === 'review' && iAmIn && !myOk ? h('span', { class: 'pill' }, 'あなたの番') : null,
              h('div', { class: 'todo-t' }, myOk ? 'あなたは承認済みです' : iAmIn ? 'この案でいいですか？' : '承認の状況'),
              h('div', { class: 'hint' }, '全員が承認すると決定です。'),
              st.phase === 'review' && iAmIn
                ? [
                    h('button', { class: 'btn big block', disabled: !!S.busy || myOk || running, onclick: approve }, myOk ? '承認済み' : 'この案を承認する'),
                    (S.open = S.open || {}).say
                      ? h(
                          'div',
                          {},
                          h('label', { for: 'sayback', style: 'margin-top:4px' }, '承認せず一言返す'),
                          draftArea('comment', { id: 'sayback', placeholder: '例：方向はいいけど、ターゲットは高校生じゃなくて大学生にしたい' }),
                          h('div', { class: 'row end' }, h('button', { class: 'btn ghost small', onclick: () => { S.open.say = false; render(); } }, 'やめる'), h('button', { class: 'btn small', disabled: !!S.busy || running, onclick: () => tellAgent('comment') }, '代理人に伝えて議論をやり直す'))
                        )
                      : h('button', { class: 'btn ghost block', disabled: !!S.busy || running, onclick: () => { S.open.say = true; render(); } }, '承認せず、一言返す'),
                    h('div', { class: 'hint', style: 'margin-top:10px' }, '別の案にしたいとき：'),
                    ...otherPickable().map((c) => (S.wantConfirm === c.id + ':side'
                      ? h('div', { class: 'q', style: 'margin-top:6px' }, h('p', {}, `推薦を「${c.title}」に変えます。これまでの承認はやり直しになります。`), h('div', { class: 'row end' }, h('button', { class: 'btn ghost small', onclick: () => { S.wantConfirm = ''; render(); } }, 'やめる'), h('button', { class: 'btn small', disabled: !!S.busy, onclick: () => adoptCand(c) }, '採用する')))
                      : h('button', { class: 'btn ghost block', style: 'margin-top:6px;text-align:left', disabled: !!S.busy || running, onclick: () => { S.wantConfirm = c.id + ':side'; render(); } }, `「${c.title}」を採用する`))),
                  ]
                : null,
              approvalRow(st),
              protoApproveHelp(st)
            )
          ),
          (() => {
            S.open = S.open || {};
            const d = h(
              'details',
              { class: 'more', open: !!S.open.recmore },
              h('summary', {}, 'くわしく見る（理由の全文・次点との差の内訳・案の中身・実装の進め方）'),
              h('h3', {}, 'なぜこの案か'),
              h('div', { class: 'reason' }, paras(rec.reason)),
              gapView(rec),
              partsView(top),
              feasView(top, true),
              rec.influences && rec.influences.length ? h('div', {}, h('h3', {}, '誰のどの意見が効いたか'), h('ul', { class: 'plain' }, rec.influences.map((i) => h('li', {}, h('b', {}, i.name + '： '), i.point)))) : null,
          rec.plan && (rec.plan.steps || (rec.plan.roles || []).length)
            ? h('div', {}, h('h3', {}, '実装の進め方（案）'), rec.plan.steps ? h('div', { style: 'line-height:1.7' }, rec.plan.steps) : null, (rec.plan.roles || []).length ? h('ul', { class: 'plain' }, rec.plan.roles.map((r) => h('li', {}, h('b', {}, r.name + '： '), r.role))) : null)
            : null
            );
            d.addEventListener('toggle', () => { S.open.recmore = d.open; });
            return d;
          })()
        )
      );
    }

    // 案の一覧と評価
    const cands = Object.entries(snap.cand).map(([id, c]) => ({ id, ...c })).sort((a, b) => (a.order || 0) - (b.order || 0));
    if (cands.length) {
      const table = rec ? Object.fromEntries(rec.table.map((t) => [t.candId, t])) : {};
      const card = (c) => {
        const t = table[c.id];
        const owner = c.origin === 'ai' ? '進行役AIが出した、メンバーの案とは別の新しい案' : c.origin === 'merged' ? '合体元：' + (c.from || []).map((f) => (snap.cand[f] || {}).title || '?').join(' ＋ ') : '提案：' + (c.owners || []).map((o) => (snap.member[o] || {}).name || '?').join('・');
        const evs = (st.participants || []).map((pid) => ({ pid, ev: snap.eval[`${pid}__${c.id}`] })).filter((x) => x.ev);
        return h(
          'div',
          { class: 'cdetail' },
          t ? h('div', { class: 'cpts' }, pointsText(t) + (t.excluded ? '・対象外（' + t.excluded + '）' : '')) : null,
          h('div', { class: 'hint' }, owner + (c.dropped ? `　／　外した理由：${c.dropReason}（部品としては残しています）` : '')),
          c.summary ? h('div', { style: 'margin-top:4px' }, c.summary) : null,
          partsView(c),
          c.why ? h('div', { class: 'hint', style: 'margin-top:6px' }, (c.origin === 'ai' ? 'この案を足した理由：' : '組み合わせの狙い：') + c.why) : null,
          feasView(c, false),
          (() => {
            const ok = st.phase === 'review' && (st.participants || []).includes(S.cfg.memberId) && c.id !== (rec && rec.topId) && !c.dropped && !(t && t.excluded) && !isRunning();
            if (!ok) return null;
            if (S.wantConfirm === c.id + ':adopt') return h('div', { class: 'row end', style: 'margin-top:10px;align-items:center' }, h('span', { class: 'hint', style: 'flex:1' }, `推薦を「${c.title}」に変えます。これまでの承認はやり直しになります。`), h('button', { class: 'btn ghost small', onclick: () => { S.wantConfirm = ''; render(); } }, 'やめる'), h('button', { class: 'btn small', disabled: !!S.busy, onclick: () => adoptCand(c) }, 'この案を採用する'));
            if (S.wantConfirm === c.id) return h('div', { class: 'row end', style: 'margin-top:10px;align-items:center' }, h('span', { class: 'hint', style: 'flex:1' }, `「${c.title}」を推すと代理人に伝えて、議論をやり直します。`), h('button', { class: 'btn ghost small', onclick: () => { S.wantConfirm = ''; render(); } }, 'やめる'), h('button', { class: 'btn small', disabled: !!S.busy, onclick: () => wantCand(c) }, '伝えてやり直す'));
            return h('div', { class: 'row end', style: 'margin-top:10px' }, h('button', { class: 'btn ghost small', disabled: !!S.busy, onclick: () => { S.wantConfirm = c.id; render(); } }, 'この案で議論をやり直す'), h('button', { class: 'btn small', disabled: !!S.busy, onclick: () => { S.wantConfirm = c.id + ':adopt'; render(); } }, 'この案を採用する'));
          })(),
          t && t.marks && t.marks.length
            ? h('div', { class: 'fit' }, h('b', {}, '評価基準ごとの採点（進行役AI）'), h('div', { class: 'marks' + (t.marks.some((m) => m.note) ? ' rows' : '') }, t.marks.map((m) => h('div', { class: 'mkrow' }, h('span', { class: 'mk s' + Math.round(m.score) }, `${m.name}${m.weight !== 1 ? ' ×' + m.weight : ''}：${m.score}/5`), m.spread ? h('span', { class: 'mkspread', title: '2回採点した結果に差がありました。平均を使っています' }, `2回の差 ${m.spread}`) : null, m.note ? h('span', { class: 'mknote' }, m.note) : null))), t.comment ? h('div', { class: 'hint' }, t.comment) : null)
            : null,
          evs.length && evs.every((x) => x.ev.basis !== 'stated')
            ? h('div', { class: 'hint guessnote' }, 'この案への支持は、すべて代理人の推測です（本人の意見はまだ入っていません）。承認の前に、自分の考えと合っているか確かめてください。')
            : null,
          evs.length
            ? h('div', { class: 'evals' }, evs.map(({ pid, ev }) =>
                h('div', { class: 'ev' }, h('span', {}, `${(snap.member[pid] || {}).name || '?'}の代理人`), h('span', { class: 'r-s' + Engine.evalScore(ev) }, `${Engine.SUPPORT_LABEL[Engine.evalScore(ev)]}（${Engine.evalScore(ev)}/5）`), h('span', {}, ev.reason, ev.basis !== 'stated' ? h('span', { class: 'tag ai' }, '代理人の推測・重み半分') : h('span', { class: 'tag me' }, '本人の話に基づく')))
              ))
            : null
        );
      };
      // 1案を1行にまとめた表。点数の高い順に並べ、行を押すと詳細が開く
      const who = (c) => (c.origin === 'ai' ? '進行役AI' : c.origin === 'merged' ? '進行役AIが組み合わせた案' : (c.owners || []).map((o) => (snap.member[o] || {}).name || '?').join('・'));
      const rank = (c) => {
        const t = table[c.id];
        if (c.dropped) return 3e6 + (c.order || 0);
        if (!t) return 1e6 + (c.order || 0);
        if (t.excluded) return 2e6 - (t.total || 0);
        return -(t.total === undefined ? t.score || 0 : t.total);
      };
      const sorted = cands.slice().sort((a, b) => rank(a) - rank(b));
      const anyFeas = cands.some((c) => c.feas);
      let no = 0;
      const row = (c) => {
        const t = table[c.id];
        const out = c.dropped || (t && t.excluded);
        const total = t ? (t.total === undefined ? t.score : t.total) : null;
        const isTop = c.id === (rec && rec.topId);
        const key = 'c:' + c.id;
        S.open = S.open || {};
        // 一覧の各行から、そのまま「本命にする」を押せるようにする（行の開閉は動かさない）
        const canPick = st.phase === 'review' && (st.participants || []).includes(S.cfg.memberId) && !isTop && !out && !!t && !isRunning();
        const stop = (e, f) => { e.preventDefault(); e.stopPropagation(); f(); };
        const pick = !canPick
          ? null
          : S.wantConfirm === c.id + ':row'
            ? h('div', { class: 'rowpick' }, h('span', { class: 'hint' }, '推薦をこの案に変えます。承認はやり直しです。'), h('button', { class: 'btn ghost small', onclick: (e) => stop(e, () => { S.wantConfirm = ''; render(); }) }, 'やめる'), h('button', { class: 'btn small', disabled: !!S.busy, onclick: (e) => stop(e, () => adoptCand(c)) }, '本命にする（確定）'))
            : h('div', { class: 'rowpick' }, h('button', { class: 'btn ghost small', disabled: !!S.busy, onclick: (e) => stop(e, () => { S.wantConfirm = c.id + ':row'; render(); }) }, '本命にする'));
        const d = h(
          'details',
          { class: 'crow' + (out ? ' out' : '') + (isTop ? ' top' : ''), open: !!S.open[key] },
          h(
            'summary',
            {},
            h('span', { class: 'cno' }, out ? '—' : total === null ? '・' : String(++no)),
            h('span', { class: 'cmain' }, h('span', { class: 'cttl' }, c.title, isTop ? h('span', { class: 'tag push' }, '推薦') : null, c.origin === 'merged' ? h('span', { class: 'tag mix' }, '合体案') : null, c.origin === 'ai' ? h('span', { class: 'tag new' }, 'AIの新案') : null, out ? h('span', { class: 'tag out' }, c.dropped ? '本人が取り下げ' : '対象外') : null), h('span', { class: 'cwho' }, who(c)), pick),
            total === null ? h('span', { class: 'cscore none' }, c.dropped ? '採点しません' : '採点前') : h('span', { class: 'cscore' }, h('span', { class: 'cbar' }, h('i', { style: `width:${Math.max(0, Math.min(100, total))}%` })), h('b', {}, String(total)), h('small', {}, '点')),
            anyFeas ? h('span', { class: 'cfeas' + (c.feas ? ' f-' + c.feas.verdict : '') }, c.feas ? Engine.FEAS_LABEL[c.feas.verdict] || '—' : out ? '—' : '未調査') : null,
            h('span', { class: 'cchev' }, '')
          ),
          card(c)
        );
        d.addEventListener('toggle', () => { S.open[key] = d.open; });
        return d;
      };
      const nMember = cands.filter((c) => c.origin !== 'merged' && c.origin !== 'ai').length;
      const nMerged = cands.filter((c) => c.origin === 'merged').length;
      const nAi = cands.filter((c) => c.origin === 'ai').length;
      wrap.append(
        fold(
          'cands',
          `すべての案をくらべる（${cands.length}案）`,
          !(rec && st.phase !== 'collecting'),
          h('div', { class: 'csum' }, h('span', {}, `メンバーの案 ${nMember}`), nMerged ? h('span', {}, `＋ 合体案 ${nMerged}`) : null, nAi ? h('span', {}, `＋ AIの新案 ${nAi}`) : null, h('span', { class: 'hint' }, '出された案は1つずつ候補になります。進行役AIが、相性のよい案を組み合わせた合体案と、新しい案を足して、まとめて採点します。')),
          h('div', { class: 'chead' }, h('span', { class: 'cno' }, '順位'), h('span', { class: 'cmain' }, '案（提案した人）'), h('span', { class: 'cscore' }, '点数（100点満点）'), anyFeas ? h('span', { class: 'cfeas plain' }, '実現性') : null, h('span', { class: 'cchev plain' }, '')),
          sorted.map(row),
          h('div', { class: 'hint', style: 'margin-top:10px' }, '行を押すと、案の中身・採点の内訳・各代理人の意見が開きます。100点満点で、お題と評価基準への合い方が70点（進行役AIが基準ごとに5段階で採点）、メンバーの支持が30点（各代理人が5段階。推測による評価は重み半分）です。本人が「嫌」と言った案と、元の案より点が低い合体案は対象外です。評価基準が未設定のときは、支持だけで100点に換算します。')
        )
      );
    }

    if (st.phase !== 'collecting') {
      wrap.append(statusCard);
      wrap.append(topicCard());
    }

    const cf = callsFold();
    if (cf) wrap.append(cf);

    // ログ
    const msgs = Engine.sortedMsgs(snap);
    wrap.append(
      fold(
        'log',
        `会議のログ（${msgs.filter((m) => m.type !== 'system').length}件の発言）`,
        false,
        msgs.length
          ? h('div', { class: 'log' }, msgs.map(msgRow))
          : h('div', { class: 'hint' }, 'まだ会議は始まっていません。全員が「① 考えを預ける」で考えを預けると、代理人どうしの会議が始まります。'),
        st.phase === 'review'
          ? h('div', { class: 'row end' }, h('button', { class: 'btn ghost small', disabled: !!S.busy || running, onclick: () => startMeeting('full') }, '最初から会議をやり直す'))
          : st.phase === 'decided' ? h('div', { class: 'hint' }, '決定したので、預けた本音は共有の保存先から消しました。やり直すときは、代表者が「決定を取り消す」を押してください（各自のアプリから自動で預け直されます）。')
          : null
      )
    );
    return wrap;
  }

  // ---------- 設定 ----------
  // はじめの画面（会議を作る／招待コードで参加する）と、参加後の設定
  const INVITE_PREFIX = 'AIDK1.';
  const encodeInvite = (o) => INVITE_PREFIX + btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // 短い招待コード: 会議の番号そのもの（8文字。まぎらわしい 0・1・I・O は使わない）。接続先はアプリに入っているものを使う
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const SHORT_RE = /^[A-HJ-NP-Z2-9]{8}$/;
  const newRoomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => CODE_CHARS[b % 32]).join('');
  const showCode = (r) => r.slice(0, 4) + '-' + r.slice(4);
  const sameDb = (u, k) => !!S.cfg.dbDefault && S.cfg.dbDefault.url === u && S.cfg.dbDefault.key === k;
  function decodeInvite(text) {
    const t = String(text || '').replace(/\s+/g, '');
    if (!t.startsWith(INVITE_PREFIX)) {
      // 全角で貼られたり、ハイフンが抜けたりしていても読む
      const c = t.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!SHORT_RE.test(c)) throw new Error('招待コードの形が違います。「K7M2-9QXD」のような8文字を入れてください（0・1・I・O は使いません）。');
      if (!S.cfg.dbDefault) throw new Error('このアプリには会議の接続先が入っていないので、短い招待コードは使えません。代表者に長い招待コード（AIDK1.…）を送ってもらってください。');
      return { r: c, u: S.cfg.dbDefault.url, k: S.cfg.dbDefault.key };
    }
    try {
      const o = JSON.parse(decodeURIComponent(escape(atob(t.slice(INVITE_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/')))));
      if (!o || !o.r) throw new Error('no room');
      return o;
    } catch (e) {
      throw new Error('招待コードを読み取れませんでした。もう一度コピーして貼り付けてください。');
    }
  }
  const isShort = () => SHORT_RE.test(S.cfg.room || '') && sameDb(S.cfg.supabaseUrl, S.cfg.supabaseKey);
  const inviteCode = () => (isShort() ? showCode(S.cfg.room) : encodeInvite({ r: S.cfg.room, u: S.cfg.supabaseUrl || '', k: S.cfg.supabaseKey || '' }));
  const val = (id) => ($(id) ? $(id).value.trim() : '');
  // 評価基準の見本（代表者が何を書けばいいか迷わないように。押すと入力欄に入り、そのあと自由に直せる）
  const CRIT_TEMPLATES = [
    ['ハッカソン・コンテスト', 'テーマに合っているか\n新しさがあるか ×2\n完成度・実際に動くか\nプレゼンで伝わるか'],
    ['授業・発表のテーマ', '課題の条件に合っているか\n調べる材料が手に入るか\n期間内にまとめきれるか\n聞く人が興味を持てるか'],
    ['イベント・企画', '参加する人が楽しめるか ×2\n予算に収まるか\n準備の手間が少ないか\n当日の運営が回るか'],
    ['行き先・お店', '全員が行ける日程・場所か ×2\n予算に収まるか\nやりたいことができるか\n体力や好みに無理がないか'],
  ];
  const critTemplateRow = (apply) =>
    h('div', { class: 'tplrow' }, h('span', { class: 'hint' }, '見本から入れる：'), CRIT_TEMPLATES.map(([name, text]) => h('button', { class: 'btn ghost small', type: 'button', onclick: () => apply(text) }, name)));
  // 締切（預ける締切）の表示と入力
  const pad2 = (n) => String(n).padStart(2, '0');
  const toLocalInput = (ms) => { if (!ms) return ''; const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  const fromLocalInput = (v) => { const t = v ? new Date(v).getTime() : 0; return Number.isFinite(t) ? t : 0; };
  const fmtDeadline = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}（${'日月火水木金土'[d.getDay()]}）${d.getHours()}:${pad2(d.getMinutes())}`; };
  const fmtLeft = (ms) => { const m = Math.round(ms / 60000); return m <= 0 ? '締切を過ぎました' : m < 60 ? `あと${m}分` : m < 60 * 48 ? `あと${Math.floor(m / 60)}時間${m % 60 ? (m % 60) + '分' : ''}` : `あと${Math.floor(m / 1440)}日`; };
  const field = (id, label, attrs, hint) => [h('label', { for: id }, label), attrs && attrs.rows ? h('textarea', { id, ...attrs }) : h('input', { id, type: 'text', ...attrs }), hint ? h('div', { class: 'hint' }, hint) : null];
  const fail = (msg) => {
    S.error = msg;
    renderStatus();
  };
  // 自分のAPIキーと見本モードは、ふだん使わないので設定の「上級者向け」にだけ置く（AIは会議のサーバー経由で動く）
  const aiFields = (prefix) => [
    window.WEB ? null : field(prefix + 'key', '自分のClaude APIキー', { type: 'password', placeholder: S.cfg.hasApiKey ? '設定済み（変えるときだけ入力）' : 'sk-ant-…（入れなくても動きます）' }, 'サーバー経由のAIが使えないときの予備です。入れると、このPCではサーバーを通らず、このキーでAIを呼びます。キーはこのPCにだけ暗号化して保存され、ほかのメンバーには送られません。'),
    S.cfg.hasApiKey ? h('label', { class: 'check' }, h('input', { id: prefix + 'keyoff', type: 'checkbox' }), ' 保存してあるAPIキーを消して、サーバー経由に戻す') : null,
    h('label', { class: 'check', style: 'margin-top:14px' }, h('input', { id: prefix + 'demo', type: 'checkbox', checked: !!S.cfg.demo }), ' 見本モード：決まった見本の応答で画面を試す'),
    h('div', { class: 'hint' }, '見本モードの応答は本物のAIではありません。画面の流れを費用なしで確かめるためのものです（自分のAPIキーが入っているときは働きません）。'),
  ];

  async function createMeeting() {
    const name = val('c-name');
    const theme = val('c-theme');
    if (!name || !theme) return fail('あなたの名前とテーマを入力してください。');
    const patch = { name, room: '', supabaseUrl: val('c-surl'), supabaseKey: val('c-skey') };
    // アプリに入っている接続先で作る会議は、番号（8文字）がそのまま招待コードになる
    patch.room = sameDb(patch.supabaseUrl, patch.supabaseKey) ? newRoomCode() : 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    if (patch.supabaseUrl || patch.supabaseKey) {
      // 別々のPCから入れる会議にするときは、先に読み書きできるか確かめる
      S.progress = '共有データベースにつながるか確かめています';
      S.busy = 'check';
      renderStatus();
      const t = await api.testDb(patch.supabaseUrl, patch.supabaseKey);
      S.busy = '';
      S.progress = '';
      if (!t.ok) return fail(t.msg);
    }
    S.error = '';
    const prev = S.cfg.room;
    S.cfg = await api.saveConfig(patch);
    resetView();
    await enterRoom();
    if (S.netError) {
      const why = S.netError;
      S.cfg = await api.saveConfig({ removeRoom: patch.room, room: prev || '' });
      S.netError = '';
      if (S.cfg.room) await enterRoom();
      return fail('共有データベースにつながりませんでした。URLとキーを確かめてください。（' + why + '）');
    }
    await api.store.put('room', 'main', { teamSize: Math.max(2, parseInt(val('c-size'), 10) || 3), theme, criteria: val('c-criteria'), conditions: val('c-cond'), deadlineAt: fromLocalInput(val('c-deadline')), leaderId: S.cfg.memberId, createdAt: Date.now() });
    S.cfg = await api.saveConfig({ roomTitle: theme });
    await refresh();
    S.startMode = '';
    S.tab = 'settings';
    S.notice = '会議を作りました。下の招待コードをメンバーに送ってください。';
    render();
  }

  async function joinMeeting() {
    const name = val('j-name');
    if (!name) return fail('あなたの名前を入力してください。');
    let inv;
    try {
      inv = decodeInvite(val('j-code'));
    } catch (e) {
      return fail(e.message);
    }
    if (roomList().some((r) => r.room === inv.r)) {
      await switchRoom(inv.r);
      S.notice = 'この会議にはすでに参加しています。切り替えました。';
      return renderStatus();
    }
    const patch = { name, room: inv.r, supabaseUrl: inv.u || '', supabaseKey: inv.k || '' };
    S.error = '';
    const prev = S.cfg.room;
    S.cfg = await api.saveConfig(patch);
    resetView();
    // 代表者に外されたことがある人が、招待コードで入り直すとき：「外した人」の印を消して、人数を1人戻す
    try {
      const snap0 = await Engine.snapshot(api.store);
      const r0 = snap0.room && snap0.room.main;
      if (r0 && (r0.removed || []).includes(S.cfg.memberId)) {
        await api.store.put('room', 'main', { ...r0, removed: r0.removed.filter((x) => x !== S.cfg.memberId), teamSize: Math.min(12, (r0.teamSize || S.teamSize) + 1) });
      }
    } catch (e) {}
    await enterRoom();
    const missing = !S.netError && !(S.snap.room && S.snap.room.main);
    if (S.netError || missing) {
      const why = S.netError;
      if (missing) await api.store.del('member', S.cfg.memberId).catch(() => {});
      S.cfg = await api.saveConfig({ removeRoom: patch.room, room: prev || '' });
      S.netError = '';
      if (S.cfg.room) await enterRoom();
      return fail(missing ? 'この招待コードの会議が見つかりませんでした。代表者が会議を作り直していないか確かめてください。' : '共有データベースにつながりませんでした。（' + why + '）');
    }
    S.startMode = '';
    S.tab = 'room';
    S.notice = `「${S.snap.room.main.theme || '会議'}」に参加しました。「① 考えを預ける」で、代理人に考えを話してください。`;
    render();
  }

  function viewStart() {
    const back = h('button', { class: 'btn ghost', onclick: () => { S.startMode = ''; S.error = ''; render(); } }, ready() ? 'やめる' : 'もどる');
    if (S.startMode === 'create') {
      return h(
        'div',
        { class: 'wrap' },
        h(
          'div',
          { class: 'card' },
          h('h2', {}, '会議を作る（代表者）'),
          h('div', { class: 'hint' }, 'ここで入れた内容は、参加したメンバー全員に共有されます。あとから「② 会議と結果」で直せます。'),
          field('c-name', 'あなたの名前', { value: S.cfg.name || '', placeholder: '例：りょうま' }),
          field('c-theme', 'テーマ（何を決める会議か）', { placeholder: '例：かゆいところに手が届くアプリ' }),
          field('c-criteria', '評価基準（1行に1つ。重みを付けたい基準は、行の最後に「×2」）', { rows: 4, placeholder: 'テーマに合っているか\n新しさがあるか ×2\n完成度・実際に動くか\nプレゼンで伝わるか' }, '点数の70点分は、この基準ごとの採点で決まります。空欄だと「テーマに合っているか」だけで採点します。'),
          critTemplateRow((text) => { const el = $('c-criteria'); if (el) el.value = text; }),
          field('c-deadline', '預ける締切（任意）', { type: 'datetime-local' }, 'この時刻になると、まだ預けていない人がいても、預けた人だけ（2人以上）で会議を自動で始めます。空欄なら全員を待ちます。'),
          field('c-cond', 'そのほかの条件（任意）', { placeholder: '例：3人チーム、開発期間は7日間、11/18締切' }),
          field('c-size', 'メンバーの人数（代表者を含む）', { type: 'number', min: '2', max: '12', value: '3' }, 'この人数が預け終わると、会議が自動で始まります。'),
          (() => {
            const fields = [
              field('c-surl', 'Project URL', { value: S.cfg.dbDefault ? S.cfg.dbDefault.url : S.cfg.supabaseUrl || '', placeholder: 'https://xxxx.supabase.co' }),
              field('c-skey', 'APIキー（publishable または anon）', { value: S.cfg.dbDefault ? S.cfg.dbDefault.key : S.cfg.supabaseKey || '', placeholder: 'sb_publishable_…' }),
            ];
            if (S.cfg.dbDefault) {
              // 接続先はアプリに入っているので、ふだんは見せない
              return [
                h('div', { class: 'hint', style: 'margin-top:16px' }, '会議を作ると、8文字の招待コードができます。メンバーはそのコードだけで、別のPCから参加できます。'),
                h('details', { class: 'more', id: 'c-more' }, h('summary', {}, '接続先を変える（ふつうは不要）'), h('div', { class: 'hint', style: 'margin-top:8px' }, '自分のSupabaseを使うときだけ書き換えます（招待コードは長い形式になります）。2つとも空にすると、このPCの中だけで試す会議になります。'), fields),
              ];
            }
            return [
              h('h3', { style: 'margin-top:20px' }, '共有データベース（任意）'),
              h('div', { class: 'hint' }, '招待コードを送って別のPCから参加してもらうには、ここにSupabaseのURLとキーを入れます。空欄のままだと、このPCの中だけで試す会議になります（同じPCで別人として起動して試せます）。'),
              fields,
            ];
          })(),
          h('div', { class: 'row end', style: 'margin-top:16px' }, back, h('button', { class: 'btn', onclick: createMeeting }, '会議を作る'))
        )
      );
    }
    if (S.startMode === 'login') {
      const doLogin = async () => {
        const raw = val('l-link').trim();
        const m = /[#&]?take=([^&\s]+)/.exec(raw);
        const code = m ? decodeURIComponent(m[1]) : raw;
        if (!code) return fail('ログイン用のリンクを貼り付けてください。');
        S.error = '';
        try {
          await takeOver(code);
        } catch (e) {
          S.error = 'ログインに失敗しました。（' + errText(e) + '）';
        }
        render();
      };
      return h(
        'div',
        { class: 'wrap' },
        h(
          'div',
          { class: 'card' },
          h('h2', {}, 'ログイン（続きから入る）'),
          h('div', { class: 'hint' }, 'すでに会議に参加している人が、別の端末やブラウザで同じ人として入り直すための画面です。パスワードはありません。かわりに、前の端末で作った「引き継ぎリンク」を使います。'),
          field('l-link', '引き継ぎリンク', { placeholder: 'https://…/#take=…（貼り付け）', autocomplete: 'off', spellcheck: 'false' }, 'リンクは、前の端末の「設定・招待」→「引き継ぎリンクを作る」で作れます。本人だけに送ってください。'),
          h('div', { class: 'row end', style: 'margin-top:16px' }, back, h('button', { class: 'btn', onclick: doLogin }, 'ログインする'))
        )
      );
    }
    if (S.startMode === 'join') {
      return h(
        'div',
        { class: 'wrap' },
        h(
          'div',
          { class: 'card' },
          h('h2', {}, '招待コードで参加する'),
          field('j-name', 'あなたの名前', { value: S.cfg.name || '', placeholder: '例：あおい' }),
          field('j-code', '招待コード', { value: S.joinCode || '', placeholder: '例：K7M2-9QXD（代表者から送られてきた8文字）', autocomplete: 'off', spellcheck: 'false' }),
          h('div', { class: 'hint', style: 'margin-top:8px' }, '入力はこの2つだけです。参加すると、あなたの代理人と1対1で話す画面が開きます。'),
          h('div', { class: 'row end', style: 'margin-top:16px' }, back, h('button', { class: 'btn', onclick: joinMeeting }, '参加する'))
        )
      );
    }
    return h(
      'div',
      { class: 'wrap' },
      h(
        'div',
        { class: 'hero2' },
        h('div', { class: 'eyebrow' }, '集まる時間が合わないチームへ'),
        h('h2', { class: 'herotitle' }, 'AIの代理人が、あなたのかわりに', h('br', {}), '「どの案にするか」を話し合います'),
        h('p', { class: 'herolead' }, 'あなたは代理人に考えを話すだけ。会議は、あなたが留守の間に、代理人どうしで進みます。'),
        h('p', { class: 'herofor' }, '集まれるなら、集まって話すのが一番です。これは、集まりたいのに時間が合わないチームのための道具です。全員の考えが、声の大きさに関係なく同じ重さで会議に入ります。'),
        h('p', { class: 'heroterm' }, h('b', {}, '代理人'), '＝あなたの考えを預かり、MeetForMeで話すAI。', h('b', {}, '預ける'), '＝代理人に、自分の案と本音を伝えること。最後に決めるのは人間です（全員の承認で決定）。'),
        h(
          'div',
          { class: 'stepcards' },
          [[1, '考えを預ける', '自分の代理人に、案と本音を話します。', '約5分'], [2, '代理人どうしが会議', '全員が預けると自動で始まり、推薦案が出ます。', '数分・見ているだけ'], [3, '承認して決定', '推薦案を見て、全員が承認すれば決まりです。', '約1分']].map(([n, title, text, time]) =>
            h('div', { class: 'stepcard' }, h('div', { class: 'num' }, String(n)), h('div', { class: 'st-t' }, title), h('div', { class: 'st-x' }, text), h('div', { class: 'st-m' }, time))
          )
        )
      ),
      h(
        'div',
        { class: 'choices' },
        h('div', { class: 'card choice' }, h('h2', {}, '会議を作る'), h('div', { class: 'hint' }, '代表者として、テーマ・評価基準・人数を決めて会議を作ります。できた招待コードをメンバーに送ります。'), h('button', { class: 'btn big', onclick: () => { S.startMode = 'create'; render(); } }, '代表者として始める')),
        h('div', { class: 'card choice' }, h('h2', {}, '招待コードで参加する'), h('div', { class: 'hint' }, '代表者から送られてきた招待コードを貼り付けて、会議に参加します。入力は名前と招待コードだけです。'), h('button', { class: 'btn ghost big', onclick: () => { S.startMode = 'join'; render(); } }, 'メンバーとして参加する'))
      ),
      h('div', { class: 'loginrow' }, h('span', {}, 'すでに参加している人は'), h('button', { class: 'btn ghost', onclick: () => { S.startMode = 'login'; S.error = ''; render(); } }, 'ログイン（続きから）')),
      h('details', { class: 'more startnote' }, h('summary', {}, 'データの扱い（入力した内容がどこへ行くか）'), dataNote())
    );
  }

  function viewSettings() {
    if (!ready() || S.startMode) return viewStart();
    const r = roomInfo();
    const leader = (S.snap.member[r.leaderId] || {}).name || '';
    const ai = S.cfg.hasApiKey ? '自分のAPIキーを使用' : S.cfg.demo ? '見本モード（決まった見本の応答。本物のAIではありません）' : S.cfg.serverAi ? '使えます（会議のサーバー経由。設定は不要です）' : '使えません（フォームで預け、会議は代表者のアプリが進めます）';
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(inviteCode());
        S.notice = '招待コードをコピーしました。メンバーに送ってください。';
      } catch (e) {
        S.error = 'コピーできませんでした。枠の中の文字を選んでコピーしてください。';
      }
      renderStatus();
    };
    // Web版: 開くだけで招待コードが入るリンク（コードは # の後ろに置くので、サーバーには送られない）
    const joinLink = () => location.origin + location.pathname + '#join=' + encodeURIComponent(inviteCode());
    const copyInvite = async () => {
      const text = window.WEB
        ? [
            `【MeetForMe】${r.theme ? '「' + r.theme + '」を決める' : ''}会議に参加してください。`,
            '1. 次のリンクを開きます（スマホ・Mac・Windowsのブラウザで使えます。インストールは不要です）。',
            `   ${joinLink()}`,
            '2. 名前を入れて「参加する」を押します（招待コードは入った状態で開きます）。',
            `   うまく入らないときの招待コード： ${inviteCode()}`,
            '3. 「① 考えを預ける」で、自分の代理人に案と本音を話します（5分ほど）。全員が預けると、代理人どうしの会議が自動で始まります。',
            '※ このリンクと招待コードはチームの外に渡さないでください。',
          ].join('\n')
        : [
        `【MeetForMe】${r.theme ? '「' + r.theme + '」を決める' : ''}会議に参加してください。`,
        '1. 一緒に送るインストーラー（rusuban-kaigi-setup-….exe）を開きます。Windowsのパソコンで使えます。',
        '   ※ 初回は青い画面「WindowsによってPCが保護されました」が出ます。まだ署名をしていないためで、「詳細情報」→「実行」で進めます。',
        '2. 「MeetForMe」を開き、「招待コードで参加する」に名前と下のコードを入れます。',
        `   招待コード： ${inviteCode()}`,
        '3. 「① 考えを預ける」で、自分の代理人に案と本音を話します（5分ほど）。全員が預けると、代理人どうしの会議が自動で始まります。',
        '※ 招待コードはチームの外に渡さないでください。',
      ].join('\n');
      try {
        await navigator.clipboard.writeText(text);
        S.notice = window.WEB ? '招待の文をコピーしました。メンバーへ送ってください。' : '招待の文をコピーしました。インストーラーと一緒にメンバーへ送ってください。';
      } catch (e) {
        S.error = 'コピーできませんでした。';
      }
      renderStatus();
    };
    const save = async () => {
      const name = val('s-name');
      if (!name) return fail('名前を入力してください。');
      const patch = { name, model: val('s-model') || 'claude-sonnet-5-5', demo: $('s-demo').checked, webSearch: $('s-web').checked };
      if (val('s-key')) patch.apiKey = val('s-key');
      else if ($('s-keyoff') && $('s-keyoff').checked) patch.clearApiKey = true;
      S.error = '';
      S.cfg = await api.saveConfig(patch);
      await enterRoom();
      if (isLeader() && !S.netError) {
        const size = Math.max(2, parseInt(val('s-size'), 10) || S.teamSize);
        if (size !== r.teamSize) await api.store.put('room', 'main', { ...roomInfo(), teamSize: size });
        await refresh();
      }
      S.notice = '保存しました。';
      render();
    };
    // ---- 代表者の操作・困ったとき・このアプリについて ----
    const tool = async (label, fn) => {
      if (S.busy) return;
      S.busy = 'tool';
      S.progress = label;
      S.error = '';
      S.notice = '';
      renderStatus();
      try {
        await fn();
      } catch (e) {
        S.error = errText(e);
      }
      S.busy = '';
      S.progress = '';
      S.confirmTool = '';
      if (ready()) await refresh();
      render();
    };
    // 取り消せない操作は、もう一度押して確かめる
    const confirmBtn = (key, label, yes, fn) =>
      S.confirmTool === key
        ? h('span', { class: 'row', style: 'gap:6px' }, h('button', { class: 'btn small danger', disabled: !!S.busy, onclick: fn }, yes), h('button', { class: 'btn ghost small', onclick: () => { S.confirmTool = ''; render(); } }, 'やめる'))
        : h('button', { class: 'btn ghost small', disabled: !!S.busy, onclick: () => { S.confirmTool = key; render(); } }, label);
    const runDiag = () =>
      tool('接続を確かめています', async () => {
        S.diag = null;
        S.diag = await api.diagnose();
        S.openTools = true;
      });
    const diagList = () =>
      S.diag
        ? h(
            'div',
            { class: 'diag', id: 'diag' },
            h('div', { class: 'diag-sum ' + (S.diag.ok ? 'ok' : 'ng') }, S.diag.ok ? '問題は見つかりませんでした。' : '通らないところがあります。上から順に、最初の ✗ を直してください。'),
            S.diag.steps.map((x) => h('div', { class: 'diag-row ' + (x.skip ? 'skip' : x.ok ? 'ok' : 'ng') }, h('span', { class: 'dm' }, x.skip ? '—' : x.ok ? '✓' : '✗'), h('div', { class: 'dt' }, h('b', {}, x.label), h('span', {}, ' ' + x.detail + (x.ms > 50 ? `（${(x.ms / 1000).toFixed(1)}秒）` : '')), x.hint ? h('div', { class: 'hint' }, x.hint) : null)))
          )
        : null;
    // 代表者: メンバーを会議から外す。その人の預けた内容も消え、会議はやり直しになる
    const removeMember = (id) =>
      tool('メンバーを外しています', async () => {
        if (isRunning()) throw new Error('会議が進行中です。終わってから外してください。');
        const snap = S.snap;
        const name = (snap.member[id] || {}).name || '';
        const hadMeeting = Object.keys(snap.cand).length > 0;
        // 人数も1人減らす（残った人が預け終わると、会議が自動で始まるように）
        await api.store.put('room', 'main', { ...roomInfo(), teamSize: Math.max(2, (roomInfo().teamSize || S.teamSize) - 1), removed: (roomInfo().removed || []).filter((x) => x !== id).concat([id]) });
        for (const kind of ['member', 'brief', 'approval', 'skill']) await api.store.del(kind, id);
        if (hadMeeting) {
          // その人の案や評価が入った議論は使えないので、会議の記録を消して、残った人でやり直す
          for (const kind of ['cand', 'eval', 'question', 'approval', 'skill', 'call', 'msg']) for (const k of Object.keys(snap[kind] || {})) await api.store.del(kind, k);
          await api.store.put('state', 'main', { phase: 'collecting', round: 0 });
          S.autoSig = '';
        }
        S.notice = `${name}さんを会議から外しました。` + (hadMeeting ? '残ったメンバーで、会議をやり直します。' : '');
      });
    // 代表者: この会議のデータを、共有の保存先からすべて消す
    const deleteRoom = () =>
      tool('会議のデータを消しています', async () => {
        if (isRunning()) throw new Error('会議が進行中です。終わってから削除してください。');
        const all = await api.store.all();
        // 会議そのもの（room）は最後に消す。途中で止まっても、もう一度やり直せる
        for (const d of all.filter((x) => x.kind !== 'room')) await api.store.del(d.kind, d.id);
        for (const d of all.filter((x) => x.kind === 'room')) await api.store.del(d.kind, d.id);
        await leave(true);
        S.notice = '会議のデータをすべて削除しました。';
      });
    const checkUpdateNow = () =>
      tool('新しい版があるか確かめています', async () => {
        S.update = await api.checkUpdate();
        S.updateShown = true;
      });
    const report = async () => {
      const lines = [
        '【MeetForMe 不具合の報告】',
        `版: ${S.cfg.appVersion} ／ 環境: ${S.cfg.platform || ''}`,
        `共有: ${S.cfg.sharedMode} ／ AI: ${S.cfg.hasApiKey ? '自分のAPIキー' : S.cfg.demo ? '見本モード' : S.cfg.serverAi ? 'サーバー経由' : 'なし'} ／ 役割: ${isLeader() ? '代表者' : 'メンバー'}`,
        `会議の状態: ${state().phase || ''}（第${state().round || 0}回）${state().error ? ' ／ 止まった理由: ' + state().error : ''}`,
        S.diag ? '診断: ' + S.diag.steps.map((x) => `${x.skip ? '—' : x.ok ? '✓' : '✗'}${x.label}${x.ok ? '' : '（' + x.detail + '）'}`).join(' ') : '診断: 未実行',
        '',
        '何をしたら、どうなったか（ここに書いてください）:',
        '',
      ];
      try {
        await navigator.clipboard.writeText(lines.join('\n'));
        S.notice = '報告に必要な情報をコピーしました。開いたページの本文に貼り付けて、何が起きたかを書き足してください（名前や会議の中身は含まれていません）。';
        window.open(S.cfg.repoUrl + '/issues/new', '_blank');
      } catch (e) {
        S.error = 'コピーできませんでした。';
      }
      renderStatus();
    };
    const wipe = () => tool('このPCのデータを消しています', async () => { await api.wipeLocal(); });

    const others = Object.entries(S.snap.member).filter(([id]) => id !== S.cfg.memberId);
    const leaderCard = isLeader()
      ? h(
          'div',
          { class: 'card', id: 'sec-leader' },
          h('h2', {}, '代表者の操作'),
          h('h3', { style: 'margin-top:6px' }, 'メンバー'),
          others.length
            ? h('div', { class: 'mlist' }, others.map(([id, m]) => h('div', { class: 'mrow' }, avatar(id), h('span', { class: 'nm' }, m.name || '?'), h('span', { class: 'hint' }, S.snap.brief[id] ? '預け済み' : '未入力'), confirmBtn('rm:' + id, '会議から外す', '本当に外す', () => removeMember(id)))))
            : h('div', { class: 'hint' }, 'まだほかのメンバーは参加していません。'),
          h('div', { class: 'hint', style: 'margin-top:6px' }, '外すと、その人が預けた内容も消え、会議の人数も1人減ります。会議のあとに外した場合は、残ったメンバーで会議をやり直します。外した人は、同じ招待コードでは入り直せません。'),
          h('h3', { style: 'margin-top:18px' }, '会議のデータを削除'),
          h('div', { class: 'hint' }, 'この会議の内容（預けた考え、発言、採点、決定）を、共有の保存先からすべて消します。全員の画面からこの会議がなくなり、取り消せません。'),
          h('div', { class: 'row', style: 'margin-top:8px' }, confirmBtn('delroom', 'この会議のデータをすべて削除する', '本当に削除する', deleteRoom))
        )
      : null;
    const toolsCard = h(
      'div',
      { class: 'card' },
      h(
        'details',
        { class: 'more', id: 's-tools', open: !!S.openTools, style: 'margin-top:0;border-top:0;padding-top:0', ontoggle: (e) => { S.openTools = e.target.open; } },
        h('summary', {}, '困ったとき（接続の診断）'),
        h('div', { class: 'hint', style: 'margin-top:10px' }, 'ネットワーク・共有データベース・AIのサーバー・AIの応答を順番に試して、どこまで通るかを表示します。AIの応答の確認で、AIを1回だけ呼びます。'),
        h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn small', disabled: !!S.busy, onclick: runDiag }, '接続を診断する')),
        diagList()
      )
    );
    const up = S.update;
    const aboutCard = h(
      'div',
      { class: 'card', id: 'sec-about' },
      h('h2', {}, 'このアプリについて'),
      h('div', { class: 'kv' }, h('b', {}, '版： '), 'v' + (S.cfg.appVersion || '')),
      up && S.updateShown ? h('div', { class: 'kv', id: 'upd' }, h('b', {}, '更新： '), !up.ok ? up.msg : up.newer ? `新しい版 v${up.latest} があります。` : '最新の版です。', up.ok && up.newer ? h('button', { class: 'btn small', style: 'margin-left:8px', onclick: () => window.open(up.url, '_blank') }, 'ダウンロードのページを開く') : null) : null,
      h('div', { class: 'row', style: 'margin-top:10px;flex-wrap:wrap' }, api.checkUpdate ? h('button', { class: 'btn ghost small', disabled: !!S.busy, onclick: checkUpdateNow }, '更新を確認する') : null, h('button', { class: 'btn ghost small', onclick: report }, '不具合を報告する'), h('button', { class: 'btn ghost small', onclick: () => { S.showData = !S.showData; render(); } }, 'データの扱い')),
      S.showData ? dataNote() : null,
      h('h3', { style: 'margin-top:18px' }, 'このPCのデータを消す'),
      h('div', { class: 'hint' }, 'このPCに保存した名前、参加している会議の一覧、代理人との会話、自分のAPIキーを消して、最初の状態に戻します。共有の保存先にある会議のデータは消えません（消すには、代表者が「この会議のデータをすべて削除する」を使います）。'),
      h('div', { class: 'row', style: 'margin-top:8px' }, confirmBtn('wipe', 'このPCのデータを消す', '本当に消す', wipe))
    );

    const leave = async (force) => {
      if (S.busy && force !== true) return;
      S.cfg = await api.saveConfig({ removeRoom: S.cfg.room });
      resetView();
      S.startMode = '';
      if (S.cfg.room) {
        await enterRoom();
        S.tab = 'meeting';
        S.notice = '会議から抜けました。別の会議に切り替えました。';
      } else {
        S.snap = null;
        S.priv = {};
      }
      render();
    };
    return h(
      'div',
      { class: 'wrap' },
      h(
        'div',
        { class: 'card' },
        h('h2', {}, 'この会議'),
        h('div', { class: 'kv' }, h('b', {}, 'テーマ： '), r.theme || '（未設定）'),
        h('div', { class: 'kv' }, h('b', {}, '代表者： '), leader || '（決まっていません）', isLeader() && r.leaderId ? '（あなた）' : ''),
        h('div', { class: 'kv' }, h('b', {}, 'メンバー： '), `${Object.keys(S.snap.member).length}人が参加中 ／ ${S.teamSize}人で会議を始めます`),
        h('div', { class: 'kv' }, h('b', {}, 'あなたのAI： '), ai),
        h('div', { class: 'kv' }, h('b', {}, '共有： '), S.cfg.sharedMode === 'supabase' ? 'Supabaseで共有中（別々のPCから参加できます）' : 'このPCの中だけ（同じPCで別人として起動して試せます）')
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', {}, '招待コード'),
        h('div', { class: 'hint' }, isShort() ? 'この8文字をメンバーに伝えます。メンバーはアプリの「招待コードで参加する」に入れるだけで、別のPCからも同じ会議に入れます。コードを知っている人は会議に入れるので、チームの外には渡さないでください。' : S.cfg.sharedMode === 'supabase' ? 'この文字列をメンバーに送ります。メンバーはアプリの「招待コードで参加する」に貼り付けます。コードには共有データベースの接続先が入っているので、チームの外には渡さないでください。' : 'この会議は「このPCだけ」で作られているので、別のPCからは参加できません（同じPCで別人として起動して試す用です）。'),
        isShort() ? h('input', { id: 's-invite', class: 'bigcode', type: 'text', readonly: true, value: inviteCode(), onfocus: (e) => e.target.select() }) : h('textarea', { id: 's-invite', readonly: true, rows: 3, value: inviteCode(), onfocus: (e) => e.target.select() }),
        h('div', { class: 'row end' }, h('button', { class: 'btn ghost', onclick: copy }, 'コードだけコピー'), h('button', { class: 'btn', onclick: copyInvite }, window.WEB ? '招待の文とリンクをコピー' : '招待の文をコピー（入れ方の説明つき）'))
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', {}, 'あなたの設定'),
        field('s-name', '名前', { value: S.cfg.name || '' }),
        isLeader() ? field('s-size', 'メンバーの人数（代表者を含む）', { type: 'number', min: '2', max: '12', value: String(S.teamSize) }) : null,
        h(
          'details',
          { class: 'more', id: 's-more' },
          h('summary', {}, '上級者向けの設定（ふつうは不要）'),
          aiFields('s-'),
          field('s-model', 'モデル', { value: S.cfg.model || 'claude-sonnet-5-5' }, '例：claude-sonnet-5-5（標準）／claude-haiku-5-5（速くて安い）'),
          h('label', { class: 'check', style: 'margin-top:14px' }, h('input', { id: 's-web', type: 'checkbox', checked: S.cfg.webSearch !== false }), ' 進行役AIが「技術的に作れるか」を調べるときに、Web検索を使う'),
          h('div', { class: 'hint' }, '検索は1回の会議で数回までで、検索1回ごとに追加の費用がかかります。切ると、AIの知識だけで判断します。')
        ),
        h('div', { class: 'row end', style: 'margin-top:16px' }, h('button', { class: 'btn', onclick: save }, '保存する'))
      ),
      h(
        'div',
        { class: 'card', id: 'sec-take' },
        h('h2', {}, '別の端末で続ける'),
        h('div', { class: 'hint' }, 'PCで始めた代理人との会話を、スマホで続けられます（逆もできます）。リンクを作り、続きをしたい端末のブラウザで開いてください。会話は暗号化して保存され、鍵はリンクの中にだけあります。リンクはあなた専用なので、ほかの人に渡さないでください。'),
        S.takeLink ? h('div', { class: 'codebox', id: 'takeLink', style: 'margin-top:10px;word-break:break-all' }, S.takeLink) : null,
        h(
          'div',
          { class: 'row end', style: 'margin-top:10px' },
          S.takeLink ? h('button', { class: 'btn ghost', onclick: async () => { try { await navigator.clipboard.writeText(S.takeLink); S.notice = '引き継ぎリンクをコピーしました。'; } catch (e) { S.notice = 'コピーできませんでした。リンクを長押しして選び、コピーしてください。'; } renderStatus(); } }, 'リンクをコピー') : null,
          h('button', { class: 'btn' + (S.takeLink ? ' ghost' : ''), disabled: !!S.busy, onclick: async () => { try { S.takeLink = await makeTakeLink(); S.error = ''; } catch (e) { S.error = errText(e); } render(); } }, S.takeLink ? '作り直す' : '引き継ぎリンクを作る')
        ),
        S.priv && S.priv.syncKey ? h('div', { class: 'hint', style: 'margin-top:8px' }, 'この会議は、引き継ぎが有効です。会話を進めるたびに、暗号化した内容が保存先に送られます。') : null
      ),
      leaderCard,
      toolsCard,
      aboutCard,
      h(
        'div',
        { class: 'card' },
        h('h2', {}, 'この会議から抜ける'),
        h('div', { class: 'hint' }, 'この会議を一覧から外します。会議のデータは残るので、招待コードを控えておけば、また参加できます。ほかの会議には、画面上部の「会議：」からいつでも切り替えられます。'),
        h('div', { class: 'row end' }, h('button', { class: 'btn ghost', onclick: () => leave() }, 'この会議から抜ける'))
      )
    );
  }

  // ---------- 全体 ----------
  function renderStatus() {
    const el = $('status');
    el.className = '';
    el.replaceChildren();
    if (!S.notice) S.noticeShown = '';
    const err = S.error || S.netError;
    if (S.busy && (S.progress || S.busy === 'meeting')) {
      el.className = 'show';
      el.append(h('div', { class: 'spin' }), h('span', {}, (S.progress || '会議を進めています') + '…'));
    } else if (err) {
      el.className = 'show err';
      el.append(h('span', {}, err), S.error ? h('button', { class: 'btn ghost small', onclick: () => { S.error = ''; renderStatus(); } }, '閉じる') : null);
    } else if (S.notice) {
      el.className = 'show';
      el.append(h('span', {}, S.notice), h('button', { class: 'btn ghost small', onclick: () => { S.notice = ''; renderStatus(); } }, '閉じる'));
      // お知らせは、しばらくしたら自動で消す（あとからベルマークの一覧で見られる）。同じお知らせの描き直しでは、時間を数え直さない
      if (S.noticeShown !== S.notice) {
        S.noticeShown = S.notice;
        clearTimeout(S.noticeTimer);
        const shown = S.notice;
        S.noticeTimer = setTimeout(() => {
          if (S.notice === shown) {
            S.notice = '';
            renderStatus();
          }
        }, 10000);
      }
    }
  }

  function render() {
    S.dirty = false;
    if (!ready()) S.tab = 'settings';
    const qn = myTodos().filter((t) => t.urgent && t.tab === 'meeting').length;
    renderSide();
    const stNow = S.snap ? state() : { phase: 'collecting' };
    const deposited = !!(S.snap && S.snap.brief[S.cfg.memberId]);
    const decidedNow = stNow.phase === 'decided';
    const onTab = S.startMode ? 'settings' : S.tab;
    const stepBtn = (id, n, label, done) =>
      h('button', { class: 'stepb' + (onTab === id ? ' on' : '') + (done ? ' done' : ''), 'aria-current': onTab === id ? 'step' : null, disabled: !ready(), onclick: () => { S.tab = id; S.startMode = ''; render(); } }, h('span', { class: 'n' }, done && onTab !== id ? '✓' : String(n)), h('span', {}, label), id === 'meeting' && qn ? h('span', { class: 'dot' }, qn) : null);
    $('nav').replaceChildren(
      stepBtn('room', 1, '考えを預ける', deposited),
      h('span', { class: 'stepline' }),
      stepBtn('meeting', 2, '会議と結果', decidedNow),
      h('span', { class: 'stepline' }),
      h('span', { class: 'stepb static' + (decidedNow ? ' done' : '') }, h('span', { class: 'n' }, decidedNow ? '✓' : '3'), h('span', {}, '決定'))
    );
    $('who').replaceChildren(
      ...[
        ready() ? h('span', { class: 'whoname' }, `${S.cfg.name}（${isLeader() ? '代表者' : 'メンバー'}）`) : null,
        !S.cfg.hasApiKey && !S.cfg.demo && S.cfg.serverAi ? h('span', { class: 'badge', title: 'AIは会議のサーバー経由で動きます。このPCにAPIキーは要りません。' }, 'AI：サーバー経由') : null,
        S.cfg.demo && !S.cfg.hasApiKey ? h('span', { class: 'badge warn', title: 'AIの応答は決まった見本です。APIは呼びません。' }, '見本モード') : null,
        ready() ? h('span', { class: 'badge' + (S.cfg.sharedMode === 'supabase' ? '' : ' warn') }, S.cfg.sharedMode === 'supabase' ? '共有中' : 'このPCだけ') : null,
        ready() && window.WEB ? h('button', { class: 'btn ghost small', disabled: !!S.busy, onclick: async () => { if (!confirm('ログアウトします。この端末の会話と預かりメモは消えます（引き継ぎリンクを作ってあれば、あとでログインして戻せます）。よろしいですか？')) return; try { await api.wipeLocal(); } catch (e) {} location.reload(); } }, 'ログアウト') : null,
        ready() ? h('button', { class: 'btn ghost small', disabled: !!S.busy, onclick: () => { S.tab = 'settings'; S.startMode = ''; render(); $('view').scrollTop = 0; } }, '設定・招待') : null,
        S.cfg.appVersion ? h('span', { class: 'ver', title: 'このアプリのバージョン' }, 'v' + S.cfg.appVersion) : null,
        S.update && S.update.ok && S.update.newer ? h('button', { class: 'btn small upd', id: 'updbtn', title: `新しい版 v${S.update.latest} があります`, onclick: () => window.open(S.update.url, '_blank') }, '新しい版があります') : null,
      ].filter(Boolean)
    );
    renderStatus();
    renderTurn();
    checkTurn();
    checkDecided();
    const view = $('view');
    const keepScroll = view.scrollTop;
    view.replaceChildren(S.startMode || S.tab === 'settings' ? viewSettings() : S.tab === 'meeting' ? viewMeeting() : viewRoom());
    view.scrollTop = keepScroll;
    const msgs = $('msgs');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
    const livelog = $('livelog');
    if (livelog) livelog.scrollTop = livelog.scrollHeight;
  }

  // 代表者のアプリ（AIを呼べる）が開いていれば、全員が預けたとき・新しい答えが届いたときに会議を進める
  // 会議をサーバーで進められるとき（関数「meeting」が入っているとき）は、だれの画面からでも「進めてください」と合図だけ送る。
  // 画面を閉じても会議は進む。合図から90秒たっても始まらないときだけ、これまでどおり代表者の画面で進める
  function serverKick() {
    if (!S.cfg.serverMeeting || !api.kickMeeting || window.PROTO) return false;
    if (!ready() || S.busy || isRunning()) return true;
    const st = state();
    const auto = Engine.autoMode(S.snap, Date.now());
    if (!auto) return true;
    const key = [auto.mode, st.round || 0, st.paused || 0, st.lastRunAt || 0, Object.keys(S.snap.brief).sort().join(',')].join(':');
    if (S.kickKey !== key) {
      S.kickKey = key;
      S.kickAt = Date.now();
      api.kickMeeting().then((r) => { if (!r || r.ok === false) S.kickAt = 0; }).catch(() => { S.kickAt = 0; });
      return true;
    }
    return Date.now() - (S.kickAt || 0) < 90000;
  }
  function autoRun() {
    const kickPending = serverKick();
    if (!ready() || S.busy || !canAI() || !isLeader() || isRunning()) return;
    const snap = S.snap;
    const st = state();
    if (st.error) return; // 止まったままのときは自動では繰り返さない（会議室の「続きから再開する」で進める）
    const ids = Object.keys(snap.brief).filter((id) => snap.member[id]).sort();
    let mode = '';
    if (kickPending) return; // サーバーに任せて待っているところ
    const deadlineAt = roomInfo().deadlineAt || 0;
    const due = !!deadlineAt && Date.now() >= deadlineAt; // 預ける締切を過ぎたら、預けた人だけで始める
    let late = false;
    if (st.phase === 'collecting' && ids.length >= 2 && (ids.length >= S.teamSize || due)) mode = 'full';
    if (mode === 'full' && st.paused && Engine.canResume(snap)) mode = 'resume'; // サーバーが時間で区切った続き
    else if (st.phase === 'review') {
      const last = st.lastRunAt || 0;
      const pending = ids.some((id) => (snap.brief[id].updates || []).some((u) => u.at > last) && !Object.values(snap.question).some((q) => q.memberId === id && q.status === 'open'));
      if (pending) mode = 'rerun';
      if (ids.some((id) => (snap.brief[id].editedAt || 0) > last)) mode = 'full'; // 案を手直しして預け直した人がいる
      // 会議のあとで預けた人がいる（締切で先に始めた場合など）→ その人を入れて最初からやり直す
      if ((st.participants || []).length && ids.some((id) => !st.participants.includes(id))) { mode = 'full'; late = true; }
    }
    if (!mode) return;
    // 同じ状況では1回しか自動で試さない（失敗したまま繰り返さないため）
    const sig = [mode, st.round || 0, ids.join(','), ids.map((id) => (snap.brief[id].updates || []).length + '/' + (snap.brief[id].editedAt || 0)).join(',')].join(':');
    if (S.autoSig === sig) return;
    S.autoSig = sig;
    S.notice = mode === 'full' ? (st.phase === 'review' ? (late ? 'あとから預けた人がいるので、その人を入れて会議をやり直しています。' : '案を預け直した人がいるので、会議をやり直しています。') : ids.length >= S.teamSize ? '全員が預けたので、会議を始めました。' : `預ける締切を過ぎたので、預けた${ids.length}人で会議を始めました。`) : '新しい答えが届いたので、議論をやり直しています。';
    run('meeting', () => Engine.runMeeting(ctx(), { mode }));
  }

  let lastPoll = 0;
  async function poll() {
    if (!ready() || S.busy) return;
    const st0 = state();
    const live = st0.runner && Date.now() - (st0.runnerAt || 0) < Engine.LOCK_MS;
    if (!live && Date.now() - lastPoll < 3800) return;
    lastPoll = Date.now();
    const before = JSON.stringify(S.snap);
    const wasRunning = isRunning();
    const hadRoom = !!(S.snap && S.snap.room && S.snap.room.main);
    await refresh();
    if (!S.netError && api.saveConfig && !window.PROTO) {
      const room = S.snap.room && S.snap.room.main;
      const kicked = room && (room.removed || []).includes(S.cfg.memberId);
      const gone = hadRoom && !room && !Object.keys(S.snap.member).length && !Object.keys(S.snap.state).length;
      if (kicked || gone) {
        if (kicked) {
          // 外された人の名前が、メンバーの一覧に残らないようにする
          for (const kind of ['member', 'brief']) await api.store.del(kind, S.cfg.memberId).catch(() => {});
        }
        S.cfg = await api.saveConfig({ removeRoom: S.cfg.room });
        resetView();
        S.startMode = '';
        if (S.cfg.room) await enterRoom();
        else {
          S.snap = null;
          S.priv = {};
        }
        S.notice = kicked ? '代表者が、この会議からあなたを外しました。' : 'この会議は、代表者によって削除されました。';
        return render();
      }
    }
    checkEvents();
    autoRun();
    if (!wasRunning && isRunning() && S.tab === 'room' && S.snap.brief[S.cfg.memberId]) {
      const el = document.activeElement;
      if (!(el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') && el.value)) {
        S.tab = 'meeting';
        S.notice = '代理人どうしの会議が始まりました。';
      }
    }
    if (S.busy || JSON.stringify(S.snap) === before) return;
    const a = document.activeElement;
    const typing = a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT') && $('view').contains(a);
    checkTurn();
    checkDecided();
    if (S.tab === 'settings' || S.startMode || typing) {
      renderTurn();
      S.dirty = true; // 入力中は描き直さず、入力欄から離れたときに反映する
      return;
    }
    render();
  }

  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (S.dirty && S.tab !== 'settings' && !S.busy) render();
    }, 150);
  });

  (async function init() {
    S.cfg = await api.getConfig();
    if (ready()) await enterRoom();
    // Web版: 招待のリンク（…#join=コード）から開いたら、参加の画面を、コードが入った状態で出す
    // 引き継ぎのリンク（…#take=…）から開いたら、同じ人としてこの端末で続きができるようにする
    const tm = /[#&]take=([^&]+)/.exec(location.hash || '');
    if (tm) {
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
      try {
        await takeOver(decodeURIComponent(tm[1]));
      } catch (e) {
        S.error = '引き継ぎに失敗しました。（' + errText(e) + '）';
      }
    }
    const jm = window.WEB ? /[#&]join=([^&]+)/.exec(location.hash || '') : null;
    if (jm) {
      S.joinCode = decodeURIComponent(jm[1]);
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
      const code = S.joinCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (!(S.cfg.rooms || []).some((x) => x.room === code || x.room === S.joinCode)) S.startMode = 'join';
    }
    setupBell();
    render();
    setInterval(poll, 1500);
    setInterval(pollOthers, 15000);
    pollOthers();
    // 新しい版があるかを、起動時に1回だけ確かめる（確認できなくても何も出さない）
    if (api.checkUpdate) {
      api.checkUpdate().then((u) => {
        if (u && u.ok && u.newer) {
          S.update = u;
          if (!S.busy) render();
        }
      }).catch(() => {});
    }
  })();
})();
