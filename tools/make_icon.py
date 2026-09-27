"""Иконка проекта из фотографии.

Фотография квадратная (1254x1254), поэтому обрезка не нужна: размеры
получаются простым изменением. Скрипт кладёт иконку в корень репозитория,
потому что собранная страница — один файл index.html, и отдельную картинку
можно положить только рядом с ним.

Запуск: python tools/make_icon.py <путь к исходнику>
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
FALLBACK = Path.home() / "Downloads"

SIZES = {
    "icon-512.png": 512,
    "icon-256.png": 256,
    "icon-192.png": 192,
    "apple-touch-icon.png": 180,
    "icon-64.png": 64,
}

# Тот же тёмный камень, что и страница: в браузере иконка sits на
# тёмной панели, и рамка из прозрачности выглядела бы осколком.
FRAME = (13, 14, 13, 255)
RADIUS_RATIO = 0.18


def find_source(arg: str | None) -> Path:
    if arg:
        path = Path(arg)
        if not path.exists():
            raise SystemExit(f"Файл не найден: {path}")
        return path
    candidates = sorted(FALLBACK.glob("*.png"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not candidates:
        raise SystemExit("Укажите путь к фотографии: python tools/make_icon.py <файл>")
    return candidates[0]


def square(image: Image.Image) -> Image.Image:
    """Приводит к квадрату по центру, если исходник не квадратный."""
    side = min(image.size)
    left = (image.width - side) // 2
    top = (image.height - side) // 2
    return image.crop((left, top, left + side, top + side))


def framed(image: Image.Image, size: int) -> Image.Image:
    inner = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    radius = int(size * RADIUS_RATIO)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    photo = image.resize((size, size), Image.LANCZOS).convert("RGBA")
    inner.paste(photo, (0, 0), mask)
    # Тонкая рамка цвета фона отделяет иконку от тёмной панели вкладки.
    edge = ImageDraw.Draw(inner)
    edge.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, outline=FRAME, width=max(1, size // 128))
    return inner


def main() -> int:
    src = find_source(sys.argv[1] if len(sys.argv) > 1 else None)
    print(f"источник: {src.name}")
    with Image.open(src) as original:
        base = square(original.convert("RGB"))
        print(f"исходник: {original.size[0]}x{original.size[1]}, после обрезки {base.size[0]}x{base.size[1]}")
        for name, size in SIZES.items():
            out = ROOT / name
            framed(base, size).save(out, "PNG", optimize=True)
            print(f"  {name:<24} {size}x{size}  {out.stat().st_size / 1024:.1f} КБ")

    # favicon.ico: ICO хранит несколько размеров сразу. PIL сам уменьшает
    # переданное изображение до каждого size, поэтому отдаём ему большое.
    ico = ROOT / "favicon.ico"
    framed(base, 512).save(ico, "ICO", sizes=[(16, 16), (32, 32), (48, 48)])
    print(f"  {'favicon.ico':<24} 16/32/48  {ico.stat().st_size / 1024:.1f} КБ")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
