# ccusageviz — UI spec

Locked via two rounds of questions. This is the contract the frontend implements.

## Surface

A **browser tab** on a normal laptop window, glanced at a few times an hour. Desktop sizing —
not a wall display, not a tiny widget. Dense enough to be useful at arm's length.

## Theme

**Dark glass over an animated gradient.**

- Backdrop: 3–4 large soft color blobs drifting on a ~30s loop, deep charcoal base.
- Panels: `backdrop-filter: blur(24px)`, white ~8% fill, 1px light top edge, soft outer shadow.
- Motion is confined to the backdrop and the rings' interiors (see *Ring interior* below).
  Arcs, ticks and charts only move when the data moves.
- `prefers-reduced-motion` freezes the gradient and holds each ring's fluid as a still frame.

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
rest, beside its ring — no click needed to see a trace. Below ~680px the chart drops under its
ring at full width.

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
