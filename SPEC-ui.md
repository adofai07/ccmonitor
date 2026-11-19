# ccusageviz — UI spec

Locked via two rounds of questions. This is the contract the frontend implements.

## Surface

A **browser tab** on a normal laptop window, glanced at a few times an hour. Desktop sizing —
not a wall display, not a tiny widget. Dense enough to be useful at arm's length.

## Theme

Six themes, chosen in *Settings*: **Glass**, the default, **Matrix**, a terminal, **Train**, a
pixel scene, **Neumorphism**, soft clay, light or dark, **Broadsheet**, a newspaper written and
drawn by hand, and **Gauges**, a motorcar's instrument panel.

**Glass: dark glass over an animated gradient.**

- Backdrop: 3–4 large soft color blobs drifting on a ~30s loop, deep charcoal base.
- Panels: `backdrop-filter: blur(24px)`, white ~8% fill, 1px light top edge, soft outer shadow.
- Motion is confined to the backdrop, the ring's interior (see *Ring interior* below) and
  one alarm, the shake of the ring while it is over pace (see *Over pace*). The arc, tick and
  chart otherwise only move when the data moves. Each of the three can be switched off in
  *Settings*. (Matrix, Train and Broadsheet have motion of their own, Neumorphism only the
  shake and Gauges only its needle's; see below.)
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
  in a small window it gives up the blank above its download row, then its explanation's last
  lines, ending in "…", then that line too, and a download heading on a line of its own, before
  the download row or the box's bottom edge would leave the screen. When the freshness line does
  not fit beside the name, the header splits over two lines.
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
| from there to the band's third quarter point (92.5%) | the sun sinks to the hills and the sky reddens with the reading, and the summer dries out with it: the grass yellows, goes to straw and cracks, the trees thin, the hills brown, the flock and the herd are taken in, and the village wears down and empties, its windows going dark |
| past the third quarter point | the fire takes what the summer left: the fields burn to ash, the empty houses catch and burn out to ruins, the dead trees char, and a horned beast's mouth swallows the train. It comes out at the far end, in hell |
| at the cap (100%) | once through, the only station in the world comes into sight, the burnt-out terminus at the end of the line, and the train brakes to a stand at its platform. Its smoke stops; the fire goes on burning around it |

**No change happens at once.** Nothing in the scene follows a reading directly. The scene keeps its
own reading, which walks after the real one at a fixed pace, and evening, hell and the train's
speed walk after that, each in its own time: day to evening takes 50 s, the fall into hell 40 s and
the brake 30 s. However far a reading jumps, the scene passes through everything between, in order.
The land changes by scrolling in, thinning from green through straw and cracked earth to ash a few
tiles at a time, each stage blotting into the next; a change of biome is never painted over land
already on screen. The clouds are the one exception, being so
slow to leave: white and black ones are both always up there, and the walk fades one set into the
other.

- **There are no other stations.** The terminus is placed out of sight ahead as the train starts to
  brake, where the brake will bring it to rest to within a couple of pixels, so it slides into view
  as the train slows. It is never moved or replaced in view: if the reading leaves the cap and
  comes back, the train brakes for it if it is still ahead, stops up to 24 scene pixels past it if
  it has only just left, and otherwise lets it go by and stops at the next. It carries no sign and
  no lettering; its clock keeps the viewer's time, and its red seconds hand ticks.
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
  the same stretch of land unless hell, the scorching or the terminus has come or gone, or the land
  has dried half a stage further or come back.
- A hidden tab stops the scene, and the walk picks up where it was: a reading that landed
  meanwhile still has to be walked to when the tab comes back.
- The ring shakes while over pace as it does in Glass, by the same rule and on the same switch, in
  whole pixels and with no twist, which would take it off its grid.
- The scene has no fluid and no choice of face, so Settings does not list those while it runs. A
  browser that cannot draw it, or a sheet that will not load, keeps the glass page, its
  settings and the reader's own typeface.

### Neumorphism

Soft clay. The page is one material, a light clay or a dark one, lit from the top left. The plates and the buttons stand
proud of it, with a light shadow up and to the left and a dark one down and to the right; the wells
are pressed into it, and in a hollow the two shadows change sides. Whatever is on or open is pressed
in: a switch that is on, the chosen theme, clay and typeface, the gear while Settings is open, the
dial's plate while its detail is open, a download while it is drawn.

- **The page says what Glass's says, in many plates.** Where Glass is one sheet with the cost strip
  under it, Neumorphism lays each part out as a plate of its own, a gap apart: the header's three
  (the name and plan, the freshness, the gear); the dial's plate, with the limit's name over the
  dial and the countdown and verdicts under it, beside the chart's well; the controls' four; and
  the cost strip's three (what it is and is not, its total, the breakdown). Opening the detail adds
  its own: its heading beside its four figures (over them where the page is narrower), a plate
  each, its words under them (in two columns where there is room) and its download under those.
  The order is the glass page's, with the controls' four stops (Clay, Vibration, Typeface, Local
  token accounting) after the limit and its detail and before the cost strip, where they are
  drawn, so the keyboard and screen readers go through it as they do there; nothing is drawn
  behind it. As the window narrows, the controls go two to a row and the detail's heading goes over
  its figures; then the chart drops under the dial, whose plate then holds its words beside it;
  then the figures go two to a row; and at a phone's width the plates stand lower and closer, so
  their shadows still fall inside the page, and the controls go one to a row.
- **Its settings are on the page.** Settings lists only the theme. The clay (Light, Dark, System)
  and the typeface are rows of keys, the chosen one pressed in; the vibration and the cost strip
  are switches; each on a plate of its own under the row it changes, with the panel's names and
  hints. They are the same settings as the panel's, kept and followed in the same way, so a
  choice made here holds when another theme lists it in Settings, and the other way round. With
  the cost strip switched off its plates go, and its switch stays.
- **The ring is a dial.** Its face stands proud of the plate, the track is a groove cut into the
  face, and the arc lies in the groove, under the groove's own shading. The numeral sits on the
  hub. The tick is still white, in a dark setting that holds it off the face, light or dark; at the
  cap the hub floods, as the well does in Glass. A held reading's dashed rim lies out on the face's lip,
  where the groove's wall cannot hide it.
- **Plates stand, wells sink.** The dial's plate goes down while its detail is open, as a key does,
  and the chart's well is cut to the dial plate's height, its chart drawn taller to fill it. The
  detail's figures are set large, with what they are in under them, and wrap rather than lose
  their ends.
- **Its palette is its own.** As in Glass, the ground does not follow the ring: the clay is the same
  at 5% as at the cap. On the light clay the arc, the chart and the marks keep the band colours, in
  darker inks for a light ground (teal, ochre, rust and crimson, relative luminance .18 → .12 → .08
  → .05), whose lightness still falls with danger, so on the clay the worse the reading, the harder
  it stands out; each holds 3:1 against the groove's floor, which is darker than the clay. Its pace
  channel runs from slate to a deep orange whose lightness falls between the ochre's and the
  rust's. On either clay a word in a band's colour, the band's name in the detail and *cap* beside
  the ring, is taken part of the way to the text's ink, so it reads as text and not only as a mark;
  and over pace the numeral takes on the pace ink in place of Glass's glow (on the light clay a glow
  would only stain the hub). The faintest of the text's inks holds 4.5:1 on either clay.
