// Web版（web/index.html）: 土台を web/web-api.js に替えても、会議を作る → 預ける → 会議 → 推薦 まで動くことを確かめる
// 実行: node web/build.js のあと npx electron test/smoke-web.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-web-'));
const outDir = process.env.SMOKE_OUT ? path.resolve(process.env.SMOKE_OUT) : tmp;
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'user'));
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1180, height: 820, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(__dirname, '..', 'web', 'index.html'), { query: { db: 'none' } });
  await sleep(800);
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
    // 1. はじめの画面。Web版の土台（window.api）で動いていて、デスクトップ専用のものは出ない
    if (!(await js(`window.WEB === true && !!window.api && !window.api.voiceStart && !window.api.checkUpdate`))) throw new Error('Web版の土台が入っていない');
    await need('#view', ['会議を作る', '招待コードで参加する', '代理人', '預ける'], 'はじめの画面');
    await click('幹事として始める'); await sleep(300);
    await type('#c-name', 'りょうま');
    await type('#c-theme', 'かゆいところに手が届くアプリ');
    await click('ハッカソン・コンテスト');
    await js(`window.api.saveConfig({ demo: true }).then(() => true)`);
    await click('会議を作る'); await sleep(1200);
    await need('#view', ['招待コード', '幹事： りょうま', '見本モード', 'この端末'], '作成後の設定画面');
    if ((await text('#view')).includes('このPC')) throw new Error('「このPC」という言い方が残っている');
    if (await js(`!!document.querySelector('#s-key')`)) throw new Error('Web版にAPIキーの入力欄が出ている');
    if ((await text('#sec-about')).includes('更新を確認する')) throw new Error('Web版に「更新を確認する」が出ている');
    await need('#who', ['りょうま（幹事）', '見本モード', 'v' + require('../package.json').version], 'ヘッダー');
    await shot('w1-settings');
    // 招待の文は、開くだけでコードが入るリンクつき
    await js(`Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied = t; } }, configurable: true }); true`);
    await click('招待の文とリンクをコピー'); await sleep(200);
    const inv = await js(`window.__copied || ''`);
    if (!/#join=/.test(inv) || !inv.includes('インストールは不要')) throw new Error('招待の文にリンクがない: ' + inv.slice(0, 120));

    // 2. 代理人（見本）と話して預ける
    await nav(0); await sleep(300);
    for (const msg of ['集まらなくても案が決まるアプリを作りたい', '実体験から話せるところが好き。デモが見せにくいのが不安。', '締切までに確実に動くこと', '画面を担当できる。平日の夜に2時間ずつ使える']) {
      await type('#chatInput', msg); await click('送信'); await idle();
    }
    if (await js(`!!document.querySelector('#micBtn')`)) throw new Error('Web版にマイクボタンが出ている');
    await click('預ける内容を確認する'); await idle();
    await click('この内容で預ける'); await idle();
    await sleep(300);
    await need('#sec-wait', ['あなたの考えを預かりました', 'あと2人'], '預けたあとの待ちの表示');

    // 3. ほかの2人が預けた状態 → 自動で会議 → 推薦
    await js(`(async () => {
      const mk = (title) => ({ ideas: [{ title, summary: title + 'の説明', target: { text: '学生', by: 'me' }, problem: { text: '', by: 'ai' }, feature: { text: '目玉', by: 'me' }, push: 'normal' }], likes: 'すぐ伝わる', worries: '新しさが弱い', mustHaves: ['実際に動くこと'], wantFromOthers: '', acceptCondition: '', impl: 'JavaScriptが書ける', updates: [] });
      await api.store.put('member', 'm-aoi', { name: 'あおい', deposited: true });
      await api.store.put('member', 'm-kenta', { name: 'けんた', deposited: true });
      await api.store.put('brief', 'm-aoi', mk('講義メモ自動停止'));
      await api.store.put('brief', 'm-kenta', mk('レシート割り勘'));
    })()`);
    await until(async () => (await text('#view')).includes('推薦案（第1回の議論）'), '推薦が出ない', 90000);
    await idle();
    await need('#view', ['理由：', '点の差', 'くわしく見る', 'この案を承認する'], '会議の結果');
    await shot('w2-result');

    // 4. 開き直しても続きから使える（設定と会議はこのブラウザに残る）
    await win.loadFile(path.join(__dirname, '..', 'web', 'index.html'), { query: { db: 'none' } });
    await sleep(1500);
    await need('#who', ['りょうま（幹事）'], '開き直したあとのヘッダー');
    await nav(1); await sleep(500);
    await need('#view', ['推薦案（第1回の議論）'], '開き直したあとの結果');

    // 5. スマホの幅でも、横にはみ出さない
    win.setContentSize(390, 780); await sleep(600);
    const over = await js(`document.documentElement.scrollWidth - window.innerWidth`);
    await shot('w3-mobile-result');
    await nav(0); await sleep(400);
    await shot('w4-mobile-room');
    if (over > 2) throw new Error('スマホの幅で横にはみ出している: ' + over + 'px');

    // 6. 招待のリンクから開くと、参加の画面にコードが入った状態で出る（別人として開く）
    win.setContentSize(1180, 820);
    await win.loadFile(path.join(__dirname, '..', 'web', 'index.html'), { query: { db: 'none', profile: 'b' }, hash: 'join=' + encodeURIComponent(await js(`document.querySelector('#s-invite') ? document.querySelector('#s-invite').value : ''`) || 'K7M29QXD') });
    await sleep(1200);
    await need('#view', ['招待コードで参加する', 'あなたの名前'], '招待のリンクから開いた画面');
    if (!(await js(`(document.querySelector('#j-code') || {}).value || ''`))) throw new Error('招待コードが入っていない');
    if ((await js(`location.hash`)) !== '') throw new Error('開いたあとも、アドレスに招待コードが残っている');
    await shot('w5-join');

    // 7. 別の端末で続ける: 引き継ぎリンクを作り、別のブラウザ（別人の設定）で開くと、同じ人として会話の続きができる
    await win.loadFile(path.join(__dirname, '..', 'web', 'index.html'), { query: { db: 'none' } });
    await sleep(1500);
    await nav(0); await sleep(400);
    const myChat = await js(`JSON.stringify([...document.querySelectorAll('#msgs .bubble')].map((b) => b.textContent))`);
    const myId = await js(`window.api.getConfig().then((c) => c.memberId)`);
    const myRoom = await js(`window.api.getConfig().then((c) => c.room)`);
    await click('設定・招待'); await sleep(300);
    await click('引き継ぎリンクを作る');
    await until(async () => js(`!!document.querySelector('#takeLink')`), '引き継ぎリンクが出ない', 8000);
    const link = await text('#takeLink');
    if (!/#take=[\w-]+$/.test(link)) throw new Error('引き継ぎリンクの形がおかしい: ' + link.slice(0, 80));
    // 保存先には暗号文だけが置かれ、会話の文字は入っていない
    const privDoc = JSON.parse(await js(`(async () => JSON.stringify((await api.store.all()).filter((d) => d.kind === 'priv')))()`));
    if (privDoc.length !== 1 || !privDoc[0].data.ct || JSON.stringify(privDoc).includes('代理人')) throw new Error('引き継ぎ用の保存内容がおかしい: ' + JSON.stringify(privDoc).slice(0, 200));
    await win.loadFile(path.join(__dirname, '..', 'web', 'index.html'), { query: { db: 'none', profile: 'c' }, hash: link.split('#')[1] });
    await sleep(2000);
    await need('#who', ['りょうま'], '引き継いだあとのヘッダー');
    if ((await js(`window.api.getConfig().then((c) => c.memberId)`)) !== myId) throw new Error('引き継いでも同じ人になっていない');
    if ((await js(`location.hash`)) !== '') throw new Error('引き継いだあとも、アドレスに鍵が残っている');
    // この確認では見本のAIを使う（元のブラウザと同じ設定にする）ので、設定してから開き直す
    await js(`window.api.saveConfig({ demo: true }).then(() => true)`);
    await win.loadFile(path.join(__dirname, '..', 'web', 'index.html'), { query: { db: 'none', profile: 'c' } });
    await sleep(1500);
    await nav(0); await sleep(400);
    const takenChat = await js(`JSON.stringify([...document.querySelectorAll('#msgs .bubble')].map((b) => b.textContent))`);
    if (takenChat !== myChat) throw new Error('会話が引き継がれていない: ' + takenChat.slice(0, 200) + ' ≠ ' + myChat.slice(0, 200));
    await shot('w6-takeover');
    if (errors.length) throw new Error('コンソールエラー: ' + errors.join(' / '));
    console.log('WEB SMOKE OK', outDir);
    app.exit(0);
  } catch (e) {
    await shot('s-error').catch(() => {});
    console.error('WEB SMOKE NG', e.message, errors);
    app.exit(1);
  }
});
