/* ═══════════════════════ Weather: the lighthouse (stream L, round 7) ═══════════════════════
   The user's ask (2026-11-26): "a lighthouse in the far ocean whose lamp is the accent colour; not overwhelming the
   whole scene, staying in the far ocean". Contract section 10 (1.4) has the shared part: WX.BEACON, R.beacon, the
   uBeacon* fields and wxBeacon.

   WHAT IT DRAWS
   - coast slot: a light probe at the lighthouse (8 x 1: its sun, moon and sky light, the clouds' shadow, the air and the
     rain's medium between it and the window), then the reef and the tower into SCENE, SCENEZ and depth, as the cove
     draws its pieces: lit by the probe and the strikes (wxFlashE), behind the air (wxAerial) and the rain in front (the
     cloud buffer's sea rays that end at its foot). A few hundred triangles, built here: a rock lighthouse, a granite
     tower 45 m high off a low reef, its base battered, a corbelled gallery, a glazed lantern under a dark dome.
   - bolt slot (added to SCENE before the TAA, so it is jittered and resolved with the rest): one scissored draw round
     the lamp: its core (a sub-pixel point, energy-normalised so the jitter cannot make it crawl) and the aureole damp
     air scatters it into, both as bright as the lamp is toward the window (the flash when a beam points at it); and,
     at dusk, at night and in rain or haze, the beams' shafts in the air: single scattering of the two beams along each
     view ray, integrated in the angle the ray subtends at the lamp (equiangular: the 1/r^2 is exact), only over the arc
     of the ray inside a beam and within its reach of the lamp. Never over the whole view: the shafts fade out a little
     under a kilometre from the lamp, so they stay within about 15 deg of it.
   The sea's path under the lamp is the ocean's (stream W: wxBeacon, R.beacon); the glare of a bright lamp through the
   wet pane is post's and the pane's, as for the cove's lamps (both work on SCENE).

   HOLDS AT ANY READING (rule 1): the beams turn on the sea's clock, a turn every WX.BEACON.turn s (16 divides 1024: no
   seam at the wrap); the lamp's colour eases to the page's accent and stands on it; the photocell follows the sun. Nothing
   accumulates. */
