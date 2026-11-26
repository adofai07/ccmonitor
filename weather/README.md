# Weather: the renderer's sources

The Weather theme's view (the cove, the sky, the sea, the rain on the glass) is drawn by
`public/weather/wx.js`, which is built from the files here and is not edited by hand.

| path | what it is |
| --- | --- |
| `core/` | the contract every pass keeps (`contract.js`), the WebGL2 helpers, the frame graph (`renderer.js`), the cove's loader, the sun and moon (`astro.js`), the weather, pacing and detail (`director.js`) and the page's API (`api.js`); `lab.js` drives the lab page and is never built |
| `passes/` | the drawing passes, in the order a frame runs them: `atmo`, `clouds`, `night`, `sky`, `coast`, `beacon` (the lighthouse at the end of the right-hand headland, built in code from primitives, and its lamp), `ocean`, `bolt`, `post`, `rain`, `pane` |
| `stub/` | frozen stand-ins for the passes, for the lab page's `live=` subsets |
| `index.html` | the lab page; its `CORE` and `PASSES` lists are the bundle's module order |
| `serve.cjs` | the lab page's server, with the dashboard's security headers |

## Build

```sh
node tools/build-weather.mjs           # writes public/weather/wx.js
node tools/build-weather.mjs --check   # fails if public/weather/wx.js is not what these files build
```

The build cuts every lab-only span (between `/*@lab*/` and `/*@end*/`), strips comments and spaces
from the JavaScript and the GLSL, checks that the tokens are unchanged, and wraps the modules so
they leave only `window.WEATHER = { makeWeather }`. The same sources always give the same bytes;
`npm test` fails when the shipped file and these sources disagree.

## The lab page

```sh
node weather/serve.cjs                 # prints the address; PORT=8790 picks the port
```

It runs the same modules with the lab-only code in, over the cove's files in `public/weather/`,
with a panel of the renderer's knobs. The query sets the scene, for example `?v=96&tod=afternoon`
(the reading and the time of day), `q=0`..`q=4` (pin a detail tier), `live=sky,ocean` (only those
passes live, the rest frozen), and `strip=1` (cut the lab-only code, as the build does).
