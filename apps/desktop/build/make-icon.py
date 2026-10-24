"""Render eNCode's app icon and in-app marks from the logo, the chrome dice in build/logo-source.png.

    python build/make-icon.py          (from apps/desktop; needs Pillow and NumPy)

The source is the dice on a black square. The black around it is taken out so the icon sits on any taskbar or
background: the background is everything dark that joins the edge of the picture, and the soft pixels where the
chrome rim meets it are kept as partly see-through rim rather than as a dark fringe. The dice's own black faces are
inside the rim, so they stay.

Writes build/icon.png (512 px, the window icon), build/icon.ico (16, 20, 24, 32, 40, 48, 64 and 256 px) and
public/brand/mark-{64,128,256}.png, which src/ui/Logo.tsx shows in the title bar, the empty chat and About.
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
SOURCE = HERE / 'logo-source.png'
PUBLIC = HERE.parent / 'public' / 'brand'

# Darker than this and joined to the edge of the picture is background. 40 takes in the soft edge of the rim;
# at 60 the fill would leak through the rim into the black faces.
BACKGROUND_MAX = 40
# At or under this the background is pure black: fully see-through.
BLACK_MAX = 4
# How much of the square the dice fills, top to bottom.
FILL = 0.9
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 256]
MARK_SIZES = [64, 128, 256]


def extract(source: Image.Image) -> Image.Image:
    """The dice alone, as RGBA, cropped to its bounds."""
    rgb = source.convert('RGB')
    lum = rgb.convert('L')

    background = lum.point(lambda v: 0 if v <= BACKGROUND_MAX else 255)
    ImageDraw.floodfill(background, (0, 0), 128)
    outside = np.asarray(background) == 128

    pixels = np.asarray(rgb).astype(np.float32)
    light = np.asarray(lum).astype(np.float32)

    # The colour of the rim next to each soft edge pixel: the brightest dice pixel nearby.
    inside_only = np.where(outside[..., None], 0, pixels).astype(np.uint8)
    rim = np.asarray(Image.fromarray(inside_only).filter(ImageFilter.MaxFilter(7))).astype(np.float32)
    rim_light = np.maximum(rim @ np.array([0.299, 0.587, 0.114], dtype=np.float32), 1.0)

    # A soft edge pixel is the rim over black: its share of the rim's brightness is how much of it is rim.
    edge_alpha = np.clip((light - BLACK_MAX) / np.maximum(rim_light - BLACK_MAX, 1.0), 0.0, 1.0)
    alpha = np.where(outside, edge_alpha, 1.0)
    color = np.where(outside[..., None], rim, pixels)

    rgba = np.dstack([color, alpha * 255.0]).round().clip(0, 255).astype(np.uint8)
    image = Image.fromarray(rgba, 'RGBA')
    return image.crop(image.getbbox())


def square(dice: Image.Image, size: int, fill: float = FILL) -> Image.Image:
    """The dice centred on a clear square of `size` px, `fill` of its height."""
    scale = fill * size / dice.height
    width, height = max(1, round(dice.width * scale)), max(1, round(dice.height * scale))
    # Scaled with the colour premultiplied by alpha, so the clear background does not darken the edge.
    small = dice.convert('RGBa').resize((width, height), Image.LANCZOS, reducing_gap=3.0).convert('RGBA')
    if size <= 48:
        small = small.filter(ImageFilter.UnsharpMask(radius=0.6, percent=60, threshold=1))
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(small, ((size - width) // 2, (size - height) // 2))
    return canvas


def main() -> None:
    dice = extract(Image.open(SOURCE))

    square(dice, 512).save(HERE / 'icon.png', optimize=True)

    frames = [square(dice, size) for size in ICO_SIZES]
    frames[-1].save(HERE / 'icon.ico', format='ICO', sizes=[(size, size) for size in ICO_SIZES], append_images=frames[:-1])

    PUBLIC.mkdir(parents=True, exist_ok=True)
    for size in MARK_SIZES:
        square(dice, size, fill=1.0).save(PUBLIC / f'mark-{size}.png', optimize=True)

    print('wrote build/icon.png, build/icon.ico and public/brand/mark-*.png from build/logo-source.png')


if __name__ == '__main__':
    main()
