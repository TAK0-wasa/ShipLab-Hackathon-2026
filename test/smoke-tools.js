// 製品版の機能: データの扱いの表示 → 更新のお知らせ → 接続の診断 → 止まった会議の再開 → 決定の取り消し → メンバーを外す → 会議のデータを削除 → このPCのデータを消す
// 実行: npx electron test/smoke-tools.js （スクリーンショットの出力先は環境変数 SMOKE_OUT）
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-tools-'));
const outDir = process.env.SMOKE_OUT ? path.resolve(process.env.SMOKE_OUT) : tmp;
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'user'));
fs.mkdirSync(outDir, { recursive: true });
process.env.KAWARINI_DB = process.env.KAWARINI_DB || 'none'; // アプリに入っている接続先は使わない
require('../main.js');
const sampleAi = require('../sample-ai.js');
global.__noRelaunch = true; // 「このPCのデータを消す」で、テスト中のアプリを起動し直さない
global.__mockUpdate = (current) => ({ ok: true, current, latest: '99.0.0', newer: true, url: 'https://github.com/TAK0-wasa/ShipLab-Hackathon-2026/releases/latest' });
let failTask = ''; // この段階でAIを失敗させる（止まった会議の再開の確認用）
global.__mockLlm = async (req) => {
  const task = (/【タスク:(\w+)】/.exec(req.messages[0].content) || [])[1] || '';
  if (failTask && task === failTask) throw new Error('Claude APIエラー (403) テスト用の失敗');
  return sampleAi(req);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  await sleep(1500);
  const win = BrowserWindow.getAllWindows()[0];
  const wc = win.webContents;
  const errors = [];
  wc.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) errors.push(e.message); });
  const js = (code) => wc.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(outDir, name + '.png'), (await wc.capturePage()).toPNG());
  const click = (text) => js(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(text)}) && !b.disabled); if (!b) throw new Error('ボタンなし: ' + ${JSON.stringify(text)}); b.click(); })()`);
  // 上部の進み具合（1 考えを預ける／2 会議と結果）のボタンを、並び順で押す
  const nav = (i) => js(`(() => { const b = document.querySelectorAll('#nav button')[${i}]; if (!b || b.disabled) throw new Error('上部のボタンなし: ' + ${i}); b.click(); })()`);
  const type = (sel, text) => js(`(() => { const t = document.querySelector(${JSON.stringify(sel)}); if (!t) throw new Error('入力欄なし: ' + ${JSON.stringify(sel)}); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const text = (sel) => js(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ''`);
  const need = async (sel, words, label) => { const t = await text(sel); for (const w of words) if (!t.includes(w)) throw new Error(`${label}: 「${w}」が見つからない → ${t.slice(0, 160)}`); };
  const until = async (fn, label, ms) => { for (let i = 0; i < (ms || 40000) / 250; i++) { if (await fn()) return; await sleep(250); } throw new Error('待っても変わらない: ' + label); };
  const idle = () => until(async () => !(await js(`!!document.querySelector('#status .spin') || [...document.querySelectorAll('.bubble')].some(b => b.textContent === '…')`)), '処理中のまま');
  const openTools = async () => { await click('設定・招待'); await sleep(300); await js(`document.querySelector('#s-tools').open = true`); await sleep(200); };
  const tclick = (t) => js(`(() => { const b = [...document.querySelectorAll('#s-tools button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(t)}) && !b.disabled); if (!b) throw new Error('ボタンなし: ' + ${JSON.stringify(t)}); b.click(); })()`);
  const closeOverlay = () => js(`(() => { const o = document.querySelector('#overlay.show'); if (o) { o.className = ''; o.replaceChildren(); } })()`);
  const phase = () => js(`(async () => { const all = await api.store.all(); const s = all.find((d) => d.kind === 'state' && d.id === 'main'); return s ? s.data.phase : ''; })()`);
  try {
    // 0. はじめの画面: データの扱いが読める。新しい版のお知らせが出る
    await need('#view', ['データの扱い'], 'はじめの画面');
    await js(`document.querySelector('details.startnote').open = true`); await sleep(200);
    await need('#datanote', ['Anthropic', '招待コードを知っている人は読める', 'このPCにだけ保存'], 'データの扱いの説明');
    await until(async () => !!(await js(`!!document.querySelector('#updbtn')`)), '新しい版のお知らせが出ない', 8000);

    // 1. 会議を作って、自分の分を預ける
    await click('代表者として始める'); await sleep(300);
    await type('#c-name', 'りょうま');
    await type('#c-theme', 'かゆいところに手が届くアプリ');
    await type('#c-criteria', 'テーマに合っているか\n新しさがあるか ×2');
    await js(`window.api.saveConfig({ demo: true })`);
    await click('会議を作る'); await sleep(1200);
    if (await js(`document.querySelector('#s-tools').open`)) throw new Error('困ったときが最初から開いている');
    if ((await text('#view')).includes('サンプルで埋める') || (await text('#view')).includes('預ける前に戻す')) throw new Error('デモ用の機能が残っている');
    await need('#sec-leader', ['代表者の操作', 'まだほかのメンバーは参加していません', 'この会議のデータをすべて削除する'], '代表者の操作');
    await need('#sec-about', ['このアプリについて', '更新を確認する', '不具合を報告する', 'このPCのデータを消す'], 'このアプリについて');
    await click('更新を確認する'); await idle(); await sleep(300);
    await need('#upd', ['新しい版 v99.0.0 があります'], '更新の確認');
    await nav(0); await sleep(300);
    for (const msg of ['集まらなくても案が決まるアプリを作りたい', '実体験から話せるところが好き。デモが見せにくいのが不安。', '締切までに確実に動くこと', '画面を担当できる。平日の夜に3時間使える']) {
      await type('#chatInput', msg); await click('送信'); await idle();
    }
    // 声で入力: マイクボタンで Windows の音声入力を起動する（テストでは起動の呼び出しだけ確かめる）
    let voiceCalls = 0;
    global.__mockVoice = () => { voiceCalls++; return { ok: true }; };
    await js(`document.querySelector('#micBtn').click()`); await sleep(400);
    await need('#status', ['音声入力を始めました'], '声で入力');
    if (voiceCalls !== 1 || !(await js(`document.activeElement && document.activeElement.id === 'chatInput'`))) throw new Error('声で入力のあと、入力欄にカーソルが無い');
    global.__mockVoice = () => ({ ok: false, msg: 'チャット欄をクリックしてから、キーボードの「Windowsキー＋H」を押すと、音声入力を始められます。' });
    await js(`document.querySelector('#micBtn').click()`); await sleep(400);
    await need('#status', ['Windowsキー＋H'], '声で入力が使えないときの案内');
    await click('預ける内容を確認する'); await idle();
    await click('この内容で預ける'); await idle(); await sleep(300);

    // 2. 接続の診断
    await openTools();
    await tclick('接続を診断する'); await idle(); await sleep(300);
    await need('#diag', ['問題は見つかりませんでした', 'ネットワーク', 'このPCだけ', '見本モード'], '診断の結果');
    global.__mockDiag = () => ({ ok: false, at: Date.now(), steps: [
      { label: 'ネットワーク', ok: true, detail: 'プロキシ経由でつなぎます（PROXY wwwproxy.example:8080）', hint: '', ms: 3 },
      { label: '共有データベースを読む', ok: true, detail: '12件のデータを読めました', hint: '', ms: 420 },
      { label: 'AIのサーバー', ok: false, detail: 'サーバーにClaudeのAPIキーが登録されていません', hint: 'Secrets に ANTHROPIC_API_KEY を登録してください。', ms: 300 },
    ] });
    await tclick('接続を診断する'); await idle(); await sleep(300);
    await need('#diag', ['通らないところがあります', 'プロキシ経由', 'APIキーが登録されていません', 'ANTHROPIC_API_KEY'], '診断の結果（失敗あり）');
    await shot('t1-diag');
    global.__mockDiag = null;

    // 3. ほかの2人が預ける → 会議が途中（合体案づくり）で止まる → 止まった案内 → 続きから再開
    failTask = 'merge';
    await js(`(async () => {
      const mk = (title, feature) => ({ ideas: [{ title, summary: title + 'の説明', target: { text: '学生', by: 'me' }, problem: { text: '', by: 'ai' }, feature: { text: feature, by: 'me' }, push: 'normal' }], likes: 'すぐ伝わる', worries: '新しさが弱い', mustHaves: ['実際に動くこと'], wantFromOthers: '', acceptCondition: '', impl: '', updates: [] });
      await api.store.put('member', 'm-aoi', { name: 'あおい', deposited: true });
      await api.store.put('member', 'm-kenta', { name: 'けんた', deposited: true });
      await api.store.put('brief', 'm-aoi', mk('講義メモ自動停止', '入力中は動画を止める'));
      await api.store.put('brief', 'm-kenta', mk('レシート割り勘', 'レシート撮影で各自の金額'));
    })()`);
    await until(async () => { await nav(1).catch(() => {}); await sleep(300); return js(`!!document.querySelector('#sec-fail')`); }, '止まったことが画面に出ない', 60000);
    await need('#sec-fail', ['会議が途中で止まりました', '403', '続きから再開する', '最初からやり直す'], '止まったときの案内');
    if ((await text('#sec-fail')).includes('Error invoking')) throw new Error('止まった理由に、内部の文言が混ざっている');
    await need('#turn', ['会議が途中で止まっています'], '止まっているときの帯');
    await shot('t3-failed');
    const nCalls = () => js(`(async () => (await api.store.all()).filter((d) => d.kind === 'call').length)()`);
    const callsBefore = await nCalls();
    await sleep(9000);
    if ((await nCalls()) !== callsBefore || (await phase()) !== 'collecting') throw new Error('止まったあと、自動で会議を繰り返している');
    failTask = '';
    await click('続きから再開する');
    await until(async () => (await phase()) === 'review', '再開しても会議が終わらない', 90000);
    await idle(); await sleep(400);
    if (await js(`!!document.querySelector('#sec-fail')`)) throw new Error('終わったのに、止まった案内が残っている');
    let all = JSON.parse(await js(`(async () => JSON.stringify(await api.store.all()))()`));
    if (!JSON.stringify(all).includes('止まったところから、会議を再開します')) throw new Error('再開したことが発言の記録に出ていない');
    if (all.filter((d) => d.kind === 'call' && d.data.task === 'round1').length !== 3) throw new Error('再開で、1回目の発言をやり直している');

    // 4. 全員が承認して決定 → 代表者が決定を取り消す → 承認待ちに戻る
    await js(`(async () => { const st = (await api.store.all()).find((d) => d.kind === 'state').data; for (const id of ['m-aoi', 'm-kenta']) await api.store.put('approval', id, { round: st.round, ok: true, at: Date.now(), candId: st.recommendation.topId }); })()`);
    await sleep(4500);
    await click('この案を承認する'); await sleep(1500);
    await until(async () => (await phase()) === 'decided', '決定にならない', 20000);
    await closeOverlay(); await sleep(300);
    await click('決定を取り消して、話し合いに戻す'); await sleep(200);
    await click('本当に取り消す'); await idle(); await sleep(500);
    if ((await phase()) !== 'review') throw new Error('決定を取り消しても、承認待ちに戻らない');
    // 決定すると共有の保存先から本音が消える。取り消すと、自分の分はこの端末から自動で預け直される
    {
      const b = JSON.parse(await js(`(async () => JSON.stringify((await api.store.all()).filter((d) => d.kind === 'brief').map((d) => [d.id, !!d.data.scrubbed, d.data.likes || ''])))()`));
      const mine = b.find((x) => !/^m-/.test(x[0]));
      if (!mine || mine[1] || !mine[2]) throw new Error('決定を取り消しても、自分の預かりメモが戻っていない: ' + JSON.stringify(b));
      if (!b.filter((x) => /^m-/.test(x[0])).every((x) => x[1] && !x[2])) throw new Error('決定後に、ほかの人の本音が保存先に残っている: ' + JSON.stringify(b));
    }
    // ほかの2人は、それぞれのアプリを開いたときに預け直される（ここでは同じ内容を入れ直して再現する）
    await js(`(async () => {
      const mk = (title, feature) => ({ ideas: [{ title, summary: title + 'の説明', target: { text: '学生', by: 'me' }, problem: { text: '', by: 'ai' }, feature: { text: feature, by: 'me' }, push: 'normal' }], likes: 'すぐ伝わる', worries: '新しさが弱い', mustHaves: ['実際に動くこと'], wantFromOthers: '', acceptCondition: '', impl: '', updates: [] });
      await api.store.put('brief', 'm-aoi', mk('講義メモ自動停止', '入力中は動画を止める'));
      await api.store.put('brief', 'm-kenta', mk('レシート割り勘', 'レシート撮影で各自の金額'));
    })()`);
    await need('#view', ['承認 0 / 3 人', 'この案を承認する'], '取り消したあとの承認の欄');
    await shot('t4-reopened');

    // 5. メンバーを外す → その人の内容が消え、残った2人で会議をやり直す
    await click('設定・招待'); await sleep(300);
    await need('#sec-leader', ['あおい', 'けんた', '預け済み'], 'メンバーの一覧');
    await js(`[...document.querySelectorAll('#sec-leader .mrow')].find((r) => r.textContent.includes('けんた')).querySelector('button').click()`); await sleep(200);
    await js(`[...document.querySelectorAll('#sec-leader button')].find((b) => b.textContent.trim() === '本当に外す').click()`); await sleep(1500);
    await until(async () => (await phase()) === 'review', '外したあと、残った人で会議が進まない', 90000);
    await idle();
    all = JSON.parse(await js(`(async () => JSON.stringify(await api.store.all()))()`));
    if (all.some((d) => d.id === 'm-kenta' || (d.kind === 'eval' && d.id.startsWith('m-kenta')))) throw new Error('外した人のデータが残っている');
    const st5 = all.find((d) => d.kind === 'state').data;
    if (st5.participants.length !== 2) throw new Error('残った2人の会議になっていない');
    if (!(all.find((d) => d.kind === 'room').data.removed || []).includes('m-kenta')) throw new Error('外した人の記録が無い');

    // 6. 会議のデータをすべて削除 → 共有の保存先が空になり、はじめの画面に戻る
    await click('設定・招待'); await sleep(300);
    await click('この会議のデータをすべて削除する'); await sleep(200);
    await click('本当に削除する'); await sleep(2000);
    await need('#view', ['会議を作る', '招待コードで参加する'], '削除したあとのはじめの画面');
    await need('#status', ['会議のデータをすべて削除しました'], '削除のお知らせ');
    const cfgAfter = await js(`window.api.getConfig()`);
    if (cfgAfter.room || (cfgAfter.rooms || []).length) throw new Error('削除した会議が一覧に残っている');
    const shared = path.join(tmp, 'ai-dairinin-kaigi-shared');
    const left = fs.existsSync(shared) ? fs.readdirSync(shared).map((f) => fs.readFileSync(path.join(shared, f), 'utf8')).join('') : '';
    if (/brief|cand|member|msg/.test(left)) throw new Error('共有の保存先に、会議のデータが残っている: ' + left.slice(0, 200));
    await shot('t5-deleted');

    // 7. このPCのデータを消す
    const ud = app.getPath('userData');
    if (!fs.readdirSync(ud).some((f) => f === 'config.json' || f.startsWith('private-'))) throw new Error('消す前の設定ファイルが見つからない');
    await js(`window.api.wipeLocal()`); await sleep(500);
    if (fs.readdirSync(ud).some((f) => f === 'config.json' || f.startsWith('private-'))) throw new Error('このPCのデータが消えていない');

    if (errors.length) throw new Error('コンソールエラー: ' + errors.join(' / '));
    console.log('TOOLS SMOKE OK', outDir);
    app.exit(0);
  } catch (e) {
    await shot('t-error').catch(() => {});
    console.error('TOOLS SMOKE NG', e.message, errors);
    app.exit(1);
  }
});
