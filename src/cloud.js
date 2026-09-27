// Синхронизация с сервером.
//
// Модуль сознательно ничего не знает про очки, значки и разметку: он умеет
// читать и писать состояние, галерею и байты фотографий, а решение о том,
// когда и что показывать, принимает приложение через переданные обработчики.
//
// Ключевые свойства:
//   * initData передаётся только в заголовке и никогда не пишется в localStorage;
//   * прогресс монотонен, поэтому локальное и серверное состояния объединяются
//     как объединение, а не перетирают друг друга;
//   * неудачные записи не теряются: состояние помечается грязным и уходит
//     повторно при появлении сети и по таймеру;
//   * без Telegram initData модуль полностью выключается и не мешает работе.

(function (global) {
  "use strict";

  // Адрес API задаётся здесь и может быть переопределён через
  // window.CLOUD_API_BASE до загрузки модуля — это нужно автотестам и
  // локальному стенду. На безопасность не влияет: подпись initData в
  // любом случае проверяется на сервере токеном бота.
  var API_BASE = global.CLOUD_API_BASE ||
    "https://patriot-grodno-api.patriot-grodno.workers.dev";
  var SAVE_DEBOUNCE_MS = 30000;
  var RETRY_MS = 60000;
  var REQUEST_TIMEOUT_MS = 20000;
  // Один пользователь не может иметь больше фото, чем мест в приложении,
  // но запас нужен на случай расширения каталога.
  var MAX_OWN_PHOTOS = 40;
  // Верхняя граница выборки галереи совпадает с лимитом фото на сервере:
  // список метаданных небольшой, а постраничные запросы на мобильном
  // интернете обходятся дороже одного полного ответа.
  var GALLERY_FETCH_LIMIT = 400;

  function initData() {
    try {
      var api = global.Telegram && global.Telegram.WebApp;
      return (api && api.initData) || "";
    } catch (err) {
      return "";
    }
  }

  // Синхронизация включается только в Telegram: вне его нет initData,
  // подписанного токеном бота, и сервер всё равно откажет в каждом запросе.
  function isEnabled() {
    return Boolean(initData());
  }

  function url(path) {
    return API_BASE + path;
  }

  function request(path, options) {
    var settings = options || {};
    var headers = { "X-Telegram-Init-Data": initData() };
    if (settings.json !== undefined) {
      headers["Content-Type"] = "application/json";
      settings.body = JSON.stringify(settings.json);
    }
    if (settings.headers) {
      Object.keys(settings.headers).forEach(function (key) { headers[key] = settings.headers[key]; });
    }

    // Таймаут обязателен: в Telegram «висящий» fetch оставляет кнопки
    // заблокированными, и пользователь не понимает, что происходит.
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, REQUEST_TIMEOUT_MS);

    return fetch(url(path), {
      method: settings.method || "GET",
      headers: headers,
      body: settings.body,
      signal: controller ? controller.signal : undefined,
      cache: "no-store",
      // keepalive позволяет запросу пережить закрытие страницы: без него
      // последние очки, отмеченные перед уходом из Telegram, могли бы
      // не дойти до сервера.
      keepalive: Boolean(settings.keepalive),
    }).then(function (response) {
      clearTimeout(timer);
      if (!response.ok) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          var error = new Error(body.error || ("HTTP " + response.status));
          error.status = response.status;
          error.code = body.error;
          throw error;
        });
      }
      return response;
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function readJson(response) {
    return response.json().catch(function () { return {}; });
  }

  // --- Очередь отправки -------------------------------------------------
  //
  // Одно поле dirty вместо очереди запросов: состояние монотонно, поэтому
  // достаточно отправить последнюю версию, а не историю изменений.

  var queue = {
    dirty: false,
    saving: false,
    // Счётчик правок: он позволяет отличить «состояние не менялось во
    // время отправки» от «менялось» и не потерять последние изменения.
    rev: 0,
    timer: null,
    retryTimer: null,
    getState: null,
    onSynced: null,
    onStatus: null,
    lastError: null,
  };

  function setStatus(state, detail) {
    if (queue.onStatus) queue.onStatus(state, detail);
  }

  function payload() {
    if (!queue.getState) return null;
    var snapshot = queue.getState();
    if (!snapshot) return null;
    // Явный белый список, а не разбор всего state: так в сеть нельзя
    // случайно утащить приватные поля. В частности, avatar (аватарка,
    // выбранная пользователем) сюда не входит намеренно — она хранится
    // только на устройстве и не должна быть видна никому, включая
    // владельца на другом телефоне.
    return {
      state: {
        visited: snapshot.visited || {},
        correct: snapshot.correct || {},
        badges: snapshot.badges || {},
      },
    };
  }

  function clearTimers() {
    if (queue.timer) { clearTimeout(queue.timer); queue.timer = null; }
    if (queue.retryTimer) { clearTimeout(queue.retryTimer); queue.retryTimer = null; }
  }

  function scheduleRetry() {
    if (queue.retryTimer || !queue.dirty) return;
    queue.retryTimer = setTimeout(function () {
      queue.retryTimer = null;
      flush();
    }, RETRY_MS);
  }

  function flush(keepalive) {
    if (!isEnabled() || !queue.dirty || queue.saving) return Promise.resolve();
    var body = payload();
    if (!body) return Promise.resolve();

    var revAtStart = queue.rev;
    queue.saving = true;
    setStatus("sync");

    return request("/api/state", { method: "POST", json: body, keepalive: Boolean(keepalive) })
      .then(readJson)
      .then(function (data) {
        queue.saving = false;
        queue.lastError = null;
        if (queue.retryTimer) { clearTimeout(queue.retryTimer); queue.retryTimer = null; }
        setStatus("ok");
        if (queue.onSynced && data.state) queue.onSynced(data.state);
        if (queue.rev === revAtStart) {
          // Во время отправки ничего не меняли — очередь чиста.
          queue.dirty = false;
        } else {
          // Прогресс изменился, пока летел запрос: снимок устарел, и
          // последние правки нужно отправить следом. Иначе они ждали бы
          // следующего изменения или сетевой ошибки.
          markDirty(true);
        }
        return data;
      })
      .catch(function (err) {
        queue.saving = false;
        queue.lastError = err;
        // Грязный флаг сохраняется: прогресс не потеряется и уйдёт позже.
        setStatus("error", err);
        scheduleRetry();
        return null;
      });
  }

  // Пометить состояние как несохранённое и запланировать отправку.
  function markDirty(immediate) {
    if (!isEnabled()) return;
    queue.dirty = true;
    queue.rev += 1;
    if (queue.timer) clearTimeout(queue.timer);
    if (immediate) {
      queue.timer = setTimeout(function () { queue.timer = null; flush(); }, 0);
      return;
    }
    queue.timer = setTimeout(function () { queue.timer = null; flush(); }, SAVE_DEBOUNCE_MS);
  }

  function isPending() {
    return queue.dirty || queue.saving;
  }

  // --- Приём состояния --------------------------------------------------

  // Локальное и серверное объединяются как объединение: прогресс не уменьшается,
  // поэтому слияние безопасно в обе стороны и не теряет очки на разных устройствах.
  function mergeMaps(into, from) {
    var out = {};
    var key;
    for (key in into) {
      if (Object.prototype.hasOwnProperty.call(into, key) && into[key]) out[key] = into[key];
    }
    for (key in from) {
      if (Object.prototype.hasOwnProperty.call(from, key) && from[key]) out[key] = from[key];
    }
    return out;
  }

  function start(options) {
    var settings = options || {};
    queue.getState = settings.getState || null;
    queue.onSynced = settings.onSynced || null;
    queue.onStatus = settings.onStatus || null;

    if (!isEnabled()) {
      setStatus("off");
      return Promise.resolve(null);
    }

    // Возврат в сеть — повод немедленно отдать накопленное.
    global.addEventListener("online", function () {
      if (queue.dirty) markDirty(true);
    });
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", function () {
        if (document.hidden) {
          // Уход в фон: отправляем с keepalive, чтобы запрос пережил
          // закрытие Mini App.
          if (queue.dirty) flush(true);
          return;
        }
        // Уход из фона на мобильных часто означает смену сети.
        if (queue.dirty) markDirty(true);
      });
    }
    global.addEventListener("pagehide", function () {
      if (queue.dirty) flush(true);
    });

    return request("/api/state", { method: "GET" })
      .then(readJson)
      .then(function (data) {
        setStatus("ok");
        if (queue.onSynced && data.state) queue.onSynced(data.state);
        return data.state || null;
      })
      .catch(function (err) {
        // Нет сети или сервер недоступен — приложение продолжает работать
        // на локальных данных, это штатная ситуация, а не поломка.
        setStatus("error", err);
        return null;
      });
  }

  // --- Сброс ------------------------------------------------------------

  function reset() {
    clearTimers();
    queue.dirty = false;
    // Сброс — это изменение состояния: счётчик правок двигается, чтобы
    // в-flight запрос не счёл его устаревшим снимком.
    queue.rev += 1;
    if (!isEnabled()) return Promise.resolve(null);
    return request("/api/state", { method: "POST", json: { reset: true } })
      .then(readJson)
      .then(function (data) {
        setStatus("ok");
        return data.state || null;
      })
      .catch(function (err) {
        setStatus("error", err);
        return null;
      });
  }

  // --- Галерея и фотографии --------------------------------------------

  // Сервер хранит не больше MAX_PHOTOS снимков на всех, поэтому список
  // метаданных запрашивается целиком: постраничный обмен с сервером на
  // телефоне дороже, чем один ответ. Показ порциями — уже на клиенте.
  function gallery(placeId) {
    if (!isEnabled()) return Promise.resolve(null);
    var path = "/api/gallery?limit=" + GALLERY_FETCH_LIMIT +
      (placeId ? "&placeId=" + encodeURIComponent(placeId) : "");
    return request(path, { method: "GET" }).then(readJson).catch(function (err) {
      setStatus("error", err);
      return null;
    });
  }

  function uploadPhoto(placeId, blob, caption) {
    if (!isEnabled()) return Promise.resolve(null);
    var form = new FormData();
    form.append("photo", blob, "photo.jpg");
    var path = "/api/photos?placeId=" + encodeURIComponent(placeId);
    if (caption) path += "&caption=" + encodeURIComponent(caption);
    return request(path, { method: "POST", body: form }).then(readJson).then(function (data) {
      setStatus("ok");
      return data.entry || null;
    });
  }

  function deletePhoto(entryId) {
    if (!isEnabled()) return Promise.resolve(true);
    return request("/api/photos/" + encodeURIComponent(entryId), { method: "DELETE" })
      .then(readJson)
      .then(function () { setStatus("ok"); return true; })
      .catch(function (err) {
        setStatus("error", err);
        return false;
      });
  }

  // Байты фотографии: обычный <img src> не годится, потому что запрос
  // требует заголовок с initData. Файл скачивается и показывается через
  // object URL.
  function fetchPhoto(entryId) {
    if (!isEnabled()) return Promise.resolve(null);
    return request("/api/photos/" + encodeURIComponent(entryId), { method: "GET" })
      .then(function (response) { return response.blob(); })
      .catch(function () { return null; });
  }

  // Восстановление своих фотографий на новом устройстве. Файлы скачиваются
  // по одному и только те, которых ещё нет локально.
  function restorePhotos(ownPhotos, hasLocal, storeLocal) {
    if (!isEnabled()) return Promise.resolve(0);
    var queueList = Object.keys(ownPhotos || {}).slice(0, MAX_OWN_PHOTOS);
    var restored = 0;

    var step = function (index) {
      if (index >= queueList.length) return Promise.resolve(restored);
      var placeId = queueList[index];
      var entryId = ownPhotos[placeId];
      if (hasLocal(placeId)) return step(index + 1);
      return fetchPhoto(entryId).then(function (blob) {
        if (blob && blob.size) {
          return Promise.resolve(storeLocal(placeId, blob)).then(function () {
            restored += 1;
          }).catch(function () {});
        }
        return null;
      }).then(function () { return step(index + 1); });
    };

    return step(0);
  }

  global.Cloud = {
    API_BASE: API_BASE,
    isEnabled: isEnabled,
    start: start,
    reset: reset,
    markDirty: markDirty,
    flush: flush,
    isPending: isPending,
    gallery: gallery,
    uploadPhoto: uploadPhoto,
    deletePhoto: deletePhoto,
    fetchPhoto: fetchPhoto,
    restorePhotos: restorePhotos,
    mergeMaps: mergeMaps,
  };
})(window);
