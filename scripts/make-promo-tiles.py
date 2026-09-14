#!/usr/bin/env python3
"""Generates the Chrome Web Store promo tiles (440x280 and 1400x560) from icons/icon128.png."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os, sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
OUT = os.path.join(ROOT, "store-assets", "final")
os.makedirs(OUT, exist_ok=True)

BG = (15, 15, 19)
TEXT = (232, 232, 240)
MUTED = (136, 136, 160)
ACCENT = (124, 106, 247)
ACCENT2 = (167, 139, 250)

CANDIDATES = {
    "bold": ["/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/HelveticaNeue.ttc", "/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"],
    "regular": ["/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/HelveticaNeue.ttc", "/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Supplemental/Arial.ttf"],
}

def font(kind, size):
    for path in CANDIDATES[kind]:
        if not os.path.exists(path):
            continue
        try:
            f = ImageFont.truetype(path, size)
            try:
                f.set_variation_by_name("Bold" if kind == "bold" else "Regular")
            except Exception:
                if kind == "bold" and path.endswith(".ttc"):
                    try: f = ImageFont.truetype(path, size, index=1)
                    except Exception: pass
            return f
        except Exception:
            continue
    return ImageFont.load_default()

def tile(w, h, scale, name):
    img = Image.new("RGB", (w, h), BG)

    # soft purple glow behind the icon
    glow = Image.new("RGB", (w, h), BG)
    gd = ImageDraw.Draw(glow)
    r = int(w * 0.32)
    gd.ellipse([w // 2 - r - int(w * 0.16), h // 2 - r, w // 2 + r - int(w * 0.16), h // 2 + r], fill=(48, 42, 88))
    glow = glow.filter(ImageFilter.GaussianBlur(int(w * 0.12)))
    img = Image.blend(img, glow, 0.9)

    icon_px = int(112 * scale)
    icon = Image.open(os.path.join(ROOT, "icons", "icon128.png")).convert("RGBA").resize((icon_px, icon_px), Image.LANCZOS)

    name_font = font("bold", int(58 * scale))
    tag_font = font("regular", max(14, int(19 * scale)))
    pill_font = font("bold", max(10, int(11 * scale)))
    d = ImageDraw.Draw(img)

    title = "Signal"
    tagline = "Track any researcher. Get every new paper."
    pill = "CHROME SIDE PANEL"
    gap = int(28 * scale)
    tw = d.textlength(title, font=name_font)
    tagw = d.textlength(tagline, font=tag_font)
    text_w = int(max(tw, tagw))
    total_w = icon_px + gap + text_w
    x0 = (w - total_w) // 2

    # icon with shadow
    shadow = Image.new("RGBA", (icon_px + 80, icon_px + 80), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle([40, 52, 40 + icon_px, 52 + icon_px], radius=int(26 * scale), fill=(124, 106, 247, 150))
    shadow = shadow.filter(ImageFilter.GaussianBlur(int(18 * scale)))
    iy = (h - icon_px) // 2
    img.paste(shadow, (x0 - 40, iy - 40), shadow)
    img.paste(icon, (x0, iy), icon)

    # text block, vertically centred
    tx = x0 + icon_px + gap
    name_h = name_font.getbbox(title)[3]
    tag_h = tag_font.getbbox(tagline)[3]
    pill_h = int(22 * scale)
    block_h = name_h + int(12 * scale) + tag_h + int(16 * scale) + pill_h
    ty = (h - block_h) // 2 - int(6 * scale)

    d.text((tx, ty), title, font=name_font, fill=TEXT)
    ty += name_h + int(12 * scale)
    d.text((tx, ty), tagline, font=tag_font, fill=MUTED)
    ty += tag_h + int(16 * scale)
    pw = int(d.textlength(pill, font=pill_font)) + int(22 * scale)
    d.rounded_rectangle([tx, ty, tx + pw, ty + pill_h], radius=pill_h // 2, fill=(35, 32, 58), outline=(70, 62, 120))
    d.text((tx + int(11 * scale), ty + (pill_h - pill_font.getbbox(pill)[3]) // 2 - 1), pill, font=pill_font, fill=ACCENT2)

    path = os.path.join(OUT, name)
    img.save(path, optimize=True)
    print(f"✓ {os.path.relpath(path, ROOT)} {img.size[0]}x{img.size[1]}")

tile(440, 280, 0.62, "promo-small-440x280.png")
tile(1400, 560, 1.5, "promo-marquee-1400x560.png")