- **The dark clay** is the same material at night, chosen with the Clay keys or taken from the system, and
  it follows the system as that changes. Its bands and its pace channel are Glass's, which were set
  for a dark ground, the channel starting from a lighter slate so that a mild over-pace verdict
  never reads quieter than the faintest ink. With them comes Glass's bloom, rising with danger so
  that a darker band does not recede, but kept inside the groove, so it lights the channel and not
  the face around it. Its inks hold at least the light clay's contrasts. The theme's patch in
  Settings shows whichever clay picking it would give, so it can be seen before the theme is on.
- **Nothing moves but the shake.** The ring shakes while over pace as it does in Glass, by the same
  rule and on the same switch, and the freshness dot breathes while it waits for a first reading,
  as in Glass. There is no fluid and no animated background, so the controls offer neither; the
  reader's typeface is kept. The system's reduced-motion setting still stills the ring, and the
  vibration's plate says so while it is on.
- Forced colours drop every shadow, and with them every edge the theme has, so there the plates,
  wells, keys and buttons get their edges back as borders, and the switches a track and a knob.
  There the ground is the system's, so the clay follows the system's palette whatever the Clay
  keys say; the choice returns when forced colours are off.
- The saved graph is drawn on a clay plate, standing up out of the clay.

### Broadsheet

