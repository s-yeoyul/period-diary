// 알림 서버 설정. 비워 두면(null) 알림 기능이 화면에 나오지 않아요.
// workerUrl: Cloudflare Worker 주소 / vapidPublicKey: VAPID 공개키 (공개돼도 괜찮은 값)
// window.NOTIFY_CONFIG = null;
window.NOTIFY_CONFIG = {
  workerUrl: "https://cal-push.springyy1011.workers.dev",
  vapidPublicKey: "BCPyh_Wbs0lKlquPf98BzmYWYDwl6K56174WRa8D5MdNoHLucGh7vL2bSAUeWll5whEx7SCc3ydI1flnAgxeJWA"
};
