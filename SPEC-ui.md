# ccusageviz — UI spec

Locked via two rounds of questions. This is the contract the frontend implements.

## Surface

A **browser tab** on a normal laptop window, glanced at a few times an hour. Desktop sizing —
not a wall display, not a tiny widget. Dense enough to be useful at arm's length.

## Theme

Three themes, chosen in *Settings*: **Glass**, the default, **Matrix**, a terminal, and **Train**,
a pixel scene.

**Glass: dark glass over an animated gradient.**

- Backdrop: 3–4 large soft color blobs drifting on a ~30s loop, deep charcoal base.
- Panels: `backdrop-filter: blur(24px)`, white ~8% fill, 1px light top edge, soft outer shadow.
- Motion is confined to the backdrop, the ring's interior (see *Ring interior* below) and
  one alarm, the shake of the ring while it is over pace (see *Over pace*). The arc, tick and
  chart otherwise only move when the data moves. Each of the three can be switched off in
  *Settings*. (Matrix and Train have motion of their own; see below.)
- `prefers-reduced-motion` freezes the gradient, holds the ring's fluid as a still frame and
  stops the shake.

### Matrix

A terminal. Nothing of the glass is drawn: no panels, no ring, no fluid, no gradient. The whole
window is one grid of character cells in Fira Code, shared by two layers.

```
 QUOTA  MAX · 20×                            ● live · updated 13s ago  [≡]
┌─ CURRENT WEEK (ALL MODELS) ───────────────────────────── 7 DAYS WINDOW ─┐
│ 41%   5d 11h 59m left                                                   │
│                                                  ╷70  ╷     ╷    ╷ 100╷ │
│ █████████████████████████████▏░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│           pace ▲━━━━━━━━━━━━━                                           │
│ ▲ 20 pts over pace · 1.9× clock                                         │
│ cap ~Wed 05:55 · in 3d 12h                                              │
│                                                                         │
│ LAST 12H OF HISTORY                              burn +0.70 %/hr ± 0.07 │
│  60┤                                                                    │
│  30┤⣀⣀⣀⣀⣤⣤⣤⣤⣤⣤⣴⣴⣴⣴⣶⣶⣶⣶⣶⣶⣶⣾⣾⣾                                           │
│   0┤                                                                    │
│    └──────────────────────────────────────────────────────────────────  │
│     10:31                                                          now  │
└─────────────────────────────────────────────────────────────────────────┘
```

