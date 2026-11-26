/* ═══════════════════════ Weather: the coast pass (scenery stream F, contract v1.1) ═══════════════════════
   The cove of DESIGN 13: two headlands of procedural terrain faced with CC0 photoscans, reefs, a pier, a
   ship at anchor, a buoy and plants, drawn in the coast slot between the sky and the sea.

   What the slot does, in order (DESIGN 13.3):
     1. once, after the view is up and the manifest lists the cove: the heightfield (1024² R16F, the GLSL twin
        of WX.COVE.height), its sky openness (RGBA8), the terrain fan's land and shallow-bed index ranges (an
        async readback), and the shore field SHORE (top-down heights, jump flood, swell exposure)
     2. the key light's shadow map (SUNSHADOW), only when the light moved > 0.05 deg, the tier changed or the
        arrived set changed; the ship's own map every world frame
     3. the cove into SCENE + SCENEZ + depth: forward while anything fades (the 2 s rise, 0.5 s LOD and map
        cross-fades), else from the static-cove cache (a G-buffer of everything that never moves, remade on
        resize, tier change or arrival, restored by a depth blit and one relighting pass) with only the ship,
        the buoy, the lantern and the plants drawn forward (p.coastCache)
     4. the thin wires (the rigging, the anchor cable) blended, as triangles with exact pixel coverage ([r2])
     5. the mirror into COASTREFL the same way, and its mips
   It provides the "coast" GLSL library and fills R.coast (contract section 8) in its ubo() hook.

   Holds at any reading (DESIGN 2.5): nothing here accumulates. Every motion is a function of the scene clocks
   (sway and rings divide the rain clock's 240 s, the ship and buoy divide the sea's 1024 s) or of SEAPROBE;
   wetness is a pure function of uWx4 (the director's walkers). The fades are startup transients on the wall
   clock and end at 1.                                                                                       */

/* ── The composition (DESIGN 13.1). World frame: metres, the eye at (0, 14, 0), +z the heading.
   Each item: the Poly Haven id, the mesh half-extents [x, y, z] in its own metres and its base (lowest y),
   the placement (pos = where the mesh origin goes, yaw degrees from +z toward +x of the mesh's +z axis,
   uniform scale), the LOD per tier T0..T4 (0 finest), the texture set shipped, and why the piece is there.
   [critic] Kits (the pier, the grass, the ferns) draw one named node per instance: `part`.                 */
WX.COVE = (function () {
  /* ── noise and the heightfield. The hash is an integer one, so the GPU's copy (coast.hgt) gives the same
     heights to the last float bit as this function, which places the cliffs, the trees and the frame tests. */
  const hashI = (i, j) => {
    let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  const vnoise = (x, z) => {
    const i = Math.floor(x), j = Math.floor(z), u = x - i, v = z - j, su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
    const a = hashI(i, j), b = hashI(i + 1, j), c = hashI(i, j + 1), d = hashI(i + 1, j + 1);
    return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
  };
  const fbm = (x, z, oct) => { let s = 0, w = 0.5, f = 1; for (let k = 0; k < oct; k++) { s += w * (vnoise(x * f, z * f) * 2 - 1); w *= 0.5; f *= 2.03; } return s; };
  const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const smax = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.max(a, b) + h * h * k * 0.25; };
  /* the ridge tables: x, z, top height m, half-width m, from the near end to the point */
  const heads = [
    /* the left head: high, its inner shore seen along its length, its point at -23 deg */
    [[-860, 120, 105, 360], [-760, 520, 112, 330], [-700, 860, 88, 220], [-640, 1110, 52, 125], [-600, 1260, 22, 60]],
    /* the right head: lower and farther, its point at +27 deg */
    [[900, 140, 82, 340], [850, 620, 78, 290], [800, 1000, 62, 200], [760, 1300, 34, 110], [740, 1420, 14, 55]],
    /* the land behind and under the window */
    [[-700, -110, 18, 170], [0, -150, 18, 175], [700, -110, 18, 170]],
  ];
  function ridge(pts, x, z) {
    let bd = 1e9, bH = 0, bw = 1;
    for (let k = 0; k < pts.length - 1; k++) {
      const [x0, z0, h0, w0] = pts[k], [x1, z1, h1, w1] = pts[k + 1];
      const dx = x1 - x0, dz = z1 - z0, L2 = dx * dx + dz * dz;
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / L2));
      const px = x0 + dx * t, pz = z0 + dz * t, d = Math.hypot(x - px, z - pz);
      const w = w0 + (w1 - w0) * t;
      if (d / w < bd / bw) { bd = d; bH = h0 + (h1 - h0) * t; bw = w; }
    }
    return { d: bd, H: bH, w: bw };
  }
  /* height m above still water at (x, z). The heads: a flat top falling steeply over the last 14 % of the
     half-width, then a foot falling 1:3 to the bay floor, continuous at the edge (the stub stepped 0.6-3.6 m
     there); the bay floor deepens to sea; heads and floor meet by a smooth maximum. The three fbm terms do
     not depend on the head, so they are evaluated once (the GPU twin does the same). */
  /* [scenery] the faces: gullies and buttresses cut across the shore (the heads run out along z, so a noise in
     z + 0.35 x runs down their faces), sharp in the creases (|2n - 1|^0.6), at 46 m and 17 m; and strata benches
     every 9 m of height on the steep band */
  const gully = (x, z) => {
    const u = (z + 0.35 * x) / 46, u2 = (z + 0.35 * x) / 17;
    const r1 = Math.pow(Math.abs(2 * vnoise(u, x / 160 + 5.3) - 1), 0.6), r2 = Math.pow(Math.abs(2 * vnoise(u2, x / 90 + 9.1) - 1), 0.6);
    return 1 + 0.06 * (r1 - 0.55) + 0.022 * (r2 - 0.55);
  };
  const bench = (h) => { const t = h / 9, f = t - Math.floor(t); return 9 * (Math.floor(t) + smoothstep(0.25, 0.75, f)); };
  function height(x, z) {
    let h = Math.max(-(2.0 + 0.021 * Math.max(z, 0) + 0.004 * Math.abs(x)), -46);
    const wob = (1 + 0.14 * fbm(x / 140, z / 140, 3)) * gully(x, z), tf = 0.88 + 0.12 * fbm(x / 60 + 7, z / 60, 3), d3 = 3 * fbm(x / 23, z / 23, 2);
    for (const pts of heads) {
      const r = ridge(pts, x, z), q = r.d / (r.w * wob);
      let land;
      if (q < 1) {
        const top = r.H * (1 - smoothstep(0.86, 1.0, q)) * tf, band = smoothstep(0.8, 0.88, q) * (1 - smoothstep(0.97, 1.0, q));
        land = top + (bench(top) - top) * 0.45 * band + d3;
      } else land = d3 - (r.d - r.w * wob) * 0.3;
      h = smax(h, land, 6);
    }
    return h;
  }
  /* a point on a head's waterline: from its ridge at segment parameter s, along the normal to `side`
     (+1 the ridge's right, the left head's cove side; -1 its left, the right head's) */
  function shoreAt(hi, s, side) {
    const pts = heads[hi], k = Math.min(pts.length - 2, Math.floor(s)), t = s - k;
    const [x0, z0] = pts[k], [x1, z1] = pts[k + 1], dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz);
    const nx = (side * dz) / l, nz = (-side * dx) / l;
    let x = x0 + dx * t, z = z0 + dz * t, top = 0;
    for (let i = 0; i < 600 && height(x, z) > 0; i++) { top = Math.max(top, height(x, z)); x += nx * 2; z += nz * 2; }
    return { x, z, nx, nz, yaw: (Math.atan2(nx, nz) * 180) / Math.PI, top };
  }
  const R1 = (v) => Math.round(v);

  const items = [];
  const put = (o) => { items.push(o); return o; };
  /* sizes (m) of the processed meshes (manifest bboxM, glTF space, y up): [x, y, z, min y]; for the kits, the
     size of one part (a deck section, a tuft, a fern). The ship is listed bow along +z, as the layout's yaw
     means; its GLB has the bow along +x (AXIS). */
  const DIM = {
    coastal_cliff_01: [91.98, 10.33, 10.97, -0.65], coastal_cliff_02: [40.93, 10.05, 8.65, -0.23],
    coastal_cliff_04: [86.77, 11.0, 24.25, -0.65], coast_line_01: [54.61, 2.63, 42.96, -1.17],
    coast_line_02: [45.64, 2.29, 23.28, -0.59], coast_rocks_01: [59.51, 3.29, 42.52, -1.98],
    coast_rocks_02: [45.97, 3.17, 49.47, -0.92], coast_rocks_05: [4.04, 1.33, 3.75, -0.25],
    coast_land_rocks_02: [4.89, 1.4, 10.46, -0.16], coast_land_rocks_04: [9.96, 0.85, 11.5, -0.06],
    sand_rocks_small_01: [4.63, 0.54, 3.88, -0.1], rock_face_02: [2.71, 2.47, 2.13, -0.14],
    mountainside: [10.21, 10.52, 5.25, -0.2], dutch_ship_large_01: [8.39, 32.08, 34.25, -1.92],
    modular_wooden_pier: [2.5, 4.6, 3.3, -1.0], lateral_sea_marker: [3.0, 6.84, 3.0, -1.28],
    wooden_lantern_01: [0.22, 0.53, 0.24, -0.01], island_tree_01: [4.76, 5.03, 4.82, -0.02],
    shrub_04: [0.58, 0.22, 0.15, -0.01], fern_02: [0.9, 0.35, 0.8, -0.03], grass_medium_01: [0.25, 0.25, 0.25, -0.02],
  };
  const AXIS = { dutch_ship_large_01: -90 };
  /* [scenery] each scan's base colour tinted toward one rock colour (the four big scans' linear mean), by the
     ratio of the means to the power 0.6, so neighbouring scans and the terrain's rock layer read as one rock.
     Printed by lab/tests/scenery/table.cjs --tints from the shipped base colours; re-run it if the assets change. */
  const TINT = {
    coastal_cliff_01: [1.515, 1.483, 1.454], coastal_cliff_02: [1.032, 0.949, 0.882], coastal_cliff_04: [1.032, 1.03, 1.188],
    mountainside: [0.753, 0.804, 0.79], coast_line_01: [1.578, 1.55, 1.454], coast_line_02: [1.048, 0.964, 0.917],
    coast_rocks_01: [0.893, 0.891, 0.866], coast_rocks_02: [0.834, 0.852, 0.866], coast_rocks_05: [0.868, 0.919, 0.974],
    coast_land_rocks_02: [0.987, 1.048, 1.084], coast_land_rocks_04: [0.868, 0.905, 0.955], sand_rocks_small_01: [0.8, 0.8, 0.79],
    terrainRock: [0.95, 0.92, 0.78], terrainWet: [1.214, 1.145, 0.995],   // [r2] terrainRock: after the shader's half desaturation
  };
  const item = (name, id, role, pos, yaw, scale, lod, tex, why, extra) => {
    const d = DIM[id];
    return put(Object.assign({ name, id, role, pos, yaw, scale, half: [d[0] / 2, d[1] / 2, d[2] / 2], base: d[3], lod, tex, why, part: null }, extra || {}));
  };
  /* a cliff or ledge on a head's waterline, its face (+z of the mesh) seaward; setback in half-depths */
  /* [scenery] the cliff scans stand +-3 m up or down by a hash, so their tops do not draw one level ledge along the run */
  const onShore = (name, id, role, hi, s, side, scale, y, setback, lod, tex, why) => {
    const p = shoreAt(hi, s, side), back = (DIM[id][2] / 2) * scale * setback;
    const dy = role === "cliff" ? Math.round((hashI(Math.round(s * 100), 41 + hi) - 0.5) * 60) / 10 : 0;
    return item(name, id, role, [R1(p.x - p.nx * back), y + dy, R1(p.z - p.nz * back)], R1(p.yaw), scale, lod, tex, why);
  };
  /* LOD per tier T0..T4 (0 finest), chosen against the manifest's px1At1080M (lab/tests/scenery/budget.cjs
     prints each one's p99 error in 1080p pixels): HF the headland cliffs, FAR everything at LOD 2,
     MID the reefs, NEAR the shelves and rocks near the window, HERO the ship */
  const HN = [2, 2, 1, 1, 1], HF = [2, 2, 2, 1, 1], FAR = [2, 2, 2, 2, 2], MID = [2, 2, 1, 1, 1], NEAR = [1, 1, 1, 1, 1], HERO = [2, 2, 2, 1, 1];
  /* [scenery] HERO was [1, 1, 0, 0, 0]: the assets workflow's second run made the ship's LOD1 lossless at 417 m
     (0.05 px at 1080p) and its LOD2 0.7 px with every rope kept (missingFrac 0.0003); LOD0 no longer ships */
  /* the left head (cove side +1) */
  onShore("L-face", "mountainside", "cliff", 0, 0.75, 1, 6.5, -5, 0.5, HN, "512", "the left head's tallest face, at the left edge of 16:9 and wider views");
  onShore("L-cliff-1", "coastal_cliff_04", "cliff", 0, 1.3, 1, 4.2, -4, 0.55, HN, "1k", "the inner shore seen along its length; its strata catch the low sun");
  onShore("L-cliff-2", "coastal_cliff_01", "cliff", 0, 1.85, 1, 4.0, -4, 0.55, HF, "1k", "the cliff that frames the left edge of a 16:10 view");
  onShore("L-cliff-3", "coastal_cliff_04", "cliff", 0, 2.45, 1, 3.4, -4, 0.55, HN, "1k", "the run of cliff toward the point");
  onShore("L-point", "coastal_cliff_02", "cliff", 0, 3.05, 1, 3.6, -4, 0.55, HF, "512", "the point; winter sunsets go down just right of it");
  onShore("L-point-2", "coastal_cliff_02", "cliff", 0, 3.75, 1, 3.0, -4, 0.4, HF, "512", "the point's end, facing the viewer, backlit at sunset");
  onShore("L-ledge", "coast_line_01", "platform", 0, 1.6, 1, 1.6, -1.4, -0.45, FAR, "512", "the wave-cut platform at the cliff foot, where swash runs");
  onShore("L-boulders", "coast_land_rocks_04", "rocks", 0, 2.75, 1, 3.4, -0.7, -0.6, FAR, "512", "boulders at the foot: contact foam and splashes");
  { const p = shoreAt(0, 3.98, 1), x = R1(p.x + 40), z = R1(p.z + 95);   // its scanned face turned to the window
    item("L-stack", "mountainside", "stack", [x, -4, z], R1((Math.atan2(-x, -z) * 180) / Math.PI), 3.4, FAR, "512",
      "a sea stack off the point: the swell breaks white around it in a storm"); }
  /* the right head (cove side -1) */
  onShore("R-face", "mountainside", "cliff", 1, 0.8, -1, 6.0, -5, 0.5, HF, "512", "the right head's tallest face, at the right edge of wide views");
  onShore("R-cliff-1", "coastal_cliff_04", "cliff", 1, 1.45, -1, 4.0, -4, 0.55, HN, "1k", "the right head's inner shore, darker against the evening sun");
  onShore("R-cliff-2", "coastal_cliff_01", "cliff", 1, 2.25, -1, 3.5, -4, 0.55, HF, "1k", "the right head toward its point");
  onShore("R-point", "coastal_cliff_02", "cliff", 1, 3.1, -1, 3.4, -4, 0.55, HF, "512", "the right point; summer sunsets go behind it only on ultrawide views");
  onShore("R-ledge", "coast_line_02", "platform", 1, 1.9, -1, 1.6, -1.3, -0.45, FAR, "512", "the ledge at the right head's foot");
  /* the middle ground: reefs where the swell breaks, clear of the sun's usual path */
  item("reef-1", "coast_rocks_02", "reef", [168, -2.2, 372], 35, 1.2, MID, "512", "a reef awash right of centre: the swell steepens and breaks over it at every reading, white in a storm");
  item("reef-2", "coast_rocks_01", "reef", [262, -2.0, 520], -20, 1.1, MID, "512", "the reef's outer end, so the line of breakers reads as a reef and not a rock");
  item("reef-3", "coast_rocks_05", "rocks", [122, -0.4, 322], 0, 5.0, [2, 2, 2, 2, 1], "512", "a boulder at the reef's inner end: spray in a storm");
  item("mid-rocks", "coast_land_rocks_02", "rocks", [-262, -0.5, 450], -30, 3.4, NEAR, "512", "low rocks left of the ship: scale for it, foam in a swell");
  /* the near ground: under the window, mostly behind the cost strip; seen on tall and wide screens */
  /* [r2] 0.4 m lower: awash between the crags, so the swash runs over it */
  item("near-left", "coast_line_01", "platform", [-70, -1.35, 96], 210, 1.0, [2, 2, 2, 1, 1], "512", "the rock shelf under the window's left side, awash",
       { tilt: [-1, 1.5] });   // [r3] tipped and 0.35 m lower: awash between the crags, so the swash runs round them and not along its straight cut edge
  item("near-left-2", "coast_rocks_05", "rocks", [-44, -0.9, 66], 10, 2.8, [2, 2, 2, 1, 1], "512", "a boulder on the shelf", { stretch: [1, 1.45, 1], tilt: [-4, 5] });   // [r3] taller, a little tipped (more read as afloat)
  /* [r2] relief on the shelf: crags that break its level top (round 1's shelf read as a flat plank), their scanned
     faces turned to the window. [r3] They still read as planks (REVIEW-2 #10: long, low, level-topped slabs: a cliff
     scan scaled to 0.3-0.4 is a wall 17-28 m long and 3-4 m high). Now a cluster of crags as tall as they are wide,
     the scans stretched up (stretch: per-axis scale) and tilted like dipping strata (tilt: [lean, roll] deg; lean < 0
     tips the top away from the window, so the scanned face becomes a slope that takes the sky, roll lifts one end),
     their tops at 2-5 m, stepping and broken. */
  const toEye = (x, z) => R1((Math.atan2(-x, -z) * 180) / Math.PI);
  const crag = (name, id, pos, yaw, scale, stretch, tilt, tex, why) =>
    item(name, id, "rocks", pos, yaw, scale, [2, 2, 2, 1, 1], tex, why, { stretch, tilt });
  crag("near-crag-1", "coastal_cliff_02", [-82, -2.4, 116], toEye(-82, 116) + 12, 0.27, [0.75, 2.4, 1.3], [-14, 24], "512", "a crag at the shelf's seaward edge, a wedge whose top climbs to 5 m at its right end and runs into the water at its left");   // [r3 close] rolled 9 -> 24 deg, narrower: at golden its level top still read as a slab
  crag("near-crag-2", "mountainside", [-56, -2.6, 88], toEye(-56, 88) + 20, 0.5, [1.2, 1.6, 1.0], [-16, -34], "512", "a crag in front of the shelf, a wedge wide at the water with its peak 5 m up at its right end: it stands over a storm's run-up");   // [r4] rolled -28 -> -34, wider and taller, turned 6 deg: with near-crag-4 it read as a cube (REVIEW-3, F)
  crag("near-crag-2b", "coastal_cliff_04", [-47, -1.9, 94], toEye(-47, 94) - 40, 0.14, [0.8, 2.0, 1.2], [-24, 30], "1k", "a low broken rib beside it, awash in a storm");
  crag("near-crag-3", "coast_rocks_05", [-97, -0.9, 99], 70, 2.1, [1, 1.9, 1], [-6, 13], "512", "a tall boulder at the shelf's far end, tipped over");
  crag("near-crag-4", "coastal_cliff_02", [-68, -1.6, 106], toEye(-68, 106) - 25, 0.18, [0.7, 2.6, 1.5], [-18, -30], "512", "a dipping rib between the crags and the edge, its top climbing to the left: with near-crag-1 a broken ridge of tilted strata");   // [r4] was a mountainside block: its level top sat on near-crag-2 as one box
  crag("near-crag-5", "coast_rocks_05", [-36, -0.9, 104], 25, 1.7, [0.8, 2.3, 0.9], [-4, -16], "512", "a leaning pinnacle off the shelf's right end");
  crag("near-crag-6", "coastal_cliff_02", [-110, -1.4, 130], toEye(-110, 130) + 30, 0.17, [1, 2.3, 1.3], [-22, 10], "512", "a small upturned slab beyond the far boulder");
  item("near-right", "coast_line_02", "platform", [92, -0.5, 40], -60, 1.0, [2, 2, 2, 1, 1], "512", "the shelf the pier starts from");
  /* [r2] raised 0.4 m: below the water its pebbles took the shallow water's tint and read as a clump of leaves */
  item("near-sand", "sand_rocks_small_01", "rocks", [44, 0.1, 52], 0, 2.2, [2, 2, 2, 1, 1], "512", "stones at the pier's root");
  /* [critic] the pier: a chain of the kit's deck sections at their own 3.0 m pitch (posts at the section's start,
     deck to the next one's), from the near right out toward the reef. Section 01 (posts at both ends) starts it,
     02 and 03 follow shuffled by a hash, 04 (the head, turned to face out) ends it, and 05's gallows frame
     stands over the deck twice. The loose poles and the plank stack are never drawn. */
  const PIER = { root: [62, 30], head: [86, 194], pitch: 3.0, y: -0.4 };
  const pdx = PIER.head[0] - PIER.root[0], pdz = PIER.head[1] - PIER.root[1], plen = Math.hypot(pdx, pdz);
  const pyaw = (Math.atan2(pdx, pdz) * 180) / Math.PI, pn = Math.floor(plen / PIER.pitch) - 1;
  const pAt = (s) => [PIER.root[0] + (pdx / plen) * s, PIER.y, PIER.root[1] + (pdz / plen) * s];
  for (let k = 0; k <= pn; k++) {
    const part = k === 0 ? "section_01" : k === pn ? "section_04" : hashI(k, 7) < 0.5 ? "section_02" : "section_03";
    item("pier-" + k, "modular_wooden_pier", "pier", pAt(k * PIER.pitch), part === "section_04" ? pyaw + 180 : pyaw, 1,
      k < 22 ? NEAR : [2, 2, 2, 1, 1], "1k",
      k === pn ? "the pier head, just above the cost strip at 1280x820; its piles stand in the sun's path at golden hour" : "the pier, entering from the near right",
      { part: "modular_wooden_pier_" + part, pierK: k, center: true, flip: part === "section_04" });
  }
  /* section_04 is the head piece turned round: its deck ran back from its posts; turned, it runs on to the end */
  for (const k of [Math.round(pn * 0.38), Math.round(pn * 0.74)])
    item("pier-frame-" + k, "modular_wooden_pier", "pier", pAt(k * PIER.pitch), pyaw, 1, [2, 2, 2, 1, 1], "1k", "a gallows frame over the deck, twice along the pier",
      { part: "modular_wooden_pier_section_05", center: true });
  const headPos = pAt(pn * PIER.pitch + 2.35);
  item("lantern", "wooden_lantern_01", "lamp", [headPos[0] + 0.9, PIER.y + 2.62, headPos[2]], 0, 2.0, FAR, "512", "a lantern on the pier head, lit at night");
  /* the ship at anchor and the channel buoy */
  item("ship", "dutch_ship_large_01", "ship", [-112, 0, 402], 62, 1.0, HERO, "512", "an old ship at anchor left of centre, clear of the sun's usual path; it swings and rides, never sails",
       { probes: 0 });
  item("buoy", "lateral_sea_marker", "buoy", [32, 0, 288], 0, 1.0, FAR, "512", "a red can buoy marking the channel inside the reef", { probes: 4 });
  /* plants: trees on the tops (silhouettes that give the cliffs their scale) */
  const onTop = (hi, s, side, f) => {
    const pts = heads[hi], k = Math.min(pts.length - 2, Math.floor(s)), t = s - k, [x0, z0, , w0] = pts[k], [x1, z1, , w1] = pts[k + 1];
    const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz), w = w0 + (w1 - w0) * t;
    return [R1(x0 + dx * t + (side * dz / l) * w * f), R1(z0 + dz * t - (side * dx / l) * w * f)];
  };
  /* in clumps near the rim (13-50 m behind it), where a tree clears the edge seen from 14 m up */
  const trees = [];
  const clumps = [[0, 1.42, 3], [0, 1.68, 2], [0, 1.95, 4], [0, 2.3, 3], [0, 2.62, 2], [0, 2.9, 3], [1, 1.85, 3], [1, 2.2, 2], [1, 2.55, 3]];
  let tk = 0;
  for (const [hi, s0, n] of clumps) for (let k = 0; k < n; k++, tk++) trees.push([hi, s0 + (hashI(tk, 3) - 0.5) * 0.06, 0.7 + 0.12 * hashI(tk, 5)]);
  trees.forEach(([hi, s, f], k) => {
    const [x, z] = onTop(hi, s, hi === 0 ? 1 : -1, f);
    item("tree-" + k, "island_tree_01", "tree", [x, null, z], R1(hashI(k, 11) * 360), 1.7 + 0.8 * hashI(k, 13), FAR, "512",
      "a tree on the head's top: a skyline silhouette that gives the cliffs their scale");
  });
  /* [r2] no plants on the near rocks: every rock there stands in the water, and the shelf is under 1 m above it
     (round 1 put 32 tufts, ferns and shrubs on them) */
  /* items placed on the ground take its height (the snapped plants: SHORE's top, on the GPU) */
  for (const it of items) if (it.pos[1] === null) it.pos[1] = it.snap ? 0 : Math.round((height(it.pos[0], it.pos[2]) - 0.3) * 10) / 10;
  items.forEach((it, k) => { it.seed = hashI(k, 101); it.var = hashI(k, 103); });
  return { items, heads, height, shoreAt, DIM, AXIS, TINT, PIER, bounds: [-2200, -260, 2200, 2600], fbm, hashI,
           /* the terrain fan (DESIGN 13.2): rings from 22 m by x1.008 to 3.4 km, columns every 0.15 deg over +-82 deg
        ([scenery] the design's x1.0175 and 0.2 deg stepped the heads' skylines: 21 m rings at 1.2 km) */
           FAN: { r0: 22, ratio: 1.008, rings: Math.ceil(Math.log(3400 / 22) / Math.log(1.008)), a0: -82, step: 164 / 1093, cols: 1094 } };
})();

