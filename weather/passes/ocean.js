/* ═══════════════════════ Weather: the ocean (stream B) ═══════════════════════
   The sea in front of the window: a Tessendorf FFT wind sea in three cascades, an analytic swell
   that shoals, slows and turns in the cove, LEAN normals and variance, Bruneton glints for the sun,
   the moon, the night lights and lightning, the sky and the cove mirrored in it, foam that follows
   Monahan, the shallows, the shore, spray on the rocks in storms, and the sea probes the ship and
   the buoy ride on. render.md 7 and 10.3, DESIGN 13.4, BRIEFS B.

   Order inside the ocean slot (world stage, after the coast):
     1. spectrum   h0(k) for 3 cascades, only when the mean wind moved (> 0.05 m/s or 0.3 deg)
     2. evolve     h(k, t) packed as 4 complex fields (2 x RGBA32F), omega quantised to 2 pi / 1024
     3. FFT        Stockham radix-2 gather, log2 N passes along x then along z, texelFetch only
     4. finalize   per cascade into two RGBA16F arrays (disp + foam, slopes + second moments), mips
     5. the sea    a projected grid on the curved sea, displaced, depth-tested against the cove and
                   depth-writing, blended ONE, SRC_ALPHA (alpha: what of the cove shows through)
     6. spray      camera-facing sheets at R.coast.spray when the swell's crest arrives (storms)
     7. probes     SEAPROBE: the displaced sea's height and slopes at R.coast.probes
   Everything that moves is a function of uTime.x (1024 s), uTime.y (240 s) or uDrift2 (840 m),
   with every period dividing its clock; the one accumulator (the foam, tau 1.6 s) decays to the
   present sea. Nothing reads anything but the atmo, clouds and coast libraries, REFL and the
   contract textures.                                                                          */
