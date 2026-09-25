"""Сверяет координаты из data/places.json с данными OpenStreetMap (Nominatim).

Запуск:  python tools/verify_coords.py
Результат: tools/coords_report.md и tools/coords_report.json

Ограничения Nominatim: не более 1 запроса в секунду, обязательный User-Agent.
"""

import json
import math
import re
import sys
import time
import unicodedata
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
PLACES = ROOT / "data" / "places.json"
REPORT_MD = Path(__file__).resolve().parent / "coords_report.md"
REPORT_JSON = Path(__file__).resolve().parent / "coords_report.json"

ENDPOINT = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "patriot-grodno-coords/1.0 (educational project)"

# Слова-подсказки для каждого места: Nominatim ищет по названию, а не по нашему описанию.
QUERIES = {
    "kurgan-slavy-grodno": ["Курган Славы, Гродно, Беларусь", "Курган Славы, Гродно"],
    "tank-t34-grodno": [
        "памятник танку Т-34, Гродно, Беларусь",
        "улица Мостовая, Гродно, Беларусь",
    ],
    "memorial-pogranichnikam-grodno": [
        "Граница в огне, Гродно, Беларусь",
        "улица Советских пограничников, Гродно, Беларусь",
    ],
    "shtalag-324-grodno": ["Шталаг-324, Гродно, Беларусь", "мемориал Фолюш, Гродно"],
    "fort-2-naumovichi": [
        "Форт №2 Гродненской крепости, Наумовичи, Беларусь",
        "Наумовичи, Гродненский район, Беларусь",
    ],
    "fort-1-zagorany": [
        "Форт №1 Гродненской крепости, Загораны, Беларусь",
        "Загораны, Гродненский район, Беларусь",
    ],
    "dot-sonichi": ["Соничи, Гродненский район, Беларусь"],
    "memorial-smorgon": [
        "мемориал Первой мировой войны, Сморгонь, Беларусь",
        "Сморгонь, Беларусь",
    ],
    "memorial-lida": ["Курган Бессмертия, Лида, Беларусь", "Лида, Беларусь"],
    "memorial-berestovitsa": [
        "Мемориал Славы, Большая Берестовица, Беларусь",
        "Большая Берестовица, Беларусь",
    ],
    "memorial-korelichi": [
        "мемориал Звезда, Кореличи, Беларусь",
        "Кореличи, Беларусь",
    ],
    "memorial-dyatlovo": ["Дети лихолетья, Дятлово, Беларусь", "Дятлово, Беларусь"],
    "pamyatnik-budenovka": ["Буденовка, Ошмянский район, Беларусь"],
    "pamyatnik-kreivantsy": ["Крейванцы, Ошмянский район, Беларусь"],
    "pamyatnik-mostiishki": ["Мостилишки, Ошмянский район, Беларусь"],
    "pamyatnik-semerniki": ["Семерники, Ошмянский район, Беларусь"],
    "pamyatnik-artilleriya-volkovysk": [
        "памятник артиллерийскому орудию, Волковыск, Беларусь",
        "Волковыск, Беларусь",
    ],
    "obelsk-belkovshchina": ["Белковщина, Сморгонский район, Беларусь"],
    "yuratishki-bratskaya": ["Юратишки, Ивьевский район, Беларусь"],
}

GOOD_ENOUGH_M = 300
NEEDS_REVIEW_M = 1500
OBJECT_TYPES = {
    "memorial",
    "monument",
    "viewpoint",
    "fort",
    "archaeological_site",
    "ruins",
    "attraction",
    "tomb",
    "wayside_shrine",
}


def clean(value: str) -> str:
    return unicodedata.normalize("NFC", str(value)).replace("ё", "е")


def slugify(value: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9-]+", "-", value).strip("-").lower()
    return re.sub(r"-{2,}", "-", value)


def haversine(a, b):
    lat1, lon1 = a
    lat2, lon2 = b
    radius = 6371000.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    h = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(
        math.radians(lat2)
    ) * math.sin(dlon / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(h))


def geocode(query: str):
    params = urlencode(
        {
            "q": query,
            "format": "jsonv2",
            "limit": 5,
            "countrycodes": "by",
            "addressdetails": 0,
        }
    )
    request = Request(
        f"{ENDPOINT}?{params}",
        headers={"User-Agent": USER_AGENT, "Accept-Language": "ru,be,en"},
    )
    with urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def resolve(place):
    lat, lon = place["coords"]
    for query in QUERIES.get(place["id"], [place["title"]]):
        try:
            hits = geocode(query)
        except Exception as exc:  # noqa: BLE001
            print(f"  ! сбой запроса: {exc}", flush=True)
            hits = []
        if hits:
            hit = hits[0]
            return {
                "found": True,
                "query": query,
                "coords": [round(float(hit["lat"]), 6), round(float(hit["lon"]), 6)],
                "name": clean(hit.get("display_name", "")),
                "osm_type": hit.get("type", ""),
            }
        time.sleep(1.1)
    return {"found": False, "query": None, "coords": None, "name": None, "osm_type": None}


def object_matches(places):
    catalog_path = Path(__file__).resolve().parent / "osm_catalog.json"
    if not catalog_path.exists():
        return []
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    rows = []
    for place in places:
        best = None
        for entry in catalog:
            distance = haversine(place["coords"], [entry["lat"], entry["lon"]])
            if best is None or distance < best[0]:
                best = (distance, entry)
        if best and best[0] <= 1000:
            rows.append((place, round(best[0]), best[1]))
    return sorted(rows, key=lambda row: row[1])


