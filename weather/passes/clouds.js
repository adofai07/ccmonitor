/* ═══════════════════════ Weather: the volumetric clouds (stream A) ═══════════════════════
   Nubis (Schneider & Vos 2015, Schneider 2017) with Hillaire's energy-conserving integration and
   Wrenninge's multiple-scattering octaves, traced 1/16 of the pixels per world frame (1/8 at T4) and
   reprojected for the wind aloft (render.md 6).

   [round 2] The cloud field is a 2.5D column field eroded in 3D:
     - the weather map holds, per column, the height of the cloud's top over a flat base. Cumulus are
       domes over jittered cells of three generations (5.2, 2.6 and 1.3 km), each with a log-normal radius,
       a height that grows with its width, and an elongation along the wind aloft; they appear by
       growing from nothing as the cover rises (no pop). Decks are a soft cover field whose gaps open
       wide (no slits: a slit in a deck showed as a glowing crack line);
     - the density is a signed distance in km below the column's top and above its base, displaced by
       the base volume's Worley octaves (turrets, 0.4-1.7 km) and then by the detail octaves (billows,
       0.1-0.4 km, curl-warped, inverted into wisps toward the base), with a 60-150 m density ramp:
       crisp edges that are never a step;
     - every tiled field is read through an integer lattice rotation, so no two tiles line up along a
       grazing ray, and every period still divides the 420 km drift wrap;
     - a 100-200 km modulation thins and clumps the far field;
     - under wet decks, scud races below the base, and the rain itself carries most of the lost visibility in
       curtains (atmo.js keeps a thinner uniform fog), so a storm's base shows between the shafts.
   The light: the march's in-scatter (energy-conserving, 4 octaves, dual-lobe HG) with Nubis 2017's in-scatter
   probability by depth below the surface (cauliflower contrast), a jittered light cone (fixed taps drew contour
   creases) whose far end reads the shadow map, a height-graded ambient (the diffuse transmission of the cloud
   above and below), the twilight arch (AMBIENT texel 3) and, after sunset, more of the dome from the sides.

   Fields (all periods divide the 420 km drift wrap, so nothing jumps when a drift offset wraps):
     base   128^3 RGBA8, a 7 km tile     R Perlin-Worley, GBA Worley fBm at 4, 8, 16 per tile; read rotated
                                         53.1 deg (period 35 km, 12 in 420)
     detail 32^3 RGBA8, a 0.874 km tile  Worley fBm at 2, 4, 8; read rotated -63.4 deg (period 420/215 km)
     curl   128^2 RG8, a 5 km tile       curl of a periodic Perlin field, for wispy bases (84 tiles)
     weather 512^2 RGBA8, a 62.6 km tile R column top (fraction of the layer), G wetness, B the peak of the cloud
                                         the column belongs to, A the deck's share; read rotated 26.6 deg (period
                                         140 km, 3 in 420); made again, a quarter of its rows per world frame,
                                         when cov, type or precip move past render.md 13.3's thresholds
     cirrus 512^2 RG8, a 30 km tile      streaks along the mean wind aloft (14 tiles); drawn by sky.js
   They move by uDrift0.xy (weather), uDrift0.zw (shape and detail), uDrift1.zw (curl), uDrift1.xy (cirrus).
   Every volume is filled slice by slice through a 2D target and copyTexSubImage3D (no 3D render
   targets: ANGLE/Vulkan answers FRAMEBUFFER_UNSUPPORTED, render.md 16).

   Outputs:
     CSHADOW  256^2 R16F over 48 km toward the key light, centred 20 km out, full mips (its last mip is
              the mean the atmosphere uses); the transmittance from sea level up through the layer
     CLOUD    the cloud buffer, RGBA16F at uCloudRes: rgb in-scatter (pre-exposed, the air in front
              included), a transmittance. Sky rays: rain below the base, then the cloud march. Surface
              rays (below the sea's horizon, or where SCENEZ, the previous world frame's distance to the
              cove, is > 0): the rain and haze medium only, ending at the surface (DESIGN 13.3)
     CLOUDZ   RG16F: r the transmittance-weighted depth km, g the kind (0 sky, 1 surface)
   wxCloudAt keeps only taps of the surface kind (it is for the sea and the cove); the sky composite
   reads the buffer itself and keeps only sky taps, so neither kind leaks across a silhouette.
   [1.2] TAA: the cloud buffer is traced and reprojected with the camera's own rays (wxRay0, wxUV0), so
   its history never carries the jitter; readers at a jittered scene uv take it out (uv - uTaa.xy / S).

   uA1 (this stream's): x the light under the deck (atmo.js), w the moon's sky-view is live; yz unused.                     */
WX.lib("clouds", `
/* the shadow map's square: 48 km, centred 20 km out along the view */
const vec2 CLD_SH_C = vec2(0., 20.);
const float CLD_SH_SIZE = 48.;
/* how much of the key light reaches a world point (m) through the clouds: 1 lit, 0 shadowed */
float cldShadowMap() { return textureLod(sCShadow, vec2(.5), 8.).r; }
/* [round 3] the shadow the air round the eye sits in, for the sky-view and the ambient: the map's mean, except that
   with a storm's edge (uWx2.w past ~.3) the open sky beyond it would light the whole storm's air through the mean,
   so the mean of the ~6 km round the eye (mip 5 at the eye's point of the map) takes over.
   [round 3 close] wxCloudShadowMean() is this too (the far sea's glint and the rain's sun light read it): with the
   whole map's mean the sunlit sea beyond a storm's edge lit the bay's far water, and the sun's glint drew a thin,
   very bright stripe along the horizon behind the ship (F, preset g). Fair weather is unchanged (no edge) */
float wxCloudShadowMean() {
  float m = cldShadowMap(), e = smoothstep(.3, .6, uWx2.w);
  return e > 0. ? mix(m, textureLod(sCShadow, vec2(.5, .5 - CLD_SH_C.y / CLD_SH_SIZE), 5.).r, e) : m;
}
float cldShadowRef() { return wxCloudShadowMean(); }
float wxCloudShadow(vec3 pM) {
  vec3 L = uKey.xyz; L.y = max(L.y, .035);
  float hKm = pM.y * 1e-3;
  vec2 xz = pM.xz * 1e-3 - L.xz / L.y * min(hKm, uWx0.z);
  vec2 uv = (xz - CLD_SH_C) / CLD_SH_SIZE + .5;
  vec2 e = min(uv, 1. - uv);
  /* [round 3] the mean (the map's last mip) is looked up only near the map's edge, where it is blended in */
  float s = textureLod(sCShadow, uv, 0.).r, k = smoothstep(0., .06, min(e.x, e.y));
  if (k < 1.) s = mix(cldShadowMap(), s, k);
  return mix(s, 1., smoothstep(uWx0.z, uWx0.w, hKm));
}
/* depth-aware bilinear of the cloud buffer: only taps of kind k (0 sky, 1 surface). uv is unjittered
   (the cloud buffer's own): a reader at a jittered scene uv passes uv - uTaa.xy * uRes.zw */
vec4 cldTaps(vec2 uv, float k, out float wsum) {
  vec2 st = uv * uCloudRes.xy - .5, f = fract(st);
  ivec2 i0 = ivec2(floor(st)), mx = ivec2(uCloudRes.xy) - 1;
  vec4 acc = vec4(0.); wsum = 0.;
  for (int j = 0; j < 4; j++) {
    ivec2 o = ivec2(j & 1, j >> 1), q = clamp(i0 + o, ivec2(0), mx);
    float w = (o.x == 1 ? f.x : 1. - f.x) * (o.y == 1 ? f.y : 1. - f.y);
    float kk = texelFetch(sCloudZ, q, 0).g;
    w *= 1. - step(.5, abs(kk - k));
    acc += texelFetch(sCloud, q, 0) * w; wsum += w;
  }
  return acc;
}
/* the medium in front of a surface (the sea, the cove) seen through scene uv: rgb in-scatter
   (pre-exposed, rain shafts and their light), a transmittance. Composite it over the surface's own
   aerial-perspective'd colour: L = L_surface * a + rgb */
vec4 wxCloudAt(vec2 uv) {
  vec2 u0 = uv - uTaa.xy * uRes.zw;
  float ws; vec4 c = cldTaps(u0, 1., ws);
  c = ws > 1e-3 ? c / ws : texture(sCloud, u0);
  /* [round 3] a flash lights the rain in front of the surface here, per pixel and per frame (the amortized
     trace would draw it in blocks): at the medium's mean depth, scattered half forward */
  if (uFlash0.w + uFlash1.w > 0. && c.a < .999) {
    vec3 rd = wxRay0(u0), pM = vec3(0., wxEye, 0.) + rd * (texture(sCloudZ, u0).r * 500.);
    /* [round 5] scattered forward (atmFlashScat): the rain glows toward the strike, not evenly over the view */
    c.rgb += atmFlashScat(pM, rd) * (1. - c.a) * .9;
  }
  return c;
}
/* transmittance-weighted distance of what the buffer holds at uv, km */
float wxCloudDepthAt(vec2 uv) { return texture(sCloudZ, uv - uTaa.xy * uRes.zw).r; }
`);

