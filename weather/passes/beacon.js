/* ═══════════════════════ Weather: the lighthouse (stream L, rounds 7-8) ═══════════════════════
   The user's asks (2026-11-26): "a lighthouse ... whose lamp is the accent colour; not overwhelming the whole scene";
   round 8: "I want the lighthouse next to the end of the right side rock. It's too small to notice." Contract section
   10 (1.4) has the shared part: WX.BEACON, R.beacon, the uBeacon* fields and wxBeacon.

   WHERE (round 8): on a granite stack just off the seaward tip of the right head (the leftmost point of its cliffs seen
   from the window, about 78 % across a 16:9 view), a little left of the cliff's end and beyond it, with a few rocks
   awash between: a rock lighthouse at the end of a headland, as La Vieille stands off the Pointe du Raz. 1.53 km out.
   WHAT: a granite tower 65 m tall on a stack 14 m high (the lamp 70 m over the sea: Ile Vierge's focal plane; Fastnet's
   and Bishop Rock's build): a battered plinth, a concave shaft with small windows and a door at the top of its solid
   base, a corbelled gallery with a railing, the glazed lantern, a dark dome with its ventilator and finial. The lamp
   stands ~53 px over the waterline at 1080p (round 7: 18 px at 3 km), ~75 device px on the user's panel.

   WHAT IT DRAWS
   - coast slot: a light probe at the lighthouse (10 x 1: its sun, moon and sky light, the clouds' shadow, the air and the
     rain's medium between it and the window, the air of its reflection's last leg), then the stack, its rocks and the
     tower into SCENE, SCENEZ and depth, as the cove draws its pieces: lit by the probe, the cove's shadow (wxSunShadow),
     the tower's own shadow on the rock and the gallery's on the shaft, the strikes (wxFlashE), behind the air (wxAerial)
     and the rain in front. And its reflection: on the world frames the cove redraws its mirror (COASTREFL), the stack and
     the tower are drawn into it under the cove (they stand behind every piece of it), and the mips are made again.
   - bolt slot (added to SCENE before the TAA, so it is jittered and resolved with the rest): one scissored draw round
     the lamp: its core (a sub-pixel point, energy-normalised so the jitter cannot make it crawl) and the aureole damp
     air scatters it into, both as bright as the lamp is toward the window (the flash when a beam points at it); and the
     beams' shafts in the air: single scattering of the two beams along each view ray, integrated in the angle the ray
     subtends at the lamp (equiangular: the 1/r^2 is exact), only over the arc of the ray inside a beam and within its
     reach of the lamp. Never over the whole view: the shafts fade out within a third of the lamp's distance of it, so
     they stay within about 15 deg of it ([r9] as a gaussian of that reach, from the lamp out: seen end on, as a beam
     passes the window, round 8's full strength to .45 of it drew a plateau with an edge, an oval disc ~75 px across in
     the night storm). Their light, the core's and the glow's are marked in SCENE's alpha (-Y, the
     lamp light's pre-exposed luminance; everything else writes 0..1), so post grades it as the cones see a lamp, past
     the rods' night shift (round 8: the night grade had turned the dim red glow mauve).
   The sea's path under the lamp is the ocean's (stream W: wxBeacon, R.beacon); the glare of a bright lamp through the
   wet pane is post's and the pane's, as for the cove's lamps (both work on SCENE).

   HOLDS AT ANY READING (rule 1): the beams turn on the sea's clock, a turn every WX.BEACON.turn s (16 divides 1024: no
   seam at the wrap); the lamp's colour eases to the page's accent and stands on it; the photocell follows the light of
   the scene. Nothing accumulates. */