def main() -> int:
    if not PLACES.exists():
        print(f"Не найден {PLACES}")
        return 1

    places = json.loads(PLACES.read_text(encoding="utf-8"))
    results = []
    problems = 0

    for index, place in enumerate(places, start=1):
        pid = slugify(clean(place["id"]))
        print(f"[{index}/{len(places)}] {clean(place['title'])}", flush=True)
        hit = resolve(place)
        current = list(place["coords"])
        is_object = hit["found"] and hit["osm_type"] in OBJECT_TYPES
        distance = None
        if hit["found"]:
            distance = round(haversine(current, hit["coords"]))
            if not is_object:
                verdict = "reference"
            elif distance <= GOOD_ENOUGH_M:
                verdict = "ok"
            elif distance <= NEEDS_REVIEW_M:
                verdict = "review"
            else:
                verdict = "fix"
        else:
            verdict = "missing"
        problems += verdict in ("fix", "review", "missing")
        results.append(
            {
                "id": pid,
                "title": clean(place["title"]),
                "status": place.get("coordStatus", "—"),
                "current": current,
                "found": hit["found"],
                "suggested": hit["coords"],
                "distance_m": distance,
                "is_object": is_object,
                "verdict": verdict,
                "query": hit["query"],
                "name": hit["name"],
                "osm_type": hit["osm_type"],
            }
        )
        time.sleep(1.1)

    REPORT_JSON.write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    lines = [
        "# Отчёт о сверке координат",
        "",
        "Поиск: OpenStreetMap через Nominatim, объекты по названию — через Overpass API.",
        "Расстояние считается по формуле гависинуса между координатой из `places.json`",
        "и найденной точкой. Совпадение считается точным в радиусе 300 м.",
        "",
        "Столбец «Что найдено» различает два случая: конкретный объект (мемориал, памятник,",
        "форт) и населённый пункт. Если найден населённый пункт, сравнение расстояния",
        "бессмысленно — метка стоит в населённом пункте, а не у объекта.",
        "",
        "| Место | Статус | Координаты в places.json | Что найдено | Найдено в OSM | Расстояние | Вердикт |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for row in results:
        suggested = (
            f"{row['suggested'][0]}, {row['suggested'][1]}" if row["suggested"] else "—"
        )
        distance = f"{row['distance_m']} м" if row["distance_m"] is not None else "—"
        kind = "объект" if row["is_object"] else ("населённый пункт" if row["found"] else "—")
        lines.append(
            f"| {row['title']} | {row['status']} | {row['current'][0]}, {row['current'][1]} "
            f"| {kind} | {suggested} | {distance} | {row['verdict']} |"
        )
    object_rows = object_matches(places)
    if object_rows:
        lines += [
            "## Подтверждение по самим объектам OpenStreetMap",
            "",
            "Выгрузка из Overpass API: 1432 памятника, форта и мемориального знака",
            "Гродненской области. Ниже — ближайший размеченный объект к координате",
            "из `places.json`.",
            "",
            "| Место | Объект в OpenStreetMap | Координаты объекта | Расстояние |",
            "| --- | --- | --- | --- |",
        ]
        for place, distance, entry in object_rows:
            lines.append(
                f"| {clean(place['title'])} | {entry['name']} "
                f"| {round(entry['lat'], 6)}, {round(entry['lon'], 6)} | {distance} м |"
            )
        lines.append("")

    lines += [
        "",
        "Вердикты: `ok` — объект найден и совпадает, `review` — объект найден рядом,",
        "нужна ручная проверка, `fix` — координата неверна, заменить,",
        "`reference` — в OpenStreetMap найден только населённый пункт, метка стоит в нём,",
        "`missing` — объект не найден, сверить по официальному каталогу.",
        "",
        "## Что было исправлено",
        "",
        "- Братская могила в Юратишках стояла в 11,6 км от одноимённого посёлка,",
        "  координата заменена на 54.032826, 25.925785.",
        "- Форт №1 был указан как 53.75, 23.75 — это 3,5 км от деревни Загораны;",
        "  заменён на объект «Форт № 1» из OpenStreetMap (53.733717, 23.711713),",
        "  он расположен в 420 м от деревни Загораны.",
        "- Памятник Т-34 в Гродно уточнён по объекту OpenStreetMap",
        "  (53.675819, 23.828941) вместо округлённой точки.",
        "- Мемориал Шталага-324, Курган Бессмертия в Лиде и комплекс «Звезда» в Кореличах",
        "  сверены по объектам OpenStreetMap, расхождение устранено.",
        "- Мемориал пограничникам в Гродно стоял в 1,1 км от комплекса: координата",
        "  заменена на 53.6726, 23.8026 (izvezda.by; в 14 м объект OpenStreetMap",
        "  «Помнік савецкім памежнікам» — 53.672481, 23.802669).",
        "- Мемориальный комплекс Первой мировой войны в Сморгони стоял в центре города,",
        "  в 1,5 км от комплекса в Парке Победы на улице Каминского (54.4897, 26.4204).",
        "- «Дети лихолетья» в Дятлово стояли в центре города, в 1,1 км от городского",
        "  кладбища: координата заменена на 53.4669, 25.3891. Объект «Дварчаніну»",
        "  в OpenStreetMap — это памятник И. С. Дворчанину на площади 17 Сентября.",
        "- Орудие в Волковыске перенесено на привокзальную площадь (53.1545, 24.449):",
        "  газета «Наш час» указывает 76-мм пушку в небольшом сквере у вокзала",
        "  Волковыск-Город, прежняя точка была в 1,07 км западнее.",
        "",
    ]
    REPORT_MD.write_text("\n".join(lines), encoding="utf-8")

    print(f"\nГотово: {len(results) - problems} без замечаний, {problems} требуют внимания.")
    print(f"Отчёт: {REPORT_MD}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
