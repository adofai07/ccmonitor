/* bolt (stream C): lightning channels (render.md 9, robust.md 4.2).

   A channel is made on the CPU once per strike, from its seed (uFlash*b.y): midpoint displacement in
   3D after Reed and Wyvill. [r3] A cloud-to-sea strike (kind 1) runs from INSIDE the deck (its top
   bolt.top + 0-0.35 km above W.base, 1.05-1.4 km at the cap: the storm's 0.4-0.45 km base is its rain foot
   and scud, and a channel from there spanned only 8-9 deg at 3 km; now 20-25 deg) to the sea's curved
   surface: 8 levels, 256 pieces, straight overall with tortuous kinks; 5-12 branches leave it below the
   base, downward and outward (5-6 levels, 0.18-0.5 of the brightness), with twigs of their own. An
   in-cloud flash (kind 0) draws no channel at all: the sky's lit cloud is all of it.
   Drawn as camera-facing ribbons into a MAX-blended layer (r core, g glow) at S, depth-tested against the
   scene's depth (the cove and the sea) and the curved sea analytically, never into the picture: post adds
   the layer to the view and to the bloom's input AFTER the flash limit (which would cut a white core into
   16 px blocks: round 2's stair-stepped blob at blue hour) and after the view's sharpening (its dark halo).
   With TAA the layer is drawn from post's taa slot, so it is never accumulated in the history.
   Radiance: a core of gaussian sigma 0.7 px x sqrt(canvas scale) (2-3 px across) whose value is the channel's
   radiance through the air (sqrt(T): rain's big drops scatter half of what they take out into a forward
   peak) compressed softly to bolt.core (20 since r4; 6 left it at ~235/255, a grey-white line, where Esterel's core is
   clipped white) pre-exposed at full brightness, so the core is white and the
   gaussian's tail stays narrow; a bluish glow of a few px that widens as the air thickens. Above W.base the
   channel is dimmed by the cloud in front (the cloud buffer's transmittance, floor .15) and softens with
   the depth into the deck. Brightness, applied linearly after the ceiling (so the channel fades out with
   the envelope; a saturated core stayed white to the envelope's end and vanished in one frame): the
   director's return strokes (uFlash*b.z) and the channel's own restrikes from its seed (2-5 strokes 30-90 ms
   apart, a continuing current between them), the brighter of the two, then an afterglow with the area
   envelope.
   [r3] THE LIT CLOUD is the sky's (A's flashVol in sky.js: the deck lit from inside round the channel,
   every frame, per pixel), by the A/C agreement in notes/sky.md and notes/pane.md; this pass draws no patch
   and no in-cloud crawler (round 2's horizontal white bar). The "boltlit" library gives post the layer
   (boltChan), which post adds to the view and the bloom's input after the flash limit.                */
