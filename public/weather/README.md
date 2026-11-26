# The Weather theme's cove

The models and textures the Weather theme builds its cove from: two headlands of photographed
cliffs, the rocks and reefs between them, a wooden pier, an old ship at anchor, a channel buoy, a
lantern, and the trees on the cliff tops. All of them are Poly Haven's
([polyhaven.com](https://polyhaven.com)), photoscanned or modelled by the people named below and
given to the public domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
(`LICENSE.txt`). CC0 asks for no credit; this is thanks.

The dashboard serves these files itself, and only the ones `manifest.json` lists: the server reads
the list once at start (`src/server.js`), so nothing else in this folder can be fetched, and the
page fetches nothing from anywhere else. Without the folder the theme shows the open sea.

## The models

| asset | folder | kind | by | LODs shipped | textures |
| --- | --- | --- | --- | --- | --- |
| [Coastal Cliff 01](https://polyhaven.com/a/coastal_cliff_01) | `coastal_cliff_01/` | cliff | Rob Tuytel (photography, processing); Rico Cilliers (cleanup) | 1, 2 | 1k |
| [Coastal Cliff 02](https://polyhaven.com/a/coastal_cliff_02) | `coastal_cliff_02/` | cliff | Rob Tuytel (all) | 1, 2 | 512 |
| [Coastal Cliff 04](https://polyhaven.com/a/coastal_cliff_04) | `coastal_cliff_04/` | cliff | Rob Tuytel (photography, processing); Rico Cilliers (cleanup) | 1, 2 | 1k |
| [Coast Line 01](https://polyhaven.com/a/coast_line_01) | `coast_line_01/` | shore | Rob Tuytel (photography, processing); Rico Cilliers (cleanup) | 1, 2 | 512 |
| [Coast Line 02](https://polyhaven.com/a/coast_line_02) | `coast_line_02/` | shore | Rob Tuytel (photography, processing); Rico Cilliers (cleanup) | 1, 2 | 512 |
| [Coast Rocks 01](https://polyhaven.com/a/coast_rocks_01) | `coast_rocks_01/` | shore | Rob Tuytel (photography, processing); Rico Cilliers (cleanup) | 1, 2 | 512 |
| [Coast Rocks 02](https://polyhaven.com/a/coast_rocks_02) | `coast_rocks_02/` | shore | Rob Tuytel (photography, processing); Rico Cilliers (cleanup) | 1, 2 | 512 |
| [Coast Land Rocks 02](https://polyhaven.com/a/coast_land_rocks_02) | `coast_land_rocks_02/` | rock | Rob Tuytel (photography, processing); Rico Cilliers (cleanup) | 1 | 512 |
| [Coast Land Rocks 04](https://polyhaven.com/a/coast_land_rocks_04) | `coast_land_rocks_04/` | rock | Rob Tuytel (photography, processing); Rico Cilliers (cleanup) | 2 | 512 |
| [Coast Rocks 05](https://polyhaven.com/a/coast_rocks_05) | `coast_rocks_05/` | rock | Rob Tuytel (all) | 1, 2 | 512 |
| [Sand Rocks Small 01](https://polyhaven.com/a/sand_rocks_small_01) | `sand_rocks_small_01/` | rock | Rob Tuytel (photography, processing); Rico Cilliers (cleanup) | 1, 2 | 512 |
| [Mountainside](https://polyhaven.com/a/mountainside) | `mountainside/` | rock | Dario Barresi (photography); Rico Cilliers (processing) | 1, 2 | 512 |
| [Dutch Ship Large 01](https://polyhaven.com/a/dutch_ship_large_01) | `dutch_ship_large_01/` | vessel | James Ray Cock (model, textures, cleanup); Rico Cilliers (sails model, textures); Nicolò Zubbini (original model) | 1, 2 | 512 |
| [Modular Wooden Pier](https://polyhaven.com/a/modular_wooden_pier) | `modular_wooden_pier/` | prop | Rico Cilliers (all) | 1, 2 | 1k |
| [Lateral Sea Marker](https://polyhaven.com/a/lateral_sea_marker) | `lateral_sea_marker/` | prop | James Ray Cock (additional texture wear); Kuutti Siitonen (all) | 2 | 512 |
| [Wooden Lantern 01](https://polyhaven.com/a/wooden_lantern_01) | `wooden_lantern_01/` | prop | James Ray Cock (all) | 2 | 512 |
| [Island Tree 01](https://polyhaven.com/a/island_tree_01) | `island_tree_01/` | vegetation | Rob Tuytel (scanning, processing); Rico Cilliers (cleanup, processing) | 2 | 512 |

## The ground

Four tiling texture sets, laid over the headlands' terrain by slope and height, at 512 px.

| asset | folder | layer | by | tile |
| --- | --- | --- | --- | --- |
| [Aerial Rocks 02](https://polyhaven.com/a/aerial_rocks_02) | `terrain/aerial_rocks_02/` | rock | Rob Tuytel (all) | 50 m |
| [Seaside Rock](https://polyhaven.com/a/seaside_rock) | `terrain/seaside_rock/` | wet rock | Dimitrios Savva (all) | 2 m |
| [Coast Sand 01](https://polyhaven.com/a/coast_sand_01) | `terrain/coast_sand_01/` | sand and pebbles | Rob Tuytel (all) | 15 m |
| [Aerial Grass Rock](https://polyhaven.com/a/aerial_grass_rock) | `terrain/aerial_grass_rock/` | cliff-top grass | Rob Tuytel (all) | 15 m |

## How they were made from Poly Haven's files

- **Meshes**: each source model simplified to levels of detail at about 25 % (LOD 1) and 6 %
  (LOD 2) of LOD 0's triangles; only the levels the theme draws ship. Saved as glTF 2.0 binaries
  with `KHR_mesh_quantization` (positions as 16-bit integers, normals as 8-bit, texture
  coordinates as 16-bit), interleaved, with 16-bit indices. No Draco, meshopt or Basis.
- **Textures**: WebP (`EXT_texture_webp`), in two sets, `1k/` for the four largest pieces and
  `512/` for the rest: `basecolor` (sRGB, its alpha the cut-out for leaves and sails), `normal`
  (tangent space, OpenGL's +Y) and `orm` (ambient occlusion, roughness and metalness in R, G and
  B). The ground's sets are `albedo`, `normal`, `orm` and `height`.
- **The shipped set**: the Weather lab's stage step copies, from the asset pipeline's output, the
  subset its plan chooses (which models, which levels, which texture set), under the same names,
  and writes `manifest.json`: the models, the ground layers, and every file with its size and the
  start of its SHA-256, which the page adds to each request so a changed file is fetched anew.
  The pipeline is not part of this repository (the lab page is, in `weather/`). Here: 114 files
  (29 GLB, 85 WebP), 15.7 MB.

`wx.js` beside them is not one of these assets: it is the theme's renderer, the project's own code
under its MIT licence, built from its sources in `weather/` by `tools/build-weather.mjs`.

The lighthouse at the end of the right-hand headland is not one of them either. Poly Haven has no
lighthouse model, so the renderer builds it in code from primitives (a granite tower on a stack of
rock) and it ships no files.

The GLBs' own image references name `1k/` even where only `512/` ships. The theme takes each
texture from `manifest.json` instead, so this does not matter to the page; to open a GLB in
another viewer, point its images at the folder that is here.
