// 오프라인에서도 열리도록 앱 파일을 캐시하고, 푸시 알림을 띄운다.
// VERSION은 배포할 때 GitHub Actions가 자동으로 바꿔 준다.
const VERSION = "calendar-v4";
const ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./firebase-config.js", "./notify-config.js", "./holidays.js", "./img/phase-rage.jpg", "./img/phase-blue.jpg", "./img/phase-small.jpg", "./img/phase-calm.jpg",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"];
// 글꼴은 버전이 바뀌어도 지우지 않는 별도 보관함에 저장 (한 번 받으면 다음부터 바로 꺼내 씀)
const FONT_CACHE = "fonts-v1";
const FONTS = [
  "https://cdn.jsdelivr.net/gh/Project-Noonnu/2610081905@hippie/hippie/hippie_%ED%9E%88%ED%94%BC%EC%B2%B4.woff2",
  "https://cdn.jsdelivr.net/gh/projectnoonnu/2408-4@1.0/RixXladywatermelonR.woff2"
];

self.addEventListener("install", e => {
  e.waitUntil(Promise.all([
    caches.open(VERSION).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: "reload" })))), // 브라우저 임시 보관 말고 서버의 최신 파일
    // 글꼴 미리 저장 (실패해도 설치는 계속)
    caches.open(FONT_CACHE).then(c => Promise.all(FONTS.map(u => c.match(u).then(hit => hit || c.add(new Request(u, { mode: "cors" })))))).catch(() => {})
  ]).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== FONT_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// 앱 파일: 저장해 둔 것을 바로 꺼내 줌 (흰 화면 없이 즉시 열림) + 뒤에서 서버의 새 파일로 바꿔 둠
// 새로 배포하면 sw.js 가 바뀌어 새 서비스워커가 깔리고, 앱을 막 연 참이면 바로 새로 불러옴
// 저장된 게 없을 때(처음 열 때)만 네트워크를 기다림. cache:"no-cache" = 브라우저의 10분 임시 보관을 건너뜀
self.addEventListener("fetch", e => {
  const req = e.request;
  // 글꼴: 저장된 게 있으면 바로, 없으면 받아서 저장
  if (req.method === "GET" && FONTS.includes(req.url)) {
    e.respondWith(caches.open(FONT_CACHE).then(c => c.match(req.url).then(hit => hit || fetch(req).then(res => {
      if (res.ok) c.put(req.url, res.clone());
      return res;
    }))));
    return;
  }
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  const fresh = fetch(req, { cache: "no-cache" }).then(res => {
    if (res.ok) { const copy = res.clone(); e.waitUntil(caches.open(VERSION).then(c => c.put(req, copy))); }
    return res;
  });
  const saved = caches.match(req, { ignoreSearch: true }).then(r => r || (req.mode === "navigate" ? caches.match("./index.html") : undefined));
  e.respondWith(saved.then(r => r || fresh).catch(() => saved));
  e.waitUntil(fresh.catch(() => {}));
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
