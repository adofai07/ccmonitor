/* STUB coast (scenery stream F replaces passes/coast.js; this copy in stub/ stays frozen). v1.1.
   The coast slot draws the cove: the procedural headlands and seabed, and every placed piece of
   the layout WX.COVE at its true size, into SCENE + SCENEZ + depth; the key light's shadow map
   (SUNSHADOW); the cove's mirror image (COASTREFL); and, once at build, the shore field (SHORE).
   It provides the "coast" GLSL library and fills R.coast (the ship at anchor, the probes).
   Placeholder: flat-coloured proxies (rocks are displaced ellipsoids, the ship boxes, the pier
   modules beams and piles) instead of the Poly Haven meshes, unless weather/manifest.json lists
   them, when it draws the real meshes flat-shaded. Lambert light, cloud and sun shadows, ambient,
   aerial perspective, soak darkening; no textures, no PBR, no puddles (stream F's work).       */

/* ── The composition (DESIGN.md 13.1). World frame: metres, the eye at (0, 14, 0), +z the heading.
   Each item: the Poly Haven id, the mesh half-extents [x, y, z] in its own metres (Poly Haven's
   dimensions: x width, y height, z depth) and its base (lowest y), the placement (pos = where the
   mesh origin goes, yaw degrees from +z toward +x of the mesh's +z axis, uniform scale), the LOD
   per tier T0..T4 (0 finest), the texture size shipped and why the piece is there.            */
