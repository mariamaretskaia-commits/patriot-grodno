// Локальные тесты Worker: моки KV и KV, реальная HMAC-проверка.
import crypto from "node:crypto";
import worker from "../src/index.js";

const BOT_TOKEN = "123456:test-token-for-local-tests";
const failures = [];
let checks = 0;

function check(name, got, want) {
  checks += 1;
  const ok = String(got) === String(want);
  if (ok) {
    console.log("  OK   " + name + ": " + got);
  } else {
    failures.push(name);
    console.log("  FAIL " + name + ": got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
  }
}

function makeKv() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      if (!store.has(key)) return null;
      const value = store.get(key);
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) {
      store.set(key, typeof value === "string" ? value : JSON.stringify(value));
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

// Мок KV-хранилища байтов. Работает на том же интерфейсе, что и настоящий
// BLOBS: get(key, "arrayBuffer") отдаёт ArrayBuffer, put/delete работают
// с ключом и Uint8Array.
function makeBlobs() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      if (!store.has(key)) return null;
      const bytes = store.get(key);
      if (type === "arrayBuffer") {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
      return new TextDecoder().decode(bytes);
    },
    async put(key, value) {
      store.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

function newEnv() {
  const STATE = makeKv();
  const INDEX = makeKv();
  const BLOBS = makeBlobs();
  return { env: { STATE, INDEX, BLOBS, BOT_TOKEN, ALLOWED_ORIGIN: "https://mariamaretskaia-commits.github.io" }, STATE, INDEX, BLOBS };
}

// Подпись initData ровно так, как это делает Telegram.
function signInitData(user, extra = {}, botToken = BOT_TOKEN) {
  const params = new URLSearchParams();
  params.set("auth_date", String(Math.floor(Date.now() / 1000)));
  params.set("query_id", "test-query");
  params.set("user", JSON.stringify(user));
  for (const [k, v] of Object.entries(extra)) params.set(k, v);

  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push([k, v]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");

  const out = new URLSearchParams(params);
  out.set("hash", hash);
  return out.toString();
}

function user(id, extra = {}) {
  return {
    id,
    first_name: "Иван",
    last_name: "Петров",
    username: "ivan" + id,
    language_code: "ru",
    is_premium: false,
    ...extra,
  };
}

function makeRequest(url, options = {}) {
  return new Request(url, options);
}

async function call(env, url, options = {}) {
  return worker.fetch(makeRequest(url, options), env);
}

function multipart(fieldName, filename, contentType, bytes) {
  const boundary = "----pgTestBoundary" + Math.random().toString(36).slice(2);
  const head = new TextEncoder().encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

async function main() {
  const { env, STATE, BLOBS } = newEnv();

  console.log("\n1. health");
  {
    const res = await call(env, "https://api.example.com/api/health");
    const body = await res.json();
    check("health ok", body.ok, true);
    check("health sees token", body.hasBotToken, true);
  }

  console.log("\n2. авторизация");
  {
    const res = await call(env, "https://api.example.com/api/state");
    check("без initData 401", res.status, 401);

    const bad = await call(env, "https://api.example.com/api/state", {
      headers: { "X-Telegram-Init-Data": "user=%7B%7D&hash=deadbeef" },
    });
    check("с чужим hash 403", bad.status, 403);

    // Подмена: правим значение параметра в подписанной строке. Хеш остаётся
    // от исходных данных, поэтому проверка обязана отклонить такой initData.
    const signed = signInitData(user(1));
    const tampered = signed.replace("query_id=test-query", "query_id=hacked");
    check("подмена реально изменила строку", tampered !== signed, true);
    const res2 = await call(env, "https://api.example.com/api/state", {
      headers: { "X-Telegram-Init-Data": tampered },
    });
    check("подмена данных 403", res2.status, 403);
    check("причина подмены", (await res2.json()).reason, "bad_hash");

    const wrongToken = signInitData(user(1), {}, "999:other-token");
    const res3 = await call(env, "https://api.example.com/api/state", {
      headers: { "X-Telegram-Init-Data": wrongToken },
    });
    check("чужой токен 403", res3.status, 403);

    const old = signInitData(user(1), { auth_date: String(Math.floor(Date.now() / 1000) - 90000) });
    const res4 = await call(env, "https://api.example.com/api/state", {
      headers: { "X-Telegram-Init-Data": old },
    });
    check("старый initData 403", res4.status, 403);
    check("причина отказа", (await res4.json()).reason, "init_data_expired");
  }

  const auth1 = { "X-Telegram-Init-Data": signInitData(user(42)) };
  const auth2 = { "X-Telegram-Init-Data": signInitData(user(77)) };

  console.log("\n3. состояние");
  {
    const post = await call(env, "https://api.example.com/api/state", {
      method: "POST",
      headers: { ...auth1, "Content-Type": "application/json" },
      body: JSON.stringify({
        state: {
          visited: { "kurgan-slavy-grodno": 1, "tank-t34-grodno": true },
          correct: { "q1": 1 },
          badges: { "first-step": 1 },
          ownPhotos: { "tank-t34-grodno": "abc" },
        },
      }),
    });
    check("POST state ok", post.status, 200);
    const saved = await post.json();
    check("visited сохранён", Object.keys(saved.state.visited).length, 2);
    check("true нормализован в 1", saved.state.visited["tank-t34-grodno"], 1);

    const get = await call(env, "https://api.example.com/api/state", { headers: auth1 });
    const g = await get.json();
    check("GET state отдаёт то же", Object.keys(g.state.visited).length, 2);

    const other = await call(env, "https://api.example.com/api/state", { headers: auth2 });
    check("у другого пусто", Object.keys((await other.json()).state.visited).length, 0);
  }

  console.log("\n4. санитайзер");
  {
    const fresh = newEnv();
    const evil = await call(fresh.env, "https://api.example.com/api/state", {
      method: "POST",
      headers: { ...auth1, "Content-Type": "application/json" },
      body: JSON.stringify({
        state: {
          visited: { "__proto__": 1, "constructor": 1, "prototype": 1, "ok-place": 1, "bad key!": 1 },
          correct: "not-an-object",
          badges: null,
        },
      }),
    });
    const body = await evil.json();
    check("прототип не записан", Object.getPrototypeOf(body.state.visited) === Object.prototype, true);
    check("__proto__ не стал свойством", Object.getOwnPropertyNames(body.state.visited).includes("__proto__"), false);
    check("constructor отброшен", Object.getOwnPropertyNames(body.state.visited).includes("constructor"), false);
    check("prototype отброшен", Object.getOwnPropertyNames(body.state.visited).includes("prototype"), false);
    check("валидный id оставлен", body.state.visited["ok-place"], 1);
    check("мусорный ключ отброшен", body.state.visited["bad key!"], undefined);
    check("correct не-объект -> пусто", Object.keys(body.state.correct).length, 0);
    check("badges не-объект -> пусто", Object.keys(body.state.badges).length, 0);

    // Заведомо опасный payload не должен ломать последующие операции
    const follow = await call(fresh.env, "https://api.example.com/api/state", {
      method: "POST",
      headers: { ...auth1, "Content-Type": "application/json" },
      body: JSON.stringify({ state: { visited: { "tank-t34-grodno": 1 } } }),
    });
    const f = (await follow.json()).state;
    check("после payload visited цел", f.visited["tank-t34-grodno"], 1);
    check("после payload прототип чист", Object.getPrototypeOf(f.visited) === Object.prototype, true);
  }

  console.log("\n5. прогресс не уменьшается");
  {
    await call(env, "https://api.example.com/api/state", {
      method: "POST",
      headers: { ...auth1, "Content-Type": "application/json" },
      body: JSON.stringify({ state: { visited: { "a-place": 1, "b-place": 1 } } }),
    });
    const shrink = await call(env, "https://api.example.com/api/state", {
      method: "POST",
      headers: { ...auth1, "Content-Type": "application/json" },
      body: JSON.stringify({ state: { visited: { "a-place": 1 } } }),
    });
    const s = (await shrink.json()).state;
    check("b-place не потерян", s.visited["b-place"], 1);
    check("a-place на месте", s.visited["a-place"], 1);
  }

  console.log("\n6. загрузка фото");
  let firstEntryId = null;
  {
    const mp = multipart("photo", "a.jpg", "image/jpeg", jpegBytes);
    const res = await call(env, "https://api.example.com/api/photos?placeId=tank-t34-grodno", {
      method: "POST",
      headers: { ...auth1, "Content-Type": mp.contentType },
      body: mp.body,
    });
    check("upload 201", res.status, 201);
    const body = await res.json();
    firstEntryId = body.entry.id;
    check("автор из профиля", body.entry.author, "Иван Петров");
    check("поле placeId", body.entry.placeId, "tank-t34-grodno");
    check("объект в KV", BLOBS.store.has(body.entry.objectKey), true);
    check("размер сохранён", body.entry.size, jpegBytes.length);

    const badPlace = await call(env, "https://api.example.com/api/photos?placeId=bad%20place", {
      method: "POST",
      headers: { ...auth1, "Content-Type": mp.contentType },
      body: mp.body,
    });
    check("кривой placeId 400", badPlace.status, 400);

    const badType = multipart("photo", "a.gif", "image/gif", jpegBytes);
    const res2 = await call(env, "https://api.example.com/api/photos?placeId=tank-t34-grodno", {
      method: "POST",
      headers: { ...auth1, "Content-Type": badType.contentType },
      body: badType.body,
    });
    check("gif отклонён", res2.status, 415);

    const big = new Uint8Array(4 * 1024 * 1024);
    const mpBig = multipart("photo", "big.jpg", "image/jpeg", big);
    const res3 = await call(env, "https://api.example.com/api/photos?placeId=tank-t34-grodno", {
      method: "POST",
      headers: { ...auth1, "Content-Type": mpBig.contentType },
      body: mpBig.body,
    });
    check("4 МБ отклонено", res3.status, 413);
  }

  console.log("\n7. галерея");
  {
    const mp = multipart("photo", "b.png", "image/png", jpegBytes);
    await call(env, "https://api.example.com/api/photos?placeId=memorial-lida", {
      method: "POST",
      headers: { ...auth2, "Content-Type": mp.contentType },
      body: mp.body,
    });

    const all = await call(env, "https://api.example.com/api/gallery", { headers: auth1 });
    const body = await all.json();
    check("в галерее 2 фото", body.entries.length, 2);
    check("своё удаляемое", body.canDelete.length, 1);
    check("чужое не удаляемое", body.canDelete[0], firstEntryId);

    const byPlace = await call(env, "https://api.example.com/api/gallery?placeId=memorial-lida", { headers: auth1 });
    const bp = await byPlace.json();
    check("фильтр по месту", bp.entries.length, 1);
    check("в фильтре чужое фото", bp.entries[0].id, "memorial-lida_77");

    // Автор не показывается в приложении, поэтому наружу он не отдаётся.
    const serialized = JSON.stringify(body);
    check("в галерее нет author", serialized.indexOf("author"), -1);
    check("в галерее нет username", serialized.indexOf("username"), -1);
    check("в галерее нет userId", serialized.indexOf("userId"), -1);
    check("в галерее нет objectKey", serialized.indexOf("objectKey"), -1);
    check("в галерее нет имени автора", serialized.indexOf("Иван Петров"), -1);
    check("в галерее есть id записи", Boolean(bp.entries[0].id), true);
    check("в галерее есть contentType", Boolean(bp.entries[0].contentType), true);

    const noAuth = await call(env, "https://api.example.com/api/gallery");
    check("галерея без auth 401", noAuth.status, 401);
  }

  console.log("\n8. выдача и удаление фото");
  {
    const get = await call(env, "https://api.example.com/api/photos/" + firstEntryId, { headers: auth1 });
    check("фото отдаётся", get.status, 200);
    check("Content-Type", get.headers.get("Content-Type"), "image/jpeg");

    const delOther = await call(env, "https://api.example.com/api/photos/" + firstEntryId, {
      method: "DELETE",
      headers: auth2,
    });
    check("чужое фото не удалить", delOther.status, 403);

    const before = BLOBS.store.size;
    const del = await call(env, "https://api.example.com/api/photos/" + firstEntryId, {
      method: "DELETE",
      headers: auth1,
    });
    check("своё удалилось", del.status, 200);
    check("объект убран из KV", BLOBS.store.size, before - 1);

    const after = await call(env, "https://api.example.com/api/gallery", { headers: auth1 });
    check("в галерее осталось 1", (await after.json()).entries.length, 1);

    const again = await call(env, "https://api.example.com/api/photos/" + firstEntryId, {
      method: "DELETE",
      headers: auth1,
    });
    check("повторное удаление 404", again.status, 404);
  }

  console.log("\n9. ownPhotos чистится при удалении");
  {
    const st = (await (await call(env, "https://api.example.com/api/state", { headers: auth1 })).json()).state;
    check("ссылка на фото убрана", st.ownPhotos["tank-t34-grodno"], undefined);
  }

  console.log("\n9b. ownPhotos выводится из индекса, клиент его не переписывает");
  {
    const { env: env3 } = newEnv();
    const mp = multipart("photo", "own.jpg", "image/jpeg", jpegBytes);
    await call(env3, "https://api.example.com/api/photos?placeId=memorial-lida", {
      method: "POST",
      headers: { ...auth1, "Content-Type": mp.contentType },
      body: mp.body,
    });

    const afterUpload = (await (await call(env3, "https://api.example.com/api/state", { headers: auth1 })).json()).state;
    check("после загрузки место видно", Boolean(afterUpload.ownPhotos["memorial-lida"]), true);

    // Клиент с пустой картой ownPhotos не должен стереть привязку.
    await call(env3, "https://api.example.com/api/state", {
      method: "POST",
      headers: { ...auth1, "Content-Type": "application/json" },
      body: JSON.stringify({ state: { visited: { "a-place": 1 }, ownPhotos: {} } }),
    });
    const afterPush = (await (await call(env3, "https://api.example.com/api/state", { headers: auth1 })).json()).state;
    check("привязка пережила пустой push", Boolean(afterPush.ownPhotos["memorial-lida"]), true);
    check("прогресс при этом сохранился", afterPush.visited["a-place"], 1);

    // Подделка чужого id в ownPhotos тоже игнорируется: карта собирается
    // сервером из индекса, а не берётся из тела запроса.
    await call(env3, "https://api.example.com/api/state", {
      method: "POST",
      headers: { ...auth1, "Content-Type": "application/json" },
      body: JSON.stringify({ state: { ownPhotos: { "tank-t34-grodno": "tank-t34-grodno_999" } } }),
    });
    const afterForge = (await (await call(env3, "https://api.example.com/api/state", { headers: auth1 })).json()).state;
    check("чужое место не появилось", afterForge.ownPhotos["tank-t34-grodno"], undefined);
    check("своё место на месте", Boolean(afterForge.ownPhotos["memorial-lida"]), true);

    // У чужого пользователя этой фотографии нет.
    const asOther = (await (await call(env3, "https://api.example.com/api/state", { headers: auth2 })).json()).state;
    check("у другого ownPhotos пуст", Object.keys(asOther.ownPhotos).length, 0);
  }

  console.log("\n10. одно фото на место: повтор заменяет");
  {
    const { env: env2, BLOBS: blobs } = newEnv();
    const mp1 = multipart("photo", "a.jpg", "image/jpeg", jpegBytes);
    const first = await call(env2, "https://api.example.com/api/photos?placeId=tank-t34-grodno", {
      method: "POST",
      headers: { ...auth1, "Content-Type": mp1.contentType },
      body: mp1.body,
    });
    check("первая загрузка 201", first.status, 201);
    const firstBody = await first.json();
    const firstEntry = firstBody.entry;
    check("replaced=false при первом", firstBody.replaced, false);

    // Вторая загрузка того же места тем же пользователем: замена, не дубль.
    const mp2 = multipart("photo", "b.jpg", "image/jpeg", jpegBytes);
    const second = await call(env2, "https://api.example.com/api/photos?placeId=tank-t34-grodno", {
      method: "POST",
      headers: { ...auth1, "Content-Type": mp2.contentType },
      body: mp2.body,
    });
    const secondBody = await second.json();
    check("повтор 201", second.status, 201);
    check("replaced=true", secondBody.replaced, true);
    check("id стабильный", secondBody.entry.id, firstEntry.id);
    check("в галерее одна запись", secondBody.total, 1);
    check("объектов в KV один", blobs.store.size, 1);
  }

  console.log("\n10b. смена расширения чистит старый объект");
  {
    const { env: env2, BLOBS: blobs } = newEnv();
    const mp1 = multipart("photo", "a.jpg", "image/jpeg", jpegBytes);
    const first = await call(env2, "https://api.example.com/api/photos?placeId=memorial-lida", {
      method: "POST",
      headers: { ...auth1, "Content-Type": mp1.contentType },
      body: mp1.body,
    });
    const oldKey = (await first.json()).entry.objectKey;

    const mp2 = multipart("photo", "a.png", "image/png", jpegBytes);
    await call(env2, "https://api.example.com/api/photos?placeId=memorial-lida", {
      method: "POST",
      headers: { ...auth1, "Content-Type": mp2.contentType },
      body: mp2.body,
    });
    check("старый объект удалён", blobs.store.has(oldKey), false);
    check("новый объект на месте", blobs.store.size, 1);
  }

  console.log("\n10c. разные пользователи на одном месте — разные записи");
  {
    const { env: env2 } = newEnv();
    for (const auth of [auth1, auth2]) {
      const mp = multipart("photo", "x.jpg", "image/jpeg", jpegBytes);
      await call(env2, "https://api.example.com/api/photos?placeId=tank-t34-grodno", {
        method: "POST",
        headers: { ...auth, "Content-Type": mp.contentType },
        body: mp.body,
      });
    }
    const g = await call(env2, "https://api.example.com/api/gallery", { headers: auth1 });
    check("две записи на место", (await g.json()).entries.length, 2);
  }

  console.log("\n10d. переполнение галереи");
  {
    const { env: env2 } = newEnv();
    for (let i = 0; i < 400; i += 1) {
      const mp = multipart("photo", "x.jpg", "image/jpeg", jpegBytes);
      await call(env2, `https://api.example.com/api/photos?placeId=place-${i}`, {
        method: "POST",
        headers: { ...auth1, "Content-Type": mp.contentType },
        body: mp.body,
      });
    }
    const mp = multipart("photo", "overflow.jpg", "image/jpeg", jpegBytes);
    const over = await call(env2, "https://api.example.com/api/photos?placeId=place-overflow", {
      method: "POST",
      headers: { ...auth1, "Content-Type": mp.contentType },
      body: mp.body,
    });
    check("401-е фото отклонено", over.status, 503);
    check("причина", (await over.json()).error, "gallery_full");

    // Замена существующего фото при полной галерее всё ещё разрешена.
    const replace = await call(env2, "https://api.example.com/api/photos?placeId=place-0", {
      method: "POST",
      headers: { ...auth1, "Content-Type": mp.contentType },
      body: mp.body,
    });
    check("замена при полной галерее разрешена", replace.status, 201);

    // Без параметра limit клиент должен получить весь индекс: постраничный
    // обход на телефоне дороже одного ответа.
    const all = await call(env2, "https://api.example.com/api/gallery", { headers: auth1 });
    const allBody = await all.json();
    check("галерея отдаёт весь индекс без limit", allBody.entries.length, 400);
    check("total совпадает с числом записей", allBody.total, 400);

    // Явный limit меньше индекса режет ответ, но total остаётся полным.
    const cut = await call(env2, "https://api.example.com/api/gallery?limit=10", { headers: auth1 });
    const cutBody = await cut.json();
    check("limit режет выдачу", cutBody.entries.length, 10);
    check("total остаётся полным", cutBody.total, 400);
  }

  console.log("\n11. CORS");
  {
    const res = await call(env, "https://api.example.com/api/state", {
      headers: { ...auth1, Origin: "https://mariamaretskaia-commits.github.io" },
    });
    check("свой Origin отдаётся", res.headers.get("Access-Control-Allow-Origin"), "https://mariamaretskaia-commits.github.io");

    // Чужому Origin заголовок не выдаётся вовсе: браузер заблокирует ответ.
    const res2 = await call(env, "https://api.example.com/api/state", {
      headers: { ...auth1, Origin: "https://evil.example" },
    });
    check("чужой Origin не отдаётся", res2.headers.get("Access-Control-Allow-Origin"), null);
    check("у чужого Origin нет Vary", res2.headers.get("Vary"), null);

    const pre = await call(env, "https://api.example.com/api/state", { method: "OPTIONS" });
    check("OPTIONS 204", pre.status, 204);
  }

  console.log("\n12. прочее");
  {
    const nf = await call(env, "https://api.example.com/api/unknown", { headers: auth1 });
    check("неизвестный маршрут 404", nf.status, 404);

    const wrong = await call(env, "https://api.example.com/api/state", {
      method: "PUT",
      headers: auth1,
    });
    check("PUT 405", wrong.status, 405);

    const emptyKv = newEnv();
    const g = await call(emptyKv.env, "https://api.example.com/api/state", { headers: auth1 });
    const body = await g.json();
    check("пустое состояние корректно", body.state.version, 1);
    check("нет токена в ответе state", JSON.stringify(body).includes(BOT_TOKEN), false);
  }

  console.log("\n13. секрет не утёк");
  {
    const stateDump = JSON.stringify(Array.from(STATE.store.entries()));
    check("токена нет в KV", stateDump.includes(BOT_TOKEN), false);
    const res = await call(env, "https://api.example.com/api/state", { headers: auth1 });
    check("токена нет в ответе", (await res.text()).includes(BOT_TOKEN), false);
  }

  console.log("\n14. сброс прогресса");
  {
    const { env: env2 } = newEnv();
    await call(env2, "https://api.example.com/api/state", {
      method: "POST",
      headers: { ...auth1, "Content-Type": "application/json" },
      body: JSON.stringify({ state: { visited: { "a-place": 1, "b-place": 1 }, correct: { q1: 1 } } }),
    });

    const reset = await call(env2, "https://api.example.com/api/state", {
      method: "POST",
      headers: { ...auth1, "Content-Type": "application/json" },
      body: JSON.stringify({ reset: true }),
    });
    check("reset 200", reset.status, 200);
    const rb = await reset.json();
    check("reset помечен", rb.reset, true);
    check("visited очищен", Object.keys(rb.state.visited).length, 0);
    check("correct очищен", Object.keys(rb.state.correct).length, 0);

    const after = await call(env2, "https://api.example.com/api/state", { headers: auth1 });
    check("сброс сохранён на сервере", Object.keys((await after.json()).state.visited).length, 0);

    // Чужой сброс не должен влиять на другие аккаунты.
    await call(env2, "https://api.example.com/api/state", {
      method: "POST",
      headers: { ...auth2, "Content-Type": "application/json" },
      body: JSON.stringify({ state: { visited: { "c-place": 1 } } }),
    });
    await call(env2, "https://api.example.com/api/state", {
      method: "POST",
      headers: { ...auth1, "Content-Type": "application/json" },
      body: JSON.stringify({ reset: true }),
    });
    const other = await call(env2, "https://api.example.com/api/state", { headers: auth2 });
    check("сброс одного не тронул другого", (await other.json()).state.visited["c-place"], 1);
  }

  console.log("\n15. кэш персонализированной галереи");
  {
    const res = await call(env, "https://api.example.com/api/gallery", { headers: auth1 });
    const cc = res.headers.get("Cache-Control") || "";
    check("галерея не public", cc.includes("public"), false);
    check("галерея private/no-store", cc.includes("no-store") || cc.includes("private"), true);

    const img = await call(env, "https://api.example.com/api/gallery", {
      headers: { ...auth1, Origin: "https://mariamaretskaia-commits.github.io" },
    });
    check("Vary: Origin выставлен", img.headers.get("Vary"), "Origin");
  }

  console.log("\n16. лимит состояния считается в байтах");
  {
    const { env: env2 } = newEnv();
    const visited = {};
    for (let i = 0; i < 3000; i += 1) visited[`place-with-long-name-${i}`] = 1;
    const res = await call(env2, "https://api.example.com/api/state", {
      method: "POST",
      headers: { ...auth1, "Content-Type": "application/json" },
      body: JSON.stringify({ state: { visited } }),
    });
    check("огромное состояние отклонено", res.status, 413);
    check("причина", (await res.json()).error, "state_too_large");
  }

  console.log("\n17. длинные идентификаторы не теряются в индексе");
  {
    const { env: env2, INDEX: idx } = newEnv();
    // placeId ровно 64 символа: составной id записи длиннее, чем placeId,
    // и раньше отбрасывался проверкой isSafeId с лимитом 64.
    const longPlace = "p".repeat(64);
    const mp = multipart("photo", "a.jpg", "image/jpeg", jpegBytes);
    const up = await call(env2, "https://api.example.com/api/photos?placeId=" + longPlace, {
      method: "POST",
      headers: { ...auth1, "Content-Type": mp.contentType },
      body: mp.body,
    });
    check("длинный placeId принят", up.status, 201);

    const g = await call(env2, "https://api.example.com/api/gallery", { headers: auth1 });
    const entries = (await g.json()).entries;
    check("запись видна в галерее", entries.length, 1);
    check("placeId не потерян", entries[0].placeId, longPlace);

    // Индекс на диске тоже должен пережить повторное чтение.
    const raw = JSON.parse(idx.store.get("photos:index"));
    check("индекс на диске цел", raw.entries.length, 1);

    const del = await call(env2, "https://api.example.com/api/photos/" + entries[0].id, {
      method: "DELETE",
      headers: auth1,
    });
    check("удаление по длинному id работает", del.status, 200);
  }

  console.log("\n18. мусорный hash отклоняется");
  {
    for (const badHash of ["zzzz", "", "0".repeat(64), "not-hex-at-all-".repeat(4)]) {
      const raw = "auth_date=" + Math.floor(Date.now() / 1000) + "&user=%7B%22id%22%3A1%7D&hash=" + encodeURIComponent(badHash);
      const res = await call(env, "https://api.example.com/api/state", {
        headers: { "X-Telegram-Init-Data": raw },
      });
      check("hash=" + JSON.stringify(badHash).slice(0, 20) + " -> отказ", res.status === 401 || res.status === 403, true);
    }
  }

  console.log("\n19. неверная конфигурация отказывает, а не пропускает");
  {
    // Воркер без секрета: HMAC считался бы от строки "undefined",
    // и такой воркер принял бы initData, подписанный этой строкой.
    const { env: noToken, STATE: st } = newEnv();
    delete noToken.BOT_TOKEN;

    const forged = signInitData(user(1), {}, "undefined");
    const res = await call(noToken, "https://api.example.com/api/state", {
      headers: { "X-Telegram-Init-Data": forged },
    });
    check("без BOT_TOKEN -> 503", res.status, 503);
    check("причина", (await res.json()).error, "server_misconfigured");
    check("в KV ничего не записано", st.store.size, 0);

    // Даже валидный initData не проходит без секрета.
    const res2 = await call(noToken, "https://api.example.com/api/state", {
      headers: { "X-Telegram-Init-Data": signInitData(user(1)) },
    });
    check("валидный initData без секрета -> 503", res2.status, 503);

    // health честно сообщает, что секрета нет.
    const health = await call(noToken, "https://api.example.com/api/health");
    check("health: hasBotToken=false", (await health.json()).hasBotToken, false);
  }

  console.log("\n20. без ALLOWED_ORIGIN CORS закрыт");
  {
    const { env: noOrigin } = newEnv();
    delete noOrigin.ALLOWED_ORIGIN;
    const res = await call(noOrigin, "https://api.example.com/api/state", {
      headers: { ...auth1, Origin: "https://evil.example" },
    });
    // Ответ не должен содержать Access-Control-Allow-Origin вовсе.
    check("Origin не выдан", res.headers.get("Access-Control-Allow-Origin"), null);
    check("но данные внутри ответа есть", (await res.json()).ok, true);
  }

  console.log("\n21. байты фото не искажаются");
  {
    // Набор байтов, который ломается при небрежном хранении в строке:
    // нули, 0xFF и последовательности, похожие на начало UTF-8-символа.
    const tricky = new Uint8Array(512);
    for (let i = 0; i < tricky.length; i += 1) {
      tricky[i] = [0x00, 0xff, 0xc3, 0x28, 0xe0, 0x80, 0x80, 0xfe, 0x7f, 0x0a, 0x0d, 0x1b][i % 12];
    }

    const mp = multipart("photo", "t.jpg", "image/jpeg", tricky);
    const up = await call(env, "https://api.example.com/api/photos?placeId=memorial-smorgon", {
      method: "POST",
      headers: { ...auth1, "Content-Type": mp.contentType },
      body: mp.body,
    });
    check("фото с непечатными байтами принято", up.status, 201);

    const entry = (await up.json()).entry;
    const down = await call(env, "https://api.example.com/api/photos/" + entry.id, { headers: auth1 });
    check("скачано", down.status, 200);

    const received = new Uint8Array(await down.arrayBuffer());
    check("длина совпала", received.length, tricky.length);

    let firstDiff = -1;
    for (let i = 0; i < tricky.length; i += 1) {
      if (received[i] !== tricky[i]) { firstDiff = i; break; }
    }
    check("байты совпали полностью", firstDiff, -1);

    // Повторная загрузка и удаление тоже не должны ломать байты.
    await call(env, "https://api.example.com/api/photos/" + entry.id, {
      method: "DELETE",
      headers: auth1,
    });
    const gone = await call(env, "https://api/photos/" + entry.id, { headers: auth1 });
    check("после удаления 404", gone.status, 404);
  }

  console.log("\n" + "-".repeat(46));
  if (failures.length) {
    console.log("ПРОВАЛЕНО " + failures.length + " из " + checks + ": " + failures.join("; "));
    process.exitCode = 1;
  } else {
    console.log("Итог: " + checks + " из " + checks);
  }
}

main().catch((error) => {
  console.error("Авария тестов:", error);
  process.exitCode = 1;
});