WX.lib("boltlit", `
uniform sampler2D uBoltL;   // the channels: r core, g glow (MAX), b the halo's energy, S, unjittered
uniform sampler2D uBoltH;   // [r4] the halo: the channels' energy blurred over 4-64 px (post's halo pyramid, S/4)
uniform vec4 uBoltOn;       // x the layer holds channels, y the halo is on, z its gain in the view, w in the drops
vec3 boltChan(vec2 uv) {
  if (uBoltOn.x < .5) return vec3(0.);
  vec2 l = texture(uBoltL, uv).rg;
  return vec3(.92, .94, 1.) * l.r + vec3(.72, .8, 1.) * l.g;
}
/* [r4] the light round a channel: the rain and haze between it and the eye scatter it forward, the eye and the lens
   bloom it (Esterel: a white core in a soft blue-white halo a few core widths wide; NOAA's night photographs: a glow
   that fills the space between the forks). drops 0: the view's gain uBoltOn.z; 1: the drops', uBoltOn.w, which see the
   channel through their lenses (every bead whose field holds the strike catches a bright point of it); lod: S/4's */
vec3 boltHalo(vec2 uv, float lod, float drops) {
  if (uBoltOn.y < .5) return vec3(0.);
  return vec3(.8, .87, 1.) * textureLod(uBoltH, uv, lod).a * mix(uBoltOn.z, uBoltOn.w, drops);    // [r5] a: post's pyramid is RGBA (rgb the glare)
}
`);
WX.pass((function () {
  WX.param("bolt.gain", 60, 0, 200, 1, "bolt");
  WX.param("bolt.core", 20, 1, 40, 0.5, "bolt");           // [r3] the core's soft ceiling, pre-exposed ([r4] 6 -> 20: clipped white)
  WX.param("bolt.top", 0.65, 0.2, 2, 0.05, "bolt");         // [r3] km above W.base where a cloud-to-sea channel starts (+0-0.35)
  WX.param("bolt.halo", 0.1, 0, 0.5, 0.005, "bolt");        // [r4] the halo's gain in the view (x the energy, <= bolt.haloCap)
  WX.param("bolt.haloDrops", 0.25, 0, 1, 0.005, "bolt");    // [r4] ... in the drops' lenses
  WX.param("bolt.haloCap", 40, 1, 400, 1, "bolt");          // [r4] the channel's energy for the halo, pre-exposed, at most (x2.5 at night)
  WX.param("bolt.foot", 0.6, 0, 2, 0.05, "bolt");           // [r4] the main channel brighter and wider toward its attachment
  /* [r6] the white core reaches the lit base: REVIEW-5 saw bolts that start inside the base's glow, 150-250 px tall at 1080p
     (round 5 tapered the core from 80 m UNDER the base over 60 m, so it was grey before the base and the glow hid its top).
     Now the taper starts 60 m into the deck and e-folds over 120 m (the cloud in front still dims it, floor .15): the
     channel stays white up to the lit base and fades into it (g-squall at 4 km: ~180 -> ~260 px) */
  WX.param("bolt.coreUp", 60, -200, 400, 10, "bolt");       // [r6] m above W.base where the white core's taper starts (r5 -80)
  WX.param("bolt.coreTaper", 120, 20, 400, 5, "bolt");     // [r6] ... and its e-folding length, m (r5 60)
  const MAXSEG = 1700;
  let P = null, quad = null, layer = null, layerFb = null;
  const slot = [0, 1].map(() => ({ buf: null, vao: null, n: 0, seed: -1, kind: -1, data: new Float32Array(MAXSEG * 8),
    st: new Float32Array(6), sa: new Float32Array(6), ns: 0 }));
  const U = { uB: 0, uGain: 30, uBase: 400, uCore: 6, uHaloCap: 40, uCoreUp: new Float32Array([60, 120]) };
  const on = new Float32Array(4);
  let layerOn = false;
  /* a seeded generator per strike */
  function rng(seed) {
    let s = (Math.floor(seed * 4294967295) ^ 0x9e3779b9) >>> 0;
    return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const pts = new Float32Array((1 << 8) * 3 + 3);
  function build(sl, f, baseKm, topKm, footK) {
    const rnd = rng(f.seed), out = sl.data;
    let n = 0;
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(6.2832 * rnd());
    /* the channel's own return strokes: 2-5, 30-90 ms apart, the first the brightest */
    sl.ns = 2 + Math.floor(rnd() * 4);
    let tt = 0;
    for (let k = 0; k < sl.ns; k++) { sl.st[k] = tt; sl.sa[k] = k ? 0.45 + 0.5 * rnd() : 1; tt += 0.03 + 0.06 * rnd(); }
    /* midpoint displacement between a and b: 2^lv pieces, each written as a segment of brightness br */
    function channel(a, b, lv, rough, br, wid, list, bow, foot) {
      const m = 1 << lv;
      pts[0] = a[0]; pts[1] = a[1]; pts[2] = a[2]; pts[m * 3] = b[0]; pts[m * 3 + 1] = b[1]; pts[m * 3 + 2] = b[2];
      /* the displacement grows with the level: a fairly straight path overall, tortuous in its small kinks (1.22 x
         rough at the finest), as photographs show. [r3c] The coarse levels displace little (0.12 x rough on the
         whole span, rising as the 1.5 power): at 0.35 x they cut the channel into 4-8 straight legs with sharp
         corners, the "wide regular kinks" of a scribble (E, round 5); the overall bend is a smooth bow instead */
      let lev = 0;
      for (let step = m; step > 1; step >>= 1, lev++) {
        const rl = rough * (0.12 + 1.1 * Math.pow(lev / Math.max(1, lv - 1), 1.5));
        for (let i = 0; i < m; i += step) {
          const j = i + step, k = i + (step >> 1);
          const ax = pts[i * 3], ay = pts[i * 3 + 1], az = pts[i * 3 + 2], bx = pts[j * 3], by = pts[j * 3 + 1], bz = pts[j * 3 + 2];
          const L = Math.hypot(bx - ax, by - ay, bz - az) * rl;
          pts[k * 3] = (ax + bx) / 2 + gauss() * L; pts[k * 3 + 1] = (ay + by) / 2 + gauss() * L * 0.35; pts[k * 3 + 2] = (az + bz) / 2 + gauss() * L;
        }
      }
      if (bow) for (let i = 1; i < m; i++) {
        const w = Math.sin(3.1416 * i / m);
        pts[i * 3] += bow[0] * w; pts[i * 3 + 2] += bow[1] * w;
      }
      for (let i = 0; i < m && n < MAXSEG; i++) {
        const o = n * 8;
        /* [r4] foot: the main channel brightens and thickens toward its attachment, where the return stroke starts
           (the lowest few per cent most: the attachment's flash) */
        const u = i / m, fr = foot ? 1 + foot * (u * u - 0.35 + 1.5 * Math.max(u - 0.94, 0) / 0.06) : 1;
        out[o] = pts[i * 3]; out[o + 1] = pts[i * 3 + 1]; out[o + 2] = pts[i * 3 + 2]; out[o + 3] = br * fr * (1 - 0.3 * u * (list ? 0 : 1));
        out[o + 4] = pts[i * 3 + 3]; out[o + 5] = pts[i * 3 + 4]; out[o + 6] = pts[i * 3 + 5]; out[o + 7] = wid * (foot ? 1 + 0.5 * foot * u * u : 1);
        n++;
      }
      if (list) for (let i = 0; i <= m; i++) list.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
    }
    const base = baseKm * 1000;
    const cx = f.pos[0] * 1000, cz = f.pos[2] * 1000;
    if (f.kind >= 0.5) {
      const dist = Math.hypot(cx, cz), dist0 = dist, footY = -dist * dist / (2 * WX.R_G * 1000) - 1;
      const topY = base + (topKm + 0.35 * rnd()) * 1000, H = topY - footY;
      const top = [cx + gauss() * 120, topY, cz + gauss() * 120];
      const foot = [cx + (rnd() - 0.5) * 0.45 * H, footY, cz + (rnd() - 0.5) * 0.45 * H];
      const main = [], n0 = n;
      channel(top, foot, 8, 0.2, 1, 1, main, [gauss() * 0.07 * H, gauss() * 0.07 * H], footK);
      /* [r4] the channel leaves the base exactly under the flash's centre (uFlash.xz, at W.base): where the sky lights
         the base round it (the A/C agreement of round 4, notes/sky.md). Shift the whole channel sideways */
      let ib = 0;
      while (ib < 255 && main[(ib + 1) * 3 + 1] > base) ib++;
      const y0 = main[ib * 3 + 1], y1 = main[ib * 3 + 4], tb = y0 > y1 ? Math.min(Math.max((y0 - base) / (y0 - y1), 0), 1) : 0;
      const sx = cx - (main[ib * 3] + (main[ib * 3 + 3] - main[ib * 3]) * tb), sz = cz - (main[ib * 3 + 2] + (main[ib * 3 + 5] - main[ib * 3 + 2]) * tb);
      for (let q = 0; q < main.length; q += 3) { main[q] += sx; main[q + 2] += sz; }
      for (let q = n0; q < n; q++) { const o = q * 8; out[o] += sx; out[o + 2] += sz; out[o + 4] += sx; out[o + 6] += sz; }
      /* branches: from the part below the base mostly (in the cloud they would only smear the column), the upper
         part of it first, downward and outward, a third to a half of what is left */
      let i0 = 3;
      while (i0 < 200 && main[i0 * 3 + 1] > base + 120) i0++;
      /* [r5] not from the base itself: a fork leaving the channel where it meets the base read as a sharp horizontal hook
         (REVIEW-4 clip a); the forks start a tenth of the way down the visible channel or lower */
      const iVis = i0;
      while (i0 < 200 && main[i0 * 3 + 1] > base - 0.1 * (base - footY)) i0++;
      if (i0 >= 200) i0 = iVis;
      /* [r3] few and short (the day photographs show one clean channel with a handful of forks; a bush of long
         branches read as CG) */
      const nb = 3 + Math.floor(rnd() * 6);
      for (let k = 0; k < nb; k++) {
        const at = Math.min(250, i0 + Math.floor(Math.pow(rnd(), 1.6) * 0.75 * (256 - i0)));
        const a = [main[at * 3], main[at * 3 + 1], main[at * 3 + 2]];
        const h = a[1] - footY, len = h * (0.08 + 0.36 * rnd() * rnd());
        /* [r3c] outward mostly across the line of sight (+-40 deg of the screen's sideways): a branch heading toward or
           away from the eye ran down beside the channel on screen, a parallel twin of it */
        const sv = rnd() < 0.5 ? -1 : 1, ph = (rnd() - 0.5) * 1.4, vx = cx / Math.max(dist0, 1), vz = cz / Math.max(dist0, 1);
        const ox = sv * -vz * Math.cos(ph) + vx * Math.sin(ph), oz = sv * vx * Math.cos(ph) + vz * Math.sin(ph);
        const ang = Math.atan2(oz, ox), out1 = 0.7 + 0.7 * rnd();
        const b = [a[0] + ox * len * out1, Math.max(footY + 5, a[1] - len * (0.4 + 0.35 * rnd())), a[2] + oz * len * out1];
        const twig = [];
        const br = (0.12 + 0.28 * rnd()) * (1 - 0.4 * at / 256);
        const lv = len > 350 ? 6 : 5;
        channel(a, b, lv, 0.24, br, 0.62, twig);
        const nt = Math.floor(rnd() * 2.5);
        for (let q = 0; q < nt; q++) {
          const at2 = 2 + Math.floor(rnd() * ((1 << lv) - 6));
          const a2 = [twig[at2 * 3], twig[at2 * 3 + 1], twig[at2 * 3 + 2]], l2 = len * (0.15 + 0.3 * rnd()), an2 = ang + (rnd() - 0.5) * 2.2;
          channel(a2, [a2[0] + Math.cos(an2) * l2 * 0.75, Math.max(footY + 5, a2[1] - l2 * 0.6), a2[2] + Math.sin(an2) * l2 * 0.75], 4, 0.26, br * 0.5, 0.45, null);
        }
      }
    }
    sl.n = n;
  }
  /* the channel's own strokes at age a: the brightest stroke's exponential, a continuing current between them */
  function strokes(sl, a) {
    let B = 0;
    for (let k = 0; k < sl.ns; k++) { const d = a - sl.st[k]; if (d >= 0) B = Math.max(B, sl.sa[k] * Math.exp(-d / 0.022)); }
    if (a >= 0 && a < sl.st[sl.ns - 1] + 0.05) B = Math.max(B, 0.16);
    return B;
  }
  /* the strikes of this frame into the layer (r core, g glow), MAX-blended and depth-tested against the scene's
     depth: post adds it after the flash limit. Nothing is drawn into the picture */
  const ZERO4 = new Float32Array(4);
  function draw(R, F) {
    const gl = R.gl;
    let any = false;
    for (let k = 0; k < 2; k++) {
      const f = F.flashes[k], s = slot[k];
      if (!f || !(f.B > 1e-3 || f.I > 0) || F.still) continue;
      if (f.seed !== s.seed || f.kind !== s.kind) {
        s.seed = f.seed; s.kind = f.kind;
        build(s, f, F.W.base, R.p("bolt.top"), R.p("bolt.foot"));
        if (s.n) { gl.bindBuffer(gl.ARRAY_BUFFER, s.buf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, s.data, 0, s.n * 8); }
      }
      if (!s.n || !layerFb) continue;
      if (!any) {
        R.bind(layerFb);
        gl.clearBufferfv(gl.COLOR, 0, ZERO4);
        gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false);
        gl.enable(gl.BLEND); gl.blendEquation(gl.MAX); gl.blendFunc(gl.ONE, gl.ONE);
        P.use();
        any = true;
      }
      /* the return strokes (the director's and the channel's own), then the afterglow with the area envelope */
      U.uB = Math.max(f.B, (f.P || 0) * strokes(s, f.age || 0)) + 0.3 * (f.level || 0) * (f.P || 0);
      U.uGain = R.p("bolt.gain"); U.uBase = F.W.base * 1000; U.uCoreUp[0] = R.p("bolt.coreUp"); U.uCoreUp[1] = R.p("bolt.coreTaper"); U.uCore = R.p("bolt.core"); U.uHaloCap = R.p("bolt.haloCap");
      R.gpu.uniforms(P, U);
      gl.bindVertexArray(s.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, s.n);
    }
    if (any) { gl.bindVertexArray(null); gl.disable(gl.DEPTH_TEST); gl.depthMask(true); gl.blendEquation(gl.FUNC_ADD); gl.disable(gl.BLEND); }
    layerOn = any;
    if (R.priv.boltLayer) R.priv.boltLayer.on = any;
  }
  /* the "boltlit" library's uniforms, for post's programs */
  function fill(u, F, R) {
    const h = R && R.priv.boltHalo;
    on[0] = layerOn ? 1 : 0; on[1] = layerOn && h && h.on ? 1 : 0;
    /* by day the halo carries more (its glow is what lets a channel read against a bright deck); at night the dark frame
       shows it at the plain gain */
    if (R) { const dayK = 1 - WX.util.smooth(300, 3000, R.exposure.E || 0); on[2] = R.p("bolt.halo") * (1 + 0.6 * dayK); on[3] = R.p("bolt.haloDrops"); }
    u.uBoltL = layer; u.uBoltOn = on; u.uBoltH = h && h.tex ? h.tex : layer;
  }
  return {
    name: "bolt",
    *build(R) {
      for (const s of slot) { s.buf = s.vao = null; s.n = 0; s.seed = -1; }
      layer = layerFb = null; layerOn = false;
      P = R.program("bolt.ribbon", { libs: ["atmo"], vs: `
        layout(location = 0) in vec2 aPos; layout(location = 1) in vec4 aA; layout(location = 2) in vec4 aB;
        uniform float uB, uGain, uBase, uCore, uHaloCap;
        flat out vec4 vSeg; flat out vec3 vP0, vP1; flat out vec2 vK;
        void main() {
          /* unjittered: the layer is added to the resolved picture (uTaa.xy is 0 when drawn in the bolt slot) */
          vec4 ca = wxClip(aA.xyz), cb = wxClip(aB.xyz);
          ca.xy -= 2. * uTaa.xy * uRes.zw * ca.w; cb.xy -= 2. * uTaa.xy * uRes.zw * cb.w;
          /* clip the piece to the near plane's front */
          if (ca.w < 1. || cb.w < 1.) { gl_Position = vec4(2., 2., 2., 1.); return; }
          vec2 pa = (ca.xy / ca.w * .5 + .5) * uRes.xy, pb = (cb.xy / cb.w * .5 + .5) * uRes.xy;
          vec2 d = pb - pa; float l = length(d);
          vec2 dir = l > 1e-3 ? d / l : vec2(0., 1.), n = vec2(-dir.y, dir.x);
          /* the quad reaches the glow; wider where the piece is in the cloud (a glowing column) */
          float sc = uRes.y / 820., dz = max(.5 * (aA.y + aB.y) - uBase, 0.);
          float hw = (6. + 4. * aB.w) * sc * (1. + 2.5 * smoothstep(150., 700., dz)) * (1. + .8 * smoothstep(300., 3000., uExpo.x));
          float t = aPos.x * .5 + .5;
          vec2 px = mix(pa - dir * hw, pb + dir * hw, t) + n * aPos.y * hw;
          vec4 c = mix(ca, cb, t);
          gl_Position = vec4((px * uRes.zw * 2. - 1.) * c.w, c.z, c.w);
          vSeg = vec4(pa, pb); vP0 = aA.xyz; vP1 = aB.xyz; vK = vec2(aA.w, aB.w);
        }`, fs: `
        uniform float uB, uGain, uBase, uCore, uHaloCap; uniform vec2 uCoreUp;
        flat in vec4 vSeg; flat in vec3 vP0, vP1; flat in vec2 vK; out vec4 o;
        void main() {
          vec2 pa = vSeg.xy, pb = vSeg.zw, ba = pb - pa;
          vec2 fp = gl_FragCoord.xy;
          float t = clamp(dot(fp - pa, ba) / max(dot(ba, ba), 1e-6), 0., 1.);
          float dpx = length(fp - pa - ba * t);
          vec3 p = mix(vP0, vP1, t), eye = vec3(0., wxEye, 0.), v = p - eye;
          float dist = length(v);
          /* behind the curved sea: the point is under it, or the sea's bulge stands between */
          float drop = dot(p.xz, p.xz) / (2. * R_G * 1000.);
          if (p.y < -drop) discard;
          float hd = length(v.xz), sx = (wxEye - p.y) * R_G * 1000. / max(hd * hd, 1.);
          if (sx > 0. && sx < 1. && wxEye + (p.y - wxEye) * sx + sx * sx * hd * hd / (2. * R_G * 1000.) < 0.) discard;
          vec4 ap = wxAerial(v / dist, dist * 1e-3);
          float T = ap.a, Ti = sqrt(T), sc = uRes.y / 820.;
          /* in the cloud (above the base): dimmed by the cloud in front (the cloud buffer's transmittance at this
             pixel, never under .15: the A/C agreement), softened and fading with the depth into the deck: a trunk
             going up into it, lit round by the sky's flashVol */
          float dz = max(p.y - uBase, 0.), df = smoothstep(100., 600., dz);
          float fade = mix(1., max(texture(sCloud, gl_FragCoord.xy * uRes.zw).a, .15), smoothstep(0., 150., dz)) * exp(-max(dz - 80., 0.) / 380.);
          /* the core: sigma 0.7 px x sqrt(scale) on the main channel (2-3 px across), less on branches */
          float cw = (.5 + .5 * vK.y) * .7 * sqrt(max(sc, .5)) * (1. + .35 * df);   // thin to the top: a fading line, not smoke
          /* [r4] at night the white core reads wider (a dark-adapted eye, the photographs' overexposed channel): it stays
             the brightest thing inside its own halo */
          cw *= 1. + .5 * smoothstep(300., 3000., uExpo.x) * (1. - df);
          float core = exp(-.5 * dpx * dpx / (cw * cw));
          /* at night (a dark-adapted eye, a dark sky) the glow reaches further and brighter, as night photographs show */
          float nk = smoothstep(300., 3000., uExpo.x);
          float sg = (1.5 + 2.5 * (1. - T)) * sc * (1. + 3. * df) * (1. + .8 * nk);
          /* the channel outshines anything it is seen against: the core is compressed softly to uCore (white, a
             narrow tail), the glow to a few px of blue-white whose reach grows with the air, never the intensity */
          /* the ceiling is reached with the stroke's full brightness; the strokes, their decay and the afterglow then
             scale it linearly, so the channel fades to nothing with the envelope instead of staying white until it
             ends (the one-frame pop E measured) */
          float X = .5 * uGain * vK.x * uExpo.x, Bn = min(uB, 1.2);
          /* [r4] the white core goes only ~0.2 km into the deck (a storm's base is optically thick: the channel leaves it,
             it is not seen inside it); above that the trunk is the glow and the halo, which keep the 0.4 km fade (the
             A/C agreement): a lit column in the cloud, not a white line ending in a grey sky (x17 with the core at 20) */
          /* [r5] the core is far over white (uCore 20), so a linear fade above the base left it clipped white up to the
             base and grey a few px later: a sharp end, read as a hook where the channel met the base (REVIEW-4 a f241).
             Now it tapers on the log scale the eye sees, from 80 m under the base: white -> grey over ~200 m, into the
             lit base (A's lump). [r6] From bolt.coreUp (60 m) into the deck over bolt.coreTaper (120 m): white to the base */
          float cv = uCore * (1. - exp(-X * Ti / uCore)) * Bn * fade * exp(-max(p.y - uBase - uCoreUp.x, 0.) / uCoreUp.y) * core;
          float gv = min(X * .004 * (Ti + .5 * (1. - T)), mix(.09, .2, nk)) * Bn * fade * (1. - .5 * df) * exp(-dpx / sg);
          /* [r4] the halo's energy: the core's radiance under a higher ceiling (the foot's extra brightness shows in the
             halo, whose blur post spreads over 4-64 px), the cloud's dimming as the core's */
          float hv = min(X / max(vK.x, 1e-3) * Ti, uHaloCap * mix(1., 1.5, nk)) * vK.x * Bn * fade * core;    // the piece's own brightness after the ceiling
          o = vec4(cv, gv, hv, 1.);
        }` });
      yield* R.wait(P);
      R.priv.boltDraw = draw;
      R.priv.boltFill = fill;
      const gl = R.gl;
      quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      for (const s of slot) {
        s.buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, s.buf);
        gl.bufferData(gl.ARRAY_BUFFER, s.data.byteLength, gl.DYNAMIC_DRAW);
        s.vao = gl.createVertexArray();
        gl.bindVertexArray(s.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, s.buf);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 0); gl.vertexAttribDivisor(1, 1);
        gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16); gl.vertexAttribDivisor(2, 1);
        gl.bindVertexArray(null);
      }
    },
    resize(R) {
      const gl = R.gl, S = R.size.S;
      if (layer) { gl.deleteTexture(layer.tex); gl.deleteFramebuffer(layerFb.fb); }
      gl.bindFramebuffer(gl.FRAMEBUFFER, R.target("scene").fb);
      const depth = gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      layer = R.gpu.tex2D(S[0], S[1], "rgba16f");      // [r4] b: the halo's energy
      layerFb = R.gpu.fbo([layer], depth);
      layerOn = false;
      R.priv.boltLayer = { tex: layer, on: false };
    },
    slots: {
      bolt(R, F) {
        /* with TAA on, post's taa slot draws the layer (after the resolve, never into the history) */
        if (!R.taa.on) draw(R, F);
      },
    },
  };
})());