The page as a newspaper, written and drawn by hand: ink on newsprint. The words are handwritten,
in Caveat, and everything drawn is inked by hand: the rules, the boxes, the ring's edges and its
hatched track, and the chart's grid and hatching. The ink boils.

```
 [MAX · 20×]                    Quota                              ⚙
 ════════════════════════════════════════════════════════════════════
 THURSDAY 12 NOVEMBER 2026                      ● live · updated 13s ago
 ────────────────────────────────────────────────────────────────────
   ◜◞   CURRENT WEEK (ALL MODELS)  │ LAST 12H OF HISTORY      burn +0.80 %/hr
  (62%) 6d 5h 59m                  │ 100 ┤        ▁▂▃▅▆▇▇██
        [STOP PRESS]               │  50 ┤ ╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱
        ▲ 51 pts over pace · 5.8×  │   0 ┤ 03:26             now
```

- **The page says what Glass's says, laid out as a front page.** The header is a masthead: the name
  large in the middle, the plan in a boxed ear on its left and the gear on its right, a double rule
  under them, and a dateline under that, with today's date on the left and the freshness on the
  right, closed by a thin rule. The date is drawn only here, and is not read out: it dresses the
  page and is not a reading. The limit is the lead, its ring and chart with a column rule between
  them; its detail opens under it as an article, with the limit as its headline, the band and
  *close* in boxes beside it, the four figures between column rules, and the words in columns
  opening on a dropped initial, ragged as a hand runs; the download sits under a rule. The cost
  strip is a boxed notice under its rule, in its own family's inks. The order, and so the
  keyboard's and screen readers' path through it, is the glass page's.
- **The hand is the same every time.** A rule is a fixed drawing, a filled stroke thicker where the
  pen came down and thinner where it lifted; a box is four strokes running past each other at the
  corners, whose corners keep their size as the box grows. The ring's two edges are circles drawn
  freehand, a little out of round, each running on past its start and coming round a pen's width
  off it; they are seeded from the limit they belong to, never from the clock or chance, so a
  reading that has not moved draws the same ring, and the page opened again draws the same page.
  The pen's roughness is a fixed noise.
- **Readings keep their places.** The arc and the trace are drawn exactly where they are, and the
  pen roughens their edges by under a pixel; the threshold marks and the tick are drawn clean. The
  boil moves any of them by about a pixel at most, and back. Only what is not a reading wanders
  further: the ring's edges, and the chart's pencilled grid.
- **The ring is engraved.** Its track is hatched in the ink between the two edges; the arc is laid
  over the hatching in the band's ink, and the edges are inked again over the arc. The tick is the
  ink, as it is white on the glass, and the detail calls it the inked tick; over pace the numeral
  takes on the pace ink, as on Neumorphism. At the cap the hub is cross-hatched in the band's ink,
  a different shape as the flooded well is in Glass, with the numeral knocked out of the
  hatching. A held reading's rim is a dashed circle outside the edges; an unknown reading has no
  hatching, broken edges and a dash.
