/* ═══════════════════════ Weather lab: the lab driver (LAB ONLY, never merged) ═══════════════════════
   Owner after the skeleton: the director/core stream (E). Builds F straight from URL parameters
   and the panel, so a pass can be looked at in any weather and light without the director:

   v=0..100 reading · plan=max20|max5|pro (critical 99.75 | 99 | 95) · held=0..1 (mist)
   wet= bolt= soak= puddle= (walkers, default at their targets) · tod=noon|afternoon|golden|sunset|blue|night|dark|crescent
   sunEl= sunRight= moonEl= moonRight= (deg; right of the view's centre) · lat= lst= (deg, stars)
   q=0..4 tier · still=1 · t0=s scene clock start (default 1000) · strike=s (force a flash at that scene time)
   freeze=s (the scene clock stops there: a screenshot can catch a flash, e.g. strike=1001&freeze=1001.08)
   [critic] strikeAz=deg (right of the view's centre) strikeKm=km strikeP=0..1: where the forced strike lands
   and how near it reads (default random), e.g. behind the left head: strikeAz=-38&strikeKm=4
   [1.2] strikeKind=0|1 the forced strike's kind (0 in-cloud, 1 cloud-to-sea; default random from W.cgShare).
   [1.3] seed=N seeds the strike scheduler (WX.rng(N) in place of Math.random), so a forced strike's channel shape,
   in-cloud height and restrikes, and the scheduled strikes after it, repeat from run to run (with api=1: the
   director's seed). The presets that show lightning give seed, strikeKind, strikeP, strikeAz and strikeKm.
   [1.3] The GPU time of every frame after ready (the sum of its slots' queries, R.onGpu) is kept, and
   summary().frame gives its n, mean, p50, p95, p99 and max (ms); summary().cove the cove's loading state.
   Strikes come from the director's own scheduler (WX.lightning, fed Math.random, so a seeded Math.random
   repeats them): >= 2.5 s after the last start and 1 s after the last envelope, and none before a forced
   strike= has fired, so a frozen flash frame shows that strike alone. I is exposure-normalised (WX.flashI).
   p.flash.cap=, p.flash.peak= (lab knobs) set WX.FLASH.cap and .peak, e.g. to try post's flash limit.
   [1.2] warm=1|still|cove|0 (default 1). Before the scene clock starts, the lab warms up, and those frames do
   not count in frames=, so t0, strike= and freeze= are seconds of a settled view. First, as the API does
   before it shows the view, converged stills (F.still: the exposure snaps, the clouds trace in full, the drops
   start at their steady state) until post has metered three times (or 12 frames); warm=still stops there, an
   exact copy of the product's start. Then (warm=1) moving frames with the clock held at t0 and no lightning
   until the exposure has settled (three metering passes in a row within 1.5 %, at most 8 s): the still meter
   reads up to a stop darker than the moving one (g: E 105 after the stills, 49 settled), and a frozen flash
   locks whatever exposure it meets (round 1's h at strike=1001: E 1.7e5 against a settled 2.1e4, a white-out).
   warm=cove also waits until the cove is in and risen (at most 30 s). warm=0: none, as in round 1.
   [1.2] taatest=1 registers a minimal "taa" slot (a 3x3-clamped exponential blend, 0.1 a world frame) to check
   the core's TAA plumbing: the jitter switches on, R.taa.out is bound as sScene after the slot. Not C's resolve.
   view=<texture> vscale= vlod= vmode= · frames=N (WXLAB.done after N frames) · ui=0 (no panel)
   lose=ms (lose the context ms after ready, restore 1 s later) · api=1 (hand over to WX.apiLab, stream E)
   [E] qto=N@s (switch to tier N s seconds after ready, through R.resize as the governor does)
   p.<name>=value sets a pass's tuning knob (WX.param) · [r4] tk<N>.<knob>=value sets tier N's knob (WX.TIERS)
   [r5] det=1 (programs ready at first ask) · rbhold=N (no readback consumed from N frames after the warm-up): pixel
   identity between runs on a GPU whose timings vary (below, where the context is made)  */
