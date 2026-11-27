/* post (stream C): the taa slot and the bloom slot (world stage), the post slot (every frame), and the
   "grade" GLSL library (AgX, the rods) that the rain's streaks share.

   taa     [1.2] the resolve of the jittered SCENE (WX.TAA): the history at the same pixel (the camera
           never moves), re-exposed by E / E_prev and clipped toward the centre of the current
           neighbourhood's box ([r6] the pixel and its 8 neighbours; min/max intersected with mean +- post.taaSig sigma, in
           YCoCg of a reversible tonemap c / (1 + Y), so a sun glint cannot stretch the box), blended at max(1 / (age + 1),
           0.1, up to 0.3 where the history was clipped hard; [r6] post.taaDamp where the change lies inside the
           neighbourhood's own spread) with inverse-luma weights; the view sharpens the
           resolved picture a little (4 taps, the jitter's box blur). After it the bolt pass draws the lightning, unjittered, over the
           resolved picture: a channel is never averaged with the frames before it.
   bloom   R.sceneTex() -> a down chain of knobs.bloom levels (S/2 ... S/64) in ONE mipped R11G11B10F
           texture (Jimenez 2014's 13 taps; level 0 with a partial Karis average and wxGuard), an up chain
           of tents blended by the normalised weights (.35 .25 .18 .12 .06 .04), both left in R.priv.pyr
           for the pane and the rain. The exposure meter: the log-average of the S/32 level, 16 x 12
           taps, the horizon band weighted 1.5x, and the clear sky's reference, into one texel of a
           5 x 8 RGBA32F meter target.
   post    [1.2] FUSED with the pane (contract section 4, noTargets HDR and RAIN): the view through the
           glass (pane's "pane" library), the bloom (0.03 by day, 0.02 at night), the rods, AgX with a look
           of power 1.1 and saturation 1.1, TPDF dither per channel (+-1.75 LSB), the dissolve, straight
           to the canvas; then the near rain streaks over it (rain.js, in display space, masked by the
           drops and the mist). The scrim grid (4 x 8 cells of display luminance, row 0 at the top: the
           mean and the brightest of 64 taps) goes into the meter target's first four columns.
   READBACK  never waits: <= 4 Hz, one readPixels of the 5 x 8 meter target into a ring of four PBOs,
           a fence per request polled with clientWaitSync(s, 0, 0), getBufferSubData only once it has
           signalled, all in the ubo() hook (before the first slot, outside every timer); never in a
           frame right after an upload (R.stats.uploads moved) or under a flash.
   EXPOSURE  render.md 12.1: EV100 = log2(L 100 / 12.5); EV' = EV + 3 (1 - smooth(-2, 16, EV)), [r4] + 1 more
           stop under a storm at night (post.nightStorm: a night strike lights a dark scene). [r4] A storm by
           day is not metered back up to a fair day's grey: of the deficit d = EV'(clear sky at this sun, a
           table measured on clear frames) - EV'(meter) the deck makes, the exposure leaves post.stormKeep x w
           in the picture (w from the rain and the storm, 0 below heavy rain), at most post.stormMax stops: the
           eye adapts to only part of a storm's gloom. So the darkness the sky draws shows through instead of
           being metered away (round 3: a storm 3.7 stops under a fair day's scene was metered to 0.87 stops
           darker on screen); then max(EV', R.exposure.floor) (the night library lowers the floor under a
           dark, starry sky). E = key 128000 / (1.2 2^EV'), adapting
           with tau 1.0 s up and 2.5 s down in real time on world frames, frozen under a flash, snapped
           by the first reading and in every still.
   FLASH LIMIT  [1.2] every world frame without a flash keeps the picture's 16 x 16 px block means,
           relative to E (the reference; the first one is the first metered frame, and a meter reading
           stands in before it). Under a flash (F.lockExposure) the same blocks give a limit map: per
           block the factor k <= 1 that holds its display luminance (through AgX) at most post.flashCap
           over the reference, found by bisection. The map scales the bloom's input (level 0 of the down
           chain, so a blown scene can never blur the frame) and the pane's sharp view of SCENE. A thin
           channel barely moves a block, so it stays white.                                       */
