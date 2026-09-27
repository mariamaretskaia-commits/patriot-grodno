// Проверка подлинности Telegram initData (Mini App).
// Токен бота хранится в секрете BOT_TOKEN и в код не попадает.

const encoder = new TextEncoder();

export function parseInitData(raw) {
  if (typeof raw !== "string" || !raw) return null;
  const params = new URLSearchParams(raw);
  const hash = params.get("hash");
  if (!hash) return null;

  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (key === "hash" || key === "signature") continue;
    pairs.push([key, value]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");
  const authDate = Number(params.get("auth_date") || 0);
  const user = parseUser(params.get("user"));

  return { hash, dataCheckString, authDate, user };
}

function parseUser(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function hmacSha256(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, message));
}

export async function verifyInitData(raw, botToken, options = {}) {
  const maxAgeSeconds = options.maxAgeSeconds ?? 86400;
  const nowSeconds = Math.floor(Date.now() / 1000);

  const parsed = parseInitData(raw);
  if (!parsed) return { ok: false, reason: "no_init_data" };

  if (maxAgeSeconds > 0) {
    if (!parsed.authDate) return { ok: false, reason: "no_auth_date" };
    if (parsed.authDate > nowSeconds + 60) return { ok: false, reason: "auth_date_in_future" };
    if (nowSeconds - parsed.authDate > maxAgeSeconds) return { ok: false, reason: "init_data_expired" };
  }

  const secretKey = await hmacSha256(encoder.encode("WebAppData"), encoder.encode(botToken));
  const computed = await hmacSha256(secretKey, encoder.encode(parsed.dataCheckString));
  const expected = hexToBytes(parsed.hash);

  if (!timingSafeEqual(computed, expected)) return { ok: false, reason: "bad_hash" };
  if (!parsed.user || !parsed.user.id) return { ok: false, reason: "no_user" };

  return {
    ok: true,
    user: {
      id: String(parsed.user.id),
      firstName: parsed.user.first_name || "",
      lastName: parsed.user.last_name || "",
      username: parsed.user.username || "",
      languageCode: parsed.user.language_code || "",
      isPremium: Boolean(parsed.user.is_premium),
    },
  };
}
