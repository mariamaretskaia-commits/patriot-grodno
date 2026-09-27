import { verifyInitData } from "./auth.js";
import { putBlob, getBlob, deleteBlob } from "./blobs.js";
import { isModerator, publicEntry } from "./moderation.js";
import {
  LIMITS,
  emptyState,
  sanitizeState,
  sanitizeCaption,
  stateKey,
  photoKey,
  newEntryId,
  readIndex,
  writeIndex,
  upsertEntry,
  removeEntry,
  ownPhotosFromIndex,
  isSafeId,
} from "./store.js";

// CORS-Origin вычисляется на каждый запрос по списку ALLOWED_ORIGIN.
// Если переменная не задана, заголовок намеренно не выдаётся: браузер
// заблокирует ответ, и это безопаснее, чем молча разрешить любому сайту
// загружать фото от имени пользователя.
function corsHeaders(request, env) {
  const allowed = env && env.ALLOWED_ORIGIN ? String(env.ALLOWED_ORIGIN) : "";
  const origin = request.headers.get("Origin") || "";
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data",
    "Access-Control-Max-Age": "86400",
  };
  if (!allowed) return headers;

  const matches =
    allowed.trim() === "*" || allowed.split(",").some((item) => item.trim() === origin);
  if (matches && origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  return headers;
}

// Ответ галереи персонализирован (canDelete), поэтому кэшировать его публично
// нельзя: кэш мог бы отдать чужому пользователю чужой canDelete. Байты самих
// фотографий иммутабельны и кэшируются отдельно в handleGetPhoto.
const CACHE_CONTROL = {
  "Cache-Control": "private, no-store",
};

// Размер в байтах, а не в символах: JSON.stringify считает символы,
// а лимит KV применяется к байтам.
function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

function json(body, status = 200, extraHeaders = {}, cors = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...cors,
      ...extraHeaders,
    },
  });
}

function fail(message, status, extra = {}, cors = {}) {
  return json({ ok: false, error: message, ...extra }, status, {}, cors);
}

async function authenticate(request, env) {
  // Без секрета HMAC считался бы от строки "undefined", и такой воркер
  // принимал бы initData, подписанный именно этой строкой. Поэтому
  // неверная конфигурация обязана отказывать, а не проверять подпись.
  if (!env || !env.BOT_TOKEN) return { ok: false, reason: "bot_token_missing" };

  const raw = request.headers.get("X-Telegram-Init-Data") || "";
  if (!raw) return { ok: false, reason: "missing_init_data" };
  return verifyInitData(raw, env.BOT_TOKEN, { maxAgeSeconds: 86400 });
}

// Разбор multipart через нативный request.formData(): Workers поддерживают
// этот метод, и он сам корректно обрабатывает границы частей, переводы строк
// и экранирование — в отличие от ручного поиска по байтам.
async function readFileField(request) {
  // Отсекаем заведомо огромные тела до буферизации, чтобы злоумышленник
  // не заставил воркер держать в памяти сотни мегабайт.
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > LIMITS.maxImageBytes + MULTIPART_OVERHEAD_BYTES) {
    return { tooLarge: true };
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return null;
  }

  const file = form.get("photo") || form.get("file");
  // Строковое значение означает обычное текстовое поле, а не файл.
  if (!file || typeof file === "string") return null;

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) return { empty: true };
  if (bytes.length > LIMITS.maxImageBytes) return { tooLarge: true };

  return { bytes, contentType: String(file.type || "").toLowerCase() };
}

