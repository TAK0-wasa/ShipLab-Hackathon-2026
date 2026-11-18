// MeetForMe: 会議をサーバー側で進める Supabase Edge Function（任意の追加機能）
// これを入れると、幹事やメンバーの画面が開いていなくても、会議と「預ける締切」での自動開始が進む。
// 入れなくても、アプリはこれまでどおり画面側で会議を進める（自動で見分ける）。
//
// 設定:
//  1. Edge Functions で「meeting」という名前で作成し、「Verify JWT」を切る。
//  2. このフォルダの3つのファイル（index.ts・core.mjs・engine.js）を入れる。
//     engine.js は src/engine.js と同じもの（node supabase/build.js で写しを作る）。
//  3. Secrets の ANTHROPIC_API_KEY は「claude」と共通。SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY は最初から入っている。
//  4. 締切での自動開始を、だれの画面も開いていないときにも進めたい場合は、supabase_cron.sql を実行する（1分ごとの見回り）。
// 注意: この関数は、本物の Supabase 上ではまだ通し確認をしていない（中身 core.mjs は Node のテストで確認済み）。
import "./engine.js";
import { createMeetingServer } from "./core.mjs";

// deno-lint-ignore no-explicit-any
const g = globalThis as any;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-room",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: { message: "POST で呼んでください" } }), { status: 405, headers: { ...cors, "content-type": "application/json" } });
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // 空の本文は ping 扱いにしない（下で 403 になる）
  }
  const self = req.url;
  const handle = createMeetingServer({
    Engine: g.Engine,
    fetch,
    env: {
      SUPABASE_URL: Deno.env.get("SUPABASE_URL") ?? "",
      SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      ANTHROPIC_API_KEY: Deno.env.get("ANTHROPIC_API_KEY") ?? "",
    },
    // 1回の実行に使える時間（無料枠は約150秒）より短くして、余裕を持って区切る
    budgetMs: 100000,
  });
  const out = await handle({
    body,
    headers: { apikey: req.headers.get("apikey") ?? "", authorization: req.headers.get("authorization") ?? "" },
    // 応答を返したあとも会議を進める
    background: (p: Promise<unknown>) => (g.EdgeRuntime && g.EdgeRuntime.waitUntil ? g.EdgeRuntime.waitUntil(p) : p.catch(() => {})),
    // 時間で区切ったら、自分自身をもう一度呼んで続きから進める
    chain: (again: { body: unknown; headers: Record<string, string> }) =>
      fetch(self, { method: "POST", headers: { "content-type": "application/json", ...again.headers }, body: JSON.stringify(again.body) }).then((r) => r.body?.cancel()),
  });
  return new Response(JSON.stringify(out.body), { status: out.status, headers: { ...cors, "content-type": "application/json" } });
});