WX.lib("grade", `
vec3 agxCurve(vec3 x) { vec3 x2 = x * x, x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + .4298 * x2 + .1191 * x - .00232; }
/* scene-referred linear Rec.709 (pre-exposed) -> display-encoded: AgX (Wrensch's fit) with the look
   (power 1.1, saturation 1.1, render.md 12.3) between the curve and the outset */
vec3 agx(vec3 v) {
  const mat3 M = mat3(.842479062253094, .0423282422610123, .0423756549057051, .0784335999999992, .878468636469772, .0784336, .0792237451477643, .0791661274605434, .879142973793104);
  const mat3 Mi = mat3(1.19687900512017, -.0528968517574562, -.0529716355144438, -.0980208811401368, 1.15190312990417, -.0980434501171241, -.0990297440797205, -.0989611768448433, 1.15107367264116);
  const float lo = -12.47393, hi = 4.026069;
  v = M * max(v, vec3(1e-10)); v = clamp(log2(v), lo, hi); v = (v - lo) / (hi - lo);
  vec3 d = clamp(agxCurve(v), 0., 1.);
  float l = dot(d, vec3(.2126, .7152, .0722));
  d = pow(d, vec3(1.1));
  d = l + 1.1 * (d - l);
  return Mi * d;
}
/* [r5] THE HUE-PRESERVING SHOULDER. AgX's per-channel curve takes any colour toward white as it climbs its shoulder (its path
   to white: right for a bright cloud, wrong for a setting sun: the disc read as a pale peach smudge at the sky's own level
   and as a cream dot above it, REVIEW-4 #2; and the oil lamps' glow at night). Above the level uHP.y the colour's chroma
   is frozen at the one AgX gives it at that level (the max channel softly clamped there), while its brightness keeps
   AgX's own max channel: a disc far over the top stays orange with its red at the top of the range, and the bright sky
   round a low sun keeps the deep orange of a sunset photograph instead of a pastel peach. Far over the top (uHP.w, log2
   over mid-grey) AgX's path to white comes back (a lamp at 1e4 is a white point in a coloured glow). Smooth: below half
   the level nothing changes. uHP: x the strength (a low sun, the night; 0 by day: fair weather and golden hour keep
   AgX's look), y the level (pre-exposed), w the path to white */
uniform vec4 uHP;
vec3 agxHP(vec3 v) {
  vec3 d = agx(v);
  if (uHP.x <= 0.) return d;
  float m = max(max(v.r, v.g), max(v.b, 1e-10));
  /* [r5] saturated colours only (a low sun, the sky round it, an oil lamp): a near-neutral highlight (the lightning's
     blue-white core, the moon, a lit cloud) keeps AgX's path to white; frozen at the 1.6 chroma the night bolt's core
     read (236, 243, 254) instead of clipped white */
  float hs = uHP.x * smoothstep(.35, .65, 1. - min(min(v.r, v.g), v.b) / m);
  if (m < .5 * uHP.y || hs <= 0.) return d;
  float q = m / uHP.y;
  vec3 a = agx(v / pow(1. + q * q * q * q, .25));
  vec3 h = a * (max(d.r, max(d.g, d.b)) / max(max(a.r, max(a.g, a.b)), 1e-6));
  return mix(d, mix(h, d, smoothstep(uHP.w, uHP.w + 2.5, log2(m / .18))), hs);
}
/* the rods (Kirk and O'Brien 2011, simplified): at low absolute luminance colour moves toward a cool
   grey; per pixel, so a lantern at night keeps its colour. on: 0 in a bright scene */
vec3 scotopic(vec3 c, float on) {
  if (on <= 0.) return c;
  float Y = wxLuma(c), La = Y / max(uExpo.x, 1e-20) * 128000.;
  float w = 1. - smoothstep(-2., .6, log(max(La, 1e-9)) * .4342945);
  return mix(c, Y * vec3(.78, .9, 1.15), .85 * w * min(on, 1.));    // [r6] on: a weight (the scene's eased Lavg 300-500)
}
/* [r3] the weather's own look, before AgX. uWB: a partial white balance (a camera's, or the eye's chromatic
   adaptation) that rain and storms engage, so a deck lit by a low sun does not grade to brown mud. uTone: x a
   boost (linear), y a pivot and z a power below it: a storm's darkening moved from the exposure into a curve
   pivoted 2.5 stops over the frame's mean, so the mid-tones sink as before while foam, spume and lightning
   keep their place near the top of the curve; w the view's local contrast (pane.js). x <= 0: none */
uniform vec4 uTone;
uniform vec4 uWB, uWB2;     // xyz the white balance in the shadows, w a saturation; xyz in the highlights, w the frame's mean
uniform vec4 uWB3;          // [r4] x the sky/ground split's strength (a low sun under a deck), y the horizon (uv.y), z the ground's
                            // desaturation (blue hour: the sea and the land go to slate while the sky keeps the hour's blue), w the
                            // ground's cool lean
/* the balance leans on the shadows: the sea, the cliffs and the deck's undersides go neutral to cool while the
   bright sky toward the low sun keeps its warmth (colour separated by light, as the eye's local adaptation sees a
   stormy sunset), instead of one brown cast over everything */
/* [r4] ground (0 sky .. 1 sea and land, < 0 unknown: by luminance only): under a deck lit by a low sun (d: the sky, the
   sea and the cliffs all one pink-mauve; x16: a purple murk) the eye adapts to the ground's light, so the sea and the land
   take the shadows' balance (neutral to cool) while the sky keeps the highlights' (its warmth or its blue): colour
   separated by surface, as a colourist's sky mask */
vec3 toneWB(vec3 c, float ground) {
  if (uTone.x <= 0.) return c;
  float Y = wxLuma(c), w = smoothstep(.6, 4., Y / max(uWB2.w, 1e-9));
  if (ground >= 0.) w = mix(w, 1. - ground, uWB3.x);
  c *= mix(uWB.xyz, uWB2.xyz, w) * (ground > 0. ? mix(vec3(1.), vec3(.96, 1., 1.06), uWB3.w * ground) : vec3(1.));
  float Y2 = wxLuma(c);
  return max(Y2 + (c - Y2) * uWB.w * (1. - uWB3.z * max(ground, 0.)), vec3(0.));
}
vec3 toneCurve(vec3 c) {
  if (uTone.x <= 0.) return c;
  c *= uTone.x;
  if (uTone.z > 0.) { float t = wxLuma(c) / uTone.y; c *= pow(max(t, 1e-6) / pow(1. + t * t * t * t, .25), uTone.z); }
  return c;
}
/* the white balance on the scene's light (as a camera's on its raw data), then the rods, the curve, AgX */
vec3 gradeG(vec3 c, float scot, float ground) { return clamp(agxHP(toneCurve(scotopic(toneWB(wxGuard(c), ground), scot))), 0., 1.); }
/* [r5] the same with a glare added past the rods: the glare is a bright source's own light scattered in the eye and the lens
   (photopic), so a lantern's glow keeps the lantern's orange; through the rods the faint glow read as a cool grey (x04b).
   It takes the highlights' white balance */
vec3 gradeGA(vec3 c, vec3 a, float scot, float ground) {
  vec3 s = scotopic(toneWB(wxGuard(c), ground), scot) + (uTone.x > 0. ? a * uWB2.xyz : a);
  return clamp(agxHP(toneCurve(s)), 0., 1.);
}
/* [L r8] and with a lamp's own light (lamp, pre-exposed) taken out of the rods' shift and added back with the glare: the
   cones see a lamp, its glow and its beams (a crimson light read as a mauve dot at the night cap, REVIEW-7 2.4: its dim
   glow went through the rods with the night around it); the Purkinje shift stays with the dim surroundings. With lamp 0
   it is gradeGA to the bit */
vec3 gradeGL(vec3 c, vec3 lamp, vec3 a, float scot, float ground) {
  vec3 s = scotopic(toneWB(wxGuard(c), ground), scot) + (uTone.x > 0. ? (a + lamp) * uWB2.xyz : a + lamp);
  return clamp(agxHP(toneCurve(s)), 0., 1.);
}
vec3 grade(vec3 c, float scot) { return gradeG(c, scot, -1.); }
/* [r4] how much of the pixel at uv is ground: the sea (from uWB3.z under the horizon down) and the near land */
float gradeGround(vec2 uv) {
  if (uWB3.x <= 0.) return -1.;
  float z = texture(sSceneZ, uv).r;
  return max(1. - smoothstep(uWB3.y - .06, uWB3.y + .004, uv.y), z > 0. ? smoothstep(4000., 600., z) : 0.);
}
/* linear display luminance of a pre-exposed colour */
float gradeY(vec3 c, float scot) { return wxLuma(pow(grade(c, scot), vec3(2.2))); }
`);
WX.pass((function () {
  WX.param("post.key", 2.1, 0.25, 6, 0.05, "post");            // exposure calibration (robust.md 6.3's bands)
  WX.param("post.bloomDay", 0.03, 0, 0.2, 0.005, "post");
  WX.param("post.bloomNight", 0.02, 0, 0.2, 0.005, "post");
  WX.param("post.flashCap", 0.18, 0, 1, 0.01, "post");          // the most a 16 px block may brighten under a flash ([r5] by day, away from the strike)
  WX.param("post.flashCapNight", 0.003, 0, 1, 0.001, "post");  // [r5] ... at night, away from the strike (a dark frame round a lit cloud)
  /* [r6] .6 -> .45: the night CG on Intel T1 (REVIEW-5: far +8.8, ratio 10) with A's round-6 sky reads far +6.3, sky far +7.9,
     ratio 14.9 but a mean lift of +21.2 (E's yardstick +12-20); at .45 far +5.0, sky far +6.2, ratio 16.7, mean +18.2 */
  WX.param("post.flashRelNight", 0.45, 0, 4, 0.05, "post");     // [r5] ... plus this many times the block's own pre-flash luminance (1: one stop)
  WX.param("post.flashCore", 0.32, 0, 1, 0.01, "post");         // [r5] ... on the lit core where the channel leaves the base
  WX.param("post.flashCoreKm", 0.8, 0.1, 4, 0.05, "post");      // [r5] the lit core's radius (a gaussian on screen at its distance)
  WX.param("post.flashKnee", 0.5, 0, 1, 0.05, "post");          // [r5] the share of the cap passed unchanged; above it a soft knee
  WX.param("post.stormKeep", 0.5, 0, 1, 0.01, "post");          // [r4] by day, the share of a storm's deficit under the clear sky kept on screen
  WX.param("post.stormMax", 2.5, 0, 4, 0.05, "post");           // [r4] at most this many stops of it
  WX.param("post.nightStorm", 1.0, 0, 2, 0.05, "post");         // [r4] stops more of evComp's dark-end compensation under a storm at night
  WX.param("post.clearCal", 1, 0.05, 20, 0.01, "post");          // scales the clear-sky table
  WX.param("post.taaAlpha", 0.1, 0.02, 1, 0.01, "post");        // the current frame's least weight in the resolve
  /* [r6] the far sea "flickering" (the user, Intel T1 at DPR 1.33): the jitter's cycle came through the resolve as a 9.4 Hz
     line (18.75 Hz with a 60 Hz world) on the far sea's thin streaks, gone with the TAA off. The history was clipped to a
     5-tap cross's mean +- 1 sigma, a box that moves with the jittered samples; a 3 x 3 box at 2 sigma and a slower blend
     where the change lies inside the neighbourhood's own spread take ~40 % off the far band and half off the mid sea */
  WX.param("post.taaSig", 2, 0.5, 4, 0.05, "post");              // [r6] the history's box: the 3 x 3 mean +- this many sigma (and min/max)
  WX.param("post.taaDamp", 0.04, 0, 0.2, 0.005, "post");        // [r6] the least weight where the change is inside the spread
  /*@lab*/ WX.param("post.taa9", 1, 0, 1, 1, "post"); /*@end*/   // [r6] lab: 0 the round-5 cross (to time the 4 more taps)
  WX.param("post.taps13", 3, 0, 5, 1, "post");                 // [r3] the lowest tier whose bloom level 0 takes 13 taps (below: 4)
  WX.param("post.wb", 0.7, 0, 1, 0.05, "post");                 // [r3] the white balance's strength in heavy rain
  WX.param("post.curve", 1.2, 0, 3, 0.05, "post");              // [r3] stops of a storm's darkening moved into the curve
  WX.param("post.clarity", 0.3, 0, 1, 0.01, "post");            // [r3] the view's local contrast in heavy rain
  WX.param("post.rainSat", 0.2, 0, 1, 0.01, "post");            // [r3] saturation given back in heavy rain
  WX.param("post.overWB", 0.6, 0, 1, 0.05, "post");             // [r4] the white balance under a deck lit by a low sun (sunset, blue hour)
  WX.param("post.split", 0.8, 0, 1, 0.05, "post");              // [r4] ... its sky/ground split (the sea and the land balanced, the sky kept)
  WX.param("post.groundCool", 0.4, 0, 1, 0.05, "post");         // [r4] ... the ground's cool lean
  WX.param("post.stormCool", 1, 0, 2, 0.05, "post");            // [r4] a storm's cool slate lean
  WX.param("post.hp", 1, 0, 1, 0.05, "post");                  // [r5] the hue-preserving shoulder's strength (a low sun, the night)
  WX.param("post.hpLevel", 1.6, 0.2, 20, 0.05, "post");         // [r5] ... the level (pre-exposed) where AgX's chroma is frozen
  WX.param("post.hpWhite", 9, 0, 16, 0.1, "post");              // [r5] ... where AgX's path to white comes back (log2 over mid-grey; ~90 pre-exposed)
  WX.param("post.sunKey", 2, 0, 3, 0.05, "post");               // [r5] at most this many stops under the meter while a low sun is in the view (the photographer's sunset exposure)
  WX.param("post.sunRing", 0.8, 0.2, 8, 0.05, "post");          // [r5c] ... stopped down until the sky ~1 deg round the disc sits here, pre-exposed (0.25 deg: ~.7 stop, 1 deg: ~2)
  WX.param("post.glare", 0.03, 0, 0.2, 0.001, "post");          // [r5] the glare of the brightest sources (a low sun, lamps at night): its gain in the view
  WX.param("post.glareT", 128, 1, 4000, 1, "post");            // [r5] ... its threshold round a low sun: a source's energy in a 4 x 4 px window, pre-exposed (the sky round the sun ~40-60)
  WX.param("post.glareTNight", 40, 1, 4000, 1, "post");         // [r5] ... at night (the lamps; not the moon's disc ~23, the stars ~10, the glints of a lamp's streak ~22)
  WX.param("post.glareMax", 1500, 1, 1e5, 1, "post");           // [r5] ... a source's energy counts at most this (a moonless night's lantern is ~4000+)
  WX.param("post.glareTau", 0.6, 0, 4, 0.05, "post");          // [r5b] ... the glare's time constant, s (a lantern's glow is steady)
  WX.param("post.sunVis", 2.5, 1, 20, 0.1, "post");             // [r5b] the disc over the sky round it at which a low sun counts as seen (sunKey, its glare)
  /*@lab*/ WX.param("post.rb", 1, 0, 2, 1, "post"); /*@end*/     // lab: 0 no readback at all
  /*@lab*/ WX.param("post.dbg", 0, 0, 1, 1, "post"); /*@end*/    // lab: [r5] 1 the view's pre-exposed colour before the grade, log2 encoded ((log2 + 12) / 24)
  const RING = 4, PERIOD_MS = 250, W6 = [0.35, 0.25, 0.18, 0.12, 0.06, 0.04];
  let P = {}, down = null, up = null, fbDown = [], fbUp = [], nLev = 0, meter = null, meterFb = null, gridS = null, gridSFb = null;
  let snap = [null, null], snapFb = [null, null], snapCur = 0, snapValid = false;
  let base = null, baseFb = null, lim = null, limFb = null, baseOK = false, limOn = false;
  let hist = [null, null], histFb = [null, null], hcur = 0;
  /* [r4] the lightning's halo: the bolt layer's energy (b) blurred over 4-64 px in a pyramid of its own at S/4 */
  let hDn = null, hUp = null, fbHDn = [], fbHUp = [], nH = 0;
  /* [r5b] the glare's history (S/4, ping-pong; level 0 of the halo pyramid and the history are written together) */
  let glH = [null, null], fbH0 = [null, null], glCur = 0, glValid = false, glT = 0, glSkip = false;
  const HG = [0.15, 0.35, 0.7, 1.1, 1.5];                       // per level w_k 2^k: each level's energy, a wide soft falloff (little at 4 px: the core stays the brightest)
  let ring = [], lastIssue = -1e9, lastUploads = -1, seeded = false, gridTick = 0;
  let meterDrawn = false, meterStill = false, gridDrawn = false, sunUp = 1, sunEl = 30, storm = 0, stormW = 0, nightStorm = 0;
  let logTarget = Math.log(2), lastAdapt = 0, stillRun = 0, lastStillL = 0;
  const px = new Float32Array(5 * 8 * 4), grid = new Float32Array(32), peak = new Float32Array(32);
  /* [r3] the tone stage's uniforms: the white balance adapts like the exposure (to the meter's mean chromaticity) */
  const toneV = new Float32Array(4), wbV = new Float32Array([1, 1, 1]), chroma = new Float32Array([1, 1, 1]);
  const wbU = new Float32Array([1, 1, 1, 1]), wbU2 = new Float32Array([1, 1, 1, 1]), wbU3 = new Float32Array(4);
  let wbSnap = true;
  /* [r6] the meter's Lavg eased as the exposure eases (in log, tau 1 s up and 2.5 s down; snapped with it, held under a
     flash): the storm curve's pivot and the highlights' mean (Lavg x E) took the raw reading, which moves in steps of a
     readback (every ~0.5 s) while E eases, so each reading stepped the frame, most at the first one after a long lock (the
     -5 levels at 95.73 % in REVIEW-5's clip f, A 18:06) */
  let lavS = 0;
  /* [r5] the hue-preserving shoulder's uniform; how near the view a low sun is (0..1), the glare's state */
  const hpV = new Float32Array(4), glareV = new Float32Array(4);
  let sunView = 0, glareOn = false, sunVis = 0, sunVisT = 0;
  /* uniform objects made once: no allocation per frame */
  const U = {
    d0: { uSrc: null, uTexel: new Float32Array(2), uLimK: null, uLimOn: 0, uTaps: 1 },
    d: { uSrc: null, uTexel: new Float32Array(2) },
    u: { uFine: null, uCoarse: null, uTexel: new Float32Array(2), uW: new Float32Array(2) },
    m: { uSrc: null, uScn: null, uLod: 0, uHorizon: 0.44 },
    g: { uSrc: null },
    r: { uBase: null, uMode: 0, uBaseOK: 0, uFall: 0, uScot: 1, uCapK: new Float32Array(4), uCapRel: 0 },
    a: { uHist: null, uAlpha: 0.1, uTaaK: new Float32Array([2, 1, .04, 0]) },
    v: { uBloom: null, uBloomK: 0.03, uScot: 1, uSnap: null, uSnapOn: 0, uFixLod: -1 },
  };
  /* the 13 taps of Jimenez 2014 around uv, in source texels; level 0: Karis (each 4-tap block weighted
     1 / (1 + luma)) and the flash limit map */
  const DOWN = (first) => `
    uniform sampler2D uSrc, uLimK; uniform vec2 uTexel; uniform float uLimOn, uTaps; in vec2 vUV; out vec4 o;
    vec3 s(vec2 d) {
      vec2 p = vUV + d * uTexel;
      ${first ? "return min(wxGuard(textureLod(uSrc, p, 0.).rgb), vec3(6e4));" : "return textureLod(uSrc, p, 0.).rgb;"}
    }
    float kw(vec3 c) { return ${first ? "1. / (1. + wxLuma(c))" : "1."}; }
    void main() {
      vec3 r;
      ${first ? `/* [r3] below T3 level 0 is a 4 x 4 box of four bilinear taps with the Karis weights (a third of the
         13 taps' bandwidth on the iGPU); the bloom is a 3 % mix and the drops see this level blurred anyway */
      if (uTaps < .5) {
        vec3 a = s(vec2(-1., 1.)), b = s(vec2(1., 1.)), c = s(vec2(-1., -1.)), d = s(vec2(1., -1.));
        float wa = kw(a), wb = kw(b), wc = kw(c), wd = kw(d);
        r = (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
      } else {` : "{"}
      vec3 a = s(vec2(-2., 2.)), b = s(vec2(0., 2.)), c = s(vec2(2., 2.));
      vec3 d = s(vec2(-2., 0.)), e = s(vec2(0., 0.)), f = s(vec2(2., 0.));
      vec3 g = s(vec2(-2., -2.)), h = s(vec2(0., -2.)), i = s(vec2(2., -2.));
      vec3 j = s(vec2(-1., 1.)), k = s(vec2(1., 1.)), l = s(vec2(-1., -1.)), m = s(vec2(1., -1.));
      vec3 g0 = (j + k + l + m) * .25, g1 = (a + b + d + e) * .25, g2 = (b + c + e + f) * .25;
      vec3 g3 = (d + e + g + h) * .25, g4 = (e + f + h + i) * .25;
      float w0 = .5 * kw(g0), w1 = .125 * kw(g1), w2 = .125 * kw(g2), w3 = .125 * kw(g3), w4 = .125 * kw(g4);
      r = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
      }
      ${first ? `/* [r3] the flash limit, then the channels on top: the limit acts on the area light only (a white core
         cut into 16 px blocks was round 2's stair-stepped blob) */
      if (uLimOn > .5) r *= texture(uLimK, vUV).r;
      r += boltChan(vUV);` : ""}
      o = vec4(r, 1.);
    }`;
  function freeTargets(gl) {
    const tx = [down, up, base, lim, snap[0], snap[1], hist[0], hist[1], hDn, hUp, glH[0], glH[1]];
    for (const t of tx) if (t) gl.deleteTexture(t.tex);
    for (const f of fbDown.concat(fbUp, fbHDn, fbHUp, [baseFb, limFb, snapFb[0], snapFb[1], histFb[0], histFb[1], fbH0[0], fbH0[1]])) if (f) gl.deleteFramebuffer(f.fb);
    glH = [null, null]; fbH0 = [null, null]; glValid = false;
    down = up = base = lim = baseFb = limFb = hDn = hUp = null; fbDown = []; fbUp = []; fbHDn = []; fbHUp = [];
    snap = [null, null]; snapFb = [null, null]; hist = [null, null]; histFb = [null, null];
    snapValid = baseOK = false;
  }
  /* sample only level k of a mipped texture while another level of it is the render target */
  function only(gl, t, k) {
    gl.activeTexture(gl.TEXTURE31);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, k);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, k);
  }
  function all(gl, t) { all2(gl, t, nLev); }
  function all2(gl, t, n) {
    gl.activeTexture(gl.TEXTURE31);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, n - 1);
  }
  /* [r4] the lightning's halo pyramid, on world frames while a channel is drawn */
  const UH = { d: { uSrc: null, uScn: null, uHist: null, uAlpha: 1, uTexel: new Float32Array(2), uBoltIn: 0, uGl: null }, u: { uFine: null, uCoarse: null, uTexel: new Float32Array(2), uG4: new Float32Array(4), uTop: 1 } };
  const HGG = [0.5, 0.6, 0.6, 0.5, 0.4];                        // [r5] the glare's energy per level: a compact glow round the source, a faint wide veil
  function halo(R, gl, F) {
    const H = R.priv.boltHalo, BL = R.priv.boltLayer;
    if (!H) return;
    H.on = false; H.glare = false;
    const bolt = !!(BL && BL.on), gl0 = glareOn && glareV[2] > 0;
    if (!gl0) glValid = false;
    if (!(bolt || gl0) || !hDn) return;
    /* [r5b] at T0-T1 (Intel) the glare alone is rebuilt every other world frame (it eases over .6 s, so a lamp's glow
       cannot tell; Intel T1 paired: the glare's 11 small draws cost +.3 ms a world frame); the lightning's halo never waits */
    if (!bolt && glValid && R.tier <= 1 && !F.still && (glSkip = !glSkip)) { H.glare = true; return; }
    const S = R.size.S, d = UH.d, u = UH.u;
    d.uSrc = bolt ? BL.tex : R.sceneTex(); d.uScn = R.sceneTex(); d.uBoltIn = bolt ? 1 : 0; d.uGl = glareV;
    d.uTexel[0] = 1 / S[0]; d.uTexel[1] = 1 / S[1];
    /* [r5b] the glare eases toward the frame's (tau post.glareTau): what feeds it can step from frame to frame (a lamp's
       ~1 px core through the TAA's resolve stepped its energy 2-7x every few frames as the ship rocked: the glare round the
       lanterns breathed 3 <-> 7 levels, the lamps clip); a lantern's glow is steady. Under a flash it holds (the lit deck
       is not a steady source; the lightning has its own halo, a), and it starts afresh after a tier change or a pause */
    const now = performance.now(), gdt = glT ? Math.min(Math.max((now - glT) / 1000, 0), 0.25) : 0;
    glT = now;
    d.uAlpha = !glValid || F.still ? 1 : F.lockExposure ? 0 : 1 - Math.exp(-gdt / Math.max(R.p("post.glareTau"), 1e-3));
    d.uHist = glH[glCur];
    R.draw(P.h0, fbH0[1 - glCur], d);
    if (gl0) { glCur = 1 - glCur; glValid = true; }
    d.uSrc = hDn;
    for (let k = 1; k < nH; k++) {
      only(gl, hDn, k - 1);
      d.uTexel[0] = 1 / fbHDn[k - 1].w; d.uTexel[1] = 1 / fbHDn[k - 1].h;
      R.draw(P.hd, fbHDn[k], d);
    }
    u.uFine = hDn;
    for (let k = nH - 1; k >= 0; k--) {
      only(gl, hDn, k);
      /* the top level reads no coarser sum; hDn (sampled at level k only) stands in, so nothing bound is the target */
      if (k < nH - 1) { only(gl, hUp, k + 1); u.uCoarse = hUp; } else u.uCoarse = hDn;
      u.uTop = k === nH - 1 ? 1 : 0; u.uG4[0] = u.uG4[1] = u.uG4[2] = HGG[k]; u.uG4[3] = HG[k];
      u.uTexel[0] = 1 / fbHDn[Math.min(k + 1, nH - 1)].w; u.uTexel[1] = 1 / fbHDn[Math.min(k + 1, nH - 1)].h;
      R.draw(P.hu, fbHUp[k], u);
    }
    all2(gl, hDn, nH); all2(gl, hUp, nH);
    H.on = bolt; H.glare = gl0;
  }
  /* [r3] the weather's grade, per world frame: the white balance's target from the meter's chromaticity, eased
     with tau 2 s (snapped with the exposure), its strength from the rain; the storm curve; the local contrast */
  const wbT = new Float32Array(3), LEAN = new Float32Array([-0.05, 0, 0.07]);   // [r4] the cool lean, log gains
  function toneStep(R, F, dt, lock) {
    const W = F.W, precip = W.precip || 0, st = W.storm || 0, sm = WX.util.smooth;
    const day = sm(-8, 0, sunEl);                        // twilight keeps some of its colour; the rods take over at night
    /* under a storm's deck the twilight arch is hidden: its colour (A's purple murk at blue hour) is balanced out too */
    /* [r4] and under a deck lit by a low sun, rain or not (d at 70 %: one pink-mauve from the sky to the sea) */
    const over = sm(0.45, 0.7, W.cov || 0) * sm(6, 1.5, sunEl) * sm(-10, -3, sunEl);
    const sWB = Math.max(R.p("post.wb") * sm(0.2, 0.75, precip) * (0.35 + 0.65 * Math.max(day, 0.85 * st)), R.p("post.overWB") * over);
    /* the sky's share of the balance under that deck: at sunset it keeps its warmth (half the highlights' share); at blue
       hour the twilight's purple under the deck goes to the hour's blue (the full balance and a blue lean: x16) while the
       ground goes to slate (no cool lean, half its saturation; the rods add their own blue to its darks) */
    const blueK = over * sm(-1, -5, sunEl);
    wbU3[0] = R.p("post.split") * over; wbU3[1] = R.cam.horizon; wbU3[2] = 0.5 * blueK; wbU3[3] = R.p("post.groundCool") * (1 - blueK);
    let n = 0;
    for (let k = 0; k < 3; k++) { wbT[k] = Math.pow(1 / Math.max(chroma[k], 0.05), sWB); n += [0.2126, 0.7152, 0.0722][k] * wbT[k] * chroma[k]; }
    for (let k = 0; k < 3; k++) wbT[k] = Math.min(1.6, Math.max(0.6, wbT[k] / Math.max(n, 1e-3)));
    const Lr = R.exposure.Lavg;
    if (Lr > 0) {
      if (wbSnap || !(lavS > 0)) lavS = Lr;
      else if (!lock) lavS = Math.exp(Math.log(lavS) + Math.log(Lr / lavS) * (1 - Math.exp(-dt / (Lr > lavS ? 1.0 : 2.5))));
    }
    R.exposure.lavS = lavS;
    if (wbSnap) { wbV.set(wbT); wbSnap = false; }
    else if (!lock) { const a = 1 - Math.exp(-dt / 2); for (let k = 0; k < 3; k++) wbV[k] += (wbT[k] - wbV[k]) * a; }
    const c = sm(0.35, 0.9, precip) * (0.5 + 0.5 * st), Dc = R.p("post.curve") * c;
    const Lavg = lavS, E = R.exposure.E;
    if (!lock) {
      toneV[0] = Math.pow(2, Dc);
      toneV[1] = Lavg > 0 && E > 0 ? Lavg / 128000 * E * toneV[0] * Math.pow(2, 2.5) : 1;
      toneV[2] = Lavg > 0 ? Dc / 2.5 : 0;
    }
    toneV[3] = R.p("post.clarity") * sm(0.3, 0.9, precip);
    /* the shadows take the balance x 1.25, the highlights x .35 (relative to the eased gains, in log); the rain's
       grey takes back a little saturation */
    const hiK = (0.35 + 0.45 * st) * (1 - 0.5 * wbU3[0] * (1 - blueK)) * (1 - blueK) + blueK;   // a storm's deck leaves no warm light to keep
    /* [r4] a storm's light is a cool slate (sc-milton, Bornholm), not a neutral grey: a lean on top of the balance */
    const cool = R.p("post.stormCool") * st;
    for (let k = 0; k < 3; k++) {
      const lg = Math.log(wbV[k]) + LEAN[k] * cool;
      wbU[k] = Math.exp(lg * 1.25); wbU2[k] = Math.exp(lg * hiK + LEAN[k] * 1.2 * blueK);
    }
    wbU[3] = 1 + R.p("post.rainSat") * sm(0.3, 0.9, precip);
    if (!lock) wbU2[3] = Lavg > 0 && E > 0 ? Lavg / 128000 * E : 1;
  }
  /* [r6] the rods' weight from the eased Lavg, over 300-500 cd/m2 (a switch at 400 stepped the darkest pixels when a reading
     crossed it) */
  const scotOf = (R) => (!(R.exposure.lavS > 0) ? (R.exposure.Lavg === undefined || R.exposure.Lavg < 400 ? 1 : 0) : 1 - WX.util.smooth(300, 500, R.exposure.lavS));
  /* [L r8] the box (uv, y up) round the lighthouse's lamp where the view grades its light past the rods: its draw
     (R.beacon.box, S px) grown by its bloom's reach (.09 of the view's height); empty with no lighthouse or while the rods
     are off (by day), so no other pixel pays for it.
     [L r9] and the lamp's path on the water (stream W's ocean.bpath, R.beacon.pathBox: its strip's box, S px, empty when
     it is not drawn), which marks its light the same way: the whole path is the lamp's colour (REVIEW-8 #1: below the
     lamp's own box its glints went through the rods, grey). R.beacon.pathGraded tells the path (from the next frame on)
     that its whole strip is graded, so it keeps its mark from the lamp's base to the window */
  const lampBoxV = new Float32Array(4);
  const lampPV = new Float32Array(4);                                // [L r9] uLampP (pane.js's paneLampClear): the lamp's uv, on
  /*@lab*/ WX.param("post.lamp", 1, 0, 1, 1, "post"); /*@end*/   // [L r8] lab: 0 the lamp's light graded with the rest (round 7)
  function lampBox(R, scot) {
    const B = R.beacon, o = lampBoxV;
    o[0] = o[1] = 2; o[2] = o[3] = -1;
    let on = 1;
    /*@lab*/ on = R.p("post.lamp"); /*@end*/
    if (!on || !B || !B.on || !B.box || !(scot > 0) || !(B.uv[0] > -0.5)) return o;
    const S = R.size.S, a = S[0] / S[1], r = 0.09;
    o[0] = Math.min(B.box[0] / S[0], B.uv[0] - r / a); o[1] = Math.min(B.box[1] / S[1], B.uv[1] - r);
    o[2] = Math.max(B.box[2] / S[0], B.uv[0] + r / a); o[3] = Math.max(B.box[3] / S[1], B.uv[1] + r);
    const P = B.pathBox;                                                 // [L r9] W's three lines (notes/beacon.md, W 23:05)
    B.pathGraded = 1;
    if (P && P[2] > P[0] && P[3] > P[1]) { o[0] = Math.min(o[0], P[0] / S[0]); o[1] = Math.min(o[1], P[1] / S[1]); o[2] = Math.max(o[2], P[2] / S[0]); o[3] = Math.max(o[3], P[3] / S[1]); }
    return o;
  }
  /* [L r9f] THE LAMP'S HUE THROUGH THE GRADE. AgX turns a saturated colour's hue as it climbs toward its shoulder, and
     the hue-preserving shoulder (agxHP) freezes the chroma it has at uHP.y: a crimson lamp's glow and its brightest
     glints on the water showed pink, an amber one's yellow (REVIEW-9 5: the crimson path -17 deg in CIELAB; the cap's
     pink glow in s6b); a storm's highlight balance (uWB2, its cool lean) turns them further. The lamp's graded light
     (gradeGL's lamp: inside its box, while the rods are on) is tinted so that it shows the accent's own hue: per-channel
     gains at unit luminance, found by turning the accent's chroma in Oklab until AgX (a copy of the grade's agx() above,
     with the balance) shows the accent's Oklab hue at the shoulder's level (uHP.y): uLampK, its w that level's log2.
     Under a dim level (.25 pre-exposed) the grade barely turns the hue and the lamp keeps the scene's grade; the view
     blends from no tint there to the gains at the shoulder by the lamp's own level. Only where the shoulder is on (uHP.x:
     a low sun, dusk, the night; a day storm's lamp, under the rods by day, keeps round 9's grade, whose hue the frozen
     level's gains do not describe) and for saturated accents (HSV saturation .3 -> .5: the no-reading grey-blue, .23, is
     a near-neutral tint and keeps its light as it is). Recomputed when the accent, the balance, the level or the shoulder
     change (an eased reading: every frame of the ease, ~30 us) */
  const AGX_M = [0.842479062253094, 0.0423282422610123, 0.0423756549057051, 0.0784335999999992, 0.878468636469772, 0.0784336, 0.0792237451477643, 0.0791661274605434, 0.879142973793104];
  const AGX_MI = [1.19687900512017, -0.0528968517574562, -0.0529716355144438, -0.0980208811401368, 1.15190312990417, -0.0980434501171241, -0.0990297440797205, -0.0989611768448433, 1.15107367264116];
  const OK1 = [0.4122214708, 0.5363325363, 0.0514459929, 0.2119034982, 0.6806995451, 0.1073969566, 0.0883024619, 0.2817188376, 0.6299787005];
  const OK2 = [0.2104542553, 0.793617785, -0.0040720468, 1.9779984951, -2.428592205, 0.4505937099, 0.0259040371, 0.7827717662, -0.808675766];
  const OK2I = [1, 0.3963377774, 0.2158037573, 1, -0.1055613458, -0.0638541728, 1, -0.0894841775, -1.291485548];
  const OK1I = [4.0767416621, -3.3077115913, 0.2309699292, -1.2684380046, 2.6097574011, -0.3413193965, -0.0041960863, -0.7034186147, 1.707614701];
  const mul3 = (m, v, o) => { const a = v[0], b = v[1], c = v[2]; o[0] = m[0] * a + m[1] * b + m[2] * c; o[1] = m[3] * a + m[4] * b + m[5] * c; o[2] = m[6] * a + m[7] * b + m[8] * c; return o; };
  /* agx() of the grade's library (scene-referred linear, pre-exposed -> display-encoded); GLSL's mat3 is column-major */
  function agxJS(v, o) {
    const lo = -12.47393, hi = 4.026069, v0 = v[0], v1 = v[1], v2 = v[2];
    for (let i = 0; i < 3; i++) {
      let x = AGX_M[i] * v0 + AGX_M[3 + i] * v1 + AGX_M[6 + i] * v2;
      x = (Math.min(Math.max(Math.log2(Math.max(x, 1e-10)), lo), hi) - lo) / (hi - lo);
      const x2 = x * x, x4 = x2 * x2;
      o[i] = Math.min(Math.max(15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232, 0), 1);
    }
    const l = 0.2126 * o[0] + 0.7152 * o[1] + 0.0722 * o[2], t0 = l + 1.1 * (Math.pow(o[0], 1.1) - l), t1 = l + 1.1 * (Math.pow(o[1], 1.1) - l), t2 = l + 1.1 * (Math.pow(o[2], 1.1) - l);
    for (let i = 0; i < 3; i++) o[i] = AGX_MI[i] * t0 + AGX_MI[3 + i] * t1 + AGX_MI[6 + i] * t2;
    return o;
  }
  const tw = { lab: [0, 0, 0], k: [0, 0, 0], x: [0, 0, 0], d: [0, 0, 0], key: new Float64Array(8).fill(-1), nw: new Float64Array(8) };
  const lampK = new Float32Array([1, 1, 1, 0.678]);
  const okHue = (c) => { mul3(OK1, c, tw.x); for (let i = 0; i < 3; i++) tw.x[i] = Math.cbrt(Math.max(tw.x[i], 0)); mul3(OK2, tw.x, tw.lab); return Math.atan2(tw.lab[2], tw.lab[1]); };
  /* the accent's chroma turned by th in Oklab, back to linear, unit luminance (into tw.k) */
  function turned(L0, th, out) {
    const c = Math.cos(th), s = Math.sin(th);
    tw.lab[0] = L0[0]; tw.lab[1] = L0[1] * c - L0[2] * s; tw.lab[2] = L0[1] * s + L0[2] * c;
    mul3(OK2I, tw.lab, tw.x); for (let i = 0; i < 3; i++) tw.x[i] = tw.x[i] * tw.x[i] * tw.x[i];
    mul3(OK1I, tw.x, out);
    for (let i = 0; i < 3; i++) out[i] = Math.max(out[i], 1e-6);
    const Y = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
    for (let i = 0; i < 3; i++) out[i] /= Y;
    return out;
  }
  /* the hue (rad) AgX shows for the linear colour k under the balance wb, its brightest channel at level */
  function shownHue(k, wb, level) {
    let m = 0;
    for (let i = 0; i < 3; i++) { tw.x[i] = k[i] * wb[i]; m = Math.max(m, tw.x[i]); }
    for (let i = 0; i < 3; i++) tw.d[i] = (tw.x[i] * level) / m;
    agxJS(tw.d, tw.d);
    for (let i = 0; i < 3; i++) { const e = Math.min(Math.max(tw.d[i], 0), 1); tw.d[i] = e <= 0.04045 ? e / 12.92 : Math.pow((e + 0.055) / 1.055, 2.4); }
    return okHue(tw.d);
  }
  const wrapPi = (a) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
  /* the gains (into o.xyz) that make the lamp's light show the accent's hue at level */
  function tintAt(u, wb, level, w, o) {
    const L0 = [0, 0, 0];
    const h0 = okHue(u); L0[0] = tw.lab[0]; L0[1] = tw.lab[1]; L0[2] = tw.lab[2];
    const f = (th) => wrapPi(shownHue(turned(L0, th, tw.k), wb, level) - h0);
    let a = 0, fa = f(a), b = -fa, fb = f(b);
    for (let it = 0; it < 6 && Math.abs(fb) > 1e-4 && Math.abs(fb - fa) > 1e-9; it++) { const c = b - (fb * (b - a)) / (fb - fa); a = b; fa = fb; b = Math.max(-0.6, Math.min(0.6, c)); fb = f(b); }
    turned(L0, Math.abs(fb) < Math.abs(fa) ? b : a, tw.k);
    for (let i = 0; i < 3; i++) o[i] = 1 + (tw.k[i] / Math.max(u[i], 1e-6) - 1) * w;
    const Y = 0.2126 * u[0] * o[0] + 0.7152 * u[1] * o[1] + 0.0722 * u[2] * o[2];
    for (let i = 0; i < 3; i++) o[i] /= Y;
  }
  const wbOne = [1, 1, 1];
  /*@lab*/ WX.param("post.lampTint", 1, 0, 1, 1, "post"); /*@end*/   // [L r9f] lab: 0 the lamp's light graded as round 9 (no tint)
  function lampTint(R, on) {
    const B = R.beacon;
    /*@lab*/ if (!R.p("post.lampTint")) on = false; /*@end*/
    if (!on || !B || !B.rgb) { lampK[0] = lampK[1] = lampK[2] = 1; tw.key[0] = -1; return; }
    const s = B.srgb, mx = Math.max(s[0], s[1], s[2]), w = hpV[0] * WX.util.smooth(0.3, 0.5, mx > 0 ? 1 - Math.min(s[0], s[1], s[2]) / mx : 0);
    const wb = toneV[0] > 0 ? wbU2 : wbOne, lv = R.p("post.hpLevel"), K = tw.key, nw = tw.nw;
    nw[0] = B.rgb[0]; nw[1] = B.rgb[1]; nw[2] = B.rgb[2]; nw[3] = wb[0]; nw[4] = wb[1]; nw[5] = wb[2]; nw[6] = lv; nw[7] = w;
    let same = true;
    for (let i = 0; i < 8 && same; i++) same = Math.abs(nw[i] - K[i]) <= 1e-4 * Math.max(1, Math.abs(K[i]));   // the balance's ease settles below this
    if (same) return;
    for (let i = 0; i < 8; i++) K[i] = nw[i];
    if (w > 0) { tintAt(B.rgb, wb, lv, w, lampK); lampK[3] = Math.log2(lv); }
    else lampK[0] = lampK[1] = lampK[2] = 1;
    /*@lab*/ R.priv.lampTint = { k: Array.from(lampK, (x) => +x.toFixed(4)), wb: Array.from(wb, (x) => +x.toFixed(4)), w: +w.toFixed(3) }; /*@end*/
  }
  function toneFill(u) { u.uTone = toneV; u.uWB = wbU; u.uWB2 = wbU2; u.uWB3 = wbU3; u.uHP = hpV; }
  /* the "boltlit" library's uniforms (the bolt pass's; off when it is not live) */
  const BOLT_OFF = new Float32Array(4);
  function boltFill(u, F, R) {
    if (R.priv.boltFill) R.priv.boltFill(u, F, R);
    else { u.uBoltL = null; u.uBoltOn = BOLT_OFF; }
  }
  /* [r4] extra: stops added to the dark end's 3 (a storm at night) */
  const evComp = (EV, extra) => EV + (3.0 + (extra || 0)) * (1 - WX.util.smooth(-2, 16, EV));
  /* what the meter reads under a clear sky (v = 5) with the sun at el degrees, cd/m2: measured on the lab's
     cove with every pass live (out/pane/cal, the sun 10 deg right of the view), log2 by elevation. A's
     AMBIENT texel 2 cannot stand in: its "clear" sky still carries the storm's fog */
  const CLEAR_EL = [-6, -4, -2, 0, 1.5, 3, 5, 8, 12, 18, 26, 40, 62, 90];
  const CLEAR_L2 = [2.55, 5.28, 7.08, 8.99, 10.5, 11.38, 12.07, 12.71, 13.13, 13.33, 13.17, 12.4, 11.8, 11.5];
  function clearAt(el) {
    let i = 0;
    while (i < CLEAR_EL.length - 2 && el > CLEAR_EL[i + 1]) i++;
    const t = WX.util.clamp((el - CLEAR_EL[i]) / (CLEAR_EL[i + 1] - CLEAR_EL[i]), 0, 1);
    return Math.pow(2, CLEAR_L2[i] + (CLEAR_L2[i + 1] - CLEAR_L2[i]) * t);
  }
  /* a finished readback: the exposure target from the meter, the scrim grid at <= 2 Hz */
  function consume(R, q) {
    if (q.locked) return;
    if (q.meter) {
      const Lrel = Math.max(px[16], 1e-14), L = Lrel * 128000;
      /* [r4] a storm at night: the dark end compensates one stop more (E's proposal, director.md round 3 close), so the
         pre-flash scene is dark and a strike lights it, as in the night photographs */
      let EVc = evComp(Math.log2(L * 100 / 12.5), R.p("post.nightStorm") * nightStorm);
      /* [r4] a storm by day keeps part of its deficit under the clear sky at this sun (the eye's partial adaptation) */
      const Lc = clearAt(sunEl) * R.p("post.clearCal");
      R.exposure.Lclear = Lc;
      if (sunUp > 0) {
        const d = evComp(Math.log2(Lc * 100 / 12.5)) - EVc;
        EVc += sunUp * Math.min(R.p("post.stormKeep") * stormW * Math.max(d, 0), R.p("post.stormMax"));
      }
      /* [r5] a low sun in the view: the exposure a photographer takes for a sunset (the meter's log-average puts the bright
         sky round the sun on AgX's shoulder, a pastel peach band; stopped down, the sky keeps its colour and the disc
         stands over it). Only within ~6 deg of the horizon and near the view: golden hour and the day are untouched */
      /* [r5b] ... and only a sun that is seen (the meter's probe: the disc over the sky round it) */
      sunVisT = WX.util.smooth(1.2, R.p("post.sunVis"), px[36]);
      if (!seeded || q.still) sunVis = sunVisT;
      /* [r5c] exposed for the sky round the sun (A's ask): stopped down until the ring ~1 deg round the disc sits at
         post.sunRing pre-exposed, at most post.sunKey stops. A flat .6 stop kept the disc 40 levels over that sky at 0.25 deg
         but not at 0.5-1 deg, where the sky round the sun is brighter (AgX's shoulder: ~1.6 stops at 1 deg). The ring is
         read relative to E, so the key does not feed back on itself */
      const sunW = sunView * sunVisT * (1 - WX.util.smooth(3, 6, sunEl)) * WX.util.smooth(-1.5, 0, sunEl);
      if (sunW > 0 && px[37] > 0) {
        const Et = R.p("post.key") * 128000 / (1.2 * Math.pow(2, EVc));
        EVc += sunW * WX.util.clamp(Math.log2(px[37] * Et / R.p("post.sunRing")), 0, R.p("post.sunKey"));
      }
      const floor = typeof R.exposure.floor === "number" ? R.exposure.floor : -4.5;
      EVc = Math.max(EVc, floor);
      logTarget = Math.log(R.p("post.key") * 128000 / (1.2 * Math.pow(2, EVc)));
      R.exposure.EV = EVc;
      R.exposure.Lavg = L;
      /* the scene's mean colour at unit luminance (r and b read, g from the luminance) */
      if (px[17] > 0 && px[18] > 0) { chroma[0] = px[17]; chroma[2] = px[18]; chroma[1] = Math.max(0.05, (1 - 0.2126 * px[17] - 0.0722 * px[18]) / 0.7152); }
      if (!seeded || q.still) { seeded = true; R.exposure.snap = true; wbSnap = true; }
      /* [r3] the still start's drift (CHANGES-2 11): a still's scene keeps converging for ~30 frames (in SwiftShader
         the meter's L swung 40x over frames 3-30 at x14), so three readings are not a settled exposure. stable
         counts consecutive still readings within 3 % of the one before; R.exposure.stable (>= 2) tells the API
         and the lab's warm-up that the still's exposure is the one the moving view will keep */
      if (q.still) { stillRun = Math.abs(Math.log(L / Math.max(lastStillL, 1e-30))) < 0.03 ? stillRun + 1 : 0; lastStillL = L; }
      else stillRun = 0;
      R.exposure.stable = stillRun;
    }
    if (q.grid && (gridTick++ & 1) === 0) {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) {
        const o = (y * 5 + x) * 4;
        grid[(7 - y) * 4 + x] = px[o]; peak[(7 - y) * 4 + x] = px[o + 1];
      }
      R.meter.grid = grid; R.meter.peak = peak; R.meter.at = performance.now();
    }
  }
  return {
    name: "post",
    noTargets: ["HDR", "RAIN"],
    *build(R) {
      /* a new context: forget every GL object of the old one */
      down = up = base = lim = baseFb = limFb = hDn = hUp = null; fbDown = []; fbUp = []; fbHDn = []; fbHUp = []; meter = meterFb = gridS = gridSFb = null;
      snap = [null, null]; snapFb = [null, null]; hist = [null, null]; histFb = [null, null];
      ring = []; lastIssue = -1e9; seeded = false; meterDrawn = gridDrawn = false; snapValid = baseOK = false; lastAdapt = 0;
      glH = [null, null]; fbH0 = [null, null]; glValid = false; glT = 0;
      /* [r3] the channels' library is the bolt pass's; with the bolt stubbed (a lab view) a no-op stands in */
      const BL = WX.libs.boltlit !== undefined ? ["boltlit"] : [], BS = BL.length ? "" : "const vec4 uBoltOn = vec4(0.);\nvec3 boltChan(vec2 uv) { return vec3(0.); }\nvec3 boltHalo(vec2 uv, float l, float d) { return vec3(0.); }\n";
      P.down0 = R.program("post.down0", { libs: ["atmo"].concat(BL), fs: BS + DOWN(true) });
      P.down = R.program("post.down", { fs: DOWN(false) });
      P.up = R.program("post.up", { fs: `
        uniform sampler2D uFine, uCoarse; uniform vec2 uTexel, uW; in vec2 vUV; out vec4 o;
        vec3 c(vec2 d) { return textureLod(uCoarse, vUV + d * uTexel, 0.).rgb; }
        void main() {
          vec3 t = (c(vec2(-1., -1.)) + c(vec2(1., -1.)) + c(vec2(-1., 1.)) + c(vec2(1., 1.))
                 + 2. * (c(vec2(0., -1.)) + c(vec2(-1., 0.)) + c(vec2(1., 0.)) + c(vec2(0., 1.))) + 4. * c(vec2(0.))) / 16.;
          o = vec4((textureLod(uFine, vUV, 0.).rgb * uW.x + t * uW.y) / (uW.x + uW.y), 1.);
        }` });
      /* the log-average relative luminance */
      P.meter = R.program("post.meter", { fs: `
        uniform sampler2D uSrc, uScn; uniform float uLod, uHorizon; out vec4 o;
        /* [r5b] how far a low sun's disc stands over the sky round it, so the sunset exposure and the sun's glare count a sun
           only when it is seen (an overcast sunset, the sun behind the deck, is metered as before: preset d): the brightest of
           three taps on the disc (its centre and .6, 1.2 radii up: a sun half under the horizon keeps its upper limb) over the
           mean of four at 4 radii (left, right and up either side: the circumsolar sky); 0 when the sun is off the view */
        vec2 sunStand() {
          if (uSun.y < -.03 || uSun.y > .2) return vec2(0.);
          vec3 e = vec3(0., wxEye, 0.);
          vec4 c = wxClip(e + uSun.xyz * 3e4), c2 = wxClip(e + normalize(uSun.xyz + vec3(0., uSun.w, 0.)) * 3e4);
          if (c.w <= 0. || c2.w <= 0.) return vec2(0.);
          vec2 u = c.xy / c.w * .5 + .5, up = c2.xy / c2.w * .5 + .5 - u, rt = vec2(length(up * uRes.xy) * uRes.z, 0.);
          if (any(lessThan(u, vec2(0.))) || any(greaterThan(u, vec2(1.)))) return vec2(0.);
          float d = 0.;
          for (int k = 0; k < 3; k++) d = max(d, wxLuma(textureLod(uScn, u + up * .6 * float(k), 0.).rgb));
          float r = wxLuma(textureLod(uScn, u - 4. * rt, 0.).rgb) + wxLuma(textureLod(uScn, u + 4. * rt, 0.).rgb)
                  + wxLuma(textureLod(uScn, u + 2.83 * (up - rt), 0.).rgb) + wxLuma(textureLod(uScn, u + 2.83 * (up + rt), 0.).rgb);
          /* [r5c] x the disc over the ring, y the ring's own level relative to E (the sunset exposure's yardstick) */
          return vec2(d / max(.25 * r, 1e-12), .25 * r / max(uExpo.x, 1e-20));
        }
        void main() {
          if (gl_FragCoord.y > 1.) { o = vec4(sunStand(), 0., 1.); return; }     // [r5c] texel (4, 1): the low sun's probe
          float s = 0., ws = 0.;
          vec3 m = vec3(0.);
          for (int y = 0; y < 12; y++) for (int x = 0; x < 16; x++) {
            vec2 uv = (vec2(x, y) + .5) / vec2(16., 12.);
            float w = abs(uv.y - uHorizon) < .1 ? 1.5 : 1.;
            vec3 c = textureLod(uSrc, uv, uLod).rgb / max(uExpo.x, 1e-20);
            float L = wxLuma(c);
            s += w * log(max(L, 1e-14)); ws += w;
            m += w * c / max(L, 1e-14);                            // [r3] the mean chromaticity, each tap's colour at unit luminance
          }
          m /= max(wxLuma(m), 1e-14);
          o = vec4(exp(s / ws), m.r, m.b, 1.);
        }` });
      /* one texel per 16 x 16 px block: the mean of 16 bilinear taps. Mode 0: the flash limit's reference,
         relative. Mode 1: the limit map, the factor that holds the block <= the reference's display
         luminance + uCap (12 bisection steps in log2) */
      P.region = R.program("post.region", { libs: ["grade"], fs: `
        uniform sampler2D uBase; uniform float uMode, uBaseOK, uFall, uScot; out vec4 o;
        uniform vec4 uCapK;     // [r5] x the cap far from the strike, y at its lit core, z the core's radius m, w the knee (share of the cap passed as it is)
        uniform float uCapRel;  // [r5] the far cap's share relative to the block's own pre-flash luminance (at night: +1 stop at most)
        /* [r5] how near this block is to the lit cloud where flash f's channel leaves the base (A's lit lump: x, W.base, z), on
           screen: 1 at its centre, a gaussian of the core's radius projected at its distance; 0 off the screen's front */
        float flashNear(vec4 f, vec2 px) {
          if (f.w <= 0.) return 0.;
          vec3 p = vec3(f.x * 1000., uWx0.z * 1000. + 60., f.z * 1000.);
          vec4 c = wxClip(p);
          if (c.w < 1.) return 0.;
          vec2 sp = (c.xy / c.w * .5 + .5) * uRes.xy;
          float r = uCapK.z / max(length(p - vec3(0., wxEye, 0.)), 1.) * .5 * uRes.x / uCamX.w;
          vec2 d = (px - sp) / max(r, 8.);
          return exp(-dot(d, d));
        }
        void main() {
          vec2 b = floor(gl_FragCoord.xy) * 16.;
          vec3 s = vec3(0.);
          /* [r3] the channels are not in the picture (they are added after the limit), so a channel never
             darkens the blocks round it */
          for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) s += texture(sScene, (b + vec2(i, j) * 4. + 2.) * uRes.zw).rgb;
          s = max(s, vec3(0.));
          s = wxGuard(s / 16.);
          if (uMode < .5) { o = vec4(s / max(uExpo.x, 1e-20), 1.); return; }
          vec3 ref = (uBaseOK > .5 ? texelFetch(uBase, ivec2(gl_FragCoord.xy), 0).rgb : vec3(uFall)) * uExpo.x;
          /* [r5] the cap: high on the lit core round the channel's exit, low far from it (at night: NOAA's lit cloud in a dark
             frame, not an even lift of the whole deck); a soft knee instead of a hard ceiling, so a block lit three times
             the cap still shows brighter than one lit at the cap (round 4's flat plateau: the whole deck lifted evenly) */
          vec2 bc = b + 8.;
          float near = max(flashNear(uFlash0, bc), flashNear(uFlash1, bc));
          float Yr = gradeY(ref, uScot), cap = mix(uCapK.x + uCapRel * Yr, uCapK.y, near), dY = gradeY(s, uScot) - Yr, kc = uCapK.w * cap;
          float dY2 = dY <= kc ? dY : kc + (cap - kc) * (1. - exp(-(dY - kc) / max(cap - kc, 1e-4)));
          float Lt = Yr + dY2, k = 1.;
          if (gradeY(s, uScot) > Lt) {
            float lo = -16., hi = 0.;
            for (int i = 0; i < 12; i++) { float m = .5 * (lo + hi); if (gradeY(s * exp2(m), uScot) > Lt) hi = m; else lo = m; }
            k = exp2(lo);
          }
          o = vec4(k, 0., 0., 1.);
        }` });
      /* the TAA resolve (WX.TAA) */
      P.taa = R.program("post.taa", { fs: `
        uniform sampler2D uHist; uniform float uAlpha; uniform vec4 uTaaK; out vec4 o;     // [r6] x sigmas, y 3 x 3, z the damped weight
        vec3 tm(vec3 c) { return c / (1. + wxLuma(c)); }
        vec3 itm(vec3 c) { return c / max(1. - wxLuma(c), 1e-4); }
        vec3 ycc(vec3 c) { return vec3(dot(c, vec3(.25, .5, .25)), dot(c, vec3(.5, 0., -.5)), dot(c, vec3(-.25, .5, -.25))); }
        vec3 rgb(vec3 y) { return vec3(y.x + y.y - y.z, y.x + y.z, y.x - y.y - y.z); }
        void main() {
          ivec2 p = ivec2(gl_FragCoord.xy), hi = ivec2(uRes.xy) - 1;
          vec4 c0 = texelFetch(sScene, p, 0);
          if (uTaa1.z < .5) { o = vec4(wxGuard(c0.rgb), c0.a); return; }        // no history: this frame as it is
          /* the neighbourhood: [r6] the pixel and its 8 neighbours (round 5: the 4 nearest, whose box followed the jitter) */
          vec3 cur = ycc(tm(wxGuard(c0.rgb))), m1 = cur, m2 = cur * cur, mn = cur, mx = cur;
          float nn = 1.;
          for (int i = 0; i < 8; i++) {
            if (i >= 4 && uTaaK.y < .5) break;
            ivec2 o = i == 0 ? ivec2(1, 0) : i == 1 ? ivec2(-1, 0) : i == 2 ? ivec2(0, 1) : i == 3 ? ivec2(0, -1)
                    : i == 4 ? ivec2(1, 1) : i == 5 ? ivec2(-1, 1) : i == 6 ? ivec2(1, -1) : ivec2(-1, -1);
            vec3 s = ycc(tm(wxGuard(texelFetch(sScene, clamp(p + o, ivec2(0), hi), 0).rgb)));
            m1 += s; m2 += s * s; mn = min(mn, s); mx = max(mx, s); nn += 1.;
          }
          vec3 mu = m1 / nn, sg = sqrt(max(m2 / nn - mu * mu, 0.));
          vec3 lo = max(mn, mu - uTaaK.x * sg), up = min(mx, mu + uTaaK.x * sg);
          vec3 h = ycc(tm(wxGuard(texelFetch(uHist, p, 0).rgb * uExpo.y)));
          /* clip toward the box's centre (Playdead 2016), not a per-axis clamp: no hue shift */
          vec3 cc = .5 * (up + lo), ex = .5 * (up - lo) + 1e-6, v = h - cc, a = abs(v / ex);
          float ma = max(a.x, max(a.y, a.z));
          if (ma > 1.) h = cc + v / ma;
          /* where the history had to be clipped hard (the sea moved), trust this frame more: no smear */
          /* [r6] a change inside the neighbourhood's own spread is the jitter's (or noise), not the scene's: blend it slower */
          float aF = mix(uTaaK.z > 0. ? min(uTaaK.z, uAlpha) : uAlpha, uAlpha, smoothstep(.5, 1.5, abs(cur.x - h.x) / (sg.x + 1e-4)));
          float al = max(max(1. / (uTaa1.z + 1.), aF), .3 * smoothstep(1.5, 4., ma));
          /* inverse-luma weights (Karis 2014): a sparkle cannot dominate the blend */
          float wc = al / (1. + cur.x), wh = (1. - al) / (1. + h.x);
          o = vec4(wxGuard(itm(rgb((cur * wc + h * wh) / (wc + wh)))), c0.a);
        }` });
      /* [r5] the glare read with a cubic B-spline (4 bilinear taps): one bilinear tap of the S/4 pyramid drew a lamp's glow
         as a soft square (x04b at 2x); the B-spline's support is round to the eye */
      const VIEW = `
        uniform sampler2D uBloom, uSnap, uGlare; uniform float uBloomK, uScot, uSnapOn, uFixLod, uGlareK, uGlareTop;
        vec3 glareAt(vec2 uv) {
          /* [r5b] far from every source (most of the view) the coarsest level, whose reach is the widest, is ~0: one tap */
          vec3 gc = textureLod(uGlare, uv, uGlareTop).rgb;
          if (uGlareK * max(gc.r, max(gc.g, gc.b)) < 1e-4) return vec3(0.);
          vec2 ts = vec2(textureSize(uGlare, 0)), p = uv * ts - .5, i = floor(p), f = p - i, f2 = f * f, f3 = f2 * f;
          vec2 w0 = (1. - 3. * f + 3. * f2 - f3) / 6., w1 = (4. - 6. * f2 + 3. * f3) / 6., w2 = (1. + 3. * f + 3. * f2 - 3. * f3) / 6., w3 = f3 / 6.;
          vec2 g0 = w0 + w1, g1 = w2 + w3, c0 = (i - .5 + w1 / g0) / ts, c1 = (i + 1.5 + w3 / g1) / ts;
          return g0.y * (g0.x * textureLod(uGlare, c0, 0.).rgb + g1.x * textureLod(uGlare, vec2(c1.x, c0.y), 0.).rgb)
               + g1.y * (g0.x * textureLod(uGlare, vec2(c0.x, c1.y), 0.).rgb + g1.x * textureLod(uGlare, c1, 0.).rgb);
        }`;
      /* [r3c] the scrim grid's 4 x 8 cells of 8 x 8 samples: one fragment a sample into a 32 x 64 target, then a
         sum. Round 2-3 ran the 64 views of a cell in one fragment: 32 threads in a serial loop of the whole view,
         a latency spike every readback (Intel: the post slot's p95 5.8 ms in a storm against a p50 of 1.1) */
      P.grid = R.program("post.grid", { libs: ["atmo", "grade", "rainfar", "pane"].concat(BL), fs: BS + WX.libs.paneview + VIEW + `
        out vec4 o;
        void main() {
          vec2 p = floor(gl_FragCoord.xy), cell = floor(p / 8.), sub = p - cell * 8.;
          vec2 uv = (cell + (sub + .5) / 8.) / vec2(4., 8.);
          float cov, mf;
          vec3 c = mix(paneView(uv, 2., cov, mf), textureLod(uBloom, uv, 0.).rgb, uBloomK);
          vec3 a = uGlareK > 0. ? uGlareK * textureLod(uGlare, uv, 0.).rgb : vec3(0.);
          o = vec4(wxLuma(pow(gradeGA(c, a, uScot, gradeGround(uv)), vec3(2.2))), 0., 0., 1.);
        }` });
      P.gridSum = R.program("post.gridSum", { fs: `
        uniform sampler2D uSrc; out vec4 o;
        void main() {
          ivec2 c = ivec2(gl_FragCoord.xy) * 8;
          float s = 0., m = 0.;
          for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) { float Y = texelFetch(uSrc, c + ivec2(x, y), 0).r; s += Y; m = max(m, Y); }
          o = vec4(s / 64., m, 0., 1.);
        }` });
      P.view = R.program("post.view", { libs: ["atmo", "grade", "rainfar", "pane"].concat(BL), fs: BS + WX.libs.paneview + VIEW + `
        in vec2 vUV; out vec4 o;
        /*@lab*/ uniform float uDbg; /*@end*/
        uniform vec4 uLampBox;      // [L r8] uv (y up) of the box round the lighthouse's lamp where its light can be: its draw and its bloom (empty: none, or the rods off)
        uniform vec4 uLampK;        // [L r9f] the lamp's light tinted to show the accent's hue through the grade: rgb the gains at the shoulder's level, w its log2
        void main() {
          float cov, mf;
          vec3 c = mix(paneView(vUV, -1., cov, mf), textureLod(uBloom, vUV, 0.).rgb, uBloomK);
          /* [r5] the glare of the brightest sources: in the eye and the lens, so over the glass and the drops */
          vec3 a = uGlareK > 0. ? uGlareK * glareAt(vUV) : vec3(0.);
          /*@lab*/ if (uDbg > .5) { o = vec4(clamp((log2(max(c + a, vec3(1e-7))) + 12.) / 24., 0., 1.), 1.); return; } /*@end*/
          /* [L r8] the lighthouse's light: its pass marks SCENE's alpha with -Y, the pre-exposed luminance it added there
             (everything else writes 0..1); that much of the lamp's colour (uBeaconC, unit luminance), at most what the
             pixel holds out of the bloom, is graded past the rods. Not where a drop or the mist shows something else */
          /* only inside the lamp's box (uLampBox: its draw and its bloom's reach), and only while the rods are on (the box
             is empty by day): every other pixel pays nothing */
          vec3 lamp = vec3(0.), lampG = vec3(0.), aL = vec3(0.);
          if (all(greaterThan(vUV, uLampBox.xy)) && all(lessThan(vUV, uLampBox.zw))) {
            float lm = texelFetch(sScene, ivec2(vUV * vec2(textureSize(sScene, 0))), 0).a;
            vec3 bl = uBloomK * textureLod(uBloom, vUV, 0.).rgb, c0 = c - bl;
            if (lm < 0.) {
              vec3 l0 = -lm * uBeaconC.rgb, q = c0 / max(l0, vec3(1e-9));
              lamp = l0 * clamp(min(q.r, min(q.g, q.b)), 0., 1.) * (1. - cov) * (1. - mf);
            }
            /* and the lamp's bloom: round the lamp the bloom is mostly its light (the lens' and the eye's scatter of it), so
               its part in the lamp's colour is seen by the cones too (at night it read as a grey ring round a coloured
               core); within ~.09 of the view's height of the lamp */
            vec2 dv = (vUV - wxUV0(normalize(uBeacon.xyz - vec3(0., wxEye, 0.)))) * vec2(uRes.x * uRes.w, 1.);
            float wnd = 1. - smoothstep(.04, .09, length(dv));
            if (wnd > 0.) {
              vec3 qb = bl / max(uBeaconC.rgb, vec3(1e-9)); lamp += wnd * min(qb.r, min(qb.g, qb.b)) * uBeaconC.rgb;
              /* [L r9f] and the glare there (post's, of the brightest sources: round the lamp, the lamp's) */
              vec3 qa = a / max(uBeaconC.rgb, vec3(1e-9)); aL = wnd * min(qa.r, min(qa.g, qa.b)) * uBeaconC.rgb;
            }
            /* [L r9f] tinted to show the accent's hue through AgX and the balance, by its own level (the curve's boost in) */
            vec3 lt = lamp + aL;
            float lv = log2(max(max(lt.r, max(lt.g, lt.b)) * max(uTone.x, 1.), 1e-9));
            lampG = lt * mix(vec3(1.), uLampK.rgb, smoothstep(-2., uLampK.w, lv));
          }
          vec3 d = gradeGL(c - lamp, lampG, a - aL, uScot, gradeGround(vUV));
          /* TPDF dither per channel, independent, +-1.75 LSB (at +-1 a flat row of sky keeps runs of 60 codes) */
          vec3 p3 = vec3(gl_FragCoord.xy, uFrame.x);
          vec3 n = wxHash33(p3) + wxHash33(p3 + vec3(71., 113., 37.)) - 1.;
          d = clamp(d + n * (1.75 / 255.), 0., 1.);
          if (uSnapOn > .5) d = mix(texture(uSnap, vUV).rgb, d, uTier.w);
          o = vec4(d, 1.);
        }` });
      /* [r4] the halo pyramid: level 0 a 4 x 4 box of the bolt layer's energy (b), each next a 4 x 4 box of the one
         above; up: each level's energy x HG[k] plus a tent of the coarser sum.
         [r5] RGBA: a the lightning's energy (as before), rgb THE GLARE of the brightest sources, the resolved picture
         over a soft threshold (x - T past T, the colour kept, a tap at most uGl.y); round a low sun in the sky and on the
         cove only (the sea's glints stay out: its glitter column must not glare over its disc), at night everywhere */
      P.h0 = R.program("post.halo0", { fs: `
        uniform sampler2D uSrc, uScn, uHist; uniform vec2 uTexel; uniform float uBoltIn, uAlpha; uniform vec4 uGl; in vec2 vUV;
        layout(location = 0) out vec4 o; layout(location = 1) out vec4 oHist;
        vec4 t(vec2 d) { return textureLod(uSrc, vUV + d * uTexel, 0.); }
        /* [r5b] THE GLARE'S SOURCE, PHASE-STABLE. Round 5's first version thresholded and capped each 2 x 2 tap: a lamp's
           core is ~1 px, so its glare doubled or tripled as the rocking ship carried it across a tap's edge (the lamps clip:
           the glare over the stern lantern stepping 3 <-> 10 levels every few frames). Now the source's energy is measured
           where it is whole: B, the largest 4 x 4 px window sum (16 taps of 2 x 2 px over the 8 x 8 px round this texel's
           4 x 4 block, windows every 2 px), is the same wherever the core sits; the threshold and the cap act on B and
           scale the block's own colour linearly, so the blocks a core straddles add up to the same glare. uGl: x the
           threshold (energy of a 4 x 4 window, pre-exposed), y the cap (a source's energy counts at most this), z the gain
           (0: none), w the horizon's uv row (round a low sun the sea is left out, its glints must not glare over the
           disc; -1 at night) */
        void main() {
          float a = uBoltIn > .5 ? .25 * (t(vec2(-1., -1.)).b + t(vec2(1., -1.)).b + t(vec2(-1., 1.)).b + t(vec2(1., 1.)).b) : 0.;
          vec3 c = vec3(0.);
          if (uGl.z > 0.) {
            float e[16];
            for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
              vec2 p = vUV + vec2(float(2 * i - 3), float(2 * j - 3)) * uTexel;
              vec3 s = wxGuard(textureLod(uScn, p, 0.).rgb);
              if (p.y < uGl.w && texture(sSceneZ, p).r <= 0.) s = vec3(0.);
              e[j * 4 + i] = 4. * max(s.r, max(s.g, s.b));
              if (i == 1 || i == 2) if (j == 1 || j == 2) c += s;
            }
            float B = 0.;
            for (int j = 0; j < 3; j++) for (int i = 0; i < 3; i++)
              B = max(B, e[j * 4 + i] + e[j * 4 + i + 1] + e[j * 4 + i + 4] + e[j * 4 + i + 5]);
            c *= B > uGl.x ? .25 * (B - uGl.x) / B * min(1., uGl.y / B) : 0.;
            c = mix(texelFetch(uHist, ivec2(gl_FragCoord.xy), 0).rgb, c, uAlpha);
          }
          o = vec4(c, a); oHist = vec4(c, 1.);
        }` });
      P.hd = R.program("post.haloDown", { fs: `
        uniform sampler2D uSrc; uniform vec2 uTexel; in vec2 vUV; out vec4 o;
        vec4 t(vec2 d) { return textureLod(uSrc, vUV + d * uTexel, 0.); }
        void main() { o = .25 * (t(vec2(-1., -1.)) + t(vec2(1., -1.)) + t(vec2(-1., 1.)) + t(vec2(1., 1.))); }` });
      P.hu = R.program("post.haloUp", { fs: `
        uniform sampler2D uFine, uCoarse; uniform vec2 uTexel; uniform vec4 uG4; uniform float uTop; in vec2 vUV; out vec4 o;
        vec4 c(vec2 d) { return textureLod(uCoarse, vUV + d * uTexel, 0.); }
        void main() {
          vec4 t = uTop > .5 ? vec4(0.) : (c(vec2(-1., -1.)) + c(vec2(1., -1.)) + c(vec2(-1., 1.)) + c(vec2(1., 1.))
                 + 2. * (c(vec2(0., -1.)) + c(vec2(-1., 0.)) + c(vec2(1., 0.)) + c(vec2(0., 1.))) + 4. * c(vec2(0.))) / 16.;
          o = textureLod(uFine, vUV, 0.) * uG4 + t;
        }` });
      P.copy = R.program("post.copy", { fs: `uniform sampler2D uSrc; uniform float uLod; in vec2 vUV; out vec4 o;
        void main() { o = vec4(textureLod(uSrc, vUV, uLod).rgb, 1.); }` });
      yield* R.wait(P.down0, P.down, P.up, P.meter, P.region, P.taa, P.grid, P.gridSum, P.view, P.copy, P.h0, P.hd, P.hu);
      /*@lab*/ R.priv.samplersC = { view: P.view.samplers, grid: P.grid.samplers, down0: P.down0.samplers }; /*@end*/
      meter = R.gpu.tex2D(5, 8, "rgba32f", { filter: "nearest" });
      meterFb = R.gpu.fbo([meter]);
      gridS = R.gpu.tex2D(32, 64, "r16f", { filter: "nearest" }); gridSFb = R.gpu.fbo([gridS]);
      const gl = R.gl;
      for (let k = 0; k < RING; k++) ring.push({ buf: gl.createBuffer(), sync: null, seen: false, meter: false, grid: false, locked: false, still: false });
      /*@lab*/ R.debugTex("post.meter", meter, "raw"); /*@end*/
    },
    resize(R) {
      const gl = R.gl, G = R.gpu, S = R.size.S;
      freeTargets(gl);
      const w = Math.max(1, S[0] >> 1), h = Math.max(1, S[1] >> 1);
      nLev = Math.max(2, Math.min(R.knobs.bloom || 6, Math.floor(Math.log2(Math.min(w, h))) + 1));
      down = G.tex2D(w, h, "r11g11b10f", { mips: true, levels: nLev });
      up = G.tex2D(w, h, "r11g11b10f", { mips: true, levels: nLev });
      for (let k = 0; k < nLev; k++) {
        fbDown.push(G.fbo([{ tex: down, level: k }]));
        fbUp.push(G.fbo([{ tex: up, level: k }]));
      }
      all(gl, down); all(gl, up);
      for (let k = 0; k < 2; k++) { snap[k] = G.tex2D(S[0], S[1], "rgba8"); snapFb[k] = G.fbo([snap[k]]); }
      const bw = Math.ceil(S[0] / 16), bh = Math.ceil(S[1] / 16);
      /* [r5c] 32-bit: the reference is stored relative to E, and at night E is 1e6-1e7, so a block's s / E (1e-9-1e-7) fell
         under half-float's range (normal from 6e-5, subnormal steps of 6e-8): the reference read ~0 or a coarse step, so
         the night cap held every block near +.003 over black. A strike then DARKENED the far sky (40 -> 22 levels in
         A's clip n), and it stayed dark until the lock ended (a pop back, +19 in one frame); round 4's flat even lift at
         night was the same bug under a .18 cap */
      base = G.tex2D(bw, bh, "rgba32f", { filter: "nearest" }); baseFb = G.fbo([base]);
      lim = G.tex2D(bw, bh, "r16f"); limFb = G.fbo([lim]);
      /* the TAA history (WX.TAA.hist) */
      for (let k = 0; k < 2; k++) {
        hist[k] = G.tex2D(S[0], S[1], "rgba16f");          // linear: it is sScene for the bloom's taps and the view
        histFb[k] = G.fbo([hist[k]]);
      }
      hcur = 0;
      /* [r4] the halo pyramid at S/4 (R16F, 5 levels: 4-64 px of S) */
      const hw = Math.max(1, S[0] >> 2), hh = Math.max(1, S[1] >> 2);
      nH = Math.max(1, Math.min(HG.length, Math.floor(Math.log2(Math.min(hw, hh))) + 1));
      hDn = G.tex2D(hw, hh, "rgba16f", { mips: true, levels: nH }); hUp = G.tex2D(hw, hh, "rgba16f", { mips: true, levels: nH });
      for (let k = 0; k < nH; k++) { fbHDn.push(G.fbo([{ tex: hDn, level: k }])); fbHUp.push(G.fbo([{ tex: hUp, level: k }])); }
      for (let k = 0; k < 2; k++) { glH[k] = G.tex2D(hw, hh, "rgba16f"); fbH0[k] = G.fbo([{ tex: hDn, level: 0 }, glH[k]]); }
      glValid = false;
      all2(gl, hDn, nH); all2(gl, hUp, nH);
      R.priv.boltHalo = { tex: hUp, on: false, glare: false };
      /* for the pane and the rain: the two pyramids (levels 0..n-1, level 0 = S/2), and the limit map */
      R.priv.pyr = { down, up, levels: nLev, w, h };
      R.priv.toneFill = toneFill;
      R.priv.lim = { tex: lim, on: false };
      /*@lab*/
      R.debugTex("post.down", down, "hdr");
      R.debugTex("post.bloom", up, "hdr");
      R.debugTex("post.lim", lim, "r");
      R.debugTex("post.taa", hist[0], "hdr");
      /*@end*/
    },
    /* the readbacks: poll, consume, issue. Runs in pack(), before the first slot and outside every timer */
    ubo(F, R, set) {
      const gl = R.gl;
      sunEl = Math.asin(Math.max(-1, Math.min(1, F.sun.dir[1]))) / WX.util.D;
      sunUp = WX.util.smooth(-6, 0, sunEl); storm = F.W.storm || 0;
      /* [r4] the weights of the storm's exposure: by day from heavy rain and the storm; at night from the storm */
      stormW = WX.util.smooth(0.3, 0.9, F.W.precip || 0) * (0.4 + 0.6 * storm);
      nightStorm = (1 - WX.util.smooth(-10, -4, sunEl)) * WX.util.smooth(0, 0.5, storm);
      /* [r5] the sun's bearing off the view's axis (+z ahead, +x right): 1 inside the view, 0 beyond 15 deg past its edge */
      const sd = F.sun.dir, half = (R.cam && R.cam.hfov ? R.cam.hfov : 1.3) / 2, off = Math.atan2(Math.abs(sd[0]), sd[2]);
      sunView = WX.util.smooth(half + 15 * WX.util.D, half, off);
      const sm = WX.util.smooth, lowSun = 1 - sm(2, 6, sunEl);
      hpV[0] = R.p("post.hp") * lowSun; hpV[1] = R.p("post.hpLevel"); hpV[2] = 0; hpV[3] = R.p("post.hpWhite");
      /* [r5] the glare runs while a low sun is near the view, or at night (the lamps): its threshold from the hour */
      const gSun = sunView * sunVis * (1 - sm(4, 8, sunEl)) * sm(-2, -0.5, sunEl), gNight = sm(-4, -8, sunEl);
      glareOn = R.p("post.glare") > 0 && (gSun > 0 || gNight > 0);
      glareV[0] = Math.exp(WX.util.lerp(Math.log(R.p("post.glareT")), Math.log(R.p("post.glareTNight")), sm(-0.5, -6, sunEl)));
      glareV[1] = R.p("post.glareMax"); glareV[2] = R.p("post.glare") * Math.max(gSun, gNight);
      /* round a low sun the sea's glints stay out (its glitter column must not glare over its disc); at night nothing is
         masked: a lamp's core writes no scene distance, and its streak on the water glares as the lamp does */
      glareV[3] = gNight > gSun ? -1 : R.cam ? R.cam.horizon : 0.44;
      if (!ring.length) return;
      /*@lab*/ if (!R.p("post.rb")) return; /*@end*/
      for (let k = 0; k < ring.length; k++) {
        const q = ring[k];
        if (!q.sync) continue;
        /* read one frame after the fence is first seen signalled, when Chrome's shadow copy is surely in */
        if (!q.seen) {
          const st = gl.clientWaitSync(q.sync, 0, 0);
          if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) q.seen = true;
          continue;
        }
        gl.deleteSync(q.sync); q.sync = null; q.seen = false;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, q.buf);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        consume(R, q);
      }
      const now = performance.now();
      const ups = R.stats.uploads || 0, uploaded = ups !== lastUploads;
      lastUploads = ups;
      if (uploaded || F.lockExposure || !(meterDrawn || gridDrawn) || (now - lastIssue < PERIOD_MS && seeded && !F.still)) return;
      let q = null;
      for (let k = 0; k < ring.length; k++) if (!ring[k].sync) { q = ring[k]; break; }
      if (!q) return;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, q.buf);
      /* fresh storage for every request (orphaning): without it Chrome discards the shadow copy it makes of a
         READ buffer at the fence and warns on every rewrite (tests/pane/pbo.cjs: 15 of 16, orphaned 0) */
      gl.bufferData(gl.PIXEL_PACK_BUFFER, px.byteLength, gl.STREAM_READ);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, meterFb.fb);
      gl.readPixels(0, 0, 5, 8, gl.RGBA, gl.FLOAT, 0);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      q.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      q.meter = meterDrawn; q.grid = gridDrawn; q.locked = false; q.still = meterStill;
      meterDrawn = gridDrawn = false;
      lastIssue = now;
    },
    slots: {
      taa(R, F) {
        const T = R.taa;
        if (!T.on) return;
        const dst = hcur ^ 1;
        U.a.uHist = hist[hcur]; U.a.uAlpha = R.p("post.taaAlpha"); U.a.uTaaK[0] = R.p("post.taaSig"); U.a.uTaaK[2] = R.p("post.taaDamp");
        /*@lab*/ U.a.uTaaK[1] = R.p("post.taa9"); /*@end*/
        R.draw(P.taa, histFb[dst], U.a);
        hcur = dst; T.out = hist[dst];
        /* [r3] the lightning's layer, unjittered, after the resolve: post adds it to the view and the bloom's
           input, so it is never in the history (round 2 drew it into the resolved picture, the next frame's
           history, and the lit cloud built up under the clip) */
        if (R.priv.boltDraw) R.priv.boltDraw(R, F);
      },
      bloom(R, F) {
        const gl = R.gl, S = R.size.S, lock = !!F.lockExposure;
        const scot = scotOf(R);
        /* the flash limit: the block means become the reference on every world frame without a flash, and the
           limit map under one (a meter reading stands in for a reference not yet made) */
        const ur = U.r;
        ur.uScot = scot;
        /* [r5] the cap's far value from the hour (the bolt's own day/night weight, from the frozen pre-flash exposure) */
        const nk = WX.util.smooth(300, 3000, R.exposure.E || 0);
        ur.uCapK[0] = WX.util.lerp(R.p("post.flashCap"), R.p("post.flashCapNight"), nk); ur.uCapK[1] = Math.max(R.p("post.flashCore"), ur.uCapK[0]);
        ur.uCapK[2] = R.p("post.flashCoreKm") * 1000; ur.uCapK[3] = R.p("post.flashKnee"); ur.uCapRel = R.p("post.flashRelNight") * nk;
        /* no texture of an older size kept in the uniform object (a tier change deletes them): set each frame */
        toneFill(ur);
        if (!lock) { ur.uMode = 0; ur.uBase = null; R.draw(P.region, baseFb, ur); baseOK = true; }
        else {
          ur.uMode = 1; ur.uBase = base; ur.uBaseOK = baseOK ? 1 : 0; ur.uFall = (R.exposure.Lavg || 0) / 128000;
          R.draw(P.region, limFb, ur);
        }
        limOn = lock; R.priv.lim.on = lock;
        /* down: level 0 from the (resolved) picture (Karis, guard, the limit map), then each from the one above */
        const d0 = U.d0;
        d0.uSrc = R.sceneTex(); d0.uTexel[0] = 1 / S[0]; d0.uTexel[1] = 1 / S[1]; d0.uLimK = lim; d0.uLimOn = lock ? 1 : 0;
        boltFill(d0, F, R); d0.uTaps = R.tier >= R.p("post.taps13") ? 1 : 0;
        R.draw(P.down0, fbDown[0], d0);
        for (let k = 1; k < nLev; k++) {
          only(gl, down, k - 1);
          U.d.uSrc = down; U.d.uTexel[0] = 1 / fbDown[k - 1].w; U.d.uTexel[1] = 1 / fbDown[k - 1].h;
          R.draw(P.down, fbDown[k], U.d);
        }
        all(gl, down);
        /* up: the coarsest level is the down level itself; each finer one a tent from the level below blended
           with its own down level by the normalised weights (base = max level: no feedback loop) */
        only(gl, down, nLev - 1);
        U.u.uFine = down; U.u.uCoarse = down; U.u.uW[0] = 1; U.u.uW[1] = 0;
        U.u.uTexel[0] = 1 / fbDown[nLev - 1].w; U.u.uTexel[1] = 1 / fbDown[nLev - 1].h;
        R.draw(P.up, fbUp[nLev - 1], U.u);
        let Wb = W6[nLev - 1];
        U.u.uCoarse = up;
        for (let k = nLev - 2; k >= 0; k--) {
          only(gl, down, k); only(gl, up, k + 1);
          U.u.uTexel[0] = 1 / fbDown[k + 1].w; U.u.uTexel[1] = 1 / fbDown[k + 1].h;
          U.u.uW[0] = W6[k]; U.u.uW[1] = Wb;
          R.draw(P.up, fbUp[k], U.u);
          Wb += W6[k];
        }
        all(gl, down); all(gl, up);
        halo(R, gl, F);
        /* the meter (world frames, never under a flash) */
        if (!lock && (performance.now() - lastIssue > PERIOD_MS * 0.7 || !seeded || F.still)) {
          U.m.uSrc = down; U.m.uScn = R.sceneTex(); U.m.uLod = Math.min(4, nLev - 1); U.m.uHorizon = R.cam.horizon;
          R.bind(meterFb);
          gl.viewport(4, 0, 1, 2);
          P.meter.use(); R.gpu.uniforms(P.meter, U.m); R.gpu.fullscreen();
          meterDrawn = true; meterStill = !!F.still;
        }
        /* adapt (real time, world frames only, so SCENE always matches the E it was made with) */
        const ex = R.exposure, now = performance.now();
        const dt = lastAdapt ? Math.min(Math.max((now - lastAdapt) / 1000, 0), 0.25) : 0;
        lastAdapt = now;
        ex.prev = ex.E;
        sunVis = ex.snap ? sunVisT : sunVis + (sunVisT - sunVis) * (1 - Math.exp(-dt / 0.7));   // [r5b] the low sun's glare fades in and out
        if (ex.snap) { ex.E = Math.exp(logTarget); ex.snap = false; }
        else if (!lock && seeded) {
          const lE = Math.log(ex.E), tau = logTarget > lE ? 2.5 : 1.0;
          ex.E = Math.exp(lE + (logTarget - lE) * (1 - Math.exp(-dt / tau)));
        }
        toneStep(R, F, dt, lock);
      },
      /* the view through the glass, graded, to the canvas (pane + post fused); then the near streaks */
      post(R, F) {
        const gl = R.gl, pane = R.priv.pane;
        if (!pane || !pane.fill) return;
        const el = Math.asin(Math.max(-1, Math.min(1, F.sun.dir[1]))), night = 1 - WX.util.smooth(-10 * WX.util.D, -2 * WX.util.D, el);
        const k = WX.util.lerp(R.p("post.bloomDay"), R.p("post.bloomNight"), night);
        const scot = scotOf(R);
        const v = U.v;
        pane.fill(v, F, R);
        boltFill(v, F, R); toneFill(v);
        v.uBloom = up; v.uBloomK = k; v.uScot = scot;
        v.uLampBox = lampBox(R, scot);                                   // [L r8]
        lampTint(R, v.uLampBox[2] > v.uLampBox[0]); v.uLampK = lampK;     // [L r9f]
        /* [L r9] the lamp for the pane (paneLampClear: no storm's local contrast round it), while the lamp's box is on */
        { const B = R.beacon, on = v.uLampBox[2] > v.uLampBox[0] && B && B.uv[0] > -0.5;
          lampPV[0] = on ? B.uv[0] : -1; lampPV[1] = on ? B.uv[1] : -1; lampPV[2] = 0; lampPV[3] = on ? 1 : 0; v.uLampP = lampPV; }
        const Hh = R.priv.boltHalo;
        v.uGlare = hUp; v.uGlareK = Hh && Hh.glare ? glareV[2] : 0; v.uGlareTop = Math.max(nH - 1, 0);
        /*@lab*/ v.uDbg = R.p("post.dbg"); /*@end*/
        /* the scrim grid (display luminance of the view, flashes left out), drawn only ahead of a readback */
        if (!F.lockExposure && (performance.now() - lastIssue > PERIOD_MS * 0.7 || !seeded || F.still)) {
          v.uFixLod = 2;
          R.draw(P.grid, gridSFb, v);
          U.g.uSrc = gridS;
          R.draw(P.gridSum, meterFb, U.g, { viewport: [0, 0, 4, 8] });
          gridDrawn = true;
        }
        v.uFixLod = -1;
        v.uSnap = snap[snapCur]; v.uSnapOn = F.dissolve < 1 && snapValid ? 1 : 0;
        if (F.snapshot) {
          const nx = 1 - snapCur;
          R.draw(P.view, snapFb[nx], v);
          snapCur = nx; snapValid = true;
          v.uSnap = snap[snapCur]; v.uSnapOn = 0;
        }
        R.draw(P.view, null, v);
        if (R.priv.rainDraw) R.priv.rainDraw(R, F, scot);
      },
    },
  };
})());
