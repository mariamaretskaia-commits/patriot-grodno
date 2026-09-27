// Импортёр раздела «Места памяти» с сайтов райисполкомов.
//
// Разметка этих страниц нерегулярна: заголовки набраны <strong>/<b> без
// h2/h3, длинные названия разорваны, часть объектов свёрстана <div> внутри
// «висячих» <strong>, фотографии спрятаны и в тексте, и отдельными
// абзацами. Структурный разбор здесь ненадёжен, поэтому границы объектов
// задаются списком заголовков: инструмент ищет их в тексте статьи и
// режет описание между соседними заголовками. Если заголовок не найден
// или встречается дважды, инструмент падает, а не импортирует мусор.
//
// Фотографии перед очисткой тегов заменяются метками, поэтому снимок
// относится к тому объекту, между чьими заголовками он встретился.
//
// Инструмент не трогает data/places.json: результат кладётся в
// data/draft_*.json и ждёт проверки человеком.
//
// Запуск:
//   node tools/import_district.mjs <url> <префикс-id> <anchors.json>
//        --district="Дятловский район" [--write]

import { writeFileSync, readFileSync, existsSync } from "node:fs";

const [, , pageUrl, idPrefix, anchorsPath, ...flags] = process.argv;
const write = flags.includes("--write");
const districtArg = flags.find((f) => f.startsWith("--district="));

if (!pageUrl || !idPrefix || !anchorsPath) {
  console.error("Использование: node tools/import_district.mjs <url> <префикс-id> <anchors.json> [--write]");
  process.exit(2);
}

const UA = { "User-Agent": "Mozilla/5.0 (compatible; catalog-import/1.0)" };
const IMG = "\u0001IMG\u0001";
const PLACES = "data/places.json";

function decodeEntities(text) {
  return String(text)
    .replace(/&nbsp;/g, " ")
    .replace(/&laquo;/g, "«").replace(/&raquo;/g, "»")
    .replace(/&ndash;/g, "–").replace(/&mdash;/g, "—")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

// Границы статьи: div.inner_text с подсчётом вложенности, ленивый regex
// обрывался на первой внутренней разметке и терял конец.
function extractScope(html) {
  const open = html.match(/<div[^>]+class="[^"]*inner_text[^"]*"[^>]*>/i);
  if (!open) return html;
  const start = open.index + open[0].length;
  const re = /<div\b[^>]*>|<\/div>/gi;
  re.lastIndex = start;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    if (m[0][1] === "/") depth -= 1;
    else depth += 1;
    if (depth === 0) return html.slice(start, m.index);
  }
  return html.slice(start);
}

// Текст статьи, в котором каждая фотография помечена меткой IMG.
function articleText(html) {
  const scope = extractScope(html);
  const marked = scope.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = (tag.match(/src="([^"]+)"/i) || [])[1];
    if (!src || !src.includes("/uploads/")) return " ";
    return " " + IMG + new URL(src, pageUrl).href + IMG + " ";
  });
  return stripTags(marked);
}

// --- заголовки -----------------------------------------------------------

// Файл якорей принимает и голый массив заголовков, и объект с полями
// district/coords — второй вариант переносит координаты из KML-карты
// и снимает необходимость вводить район флагом.
const anchorFile = JSON.parse(readFileSync(anchorsPath, "utf8"));
const anchors = Array.isArray(anchorFile) ? anchorFile : anchorFile.titles;
const coordsMap = Array.isArray(anchorFile) ? null : (anchorFile.coords || null);
const district = Array.isArray(anchorFile)
  ? (districtArg ? districtArg.slice("--district=".length) : idPrefix)
  : (anchorFile.district || idPrefix);

if (!Array.isArray(anchors) || !anchors.length) {
  console.error("anchors.json должен содержать непустой массив заголовков (поле titles) либо сам массив");
  process.exit(2);
}

// --- загрузка ------------------------------------------------------------

const html = await (await fetch(pageUrl, { headers: UA })).text();
const text = articleText(html);
console.log("страница:", html.length, "символов, текст:", text.length, "символов");

// --- проверка заголовков -------------------------------------------------

// Заголовок ищется строго после предыдущего, поэтому объекты не
// перекрываются и порядок сохраняется. Повтор названия внутри описания
// («Обелиск Славы установлен в 1967 году…») — обычный текст, поэтому
// отдельной проверки на повтор нет: если заголовок действительно
// продублирован, объект останется без описания, и это поймает
// проверка длины ниже.
const problems = [];
let cursor = 0;
const found = anchors.map((anchor) => {
  const at = text.indexOf(anchor, cursor);
  if (at < 0) {
    problems.push("заголовок не найден после предыдущего: " + anchor);
    return null;
  }
  cursor = at + anchor.length;
  return at;
});

if (problems.length) {
  console.error("\nПРОБЛЕМЫ РАЗБОРА:");
  problems.forEach((p) => console.error("  - " + p));
  process.exit(1);
}