/* ── The coast library: the cove's shared data for the other passes (contract signatures) ───────────────── */
WX.lib("coast", `
/* the shore field lives in a warped 2D texture: texels shrink toward the eye like screen pixels.
   [r2] across z the fine part is centred 30 m ahead of the eye, where the near shelves are (round 1 centred it on the
   field's back edge 260 m behind the eye, so the near ledge had 3.5 m texels and the contact foam drew them as
   polygons; now 1.1 m), 1 km out the texels are as before */
vec2 cstShoreUV(vec2 xz) {
  return vec2(.5 + .5 * asinh(xz.x / 40.) / asinh(2200. / 40.), (asinh((xz.y - 30.) / 40.) + ${Math.asinh(290 / 40).toFixed(6)}) / ${(Math.asinh(2570 / 40) + Math.asinh(290 / 40)).toFixed(6)});
}
vec4 wxShore(vec2 xz) {
  vec2 uv = cstShoreUV(xz);
  if (uv.x <= 0. || uv.x >= 1. || uv.y <= 0. || uv.y >= 1. || uCoast.x <= 0.) return vec4(1e4, 60., 1., 0.);
  return texture(sShore, uv);
}
vec2 wxShoreNormal(vec2 xz) {
  float e = max(1., .004 * length(xz));
  vec2 g = vec2(wxShore(xz + vec2(e, 0.)).x - wxShore(xz - vec2(e, 0.)).x, wxShore(xz + vec2(0., e)).x - wxShore(xz - vec2(0., e)).x);
  return dot(g, g) > 1e-8 ? normalize(g) : vec2(0., 1.);
}
/* the key light's shadow from the cove, for a receiver that is not in the map (the sea): 4 bilinear compare
   taps on a rotated grid (16 texels), a fixed small bias. Receivers beyond the far plane compare at 1, so a
   head's shadow runs out over the sea as far as the map's box reaches */
float wxSunShadow(vec3 pM) {
  if (uShadow.x < .5 || uShadow.w <= 0.) return 1.;
  vec4 c = uShadowVP * vec4(pM, 1.);
  vec3 s = c.xyz / c.w * .5 + .5;
  if (any(lessThan(s.xy, vec2(0.))) || any(greaterThan(s.xy, vec2(1.)))) return 1.;
  vec2 t = 1. / vec2(textureSize(sSunShadow, 0)); float z = min(s.z, 1.) - .0004;
  float v = texture(sSunShadow, vec3(s.xy + vec2(-.8, -.3) * t, z)) + texture(sSunShadow, vec3(s.xy + vec2(.3, -.8) * t, z))
          + texture(sSunShadow, vec3(s.xy + vec2(.8, .3) * t, z)) + texture(sSunShadow, vec3(s.xy + vec2(-.3, .8) * t, z));
  return mix(1., v * .25, uShadow.w);
}
float wxSceneDist(vec2 uv) { float z = texture(sSceneZ, uv).r; return z > 0. ? z : 1e9; }
/* [r5] the waves tilt the reflected ray up and down by twice their slope along the view, and sideways by hardly
   more than that times the grazing angle: the lookup's footprint is the lod's size tall and a fraction of it wide
   (anisotropic filtering), so the cliffs' reflections streak down under a breeze and do not smear sideways past
   their feet (REVIEW-4 F1, x10 at 21:9). Without anisotropy it is the isotropic lookup of rounds 1-4 */
vec4 wxCoastRefl(vec2 uv, float lod) {
  vec2 ts = vec2(textureSize(sCoastRefl, 0));
  float v = exp2(max(lod, 0.)), k = clamp(.06 - wxRay0(uv).y, .125, 1.);
  return textureGrad(sCoastRefl, uv, vec2(v * k / ts.x, 0.), vec2(0., v / ts.y)) * uCoast.x;
}
`);

