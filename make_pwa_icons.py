# -*- coding: utf-8 -*-
"""生成手机端 PWA 图标，风格与电脑端 app.ico 一致：
圆角方形 + 深靛蓝→商务蓝对角渐变 + 白色「邢」。
产出（写到 repo/static/）：
  icon-192.png / icon-512.png   圆角、带透明（Android / PWA any）
  apple-touch-icon.png (180)    满幅不透明（iOS 自己会裁圆角，避免黑角）
用法：python make_pwa_icons.py [输出目录]
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont, ImageFilter

SS = 1024
CORNER = int(SS * 0.235)
FONT = r"C:\Windows\Fonts\msyhbd.ttc"
TOP = (0x1B, 0x27, 0x45)   # 深靛蓝
BOT = (0x33, 0x5A, 0xC0)   # 商务蓝
GLYPH = "邢"


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def base_image():
    bg = Image.new("RGB", (SS, SS), TOP)
    px = bg.load()
    for y in range(SS):
        for x in range(SS):
            px[x, y] = lerp(TOP, BOT, (x + y) / (2.0 * SS))
    glow = Image.new("L", (SS, SS), 0)
    ImageDraw.Draw(glow).ellipse([-SS * 0.30, -SS * 0.50, SS * 0.85, SS * 0.55], fill=46)
    glow = glow.filter(ImageFilter.GaussianBlur(SS * 0.12))
    return Image.composite(Image.new("RGB", (SS, SS), (255, 255, 255)), bg, glow)


def draw_glyph(img, scale=0.48):
    d = ImageDraw.Draw(img)
    target = int(SS * scale)
    size = target
    font = ImageFont.truetype(FONT, size)
    for _ in range(24):
        bbox = d.textbbox((0, 0), GLYPH, font=font)
        h = bbox[3] - bbox[1]
        if abs(h - target) <= 4:
            break
        size = max(8, int(size * target / max(1, h)))
        font = ImageFont.truetype(FONT, size)
    bbox = d.textbbox((0, 0), GLYPH, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((SS - w) / 2 - bbox[0], (SS - h) / 2 - bbox[1]), GLYPH, font=font, fill=(255, 255, 255))
    return img


def rounded(img, radius):
    m = Image.new("L", (SS, SS), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, SS - 1, SS - 1], radius=radius, fill=255)
    img = img.convert("RGBA")
    img.putalpha(m)
    return img


def main(outdir=None):
    outdir = outdir or (sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__)))
    os.makedirs(outdir, exist_ok=True)
    art = draw_glyph(base_image(), 0.48)

    # 圆角 + 透明：192 / 512
    rnd = rounded(art, CORNER)
    for s in (192, 512):
        p = os.path.join(outdir, f"icon-{s}.png")
        rnd.resize((s, s), Image.LANCZOS).save(p, optimize=True)
        print("OK", p)

    # iOS：满幅不透明（系统自己裁圆角）
    p = os.path.join(outdir, "apple-touch-icon.png")
    art.convert("RGBA").resize((180, 180), Image.LANCZOS).save(p, optimize=True)
    print("OK", p)

    # 开屏用的大图（页面内启动画面）
    p = os.path.join(outdir, "splash-logo.png")
    rnd.resize((240, 240), Image.LANCZOS).save(p, optimize=True)
    print("OK", p)


if __name__ == "__main__":
    main()
