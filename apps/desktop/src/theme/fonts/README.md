# Bundled fonts

Both fonts are used unmodified under the SIL Open Font License 1.1, whose
full text sits next to each file. The licence lets eNCode bundle and
redistribute them; it does not let anyone sell the fonts on their own.

| File | Font | Source | SHA-256 |
| --- | --- | --- | --- |
| `InterVariable.woff2` | Inter 4, variable, weights 100–900 | https://rsms.me/inter/font-files/InterVariable.woff2 | `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3` |
| `JetBrainsMono-Variable.woff2` | JetBrains Mono 2, variable, weights 100–800 | https://github.com/JetBrains/JetBrainsMono, `fonts/webfonts/JetBrainsMono[wght].woff2` | `31ec365b93e4bad6f202ce23352a56d01ca4462b2afc782ed2cf6fa42ca9ac0e` |

`Inter-OFL.txt` and `JetBrainsMono-OFL.txt` are each project's own `LICENSE.txt`
and `OFL.txt`. `../fonts.css` declares the faces; `../tokens.css` puts them
first in `--font-ui` and `--font-mono`, with Segoe UI Variable and Cascadia
Mono behind them.
