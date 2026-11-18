// 会議エンジンの通しテスト（AIと共有ストアはモック）。実行: npm test
const assert = require('assert');
const Engine = require('../src/engine.js');

function memStore() {
  const m = new Map();
  return {
    all: async () => [...m.entries()].map(([k, data]) => ({ kind: k.split('/')[0], id: k.slice(k.indexOf('/') + 1), data: JSON.parse(JSON.stringify(data)) })),
    put: async (kind, id, data) => void m.set(`${kind}/${id}`, JSON.parse(JSON.stringify(data))),
    del: async (kind, id) => void m.delete(`${kind}/${id}`),
  };
}

const calls = [];
function mockLlm(opts) {
  return async (req) => {
    const { system, messages } = req;
    const user = messages[0].content;
    const task = (user.match(/【タスク:(\w+)】/) || [])[1];
    calls.push({ system, user, task, search: req.search });
    const section = user.split('【会議に出ている案】')[1] || user.split('【案の内容】')[1] || '';
    const ids = [...section.split('【')[0].matchAll(/^\[([\w-]+)\]/gm)].map((x) => x[1]);
    const who = (system.match(/あなたは(.+?)さんの代理人/) || [])[1];
    if (task === 'round1') {
      return '```json\n' + JSON.stringify({
        statement: `${who}の代理人として意見を述べます。`,
        evals: ids.map((id, i) => ({ candId: id, score: i === 0 ? 5 : 3, reason: '理由', basis: 'stated' })),
        wantParts: [{ candId: ids[0], part: 'feature', why: '面白い' }],
        canDo: `${who}はフロントエンドを担当できる`,
      }) + '\n```';
    }
    if (task === 'merge') {
      return JSON.stringify({ statement: '合体案を作りました。', merged: [{ title: '合体案X', summary: 's', target: 't', problem: 'p', feature: 'f', from: ids.slice(0, 2), why: 'w' }], fresh: [{ title: '新案Y', summary: 's', target: 't', problem: 'p', feature: 'f', why: 'w' }], drop: [] });
    }
    if (task === 'round2' || task === 'rerun') {
      return JSON.stringify({
        statement: `${who}の代理人です。見直しました。`,
        evals: ids.map((id) => {
          if (opts.vetoBy === who && id === ids[0]) return { candId: id, score: 1, reason: '本人が嫌と言った', basis: 'stated' };
          if (opts.lowGuessBy === who && id.startsWith('mix')) return { candId: id, score: 2, reason: '重そう', basis: 'guess' };
          return { candId: id, score: id.startsWith('mix') ? 5 : 3, reason: '理由', basis: 'guess' };
        }),
        questions: task === 'round2' ? [{ candId: ids[0], text: `${who}さんへの確認です` }] : [],
      });
    }
    if (task === 'feas') return JSON.stringify({ statement: '実現性を検討しました。', items: ids.map((id, i) => ({ candId: id, verdict: i === 0 ? 'ok' : 'partial', needs: 'n', mvp: `${id}の最小の形`, later: 'l', risk: 'r' })) }) + (opts.withSources ? '§SRC§https://example.com/a https://example.com/b' : '');
    if (task === 'judge') return JSON.stringify({ scores: ids.map((id) => ({ candId: id, marks: id.startsWith('mix') ? [5, 4] : [3, 2], comment: 'c' })) });
    if (task === 'explain') return JSON.stringify({ reason: '全員の評価が高いためです。', influences: [{ name: 'A', point: '実装の軽さ' }], conflict: '', plan: { steps: '進め方', roles: [{ name: 'A', role: '画面' }] } });
    throw new Error('unknown task ' + task);
  };
}

