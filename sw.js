// 킹콩 배차 — 휴대폰 알림 받기(웹 푸시). 화면 파일은 저장하지 않음(항상 최신)
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
