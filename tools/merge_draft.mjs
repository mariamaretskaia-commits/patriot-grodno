// Слияние проверенного черновика в data/places.json.
//
// Черновик (data/draft_*.json) даёт только официальный текст, фотографии
// и координаты. Всё, что имеет отношение к оформлению карточки — тип,
// годы, короткая аннотация, адрес, — берётся из курируемого файла
// data/district_meta/*.json. Если для записи метаданных нет, слияние
// падает: молча поставить объект с пустым типом нельзя.
//
// Существующие записи каталога не перезаписываются. Если черновик совпал
// с уже имеющейся карточкой (тот же памятник, другое название), запись
// дополняется официальным источником и уточнёнными координатами, а
// фотография не трогается — лицензия действующего снимка может быть
// строже.
//
// Запуск:  node tools/merge_draft.mjs data/draft_dyatlovo.json data/district_meta/dyatlovo.json [--write] [--update]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [, , draftPath, metaPath, ...flags] = process.argv;
const write = flags.includes("--write");
// Без --update инструмент не трогает уже существующие записи. Иначе
// второй прогон молча дописал бы те же девять мест ещё раз.
const update = flags.includes("--update");

if (!draftPath || !metaPath) {
  console.error("Использование: node tools/merge_draft.mjs <draft.json> <meta.json> [--write]");
  process.exit(2);
}

const PAGE_AUTHOR = "Дятловский райисполком, dyatlovo.gov.by";
const RAW = "img/raw";

const draft = JSON.parse(readFileSync(draftPath, "utf8"));
const meta = JSON.parse(readFileSync(metaPath, "utf8"));
const entries = meta.entries || {};
const byId = new Map(draft.places.map((p) => [p.id, p]));
const problems = [];
const plan = [];

// --- проверка полноты ---------------------------------------------------

for (const p of draft.places) {
  const info = entries[p.id];
  if (!info) {
    problems.push("нет курируемых метаданных для: " + p.id);
    continue;
  }
  if (info.mergeInto) continue;
  for (const field of ["type", "period", "short", "address"]) {
    if (!info[field]) problems.push("в метаданных " + p.id + " не заполнено поле " + field);
  }
  if (!p.coords) problems.push("нет координат: " + p.id);
  // Официальный текст обязателен, но если он непомерно длинный, в
  // метаданных допускается своя редакция.
  const len = (info.fullOverride || p.full || "").length;
  if (len < 200) problems.push("слишком короткий текст: " + p.id);
  if (len > 4500 && !info.fullOverride) problems.push("текст " + len + " символов без fullOverride: " + p.id);
}
for (const id of Object.keys(entries)) {
  if (!byId.has(id)) problems.push("метаданные без записи в черновике: " + id);
}

if (problems.length) {
  console.error("\nПРОБЛЕМЫ:");
  problems.forEach((p) => console.error("  - " + p));
  process.exit(1);
}

// --- сборка -------------------------------------------------------------

