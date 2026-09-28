// Собирает галереи фортов с fortressgrodno.by и скачивает фото.
// Запуск: node tools/fetch_galleries.mjs
import { writeFileSync, mkdirSync } from "node:fs";

const PAGES = {
  "fort-1-zagorany": 44,
  "fort-2-naumovichi": 45,
  "fort-3-labno-ogorodniki": 43,
  "fort-4-korolino": 46,
  "fort-5-gorodnichy": 47,
  "fort-6": 48,
  "fort-7": 49,
  "fort-8": 50,
  "fort-9": 52,
  "fort-10": 53,
  "fort-11": 54,
  "fort-12-lapenki": 55,
  "fort-13": 56,
};

const re = /href="(assets\/gallery\/[^"]+\.(?:jpg|jpeg|png|webp))"[^>]*title="([^"]*)"/gi;

const manifest = [];
for (const [place, id] of Object.entries(PAGES)) {
  const url = `https://fortressgrodno.by/index.php?id=${id}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "patriot-grodno-photos/1.0 (educational attribution)" } });
    const html = res.ok ? await res.text() : "";
    const shots = [...html.matchAll(re)].map((m) => ({ url: "https://fortressgrodno.by/" + m[1], title: m[2] }));
    manifest.push({ place, id, count: shots.length, shots });
    console.log(`${place} (id=${id}): ${shots.length} фото`);
  } catch (err) {
    manifest.push({ place, id, count: 0, shots: [], error: err.message });
    console.error(`${place}: ОШИБКА ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 700));
}

writeFileSync("tools/galleries_manifest.json", JSON.stringify(manifest, null, 2), "utf8");
mkdirSync("img/raw", { recursive: true });

// Логика выбора: предпочитаем "Общий вид", "Современный вид", иначе первый снимок.
for (const { place, shots } of manifest) {
  if (!shots.length) continue;
  const pick =
    shots.find((s) => /общий вид|современный вид|общий/i.test(s.title)) ||
    shots.find((s) => /вид|панорама/i.test(s.title)) ||
    shots[0];
  const ext = pick.url.split(".").pop();
  const out = `img/raw/${place}.${ext}`;
  try {
    const res = await fetch(pick.url, { headers: { "User-Agent": "patriot-grodno-photos/1.0 (educational attribution)" } });
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(out, buf);
    console.log(`OK ${place} <- ${pick.url} (${buf.length} байт) "${pick.title}"`);
  } catch (err) {
    console.error(`FAIL ${place}: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log("\nМанифест: tools/galleries_manifest.json");