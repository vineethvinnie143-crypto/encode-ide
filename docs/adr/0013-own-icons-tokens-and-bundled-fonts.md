# 0013. Own icons, one token set and bundled fonts

- Status: Accepted
- Date: 2026-10-22
- Amends: [0003](0003-own-code-above-the-platform.md), which kept lucide-react for now

## Context

Phase 2 rebuilds the interface to match the Codex desktop app's layout, flows and finish
while keeping eNCode's own identity (the approved UI spec). The renderer had grown one
4,874-line stylesheet with 17 font sizes, 15 radii and about 40 hard-coded colours, so a
light theme or an accent choice meant editing hundreds of rules. Icons came from
lucide-react, an outside app-level library that ADR 0003 kept only "for now", and copying
another product's icons, colours or fonts would be a trade dress risk once eNCode is public.

## Decision

- **Icons.** `apps/desktop/src/ui/icons.tsx` holds eNCode's own line icons: a 24 px grid, round
  ends, coloured by `currentColor`, and a stroke sized to the size they are drawn at so the line
  is 1.5 px on screen from 16 px up and a little finer below (`icon-weight.ts`; first written as
  a fixed 1.75 px stroke, which drew 1 px lines at 14 px and looked faint). They take lucide's prop shape
  (`size`, `className`, `strokeWidth`, `fill`), so call sites changed only their import.
  lucide-react is removed. A new icon is drawn in that file to the same rules; no icon
  package is added.
- **Tokens.** `src/theme/tokens.css` is the only place that defines colours, type sizes,
  radii, shadows and motion. Dark is the default; `data-theme`, `data-accent`,
  `data-contrast`, `data-density` and `data-motion` on `<html>` switch the rest. Every other
  stylesheet (`src/styles/*.css`, one file per area in cascade order, and `src/ui/ui.css`)
  uses tokens only. The deliberate exceptions are the logo's gradient stops, the white page
  behind the browser panel, the window's red close hover and the white toggle thumb.
- **Appearance.** `Settings.appearance` (mode, accent, contrast, density, motion) is
  validated by `shared/appearance.ts` in the main process. The renderer applies it with
  `src/theme/appearance.ts`. The main process mirrors the mode into `nativeTheme` and the
  window's colour, and puts it in the page URL so the first frame is already in the right
  theme. Dark stays the default so nothing changes for existing users.
- **Fonts.** Inter (interface) and JetBrains Mono (code) ship as variable WOFF2 files under
  the SIL Open Font License 1.1, with each licence next to its file and the sources and
  hashes in `src/theme/fonts/README.md`. Segoe UI Variable and Cascadia Mono are the
  fallbacks. Fonts are assets, not code, so the platform boundary of 0003 is unchanged.
- **Logo.** The mark is Trace N: one line drawn between two nodes. `src/ui/Logo.tsx` draws
  it in the app, `build/icon.svg` is the master drawing and `build/make-icon.py` renders the
  PNG and the ICO from the same geometry, with the one-colour glyph under 20 px.
- **Primitives.** `src/ui/` holds the shared controls: Button, IconButton, Pill, Chip, Kbd,
  Toggle, Segmented, Select, Menu, Tooltip, Dialog, Toast, Tabs, Skeleton and Spinner. Their
  keyboard and placement logic lives in plain modules (`nav.ts`, `place.ts`, `shortcut.ts`)
  with unit tests. New screens build on these rather than one-off markup.
- **Review by eye.** The end-to-end smoke switches the theme through Settings and captures
  the window dark and light at 1280 x 800 and 1920 x 1080. CI keeps the screenshots from
  every run, not only failed ones as ADR 0012 first set up.

## Consequences

- One fewer runtime dependency, and no outside artwork in the product. An icon that is
  missing has to be drawn, which takes minutes rather than an install.
- Themes, accents and density come free to any rule that uses tokens; a hard-coded colour
  is a review finding.
- The bundled fonts add about 466 KB to the app and look the same on every Windows install.
- The editor and terminal packages read only their own variables (`--enc-editor-*`,
  `--enc-tok-*`, `--enc-term-*`), which `src/theme/editor-terminal.css` maps from these
  tokens, so they are themed without the redesign reaching into their markup.
- Still open: user-chosen fonts and sizes, theme presets with import and export, and a
  custom accent colour, which arrive with the full Appearance page in UI-6.
