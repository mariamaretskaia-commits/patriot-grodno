"""Подготавливает значки из изображений с шахматным фоном.

Берёт исходники (обычно 1024x1024 JPEG с шахматным/белым фоном),
убирает фон заливкой от краёв, центрирует содержимое в квадрат и
сохраняет как 128x128 WebP с прозрачностью — как остальные значки.

Запуск:  python tools/make_badges.py
"""

import sys
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
BADGES = ROOT / "img" / "badges"

# badge_id -> исходный файл. Порядок соответствует тексту пользователя.
SOURCES = {
    "explorer": Path.home() / "Downloads" / "Gemini_Generated_Image_t60y67t60y67t60y.jpg",
    "expert": Path.home() / "Downloads" / "Gemini_Generated_Image_wopdwjwopdwjwopd.jpg",
}

SIZE = 128
# Пиксель — фон, если он светлый и почти без хроматического сдвига:
# так шахматка (белый/серый) отделяется от тёплой «золотистой» графики.
MIN_NEUTRAL = 168
MAX_SPREAD = 20
# Блохи заполнения меньше доли от крупнейшего компонента — шум, их выкидываем.
MIN_COMPONENT_RATIO = 0.005


def candidate(pixel):
    r, g, b = pixel
    return min(r, g, b) >= MIN_NEUTRAL and max(r, g, b) - min(r, g, b) <= MAX_SPREAD


def flood_fill(mask, width, height):
    """Помечает True все точки, достижимые от краёв по фону."""
    stack = []
    for x in range(width):
        stack += [(x, 0), (x, height - 1)]
    for y in range(height):
        stack += [(0, y), (width - 1, y)]
    done = set()
    while stack:
        x, y = stack.pop()
        if (x, y) in done:
            continue
        done.add((x, y))
        if not mask[y][x]:
            continue
        if x < width - 1:
            stack.append((x + 1, y))
        if x > 0:
            stack.append((x - 1, y))
        if y < height - 1:
            stack.append((x, y + 1))
        if y > 0:
            stack.append((x, y - 1))
    return done


def largest_components(mask, width, height):
    """Возвращает множество пикселей крупнейших связанных областей маски."""
    seen = set()
    components = []
    for y in range(height):
        for x in range(width):
            if not mask[y][x] or (x, y) in seen:
                continue
            stack = [(x, y)]
            seen.add((x, y))
            size = 0
            cells = []
            while stack:
                cx, cy = stack.pop()
                size += 1
                cells.append((cx, cy))
                for nx, ny in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)):
                    if 0 <= nx < width and 0 <= ny < height and mask[ny][nx] and (nx, ny) not in seen:
                        seen.add((nx, ny))
                        stack.append((nx, ny))
            components.append((size, cells))
    if not components:
        return set()
    top = max(size for size, _ in components)
    keep = set()
    for size, cells in components:
        if size >= top * MIN_COMPONENT_RATIO:
            keep.update(cells)
    return keep


def cut(path: Path, out: Path) -> None:
    with Image.open(path) as original:
        image = original.convert("RGB")
    width, height = image.size
    px = image.load()

    mask = [[candidate(px[x, y]) for x in range(width)] for y in range(height)]
    filled = flood_fill(mask, width, height)
    # Фон: заливка от краёв. Содержимое — всё остальное.
    content = [[not (x, y) in filled for x in range(width)] for y in range(height)]
    content = largest_components(content, width, height)
    if not content:
        raise SystemExit(f"В {path.name} не найдено содержимое — фон неудачно распознан.")

    # Альфа-маска с мягкой кромкой: лёгкое размытие убирает «зазубрины» JPEG.
    alpha = Image.new("L", (width, height), 0)
    for y in range(height):
        for x in range(width):
            if (x, y) in content:
                alpha.putpixel((x, y), 255)
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.8))

    min_x = min(x for x, _ in content)
    max_x = max(x for x, _ in content)
    min_y = min(y for y, _ in content)
    max_y = max(y for y, _ in content)
    inner = (min_x, min_y, max_x + 1, max_y + 1)

    # Квадрат по содержимому с полем 6% и центрированием.
    side = max(max_x - min_x, max_y - min_y)
    margin = round(side * 0.06)
    canvas = side + margin * 2
    x0 = (side - (max_x - min_x)) // 2
    y0 = (side - (max_y - min_y)) // 2

    square = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    square.paste(image.crop(inner), (x0 + margin, y0 + margin))
    alpha_layer = Image.new("L", (canvas, canvas), 0)
    alpha_layer.paste(alpha.crop(inner), (x0 + margin, y0 + margin))
    square.putalpha(alpha_layer)
    square = square.resize((SIZE, SIZE), Image.LANCZOS)

    BADGES.mkdir(parents=True, exist_ok=True)
    square.save(out, "WEBP", quality=92, method=6)

    # Диагностика: доля непрозрачных пикселей и охват содержимого.
    opaque = sum(1 for p in square.getdata() if p[3] > 128)
    area = (max_x - min_x + 1) * (max_y - min_y + 1)
    print(f"{out.name}: src {width}x{height}, bbox {area / (width * height) * 100:.0f}% "
          f"кадра, прозрачных {100 - opaque / (SIZE * SIZE) * 100:.0f}%")


def main() -> int:
    ok = 0
    for badge_id, source in SOURCES.items():
        if not source.exists():
            print(f"Нет исходника для {badge_id}: {source}")
            continue
        cut(source, BADGES / f"{badge_id}.webp")
        ok += 1
    print(f"\nЗначков готово: {ok} из {len(SOURCES)}")
    return 0 if ok == len(SOURCES) else 1


if __name__ == "__main__":
    sys.exit(main())