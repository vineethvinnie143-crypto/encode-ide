"""Render the eNCode app icon, "Trace N", from the same geometry as build/icon.svg.

    python build/make-icon.py          (from apps/desktop; needs Pillow)

Writes build/icon.png (512 px) and build/icon.ico (16, 20, 24, 32, 40, 48, 64
and 256 px). Sizes under 20 px use the one-colour glyph without the tile, which
stays legible where the tile would turn to mush.
"""
from PIL import Image, ImageChops, ImageDraw

SCALE = 8  # draw at 8 x 256 = 2048 px, then scale down
S = 256 * SCALE

TILE_TOP, TILE_BOTTOM = (0x1D, 0x23, 0x30), (0x0B, 0x0C, 0x10)
LINE_START, LINE_END = (0x5B, 0x8C, 0xFF), (0x3F, 0xD6, 0xEE)
GLYPH = (0x5B, 0x8C, 0xFF)

# The N: one line from the bottom-left node to the top-right node.
PATH = [(80, 180), (80, 76), (176, 180), (176, 76)]
START_NODE, END_NODE = (80, 180), (176, 76)


def px(value):
    return value * SCALE


def ramp(length, value_at):
    """A 1 x length strip whose pixel i holds value_at(i) (0..255)."""
    strip = Image.new('L', (length, 1))
    strip.putdata([max(0, min(255, round(value_at(i)))) for i in range(length)])
    return strip


def stroke_mask(width, node_radius=None):
    """The N as a mask: round joins and round caps, optionally with node dots."""
    mask = Image.new('L', (S, S), 0)
    draw = ImageDraw.Draw(mask)
    points = [(px(x), px(y)) for x, y in PATH]
    draw.line(points, fill=255, width=px(width), joint='curve')
    for x, y in (points[0], points[-1]):
        r = px(width) / 2
        draw.ellipse([x - r, y - r, x + r, y + r], fill=255)
    if node_radius:
        for x, y in (START_NODE, END_NODE):
            r = px(node_radius)
            draw.ellipse([px(x) - r, px(y) - r, px(x) + r, px(y) + r], fill=255)
    return mask


def solid(color):
    return Image.new('RGB', (S, S), color)


def tile_icon():
    icon = Image.new('RGBA', (S, S), (0, 0, 0, 0))

    # Graphite tile, lighter at the top.
    vertical = ramp(S, lambda i: 255 * i / (S - 1)).rotate(-90, expand=True).resize((S, S), Image.NEAREST)
    tile = Image.composite(solid(TILE_BOTTOM), solid(TILE_TOP), vertical)
    shape = Image.new('L', (S, S), 0)
    ImageDraw.Draw(shape).rounded_rectangle([0, 0, S - 1, S - 1], radius=px(58), fill=255)
    icon.paste(tile, (0, 0), shape)

    # A faint light edge, so the tile holds on a dark taskbar.
    edge = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle(
        [0, 0, S - 1, S - 1], radius=px(58), outline=(255, 255, 255, round(0.14 * 255)), width=px(3)
    )
    icon.alpha_composite(edge)

    # The line's gradient runs along the diagonal of the N's box, as in the SVG.
    across = ramp(S, lambda i: 255 * (i / SCALE - 80) / 96).resize((S, S), Image.NEAREST)
    up = ramp(S, lambda i: 255 * (180 - i / SCALE) / 104).rotate(-90, expand=True).resize((S, S), Image.NEAREST)
    along = ImageChops.add(across, up, scale=2.0)
    line = Image.composite(solid(LINE_END), solid(LINE_START), along).convert('RGBA')
    line.putalpha(stroke_mask(22))
    icon.alpha_composite(line)

    # The two nodes: the request and the working code.
    draw = ImageDraw.Draw(icon)
    for (x, y), color in ((START_NODE, LINE_START), (END_NODE, LINE_END)):
        r = px(17)
        draw.ellipse([px(x) - r, px(y) - r, px(x) + r, px(y) + r], fill=color + (255,))
    return icon


def glyph_icon():
    glyph = solid(GLYPH).convert('RGBA')
    glyph.putalpha(stroke_mask(26, node_radius=20))
    return glyph


def scaled(image, size):
    return image.resize((size, size), Image.LANCZOS)


tile = tile_icon()
glyph = glyph_icon()

scaled(tile, 512).save('build/icon.png')

ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 256]
frames = [scaled(glyph if size < 20 else tile, size) for size in ICO_SIZES]
frames[-1].save(
    'build/icon.ico',
    sizes=[(size, size) for size in ICO_SIZES],
    append_images=frames[:-1],
)
print('wrote build/icon.png and build/icon.ico (Trace N)')
