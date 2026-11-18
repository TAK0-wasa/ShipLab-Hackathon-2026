// Web版（web/index.html）を作る。実行: node web/build.js
// デスクトップ版と同じ画面（src/index.html・src/app.js）と会議の処理（src/engine.js）を、1つのHTMLにまとめる。
// 違うのは土台だけ: main.js / preload.js の代わりに web/web-api.js を使う。web/index.html は直接書き換えず、元のファイルを直してからこれを実行する
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const version = JSON.parse(read('package.json')).version;

// Web版はスマホでも開くので、「このPC」という言い方を「この端末」に替える
const wording = (s) => s.replace(/このPC/g, 'この端末').replace(/別々のPC/g, '別々の端末').replace(/別のPC/g, '別の端末').replace(/同じPC/g, '同じ端末');
const sample = `(function () { var module = { exports: {} };\n${read('sample-ai.js')}\nwindow.sampleAi = module.exports; })();`;
const api = read('web/web-api.js').replace('__APP_VERSION__', version);
const head = `// MeetForMe Web版 v${version}（node web/build.js で作成。直接は書き換えない）\n`;
fs.writeFileSync(path.join(__dirname, 'app.js'), head + [sample, api, read('src/engine.js'), wording(read('src/app.js'))].join('\n;\n'), 'utf8');

let html = read('src/index.html');
const tags = '<script src="engine.js"></script>\n<script src="app.js"></script>';
if (!html.includes(tags)) throw new Error('src/index.html の script タグの形が変わっています');
html = wording(html).replace(tags, () => `<script src="app.js?v=${version}"></script>`);
// 通信先: 会議の保存先とAIのサーバー（Supabase）。自分のSupabaseも使えるように https 全般を許す。スクリプトはこのサイトのファイルだけ
const csp = /<meta http-equiv="Content-Security-Policy"[^>]*>/;
if (!csp.test(html)) throw new Error('src/index.html に Content-Security-Policy がありません');
html = html.replace(csp, `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src https:; base-uri 'none'; form-action 'none'">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="robots" content="noindex">`);
html = html.replace('<head>', `<head>\n<!-- MeetForMe Web版 v${version}（node web/build.js で作成。直接は書き換えない） -->`);
fs.writeFileSync(path.join(__dirname, 'index.html'), html, 'utf8');
console.log(`web/index.html と web/app.js を作りました（v${version}）`);
