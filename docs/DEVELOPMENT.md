# 開発者向けガイド

[← README に戻る](../README.md)

セットアップ、テスト、インストーラーの作成、Web版の公開、自分の Supabase での動かし方、リポジトリの構成をまとめたものです。

## 動かす・テスト・公開

### 動かす

```
npm install
npm start          （または start.bat）
```

同じPCで別の人として開くには、`start.bat --profile=b` のように起動します。

### テスト

```
npm test                                  会議と採点のテスト
npx electron test/smoke-start.js          作る → 預ける → 会議 → 推薦（見本モード）
npx electron test/smoke-deadline.js       預ける締切での自動開始
npx electron test/smoke-web.js            Web版
node test/smoke-two-pc.js                 2台から同じ会議に入る
```

### インストーラーを作る

```
npm run dist       （dist フォルダにできます）
```

### Web版を作り直して公開する

`web/index.html` と `web/app.js` は、`src/` から作られます（直接は書き換えません）。

```
node web/build.js
cd web
npx vercel --prod
```

### 自分の Supabase で動かす

1. SQL Editor で `supabase_setup.sql` を実行します（表、行ごとの制限、回数の上限が入ります）。
2. Edge Functions に `claude` という名前の関数を作り、`supabase/functions/claude/index.ts` の中身を貼り付けて公開します。「Verify JWT」は切ります。
3. Edge Functions の Secrets に、`ANTHROPIC_API_KEY` という名前でClaudeのAPIキーを登録します。
4. アプリの「会議を作る」→「接続先を変える」にURLとキーを入れます（招待コードは `AIDK1.` で始まる長い形式になります）。フォルダに `shared-db.local.json`（`{"url":"…","key":"…"}`）を置くと、その接続先が既定になります。

利用分はすべて、登録したキーの持ち主に請求されます。キーには利用上限を設定しておくのが安全です。

## 会議をサーバーで進める（任意）

Web版は、Supabase に関数「meeting」が入っていると自動で見分けて、会議をサーバーに任せます。画面は「進めてください」と合図を送るだけなので、預けたあとにページを閉じても会議は進みます。入っていなければ、これまでどおり画面側で進めます（合図から90秒たっても始まらないときも、幹事の画面が引き取ります）。

1. `node supabase/build.js` を実行します（`supabase/functions/meeting/engine.js` に `src/engine.js` の写しができます）。
2. Supabase の Edge Functions で「meeting」を作り、`supabase/functions/meeting/` の3つのファイル（`index.ts`・`core.mjs`・`engine.js`）を入れます。「Verify JWT」は切ります。
3. Secrets の `ANTHROPIC_API_KEY` は「claude」と共通です。
4. だれの画面も開いていないときにも「預ける締切」で始めたい場合は、`supabase_cron.sql` の2か所を書き換えて実行します（1分ごとの見回り）。service_role の鍵を書いたファイルは、コミットしないでください。

1回の実行時間には上限があるので、関数は約100秒ごとに区切り、自分を呼び直して続きから進めます（済んだ段階はやり直しません）。デスクトップ版は、これまでどおり画面側で進めます。

## ファイル

- `src/engine.js` … 会議の進行、採点のルール、AIへの指示文（Web版・デスクトップ版で共通）
- `src/app.js` / `src/index.html` … 画面（共通）
- `main.js` / `preload.js` … デスクトップ版の土台（設定の保存、保存先とAIへの通信）
- `web/web-api.js` … Web版の土台（同じ仕事をブラウザの中で行う）
- `web/build.js` … Web版を作るスクリプト。`web/index.html` と `web/app.js` が出力です
- `sample-ai.js` … 見本モードの応答
- `supabase_setup.sql` / `supabase/functions/claude/index.ts` … 保存先とAIの中継の設定
- `supabase/functions/meeting/` / `supabase/build.js` / `supabase_cron.sql` … 会議をサーバーで進めるための関数（任意）
- `test/` … 自動テスト
- `PRIVACY.md` / `TERMS.md` … データの扱いと利用上の注意（下書き）
