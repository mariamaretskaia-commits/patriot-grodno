// Схема хранения.
//
// Состояние пользователя: KV, ключ state:<userId>. Внутри — карты
// visited / correct / badges. Байты фотографий: KV, ключ
// photo:<placeId>:<userId>.<ext> (см. blobs.js). Индекс галереи: KV,
// ключ photos:index — список записей, чтобы не перебирать хранилище
// листингом на каждый запрос.
//
// Связь «какое фото принадлежит какому месту» НЕ хранится в состоянии:
// она выводится из индекса галереи при каждом чтении. Иначе клиент, у
// которого карта ownPhotos почему-то оказалась пустой, записал бы её на
// сервер и стёр бы у себя привязку к собственным фотографиям.

export const LIMITS = {
  maxImageBytes: 3 * 1024 * 1024,
  // Согласованное правило: один пользователь — одно фото на одно место.
  // Повторная загрузка заменяет предыдущее фото, а не добавляет новое.
  maxPhotosPerUserPerPlace: 1,
  maxTotalPhotos: 400,
  maxStateBytes: 32 * 1024,
  maxCaptionLength: 300,
  allowedTypes: {
    "image/webp": "webp",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
  },
};

// Ключи, которые нельзя принимать из внешнего ввода: присваивание
// out["__proto__"] не создаёт свойство, а меняет прототип объекта, а
// constructor/prototype засоряют последующие обращения по имени.
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const stateKey = (userId) => `state:${userId}`;
export const indexKey = "photos:index";
export const photoKey = (placeId, userId, ext) => `photo:${placeId}:${userId}.${ext}`;

// Идентификатор записи галереи детерминирован по паре (место, автор),
// поэтому повторная загрузка заменяет запись, а не создаёт дубликат
// даже если два запроса пришли в одну и ту же миллисекунду.
export const entryId = (placeId, userId) => `${placeId}_${userId}`;

// Идентификатор записи длиннее, чем placeId или userId по отдельности,
// поэтому для него свой предел: placeId (64) + "_" + userId (20).
const MAX_ENTRY_ID_LENGTH = 96;

export function isSafeEntryId(value) {
  if (typeof value !== "string" || value.length > MAX_ENTRY_ID_LENGTH) return false;
  if (FORBIDDEN_KEYS.has(value)) return false;
  return /^[a-zA-Z0-9_-]+$/.test(value);
}

// Прогресс пользователя. Карты здесь только такие, которые накапливаются
// по принципу «посещённое не отнимаем»: visited, correct, badges.
// Сведения о фото сюда не попадают — см. схему хранения выше.
export function emptyState() {
  return { version: 1, visited: {}, correct: {}, badges: {}, updatedAt: 0 };
}

// Приводим присланное состояние к безопасному виду: только известные поля,
// только строковые id, никаких прототипов из внешнего ввода.
export function sanitizeState(input) {
  const base = emptyState();
  if (!input || typeof input !== "object") return base;

  const copyMap = (value) => {
    const out = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return out;
    for (const [key, entry] of Object.entries(value)) {
      if (!isSafeId(key)) continue;
      if (entry === true || entry === 1) out[key] = 1;
    }
    return out;
  };

  base.visited = copyMap(input.visited);
  base.correct = copyMap(input.correct);
  base.badges = copyMap(input.badges);
  return base;
}

// Привязка «место → id своей записи в галерее», собранная из индекса.
export function ownPhotosFromIndex(entries, userId) {
  const out = {};
  for (const entry of entries) {
    if (entry.userId === userId) out[entry.placeId] = entry.id;
  }
  return out;
}

export function isSafeId(value) {
  if (typeof value !== "string") return false;
  if (FORBIDDEN_KEYS.has(value)) return false;
  return /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

export function sanitizeCaption(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, LIMITS.maxCaptionLength);
}

export async function readIndex(env) {
  const raw = await env.INDEX.get(indexKey, "json");
  if (!raw || !Array.isArray(raw.entries)) return { entries: [] };
  return { entries: raw.entries.filter(isEntry) };
}

export function isEntry(entry) {
  return (
    entry &&
    typeof entry === "object" &&
    isSafeEntryId(entry.id) &&
    isSafeId(entry.placeId) &&
    isSafeId(entry.userId) &&
    typeof entry.objectKey === "string" &&
    entry.objectKey.startsWith("photo:") &&
    typeof entry.contentType === "string"
  );
}

export async function writeIndex(env, index) {
  await env.INDEX.put(indexKey, JSON.stringify(index), { expirationTtl: 60 * 60 * 24 * 400 });
}

// Запись добавляется в индекс только один раз: повторная загрузка того же
// фото тем же пользователем перезаписывает объект, но не плодит дубли.
export function upsertEntry(entries, entry) {
  const rest = entries.filter((item) => !(item.id === entry.id));
  rest.unshift(entry);
  return { entries: rest };
}

export function removeEntry(entries, id) {
  return { entries: entries.filter((item) => item.id !== id) };
}
