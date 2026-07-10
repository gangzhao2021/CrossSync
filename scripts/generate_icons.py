from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "app" / "static"


def build_icon(size: int, name: str) -> None:
    image = Image.new("RGB", (size, size), "#143d35")
    draw = ImageDraw.Draw(image)
    margin = round(size * 0.08)
    radius = round(size * 0.22)
    draw.rounded_rectangle(
        (margin, margin, size - margin, size - margin),
        radius=radius,
        fill="#247c6d",
    )
    draw.ellipse(
        (round(size * 0.66), round(size * 0.10), round(size * 0.88), round(size * 0.32)),
        fill="#8ce1cf",
    )
    try:
        font = ImageFont.truetype("arialbd.ttf", round(size * 0.34))
    except OSError:
        font = ImageFont.load_default()
    text = "CS"
    box = draw.textbbox((0, 0), text, font=font)
    width = box[2] - box[0]
    height = box[3] - box[1]
    draw.text(
        ((size - width) / 2, (size - height) / 2 - box[1]),
        text,
        fill="#fffefa",
        font=font,
    )
    image.save(STATIC / name, "PNG", optimize=True)


if __name__ == "__main__":
    build_icon(180, "app-icon-180.png")
    build_icon(192, "app-icon-192.png")
    build_icon(512, "app-icon-512.png")
