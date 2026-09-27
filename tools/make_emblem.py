"""Эмблема (герб) из присланной фотографии.

Фотография — это герб, отпечатанный на белом листе. Белое занимает почти
половину площади, причём в двух видах: поля листа снаружи и серебряное
поле щита внутри. На тёмном фоне и то и другое выглядит белым квадратом.

Раньше пробовали убирать белый порогом, но серебряное поле щита окружено
контуром и до края не связано, поэтому порог его не трогал: в круглом
значке прозрачность обрезалась и оставался светлый круг. Теперь белое
ищется по признаку "светлое И бесцветное" (низкая насыщенность), а
красный льва и золото, насыщенные по цвету, остаются на месте.

Результат кладётся в img/ и потом встраивается в страницу сборкой.

Запуск: python tools/make_emblem.py <путь к фотографии>
"""

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
FALLBACK_DIR = Path.home() / "Downloads"

SIZES = {
    "emblem-256.webp": 256,
    "emblem-128.webp": 128,
}

# Порог отсечки бумаги и серебра.
WHITE_V = 0.62  # яркость выше — считаем белым
WHITE_S = 0.18  # насыщенность ниже — считаем бесцветным
PAPER_T = 238   # строгий порог только для поиска границ обрезки


def find_source(arg: str | None) -> Path:
    if arg:
        path = Path(arg)
        if not path.exists():
            raise SystemExit(f"Файл не найден: {path}")
        return path
    pngs = sorted(FALLBACK_DIR.glob("*.png"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not pngs:
        raise SystemExit("Укажите путь: python tools/make_emblem.py <файл>")
    return pngs[0]


def content_box(image: Image.Image):
    """Прямоугольник всего, что не бумага — по нему отрезаем поля."""
    w, h = image.size
    px = image.load()
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if not (r >= PAPER_T and g >= PAPER_T and b >= PAPER_T):
                if x < minx:
                    minx = x
                if x > maxx:
                    maxx = x
                if y < miny:
                    miny = y
                if y > maxy:
                    maxy = y
    if maxx < 0:
        raise SystemExit("На фото нет ничего, кроме белого листа")
    return minx, miny, maxx + 1, maxy + 1


def square(image: Image.Image) -> Image.Image:
    side = min(image.size)
    left = (image.width - side) // 2
    top = (image.height - side) // 2
    return image.crop((left, top, left + side, top + side))


def cut_white(image: Image.Image) -> Image.Image:
    """Прозрачным делаем светлое бесцветное: и бумагу, и серебро щита.

    Насыщенность считаем по HSV: у золота и багреца она высокая, поэтому
    они отсечку не проходят, даже когда светлые.
    """
    out = image.convert("RGBA")
    px = out.load()
    w, h = out.size
    removed = 0
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y][:3]
            v = max(r, g, b) / 255
            lo = min(r, g, b) / 255
            s = 0.0 if v == 0 else (v - lo) / v
            if v > WHITE_V and s < WHITE_S:
                px[x, y] = (0, 0, 0, 0)
                removed += 1
    print(f"  прозрачным сделано: {100 * removed / (w * h):.1f}% площади")
    return out


def feather(cut: Image.Image) -> Image.Image:
    """Один пиксель полупрозрачности по краю, чтобы не было ступеньки."""
    alpha = cut.getchannel("A")
    w, h = cut.size
    px = alpha.load()
    updates = []
    for y in range(w and 1 or 1, h - 1):
        for x in range(1, w - 1):
            if px[x, y] == 0:
                continue
            empty = sum(1 for d in ((-1, 0), (1, 0), (0, -1), (0, 1)) if px[x + d[0], y + d[1]] == 0)
            if empty:
                updates.append((x, y, max(0, 255 - empty * 70)))
    for x, y, value in updates:
        px[x, y] = value
    return cut


def main() -> int:
    src = find_source(sys.argv[1] if len(sys.argv) > 1 else None)
    print(f"источник: {src.name}")
    with Image.open(src) as original:
        image = original.convert("RGB")
        print(f"исходник: {original.size[0]}x{original.size[1]}")
        box = content_box(image)
        print(f"содержимое: x {box[0]}..{box[2]}, y {box[1]}..{box[3]}")
        image = square(image.crop(box))
        cut = feather(cut_white(image))

    for name, size in SIZES.items():
        out = ROOT / "img" / name
        cut.resize((size, size), Image.LANCZOS).save(out, "WEBP", quality=92, method=6)
        print(f"  {name:<18} {size}x{size}  {out.stat().st_size / 1024:.1f} КБ")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
