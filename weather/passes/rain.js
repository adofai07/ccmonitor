/* rain (stream C): the near streaks and the far curtains. [1.2] No RAIN target and an empty rain slot
   (contract section 4, noTargets): post draws the view through the glass to the canvas and then calls
   R.priv.rainDraw, which draws the streaks over it in display space (graded per streak), faded where a
   drop or the mist covers the glass; the curtains are the "rainfar" GLSL library the view calls on the
   scene behind the glass.

   STREAKS (render.md 10.1): stateless and instanced, knobs.streaks x precip drops, each a hash of its
   instance id. A drop falls at the terminal speed of its size (Atlas-Ulbrich), at a log-uniform distance
   (near 1.5-30 m, far 25-160 m: each streak stands for the drops near its distance), carried by the local
   wind (its sideways part in full, its part toward the window damped). Its fall repeats in a cycle that
   spans about twice the frustum's height at its distance, k cycles in 240 s exactly (k an integer per
   drop), so the rain clock's wrap is seamless; each cycle places it anew. Its streak is the path over
   the shutter (1/30 s near, 1/14 s far), drawn at least 1 px wide with its alpha cut to its true width,
   a brighter core along its middle, never depth-tested. Radiance after Garg and Nayar: a drop refracts
   some 165 deg of what is round it, so it shows the sky low over the sea mixed with the local
   background, plus the sun's forward glint and the flash (wxFlashE): streaks stand out against the dark
   sea and nearly vanish against the sky. The count follows precip with a fractional last drop.
   CURTAINS: two sheets (three from T3) of heavier rain hanging from the cloud base at 0.9, 1.35 and
   2 km, each a noise along the sheet (shafts 150-300 m wide, drifting across the view at [r3] 20 m/s, two
   copies half a 240 s loop apart cross-faded so the loop has no seam) times falling, wind-slanted
   striation (4 whole texture periods per loop), from a 64 x 64 noise texture made at build; where the scene lies beyond a sheet it occludes part of it and adds its own light, both seen
   through the air in front: L' = L (1 - a) + a (Lair (1 - T) + T Lair uCurt.w), Lair the air's own
   light (wxAerial at 0.9 km, its optical depth scaled for the farther sheets).            */