- **The chart is drawn by hand.** The grid is pencilled, the trace is in pen, the fitted run is
  hatched in the band's ink, and the fit's upright, the warning floor and the projection are
  dashed unevenly, as a pen dashes. The chart stands taller than the glass's: 150px, and 120px at
  a phone's width.
- **Its palette is its own.** The paper is the same at 5% as at the cap, and the page's own
  colours are one ink on it, so any colour on the page is a reading: the bands, the pace channel,
  the hold and down tones and the cost strip's family keep Neumorphism's light-clay inks, set for a
  light ground, whose lightness still falls with danger. A word in a band's colour is taken part
  of the way to the ink, as on the clay. The steady and unknown inks hold 3:1 on the paper and the
  faintest text 4.5:1, where the paper is darkest.
- **Nothing moves by itself but the ink, which boils.** As a drawn film's lines tremble from one
  drawing to the next, the whole page, words and drawings, steps through three fixed roughenings
  about seven times a second, each moving a line by about a pixel at most. It loops and goes
  nowhere, so it holds at any reading; the paper's grain stays still. *Boiling ink* in Settings
  switches it off, and the system's reduced-motion setting, forced colours and a hidden tab stop
  it. There is no fluid, no shake and no animated background, and the freshness dot does not
  breathe; the arc and the chart move only when a reading does, and the detail and Settings open as
  they do on the glass. A loud overrun, the one that also states its multiple of the clock, is
  headed **STOP PRESS** in a box over its pace line instead of shaking; the box adds nothing to
  what is read out, and at the cap it goes, as the shake does there, since the hatched hub already
  says it. Settings lists the theme, the boil and the cost strip.
- **Its hand is its own.** It is written in Caveat whatever the typeface says, figures included,
  which are all of one width in this hand, so a countdown does not shift as it runs; the reader's
  own choice returns with Glass or Neumorphism. The hand is drawn a fifth larger than its nominal
  size, as its small letters are short, and runs larger than the glass page's type, with its
  capitals closer together than letter-spaced type would set them. It has no ▲ ▼ ◆, which come from
  Source Serif 4, and no italic, so nothing is slanted.
- As the window narrows, the figures go two to a row and the freshness goes under the date, then
  the chart drops under the ring with a rule over it in place of the column rule, and at a phone's
  width the plan and the gear go up over the name and the rule's words wrap.
- Forced colours keep the words and drop the drawings' fixed ink, so there the rules and boxes
  come back as plain lines in the system's colours, the chosen theme and the switches that are on
  are marked in the system's highlight, and the ink holds still. On a dark forced palette the
  readings take Glass's inks, set for a dark ground.
- The saved graph is drawn on the paper, in a frame inked by hand with a double rule under its
  heading, its run hatched as on the page.

### Gauges

The page as a motorcar's instrument panel: a fascia of black wrinkle paint in a chrome moulding,
the limit as a round gauge on it, and its chart as a strip-chart recorder. The words are printed on
the paint in B612. Its palette is fixed, and only an instrument's own conventions signal.

```
 QUOTA [MAX · 20×]                                 ◉ live · updated 13s ago   (⚙)
 ╭──────────────────────────────────────────────────────────────────────────────╮
 │    ╭────▽─────╮    CURRENT WEEK (ALL MODELS)     LAST 12H OF HISTORY    burn │
 │   ╱ 40  50  60 ╲   RESETS IN                     ┌·······················┐   │
 │  │ 30    ╱   70 │  [4]d[0][3]h[5][9]m            │100 ───────────────────│   │
 │  │ 20   ╱    80 │  (●) PACE   (○) LIMIT          │ 50 ___▁▂▃▅▆▇━━━┃      │   │
 │  │ 10  ●     90 │  ▲ 20 pts over pace            │  0 ────────────┃      │   │
 │   ╲ 0 [60]% 100╱   cap ~Thu 18:40 · in 1d 6h     └·······················┘   │
 │    ╰──────────╯                                                              │
 ╰──────────────────────────────────────────────────────────────────────────────╯
```

