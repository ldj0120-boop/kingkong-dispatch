// 킹콩 배차 — 휴대폰 알림 받기(웹 푸시) + b94: 버전이 붙은 파일(app.js?b=N · CDN 라이브러리 · 글꼴)은 기기에 저장해 두고 바로 씀(첫 화면 빨라짐). 화면(index.html)은 항상 서버에서 최신
const KK_C = "kk-static-v1";
const immutable = u => (u.origin === self.location.origin && /\.(js|css|png|webmanifest)$/.test(u.pathname) && /[?&]b=\d+/.test(u.search) && !/sw\.js$/.test(u.pathname))
  || (u.hostname === "cdn.jsdelivr.net" && /@\d/.test(u.pathname)) || u.hostname === "fonts.gstatic.com";
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return; let u; try { u = new URL(e.request.url); } catch (_) { return; } if (!immutable(u)) return;
  e.respondWith((async () => { const c = await caches.open(KK_C), hit = await c.match(e.request); if (hit) return hit;
    const r = await fetch(e.request); if (r && (r.ok || r.type === "opaque")) { try { await c.put(e.request, r.clone());
      if (u.origin === self.location.origin) for (const k of await c.keys()) { const ku = new URL(k.url); if (ku.pathname === u.pathname && ku.search !== u.search) await c.delete(k); } } catch (_) {} }   // 같은 파일의 예전 버전은 지움
    return r; })());
});
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: "킹콩 배차", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "킹콩 배차", { body: d.body || "", icon: "icon-192.png", badge: "icon-192.png", tag: "kk-" + Date.now(), renotify: true, vibrate: [200, 100, 200] }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil((async () => {
    const L = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of L) { if ("focus" in c) { c.postMessage({ kk: "refresh" }); return c.focus(); } }
    return self.clients.openWindow("./?app=1");
  })());
});