WX.COVE = (function () {
  /* ── noise, and the heightfield: headlands as ridges with flat tops and steep edges, a seabed
     that falls away to sea. The ridge tables are composition constants: x, z, top height m,
     half-width m, from the near end to the point. */
  const fract = (x) => x - Math.floor(x);
  const hash = (i, j) => fract(Math.sin(i * 127.1 + j * 311.7) * 43758.5453);
  const vnoise = (x, z) => {
    const i = Math.floor(x), j = Math.floor(z), u = x - i, v = z - j, su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
    const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
    return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
  };
  const fbm = (x, z, oct) => { let s = 0, w = 0.5, f = 1; for (let k = 0; k < oct; k++) { s += w * (vnoise(x * f, z * f) * 2 - 1); w *= 0.5; f *= 2.03; } return s; };
  const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const smax = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.max(a, b) + h * h * k * 0.25; };
  const heads = [
    /* the left head: high, its inner shore seen along its length, its point at -23 deg */
    [[-860, 120, 105, 360], [-760, 520, 112, 330], [-700, 860, 88, 220], [-640, 1110, 52, 125], [-600, 1260, 22, 60]],
    /* the right head: lower and farther, its point at +27 deg */
    [[900, 140, 82, 340], [850, 620, 78, 290], [800, 1000, 62, 200], [760, 1300, 34, 110], [740, 1420, 14, 55]],
    /* the land behind and under the window */
    [[-700, -110, 18, 170], [0, -150, 18, 175], [700, -110, 18, 170]],
  ];
  function ridge(pts, x, z) {
    let best = { d: 1e9, H: 0, w: 1 };
    for (let k = 0; k < pts.length - 1; k++) {
      const [x0, z0, h0, w0] = pts[k], [x1, z1, h1, w1] = pts[k + 1];
      const dx = x1 - x0, dz = z1 - z0, L2 = dx * dx + dz * dz;
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / L2));
      const px = x0 + dx * t, pz = z0 + dz * t, d = Math.hypot(x - px, z - pz);
      const w = w0 + (w1 - w0) * t;
      if (d / w < best.d / best.w) best = { d, H: h0 + (h1 - h0) * t, w };
    }
    return best;
  }
  function height(x, z) {
    let h = -(2.0 + 0.021 * Math.max(z, 0) + 0.004 * Math.abs(x));          // the bay deepens to sea: -10 m at 400 m, -23 at 1 km
    h = Math.max(h, -46);
    for (const pts of heads) {
      const r = ridge(pts, x, z);
      const wob = 1 + 0.14 * fbm(x / 140, z / 140, 3);                       // a ragged shoreline: points and inlets
      const q = r.d / (r.w * wob);
      const top = r.H * (1 - smoothstep(0.86, 1.0, q)) * (0.88 + 0.12 * fbm(x / 60 + 7, z / 60, 3)) + 3 * fbm(x / 23, z / 23, 2);
      const land = q < 1 ? top : -(r.d - r.w * wob) * 0.3 - 0.6;             // the foot falls 1:3 below the cliffs
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
  /* sizes (m) of the processed meshes (assets/out/manifest.json bboxM, glTF space, y up): [x, y, z, min y].
     The ship is listed bow along +z, as the layout's yaw means; its GLB has the bow along +x (AXIS). */
  const DIM = {
    coastal_cliff_01: [91.98, 10.33, 10.97, -0.65], coastal_cliff_02: [40.93, 10.05, 8.65, -0.23],
    coastal_cliff_04: [86.77, 11.0, 24.25, -0.65], coast_line_01: [54.61, 2.63, 42.96, -1.17],
    coast_line_02: [45.64, 2.29, 23.28, -0.59], coast_rocks_01: [59.51, 3.29, 42.52, -1.98],
    coast_rocks_02: [45.97, 3.17, 49.47, -0.92], coast_rocks_05: [4.04, 1.33, 3.75, -0.25],
    coast_land_rocks_02: [4.89, 1.4, 10.46, -0.16], coast_land_rocks_04: [9.96, 0.85, 11.5, -0.06],
    sand_rocks_small_01: [4.63, 0.54, 3.88, -0.1], rock_face_02: [2.71, 2.47, 2.13, -0.14],
    mountainside: [10.21, 10.52, 5.25, -0.2], dutch_ship_large_01: [8.39, 32.08, 34.25, -1.92],
    modular_wooden_pier: [3.1, 7.52, 19.03, -0.99], lateral_sea_marker: [3.0, 6.84, 3.0, -1.28],
    wooden_lantern_01: [0.22, 0.53, 0.24, -0.01], island_tree_01: [4.76, 5.03, 4.82, -0.02],
    shrub_04: [0.58, 0.22, 0.15, -0.01], fern_02: [1.97, 0.43, 1.72, -0.03], grass_medium_01: [5.6, 0.34, 0.33, -0.03],
  };
  const AXIS = { dutch_ship_large_01: -90 };
  const item = (name, id, role, pos, yaw, scale, lod, tex, why, extra) => {
    const d = DIM[id];
    return put(Object.assign({ name, id, role, pos, yaw, scale, half: [d[0] / 2, d[1] / 2, d[2] / 2], base: d[3], lod, tex, why }, extra || {}));
  };
  /* a cliff or ledge on a head's waterline, its face (+z of the mesh) seaward; setback in half-depths */
  const onShore = (name, id, role, hi, s, side, scale, y, setback, lod, tex, why) => {
    const p = shoreAt(hi, s, side), back = (DIM[id][2] / 2) * scale * setback;
    return item(name, id, role, [R1(p.x - p.nx * back), y, R1(p.z - p.nz * back)], R1(p.yaw), scale, lod, tex, why);
  };
  /* LOD per tier T0..T4 (0 finest), chosen against the manifest's px1At1080M (lab/tests/scenery/budget.cjs
     prints each one's p99 error in 1080p pixels): HF the headland cliffs, FAR everything at LOD 2,
     MID the reefs, NEAR the shelves and rocks near the window, HERO the ship */
  const HF = [2, 2, 2, 1, 1], HN = [2, 2, 1, 1, 1], FAR = [2, 2, 2, 2, 2], MID = [2, 2, 1, 1, 1], NEAR = [1, 1, 1, 1, 1], HERO = [1, 1, 0, 0, 0];
  const L2 = HF, LF = HF, L1 = NEAR, L0 = NEAR;
  /* the left head (cove side +1) */
  onShore("L-face", "mountainside", "cliff", 0, 0.75, 1, 6.5, -5, 0.5, HN, "512", "the left head's tallest face, at the left edge of 16:9 and wider views");
  onShore("L-cliff-1", "coastal_cliff_04", "cliff", 0, 1.3, 1, 4.2, -4, 0.55, HN, "1k", "the inner shore seen along its length; its strata catch the low sun");
  onShore("L-cliff-2", "coastal_cliff_01", "cliff", 0, 1.85, 1, 4.0, -4, 0.55, L2, "1k", "the cliff that frames the left edge of a 16:10 view");
  onShore("L-cliff-3", "coastal_cliff_04", "cliff", 0, 2.45, 1, 3.4, -4, 0.55, HN, "1k", "the run of cliff toward the point");
  onShore("L-point", "coastal_cliff_02", "cliff", 0, 3.05, 1, 3.6, -4, 0.55, LF, "512", "the point; winter sunsets go down just right of it");
  onShore("L-point-2", "coastal_cliff_02", "cliff", 0, 3.75, 1, 3.0, -4, 0.4, LF, "512", "the point's end, facing the viewer, backlit at sunset");
  onShore("L-ledge", "coast_line_01", "platform", 0, 1.6, 1, 1.6, -1.4, -0.45, FAR, "512", "the wave-cut platform at the cliff foot, where swash runs");
  onShore("L-boulders", "coast_land_rocks_04", "rocks", 0, 2.75, 1, 3.4, -0.7, -0.6, FAR, "512", "boulders at the foot: contact foam and splashes");
  { const p = shoreAt(0, 3.98, 1), x = R1(p.x + 40), z = R1(p.z + 95);   // its scanned face turned to the window
    item("L-stack", "mountainside", "stack", [x, -4, z], R1((Math.atan2(-x, -z) * 180) / Math.PI), 3.4, FAR, "512",
      "a sea stack off the point: the swell breaks white around it in a storm"); }
  /* the right head (cove side -1) */
  onShore("R-face", "mountainside", "cliff", 1, 0.8, -1, 6.0, -5, 0.5, L2, "512", "the right head's tallest face, at the right edge of wide views");
  onShore("R-cliff-1", "coastal_cliff_04", "cliff", 1, 1.45, -1, 4.0, -4, 0.55, HN, "1k", "the right head's inner shore, darker against the evening sun");
  onShore("R-cliff-2", "coastal_cliff_01", "cliff", 1, 2.25, -1, 3.5, -4, 0.55, LF, "1k", "the right head toward its point");
  onShore("R-point", "coastal_cliff_02", "cliff", 1, 3.1, -1, 3.4, -4, 0.55, LF, "512", "the right point; summer sunsets go behind it only on ultrawide views");
  onShore("R-ledge", "coast_line_02", "platform", 1, 1.9, -1, 1.6, -1.3, -0.45, FAR, "512", "the ledge at the right head's foot");
  /* the middle ground: reefs where the swell breaks, clear of the sun's usual path */
  item("reef-1", "coast_rocks_02", "reef", [168, -2.2, 372], 35, 1.2, MID, "512", "a reef awash right of centre: the swell steepens and breaks over it at every reading, white in a storm");
  item("reef-2", "coast_rocks_01", "reef", [262, -2.0, 520], -20, 1.1, MID, "512", "the reef's outer end, so the line of breakers reads as a reef and not a rock");
  item("reef-3", "coast_rocks_05", "rocks", [122, -0.4, 322], 0, 5.0, [2, 2, 2, 2, 1], "512", "a boulder at the reef's inner end: spray in a storm");
  item("mid-rocks", "coast_land_rocks_02", "rocks", [-262, -0.5, 450], -30, 3.4, L1, "512", "low rocks left of the ship: scale for it, foam in a swell");
  /* the near ground: under the window, mostly behind the cost strip; seen on tall and wide screens */
  item("near-left", "coast_line_01", "platform", [-70, -0.6, 96], 30, 1.0, [2, 2, 2, 1, 1], "512", "the rock shelf under the window's left side");
  item("near-left-2", "coast_rocks_05", "rocks", [-44, -0.3, 66], 10, 3.0, [2, 2, 2, 1, 1], "512", "a boulder on the shelf");
  item("near-right", "coast_line_02", "platform", [92, -0.5, 40], -60, 1.0, [2, 2, 2, 1, 1], "512", "the shelf the pier starts from");
  item("near-sand", "sand_rocks_small_01", "rocks", [44, -0.3, 52], 0, 2.2, [2, 2, 2, 1, 1], "512", "stones at the pier's root");
  /* the pier: modular_wooden_pier repeated, from the near right out toward the reef */
  const root = [62, 0, 30], head = [86, 0, 194], dir = [head[0] - root[0], head[2] - root[2]];
  const len = Math.hypot(dir[0], dir[1]), n = Math.round(len / 19.03), yaw = R1((Math.atan2(dir[0], dir[1]) * 180) / Math.PI);
  for (let k = 0; k < n; k++) {
    const t = (k + 0.5) / n;
    item("pier-" + k, "modular_wooden_pier", "pier", [R1(root[0] + dir[0] * t), -0.4, R1(root[2] + dir[1] * t)], yaw, 1, k < 4 ? NEAR : [2, 2, 2, 1, 1], "1k",
         k === n - 1 ? "the pier head, just above the cost strip at 1280x820; its piles stand in the sun's path at golden hour" : "the pier, entering from the near right");
  }
  item("lantern", "wooden_lantern_01", "lamp", [head[0] + 1.2, 2.45, head[2] - 1.5], 0, 2.0, FAR, "512", "a lantern on the pier head, lit at night");
  /* the ship at anchor and the channel buoy */
  item("ship", "dutch_ship_large_01", "ship", [-112, 0, 402], 62, 1.0, HERO, "512", "an old ship at anchor left of centre, clear of the sun's usual path; it swings and rides, never sails",
       { probes: 0 });
  item("buoy", "lateral_sea_marker", "buoy", [32, 0, 288], 0, 1.0, FAR, "512", "a red can buoy marking the channel inside the reef", { probes: 4 });
  /* plants: trees on the tops (silhouettes that give the cliffs their scale), grass, ferns and shrubs near (they sway) */
  const onTop = (hi, s, side, f) => {
    const pts = heads[hi], k = Math.min(pts.length - 2, Math.floor(s)), t = s - k, [x0, z0, , w0] = pts[k], [x1, z1, , w1] = pts[k + 1];
    const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz), w = w0 + (w1 - w0) * t;
    return [R1(x0 + dx * t + (side * dz / l) * w * f), R1(z0 + dz * t - (side * dx / l) * w * f)];
  };
  [[0, 1.5, 0.62], [0, 1.7, 0.7], [0, 1.95, 0.66], [0, 2.3, 0.6], [0, 2.6, 0.55], [0, 2.85, 0.5], [0, 3.1, 0.45],
   [1, 1.9, 0.6], [1, 2.3, 0.6], [1, 2.7, 0.55]].forEach(([hi, s, f], k) => {
    const [x, z] = onTop(hi, s, hi === 0 ? 1 : -1, f);
    item("tree-" + k, "island_tree_01", "tree", [x, null, z], k * 47, 1.8 + 0.3 * ((k * 7) % 3), FAR, "512",
      "a tree on the head's top: a skyline silhouette that gives the cliffs their scale");
  });
  [[84, 44], [100, 36], [52, 40], [-78, 100], [-54, 112]].forEach(([x, z], k) => item("grass-" + k, "grass_medium_01", "plant", [x, null, z], k * 61, 1.2, FAR, "512",
    "grass on the near shelves, bending in the wind (tall and wide views)"));
  [[70, 26], [-88, 88]].forEach(([x, z], k) => item("fern-" + k, "fern_02", "plant", [x, null, z], k * 90, 1.5, FAR, "512", "ferns at the pier's root"));
  [[78, 34], [-60, 84]].forEach(([x, z], k) => item("shrub-" + k, "shrub_04", "plant", [x, null, z], k * 33, 4.0, FAR, "512", "shrubs on the near shelves"));
  /* items placed on the ground take its height */
  for (const it of items) if (it.pos[1] === null) it.pos[1] = Math.round((height(it.pos[0], it.pos[2]) - 0.3) * 10) / 10;
  return { items, heads, height, shoreAt, DIM, AXIS, bounds: [-2200, -260, 2200, 2600], fbm };
})();