- **The page says what Glass's says, as instruments.** The header is a chrome nameplate, the plan on
  an enamel badge, the freshness beside a pilot lamp and the gear on a knurled knob. The limit's row
  is the fascia: the gauge, its words in a column beside it, and the recorder. The detail slides out
  of the same fascia under a chrome lip: the title printed on the paint, the band on an enamel badge
  that is the same at every reading, *close* a push button, the four figures in windows sunk into
  the paint so that nothing reads as a control but the controls, the words in two columns, and the
  download a bank of piano keys. The words name only what the dial and the card show in that state,
  and are never longer than another theme's in the same state: with no reading, or no window
  running, there is no pace, and they keep to what stands in for it, the flag, the lights and the
  card, leaving the zones and the jewels to the words with a pace. The cost strip is a data plate of black anodised aluminium, brushed
  and screwed on: a different source in a different material, its lettering etched and its models
  told apart by etched patterns, solid, hatched, dotted, cross-hatched and ruled, not by colour. The
  order, and so the keyboard's and screen readers' path through it, is the glass page's; the gauge
  is still the ring's button, drawn sunk into the paint while its detail is open.
- **The gauge.** An ivory face printed in black, ticks every 1, 5 and 10 points and upright numerals
  every 10, sweeps 240° from 0 at the bottom left to 100 at the bottom right; the gap at the bottom,
  which the needle never crosses, holds the odometer, the legend and the flags. A polished bezel in
  facets, drawn as hard bands of reflection, holds a domed glass whose glint is drawn at the top
  left. The needle is slim and black, with a counterweight and a domed chrome cap, and its shadow
  falls at a fixed offset whatever its angle. Two stop pins stand at the scale's ends: with no
  reading the needle rests on the lower one, below 0, and at the cap it rests on the upper one, just
  past the red line, placed so the needle on it reads exactly 100.
- **The zones are printed, from the thresholds the API serves.** A warning arc runs from the
  warning floor to the cap, cut by lighter station marks into the quarters colourMarks gives, each
  painted a shade deeper toward the cap: yellow, amber, orange and red-orange, the instrument's own
  paints and never the accent colours. A red line marks the cap. A red zone is printed from
  critical only where critical stands clear of the cap, with a line of print across the band where
  it meets the warning arc, so the join does not rest on hue; the served 99% does not, and the
  detail says so. They are redrawn only when the thresholds move, and only from a reading's: with
  none the plan is unknown and its critical cut a placeholder, so the face keeps what the last
  reading printed, or, before any, the warning arc and the red line.
- **Pace is a bug on the bezel.** A polished brass triangle, a colour no zone or lamp uses, stands
  on the bezel's black step at the clock's share of the window, and a brass span on the step joins
  it to the needle: dotted while it is headroom, solid and heavier the further the needle has
  overrun the clock. On the step it stays clear of the face and the warning arc, so both read at 1x
  in every state. Within 1.5 points of the clock there is no span, and with no reading, no reset
  instant or a dormant limit neither is drawn.
- **Drums and lamps.** The percent rolls on odometer drums cut into the face below the hub: two
  figures, and a narrow hundreds wheel that turns up its 1 only at the cap. Every change slides one
  step: the new figure comes up from below when the value has risen and down from above when it
  has fallen, the old one leaving by the other side, so a drum never runs through figures the value
  did not pass; a dash counts as lower than any reading, and the dash and the blank slide like any
  figure. The step is quick (350 ms) and lands without creeping, as a drum's detent does; the
  damped swing is the needle's. A change that comes while a row is sliding waits for it to land,
  keeping only the newest, so no drum jumps part way and a row never shows a mix of two readings.
  *Resets in* is a drum counter beside the dial, in days, hours and minutes, holding at 9d 23h 59m
  for a reset further off, and the written countdown is left out; only a word (waiting, dormant,
  resetting) is still written, in the place of the empty pace and cap lines, so the counter does
  not move when a reading comes or goes.
  With no reading the odometer shows dashes, and with no reset time the counter. Two cut-glass
  jewels sit under the counter: PACE, amber, lit while the reading is more than 1.5 points past the
  bug, and LIMIT, red, lit at the cap; a held reading keeps its lamps. The pilot lamp is lit green
  while the feed is live, unlit green while it waits for its first reading, lit amber while a
  reading is held and unlit red while the service is out of reach.
