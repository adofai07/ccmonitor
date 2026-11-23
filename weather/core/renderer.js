/* ═══════════════════════ Weather lab: the renderer core (frame graph) ═══════════════════════
   Owner after the skeleton: the director/core stream (E). Additive changes only.

   R = WX.renderer(canvas, gl, {timing})   one per GL context; made again after a context restore
     R.resize(cssW, cssH, dpr, tier)        sizes S, C and the cloud buffer from the tier; (re)allocates SCENE,
                                            its depth, REFL, RAIN, HDR, then every pass's resize()
     R.step()                               advance the staged build; true once every pass is built
     R.frame(F)                             one frame from the frame state F (contract.js); false while building
     R.ready, R.size, R.knobs, R.tier, R.cam, R.stats, R.exposure, R.meter, R.priv
   A pass (WX.pass) may define:
     *build(R)            generator: programs and fixed resources; `yield` to spread work over frames.
                          It runs again on a new context after a loss: it starts from nothing and
                          forgets every GL object it held (deleting them would be an error)
     resize(R)            size-dependent resources
     slots: { name(R, F) } GPU work, for the slots of WX.SLOTS it implements
     ubo(F, R, set)       fill its stream's reserved vec4s: set("uB0", x, y, z, w)
   Helpers on R for passes:
     R.program(name, {fs, vs, libs})  fs/vs are bodies; the common prelude and the listed libs are prepended.
                                      vs defaults to the fullscreen triangle (out vec2 vUV)
     R.wait(...programs)              `yield* R.wait(P)` inside build()
     R.draw(P, target, uniforms, o)   fullscreen draw; target: an fbo object, a shared target name or null
     R.target(name)                   "scene" (SCENE + depth), "refl", "rain", "hdr", "screen",
                                      [v1.1] "coast" (SCENE + SCENEZ + the same depth: the coast slot's MRT target)
     R.coast                          [v1.1] WX.coastDefaults(): the cove's shared state (contract.js section 8)
     R.provide(name, texObj)          a writer registers a contract texture (WX.TEX name)
     R.debugTex(name, texObj, mode)   lab: offers a texture in the lab's view picker (mode hdr|raw|r|a|depth)
     R.p(name)                        a lab tuning knob's value (WX.param); its default after the merge
   [E, additive] for the API and the governor:
     R.onGpu = (ms, backlogged, flash) => {} one call per drawn frame, a few frames late: the frame's GPU ms (null
                                      when unknown), or without the timer extension whether the frame was
                                      backlogged (its fence not signalled by the next frame). With opts.timing
                                      (the lab) it is the sum of the frame's slot timers; else one query a frame
     R.provideLib(sampler, texObj)    [E] a GLSL library's own texture (WX.LIBTEX: name -> fixed unit), bound
                                      by the core before every slot like a contract texture (the night
                                      library's Milky Way)
     R.burn = { passes, iters }       LAB ONLY: extra GPU work at the end of each frame, a forced slow GPU
                                      for the governor's test; 0 passes (the default) draws nothing
   [1.2, contract section 9] R.stats.uploads (counted at the GL calls by gl.js), R.meter.peak, R.exposure.floor,
   R.taa (the TAA jitter and the resolved history, WX.TAA), R.sceneTex() (what sScene reads now), pass.noTargets
   (HDR and RAIN optional). Before every
   pass's slot the core resets DEPTH_TEST, BLEND, CULL_FACE (off), depthMask (on) and frontFace (CCW).
   Lab-only code is between the contract's markers (WX.LAB_MARKERS).
*/
WX.renderer = function (canvas, gl, opts = {}) {
  const G = WX.gpu(gl);
  const R = {
    gl, gpu: G, canvas, caps: { renderer: G.renderer, timer: !!G.ext.timer, parallel: !!G.ext.par, aniso: !!G.ext.aniso, floatLinear: !!G.ext.flin },
    size: null, knobs: WX.TIERS[2], tier: 2, cam: null, ready: false, frameIndex: 0, worldIndex: 0,
    tex: {}, priv: {}, debug: {}, view: null,
    exposure: { E: 2, prev: 2, EV: 14, floor: -4.5 }, meter: { grid: null, peak: null, avg: null, at: 0 },
    stats: { slots: {}, frames: 0, built: 0, buildMs: 0 },
    /* [1.2] TAA (WX.TAA): on while a pass implements the "taa" slot; out is that pass's resolved picture */
    taa: { on: false, phase: 0, jitter: [0, 0], prev: [0, 0], age: 0, out: null },
    coast: WX.coastDefaults(),          // [v1.1] filled by the coast pass, packed by the core, read by the ocean
    timing: opts.timing !== false,
  };
  if (!G.ext.cbf) throw new Error("EXT_color_buffer_float missing");
  /* [1.2] the uploads that can stall a frame, counted by gl.js at the GL calls (contract section 9) */
  Object.defineProperty(R.stats, "uploads", { enumerable: true, get: () => G.counts.uploads });

  /* ── contract textures: dummies until provided ── */
  const dummy = G.tex2D(1, 1, "rgba16f", { filter: "nearest" });
  /* [v1.1] a shadow sampler needs a depth texture in compare mode: 1x1 at depth 1.0, so all is lit */
  const dummyShadow = G.tex2D(1, 1, "depth16", { compare: true });
  {
    const fb = G.fbo([], dummyShadow);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb.fb); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb.fb);
  }
  R.provide = (name, t) => { if (!WX.TEX[name]) throw new Error("not a contract texture: " + name); R.tex[name] = t; };
  /* [E] a library's own textures, at fixed units above the private range a pass uses (WX.LIBTEX) */
  R.libTex = {};
  R.provideLib = (s, t) => { if (!WX.LIBTEX[s]) throw new Error("not a library texture: " + s); R.libTex[s] = t; };
  let sceneOut = null;                  // [1.2] the resolved TAA history, bound as sScene after the taa slot
  /* [1.2] the texture sScene reads now: the resolved history after the taa slot (TAA on), else SCENE. A pass
     that hands SCENE to G.uniforms itself (post's first bloom level) uses this instead of R.tex.SCENE */
  R.sceneTex = () => sceneOut || R.tex.SCENE;
  function bindContract() {
    for (const k in WX.TEX) {
      gl.activeTexture(gl.TEXTURE0 + WX.TEX[k].unit);
      const t = k === "SCENE" && sceneOut ? sceneOut : R.tex[k];
      gl.bindTexture(gl.TEXTURE_2D, (t || (WX.TEX[k].type === "sampler2DShadow" ? dummyShadow : dummy)).tex);
    }
    for (const s in WX.LIBTEX) {
      gl.activeTexture(gl.TEXTURE0 + WX.LIBTEX[s].unit);
      gl.bindTexture(gl.TEXTURE_2D, (R.libTex[s] || dummy).tex);
    }
  }

  /* ── programs ── */
  R.src = (libs, body) => WX.glsl.common + (libs || []).map((n) => {
    if (WX.libs[n] === undefined) throw new Error("no GLSL library " + n);
    return "\n// ---- lib " + n + "\n" + WX.libs[n];
  }).join("\n") + "\n// ---- body\n" + body;
  R.program = (name, o) => G.program(R.src(o.libs, o.vs || WX.glsl.fullscreenVS), R.src(o.libs, o.fs), name);
  R.wait = function* (...ps) { while (!ps.every((p) => p.ready())) yield; };
  R.p = (name) => (WX.params[name] ? WX.params[name].v : 0);
  /* a no-op after the merge, so a pass's unmarked call still runs */
  R.debugTex = (name, t, mode) => { /*@lab*/ R.debug[name] = { t, mode: mode || "hdr" }; /*@end*/ };

  /* ── shared targets ── */
  const T = {};
  /* [1.2] HDR and RAIN are optional (contract section 4, pass.noTargets) */
  const OPTIONAL = { hdr: "HDR", rain: "RAIN" };
  const skipped = (name) => WX.mods.some((m) => m.noTargets && m.noTargets.indexOf(name) >= 0);
  R.target = (name) => {
    if (name === "screen" || name === null) return null;
    if (!T[name] && OPTIONAL[name]) throw new Error("target " + name + " is not allocated (a pass lists " + OPTIONAL[name] + " in noTargets)");
    return T[name];
  };
  function bindTarget(t) {
    if (!t) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height); return; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, t.w, t.h);
  }
  R.bind = (target) => bindTarget(typeof target === "string" ? R.target(target) : target);
  R.draw = (P, target, uni, o = {}) => {
    R.bind(target);
    if (o.viewport) gl.viewport(...o.viewport);
    const u = P.use();
    if (uni) G.uniforms(P, uni);
    G.fullscreen();
    return u;
  };
  const del = (t) => { if (t && t.tex) gl.deleteTexture(t.tex); };
  /*@lab*/
  /* [r6] core.jitter=s (lab): the TAA jitter times s (0: the resolve and its history stay, the jitter goes) */
  WX.param("core.jitter", 1, 0, 1, 0.05, "core");
  /* [r4] core.zcarry=0 (lab): a resize starts SCENEZ empty, as before round 4 (to compare) */
  WX.param("core.zcarry", 1, 0, 1, 1, "core");
  /*@end*/
  function allocShared() {
    const [w, h] = R.size.S;
    /* [r4] SCENEZ is the one shared target read across frames: the shadow to sky slots read the previous world
       frame's (the clouds trace land pixels as sea rays ending there). A resize used to start it at 0, so the first
       frames at a new size traced the cove as sky: the frame after every tier change was 4-19 % darker and came back
       over the clouds' refresh (16 world frames). The old one is carried into the new size (nearest) instead. */
    const oldZ = R.tex.SCENEZ;
    let carry = !!oldZ;
    /*@lab*/ carry = carry && R.p("core.zcarry") > 0; /*@end*/
    for (const k of ["SCENE", "REFL", "RAIN", "HDR"]) { del(R.tex[k]); delete R.tex[k]; }
    delete R.tex.SCENEZ;
    if (T.depth) gl.deleteRenderbuffer(T.depth);
    for (const k in T) { if (T[k] && T[k].fb) gl.deleteFramebuffer(T[k].fb); delete T[k]; }
    R.tex.SCENE = G.tex2D(w, h, "rgba16f");
    R.tex.REFL = G.tex2D(Math.max(1, w >> 1), Math.max(1, h >> 1), "rgba16f", { mips: true });
    if (!skipped("RAIN")) R.tex.RAIN = G.tex2D(w, h, "rgba16f");
    if (!skipped("HDR")) R.tex.HDR = G.tex2D(w, h, "rgba16f");
    R.tex.SCENEZ = G.tex2D(w, h, "r32f", { filter: "nearest" });     // [v1.1]
    if (carry) {
      const a = G.fbo([oldZ]), b = G.fbo([R.tex.SCENEZ]);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, a.fb); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, b.fb);
      gl.blitFramebuffer(0, 0, oldZ.w, oldZ.h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.deleteFramebuffer(a.fb); gl.deleteFramebuffer(b.fb);
    }
    if (oldZ) del(oldZ);
    T.depth = G.depthRB(w, h);
    T.scene = G.fbo([R.tex.SCENE], T.depth);
    T.coast = G.fbo([R.tex.SCENE, R.tex.SCENEZ], T.depth);           // [v1.1] the coast slot's MRT target
    T.refl = G.fbo([R.tex.REFL]);
    if (R.tex.RAIN) T.rain = G.fbo([R.tex.RAIN]);
    if (R.tex.HDR) T.hdr = G.fbo([R.tex.HDR]);
    /*@lab*/
    R.debugTex("SCENE", R.tex.SCENE, "hdr");
    R.debugTex("REFL", R.tex.REFL, "hdr");
    if (R.tex.RAIN) R.debugTex("RAIN", R.tex.RAIN, "hdr");
    if (R.tex.HDR) R.debugTex("HDR", R.tex.HDR, "hdr");
    R.debugTex("SCENEZ", R.tex.SCENEZ, "r");
    /*@end*/
  }

  /* ── sizes and the camera ── */
  R.resize = (cssW, cssH, dpr, tier) => {
    R.tier = Math.max(0, Math.min(WX.TIERS.length - 1, tier | 0));
    R.knobs = WX.TIERS[R.tier];
    const dw = Math.max(1, Math.round(cssW * dpr)), dh = Math.max(1, Math.round(cssH * dpr));
    const s = Math.min(1, Math.sqrt(R.knobs.px / (dw * dh)));
    const S = [Math.max(64, Math.round(dw * s)), Math.max(36, Math.round(dh * s))];
    const cpx = Math.min((S[0] * S[1]) / (R.knobs.cloudDiv * R.knobs.cloudDiv), R.knobs.cloudMaxPx);
    const cs = Math.sqrt(cpx / (S[0] * S[1]));
    const cloud = [Math.max(32, Math.round(S[0] * cs)), Math.max(18, Math.round(S[1] * cs))];
    R.size = { S, C: [cssW, cssH], dpr, scale: S[0] / dw, cloud, device: [dw, dh] };
    canvas.width = S[0]; canvas.height = S[1];
    R.cam = WX.frameCamera(cssW, cssH);
    R.viewProj = viewProj(R.cam, S[0] / S[1]);
    R.taa.age = 0; R.taa.out = null; sceneOut = null; prevOut = null;   // [1.2] the history goes with the old size
    pending = false;                     // [r5] a split world frame's early half went with the old SCENE
    allocShared();
    if (R.ready) for (const m of WX.mods) if (m.resize) m.resize(R);
  };
  function viewProj(c, aspect) {
    const e = [0, c.eye, 0], r = c.right, u = c.up, f = c.fwd, n = c.near, fa = c.far;
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const V = [r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0, -dot(r, e), -dot(u, e), dot(f, e), 1];
    const fx = 1 / c.tanX, fy = 1 / c.tanY;
    const P = [fx, 0, 0, 0, 0, fy, 0, 0, 0, 0, (fa + n) / (n - fa), -1, 0, 0, (2 * fa * n) / (n - fa), 0];
    const M = new Float32Array(16);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += P[k * 4 + j] * V[i * 4 + k];
      M[i * 4 + j] = s;
    }
    return M;
  }

  /* ── the staged build ── */
  let builds = null, taaPass = false;
  R.step = () => {
    if (R.ready) return true;
    G.pump();
    const t0 = performance.now();
    if (!builds) {
      builds = WX.mods.filter((m) => m.build).map((m) => ({ m, gen: m.build(R), done: false }));
      R.stats.buildStart = t0;
    }
    for (const b of builds) if (!b.done) b.done = !!b.gen.next().done;
    if (builds.every((b) => b.done)) {
      taaPass = WX.mods.some((m) => m.slots && m.slots.taa);      // [1.2] the jitter is on only with a resolve
      for (const m of WX.mods) if (m.resize) m.resize(R);
      R.ready = true;
      R.stats.buildMs = performance.now() - R.stats.buildStart;
    }
    return R.ready;
  };

  /* ── UBO ── */
  const ubo = gl.createBuffer();
  const U = new Float32Array(WX.UBO_FLOATS);
  gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
  gl.bufferData(gl.UNIFORM_BUFFER, U.byteLength, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.UNIFORM_BUFFER, null);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo);   // bound from the start: build-time draws use the block too
  const set = (name, x, y, z, w) => {
    const o = WX.UBO_OFFSET[name];
    if (o === undefined) throw new Error("not a UBO field: " + name);
    U[o] = x || 0; U[o + 1] = y || 0; U[o + 2] = z || 0; U[o + 3] = w || 0;
  };
  const D = Math.PI / 180;
  /* [1.2] TAA: this world frame's jitter (contract section 1), into uViewProj and uTaa */
  /* the lab knob taa (contract WX.TAA): 1 the jitter follows the taa slot (the product), 0 never */
  const VPJ = new Float32Array(16);
  let jx = 0, jy = 0;
  let late = false;     // [r5] this frame draws the late half of a split world frame (worldSplit): world frame n's jitter
  let pending = false;  // [r5] world frame n's late half is still to be drawn (the next frame draws it)
  function taaFrame(F) {
    const T = R.taa, wasOn = T.on;
    T.on = taaPass && R.p("taa") !== 0;
    if (late) { jx = T.jitter[0]; jy = T.jitter[1]; }   // [r5] SCENE's early half was drawn with it
    else if (!F.world) { jx = 0; jy = 0; return; }   // the composite only: SCENE is the last world frame's
    else {
      T.prev[0] = T.jitter[0]; T.prev[1] = T.jitter[1];
      if (!T.on || F.still || F.snapshot || !wasOn) {  // no history to blend with: a still converges as is
        T.jitter[0] = 0; T.jitter[1] = 0; T.age = 0;
        if (!T.on) { T.prev[0] = 0; T.prev[1] = 0; }
      } else {
        T.phase = R.worldIndex % WX.TAA.phases;
        WX.taaJitter(T.phase, T.jitter);
        /*@lab*/ const js = R.p("core.jitter"); T.jitter[0] *= js; T.jitter[1] *= js; /*@end*/   // [r6] lab: the jitter's scale
      }
      jx = T.jitter[0]; jy = T.jitter[1];
    }
    /* the jitter moves the picture by +j px: clip.xy += 2 j / S x clip.w, i.e. rows 0 and 1 gain row 3 */
    const M = R.viewProj, ax = (2 * jx) / R.size.S[0], ay = (2 * jy) / R.size.S[1];
    for (let i = 0; i < 4; i++) {
      VPJ[i * 4] = M[i * 4] + ax * M[i * 4 + 3]; VPJ[i * 4 + 1] = M[i * 4 + 1] + ay * M[i * 4 + 3];
      VPJ[i * 4 + 2] = M[i * 4 + 2]; VPJ[i * 4 + 3] = M[i * 4 + 3];
    }
  }
  function pack(F) {
    const c = R.cam, S = R.size.S, n = R.frameIndex;
    taaFrame(F);
    U.set(jx || jy ? VPJ : R.viewProj, WX.UBO_OFFSET.uViewProj);
    set("uCamX", c.right[0], c.right[1], c.right[2], c.tanX);
    set("uCamY", c.up[0], c.up[1], c.up[2], c.tanY);
    set("uCamZ", c.fwd[0], c.fwd[1], c.fwd[2], c.eye);
    set("uRes", S[0], S[1], 1 / S[0], 1 / S[1]);
    set("uCss", R.size.C[0], R.size.C[1], R.size.dpr, R.size.scale);
    set("uCloudRes", R.size.cloud[0], R.size.cloud[1], 1 / R.size.cloud[0], 1 / R.size.cloud[1]);
    const sd = F.sun.dir, md = F.moon.dir;
    const sunEl = Math.asin(Math.max(-1, Math.min(1, sd[1]))), moonEl = Math.asin(Math.max(-1, Math.min(1, md[1])));
    set("uSun", sd[0], sd[1], sd[2], WX.SUN_RADIUS);
    set("uSunInfo", sunEl, F.sun.E, sd[1], sunEl > -1 * D ? 1 : 0);
    set("uMoon", md[0], md[1], md[2], F.moon.radius);
    set("uMoonInfo", moonEl, F.moon.E, F.moon.lit, F.moon.earthshine);
    if (sunEl > -6 * D) set("uKey", sd[0], sd[1], sd[2], F.sun.E); else set("uKey", md[0], md[1], md[2], F.moon.E);
    const st = F.star;
    set("uStar0", st[0], st[1], st[2], 0); set("uStar1", st[3], st[4], st[5], 0); set("uStar2", st[6], st[7], st[8], 0);
    const W = F.W, wn = F.wind || WX.windAt(W, F.t);
    set("uWx0", W.cov, W.type, W.base, W.top);
    set("uWx1", W.cirrus, W.precip, W.rain, W.vis);
    set("uWx2", wn.wind.U10, W.swellHs, W.fogH, W.storm);
    const night = 1 - WX.util.smooth(-10 * D, -2 * D, sunEl);
    set("uWx3", W.mist, W.bolt, W.wet, night);
    set("uWind", wn.wind.dir[0], wn.wind.dir[1], wn.wind.U10, wn.wind.gust);
    set("uAloft", wn.aloft.dir[0], wn.aloft.dir[1], wn.aloft.speed, 0);
    set("uSwell", wn.swell.dir[0], wn.swell.dir[1], wn.swell.T, wn.swell.Hs);
    const d = F.drift;
    set("uDrift0", d.weather[0], d.weather[1], d.shape[0], d.shape[1]);
    set("uDrift1", d.cirrus[0], d.cirrus[1], d.curl[0], d.curl[1]);
    set("uDrift2", d.sea[0], d.sea[1], 0, 0);
    set("uTime", F.t.ocean, F.t.rain, F.t.twinkle, F.t.slow);
    const upd = R.knobs.cloudUpdate;
    set("uFrame", n % 65536, F.still ? 0 : R.worldIndex % upd, F.world || late ? 1 : 0, F.dt);
    set("uJitter", (0.5 + n * 0.7548776662) % 1, (0.5 + n * 0.5698402910) % 1, (n * 0.6180339887) % 1, n & 1);
    const ex = R.exposure;
    set("uExpo", ex.E, ex.E / (ex.prev || ex.E), ex.EV, ex.scotopic || 0);
    const fl = F.flashes;
    set("uFlash0", fl[0].pos[0], fl[0].pos[1], fl[0].pos[2], fl[0].I);
    set("uFlash0b", fl[0].kind, fl[0].seed, fl[0].B, fl[0].age);
    set("uFlash1", fl[1].pos[0], fl[1].pos[1], fl[1].pos[2], fl[1].I);
    set("uFlash1b", fl[1].kind, fl[1].seed, fl[1].B, fl[1].age);
    set("uTier", R.tier, F.still ? 1 : 0, F.still || R.fullCloud ? 1 : 0, F.dissolve);
    set("uWx4", W.soak === undefined ? WX.soakTarget(W.precip) : W.soak,                 // [v1.1]
        W.puddle === undefined ? WX.puddleTarget(W.precip) : W.puddle, 0, 0);
    const T = R.taa;                                                                  // [1.2]
    set("uTaa", jx, jy, F.world || late ? T.prev[0] : T.jitter[0], F.world || late ? T.prev[1] : T.jitter[1]);
    set("uTaa1", T.on ? 1 : 0, T.phase, T.age, 0);
    for (const m of WX.mods) if (m.ubo) m.ubo(F, R, set);
    /* [v1.1] the cove's shared fields, from R.coast as the coast pass's ubo() hook left it */
    const C = R.coast, sh = C.ship;
    U.set(C.shadowVP, WX.UBO_OFFSET.uShadowVP);
    set("uShadow", C.shadow[0], C.shadow[1], C.shadow[2], C.shadow[3]);
    set("uCoast", C.up, C.lights, 0, 0);
    set("uShip", sh.pos[0], sh.pos[1], sh.pos[2], sh.yaw);
    set("uShipB", sh.halfL, sh.halfB, sh.draft, sh.on);
    gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, U);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo);
  }
  R.uboData = U;
  /* [1.2] after the taa slot: the rest of the frame reads the resolved, unjittered picture */
  function unjitter() {
    U.set(R.viewProj, WX.UBO_OFFSET.uViewProj);
    const o = WX.UBO_OFFSET.uTaa;
    U[o] = 0; U[o + 1] = 0;
    gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, U, 0, 16);
    gl.bufferSubData(gl.UNIFORM_BUFFER, o * 4, U, o, 4);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo);
  }

  /* ── GPU timers: one query per slot (lab, opts.timing) or one per frame (the product's governor) ──
     [E] each frame's queries share a record; when the last resolves, R.onGpu gets the frame's sum. A
     disjoint frame reports null. Without the extension a fence per frame reports backlog instead. */
  const TQ = G.ext.timer, live = [];
  let current = null, rec = null, fence = null, fenceAt = 0;
  R.onGpu = null;
  const pool = [];
  /* the per-slot queries are the lab's (opts.timing); the product keeps the one frame query below */
  function tBegin(name) {
    /*@lab*/
    if (!TQ || current || !R.timing) return;
    const q = pool.pop() || gl.createQuery();
    gl.beginQuery(TQ.TIME_ELAPSED_EXT, q);
    current = { name, q, rec };
    if (rec) rec.pending++;
    /*@end*/
  }
  function tEnd(frame) {
    if (!current || !!current.frame !== !!frame) return;   // a slot's end never ends the frame's query
    gl.endQuery(TQ.TIME_ELAPSED_EXT);
    live.push(current);
    current = null;
  }
  /*@lab*/
  /* [r3] core.tflush=0 (lab) skips the flush at the frame's end, to compare (see R.frame) */
  WX.param("core.tflush", 1, 0, 1, 1, "core");
  /*@end*/
  function frameBegin() {
    rec = { pending: 0, ms: 0, bad: false, closed: false, flash: false };
    /*@lab*/ rec.fi = R.frameIndex; rec.t = performance.timeOrigin + performance.now(); /*@end*/   // [r5] for spikesrc --corr
    if (!TQ) {
      /* [r7] backlogged: the frame was not done within Auto's period (12 ms, under 75 Hz's 13.3). At the Frame rate
         setting's 120 fps or every refresh the next frame comes sooner than that: an unfinished fence is kept and
         judged by a later frame, and no new one is set while it waits */
      if (fence) {
        const st = gl.getSyncParameter(fence, gl.SYNC_STATUS);
        if (st !== gl.SIGNALED && performance.now() - fenceAt < 12) return;
        gl.deleteSync(fence); fence = null;
        if (R.onGpu) R.onGpu(null, st !== gl.SIGNALED);
      }
      return;
    }
    if (!R.timing && !current && live.length < 8) {
      const q = pool.pop() || gl.createQuery();
      gl.beginQuery(TQ.TIME_ELAPSED_EXT, q);
      current = { name: "frame", q, rec, frame: true };
      rec.pending++;
    }
  }
  function frameEnd() {
    if (current && current.frame) tEnd(true);
    if (!TQ && !fence) { fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); fenceAt = performance.now(); }
    if (rec) { rec.closed = true; done(rec); }
    rec = null;
  }
  function done(r) {
    if (!r.closed || r.pending > 0 || r.reported) return;
    r.reported = true;
    /*@lab*/ if (R.stats.flog) { const L = R.stats.flog; L.push([r.fi, r.t, r.bad ? -1 : +r.ms.toFixed(3)]); if (L.length > 8192) L.splice(0, 1024); } /*@end*/
    if (R.onGpu && (r.ms > 0 || r.bad)) R.onGpu(r.bad ? null : r.ms, false, r.flash);
  }
  function tPoll() {
    if (!TQ || !live.length) return;
    const disjoint = gl.getParameter(TQ.GPU_DISJOINT_EXT);
    for (let k = live.length - 1; k >= 0; k--) {
      const { name, q, rec: r } = live[k];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue;
      if (!disjoint) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        /*@lab*/
        if (name !== "frame") {
          const a = (R.stats.slots[name] = R.stats.slots[name] || []);
          a.push(ms);
          if (a.length > 240) a.shift();
        }
        R.stats.gpuTotal = (R.stats.gpuTotal || 0) + ms;   // [r5] every query's ms since the start (spikesrc.cjs)
        /*@end*/
        if (r) r.ms += ms;
      } else if (r) r.bad = true;
      pool.push(q);
      live.splice(k, 1);
      if (r) { r.pending--; done(r); }
    }
  }
  /*@lab*/
  /* LAB ONLY: a forced slow GPU (DESIGN 6.2's governor test): heavy fragment work into a small target */
  R.burn = { passes: 0, iters: 1024 };
  let burnP = null, burnT = null;
  function burn() {
    if (!(R.burn.passes > 0)) return;
    if (!burnP) {
      burnP = R.program("core.burn", { fs: `
        uniform int uN; out vec4 o;
        void main() {
          vec2 p = gl_FragCoord.xy * .01 + uJitter.xy; float a = 0.;
          for (int i = 0; i < 16384; i++) { if (i >= uN) break; p = fract(p * 1.6180339 + vec2(a, .37)); a += sin(p.x * 6.2831) * cos(p.y * 6.2831); }
          o = vec4(a * 1e-6, 0., 0., 1.);
        }` });
      burnT = G.fbo([G.tex2D(512, 512, "rgba8")]);
    }
    if (!burnP.ready()) return;
    for (let k = 0; k < R.burn.passes; k++) R.draw(burnP, burnT, { uN: R.burn.iters | 0 });
  }
  /* [r5] LAB ONLY, for the Intel slot spikes (spikesrc.cjs): core.sentinel=1 puts a query round one 1 x 1 draw before
     every world slot ("sent:<slot>"): work another GPU client gets in at the first draw boundary after a long draw
     lands there instead of in the slot. core.slotflush=1 flushes after every slot */
  WX.param("core.sentinel", 0, 0, 1, 1, "core");
  WX.param("core.slotflush", 0, 0, 1, 1, "core");
  let sentP = null, sentT = null;
  function sentinel(slot) {
    if (!sentP) { sentP = R.program("core.sentinel", { fs: "out vec4 o; void main() { o = vec4(0.); }" }); sentT = G.fbo([G.tex2D(1, 1, "rgba8")]); }
    if (!sentP.ready()) return;
    tBegin("sent:" + slot);
    R.draw(sentP, sentT);
    tEnd();
  }
  R.timesSummary = () => {
    const out = {}; let total = 0;
    for (const k in R.stats.slots) {
      const a = R.stats.slots[k].slice().sort((x, y) => x - y);
      if (!a.length) continue;
      out[k] = { p50: +a[a.length >> 1].toFixed(3), p95: +a[Math.floor(a.length * 0.95)].toFixed(3), n: a.length };
      total += a[a.length >> 1];
    }
    out.total_p50 = +total.toFixed(3);
    return out;
  };
  /*@end*/

  /*@lab*/
  /* ── debug view (lab): draw one registered texture instead of the picture ── */
  let dbgP = null, dbgS = null;
  function debugView() {
    const v = R.view && R.debug[R.view.name];
    if (!v) return;
    if (!dbgP) dbgP = R.program("debug", { fs: `
      uniform sampler2D uTex; uniform float uScale; uniform int uMode; uniform float uLod;
      in vec2 vUV; out vec4 o;
      void main() {
        vec4 c = textureLod(uTex, vUV, uLod);
        vec3 r = uMode == 0 ? (1. - exp(-c.rgb * uScale)) : uMode == 1 ? abs(c.rgb) * uScale
               : uMode == 2 ? vec3(c.r * uScale) : uMode == 3 ? vec3(c.a * uScale) : vec3(fract(c.r * uScale));
        o = vec4(pow(clamp(r, 0., 1.), vec3(1. / 2.2)), 1.);
      }` });
    if (!dbgP.ready()) return;
    const mode = { hdr: 0, raw: 1, r: 2, a: 3, depth: 4 }[v.mode] || 0;
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    /* [1.2] a compare-mode depth texture (SUNSHADOW) through a plain sampler2D: a sampler object with the
       compare off, at the unit G.uniforms gives the first texture (stream F's request) */
    const depth = /^depth/.test((v.t && v.t.fmt) || "");
    if (depth) {
      if (!dbgS) { dbgS = gl.createSampler(); gl.samplerParameteri(dbgS, gl.TEXTURE_COMPARE_MODE, gl.NONE);
        gl.samplerParameteri(dbgS, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.samplerParameteri(dbgS, gl.TEXTURE_MAG_FILTER, gl.NEAREST); }
      gl.bindSampler(WX.PRIVATE_UNIT0, dbgS);
    }
    R.draw(dbgP, null, { uTex: v.t, uScale: R.view.scale || 1, uMode: mode, uLod: R.view.lod || 0 });
    if (depth) gl.bindSampler(WX.PRIVATE_UNIT0, null);
  }
  /*@end*/

  /* ── one frame ── */
  const slotsOf = {};
  for (const [name, stage] of WX.SLOTS) slotsOf[name] = stage;
  const ZERO4 = new Float32Array(4);   // [critic] the SCENEZ clear value, made once: no allocation per frame (DESIGN 2.5 rule 4)
  /* [r4] THE IN-BETWEEN FRAME (knobs.worldBlend, T0-T1, where the world is drawn every second frame). Shown as is,
     a 30 Hz world under the 60 Hz glass judders: the sea and the clouds hold for two frames, then jump (REVIEW-3 6,
     clip i: steps 2.40 and 0.09 on alternate frames). Instead the frame that draws world frame n shows the mean of
     n - 1 and n, and the next (composite) frame shows n: the world's motion is spread evenly over the 60 Hz frames,
     half a world frame late (8 ms; nothing here is interactive). Both pictures are the TAA's resolved history
     (post's two textures, n - 1 still intact until world frame n + 1); one fullscreen pass, at world frames only.
     A still, a snapshot or a history younger than two frames is shown as is. core.blend=0 (lab) turns it off. */
  let blendP = null, blendT = null, blendFb = null, prevOut = null;
  /*@lab*/ WX.param("core.blend", 1, 0, 1, 1, "core"); /*@end*/
  function blendWorld(a, b) {
    if (!blendP) blendP = R.program("core.blend", { fs: `
      uniform sampler2D uA, uB; out vec4 o;
      void main() { ivec2 p = ivec2(gl_FragCoord.xy); o = .5 * (texelFetch(uA, p, 0) + texelFetch(uB, p, 0)); }` });
    if (!blendP.ready()) return false;
    const [w, h] = R.size.S;
    if (!blendT || blendT.w !== w || blendT.h !== h) {
      if (blendT) { gl.deleteTexture(blendT.tex); gl.deleteFramebuffer(blendFb.fb); }
      blendT = G.tex2D(w, h, "rgba16f"); blendFb = G.fbo([blendT]);
    }
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    tBegin("blend:core");
    R.draw(blendP, blendFb, { uA: a, uB: b });
    tEnd();
    return true;
  }
  /* [r5] THE SPLIT WORLD FRAME (knobs.worldSplit, T0-T1, contract 1.3.5). At 30 Hz the world frame carried all the
     world's work and the frame after it none: on Intel T1 in a storm 7.8 ms against 1.5, so the window's p95 was the
     world frames' tail, and another client of the iGPU (the desktop terminal, 30-100 ms of GPU a second while we
     measured) landing in one of them put it over 12 ms (notes/director.md "Round 5"). Now the frame that starts
     world frame n draws its early slots (shadow to coast: the sky, the clouds and the cove into SCENE) and shows
     world frame n - 1 as it was resolved; the next frame draws the late ones (ocean to bloom) with n's jitter,
     resolves n and shows the in-between picture (n - 1 + n) / 2. The world's picture is one 60 Hz frame later than
     before; each half reads F as it is on its own frame (the sea 16 ms after the sky), but the late half takes the
     strikes (F.flashes) as they were when n began, so the channel, the sea's flash light and the sky's glow agree.
     Passes see F.world only on the first frame; uFrame.z and uTaa read as a world frame's on both. A world frame
     asked for before the late half (a still, a snapshot) drops world frame n; a resize drops it too (SCENE is new).
     A still, a snapshot, a young history or the tiers that draw the world every frame draw it whole.
     core.split=0 (lab) draws it whole, to compare. */
  const EARLY = { shadow: 1, atmo: 1, clouds: 1, sky: 1, coast: 1 };
  /* the strikes as they were when world frame n began: its late half (the channel, the sea's flash light, the flash
     limit) reads them, so a strike's channel never shows a frame before the deck it lights (measured: the channel
     came 33 ms before the sky's glow without this) */
  const FLA = [WX.noFlash(), WX.noFlash()];
  let flLive = null;
  function keepFlashes(src) {
    for (let k = 0; k < 2; k++) {
      const a = src[k], b = FLA[k];
      for (const key in a) { const v = a[key]; if (Array.isArray(v)) { const d = b[key] || (b[key] = []); for (let i = 0; i < v.length; i++) d[i] = v[i]; } else b[key] = v; }
    }
  }
  /*@lab*/ WX.param("core.split", 1, 0, 1, 1, "core"); /*@end*/
  R.frame = (F) => {
    G.poll();
    G.pump();          // programs made after the build (lazily) still get issued without the parallel extension
    tPoll();
    if (!R.ready) { R.step(); return false; }
    const T = R.taa;
    if (pending && F.world) { T.jitter[0] = T.prev[0]; T.jitter[1] = T.prev[1]; pending = false; }   // [r5] n dropped
    late = pending; pending = false;
    let split = F.world && !F.still && !F.snapshot && R.knobs.worldEvery > 1 && R.knobs.worldSplit > 0 && T.on && !!T.out && T.age > 2;
    /*@lab*/ split = split && R.p("core.split") > 0; /*@end*/
    if (split) keepFlashes(F.flashes);
    if (late) { flLive = F.flashes; F.flashes = FLA; }    // [r5] world frame n's strikes for its late half
    frameBegin();
    pack(F);
    if (rec) rec.flash = F.flashes[0].I > 0 || F.flashes[1].I > 0 || F.flashes[0].B > 0 || F.flashes[1].B > 0;   // [r4] for the governor
    sceneOut = T.on && !F.world && !late ? T.out : null; // [1.2] the composite only: the last resolved picture
    let blend = (F.world && !split || late) && !F.still && !F.snapshot && R.knobs.worldEvery > 1 && R.knobs.worldBlend > 0;   // [r4]
    /*@lab*/ blend = blend && R.p("core.blend") > 0; /*@end*/
    if (F.world) prevOut = T.out;                        // [r4] world frame n - 1's picture, before the resolve of n
    let shown = false;
    for (const [slot, stage] of WX.SLOTS) {
      if (stage === "world") {
        if (late ? EARLY[slot] : !F.world || split && !EARLY[slot]) continue;          // [r5]
      } else if (split && !shown) {                      // [r5] the early half is in: show world frame n - 1, unjittered
        shown = true; sceneOut = T.out;
        if (jx || jy) unjitter();
      }
      if (slot === "coast") {            // [v1.1] SCENEZ starts each world frame at 0: no cove in front of anything
        R.bind("coast");
        gl.clearBufferfv(gl.COLOR, 1, ZERO4);
      }
      /*@lab*/ if (stage === "world" && R.p("core.sentinel") > 0) sentinel(slot); /*@end*/
      for (const m of WX.mods) {
        const fn = m.slots && m.slots[slot];
        if (!fn) continue;
        bindContract();
        gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.depthMask(true);
        gl.disable(gl.CULL_FACE); gl.frontFace(gl.CCW);    // [1.2] no culling state leaks between passes
        tBegin(slot + ":" + m.name);
        fn(R, F);
        tEnd();
        /*@lab*/ if (R.p("core.slotflush") > 0) gl.flush(); /*@end*/
      }
      if (slot === "taa" && T.on) {                        // [1.2] from here on: the resolved, unjittered picture
        sceneOut = T.out;
        if (jx || jy) unjitter();
        if (T.out && !F.still) T.age = Math.min(T.age + 1, 65535);
        if (blend && prevOut && T.out && prevOut !== T.out && T.age > 2 && blendWorld(prevOut, T.out)) sceneOut = blendT;   // [r4]
      }
    }
    /*@lab*/ burn(); debugView(); /*@end*/
    frameEnd();
    /* [r3] submit the frame now. Without it ANGLE/Vulkan kept the frame's last commands until the next frame
       began, so a timer query spanning them read the GPU's idle wait for the next frame: on the RTX 15-25 % of
       frames read 15-20 ms, the frame mean was 4x and the p95 one display interval (CHANGES-2 8's governor
       finding). With the flush: T0 mean 3.6 -> 0.9 ms, p95 16.7 -> 4.7; T4 4.1 -> 2.9, p95 17 -> 4.2 (CHANGES-3) */
    let flushNow = true;
    /*@lab*/ flushNow = R.p("core.tflush") > 0; /*@end*/
    if (flushNow) gl.flush();
    R.frameIndex++;
    if (F.world) R.worldIndex++;
    R.stats.frames++;
    pending = split; late = false;
    if (flLive) { F.flashes = flLive; flLive = null; }
    return true;
  };
  R.dispose = () => { /* the context goes with the canvas; nothing to free in the lab */ };
  return R;
};
