// かわりに会議 — 画面
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
  // AIを呼べるか（APIキーがある、または見本モード）。呼べない人はフォームで預け、会議は幹事のアプリが進める
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
  function todosOf(snap) {
    const out = [];
    if (!snap) return out;
    const st = snap.state.main || { phase: 'collecting', round: 0 };
    const running = !!(st.runner && Date.now() - (st.runnerAt || 0) < Engine.LOCK_MS);
    const me = S.cfg.memberId;
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
        if (window.Notification && Notification.permission === 'granted' && (document.hidden || !document.hasFocus())) {
          new Notification('かわりに会議：あなたの番です', { body: fresh[0].text });
        }
      } catch (e) {}
    }
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
        const urgent = todosOf(snap).filter((t) => t.urgent);
        const prev = S.peek[r.room];
        const keys = urgent.map((t) => t.key).join('|');
        if (prev && keys && keys !== prev.keys) {
          try {
            if (window.Notification && Notification.permission === 'granted') new Notification('かわりに会議：あなたの番です', { body: `「${roomTitle(r)}」${urgent[0].text}` });
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
        h('div', { class: 'swfoot' }, h('button', { class: 'btn small', disabled: !!S.busy, onclick: () => open('create') }, '新しい会議を作る'), h('button', { class: 'btn small ghost', disabled: !!S.busy, onclick: () => open('join') }, '招待コードで参加する'))
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

  async function savePriv() {
    await api.savePrivate(S.cfg.room, S.priv);
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
    render();
  }

  function sendChat() {
    const text = (S.drafts.chat || '').trim();
    if (!text) return;
    S.drafts.chat = '';
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
        S.notice = `預けました（いま ${deposited} / ${S.teamSize} 人）。全員が預けると、幹事のアプリが開いているときに会議が進みます。`;
      } else if (deposited >= 2 && (deposited >= S.teamSize || hadMeeting)) {
        S.tab = 'meeting';
        render();
        await Engine.runMeeting(ctx(), { mode: 'full' });
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
    run('meeting', async () => {
      const left = await Engine.answerQuestion(ctx(), q.id, text);
      delete S.drafts[key];
      if (left === 0 && canAI()) {
        S.tab = 'meeting';
        await Engine.runMeeting(ctx(), { mode: 'rerun' });
      } else if (left === 0) {
        S.notice = '答えを代理人に伝えました。幹事のアプリが開いているときに、議論をやり直します。';
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
        S.notice = Object.keys(S.snap.cand).length ? '代理人に伝えました。幹事のアプリが開いているときに、議論をやり直します。' : '代理人に伝えました。';
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
      kv('外したくない条件', b.mustHaves && b.mustHaves.length ? b.mustHaves.join(' ／ ') : '（特になし）'),
      kv('実装でできること', b.impl),
      kv('取り入れたい部分', b.wantFromOthers),
      kv('納得の条件', b.acceptCondition),
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
    if (ed.src === 'saved') next.editedAt = Date.now(); // 預け直しの印（幹事のアプリが議論をやり直す合図）
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
      draftArea('e:must', {}),
      h('label', {}, '実装でできること'),
      draftArea('e:impl', {}),
      h('label', {}, '取り入れたい部分'),
      draftArea('e:want', one),
      h('label', {}, '納得の条件'),
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
          h('div', { class: 'row end' }, h('button', { class: 'btn small', disabled: !!S.busy, onclick: () => answer(q) }, '答える'))
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
      h('div', { class: 'row' }, h('button', { class: 'btn small', disabled: !!S.busy, onclick: () => { S.tab = 'meeting'; S.editTopic = true; S.drafts['t:theme'] = r.theme || ''; S.drafts['t:criteria'] = r.criteria || ''; S.drafts['t:conditions'] = r.conditions || ''; render(); const ta = document.querySelector('details.fold textarea'); if (ta) ta.scrollIntoView({ block: 'center' }); } }, '評価基準を入れる'))
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
      placeholder: '代理人に話す（Enterで送信／Shift+Enterで改行）',
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
        h('div', { class: 'agenthead' }, avatar(S.cfg.memberId), h('div', {}, h('b', {}, `${S.cfg.name}さんの代理人`), h('div', { class: 'hint' }, 'ここでの話はこのPCにだけ保存され、ほかの人には見えません。')))
      ),
      msgs,
      h('div', { class: 'composer' }, input, h('button', { class: 'btn', disabled: !!S.busy, onclick: sendChat }, '送信'))
    );

    const side = h('div', { class: 'side' });
    const cn = critNote();
    if (cn) side.append(cn);
    const qb = questionsBox();
    if (qb) side.append(qb);
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
    const ps = Engine.paragraphs(text);
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
        { class: 'log livelog', id: 'livelog' },
        msgs.map(msgRow),
        speaker ? bubbleRow(speakerIdOf(speaker), speaker, text || '考えています…', true) : h('div', { class: 'm system' }, (st.progress || '準備しています') + '…')
      ),
      h('div', { class: 'hint', style: 'margin-top:8px' }, st.runner === S.cfg.memberId ? '発言が出るたびにここへ流れます。終わると下に推薦案が出ます。会議が終わるまでこの画面を開いたままにしてください。' : `${st.runnerName || 'ほかのメンバー'}さんのアプリが会議を進めています。発言が出るたびにここへ流れます。`)
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
              r.conditions ? h('div', { class: 'kv' }, h('b', {}, '締切・条件： '), r.conditions) : null,
            ]
          : h('div', { class: 'hint' }, 'まだ設定されていません。テーマと評価基準を入れると、代理人と進行役AIがそれに沿って案を評価します。'),
        isLeader()
          ? h('div', { class: 'row end' }, h('button', { class: 'btn ghost small', disabled: !!S.busy, onclick: () => { S.editTopic = true; S.drafts['t:theme'] = r.theme || ''; S.drafts['t:criteria'] = r.criteria || ''; S.drafts['t:conditions'] = r.conditions || ''; render(); } }, set ? '編集する' : '設定する'))
          : h('div', { class: 'hint', style: 'margin-top:6px' }, 'お題と評価基準は、幹事が設定します。')
      );
    }
    const save = () =>
      run('topic', async () => {
        const cur = (S.snap.room && S.snap.room.main) || {};
        await api.store.put('room', 'main', { ...cur, theme: (S.drafts['t:theme'] || '').trim(), criteria: (S.drafts['t:criteria'] || '').trim(), conditions: (S.drafts['t:conditions'] || '').trim() });
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
      h('label', {}, '締切・条件'),
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
        await navigator.clipboard.writeText(JSON.stringify({ app: 'かわりに会議', exportedAt: new Date().toISOString(), snapshot: S.snap }, null, 1));
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
    const lines = [`【決定】${roomInfo().theme || 'かわりに会議'}`, '', `決まった案：${c.title || ''}`];
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
      if (window.Notification && Notification.permission === 'granted' && (document.hidden || !document.hasFocus())) new Notification('かわりに会議：決定しました', { body: `「${c.title}」に決まりました。` });
    } catch (e) {}
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
    if (st.phase === 'decided' && was !== 'decided') showDecided(st);
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
    if (!snap || !snap.brief[me] || st.phase !== 'collecting' || isRunning() || S.busy === 'meeting') return null;
    const members = Object.entries(snap.member).map(([id, m]) => ({ id, ...m }));
    const total = Math.max(S.teamSize, members.length);
    const done = members.filter((m) => snap.brief[m.id]);
    const yet = members.filter((m) => !snap.brief[m.id]);
    const notJoined = Math.max(0, total - members.length);
    const all = done.length >= total;
    const theme = roomInfo().theme || '';
    const stepNow = all ? 2 : 1;
    const steps = ['考えを預ける', '全員がそろうのを待つ', '代理人どうしの会議', '結果を確認して承認'];
    const remind = async () => {
      const names = yet.map((m) => m.name + 'さん').join('、');
      const text = `【かわりに会議】${theme ? '「' + theme + '」の会議で、' : ''}${names ? names + 'の' : 'まだの人の'}入力を待っています。アプリを開いて、「① 考えを預ける」で考えを預けてください（5分ほどです）。全員が預けると、AIの代理人どうしの会議が自動で始まります。`;
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
      protoWaitHelp(yet),
      window.PROTO && yet.length ? null : h('div', { class: 'wlive' }, h('span', { class: 'pulse' }), 'ほかの人の状況を数秒ごとに自動で確認しています。この画面のまま待っていて大丈夫です。'),
      h(
        'div',
        { class: 'wnext' },
        h('b', {}, '待っている間にできること'),
        h(
          'ul',
          { class: 'plain' },
          h('li', {}, '会議が始まると、この画面に代理人どうしのやり取りが流れます。あなたの番が来たら、画面上部の帯' + (window.Notification && !window.PROTO ? 'と通知' : '') + 'でお知らせします。'),
          h('li', {}, '預けた内容は、会議が始まる前ならいつでも直せます。'),
          notJoined ? h('li', {}, isLeader() ? `まだ参加していない人が${notJoined}人います。「設定・招待」の招待コードを送ってください。` : `まだ参加していない人が${notJoined}人います。幹事が招待コードを送るのを待っています。`) : null
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
              h('h3', {}, 'なぜこの案か'),
              h('div', { class: 'reason' }, paras(rec.reason)),
              rec.tie && snap.cand[rec.runnerUpId] ? h('div', { class: 'q', style: 'margin-top:10px' }, h('p', {}, `「${snap.cand[rec.runnerUpId].title}」と評価が並んでいます。${rec.conflict ? '対立点：' + rec.conflict : ''}`)) : null
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
              h('summary', {}, 'くわしく見る（案の中身・誰の意見が効いたか・実装の進め方）'),
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
          { class: 'idea' + (c.dropped ? ' dropped' : '') },
          t ? h('span', { class: 'score' }, pointsText(t) + (t.excluded ? '・対象外（' + t.excluded + '）' : '')) : null,
          h('div', { class: 'ttl' }, c.title, c.origin === 'merged' ? h('span', { class: 'tag mix' }, '合体案') : null, c.origin === 'ai' ? h('span', { class: 'tag new' }, 'AIの新案') : null, c.id === (rec && rec.topId) ? h('span', { class: 'tag push' }, '推薦') : null),
          h('div', { class: 'hint' }, owner + (c.dropped ? `　／　外した理由：${c.dropReason}（部品としては残しています）` : '')),
          c.summary ? h('div', { style: 'margin-top:4px' }, c.summary) : null,
          partsView(c),
          c.why ? h('div', { class: 'hint', style: 'margin-top:6px' }, (c.origin === 'ai' ? 'この案を足した理由：' : '組み合わせの狙い：') + c.why) : null,
          feasView(c, false),
          t && t.marks && t.marks.length
            ? h('div', { class: 'fit' }, h('b', {}, '評価基準ごとの採点（進行役AI）'), h('div', { class: 'marks' }, t.marks.map((m) => h('span', { class: 'mk s' + m.score }, `${m.name}${m.weight !== 1 ? ' ×' + m.weight : ''}：${m.score}/5`))), t.comment ? h('div', { class: 'hint' }, t.comment) : null)
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
      wrap.append(
        fold('cands', `案の一覧と評価（${cands.filter((c) => !c.dropped).length}案）`, false, h('div', { class: 'hint' }, '100点満点です。お題と評価基準への合い方が70点（進行役AIが基準ごとに5段階で採点）、メンバーの支持が30点（各代理人が5段階。推測による評価は重み半分）。本人が「嫌」と言った案と、元の案より点が低い合体案は対象外です。評価基準が未設定のときは、支持だけで100点に換算します。'), cands.filter((c) => !c.dropped).map(card), cands.filter((c) => c.dropped).map(card))
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
        st.phase === 'review' || st.phase === 'decided'
          ? h('div', { class: 'row end' }, h('button', { class: 'btn ghost small', disabled: !!S.busy || running, onclick: () => startMeeting('full') }, '最初から会議をやり直す'))
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
      if (!S.cfg.dbDefault) throw new Error('このアプリには会議の接続先が入っていないので、短い招待コードは使えません。幹事に長い招待コード（AIDK1.…）を送ってもらってください。');
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
  const field = (id, label, attrs, hint) => [h('label', { for: id }, label), attrs && attrs.rows ? h('textarea', { id, ...attrs }) : h('input', { id, type: 'text', ...attrs }), hint ? h('div', { class: 'hint' }, hint) : null];
  const fail = (msg) => {
    S.error = msg;
    renderStatus();
  };
  // 自分のAPIキーと見本モードは、ふだん使わないので設定の「上級者向け」にだけ置く（AIは会議のサーバー経由で動く）
  const aiFields = (prefix) => [
    field(prefix + 'key', '自分のClaude APIキー', { type: 'password', placeholder: S.cfg.hasApiKey ? '設定済み（変えるときだけ入力）' : 'sk-ant-…（入れなくても動きます）' }, 'サーバー経由のAIが使えないときの予備です。入れると、このPCではサーバーを通らず、このキーでAIを呼びます。キーはこのPCにだけ暗号化して保存され、ほかのメンバーには送られません。'),
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
    await api.store.put('room', 'main', { teamSize: Math.max(2, parseInt(val('c-size'), 10) || 3), theme, criteria: val('c-criteria'), conditions: val('c-cond'), leaderId: S.cfg.memberId, createdAt: Date.now() });
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
    await enterRoom();
    const missing = !S.netError && !(S.snap.room && S.snap.room.main);
    if (S.netError || missing) {
      const why = S.netError;
      if (missing) await api.store.del('member', S.cfg.memberId).catch(() => {});
      S.cfg = await api.saveConfig({ removeRoom: patch.room, room: prev || '' });
      S.netError = '';
      if (S.cfg.room) await enterRoom();
      return fail(missing ? 'この招待コードの会議が見つかりませんでした。幹事が会議を作り直していないか確かめてください。' : '共有データベースにつながりませんでした。（' + why + '）');
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
          h('h2', {}, '会議を作る（幹事）'),
          h('div', { class: 'hint' }, 'ここで入れた内容は、参加したメンバー全員に共有されます。あとから「② 会議と結果」で直せます。'),
          field('c-name', 'あなたの名前', { value: S.cfg.name || '', placeholder: '例：りょうま' }),
          field('c-theme', 'テーマ（何を決める会議か）', { placeholder: '例：かゆいところに手が届くアプリ' }),
          field('c-criteria', '評価基準（1行に1つ。重みを付けたい基準は、行の最後に「×2」）', { rows: 4, placeholder: 'テーマに合っているか\n新しさがあるか ×2\n完成度・実際に動くか\nプレゼンで伝わるか' }, '点数の70点分は、この基準ごとの採点で決まります。空欄だと「テーマに合っているか」だけで採点します。'),
          field('c-cond', '締切・条件（任意）', { placeholder: '例：3人チーム、開発期間は7日間、11/18締切' }),
          field('c-size', 'メンバーの人数（幹事を含む）', { type: 'number', min: '2', max: '12', value: '3' }, 'この人数が預け終わると、会議が自動で始まります。'),
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
    if (S.startMode === 'join') {
      return h(
        'div',
        { class: 'wrap' },
        h(
          'div',
          { class: 'card' },
          h('h2', {}, '招待コードで参加する'),
          field('j-name', 'あなたの名前', { value: S.cfg.name || '', placeholder: '例：あおい' }),
          field('j-code', '招待コード', { placeholder: '例：K7M2-9QXD（幹事から送られてきた8文字）', autocomplete: 'off', spellcheck: 'false' }),
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
        h('p', { class: 'herolead' }, 'あなたは代理人に考えを話すだけ。会議は代理人どうしで進みます。'),
        h(
          'div',
          { class: 'stepcards' },
          [[1, '考えを預ける', '自分の代理人に、案と本音を話します。', '約5分'], [2, '代理人どうしが会議', '全員が預けると自動で始まり、推薦案が出ます。', '1〜2分・見ているだけ'], [3, '承認して決定', '推薦案を見て、全員が承認すれば決まりです。', '約1分']].map(([n, title, text, time]) =>
            h('div', { class: 'stepcard' }, h('div', { class: 'num' }, String(n)), h('div', { class: 'st-t' }, title), h('div', { class: 'st-x' }, text), h('div', { class: 'st-m' }, time))
          )
        )
      ),
      h(
        'div',
        { class: 'choices' },
        h('div', { class: 'card choice' }, h('h2', {}, '会議を作る'), h('div', { class: 'hint' }, '幹事として、テーマ・評価基準・人数を決めて会議を作ります。できた招待コードをメンバーに送ります。'), h('button', { class: 'btn big', onclick: () => { S.startMode = 'create'; render(); } }, '幹事として始める')),
        h('div', { class: 'card choice' }, h('h2', {}, '招待コードで参加する'), h('div', { class: 'hint' }, '幹事から送られてきた招待コードを貼り付けて、会議に参加します。入力は名前と招待コードだけです。'), h('button', { class: 'btn ghost big', onclick: () => { S.startMode = 'join'; render(); } }, 'メンバーとして参加する'))
      )
    );
  }

  function viewSettings() {
    if (!ready() || S.startMode) return viewStart();
    const r = roomInfo();
    const leader = (S.snap.member[r.leaderId] || {}).name || '';
    const ai = S.cfg.hasApiKey ? '自分のAPIキーを使用' : S.cfg.demo ? '見本モード（決まった見本の応答。本物のAIではありません）' : S.cfg.serverAi ? '使えます（会議のサーバー経由。設定は不要です）' : '使えません（フォームで預け、会議は幹事のアプリが進めます）';
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(inviteCode());
        S.notice = '招待コードをコピーしました。メンバーに送ってください。';
      } catch (e) {
        S.error = 'コピーできませんでした。枠の中の文字を選んでコピーしてください。';
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
    const leave = async () => {
      if (S.busy) return;
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
        h('div', { class: 'kv' }, h('b', {}, '幹事： '), leader || '（決まっていません）', isLeader() && r.leaderId ? '（あなた）' : ''),
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
        h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: copy }, '招待コードをコピー'))
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', {}, 'あなたの設定'),
        field('s-name', '名前', { value: S.cfg.name || '' }),
        isLeader() ? field('s-size', 'メンバーの人数（幹事を含む）', { type: 'number', min: '2', max: '12', value: String(S.teamSize) }) : null,
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
        { class: 'card' },
        h('h2', {}, 'この会議から抜ける'),
        h('div', { class: 'hint' }, 'この会議を一覧から外します。会議のデータは残るので、招待コードを控えておけば、また参加できます。ほかの会議には、画面上部の「会議：」からいつでも切り替えられます。'),
        h('div', { class: 'row end' }, h('button', { class: 'btn ghost', onclick: leave }, 'この会議から抜ける'))
      )
    );
  }

  // ---------- 全体 ----------
  function renderStatus() {
    const el = $('status');
    el.className = '';
    el.replaceChildren();
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
        ready() ? h('span', { class: 'whoname' }, `${S.cfg.name}（${isLeader() ? '幹事' : 'メンバー'}）`) : null,
        !S.cfg.hasApiKey && !S.cfg.demo && S.cfg.serverAi ? h('span', { class: 'badge', title: 'AIは会議のサーバー経由で動きます。このPCにAPIキーは要りません。' }, 'AI：サーバー経由') : null,
        S.cfg.demo && !S.cfg.hasApiKey ? h('span', { class: 'badge warn', title: 'AIの応答は決まった見本です。APIは呼びません。' }, '見本モード') : null,
        ready() ? h('span', { class: 'badge' + (S.cfg.sharedMode === 'supabase' ? '' : ' warn') }, S.cfg.sharedMode === 'supabase' ? '共有中' : 'このPCだけ') : null,
        ready() ? h('button', { class: 'btn ghost small', disabled: !!S.busy, onclick: () => { S.tab = 'settings'; S.startMode = ''; render(); $('view').scrollTop = 0; } }, '設定・招待') : null,
        S.cfg.appVersion ? h('span', { class: 'ver', title: 'このアプリのバージョン' }, 'v' + S.cfg.appVersion) : null,
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

  // 幹事のアプリ（AIを呼べる）が開いていれば、全員が預けたとき・新しい答えが届いたときに会議を進める
  function autoRun() {
    if (!ready() || S.busy || !canAI() || !isLeader() || isRunning()) return;
    const snap = S.snap;
    const st = state();
    const ids = Object.keys(snap.brief).filter((id) => snap.member[id]).sort();
    let mode = '';
    if (st.phase === 'collecting' && ids.length >= 2 && ids.length >= S.teamSize) mode = 'full';
    else if (st.phase === 'review') {
      const last = st.lastRunAt || 0;
      const pending = ids.some((id) => (snap.brief[id].updates || []).some((u) => u.at > last) && !Object.values(snap.question).some((q) => q.memberId === id && q.status === 'open'));
      if (pending) mode = 'rerun';
      if (ids.some((id) => (snap.brief[id].editedAt || 0) > last)) mode = 'full'; // 案を手直しして預け直した人がいる
    }
    if (!mode) return;
    // 同じ状況では1回しか自動で試さない（失敗したまま繰り返さないため）
    const sig = [mode, st.round || 0, ids.join(','), ids.map((id) => (snap.brief[id].updates || []).length + '/' + (snap.brief[id].editedAt || 0)).join(',')].join(':');
    if (S.autoSig === sig) return;
    S.autoSig = sig;
    S.notice = mode === 'full' ? (st.phase === 'review' ? '案を預け直した人がいるので、会議をやり直しています。' : '全員が預けたので、会議を始めました。') : '新しい答えが届いたので、議論をやり直しています。';
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
    await refresh();
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
    render();
    setInterval(poll, 1500);
    setInterval(pollOthers, 15000);
    pollOthers();
  })();
})();
