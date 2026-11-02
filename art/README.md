# Train theme: the art

The sources of `public/sprites/train.png`. Nothing here is served or shipped.

| file | what |
| --- | --- |
| `train.lua`, `village.lua`, `hell.lua` | the three sprite families, each drawn in code |
| `px.lua` | the drawing kit they share |
| `pack.lua` | stacks the families into the sheet the page loads |
| `train.aseprite` | the packed sheet with `base` and `lights` layers and a slice per sprite, to look at |

To rebuild, run each family and then the packer in Aseprite 1.3, with `ART` set to this folder and
`OUT` to the repository root:

    ART = "/path/to/art"; dofile(ART .. "/train.lua")
    ART = "/path/to/art"; dofile(ART .. "/village.lua")
    ART = "/path/to/art"; dofile(ART .. "/hell.lua")
    ART = "/path/to/art"; OUT = "/path/to/repo"; dofile(ART .. "/pack.lua")

Then paste `sprites.js`, which the packer writes here, over `SPR` in `public/index.html`. The
family PNGs, JSON and previews are working files, and git ignores them.

The rest of this file is the contract the art was drawn to.

The dashboard's new theme is a pixel-art side-scroller on a low-resolution canvas (about 480×240,
upscaled with hard pixels). A steam train runs right through a village under a sky whose colour is
the page's accent: teal `#72EAD0` by day, amber at dusk, deepening to red. Past 92.5% usage the train
is swallowed by a demon's mouth and rolls through burning hell. At 100% it stops.

## How the art is used
- The camera follows the train: the train stays put on screen, wheels turning, and the world scrolls
  LEFT past it. The train faces RIGHT. Layers scroll at different speeds (parallax).
- **Everything is drawn in neutral DAY colours and tinted at run time** by multiplying the whole sheet
  with a light colour: warm dark at dusk, red dark in hell. So do NOT bake sunset or fire light into
  the base art. Form shading is fine and wanted; a sprite must keep a readable silhouette and value
  range after being multiplied by the page's darkest lights, `LIGHT.eveLow` `#AA5E66` and `LIGHT.pit`
  `#D65448`. The `-dusk` preview shows the untinted art against a sunset backdrop, `#E2793C`; it does
  not multiply it.
- **Lights are a separate image at the same coordinates** (`sheet.lights`): windows, lamps, headlamp,
  firebox, glowing eyes, embers. They are drawn untinted at dusk and in hell, fading in. Only warm
  colours: `yellow`, `skin`, `sand`, `rust`, `coral`, `red`. Base art under a light is a dark window.
  Check them with the `-lit` preview.

## Rules every sheet keeps (`P.save` prints violations; both counts must be 0)
- Palette: DawnBringer 32 only, by the names in `px.lua` (`P.C`).
- Alpha is 0 or 255. No anti-aliasing, no gradients except ordered dither by hand.
- Bottom row of a sprite is where it touches the ground. No padding rows under it; none around it.
- Each sprite is a strip of equal frames, left to right, reserved with `P.strip`.
- Animated strips must loop perfectly; every frame keeps the same pivot.
- Sheet width 512. Keep the names the family files give their sprites; the engine looks them up by
  name in `SPR`, and `field`, `track` and `front` by name plus biome number.

## Style
16-bit side-scroller warmth: think SNES-era JRPG towns, small and charming, chunky and readable at
4× zoom on a laptop. Clean clusters, no noise, no pillow shading, no orphan pixels. Selective outline:
outline in a darker shade of the sprite's own colour rather than black, so it reads against both a
bright teal sky and a dark red one. Black only for the deepest gaps. Details are few and deliberate:
a sprite this small is a silhouette plus two or three telling touches. Think in clusters of 2+ pixels.

## Scene geometry (scene pixels, from the bottom of the canvas H)
- Rail top, where wheels touch: `railY = H - 24`.
- `track*` tile: 32×10, top row at `railY - 1`. Rails in rows 0-1, sleepers and ballast under them.
- `front*` tile: 32×16, sits at `H - 16`, in front of the track, down to the window's bottom edge.
- `field*` tile: 32×26, sits at `railY - 26`, the land behind the track. Its top edge meets hills.
- Tiles must repeat seamlessly left-right, and any biome's tile must sit beside any other's with no
  gap in the rows they share. Each is a strip of variants or frames.
- Back row of scenery stands on the field's top edge, main row a few pixels further down.
- Biomes: 0 green, 1 dry (a summer drought, yellow-brown), 2 ash (scorched, grey-black, embers),
  3 hell (basalt and lava).

## Delivery
A family is one Lua file at `<ART>/<family>.lua`, run by `mcp__aseprite__run_lua_script` with:

    ART = "<ART>"; dofile(ART .. "/<family>.lua")

Load that tool with ToolSearch first (`select:mcp__aseprite__run_lua_script`). The file starts with
`local P = dofile(ART .. "/px.lua")` and ends with `P.save(sheet, ART, 3)`. That writes
`<family>.png`, `<family>-lights.png`, `<family>.json`, and the previews `<family>-day.png`,
`<family>-dusk.png`, `<family>-lit.png`. LOOK at the previews with Read after every change. Pixel art
is judged by eye, and you are expected to iterate until it is genuinely charming, not just correct.
Read `px.lua` first: `P.map` (ASCII art) is the best tool for anything under 40 px; `P.rect`, `P.line`
and `P.disc` for large forms; `P.blit` to compose frames from a shared base.

