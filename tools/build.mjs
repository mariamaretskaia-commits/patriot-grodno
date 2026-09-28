import { readFile, writeFile, mkdir, readdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const paths = {
  template: resolve(root, "src/index.html"),
  styles: resolve(root, "src/styles.css"),
  app: resolve(root, "src/app.js"),
  cloud: resolve(root, "src/cloud.js"),
  leafletCss: resolve(root, "src/vendor/leaflet/leaflet.css"),
  leafletJs: resolve(root, "src/vendor/leaflet/leaflet.js"),
  places: resolve(root, "data/places.json"),
  questions: resolve(root, "data/questions.json"),
  credits: resolve(root, "data/photo_credits.json"),
  photos: resolve(root, "img/opt"),
  // Значки лежат отдельной папкой: у них нет кредитов, и в img/opt их быть
  // не должно — catalog_check требует биекцию фото и кредитов.
  badges: resolve(root, "img/badges"),
  out: resolve(root, "dist/index.html"),
  site: resolve(root, "index.html"),
  // Иконки лежат отдельными файлами: собранная страница — один HTML,
  // и картинку для вкладки браузера положить можно только рядом с ним.
  icons: ["favicon.ico", "icon-64.png", "icon-192.png", "icon-256.png", "icon-512.png", "apple-touch-icon.png"],
  // Статика, которая должна работать при любом размещении готовой
  // страницы: её встраиваем как data URI, иначе файл пришлось бы искать
  // рядом с документом. Ключ — путь, как он указан в исходниках.
  inlineAssets: {
    "img/emblem-128.webp": { file: resolve(root, "img/emblem-128.webp"), mime: "image/webp" },
  },
  // Иконку вкладки встраиваем как PNG: data URI с image/x-icon
  // понимают не все браузеры, а PNG поддерживают все.
  tabIcon: { file: resolve(root, "icon-64.png"), mime: "image/png" },
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

// Значки встраиваются так же, как фото мест, но отдельной картой:
// имена файлов совпадают с id значков (first, quiz, forts, patriot).
async function collectBadges() {
  if (!existsSync(paths.badges)) return {};
  const files = await readdir(paths.badges);
  const out = {};
  for (const file of files.sort()) {
    if (!IMAGE_EXT.test(file)) continue;
    const id = file.replace(IMAGE_EXT, "");
    const bytes = await readFile(resolve(paths.badges, file));
    const mime = file.endsWith(".png") ? "image/png" : file.endsWith(".jpg") || file.endsWith(".jpeg") ? "image/jpeg" : "image/webp";
    out[id] = `data:${mime};base64,${bytes.toString("base64")}`;
  }
  return out;
}

function inlineLeafletCss(css, imageData) {  let out = css;
  for (const [file, dataUri] of Object.entries(imageData)) {
    out = out.replaceAll(`url(images/${file})`, `url(${dataUri})`);
  }
  return out;
}

async function main() {
  for (const key of ["template", "styles", "app", "cloud", "leafletCss", "leafletJs", "places", "questions"]) {
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
  const badges = await collectBadges();
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
    `const BADGES = ${JSON.stringify(badges)};`,
    `const PHOTO_CREDITS = ${JSON.stringify(photoCredits)};`,
    "window.PLACES = PLACES;",
    "window.QUESTIONS = QUESTIONS;",
    "window.PHOTOS = PHOTOS;",
    "window.BADGES = BADGES;",
    "window.PHOTO_CREDITS = PHOTO_CREDITS;"
  ].join("\n");

  let html = await readText(paths.template);
  // Подстановка идёт функцией, а не строкой: в содержимом исходников
  // встречаются последовательности $&, $' и $`, которые в строковом
  // аргументе replace трактуются как спецсимволы и портят результат.
  const inline = (marker, content) => html.replace(marker, () => content);
  html = inline("/*{{LEAFLET_CSS}}*/", inlineLeafletCss(await readText(paths.leafletCss), imageData));
  html = inline("/*{{CSS}}*/", await readText(paths.styles));
  html = inline("/*{{LEAFLET_JS}}*/", await readText(paths.leafletJs));
  html = inline("/*{{DATA}}*/", data);
  html = inline("/*{{CLOUD_JS}}*/", await readText(paths.cloud));
  html = inline("/*{{APP_JS}}*/", await readText(paths.app));

  const leftovers = html.match(/\/\*\{\{[A-Z_]+\}\}\*\//g);
  if (leftovers) throw new Error(`Не заменены плейсхолдеры: ${leftovers.join(", ")}`);

  // Встраиваем статику после подстановки скриптов: ссылки на неё есть
  // и в разметке, и в app.js, а после сборки всё лежит в одном файле,
  // поэтому замена идёт по готовому документу.
  let inlinedAssets = 0;
  for (const [path, spec] of Object.entries(paths.inlineAssets)) {
    if (!existsSync(spec.file)) throw new Error(`Нет статики для встраивания: ${path} (создайте её скриптом tools/)`);
    const uri = `data:${spec.mime};base64,${(await readFile(spec.file)).toString("base64")}`;
    html = html.split(path).join(uri);
    inlinedAssets += 1;
  }
  if (existsSync(paths.tabIcon.file)) {
    const uri = `data:${paths.tabIcon.mime};base64,${(await readFile(paths.tabIcon.file)).toString("base64")}`;
    html = html.split('href="favicon.ico"').join(`href="${uri}"`);
  } else {
    console.warn("  ВНИМАНИЕ: нет icon-64.png, иконка вкладки останется внешней");
  }

  await mkdir(dirname(paths.out), { recursive: true });
  await writeFile(paths.out, html, "utf8");
  await writeFile(paths.site, html, "utf8");

  // Копируем иконки в dist, иначе локальный запуск dist/index.html
  // показывает битую иконку вкладки, хотя на Pages всё в порядке.
  const missingIcons = [];
  for (const name of paths.icons) {
    const from = resolve(root, name);
    if (!existsSync(from)) { missingIcons.push(name); continue; }
    await copyFile(from, resolve(dirname(paths.out), name));
  }

  const kb = (value) => `${(value / 1024).toFixed(1)} КБ`;
  console.log(`Собрано: ${paths.out}`);
  console.log(`  копия для GitHub Pages: ${paths.site}`);
  console.log(`  размер: ${kb(Buffer.byteLength(html))}`);
  console.log(`  иконок скопировано в dist: ${paths.icons.length - missingIcons.length}`);
  console.log(`  встроено в страницу: ${inlinedAssets + 1} файла (статика и иконка вкладки)`);
  if (missingIcons.length) {
    console.warn(`  ВНИМАНИЕ, иконки не найдены: ${missingIcons.join(", ")} — выполните tools/make_icon.py`);
  }
  console.log(`  мест: ${places.length}, вопросов: ${questions.length}`);
  console.log(`  фото встроено: ${Object.keys(photos).length}, заглушек: ${places.length - Object.keys(photos).length}`);
  const badgeIds = Object.keys(badges).sort();
  console.log(`  значков встроено: ${badgeIds.length}${badgeIds.length ? " (" + badgeIds.join(", ") + ")" : ""}`);
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