WX.lib("rainfar", `
uniform sampler2D uRainNoise;   // 64 x 64 value noise, repeating, made at build (rain.js)
uniform vec4 uCurt;             // x strength 0..1, y the drift's direction (+1 to the right), z cloud base m, w the sheets' light vs the air's
uniform float uCurtN;           // sheets drawn (2 or 3)
float rfN(vec2 p) { return texture(uRainNoise, p / 64.).r; }
vec3 rainCurtain(vec3 L, vec2 uv) {
  if (uCurt.x <= 0.) return L;
  vec3 d = wxRay0(uv);
  float zc = texture(sSceneZ, uv).r;
  float dist = zc > 0. ? zc : (d.y < -1e-4 ? wxEye / -d.y : 1e9);
  if (dist < 900.) return L;
  float az = atan(d.x, d.z), hz = max(length(d.xz), 1e-3), ph = uTime.y / 240.;
  /* the air to the nearest sheet; the farther ones scale its optical depth */
  vec4 ap0 = wxAerial(d, .9);
  float tau0 = -log(max(ap0.a, 1e-4));
  vec3 Lair = ap0.rgb / max(1. - ap0.a, .05);                  // the air's own light over a long path
  for (int k = 0; k < 3; k++) {
    if (float(k) >= uCurtN) break;
    float D = 900. * pow(1.5, float(k));
    if (dist < D) break;                                       // the scene is nearer than this sheet (and the farther ones)
    float y = wxEye + d.y * D / hz;
    if (y > uCurt.z || y < -5.) continue;
    /* along the sheet in 37.5 m texels, drifting [r3] 20 m/s with the storm (two whole texture periods per
       240 s; 10 m/s barely moved at 0.9-2 km); two copies half a loop apart, each faded out at its own wrap
       (weights 1 - |2 x - 1| sum to 1), so the 240 s loop has no seam */
    float s = az * D / 37.5 + float(k) * 23., n = 0.;
    for (int c = 0; c < 2; c++) {
      float x = fract(ph + .5 * float(c)), sc = s - uCurt.y * 128. * x + 17. * float(c);
      n += (1. - abs(2. * x - 1.)) * (.65 * rfN(vec2(sc * .25, float(k) * 9.)) + .35 * rfN(vec2(sc * .5 + 7., float(k) * 9. + 30.)));
    }
    float shaft = smoothstep(.42, .75, n);
    /* striation: 6 m texels across, slanted with the wind, falling 8 m/s (4 periods of 480 m per 240 s) */
    float st = rfN(vec2(az * D / 6. - uCurt.y * y * .1, y / 7.5 + 256. * ph));
    float fade = smoothstep(uCurt.z, uCurt.z * .75, y) * .55 + .45;
    float a = uCurt.x * shaft * (.8 + .2 * st) * fade * .4;
    if (a <= .002) continue;
    float T = exp(-tau0 * D / 900.);
    L = L * (1. - a) + a * (Lair * (1. - T) + T * Lair * uCurt.w);
  }
  return L;
}
`);
WX.pass((function () {
  WX.param("rain.alpha", 1, 0, 3, 0.05, "rain");
  WX.param("rain.count", 1, 0, 2, 0.05, "rain");            // x knobs.streaks
  WX.param("rain.curtain", 1, 0, 3, 0.05, "rain");
  WX.param("rain.curtainLight", 1.15, 0.2, 2, 0.05, "rain");
  WX.param("rain.farTier", 0, 0, 5, 1, "rain");             // [r3] the lowest tier that draws the far streaks
  let P = null, quad = null, vao = null, noise = null;
  const U = { uDown: null, uLev: 5, uCount: 0, uShutter: 0.02, uAlpha: 1, uD: new Float32Array([1.5, 30, 0, 0]), uScot: 1 };
  const curt = new Float32Array(4);
  function draw(R, F, scot) {
    const gl = R.gl, pyr = R.priv.pyr, pane = R.priv.pane;
    const count = (R.knobs.streaks || 0) * R.p("rain.count") * F.W.precip * (0.75 + 0.25 * F.W.storm);
    if (!pyr || !pane || count < 1 || !P || !(R.p("rain.alpha") > 0)) return;
    pane.fill(U, F, R);
    if (R.priv.toneFill) R.priv.toneFill(U);
    U.uDown = pyr.down; U.uLev = pyr.levels - 1; U.uScot = scot;
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    P.use();
    gl.bindVertexArray(vao);
    /* the far rain first (25-160 m, a longer persistence so it reads as streaks), then the near; [r3] the far
       streaks from rain.farTier up (below it the curtains carry the far rain) */
    U.uAlpha = R.p("rain.alpha");
    if (R.tier >= R.p("rain.farTier")) {
      U.uCount = count * 0.8; U.uShutter = 1 / 14;
      U.uD[0] = 25; U.uD[1] = 160; U.uD[2] = 1;
      R.gpu.uniforms(P, U);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, Math.ceil(U.uCount));
    }
    U.uCount = count; U.uShutter = 1 / 30;
    U.uD[0] = 1.5; U.uD[1] = 30; U.uD[2] = 0;
    R.gpu.uniforms(P, U);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, Math.ceil(count));
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }
  function fill(u, F, R) {
    const W = F.W, wn = F.wind || WX.windAt(W, F.t);
    curt[0] = R.p("rain.curtain") * WX.util.smooth(0.55, 1, W.precip) * (0.35 + 0.65 * W.storm);
    curt[1] = wn.wind.dir[0] >= 0 ? 1 : -1;
    curt[2] = W.base * 1000; curt[3] = R.p("rain.curtainLight");
    u.uCurt = curt; u.uRainNoise = noise; u.uCurtN = R.tier >= 3 ? 3 : R.tier >= 2 ? 2 : 1;
  }
  return {
    name: "rain",
    *build(R) {
      quad = vao = null;
      P = R.program("rain.streaks", { libs: ["atmo", "clouds", "grade", "rainfar", "pane"], vs: `
        layout(location = 0) in vec2 aPos;
        uniform float uCount, uShutter, uAlpha, uScot;
        uniform vec4 uD;            // x, y the distances (m, log-uniform), z the salt (0 near, 1 far)
        flat out vec3 vL, vLF; flat out vec3 vW; out vec2 vQ;
        vec2 toPx(vec4 c) { return (c.xy / c.w * .5 + .5) * uRes.xy; }
        void main() {
          float id = float(gl_InstanceID);
          vec3 h = wxHash33(vec3(id, 1. + uD.z * 13., 7.));
          float D = mix(.9, 4.2, h.x * h.x);                                  // drop diameter mm
          float vy = max(9.65 - 10.3 * exp(-.6 * D), 2.);                      // Atlas-Ulbrich terminal speed m/s
          float d = uD.x * pow(uD.y / uD.x, h.y);
          float Hc0 = 2.1 * d * uCamY.w * 2. + 2.;
          float k = max(1., floor(240. * vy / Hc0 + .5)), Tc = 240. / k;      // k cycles in 240 s exactly
          float cyc = h.z + uTime.y / Tc, f = fract(cyc), c = mod(floor(cyc), k);
          vec3 g = wxHash33(vec3(id, c, 3. + uD.z * 5.));
          vec2 sxy = (g.xy * 2. - 1.) * 1.1;
          vec3 eye = vec3(0., wxEye, 0.);
          vec3 pm = eye + d * (uCamZ.xyz + sxy.x * uCamX.w * uCamX.xyz + sxy.y * uCamY.w * uCamY.xyz);
          vec3 vel = vec3(uWind.x * uWind.z * .75, -vy, uWind.y * uWind.z * .22);
          vec3 p = pm + vel * (f - .5) * Tc;
          vec3 pt = p - vel * uShutter;
          vec4 c1 = wxClipFlat(p), c0 = wxClipFlat(pt);
          float fade = smoothstep(0., .06, f) * smoothstep(1., .94, f) * clamp(uCount - id, 0., 1.);
          if (c1.w < .3 || c0.w < .3 || fade <= 0.) { gl_Position = vec4(2., 2., 2., 1.); return; }
          vec2 a = toPx(c0), b = toPx(c1), ab = b - a;
          float len = max(length(ab), 1.5);
          vec2 dir = length(ab) > 1e-3 ? ab / length(ab) : vec2(0., -1.), nrm = vec2(-dir.y, dir.x);
          float trueW = D * 1e-3 / (c1.w * 2. * uCamY.w) * uRes.y;             // its real width px
          float w = max(trueW, 1.);
          vec2 q = vec2(aPos.x * .5 + .5, aPos.y);
          vec2 px = a - dir * .75 + dir * (len + 1.5) * q.x + nrm * (w * .5 + .75) * q.y;
          vQ = vec2(q.x, q.y * (w * .5 + .75));
          vW = vec3(w, len, 0.);
          gl_Position = vec4(px * uRes.zw * 2. - 1., 0., 1.);
          /* Garg and Nayar: the drop shows the mean of what is round it, the sky low over the sea (the median of
             three taps: a moon or a sun in one of them must not light every streak) and the local background */
          vec2 uv = clamp(b * uRes.zw, vec2(.01), vec2(.99));
          vec3 bg = textureLod(uDown, uv, 2.).rgb;
          vec3 s1 = textureLod(uDown, vec2(.15, .6), uLev).rgb, s2 = textureLod(uDown, vec2(.5, .62), uLev).rgb, s3 = textureLod(uDown, vec2(.85, .6), uLev).rgb;
          vec3 sky = max(min(s1, s2), min(max(s1, s2), s3));
          vec3 L = mix(sky, bg, .35) * 1.6;
          vec3 v = normalize(p - eye);
          L += wxSunLight(wxPlanet(eye)) * wxCloudShadowMean() * wxHG(dot(v, uSun.xyz), .7) * .02 * step(0., uSun.y);
          /* [r3] the flash lights the drop only for its strokes' millisecond: a bright bead at the streak's head,
             not the whole 1/30 s streak (which drew white scratches across a lit storm) */
          vec3 Lf = min(wxFlashE(p, vec3(0.)) * .25, vec3(.3));
          /* [r3] a little stronger in a storm (uWx2.w), so the streaks read at 1080p without zooming */
          float al = mix(.36, .12, smoothstep(1.5, 30., d)) * (1. + .3 * uWx2.w) * uAlpha * clamp(trueW / w * 2., .3, 1.) * fade;
          al *= min(1., 2.5 / len + .55);                                       // a long streak: the drop crossed each pixel briefly
          /* outside the glass: a drop on it or the mist inside hides the streak behind (sampled at its middle) */
          vec2 mid = (a + b) * .5 * uRes.zw;
          float cov = uOn.x > .5 ? smoothstep(0., .06, paneH(mid)) : 0.;
          al *= (1. - cov) * (1. - paneMist(mid)) * uTier.w;
          vL = grade(L, uScot); vLF = dot(Lf, Lf) > 0. ? grade(L + Lf * 3., uScot) : vL; vW.z = al;
        }`, fs: `
        flat in vec3 vL, vLF; flat in vec3 vW; in vec2 vQ; out vec4 o;
        void main() {
          float w = vW.x * .5, x = abs(vQ.y);
          float ac = (1. - smoothstep(w - .5, w + .6, x)) * (.6 + .4 * exp(-2. * x * x / max(w * w, .25)));
          float along = vQ.x * (vW.y + 1.5);
          float ends = smoothstep(0., 1.6, along) * smoothstep(vW.y + 1.5, vW.y - .2, along);
          float hd = vW.y + .75 - along, head = exp(-hd * hd / 2.);         // the head: where the drop is now
          float a = vW.z * ac * ends;
          o = vec4(mix(vL, vLF, head) * a, a);
        }` });
      yield* R.wait(P);
      const gl = R.gl;
      quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      /* the curtains' noise: 64 x 64 bytes of a seeded hash, repeating (one upload, at build) */
      const nd = new Uint8Array(64 * 64);
      let h = 0x1234567;
      for (let i = 0; i < nd.length; i++) { h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) + 0x297a2d39 | 0; h ^= h >>> 12; nd[i] = h & 255; }
      noise = R.gpu.tex2D(64, 64, "r8", { wrap: "repeat", data: nd });
      R.priv.rainDraw = draw;
      R.priv.rainFill = fill;
    },
  };
})());
