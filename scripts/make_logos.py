#!/usr/bin/env python3
"""Генерация набора логотипов для amoCRM-виджета «Поиск и объединение дублей».

Фирменный стиль KO:AGENCY: синий фон, белая графика, гротеск с разрядкой
для вордмарки. Иконка — на тему «дубли/слияние» (две перекрывающиеся
карточки). Создаёт в widget/images/ стандартный набор размеров амоМаркета.
"""
from PIL import Image, ImageDraw, ImageFont

BLUE = (43, 125, 233, 255)
WHITE = (255, 255, 255, 255)
FONT_PATH = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"

SIZES = {
    # logo.png — строго 130x100 по требованию валидатора amoCRM (full-bleed
    # синий + иконка дублей). Полноширинный баннер рисуется в теле виджета
    # через CSS (.dub__banner), а не логотипом.
    "logo.png": (130, 100),
    "logo_min.png": (84, 84),
    "logo_small.png": (108, 108),
    "logo_medium.png": (240, 84),
    "logo_dp.png": (174, 109),
    "logo_main.png": (400, 272),
}


def draw_icon(draw, cx, cy, size):
    """Две перекрывающиеся карточки — метафора дублей/слияния."""
    line_w = max(2, size // 14)
    radius = max(2, size // 12)
    # размер одной карточки и сдвиг второй относительно первой
    card_w = int(size * 0.62)
    card_h = int(size * 0.78)
    shift = int(size * 0.30)

    # верхняя-левая граница блока из двух карточек, центрируем по cx/cy
    total_w = card_w + shift
    total_h = card_h + shift
    left = cx - total_w // 2
    top = cy - total_h // 2

    # задняя карточка (контур)
    bx0, by0 = left, top
    draw.rounded_rectangle(
        [bx0, by0, bx0 + card_w, by0 + card_h],
        radius=radius, outline=WHITE, width=line_w,
    )

    # передняя карточка: сначала «вырезаем» её силуэт на фоне (заливка цветом
    # фона), затем рисуем контур — так задняя карточка не просвечивает сквозь
    fx0, fy0 = left + shift, top + shift
    draw.rounded_rectangle(
        [fx0, fy0, fx0 + card_w, fy0 + card_h],
        radius=radius, fill=BLUE,
    )
    draw.rounded_rectangle(
        [fx0, fy0, fx0 + card_w, fy0 + card_h],
        radius=radius, outline=WHITE, width=line_w,
    )

    # пара строк-«контента» на передней карточке
    pad = max(line_w, card_w // 6)
    row_y1 = fy0 + card_h // 3
    row_y2 = fy0 + (card_h * 2) // 3
    draw.line([(fx0 + pad, row_y1), (fx0 + card_w - pad, row_y1)],
              fill=WHITE, width=line_w)
    draw.line([(fx0 + pad, row_y2), (fx0 + card_w - pad - card_w // 5, row_y2)],
              fill=WHITE, width=line_w)


def draw_tracked_text(draw, text, font, center_x, center_y, tracking):
    """Текст с разрядкой (letter-spacing), как в фирменном написании."""
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
    img = Image.new("RGBA", (w, h), BLUE)
    draw = ImageDraw.Draw(img)

    wide = width / height > 2          # logo_medium 240x84
    large = width >= 300               # logo_main 400x272

    if wide:
        # иконка слева, вордмарка справа
        icon_size = int(h * 0.55)
        icon_cx = int(h * 0.55)
        draw_icon(draw, icon_cx, h // 2, icon_size)
        text_left = icon_cx + icon_size // 2 + int(h * 0.18)
        text_right = w - int(h * 0.18)
        tracking = int(h * 0.02)
        # автоподбор кегля под доступную ширину
        font_size = int(h * 0.30)
        while font_size > 8:
            font = ImageFont.truetype(FONT_PATH, font_size)
            total = sum(draw.textlength(ch, font=font) for ch in "KO:AGENCY") + tracking * 8
            if total <= text_right - text_left:
                break
            font_size -= 2
        draw_tracked_text(draw, "KO:AGENCY", font, (text_left + text_right) / 2, h // 2, tracking)
    elif large:
        # иконка по центру, вордмарка под ней
        icon_size = int(h * 0.48)
        draw_icon(draw, w // 2, int(h * 0.40), icon_size)
        font = ImageFont.truetype(FONT_PATH, int(h * 0.115))
        draw_tracked_text(draw, "KO:AGENCY", font, w // 2, int(h * 0.78), int(h * 0.012))
    else:
        # компактные форматы: только иконка
        icon_size = int(min(w, h) * 0.60)
        draw_icon(draw, w // 2, h // 2, icon_size)

    img = img.resize((width, height), Image.LANCZOS)
    img.save(path)
    print(f"{path}: {width}x{height}")


if __name__ == "__main__":
    import os
    out_dir = os.path.join(os.path.dirname(__file__), "..", "widget", "images")
    os.makedirs(out_dir, exist_ok=True)
    for name, (width, height) in SIZES.items():
        make_logo(os.path.join(out_dir, name), width, height)
