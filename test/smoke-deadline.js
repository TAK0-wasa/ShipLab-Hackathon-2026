// 預ける締切: 3人の会議で2人だけ預けた状態 → 締切を過ぎると預けた人だけで自動で始まる → あとから預けた人が来たら、その人を入れてやり直す
// 実行: npx electron test/smoke-deadline.js （スクリーンショットの出力先は環境変数 SMOKE_OUT）
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-deadline-'));
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
    await click('代表者として始める'); await sleep(300);
    await type('#c-name', 'りょうま');
    await type('#c-theme', 'かゆいところに手が届くアプリ');
    // 評価基準は見本から入れる
    await need('.tplrow', ['見本から入れる', 'ハッカソン・コンテスト', '行き先・お店'], '評価基準の見本');
    await click('ハッカソン・コンテスト');
    if (!(await js(`document.querySelector('#c-criteria').value`)).includes('新しさがあるか ×2')) throw new Error('見本が評価基準に入らない');
    await need('#view', ['預ける締切（任意）', '預けた人だけ（2人以上）で会議を自動で始めます'], '締切の入力欄');
    await js(`window.api.saveConfig({ demo: true })`);
    await click('会議を作る'); await sleep(1200);

    // 代表者ともう1人だけが預けた状態（3人中2人）
    const mk = `(title) => ({ ideas: [{ title, summary: title + 'の説明', target: { text: '学生', by: 'me' }, problem: { text: '', by: 'ai' }, feature: { text: '目玉', by: 'me' }, push: 'normal' }], likes: 'すぐ伝わる', worries: '新しさが弱い', mustHaves: ['実際に動くこと'], wantFromOthers: '', acceptCondition: '', impl: 'JavaScriptが書ける', updates: [] })`;
    await js(`(async () => { const mk = ${mk}; const me = (await api.getConfig()).memberId;
      await api.store.put('member', me, { name: 'りょうま', deposited: true });
      await api.store.put('brief', me, mk('集まらず決まる会議アプリ'));
      await api.store.put('member', 'm-aoi', { name: 'あおい', deposited: true });
      await api.store.put('brief', 'm-aoi', mk('講義メモ自動停止')); })()`);
    await nav(1); await sleep(6000);
    if (await js(`!!document.querySelector('.card.live')`) || (await text('#view')).includes('推薦案（第1回')) throw new Error('締切がないのに、全員そろう前に会議が始まった');
    await need('#sec-wait', ['あと1人', '預ける締切を決められます'], '締切なしの待ちの表示');

    // 締切を先の時刻にする → 待ちの画面に締切が出る。まだ始まらない
    await js(`(async () => { const cur = (await api.store.all()).find((d) => d.kind === 'room' && d.id === 'main').data; await api.store.put('room', 'main', { ...cur, deadlineAt: Date.now() + 3600000 }); })()`);
    await until(async () => (await text('#sec-wait')).includes('預ける締切：'), '締切が待ちの画面に出ない', 15000);
    await need('#sec-wait', ['あと', '締切になると、預けた人だけで会議を始めます'], '締切ありの待ちの表示');
    await shot('d1-wait');
    await sleep(3000);
    if (await js(`!!document.querySelector('.card.live')`)) throw new Error('締切前に会議が始まった');

    // 締切を過ぎた時刻にする → 預けた2人で自動で始まる
    await js(`(async () => { const cur = (await api.store.all()).find((d) => d.kind === 'room' && d.id === 'main').data; await api.store.put('room', 'main', { ...cur, deadlineAt: Date.now() - 1000 }); })()`);
    await until(async () => (await text('#view')).includes('推薦案（第1回の議論）'), '締切を過ぎても会議が始まらない', 90000);
    await idle();
    let st = JSON.parse(await js(`(async () => JSON.stringify(((await api.store.all()).find((d) => d.kind === 'state' && d.id === 'main') || {}).data || {}))()`));
    if ((st.participants || []).length !== 2) throw new Error('参加者が2人でない: ' + JSON.stringify(st.participants));
    await shot('d2-result');

    // あとから3人目が預ける → その人を入れて最初からやり直す
    await js(`(async () => { const mk = ${mk};
      await api.store.put('member', 'm-kenta', { name: 'けんた', deposited: true });
      await api.store.put('brief', 'm-kenta', mk('レシート割り勘')); })()`);
    await until(async () => { const s2 = JSON.parse(await js(`(async () => JSON.stringify(((await api.store.all()).find((d) => d.kind === 'state' && d.id === 'main') || {}).data || {}))()`)); return s2.phase === 'review' && (s2.participants || []).length === 3 && s2.round >= 2; }, 'あとから預けた人を入れたやり直しが起きない', 90000);
    await idle();
    await need('#view', ['推薦案（第2回の議論）'], 'やり直しの結果');
    // もう一度は繰り返さない
    await sleep(6000);
    st = JSON.parse(await js(`(async () => JSON.stringify(((await api.store.all()).find((d) => d.kind === 'state' && d.id === 'main') || {}).data || {}))()`));
    if (st.round !== 2 || st.phase !== 'review') throw new Error('やり直しが繰り返されている: 第' + st.round + '回');

    if (errors.length) throw new Error('コンソールエラー: ' + errors.join(' / '));
    console.log('DEADLINE SMOKE OK', outDir);
    app.exit(0);
  } catch (e) {
    await shot('s-error').catch(() => {});
    console.error('DEADLINE SMOKE NG', e.message, errors);
    app.exit(1);
  }
});
