// テスト用の見本: メモリ上の保存先と、決まった応答を返すAI（engine.test.js と server.test.js で共用）
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

module.exports = { memStore, mockLlm, calls };