/* ── The coast library (stub bodies; signatures are the contract's) ─────────────────────────── */
WX.lib("coast", `
/* the shore field lives in a warped 2D texture: texels shrink toward the eye like screen pixels */
vec2 cstShoreUV(vec2 xz) {
  return vec2(.5 + .5 * asinh(xz.x / 40.) / asinh(2200. / 40.), asinh(max(xz.y + 260., 0.) / 40.) / asinh(2860. / 40.));
}
vec4 wxShore(vec2 xz) {
  vec2 uv = cstShoreUV(xz);
  if (uv.x <= 0. || uv.x >= 1. || uv.y >= 1. || uCoast.x <= 0.) return vec4(1e4, 60., 1., 0.);
  return texture(sShore, uv);
}
vec2 wxShoreNormal(vec2 xz) {
  float e = max(1., .004 * length(xz));
  vec2 g = vec2(wxShore(xz + vec2(e, 0.)).x - wxShore(xz - vec2(e, 0.)).x, wxShore(xz + vec2(0., e)).x - wxShore(xz - vec2(0., e)).x);
  return dot(g, g) > 1e-8 ? normalize(g) : vec2(0., 1.);
}
float wxSunShadow(vec3 pM) {
  if (uShadow.x < .5) return 1.;
  vec4 c = uShadowVP * vec4(pM, 1.);
  vec3 s = c.xyz / c.w * .5 + .5;
  if (any(lessThan(s, vec3(0.))) || any(greaterThan(s, vec3(1.)))) return 1.;
  vec2 t = vec2(1.5 / float(textureSize(sSunShadow, 0).x));
  float z = s.z - .0015, v = 0.;
  v += texture(sSunShadow, vec3(s.xy, z));
  v += texture(sSunShadow, vec3(s.xy + vec2(t.x, 0.), z)) + texture(sSunShadow, vec3(s.xy - vec2(t.x, 0.), z));
  v += texture(sSunShadow, vec3(s.xy + vec2(0., t.y), z)) + texture(sSunShadow, vec3(s.xy - vec2(0., t.y), z));
  return mix(1., v / 5., uShadow.w);
}
float wxSceneDist(vec2 uv) { float z = texture(sSceneZ, uv).r; return z > 0. ? z : 1e9; }
vec4 wxCoastRefl(vec2 uv, float lod) { return textureLod(sCoastRefl, uv, lod) * uCoast.x; }
`);

