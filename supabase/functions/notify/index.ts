// Supabase Edge Function 'notify' — 등록된 휴대폰(웹 푸시)으로 알림을 보낸다
// b124: 따로 넣을 Secrets 없음 — 알림 키(VAPID)와 DB↔함수 암호는 app_config(RLS: 아무도 못 읽음)에 두고 service role 로만 읽음
//        VAPID 키가 없으면 처음 불릴 때 함수가 만들어 저장(공개키는 앱이 push_vapid_pub() 로 받아 다시 등록)
//        배포: 대시보드 › Edge Functions › notify (Verify JWT 끔 — x-kk-secret 으로 확인)
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || (() => { try { const o = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); return o.default || Object.values(o)[0]; } catch (_) { return ""; } })();
const sb = createClient(Deno.env.get("SUPABASE_URL")!, svc as string);
async function cfg() {
  const { data } = await sb.from("app_config").select("key, value").in("key", ["notify_secret", "vapid_pub", "vapid_priv"]);
  const m: Record<string, string> = {}; (data || []).forEach((r: { key: string; value: string }) => m[r.key] = r.value);
  if (!m.vapid_pub || !m.vapid_priv) {
    const k = webpush.generateVAPIDKeys();
    await sb.from("app_config").upsert([{ key: "vapid_pub", value: k.publicKey }, { key: "vapid_priv", value: k.privateKey }], { onConflict: "key" });
    m.vapid_pub = k.publicKey; m.vapid_priv = k.privateKey;
  }
  return m;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const m = await cfg();
  if (!m.notify_secret || req.headers.get("x-kk-secret") !== m.notify_secret) return new Response("forbidden", { status: 403 });
  const { to = [], title = "킹콩 배차", body = "", url = "" } = await req.json();
  webpush.setVapidDetails("mailto:noreply@kingkong.local", m.vapid_pub, m.vapid_priv);
  const { data: subs, error } = await sb.from("push_subs").select("id, who, sub");
  if (error) return new Response(error.message, { status: 500 });
  // 받는 쪽 고르기: 'vendor:더한물류' 정확히 · 'vendor:*' 업체 전부 · 'store:이천점' · 'staff' = 관리자(이메일로 등록된 기기)
  const hit = (who: string) => (to as string[]).some((t) =>
    t === "staff" ? !who.includes(":") : t.endsWith(":*") ? who.startsWith(t.slice(0, -1)) : who === t);
  const targets = (subs || []).filter((s) => hit(s.who));
  const payload = JSON.stringify({ title, body, url });
  let sent = 0; const fail: number[] = [];
  await Promise.all(targets.map(async (s) => {
    try { await webpush.sendNotification(s.sub, payload, { TTL: 3600, urgency: "high" }); sent++; }
    catch (e) { const code = (e as { statusCode?: number }).statusCode || 0; fail.push(code);
      if (code === 404 || code === 410 || code === 403) await sb.from("push_subs").delete().eq("id", s.id); }   // 지워진 기기 · 예전 키로 등록된 기기는 정리(앱을 열면 새 키로 다시 등록)
  }));
  return new Response(JSON.stringify({ targets: targets.length, sent, fail }), { headers: { "Content-Type": "application/json" } });
});