const bounds = found.map((at, i) => ({
  title: anchors[i],
  from: at + anchors[i].length,
  to: i + 1 < anchors.length ? found[i + 1] : text.length,
}));

// --- описание и фотографии ----------------------------------------------

const usedTitles = new Set();
// Идентификаторы в каталоге латинские: кириллица в id ломает ссылки
// и Sharing, поэтому транслитерируем.
const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};
function slug(value) {
  const map = { "«": "", "»": "", "—": "-", "–": "-", ".": "", ",": "", "(": "", ")": "" };
  let out = value.toLowerCase();
  for (const [from, to] of Object.entries(map)) out = out.split(from).join(to);
  out = out.split("").map((ch) => (ch in TRANSLIT ? TRANSLIT[ch] : ch)).join("");
  return out.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

const places = bounds.map((b) => {
  const slice = text.slice(b.from, b.to);
  const photos = [...slice.matchAll(new RegExp(IMG + "(.*?)" + IMG, "g"))].map((m) => m[1]);
  // Метки снимаются вместе с адресом: иначе URL фотографии осел бы
  // в начале описания.
  const full = stripTags(slice.replace(new RegExp(IMG + ".*?" + IMG, "g"), " "));
  let id = idPrefix + "-" + slug(b.title);
  let n = 2;
  while (usedTitles.has(id)) { id = idPrefix + "-" + slug(b.title) + "-" + n; n += 1; }
  usedTitles.add(id);
  const coords = coordsMap ? (coordsMap[b.title] || null) : null;
  if (coordsMap && !coords) problems.push("нет координат в anchors.json: " + b.title);
  return {
    id,
    title: b.title,
    district,
    coords,
    coordStatus: coords ? "kml" : "unknown",
    short: "",
    full,
    address: "",
    source: pageUrl,
    photos,
  };
});

if (problems.length) {
  console.error("\nПРОБЛЕМЫ:");
  problems.forEach((p) => console.error("  - " + p));
  process.exit(1);
}

places.forEach((p, i) => {
  if (!p.photos.length) console.error("ВНИМАНИЕ: у «" + p.title + "» не найдено фотографий");
  if (p.full.length < 80) console.error("ВНИМАНИЕ: у «" + p.title + "» слишком короткое описание");
  console.log("  " + (i + 1) + ". " + p.title + "  [фото: " + p.photos.length + ", текст: " + p.full.length + "]");
});

// --- сверка с текущим каталогом -----------------------------------------
// Импортёр не решает, что делать с совпадением: он обязан показать его.

if (existsSync(PLACES)) {
  const current = JSON.parse(readFileSync(PLACES, "utf8"));
  const list = Array.isArray(current) ? current : (current.places || []);
  const normalize = (s) => String(s).toLowerCase()
    .replace(/[«»"'().,—–-]/g, " ").replace(/\s+/g, " ").trim();
  const byTitle = new Map();
  for (const item of list) byTitle.set(normalize(item.title), item);

  const collisions = places
    .map((p) => {
      const key = normalize(p.title);
      let hit = byTitle.get(key);
      if (!hit) {
        // В каталоге заголовок часто уточняется районом в скобках,
        // поэтому ищем и по совпадению начала строки.
        for (const [title, item] of byTitle) {
          if (title.startsWith(key) || key.startsWith(title)) { hit = item; break; }
        }
      }
      return { p, hit };
    })
    .filter((x) => x.hit);
  const idClashes = places.filter((p) => list.some((item) => item.id === p.id));

  if (collisions.length || idClashes.length) {
    console.log("\nВОЗМОЖНЫЕ ДУБЛИ (требуют решения, автоматически не объединяются):");
    for (const c of collisions) {
      console.log("  «" + c.p.title + "»");
      console.log("    черновик: " + c.p.id + ", фото: " + c.p.photos.length);
      console.log("    каталог:  " + c.hit.id + ", " + c.hit.title + ", " + JSON.stringify(c.hit.coords));
    }
    for (const p of idClashes) console.log("  совпал id: " + p.id);
    if (!collisions.length) console.log("  (названия различаются, но id уже заняты)");
  } else {
    console.log("\nдублей по названию и id не найдено");
  }
}

const draft = {
  generatedAt: new Date().toISOString(),
  source: pageUrl,
  district,
  note: "Черновик: координаты не подтверждены, поля short/address/type/period пустые. data/places.json не изменён.",
  places,
};

const out = "data/draft_" + idPrefix.replace(/[^\w-]/g, "") + ".json";
if (write) {
  writeFileSync(out, JSON.stringify(draft, null, 2) + "\n", "utf8");
  console.log("\nчерновик записан:", out);
} else {
  console.log("\nчерновик не записан (нужен --write)");
}
console.log("итого объектов:", places.length, ", фотографий:", places.reduce((n, p) => n + p.photos.length, 0));