WX.pass((function () {
  const C = WX.COVE, D = Math.PI / 180;
  /* lab knobs to take the stub apart when timing it (p.coastTerrain=0 ...) */
  WX.param("coastTerrain", 1, 0, 1, 1, "coast"); WX.param("coastMeshes", 1, 0, 1, 1, "coast");
  WX.param("coastMirror", 1, 0, 1, 1, "coast"); WX.param("coastReal", 1, 0, 1, 1, "coast");
  WX.param("coastDyn", 1, 0, 1, 1, "coast"); WX.param("coastShadow", 1, 0, 1, 1, "coast");
  let P = {}, geo = [], terrain = null, shadow = null, shadowFb = null, mirror = null, mirrorFb = null, mirrorDepth = 0;
  let shoreTex = null, lightDir = [0, 0, 0], lightAge = 1e9, loader = null, lastTier = -1, bucketTier = -1, ship = null, redraw = false, lastUploads = -1;
  let lists = [[], [], []], listStamp = "";
  /* ── proxy geometry: flat-shaded triangle soups in mesh metres ── */
  function soup() { return { p: [], n: [] }; }
  function tri(s, a, b, c) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1; n = n.map((x) => x / l);
    s.p.push(...a, ...b, ...c); s.n.push(...n, ...n, ...n);
  }
  function box(s, cx, cy, cz, hx, hy, hz, ry = 0, rx = 0) {
    const cr = Math.cos(ry), sr = Math.sin(ry), cX = Math.cos(rx), sX = Math.sin(rx);
    const V = (x, y, z) => { const y1 = y * cX - z * sX, z1 = y * sX + z * cX; return [cx + x * cr + z1 * sr, cy + y1, cz - x * sr + z1 * cr]; };
    const q = (a, b, c, d) => { tri(s, a, b, c); tri(s, a, c, d); };
    const p = [V(-hx, -hy, -hz), V(hx, -hy, -hz), V(hx, hy, -hz), V(-hx, hy, -hz), V(-hx, -hy, hz), V(hx, -hy, hz), V(hx, hy, hz), V(-hx, hy, hz)];
    q(p[0], p[3], p[2], p[1]); q(p[4], p[5], p[6], p[7]); q(p[0], p[4], p[7], p[3]); q(p[1], p[2], p[6], p[5]); q(p[3], p[7], p[6], p[2]); q(p[0], p[1], p[5], p[4]);
  }
  function cyl(s, cx, y0, y1, cz, r0, r1, sides = 10) {
    for (let k = 0; k < sides; k++) {
      const a0 = (k / sides) * 2 * Math.PI, a1 = ((k + 1) / sides) * 2 * Math.PI;
      const p = (a, r, y) => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
      tri(s, p(a0, r0, y0), p(a1, r1, y1), p(a1, r0, y0)); tri(s, p(a0, r0, y0), p(a0, r1, y1), p(a1, r1, y1));
      tri(s, [cx, y1, cz], p(a1, r1, y1), p(a0, r1, y1));
    }
  }
  /* a rock: a subdivided octahedron scaled to the half extents, displaced by noise, flat below `base` */
  function rock(s, hx, hy, hz, base, seed, rough) {
    const f = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const faces = [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5]];
    const N = 7;
    const disp = (d) => {
      const l = Math.hypot(...d), u = d.map((x) => x / l);
      const k = 1 + rough * C.fbm(u[0] * 2.3 + seed, u[2] * 2.3 + u[1] * 1.7 - seed, 4) + 0.12 * rough * C.fbm(u[0] * 9 + seed, u[1] * 9 + u[2] * 4, 2);
      const top = u[1] > 0 ? Math.pow(u[1], 0.55) : u[1];
      return [u[0] * hx * k, Math.max(base, hy + top * hy * k), u[2] * hz * k];
    };
    for (const [ia, ib, ic] of faces) {
      const A = f[ia], B = f[ib], Cc = f[ic];
      const P_ = (i, j) => { const a = 1 - (i + j) / N, b = i / N, c = j / N; return disp([A[0] * a + B[0] * b + Cc[0] * c, A[1] * a + B[1] * b + Cc[1] * c, A[2] * a + B[2] * b + Cc[2] * c]); };
      for (let i = 0; i < N; i++) for (let j = 0; j < N - i; j++) {
        tri(s, P_(i, j), P_(i + 1, j), P_(i, j + 1));
        if (i + j < N - 1) tri(s, P_(i + 1, j), P_(i + 1, j + 1), P_(i, j + 1));
      }
    }
  }
  /* proxies per asset: a list of [soup, material]; materials 1 rock, 2 wood, 3 hull, 4 sail, 5 red, 6 plant, 7 lamp, 8 rope */
  function proxy(id) {
    const d = C.DIM[id], hx = d[0] / 2, hy = d[1] / 2, hz = d[2] / 2, base = d[3], out = [];
    const S = (m) => { const s = soup(); out.push([s, m]); return s; };
    const seed = id.length * 1.37;
    if (/cliff|mountainside|rock_face/.test(id)) rock(S(1), hx, hy, hz, base, seed, 0.38);
    else if (/coast_line|coast_rocks_0[12]/.test(id)) rock(S(1), hx, hy, hz, base, seed, 0.5);
    else if (/rocks|sand_rocks/.test(id)) rock(S(1), hx, hy, hz, base, seed, 0.45);
    else if (id === "dutch_ship_large_01") {
      const h = S(3), sl = S(4), rg = S(8), L = 15.5, B = 3.9;
      for (let k = 0; k < 8; k++) {                     // the hull: slices that narrow to the bow and rise to the stern
        const z = -L + (k + 0.5) * (2 * L / 8), w = B * (k < 6 ? 1 - Math.pow(Math.max(0, (k - 3) / 4), 2) * 0.55 : 0.55 - (k - 6) * 0.2);
        box(h, 0, 1.2 + (k < 2 ? 1.3 - k * 0.5 : k > 6 ? 0.6 : 0), z, w, 3.4 + (k < 2 ? 1.3 - k * 0.5 : 0), L / 8);
      }
      box(h, 0, 6.4, -L + 2.6, B * 0.85, 1.6, 3.2);    // the stern castle
      box(h, 0, 4.4, L - 1.0, B * 0.45, 0.8, 1.8);     // the forecastle
      box(h, 0, 5.0, L + 4.5, 0.18, 0.18, 6.0, 0, -0.35);   // the bowsprit
      const masts = [[-7.5, 22], [1.0, 28.5], [8.6, 24]];
      for (const [z, top] of masts) {
        box(rg, 0, top / 2, z, 0.28, top / 2, 0.28);
        for (const [y, w] of [[top * 0.42, 7.5], [top * 0.68, 5.6], [top * 0.88, 3.6]]) {
          box(rg, 0, y, z, w, 0.16, 0.16);                    // a yard
          box(sl, 0, y - (top * 0.11), z + 0.25, w * 0.92, top * 0.105, 0.06);   // its sail, hanging loose
        }
      }
      box(sl, 0, 12, -12.5, 0.05, 5.5, 3.2);                // the mizzen's lateen sail
    } else if (id === "modular_wooden_pier") {
      const w = S(2);
      box(w, 0, 2.55, 0, 1.55, 0.12, 9.5);                   // the deck at +2.6 m
      box(w, 1.45, 3.1, 0, 0.06, 0.06, 9.5); box(w, -1.45, 3.1, 0, 0.06, 0.06, 9.5);   // the rails
      for (const z of [-8.5, -2.8, 2.8, 8.5]) for (const x of [-1.4, 1.4]) box(w, x, -1.0, z, 0.16, 4.2, 0.16);   // the piles to the seabed
      for (const z of [-8.5, 0, 8.5]) for (const x of [-1.45, 1.45]) box(w, x, 3.1, z, 0.07, 0.55, 0.07);       // the rail posts
    } else if (id === "lateral_sea_marker") {
      const r = S(5);
      cyl(r, 0, -1.6, 0.5, 0, 1.5, 1.5, 12);                // the float
      cyl(r, 0, 0.5, 3.6, 0, 0.9, 0.7, 10);                 // the can
      cyl(S(8), 0, 3.6, 5.6, 0, 0.12, 0.12, 6);             // the mast
      box(r, 0, 5.9, 0, 0.35, 0.45, 0.35);                  // the top mark
    } else if (id === "wooden_lantern_01") { box(S(2), 0, 0.5, 0, 0.04, 0.5, 0.04); box(S(7), 0, 1.15, 0, 0.12, 0.16, 0.12); }
    else if (id === "island_tree_01") {
      const t = S(2), l = S(6); box(t, 0, 1.4, 0, 0.18, 1.4, 0.18);
      rock(l, 2.1, 1.5, 2.0, -1.4, seed + 3, 0.35); const q = l.p; for (let k = 1; k < q.length; k += 3) q[k] += 3.0;
    } else { const l = S(6); rock(l, hx, hy, hz, 0, seed, 0.6); }
    return out;
  }
  /* the terrain: a polar fan around the eye, so its triangles stay a few pixels wide at every distance */
  function buildTerrain() {
    const rings = [], cols = [];
    for (let r = 22; r < 3400; r *= 1.0175) rings.push(r);
    for (let a = -82; a <= 82.001; a += 0.2) cols.push(a * D);
    const NR = rings.length, NC = cols.length, pos = new Float32Array(NR * NC * 3), nrm = new Float32Array(NR * NC * 3), hgt = new Float32Array(NR * NC);
    for (let i = 0; i < NR; i++) for (let j = 0; j < NC; j++) {
      const x = Math.sin(cols[j]) * rings[i], z = Math.cos(cols[j]) * rings[i], h = C.height(x, z), k = i * NC + j;
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z; hgt[k] = h;
      const e = Math.max(1.5, rings[i] * 0.004);
      const nx = C.height(x - e, z) - C.height(x + e, z), nz = C.height(x, z - e) - C.height(x, z + e), l = Math.hypot(nx, 2 * e, nz);
      nrm[k * 3] = nx / l; nrm[k * 3 + 1] = (2 * e) / l; nrm[k * 3 + 2] = nz / l;
    }
    /* two index ranges: the land (any corner above -0.5 m), drawn in the view, the mirror and the shadow
       map; then the shallow seabed (down to -4 m), drawn in the view only, cheaply. Deeper water hides
       its bed at these grazing angles, so it is not drawn at all (SCENEZ stays 0 there: deep water) */
    const land = [], bed = [];
    for (let i = 0; i < NR - 1; i++) for (let j = 0; j < NC - 1; j++) {
      const a = i * NC + j, b = a + 1, c = a + NC, d = c + 1, top = Math.max(hgt[a], hgt[b], hgt[c], hgt[d]);
      if (top < -4) continue;
      (top > -0.5 ? land : bed).push(a, c, b, b, c, d);
    }
    return { pos, nrm, idx: new Uint32Array(land.concat(bed)), land: land.length, bed: bed.length };
  }
  /* ── the shore field, baked on the CPU from the heightfield and the placed rocks (the stub's way) */
  function bakeShore(N) {
    const B = C.bounds, ax = Math.asinh(2200 / 40), az = Math.asinh(2860 / 40);
    const X = new Float32Array(N), Z = new Float32Array(N);
    for (let i = 0; i < N; i++) { X[i] = 40 * Math.sinh(((i + 0.5) / N * 2 - 1) * ax); Z[i] = 40 * Math.sinh(((i + 0.5) / N) * az) - 260; }
    const H = new Float32Array(N * N), rockM = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = X[i], z = Z[j];
      let h = C.height(x, z), rk = 0;
      for (const it of C.items) {
        if (!/cliff|stack|platform|rocks|reef/.test(it.role)) continue;
        const c = Math.cos(it.yaw * D), s = Math.sin(it.yaw * D), dx = x - it.pos[0], dz = z - it.pos[2];
        const lx = (dx * c - dz * s) / (it.half[0] * it.scale), lz = (dx * s + dz * c) / (it.half[2] * it.scale);
        const q = lx * lx + lz * lz;
        if (q < 1) { const top = it.pos[1] + (it.base + 2 * it.half[1]) * it.scale * Math.sqrt(1 - q) * 0.9; h = Math.max(h, top); rk = 1; }
        else if (q < 2.2) rk = Math.max(rk, 1 - (q - 1) / 1.2);
      }
      H[j * N + i] = h; rockM[j * N + i] = Math.max(rk, h > -3 && Math.abs(x) > 150 ? 0.8 : 0);
    }
    /* signed distance to the h = 0 line: nearest-seed propagation with world distances (8SSEDT-like) */
    const sx = new Float32Array(N * N).fill(NaN), sz = new Float32Array(N * N).fill(NaN);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i, land = H[k] > 0;
      for (const [di, dj] of [[1, 0], [0, 1]]) {
        const i2 = i + di, j2 = j + dj;
        if (i2 >= N || j2 >= N) continue;
        if ((H[j2 * N + i2] > 0) !== land) { sx[k] = (X[i] + X[i2]) / 2; sz[k] = (Z[j] + Z[j2]) / 2; sx[j2 * N + i2] = sx[k]; sz[j2 * N + i2] = sz[k]; }
      }
    }
    const dist = (k, i, j) => (isNaN(sx[k]) ? 1e9 : Math.hypot(X[i] - sx[k], Z[j] - sz[k]));
    for (let pass = 0; pass < 2; pass++) for (const dir of [1, -1]) {
      for (let jj = 0; jj < N; jj++) {
        const j = dir > 0 ? jj : N - 1 - jj;
        for (let ii = 0; ii < N; ii++) {
          const i = dir > 0 ? ii : N - 1 - ii, k = j * N + i;
          let best = dist(k, i, j);
          for (const [di, dj] of [[-dir, 0], [0, -dir], [-dir, -dir], [dir, -dir]]) {
            const i2 = i + di, j2 = j + dj;
            if (i2 < 0 || j2 < 0 || i2 >= N || j2 >= N) continue;
            const k2 = j2 * N + i2;
            if (isNaN(sx[k2])) continue;
            const d = Math.hypot(X[i] - sx[k2], Z[j] - sz[k2]);
            if (d < best) { best = d; sx[k] = sx[k2]; sz[k] = sz[k2]; }
          }
        }
      }
    }
    /* exposure to the swell: march toward where it comes from (from 10 deg right, in the world frame) on a coarse land grid */
    const G = 20, GW = Math.ceil((B[2] - B[0]) / G), GH = Math.ceil((B[3] - B[1]) / G), land = new Uint8Array(GW * GH);
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) land[j * GW + i] = C.height(B[0] + (i + 0.5) * G, B[1] + (j + 0.5) * G) > 0 ? 1 : 0;
    const sw = [Math.sin(10 * D), Math.cos(10 * D)];
    const out = new Float32Array(N * N * 4);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i, x = X[i], z = Z[j], h = H[k];
      let e = 1;
      for (let s = 1; s <= 70; s++) {
        const px = x + sw[0] * s * 25, pz = z + sw[1] * s * 25;
        const gi = Math.floor((px - B[0]) / G), gj = Math.floor((pz - B[1]) / G);
        if (gi < 0 || gj < 0 || gi >= GW || gj >= GH) break;
        if (land[gj * GW + gi]) { e = smooth01(s * 25 / 1400); break; }
      }
      const d = Math.min(dist(k, i, j), 400);
      out[k * 4] = h > 0 ? -d : d; out[k * 4 + 1] = Math.max(-60, Math.min(60, -h)); out[k * 4 + 2] = e; out[k * 4 + 3] = rockM[k];
    }
    return out;
  }
  const smooth01 = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
  /* half floats for an RGBA16F upload */
  function toHalf(f32) {
    const out = new Uint16Array(f32.length), fb = new Float32Array(1), ib = new Uint32Array(fb.buffer);
    for (let k = 0; k < f32.length; k++) {
      fb[0] = f32[k]; const x = ib[0], s = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 112, m = x & 0x7fffff;
      out[k] = e <= 0 ? s : e >= 31 ? s | 0x7bff : s | (e << 10) | (m >>> 13);
    }
    return out;
  }
  /* ── GPU objects ── */
  function makeVAO(gl, pos, nrm, idx) {
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const b0 = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b0); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const b1 = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b1); gl.bufferData(gl.ARRAY_BUFFER, nrm, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(2); gl.vertexAttrib2f(2, 0, 0); gl.disableVertexAttribArray(3); gl.vertexAttrib4f(3, 1, 0, 0, 1);
    if (idx) { const b2 = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b2); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW); }
    gl.bindVertexArray(null);
    return vao;
  }
  /* instance attributes 4..7 from a buffer of 16 floats per instance */
  function bindInst(gl, vao, buf) {
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    for (let k = 0; k < 4; k++) { gl.enableVertexAttribArray(4 + k); gl.vertexAttribPointer(4 + k, 4, gl.FLOAT, false, 64, k * 16); gl.vertexAttribDivisor(4 + k, 1); }
    gl.bindVertexArray(null);
  }
  function instRow(it, out, o, extra) {
    const c = Math.cos(it.yaw * D), s = Math.sin(it.yaw * D), k = it.scale;
    out.set([c * k, 0, s * k, it.pos[0], 0, k, 0, it.pos[1], -s * k, 0, c * k, it.pos[2]], o);
    out.set(extra, o + 12);
  }
  const motionOf = (it) => (it.role === "ship" ? 2 : it.role === "buoy" ? 6 : /plant|tree/.test(it.role) ? (it.role === "tree" ? 0.35 : 1) : 0);
  const MIRROR_LOW = /cliff|stack|ship|pier|buoy/;           // below T3 the mirror holds only the big silhouettes
  const I4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const yawM = (deg) => { const c = Math.cos(deg * D), s = Math.sin(deg * D); return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]); };
  const mul4 = (A, B) => { const M = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += A[k * 4 + r] * B[c * 4 + k]; M[c * 4 + r] = s; } return M; };

  const VS = WX.glsl.meshVS + `
    uniform int uMode;            // 0 the view, 1 the key light's shadow map, 2 the mirror
    uniform mat4 uLightVP;
    uniform float uMeshH;         // the asset's height m, for the plants' sway
    out vec3 vP; out vec3 vN; out vec2 vUV; flat out float vSeed; flat out float vVar;
    vec3 rotX(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c); }
    vec3 rotZ(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x * c - p.y * s, p.x * s + p.y * c, p.z); }
    void main() {
      vec3 lp = wxNodePos(aPos), ln = wxNodeNormal(aNormal);
      float heave = 0.;
      if (aInstP.y >= 2.) {                       // the ship and the buoy ride the sea: 4 probes (bow, stern, port, starboard)
        int b = int(aInstP.y + .5) - 2;
        vec4 pb = wxSeaProbe(b), ps = wxSeaProbe(b + 1), pp = wxSeaProbe(b + 2), pt = wxSeaProbe(b + 3);
        float span = b == 0 ? 26. : 2.4, beam = b == 0 ? 7. : 2.4;
        heave = .25 * (pb.x + ps.x + pp.x + pt.x);
        float pitch = atan((pb.x - ps.x) / span), roll = atan((pt.x - pp.x) / beam) * (b == 0 ? 1.2 : 1.6);
        lp = rotZ(rotX(lp, -pitch), roll); ln = rotZ(rotX(ln, -pitch), roll);
      }
      vec3 p = wxInstPos(lp) + vec3(0., heave, 0.);
      vec3 n = wxInstNormal(ln);
      if (aInstP.y > 0. && aInstP.y < 2.) {       // plants bend downwind, more in the gusts; a stationary sway
        float w = aInstP.y * pow(clamp(lp.y / max(uMeshH, .01), 0., 1.), 2.);
        /* periods that divide the rain clock's 240 s wrap (3.75 s and 15 s), so the sway never jumps */
        float t = uTime.y, ph = aInstP.w * 6.28;
        float g = (uWind.z / 26.) * (.6 + .4 * sin(t * (2. * PI * 64. / 240.) + ph) * sin(t * (2. * PI * 16. / 240.) + ph * 2.));
        p.xz += uWind.xy * w * g * (aInstP.y < .5 ? 1.2 : .25);
      }
      p.y -= wxDrop(p.xz);
      vP = p; vN = n; vUV = aUV; vSeed = aInstP.w; vVar = aInstP.x;
      if (uMode == 1) { gl_Position = uLightVP * vec4(p, 1.); return; }
      gl_Position = uViewProj * vec4(p.x, uMode == 2 ? -p.y : p.y, p.z, 1.);
    }`;
  const FS = `
    uniform int uMode; uniform int uMat;
    uniform sampler2D uBase; uniform float uHasBase, uCutoff, uAlphaScale;
    uniform sampler2D uTerRock, uTerGrass, uTerSand, uTerWet; uniform float uHasTer;
    in vec3 vP; in vec3 vN; in vec2 vUV; flat in float vSeed; flat in float vVar;
    layout(location = 0) out vec4 o; layout(location = 1) out vec4 oZ;
    float hn(vec2 p) { return wxHash12(floor(p)); }
    float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
      return mix(mix(hn(i), hn(i + vec2(1, 0)), f.x), mix(hn(i + vec2(0, 1)), hn(i + vec2(1, 1)), f.x), f.y); }
    vec3 tri(sampler2D t, vec3 p, vec3 n, float tile) {      // triplanar, for the steep terrain
      vec3 w = pow(abs(n), vec3(4.)); w /= w.x + w.y + w.z;
      return texture(t, p.zy / tile).rgb * w.x + texture(t, p.xz / tile).rgb * w.y + texture(t, p.xy / tile).rgb * w.z;
    }
    void main() {
      if (uMode == 2 && vP.y < -.05) discard;                        // the mirror holds what stands above the water
      if (wxIGN(gl_FragCoord.xy) > uCoast.x) discard;                // the cove fades in, dithered
      vec3 n = normalize(vN);
      if (uMode == 2 ? gl_FrontFacing : !gl_FrontFacing) n = -n;      // the mirror turns the winding over
      vec3 eye = vec3(0., wxEye, 0.), pv = uMode == 2 ? vec3(vP.x, -vP.y, vP.z) : vP;
      vec3 d = normalize(pv - eye); float dist = length(pv - eye);
      /* the albedo by material; the terrain's by height, slope and a little noise */
      vec3 alb; float porous = 1.;
      float nz = vn(vP.xz / 9.) * .6 + vn(vP.xz / 41.) * .4;
      if (uMat == 9) {                                               // a real mesh: its base colour
        vec4 b = uHasBase > .5 ? texture(uBase, vUV) : vec4(.18, .17, .15, 1.);
        if (uCutoff > 0. && b.a * uAlphaScale < uCutoff) discard;
        alb = b.rgb; porous = .9;
      } else if (uMat == 0 && vP.y < -.8) {                          // the shallow seabed: one look-up, seen only through water
        alb = uHasTer > .5 ? texture(uTerSand, vP.xz / 15.).rgb * .8 : vec3(.2, .18, .13);
        vec3 Lb = alb * (wxSunLight(wxPlanet(vP)) * max(uSun.y, 0.) * wxCloudShadow(vP) / PI + wxAmbient(.8));
        vec4 apb = wxAerial(d, dist * 1e-3);
        o = vec4(wxGuard(Lb * apb.a + apb.rgb), 1.); oZ = vec4(dist, 0., 0., 1.);
        return;
      } else if (uMat == 0) {
        vec3 rockC = mix(vec3(.13, .115, .10), vec3(.21, .19, .16), nz);
        vec3 grass = mix(vec3(.055, .075, .03), vec3(.11, .12, .05), vn(vP.xz / 17.));
        vec3 sand = vec3(.30, .26, .20), bed = mix(vec3(.16, .15, .11), vec3(.09, .1, .08), nz);
        if (uHasTer > .5) {
          rockC = tri(uTerRock, vP, n, 50.) * (.8 + .4 * nz);
          grass = texture(uTerGrass, vP.xz / 15.).rgb * (.85 + .3 * vn(vP.xz / 31.));
          sand = texture(uTerSand, vP.xz / 15.).rgb; bed = mix(sand * .7, tri(uTerWet, vP, n, 2.), .5);
        }
        float flat_ = smoothstep(.72, .86, n.y), up = smoothstep(1.5, 5., vP.y);
        alb = mix(rockC, grass, flat_ * up);
        alb = mix(alb, sand, smoothstep(2.5, .3, vP.y) * smoothstep(-1., .5, vP.y) * flat_ * .5);
        alb = mix(alb, bed, smoothstep(-.3, -1.5, vP.y));
      } else if (uMat == 1) alb = mix(vec3(.12, .11, .095), vec3(.22, .2, .17), nz * .7 + vVar * .3);
      else if (uMat == 2) { alb = vec3(.13, .095, .065); porous = .8; }
      else if (uMat == 3) { alb = mix(vec3(.07, .05, .035), vec3(.11, .075, .05), step(3.6, vP.y - uShip.y)); porous = .4; }
      else if (uMat == 4) { alb = vec3(.52, .48, .40); porous = .7; }
      else if (uMat == 5) { alb = vec3(.42, .035, .025); porous = .1; }
      else if (uMat == 6) alb = mix(vec3(.035, .055, .02), vec3(.07, .085, .03), vVar);
      else if (uMat == 7) alb = vec3(.25, .2, .12);
      else alb = vec3(.05, .045, .035);
      /* wet rock and wood go darker (soak), and the splash zone is always wet */
      float wet = max(uWx4.x, smoothstep(2.5, .2, vP.y) * step(-.5, vP.y) * .8);
      alb *= mix(1., .55, wet * porous);
      /* light: the key light through the clouds and the cove's own shadows, the moon, the sky, lightning */
      vec3 pk = wxPlanet(vP);
      float cs = wxCloudShadow(vP), ss = wxSunShadow(vP + n * .6);
      bool sunKey = dot(uKey.xyz, uSun.xyz) > .9999;
      vec3 sun = wxSunLight(pk) * max(dot(n, uSun.xyz), 0.) * cs * (sunKey ? ss : 1.);
      vec3 moon = wxMoonLight(pk) * max(dot(n, uMoon.xyz), 0.) * (sunKey ? 1. : ss);
      vec3 amb = wxAmbient(n.y * .5 + .5) * (.55 + .45 * n.y * n.y);
      vec3 L = alb * ((sun + moon) / PI + amb);
      for (int k = 0; k < 2; k++) {
        vec4 f = k == 0 ? uFlash0 : uFlash1;
        if (f.w <= 0.) continue;
        vec3 lv = f.xyz * 1000. - vP; float r = length(lv) * 1e-3;
        L += alb * f.w * 2.5 / (r * r + .6) * (.35 + .65 * max(dot(n, lv / (r * 1e3)), 0.)) * uExpo.x;
      }
      if (uMat == 7) L += vec3(1., .62, .3) * 2.5e-4 * uCoast.y * uExpo.x;                 // the lantern
      vec4 ap = wxAerial(d, dist * 1e-3);
      o = vec4(wxGuard(L * ap.a + ap.rgb), 1.);
      oZ = vec4(dist, 0., 0., 1.);
    }`;
  const ZFS = `
    uniform int uMat; uniform sampler2D uBase; uniform float uHasBase, uCutoff, uAlphaScale;
    in vec2 vUV;
    void main() { if (uMat == 9 && uCutoff > 0. && uHasBase > .5 && texture(uBase, vUV).a * uAlphaScale < uCutoff) discard; }`;

  function lightMatrix(L) {
    /* an orthographic box around the cove, looking along -L */
    const up = Math.abs(L[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
    const f = [-L[0], -L[1], -L[2]];
    const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const nrm = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
    const r = nrm(cr(f, up)), u = cr(r, f), B = C.bounds;
    let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (const x of [B[0], B[2]]) for (const y of [-50, 130]) for (const z of [B[1], B[3]]) {
      const p = [x, y, z], v = [p[0] * r[0] + p[1] * r[1] + p[2] * r[2], p[0] * u[0] + p[1] * u[1] + p[2] * u[2], p[0] * f[0] + p[1] * f[1] + p[2] * f[2]];
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
    }
    const sx = 2 / (hi[0] - lo[0]), sy = 2 / (hi[1] - lo[1]), sz = 2 / (hi[2] - lo[2]);
    const ox = -(hi[0] + lo[0]) / 2, oy = -(hi[1] + lo[1]) / 2, oz = -(hi[2] + lo[2]) / 2;
    /* clip = S (R p + o), column-major */
    const M = new Float32Array([r[0] * sx, u[0] * sy, f[0] * sz, 0, r[1] * sx, u[1] * sy, f[1] * sz, 0, r[2] * sx, u[2] * sy, f[2] * sz, 0, ox * sx, oy * sy, oz * sz, 1]);
    return { M, texel: (hi[0] - lo[0]) };
  }

  /* instance buckets: for each mode (0 view, 1 shadow, 2 mirror) and asset, its instances grouped by
     the LOD that mode draws at this tier; one instance buffer per bucket, re-made at a tier change */
  function lodFor(it, mode, R) {
    const t = R.tier, kn = R.knobs, mx = Math.max(...it.lod);
    if (mode === 1) return mx;
    if (mode === 2) return t < 3 && !MIRROR_LOW.test(it.role) ? -1 : Math.min(mx, it.lod[t] + kn.reflLod);
    return it.lod[t];
  }
  function rowOf(it, out, o, F) {
    if (it.role === "ship" && it._pose) return instRow({ ...it, pos: it._pose.pos, yaw: it._pose.yaw }, out, o, [0.3, 2, 1, 0.5]);
    if (it.role === "buoy" && F) {
      const t = F.t.ocean, yw = 8 * Math.sin((2 * Math.PI * t) / 64);
      return instRow({ ...it, yaw: yw, pos: [it.pos[0] + 0.6 * Math.sin((2 * Math.PI * t) / 85.333), 0, it.pos[2]] }, out, o, [0.5, 6, 1, 0.2]);
    }
    instRow(it, out, o, [it._var, motionOf(it), 1, it._seed]);
  }
  function bucketize(R) {
    const gl = R.gl;
    for (const g of geo) {
      for (const b of g.buckets || []) gl.deleteBuffer(b.ib);
      g.buckets = [];
      for (const mode of [0, 1, 2]) {
        const by = {};
        g.its.forEach((it) => { const l = lodFor(it, mode, R); if (l >= 0) (by[l] = by[l] || []).push(it); });
        for (const l in by) {
          const its = by[l], inst = new Float32Array(its.length * 16);
          its.forEach((it, k) => rowOf(it, inst, k * 16, null));
          const ib = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, ib); gl.bufferData(gl.ARRAY_BUFFER, inst, gl.DYNAMIC_DRAW);
          g.buckets.push({ mode, lod: +l, its, inst, ib });
        }
      }
    }
    bucketTier = R.tier; listStamp = "";
  }
  function instAttrs(gl, ib) {
    gl.bindBuffer(gl.ARRAY_BUFFER, ib);
    for (let k = 0; k < 4; k++) { gl.enableVertexAttribArray(4 + k); gl.vertexAttribPointer(4 + k, 4, gl.FLOAT, false, 64, k * 16); gl.vertexAttribDivisor(4 + k, 1); }
  }
  const terrainSet = () => {
    const T = loader.terrain(), by = (re) => T.find((t) => re.test(t.layer) && t.albedo);
    const rock = by(/^rock/), grass = by(/grass/), sand = by(/sand/), wet = by(/wet/);
    return rock && grass && sand && wet ? { uTerRock: rock.albedo, uTerGrass: grass.albedo, uTerSand: sand.albedo, uTerWet: wet.albedo, uHasTer: 1 } : { uHasTer: 0 };
  };

  return {
    name: "coast",
    *build(R) {
      const gl = R.gl, G = R.gpu;
      geo = []; shadow = shadowFb = mirror = mirrorFb = null; shoreTex = null; lastTier = -1; bucketTier = -1; ship = null;
      P.color = R.program("coast.color", { libs: ["atmo", "clouds", "coast", "ocean"], vs: VS, fs: FS });
      P.depth = R.program("coast.depth", { libs: ["coast", "ocean"], vs: VS, fs: ZFS });
      /* the real meshes, when the lab has them (lab/weather/manifest.json) */
      loader = WX.assets.loader(WX.ASSETS.base);
      let manDone = false; loader.manifest().then(() => (manDone = true));
      yield;
      /* the terrain */
      const t = buildTerrain();
      yield;
      const tv = makeVAO(gl, t.pos, t.nrm, t.idx);
      const tib = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, tib);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 0, 1, 0.5]), gl.STATIC_DRAW);
      bindInst(gl, tv, tib);
      terrain = { vao: tv, count: t.idx.length, land: t.land, bed: t.bed, type: gl.UNSIGNED_INT };
      yield;
      /* the proxies, one VAO per (asset, material) */
      const byId = {};
      C.items.forEach((it, k) => { it._var = (k * 0.618) % 1; it._seed = (k * 0.377 + it.id.length * 0.13) % 1; (byId[it.id] = byId[it.id] || []).push(it); });
      for (const id in byId) {
        const its = byId[id];
        const parts = proxy(id).map(([s, mat]) => ({ vao: makeVAO(gl, new Float32Array(s.p), new Float32Array(s.n), null), count: s.p.length / 3, mat }));
        geo.push({ id, its, parts, meshH: C.DIM[id][1], axis: yawM(C.AXIS[id] || 0), dynamic: its.some((it) => it.role === "ship" || it.role === "buoy") });
        if (its[0].role === "ship") ship = geo[geo.length - 1];
      }
      yield;
      /* the shore field */
      const N = 512, data = bakeShore(N);
      yield;
      shoreTex = G.tex2D(N, N, "rgba16f", { data: toHalf(data) });
      R.provide("SHORE", shoreTex);
      R.debugTex("SHORE", shoreTex, "raw");
      yield* R.wait(P.color, P.depth);
      while (!manDone) yield;
      if (loader.man()) loader.want(Object.keys(byId), { texPx: R.knobs.texPx, tier: R.tier });
    },
    resize(R) {
      const gl = R.gl, G = R.gpu, kn = R.knobs;
      const [w, h] = R.size.S, div = kn.coastRefl || 2, mw = Math.max(16, Math.round(w / div)), mh = Math.max(16, Math.round(h / div));
      if (mirror) { gl.deleteTexture(mirror.tex); gl.deleteFramebuffer(mirrorFb.fb); gl.deleteRenderbuffer(mirrorDepth); }
      mirror = G.tex2D(mw, mh, "rgba16f", { mips: true });
      mirrorDepth = G.depthRB(mw, mh);
      mirrorFb = G.fbo([mirror], mirrorDepth);
      R.provide("COASTREFL", mirror);
      R.debugTex("COASTREFL", mirror, "hdr");
      if (lastTier !== R.tier || !shadow) {
        if (shadow) { gl.deleteTexture(shadow.tex); gl.deleteFramebuffer(shadowFb.fb); }
        shadow = G.tex2D(kn.shadow || 1536, kn.shadow || 1536, "depth16", { compare: true });
        shadowFb = G.fbo([], shadow);
        R.provide("SUNSHADOW", shadow);
        R.debugTex("SUNSHADOW", shadow, "r");
        lightAge = 1e9; lastTier = R.tier;
      }
      bucketize(R);
    },
    ubo(F, R) {
      const c = R.coast, it = ship && ship.its[0], t = F.t.ocean;
      c.up = 1;
      c.lights = 1 - WX.util.smooth(-6 * D, -2 * D, Math.asin(F.sun.dir[1]));
      if (it) {
        /* at anchor: the ship lies to its cable and swings a few degrees in loops that divide the sea's 1024 s */
        const yaw = it.yaw + 3.0 * Math.sin((2 * Math.PI * t) / 256) + 1.2 * Math.sin((2 * Math.PI * t) / 93.0909 + 1.1);
        const back = 24, ang = yaw * D, y0 = it.yaw * D;
        const a = [it.pos[0] + Math.sin(y0) * back, 0, it.pos[2] + Math.cos(y0) * back];   // the anchor, ahead of the bow
        const pos = [a[0] - Math.sin(ang) * back + 0.8 * Math.sin((2 * Math.PI * t) / 128), 0, a[2] - Math.cos(ang) * back];
        c.ship.pos = pos; c.ship.yaw = ang; c.ship.halfL = 16.5; c.ship.halfB = 4.0; c.ship.draft = 2.0; c.ship.on = 1;
        const fx = Math.sin(ang), fz = Math.cos(ang);
        const P_ = [[pos[0] + fx * 13, pos[2] + fz * 13, 6], [pos[0] - fx * 13, pos[2] - fz * 13, 6],
                    [pos[0] - fz * 3.5, pos[2] + fx * 3.5, 3], [pos[0] + fz * 3.5, pos[2] - fx * 3.5, 3]];
        P_.forEach((q, k) => c.probes.set([q[0], q[1], q[2], 1], k * 4));
        it._pose = { pos, yaw: yaw };
      }
      const b = C.items.find((x) => x.role === "buoy");
      if (b) [[0, 1.2], [0, -1.2], [-1.2, 0], [1.2, 0]].forEach(([dx, dz], k) => c.probes.set([b.pos[0] + dx, b.pos[2] + dz, 1.5, 1], (4 + k) * 4));
      c.nProbes = 8;
      /* spray points: the rocks' feet that face the swell */
      let ns = 0;
      for (const x of C.items) if (/reef|stack|rocks|platform/.test(x.role) && ns < WX.SPRAYS) { c.spray.set([x.pos[0], 0.5, x.pos[2], x.role === "reef" ? 1 : 0.6], ns * 4); ns++; }
      c.nSpray = ns;
      /* the key light's shadow: redrawn when the light moved by more than 0.05 deg, or new meshes came */
      const sunEl = Math.asin(F.sun.dir[1]);
      const key = sunEl > -6 * D ? F.sun.dir : F.moon.dir;
      const moved = Math.acos(Math.min(1, key[0] * lightDir[0] + key[1] * lightDir[1] + key[2] * lightDir[2])) > 0.05 * D;
      if (moved || lightAge > 120 || (loader.progress.uploads !== lastUploads && lightAge > 30)) {
        const lm = lightMatrix(key);
        c.shadowVP.set(lm.M);
        c.shadow[1] = lm.texel / ((shadow && shadow.w) || 1536);
        lightDir = key.slice(); lightAge = 0; redraw = true; lastUploads = loader.progress.uploads;
      } else lightAge++;
      c.shadow[0] = shadow ? 1 : 0; c.shadow[2] = WX.SUN_RADIUS;
      c.shadow[3] = WX.util.smooth(-0.02, 0.06, key[1]) * (1 - 0.75 * WX.util.smooth(0.85, 1, F.W.cov));
    },
    slots: {
      coast(R, F) {
        const gl = R.gl;
        if (!terrain) return;
        loader.step(R, 4);
        if (bucketTier !== R.tier) bucketize(R);
        for (const g of geo) {                         // the moving pieces' instance rows
          if (!g.dynamic || !R.p("coastDyn")) continue;
          for (const b of g.buckets) { b.its.forEach((it, k) => rowOf(it, b.inst, k * 16, F)); gl.bindBuffer(gl.ARRAY_BUFFER, b.ib); gl.bufferSubData(gl.ARRAY_BUFFER, 0, b.inst); }
        }
        /* draw lists, made again only when the tier, the buckets or the arrived meshes and textures change:
           the per-frame loop is a few GL calls per draw, no allocation (DESIGN 13.3: the slot's JS <= 0.3 ms) */
        const stamp = R.tier + ":" + loader.progress.uploads + ":" + R.p("coastReal") + ":" + R.p("coastMeshes");
        if (stamp !== listStamp) {
          listStamp = stamp;
          lists = [[], [], []];
          for (const g of R.p("coastMeshes") ? geo : []) for (const b of g.buckets) {
            const m = R.p("coastReal") ? loader.mesh(g.id, b.lod) : null;
            if (!m) { for (const pt of g.parts) lists[b.mode].push({ vao: pt.vao, ib: b.ib, n: b.its.length, node: I4, mat: pt.mat, base: null, cut: 0, as: 1, h: g.meshH, count: pt.count, type: 0, off: 0, prim: gl.TRIANGLES }); continue; }
            for (const part of m.parts) {
              const node = mul4(g.axis, part.xform);
              for (const pr of part.prims) {
                const mt = m.materials[pr.mat] || { name: "", alpha: "OPAQUE" }, tx = loader.mat(g.id, mt.name);
                lists[b.mode].push({ vao: pr.vao, ib: b.ib, n: b.its.length, node, mat: 9, base: tx.base, cut: mt.alpha === "MASK" ? mt.cutoff : 0, as: tx.alphaScale || 1,
                                     h: g.meshH, count: pr.count, type: pr.type, off: pr.offset, prim: pr.mode });
              }
            }
          }
        }
        R.coast.draws = lists[0].length + lists[1].length + lists[2].length;
        R.coast.loading = loader.progress;                       // lab: what has arrived
        const ter = terrainSet();
        const UB = WX.PRIVATE_UNIT0 + 8;
        const drawAll = (prog, mode, extra) => {
          const u = prog.use();
          R.gpu.uniforms(prog, Object.assign({ uMode: mode, uMeshH: 1, uMat: 0, uNode: I4, uCutoff: 0, uHasBase: 0, uAlphaScale: 1 }, ter, extra));
          gl.bindVertexArray(terrain.vao);
          if (R.p("coastTerrain")) gl.drawElementsInstanced(gl.TRIANGLES, mode === 0 ? terrain.count : terrain.land, terrain.type, 0, 1);
          const L = (k) => (u[k] ? u[k].loc : null);
          const lNode = L("uNode"), lMat = L("uMat"), lH = L("uMeshH"), lCut = L("uCutoff"), lHas = L("uHasBase"), lAs = L("uAlphaScale"), lBase = L("uBase");
          if (lBase) gl.uniform1i(lBase, UB);
          gl.activeTexture(gl.TEXTURE0 + UB);
          let node = null, ib = null, base = undefined;
          for (const d of lists[mode]) {
            if (d.node !== node) { gl.uniformMatrix4fv(lNode, false, d.node); node = d.node; }
            gl.uniform1i(lMat, d.mat); gl.uniform1f(lH, d.h); gl.uniform1f(lCut, d.cut); gl.uniform1f(lAs, d.as);
            if (d.base !== base) { base = d.base; gl.uniform1f(lHas, base ? 1 : 0); if (base) gl.bindTexture(gl.TEXTURE_2D, base.tex); }
            gl.bindVertexArray(d.vao);
            if (d.ib !== ib || true) instAttrs(gl, d.ib);
            ib = d.ib;
            if (d.type) gl.drawElementsInstanced(d.prim, d.count, d.type, d.off, d.n);
            else gl.drawArraysInstanced(d.prim, 0, d.count, d.n);
          }
          gl.bindVertexArray(null);
        };
        gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
        /* 1. the shadow map, when the key light moved */
        if (redraw && shadowFb && R.p("coastShadow")) {
          redraw = false;
          R.bind(shadowFb); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
          gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(2, 4);
          drawAll(P.depth, 1, { uLightVP: R.coast.shadowVP });
          gl.disable(gl.POLYGON_OFFSET_FILL);
        }
        /* 2. the cove into SCENE + SCENEZ */
        R.bind("coast");
        drawAll(P.color, 0, {});
        /* 3. its mirror image */
        R.bind(mirrorFb); gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        if (R.p("coastMirror")) drawAll(P.color, 2, {});
        gl.disable(gl.DEPTH_TEST);
        gl.activeTexture(gl.TEXTURE31); gl.bindTexture(gl.TEXTURE_2D, mirror.tex); gl.generateMipmap(gl.TEXTURE_2D);
      },
    },
  };
})());
