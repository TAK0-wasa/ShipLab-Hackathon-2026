// かわりに会議 — 会議エンジン（画面からも Node のテストからも使える）
// 重要な設計: 各エージェントの呼び出しには「その担当者の考え」と「公開された会議ログ」しか渡さない。
// 進行役（合体案づくり・推薦理由の説明）には公開情報しか渡さない。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const LOCK_MS = 3 * 60 * 1000;
  // 採点は100点満点: お題と評価基準への合い方 70点 ＋ メンバーの支持 30点
  const RATIO = { crit: 70, support: 30 };
  const FEAS_LABEL = { ok: '締切までに作れる', partial: '一部なら作れる', hard: '締切までには難しい' };
  const SUPPORT_LABEL = { 5: '強く推す', 4: '好き', 3: 'どちらでもいい', 2: 'あまり乗り気でない', 1: '嫌' };
  const clamp5 = (v, d) => {
    const n = Math.round(Number(v));
    return n >= 1 && n <= 5 ? n : d === undefined ? 3 : d;
  };
  // 支持の点数（1〜5）。以前の形式（好き/まあいい/嫌）で保存された評価も読めるようにする
  function evalScore(ev) {
    if (!ev) return 3;
    if (ev.score >= 1 && ev.score <= 5) return ev.score;
    return ev.rating === 'like' ? 4 : ev.rating === 'no' ? 1 : 3;
  }
  const MAX_MUST = 3;
  const INTERVIEW_ITEMS = ['案', '好きな点・不安', '外したくない条件', '実装でできること'];
  // 代理人の返答の末尾にある <<済:1,2>> を取り出し、表示用の文章と分ける
  function splitCovered(text) {
    const m = /<<済[:：]([\d,、\s]*)>>/.exec(text || '');
    const covered = m ? [...new Set((m[1].match(/\d/g) || []).map(Number).filter((n) => n >= 1 && n <= INTERVIEW_ITEMS.length))] : null;
    return { text: (text || '').replace(/<<済[:：][^>]*>>/g, '').trim(), covered };
  }

  const now = () => Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let seq = 0;
  const uid = (p) => `${p || ''}${now().toString(36)}${(seq++).toString(36).padStart(3, '0')}${Math.random().toString(36).slice(2, 6)}`;
  const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));

  function paragraphs(text) {
    const t = str(text);
    if (!t) return [];
    let parts = t.split(/\n\s*\n+/).map((x) => x.trim()).filter(Boolean);
    if (parts.length === 1 && t.length > 90) {
      const sents = t.replace(/\n/g, '').match(/[^。！？!?]+[。！？!?]*/g) || [t];
      parts = [];
      for (let i = 0; i < sents.length; i += 2) parts.push(sents.slice(i, i + 2).join('').trim());
      parts = parts.filter(Boolean);
    }
    return parts;
  }

  function parseJson(text) {
    if (!text) throw new Error('空の応答');
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s < 0 || e <= s) throw new Error('JSONが見つかりません');
    return JSON.parse(text.slice(s, e + 1));
  }

  function partialStatement(t) {
    const m = /"(?:statement|reason)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(t || '');
    if (!m) return '';
    return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }

  async function askJson(llm, system, user, maxTokens, onPartial, extra) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      if (i) await sleep(600 * i);
      const retry = i ? '\n\n※前回の出力はJSONとして読めませんでした。JSONオブジェクトだけを出力してください。' : '';
      const req = { system, messages: [{ role: 'user', content: user + retry }], maxTokens: maxTokens || 8000 };
      if (extra) Object.assign(req, extra);
      if (onPartial) req.onText = (t) => { try { onPartial(partialStatement(t)); } catch (e) {} };
      const raw = await llm(req);
      const [text, src] = String(raw || '').split('§SRC§');
      try {
        const out = parseJson(text);
        if (src) out.__sources = src.split(/\s+/).filter((u) => /^https?:\/\//.test(u)).slice(0, 8);
        return out;
      } catch (e) {
        lastErr = e;
      }
    }
    const err = new Error('AIの応答を3回読み取れませんでした（' + lastErr.message + '）');
    err.unreadable = true;
    throw err;
  }

  async function snapshot(store) {
    const docs = await store.all();
    const snap = { member: {}, brief: {}, msg: {}, cand: {}, eval: {}, question: {}, approval: {}, state: {}, room: {}, skill: {}, call: {} };
    for (const d of docs) {
      if (!snap[d.kind]) snap[d.kind] = {};
      snap[d.kind][d.id] = d.data;
    }
    return snap;
  }

  const sortedMsgs = (snap) =>
    Object.entries(snap.msg)
      .map(([id, m]) => ({ id, ...m }))
      .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));

  const activeCands = (snap) =>
    Object.entries(snap.cand)
      .map(([id, c]) => ({ id, ...c }))
      .filter((c) => !c.dropped)
      .sort((a, b) => (a.order || 0) - (b.order || 0));

  const partText = (p) => (p && typeof p === 'object' ? str(p.text) : str(p));

  // ---------- お題と評価基準（ルームで共有） ----------
  function topicText(snap) {
    const r = (snap.room && snap.room.main) || {};
    const crit = str(r.criteria).split(/\n+/).map((x) => x.trim()).filter(Boolean);
    const lines = [`テーマ: ${str(r.theme) || '（未設定）'}`];
    lines.push(crit.length ? '評価基準:\n' + crit.map((c) => '  - ' + c).join('\n') : '評価基準: （未設定）');
    if (str(r.conditions)) lines.push(`締切・条件: ${str(r.conditions)}`);
    return lines.join('\n');
  }
  // 評価基準を1行ずつ読む。行の最後の「×2」「(30点)」は重み
  function parseCriteria(snap) {
    const r = (snap.room && snap.room.main) || {};
    const out = str(r.criteria)
      .split(/\n+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((line) => {
        const m = /^(.*?)[\s\u3000]*(?:[×xX*＊]\s*(\d+(?:\.\d+)?)|[（(]\s*(\d+(?:\.\d+)?)\s*(?:点|倍)?\s*[)）])\s*$/.exec(line);
        if (m && m[1].trim()) return { name: m[1].trim(), weight: Number(m[2] || m[3]) || 1 };
        return { name: line, weight: 1 };
      });
    if (!out.length && str(r.theme)) out.push({ name: `テーマ「${str(r.theme)}」に合っているか`, weight: 1, implicit: true });
    return out;
  }
  const hasTopic = (snap) => {
    const r = (snap.room && snap.room.main) || {};
    return !!(str(r.theme) || str(r.criteria));
  };

  // 個室の代理人に渡す文脈: お題、他のメンバーがすでに預けた案（案は公開情報）、会議の公開状況
  function interviewContext(snap, myId) {
    const out = ['【お題と評価基準】', topicText(snap)];
    const others = Object.keys(snap.brief).filter((id) => id !== myId && snap.member[id]);
    const lines = [];
    for (const id of others) {
      for (const i of snap.brief[id].ideas || []) {
        if (i.push === 'drop') continue;
        lines.push(`- ${(snap.member[id] || {}).name}さんの案「${i.title}」: 誰向け=${partText(i.target) || '-'}／解決=${partText(i.problem) || '-'}／目玉機能=${partText(i.feature) || '-'}`);
      }
    }
    out.push('', '【他のメンバーがすでに預けた案】', lines.length ? lines.join('\n') : '（まだ誰も預けていません）');
    const pub = publicContext(snap);
    if (pub) out.push('', '【現在の会議の公開状況（本人から聞かれたら説明に使ってよい）】', pub);
    return out.join('\n');
  }

  // ---------- 個室での聞き取り ----------
  function interviewSystem(name, context) {
    return [
      `あなたは${name}さん専属の代理人エージェントです。ここは他のメンバーには見えない、本人と1対1で話す場で、${name}さんの本音を聞き取るのが仕事です。`,
      'あとであなたは、チームの「どの案にするか」を決める会議に、本人の代わりに出席します。そのために必要なことを短い質問で聞いてください。',
      '',
      '聞き取りの進め方（短く済ませる。聞くのは次の4項目だけ）:',
      '  項目1 案: 本人の案。一言だけ・まだ固まっていない草案でも歓迎する。下の「お題と評価基準」が設定されていれば、それに照らして一言受け止める。',
      '  項目2 好きな点と不安な点: 1回の質問でまとめて聞く（「この案の一番好きなところと、逆に不安なところを教えてください」）。',
      '  項目3 外したくない条件: 「譲れない点はありますか」とだけ聞くと答えにくいので、必ずその案とお題に合わせた具体例を2〜3個出して選べるようにする。例:「たとえば『締切までに確実に動くこと』『AIを使うこと』『自分が実装できる技術で作れること』のように、これが崩れるなら別の案がいい、という条件はありますか？ 特になければ『なし』で大丈夫です」',
      '  項目4 実装でできること: 「この案を作るなら、自分はどこを担当できそうか、締切までにどのくらい時間を使えそうか」を1回で聞く。',
      '- 本人が1回の発言で複数の項目に答えていたら、その項目は聞き直さない。',
      '- 案が4個以上のとき: 「特に推したい3つはどれか」「無しでいい案はあるか」を1回で聞き、項目2〜4は推したい案についてだけ聞く。',
      '- 草案で「誰向けか・何を解決するか・目玉機能」が空いていても、無理に埋めさせない。聞くなら1問だけ。',
      '- 下の「他のメンバーがすでに預けた案」に案があるときだけ、4項目のあとに1回だけ、案の名前と目玉機能を見せて「取り入れたい部分はありますか」と聞いてよい。まだ誰も預けていなければ聞かない。',
      '- 「採用されなかったら何が残れば納得できるか」は、ここでは聞かない（会議のあと、必要になったときだけ確認する）。',
      '',
      'ルール:',
      '- 質問は1回に1つ。1〜3文で短く。敬語でやわらかく。音声で読み上げられることがあるので、記号や箇条書きに頼らず、話し言葉で書く。',
      '- 本人が言っていないことを決めつけない。評価や説教はしない。',
      '- 外したくない条件は最大' + MAX_MUST + 'つまで。多いときは優先順位を聞く。',
      '- 4項目が聞けたら、それ以上質問を足さず、「『預ける内容を確認する』ボタンを押してください」と案内する。本人が途中で預けたいと言ったら止めない（足りない所は推測として扱われる）。それ以降は本人が「やっぱりこう思う」と言ってきたら受け止める。',
      '- 返答の一番最後の行に、必ず <<済:1,2>> の形で、ここまでに本人から聞けた項目の番号だけを書く（1=案 2=好きな点と不安な点 3=外したくない条件 4=実装でできること）。まだ何も聞けていなければ <<済:>> と書く。この行は本人には表示されない。',
      '',
      context || '',
    ].join('\n');
  }

  function normPart(p) {
    if (p && typeof p === 'object') return { text: str(p.text), by: p.by === 'me' ? 'me' : 'ai' };
    return { text: str(p), by: 'me' };
  }

  function normalizeBrief(raw) {
    const ideas = (Array.isArray(raw.ideas) ? raw.ideas : [])
      .map((i) => ({
        title: str(i.title) || '（無題の案）',
        summary: str(i.summary),
        target: normPart(i.target),
        problem: normPart(i.problem),
        feature: normPart(i.feature),
        push: ['push', 'normal', 'drop'].includes(i.push) ? i.push : 'normal',
      }))
      .filter((i) => i.title || i.summary);
    return {
      ideas,
      likes: str(raw.likes),
      worries: str(raw.worries),
      mustHaves: (Array.isArray(raw.mustHaves) ? raw.mustHaves : []).map(str).filter(Boolean).slice(0, MAX_MUST),
      wantFromOthers: str(raw.wantFromOthers),
      acceptCondition: str(raw.acceptCondition),
      impl: str(raw.impl),
      updates: [],
    };
  }

  async function extractBrief(llm, name, chat) {
    const transcript = chat.map((m) => `${m.role === 'user' ? name : 'エージェント'}: ${m.content}`).join('\n');
    const system = [
      `あなたは${name}さんの代理人エージェントです。本人と1対1で話した会話記録から、会議に持っていく「預かりメモ」をJSONで作ります。`,
      'ルール:',
      '- 本人が実際に言った内容は by を "me" にする。本人が言っておらず、あなたが仮で埋めた内容は by を "ai" にする。この区別は必ず守る。',
      '- 各案の target（誰向けか）・problem（何を解決するか）・feature（目玉機能）が空なら、もっともらしい候補を1つ仮置きして by を "ai" にする。',
      '- push は、本人が特に推している案は "push"、本人が「無しでいい」と言った案は "drop"、それ以外は "normal"。',
      '- likes / worries / wantFromOthers / acceptCondition / impl は本人が言った内容だけを要約する。言っていなければ空文字にする（作らない）。',
      '- impl は実装面（本人が担当できること、使える技術、使える時間、避けたいこと）。',
      `- mustHaves（譲れない点）は本人が言ったものだけ、最大${MAX_MUST}つ。`,
      '- 出力はJSONオブジェクトだけ。前後に説明を書かない。',
    ].join('\n');
    const user = [
      '【タスク:brief】次の会話記録から預かりメモを作ってください。',
      '',
      '出力形式:',
      '{"ideas":[{"title":"案の短い名前","summary":"1〜2文の説明","target":{"text":"","by":"me"},"problem":{"text":"","by":"me"},"feature":{"text":"","by":"ai"},"push":"push"}],"likes":"","worries":"","mustHaves":[""],"wantFromOthers":"","acceptCondition":"","impl":""}',
      '',
      '会話記録:',
      transcript,
    ].join('\n');
    const brief = normalizeBrief(await askJson(llm, system, user, 8000));
    if (!brief.ideas.length) throw new Error('案が1つも読み取れませんでした。代理人に案を話してから、もう一度お試しください。');
    return brief;
  }

  // ---------- 会議 ----------
  function candText(cands, members, anonymous) {
    return cands
      .map((c) => {
        const feas = c.feas ? [`  実現性（進行役AIの検討）: ${FEAS_LABEL[c.feas.verdict] || '-'}`, `  締切までに作れる範囲: ${c.feas.mvp || '-'}`, `  後回しにする範囲: ${c.feas.later || '-'}`] : [];
        if (anonymous) {
          return [`[${c.id}] ${c.title}`, `  概要: ${c.summary || '-'}`, `  誰向けか: ${partText(c.target) || '-'}`, `  何を解決するか: ${partText(c.problem) || '-'}`, `  目玉機能: ${partText(c.feature) || '-'}`].concat(feas).join('\n');
        }
        const kind = c.origin === 'merged' ? '合体案' : c.origin === 'ai' ? '進行役AIの新案' : `元の案／提案: ${(c.owners || []).map((o) => (members[o] || {}).name || '?').join('・')}`;
        return [
          `[${c.id}] ${c.title}（${kind}）`,
          `  概要: ${c.summary || '-'}`,
          `  誰向けか: ${partText(c.target) || '-'}`,
          `  何を解決するか: ${partText(c.problem) || '-'}`,
          `  目玉機能: ${partText(c.feature) || '-'}`,
        ].concat(feas).join('\n');
      })
      .join('\n');
  }

  function logText(msgs, limit) {
    const list = msgs.filter((m) => m.type !== 'system').slice(-(limit || 14));
    return list.length ? list.map((m) => `${m.speakerName}: ${m.text}`).join('\n') : '（まだ発言はありません）';
  }

  function privateText(name, brief) {
    const lines = [
      `好きな点: ${brief.likes || '（聞けていない）'}`,
      `不安な点: ${brief.worries || '（聞けていない）'}`,
      `外したくない条件（譲れない点）: ${brief.mustHaves && brief.mustHaves.length ? brief.mustHaves.join(' ／ ') : '（特になし）'}`,
      `他の案から取り入れたい部分: ${brief.wantFromOthers || '（聞けていない）'}`,
      `不採用でも納得できる条件: ${brief.acceptCondition || '（聞けていない）'}`,
      `実装面（担当できること・技術・時間・避けたいこと）: ${brief.impl || '（聞けていない）'}`,
      `本人の案: ${(brief.ideas || []).map((i) => `${i.title}${i.push === 'push' ? '（特に推している）' : i.push === 'drop' ? '（無しでいい）' : ''}`).join('、') || '（なし）'}`,
    ];
    const ups = brief.updates || [];
    if (ups.length) {
      lines.push('', `その後${name}さん本人から追加で聞いたこと（新しいものほど優先）:`);
      for (const u of ups) lines.push(`- ${u.q ? `質問「${u.q}」への答え: ` : ''}${u.text}`);
    }
    return lines.join('\n');
  }

  function agentSystem(name) {
    return [
      `あなたは${name}さんの代理人エージェントです。チームで「どの案にするか」を決める会議に、本人の代わりに出席しています。`,
      `あなたが知っているのは${name}さんの考えと、会議で公開された内容だけです。他のメンバーの本音は知りません。`,
      'ルール:',
      `- ${name}さんの立場で主張し、外したくない条件は守る。ただし良い合体案や新案には歩み寄る。`,
      '- 「お題と評価基準」が設定されていれば、各案がそれにどれだけ合うかを評価の理由に必ず入れる。好みだけで評価しない。',
      '- 実装面も見る。チーム全員のできること・使える時間で締切までに作りきれるかを考える。',
      '- 本人の発言そのものは引用しない。他人の案への不満は、角が立たないよう理由を言い換えて伝える。',
      '- 本人から聞いた内容に基づく評価は basis を "stated"、あなたの推測による評価は basis を "guess" にする。',
      '- score は、本人がその案をどのくらい支持するかを1〜5の整数で付ける（5=強く推す 4=好き 3=どちらでもいい 2=あまり乗り気でない 1=嫌）。1 は本人がはっきり嫌だと言った場合か、本人が挙げた外したくない条件に明らかに反する場合だけ使い、そのとき basis は必ず "stated" にする。推測で低く付けるときは 2 までにする。',
      '- statement は会議での発言。話し言葉の丁寧語で、具体的に。読みやすいように2〜3段落に分け、段落の間は空行（\\n\\n）にする。1段落目は立場（どの案を推すか・どう見ているか）を1〜2文、2段落目はその理由を1〜2文、3段落目は他の案への提案や歩み寄れる点を1〜2文。',
      '- 出力はJSONオブジェクトだけ。前後に説明を書かない。',
    ].join('\n');
  }

  async function agentTurn(ctx, env, member, brief, mode) {
    const { llm } = ctx;
    const cands = activeCands(env.snap);
    const base = [
      '【お題と評価基準】',
      topicText(env.snap),
      '',
      `【あなただけが知っている${member.name}さんの考え】`,
      privateText(member.name, brief),
      '',
      '【会議に出ている案】',
      candText(cands, env.snap.member),
      '',
      '【これまでの会議の発言】',
      logText(sortedMsgs(env.snap)),
      '',
    ];
    let task;
    if (mode === 'round1') {
      task = [
        '【タスク:round1】最初の意見表明です。本人の案の良さを伝えつつ、他の案への評価と、他の案から取り入れたい部品（誰向けか=target／何を解決するか=problem／目玉機能=feature）を述べてください。会議に出ているすべての案を評価してください。',
        `canDo には、${member.name}さんが実装で担当できること・使える技術・使える時間を、チームに共有してよい形で1〜2文にまとめてください（聞けていなければ空文字）。`,
        '出力形式:',
        '{"statement":"","evals":[{"candId":"","score":4,"reason":"","basis":"stated"}],"wantParts":[{"candId":"","part":"feature","why":""}],"canDo":""}',
      ];
    } else {
      const asked = Object.values(env.snap.question)
        .filter((q) => q.memberId === member.id)
        .map((q) => `- ${q.text}`)
        .join('\n');
      task = [
        `【タスク:${mode}】${mode === 'rerun' ? '本人から新しい意見が届いたので議論をやり直します。' : '合体案が出ました。'}合体案と進行役AIの新案を含むすべての案を、本人の立場で評価し直してください。`,
        `そのうえで、${member.name}さん本人の反応が預かった考えから予測しにくい点があれば、本人への確認質問を作ってください（最大${mode === 'rerun' ? 1 : 2}個、無ければ空配列）。`,
        '質問は「〇〇さんの案のこの部分を入れると、あなたが気にしていた△△が減りそうですが、どうですか？」のように、他の人の案や合体案を踏まえた具体的なものにしてください。預かった考えから賛成・反対が予測できる点は聞かないでください。本人の案が推薦から外れそうで、不採用でも納得できる条件が聞けていない場合は、「何が残っていれば納得できますか」を質問に含めてかまいません。',
        asked ? 'すでに本人に聞いた質問（同じことは聞かない）:\n' + asked : '',
        '出力形式:',
        '{"statement":"","evals":[{"candId":"","score":3,"reason":"","basis":"guess"}],"questions":[{"candId":"","text":""}]}',
      ];
    }
    const live = (text) => ctx.onLive && ctx.onLive({ speakerName: `${member.name}さんの代理人`, text });
    try {
      return await askJson(llm, agentSystem(member.name), base.concat(task).join('\n'), undefined, live);
    } catch (e) {
      if (!e.unreadable) throw e;
      return {
        statement: '（この代理人の応答を読み取れなかったため、この回はすべての案を「どちらでもいい・推測」として扱っています。）',
        evals: cands.map((c) => ({ candId: c.id, score: 3, reason: '応答を読み取れなかったための仮の評価', basis: 'guess' })),
        questions: [],
        wantParts: [],
        canDo: '',
        fallback: true,
      };
    }
  }

  // 推薦の計算（AIではなくコードで決める。なぜその点になったか追えるようにするため）
  // 合計100点 = 評価基準への合い方70点（進行役AIが基準ごとに5段階、重み付き平均）
  //           + メンバーの支持30点（各代理人が5段階。推測による評価は重み半分）
  // 対象外: 本人が「嫌」と言った案 / 元の案より合計が低い合体案
  function recommend(cands, evals, participants, judge, criteria) {
    const r1 = (x) => Math.round(x * 10) / 10;
    const crits = criteria || [];
    const table = cands.map((c) => {
      let wsum = 0;
      let ssum = 0;
      let guess = 0;
      const vetoBy = [];
      for (const pid of participants) {
        const ev = evals[`${pid}__${c.id}`];
        const sc = evalScore(ev);
        const stated = !!(ev && ev.basis === 'stated');
        const w = stated ? 1 : 0.5;
        wsum += w;
        ssum += w * sc;
        if (!stated) guess++;
        if (sc === 1 && stated) vetoBy.push(pid);
      }
      const supportRate = wsum ? ssum / wsum / 5 : 0.6;
      const j = (judge || {})[c.id] || {};
      const marks = crits.map((k, i) => ({ name: k.name, weight: k.weight, score: clamp5(j.marks && j.marks[i]) }));
      const cw = marks.reduce((t, m) => t + m.weight, 0);
      const crit = marks.length && cw ? r1((marks.reduce((t, m) => t + m.weight * m.score, 0) / cw / 5) * RATIO.crit) : null;
      const support = r1(supportRate * (crit === null ? 100 : RATIO.support));
      const total = r1((crit || 0) + support);
      return { candId: c.id, title: c.title, origin: c.origin, from: c.from || [], crit, support, total, score: total, marks, comment: str(j.comment), guess, vetoBy, excluded: '' };
    });
    const byId = Object.fromEntries(table.map((t) => [t.candId, t]));
    for (const t of table) {
      if (t.vetoBy.length) {
        t.excluded = '本人が「嫌」と言ったメンバーがいる';
        continue;
      }
      if (t.origin === 'merged') {
        const src = t.from.map((id) => byId[id]).filter((x) => x && !x.vetoBy.length);
        const best = src.reduce((m, x) => Math.max(m, x.total), -1);
        if (best > t.total) t.excluded = '元の案より点が低い合体案';
      }
    }
    const rank = (a, b) => b.total - a.total || b.support - a.support || (a.origin === 'original' ? 0 : 1) - (b.origin === 'original' ? 0 : 1);
    let eligible = table.filter((t) => !t.excluded).sort(rank);
    let allVetoed = false;
    if (!eligible.length) {
      allVetoed = true;
      eligible = table.slice().sort((a, b) => a.vetoBy.length - b.vetoBy.length || rank(a, b));
    }
    const top = eligible[0] || null;
    const second = eligible[1] || null;
    // 1.5点未満の差は「僅差」として、残った2案を全員にもう一度だけ聞く
    const tie = !!(top && second && (allVetoed || top.total - second.total < 1.5));
    return { table, topId: top ? top.candId : null, runnerUpId: second ? second.candId : null, tie, allVetoed, ratio: crits.length ? RATIO : null };
  }

  // 進行役AIが、各案を評価基準ごとに5段階で採点する（公開情報だけを見る）
  async function facilitatorJudge(ctx, env, criteria) {
    const cands = activeCands(env.snap);
    const system = [
      'あなたは会議の中立な進行役であり、審査員の目線で案を採点します。特定のメンバーの味方はしません。あなたが知っているのは公開された内容だけです。',
      'ルール:',
      '- 各案を、評価基準ごとに1〜5の整数で採点する。点の意味は次のとおり。',
      '    5 = この基準で審査員が高く評価する決め手になる。他の案と比べても抜けている。',
      '    4 = この基準で明確な強みがある。',
      '    3 = 可もなく不可もない。または、案の内容から判断材料が読み取れない。',
      '    2 = この基準で弱点がある。',
      '    1 = この基準を満たしていない。',
      '- 案が誰のものか、どう作られたかは知らされていない。案の内容だけで採点する。',
      '- 案に「実現性」と「締切までに作れる範囲」が書かれていれば、完成度や実際に動くかに関わる基準では、それを踏まえて採点する。',
      '- 案どうしで差がつくように採点する。全部に3や4を並べない。根拠が案の内容から読み取れない基準は3にする。',
      '- marks は、下の評価基準の番号順に並べた整数の配列にする（基準の数と同じ長さ）。',
      '- comment は、その案がどの基準に強く、どの基準に弱いかを1〜2文で。',
      '- 出力はJSONオブジェクトだけ。',
    ].join('\n');
    const user = [
      '【タスク:judge】各案を評価基準ごとに採点してください。',
      '',
      '【お題と評価基準】',
      topicText(env.snap),
      '',
      '【評価基準（この番号順に採点）】',
      criteria.map((k, i) => `${i + 1}. ${k.name}`).join('\n'),
      '',
      '【会議に出ている案】',
      candText(cands, env.snap.member, true), // 誰の案か・合体案か・AIの新案かは渡さない
      '',
      '出力形式:',
      '{"scores":[{"candId":"","marks":[3,4,2],"comment":""}]}',
    ].join('\n');
    let judge = {};
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await askJson(ctx.llm, system, user, 8000, (text) => ctx.onLive && ctx.onLive({ speakerName: '進行役AI', text }));
      judge = {};
      for (const x of Array.isArray(out.scores) ? out.scores : []) {
        if (!x || !env.snap.cand[x.candId] || !Array.isArray(x.marks) || x.marks.length < criteria.length) continue;
        judge[x.candId] = { marks: criteria.map((_, i) => clamp5(x.marks[i])), comment: str(x.comment) };
      }
      if (cands.every((c) => judge[c.id])) return judge;
    }
    throw new Error('進行役AIの採点が全部の案にそろいませんでした。もう一度「最初から会議をやり直す」を押してください。');
  }

  async function postMsg(ctx, env, m) {
    const id = uid('g');
    const data = { round: env.round, at: now(), ...m };
    await ctx.store.put('msg', id, data);
    env.snap.msg[id] = data;
    if (ctx.onLive) ctx.onLive(null);
  }

  async function setState(ctx, env, patch) {
    env.state = { ...env.state, ...patch };
    if (env.state.runner) env.state.runnerAt = now();
    await ctx.store.put('state', 'main', env.state);
    env.snap.state.main = env.state;
  }

  async function storeEvals(ctx, env, member, out, basisDefault) {
    const cands = env.snap.cand;
    for (const ev of Array.isArray(out.evals) ? out.evals : []) {
      if (!ev || !cands[ev.candId] || cands[ev.candId].dropped) continue;
      const data = {
        memberId: member.id,
        candId: ev.candId,
        score: clamp5(ev.score, evalScore({ rating: ev.rating })),
        reason: str(ev.reason),
        basis: ev.basis === 'stated' ? 'stated' : basisDefault || 'guess',
        round: env.round,
      };
      const id = `${member.id}__${ev.candId}`;
      await ctx.store.put('eval', id, data);
      env.snap.eval[id] = data;
    }
  }

  function skillText(env) {
    const lines = env.participants
      .filter((id) => env.snap.skill[id] && env.snap.skill[id].text)
      .map((id) => `- ${(env.snap.member[id] || {}).name}さん: ${env.snap.skill[id].text}`);
    return lines.length ? lines.join('\n') : '（共有されていません）';
  }

  async function facilitatorMerge(ctx, env) {
    const cands = activeCands(env.snap);
    const names = env.snap.member;
    const evalLines = Object.values(env.snap.eval)
      .filter((e) => env.snap.cand[e.candId] && !env.snap.cand[e.candId].dropped)
      .map((e) => `- ${(names[e.memberId] || {}).name}さんの代理人 → [${e.candId}] ${SUPPORT_LABEL[evalScore(e)]}（${evalScore(e)}/5${e.basis === 'stated' ? '' : '・推測'}）: ${e.reason}`)
      .join('\n');
    const wants = (env.wantParts || []).map((w) => `- ${w.name}さんの代理人: [${w.candId}] の ${w.part} を取り入れたい（${w.why}）`).join('\n');
    const skills = skillText(env);
    const system = [
      'あなたは会議の中立な進行役です。特定のメンバーの味方はしません。あなたが知っているのは会議で公開された内容だけです。',
      '仕事は2つあります。(1) 出ている案を部品に分解して組み替えた「合体案」を作ること。(2) メンバーの案の組み替えではない「新しい案」を出すこと。',
      'ルール:',
      '- 各案を「誰向けか」「何を解決するか」「目玉機能」の3つに分解して考える。',
      '- 「A案のターゲットにB案の目玉機能を足す」のように部品を組み替えて、合体案を2〜3個作る。全員の要望を詰め込んだ「全部のせ」にはしない。1つの合体案は、1人のユーザーに1つの価値が伝わる形にする。',
      '- 各エージェントが好きと言った部分・取り入れたいと言った部品を優先して使う。「嫌」の理由になった部分は避ける。',
      '- 案が6個以上あるときは、内容がほぼ同じ案や、誰も推しておらず支持が低い案を drop に入れて、元の案を5個前後に絞る。落とした案の部品は合体案に使ってよい。',
      '- 案が2個以上あれば、合体案を最低1つは作る。',
      '- 新しい案（fresh）を1〜2個出す。メンバーの案の言い換えや足し算ではなく、発想の違う案にする。「お題と評価基準」に強く合い、各メンバーが大事にしている点と、メンバーができること・使える時間で作りきれる範囲に収める。why には、なぜこの案を足したかを書く。',
      '- 「お題と評価基準」が設定されていれば、合体案も新しい案も、それに合う方向に組み立てる。',
      '- statement は会議での発言。2〜3段落に分け、段落の間は空行（\\n\\n）にする。1段落目で合体案について、2段落目で新しい案について、それぞれ何をどう作ったかを1〜2文ずつ説明する。',
      '- 出力はJSONオブジェクトだけ。',
    ].join('\n');
    const user = [
      '【タスク:merge】合体案と新しい案を作ってください。',
      '',
      '【お題と評価基準】',
      topicText(env.snap),
      '',
      '【メンバーが実装でできること】',
      skills,
      '',
      '【会議に出ている案】',
      candText(cands, names),
      '',
      '【各エージェントの評価】',
      evalLines || '（なし）',
      '',
      '【取り入れたい部品の希望】',
      wants || '（なし）',
      '',
      '出力形式:',
      '{"statement":"","merged":[{"title":"","summary":"","target":"","problem":"","feature":"","from":["元になった案のid"],"why":""}],"fresh":[{"title":"","summary":"","target":"","problem":"","feature":"","why":""}],"drop":[{"candId":"","reason":""}]}',
    ].join('\n');
    const out = await askJson(ctx.llm, system, user, 8000, (text) => ctx.onLive && ctx.onLive({ speakerName: '進行役AI', text }));

    for (const d of Array.isArray(out.drop) ? out.drop : []) {
      const c = d && env.snap.cand[d.candId];
      if (!c || c.origin === 'merged') continue;
      const data = { ...c, dropped: true, dropReason: str(d.reason) || '進行役が絞り込みで外した' };
      await ctx.store.put('cand', d.candId, data);
      env.snap.cand[d.candId] = data;
    }
    let order = 1000;
    let n = 0;
    for (const m of (Array.isArray(out.merged) ? out.merged : []).slice(0, 3)) {
      if (!m || !str(m.title)) continue;
      const id = `mix${env.round}-${++n}`;
      const data = {
        title: str(m.title),
        summary: str(m.summary),
        target: { text: str(m.target), by: 'ai' },
        problem: { text: str(m.problem), by: 'ai' },
        feature: { text: str(m.feature), by: 'ai' },
        origin: 'merged',
        from: (Array.isArray(m.from) ? m.from : []).filter((f) => env.snap.cand[f]),
        why: str(m.why),
        order: order++,
        round: env.round,
      };
      await ctx.store.put('cand', id, data);
      env.snap.cand[id] = data;
    }
    n = 0;
    for (const m of (Array.isArray(out.fresh) ? out.fresh : []).slice(0, 2)) {
      if (!m || !str(m.title)) continue;
      const id = `new${env.round}-${++n}`;
      const data = {
        title: str(m.title),
        summary: str(m.summary),
        target: { text: str(m.target), by: 'ai' },
        problem: { text: str(m.problem), by: 'ai' },
        feature: { text: str(m.feature), by: 'ai' },
        origin: 'ai',
        why: str(m.why),
        order: order++,
        round: env.round,
      };
      await ctx.store.put('cand', id, data);
      env.snap.cand[id] = data;
    }
    await postMsg(ctx, env, { speaker: 'facilitator', speakerName: '進行役AI', type: 'merge', text: str(out.statement) || '合体案と新しい案を作りました。' });
  }

  // 進行役AIが、各案が技術的に作れるかを調べ、締切までに作れる範囲を説明する
  // （デスクトップ版でAPIキーがあるときは、Web検索で必要なAPIやライブラリを確かめる）
  async function facilitatorFeasibility(ctx, env) {
    const cands = activeCands(env.snap);
    const system = [
      'あなたは会議の中立な進行役で、経験のあるエンジニアとして各案の技術的な実現性を調べます。特定のメンバーの味方はしません。あなたが知っているのは公開された内容だけです。',
      'やること:',
      '- 各案について、目玉機能を作るのに必要な技術・API・ライブラリ・端末の機能を洗い出す。',
      '- Web検索が使えるときは、必要なAPIやライブラリが実在して今も使えるか、無料で使える範囲、既知の制限（対応していない環境、審査や申請が要る、など）を調べる。調べるのは判断に効く点だけに絞る。検索が使えないときは、自分の知識で判断する。',
      '- 「メンバーが実装でできること」と「締切・条件」に照らして、締切までに作れるかを判定する。',
      'ルール:',
      '- verdict は "ok"（締切までに目玉機能まで作れる）/ "partial"（範囲を絞れば作れる）/ "hard"（締切までには難しい）のどれか。',
      '- needs は、必要な技術や外部サービスを1〜2文で。',
      '- mvp は、締切までに作れる範囲を具体的に1〜2文で（何ができる状態になるか）。verdict が "hard" でも、見せられる最小の形があれば書く。',
      '- later は、後回しにするもの・今回は作らないものを1文で。無ければ空文字。',
      '- risk は、一番つまずきそうな点を1文で。',
      '- 確かめられなかったことを、確かめたように書かない。分からない点は risk に「未確認」と書く。',
      '- statement は会議での発言。2〜3段落で、段落の間は空行（\\n\\n）。全体としてどの案が作りやすく、どの案は範囲を絞る必要があるかを説明する。',
      '- 出力はJSONオブジェクトだけ。',
    ].join('\n');
    const user = [
      '【タスク:feas】各案の技術的な実現性を調べ、締切までに作れる範囲を説明してください。',
      '',
      '【お題と評価基準】',
      topicText(env.snap),
      '',
      '【メンバーが実装でできること】',
      skillText(env),
      '',
      '【会議に出ている案】',
      candText(cands, env.snap.member),
      '',
      '出力形式:',
      '{"statement":"","items":[{"candId":"","verdict":"partial","needs":"","mvp":"","later":"","risk":""}]}',
    ].join('\n');
    let out;
    try {
      out = await askJson(ctx.llm, system, user, 8000, (text) => ctx.onLive && ctx.onLive({ speakerName: '進行役AI', text }), { search: true });
    } catch (e) {
      if (!e.unreadable) throw e;
      await postMsg(ctx, env, { speaker: 'system', speakerName: 'システム', type: 'system', text: '実現性の検討は、応答を読み取れなかったため省きました' });
      return;
    }
    const sources = out.__sources || [];
    for (const x of Array.isArray(out.items) ? out.items : []) {
      const c = x && env.snap.cand[x.candId];
      if (!c || c.dropped) continue;
      const data = { ...c, feas: { verdict: FEAS_LABEL[x.verdict] ? x.verdict : 'partial', needs: str(x.needs), mvp: str(x.mvp), later: str(x.later), risk: str(x.risk), searched: sources.length > 0, sources } };
      await ctx.store.put('cand', x.candId, data);
      env.snap.cand[x.candId] = data;
    }
    await postMsg(ctx, env, { speaker: 'facilitator', speakerName: '進行役AI', type: 'feas', text: str(out.statement) || '各案の実現性を検討しました。' });
  }

  async function facilitatorExplain(ctx, env, rec) {
    const names = env.snap.member;
    const cands = activeCands(env.snap);
    const rows = rec.table
      .map((t) => `- [${t.candId}] ${t.title}: 合計${t.total}点（基準${t.crit === null ? 'なし' : t.crit}・支持${t.support}）${t.comment ? ' ' + t.comment : ''}${t.excluded ? `（対象外: ${t.excluded}）` : ''}`)
      .join('\n');
    const evalLines = Object.values(env.snap.eval)
      .filter((e) => env.snap.cand[e.candId] && !env.snap.cand[e.candId].dropped && env.participants.includes(e.memberId))
      .map((e) => `- ${(names[e.memberId] || {}).name}さんの代理人 → [${e.candId}] ${SUPPORT_LABEL[evalScore(e)]}（${evalScore(e)}/5${e.basis === 'stated' ? '' : '・推測'}）: ${e.reason}`)
      .join('\n');
    const system = [
      'あなたは会議の中立な進行役です。推薦する案は、すでに点数のルールで決まっています（100点満点。お題と評価基準への合い方が70点、メンバーの支持が30点。推測による支持は重み半分。本人が「嫌」と言った案と、元の案より点が低い合体案は対象外）。',
      'あなたの仕事は、その結果を人間のメンバーが納得できるように説明することです。結果そのものは変えないでください。',
      '- 案に「実現性」が書かれていれば、reason の中で、推薦案について締切までに作れる範囲にも一言触れる。',
      '- reason: なぜこの案が推薦なのかを2段落で。段落の間は空行（\\n\\n）にする。1段落目は結論と一番の決め手を1〜2文、2段落目は他の案と比べた理由を1〜2文。',
      '- influences: 誰のどの意見が結論に効いたかを、メンバーごとに1つずつ。発言そのものではなく要旨で。',
      '- conflict: 上位2案で意見が割れている場合だけ、対立点を1〜2文で整理（例: 実装の大変さが不安／面白さ重視）。割れていなければ空文字。',
      '- plan: 推薦案の実装の進め方。steps に締切までの進め方を2〜3文で、roles に各メンバーの担当案を「メンバーが実装でできること」に基づいて書く。共有されていないメンバーの担当は、決めつけず「未定（本人に確認）」とする。',
      '- 出力はJSONオブジェクトだけ。',
    ].join('\n');
    const user = [
      '【タスク:explain】推薦結果を説明してください。',
      `推薦案: [${rec.topId}]${rec.tie ? `／同点の次点: [${rec.runnerUpId}]（意見が割れています）` : rec.runnerUpId ? `／次点: [${rec.runnerUpId}]` : ''}`,
      '',
      '【お題と評価基準】',
      topicText(env.snap),
      '',
      '【メンバーが実装でできること】',
      skillText(env),
      '',
      '【点数】',
      rows,
      '',
      '【案の内容】',
      candText(cands, names),
      '',
      '【各エージェントの評価】',
      evalLines,
      '',
      '出力形式:',
      '{"reason":"","influences":[{"name":"","point":""}],"conflict":"","plan":{"steps":"","roles":[{"name":"","role":""}]}}',
    ].join('\n');
    let out;
    try {
      out = await askJson(ctx.llm, system, user, 8000, (text) => ctx.onLive && ctx.onLive({ speakerName: '進行役AI', text }));
    } catch (e) {
      if (!e.unreadable) throw e;
      out = { reason: '（理由の説明を作れませんでした。点数の内訳をご覧ください。）' };
    }
    const plan = out.plan && typeof out.plan === 'object' ? out.plan : {};
    return {
      plan: {
        steps: str(plan.steps),
        roles: (Array.isArray(plan.roles) ? plan.roles : []).map((r) => ({ name: str(r.name), role: str(r.role) })).filter((r) => r.name && r.role),
      },
      reason: str(out.reason),
      influences: (Array.isArray(out.influences) ? out.influences : []).map((i) => ({ name: str(i.name), point: str(i.point) })).filter((i) => i.name && i.point),
      conflict: str(out.conflict),
    };
  }

  // 会議を進める。mode: 'full'（最初から） / 'rerun'（新しい意見を受けて評価からやり直し）
  async function runMeeting(ctx0, opts) {
    let ctx = ctx0;
    const { store, me } = ctx;
    const notify = ctx.onProgress || (() => {});
    let env = null;
    const progress = async (text, stage, speaker) => {
      notify(text);
      if (env && env.state.runner) await setState(ctx, env, { progress: text, stage: stage || '', speaker: speaker || '' });
    };
    const snap = await snapshot(store);
    const st = snap.state.main || { phase: 'collecting', round: 0 };
    if (st.runner && st.runner !== me.id && now() - (st.runnerAt || 0) < LOCK_MS) {
      throw new Error(`${st.runnerName || '他のメンバー'}さんのアプリで会議が進行中です。少し待ってください。`);
    }
    const participants = Object.keys(snap.brief).filter((id) => snap.member[id]);
    if (participants.length < 2) throw new Error('考えを預けたメンバーが2人以上そろうと会議を始められます。');
    const full = (opts && opts.mode) === 'full' || !Object.keys(snap.cand).length || st.phase === 'collecting';

    env = { snap, state: st, round: (st.round || 0) + 1, participants, wantParts: [], owner: 'facilitator' };
    const baseLlm = ctx.llm;
    let callNo = 0;
    ctx = {
      ...ctx,
      llm: async (req) => {
        const t0 = now();
        const out = await baseLlm(req);
        try {
          const user = req.messages[0].content;
          const id = `c${String(env.round).padStart(2, '0')}-${String(++callNo).padStart(2, '0')}-${t0.toString(36)}`;
          const data = { round: env.round, no: callNo, at: t0, ms: now() - t0, task: (/【タスク:(\w+)】/.exec(user) || [])[1] || '', owner: env.owner, system: req.system, user, out };
          await store.put('call', id, data);
          snap.call[id] = data;
        } catch (e) {}
        return out;
      },
    };
    await setState(ctx, env, { runner: me.id, runnerName: me.name, phase: 'meeting', error: '' });
    // 同時に2人が始めた場合に備えて、少し待ってから自分が進行役になれたか確かめる
    await sleep(ctx.lockWait === undefined ? 1200 : ctx.lockWait);
    const check = (await snapshot(store)).state.main || {};
    if (check.runner !== me.id) throw new Error(`${check.runnerName || '他のメンバー'}さんのアプリが先に会議を始めました。`);

    try {
      const members = participants.map((id) => ({ id, name: snap.member[id].name || '?' }));
      const namesText = members.map((m) => m.name).join('・');

      if (full) {
        await progress('会議の準備をしています', 'round1', '');
        for (const kind of ['cand', 'eval', 'question', 'approval', 'skill', 'call']) {
          for (const id of Object.keys(snap[kind])) await store.del(kind, id);
          snap[kind] = {};
        }
        await setState(ctx, env, { round: env.round, recommendation: null, tieAsked: false, participants });
        await postMsg(ctx, env, { speaker: 'system', speakerName: 'システム', type: 'system', text: `会議を始めます（参加: ${namesText}さんの代理人）` });

        let order = 0;
        for (const m of members) {
          const ideas = snap.brief[m.id].ideas || [];
          for (let i = 0; i < ideas.length; i++) {
            const idea = ideas[i];
            const id = `${m.id.slice(-5)}-${i + 1}`;
            const data = {
              title: idea.title,
              summary: idea.summary,
              target: idea.target,
              problem: idea.problem,
              feature: idea.feature,
              origin: 'original',
              owners: [m.id],
              order: order++,
            };
            if (idea.push === 'drop') {
              data.dropped = true;
              data.dropReason = '提案した本人が「無しでいい」とした';
            }
            await store.put('cand', id, data);
            snap.cand[id] = data;
          }
        }
        if (!activeCands(snap).length) throw new Error('会議にかけられる案がありません。');

        for (const m of members) {
          await progress(`${m.name}さんの代理人が意見を述べています`, 'round1', `${m.name}さんの代理人`);
          env.owner = m.id;
          const out = await agentTurn(ctx, env, m, snap.brief[m.id], 'round1');
          env.owner = 'facilitator';
          await storeEvals(ctx, env, m, out);
          for (const w of Array.isArray(out.wantParts) ? out.wantParts : []) {
            if (w && snap.cand[w.candId]) env.wantParts.push({ name: m.name, candId: w.candId, part: str(w.part), why: str(w.why) });
          }
          if (str(out.canDo)) {
            const sk = { text: str(out.canDo), round: env.round };
            await store.put('skill', m.id, sk);
            snap.skill[m.id] = sk;
          }
          await postMsg(ctx, env, { speaker: m.id, speakerName: `${m.name}さんの代理人`, type: 'statement', text: str(out.statement) });
          await setState(ctx, env, {});
        }

        await progress('進行役AIが合体案と新しい案を作っています', 'merge', '進行役AI');
        await facilitatorMerge(ctx, env);
        await setState(ctx, env, {});

        await progress('進行役AIが、技術的に作れるかを調べています', 'feas', '進行役AI');
        await facilitatorFeasibility(ctx, env);
        await setState(ctx, env, {});
      } else {
        for (const id of Object.keys(snap.approval)) await store.del('approval', id);
        snap.approval = {};
        await setState(ctx, env, { round: env.round, participants });
        await postMsg(ctx, env, { speaker: 'system', speakerName: 'システム', type: 'system', text: '新しい意見が届いたので、議論をやり直します' });
      }

      const mode = full ? 'round2' : 'rerun';
      for (const m of members) {
        await progress(`${m.name}さんの代理人が${full ? '合体案と新案を評価' : '評価を見直'}しています`, 'round2', `${m.name}さんの代理人`);
        env.owner = m.id;
        const out = await agentTurn(ctx, env, m, snap.brief[m.id], mode);
        env.owner = 'facilitator';
        await storeEvals(ctx, env, m, out);
        await postMsg(ctx, env, { speaker: m.id, speakerName: `${m.name}さんの代理人`, type: 'statement', text: str(out.statement) });
        for (const q of (Array.isArray(out.questions) ? out.questions : []).slice(0, full ? 2 : 1)) {
          if (!q || !str(q.text)) continue;
          const qid = uid('q');
          const data = { memberId: m.id, candId: snap.cand[q.candId] ? q.candId : '', text: str(q.text), status: 'open', at: now(), round: env.round };
          await store.put('question', qid, data);
          snap.question[qid] = data;
        }
        await setState(ctx, env, {});
      }

      await progress('進行役AIが推薦案をまとめています', 'explain', '進行役AI');
      const criteria = parseCriteria(snap);
      let judge = {};
      if (criteria.length) {
        await progress('進行役AIが評価基準に沿って採点しています', 'explain', '進行役AI');
        judge = await facilitatorJudge(ctx, env, criteria);
        await progress('進行役AIが推薦案をまとめています', 'explain', '進行役AI');
      }
      const rec = recommend(activeCands(snap), snap.eval, participants, judge, criteria);

      // 上位の案に、代理人の推測で低い評価が付いているときは、本人に確かめる（推測のままでは案を落とさない）
      const upper = rec.table.filter((t) => !t.excluded).sort((x, y) => y.total - x.total).slice(0, 3);
      for (const m of members) {
        const hit = upper.find((t) => {
          const ev = snap.eval[`${m.id}__${t.candId}`];
          const asked = Object.values(snap.question).some((q) => q.memberId === m.id && q.candId === t.candId);
          return ev && ev.basis !== 'stated' && evalScore(ev) <= 2 && !asked;
        });
        if (!hit) continue;
        const ev = snap.eval[`${m.id}__${hit.candId}`];
        const qid = uid('q');
        const data = { memberId: m.id, candId: hit.candId, text: `代理人は、あなたが「${hit.title}」にあまり乗り気でないと推測しています${ev.reason ? `（理由：${ev.reason}）` : ''}。合っていますか？ 実際はどう思うか、一言で教えてください。`, status: 'open', at: now(), round: env.round, auto: true };
        await store.put('question', qid, data);
        snap.question[qid] = data;
      }
      const exp = await facilitatorExplain(ctx, env, rec);
      const recommendation = { ...rec, ...exp, at: now() };
      const top = snap.cand[rec.topId];
      const second = snap.cand[rec.runnerUpId];

      // 意見が割れたら、残った2案について全員にもう一度だけ聞く
      let tieAsked = env.state.tieAsked || false;
      if (rec.tie && top && second && !tieAsked) {
        tieAsked = true;
        for (const m of members) {
          const qid = uid('q');
          const data = {
            memberId: m.id,
            candId: rec.topId,
            text: `最終候補が「${top.title}」と「${second.title}」の2つに絞られました。${exp.conflict ? '対立点は「' + exp.conflict + '」です。' : ''}どちらがいいですか？理由も一言あれば教えてください。`,
            status: 'open',
            at: now(),
            round: env.round,
            tie: true,
          };
          await store.put('question', qid, data);
          snap.question[qid] = data;
        }
      }

      await postMsg(ctx, env, {
        speaker: 'facilitator',
        speakerName: '進行役AI',
        type: 'recommend',
        text: `推薦は「${top ? top.title : '?'}」です。${exp.reason}${rec.tie && second ? `（「${second.title}」と評価が並んでいます）` : ''}`,
      });
      await setState(ctx, env, { phase: 'review', recommendation, tieAsked, runner: null, runnerName: '', lastRunAt: now(), progress: '', stage: '', speaker: '' });
      notify('');
      return recommendation;
    } catch (e) {
      try {
        await setState(ctx, env, { runner: null, runnerName: '', phase: Object.keys(env.snap.cand).length && env.state.recommendation ? 'review' : 'collecting', error: e.message, progress: '', stage: '', speaker: '' });
      } catch {}
      notify('');
      throw e;
    }
  }

  // 本人が自分のエージェントに追加で伝える（確認質問への答え・一言コメント・「やっぱりこう思う」）
  async function addUpdate(ctx, text, q) {
    const snap = await snapshot(ctx.store);
    const brief = snap.brief[ctx.me.id];
    if (!brief) throw new Error('まだ考えを預けていません。');
    const updates = (brief.updates || []).concat([{ at: now(), text: str(text), q: q || '' }]);
    await ctx.store.put('brief', ctx.me.id, { ...brief, updates });
  }

  async function answerQuestion(ctx, qid, text) {
    const snap = await snapshot(ctx.store);
    const q = snap.question[qid];
    if (!q || q.memberId !== ctx.me.id) throw new Error('この質問には答えられません。');
    await addUpdate(ctx, text, q.text);
    await ctx.store.put('question', qid, { ...q, status: 'answered', answeredAt: now() });
    const after = await snapshot(ctx.store);
    return Object.values(after.question).filter((x) => x.memberId === ctx.me.id && x.status === 'open').length;
  }

  // 承認。全員が今の回の推薦を承認したら決定になる
  async function approve(ctx) {
    const snap = await snapshot(ctx.store);
    const st = snap.state.main;
    if (!st || st.phase !== 'review' || !st.recommendation) throw new Error('いまは承認できる推薦案がありません。');
    await ctx.store.put('approval', ctx.me.id, { round: st.round, ok: true, at: now(), candId: st.recommendation.topId });
    const after = await snapshot(ctx.store);
    const st2 = after.state.main || st;
    const parts = st2.participants || [];
    const all = parts.length > 0 && parts.every((id) => after.approval[id] && after.approval[id].ok && after.approval[id].round === st2.round);
    if (all && st2.phase === 'review' && !st2.runner) {
      const cand = after.cand[st2.recommendation.topId];
      await ctx.store.put('state', 'main', { ...st2, phase: 'decided', decidedAt: now(), decidedCandId: st2.recommendation.topId });
      await ctx.store.put('msg', uid('g'), {
        round: st2.round,
        at: now(),
        speaker: 'system',
        speakerName: 'システム',
        type: 'system',
        text: `全員が承認しました。「${cand ? cand.title : ''}」に決定です。`,
      });
      return true;
    }
    return false;
  }

  function publicContext(snap) {
    const cands = activeCands(snap);
    if (!cands.length) return '';
    const st = snap.state.main || {};
    const rec = st.recommendation;
    const lines = [candText(cands, snap.member)];
    if (rec && snap.cand[rec.topId]) lines.push(`現在の推薦: 「${snap.cand[rec.topId].title}」 理由: ${rec.reason}`);
    if (st.phase === 'decided') lines.push('この案で決定済みです。');
    return lines.join('\n');
  }

  return {
    LOCK_MS,
    RATIO,
    FEAS_LABEL,
    SUPPORT_LABEL,
    evalScore,
    parseCriteria,
    MAX_MUST,
    INTERVIEW_ITEMS,
    splitCovered,
    parseJson,
    paragraphs,
    snapshot,
    sortedMsgs,
    activeCands,
    partText,
    interviewSystem,
    interviewContext,
    topicText,
    hasTopic,
    extractBrief,
    normalizeBrief,
    recommend,
    runMeeting,
    addUpdate,
    answerQuestion,
    approve,
    publicContext,
  };
});
