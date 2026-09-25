import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const paths = {
  template: resolve(root, "src/index.html"),
  styles: resolve(root, "src/styles.css"),
  app: resolve(root, "src/app.js"),
  leafletCss: resolve(root, "src/vendor/leaflet/leaflet.css"),
  leafletJs: resolve(root, "src/vendor/leaflet/leaflet.js"),
  places: resolve(root, "data/places.json"),
  questions: resolve(root, "data/questions.json"),
  credits: resolve(root, "data/photo_credits.json"),
  photos: resolve(root, "img/opt"),
  out: resolve(root, "dist/index.html"),
  site: resolve(root, "index.html"),
};

const IMAGE_EXT = /\.(webp|png|jpe?g)$/i;

async function readText(file) {
  return readFile(file, "utf8");
}

async function collectPhotos() {
  if (!existsSync(paths.photos)) return {};
  const files = await readdir(paths.photos);
  const out = {};
  for (const file of files.sort()) {
    if (!IMAGE_EXT.test(file)) continue;
    const id = file.replace(IMAGE_EXT, "");
    const bytes = await readFile(resolve(paths.photos, file));
    const mime = file.endsWith(".png") ? "image/png" : file.endsWith(".jpg") || file.endsWith(".jpeg") ? "image/jpeg" : "image/webp";
    out[id] = `data:${mime};base64,${bytes.toString("base64")}`;
  }
  return out;
}

function inlineLeafletCss(css, imageData) {
  let out = css;
  for (const [file, dataUri] of Object.entries(imageData)) {
    out = out.replaceAll(`url(images/${file})`, `url(${dataUri})`);
  }
  return out;
}

async function main() {
  for (const key of ["template", "styles", "app", "leafletCss", "leafletJs", "places", "questions"]) {
    if (!existsSync(paths[key])) {
      throw new Error(`Отсутствует файл: ${paths[key]}`);
    }
  }

  const leafletImageDir = resolve(root, "src/vendor/leaflet/images");
  const leafletImages = existsSync(leafletImageDir) ? await readdir(leafletImageDir) : [];
  const imageData = {};
  for (const file of leafletImages) {
    const bytes = await readFile(resolve(leafletImageDir, file));
    imageData[file] = `data:image/png;base64,${bytes.toString("base64")}`;
  }

  const photos = await collectPhotos();
  const places = JSON.parse(await readText(paths.places));
  const questions = JSON.parse(await readText(paths.questions));
  const credits = existsSync(paths.credits) ? JSON.parse(await readText(paths.credits)) : {};
  const photoCredits = {};
  for (const [id, credit] of Object.entries(credits)) {
    if (photos[id]) photoCredits[id] = credit;
  }

  const data = [
    `const PLACES = ${JSON.stringify(places)};`,
    `const QUESTIONS = ${JSON.stringify(questions)};`,
    `const PHOTOS = ${JSON.stringify(photos)};`,
    `const PHOTO_CREDITS = ${JSON.stringify(photoCredits)};`,
    "window.PLACES = PLACES;",
    "window.QUESTIONS = QUESTIONS;",
    "window.PHOTOS = PHOTOS;",
    "window.PHOTO_CREDITS = PHOTO_CREDITS;"
  ].join("\n");

  let html = await readText(paths.template);
  html = html.replace("/*{{LEAFLET_CSS}}*/", inlineLeafletCss(await readText(paths.leafletCss), imageData));
  html = html.replace("/*{{CSS}}*/", await readText(paths.styles));
  html = html.replace("/*{{LEAFLET_JS}}*/", await readText(paths.leafletJs));
  html = html.replace("/*{{DATA}}*/", data);
  html = html.replace("/*{{APP_JS}}*/", await readText(paths.app));

  const leftovers = html.match(/\/\*\{\{[A-Z_]+\}\}\*\//g);
  if (leftovers) throw new Error(`Не заменены плейсхолдеры: ${leftovers.join(", ")}`);

  await mkdir(dirname(paths.out), { recursive: true });
  await writeFile(paths.out, html, "utf8");
  await writeFile(paths.site, html, "utf8");

  const kb = (value) => `${(value / 1024).toFixed(1)} КБ`;
  console.log(`Собрано: ${paths.out}`);
  console.log(`  копия для GitHub Pages: ${paths.site}`);
  console.log(`  размер: ${kb(Buffer.byteLength(html))}`);
  console.log(`  мест: ${places.length}, вопросов: ${questions.length}`);
  console.log(`  фото встроено: ${Object.keys(photos).length}, заглушек: ${places.length - Object.keys(photos).length}`);
  if (Object.keys(photoCredits).length !== Object.keys(photos).length) {
    console.log(`  внимание: кредитов ${Object.keys(photoCredits).length}, фото ${Object.keys(photos).length}`);
  }
  if (Object.keys(photos).length === 0) {
    console.log("  подсказка: положите фото в img/raw и запустите python tools/optimize_images.py");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
