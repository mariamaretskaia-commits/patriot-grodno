"""Ищет свободные фотографии мест на Wikimedia Commons.

discover: собирает кандидатов по категориям и поиску, ничего не скачивая.
fetch:    скачивает выбранные файлы в img/raw и пишет data/photo_credits.json.

Запуск:
  python tools/fetch_photos.py discover
  python tools/fetch_photos.py fetch
"""

import json
import math
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "img" / "raw"
CANDIDATES = ROOT / "img" / "photo_candidates.json"
SELECTION = ROOT / "img" / "photo_selection.json"
CREDITS = ROOT / "data" / "photo_credits.json"
PLACES = ROOT / "data" / "places.json"

API = "https://commons.wikimedia.org/w/api.php"
USER_AGENT = "patriot-grodno/1.0 (educational Telegram Mini App; contact: mariamaretskaia@gmail.com)"
PAUSE = 2.0
THUMB_WIDTH = 1000
MIN_WIDTH = 700
INFO_BATCH = 25
LICENSE_ALLOW = ("cc0", "public domain", "cc by", "cc-by")
MONUMENT_RE = re.compile(r"monument|memorial|pamyatn|grave|cemeter|war", re.IGNORECASE)

CAT_QUERIES = {
    "kurgan-slavy-grodno": ["Kurgan Slavy Hrodna", "Гродно курган Славы"],
    "fort-2-naumovichi": ["Grodno Fortress forts", "Крэпост Гродна форты", "Форты Гродненской крепости"],
    "fort-1-zagorany": ["Гродненская крепость форты", "Zagorany fort", "Загораны форт"],
    "dot-sonichi": ["Соничи Гродненский район", "ДОТ Гродненская область"],
    "memorial-smorgon": ["Defense of Smorgon", "Сморгонь Первая мировая мемориал"],
    "memorial-lida": ["Lida monuments memorials", "Лідскі курган"],
    "memorial-berestovitsa": ["Berastavičy monuments", "Бераставіца помнік"],
    "memorial-korelichi": ["Karelichy monuments", "Карелічы помнік"],
    "pamyatnik-budenovka": ["Karelichy District monuments", "Кореличский район памятники"],
    "pamyatnik-kreivantsy": ["Karelichy District monuments"],
    "pamyatnik-mostiishki": ["Masty monuments", "Масты помнікі"],
    "pamyatnik-semerniki": ["Ašmiany District monuments", "Ошмянский район памятники"],
    "pamyatnik-artilleriya-volkovysk": ["Vaŭkavysk monuments memorials", "Волковыск памятник орудию"],
    "obelsk-belkovshchina": ["Masty monuments", "Белковщина"],
    "yuratishki-bratskaya": ["Juraciški monuments", "Юрацішкі помнік"],
}

