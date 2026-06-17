#!/usr/bin/env python3
"""Генерация набора логотипов KO:AGENCY для виджета «Hidden Field».

Фирменный стиль KO:AGENCY: красный фон, белая графика, гротеск для вордмарки.
Иконка — чеклист (тема «видимость/скрытие полей»): чекбокс с галочкой и
строки-«поля». Создаёт в hidden_field/images/ стандартный набор размеров amoCRM
(logo.png строго 130x100 по требованию валидатора) + logo_main.png 400x272,
который можно загрузить баннером интеграции.

Запуск: python3 scripts/make_logos.py   (нужен Pillow: pip install Pillow)
"""
from PIL import Image, ImageDraw, ImageFont

RED = (227, 6, 19, 255)
WHITE = (255, 255, 255, 255)
FONT_PATH = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"

SIZES = {
    "logo.png": (130, 100),       # строго 130x100 — требование валидатора amoCRM
    "logo_min.png": (84, 84),
    "logo_small.png": (108, 108),
    "logo_medium.png": (240, 84),
    "logo_dp.png": (174, 109),
    "logo_main.png": (400, 272),  # годится баннером интеграции (400x272)
}


def draw_icon(draw, cx, cy, size):
    """Чеклист: чекбокс с галочкой + строки-поля (метафора видимости полей)."""
    line_w = max(2, int(size / 14))
    left = cx - size / 2
    top = cy - size / 2
    rows = 3
    gap = size / rows
    box = gap * 0.62
    radius = max(1, int(box * 0.14))
    line_x0 = left + box + box * 0.55
    line_x1 = left + size

    for i in range(rows):
        ry = top + i * gap + (gap - box) / 2
        draw.rounded_rectangle(
            [left, ry, left + box, ry + box], radius=radius, outline=WHITE, width=line_w
        )
        ly = ry + box / 2
        # последняя строка короче — для «живости», как в реальном логотипе
        seg = line_x1 if i != rows - 1 else line_x1 - (line_x1 - line_x0) * 0.35
        draw.line([(line_x0, ly), (seg, ly)], fill=WHITE, width=line_w)

    # галочка в верхнем чекбоксе
    by0 = top + (gap - box) / 2
    draw.line(
        [
            (left + box * 0.20, by0 + box * 0.52),
            (left + box * 0.42, by0 + box * 0.72),
            (left + box * 0.80, by0 + box * 0.26),
        ],
        fill=WHITE,
        width=line_w,
        joint="curve",
    )


def draw_tracked_text(draw, text, font, center_x, center_y, tracking):
    widths = [draw.textlength(ch, font=font) for ch in text]
    total = sum(widths) + tracking * (len(text) - 1)
    ascent, descent = font.getmetrics()
    x = center_x - total / 2
    y = center_y - (ascent + descent) / 2
    for ch, w in zip(text, widths):
        draw.text((x, y), ch, font=font, fill=WHITE)
        x += w + tracking


def make_logo(path, width, height):
    scale = 4  # рисуем в 4x и уменьшаем для сглаживания
    w, h = width * scale, height * scale
    img = Image.new("RGBA", (w, h), RED)
    draw = ImageDraw.Draw(img)

    wide = width / height > 2          # logo_medium 240x84
    large = width >= 300               # logo_main 400x272

    if wide:
        icon_size = int(h * 0.62)
        icon_cx = int(h * 0.58)
        draw_icon(draw, icon_cx, h // 2, icon_size)
        text_left = icon_cx + icon_size // 2 + int(h * 0.18)
        text_right = w - int(h * 0.16)
        tracking = int(h * 0.015)
        font_size = int(h * 0.34)
        while font_size > 8:
            font = ImageFont.truetype(FONT_PATH, font_size)
            total = sum(draw.textlength(ch, font=font) for ch in "KO:AGENCY") + tracking * 8
            if total <= text_right - text_left:
                break
            font_size -= 2
        draw_tracked_text(draw, "KO:AGENCY", font, (text_left + text_right) / 2, h // 2, tracking)
    elif large:
        icon_size = int(h * 0.42)
        draw_icon(draw, w // 2, int(h * 0.38), icon_size)
        font = ImageFont.truetype(FONT_PATH, int(h * 0.13))
        draw_tracked_text(draw, "KO:AGENCY", font, w // 2, int(h * 0.76), int(h * 0.01))
    else:
        icon_size = int(min(w, h) * 0.64)
        draw_icon(draw, w // 2, h // 2, icon_size)

    img = img.resize((width, height), Image.LANCZOS)
    img.save(path)
    print(f"{path}: {width}x{height}")


if __name__ == "__main__":
    import os

    out_dir = os.path.join(os.path.dirname(__file__), "..", "images")
    os.makedirs(out_dir, exist_ok=True)
    for name, (width, height) in SIZES.items():
        make_logo(os.path.join(out_dir, name), width, height)