- **Flags and lights.** With no reading an OFF flag, striped red and ivory, rises out of a slit in
  the face; over a held reading a HELD flag, striped black and ivory. The slit is cut only while a
  flag is up. While a reading is held or the service is out of reach, the instrument's lighting goes
  out: the face cools to grey and the lamps' light at its rim, and at the recorder card's, is gone.
- **The chart is a strip-chart recorder.** Ivory ruled paper behind glass in a chrome frame, with a
  sprocket strip along each edge, a rule every hour (or every few, where hours would crowd), one
  every 10 points, heavier at 0 and 50, and a red rule at 100. The paper is printed 0 to 100, as the
  dial is, whatever the trace reaches. The run the burn rate was fitted to is in full ink over a
  highlighter, the earlier trace fainter, with a dashed upright at `fit`. A published projection
  runs as a dashed ramp on the chart's own clock to a red ring on the cap's rule, over paper hatched
  from now to the cap's time, so a forecast is never taken for a reading; its ring is drawn over the
  pen, so a cap close to now is not hidden. The pen stands at the head on a carriage running up a
  guide rod, which at 0 and at 100 stops against the rod's bracket rather than run off its end;
  while the reading is held or missing it lifts off the paper and `PEN UP` is printed beside it. The card is 268px tall, and 212px at a phone's width.
- **Its palette is fixed.** It reads none of the colours the other themes take from the reading: the
  band's and the pace channel's inks are overruled with the paint's lettering, and the band's badge
  is the same enamel at every reading. Only the printed zones, the jewels, the pilot lamp and the
  flags signal, by the conventions of an instrument, and nothing else changes colour at any reading.
  The lettering holds 5:1 on the paint at its faintest and the print 8:1 on the ivory.
- **Nothing moves by itself.** The needle is a spring: it swings to each new reading with a little
  overshoot and settles, strikes the upper pin at the cap, gives back a little and comes to rest
  against it. The drums roll and the flags rise when the data changes them. While the reading runs
  over pace, short of the cap, the needle trembles, three slow waves of unrelated periods summing to
  at most 0.3° plus 0.7° times the pace severity, so it never visibly repeats and never leans either
  way, and never past a stop pin; a held reading keeps trembling, as Glass's ring keeps shaking.
  *Vibration* in Settings switches the tremble off. The loop runs only while the needle swings or
  trembles, and a needle pressed on its pin is at rest once its bounces are under a point a second;
  it stops in a hidden tab; the needle and its shadow are layers of their own, turned only by a transform, so
  nothing is repainted while it moves, and the paint, the grain and the brushed metal are fixed
  images. There is no fluid and no animated background, and the pilot lamp does not breathe. Under
  the system's reduced-motion setting every change is made at once, with no swing, roll or tremble,
  and a slide already running lands at once; forced colours still the tremble too.
- **Settings is a slip of the same paint** hung from the knob in a chrome moulding. The themes are a
  bank of ivory preset keys in a chrome strip, the one chosen latched down; a switch is a chrome
  bat-handle toggle on a plate printed ON and OFF, up for on; the reset is a push button. It lists
  the theme, the vibration and the cost strip.