PLACE_SPECS = [
    {
        "id": "kurgan-slavy-grodno",
        "cats": ["Category:Monuments and memorials in Hrodna", "Category:Kurgan Slavy in Hrodna"],
        "queries": ["Курган Славы Гродно", "Гродно курган Славы мемориал", "Hrodno mound of glory monument"],
        "keys": ["курган", "kurgan", "mound", "лавы"],
    },
    {
        "id": "tank-t34-grodno",
        "cats": ["Category:Monuments and memorials in Hrodna", "Category:Tanks in Belarus"],
        "queries": ["Гродно памятник танку Т-34", "Гродно танк Т-34", "Hrodno T-34 tank monument"],
        "keys": ["т-34", "t-34", "танк", "tank"],
    },
    {
        "id": "memorial-pogranichnikam-grodno",
        "cats": ["Category:Monuments and memorials in Hrodna"],
        "queries": ["Гродно мемориал пограничникам", "Hrodno border guards memorial"],
        "keys": ["погранич", "granichn"],
    },
    {
        "id": "shtalag-324-grodno",
        "cats": ["Category:Monument to Prisoners of Stalag 324", "Category:Stalag 324"],
        "queries": ["Stalag 324 monument Hrodna", "Помнік вязням шталага 324"],
        "keys": ["stalag", "шталаг", "вязн", "warzeń"],
    },
    {
        "id": "fort-2-naumovichi",
        "cats": ["Category:Grodno Fortress", "Category:Forts in Grodno Region"],
        "queries": ["Гродненская крепость форт Наумовичи", "Крэпост Гродна форт"],
        "keys": ["форт", "fort", "naumow", "наумов", "zumart"],
    },
    {
        "id": "fort-1-zagorany",
        "cats": ["Category:Grodno Fortress", "Category:Forts in Grodno Region"],
        "queries": ["Гродненская крепость форт Загораны", "Гродно форт Загораны"],
        "keys": ["форт", "fort", "zagoran", "загоран"],
    },
    {
        "id": "dot-sonichi",
        "cats": ["Category:Monuments and memorials in Hrodno"],
        "queries": ["Соничи ДОТ Гродненский район", "ДОТ Соничи", "Sonichy dot Grodno"],
        "keys": ["сонич", "sonich", "дот"],
    },
    {
        "id": "memorial-smorgon",
        "cats": ["Category:Monuments and memorials in Smorgon", "Category:Smorgon"],
        "queries": ["Сморгонь мемориал Первая мировая война", "Сморгонь памятник", "Smorgon memorial monument"],
        "keys": ["сморгон", "smorgon", "smarhon"],
    },
    {
        "id": "memorial-lida",
        "cats": ["Category:Monuments and memorials in Lida", "Category:Lida"],
        "queries": ["Лідскі курган Славы", "Лида Курган Бессмертия", "Lida mound of immortality monument"],
        "keys": ["курган", "kurgan"],
    },
    {
        "id": "memorial-berestovitsa",
        "cats": ["Category:Monuments and memorials in Berastavičy", "Category:Berestovitsa"],
        "queries": ["Берестовица мемориал Славы", "Бераставіца помнік Славы", "Berestovitsa war memorial"],
        "keys": ["берест", "berast", "мемориал", "мемарыял", "memorial"],
    },
    {
        "id": "memorial-korelichi",
        "cats": ["Category:Monuments and memorials in Karelichy", "Category:Karelichy"],
        "queries": ["Кореличи мемориальный комплекс Звезда", "Карелічы Зорка помнік", "Karelichy monument star"],
        "keys": ["корелич", "karelich", "звезд", "зорк"],
    },
    {
        "id": "memorial-dyatlovo",
        "cats": ["Category:Memorial to children in Dziatlava", "Category:Monuments and memorials in Dziatlava"],
        "queries": ["Дети лихолетья Дятлово", "Дзяцкаўскі помнік"],
        "keys": ["дятл", "dziat", "дет", "dziec"],
    },
    {
        "id": "pamyatnik-budenovka",
        "cats": ["Category:Karelichy District"],
        "queries": ["Буденовка Кореличи памятник воинам", "Будзёнаўка помнік"],
        "keys": ["буден", "будзён", "buden"],
    },
    {
        "id": "pamyatnik-kreivantsy",
        "cats": ["Category:Karelichy District"],
        "queries": ["Крейванцы Кореличи памятник", "Крэйванцы помнік"],
        "keys": ["крейван", "крэйван", "kreivan"],
    },
    {
        "id": "pamyatnik-mostiishki",
        "cats": ["Category:Monuments and memorials in Masty", "Category:Masty"],
        "queries": ["Мостилишки Мосты памятник воинам", "Мастылішкі помнік", "Mostilishki monument"],
        "keys": ["мостилиш", "мастыліш", "mostiliš", "mostilish"],
    },
    {
        "id": "pamyatnik-semerniki",
        "cats": ["Category:Monuments and memorials in Ašmiany District", "Category:Ašmiany District"],
        "queries": ["Семерники Ошмянский район памятник", "Семернікі помнік"],
        "keys": ["семерник", "семернік", "semernik"],
    },
    {
        "id": "pamyatnik-artilleriya-volkovysk",
        "cats": ["Category:Monuments and memorials in Vaŭkavysk", "Category:Vaŭkavysk"],
        "queries": ["Волковыск памятник орудию", "Касцыйная арматаванная плошча", "Volkovysk gun monument artillery"],
        "keys": ["армат", "пушк", "ган", "gun", "artiller"],
    },
    {
        "id": "obelsk-belkovshchina",
        "cats": ["Category:Monuments and memorials in Masty"],
        "queries": ["Белковщина обелиск Мосты", "Бялкоўшчына помнік"],
        "keys": ["белков", "бялкоў", "belkov", "obelisk", "обелиск"],
    },
    {
        "id": "yuratishki-bratskaya",
        "cats": ["Category:Monuments and memorials in Juraciški", "Category:Juraciški", "Category:Iŭje District"],
        "queries": ["Юратишки братская могила", "Юрацішкі помнік", "Yuratsishki grave memorial"],
        "keys": ["юраціш", "юратиш", "juraciš", "yuratsish"],
    },
]


def esc(value):
    return str(value).encode("unicode_escape").decode("ascii", "backslashreplace")


def haversine(lat1, lon1, lat2, lon2):
    to_rad = math.pi / 180
    d_lat = (lat2 - lat1) * to_rad
    d_lon = (lon2 - lon1) * to_rad
    part = math.sin(d_lat / 2) ** 2 + math.cos(lat1 * to_rad) * math.cos(lat2 * to_rad) * math.sin(d_lon / 2) ** 2
    return 2 * 6371000 * math.atan2(math.sqrt(part), math.sqrt(1 - part))


