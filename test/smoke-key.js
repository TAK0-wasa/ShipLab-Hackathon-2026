// 同梱のAPIキー（api-key.local.json）の確認: 入力なしでキーありになる／設定ファイルには写らない／自分のキーを入れるとそちらが優先
// 実行: npx electron test/smoke-key.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-key-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'user'));
const keyFile = path.join(tmp, 'api-key.local.json');
process.env.KAWARINI_KEY_FILE = keyFile;
fs.writeFileSync(keyFile, JSON.stringify({ apiKey: 'sk-ant-test-bundled-000' }));
require('../main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  await sleep(1500);
  const wc = BrowserWindow.getAllWindows()[0].webContents;
  const js = (code) => wc.executeJavaScript(code);
  const must = (ok, msg) => { if (!ok) throw new Error(msg); };
  try {
    let c = await js(`window.api.getConfig()`);
    must(c.hasApiKey && c.keyBundled, '同梱のキーが使われていない');
    must(!JSON.stringify(c).includes('sk-ant-test'), '画面側にキーが渡っている');
    c = await js(`window.api.saveConfig({ name: 'てすと' })`);
    must(c.hasApiKey && c.keyBundled, '保存のあとに同梱のキーが外れた');
    const saved = fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8');
    must(!saved.includes('sk-ant') && !saved.includes('apiKeyEnc'), '同梱のキーが設定ファイルに写っている: ' + saved.slice(0, 200));
    c = await js(`window.api.saveConfig({ apiKey: 'sk-ant-test-own-111' })`);
    must(c.hasApiKey && !c.keyBundled, '自分のキーが優先されていない');
    fs.writeFileSync(keyFile, JSON.stringify({ apiKey: '' }));
    c = await js(`window.api.saveConfig({ apiKey: '' })`);
    must(c.hasApiKey && !c.keyBundled, '自分のキーが消えた');
    console.log('KEY SMOKE OK');
    app.exit(0);
  } catch (e) {
    console.log('KEY SMOKE FAILED: ' + e.message);
    app.exit(1);
  }
});
