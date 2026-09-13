# 生成 PWA 图标：icon-192 / icon-512 / icon-maskable
# 用法：python scripts/generate_icons.py
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', 'icons'))
os.makedirs(OUT, exist_ok=True)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\arial.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\segoeui.ttf",
    r"C:\Windows\Fonts\msyh.ttc",
]
FONT = next((p for p in FONT_CANDIDATES if os.path.exists(p)), None)
if not FONT:
    raise SystemExit("未找到可用字体")


def gradient(size):
    top = (90, 118, 255)    # #5A76FF
    bottom = (79, 110, 247)  # #4F6EF7
    img = Image.new('RGBA', (size, size))
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        r = int(top[0] + (bottom[0] - top[0]) * t)
        g = int(top[1] + (bottom[1] - top[1]) * t)
        b = int(top[2] + (bottom[2] - top[2]) * t)
        for x in range(size):
            px[x, y] = (r, g, b, 255)
    return img


def round_corners(img, ratio=0.22):
    size = img.width
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * ratio), fill=255
    )
    img.putalpha(mask)
    return img


def draw_yen(img, ratio):
    size = img.width
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, int(size * ratio))
    draw.text((size / 2, size / 2), '¥', font=font, fill=(255, 255, 255, 255), anchor='mm')
    return img


def make(size, rounded=True, yen_ratio=0.62):
    img = gradient(size)
    if rounded:
        img = round_corners(img)
    return draw_yen(img, yen_ratio)


make(192).save(os.path.join(OUT, 'icon-192.png'))
make(512).save(os.path.join(OUT, 'icon-512.png'))
make(512, rounded=False, yen_ratio=0.46).save(os.path.join(OUT, 'icon-maskable.png'))
print('icons generated:', os.listdir(OUT))