const places = JSON.parse(readFileSync("data/places.json", "utf8"));
const normalize = (s) => String(s).toLowerCase()
  .replace(/[«»"'().,—–-]/g, " ").replace(/\s+/g, " ").trim();

function addSource(text, addition) {
  if (!text) return addition;
  if (normalize(text).includes(normalize(addition))) return text;
  return text + "; " + addition;
}

const rawWanted = [];

for (const p of draft.places) {
  const info = entries[p.id];

  if (info.mergeInto) {
    const target = places.find((x) => x.id === info.mergeInto);
    if (!target) {
      problems.push("цель слияния не найдена в каталоге: " + info.mergeInto);
      continue;
    }
    const before = { coords: target.coords, coordStatus: target.coordStatus };
    // Координаты из KML точнее прежних каталожных, но это не полевая
    // проверка, поэтому статус остаётся catalog.
    if (p.coords) { target.coords = p.coords; target.coordStatus = "catalog"; }
    target.source = addSource(target.source, PAGE_AUTHOR);
    plan.push({
      action: "дополнено",
      id: target.id,
      title: target.title,
      coords: before.coords + " -> " + JSON.stringify(target.coords),
      note: info.comment || "",
    });
    continue;
  }

  // Запись уже в каталоге: по умолчанию пропускаем, с --update
  // освежаем курируемые поля.
  const existing = places.find((x) => x.id === p.id);
  if (existing) {
    if (!update) {
      plan.push({ action: "пропущено (уже есть, нужен --update)", id: p.id, title: p.title });
      continue;
    }
    // Заголовок берём из черновика: в метаданных его нет, и обращение
    // info.title стирало бы название места.
    for (const field of ["type", "period", "short", "address"]) {
      existing[field] = info[field];
    }
    existing.title = p.title;
    existing.district = meta.district || p.district;
    // Официальный текст не перетираем молча: только если в метаданных
    // явно задана своя редакция.
    if (info.fullOverride) existing.full = info.fullOverride;
    existing.source = addSource(existing.source, PAGE_AUTHOR);
    plan.push({ action: "обновлено", id: p.id, title: p.title, note: info.fullOverride ? "текст заменён редакцией" : "текст официальный, не тронут" });
    continue;
  }

  places.push({
    id: p.id,
    title: p.title,
    district: meta.district || p.district,
    type: info.type,
    period: info.period,
    coords: p.coords,
    coordStatus: "catalog",
    short: info.short,
    full: info.fullOverride || p.full,
    address: info.address,
    source: (p.source ? p.source + "; " : "") + PAGE_AUTHOR + "; координаты — курируемая KML-карта",
  });
  plan.push({ action: "добавлено", id: p.id, title: p.title, photos: p.photos.length });

  // В приложении одно фото на место, поэтому берём первое.
  if (p.photos.length) {
    rawWanted.push({ id: p.id, url: p.photos[0] });
  } else {
    problems.push("нет фотографии: " + p.id);
  }
}

if (problems.length) {
  console.error("\nПРОБЛЕМЫ:");
  problems.forEach((p) => console.error("  - " + p));
  process.exit(1);
}

for (const item of plan) {
  console.log(item.action + ": " + item.id + (item.coords ? "  [" + item.coords + "]" : "") + (item.photos ? "  фото: " + item.photos : ""));
}

// --- фотографии ---------------------------------------------------------

mkdirSync(RAW, { recursive: true });
for (const item of rawWanted) {
  const res = await fetch(item.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; catalog-import/1.0)" } });
  if (!res.ok) {
    console.log("  не скачана " + item.id + ": HTTP " + res.status);
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = item.url.split("?")[0].split(".").pop().toLowerCase();
  const file = item.id + "." + (["jpg", "jpeg", "png", "webp"].includes(ext) ? ext : "jpg");
  writeFileSync(resolve(RAW, file), buf);
  console.log("  скачана " + file + " (" + Math.round(buf.length / 1024) + " КБ) " + item.url);
}

// --- кредиты ------------------------------------------------------------

const creditsPath = "data/photo_credits.json";
const credits = existsSync(creditsPath) ? JSON.parse(readFileSync(creditsPath, "utf8")) : {};
const draftById = new Map(draft.places.map((p) => [p.id, p]));

for (const item of rawWanted) {
  const p = draftById.get(item.id);
  const fileName = item.url.split("/").pop().split("?")[0];
  credits[item.id] = {
    title: fileName,
    author: "Дятловский райисполком",
    license: "лицензия автором не указана",
    license_url: "",
    source_url: p.source,
    source_name: "сайт Дятловского райисполкома",
    date: "",
  };
}

// --- запись -------------------------------------------------------------

if (!write) {
  console.log("\nчерновик слияния не записан (нужен --write)");
} else {
  writeFileSync("data/places.json", JSON.stringify(places, null, 2) + "\n", "utf8");
  writeFileSync(creditsPath, JSON.stringify(credits, null, 2) + "\n", "utf8");
  console.log("\nзаписано: data/places.json (" + places.length + " мест), data/photo_credits.json (" + Object.keys(credits).length + ")");
}

if ((meta.futureCandidates || []).length) {
  console.log("\nкандидаты на следующий заход (нужны официальные страницы):");
  for (const c of meta.futureCandidates) console.log("  - " + c.title + ": " + c.reason);
}
