// はじめの画面 → 会議を作る（見本モード）→ 預ける → 代表者のアプリが自動で会議 → 抜ける → 招待コードで参加（APIキーなし・フォーム入力）
// 実行: npx electron test/smoke-start.js （スクリーンショットの出力先は環境変数 SMOKE_OUT）
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-start-'));
const outDir = process.env.SMOKE_OUT ? path.resolve(process.env.SMOKE_OUT) : tmp;
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'user'));
fs.mkdirSync(outDir, { recursive: true });
process.env.KAWARINI_DB = process.env.KAWARINI_DB || 'none'; // アプリに入っている接続先は使わない
require('../main.js');

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
  try {
    // 1. はじめの画面
    await need('#view', ['会議を作る', '招待コードで参加する'], 'はじめの画面');
    await shot('s1-start');
    await click('代表者として始める'); await sleep(300);
    await type('#c-name', 'りょうま');
    await type('#c-theme', 'かゆいところに手が届くアプリ');
    await type('#c-criteria', 'テーマに合っているか\n新しさがあるか ×2\n完成度・実際に動くか');
    await js(`window.api.saveConfig({ demo: true })`); // 見本モードは設定の奥にあるので、テストでは直接入れる
    await shot('s2-create');
    await click('会議を作る'); await sleep(1200);
    await need('#view', ['招待コード', '代表者： りょうま', '見本モード'], '作成後の設定画面');
    if (await js(`document.querySelector('#s-more').open || document.querySelector('#s-key').checkVisibility()`)) throw new Error('上級者向けの設定が最初から開いている');
    await need('#who', ['りょうま（代表者）', '見本モード', 'このPCだけ'], 'ヘッダー');
    await need('#switch', ['会議：', 'かゆいところに手が届くアプリ'], '会議の切り替えボタン');
    if (await js(`!!document.querySelector('#side')`)) throw new Error('左側の一覧が残っている');
    const code = await js(`document.querySelector('#s-invite').value`);
    if (!code.startsWith('AIDK1.')) throw new Error('招待コードの形が違う: ' + code);
    await shot('s3-invite');

    // 2. 個室で代理人（見本）と会話して預ける
    await nav(0); await sleep(300);
    for (const msg of ['集まらなくても案が決まるアプリを作りたい', '実体験から話せるところが好き。デモが見せにくいのが不安。', '締切までに確実に動くこと', '画面を担当できる。平日の夜に2時間ずつ使える']) {
      await type('#chatInput', msg); await click('送信'); await idle();
    }
    await need('.todo', ['内容を確認して預ける', '聞き取りが終わりました'], 'いまやること');
    if ((await js(`document.querySelectorAll('.todo .checks li.ok').length`)) !== 4) throw new Error('聞き取りの4項目に済みの印が付いていない');
    await click('預ける内容を確認する'); await idle();
    await need('.side', ['預ける内容の確認', '締切までに確実に動くこと'], '確認画面');
    // 2.5 預ける前に手直しする
    await click('手直しする'); await sleep(300);
    await need('#sec-edit', ['預ける内容を手直しする', '案の名前', '納得の条件'], '手直しの画面');
    await type('#e-title0', '集まらず決まる会議アプリ');
    await shot('s3b-edit');
    await click('手直しを反映する'); await sleep(300);
    await need('.side', ['預ける内容の確認', '集まらず決まる会議アプリ', '締切までに確実に動くこと'], '手直し後の確認画面');
    await click('この内容で預ける'); await idle();
    // 2.6 預けたあとは会議室に移り、待ちの状況が出る
    await sleep(300);
    await need('#sec-wait', ['あなたの考えを預かりました', 'あと2人', '全員がそろうのを待つ', 'まだ参加していない人', '待っている間にできること'], '預けたあとの待ちの表示');
    await shot('s3c-wait');

    // 3. ほかの2人がフォームで預けた、という状態を作る → 代表者のアプリが自動で会議を進める
    await js(`(async () => {
      const mk = (title, feature) => ({ ideas: [{ title, summary: title + 'の説明', target: { text: '学生', by: 'me' }, problem: { text: '', by: 'ai' }, feature: { text: feature, by: 'me' }, push: 'normal' }], likes: 'すぐ伝わる', worries: '新しさが弱い', mustHaves: ['実際に動くこと'], wantFromOthers: '', acceptCondition: '', impl: 'JavaScriptが書ける', updates: [] });
      await api.store.put('member', 'm-aoi', { name: 'あおい', deposited: true });
      await api.store.put('member', 'm-kenta', { name: 'けんた', deposited: true });
      await api.store.put('brief', 'm-aoi', mk('講義メモ自動停止', '入力中は動画を止める'));
      await api.store.put('brief', 'm-kenta', mk('レシート割り勘', 'レシート撮影で各自の金額'));
    })()`);
    await until(async () => (await text('#status')).includes('会議') || !!(await js(`!!document.querySelector('.card.live')`)), '会議が自動で始まらない', 15000);
    await nav(1);
    // 会議中は、段階と「開始から◯秒」が出て、1秒ごとに進む
    await until(async () => !!(await js(`!!document.querySelector('#liveElapsed')`)), '会議中の経過時間が出ない', 15000);
    const e1 = await text('#liveElapsed'); await sleep(2200); const e2 = await text('#liveElapsed');
    if (!e2 || e1 === e2) throw new Error('経過時間が進まない: ' + e1 + ' → ' + e2);
    await need('.livetime', ['段階め', '開始から', 'あと約', '分で終わります'], '会議中の時間の案内');
    await shot('s4-live');
    await until(async () => (await text('#view')).includes('推薦案（第1回の議論）'), '推薦が出ない', 60000);
    await idle();
    await js(`document.querySelectorAll('details').forEach((d) => (d.open = true))`); await sleep(300);
    await need('#view', ['/70 ＋ 支持 ', 'AIの新案', '実行記録（第1回：AIの呼び出し11回', '技術的に作れるか', 'AIの知識による判断（検索なし）', '【見本】', '新しさがあるか ×2：', '案のどの記述からこの点にしたか', '次点「', 'との差：', '点数からそのまま計算した内訳です'], '会議の結果');
    // 3.1 案の一覧は、1案1行の表（点数の高い順。推薦が1位。行を押すと詳細）
    const rows = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('details.crow')].map((d) => ({ no: d.querySelector('.cno').innerText, top: d.classList.contains('top'), score: (d.querySelector('.cscore b') || {}).innerText || '' })))`));
    if (rows.length < 4 || rows[0].no !== '1' || !rows[0].top || rows.filter((r) => r.top).length !== 1) throw new Error('案の表の並びがおかしい: ' + JSON.stringify(rows));
    const scores = rows.filter((r) => /^\d+$/.test(r.no)).map((r) => Number(r.score));
    if (scores.some((v, i) => i && v > scores[i - 1])) throw new Error('案が点数の高い順に並んでいない: ' + scores.join(','));
    await need('details.fold', ['すべての案をくらべる', 'メンバーの案 3', 'AIの新案 1'], '案の表の見出し');
    // 3.2 代理人からの確認に答える場所は「② 会議と結果」だけ。「① 考えを預ける」には案内だけが出る
    if (!(await js(`!!document.querySelector('#sec-q')`))) throw new Error('会議と結果に、確認の欄が無い');
    await nav(0); await sleep(400);
    await need('#sec-qlink', ['代理人から確認が', '確認に答える'], '確認の案内');
    if (await js(`!!document.querySelector('#sec-q') || !!document.querySelector('.side .q textarea')`)) throw new Error('考えを預ける画面に、確認の回答欄が残っている');
    await shot('s5d-qlink');
    await click('確認に答える'); await sleep(500);
    if (!(await js(`!!document.querySelector('#sec-q textarea')`))) throw new Error('案内から、確認の欄に移れない');
    win.setContentSize(1180, 1500); await sleep(300);
    await shot('s5-result');
    win.setContentSize(1180, 820);

    // 3.5 2つ目の会議を作る → メニューに2つ並び、中身は混ざらない → 1つ目に戻れて、番の印が付く
    const openMenu = async () => { if (!(await js(`!!document.querySelector('.swmenu')`))) { await click('会議：'); await sleep(200); } };
    const pick = async (word) => { await openMenu(); await js(`[...document.querySelectorAll('.swmenu .mitem')].find((b) => b.textContent.includes(${JSON.stringify(word)})).click()`); await sleep(1500); };
    await openMenu();
    await need('.swmenu', ['参加している会議', 'かゆいところに手が届くアプリ', '表示中', '新しい会議を作る', '招待コードで参加する'], '切り替えメニュー');
    await shot('s5a-menu');
    await click('新しい会議を作る'); await sleep(300);
    await type('#c-theme', 'お別れ会の店決め');
    await js(`window.api.saveConfig({ demo: true })`); // 見本モードは設定の奥にあるので、テストでは直接入れる
    await click('会議を作る'); await sleep(1500);
    await need('#switch', ['お別れ会の店決め'], '2つ目の会議に切り替わる');
    await nav(0); await sleep(300);
    if ((await js(`document.querySelectorAll('.bubble').length`)) !== 1) throw new Error('2つ目の会議の個室に、1つ目の会話が混ざっている');
    await nav(1); await sleep(300);
    const m2 = await text('#view');
    if (m2.includes('推薦案') || m2.includes('講義メモ自動停止')) throw new Error('2つ目の会議に、1つ目の会議の中身が混ざっている');
    await until(async () => !!(await js(`!!document.querySelector('#switch .swbtn .dot')`)), '別の会議の「あなたの番」の印が付かない', 20000);
    await openMenu();
    await need('.swmenu', ['かゆいところに手が届くアプリ', 'お別れ会の店決め'], 'メニューに2つ並ぶ');
    await shot('s5b-two-rooms');
    await pick('かゆいところ');
    await need('#switch', ['かゆいところに手が届くアプリ'], '1つ目に戻る');
    await need('#view', ['推薦案（第1回の議論）'], '1つ目の会議の中身');
    await click('設定・招待'); await sleep(300);
    const code1 = await js(`document.querySelector('#s-invite').value`);
    if (code1 !== code) throw new Error('1つ目の会議の招待コードが変わっている');
    // 2つ目から抜けて、会議が1つだけの状態に戻す
    await pick('お別れ会');
    await click('設定・招待'); await sleep(300);
    await click('この会議から抜ける'); await sleep(1200);
    await need('#switch', ['かゆいところに手が届くアプリ'], '抜けたあとは残りの会議に切り替わる');
    await openMenu();
    if ((await text('.swmenu')).includes('お別れ会')) throw new Error('抜けた会議が一覧に残っている');
    await js(`document.body.click()`); await sleep(200);
    if (await js(`!!document.querySelector('.swmenu')`)) throw new Error('メニューが外側のクリックで閉じない');
    await click('設定・招待'); await sleep(300);

    // 4. 抜けて、招待コードで参加し直す（APIキーなし・見本モードなし → フォーム入力）
    await click('設定・招待'); await sleep(300);
    await click('この会議から抜ける'); await sleep(500);
    await need('#view', ['会議を作る', '招待コードで参加する'], '抜けたあと');
    await click('メンバーとして参加する'); await sleep(300);
    await need('#view', ['あなたの名前', '招待コード'], '参加画面');
    if (await js(`!!document.querySelector('#j-key') || document.querySelector('#view').innerText.includes('APIキー')`)) throw new Error('参加画面にAPIキーの欄が残っている');
    await shot('s5c-join');
    await type('#j-name', 'りょうま');
    await type('#j-code', 'でたらめ');
    await click('参加する'); await sleep(400);
    await need('#status', ['招待コードの形が違います'], '不正な招待コード');
    await type('#j-code', code);
    await js(`window.api.saveConfig({ demo: false })`);
    await click('参加する'); await sleep(1500);
    await need('#who', ['りょうま（代表者）'], '参加後のヘッダー');
    await need('.chat', ['AIのサーバーが使えない', '案の名前', '外したくない条件'], '入力フォーム');
    await type('.formbody textarea', '発表タイマー');
    await js(`(() => { const ts = document.querySelectorAll('.formbody textarea'); ts[1].value = '発表の残り時間を教える'; ts[1].dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await shot('s6-form');
    await click('内容を確認する'); await sleep(400);
    await need('.side', ['預ける内容の確認', '発表タイマー', 'AIが補完'], 'フォームからの確認画面');
    await click('この内容で預ける'); await idle(); await sleep(300);
    await need('#status', ['代表者のアプリが開いているとき'], 'キーなしで預けたあとの案内');

    // 5. 預けたあとに手直しして、預け直す
    await nav(0); await sleep(300);
    await need('.side', ['代理人に預け済み', '発表タイマー'], '預け済みの表示');
    await click('手直しする'); await sleep(300);
    await click('手直しを反映する'); await sleep(300);
    await need('#status', ['変更はありませんでした'], '何も変えずに反映');
    await click('手直しする'); await sleep(300);
    await type('#e-title0', '発表タイマー改');
    await js(`[...document.querySelectorAll('#sec-edit button')].find((b) => b.textContent.includes('案をもう1つ足す')).click()`); await sleep(200);
    await type('#e-title1', '質疑メモ');
    await click('手直しを反映する'); await sleep(300);
    await need('.side', ['預ける内容の確認', '発表タイマー改', '質疑メモ'], '預け直しの確認画面');
    await click('この内容で預ける'); await idle(); await sleep(300);
    await nav(0); await sleep(300);
    await need('.side', ['代理人に預け済み', '発表タイマー改', '質疑メモ'], '預け直したあと');
    const saved = await js(`(async () => { const all = await api.store.all(); return JSON.stringify(all); })()`);
    if (!saved.includes('発表タイマー改') || !saved.includes('editedAt')) throw new Error('預け直しが共有データに入っていない');
    await shot('s7-edited');

    if (errors.length) throw new Error('コンソールエラー: ' + errors.join(' / '));
    console.log('START SMOKE OK', outDir);
    app.exit(0);
  } catch (e) {
    await shot('s-error').catch(() => {});
    console.error('START SMOKE NG', e.message, errors);
    app.exit(1);
  }
});
