// 会議エンジンの通しテスト（AIと共有ストアはモック）。実行: npm test
const assert = require('assert');
const Engine = require('../src/engine.js');
const { memStore, mockLlm, calls } = require('./mocks.js');

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
    // AIの文章の後始末: 案の内部の番号は名前に、引用の印は外す（本物のAIでの通し確認で見つかった）
    const cm = { 'mix1-2': { title: '割り勘' }, 'mix1-22': { title: '別案' }, 'new1-1': { title: '催促' } };
    assert.strictEqual(Engine.cleanText('「mix1-2」が81点。次点のnew1-1(79点)より、mix1-2の支持が上。合体案(mix1-22)は別。', cm), '「割り勘」が81点。次点の「催促」(79点)より、「割り勘」の支持が上。合体案(「別案」)は別。');
    assert.strictEqual(Engine.cleanText('<cite index="15-11">無料枠があります。</cite>ただし注意。', cm), '無料枠があります。ただし注意。');
    assert.strictEqual(Engine.cleanText('番号のない文はそのまま', cm), '番号のない文はそのまま');
    assert.strictEqual(Engine.cleanText(null, cm), '');
    // 次点との差の内訳: 基準 x・y で +28 ずつ、支持で -12。合計は +44 で、内訳の和と合う
    const gap = Engine.compareTop(r);
    assert.strictEqual(gap.diff, 44);
    assert.deepStrictEqual(gap.rows.map((x) => [x.label, x.pts]), [['x', 28], ['y', 28], ['メンバーの支持', -12]]);
    assert.strictEqual(gap.rows.reduce((t, x) => t + x.pts, 0), gap.diff);
    assert.strictEqual(Engine.compareTop({ table: r.table, topId: 'a', runnerUpId: null }), null);
    // 基準ごとの根拠（notes）は、点と一緒に表へ入る。無くても採点は通る
    const rn = Engine.recommend(cands.slice(0, 1), {}, ['p'], { a: { marks: [5, 1], notes: ['根拠1'] } }, crit);
    assert.deepStrictEqual(rn.table[0].marks.map((m) => m.note), ['根拠1', '']);

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

  const savedBriefs = Object.fromEntries(people.map((p) => [p.id, snap.brief[p.id]]));
  // 全員承認で決定
  assert.strictEqual(await Engine.approve(ctxOf(people[0])), false);
  assert.strictEqual(await Engine.approve(ctxOf(people[1])), false);
  assert.strictEqual(await Engine.approve(ctxOf(people[2])), true);
  snap = await Engine.snapshot(store);
  assert.strictEqual(snap.state.main.phase, 'decided');
  assert.strictEqual(snap.state.main.decidedCandId, 'mix1-1');
  // 決定すると、共有の保存先から本音が消える。そのままではやり直せず、各自が預け直すとやり直せる
  for (const p of people) {
    assert.strictEqual(snap.brief[p.id].scrubbed, true, '決定後は本音が消えている');
    assert.strictEqual(snap.brief[p.id].likes, undefined);
    assert.ok(snap.brief[p.id].ideas.length, '案は残る');
  }
  assert.strictEqual(Object.keys(snap.question).length, 0, '確認のやり取りも消える');
  await assert.rejects(() => Engine.runMeeting(ctxOf(people[1]), { mode: 'full' }), /本音を消しました/);
  for (const p of people) await store.put('brief', p.id, savedBriefs[p.id]);

  // ---- 評価基準あり・本人の「嫌」・推測の低評価 ----
  await store.put('room', 'main', { theme: 'かゆいところに手が届くアプリ', criteria: 'テーマに合っているか\n新しさ ×2' });
  calls.length = 0;
  const rec2 = await Engine.runMeeting(ctxOf(people[1], { vetoBy: 'B', lowGuessBy: 'C', withSources: true }), { mode: 'full' });
  snap = await Engine.snapshot(store);
  assert.strictEqual(calls.filter((c) => c.task === 'judge').length, 2, '基準があれば採点の呼び出しが2回入る（ぶれを減らすため2回採点する）');
  assert.strictEqual(calls.length, 3 + 1 + 1 + 3 + 2 + 1);
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

  // ---- 止まった会議を「続きから」再開する／一時的な失敗は自動でやり直す ----
  {
    const good = mockLlm({});
    const taskOf = (req) => (req.messages[0].content.match(/【タスク:(\w+)】/) || [])[1] || '';
    // 直前の会議は採点（judge）で止まっている: 発言と合体案は済んでいるので、続きは採点とまとめだけ
    snap = await Engine.snapshot(store);
    assert.ok(snap.state.main.error && snap.state.main.failedAt, '止まった理由が残る');
    assert.ok(Engine.canResume(snap), '続きから再開できる');
    const candsBefore = Object.keys(snap.cand).length;
    let calls = [];
    const counting = async (req) => { calls.push(taskOf(req)); return good(req); };
    const r4 = await Engine.runMeeting({ store, llm: counting, me: people[0], lockWait: 0 }, { mode: 'resume' });
    snap = await Engine.snapshot(store);
    assert.ok(r4.topId, '再開して最後まで進む');
    assert.ok(!calls.includes('round1') && !calls.includes('merge') && !calls.includes('feas') && !calls.includes('round2'), '済んだ段階はやり直さない: ' + calls.join(','));
    assert.strictEqual(Object.keys(snap.cand).length, candsBefore, '案が二重に作られない');
    assert.strictEqual(snap.state.main.phase, 'review');
    assert.ok(!snap.state.main.ck && !snap.state.main.error, '終わったら進み具合の記録と、止まった理由は消える');
    assert.ok(!Engine.canResume(snap), '終わった会議は再開の対象にならない');

    // 途中（合体案づくり）で止まる → 1回目の発言は済んでいるので、再開では合体案から
    const failAt = (task, msg) => async (req) => { if (taskOf(req) === task) throw new Error(msg); return good(req); };
    await assert.rejects(() => Engine.runMeeting({ store, llm: failAt('merge', 'Claude APIエラー (403) forbidden'), me: people[0], lockWait: 0, retryWait: 0 }, { mode: 'full' }), /403/);
    snap = await Engine.snapshot(store);
    assert.strictEqual(snap.state.main.phase, 'collecting');
    assert.deepStrictEqual([snap.state.main.ck.r1.length, snap.state.main.ck.merge], [3, false], '1回目の発言まで済んだ記録が残る');
    calls = [];
    const r5 = await Engine.runMeeting({ store, llm: counting, me: people[1], lockWait: 0 }, { mode: 'resume' });
    assert.ok(r5.topId && calls.includes('merge') && calls.includes('round2') && !calls.includes('round1'), '合体案から再開する: ' + calls.join(','));

    // 一時的な失敗（通信の途切れ）は、自動でやり直して続ける
    let n = 0;
    const flaky = async (req) => { if (++n === 2 || n === 5) throw new Error('fetch failed'); return good(req); };
    const r6 = await Engine.runMeeting({ store, llm: flaky, me: people[0], lockWait: 0, retryWait: 0 }, { mode: 'full' });
    assert.ok(r6.topId, '途切れても自動でやり直して終わる');
    // 3回続けて失敗したら止まる。設定の誤りは1回で止まる
    n = 0;
    await assert.rejects(() => Engine.runMeeting({ store, llm: async () => { n++; throw new Error('fetch failed'); }, me: people[0], lockWait: 0, retryWait: 0 }, { mode: 'full' }), /fetch failed/);
    assert.strictEqual(n, 3, '一時的な失敗は3回まで試す');
    n = 0;
    await assert.rejects(() => Engine.runMeeting({ store, llm: async () => { n++; throw new Error('Claude APIキーが未設定です'); }, me: people[0], lockWait: 0, retryWait: 0 }, { mode: 'full' }), /未設定/);
    assert.strictEqual(n, 1, '設定の誤りはやり直さない');
    // 参加者が変わったら、続きからではなく最初から
    await store.del('brief', people[2].id);
    assert.ok(!Engine.canResume(await Engine.snapshot(store)), '参加者が変わったら再開しない');
  }

  // ---- 小物 ----
  assert.deepStrictEqual(Engine.parseJson('はい。\n```json\n{"a":1}\n```\n以上'), { a: 1 });
  assert.deepStrictEqual(Engine.splitCovered('好きな点は？\n<<済:1,2>>'), { text: '好きな点は？', covered: [1, 2], choices: [] });
  assert.deepStrictEqual(Engine.splitCovered('条件は？\n<<選:確実に動くこと｜AIを使うこと|特になし>>\n<<済:1>>'), { text: '条件は？', covered: [1], choices: ['確実に動くこと', 'AIを使うこと', '特になし'] });
  assert.strictEqual(Engine.splitCovered('目印なし').covered, null);
  // 決定したら本音を消す: 案だけが残り、確認のやり取りは消える
  {
    const docs = { 'brief/a': { ideas: [{ title: 'X' }], likes: '好き', worries: '不安', mustHaves: ['条件'], impl: '10時間', updates: [{ text: '追加' }] }, 'question/q1': { text: '合っていますか' } };
    const st = { put: async (k, id, d) => { docs[k + '/' + id] = d; }, del: async (k, id) => { delete docs[k + '/' + id]; } };
    const n = await Engine.scrubPrivate(st, { brief: { a: docs['brief/a'] }, question: { q1: docs['question/q1'] } });
    assert.strictEqual(n, 1);
    assert.deepStrictEqual(Object.keys(docs), ['brief/a']);
    assert.deepStrictEqual(docs['brief/a'].ideas, [{ title: 'X' }]);
    assert.strictEqual(docs['brief/a'].scrubbed, true);
    for (const k of Engine.PRIVATE_KEYS) assert.strictEqual(docs['brief/a'][k], undefined, k + ' が残っている');
  }
  // 採点を2回して平均する: 半点と、2回の差が残る
  {
    const a = { c1: { marks: [4, 2], notes: ['x', 'y'], comment: 'k' } };
    const b = { c1: { marks: [3, 2], notes: ['p', 'q'], comment: 'z' } };
    const m = Engine.mergeJudges(a, b, 2);
    assert.deepStrictEqual(m.c1.marks, [3.5, 2]);
    assert.deepStrictEqual(m.c1.spread, [1, 0]);
    assert.strictEqual(Engine.mergeJudges(a, null, 2), a);
    const rec = Engine.recommend([{ id: 'c1', title: 'A', origin: 'original' }], {}, [], m, [{ name: '新しさ', weight: 1 }, { name: '実現性', weight: 1 }]);
    assert.strictEqual(rec.table[0].marks[0].score, 3.5);
    assert.strictEqual(rec.table[0].marks[0].spread, 1);
  }
  // 実現性: 番号が括弧付き・題名・別のキー名で返ってきても、案に結び付く
  {
    const snap = { cand: { 'ab-1': { title: '割り勘アプリ' }, 'mix1-2': { title: '合体案' }, 'zz-9': { title: '取り下げ', dropped: true } } };
    const got = Engine.feasItems({ items: [{ candId: '[ab-1]', verdict: 'ok' }, { id: 'MIX1-2', verdict: 'hard' }, { candId: 'zz-9' }, { candId: 'nope' }] }, snap);
    assert.deepStrictEqual(got.map((x) => x.candId), ['ab-1', 'mix1-2']);
    assert.deepStrictEqual(Engine.feasItems({ items: [{ candId: '割り勘アプリ' }, { title: '「合体案」' }] }, snap).map((x) => x.candId), ['ab-1', 'mix1-2']);
    assert.deepStrictEqual(Engine.feasItems({ items: { 'ab-1': { verdict: 'ok' } } }, snap).map((x) => x.candId), ['ab-1']);
    assert.deepStrictEqual(Engine.feasItems({}, snap), []);
  }
  assert.strictEqual(Engine.paragraphs('一。\n\n二。').length, 2);

  console.log('OK: すべてのテストに通りました');
})().catch((e) => {
  console.error('NG:', e);
  process.exit(1);
});
