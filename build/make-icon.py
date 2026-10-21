"""Generate the eNCode app icon (PNG + multi-size ICO) with Pillow."""
from PIL import Image, ImageDraw, ImageFont

SIZE = 512
img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))

gradient = Image.new('RGB', (SIZE, SIZE))
pixels = gradient.load()
for y in range(SIZE):
    for x in range(SIZE):
        t = (x * 0.35 + y * 0.65) / (SIZE - 1)
        pixels[x, y] = (
            int(107 * (1 - t) + 63 * t),
            int(155 * (1 - t) + 111 * t),
            int(255 * (1 - t) + 224 * t),
        )

mask = Image.new('L', (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=116, fill=255)
img.paste(gradient, (0, 0), mask)

font = ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', 258)
draw = ImageDraw.Draw(img)
text = 'eN'
bbox = draw.textbbox((0, 0), text, font=font)
width = bbox[2] - bbox[0]
height = bbox[3] - bbox[1]
draw.text(
    ((SIZE - width) / 2 - bbox[0], (SIZE - height) / 2 - bbox[1] - 6),
    text,
    font=font,
    fill=(255, 255, 255, 255),
)

img.save('build/icon.png')
img.save('build/icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('wrote build/icon.png and build/icon.ico (eN monogram)')
