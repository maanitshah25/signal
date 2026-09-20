"""Generate Signal's toolbar icons from the approved brand colors."""

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "icons"
CANVAS = 1024


def build_icon() -> Image.Image:
    image = Image.new("RGBA", (CANVAS, CANVAS), "#F5F1E8")
    draw = ImageDraw.Draw(image)

    draw.rounded_rectangle(
        (80, 80, 944, 944),
        radius=144,
        fill="#E6F1F7",
        outline="#4F93BD",
        width=48,
    )

    # A geometric S remains legible at Chrome's 16 px toolbar size.
    draw.line(
        [(696, 336), (568, 280), (424, 304), (328, 392), (344, 488),
         (424, 536), (592, 568), (680, 624), (688, 712), (624, 776),
         (504, 792), (384, 752), (312, 688)],
        fill="#2F6F98",
        width=80,
        joint="curve",
    )
    return image


def main() -> None:
    master = build_icon()
    for size in (16, 48, 128):
        output = master.resize((size, size), Image.Resampling.LANCZOS)
        output.save(ICON_DIR / f"icon{size}.png", optimize=True)


if __name__ == "__main__":
    main()
