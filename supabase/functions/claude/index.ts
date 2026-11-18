// かわりに会議: AIをサーバー経由で呼ぶための Supabase Edge Function
// ClaudeのAPIキーはこのサーバーだけが持ち（Secrets の ANTHROPIC_API_KEY）、アプリには渡らない。
// 設定: Edge Functions で「claude」という名前で作成し、「Verify JWT」を切る。Secrets に ANTHROPIC_API_KEY を登録する。
// 使いすぎ防止のため、先に supabase_setup.sql（relay_take）を実行しておく。
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "content-type": "application/json" } });
const fail = (status: number, message: string) => json({ error: { message } }, status);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail(405, "POST で呼んでください");
  const key = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail(400, "リクエストの形が違います");
  }
  // アプリが「サーバー経由で使えるか」を確かめるための呼び出し
  if (body.ping) return json({ ok: true, ready: !!key });
  if (!key) return fail(500, "サーバーにClaudeのAPIキーが登録されていません（Secrets の ANTHROPIC_API_KEY）");

  // 実在する会議からの呼び出しだけを通す（招待コードを持っている人だけが使える）
  const room = String(body.room ?? "");
  const apikey = req.headers.get("apikey") ?? "";
  const base = Deno.env.get("SUPABASE_URL") ?? "";
  if (!room || !apikey || !base) return fail(403, "会議が指定されていません");
  try {
    const r = await fetch(`${base}/rest/v1/docs?select=id&room=eq.${encodeURIComponent(room)}&kind=eq.room&limit=1`, {
      headers: { apikey, authorization: `Bearer ${apikey}`, "x-room": room },
    });
    const rows = r.ok ? await r.json() : [];
    if (!Array.isArray(rows) || rows.length === 0) return fail(403, "この会議は見つかりません");
  } catch {
    return fail(403, "会議を確認できませんでした");
  }
  // 使いすぎ防止: 会議ごと・全体で1日に呼べる回数を数える（supabase_setup.sql の relay_take）
  try {
    const r = await fetch(`${base}/rest/v1/rpc/relay_take`, {
      method: "POST",
      headers: { apikey, authorization: `Bearer ${apikey}`, "content-type": "application/json" },
      body: JSON.stringify({ p_room: room }),
    });
    const allowed = r.ok ? await r.json() : null;
    if (allowed !== true) {
      return fail(429, r.ok ? "今日のAIの利用回数の上限に達しました（会議ごと1日200回・全体1日1000回）" : "利用回数を確認できませんでした（supabase_setup.sql を実行してください）");
    }
  } catch {
    return fail(503, "利用回数を確認できませんでした");
  }

  // 使えるモデルを限る（高いモデルを勝手に使わせない）
  const MODELS = ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"];
  const model = MODELS.includes(String(body.model)) ? String(body.model) : "claude-sonnet-5-5";
  const out: Record<string, unknown> = {
    model,
    max_tokens: Math.min(Math.max(Number(body.max_tokens) || 2000, 1), 16000),
    system: typeof body.system === "string" ? body.system : "",
    messages: Array.isArray(body.messages) ? body.messages : [],
  };
  // 使わせる道具は Web 検索だけ
  if (Array.isArray(body.tools)) {
    const tools = body.tools.filter((t) => t && typeof t === "object" && String((t as { type?: string }).type ?? "").startsWith("web_search"));
    if (tools.length) out.tools = tools;
  }
  const res = await fetch(Deno.env.get("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(out),
  });
  return new Response(await res.text(), { status: res.status, headers: { ...cors, "content-type": "application/json" } });
});
