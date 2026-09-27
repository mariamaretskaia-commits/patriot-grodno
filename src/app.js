(function () {
  "use strict";

  var STORAGE_KEY = "pg_state_v1";
  var BOT_USERNAME = "MemoryOfTheGrodnoRegion_bot";

  var POINTS = { visit: 10, quiz: 15, photo: 20 };
  var FORT_TYPE = "фортификация";

  // Общая галерея показывает кадр достаточно крупным, поэтому фото
  // уменьшается до 1280 px по большей стороне. Сервер принимает до 3 МБ,
  // этого хватает с запасом.
  var PHOTO_MAX_SIDE = 1280;
  var PHOTO_QUALITY = 0.82;

  var state = {
    visited: {},
    photos: {},
    correct: {},
    badges: {},
    // photoIds: место → id своей записи в серверной галерее. Нужны, чтобы
    // отличить своё фото в общей галерее и удалить его с сервера.
    // pendingDeletes: id фото, удалённых офлайн и ждущих сети.
    // Оба поля живут только на устройстве и на сервер не отправляются.
    photoIds: {},
    pendingDeletes: []
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
      "sheetClose", "sheetBody", "toast", "sheetPanel",
      "syncDot", "syncText", "lightbox", "lightboxBody",
      "lightboxCaption", "lightboxClose"
    ].forEach(function (id) { el[id] = $(id); });
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      Object.keys(state).forEach(function (key) {
        if (!saved[key] || typeof saved[key] !== "object") return;
        // Массив ожидается массивом, карта — картой: иначе полезшие в
        // localStorage данные другого формата сломали бы цикл удаления.
        if (Array.isArray(state[key]) !== Array.isArray(saved[key])) return;
        state[key] = saved[key];
      });
    } catch (err) {
      storageAvailable = false;
    }
  }

  var storageAvailable = true;

  function persistLocal() {
    if (!storageAvailable) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      storageAvailable = false;
    }
  }

  function saveState(immediate) {
    persistLocal();
    // Локальная запись не зависит от сети: если сервер недоступен,
    // изменения останутся грязными и уйдут при следующей попытке.
    if (window.Cloud) window.Cloud.markDirty(immediate);
  }

  
  function setAvatar(url) {
    if (!url) return;
    var img = document.createElement("img");
    img.src = url;
    img.alt = "Аватар";
    img.style.cssText = "width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block;";
    img.onerror = function() { this.style.display = "none"; };
    var m = document.getElementById("brandMark");
    if (m) { m.innerHTML = ""; m.style.background = "#1a1814"; m.style.border = "1.5px solid #8a6f3f"; m.appendChild(img.cloneNode()); }
    var p = document.getElementById("avatarImg");
    if (p) { p.innerHTML = ""; p.style.background = "#2a2418"; p.style.border = "2px solid #8a6f3f"; p.appendChild(img); }
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
    // Источник берём из данных: не все снимки из Wikimedia Commons,
    // часть взята с сайтов райисполкомов, и подпись должна быть верной.
    var source = credit.source_name || "Wikimedia Commons";
    // Ссылки на источник и условия намеренно не делаем кликабельными:
    // в приложении не должно быть ни одной ссылки, а требование
    // атрибуции выполняется именем автора и названием лицензии.
    return '<div class="card-credit">Фото: ' + escapeHtml(source) + ", " + escapeHtml(parts.join(" · ")) +
      " · снимок уменьшен</div>";
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
    releaseSheetUrls();
    Object.keys(markers).forEach(refreshMarker);
  }

  function renderSheet(place) {
    // Прежнее содержимое карточки заменяется целиком, поэтому его кадры
    // больше не нужны и под них освобождается память.
    releaseSheetUrls();
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
      galleryBlock(place) +
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

    var galleryMore = $("galleryMore");
    if (galleryMore) {
      galleryMore.addEventListener("click", function () { showMoreGallery(place.id); });
    }

    var own = $("ownPhoto");
    if (own) {
      loadPhoto(place.id).then(function (blob) {
        if (!blob) return;
        own.src = trackSheetUrl(URL.createObjectURL(blob));
        applyPhotoFit(own);
      });
    }
    applyPhotoFit(el.sheetBody.querySelector(".card-photo[data-fit]"));
    loadGallery(place.id);
  }

  function galleryBlock(place) {
    // Галерея — витрина общих фотографий. Свое фото показывается отдельно
    // выше, поэтому в общей сетке его не дублируем.
    return '<div class="gallery" id="gallery" data-place="' + escapeHtml(place.id) + '">' +
      '<div class="gallery-head">' +
      '<span class="gallery-title">Фото участников</span>' +
      '<span class="gallery-count" id="galleryCount"></span>' +
      "</div>" +
      '<div class="gallery-grid" id="galleryGrid">' +
      '<p class="gallery-empty">Загружаем фотографии…</p>' +
      "</div>" +
      '<button class="btn btn-ghost gallery-more" id="galleryMore" type="button" hidden>Показать ещё</button>' +
      '<p class="gallery-note" id="galleryNote" hidden></p>' +
      "</div>";
  }

  // Список мест, для которых галерея уже загружалась: при каждом открытии
  // карточки перезапрашивать её не нужно, иначе тратится лимит запросов.
  var galleryCache = {};
  var GALLERY_PAGE = 24;

  function loadGallery(placeId) {
    var box = $("gallery");
    if (!box || !window.Cloud || !window.Cloud.isEnabled()) {
      if (box) {
        box.hidden = true;
      }
      return;
    }
    box.hidden = false;
    var cached = galleryCache[placeId];
    if (cached) {
      renderGallery(placeId, cached.shown, cached.total, cached.mine, cached.moderator);
      loadGalleryImages(placeId, cached.shown);
      return;
    }
    window.Cloud.gallery(placeId).then(function (data) {
      if (!data) {
        var grid = $("galleryGrid");
        var note = $("galleryNote");
        if (grid) grid.innerHTML = "";
        if (note) {
          note.textContent = "Общая галерея сейчас недоступна.";
          note.hidden = false;
        }
        return;
      }
      // С сервера приходит весь список: показ порциями делается на
      // устройстве, поэтому «Показать ещё» не требует нового запроса.
      var all = (data.entries || []).slice();
      var mine = (data.canDelete || []).slice();
      var total = data.total || all.length;
      // У модератора canDelete содержит все записи, поэтому его сетку
      // нельзя фильтровать по «свои» — иначе она окажется пустой.
      var moderator = Boolean(data.isModerator);
      var shown = all.slice(0, GALLERY_PAGE);
      galleryCache[placeId] = {
        all: all, shown: shown, mine: mine, total: total, moderator: moderator,
      };
      renderGallery(placeId, shown, total, mine, moderator);
      loadGalleryImages(placeId, shown);
    });
  }

  // Показать следующую порцию уже загруженного списка.
  function showMoreGallery(placeId) {
    var cached = galleryCache[placeId];
    if (!cached) return;
    var before = cached.shown.length;
    cached.shown = cached.all.slice(0, before + GALLERY_PAGE);
    renderGallery(placeId, cached.shown, cached.total, cached.mine, cached.moderator);
    loadGalleryImages(placeId, cached.shown.slice(before));
  }

  // После загрузки или удаления своего фото список на сервере меняется, и
  // старый кэш показывал бы устаревший счётчик.
  function invalidateGallery(placeId) {
    delete galleryCache[placeId];
  }

  function renderGallery(placeId, entries, total, mine, moderator) {
    var grid = $("galleryGrid");
    var count = $("galleryCount");
    var more = $("galleryMore");
    if (!grid) return;

    // Своё фото живёт выше по карточке, в общей сетке оно лишнее.
    // Модератору показываем всё, включая его собственное: canDelete у
    // него содержит все записи, и фильтр «убрать свои» обнулил бы сетку.
    var visible = moderator
      ? entries.slice()
      : entries.filter(function (entry) {
        return mine.indexOf(entry.id) < 0;
      });
    // total считает все снимки места, включая собственный, поэтому
    // чужих фото чуть меньше — иначе счётчик врёт на единицу.
    var othersTotal = moderator ? total : Math.max(total - mine.length, 0);
    var hidden = othersTotal - visible.length;

    if (count) {
      if (!othersTotal) {
        count.textContent = "";
      } else if (hidden > 0) {
        count.textContent = visible.length + " из " + othersTotal + " фото";
      } else {
        count.textContent = othersTotal + " фото";
      }
    }
    if (!visible.length) {
      grid.innerHTML = total
        ? '<p class="gallery-empty">Здесь пока нет фотографий от других участников.</p>'
        : '<p class="gallery-empty">Будьте первым, кто добавит фото этого места.</p>';
    } else {
      grid.innerHTML = visible.map(function (entry) {
        // Имя автора кладём в разметку только для модератора. Сервер
        // поле и не отдаёт обычному участнику, но лишний раз показать
        // его в DOM значит показать при любой опечатке на сервере.
        var authorAttr = moderator
          ? ' data-author="' + escapeHtml(entry.author || "") + '"'
          : "";
        var photo = '<button class="gallery-item" type="button" data-entry="' + escapeHtml(entry.id) +
          '" data-caption="' + escapeHtml(entry.caption || "") + '"' + authorAttr + ">" +
          '<span class="gallery-photo" data-entry="' + escapeHtml(entry.id) + '"></span>' +
          (entry.caption ? '<span class="gallery-caption">' + escapeHtml(entry.caption) + "</span>" : "") +
          "</button>";
        // Подпись с автором и кнопкой удаления нужна только модератору,
        // поэтому обычные участники её не видят и лишних узлов не получают.
        if (!moderator) return '<div class="gallery-cell">' + photo + "</div>";
        var who = entry.author || entry.username || ("id " + entry.userId);
        var tags = [entry.author, entry.username, entry.userId].filter(Boolean).join(" · ");
        return '<div class="gallery-cell">' + photo +
          '<div class="gallery-mod">' +
          '<span class="gallery-author" title="' + escapeHtml(tags) + '">' + escapeHtml(who) + "</span>" +
          '<button class="gallery-del" type="button" data-entry="' + escapeHtml(entry.id) +
          '" data-place="' + escapeHtml(placeId) +
          '" data-label="' + escapeHtml(who) + '">Удалить</button>' +
          "</div></div>";
      }).join("");
    }
    // Кнопка нужна, только если в уже загруженном списке есть ещё кадры.
    if (more) more.hidden = !(hidden > 0);
  }

  // Фотографии грузятся отдельными запросами с initData, поэтому обычный
  // <img src="..."> не подходит: картинки собираются через blob и
  // подставляются после загрузки.
  function loadGalleryImages(placeId, entries) {
    entries.forEach(function (entry) {
      var slot = document.querySelector('.gallery-photo[data-entry="' + cssEscape(entry.id) + '"]');
      if (!slot || slot.dataset.loaded) return;
      slot.dataset.loaded = "1";
      window.Cloud.fetchPhoto(entry.id).then(function (blob) {
        if (!blob) {
          slot.textContent = "";
          return;
        }
        var img = document.createElement("img");
        img.loading = "lazy";
        img.alt = entry.caption || "Фото участника";
        img.src = trackSheetUrl(URL.createObjectURL(blob));
        slot.appendChild(img);
      });
    });
  }

  // Атрибут data-entry используется в селекторе, поэтому значение нужно
  // экранировать для CSS.
  function cssEscape(value) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  // Фотографии показываются через object URL, поэтому их нужно вовремя
  // освобождать: иначе память телефона забивается кадрами при каждом
  // открытии карточки. Учётчика два: карточка и просмотрщик живут
  // независимо, и закрытие просмотрщика не должно гасить кадры в карточке.
  var sheetUrls = [];
  var lightboxUrl = "";

  function trackSheetUrl(url) {
    sheetUrls.push(url);
    return url;
  }

  function releaseSheetUrls() {
    sheetUrls.forEach(function (url) {
      try { URL.revokeObjectURL(url); } catch (err) {}
    });
    sheetUrls = [];
  }

  function openLightbox(entryId, caption, author) {
    if (!el.lightbox) return;
    el.lightboxBody.innerHTML = "";
    if (lightboxUrl) {
      try { URL.revokeObjectURL(lightboxUrl); } catch (err) {}
      lightboxUrl = "";
    }
    // Модератору подпись нужна вместе с автором: по фото он решает,
    // оставлять ли его в общей галерее.
    el.lightboxCaption.textContent = author
      ? (caption ? caption + " · " : "") + author
      : (caption || "");
    el.lightbox.hidden = false;
    window.Cloud.fetchPhoto(entryId).then(function (blob) {
      // Просмотрщик могли закрыть, пока шла загрузка.
      if (el.lightbox.hidden) return;
      if (!blob) {
        closeLightbox();
        return;
      }
      var img = document.createElement("img");
      img.alt = caption || "Фотография участника";
      lightboxUrl = URL.createObjectURL(blob);
      img.src = lightboxUrl;
      el.lightboxBody.appendChild(img);
    });
  }

  function closeLightbox() {
    if (!el.lightbox || el.lightbox.hidden) return;
    el.lightbox.hidden = true;
    el.lightboxBody.innerHTML = "";
    el.lightboxCaption.textContent = "";
    if (lightboxUrl) {
      try { URL.revokeObjectURL(lightboxUrl); } catch (err) {}
      lightboxUrl = "";
    }
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
    toast("Обрабатываю фото…");
    resizeImage(file, PHOTO_MAX_SIDE, PHOTO_QUALITY).then(function (blob) {
      return savePhotoBlob(id, blob).then(function () { return blob; });
    }).then(function (blob) {
      state.photos[id] = true;
      delete state.photoIds[id];
      saveState(true);
      haptic("success");
      toast("Фото сохранено, +" + POINTS.photo + " очков", true);
      updateStats();
      renderSheet(placeById(id));
      checkBadges();
      // Загрузка на сервер идёт после показа результата: медленная сеть
      // не должна заставлять ждать подтверждения, что фото сохранено.
      uploadToCloud(id, blob);
    }).catch(function () {
      toast("Не удалось обработать фото");
    });
  }

  function uploadToCloud(id, blob) {
    if (!window.Cloud || !window.Cloud.isEnabled()) return;
    window.Cloud.uploadPhoto(id, blob).then(function (entry) {
      if (!entry) {
        toast("Фото сохранено на устройстве, но не отправлено в общую галерею");
        return;
      }
      state.photoIds[id] = entry.id;
      // Успешная отправка снимает отложенное удаление этого места.
      state.pendingDeletes = (state.pendingDeletes || []).filter(function (value) {
        return value !== entry.id;
      });
      saveState();
      // Общий список изменился: своё фото появилось в галерее, старый
      // счётчик и кнопка удаления были бы неверны. Кэш сбрасывается до
      // перерисовки карточки.
      invalidateGallery(id);
      if (el.sheet.hidden !== false) renderSheet(placeById(id));
    });
  }

  function deletePhoto(id) {
    if (!window.confirm("Удалить своё фото? " + POINTS.photo + " очков будет снято.")) return;
    var entryId = state.photoIds[id];
    deletePhotoBlob(id).then(function () {
      delete state.photos[id];
      delete state.photoIds[id];
      haptic("warning");
      toast("Фото удалено, −" + POINTS.photo + " очков");
      updateStats();
      renderList();
      // Снимка в общей галерее больше нет: кэш сбрасывается до перерисовки
      // карточки, иначе она успела бы показать устаревшую сетку.
      invalidateGallery(id);
      renderSheet(placeById(id));
      checkBadges();
      if (window.Cloud && window.Cloud.isEnabled() && entryId) {
        window.Cloud.deletePhoto(entryId).then(function (ok) {
          if (ok) {
            saveState(true);
            return;
          }
          // Сеть пропала в момент удаления: Remember, чтобы повторить.
          state.pendingDeletes = (state.pendingDeletes || []).concat([entryId]);
          saveState();
        });
      } else {
        saveState(true);
      }
    }).catch(function () {
      toast("Не удалось удалить фото");
    });
  }

  // Повторная отправка отложенных удалений после появления сети.
  function flushPendingDeletes() {
    var pending = state.pendingDeletes || [];
    if (!pending.length || !window.Cloud || !window.Cloud.isEnabled()) return;
    var rest = pending.slice();
    var chain = Promise.resolve();
    rest.forEach(function (entryId) {
      chain = chain.then(function () {
        return window.Cloud.deletePhoto(entryId).then(function (ok) {
          if (ok) rest = rest.filter(function (value) { return value !== entryId; });
        });
      });
    });
    chain.then(function () {
      state.pendingDeletes = rest;
      saveState();
    });
  }

  // Модератор удаляет чужое фото: локальное состояние участника не
  // трогаем, очки не начислялись, поэтому и не снимаем.
  function moderateDelete(entryId, placeId, label) {
    if (!entryId) return;
    var who = label ? " (" + label + ")" : "";
    if (!window.confirm("Удалить фото участника" + who + "?")) return;
    if (!window.Cloud || !window.Cloud.deletePhoto) {
      toast("Удаление доступно только в Telegram");
      return;
    }
    window.Cloud.deletePhoto(entryId).then(function (ok) {
      if (!ok) {
        toast("Не удалось удалить фото");
        return;
      }
      haptic("warning");
      toast("Фото удалено");
      invalidateGallery(placeId);
      renderSheet(placeById(placeId));
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

  // Шаринг живёт только через Telegram: запасная ветка с t.me/share
  // открывала ссылку в браузере, а ссылок в приложении быть не должно.
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
    toast("Поделиться можно только из Telegram");
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
    toast("Поделиться можно только из Telegram");
  }

  function resetProgress() {
    if (!window.confirm("Сбросить прогресс, очки за посещения и викторину и значки? Загруженные фото и очки за них сохранятся.")) return;
    state.visited = {};
    state.correct = {};
    state.badges = {};
    // Фото не трогаем: это содержимое пользователя, а не прогресс. Если
    // стереть и photos, то сервер вернёт их из ownPhotos при следующей
    // синхронизации и сброс ничего бы не значил.
    saveState(true);
    // Сервер тоже должен забыть прогресс, иначе следующая синхронизация
    // вернёт его обратно на только что очищенное устройство.
    if (window.Cloud && window.Cloud.isEnabled()) {
      window.Cloud.reset().then(function (remote) {
        if (remote) applyRemoteState(remote);
        flushPendingDeletes();
        updateStats();
        renderList();
        Object.keys(markers).forEach(refreshMarker);
        toast("Прогресс сброшен");
      });
      return;
    }
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
      var del = event.target.closest(".gallery-del");
      if (del) {
        // Кнопка модератора лежит рядом с миниатюрой внутри той же ячейки,
        // поэтому гасим всплытие: иначе клик открыл бы просмотрщик.
        event.preventDefault();
        event.stopPropagation();
        moderateDelete(del.dataset.entry, del.dataset.place, del.dataset.label);
        return;
      }
      var item = event.target.closest(".gallery-item");
      if (item && item.dataset.entry) openLightbox(item.dataset.entry, item.dataset.caption, item.dataset.author);
    });

    if (el.lightboxClose) el.lightboxClose.addEventListener("click", closeLightbox);
    if (el.lightbox) {
      el.lightbox.addEventListener("click", function (event) {
        if (event.target === el.lightbox) closeLightbox();
      });
    }

    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      if (el.lightbox && !el.lightbox.hidden) {
        closeLightbox();
        return;
      }
      if (!el.sheet.hidden) closeSheet();
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

  // Приложение рассчитано на Telegram: вне его нет initData, поэтому
  // сервер не примет ни прогресс, ни фотографии, а прогресс на устройстве
  // не будет переноситься на другие устройства. Показываем честный
  // экран-заглушку вместо приложения, которое всё равно не работает.
  //
  // Служебный параметр nogate=1 снимает замок: он нужен автотестам и
  // локальной проверке в браузере. На серверной логике он не влияет —
  // запросы без initData сервер отклоняет в любом случае.
  function telegramGatePassed() {
    var api = window.Telegram && window.Telegram.WebApp;
    if (api && api.initData) return true;
    try {
      if (/(^|[?&])nogate=1(&|$)/.test(window.location.search)) return true;
    } catch (err) {}
    return false;
  }

  function showGate() {
    var gate = $("tgate");
    if (gate) gate.hidden = false;
    document.body.classList.add("is-gated", "is-locked");
  }

  var SYNC_TEXT = {
    off: "",
    sync: "Сохраняю…",
    ok: "",
    error: "Нет сети — сохраню позже"
  };

  function showSyncStatus(status) {
    if (!el.syncDot) return;
    if (status === "off" || status === "ok") {
      el.syncDot.hidden = true;
      el.syncDot.classList.remove("is-error");
      return;
    }
    el.syncDot.hidden = false;
    el.syncText.textContent = SYNC_TEXT[status] || "";
    el.syncDot.classList.toggle("is-error", status === "error");
  }

  // Прогресс, очки и фото с сервера накладываются на локальные, а не
  // заменяют их: слияние монотонно, поэтому ни одна сторона не теряет
  // накопленное.
  function applyRemoteState(remote) {
    if (!remote) return false;
    var before = JSON.stringify(state.visited) + JSON.stringify(state.correct) +
      JSON.stringify(state.badges) + JSON.stringify(state.photos);
    state.visited = window.Cloud.mergeMaps(state.visited, remote.visited);
    state.correct = window.Cloud.mergeMaps(state.correct, remote.correct);
    state.badges = window.Cloud.mergeMaps(state.badges, remote.badges);
    // Свои фото на сервере — источник истины: если фото там есть, а
    // локально файла нет, значит это новое устройство.
    var own = remote.ownPhotos || {};
    Object.keys(own).forEach(function (placeId) {
      state.photoIds[placeId] = own[placeId];
      state.photos[placeId] = true;
    });
    var after = JSON.stringify(state.visited) + JSON.stringify(state.correct) +
      JSON.stringify(state.badges) + JSON.stringify(state.photos);
    return before !== after;
  }

  function startCloud() {
    if (!window.Cloud) return;
    window.Cloud.start({
      getState: function () { return state; },
      onSynced: function (remote) {
        var changed = applyRemoteState(remote);
        // Только локальная запись: ответ сервера не является новым
        // изменением. Иначе каждый успешный ответ помечал бы состояние
        // грязным заново и приложение слало бы бесконечный поток POST.
        persistLocal();
        if (changed) {
          updateStats();
          renderList();
          Object.keys(markers).forEach(refreshMarker);
          if (!el.sheet.hidden && activeId) renderSheet(placeById(activeId));
        }
        flushPendingDeletes();
        restoreOwnPhotos(remote.ownPhotos || {});
      },
      onStatus: showSyncStatus
    });
  }

  // На новом устройстве своих фотографий в IndexedDB ещё нет, поэтому
  // файлы скачиваются с сервера в фоне.
  function restoreOwnPhotos(ownPhotos) {
    if (!window.Cloud || !window.Cloud.isEnabled()) return;
    window.Cloud.restorePhotos(ownPhotos, function (placeId) {
      return state.photos[placeId] && Boolean(localPhotoCache[placeId]);
    }, function (placeId, blob) {
      return savePhotoBlob(placeId, blob).then(function () {
        localPhotoCache[placeId] = true;
      });
    }).then(function (count) {
      if (!count) return;
      renderList();
      if (!el.sheet.hidden && activeId) renderSheet(placeById(activeId));
    });
  }

  // Отметка «фото уже лежит в IndexedDB», чтобы восстановление не качало
  // одни и те же файлы при каждом запуске.
  var localPhotoCache = {};

  function primeLocalPhotoCache() {
    if (!window.indexedDB) return Promise.resolve();
    return openDb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction("photos", "readonly");
        var request = tx.objectStore("photos").getAllKeys();
        request.onsuccess = function () {
          (request.result || []).forEach(function (key) { localPhotoCache[key] = true; });
          resolve();
        };
        request.onerror = function () { resolve(); };
      });
    }).catch(function () {});
  }

  function init() {
    if (!telegramGatePassed()) {
      // Приложение не инициализируется вовсе: карта и списки остаются
      // пустыми и не могут случайно выглядеть как рабочие.
      showGate();
      return;
    }
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
      primeLocalPhotoCache().then(startCloud);
    }).catch(function () {
      el.placeList.innerHTML = '<li class="place-card" style="display:block;cursor:default">' +
        "Не удалось загрузить данные. Откройте dist/index.html или запустите локальный сервер.";
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