WX.lib("ocean", `
/* the sea at probe i of R.coast.probes, as the ocean slot left it last frame:
   x height m, y dh/dx, z dh/dz (averaged over the probe's radius), w 1 once written */
vec4 wxSeaProbe(int i) { return texelFetch(sSeaProbe, ivec2(i, 0), 0); }
`);
WX.pass((function () {
  const TAU = 2 * Math.PI, D2R = Math.PI / 180, GR = 9.81;
  /* cascades (render.md 7.2): ratios 8 and 5.6, never integers; each turned so the lattices never align */
  const LS = [331, 41, 7.3], ROT = [0, 29 * D2R, -53 * D2R];
  const KB = [6 * TAU / LS[1], 6 * TAU / LS[2]];          // band edges rad/m: no k is counted twice
  /* the swell: four long-crested components at frequencies n 2 pi / 1024 (so they loop with the sea),
     around the contract's 1024/93 s, a few degrees apart: a narrow JONSWAP (gamma 7) with cos^2s
     spreading (s 32), sampled. Their beats make sets of 10-15 waves. [n, turn deg, energy share] */
  const SWELL = [[93, 0, 0.40], [86, 5, 0.20], [100, -6, 0.22], [97, 2.5, 0.18]];
  const EIK = { N: 256, x0: -2200, x1: 2200, z0: -260, z1: 2600 };   // the swell's travel-time field over the cove
  const FOAM_TILE = [7, 21];                              // m; both divide the 840 m drift wrap
  const SPUME_RINGS = 40, SPUME_COLS = 48;                // [r2] the spume's emitters: 60 m x 1.075^39 = 1.0 km, +-50 deg
/*@lab*/ WX.param("oceanDbg", 0, -1, 17, 1, "ocean"); /*@end*/       // lab: 0 picture; 1 height, 2 slope variance, 3 foam, 4 normal, 5 shore, 6 alpha, 7 whitecaps, 8 the rocks' band, 9 NaN, 10 bores, 11-16 raw numbers, -1 the spray in magenta
  WX.param("oceanFoam", 1, 0, 3, 0.01, "ocean");          // whitecap calibration factor (Monahan)
  /*@lab*/ WX.param("oceanLampTest", 0, 0, 1, 1, "ocean"); /*@end*/    // lab: glint two test lamps when R.coast.lamps is empty
  WX.param("oceanSpray", 1, 0, 1, 1, "ocean");
  WX.param("oceanShore", 1, 0, 1, 1, "ocean");
  /*@lab*/ WX.param("oceanProf", 0, 0, 255, 1, "ocean"); /*@end*/      // lab timing: skip 1 the FFT, 2 the sea, 4 the probes, 8 the sprays, 16 the fragment work; >> 5 stop after a stage
  WX.param("oceanAniso", 0, 0, 16, 1, "ocean");          // the arrays' anisotropy (0: by tier)
  /*@lab*/ WX.param("oceanGrid", 1, .5, 3, .05, "ocean"); /*@end*/      // lab: a multiplier on knobs.grid (timing only)

  /* ── GLSL shared by every ocean program ── */
  const OCN = `
uniform vec3 uL;                 // cascade tile sizes m
uniform vec3 uRc, uRs;           // cascade rotations: cos, sin
uniform float uNC;               // cascades in use (2 at T0)
uniform vec4 uSw[4];             // swell components: xy direction of travel, z deep k rad/m, w amplitude m
uniform vec4 uSwN;               // their frequencies in 2 pi / 1024 s
uniform vec4 uSea;               // x choppiness, y extra slope variance per axis, z wind-sea Hs m, w swell Hs m
uniform vec4 uKc;                // xyz each cascade's typical k (for the shallows), w the swell's main deep k
uniform vec4 uEikB;              // the swell's travel-time field: x0, z0, 1 / width, 1 / depth (m)
uniform float uEikOn;
uniform vec4 uWindO;             // the wind the sea sees: xy direction of travel, z U10 with the gusts (uWind; the lab can hold it)
uniform vec4 uRefl4;             // x REFL's lod for the sky's mean, y COASTREFL's lod offset, z debug mode, w the shore on 0/1
uniform vec4 uFoamW3;            // x the spray haze's scroll 0..1, yz [r2] the spume's two noise scrolls 0..1, w the streaks' (70 m tiles)
uniform vec4 uSurfA;             // [r2] x the fresh white water's scroll along the swell, 21 m tiles 0..1 (6 m/s, whole tiles per 1024 s), y detail 0/1 (T3-T4),
                                 // [r3] z 0 below 70 % (no bore breaks near the window) .. 1 from about 80 %
uniform highp sampler2DArray uDisp, uSlope;
uniform highp sampler2D uEik;
vec2 ocnToLocal(vec2 v, int c) { return vec2(uRc[c] * v.x + uRs[c] * v.y, -uRs[c] * v.x + uRc[c] * v.y); }
vec2 ocnToWorld(vec2 v, int c) { return vec2(uRc[c] * v.x - uRs[c] * v.y, uRs[c] * v.x + uRc[c] * v.y); }
/* 2 pi n t / 1024, exact for t in [0, 1024) and integer n (integer product, then the fraction) */
float ocnPhase(float n, float t) {
  float ti = floor(t);
  uint a = (uint(n + .5) * uint(ti)) & 1023u;
  return 2. * PI * fract((float(a) + n * (t - ti)) / 1024.);
}
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
/* [r3] smooth 1D value noise (k: a seed), on a cheap float hash (Hoskins' hash11; its inputs stay under 1e4) */
float ocnH1(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float ocnN1(float x, float k) {
  float i = floor(x), f = x - i;
  f = f * f * (3. - 2. * f);
  i += k * 131.7;
  return mix(ocnH1(i), ocnH1(i + 1.), f);
}
/* [r3] value noise on (x, c) with c periodic in 93 (the main component's crests per 1024 s) */
float ocnN2(vec2 p, float k) {
  vec2 i = floor(p), f = p - i;
  f = f * f * (3. - 2. * f);
  float y0 = i.y - 93. * floor(i.y / 93.), y1 = y0 + 1.;
  y1 -= 93. * floor(y1 / 93.);
  float a = ocnH1(i.x + y0 * 157.3 + k), b = ocnH1(i.x + 1. + y0 * 157.3 + k), c = ocnH1(i.x + y1 * 157.3 + k), d = ocnH1(i.x + 1. + y1 * 157.3 + k);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
/* [r3] how ready the swell is to break here, 0..1, on (c: the main component's unwrapped cycles, constant along its
   crests and travelling with them; s: alongshore m): each crest carries its own peaks and shoulders, 30-150 m long,
   so a breaker line breaks in segments, first at its peaks (further out), then peeling along the crest as it reaches
   shallower water. Continuous in both (no crest numbering, which a set's phase slips would break), periodic with the sea */
float ocnPeak(float c, float s) {
  float g = .62 * ocnN2(vec2(s / 95., c), 3.) + .38 * ocnN2(vec2(s / 33., c + .5), 71.);
  /* [r4] and a peak every 50-110 m along each crest (a phase that wanders along the crest and from crest to crest,
     continuous in both): value noise alone left whole crests ready to break where it ran high, so at 80-90 % one even
     breaker crossed the bay from the left rocks to the pier (REVIEW-3 B2, clips e and f). Now every line has gaps */
  g = mix(g, .5 + .5 * sin(2. * PI * (s / 72. + 2.4 * ocnN2(vec2(s / 170., c + .25), 29.))), .5);
  return g;
}
/* [r3] breaking for a wave of envelope r (of its depth limit) and height-to-depth hh at readiness g */
float ocnBrk(float r, float hh, float g) {
  float gm = mix(.5, 1.35, g);
  /* even where the depth makes every wave break (a reef, a storm's inner surf) a crest breaks harder at its peaks:
     its shoulders keep a lip of white over a dark face, so no line is one even ribbon */
  float b = max(smoothstep(.55, 1.15, r * gm), smoothstep(.4, .8, hh * gm) * smoothstep(.12, .4, r));
  /* [r4] between its peaks a crest's face stays green: at 80-90 % round 3's floor (.15) and soft ramp left about 70 % of
     each line breaking at half strength or more, one even ribbon across the bay (REVIEW-3 B2, clips e and f). Only a
     storm's saturated surf (r well past the depth's limit, or the storm itself) keeps round 3's lip on the shoulders */
  float sat = uWx2.w * uWx2.w;
  return b * mix(mix(.05, .15, sat), 1., smoothstep(mix(.42, .26, sat), mix(.63, .6, sat), g));
}
/* the wind sea lies down in shallow water: each cascade by tanh(k depth) */
vec3 ocnDamp(float depth) {
  float h = max(depth, 0.);
  /* the long waves: what the depth can hold; the short: tanh(k h). [r2] In the surf the long cascade keeps
     only 0.35 of the depth: the bores (ocnSwell) carry the energy it loses there, as breaking lines */
  return vec3(min(tanh(uKc.x * h * 4.), .35 * h / max(uSea.z, .1)), tanh(uKc.yz * h));
}
`;
  /* the surface: displacement and slopes of the wind sea (FFT) and the swell at a point, for a
     footprint given by two gradient vectors (m); used by the sea's vertices and the probes */
  const SURF = `
struct Swl { vec3 D; vec2 s; float var; vec2 cs; float brk; float H; float H0; float nl; vec2 kv; float U; float r; float hh; float al; float bf; };
/* the swell at xz, shoaled (linear shoaling, Green's law in shallow water), slowed and turned by the
   cove's travel-time field (an eikonal solved from the shore field), scaled by the exposure. In shallow
   water it also takes the energy the wind sea's long cascade loses there (dmp0).
   [r2] The four components make one carrier Z = sum a e^(i phase) (its beats are the sets). In the surf its
   envelope saturates at 0.36 of the depth (bores near 0.7 h high, every wave breaking in a storm), and the
   profile is no sine: the crest runs ahead of the trough (a Riemann simple wave, y = cos(theta + sg y),
   steep in front, long behind) and sharpens over a flat trough (cnoidal), more as the wave nears its limit.
   Out: D displacement, s slope, var the slope variance the footprint filters out, cs the bore's (cos, sin)
   phase (0 at the crest, rising after it passes), brk how hard it breaks 0..1, H the local crest-to-trough
   height m, H0 the unbroken Hs m, nl the nonlinearity 0..1, kv the carrier's local wave vector (rad/m, along its travel).
   foot: the footprint along the swell (m), for filtering; tm: the sea's clock (s, 0..1024) */
Swl ocnSwell(vec2 xz, float foot, vec4 sh, float tm, float dmp0) {
  Swl o; o.D = vec3(0.); o.s = vec2(0.); o.var = 0.; o.cs = vec2(1., 0.); o.brk = 0.; o.H = 0.; o.H0 = 0.; o.nl = 0.; o.kv = vec2(0., 1e-3);
  o.U = 0.; o.r = 0.; o.hh = 0.; o.al = 0.; o.bf = 0.;
  float h = max(sh.y, .02);
  vec4 ek = vec4(0.);
  if (uEikOn > .5) {
    vec2 eu = (xz - uEikB.xy) * uEikB.zw;
    if (all(greaterThan(eu, vec2(0.))) && all(lessThan(eu, vec2(1.)))) ek = textureLod(uEik, eu, 0.);
  }
  float k0 = uKc.w, kh0 = k0 * min(h, 400.);
  float khl = kh0 / sqrt(tanh(kh0));                                   // Eckart
  float Ks = 1. / sqrt(tanh(khl) * (1. + 2. * khl / sinh(min(2. * khl, 40.))));
  float Hsw = uSea.w * Ks * sh.z, Had = .85 * uSea.z * sqrt(max(1. - dmp0 * dmp0, 0.)) * mix(.5, 1., sh.z);
  float Ht = sqrt(Hsw * Hsw + Had * Had);
  o.H0 = Ht;
  float A = Ht / max(uSea.w, .05);                                     // the components are normalised to the deep swell's Hs
  vec2 Z = vec2(0.), gX = vec2(0.), gY = vec2(0.), Dh = vec2(0.), km = vec2(0.);
  float sa = 0., sf = 0., kk = 0.;
  for (int i = 0; i < 4; i++) {
    vec4 c = uSw[i];
    float w = uSwN[i] * (2. * PI / 1024.);
    vec2 kv = c.z * c.xy + w * ek.yz;                                  // the local wave vector: deep + the delay's gradient
    float k = length(kv);
    float ph = ocnPhase(uSwN[i], tm) - c.z * dot(c.xy, xz) - w * ek.x;
    float a = c.w * A, f = exp(-.5 * k * k * foot * foot);
    float sn = sin(ph), cn = cos(ph);
    Z += a * vec2(cn, sn);
    gX += (a * sn) * kv; gY -= (a * cn) * kv;                          // the gradients of Re Z and Im Z
    Dh += kv / max(k, 1e-5) * min(.9, .22 / max(k * a, 1e-3)) * a * sn * f;   // Gerstner: sharp crests in deep water
    sa += a; sf += a * f; kk += a * k * k; km += a * kv;
  }
  float Z2 = dot(Z, Z) + 1e-8, Al = sqrt(Z2);
  vec2 gth = (Z.x * gY - Z.y * gX) / Z2, gA = (Z.x * gX + Z.y * gY) / Al;
  float Am = .36 * h, r = Al / Am, tr = tanh(r);                       // [r2] bores up to 0.72 h crest to trough (breakers 0.78 h)
  float Ae = Am * tr, Fl = sf / max(sa, 1e-6);                         // the envelope held by the depth; the footprint's mean filter
  float th = atan(Z.y, Z.x), y = cos(th);
  /* [r3] where on the swell this is: the main component's unwrapped cycles (93 per 1024 s, constant along its crests),
     and the alongshore coordinate. Each part of a crest breaks where its readiness (ocnPeak) and the depth allow */
  float cyc0 = uSwN[0] * tm / 1024. - (uSw[0].z * dot(uSw[0].xy, xz) + uSwN[0] * (2. * PI / 1024.) * ek.x) / (2. * PI);
  float sAl = dot(xz, vec2(-uSw[0].y, uSw[0].x));
  float g = ocnPeak(cyc0, sAl);
  /* breaking: this wave at its own limit, or a saturated surf zone (Hs over 0.4 of the depth: every wave but a set's
     smallest is a bore, whatever the set does). [r3] Below 70 % (the mean wind under 9-11 m/s) no bore breaks
     within 45-70 m of the window: a calm's shore break is on the rocks, not across the frame's foot */
  float bfac = smoothstep(.05, .3, sh.y) * mix(smoothstep(45., 70., length(xz)), 1., uSurfA.z);
  float brk = ocnBrk(r, Ht / h, g) * bfac;
  float nl = max(tr * smoothstep(.3, 1., r), .95 * brk);              // nonlinear near the depth's limit (deep water stays sinusoidal)
  float sg = .88 * nl * nl;
  for (int j = 0; j < 4; j++) y = cos(th + sg * y);                    // a contraction for sg < 1
  float phi = th + sg * y, sp = sin(phi);
  float dyt = -sp / (1. + sg * sp), u = .5 * y + .5;
  float P = mix(y, 2. * u * u - .75, nl), dP = mix(1., 2. * u, nl);    // zero mean over a period, crest-to-trough 2
  o.D = vec3(Dh * (1. - nl), Ae * P * Fl).xzy;
  o.s = Fl * (Ae * dP * dyt * gth + P * (1. - tr * tr) * gA);
  float k2 = kk / max(sa, 1e-6);
  o.var = .5 * k2 * Ae * Ae * (1. + 3. * sg * sg) * (1. - Fl * Fl);
  o.cs = vec2(cos(phi), sp);
  o.brk = brk;
  o.H = 2. * Ae; o.nl = nl; o.kv = km / max(sa, 1e-6);
  o.U = cyc0; o.r = r; o.hh = Ht / h; o.al = sAl; o.bf = bfac;   // [r3] crest cycles (fract: the phase age), the breaking's inputs
  return o;
}
/* the bed under a wave: near the shore the larger of the point's depth and the mean of four taps 8 m round
   it, so a pile's or a hull's footprint in the shore field never reads as a shoal (a reef flat, a shelf or a
   beach stays shallow: the taps are shallow too) */
float ocnBed(vec2 xz, vec4 sh) {
  if (uRefl4.w <= 0. || sh.x >= 60.) return sh.y;
  float m = wxShore(xz + vec2(8., 0.)).y + wxShore(xz - vec2(8., 0.)).y + wxShore(xz + vec2(0., 8.)).y + wxShore(xz - vec2(0., 8.)).y;
  /* [r3] faded out toward 60 m from the waterline: round 2 switched at 60 m, a step in the depth (and so in the bores'
     breaking and phase) along a line that runs away from the window, a vertical seam on the screen */
  return mix(max(sh.y, .25 * m), sh.y, smoothstep(35., 60., sh.x));
}
/* the wind sea: the sum of the cascades at a footprint (gradients gx, gy in m), damped in shallow water */
vec3 ocnWind(vec2 xz, vec2 gx, vec2 gy, vec3 dmp, out float w0) {   // w0: cascade 0's held compression
  vec3 D = vec3(0.);
  w0 = 0.;
  float fp = max(length(gx), length(gy)), nT = float(textureSize(uDisp, 0).x);
  for (int i = 0; i < 3; i++) {
    if (float(i) >= uNC) break;
    vec2 q = ocnToLocal(xz, i) / uL[i];
    /* trilinear at the larger footprint, less half a level: anisotropic filtering buys a vertex nothing */
    vec4 t = textureLod(uDisp, vec3(q, float(i)), max(log2(fp * nT / uL[i]) - .5, 0.));
    vec2 h = ocnToWorld(t.xz, i);
    D += dmp[i] * vec3(h.x, t.y, h.y);
    if (i == 0) w0 = t.w;
  }
  return D;
}
vec2 ocnWindSlope(vec2 xz, vec2 gx, vec2 gy, vec3 dmp) {
  vec2 s = vec2(0.);
  for (int i = 0; i < 3; i++) {
    if (float(i) >= uNC) break;
    vec2 q = ocnToLocal(xz, i) / uL[i];
    vec4 t = textureGrad(uSlope, vec3(q, float(i)), ocnToLocal(gx, i) / uL[i], ocnToLocal(gy, i) / uL[i]);
    s += dmp[i] * ocnToWorld(t.xy, i);
  }
  return s;
}
`;

  /* ── 1. the spectrum: fetch-limited JONSWAP, Donelan-Banner spreading, one fixed Gaussian field ── */
  const SPEC = `
uniform vec4 uWindS;   // xy wind direction of travel (unit), z mean U10 m/s, w omega_p
uniform vec4 uJon;     // x alpha (normalised to the growth law), y gamma, z kb1, w kb2
uniform float uN;
out vec4 o;
vec2 ocnGauss(ivec3 key) {      // the same value for the same k at every N: the 128 tiers take the central k
  uvec3 h = wxPcg3(uvec3(key + ivec3(32768, 32768, 11)));
  float u1 = max(float(h.x) * (1. / 4294967296.), 1e-12), u2 = float(h.y) * (1. / 4294967296.);
  return sqrt(-2. * log(u1)) * vec2(cos(2. * PI * u2), sin(2. * PI * u2));
}
float ocnSpec(vec2 k) {         // S(kx, kz) m^4: the wind sea's directional spectrum
  float kk = length(k);
  if (kk < 1e-6) return 0.;
  float w = sqrt(9.81 * kk), wp = uWindS.w, r = w / wp;
  float sg = w <= wp ? .07 : .09, e = (w - wp) / (sg * wp);
  float r2 = r * r;
  float S = uJon.x * 96.2361 / (w * w * w * w * w) * exp(-1.25 / (r2 * r2)) * pow(uJon.y, exp(-.5 * e * e));
  float beta = r < .95 ? 2.61 * pow(r, 1.3) : r < 1.6 ? 2.28 * pow(r, -1.3) : pow(10., -.4 + .8393 * exp(-.567 * log(r2)));
  float th = atan(k.y, k.x) - atan(uWindS.y, uWindS.x);
  th = mod(th + PI, 2. * PI) - PI;
  float bt = clamp(beta * th, -30., 30.), sech = 2. / (exp(bt) + exp(-bt));
  float Dd = beta / (2. * tanh(beta * PI)) * sech * sech;
  return S * Dd * (9.81 / (2. * w)) / kk;
}
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int N = int(uN), c = px.x / N;
  ivec2 m = ivec2(px.x - c * N, px.y);
  m -= N * ivec2(greaterThanEqual(m, ivec2(N / 2)));
  float dk = 2. * PI / uL[c];
  vec2 kl = vec2(m) * dk, kw = ocnToWorld(kl, c);
  float kk = length(kl);
  float lo = c == 0 ? 0. : c == 1 ? uJon.z : uJon.w, hi = c == 0 ? uJon.z : c == 1 ? uJon.w : 1e9;
  if (m.x == -N / 2 || m.y == -N / 2 || kk <= lo || kk > hi || kk == 0.) { o = vec4(0.); return; }
  vec2 g1 = ocnGauss(ivec3(m, c)), g2 = ocnGauss(ivec3(-m, c));
  vec2 h0 = g1 * (dk * .5) * sqrt(ocnSpec(kw)), hm = g2 * (dk * .5) * sqrt(ocnSpec(-kw));
  o = vec4(h0, hm.x, -hm.y);    // h0(k), conj(h0(-k))
}`;

  /* ── 2. evolve: h(k, t) and its derivatives, packed two real fields per complex one ── */
  const EVOLVE = `
uniform highp sampler2D uH0; uniform float uN;
layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int N = int(uN), c = px.x / N;
  ivec2 m = ivec2(px.x - c * N, px.y);
  m -= N * ivec2(greaterThanEqual(m, ivec2(N / 2)));
  vec4 h = texelFetch(uH0, px, 0);
  vec2 kl = vec2(m) * (2. * PI / uL[c]);
  float kk = length(kl);
  if (kk == 0.) { o0 = vec4(0.); o1 = vec4(0.); return; }
  float n = floor(sqrt(9.81 * kk) * (1024. / (2. * PI)) + .5);      // omega quantised: the sea loops in 1024 s
  float ph = ocnPhase(n, uTime.x);
  vec2 e = vec2(cos(ph), sin(ph));
  vec2 a = cmul(h.xy, vec2(e.x, -e.y)) + cmul(h.zw, e);                 // waves travel along +k: with the wind
  vec2 u = kl / kk, ia = vec2(-a.y, a.x);
  vec2 Dx = u.x * ia, Dz = u.y * ia;                                    // choppy: x' = x + lambda D sharpens the crests
  vec2 Sx = kl.x * ia, Sz = kl.y * ia;
  vec2 Dxx = -kl.x * u.x * a, Dzz = -kl.y * u.y * a, Dxz = -kl.x * u.y * a;
  o0 = vec4(Dx + vec2(-Dz.y, Dz.x), a + vec2(-Dxz.y, Dxz.x));          // (Dx + i Dz, Dy + i Dxz)
  o1 = vec4(Sx + vec2(-Sz.y, Sz.x), Dxx + vec2(-Dzz.y, Dzz.x));        // (Sx + i Sz, Dxx + i Dzz)
}`;

  /* ── 3. one Stockham radix-2 pass (Govindaraju et al. 2008), gather form, over the C N x N strip ── */
  const FFT = `
uniform highp sampler2D uA, uB; uniform int uStage, uDir; uniform float uN;
layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1;
vec2 cm(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int N = int(uN);
  int o = uDir == 0 ? px.x % N : px.y, base = uDir == 0 ? px.x - o : 0;
  int Ns = 1 << uStage, k = o & (Ns - 1), j = (o >> (uStage + 1)) * Ns + k;
  float ang = PI * float(k) / float(Ns);
  vec2 w = ((o & Ns) == 0 ? 1. : -1.) * vec2(cos(ang), sin(ang));
  ivec2 p0 = uDir == 0 ? ivec2(base + j, px.y) : ivec2(px.x, j);
  ivec2 p1 = uDir == 0 ? ivec2(base + j + N / 2, px.y) : ivec2(px.x, j + N / 2);
  vec4 a0 = texelFetch(uA, p0, 0), b0 = texelFetch(uA, p1, 0), a1 = texelFetch(uB, p0, 0), b1 = texelFetch(uB, p1, 0);
  o0 = vec4(a0.xy + cm(w, b0.xy), a0.zw + cm(w, b0.zw));
  o1 = vec4(a1.xy + cm(w, b1.xy), a1.zw + cm(w, b1.zw));
}`;

  /* ── 4. finalize one cascade: displacement + held Jacobian foam, slopes of the choppy surface + moments ── */
  const FIN = `
uniform highp sampler2D uA, uB; uniform highp sampler2DArray uFoamPrev;
uniform float uN, uC, uDt, uSpan;
layout(location = 0) out vec4 oD; layout(location = 1) out vec4 oS; layout(location = 2) out vec4 oF;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int c = int(uC);
  ivec2 q = ivec2(c * int(uN) + p.x, p.y);
  vec4 a = texelFetch(uA, q, 0), b = texelFetch(uB, q, 0);
  float l = uSea.x;
  float jx = 1. + l * b.z, jz = 1. + l * b.w, J = jx * jz - l * l * a.w * a.w;
  vec2 s = b.xy / max(vec2(jx, jz), vec2(.25));
  float fp = texelFetch(uFoamPrev, ivec3(p, c), 0).r;
  /* the compression (1 - J) in units of three of its standard deviations, held with tau 1.6 s: the render's
     threshold on it picks the whitecaps (Monahan in open water, most crests in a surf zone) */
  float f = max(clamp((1. - J) / uSpan, 0., 1.), fp * exp(-uDt / 1.6));
  oD = vec4(l * a.x, a.z, l * a.y, f);
  oS = vec4(s, s * s);
  oF = vec4(f, 0., 0., 1.);
}`;

  /* [r4] the held foam carried into an FFT of another size (a tier change): uR the old size over the new */
  const FOAMCOPY = `
uniform highp sampler2DArray uOld; uniform float uC, uR;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int c = int(uC);
  float f = 0.;
  if (uR > 1.5) { for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) f = max(f, texelFetch(uOld, ivec3(p * 2 + ivec2(x, y), c), 0).r); }
  else f = texelFetch(uOld, ivec3(uR < .75 ? p / 2 : p, c), 0).r;
  o = vec4(f, 0., 0., 1.);
}`;

  /* ── a tileable foam pattern, made once: r lace (warped cell walls at three scales, aged foam; [r2] the cells
     drawn out 2:1 along v, which is world z, within 20 degrees of the wind), g soft blotches (spray puffs, patches),
     b [r2] clumps (white water's tumbling mass: inverted cells at three scales, bright tops, dark gaps), a sparse
     sparkle points (mean 0.075 exactly) ── */
  const FOAMTEX = `
in vec2 vUV; out vec4 o;
vec2 cellPt(vec2 c, vec2 per) { return wxHash22(mod(c, per)) * .84 + .08; }
/* F1, F2 of cells tiling with period per (cells per tile, per axis); st stretches the distance metric */
vec2 worley(vec2 p, vec2 per, vec2 st) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 9., d2 = 9.;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(x, y), r = (g + cellPt(i + g, per) - f) * st;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return sqrt(vec2(d1, d2));
}
vec2 worley(vec2 p, float per) { return worley(p, vec2(per), vec2(1.)); }
float vn(vec2 p, float per) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  float a = wxHash12(mod(i, per)), b = wxHash12(mod(i + vec2(1, 0), per)), c = wxHash12(mod(i + vec2(0, 1), per)), d = wxHash12(mod(i + vec2(1, 1), per));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p, float per) { float s = 0., w = .5; for (int k = 0; k < 5; k++) { s += w * vn(p, per); p *= 2.; per *= 2.; w *= .5; } return s / .97; }
void main() {
  vec2 p = vUV;
  vec2 wq = vec2(fbm(p * 5., 5.), fbm(p * 5. + vec2(.37, .61), 5.)) - .5;          // a tileable warp: irregular cells
  vec2 A = vec2(1., .5);                                                            // [r2] cells twice as long along v
  vec2 w1 = worley(p * vec2(9., 5.) + wq * 1.6, vec2(9., 5.), A * vec2(1., 1.8)), w2 = worley(p * vec2(21., 11.) + wq * 3.2 + 7.3, vec2(21., 11.), A * vec2(1., 1.9)),
       w3 = worley(p * vec2(45., 23.) + wq * 5., vec2(45., 23.), A * vec2(1., 1.96));
  float l1 = smoothstep(.20, .02, w1.y - w1.x), l2 = smoothstep(.17, .02, w2.y - w2.x), l3 = smoothstep(.15, .0, w3.y - w3.x);
  float n = fbm(p * 7. + wq * 2., 7.);
  float lace = max(l1 * .95, l2 * .8) + l3 * .45 * smoothstep(.35, .65, n);
  lace *= .5 + .5 * smoothstep(.25, .6, fbm(p * 13. + 2.7, 13.));                 // aged foam tears into holes
  lace = clamp(lace + .35 * smoothstep(.62, .92, n), 0., 1.);                   // [r3] fewer blotches: aged foam is veins, not decals
  float blot = smoothstep(.2, .85, fbm(p * 3. + wq, 3.));
  /* [r2] clumps: inverted cells at 1/6, 1/14 and 1/32 of the tile, warped, summed: the cauliflower of white water */
  float c1 = 1. - smoothstep(0., .62, worley(p * 6. + wq * 1.3, 6.).x), c2 = 1. - smoothstep(0., .66, worley(p * 14. + wq * 2.6 + 3.1, 14.).x);
  float c3 = 1. - smoothstep(0., .7, worley(p * 32. + wq * 4. + 5.7, 32.).x);
  float streak = clamp(.5 * c1 + .35 * c2 + .3 * c3 - .08, 0., 1.);
  float sp = smoothstep(.85, 1., wxHash12(mod(floor(p * 128.), 128.)));
  o = vec4(lace, blot, streak, sp);
}`;

  /* ── 5. the sea ── */
  const SEA_VS = `
layout(location = 0) in vec2 aPos;          // the projected grid, NDC
uniform vec4 uGrid;                          // x one grid cell in rad, y 1 / horizon NDC, zw unused
uniform sampler2D uFoamTex;                  // [r2] the spray haze's noise
uniform vec4 uStreak;                        // xy wind direction (unit)
out vec3 vP0;                                // the undisplaced point on the curved sea (world m)
out vec3 vP;                                 // the displaced point
out vec4 vAP;                                // the air in front: in-scatter (pre-exposed), transmittance
out vec4 vSunE;                              // the sun's illuminance at the sea (no clouds, no cove) rgb, the moon's (luminance) a
out vec4 vAmb;                               // the sky's irradiance / pi (wxAmbient, clouds included) rgb, the cloud shadow a
out vec4 vSh;                                // the shore field (signed distance m, still depth m, exposure, rockiness), raw
out vec4 vSw;                                // the swell's slope xy, its filtered slope variance, the bores' local crest-to-trough height m
out vec4 vSwC;                               // [r5] x the bore's linear phase, unwrapped (cycles), y its profile's sharpening; [r2] z how hard it breaks 0..1, w height / Hs
out vec4 vMisc;                              // x the bed's depth under the wave (low-passed near the shore) m, y cascade 0's held compression, z its far weight, w the local wind-sea Hs m
out vec4 vC0;                                // cascade 0's slope xy (world, damped) and slope variance per axis zw
out vec4 vRun;                               // swash: x the water level at the shore now m, y the cove's key-light shadow, z the period's age 0..1, w swash zone 0..1
out vec4 vHaze;                              // [r2] the spray haze in front (above 15 m/s): rgb its in-scatter, a its opacity (per vertex: 512 m tiles)
void main() {
  vec2 uv = aPos * .5 + .5;
  vec3 d = wxRay(uv);
  float Rm = R_G * 1000., h = wxEye;
  float c = h * (2. * Rm + h), b = (Rm + h) * d.y, disc = b * b - c;   // r^2 - R^2 in its stable form
  vec3 eye = vec3(0., h, 0.), p0;
  float t;
  if (d.y < 0. && disc > 0.) { t = c / (-b + sqrt(disc)); p0 = eye + d * t; }
  else {                                                                // above the horizon: the horizon in this azimuth
    vec2 az = normalize(d.xz);
    float sd = sqrt(c) / (Rm + h), cd = Rm / (Rm + h);
    d = vec3(az.x * cd, -sd, az.y * cd);
    t = sqrt(c); p0 = eye + d * t;
  }
  float fw = t * uGrid.x, fl = fw / max(-d.y, .003);                    // the footprint across and along the ray, m
  vec2 ax = normalize(vec2(-d.z, d.x)), al = normalize(d.xz);
  vec4 sh = uRefl4.w > 0. ? wxShore(p0.xz) : vec4(1e4, 60., 1., 0.);
  /* the bed under a wave: near the shore the depth is the larger of the point's and the mean of four taps
     8 m round it, so a pile's or a hull's footprint in the shore field never reads as a shoal; a reef flat,
     a shelf or a beach stays shallow (the taps are shallow too) */
  float depth = ocnBed(p0.xz, sh);
  vec3 dmp = ocnDamp(depth);
  float D0w;
  vec3 D = ocnWind(p0.xz, ax * fw, al * fl, dmp, D0w);
  /* cascade 0's slope, variance and held foam per vertex: its 2.6 m texels are coarser than the grid near the
     window, and far away the footprint blurs them anyway; the fragments read only the finer two */
  {
    vec2 q0 = ocnToLocal(p0.xz, 0) / uL[0], g0x = ocnToLocal(ax * fw, 0) / uL[0], g0y = ocnToLocal(al * fl, 0) / uL[0];
    /* [r6] filtered to about two grid cells (round 5: -.5, under one): the 8 px grid held its shorter waves at under two
       vertices a wavelength, and the grid's points move with the TAA's jitter, so their linear interpolation changed
       every frame; the mirror, a strong magnifier at a grazing view, showed that as the far sea's flicker (the user's
       report). What the coarser mip leaves out goes into the variance (zw), as LEAN has it: a sheen, not a shimmer */
    vec4 t = textureLod(uSlope, vec3(q0, 0.), max(log2(max(fw, fl) * float(textureSize(uSlope, 0).x) / uL[0]) + .5, 0.));
    vec2 vl = max(t.zw - t.xy * t.xy, 0.);
    float co = uRc[0], si = uRs[0];
    vC0 = vec4(dmp.x * ocnToWorld(t.xy, 0), dmp.x * dmp.x * vec2(co * co * vl.x + si * si * vl.y, si * si * vl.x + co * co * vl.y));
    float texel = uL[0] / float(textureSize(uDisp, 0).x);
    vMisc = vec4(0., D0w, smoothstep(1.5, 6., max(fw, fl) / texel), 0.);
  }
  float fsw = 1.3 * mix(fw, fl, abs(dot(al, uSw[0].xy)));          // [r6] the swell filtered a little wider, for the same reason
  vec4 shd = vec4(sh.x, depth, sh.zw);
  Swl s = ocnSwell(p0.xz, fsw, shd, uTime.x, dmp.x);
  D += s.D;
  vMisc.x = depth;
  /* swash: at the waterline the swell runs up the shore once per period and falls back (R = 0.5 Hs xi). Over
     the shore the surface holds near the period's highest line while the backwash drains, so the lace it
     leaves can be drawn on the wet rock; the fragment decides what is water and what is a dry shore's film.
     Everything here is smooth in the shore distance: no vertex may stand up a wall */
  vRun = vec4(0.);
  if (sh.x < 40. && sh.x > -25. && uRefl4.w > 0.) {
    vec2 nrm = wxShoreNormal(p0.xz);
    float d10 = wxShore(p0.xz + nrm * (10. - sh.x)).y;
    float slope = clamp(d10 / 10., .03, 1.5);
    float H0 = s.H0;
    float xi = slope / sqrt(max(H0, .05) / 189.);                       // Iribarren, against the deep swell's 189 m
    float Ru = min(min(.5 * H0 * xi, 1.2 * H0 + .1), 2.2);              // a swash, never a wall (spray does the rest)
    float ph = atan(s.cs.y, s.cs.x);                                    // the main component's phase at the shore
    float tau = fract(ph / (2. * PI) + .1);
    float up = tau < .3 ? sin(tau / .3 * PI * .5) : cos((tau - .3) / .7 * PI * .5);
    float hold = max(up, .92 * step(.3, tau) * (1. - smoothstep(.85, 1., tau)));
    float zone = smoothstep(40., 2., sh.x) * smoothstep(-25., -12., sh.x), landW = smoothstep(1.5, -1.5, sh.x);
    vRun = vec4(Ru * up, 1., tau, zone);
    D.y += Ru * mix(up, hold, landW) * zone;
  }
  vec3 p = p0 + D;
  vP0 = p0; vP = p;
  vSw = vec4(s.s, s.var, s.H);
  /* [r5] the bore's phase, unwrapped, so the fragment rebuilds it at its own point: past ~150 m the grid (8 px cells at
     T0-T2, 4 px at T3-T4) holds one vertex or less per wavelength, and the (cos, sin) pair interpolated between vertices
     on different crests drew a smeared white band per row of vertices (REVIEW-4 #1, the rails, with the spume). The
     carrier's linear phase is unwrapped on the main component's cycles (continuous over the bay; its offset from them,
     the sets' beat, varies over 6-10 wavelengths), and a linear phase interpolates exactly whatever the grid's spacing */
  float th0 = atan(s.cs.y, s.cs.x) - .88 * s.nl * s.nl * s.cs.x;      // the linear phase (ocnSwell: phi = th + sg cos phi)
  float dth = th0 - 2. * PI * s.U;
  float cu = s.U + (dth / (2. * PI) - floor(dth / (2. * PI) + .5));
  vSwC = vec4(cu, .88 * s.nl * s.nl, s.brk * uRefl4.w, (D.y - vRun.x * vRun.w) / max(uSea.z + uSea.w, .3));   // [r3] z: the breaking with the swell's readiness (per vertex: it varies over tens of metres)
/*@lab*/  if (uRefl4.z > 15.5) vSwC = vec4(ocnPeak(s.U, s.al), s.brk, s.r, s.hh);/*@end*/   // lab: the breaking's inputs (raw, dbg 16)
  vMisc.w = uSea.z * dmp.x;
  vAP = wxAerial(d, t * 1e-3);
  /* [r4] per vertex the air's optical depth per km and its in-scatter's limit, not the transmittance and the in-scatter:
     both are near constant along a row of the sea, so the fragment rebuilds the air at its own distance. Interpolated
     as they were, the transmittance between a vertex at the horizon (13 km) and the next one 8 px down (T0-T2's grid,
     ~1.7 km) let the far sea show through several times too much air: under a storm with sunlit sea past its edge, a
     thin bright line at the horizon (REVIEW-3 B12, x07n on Intel T2; on the RTX at q=2) */
  vAP = vec4(vAP.rgb / max(1. - vAP.a, 1e-3), -log(max(vAP.a, 1e-30)) / max(t * 1e-3, 1e-3));
  vec3 pk = wxPlanet(p0);
  vSunE = vec4(wxSunLight(pk), wxLuma(wxMoonLight(pk)));
  /* slow fields, per vertex: the cloud shadow (190 m texels), the cove's shadow (1-2.5 m texels; the grid is
     0.1-0.5 m apart near the shore), the shore field */
  vSh = sh; vRun.y = wxSunShadow(p);
  vAmb = vec4(wxAmbient(1.), wxCloudShadow(p));
  /* spray haze, blown off the crests above 15 m/s: an exponential layer (30 m) between the eye and the water, its
     density carried along the wind (render.md 10.3) */
  vHaze = vec4(0.);
  if (uWindO.z > 15.) {
    vec2 w = uStreak.xy, mid = .5 * p0.xz;
    vec2 hq = vec2(dot(mid, w) / 512. - uFoamW3.x, dot(mid, vec2(-w.y, w.x)) / 512.);
    float nz = textureLod(uFoamTex, hq, 3.).g * .7 + textureLod(uFoamTex, hq * 3.1 + .3, 2.).g * .5;
    float sig = .4e-3 * smoothstep(15., 25., uWindO.z) * (.4 + 1.2 * nz);
    float th = 1. - exp(-sig * length(p - vec3(0., wxEye, 0.)) * 30. / wxEye * (1. - exp(-wxEye / 30.)));
    vHaze = vec4((vAmb.rgb * 1.05 + vSunE.rgb * vAmb.a * (.25 + 2.5 * wxHG(dot(normalize(p - vec3(0., wxEye, 0.)), uSun.xyz), .7))) * th, th);
  }
  gl_Position = uViewProj * vec4(p, 1.);
}`;
  const SEA_FS = `
in vec3 vP0; in vec3 vP; in vec4 vAP; in vec4 vSunE; in vec4 vAmb; in vec4 vSh; in vec4 vSw; in vec4 vSwC; in vec4 vRun; in vec4 vMisc; in vec4 vC0; in vec4 vHaze;
uniform sampler2D uFoamTex;
uniform vec3 uMss;                   // each cascade's slope variance per axis (the far field's, from the spectrum)
uniform vec4 uGth;                   // xyz each cascade's whitecap threshold on the held compression, w the open sea's whitecap fraction
uniform vec4 uFoamW;                 // x calibration, y storm streaks 0..1, z sparkle 0..1, w the second sparkle layer's scroll 0..1
uniform vec4 uLamp[4];               // the night lights: xyz m, w intensity rel m^2 (pre-exposure). [r3] 4 (contract 1.3: R.coast.lamps' length / 4)
uniform vec4 uStreak;                // xy wind direction (unit), z streak scroll 0..1, w sparkle scroll 0..1
uniform float uGlintCap;             // [r5] the sun's disc as drawn, at its centre: luminance, unexposed
/*@lab*/uniform float uCut;                  // lab timing: stop after stage 1..6/*@end*/
layout(location = 0) out vec4 o;
float ocnLambda(float c, float s2) {          // Smith's Lambda for a Beckmann slope variance (per axis)
  float v = c / sqrt(max((1. - c * c) * 2. * s2, 1e-9));
  return v >= 1.6 ? 0. : (1. - 1.259 * v + .396 * v * v) / (3.535 * v + 2.181 * v * v);
}
/* Bruneton, Neyret & Holzschuch 2010: the reflected radiance of a light of unit irradiance (x), and [r4] the slope
   density at H against its peak (y, 0..1: how likely one facet here shows the light, whatever its brightness; the far
   glitter's density). Returned, not kept in a global: a global written by a function called in loops is costly on
   some compilers */
vec2 ocnGlintPk(vec3 L, vec3 V, vec3 N, vec2 s2) {
  vec3 H = normalize(L + V);
  float zH = dot(H, N);
  if (zH < .15) return vec2(0.);
  vec3 Tx = normalize(vec3(1., 0., 0.) - N * N.x), Ty = cross(N, Tx);
  float zx = dot(H, Tx) / zH, zy = dot(H, Ty) / zH;
  float ex = .5 * (zx * zx / s2.x + zy * zy / s2.y);
  if (ex > 30.) return vec2(0.);                                        // most of the sea: nothing to reflect
  float pk = exp(-ex), p = pk / (2. * PI * sqrt(s2.x * s2.y));
  float zL = max(dot(L, N), .01), zV = max(dot(V, N), .01);
  vec2 lv = vec2(dot(V, Tx), dot(V, Ty)), ll = vec2(dot(L, Tx), dot(L, Ty));
  float cv = lv.x * lv.x / max(dot(lv, lv), 1e-8), cl = ll.x * ll.x / max(dot(ll, ll), 1e-8);
  float sv = s2.x * cv + s2.y * (1. - cv), sl = s2.x * cl + s2.y * (1. - cl);
  float F = .02 + .98 * pow(1. - max(dot(V, H), 0.), 5.);
  return vec2(F * p / ((1. + ocnLambda(zL, sl) + ocnLambda(zV, sv)) * zV * zH * zH * zH * zH * 4.), pk);
}
float ocnGlint(vec3 L, vec3 V, vec3 N, vec2 s2) { return ocnGlintPk(L, V, N, s2).x; }
float ocnFresnel(float cv, float sv) {        // the Fresnel factor averaged over the slopes (Bruneton 2010)
  return .02 + .98 * pow(1. - cv, 5. * exp(-2.69 * sv)) / (1. + 22.7 * pow(sv, 1.5));
}
/* [r2] the surf's white water at the bore's phase age (0 at the crest, the front face .5..1) for a breaking
   strength b: the roller reaches down the front as the bore breaks harder (a broken bore is white to its foot),
   and behind the crest a sheet decays into the residue that covers a storm's surf zone; e (the waves' energy 0..1)
   thins the sheet and the residue of a small shore break to a lace. res 0: its mean */
float ocnSurf(float age, float bB, float bN, float res, float e, float big) {
  float b = .5 * (bB + bN);
  if (max(bB, bN) <= .002) return 0.;
  /* [r2] the roller starts at the steep toe (phase -pi/2 on a broken bore, nearer the crest on a spilling one); the
     trough ahead of it stays dark water. [r3] The roller is the coming crest's (bN), the crest top and the sheet
     behind it the passed one's (bB); the residue is every crest's */
  float wR = mix(.1, .32, wxSat(bN * bN));                            // [r3] a hard-breaking crest's roller reaches further down its face
  float roll = smoothstep(1. - wR, 1. - .7 * wR, age) * bN + (1. - smoothstep(0., .04, age)) * bB;
  /* [r7] big (the caller's: the swell 2 -> 3.6 m from the UBO's uWx2.y, faded out where a pixel spans 0.25-1 m; a new
     uniform component here, even uSurfA.w, put Intel's SIMD8 compile of the sea over its registers, 47 spills). In big
     storm surf every bore's sheet lasts longer and the surf zone between the bores is a churned
     blanket, not a few patches (rocky-creek's and shore-acres' surf zones are white from rock to rock) */
  float trail = (.8 * exp(-age * mix(mix(9., 5.5, e), 3.2, big)) * bB + mix(.28, .66, big) * b * b * e) * mix(.45, 1., e);
  return wxSat(mix(max(roll, trail), b * (.3 + .4 * b) * mix(.5, 1., e), 1. - res));
}
/* [r2] the wind's streaks (Beaufort 8 and up): old foam combed into lanes along the wind. Each lane (sp m across)
   holds one line at its own offset and width, meandering a few metres (mv, shared by the families); a noise along
   the lane breaks it into segments tens of metres long. Analytic across the wind, so a line stays thin and sharp
   near and fades to its mean where it is under a pixel. k: the family (a seed); st: the strength 0..1 */
float ocnLane(float al, float ac, vec2 gq, float mv, float sp, float wd, float k, float st) {
  float acm = (ac + (mv - .5) * 7.) / sp;
  float li = floor(acm), lf = fract(acm) - .5;
  vec3 hl = wxHash33(vec3(li, k * 17., 3.));
  float hw = wd * mix(.5, 1.4, hl.y) / sp, fw = fwidth(acm);
  float line = 1. - smoothstep(hw - .5 * fw, hw + .7 * fw, abs(lf - (hl.x - .5) * .45));
  float sg = textureGrad(uFoamTex, vec2(al / 70. - uFoamW3.w + hl.z * 7., li * .137 + k), vec2(gq.x, 0.), vec2(gq.y, 0.)).g;
  float seg = smoothstep(.62 - .22 * st, .78 - .2 * st, sg);
  return mix(line * seg, 2. * hw * .5 * st, smoothstep(.2, .7, fw)) * mix(.55, 1., hl.z);
}
float ocnStreaks(vec2 xz, vec2 dX, vec2 dY, float st, float mvLo) {
  vec2 w = uStreak.xy, wp = vec2(-w.y, w.x);
  float al = dot(xz, w), ac = dot(xz, wp);
  vec2 gq = vec2(dot(dX, w), dot(dY, w)) / 70.;
  /* [r3] the lanes' meander: T3-T4 only. [r5] Below T3 the 21 m blotches already fetched (mvLo): round 4's lanes there
     ran dead straight and evenly spaced to the horizon, like rails (F's Intel T2 crop; REVIEW-4 B2, the long lanes) */
  float mv = mvLo;
  if (uSurfA.y > .5) mv = textureGrad(uFoamTex, vec2(al / 70. - uFoamW3.w, ac / 61.), vec2(gq.x, 0.), vec2(gq.y, 0.)).g;
  float l1 = ocnLane(al, ac, gq, mv, 4.5, .22, .31, st);
  return uSurfA.y > .5 ? max(l1, .55 * ocnLane(al, ac, gq, mv, 13., .5, .73, st)) : l1;   // [r2] the broad family at T3-T4 only
}
void main() {
  vec3 eye = vec3(0., wxEye, 0.);
  vec3 dv = vP - eye;
  float dist = length(dv);
  vec3 d = dv / dist, V = -d;
  vec2 uv = gl_FragCoord.xy * uRes.zw;
/*@lab*/  int dbg = int(uRefl4.z + .5);/*@end*/
  /* no water inside the ship's hull: the fragment turns fully transparent (no discard, so the cove's depth
     still rejects the sea behind it early) */
  bool hull = false;
  if (uShipB.w > .5) {
    vec2 rel = vP.xz - uShip.xz, f = vec2(sin(uShip.w), cos(uShip.w));
    vec2 lq = vec2(dot(rel, vec2(f.y, -f.x)) / uShipB.y, dot(rel, f) / uShipB.x);
    hull = dot(lq, lq) < .9;
  }
  if (hull) { o = vec4(0., 0., 0., 1.); return; }
/*@lab*/  if (dbg == 16) { o = vec4(vSwC.xyz, 0.); return; }/*@end*/       // lab: alpha 0, so the blend leaves the raw numbers
  vec4 sh = vSh;
  /* the water's depth under this fragment: the cove's surface behind it where there is one (it is the truth
     there), the shore field elsewhere; where neither shows a bed, at least the 4 m the cove draws down to */
  float zc = uRefl4.w > 0. ? wxSceneDist(uv) : 1e9, thick = zc - dist;
  bool cove = zc < 1e8;
  float zd = max(thick, 0.) * max(-d.y, .02);
  /* the bed's depth from the vertices; deeper where the shore field says land but the cove's surface lies
     well below this fragment (a coarse field), or where no bed is drawn at all (the cove draws it to 4 m) */
  float depth = cove ? (sh.y <= 0. && zd > .3 ? max(vMisc.x, min(zd, 4.)) : vMisc.x) : max(vMisc.x, uCoast.x > 0. ? 4. : vMisc.x);
/*@lab*/  if (uCut == 1.) { o = vec4(vec3(sh.x * 1e-6 + zc * 1e-9), 1.); return; }/*@end*/
  vec3 dmp = ocnDamp(depth);
  vec2 xz = vP0.xz, dX = dFdx(xz), dY = dFdy(xz), fwd = abs(dX) + abs(dY);
  float foot = max(fwd.x, fwd.y);
  /* [r2] the surf: how hard the bores break here (0 in deep water; ocnSwell). [r3] Per fragment, where the swell's
     readiness along its crests allows (ocnPeak) */
  /* [r5] the readiness stays per vertex: read per fragment where the grid is coarse (round 5's first form) it changed
     nothing to see at 85-96 % and cost Intel's SIMD8 compile its registers (spills) */
  float surf = vSwC.z, bB = surf, bN = surf;
  /* slopes and their variance (LEAN): the cascades' mips blur slopes into variance far away; and whitecaps */
  vec2 s = vSw.xy + vC0.xy, var = vec2(vSw.z) + vC0.zw;
  /* [r6] THE FAR SEA'S FLICKER (the user's report, on their own screen). The TAA's half-pixel jitter moved the point each
     pixel shades, and at a grazing view the mirror is a strong magnifier: a slope change of a few thousandths moves the
     reflected ray by pixels, so the sky's and the cove's images in the water jumped from frame to frame under a fixed
     pixel, and the resolve's history clip (the whole neighbourhood moves together) let it through. Measured on the
     dashboard (tests/ocean/r6/flick.cjs, Intel T2 at the user's 1920 x 1150 at DPR 1.33, the sea only): 2.3 % of the
     pixels 100-215 m out toggled by over 12 levels a frame, .28 % at 215-600 m; with the jitter off, .01 %. Now the
     water's slopes and the mirror's ray are those of the pixel's centre (the slopes moved back by the jitter along their
     screen gradients, the finer cascades read there, the camera's unjittered ray): its shading no longer moves with
     the jitter. The geometry still does, so the waves' silhouettes and the shore keep the TAA's antialiasing. With the
     vertices' long waves filtered wider (above): .32 % and .007 % */
  s += dFdx(s) * uTaa.x + dFdy(s) * uTaa.y;
  vec2 xzU = xz + dX * uTaa.x + dY * uTaa.y;
  float far0 = vMisc.z;
  /* [r3] how fresh the open sea's foam is (well over its threshold: a crest breaking now): solid and clumpy; old foam is a lace */
  float frO = smoothstep(uGth.x + .05, uGth.x + .35, vMisc.y) * dmp.x * (1. - far0);
  float noFoam = 1. - mix(wxSat((vMisc.y - mix(uGth.x, uGth.x * .45, surf)) / .1) * mix(.6, 1., wxSat(vMisc.y * 2.)),
                          mix(uGth.w * .5, .12, surf), far0) * max(dmp.x, surf);
  float crW = .7 * smoothstep(9., 14., uWindO.z);                       // [r4] the crests' share of the short whitecaps
  float cnS = .1 * smoothstep(.05, .4, uWx1.y);   // [r4] in rain the whitecaps' edge is softer (a wider lace margin)
  for (int i = 1; i < 3; i++) {
    if (float(i) >= uNC) break;
    float texel = uL[i] / float(textureSize(uDisp, 0).x);
    /* [r6] the fold is a blend over the footprints just short of it, not a switch: at the switch the cascade's resolved
       slope (its long waves, metres long) left the normal at once, so along the distance where a pixel's footprint
       crosses it (~350 m for cascade 1 at T2) the mirror jumped, and the TAA jitter moved that line by a pixel every frame:
       a row of thin dashes flickering under the cove's reflection (E's "bright dashes just under the horizon") */
    float fT = (i == 2 && uSurfA.y < .5 ? 5. : 10.) * texel, wk = 1. - smoothstep(.55 * fT, fT, foot);
    if (wk <= 0.) {                                                    // far below a pixel: its variance and its mean foam ([r3] below T3 cascade 2 from 5 texels)
      var += dmp[i] * dmp[i] * uMss[i];
      noFoam *= 1. - mix(uGth.w * (i == 1 ? .4 : .1), (i == 2 ? .05 : .12), surf) * (i == 2 ? .6 : 1.) * max(dmp[i], surf);
      continue;
    }
    vec3 q = vec3(ocnToLocal(xzU, i) / uL[i], float(i));
    vec4 t = texture(uSlope, q, i == 1 ? .25 : .5);                     // [r2] less bias than round 1 (+.5/+1): TAA settles the shimmer
    vec2 vl = max(t.zw - t.xy * t.xy, 0.);
    float co = uRc[i], si = uRs[i], w2 = dmp[i] * dmp[i];
    /* [r4] heavy rain damps the short waves (tenths of a metre to a metre: cascade 2) and roughens the surface below
       them: their resolved slopes go into the variance, so the storm's near water is a rough, softly lit surface,
       not a crumpled foil of sharp facets (REVIEW-3 B3; Rocky Creek, Shore Acres) */
    float kr = i == 2 ? 1. - .6 * uWx1.y * uWx1.y : 1.;
    s += wk * kr * dmp[i] * ocnToWorld(t.xy, i);
    var += wk * (w2 * vec2(co * co * vl.x + si * si * vl.y, si * si * vl.x + co * co * vl.y) + (1. - kr * kr) * w2 * uMss[i]) + (1. - wk) * w2 * uMss[i];
    /* the held compression above this cascade's threshold (lower in the surf zone), or, once its foam is
       smaller than a pixel, the fraction it covers on average */
    float g = -1.;                                                      // [r2] below T3 cascade 2 (a tenth of the whitecaps) gives its mean
    if (i < 2 || uSurfA.y > .5) g = texture(uDisp, q).w;               // [r3] an explicit branch: no fetch below T3
    float th = mix(uGth[i], uGth[i] * .45, surf), cn = smoothstep(th - .06 - cnS, th + .16 + cnS, g) * mix(.6, 1., wxSat(g * 2.));   // [r2] soft: old foam thins
    /* [r4] from a fresh breeze the short waves break on the long ones' crests (hydrodynamic modulation): their
       whitecaps gather in bands along the swell and the wind sea's crests instead of an even confetti of flecks
       (REVIEW-3 B3, x06 at 80 %); the mean over a wave is about kept */
    cn *= mix(1., 2.6 * smoothstep(-.2, .45, vSwC.w), crW);
    float farW = smoothstep(1.5, 6., foot / texel);
    if (g >= 0.) frO = max(frO, smoothstep(th + .05, th + .35, g) * dmp[i] * (1. - farW) * (i == 2 ? .35 : 1.));   // [r4] the short waves' whitecaps stay lace, not solid pebbles
    float frac = mix(uGth.w * (i == 1 ? .4 : .1), (i == 2 ? .05 : .12), surf);
    noFoam *= 1. - mix(cn, frac, g < 0. ? 1. : farW) * (i == 2 ? .6 : 1.) * max(dmp[i], surf);
  }
/*@lab*/  if (uCut == 2.) { o = vec4(vec3(s, noFoam) * 1e-3, 1.); return; }/*@end*/
  var += uSea.y + .004 * smoothstep(2., 20., uWindO.z) * wxSat(depth);   // capillaries; the gusts roughen at once
  var = max(var, vec2(2e-5));
  vec3 n = normalize(vec3(-s.x, 1., -s.y));
  float nv = max(dot(n, V), 0.);
  float sv = sqrt(.5 * (var.x + var.y));
  float F = ocnFresnel(nv, sv);
  /* the sky and the clouds as rendered, mirrored, with the cove's mirror image over them */
  vec3 r = reflect(wxRay0(uv), n); r.y = abs(r.y) + 1e-4; r = normalize(r);   // [r6] the pixel centre's ray
  vec2 ruv = wxUV(r);
  float lod = .5 * log2(1. + 4000. * (var.x + var.y) * .5);
  /* off the screen (steep facets near the window) the reflection leaves REFL: its edge, fading to the sky's
     mean radiance above (wxAmbient). No wxSky here: its two LUTs would take the program past 16 samplers */
  vec3 skyMean = textureLod(sRefl, vec2(.5, .8), uRefl4.x).rgb;      // one hot texel for every fragment
  vec2 ovr = max(max(-ruv, ruv - 1.), 0.);
  float over = ruv.x < -.9 && ruv.y < -.9 ? 1. : smoothstep(0., .45, max(ovr.x, ovr.y));
  vec3 sky = mix(textureLod(sRefl, clamp(ruv, vec2(.002), vec2(.998)), lod).rgb, vAmb.rgb, over);
  sky = min(sky, vec3(60. * wxLuma(skyMean) + 1e-6));                   // the sun's disc is the glint's, not the mirror's
  /* [r3 close] REFL holds no sun disc since A's round 3 (sky.refl takes it out of each tap), so the mirror needs no
     cap round the disc's image (round 2-3's cap: 3 more REFL fetches near the sun). The glint draws the sun */
  /* [r6] the static cove in the mirror is relit from F's cache, which was drawn with the jitter of the frame that baked
     it (coast.js cacheJ), not with this frame's: through wxUV its image moved by the difference, a different one every
     frame. Without the jitter (wxUV0) it is off by the bake's fixed half pixel at most and holds still (a small share of
     the flicker measured; the ship, drawn into the mirror on its own frames, still moves by its frame's jitter) */
  vec2 cuv = wxUV0(vec3(r.x, -r.y, r.z));
  vec4 cr = wxCoastRefl(clamp(cuv, 0., 1.), max(lod + uRefl4.y, 0.));
  /* [r3] a light in the cove's low-resolution mirror would read as a block: the lights lay their own streaks (the
     glints below), so the mirror keeps the cove at no more than a few times the sky's mean */
  cr.rgb = min(cr.rgb, vec3(mix(1.2, 6., smoothstep(-.1, .05, uSun.y)) * wxLuma(skyMean) * cr.a + 1e-6));   // 6x by day (sunlit rock), 1.2x at night
  vec3 refl = sky * (1. - cr.a) + cr.rgb;
  /* sparkle: the sub-pixel facets that catch the light, two scrolling layers of sparse points (mean 1),
     which the mips smooth into the even glitter of the far path */
/*@lab*/  if (uCut == 3.) { o = vec4(refl * 1e-3, 1.); return; }/*@end*/
  /* the sun and the moon on the water */
  /* [r3] beyond a few hundred metres (where the glitter path runs out to the horizon) not the shadow map's texel: the
     map's blocks under a fast-changing deck flickered the far glint (the 60-97 % build-up clip). [r3 close] Nor the map's
     mean over its 48 km: under a storm with open sky beyond its edge that mean lit the whole far glint (a white slab
     under the ship at x12). The map at mip 3 (1.5 km cells, bilinear) at this point of the sea: the deck's real
     shape, smooth in space and time. (At sea level the map's lookup is the point itself; A's square, clouds lib) */
  vec2 shUV = clamp((xz * 1e-3 - CLD_SH_C) / CLD_SH_SIZE + .5, vec2(0.), vec2(1.));
  float cs = mix(vAmb.a, textureLod(sCShadow, shUV, 3.).r, smoothstep(250., 1500., dist)), ss = vRun.y;
  bool sunKey = dot(uKey.xyz, uSun.xyz) > .9999;
  /* [r2] the moon through the deck: the cloud shadow when it is the key light, else the deck's mean; no floor,
     so a sea under an overcast carries no moon path */
  vec3 sunE = vSunE.rgb * cs * (sunKey ? ss : 1.), moonE = vec3(.94, .97, 1.) * vSunE.a * (sunKey ? (uSun.y < .05 ? wxCloudShadowMean() : 0.) : cs * ss);
  vec3 glint = vec3(0.);
  /* [r2] skipped where the deck leaves the sun under 2 % of the sky's light (a storm: a wide cone, nothing to see) */
  float pkL = 0.;                                                       // [r4] the sun's or the moon's slope density here
  /* [r4] the gate fades in over 2-8 % (round 3 switched at 2 %): under the far glitter's ceiling a glint is about as
     bright at 3 % as at 100 %, so a deck whose shadow map steps across the gate would switch the path in one frame */
  float sunR = wxLuma(sunE) / max(wxLuma(skyMean), 1e-12), gate = smoothstep(.02, .08, sunR);
  if (uSun.y > -.03 && gate > 0. && dot(r, uSun.xyz) > cos(min(16. * sqrt(max(var.x, var.y)) + .02, 3.))) { vec2 gp = ocnGlintPk(uSun.xyz, V, n, var + uSun.w * uSun.w * .25); glint += sunE * gp.x; pkL = gp.y * gate; }
  if (uMoon.y > -.03 && uSun.y < .05) { vec2 gp = ocnGlintPk(uMoon.xyz, V, n, var + uMoon.w * uMoon.w * .25); glint += moonE * gp.x; pkL = max(pkL, gp.y); }
  /* the night lights (R.coast.lamps), glinted as the moon is: each lays a broken streak down the water. [r3] A
     streak is the glints of single wave facets, not an even lobe: a coarse sparkle (cells of about 2 px across,
     world-anchored, scrolling) breaks it into short horizontal dashes, and a soft ceiling per pixel keeps its
     brightest part from one saturated block (F, notes/scenery.md round 3, against a harbour at night) */
  vec3 lampG = vec3(0.);
  for (int k = 0; k < 4; k++) {
    vec4 lp = uLamp[k];
    if (lp.w <= 0.) continue;
    vec3 lv = lp.xyz - vP; float l2 = dot(lv, lv);
    lampG += vec3(1., .78, .52) * (lp.w * uExpo.x / l2) * ocnGlint(lv * inversesqrt(l2), V, n, var + .02 / l2);
  }
  if (max(lampG.r, max(lampG.g, lampG.b)) > 1e-4) {
    float T = 512. * max(fwd.x, .02);
    float sp = textureLod(uFoamTex, xz / T + vec2(1., 2.) * uStreak.w, 0.).a;
    lampG *= mix(1., sp / .075, .9);
    /* about white on the display: the dashes keep their gaps. [r7] The ceiling on the luminance, not per channel: per
       channel it bleached every streak toward white (C, round 5: an oil lantern's streak should carry its orange,
       vrsar-night), and the lighthouse's path lost the accent it is there to show */
    float lgL = wxLuma(lampG);
    lampG *= lgL > 1e-9 ? 1.4 * (1. - exp(-lgL / 1.4)) / lgL : 0.;
  }
  /* sparkle: the sub-pixel facets that catch the light, two scrolling layers of sparse points (mean 1),
     which the mips smooth into the even glitter of the far path; looked up only where there is a glint */
  if (max(glint.r, max(glint.g, glint.b)) > 1e-3 * wxLuma(skyMean) + 1e-12) {
    /* [r4 close] every term below is the glint times a number, so only that number is carried (round 4's first form kept
       three colours alive here: the sea's shader spilled registers on Intel, +1.6-2.2 ms at T1, notes/ocean.md) */
    float wf = smoothstep(.4, 1.1, foot), kN = 1.;
    if (wf < 1.) {                                                       // [r4] the sparkle only where the far glitter does not replace it
      vec2 su = xz / .83 + vec2(1., 2.) * uStreak.w, sv2 = xz / .61 + vec2(-2., 1.) * uFoamW.w;
      float a1 = textureGrad(uFoamTex, su, dX / .83, dY / .83).a, a2 = textureGrad(uFoamTex, sv2.yx, dX.yx / .61, dY.yx / .61).a;
      kN = mix(1., a1 * a2 / (.075 * .075), uFoamW.z);
    }
    /* [r4] THE FAR GLITTER. Past ~150 m the wind sea is folded into the variance (its waves are under a pixel), so the
       lobe there is smooth, and under the moon or a low sun it is tens of times the display's white: round 3's slab, a
       saturated rectangle from the horizon down (REVIEW-3 B1; round 2's ocean.js gives the same slab under the
       present exposure, tests/ocean/r4 bisect). A glitter path is single facets catching the light: their density
       follows the slope density (pkL, the lobe's shape whatever the light's strength, so the path is narrow at the
       horizon and widens toward the window), and each glint is about as bright as the display allows. So past the
       fold: cells 2 px wide and 1 px tall (a facet at a grazing view), each lit at random with a probability from
       the density, rows of crests a little denser or sparser in turn; a lit glint carries the lobe's energy over
       that probability under a soft ceiling, and lives ~0.4 s (2.5 per second, 2560 per 1024 s: the sea's loop).
       Between the glints a dim sheen that also follows the density, never over ~205/255. Screen cells: the camera
       never moves, and at kilometres the sea's own motion is under a pixel a second */
    if (wf > 0.) {
      /* [r6] cells about 2 x 1 DEVICE px (E): at the user's T1 a render pixel is ~2 x 2 device px, and the 2 x 1 render-px
         cells were 4 x 2 on their panel, twice the grain anyone had judged */
      vec2 cq = floor(gl_FragCoord.xy * vec2(1. / max(1., floor(2. * uCss.w + .5)), 1.));
      vec3 hc = wxHash33(vec3(cq, 3.));
      float tq = uTime.x * (820. / 1024.) + hc.x, ep = floor(tq), fe = tq - ep;   // [r6] ~1.25 s a glint (round 5: .4 s), 820 per 1024 s
      float tr = uTime.x + hc.z, er = floor(tr);
      /* the row's density for this second and the next (a scalar hash of the row and the second: one lane, not three) */
      uvec2 rh = (uint(cq.y) * 747796405u + uvec2(uint(mod(er, 1024.)), uint(mod(er + 1., 1024.))) * 2891336453u) ^ 0x9e3779b9u;
      rh = ((rh >> ((rh >> 28u) + 4u)) ^ rh) * 277803737u; rh ^= rh >> 22u;
      float row = mix(float(rh.x), float(rh.y), smoothstep(.6, 1., tr - er)) * (1. / 4294967296.);
      float pr = .35 * pkL * mix(.15, 1.85, row * row * (3. - 2. * row));
      float on = step(wxHash33(vec3(cq, mod(ep, 820.) + 7.)).y, pr) * 2. * sin(PI * fe) * sin(PI * fe);   // mean pr
      /* [r6] a steadier path (the user: the far sea flickered): half the light in the sheen, the glints softer and slower
         (round 5: .7 of it in glints near the display's white, each living .4 s, a 2.5-5 Hz twinkle all over the path) */
      float lum = wxLuma(glint), g0 = .5 * on / max(pr, 1e-4), Lg = lum * g0, Lb = lum * .5, Bc = 1.5 * pkL;
      g0 *= Lg > 1e-9 ? 3. * (1. - exp(-Lg / 3.)) / Lg : 0.;            // the glint under a soft ceiling
      g0 += Lb > Bc ? .5 * Bc / Lb : .5;                                 // the sheen
      kN = mix(kN, g0, wf);
    }
    glint *= kN;
    /* [r5] no glint is brighter than the sun's disc as the sky draws it (REVIEW-4 #2, §6.1: at a 0.25 deg sun A holds the
       disc near the sky's level so that it keeps its hue, and the glitter column, at the display's white, ran up to no
       sun). A facet reflects the disc at Fresnel ~.85 at these grazing angles; the disc is read back from A's own
       wxSunDisc (the disc probe below), so the column follows whatever A draws */
    float gL = wxLuma(glint), gC = .85 * uGlintCap * uExpo.x;
    if (gL > gC) glint *= gC / gL;
  }
  glint += lampG;
/*@lab*/  if (uCut == 4.) { o = vec4(glint * 1e-3, 1.); return; }/*@end*/
  /* lightning: [1.2] the contract's one light for every receiver (wxFlash: the lit patch of cloud, exposure-
     normalised), its envelope only (never the restrikes) */
  vec3 flashE = vec3(0.);
  for (int k = 0; k < 2; k++) {
    vec4 f = wxFlash(k, vP);
    if (f.w <= 0.) continue;
    vec3 E = WX_FLASH_RGB * f.w;
    glint += E * ocnGlint(f.xyz, V, n, var + .05);
    flashE += E * max(f.y, 0.);
  }
  glint = min(glint, vec3(3000. * uExpo.x));
  /* the water body: light scattered back out of the deep, lit by the sun, the moon, the sky above */
  /* [r3] bluer than round 2's (.0025, .014, .022), which read turquoise at noon: an Atlantic coast's water */
  vec3 rho = vec3(.0016, .0095, .021);
  /* [r3] a storm churns sand and bubbles through the bay: grey-green water some times brighter than the clear sea's (the
     Rocky Creek and Shore Acres photographs: the water between the foam is a light slate, not black) */
  rho = mix(rho, vec3(.04, .058, .062), .85 * uWx2.w);   // [r4] lighter: a slate, not near black
  vec3 Ein = sunE * max(uSun.y, 0.) + moonE * max(uMoon.y, 0.) + PI * vAmb.rgb + flashE;
  vec3 body = (1. - F) * rho * Ein / PI;
  /* [r2] the shallow bay's floor through the water where the cove draws no bed (it draws to -2.2 m), seen down and
     back up through coastal water (Kd per m), so the near water has a body, gone below about 10 m; a storm's churned
     water (uWx2.w) hides it. [r3] A rocky floor: weed and rock (albedo .025) with patches of sand (.10) tens of
     metres across, so the shallows are dark blue-green with lighter patches, not an even teal */
  if (!cove && uCoast.x > 0. && vMisc.x < 12. && uWx2.w < .6) {        // [r3] a storm's churned water hides it: skipped
    float dB = max(vMisc.x, 2.2), ct = sqrt(max(1. - (1. - nv * nv) / 1.769, .05));
    vec3 Kd = vec3(.45, .15, .19) * (1. + 4. * uWx2.w + 2. * uWx1.y);
    float bedA = mix(.025, .10, smoothstep(.35, .75, textureLod(uFoamTex, xz / 97. + .21, max(log2(foot * 2.64), 2.5)).g));   // trilinear: no anisotropy for a 20-60 m pattern
    body += (1. - F) * bedA * exp(-Kd * dB * (1. / ct + 1.15)) * Ein / PI * smoothstep(12., 8., vMisc.x) * smoothstep(2.2, 2.8, vMisc.x);
  }
  /* crests glow green-teal when we look toward a low sun (Atlas, GDC 2019) */
  float hgt = vSwC.w;
  vec3 sss = vec3(.10, .42, .36) * 8. * rho * max(hgt, 0.) * pow(wxSat(.8 * dot(d, uSun.xyz) + .2), 4.) * (1. - nv) * (1. - nv) * 3. * sunE / PI;
  /* [r3] the water's colour so far, folded now, so only three colours stay alive through the foam below (on Intel the
     shader's live state, not its arithmetic, set the cost: tests/ocean/r3/ab.sh). The shallows: the bed and the cove's
     feet show through (F shades them through still water; this is the grey half) */
  float Tw = cove ? exp(-.35 * max(thick, 0.)) : 0.;
  vec3 cw = refl * F + glint + body * (1. - Tw) + sss;
  vec3 bubC = (1. - F) * vec3(.02, .07, .075) * Ein / PI * (1. - Tw);  // aerated water under and around the foam: bubbles light the body turquoise
  /* foam is lit by the sun, the moon, the sky and lightning */
  /* [r4] the sky light on foam: under a storm deck with a bright band beyond its edge, the ambient alone left foam
     1.3-2 times the water (measured, x12 rows 700-1020) where the water mirrors that band: a grey film, no streaks
     (the Rocky Creek and Shore Acres foam sits over their sky's level). Foam is a thick scattering layer that sees
     the same sky the water mirrors, from every side: in rain it takes at least 0.6 of the mirrored sky here (the
     water's own mirror is F ~ .1-.3 of it). [r4 close] Not the mirror's mean sky as well: it was under the ambient
     where measured, and keeping it alive as a colour to here made the shader spill registers on Intel (SIMD8 52 spills,
     +1.6-2.2 ms at T1; tests/ocean/r4/simd.cjs) */
  vec3 ambF = max(vAmb.rgb, .6 * smoothstep(.15, .5, uWx1.y) * refl);
  vec3 foamLt = .98 * ((sunE * max(dot(n, uSun.xyz), 0.) + moonE * max(dot(n, uMoon.xyz), 0.) + flashE) / PI + ambF * (.85 + .15 * n.y));
  float alpha = (1. - F) * Tw;
/*@lab*/  if (dbg == 11) { o = vec4(depth, vSw.w, vMisc.w, 0.); return; }         // lab: raw numbers, read back from SCENE (tests/ocean/r2/probe.js)
  if (dbg == 12) { o = vec4(s, dist, 0.); return; }
  if (dbg == 14) { o = vec4(glint, 0.) / uExpo.x; return; }                // lab: the glints alone, rel
  if (dbg == 15) { o = vec4(refl * F, 0.) / uExpo.x; return; }             // lab: the mirror alone, rel
  if (dbg == 13) { o = vec4(wxLuma(vAmb.rgb), wxLuma(skyMean), wxLuma(textureLod(sRefl, vec2(.5, .47), 2.).rgb), 0.) / uExpo.x; return; }   // lab: the light, rel
  if (dbg == 1 || dbg == 2 || dbg == 4 || dbg == 5) {
    o = vec4(dbg == 1 ? vec3(.5 + .5 * hgt) : dbg == 2 ? vec3(var * 20., (var.x + var.y) * 10.) : dbg == 4 ? n * .5 + .5 : vec3(wxSat(sh.x / 50.), wxSat(depth / 20.), sh.z), 0.);
    return;
  }/*@end*/
  /* foam. Whitecaps (above). [r2] The surf: every bore breaks along its crest line, with a roller of white water
     on its front face (the whole face once it is a broken bore) and a sheet behind it that thins to a lace and
     patches; where the bores are under a few pixels it fades to its mean. The wash at the cove's feet; the
     swash's edge and the lace its backwash leaves */
  /* [r5] the bore's phase at this fragment (the vertices' unwrapped linear phase), and its profile (the crest ahead of
     the trough, as ocnSwell draws it); the cycles across a pixel say whether the bore is resolved here. Read here, where
     it is used */
  float cyc = vSwC.x, thc = 2. * PI * fract(cyc), sgc = vSwC.y, yc = cos(thc);
  for (int j = 0; j < 3; j++) yc = cos(thc + sgc * yc);
  float age = fract((thc + sgc * yc) / (2. * PI));                    // 0 as the crest passes, rising behind it; the front face is .5..1
  float res = 1. - smoothstep(.5, 1.5, min(2. * PI * fwidth(cyc), 4.));   // the bore's phase across a pixel: resolved or aliasing
  float crest = smoothstep(-.05, .35, hgt);                            // near the composite wave's top
  float energy = wxSat((vSw.w + .5 * vMisc.w) / 3.), eC = wxSat((energy - .15) / .65);
  float farP = smoothstep(.04, .5, length(fwd) / ${FOAM_TILE[0].toFixed(1)});
  bool patB = farP < .999;                                              // [r3] the pattern branch below draws the surf itself
  float film = 0., shoreF = patB ? 0. : ocnSurf(age, bB, bN, res, eC, 0.);
  if (cove || vRun.w > 0.) {
    /* [r2] the waterline per pixel (bilinear, not the grid's triangles), its edge broken by the lace's noise, so the
       swash and the wash at a ledge never follow the shore field's texels or the grid as polygons */
    if (vRun.w > 0.) sh.x = wxShore(xz).x + (textureGrad(uFoamTex, (xz - uDrift2.xy) / 9., dX / 9., dY / 9.).r - .45) * 1.6;
    float cBand = .2 + 1.3 * energy + 4. * uWx2.w;
    /* [r3] and only where the bed is near the surface (zd, vertical): a shelf a metre or two down, seen at a grazing
       angle, is thin along the ray but no wash covers it (round 2 foamed it whole, up to a hard edge where its mesh ends) */
    float contact = cove ? (1. - smoothstep(0., cBand, thick)) * (1. - smoothstep(.1, .3 + .6 * energy + 1.5 * uWx2.w, zd))
                         * wxSat(eC * eC * sh.w * 1.5 + .3 * sh.w + .9 * uWx2.w * mix(.3, 1., smoothstep(.05, .5, surf))) * mix(.4, 1., exp(-age * 2.5)) : 0.;
    /* [r3] a thin ring even in a calm; in a storm the wash over a reef follows where its crests break (no even line) */
    float yl = vP.y - max(thick, 0.) * max(-d.y, 0.);                   // the cove's height under this fragment
    float under = vRun.x * vRun.w - yl;                                 // water over the shore now, m
    /* the swash's film above a shore that is dry now; only where the view is steep enough (within about 170 m)
       for the height under the fragment to be read from the cove's distance */
    film = cove && under <= 0. && sh.x < 2. && vRun.w > .3 && -d.y > .08 ? 1. : 0.;
    float lace = vRun.w * smoothstep(.0, .4, vRun.z - .3) * (1. - vRun.z) * smoothstep(1.6, .4, sh.x) * eC;
    float edgeF = vRun.w * exp(-abs(under) * 6.) * smoothstep(.0, .2, vRun.x) * wxSat(eC * 1.5 + .15);
    shoreF = max(contact, max(shoreF, max(edgeF * .8, lace * film)));
  }
  /* [r2] whitecaps in a light wind are rare, thin and short-lived: translucent, never opaque discs */
  float fOpen = (1. - noFoam) * mix(.5, 1., smoothstep(6., 12., uWindO.z));
  shoreF *= uRefl4.w;
  float fsum = 1. - (1. - fOpen) * (1. - shoreF);
  /* the pattern: fresh foam is solid, old foam a lace; far away only the coverage counts (explicit gradients:
     the lookups sit in a branch) */
  float pat = .5, cov = fsum * .8 * wxSat(uFoamW.x), clump = .5, edgeS = 1.;
  /* [r2] the wind's streaks (Beaufort 8 and up): the old foam combed out along the wind, tens of metres long and
     a metre or two across, in bands that wander; their mean far away */
  float strk = uFoamW.y * uFoamW.y * .08;                              // the streaks' mean far away
  if ((fsum > .01 || uFoamW.y > 0. || surf > .002) && patB) {
    vec2 fuv2 = (xz - uDrift2.xy) / ${FOAM_TILE[1].toFixed(1)};
    vec4 f21 = textureGrad(uFoamTex, fuv2 + .37, dX / ${FOAM_TILE[1].toFixed(1)}, dY / ${FOAM_TILE[1].toFixed(1)});   // [r2] one fetch: lace and clumps
    pat = f21.r;
    if (uSurfA.y > .5 || foot < .08) {                                 // [r3] below T3 the 7 m lace only near the window, where a pixel resolves it
      /* [r4] the aged foam combed along the wind: the 7 m lace twice as long along z (the wind's axis within 20 deg;
         14 m divides the 840 m drift, so no seam at its wrap). Seen from 14 m the z axis is foreshortened 5-10 times, so
         the lace's cells read rounder on screen, and torn into threads along the wind near the window. One fetch at
         every reading (round 4's first cross-fade by the rain, two fetches, cost Intel T1 ~.3 ms with the streaks' threads) */
      vec2 k7 = vec2(${FOAM_TILE[0].toFixed(1)}, ${(2 * FOAM_TILE[0]).toFixed(1)});
      pat = mix(textureGrad(uFoamTex, (xz - uDrift2.xy) / k7 + .19, dX / k7, dY / k7).r, f21.r, .4);
    }
    clump = f21.b;                                                     // the 21 m tile: clumps 0.7-3.5 m
    /* [r2] a bore's fresh white water travels with it: its clumps are read in the swell's frame, scrolled shoreward
       at the bores' speed (the open sea's foam and the surf's old residue keep the slow drift) */
    float fresh = max(bN * smoothstep(.7, .9, age), bB * (1. - smoothstep(.0, .2, age)));
    if (fresh > .02 && uSurfA.y > .5) {
      vec2 sd = uSw[0].xy, sq = vec2(sd.y, -sd.x);
      vec2 qa = vec2(dot(xz, sd) / ${FOAM_TILE[1].toFixed(1)} - uSurfA.x, dot(xz, sq) / ${FOAM_TILE[1].toFixed(1)});
      vec2 gx = vec2(dot(dX, sd), dot(dX, sq)) / ${FOAM_TILE[1].toFixed(1)}, gy = vec2(dot(dY, sd), dot(dY, sq)) / ${FOAM_TILE[1].toFixed(1)};
      vec4 fa = textureGrad(uFoamTex, qa + .53, gx, gy);
      clump = mix(clump, fa.b, fresh); pat = mix(pat, fa.r, .6 * fresh);
    }
    /* old foam gathers in patches tens of metres across, and thins between them */
    float pch = f21.g;                                                 // [r3] the 21 m tile's blotches (round 2 fetched a 42 m tile)
    /* the roller's edge is ragged, and a crest line breaks harder in some places than in others */
    if (surf > .002) {
      /* [r3] and a bore's front wanders a few metres along the line */
      float wig = ((pat - .5) * .09 + (ocnN1(dot(xz, vec2(-uSw[0].y, uSw[0].x)) / 19., 9.) - .5) * .07) * res, pm = mix(.75, 1.15, pch);
      shoreF = max(shoreF, ocnSurf(age + wig, bB * pm, bN * pm, res, eC, smoothstep(2., 3.6, uWx2.y) * (1. - smoothstep(.25, 1., foot))) * uRefl4.w);
    }
    /* only the open water's foam gathers in patches; the wash at the rocks and the breakers stay whole */
    fsum = 1. - (1. - fOpen * mix(.45, 1.25, pch) * mix(1., .55 + .45 * crest, surf)) * (1. - shoreF);
    float thickF = smoothstep(.3, .9, fsum);
    /* [r2] the surf's blanket is blotches with dark holes (the clumps), the open sea's old foam a lace (the walls) */
    float pz = mix(pat, clump * 1.1 - .05, .85 * wxSat(fresh * 1.6 + frO * .7));   // [r3] only fresh white water (surf, a breaking whitecap) tumbles; the rest is lace
    /* [r7] CHURNED, NOT CUT OUT (REVIEW-6 #3: near the window the whitecaps and the surf's sheet were white shapes with
       clean outlines, like paper on the water). Where a pixel is under ~20 cm, a finer layer (the lace at a 2.1 x 4.2 m
       tile, drawn out along the wind's axis; both divide the 840 m drift) breaks every edge into a bubbly fringe of
       threads and holes and pits the body, as the photographs' foam is at that range (waves-rocks, rocky-creek) */
    float nearW = (1. - smoothstep(.06, .25, foot)) * (1. - farP), fd = .5;
    if (nearW > 0.) fd = textureGrad(uFoamTex, (xz - uDrift2.xy) / vec2(2.1, 4.2) + .71, dX / vec2(2.1, 4.2), dY / vec2(2.1, 4.2)).r;
    pz += (fd - .4) * .32 * nearW;
    /* [r3] the pattern's edge as sharp as the pixel allows: near the window foam has crisp edges, not a soft ramp */
    float rw = clamp(length(fwd) * .9, .1, .2 + .2 * fsum);
    rw += .18 * uWx1.y;                                                // [r4] in rain foam has a soft, bubbly edge: no decals
    /* fresh, thick foam closes its holes; [r7] near the window the fine layer frays its outline and opens a few bubbly
       holes in it (a fresh whitecap there was a white pebble with a clean outline, REVIEW-6 #3) */
    float covNear = max(smoothstep(1. - fsum, 1. - fsum + rw, pz) * mix(.55, 1., thickF), smoothstep(.8, 1., fsum + (fd - .52) * .45 * nearW));
    covNear *= mix(.78, 1., max(thickF, fresh));                       // [r3] a whitecap's thin edge shows the bubbly water through it
    /* [r4] foam has thickness: its thin margin is a grey film of bubbles over the water, its middle a heaped white */
    edgeS = mix(.62, 1.05, smoothstep(0., .3 + .2 * thickF, pz - (1. - fsum)));
    /* [r7] in big surf the surf zone's foam is fresh white water: the thin lace's greying lifts; and the fine layer's pits
       and ridges near the window. Both folded into edgeS here, so nothing new stays alive past this branch (the sea's
       shader sits at the edge of Intel's SIMD8 registers: 0 spills in round 6) */
    edgeS = mix(edgeS, max(edgeS, .92), smoothstep(2., 3.6, uWx2.y) * (1. - smoothstep(.25, 1., foot)) * wxSat(shoreF * 1.6)) * mix(1., .8 + .36 * fd, nearW);
    cov = mix(covNear, fsum * .8, farP);
    if (uFoamW.y > 0.) {
      float st = uFoamW.y;
      strk = wxSat(1.5 * st) * ocnStreaks(xz, dX, dY, st, pch) * mix(.6, 1.15, pch);   // [r4] whiter: a streak's foam is fresh enough to be white
      /* [r5] a lane is combed foam, not a ribbon: the lace tears it into threads and flecks along its length */
      strk *= smoothstep(.22, .62, pat);
      cov = max(cov, strk);
    }
    cov = wxSat(cov * uFoamW.x);
  } else cov = max(cov, strk);
  fsum = max(fsum, strk);
/*@lab*/  if (uCut == 5.) { o = vec4(vec3(cov * 1e-3), 1.); return; }/*@end*/
  float bub = wxSat(fsum * 1.6) * (1. - cov);
  /* its lace's ridges catch more light than its holes */
  vec3 foamL = foamLt * mix(.85, 1.15, smoothstep(.6, 1., fsum));    // [r3] fresh white water near the albedo of snow (.98), whiter than aged lace                 // [r2] fresh thick foam is whiter than a thin aged lace
  /* [r7] UNDER AN OVERCAST, WHITE WATER IS AS BRIGHT AS THE LOW SKY (rocky-creek: its surf 1.1-1.2 x the sky round it; the
     bursts here take the low sky behind them since round 5, F). Lit by the deck's irradiance alone, the sea's foam at
     96-100 % was 0.35-0.4 x the horizon's radiance, as dark as the water a little off it: the surf zone the probes found
     covered (dbg 17) read as dark water near the window. Thick white water is a scattering volume that the bright low sky
     lights through its edges and tops: at least the low sky x .72 (thin) to 1.08 (thick, fresh), as rain closes the deck
     (precip .1 -> .5, from the floor). The low sky is REFL's band 4 deg up over the open sea between the heads (the view's
     middle, lod 5): REFL holds the clear sky behind the cliffs where the cloud buffer's taps are the cove's, so a lookup
     in each pixel's own column lit the foam under the left head as if under a gap in the deck (a bright band) */
  float ovc = smoothstep(.1, .5, uWx1.y);
  if (ovc > 0. && cov > .004) {
    vec3 Lh = textureLod(sRefl, clamp(wxUV0(vec3(0., .0698, .9976)), vec2(.02), vec2(.98)), 5.).rgb;
    foamL = max(foamL, Lh * ovc * mix(.72, 1.08, smoothstep(.45, .95, fsum)));
  }
  /* [r2] thick white water is a tumbling mass: its clumps' tops catch the sky and the gaps between them are grey;
     on a bore's front the roller faces away from the bright zenith, darker down toward its toe */
  float thk = smoothstep(.55, .95, fsum);
  float rollS = bN > .002 && age > .5 ? mix(.62, 1.04, smoothstep(.72, .99, age)) : 1.;
  /* [r3] thick white water is white with small dark pits, not grey clouds: the clumps shade it less, the lace's holes pit it */
  foamL *= mix(mix(mix(.78, 1.08, pat), mix(.62, 1.18, clump * clump * (3. - 2. * clump)) * mix(.82, 1.04, smoothstep(.15, .45, pat)), thk) * mix(1., rollS, bN) * edgeS, 1., farP);
  vec3 c = cw + bubC * bub;
/*@lab*/  if (dbg == 17) { o = vec4(wxLuma(foamL) / uExpo.x, wxLuma(c) / uExpo.x, cov, 0.); return; }   // lab: foam and water luma (rel), coverage (alpha 0: raw)/*@end*/
  if (film > .5) { c = vec3(0.); alpha = 1.; }                         // a dry shore under the swash's film: only foam
  c = mix(c, foamL, cov);
  alpha *= 1. - cov;
/*@lab*/  if (dbg == 10) { o = vec4(surf, age, res, 0.); return; }                // lab: the bores (breaking, phase age, resolved)
  if (dbg > 0 && dbg < 9) {                                               // [r3] 1, 2, 4, 5 return above (so n and var die early)
    float open = (1. - step(sh.x, 150.)) * (1. - far0) * (1. - surf);
    vec3 v = dbg == 3 ? vec3(cov) : dbg == 6 ? vec3(alpha, Tw, F) :
             dbg == 7 ? vec3(step(.5, cov) * open, open, surf) :
             vec3(cov, .5 + .5 * (step(-.5, sh.x) - step(3., sh.x)) * step(.5, sh.w) * (cove ? 1. : 0.), .5 + .5 * (1. - step(sh.x, 150.)));   // 8: coverage, the rocks' 3 m band (1, else .5), the open sea (1, else .5)
    o = vec4(v, 0.); return;
  }/*@end*/
/*@lab*/  if (uCut == 6.) { o = vec4(c * 1e-3, 1.); return; }/*@end*/
  /* spray haze, blown off the crests above 15 m/s: an exponential layer (30 m) between the eye and the water,
     its density carried along the wind */
  if (vHaze.a > 0.) { c = c * (1. - vHaze.a) + vHaze.rgb * (1. - alpha); alpha *= 1. - vHaze.a; }   // [r2] per vertex
  /* the air in front, then the medium of the rain shafts (the cloud buffer's sea pixels) */
  vec4 cl = uWx1.y > 1e-3 ? wxCloudAt(uv) : vec4(0., 0., 0., 1.);
  vec4 ap = vAP;
  ap.a = exp(-vAP.a * dist * 1e-3); ap.rgb *= 1. - ap.a;   // [r4] the air at this fragment's own distance
  vec3 L = (c * ap.a + ap.rgb * (1. - alpha)) * cl.a + cl.rgb * (1. - alpha);
/*@lab*/  if (dbg == 9) { bool bad = any(isnan(L)) || any(isinf(L)) || isnan(alpha); o = vec4(bad ? 1. : 0., 0., .02, 0.); return; }/*@end*/
  o = vec4(wxGuard(L), alpha);
}`;

  /* ── 6. spray on the rocks in storms: when the swell's crest arrives at a rock it throws up a fan of white water.
     [r4, F's proposal, against ref/F/splash-spray, big-splash, waves-rocks: round 3's bursts read as grey smoke, round
     translucent droplet clouds that grew and drifted for 5 s] Each part is a jet: a column standing on the rock's face,
     its head thrown up and a little toward the shore within a fan of +-25 deg, slowed by the air and falling back.
     The column is opaque white water while it rises (its strength sets the height, not the opacity), breaks into
     clumps from the peak and into droplets as it falls, its foot leaving the rock, and is gone by 2.6 s. One part a
     burst is the mist the jets leave, faint and short. Billboards along each jet's own direction on screen ── */
  const SPRAY_VS = `
layout(location = 0) in vec2 aPos;
uniform vec4 uSpray[32];
uniform float uParts;
out vec2 vQ; out float vA; out vec3 vL; out vec3 vAp; out vec4 vCl; flat out vec3 vSeed;   // vSeed.z: the jet's density 1..0 (-1 the mist)
void main() {
  int id = gl_InstanceID, pi = id / int(uParts), k = id - pi * int(uParts);
  vec4 sp = uSpray[pi];
  vec4 sh = wxShore(sp.xz);
  vec4 shs = vec4(sh.x, 1.2, max(sh.z, .35), sh.w);                    // the swell as it reaches the rock's foot
  Swl s = ocnSwell(sp.xz, 0., shs, uTime.x, 1.);
  float T = uSwell.z;
  float since = fract(atan(s.cs.y, s.cs.x) / (2. * PI)) * T;           // s since this point's crest
  /* [p6] each crest throws its own burst: the jets' draws move on by the crest's time (constant through a burst, a
     different set every crest; the crest's time is taken mod 1024 s, so the bursts repeat exactly with the sea) */
  vec3 rnd = fract(wxHash33(vec3(float(pi), float(k), 5.)) + mod(uTime.x - since + 1024., 1024.) * vec3(.0731, .1137, .0419));
  bool mist = k == int(uParts) - 1;
  float age = since - rnd.x * .2;                                      // the jets leave within 0.2 s of the impact
  /* how high this burst goes: the crest that threw it (a big set throws more), the storm, the rock */
  Swl s0 = ocnSwell(sp.xz, 0., shs, mod(uTime.x - since + 1024., 1024.), 1.);
  float env = wxSat(s0.D.y / max(.5 * s0.H, .05));
  /* [r7] how big the sea is at the rock: the swell that reaches the cove (uSwell.w: 0.5 m low down, 4 m at the cap; the
     user's "big storm surf"), not the storm alone (round 6: uWx2.w, from 85 %). Bursts start at about 75 % (2 m), are
     round 6's at 96 %, and the highest at the cap */
  float sea = pow(wxSat((uSwell.w - 1.1) / 2.9), 1.2);
  float Hm = 32. * sp.w * sea * env * mix(.6, 1., rnd.y);
  float a = max(age, 0.);
  vec3 eye = vec3(0., wxEye, 0.), base = sp.xyz;
  vec3 tb = normalize(base - eye), rt = normalize(vec3(tb.z, 0., -tb.x));
  vec3 wnd = vec3(uWindO.x, 0., uWindO.y) * uWindO.z;
  float on = smoothstep(.5, 3., Hm) * wxSat(1.5 * env);                // a small crest throws nothing
  vec3 c, ax; float len, wd0, wd1;
  if (mist) {
    /* the mist: a low veil the jets leave, blown downwind, gone by 3 s */
    float e = 1. - exp(-a / .8);
    c = base + vec3(0., .22 * Hm * (.5 + .5 * e), 0.) + wnd * .25 * a;
    ax = vec3(0., 1., 0.); len = .22 * Hm * (.7 + .3 * e); wd0 = wd1 = .45 * Hm * (.7 + .4 * wxSat(a / 2.));
    vA = on * smoothstep(.3, .9, age) * (1. - smoothstep(1.4, 3., a)) * .22;
    vSeed = vec3(rnd.yz, -1.);
  } else {
    /* a jet: tilted from the vertical within the fan across the view, and toward the shore (the eye's side) */
    float th = (rnd.z - .5) * .7 + (rnd.y - .5) * .16;                 // +-22 deg at most
    vec3 dir = normalize(vec3(0., cos(th), 0.) + rt * sin(th) - tb * (.15 + .2 * rnd.x));
    float td = 1.5, e = 1. - exp(-a / td);
    float hj = Hm * mix(.35, 1., rnd.x * rnd.x) * (1. - .9 * abs(th));   // the jets' own heights: the middle ones tallest, a ragged top
    float v0 = sqrt(2. * 9.81 * max(hj, .01)) * 1.22;                  // with the drag, the head peaks near its height about 1 s in
    float up = v0 * td * e * dir.y - 9.81 * td * (a - td * e);
    vec3 head = base + vec3(dir.x, 0., dir.z) * v0 * td * e + vec3(0., max(up, -.5), 0.) + wnd * .06 * a;
    /* the column stands on the rock while it rises, then its foot leaves it and it falls back as a mass */
    vec3 foot = base + (head - base) * (.75 * smoothstep(.6, 1.8, a));
    c = .5 * (head + foot); ax = head - foot; len = length(ax); ax = len > 1e-3 ? ax / len : vec3(0., 1., 0.);
    float w = (.08 + .07 * rnd.y) * (Hm + hj) * (1. + .6 * wxSat(a / 1.2));
    wd0 = w * .5; wd1 = w;                                             // narrower at the foot: a fan
    len = .5 * len + .6 * w;                                           // half the column plus its rounded head
    vA = on * smoothstep(0., .05, age) * (1. - smoothstep(1.9, 2.6, a));
    vSeed = vec3(rnd.xy, 1. - smoothstep(.8, 2.3, a));
  }
  /* the quad along the jet on screen: up its axis, across it facing the eye */
  vec3 to = normalize(c - eye), side = cross(ax, to);
  float sl = length(side);
  side = sl > .05 ? side / sl : rt;
  vec3 along = normalize(cross(to, side));
  if (dot(along, ax) < 0.) along = -along;
  float t01 = aPos.y * .5 + .5;
  vec3 p = c + along * aPos.y * len + side * aPos.x * mix(wd0, wd1, t01) * (mist ? 1. : 1.15);   // [p6] room for the fingers
  p.y -= dot(p.xz, p.xz) / (2. * R_G * 1000.);
  vQ = aPos;
  vec4 ap = wxAerial(to, length(c - eye) * 1e-3);
  float mu = dot(to, uSun.xyz), ph = mix(wxHG(mu, .75), wxHG(mu, -.15), .35);   // droplets throw the light forward
  /* lit as the sea's foam (its albedo near snow's, the sky's irradiance); the fragment shades it along the jet */
  /* [r5, F] white water lit by the overcast: the sky above it (the up-facing ambient) and the bright low sky behind
     it, which the droplets' forward lobe sends on toward the eye (the jets stand against the sea's horizon). With the
     ambient alone round 4's jets were grey veils level with the overcast (near shelf p99 118 against a sky of 131,
     1080p, 96 % by day: smoke); now 150-164, 1.15-1.25x the sky round them, as ref/ocean/rocky-creek's burst stands
     over its overcast (1.17-1.25x). REFL at lod 4 (~32 px of the sky 4 deg over the horizon above the jet) */
  vec3 Lb = textureLod(sRefl, clamp(wxUV(normalize(vec3(to.x, .07, to.z))), vec2(.02), vec2(.98)), 4.).rgb;
  vec3 L = wxSunLight(wxPlanet(c)) * wxCloudShadow(c) * wxSunShadow(c) * PI * ph + wxAmbient(1.) * .98 + Lb * 1.5
         + wxFlashE(c, vec3(0.)) * .25;                                // [1.2] lightning: the contract's one light, facing it
  vL = L * ap.a; vAp = ap.rgb;                                        // the jet's own light is shaded along it, the air's is not
  gl_Position = uViewProj * vec4(p, 1.);
  vCl = vec4(0., 0., 0., 1.);
  if (uWx1.y > 1e-3) { vec4 cc = uViewProj * vec4(c, 1.); vCl = wxCloudAt(clamp(cc.xy / cc.w * .5 + .5, 0., 1.)); }
}`;
  const SPRAY_FS = `
in vec2 vQ; in float vA; in vec3 vL; in vec3 vAp; in vec4 vCl; flat in vec3 vSeed;
uniform sampler2D uFoamTex;
layout(location = 0) out vec4 o;
void main() {
  if (vA <= 0.) discard;
  float x = vQ.x, t = vQ.y * .5 + .5, a;
  vec3 sh = vec3(1.);
  if (vSeed.z < 0.) {
    /* the mist: soft, low-frequency, faint */
    float nz = texture(uFoamTex, vQ * .19 + vSeed.xy * 7.).g;
    a = wxSat((1. - smoothstep(.15, 1., length(vQ))) * (.5 + nz)) * vA;
  } else {
    /* the jet: a white mass with cauliflower edges, its clumps drawn out a little along the column, a rounded head.
       Fresh, all of it is opaque; as it ages holes open from the edges in (the core holds longest), then droplets */
    float d = vSeed.z;
    /* [r6] a jet a few tens of pixels across (Intel T0-T1, the render a fraction of the window): the noise's mips flatten
       its clumps and fingers to their mean, and the mass was a white cut-out with a clean outline (REVIEW-5 §9 F). There
       its edges fray over the pixels the quad spans and its body thins where its structure is under a pixel, so a small
       burst reads as spray, not a decal */
    float sm = smoothstep(.035, .09, max(fwidth(vQ.x), fwidth(vQ.y)));
    vec2 q = vec2(x * .3, t * .5) + vSeed.xy * 5.;
    float n = texture(uFoamTex, q).b * .7 + texture(uFoamTex, q * vec2(2.1, 1.6) + .31).b * .4;
    float nf = texture(uFoamTex, q * vec2(4.3, 2.9) + .57).b;                       // the finest clumps: spiky edges
    float rag = (n - .45) * .55 + (nf - .4) * .35;
    /* [p6] the water leaves in fingers: a noise drawn out along the jet (streaks) lets the rim and the head end in
       spikes, as the photographs' bursts do; and the quad's own edge never shows (round 4's p5 had a straight side) */
    float sk = texture(uFoamTex, vec2(x * 1.3, t * .09) + vSeed.yx * 3.).g;
    rag *= 1. + .8 * sm;                                                // [r6] the coarse clumps carry the outline when the fine ones are gone
    float cap = (1. - smoothstep(.6 - .3 * sm, .96, t + rag * .8 - .15 * (1. - x * x) - (sk - .5) * .7)) * (1. - smoothstep(.9, 1., t));
    float foot = smoothstep(0., .1, t);
    /* [r7] SPRAY, NOT A WHITE CUT-OUT (REVIEW-6 #3: the bursts on the RTX at 1080p were flat white cauliflowers with clean
       outlines; rocky-creek's and shore-acres' are a dense white core inside a translucent, grainy spray that ends in
       threads and single drops). Three layers by a ragged distance from the jet's axis: the core, opaque white water
       near the axis and low in the jet, narrowing upward and as the jet ages; the envelope, a translucent spray round it,
       grained along the jet (the lace's threads) and thinning outward; and drops past it. The core keeps round 6's clumpy
       outline; nothing else of the jet is opaque, so the sea and the rock show through its edges */
    float rr = abs(x) + rag + (sk - .5) * .55 * smoothstep(.2, .8, t);
    /* the core: a third of the jet across at its foot, narrowing and thinning toward the head, where the column breaks up
       (round 7's first form kept half the jet opaque to its head: far bursts still read as white puffs) */
    float coreW = mix(.1, .34, d) * (1. - .5 * t) + .2 * sm;
    float thr = .95 - 1.2 * d;
    float core = (1. - smoothstep(coreW - .08, coreW + .12, rr)) * cap * foot * mix(1., .55, smoothstep(.45, .95, t));
    core *= smoothstep(thr - .1 - .2 * sm, thr + .1 + .2 * sm, n + .35 * (1. - abs(x)) + .25);
    float thr2 = texture(uFoamTex, vec2(x * .55, t * .21) + vSeed.xy * 9.).r;           // threads along the jet
    /* the envelope ends in fingers at the head: the streak noise (drawn out along the jet) cuts it there */
    float env = (1. - smoothstep(.3, .95, rr)) * (1. - smoothstep(.82, 1., abs(x))) * cap * foot
              * mix(1., smoothstep(.32, .68, sk), smoothstep(.35, .85, t));
    float spray = env * (.2 + .55 * smoothstep(.25, .75, thr2) + .2 * smoothstep(.4, .9, nf)) * mix(.5, .9, d);
    spray *= 1. - .35 * sm;                                             // unresolved: the mean of a grain, not its peaks
    float drops = texture(uFoamTex, vQ * vec2(.9, 1.7) + vSeed.yx * 3.).a * (1. - smoothstep(.6, 1.15, rr)) * smoothstep(.12, .55, t) * (2.4 - 1.2 * d);
    a = wxSat(max(core * .97, spray) + drops) * vA;
    /* the light along the jet: the thick water at its foot darker and a little green, the clumps' tops whiter; the thin
       spray a little greyer than the core (its drops are fewer than the foam's bubbles) */
    sh = mix(vec3(.66, .75, .73), vec3(1.06), smoothstep(.0, .5, t)) * (.86 + .26 * smoothstep(.3, .8, nf)) * mix(.84, 1., wxSat(core * 1.3));
  }
  if (a < .004) discard;
  o = vec4(wxGuard(((vL * sh + vAp) * vCl.a + vCl.rgb) * a), a);
/*@lab*/  if (uRefl4.z < -.5) o = vec4(vec3(1., 0., 1.) * uExpo.x * a, a);/*@end*/         // lab: show the spray (p.oceanDbg=-1)
}`;

  /* ── 6b. [r2] spume: the spray the wind tears off breaking crests (Beaufort 7 and up). Emitters on a polar lattice
     round the eye (rings x 1.075 from 55 m, 56 columns); each draws the sheet over a breaking crest while that crest
     crosses its cell, so the sheets travel with the breaker lines and hand over from cell to cell with a cross-
     fade. The sheet is thick at the crest and thins upward, streams downwind, and its noise is sampled in world
     space so neighbouring cells agree. Lit as the rock spray; through wxAerial and the rain's medium ── */
  const SPUME_VS = `
layout(location = 0) in vec2 aPos;
uniform vec4 uSpume;                         // x the first ring m, y the ring ratio, z the columns' half-angle rad, w the columns
uniform vec4 uSpume2;                        // x rings, y the wind's tearing 0..1, z unused, w unused
out vec2 vQ; out vec3 vW; out float vA; out vec3 vL; out vec4 vCl;
/* the light the spray sends to the eye per vertex (a sheet is lit evenly): sun (forward-throwing droplets), sky,
   lightning, then the air in front; and the rain's medium at its place on screen */
void main() {
  int nc = int(uSpume.w), j = gl_InstanceID / nc, i = gl_InstanceID - j * nc;
  vA = 0.; vQ = aPos; vW = vec3(0.); vL = vec3(0.); vCl = vec4(0., 0., 0., 1.);
  gl_Position = vec4(2., 2., 2., 1.);                                  // culled unless a crest is breaking in this cell
  vec3 h3 = wxHash33(vec3(float(i), float(j), 11.));
  float r = uSpume.x * pow(uSpume.y, float(j) + .4 * (h3.x - .5)), daz = 2. * uSpume.z / uSpume.w;
  float az = -uSpume.z + daz * (float(i) + .5 + .5 * (h3.y - .5));
  vec2 e = r * vec2(sin(az), cos(az));
  vec4 sh = uRefl4.w > 0. ? wxShore(e) : vec4(1e4, 60., 1., 0.);
  if (sh.y < .3 || uSpume2.y <= 0.) return;
  float depth = ocnBed(e, sh);
  vec3 dmp = ocnDamp(depth);
  Swl s = ocnSwell(e, 0., vec4(sh.x, depth, sh.zw), uTime.x, dmp.x);
  float b = s.brk * uSpume2.y;
  if (b < .03) return;
  /* where the crest is: the phase falls along the travel, so the crest lies phi / k ahead of the emitter */
  float k = max(length(s.kv), 1e-3);
  vec2 kd = s.kv / k, rad = e / r;
  float phi = atan(s.cs.y, s.cs.x), ahead = phi / k;
  /* [r5] only a crest's peaks throw spume. In a storm every crest in the bay breaks (the surf is saturated), so the
     sheets, 1.8 columns wide, joined into 3-5 full-width bars of white between 150 m and 1 km (REVIEW-4 #1, the rails;
     worst under a flash and at T0-T2's S / 4 target). Now a sheet stands only where this crest's own readiness peaks
     (ocnPeak at the crest's cycle, so a sheet keeps its strength as it travels; the peaks wander from crest to crest,
     so the patches are staggered), a little over a column wide and of its own size */
  float gc = ocnPeak(s.U - phi / (2. * PI), s.al), pk = smoothstep(.5, .8, gc);
  b *= pk;
  if (b < .03) return;
  float cell = .5 * (uSpume.y - 1.) * r / max(abs(dot(kd, rad)), .35);  // half the cell along the travel
  float wgt = 1. - smoothstep(.55, 1.25, abs(ahead) / cell);           // neighbouring cells overlap and cross-fade
  if (wgt <= 0.) return;
  vec2 cp = e + kd * ahead + vec2(uWindO.x, uWindO.y) * (.6 + .5 * s.H);
  /* [r5] a low veil along the breaking segment, standing on its crest: the spray the wind lifts off a crest is a few
     metres high and as long as the stretch that breaks. Neighbouring columns on one peak overlap into one veil, and the
     peaks' gaps part them. Each column its own width and height (per column, not per cell: a sheet keeps its shape as
     its crest travels in from ring to ring); its foot a little under the crest's top, never over it (round 5's first
     puffs floated clear of the water: cotton balls) */
  vec3 hb = wxHash33(vec3(float(i), 29., 5.));
  float W = max(2. * mix(.75, 1.25, hb.z) * daz * r, 4.), Hp = (.8 + 1.7 * b) * (.7 + .3 * s.H / 3.) * mix(.65, 1.2, hb.x);
  vec3 c = vec3(cp.x, .45 * s.H, cp.y);
  c.y -= hb.y * .15 * Hp;
  c.y -= dot(c.xz, c.xz) / (2. * R_G * 1000.);
  vec3 eye = vec3(0., wxEye, 0.), to = normalize(c - eye);
  vec3 rt = normalize(vec3(to.z, 0., -to.x)), up = vec3(0., 1., 0.);
  vec3 p = c + rt * (aPos.x * .5 * W) + up * ((aPos.y * .5 + .5) * 1.25 - .25) * Hp;
  vW = p;
  vA = b * wgt * smoothstep(.0, .25, s.H);
  /* [r4] the last rings fade out: cut off at the last ring (560 m below T3), the sheets there overlapped into a thin
     bright line just under the horizon in a day storm (REVIEW-3 B12, x07n on Intel T2) */
  vA *= 1. - smoothstep(uSpume2.x - 8., uSpume2.x - .5, float(j) + .4 * (h3.x - .5));
  vec4 ap = wxAerial(to, length(c - eye) * 1e-3);
  float mu = dot(to, uSun.xyz), ph = mix(wxHG(mu, .75), wxHG(mu, -.15), .35);
  vec3 L = wxSunLight(wxPlanet(c)) * wxCloudShadow(c) * PI * ph + textureLod(sRefl, vec2(.5, .8), 8.).rgb * .95 + wxFlashE(c, vec3(0.)) * .25;
  vL = L * ap.a + ap.rgb;
  gl_Position = uViewProj * vec4(p, 1.);
  vec4 cc = uViewProj * vec4(c, 1.);
  if (uWx1.y > 1e-3) vCl = wxCloudAt(clamp(cc.xy / cc.w * .5 + .5, 0., 1.));
}`;
  const SPUME_FS = `
in vec2 vQ; in vec3 vW; in float vA; in vec3 vL; in vec4 vCl;
uniform sampler2D uFoamTex;
uniform vec4 uSpT;                           // xy 1 / the spume target's size (it is drawn at S / 2 or S / 3, then composited)
layout(location = 0) out vec4 o;
void main() {
  float yr = vQ.y * .5 + .5;
  /* thick at the crest, thinning upward. [r5] A puff, not a panel: round at the sides and soft at the foot (a hard foot on
     every sheet lined up into a rule) */
  float x2 = vQ.x * vQ.x, up = exp(-yr * 2.4), side = (1. - x2) * (1. - x2);
  if (vA * up * side < .01) discard;
  if (wxSceneDist(gl_FragCoord.xy * uSpT.xy) < length(vW - vec3(0., wxEye, 0.))) discard;   // behind the cove (no depth buffer here)
  /* streaming downwind: the noise in world space, scrolled along the wind (whole tiles per 1024 s) */
  vec2 w = uWindO.xy, wp = vec2(-w.y, w.x);
  float along = dot(vW.xz, w), across = dot(vW.xz, wp);
  vec2 q1 = vec2(across / 23., (vW.y - .25 * along) / 9.) + vec2(0., uFoamW3.y);
  vec2 q2 = vec2(across / 7.7, (vW.y - .35 * along) / 3.1) + vec2(.37, uFoamW3.z);
  float nz = texture(uFoamTex, q1).g * .6 + texture(uFoamTex, q2).g * .55;
  /* [r5, resumed] the mist rises from the crest's white water unevenly: its foot torn by the same noise (round 5's first
     veils had a ruled flat base, and under a night flash they read as white pancakes lying on the sea) */
  float prof = smoothstep(0., .32, yr + .3 * (nz - .6)) * up;
  float a = wxSat((nz * 1.8 - .4) * prof * side * vA * 2.1) * .9;    // [r3] denser: the veil must read over the dark water in a storm's fog
  /* [r5] the noise eats the sheet from its edges inward, so a puff ends in wisps and torn holes, not a soft panel */
  a *= smoothstep(0., .35, nz * 1.8 - .4 - .9 * (1. - prof * side / .46));
  /* [r5, resumed] spray is a translucent mist over the crest's white water, never an opaque white body: at most ~.55 */
  a *= .6;
  o = vec4(wxGuard((vL * vCl.a + vCl.rgb) * a), a);
}`;

  /* [r2] the spume's low-resolution target over SCENE, premultiplied, only the frame's lower part (uSpT.z) */
  const SPUMECOMP = `
in vec2 vUV; out vec4 o;
uniform sampler2D uSpumeT; uniform vec4 uSpT;
void main() {
  vec4 c = texture(uSpumeT, vec2(vUV.x, vUV.y * uSpT.z));
  if (c.a < .002) discard;
  o = c;
}`;

  /* [r7] THE LIGHTHOUSE'S LAMP ON THE WATER (stream L's ask, contract 1.4; the user: its lamp the page's accent). Its own
     draw over a narrow strip of the frame under the lamp (+-4 deg of its bearing, from the horizon down), not the sea's
     shader: there wxBeacon and the beacon's three UBO vectors put Intel's SIMD8 compile of the sea over its registers
     (58 spills; 0 without, tests/ocean/r7/simd.sh). Per pixel: the curved sea's point on the unjittered ray, the lamp
     glinted on a sea of the far field's slope variance (the cascades' spectral variance, the extra roughness, the
     capillaries: what the sea's shader folds there), broken into dashes by the night lights' sparkle (world-anchored,
     scrolling), in the lamp's colour (uBeaconC.rgb, the accent eased as the reading eases), through the air and the
     rain in front, under the night lights' soft ceiling (on its luminance). wxBeacon's strength is the lantern's steady
     glow plus the two beams' pattern toward that point of the sea, so the path brightens each time a beam sweeps the
     water between the lamp and the window (a flash every 8 s). The cove and the ship in front hide it (SCENEZ). Added
     (ONE, ONE) into SCENE after the sea */
  const BPATH = `
uniform sampler2D uFoamTex;
uniform vec3 uMss;
uniform vec4 uStreak;
layout(location = 0) out vec4 o;
float bpLambda(float c, float s2) {
  float v = c / sqrt(max((1. - c * c) * 2. * s2, 1e-9));
  return v >= 1.6 ? 0. : (1. - 1.259 * v + .396 * v * v) / (3.535 * v + 2.181 * v * v);
}
void main() {
  vec2 uv = gl_FragCoord.xy * uRes.zw;
  vec3 d = wxRay0(uv);
  if (d.y > -1e-4) discard;
  float Rm = R_G * 1000., h = wxEye, c = h * (2. * Rm + h), b = (Rm + h) * d.y, disc = b * b - c;
  if (disc <= 0.) discard;
  float t = c / (-b + sqrt(disc));
  if (wxSceneDist(uv) < t) discard;                                  // the cove, the ship, the buoy in front
  vec3 p = vec3(0., h, 0.) + d * t;
  vec4 bl = wxBeacon(p);
  if (bl.w <= 0.) discard;
  /* the wind sea's own slopes here (its two long cascades, filtered to the pixel: LEAN's mean and variance), so the
     streak's dashes follow the waves as the moon's path does; what they leave out, and the short cascade, as variance */
  vec2 dx = dFdx(p.xz), dy = dFdy(p.xz), sl = vec2(0.), vr = vec2(0.);
  for (int i = 0; i < 2; i++) {
    vec4 tt = textureGrad(uSlope, vec3(ocnToLocal(p.xz, i) / uL[i], float(i)), ocnToLocal(dx, i) / uL[i], ocnToLocal(dy, i) / uL[i]);
    sl += ocnToWorld(tt.xy, i); vr += max(tt.zw - tt.xy * tt.xy, 0.);
  }
  float s2 = max(.5 * (vr.x + vr.y) + uMss.z + uSea.y + .004 * smoothstep(2., 20., uWindO.z), 2e-5);
  vec3 n = normalize(vec3(-sl.x, 1., -sl.y)), V = -d, L = bl.xyz, H = normalize(L + V);
  float zH = dot(H, n);
  if (zH < .15) discard;
  vec3 Ht = H - n * zH;
  float ex = .5 * dot(Ht, Ht) / (zH * zH * s2);
  if (ex > 30.) discard;
  float F = .02 + .98 * pow(1. - max(dot(V, H), 0.), 5.), zV = max(dot(V, n), .01), zL = max(dot(L, n), .01);
  float g = F * exp(-ex) / (2. * PI * s2) / ((1. + bpLambda(zL, s2) + bpLambda(zV, s2)) * 4. * zV * zH * zH * zH * zH);
  vec3 Lc = uBeaconC.rgb * bl.w * g;
  vec2 fw = abs(dx) + abs(dy);
  float sp = textureLod(uFoamTex, p.xz / (512. * max(fw.x, .02)) + vec2(1., 2.) * uStreak.w, 0.).a;
  Lc *= mix(1., sp / .075, .9);
  float lum = wxLuma(Lc);
  Lc *= lum > 1e-9 ? 1.4 * (1. - exp(-lum / 1.4)) / lum : 0.;
  Lc *= wxAerial(d, t * 1e-3).a;
  if (uWx1.y > 1e-3) Lc *= wxCloudAt(uv).a;
  o = vec4(wxGuard(Lc), 0.);
}`;

  /* [r5] the sun's disc as A's sky draws it, at its centre (wxSunDisc, A's cap at a low sun included), unexposed: read
     back at 2 Hz while the sun is low, so the sea's glints never outshine it */
  const DISC = `
layout(location = 0) out vec4 o;
void main() { o = vec4(wxGuard(wxSunDisc(uSun.xyz) / max(uExpo.x, 1e-30)), 1.); }`;

  /* ── 7. the sea probes: the displaced surface's height and slope at each probe, over its radius ── */
  const PROBE = `
uniform vec4 uProbe[16];
out vec4 o;
void main() {
  int i = int(gl_FragCoord.x);
  vec4 q = uProbe[i];
  if (q.w < .5) { o = vec4(0.); return; }
  float r = max(q.z, .5);
  vec2 x = q.xy;
  vec4 sh = uRefl4.w > 0. ? wxShore(q.xy) : vec4(1e4, 60., 1., 0.);
  sh.y = ocnBed(q.xy, sh);
  vec3 dmp = ocnDamp(sh.y);
  vec3 D = vec3(0.);
  Swl s;
  for (int it = 0; it < 3; it++) {           // the surface point that the choppy displacement brings over the probe
    float w0;
    D = ocnWind(x, vec2(2. * r, 0.), vec2(0., 2. * r), dmp, w0);
    s = ocnSwell(x, r, sh, uTime.x, dmp.x);
    D += s.D;
    x = q.xy - D.xz;
  }
  vec2 sl = ocnWindSlope(x, vec2(2. * r, 0.), vec2(0., 2. * r), dmp) + s.s;
  o = vec4(D.y, sl, 1.);
}`;

  /* ── lab only: the probes' reference, the displaced surface at mip 0 over a 64-point Vogel disc, each point
     found by six fixed-point steps through the choppy displacement (tests/ocean: SEAPROBE within 0.1 m) ── */
  /*@lab*/const PROBEREF = `
uniform vec4 uProbe[16];
out vec4 o;
void main() {
  int i = int(gl_FragCoord.x);
  vec4 q = uProbe[i];
  if (q.w < .5) { o = vec4(0.); return; }
  float r = max(q.z, .5), hs = 0.;
  for (int k = 0; k < 64; k++) {
    float rr = r * sqrt((float(k) + .5) / 64.), a = float(k) * 2.39996;
    vec2 y = q.xy + rr * vec2(cos(a), sin(a)), x = y;
    vec4 sh = uRefl4.w > 0. ? wxShore(y) : vec4(1e4, 60., 1., 0.);
    sh.y = ocnBed(y, sh);
    vec3 dmp = ocnDamp(sh.y), D = vec3(0.);
    for (int it = 0; it < 6; it++) {
      float w0;
      D = ocnWind(x, vec2(1e-3, 0.), vec2(0., 1e-3), dmp, w0) + ocnSwell(x, 0., sh, uTime.x, dmp.x).D;
      x = y - D.xz;
    }
    hs += D.y;
  }
  o = vec4(hs / 64., 0., 0., 1.);
}`;/*@end*/
  /* ── the cove's shore sampled for the swell's travel-time field (read back once, solved on the CPU) ── */
  const SHOREREAD = `
uniform vec4 uB4; in vec2 vUV; out vec4 o;
void main() { o = wxShore(uB4.xy + vUV * uB4.zw); }`;

  /* ── JS: the sea state from the walked weather ── */
  function jonswap(w, wp, gamma) {
    const s = w <= wp ? 0.07 : 0.09, e = (w - wp) / (s * wp), r = wp / w;
    return GR * GR / Math.pow(w, 5) * Math.exp(-1.25 * r * r * r * r) * Math.pow(gamma, Math.exp(-0.5 * e * e));
  }
  /* the wind sea for a mean U10: JONSWAP shape (peak from a 300 km fetch, never past full development),
     energy from the JONSWAP growth law (g Hs / U^2 = 1.6e-3 (g F / U^2)^0.5, at most 0.237).
     [r7] Through full development smoothly: the two limits (fully developed below Uc = 11.57 m/s, fetch-limited above)
     met at a corner, so the open sea's Hs and peak changed their rate with the wind at once there (Hs' halved: the kink
     the user saw in the waves came from the table, this one sat at ~75 %). Now the growth's log-slope d ln Hs / d ln U
     goes from 2 (fully developed) to 1 (fetch-limited) along a smootherstep in ln(U / Uc) over +-0.5 (7.0-19.1 m/s), and
     Hs is its integral: Hs = Hs_full e^(-w S), S the smootherstep's running integral (0 below the window, ln(U / Uc) / w
     above it, so both limits hold outside it; at Uc itself 7.5 % under the corner). Feff the same with twice the slope
     (2 -> 0), so the peak follows. (Blending the two limits' logs instead puts a bump and a dip in the rate) */
  const SEA_F = 3e5, SEA_UC = Math.sqrt(GR * SEA_F) * 1.6e-3 / 0.2373, SEA_W = 0.5;
  function seaState(U, N, NC) {
    U = Math.max(U, 0.7);
    const F = SEA_F, lam = Math.log(U / SEA_UC) / SEA_W, l = WX.util.clamp((lam + 1) / 2, 0, 1);
    const S = lam >= 1 ? lam : 2 * l * l * l * l * (l * l - 3 * l + 2.5);
    const Feff = 2.2e4 * U * U / GR * Math.exp(-2 * SEA_W * S);           // F from Uc e^w up
    const wp = 22 * Math.cbrt(GR * GR / (U * Feff));
    const Hs = 0.2373 * U * U / GR * Math.exp(-SEA_W * S);                // 1.6e-3 sqrt(g F) U / g from Uc e^w up
    const integ = (k0, k1, pw) => {           // integral of omega^pw S(omega) d omega between two wavenumbers
      const w0 = Math.sqrt(GR * k0), w1 = Math.sqrt(GR * k1), n = 600, a = Math.log(w0), b = Math.log(w1);
      let s = 0;
      for (let i = 0; i <= n; i++) {
        const w = Math.exp(a + (b - a) * i / n), f = jonswap(w, wp, 3.3) * Math.pow(w, pw) * w;
        s += (i === 0 || i === n ? 0.5 : 1) * f;
      }
      return s * (b - a) / n;
    };
    const kMin = TAU / LS[0], kMax = Math.PI * 256 / LS[2];
    const alpha = (Hs / 4) * (Hs / 4) / integ(kMin, kMax, 0);
    /* slope variance that the resolved cascades leave out (the 128 tiers' short end; at T0 all of cascade 2) */
    const kTop = NC < 3 ? KB[1] : Math.PI * N / LS[2];
    const mssFold = kTop < kMax ? alpha * integ(kTop, kMax, 4) / (GR * GR) : 0;
    const mss = [integ(kMin, KB[0], 4), integ(KB[0], KB[1], 4), integ(KB[1], Math.PI * N / LS[2], 4)].map((x) => alpha * x / (GR * GR));
    return { U, wp, alpha, Hs, mssFold, mss, kp: wp * wp / GR };
  }
  const probit = (p) => {                        // inverse normal CDF (Acklam's rational fit, ample here)
    p = Math.min(Math.max(p, 1e-9), 1 - 1e-9);
    const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
    const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
    const c = [-7.78489400243029e-3, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
    const d = [7.78469570904146e-3, 0.32246712907004, 2.445134137143, 3.75440866190742];
    if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - 0.02425) return -probit(1 - p);
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  };
  /* the wavenumber of frequency w in depth h (omega^2 = g k tanh(k h)), Newton from Eckart */
  function kOf(w, h) {
    const k0 = w * w / GR;
    if (h > 300) return k0;
    let k = k0 / Math.sqrt(Math.tanh(k0 * h));
    for (let i = 0; i < 4; i++) { const t = Math.tanh(k * h), f = GR * k * t - w * w, df = GR * t + GR * k * h * (1 - t * t); k -= f / df; }
    return k;
  }
  /* the swell's arrival time over the cove (fast sweeping on the eikonal |grad T| = k(h) / omega), less the
     deep-water plane wave's: dT and its gradient, so the shader's phase is the deep one less omega dT */
  function* solveEik(data, dir) {
    const N = EIK.N, hx = (EIK.x1 - EIK.x0) / N, hz = (EIK.z1 - EIK.z0) / N;
    const w0 = TAU * 93 / 1024, c0 = GR / w0;
    const slow = new Float32Array(N * N), T = new Float64Array(N * N).fill(Infinity), water = new Uint8Array(N * N);
    const X = (i) => EIK.x0 + (i + 0.5) * hx, Z = (j) => EIK.z0 + (j + 0.5) * hz;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i, depth = data[k * 4 + 1];
      if (depth > 0.25) { water[k] = 1; slow[k] = kOf(w0, depth) / w0; }
      if (water[k] && (i === 0 || i === N - 1 || j === N - 1)) T[k] = (dir[0] * X(i) + dir[1] * Z(j)) / c0;
    }
    yield;
    const upd = (i, j) => {
      const k = j * N + i;
      if (!water[k]) return 0;
      const a = Math.min(i > 0 ? T[k - 1] : Infinity, i < N - 1 ? T[k + 1] : Infinity);
      const b = Math.min(j > 0 ? T[k - N] : Infinity, j < N - 1 ? T[k + N] : Infinity);
      const f = slow[k];
      if (!isFinite(a) && !isFinite(b)) return 0;
      let t = Math.min(a + f * hx, b + f * hz);                       // the 1D updates (Godunov upwind)
      if (isFinite(a) && isFinite(b)) {
        const A = 1 / (hx * hx) + 1 / (hz * hz), B = -2 * (a / (hx * hx) + b / (hz * hz)), C = a * a / (hx * hx) + b * b / (hz * hz) - f * f;
        const disc = B * B - 4 * A * C;
        if (disc >= 0) { const r = (-B + Math.sqrt(disc)) / (2 * A); if (r >= Math.max(a, b)) t = Math.min(t, r); }
      }
      if (t < T[k]) { const ch = T[k] - t; T[k] = t; return isFinite(ch) ? ch : 1e9; }
      return 0;
    };
    for (let round = 0; round < 8; round++) {
      let ch = 0;
      for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        for (let jj = 0; jj < N; jj++) { const j = sz > 0 ? jj : N - 1 - jj; for (let ii = 0; ii < N; ii++) ch = Math.max(ch, upd(sx > 0 ? ii : N - 1 - ii, j)); }
        yield;
      }
      if (ch < 1e-3) break;
    }
    /* dT, the land filled from its water neighbours so the bilinear lookups near the shore stay smooth */
    const dT = new Float32Array(N * N), ok = new Uint8Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      if (water[k] && isFinite(T[k])) { dT[k] = T[k] - (dir[0] * X(i) + dir[1] * Z(j)) / c0; ok[k] = 1; }
    }
    for (let pass = 0; pass < 40; pass++) {
      let any = false;
      const add = [];
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const k = j * N + i;
        if (ok[k]) continue;
        let s = 0, n = 0;
        if (i > 0 && ok[k - 1] === 1) { s += dT[k - 1]; n++; } if (i < N - 1 && ok[k + 1] === 1) { s += dT[k + 1]; n++; }
        if (j > 0 && ok[k - N] === 1) { s += dT[k - N]; n++; } if (j < N - 1 && ok[k + N] === 1) { s += dT[k + N]; n++; }
        if (n) { add.push(k, s / n); any = true; }
      }
      for (let q = 0; q < add.length; q += 2) { dT[add[q]] = add[q + 1]; ok[add[q]] = 1; }
      if (!any) break;
    }
    yield;
    const out = new Float32Array(N * N * 4);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i, g = (a, b) => dT[a] - dT[b];
      out[k * 4] = dT[k];
      out[k * 4 + 1] = (i > 0 && i < N - 1 ? g(k + 1, k - 1) / (2 * hx) : 0);
      out[k * 4 + 2] = (j > 0 && j < N - 1 ? g(k + N, k - N) / (2 * hz) : 0);
      out[k * 4 + 3] = water[k];
    }
    /* fade the field to 0 over the last 8 cells of the rim, so the shader's out-of-field swell meets it */
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const e = Math.min(i, N - 1 - i, N - 1 - j, 9999) / 8, f = Math.min(1, e), k = (j * N + i) * 4;
      out[k] *= f; out[k + 1] *= f; out[k + 2] *= f;
    }
    return out;
  }
  function toHalf(f32) {
    const out = new Uint16Array(f32.length), fb = new Float32Array(1), ib = new Uint32Array(fb.buffer);
    for (let k = 0; k < f32.length; k++) {
      fb[0] = f32[k]; const x = ib[0], s = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 112, m = x & 0x7fffff;
      out[k] = e <= 0 ? s : e >= 31 ? s | 0x7bff : s | (e << 10) | (m >>> 13);
    }
    return out;
  }

  /* ── state ── */
  let P = {}, S = null;
  const fresh = () => ({ ready: false, N: 0, NC: 0, gridKey: "", lastU: -1, lastDir: [0, 0], lastT: -1, parity: 0, sea: null,
                         eik: null, eikTex: null, eikJob: null, eikShore: null, eikWait: 0, eikReading: false, frames: 0,
                         disc: null, discFb: null, discReading: false, discAt: -1e9 });
  /* uniform objects made once and mutated in place: no allocation per frame */
  const U = {
    uL: new Float32Array(LS), uRc: new Float32Array(ROT.map(Math.cos)), uRs: new Float32Array(ROT.map(Math.sin)), uNC: 3,
    uSw: new Float32Array(16), uSwN: new Float32Array(SWELL.map((s) => s[0])), uSea: new Float32Array(4), uKc: new Float32Array(4),
    uEikB: new Float32Array([EIK.x0, EIK.z0, 1 / (EIK.x1 - EIK.x0), 1 / (EIK.z1 - EIK.z0)]), uEikOn: 0,
    uDisp: null, uSlope: null, uEik: null, uFoamTex: null, uGrid: new Float32Array(4), uFoamW: new Float32Array(4),
    uRefl4: new Float32Array(4), uMss: new Float32Array(3), uSpume: new Float32Array([60, 1.075, 50 * D2R, SPUME_COLS]), uSpume2: new Float32Array(4), uSpT: new Float32Array(4), uSpumeT: null, uSurfA: new Float32Array(4), uWindO: new Float32Array(4), uFoamW3: new Float32Array(4), uLamp: new Float32Array(16), uStreak: new Float32Array(4), uGth: new Float32Array(4), uSpray: null, uParts: 8, uProbe: null,
    uGlintCap: 1e30,                                           // [r5] the sun's disc as drawn at its centre, luminance, unexposed (A's cap at a low sun)
  };
  const UF = { uA: null, uB: null, uStage: 0, uDir: 0, uN: 128 };
  const UFin = { uA: null, uB: null, uFoamPrev: null, uN: 128, uC: 0, uDt: 0, uSpan: 1, uSea: U.uSea };
  const UCp = { uOld: null, uC: 0, uR: 1 };                    // [r4] the held foam carried across a change of the FFT's size
  const USpec = { uWindS: new Float32Array(4), uJon: new Float32Array(4), uN: 128, uL: U.uL, uRc: U.uRc, uRs: U.uRs };
  const UEv = { uH0: null, uN: 128, uL: U.uL, uRc: U.uRc, uRs: U.uRs };
  const SPAN = new Float32Array(3);

  function alloc(R) {
    const gl = R.gl, G = R.gpu, N = R.knobs.fft || 128, NC = R.knobs.cascades || 3;
    if (S.N === N && S.NC === NC && S.tier === R.tier) return;
    /* [r3] the foam pattern's anisotropy by tier: 8 at T3-T4, 4 below (every foam, streak and sparkle lookup is grazing) */
    if (S.foamTex && R.gpu.ext.aniso) { gl.activeTexture(gl.TEXTURE31); gl.bindTexture(gl.TEXTURE_2D, S.foamTex.tex); gl.texParameterf(gl.TEXTURE_2D, R.gpu.ext.aniso.TEXTURE_MAX_ANISOTROPY_EXT, R.tier >= 3 ? 8 : 4); gl.bindTexture(gl.TEXTURE_2D, null); }
    const del = (t) => t && gl.deleteTexture(t.tex), delF = (f) => f && gl.deleteFramebuffer(f.fb);
    const W = 3 * N, o32 = { filter: "nearest" };
    /* [r3] the FFT's ping-pong strips in half floats below T3: the 14 passes are bandwidth-bound on an iGPU, and the
       sums keep about 3 digits (millimetres on metres, 1e-4 on slopes), under what a pixel shows at 128^2 */
    const fF = R.tier >= 3 ? "rgba32f" : "rgba16f";
    const strips = () => {
      if (S.A0) { [S.A0, S.A1, S.B0, S.B1].forEach(del); [S.Afb, S.Bfb].forEach(delF); }
      S.A0 = G.tex2D(W, N, fF, o32); S.A1 = G.tex2D(W, N, fF, o32); S.Afb = G.fbo([S.A0, S.A1]);
      S.B0 = G.tex2D(W, N, fF, o32); S.B1 = G.tex2D(W, N, fF, o32); S.Bfb = G.fbo([S.B0, S.B1]);
      S.fF = fF;
    };
    const aniso = R.p("oceanAniso") || (R.tier >= 3 ? 16 : 4);
    /* [r4] a tier change that keeps the FFT's size keeps the sea's arrays, its spectrum and its held foam: only the
       strips' format and the arrays' anisotropy follow the tier. Round 3 re-made everything, and the near foam vanished
       at a tier change and grew back over ~1.5 s (E, notes/ocean.md round 4) */
    if (S.h0 && S.N === N && S.NC === NC) {
      if (S.fF !== fF) strips();
      if (R.gpu.ext.aniso) {
        gl.activeTexture(gl.TEXTURE31);
        for (const t of [S.disp, S.slope]) { gl.bindTexture(gl.TEXTURE_2D_ARRAY, t.tex); gl.texParameterf(gl.TEXTURE_2D_ARRAY, R.gpu.ext.aniso.TEXTURE_MAX_ANISOTROPY_EXT, aniso); }
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      }
      S.tier = R.tier;
      return;
    }
    const oldFoam = S.h0 ? S.foam[1 - S.parity] : null, oldN = S.N, oldNC = S.NC;   // [r4] the last held foam, carried over below
    if (S.h0) {
      [S.h0, S.disp, S.slope].forEach(del);
      for (const f of S.foam) if (f !== oldFoam) del(f);
      delF(S.h0fb); S.fin.forEach((a) => a.forEach(delF));
    }
    S.h0 = G.tex2D(W, N, "rgba32f", o32); S.h0fb = G.fbo([S.h0]);
    strips();
    const oa = { mips: true, wrap: "repeat", aniso };
    S.disp = G.texArray(N, N, 3, "rgba16f", oa); S.slope = G.texArray(N, N, 3, "rgba16f", oa);
    S.foam = [G.texArray(N, N, 3, "r16f", { filter: "nearest" }), G.texArray(N, N, 3, "r16f", { filter: "nearest" })];
    S.fin = [0, 1].map((par) => [0, 1, 2].map((c) => G.fbo([{ tex: S.disp, layer: c }, { tex: S.slope, layer: c }, { tex: S.foam[par], layer: c }])));
    /* the held foam starts at none, or [r4] at the old size's (same tiles, so the same world points: the larger of a
       2 x 2 block going down to 128, the nearest texel going up), so a change of the FFT's size keeps the foam */
    if (oldFoam) { gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); }
    for (const f of S.foam) for (let c = 0; c < 3; c++) {
      const fb = G.fbo([{ tex: f, layer: c }]);
      if (oldFoam && c < oldNC && P.foamCopy) {
        UCp.uOld = oldFoam; UCp.uC = c; UCp.uR = oldN / N;
        R.draw(P.foamCopy, fb, UCp);
      } else { gl.bindFramebuffer(gl.FRAMEBUFFER, fb.fb); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
      gl.deleteFramebuffer(fb.fb);
    }
    if (oldFoam) del(oldFoam);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    S.N = N; S.NC = NC; S.tier = R.tier; S.lastU = -1;
    S.ffted = false;                                                  // [r4] the FFT runs in the next frame at its new size, whatever the 30 Hz parity
    U.uDisp = S.disp; U.uSlope = S.slope; U.uNC = NC;
    /*@lab*/R.debugTex("ocean.fft", S.A0, "raw");/*@end*/
  }
  function makeGrid(R) {
    let gm = 1; /*@lab*/ gm = R.p("oceanGrid") || 1; /*@end*/
    const gl = R.gl, C = R.size.C, cell = (R.knobs.grid || 4) * gm, cam = R.cam;
    const key = C[0] + "x" + C[1] + ":" + cell + ":" + R.size.S.join("x");
    if (S.gridKey === key) return;
    S.gridKey = key;
    const yh = Math.tan(-cam.dip - cam.pitch) / cam.tanY;            // the horizon's NDC y at the centre column
    const yTop = yh + 0.04, yBot = -1.15, xs = 1.12;                // [r2] below the frame: the highest near crest lifts < 0.1
    const cols = Math.ceil((xs * C[0]) / cell) + 1, rows = Math.ceil(((yTop - yBot) / 2) * C[1] / cell) + 1;
    const pos = new Float32Array(cols * rows * 2);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const k = (j * cols + i) * 2;
      pos[k] = -xs + (2 * xs * i) / (cols - 1); pos[k + 1] = yBot + ((yTop - yBot) * j) / (rows - 1);
    }
    const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
    let q = 0;
    for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
      idx[q++] = a; idx[q++] = b; idx[q++] = c; idx[q++] = b; idx[q++] = d; idx[q++] = c;
    }
    if (S.grid) { gl.deleteVertexArray(S.grid.vao); gl.deleteBuffer(S.grid.vb); gl.deleteBuffer(S.grid.ib); }
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    S.grid = { vao, vb, ib, count: idx.length, verts: cols * rows };
    const cellScene = cell * (R.size.S[1] / C[1]);
    U.uGrid[0] = cellScene * (2 * cam.tanY / R.size.S[1]); U.uGrid[1] = 1 / yh;
    /* [r2] the spume's target: S / 2 at T3-T4, [r3] S / 4 below (a soft mist: a sixteenth of the fill); and its
       lattice: 40 rings x 48 columns (60 m to 1 km) at T3-T4, 34 x 40 (to 650 m) below */
    S.spRings = R.tier >= 3 ? SPUME_RINGS : 32; U.uSpume[3] = R.tier >= 3 ? SPUME_COLS : 36;   // [r3] 32 x 36 below T3 (to 560 m)
    const div = R.tier >= 3 ? 2 : 4, sw = Math.ceil(R.size.S[0] / div), sh = Math.ceil(R.size.S[1] / div);
    if (S.spT) { gl.deleteTexture(S.spT.tex); gl.deleteFramebuffer(S.spFb.fb); }
    S.spT = R.gpu.tex2D(sw, sh, "rgba16f", {}); S.spFb = R.gpu.fbo([S.spT]);
    U.uSpumeT = S.spT;
    U.uSpT[0] = 1 / sw; U.uSpT[1] = 1 / sh; U.uSpT[2] = Math.min(1, (yh + 1) / 2 + 0.06);   // the composite covers the sea and 6 % above
  }

  /* ── per frame: the sea state into the uniforms ── */
  function seaUniforms(R, F) {
    const W = F.W, kn = R.knobs;
    const wn = F.wind || WX.windAt(W, F.t);                         // [1.2] it loops with the sea: the hold tests need no held wind
    const Um = W.U10, dir = wn.wind.dir, N = S.N, NC = S.NC;
    const moved = Math.abs(Um - S.lastU) > 0.05 || Math.abs(Math.atan2(dir[1], dir[0]) - Math.atan2(S.lastDir[1], S.lastDir[0])) > 0.3 * D2R;
    if (moved || !S.sea) {
      S.sea = seaState(Um, N, NC);
      S.needSpec = true; S.lastU = Um; S.lastDir = dir.slice();
      const sea = S.sea, lam = WX.util.lerp(0.75, 1.0, W.storm);
      /* whitecaps after Monahan & O'Muircheartaigh (1980): W = 3.84e-6 U^3.41, shared between the cascades by
         their slope variance; each threshold from the Jacobian's spread (J ~ 1 + lambda (Dxx + Dzz)) */
      const Wm = Math.min(0.5, 3.84e-6 * Math.pow(Um, 3.41));
      S.Wm = Wm;
      for (let c = 0; c < 3; c++) SPAN[c] = 3 * lam * Math.sqrt(Math.max(sea.mss[c], 1e-12));
      S.lam = lam;
    }
    const sea = S.sea;
    U.uSea[0] = S.lam; U.uSea[1] = 0.0025 + 0.010 * W.precip + 0.5 * sea.mssFold; U.uSea[2] = sea.Hs; U.uSea[3] = wn.swell.Hs;
    U.uKc[0] = Math.max(1.5 * sea.kp, 0.06); U.uKc[1] = 1.6; U.uKc[2] = 11; U.uKc[3] = Math.pow(TAU * 93 / 1024, 2) / GR;
    /* the swell's components, turned about the contract's direction */
    const m0 = (wn.swell.Hs / 4) * (wn.swell.Hs / 4), a0 = Math.atan2(wn.swell.dir[1], wn.swell.dir[0]);
    SWELL.forEach(([n, turn, share], i) => {
      const w = TAU * n / 1024, a = a0 + turn * D2R;
      U.uSw.set([Math.cos(a), Math.sin(a), w * w / GR, Math.sqrt(2 * m0 * share)], i * 4);
    });
    /* whitecaps: each cascade's share of Monahan's fraction, as a threshold on the held compression in units of
       three standard deviations (a Gaussian Jacobian; oceanFoam calibrates what the hold and the pattern add) */
    /* measured (tests/ocean/whitecap.py, open sea, the RTX): what the Gaussian estimate misses, by wind */
    /* [r7] its ceiling of 12 (reached under 4.5 m/s, 0-45 % on the new curve) as a smooth minimum (a 6-norm): the clamp's
       corner put a kink in the whitecaps' threshold against the reading */
    const kRaw = 5.2 * Math.pow(Math.max(W.U10, 3) / 9, -1.19);
    const kc = R.p("oceanFoam") * kRaw * Math.pow(1 + Math.pow(kRaw / 12, 6), -1 / 6);
    [0.5, 0.4, 0.1].forEach((w, c) => { U.uGth[c] = Math.max(0.02, -probit(Math.max(S.Wm * w * kc, 1e-7)) / 3); });
    U.uGth[3] = S.Wm;
    for (let c = 0; c < 3; c++) U.uMss[c] = 0.5 * S.lam * S.sea.mss[c];
    U.uFoamW[0] = 1; U.uFoamW[1] = WX.util.smooth(14, 26, wn.wind.U10) * 0.85; U.uFoamW[2] = 0.85;   // [r2] streaks: Beaufort 7 to 10
    const refl = R.tex.REFL;
    U.uRefl4[0] = Math.max(0, (refl ? refl.levels : 1) - 3); U.uRefl4[1] = 1 - Math.log2(kn.coastRefl || 2); U.uRefl4[2] = 0; /*@lab*/ U.uRefl4[2] = R.p("oceanDbg"); /*@end*/ U.uRefl4[3] = R.p("oceanShore");
    /* scrolls that wrap with the sea's clock: whole tiles per 1024 s */
    const t = F.t.ocean;
    U.uStreak[0] = dir[0]; U.uStreak[1] = dir[1]; U.uStreak[2] = ((t * 10) / 1024) % 1;   // 0.625 m/s along the wind
    U.uStreak[3] = ((t * 97) / 1024) % 1; U.uFoamW[3] = ((t * 131) / 1024) % 1;             // the sparkle's two layers
    U.uFoamW3[0] = ((t * 40) / 1024) % 1;
    U.uFoamW3[1] = ((t * 341) / 1024) % 1; U.uFoamW3[2] = ((t * 1380) / 1024) % 1;           // [r2] the spume streams downwind (~12 m/s)
    U.uFoamW3[3] = ((t * 13) / 1024) % 1;                                                     // [r2] the streaks drift 0.9 m/s
    U.uSurfA[0] = ((t * 293) / 1024) % 1;                                                     // [r2] fresh white water rides the bores: 6 m/s
    U.uSurfA[1] = R.tier >= 3 ? 1 : 0;                                                        // [r2] detail: T3-T4
    U.uSurfA[2] = WX.util.smooth(8.6, 11.5, W.U10);                                          // [r3] the near bores: none below 70 % (the mean wind, no gusts)
    U.uSurfA[3] = 0;                                                                          // free
    U.uSpume2[0] = S.spRings || SPUME_RINGS; U.uSpume2[1] = WX.util.smooth(12, 22, wn.wind.U10);          // spray torn off the crests from Beaufort 7
    U.uWindO[0] = dir[0]; U.uWindO[1] = dir[1]; U.uWindO[2] = wn.wind.U10;                                                     // the spray haze: 20 m/s
    /* the night lights */
    const L = R.coast.lamps;
    let any = false;
    const nL = Math.min(16, L.length);                     // [r3] as many lamps as R.coast.lamps holds, up to 4 (contract 1.3)
    for (let k = 0; k < 16; k++) { U.uLamp[k] = k < nL ? L[k] : 0; if (k % 4 === 3 && k < nL && L[k] > 0) any = true; }
    /*@lab*/if (!any && R.p("oceanLampTest") > 0) {      // lab: the pier lantern and the anchor light (DESIGN 13.1, 13.3)
      const night = 1 - WX.util.smooth(-6 * D2R, -2 * D2R, Math.asin(F.sun.dir[1])), sp = R.coast.ship.pos;
      U.uLamp.set([87.2, 2.5, 192.5, 0.004 * night, sp[0] + 10 * Math.sin(R.coast.ship.yaw), 13, sp[2] + 10 * Math.cos(R.coast.ship.yaw), 0.002 * night * R.coast.ship.on]);
    }/*@end*/
    U.uEikOn = S.eikTex && R.coast.up > 0 ? 1 : 0;
  }

  /* [r5] the disc probe: while the sun is within ~9 deg of the horizon, its drawn centre is read back every half second
     (async, never a stall); above that A draws the physical disc, far brighter than any glint, and nothing is read */
  function discStep(R, F) {
    /* and only while the sun's glint is drawn (the sea's shader: uSun.y > -.03): below that the disc is under the horizon,
       and its value there must not hold the moon's path down */
    if (F.sun.dir[1] > .16 || F.sun.dir[1] < -.03) { U.uGlintCap = 1e30; return; }
    if (S.discReading || (S.frames - S.discAt < 30 && S.frames >= S.discAt)) return;   // world frames: every 0.5-1 s
    R.draw(P.disc, S.discFb, U);
    S.discReading = true; S.discAt = S.frames;
    const ok = R.gpu.readback(S.discFb.fb, 0, 0, 1, 1, (px) => {
      S.discReading = false;
      const L = 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2];
      U.uGlintCap = L > 0 && isFinite(L) ? L : 1e30;
    });
    if (!ok) S.discReading = false;
  }

  /* ── the swell's travel-time field: read the shore field back once it is up, solve, upload ── */
  function eikStep(R, F) {
    const gl = R.gl, shore = R.tex.SHORE;
    if (!shore || R.coast.up <= 0) return;
    /* [1.2] read it again when the coast says SHORE changed (R.coast.shoreStamp) or the texture object did */
    const stamp = R.coast.shoreStamp | 0;
    if ((S.eikShore !== shore || S.eikStamp !== stamp) && !S.eikReading && !S.eikJob) {
      if (S.eikWait++ < 4) return;                  // let the coast's bake settle for a few frames
      S.eikShore = shore; S.eikStamp = stamp; S.eikReading = true; S.eikWait = 0;
      if (!S.eikRT) { S.eikRT = R.gpu.tex2D(EIK.N, EIK.N, "rgba32f", { filter: "nearest" }); S.eikFb = R.gpu.fbo([S.eikRT]); }
      R.draw(P.shoreRead, S.eikFb, { uB4: [EIK.x0, EIK.z0, EIK.x1 - EIK.x0, EIK.z1 - EIK.z0] });
      const dir = (F.wind || WX.windAt(F.W, F.t)).swell.dir.slice();
      const ok = R.gpu.readback(S.eikFb.fb, 0, 0, EIK.N, EIK.N, (data) => { S.eikReading = false; S.eikJob = solveEik(data, dir); });
      if (!ok) { S.eikReading = false; S.eikShore = null; }
      return;
    }
    if (S.eikJob) {
      const r = S.eikJob.next();
      if (r.done) {
        S.eikJob = null;
        if (!S.eikTex) S.eikTex = R.gpu.tex2D(EIK.N, EIK.N, "rgba16f", {});
        gl.bindTexture(gl.TEXTURE_2D, S.eikTex.tex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, EIK.N, EIK.N, gl.RGBA, gl.HALF_FLOAT, toHalf(r.value));
        U.uEik = S.eikTex;
        /*@lab*/R.debugTex("ocean.eik", S.eikTex, "raw");/*@end*/
      }
    }
  }

  function runFFT(R, F) {
    const gl = R.gl, N = S.N;
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    if (S.needSpec) {
      const sea = S.sea, dir = S.lastDir;
      USpec.uWindS[0] = dir[0]; USpec.uWindS[1] = dir[1]; USpec.uWindS[2] = sea.U; USpec.uWindS[3] = sea.wp;
      USpec.uJon[0] = sea.alpha; USpec.uJon[1] = 3.3; USpec.uJon[2] = KB[0]; USpec.uJon[3] = KB[1];
      USpec.uN = N;
      R.draw(P.spec, S.h0fb, USpec);
      S.needSpec = false;
    }
    UEv.uH0 = S.h0; UEv.uN = N;
    R.draw(P.evolve, S.Afb, UEv);
    const L2 = Math.round(Math.log2(N));
    let inA = true;                                                      // the evolve wrote A; passes alternate A -> B -> A
    UF.uN = N;
    for (let dirn = 0; dirn < 2; dirn++) for (let s = 0; s < L2; s++) {
      UF.uA = inA ? S.A0 : S.B0; UF.uB = inA ? S.A1 : S.B1; UF.uStage = s; UF.uDir = dirn;
      R.draw(P.fft, inA ? S.Bfb : S.Afb, UF);
      inA = !inA;
    }
    const src0 = inA ? S.A0 : S.B0, src1 = inA ? S.A1 : S.B1;
    /* the scene-time step since the last update (0 when frozen): the foam's hold */
    const t = F.t.ocean, dt = S.lastT < 0 ? 0 : Math.min(1, ((t - S.lastT) % 1024 + 1024) % 1024);
    S.lastT = t;
    const par = S.parity;
    UFin.uA = src0; UFin.uB = src1; UFin.uFoamPrev = S.foam[1 - par]; UFin.uN = N; UFin.uDt = dt;
    for (let c = 0; c < S.NC; c++) { UFin.uC = c; UFin.uSpan = SPAN[c]; R.draw(P.fin, S.fin[par][c], UFin); }
    S.parity = 1 - par;
    R.bind(null);
    gl.activeTexture(gl.TEXTURE31);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, S.disp.tex); gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, S.slope.tex); gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }

  return {
    name: "ocean",
    *build(R) {
      S = fresh();                               // a new context: forget every object of the old one
      U.uEik = null;                             // [r7] its swell field too (a Graphics card change printed a console line)
      /*@lab*/R.priv.ocean = { S, U, SPAN, P };           // lab: what the tests read
      /* lab: SEAPROBE against the exact surface, read back at once (a test, never in a frame) */
      R.priv.ocean.probeCheck = () => {
        const gl = R.gl, n = R.coast.nProbes | 0;
        if (!S.refTex) { S.refTex = R.gpu.tex2D(WX.SEAPROBES, 1, "rgba32f", { filter: "nearest" }); S.refFb = R.gpu.fbo([S.refTex]); }
        U.uProbe = R.coast.probes;
        R.draw(P.probeRef, S.refFb, U);
        const a = new Float32Array(64), b = new Float32Array(64);
        gl.bindFramebuffer(gl.FRAMEBUFFER, S.probeFb.fb); gl.readPixels(0, 0, 16, 1, gl.RGBA, gl.FLOAT, a);
        gl.bindFramebuffer(gl.FRAMEBUFFER, S.refFb.fb); gl.readPixels(0, 0, 16, 1, gl.RGBA, gl.FLOAT, b);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const out = [];
        for (let k = 0; k < n; k++) out.push({ probe: k, at: [R.coast.probes[k * 4], R.coast.probes[k * 4 + 1]], r: R.coast.probes[k * 4 + 2],
                                                 seaprobe: +a[k * 4].toFixed(3), exact: +b[k * 4].toFixed(3), err: +(a[k * 4] - b[k * 4]).toFixed(3) });
        return out;
      };/*@end*/
      const libs = ["atmo", "clouds", "coast"];
      P.spec = R.program("ocean.spectrum", { fs: OCN + SPEC });
      P.evolve = R.program("ocean.evolve", { fs: OCN + EVOLVE });
      P.fft = R.program("ocean.fft", { fs: FFT });
      P.fin = R.program("ocean.finalize", { fs: OCN + FIN });
      P.foamTex = R.program("ocean.foamtex", { fs: FOAMTEX });
      P.foamCopy = R.program("ocean.foamcopy", { fs: FOAMCOPY });   // [r4]
      P.sea = R.program("ocean.sea", { libs, vs: OCN + SURF + SEA_VS, fs: OCN + SEA_FS });
      /* [r7] the lighthouse's path on the water needs contract 1.4's wxBeacon (stream L): made only when the common
         prelude has it, so this pass still builds on a 1.3 core */
      P.bpath = WX.glsl && typeof WX.glsl.common === "string" && WX.glsl.common.indexOf("vec4 wxBeacon(") >= 0
        ? R.program("ocean.bpath", { libs: ["atmo", "clouds", "coast"], fs: OCN + BPATH }) : null;
      /*@lab*/ P.seaVS = R.program("ocean.seaVS", { libs, vs: OCN + SURF + SEA_VS, fs: `in vec3 vP; layout(location = 0) out vec4 o; void main() { o = vec4(vP * 1e-9, 1.); }` }); /*@end*/   // lab timing only
      P.spray = R.program("ocean.spray", { libs, vs: OCN + SURF + SPRAY_VS, fs: OCN + SPRAY_FS });
      P.spume = R.program("ocean.spume", { libs, vs: OCN + SURF + SPUME_VS, fs: OCN + SPUME_FS });
      P.spumeComp = R.program("ocean.spumecomp", { fs: SPUMECOMP });
      P.probe = R.program("ocean.probe", { libs: ["coast"], fs: OCN + SURF + PROBE });
      P.shoreRead = R.program("ocean.shoreread", { libs: ["coast"], fs: SHOREREAD });
      P.disc = R.program("ocean.disc", { libs: ["atmo"], fs: DISC });   // [r5]
      const wait = [P.spec, P.evolve, P.fft, P.fin, P.foamTex, P.foamCopy, P.sea, P.spray, P.spume, P.spumeComp, P.probe, P.shoreRead, P.disc].concat(P.bpath ? [P.bpath] : []);
      /*@lab*/ P.probeRef = R.program("ocean.proberef", { libs: ["coast"], fs: OCN + SURF + PROBEREF }); wait.push(P.seaVS, P.probeRef); /*@end*/
      yield* R.wait(...wait);
      const G = R.gpu, gl = R.gl;
      S.foamTex = G.tex2D(256, 256, "rgba8", { mips: true, wrap: "repeat", aniso: 8 });
      R.draw(P.foamTex, G.fbo([S.foamTex]));
      gl.activeTexture(gl.TEXTURE31); gl.bindTexture(gl.TEXTURE_2D, S.foamTex.tex); gl.generateMipmap(gl.TEXTURE_2D);
      U.uFoamTex = S.foamTex;
      /*@lab*/R.debugTex("ocean.foamtex", S.foamTex, "raw");/*@end*/
      S.probe = G.tex2D(WX.SEAPROBES, 1, "rgba16f", { filter: "nearest" });
      S.probeFb = G.fbo([S.probe]);
      S.disc = G.tex2D(1, 1, "rgba32f", { filter: "nearest" }); S.discFb = G.fbo([S.disc]);   // [r5]
      R.provide("SEAPROBE", S.probe);
      /*@lab*/R.debugTex("SEAPROBE", S.probe, "raw");/*@end*/
      /* a quad for the spray sheets */
      S.quad = gl.createVertexArray(); gl.bindVertexArray(S.quad);
      const qb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, qb);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      S.ready = true;
    },
    resize(R) {
      if (!S || !S.ready) return;
      alloc(R);
      makeGrid(R);
      /*@lab*/R.debugTex("ocean.dbg", R.tex.SCENE, "raw");/*@end*/
    },
    ubo(F, R, set) {
      if (!S || !S.sea) return;
      set("uB0", S.sea.Hs, R.coast ? U.uSea[3] : 0, S.lam || 0.75, S.sea.wp);   // wind-sea Hs, swell Hs, choppiness, peak omega
    },
    slots: {
      ocean(R, F) {
        if (!S || !S.ready) return;
        const gl = R.gl;
        alloc(R); makeGrid(R);
        seaUniforms(R, F);
        eikStep(R, F);
        let prof = 0; /*@lab*/ prof = R.p("oceanProf") | 0; /*@end*/
        /* [r2] the wind sea's FFT at 30 Hz below T3 (the bores, the foam's hold and everything else stay per frame:
           the chop moves under a pixel per frame at these distances); every world frame at T3-T4 */
        S.frames++;
        const fftNow = R.tier >= 3 || R.knobs.worldEvery > 1 || (S.frames & 1) === 0 || F.still || !S.ffted;
        if ((!(prof & 1) || !S.ffted) && fftNow) { runFFT(R, F); S.ffted = true; }
        /* the sea, over the sky and the cove */
        R.bind("scene");
        gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.SRC_ALPHA);
        if (!(prof & 2)) {
          const Ps = prof & 16 ? P.seaVS : P.sea;
          /*@lab*/ U.uCut = prof >> 5; /*@end*/
          Ps.use(); R.gpu.uniforms(Ps, U);
          gl.bindVertexArray(S.grid.vao);
          gl.drawElements(gl.TRIANGLES, S.grid.count, gl.UNSIGNED_INT, 0);
          gl.bindVertexArray(null);
        }
        /* spray on the rocks, in storms */
        const ns = R.coast.nSpray | 0;
        if (ns > 0 && F.W.swellHs > 1.15 && R.p("oceanSpray") > 0 && U.uRefl4[2] <= 0 && !(prof & 8)) {   // [r7] the swell's bursts (VS: sea)
          gl.depthMask(false); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          U.uSpray = R.coast.spray; U.uParts = R.tier >= 3 ? 8 : 6;   // [r3] 6 droplet clouds a burst below T3
          P.spray.use(); R.gpu.uniforms(P.spray, U);
          gl.bindVertexArray(S.quad);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, ns * U.uParts);
          gl.bindVertexArray(null);
          gl.depthMask(true);
        }
        /* [r7] the lighthouse's path on the water: a strip +-4 deg of the lamp's bearing, from the horizon down */
        const BC = R.beacon;
        if (P.bpath && BC && BC.on > 0 && BC.uv[0] >= 0 && BC.uv[0] <= 1 && U.uRefl4[2] <= 0) {
          const sc = R.target("scene"), hw = 0.5 * Math.tan(4 * D2R) / R.cam.tanX;
          const x0 = Math.max(0, Math.floor((BC.uv[0] - hw) * sc.w)), x1 = Math.min(sc.w, Math.ceil((BC.uv[0] + hw) * sc.w));
          const y1 = Math.min(sc.h, Math.ceil((BC.uv[1] + 0.01) * sc.h));
          if (x1 > x0 && y1 > 0) {
            gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
            R.draw(P.bpath, "scene", U, { viewport: [x0, 0, x1 - x0, y1] });
            gl.viewport(0, 0, sc.w, sc.h); gl.depthMask(true);
          }
        }
        /* [r2] spume off the breaking crests, from Beaufort 7: into its low-resolution target, then over SCENE */
        if (U.uSpume2[1] > 0 && R.p("oceanSpray") > 0 && U.uRefl4[2] <= 0 && !(prof & 8)) {
          R.bind(S.spFb); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
          gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          P.spume.use(); R.gpu.uniforms(P.spume, U);
          gl.bindVertexArray(S.quad);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, S.spRings * U.uSpume[3]);
          gl.bindVertexArray(null);
          const sc = R.target("scene");
          R.draw(P.spumeComp, "scene", U, { viewport: [0, 0, sc.w, Math.ceil(sc.h * U.uSpT[2])] });
          gl.depthMask(true);
        }
        gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
        /* the probes, for the ship and the buoy next frame */
        U.uProbe = R.coast.probes;
        if (!(prof & 4)) R.draw(P.probe, S.probeFb, U);
        discStep(R, F);
      },
    },
  };
})());