- **Its type is its own.** It is set in B612 whatever the typeface says: a face drawn for aircraft
  cockpits, bundled in two weights, its figures all of one width. B612 has no ▲ or ◆, so they are
  drawn from its ▼, and its straight-sided parentheses, which in capitals read as brackets, are
  drawn again as curves (see `public/fonts/README.md`).
- As the window narrows, the chart drops under the instrument, the detail's figures go two to a row,
  then the freshness takes a line of its own under the nameplate with the knob still beside it, then
  the words drop under a 300px dial with the counter and the jewels side by side, and at a phone's
  width the card is shorter and the divider's words wrap. The narrowest phones get a smaller
  nameplate, counter and jewels, and a dial as wide as its row allows up to 300px, so nothing is
  wider than the screen at 320px.
- Forced colours keep the words and the instrument and drop the paint, the chrome, the glass and
  every glow. The face is the system's ground; the print, the case, the pins and the drums' figures
  are its text, and so is the line where a red zone meets the warning arc; the warning arc is grey,
  its quarters told apart by their cuts; and what reads the data, the needle, the bug and its span
  and the red line, is highlighted. A lit lamp is a filled lens and a dark one an empty ring, under
  its word, and a flag is striped in the text colour round its word. On the recorder the paper is
  the ground and the fitted run, the cap and the ramp's end are highlighted; the plate's patterns
  are etched in the text colour, so the models are still told apart. In Settings the chosen theme is
  ringed in the highlight and a switch's handle is a bar, highlighted while it is on. The gauge keeps
  a thicker highlighted focus ring over its open mark while its detail is open.
- The saved graph is drawn on the fascia's paint in a chrome moulding, the plan on its enamel badge,
  and the recorder's card in its chrome frame, its lamps' light at the rim only while the dial's is
  lit.

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
the trace. It covers at most the last 12 hours, though the history keeps about twenty days for
the graphs the detail panel saves (below), so an account switched back to after days away starts a
fresh trace instead of redrawing its old window. Below ~680px the chart drops under the ring at
full width.

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
marker carries the same warning independent of color. Neumorphism's light clay reads the same
ladder in darker inks whose lightness still falls with danger; its dark clay reads the ladder as it
is (see *Neumorphism*).

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

### Download the graph

The panel's last row saves the chart as a picture, over the last hour, 12 hours, day, 3 days or
7 days, one button each:

```
DOWNLOAD THE GRAPH   [1h] [12h] [1d] [3d] [7d]   saved quota-week-7d-2026-11-04-1222.png
```

- It is a PNG of 1200×630, drawn at twice that, named for the limit, the span and the minute it
  was saved. On it: the limit's name, the span and its dates, the reading now and its reset, the
  cap's time and how far off it is, the chart, and the burn rate as the chart's caption gives it.
- The chart is the page's own, laid out again at the picture's size, so the picture is in the
  theme on screen: its colours, its type, in Train its pixels and stepped corners, and in
  Neumorphism its clay. A span of
  a day or more marks each midnight with the name of the day, wherever the name, measured in its
  own face, clears the axis' two ends and the other names.
- The axis always covers the whole span. The server keeps about twenty days of readings (see the
  README), from when it started keeping them, so where they begin after the span does the line
  starts there and the picture says from when. A gap in them, as a machine asleep leaves, is only
  a gap in the line. Each account keeps its own.
- One save at a time: while one is drawn, the other spans are dimmed. The note says how it went,
  and when the panel was closed meanwhile, the page's live region says it too.
- The row sits outside the part of the panel rebuilt with each reading, so a button keeps its
  focus. In Matrix the terminal draws it in the detail box, its spans clickable. As the window
  narrows the heading shortens to `SAVE`, then the spans close up, and only then does the heading
  take a line of its own. The note goes on the box's bottom edge, so a save never moves the page:

```
│  DOWNLOAD THE GRAPH  [1h] [12h] [1d] [3d] [7d]               │
└─ saved quota-week-7d-2026-11-04-1222.png ────────────────────┘
```

