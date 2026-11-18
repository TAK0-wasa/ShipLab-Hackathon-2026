// 見本モード用の「AIの代わり」。APIを呼ばずに、決まった形の見本の応答を返す。
// 画面の流れ（個室 → 預ける → 会議 → 採点 → 推薦 → 承認）を、費用をかけずに確かめるためのもの。
// 本物のAIではないので、内容は入力された案の名前を当てはめただけの定型文になる。

const pick = (text, re) => (re.exec(text || '') || [])[1] || '';

function parseCands(user) {
  const section = (user.split('【会議に出ている案】')[1] || user.split('【案の内容】')[1] || '').split('\n【')[0];
  const out = [];
  for (const m of section.matchAll(/^\[([\w-]+)\] (.+)$/gm)) {
    const k = /^(.*?)（((?:元の案|合体案|進行役AIの新案).*)）$/.exec(m[2]);
    out.push({ id: m[1], title: k ? k[1] : m[2], kind: k ? k[2] : '' });
  }
  return out;
}

function interview(messages) {
  const n = messages.filter((m) => m.role === 'user').length;
  if (n <= 1) return '【見本】ありがとうございます。お題にも合いそうな案ですね。この案の一番好きなところと、逆に不安なところを教えてください。\n<<済:1>>';
  if (n === 2) return '【見本】なるほど。では、外したくない条件はありますか。たとえば「締切までに確実に動くこと」「自分が実装できる技術で作れること」のように、これが崩れるなら別の案がいい、というものです。特になければ「なし」で大丈夫です。\n<<済:1,2>>';
  if (n === 3) return '【見本】わかりました。最後に、この案を作るなら自分はどこを担当できそうか、締切までにどのくらい時間を使えそうかを教えてください。\n<<済:1,2,3>>';
  return '【見本】ありがとうございます。必要なことは聞けました。「預ける」ボタンを押してください。\n<<済:1,2,3,4>>';
}

function brief(system, user) {
  const name = pick(system, /あなたは(.+?)さんの代理人/);
  const lines = (user.split('会話記録:')[1] || '').split('\n').filter((l) => l.startsWith(name + ': ')).map((l) => l.slice(name.length + 2).trim());
  const idea = lines[0] || '（案の説明がありません）';
  const second = (lines[1] || '').split(/(?<=[。.！!])/);
  const must = lines[2] && !/^(なし|特にな|ない)/.test(lines[2]) ? [lines[2]] : [];
  return JSON.stringify({
    ideas: [{
      title: idea.split(/[。、,.\s]/)[0].slice(0, 18) || '案',
      summary: idea,
      target: { text: 'この案で困りごとが減る人（見本の仮置き）', by: 'ai' },
      problem: { text: 'いま手間がかかっていること（見本の仮置き）', by: 'ai' },
      feature: { text: idea.slice(0, 30), by: 'me' },
      push: 'push',
    }],
    likes: (second[0] || '').trim(),
    worries: second.slice(1).join('').trim(),
    mustHaves: must,
    wantFromOthers: '',
    acceptCondition: '',
    impl: lines[3] || '',
  });
}

function agent(task, system, user) {
  const who = pick(system, /あなたは(.+?)さんの代理人/);
  const cands = parseCands(user);
  const own = cands.find((c) => c.kind.includes('提案: ' + who) || c.kind.includes('・' + who));
  const others = cands.filter((c) => c !== own);
  const impl = pick(user, /実装面（[^）]*）: (.+)/);
  const evals = cands.map((c) => {
    if (c === own) return { candId: c.id, score: 5, reason: `${who}さん本人が推している案です`, basis: 'stated' };
    if (c.kind.startsWith('合体案')) return { candId: c.id, score: 4, reason: `${who}さんの案の良さが残りそうです`, basis: 'guess' };
    return { candId: c.id, score: 3, reason: '悪くはありませんが、決め手はまだ見えません', basis: 'guess' };
  });
  if (task === 'round1') {
    return JSON.stringify({
      statement: `【見本】${who}さんは「${own ? own.title : cands[0] ? cands[0].title : '自分の案'}」を推しています。\n\n本人が話していた良さが、お題に合うと考えているためです。\n\nほかの案の目玉機能にも、取り入れたい部分があります。`,
      evals,
      wantParts: others[0] ? [{ candId: others[0].id, part: 'feature', why: '自分の案と組み合わせやすそうです' }] : [],
      canDo: impl && !impl.includes('聞けていない') ? impl : '',
    });
  }
  const mix = cands.find((c) => c.kind.startsWith('合体案'));
  return JSON.stringify({
    statement: `【見本】${who}さんの立場で、合体案と新しい案も含めて見直しました。\n\n${mix ? `「${mix.title}」は、${who}さんの案の良さが残るので前向きです。` : '大きく評価は変わりません。'}\n\n進行役の新しい案は、本人の考えが分からないので「どちらでもいい」としています。`,
    evals,
    questions: task === 'round2' && mix ? [{ candId: mix.id, text: `合体案「${mix.title}」なら、あなたの案の良さも残りそうですが、どうですか？` }] : [],
  });
}

