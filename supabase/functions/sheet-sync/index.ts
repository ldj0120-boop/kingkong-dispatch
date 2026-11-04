// Supabase Edge Function 'sheet-sync' — 구글시트(Apps Script)가 1시간마다 보낸 줄을 통합 대장에 반영
// 대시보드 › Edge Functions › Deploy a new function › Via Editor › 이름 sheet-sync › 붙여넣기 › Deploy
// Secrets: SHEET_SECRET (Apps Script 의 SECRET 과 같은 값)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  if (req.headers.get("x-kk-secret") !== Deno.env.get("SHEET_SECRET")) return new Response("forbidden", { status: 403 });
  const { source, rows } = await req.json();
  if (!source || !Array.isArray(rows)) return new Response("bad request", { status: 400 });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let total = { inserted: 0, updated: 0, skipped: 0 };
  for (let i = 0; i < rows.length; i += 300) {   // 300줄씩
    const { data, error } = await sb.rpc("sheet_upsert", { p_source: source, p_rows: rows.slice(i, i + 300) });
    if (error) return new Response(JSON.stringify({ error: error.message, at: i }), { status: 500 });
    total = { inserted: total.inserted + data.inserted, updated: total.updated + data.updated, skipped: total.skipped + data.skipped };
  }
  return new Response(JSON.stringify(total), { headers: { "Content-Type": "application/json" } });
});
