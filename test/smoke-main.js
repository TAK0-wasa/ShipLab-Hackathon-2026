// 画面の通し確認（開発用）。AIはモック、共有ストアは一時フォルダ。
// 実行: npx electron test/smoke-main.js （スクリーンショットの出力先は環境変数 SMOKE_OUT）
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-smoke-'));
const outDir = process.env.SMOKE_OUT ? path.resolve(process.env.SMOKE_OUT) : tmp;
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'user'));
fs.mkdirSync(path.join(tmp, 'user'), { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(tmp, 'user', 'config.json'), JSON.stringify({ name: 'りょうま', room: 'smoke', memberId: 'm-me001', apiKey: 'dummy' }));

// 他の2人はすでに預け済み、という状態を作る
const brief = (title, target, feature, worries) => ({
  ideas: [{ title, summary: `${title}の概要です。`, target: { text: target, by: 'me' }, problem: { text: '時間が合わない', by: 'ai' }, feature: { text: feature, by: 'me' }, push: 'push' }],
  likes: '発表で伝わりやすい', worries, mustHaves: ['1週間で作りきれること'], wantFromOthers: '', acceptCondition: '', updates: [],
});
fs.mkdirSync(path.join(tmp, 'ai-dairinin-kaigi-shared'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'ai-dairinin-kaigi-shared', 'smoke.json'), JSON.stringify({
  'room/main': { teamSize: 3, theme: 'かゆいところに手が届くアプリ', criteria: 'テーマに合っているか\n新しさがあるか ×2\n完成度・実際に動くか' },
  'member/m-aaa01': { name: 'あおい', deposited: true },
  'member/m-bbb01': { name: 'けんた', deposited: true },
  'brief/m-aaa01': brief('講義メモ自動停止', '講義動画で勉強する学生', '入力中は動画を自動で止める', '実装が重いと間に合わない'),
  'brief/m-bbb01': brief('レシート割り勘', '飲み会の幹事', 'レシート撮影で各自の金額を出す', '既存アプリと差が出にくい'),
}));

global.__mockLlm = async ({ system, messages }) => {
  const user = messages[messages.length - 1].content;
  const task = (user.match(/【タスク:(\w+)】/) || [])[1];
  const who = (system.match(/あなたは(.+?)さんの代理人/) || [])[1];
  const section = user.split('【会議に出ている案】')[1] || user.split('【案の内容】')[1] || '';
  const ids = [...section.split('【')[0].matchAll(/^\[([\w-]+)\]/gm)].map((x) => x[1]);
  if (!task) return 'ありがとうございます。その案の一番好きなところと、不安なところを教えてください。\n<<済:1>>';
  if (task === 'brief') {
    return JSON.stringify({
      ideas: [{ title: 'AI代理人会議', summary: '集まらなくても案が決まるアプリ。', target: { text: '予定が合わない少人数チーム', by: 'me' }, problem: { text: '最終決定だけ全員そろわないと進まない', by: 'me' }, feature: { text: '代理人AIどうしが議論して合体案を作る', by: 'ai' }, push: 'push' }],
      likes: '自分たちの実体験から話せる', worries: 'デモが見せにくい', mustHaves: ['本人の承認なしに決めない'], wantFromOthers: '', acceptCondition: '決め方の仕組みが残ること',
    });
  }
  if (task === 'round1') {
    return JSON.stringify({ statement: `${who}さんは自分の案を推しています。\n\n発表で伝わりやすく、締切までに作りきれる見込みがあるためです。\n\n一方で、他の案の目玉機能は取り入れたいと考えています。`, evals: ids.map((id, i) => ({ candId: id, score: i % 2 ? 3 : 5, reason: '発表で伝わりやすそうです', basis: i % 2 ? 'guess' : 'stated' })), wantParts: [{ candId: ids[0], part: 'feature', why: '目玉として強い' }] });
  }
  if (task === 'merge') {
    return JSON.stringify({ statement: '講義メモ案のターゲットに、代理人会議の目玉機能を足した合体案を作りました。', merged: [{ title: '勉強会の決めごと代理人', summary: '学生チームの決めごとを代理人AIが進める。', target: '講義動画で勉強する学生チーム', problem: '予定が合わず決めごとが進まない', feature: '代理人AIどうしの議論と合体案', from: ids.slice(0, 2), why: '学生という身近な相手に絞れる' }], fresh: [{ title: '発表タイマー係', summary: '発表練習の残り時間を教える。', target: '発表前の学生', problem: '時間配分が分からない', feature: '話す速さから残り時間を予測', why: 'テーマに合う別方向の案' }], drop: [] });
  }
  if (task === 'round2' || task === 'rerun') {
    return JSON.stringify({ statement: `${who}さんの立場で見直しました。合体案は不安だった点が減るので前向きです。`, evals: ids.map((id) => ({ candId: id, score: id.startsWith('mix') ? 5 : 3, reason: id.startsWith('mix') ? '不安だった実装量が減りそうです' : '悪くはないです', basis: 'guess' })), questions: task === 'round2' && who === 'りょうま' ? [{ candId: ids[ids.length - 1], text: 'あおいさんの案のターゲット（学生）に絞ると、気にしていた「デモの見せにくさ」が減りそうですが、どうですか？' }] : [] });
  }
  if (task === 'feas') return JSON.stringify({ statement: '各案の実現性を調べました。\n\n合体案は範囲を絞れば締切までに作れます。', items: ids.map((id, i) => ({ candId: id, verdict: ['ok', 'partial', 'hard'][i % 3], needs: 'ブラウザの拡張機能のAPIが必要です。', mvp: '動画の一時停止だけが動く形まで作れます。', later: '要約と書き出しは後回しにします。', risk: '対応していないサイトがあるかは未確認です。' })) }) + '§SRC§https://developer.chrome.com/docs/extensions';
  if (task === 'judge') return JSON.stringify({ scores: ids.map((id) => ({ candId: id, marks: id.startsWith('mix') ? [5, 4, 4] : id.startsWith('new') ? [4, 5, 2] : [4, 2, 3], comment: id.startsWith('mix') ? 'テーマと完成度に強く、新しさもあります。' : 'テーマには合いますが、新しさが弱めです。' })) });
  return JSON.stringify({ reason: '評価基準への合い方が最も高く、全員の支持も集まりました。\n\nほかの案はテーマには合うものの、新しさの点で差がつきました。', influences: [{ name: 'あおい', point: 'ターゲットを学生に絞る' }, { name: 'りょうま', point: '本人の承認なしに決めない' }], conflict: '', fit: ids.map((id) => ({ candId: id, score: id.startsWith('mix') ? 5 : 3, comment: 'テーマには合うが新しさは普通' })), plan: { steps: '1日目に個室、2日目に会議を作る。', roles: [{ name: 'りょうま', role: '会議ロジック' }, { name: 'あおい', role: '未定（本人に確認）' }] } });
};

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
  const type = (sel, text) => js(`(() => { const t = document.querySelector(${JSON.stringify(sel)}); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const idle = async () => { for (let i = 0; i < 100; i++) { await sleep(200); if (!(await js(`!!document.querySelector('#status .spin') || !!document.querySelector('.bubble:last-child') && document.querySelector('.bubble:last-child').textContent === '…'`))) return; } throw new Error('終わらない'); };
  try {
    await type('#chatInput', 'みんなが集まれなくても案が決まるアプリを作りたい');
    await click('送信'); await idle();
    const chatText = await js(`document.querySelector('.chat').innerText`);
    if (chatText.includes('<<') || !chatText.includes('✓ 案') || !chatText.includes('あと3問')) throw new Error('進み具合の表示がおかしい: ' + chatText.slice(0, 200));
    await click('ここまでで預ける'); await idle();
    await shot('1-deposit-preview');
    await click('この内容で預ける'); await idle();
    win.setContentSize(1180, 1500); await sleep(500);
    await shot('2-meeting');
    const turn = await js(`document.querySelector('#turn').innerText`);
    if (!turn.includes('あなたの番') || !turn.includes('確認質問')) throw new Error('あなたの番が出ない: ' + turn);
    await type('.q textarea', 'それなら賛成です');
    await click('答える'); await idle(); await sleep(300);
    await click('この案を承認する'); await idle(); await sleep(300);
    await shot('3-after-approve');
    const turn2 = await js(`document.querySelector('#turn').innerText`);
    if (!turn2.includes('いまは待ち') || !turn2.includes('承認を待っています')) throw new Error('待ちの表示が出ない: ' + turn2);
    await js(`document.querySelectorAll('details').forEach((d) => (d.open = true))`); await sleep(200);
    const text = await js(`document.querySelector('#view').innerText`);
    for (const need of ['推薦案（第2回の議論）', '✓ 承認', '承認 1 / 3 人', '勉強会の決めごと代理人', '代理人の推測', 'AIの新案', '実装の進め方（案）', '評価基準ごとの採点', '技術的に作れるか', '締切までに作れる範囲', 'Web検索で確認', 'developer.chrome.com', '新しさがあるか ×2：4/5', '基準 ', '/70 ＋ 支持 ', 'お題と評価基準']) {
      if (!text.includes(need)) throw new Error('表示に見つからない: ' + need);
    }
    if (errors.length) throw new Error('コンソールエラー: ' + errors.join(' / '));
    console.log('SMOKE OK', outDir);
    app.exit(0);
  } catch (e) {
    await shot('error').catch(() => {});
    console.error('SMOKE NG', e.message, errors);
    app.exit(1);
  }
});