## Settings

A gear at the right end of the header, beside the freshness pill, opens a small panel that grows
out of it and floats over the page, so a switch can be flipped while watching the ring it
changes. The gear again, Escape, a click elsewhere or focus moving away closes it.

The panel lists the theme, then only the settings of the theme on screen, and the one setting that
belongs to no theme; nothing is shown greyed out. Under Neumorphism it lists only the theme: that
theme's settings, and the cost strip's, are keys and switches on the page itself (see
*Neumorphism*), so there it has no reset either. Under Broadsheet it lists the theme, the boil and
the cost strip, and under Gauges the theme, the vibration and the cost strip.

| theme | setting | choices | default |
| --- | --- | --- | --- |
| all | Theme | Glass, Matrix, Train, Neumorphism, Broadsheet, Gauges | Glass |
| Neumorphism, on the page | Clay | Light, Dark, System — System follows the system's dark mode, as it changes | System |
| Glass | Fluid simulation | on / off — off shows the plain well and stops the GPU loop | on |
| Glass | Speed | slow / normal / fast (0.25×, 0.5×, 1×) — listed only while the fluid is on | normal |
| Glass, Train, Gauges; Neumorphism on the page | Vibration | on / off — the shake of a ring over pace; in Gauges the needle's tremble | on |
| Glass | Animated background | on / off — off pauses the drifting sky where it stands | on |
| Glass; Neumorphism on the page | Typeface | System, Source Serif 4, Noto Sans, Fira Code | System |
| Matrix | Rain | on / off — off stops the rain where it stands | on |
| Matrix | Amount | slider, 5–100% of the columns falling at once — listed only while the rain is on | 40% |
| Matrix | Speed | slider, 0.25×–2.5× of 22 steps a second — listed only while the rain is on | 1× |
| Matrix | Colour #1 | any colour — the rain; its heads are the colour lit toward white, less so the darker it is | green `#00ff66` |
| Matrix | Colour #2 | any colour — the warm rain, more of it the hotter the limit runs | red `#ff3028` |
| Train | Moving scene | on / off — off stops the train, its smoke, the fire and the station clock where they stand | on |
| Broadsheet | Boiling ink | on / off — off holds the ink still, on the plain drawing | on |
| all; Neumorphism on the page | Local token accounting | on / off — off hides the cost strip and its rule, and the page stops asking ccusage | on |

Settings change how the page looks, never what it measures or how it judges a reading:
switching the shake off leaves the over-pace verdict in the tick, the caption and the halo (in
Neumorphism, the numeral's ink; in Gauges, the PACE lamp and the solid span).
They are kept in this browser (only the ones that differ from the default), applied before the
ring is first drawn, and followed in other open tabs. A slider or a colour is followed on screen
as it moves, and kept once it is let go. The system's reduced-motion setting still stills
everything, and the panel (in Neumorphism, the vibration's plate) says so while it is on.

The three named typefaces are bundled with the dashboard and served by it, never fetched from a
font service. Fira Code also takes over the figures, which are otherwise set in the system's
monospaced face. Matrix is set in Fira Code, Train in Jersey 10, Broadsheet in Caveat, a
handwriting face, and Gauges in B612, a face drawn for aircraft cockpits, whatever the typeface
says; the reader's own choice is kept, and returns with Glass or Neumorphism. Jersey 10 is not
offered as a choice: it is a bitmap face, set at a few fixed sizes that the rest of the page does
not keep to.

The page writes its times, weekdays, dates and amounts in English, on a 24-hour clock with the day
before the month (British English), whatever the browser's language. So it reads the same
everywhere, and a typeface for it needs only the characters in `characters.txt`: printable ASCII
and nine more. Matrix's terminal draws more than that, in Fira Code.

## Footer strip

Shown unless *Settings* hides it (in Neumorphism, its switch on the page): the ccusage cost numbers.

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
