// 自分のAPIキー（上級者向けの設定）の確認: 保存しても画面側や設定ファイルに生のキーが出ない／空欄の保存では消えない／消す指定で消える
// 実行: npx electron test/smoke-key.js
const { app, BrowserWindow, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-key-'));
app.setPath('appData', tmp);
process.env.KAWARINI_DB = process.env.KAWARINI_DB || 'none'; // アプリに入っている接続先は使わない
require('../main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  await sleep(1500);
  const wc = BrowserWindow.getAllWindows()[0].webContents;
  const js = (code) => wc.executeJavaScript(code);
  const must = (ok, msg) => { if (!ok) throw new Error(msg); };
  const saved = () => fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8');
  try {
    let c = await js(`window.api.getConfig()`);
    must(!c.hasApiKey, '最初からキーありになっている');
    // 起動直後の画面（参加・作成の入口）に、APIキーの文言が無いこと
    must(!(await js(`document.querySelector('#view').innerText`)).includes('APIキー'), 'はじめの画面にAPIキーの文言が出ている');
    c = await js(`window.api.saveConfig({ name: 'てすと', apiKey: 'sk-ant-test-own-111' })`);
    must(c.hasApiKey, '自分のキーが保存されない');
    must(!JSON.stringify(c).includes('sk-ant-test'), '画面側にキーが渡っている');
    if (safeStorage.isEncryptionAvailable()) must(!saved().includes('sk-ant-test'), '設定ファイルに生のキーが書かれている');
    c = await js(`window.api.saveConfig({ name: 'てすと2', apiKey: '' })`);
    must(c.hasApiKey, '空欄で保存したらキーが消えた');
    c = await js(`window.api.saveConfig({ clearApiKey: true })`);
    must(!c.hasApiKey, '消す指定でキーが消えない');
    must(!saved().includes('clearApiKey'), '消す指定が設定ファイルに残っている');
    console.log('KEY SMOKE OK');
    app.exit(0);
  } catch (e) {
    console.log('KEY SMOKE FAILED: ' + e.message);
    app.exit(1);
  }
});