WX.pass((function () {
  const P = {};
  let V = null;        // GL objects of this context
  let cur = 0, needFull = true, lastDrift = null, lastE = 0, shQ = -1, shBlend = false;
  const wx = { cov: -1, type: -1, precip: -1, age: 99, band: -1, blend: false, left: 0 };
  /* the visit order of the sub-pixels: 4x4 Bayer (1/16), 4x2 (1/8, T4), 2x2 (1/4) */
  const ORDER = { 16: [0, 10, 2, 8, 5, 15, 7, 13, 1, 11, 3, 9, 4, 14, 6, 12], 8: [0, 6, 2, 4, 1, 7, 3, 5], 4: [0, 3, 1, 2] };
  const BLOCK = { 16: [4, 4], 8: [4, 2], 4: [2, 2] };
  /* the light's balance (uCK): ambient, twilight arch, deep-path energy, powder */
  const CK = [1, 1, 1, 1], CS = [1, 1, 1, 1];
  /* [round 5] the rain deck's tuning, as constants in the shaders (lab: p.cld.<name>=): the mottle's reach (rmot), its share of
     the key light (rkey, an exponent on the mottle), the edge light's forward rim (rrim), the deck's forward lobe (rg), the
     base volume's mip bias (rmip), the seams' smooth minimum (scK), shift (scS), width (scW) and wander (scF) */
  const LK = (k, v) => { /*@lab*/ const q = new URLSearchParams(location.search).get("p.cld." + k); if (q !== null && q !== "") v = +q; /*@end*/ return (+v).toFixed(4); };
  /*@lab*/ WX.param("cld.amb", CK[0], 0, 4, 0.05, "sky"); WX.param("cld.arch", CK[1], 0, 4, 0.05, "sky");
  WX.param("cld.deep", CK[2], 0, 4, 0.05, "sky"); WX.param("cld.powder", CK[3], 0, 2, 0.05, "sky");
  WX.param("cld.dbg", 0, 0, 6, 1, "sky"); WX.param("sky.under", 1, 0, 2, 0.05, "sky"); WX.param("sky.cut", 0, 0, 31, 1, "sky");
  WX.param("cld.turret", CS[0], 0, 4, 0.05, "sky"); WX.param("cld.billow", CS[1], 0, 4, 0.05, "sky"); WX.param("cld.ramp", CS[2], 0.1, 4, 0.05, "sky"); WX.param("cld.shelf", CS[3], 0, 2, 0.05, "sky"); /*@end*/

  /* uOne = 1 and uOct: loop bounds from uniforms, so a compiler cannot unroll the 27 cells of every Worley
     call and the octaves of every fBm (unrolled, the noise programs took seconds to compile on Mesa) */
  const NOISE = `
    uniform int uOne, uOct;
    vec3 cldH3(vec3 c, float per) { return wxHash33(mod(c, per) + 64.); }
    float cldWorley(vec3 p, float per) {
      vec3 id = floor(p), f = fract(p); float d = 1e9;
      for (int x = -uOne; x <= uOne; x++) for (int y = -uOne; y <= uOne; y++) for (int z = -uOne; z <= uOne; z++) {
        vec3 o = vec3(x, y, z), r = o + cldH3(id + o, per) - f; d = min(d, dot(r, r));
      }
      /* 1 - F1^2: a round cap over each feature point (1 - F1 made cones, and the billows read as facets) */
      return 1. - min(d, 1.);
    }
    vec3 cldGrad(vec3 c, float per) { return normalize(cldH3(c + 19., per) * 2. - 1. + 1e-4); }
    float cldPerlin(vec3 p, float per) {
      vec3 i = floor(p), f = fract(p), u = f * f * f * (f * (f * 6. - 15.) + 10.);
      float n000 = dot(cldGrad(i, per), f), n100 = dot(cldGrad(i + vec3(1, 0, 0), per), f - vec3(1, 0, 0));
      float n010 = dot(cldGrad(i + vec3(0, 1, 0), per), f - vec3(0, 1, 0)), n110 = dot(cldGrad(i + vec3(1, 1, 0), per), f - vec3(1, 1, 0));
      float n001 = dot(cldGrad(i + vec3(0, 0, 1), per), f - vec3(0, 0, 1)), n101 = dot(cldGrad(i + vec3(1, 0, 1), per), f - vec3(1, 0, 1));
      float n011 = dot(cldGrad(i + vec3(0, 1, 1), per), f - vec3(0, 1, 1)), n111 = dot(cldGrad(i + vec3(1), per), f - vec3(1));
      return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
    }
    float cldPerlinFbm(vec3 p, float freq, int oct) {
      float a = 1., s = 0., n = 0.;
      for (int i = 0; i < uOct; i++) { if (i >= oct) break; s += a * cldPerlin(p * freq, freq); n += a; a *= .5; freq *= 2.; }
      return s / n;
    }
    float cldWorleyFbm(vec3 p, float f) {
      return cldWorley(p * f, f) * .625 + cldWorley(p * f * 2., f * 2.) * .25 + cldWorley(p * f * 4., f * 4.) * .125;
    }`;

  /* the density (render.md 6.3, round 2's column model), in the trace's coordinates q = (x km, altitude km, z km) */
  const FIELD = `
    uniform highp sampler3D uBase, uDetail; uniform sampler2D uWeather, uCurl;
    /* the shape's tuning: x the turrets, y the billows, z the edge ramp, w the shelf's depth (1 = the design) */
    uniform vec4 uCS;
    /* integer lattice rotations: M xz / P with M integer and P dividing 420 km, so a drift wrap moves each
       field by whole periods, while the tiles of different fields no longer line up along a grazing ray */
    vec2 cldWxUV(vec2 xz) { return vec2(2. * xz.x - xz.y, xz.x + 2. * xz.y) / 140.; }                       // 26.6 deg, a 62.6 km tile
    vec3 cldBaseUV(vec3 p) { return vec3(3. * p.x - 4. * p.z, 5. * p.y, 4. * p.x + 3. * p.z) / 35.; }       // 53.1 deg, 7 km
    vec3 cldDetUV(vec3 p) { return vec3(p.x + 2. * p.z, 2.2360680 * p.y, p.z - 2. * p.x) * (215. / 420.); } // -63.4 deg, .874 km
    vec4 cldWx(vec2 xz) { return textureLod(uWeather, cldWxUV(xz - uDrift0.xy), 0.); }
    /* the far field's 100-200 km modulation (wavelengths 102-133 km, periodic in 420): 0.1..0.9 */
    float cldFar(vec2 xz) {
      vec2 p = xz * (6.2831853 / 420.);
      return .5 + .2 * sin(2. * p.x + 3. * p.y + 1.3) + .12 * sin(p.y - 3. * p.x + 4.1) + .08 * sin(p.x - 4. * p.y + 2.2);
    }
    /* the density in two parts, so a march step that finds cloud does not look the cheap part up twice.
       cldBase: the column (top over a flat base), the far field's thinning and the turrets of the base volume:
       a signed distance f in km (> 0 inside) and the cheap density sat(f / .15) (empty-space skipping, the far
       taps of the light cone, the shadow map). cldFull: the billows and wisps of the detail volume */
    struct CldS { vec4 w; vec3 sp; float z, top, f, hs, pw, lb, mt; };
    /* the last cldFull's depth below the cloud's surface, km (the signed distance after the billows) */
    float cldDepth = 0.;
    /* [round 4] the last cldFull's detail noise (~N(0, 1), 0 where it was not read): the storm base's fine mottle */
    float cldHf = 0.;
    /* the march's pixel footprint at the sample, km: the crisp edges are never thinner than 1.5 pixels */
    float cldFoot = .01;
    /* [r9] how much of round 9's cumulus look a column takes: a cumulus' (not a deck's) under a sky that is not closing over
       (cover under .62, ~61 %) and not a storm's. Every round-9 change is weighted by it, so the 66-100 % decks and the storm
       keep their look */
    /* CLD_R8 1 (the trace's second program, drawn once cover >= .79 or storm >= .69, where this weight is 0 to < .5 %): the weight
       is the constant 0, so every round-9 term folds into round 8's at compile time and the decks and the storm run round 8's
       program (its Intel SIMD8 size and spills; the round-9 program's extra registers cost the 96 % storm +.04-.1 ms, r9/cost-c1) */
    #ifndef CLD_R8
    #define CLD_R8 0
    #endif
    float cldCu(vec4 w) {
    #if CLD_R8
      return 0.;
    #else
      return (1. - w.a) * (1. - smoothstep(.62, .8, uWx0.x)) * (1. - smoothstep(.3, .7, uWx2.w));
    #endif
    }
    float cldBase(vec3 q, float lod, out CldS s) {
      s.w = vec4(0.); s.sp = vec3(0.); s.z = 0.; s.top = 0.; s.f = -1.; s.hs = 0.; s.pw = 0.; s.lb = 0.; s.mt = 0.;
      float b0 = uWx0.z, thick = max(uWx0.w - b0, .2);
      float z0 = q.y - b0;
      if (z0 < -.4 * b0 || z0 > thick + .2) return 0.;
      vec2 xz = q.xz - uDrift0.xy;
      /* the tops lean downwind with the wind aloft */
      float dK = length(q.xz);
      /* [round 3] PAST ~18 KM THE CLOUDS MERGE into lines and sheets where the 100-200 km field is dense (REVIEW-2: a
         polka-dot far field of near-identical ellipses): the columns are read from the blurred weather map (up to mip 3,
         ~1 km) and their tops raised, so neighbours join into flat-topped bands; where the far field is sparse they stay
         apart. One fetch either way */
      float farD = smoothstep(16., 32., dK) * (1. - smoothstep(.8, .95, uWx0.x));
      float farM = farD * smoothstep(.45, .75, cldFar(xz));
      vec4 w = textureLod(uWeather, cldWxUV(xz - uAloft.xy * max(z0, 0.) * .3), 3. * farD);
      if (farD > 0.) { w.r = min(w.r * mix(1., 2.2, farM), 1.); w.b = max(w.b, w.r); }
      s.w = w;
      /* the far field thins (100-200 km), less as the sky fills: each cloud's footprint shrinks round its
         middle at the same height (lowering the tops made thin flat pancakes) */
      float pk = max(w.b, w.r) * thick, qn = w.r / max(max(w.b, w.r), 1e-3);
      float thin = (1. - cldFar(xz)) * (1. - uWx0.x * uWx0.x) * .22;
      /* [round 3] THE STORM'S EDGE (uA1.y km out; from ~90 %): the deck ends in a ragged line and the towers beyond it
         stand apart, so the horizon under the deck's edge is open sky. View-relative, so a reading that sits flat keeps
         its storm where it is; the weather drifting through it changes only the edge's raggedness */
      /* [round 4] over storm .2-.8 (90-95 %, was .3-.6, 90.5-93.5 %): the open sky under the edge lifts the scene's mean by
         ~.6 stop as it opens, and over 3 points a fast-climbing reading outran the meter (the swell of a 60 -> 97 % clip,
         now at 92-94 %) */
      float edgeW = smoothstep(.2, .8, uWx2.w);
      float edge = edgeW * smoothstep(uA1.y - 2., uA1.y + 2., dK + (w.r - .6) * 5.);
      thin = max(thin, edge * .5);
      float s2 = (1. - thin) * (1. - thin);
      float top = pk * sqrt(max(0., 1. - (1. - qn * qn) / s2)) * (1. - edge * w.a);
      /* under the wettest cells the base sags (the rain foot): up to 35 % of its height */
      float z = z0 + .35 * w.g * b0;
      if (top <= .004 || z < -.03 - .5 * w.a * b0 - .05 * w.a || z > top + .25) return 0.;
      vec3 sp = vec3(q.x - uDrift0.z, q.y, q.z - uDrift0.w);
      /* [round 5] under a rain deck (66-90 %) the base volume is read a mip coarser (its 55 m voxels at 110 m: the .44-.87 km
         octaves of the mottle still resolved; 2 mips smoothed the deck into satin, r5 w4; full detail cost Intel T1 +.2 ms at
         80 %, r5 tim5). The storm reads it in full */
      vec4 n = textureLod(uBase, cldBaseUV(sp), max(lod, 0.) + ${LK("rmip", 1)} * w.a * (1. - smoothstep(.3, .7, uWx2.w)));
      float hn = wxSat(z / max(top, .05));
      /* turrets and lumps on the dome (the base volume's Worley octaves, 1.75 / .87 / .44 km, normalised to
         about N(0, 1)): little on the flat base, most on the tops; a deck's underside gets lumps of its own */
      float lump = ((n.g * .25 + n.b * .45 + n.a * .3) - .714) * 9.;
      /* the base rounds up toward the rim: flat under the inner two thirds of a cumulus, closed at its edge */
      /* [r9] a cumulus' base is flat out to its last fifth (rim^3, was rim^2: a lens under every cloud, the cotton look) */
      /* (the rim's power by products, not pow(): cldBase runs at every step and cone tap, the storm's too) */
      float rim = 1. - top / max(pk, 1e-3), r2 = rim * rim, bot = .3 * pk * mix(r2, r2 * rim, cldCu(w)) * (1. - w.a);
      float ampT = min(.3, .35 * pk) * (.25 + .75 * hn) * mix(1., .55, w.a) * uCS.x;
      /* a deck's base hangs in rounded lumps (the base volume's 1.75 and .87 km octaves, up to 300 m), shredded
         into scud by the inverted billows below it */
      /* pouches hang (up to 300 m); the dents between them stay shallow and round (a dent that folded into a
         V seen edge-on drew a glowing crack line) */
      /* [round 4] under a storm's deck a third octave (.44 km): mammatus-like lumps on the pouches (the rolls alone read
         airbrushed next to sc-milton's lumpy base) */
      float mam = smoothstep(.3, .7, uWx2.w) * w.a;
      float lumpB = ((n.g * mix(.6, .45, mam) + n.r * mix(.4, .25, mam) + n.a * .3 * mam) - .7) * 8.;
      lumpB = lumpB > -.6 ? lumpB : -.6 - .5 * (1. - exp(lumpB + .6));
      /* [round 5] a rain deck's pouches are 100 m, the storm's 300-380 m: at 300 m every rain deck hung smooth mammatus lobes
         (REVIEW-4 #3, f480) */
      float ampB = mix(.05, mix(.1, .3, smoothstep(.3, .7, uWx2.w)) + .08 * mam, w.a) * min(1., top * 2.);
      /* [round 3] the shelf: just inside the storm's edge the deck's base hangs 250 m lower in a smooth, laminar band
         (a shelf cloud's underside), its lumps flattened */
      float shelf = edgeW * w.a * smoothstep(uA1.y - 5., uA1.y - 2., dK) * (1. - smoothstep(uA1.y - 1., uA1.y + 1., dK));
      bot -= .25 * uCS.w * shelf; ampB *= 1. - .7 * shelf;
      /* [round 4] PAST ~16 KM the columns come from the blurred map and every cloud was the same smooth lens (REVIEW-3
         #8, sunset's far field): their tops take the base volume's lumps at a quarter of their height, so neighbours
         differ in height and outline */
      float f = min(top - z + lump * (ampT + farD * .25 * pk), (z - bot) * 3. + .03 + mix(lump, lumpB, w.a) * ampB);
      /* scud (pannus): ragged shreds 100-300 m under a wet deck, carried by the whole wind aloft (a fifth faster
         than the deck's own lumps, which ride the shape layer), so they race under it; the base's inverted
         billows tear them */
      if (w.a > .3 && uWx1.y > 0. && z < .06) {
        vec2 su = vec2(3. * xz.x - 4. * xz.y, 4. * xz.x + 3. * xz.y) / 17.5;      // 53.1 deg, 3.5 km tile, 17.5 km period
        /* [round 3] stretched 2:1 along one lattice axis (period 35 km: 12 in 420) into ragged streamers, not puffs */
        vec4 m = textureLod(uBase, vec3(su.x * .5, q.y / 3.5 + .37, su.y), max(lod + 1., 0.));
        /* [round 3] fragments, not a layer: ~20 % of the sky at the storm (it was half, a continuous murk 100-500 m up
           that hid the base), 60-200 m thick, 60-250 m under the base */
        float sc = ((m.b * .5 + m.a * .5) - .714) * 8. - mix(2.4, 1.1, uWx1.y * w.a);
        float zc = -.25 * b0 - .03, hw = .03 + .07 * wxSat((m.r - .7) / .26);
        f = max(f, min(sc * .08, hw - abs(z - zc)));
      }
      s.sp = sp; s.z = z; s.top = top; s.f = f; s.hs = z / thick; s.lb = lumpB;
      s.pw = wxSat((n.r - .7) / .26);
      /* [round 4] the mid-scale mottle (the .87 and .44 km octaves, ~N(0, 1)) */
      s.mt = ((n.b * .5 + n.a * .5) - .714) * 8.;
      return wxSat(f / .15);
    }
    float cldFull(CldS s, vec3 q, float lod, bool light) {
      vec3 dp = s.sp;
      float hn = wxSat(s.z / max(s.top, .05));
      if (!light) {
        vec2 cu = textureLod(uCurl, (q.xz - uDrift1.zw) / 5., 0.).rg * 2. - 1.;
        /* curl-warped: wisps at the base, rolled billows above. [round 4] half as much under a deck (w.a): its base read as
           silky streaks, smeared paint at 66-72 % and satin swirls under the storm (REVIEW-3 #8, f-seams; r5 v68, s96) */
        dp += vec3(cu.x, 0., cu.y) * .16 * (1. - .7 * hn) * (1. - .5 * s.w.a);
      }
      vec3 dn = textureLod(uDetail, cldDetUV(dp), max(lod + 1., 0.)).rgb;
      /* [r9] A SMALL CUMULUS IS A HEAP OF SMALL BILLOWS (the overhead ones, 300-600 m across, were one 440 m billow each: a smooth
         blob at 1-2 km): under a peak of ~.7 km the billows lean on the 220 and 110 m octaves */
      float cu = cldCu(s.w), smc = ${LK("sms", .7)} * cu * (1. - smoothstep(.25, .75, max(s.w.b, s.w.r) * max(uWx0.w - uWx0.z, .2)));
      float hf = (dot(dn, mix(vec3(.55, .3, .15), vec3(.2, .4, .4), smc)) - .714) * 8.;
      /* a fourth octave at 4x (a 219 m tile) for the near clouds: their cauliflower down to tens of metres */
      if (!light && lod < -1.5) {
        /* [r9] stronger (.5, was .3), and a fifth at 16x (a 55 m tile) within ~1.5 km: a near cumulus at 1:1 read as smooth plastic */
        hf = mix(hf, hf * .75 + (textureLod(uDetail, cldDetUV(dp) * 4., 0.).g - .714) * 8. * mix(.3, ${LK("o4w", .5)}, cu), wxSat(-1.5 - lod));
        if (cu > 0. && lod < -3.) hf += (textureLod(uDetail, cldDetUV(dp) * 16., 0.).g - .714) * 8. * ${LK("o5w", .25)} * cu * wxSat(-3. - lod);
      }
      /* billows on the tops, wisps toward the base (Nubis: the detail inverted low down) */
      hf = mix(-hf, hf, smoothstep(.04, .3, hn));
      /* [r9] (a cumulus' base wisps at .7: they rounded its flat base off) */
      float amp = (.07 * mix(1., ${LK("bws", .7)}, cu) + .2 * hn) * min(1., s.top * 4.) * mix(1., .6, s.w.a) * uCS.y;
      /* [round 3] a rain deck's base and its scud are torn: twice the billows' reach there (the base read airbrushed) */
      amp *= 1. + uA1.z * s.w.a * (1. - smoothstep(.05, .3, s.z));
      /* [round 5] where a deck thins toward a gap it frays (REVIEW-4 #3: a hard-edged blue hole at 66-70 %, its rim a smooth
         lens): the billows tear its thin parts up to 2.5x as far */
      /* [round 6] .5 (was 1.5): the torn thin parts drew jagged crease lines that a sun behind the deck lit as veins (REVIEW-5 #2);
         the soft seams (the weather map) now keep the gaps from reading as hard holes */
      amp *= 1. + ${LK("rfr", .5)} * s.w.a * (1. - smoothstep(.08, .4, s.top));
      float f2 = s.f + hf * amp;
      cldDepth = f2; cldHf = hf;
      /* the density ramp at the surface: 10-20 m on a cumulus' billowed sides and tops (crisp, as the photographs
         show them), 100 m at its base and on a deck (soft, wispy), never under 1.5 pixels; denser and thinner
         parts inside */
      /* [round 5] a rain deck's (66-90 %) edges twice as soft, 440 m at its base: at 100 m a sun behind a thinning deck lit
         the rims of its pouches and gaps as thin bright veins (REVIEW-4 #3); a softer edge spreads the same light into a
         broad glow with wisps, as a sun behind nimbostratus shows (ref/sky/ns-hockenheim5). The storm keeps 100 m */
      float rk = smoothstep(.6, .72, uWx0.x) * (1. - smoothstep(.3, .7, uWx2.w));
      /* [r9] a cumulus' base 60 m (100), its billowed tops 8 m (14: at 1-2 km a 14 m ramp is 10 px of airbrush) */
      float ramp = mix(mix(mix(.1, ${LK("brp", .06)}, cu), mix(.014, ${LK("rpt", .008)}, cu), smoothstep(.12, .5, hn)), mix(.1, .22, rk * (1. - smoothstep(.1, .4, hn))) * (1. + rk), s.w.a);
      float d = wxSat(f2 / (max(ramp, cldFoot * 1.5) * uCS.z));
      /* [round 6] SMALL CUMULUS ARE OPTICALLY THICK (REVIEW-5 #1, cotton puffs): a humilis 100-400 m deep came out translucent
         (an optical depth of ~5-10 across it, cld.dbg=4), so a low sun behind it lit its whole body through the forward lobe
         (pink cotton at sunset) and at noon it read as a soft airbrushed blob; up to twice the density in the small ones */
      d *= 1. + ${LK("cud", 1)} * (1. - s.w.a) * (1. - smoothstep(.1, .5, s.top));
      return d * (.55 + .45 * s.pw);
    }
    float cldDensity(vec3 q, bool full, float lod, out vec4 w) {
      CldS s; float c = cldBase(q, lod, s); w = s.w;
      return c <= 0. || !full ? c : cldFull(s, q, lod, false);
    }
    /* the rain below the base: grey curtains hanging from the wet cells, slanted downwind */
    float cldRain(vec3 q) {
      if (uWx1.y <= 0.) return 0.;
      float below = uWx0.z - q.y;
      if (below < 0.) return 0.;
      vec2 xz = q.xz - uAloft.xy * below * .45;
      float g = cldWx(xz).g;
      float n = textureLod(uBase, cldBaseUV(vec3(xz.x - uDrift0.z, q.y * .3, xz.y - uDrift0.w)) * 2., 2.).g;
      /* curtains with gaps between them: the shafts of a cell, 1-2 km, slanted downwind */
      g = wxSat(g * smoothstep(.45, .85, n) * 1.8);
      /* [round 2] the rain carries most of the reading's lost visibility itself, in curtains (atmo.js keeps the
         uniform fog at 1 - .65 precip of it): between the shafts the base shows, in them it greys out */
      return max(1.6 * g, g * 3.912 / max(uWx1.w, .5) * 1.1) * (1. - .55 * wxSat(q.y / max(uWx0.z, .1)));
    }`;

  /* [round 3] the density field as a library, for the sky composite's flash volume (sky.js) */
  WX.lib("cldfield", FIELD);

  const TRACE = FIELD + `
    const vec3 CLD_CONE[7] = vec3[7](vec3(0.), vec3(.5, -.3, .2), vec3(-.4, .4, -.3), vec3(.2, .3, -.6), vec3(-.6, -.2, .4), vec3(.3, -.5, -.3), vec3(0.));
    /* [r9] the entry's taps (km): 80 m up, 250 m up, 80 m down, then +-80 m in x and z */
    const vec3 CLD_AO[7] = vec3[7](vec3(0., .08, 0.), vec3(0., .25, 0.), vec3(0., -.08, 0.), vec3(.08, 0., 0.), vec3(-.08, 0., 0.), vec3(0., 0., .08), vec3(0., 0., -.08));
    uniform vec2 uBlock, uOff; uniform float uSteps, uLightTaps; uniform int uNLight, uNRain;
    /* tuning: x the ambient, y the twilight arch, z the deep-path energy, w the powder (1 = the design) */
    uniform vec4 uCK;
    /*@lab*/ uniform float uDbg; /*@end*/
    /* a full update (still frames) blends into the same texel's history (uFullA < 1): a still converges to a
       clean mean instead of drawing new noise every frame */
    uniform sampler2D uHistL, uHistZ; uniform float uFullA;
    layout(location = 0) out vec4 oL; layout(location = 1) out vec4 oZ;
    float cldSphFar(float r, float mu, float R) { vec2 s = wxSphere(r, mu, R); return s.x; }
    void cldTrace(out vec4 oL, out vec4 oZ);
    void main() {
      cldTrace(oL, oZ);
      if (uFullA < 1.) {
        ivec2 p = ivec2(gl_FragCoord.xy);
        vec4 hz = texelFetch(uHistZ, p, 0);
        if (abs(hz.g - oZ.g) < .5) { oL = mix(texelFetch(uHistL, p, 0), oL, uFullA); oZ.r = mix(hz.r, oZ.r, uFullA); }
      }
    }
    void cldTrace(out vec4 oL, out vec4 oZ) {
      vec2 blk = floor(gl_FragCoord.xy);
      vec2 pix = blk * uBlock + uOff + .5;
      vec2 uv = pix * uCloudRes.zw;
      vec3 rd = wxRay0(uv);
      float r0 = R_G + wxEye * 1e-3;
      vec3 ro = vec3(0., r0, 0.);
      /* the march's start offset: interleaved gradient noise over the buffer, turned by the golden ratio at
         each refresh of the texel, so a still converges to a smooth mean instead of a fixed stipple */
      float refresh = floor(uFrame.x / (uBlock.x * uBlock.y));
      float jit = fract(wxIGN(pix) + .61803399 * refresh);
      vec3 ambClear = texelFetch(sAmbient, ivec2(2, 0), 0).rgb, ambBelow = texelFetch(sAmbient, ivec2(1, 0), 0).rgb;
      /* [round 3] (texel 2 carries the night sky's own light, contract 1.3's wxNightAmbient: a moonless cloud's top
         ~0.8x the sky beside it, its base less) */
      vec3 ambSky = texelFetch(sAmbient, ivec2(0, 0), 0).rgb, arch = texelFetch(sAmbient, ivec2(3, 0), 0).rgb;
      /* [round 3] no flash light in the amortized trace: refreshed 1/16 (or 1/8) of the texels a frame, it drew a
         flash as 4x4 blocks that lingered after it (the blocky blob at blue hour). AMBIENT texels 0 and 1 carry a
         flash's diffuse share: take it out here; the sky composite lights the cloud per pixel, per frame */
      vec3 flA = atmFlashAmb();
      ambSky = max(ambSky - flA, vec3(0.)); ambBelow = max(ambBelow - flA * .08, vec3(0.));
      vec3 town = atmTown() * uExpo.x;
      /* [round 5] THE FACE OF A CLOUD WE SEE LOOKS BACK AT US (REVIEW-4 #5: pastel cotton puffs at sunset and dusk). It is lit
         by the half of the sky behind the viewer, not by the whole sky's mean, which a low sun fills with peach: looking toward
         the sun we see the clouds' far sides under the blue-grey half of the sky (the Earth's shadow), looking away their
         sunward sides under the warm half (ref/sky/ss-baltic, ss-sozopol: blue-grey bodies, warm-lit undersides and rims).
         A first-order dipole: half of texel 3 (the sky's excess toward the sun's azimuth) taken off, or added, along the
         view's horizontal direction, never under a quarter of the mean */
      vec2 azS = length(uSun.xz) > 1e-4 ? normalize(uSun.xz) : vec2(0., 1.);
      float facing = length(rd.xz) > 1e-4 ? dot(normalize(rd.xz), azS) : 0.;
      ambClear = max(ambClear - arch * .5 * facing, ambClear * .25);
      vec3 Lk = uKey.xyz; float keyE = uKey.w * uExpo.x;
      bool sunKey = dot(Lk, uSun.xyz) > .999;
      float cosT = dot(rd, Lk);
      float hzMu = -sqrt(max(0., 1. - R_G * R_G / (r0 * r0)));
      /* what this ray ends on: the cove (last world frame's SCENEZ, drawn with last frame's jitter), the sea, or the sky */
      float zc = texture(sSceneZ, wxUVPrev(rd)).r;
      bool land = zc > 0.;
      bool sea = !land && rd.y < hzMu;
      float tSurf = land ? zc * 1e-3 : 0.;
      if (sea) { vec2 s = wxSphere(r0, rd.y, R_G); tSurf = s.y > 0. ? s.y : s.x; }
      vec3 L = vec3(0.); float T = 1.;
      float tw = 0., twt = 0.;
      /* ── the rain and its light, from the eye to the surface or under the base (8 steps, denser near) ── */
      /* where the cloud march starts: the base, lowered under wet decks by the rain foot and the scud below it */
      float tB = cldSphFar(r0, rd.y, R_G + uWx0.z * (1. - .8 * uWx1.y));
      float tR = land || sea ? tSurf : min(max(tB, 0.), 40.);
      if (uWx1.y > 0. && tR > 0.) {
        /* the rain and the air share the ray: each segment adds the air's own in-scatter (the AP atlas'
           increment) seen through the rain in front of it, then the rain's; what the caller adds again
           (the sky's or the surface's own aerial perspective, times this T) is taken out at the end */
        float phR = mix(wxHG(cosT, .55), 1. / (4. * PI), .4);
        float t0 = 0.; vec3 apPrev = vec3(0.);
        for (int i = 0; i < uNRain; i++) {
          float f1 = (float(i) + 1.) / float(uNRain), t1 = tR * f1 * f1;
          float t = mix(t0, t1, jit), dt = t1 - t0; t0 = t1;
          vec4 ap = wxAerial(rd, t1);
          L += T * max(ap.rgb - apPrev, vec3(0.)); apPrev = ap.rgb;
          vec3 p = ro + rd * t; float pr = length(p), alt = pr - R_G;
          if (alt < 0.) alt = -alt;
          vec3 q = vec3(p.x, alt, p.z);
          /* [round 3] the curtains thin toward the eye as the fog does (atmNear) */
          float s = cldRain(q) * atmNear(t);
          if (s <= 1e-4) continue;
          vec3 pM = vec3(p.x * 1e3, alt * 1e3, p.z * 1e3);
          vec3 key = atmLightT(pr, dot(p / pr, Lk), .0047) * keyE * wxCloudShadow(pM);
          /* [round 3] under a rain deck the rain is lit by the deck above (dim) and by the open sky's light from beyond
             the storm's edge (atmUnder), not by the whole sky-above estimate, which fed back on itself and made the
             air overhead brighter than the horizon. (A flash lights it per pixel: wxCloudAt, sky.js) */
          vec3 amR = mix(ambSky * 1.1, ambSky * .35 + atmUnder(length(q.xz)), uA1.z);
          vec3 S = .9 * (key * phR + amR + ambBelow * .3 + town * .5);
          float e = exp(-s * dt);
          L += T * (S * ap.a) * (1. - e); T *= e;
          tw += (1. - e) * T * t; twt += (1. - e) * T;
        }
        L = max(L - T * apPrev, vec3(0.));
      }
      if (land || sea) {
        oL = vec4(wxGuard(L), T); oZ = vec4(tSurf, 1., 0., 1.);
        return;
      }
      /*@lab*/ if (uDbg > 4.5 && uDbg < 5.5) { oL = vec4(wxGuard(L), T); oZ = vec4(1., 0., 0., 1.); return; }
      if (uDbg > 5.5) { L = vec3(0.); T = 1.; } /*@end*/
      /* ── the cloud march (render.md 6.5): coarse steps through empty air, fine ones inside cloud ── */
      float tTop = cldSphFar(r0, rd.y, R_G + uWx0.w + .2);
      float tIn = max(tB, 0.), tOut = min(tTop, tIn + 60.);
      float dAvg = tIn;
      if (rd.y < hzMu + 1e-4 || tIn > 150.) { oL = vec4(wxGuard(L), T); oZ = vec4(max(tIn, 1.), 0., 0., 1.); return; }
      bool far = tIn > 90.;
      float pxKm = 2. * uCamY.w * uCloudRes.w;              // one cloud-buffer pixel, radians
      /* the fine step: about 1/170 of the distance at T2 (40-60 m at 10 km), never under 20 m; the tier's step
         count scales it. The coarse step is 4x that, at least 120 m */
      float kS = 64. / uSteps;
      float a = 1., b = 1., c = 1.;
      float phs[4];
      for (int k = 0; k < 4; k++) { phs[k] = mix(wxHG(cosT, .8 * c), wxHG(cosT, -.3 * c), .35); c *= .5; }
      /* [round 6] g .55 (it was .8, the same as the cumulus', so round 5's softer lobe did nothing).
         [round 5] a rain deck's first octave scatters with a softer forward lobe: its thin parts backlit by a sun behind it
         glow broadly, as a sun behind nimbostratus shows (ns-hockenheim5), not in thin veins along every thinning (REVIEW-4 #3);
         the storm and the cumulus keep theirs */
      float phD = mix(wxHG(cosT, ${LK("rg", .55)}), wxHG(cosT, -.3), .35), rainD = smoothstep(.55, .7, uWx0.x) * (1. - smoothstep(.3, .7, uWx2.w));
      float sigmaBase = 55.;
      vec3 keyTop = atmLightT(R_G + uWx0.w, Lk.y, .0047) * keyE * max(Lk.y, .05);
      vec3 Lc = vec3(0.); float Tc = 1.;
      int maxI = int(uSteps * 1.8);
      bool fine = false; int zeroRun = 0;
      /* [r9f] after sunset (whole under -1 deg, none over 3.4 deg), and the most cumulus a sample of this ray had (for the air in
         front of it) */
      float kDk = smoothstep(.06, -.02, uSun.y), cuMax = 0.;
      /* [r9] the sky's light at a cloud's surface, measured where the ray enters it (aoN): aoU from above, aoD from below */
      float aoU = 1., aoD = 1.; bool aoN = true;
      /* [r9] the surface's outward normal there and how much of it a face takes (nW) */
      vec3 nS = vec3(0.); float nW = 0.;
      float aoK = ${LK("ao", 1)} * (1. - smoothstep(.3, .7, uWx2.w));
      /* [r9f] AFTER SUNSET A CUMULUS IS LIT BY THE AFTERGLOW, NOT BY THE SUN UNDER ITS HORIZON (REVIEW-9 A2: lilac puffs on a violet
         sky): from a sun 1.5 deg under the horizon (the layer's tops leave its light) to 2.9 deg, the light cone turns from the sun
         to the glow, ~15 deg up over the sun's azimuth, so a body between us and the glow is a long path from it (dark) and its
         rims and tops a short one (lit). Cumulus only (the decks keep their light) */
      /* (the weight and the direction are made where they are used: every value kept across the march costs the Intel compile
         registers, and its spills cost every frame) */
      float dtF0 = clamp(tIn * .0068 * kS, .02 * kS, .6), dtE0 = max(dtF0 * 4., .12 * kS);   // [round 3] .0068 (was .006)
      float t = tIn + (far ? 3. : dtE0) * jit;
      for (int i = 0; i < 400; i++) {
        if (i >= maxI || t >= tOut || Tc < .008) break;
        /* in rain and fog the air in front hides the rest: once its transmittance is under 1 %, stop */
        if ((i & 7) == 7 && wxAerial(rd, t).a < .01) break;
        float dtF = far ? 2. : clamp(t * .0068 * kS, .02 * kS, .6), dtE = far ? 4. : max(dtF * 4., .12 * kS);
        vec3 p = ro + rd * t; float pr = length(p), alt = pr - R_G;
        vec3 q = vec3(p.x, alt, p.z);
        float foot = t * pxKm;
        cldFoot = foot;
        float lodB = min(log2(foot / .055), 5.);              // < 0 near: the base and detail at full size
        CldS cs;
        float dc = cldBase(q, lodB, cs);
        if (dc <= 0.) {
          if (fine && ++zeroRun < 8) t += dtF;
          else { fine = false; t += dtE; }
          continue;
        }
        /* a coarse step that lands in cloud steps back and walks in fine steps from there */
        if (!fine && !far) { fine = true; zeroRun = 0; aoN = true; t = max(t - dtE + dtF * jit, tIn); continue; }
        zeroRun = 0;
        float dt = far ? dtE : dtF;
        vec4 w = cs.w;
        /* behind the visible surface (T < .05) what is left adds < 5 %: the cheap density does there */
        cldHf = 0.;
        float d = far || Tc < .05 ? dc * (.55 + .45 * cs.pw) : cldFull(cs, q, Tc > .3 ? lodB : max(lodB, -1.), false);
        float hfS = cldHf;      // (the light cone's cldFull calls overwrite it)
        /* [r9] and the depth below the surface (the cone's cldFull calls overwrote it too: dep was the depth of the cone's third
           full tap, ~250 m toward the light, so a sunlit face took no multiple scattering and a shaded one all of it) */
        float depS = far || Tc < .05 ? 1. : cldDepth;
        if (d > .003) {
          float sig = sigmaBase + 10. * max(smoothstep(.7, 1., uWx0.y), 1. - smoothstep(.1, .35, uWx0.y));
          float st = d * sig;
          /* [r9] THE SKY LIGHTS A CLOUD'S SURFACE BY WHAT IS OPEN ABOVE AND BELOW IT, not by its column alone (the column's
             diffuse transmission lit every point of a flat base alike: a flat grey offset under the key light, the cotton
             look at every hour). Where the ray enters a cloud, the cloud within ~80 and ~250 m above it and ~80 m below it:
             the top of a billow sees the sky, its underside and the crevice under the next one do not. Taken once a
             crossing (the entry sample's surface lights the first tens of metres the eye sees), cumulus only */
          if (aoN && aoK > 0. && !far && Tc > .2) {
            aoN = false;
            float aw = aoK * cldCu(w);
            if (aw > 0.) {
              /* the signed distance (km, > 0 inside) at each tap, not the density (14 m from air to cloud: the occlusion
                 switched in steps and drew hard-edged patches): a tap h above a surface that faces up is h out (none), on a
                 wall about at the surface (half), under an overhang inside (all) */
              /* [r9] THE FACE'S OWN NORMAL: the column's field (the dome, the turrets and the lumps; not the billows, whose normal
                 jumped from one entry to the next and drew blotches on a cloud lit by the sky alone), by central differences over
                 160 m. A face takes the sky, the sea, the dusk's horizon and the twilight arch by the way it faces, and the key's
                 multiple scattering by its facing near the surface: lit tops over grey undersides, lobes in the light.
                 Seven taps in one loop (its bound a uniform's, so the compiler keeps it a loop: written out, the nine density calls
                 grew the trace's Intel SIMD8 program from 4211 to 6688 instructions and its spills from 54 to 100, and the storm,
                 which never runs them, paid +.04 ms): 80 m up (with the billows), 250 m up, 80 m down (with the billows), +-80 m
                 across in x and z */
              float oU = 0., oD = 0.; vec3 gr = vec3(0.); CldS as_;
              for (int k = 0; k < uNRain; k++) {
                if (k >= 7) break;
                vec3 aq = q + CLD_AO[k];
                cldBase(aq, lodB, as_); float fb = as_.f, ff = fb;
                if ((k == 0 || k == 2) && fb > -.3) { cldFull(as_, aq, lodB, true); ff = cldDepth; }
                if (k == 0) { oU += .6 * wxSat((ff + .08) / .16); gr.y += fb; }
                else if (k == 1) oU += .4 * wxSat((fb + .25) / .5);
                else if (k == 2) { oD = wxSat((ff + .08) / .16); gr.y -= fb; }
                else if (k == 3) gr.x += fb; else if (k == 4) gr.x -= fb; else if (k == 5) gr.z += fb; else gr.z -= fb;
              }
              gr /= .16;
              float gl = length(gr);
              if (gl > 1e-3) { nS = -gr / gl; nW = ${LK("nrm", 1)} * aw * smoothstep(.05, .4, gl); }
              aoU = 1. - ${LK("aos", .8)} * aw * oU;
              aoD = 1. - ${LK("aos", .8)} * aw * oD;
            }
          }
          /* the light cone: 6 (or 7) taps, 40 m x 1.9^k, full detail on the first three */
          /* the cone's taps start at a jittered distance (the march's own offset, turned): fixed taps drew the
             optical depth's contours on the clouds as creases */
          float od = 0., sl = .04 * (.6 + .8 * fract(jit + float(i) * .754877)); vec3 lq = q; CldS ls;
          float cuW = cldCu(w);
          vec3 LkC = Lk; float cosA = cosT;
          float dkW = sunKey ? ${LK("dkc", 1)} * smoothstep(-.026, -.05, uSun.y) * cuW : 0.;
          if (dkW > 0.) { LkC = normalize(mix(Lk, normalize(vec3(azS.x, .27, azS.y)), dkW)); cosA = dot(rd, LkC); }
          int nl = far ? 3 : Tc > .4 ? uNLight : min(uNLight, 4);    // full cone only where it shows ([round 3] .4, was .25)
          /* deep under a thick deck the key light is spent (the deck's diffusion term below carries it): no cone */
          if (w.a > .8 && max(cs.top - cs.z, 0.) * sig / max(Lk.y, .1) > 400.) { nl = 0; od = 60.; }
          for (int k = 0; k < uNLight; k++) {
            if (k >= nl) break;
            lq += normalize(LkC + CLD_CONE[k] * .1) * sl;
            float db = cldBase(lq, lodB, ls);
            /* the near taps see the billows round the sample (their shadows give the cauliflower its form);
               the far ones a thinned medium, for the light that diffuses through a deep cloud */
            od += (k < 3 && !far && db > 0. ? cldFull(ls, lq, lodB, true) * .8 : db * .5) * sl * sig;
            sl *= 1.9;
          }
          /* Nubis 2017's in-scatter probability: light that has scattered many times builds up in the dense
             cores and toward the tops, not in the thin crevices between billows or at the base. Applied to the
             multiple-scattering octaves only, so the thin edges keep their single-scattered silver lining:
             the cauliflower's contrast */
          float hnL = wxSat(cs.z / max(cs.top, .05));
          /* by depth below the surface (the billow's own scale, 300 m), not by the density, which is whole a few
             tens of metres in */
          float dep = far || Tc < .05 ? 1. : wxSat(mix(cldDepth, depS, ${LK("dps", 1)} * cuW) / .3);
          /* [round 4] with a low sun the light comes in from the side, not down through the top: the base is no place
             apart, and its .2 drew a darker band along every cloud's bottom at sunset and dusk, an outline round a
             uniform puff (REVIEW-3 #8, clip d) */
          /* [r9] (.05 + the depth's share: a cumulus' sunlit surface took almost none of its multiple scattering, the light that makes
             a thick cloud white; .35 at its surface now) */
          float isp = (mix(.05, ${LK("isf", .35)}, cuW) + pow(dep, mix(.5, 2., smoothstep(.3, .85, hnL)))) * pow(wxSat(wxRemap(hnL, 0., .2, mix(.2, .75, 1. - smoothstep(.04, .2, Lk.y)), 1.)), .8);
          float ms = exp(-od) * mix(phs[0], phD, w.a * rainD); a = .6; b = .4;
          /* [round 6] A CUMULUS BETWEEN US AND THE SUN IS A DARK BODY WITH BRIGHT RIMS (ss-atsea; REVIEW-5 #1): its multiple
             scattering loses more over the cone toward the light (the octaves' .4^k extinction let a thick body glow evenly);
             its thin edges keep the single-scattered rim. Decks keep theirs */
          /* [r9f] AND AT SUNSET STILL MORE (REVIEW-9 A2: rust bodies, salmon puffs): under a sun below ~2 deg the reddened light that
             diffuses through a cumulus is a few per cent of what lights its rims, and the face turned to us shows the anti-sun sky's
             blue-grey (ss-baltic's slate bodies, ss-atsea's dark ones); its rims keep the single-scattered light */
          float odM = od * (1. + ${LK("bkl", 3)} * smoothstep(${LK("bkg", .5)}, .97, cosT) * (1. - w.a) * (1. + ${LK("bkx", 2)} * cuW * (1. - smoothstep(.04, .16, Lk.y))));
          float nKf = nW > 0. ? mix(1., 1.3 * wxSat(.35 + .75 * dot(nS, Lk)), nW * (1. - wxSat(depS * 4.))) : 1.;
          for (int k = 1; k < 4; k++) { ms += a * exp(-odM * b) * phs[k] * isp * nKf; a *= .6; b *= .4; }
          /* four octaves return about half of what a thick slab reflects (albedo ~.8 against ~.14 / pi
             per unit light at normal incidence); make up the deep part's energy, not the thin edges' */
          /* [r9] (a cumulus' at .3: the deep-path lift lit its shaded sides as much as its sunlit ones) */
          ms *= 1. + mix(.6, ${LK("dpe", .3)}, cuW) * uCK.z * (1. - exp(-.4 * od));
          /* powder: in-scatter builds up only where there is depth behind the edge (Schneider 2015) */
          float powder = mix(1., .25 + .75 * (1. - exp(-dep * 4.)), (.55 * (.5 - .5 * cosT) + .15) * uCK.w);
          /* the light beyond the cone (2 km) is the shadow map's: a low sun under a deck no longer reaches a hanging
             lump through the clear air below the base for the cone's length and lights its edge as a glowing crack;
             a cloud in another's shadow far toward the sun goes grey */
          float kSh = far || Lk.y > .35 ? 1. : wxCloudShadow(lq * 1e3);
          /* [round 3] UNDER A SUN AT OR JUST BELOW THE HORIZON THE BASE IS LIT FROM BELOW. The shadow map
             counts the whole layer between a point and the sun, but a point on a deck's base sees a low sun along a path
             that skims under the base, blocked only by the pouches and clouds hanging in it: four taps along that path
             (3-28 km) decide it, so the undersides catch the light in patches with the pouches' shadows between them */
          /* [round 6] EVERY CLOUD UNDER AN OVERCAST TAKES THE DECK'S DIFFUSE LIGHT (REVIEW-5 #2, d-floor-sunset's hard-edged slate lens):
             a cumulus column inside a 62-80 % deck had none of it (w.a 0), nor the low sun under the base, and stood out as a
             flat blue-grey lens with the cumulus' crisp outline in a pink deck */
          float wL = max(w.a, ${LK("wl", 1)} * smoothstep(.62, .8, uWx0.x));
          float wU = wL * (1. - smoothstep(.12, .35, cs.z)) * (1. - smoothstep(-.005, .012, Lk.y));
          if (wU > .01 && !far) {
            float odU = 0., su = 3.; vec3 uq = lq; CldS us;
            for (int k = 0; k < 4; k++) { uq += Lk * su; odU += cldBase(uq, lodB + 2., us) * su * sig * .08; su *= 2.; }
            kSh = mix(kSh, exp(-odU), wU);
          }
          vec3 key = atmLightT(pr, dot(p / pr, Lk), .0047) * keyE * kSh;
          /* the light from around, height-graded: what reaches a point through the cloud above it and below it
             is the diffuse transmission of that much cloud, Td = 1 / (1 + .75 (1 - g) tau) (g .85), so the tops
             see the sky, the flat bases mostly the sea and the light that crossed the cloud: grey, not putty */
          float above = max(cs.top - cs.z, 0.), below = max(cs.z, 0.);
          float TdA = 1. / (1. + .11 * above * sig * .7), TdB = 1. / (1. + .11 * below * sig * .7);
          /* [r9f] after sunset a cumulus' wall sees its side of the sky over the cloud's own shoulder, not through the column above it
             (TdA is the light that crosses the cloud to a point inside it): near the surface of a face turned sideways the sky's
             light is the dome's half it faces (fA), not that times the column's diffuse transmission. Before, every wall turned
             from the glow took next to nothing from the anti-sun sky, and the arch's light through the body was all of its colour */
          cuMax = max(cuMax, cuW);
          if (nW > 0. && kDk > 0.) TdA = mix(TdA, 1., ${LK("wsk", 1)} * kDk * nW * (1. - abs(nS.y)) * (1. - wxSat(depS * 4.)));
          /* after sunset the sky dome is the only light: the clouds take more of it from the sides, which the
             height grading leaves out (REVIEW-1: overhead clouds at .5-1x the zenith sky, not black cut-outs) */
          float dusk = smoothstep(.02, -.1, uSun.y);
          /* the base's side light is the sky round it as it is (texel 0: under a deck, the deck's own dim light) */
          /* [round 3] the town's light falls off out to sea (a far cloud is lit by less of it) */
          /* [round 6] ON A MOONLESS NIGHT A CLOUD SEEN FROM BELOW IS DARKER THAN THE SKY (REVIEW-5 #1, x04b: a grey blob lighter than
             the starry sky, 49 against 41): it hides the airglow and the stars and sees the dark sea; the town's glow and the
             dome's side light on its base at .15 (cloud 37-38 against the sky's 41) */
          float nK = mix(1., ${LK("ntc", .15)}, 1. - smoothstep(-.2, -.1, uSun.y));
          /* [r9] (aoU, aoD: the open sky above and below the entry; the sea's light under a cumulus at blw of the deck's) */
          float blw = mix(1.3, ${LK("blw", .6)}, cuW);
          /* [r9] a face takes the sky by the share of the dome it faces (a top all of it, a wall half, an underside none), the sea
             by the rest, and after sunset the horizon's light by how much it faces sideways: the column alone lit a wall as a top,
             and the base of a cloud at dusk as brightly as its sides */
          float fA = 1., fB = 1., fS = 1.;
          if (nW > 0.) { fA = mix(1., .5 + .5 * nS.y, nW); fB = mix(1., .5 - .5 * nS.y, nW); fS = mix(1., .3 + .9 * (1. - abs(nS.y)), nW); }
          /* [r9f] THE DOME'S DIPOLE BY THE FACE'S OWN NORMAL (REVIEW-9 A2: body and rim one tone at sunset and dusk): round 5 took every
             face we see as looking back at us, so the rims and the tops turned to the glow took the dim half of the sky too. A face takes
             the dome's mean plus half the dipole by its horizontal facing toward the sun's azimuth (a top none of it, a wall turned away
             the anti-sun half: blue-grey); and the horizon's side light by which side it faces. From a sun under 3.4 deg (whole under
             -1 deg): by day the view's dipole stays (the golden hour's dark bodies under lit tops, round 9's best hour) */
          vec3 aC = ambClear, aS = ambSky;
          if (nW > 0. && uSun.y < .06) {
            float kD = nW * ${LK("adn", 1)} * smoothstep(.06, -.02, uSun.y);
            vec3 ambDome = texelFetch(sAmbient, ivec2(2, 0), 0).rgb;
            aC = mix(ambClear, max(ambDome + arch * .5 * dot(nS.xz, azS), ambDome * .25), kD);
            aS = mix(ambSky, max(ambSky + arch * .5 * dot(nS.xz, azS) / max(length(nS.xz), .2), ambSky * .25), kD);
          }
          vec3 amb = (aC * TdA * .9 * aoU * fA + (ambBelow * blw + town * nK * (.3 + .7 / (1. + t * t / 36.))) * TdB * aoD * fB + aS * (.12 * aoD * fB + mix(.3, ${LK("dsl", .3)}, cuW) * dusk * nK * fS) * TdB) * uCK.x;
          /* the twilight arch (AMBIENT texel 3): the sky's excess light from the sun's side, which still lights
             the clouds long after the sun has left them; it crosses them like the sun's own diffuse light */
          /* (the cone's od is only 2 km of the path: its transmission is steepened, so a thick cloud against the
             sunset stays a dark body with bright edges, as photographs show it, not a glowing pink one) */
          /* [round 4] steep only toward the light (a backlit cloud: dark body, glowing edges); away from it the arch light
             falls across the body (a gradient), where the steep falloff drew a lit outline round a flat puff at dusk
             (REVIEW-3 #8, x03) */
          float TdS = 1. / (1. + mix(.05, .22, smoothstep(-.2, .6, cosA)) * (sunKey ? od * mix(1., ${LK("ads", 2)} * (1. + ${LK("adk", 1.5)} * kDk), cuW) : above * sig * .7));
          /* [r9] AND THROUGH A CLOUD'S THIN PARTS IT SCATTERS FORWARD (at dusk the thin edges of a cloud before the afterglow glow
             as its silver lining did; the arch lit only the body, evenly, and a cloud against it was a flat cut-out) */
          vec3 archL = arch * (TdS * (.75 + .35 * (.5 + .5 * cosA)) + ${LK("afw", 1)} * mix(1., ${LK("afd", 0)}, kDk) * exp(-.3 * od) * wxHG(cosA, .55) * 12.566 * cuW) * (1. + 1.6 * dusk) * uCK.y;
          /* [r9] and by the side it faces (the arch is a broad glow 0-30 deg over the sun's azimuth, a wrapped cosine about ~15 deg up:
             2x for the faces that see it, .35x for a base or a wall turned away (the glow's flanks), so before the afterglow a cloud
             is a dark body lit at its tops and sunward edges; round 9's first try, 1 + .6 cos, lit every base: an overhead cloud at
             dusk read two-tone; with none at all the dusk bodies fell to .12 of the sky, black cut-outs) */
          if (nW > 0.) archL *= mix(1., ${LK("afl", .35)} + (2. - ${LK("afl", .35)}) * wxSat((dot(nS, normalize(vec3(azS.x, .27, azS.y))) + .3) / 1.3), nW);
          amb += archL;
          /* [r9f] THE CAULIFLOWER'S FOLDS (REVIEW-9 A1: a near cloud at 1:1 a soft loaf): near a cumulus' surface the billows' own
             displacement says whether a point sits in a bulge (hf > 0: the surface pushed out round it, open to the sky) or in a fold
             between two (hf < 0: hemmed in); the sky's and the arch's light take it, so each bubble has a lit crown and a shaded crease.
             It moves with the cloud's own fields (no screen-space or per-frame term) */
          amb *= mix(1., ${LK("cvf", .4)} + (1. - ${LK("cvf", .4)}) * smoothstep(-1.4, 1.2, hfS), ${LK("cav", 1)} * cuW * (1. - wxSat(depS * 5.)));
          /* [r9f] A CLOUD'S THIN EDGES GLOW WITH THE SKY BEHIND THEM (REVIEW-9 A2: the dusk bodies one tone, the rims dim and violet):
             from sunset on, the light that reaches a thin edge from behind it, scattered forward, is the sky's own along the ray
             (orange before the glow, violet higher), not the twilight arch's mean; an edge with little behind it matches the sky
             there and fades into it, the thick body stays dark. The cone's depth toward the glow is the path behind the sample where
             we look toward the glow, and the forward lobe (cosA) keeps it there */
          if (kDk * cuW > 0.) amb += wxSky(rd) * (${LK("fsk", .5)} * kDk * cuW * exp(-1.5 * od) * smoothstep(.5, .95, cosA));
          /* [round 4] AT SUNSET (sun 0-3 deg) a cumulus is lit from below and the side by the reddened sun, and the sky dome
             fills its body evenly: the dome's share at .7 lets the sun's own gradient show (orange undersides, greyer
             bodies) where the flat fill made uniform salmon puffs (REVIEW-3 #8, d and x02) */
          amb *= 1. - .3 * smoothstep(.055, .015, uSun.y) * smoothstep(-.035, 0., uSun.y) * (1. - w.a);
          /* the deck's own diffusion: the key light that crossed the column above by many scatterings */
          /* [round 3] a storm's deck (Cb, uWx2.w) diffuses it through its full optical depth: its base is darker than the
             light under its edge, as photographs show it */
          if (wL > 0. && Lk.y > 0.) amb += keyTop * wL * .9 / PI / (1. + .11 * above * sig * mix(.7, 1.2, uWx2.w));
          /* [round 3] THE BASE OF A RAIN DECK, LIT FROM THE STORM'S EDGE: the open sky's light that the rain carries in
             (atmUnder) reaches the base's lumps and the scud from the side, outward, nearly along the view: a short
             march toward it (3 taps, 0.12-1.1 km) finds how much of the base's own relief it crosses, and forward
             scattering lights the outer sides of the pouches and the gaps between them while their cores stay dark */
          if (uA1.z > 0. && w.a > .2 && cs.z < .45) {
            float dq = length(q.xz);
            vec3 U = atmUnder(dq);
            vec3 Le = vec3(q.x, 0., q.z) / max(dq, 1e-3);
            float odE = 0., es = .1; vec3 eq = q; CldS es_;
            for (int k = 0; k < 3; k++) { eq += Le * es; odE += cldBase(eq, lodB, es_) * es * sig * .4; es *= 2.5; }
            /* (scud, below the base, takes the rim at a third: lit from beside it read as bright cotton puffs)
               [round 4] a quarter of the diffuse part (.6 -> .15) and half the forward part, which only the thin parts pass
               (od x 2): the base lit at .2-.7 of the clear horizon read as a light grey sheet barely darker than the band
               under the edge (REVIEW-3 #1: 0.87 stops on screen; sc-milton's base is a quarter of its horizon) */
            /* [round 6] (weighted from w.a .2 to .4, not cut at .2: no contour where a deck meets a cumulus column) */
            amb += smoothstep(.2, .4, w.a) * U * (.15 * TdB + exp(-2. * odE) * wxHG(dot(rd, Le), .45) * 1.6 * mix(.33, 1., smoothstep(-.08, 0., cs.z)) * mix(${LK("rrim", 1)}, 1., smoothstep(.3, .7, uWx2.w))) * (1. - smoothstep(.15, .45, cs.z));
          }
          /* [round 3] a storm's pouches hang into the dark air under the deck and see little but the sea: the deeper a
             lump hangs, the darker its underside; the recesses between them stay lighter (sc-milton: charcoal lumps,
             light grey seams) */
          /* [round 4] .25 under the deepest (was .3; .15 drew one smooth black lens overhead, r5 s96 next to sc-milton) */
          if (w.a > .3 && cs.z < .35) amb *= mix(1., mix(1.5, .25, smoothstep(-.4, .9, cs.lb)), uA1.z * (1. - smoothstep(.1, .35, cs.z)) * smoothstep(.3, .5, w.a));
          /* [round 4] THE STORM BASE IS MOTTLED AT EVERY SCALE (REVIEW-3 #1: airbrushed rolls; sc-milton's base is dark and light
             swirls from ~100 m to kilometres): the lowest few hundred metres of a rain deck vary in thickness and wetness, so
             the light from below and from the edge that a place returns varies with it. The base's light follows the field's
             own mid (.44-.87 km) and fine (.1-.2 km, curl-warped: swirls) octaves, about +-1 stop, its mean kept
             (2^(.75 m - .28) over m ~ N(0, 1.2)) */
          /* [round 5] AND SO IS A RAIN DECK'S (REVIEW-4 #3: from 66 to ~90 %, where usage sits for hours, the deck was smooth
             satin lobes; the storm's mottle stopped at ~92 %): the same mottle fades in with the deck from ~64 % (cover .62-.8)
             and reaches 1.4x the storm's amplitude by ~76 % (at .7 the 76-88 % deck still read as satin bands, r5 w3/w4: the
             thinner rain deck's base shows its texture against the light more than the storm's dark one), and over the key light
             that it still lets through at half that, so a sun behind it lights the base in patches, not along smooth rims. The
             storm's own weight takes over above ~91 % */
          /* [round 6] from 64 % (cover .6-.68: full by 66 %, was .62-.8, full by ~76 %): the mottle breaks up the 66-76 % deck as it
             does the rain deck above it (REVIEW-5 #2); and weighted by the deck share (wL, so a cumulus column inside the overcast
             is mottled too: it stood as a smooth dark lens in it) from .3 to .55 (it was cut at .3: a contour) */
          float mwR = ${LK("rmot", 1.4)} * smoothstep(${LK("rm0", .6)}, ${LK("rm1", .68)}, uWx0.x), mK = 1.;
          if (wL > .3 && cs.z < .45) {
            /* (the fine part is the detail volume's Worley octave on a 290 m tile (3 in its .87 km one: a whole number, so the 420 km wrap stays seamless) read without the curl warp: bumps, as sc-milton's
               base shows them; the curl-warped one alone drew satin streaks) */
            float fb = (textureLod(uDetail, cldDetUV(cs.sp) * 3., max(lodB + 1., 0.)).g - .714) * 8.;
            /* (a rain deck's mottle leans on the mid octaves: the fine bumps alone read as an even fleece at 84-88 %) */
            float stW = smoothstep(.3, .7, uWx2.w), wS = uA1.z * stW;
            float mt = clamp(mix(.75 * cs.mt + .25 * hfS + .3 * fb, .5 * cs.mt + .3 * hfS + .5 * fb, stW), -2.2, 2.2), zf = 1. - smoothstep(.2, .45, cs.z);
            /* (past a reach of 1 the rain deck's mottle grows in amplitude, its mean kept) */
            float aR = mix(max(mwR, 1.), 1., stW), M = exp2(.75 * mt * aR - .28 * aR * aR); zf *= smoothstep(.3, .55, wL);
            amb *= mix(1., M, min(max(wS, mwR), 1.) * zf);
            mK = mix(1., pow(M, ${LK("rkey", .5)}), min(mwR, 1.) * zf * (1. - stW));
          }
          /* [round 6] AT A SUN UNDER ~2 DEG A CUMULUS' BASE IS IN ITS OWN SHADOW (REVIEW-5 #1, clip d, x02): the rounded underside
             and the wisps hanging from it caught the grazing light and lit the whole puff pink from below; toward the sun the
             lowest 5-45 % of its height takes the key light only at its top (the rims and the sunward sides keep theirs) */
          float kLow = ${LK("kbs", 1)} * (1. - smoothstep(.03, .15, Lk.y)) * (1. - w.a) * (1. - smoothstep(-.2, .6, -cosT + .6));
          vec3 S = key * ms * powder * mK * mix(1., smoothstep(.05, .45, hnL), kLow) + amb;
          /*@lab*/ if (uDbg > .5 && uDbg < 4.5) S = uDbg < 1.5 ? key * ms * powder : uDbg < 2.5 ? amb - archL : uDbg < 3.5 ? archL : vec3(hnL, dep, exp(-.1 * od)) * 2e-2 * uExpo.x; /*@end*/
          float e = exp(-st * dt);
          vec3 Si = S * (1. - e) * .98;
          Lc += Tc * Si;
          tw += Tc * (1. - e) * t; twt += Tc * (1. - e);
          Tc *= e;
        }
        t += dt;
      }
      if (twt > 0.) dAvg = tw / twt;
      vec4 ap = wxAerial(rd, dAvg);
      /* [r9f] AT SUNSET THE AIR IN FRONT OF A CUMULUS BANK IS IN ITS SHADOW (REVIEW-9 A2: rust bodies, salmon puffs, ss-atsea's and
         ss-baltic's are dark slate): under a sun below ~3 deg the light that reaches the low haze between us and the clouds near its
         azimuth has crossed the cloud layer over tens of km (crepuscular rays, not an even glow), which the sky-view's mean shadow and
         the AP's coarse froxels leave lit. The in-scatter in front of a cumulus toward the sun is cut by up to aps; the clear sky round
         it keeps its glow, so the bodies stand dark against it */
      #if !CLD_R8
      if (sunKey && Tc < .999) ap.rgb *= 1. - ${LK("aps", .8)} * cuMax * (1. - smoothstep(.02, .09, Lk.y)) * smoothstep(.3, .9, cosT) * (1. - Tc);
      #endif
      /* in front of the cloud the sky's own in-scatter stays; the cloud hides what is behind it */
      vec3 Lout = Lc * ap.a + ap.rgb * (1. - Tc);
      L += T * Lout; T *= Tc;
      oL = vec4(wxGuard(L), T);
      oZ = vec4(max(dAvg, .5), 0., 0., 1.);
    }`;

  return {
    name: "clouds",
    *build(R) {
      V = null; cur = 0; needFull = true; lastDrift = null; wx.cov = -1; wx.age = 99; wx.band = -1; wx.blend = false; wx.left = 0; shQ = -1; shBlend = false;
      /*@lab*/ R.priv.skyBuild = R.priv.skyBuild || { t0: performance.now() }; /*@end*/
      P.noise = R.program("clouds.noise", { fs: NOISE + `
        uniform float uZ, uN; uniform int uKind; out vec4 o;
        void main() {
          vec3 p = vec3(gl_FragCoord.xy, uZ + .5) / uN;
          if (uKind == 0) {
            /* five octaves (4..64 cycles per tile): finer ones would fall under the 128^3 voxels and alias */
            float pf = clamp(cldPerlinFbm(p, 4., 5) * 1.2 + .5, 0., 1.);
            /* five Worley fields (4..64 cells per tile) make the three fBm octave sets */
            float W4 = cldWorley(p * 4., 4.), W8 = cldWorley(p * 8., 8.), W16 = cldWorley(p * 16., 16.);
            float W32 = cldWorley(p * 32., 32.), W64 = cldWorley(p * 64., 64.);
            float w0 = W4 * .625 + W8 * .25 + W16 * .125, w1 = W8 * .625 + W16 * .25 + W32 * .125, w2 = W16 * .625 + W32 * .25 + W64 * .125;
            float pw = wxRemap(pf, 0., 1., w0, 1.);
            o = vec4(clamp(pw, 0., 1.), w0, w1, w2);
          } else {
            o = vec4(cldWorleyFbm(p, 2.), cldWorleyFbm(p, 4.), cldWorleyFbm(p, 8.), 1.);
          }
        }` });
      P.curl = R.program("clouds.curl", { fs: NOISE + `
        out vec4 o;
        float pot(vec2 p) { return cldPerlinFbm(vec3(p, .37), 4., 3); }
        void main() {
          vec2 p = gl_FragCoord.xy / 128., e = vec2(1. / 128., 0.);
          float dx = pot(p + e.xy) - pot(p - e.xy), dy = pot(p + e.yx) - pot(p - e.yx);
          vec2 c = vec2(dy, -dx) * 128. / 2. * .08;
          o = vec4(clamp(c * .5 + .5, 0., 1.), 0., 1.);
        }` });
      /* cirrus: fibres along the mean wind aloft (from 30 deg left), on integer lattices so the tile
         stays periodic: a = x - 2z runs along the fibres, b = 2x + z across them */
      P.cirrus = R.program("clouds.cirrus", { fs: NOISE + `
        out vec4 o;
        float pn(vec2 p, vec2 per) { return cldPerlin(vec3(p, .5), per.x) * .5 + .5; }
        float vn2(vec2 p, vec2 per) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
          float a = wxHash12(mod(i, per)), b = wxHash12(mod(i + vec2(1, 0), per));
          float c = wxHash12(mod(i + vec2(0, 1), per)), d = wxHash12(mod(i + vec2(1, 1), per));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }
        /* [round 4] the cloudlets differ (REVIEW-3 m-phone: a regular cobblestone of equal cells): each point wanders over
           its whole cell (.05-.95, was .15-.85) and each cell has its own size, .55-1 of the round cap */
        float acCell(vec2 p, vec2 per) {
          vec2 i = floor(p), f = fract(p); float d = 1e9, wv = 1.;
          for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
            vec3 h = wxHash33(vec3(mod(i + vec2(x, y), per) + 5.3, 7.1));
            vec2 r = vec2(x, y) + .05 + .9 * h.xy - f; float e = dot(r, r) / mix(.55, 1., h.z);
            if (e < d) { d = e; wv = h.z; }
          }
          return (1. - min(d, 1.)) * (.8 + .2 * wv);
        }
        void main() {
          vec2 uv = gl_FragCoord.xy / 512.;
          float a = uv.x - 2. * uv.y, b = 2. * uv.x + uv.y;
          float s = 0., amp = .5;
          for (int k = 0; k < uOct && k < 4; k++) {
            float fa = 2. * exp2(float(k)), fb = 20. * exp2(float(k));
            vec2 warp = vec2(vn2(vec2(a * 3., b * 3.) * exp2(float(k)), vec2(3., 3.) * exp2(float(k))) - .5) * .18 / exp2(float(k));
            s += amp * vn2(vec2(a * fa, (b + warp.x) * fb), vec2(fa, fb));
            amp *= .5;
          }
          float mask = (1. - sqrt(1. - cldWorley(vec3(uv * 5., .3), 5.))) * .6 + vn2(uv * 3., vec2(3.)) * .4;   // 1 - F1 (the cones), as round 1's cirrus had
          float hook = vn2(vec2(a * 6., b * 9.), vec2(6., 9.));
          /* [round 3] alpha: altocumulus cloudlets for sky.js (round caps, 1 - F1^2, at 44 and 88 per tile: ~300 m on its
             15 km tile), in rows along a lattice direction near the wind aloft */
          vec2 ap = vec2(3. * uv.x - 2. * uv.y, 2. * uv.x + 3. * uv.y);
          /* [round 4] the rows bend: a warp of about one cell over ~2 km of the tile (periodic) */
          vec2 aw = (vec2(vn2(uv * 7., vec2(7.)), vn2(uv * 7. + .5, vec2(7.))) - .5) * 2.2;
          float acc = acCell(ap * vec2(10., 14.) + aw * vec2(10., 14.) * .09, vec2(10., 14.)) * .7 + acCell(uv * 88. + aw * 3., vec2(88.)) * .3;
          o = vec4(s / .94, mask, hook, acc);
        }` });
      /* the weather map (round 2): per column the cloud's top over the flat base, from cumulus cells and a deck */
      P.weather = R.program("clouds.weather", { fs: NOISE + `
        uniform float uCov, uType, uPrecip, uThick; uniform vec2 uAxis; out vec4 o;
        float pn2(vec2 p, float f) { return cldPerlin(vec3(p * f, .5), f) * .5 + .5; }
        /* [round 5] a smooth minimum of the distances (K ${LK("scK", 7)}): the plain F1 folds into a V along every border between
           two cells, so a deck's seams were creases of thin cloud that a sun behind it lit as bright veins (REVIEW-4 #3); the
           smooth one rounds them into broad, shallow troughs. (Its borders sit ln 2 / K higher: the seams' threshold follows) */
        float scCell(vec2 p, vec2 per, float K) {
          vec2 i = floor(p), f = fract(p); float sm = 0.;
          for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
            vec2 o = vec2(x, y), r = o + .05 + .9 * wxHash22(mod(i + o, per) + 3.1) - f; sm += exp(-K * dot(r, r));
          }
          return 1. - min(-log(max(sm, 1e-6)) / K, 1.);
        }
        float fbm2(vec2 p, float f) { return pn2(p, f) * .5 + pn2(p, f * 2.) * .25 + pn2(p, f * 4.) * .15 + pn2(p, f * 8.) * .1; }
        /* [r9f] a smooth periodic value noise (per cells to the tile), 0..1: cheap enough to read once per cloud */
        float wmVn(vec2 p, float per) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
          float a = wxHash12(mod(i, per) + 41.), b = wxHash12(mod(i + vec2(1, 0), per) + 41.);
          float c = wxHash12(mod(i + vec2(0, 1), per) + 41.), d = wxHash12(mod(i + vec2(1, 1), per) + 41.);
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }
        /* [r9f] THE FIELD IS ORGANISED (REVIEW-9 A1: polka dots, one scale spread evenly): fair-weather cumulus over the sea gather in
           groups a few km across with clear lanes between them, and in places in streets along the wind aloft (rolls ~2-3 times the
           boundary layer's depth apart: here 4.3 km, across the lattice direction (2, 3), which lies along the wind's cross direction
           within 0.3 deg, so the waves stay periodic in the tile). Read once per cloud, at its centre (cen, tile uv): a cloud is
           kept whole or left out, never cut by the pattern. 1 in a group or on a street, toward 0 in a lane */
        float wmOrg(vec2 cen) {
          float g = wmVn(cen * 8., 8.) * .6 + wmVn(cen * 16. + 3.7, 16.) * .4;
          float ph = (wmVn(cen * 3. + 1.3, 3.) - .5) * 9.;
          float st = .5 + .5 * cos(6.2831853 * dot(cen, vec2(8., 12.)) + ph);
          float sw = smoothstep(.3, .7, wmVn(cen * 2. + 7.1, 2.)) * ${LK("str", .4)};
          return smoothstep(.22, .72, mix(g, .35 * g + .65 * st, sw));
        }
        void main() {
          vec2 uv = gl_FragCoord.xy / 512.;
          float cov = uCov;
          float tn = fbm2(uv + .37, 4.);
          float type = clamp(uType + (tn - .5) * .5, 0., 1.);
          /* clusters and clear lanes (~20 km): the cumulus gather in fields, as they do over a warm sea */
          float clus = smoothstep(.3, .7, fbm2(uv + .13, 3.));
          /* cumulus: three generations of jittered cells (5.2, 2.6, 1.3 km on the 62.6 km tile). Each cell may
             hold one cloud of log-normal radius (median 1.3, .65, .33 km), elongated along the wind aloft. A cloud
             is a cluster of thermals: a low mound over its whole flat base and six rounded turrets of different
             sizes and heights, the tallest near its middle, so its top is a cauliflower at the largest scale.
             Fair-weather cumulus (humilis) are wider than tall; the turrets grow as the cover rises (mediocris).
             A cloud exists once the cover passes its own rank, and grows from a third of its size to all of it
             over the next .2 of cover, so a rising reading never pops one into being; every term rises with the
             cover, so more reading never takes a cloud away */
          float cu = 0., cuPk = 0.;
          /* [round 3] where stratocumulus spreads (about 50-85 %) the cumulus stay flat (humilis, fractus): tall ones
             there read as heavy blobs next to the golden photographs' thin broken clouds */
          float scW0 = smoothstep(.42, .52, cov) * (1. - smoothstep(.84, .93, cov));
          /* [r9f] (fair weather's cumulus .8 of their height there, not .55: with the fix's flatter humilis and towering big ones the
             flattening from 40 to 55 % took 8 points of the 5-12 deg band's cover away (cloudfrac.js: .57 -> .49), a cover that fell as
             the reading rose; the decks keep .55) */
          float tall = mix(.45, .9, smoothstep(.1, .65, cov)) * mix(1., mix(.55, ${LK("scf", .8)}, 1. - smoothstep(.62, .8, cov)), scW0);
          /* [r9f] the clouds' new shapes and organisation (below) are fair weather's, as cldCu's light is: whole under cover .62 (~61 %),
             gone by .8 (~75 %), so from there the map's cumulus are round 9's and the decks and the storm keep their look */
          float fw = 1. - smoothstep(.62, .8, cov);
          /* [r9f] the organisation (wmOrg) leaves clouds out of the lanes, and the share's lift puts them in the groups (the same cover
             in all); both fade as the deck closes over them (the lanes fill as the lift goes: the cover keeps rising, cloudfrac.js) */
          float orgW = ${LK("org", 1)} * fw, lift = 1. + ${LK("lift", .8)} * orgW;
          /* [r9f] A FOOTPRINT IS NOT AN ELLIPSE (REVIEW-9 A1: from below, every base was a smooth oval): each cloud's frame is warped
             by a noise about a quarter of its generation's cell, so its outline is lobed and irregular, the turrets with it */
          float wrp = ${LK("wrp", .3)} * fw, pe = mix(.5, ${LK("pro", .47)}, fw);
          for (int L = 0; L < 4; L++) {
            /* [r9f] a fourth generation on 0.65 km cells: fractus and the smallest humilis, flat shreds 0.2-0.6 km across and tens of
               metres thick that crowd low near the horizon and between the bigger clouds */
            if (L == 3 && (${LK("frc", 1)} <= 0. || fw <= 0.)) break;
            float N = 12. * exp2(float(L)), cell = 62.6 / N;
            float share = L == 0 ? (cov - .12) * mix(1.5, ${LK("l0s", 1.3)}, fw) : L == 1 ? (cov - .03) * 1.4 : L == 2 ? cov * 1.5 : (cov + .05) * ${LK("frs", 1.1)} * fw;
            share *= mix(.15, 2., clus) * lift;
            float shF = .25 * smoothstep(.75, 1., cov) * (L == 3 ? fw : 1.);
            if (share + shF <= 0.) continue;
            vec2 g = uv * N, gi = floor(g);
            /* (4 features a cell, fewer on the finer generations: a feature stays over ~5 of the map's 122 m texels, no aliasing) */
            float wf = L == 3 ? 1. : L == 2 ? 2. : ${LK("wrf", 4)};
            /* (gradient noise, no steeper than ~.6 so the warp never folds a cloud into a star: a value noise's warp drew straight
               creases, torn-paper outlines overhead; on the two big generations .6 of it, for a near cloud's outline is ~6 of the
               map's texels a km of base: a stronger warp left straight sides and corners on the bilinear map, rocks at 1:1) */
            vec2 wv = wrp > 0. ? vec2(cldPerlin(vec3(uv * N * wf, .31), N * wf), cldPerlin(vec3(uv * N * wf, .77), N * wf)) * (L <= 1 ? .84 : 1.4) * wrp : vec2(0.);
            for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
              vec2 c = gi + vec2(i, j), cm = mod(c, N);
              vec3 a = wxHash33(vec3(cm, 7. + float(L) * 13.)), b = wxHash33(vec3(cm, 61. + float(L) * 13.));
              vec2 cc = c + .12 + .76 * a.xy, dv = g - cc;
              /* [r9f] fewer, smaller big ones (a median radius of 1.15 km, was 1.46: the giant ovals overhead) */
              float r1 = (L == 0 ? mix(.28, ${LK("l0r", .22)}, fw) : .28) * exp(.85 * (b.x + b.y - 1.)), asp = 1.1 + .5 * b.z;
              /* (as far as it can reach, grown and warped: past it the cloud's organisation need not be read) */
              if (dot(dv, dv) > r1 * r1 * asp * (1.3 + 1.42 * wrp) * (1.3 + 1.42 * wrp)) continue;
              float grow = smoothstep(a.z, a.z + .2, wxSat(share * (orgW > 0. ? mix(1., wmOrg(cc / N), orgW) : 1.) + shF));
              if (grow <= 0.) continue;
              float rC = r1 * mix(.35, 1., grow);    // radius in cells
              /* into the cloud's own frame: along the wind stretched, across it narrowed, in radii */
              vec2 e = vec2(dot(dv, uAxis) / sqrt(asp), dot(dv, vec2(-uAxis.y, uAxis.x)) * sqrt(asp)) / rC + wv;
              float d2 = dot(e, e);
              if (d2 >= mix(1., 1.69, fw)) continue;
              /* [round 4] and rises from a flat wisp over the first third of its growth: at a third of its width and its
                 full height it popped into the sky and its shadow onto the cove in one rebuild of the map (REVIEW-3 f117) */
              /* [r9f] HUMILIS ARE FLAT, THE BIG ONES TOWER (REVIEW-9 A1: every cloud was the same shape at its own size): the height grows
                 as the radius to the 1.5 (normalised at 0.45 km), so at 40 % a 0.36 km humilis is ~0.2 km tall, a 0.18 km fractus ~90 m,
                 and the big ones reach the layer's top */
              float rK = rC * cell;
              float pk = min(rK * pow(rK / ${LK("asn", .45)}, ${LK("asx", .5)} * fw) * tall * (.6 + .8 * fract(a.z * 7.31 + b.x * 3.17)) / uThick, 1.) * wxSat(grow * 3.);
              /* [r9f] a little steeper flanks (the dome (1 - d^2)^.47, was ^.5; at ^.38 its top was a plateau over cliffs: a mesa, a rock
                 from below) */
              float tp = d2 < 1. ? mix(.62, ${LK("mnd", .56)}, fw) * pk * pow(1. - d2, pe) : 0.;
              /* (past the mound a turret fades out over the warp's reach, so no turret's edge is a wall in the map; with fw 0 it is
                 cut at the mound's edge as before) */
              float ow = d2 < 1. ? 1. : 1. - smoothstep(0., 1., (d2 - 1.) / (.69 * fw + 1e-4));
              /* the turrets: six as before, and on the bigger clouds more, smaller, higher ones near the top (the cauliflower's
                 next scale: a big cloud's top was six soft domes) */
              int nT = fw <= 0. ? 6 : L == 0 ? 6 + int(${LK("tx", 5)}) : L == 1 ? 6 + int(${LK("tx", 5)}) / 2 : L == 2 ? 6 : 2;
              for (int m = 0; m < 11; m++) {
                if (m >= nT) break;
                vec3 h = wxHash33(vec3(cm, 211. + float(L) * 13. + float(m) * 5.));
                bool sm = m >= 6;
                vec2 o = (h.xy * 2. - 1.) * (sm ? .45 : .55);
                float rs = sm ? .18 + .14 * h.z : .22 + .3 * h.z, ds2 = dot(e - o, e - o) / (rs * rs);
                if (ds2 < 1.) tp = max(tp, ow * pk * (sm ? (.72 + .28 * fract(h.z * 3.7 + h.x)) * wxSat(fw * 3.) : .55 + .45 * fract(h.z * 3.7 + h.x)) * (1. - .45 * length(o)) * pow(1. - ds2, sm ? .45 : pe));
              }
              if (tp > cu) { cu = tp; cuPk = pk; }
            }
          }
          /* the deck (stratus, nimbostratus, stratocumulus; the storm's base): a cover field whose gaps open wide.
             The edge is soft (a .2 ramp of the field), so where it barely dips the deck thins instead of opening
             a slit: a slit seen edge-on showed as a glowing crack line */
          float fd = fbm2(uv, 6.) * .65 + fbm2(uv + .71, 13.) * .35;
          float deckCov = smoothstep(.45, .97, cov);
          float deck = wxSat((fd - .5) * 4.5 + (deckCov - .5) * 4.5 + .5) * smoothstep(0., .15, deckCov);
          deck *= deck * (3. - 2. * deck);
          float tDeck = type < .2 ? mix(.3, .95, type / .2) : type < .5 ? mix(.95, .5, (type - .2) / .3) : mix(.5, .95, (type - .5) / .5);
          /* the deck's thickness varies two- to threefold (8 and 3 km): thick dark cores and thinner, lighter
             patches, which is most of what an overcast shows from below */
          float th = fbm2(uv + .29, 7.) * .65 + fbm2(uv + .53, 19.) * .35;
          /* [round 3] a storm's deck (Cb, rain) varies more: thin, lighter places between dark thick cores.
             [round 4] .45-1 of the layer (was .1-1): a Cb is thick everywhere, and the thin places let so much sun through
             (9x the cores) that the deck read as a light grey sheet round one lens-shaped dark blot (REVIEW-3 #1, x17) */
          float stK = smoothstep(.6, .9, uType) * uPrecip;
          float dk = deck * tDeck * mix(.3 + .7 * smoothstep(.28, .72, th), .45 + .55 * smoothstep(.3, .7, th), stK);
          /* [round 3] STRATOCUMULUS (about 50-80 %): the deck breaks into rounded masses ~2 km along the wind aloft and
             ~1.3 km across (rows on the lattice direction (3, -2), which lies along it), thick in their middles and thin
             or open between them, and thinner overall: from below, dark cores and light seams, as Sc shows. A rain deck
             closes them up */
          float scW = smoothstep(.42, .52, cov) * (1. - smoothstep(.84, .93, cov));
          if (scW > 0.) {
            vec2 sp = vec2(3. * uv.x - 2. * uv.y, 2. * uv.x + 3. * uv.y);
            /* [round 4] NOT A COBBLESTONE (REVIEW-3 m-phone: a regular tiling of equal cells overhead): the cells' points
               wander over the whole cell (.05-.95, was .15-.85), the lattice is bent by a ~5 km warp of about half a cell
               (periodic in the tile), and the seams open at a threshold that wanders over ~6 km, so the cells merge into
               rows and masses in some places and stand apart, smaller, in others */
            vec2 wp = (vec2(fbm2(uv + .17, 11.), fbm2(uv + .59, 11.)) - .5) * 1.4;
            /* [round 6] THE SEAMS OF A DECK THAT IS CLOSING ARE SOFT (REVIEW-5 #2, 64-76 %: crisp lit rims and crease veins along every
               cell border, a dark-ringed gap round the sun, straight vertical bright streaks where a border ran toward the eye):
               from cover .58-.68 the smooth minimum is rounder (K 7 -> 4) and the seams open over a ramp .3 wider, so the deck
               thins into broad, shallow troughs that the light through it fills as a glow, not as lines */
            float rdW = smoothstep(.58, .68, cov), scK = mix(${LK("scK", 7)}, ${LK("scK2", 4)}, rdW);
            float sc = scCell(sp * vec2(8., 13.) + wp, vec2(8., 13.), scK) * .7 + scCell(sp * vec2(16., 26.) + wp * 2., vec2(16., 26.), scK) * .3;
            /* its own sheets (from ~50 %): patches that spread and join as the cover rises; in them the cells, open
               between when the sheet is young, 0.3-0.7 km thick (a quarter to under half of the layer) */
            float scCov = smoothstep(.45, .85, cov);
            float sheet = wxSat((fbm2(uv + .41, 5.) - .5) * 4. + (scCov - .55) * 4. + .5);
            /* (1 - F1^2 sits at ~.5-.75 on the cells' borders and ~1 at their middles: the seams open below ~.7) */
            /* [round 5] the seams open over a wider ramp and at a threshold that also wanders over ~1.7 km: the edges of the gaps
               fray and thin out (REVIEW-4 #3: a hard-edged blue hole at 66-70 %) */
            float cellT = smoothstep(.66 + ${LK("scS", .06)} - .5 * ${LK("scW2", .2)} * rdW, .84 + ${LK("scS", .06)} + ${LK("scW", .08)} + ${LK("scW2", .2)} * rdW, sc + .12 * (scCov - .5) + .22 * (fbm2(uv + .83, 9.) - .5) + ${LK("scF", .12)} * (fbm2(uv + .27, 37.) - .5));
            dk = max(dk * mix(1., .25 + .75 * cellT, scW), sheet * cellT * mix(.2, .45, smoothstep(.7, 1., sc)) * scW);
          }
          float top = max(cu, dk);
          float share = wxSat(dk / max(top, 1e-3) * 2. - 1.) * step(1e-3, dk);
          /* wetness: rain falls from the deep columns */
          float wet = uPrecip * smoothstep(.25, .8, top) * (.6 + .4 * fbm2(uv + .71, 6.));
          /* B: the peak of the cloud this column belongs to (the deck's own top for a deck), so the trace can
             round the cloud's base up toward its rim: a flat base over the inner two thirds, no thin lip */
          o = vec4(wxSat(top), wet, mix(cuPk, tDeck * deck, share), share);
        }` });
      /*@lab*/ yield* (R.priv.skyWaitMark || function* (w, ps) { yield* R.wait(...Object.values(ps)); })("clouds", { noise: P.noise, curl: P.curl, cirrus: P.cirrus, weather: P.weather }); /*@end*/
      yield* R.wait(P.noise, P.curl, P.cirrus, P.weather);
      /*@lab*/ R.priv.skyBuild.noiseProgs = performance.now() - R.priv.skyBuild.t0; /*@end*/
      /* the big programs are made only now, so the noise shaders (trivial) are not queued behind them in a
         driver's compile threads; they compile while the volumes are drawn */
      P.shadow = R.program("clouds.shadow", { libs: ["atmo", "clouds"], fs: FIELD + `
        uniform int uOct; out vec4 o;
        void main() {
          vec2 xz = (gl_FragCoord.xy / 256. - .5) * CLD_SH_SIZE + CLD_SH_C;
          vec3 L = uKey.xyz; L.y = max(L.y, .035); L = normalize(L);
          float b = uWx0.z * (1. - .35 * uWx1.y), tp = uWx0.w + .2;
          float t0 = b / L.y, t1 = tp / L.y, dt = (t1 - t0) / float(uOct), od = 0.; vec4 w;
          for (int i = 0; i < uOct; i++) {
            vec3 p = vec3(xz.x, 0., xz.y) + L * (t0 + (float(i) + .5) * dt);
            od += cldDensity(p, false, 1., w) * dt;
          }
          o = vec4(exp(-od * 55. * .6), 0., 0., 1.);
        }` });
      const nightAmb = (WX.libs.night || "").indexOf("wxNightAmbient") >= 0;
      const traceFS = (nightAmb ? "vec3 cldNightAmb() { return wxNightAmbient(); }\n" : "vec3 cldNightAmb() { return vec3(0.); }\n") + TRACE;
      P.trace = R.program("clouds.trace", { libs: ["atmo", "clouds"].concat(nightAmb ? ["night"] : []), fs: traceFS });
      /* [r9] the decks' and the storm's trace: round 8's program (the cumulus weight the constant 0), compiled beside the other and
         used once it is ready (until then the other draws the same picture, slower) */
      P.trace8 = R.program("clouds.trace8", { libs: ["atmo", "clouds"].concat(nightAmb ? ["night"] : []), fs: "#define CLD_R8 1\n" + traceFS });
      P.resolve = R.program("clouds.resolve", { libs: ["atmo", "clouds"], fs: `
        uniform sampler2D uNewL, uNewZ, uHistL, uHistZ; uniform float uExpR; uniform vec2 uBlock, uOff, uDisp;
        layout(location = 0) out vec4 oL; layout(location = 1) out vec4 oZ;
        /* Catmull-Rom in 5 bilinear taps (Jimenez 2016): the history is resampled every frame by a sub-pixel
           wind offset, and bilinear resampling 4-16 times between refreshes blurred the clouds to putty */
        vec4 cldHist(vec2 uv) {
          vec2 sz = uCloudRes.xy, pos = uv * sz, c = floor(pos - .5) + .5, f = pos - c;
          vec2 w0 = f * (-.5 + f * (1. - .5 * f)), w1 = 1. + f * f * (-2.5 + 1.5 * f), w2 = f * (.5 + f * (2. - 1.5 * f)), w3 = f * f * (-.5 + .5 * f);
          vec2 w12 = w1 + w2, o12 = c + w2 / w12;
          vec2 t0 = (c - 1.) * uCloudRes.zw, t3 = (c + 2.) * uCloudRes.zw, t12 = o12 * uCloudRes.zw;
          vec4 r = texture(uHistL, vec2(t12.x, t0.y)) * w12.x * w0.y + texture(uHistL, vec2(t0.x, t12.y)) * w0.x * w12.y
                 + texture(uHistL, t12) * w12.x * w12.y + texture(uHistL, vec2(t3.x, t12.y)) * w3.x * w12.y
                 + texture(uHistL, vec2(t12.x, t3.y)) * w12.x * w3.y;
          float ws = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
          return max(r / ws, vec4(0.));
        }
        void main() {
          ivec2 p = ivec2(gl_FragCoord.xy), B = ivec2(uBlock);
          ivec2 blk = p / B, sub = p - blk * B, mxs = textureSize(uNewL, 0) - 1;
          vec2 uv = (vec2(p) + .5) * uCloudRes.zw;
          vec3 rd = wxRay0(uv);
          float r0 = R_G + wxEye * 1e-3, hzMu = -sqrt(max(0., 1. - R_G * R_G / (r0 * r0)));
          float kind = (texture(sSceneZ, wxUVPrev(rd)).r > 0. || rd.y < hzMu) ? 1. : 0.;
          vec4 n = texelFetch(uNewL, blk, 0), nz = texelFetch(uNewZ, blk, 0);
          bool fresh = sub == ivec2(uOff) && abs(nz.g - kind) < .5;
          /* history, moved with the wind aloft since the last world frame (sky rays only) */
          vec4 hz = texelFetch(uHistZ, p, 0);
          vec2 huv = uv;
          if (kind < .5) {
            vec3 P = rd * max(hz.r, .5) - vec3(uDisp.x, 0., uDisp.y);
            huv = wxUV0(normalize(P));
            if (huv.x < 0.) huv = uv;
          }
          vec4 h = kind < .5 ? cldHist(huv) : texture(uHistL, huv); h.rgb *= uExpR; h.a = min(h.a, 1.);
          vec4 hzz = texture(uHistZ, huv);
          bool stale = abs(hzz.g - kind) > .5 || huv.x <= 0. || huv.x >= 1. || huv.y <= 0. || huv.y >= 1.;
          /* between its refreshes a texel only moves with the wind (15 of 16 texels at T2: no neighbourhood) */
          if (!fresh && !stale) { oL = h; oZ = vec4(hzz.r, kind, 0., 1.); return; }
          /* the 3x3 of fresh samples of the same kind bounds it */
          vec4 mn = vec4(1e9), mx = vec4(-1e9); float cnt = 0.; vec4 best = n; float bd = 1e9;
          for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
            ivec2 q = clamp(blk + ivec2(x, y), ivec2(0), mxs);
            vec4 s = texelFetch(uNewL, q, 0); float k = texelFetch(uNewZ, q, 0).g;
            if (abs(k - kind) > .5) continue;
            mn = min(mn, s); mx = max(mx, s); cnt += 1.;
            float dd = float(x * x + y * y); if (dd < bd) { bd = dd; best = s; }
          }
          if (fresh && stale) { oL = n; oZ = nz; return; }
          if (cnt < .5) { oL = stale ? vec4(0., 0., 0., 1.) : h; oZ = vec4(stale ? 1. : hzz.r, kind, 0., 1.); return; }
          if (stale) { oL = best; oZ = vec4(max(hzz.r, .5), kind, 0., 1.); return; }
          /* between its refreshes a texel only moves with the wind; at its refresh the moved history is
             bounded by the fresh samples round it and averaged with its own (an exponential mean: it settles
             within a few refreshes and keeps no state of its own). Clamping every frame against a box that
             changes every frame made the silhouettes shimmer */
          if (fresh) {
            vec4 pad = (mx - mn) * .5 + vec4(vec3(.02) * max(mx.rgb, vec3(1e-3)) + 1e-4, .02);
            h = clamp(h, mn - pad, mx + pad);
            /* (.15: the fresh sample of a thin, wispy texel scatters with its jitter; a .25 mean left the refresh
               blocks as a fine checker on lit undersides) */
            oL = mix(h, n, .15); oZ = vec4(mix(hzz.r, nz.r, .15), kind, 0., 1.); return;
          }
          oL = h;
          oZ = vec4(hzz.r, kind, 0., 1.);
        }` });

      const G = R.gpu, gl = R.gl;
      const v = {
        base: G.tex3D(128, 128, 128, "rgba8", { mips: true, wrap: "repeat" }),
        detail: G.tex3D(32, 32, 32, "rgba8", { mips: true, wrap: "repeat" }),
        s128: G.tex2D(128, 128, "rgba8"), s32: G.tex2D(32, 32, "rgba8"),
        curl: G.tex2D(128, 128, "rg8", { wrap: "repeat" }),
        cirrus: G.tex2D(512, 512, "rgba8", { wrap: "repeat", mips: true, aniso: 8 }),
        weather: G.tex2D(512, 512, "rgba8", { wrap: "repeat", mips: true }),      // [round 3] mips: the far field's merge
        shadow: G.tex2D(256, 256, "r16f", { mips: true }),
      };
      v.s128.fb = G.fbo([v.s128]); v.s32.fb = G.fbo([v.s32]);
      v.curl.fb = G.fbo([v.curl]); v.cirrus.fb = G.fbo([v.cirrus]); v.weather.fb = G.fbo([v.weather]);
      v.shadow.fb = G.fbo([v.shadow]);
      /* the volumes: 6 slices of the base per frame, and the 32 small detail slices in the first frames (<= 3 ms of GPU on the iGPU; measured
         3.7-4.6 ms for 8 + 4), copied into the 3D textures */
      /*@lab*/ const TQ = G.ext.timer, qs = [], noiseGpu = (R.priv.skyBuild.noiseGpu = []);
      const pollQ = () => { for (let k = qs.length - 1; k >= 0; k--) if (gl.getQueryParameter(qs[k], gl.QUERY_RESULT_AVAILABLE)) {
        noiseGpu.push(+(gl.getQueryParameter(qs[k], gl.QUERY_RESULT) / 1e6).toFixed(3)); gl.deleteQuery(qs[k]); qs.splice(k, 1); } };
      let q = null; /*@end*/
      for (let z = 0; z < 128; z++) {
        /*@lab*/ if (TQ && z % 6 === 0) { q = gl.createQuery(); gl.beginQuery(TQ.TIME_ELAPSED_EXT, q); } /*@end*/
        R.draw(P.noise, v.s128.fb, { uZ: z, uN: 128, uKind: 0, uOne: 1, uOct: 8 });
        gl.bindTexture(gl.TEXTURE_3D, v.base.tex);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, v.s128.fb.fb);
        gl.copyTexSubImage3D(gl.TEXTURE_3D, 0, 0, 0, z, 0, 0, 128, 128);
        if (z < 32) {
          R.draw(P.noise, v.s32.fb, { uZ: z, uN: 32, uKind: 1, uOne: 1, uOct: 8 });
          gl.bindTexture(gl.TEXTURE_3D, v.detail.tex);
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, v.s32.fb.fb);
          gl.copyTexSubImage3D(gl.TEXTURE_3D, 0, 0, 0, z, 0, 0, 32, 32);
        }
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        if (z % 6 === 5 || z === 127) {
          /*@lab*/ if (q) { gl.endQuery(TQ.TIME_ELAPSED_EXT); qs.push(q); q = null; } pollQ(); /*@end*/
          yield;
        }
      }
      /*@lab*/ for (let k = 0; k < 30 && qs.length; k++) { pollQ(); if (qs.length) yield; } /*@end*/
      gl.bindTexture(gl.TEXTURE_3D, v.base.tex); gl.generateMipmap(gl.TEXTURE_3D);
      gl.bindTexture(gl.TEXTURE_3D, v.detail.tex); gl.generateMipmap(gl.TEXTURE_3D);
      R.draw(P.curl, v.curl.fb, { uOne: 1, uOct: 8 });
      R.draw(P.cirrus, v.cirrus.fb, { uOne: 1, uOct: 8 });
      gl.activeTexture(gl.TEXTURE31); gl.bindTexture(gl.TEXTURE_2D, v.cirrus.tex); gl.generateMipmap(gl.TEXTURE_2D);
      gl.deleteFramebuffer(v.s128.fb.fb); gl.deleteFramebuffer(v.s32.fb.fb);
      gl.deleteTexture(v.s128.tex); gl.deleteTexture(v.s32.tex);
      /*@lab*/ R.priv.skyBuild.volumes = performance.now() - R.priv.skyBuild.t0;
      yield* (R.priv.skyWaitMark || function* (w, ps) { yield* R.wait(...Object.values(ps)); })("clouds", { shadow: P.shadow, trace: P.trace, resolve: P.resolve }); /*@end*/
      yield* R.wait(P.shadow, P.trace, P.resolve);
      /*@lab*/ R.priv.skyBuild.trace = performance.now() - R.priv.skyBuild.t0; /*@end*/
      V = v;
      /*@lab*/ R.priv.skyClouds = v; /*@end*/
      R.provide("CSHADOW", v.shadow);
      R.priv.skyCirrus = v.cirrus;
      R.priv.skyField = v;                 // [round 3] the base volume and the weather map, for sky.js's flash volume
      R.debugTex("CSHADOW", v.shadow, "r");
      R.debugTex("clouds.weather", v.weather, "raw");
      R.debugTex("clouds.curl", v.curl, "raw");
      R.debugTex("clouds.cirrus", v.cirrus, "raw");
    },
    resize(R) {
      if (!V) return;
      const gl = R.gl, G = R.gpu, [w, h] = R.size.cloud;
      const del = (o) => { if (o) { gl.deleteTexture(o.L.tex); gl.deleteTexture(o.Z.tex); gl.deleteFramebuffer(o.fb.fb); } };
      del(V.h0); del(V.h1);
      if (V.small) for (const k in V.small) del(V.small[k]);
      const mk = (ww, hh) => { const L = G.tex2D(ww, hh, "rgba16f"), Z = G.tex2D(ww, hh, "rg16f", { filter: "nearest" }); return { L, Z, fb: G.fbo([L, Z]) }; };
      V.h0 = mk(w, h); V.h1 = mk(w, h);
      /* the refresh buffers, one per block shape (4x4, 4x2, 2x2), made as the tier needs them */
      V.small = {};
      V.smallFor = (n) => { if (!V.small[n]) { const [bx, by] = BLOCK[n]; V.small[n] = mk(Math.ceil(w / bx), Math.ceil(h / by)); } return V.small[n]; };
      cur = 0; needFull = true;
      for (const t of [V.h0, V.h1]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb.fb);
        gl.clearBufferfv(gl.COLOR, 0, new Float32Array([0, 0, 0, 1]));
        gl.clearBufferfv(gl.COLOR, 1, new Float32Array([1, 0, 0, 1]));
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      R.priv.skyCloudValid = false;
      R.provide("CLOUD", V.h0.L); R.provide("CLOUDZ", V.h0.Z);
      R.priv.skyCloudPrev = V.h0.L;
      R.debugTex("CLOUD", V.h0.L, "hdr");
      R.debugTex("CLOUD.T", V.h0.L, "a");
      R.debugTex("CLOUDZ", V.h0.Z, "raw");
    },
    ubo(F, R, set) {
      /* [round 3] the storm's edge: 4.5 + 4 storm km out (6.5 km at 92.5 %, 8.5 km at the cap): a squall's cell, with the
         open sky's light under its edge at the horizon (REVIEW-2: a lighter band beyond the storm's edge); under a rain deck
         without a storm the open sky's light comes from 25 km. The weight of that light: rain under a closed deck */
      const W = F.W, sm = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
      /* [round 4] THE SWELL AT 89-91 % (REVIEW-3 clip f, frames 900-1100: the whole frame +31 levels over 0.7 s, then the
         exposure's 2.5 s fall): the light's edge came in from 25 to 6 km between storm 0 and .3 (88.8-90.1 %), while the
         deck's edge itself only opens between storm .3 and .6 (smoothstep in cldBase), so the air under a still-closed
         deck lit up sevenfold within 1.3 points. The light's edge now follows the deck's: the same storm .3-.6 */
      const D = 25 - (20.5 - 4 * W.storm) * sm(0.2, 0.8, W.storm);   // [round 4] with the deck's edge (edgeW): storm .2-.8
      let dw = sm(0.75, 0.95, W.cov) * sm(0.2, 0.5, W.precip);
      /*@lab*/ dw *= R.p("sky.under"); /*@end*/
      set("uA1", R.priv.skyDeck === undefined ? 1 : R.priv.skyDeck, D, dw, R.priv.skyMoonOn || 0);
    },
    slots: {
      shadow(R, F) {
        if (!V) return;
        const W = F.W, gl = R.gl;
        wx.age++;
        const whole = wx.cov < 0 || F.still || needFull;
        /* [round 5] NO STEPS WHILE THE READING CLIMBS (REVIEW-4 #9: in a time-lapse the sky stepped 1-2 levels every 0.3 s, a
           whole rebuild of the map at once in quarters). Each rebuild now moves the map half way to the new one (a blended
           cycle of four bands), at half round 4's thresholds; once the reading rests, one more blended cycle and then an
           exact one land it on the target. Nothing drifts: the map converges to what the reading asks, and a still or a
           full update draws it exactly */
        if (wx.band < 0) {
          if (wx.cov < 0 || (wx.age >= 4 && (Math.abs(W.cov - wx.cov) > 0.0025 || Math.abs(W.type - wx.type) > 0.005 || Math.abs(W.precip - wx.precip) > 0.005))) {
            wx.blend = wx.cov >= 0; wx.cov = W.cov; wx.type = W.type; wx.precip = W.precip; wx.age = 0;
            wx.band = 0; wx.left = 2;
          } else if (wx.left > 0) { wx.left--; wx.blend = wx.left > 0; wx.band = 0; }
        }
        if (wx.band >= 0 && whole) wx.band = 4;
        if (wx.band >= 0) {
          /* made again a quarter of the rows per world frame (whole on a full update): one build costs up to
             ~8 ms on an iGPU, and a quarter of it hides in a frame; the cover moves by < .005 meanwhile */
          const all = wx.band === 4, y0 = all ? 0 : wx.band * 128;
          /* the cumulus stretch along the mean wind aloft (from 30 deg left of the view: travel (.5, -.87)),
             turned into the weather map's rotated tile (x 26.6 deg) */
          const ax = [2 * 0.5 - (-0.866), 0.5 + 2 * (-0.866)], al = Math.hypot(ax[0], ax[1]);
          gl.enable(gl.SCISSOR_TEST); gl.scissor(0, y0, 512, all ? 512 : 128);
          const mixIn = wx.blend && !all;
          if (mixIn) { gl.enable(gl.BLEND); gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA); gl.blendColor(0, 0, 0, 0.5); }
          R.draw(P.weather, V.weather.fb, { uCov: wx.cov, uType: wx.type, uPrecip: wx.precip, uThick: Math.max(W.top - W.base, 0.2),
            uAxis: [ax[0] / al, ax[1] / al], uOne: 1, uOct: 8 });
          if (mixIn) gl.disable(gl.BLEND);
          gl.disable(gl.SCISSOR_TEST);
          wx.band = all || wx.band === 3 ? -1 : wx.band + 1;
          gl.activeTexture(gl.TEXTURE31); gl.bindTexture(gl.TEXTURE_2D, V.weather.tex); gl.generateMipmap(gl.TEXTURE_2D);
        }
        /* the clouds cross a 188 m texel in ~10 s: a quarter of the rows per world frame (all of them on a
           full update), and the mips (the mean) once the map is whole again */
        const all = F.still || needFull || shQ < 0;
        const q = all ? 0 : shQ;
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, all ? 0 : q * 64, 256, all ? 256 : 64);
        let cs = CS; /*@lab*/ cs = [R.p("cld.turret"), R.p("cld.billow"), R.p("cld.ramp"), R.p("cld.shelf")]; /*@end*/
        /* [round 4] THE SHADOW MAP EASES IN TIME (REVIEW-3 clip f frame 117: both cliffs and the far glint went from sun to
           shade in one frame at 62 %): each refresh of a band moves it 30 % of the way to the newly traced shadow (a
           band every 4th world frame: ~0.5 s at 60 Hz to settle), so a cloud the weather map adds or reshapes darkens
           the land and the sea over about a second. The clouds' own drift (< 25 m/s against 188 m texels) lags by
           metres. Nothing accumulates: the map converges to the traced shadow; stills and full updates replace it */
        const ease = !all && shBlend;
        if (ease) { gl.enable(gl.BLEND); gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA); gl.blendColor(0, 0, 0, 0.3); }
        R.draw(P.shadow, V.shadow.fb, { uBase: V.base, uDetail: V.detail, uWeather: V.weather, uCurl: V.curl, uOct: 12, uCS: cs });
        if (ease) gl.disable(gl.BLEND);
        if (all) shBlend = true;
        gl.disable(gl.SCISSOR_TEST);
        shQ = all ? 0 : (q + 1) & 3;
        if (all || shQ === 0) { gl.activeTexture(gl.TEXTURE31); gl.bindTexture(gl.TEXTURE_2D, V.shadow.tex); gl.generateMipmap(gl.TEXTURE_2D); }
      },
      clouds(R, F) {
        if (!V || !V.h0) return;
        const k = R.knobs;
        const H = [V.h0, V.h1], nxt = H[cur ^ 1], prev = H[cur];
        let ck = CK, cs = CS; /*@lab*/ ck = [R.p("cld.amb"), R.p("cld.arch"), R.p("cld.deep"), R.p("cld.powder")]; cs = [R.p("cld.turret"), R.p("cld.billow"), R.p("cld.ramp"), R.p("cld.shelf")]; /*@end*/
        const common = { uBase: V.base, uDetail: V.detail, uWeather: V.weather, uCurl: V.curl, uSteps: k.steps, uLightTaps: k.light,
                         uNLight: Math.min(k.light, 7), uNRain: 8, uCK: ck, uCS: cs };
        /*@lab*/ common.uDbg = R.p("cld.dbg"); /*@end*/
        /* the wind's displacement since the last world frame, km (drift offsets wrap at 420 km) */
        const dw = F.drift.weather, ds = F.drift.shape;
        let disp = [0, 0];
        if (lastDrift) {
          const wr = (x) => x - 420 * Math.round(x / 420);
          disp = [0.5 * (wr(dw[0] - lastDrift[0]) + wr(ds[0] - lastDrift[2])), 0.5 * (wr(dw[1] - lastDrift[1]) + wr(ds[1] - lastDrift[3]))];
        }
        lastDrift = [dw[0], dw[1], ds[0], ds[1]];
        const E = R.exposure.E, expR = lastE > 0 ? E / lastE : 1;
        lastE = E;
        /* [r9] round 8's program where the cumulus weight is 0 (cover >= .79 or storm >= .69: the weight < .5 % at the switch) */
        const tp = (F.W.cov >= 0.79 || F.W.storm >= 0.69) && P.trace8.ready() ? P.trace8 : P.trace;
        if (F.still || needFull) {
          R.draw(tp, nxt.fb, Object.assign(common, { uBlock: [1, 1], uOff: [0, 0], uHistL: prev.L, uHistZ: prev.Z, uFullA: needFull ? 1 : 0.25 }));
          needFull = false;
        } else {
          /* 1/16 of the pixels a world frame in 4x4 blocks, 1/8 in 4x2 (T4), 1/4 in 2x2 */
          /* [round 3] while the weather map is being remade (the reading moving), refresh twice as often: a climbing reading
             left the moved history stale between refreshes, as 4x4 blocks and stripes in the deck (D's round-2 crop) */
          let n = k.cloudUpdate <= 4 ? 4 : k.cloudUpdate <= 8 ? 8 : 16;
          if (wx.age < 8 && n > 4) n = n === 16 ? 8 : 4;
          const [bx, by] = BLOCK[n], sm = V.smallFor(n);
          const ph = ORDER[n][R.worldIndex % n];
          const off = [ph % bx, Math.floor(ph / bx)];
          R.draw(tp, sm.fb, Object.assign(common, { uBlock: [bx, by], uOff: off, uHistL: prev.L, uHistZ: prev.Z, uFullA: 1 }));
          R.draw(P.resolve, nxt.fb, { uNewL: sm.L, uNewZ: sm.Z, uHistL: prev.L, uHistZ: prev.Z, uBlock: [bx, by], uOff: off, uDisp: disp, uExpR: expR });
        }
        cur ^= 1;
        R.provide("CLOUD", nxt.L); R.provide("CLOUDZ", nxt.Z);
        R.priv.skyCloudPrev = nxt.L; R.priv.skyCloudValid = true;
        R.debugTex("CLOUD", nxt.L, "hdr"); R.debugTex("CLOUD.T", nxt.L, "a"); R.debugTex("CLOUDZ", nxt.Z, "raw");
      },
    },
  };
})());
