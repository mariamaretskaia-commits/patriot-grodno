// Загрузка статей о фортах с fortressgrodno.by по верным id.
// Запуск: node tools/fetch_forts.mjs
import { writeFileSync } from "node:fs";

const PAGES = {
  1: 44, 2: 45, 4: 46, 5: 47, 6: 48, 7: 49, 8: 50, 9: 52,
  10: 53, 11: 54, 12: 55, 13: 56, "IV-alt": 43,
};

const strip = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");

const out = [];
for (const [num, id] of Object.entries(PAGES)) {
  const url = `https://fortressgrodno.by/index.php?id=${id}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "patriot-grodno-forts/1.0 (educational)" },
    });
    const text = strip(await res.text());
    // отрезаем навигационное меню: текст статьи начинается с «Опубликовано»
    const start = text.indexOf("Опубликовано");
    let body = start > -1 ? text.slice(start) : text;
    const cut = body.search(/Разработка и поддержка/);
    if (cut > -1) body = body.slice(0, cut);
    out.push(`\n\n########## ФОРТ ${num} id=${id} ${url}\n\n` + body.trim());
    console.log("ок " + num + " id=" + id + " символов=" + body.trim().length);
  } catch (err) {
    out.push(`\n\n########## ФОРТ ${num} ОШИБКА ${err.message}`);
    console.log("ошибка " + num + ": " + err.message);
  }
  await new Promise((r) => setTimeout(r, 1000));
}

writeFileSync("tools/forts_raw.txt", out.join(""), "utf8");
console.log("\nИтог: tools/forts_raw.txt");