// Запас на multipart-заголовки и прочие поля поверх лимита самого файла.
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/api/health") {
      return json({ ok: true, hasBotToken: Boolean(env.BOT_TOKEN) }, 200, cors);
    }

    const route = url.pathname.replace(/\/+$/, "") || "/";
    const isState = route === "/api/state";
    const isPhotos = route === "/api/photos";
    const isGallery = route === "/api/gallery";
    // Предел 96 совпадает с MAX_ENTRY_ID_LENGTH в store.js: идентификатор
    // записи состоит из placeId и userId, поэтому он длиннее любого из них.
    const photoMatch = /^\/api\/photos\/([a-zA-Z0-9_-]{1,96})$/.exec(route);

    if (!isState && !isPhotos && !isGallery && !photoMatch) {
      return fail("not_found", 404, {}, cors);
    }

    const auth = await authenticate(request, env);
    if (!auth.ok) {
      if (auth.reason === "bot_token_missing") {
        return fail("server_misconfigured", 503, { reason: auth.reason }, cors);
      }
      const status = auth.reason === "missing_init_data" ? 401 : 403;
      return fail("unauthorized", status, { reason: auth.reason }, cors);
    }
    const user = auth.user;
    const moderator = isModerator(user.id, env);

    try {
      if (isState) return await handleState(request, env, user, cors);
      if (isGallery) return await handleGallery(request, env, user, cors, { moderator });
      if (isPhotos && request.method === "POST") return await handleUpload(request, env, user, cors);
      if (isPhotos && request.method === "GET") return await handleGallery(request, env, user, cors, { moderator });
      if (photoMatch && request.method === "DELETE") {
        return await handleDelete(photoMatch[1], env, user, cors, { moderator });
      }
      if (photoMatch && request.method === "GET") {
        return await handleGetPhoto(photoMatch[1], env, cors);
      }
      return fail("method_not_allowed", 405, {}, cors);
    } catch (error) {
      return fail("internal_error", 500, { detail: String(error && error.message) }, cors);
    }
  },
};

async function handleState(request, env, user, cors) {
  // Фото не хранятся в состоянии: привязка «место → моя запись» выводится
  // из индекса галереи при каждом ответе. Так клиент не может случайно
  // стереть её, отправив на сервер пустую карту.
  const withOwnPhotos = async (stored) => {
    const index = await readIndex(env);
    return {
      ...(stored || emptyState()),
      ownPhotos: ownPhotosFromIndex(index.entries, user.id),
    };
  };

  if (request.method === "GET") {
    const stored = await env.STATE.get(stateKey(user.id), "json");
    return json({ ok: true, state: await withOwnPhotos(stored) }, 200, {}, cors);
  }

  if (request.method !== "POST") return fail("method_not_allowed", 405, {}, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return fail("bad_json", 400, {}, cors);
  }

  // Сброс прогресса. mergeState по построению только дополняет данные,
  // поэтому очистить накопленное можно лишь явной операцией.
  if (body && body.reset === true) {
    const cleared = { ...emptyState(), updatedAt: Date.now() };
    await env.STATE.put(stateKey(user.id), JSON.stringify(cleared));
    return json({ ok: true, state: await withOwnPhotos(cleared), reset: true }, 200, {}, cors);
  }

  const clean = sanitizeState(body && body.state ? body.state : body);
  const previous = (await env.STATE.get(stateKey(user.id), "json")) || emptyState();
  const merged = mergeState(previous, clean);
  merged.updatedAt = Date.now();

  const serialized = JSON.stringify(merged);
  if (byteLength(serialized) > LIMITS.maxStateBytes) {
    return fail("state_too_large", 413, { maxBytes: LIMITS.maxStateBytes }, cors);
  }

  await env.STATE.put(stateKey(user.id), serialized);
  return json({ ok: true, state: await withOwnPhotos(merged) }, 200, {}, cors);
}

// Прогресс только растёт: очки за уже засчитанные действия не снимаются
// сервером, а удаление фото проходит отдельным запросом и состояние не трогает.
function mergeState(previous, incoming) {
  const mergeMaps = (a = {}, b = {}) => {
    const out = { ...a };
    for (const [key, value] of Object.entries(b)) {
      if (value) out[key] = value;
    }
    return out;
  };
  return {
    version: 1,
    visited: mergeMaps(previous.visited, incoming.visited),
    correct: mergeMaps(previous.correct, incoming.correct),
    badges: mergeMaps(previous.badges, incoming.badges),
    updatedAt: 0,
  };
}

