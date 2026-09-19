# -*- coding: utf-8 -*-
"""生成 PWA 图标：icon-192 / icon-512 / icon-maskable
用法：python scripts/generate_icons.py

配色沿用用户原图：深蓝 #003058、青 #19BCC3。
图形只用两个元素 —— 粗体 ¥ 加一条青色横条。这不是偷懒：
图标在手机桌面上实际只显示约 48px，元素一多就糊成一团。
（前一版原图有折线图、两条横杠、橙色方块、右下角箭头五个元素，
缩到 48px 完全认不出来，而且内容出血被切掉了边缘。）
横条同时呼应 App 里最核心的视觉 —— 预算进度条。
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', 'icons'))
os.makedirs(OUT, exist_ok=True)

NAVY = (0, 48, 88)        # #003058
NAVY_LIGHT = (0, 74, 124)  # 渐变用的亮端
TEAL = (25, 188, 195)     # #19BCC3
WHITE = (255, 255, 255)

# Arial Black 最粗，缩到 48px 时笔画不会糊掉
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\ariblk.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\seguibl.ttf",
    r"C:\Windows\Fonts\msyhbd.ttc",
]
FONT = next((p for p in FONT_CANDIDATES if os.path.exists(p)), None)
if not FONT:
    raise SystemExit("未找到可用字体")


def background(size, radius_ratio=0.0):
    """深蓝底 + 极淡的竖向渐变，避免大色块发死。
    radius_ratio=0 表示铺满（maskable 必须铺满，裁切由系统做）。"""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if radius_ratio > 0:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=NAVY)
    else:
        d.rectangle([0, 0, size - 1, size - 1], fill=NAVY)

    grad = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    gp = grad.load()
    for y in range(size):
        alpha = int(26 * (y / max(1, size - 1)))
        for x in range(size):
            gp[x, y] = (NAVY_LIGHT[0], NAVY_LIGHT[1], NAVY_LIGHT[2], alpha)
    return Image.alpha_composite(img, grad)


def draw_mark(img, size, scale=1.0):
    """¥ + 青色横条，整体按 scale 缩放（maskable 要缩进安全区）"""
    d = ImageDraw.Draw(img)
    cx = size / 2

    yen_size = size * 0.46 * scale
    font = ImageFont.truetype(FONT, int(yen_size))
    # anchor='mm' 对齐的是字体度量框，Arial Black 的 ¥ 视觉重心偏上，往上抬一点点补偿
    d.text((cx, size / 2 - size * 0.055 * scale), '¥', font=font, fill=WHITE, anchor='mm')

    bar_w = int(size * 0.40 * scale)
    bar_h = max(2, int(size * 0.056 * scale))
    bar_y = int(size / 2 + size * 0.185 * scale)
    d.rounded_rectangle(
        [(size - bar_w) / 2, bar_y, (size + bar_w) / 2, bar_y + bar_h],
        radius=bar_h / 2, fill=TEAL,
    )
    return img


def make(size, rounded=True, scale=1.0):
    # 有圆角的版本用蒙版裁，避免先画圆角矩形再叠渐变把圆角糊掉
    img = background(size, 0.0 if not rounded else 0.0)
    img = draw_mark(img, size, scale)
    if rounded:
        mask = Image.new('L', (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
        img.putalpha(mask)
    return img


# any：自带圆角，桌面上就是个圆角方块
make(192).save(os.path.join(OUT, 'icon-192.png'))
make(512).save(os.path.join(OUT, 'icon-512.png'))
# maskable：铺满不留圆角，图形缩到安全区内。
# 安卓会按自己的形状（圆形/圆角方形/水滴）裁切，安全区是直径 80% 的同心圆，
# 所以图形整体缩到 0.62 —— 留足余量，任何裁法都不会切到 ¥ 和横条。
make(512, rounded=False, scale=0.62).save(os.path.join(OUT, 'icon-maskable.png'))

print('icons generated:', sorted(os.listdir(OUT)))
