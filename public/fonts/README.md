# Bundled typefaces

The typefaces the dashboard's Settings panel offers, served by the dashboard itself so they look
the same on every machine and nothing is fetched from anywhere else. All three are under the SIL
Open Font License 1.1; each licence sits beside its font.

| File | Source | Changes |
| --- | --- | --- |
| `SourceSerif4Variable-Roman.ttf.woff2` | Adobe, [source-serif 4.005R](https://github.com/adobe-fonts/source-serif/releases/tag/4.005R), `source-serif-4.005_WOFF2.zip` → `VAR/` | none — the licence reserves the name "Source", so it ships exactly as released |
| `FiraCode-VF.woff2` | [Fira Code 6.2](https://github.com/tonsky/FiraCode/releases/tag/6.2), `Fira_Code_v6.2.zip` → `woff2/` | none |
| `NotoSans-Latin.woff2` | [google/fonts](https://github.com/google/fonts/tree/main/ofl/notosans) `ofl/notosans/NotoSans[wdth,wght].ttf` | width fixed at 100 and cut to Latin (below); no reserved name |

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

Only the `.woff2` files are served, each by name in `src/server.js`'s allowlist.