function merge(user) {
  const cands = parseCands(user);
  const [a, b] = cands;
  const merged = a && b ? [{ title: `${a.title} ＋ ${b.title}`, summary: `「${a.title}」の対象に、「${b.title}」の目玉機能を足した案です。`, target: `「${a.title}」が想定している人`, problem: 'ふたつの案が解こうとしている困りごと', feature: `「${b.title}」の目玉機能`, from: [a.id, b.id], why: '支持の集まった部分どうしを組み合わせました' }] : [];
  return JSON.stringify({
    statement: `【見本】${merged.length ? `「${a.title}」と「${b.title}」を組み合わせた合体案を作りました。` : '案が1つなので合体案はありません。'}\n\nあわせて、お題から考えた別の方向の案も1つ足しました。`,
    merged,
    fresh: [{ title: 'お題から考えた別の案', summary: 'メンバーの案とは別の角度から、お題に答える案です（見本の定型文）。', target: 'お題で想定されている人', problem: 'お題が挙げている困りごと', feature: '一番小さく作れる形に絞った機能', why: '3人の案に無い方向も比べるためです' }],
    drop: [],
  });
}

function feas(user) {
  const cands = parseCands(user);
  const verdicts = ['ok', 'partial', 'partial', 'hard'];
  return JSON.stringify({
    statement: '【見本】各案について、必要な技術と、締切までに作れる範囲を検討しました。\n\n1つ目の案は目玉機能まで作れそうです。ほかの案は、範囲を絞れば見せられる形になります。',
    items: cands.map((c, i) => ({
      candId: c.id,
      verdict: verdicts[i % verdicts.length],
      needs: '画面の作成と、データの保存先が必要です（見本の定型文）。',
      mvp: `「${c.title}」の一番小さく動く形までです（見本の定型文）。`,
      later: '細かい設定や見た目の作り込みは後回しにします。',
      risk: '見本モードのため、実際のAPIやライブラリは未確認です。',
    })),
  });
}

function judge(user) {
  const cands = parseCands(user);
  const n = ((user.split('【評価基準（この番号順に採点）】')[1] || '').split('\n【')[0].match(/^\d+\. /gm) || []).length || 1;
  const h = (s) => [...s].reduce((t, c) => (t * 31 + c.charCodeAt(0)) % 9973, 7);
  return JSON.stringify({
    scores: cands.map((c) => ({
      candId: c.id,
      marks: Array.from({ length: n }, (_, i) => 2 + ((h(c.id + c.title) + i * 3) % 4)),
      comment: '見本の採点です。本物のAIでは、基準ごとの強みと弱みがここに入ります。',
    })),
  });
}

function explain(user) {
  const cands = parseCands(user);
  const topId = pick(user, /推薦案: \[([\w-]+)\]/);
  const top = cands.find((c) => c.id === topId) || cands[0] || { title: '推薦案' };
  const names = [...new Set([...user.matchAll(/- (.+?)さんの代理人 →/g)].map((m) => m[1]))];
  const skills = Object.fromEntries([...((user.split('【メンバーが実装でできること】')[1] || '').split('\n【')[0]).matchAll(/^- (.+?)さん: (.+)$/gm)].map((m) => [m[1], m[2]]));
  return JSON.stringify({
    reason: `【見本】「${top.title}」が、評価基準への合い方とメンバーの支持を合わせた点数で最も高くなりました。\n\nほかの案は、基準への合い方か支持のどちらかで差がつきました。`,
    influences: names.map((n) => ({ name: n, point: `${n}さんの代理人が付けた支持の点数` })),
    conflict: '',
    plan: { steps: 'まず一番小さく動く形を作り、残りの時間で目玉機能を磨きます（見本の定型文）。', roles: names.map((n) => ({ name: n, role: skills[n] || '未定（本人に確認）' })) },
  });
}

module.exports = async function sampleAi({ system, messages }) {
  await new Promise((r) => setTimeout(r, 500)); // 本物らしい間をあける
  const user = messages[messages.length - 1].content;
  const task = pick(user, /【タスク:(\w+)】/);
  if (!task) return interview(messages);
  if (task === 'brief') return brief(system, user);
  if (task === 'round1' || task === 'round2' || task === 'rerun') return agent(task, system, user);
  if (task === 'merge') return merge(user);
  if (task === 'feas') return feas(user);
  if (task === 'judge') return judge(user);
  return explain(user);
};
