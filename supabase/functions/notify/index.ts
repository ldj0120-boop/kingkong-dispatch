// Supabase Edge Function 'notify' — 등록된 휴대폰(웹 푸시)으로 알림을 보낸다
// 대시보드 › Edge Functions › Deploy a new function › Via Editor › 이름 notify › 이 파일 내용을 붙여넣고 Deploy
// 필요한 Secrets(Edge Functions › Secrets): VAPID_PUBLIC, VAPID_PRIVATE, KK_SECRET   (SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY 는 자동)
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  if (req.headers.get("x-kk-secret") !== Deno.env.get("KK_SECRET")) return new Response("forbidden", { status: 403 });
  const { to = [], title = "킹콩 배차", body = "", url = "" } = await req.json();
  webpush.setVapidDetails("mailto:ldj0120@kinggo.ai", Deno.env.get("VAPID_PUBLIC")!, Deno.env.get("VAPID_PRIVATE")!);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: subs, error } = await sb.from("push_subs").select("id, who, sub");
  if (error) return new Response(error.message, { status: 500 });
  // 받는 쪽 고르기: 'vendor:더한물류' 정확히 · 'vendor:*' 업체 전부 · 'store:이천점' · 'staff' = 관리자(이메일로 등록된 기기)
  const hit = (who: string) => (to as string[]).some((t) =>
    t === "staff" ? !who.includes(":") : t.endsWith(":*") ? who.startsWith(t.slice(0, -1)) : who === t);
  const targets = (subs || []).filter((s) => hit(s.who));
  const payload = JSON.stringify({ title, body, url });
  let sent = 0;
  await Promise.all(targets.map(async (s) => {
    try { await webpush.sendNotification(s.sub, payload, { TTL: 3600, urgency: "high" }); sent++; }
    catch (e) { const code = (e as { statusCode?: number }).statusCode; if (code === 404 || code === 410) await sb.from("push_subs").delete().eq("id", s.id); }   // 지워진 기기는 정리
  }));
  return new Response(JSON.stringify({ targets: targets.length, sent }), { headers: { "Content-Type": "application/json" } });
});
