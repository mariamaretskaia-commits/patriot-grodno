// Проверка, что Workers KV не портит байты фотографии.
//
// Загружает файл с байтами, которые ломаются при хранении в строке
// (нули, 0xFF, недопустимые UTF-8-последовательности), читает его обратно
// и сравнивает SHA-256. Если хеши совпали — фото можно класть в KV как есть,
// без base64. Если нет — переходим на base64 в worker/src/blobs.js.
//
// Скрипт работает по-настоящему с BLOBS-хранилищем: пишет тестовый ключ и
// удаляет его в конце. Требуется задеплоенный воркер и авторизация Wrangler
// (`npx wrangler login`).
//
// Запуск: node worker/tools/verify_blob.mjs
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const NAMESPACE = "bb6faaac811042d3aef5897ed4e1eadd"; // BLOBS
const KEY = "verify:blob:roundtrip";
const dir = tmpdir();
const src = join(dir, "verify_blob_in.bin");
const dst = join(dir, "verify_blob_out.bin");

// 256 КБ байтов, которые не переживают наивное преобразование в строку.
const bytes = new Uint8Array(256 * 1024);
for (let i = 0; i < bytes.length; i += 1) {
  bytes[i] = [0x00, 0xff, 0xc3, 0x28, 0xe0, 0x80, 0x80, 0xfe, 0x7f, 0x0a, 0x0d, 0x1b, 0x80, 0xbf][i % 14];
}
writeFileSync(src, bytes);

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const want = sha(bytes);
console.log("загружаем", bytes.length, "байт, sha256", want.slice(0, 16));

const wrangler = (args) =>
  execFileSync("cmd", ["/c", "npx", "wrangler", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

wrangler(["kv", "key", "put", KEY, "--path", src, "--namespace-id", NAMESPACE, "--remote"]);

// KV в регионе читает с задержкой до минуты, поэтому читаем с повторами.
let got = null;
for (let attempt = 1; attempt <= 12; attempt += 1) {
  await new Promise((r) => setTimeout(r, 8000));
  try {
    // Важно: перенаправление делает cmd, а не PowerShell — иначе
    // бинарный вывод портится при перекодировке.
    execFileSync("cmd", ["/c", "npx", "wrangler", "kv", "key", "get", KEY,
      "--namespace-id", NAMESPACE, "--remote", ">", dst], { stdio: "ignore" });
    const buf = readFileSync(dst);
    if (buf.length > 0) { got = buf; break; }
  } catch {
    // ключ ещё не виден — ждём
  }
  console.log(`  попытка ${attempt}: ключ ещё не прочитан, ждём`);
}

if (!got) {
  console.error("НЕ ПРОВЕРЕНО: значение так и не прочиталось");
  process.exit(1);
}

const have = sha(got);
console.log("прочитано", got.length, "байт, sha256", have.slice(0, 16));
if (have === want && got.length === bytes.length) {
  console.log("OK: байты сохранились без изменений, base64 не нужен");
} else {
  console.log("ПЛОХО: KV исказил байты, нужен base64");
  process.exit(1);
}

wrangler(["kv", "key", "delete", KEY, "--namespace-id", NAMESPACE, "--remote"]);
rmSync(src, { force: true });
rmSync(dst, { force: true });
console.log("тестовый ключ удалён");