def api(params, attempt=0, post=False):
    payload = dict(params, format="json")
    if post:
        request = urllib.request.Request(
            API,
            data=urllib.parse.urlencode(payload).encode("utf-8"),
            headers={"User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded"},
        )
    else:
        request = urllib.request.Request(API + "?" + urllib.parse.urlencode(payload), headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        if error.code in (429, 502, 503) and attempt < 4:
            wait = 6 * (attempt + 1)
            print("   retry in " + str(wait) + " s after HTTP " + str(error.code), flush=True)
            time.sleep(wait)
            return api(params, attempt + 1, post)
        raise
    time.sleep(PAUSE)
    return data


def strip_html(value):
    text = re.sub(r"<[^>]+>", " ", str(value or ""))
    return re.sub(r"\s+", " ", text).strip()


def category_members(category, kind):
    data = api({
        "action": "query",
        "list": "categorymembers",
        "cmtitle": category,
        "cmlimit": "200",
        "cmtype": kind,
    })
    return [item["title"] for item in data.get("query", {}).get("categorymembers", [])]


def image_info(titles):
    out = {}
    titles = list(dict.fromkeys(titles))
    for start in range(0, len(titles), INFO_BATCH):
        chunk = titles[start:start + INFO_BATCH]
        data = api({
            "action": "query",
            "titles": "|".join(chunk),
            "prop": "imageinfo|categories",
            "iiprop": "url|extmetadata|size",
            "iiurlwidth": str(THUMB_WIDTH),
            "cllimit": "max",
        }, post=True)
        for page in data.get("query", {}).get("pages", {}).values():
            info = (page.get("imageinfo") or [{}])[0]
            meta = info.get("extmetadata", {})
            out[page.get("title")] = {
                "license": strip_html((meta.get("LicenseShortName") or {}).get("value")),
                "licenseUrl": strip_html((meta.get("LicenseUrl") or {}).get("value")),
                "artist": strip_html((meta.get("Artist") or {}).get("value"))[:120],
                "description": strip_html((meta.get("ImageDescription") or {}).get("value"))[:300],
                "date": strip_html((meta.get("DateTimeOriginal") or {}).get("value"))[:40],
                "width": info.get("width", 0),
                "height": info.get("height", 0),
                "thumb": info.get("thumburl", ""),
                "gps_lat": strip_html((meta.get("GPSLatitude") or {}).get("value")),
                "gps_lon": strip_html((meta.get("GPSLongitude") or {}).get("value")),
                "categories": [item["title"] for item in page.get("categories", [])],
            }
    return out


def parse_degrees(value):
    if not value:
        return None
    numbers = re.findall(r"\d+(?:\.\d+)?", value)
    if not numbers:
        return None
    numbers = [float(item) for item in numbers[:3]]
    while len(numbers) < 3:
        numbers.append(0.0)
    degrees = numbers[0] + numbers[1] / 60 + numbers[2] / 3600
    upper = value.upper()
    if "S" in upper or "W" in upper:
        degrees = -degrees
    return degrees


def search_files(query):
    data = api({
        "action": "query",
        "generator": "search",
        "gsrsearch": query,
        "gsrnamespace": "6",
        "gsrlimit": "20",
        "prop": "imageinfo",
        "iiprop": "url|size",
    })
    return [page["title"] for page in data.get("query", {}).get("pages", {}).values()]


def keep_titles(titles, keys, limit=25):
    if len(titles) <= limit:
        return titles
    matched = [title for title in titles if any(key.lower() in title.lower() for key in keys)]
    return (matched or titles)[:limit]


def search_categories(query):
    data = api({
        "action": "query",
        "list": "search",
        "srsearch": query,
        "srnamespace": "14",
        "srlimit": "8",
    })
    return [item["title"] for item in data.get("query", {}).get("search", [])]


def collect_candidates(spec):
    titles = []
    from_category = []
    for category in spec["cats"]:
        files = category_members(category, "file")
        files = keep_titles(files, spec["keys"])
        from_category.extend(files)
        titles.extend(files)
        for sub in category_members(category, "subcat"):
            if MONUMENT_RE.search(sub):
                sub_files = keep_titles(category_members(sub, "file"), spec["keys"])
                from_category.extend(sub_files)
                titles.extend(sub_files)
                print("   subcat: " + esc(sub) + " -> " + str(len(sub_files)) + " files", flush=True)
    for query in spec.get("cat_queries", []):
        found = search_categories(query)
        print("   cat query: " + esc(query) + " -> " + str(len(found)), flush=True)
        for category in found:
            files = keep_titles(category_members(category, "file"), spec["keys"], 15)
            if not files:
                continue
            from_category.extend(files)
            titles.extend(files)
            print("     " + esc(category) + " -> " + str(len(files)), flush=True)
    for query in spec["queries"]:
        found = search_files(query)
        titles.extend(found)
        print("   query: " + esc(query) + " -> " + str(len(found)), flush=True)
    rows = []
    if not titles:
        return rows
    info = image_info(titles)
    for title, data in info.items():
        if data["width"] < MIN_WIDTH or data["width"] * 1.6 < data["height"]:
            continue
        if not any(item in data["license"].lower() for item in LICENSE_ALLOW):
            continue
        score = 0
        if title in from_category:
            score += 5
        if any(key.lower() in title.lower() for key in spec["keys"]):
            score += 3
        if data["width"] >= 1200:
            score += 2
        lat = parse_degrees(data["gps_lat"])
        lon = parse_degrees(data["gps_lon"])
        gap = None
        if lat is not None and lon is not None:
            gap = round(haversine(spec["coords"][0], spec["coords"][1], lat, lon))
            if gap <= 250:
                score += 5
            elif gap <= 1000:
                score += 3
        rows.append({
            "title": title,
            "score": score,
            "distance": gap,
            "license": data["license"],
            "license_url": data["licenseUrl"],
            "artist": data["artist"],
            "date": data["date"],
            "size": [data["width"], data["height"]],
            "thumb": data["thumb"],
            "categories": data["categories"][:4],
            "description": data["description"],
        })
    rows.sort(key=lambda row: (-row["score"], row["title"]))
    return rows


def discover():
    if not PLACES.exists():
        print("missing " + str(PLACES))
        return 1
    places = {place["id"]: place for place in json.loads(PLACES.read_text(encoding="utf-8"))}
    report = {}
    for source in PLACE_SPECS:
        pid = source["id"]
        spec = dict(source)
        spec["coords"] = places[pid]["coords"] if pid in places else [0, 0]
        spec["cat_queries"] = CAT_QUERIES.get(pid, [])
        print("=== " + pid, flush=True)
        rows = collect_candidates(spec)
        report[pid] = rows[:15]
        print("   kept " + str(len(rows)), flush=True)
        for row in rows[:8]:
            print("   " + str(row["score"]) + " | " + esc(row["title"]) + " | " + row["license"] +
                  " | " + str(row["size"][0]) + "x" + str(row["size"][1]) +
                  " | d=" + str(row["distance"]) +
                  " | " + esc(",".join(row["categories"])) +
                  " | " + esc(row["description"][:80]), flush=True)
    CANDIDATES.parent.mkdir(parents=True, exist_ok=True)
    CANDIDATES.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    found_total = sum(1 for rows in report.values() if rows)
    print("\nplaces with candidates: " + str(found_total) + " of " + str(len(PLACE_SPECS)))
    print("written: " + str(CANDIDATES))
    return 0


def fetch():
    if not SELECTION.exists():
        print("missing " + str(SELECTION))
        return 1
    selection = json.loads(SELECTION.read_text(encoding="utf-8"))
    RAW.mkdir(parents=True, exist_ok=True)
    credits = {}
    for pid, title in selection.items():
        info = image_info([title]).get(title)
        if not info or not info["thumb"]:
            print("skip " + pid + ": " + esc(title))
            continue
        if not any(item in info["license"].lower() for item in LICENSE_ALLOW):
            print("skip " + pid + ": license " + info["license"])
            continue
        suffix = ".jpg"
        match = re.search(r"\.([a-z]{3,4})$", title, re.IGNORECASE)
        if match:
            suffix = "." + match.group(1).lower()
        target = RAW / (pid + suffix)
        request = urllib.request.Request(info["thumb"], headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=90) as response:
            target.write_bytes(response.read())
        credits[pid] = {
            "title": title.replace("File:", ""),
            "author": info["artist"] or "Автор не указан",
            "license": info["license"],
            "license_url": info["licenseUrl"],
            "source_url": "https://commons.wikimedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_")),
            "date": info["date"],
        }
        print(pid + ": " + target.name + " <- " + esc(title) + " (" + info["license"] + ")", flush=True)
    CREDITS.write_text(json.dumps(credits, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("\ndownloaded: " + str(len(credits)))
    print("written: " + str(CREDITS))
    return 0


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "discover"
    if mode == "discover":
        return discover()
    if mode == "fetch":
        return fetch()
    print("mode must be discover or fetch")
    return 1


if __name__ == "__main__":
    sys.exit(main())
