/* ═══════════════════════ Weather: the API (stream E) ═══════════════════════
   WX.makeWeather(host, hooks) -> null | W, exactly DESIGN 9.1 (merged into index.html as makeWeather):
     host   the <div class="wx"> the view lives in; makeWeather puts its own <canvas> in it and swaps that
            canvas when the GPU setting changes (powerPreference). host.dataset.up = "1" shows the
            view (the page's CSS fades it in over 1.2 s); cleared on a loss and before any reading.
     hooks.onDead()       the view can no longer run (no restore in 10 s, 3 losses in 10 min, a failed
                          build): the page drops data-weather and stands as Glass. At most once.
     hooks.onScrim(grid, peak)  Float32Array(32), display luminance of a 4 x 8 grid, row 0 at the top,
                          flashes left out, at most twice a second; [1.2] peak: Float32Array(32), each cell's
                          brightest tap (R.meter.peak), or null until post provides it.
     hooks.quality        [1.2] "auto" | "high" | "low", the stored Quality: the detail (High pins T4, Low T0).
     hooks.gpu            [r7] "auto" | "low" | "high", the stored GPU setting: the first context's powerPreference
                          ('default', 'low-power', 'high-performance'), so a stored choice makes one context, not two.
                          It is a request: the browser may keep the GPU it runs on (on Linux it usually does).
     hooks.fps            [r7] "auto" | 30 | 60 | 120 | "display", the stored Frame rate (the pacer's P.cap).
     hooks.accent         [1.4] the accent's first value, as W.accent takes it (the lighthouse's lamp, contract section 10).
     Returns null at once when this browser cannot draw it (DESIGN 10.3): no WebGL2; a software
     renderer by name; no EXT_color_buffer_float; MAX_TEXTURE_SIZE < 4096 or MAX_3D_TEXTURE_SIZE < 128.
     The gate needs a context, so the context is made here (once, and kept); everything else (the
     renderer, programs, targets, noise) waits for the first idle task after the first paint.
   W.start() W.stop() W.play(moving) W.reading(p, th, misted) W.sky(follow, place) W.quality(q) W.gpu(g) W.fps(f)
   W.resize() W.capture(w, h): DESIGN 9.1. [1.4] W.accent(rgb): the colour every other theme gives the ring for the
   hottest reading (rampOf on the dark ground's STOP table), sRGB [r, g, b] 0..255; null or anything else is no reading
   (the unknown grey-blue). It colours the lighthouse's lamp, which eases to it as the reading eases (contract section
   10); handed to the passes as F.accent on every drawn frame; a still view draws a new still for it. W.lab: LAB ONLY (the lab's hooks; removed at the merge, with
   everything else between the contract's lab-only markers).

   Pacing (DESIGN 6.3): focused display/ceil(hz/75), unfocused display/ceil(hz/37.5), Low halves both; [r7] or the
   Frame rate setting's 30, 60, 120 fps or every refresh, halved unfocused (director.js, WX.pacer);
   the world every frame at T2-T4 and every second frame at T0-T1; a still is one converged frame
   (three metering passes), then a 4 s dissolve at 30 Hz per change and no frames at all otherwise.
   Hidden or stopped: no frames and no timers. The governor (DESIGN 6.2) on one GPU timer query a frame,
   or the fence backlog without one; its settled tier is remembered in localStorage "ccquota.wx".

   WX.apiLab(canvas, Q, LAB): LAB ONLY. Drives makeWeather from the lab page with ?api=1, standing in
   for the dashboard's glue (DESIGN 9.2): p=, plan=, held=1, blank=1 (after the first reading), follow=0|1,
   lat= lon=, quality=auto|high|low, [r7] gpu=auto|low|high, fps=auto|30|60|120|display, lapse=k (the sky clock runs k x real time), at=<ISO> (the sky clock's
   start), t0= (scene clock), steps=p@s,p@s (later readings), slow=N@a-b (forced slow GPU: N passes from a
   to b s after the view is up), lose=ms (lose the context ms after up, restore 1 s later; losecount=n
   repeats it, norestore=1 never restores), strike=s (force a strike s after up), frames=N, [r4] memtier=N
   (the stored tier memory holds N: a warm start).                                                   */
