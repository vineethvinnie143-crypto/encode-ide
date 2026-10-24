# 0107. The chrome dice is the logo, and the theme is black and silver from it

- Status: Accepted, supersedes the logo and default colours of 0013
- Date: 2026-10-24

## Context

The owner chose a new logo: a black dice with a chrome rim and white pips, with `</>` on its top face, drawn on a
black square, and asked for it to be the app's logo and for the theme to move from the navy-tinted Graphite of 0013 to
black, with the logo's colours as the reference. Trace N, its blue-to-cyan gradient and the Signal blue accent were
the old brand.

The logo is a rendered picture (chrome reflections, soft edges), not a drawing of lines, so it cannot be redrawn in a
few SVG paths without losing what makes it the logo. It also comes on a black square, which would show as a black tile
on a light taskbar or a grey one.

## Decision

### The logo

- `apps/desktop/build/logo-source.png` is the logo exactly as supplied. `build/make-icon.py` (Pillow and NumPy) takes
  the black square out: the background is everything dark that joins the edge of the picture (at most 40 of 255; at
  60 the fill leaks through the rim into the faces), and the soft pixels where the rim meets it become partly
  see-through rim, with their colour taken from the nearest rim pixel, rather than a dark fringe. The dice's own black
  faces are inside the rim and stay.
- From that cut-out it renders `build/icon.png` (512 px, the window icon), `build/icon.ico` (16 to 256 px, sharpened a
  little at 48 px and under) and `public/brand/mark-{64,128,256}.png`. Pictures are scaled with premultiplied alpha.
- In the app, `LogoMark` is an `<img>` of those marks with a `srcset`, so the page takes the render that fits the size
  and the screen's scale: 22 px in the title bar, 44 px on an empty chat, 64 px in About. Vite copies `public/` into
  `dist/renderer/`, which the `app://` protocol already serves. The mark is chrome and black, so one picture serves
  the dark and the light theme. The one-colour Trace N glyph, unused, is removed.
- The wordmark keeps the N picked out, now in the chrome gradient (`--brand-1`, `--brand-2`).

### The theme: Obsidian, with the Mono accent

- **Surfaces** are true neutral blacks with no tint, from `--chrome` `#050505` to `--surface-3` `#1d1d1d`; lines
  `#1a1a1a`, `#262626` and `#333333`. Text is `#f2f2f2`, `#b0b0b0` and `#8f8f8f`, each at least 4.5:1 on every
  surface; your messages sit on `#1c1c1c`. Light is the same in neutral greys on white.
- **Mono** is the new default accent: the logo's chrome on dark (`--accent` `#d4d4d4`, buttons `#ebebeb`) and its black
  on light (`#111111`). A silver button cannot take white text, so the text on an accent fill is now a token,
  `--on-accent`: the logo's black (`#0a0a0a`) on silver, white on black and on every coloured accent. The toggle's
  thumb takes it when on, so it shows on a silver track.
- Silver links sit too close to the text to be told apart by colour alone, so under Mono a link in replies, help and
  settings carries a thin underline in the accent.
- **Colour stays for meaning and code.** Success, warning and danger, the syntax colours and the terminal's ANSI
  colours are unchanged; only their greys lose the blue tint.
- Signal blue, Cyan, Jade and Amber stay as choices, each with white text on its fill as before.
- **Themes of your own** start from these colours. A light grey accent fills halfway to white under black text, as
  Mono does; any other accent is darkened until white text reads, as before. The contrast check reads the button text
  from `--on-accent`.
- The window's first-frame colour and its native buttons (`WINDOW_BACKGROUND`, `CAPTION_SYMBOL`) follow the new chrome.

## Consequences

- Existing settings that saved `accent: 'blue'` keep Signal blue; a new profile starts on Mono.
- The source picture is 1254 px; the largest render made from it is 512 px, so a larger icon (a store listing) would
  need a larger source from the owner.
- A rendered logo is not themeable: if a coloured or one-colour mark is ever needed (a monochrome tray icon, a
  favicon in a colour), it has to be drawn for that purpose.
- The appearance part of the smoke (`ENCODE_SMOKE_ONLY=appearance`) checks the Mono accent and black canvas at start,
  that the dice in the title bar loaded, and that Mono on light gives ink buttons with white text.
