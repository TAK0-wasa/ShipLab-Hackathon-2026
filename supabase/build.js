// 関数「meeting」に入れる engine.js の写しを作る（src/engine.js と同じ中身）。実行: node supabase/build.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
fs.copyFileSync(path.join(root, 'src', 'engine.js'), path.join(root, 'supabase', 'functions', 'meeting', 'engine.js'));
console.log('supabase/functions/meeting/engine.js を作りました');
