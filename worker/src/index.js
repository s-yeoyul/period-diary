// 알림 발송 서버 (Cloudflare Worker)
// - 앱이 보낸 요청을 받아 Apple/Google 푸시 서버로 Web Push 알림을 보낸다.
// - KV에는 채널(공유)별로 "발송 토큰 해시 / 푸시 구독 / 예정일 알림 날짜"만 저장한다. 기록 내용은 모른다.
//
// KV 키  ch:{id} → { tokenHash, subs: { [hash]: { endpoint, keys, role, at } }, schedule: [{ date, kind }], last }
//   role: "self"(기록하는 사람 본인) | "partner"(파트너)

const enc = new TextEncoder();
const NOTIFY_GAP_MS = 10 * 60 * 1000; // 기록 변경 알림은 10분에 최대 1번
const MAX_SUBS = 10;
const MAX_ITEMS = 20;
// 푸시 서버로 알려진 곳에만 요청을 보낸다 (아무 주소로나 요청을 보내는 데 악용되지 않게)
const PUSH_HOSTS = [/^web\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];

const MESSAGES = {
  update:  { partner: "파트너가 생리 기록을 업데이트했어요" },
  pre2:    { self: "2일 뒤 생리 예정이에요",   partner: "파트너의 생리 예정일이 2일 남았어요" },
  start:   { self: "오늘 생리 예정일이에요",   partner: "오늘은 파트너의 생리 예정일이에요" },
  zone:    { self: "오늘부터 가임기예요",      partner: "오늘부터 파트너의 가임기예요" }
};

export default {
  async fetch(req, env) {
    const allowed = origins(env);
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return reply(405, { error: "method" });
    if (!allowed.includes(origin)) return reply(403, { error: "origin" });

    let body;
    try {
      const text = await req.text();
      if (text.length > 8000) return reply(413, { error: "size" });
      body = JSON.parse(text);
    } catch { return reply(400, { error: "json" }); }

    const id = String(body.id || "");
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) return reply(400, { error: "id" });
    const key = "ch:" + id;
    const rec = await env.PUSH.get(key, "json");
    const isOwner = async () => !!rec && typeof body.token === "string" && rec.tokenHash === await sha256(body.token);
    const save = () => env.PUSH.put(key, JSON.stringify(rec));

    switch (new URL(req.url).pathname) {
      // 채널 만들기: 처음 등록한 사람(토큰)만 주인으로 인정
      case "/claim": {
        if (typeof body.token !== "string" || body.token.length < 32) return reply(400, { error: "token" });
        if (!rec) {
          await env.PUSH.put(key, JSON.stringify({ tokenHash: await sha256(body.token), subs: {}, schedule: [], last: 0 }));
          return reply(200, { ok: true });
        }
        return (await isOwner()) ? reply(200, { ok: true }) : reply(403, { error: "owner" });
      }

      // 알림 받기 등록. 본인(self)은 토큰 필요, 파트너는 채널 ID(공유 데이터 안에만 있음)만 있으면 됨
      case "/subscribe": {
        if (!rec) return reply(404, { error: "channel" });
        const role = body.role === "self" ? "self" : "partner";
        if (role === "self" && !(await isOwner())) return reply(403, { error: "owner" });
        const s = body.subscription;
        if (!validSubscription(s, env)) return reply(400, { error: "subscription" });
        rec.subs[await sha256(s.endpoint + "|" + role)] = { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, role, at: Date.now() };
        const entries = Object.entries(rec.subs).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_SUBS);
        rec.subs = Object.fromEntries(entries);
        await save();
        return reply(200, { ok: true });
      }

      case "/unsubscribe": {
        if (!rec) return reply(200, { ok: true });
        const role = body.role === "self" ? "self" : "partner";
        delete rec.subs[await sha256(String(body.endpoint || "") + "|" + role)];
        await save();
        return reply(200, { ok: true });
      }

      // 기록 변경 알림 → 파트너에게만
      case "/notify": {
        if (!(await isOwner())) return reply(403, { error: "owner" });
        if (Date.now() - rec.last < NOTIFY_GAP_MS) return reply(200, { ok: true, skipped: true });
        rec.last = Date.now();
        const sent = await sendAll(env, rec, s => message("update", s.role));
        await save();
        return reply(200, { ok: true, sent });
      }

      // 예정일 알림 날짜 저장 (앱이 계산해서 보냄)
      case "/schedule": {
        if (!(await isOwner())) return reply(403, { error: "owner" });
        const items = Array.isArray(body.items) ? body.items : [];
        rec.schedule = items
          .filter(i => i && /^\d{4}-\d{2}-\d{2}$/.test(i.date) && i.kind !== "update" && MESSAGES[i.kind])
          .slice(0, MAX_ITEMS)
          .map(i => ({ date: i.date, kind: i.kind }));
        await save();
        return reply(200, { ok: true, count: rec.schedule.length });
      }

      // 채널 삭제 (공유 중지 시)
      case "/delete": {
        if (!rec) return reply(200, { ok: true });
        if (!(await isOwner())) return reply(403, { error: "owner" });
        await env.PUSH.delete(key);
        return reply(200, { ok: true });
      }
    }
    return reply(404, { error: "path" });
  },

  // 매일 00:00 UTC (오전 9시 KST) 실행
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDaily(env));
  }
};