(function () {
  const Q = new URLSearchParams(location.search);
  const num = (k, d) => (Q.has(k) && Q.get(k) !== "" && isFinite(+Q.get(k)) ? +Q.get(k) : d);
  const D = Math.PI / 180;
  const TOD = {
    noon: [62, 0, -40, 0], afternoon: [26, -15, -40, 0], golden: [8, 20, -30, -60], sunset: [1.2, 12, -30, -60],
    blue: [-5, 14, -30, -60], night: [-25, 180, 20, -25], dark: [-30, 180, -25, 0], crescent: [-8, 28, 7, 20],
  };
  const S = {
    v: num("v", 55), plan: Q.get("plan") || "max20", held: num("held", 0),
    wet: Q.has("wet") ? num("wet", 1) : null, bolt: Q.has("bolt") ? num("bolt", 1) : null,
    soak: Q.has("soak") ? num("soak", 0) : null, puddle: Q.has("puddle") ? num("puddle", 0) : null,   // [v1.1]
    tod: Q.get("tod") || "golden", lat: num("lat", 38), lst: num("lst", 80),
    q: Q.has("q") ? num("q", 2) : null, still: Q.get("still") === "1",
    t0: num("t0", 1000), strike: Q.has("strike") ? num("strike", 0) : null, freeze: Q.has("freeze") ? num("freeze", 0) : null,
    strikeAz: Q.has("strikeAz") ? num("strikeAz", 0) : null, strikeKm: Q.has("strikeKm") ? num("strikeKm", 5) : null,   // [critic]
    strikeP: Q.has("strikeP") ? num("strikeP", 1) : null,
    strikeKind: Q.has("strikeKind") ? num("strikeKind", 1) : null,                                          // [1.2]
    frames: num("frames", 0), ui: Q.get("ui") !== "0", warm: Q.get("warm") !== "0", warmCove: Q.get("warm") === "cove",
    warmSettle: Q.get("warm") !== "still",
  };
  const t = TOD[S.tod] || TOD.golden;
  S.sunEl = num("sunEl", t[0]); S.sunRight = num("sunRight", t[1]); S.moonEl = num("moonEl", t[2]); S.moonRight = num("moonRight", t[3]);
  for (const [k, v] of Q) if (k.startsWith("p.")) WX.labParam = Object.assign(WX.labParam || {}, { [k.slice(2)]: +v });
  /* [r4] tk<N>.<knob>=value sets tier N's knob (WX.TIERS[N][knob]) before anything is built, in the lab and with
     api=1 (the governor's ladder): to time a candidate tier, e.g. tk1.px=0.6e6&tk1.worldEvery=1 */
  for (const [k, v] of Q) { const m = /^tk([0-4])\.(\w+)$/.exec(k); if (m && m[2] in WX.TIERS[+m[1]] && isFinite(+v)) WX.TIERS[+m[1]][m[2]] = +v; }
  if (Q.has("seed")) WX.labSeed = num("seed", 1) >>> 0;                                                 // [1.3]

  const LAB = (window.WXLAB = { ready: false, frames: 0, errors: [], losses: 0, done: false, state: S, R: null, F: null });
  const fail = (e) => { LAB.errors.push(String(e && e.stack || e)); console.error(e); paintStatus(); };
  addEventListener("error", (e) => fail(e.error || e.message));

  const canvas = document.getElementById("c");
  const gpuMs = new Float32Array(4096);                                                             // [1.3]
  let gpuN = 0;
  const paceMs = new Float32Array(4096);                                                            // [r3] rAF intervals
  let paceN = 0;
  /* [r3] the cadence the frames came at (ms between rAF callbacks once ready): p50, p95, and the share later than
     1.25 display intervals (the governor's 'late'), as the frame GPU time cannot show a CPU-bound or blocked frame */
  LAB.paceStats = () => {
    const n = Math.min(paceN, paceMs.length);
    if (!n) return null;
    const a = Array.from(paceMs.subarray(0, n)).sort((x, y) => x - y), iv = a[n >> 1];
    return { n, p50: +iv.toFixed(2), p95: +a[Math.floor(n * 0.95)].toFixed(2), late: +(a.filter((x) => x > 1.25 * iv).length / n).toFixed(3) };
  };
  /* [1.3] the frames' GPU ms: n, mean, p50, p95, p99, max over the last `last` frames (default all kept) */
  LAB.frameStats = (last) => {
    const n = Math.min(gpuN, gpuMs.length, last || Infinity);
    if (!n) return null;
    const a = [];
    for (let k = gpuN - n; k < gpuN; k++) a.push(gpuMs[k % gpuMs.length]);
    const mean = a.reduce((x, y) => x + y, 0) / n;
    a.sort((x, y) => x - y);
    const q = (f) => +a[Math.min(n - 1, Math.floor(n * f))].toFixed(3);
    return { n, mean: +mean.toFixed(3), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +a[n - 1].toFixed(3) };
  };
  LAB.frameSeries = () => { const n = Math.min(gpuN, gpuMs.length), a = []; for (let k = gpuN - n; k < gpuN; k++) a.push(+gpuMs[k % gpuMs.length].toFixed(3)); return a; };
  if (Q.get("taatest") === "1") WX.pass((function () {
    let P = null, H = [null, null], cur = 0;
    return {
      name: "taatest",
      *build(R) {
        P = R.program("taatest", { fs: `
          uniform sampler2D uHist; in vec2 vUV; out vec4 o;
          void main() {
            ivec2 p = ivec2(gl_FragCoord.xy), hi = ivec2(uRes.xy) - 1;
            vec4 c = texelFetch(sScene, p, 0);
            if (uTaa1.z < .5) { o = c; return; }
            vec3 mn = c.rgb, mx = c.rgb;
            for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
              vec3 s = texelFetch(sScene, clamp(p + ivec2(x, y), ivec2(0), hi), 0).rgb; mn = min(mn, s); mx = max(mx, s);
            }
            vec3 h = clamp(texelFetch(uHist, p, 0).rgb, mn, mx);
            o = vec4(mix(h, c.rgb, .1), c.a);
          }` });
        yield* R.wait(P);
      },
      resize(R) {
        const [w, h] = R.size.S;
        for (let k = 0; k < 2; k++) { const t = R.gpu.tex2D(w, h, "rgba16f", { filter: "nearest" }); t.fb = R.gpu.fbo([t]); H[k] = t; }
      },
      slots: {
        taa(R, F) {
          const src = H[cur], dst = H[cur ^ 1];
          R.draw(P, dst.fb, { uHist: src });
          R.taa.out = dst; cur ^= 1;
        },
      },
    };
  })());
  if (Q.get("api") === "1" && WX.apiLab) { WX.apiLab(canvas, Q, LAB); return; }

  const attrs = { alpha: false, depth: false, stencil: false, antialias: false, premultipliedAlpha: true,
                  preserveDrawingBuffer: false, powerPreference: Q.get("power") || "default" };
  const gl = canvas.getContext("webgl2", attrs);
  if (!gl) { fail("no WebGL2"); return; }
  /* [r5] Two knobs for pixel identity between runs (D's equivalence on Intel, whose timings vary from run to run),
     on this context only, so the lab and the built bundle behind this driver get them alike:
     det=1     a program reads as compiled as soon as it is asked (COMPLETION_STATUS_KHR true): its first use then
               waits for the link, so every program starts on the frame it is first asked for, not on the frame the
               driver happens to finish it (the cove's programs gate its rise, and the rise the warm-up's end);
     rbhold=N  N drawn frames after the warm-up (0: at once), every fence made from then on reads as never signalled,
               so post consumes no more readbacks: the exposure's target, the white balance and the scrim grid hold
               where the warm-up left them (the exposure still eases to that target on the clock).
     Both wrap the prototype's methods, so a harness that patched those (equiv.cjs's fences) still runs under them. */
  {
    const proto = Object.getPrototypeOf(gl), CS = 0x91B1;   // COMPLETION_STATUS_KHR
    if (Q.get("det") === "1") gl.getProgramParameter = function (p, k) { return k === CS ? true : proto.getProgramParameter.call(this, p, k); };
    if (Q.has("rbhold")) {
      const after = num("rbhold", 0);
      gl.fenceSync = function (c, f) {
        const s = proto.fenceSync.call(this, c, f);
        if (s && LAB.ready && LAB.frames >= after) { s.__held = true; LAB.rbHeld = (LAB.rbHeld || 0) + 1; }
        return s;
      };
      gl.clientWaitSync = function (s, f, t) { return s && s.__held ? this.TIMEOUT_EXPIRED : proto.clientWaitSync.call(this, s, f, t); };
      gl.getSyncParameter = function (s, k) { return s && s.__held && k === this.SYNC_STATUS ? this.UNSIGNALED : proto.getSyncParameter.call(this, s, k); };
    }
  }
  let R = null;
  function make() {
    for (const [k, v] of Object.entries(WX.labParam || {})) if (WX.params[k]) WX.params[k].v = v;
    R = LAB.R = WX.renderer(canvas, gl, { timing: true });
    for (const [k, v] of Object.entries(WX.labParam || {})) if (WX.params[k]) WX.params[k].v = v;   // [r3] knobs the renderer registers
    /* [1.3] each frame's GPU ms (the sum of its slots), once the view is ready and warmed up */
    R.onGpu = (ms) => { if (LAB.ready && ms !== null && ms > 0) { gpuMs[gpuN % gpuMs.length] = ms; gpuN++; } };
    const discrete = /NVIDIA|GeForce|RTX|Quadro|Radeon (RX|Pro)|Arc [AB]\d|Apple M\d (Pro|Max|Ultra)/i.test(R.caps.renderer);
    LAB.tier = S.q !== null ? S.q : discrete ? 4 : 2;
    R.resize(innerWidth, innerHeight, devicePixelRatio || 1, LAB.tier);
    R.view = Q.get("view") ? { name: Q.get("view"), scale: num("vscale", 1), lod: num("vlod", 0) } : null;
    LAB.renderer = R.caps.renderer;
  }
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); LAB.losses++; R = null; LAB.ready = false; warm = null; });
  canvas.addEventListener("webglcontextrestored", () => { try { make(); } catch (e) { fail(e); } });
  try { make(); } catch (e) { fail(e); return; }
  let resizeT = 0;
  addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (R) R.resize(innerWidth, innerHeight, devicePixelRatio || 1, LAB.tier); }, 150); });

  /* ── the frame state, from the controls ── */
  const F = (LAB.F = WX.frameDefaults());
  let scene = S.t0, last = 0, frameNo = 0, warm = null;
  /* [1.2] the director's scheduler (one for the product and the lab), and the flash knobs */
  const LT = WX.lightning(WX.labSeed !== undefined ? WX.rng(WX.labSeed) : Math.random);        // [1.3] seed=
  WX.param("flash.cap", WX.FLASH.cap, 0.01, 2, 0.01, "core");
  WX.param("flash.peak", WX.FLASH.peak, 1e-5, 3e-3, 1e-5, "core");
  /* [r5] lab.tod=N (0 noon .. 7 crescent, TOD's order) sets the sun and the moon each frame, so abtoggle.cjs can flip day and
     night in one page (a paired cost on a GPU whose clock drifts); -1: the URL's sky */
  WX.param("lab.tod", -1, -1, 7, 1, "core");
  for (const k of ["flash.cap", "flash.peak"]) if (WX.labParam && k in WX.labParam) WX.params[k].v = WX.labParam[k];
  const wrap = (x, p) => ((x % p) + p) % p;
  function starMatrix(latDeg, lstDeg, headingDeg) {
    const sl = Math.sin(lstDeg * D), cl = Math.cos(lstDeg * D), sp = Math.sin(latDeg * D), cp = Math.cos(latDeg * D);
    const eq = [-sl, -sp * cl, cp * cl, cl, -sp * sl, cp * sl, 0, cp, sp];            // equatorial -> ENU, column-major
    const H = headingDeg * D, E = [Math.cos(H), 0, Math.sin(H)], N = [-Math.sin(H), 0, Math.cos(H)], U = [0, 1, 0];
    const out = new Float32Array(9);
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) out[c * 3 + r] = eq[c * 3] * E[r] + eq[c * 3 + 1] * N[r] + eq[c * 3 + 2] * U[r];
    return out;
  }
  /* WCAG-safe strike envelope (robust.md 4.2), restrikes in B only: WX.lightning in core/director.js.
     [critic] the forced strike may be placed, so a test can put it behind the cove's land or in front of it */
  function strike(W, forced) {
    LT.hfov = R.cam.hfov;
    const o = forced ? { az: S.strikeAz === null ? undefined : S.strikeAz, km: S.strikeKm === null ? undefined : S.strikeKm,
                         P: S.strikeP === null ? undefined : S.strikeP, kind: S.strikeKind === null ? undefined : S.strikeKind } : null;
    LT.strike(scene, W, o);
  }
  function frameState(dt) {
    const cuts = WX.cuts({ warningFloorPercent: 70, exhaustedPercent: 100,
                           criticalPercent: { max20: 99.75, max5: 99, pro: 95 }[S.plan] || 99.75 });
    F.W = WX.weatherAt(S.v, cuts, { wet: S.wet, bolt: S.bolt, mist: S.held, soak: S.soak, puddle: S.puddle });
    const still = S.still || !!(warm && !warm.settle);            // [1.2] the warm-up: converged stills, then held moving frames
    F.dt = dt; F.still = still; F.tier = LAB.tier;
    F.world = still || frameNo % R.knobs.worldEvery === 0;
    F.t.ocean = wrap(scene, WX.PERIOD.ocean); F.t.rain = wrap(scene, WX.PERIOD.rain);
    F.t.twinkle = wrap(scene, WX.PERIOD.twinkle); F.t.slow = wrap(scene, WX.PERIOD.slow);
    const wn = (F.wind = WX.windAt(F.W, F.t, F.wind));          // [1.2] loops on the wrapped clocks
    const adv = (key, k) => { const d = F.drift[key]; d[0] = wrap(d[0] + wn.aloft.dir[0] * wn.aloft.speed * k * dt / 1000, 420); d[1] = wrap(d[1] + wn.aloft.dir[1] * wn.aloft.speed * k * dt / 1000, 420); };
    adv("weather", WX.DRIFT_K.weather); adv("shape", WX.DRIFT_K.shape); adv("cirrus", WX.DRIFT_K.cirrus); adv("curl", WX.DRIFT_K.curl);
    F.drift.sea[0] = wrap(F.drift.sea[0] + wn.wind.dir[0] * 0.03 * wn.wind.U10 * dt, 840);
    F.drift.sea[1] = wrap(F.drift.sea[1] + wn.wind.dir[1] * 0.03 * wn.wind.U10 * dt, 840);
    const lt = WX.params["lab.tod"].v >= 0 ? TOD[Object.keys(TOD)[WX.params["lab.tod"].v | 0]] : null;   // [r5]
    F.sun.dir = lt ? WX.dirOf(lt[0], lt[1]) : WX.dirOf(S.sunEl, S.sunRight);
    F.moon.dir = lt ? WX.dirOf(lt[2], lt[3]) : WX.dirOf(S.moonEl, S.moonRight);
    const cosE = F.sun.dir[0] * F.moon.dir[0] + F.sun.dir[1] * F.moon.dir[1] + F.sun.dir[2] * F.moon.dir[2];
    F.moon.lit = (1 - cosE) / 2;
    const alpha = 180 - Math.acos(Math.max(-1, Math.min(1, cosE))) / D;             // phase angle, deg
    F.moon.E = Math.pow(10, -0.4 * (-12.73 + 0.026 * alpha + 4e-9 * Math.pow(alpha, 4) + 26.74));
    F.moon.phase = alpha;
    /* [E] uMoonInfo.w is a radiance: 2.5e-4 x the full moon's mean radiance x (1 - lit) (core/astro.js) */
    F.moon.earthshine = WX.moonEarthshine ? WX.moonEarthshine(F.moon.lit) : 2.5e-4 * 2.5e-6 * (1 - F.moon.lit);
    F.star = starMatrix(S.lat, S.lst + scene * 360.98564736629 / 86400, WX.heading(S.lat));
    /* lightning ([1.2] the director's scheduler; nothing random before a forced strike has fired) */
    WX.FLASH.cap = WX.params["flash.cap"].v; WX.FLASH.peak = WX.params["flash.peak"].v;
    if (S.strike !== null && scene >= S.strike && !LAB.struck) { strike(F.W, true); LAB.struck = true; }
    const pending = S.strike !== null && !LAB.struck || !!warm;
    LT.hfov = R.cam.hfov;
    F.lockExposure = LT.step(scene, dt, F.W, still || pending ? 0 : F.W.flashRate, F.flashes, R.exposure.E, still);
    return F;
  }

  function loop(ts) {
    requestAnimationFrame(loop);
    if (!R) return;
    const dt = last ? Math.min((ts - last) / 1000, 0.1) : 1 / 60;
    if (last && LAB.ready && !warm) { paceMs[paceN % paceMs.length] = ts - last; paceN++; }   // [r3] the frames' cadence
    last = ts;
    try {
      if (!R.ready) {
        R.frame(frameState(0));
        if (R.ready) { if (S.warm) warm = { n: 0, at: R.meter.at, frames: 0, t0: performance.now(), settle: false, E: 0, calm: 0 }; else { LAB.ready = true; LAB.readyMs = performance.now(); schedLose(); } }
        return;
      }
      /* [1.2] the warm-up: converged stills at t0 until post has metered three times (or 12 frames), then
         (warm=1) moving frames at t0 until the exposure has settled; with warm=cove, until the cove is in too */
      if (warm) {
        R.frame(frameState(0));
        warm.frames++;
        const metered = R.meter.at !== warm.at;
        if (metered) { warm.at = R.meter.at; warm.n++; }
        const wall = performance.now() - warm.t0, c = R.coast;
        const coveIn = !S.warmCove || (c.up >= 1 && c.loading && c.loading.got + c.loading.failed >= c.loading.of) || wall > 30000;
        if (!warm.settle && ((warm.n >= 3 || warm.frames >= 12) && !(R.exposure.stable < 2) || warm.frames >= 45)) {   // [1.3.1] as api.js
          if (!S.warmSettle) warm.done = true; else { warm.settle = true; warm.E = R.exposure.E; warm.calm = 0; warm.ts = performance.now(); }
        } else if (warm.settle && metered) {
          const E = R.exposure.E, ch = Math.abs(E / warm.E - 1);
          warm.calm = ch < 0.015 ? warm.calm + 1 : 0; warm.E = E;
          if (warm.calm >= 3 || performance.now() - warm.ts > 8000) warm.done = true;
        } else if (warm.settle && performance.now() - warm.ts > 8000) warm.done = true;
        if (warm.done && coveIn) {
          LAB.warmFrames = warm.frames; LAB.warmMs = Math.round(wall); warm = null;
          LAB.ready = true; LAB.readyMs = performance.now(); schedLose();
        }
        return;
      }
      /* [E] qto=N@s: change the tier to N at s seconds after ready, as the governor does: [r4] at the start of a
         frame, which is then a world frame (api.js takeSize: never between a draw and its presentation) */
      if (qto && !qto.done && performance.now() - LAB.readyMs >= qto.at * 1000) {
        qto.done = true; LAB.tier = qto.tier; R.resize(innerWidth, innerHeight, devicePixelRatio || 1, LAB.tier); frameNo = 0;
      }
      /* [r4] LAB.qnext = N (a tool, e.g. clip.cjs --tierAt): the same, at the next frame */
      if (LAB.qnext >= 0) { LAB.tier = LAB.qnext; LAB.qnext = -1; R.resize(innerWidth, innerHeight, devicePixelRatio || 1, LAB.tier); frameNo = 0; }
      const frozen = S.still || (S.freeze !== null && scene >= S.freeze);
      if (!frozen) scene = S.freeze !== null ? Math.min(scene + dt, S.freeze) : scene + dt;
      R.frame(frameState(frozen ? 0 : dt));
      frameNo++; LAB.frames++;
      if (LAB.frames % 10 === 0 && (LAB.expoLog = LAB.expoLog || []).length < 200)             // [1.2] the exposure over time
        LAB.expoLog.push([LAB.frames, +R.exposure.E.toPrecision(4), +(R.coast.up || 0).toFixed(2), F.lockExposure ? 1 : 0]);
      if (S.frames && LAB.frames >= S.frames) LAB.done = true;
      if (LAB.frames % 30 === 0) paintStatus();
    } catch (e) { fail(e); R = null; }
  }
  const qm = /^(\d)@([\d.]+)$/.exec(Q.get("qto") || ""), qto = qm ? { tier: +qm[1], at: +qm[2], done: false } : null;
  requestAnimationFrame(loop);
  function schedLose() {
    if (!Q.has("lose") || LAB.lostOnce) return;
    LAB.lostOnce = true;
    const ext = gl.getExtension("WEBGL_lose_context");
    setTimeout(() => { ext.loseContext(); setTimeout(() => ext.restoreContext(), 1000); }, num("lose", 1000));
  }
  LAB.summary = () => ({ renderer: LAB.renderer, ready: LAB.ready, frames: LAB.frames, errors: LAB.errors, losses: LAB.losses,
                         tier: LAB.tier, S: R && R.size.S, cloud: R && R.size.cloud, buildMs: R && Math.round(R.stats.buildMs),
                         gpu: R && R.timesSummary ? R.timesSummary() : null, stripped: window.WXLAB_STRIPPED || 0, uploads: R && R.stats.uploads,
                         warmFrames: LAB.warmFrames || 0, warmMs: LAB.warmMs || 0, taa: R && { on: R.taa.on, age: R.taa.age }, exposure: R && R.exposure, meter: R && R.meter.grid && Array.from(R.meter.grid).map((x) => +x.toFixed(3)),
                         W: F.W, views: R ? Object.keys(R.debug) : [], frame: LAB.frameStats(S.frames || 0), pace: LAB.paceStats(), frameSeries: LAB.frameSeries().slice(-(S.frames || 4096)), seed: WX.labSeed,
                         cove: R && R.coast && { up: +(R.coast.up || 0).toFixed(2), got: R.coast.loading && R.coast.loading.got,
                                                 of: R.coast.loading && R.coast.loading.of, failed: R.coast.loading && R.coast.loading.failed } });

  /* ── the panel ── */
  const panel = document.getElementById("panel");
  function paintStatus() {
    const st = document.getElementById("status");
    if (!st) return;
    const g = R && R.ready && R.timesSummary ? R.timesSummary() : null;   // [1.2] none with ?strip=1
    st.textContent = (LAB.errors.length ? "ERROR " + LAB.errors[0].slice(0, 400) + "\n" : "") +
      (R ? R.caps.renderer + "\nT" + LAB.tier + " S " + R.size.S.join("x") + " cloud " + R.size.cloud.join("x") +
      (g ? "\nGPU p50 " + g.total_p50 + " ms\n" + Object.entries(g).filter(([k]) => k !== "total_p50").map(([k, v]) => k + " " + v.p50).join("\n") : "\nbuilding…") : "");
  }
  if (!S.ui) { panel.remove(); return; }
  const go = (patch) => { for (const k in patch) Q.set(k, patch[k]); location.search = Q.toString(); };
  const row = (label, key, lo, hi, step, val) => {
    const r = document.createElement("label");
    r.innerHTML = `<span>${label}</span><input type="range" min="${lo}" max="${hi}" step="${step}" value="${val}"><output>${val}</output>`;
    const inp = r.querySelector("input"), out = r.querySelector("output");
    inp.addEventListener("input", () => {
      out.textContent = inp.value;
      if (key in S) { S[key] = +inp.value; if (key === "q" && R) { LAB.tier = +inp.value; R.resize(innerWidth, innerHeight, devicePixelRatio || 1, LAB.tier); } }
      else if (WX.params[key]) WX.params[key].v = +inp.value;
    });
    panel.appendChild(r);
  };
  row("reading %", "v", 0, 100, 0.5, S.v);
  row("held (mist)", "held", 0, 1, 0.05, S.held);
  row("sun el", "sunEl", -30, 70, 0.5, S.sunEl);
  row("sun right", "sunRight", -180, 180, 1, S.sunRight);
  row("moon el", "moonEl", -30, 70, 0.5, S.moonEl);
  row("moon right", "moonRight", -180, 180, 1, S.moonRight);
  S.q = LAB.tier; row("tier", "q", 0, 4, 1, LAB.tier);
  for (const [k, p] of Object.entries(WX.params)) row(k, k, p.lo, p.hi, p.step, p.v);
  const sel = document.createElement("select");
  sel.innerHTML = `<option value="">(picture)</option>` + Object.keys(R.debug).map((k) => `<option>${k}</option>`).join("");
  sel.value = Q.get("view") || "";
  sel.addEventListener("focus", () => { sel.innerHTML = `<option value="">(picture)</option>` + Object.keys(R.debug).map((k) => `<option>${k}</option>`).join(""); });
  sel.addEventListener("change", () => { R.view = sel.value ? { name: sel.value, scale: num("vscale", 1), lod: 0 } : null; });
  panel.appendChild(sel);
  const b = document.createElement("button"); b.textContent = "strike";
  b.addEventListener("click", () => strike(F.W)); panel.appendChild(b);
  const tods = document.createElement("div");
  tods.innerHTML = Object.keys(TOD).map((k) => `<button data-t="${k}">${k}</button>`).join("");
  tods.addEventListener("click", (e) => { if (e.target.dataset.t) go({ tod: e.target.dataset.t, sunEl: "", sunRight: "", moonEl: "", moonRight: "" }); });
  panel.appendChild(tods);
  const st = document.createElement("pre"); st.id = "status"; panel.appendChild(st);
})();