WX.pass((function () {
  const U = WX.util, D2R = Math.PI / 180, K = WX.BEACON;
  const P = {};
  let geo = null, probe = null, refl = null, reflDue = true;
  /* the lamp's colour: eased in linear light (each channel by WX.easeStep at the reading's own w), the lamp drawn at
     unit luminance */
  const col = { c: [0, 0, 0], r: [0, 0, 0], w: [0, 0, 0], tgt: [0, 0, 0], last: [-1, -1, -1], seen: false };
  const es = new Float64Array(2);
  /* the bolt slot's uniforms, made once */
  const uL = new Float32Array(4), uL2 = new Float32Array(4), uS = new Float32Array(4), uS2 = new Float32Array(4), uF = new Float32Array(4), uF2 = new Float32Array(4);
  const box = [0, 0, 0, 0];
  /* uniform objects and the sector's sample points, made once: nothing is allocated per frame (DESIGN 2.5 rule 4) */
  const uMid = new Float32Array(4), uFoot = new Float32Array(4), uLeg = new Float32Array(4), uBase = new Float32Array(4), uTw = new Float32Array(4);
  const forcedRgb = [0, 0, 0];
  const PROBE_VP = { viewport: [0, 0, 10, 1] }, uniP = { uMid, uFoot, uLeg }, uniT = { uProbe: null, uBase, uTw, uMirror: 0 };
  const uniL = { uProbe: null, uL, uL2, uS, uS2, uF, uF2 };
  const SECT_A = [-1, 0, 1], SECT_R = [0.12, 0.35, 1], SECT_H = [-1, 1];
  /* the stack, the rocks and the tower, in the model's frame (m; y up from the still sea; x and z the world's) */
  const CROWN = 14.2, FOOT = 12.8, GAL = 65.4, RC = 5.6;
  /*@lab*/
  WX.param("beacon.az", K.az, -45, 45, 0.1, "beacon");          // deg right of the view's centre
  WX.param("beacon.km", K.km, 0.8, 12, 0.01, "beacon");         // km from the window
  WX.param("beacon.lamp", 1, 0, 20, 0.05, "beacon");            // the lantern's steady glow x this
  WX.param("beacon.beam", 1, 0, 20, 0.05, "beacon");            // the beams' intensity x this (the flash and the shafts)
  WX.param("beacon.shaft", 1, 0, 20, 0.05, "beacon");           // the shafts alone x this
  WX.param("beacon.air", 0.15, 0, 3, 0.01, "beacon");           // km^-1: the least scattering the beams find in the air near the sea
  WX.param("beacon.reach", 0.3, 0.05, 1, 0.01, "beacon");       // the shafts fade out by this share of the lamp's distance from it ([r9] a gaussian, e^-3 there)
  WX.param("beacon.rgb", -1, -1, 16777215, 1, "beacon");        // a forced accent 0xRRGGBB (-1: the page's, or the reading's)
  WX.param("beacon.hold", 0, 0, 1, 1, "beacon");                // 1: the beams hold, pointing 90 deg off the window (a still's pose)
  WX.param("beacon.face", -1, -1, 360, 1, "beacon");            // >= 0: beam 1 holds at this many deg past the window's bearing (0: the flash)
  WX.param("beacon.on", 1, 0, 1, 1, "beacon");                  // 0: no lighthouse (for a paired A/B of its cost)
  WX.param("beacon.mirror", 1, 0, 1, 1, "beacon");              // 0: not drawn into the cove's mirror
  WX.param("beacon.mark", 1, 0, 1, 1, "beacon");                // 0: the lamp's light is not marked for post (the round-7 grade)
  WX.param("beacon.flash", 0.06, 0, 0.5, 0.005, "beacon");       // the share of the flash's light in its glare round the lamp
  /*@end*/

  /* ── the model ── */
  /* materials: 0 rock, 1 the tower's granite, 2 dark metal (the gallery's deck and lip, the sill, the finial), 3 the
     lantern's glazing, 4 the dome, 5 the railing (a band drawn at its coverage) */
  function model() {
    const V = [], I = [];
    const vert = (x, y, z, nx, ny, nz, m) => { V.push(x, y, z, nx, ny, nz, m); return V.length / 7 - 1; };
    const hash = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };
    /* a lathe: profile [[r, y, mat], ...] round the y axis, each segment its own band (crisp edges between them), smooth
       round the axis; its triangles face outward (counter-clockwise by the right hand, as glTF's) */
    function lathe(pr, n) {
      for (let s = 0; s + 1 < pr.length; s++) {
        const [r0, y0, m] = pr[s], [r1, y1] = pr[s + 1];
        if (r0 === r1 && y0 === y1) continue;
        let nr = y1 - y0, ny = r0 - r1;
        const l = Math.hypot(nr, ny) || 1; nr /= l; ny /= l;
        const base = V.length / 7;
        for (let k = 0; k <= n; k++) {
          const a = (k / n) * 2 * Math.PI, c = Math.cos(a), si = Math.sin(a);
          vert(r0 * c, y0, r0 * si, nr * c, ny, nr * si, m);
          vert(r1 * c, y1, r1 * si, nr * c, ny, nr * si, m);
        }
        for (let k = 0; k < n; k++) {
          const a = base + 2 * k;
          I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);         // by the right hand along (nr, ny): a band running down faces in
        }
      }
    }
    /* a rock: rings [R, y] from the crown down, round (ox, oz), stretched ex along the bearing phi, its outline wobbled
       by a few harmonics and roughened per vertex (rough, more down its sides); flat-shaded facets (granite's joints),
       each triangle its own normal, facing out or up */
    function rock(ox, oz, RINGS, N, ex, phi, seed, rough) {
      const cp = Math.cos(phi), sp = Math.sin(phi), pos = [];
      for (let j = 0; j < RINGS.length; j++) {
        const [R0, y0] = RINGS[j], row = [], side = Math.min(1, j / 3);
        for (let k = 0; k < N; k++) {
          const a = (k / N) * 2 * Math.PI;
          const wob = 1 + (0.14 * Math.sin(2 * a + 0.7 + seed) + 0.08 * Math.sin(3 * a + 2.1 + 2 * seed) + 0.05 * Math.sin(5 * a + 1.3 * seed)) * (0.3 + 0.7 * side)
                    + rough * side * (hash(k + seed * 13, j) - 0.5);
          const u = R0 * wob * Math.cos(a) * ex, v = R0 * wob * Math.sin(a);
          const dy = j > 0 && j < RINGS.length - 1 ? rough * 0.35 * Math.max(R0, 2) * (hash(k + 7 + seed, j + 3) - 0.5) * side : 0;
          row.push([ox + u * cp - v * sp, y0 + dy, oz + u * sp + v * cp]);
        }
        pos.push(row);
      }
      const tri = (a, b, c) => {
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz);
        if (l < 1e-6) return;
        nx /= l; ny /= l; nz /= l;
        const mx = (a[0] + b[0] + c[0]) / 3 - ox, mz = (a[2] + b[2] + c[2]) / 3 - oz;
        if (nx * mx + nz * mz + ny * 2 < 0) { const t = b; b = c; c = t; nx = -nx; ny = -ny; nz = -nz; }   // outward, by the right hand
        I.push(vert(a[0], a[1], a[2], nx, ny, nz, 0), vert(b[0], b[1], b[2], nx, ny, nz, 0), vert(c[0], c[1], c[2], nx, ny, nz, 0));
      };
      for (let j = 0; j + 1 < pos.length; j++) for (let k = 0; k < N; k++) {
        const k1 = (k + 1) % N, a = pos[j][k], b = pos[j][k1], c = pos[j + 1][k], d = pos[j + 1][k1];
        tri(a, c, b); tri(b, c, d);
      }
    }
    /* the stack: a crown 14 m up, broad enough for the tower's plinth (r 7.4) with room round it, its shoulder, cliffs of
       jointed granite to a wave-cut ledge awash, and a skirt 11 m under the sea (so the waterline is the sea's own).
       Longer along the line from the cliff's end out to sea, as the head runs on under the water */
    const along = Math.atan2(0.89, -0.47);
    rock(0, 0, [[0, CROWN], [5, CROWN - 0.15], [9.6, CROWN - 0.8], [11.6, CROWN - 2.4], [12.9, 9.6], [14, 5.6], [15.2, 2.4],
                [16.6, 0.8], [18.6, 0.05], [20.5, -2], [23.5, -6.5], [26, -11]], 28, 1.22, along, 0.3, 0.24);
    /* a lower crag on the stack's seaward shoulder, and rocks awash between the stack and the cliff's end (37 m off,
       toward +x and the window), and two beyond it: the head running on under the sea to the stack */
    rock(-9, 12, [[0, 9.5], [3.5, 8.6], [6, 5.5], [7.5, 1.5], [9, -0.6], [11, -4]], 11, 1.35, along + 0.6, 7.7, 0.4);
    for (const [x, z, R, h, sd] of [[8, -24, 5.5, 3.6, 1.1], [12, -33, 4.2, 2.2, 2.3], [3, -15, 3.2, 1.4, 3.7], [-15, 22, 3.8, 1.6, 4.9], [9, 24, 2.8, 0.9, 6.1]])
      rock(x, z, [[0, h], [0.55 * R, 0.82 * h], [R, 0.3 * h], [1.3 * R, -0.5], [1.7 * R, -3.5]], 9, 1.3, along + sd, sd, 0.35);
    const nRock = I.length;
    /* the tower: a rock lighthouse's granite, its plinth battered and set back, the solid base, the shaft a concave taper
       (6.3 m to 3.75 m), a corbel flaring to the gallery, the gallery's deck and lip, the lantern's pedestal and sill,
       the glazing centred on the lamp's focal plane (K.lampM), the dome, the ventilator ball and the finial. 20 sides: at
       1.5 km the tower is 8-11 px wide at 1080p, the shading across it reads */
    /* each point [r, y, the material of the segment that starts there] */
    const f = K.lampM;
    const prof = [[7.4, FOOT, 1], [7.1, 15.6, 1], [6.5, 15.9, 1], [6.3, 19.5, 1]];
    for (let k = 1; k <= 7; k++) { const s = k / 7; prof.push([3.75 + 2.55 * Math.pow(1 - s, 1.6), 19.5 + (63.6 - 19.5) * s, 1]); }
    prof.push([4.15, 64.6, 1], [4.75, GAL, 2], [4.75, GAL + 0.35, 2], [2.95, GAL + 0.35, 1]);          // the corbel, the lip, the deck
    prof.push([2.95, f - 2.6, 2], [2.7, f - 2.6, 3], [2.7, f + 2.6, 4]);                              // the pedestal, the sill, the glazing
    prof.push([2.95, f + 2.6, 4], [2.4, f + 3.6, 4], [1.5, f + 4.5, 4], [0.55, f + 5.1, 4], [0.55, f + 5.35, 4]);   // the eave, the dome
    prof.push([0.75, f + 5.6, 4], [0.75, f + 6.1, 4], [0.3, f + 6.5, 2], [0.1, f + 6.5, 2], [0.1, f + 8.3, 2], [0, f + 8.4, 2]);   // the ventilator, the finial
    lathe(prof, 20);
    /* the railing: a band 1.1 m tall round the gallery, drawn at its coverage (the posts and rails of a 1 m railing are
       far under a pixel at 1.5 km: it darkens the lip and lets the lantern's base show through) */
    lathe([[4.6, GAL + 0.35, 5], [4.6, GAL + 1.45, 5]], 20);
    lathe([[4.6, GAL + 1.45, 5], [4.6, GAL + 0.35, 5]], 20);
    return { v: new Float32Array(V), i: new Uint16Array(I), nRock };
  }

  /* ── GLSL ── */
  /* the probe: 10 texels a world frame at the lighthouse. 0 the sun's illuminance, 1 the moon's, 2-4 the sky's light from
     above, the side and below (irradiance / pi), 5 the air between it and the window (rgb in-scatter, a transmittance),
     6 the rain's medium in front of it (the cloud buffer's sea rays just short of its foot: rgb, a), 7 x the clouds'
     shadow on it (for the key light), y their mean shadow, 8 the air of its reflection's last leg (from the sea point
     the window sees its middle at, up to it), 9 the swell's sets at the stack (stream W's wxSwellSet when the ocean has
     it: x the envelope over the swell's rms, ~0 in a lull to ~1.9 a set's biggest, y the crests' phase rad, 0 as one
     passes; without it 1 and the swell's own phase) */
  const PROBEFS = `
    uniform vec4 uMid;      // xyz the tower's middle, world m
    uniform vec4 uFoot;     // xyz a point on the sea 60 m short of the stack's waterline, toward the window
    uniform vec4 uLeg;      // xyz the direction of the reflection's last leg, w its length km
    out vec4 o;
    void main() {
      int i = int(gl_FragCoord.x);
      vec3 e = vec3(0., wxEye, 0.), pm = uMid.xyz, pk = wxPlanet(pm);
      vec3 c = vec3(0.); float a = 1.;
      if (i == 0) c = wxSunLight(pk);
      else if (i == 1) c = wxMoonLight(pk);
      else if (i < 5) c = wxAmbient(i == 2 ? 1. : i == 3 ? .5 : 0.);
      else if (i == 5) { vec3 d = pm - e; float l = length(d); vec4 ap = wxAerial(d / l, l * 1e-3); c = ap.rgb; a = ap.a; }
      else if (i == 6) {
        if (uWx1.y > 0.) {
          vec2 uv = wxUV(normalize(uFoot.xyz - e));
          if (all(greaterThan(uv, vec2(0.))) && all(lessThan(uv, vec2(1.)))) { vec4 m = wxCloudAt(uv); c = m.rgb; a = m.a; }
        }
      } else if (i == 7) c = vec3(wxCloudShadow(pm), wxCloudShadowMean(), 0.);
      else if (i == 8) { vec4 ap = wxAerial(uLeg.xyz, uLeg.w); c = ap.rgb; a = ap.a; }
      else if (i == 9) {
#ifdef BC_SETS
        c = vec3(wxSwellSet(uMid.xz), 0.);
#else
        c = vec3(1., mod(uTime.x * 6.2831853 / uSwell.z - 6.2831853 * 6.2831853 / (9.81 * uSwell.z * uSwell.z) * dot(normalize(uSwell.xy), uMid.xz), 6.2831853), 0.);
#endif
        o = vec4(c, 1.); return;
      }
      o = vec4(wxGuard(c), clamp(a, 0., 1.));
    }`;
  const TOWERVS = `
    layout(location = 0) in vec3 aP; layout(location = 1) in vec3 aN; layout(location = 2) in float aM;
    uniform vec4 uBase;     // xyz the stack's origin, world m (at the sea's level, before the curvature)
    uniform float uMirror;  // > 0: drawn mirrored in the still sea plane (COASTREFL), at this coverage
    out vec3 vP; out vec3 vN; out vec3 vL; flat out float vM;
    void main() {
      vec3 p = aP + uBase.xyz;
      p.y -= dot(p.xz, p.xz) / (2. * R_G * 1000.);          // the sea's curvature, as the cove is lowered (wxDrop)
      vP = p; vN = aN; vL = aP; vM = aM;
      gl_Position = uViewProj * vec4(p.x, uMirror > 0. ? -p.y : p.y, p.z, 1.);
    }`;
  const TOWERFS = `
    uniform sampler2D uProbe;
    uniform vec4 uBase;
    uniform vec4 uTw;       // x the bearing (atan(z, x), model frame) from the tower toward the window, y 0, z the beams' light
                            // toward the window over the lantern's (the lit lens blazes with the flash), w 0
    uniform float uMirror;
    in vec3 vP; in vec3 vN; in vec3 vL; flat in float vM;
    layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1;
    vec4 bcP(int i) { return texelFetch(uProbe, ivec2(i, 0), 0); }
    float bcN(vec2 p) {                                     // value noise, C1
      vec2 i = floor(p), f = p - i; f = f * f * (3. - 2. * f);
      return mix(mix(wxHash12(i), wxHash12(i + vec2(1., 0.)), f.x), mix(wxHash12(i + vec2(0., 1.)), wxHash12(i + vec2(1., 1.)), f.x), f.y);
    }
    /* a small dark opening on the shaft, w x h m at bearing a0 and height y0 (its sill) */
    float bcHole(float a, float rr, float y, float a0, float y0, float w, float h) {
      float da = abs(mod(a - a0 + PI, 2. * PI) - PI) * rr;
      return (1. - smoothstep(.5 * w - .05, .5 * w + .05, da)) * (1. - smoothstep(.5 * h - .05, .5 * h + .05, abs(y - y0 - .5 * h)));
    }
    void main() {
      bool mir = uMirror > 0.;
      int m = int(vM + .5);
      if (mir && vL.y < -.05) discard;                     // the mirror holds what stands above the water
      vec3 e = vec3(0., wxEye, 0.), rd, pv = mir ? vec3(vP.x, -vP.y, vP.z) : vP;
      rd = pv - e;
      float dist = length(rd); rd /= dist;
      if (mir) rd.y = -rd.y;                                // the reflection's last leg runs up from the sea to the tower
      vec3 n = normalize(vN);
      if (dot(n, rd) > 0. && m != 0) n = normalize(n - rd * (dot(n, rd) + .05));   // a face seen edge-on: lit as its silhouette
      float y = vL.y, rr = length(vL.xz), az = atan(vL.z, vL.x), Hs = uSwell.w, soak = uWx4.x;
      /* the railing: a band of posts and rails, drawn at its coverage (dithered with the TAA's jitter; resolved, a
         darker line under the lantern with the pedestal showing through) */
      if (m == 5) {
        float post = 1. - smoothstep(.05, .09, abs(fract(az * rr / 1.25) - .5) * 1.25);
        float rail = max(1. - smoothstep(.04, .08, abs(y - ${(GAL + 1.42).toFixed(2)})), 1. - smoothstep(.03, .06, abs(y - ${(GAL + 0.9).toFixed(2)})));
        float cov = clamp(max(post, rail) + .12, 0., 1.);
        if (fract(wxIGN(gl_FragCoord.xy) + uJitter.z) > cov) discard;
      }
      /* the air and the rain in front of it (the probe's); under 5 % transmittance (a storm's 1.5 km of rain) nothing of
         the detail comes through (< 1 8-bit level): one albedo a material, the key and the sky, the veil. The branch is
         the same for every pixel of the draw (the probe is one texel), so the storm's frames (the binding budget) skip
         the detail's cost */
      vec4 ap = bcP(mir ? 8 : 5), md = bcP(6);
      if (ap.a * md.a < .05) {
        vec3 a0 = m == 0 ? vec3(.105, .092, .074) * mix(1., .5, soak) : m == 1 ? vec3(.36, .355, .33) * mix(1., .82, soak)
                : m == 3 ? vec3(.012, .014, .016) : vec3(.045, .05, .048);
        bool sk = dot(uKey.xyz, uSun.xyz) > .9999;
        vec4 s7 = bcP(7);
        vec3 E0 = bcP(0).rgb * (sk ? s7.x : s7.y) * max(dot(n, uSun.xyz), 0.) + (uMoon.y > -.05 ? bcP(1).rgb * (sk ? s7.y : s7.x) * max(dot(n, uMoon.xyz), 0.) : vec3(0.));
        vec3 L0 = a0 / PI * E0 + a0 * mix(bcP(3).rgb, n.y > 0. ? bcP(2).rgb : bcP(4).rgb, abs(n.y)) + a0 / PI * wxFlashE(vP, n);
        vec3 Ll0 = !mir && m == 3 ? uBeaconC.rgb * (1. - smoothstep(0., .5, abs(vL.y - LAMP_Y) - 1.7)) * (1. + uTw.z) * uBeacon.w * uExpo.x * 2e-4 : vec3(0.);
        L0 = ((L0 + Ll0) * ap.a + ap.rgb) * md.a + md.rgb;
        float ly0 = wxLuma(Ll0) * ap.a * md.a;
        o0 = mir ? vec4(wxGuard(L0) * uMirror, uMirror) : vec4(wxGuard(L0), ly0 > 1e-6 && ly0 > .2 * wxLuma(L0) ? -ly0 : 1.);
        o1 = vec4(dist, 0., 0., 1.);
        return;
      }
      /* albedo (linear) */
      vec3 alb; float wet = soak, gloss = 0.;
      if (m == 0) {
        /* bedded rock, as the head's cliffs beside it: beds ~3 m thick dipping a little seaward, each its own shade with
           a soft change between them (a bed is 2-3 px at 1.5 km: the change widens as fwidth grows, so nothing aliases),
           blotches and darker joints; the crown dry and pale, the faces darker as they steepen */
        float bed = (y + .05 * vL.x - .03 * vL.z) / 3.1 + .25 * bcN(vec2(az * 1.9, 1.7)), b0 = floor(bed), fr = bed - b0;
        float ew = clamp(.2 + 1.5 * fwidth(bed), .2, .5);
        float st = mix(wxHash12(vec2(b0, 3.)), wxHash12(vec2(b0 + 1., 3.)), smoothstep(1. - ew, 1., fr));
        float bl = bcN(vL.xz * .21 + vec2(y * .13, 7.1));
        float jt = smoothstep(.42, .5, abs(bcN(vec2(az * 6.5, y * .18 + 11.)) - .5));
        alb = vec3(.20, .175, .135) * (.72 + .5 * st) * (.85 + .3 * bl) * (1. - .4 * jt);
        alb *= mix(1.1, .88, smoothstep(.5, .85, 1. - abs(n.y)));
        alb = mix(alb, vec3(.33, .30, .245), .5 * smoothstep(CROWN_Y - 1.5, CROWN_Y, y) * smoothstep(.6, .9, n.y));   // the weathered crown
      } else if (m == 1) {
        /* pale granite in courses and blocks (both under a pixel: they come through as a faint grain), weathered
           patches, rain streaks under the gallery and the windows */
        vec2 q = vec2(az * rr, y);
        float mot = bcN(q / vec2(2.7, 1.9)) - .5, mot2 = bcN(q / vec2(.9, .62) + 17.) - .5;
        float strk = bcN(vec2(q.x / .75, q.y / 16.)) - .5;
        float fw = clamp(1. - fwidth(y) / .6, 0., 1.);
        alb = vec3(.44, .43, .40) * (1. + .14 * mot + .08 * fw * mot2);
        alb *= 1. - .16 * smoothstep(0., .4, strk) * smoothstep(30., 58., y);
        alb *= 1. - .18 * smoothstep(4., 0., ${(63.6).toFixed(1)} - y) * smoothstep(-.1, .3, strk + .2);
        /* the door at the top of the solid base (facing the landing, a little right of the window), the windows up the
           shaft in two staggered columns and a ring of four under the gallery: dark openings */
        float hole = bcHole(az, rr, y, uTw.x + .38, 19.7, 1.25, 2.3);
        for (int k = 0; k < 8; k++) {
          float yk = 25.2 + float(k) * 4.7, ak = uTw.x + (k - (k / 2) * 2 == 0 ? -.62 : .92);
          hole = max(hole, bcHole(az, rr, y, ak, yk, .8, 1.3));
        }
        for (int k = 0; k < 4; k++) hole = max(hole, bcHole(az, rr, y, uTw.x + .35 + 1.5708 * float(k), 60.6, .75, 1.15));
        alb = mix(alb, vec3(.025, .026, .028), hole);
        /* the splash zone: dark and green-brown as high as the sea throws itself at the stack's crown */
        float sz = smoothstep(FOOT_Y + 1.2 + 1.4 * Hs, FOOT_Y + .3, y) * smoothstep(1.2, 2.6, Hs);
        alb *= mix(vec3(1.), vec3(.55, .6, .52), sz);
        wet = max(wet, sz);
        /* the corbel's underside and the gallery's eaves: darker in their own shade */
        if (y > 63.4 && n.y < -.2) alb *= .55;
      } else if (m == 2 || m == 5) { alb = vec3(.05, .055, .055); gloss = .5; }
      else if (m == 3) { alb = vec3(.012, .014, .016); gloss = 1.; }
      else { alb = vec3(.035, .045, .04); gloss = .55; }
      /* wet: the rock soaks and darkens in rain; the granite less; the spray-wet waterline band darker still */
      if (m == 0) {
        float band = smoothstep(1.6 + 1.3 * Hs, .2, y);
        wet = max(wet, band * smoothstep(.3, 1.2, Hs + .5));
        alb *= mix(1., .5, wet);
        gloss = .45 * wet;
      } else if (m == 1) { alb *= mix(1., .82, wet); gloss = max(gloss, .3 * wet); }
      /* the rock at the waterline: in a swell the sea washes it white; the wash rises and falls with the swell (its
         period divides the sea's loop) round the stack, more on its windward side */
      vec2 rel = vL.xz;
      vec4 sw = bcP(9);                                     // the sets at the stack: x the envelope, y the crests' phase
      float env = clamp(sw.x, .2, 1.9);
      if (m == 0) {
        float run = .5 + .5 * cos(sw.y - az * 2. + 1.3 * sin(az * 3.));
        float top = .3 + Hs * (.35 + .65 * run) * (.6 + .4 * uWx2.w) * (.45 + .55 * env);
        float side = .55 + .45 * dot(normalize(rel + 1e-4), -normalize(uSwell.xy));
        float wash = smoothstep(top, top - .6 - .3 * Hs, y) * smoothstep(-1.2, .1, y) * smoothstep(.9, 2.2, Hs) * side;
        alb = mix(alb, vec3(.70, .72, .74), clamp(wash, 0., 1.) * .85);
      }
      /* the storm's white water thrown up the stack's windward face is stream W's burst (the spray draw's point at the
         stack's foot, round 8): it rides the sets with the bay's */
      /* the light: the key (the sun, or the moon at night), through the clouds' shadow, the cove's shadow, the tower's own
         shadow on its rock and the gallery's on the shaft */
      bool sunKey = dot(uKey.xyz, uSun.xyz) > .9999;
      vec3 k = uKey.xyz;
      float vis = wxSunShadow(vP + n * .6);
      if (k.y > .01) {
        if (m == 0 && y > -1.) {
          float kk = max(dot(k.xz, k.xz), 1e-4), t0 = -dot(rel, k.xz) / kk, d = length(rel + t0 * k.xz);
          float hh = sqrt(max(RC_R * RC_R - d * d, 0.)) / sqrt(kk);
          if (t0 + hh > 0. && y + max(t0 - hh, 0.) * k.y < GAL_Y) vis *= smoothstep(RC_R - .9, RC_R + .3, d);
        } else if (m == 1 && y < GAL_Y) {
          vec2 g = rel + (GAL_Y - y) / k.y * k.xz;
          vis *= smoothstep(4.45, 4.8, length(g));
        }
      }
      vec4 sh = bcP(7);
      vec3 Es = bcP(0).rgb * (sunKey ? sh.x * vis : sh.y), Em = bcP(1).rgb * (sunKey ? sh.y : sh.x * vis);
      float up = n.y * .5 + .5;
      vec3 amb = up > .5 ? mix(bcP(3).rgb, bcP(2).rgb, up * 2. - 1.) : mix(bcP(4).rgb, bcP(3).rgb, up * 2.);
      float ao = m == 0 ? .75 + .25 * smoothstep(-.4, .6, n.y) : m == 1 && y > 63.4 && n.y < -.2 ? .6 : 1.;
      vec3 L = alb / PI * (Es * max(dot(n, uSun.xyz), 0.) + (uMoon.y > -.05 ? Em * max(dot(n, uMoon.xyz), 0.) : vec3(0.)));
      L += alb * amb * ao + alb / PI * wxFlashE(vP, n);
      if (gloss > 0.) {
        /* a smooth coat (the glazing, the dome, the wet rock and stone) mirrors the sky above the horizon */
        vec3 R = reflect(rd, n);
        float F = .04 + .96 * pow(1. - max(dot(n, -rd), 0.), 5.);
        L += gloss * F * mix(bcP(3).rgb, bcP(2).rgb, clamp(R.y * 2. + .5, 0., 1.)) * PI * .5;
      }
      /* the lit lens shows through the glazing in the lamp's colour (the core itself is the bolt slot's), brighter as a
         beam faces the window; the lantern's light falls on the gallery and the dome's eave */
      float lens = 0.;
      if (!mir) {
        if (m == 3) lens = (1. - smoothstep(0., .5, abs(y - LAMP_Y) - 1.7)) * (1. + uTw.z);
        else if (m == 2 || m == 5 || m == 4) lens = .08 * (1. - smoothstep(0., 3.5, abs(y - LAMP_Y) - 2.6));
        lens *= uBeacon.w * uExpo.x * 2e-4;
      }
      vec3 Ll = uBeaconC.rgb * lens;
      L = ((L + Ll) * ap.a + ap.rgb) * md.a + md.rgb;
      float ly = wxLuma(Ll) * ap.a * md.a;
      o0 = mir ? vec4(wxGuard(L) * uMirror, uMirror) : vec4(wxGuard(L), ly > 1e-6 && ly > .2 * wxLuma(L) ? -ly : 1.);
      o1 = vec4(dist, 0., 0., 1.);
    }`
    .replace(/CROWN_Y/g, CROWN.toFixed(2)).replace(/FOOT_Y/g, FOOT.toFixed(2)).replace(/GAL_Y/g, GAL.toFixed(2))
    .replace(/RC_R/g, RC.toFixed(2)).replace(/LAMP_Y/g, K.lampM.toFixed(2));
  /* the lamp and the beams' shafts, one scissored draw round the lamp, added to SCENE; alpha marks the lamp's light */
  const LAMPFS = `
    uniform sampler2D uProbe;
    uniform vec4 uL;        // x the lantern's flux on the image toward the window (pre-exposed radiance x px^2, before the air), y the core's sigma px, z px per degree, w the glow's share in clear air
    uniform vec4 uL2;       // x the glow's soft ceiling (pre-exposed), y the sprite's radius px, z the distance m nearer than which the cove hides the lamp, w 1: mark the lamp's light in alpha
    uniform vec4 uS;        // x the least scattering the beams find near the sea 1/m (the marine layer), y 0, z HG g, w the shafts' gain (0: none)
    uniform vec4 uS2;       // x the shafts' reach m, y the regularising radius m round the lamp, z samples per beam, w their soft ceiling (pre-exposed)
    uniform vec4 uF;        // the flash: x the beams' flux toward the window (as uL.x), y the glare's share, z its core px, w its soft ceiling (pre-exposed)
    uniform vec4 uF2;       // x the glare's most energy (pre-exposed x px^2), y the most of the beams' flux the glow takes, zw 0
    out vec4 o;
    float lmpHG(float c, float g) { float g2 = g * g; return (1. - g2) / (4. * PI * pow(max(1. + g2 - 2. * g * c, 1e-4), 1.5)); }
    void main() {
      vec2 uv = gl_FragCoord.xy * uRes.zw;
      vec3 e = vec3(0., wxEye, 0.), Lp = uBeacon.xyz, dl = Lp - e;
      float Dl = length(dl);
      vec2 luv = wxUV(dl / Dl);
      vec2 q = (uv - luv) * uRes.xy;
      float r2 = dot(q, q), r = sqrt(r2);
      vec4 ap = texelFetch(uProbe, ivec2(5, 0), 0), md = texelFetch(uProbe, ivec2(6, 0), 0);
      float T = ap.a * md.a;
      float L = 0.;
      /* the lamp: a sub-pixel core (it integrates to 1 over the image plane) and the glow the air between scatters it
         into: its share of the light grows with the optical depth tau, then falls as thick rain swallows the light too
         (a share .03 T + .25 tau e^(-.7 tau): ~5 % in clear air, 13 % at tau 1, 5 % in a 94 % storm), and widens from
         .06 deg to ~.4; under a soft ceiling, so it keeps the lamp's colour (a night exposure would draw a physical halo
         of a light 1e4 x the scene as a white ball) */
      if (r < uL2.y) {
        float zc = texture(sSceneZ, luv).r;
        float seen = zc > 0. && zc < uL2.z ? 0. : 1.;
        float s = uL.y, tau = -log(max(T, 1e-6));
        float l = uL.z * (.06 + .35 * (1. - exp(-.5 * tau)));
        float core = exp(-.5 * r2 / (s * s)) / (6.2832 * s * s);
        float share = uL.w * T + .25 * tau * exp(-.7 * tau);
        float mc = max(uBeaconC.r, max(uBeaconC.g, uBeaconC.b));       // the ceiling holds the brightest channel: a red glow stays red
        /* the glow takes the lantern's light and the beams' toward the window, the beams' part soft-capped (uF2.y): in
           thick rain the flash would otherwise draw the aureole out ~80 px every 8 s */
        float fa = uL.x + uF2.y * (1. - exp(-uF.x / max(uF2.y, 1e-6)));
        float h = fa * share * mc / (6.2832 * l * l), G = uL2.x;
        h = G * (1. - exp(-h / G)) / mc;
        /* the flash's glare: as a beam passes the window its light, 17 x the lantern's at night, is scattered in the eye
           and the lens round the point (a Moffat profile, beta 2: a point's glare tail), at once and gone with the beam
           (post's glare of the steady lamps eases over .6 s and cannot follow a .3 s flash). Its energy is the beams'
           light through the air times the share, soft-capped (uF2.x); its visible reach grows as the fourth root of the
           flash against the scene's exposure, so it shows from civil dusk and blooms at night within ~12 px (1080p);
           under a soft ceiling on the brightest channel (its middle burns toward white through the grade, the rest keeps
           the lamp's colour) */
        float a2 = uF.z * uF.z, Eg = uF2.x * (1. - exp(-uF.x * T * uF.y / max(uF2.x, 1e-6)));
        float gf = Eg / (PI * a2) / ((1. + r2 / a2) * (1. + r2 / a2)) * mc;
        gf = uF.w * (1. - exp(-gf / uF.w)) / mc;
        L += ((uL.x + uF.x) * T * core + h * exp(-r / l) * (1. - smoothstep(.7 * uL2.y, uL2.y, r)) + gf * (1. - smoothstep(.75 * uL2.y, uL2.y, r))) * seen;
      }
      /* the shafts: the two beams scattered toward the window along this pixel's ray (single scattering), integrated in
         the angle b the ray subtends at the lamp: x(b) = the ray's closest point + h tan b along it, dt / r^2 = db / h */
      if (uS.w > 0.) {
        /* the air's extinction is the scene's own (the probe's tau over the lamp's distance: the AP and the rain's medium,
           as the tower is drawn); its scattering at least the marine layer's */
        float sigE = -log(max(T, 1e-6)) / Dl, sigS = max(sigE, uS.x);
        vec3 rd = wxRay(uv);
        float zc = texture(sSceneZ, uv).r, tEnd = zc > 0. ? zc : 6e4;
        float r0 = R_G + wxEye * 1e-3, hzMu = -sqrt(max(0., 1. - R_G * R_G / (r0 * r0)));
        if (rd.y < hzMu) { vec2 sp = wxSphere(r0, rd.y, R_G); tEnd = min(tEnd, (sp.y > 0. ? sp.y : sp.x) * 1e3); }
        float t0 = dot(dl, rd);
        vec3 cp = e + rd * t0 - Lp;
        float h = length(cp), he = sqrt(h * h + uS2.y * uS2.y), reach = uS2.x;
        if (he < reach) {
          vec3 mh = h > 1e-3 ? cp / h : vec3(0., 1., 0.);
          float bm = acos(he / reach);
          float lo0 = max(atan(-t0 / he), -bm), hi0 = min(atan((tEnd - t0) / he), bm);
          float sh = uBeaconB.y, sv = uBeaconB.z, cc = cos(3.5 * sh), N = uS2.z;
          float jit = fract(wxIGN(gl_FragCoord.xy) + uJitter.z);
          float acc = 0.;
          for (int k = 0; k < 2; k++) {
            vec2 b2 = vec2(sin(uBeaconB.x), cos(uBeaconB.x)) * (k == 0 ? 1. : -1.);
            vec3 b = vec3(b2.x, 0., b2.y);
            float A1 = dot(mh, b), A2 = dot(rd, b), A = sqrt(A1 * A1 + A2 * A2);
            if (A < cc) continue;
            float bs = atan(A2, A1), dlt = acos(min(cc / A, 1.));
            float lo = max(lo0, bs - dlt), hi = min(hi0, bs + dlt);
            if (hi <= lo) continue;
            float st = (hi - lo) / N, sum = 0.;
            for (int i = 0; i < 16; i++) {
              if (float(i) >= N) break;
              float be = lo + (float(i) + jit) * st;
              float t = t0 + he * tan(be), rr = he / cos(be);
              vec3 u = normalize(e + rd * t - Lp);
              float c = dot(u.xz, b2);
              if (c <= 0.) continue;
              float s = u.x * b2.y - u.z * b2.x, db = atan(abs(s), c), de = u.y / max(length(u.xz), 1e-4);
              float prof = exp(-.5 * (db * db / (sh * sh) + de * de / (sv * sv)));
              float ph = .8 * lmpHG(dot(u, -rd), uS.z) + .2 / (4. * PI);
              /* [r9] a gaussian of the reach (no plateau, no edge: e^-3 at the reach), one exp with the air's */
              sum += prof * ph * exp(-sigE * (max(t, 0.) + rr) - 3. * rr * rr / (reach * reach));
            }
            acc += sum * st;
          }
          /* under a soft ceiling on the brightest channel (uS2.w, pre-exposed): faint shafts that keep the lamp's colour,
             where a dark storm's exposure would draw the rain's forward-scattered beam near white */
          float Ls = uS.w * sigS * uBeaconC.w * uExpo.x / he * acc, mcs = max(uBeaconC.r, max(uBeaconC.g, uBeaconC.b));
          L += uS2.w * (1. - exp(-Ls * mcs / uS2.w)) / mcs;
        }
      }
      vec3 c = wxGuard(uBeaconC.rgb * L);
      float Y = wxLuma(c);
      /* the mark (MIN-blended into SCENE's alpha): -Y where the lamp adds light, 1 (no change) elsewhere */
      o = vec4(c, uL2.w > .5 && Y > 1e-7 ? -Y : 1.);
    }`;

  /* ── the lamp's place on the screen (unjittered uv, y up), or null behind the eye ── */
  function project(R, x, y, z, out) {
    const c = R.cam, dx = x, dy = y - WX.EYE_M, dz = z;
    const zz = dx * c.fwd[0] + dy * c.fwd[1] + dz * c.fwd[2];
    if (zz <= 1) return null;
    out[0] = ((dx * c.right[0] + dy * c.right[1] + dz * c.right[2]) / (zz * c.tanX)) * 0.5 + 0.5;
    out[1] = ((dx * c.up[0] + dy * c.up[1] + dz * c.up[2]) / (zz * c.tanY)) * 0.5 + 0.5;
    return out;
  }
  const pj = [0, 0];
  const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const srgb = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  /* the reading's ease (core/director.js): w 1/s, the exact critically damped step; a stand-in if the director has none */
  function easeStep(v, r, goal, w, dt, s) {
    if (WX.easeStep) return WX.easeStep(v, r, goal, w, dt, s);
    const e = v - goal, B = r + w * e, x = Math.exp(-w * dt);
    s[0] = goal + (e + B * dt) * x; s[1] = (r - w * B * dt) * x;
    return s;
  }
  /* the photocell: 0 (night) .. 1 (day) from the light of the scene (post's eased mean luminance, cd/m^2: an automated
     light reads the ambient light, as obstruction lights do), log-linear from K.dayLum[0] to K.dayLum[1]; from the sun's
     elevation where no meter runs (a still's first frame, the stub post) */
  function photocell(R, F) {
    const lv = R.exposure && R.exposure.lavS;
    if (lv > 0 && K.dayLum) return U.smooth(Math.log(K.dayLum[0]), Math.log(K.dayLum[1]), Math.log(lv));
    const sunEl = Math.asin(U.clamp(F.sun.dir[1], -1, 1)) / D2R;
    return U.smooth(K.dayEl[0], K.dayEl[1], sunEl);
  }
  /* a log-linear blend of the night and day intensities (cd) */
  const llerp = (a, b, t) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * t);

  return {
    name: "beacon",
    *build(R) {
      const gl = R.gl, G = R.gpu;
      /* the swell's sets come from the ocean's library when it has them (stream W, round 8) */
      const sets = /vec2 wxSwellSet\(/.test((WX.libs && WX.libs.ocean) || "");
      P.probe = R.program("beacon.probe", { fs: (sets ? "#define BC_SETS 1\n" : "") + PROBEFS, libs: ["atmo", "clouds"].concat(sets ? ["ocean"] : []) });
      P.tower = R.program("beacon.tower", { vs: TOWERVS, fs: TOWERFS, libs: ["coast"] });
      P.lamp = R.program("beacon.lamp", { fs: LAMPFS });
      const m = model();
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, m.v, gl.STATIC_DRAW);
      for (const [loc, n, off] of [[0, 3, 0], [1, 3, 12], [2, 1, 24]]) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 28, off); }
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.i, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      geo = { vao, count: m.i.length, nRock: m.nRock, tris: m.i.length / 3, verts: m.v.length / 7 };
      const t = G.tex2D(10, 1, "rgba16f", { filter: "nearest" });
      probe = { tex: t, fb: G.fbo([t]), ok: false };
      refl = null; reflDue = true;
      /*@lab*/ R.debugTex("beacon.probe", t, "raw"); R.priv.beacon = { tris: geo.tris, verts: geo.verts }; /*@end*/
      yield* R.wait(P.probe, P.tower, P.lamp);
    },
    ubo(F, R, set) {
      const B = R.beacon || (R.beacon = WX.beaconDefaults());
      let az = K.az, km = K.km, lampK = 1, beamK = 1, hold = false, face = -1;
      /*@lab*/ az = R.p("beacon.az"); km = R.p("beacon.km"); lampK = R.p("beacon.lamp"); beamK = R.p("beacon.beam"); hold = R.p("beacon.hold") > 0; face = R.p("beacon.face"); /*@end*/
      const x = km * 1000 * Math.sin(az * D2R), z = km * 1000 * Math.cos(az * D2R);
      const drop = (x * x + z * z) / (2 * WX.R_G * 1000);
      B.pos[0] = x; B.pos[1] = K.lampM - drop; B.pos[2] = z;
      B.base = B.base || [0, 0, 0, 0];
      B.base[0] = x; B.base[1] = 0; B.base[2] = z; B.base[3] = 0;
      /* the accent: the page's (F.accent, set by the API on every frame it draws); with no reading the unknown grey */
      let tgt = F.accent;
      /*@lab*/
      if (tgt === undefined) tgt = WX.accentOf(F.W.v, null);        // the lab's own driver: the page's ramp for its reading
      const forced = R.p("beacon.rgb");
      if (forced >= 0) { forcedRgb[0] = (forced >> 16) & 255; forcedRgb[1] = (forced >> 8) & 255; forcedRgb[2] = forced & 255; tgt = forcedRgb; }
      /*@end*/
      if (!tgt) tgt = K.unknown;
      for (let i = 0; i < 3; i++) col.tgt[i] = lin(tgt[i]);
      const w = WX.easeStep ? WX.WALK.read : 0.11;
      if (!col.seen || F.still) {
        for (let i = 0; i < 3; i++) { col.c[i] = col.tgt[i]; col.r[i] = 0; col.w[i] = w; }
        col.seen = true;
      } else {
        for (let i = 0; i < 3; i++) {
          const g = col.tgt[i];
          if (col.c[i] === g && col.r[i] === 0) continue;
          /* a new goal keeps the rate, as the reading does: heading to it faster than w x the distance, the approach
             stiffens to rate / distance, so nothing overshoots */
          if (g !== col.last[i]) { const ee = g - col.c[i]; col.w[i] = ee * col.r[i] > 0 && Math.abs(col.r[i]) > w * Math.abs(ee) ? Math.abs(col.r[i] / ee) : w; }
          easeStep(col.c[i], col.r[i], g, col.w[i], Math.min(F.dt || 0, 0.1), es);
          col.c[i] = es[0]; col.r[i] = es[1];
          if (Math.abs(col.c[i] - g) < 1e-5 && Math.abs(col.r[i]) < 1e-6) { col.c[i] = g; col.r[i] = 0; col.w[i] = w; }
        }
      }
      for (let i = 0; i < 3; i++) col.last[i] = col.tgt[i];
      const Y = 0.2126 * col.c[0] + 0.7152 * col.c[1] + 0.0722 * col.c[2];
      for (let i = 0; i < 3; i++) { B.rgb[i] = Y > 1e-6 ? col.c[i] / Y : 1; B.srgb[i] = srgb(Math.max(0, col.c[i])); }
      /* the photocell: from the night intensities in a dark scene to the day's in daylight, through dusk's (an
         automated light's day, twilight and night settings, as obstruction lights have), log-linear in both */
      const day = photocell(R, F);
      B.day = day;
      B.I = (llerp(K.cd.lanternNight, K.cd.lanternDay, day) / 128000) * lampK;
      B.Ib = (llerp(K.cd.beamNight, K.cd.beamDay, day) / 128000) * beamK;
      /* the beams: a turn every K.turn s of the sea's clock (it wraps at 1024 s, 64 turns: no seam), clockwise from
         above; a still, and the lab's hold, show them 90 deg off the window (two shafts, not a frozen flash) */
      const toEye = Math.atan2(-x, -z);
      B.angle = F.still || hold ? toEye + Math.PI / 2 : 2 * Math.PI * ((F.t.ocean / K.turn) % 1);
      /*@lab*/ if (face >= 0) B.angle = toEye + face * D2R; /*@end*/
      B.sigma[0] = K.sigmaDeg[0] * D2R; B.sigma[1] = K.sigmaDeg[1] * D2R;
      let db = toEye - B.angle; db -= Math.PI * Math.round(db / Math.PI);
      const de = (WX.EYE_M - B.pos[1]) / Math.hypot(x, z);
      B.eye = Math.exp(-0.5 * ((db * db) / (B.sigma[0] * B.sigma[0]) + (de * de) / (B.sigma[1] * B.sigma[1])));
      B.on = 1;
      /*@lab*/ B.on = R.p("beacon.on") > 0 ? 1 : 0; /*@end*/
      if (R.cam && project(R, B.pos[0], B.pos[1], B.pos[2], pj)) { B.uv[0] = pj[0]; B.uv[1] = pj[1]; } else { B.uv[0] = -1; B.uv[1] = -1; }
      set("uBeacon", B.pos[0], B.pos[1], B.pos[2], B.I * B.on);
      set("uBeaconC", B.rgb[0], B.rgb[1], B.rgb[2], B.Ib * B.on);
      set("uBeaconB", B.angle, B.sigma[0], B.sigma[1], B.on);
    },
    slots: {
      coast(R, F) {
        const B = R.beacon;
        if (!B || !B.on || !geo) return;
        const gl = R.gl;
        /* the probe first: the sky and the clouds of this world frame are in */
        const D = Math.hypot(B.pos[0], B.pos[2]), fx = B.pos[0] / D, fz = B.pos[2] / D, fd = D - 85;
        uMid[0] = B.pos[0]; uMid[1] = 35; uMid[2] = B.pos[2];
        uFoot[0] = fx * fd; uFoot[1] = -(fd * fd) / (2 * WX.R_G * 1000); uFoot[2] = fz * fd;
        /* the reflection's last leg: from the sea point the window sees the tower's middle (35 m) at, up to it */
        const hm = 35 + WX.EYE_M, t0 = (D * WX.EYE_M) / hm, lg = Math.hypot(D - t0, 35);
        uLeg[0] = (fx * (D - t0)) / lg; uLeg[1] = 35 / lg; uLeg[2] = (fz * (D - t0)) / lg; uLeg[3] = lg * 1e-3;
        /* below T2 (the world every second frame) the probe every second world frame: its light changes over seconds */
        if (R.tier >= 2 || !probe.ok || (R.worldIndex & 1) === 0) R.draw(P.probe, probe.fb, uniP, PROBE_VP);
        probe.ok = true;
        /*@lab*/
        const pv = R.priv.beacon;
        if (pv && !pv.reading && (pv.n = (pv.n || 0) + 1) % 30 === 1) {
          pv.reading = true;
          if (!R.gpu.readback(probe.fb.fb, 0, 0, 10, 1, (px) => { pv.reading = false; pv.probe = Array.from(px, (v) => +v.toPrecision(4)); })) pv.reading = false;
        }
        /*@end*/
        /* the stack, its rocks and the tower, depth-tested and depth-writing, into SCENE and SCENEZ as the cove; front
           faces only (the camera's basis is mirrored: they land clockwise) */
        R.bind("coast");
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
        gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true);
        gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); gl.frontFace(gl.CW);
        P.tower.use();
        uBase[0] = B.base[0]; uBase[1] = B.base[1]; uBase[2] = B.base[2]; uBase[3] = 0;
        uTw[0] = Math.atan2(-B.base[2], -B.base[0]); uTw[1] = 0; uTw[2] = B.I > 0 ? (B.Ib * B.eye) / B.I : 0; uTw[3] = 0;
        uniT.uProbe = probe.tex; uniT.uMirror = 0;
        R.gpu.uniforms(P.tower, uniT);
        gl.bindVertexArray(geo.vao);
        gl.drawElements(gl.TRIANGLES, geo.count, gl.UNSIGNED_SHORT, 0);
        /* its reflection: on the world frames the cove redraws its mirror (every one at T3-T4, every coastMirrorEvery-th
           below, and a fresh one), drawn under what the cove put there (the stack and the tower stand behind every piece
           of it), the rock first so the tower goes under it; then the mips again. It fades out as the wind roughens the
           bay (U10 12 -> 18 m/s, ~80-88 %): a rough sea breaks the image of a far tower into nothing the mirror can show,
           and the storm's frames (the binding budget) skip the draw and the mips */
        let mirOn = 1;
        /*@lab*/ mirOn = R.p("beacon.mirror"); /*@end*/
        const CR = R.tex.COASTREFL, every = R.p("coastMirrorEvery") | 0, mirK = mirOn * (1 - U.smooth(12, 18, F.W.U10 || 0));
        if (mirK > 0.004 && CR && CR.w > 16 && every > 0) {
          if (!refl || refl.tex !== CR) { if (refl) gl.deleteFramebuffer(refl.fb.fb); refl = { tex: CR, fb: R.gpu.fbo([CR]) }; reflDue = true; }
          if (reflDue || R.tier >= 3 || R.worldIndex % every === 2) {
            reflDue = false;
            gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
            R.bind(refl.fb);
            gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE_MINUS_DST_ALPHA, gl.ONE);
            gl.frontFace(gl.CCW);
            uniT.uMirror = mirK;
            R.gpu.uniforms(P.tower, uniT);
            gl.drawElements(gl.TRIANGLES, geo.count, gl.UNSIGNED_SHORT, 0);
            gl.disable(gl.BLEND); gl.depthMask(true);
            gl.activeTexture(gl.TEXTURE0 + WX.TEX.COASTREFL.unit); gl.bindTexture(gl.TEXTURE_2D, CR.tex); gl.generateMipmap(gl.TEXTURE_2D);   // on its own unit, where the core binds it
          }
        }
        gl.bindVertexArray(null);
        gl.disable(gl.CULL_FACE); gl.frontFace(gl.CCW);
        gl.disable(gl.DEPTH_TEST);
      },
      bolt(R, F) {
        const B = R.beacon;
        if (!B || !B.on || !probe || !probe.ok || B.uv[0] < -0.5) return;
        const gl = R.gl, S = R.size.S, cam = R.cam, E = R.exposure.E;
        const ppr = S[1] / (2 * cam.tanY);
        const dx = B.pos[0], dy = B.pos[1] - WX.EYE_M, dz = B.pos[2], D = Math.hypot(dx, dy, dz);
        const vis = Math.max(F.W.vis || 30, 0.2), Te = Math.exp((-3.912 * D) / (1000 * vis));
        /* the lamp toward the window: the lantern (uL.x), and the beams' pattern there, the flash (uF.x) */
        const k2 = (E * ppr * ppr) / (D * D), sc = S[1] / 1080;
        uL[0] = B.I * k2;
        uL[1] = 0.6;                                      // a point under a pixel: the image's own blur
        uL[2] = ppr * D2R;                                // px per degree (the glow's width is set on the GPU from the probe's tau)
        uL[3] = 0.03;
        uL2[0] = 0.3;
        const lam = uL[2] * (0.06 + 0.35 * (1 - Math.exp(-0.5 * (3.912 * D) / (1000 * vis))));
        /* the flash: the beams' flux toward the window; 6 % of it in the glare (its core 1.5 px at 1080p, its energy at most
           600 pre-exposed px^2 at 1080p, its brightest channel under 2), the glow taking at most twice the lantern's from
           it; the sprite reaches where the glare falls under 1e-3 (pre-exposed), at most 96 px */
        let flashK = 0.06;
        /*@lab*/ flashK = R.p("beacon.flash"); /*@end*/
        uF[0] = B.Ib * B.eye * k2; uF[1] = flashK; uF[2] = Math.max(1, 1.5 * sc); uF[3] = 2;
        uF2[0] = 600 * sc * sc; uF2[1] = 2 * uL[0];
        const Eg = uF2[0] * (1 - Math.exp(-(uF[0] * flashK * Te) / uF2[0]));
        const rf = Eg > 1e-3 ? Math.sqrt(Math.sqrt((Eg * uF[2] * uF[2]) / (Math.PI * 1e-3))) : 0;
        const rs = Math.min(Math.max(Math.ceil(6 * lam + 3), Math.ceil(rf), 6), 96);
        let mark = 1;
        /*@lab*/ mark = R.p("beacon.mark"); /*@end*/
        uL2[1] = rs; uL2[2] = D - 40; uL2[3] = mark;
        /* the shafts: the air's scattering from the visibility (Koschmieder), at least the marine layer's near the sea;
           drawn where they can show against the sky (the beams' own light against the exposure), never by day */
        let air = 0.15, shaftK = 1, reachK = 0.3;
        /*@lab*/ air = R.p("beacon.air"); shaftK = R.p("beacon.shaft"); reachK = R.p("beacon.reach"); /*@end*/
        const reach = reachK * D;
        /* a shaft's brightest radiance, pre-exposed (the beam 100 m out seen ~25 deg off its axis, the scattering at
           least the marine layer's): under 1e-3 it cannot show (an 8-bit step of the night's darkest grey) */
        const sigS = Math.max(air * 1e-3, 3.912 / (1000 * vis)), est = (B.Ib * E * sigS * 0.5 * 18) / (100 * 100);
        uS[0] = air * 1e-3; uS[1] = 0; uS[2] = U.lerp(0.7, 0.82, U.smooth(0.1, 0.8, F.W.precip || 0)); uS[3] = est > 1e-3 ? shaftK : 0;
        uS2[0] = reach; uS2[1] = Math.max(2, (2 * D) / ppr); uS2[2] = R.tier >= 2 ? 10 : 6; uS2[3] = 0.35;
        /* the scissor: the sprite, and the shafts' sector: only the beam that turns toward the window shows (its light
           scattered forward); the one turned away, or both broadside (over 70 deg off the window), throw too little at
           it to see, so the shafts are drawn only while one is within 70 deg, over its own sector out to the reach */
        const lx = B.uv[0] * S[0], ly = B.uv[1] * S[1];
        box[0] = lx - rs - 2; box[1] = ly - rs - 2; box[2] = lx + rs + 2; box[3] = ly + rs + 2;
        const toEye = Math.atan2(-B.pos[0], -B.pos[2]);
        let dEye = toEye - B.angle; dEye -= Math.PI * Math.round(dEye / Math.PI);       // the nearer beam's bearing off the window
        if (Math.abs(dEye) > 70 * D2R) uS[3] = 0;
        if (uS[3] > 0) {
          const bk = toEye - dEye, dzv = Math.tan(3 * B.sigma[1]), wb = 3.5 * B.sigma[0];
          for (let ia = 0; ia < 3; ia++) for (let ir = 0; ir < 3; ir++) for (let ih = 0; ih < 2; ih++) {
            const a = bk + SECT_A[ia] * wb, rr = reach * SECT_R[ir], hy = SECT_H[ih];
            if (!project(R, B.pos[0] + rr * Math.sin(a), B.pos[1] + hy * rr * dzv, B.pos[2] + rr * Math.cos(a), pj)) continue;
            const px = pj[0] * S[0], py = pj[1] * S[1];
            box[0] = Math.min(box[0], px - 4); box[1] = Math.min(box[1], py - 4); box[2] = Math.max(box[2], px + 4); box[3] = Math.max(box[3], py + 4);
          }
        }
        const x0 = Math.max(0, Math.floor(box[0])), y0 = Math.max(0, Math.floor(box[1]));
        const x1 = Math.min(S[0], Math.ceil(box[2])), y1 = Math.min(S[1], Math.ceil(box[3]));
        /* the draw's box (S px, y up) for post, which grades the lamp's marked light only inside it */
        B.box = B.box || [0, 0, 0, 0]; B.box[0] = x0; B.box[1] = y0; B.box[2] = x1; B.box[3] = y1;
        if (x1 <= x0 || y1 <= y0) return;
        R.bind("scene");
        gl.enable(gl.SCISSOR_TEST); gl.scissor(x0, y0, x1 - x0, y1 - y0);
        /* the light adds; alpha keeps the least (the mark -Y where the lamp adds light, else what was there: 0..1) */
        gl.enable(gl.BLEND); gl.blendEquationSeparate(gl.FUNC_ADD, gl.MIN); gl.blendFunc(gl.ONE, gl.ONE); gl.depthMask(false);
        uniL.uProbe = probe.tex;
        R.draw(P.lamp, "scene", uniL);
        gl.blendEquation(gl.FUNC_ADD);
        gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST); gl.depthMask(true);
        /*@lab*/ Object.assign(R.priv.beacon, { box: [x0, y0, x1 - x0, y1 - y0], flux: +uL[0].toPrecision(4), fb: +uF[0].toPrecision(4), Eg: +Eg.toPrecision(3), rs, eye: +B.eye.toFixed(4), Te: +Te.toPrecision(3), shaft: +uS[3].toFixed(3), est: +est.toPrecision(3), day: +B.day.toFixed(3), I: +B.I.toPrecision(3), Ib: +B.Ib.toPrecision(3), E: +E.toPrecision(4), lav: R.exposure.lavS }); /*@end*/
      },
    },
  };
})());