async function handleUpload(request, env, user, cors) {
  const url = new URL(request.url);
  const placeId = url.searchParams.get("placeId") || "";
  if (!isSafeId(placeId)) return fail("bad_place_id", 400, {}, cors);

  const field = await readFileField(request);
  if (!field) return fail("no_file", 400, {}, cors);
  if (field.tooLarge) return fail("file_too_large", 413, { maxBytes: LIMITS.maxImageBytes }, cors);
  if (field.empty) return fail("empty_file", 400, {}, cors);

  const ext = LIMITS.allowedTypes[field.contentType];
  if (!ext) {
    return fail("unsupported_type", 415, { allowed: Object.keys(LIMITS.allowedTypes) }, cors);
  }

  const index = await readIndex(env);
  const previous = index.entries.find(
    (entry) => entry.userId === user.id && entry.placeId === placeId,
  );

  // Замена уже существующего фото не расходует квоту галереи,
  // поэтому проверяем лимит только для действительно новой записи.
  if (!previous && index.entries.length >= LIMITS.maxTotalPhotos) {
    return fail("gallery_full", 503, { max: LIMITS.maxTotalPhotos }, cors);
  }

  // При замене фотографии идентификатор записи сохраняется. Новый он
  // только при первой загрузке: иначе у клиента, который держит в
  // ownPhotos прежний id, удаление заменившегося фото начало бы отвечать 404.
  const id = previous ? previous.id : newEntryId();
  const objectKey = photoKey(placeId, user.id, ext);
  const entry = {
    id,
    placeId,
    userId: user.id,
    author: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || "Участник",
    username: user.username,
    caption: sanitizeCaption(url.searchParams.get("caption")),
    objectKey,
    contentType: field.contentType,
    size: field.bytes.length,
    createdAt: Date.now(),
  };

  await putBlob(env, objectKey, field.bytes);

  // Сменилось расширение — старый объект в хранилище больше не на что ссылается.
  if (previous && previous.objectKey !== objectKey) {
    await deleteBlob(env, previous.objectKey);
  }

  const next = upsertEntry(index.entries, entry);
  await writeIndex(env, next);

  return json(
    { ok: true, entry, total: next.entries.length, replaced: Boolean(previous) },
    201,
    {},
    cors,
  );
}

// Публичный вид записи галереи и правила удаления описаны в moderation.js:
// обычному пользователю отдаётся минимум, модератору — ещё и автор.

async function handleGallery(request, env, user, cors, { moderator = false } = {}) {
  const url = new URL(request.url);
  const placeFilter = url.searchParams.get("placeId");
  const index = await readIndex(env);
  let entries = index.entries;
  if (placeFilter) {
    if (!isSafeId(placeFilter)) return fail("bad_place_id", 400, {}, cors);
    entries = entries.filter((entry) => entry.placeId === placeFilter);
  }
  // Индекс физически не длиннее maxTotalPhotos, поэтому клиенту можно
  // отдать его целиком одним ответом: постраничный обход на мобильном
  // интернете обошёлся бы дороже, да и не дал бы выиграть в размере.
  const limit = Math.min(
    Number(url.searchParams.get("limit")) || LIMITS.maxTotalPhotos,
    LIMITS.maxTotalPhotos,
  );
  const slice = entries.slice(0, limit);
  return json(
    {
      ok: true,
      entries: slice.map((entry) => publicEntry(entry, { moderator })),
      total: entries.length,
      // Модератору можно удалять любую запись, поэтому ему в canDelete
      // попадает весь срез, а не только собственные фотографии.
      canDelete: moderator
        ? slice.map((entry) => entry.id)
        : slice.filter((entry) => entry.userId === user.id).map((entry) => entry.id),
      isModerator: moderator,
    },
    200,
    CACHE_CONTROL,
    cors,
  );
}

// Параметр назван id, а не entryId, чтобы не затенять одноимённую
// функцию-хелпер из store.js.
async function handleDelete(id, env, user, cors, { moderator = false } = {}) {
  const index = await readIndex(env);
  const entry = index.entries.find((item) => item.id === id);
  if (!entry) return fail("not_found", 404, {}, cors);
  const own = entry.userId === user.id;
  if (!own && !moderator) return fail("forbidden", 403, {}, cors);

  await deleteBlob(env, entry.objectKey);
  const next = removeEntry(index.entries, id);
  await writeIndex(env, next);

  // Состояние править не нужно: привязка места к фото выводится из индекса
  // при каждом чтении, и удалённая запись из него исчезла.
  return json(
    { ok: true, placeId: entry.placeId, moderated: moderator && !own },
    200,
    {},
    cors,
  );
}

async function handleGetPhoto(id, env, cors) {
  const index = await readIndex(env);
  const entry = index.entries.find((item) => item.id === id);
  if (!entry) return fail("not_found", 404, {}, cors);
  const bytes = await getBlob(env, entry.objectKey);
  if (!bytes) return fail("not_found", 404, {}, cors);
  // Байты фотографии не персонализированы, поэтому кэшируются надолго.
  // Открытый GET защищён тем же initData-эндпоинтом, что и галерея.
  return new Response(bytes, {
    headers: {
      "Content-Type": entry.contentType,
      "Cache-Control": "public, max-age=604800, immutable",
      ...cors,
    },
  });
}
