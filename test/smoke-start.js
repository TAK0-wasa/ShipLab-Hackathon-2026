// はじめの画面 → 会議を作る（見本モード）→ 預ける → 幹事のアプリが自動で会議 → 抜ける → 招待コードで参加（APIキーなし・フォーム入力）
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
  const type = (sel, text) => js(`(() => { const t = document.querySelector(${JSON.stringify(sel)}); if (!t) throw new Error('入力欄なし: ' + ${JSON.stringify(sel)}); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const text = (sel) => js(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ''`);
  const need = async (sel, words, label) => { const t = await text(sel); for (const w of words) if (!t.includes(w)) throw new Error(`${label}: 「${w}」が見つからない → ${t.slice(0, 160)}`); };
  const until = async (fn, label, ms) => { for (let i = 0; i < (ms || 40000) / 250; i++) { if (await fn()) return; await sleep(250); } throw new Error('待っても変わらない: ' + label); };
  const idle = () => until(async () => !(await js(`!!document.querySelector('#status .spin') || [...document.querySelectorAll('.bubble')].some(b => b.textContent === '…')`)), '処理中のまま');
  try {
    // 1. はじめの画面
    await need('#view', ['会議を作る', '招待コードで参加する'], 'はじめの画面');
    await shot('s1-start');
    await click('幹事として始める'); await sleep(300);
    await type('#c-name', 'りょうま');
    await type('#c-theme', 'かゆいところに手が届くアプリ');
    await type('#c-criteria', 'テーマに合っているか\n新しさがあるか ×2\n完成度・実際に動くか');
    await js(`document.querySelector('#c-demo').checked = true`);
    await shot('s2-create');
    await click('会議を作る'); await sleep(1200);
    await need('#view', ['招待コード', '幹事： りょうま', '見本モード'], '作成後の設定画面');
    await need('#who', ['# かゆいところに手が届くアプリ', 'りょうま（幹事）', '見本モード', 'このPCだけ'], 'ヘッダー');
    await need('#side', ['参加中の会議', 'かゆいところに手が届くアプリ', '＋ 会議を作る', '＋ 招待コードで参加'], '会議の一覧');
    const code = await js(`document.querySelector('#s-invite').value`);
    if (!code.startsWith('AIDK1.')) throw new Error('招待コードの形が違う: ' + code);
    await shot('s3-invite');

    // 2. 個室で代理人（見本）と会話して預ける
    await click('個室'); await sleep(300);
    for (const msg of ['集まらなくても案が決まるアプリを作りたい', '実体験から話せるところが好き。デモが見せにくいのが不安。', '締切までに確実に動くこと', '画面を担当できる。平日の夜に2時間ずつ使える']) {
      await type('#chatInput', msg); await click('送信'); await idle();
    }
    await need('.chat-head', ['✓ 案', '✓ 実装でできること', '聞き取りは済みました'], '進み具合');
    await click('預ける'); await idle();
    await need('.side', ['預ける内容の確認', '締切までに確実に動くこと'], '確認画面');
    await click('この内容で預ける'); await idle();

    // 3. ほかの2人がフォームで預けた、という状態を作る → 幹事のアプリが自動で会議を進める
    await js(`(async () => {
      const mk = (title, feature) => ({ ideas: [{ title, summary: title + 'の説明', target: { text: '学生', by: 'me' }, problem: { text: '', by: 'ai' }, feature: { text: feature, by: 'me' }, push: 'normal' }], likes: 'すぐ伝わる', worries: '新しさが弱い', mustHaves: ['実際に動くこと'], wantFromOthers: '', acceptCondition: '', impl: 'JavaScriptが書ける', updates: [] });
      await api.store.put('member', 'm-aoi', { name: 'あおい', deposited: true });
      await api.store.put('member', 'm-kenta', { name: 'けんた', deposited: true });
      await api.store.put('brief', 'm-aoi', mk('講義メモ自動停止', '入力中は動画を止める'));
      await api.store.put('brief', 'm-kenta', mk('レシート割り勘', 'レシート撮影で各自の金額'));
    })()`);
    await until(async () => (await text('#status')).includes('会議') || !!(await js(`!!document.querySelector('.card.live')`)), '会議が自動で始まらない', 15000);
    await click('会議室'); await sleep(500);
    await shot('s4-live');
    await until(async () => (await text('#view')).includes('推薦案（第1回の議論）'), '推薦が出ない', 60000);
    await idle();
    await js(`document.querySelectorAll('details').forEach((d) => (d.open = true))`); await sleep(300);
    await need('#view', ['/70 ＋ 支持 ', 'AIの新案', '実行記録（第1回：AIの呼び出し9回', '【見本】', '新しさがあるか ×2：'], '会議の結果');
    win.setContentSize(1180, 1500); await sleep(300);
    await shot('s5-result');
    win.setContentSize(1180, 820);

    // 3.5 2つ目の会議を作る → 一覧に2つ並び、中身は混ざらない → 1つ目に戻れて、番の印が付く
    await click('＋ 会議を作る'); await sleep(300);
    await type('#c-theme', 'お別れ会の店決め');
    await js(`document.querySelector('#c-demo').checked = true`);
    await click('会議を作る'); await sleep(1500);
    await need('#side', ['かゆいところに手が届くアプリ', 'お別れ会の店決め'], '会議の一覧');
    await need('#who', ['# お別れ会の店決め'], '2つ目の会議の見出し');
    await click('個室'); await sleep(300);
    if ((await js(`document.querySelectorAll('.bubble').length`)) !== 1) throw new Error('2つ目の会議の個室に、1つ目の会話が混ざっている');
    await click('会議室'); await sleep(300);
    const m2 = await text('#view');
    if (m2.includes('推薦案') || m2.includes('講義メモ自動停止')) throw new Error('2つ目の会議に、1つ目の会議の中身が混ざっている');
    await until(async () => !!(await js(`!!document.querySelector('#side .sideitem:not(.on) .dot')`)), '別の会議の「あなたの番」の印が付かない', 20000);
    await shot('s5b-two-rooms');
    await js(`[...document.querySelectorAll('#side .sideitem')].find((b) => b.textContent.includes('かゆいところ')).click()`); await sleep(1500);
    await need('#who', ['# かゆいところに手が届くアプリ'], '1つ目に戻ったあとの見出し');
    await need('#view', ['推薦案（第1回の議論）'], '1つ目の会議の中身');
    await click('設定'); await sleep(300);
    const code1 = await js(`document.querySelector('#s-invite').value`);
    if (code1 !== code) throw new Error('1つ目の会議の招待コードが変わっている');
    // 2つ目から抜けて、会議が1つだけの状態に戻す
    await js(`[...document.querySelectorAll('#side .sideitem')].find((b) => b.textContent.includes('お別れ会')).click()`); await sleep(1200);
    await click('設定'); await sleep(300);
    await click('この会議から抜ける'); await sleep(1200);
    await need('#who', ['# かゆいところに手が届くアプリ'], '抜けたあとは残りの会議に切り替わる');
    if ((await text('#side')).includes('お別れ会')) throw new Error('抜けた会議が一覧に残っている');
    await click('設定'); await sleep(300);

    // 4. 抜けて、招待コードで参加し直す（APIキーなし・見本モードなし → フォーム入力）
    await click('設定'); await sleep(300);
    await click('この会議から抜ける'); await sleep(500);
    await need('#view', ['会議を作る', '招待コードで参加する'], '抜けたあと');
    await click('メンバーとして参加する'); await sleep(300);
    await type('#j-name', 'りょうま');
    await type('#j-code', 'でたらめ');
    await click('参加する'); await sleep(400);
    await need('#status', ['招待コードの形が違います'], '不正な招待コード');
    await type('#j-code', code);
    await js(`document.querySelector('#j-demo').checked = false`);
    await click('参加する'); await sleep(1500);
    await need('#who', ['りょうま（幹事）'], '参加後のヘッダー');
    await need('.chat', ['APIキーなしで参加している', '案の名前', '外したくない条件'], '入力フォーム');
    await type('.formbody textarea', '発表タイマー');
    await js(`(() => { const ts = document.querySelectorAll('.formbody textarea'); ts[1].value = '発表の残り時間を教える'; ts[1].dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await shot('s6-form');
    await click('内容を確認する'); await sleep(400);
    await need('.side', ['預ける内容の確認', '発表タイマー', 'AIが補完'], 'フォームからの確認画面');
    await click('この内容で預ける'); await idle(); await sleep(300);
    await need('#status', ['幹事のアプリが開いているとき'], 'キーなしで預けたあとの案内');

    if (errors.length) throw new Error('コンソールエラー: ' + errors.join(' / '));
    console.log('START SMOKE OK', outDir);
    app.exit(0);
  } catch (e) {
    await shot('s-error').catch(() => {});
    console.error('START SMOKE NG', e.message, errors);
    app.exit(1);
  }
});
