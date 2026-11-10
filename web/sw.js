// 오프라인에서도 열리도록 앱 파일을 캐시하고, 푸시 알림을 띄운다.
// VERSION은 배포할 때 GitHub Actions가 자동으로 바꿔 준다.
const VERSION = "calendar-v4";
const ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./firebase-config.js", "./notify-config.js",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// 네트워크 우선, 실패하면 캐시
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("./index.html")))
  );
});

// 푸시 알림 받기
self.addEventListener("push", e => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(msg.title || "캘린더", {
    body: msg.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: msg.tab || "me",          // 같은 종류 알림은 하나로 합침
    data: { tab: msg.tab === "partner" ? "partner" : "me" }
  }));
});

// 알림을 누르면 앱을 열고 해당 탭으로
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const tab = (e.notification.data && e.notification.data.tab) || "me";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if ("focus" in c) { c.postMessage({ tab }); return c.focus(); }
    }
    return self.clients.openWindow(new URL(`./?tab=${tab}`, self.registration.scope).href);
  }));
});
