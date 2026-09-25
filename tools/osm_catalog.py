import json
import sys
import time
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

OUT = Path(__file__).resolve().parent / "osm_catalog.json"

QUERIES = [
    '[out:json][timeout:180];'
    '(nwr["historic"~"memorial|monument|fort|archaeological_site"](53.0,23.2,54.7,26.7););'
    "out center tags;",
    '[out:json][timeout:180];'
    '(nwr["name"~"памятник|мемориал|курган|форт|ДОТ|братск|скульптур|могильник",i](53.0,23.2,54.7,26.7););'
    "out center tags;",
    '[out:json][timeout:180];'
    '(nwr["tourism"="artwork"](53.0,23.2,54.7,26.7););'
    "out center tags;",
]


def run(query: str):
    data = urlencode({"data": query}).encode("utf-8")
    request = Request(
        "https://overpass-api.de/api/interpreter",
        data=data,
        headers={"User-Agent": "patriot-grodno-coords/1.0 (educational project)"},
    )
    with urlopen(request, timeout=200) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    catalog = {}
    for index, query in enumerate(QUERIES, start=1):
        try:
            result = run(query)
        except Exception as exc:  # noqa: BLE001
            print(f"запрос {index} не выполнен: {exc}", flush=True)
            time.sleep(3)
            continue
        added = 0
        for element in result.get("elements", []):
            tags = element.get("tags", {})
            name = tags.get("name") or tags.get("name:ru")
            if not name:
                continue
            key = f"{element['type']}/{element['id']}"
            if key in catalog:
                continue
            lat = element.get("lat") or (element.get("center") or {}).get("lat")
            lon = element.get("lon") or (element.get("center") or {}).get("lon")
            if lat is None or lon is None:
                continue
            catalog[key] = {
                "name": name,
                "lat": lat,
                "lon": lon,
                "historic": tags.get("historic", ""),
                "memorial": tags.get("memorial", ""),
                "tourism": tags.get("tourism", ""),
                "wikidata": tags.get("wikidata", ""),
                "description": tags.get("description", ""),
            }
            added += 1
        print(f"запрос {index}: добавлено {added}, всего {len(catalog)}", flush=True)
        time.sleep(3)

    rows = sorted(catalog.values(), key=lambda row: row["name"].lower())
    OUT.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nЗаписано {len(rows)} объектов в {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
