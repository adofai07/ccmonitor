# ccusageviz — UI spec

Locked via two rounds of questions. This is the contract the frontend implements.

## Surface

A **browser tab** on a normal laptop window, glanced at a few times an hour. Desktop sizing —
not a wall display, not a tiny widget. Dense enough to be useful at arm's length.

## Theme

**Dark glass over an animated gradient.**

- Backdrop: 3–4 large soft color blobs drifting on a ~30s loop, deep charcoal base.
- Panels: `backdrop-filter: blur(24px)`, white ~8% fill, 1px light top edge, soft outer shadow.
- Motion is confined to the backdrop, the rings' interiors (see *Ring interior* below) and
  one alarm, the shake of a ring that is over pace (see *Over pace*). Arcs, ticks and charts
  otherwise only move when the data moves. Each of the three can be switched off in
  *Settings*.
- `prefers-reduced-motion` freezes the gradient, holds each ring's fluid as a still frame and
  stops the shake.

## Primary view — three rows, each a ring and its chart

```
  ◜◞   SESSION              │ ▁▁▁▁▁▂▃▅▆▇  ┊ burn +9.2 %/hr
 (1%)  4h 22m               │             ┊
       ▼ 3 pts under pace   │ 03:17          now
  ─────────────────────────────────────────────────
  ◜◞   WEEKLY  …            │ …
  ─────────────────────────────────────────────────
  ◜◞   FABLE   dormant      │ …
```

Fixed order, top to bottom: **session, weekly, Fable.** The order never changes and no row is
ever dropped, so the layout cannot reflow under you. Every limit's history chart is drawn at
rest, beside its ring — no click needed to see a trace. A chart covers at most the last 12
hours, the span the history cache is sized for, so an account switched back to after days away
starts a fresh trace instead of redrawing its old window. Below ~680px the chart drops under
its ring at full width.

Each ring:

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

The session ring's pace marker is the useful one day-to-day; the weekly ring's marker is
what catches a Monday-morning spree.

### Over pace

A ring whose verdict is *over pace* shakes, continuously, for as long as it stays over — no
beat and no rest. The motion goes every way: a fast jitter and a slower sway, both in two
dimensions, with a twist on top, in loops of unrelated lengths so it never visibly repeats.
How hard it shakes follows the pace severity — the same score that heats the tick and the
caption — so a two-point overrun trembles and a 3× burn rattles. Only rings that are over pace
move, and each shakes on its own rather than in step with another. A held reading keeps
shaking, like every other severity channel. A ring at the cap does not: the flooded well
already says it, and there is no pace left to warn about.

### Ring interior

The well inside each ring is a small **WebGL fluid simulation** (stable fluids: advection,
vorticity confinement, pressure projection), one per ring. It is the look, not a reading, so
it borrows its meaning instead of adding any:

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

Fable currently returns 0% with a `null` reset time. A limit in that state renders
**dimmed at low opacity** with the word `dormant` where the countdown goes. It still occupies
its slot at full size. When Fable usage starts, the ring comes up to full strength on its own —
the visual wake-up is the signal.

Same treatment for any limit the API returns as null or inactive.

## Detail on click

At rest the page shows the three rings and their charts. Clicking a ring expands a detail
panel directly under that ring's row:

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

The history chart is not repeated here; it is already beside the ring. One panel open at a
time. Clicking the open ring collapses it.

## Settings

A gear at the right end of the header, beside the freshness pill, opens a small panel that grows
out of it and floats over the page, so a switch can be flipped while watching the ring it
changes. The gear again, Escape, a click elsewhere or focus moving away closes it.

| setting | choices | default |
| --- | --- | --- |
| Fluid simulation | on / off — off shows the plain well and stops the GPU loop | on |
| Speed | slow / normal / fast (0.25×, 0.5×, 1×), while the fluid is on | normal |
| Vibration | on / off — the shake of a ring over pace | on |
| Animated background | on / off — off pauses the drifting sky where it stands | on |
| Typeface | System, Source Serif 4, Noto Sans, Fira Code | System |

Settings change how the page looks, never what it measures or how it judges a reading:
switching the shake off leaves the over-pace verdict in the tick, the caption and the halo.
They are kept in this browser (only the ones that differ from the default), applied before the
rings are first drawn, and followed in other open tabs. The system's reduced-motion setting
still stills everything, and the panel says so while it is on.

The three named typefaces are bundled with the dashboard and served by it, never fetched from a
font service. Fira Code also takes over the figures, which are otherwise set in the system's
monospaced face.

## Footer strip

**Always visible**, never collapsed: the ccusage cost numbers.

```
ccusage · 7d $2,289 · opus $1,869 · fable $415
```

This is a **different data source with different meaning** and the UI must say so. It is
local token accounting priced at API list rates — not what your subscription meters against.
It goes in the footer, visually separated from the rings, never blended into a quota ring.

## Live updates

Server-sent events push every poll. A quiet freshness indicator shows last-update age.
When the backend goes stale (expired token, network down) the rings hold their last known
values, drop to a muted treatment, and the header states why. The dashboard never shows a
confident number it cannot currently verify.

## Backend work this spec implies

Beyond the quota service already being built:

1. **History recording** — burn rate, projection and sparklines all need a rolling series of
   samples. The poller must retain a window of readings.
2. **Cost endpoint** — the footer needs `ccusage claude daily --json --breakdown`, cached,
   since shelling out is slow relative to the quota poll.
