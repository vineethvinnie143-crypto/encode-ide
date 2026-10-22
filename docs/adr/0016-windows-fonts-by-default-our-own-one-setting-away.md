# 0016. Windows' fonts by default, eNCode's own one setting away

- Status: Accepted
- Date: 2026-10-22
- Amends: [0013](0013-own-icons-tokens-and-bundled-fonts.md), which made Inter and JetBrains Mono the fonts

## Context

ADR 0013 bundled Inter and JetBrains Mono as eNCode's fonts. Put next to the Codex desktop
app, eNCode's text still looked different. Measured on the same screen:

- Codex's Appearance page has Font: System, so it draws everything in Windows' own font. Its
  sidebar line "Build VirtFusion-style VPS panel" is 196 px wide, exactly Segoe UI at 14 px
  (Inter is 213 px at 14 px, about 8% wider, and heavier with a taller x-height).
- Its UI size is 14 px and its code size 12 px (Settings, Appearance, Advanced). Code lines
  run 6.6 px per character, which is Consolas at 12 px (JetBrains Mono is 7.2 px).

So the difference was the typeface and the small sizes, not a rendering setting.

## Decision

- **Four settings.** `Appearance` gains `uiFont`, `codeFont`, `uiSize` and `codeSize`. A font
  is the built-in System choice, the built-in eNCode choice (Inter, JetBrains Mono) or the
  family name of any font installed on the PC. The defaults are System fonts at Codex's sizes
  (14 px and 12 px). Existing users get them too, because their saved settings name no font.
- **A name is checked before it reaches CSS.** `shared/appearance.ts` accepts a family name
  only if it is up to 64 letters, digits, spaces and a few marks, and quotes it in the font
  list; saved settings, the page URL and the picker all go through it.
- **Sizes follow the base size.** The stylesheets are written for 14 px text, as before.
  `--ui-delta` moves every size by the change from 14 px. In Windows' font, text under 14 px
  also gets one more pixel (`--ui-small`), since the font sets about 8% narrower than Inter,
  so small text is not smaller than Codex's. Code in replies, diffs and tool output is
  `--code-size`, and the editor and terminal read it through their own variables. About 100
  literal pixel sizes in the stylesheets became tokens; the editor's and terminal's own
  sheets are left to the editor thread.
- **The installed fonts** come from Chromium's Local Font Access API. The main window's own
  page may ask for `local-fonts` and nothing else; every other permission request from any
  page or frame, such as the browser panel, is refused.
- **The bundled fonts stay**, with their licences, one choice away. No font is added.

## Consequences

- eNCode opens looking like Codex's text: same typeface, same sizes. The brand fonts are a
  setting, not the default.
- A font chosen by name gets the size change only, never the extra pixel, because its metrics
  are not known.
- The first frame is drawn in the saved fonts, because the page URL carries them.
- Sizes are moved by a user setting from now on, so a new rule uses `--fs-*` or `--code-size`
  and not a literal px size.
