"""Готовит фотографии мест из img/raw в img/opt.

Кладёте исходники в img/raw, имена файлов совпадают с id мест из places.json.
Запуск:  python tools/optimize_images.py
"""

import json
import sys
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "img" / "raw"
OUT = ROOT / "img" / "opt"
PLACES = ROOT / "data" / "places.json"

MAX_SIDE = 400
TARGET_BYTES = 20 * 1024
EXTS = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff")
QUALITIES = (78, 72, 66, 60, 54, 46, 38)


def find_raw(pid: str):
    for ext in EXTS:
        candidate = RAW / f"{pid}{ext}"
        if candidate.exists():
            return candidate
    return None


def compress(image: Image.Image, path: Path) -> int:
    best = None
    for quality in QUALITIES:
        image.save(path, "WEBP", quality=quality, method=6)
        size = path.stat().st_size
        best = size
        if size <= TARGET_BYTES:
            break
    return best


def main() -> int:
    if not PLACES.exists():
        print(f"Не найден {PLACES}")
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    places = json.loads(PLACES.read_text(encoding="utf-8"))

    ready, missing = 0, []
    for place in places:
        pid = place["id"]
        source = find_raw(pid)
        if source is None:
            missing.append(pid)
            continue
        with Image.open(source) as original:
            image = ImageOps.exif_transpose(original).convert("RGB")
            image.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
        target = OUT / f"{pid}.webp"
        size = compress(image, target)
        width, height = image.size
        ready += 1
        print(f"{pid}: {width}x{height}, {size / 1024:.1f} КБ")

    print(f"\nГотово фото: {ready} из {len(places)}")
    if missing:
        print("Нет исходников для: " + ", ".join(missing))
        print("В приложении для этих мест показывается SVG-заглушка.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
