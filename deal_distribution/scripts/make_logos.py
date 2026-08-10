#!/usr/bin/env python3
# Генератор плейсхолдер-иконок виджета «Распределение сделок».
# Без внешних зависимостей (чистый PNG-энкодер): фон бренд-цвета + центральная метка.
# Размеры строго по требованиям amoCRM/Kommo. Заменить на финальный дизайн перед публикацией.
import zlib
import struct
import os

BRAND = (15, 118, 110)   # teal-700
MARK = (240, 253, 250)   # почти белый

SIZES = {
    "logo_min.png": (84, 84),
    "logo_medium.png": (240, 84),
    "logo.png": (130, 100),
    "logo_main.png": (400, 272),
    "logo_small.png": (108, 108),
    "logo_dp.png": (174, 109),
}


def _chunk(typ: bytes, data: bytes) -> bytes:
    body = typ + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def make_png(w: int, h: int, bg, mark) -> bytes:
    # Центральная «метка» — три точки-стрелки (условно «раздача»): рисуем 3 квадрата по диагонали.
    cx, cy = w / 2, h / 2
    unit = max(4, int(min(w, h) * 0.14))
    dots = [(-1.6, -1.0), (0.0, 0.0), (1.6, 1.0)]  # смещения в «unit»

    def pix(x, y):
        for dx, dy in dots:
            mx, my = cx + dx * unit, cy + dy * unit
            if abs(x - mx) <= unit / 2 and abs(y - my) <= unit / 2:
                return mark
        return bg

    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter 0
        for x in range(w):
            raw += bytes(pix(x, y))
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)  # RGB, 8-bit
    idat = zlib.compress(bytes(raw), 9)
    return sig + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", idat) + _chunk(b"IEND", b"")


def main():
    out = os.path.join(os.path.dirname(__file__), "..", "images")
    os.makedirs(out, exist_ok=True)
    for name, (w, h) in SIZES.items():
        data = make_png(w, h, BRAND, MARK)
        with open(os.path.join(out, name), "wb") as f:
            f.write(data)
        print(f"{name:16} {w}x{h:<4} {len(data)} bytes")


if __name__ == "__main__":
    main()