WX.pass((function () {
  const U = WX.util, D2R = Math.PI / 180, K = WX.BEACON;
  const P = {};
  let geo = null, probe = null;
  /* the lamp's colour: eased in linear light (each channel by WX.easeStep at the reading's own w), the lamp drawn at
     unit luminance */
  const col = { c: [0, 0, 0], r: [0, 0, 0], w: [0, 0, 0], tgt: [0, 0, 0], last: [-1, -1, -1], seen: false };
  const es = new Float64Array(2);
  /* the bolt slot's uniforms, made once */
  const uL = new Float32Array(4), uL2 = new Float32Array(4), uS = new Float32Array(4), uS2 = new Float32Array(4);
  const box = [0, 0, 0, 0];
  /* uniform objects and the sector's sample points, made once: nothing is allocated per frame (DESIGN 2.5 rule 4) */
  const uMid = new Float32Array(4), uFoot = new Float32Array(4), uBase = new Float32Array(4), forcedRgb = [0, 0, 0];
  const PROBE_VP = { viewport: [0, 0, 8, 1] }, uniP = { uMid, uFoot }, uniT = { uProbe: null, uBase }, uniL = { uProbe: null, uL, uL2, uS, uS2 };
  const SECT_A = [-1, 0, 1], SECT_R = [0.12, 0.35, 1], SECT_H = [-1, 1];
  /*@lab*/
  WX.param("beacon.az", K.az, -45, 45, 0.5, "beacon");          // deg right of the view's centre
  WX.param("beacon.km", K.km, 0.8, 12, 0.1, "beacon");          // km from the window
  WX.param("beacon.lamp", 1, 0, 20, 0.05, "beacon");            // the lantern's steady glow x this
  WX.param("beacon.beam", 1, 0, 20, 0.05, "beacon");            // the beams' intensity x this (the flash and the shafts)
  WX.param("beacon.shaft", 1, 0, 20, 0.05, "beacon");           // the shafts alone x this
  WX.param("beacon.air", 0.15, 0, 3, 0.01, "beacon");           // km^-1: the least scattering the beams find in the air near the sea
  WX.param("beacon.reach", 900, 100, 4000, 10, "beacon");       // m from the lamp the shafts fade out by
  WX.param("beacon.rgb", -1, -1, 16777215, 1, "beacon");        // a forced accent 0xRRGGBB (-1: the page's, or the reading's)
  WX.param("beacon.hold", 0, 0, 1, 1, "beacon");                // 1: the beams hold, pointing 90 deg off the window (a still's pose)
  WX.param("beacon.on", 1, 0, 1, 1, "beacon");                  // 0: no lighthouse (for a paired A/B of its cost)
  /*@end*/

  /* ── the model, in its own frame (m, y up, origin at the reef's middle at the sea's level) ── */
  /* materials: 0 the reef's rock, 1 the tower's granite, 2 dark metal (the gallery), 3 the lantern's glazing, 4 the dome */
  function model() {
    const V = [], I = [];
    const vert = (x, y, z, nx, ny, nz, m) => { V.push(x, y, z, nx, ny, nz, m); return V.length / 7 - 1; };
    /* a lathe: profile [[r, y, mat], ...] round the y axis, each segment its own band (crisp edges between them),
       smooth round the axis */
    function lathe(pr, n, ox, oz) {
      for (let s = 0; s + 1 < pr.length; s++) {
        const [r0, y0, m] = pr[s], [r1, y1] = pr[s + 1];
        let nr = y1 - y0, ny = r0 - r1;
        const l = Math.hypot(nr, ny) || 1; nr /= l; ny /= l;
        const base = V.length / 7;
        for (let k = 0; k <= n; k++) {
          const a = (k / n) * 2 * Math.PI, c = Math.cos(a), si = Math.sin(a);
          vert(ox + r0 * c, y0, oz + r0 * si, nr * c, ny, nr * si, m);
          vert(ox + r1 * c, y1, oz + r1 * si, nr * c, ny, nr * si, m);
        }
        for (let k = 0; k < n; k++) {
          const a = base + 2 * k;
          I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
    }
    /* the reef: a low uneven rock, longer one way, 3 m at its crown where the tower stands; its skirt runs 8 m under the
       sea, so the waterline is the sea's own */
    const RINGS = [[0, 3.3], [7.2, 3.1], [10, 2.3], [13.5, 1.0], [16.5, -0.3], [20, -2.5], [24, -8]];
    const N = 22, hash = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };
    const pos = [];
    for (let j = 0; j < RINGS.length; j++) {
      const [R0, y0] = RINGS[j], row = [];
      for (let k = 0; k < N; k++) {
        const a = (k / N) * 2 * Math.PI;
        /* a smooth wobble round the ring (two harmonics) and a little per-vertex roughness, more on the lower rings */
        const wob = 1 + 0.15 * Math.sin(2 * a + 0.7) + 0.08 * Math.sin(3 * a + 2.1) + (j > 1 ? 0.18 * (hash(k, j) - 0.5) : 0);
        const ex = 1.3, R1 = R0 * wob;
        const y = j === 0 ? y0 : y0 + (j > 1 && j < 5 ? 0.9 * (hash(k + 7, j) - 0.5) + 0.5 * Math.sin(a * 2 + 1) : 0);
        row.push([R1 * ex * Math.cos(a), y, R1 * Math.sin(a)]);
      }
      pos.push(row);
    }
    /* smooth normals from the faces round each vertex */
    const nrm = pos.map((row) => row.map(() => [0, 0, 0]));
    const addN = (a, b, c, ja, ka, jb, kb, jc, kc) => {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (ny < 0 || (ny === 0 && nx * a[0] + nz * a[2] < 0)) { nx = -nx; ny = -ny; nz = -nz; }   // outward / up
      for (const [j, k] of [[ja, ka], [jb, kb], [jc, kc]]) { const t = nrm[j][k]; t[0] += nx; t[1] += ny; t[2] += nz; }
    };
    for (let j = 0; j + 1 < pos.length; j++) for (let k = 0; k < N; k++) {
      const k1 = (k + 1) % N, a = pos[j][k], b = pos[j][k1], c = pos[j + 1][k], d = pos[j + 1][k1];
      addN(a, c, b, j, k, j + 1, k, j, k1); addN(b, c, d, j, k1, j + 1, k, j + 1, k1);
    }
    const ids = pos.map((row, j) => row.map((p, k) => {
      const n = nrm[j][k], l = Math.hypot(n[0], n[1], n[2]) || 1;
      return vert(p[0], p[1], p[2], n[0] / l, n[1] / l, n[2] / l, 0);
    }));
    for (let j = 0; j + 1 < pos.length; j++) for (let k = 0; k < N; k++) {
      const k1 = (k + 1) % N;
      I.push(ids[j][k], ids[j + 1][k], ids[j][k1], ids[j][k1], ids[j + 1][k], ids[j + 1][k1]);
    }
    /* the tower: a rock lighthouse (Eddystone, Bishop Rock, Fastnet: a granite tower straight off a reef in the open sea),
       its solid base battered, the shaft a concave taper, a corbelled gallery, the lantern's glazing centred on the lamp's
       focal plane (K.lampM), a dark dome. 14 sides: at 3 km it is 4 px wide at its foot, the shading across it is what
       reads. From 2.5 m, sunk into the reef's crown */
    const f = K.lampM, H = f - 4.4;                                        // H: the corbel's foot
    const prof = [[6.3, 2.5, 1], [5.7, 5.5, 1]];                           // the base, battered
    for (let k = 1; k <= 6; k++) {                                         // the concave shaft, 5.7 m to 3.2 m
      const s = k / 6, y = 5.5 + (H - 5.5) * s;
      prof.push([3.2 + 2.5 * Math.pow(1 - s, 1.7), y, 1]);
    }
    prof.push([3.95, H + 1.4, 1], [3.95, H + 1.75, 2]);                    // the corbel, the gallery's lip
    prof.push([2.35, H + 1.75, 2], [2.35, f - 1.65, 2]);                   // the deck, the lantern's pedestal
    prof.push([2.35, f + 1.65, 3]);                                        // the glazing
    prof.push([2.55, f + 1.65, 4], [1.6, f + 2.9, 4], [0.45, f + 3.7, 4], [0.45, f + 4.1, 4], [0, f + 4.3, 4]);   // the dome, the ventilator
    lathe(prof, 14, 0, 0);
    /* the gallery's railing as a thin dark band (a 1 m rail is half a pixel at 3 km: it darkens the lip, no more) */
    lathe([[3.85, H + 1.75, 2], [3.85, H + 2.8, 2], [3.75, H + 2.8, 2], [3.75, H + 1.75, 2]], 14, 0, 0);
    return { v: new Float32Array(V), i: new Uint16Array(I) };
  }

  /* ── GLSL ── */
  /* the probe: 8 texels a world frame at the lighthouse. 0 the sun's illuminance, 1 the moon's, 2-4 the sky's light from
     above, the side and below (irradiance / pi), 5 the air between it and the window (rgb in-scatter, a transmittance),
     6 the rain's medium in front of it (the cloud buffer's sea rays just short of its foot: rgb, a), 7 x the clouds'
     shadow on it (for the key light), y their mean shadow */
  const PROBEFS = `
    uniform vec4 uMid;      // xyz the tower's middle, world m
    uniform vec4 uFoot;     // xyz a point on the sea 60 m short of the reef's waterline, toward the window
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
      } else c = vec3(wxCloudShadow(pm), wxCloudShadowMean(), 0.);
      o = vec4(wxGuard(c), clamp(a, 0., 1.));
    }`;
  const TOWERVS = `
    layout(location = 0) in vec3 aP; layout(location = 1) in vec3 aN; layout(location = 2) in float aM;
    uniform vec4 uBase;     // xyz the reef's origin, world m (at the sea's level, before the curvature), w its yaw rad
    out vec3 vP; out vec3 vN; out float vY; flat out float vM;
    void main() {
      float c = cos(uBase.w), s = sin(uBase.w);
      vec3 p = vec3(c * aP.x + s * aP.z, aP.y, -s * aP.x + c * aP.z) + uBase.xyz;
      p.y -= dot(p.xz, p.xz) / (2. * R_G * 1000.);          // the sea's curvature, as the cove is lowered (wxDrop)
      vP = p; vN = vec3(c * aN.x + s * aN.z, aN.y, -s * aN.x + c * aN.z); vY = aP.y; vM = aM;
      gl_Position = uViewProj * vec4(p, 1.);
    }`;
  const TOWERFS = `
    uniform sampler2D uProbe;
    uniform vec4 uBase;
    in vec3 vP; in vec3 vN; in float vY; flat in float vM;
    layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1;
    vec4 bcP(int i) { return texelFetch(uProbe, ivec2(i, 0), 0); }
    void main() {
      vec3 e = vec3(0., wxEye, 0.), rd = vP - e;
      float dist = length(rd); rd /= dist;
      vec3 n = normalize(vN);
      if (dot(n, rd) > 0.) n = normalize(n - rd * (dot(n, rd) + .05));   // a face seen edge-on: lit as its silhouette
      int m = int(vM + .5);
      /* albedo (linear), and wetness: the rock soaks and darkens in rain; the white paint barely */
      vec3 alb = m == 0 ? vec3(.15, .145, .135) : m == 1 ? vec3(.52, .51, .48) : m == 2 ? vec3(.045, .047, .05)
               : m == 3 ? vec3(.012, .014, .016) : vec3(.035, .045, .04);
      float soak = uWx4.x;
      alb *= m == 0 ? mix(1., .55, soak) : mix(1., .8, soak);
      /* the splash zone: the tower's foot is dark and wet as high as the swell throws the sea at it */
      if (m == 1) alb *= mix(1., .62, smoothstep(5. + 2.2 * uSwell.w, 3. + 1.2 * uSwell.w, vY));
      /* the rock at the waterline: in a swell the sea washes it white; the wash rises and falls with the swell (its
         period divides the sea's loop) round the reef, more on its windward side, the swell's height from the reading */
      if (m == 0) {
        float Hs = uSwell.w, st = uWx2.w;
        float th = atan(vP.z - uBase.z, vP.x - uBase.x);
        float ph = uTime.x * 6.2831853 / uSwell.z;
        float run = .5 + .5 * sin(ph - th * 2. + 1.3 * sin(th * 3.));
        float top = .3 + Hs * (.35 + .65 * run) * (.6 + .4 * st);
        float side = .55 + .45 * dot(normalize(vec2(vP.x - uBase.x, vP.z - uBase.z)), -normalize(uSwell.xy));
        float wash = smoothstep(top, top - .6 - .3 * Hs, vY) * smoothstep(-1.2, .1, vY) * smoothstep(.9, 2.2, Hs) * side;
        alb = mix(alb, vec3(.70, .72, .74), clamp(wash, 0., 1.) * .85);
      }
      /* in a heavy swell each crest that reaches the reef throws a sheet of white water up the tower's windward face
         (the rock lighthouse's storm picture): it climbs over ~1.5 s to a height set by the swell (up to ~4 Hs, every
         crest its own), streaked, then drains over ~3 s. The crest's time from the swell's own phase at the reef (its
         period divides the sea's loop, and a crest's index wraps with it: no seam) */
      if (m <= 1 && uSwell.w > 1.6) {
        float Hs = uSwell.w, T = uSwell.z;
        vec2 rel = vP.xz - uBase.xz, sd = normalize(uSwell.xy);
        float kx = 6.2831853 * 6.2831853 / (9.81 * T * T);                 // the swell's wavenumber (deep water)
        float cyc = uTime.x / T - kx * dot(uBase.xz, sd) / 6.2831853, ci = floor(cyc), tt = (cyc - ci) * T;
        float hc = fract(sin(mod(ci, 93.) * 12.9898 + 4.1) * 43758.5453);   // this crest's own strength
        float top = 2.5 + Hs * (1.2 + 2.8 * hc * hc) * smoothstep(1.6, 3.2, Hs) * smoothstep(0., 1.5, tt);
        float drain = 1. - smoothstep(1.5, 4.5, tt);
        float face = smoothstep(-.2, .7, dot(normalize(rel), -sd));          // the windward face
        float az = atan(rel.y, rel.x);
        float strk = fract(sin(floor(az * 9.) * 78.233 + ci) * 43758.5453), fall = smoothstep(top - (2. + 3. * strk), top, vY);
        float sheet = (1. - fall) * smoothstep(1., 3., vY) * face * drain * (.55 + .45 * strk);
        alb = mix(alb, vec3(.78, .80, .82), clamp(sheet, 0., 1.) * .9);
      }
      bool sunKey = dot(uKey.xyz, uSun.xyz) > .9999;
      vec4 sh = bcP(7);
      vec3 Es = bcP(0).rgb * (sunKey ? sh.x : sh.y), Em = bcP(1).rgb * (sunKey ? sh.y : sh.x);
      float up = n.y * .5 + .5;
      vec3 amb = up > .5 ? mix(bcP(3).rgb, bcP(2).rgb, up * 2. - 1.) : mix(bcP(4).rgb, bcP(3).rgb, up * 2.);
      vec3 L = alb / PI * (Es * max(dot(n, uSun.xyz), 0.) + (uMoon.y > -.05 ? Em * max(dot(n, uMoon.xyz), 0.) : vec3(0.)));
      L += alb * amb + alb / PI * wxFlashE(vP, n);
      if (m == 3 || m == 4) {
        /* the glazing and the dome: a smooth coat that mirrors the sky above the horizon (its light from above) */
        vec3 R = reflect(rd, n);
        float F = .04 + .96 * pow(1. - max(dot(n, -rd), 0.), 5.);
        L += F * (m == 3 ? 1. : .5) * mix(bcP(3).rgb, bcP(2).rgb, clamp(R.y * 2. + .5, 0., 1.)) * PI * .5;
        /* at night the lit lens shows through the glazing, in the lamp's colour (the core itself is the bolt slot's) */
        if (m == 3) L += uBeaconC.rgb * uBeacon.w * uExpo.x * 2e-4 * (1. - smoothstep(0., .5, abs(vY - ${K.lampM.toFixed(2)}) - .8));
      }
      vec4 ap = bcP(5), md = bcP(6);
      L = (L * ap.a + ap.rgb) * md.a + md.rgb;
      o0 = vec4(wxGuard(L), 1.);
      o1 = vec4(dist, 0., 0., 1.);
    }`;
  /* the lamp and the beams' shafts, one scissored draw round the lamp, added to SCENE */
  const LAMPFS = `
    uniform sampler2D uProbe;
    uniform vec4 uL;        // x the lamp's flux on the image toward the window (pre-exposed radiance x px^2, before the air), y the core's sigma px, z px per degree, w the glow's share in clear air
    uniform vec4 uL2;       // x the glow's soft ceiling (pre-exposed), y the sprite's radius px, z the distance m nearer than which the cove hides the lamp, w 0
    uniform vec4 uS;        // x the least scattering the beams find near the sea 1/m (the marine layer), y 0, z HG g, w the shafts' gain (0: none)
    uniform vec4 uS2;       // x the shafts' reach m, y the regularising radius m round the lamp, z samples per beam, w their soft ceiling (pre-exposed)
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
        float h = uL.x * share * mc / (6.2832 * l * l), G = uL2.x;
        h = G * (1. - exp(-h / G)) / mc;
        L += (uL.x * T * core + h * exp(-r / l) * (1. - smoothstep(.7 * uL2.y, uL2.y, r))) * seen;
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
              sum += prof * ph * exp(-sigE * (max(t, 0.) + rr)) * (1. - smoothstep(.45 * reach, reach, rr));
            }
            acc += sum * st;
          }
          /* under a soft ceiling on the brightest channel (uS2.w, pre-exposed): faint shafts that keep the lamp's colour,
             where a dark storm's exposure would draw the rain's forward-scattered beam near white */
          float Ls = uS.w * sigS * uBeaconC.w * uExpo.x / he * acc, mcs = max(uBeaconC.r, max(uBeaconC.g, uBeaconC.b));
          L += uS2.w * (1. - exp(-Ls * mcs / uS2.w)) / mcs;
        }
      }
      o = vec4(wxGuard(uBeaconC.rgb * L), 0.);
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

  return {
    name: "beacon",
    *build(R) {
      const gl = R.gl, G = R.gpu;
      P.probe = R.program("beacon.probe", { fs: PROBEFS, libs: ["atmo", "clouds"] });
      P.tower = R.program("beacon.tower", { vs: TOWERVS, fs: TOWERFS });
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
      geo = { vao, count: m.i.length, tris: m.i.length / 3 };
      const t = G.tex2D(8, 1, "rgba16f", { filter: "nearest" });
      probe = { tex: t, fb: G.fbo([t]), ok: false };
      /*@lab*/ R.debugTex("beacon.probe", t, "raw"); R.priv.beacon = { tris: geo.tris }; /*@end*/
      yield* R.wait(P.probe, P.tower, P.lamp);
    },
    ubo(F, R, set) {
      const B = R.beacon || (R.beacon = WX.beaconDefaults());
      let az = K.az, km = K.km, lampK = 1, beamK = 1, hold = false;
      /*@lab*/ az = R.p("beacon.az"); km = R.p("beacon.km"); lampK = R.p("beacon.lamp"); beamK = R.p("beacon.beam"); hold = R.p("beacon.hold") > 0; /*@end*/
      const x = km * 1000 * Math.sin(az * D2R), z = km * 1000 * Math.cos(az * D2R);
      const drop = (x * x + z * z) / (2 * WX.R_G * 1000);
      B.pos[0] = x; B.pos[1] = K.lampM - drop; B.pos[2] = z;
      B.base = B.base || [0, 0, 0, 0];
      B.base[0] = x; B.base[1] = 0; B.base[2] = z; B.base[3] = 0.4;
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
      /* the photocell: the night intensity from the sun 8 deg under the horizon, the day's from 2 deg under it */
      const sunEl = Math.asin(U.clamp(F.sun.dir[1], -1, 1)) / D2R, day = U.smooth(K.dayEl[0], K.dayEl[1], sunEl);
      B.I = (U.lerp(K.cd.lanternNight, K.cd.lanternDay, day) / 128000) * lampK;
      B.Ib = (U.lerp(K.cd.beamNight, K.cd.beamDay, day) / 128000) * beamK;
      /* the beams: a turn every K.turn s of the sea's clock (it wraps at 1024 s, 64 turns: no seam), clockwise from
         above; a still, and the lab's hold, show them 90 deg off the window (two shafts, not a frozen flash) */
      const toEye = Math.atan2(-x, -z);
      B.angle = F.still || hold ? toEye + Math.PI / 2 : 2 * Math.PI * ((F.t.ocean / K.turn) % 1);
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
        const D = Math.hypot(B.pos[0], B.pos[2]), fx = B.pos[0] / D, fz = B.pos[2] / D, fd = D - 60;
        uMid[0] = B.pos[0]; uMid[1] = 22; uMid[2] = B.pos[2];
        uFoot[0] = fx * fd; uFoot[1] = -(fd * fd) / (2 * WX.R_G * 1000); uFoot[2] = fz * fd;
        R.draw(P.probe, probe.fb, uniP, PROBE_VP);
        probe.ok = true;
        /*@lab*/
        const pv = R.priv.beacon;
        if (pv && !pv.reading && (pv.n = (pv.n || 0) + 1) % 30 === 1) {
          pv.reading = true;
          if (!R.gpu.readback(probe.fb.fb, 0, 0, 8, 1, (px) => { pv.reading = false; pv.probe = Array.from(px, (v) => +v.toPrecision(4)); })) pv.reading = false;
        }
        /*@end*/
        /* the reef and the tower, depth-tested and depth-writing, into SCENE and SCENEZ as the cove */
        R.bind("coast");
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
        gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true);
        P.tower.use();
        uBase[0] = B.base[0]; uBase[1] = B.base[1]; uBase[2] = B.base[2]; uBase[3] = B.base[3]; uniT.uProbe = probe.tex;
        R.gpu.uniforms(P.tower, uniT);
        gl.bindVertexArray(geo.vao);
        gl.drawElements(gl.TRIANGLES, geo.count, gl.UNSIGNED_SHORT, 0);
        gl.bindVertexArray(null);
        gl.disable(gl.DEPTH_TEST);
      },
      bolt(R, F) {
        const B = R.beacon;
        if (!B || !B.on || !probe || !probe.ok || B.uv[0] < -0.5) return;
        const gl = R.gl, S = R.size.S, cam = R.cam, E = R.exposure.E;
        const ppr = S[1] / (2 * cam.tanY);
        const dx = B.pos[0], dy = B.pos[1] - WX.EYE_M, dz = B.pos[2], D = Math.hypot(dx, dy, dz);
        const vis = Math.max(F.W.vis || 30, 0.2), Te = Math.exp((-3.912 * D) / (1000 * vis));
        /* the lamp toward the window: the lantern, and the beams' pattern there (the flash) */
        const Ieye = B.I + B.Ib * B.eye;
        uL[0] = (Ieye * E * ppr * ppr) / (D * D);
        uL[1] = 0.6;                                      // a point under a pixel: the image's own blur
        uL[2] = ppr * D2R;                                // px per degree (the glow's width is set on the GPU from the probe's tau)
        uL[3] = 0.03;
        uL2[0] = 0.3;
        const lam = uL[2] * (0.06 + 0.35 * (1 - Math.exp(-0.5 * (3.912 * D) / (1000 * vis))));
        const rs = Math.min(Math.max(Math.ceil(6 * lam + 3), 6), 64);
        uL2[1] = rs; uL2[2] = D - 40; uL2[3] = 0;
        /* the shafts: the air's scattering from the visibility (Koschmieder), at least the marine layer's near the sea;
           worth drawing where they can show (dusk, night, rain or haze), never by day in clear air */
        let air = 0.15, shaftK = 1, reach = 900;
        /*@lab*/ air = R.p("beacon.air"); shaftK = R.p("beacon.shaft"); reach = R.p("beacon.reach"); /*@end*/
        const sunEl = Math.asin(U.clamp(F.sun.dir[1], -1, 1)) / D2R;
        const dark = 1 - U.smooth(-3, 4, sunEl), murk = U.smooth(0.15, 0.6, F.W.precip || 0) + U.smooth(12, 4, vis);
        const show = Math.min(1, dark + 0.6 * murk);
        uS[0] = air * 1e-3; uS[1] = 0; uS[2] = U.lerp(0.7, 0.82, U.smooth(0.1, 0.8, F.W.precip || 0)); uS[3] = show > 0.01 ? show * shaftK : 0;
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
        if (x1 <= x0 || y1 <= y0) return;
        R.bind("scene");
        gl.enable(gl.SCISSOR_TEST); gl.scissor(x0, y0, x1 - x0, y1 - y0);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.depthMask(false);
        uniL.uProbe = probe.tex;
        R.draw(P.lamp, "scene", uniL);
        gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST); gl.depthMask(true);
        /*@lab*/ Object.assign(R.priv.beacon, { box: [x0, y0, x1 - x0, y1 - y0], flux: +uL[0].toPrecision(4), eye: +B.eye.toFixed(4), Te: +Te.toPrecision(3), shaft: +uS[3].toFixed(3), E: +E.toPrecision(4) }); /*@end*/
      },
    },
  };
})());