export async function runDaily(env, now = Date.now()) {
  const today = new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10); // 한국 날짜
  let cursor, total = 0;
  do {
    const page = await env.PUSH.list({ prefix: "ch:", cursor });
    for (const { name } of page.keys) {
      const rec = await env.PUSH.get(name, "json");
      if (!rec) continue;
      const due = rec.schedule.filter(i => i.date === today);
      const before = JSON.stringify(rec);
      rec.schedule = rec.schedule.filter(i => i.date > today);
      for (const item of due) total += await sendAll(env, rec, s => message(item.kind, s.role));
      if (JSON.stringify(rec) !== before) await env.PUSH.put(name, JSON.stringify(rec));
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return total;
}

function origins(env) {
  return String(env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
}

function message(kind, role) {
  const body = MESSAGES[kind] && MESSAGES[kind][role];
  return body ? { title: "캘린더", body, tab: role === "partner" ? "partner" : "me" } : null;
}

function validSubscription(s, env) {
  if (!s || typeof s.endpoint !== "string" || s.endpoint.length > 1000 || !s.keys) return false;
  if (typeof s.keys.p256dh !== "string" || typeof s.keys.auth !== "string") return false;
  let url;
  try { url = new URL(s.endpoint); } catch { return false; }
  if (env.ALLOW_TEST_ENDPOINTS === "true" && url.hostname === "127.0.0.1") return true; // 로컬 테스트 전용
  return url.protocol === "https:" && PUSH_HOSTS.some(re => re.test(url.hostname));
}

async function sendAll(env, rec, messageFor) {
  let sent = 0;
  for (const [k, s] of Object.entries(rec.subs)) {
    const msg = messageFor(s);
    if (!msg) continue;
    try {
      const res = await sendPush(env, s, JSON.stringify(msg));
      if (res.status === 404 || res.status === 410) { delete rec.subs[k]; continue; } // 앱 삭제 등으로 만료된 구독
      if (res.ok) sent++;
      else console.log("push failed", res.status, await res.text());
    } catch (e) { console.log("push error", String(e)); }
  }
  return sent;
}

// ---------- Web Push (RFC 8030 / 8291 / 8292) ----------

async function sendPush(env, sub, payload) {
  const jwt = await vapidJwt(env, new URL(sub.endpoint).origin);
  const body = await encryptPayload(sub.keys, enc.encode(payload));
  return fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "normal"
    },
    body
  });
}

// 푸시 서버에 "이 알림은 우리 서버가 보낸 것"을 증명하는 서명 토큰
async function vapidJwt(env, aud) {
  const pub = unb64u(env.VAPID_PUBLIC_KEY);
  const key = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", d: env.VAPID_PRIVATE_KEY, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const subject = env.VAPID_SUBJECT || origins(env)[0];
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64u(sig)}`;
}

// 알림 내용 암호화 (aes128gcm). 받는 폰만 풀 수 있고, Apple/Google도 내용을 못 봄
async function encryptPayload(keys, plaintext) {
  const uaPublic = unb64u(keys.p256dh);
  const authSecret = unb64u(keys.auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(shared, authSecret, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 256);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, enc.encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(ikm, salt, enc.encode("Content-Encoding: nonce\0"), 96);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(plaintext, new Uint8Array([2]))));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, ct);
}

async function hkdf(ikm, salt, info, bits) {
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, base, bits));
}

async function sha256(s) {
  return b64u(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

function b64u(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64u(s) {
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
