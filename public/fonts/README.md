# Bundled typefaces

The typefaces the dashboard uses beyond the system's own, served by the dashboard itself so they
look the same on every machine and nothing is fetched from anywhere else. Three are offered in the
Settings panel, the Train theme sets itself in the fourth, Broadsheet in the fifth and Gauges in the
sixth. All six are under the SIL Open Font License 1.1; each licence sits beside its font.

| File | Source | Changes |
| --- | --- | --- |
| `SourceSerif4Variable-Roman.ttf.woff2` | Adobe, [source-serif 4.005R](https://github.com/adobe-fonts/source-serif/releases/tag/4.005R), `source-serif-4.005_WOFF2.zip` → `VAR/` | none — the licence reserves the name "Source", so it ships exactly as released |
| `FiraCode-VF.woff2` | [Fira Code 6.2](https://github.com/tonsky/FiraCode/releases/tag/6.2), `Fira_Code_v6.2.zip` → `woff2/` | none |
| `NotoSans-Latin.woff2` | [google/fonts](https://github.com/google/fonts/tree/main/ofl/notosans) `ofl/notosans/NotoSans[wdth,wght].ttf` | width fixed at 100 and cut to Latin (below); no reserved name |
| `Jersey10-Latin.woff2` | [google/fonts](https://github.com/google/fonts/tree/main/ofl/jersey10) `ofl/jersey10/Jersey10-Regular.ttf` | cut to Latin (below); no reserved name |
| `Caveat-Latin.woff2` | [google/fonts](https://github.com/google/fonts/tree/main/ofl/caveat) `ofl/caveat/Caveat[wght].ttf` | cut to Latin (below); no reserved name |
| `B612-Regular-Latin.woff2`, `B612-Bold-Latin.woff2` | [polarsys/b612](https://github.com/polarsys/b612) 1.008, `B612-Regular.ttf` and `B612-Bold.ttf` | ▲ and ◆ added, ( and ) redrawn, and cut to Latin (below); no reserved name |

`NotoSans-Latin.woff2` was made with fontTools 4.65:

```sh
fonttools varLib.instancer 'NotoSans[wdth,wght].ttf' wdth=100 -o NotoSans-wght.ttf
pyftsubset NotoSans-wght.ttf \
  --unicodes="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2190-2193,U+2212,U+2215,U+25B2,U+25BC,U+25C6,U+FEFF,U+FFFD" \
  --layout-features='*' --name-IDs='*' --name-legacy --name-languages='*' --notdef-outline \
  --flavor=woff2 --output-file=NotoSans-Latin.woff2
```

The full font is 2 MB; the dashboard's text is Latin, so the cut keeps the weight axis and every
OpenType feature (tabular figures included) at 57 KB. Noto Sans has no ▲ ▼ ◆ →, so those come
from the next face in the stack.

`Jersey10-Latin.woff2` was made the same way with fontTools 4.68, from the same list less the
marks and arrows it does not have, at 13 KB. It has no ▲ ▼ ◆ → or ± of its own, so those also come
from the next face in the stack. A bitmap face looks its best at a few fixed sizes, so the Train
theme keeps to 20, 40 and 60px.

`Caveat-Latin.woff2` was made the same way with fontTools 4.68, from the full list above, keeping
the weight axis (400 to 700), at 78 KB. Its figures are all of one width. It has no ▲ ▼ ◆ of its
own, so those come from the next face in the stack, Source Serif 4.

The two B612 files were made with fontTools 4.68, after three changes to each face. It has ▼ but
not ▲ or ◆, so ▲ is its ▼ turned over and ◆ a square stood on its point, on the same centre and in
the same width, a little taller so it carries as much ink. Its parentheses are straight-sided,
which in capitals reads as [ALL MODELS], so ( and ) are drawn again as curves of the face's own
stem, thinning to their tips, in the same width and height. The table of widths cached per size
(`hdmx`, Regular only), which does not list the new glyphs, is dropped. Each face is then cut to
the full list above, keeping its hinting, at 19 and 14 KB. Its figures are all of one width.

Only the `.woff2` files are served, each by name in `src/server.js`'s allowlist.