- **The page** is a text UI: framed boxes, the limit as a bar in its band's colour (to an eighth
  of a cell), the colour changes as marks on the row above the bar, the ones it has passed
  included (every served one, numbered where there is room; the quarter-point stations fainter),
  the pace ▲ on the row under it with the span to the bar's end (solid in the pace colour when
  over, dotted while it is headroom), so the ▲ never lands on a mark, the verdict and cap lines,
  and the history as a braille chart: bright in the band's colour where the burn rate was
  fitted, with a dotted upright over "fit" where that run starts, the warning floor labelled,
  and, when a projection is published, a dotted ramp to the cap and a "now" tick where the
  readings stop. Every character is locked in its cell and set in **amber**, so the page is told
  from the rain at a glance; the readings that carry a colour keep it (the bar's band, the pace
  channel, the hold and error tones, the cost strip's own family).
- **The rain** falls on the layer below: columns of digits, letters and signs at a fixed 22
  steps a second whatever the display's rate, in **green**, with a head of the same colour lit
  most of the way to white (less of the way for a dark colour, so a dark rain stays dark); about
  four columns in ten are falling at any moment, whatever the window's height. All three are
  settings: *Speed* scales the steps, *Amount* sets the share of columns falling, and
  *Colour #1* is the green.
- **The page is always in front.** It is drawn over the rain and never gives way to it: the rain
  shows at full strength in the gaps and only as a glimmer under the boxes. Whatever is amber is
  the page; whatever is green is rain, so a falling digit is never read as part of a reading.
  The amber is not a setting; the rain's colours are, and a rain set in amber gives this up.
- **The same words.** The glass page is still there, out of sight, and the terminal reads its
  words off it, so the two themes never say different things; the detail panel's explanation
  names the bar and the ▲ under Matrix, the ring and the tick under Glass. Screen readers and
  the keyboard keep using the glass page: a focused control lights its box in the terminal,
  clicking the limit's box (or Enter on it) opens the detail beneath it, and the settings gear
  is the real button, placed unseen over the terminal's `[≡]`.
- **It fits the window.** The page is centred, at most 100 cells wide, and gives up the chart's
  height, then the cost strip piece by piece, when the window is too short; with the detail open
  in a small window its explanation gives up its last lines and ends in "…". When the freshness
  line does not fit beside the name, the header splits over two lines.
- The rain warms with the room: the hotter the weekly limit runs, the more of the streams coming
  on screen fall in red (*Colour #2*), as the gradient warms in Glass.
- *Rain*, the terminal's own setting, off stops the rain where it stands, and
  `prefers-reduced-motion` shows one still frame of it: the rain as it is once settled, at its
  amount. A still frame is drawn again when the rain's amount or colours change, and when a new
  reading moves the room's heat, so it never shows a calm room at the cap.
- The terminal has no fluid, no shake and no choice of face, so Settings does not list those
  while it is on. A browser that cannot draw it keeps the glass page, and its settings.

### Train

A steam train runs through a village, and the window is the view from alongside it. The camera
keeps up with the train, so the train stands on screen with its wheels turning and the world goes
past it in layers. The scene is drawn small on one canvas and enlarged with hard pixels, from the
sprite sheet in `public/sprites/train.png` (its sources are in `art/`).

The page is the same page as Glass, so it says the same things and the keyboard and screen readers
work the same way. It is reset as flat plates with stepped corners, in the bitmap face Jersey 10,
at the top of the window so that the train has its lane below; in a short window the page scrolls
over the scene. The ring and the chart's marks are coarsened onto a 3px grid.

**The sky is the accent.** The sky's middle band is the colour the ring would have, teal by day,
amber at the warning floor and redder to the cap, and everything on the page that carries the
ring's colour carries the sky's instead: the arc, the chart, the plates' borders, the headings.
The bands above it run to the deep of the sky and those below to the light at the horizon.

The story turns on the served cut points, so it lands on the marks the ring prints:

| reading | scene |
| --- | --- |
| under the warning floor (70%) | day. The sun crosses the sky with the reading |
| at the warning floor | evening comes: the sun is carried down, the sky turns amber from the horizon up, and windows and lamps light |
| from there to the band's third quarter point (92.5%) | the sun sinks to the hills and the sky reddens with the reading |
| past the third quarter point | the land scorches, the village gives out into ruins, and a horned beast's mouth swallows the train. It comes out at the far end, in hell |
| at the cap (100%) | once through, the only station in the world comes into sight, the burnt-out terminus at the end of the line, and the train brakes to a stand at its platform. Its smoke stops; the fire goes on burning around it |

**No change happens at once.** Nothing in the scene follows a reading directly. The scene keeps its
own reading, which walks after the real one at a fixed pace, and evening, hell and the train's
speed walk after that, each in its own time: day to evening takes 50 s, the fall into hell 40 s and
the brake 30 s. However far a reading jumps, the scene passes through everything between, in order.
The land changes by scrolling in, thinning from green to dry to ash a tile at a time; a change of
biome is never painted over land already on screen. The clouds are the one exception, being so
slow to leave: white and black ones are both always up there, and the walk fades one set into the
other.

- **There are no other stations.** The terminus is placed out of sight ahead as the train starts to
  brake, where the brake will bring it to rest to within a couple of pixels, so it slides into view
  as the train slows. It is never moved or replaced in view: if the reading leaves the cap and
  comes back, the train brakes for it if it is still ahead, stops up to 24 scene pixels past it if
  it has only just left, and otherwise lets it go by and stops at the next. It carries no sign and
  no lettering; its clock has stopped with both hands at twelve.
- **Going back.** A reading that falls, as one does when the week resets, walks back the same way:
  the train pulls away from the terminus, leaves hell through the beast (it comes out of the mouth this time), and
  the sky cools. A long fall back into the day does not walk the sun back the way it came: it goes
  on down, waits under the land while hell lasts, and comes up in the east on a new morning.
- **The accent lags the reading by design.** The number is always the reading, at once. The ring's
  colour is the sky's, so for the length of a walk it shows where the sky has got to, not where
  the reading is.
- **The first reading is where the scene starts,** however late it comes, as there is nothing yet
  to walk from: no scene is drawn before it, and it fades up already in that state, so a page
  opened at 95% is simply in hell. A held reading is walked to like any other, and a reading lost
  later on leaves the sky as it was rather than calling it morning.
- *Moving scene*, the theme's own setting, off stops it where it stands, and
  `prefers-reduced-motion` shows one still frame. A still frame cannot walk, so it dissolves into
  the next one over 4 s when a reading moves it, and the accent eases across with it. It stays on
  the same stretch of land unless hell, the scorching or the terminus has come or gone.
- A hidden tab stops the scene, and the walk picks up where it was: a reading that landed
  meanwhile still has to be walked to when the tab comes back.
- The scene has no fluid, no shake and no choice of face, so Settings does not list those while it
  runs. A browser that cannot draw it, or a sheet that will not load, keeps the glass page, its
  settings and the reader's own typeface.

## Primary view — the weekly limit, a ring and its chart

```
  ◜◞   CURRENT WEEK         │ ▁▁▁▁▁▂▃▅▆▇  ┊ burn +0.40 %/hr
 (41%) 5d 11h               │             ┊
       ▲ 6 pts over pace    │ 03:17          now
```

One row: **the weekly limit**. Anthropic has removed the five-hour session limit, and Fable is
not used here, so neither is drawn. The backend still reports all three (see the README) and
the history still records all three, so a ring could come back by adding its key to the
page's `ORDER`. The history chart is drawn at rest, beside the ring — no click needed to see
the trace. It covers at most the last 12 hours, the span the history cache is sized for, so
an account switched back to after days away starts a fresh trace instead of redrawing its old
window. Below ~680px the chart drops under the ring at full width.

The ring:

| element | meaning |
| --- | --- |
| arc sweep | percent of the limit consumed |
| arc color | threshold band (see below) |
| tick notch on circumference | **pace marker** — where even burn would put you right now |
| center | the percentage, large |
| under the ring | label + live reset countdown |

The pace marker is the whole point of the color rule: a ring can read 9% and still be in
trouble if only 3% of the window has elapsed. Arc **behind** the tick = coasting.
Arc **past** the tick = burning hot, will hit the cap before the window resets.

The pace marker is what catches a Monday-morning spree.

### Over pace

A ring whose verdict is *over pace* shakes, continuously, for as long as it stays over — no
beat and no rest. The motion goes every way: a fast jitter and a slower sway, both in two
dimensions, with a twist on top, in loops of unrelated lengths so it never visibly repeats.
How hard it shakes follows the pace severity — the same score that heats the tick and the
caption — so a two-point overrun trembles and a 3× burn rattles. Only a ring that is over pace
moves. A held reading keeps shaking, like every other severity channel. A ring at the cap does not: the flooded well
already says it, and there is no pace left to warn about.

### Ring interior

The well inside the ring is a small **WebGL fluid simulation** (stable fluids: advection,
vorticity confinement, pressure projection). It is the look, not a reading, so it borrows its
meaning instead of adding any:

- the dye is the arc's own band colour, saturated, with a little hue play around it;
- how hard it is stirred follows the same heat that warms the backdrop — calm limits drift,
  hot ones churn;
- a ring with no reading, or dormant at zero, gets a dim grey, barely moving fluid;
- a held (stale) reading slows to a crawl;
- the pointer drags dye across the ring it is over.

The numeral stays legible over it through a dark halo on the glyphs and a calmer core. Without
WebGL or renderable half-float textures the canvas is dropped and the plain well is drawn.

## Color bands

Arc color is a function of the raw percentage. Exact cut points come from the threshold
table the probe agent extracted from the Claude Code binary, so the dashboard agrees with
what `/usage` tells you rather than inventing its own opinion.

Shape of the rule (values pending the probe):

| band | intent |
| --- | --- |
| low | calm green — ignore this |
| mid | amber — worth knowing |
| high | orange — plan around it |
| near cap | red — act now |

Colorblind safety: the bands must differ in **lightness** as well as hue, and the pace
marker carries the same warning independent of color.

## Dormant limits

A limit the API returns at 0% with a `null` reset time is dormant: no window is running. It
renders **dimmed at low opacity** with the word `dormant` where the countdown goes, still at
full size in its slot, and comes up to full strength on its own when usage starts — the visual
wake-up is the signal. (Fable, before it was dropped, was the case this was written for.)

Same treatment for any limit the API returns as null or inactive.

## Detail on click

At rest the page shows the ring and its chart. Clicking the ring expands a detail panel
directly under its row:

```
┌───────────────────────────────────────────────────┐
│  WEEKLY · 7 days window                  NOMINAL  │
│  +0.40 %/hr │ ~Tue 14:05 │ ▲ 6 over │ 57 samples  │
│  what the tick, the overshoot span and the marks  │
│  mean, in words                                   │
└───────────────────────────────────────────────────┘
```

- **burn rate** — percent per hour over the current fitted run, with its standard error
- **projection** — when this limit hits 100% at the current rate, or "not at this rate"
  if the window resets first
- **pace** and **fitted run** — the over/under-pace verdict and the span the fit was taken over

The history chart is not repeated here; it is already beside the ring. Clicking the ring again
collapses it.

## Settings

A gear at the right end of the header, beside the freshness pill, opens a small panel that grows
out of it and floats over the page, so a switch can be flipped while watching the ring it
changes. The gear again, Escape, a click elsewhere or focus moving away closes it.

The panel lists the theme, then only the settings of the theme on screen; nothing is shown
greyed out.

| theme | setting | choices | default |
| --- | --- | --- | --- |
| all | Theme | Glass, Matrix, Train | Glass |
| Glass | Fluid simulation | on / off — off shows the plain well and stops the GPU loop | on |
| Glass | Speed | slow / normal / fast (0.25×, 0.5×, 1×) — listed only while the fluid is on | normal |
| Glass | Vibration | on / off — the shake of a ring over pace | on |
| Glass | Animated background | on / off — off pauses the drifting sky where it stands | on |
| Glass | Typeface | System, Source Serif 4, Noto Sans, Fira Code | System |
| Matrix | Rain | on / off — off stops the rain where it stands | on |
| Matrix | Amount | slider, 5–100% of the columns falling at once — listed only while the rain is on | 40% |
| Matrix | Speed | slider, 0.25×–2.5× of 22 steps a second — listed only while the rain is on | 1× |
| Matrix | Colour #1 | any colour — the rain; its heads are the colour lit toward white, less so the darker it is | green `#00ff66` |
| Matrix | Colour #2 | any colour — the warm rain, more of it the hotter the limit runs | red `#ff3028` |
| Train | Moving scene | on / off — off stops the train, its smoke and the fire where they stand | on |

Settings change how the page looks, never what it measures or how it judges a reading:
switching the shake off leaves the over-pace verdict in the tick, the caption and the halo.
They are kept in this browser (only the ones that differ from the default), applied before the
ring is first drawn, and followed in other open tabs. A slider or a colour is followed on screen
as it moves, and kept once it is let go. The system's reduced-motion setting still stills
everything, and the panel says so while it is on.

The three named typefaces are bundled with the dashboard and served by it, never fetched from a
font service. Fira Code also takes over the figures, which are otherwise set in the system's
monospaced face. Matrix is set in Fira Code and Train in Jersey 10 whatever the typeface says; the
reader's own choice is kept, and returns with Glass. Jersey 10 is not offered as a choice: it is
a bitmap face, set at a few fixed sizes that the rest of the page does not keep to.

## Footer strip

**Always visible**, never collapsed: the ccusage cost numbers.

```
ccusage · 7d $2,289 · opus $1,869 · fable $415
```

This is a **different data source with different meaning** and the UI must say so. It is
local token accounting priced at API list rates — not what your subscription meters against.
It goes in the footer, visually separated from the ring, never blended into it.

## Live updates

Server-sent events push every poll, and every reading Claude Code's status line files (see the
README) — those come after every reply and cost no request, so while Claude Code is in use the
page moves within seconds and the endpoint is left alone. A quiet freshness indicator shows
last-update age, and says "via Claude Code" while that is where the numbers come from.
The server sends a heartbeat event every 15 s, so a quiet stretch between readings is not
mistaken for a dead link: "lost the live feed" means no frame of any kind for 150 s.
When the backend goes stale (expired token, network down) the ring holds its last known
value, drops to a muted treatment, and the header states why. The dashboard never shows a
confident number it cannot currently verify.

## Backend work this spec implies

Beyond the quota service already being built:

1. **History recording** — burn rate, projection and sparklines all need a rolling series of
   samples. The poller must retain a window of readings.
2. **Cost endpoint** — the footer needs `ccusage claude daily --json --breakdown`, cached,
   since shelling out is slow relative to the quota poll.