(function () {
  const SOFT = /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i;
  const ATTRS = { alpha: false, depth: false, stencil: false, antialias: false, premultipliedAlpha: true,
                  preserveDrawingBuffer: false, desynchronized: false };
  const now = () => performance.now();

  /* the gate (DESIGN 10.3): a context this design can run on, or null */
  function gate(canvas, power) {
    let gl = null;
    try { gl = canvas.getContext("webgl2", Object.assign({ powerPreference: power }, ATTRS)); } catch (_) { gl = null; }
    if (!gl) return null;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || "");
    let soft = SOFT.test(renderer);
    /*@lab*/ if (WX.labAllowSoft) soft = false; /*@end*/
    const ok = !soft && !!gl.getExtension("EXT_color_buffer_float") &&
      gl.getParameter(gl.MAX_TEXTURE_SIZE) >= 4096 && gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) >= 128;
    if (!ok) { const lc = gl.getExtension("WEBGL_lose_context"); if (lc) lc.loseContext(); return null; }
    return { gl, renderer, power };
  }
  function powerOf(g) { return g === "high" ? "high-performance" : g === "low" ? "low-power" : "default"; }
  const gpuOf = (g) => (g === "high" || g === "low" ? g : "auto");
  const fpsOf = (f) => { const n = Number(f); return n === 30 || n === 60 || n === 120 ? n : f === "display" ? f : "auto"; };
  /* [1.4] the accent as W.accent takes it: three finite numbers, clamped to 0..255 (a copy: the page may reuse its
     array); anything else is no reading (null) */
  const accentOf = (c) => {
    if (!c || typeof c.length !== "number" || c.length < 3) return null;
    const o = [+c[0], +c[1], +c[2]];
    return o.every((x) => isFinite(x)) ? o.map((x) => Math.min(255, Math.max(0, x))) : null;
  };
  const sameAccent = (a, b) => a === b || !!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  function newCanvas() {
    const c = document.createElement("canvas");
    c.setAttribute("aria-hidden", "true");
    c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
    return c;
  }

  WX.makeWeather = function (host, hooks) {
    if (typeof WebGL2RenderingContext === "undefined" || !host) return null;
    hooks = hooks || {};
    const q0 = hooks.quality === "high" || hooks.quality === "low" ? hooks.quality : "auto";
    /* [r7] the stored GPU setting first: its context is made at once, with its powerPreference */
    const g0 = gpuOf(hooks.gpu);
    let canvas = newCanvas();
    let ctx = gate(canvas, powerOf(g0));
    if (!ctx) return null;
    host.appendChild(canvas);

    let dOpts = {};
    /*@lab*/ if (WX.labSeed !== undefined) dOpts = { seed: WX.labSeed }; /*@end*/
    const D = WX.director(dOpts);
    const P = WX.pacer();
    P.cap = fpsOf(hooks.fps);
    const S = {
      active: false, moving: true, quality: q0, gpu: g0, dead: false, lost: false, up: false,
      building: false, scheduled: 0, raf: 0, poll: 0, stillTimer: 0, resizeTimer: 0, restoreTimer: 0,
      losses: [], rebuildTier: -1, tooSlow: false, missed: false, world: 0, frames: 0, swaps: 0,
      resizes: 0, pend: false,  // [r4] pend: a size or tier to take at the start of the next drawn frame (takeSize)
      still: null,             // { phase: "snap" | "meter" | "fade", n, at, frames }, while a still is being made
      warm: null,              // { n, at, frames }: the first frames, metered before the view is shown
      stillSun: [0, 0, 1], stillAt: 0, scrimAt: 0, scrimSeen: 0, lastFrame: 0,
    };
    let R = null, G = null, tier = 2, next = null;   // next: a canvas being built for a swap
    let accent = accentOf(hooks.accent);                // [1.4] the page's accent (F.accent): the lighthouse's lamp
    const scrim = new Float32Array(32), scrimPeak = new Float32Array(32);
    let clock = () => Date.now();                       // the sky's clock: the wall clock (the lab may replace it)
    /*@lab*/
    /* lab: the director's and the API's JS per drawn frame (the frame less the renderer's GL work), ms */
    const lab = { D, P, burn: null, onFrame: null, state: S, js: new Float64Array(1024), jsN: 0, rMs: 0 };
    Object.defineProperty(lab, "clock", { get: () => clock, set: (f) => { clock = f; } });
    /*@end*/

    function die(why) {
      if (S.dead) return;
      S.dead = true;
      halt();
      delete host.dataset.up;
      /* [1.3] let the GPU go at once (D's request): no restore is awaited any more, the context is released
         and the canvas leaves the host, so the page's glass stands without anything of the view under it */
      clearTimeout(S.restoreTimer); S.restoreTimer = 0;
      try {
        const lc = ctx && ctx.gl && !ctx.gl.isContextLost() ? ctx.gl.getExtension("WEBGL_lose_context") : null;
        if (lc) lc.loseContext();
      } catch (_) { /* already gone */ }
      if (canvas && canvas.parentNode === host) host.removeChild(canvas);
      if (next) {                                      // dead in the middle of a swap: the old canvas goes too
        const o = next;
        next = null;
        if (o.canvas.parentNode) o.canvas.parentNode.removeChild(o.canvas);
        try { const l2 = o.ctx.gl.isContextLost() ? null : o.ctx.gl.getExtension("WEBGL_lose_context"); if (l2) l2.loseContext(); } catch (_) { /* gone */ }
      }
      if (why) console.warn("weather: " + why);
      try { if (hooks.onDead) hooks.onDead(); } catch (e) { console.error(e); }
    }
    function cssSize() { return [Math.max(1, host.clientWidth || innerWidth), Math.max(1, host.clientHeight || innerHeight)]; }
    function devicePx() { const [w, h] = cssSize(), d = devicePixelRatio || 1; return (w * d * h * d) / 1e6; }
    function pinned() { return S.quality === "high" ? 4 : S.quality === "low" ? 0 : -1; }

    /* ── the renderer, made in an idle task after the first paint (and again after a restore or a swap) ── */
    function schedule() {
      if (S.scheduled || R || S.dead || S.lost) return;
      S.scheduled = requestAnimationFrame(() => { S.scheduled = setTimeout(build, 0); });
    }
    /* [r4] the governor's options; p.core.govflash=0 (lab) counts flash frames in the p95 again, to compare;
       [r5b] p.core.govwin=N (lab): the deciding mean over N 2 s windows (1: round 5's first rule) */
    function govOpts(o) {
      /*@lab*/ if (WX.labParam && WX.labParam["core.govflash"] === 0) o.flashP95 = true; /*@end*/
      /*@lab*/ if (WX.labParam && WX.labParam["core.govwin"] > 0) o.meanWindows = WX.labParam["core.govwin"]; /*@end*/
      return o;
    }
    function build() {
      S.scheduled = 0;
      if (S.dead || S.lost || !S.active) return;
      let timing = false;
      /*@lab*/ timing = !!WX.labSlotTiming; /*@end*/      // LAB ONLY: per-slot queries
      try {
        R = WX.renderer(canvas, ctx.gl, { timing });
      } catch (e) { die("the renderer could not start: " + (e && e.message)); return; }
      /*@lab*/ for (const [k, v] of Object.entries(WX.labParam || {})) if (WX.params[k]) WX.params[k].v = v; /*@end*/   // [r4] knobs the renderer registers (core.*)
      const [w, h] = cssSize(), mp = devicePx();
      const pin = pinned();
      tier = pin >= 0 ? pin : S.rebuildTier >= 0 ? S.rebuildTier : WX.startTier(ctx.renderer, w, devicePixelRatio || 1, mp);
      S.rebuildTier = -1; S.pend = false;
      G = WX.governor(govOpts({ tier, timer: R.caps.timer, pinned: pin >= 0 }));
      G.notice(now(), true);
      R.onGpu = (ms, backlogged, flash) => { if (G) G.sample(now(), ms, backlogged, flash); };
      R.resize(w, h, devicePixelRatio || 1, tier);
      D.view(R.cam.hfov);
      P.low = S.quality === "low";
      S.building = true;
      loop();
    }

    /* ── the loop ── */
    function wants() {
      if (!S.active || S.dead || S.lost || document.hidden) return false;
      if (!R || !R.ready) return !!R;
      if (!D.seen) return false;
      return S.moving && !S.tooSlow || !!S.still || !!S.warm;
    }
    function loop() { if (!S.raf && wants()) S.raf = requestAnimationFrame(tick); }
    function halt() {
      if (S.raf) cancelAnimationFrame(S.raf);
      S.raf = 0;
      if (S.poll) clearInterval(S.poll);
      S.poll = 0;
      if (S.stillTimer) clearTimeout(S.stillTimer);
      S.stillTimer = 0;
      if (S.resizeTimer) clearTimeout(S.resizeTimer);
      S.resizeTimer = 0;
      if (S.scheduled) { cancelAnimationFrame(S.scheduled); clearTimeout(S.scheduled); S.scheduled = 0; }
    }
    function focusPoll() {
      if (S.poll || !S.active || document.hidden || S.dead) return;
      P.focused = document.hasFocus();
      S.poll = setInterval(() => { if (document.hidden) { clearInterval(S.poll); S.poll = 0; return; } P.focused = document.hasFocus(); }, 2000);
    }
    function tick(ts) {
      S.raf = 0;
      if (!wants()) return;
      S.raf = requestAnimationFrame(tick);
      /*@lab*/ const a = now(); lab.rMs = -1; /*@end*/
      try { frame(ts); } catch (e) { die("a frame failed: " + (e && e.message)); }
      /*@lab*/ if (lab.rMs >= 0) { lab.js[lab.jsN % 1024] = now() - a - lab.rMs; lab.jsN++; } /*@end*/
    }
    function frame(ts) {
      if (!R.ready) {                                  // the staged build: one step a frame
        R.frame(D.F);
        if (R.ready) { S.building = false; if (D.seen) rise(); else halt(); }
        return;
      }
      /* stills and their dissolves run at 30 Hz; moving frames at the pacer's cap */
      const focused = P.focused;
      if (S.still && S.still.phase === "fade") P.focused = false;
      const draw = P.tick(ts);
      P.focused = focused;
      if (!draw) return;
      const resized = takeSize();
      const t = now(), dt = P.dt;
      /* [r6] late: a draw slot missed (over 1.5 periods since the last draw). 1.25 periods flagged a single vsync the
         browser skipped at 240 Hz (20.8 ms against 16.7) as late, where at 60 Hz a late frame is a whole frame (33 ms);
         at k = 1 both thresholds catch a missed vsync */
      /* [r7] against Auto's pace at most: at 120 fps or every refresh a frame that misses a vsync is not a slow GPU
         (the GPU timer, or the fence over Auto's period, still judges the detail), so a faster Frame rate costs
         smoothness on a slow GPU, not detail */
      if (G && !S.still && !S.warm) G.pace(t, dt * 1000 > 1.5 * Math.max(P.k * 1000 / P.hz, 1000 / 75));
      let F;
      if (S.warm) {                                    // the first frames: converged, metered three times, not yet shown
        const w = S.warm;
        D.still = !S.moving || S.tooSlow;
        D.freeze = true;
        F = D.frame(clock(), dt, R.exposure.E);
        F.world = true;
        draw1(F);
        w.frames++;
        if (R.meter.at !== w.at) { w.at = R.meter.at; w.n++; }
        /* [1.3.1] and post's still meter has settled (R.exposure.stable >= 2; C's round-3 request: a still's scene
           keeps converging for ~30 frames, so three readings could show the view a stop off the exposure it then
           drifts to), at most 45 frames; a post without the field is taken as settled */
        if ((w.n >= 3 || w.frames >= 12) && !(R.exposure.stable < 2) || w.frames >= 45) {
          S.warm = null;
          D.freeze = false;
          show();
          if (D.still) stillDone();
        }
        return;
      }
      if (S.still) { stillFrame(dt, resized); return; }
      D.still = false;
      F = D.frame(clock(), dt, R.exposure.E);
      if (resized) S.world = 0;                        // [r4] the new size's targets hold nothing yet: a world frame
      F.world = F.snapshot || (S.world++ % R.knobs.worldEvery === 0);
      draw1(F);
      govern(t);
    }
    function draw1(F) {
      F.tier = R.tier;
      F.accent = accent;                                 // [1.4] the lighthouse's lamp eases to it (passes/beacon.js)
      /*@lab*/ if (lab.burn) R.burn.passes = lab.burn(); const a = now(); /*@end*/
      R.frame(F);
      /*@lab*/ lab.rMs = now() - a; /*@end*/
      S.lastFrame = now();
      S.frames++;
      /*@lab*/ if (lab.onFrame) lab.onFrame(F); /*@end*/
      const t = now();
      if (hooks.onScrim && R.meter.grid && R.meter.at !== S.scrimSeen && t - S.scrimAt >= 500) {
        S.scrimSeen = R.meter.at; S.scrimAt = t;
        scrim.set(R.meter.grid);
        let peak = null;                                 // [1.2] each cell's brightest tap, once post provides it
        if (R.meter.peak) { scrimPeak.set(R.meter.peak); peak = scrimPeak; }
        try { hooks.onScrim(scrim, peak); } catch (e) { console.error(e); }
      }
    }
    function govern(t) {
      if (!G) return;
      const nt = G.evaluate(t, P.focused, S.moving);
      if (G.tooSlow && !S.tooSlow) { S.tooSlow = true; requestStill(true); return; }
      if (nt >= 0 && nt !== tier) setTier(nt);
      G.settle(t, ctx.renderer, devicePx());
    }
    /* [r4] A tier change or a new size is TAKEN at the start of the next drawn frame, never where it is decided.
       R.resize sets canvas.width, which clears the drawing buffer; done after the frame's draw (the governor
       decides after it) or in a timer task (W.resize), the compositor then showed that cleared buffer: one black
       frame at every tier change (REVIEW-3 5: the dashboard storm's T4 -> T3, Intel's T2 -> T1 at ~8 s, and each
       backing-off try). Taken here, the resize and a full world frame at the new size share one task, so the
       buffer the page shows is always drawn. */
    function setTier(t) { tier = t; S.pend = true; }
    function takeSize() {
      if (!S.pend) return false;
      S.pend = false;
      const [w, h] = cssSize();
      R.resize(w, h, devicePixelRatio || 1, tier);
      D.view(R.cam.hfov);
      S.resizes++;
      if (G) { G.tier = tier; G.notice(now()); }
      return true;
    }

    /* the first frame of a reading: metered while hidden, then shown already in its weather */
    function rise() {
      if (S.up || !R || !R.ready || !D.seen) { loop(); return; }
      if (!S.warm) S.warm = { n: 0, at: R.meter.at, frames: 0 };
      loop();
    }
    function show() {
      S.up = true;
      host.dataset.up = "1";
      if (next) finishSwap();
    }

    /* ── stills (reduced motion, Moving scene off, too slow): DESIGN 6.3 and 10.2 ── */
    function requestStill(dissolve) {
      if (!R || !R.ready || !D.seen) return;
      if (!S.up) { rise(); return; }
      D.still = true;
      if (dissolve) { D.dissolve(WX.WALK.stillFade); D.hold = true; S.still = { phase: "snap", n: 0, at: R.meter.at, frames: 0 }; }
      else S.still = { phase: "meter", n: 0, at: R.meter.at, frames: 0 };
      loop();
    }
    function stillFrame(dt, resized) {
      const st = S.still;
      const F = D.frame(clock(), dt, R.exposure.E);
      if (st.phase === "snap") { F.world = true; draw1(F); st.phase = "meter"; return; }
      if (st.phase === "meter") {
        F.world = true;
        draw1(F);
        if (R.meter.at !== st.at) { st.at = R.meter.at; st.n++; }
        if (st.n >= 3 || ++st.frames >= 12) { st.phase = "fade"; D.hold = false; }
        return;
      }
      F.world = !!resized;                           // the dissolve: the composite only, from the snapshot ([r4] a new size: a world frame)
      draw1(F);
      if (!D.dissolving()) stillDone();
    }
    function stillDone() {
      S.still = null;
      D.hold = false;
      const s = D.sunENU(clock());
      S.stillSun[0] = s[0]; S.stillSun[1] = s[1]; S.stillSun[2] = s[2]; S.stillAt = clock();
      watchSun();
    }
    /* a still that follows the real sky is redrawn when the sun has moved over 0.25 deg, at most every 5 min */
    function watchSun() {
      if (S.stillTimer) clearTimeout(S.stillTimer);
      S.stillTimer = 0;
      if (S.moving && !S.tooSlow || !S.active || document.hidden || !D.place().follow) return;
      S.stillTimer = setTimeout(() => {
        S.stillTimer = 0;
        const s = D.sunENU(clock()), c = s[0] * S.stillSun[0] + s[1] * S.stillSun[1] + s[2] * S.stillSun[2];
        if (Math.acos(Math.min(1, c)) * 180 / Math.PI > 0.25) requestStill(true); else watchSun();
      }, 300000);
    }

    /* ── loss (DESIGN 10.3) ── */
    function listen(c) {
      c.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        if (c !== canvas || S.dead) return;            // a canvas being swapped out, or released by die()
        /*@lab*/ if (lab.onLost) lab.onLost(); /*@end*/
        const t = now();
        S.losses = S.losses.filter((x) => t - x < 600000);
        S.losses.push(t);
        S.lost = true; S.up = false; S.still = null; S.warm = null; D.freeze = false;
        delete host.dataset.up;
        halt();
        R = null; G = null;
        if (S.losses.length >= 3) { die("the GPU was lost three times in ten minutes"); return; }
        S.restoreTimer = setTimeout(() => die("the GPU did not come back within 10 s"), 10000);
      });
      c.addEventListener("webglcontextrestored", () => {
        if (c !== canvas || S.dead) return;
        clearTimeout(S.restoreTimer); S.restoreTimer = 0;
        S.lost = false;
        if (S.losses.length >= 2) S.rebuildTier = Math.max(0, tier - 1);   // the second in 10 min: one tier lower
        else S.rebuildTier = tier;
        D.still = !S.moving || S.tooSlow;
        if (S.active) schedule();
      });
    }
    listen(canvas);

    /* ── the GPU setting: a change makes the context again with another powerPreference ── */
    function swap() {
      const c = newCanvas();
      const g2 = gate(c, powerOf(S.gpu));
      if (!g2) return false;
      /* under the old one until it is up; [r7] with no inline opacity, which, cleared, ran the page's 1.2 s fade-in from 0
         as the old canvas went: a dark frame on every Graphics card change */
      host.insertBefore(c, canvas);
      listen(c);
      const old = { canvas, ctx, R };
      halt();
      next = old;
      canvas = c; ctx = g2; R = null; G = null;
      S.swaps++;
      if (!old.R || !S.up) { S.up = false; delete host.dataset.up; finishSwap(); }   // nothing shown yet: no overlap
      S.up = false;
      if (S.active) schedule();
      return true;
    }
    function finishSwap() {
      const old = next;
      next = null;
      if (old.canvas.parentNode) old.canvas.parentNode.removeChild(old.canvas);
      const lc = old.ctx.gl.getExtension("WEBGL_lose_context");
      if (lc) lc.loseContext();
    }

    /* ── focus and visibility: frame caps, and no timers while hidden ── */
    const onFocus = () => { P.focused = true; };
    const onBlur = () => { P.focused = false; };
    addEventListener("focus", onFocus);
    addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { halt(); return; }
      if (S.active && !S.dead) { P.rebase(); focusPoll(); if (R && !R.ready) loop(); else resume(); }
    });
    function resume() {
      focusPoll();
      if (!R) { schedule(); return; }
      if (!R.ready) { loop(); return; }
      if (!D.seen) return;
      if (!S.up) { rise(); return; }
      if (S.missed && (!S.moving || S.tooSlow)) { S.missed = false; requestStill(true); return; }
      S.missed = false;
      if (!S.moving || S.tooSlow) { if (!S.still) watchSun(); }
      /* back after more than a minute away: dissolve over 2 s to the sky as it is now (DESIGN 2.4) */
      else if (S.lastFrame && now() - S.lastFrame > 60000) D.dissolve(WX.WALK.jumpFade);
      loop();
    }

    const W = {
      start() {
        if (S.dead) return;
        const was = S.active;
        S.active = true;
        focusPoll();
        if (!was) P.rebase();
        if (S.lost) return;
        resume();
      },
      stop() { S.active = false; halt(); },
      play(moving) {
        const m = !!moving;
        if (m === S.moving) { if (S.active) resume(); return; }
        S.moving = m;
        P.rebase();
        if (!R || !R.ready || !D.seen || !S.up) { if (S.active) resume(); return; }
        if (!m || S.tooSlow) requestStill(true);
        else { S.still = null; D.still = false; D.hold = false; if (S.stillTimer) { clearTimeout(S.stillTimer); S.stillTimer = 0; } loop(); }
      },
      reading(p, th, misted) {
        const first = !D.seen;
        const changed = D.reading(p, th, misted);
        if (first && D.seen) { if (S.active) resume(); return; }
        if (!changed || !D.seen) return;
        if (!S.active || document.hidden) { S.missed = true; return; }
        if (!S.moving || S.tooSlow) requestStill(true);
      },
      sky(follow, place) {
        const changed = D.sky(follow, place);
        if (!changed || !D.seen) return;
        if (!S.active || document.hidden) { S.missed = true; return; }
        if (!S.moving || S.tooSlow) requestStill(true);
      },
      quality(q) {
        q = q === "high" || q === "low" ? q : "auto";
        if (q === S.quality) return;
        S.quality = q;
        P.low = q === "low";
        if (!R || !R.ready) return;
        const pin = pinned();
        G = WX.governor(govOpts({ tier: pin >= 0 ? pin : tier, timer: R.caps.timer, pinned: pin >= 0 }));
        G.notice(now());
        if (pin >= 0 && pin !== tier) setTier(pin);
        if (!S.moving || S.tooSlow) requestStill(true);
      },
      /* [r7] the GPU setting: a change makes the context again with its powerPreference, the old canvas shown
         until the new one is up; if the browser refuses the new one, the old one stays */
      gpu(g) {
        g = gpuOf(g);
        if (g === S.gpu || S.dead) return;
        const was = S.gpu;
        S.gpu = g;
        if (!swap()) S.gpu = was;
      },
      /* [r7] the Frame rate setting: the pacer's cap, from the next frame */
      fps(f) {
        f = fpsOf(f);
        if (f === P.cap) return;
        P.cap = f;
        if (G) G.notice(now());
      },
      /* [1.4] the page's accent for the reading (contract section 10): the lighthouse's lamp. Moving, the lamp eases to
         it on the next frames; a still view draws a new still (unless one is still being metered, which takes it) */
      accent(rgb) {
        const c = accentOf(rgb);
        if (sameAccent(c, accent)) return;
        accent = c;
        if (!R || !R.ready || !D.seen || !S.up) return;
        if (!S.active || document.hidden) { S.missed = true; return; }
        if ((!S.moving || S.tooSlow) && (!S.still || S.still.phase === "fade")) requestStill(true);
      },
      resize() {
        if (S.resizeTimer) clearTimeout(S.resizeTimer);
        S.resizeTimer = setTimeout(() => {
          S.resizeTimer = 0;
          if (!R) return;
          setTier(tier);                                 // [r4] taken by the next drawn frame (a build takes it once ready)
          if (!R.ready) return;
          P.reset();
          if (!S.moving || S.tooSlow) requestStill(false); else loop();
        }, 150);
      },
      capture(w, h) {
        if (!R || !R.ready || !D.seen || S.lost || S.dead || !(w > 0 && h > 0)) return null;
        takeSize();
        const F = D.frame(clock(), 0, R.exposure.E);
        F.world = true;
        draw1(F);
        const out = document.createElement("canvas");
        out.width = Math.round(w); out.height = Math.round(h);
        const cx = out.getContext("2d");
        if (!cx) return null;
        const sw = canvas.width, sh = canvas.height, k = Math.max(out.width / sw, out.height / sh);
        const cw = out.width / k, ch = out.height / k;
        cx.drawImage(canvas, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, out.width, out.height);
        return out;
      },
    };
    /*@lab*/
    W.lab = lab;
    lab.R = () => R;
    lab.G = () => G;
    lab.canvas = () => canvas;
    lab.ctx = () => ctx;
    lab.tier = () => tier;
    /*@end*/
    return W;
  };

  /*@lab*/
  /* ══════════════ LAB ONLY: the dashboard's part, from URL parameters (removed at the merge) ══════════════ */
  WX.apiLab = function (labCanvas, Q, LAB) {
    const num = (k, d) => (Q.has(k) && Q.get(k) !== "" && isFinite(+Q.get(k)) ? +Q.get(k) : d);
    for (const [k, v] of Object.entries(WX.labParam || {})) if (WX.params[k]) WX.params[k].v = v;   // p.<knob>=x
    /* [1.3] p.flash.cap= and p.flash.peak= reach the director here too (the lab path registers them as params) */
    if (WX.labParam && "flash.cap" in WX.labParam) WX.FLASH.cap = WX.labParam["flash.cap"];
    if (WX.labParam && "flash.peak" in WX.labParam) WX.FLASH.peak = WX.labParam["flash.peak"];
    labCanvas.style.display = "none";
    if (Q.get("ui") === "0") { const pn = document.getElementById("panel"); if (pn) pn.remove(); }
    const style = document.createElement("style");
    style.textContent = ".wx{position:fixed;inset:0;background:#05080c}.wx canvas{opacity:0;transition:opacity 1.2s}" +
      ".wx[data-up='1'] canvas{opacity:1}";
    document.head.appendChild(style);
    const host = document.createElement("div");
    host.className = "wx"; host.id = "wx";
    document.body.insertBefore(host, document.body.firstChild);
    /* count every draw call, for the "zero draws" checks */
    LAB.draws = 0;
    for (const k of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements"]) {
      const f = WebGL2RenderingContext.prototype[k];
      WebGL2RenderingContext.prototype[k] = function () { LAB.draws++; return f.apply(this, arguments); };
    }
    /* [1.2] count the WebGL2 contexts made, and their powerPreference (a stored High makes one, not two) */
    LAB.contexts = 0; LAB.powers = [];
    const gc = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      if (type === "webgl2" && this !== labCanvas) { LAB.contexts++; LAB.powers.push(attrs && attrs.powerPreference); }
      return gc.apply(this, arguments);
    };
    LAB.api = true; LAB.dead = false; LAB.scrims = 0; LAB.log = [];
    /* a texture used after its context was lost or swapped: whose (the stack names the module) */
    LAB.epoch = 0; LAB.stale = [];
    const proto = WebGL2RenderingContext.prototype, mk = proto.createTexture, bt = proto.bindTexture;
    proto.createTexture = function () { const t = mk.call(this); if (t) { t.__gl = this; t.__epoch = LAB.epoch; } return t; };
    proto.bindTexture = function (target, t) {
      if (t && (t.__gl !== this || t.__epoch !== LAB.epoch) && LAB.stale.length < 8)
        LAB.stale.push(String(new Error().stack).split("\n").slice(2, 6).map((l) => l.trim().replace(/^at /, "").replace(/\(?https?:\/\/[^/]+\//, "(")).join(" < "));
      return bt.call(this, target, t);
    };
    WX.labAllowSoft = Q.get("allowsoft") === "1";          // debug the API's logic on SwiftShader, without the GPU
    WX.labSlotTiming = Q.get("slots") === "1";             // the governor fed by the sum of per-slot queries
    const plan = Q.get("plan") || "max20";
    const th = { warningFloorPercent: 70, exhaustedPercent: 100, criticalPercent: { max20: 99.75, max5: 99, pro: 95 }[plan] || 99.75 };
    const W = (LAB.W = WX.makeWeather(host, {
      onDead: () => { LAB.dead = true; LAB.log.push([performance.now(), "dead"]); },
      onScrim: (g, pk) => { LAB.scrims++; LAB.scrimPeak = !!pk; },
      quality: Q.get("quality") || "auto",            // [1.2] the stored Quality, before the first context
      gpu: Q.get("gpu") || "auto",                    // [r7] the stored GPU setting
      fps: Q.get("fps") || "auto",                    // [r7] the stored Frame rate
    }));
    if (!W) { LAB.nullApi = true; LAB.ready = true; LAB.done = true; LAB.summary = () => ({ nullApi: true, errors: LAB.errors, ready: true }); return; }
    const lab = W.lab, D = lab.D;
    /* [r4] memtier=N: the tier memory holds N for this renderer and size, as after an earlier session settled there
       (the dashboard's warm start; the renderer is built after the first paint, so this is in time) */
    if (Q.has("memtier")) {
      const d = devicePixelRatio || 1, mp = (Math.max(1, host.clientWidth || innerWidth) * d * Math.max(1, host.clientHeight || innerHeight) * d) / 1e6;
      try { localStorage.setItem(WX.TIER_MEMORY, JSON.stringify({ r: lab.ctx().renderer, s: Math.ceil(mp), t: num("memtier", 2) | 0, at: Date.now() })); } catch (_) { /* no storage */ }
    }
    lab.onLost = () => { LAB.epoch++; };
    if (Q.has("t0")) D.setScene(num("t0", 1000));
    /* the sky's clock: real time, or from an instant, sped up by lapse */
    const t0 = Date.now(), at = Q.has("at") ? Date.parse(Q.get("at")) : t0, lapse = num("lapse", 1);
    lab.clock = () => at + (Date.now() - t0) * lapse;
    const place = { lat: num("lat", 38.7), lon: num("lon", -9.1), zone: Q.get("zone") || "", from: "lab" };
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    let upAt = 0;
    const misted = Q.get("held") === "1";
    /* [1.4] the page's accent with each reading (WX.accentOf: rampOf on the dark ground's STOP table); accent=unknown or
       accent=r,g,b forces one */
    const qa = Q.get("accent");
    const labAccent = (p) => qa === "unknown" ? null : qa && /^\d+,\d+,\d+$/.test(qa) ? qa.split(",").map(Number) : WX.accentOf(p, th);
    let labP = Q.has("p") ? num("p", 60) : 60;          // the reading the page holds now (steps= and blank= change it)
    function motion() {
      if (document.hidden) { W.stop(); return; }
      W.sky(Q.get("follow") !== "0", place);
      W.quality(Q.get("quality") || "auto");
      W.gpu(Q.get("gpu") || "auto");
      W.fps(Q.get("fps") || "auto");
      W.start();
      W.reading(Q.has("p") ? num("p", 60) : 60, th, misted);
      if (W.accent) W.accent(labAccent(labP));
      W.play(Q.get("still") !== "1" && !reduce.matches);
    }
    reduce.addEventListener("change", motion);
    document.addEventListener("visibilitychange", motion);
    /* the dashboard calls makeWeather at boot and the rest after its first paint */
    motion();
    LAB.renderer = lab.ctx().renderer;
    /* later readings and events, in seconds after the view is up */
    const steps = (Q.get("steps") || "").split(",").filter(Boolean).map((s) => s.split("@").map(Number));
    const slow = /^(\d+)@([\d.]+)-([\d.]+)$/.exec(Q.get("slow") || "");
    if (slow) lab.burn = () => { const s = (performance.now() - upAt) / 1000; return upAt && s >= +slow[2] && s < +slow[3] ? +slow[1] : 0; };
    let loseN = 0;
    const loseAt = Q.has("lose") ? num("lose", 1000) : -1, loseCount = num("losecount", 1);
    const stepsDone = new Set();
    LAB.frames = 0;
    function upNow() { if (!upAt && lab.state.up) { upAt = performance.now(); LAB.upMs = upAt; LAB.ready = true; } }
    lab.onFrame = (F) => {
      LAB.frames++;
      LAB.F = F;
      LAB.R = lab.R();
      upNow();
      if (upAt && LAB.walk) LAB.walk.push([+((performance.now() - upAt) / 1000).toFixed(4), D.walk.v, +F.W.rain.toFixed(3), +D.walk.mist.toFixed(3)]);
    };
    /* scripted readings and events, from the lab's poll (a still draws no frames to hang them on) */
    function script() {
      upNow();
      if (!upAt) return;
      const s = (performance.now() - upAt) / 1000;
      steps.forEach(([p, t], i) => { if (!stepsDone.has(i) && s >= t) { stepsDone.add(i); labP = p; W.reading(p, th, misted); if (W.accent) W.accent(labAccent(p)); LAB.log.push([performance.now(), "reading " + p]); } });
      if (Q.has("blank") && !stepsDone.has("blank") && s >= num("blank", 1)) { stepsDone.add("blank"); labP = null; W.reading(null, th, true); if (W.accent) W.accent(labAccent(null)); }
      /* [1.2] strikeAz= strikeKm= strikeP= strikeKind=0|1 place the forced strike, as in the lab */
      if (Q.has("strike") && !stepsDone.has("strike") && s >= num("strike", 1)) {
        stepsDone.add("strike");
        const o = {};
        for (const [k, q] of [["az", "strikeAz"], ["km", "strikeKm"], ["P", "strikeP"], ["kind", "strikeKind"]]) if (Q.has(q)) o[k] = num(q, 0);
        D.force(o);
      }
    }
    if (Q.get("trace") === "1") LAB.walk = [];
    (function poll() {
      /* the lab's own bookkeeping: a timer only while the page is visible and the run is not over */
      if (document.hidden) { setTimeout(poll, 250); return; }
      script();
      const R = lab.R();
      if (upAt && loseAt >= 0 && loseN < loseCount && performance.now() - upAt >= loseAt + loseN * 3000 && R) {
        const lc = lab.ctx().gl.getExtension("WEBGL_lose_context");
        loseN++; LAB.losses = loseN;
        LAB.log.push([performance.now(), "lose " + loseN]);
        lc.loseContext();
        if (Q.get("norestore") !== "1") setTimeout(() => lc.restoreContext(), 1000);
      }
      const want = num("frames", 0);
      if (want && LAB.frames >= want) LAB.done = true;
      /* a still has no frames to count: done once the view is up and nothing is scheduled for 1 s */
      const st = lab.state;
      LAB.idle = st.up && !st.raf && !st.still && !st.warm ? (LAB.idle || 0) + 1 : 0;
      if (want && LAB.idle >= 10) LAB.done = true;
      if (!LAB.done) setTimeout(poll, 100);
    })();
    LAB.summary = () => {
      const R = lab.R(), G = lab.G();
      return { api: true, renderer: LAB.renderer, ready: !!LAB.ready, frames: LAB.frames, draws: LAB.draws, errors: LAB.errors,
        losses: LAB.losses || 0, dead: LAB.dead, up: lab.state.up, tier: lab.tier(), S: R && R.size && R.size.S,
        power: lab.ctx().power, swaps: lab.state.swaps, scrims: LAB.scrims, scrimPeak: !!LAB.scrimPeak, contexts: LAB.contexts || 0, powers: LAB.powers, tierLog: G && G.log, gpuAvg: G && +G.avg.toFixed(3), gpuP95: G && +G.p95.toFixed(3), gpuN: G && G.n, late: G && G.late,
        slots: R && R.timing ? R.timesSummary() : null,
        hz: +lab.P.hz.toFixed(1), k: lab.P.k, focused: lab.P.focused, still: !!lab.state.still, moving: lab.state.moving,
        W: LAB.F && LAB.F.W, walk: D.walk, sun: LAB.F && Array.from(LAB.F.sun.dir), moon: LAB.F && Array.from(LAB.F.moon.dir),
        lit: LAB.F && LAB.F.moon.lit, log: LAB.log, exposure: R && R.exposure, stale: LAB.stale,
        jsMs: (() => { const n = Math.min(lab.jsN, 1024); if (!n) return null; const a = Array.from(lab.js.subarray(0, n)).sort((x, y) => x - y);
                       return { n, p50: +a[n >> 1].toFixed(4), p95: +a[Math.floor(n * 0.95)].toFixed(4), max: +a[n - 1].toFixed(3) }; })() };
    };
  };
  /*@end*/
})();