WX.pass((function () {
  const C = WX.COVE, D = Math.PI / 180, U = WX.util;
  /* lab knobs to take the slot apart when timing it (p.coastTerrain=0 ...); constants after the merge */
  WX.param("coastTerrain", 1, 0, 1, 1, "coast"); WX.param("coastMeshes", 1, 0, 1, 1, "coast");
  WX.param("coastMirror", 1, 0, 1, 1, "coast"); WX.param("coastReal", 1, 0, 1, 1, "coast");
  WX.param("coastDyn", 1, 0, 1, 1, "coast"); WX.param("coastShadow", 1, 0, 1, 1, "coast");
  WX.param("coastCache", 1, -1, 1, 1, "coast");         // the static-cove cache (G-buffer + relight): 1 always, -1 below T3 only, 0 never
  WX.param("coastWires", 1, 0, 1, 1, "coast");          // the rigging's coverage pass
  /*@lab*/ WX.param("coastWireDbg", 0, 0, 1, 1, "coast"); /*@end*/     // lab: 1 the strands black (their coverage alone)
  WX.param("coastLodBias", 0, -2, 2, 1, "coast");       // added to the table's LOD per instance
  WX.param("coastWireFrac", 0.6, 0.2, 1, 0.05, "coast");  // [r3] below T3, the share of the rigging's strands drawn (widest first; 0.6 saves Intel T2 ~0.03 ms)
  WX.param("coastMirrorEvery", 8, 4, 16, 4, "coast");     // [r3] below T3, the mirror is redrawn every this many world frames
  WX.param("coastDynDraw", 1, 0, 1, 1, "coast");        // lab: the moving pieces' forward draws (timing)
  WX.param("coastCheap", 0, 0, 1, 1, "coast");
  WX.param("coastTrees", 1, 0, 1, 1, "coast");          // lab: the trees (timing)
  WX.param("coastGLCheck", 0, 0, 1, 1, "coast");        // lab: gl.getError after each draw group, named in the console
  WX.param("coastRelightZ", 0, 0, 2, 1, "coast");       // lab: the relight's depth test 0 GREATER (the cove only), 1 NEVER, 2 ALWAYS          // lab: the relight outputs the cached albedo only (timing)
  WX.param("coastDebug", 0, 0, 7, 1, "coast");          // 1 albedo, 2 normal, 3 roughness, 4 AO x openness, 5 shadow, 6 wetness, [r3] 7 the wash (red) and wetness (green)
  /*@lab*/ WX.param("coastHalo", 1, 0, 2, 0.05, "coast"); /*@end*/     // [r5] lab: the lamps' near aureole x this (0 off)
  /*@lab*/ WX.param("coastCut", 0, 0, 255, 1, "coast"); WX.param("coastMirrorCut", 0, 0, 7, 1, "coast"); /*@end*/      // [r3] lab timing: skip parts of the shading (bits: 1 shadow taps, 2 cloud shadow, 4 sky specular, 8 AP, 16 wash and film) and of the mirror (1 relight, 2 moving pieces, 4 mips)

  /* ── constants ── */
  const NC = C.FAN.cols, NR = C.FAN.rings, B = C.bounds;
  const HGT = 1024, HGTW = 1536, OPEN = 256, SHN = 512;
  /* the shallow bed is drawn down to -2.2 m: at these grazing angles 2 m of water is a 10-25 m path and the bed
     below it shows less than a few per cent (DESIGN 13.2 said -4 m; the near bay is that shallow out to 95 m,
     so the whole foot of the screen ran the rock shader under the sea) */
  const BED = -2.2;
  const UNIT = { base: 18, nrm: 19, orm: 20, open: 21, hgt: 22, albA: 23, nrmA: 24, ormA: 25, g0: 26, g1: 27, gz: 28, shipZ: 29, raw: 30, aux: 31 };
  const ROCKY = /cliff|stack|platform|rocks|reef/;
  const MIRROR_LOW = /cliff|stack|ship|pier|buoy/;            // below T3 the mirror holds only the big silhouettes
  const DYN = /ship|buoy|plant|tree|lamp/;                    // drawn forward every frame; the rest is the static cove
  const I4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const yawM = (deg) => { const c = Math.cos(deg * D), s = Math.sin(deg * D); return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]); };
  const mul4 = (A, Bm) => { const M = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += A[k * 4 + r] * Bm[c * 4 + k]; M[c * 4 + r] = s; } return M; };
  const trans = (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
  /* materials: porosity (Lagarde's wet response), kind (0 rock, 1 wood, 2 paint, 3 cloth, 4 leaf, 5 glass/flame,
     6 rope), thin (translucency) */
  function matOf(id, name) {
    if (id === "dutch_ship_large_01") return name === "sails" ? { por: 0.7, kind: 3, thin: 0.85 } : name === "rigging" ? { por: 0.6, kind: 6, thin: 0 } : { por: 0.45, kind: 1, thin: 0 };
    if (id === "modular_wooden_pier") return { por: 0.8, kind: 1, thin: 0 };
    if (id === "lateral_sea_marker") return { por: 0.1, kind: 2, thin: 0 };
    if (id === "wooden_lantern_01") return name === "glass" ? { por: 0.05, kind: 5, thin: 0 } : { por: 0.5, kind: 1, thin: 0 };
    if (id === "island_tree_01") return name === "leaves" ? { por: 0.3, kind: 4, thin: 0.6 } : { por: 0.6, kind: 1, thin: 0 };
    if (/grass|fern|shrub/.test(id)) return { por: 0.3, kind: 4, thin: 0.6 };
    return { por: 0.9, kind: 0, thin: 0 };
  }

  /* ── GLSL shared by every coast program ── */
  const SHARED = `
    uniform int uMode;            // 0 the view, 1 a shadow map, 2 the mirror, 3 the cache (view), 4 the cache (mirror)
    uniform vec4 uBox;            // the heightfield's box: x0, z0, 1/(x1-x0), 1/(z1-z0)
    /* the sea's curvature at world xz (the contract's wxDrop, for the shaders without the mesh prelude) */
    float cstDrop(vec2 xz) { return dot(xz, xz) / (2. * R_G * 1000.); }
    float cstHashI(ivec2 c) {     // = WX.COVE's hashI
      uint h = uint(c.x) * 374761393u + uint(c.y) * 668265263u;
      h = (h ^ (h >> 13u)) * 1274126177u; h ^= h >> 16u;
      return float(h) * (1. / 4294967296.);
    }
    float cstVN(vec2 p) {
      vec2 i = floor(p), f = p - i, u = f * f * (3. - 2. * f); ivec2 c = ivec2(i);
      float a = cstHashI(c), b = cstHashI(c + ivec2(1, 0)), cc = cstHashI(c + ivec2(0, 1)), d = cstHashI(c + ivec2(1, 1));
      return a + (b - a) * u.x + (cc - a) * u.y + (a - b - cc + d) * u.x * u.y;
    }
    float cstFbm(vec2 p, int oct) { float s = 0., w = .5, f = 1.; for (int k = 0; k < 4; k++) { if (k >= oct) break; s += w * (cstVN(p * f) * 2. - 1.); w *= .5; f *= 2.03; } return s; }
    /* value noise periodic in y with period P cells (the rain streaks scroll by whole periods per 240 s) */
    float cstVNy(vec2 p, int P) {
      vec2 i = floor(p), f = p - i, u = f * f * (3. - 2. * f); ivec2 c = ivec2(i);
      int y0 = ((c.y % P) + P) % P, y1 = (y0 + 1) % P;
      float a = cstHashI(ivec2(c.x, y0)), b = cstHashI(ivec2(c.x + 1, y0)), cc = cstHashI(ivec2(c.x, y1)), d = cstHashI(ivec2(c.x + 1, y1));
      return a + (b - a) * u.x + (cc - a) * u.y + (a - b - cc + d) * u.x * u.y;
    }
    vec3 cstRotX(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c); }
    vec3 cstRotZ(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x * c - p.y * s, p.x * s + p.y * c, p.z); }
  `;
  /* the vertex side of every mesh program: the instance, the ship's and buoy's ride on SEAPROBE, the plants'
     sway, the plants snapped to the rock tops, the drop of the curved sea */
  const MESHVS = WX.glsl.meshVS + SHARED + `
    uniform mat4 uLightVP;
    uniform vec4 uMeshI;          // x the part's height m (sway), y snap to SHORE's top 0/1, z wire px scale, w wires 0/1
    uniform vec4 uShipM;          // [r2] the ship's own roll and pitch rad (x, y): its seaway motion and heel
    uniform vec4 uNodeC;          // xyz the part's own centre to subtract (a kit's part, centred), w 0
    out vec3 vP; out vec3 vN; out vec2 vUV; flat out vec4 vI; out float vA;
    /* [r3] an instance is a rotation times a scale per axis (the near crags are tilted and stretched), so its normal
       matrix is the inverse transpose: the cofactor rows, three cross products (det > 0, so no sign) */
    vec3 cstInstNormal(vec3 n) {
      vec3 r0 = aInst0.xyz, r1 = aInst1.xyz, r2 = aInst2.xyz;
      return normalize(vec3(dot(cross(r1, r2), n), dot(cross(r2, r0), n), dot(cross(r0, r1), n)));
    }
    void cstMove(inout vec3 lp, inout vec3 ln, out vec3 p, out vec3 n) {
#ifndef CST_DYN
      p = wxInstPos(lp); n = cstInstNormal(ln); p.y -= cstDrop(p.xz);
#else
      float heave = 0.;
      if (aInstP.y >= 2.) {        // the ship and the buoy ride the sea: 4 probes (bow, stern, port, starboard)
        int b = int(aInstP.y + .5) - 2;
        vec4 pb = wxSeaProbe(b), ps = wxSeaProbe(b + 1), pp = wxSeaProbe(b + 2), pt = wxSeaProbe(b + 3);
        bool ship = b == 0;
        float span = ship ? 26. : 2.4, beam = ship ? 7. : 2.4;
        heave = .25 * (pb.x + ps.x + pp.x + pt.x);
        /* the probes are in the instance's frame: bow along the mesh's +z after AXIS; pitch about local x */
        float pitch = atan((pb.x - ps.x) / span) * (ship ? 1. : 1.6), roll = atan((pt.x - pp.x) / beam) * (ship ? 1.2 : 1.6);
        if (ship) { roll += uShipM.x; pitch += uShipM.y; }
        lp = cstRotZ(cstRotX(lp, -pitch), roll); ln = cstRotZ(cstRotX(ln, -pitch), roll);
      }
      p = wxInstPos(lp) + vec3(0., heave, 0.);
      n = cstInstNormal(ln);
      if (aInstP.y > 0. && aInstP.y < 2.) {   // plants bend downwind, more in the gusts; a stationary sway
        float hgt = clamp(lp.y / max(uMeshI.x, .01), 0., 1.), w = hgt * hgt;
        /* periods that divide the rain clock's 240 s (15 s, 3.75 s, flutter 1.25 s), so the sway never jumps */
        float t = uTime.y, ph = aInstP.w * 6.2832;
        float base = .5 + .2 * sin(t * (2. * PI / 15.) + ph) + .3 * sin(t * (2. * PI / 3.75) + ph * 2.3);
        float flut = sin(t * (2. * PI / 1.25) + dot(lp, vec3(7.1, 3.3, 5.7)) + ph * 3.) * .12 * hgt;
        /* [r2] the drag grows as the wind's square: little in a breeze, a full lean and sway in a gale */
        float g = min(uWind.z * uWind.z / (22. * 22.), 1.6);
        float H = max(uMeshI.x * length(aInst0.xyz), .3);
        /* [r3] at the cap a tree's crown leans a fifth of its height downwind (about 12 deg: 2-2.5 m on the 9-12 m
           trees of the rim, which read at 1 km), pumping with the 3.75 s sway; a tuft's 0.3 m. The top dips so the
           stem keeps its length */
        vec2 off = uWind.xy * (base + flut) * g * w * (aInstP.y < .5 ? .2 * H : .3);
        p.xz += off; p.y -= .5 * dot(off, off) / H;
      }
      if (uMeshI.y > .5) p.y += -wxShore(vec2(aInst0.w, aInst2.w)).y;   // on the rock top below
      p.y -= cstDrop(p.xz);
#endif
    }
  `;
  /* ── the material side: BRDF, shadows, wetness, the light ── */
  const LIGHT = SHARED + `
    /*@lab*/ uniform float uCstCut;  /*@end*/  // [r3] lab timing: bits skip 1 the shadow taps, 2 the cloud shadow, 4 the sky's specular, 8 the air (AP), 16 the wash and film, [r3 close] 32 the rain's medium in front, 64 the rain streaks and runoff, 128 the puddles
#ifndef CST_DYN
    uniform sampler2D uOpen;      // openness: r at the surface, g 30 m above it, b the surface height (+50)/200
#endif
#ifdef CST_PCSS
    uniform sampler2D uShadowRaw; // the key light's depth without compare (PCSS)
#endif
    uniform vec4 uShadowK;        // x pcss 0/1, y depth range of the box m, z 1/texels, w debug view
    /* the light probe, made once a world frame (coast.probe): 0 the sun's illuminance at the cove, 1 the moon's,
       2..9 wxAmbient(up) for up = 0, 1/7 .. 1, 10 the clouds' mean shadow. The sky stream's functions are
       evaluated 16 times a frame instead of several times a pixel; over a few km and 0-110 m they do not vary */
    uniform sampler2D uProbe;
    vec3 cstSunE() { return texelFetch(uProbe, ivec2(0, 0), 0).rgb; }
    vec3 cstMoonE() { return texelFetch(uProbe, ivec2(1, 0), 0).rgb; }
    vec3 cstAmb(float up) {
      float f = clamp(up, 0., 1.) * 7.; int i = int(min(floor(f), 6.));
      return mix(texelFetch(uProbe, ivec2(2 + i, 0), 0).rgb, texelFetch(uProbe, ivec2(3 + i, 0), 0).rgb, f - float(i));
    }
    float cstCSMean() { return texelFetch(uProbe, ivec2(10, 0), 0).r; }
    uniform vec4 uShad;           // x skip m (the receiver moved toward the light: a moving piece ignores itself), y the ship's map 0/1
#ifdef CST_DYN
    uniform sampler2DShadow uShipZ; uniform mat4 uShipVP;
#endif
#ifndef CST_DYN
    float cstOpenAt(vec3 p) {
      vec2 uv = (p.xz - uBox.xy) * uBox.zw;
      if (any(lessThan(uv, vec2(0.))) || any(greaterThan(uv, vec2(1.)))) return 1.;
      vec3 o = texture(uOpen, uv).rgb;
      float hs = o.b * 200. - 50., y = p.y + cstDrop(p.xz);
      return mix(o.r, o.g, clamp((y - hs) / 30., 0., 1.)) + (1. - o.g) * clamp((y - hs - 30.) / 60., 0., 1.);
    }
#endif
    vec2 cstOct(vec3 n) {
      n /= abs(n.x) + abs(n.y) + abs(n.z);
      vec2 s = vec2(n.x >= 0. ? 1. : -1., n.y >= 0. ? 1. : -1.);
      return n.z >= 0. ? n.xy : (1. - abs(n.yx)) * s;
    }
    vec3 cstUnOct(vec2 e) {
      vec3 n = vec3(e, 1. - abs(e.x) - abs(e.y));
      float t = max(-n.z, 0.);
      n.x += n.x >= 0. ? -t : t; n.y += n.y >= 0. ? -t : t;
      return normalize(n);
    }
    float cstD(float NoH, float a2) { float d = NoH * NoH * (a2 - 1.) + 1.; return a2 / (PI * d * d); }
    float cstV(float NoV, float NoL, float a2) {
      float gv = NoL * sqrt(NoV * NoV * (1. - a2) + a2), gl = NoV * sqrt(NoL * NoL * (1. - a2) + a2);
      return .5 / max(gv + gl, 1e-5);
    }
    /* Karis' analytic fit of the split-sum DFG (no LUT): x scale, y bias of F0 */
    vec2 cstEnv(float NoV, float r) {
      const vec4 c0 = vec4(-1., -.0275, -.572, .022), c1 = vec4(1., .0425, 1.04, -.04);
      vec4 q = r * c0 + c1;
      float a = min(q.x * q.x, exp2(-9.28 * NoV)) * q.x + q.y;
      return vec2(-1.04, 1.04) * a + q.zw;
    }
    /* the cove's own shadow from the key light: normal offset (0.6 texel) and slope-scaled bias; 4 bilinear
       compare taps (T0-T2) or PCSS from the key light's angular radius (T3-T4) */
    float cstShadow(vec3 p, vec3 ng) {
      if (uShadow.x < .5 || uShadow.w <= 0.) return 1.;
      vec3 L = uKey.xyz;
      float NoL = dot(ng, L), tex = uShadow.y;
      vec3 q = p + ng * tex * (.9 + 1.1 * (1. - abs(NoL))) + L * uShad.x;
      vec4 c = uShadowVP * vec4(q, 1.);
      vec3 s = c.xyz / c.w * .5 + .5;
      if (any(lessThan(s.xy, vec2(0.))) || any(greaterThan(s.xy, vec2(1.)))) return 1.;
      float slope = clamp(sqrt(max(1. - NoL * NoL, 0.)) / max(abs(NoL), .08), 0., 6.);
      float z = min(s.z, 1.) - (.4 + .5 * slope) * tex / uShadowK.y;
      vec2 t = 1. / vec2(textureSize(sSunShadow, 0)); float v = 0.;
#ifdef CST_PCSS
      if (uShadowK.x > .5 && uShad.x <= 0.) {
        /* PCSS: blocker search over the light's footprint, then a penumbra from the angular radius */
        float avg = 0., nb = 0.;
        float sr = 6.;
        for (int k = 0; k < 8; k++) {
          float a = float(k) * 2.39996 + wxIGN(gl_FragCoord.xy) * 6.283, r = sqrt((float(k) + .5) / 8.) * sr;
          float d = texture(uShadowRaw, s.xy + vec2(cos(a), sin(a)) * r * t).r;
          if (d < z) { avg += d; nb += 1.; }
        }
        if (nb < .5) return 1.;
        float dz = (z - avg / nb) * uShadowK.y;                   // m from the blocker
        float pen = clamp(dz * tan(uShadow.z) * 2. / uShadow.y, .8, 12.);   // penumbra width, texels
        for (int k = 0; k < 12; k++) {
          float a = float(k) * 2.39996 + wxIGN(gl_FragCoord.xy + 17.) * 6.283, r = sqrt((float(k) + .5) / 12.) * pen * .5;
          v += texture(sSunShadow, vec3(s.xy + vec2(cos(a), sin(a)) * r * t, z));
        }
        v /= 12.;
      } else
#endif
      {
        v = .25 * (texture(sSunShadow, vec3(s.xy + vec2(-.8, -.3) * t, z)) + texture(sSunShadow, vec3(s.xy + vec2(.3, -.8) * t, z))
                 + texture(sSunShadow, vec3(s.xy + vec2(.8, .3) * t, z)) + texture(sSunShadow, vec3(s.xy + vec2(-.3, .8) * t, z)));
      }
#ifdef CST_DYN
      if (uShad.y > .5) {
        /* the ship's own map: its hull, rig and sails at 3-6 cm texels, drawn every world frame */
        vec4 c2 = uShipVP * vec4(p + ng * .06, 1.);
        vec3 s2 = c2.xyz / c2.w * .5 + .5;
        if (all(greaterThan(s2, vec3(0.))) && all(lessThan(s2, vec3(1.)))) {
          float t2 = 1. / float(textureSize(uShipZ, 0).x), z2 = s2.z - .0015;
          v *= .25 * (texture(uShipZ, vec3(s2.xy + vec2(-.7, -.3) * t2, z2)) + texture(uShipZ, vec3(s2.xy + vec2(.3, -.7) * t2, z2))
                    + texture(uShipZ, vec3(s2.xy + vec2(.7, .3) * t2, z2)) + texture(uShipZ, vec3(s2.xy + vec2(-.3, .7) * t2, z2)));
        }
      }
#endif
      /* near the terminator the light grazes the surface: its own relief (NoL) shades it, the map's stretched
         texels would only stair-step */
      return mix(1., v, uShadow.w * smoothstep(.03, .18, NoL));
    }
    /* the clouds and the rain's medium in front of the cove, from the cloud buffer, depth-aware: only the taps
       whose distance does not pass the cove's (land rays, traced by the sky stream to SCENEZ) */
    vec3 cstCloudsOver(vec3 L, vec2 uv, float distM) {
      /* the sky stream's wxCloudAt keeps only the buffer's surface-kind taps (CLOUDZ.g, 1 surface: its contract
         request 2); a buffer with no kind there and a depth past the cove (a sky ray, as the stub draws its
         deck) is not in front of it. (The depth alone flickered: A's surface depth is an exponential mean that
         converges over refreshes, so one texel in 16 passed: a dot grid over the cove) */
      if (uWx1.y <= 0.) return L;           // [r3] no rain, no medium in front (the contract lets a caller skip it)
      /*@lab*/ if ((int(uCstCut) & 32) != 0) return L; /*@end*/
      if (texture(sCloudZ, uv).g < .5 && wxCloudDepthAt(uv) * 1000. > distM * 1.03 + 40.) return L;
      vec4 c = wxCloudAt(uv);
      return L * c.a + c.rgb;
    }
    /* caustics on the bed under still water: two warped lattices, sharpened; their angular speeds are whole
       multiples of 2 pi / 1024 s, so they loop with the sea */
    float cstCaustic(vec2 xz, float t) {
      float w = 2. * PI / 1024.;
      vec2 q = xz * 1.3;
      float a = sin(q.x + 1.4 * sin(q.y * .83 + t * w * 37.) + t * w * 53.);
      float b = sin(q.y * 1.13 + 1.4 * sin(q.x * .71 - t * w * 41.) - t * w * 47.);
      float c = sin((q.x + q.y) * .77 + 1.2 * sin((q.x - q.y) * .61 + t * w * 29.) - t * w * 61.);
      float m = (a + b + c) / 3.;
      return .35 + 2.2 * pow(1. - abs(m), 7.);
    }
    /* rough: the material's roughness before wetness and before the specular AA; kern: the AA kernel (the
       screen-space variance of the normal), added after wetness has smoothed the surface */
    struct Surf { vec3 alb; float por; vec3 n; float rough; float kern; float ao; float metal; float thin; float open; vec3 em; float kind; };
    /* the cache's packing: g0 = albedo (sRGB), kernel / 0.18; g1 = octahedral normal, roughness, AO (6 bits) and
       the porosity class (2 bits: 0.45, 0.8 wood, 0.9 rock, 1.0 sand) */
    vec4 cstPackG1(vec3 n, float rough, float ao, float por) {
      float cls = por > .95 ? 3. : por > .85 ? 2. : por > .6 ? 1. : 0.;
      return vec4(cstOct(n) * .5 + .5, rough, (floor(clamp(ao, 0., 1.) * 63. + .5) * 4. + cls) / 255.);
    }
    void cstUnpackG(vec4 g0, vec4 g1, inout Surf s) {
      s.alb = g0.rgb; s.kern = g0.a * .18; s.n = cstUnOct(g1.xy * 2. - 1.); s.rough = g1.z;
      float v = floor(g1.w * 255. + .5), cls = mod(v, 4.);
      s.ao = floor(v / 4.) / 63.; s.por = cls > 2.5 ? 1. : cls > 1.5 ? .9 : cls > .5 ? .8 : .45;
      s.kind = cls > 1.5 ? 0. : 1.;
    }
    vec3 cstDirect(vec3 Ld, vec3 E, vec3 n, vec3 v, vec3 dif, vec3 F0, float a2, vec3 comp, float thin) {
      float NoL = dot(n, Ld), nl = max(NoL, 0.), NoV = max(dot(n, v), 1e-4);
      vec3 h = normalize(Ld + v);
      float NoH = max(dot(n, h), 0.), VoH = max(dot(v, h), 0.);
      vec3 F = F0 + (1. - F0) * pow(1. - VoH, 5.);
      vec3 r = (dif * (1. - F) / PI + cstD(NoH, a2) * cstV(NoV, nl, a2) * F * comp) * nl;
      if (thin > 0.) {          // a thin sheet lit from behind: diffuse transmission and a forward lobe toward the light
        /* sailcloth and leaves pass a good part of the light, most of it forward: a low sun 30 deg off the line
           of sight still lights a sail from behind */
        float back = max(-NoL, 0.), fw = pow(max(dot(-v, Ld), 0.), 4.);
        r += dif * thin * back * (.6 + 6. * fw) / PI;
      }
      return r * E;
    }
    /* the radiance of a cove surface, pre-exposed, with the air in front.
       p world m (dropped), rd the direction of the path's last leg (eye -> p, or the sea point -> p in the mirror),
       dist the path's length, tAir0 the part before the last leg (the mirror's eye -> sea), ng the geometric normal */
    vec3 cstShade(Surf s, vec3 p, vec3 rd, float dist, float tAir0, vec3 ng, bool mirror, vec2 uv) {
      vec3 v = -rd;
      float y = p.y + cstDrop(p.xz);
      int cut = 0; /*@lab*/ cut = int(uCstCut); /*@end*/
      if (!mirror && y < -.35 && uShadowK.w < .5) {
        /* under the water, seen only through it: diffuse light only (no gloss, puddles or shadow-map taps), the sun
           attenuated down to it with caustics, the coloured part of the view path's absorption, the air in front */
        vec3 sig = vec3(.75, .20, .10);
        float dw = -y, cosT = sqrt(max(1. - (1. - uKey.y * uKey.y) / 1.7689, .05)), NoL = max(dot(s.n, uKey.xyz), 0.);
        vec3 E = (dot(uKey.xyz, uSun.xyz) > .9999 ? cstSunE() : cstMoonE()) * wxCloudShadow(p);
        float ca = mix(1., cstCaustic(p.xz, uTime.x), smoothstep(.1, .8, dw) * (1. - smoothstep(2., 6., dw)) * (1. - uWx0.x * .7));
        vec3 alb = s.alb * mix(1., .55, s.por);                       // soaked, always
        vec3 L = alb * (E * NoL * exp(-sig * dw / cosT) * ca / PI + cstAmb(s.n.y * .5 + .5) * s.ao * exp(-sig * dw));
        L *= exp(-(sig - .35) * min(dw / max(-rd.y, .03), 8.));
        vec4 ap = wxAerial(rd, dist * 1e-3);
        return L * ap.a + ap.rgb;
      }
      /* wetness (Lagarde): soak darkens the porous and smooths every surface; the splash zone is always wet */
      float splash = (1. - smoothstep(.4, 2.5 + 2.5 * uWx2.w, y)) * step(-.3, y) * (s.kind < .5 ? 1. : .5);
      float wet = max(uWx4.x, splash * .85);
      vec3 alb = s.alb * mix(1., .45, wet * s.por);
      float rough = max(s.rough * mix(1., .45, wet), .045);
      vec3 n = s.n;
      float puddle = 0.;
      if (s.kind < .5 && y > .06 && uWx4.y > 0. && (cut & 128) == 0) {
        /* standing water on flat rock and ground under a 7 m mask that grows with the walker */
        float m = cstVN(p.xz / 7.) * .7 + cstVN(p.xz / 1.9 + 31.) * .3;
        float fl = smoothstep(.955, .99, ng.y) * smoothstep(.93, .98, n.y);
        puddle = smoothstep(1. - uWx4.y * .7, 1.05 - uWx4.y * .7, m) * fl;
        if (puddle > .01) {
          /* rain rings: one ring per cell, its period dividing the rain clock's 240 s */
          vec2 g = p.xz * 2.2, c = floor(g), fr = g - c;
          vec2 rn = vec2(0.);
          for (int k = 0; k < 4; k++) {
            vec2 cc = c + vec2(float(k & 1), float(k >> 1)) - .5;
            vec2 ctr = cc + .5 + (wxHash22(cc) - .5) * .7;
            float per = 240. / (160. + floor(wxHash12(cc + 7.) * 80.)), ph = fract(uTime.y / per + wxHash12(cc + 3.));
            float r = length(g - ctr), wv = ph * 1.4;
            float ring = sin((r - wv) * 28.) * exp(-pow((r - wv) * 6., 2.)) * (1. - ph) * (1. - ph);
            rn += (g - ctr) / max(r, 1e-3) * ring * uWx1.y;
          }
          n = normalize(mix(n, normalize(vec3(-rn.x * .35, 1., -rn.y * .35)), puddle));
          rough = mix(rough, .03, puddle);
          alb *= mix(1., .55, puddle);
        }
      }
      if (uWx4.x > .5 && uWx1.y > .55 && abs(ng.y) < .6 && s.kind < .5 && (cut & 64) == 0) {
        /* streaks down the steep faces in heavy rain: vertical noise scrolled 16 tiles (of 16 cells) per 240 s */
        vec2 sq = vec2(dot(p.xz, vec2(.71, .71)) * 2.3, p.y * .35 + uTime.y * (16. * 16. / 240.));
        float st = smoothstep(.55, .8, cstVNy(sq, 16)) * smoothstep(.5, .9, uWx4.x) * smoothstep(.55, .9, uWx1.y);
        alb *= 1. - .35 * st; rough = mix(rough, .08, st);
      }
      float runK = smoothstep(.45, .85, uWx1.y) * smoothstep(.5, .9, uWx4.x);
      if (runK > 0. && s.kind < .5 && abs(ng.y) < .75 && abs(p.x) > 300. && y > .2 && (cut & 64) == 0) {
        /* [r2] runoff on the heads in heavy rain: the gully creases (the heightfield's 46 m gully noise, as cstGully)
           carry it down the faces as white cascades 1-3 m wide, in about half of them, with the rock round them
           darker and glossier; the falling water is a noise scrolled down 48 whole tiles (of 16 cells, 40 m) per
           240 s, about 8 m/s, so it loops with the rain clock. A function of the walkers and the clocks only. */
        float u = (p.z + .35 * p.x) / 46., cr = abs(2. * cstVN(vec2(u, p.x / 160. + 5.3)) - 1.);
        float run = smoothstep(.42, .62, cstVN(vec2(u * .7 + 3.7, 11.3))) * runK;
        float band = smoothstep(.25, .04, cr) * run, core = smoothstep(.065, .02, cr) * run;
        alb *= 1. - .25 * band; rough = mix(rough, .22, band);
        vec2 q = vec2(u * 57.5, y / 2.5 + uTime.y * (48. * 16. / 240.));
        float fall = core * (.5 + .5 * smoothstep(.3, .8, cstVNy(q, 16)));
        alb = mix(alb, vec3(.72, .74, .76), fall); rough = mix(rough, .4, fall);
        wet = max(wet, band);
      }
      float washF = 0.;
#ifndef CST_DYN
      if (uSwell.w > .6 && s.kind < .5 && y > -.3 && y < 8. && abs(p.x) < 175. && p.z < 215. && (cut & 16) == 0) {
        /* [r3] white water running off the near rocks after each crest (the storm look through the pane): the sea's
           height at their feet now and its decaying maximum (the probe's texels 16..23, weighted by distance), the
           run-up reaching a little higher than the crest. Between the water now and that line the rock carries a
           sheet of foam streaming down its faces, falling with the hold as the water drains; the streaks scroll down
           16 whole tiles per 240 s, so they loop with the rain clock */
        float hold = 0., now = 0., ws = 0., dmin = 1e4;
        for (int j = 0; j < 8; j++) {
          vec4 q = texelFetch(uProbe, ivec2(16 + j, 0), 0);
          if (q.b == 0. && q.a == 0.) continue;
          vec2 dd = p.xz - q.ba; float d2 = dot(dd, dd), w = 1. / (d2 + 36.);
          hold += q.r * w; now += q.g * w; ws += w; dmin = min(dmin, d2);
        }
        if (ws > 0. && dmin < 3600.) {
          hold /= ws; now /= ws;
          /* [r8] the run-up follows the sets: by how high the crest that just struck stood at the rock's foot (the hold)
             against the swell, from a lull's short wash (x .3) to a set's (x 1.6); round 7 ran every crest up alike. At 96 %
             the crests at the eight rock probes run .35-.75 m (p10) to .6-2.4 m (p90) as the sets pass (probes.cjs) */
          float Hs = uSwell.w, reach = .35 * Hs * (.5 + .5 * uWx2.w) * clamp(hold / max(.25 * Hs, .2), .3, 1.6);
          float top = hold + reach, sheet = smoothstep(top, top - .35, y) * smoothstep(now - .1, now + .2, y);
          vec2 sq = vec2(dot(p.xz, vec2(.71, -.71)) * 1.9 + n.x * 2., y * 1.1 + uTime.y * (16. * 16. / 240.));
          float st = smoothstep(.3, .75, cstVNy(sq, 16)), fresh = smoothstep(0., .8, hold - now);
          float foam = sheet * mix(.35, 1., st) * smoothstep(.6, 2., Hs) * (.55 + .45 * fresh) * smoothstep(3600., 900., dmin);
          /* the rock the run-up reached is soaked (darker, glossier) whatever the rain */
          float wetted = smoothstep(top + .8, top, y) * step(-.3, y) * smoothstep(3600., 900., dmin), more = max(wetted - wet, 0.);
          alb *= mix(1., .5, more * s.por); rough *= mix(1., .5, more); wet = max(wet, wetted);
          alb = mix(alb, vec3(.74, .76, .78), foam); rough = mix(rough, .3, foam); washF = foam;
        }
      }
#endif
      vec3 F0 = mix(vec3(.04), alb, s.metal), dif = alb * (1. - s.metal);
      if (puddle > .01) F0 = mix(F0, vec3(.02), puddle);
      /* the AA kernel after wetness: a smoothed surface still cannot sparkle finer than its pixels */
      float a2 = clamp(pow(rough, 4.) + s.kern * (1. - .7 * puddle), 4e-6, 1.);
      rough = sqrt(sqrt(a2));
      float NoV = max(dot(n, v), 1e-4);
      vec2 env = cstEnv(NoV, rough);
      vec3 comp = 1. + F0 * (1. / max(env.x + env.y, .05) - 1.);
      /* the key light through the clouds and the cove's shadows; the other light through the mean cloud */
      bool sunKey = dot(uKey.xyz, uSun.xyz) > .9999;
      float cs = (cut & 2) == 0 ? wxCloudShadow(p) : 1., sh = (cut & 1) == 0 ? cstShadow(p, ng) : 1., cm = cstCSMean();
      vec3 Es = cstSunE() * (sunKey ? cs * sh : cm), Em = cstMoonE() * (sunKey ? cm : cs * sh);
      vec3 Ld = cstDirect(uSun.xyz, Es, n, v, dif, F0, a2, comp, s.thin);
      if (uMoon.y > -.05 && uSun.y < .1) Ld += cstDirect(uMoon.xyz, Em, n, v, dif, F0, a2, comp, s.thin);
      /* the sky: diffuse from the ambient x AO x openness; specular from the rendered sky (smooth) or the ambient */
      float vis = s.open, ao = s.ao;
      vec3 La = dif * cstAmb(n.y * .5 + .5) * ao * vis;
      if (s.thin > 0.) La += dif * s.thin * .5 * cstAmb(.5 - .5 * n.y) * vis;
      vec3 R = reflect(rd, n);
      float so = clamp(pow(NoV + ao, exp2(-16. * rough - 1.)) - 1. + ao, 0., 1.);
      vec3 envL = cstAmb(R.y * .5 + .5);
      if (rough < .3 && (cut & 4) == 0) {
        vec2 ruv = wxUV(mirror ? vec3(R.x, -R.y, R.z) : R);
        vec3 sky = wxSky(normalize(vec3(R.x, max(R.y, .01), R.z)));
#ifdef CST_REFL
        if (R.y > 0. && all(greaterThan(ruv, vec2(.002))) && all(lessThan(ruv, vec2(.998))) && !mirror) sky = textureLod(sRefl, ruv, rough * 14.).rgb;
#endif
        envL = mix(sky, envL, smoothstep(.05, .3, rough));
      }
      La += envL * (F0 * env.x + env.y) * comp * so * vis;
      /* [r3] a film of water on wet rock and wood (soaked by rain or by the run-up): a smooth second interface over the
         rough surface, Fresnel-weighted, mirroring the sky. It is strongest at the grazing angles the window sees the
         near rocks at, so wet rock takes the sky's sheen in a storm instead of only going darker */
      /* (within 350 m: the near rocks, the pier, the reef; on the heads' grassed tops at grazing angles a film would
         turn them white, and past that the rain's medium takes the sheen anyway) */
      float film = smoothstep(.45, .9, wet) * smoothstep(.1, .55, ng.y) * step(s.kind, 1.5) * (1. - puddle) * smoothstep(350., 250., dist);
      if (film > .01 && (cut & 16) == 0) {
        vec3 nf = normalize(mix(n, ng, .6));
        float Ff = .02 + .98 * pow(1. - max(dot(nf, v), 1e-3), 5.);
        vec3 Rf = reflect(rd, nf);
        vec3 Lf = cstAmb(clamp(Rf.y * .5 + .5, 0., 1.)) * (Rf.y > 0. ? 1. : .4);
        La = La * (1. - Ff * film) + Lf * Ff * film * vis;
        Ld *= 1. - Ff * film;
      }
      vec3 Lo = vec3(0.);
      /* lightning: [1.2] the contract's one falloff (wxFlash: the lit patch of cloud the sky draws round the channel,
         exposure-normalised), the same light the sea and the sky get from the same strike (never the restriking B) */
      for (int k = 0; k < 2; k++) {
        vec4 f = wxFlash(k, p);
        if (f.w > 0.) Lo += cstDirect(f.xyz, WX_FLASH_RGB * f.w, n, v, dif, F0, a2, comp, s.thin);
      }
      /* the pier lantern lights the deck within 6 m (uF1: xyz m, w pre-exposed intensity) */
      if (uF1.w > 0.) {
        vec3 lv = uF1.xyz - p; float d2 = dot(lv, lv);
        if (d2 < 49.) Lo += cstDirect(lv * inversesqrt(d2), vec3(1., .46, .15) * uF1.w * (1. - smoothstep(9., 49., d2)) / max(d2, .3), n, v, dif, F0, a2, comp, s.thin);
      }
      vec3 L;
      if (!mirror && y < 0.) {
        /* seen through still water: the sun attenuated down to it with caustics, the sky to its depth, and the
           coloured part of the view path's absorption (the ocean applies the grey mean, 0.35 per m) */
        vec3 sig = vec3(.75, .20, .10);
        float dw = -y, cosT = sqrt(max(1. - (1. - uKey.y * uKey.y) / 1.7689, .05));
        vec3 Ts = exp(-sig * dw / cosT) * mix(1., cstCaustic(p.xz, uTime.x), smoothstep(.1, .8, dw) * (1. - smoothstep(2., 6., dw)) * (1. - uWx0.x * .7));
        L = Ld * Ts + (La * exp(-sig * dw) + Lo);
        /* (the path is held to 8 m: past it the ocean's grey part has taken the light anyway, and the ratio, which
           exceeds 1 in blue, must not amplify the waves' departure from still water) */
        L *= exp(-(sig - .35) * min(dw / max(-rd.y, .03), 8.));
      } else L = Ld + La + Lo;
      L += s.em;
      /*@lab*/
      if (uShadowK.w > .5) {     // lab debug views
        int dv = int(uShadowK.w + .5);
        L = (dv == 1 ? alb : dv == 2 ? n * .5 + .5 : dv == 3 ? vec3(rough) : dv == 4 ? vec3(ao * vis) : dv == 5 ? vec3(sh) : dv == 7 ? vec3(washF, wet * .3, 0.) : vec3(wet, puddle, 0.)) * .25 * uExpo.x;
        return L;
      }
      /*@end*/
      /* the air in front: AP along the last leg; the direct view also gets the clouds and the rain's medium */
      vec4 ap = (cut & 8) == 0 ? wxAerial(rd, max(dist - tAir0, 0.) * 1e-3) : vec4(0., 0., 0., 1.);
      L = L * ap.a + ap.rgb;
      if (!mirror) L = cstCloudsOver(L, uv, dist);
      return L;
    }
    /* the Tokuyoshi-Kaplanyan specular AA: the kernel that widens alpha^2 by the screen-space variance of the normal */
    float cstKern(vec3 n) {
      vec3 du = dFdx(n), dv = dFdy(n);
      return min(2. * .25 * (dot(du, du) + dot(dv, dv)), .18);
    }
    /* the path of a fragment: the eye's ray, or in the mirror the leg from the sea up to the cove */
    void cstPath(vec3 p, bool mirror, out vec3 rd, out float dist, out float t0) {
      vec3 e = vec3(0., wxEye, 0.);
      if (mirror) {
        vec3 pm = vec3(p.x, -p.y, p.z), d = normalize(pm - e);
        dist = length(pm - e); t0 = wxEye / max(-d.y, 1e-4); t0 = min(t0, dist);
        rd = vec3(d.x, -d.y, d.z);
      } else { rd = normalize(p - e); dist = length(p - e); t0 = 0.; }
    }
  `;
  /* the photoscans, the pier, the ship, the buoy, the plants, the lantern */
  const MESHFS = LIGHT + `
    uniform sampler2D uBase, uNrm, uOrm;
    uniform vec4 uMatK;           // x alpha cutoff (0 opaque), y alphaScale, z porosity, w kind
    uniform vec4 uTint;           // rgb base colour tint, w the normal and ORM maps' weight (their 0.5 s fade-in)
    uniform vec4 uFade;           // x LOD cross-fade 0..1, y 0 fading in / 1 fading out, z thin, w has maps
    uniform vec4 uEmis;           // rgb emissive (pre-exposed), w metal 0/1 (the lantern's fittings keep the ORM's metal)
    in vec3 vP; in vec3 vN; in vec2 vUV; flat in vec4 vI; in float vA;
    layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1;
    void main() {
      bool mirror = uMode == 2 || uMode == 4;
      if (mirror && vP.y + cstDrop(vP.xz) < -.05) discard;              // the mirror holds what stands above the water
      float dz = wxIGN(gl_FragCoord.xy);
      if (dz > uCoast.x) discard;                                       // the cove rises, dithered (stable per pixel)
      if (uFade.y < .5 ? dz >= uFade.x : dz < uFade.x) discard;        // an LOD cross-fade
      if (vI.z < 1. && dz >= vI.z) discard;                             // the instance's own fade (aInstP.z)
      vec4 bc = texture(uBase, vUV);
      if (uMatK.x > 0.) {
        /* cut-outs keep their coverage through the mips (the workflow's alphaScale, and the mip in use) */
        vec2 tsz = vec2(textureSize(uBase, 0));
        vec2 dd = max(abs(dFdx(vUV * tsz)), abs(dFdy(vUV * tsz)));
        float a = bc.a * uMatK.y * (1. + max(0., log2(max(dd.x, dd.y))) * .25);
        if (a < uMatK.x) discard;
      }
      if (uMode == 1) { o0 = vec4(0.); return; }
      vec3 N = normalize(vN);
      if (!gl_FrontFacing) N = -N;                                      // a two-sided sheet seen from behind
      /* the normal map in a derivative cotangent frame, its green negated (OpenGL +y maps, glTF v down) */
      vec3 n = N;
      float ao = 1., rough = .8, metal = 0.;
      if (uFade.w > .5) {
        vec3 dp1 = dFdx(vP), dp2 = dFdy(vP); vec2 du1 = dFdx(vUV), du2 = dFdy(vUV);
        vec3 p2 = cross(dp2, N), p1 = cross(N, dp1);
        vec3 T = p2 * du1.x + p1 * du2.x, Bt = p2 * du1.y + p1 * du2.y;
        float im = inversesqrt(max(max(dot(T, T), dot(Bt, Bt)), 1e-30));
        vec3 tn; tn.xy = texture(uNrm, vUV).xy * 2. - 1.; tn.z = sqrt(max(1e-4, 1. - dot(tn.xy, tn.xy)));
        tn.y = -tn.y;
        vec3 nm = normalize(mat3(T * im, Bt * im, N) * tn);
        n = normalize(mix(N, nm, uTint.w));
        vec4 orm = texture(uOrm, vUV);
        ao = mix(1., orm.r, uTint.w); rough = mix(.8, orm.g, uTint.w);
        metal = uEmis.w > .5 ? orm.b * uTint.w : 0.;
      }
      Surf s;
      s.alb = bc.rgb * uTint.rgb; s.por = uMatK.z; s.n = n; s.rough = max(rough, .045); s.kern = cstKern(n); s.ao = ao; s.metal = metal;
      s.thin = uFade.z; s.kind = uMatK.w; s.em = uEmis.rgb;
      if (uMode >= 3) {           // the static-cove cache
        o0 = vec4(s.alb, s.kern / .18);
#ifndef CST_DYN
        /* [r3] the sky's openness is static too: baked into the cached AO, so the relight does not look it up every
           frame (Intel's coast slot) */
        o1 = cstPackG1(n, s.rough, ao * cstOpenAt(vP), s.por);
#else
        o1 = cstPackG1(n, s.rough, ao, s.por);
#endif
        return;
      }
#ifdef CST_DYN
      s.open = vI.x;
#else
      s.open = cstOpenAt(vP);
#endif
      vec3 rd; float dist, t0;
      cstPath(vP, mirror, rd, dist, t0);
      vec2 uv = gl_FragCoord.xy * uRes.zw;
      vec3 L = cstShade(s, vP, rd, dist, t0, N, mirror, uv);
      o0 = vec4(wxGuard(L), 1.);
      o1 = vec4(dist, 0., 0., 1.);
    }
  `;
  const MESHVSMAIN = MESHVS + `
    void main() {
      vec3 lp = wxNodePos(aPos) - uNodeC.xyz, ln = wxNodeNormal(aNormal), p, n;
      cstMove(lp, ln, p, n);
      vA = 1.;
      vP = p; vN = n; vUV = aUV; vI = aInstP;
      if (uMode == 1) { gl_Position = uLightVP * vec4(p, 1.); return; }
      gl_Position = uViewProj * vec4(p.x, (uMode == 2 || uMode == 4) ? -p.y : p.y, p.z, 1.);
    }
  `;
  /* [r2] the thin wires as COVERAGE TRIANGLES: every triangle of the rigging material (ropes, ratline ladders, masts,
     yards, blocks) and of the anchor cable is drawn as a screen-aligned quad round its projection, 1 px larger each
     way. Each fragment gets the area of its pixel (a box) that the triangle covers, from its three signed edge
     distances: clamp(sum of min(.5, d) - .5, 0, 1), which is exact across a sliver (a rope 0.1 px wide adds 0.1 of
     its colour to each pixel it crosses, whatever its sub-pixel position) and 1 inside a wide triangle. So the
     rigging fades with distance instead of breaking into dots, and cannot crawl as the ship rides. A closed tube
     counts its front and back (up to twice its width); a sliver seen edge-on covers nothing, as it should.
     The quad is built on the screen and emitted with w = 1, so the varyings interpolate linearly on it (GLSL ES 3.00
     has no noperspective); its depth and world position run along its long axis between its end corners. */
  const STRANDVS = MESHVS + `
    layout(location = 8) in vec3 aTA;     // the triangle's corners in the mesh's units
    layout(location = 9) in vec3 aTB;
    layout(location = 10) in vec3 aTC;
    layout(location = 11) in vec2 aTUV;   // the uv of its centroid
    uniform vec4 uRow[4];                 // the moving piece's instance row (WX.MESH's aInst0..2, aInstP), one for all its strands
    uniform vec4 uStrand;                 // xy the target's size px, z lab: black strands, w the pass (0 blended, 1 over the
                                          // sea, 2 the mirror's spars blended)
    uniform sampler2D uProbe, uBase;      // the light probe (as LIGHT's), the rigging's base colour
    out vec3 vD;                          // the signed distances (px) to its three edges, inside positive
    flat out vec3 vC;                     // its radiance, pre-exposed, with the air and the rain's medium in front: lit once,
                                          // by the provoking (last) corner
    float cstEdge(vec2 p, vec2 a, vec2 b) { vec2 e = b - a; float l = length(e); return l > 1e-5 ? (e.x * (p.y - a.y) - e.y * (p.x - a.x)) / l : 1e3; }
    vec3 cstPr(int i) { return texelFetch(uProbe, ivec2(i, 0), 0).rgb; }
    /* [r2] a strand's light, once a strand: it covers a pixel or less, so its colour cannot vary across it (round 1
       ran the cove's whole surface shading in every covered fragment: shadow maps, wetness, the sky). A round strand
       lit as its middle, the normal facing the viewer across its axis T; the sun and the moon through the clouds'
       shadow, the sky's ambient, lightning (wxFlashE), then the air and the rain's medium, which the light probe
       evaluates once a frame for the ship (all its strands are about as far). */
    vec3 cstStrandLight(vec3 p, vec3 T, bool mirror) {
      vec3 e = vec3(0., wxEye, 0.), pm = mirror ? vec3(p.x, -p.y, p.z) : p, d0 = normalize(pm - e);
      vec3 rd = mirror ? vec3(d0.x, -d0.y, d0.z) : d0;
      vec3 N = -rd - T * dot(-rd, T);
      N = dot(N, N) > 1e-8 ? normalize(N) : -rd;
      vec3 alb = texture(uBase, aTUV).rgb * .9 * mix(1., .55, uWx4.x);
      bool sunKey = dot(uKey.xyz, uSun.xyz) > .9999;
      float cs = cstPr(14).r, cm = texelFetch(uProbe, ivec2(10, 0), 0).r;
      vec3 E = cstPr(0) * (sunKey ? cs : cm) * max(dot(N, uSun.xyz), 0.);
      if (uMoon.y > -.05 && uSun.y < .1) E += cstPr(1) * (sunKey ? cm : cs) * max(dot(N, uMoon.xyz), 0.);
      E += wxFlashE(p, N);
      float up = clamp(N.y * .5 + .5, 0., 1.) * 7.; int k = int(min(floor(up), 6.));
      vec3 L = alb * (E / PI + mix(cstPr(2 + k), cstPr(3 + k), up - float(k)) * uRow[3].x);
      /* the air and the rain's medium on the way to the ship, from the probe (every strand is about as far) */
      L = L * cstPr(11) + cstPr(12);
      if (!mirror) { vec4 m = texelFetch(uProbe, ivec2(13, 0), 0); L = L * m.a + m.rgb; }
      return wxGuard(L);
    }
    void main() {
      vN = vec3(0., 1., 0.); vA = 1.; vUV = aTUV; vI = uRow[3]; vC = vec3(0.);
      vec3 A = wxNodePos(aTA), B = wxNodePos(aTB), Cc = wxNodePos(aTC);
      vec3 f0 = B - A, f1 = Cc - B, f2 = A - Cc;
      float m0 = dot(f0, f0), m1 = dot(f1, f1), m2 = dot(f2, f2);
      bool pass1 = uStrand.w > .5 && uStrand.w < 1.5;
      /* the ship's ride (cstMove's), read once for the three corners */
      float heave = 0., pitch = 0., roll = 0.;
      if (uRow[3].y >= 2.) {
        int b = int(uRow[3].y + .5) - 2;
        vec4 pb = wxSeaProbe(b), ps = wxSeaProbe(b + 1), pp = wxSeaProbe(b + 2), pt = wxSeaProbe(b + 3);
        heave = .25 * (pb.x + ps.x + pp.x + pt.x);
        pitch = atan((pb.x - ps.x) / 26.) + uShipM.y; roll = atan((pt.x - pp.x) / 7.) * 1.2 + uShipM.x;
      }
      float cp = cos(-pitch), sp = sin(-pitch), cr = cos(roll), sr = sin(roll);
      vec3 P[3], lp;
      for (int k = 0; k < 3; k++) {
        lp = (k == 0 ? A : k == 1 ? B : Cc) - uNodeC.xyz;
        lp = vec3(lp.x, lp.y * cp - lp.z * sp, lp.y * sp + lp.z * cp);          // cstRotX
        lp = vec3(lp.x * cr - lp.y * sr, lp.x * sr + lp.y * cr, lp.z);          // cstRotZ
        vec4 q = vec4(lp, 1.);
        P[k] = vec3(dot(uRow[0], q), dot(uRow[1], q), dot(uRow[2], q)) + vec3(0., heave, 0.);
        P[k].y -= cstDrop(P[k].xz);
      }
      vec3 g0 = P[1] - P[0], g1 = P[2] - P[1], g2 = P[0] - P[2];
      vec3 T = normalize((m0 >= m1 && m0 >= m2 ? g0 : m1 >= m2 ? g1 : g2) + vec3(0., 1e-7, 0.));
      bool mir = uMode == 2;
      vec4 c[3]; vec2 s[3];
      vec2 res = uStrand.xy;
      for (int k = 0; k < 3; k++) {
        c[k] = uViewProj * vec4(P[k].x, mir ? -P[k].y : P[k].y, P[k].z, 1.);
        s[k] = (c[k].xy / max(c[k].w, 1e-3) * .5 + .5) * res;
      }
      vP = P[0];
      if (min(c[0].w, min(c[1].w, c[2].w)) < 1.) { gl_Position = vec4(0., 0., -2., 1.); vD = vec3(-1.); return; }
      if (pass1) {
        /* over the sea (the spars only: the loader puts them first, the coast draws that many): the triangle
           rasterised as it is, opaque */
        int k = gl_VertexID;
        vD = vec3(1.); vP = P[k];
        if (k == 2) vC = cstStrandLight(P[k], T, false);
        gl_Position = c[k];
        return;
      }
      /* the rectangle round the three corners along the longest edge, a pixel larger each way, covered by one right
         triangle twice its size (one light a strand, three corners instead of a strip's four) */
      vec2 e0 = s[1] - s[0], e1 = s[2] - s[1], e2 = s[0] - s[2];
      float l0 = dot(e0, e0), l1 = dot(e1, e1), l2 = dot(e2, e2);
      vec2 ax = l0 >= l1 && l0 >= l2 ? e0 : l1 >= l2 ? e1 : e2;
      vec2 u = dot(ax, ax) > 1e-8 ? normalize(ax) : vec2(1., 0.), v = vec2(-u.y, u.x);
      vec3 pu = vec3(dot(s[0], u), dot(s[1], u), dot(s[2], u)), pv = vec3(dot(s[0], v), dot(s[1], v), dot(s[2], v));
      float u0 = min(pu.x, min(pu.y, pu.z)) - 1., u1 = max(pu.x, max(pu.y, pu.z)) + 1.;
      float v0 = min(pv.x, min(pv.y, pv.z)) - 1., v1 = max(pv.x, max(pv.y, pv.z)) + 1.;
      float cu = gl_VertexID == 1 ? 2. * u1 - u0 : u0, cv = gl_VertexID == 2 ? 2. * v1 - v0 : v0;
      vec2 q = u * cu + v * cv;
      float sg = (e0.x * (s[2].y - s[0].y) - e0.y * (s[2].x - s[0].x)) >= 0. ? 1. : -1.;
      vD = vec3(cstEdge(q, s[0], s[1]), cstEdge(q, s[1], s[2]), cstEdge(q, s[2], s[0])) * sg;
      /* depth and world position along the long axis, between the corners at either end */
      int ia = pu.x <= pu.y && pu.x <= pu.z ? 0 : pu.y <= pu.z ? 1 : 2, ib = pu.x >= pu.y && pu.x >= pu.z ? 0 : pu.y >= pu.z ? 1 : 2;
      /* (unclamped, so it stays linear across the covering triangle) */
      float t = (cu - pu[ia]) / max(pu[ib] - pu[ia], 1e-4);
      vP = mix(P[ia], P[ib], t);
      if (gl_VertexID == 2) vC = cstStrandLight(mix(P[ia], P[ib], .5), T, mir);
      gl_Position = vec4(q / res * 2. - 1., mix(c[ia].z / c[ia].w, c[ib].z / c[ib].w, t), 1.);
    }
  `;
  const STRANDFS = SHARED + `
    uniform vec4 uStrand;
    in vec3 vD; flat in vec3 vC;
    in vec3 vP; in vec2 vUV; flat in vec4 vI;
    layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1;
    void main() {
      bool mirror = uMode == 2;
      if (mirror && vP.y + cstDrop(vP.xz) < -.05) discard;
      if (wxIGN(gl_FragCoord.xy) > uCoast.x) discard;
      /* the share of the pixel's box the triangle covers */
      float a = clamp(min(.5, vD.x) + min(.5, vD.y) + min(.5, vD.z) - .5, 0., 1.);
      if (a < .002) discard;
      /* two passes (uStrand.w): 0 blended, no depth write, where the sky is behind the pixel (the sea is drawn after
         the cove and replaces what lies under it); 1 over the sea, the spars only, opaque, writing depth and SCENEZ so
         the sea keeps out. Ropes over the sea are left to the sea: drawn after them, it cannot be blended under them.
         (Round 1 wrote depth from every fragment of every widened strand, against an estimate of the sea: below the
         horizon that kept the sea out of the whole footprint and painted the pale estimate there; above it each
         quad hid the ropes behind it, beads.) */
      bool overSea = !mirror && wxRay(gl_FragCoord.xy * uRes.zw).y < -.0021;
      if (uStrand.w > .5 && uStrand.w < 1.5 ? !overSea : overSea) discard;
      vec3 L = vC;
      /*@lab*/ if (uStrand.z > .5) L = vec3(0.); /*@end*/
      float dist = length((mirror ? vec3(vP.x, -vP.y, vP.z) : vP) - vec3(0., wxEye, 0.));
      if (overSea) { o0 = vec4(L, 1.); o1 = vec4(dist, 0., 0., 1.); }
      else { o0 = vec4(L * a, a); o1 = vec4(0.); }
    }
  `;
  /* ── the terrain: the polar fan, its heights from the heightfield texture in the vertex shader ── */
  const TERVS = SHARED + `
    uniform sampler2D uHgt;
    uniform vec4 uFan;            // x columns, y first ring m, z ln(ring ratio), w column step rad
    uniform float uFanA0;         // first column's azimuth rad
    uniform int uVBase;           // the chunk's first vertex (the fan is drawn in chunks of 16-bit indices)
    uniform mat4 uLightVP;
    out vec3 vP; out vec3 vN; out float vCav;
    float hAt(vec2 xz) { return texture(uHgt, (xz - uBox.xy) * uBox.zw).r; }
    void main() {
      int id = gl_VertexID + uVBase, nc = int(uFan.x), i = id / nc, j = id - i * nc;
      float r = uFan.y * exp(uFan.z * float(i)), az = uFanA0 + uFan.w * float(j);
      vec2 xz = vec2(sin(az), cos(az)) * r;
      float h = hAt(xz), e = max(3., r * .004);
      float hx0 = hAt(xz - vec2(e, 0.)), hx1 = hAt(xz + vec2(e, 0.)), hz0 = hAt(xz - vec2(0., e)), hz1 = hAt(xz + vec2(0., e));
      vec3 n = normalize(vec3(hx0 - hx1, 2. * e, hz0 - hz1));
      /* the cavity: the Laplacian over 9 m, so gullies darken and buttresses catch the light */
      float c = 9.;
      vCav = (hAt(xz + vec2(c, 0.)) + hAt(xz - vec2(c, 0.)) + hAt(xz + vec2(0., c)) + hAt(xz - vec2(0., c)) - 4. * h) / (c * c);
      vec3 p = vec3(xz.x, h - cstDrop(xz), xz.y);
      vP = p; vN = n;
      if (uMode == 1) { gl_Position = uLightVP * vec4(p, 1.); return; }
      gl_Position = uViewProj * vec4(p.x, (uMode == 2 || uMode == 4) ? -p.y : p.y, p.z, 1.);
    }
  `;
  const TERFS = LIGHT + `
    uniform mediump sampler2DArray uAlbA, uNrmA, uOrmA;   // layers: 0 rock, 1 cliff-top grass, 2 sand and pebbles, 3 wet rock
    uniform vec4 uTile;           // tile m per layer
    uniform vec4 uTerT;           // x maps weight (fade-in), yzw unused
    uniform vec3 uRockTint, uWetTint;
    in vec3 vP; in vec3 vN; in float vCav;
    layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1;
    /* one layer, planar on xz */
    void lay(float L, float tile, vec3 p, out vec3 al, out vec3 tn, out vec3 oh) {
      vec3 uvw = vec3(p.xz / tile, L);
      al = texture(uAlbA, uvw).rgb; vec2 nx = texture(uNrmA, uvw).xy * 2. - 1.; oh = texture(uOrmA, uvw).rgb;
      tn = vec3(nx.x, -nx.y, sqrt(max(1e-4, 1. - dot(nx, nx))));
    }
    /* one layer, triplanar (weights |n|^4) with whiteout-blended normals */
    void tri(float L, float tile, vec3 p, vec3 n, out vec3 al, out vec3 nw, out vec3 oh) {
      vec3 w = pow(abs(n), vec3(4.)); w /= w.x + w.y + w.z;
      vec3 a = vec3(0.), o = vec3(0.), nn = vec3(0.);
      if (w.x > .02) { vec3 u = vec3(p.zy / tile, L); a += texture(uAlbA, u).rgb * w.x; o += texture(uOrmA, u).rgb * w.x;
        vec2 t = texture(uNrmA, u).xy * 2. - 1.; t.y = -t.y; vec3 tn = vec3(t + n.zy, abs(sqrt(max(1e-4, 1. - dot(t, t)))) * n.x); nn += tn.zyx * w.x; }
      if (w.y > .02) { vec3 u = vec3(p.xz / tile, L); a += texture(uAlbA, u).rgb * w.y; o += texture(uOrmA, u).rgb * w.y;
        vec2 t = texture(uNrmA, u).xy * 2. - 1.; t.y = -t.y; vec3 tn = vec3(t + n.xz, abs(sqrt(max(1e-4, 1. - dot(t, t)))) * n.y); nn += tn.xzy * w.y; }
      if (w.z > .02) { vec3 u = vec3(p.xy / tile, L); a += texture(uAlbA, u).rgb * w.z; o += texture(uOrmA, u).rgb * w.z;
        vec2 t = texture(uNrmA, u).xy * 2. - 1.; t.y = -t.y; vec3 tn = vec3(t + n.xy, abs(sqrt(max(1e-4, 1. - dot(t, t)))) * n.z); nn += tn.xyz * w.z; }
      float ws = (w.x > .02 ? w.x : 0.) + (w.y > .02 ? w.y : 0.) + (w.z > .02 ? w.z : 0.);
      al = a / ws; oh = o / ws; nw = normalize(nn);
    }
    void main() {
      bool mirror = uMode == 2 || uMode == 4;
      float y = vP.y + cstDrop(vP.xz);
      if (mirror && y < -.05) discard;
      if (wxIGN(gl_FragCoord.xy) > uCoast.x) discard;
      if (uMode == 1) { o0 = vec4(0.); return; }
      vec3 N = normalize(vN), p = vec3(vP.x, y, vP.z);
      /* weights by slope and height, a little noise, then the height maps decide the edges */
      float nz = cstVN(p.xz / 31.) * .6 + cstVN(p.xz / 9.) * .4;
      float steep = smoothstep(.86, .72, N.y);
      float wGrass = (1. - steep) * smoothstep(3., 7., y) * smoothstep(.15, .45, nz + .25);
      float wSand = (1. - steep) * smoothstep(3.5, 1.2, y) * smoothstep(-6., -.5, y);
      float wWet = smoothstep(3.2 + nz, .8, y) * smoothstep(-2.5, -.3, y) * mix(.3, 1., steep);
      float wRock = max(steep, 1. - wGrass - wSand) * (1. - wWet * .8);
      vec3 aR, nR, oR, aG, nG, oG, aS, nS, oS, aW, nW, oW;
      vec3 Nf = N;
      if (wRock > .01 && steep > .05) tri(0., uTile.x, p, N, aR, nR, oR); else { vec3 t; lay(0., uTile.x, p, aR, t, oR); nR = normalize(vec3(t.x + N.x, t.z * N.y, t.y + N.z)); }
      /* [r2] the layer is grey stone with yellow-green moss: half way to its own grey, then tinted to the scans' mean
         rock (a tint from the means alone turned the stone blue-purple and left the moss bright: lit, the moss on
         the buttresses read as white vertical smears) */
      aR = mix(vec3(dot(aR, vec3(.2126, .7152, .0722))), aR, .5) * uRockTint;
      if (steep > .05) {
        /* the rock at a second, finer scale (11 m): its relief and its light and dark, over the 50 m one */
        vec3 a2, n2, o2; tri(0., uTile.x * .23, p * vec3(1., 1.13, 1.) + 17., N, a2, n2, o2);
        float l2 = dot(a2 * uRockTint, vec3(.3, .55, .15)), l1 = dot(aR, vec3(.3, .55, .15));
        aR *= mix(1., clamp(l2 / max(l1, 1e-3), .55, 1.6), .5 * steep);
        nR = normalize(mix(nR, normalize(nR + n2 - N), .6 * steep));
        oR.r *= mix(1., clamp(o2.r * 1.3, .5, 1.2), .4 * steep);
        /* strata: lighter and darker beds every few metres, warped a little; stains run down from the ledges */
        float bed = cstVN(vec2(y / 6.5 + .35 * cstVN(p.xz / 70.), 3.1)), bed2 = cstVN(vec2(y / 2.2 + 9., dot(p.xz, vec2(.01, .013))));
        aR *= mix(1., (.78 + .42 * bed) * (.9 + .2 * bed2), steep);
        /* [r2] and their hue: some beds warmer (iron-stained sandstone), some cooler (shale), as the cliffs of a
           sandstone cove band (round 1 varied only their brightness, and the faces read as one grey-brown) */
        float hb = cstVN(vec2(y / 4.3 + 21. + .3 * cstVN(p.xz / 55.), dot(p.xz, vec2(.006, .009))));
        aR *= mix(vec3(1.), mix(vec3(.93, .98, 1.05), vec3(1.1, 1., .84), smoothstep(.25, .75, hb)), .8 * steep);
        float stain = cstVN(vec2(dot(p.xz, vec2(.7071, .7071)) / 3.5, y / 40.)), wetl = smoothstep(.55, .85, stain) * steep;
        aR *= mix(1., .72, wetl * (.5 + .5 * smoothstep(20., 60., y)));
      }
      if (wGrass > .01) { vec3 t; lay(1., uTile.y, p, aG, t, oG); nG = normalize(vec3(t.x + N.x, t.z * N.y, t.y + N.z)); } else { aG = aR; nG = nR; oG = oR; }
      if (wSand > .01) { vec3 t; lay(2., uTile.z, p, aS, t, oS); nS = normalize(vec3(t.x + N.x, t.z * N.y, t.y + N.z)); } else { aS = aR; nS = nR; oS = oR; }
      if (wWet > .01) { tri(3., uTile.w, p, N, aW, nW, oW); aW *= uWetTint; } else { aW = aR; nW = nR; oW = oR; }
      /* height blending: a layer wins where its own height map stands above the others' */
      vec4 w = vec4(wRock, wGrass, wSand, wWet), hgt = vec4(oR.b, oG.b, oS.b, oW.b);
      vec4 hb = w + hgt * .6 * step(.01, w);
      float mx = max(max(hb.x, hb.y), max(hb.z, hb.w));
      vec4 wf = max(hb - mx + .12, 0.) * step(.01, w); wf /= max(dot(wf, vec4(1.)), 1e-4);
      vec3 alb = aR * wf.x + aG * wf.y + aS * wf.z + aW * wf.w;
      vec3 n = normalize(nR * wf.x + nG * wf.y + nS * wf.z + nW * wf.w);
      vec2 ormv = oR.rg * wf.x + oG.rg * wf.y + oS.rg * wf.z + oW.rg * wf.w;
      n = normalize(mix(N, n, uTerT.x));
      float ao = mix(1., ormv.r, uTerT.x) * clamp(1. + vCav * 5., .45, 1.08), rough = max(mix(.85, ormv.g, uTerT.x), .05);
      if (flipN(mirror)) {}
      Surf s;
      s.alb = alb; s.por = wf.z > .5 ? 1. : .9; s.n = n; s.rough = rough; s.kern = cstKern(n); s.ao = ao; s.metal = 0.; s.thin = 0.; s.kind = 0.; s.em = vec3(0.);
      if (uMode >= 3) { o0 = vec4(s.alb, s.kern / .18); o1 = cstPackG1(n, rough, ao * cstOpenAt(vP), s.por); return; }   // [r3] openness baked
      s.open = cstOpenAt(vP);
      vec3 rd; float dist, t0;
      cstPath(vP, mirror, rd, dist, t0);
      vec3 L = cstShade(s, vP, rd, dist, t0, N, mirror, gl_FragCoord.xy * uRes.zw);
      o0 = vec4(wxGuard(L), 1.);
      o1 = vec4(dist, 0., 0., 1.);
    }
  `.replace("if (flipN(mirror)) {}", "");
  /* ── the cache's relighting pass: one full-screen pass over the cached cove. Its triangle stands at depth
     0.99999 and is drawn with GREATER against the restored depth, so early-z drops every pixel the cove does
     not cover (the sky and the sea, ~80 % of the screen) before the shader runs ── */
  const RELIGHTVS = `
    layout(location = 0) in vec2 aPos;
    out vec2 vUV;
    void main() { vUV = aPos * .5 + .5; gl_Position = vec4(aPos, .99999, 1.); }
  `;
  const RELIGHTFS = LIGHT + `
    uniform sampler2D uG0, uG1, uGZ;
    uniform vec4 uProj;           // x near, y far, zw [1.2] the TAA jitter (S px) the cache was drawn with
    in vec2 vUV;
    layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1;
    void main() {
      bool mirror = uMode == 4;
      ivec2 px = ivec2(gl_FragCoord.xy);
      float d = texelFetch(uGZ, px, 0).r;          // (no discard: the depth test has kept only the cove's pixels)
      vec4 g0 = texelFetch(uG0, px, 0), g1 = texelFetch(uG1, px, 0);
      /*@lab*/ if (uShad.z > .5) { o0 = vec4(g0.rgb * uExpo.x * .1, 1.); o1 = vec4(1.); return; } /*@end*/
      /* the cached point: the ray through this pixel to the depth (mirror: the mirrored ray, then back) */
      vec2 uv = gl_FragCoord.xy * (mirror ? vec2(1.) / vec2(textureSize(uGZ, 0)) : uRes.zw);
      vec3 ray = wxRay0(uv - uProj.zw * uRes.zw);   // through the pixel as the cache saw it (its frame's jitter)
      float zn = d * 2. - 1., n_ = uProj.x, f_ = uProj.y;
      float zv = 2. * n_ * f_ / (f_ + n_ - zn * (f_ - n_));
      vec3 pm = vec3(0., wxEye, 0.) + ray * (zv / dot(ray, uCamZ.xyz));
      vec3 p = mirror ? vec3(pm.x, -pm.y, pm.z) : pm;
      Surf s;
      cstUnpackG(g0, g1, s);
      s.metal = 0.; s.thin = 0.; s.em = vec3(0.);
      s.open = 1.;                                  // [r3] baked into the cached AO
      vec3 rd; float dist, t0;
      cstPath(p, mirror, rd, dist, t0);
      /* the geometric normal from the cached depth (the shadow's offsets want it, not the bumpy shading normal) */
      vec3 gn = cross(dFdx(p), dFdy(p));
      gn = dot(gn, gn) > 1e-12 ? normalize(gn) : s.n;
      if (dot(gn, rd) > 0.) gn = -gn;
      if (dot(gn, s.n) < .2) gn = s.n;
      vec3 L = cstShade(s, p, rd, dist, t0, gn, mirror, uv);
      o0 = vec4(wxGuard(L), 1.);
      o1 = vec4(dist, 0., 0., 1.);
    }
  `;
  /* the night lights as points ([r2] the anchor light at the forestay, the stern lantern on the taffrail and two
     stern windows, riding with the ship; [r3] and the pier lantern's glow, fixed). [r3] A light 0.3 m across at
     400 m is under a pixel, so each is drawn as its flux on the image, not as a disc: a sub-pixel Gaussian core
     (energy-normalised, so it does not crawl as the ship swings and the TAA jitter moves it) dimmed by the air and
     the rain in front of it, plus the near aureole damp air scatters it into (exp(-r/lambda), lambda a tenth of a
     degree in clear air to a quarter in rain), its peak under a soft ceiling, cut off smoothly a few px out. Added
     (ONE, ONE) to SCENE only; the bright core writes depth, so the sea (drawn after, replacing what lies under it)
     cannot erase it; the dim tail does not (where it falls over the sea it is the sea's: depth there punched a
     disc of sky into the sea). The wide glare of a bright light at night is post's (after the sea).
     Never drawn into the mirror: a 1-2 texel light in COASTREFL becomes a hard block in its coarse mips (the
     round-2 rectangles); the sea lays their streaks itself from R.coast.lamps (B's lamp glint). */
  const LAMPVS = MESHVS + `
    uniform vec4 uLampP;          // xyz the light in the ship's mesh frame (before AXIS), w the sprite's side px
    uniform vec4 uLampW;          // [r3] xyz a fixed light in world m (the pier lantern) when w = 1
    void main() {
      vec3 p, n = vec3(0., 1., 0.);
      if (uLampW.w > .5) { p = uLampW.xyz; p.y -= cstDrop(p.xz); }
      else { vec3 lp = (uNode * vec4(uLampP.xyz, 1.)).xyz, ln = n; cstMove(lp, ln, p, n); }
      vP = p; vN = n; vUV = vec2(0.); vI = aInstP; vA = 1.;
      gl_Position = uViewProj * vec4(p, 1.);
      gl_PointSize = uLampP.w;
    }
  `;
  const LAMPFS = SHARED + `
    uniform vec4 uLampC;          // rgb the light's pre-exposed flux on the image (radiance x px^2), a on 0/1
    uniform vec4 uLampK;          // x the core's sigma px, y the aureole's lambda px, z its share in clear air, w core weight
    uniform vec4 uLampP;          // w the sprite's side px
    uniform vec4 uLampM;          // [r3] x the light's distance over the ship's (the rain's medium scales with it), y the aureole's ceiling, z the draw
    uniform sampler2D uProbe;     // 11 the air's transmittance to the ship, 13 the rain's medium in front of it
    in vec3 vP; in vec3 vN; in vec2 vUV; flat in vec4 vI; in float vA;
    layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1;
    void main() {
      if (uLampC.a <= 0.) discard;
      vec2 q = (gl_PointCoord - .5) * uLampP.w;          // px from the light's centre (sub-pixel exact)
      float r2 = dot(q, q), s = uLampK.x, l = uLampK.y;
      vec3 e = vec3(0., wxEye, 0.);
      float dist = length(vP - e);
      float Ta = wxAerial((vP - e) / dist, dist * 1e-3).a;
      float Tm = pow(max(texelFetch(uProbe, ivec2(13, 0), 0).a, 1e-4), uLampM.x);
      float T = Ta * Tm;
      /* the core integrates to 1 over the image plane. The aureole's peak is the scattered share's, held under
         a soft ceiling (uLampM.y, pre-exposed): at a night exposure a physical halo of a light 1e4 times the
         scene would read as a white ball several px wide, where the eye and a camera see a point in a soft
         glow; at blue hour the light is dim against the scene and the halo stays physical. */
      float Rs = .5 * uLampP.w - 1., r = sqrt(r2);
      float core = exp(-.5 * r2 / (s * s)) / (6.2832 * s * s);
      float share = uLampK.z + .5 * (1. - T), G = uLampM.y;
      vec3 h = uLampC.rgb * (share * max(T, .15) / (6.2832 * l * l));
      h = G * (1. - exp(-h / G));
      vec3 L = (uLampC.rgb * (core * T * uLampK.w) + h * exp(-r / l) * (1. - smoothstep(.7 * Rs, Rs, r))) * uCoast.x;
      /* two draws: z 0 the core's disc (r < 2.2 sigma), writing depth, so the sea drawn after cannot erase it (the
         lamps stand 3 m below eye level, over the far sea); z 1 the tail, no depth (over the sea it is the sea's).
         By the core's radius, not its brightness: at blue hour a lamp is dim against the scene and a brightness
         test erased it */
      float m = max(L.r, max(L.g, L.b));
      if (m < 3e-3 || (uLampM.z < .5) != (r < max(1.25, 2.2 * s))) discard;
      o0 = vec4(wxGuard(L), 0.); o1 = vec4(0.);
    }
  `;
  /* the light probe: the sky stream's light at the cove, 16 texels a world frame */
  const PROBEFS = `
    uniform vec4 uShipC;          // [r2] the ship's middle, 15 m up (world m), w 1 when it is there
    uniform vec4 uWashP[8];       // [r3] the near rocks' feet facing the swell: x, z m, w 1 used (SEAPROBE 8 + j)
    uniform vec4 uWashK;          // [r3] x the drain this frame m (rate x dt), y 1 to restart the holds
    uniform sampler2D uProbe;     // [r3] last frame's probe (its texels 16..23)
    out vec4 o;
    void main() {
      int i = int(gl_FragCoord.x);
      if (i >= 16) {
        /* [r3] the water on the near rocks' feet: the sea's height there now (SEAPROBE, the ocean's own surface:
           swell, bores and wind sea) and its decaying maximum, hold = max(now, last hold - drain). The white water
           a crest leaves on the rock runs off as the hold falls. It decays to a steady state that follows the
           sea's 1024 s loop: no accumulation */
        if (i >= 24) { o = vec4(0.); return; }                          // [r8] texels 24..31: past uWashP[8] (read out of bounds before)
        vec4 q = uWashP[i - 16];
        if (q.w < .5) { o = vec4(0.); return; }
        vec4 sp = wxSeaProbe(8 + i - 16);
        float now = sp.w > .5 ? sp.x : 0., last = texelFetch(uProbe, ivec2(i, 0), 0).r;
        float hold = uWashK.y > .5 ? now : max(now, last - uWashK.x);
        /* [r8] not through wxGuard: it clamps to 0..6e4 (a colour's guard), so a probe left of the view's centre (x < 0:
           every near rock) was read back at x = 0, and the sea under its mean at 0; the wash weighed each rock by the
           distance to x = 0, and the rocks 60 m or more left of it got none (round 3-7). Only NaN and inf are caught */
        vec3 hn = vec3(hold, now, q.x);
        o = any(isnan(hn)) || any(isinf(hn)) ? vec4(0.) : vec4(hn, q.y);
        return;
      }
      vec3 pk = wxPlanet(vec3(0., 30., 900.)), c = vec3(0.);
      float a = 1.;
      if (i == 0) c = wxSunLight(pk);
      else if (i == 1) c = wxMoonLight(pk);
      else if (i < 10) c = wxAmbient(float(i - 2) / 7.);
      else if (i == 10) c = vec3(wxCloudShadowMean());
      else if (i < 15 && uShipC.w > 0.) {
        /* [r2] for the ship's rigging, whose every strand is about this far: 11 the air's transmittance and 12 its
           in-scatter on the ray to it, 13 the rain's medium in front of it (wxCloudAt where the buffer holds its
           land rays, rgb and a), 14 the clouds' shadow on it */
        vec3 e = vec3(0., wxEye, 0.), d = normalize(uShipC.xyz - e);
        float dist = length(uShipC.xyz - e);
        vec4 ap = wxAerial(d, dist * 1e-3);
        vec2 suv = wxUV0(d);
        if (i == 11) c = vec3(ap.a);
        else if (i == 12) c = ap.rgb;
        else if (i == 13) {
          vec4 m = vec4(0., 0., 0., 1.);
          if (all(greaterThan(suv, vec2(0.))) && all(lessThan(suv, vec2(1.))) && !(texture(sCloudZ, suv).g < .5 && wxCloudDepthAt(suv) * 1000. > dist * 1.03 + 40.)) m = wxCloudAt(suv);
          c = m.rgb; a = m.a;
        } else c = vec3(wxCloudShadow(uShipC.xyz));
      } else if (i == 11 || i == 13) c = vec3(1.);
      o = vec4(wxGuard(c), a);
    }
  `;
  /* ── the bakes ── */
  const HGTFS = SHARED + `
    uniform vec4 uRidge[13];      // x, z, top m, half-width m: the left head (5), the right head (5), the land behind (3)
    in vec2 vUV; out vec4 o;
    float cstSmooth(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
    float cstSmax(float a, float b, float k) { float h = max(k - abs(a - b), 0.) / k; return max(a, b) + h * h * k * .25; }
    float cstGully(float x, float z) {
      float u = (z + .35 * x) / 46., u2 = (z + .35 * x) / 17.;
      float r1 = pow(abs(2. * cstVN(vec2(u, x / 160. + 5.3)) - 1.), .6), r2 = pow(abs(2. * cstVN(vec2(u2, x / 90. + 9.1)) - 1.), .6);
      return 1. + .06 * (r1 - .55) + .022 * (r2 - .55);
    }
    float cstBench(float h) { float t = h / 9., f = t - floor(t); return 9. * (floor(t) + cstSmooth(.25, .75, f)); }
    float cstHeight(vec2 xz) {   // = WX.COVE.height
      float x = xz.x, z = xz.y;
      float h = max(-(2. + .021 * max(z, 0.) + .004 * abs(x)), -46.);
      float wob = (1. + .14 * cstFbm(vec2(x / 140., z / 140.), 3)) * cstGully(x, z), tf = .88 + .12 * cstFbm(vec2(x / 60. + 7., z / 60.), 3), d3 = 3. * cstFbm(vec2(x / 23., z / 23.), 2);
      for (int hd = 0; hd < 3; hd++) {
        int o0 = hd == 0 ? 0 : hd == 1 ? 5 : 10, n = hd == 2 ? 3 : 5;
        float bd = 1e9, bH = 0., bw = 1.;
        for (int k = 0; k < 4; k++) {
          if (k >= n - 1) break;
          vec4 a = uRidge[o0 + k], b = uRidge[o0 + k + 1];
          vec2 dd = b.xy - a.xy;
          float t = clamp(dot(xz - a.xy, dd) / dot(dd, dd), 0., 1.);
          float d = length(xz - (a.xy + dd * t)), w = a.w + (b.w - a.w) * t;
          if (d / w < bd / bw) { bd = d; bH = a.z + (b.z - a.z) * t; bw = w; }
        }
        float q = bd / (bw * wob), land;
        if (q < 1.) {
          float top = bH * (1. - cstSmooth(.86, 1., q)) * tf, band = cstSmooth(.8, .88, q) * (1. - cstSmooth(.97, 1., q));
          land = top + (cstBench(top) - top) * .45 * band + d3;
        } else land = d3 - (bd - bw * wob) * .3;
        h = cstSmax(h, land, 6.);
      }
      return h;
    }
    void main() { vec2 xz = uBox.xy + (gl_FragCoord.xy / vec2(textureSize0())) / uBox.zw; o = vec4(cstHeight(xz), 0., 0., 1.); }
  `;
  const OPENFS = SHARED + `
    uniform sampler2D uHgt; uniform vec4 uTileR;   // the tile of the target this frame: x0, y0, w, h in texels
    in vec2 vUV; out vec4 o;
    float hAt(vec2 xz) { return texture(uHgt, (xz - uBox.xy) * uBox.zw).r; }
    void main() {
      vec2 xz = uBox.xy + vUV / uBox.zw;
      float h0 = max(hAt(xz), 0.), y1 = h0 + 1.5, y2 = h0 + 30.;
      float v1 = 0., v2 = 0.;
      for (int k = 0; k < 16; k++) {
        float a = (float(k) + .5) * (2. * PI / 16.);
        vec2 dir = vec2(cos(a), sin(a));
        float m1 = 0., m2 = 0., s = 5.;
        for (int i = 0; i < 28; i++) { float hh = hAt(xz + dir * s); m1 = max(m1, (hh - y1) / s); m2 = max(m2, (hh - y2) / s); s *= 1.22; }
        v1 += 1. / (1. + m1 * m1); v2 += 1. / (1. + m2 * m2);
      }
      o = vec4(v1 / 16., v2 / 16., clamp((h0 + 50.) / 200., 0., 1.), 1.);
    }
  `;
  /* the fan's quads: the highest of each one's four corners, read back once to split the index buffer */
  const FANCLSFS = SHARED + `
    uniform sampler2D uHgt; uniform vec4 uFan; uniform float uFanA0;
    out vec4 o;
    float hAt(vec2 xz) { return texture(uHgt, (xz - uBox.xy) * uBox.zw).r; }
    vec2 vtx(int i, int j) { float r = uFan.y * exp(uFan.z * float(i)), az = uFanA0 + uFan.w * float(j); return vec2(sin(az), cos(az)) * r; }
    void main() {
      int j = int(gl_FragCoord.x), i = int(gl_FragCoord.y);
      float h = max(max(hAt(vtx(i, j)), hAt(vtx(i, j + 1))), max(hAt(vtx(i + 1, j)), hAt(vtx(i + 1, j + 1))));
      o = vec4(h, 0., 0., 1.);
    }
  `;
  /* the shore field in its warped space (wxShore's): world xz of a texel, and back */
  const WZ0 = Math.asinh(290 / 40), WZR = Math.asinh(2570 / 40) + WZ0;   // = the coast library's cstShoreUV
  const WARP = `
    vec2 cstWorldOf(vec2 uv) { return vec2(40. * sinh((uv.x * 2. - 1.) * asinh(2200. / 40.)), 30. + 40. * sinh(uv.y * ${WZR.toFixed(6)} - ${WZ0.toFixed(6)})); }
    vec2 cstWarpOf(vec2 xz) { return vec2(.5 + .5 * asinh(xz.x / 40.) / asinh(2200. / 40.), (asinh((xz.y - 30.) / 40.) + ${WZ0.toFixed(6)}) / ${WZR.toFixed(6)}); }
  `;
  /* step 1: the top height (the heightfield, then the rock meshes drawn top-down over it, the highest winning) */
  const SHTOP0FS = SHARED + WARP + `
    uniform sampler2D uHgt;
    in vec2 vUV; out vec4 o;
    void main() {
      vec2 xz = cstWorldOf(vUV);
      float h = texture(uHgt, (xz - uBox.xy) * uBox.zw).r;
      float rk = h > -3. && abs(xz.x) > 150. ? .8 : 0.;
      o = vec4(h, rk, 0., 1.);
      gl_FragDepth = clamp(.5 - h / 400., 0., 1.);
    }
  `;
  const SHTOPMVS = WX.glsl.meshVS + WARP + `
    uniform vec4 uNodeC;
    out float vY;
    void main() {
      vec3 p = wxInstPos(wxNodePos(aPos) - uNodeC.xyz);
      vY = p.y;
      vec2 w = cstWarpOf(p.xz);
      gl_Position = vec4(w * 2. - 1., clamp(.5 - p.y / 400., 0., 1.) * 2. - 1., 1.);
    }
  `;
  const SHTOPMFS = `in float vY; out vec4 o; void main() { o = vec4(vY, 1., 0., 1.); }`;
  /* step 2: seeds on the waterline, step 3: the jump flood (world distances in a warped grid) */
  const SHSEEDFS = SHARED + WARP + `
    uniform sampler2D uTop;
    out vec4 o;
    void main() {
      ivec2 c = ivec2(gl_FragCoord.xy), sz = textureSize(uTop, 0);
      bool land = texelFetch(uTop, c, 0).r > 0.;
      vec2 me = cstWorldOf((vec2(c) + .5) / vec2(sz)), best = vec2(1e9); float bd = 1e18;
      for (int k = 0; k < 4; k++) {
        ivec2 q = c + (k == 0 ? ivec2(1, 0) : k == 1 ? ivec2(-1, 0) : k == 2 ? ivec2(0, 1) : ivec2(0, -1));
        if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, sz))) continue;
        if ((texelFetch(uTop, q, 0).r > 0.) != land) {
          vec2 m = .5 * (me + cstWorldOf((vec2(q) + .5) / vec2(sz)));
          float d = dot(m - me, m - me);
          if (d < bd) { bd = d; best = m; }
        }
      }
      o = vec4(best, 0., 1.);
    }
  `;
  const SHJFAFS = SHARED + WARP + `
    uniform sampler2D uSeed; uniform int uStep;
    out vec4 o;
    void main() {
      ivec2 c = ivec2(gl_FragCoord.xy), sz = textureSize(uSeed, 0);
      vec2 me = cstWorldOf((vec2(c) + .5) / vec2(sz));
      vec2 best = texelFetch(uSeed, c, 0).xy; float bd = dot(best - me, best - me);
      for (int k = 0; k < 9; k++) {
        if (k == 4) continue;
        ivec2 q = c + ivec2(k % 3 - 1, k / 3 - 1) * uStep;
        if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, sz))) continue;
        vec2 s = texelFetch(uSeed, q, 0).xy;
        float d = dot(s - me, s - me);
        if (d < bd) { bd = d; best = s; }
      }
      o = vec4(best, 0., 1.);
    }
  `;
  /* step 4: SHORE: signed distance, depth, swell exposure (marched toward where the swell comes from), rockiness */
  const SHFINFS = SHARED + WARP + `
    uniform sampler2D uTop, uSeed; uniform vec2 uSwellFrom;
    out vec4 o;
    void main() {
      ivec2 c = ivec2(gl_FragCoord.xy), sz = textureSize(uTop, 0);
      vec2 uv = (vec2(c) + .5) / vec2(sz), me = cstWorldOf(uv);
      vec2 tr = texelFetch(uTop, c, 0).rg;
      vec2 sd = texelFetch(uSeed, c, 0).xy;
      float d = min(length(sd - me), 400.);
      float e = 1.;
      for (int s = 1; s <= 64; s++) {
        vec2 q = me + uSwellFrom * float(s) * 22.;
        vec2 w = cstWarpOf(q);
        if (w.x <= 0. || w.x >= 1. || w.y <= 0. || w.y >= 1.) break;
        if (texture(uTop, w).r > .3) { e = smoothstep(0., 1400., float(s) * 22.); break; }
      }
      /* rockiness: the rock meshes' footprints, dilated by a few texels, and the heads' rocky shores */
      float rk = tr.g;
      for (int k = 0; k < 8; k++) {
        float a = float(k) * .785398;
        vec2 q = cstWarpOf(me + vec2(cos(a), sin(a)) * max(3., length(me) * .01));
        rk = max(rk, texture(uTop, q).g * .85);
      }
      o = vec4(tr.r > 0. ? -d : d, clamp(-tr.r, -60., 60.), e, clamp(rk, 0., 1.));
    }
  `;

  /* ── state (build() starts it from nothing; a new context forgets every GL object) ── */
  let P = {}, loader = null, man = null, ph = 0, uniformsOf = new Map();
  let hgt = null, hgtFb = null, open = null, openFb = null, openTile = 0, fanCls = null, fanClsFb = null, terrain = null;
  let shTop = null, shTopFb = null, shTopDepth = null, shSeed = [null, null], shSeedFb = [null, null], shore = null, shoreFb = null, jfaK = 0;
  let shoreMeshes = false, rebaked = false;
  let shadow = null, shadowFb = null, shadowDrawn = false, rawSampler = null, shipZ = null, shipZFb = null, mirror = null, mirrorFb = null, mirrorDepth = null;
  let cache = null, mcache = null, cacheStamp = -1, cacheAt = -1e9, cacheValid = false, mirrorStale = true;
  let geo = [], byId = {}, lists = null, listStamp = -1, bucketTier = -1, lastTier = -1, vaos = [], cable = null;
  /* [r3] the light probe's pair (the wash holds go from one to the other), and the wash points */
  let probes = null, probeFbs = null, probeCur = 0, washReset = true;
  const washP = new Float32Array(32);
  /* [r4] the near shelf's spray points (under 200 m, strength 0..1): only the rocks on its seaward edge, where a crest
     strikes first. Round 3 gave all eleven rocks and shelves under 200 m a point, so up to eleven bursts at different
     phases overlapped into one pale bank over the left third (REVIEW-3 #10). The inner crags, the boulder near the
     window, the pier's shelf and its stones throw none: the edge breaks the crest before it reaches them */
  const NEAR_SPRAY = { "near-crag-1": 0.45, "near-crag-6": 0.4, "near-crag-5": 0.3, "near-crag-3": 0.35 };   // crag-5 0.3: its burst stands under the ship in the view (a 12 m jet reaches the hull)
  let lightDir = [0, 0, 0], lightAge = 1e9, redraw = false, lastShadowStamp = -1, probe = null, probeFb = null;
  /* below T3 the trees join the static cache while the wind is light: their sway is under half a pixel at
     600-1400 m below U10 14 m/s (the reading's, past the second quarter); they draw forward above it and go back
     below 12.5 (hysteresis, on the walked reading, not its gusts), so they bend in a storm */
  let treesDyn = true;
  let upStart = -1, viewAt = -1, upOK = false, fadeActive = false, fadeEnds = false, haveCove = false, readbackPending = false;
  const shadowBox = { range: 1 }, shipVP = new Float32Array(16), mapAt = new Map();
  const mem = { tex: 0, mesh: 0, targets: 0 };
  /* lab: the slot's main-thread time (ring of 240), the startup (wall-clock s): the view, the cove rising, fully up */
  const mirrorDst = { fb: null, w: 0, h: 0 };
  const cpu = { ring: new Float32Array(240), n: 0 }, start = { view: -1, rise: -1, up: -1 };
  const now = () => performance.now() / 1000;
  const JFA = [256, 128, 64, 32, 16, 8, 4, 2, 1, 1];

  /* ── programs: one source, variants by define (DESIGN 13.3, Samplers: <= 16 active per program) ── */
  function programs(R) {
    const libs = ["atmo", "clouds", "coast", "ocean"];
    const ST = "#define CST_PCSS 1\n#define CST_REFL 1\n", DY = "#define CST_DYN 1\n";
    P.mesh = R.program("coast.mesh", { libs, vs: MESHVSMAIN, fs: ST + MESHFS });
    P.dyn = R.program("coast.dyn", { libs, vs: DY + MESHVSMAIN, fs: DY + MESHFS });
    P.wire = R.program("coast.strand", { libs, vs: DY + STRANDVS, fs: DY + STRANDFS });
    P.ter = R.program("coast.terrain", { libs, vs: TERVS, fs: ST + TERFS });
    P.relight = R.program("coast.relight", { libs, vs: RELIGHTVS, fs: ST + RELIGHTFS });
    P.lamp = R.program("coast.lamp", { libs, vs: DY + LAMPVS, fs: LAMPFS });
    P.probe = R.program("coast.probe", { libs: ["atmo", "clouds", "ocean"], fs: PROBEFS });
    P.hgt = R.program("coast.hgt", { libs: [], fs: HGTFS.replace("vec2(textureSize0())", "vec2(" + HGTW + "., " + HGT + ".)") });
    P.open = R.program("coast.open", { libs: [], fs: OPENFS });
    P.fanCls = R.program("coast.fanCls", { libs: [], fs: FANCLSFS });
    P.shTop0 = R.program("coast.shTop0", { libs: [], fs: SHTOP0FS });
    P.shTopM = R.program("coast.shTopM", { libs: [], vs: SHTOPMVS, fs: SHTOPMFS });
    P.shSeed = R.program("coast.shSeed", { libs: [], fs: SHSEEDFS });
    P.shJfa = R.program("coast.shJfa", { libs: [], fs: SHJFAFS });
    P.shFin = R.program("coast.shFin", { libs: [], fs: SHFINFS });
  }
  const VIEWP = ["mesh", "dyn", "wire", "ter", "relight", "lamp", "probe"];
  /* uniform locations, cached once per program (only once it is linked); private samplers on fixed units */
  function uloc(prog) {
    let m = uniformsOf.get(prog);
    if (m) return m;
    m = {};
    for (const k in prog.u) m[k] = prog.u[k].loc;
    uniformsOf.set(prog, m);
    return m;
  }
  const SAMPLERS = [["uBase", UNIT.base], ["uNrm", UNIT.nrm], ["uOrm", UNIT.orm], ["uOpen", UNIT.open], ["uHgt", UNIT.hgt], ["uAlbA", UNIT.albA],
    ["uNrmA", UNIT.nrmA], ["uOrmA", UNIT.ormA], ["uG0", UNIT.g0], ["uG1", UNIT.g1], ["uGZ", UNIT.gz], ["uShadowRaw", UNIT.raw], ["uShipZ", UNIT.shipZ],
    ["uTop", UNIT.base], ["uSeed", UNIT.nrm], ["uProbe", UNIT.aux]];
  function bindUnits(gl, prog) {
    const m = uloc(prog);
    gl.useProgram(prog.prog);
    for (let k = 0; k < SAMPLERS.length; k++) { const l = m[SAMPLERS[k][0]]; if (l) gl.uniform1i(l, SAMPLERS[k][1]); }
    return m;
  }
  const tex2 = (gl, unit, t) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t ? t.tex || t : null); };
  const texA = (gl, unit, t) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D_ARRAY, t ? t.tex : null); };

  /* ── the light's box: an orthographic view along -L over the casters. Receivers beyond the far plane compare
     at depth 1, so the heads' shadows reach across the sea as far as the light's xy box covers ── */
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };
  function lightBasis(L) {
    const up = Math.abs(L[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0], f = [-L[0], -L[1], -L[2]], r = unit3(cross(f, up));
    return { r, u: cross(r, f), f };
  }
  function lightMatrix(L, out) {
    const { r, u, f } = lightBasis(L), lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (const x of [-1300, 1300]) for (const y of [-12, 128]) for (const z of [-260, 1700]) {
      const v = [x * r[0] + y * r[1] + z * r[2], x * u[0] + y * u[1] + z * u[2], x * f[0] + y * f[1] + z * f[2]];
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
    }
    hi[2] += 200;
    const sx = 2 / (hi[0] - lo[0]), sy = 2 / (hi[1] - lo[1]), sz = 2 / (hi[2] - lo[2]);
    const ox = -(hi[0] + lo[0]) / 2, oy = -(hi[1] + lo[1]) / 2, oz = -(hi[2] + lo[2]) / 2;
    out.set([r[0] * sx, u[0] * sy, f[0] * sz, 0, r[1] * sx, u[1] * sy, f[1] * sz, 0, r[2] * sx, u[2] * sy, f[2] * sz, 0, ox * sx, oy * sy, oz * sz, 1]);
    return { ex: hi[0] - lo[0], ey: hi[1] - lo[1], range: hi[2] - lo[2] };
  }
  /* the shadow map keeps its texel count but takes the box's aspect (1, 2 or 4 to 1, either way): a low sun
     looks along a box 10-15 times wider than tall, and a square map would waste most of its rows */
  function shadowShape(ex, ey, sp) {
    const r = ex / ey, a = r >= 3 ? 4 : r >= 1.5 ? 2 : r <= 1 / 3 ? 0.25 : r <= 1 / 1.5 ? 0.5 : 1;
    return [Math.round(sp * Math.sqrt(a)), Math.round(sp / Math.sqrt(a))];
  }
  /* the ship's own box: a 48 m cube round its middle, along the key light */
  /* (every world frame: scalars into the output, no allocation) */
  function shipMatrix(L, cx, cz, out) {
    const h = 24, cy = 12, fx = -L[0], fy = -L[1], fz = -L[2];
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(L[1]) > 0.99) { uy = 0; uz = 1; }
    let rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux;
    const rl = Math.hypot(rx, ry, rz); rx /= rl; ry /= rl; rz /= rl;
    const vx = ry * fz - rz * fy, vy = rz * fx - rx * fz, vz = rx * fy - ry * fx;
    const o0 = -(cx * rx + cy * ry + cz * rz), o1 = -(cx * vx + cy * vy + cz * vz), o2 = -(cx * fx + cy * fy + cz * fz);
    out[0] = rx / h; out[1] = vx / h; out[2] = fx / h; out[3] = 0; out[4] = ry / h; out[5] = vy / h; out[6] = fy / h; out[7] = 0;
    out[8] = rz / h; out[9] = vz / h; out[10] = fz / h; out[11] = 0; out[12] = o0 / h; out[13] = o1 / h; out[14] = o2 / h; out[15] = 1;
  }

  /* ── the ship at anchor and the buoy: pure functions of the sea clock (DESIGN 13.3) ── */
  const SHIPI = C.items.find((x) => x.role === "ship"), BUOYI = C.items.find((x) => x.role === "buoy"), LAMPI = C.items.find((x) => x.role === "lamp");
  /* the hull: its centre 2.15 m forward of the mesh origin, half-length 15.2, half-beam 4.2, draft 1.9; the
     hawse and the anchor light at the forestay, in the mesh's frame (bow +x) */
  const SHIP = { cx: 2.15, halfL: 15.2, halfB: 4.2, draft: 1.9, hawse: [16.0, 3.9, 0], light: [17.2, 11.0, 0] };
  /* [r2] its lights at night, in the mesh frame (bow +x; the taffrail's top is 10.1 m up at x -12.7): the anchor
     light at the forestay (white, 1800 K oil), the stern lantern above the taffrail, two stern windows (dim, warm).
     [r3] i: intensity in rel m^2 before the exposure (as R.coast.lamps: the illuminance it gives at 1 m), size m
     (the flame or the pane, for the core's width when it is over a pixel), core: the core's weight; fl: the oil
     flame's flicker. The last is the pier lantern's flame, in world m (its glass is a mesh, held under a ceiling) */
  const SHIPLAMPS = [
    { p: [17.2, 11.0, 0], size: 0.3, rgb: [1, 0.93, 0.8], i: 3e-4, fl: 0, core: 1 },
    { p: [-13.2, 11.0, 0], size: 0.35, rgb: [1, 0.62, 0.28], i: 3e-4, fl: 1, core: 1 },
    { p: [-13.25, 8.1, -1.1], size: 0.45, rgb: [1, 0.55, 0.22], i: 0.4e-4, fl: 0.5, core: 1 },
    { p: [-13.25, 8.1, 1.1], size: 0.45, rgb: [1, 0.55, 0.22], i: 0.4e-4, fl: 0.5, core: 1 },
    { world: true, size: 0.12, rgb: [1, 0.6, 0.27], i: 2.5e-4, fl: 1, core: 1 },           // [r3] the pier lantern's flame
  ];
  const lampC = SHIPLAMPS.map(() => new Float32Array(4)), lampK = SHIPLAMPS.map(() => new Float32Array(4));
  const lampS = new Float32Array(SHIPLAMPS.length), lampM = new Float32Array(SHIPLAMPS.length), lampG = new Float32Array(SHIPLAMPS.length);
  let maxPoint = 64;
  const pose = { x: 0, z: 0, yaw: 0, bx: 0, bz: 0, byaw: 0 };
  const sm = (a, b, x) => { const k = Math.max(0, Math.min(1, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
  /* [r2] the ship's mean heading: in light airs it lies as moored, broadside to the window (yaw 62); as the
     reading's wind rises past 10 m/s it swings 27 deg toward the sea and the swell (a three-quarter view, where its
     pitch and roll both tilt the masts on screen; broadside, a beam sea's roll only moves the mastheads toward and
     away from the camera). A pure function of the reading's wind (the director's walker, never its gusts), so at a
     steady reading it does not move. */
  const shipYaw0 = (U10) => SHIPI.yaw - 27 * sm(10, 22, U10);
  function poseAt(t, U10 = 8) {
    const two = 2 * Math.PI;
    if (SHIPI) {
      /* moored fore and aft: the heading swings +-3 deg over 256 s and +-1.2 deg over 1024/11 s about its mean, and
         it surges +-0.8 m over 128 s along its length: every period divides the sea's 1024 s */
      const y0 = shipYaw0(U10), yaw = y0 + 3.0 * Math.sin((two * t) / 256) + 1.2 * Math.sin((two * t * 11) / 1024 + 1.1);
      const s = 0.8 * Math.sin((two * t) / 128), a = y0 * D;
      pose.x = SHIPI.pos[0] + Math.sin(a) * s; pose.z = SHIPI.pos[2] + Math.cos(a) * s; pose.yaw = yaw;
    }
    if (BUOYI) {
      pose.byaw = 8 * Math.sin((two * t) / 64);
      pose.bx = BUOYI.pos[0] + 0.6 * Math.sin((two * t * 12) / 1024); pose.bz = BUOYI.pos[2] + 0.4 * Math.sin((two * t * 5) / 1024 + 0.7);
    }
    return pose;
  }
  C.poseAt = (t, U10) => { const q = poseAt(t, U10); return { x: q.x, z: q.z, yaw: q.yaw, bx: q.bx, bz: q.bz, byaw: q.byaw }; };   // for the hold tests
  /* [r2] the ship's own motion in a seaway, on top of the sea's slope under it (SEAPROBE, in the vertex shader): a
     roll near its natural period (about 12 s) and a pitch (about 7 s), each a sum of three or two sines whose
     periods divide the sea's 1024 s (they loop with the sea and beat into groups of bigger rolls), their amplitude
     the sea state's: +-1 deg of roll in a breeze, +-11 at the cap (+-0.4 and +-3 of pitch: more lifts the bow and
     stern clear of a sea that is not under them); and a heel to leeward
     from the wind on the bare rig, 0 in calm, 4 deg at 26 m/s, breathing with the gusts. No state: a function of
     the sea clock and the wind (uShipM: x roll, y pitch rad). */
  const shipM = new Float32Array(4);
  function shipMotion(t, U10, Ug, wdx, wdz, yawDeg) {
    const w = (2 * Math.PI * t) / 1024, k = sm(6, 26, U10), k2 = k * k, a = yawDeg * D;
    /* [r3] harder at the cap (the storm look: +-14 deg of roll, +-4 of pitch on top of the sea's own slope) */
    const roll = (1 + 13 * k2) * D * (0.6 * Math.sin(85 * w + 0.3) + 0.3 * Math.sin(79 * w + 1.9) + 0.1 * Math.sin(97 * w + 4.1));
    const pitch = (0.4 + 3.6 * k2) * D * (0.65 * Math.sin(146 * w + 2.2) + 0.35 * Math.sin(131 * w + 0.7));
    /* the masthead leans toward local -x for a positive roll; the wind pushes it along its direction of travel */
    const heel = 4 * D * Math.min(1.5, (Ug / 26) ** 2) * (wdx * Math.cos(a) - wdz * Math.sin(a));
    shipM[0] = roll - heel; shipM[1] = pitch;
    return shipM;
  }
  C.shipMotion = (t, U10, Ug, wdx, wdz, yawDeg) => Array.from(shipMotion(t, U10, Ug, wdx, wdz, yawDeg));

  /* ── instances: one row per placed piece (WX.MESH: 3 rows of the model matrix, then aInstP) ── */
  const motionOf = (it) => (it.role === "ship" ? 2 : it.role === "buoy" ? 6 : it.role === "tree" ? 0.35 : it.role === "plant" ? 1 : 0);
  function instRow(it, out, o, x, y, z, yaw, e0, e1, e3) {
    const c = Math.cos(yaw * D), s = Math.sin(yaw * D), k = it.scale;
    if (it.tilt || it.stretch) { tiltRow(it, out, o, c, s, k); out[o + 3] = x; out[o + 7] = y; out[o + 11] = z; }
    else {
      out[o] = c * k; out[o + 1] = 0; out[o + 2] = s * k; out[o + 3] = x;
      out[o + 4] = 0; out[o + 5] = k; out[o + 6] = 0; out[o + 7] = y;
      out[o + 8] = -s * k; out[o + 9] = 0; out[o + 10] = c * k; out[o + 11] = z;
    }
    out[o + 12] = e0; out[o + 13] = e1; out[o + 14] = 1; out[o + 15] = e3;
  }
  /* [r3] M = yaw . roll(z) . lean(x) . diag(k sx, k sy, k sz): a crag leans back from the window (lean < 0 tips its
     top away along -z, so its scanned face becomes a slope that takes the sky) and rolls in its own plane (one end
     higher). Static pieces only: their rows are made at a bucketize, never a frame */
  function tiltRow(it, out, o, c, s, k) {
    const t = it.tilt || [0, 0], st = it.stretch || [1, 1, 1];
    const ca = Math.cos(t[0] * D), sa = Math.sin(t[0] * D), cb = Math.cos(t[1] * D), sb = Math.sin(t[1] * D);
    /* Rz . Rx, then the scale on the columns */
    const A = [cb, -sb * ca, sb * sa, sb, cb * ca, -cb * sa, 0, sa, ca];
    const Y = [c, 0, s, 0, 1, 0, -s, 0, c];
    for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++)
      out[o + r * 4 + q] = (Y[r * 3] * A[q] + Y[r * 3 + 1] * A[3 + q] + Y[r * 3 + 2] * A[6 + q]) * k * st[q];
  }
  function rowOf(it, out, o) {
    if (it.role === "ship") return instRow(it, out, o, pose.x, 0, pose.z, pose.yaw, 0.85, 2, it.seed);
    if (it.role === "buoy") return instRow(it, out, o, pose.bx, 0, pose.bz, pose.byaw, 0.92, 6, it.seed);
    instRow(it, out, o, it.pos[0], it.pos[1], it.pos[2], it.yaw, it.role === "pier" ? 0.92 : it.role === "plant" ? 0.8 : 1, motionOf(it), it.seed);
  }
  /* the LOD an instance draws in a pass at this tier, or -1 (not drawn); the table's, clamped to what ships */
  function lodFor(it, mode, R, lods) {
    const t = R.tier, mx = Math.max(...lods), mn = Math.min(...lods);
    const clamp = (l) => { l = Math.max(mn, Math.min(mx, l)); while (!lods.includes(l) && l < mx) l++; return l; };
    const base = clamp(it.lod[t] + (R.p("coastLodBias") | 0));
    if (mode === 1) return clamp(Math.max(...it.lod.map(clamp)));
    if (mode === 2) return t < 3 && !MIRROR_LOW.test(it.role) ? -1 : clamp(base + R.knobs.reflLod);
    return base;
  }
  /* frustum test of an instance's bounding sphere (the view; the mirror flips y); made per resize */
  function inView(R, it, mir) {
    const cam = R.cam, rad = Math.max(it.half[0], it.half[1], it.half[2]) * it.scale * (it.stretch ? Math.max(...it.stretch) : 1) * 1.8 + 4;
    const y = (mir ? -1 : 1) * (it.pos[1] + it.half[1] * it.scale) - cam.eye, dx = it.pos[0], dz = it.pos[2];
    const zc = dx * cam.fwd[0] + y * cam.fwd[1] + dz * cam.fwd[2];
    if (zc < -rad) return false;
    const xc = dx * cam.right[0] + y * cam.right[1] + dz * cam.right[2], yc = dx * cam.up[0] + y * cam.up[1] + dz * cam.up[2];
    return Math.abs(xc) - zc * cam.tanX < rad * Math.hypot(1, cam.tanX) && Math.abs(yc) - zc * cam.tanY < rad * Math.hypot(1, cam.tanY);
  }
  /* buckets per (asset, part, LOD, pass), each with its instance buffer; made again at a tier change or resize */
  function bucketize(R) {
    const gl = R.gl;
    for (const g of geo) for (const b of g.buckets) gl.deleteBuffer(b.ib);
    const veg = R.knobs.veg === undefined ? 1 : R.knobs.veg;
    for (const g of geo) {
      const old = g.buckets;
      g.buckets = [];
      const a = man.models.find((m) => m.id === g.id), lods = a.lods.map((l) => l.lod);
      for (const mode of [0, 1, 2]) {
        const by = {};
        for (const it of g.its) {
          if ((it.role === "plant" || it.role === "tree") && it.var > veg) continue;   // knobs.veg thins the plants and trees
          if (it.role === "tree" && !R.p("coastTrees")) continue;         // lab: timing
          const l = lodFor(it, mode, R, lods);
          if (l < 0 || (mode !== 1 && !inView(R, it, mode === 2))) continue;
          const key = l + "|" + (it.part || "");
          (by[key] = by[key] || []).push(it);
        }
        for (const key in by) {
          const [l, part] = key.split("|"), its = by[key], inst = new Float32Array(its.length * 16);
          its.forEach((it, k) => rowOf(it, inst, k * 16));
          const ib = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, ib); gl.bufferData(gl.ARRAY_BUFFER, inst, gl.DYNAMIC_DRAW);
          const prev = old.find((b) => b.mode === mode && b.lod === +l && b.part === (part || null));
          const dyn = its[0].role === "tree" ? treesDyn || R.tier >= 3 : DYN.test(its[0].role);
          g.buckets.push({ mode, lod: +l, part: part || null, its, inst, ib, dyn, moving: /ship|buoy/.test(its[0].role),
                           dist: Math.min(...its.map((it) => Math.hypot(it.pos[0], it.pos[2]))), centre: !!its[0].center,
                           shown: prev ? prev.shown : -1, from: -1, t0: 0 });
        }
      }
    }
    bucketTier = R.tier; listStamp = -1;
  }
  /* a VAO for one primitive with one bucket's instance rows (the loader's prim attributes, bound again) */
  function vaoFor(gl, pr, ib) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    for (const a of pr.attrs) { gl.bindBuffer(gl.ARRAY_BUFFER, a.buf); gl.enableVertexAttribArray(a.loc); gl.vertexAttribPointer(a.loc, a.size, a.type, a.norm, a.stride, a.offset); }
    if (pr.wire) { gl.bindBuffer(gl.ARRAY_BUFFER, pr.wire); gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 0, 0); }
    gl.bindBuffer(gl.ARRAY_BUFFER, ib);
    for (let k = 0; k < 4; k++) { gl.enableVertexAttribArray(4 + k); gl.vertexAttribPointer(4 + k, 4, gl.FLOAT, false, 64, k * 16); gl.vertexAttribDivisor(4 + k, 1); }
    if (pr.ebo) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, pr.ebo);
    gl.bindVertexArray(null);
    vaos.push(vao);
    return vao;
  }
  /* the anchor cable: a 6-sided tube of 8 sections from the hawse 40 deg down to the water with a little sag, in the
     ship's mesh frame (bow +x), as coverage triangles; it rides with the ship */
  function makeCable(gl) {
    const [hx, hy, hz] = SHIP.hawse, L = hy / Math.sin(40 * D) + 1.5, seg = 8, sides = 6, r0 = 0.035;
    const ring = (i, k) => {
      const s = (i / seg) * L, a = (k / sides) * 2 * Math.PI, sag = 0.02 * s * (L - s) / L;
      const n = [Math.sin(40 * D) * Math.cos(a), Math.cos(40 * D) * Math.cos(a), Math.sin(a)];
      return [hx + Math.cos(40 * D) * s + n[0] * r0, hy - Math.sin(40 * D) * s - sag + n[1] * r0, hz + n[2] * r0];
    };
    const f = new Float32Array(seg * sides * 2 * 11);
    let o = 0;
    for (let i = 0; i < seg; i++) for (let k = 0; k < sides; k++) {
      const a = ring(i, k), b = ring(i, (k + 1) % sides), c = ring(i + 1, k), d = ring(i + 1, (k + 1) % sides);
      for (const t of [[a, c, b], [b, c, d]]) { f.set([...t[0], ...t[1], ...t[2], 0.62, 0.3], o); o += 11; }
    }
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, f, gl.STATIC_DRAW); gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return { buf: b, n: seg * sides * 2, layout: "f32" };
  }
  /* how many of a wire primitive's triangles are spars (least altitude 6 cm or more, at this node and instance scale):
     the loader sorted them widest first */
  function sparsOf(tris, node, scale) {
    const k = Math.hypot(node[0], node[1], node[2]) * scale, a = tris.alts;
    if (!a) return 0;
    let lo = 0, hi = a.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] * k >= 0.06) lo = m + 1; else hi = m; }
    return lo;
  }
  /* a VAO for a coverage-triangle list: the triangles as instances (8-11) */
  function strandVao(gl, tris) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, tris.buf);
    const sn = tris.layout === "snorm16", st = sn ? 28 : 44;
    for (let k = 0; k < 3; k++) { gl.enableVertexAttribArray(8 + k); gl.vertexAttribPointer(8 + k, sn ? 4 : 3, sn ? gl.SHORT : gl.FLOAT, sn, st, k * (sn ? 8 : 12)); gl.vertexAttribDivisor(8 + k, 1); }
    gl.enableVertexAttribArray(11); gl.vertexAttribPointer(11, 2, sn ? gl.HALF_FLOAT : gl.FLOAT, false, st, sn ? 24 : 36); gl.vertexAttribDivisor(11, 1);
    /* (the moving piece's instance row is a uniform, uRow: a divisor past the count, or a 3 x 16-bit format, makes
       ANGLE's Vulkan backend convert the buffer on every draw: the whole RTX frame ran 4.6 times slower) */
    gl.bindVertexArray(null);
    vaos.push(vao);
    return vao;
  }
  /* the draw lists: per pass and program, front to back, each entry a few GL calls; made again only when the
     tier, the buckets or the arrived files change (DESIGN 13.3: the slot's JS <= 0.3 ms, no allocation a frame).
     The fades only update numbers in place (updateFades) */
  function buildLists(R) {
    const gl = R.gl, t = now();
    for (const v of vaos) gl.deleteVertexArray(v);
    vaos = [];
    const L = () => ({ stat: [], dyn: [] });
    lists = { 0: L(), 1: L(), 2: L(), wire0: [], wire2: [], lamp: null, ship1: [] };
    for (const g of R.p("coastMeshes") ? geo : []) for (const b of g.buckets) {
      /* the LOD this bucket shows: the one it asked for, or the nearest that has arrived; a newly arrived finer
         one cross-fades in over 0.5 s, the old one dithering out against it */
      const m = loader.mesh(g.id, b.lod);
      if (!m) continue;
      if (b.shown < 0 || b.mode === 1) { b.shown = m.lod; b.from = -1; }
      else if (m.lod !== b.shown) { b.from = b.shown; b.shown = m.lod; b.t0 = t; }
      if (b.from >= 0 && t - b.t0 >= 0.5) b.from = -1;
      const show = [[loader.mesh(g.id, b.shown), 0]];
      if (b.from >= 0 && loader.has(g.id, b.from)) show.push([loader.mesh(g.id, b.from), 1]);
      for (const [mm, out] of show) for (const part of mm.parts) {
        if (b.part && part.name.replace(/_dequant$/, "") !== b.part.replace(/_dequant$/, "")) continue;
        const own = b.part ? part.own : part.xform;
        const node = mul4(g.axis, own);
        const ob = b.part ? part.ownBounds : part.bounds;
        const centre = new Float32Array([b.centre && ob ? (ob[0][0] + ob[1][0]) / 2 : 0, 0, 0, 0]);
        for (const pr of part.prims) {
          const mt = mm.materials[pr.mat] || { name: "", alpha: "OPAQUE" }, tx = loader.mat(g.id, mt.name), mk = matOf(g.id, mt.name);
          if (!tx.base) continue;                         // the base colour comes with the coarse set; until then not drawn
          const maps = !!(tx.nrm && tx.orm);
          if (maps && !mapAt.has(tx.nrm)) mapAt.set(tx.nrm, t);
          const tint = C.TINT[g.id] || [1, 1, 1];
          const role = b.its[0].role;
          /* [r2] a wire material outside the shadow maps draws as coverage triangles; only the LOD shown (no double
             rigging while the LODs cross-fade) */
          if (mk.kind === 6 && pr.tris && R.p("coastWires") && b.mode !== 1) {
            if (!out) lists[b.mode === 2 ? "wire2" : "wire0"].push({ vao: strandVao(gl, pr.tris), n: pr.tris.n, nSpar: sparsOf(pr.tris, node, b.its[0].scale),
                                                                       node, centre, base: tx.base, dist: b.dist, inst: b.inst });
            continue;
          }
          const src = pr;
          const e = { vao: vaoFor(gl, src, b.ib), n: b.its.length, node, centre, count: src.count, type: src.type, off: src.offset, prim: src.mode,
            base: tx.base, nrm: tx.nrm, orm: tx.orm, mapKey: tx.nrm, cut: mt.alpha === "MASK" ? mt.cutoff : 0, as: tx.alphaScale || 1, por: mk.por, kind: mk.kind,
            tint: new Float32Array([tint[0], tint[1], tint[2], 0]), fade: new Float32Array([1, out, mk.thin, maps ? 1 : 0]),
            meshI: new Float32Array([g.meshH, b.its[0].snap ? 1 : 0, 1, 0]), twoSided: !!mt.twoSided, dist: b.dist, bucket: b, out,
            shad: new Float32Array([role === "ship" ? 40 : role === "buoy" ? 8 : role === "tree" ? 7 : role === "plant" ? 2 : 0, role === "ship" ? 1 : 0, 0, 0]),
            metal: g.id === "wooden_lantern_01" && mt.name === "main" ? 1 : 0, lamp: g.id === "wooden_lantern_01" && mt.name === "glass" };
          lists[b.mode][b.dyn ? "dyn" : "stat"].push(e);
          if (b.mode === 1 && role === "ship" && mk.kind !== 6) lists.ship1.push(e);   // the ship's own map: hull and sails
        }
      }
      if (g.id === "dutch_ship_large_01" && b.mode === 0 && !lists.lamp) {
        lists.lamp = { vao: vaoFor(gl, { attrs: [], ebo: null }, b.ib), node: g.axis };
        if (!cable) cable = makeCable(gl);
        if (R.p("coastWires")) {
          lists.wire0.push({ vao: strandVao(gl, cable), n: cable.n, nSpar: 0, node: g.axis, centre: new Float32Array(4), base: null, dist: b.dist, inst: b.inst });
        }
      }
    }
    for (const k of [0, 1, 2]) { lists[k].stat.sort((a, b) => a.dist - b.dist); lists[k].dyn.sort((a, b) => a.dist - b.dist); }
    lists.fadeSets = [lists[0].stat, lists[0].dyn, lists[2].stat, lists[2].dyn, lists.wire0, lists.wire2];
    const rig = loader.mat("dutch_ship_large_01", "rigging").base;
    for (const e of lists.wire0) if (!e.base) e.base = rig;
    for (const e of lists.wire2) if (!e.base) e.base = rig;
    R.coast.draws = [0, 1, 2].reduce((s, k) => s + lists[k].stat.length + lists[k].dyn.length, 0) + lists.wire0.length + lists.wire2.length + 2;
    updateFades(t);
  }
  /* the fades, in place: the LOD cross-fades (0.5 s), the normal and ORM maps' fade-in (0.5 s) */
  function fadeOne(e, t) {
    const b = e.bucket;
    if (!b) return;
    if (b.from >= 0) {
      const f = Math.min(1, (t - b.t0) / 0.5);
      e.fade[0] = f;
      if (f >= 1) fadeEnds = true; else fadeActive = true;
    } else e.fade[0] = e.out ? 0 : 1;
    if (e.mapKey) { const w = Math.min(1, (t - mapAt.get(e.mapKey)) / 0.5); e.tint[3] = w; if (w < 1) fadeActive = true; }
  }
  function updateFades(t) {
    fadeActive = false; fadeEnds = false;
    const L = lists.fadeSets;
    for (let i = 0; i < L.length; i++) for (let k = 0; k < L[i].length; k++) fadeOne(L[i][k], t);
  }

  /* ── drawing ── */
  /* the winding: the contract camera's basis is mirrored (right x up = forward), so glTF's counter-clockwise
     fronts land clockwise in the view; the mirror flips them back, and the light's box keeps them */
  const faceFor = (gl, mode) => gl.frontFace(mode === 0 || mode === 3 ? gl.CW : gl.CCW);
  const glCheck = (R, what) => { /*@lab*/ if (!R.p("coastGLCheck")) return; const e = R.gl.getError(); if (e) console.warn("coast: GL error 0x" + e.toString(16) + " after " + what + " (tier " + R.tier + ")"); /*@end*/ };
  function drawMeshes(R, prog, list, mode) {
    if (!list.length) return;
    /* [r3] the lantern's glass does not burn in the mirror: its 1-2 texels became a block in COASTREFL's coarse mips;
       the sea lays its streak from R.coast.lamps */
    const gl = R.gl, u = uloc(prog), lit = mode === 2 ? 0 : R.coast.lights * R.coast.up * R.exposure.E;
    faceFor(gl, mode);
    gl.useProgram(prog.prog);
    gl.uniform1i(u.uMode, mode);
    let node = null, base = null, nrm = null, orm = null, cull = -1;
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (d.node !== node) { gl.uniformMatrix4fv(u.uNode, false, d.node); node = d.node; }
      gl.uniform4fv(u.uNodeC, d.centre);
      gl.uniform4f(u.uMatK, d.cut, d.as, d.por, d.kind);
      gl.uniform4fv(u.uTint, d.tint);
      gl.uniform4fv(u.uFade, d.fade);
      gl.uniform4fv(u.uMeshI, d.meshI);
      if (u.uShad) gl.uniform4fv(u.uShad, d.shad);
      /* the lantern's glass burns at night (1800 K), the fittings keep their metal */
      /* [r3] under a soft ceiling (pre-exposed 0.8: warm, not white): at a night exposure 4e-3 x E blew the whole glass into a white
         ball 4-5 px wide; the flame's point is the lamp sprite's core */
      const k = d.lamp ? 0.8 * (1 - Math.exp(-4e-3 * lit / 0.8)) : 0;
      gl.uniform4f(u.uEmis, k, k * 0.46, k * 0.15, d.metal);
      if (d.base !== base) { tex2(gl, UNIT.base, d.base); base = d.base; }
      if (d.nrm !== nrm) { tex2(gl, UNIT.nrm, d.nrm); nrm = d.nrm; }
      if (d.orm !== orm) { tex2(gl, UNIT.orm, d.orm); orm = d.orm; }
      const c = d.twoSided ? 0 : 1;
      if (c !== cull) { if (c) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE); cull = c; }
      gl.bindVertexArray(d.vao);
      if (d.type) gl.drawElementsInstanced(d.prim, d.count, d.type, d.off, d.n);
      else gl.drawArraysInstanced(d.prim, 0, d.count, d.n);
      glCheck(R, (prog === P.dyn ? "dyn" : "mesh") + " mode " + mode + " kind " + d.kind + " lamp " + !!d.lamp);
    }
    gl.disable(gl.CULL_FACE);
    gl.frontFace(gl.CCW);
    gl.bindVertexArray(null);
  }
  function drawTerrain(R, mode, range) {
    if (!terrain || !R.p("coastTerrain")) return;
    const gl = R.gl, u = uloc(P.ter);
    gl.useProgram(P.ter.prog);
    gl.uniform1i(u.uMode, mode);
    gl.bindVertexArray(terrain.vao);
    for (const c of terrain.chunks) {
      gl.uniform1i(u.uVBase, c.base);
      if (range !== "bed" && c.land) gl.drawElements(gl.TRIANGLES, c.land, gl.UNSIGNED_SHORT, c.off * 2);
      if (range === "all" && c.bed) gl.drawElements(gl.TRIANGLES, c.bed, gl.UNSIGNED_SHORT, (c.off + c.land) * 2);
    }
    gl.bindVertexArray(null);
  }
  /* the cached cove: its depth restored by a blit, then one relighting pass where it stands */
  function relight(R, c, mode, dst) {
    const gl = R.gl;
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, c.fb.fb); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fb);
          gl.blitFramebuffer(0, 0, c.w, c.h, 0, 0, dst.w, dst.h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
          R.bind(dst);
          let rz = gl.GREATER; /*@lab*/ rz = [gl.GREATER, gl.NEVER, gl.ALWAYS][R.p("coastRelightZ") | 0]; /*@end*/
          gl.enable(gl.DEPTH_TEST); gl.depthFunc(rz); gl.depthMask(false);
          tex2(gl, UNIT.g0, c.g0); tex2(gl, UNIT.g1, c.g1); tex2(gl, UNIT.gz, c.z);
          gl.useProgram(P.relight.prog); gl.uniform1i(uloc(P.relight).uMode, mode);
          let cheap = 0; /*@lab*/ cheap = R.p("coastCheap"); /*@end*/
          gl.uniform4f(uloc(P.relight).uShad, 0, 0, cheap, 0);
          R.gpu.fullscreen();
          tex2(gl, UNIT.g0, null); tex2(gl, UNIT.g1, null); tex2(gl, UNIT.gz, null);
          gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
  }
  function drawWires(R, list, mode) {
    if (!list.length || !R.p("coastWires")) return;
    const gl = R.gl, u = uloc(P.wire);
    gl.useProgram(P.wire.prog);
    gl.uniform1i(u.uMode, mode);
    gl.disable(gl.CULL_FACE);
    const tw = mode === 2 ? mirror.w : R.size.S[0], th = mode === 2 ? mirror.h : R.size.S[1];
    let dbg = 0; /*@lab*/ dbg = R.p("coastWireDbg"); /*@end*/
    /* pass 0: blended where the sky is behind, no depth write (a quad's margin must not hide the ropes behind it);
       pass 1 (the view only): opaque over the sea for the cores at least half a pixel wide, writing depth and SCENEZ */
    /* the mirror (T3-T4) takes the spars only, blended: a rope is far below a pixel of the half-size mirror */
    for (let pass = 0; pass < (mode === 2 ? 1 : 2); pass++) {
      const pw = mode === 2 ? 2 : pass;
      if (pw !== 1) { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); }
      else { gl.disable(gl.BLEND); gl.depthMask(true); }
      let base = undefined;
      /* [r3] below T3 (Intel at T2) the rope pass may draw only the widest share of the strands (the loader sorts
         them widest first): `coastWireFrac` */
      const frac = R.tier < 3 ? R.p("coastWireFrac") : 1;
      for (const d of list) {
        const n = pw === 0 ? Math.max(d.nSpar, Math.ceil(d.n * frac)) : d.nSpar;
        if (!n) continue;
        gl.uniformMatrix4fv(u.uNode, false, d.node); gl.uniform4fv(u.uNodeC, d.centre);
        gl.uniform4fv(u.uRow, d.inst, 0, 16);         // the ship's instance row (its bucket's, updated this frame)
        gl.uniform4f(u.uStrand, tw, th, dbg, pw);
        if (d.base !== base) { tex2(gl, UNIT.base, d.base); base = d.base; }
        gl.bindVertexArray(d.vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, n);
        glCheck(R, "strands mode " + mode + " pass " + pw);
      }
    }
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND); gl.depthMask(true); gl.frontFace(gl.CCW);
  }
  function drawLamp(R) {
    if (!lists.lamp || R.coast.lights <= 0) return;
    const gl = R.gl, u = uloc(P.lamp);
    gl.useProgram(P.lamp.prog);
    gl.uniform1i(u.uMode, 0);
    gl.uniformMatrix4fv(u.uNode, false, lists.lamp.node); gl.uniform4f(u.uNodeC, 0, 0, 0, 0);
    gl.uniform4f(u.uMeshI, 1, 0, 1, 0);
    gl.bindVertexArray(lists.lamp.vao);
    /* [r3] added over the cove, SCENE only: blending an R32F attachment (SCENEZ) needs EXT_float_blend */
    gl.drawBuffers(DB1); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    for (let pass = 0; pass < 2; pass++) {
      gl.depthMask(pass === 0);
      for (let k = 0; k < SHIPLAMPS.length; k++) {
        const L = SHIPLAMPS[k], c = lampC[k];
        if (c[3] <= 0) continue;
        if (L.world) { gl.uniform4f(u.uLampW, LAMPI.pos[0], LAMPI.pos[1] + 0.75, LAMPI.pos[2], 1); gl.uniform4f(u.uLampP, 0, 0, 0, lampS[k]); }
        else { gl.uniform4f(u.uLampW, 0, 0, 0, 0); gl.uniform4f(u.uLampP, L.p[0], L.p[1], L.p[2], lampS[k]); }
        gl.uniform4fv(u.uLampC, c); gl.uniform4fv(u.uLampK, lampK[k]); gl.uniform4f(u.uLampM, lampM[k], lampG[k], pass, 0);
        gl.drawArraysInstanced(gl.POINTS, 0, 1, 1);
      }
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND); gl.drawBuffers(DB2);
    gl.bindVertexArray(null);
  }
  const DB1 = [0x8CE0, 0], DB2 = [0x8CE0, 0x8CE1];      // COLOR_ATTACHMENT0, NONE / COLOR_ATTACHMENT0, 1
  /* uniforms every coast program shares this frame (no allocation: cached values) */
  const TILE = new Float32Array(4), cacheJ = new Float32Array(2), shipC = new Float32Array(3);
  function common(R, prog) {
    const gl = R.gl, u = bindUnits(gl, prog);
    if (u.uBox) gl.uniform4f(u.uBox, B[0], B[1], 1 / (B[2] - B[0]), 1 / (B[3] - B[1]));
    let dv = 0; /*@lab*/ dv = R.p("coastDebug"); /*@end*/
    if (u.uShadowK) gl.uniform4f(u.uShadowK, R.knobs.pcss ? 1 : 0, shadowBox.range, 0, dv);
    /*@lab*/ if (u.uCstCut) gl.uniform1f(u.uCstCut, R.p("coastCut")); /*@end*/
    if (u.uLightVP) gl.uniformMatrix4fv(u.uLightVP, false, R.coast.shadowVP);
    if (u.uShipVP) gl.uniformMatrix4fv(u.uShipVP, false, shipVP);
    if (u.uShad) gl.uniform4f(u.uShad, 0, 0, 0, 0);
    if (u.uFan) { gl.uniform4f(u.uFan, NC, C.FAN.r0, Math.log(C.FAN.ratio), C.FAN.step * D); gl.uniform1f(u.uFanA0, C.FAN.a0 * D); }
    if (u.uTile) gl.uniform4fv(u.uTile, TILE);
    if (u.uTerT) gl.uniform4f(u.uTerT, 1, 0, 0, 0);
    if (u.uRockTint) { gl.uniform3fv(u.uRockTint, C.TINT.terrainRock); gl.uniform3fv(u.uWetTint, C.TINT.terrainWet); }
    if (u.uProj) gl.uniform4f(u.uProj, R.cam.near, R.cam.far, cacheJ[0], cacheJ[1]);
    if (u.uShipM) gl.uniform4fv(u.uShipM, shipM);
  }
  function bindPrivate(R, ta) {
    const gl = R.gl;
    /* every unit a draw binds for itself is cleared first: a texture made between frames (a resize) is left bound
       on whatever unit was active, and a depth texture on a sampler2D unit fails the draw */
    tex2(gl, UNIT.base, null); tex2(gl, UNIT.nrm, null); tex2(gl, UNIT.orm, null);
    tex2(gl, UNIT.g0, null); tex2(gl, UNIT.g1, null); tex2(gl, UNIT.gz, null);
    tex2(gl, UNIT.open, open); tex2(gl, UNIT.hgt, hgt);
    if (ta) { texA(gl, UNIT.albA, ta.albedo); texA(gl, UNIT.nrmA, ta.normal); texA(gl, UNIT.ormA, ta.ormh); }
    tex2(gl, UNIT.raw, shadow); gl.bindSampler(UNIT.raw, rawSampler);
    tex2(gl, UNIT.shipZ, shipZ || shadow);
  }
  function unbindPrivate(R) { const gl = R.gl; gl.bindSampler(UNIT.raw, null); for (const k of [UNIT.g0, UNIT.g1, UNIT.gz]) tex2(gl, k, null); gl.activeTexture(gl.TEXTURE0); }

  /* ── the one-time bakes, a step per frame after the view is up (each well under 3 ms of GPU) ── */
  function bake(R) {
    const gl = R.gl, G = R.gpu;
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    const box = [B[0], B[1], 1 / (B[2] - B[0]), 1 / (B[3] - B[1])];
    if (ph === 1) {                           // the heightfield: WX.COVE.height on the GPU
      if (!P.hgt.ready()) return;
      if (!hgt) { hgt = G.tex2D(HGTW, HGT, "r16f", {}); hgtFb = G.fbo([hgt]); /*@lab*/ R.debugTex("coast.hgt", hgt, "raw"); /*@end*/ }
      const rid = new Float32Array(52); let o = 0;
      for (const pts of C.heads) for (const p of pts) { rid.set(p, o); o += 4; }
      const u = bindUnits(gl, P.hgt);
      gl.uniform4fv(u.uBox, box); gl.uniform4fv(u.uRidge, rid);
      R.bind(hgtFb); G.fullscreen();
      ph = 2; return;
    }
    if (ph === 2) {                           // the sky openness, in four tiles
      if (!P.open.ready()) return;
      if (!open) { open = G.tex2D(OPEN, OPEN, "rgba8", {}); openFb = G.fbo([open]); /*@lab*/ R.debugTex("coast.open", open, "raw"); /*@end*/ openTile = 0; }
      const u = bindUnits(gl, P.open);
      gl.uniform4fv(u.uBox, box);
      tex2(gl, UNIT.hgt, hgt);
      R.bind(openFb);
      const h = OPEN / 4;
      gl.enable(gl.SCISSOR_TEST); gl.scissor(0, openTile * h, OPEN, h);
      G.fullscreen();
      gl.disable(gl.SCISSOR_TEST);
      if (++openTile >= 4) ph = 3;
      return;
    }
    if (ph === 3) {                           // the fan's quads, read back to split land and shallow bed
      if (!P.fanCls.ready()) return;
      fanCls = G.tex2D(NC - 1, NR - 1, "r32f", { filter: "nearest" }); fanClsFb = G.fbo([fanCls]);
      const u = bindUnits(gl, P.fanCls);
      gl.uniform4fv(u.uBox, box); gl.uniform4f(u.uFan, NC, C.FAN.r0, Math.log(C.FAN.ratio), C.FAN.step * D); gl.uniform1f(u.uFanA0, C.FAN.a0 * D);
      tex2(gl, UNIT.hgt, hgt);
      R.bind(fanClsFb); G.fullscreen();
      if (!G.readback(fanClsFb.fb, 0, 0, NC - 1, NR - 1, (px) => { readbackPending = false; buildTerrain(R, px); })) return;
      readbackPending = true;
      ph = 4; return;
    }
    if (ph === 4) { if (!readbackPending) ph = 5; return; }
    if (ph === 5) {                           // the shore field: top heights (+ the rock meshes that are in)
      if (!P.shTop0.ready() || !P.shTopM.ready()) return;
      if (!shTop) {
        shTop = G.tex2D(SHN, SHN, "rgba16f", {}); shTopDepth = G.depthRB(SHN, SHN); shTopFb = G.fbo([shTop], shTopDepth);
        for (let k = 0; k < 2; k++) { shSeed[k] = G.tex2D(SHN, SHN, "rg32f", { filter: "nearest" }); shSeedFb[k] = G.fbo([shSeed[k]]); }
      }
      if (!shore) { shore = G.tex2D(SHN, SHN, "rgba16f", {}); shoreFb = G.fbo([shore]); }
      R.bind(shTopFb);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.ALWAYS); gl.depthMask(true);
      let u = bindUnits(gl, P.shTop0);
      gl.uniform4fv(u.uBox, box); tex2(gl, UNIT.hgt, hgt);
      G.fullscreen();
      gl.depthFunc(gl.LESS);
      u = uloc(P.shTopM); gl.useProgram(P.shTopM.prog);
      let n = 0;
      for (const g of geo) {
        const its = g.its.filter((it) => ROCKY.test(it.role));
        if (!its.length) continue;
        const a = man.models.find((m) => m.id === g.id), m = loader.mesh(g.id, Math.max(...a.lods.map((l) => l.lod)));
        if (!m) continue;
        n++;
        const inst = new Float32Array(its.length * 16);
        its.forEach((it, k) => rowOf(it, inst, k * 16));
        const ib = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, ib); gl.bufferData(gl.ARRAY_BUFFER, inst, gl.STATIC_DRAW);
        for (const part of m.parts) for (const pr of part.prims) {
          const vao = vaoFor(gl, pr, ib);
          gl.uniformMatrix4fv(u.uNode, false, mul4(g.axis, part.xform)); gl.uniform4f(u.uNodeC, 0, 0, 0, 0);
          gl.bindVertexArray(vao);
          gl.drawElementsInstanced(pr.mode, pr.count, pr.type, pr.offset, its.length);
          gl.bindVertexArray(null);
        }
        gl.deleteBuffer(ib);
      }
      gl.disable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
      shoreMeshes = n > 0;
      ph = 6; return;
    }
    if (ph === 6) {                           // the waterline's seeds
      if (!P.shSeed.ready() || !P.shJfa.ready() || !P.shFin.ready()) return;
      bindUnits(gl, P.shSeed);
      tex2(gl, UNIT.base, shTop);
      R.bind(shSeedFb[0]); G.fullscreen();
      jfaK = 0; ph = 7; return;
    }
    if (ph === 7) {                           // the jump flood: 256 .. 1, then 1 again, five passes a frame
      const u = bindUnits(gl, P.shJfa);
      for (let k = 0; k < 5 && jfaK < JFA.length; k++, jfaK++) {
        tex2(gl, UNIT.nrm, shSeed[0]);
        gl.uniform1i(u.uStep, JFA[jfaK]);
        R.bind(shSeedFb[1]); G.fullscreen();
        tex2(gl, UNIT.nrm, null);
        [shSeed[0], shSeed[1]] = [shSeed[1], shSeed[0]]; [shSeedFb[0], shSeedFb[1]] = [shSeedFb[1], shSeedFb[0]];
      }
      if (jfaK >= JFA.length) ph = 8;
      return;
    }
    if (ph === 8) {                           // SHORE
      const u = bindUnits(gl, P.shFin);
      tex2(gl, UNIT.base, shTop); tex2(gl, UNIT.nrm, shSeed[0]);
      gl.uniform2f(u.uSwellFrom, Math.sin(10 * D), Math.cos(10 * D));
      R.bind(shoreFb); G.fullscreen();
      tex2(gl, UNIT.base, null); tex2(gl, UNIT.nrm, null);
      R.provide("SHORE", shore);
      R.coast.shoreStamp++;                   // [1.2] a reader that derives something from SHORE reads it again
      /*@lab*/ R.debugTex("SHORE", shore, "raw"); /*@end*/
      /* the bake's temporaries go (a second bake, with the rock meshes, makes them again) */
      gl.deleteTexture(shTop.tex); gl.deleteRenderbuffer(shTopDepth); gl.deleteFramebuffer(shTopFb.fb);
      for (let k = 0; k < 2; k++) { gl.deleteTexture(shSeed[k].tex); gl.deleteFramebuffer(shSeedFb[k].fb); }
      shTop = shTopFb = shTopDepth = null; shSeed = [null, null]; shSeedFb = [null, null];
      ph = 9; return;
    }
  }
  /* the terrain fan's index buffer from the read-back quad heights: land (any corner above -0.5 m) drawn in the
     view, the mirror and the shadow map; the shallow bed (down to BED) in the view only; deeper never */
  function buildTerrain(R, px) {
    const gl = R.gl;
    if (gl.isContextLost()) return;
    /* in chunks of rings small enough for 16-bit indices (the vertex shader adds each chunk's first vertex) */
    const K = Math.floor(65536 / NC) - 1, NQ = (NC - 1) * (NR - 1);
    let n = 0;
    for (let q = 0; q < NQ; q++) if (px[q * 4] > BED) n++;
    const idx = new Uint16Array(n * 6), chunks = [];
    let o = 0;
    for (let c0 = 0; c0 < NR - 1; c0 += K) {
      const base = c0 * NC, ch = { base, off: o, land: 0, bed: 0 };
      for (const pass of [0, 1]) {
        for (let i = c0; i < Math.min(c0 + K, NR - 1); i++) for (let j = 0; j < NC - 1; j++) {
          const h = px[(i * (NC - 1) + j) * 4];
          if (h <= BED || (pass === 0) !== (h > -0.5)) continue;
          const v0 = i * NC + j - base, v1 = v0 + 1, v2 = v0 + NC, v3 = v2 + 1;
          idx[o++] = v0; idx[o++] = v2; idx[o++] = v1; idx[o++] = v1; idx[o++] = v2; idx[o++] = v3;
          if (pass === 0) ch.land += 6; else ch.bed += 6;
        }
      }
      if (ch.land + ch.bed) chunks.push(ch);
    }
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const eb = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, eb); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    terrain = { vao, eb, chunks, tris: n * 2 };
    terrain.bytes = idx.byteLength;
    if (fanCls) { gl.deleteTexture(fanCls.tex); gl.deleteFramebuffer(fanClsFb.fb); fanCls = fanClsFb = null; }
  }

  /* ── targets that follow the size and the tier ── */
  function sizeTargets(R) {
    const gl = R.gl, G = R.gpu, kn = R.knobs, [w, h] = R.size.S;
    const div = kn.coastRefl || 2, mw = Math.max(16, Math.round(w / div)), mh = Math.max(16, Math.round(h / div));
    if (mirror) { gl.deleteTexture(mirror.tex); gl.deleteFramebuffer(mirrorFb.fb); gl.deleteRenderbuffer(mirrorDepth); }
    mirror = G.tex2D(mw, mh, "rgba16f", { mips: true, aniso: 8 });   // [r5] the sea's lookup is tall and narrow (wxCoastRefl), at most 8:1
    mirrorDepth = G.depthRB(mw, mh);
    mirrorFb = G.fbo([mirror], mirrorDepth);
    R.provide("COASTREFL", mirror);
    /*@lab*/ R.debugTex("COASTREFL", mirror, "hdr"); /*@end*/
    if (lastTier !== R.tier || !shadow) {
      makeShadow(R);
      if (shipZ) { gl.deleteTexture(shipZ.tex); gl.deleteFramebuffer(shipZFb.fb); shipZ = shipZFb = null; }
      /* the ship's own map: 512 at most (9 cm texels over the 48 m box; the ship is ~100 px wide at 1080p) */
      if (kn.shipShadow) { const z = Math.min(kn.shipShadow, 512); shipZ = G.tex2D(z, z, "depth16", { compare: true }); shipZFb = G.fbo([], shipZ); }
      lightAge = 1e9; lastTier = R.tier;
    }
    /* the static-cove cache: albedo + porosity (sRGB), normal + roughness + AO, depth; and the mirror's */
    const mk = (cw, ch) => {
      const g0 = G.tex2D(cw, ch, "srgba8", { filter: "nearest" }), g1 = G.tex2D(cw, ch, "rgba8", { filter: "nearest" }), z = G.tex2D(cw, ch, "depth24", { filter: "nearest" });
      return { g0, g1, z, fb: G.fbo([g0, g1], z), w: cw, h: ch };
    };
    const kill = (c) => { if (c) { gl.deleteTexture(c.g0.tex); gl.deleteTexture(c.g1.tex); gl.deleteTexture(c.z.tex); gl.deleteFramebuffer(c.fb.fb); } };
    kill(cache); kill(mcache); cache = mcache = null;
    const useC = R.p("coastCache") > 0 || (R.p("coastCache") < 0 && R.tier < 3);
    if (useC) { cache = mk(w, h); mcache = mk(mw, mh); /*@lab*/ R.debugTex("coast.g0", cache.g0, "raw"); R.debugTex("coast.g1", cache.g1, "raw"); /*@end*/ }
    cacheValid = false; cacheStamp = -1; mirrorStale = true; cacheAt = -1e9;
    tally(R);
  }
  function makeShadow(R) {
    const gl = R.gl, G = R.gpu, sp = R.knobs.shadow || 1536, sh = shadowBox.shape || [sp, sp];
    if (shadow) { gl.deleteTexture(shadow.tex); gl.deleteFramebuffer(shadowFb.fb); }
    shadow = G.tex2D(sh[0], sh[1], "depth16", { compare: true });
    shadowFb = G.fbo([], shadow);
    shadowDrawn = false; redraw = true;
    R.provide("SUNSHADOW", shadow);
    /*@lab*/ R.debugTex("SUNSHADOW", shadow, "r"); /*@end*/     // [1.2] the core's viewer samples depth with a compare-off sampler
  }
  /* R.coast.mem (bytes): textures and meshes from the loader, targets from here (WebGL reports none) */
  function tally(R) {
    const w = R.size.S[0], h = R.size.S[1], mw = mirror ? mirror.w : 0, mh = mirror ? mirror.h : 0, ss = shipZ ? shipZ.w : 0;
    /* (SCENEZ is the core's target, allocated with or without a cove: not counted here) */
    mem.targets = HGTW * HGT * 2 + OPEN * OPEN * 4 + (shore ? SHN * SHN * 8 : 0) + (shTop ? SHN * SHN * (8 + 4 + 16) : 0) + (shadow ? shadow.w * shadow.h * 2 : 0) + ss * ss * 2
      + Math.round((mw * mh * 8 * 4) / 3) + mw * mh * 4 + (cache ? (w * h + mw * mh) * 12 : 0);
    mem.tex = loader ? loader.progress.mem.tex : 0;
    mem.mesh = (loader ? loader.progress.mem.mesh : 0) + (terrain ? terrain.bytes : 0);
    R.coast.mem = mem;
  }

  /* ── the pass ── */
  return {
    name: "coast",
    *build(R) {
      /* a new context: forget every GL object the last one held */
      P = {}; uniformsOf = new Map(); hgt = hgtFb = open = openFb = fanCls = fanClsFb = terrain = null;
      shTop = shTopFb = shTopDepth = null; shSeed = [null, null]; shSeedFb = [null, null]; shore = shoreFb = null; shoreMeshes = false; rebaked = false;
      shadow = shadowFb = shipZ = shipZFb = mirror = mirrorFb = mirrorDepth = cache = mcache = probe = probeFb = probes = probeFbs = null; shadowDrawn = false;
      geo = []; byId = {}; lists = null; listStamp = -1; bucketTier = -1; lastTier = -1; vaos = []; cable = null; mapAt.clear();
      lightDir = [0, 0, 0]; lightAge = 1e9; redraw = false; cacheValid = false; cacheStamp = -1; cacheAt = -1e9; ph = 0;
      upStart = -1; viewAt = -1; upOK = false; haveCove = false; readbackPending = false; man = null;
      R.coast.up = 0; R.coast.mem = mem;
      cpu.n = 0; start.view = start.rise = start.up = -1;
      /* lab: what the tests read (WXLAB.R.coast.lab()) */
      /*@lab*/
      R.coast.lab = () => {
        const a = Array.from(cpu.ring.slice(0, Math.min(cpu.n, 240))).sort((x, y) => x - y);
        return { jsP50: a.length ? +a[a.length >> 1].toFixed(3) : null, jsP95: a.length ? +a[Math.floor(a.length * 0.95)].toFixed(3) : null,
                 startup: { rise: +start.rise.toFixed(2), up: +start.up.toFixed(2) }, maxUploadMs: loader ? +loader.progress.maxStepMs.toFixed(2) : null,
                 slowJobs: loader ? loader.progress.slow : null, stepPhases: loader ? loader.progress.phase : null,
                 path: R.coast.path, draws: R.coast.draws, mem: { tex: mem.tex, mesh: mem.mesh, targets: mem.targets, total: mem.tex + mem.mesh + mem.targets },
                 loading: loader ? { got: loader.progress.got, of: loader.progress.of, failed: loader.progress.failed } : null };
      };
      /*@end*/
      const gl = R.gl;
      rawSampler = gl.createSampler();
      gl.samplerParameteri(rawSampler, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.samplerParameteri(rawSampler, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.samplerParameteri(rawSampler, gl.TEXTURE_COMPARE_MODE, gl.NONE);
      gl.samplerParameteri(rawSampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.samplerParameteri(rawSampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      programs(R);
      /* [r3] the lamps' sprites stay within the point size the context allows (WebGL2 only promises 1) */
      { const r = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE); maxPoint = Math.max(1, Math.min(96, r ? r[1] : 1)); }
      /* the manifest, then everything else from the slot, after the view is up (the loader caches in HTTP) */
      loader = WX.assets.loader(WX.ASSETS.base);
      const L = loader;
      loader.manifest().then((m) => { if (L !== loader) return; man = m; ph = m ? -1 : -2; });
      C.items.forEach((it) => { (byId[it.id] = byId[it.id] || []).push(it); });
      yield;
    },
    resize(R) { if (haveCove) { sizeTargets(R); bucketize(R); } },
    ubo(F, R, set) {
      const c = R.coast, t = F.t.ocean;
      /* the cove's presence: 0 until the coarse set and the bakes are in (or 6 s after the view, with whatever
         came), then up over 2 s; a wall-clock fade, so a frozen scene clock still sees the cove arrive */
      const w = now();
      if (viewAt < 0 && R.ready) viewAt = w;
      if (upStart < 0 && haveCove && ph >= 9 && terrain && P.mesh.ready() && P.ter.ready() && (upOK || w - viewAt > 6)) upStart = w;
      c.up = upStart < 0 ? 0 : U.clamp((w - upStart) / 2, 0, 1);
      /*@lab*/
      if (start.view < 0 && viewAt >= 0) start.view = viewAt;
      if (start.rise < 0 && upStart >= 0) start.rise = upStart - viewAt;
      if (start.up < 0 && c.up >= 1) start.up = w - viewAt;
      /*@end*/
      const sunEl = Math.asin(U.clamp(F.sun.dir[1], -1, 1));
      /* [r2] below T3 they stay cached in thick rain (visibility under 3.5 km, from about 91 %): at 600-1400 m the
         rain's medium hides their 1-2 px of bend there, and drawing them forward costs Intel T2 about 0.1 ms */
      const wind = F.W.U10, seen = R.tier >= 3 || F.W.vis > (treesDyn ? 3.3 : 3.5);
      const want = seen && (treesDyn ? wind > 12.5 : wind > 14);      // the reading's wind, not its gusts
      if (want !== treesDyn) { treesDyn = want; bucketTier = -1; }      // re-bucketed (and the cache remade) in the slot
      /* [r3] lit from sunset (the anchor light's rule: sunset to sunrise), fully by -2 deg: at blue hour they burn */
      c.lights = haveCove ? 1 - U.smooth(-2 * D, 1 * D, sunEl) : 0;
      const wn = F.wind && F.wind.wind;
      poseAt(t, F.W.U10);
      if (SHIPI) shipMotion(t, F.W.U10, wn ? wn.U10 : F.W.U10, wn ? wn.dir[0] : 0, wn ? wn.dir[1] : 1, pose.yaw);
      if (SHIPI && haveCove) {
        const a = pose.yaw * D, fx = Math.sin(a), fz = Math.cos(a), pr = c.probes;
        /* the waterplane: the hull's centre 2.15 m forward of the mesh origin */
        const cx = pose.x + fx * SHIP.cx, cz = pose.z + fz * SHIP.cx;
        shipC[0] = cx; shipC[1] = 15; shipC[2] = cz;
        c.ship.pos[0] = cx; c.ship.pos[1] = 0; c.ship.pos[2] = cz;
        c.ship.yaw = a; c.ship.halfL = SHIP.halfL; c.ship.halfB = SHIP.halfB; c.ship.draft = SHIP.draft; c.ship.on = c.up > 0 ? 1 : 0;
        /* probes 0-3: bow and stern 13 m out (radius 6), port and starboard 3.5 m (radius 3) */
        pr[0] = cx + fx * 13; pr[1] = cz + fz * 13; pr[2] = 6; pr[3] = 1;
        pr[4] = cx - fx * 13; pr[5] = cz - fz * 13; pr[6] = 6; pr[7] = 1;
        pr[8] = cx - fz * 3.5; pr[9] = cz + fx * 3.5; pr[10] = 3; pr[11] = 1;
        pr[12] = cx + fz * 3.5; pr[13] = cz - fx * 3.5; pr[14] = 3; pr[15] = 1;
      } else c.ship.on = 0;
      if (BUOYI && haveCove) {
        const a = pose.byaw * D, fx = Math.sin(a) * 1.2, fz = Math.cos(a) * 1.2, pr = c.probes;
        pr[16] = pose.bx + fx; pr[17] = pose.bz + fz; pr[18] = 1.5; pr[19] = 1;
        pr[20] = pose.bx - fx; pr[21] = pose.bz - fz; pr[22] = 1.5; pr[23] = 1;
        pr[24] = pose.bx - fz; pr[25] = pose.bz + fx; pr[26] = 1.5; pr[27] = 1;
        pr[28] = pose.bx + fz; pr[29] = pose.bz - fx; pr[30] = 1.5; pr[31] = 1;
      }
      /* [r3] probes 8..15: the water 3 m off the near rocks' faces toward the swell (it comes from 10 deg right of the
         view), radius 2 m: the sea's height there, the crest that will hit the rock, feeds the white water a crest
         leaves running off it. (The footprint's extent toward the swell from the yawed box; the spray points stand
         on the rock itself) */
      if (haveCove && !washP[3]) {
        let j = 0;
        const ux = Math.sin(10 * D), uz = Math.cos(10 * D);
        for (const x of C.items) {
          if (j >= 8 || !/rocks|platform/.test(x.role) || Math.abs(x.pos[0]) > 170 || x.pos[2] > 210) continue;
          const c = Math.cos(x.yaw * D), sn = Math.sin(x.yaw * D), st = x.stretch || [1, 1, 1];
          const ext = x.half[0] * x.scale * st[0] * Math.abs(c * ux - sn * uz) + x.half[2] * x.scale * st[2] * Math.abs(sn * ux + c * uz);
          washP[j * 4] = x.pos[0] + ux * (ext + 3); washP[j * 4 + 1] = x.pos[2] + uz * (ext + 3); washP[j * 4 + 3] = 1; j++;
        }
      }
      for (let j = 0; j < 8; j++) {
        const o = 32 + j * 4;
        c.probes[o] = washP[j * 4]; c.probes[o + 1] = washP[j * 4 + 1]; c.probes[o + 2] = 2; c.probes[o + 3] = haveCove ? washP[j * 4 + 3] : 0;
      }
      c.nProbes = haveCove ? 16 : 0;
      /* spray points: the rocks' feet that face the swell (it comes from 10 deg right of the view) */
      if (!c.nSpray && haveCove) {
        let ns = 0;
        const sx = Math.sin(10 * D), sz = Math.cos(10 * D);
        for (const x of C.items) {
          if (ns >= WX.SPRAYS || !/reef|stack|rocks|platform|point/.test(x.role + x.name)) continue;
          if (x.role === "cliff" && !/point/.test(x.name)) continue;
          /* [r2] the near shelf's rocks (under 200 m) face the swell across the bay: 0.8 (round 1: 0.6) */
          /* [r3] 0.45 on the near shelf: 60-130 m from the window, round 2's 0.8 threw 25 m plumes that filled the left
             third of the view like smoke; low rocks there throw 8-14 m */
          const near = Math.hypot(x.pos[0], x.pos[2]) < 200;
          const w = x.name in NEAR_SPRAY ? NEAR_SPRAY[x.name] : near ? 0 : x.role === "reef" ? 1 : x.role === "stack" ? 0.9 : 0.6;
          if (!(w > 0)) continue;
          /* [r4] the point on the rock's own face toward the swell (its stretched, yawed footprint), not its middle */
          const cy = Math.cos(x.yaw * D), sy = Math.sin(x.yaw * D), st = x.stretch || [1, 1, 1];
          const ext = x.half[0] * x.scale * st[0] * Math.abs(cy * sx - sy * sz) + x.half[2] * x.scale * st[2] * Math.abs(sy * sx + cy * sz);
          const r = near ? 0.8 * ext : Math.min(x.half[0], x.half[2]) * x.scale * 0.8;
          c.spray[ns * 4] = x.pos[0] + sx * r; c.spray[ns * 4 + 1] = 0.5; c.spray[ns * 4 + 2] = x.pos[2] + sz * r;
          c.spray[ns * 4 + 3] = w; ns++;
        }
        c.nSpray = ns;
      }
      /* the night lights: R.coast.lamps for the ocean's glints (intensity rel, before the exposure), and uF0/uF1 for
         this pass (pre-exposed): the anchor light's radiance as a 2.5 px point, the lantern's intensity on the deck.
         [r3] R.coast.lamps holds four: 0 the anchor light, 1 the pier lantern (as the contract has them), 2 the stern
         lantern and 3 the two stern windows as one (2.2 m apart: 5 px at 400 m); a reader of the first two is unchanged */
      if (c.lamps.length < 16) c.lamps = new Float32Array(16);
      const li = c.lights * c.up, E = R.exposure.E, a = pose.yaw * D, fx = Math.sin(a), fz = Math.cos(a);
      const ax = pose.x + fx * SHIP.light[0], az = pose.z + fz * SHIP.light[0];
      const fl = 1 + 0.05 * Math.sin((2 * Math.PI * F.t.rain) / 1.875) * Math.sin((2 * Math.PI * F.t.rain) / 0.46875 + 1.3);
      c.lamps[0] = ax; c.lamps[1] = SHIP.light[1]; c.lamps[2] = az; c.lamps[3] = SHIPI ? 3e-4 * li : 0;
      if (LAMPI) { c.lamps[4] = LAMPI.pos[0]; c.lamps[5] = LAMPI.pos[1] + 0.75; c.lamps[6] = LAMPI.pos[2]; c.lamps[7] = 2.5e-4 * li * fl; }
      set("uF0", ax, SHIP.light[1], az, SHIPI ? 1.2e-4 * li * E : 0);
      /* [r3] each point's flux on the image: I / d^2 x E over the solid angle of a pixel (ppr: px per radian at
         the centre); the core's sigma from its size (at least 0.55 px: under a pixel it is the image's own
         blur), the aureole's lambda 0.15 deg in clear air to 0.45 in thick rain (its share grows on the GPU from
         the air's and the rain's transmittance), the sprite out to 5 lambda */
      const ppr = R.size.S[1] / (2 * R.cam.tanY), vis = Math.max(F.W.vis || 30, 0.2);
      const dShip = Math.hypot(pose.x, 15 - WX.EYE_M, pose.z) || 400;
      for (let k = 0; k < SHIPLAMPS.length; k++) {
        const L = SHIPLAMPS[k], f = 1 + 0.08 * L.fl * Math.sin((2 * Math.PI * F.t.rain) / 0.9375 + k) * Math.sin((2 * Math.PI * F.t.rain) / 0.3 + 2 * k);
        let x, y, z;
        if (L.world) { if (!LAMPI) { lampC[k][3] = 0; continue; } x = LAMPI.pos[0]; y = LAMPI.pos[1] + 0.75; z = LAMPI.pos[2]; }
        else { x = pose.x + fx * L.p[0] + fz * L.p[2]; y = L.p[1]; z = pose.z + fz * L.p[0] - fx * L.p[2]; }
        const d = Math.max(Math.hypot(x, y - WX.EYE_M, z), 20), Te = Math.exp((-3.912 * d) / (1000 * vis));
        const v = (L.world ? LAMPI : SHIPI) ? (L.i * li * E * f * ppr * ppr) / (d * d) : 0;
        lampC[k][0] = L.rgb[0] * v; lampC[k][1] = L.rgb[1] * v; lampC[k][2] = L.rgb[2] * v; lampC[k][3] = v > 0 ? 1 : 0;
        const lam = ppr * D * (0.1 + 0.15 * (1 - Te)), sc = ppr / 879;
        lampK[k][0] = Math.max(0.55, (0.4 * L.size * ppr) / d); lampK[k][1] = lam; lampK[k][2] = 0.04; lampK[k][3] = L.core;
        lampG[k] = 0.5 + 1.0 * (1 - Te);                 // the aureole's soft ceiling: brighter in thick air
        lampS[k] = Math.min(2 * Math.ceil(Math.min(lam * Math.log(lampG[k] / 0.003) + 1.5, 16 * sc) + 1), maxPoint); lampM[k] = d / dShip;
        /*@lab*/ lampG[k] *= Math.max(R.p("coastHalo"), 1e-4); /*@end*/     // [r5] lab: the near aureole scaled (0 off; after the sprite's size), against C's glare
        if (k >= 1 && k <= 3 && !L.world) {      // the stern lantern, and the windows' pair as one
          const o = k === 1 ? 8 : 12, w = SHIPI ? L.i * li * f : 0;
          if (k === 3) { c.lamps[12] = (c.lamps[12] + x) / 2; c.lamps[13] = y; c.lamps[14] = (c.lamps[14] + z) / 2; c.lamps[15] += w; }
          else { c.lamps[o] = x; c.lamps[o + 1] = y; c.lamps[o + 2] = z; c.lamps[o + 3] = w; }
        }
      }
      if (!SHIPI) c.lamps[11] = c.lamps[15] = 0;
      set("uF1", c.lamps[4], c.lamps[5], c.lamps[6], 1.6e-4 * li * fl * E);
      /* the key light's shadow: redrawn when the light moved by more than 0.05 deg, the tier changed, or the
         arrived set changed (at most every 2 s); faded below the horizon, under a closed deck and across the
         sun-to-moon switch at -6 deg (over -5 .. -7) */
      const key = sunEl > -6 * D ? F.sun.dir : F.moon.dir;
      const moved = Math.acos(Math.min(1, key[0] * lightDir[0] + key[1] * lightDir[1] + key[2] * lightDir[2])) > 0.05 * D;
      const stamp = loader ? loader.progress.stamp : 0;
      if (moved || lightAge > 1e8 || (stamp !== lastShadowStamp && lightAge > 120)) {
        const lm = lightMatrix(key, c.shadowVP);
        shadowBox.range = lm.range; shadowBox.ex = lm.ex; shadowBox.ey = lm.ey;
        shadowBox.shape = shadowShape(lm.ex, lm.ey, R.knobs.shadow || 1536);
        c.shadow[1] = Math.max(lm.ex / shadowBox.shape[0], lm.ey / shadowBox.shape[1]);
        lightDir = key.slice(); lightAge = 0; redraw = true; lastShadowStamp = stamp;
      } else lightAge++;
      if (SHIPI) shipMatrix(key, pose.x + Math.sin(a) * SHIP.cx, pose.z + Math.cos(a) * SHIP.cx, shipVP);
      c.shadow[0] = shadowDrawn && haveCove ? 1 : 0; c.shadow[2] = key === F.sun.dir ? WX.SUN_RADIUS : F.moon.radius;
      const sw = U.clamp(Math.abs(sunEl / D + 6), 0, 1);
      c.shadow[3] = U.smooth(-0.017, 0.009, key[1]) * (1 - 0.8 * U.smooth(0.85, 1, F.W.cov)) * sw;
    },
    slots: {
      coast(R, F) {
        let t0 = 0; /*@lab*/ t0 = performance.now(); /*@end*/
        slot(R, F);
        /*@lab*/ cpu.ring[cpu.n++ % 240] = performance.now() - t0; /*@end*/
      },
    },
  };
  function slot(R, F) {
        const gl = R.gl;
        if (ph === -2 || ph === 0) return;            // no manifest (or not yet): the open sea, nothing said
        if (ph === -1) {
          /* the manifest is in: queue the files, staged (coarsest LODs; base colours and terrain; finer LODs; maps) */
          const ids = Object.keys(byId).filter((id) => man.models.some((m) => m.id === id));
          if (!ids.length) { ph = -2; return; }
          const pxOf = {}, lods = {};
          /* each asset's largest on-screen extent at 1080p (vFOV 50 deg: 1237 px per radian), over the instances a
             window up to 21:9 can show; the loader decodes at 2 texels per such pixel (4 at T3-T4), never under 128 */
          for (const it of C.items) {
            if (Math.abs(Math.atan2(it.pos[0], it.pos[2])) > 50 * D) continue;
            const ext = Math.max(...it.half) * 2 * it.scale, d = Math.max(20, Math.hypot(it.pos[0], it.pos[2]));
            pxOf[it.id] = Math.max(pxOf[it.id] || 0, (ext / d) * 1237);
          }
          for (const id of ids) {
            const a = man.models.find((m) => m.id === id), have = a.lods.map((l) => l.lod), want = new Set([Math.max(...have)]);
            for (const it of byId[id]) for (let t = 0; t < 5; t++) { const l = it.lod[t]; want.add(have.includes(l) ? l : have.reduce((p, q) => (Math.abs(q - l) < Math.abs(p - l) ? q : p))); }
            lods[id] = [...want];
            geo.push({ id, its: byId[id], meshH: C.DIM[id][1], axis: yawM(C.AXIS[id] || 0), buckets: [] });
          }
          loader.want(ids, { texPx: R.knobs.texPx, tier: R.tier, lods, px: pxOf, metal: ["wooden_lantern_01"], terrainArrays: true,
            terrainPx: 256, matScale: { dutch_ship_large_01: { rigging: 0.5, sails: 0.5 } }, wires: { dutch_ship_large_01: ["rigging"] } });
          haveCove = true;
          sizeTargets(R);
          bucketize(R);
          ph = 1;
        }
        loader.step(R, 2);
        if (ph >= 1 && ph < 9) { bake(R); return; }
        /* the shore field again once the rock meshes' coarse LODs are in, before the cove rises */
        if (!shoreMeshes && !rebaked && upStart < 0 && loader.progress.stage >= 1) { rebaked = true; ph = 5; return; }
        const ta = loader.terrainArrays();
        if (!upOK && loader.progress.stage >= 2 && ta) upOK = true;
        if (!terrain || R.coast.up <= 0) return;
        for (let k = 0; k < VIEWP.length; k++) if (!P[VIEWP[k]].ready()) return;
        if (bucketTier === -1 && haveCove) bucketize(R);
        else if (bucketTier !== R.tier) { sizeTargets(R); bucketize(R); }
        if (ta && !TILE[0]) { const T = (L) => (ta.tile[L] ? ta.tile[L][0] : 15); TILE[0] = T("rock"); TILE[1] = T("cliff-top grass"); TILE[2] = T("sand and pebbles"); TILE[3] = T("wet rock"); }
        /* the moving pieces' instance rows */
        if (R.p("coastDyn")) for (const g of geo) for (const b of g.buckets) {
          if (!b.moving) continue;
          for (let k = 0; k < b.its.length; k++) rowOf(b.its[k], b.inst, k * 16);
          gl.bindBuffer(gl.ARRAY_BUFFER, b.ib); gl.bufferSubData(gl.ARRAY_BUFFER, 0, b.inst);
        }
        const stamp = (((loader.progress.stamp * 8 + R.tier) * 2 + (R.p("coastReal") ? 1 : 0)) * 2 + (R.p("coastMeshes") ? 1 : 0)) * 2 + (R.p("coastWires") ? 1 : 0);   // a number: no string a frame
        if (stamp !== listStamp || fadeEnds) { listStamp = stamp; buildLists(R); }
        else updateFades(now());
        R.coast.loading = loader.progress;
        const forward = !cache || R.coast.up < 1 || fadeActive || !ta;
        /* every texture made in the slot is made here, before the frame's units are bound: making one binds it
           to the active unit, and a depth texture left on the probe's unit failed every draw of that frame
           (and the cache rebuilt in it stayed empty) */
        if (shadow && shadowBox.shape && (shadow.w !== shadowBox.shape[0] || shadow.h !== shadowBox.shape[1])) makeShadow(R);
        /* the light probe first (it reads nothing of ours) */
        /* [r3] two of them (32 x 1), alternating: texels 16..23 carry the rocks' wash holds from frame to frame */
        if (!probe) {
          gl.activeTexture(gl.TEXTURE0 + UNIT.aux);     // made on the scratch unit, never on one a program samples
          probes = [0, 1].map(() => R.gpu.tex2D(32, 1, "rgba16f", { filter: "nearest" })); probeFbs = probes.map((t) => R.gpu.fbo([t]));
          probe = probes[0]; probeFb = probeFbs[0]; probeCur = 0; washReset = true;
        }
        gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
        probeCur ^= 1; probe = probes[probeCur]; probeFb = probeFbs[probeCur];
        tex2(gl, UNIT.aux, probes[probeCur ^ 1]);
        { const pu = bindUnits(gl, P.probe); if (pu.uShipC) gl.uniform4f(pu.uShipC, shipC[0], shipC[1], shipC[2], SHIPI && haveCove ? 1 : 0);
          /* the water leaves a rock face at 0.15 m/s: slower than the sea falls behind a crest (2 m in 5 s), so a band
             of white water runs down the rock for a few seconds after each one */
          if (pu.uWashP) gl.uniform4fv(pu.uWashP, washP); if (pu.uWashK) gl.uniform4f(pu.uWashK, 0.15 * Math.min(F.dt || 1 / 60, 0.1), washReset ? 1 : 0, 0, 0); }
        washReset = false;
        R.draw(P.probe, probeFb);
        /*@lab*/ R.debugTex("coast.probe", probe, "hdr"); /*@end*/
        bindPrivate(R, ta);
        tex2(gl, UNIT.aux, probe);
        for (const k of VIEWP) common(R, P[k]);
        gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true); gl.disable(gl.BLEND);
        /* 1. the key light's shadow map, when it moved; the ship's own every world frame */
        /* (no texture may be sampled while it is drawn into: the maps leave their units for the moment) */
        const sunUnit = WX.TEX.SUNSHADOW.unit;
        tex2(gl, sunUnit, null); tex2(gl, UNIT.raw, null); tex2(gl, UNIT.shipZ, null);
        if (redraw && shadowFb && R.p("coastShadow")) {
          redraw = false; shadowDrawn = true;
          R.bind(shadowFb); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
          gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1.5, 2);
          drawTerrain(R, 1, "land");
          drawMeshes(R, P.mesh, lists[1].stat, 1);
          drawMeshes(R, P.dyn, lists[1].dyn, 1);
          gl.disable(gl.POLYGON_OFFSET_FILL);
        }
        /* the ship's own map: every world frame at T3-T4, every fourth one below (15 Hz: its motion is slow) */
        if (shipZFb && lists.ship1.length && R.p("coastShadow") && (R.tier >= 3 || (R.worldIndex & 3) === 0)) {
          R.bind(shipZFb); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
          gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1.5, 2);
          gl.useProgram(P.dyn.prog); gl.uniformMatrix4fv(uloc(P.dyn).uLightVP, false, shipVP);
          drawMeshes(R, P.dyn, lists.ship1, 1);
          gl.uniformMatrix4fv(uloc(P.dyn).uLightVP, false, R.coast.shadowVP);
          gl.disable(gl.POLYGON_OFFSET_FILL);
        }
        tex2(gl, sunUnit, shadow); tex2(gl, UNIT.raw, shadow); tex2(gl, UNIT.shipZ, shipZ || shadow);
        /* 2. the static-cove cache, remade when what it holds changed (at most twice a second) */
        const w = now();
        if (!forward && (!cacheValid || cacheStamp !== listStamp) && w - cacheAt > 0.5) {
          cacheAt = w; cacheStamp = listStamp; cacheValid = true;
          /* [1.2] the jitter it is drawn with this frame: the relight reconstructs through it */
          const jt = R.taa && R.taa.jitter; cacheJ[0] = jt ? jt[0] : 0; cacheJ[1] = jt ? jt[1] : 0;
          gl.useProgram(P.relight.prog); gl.uniform4f(uloc(P.relight).uProj, R.cam.near, R.cam.far, cacheJ[0], cacheJ[1]);
          for (const [c, mode] of [[cache, 3], [mcache, 4]]) {
            R.bind(c.fb); gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            drawTerrain(R, mode, mode === 4 ? "land" : "all");
            drawMeshes(R, P.mesh, lists[mode === 3 ? 0 : 2].stat, mode);
          }
        }
        const useCache = !forward && cacheValid;
        /* 3. the cove into SCENE + SCENEZ + depth */
        const target = R.target("coast");
        if (useCache) relight(R, cache, 0, target);
        else { R.bind(target); drawTerrain(R, 0, "all"); drawMeshes(R, P.mesh, lists[0].stat, 0); }
        if (R.p("coastDynDraw")) drawMeshes(R, P.dyn, lists[0].dyn, 0);
        drawLamp(R);
        /* 4. the thin wires */
        drawWires(R, lists.wire0, 0);
        /* 5. the mirror: every world frame at T3-T4; below, every fourth one, staggered from the ship's map (it holds
           the static cove and a ship that moves a few centimetres a frame, under waves that wobble it anyway) */
        mirrorDst.fb = mirrorFb.fb; mirrorDst.w = mirror.w; mirrorDst.h = mirror.h;
        /* [r3] below T3 every eighth world frame (round 2: every fourth): on Intel at T2 a mirror frame costs about
           0.5 ms (its relight, the ship and buoy drawn again, the mip chain of a 640 x 410 RGBA16F target); the ship's
           reflection under a wind-roughened sea moves smoothly enough at 7.5 Hz. Still staggered from the ship's map */
        const every = R.p("coastMirrorEvery") | 0, mirrorNow = R.tier >= 3 || (R.worldIndex % every) === 2 || mirrorStale;
        if (mirrorNow) {
        mirrorStale = false;
        R.bind(mirrorFb); gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        let mc = 0; /*@lab*/ mc = R.p("coastMirrorCut") | 0; /*@end*/
        if (R.p("coastMirror")) {
          if (useCache) { if (!(mc & 1)) relight(R, mcache, 4, mirrorDst); }
          else { drawTerrain(R, 2, "land"); drawMeshes(R, P.mesh, lists[2].stat, 2); }
          if (R.p("coastDynDraw") && !(mc & 2)) drawMeshes(R, P.dyn, lists[2].dyn, 2);
          if (R.tier >= 3) drawWires(R, lists.wire2, 2);
        }
        gl.disable(gl.DEPTH_TEST);
        if (!(mc & 4)) { gl.activeTexture(gl.TEXTURE0 + UNIT.aux); gl.bindTexture(gl.TEXTURE_2D, mirror.tex); gl.generateMipmap(gl.TEXTURE_2D); }
        gl.bindTexture(gl.TEXTURE_2D, null);
        }
        gl.disable(gl.DEPTH_TEST);
        unbindPrivate(R);
        R.coast.path = useCache ? "cache" : "forward";
        tally(R);
  }
})());
