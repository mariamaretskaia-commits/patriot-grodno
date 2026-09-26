(function () {
  "use strict";

  var STORAGE_KEY = "pg_state_v1";
  var BOT_USERNAME = "MemoryOfTheGrodnoRegion_bot";

  var POINTS = { visit: 10, quiz: 15, photo: 20 };
  var FORT_TYPE = "фортификация";

  var state = {
    visited: {},
    photos: {},
    correct: {},
    badges: {}
  };

  var places = [];
  var questions = [];
  var photos = {};
  var photoCredits = {};
  var map = null;
  var markers = {};
  var activeId = null;
  var quizOrder = [];
  var quizIndex = 0;
  var quizRound = 0;
  var quizRoundCorrect = 0;
  var tileFailures = 0;
  var photoInput = null;
  var homeScreenOffered = false;

  var el = {};

  function $(id) { return document.getElementById(id); }

  function cacheElements() {
    [
      "brandSub", "scoreValue", "progressText", "progressFill", "tabs",
      "view-map", "view-quiz", "view-passport", "filterDistrict", "filterType",
      "filterSearch", "filterReset", "map", "mapNote", "listCount", "placeList",
      "quizMeta", "quizScore", "quizFill", "quizCard", "quizQuestion",
      "quizOptions", "quizFeedback", "quizVerdict", "quizExplanation",
      "quizNext", "quizRestart", "quizFinish", "finishScore", "finishText",
      "finishRestart", "passportRank", "passportSub", "passportFill",
      "statVisited", "statQuiz", "statPhotos", "statBadges", "badges",
      "sources", "shareBtn", "resetProgress", "sheet", "sheetBackdrop",
      "sheetClose", "sheetBody", "toast", "sheetPanel"
    ].forEach(function (id) { el[id] = $(id); });
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      Object.keys(state).forEach(function (key) {
        if (saved[key] && typeof saved[key] === "object") state[key] = saved[key];
      });
    } catch (err) {
      storageAvailable = false;
    }
  }

  var storageAvailable = true;

  function saveState() {
    if (!storageAvailable) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      storageAvailable = false;
    }
  }

  function tg() {
    return (window.Telegram && window.Telegram.WebApp) || null;
  }

  function haptic(kind) {
    try {
      var api = tg();
      if (!api || !api.HapticFeedback) return;
      if (kind === "success" || kind === "error" || kind === "warning") {
        api.HapticFeedback.notificationOccurred(kind);
      } else {
        api.HapticFeedback.impactOccurred(kind || "light");
      }
    } catch (err) {}
  }

  function supportsVersion(api, version) {
    if (!api) return false;
    if (typeof api.isVersionAtLeast === "function") {
      try {
        return api.isVersionAtLeast(version);
      } catch (err) {
        return false;
      }
    }
    var current = parseFloat(api.version);
    return !isNaN(current) && current >= parseFloat(version);
  }

  function setBackButton(visible) {
    var api = tg();
    if (!api || !api.BackButton || !supportsVersion(api, "6.1")) return;
    try {
      if (visible) api.BackButton.show();
      else api.BackButton.hide();
    } catch (err) {}
  }

  function offerHomeScreen() {
    var api = tg();
    if (!api || homeScreenOffered) return;
    homeScreenOffered = true;
    if (typeof api.addToHomeScreen !== "function" || !supportsVersion(api, "6.1")) return;
    try {
      api.addToHomeScreen();
    } catch (err) {}
  }

  function updateNativeChrome() {
    var api = tg();
    if (!api || !supportsVersion(api, "6.1")) return;
    try {
      var params = api.themeParams || {};
      var header = params.header_bg_color || params.secondary_bg_color || params.bg_color;
      var background = params.bg_color || params.secondary_bg_color;
      if (header && typeof api.setHeaderColor === "function") api.setHeaderColor(header);
      if (background && typeof api.setBackgroundColor === "function") api.setBackgroundColor(background);
    } catch (err) {}
  }

  function updateSafeArea() {
    var api = tg();
    if (!api) return;
    try {
      var insets = api.contentSafeAreaInset || api.viewportSafeAreaInset;
      if (!insets) return;
      var root = document.documentElement.style;
      if (typeof insets.top === "number") root.setProperty("--tg-safe-top", insets.top + "px");
      if (typeof insets.bottom === "number") root.setProperty("--tg-safe-bottom", insets.bottom + "px");
      if (typeof insets.left === "number") root.setProperty("--tg-safe-left", insets.left + "px");
      if (typeof insets.right === "number") root.setProperty("--tg-safe-right", insets.right + "px");
    } catch (err) {}
  }

  function applyTelegramTheme() {
    var api = tg();
    if (!api) return;
    try {
      api.ready();
      api.expand();
      var params = api.themeParams || {};
      var root = document.documentElement.style;
      if (params.bg_color) root.setProperty("--tg-bg", params.bg_color);
      if (params.secondary_bg_color) root.setProperty("--tg-surface", params.secondary_bg_color);
      if (params.text_color) root.setProperty("--tg-text", params.text_color);
      if (params.hint_color) root.setProperty("--tg-muted", params.hint_color);
      if (params.button_color) root.setProperty("--tg-accent", params.button_color);
      if (params.link_color) root.setProperty("--tg-link", params.link_color);
      updateNativeChrome();
      updateSafeArea();
    } catch (err) {}
  }

  function initTelegram() {
    var api = tg();
    if (!api) return;
    applyTelegramTheme();
    try {
      if (api.initData && window.history && history.replaceState) {
        history.replaceState(null, "", location.pathname + location.search + location.hash);
      }
      if (typeof api.onEvent === "function" && supportsVersion(api, "6.1")) {
        api.onEvent("themeChanged", applyTelegramTheme);
        api.onEvent("viewportChanged", updateSafeArea);
      }
      if (api.BackButton && typeof api.BackButton.onClick === "function" && supportsVersion(api, "6.1")) {
        api.BackButton.onClick(closeSheet);
      }
      setBackButton(false);
    } catch (err) {}
  }

  function miniAppLink(placeId) {
    if (!BOT_USERNAME) return null;
    var base = "https://t.me/" + BOT_USERNAME;
    if (!placeId) return base + "?startapp";
    return base + "?startapp=" + encodeURIComponent(placeId);
  }

  function applyStartParam() {
    var api = tg();
    if (!api || !api.initData) return;
    var param = api.initDataUnsafe && api.initDataUnsafe.start_param;
    if (!param) return;
    if (placeById(param)) openPlace(param);
  }

  function toast(message, award) {
    if (!el.toast) return;
    el.toast.textContent = message;
    el.toast.classList.toggle("is-award", Boolean(award));
    el.toast.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { el.toast.hidden = true; }, 3200);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function placeById(id) {
    for (var i = 0; i < places.length; i += 1) if (places[i].id === id) return places[i];
    return null;
  }

  function visitedCount() {
    return Object.keys(state.visited).filter(function (id) { return state.visited[id]; }).length;
  }

  function correctCount() {
    return Object.keys(state.correct).filter(function (id) { return state.correct[id]; }).length;
  }

  function photoCount() {
    return Object.keys(state.photos).filter(function (id) { return state.photos[id]; }).length;
  }

  function points() {
    var total = visitedCount() * POINTS.visit;
    total += correctCount() * POINTS.quiz;
    total += photoCount() * POINTS.photo;
    return total;
  }

  function badgeDefs() {
    var forts = places.filter(function (place) { return place.type === FORT_TYPE; });
    return [
      {
        id: "first", icon: "🌱", name: "Первый шаг", hint: "Посетите 1 место",
        test: function () { return visitedCount() >= 1; }
      },
      {
        id: "forts", icon: "🏰", name: "Хранитель фортов", hint: "Посетите все форты (" + forts.length + ")",
        test: function () {
          return forts.length > 0 && forts.every(function (place) { return state.visited[place.id]; });
        }
      },
      {
        id: "quiz", icon: "🎓", name: "Знаток", hint: "15 верных ответов",
        test: function () { return correctCount() >= questions.length && questions.length > 0; }
      },
      {
        id: "patriot", icon: "🏅", name: "Патриот Гродненщины", hint: "500 очков",
        test: function () { return points() >= 500; }
      }
    ];
  }

  function checkBadges() {
    var earned = [];
    badgeDefs().forEach(function (badge) {
      if (!state.badges[badge.id] && badge.test()) {
        state.badges[badge.id] = true;
        earned.push(badge);
      }
    });
    if (!earned.length) return;
    saveState();
    haptic("success");
    earned.forEach(function (badge, index) {
      setTimeout(function () { toast("Значок: " + badge.name, true); }, index * 1400);
    });
  }

  function rankLabel(value) {
    if (value >= 600) return "Герой памяти";
    if (value >= 350) return "Патриот";
    if (value >= 150) return "Исследователь";
    if (value >= 50) return "Знаток мест";
    return "Начинающий";
  }

  function photoSrc(place) {
    return photos[place.id] || "";
  }

  function hasPhoto(place) {
    return Boolean(photos[place.id]);
  }

  function photoBlock(place) {
    if (hasPhoto(place)) {
      return '<img class="card-photo" data-fit="1" src="' + photoSrc(place) +
        '" alt="' + escapeHtml(place.title) + '">';
    }
    return '<div class="card-photo-fallback">Фото пока нет</div>';
  }

  function applyPhotoFit(img) {
    if (!img || img.dataset.fitDone) return;
    if (!img.naturalWidth) {
      img.addEventListener("load", function () { applyPhotoFit(img); }, { once: true });
      return;
    }
    img.dataset.fitDone = "1";
    if (img.naturalHeight > img.naturalWidth) img.classList.add("is-portrait");
  }

  function creditBlock(place) {
    var credit = photoCredits[place.id];
    if (!credit) return "";
    var parts = [];
    if (credit.author) parts.push("Автор: " + credit.author);
    if (credit.license) parts.push("Лицензия: " + credit.license);
    if (credit.date) parts.push("Дата: " + String(credit.date).slice(0, 10));
    return '<div class="card-credit">Фото: Wikimedia Commons, ' + escapeHtml(parts.join(" · ")) +
      ' · снимок уменьшен' +
      (credit.source_url ? ' · <a class="card-credit-link" data-url="' + escapeHtml(credit.source_url) + '" href="' + escapeHtml(credit.source_url) + '" target="_blank" rel="noopener noreferrer">источник</a>' : "") +
      (credit.license_url ? ' · <a class="card-credit-link" data-url="' + escapeHtml(credit.license_url) + '" href="' + escapeHtml(credit.license_url) + '" target="_blank" rel="noopener noreferrer">условия</a>' : "") +
      "</div>";
  }

  function fillFilters() {
    var districts = [];
    var types = [];
    places.forEach(function (place) {
      if (districts.indexOf(place.district) < 0) districts.push(place.district);
      if (types.indexOf(place.type) < 0) types.push(place.type);
    });
    districts.sort();
    types.sort();
    el.filterDistrict.innerHTML = '<option value="">Все районы</option>' +
      districts.map(function (v) { return '<option value="' + escapeHtml(v) + '">' + escapeHtml(v) + "</option>"; }).join("");
    el.filterType.innerHTML = '<option value="">Все типы</option>' +
      types.map(function (v) { return '<option value="' + escapeHtml(v) + '">' + escapeHtml(v) + "</option>"; }).join("");
  }

  function filteredPlaces() {
    var district = el.filterDistrict.value;
    var type = el.filterType.value;
    var query = (el.filterSearch.value || "").trim().toLowerCase();
    return places.filter(function (place) {
      if (district && place.district !== district) return false;
      if (type && place.type !== type) return false;
      if (query) {
        var haystack = (place.title + " " + place.short + " " + place.district + " " + place.full).toLowerCase();
        if (haystack.indexOf(query) < 0) return false;
      }
      return true;
    });
  }

  function renderList() {
    var visible = filteredPlaces();
    var ids = {};
    visible.forEach(function (place) { ids[place.id] = true; });

    el.listCount.textContent = visible.length + " из " + places.length;

    if (!visible.length) {
      el.placeList.innerHTML = '<li class="place-card" style="display:block;cursor:default;color:var(--tg-muted)">' +
        "Ничего не найдено. Измените фильтры или поисковый запрос.</li>";
      return;
    }

    el.placeList.innerHTML = visible.map(function (place) {
      var isVisited = Boolean(state.visited[place.id]);
      var thumb = hasPhoto(place)
        ? '<span class="place-thumb"><img src="' + photoSrc(place) + '" alt="" loading="lazy"></span>'
        : '<span class="place-thumb place-thumb-empty">' + escapeHtml((place.title || "★").slice(0, 1)) + "</span>";
      return '<li><button type="button" class="place-card' + (isVisited ? " is-visited" : "") +
        '" data-id="' + escapeHtml(place.id) + '">' +
        thumb +
        '<span class="place-main">' +
        '<span class="place-name">' + escapeHtml(place.title) + "</span>" +
        '<span class="place-meta">' + escapeHtml(place.district) + " · " + escapeHtml(place.period) + "</span>" +
        '<span class="place-address">' + escapeHtml(place.address || place.district) + "</span>" +
        "</span>" +
        '<span class="place-check">✓</span>' +
        "</button></li>";
    }).join("");

    Object.keys(markers).forEach(function (id) {
      var visibleMarker = Boolean(ids[id]);
      var container = markers[id].getElement();
      if (container) container.style.display = visibleMarker ? "" : "none";
    });
  }

  function markerIcon(place, active) {
    var classes = "marker-pin";
    if (state.visited[place.id]) classes += " is-visited";
    if (active) classes += " is-active";
    return L.divIcon({
      className: "",
      html: '<div class="' + classes + '"><span>★</span></div>',
      iconSize: [30, 30],
      iconAnchor: [15, 28],
      popupAnchor: [0, -26]
    });
  }

  function initMap() {
    if (typeof L === "undefined") return;
    map = L.map("map", { zoomControl: true, attributionControl: true })
      .setView([53.68, 23.83], 9);

    // Убираем логотип Leaflet (флаг) из атрибуции; ссылка на OpenStreetMap обязательна
    if (map.attributionControl) map.attributionControl.setPrefix(false);

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; <a href=\"https://www.openstreetmap.org/copyright\" target=\"_blank\" rel=\"noopener\">OpenStreetMap</a> contributors"
    }).on("tileerror", function () {
      tileFailures += 1;
      if (tileFailures > 2) el.mapNote.hidden = false;
    }).addTo(map);

    places.forEach(function (place) {
      var marker = L.marker(place.coords, {
        icon: markerIcon(place, false),
        title: place.title,
        keyboard: true
      }).addTo(map);
      marker.on("click", function () { openPlace(place.id); });
      markers[place.id] = marker;
    });

    var bounds = L.latLngBounds(places.map(function (place) { return place.coords; }));
    map.fitBounds(bounds.pad(0.25), { maxZoom: 11 });
  }

  function refreshMarker(id) {
    var place = placeById(id);
    if (!place || !markers[id]) return;
    markers[id].setIcon(markerIcon(place, id === activeId));
  }

  function openPlace(id) {
    var place = placeById(id);
    if (!place) return;
    activeId = id;
    if (map) {
      map.setView(place.coords, Math.max(map.getZoom(), 13), { animate: true });
    }
    renderSheet(place);
    el.sheet.hidden = false;
    document.body.style.overflow = "hidden";
    el.sheetPanel.scrollTop = 0;
    setBackButton(true);
    offerHomeScreen();
    Object.keys(markers).forEach(refreshMarker);
  }

  function closeSheet() {
    if (el.sheet.hidden) return;
    el.sheet.hidden = true;
    document.body.style.overflow = "";
    activeId = null;
    setBackButton(false);
    Object.keys(markers).forEach(refreshMarker);
  }

  function renderSheet(place) {
    var isVisited = Boolean(state.visited[place.id]);
    var tags = [
      '<span class="tag">' + escapeHtml(place.district) + "</span>",
      '<span class="tag">' + escapeHtml(place.type) + "</span>",
      '<span class="tag">' + escapeHtml(place.period) + "</span>"
    ].join("");

    var hasOwnPhoto = Boolean(state.photos[place.id]);
    var ownPhoto = hasOwnPhoto ? '<div class="photo-strip"><img id="ownPhoto" alt="Ваше фото"></div>' : "";
    var deletePhotoBtn = hasOwnPhoto ?
      '<button class="btn btn-danger" id="deletePhotoBtn" type="button">Удалить фото</button>' : "";

    el.sheetBody.innerHTML =
      photoBlock(place) +
      creditBlock(place) +
      '<div class="card-title" id="sheetTitle">' + escapeHtml(place.title) + "</div>" +
      '<div class="card-meta">' + escapeHtml(place.short) + "</div>" +
      '<div class="card-tags">' + tags + "</div>" +
      '<p class="card-full">' + escapeHtml(place.full) + "</p>" +
      '<div class="card-address">' + escapeHtml(place.address || place.district) + "</div>" +
      ownPhoto +
      '<div class="card-actions">' +
      '<button class="btn ' + (isVisited ? "btn-ghost" : "btn-primary") + '" id="visitBtn" type="button">' +
      (isVisited ? "✓ Вы здесь были" : "Я здесь — " + POINTS.visit + " очков") + "</button>" +
      '<div class="card-actions-row">' +
      '<button class="btn btn-ghost" id="photoBtn" type="button">' +
      (hasOwnPhoto ? "Заменить фото" : "Своё фото +" + POINTS.photo) + "</button>" +
      '<button class="btn btn-ghost" id="sharePlaceBtn" type="button">Поделиться</button>' +
      "</div>" +
      deletePhotoBtn +
      "</div>";

    var visitBtn = $("visitBtn");
    if (visitBtn) visitBtn.addEventListener("click", function () { markVisited(place.id); });
    var photoBtn = $("photoBtn");
    if (photoBtn) photoBtn.addEventListener("click", function () { openPhotoPicker(place.id); });
    var sharePlaceBtn = $("sharePlaceBtn");
    if (sharePlaceBtn) sharePlaceBtn.addEventListener("click", function () { sharePlace(place.id); });
    var deletePhotoBtn = $("deletePhotoBtn");
    if (deletePhotoBtn) deletePhotoBtn.addEventListener("click", function () { deletePhoto(place.id); });

    var own = $("ownPhoto");
    if (own) {
      loadPhoto(place.id).then(function (blob) {
        if (!blob) return;
        own.src = URL.createObjectURL(blob);
        applyPhotoFit(own);
      });
    }
    applyPhotoFit(el.sheetBody.querySelector(".card-photo[data-fit]"));
  }

  function markVisited(id) {
    if (state.visited[id]) {
      toast("Это место уже засчитано");
      return;
    }
    state.visited[id] = true;
    saveState();
    haptic("success");
    toast("+" + POINTS.visit + " очков. Место в паспорте", true);
    updateStats();
    renderList();
    refreshMarker(id);
    renderSheet(placeById(id));
    checkBadges();
  }

  function openPhotoPicker(id) {
    if (!photoInput) {
      photoInput = document.createElement("input");
      photoInput.type = "file";
      photoInput.accept = "image/*";
      photoInput.style.display = "none";
      document.body.appendChild(photoInput);
    }
    photoInput.value = "";
    photoInput.dataset.placeId = id;
    photoInput.onchange = function () {
      var file = photoInput.files && photoInput.files[0];
      if (file) savePhoto(id, file);
    };
    photoInput.click();
  }

  function savePhoto(id, file) {
    resizeImage(file, 480, 0.78).then(function (blob) {
      return savePhotoBlob(id, blob);
    }).then(function () {
      state.photos[id] = true;
      saveState();
      haptic("success");
      toast("Фото сохранено, +" + POINTS.photo + " очков", true);
      updateStats();
      renderSheet(placeById(id));
      checkBadges();
    }).catch(function () {
      toast("Не удалось обработать фото");
    });
  }

  function deletePhoto(id) {
    if (!window.confirm("Удалить своё фото? " + POINTS.photo + " очков будет снято.")) return;
    deletePhotoBlob(id).then(function () {
      delete state.photos[id];
      saveState();
      haptic("warning");
      toast("Фото удалено, −" + POINTS.photo + " очков");
      updateStats();
      renderList();
      renderSheet(placeById(id));
      checkBadges();
    }).catch(function () {
      toast("Не удалось удалить фото");
    });
  }

  function resizeImage(file, maxSide, quality) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = reject;
      reader.onload = function () {
        var image = new Image();
        image.onerror = reject;
        image.onload = function () {
          var scale = Math.min(1, maxSide / Math.max(image.width, image.height));
          var canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(function (blob) {
            if (blob) resolve(blob); else reject(new Error("toBlob failed"));
          }, "image/jpeg", quality);
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error("no indexeddb")); return; }
      var request = indexedDB.open("patriot-grodno-photos", 1);
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains("photos")) request.result.createObjectStore("photos");
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
    return dbPromise;
  }

  function savePhotoBlob(id, blob) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction("photos", "readwrite");
        tx.objectStore("photos").put(blob, id);
        tx.oncomplete = resolve;
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function deletePhotoBlob(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction("photos", "readwrite");
        tx.objectStore("photos").delete(id);
        tx.oncomplete = resolve;
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function loadPhoto(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction("photos", "readonly");
        var request = tx.objectStore("photos").get(id);
        request.onsuccess = function () { resolve(request.result || null); };
        request.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }

  function shuffle(list) {
    var copy = list.slice();
    for (var i = copy.length - 1; i > 0; i -= 1) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = copy[i]; copy[i] = copy[j]; copy[j] = tmp;
    }
    return copy;
  }

  function startQuiz() {
    quizOrder = shuffle(questions);
    quizIndex = 0;
    quizRoundCorrect = 0;
    el.quizFinish.hidden = true;
    el.quizCard.hidden = false;
    setBackButton(false);
    renderQuestion();
  }

  function renderQuestion() {
    var question = quizOrder[quizIndex];
    if (!question) return;
    el.quizMeta.textContent = "Вопрос " + (quizIndex + 1) + " из " + quizOrder.length;
    el.quizScore.textContent = correctCount() + " / " + questions.length;
    el.quizFill.style.width = ((quizIndex / quizOrder.length) * 100) + "%";
    el.quizQuestion.textContent = question.question;
    el.quizFeedback.hidden = true;
    el.quizNext.hidden = true;
    el.quizRestart.hidden = true;

    el.quizOptions.innerHTML = question.options.map(function (option, index) {
      return '<button type="button" class="quiz-option" data-index="' + index + '">' +
        '<span class="opt-key">' + "АБВГД"[index] + "</span>" +
        "<span>" + escapeHtml(option) + "</span></button>";
    }).join("");

    Array.prototype.forEach.call(el.quizOptions.children, function (button) {
      button.addEventListener("click", function () { answerQuestion(question, button); });
    });
  }

  function answerQuestion(question, button) {
    var chosen = Number(button.dataset.index);
    var isCorrect = chosen === question.correct;
    Array.prototype.forEach.call(el.quizOptions.children, function (option, index) {
      option.disabled = true;
      if (index === question.correct) option.classList.add("is-correct");
      if (index === chosen && !isCorrect) option.classList.add("is-wrong");
    });

    if (isCorrect) {
      quizRoundCorrect += 1;
      if (!state.correct[question.id]) {
        state.correct[question.id] = true;
        toast("+" + POINTS.quiz + " очков", true);
      }
      haptic("success");
    } else {
      haptic("error");
    }

    el.quizVerdict.textContent = isCorrect ? "Верно" : "Неверно";
    el.quizVerdict.className = "quiz-verdict " + (isCorrect ? "ok" : "no");
    el.quizExplanation.textContent = question.explanation;
    el.quizFeedback.hidden = false;
    el.quizNext.hidden = false;
    el.quizScore.textContent = correctCount() + " / " + questions.length;

    saveState();
    updateStats();
    checkBadges();

    if (quizIndex >= quizOrder.length - 1) {
      el.quizNext.textContent = "Итоги";
    } else {
      el.quizNext.textContent = "Следующий вопрос";
    }
  }

  function finishQuiz() {
    var percent = Math.round((quizRoundCorrect / quizOrder.length) * 100);
    el.quizFill.style.width = "100%";
    el.quizCard.hidden = true;
    el.quizFinish.hidden = false;
    setBackButton(false);
    el.finishScore.textContent = quizRoundCorrect + " / " + quizOrder.length;
    el.finishText.textContent = percent + "% правильных ответов в этом заходе. Всего верных ответов: " +
      correctCount() + " из " + questions.length + ". Очки начисляются за каждый вопрос только один раз.";
  }

  function renderBadges() {
    el.badges.innerHTML = badgeDefs().map(function (badge) {
      var earned = Boolean(state.badges[badge.id]);
      return '<div class="badge' + (earned ? " is-earned" : "") + '">' +
        '<div class="badge-icon">' + badge.icon + "</div>" +
        '<div class="badge-name">' + escapeHtml(badge.name) + "</div>" +
        '<div class="badge-hint">' + escapeHtml(badge.hint) + "</div></div>";
    }).join("");
  }

  function openExternalLink(url) {
    var api = tg();
    if (api) {
      try {
        if (typeof api.openLink === "function") {
          api.openLink(url, { try_instant_view: false });
          return;
        }
      } catch (err) {}
    }
    window.open(url, "_blank", "noopener");
  }

  function renderSources() {
    var seen = {};
    places.forEach(function (place) {
      var text = place.source || "";
      if (!text || seen[text]) return;
      seen[text] = true;
      el.sources.innerHTML += "<li>" + escapeHtml(text) + "</li>";
    });
    el.sources.innerHTML += "<li>Фотографии: Wikimedia Commons, свободные лицензии " +
      "(CC0, CC BY-SA). Снимки уменьшены, авторы и условия указаны в карточках мест.</li>";
  }

  function updateStats() {
    var total = points();
    var visited = visitedCount();
    el.scoreValue.textContent = total;
    el.progressText.textContent = visited + " / " + places.length;
    el.progressFill.style.width = ((visited / places.length) * 100) + "%";
    el.brandSub.textContent = places.length + " мест памяти · " + correctCount() + " из " + questions.length + " вопросов";
    el.statVisited.textContent = visited;
    el.statQuiz.textContent = correctCount();
    el.statPhotos.textContent = photoCount();
    el.statBadges.textContent = Object.keys(state.badges).filter(function (key) { return state.badges[key]; }).length;
    el.passportRank.textContent = rankLabel(total);
    el.passportSub.textContent = total + " очков · " + rankLabel(total);
    el.passportFill.style.width = Math.min(100, (total / 500) * 100) + "%";
    renderBadges();
  }

  function sharePlace(id) {
    var place = placeById(id);
    if (!place) return;
    var link = miniAppLink(id) || location.href.split("#")[0];
    var text = place.title + " — " + place.district + ", " + place.period;
    var api = tg();
    if (api && api.initData && typeof api.shareMessage === "function") {
      try {
        api.shareMessage(text, link);
        return;
      } catch (err) {}
    }
    var share = "https://t.me/share/url?url=" + encodeURIComponent(link) +
      "&text=" + encodeURIComponent(text);
    window.open(share, "_blank", "noopener");
  }

  function shareResult() {
    var total = points();
    var text = "Я набрал(а) " + total + " очков в «Памяти Гродненщины»: посещено " +
      visitedCount() + " из " + places.length + " мест, верных ответов в викторине — " +
      correctCount() + " из " + questions.length + ".";
    var url = miniAppLink("") || location.href.split("#")[0];
    var api = tg();
    if (api && api.initData && typeof api.shareMessage === "function") {
      try {
        api.shareMessage(text, url);
        return;
      } catch (err) {}
    }
    var share = "https://t.me/share/url?url=" + encodeURIComponent(url) +
      "&text=" + encodeURIComponent(text);
    window.open(share, "_blank", "noopener");
  }

  function resetProgress() {
    if (!window.confirm("Сбросить весь прогресс, очки и значки? Фото останутся на устройстве.")) return;
    state.visited = {};
    state.photos = {};
    state.correct = {};
    state.badges = {};
    saveState();
    updateStats();
    renderList();
    Object.keys(markers).forEach(refreshMarker);
    toast("Прогресс сброшен");
  }

  function bindEvents() {
    el.tabs.addEventListener("click", function (event) {
      var button = event.target.closest(".tab");
      if (!button) return;
      var target = button.dataset.tab;
      Array.prototype.forEach.call(el.tabs.children, function (tab) {
        tab.classList.toggle("is-active", tab === button);
      });
      ["map", "quiz", "passport"].forEach(function (name) {
        el["view-" + name].classList.toggle("is-active", name === target);
      });
      if (target === "map" && map) setTimeout(function () { map.invalidateSize(); }, 60);
    });

    el.filterDistrict.addEventListener("change", renderList);
    el.filterType.addEventListener("change", renderList);
    el.filterReset.addEventListener("click", function () {
      el.filterDistrict.value = "";
      el.filterType.value = "";
      el.filterSearch.value = "";
      renderList();
    });

    var searchTimer = null;
    el.filterSearch.addEventListener("input", function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderList, 160);
    });

    el.placeList.addEventListener("click", function (event) {
      var card = event.target.closest(".place-card");
      if (!card || !card.dataset.id) return;
      openPlace(card.dataset.id);
    });

    el.sheetBackdrop.addEventListener("click", closeSheet);
    el.sheetClose.addEventListener("click", closeSheet);
    el.sheetBody.addEventListener("click", function (event) {
      var link = event.target.closest(".card-credit-link");
      if (!link) return;
      event.preventDefault();
      event.stopPropagation();
      if (link.dataset.url) openExternalLink(link.dataset.url);
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !el.sheet.hidden) closeSheet();
    });

    el.quizNext.addEventListener("click", function () {
      if (quizIndex >= quizOrder.length - 1) finishQuiz();
      else { quizIndex += 1; renderQuestion(); }
    });
    el.quizRestart.addEventListener("click", startQuiz);
    el.finishRestart.addEventListener("click", startQuiz);
    el.shareBtn.addEventListener("click", shareResult);
    el.resetProgress.addEventListener("click", resetProgress);
  }

  function readData() {
    if (Array.isArray(window.PLACES) && Array.isArray(window.QUESTIONS)) {
      places = window.PLACES;
      questions = window.QUESTIONS;
      photos = window.PHOTOS || {};
      photoCredits = window.PHOTO_CREDITS || {};
      return Promise.resolve();
    }
    return Promise.all([
      fetch("data/places.json").then(function (r) { return r.json(); }),
      fetch("data/questions.json").then(function (r) { return r.json(); })
    ]).then(function (result) {
      places = result[0];
      questions = result[1];
      photos = window.PHOTOS || {};
      photoCredits = window.PHOTO_CREDITS || {};
    });
  }

  function init() {
    cacheElements();
    loadState();
    initTelegram();
    readData().then(function () {
      fillFilters();
      renderList();
      renderSources();
      updateStats();
      initMap();
      startQuiz();
      bindEvents();
      applyStartParam();
      checkBadges();
    }).catch(function () {
      el.placeList.innerHTML = '<li class="place-card" style="display:block;cursor:default">' +
        "Не удалось загрузить данные. Откройте dist/index.html или запустите локальный сервер.</li>";
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