(async () => {
  // ---- 採点ルールの単体確認 ----
  {
    const cands = [
      { id: 'a', title: 'A', origin: 'original' },
      { id: 'b', title: 'B', origin: 'original' },
      { id: 'm', title: 'M', origin: 'merged', from: ['a', 'b'] },
    ];
    const ev = (p, c, score, basis) => [`${p}__${c}`, { score, basis: basis || 'stated' }];
    const O = Object.fromEntries;

    // 評価基準なし: 支持だけで100点換算。本人の「嫌」は対象外、元より低い合体案も対象外
    let r = Engine.recommend(cands, O([ev('p', 'a', 5), ev('q', 'a', 5), ev('p', 'b', 1), ev('q', 'b', 5), ev('p', 'm', 3), ev('q', 'm', 4)]), ['p', 'q'], {}, []);
    assert.strictEqual(r.topId, 'a');
    assert.strictEqual(r.table.find((t) => t.candId === 'a').total, 100);
    assert.ok(r.table.find((t) => t.candId === 'b').excluded.includes('嫌'));
    assert.ok(r.table.find((t) => t.candId === 'm').excluded.includes('元の案より'));
    assert.strictEqual(r.ratio, null);

    // 推測の「嫌」では対象外にしない
    r = Engine.recommend(cands.slice(0, 2), O([ev('p', 'a', 3), ev('q', 'a', 3), ev('p', 'b', 1, 'guess'), ev('q', 'b', 5)]), ['p', 'q'], {}, []);
    assert.strictEqual(r.table.find((t) => t.candId === 'b').excluded, '');

    // 基準70：支持30。基準で強い案が、支持で強い案に勝つ
    const crit = [{ name: 'x', weight: 1 }, { name: 'y', weight: 1 }];
    r = Engine.recommend(cands.slice(0, 2), O([ev('p', 'a', 3), ev('q', 'a', 3), ev('p', 'b', 5), ev('q', 'b', 5)]), ['p', 'q'], { a: { marks: [5, 5] }, b: { marks: [1, 1] } }, crit);
    const ta = r.table.find((t) => t.candId === 'a');
    const tb = r.table.find((t) => t.candId === 'b');
    assert.deepStrictEqual([ta.crit, ta.support, ta.total], [70, 18, 88]);
    assert.deepStrictEqual([tb.crit, tb.support, tb.total], [14, 30, 44]);
    assert.strictEqual(r.topId, 'a');
    assert.deepStrictEqual(r.ratio, { crit: 70, support: 30 });

    // 基準の重み: [5,1] に重み 1:2 → (5+2)/3/5*70 = 32.7
    r = Engine.recommend(cands.slice(0, 1), {}, ['p'], { a: { marks: [5, 1] } }, [{ name: 'x', weight: 1 }, { name: 'y', weight: 2 }]);
    assert.strictEqual(r.table[0].crit, 32.7);

    // 推測の評価は重み半分: (1*5 + 0.5*2)/1.5 = 4 → 4/5*30 = 24
    r = Engine.recommend(cands.slice(0, 1), O([ev('p', 'a', 5), ev('q', 'a', 2, 'guess')]), ['p', 'q'], { a: { marks: [3, 3] } }, crit);
    assert.strictEqual(r.table[0].support, 24);
    assert.strictEqual(r.table[0].guess, 1);

    // 1.5点未満の差は僅差
    r = Engine.recommend(cands.slice(0, 2), O([ev('p', 'a', 5), ev('q', 'a', 4), ev('p', 'b', 4), ev('q', 'b', 5)]), ['p', 'q'], { a: { marks: [4, 4] }, b: { marks: [4, 4] } }, crit);
    assert.strictEqual(r.tie, true);

    // 以前の形式（好き/まあいい/嫌）の評価も読める
    assert.strictEqual(Engine.evalScore({ rating: 'like' }), 4);
    assert.strictEqual(Engine.evalScore({ rating: 'no' }), 1);

    // 評価基準の読み取り（重みの書き方）
    assert.deepStrictEqual(
      Engine.parseCriteria({ room: { main: { criteria: 'テーマに合っているか\n新しさ ×2\n完成度（30点）' } } }),
      [{ name: 'テーマに合っているか', weight: 1 }, { name: '新しさ', weight: 2 }, { name: '完成度', weight: 30 }]
    );
  }

  const store = memStore();
  const people = [
    { id: 'mem-aaaaa', name: 'A', secret: 'SECRET_A_実装が重いのは嫌' },
    { id: 'mem-bbbbb', name: 'B', secret: 'SECRET_B_面白さ最優先' },
    { id: 'mem-ccccc', name: 'C', secret: 'SECRET_C_発表映え' },
  ];
  for (const p of people) {
    await store.put('member', p.id, { name: p.name, deposited: true });
    await store.put('brief', p.id, Engine.normalizeBrief({
      ideas: [{ title: `${p.name}の案`, summary: '概要', target: { text: '学生', by: 'me' }, problem: { text: '', by: 'ai' }, feature: '目玉', push: 'push' }],
      likes: '好き', worries: p.secret, mustHaves: ['m1', 'm2', 'm3', 'm4'], wantFromOthers: '', acceptCondition: '',
    }));
  }
  const ctxOf = (p, opts) => ({ store, llm: mockLlm(opts || {}), me: p, lockWait: 0 });

  // ---- 最初の会議（評価基準なし）----
  const rec = await Engine.runMeeting(ctxOf(people[2]), { mode: 'full' });
  let snap = await Engine.snapshot(store);
  assert.strictEqual(snap.state.main.phase, 'review');
  assert.strictEqual(snap.state.main.runner, null);
  assert.strictEqual(snap.brief[people[0].id].mustHaves.length, 3, '譲れない点は3つまで');
  assert.strictEqual(Object.keys(snap.cand).length, 5, '元の案3 + 合体案1 + AIの新案1');
  assert.strictEqual(Object.values(snap.cand).filter((c) => c.origin === 'ai').length, 1);
  assert.strictEqual(rec.topId, 'mix1-1', '合体案が最高評価なら推薦される');
  assert.strictEqual(Object.values(snap.question).filter((q) => q.status === 'open').length, 3);
  assert.strictEqual(calls.length, 3 + 1 + 1 + 3 + 1, '基準なし: 意見3 + 合体1 + 実現性1 + 評価3 + 説明1');
  assert.strictEqual(calls.filter((c) => c.search).length, 1, 'Web検索を頼むのは実現性の検討だけ');
  assert.strictEqual(calls.find((c) => c.task === 'feas').search, true);
  assert.ok(Object.values(snap.cand).filter((c) => !c.dropped).every((c) => c.feas && c.feas.mvp && c.feas.searched === false), 'すべての案に、作れる範囲が付く（検索なしの印）');
  assert.ok(calls.filter((c) => c.task === 'round2').every((c) => c.user.includes('締切までに作れる範囲')), '評価し直すとき、代理人は実現性を見ている');
  assert.strictEqual(Object.keys(snap.skill).length, 3, '実装でできることが共有される');
  assert.strictEqual(Object.keys(snap.call).length, 9, 'AIの呼び出しが1回ずつ記録される');
  assert.ok(Object.values(snap.call).every((c) => c.ms >= 0 && c.user && c.out && c.owner));
  assert.strictEqual(Object.values(snap.call).filter((c) => c.owner === 'facilitator').length, 3);

  // 情報の分離: 各エージェントの呼び出しに他人の本音が混ざっていないこと。進行役には誰の本音も渡らないこと
  for (const c of calls) {
    const who = (c.system.match(/あなたは(.+?)さんの代理人/) || [])[1];
    for (const p of people) {
      if (p.name !== who) assert.ok(!c.user.includes(p.secret), `${who || '進行役'}の呼び出しに${p.name}の本音が漏れている`);
    }
    if (who) assert.ok(c.user.includes(people.find((p) => p.name === who).secret));
  }

  // ---- 確認質問に答える → 議論やり直し ----
  const [qid] = Object.entries(snap.question).find(([, q]) => q.memberId === people[0].id);
  const left = await Engine.answerQuestion(ctxOf(people[0]), qid, 'それなら賛成です');
  assert.strictEqual(left, 0);
  await Engine.approve(ctxOf(people[1])); // やり直し前の承認は無効になるはず
  calls.length = 0;
  await Engine.runMeeting(ctxOf(people[0]), { mode: 'rerun' });
  snap = await Engine.snapshot(store);
  assert.strictEqual(snap.state.main.round, 2);
  assert.strictEqual(Object.keys(snap.approval).length, 0, 'やり直すと承認はリセット');
  assert.ok(calls[0].user.includes('それなら賛成です'), '答えがエージェントに反映される');
  assert.strictEqual(calls.length, 3 + 1);

  // 進行中は他の人が始められない
  await store.put('state', 'main', { ...snap.state.main, runner: 'someone', runnerName: 'X', runnerAt: Date.now() });
  await assert.rejects(() => Engine.runMeeting(ctxOf(people[0]), { mode: 'rerun' }), /進行中/);
  await store.put('state', 'main', snap.state.main);

  // 全員承認で決定
  assert.strictEqual(await Engine.approve(ctxOf(people[0])), false);
  assert.strictEqual(await Engine.approve(ctxOf(people[1])), false);
  assert.strictEqual(await Engine.approve(ctxOf(people[2])), true);
  snap = await Engine.snapshot(store);
  assert.strictEqual(snap.state.main.phase, 'decided');
  assert.strictEqual(snap.state.main.decidedCandId, 'mix1-1');

  // ---- 評価基準あり・本人の「嫌」・推測の低評価 ----
  await store.put('room', 'main', { theme: 'かゆいところに手が届くアプリ', criteria: 'テーマに合っているか\n新しさ ×2' });
  calls.length = 0;
  const rec2 = await Engine.runMeeting(ctxOf(people[1], { vetoBy: 'B', lowGuessBy: 'C', withSources: true }), { mode: 'full' });
  snap = await Engine.snapshot(store);
  assert.strictEqual(calls.filter((c) => c.task === 'judge').length, 1, '基準があれば採点の呼び出しが1回入る');
  assert.strictEqual(calls.length, 3 + 1 + 1 + 3 + 1 + 1);
  const anyCand = Object.values(snap.cand).find((c) => c.feas);
  assert.strictEqual(anyCand.feas.searched, true, '検索した出典があれば、確認済みの印が付く');
  assert.deepStrictEqual(anyCand.feas.sources, ['https://example.com/a', 'https://example.com/b']);
  assert.ok(calls.find((c) => c.task === 'judge').user.includes('締切までに作れる範囲'), '採点にも実現性が渡る');
  assert.ok(calls.find((c) => c.task === 'judge').user.includes('2. 新しさ'), '採点に基準が番号つきで渡る');
  const judgeIn = calls.find((c) => c.task === 'judge').user;
  assert.ok(!judgeIn.includes('（合体案）') && !judgeIn.includes('進行役AIの新案') && !judgeIn.includes('提案:'), '採点には案の出どころを渡さない');
  assert.ok(calls.every((c) => !c.task || c.task === 'brief' || c.user.includes('かゆいところに手が届くアプリ')), 'すべての呼び出しにお題が渡る');
  const vetoed = rec2.table.find((t) => t.vetoBy.length);
  assert.ok(vetoed && vetoed.excluded && rec2.topId !== vetoed.candId, '本人の「嫌」が付いた案は推薦されない');
  const mix = rec2.table.find((t) => t.candId.startsWith('mix'));
  // 基準: [5,4] 重み1:2 → (5+8)/3/5*70 = 60.7
  assert.strictEqual(mix.crit, 60.7);
  assert.strictEqual(mix.marks.length, 2);
  assert.strictEqual(rec2.topId, mix.candId);
  assert.strictEqual(mix.excluded, '', '推測の低評価では対象外にならない');
  const auto = Object.values(snap.question).filter((q) => q.auto);
  assert.strictEqual(auto.length, 1, '推測の低評価は本人への確認質問になる');
  assert.strictEqual(auto[0].memberId, people[2].id);
  assert.strictEqual(snap.state.main.phase, 'review');
  assert.ok(snap.state.main.recommendation.plan.steps, '実装の進め方が入る');

  // ---- 代理人の応答が読めないとき: 仮の評価（どちらでもいい・推測）で続行し、採点が読めないときは止まる ----
  {
    const broken = (badTask) => {
      const good = mockLlm({});
      return async (req) => ((req.messages[0].content.match(/【タスク:(\w+)】/) || [])[1] === badTask && /あなたはAさん/.test(req.system + 'あなたはAさん') && (badTask !== 'round2' || /あなたはAさんの代理人/.test(req.system)) ? 'これはJSONではありません' : good(req));
    };
    const r3 = await Engine.runMeeting({ store, llm: broken('round2'), me: people[0], lockWait: 0 }, { mode: 'full' });
    snap = await Engine.snapshot(store);
    assert.ok(r3.topId, '1人の代理人が読めなくても会議は終わる');
    const evA = Object.values(snap.eval).filter((e) => e.memberId === people[0].id);
    assert.ok(evA.length && evA.every((e) => e.score === 3 && e.basis === 'guess'), '読めなかった代理人は「どちらでもいい・推測」になる');
    assert.ok(Engine.sortedMsgs(snap).some((m) => m.text.includes('読み取れなかった')), '仮の評価であることが発言に出る');
    await assert.rejects(() => Engine.runMeeting({ store, llm: broken('judge'), me: people[0], lockWait: 0 }, { mode: 'full' }), /読み取れません/);
    snap = await Engine.snapshot(store);
    assert.strictEqual(snap.state.main.runner, null, '失敗しても進行役の印は外れる');
  }

  // ---- 小物 ----
  assert.deepStrictEqual(Engine.parseJson('はい。\n```json\n{"a":1}\n```\n以上'), { a: 1 });
  assert.deepStrictEqual(Engine.splitCovered('好きな点は？\n<<済:1,2>>'), { text: '好きな点は？', covered: [1, 2] });
  assert.strictEqual(Engine.splitCovered('目印なし').covered, null);
  assert.strictEqual(Engine.paragraphs('一。\n\n二。').length, 2);

  console.log('OK: すべてのテストに通りました');
})().catch((e) => {
  console.error('NG:', e);
  process.exit(1);
});
