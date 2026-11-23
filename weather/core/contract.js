/* ═══════════════════════ Weather lab: THE CONTRACT ═══════════════════════
   FROZEN. Owned by the lead designer ([1.2] in round 2, by the core agent); no workstream edits this file. A stream that needs a
   shared field writes the request in lab/notes/<stream>.md and uses its own reserved UBO
   slots (uA*, uB*, uC*, uE*) or private textures meanwhile. The merge step lands requests.

   What it fixes, and nothing else:
     1. the world frame, units and the camera framing rule          (WX.frameCamera)
     2. the frame-state object F the director hands the renderer     (WX.frameDefaults)
     3. the per-frame uniform block WxFrame, its packing and GLSL    (WX.UBO, WX.glsl.common)
     4. the contract textures: units, formats, who writes them       (WX.TEX)
     5. the slots a frame runs, in order, and which stage they are   (WX.SLOTS)
     6. the reading -> weather table on the served cut points        (WX.cuts, WX.weatherAt)
     7. the quality ladder                                           (WX.TIERS)
     8. [v1.1 scenery] the cove's shared data: the coast slot, the scene-distance, shore, sun-shadow,
        coast-reflection and sea-probe textures, the UBO fields after uE1, R.coast, the mesh vertex
        layout and the asset loader's API                         (WX.MESH, WX.ASSETS, WX.coastDefaults)
   The GLSL library functions each stream provides are listed in WX.LIBS (names, signatures,
   meaning); their bodies live in the owning stream's module.

   Version 1.1 (scenery, DESIGN.md 13) only ADDS: every v1.0 name, offset, unit and meaning holds,
   except that private texture units now start at 18 (WX.PRIVATE_UNIT0), because units 13-17 are
   the new contract textures.

   [1.2] Version 1.2 (round 2, landed by the core agent; CHANGES-2.md lists each change and who adopts
   it). It ADDS, and changes these meanings: uFlash*.w is normalised for the exposure (WX.flashI);
   WX.windAt loops on the sea's and the slow clocks; CLOUDZ is RG16F; the sea grid and T4's cloud
   update; WX.TIER_SCENERY.coastLod is gone. New: wxFlash/wxFlashE (one falloff for every receiver),
   the TAA jitter (WX.TAA, uTaa, uTaa1, the "taa" slot), the optional HDR and RAIN targets
   (pass.noTargets), section 9 (the core state the passes share), and the lab-only markers below.

   [1.2] LAB-ONLY MARKERS (WX.LAB_MARKERS). The merge deletes every span from an OPEN marker to the
   next CLOSE marker, both included. OPEN is the block comment whose text is exactly @lab, CLOSE the
   block comment whose text is exactly @end (slash, star, @lab, star, slash; written out here they
   would end this comment). The same two comments work in JS and inside a GLSL template string,
   because GLSL takes block comments too. Example, with [ ] standing for the comment delimiters:
     [@lab] R.debugTex("CLOUD", nxt.L, "hdr"); [@end]
     let k = .03; [@lab] k = R.p("post.bloomDay"); [@end]
   Rules: no nesting; never write a marker inside another comment or a string (build it by
   concatenation if code needs it); a span holds whole statements, declarations or GLSL lines, so
   what is left still parses and compiles; the product's value stays OUTSIDE the span and the lab's
   override inside it. Mark every lab-only knob read that has no product meaning, every debug view,
   probe, extra GPU timer, lab counter and console line. WX.param and R.p themselves stay (they become
   the constants table) and R.debugTex stays as a no-op, so an unmarked call still runs. Files that
   never merge (core/lab.js, index.html, run.cjs, serve.cjs, tests/, stub/) need no markers.
   `?strip=1` in the lab loads every module with its spans removed, as the merge will (index.html);
   `node tests/director/strip.cjs` checks that every merged file still parses and counts the bytes.

   Merge note: in index.html the first statement becomes `const WX = {};` inside makeWeather's
   scope; every module only ever refers to WX, so nothing else changes.                      */
var WX = (typeof window !== "undefined" && window.WX) || {};
if (typeof window !== "undefined") window.WX = WX;
WX.CONTRACT = "1.3.6";   // [1.3] additive: R.coast.lamps holds 4 lights; WX.TAA.hist is LINEAR-filtered; [1.3.1] the sea grid 8 px at T0-T2; [1.3.2] the storm's lightning nearer (CHANGES-3.md); [1.3.3] a day flash twice as bright, 3 a minute from 92.5 %; [1.3.4] T0 draws 1000 rain streaks, a strike after a long wait is seen; [1.3.5] T0-T1 split the world frame over two frames (worldSplit); [1.3.6] the Frame rate and Graphics card settings (hooks.fps, hooks.gpu, W.fps, W.gpu), Quality only sets the detail
WX.LAB_MARKERS = { open: "/" + "*@lab*" + "/", close: "/" + "*@end*" + "/" };   // concatenated: a literal here would be stripped

WX.mods = WX.mods || [];          // registered passes, in load order
WX.libs = WX.libs || {};          // GLSL libraries by name
WX.params = WX.params || {};      // lab-only tuning knobs (name -> {v, lo, hi, step, owner}); constants after the merge
WX.pass = function (def) { WX.mods = WX.mods.filter((m) => m.name !== def.name); WX.mods.push(def); return def; };
WX.lib = function (name, src) { WX.libs[name] = src; };
WX.param = function (name, v, lo, hi, step, owner) {
  if (!WX.params[name]) WX.params[name] = { v, lo, hi, step: step || (hi - lo) / 100, owner: owner || "" };
  return WX.params[name];
};

const wxClamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const wxLerp = (a, b, t) => a + (b - a) * t;
const wxSmooth = (a, b, x) => { const t = wxClamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
WX.util = { clamp: wxClamp, lerp: wxLerp, smooth: wxSmooth, D: Math.PI / 180 };

/* ── 1. World frame, units, camera ─────────────────────────────────────────────────────────
   World frame (every pass): metres, origin at mean sea level directly below the eye,
   +y up, +z the window's heading (horizontal, out to sea), +x to the right. Left-handed.
   The eye is at (0, 14, 0). Planet-centred km for the atmosphere and clouds:
   pKm = (x, y + 6 360 000, z) / 1000, planet centre at (0, -6360 km, 0).
   Light: linear Rec.709. 1.0 = 128 000 lux (illuminance) or 128 000 cd/m2 (luminance), "rel".
   HDR targets store rel * E (pre-exposure, uExpo.x). Every GLSL library function that returns
   light returns it pre-exposed; transmittances are unitless. fp16 writes clamp to 6e4, NaN -> 0.
   Directions to sun, moon and stars are unit vectors in the world frame.                    */
WX.EYE_M = 14;
WX.R_G = 6360; WX.R_T = 6460;      // km
WX.SUN_RADIUS = 0.004654;          // rad (0.2666 deg)

/* The framing rule. Hor+ in landscape (vFOV 50 deg, hFOV up to 100), Vert+ in portrait (hFOV
   50, vFOV up to 75). The horizon sits 44 % up the window at aspect >= 1.2 and 38 % at <= 0.8:
   the HUD's header and limit sit over the upper sky, the cost strip over the near sea, and the
   horizon, the sun's low path and the far sea are left clear between them.                  */
WX.frameCamera = function (cssW, cssH) {
  const D = Math.PI / 180, a = Math.max(cssW, 1) / Math.max(cssH, 1);
  let v, h;
  if (a >= 1) {
    v = 50 * D; h = 2 * Math.atan(Math.tan(v / 2) * a);
    if (h > 100 * D) { h = 100 * D; v = 2 * Math.atan(Math.tan(h / 2) / a); }
  } else {
    h = 50 * D; v = 2 * Math.atan(Math.tan(h / 2) / a);
    if (v > 75 * D) { v = 75 * D; h = 2 * Math.atan(Math.tan(v / 2) * a); }
  }
  const f = wxLerp(0.38, 0.44, wxClamp((a - 0.8) / 0.4, 0, 1));   // horizon, fraction of the height from the bottom
  const dip = Math.sqrt(2 * WX.EYE_M / 6.36e6);
  const pitch = Math.atan((1 - 2 * f) * Math.tan(v / 2)) - dip;
  const c = Math.cos(pitch), s = Math.sin(pitch);
  return { vfov: v, hfov: h, tanX: Math.tan(h / 2), tanY: Math.tan(v / 2), pitch, horizon: f, dip,
           right: [1, 0, 0], up: [0, c, -s], fwd: [0, s, c], eye: WX.EYE_M, near: 5, far: 60000 };
};
/* [1.2] The camera's basis is mirrored. The world frame is left-handed (right x up = forward), while
   GL's eye space is right-handed (it looks down -z), so uViewProj contains a reflection (det -1).
   Front faces: a triangle whose front is (b - a) x (c - a), the right-handed cross product (glTF's
   counter-clockwise convention), shows CLOCKWISE in the main view. Cull with gl.frontFace(gl.CW)
   there. A y-mirrored view (the cove's reflection in the sea plane, y -> -y) is a second reflection
   and shows the same triangle counter-clockwise, as does a proper (det +1) orthographic light box
   such as the cove's shadow map: gl.frontFace(gl.CCW) in those. The core resets CULL_FACE off and
   frontFace CCW before every pass's slot, so no culling state leaks from one pass into the next.

   [1.2] TAA jitter (DESIGN 6 / REVIEW-1 4.9). The camera never moves, but each world frame's picture
   is offset by a sub-pixel jitter: phase n of WX.TAA.phases (16) is Halton(2, 3) at index n + 1,
   minus .5, in px of the scene target S. The core draws it into uViewProj and uTaa.xy, so every ray
   built by wxRay and every point placed by wxUV, wxClipFlat or uViewProj moves with it (section 3).
   It is 0 unless a pass implements the "taa" slot (stream C's resolve), 0 in a still (F.still), and
   0 in every slot after "taa", which read the resolved, unjittered history as sScene. The phase
   advances once per world frame (R.worldIndex), so tiers that run the world every second frame
   jitter at the world's rate. WX.taaJitter(n, out) returns phase n's offset [x, y] in px.       */
WX.TAA = { phases: 16,
  /* the history: two RGBA16F S textures (ping-pong), private to the pass with the "taa" slot (stream
     C's post), made in its resize(). Its taa slot reads SCENE (jittered by uTaa.xy) and the history
     (made with uTaa.zw, valid when uTaa1.z > 0), writes the other history texture and sets R.taa.out
     to it; the core then binds R.taa.out as sScene for every later slot of the frame, and on frames
     that run the composite only. R.taa: { on, phase, jitter: [x, y], prev: [x, y], age, out } */
  /* [1.3] LINEAR-filtered (C's request): R.taa.out becomes sScene, which the bloom's bilinear taps and the
     pane's warped view lookups sample between texels */
  hist: "RGBA16F S x 2, LINEAR filtering, private to the taa slot's pass; R.taa.out is the resolved picture" };
WX.param("taa", 1, 0, 1, 1, "core");      // lab: 0 keeps the jitter off even with a taa slot (R.p("taa") is 1 after the merge)
WX.halton = function (i, b) { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
WX.taaJitter = function (n, out) {
  const o = out || [0, 0], i = (((n % WX.TAA.phases) + WX.TAA.phases) % WX.TAA.phases) + 1;
  o[0] = WX.halton(i, 2) - 0.5; o[1] = WX.halton(i, 3) - 0.5;
  return o;
};

/* The window's heading, degrees from north: west-south-west in the north, west-north-west in the
   south, due west near the equator. Afternoon sun and sunsets over the sea all year. */
WX.heading = (latDeg) => (Math.abs(latDeg) < 10 ? 270 : latDeg > 0 ? 250 : 290);
/* Follow real time off: a fixed late afternoon, the sun 8 deg up and 20 deg right of the middle. */
WX.FIXED_SKY = { sunEl: 8, sunRight: 20, moonEl: -30, moonRight: -60, lit: 0.6 };
/* a direction from elevation and degrees right of the view's centre, in the world frame */
WX.dirOf = function (elDeg, rightDeg) {
  const D = Math.PI / 180, e = elDeg * D, r = rightDeg * D;
  return [Math.sin(r) * Math.cos(e), Math.sin(e), Math.cos(r) * Math.cos(e)];
};

/* ── 2. Frame state F: director -> renderer, once per frame ───────────────────────────────
   The director (core/director.js) owns every field; the renderer never walks anything.
   Times and offsets are float64 in JS and arrive WRAPPED; nothing unbounded reaches a shader. */
WX.PERIOD = { ocean: 1024, rain: 240, twinkle: 600, slow: 3600, driftKm: 420, seaM: 840 };
WX.DRIFT_K = { weather: 1.0, shape: 0.8, cirrus: 1.8, curl: 0.3 };   // x the wind aloft
WX.frameDefaults = function () {
  return {
    dt: 1 / 60,                 // s since the last frame, <= 0.1
    world: true,                // run the world stage this frame (tiers T0/T1 run it every 2nd frame)
    still: false,               // a converged still: full cloud update, exposure converged, no flash, no motion
    tier: 2,                    // 0..4, an index into WX.TIERS
    dissolve: 1,                // 0..1: 1 = the new frame only; < 1 blends from post's snapshot
    snapshot: false,            // ask post to keep this frame's output as the dissolve source
    lockExposure: false,        // hold the exposure (a flash is live, or within 0.5 s of one)
    t: { ocean: 0, rain: 0, twinkle: 0, slow: 0 },              // s, each modulo WX.PERIOD
    drift: { weather: [0, 0], shape: [0, 0], cirrus: [0, 0], curl: [0, 0], sea: [0, 0] },  // km mod 420; sea m mod 840
    sun: { dir: WX.dirOf(8, 20), E: 1 },                        // E: illuminance at the top of the atmosphere, rel
    moon: { dir: WX.dirOf(-30, -60), E: 2.0e-6, lit: 0.6, radius: 0.00452, earthshine: 0 },
    star: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),     // equatorial unit vector -> world, column-major 3x3
    lat: 38,                                                    // deg, for the stars' pole height (already in star)
    W: WX.weatherAt(55, WX.cuts(null), null),                   // the walked weather (WX.weatherAt's output)
    flashes: [WX.noFlash(), WX.noFlash()],                      // two slots; I = 0 when unused
  };
};
/* [1.2] a flash slot: pos km (world frame), I the area light (uFlash*.w, normalised, WX.flashI), kind 0 in-cloud
   1 cloud-to-sea, seed, B the channel's brightness (it may restrike), age s; P the strike's nearness
   0.15..1 and level its envelope 0..1 (WX.flashLevel), so a reader that wants the strike's own strength
   (the bolt) never divides I by the peak: I already carries the exposure. */
WX.noFlash = () => ({ pos: [0, 1, 10], I: 0, kind: 0, seed: 0, B: 0, age: 0, P: 0, level: 0 });

/* [1.2] The strike's sky light (robust.md 4.2, render.md 9), moved here from the director so that the
   director and the lab share it. One envelope per strike: up in 33 ms, held 50 ms, down with tau 150 ms,
   0 by 0.77 s; starts >= 2.5 s apart and >= 1 s after the last envelope ended.
   I is the radiance, rel, of the patch of cloud base the strike lights (radius r0Km round its channel
   point; the sky draws it as the glow of render.md 9), and through wxFlash the light every surface gets.
   EXPOSURE-NORMALISED (REVIEW-1 4.1): I = min(peak, cap / E) x P x level(t), with E the exposure the
   frame is drawn at (R.exposure.E, uExpo.x). By day (E < cap / peak, about 420 since 1.3.3) it is the
   peak x P; at blue hour and at night the cap holds, so the pre-exposed I x E never passes cap x P:
   a flash cannot blow the frame up at any exposure, and a near strike still reads brighter than a far one
   (P stays a factor, as robust.md 4.2's exposure-normalised `E(t) P` has it). Post's flash limit
   (stream C) still bounds what reaches the screen.
   [1.3.3] peak 6e-4 (was 3e-4): by day a strike 5-15 km away lifted the view by 1.8-2.8 % (REVIEW-3 4: none seen in
   100 s at 96 %); with C's darker day storm and halo (e2f23f1) 7 of 11 strikes passed 3 % at 96 %, at 6e-4 9 of 11,
   every one in the view (out/director/r4/pk). It only changes exposures under cap / 3e-4 (~830, the day): at blue
   hour and at night the cap still holds I x E (photosensitivity re-run, notes/director.md "Round 4"). */
WX.FLASH = { gap: 2.5, rest: 1.0, attack: 0.033, hold: 0.05, tau: 0.15, end: 0.77, lock: 0.5,
             peak: 6e-4, cap: 0.25, r0Km: 1.5 };
WX.flashLevel = function (t) {
  const f = WX.FLASH;
  return t < 0 ? 0 : t < f.attack ? t / f.attack : t < f.attack + f.hold ? 1
    : Math.max(0, Math.exp(-(t - f.attack - f.hold) / f.tau) - 0.01) / 0.99;
};
WX.flashI = function (P, level, E) {
  const f = WX.FLASH;
  return (E > 0 ? Math.min(f.peak, f.cap / E) : f.peak) * P * level;
};

/* ── 3. The uniform block, std140, vec4 and mat4 only (binding point 0) ──────────────────── */
WX.UBO = [
  ["uViewProj", "mat4", "world m -> clip; near 5 m, far 60 km; for rasterised geometry"],
  ["uCamX", "vec4", "xyz right (unit), w tan(hFOV/2)"],
  ["uCamY", "vec4", "xyz up (unit), w tan(vFOV/2)"],
  ["uCamZ", "vec4", "xyz forward (unit), w eye height m"],
  ["uRes", "vec4", "xy scene target S px, zw 1/S"],
  ["uCss", "vec4", "xy canvas CSS px C, z devicePixelRatio, w render scale (S / device px)"],
  ["uCloudRes", "vec4", "xy cloud buffer px, zw 1/size"],
  ["uSun", "vec4", "xyz unit dir to the sun's apparent centre, w angular radius rad"],
  ["uSunInfo", "vec4", "x elevation rad, y TOA illuminance rel (1), z sin(elevation), w disc visible 0/1"],
  ["uMoon", "vec4", "xyz unit dir to the moon, w angular radius rad"],
  ["uMoonInfo", "vec4", "x elevation rad, y TOA illuminance rel (full ~2e-6), z lit fraction, w earthshine radiance rel"],
  ["uKey", "vec4", "xyz key light for clouds (sun above -6 deg, else moon), w its TOA illuminance rel"],
  ["uStar0", "vec4", "column 0 of equatorial -> world (xyz)"],
  ["uStar1", "vec4", "column 1"],
  ["uStar2", "vec4", "column 2"],
  ["uWx0", "vec4", "x cov 0..1, y type 0..1 (0 St, .2 Ns, .5 Cu, 1 Cb), z base km, w top km"],
  ["uWx1", "vec4", "x cirrus 0..1, y precip 0..1 (log rain), z rain mm/h, w visibility km"],
  ["uWx2", "vec4", "x U10 m/s incl. gust, y swell Hs m, z fog scale height km, w storm 0..1"],
  ["uWx3", "vec4", "x mist 0..1, y lightning presence 0..1, z wet 0..1, w night 0..1"],
  ["uWind", "vec4", "xy local wind, direction of travel (unit, world xz), z U10 incl. gust m/s, w gust factor"],
  ["uAloft", "vec4", "xy wind aloft, direction of travel (unit, world xz), z speed m/s, w unused"],
  ["uSwell", "vec4", "xy swell, direction of travel (unit, world xz), z period s, w Hs m"],
  ["uDrift0", "vec4", "xy weather-map layer offset km, zw shape-noise layer offset km (mod 420)"],
  ["uDrift1", "vec4", "xy cirrus layer offset km, zw curl layer offset km (mod 420)"],
  ["uDrift2", "vec4", "xy sea-surface drift m (mod 840), zw unused"],
  ["uTime", "vec4", "x ocean s (mod 1024), y rain s (mod 240), z twinkle s (mod 600), w slow s (mod 3600)"],
  ["uFrame", "vec4", "x frame index mod 65536, y cloud update phase 0..15, z world updates this frame 0/1, w dt s"],
  ["uJitter", "vec4", "xy R2 dither offset 0..1, z golden-ratio jitter 0..1, w frame parity 0/1"],
  ["uExpo", "vec4", "x E (pre-exposure), y E/E_prev, z EV100, w scotopic weight 0..1"],
  ["uFlash0", "vec4", "xyz flash centre km (world frame, camera-relative), w sky-light intensity I >= 0 ([1.2] exposure-normalised: WX.flashI, I x uExpo.x <= WX.FLASH.cap; light surfaces with wxFlash)"],
  ["uFlash0b", "vec4", "x kind (0 in-cloud, 1 cloud-to-sea), y seed 0..1, z channel brightness B >= 0, w age s"],
  ["uFlash1", "vec4", "second flash slot"],
  ["uFlash1b", "vec4", "second flash slot"],
  ["uTier", "vec4", "x tier 0..4, y still 0/1, z full cloud update 0/1, w dissolve 0..1"],
  ["uA0", "vec4", "reserved: sky stream (atmo, clouds, sky)"],
  ["uA1", "vec4", "reserved: sky stream"],
  ["uB0", "vec4", "reserved: ocean stream"],
  ["uB1", "vec4", "reserved: ocean stream"],
  ["uC0", "vec4", "reserved: pane and post stream"],
  ["uC1", "vec4", "reserved: pane and post stream"],
  ["uE0", "vec4", "reserved: director and night stream"],
  ["uE1", "vec4", "reserved: director and night stream"],
  /* [v1.1 scenery] appended: every offset above is unchanged */
  ["uShadowVP", "mat4", "world m -> the key light's shadow clip space over the cove (sun, or the moon below -6 deg)"],
  ["uShadow", "vec4", "x map ready 0/1 (0: wxSunShadow returns 1), y texel size m, z key light angular radius rad, w fade 0..1 (key light low or overcast)"],
  ["uWx4", "vec4", "x soak 0..1 (land wetness walker), y puddle 0..1 (standing water walker), zw unused"],
  ["uCoast", "vec4", "x cove presence 0..1 (0 until its meshes are up, then fades in over 2 s), y anchor and pier lights 0..1 (night), zw unused"],
  ["uShip", "vec4", "xyz the ship's waterplane centre m (world, at anchor, swinging), w yaw rad (bow direction, from +z toward +x)"],
  ["uShipB", "vec4", "x half-length m, y half-beam m, z draft m, w present 0/1 (the ocean keeps the water out of the hull)"],
  ["uF0", "vec4", "reserved: scenery stream"],
  ["uF1", "vec4", "reserved: scenery stream"],
  /* [1.2] appended: every offset above is unchanged */
  ["uTaa", "vec4", "xy the sub-pixel jitter the world slots draw with this frame, S px (-.5...5; 0 with TAA off, in a still, and in every slot after 'taa'), zw the previous world frame's (what the history was drawn with)"],
  ["uTaa1", "vec4", "x TAA on 0/1 (a pass implements the 'taa' slot), y jitter phase 0..15, z world frames of valid history (0: none; a build, resize, tier change, still or sky jump resets it), w unused"],
];
WX.UBO_OFFSET = {};
WX.UBO_FLOATS = (function () {
  let o = 0;
  for (const [name, type] of WX.UBO) { WX.UBO_OFFSET[name] = o; o += type === "mat4" ? 16 : 4; }
  return o;
})();

/* ── 4. Contract textures: fixed units, bound by the core before every slot ───────────────
   GLSL sampler names start with "s" (sScene, sRefl ...); library functions start with "wx".
   Units 0..17 are the contract's and are never rebound by a pass. Private textures use units
   18..31 (WX.PRIVATE_UNIT0; 16..31 before v1.1) and are bound by their pass right before its
   draw. A texture not yet provided reads as a 1x1 zero (SUNSHADOW: a 1x1 depth texture at 1.0,
   lit). Layouts marked "private" are known only to the owner's GLSL library; readers call the
   library, never the sampler. `type` is the GLSL sampler type when it is not sampler2D.       */
WX.TEX = {
  TRANS:   { unit: 0, s: "sTrans", owner: "atmo", fmt: "private", what: "transmittance LUT" },
  MS:      { unit: 1, s: "sMS", owner: "atmo", fmt: "private", what: "multiple-scattering LUT" },
  SKYVIEW: { unit: 2, s: "sSkyView", owner: "atmo", fmt: "private", what: "sky-view LUT, sun" },
  SKYMOON: { unit: 3, s: "sSkyMoon", owner: "atmo", fmt: "private", what: "sky-view LUT, moon" },
  AP:      { unit: 4, s: "sAP", owner: "atmo", fmt: "private", what: "aerial-perspective atlas" },
  AMBIENT: { unit: 5, s: "sAmbient", owner: "atmo", fmt: "private", what: "ambient texels" },
  CSHADOW: { unit: 6, s: "sCShadow", owner: "clouds", fmt: "private", what: "cloud shadow map" },
  CLOUD:   { unit: 7, s: "sCloud", owner: "clouds", fmt: "private", what: "cloud buffer (L, T)" },
  CLOUDZ:  { unit: 8, s: "sCloudZ", owner: "clouds", fmt: "RG16F", what: "[1.2] r the transmittance-weighted depth km of the cloud medium in front, g the kind of the ray the texel traced: 0 a sky ray, 1 a surface ray (it ended on the sea or the cove); read through wxCloudDepthAt / wxCloudAt" },
  SCENE:   { unit: 9, s: "sScene", owner: "core", fmt: "RGBA16F S", what: "pre-exposed HDR world: sky (sky slot), sea over it (ocean), bolts (bolt). [1.2] With TAA on, the slots after 'taa' (and frames that run the composite only) read the resolved history R.taa.out as sScene: unjittered, the same layout" },
  REFL:    { unit: 10, s: "sRefl", owner: "core", fmt: "RGBA16F S/2, full mips", what: "the sky as rendered, before the sea; written by the sky slot" },
  RAIN:    { unit: 11, s: "sRain", owner: "core", fmt: "RGBA16F S, premultiplied", what: "near rain streaks beyond the glass; cleared and written by the rain slot. [1.2] optional (pass.noTargets): the near streaks may instead draw inside the pane slot, and then RAIN is neither allocated, cleared nor read" },
  HDR:     { unit: 12, s: "sHDR", owner: "core", fmt: "RGBA16F S", what: "the view through the pane, pre-exposed; written by the pane slot. [1.2] optional (pass.noTargets): post may absorb the pane slot (pane + post fused), drawing the view through the glass to the canvas with its grade, and then HDR is neither allocated, written nor read" },
  /* [v1.1 scenery] */
  SCENEZ:  { unit: 13, s: "sSceneZ", owner: "core", fmt: "R32F S", what: "distance m along the pixel's ray to the cove's nearest opaque surface, 0 where there is none; the core clears it before the coast slot, the coast slot writes it (attachment 1 of R.target('coast')); read through wxSceneDist. [critic] In the shadow, atmo, clouds and sky slots it still holds the previous world frame's distances, exact for the static cove because the camera never moves: the clouds trace ends land rays there (DESIGN 13.3)" },
  SHORE:   { unit: 14, s: "sShore", owner: "coast", fmt: "private", what: "the cove's shore field, baked at load from the layout: distance to the waterline, depth, swell exposure, rockiness; read through wxShore" },
  SUNSHADOW: { unit: 15, s: "sSunShadow", type: "sampler2DShadow", owner: "coast", fmt: "private (depth, compare mode)", what: "the key light's depth over the cove; read through wxSunShadow" },
  COASTREFL: { unit: 16, s: "sCoastRefl", owner: "coast", fmt: "RGBA16F S/knobs.coastRefl, full mips", what: "the cove mirrored in the still sea plane y = 0, through the same scene uv as the direct view: rgb pre-exposed x coverage, a coverage; 0 where only sky; read through wxCoastRefl" },
  SEAPROBE: { unit: 17, s: "sSeaProbe", owner: "ocean", fmt: "RGBA16F 16x1", what: "for probe i of R.coast.probes: x the sea's height m, y dh/dx, z dh/dz, averaged over the probe's radius, w 0; written at the end of the ocean slot, read one frame later by the coast's vertex shaders through wxSeaProbe" },
};
WX.PRIVATE_UNIT0 = 18;
/* [1.2] Optional shared targets. A pass may declare `noTargets: ["HDR"]` and/or `["RAIN"]` in its WX.pass
   definition (a static field, read before the first allocation). The core then does not allocate that
   target: its sampler reads the 1x1 zero dummy, R.tex[name] is undefined, and R.target("hdr" | "rain")
   throws, so a stale draw into it fails loudly in the lab. Meant for stream C's fusion: post absorbs the
   pane slot (no HDR: one full-screen RGBA16F write and read fewer) and the near streaks draw in the pane
   slot (no RAIN). The slots stay in WX.SLOTS; a fused pass leaves "rain" (or "pane") empty.
   [1.2] Library textures (WX.LIBTEX, kept from round 1): a GLSL library's own texture, bound by the core
   before every slot at a fixed unit from 30 down (the night library's Milky Way map, sNightMW, is at 30;
   31 stays the passes' scratch unit). R.provideLib(sampler, tex) registers it; gl.js sets the sampler at
   link and G.uniforms steps over the unit. It counts toward a program's 16 samplers. */
WX.LIBTEX = WX.LIBTEX || {};
WX.LIBTEX_UNIT0 = 30;

/* ── 5. Slots, in order. World slots run when F.world; composite slots every frame ───────── */
WX.SLOTS = [
  ["shadow", "world", "clouds: the cloud shadow map (read by atmo's AP and sky-view, and the sea)"],
  ["atmo", "world", "atmo: LUTs when the air moved, sky-view, AP atlas, ambient"],
  ["clouds", "world", "clouds: trace 1/16 (or all, still), resolve, reprojection"],
  ["sky", "world", "sky: clears SCENE and depth, draws sky + space + sun + clouds + in-cloud flash; fills REFL"],
  ["coast", "world", "coast [v1.1]: the key light's shadow map when it moved; the cove (terrain, seabed, cliffs, rocks, pier, ship, buoy, plants) into SCENE + SCENEZ + depth; its mirror image into COASTREFL"],
  ["ocean", "world", "ocean: FFT and the sea over SCENE, depth-tested and depth-writing (v1.1: against the cove too; shallows and shore from SCENEZ and SHORE, the cove's reflection from COASTREFL, writes SEAPROBE)"],
  ["bolt", "world", "bolt: lightning channels into SCENE, depth-tested against the sea (and the cove)"],
  ["taa", "world", "[1.2] post (stream C): the TAA resolve of the jittered SCENE with its history into R.taa.out (WX.TAA); empty until C implements it, and while empty the jitter stays 0. After it the core binds R.taa.out as sScene and uTaa.xy reads 0"],
  ["bloom", "world", "post: blur/bloom pyramid from SCENE, exposure and scrim meters"],
  ["drops", "composite", "pane: drop simulation (CPU) and the drop height map"],
  ["rain", "composite", "rain: clears RAIN, near streaks"],
  ["pane", "composite", "pane: SCENE + RAIN through the glass (drops, film, mist) into HDR ([1.2] or, fused with post, through the grade to the canvas; and it may draw the near streaks itself: section 4, noTargets)"],
  ["post", "composite", "post: bloom add, scotopic, AgX, dither, dissolve, to the canvas ([1.2] fused: what is left after the pane slot)"],
];

/* The GLSL libraries: who provides what (signatures are the contract; stubs exist for all). */
WX.LIBS = {
  common: "core   (this file): UBO, samplers, wxRay, wxUV, wxClip, wxClipFlat, wxPlanet, wxLuma, wxGuard, hashes;" +
          " [1.2] wxRay0, wxUV0 (unjittered), wxUVPrev (the previous world frame's jitter), WX_FLASH_RGB," +
          " vec4 wxFlash(int k, vec3 pM), vec3 wxFlashE(vec3 pM, vec3 n): lightning as a light, one falloff for every receiver",
  atmo: "sky stream: vec3 wxTransmittance(float rKm, float mu); vec3 wxSunLight(vec3 pKm); vec3 wxMoonLight(vec3 pKm);" +
        " vec3 wxSky(vec3 dir); vec3 wxSunDisc(vec3 dir); vec4 wxAerial(vec3 dir, float dKm); vec3 wxAmbient(float up)",
  clouds: "sky stream: vec4 wxCloudAt(vec2 uv); float wxCloudDepthAt(vec2 uv); float wxCloudShadow(vec3 pM); float wxCloudShadowMean()." +
          " [1.2] wxCloudAt(uv) is for SURFACE pixels (the sea and the cove): it keeps only the buffer's surface-kind taps (CLOUDZ.g = 1)" +
          " and returns the cloud and rain medium in front of the surface, rgb pre-exposed in-scatter and a its transmittance; callers" +
          " composite L = (L_surface * ap.a + ap.rgb) * c.a + c.rgb (ap: wxAerial at the surface's distance). The sky composite reads" +
          " the buffer itself with sky-kind taps. It may return (0, 0, 0, 1) when uWx1.y (precip) is 0, and a caller may skip it then",
  night: "director stream: vec3 wxSpace(vec3 dir, float pxRad); [1.3] vec3 wxNightAmbient() (the clear night sky's mean radiance, pre-exposed: what it lights clouds and haze with), vec3 wxNightIn(vec3 dir, vec3 T) (that light scattered into a ray of transmittance T, to add beside wxSpace * T)",
  /* [v1.1 scenery] */
  coast: "scenery stream: vec4 wxShore(vec2 xzM) (x signed distance to the still-water line m, + seaward;" +
         " y still-water depth m, + below mean sea level, < 0 the land's height; z exposure to the open-sea swell 0..1;" +
         " w rockiness 0..1: rock, cliff or piling 1, sand 0); vec2 wxShoreNormal(vec2 xzM) (unit, horizontal, seaward);" +
         " float wxSunShadow(vec3 pM) (1 lit, 0 in the cove's shadow, for uKey, soft); float wxSceneDist(vec2 uv)" +
         " (m along the ray to the cove, 1e9 where none); vec4 wxCoastRefl(vec2 uv, float lod) (the cove in the mirror:" +
         " rgb pre-exposed premultiplied, a coverage)",
  ocean: "ocean stream: vec4 wxSeaProbe(int i) (x the sea's height m, y dh/dx, z dh/dz at probe i of R.coast.probes, last frame)",
};

/* ── 6. Reading -> weather, on the served cut points ──────────────────────────────────────── */
const wxNum = (v, d) => (typeof v === "number" && isFinite(v) ? v : d);
/* The warning floor, its quarter points, critical where it stands clear of the cap (as
   colourMarks draws it, and above the third quarter), and the cap. Derived, never invented. */
WX.cuts = function (th) {
  let warn = wxNum(th && th.warningFloorPercent, 70), cap = wxNum(th && th.exhaustedPercent, 100);
  if (!(warn > 0 && cap > warn)) { warn = 70; cap = 100; }
  const q = (k) => warn + ((cap - warn) * k) / 4;
  const c = wxNum(th && th.criticalPercent, NaN);
  const crit = isFinite(c) && c > q(3) && cap - c > 1.5 ? c : null;
  return { warn, s1: q(1), s2: q(2), s3: q(3), crit, cap };
};
/* columns of an anchor row */
WX.COLS = ["cov", "type", "base", "top", "cirrus", "rain", "U10", "swellHs", "vis", "flashes", "strikeKm", "cgShare"];
WX.ANCHORS = {
  //     cov   type  base  top   cirr  rain U10  swell vis  fl/min km  CG
  zero: [0.10, 0.50, 1.40, 2.2, 0.15, 0.0, 3, 0.80, 50, 0.0, 22, 0.00],
  warn: [0.70, 0.32, 1.00, 2.8, 0.55, 0.5, 9, 1.10, 20, 0.0, 22, 0.00],
  s1:   [0.84, 0.22, 0.80, 3.5, 0.40, 2.0, 12, 1.20, 10, 0.0, 22, 0.00],
  s2:   [0.93, 0.20, 0.65, 4.2, 0.20, 6.0, 15, 1.35, 5.5, 0.0, 22, 0.00],
  s3:   [0.97, 0.55, 0.55, 7.0, 0.00, 15, 19, 1.50, 3.0, 3.0, 12, 0.20],
  crit: [0.99, 0.85, 0.45, 10, 0.00, 28, 23, 1.65, 2.0, 5.0, 5, 0.40],
  cap:  [1.00, 1.00, 0.40, 11, 0.00, 40, 26, 1.80, 1.5, 8.0, 3, 0.50],
};
/* [1.3.2] the storm's lightning, nearer, more often and more often to the ground (REVIEW-3 4: at 96 % by day the
   table gave strikes ~14 km away, a fifth of them to the sea, and none was seen in 100 s on the dashboard). From
   92.5 %: 2.4 flashes a minute (was 1.5: with WX.lightning's cut waits, no gap over 55 s), median 12 km (was 22),
   20 % cloud-to-sea (was 0); critical (pro's 95 %) 5 km (8), 40 % (30 %); the cap 8 a minute, 3 km (4), 50 % (45 %).
   Max 20x at 96 % (critical folds into the cap): 5.0 a minute, 7.8 km, 34 % (was 4.5, 13.6 km, 21 %). strikeKm is the
   median distance (WX.lightning spreads it by e^(+-0.75), at least 2 km).
   [1.3.3] 92.5 % has 3.0 flashes a minute (was 2.4): with WX.lightning's see rule (a strike outside the view or faint
   for its distance is followed by one in it, near, strong and sooner), a strike the viewer can see comes in 97 % of
   the minutes at 92.5 %, 99 % at 93 %, and in every minute from 95 % (3 simulated hours a reading; round4.test.mjs). */
/* walk: { wet, bolt, mist, soak, puddle } walkers 0..1 (a missing one: at its target for v).
   Returns the W vector. [v1.1] soak and puddle are the land's: the director walks soak toward
   WX.soakTarget(precip) (15 s in, 40 s out) and puddle toward WX.puddleTarget(precip) (35 s in,
   40 s out), so wet rock, standing water and drying all reach a steady state within 2 min. */
WX.soakTarget = (precip) => wxSmooth(0.0, 0.35, precip);
WX.puddleTarget = (precip) => wxSmooth(0.45, 0.9, precip);
WX.weatherAt = function (v, cuts, walk) {
  const C = cuts || WX.cuts(null), A = WX.ANCHORS;
  const rows = [[0, A.zero], [C.warn, A.warn], [C.s1, A.s1], [C.s2, A.s2], [C.s3, A.s3]];
  if (C.crit !== null) rows.push([C.crit, A.crit]);
  rows.push([C.cap, A.cap]);
  const x = wxClamp(v, 0, C.cap);
  let i = 0;
  while (i < rows.length - 2 && x > rows[i + 1][0]) i++;
  const [x0, r0] = rows[i], [x1, r1] = rows[i + 1];
  const t = x1 > x0 ? wxClamp((x - x0) / (x1 - x0), 0, 1) : 1;
  const row = {};
  WX.COLS.forEach((k, j) => { row[k] = wxLerp(r0[j], r1[j], t); });
  row.vis = Math.exp(wxLerp(Math.log(r0[8]), Math.log(r1[8]), t));     // visibility: geometric
  const wet = walk && typeof walk.wet === "number" ? walk.wet : x >= C.warn ? 1 : 0;
  const bolt = walk && typeof walk.bolt === "number" ? walk.bolt : x >= C.s3 ? 1 : 0;
  const mist = walk && typeof walk.mist === "number" ? walk.mist : 0;
  const rain = (x >= C.warn ? row.rain : A.warn[5]) * wet;
  const flashes = (x >= C.s3 ? row.flashes : A.s3[9]) * bolt;
  const precip = Math.log10(1 + rain) / Math.log10(41);
  const soak = walk && typeof walk.soak === "number" ? walk.soak : WX.soakTarget(precip);
  const puddle = walk && typeof walk.puddle === "number" ? walk.puddle : WX.puddleTarget(precip);
  return {
    v: x, cov: row.cov, type: row.type, base: row.base, top: row.top, cirrus: row.cirrus,
    rain, precip,
    /* [critic] the swell's period is 1024/93 s (11.01 s), not 11: then 93 swells fill the sea's
       1024 s loop exactly, so any phase 2 pi t / uSwell.z (the swash, the spray bursts, a stub's
       swell) is continuous across the uTime.x wrap instead of jumping 0.57 rad every 17 min */
    U10: row.U10, swellHs: row.swellHs, swellT: 1024 / 93, vis: row.vis,
    fogH: 0.5 - 0.2 * wxSmooth(C.warn, C.cap, x),
    storm: wxSmooth(C.s2, C.cap, x),
    flashRate: flashes / 60, strikeKm: row.strikeKm, cgShare: row.cgShare,
    wet, bolt, mist, soak, puddle,
  };
};
/* wind and swell, relative to the view: the wind comes off the sea 20 deg left of the view and
   blows toward the window; the clouds aloft come from 30 deg left; the swell from 10 deg right.
   [1.2] It LOOPS, so a reading that sits flat repeats exactly and the hold tests can compare t0 with
   t0 + P. The local wind (its 10-degree meander and the three gusts, which drive the sea, the ship,
   the rain's slant and the trees) runs on whole cycles of the sea's 1024 s (WX.PERIOD.ocean): one
   meander cycle, gusts of 1024/140, 1024/78 and 1024/34 s (7.31, 13.13, 30.12 s; round 1 had 2820, 7.3,
   13.1, 29.7). The wind aloft's 25-degree meander runs one cycle of the slow clock's 3600 s.
   clock: F.t (the wrapped clocks: t.ocean for the local wind, t.slow aloft; what the director passes),
   or a number, the scene clock in s, unwrapped (each loop is periodic, so any float64 value works).
   out: an optional object of the returned shape, filled in place (no allocation per frame). */
WX.windAt = function (W, clock, out) {
  const D = Math.PI / 180, two = 2 * Math.PI;
  const num = typeof clock === "number";
  const tL = (two * (num ? clock : clock.ocean)) / WX.PERIOD.ocean, tA = (two * (num ? clock : clock.slow)) / WX.PERIOD.slow;
  const mLocal = 10 * Math.sin(tL), mAloft = 25 * Math.sin(tA + 1.3);
  const g = 1 + (0.05 + 0.15 * W.storm) * (0.5 * Math.sin(140 * tL) + 0.3 * Math.sin(78 * tL + 2) + 0.2 * Math.sin(34 * tL + 4));
  const o = out || { wind: { dir: [0, 0], U10: 0, gust: 1 }, aloft: { dir: [0, 0], speed: 0 }, swell: { dir: [0, 0], T: 0, Hs: 0 } };
  const from = (deg, d) => { d[0] = -Math.sin(deg * D); d[1] = -Math.cos(deg * D); return d; };   // direction of travel, world xz
  from(-20 + mLocal, o.wind.dir); o.wind.U10 = W.U10 * g; o.wind.gust = g;
  from(-30 + mAloft, o.aloft.dir); o.aloft.speed = wxLerp(8, 25, wxClamp((W.U10 - 3) / 23, 0, 1));
  from(10, o.swell.dir); o.swell.T = W.swellT; o.swell.Hs = W.swellHs;
  return o;
};

/* ── 7. The quality ladder. Knobs are uniforms or allocation sizes, never shader variants ──── */
WX.TIERS = [
  { name: "T0", px: 0.6e6, worldEvery: 2, worldBlend: 1, worldSplit: 1, cloudDiv: 3.0, cloudMaxPx: 0.07e6, cloudUpdate: 16, steps: 40, light: 4,
    fft: 128, cascades: 2, grid: 8, streaks: 1000, beads: 1000, sliders: 40, bloom: 4 },
  { name: "T1", px: 1.0e6, worldEvery: 2, worldBlend: 1, worldSplit: 1, cloudDiv: 2.5, cloudMaxPx: 0.16e6, cloudUpdate: 16, steps: 48, light: 5,
    fft: 128, cascades: 3, grid: 8, streaks: 2000, beads: 1500, sliders: 80, bloom: 5 },
  { name: "T2", px: 1.6e6, worldEvery: 1, worldBlend: 0, worldSplit: 0, cloudDiv: 2.0, cloudMaxPx: 0.40e6, cloudUpdate: 16, steps: 64, light: 6,
    fft: 128, cascades: 3, grid: 8, streaks: 4000, beads: 3000, sliders: 150, bloom: 6 },
  { name: "T3", px: 2.6e6, worldEvery: 1, worldBlend: 0, worldSplit: 0, cloudDiv: 2.0, cloudMaxPx: 0.65e6, cloudUpdate: 16, steps: 96, light: 6,
    fft: 256, cascades: 3, grid: 4, streaks: 6000, beads: 6000, sliders: 300, bloom: 6 },
  { name: "T4", px: 8.3e6, worldEvery: 1, worldBlend: 0, worldSplit: 0, cloudDiv: 1.0, cloudMaxPx: 2.1e6, cloudUpdate: 8, steps: 128, light: 7,
    fft: 256, cascades: 3, grid: 4, streaks: 12000, beads: 6000, sliders: 300, bloom: 6 },
];
/* [1.2] the sea grid (CSS px per cell) is 6 at T0-T2 and 4 at T3-T4 (round 1: 6, 5, 4, 4, 3): stream B
   measured Intel T2 at 2.17 -> 1.76 ms, as smaller triangles waste most of each 2 x 2 shading quad; T1
   follows T2 so the ladder stays monotone. [1.3.1] 8 at T0-T2 (B's round-3 request: Intel T2 golden 1.93 ->
   1.69 ms, storm 2.40 -> 2.13; the triangles near the window stay under 0.8 m, the normals are per pixel). T4's cloud buffer refreshes 1/8 of its pixels a world frame
   (cloudUpdate 8, round 1: 4), so the RTX T4 1080p sky stays under 1 ms in the slow clock state too
   (stream A's request); cloudUpdate is 4, 8 or 16.
   [1.3.2] worldBlend 1 (T0-T1, the tiers that draw the world every second frame): the core shows the mean of world
   frames n - 1 and n at the frame that draws n, and n at the next, so the world's motion is spread over the 60 Hz
   frames instead of holding two and jumping (renderer.js; REVIEW-3 6). Passes see nothing of it: sScene is that
   picture from the taa slot on.
   [1.3.4] T0 draws 1000 near rain streaks (was 0). Intel at 1280x820 now settles at T0 in fair weather and in a storm
   (notes/director.md, "Round 4", 3c), and a storm without falling rain was the loss that showed most. Measured on Intel
   T0 968x620 in a 96 % storm, 3 runs each: frame mean 3.69 (0) / 3.81 (1000) / 3.74 (2000) ms, within the runs' noise.
   [1.3.5] worldSplit 1 (T0-T1): the world frame's work is split over its two 60 Hz frames (renderer.js): the frame that
   starts world frame n draws the slots shadow to coast and shows n - 1; the next draws ocean to bloom with n's jitter
   (uFrame.z 1, uTaa as at a world frame, F.world false: F is that frame's own) and shows the in-between picture. On
   Intel T1 in a storm the world frame was 7.8 ms against 1.5 for the other, so the window's p95 was the world frames'
   tail; another iGPU client's frames (the desktop terminal) landing in one of them put it over 12 ms. */
/* [v1.1 scenery] knobs, merged into the tiers above (allocation sizes and uniforms, no variants):
   [1.2] coastLod is gone: the layout's instance table holds each piece's LOD per tier, and a tier-wide
   bias on top of it counted the tier twice (the coast pass reads the table, plus its lab knob coastLodBias)
   shadow     key-light shadow map size px (one cascade over the cove)
   pcss       0: 4-tap PCF at a fixed penumbra; 1: blocker search + 12-tap PCF (contact-hardening)
   coastRefl  COASTREFL divisor of S (2 = half size)       reflLod  extra LOD bias in the mirror
   veg        share of the plant instances drawn 0..1       shipShadow  the ship's own shadow map px (0 off)
   texPx      largest GPU texture side px; read at build only (a tier change never re-uploads)   */
WX.TIER_SCENERY = [
  { shadow: 1024, pcss: 0, coastRefl: 4, reflLod: 1, veg: 0.35, shipShadow: 0, texPx: 512 },
  { shadow: 1024, pcss: 0, coastRefl: 4, reflLod: 1, veg: 0.6, shipShadow: 0, texPx: 512 },
  { shadow: 1536, pcss: 0, coastRefl: 2, reflLod: 1, veg: 0.8, shipShadow: 512, texPx: 512 },
  { shadow: 2048, pcss: 1, coastRefl: 2, reflLod: 1, veg: 1.0, shipShadow: 1024, texPx: 1024 },
  { shadow: 2048, pcss: 1, coastRefl: 2, reflLod: 0, veg: 1.0, shipShadow: 1024, texPx: 1024 },
];
WX.TIERS.forEach((t, i) => Object.assign(t, WX.TIER_SCENERY[i]));
WX.BUDGET_MS = 6;     // average GPU ms per drawn frame, any GPU; p95 <= 2x

/* ── 8. [v1.1] The cove: what other streams share with the scenery stream ──────────────────
   R.coast = WX.coastDefaults() is made by the core with each renderer. The coast pass fills it in
   its ubo() hook (which runs before the core packs it) and its slot; the core packs uShadowVP,
   uShadow, uCoast, uShip and uShipB from it; the ocean reads probes, spray and (critic) lamps and
   writes SEAPROBE. Everything in it is bounded: positions are in the cove (|x|, |z| < 4 km), angles
   wrapped, and the ship only swings and rides at anchor, it never sails.                     */
WX.coastDefaults = function () {
  return {
    up: 0,                               // cove presence 0..1: 0 until the meshes are up, then 2 s to 1 (uCoast.x)
    lights: 0,                           // the ship's anchor light and the pier lantern 0..1 (uCoast.y)
    shadowVP: new Float32Array(16),      // world m -> key-light clip (uShadowVP)
    shadow: new Float32Array(4),         // ready 0/1, texel m, key light angular radius rad, fade 0..1 (uShadow)
    ship: { pos: [0, 0, 0], yaw: 0, halfL: 0, halfB: 0, draft: 0, on: 0 },   // waterplane (uShip, uShipB)
    probes: new Float32Array(64),        // 16 x (x m, z m, radius m, used 0/1): SEAPROBE's points, in this order
    nProbes: 0,
    spray: new Float32Array(128),        // 32 x (x, y, z m at a rock face's foot facing the swell, strength 0..1)
    nSpray: 0,
    /* [critic] the night lights, for the ocean's glints: 2 x (x, y, z m world, w intensity, 0 by day); 0 the
       ship's anchor light, 1 the pier lantern. A 2 px light in a S/4 mirror cannot lay the long broken
       streak a harbour light lays on rippled water; the ocean glints them as points.
       [1.2] w is the light's intensity in rel m^2 BEFORE the exposure: the illuminance it gives at 1 m,
       so a receiver at r m gets w / r^2 x uExpo.x (the coast writes 3e-4 for the anchor light and 2.5e-4
       for the lantern, times the lights' level and the cove's presence).
       [1.3] 4 x (x, y, z m, w): 0 the anchor light, 1 the pier lantern, 2 the ship's stern lantern, 3 the
       stern windows (as one light, at their middle). The coast fills them (F, round 3); the ocean glints
       every light the array holds (length / 4) and draws none of them from COASTREFL. A light with w = 0
       is off. Nothing draws a lamp into COASTREFL any more (a 1-2 texel light became a block in its mips). */
    lamps: new Float32Array(16),
    /* [1.2] SHORE's stamp: the coast adds 1 whenever SHORE's contents change (a bake, a restore), so a
       reader that derives something from SHORE (the ocean's swell travel-time field) reads it back again */
    shoreStamp: 0,
    /* [1.2] the cove's GPU memory in bytes (the governor and the merged page may read it): textures, mesh
       buffers, and its own render targets (shadow maps, COASTREFL); written by the coast pass */
    mem: { tex: 0, mesh: 0, targets: 0 },
  };
};
WX.SEAPROBES = 16;
WX.SPRAYS = 32;

/* The vertex layout every mesh program sees (WX.glsl.meshVS declares it). Attributes are bound
   with vertexAttribPointer straight onto the GLB's buffer views, as stored: no CPU decode, so
   KHR_mesh_quantization's SHORT/BYTE/USHORT (normalised or not) and FLOAT all work. The node's
   matrix (the dequantisation, and a variant's placement) is the uniform uNode, set per draw; the
   instance matrix comes after it. A material's KHR_texture_transform becomes its uUVXform.
     0 aPos     vec3  mesh units (uNode -> metres)  4..6 aInst0..2  instance: rows of the model matrix (world m <- metres)
     1 aNormal  vec3  unit                  7 aInstP        instance: x sky openness 0..1 (baked at load from the
     2 aUV      vec2                                            heightfield), y motion: 0 static, (0, 2) a plant's sway
                                                                weight, >= 2 ship or buoy (probe base + 2), z fade 0..1
                                                                (LOD cross-fade, dithered), w seed 0..1 (variation)
     3 aTangent vec4  optional; absent, the fragment shader builds the TBN from derivatives           */
WX.MESH = { aPos: 0, aNormal: 1, aUV: 2, aTangent: 3, aInst0: 4, aInst1: 5, aInst2: 6, aInstP: 7, INST_FLOATS: 16 };

/* The asset loader's API (core/assets.js, scenery stream) and the files it reads. The page
   fetches them relative to itself from weather/ (public/weather/ in the repo, served by
   src/server.js's allowlist), decodes images with createImageBitmap(blob) and nothing else:
   no <img>, no blob: or data: URL, no worker, no WebAssembly, no Draco, meshopt or Basis.
     L = WX.assets.loader(base)          base "weather/"
     L.manifest()  -> Promise<manifest>  manifest.json, schema WX.ASSETS.schema
     L.want(ids, { texPx, lods })        queue meshes (coarsest LOD first) then textures
     L.step(R, ms)                       once a frame: at most one GL upload, within ms of main thread
     L.mesh(id, lod) -> null | { prims: [{ vao, count, type, offset, mat }], xform: Float32Array(16), bounds }
     L.tex(file)   -> null | { tex, w, h, target }       L.progress -> { got, of, uploads, failed }
   A failed fetch or decode leaves that piece out (the cove draws without it), never throws.  */
WX.ASSETS = {
  base: "weather/",
  manifest: "manifest.json",
  /* public/weather/manifest.json, written by the stage step (lab/tests/scenery/stage.cjs) from the assets
     workflow's manifest: only what ships, every file listed with its size and sha-256 prefix */
  schema: {
    v: "1",
    models: "[{ id, name, authors, license, url, kind, bboxM: { min, max, size } (glTF space, y up, m), materials: [{ name, alphaMode, alphaCutoff, doubleSided }]," +
            " lods: [{ lod, file, triangles, vertices, bytes, px1At1080M }] (only the shipped ones), tex: { set: 512|1k, px, gpu: [T0..T4 px caps]," +
            " materials: { <name>: { basecolor, normal, orm: file, alphaCoverage?, alphaScale? } } } }]",
    terrain: "[{ id, layer: rock|wet rock|sand and pebbles|cliff-top grass, tileSizeM: [x, z], set, px, files: { albedo, normal, orm, height } }]",
    files: "{ <path under weather/>: { bytes, sha: first 8 hex of sha-256 } }: the server's allowlist; fetched as <path>?v=<sha>",
    format: "the workflow's notes: KHR_mesh_quantization (POSITION int16 norm + node T/S, NORMAL int8 norm, TEXCOORD_0 uint16 norm or float," +
            " stride 16 or 20, uint16 indices), EXT_texture_webp; normal maps OpenGL +y with glTF v down (negate green in a derivative frame);" +
            " orm R AO, G roughness, B metal; no tangents",
  },
  gpu: { base: "SRGB8_ALPHA8", nrm: "RG8 (z rebuilt)", orm: "RG8 (AO, roughness; metal 0) or RGBA8 where metal varies", mips: "generateMipmap", aniso: 8 },
};

/* ── 9. [1.2] The core's state that passes share (renderer.js makes it with each renderer) ────
   R.stats.uploads   a counter of the uploads that can stall a frame, counted by the core itself at the
                     GL calls (gl.js): every texImage2D/3D and texSubImage2D/3D with pixel data, and every
                     bufferData with data and STATIC_DRAW. Per-frame dynamic buffer updates (bufferSubData,
                     DYNAMIC/STREAM_DRAW) and the core's own UBO do not count. Nobody increments it by hand;
                     a pass compares it with last frame's value (post skips a readback in a frame that
                     uploaded). R.coast.loading.uploads is the coast's own, lab-only.
   R.meter           { grid, peak, avg, at }: grid Float32Array(32), the mean display luminance of a 4 x 8
                     grid, grid[row * 4 + col], row 0 at the top, flashes left out; peak Float32Array(32),
                     the same cells' brightest tap (a narrow bright feature, the sun's path on the water, is
                     diluted in the mean); at the time they were read. Written by post (stream C); the API
                     hands both to hooks.onScrim(grid, peak) at most twice a second; peak is null until post
                     fills it.
   R.exposure        { E, prev, EV, ... } as post writes it, and floor: the lowest EV' post's meter may
                     go to (default -4.5). The night library's ubo() hook lowers it toward -6 under a dark,
                     clear sky (stars visible, sun below -14 deg), so a moonless sky shows the Milky Way
                     at the default exposure (DESIGN 10.1 / notes/director.md); post (stream C) uses
                     max(EV', R.exposure.floor) in place of its constant.
   R.taa             { on, phase, jitter, prev, age, out } (WX.TAA). on: a pass implements the "taa" slot
                     (and the lab knob taa is not 0). out: set by that pass each world frame.
   R.sceneTex()      the texture sScene reads now (R.taa.out after the taa slot, else R.tex.SCENE): a pass
                     that passes SCENE to G.uniforms itself uses this, not R.tex.SCENE.
   R.coast.mem, R.coast.shoreStamp, R.coast.lamps: section 8.                                    */

/* ── GLSL: the common prelude every program starts with ──────────────────────────────────── */
WX.glsl = WX.glsl || {};
WX.glsl.common = `#version 300 es
precision highp float; precision highp int;
precision highp sampler2D; precision highp sampler3D; precision highp sampler2DArray; precision highp sampler2DShadow;
layout(std140) uniform WxFrame {
${WX.UBO.map(([n, t]) => "  " + t + " " + n + ";").join("\n")}
};
${Object.values(WX.TEX).map((t) => "uniform " + (t.type || "sampler2D") + " " + t.s + ";").join("\n")}
const float PI = 3.14159265358979;
const float R_G = ${WX.R_G.toFixed(1)};
const float R_T = ${WX.R_T.toFixed(1)};
#define wxEye (uCamZ.w)
/* the camera's own ray through scene uv (0..1, y up), world frame, with no jitter */
vec3 wxRay0(vec2 uv) {
  return normalize(uCamZ.xyz + (uv.x * 2. - 1.) * uCamX.w * uCamX.xyz + (uv.y * 2. - 1.) * uCamY.w * uCamY.xyz);
}
/* [1.2] the view ray through scene uv in this frame's picture: with the TAA jitter uTaa.xy (S px), the
   same offset uViewProj carries, so ray-built pixels (sky, clouds) and rasterised ones (cove, sea) move
   together. uTaa.xy is 0 with TAA off, in a still, and in every slot after "taa": then it is wxRay0 */
vec3 wxRay(vec2 uv) { return wxRay0(uv - uTaa.xy * uRes.zw); }
/* where a world direction lands on screen (uv 0..1); outside 0..1 when off screen or behind; no jitter */
vec2 wxUV0(vec3 d) {
  float z = dot(d, uCamZ.xyz);
  if (z <= 1e-4) return vec2(-1.);
  return vec2(dot(d, uCamX.xyz) / (z * uCamX.w), dot(d, uCamY.xyz) / (z * uCamY.w)) * .5 + .5;
}
/* [1.2] where it lands in this frame's (jittered) picture, the inverse of wxRay; and in the previous world
   frame's (uTaa.zw), for a texture drawn then (a history, last frame's SCENEZ) */
vec2 wxUV(vec3 d) { return wxUV0(d) + uTaa.xy * uRes.zw; }
vec2 wxUVPrev(vec3 d) { return wxUV0(d) + uTaa.zw * uRes.zw; }
vec4 wxClip(vec3 pM) { return uViewProj * vec4(pM, 1.); }
/* clip position with no depth (for geometry nearer than the 5 m near plane, never depth-tested);
   [1.2] with this frame's jitter, as uViewProj */
vec4 wxClipFlat(vec3 pM) {
  vec3 d = pM - vec3(0., wxEye, 0.);
  float z = dot(d, uCamZ.xyz);
  return vec4(dot(d, uCamX.xyz) / uCamX.w + 2. * uTaa.x * uRes.z * z, dot(d, uCamY.xyz) / uCamY.w + 2. * uTaa.y * uRes.w * z, 0., z);
}
vec3 wxPlanet(vec3 pM) { return vec3(pM.x, pM.y + R_G * 1000., pM.z) * 1e-3; }
float wxLuma(vec3 c) { return dot(c, vec3(.2126, .7152, .0722)); }
/* every fp16 write goes through this: NaN and Inf to 0, then clamped to 6e4 */
vec3 wxGuard(vec3 c) {
  if (any(isnan(c)) || any(isinf(c))) return vec3(0.);
  float m = max(max(c.r, c.g), c.b);
  if (!(m >= 0. && m < 1e30)) return vec3(0.);
  return clamp(c, 0., 6e4);
}
float wxSat(float x) { return clamp(x, 0., 1.); }
float wxRemap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }
uvec3 wxPcg3(uvec3 v) {
  v = v * 1664525u + 1013904223u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; return v;
}
vec3 wxHash33(vec3 p) { return vec3(wxPcg3(uvec3(ivec3(floor(p)) + 32768))) * (1. / 4294967296.); }
float wxHash13(vec3 p) { return wxHash33(p).x; }
float wxHash12(vec2 p) { return wxHash33(vec3(p, 17.)).x; }
vec2 wxHash22(vec2 p) { return wxHash33(vec3(p, 29.)).xy; }
/* interleaved gradient noise (Jimenez 2014), per pixel */
float wxIGN(vec2 px) { return fract(52.9829189 * fract(dot(px, vec2(.06711056, .00583715)))); }
float wxHG(float c, float g) { float g2 = g * g; return (1. - g2) / (4. * PI * pow(max(1. + g2 - 2. * g * c, 1e-4), 1.5)); }
/* [1.2] Lightning as a light (WX.FLASH): ONE falloff for every receiver, so the cliffs and the sea get the
   same light from the same strike. Flash slot k (0 or 1) is the patch of cloud the strike lights, of
   radiance I = uFlash<k>.w (already exposure-normalised by the director) and radius r0 = ${WX.FLASH.r0Km} km
   round its channel point uFlash<k>.xyz km: the disc the sky draws as the strike's glow. At r km from
   it a surface facing it gets the on-axis disc's illuminance pi I r0^2 / (r^2 + r0^2) (3.1 I near the
   channel, 1.1 I at 2 km, 0.39 I at 4 km), pre-exposed (x uExpo.x).
   wxFlash: xyz the unit direction from pM toward the channel point, w that illuminance (0: slot idle).
   wxFlashE: both slots' irradiance on a surface of unit normal n at pM, coloured; n = vec3(0.) means
   facing each flash (a medium: rain, spray, cloud). Specular receivers loop over wxFlash for the
   direction. Lambertian radiance is wxFlashE(p, n) * albedo / PI. */
const vec3 WX_FLASH_RGB = vec3(.75, .82, 1.);
vec4 wxFlash(int k, vec3 pM) {
  vec4 f = k == 0 ? uFlash0 : uFlash1;
  if (f.w <= 0.) return vec4(0., 1., 0., 0.);
  vec3 l = f.xyz * 1000. - pM;
  float r = max(length(l), 1.), rk = r * 1e-3, r02 = ${(WX.FLASH.r0Km * WX.FLASH.r0Km).toFixed(4)};
  return vec4(l / r, f.w * uExpo.x * PI * r02 / (rk * rk + r02));
}
vec3 wxFlashE(vec3 pM, vec3 n) {
  float e = 0.;
  bool facing = dot(n, n) < .5;
  for (int k = 0; k < 2; k++) {
    vec4 f = wxFlash(k, pM);
    e += f.w * (facing ? 1. : max(dot(n, f.xyz), 0.));
  }
  return e * WX_FLASH_RGB;
}
/* ray / sphere around the planet centre: distance to the far (x) and near (y) hits, or -1 */
vec2 wxSphere(float r, float mu, float R) {
  float b = r * mu, c = r * r - R * R, d = b * b - c;
  if (d < 0.) return vec2(-1.);
  float s = sqrt(d);
  return vec2(-b + s, -b - s);
}
`;
/* [v1.1] the vertex prelude of every mesh program (after the common prelude), WX.MESH's layout */
WX.glsl.meshVS = `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUV;
layout(location = 3) in vec4 aTangent;
layout(location = 4) in vec4 aInst0;
layout(location = 5) in vec4 aInst1;
layout(location = 6) in vec4 aInst2;
layout(location = 7) in vec4 aInstP;
/* the GLB node's matrix (KHR_mesh_quantization's dequantisation and the node's placement in the
   file), applied before the instance's: identity for geometry already in metres. Every draw sets it. */
uniform mat4 uNode;
vec3 wxNodePos(vec3 p) { return (uNode * vec4(p, 1.)).xyz; }
vec3 wxNodeNormal(vec3 n) { return normalize(mat3(uNode) * n); }
/* the instance's model matrix (world m <- the asset's metres), and its normal matrix */
vec3 wxInstPos(vec3 p) { vec4 q = vec4(p, 1.); return vec3(dot(aInst0, q), dot(aInst1, q), dot(aInst2, q)); }
vec3 wxInstNormal(vec3 n) { return normalize(inverse(mat3(aInst0.xyz, aInst1.xyz, aInst2.xyz)) * n); }
/* the sea's curvature at world xz: the cove is laid out flat and lowered by this, as the curved sea is */
float wxDrop(vec2 xz) { return dot(xz, xz) / (2. * R_G * 1000.); }
`;
WX.glsl.fullscreenVS = `
layout(location = 0) in vec2 aPos;
out vec2 vUV;
void main() { vUV = aPos * .5 + .5; gl_Position = vec4(aPos, 0., 1.); }
`;
