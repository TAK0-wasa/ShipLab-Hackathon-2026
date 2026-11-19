// 2台のPCに見立てた通し確認の、1台分（test/smoke-two-pc.js から起動される）
// ROLE=leader: 会議を作って招待コードを書き出す / ROLE=member: 招待コードで参加する
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROLE = process.env.ROLE;
const DIR = process.env.TWO_PC_DIR;
const URL0 = process.env.FAKE_DB_URL;
const home = path.join(DIR, ROLE);
app.setPath('appData', home); // 保存先を完全に分ける（別のPCと同じ状態）
app.setPath('userData', path.join(home, 'user'));
process.env.KAWARINI_DB = URL0 + '|fake-key'; // アプリに入っている接続先の代わりに、テスト用のサーバーを使う
require('../main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  await sleep(1500);
  const win = BrowserWindow.getAllWindows()[0];
  const wc = win.webContents;
  const errors = [];
  wc.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) errors.push(e.message); });
  const js = (code) => wc.executeJavaScript(code);
  const click = (text) => js(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(text)}) && !b.disabled); if (!b) throw new Error('ボタンなし: ' + ${JSON.stringify(text)}); b.click(); })()`);
  const type = (sel, text) => js(`(() => { const t = document.querySelector(${JSON.stringify(sel)}); if (!t) throw new Error('入力欄なし: ' + ${JSON.stringify(sel)}); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const nav = (i) => js(`(() => { const b = document.querySelectorAll('#nav button')[${i}]; if (!b || b.disabled) throw new Error('上部のボタンなし: ' + ${i}); b.click(); })()`);
  const text = (sel) => js(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ''`);
  const until = async (fn, label, ms) => { for (let i = 0; i < (ms || 60000) / 300; i++) { if (await fn()) return; await sleep(300); } throw new Error(`[${ROLE}] 待っても変わらない: ${label}`); };
  const idle = () => until(async () => !(await js(`!!document.querySelector('#status .spin') || [...document.querySelectorAll('.bubble')].some(b => b.textContent === '…')`)), '処理中のまま');
  const shot = async (name) => fs.writeFileSync(path.join(DIR, `${ROLE}-${name}.png`), (await wc.capturePage()).toPNG());
  const closeOverlay = () => js(`(() => { const o = document.querySelector('#overlay.show'); if (o) { o.className = ''; o.replaceChildren(); } })()`);
  try {
    if (ROLE === 'leader') {
      await click('代表者として始める'); await sleep(300);
      await type('#c-name', 'りょうま');
      await type('#c-theme', '発表の役割分担');
      await type('#c-criteria', '全員が無理なく担当できるか\n発表がうまくいくか ×2');
      await type('#c-size', '2');
      if (await js(`document.querySelector('#c-more').open`)) throw new Error('接続先の欄が最初から開いている');
      await js(`window.api.saveConfig({ demo: true })`);
      await click('会議を作る'); await sleep(1500);
      const who = await text('#who');
      if (!who.includes('共有中')) throw new Error('共有中にならない: ' + who + ' / ' + (await text('#status')));
      const code = await js(`document.querySelector('#s-invite').value`);
      if (!/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code)) throw new Error('招待コードが8文字になっていない: ' + code);
      fs.writeFileSync(path.join(DIR, 'code.txt'), code);
      await nav(0); await sleep(300);
      for (const msg of ['自分は話す役をやりたい', '人前で話すのは好き。質問に答えるのは不安。', 'なし', 'スライドも作れる。今夜2時間使える']) { await type('#chatInput', msg); await click('送信'); await idle(); }
      await click('預ける内容を確認する'); await idle();
      await click('この内容で預ける'); await idle();
      // メンバーが別のPCから預けるのを待つ → 代表者のアプリが自動で会議を進める
      await until(async () => { await nav(1).catch(() => {}); return (await text('#view')).includes('推薦案（第1回の議論）'); }, 'メンバーが預けたあと会議が進まない', 120000);
      await idle();
      if (!(await text('#view')).includes('あおい')) throw new Error('メンバーの名前が代表者側に出ていない');
      await shot('meeting');
      // メンバーの承認が届くのを待ってから、自分も承認 → 決定
      await until(async () => (await text('#view')).includes('承認 1 / 2 人'), 'メンバーの承認が届かない', 90000);
      await click('この案を承認する'); await sleep(1500);
      await until(async () => (await text('#overlay')).includes('決定'), '決定の表示が出ない', 20000);
      await shot('decided');
      await closeOverlay();
      // メンバーの画面にも決定が届いてから、代表者が会議のデータを削除する
      await until(async () => fs.existsSync(path.join(DIR, 'member-saw-decided')), 'メンバーに決定が届かない', 90000);
      await click('設定・招待'); await sleep(300);
      await click('この会議のデータをすべて削除する'); await sleep(200);
      await click('本当に削除する'); await sleep(2500);
      if (!(await text('#view')).includes('会議を作る')) throw new Error('削除したあと、はじめの画面に戻らない');
    } else {
      const code = fs.readFileSync(path.join(DIR, 'code.txt'), 'utf8');
      await click('メンバーとして参加する'); await sleep(300);
      await type('#j-name', 'あおい');
      await type('#j-code', ' ' + code.toLowerCase().replace('-', ' ') + ' '); // 小文字・空白まじりで入れても通る
      await click('参加する'); await sleep(1800);
      const who = await text('#who');
      if (!(await text('#switch')).includes('発表の役割分担') || !who.includes('あおい（メンバー）') || !who.includes('共有中')) throw new Error('参加後の表示がおかしい: ' + who + ' / ' + (await text('#status')));
      const topic = await js(`(async () => { document.querySelectorAll('nav button')[1].click(); await new Promise(r => setTimeout(r, 400)); document.querySelectorAll('details').forEach((d) => (d.open = true)); await new Promise(r => setTimeout(r, 200)); return document.querySelector('#view').innerText; })()`);
      if (!topic.includes('発表がうまくいくか ×2') || !topic.includes('代表者が設定します')) throw new Error('代表者が入れた評価基準がメンバーに見えない: ' + topic.slice(0, 200));
      await nav(0); await sleep(300);
      await type('.formbody textarea', 'デモ操作の担当');
      await js(`(() => { const ts = document.querySelectorAll('.formbody textarea'); ts[1].value = 'PCを操作してデモを見せる役をやりたい'; ts[1].dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await click('内容を確認する'); await sleep(400);
      await click('この内容で預ける'); await idle();
      await shot('deposited');
      // 代表者のPCで会議が進むのを待つ（こちらはAPIキーなし）
      await until(async () => { await nav(1).catch(() => {}); return (await text('#view')).includes('推薦案（第1回の議論）'); }, '代表者のPCで進んだ会議が届かない', 120000);
      if (!(await text('#view')).includes('りょうま')) throw new Error('代表者の名前がメンバー側に出ていない');
      await until(async () => !(await js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('この案を承認する')).disabled`)), '承認ボタンが押せない', 60000);
      await click('この案を承認する'); await idle();
      await until(async () => (await text('#overlay')).includes('決定'), '代表者の承認後、決定が届かない', 90000);
      await shot('decided');
      await closeOverlay();
      fs.writeFileSync(path.join(DIR, 'member-saw-decided'), 'ok');
      // 代表者が会議のデータを削除すると、メンバーの画面からも会議がなくなる
      await until(async () => (await text('#status')).includes('代表者によって削除されました'), '削除されたことがメンバーに伝わらない', 60000);
      if (!(await text('#view')).includes('招待コードで参加する')) throw new Error('削除されたあと、はじめの画面に戻らない');
    }
    if (errors.length) throw new Error('コンソールエラー: ' + errors.join(' / '));
    fs.writeFileSync(path.join(DIR, `ok-${ROLE}`), 'ok');
    console.log(`[${ROLE}] OK`);
    app.exit(0);
  } catch (e) {
    await shot('error').catch(() => {});
    console.error(`[${ROLE}] NG`, e.message, errors);
    app.exit(1);
  }
});
