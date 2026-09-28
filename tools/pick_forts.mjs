// Пересобирает выбранные фото фортов с fortressgrodno.by под фактические id из places.json.
// Запуск: node tools/pick_forts.mjs
import { writeFileSync } from "node:fs";

const PICKS = {
  "fort-1-zagorany": ["Форт№I/146.jpg", "Форт№I. Общий вид"],
  "fort-2-naumovichi": ["Форт№II/95.jpg", "Форт№II"],
  "fort-4-korolino": ["Форт№IV/107.jpg", "Форт№IV. Общий вид"],
  "fort-5-gnevenchina": ["Форт№V/113.jpg", "Форт№V"],
  "fort-6-kamenka": ["Форт№VI/242.jpg", "Форт№VI"],
  "fort-7-malaya-olshanka": ["Форт№VII/149.jpg", "Форт№VII"],
  "fort-9-pogorany": ["Форт№IX/130.jpg", "Форт№IX"],
  "fort-10-shchetchinovo": ["Форт№X/132.jpg", "Форт№X. Германские солдаты заняты извлечением металлических конструкций"],
  "fort-11-yalovshchina": ["Форт№XI/133.jpg", "Форт№XI. Остатки временного убежища"],
  "fort-12-lapenki": ["Форт№XII/205.jpg", "Форт№XII. Фрагмент генерального плана крепости"],
  "fort-13-grandichi": ["Форт№XIII/134.jpg", "Форт№XIII. Незаконченный бруствер"],
};

const base = "https://fortressgrodno.by/assets/gallery/";
const got = [];
for (const [id, [rel, title]] of Object.entries(PICKS)) {
  const url = base + rel;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "patriot-grodno-photos/1.0 (educational attribution)" } });
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(`img/raw/${id}.jpg`, buf);
    got.push({ id, url, title, bytes: buf.length });
    console.log(`OK ${id} <- ${rel} (${buf.length} байт)`);
  } catch (err) {
    console.error(`FAIL ${id}: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 500));
}
const credits = Object.fromEntries(got.map((g) => [
  g.id,
  {
    title: g.title,
    author: "fortressgrodno.by",
    license: "Указан источник (сайт fortressgrodno.by)",
    license_url: "https://fortressgrodno.by",
    source_url: g.url,
  },
]));
writeFileSync("tools/fort_credits.json", JSON.stringify(credits, null, 2), "utf8");
console.log("\nКредиты: tools/fort_credits.json");