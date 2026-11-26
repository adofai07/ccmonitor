/* ═══════════════════════ Weather: the director (stream E) ═══════════════════════
   The CPU half of makeWeather. Everything the renderer draws is a function of the frame state F it
   hands over once a frame (contract.js WX.frameDefaults); nothing here touches GL.

   D = WX.director(opts)       opts: { t0 (scene clock start s; default random in [0, 864 000)), seed,
                                       lat, lon, follow (Follow real time, default true), hfov (rad) }
     D.reading(p, th, misted)  p the hottest percent or null; th the served thresholds; misted: held, or
                               blank after a reading was seen. The first numeric p snaps every walker.
                               -> true when what the view should show changed (a still re-renders on it)
     D.sky(follow, place)      Follow real time; place { lat, lon }. -> true when it changed
     D.frame(nowMs, dt, E) -> F  nowMs the wall clock (Date.now()), dt the real seconds since the last
                               drawn frame (<= 0.1), [1.2] E the exposure the frame will be drawn at
                               (R.exposure.E; omitted: the last one given), which normalises the flash's
                               I (WX.flashI). Allocates nothing per frame (DESIGN 2.5 rule 4).
     D.still                   true: a converged still (walkers at their ends, no clock, no lightning)
     D.freeze                  true: a converged frame of the weather as it is (no clock, no walk, no lightning)
     D.dissolve(s)             the next frame keeps the old picture as post's snapshot (F.snapshot), then
                               F.dissolve runs 0 -> 1 over s seconds of real time
     D.hold                    while true, a dissolve waits at 0 (a still's metering passes)
     D.seen, D.F, D.walk       state, for the API and the lab
     D.view(hfovRad)           the view's width, for placing strikes in it

   Walkers (DESIGN 2.3, contract v1.1): [r7] v eases to each new reading, critically damped (WX.WALK.read: half of any
   step in 15 s, 99 % in 60 s; round 6 walked 0.6 points/s); wet 1/20 s; bolt 1/30 s; mist 1/20 s in,
   1/30 s out; soak tau 15 s in, 40 s out; puddle tau 35 s in, 40 s out. Clocks are float64 and reach
   F wrapped (WX.PERIOD), drifts mod 420 km and 840 m. The real sky (WX.skyAt) runs at 1 Hz, two
   samples interpolated; a sun or moon jump over 0.5 deg dissolves over 2 s. The stars' matrix is
   made every frame from the sidereal time, so they turn smoothly. Lightning (DESIGN 10.1): a
   Poisson process at W.flashRate after a dead time, starts >= 2.5 s apart and >= 1 s after the last
   envelope; one sky-light envelope per strike (33 ms up, 50 ms hold, tau 150 ms, 0 by 0.77 s);
   restrikes in the channel's B only; none in stills. [1.2] The scheduler is WX.lightning(rnd), shared
   with the lab (core/lab.js), and the flash's I is exposure-normalised (contract WX.FLASH, WX.flashI).

   P = WX.pacer()       display rate (median of 30 rAF intervals) and the frame cap of DESIGN 6.3; [r7] P.cap the
                        Frame rate setting: "auto" (DESIGN 6.3), 30, 60, 120, or "display" (every refresh)
   G = WX.governor(o)   the tier controller of DESIGN 6.2 (robust.md 2.6) and the tier memory       */
(function () {
  const RAD = Math.PI / 180, U = WX.util;
  const wrap = (x, p) => ((x % p) + p) % p;
  const toward = (x, t, step) => (x < t ? Math.min(t, x + step) : Math.max(t, x - step));
  /* [r7] THE READING EASES, IT DOES NOT WALK (the user, 2026-11-26: "more continuous change"). The quota comes in whole
     percents about every 2 minutes, and round 6 walked the scene's reading to each at 0.6 points/s: a 1-point step was
     a 1.7 s surge of wind, waves and rain at full rate, then nothing. Now the reading is a critically damped second-order
     system: v'' = w^2 (goal - v) - 2 w v', w = read (1/s; the key keeps its name so the harness's time-lapse, which
     scales `read` up, still speeds it). From rest, v = goal - D (1 + w t) e^(-w t): S-shaped (its rate starts at 0,
     peaks at t = 1 / w, then dies away), half of the step in 15 s, 90 % in 35 s, 99 % in 60 s, whatever the step's size
     (a 1-point step peaks at .04 points/s, 5 points at .2, a 40 -> 96 jump at 2.3). A new reading keeps the rate the
     reading has (no jump in it), and never overshoots: a reading that arrives closer than the rate can stop for at w
     (the walk heads to it faster than w x the distance) is approached at w' = rate / distance, a pure exponential, so the
     motion slows into it. Within .005 points and .001 points/s of its goal it stands on it (so the rain at the floor and
     the bolt at the third quarter start on a reading that lands on them). It decays to the goal: rule 1 holds. A first
     reading and a still still take the goal at once. */
  WX.WALK = { read: 0.11, wet: 20, bolt: 30, mistIn: 20, mistOut: 30, soakIn: 15, soakOut: 40, puddleIn: 35, puddleOut: 40,
              jumpDeg: 0.5, jumpFade: 2, toggleFade: 2, stillFade: 4 };
  /* [r7] the ease's step: the exact solution over dt, so any frame time is stable. e = v - goal, r = v'; returns the
     new v into s[0] and r into s[1] */
  WX.easeStep = function (v, r, goal, w, dt, s) {
    const e = v - goal, B = r + w * e, x = Math.exp(-w * dt);
    s[0] = goal + (e + B * dt) * x; s[1] = (r - w * B * dt) * x;
    return s;
  };
  /* the strike's sky light, up once and down once (robust.md 4.2): WX.FLASH, WX.flashLevel and WX.flashI
     are in the contract since 1.2 */
  /* a small seeded generator (mulberry32): every random thing is seeded (DESIGN 2.5 rule 5) */
  WX.rng = function (seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  /* [1.2] ── the lightning scheduler (DESIGN 10.1), one for the director and the lab ──
     L = WX.lightning(rnd)              rnd() in [0, 1): the director's seeded generator, or the lab's Math.random
     L.step(scene, dt, W, rate, flashes, E, frozen) -> lockExposure
                                        once a frame: scene the clock now (s), dt the step, rate strikes per s
                                        (0 in a still), flashes F.flashes (filled in place), E the exposure the
                                        frame is drawn at, frozen: a still or a frozen frame (every slot dark)
     L.strike(scene, W, forced)         start one now; forced { az deg, km, P, kind 0|1 } (each optional)
     L.lastStart, L.lastEnd, L.count    the last start and the last envelope's end, scene s; strikes so far
     L.hfov                             the view's width (rad), for placing strikes in it
   A strike starts only >= 2.5 s after the LAST START (kept in its own variable, never read from the slots,
   which are reused 1.2 s after a start) and >= 1 s after the last envelope ended. After that dead time a
   hazard accumulates at 1 / (1/rate - 2.5) a second, so the mean gap stays 1/rate. A forced strike starts
   at once (a lab tool) and counts as the last start.
   [r4] Lightning you can see within a minute (REVIEW-3 4: none in 100 s at 96 % by day). WX.STRIKES:
   - the wait after the dead time is an exponential CUT at needMax (2) means, its mean scaled up by
     1 / (1 - e^-2) so the rate is unchanged: no gap is longer than 2.5 s + 2.31 x the mean wait (60 s at
     92.5 %, the table's slowest rate, 2 a minute);
   - inView (0.8, was 0.7) of the strikes are in the view, and a strike after one outside it always is: an
     in-view strike comes at most two gaps apart, 83 % of strikes are in view;
   - the distance is W.strikeKm (the median, contract 1.3.2: 12 km at 92.5 % to 3 at the cap) x e^(+-spread)
     (0.75, was 0.6), so about one strike in six is within 0.6 x the median.
   Every draw is the seeded generator's, in the same order as before (a forced strike's channel is unchanged),
   and nothing accumulates: a renewal process, the same at any reading that sits flat (rule 1).
   [r4, 1.3.3] A strike the viewer could not have seen is followed by one they can. Missed: outside the view, or
   faint for its distance, P x (strikeKm / km)^1.2 under seeMin (0.4). How much a strike lifts the view by day goes
   with that score: at 93 % the lifts measured in real time (out/director/r4/pk) were 0.5 / 1.5 / 2.2 / 2.7 % at
   scores .09-.29 and 3.8 / 4.1 % at .53 / .82; REVIEW-3's "seen" is 3 %. The next strike is then in the view, its
   distance from the same draw over [-spread, 0] (at most the median) and its P over [seeMin, 1] from the same draw,
   so it scores at least seeMin: a seeable strike comes at most two gaps apart. The state is the last strike alone
   (a Markov step, not a count: rule 1). Simulated over 3 h a reading (tests/director/round4.test.mjs): a strike in
   view scoring >= seeMin comes in 97 % of the minutes at 92.5 % and 99 % at 93 % (longest wait 73 / 66 s), in every
   minute from 95 % (1.3.2: 67 / 76 / 77-95 %; the 93 % real-time run of 1.3.2 saw .76); 86-91 % of strikes are in
   view, the median distance of all strikes is ~0.8 x strikeKm, their median P .46-.50 (was .26) and 14-20 % of them
   P >= .8 (7-11 %).
   [r4, 1.3.3] And the wait after a missed strike is cut at missMax (1) mean instead of needMax (2), so the seeable
   strike that follows comes sooner: at 93 % the longest wait between seeable strikes was 2 x 38 s (an out-of-view
   strike after a full-length gap, measured 76.7 s in real time). needK rescales every wait so the rate is kept, for
   missQ (.42) of the waits following a miss (the share of missed strikes, .42-.43 at 92.5-100 %).
   [r4, 1.3.4] And a strike that ends a long quiet spell (over lateS, 22.5 s since the last strike started, or since the
   storm began) is placed as one after a miss: in the view, near and strong. A long quiet spell is when a viewer looks
   for the lightning; before, the strike that ended it was out of the view or faint one time in two, and the seeable one
   came a short wait later: at 93 % by day in real time (seed 5, HEAD 5a3b809) the longest wait between strikes seen
   was 65.6 s (43 s, then an out-of-view strike, then 23 s). Now a seeable strike comes within lateS + two dead times +
   one mean wait, or one full-length gap (45 s at 93 %, 47 s at 92.5 %, 36 s at 96 %). In seconds, not means: at
   97-100 % no gap is that long, so the cap's strikes are exactly 1.3.3's (a rule in means put twice as many strong
   strikes at 2-3 km there, and a strong CG's return strokes made two flashes in a second in a 10-degree field at night:
   psrun failed). The draws and their order are unchanged (a forced strike is never late), the state is still the last
   strike's (its start and whether it was missed: rule 1), and needK, from WX.strikeNeedK(base) at the current rate,
   keeps the rate with the late strikes (which are never missed) in the share of missed strikes. */
  WX.STRIKES = { needMax: 2, missMax: 1, missR: 0.724, lateS: 22.5, inView: 0.8, spread: 0.75, seeK: 1.2, seeMin: 0.4, lockOut: false };
  /* [r6] THE EXPOSURE LOCK (F.lockExposure) is held for a strike the view can see, not for every strike (REVIEW-5 #3, §6.1;
     A's log of clip f): a strike outside the view that also scores under seeMin (far or faint for its distance) lights
     nothing on screen, yet it held the exposure for its 0.77 s envelope and the 0.5 s after, while the scene went on
     changing under it (the build-up's +12-level swell over 93.6-95.6 %, released at 95.73 % as a one-frame step).
     Such a strike now leaves the exposure free; one in the view, or near and strong outside it (its glow reaches the
     view), locks as before. WX.STRIKES.lockOut = true (or the lab's p.core.lockAll=1) locks for every strike again.
     The draws and their order are unchanged. */
  /*@lab*/ WX.param("core.lockAll", 0, 0, 1, 1, "core"); /*@end*/
  /* The factor on the mean wait after the dead time (base = 1 / rate - gap, s) that keeps the rate: the waits are
     exponential draws cut at needMax means, or at missMax after a missed strike, and the missed strikes are a share m
     of all. A regular strike is missed with probability missR (.724, simulated: .42 of all strikes in 1.3.3), a strike
     after a miss never is, nor [1.3.4] one after a regular wait longer than lateS - gap s (probability e^-x, x that
     wait in means, while x < needMax). m = (1 - pl) missR / (1 + (1 - pl) missR); a fixed point in needK, 4 steps. */
  WX.strikeNeedK = function (base) {
    const SK = WX.STRIKES, eMiss = 1 - Math.exp(-SK.missMax), eReg = 1 - Math.exp(-SK.needMax);
    let k = 1.3;
    for (let i = 0; i < 4; i++) {
      const x = (SK.lateS - WX.FLASH.gap) / Math.max(1e-3, base * k);
      const pl = x < SK.needMax ? Math.exp(-x) : 0, q = (1 - pl) * SK.missR, m = q / (1 + q);
      k = 1 / (m * eMiss + (1 - m) * eReg);
    }
    return k;
  };
  WX.strikeScore = (P, km, W) => P * Math.pow(Math.max(2, W.strikeKm) / Math.max(0.5, km), WX.STRIKES.seeK);
  WX.lightning = function (rnd) {
    const FL = WX.FLASH;
    const L = { lastStart: -1e9, lastEnd: -1e9, lockEnd: -1e9, count: 0, hfov: 72 * RAD, miss: false };
    const SK = WX.STRIKES, uSee = Math.cbrt((SK.seeMin - 0.15) / 0.85);
    let kBase = NaN, needK = 1.3, quietFrom = NaN;       // [1.3.4] needK at the last rate; when the quiet spell began
    const draw = () => Math.min(SK.needMax, -Math.log(1 - rnd()));
    const strikes = [0, 1].map(() => ({ on: false, t0: 0, pos: [0, 1, 10], P: 0, kind: 0, seed: 0, n: 1, gaps: [0, 0, 0], lock: true }));
    let hazard = 0, need = draw(), nextSlot = 0;
    L.strike = function (scene, W, forced) {
      const s = strikes[nextSlot];
      nextSlot = (nextSlot + 1) % strikes.length;
      const must = L.miss || (!forced && scene - quietFrom > SK.lateS);   // [r4] after a missed strike or [1.3.4] a long quiet spell
      const u0 = rnd(), inView = rnd() < SK.inView || must;
      let az = inView ? (rnd() * 2 - 1) * 0.45 * L.hfov : (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.3) * L.hfov;
      const kr = rnd();                                  // [r4] a strike that must be seen: the near half, P over [seeMin, 1]
      let km = U.clamp(W.strikeKm * Math.exp(must ? SK.spread * (kr - 1) : (kr * 2 - 1) * SK.spread), 2, 30);
      const u = must ? uSee + (1 - uSee) * u0 : u0;     // [r4] P >= seeMin: with km <= the median, its score is >= seeMin
      let P = 0.15 + 0.85 * u * u * u;
      const kindU = rnd(), upU = rnd();
      if (forced) {
        if (typeof forced.az === "number") az = forced.az * RAD;
        if (typeof forced.km === "number") km = Math.max(0.5, forced.km);
        if (typeof forced.P === "number") P = U.clamp(forced.P, 0, 1);
      }
      /* [r4] outside the view, or faint for its distance: the next strike is in it, near and strong */
      const out = Math.abs(az) > 0.45 * L.hfov + 1e-9, faint = WX.strikeScore(P, km, W) < SK.seeMin;
      L.miss = out || faint;
      /* [r6] the exposure is held only for a strike the view can see (above) */
      let lockAll = SK.lockOut;
      /*@lab*/ lockAll = lockAll || !!(WX.params["core.lockAll"] && WX.params["core.lockAll"].v > 0); /*@end*/
      s.lock = lockAll || !(out && faint);
      s.on = true; s.t0 = scene; s.P = P; s.seed = rnd();
      s.kind = forced && (forced.kind === 0 || forced.kind === 1) ? forced.kind : kindU < W.cgShare ? 1 : 0;
      /* cloud-to-sea from 300 m above the base; in-cloud anywhere 0.3-3.3 km above it, inside the cloud */
      const up = s.kind ? W.base + 0.3 : W.base + 0.3 + upU * Math.max(0.2, Math.min(3, W.top - W.base - 0.5));
      s.pos[0] = Math.sin(az) * km; s.pos[1] = up; s.pos[2] = Math.cos(az) * km;
      /* the channel restrikes 0-2 times, 60-110 ms apart; the sky light does not (DESIGN 10.1) */
      s.n = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < 3; k++) s.gaps[k] = 0.06 + rnd() * 0.05;
      L.lastStart = scene; quietFrom = scene;
      L.count++;
      hazard = 0; need = L.miss ? Math.min(SK.missMax, draw()) : draw();   // [r4] the same draw, cut shorter after a miss
      return s;
    };
    L.step = function (scene, dt, W, rate, flashes, E, frozen) {
      if (!(rate > 0) || frozen) quietFrom = NaN;          // [1.3.4] no storm (or frozen): no quiet spell yet
      else if (quietFrom !== quietFrom) quietFrom = scene;
      if (rate > 0 && !frozen && scene - L.lastStart >= FL.gap && scene - L.lastEnd >= FL.rest) {
        /* after the dead time, a Poisson process whose mean gap keeps 1/rate overall */
        const base = Math.max(0.25, 1 / rate - FL.gap);
        if (base !== kBase) { kBase = base; needK = WX.strikeNeedK(base); }
        const mean = base * needK;
        hazard += dt / mean;
        if (hazard >= need) L.strike(scene, W, null);
      }
      let live = false;
      for (let k = 0; k < 2; k++) {
        const s = strikes[k], f = flashes[k];
        const a = scene - s.t0;
        if (!s.on || frozen || a > 1.2) {
          if (s.on && a > 1.2) s.on = false;
          f.I = 0; f.B = 0; f.age = 0; f.level = 0;
          continue;
        }
        f.pos = s.pos; f.kind = s.kind; f.seed = s.seed; f.age = a; f.P = s.P;
        const lv = WX.flashLevel(a);
        f.level = lv;
        f.I = WX.flashI(s.P, lv, E);
        let B = 0, t = 0;
        for (let r = 0; r < s.n; r++) { if (a >= t) B += Math.exp(-(a - t) / 0.03); t += s.gaps[r]; }
        f.B = B * s.P;
        if (a >= FL.end) {
          if (L.lastEnd < s.t0 + FL.end) L.lastEnd = s.t0 + FL.end;
          if (s.lock && L.lockEnd < s.t0 + FL.end) L.lockEnd = s.t0 + FL.end;   // [r6]
        } else if (s.lock) live = true;
      }
      return live || (scene - L.lockEnd < FL.lock && L.lockEnd > -1e8);
    };
    return L;
  };

  WX.director = function (opts) {
    const o = opts || {};
    const rnd = WX.rng(o.seed !== undefined ? o.seed : (Math.random() * 4294967296) >>> 0);
    const F = WX.frameDefaults();
    const K = WX.WALK;
    let scene = typeof o.t0 === "number" ? o.t0 : rnd() * 864000;     // float64 seconds
    let cuts = WX.cuts(null), goal = 0, misted = false;
    const walk = { v: 0, rate: 0, wet: 0, bolt: 0, mist: 0, soak: 0, puddle: 0 };   // [r7] rate: v' points/s
    let easeW = K.read;                                  // [r7] the ease's w for the present approach
    const easeS = new Float64Array(2);
    let Wkey = NaN, Wsoak = -1, Wpuddle = -1, Wmist = -1, Wbolt = -1, Wwet = -1, Wcuts = null;
    const drift = { weather: [0, 0], shape: [0, 0], cirrus: [0, 0], curl: [0, 0], sea: [0, 0] };   // float64
    for (const k in drift) { drift[k][0] = rnd() * 420; drift[k][1] = rnd() * 420; }
    drift.sea[0] = rnd() * 840; drift.sea[1] = rnd() * 840;

    /* still: a converged still (walkers at their ends); freeze: a converged frame of the weather as it
       is (the first frames after a build or a restore: the walk resumes where it was, nothing jumps) */
    const D = { seen: false, still: false, freeze: false, hold: false, F, walk, hfov: o.hfov || 72 * RAD };
    const windOut = WX.windAt(F.W, F.t);                 // [1.2] reused every frame

    /* ── the reading ── */
    /* rain and lightning follow the walked reading, not the goal: a walk across the floor starts the
       rain when the scene's own reading gets there */
    const tg = { v: 0, wet: 0, bolt: 0, mist: 0 };
    function targets() {
      tg.v = goal; tg.wet = walk.v >= cuts.warn ? 1 : 0; tg.bolt = walk.v >= cuts.s3 ? 1 : 0; tg.mist = misted ? 1 : 0;
      return tg;
    }
    function snap() {
      walk.v = goal; walk.rate = 0; easeW = K.read;
      const t = targets();
      walk.wet = t.wet; walk.bolt = t.bolt; walk.mist = t.mist;
      const W0 = WX.weatherAt(walk.v, cuts, { wet: walk.wet, bolt: walk.bolt, mist: walk.mist });
      walk.soak = WX.soakTarget(W0.precip); walk.puddle = WX.puddleTarget(W0.precip);
      Wkey = NaN;
    }
    D.reading = function (p, th, mist) {
      if (typeof p !== "number" || !isFinite(p)) {
        if (!D.seen) return false;                       // before any reading: nothing is claimed, no mist
        const was = misted; misted = !!mist;             // blank after a reading: the weather stays, mists
        return was !== misted;
      }
      const c = WX.cuts(th);
      const was = goal, wasMist = misted, wasCuts = cuts;
      cuts = c;
      goal = U.clamp(p, 0, c.cap);
      misted = !!mist;
      if (!D.seen) { D.seen = true; snap(); return true; }
      /* [r7] a new goal keeps the rate; heading to it faster than w x the distance, the approach stiffens to rate /
         distance (a pure exponential): no overshoot, no jump in the rate */
      if (goal !== was) {
        const e = goal - walk.v;
        easeW = e * walk.rate > 0 && Math.abs(walk.rate) > K.read * Math.abs(e) ? Math.abs(walk.rate / e) : K.read;
      }
      return goal !== was || misted !== wasMist || c.warn !== wasCuts.warn || c.cap !== wasCuts.cap || c.crit !== wasCuts.crit;
    };
    function stepWalkers(dt) {
      if (D.still) { snap(); return; }
      const t = targets();
      /* [r7] the reading eases (WX.WALK): critically damped, standing on its goal once within .005 points and .001
         points/s of it */
      if (walk.v !== t.v || walk.rate !== 0) {
        WX.easeStep(walk.v, walk.rate, t.v, easeW, dt, easeS);
        walk.v = easeS[0]; walk.rate = easeS[1];
        if (Math.abs(walk.v - t.v) < 0.005 && Math.abs(walk.rate) < 0.001) { walk.v = t.v; walk.rate = 0; easeW = K.read; }
      }
      walk.wet = toward(walk.wet, t.wet, dt / K.wet);
      walk.bolt = toward(walk.bolt, t.bolt, dt / K.bolt);
      walk.mist = toward(walk.mist, t.mist, dt / (t.mist > walk.mist ? K.mistIn : K.mistOut));
      /* the land: exponential, toward the targets of the rain as it is now */
      const rain = (walk.v >= cuts.warn ? Wrain(walk.v) : WX.ANCHORS.warn[5]) * walk.wet;
      const precip = Math.log10(1 + rain) / Math.log10(41);
      const ts = WX.soakTarget(precip), tp = WX.puddleTarget(precip);
      walk.soak += (ts - walk.soak) * (1 - Math.exp(-dt / (ts > walk.soak ? K.soakIn : K.soakOut)));
      walk.puddle += (tp - walk.puddle) * (1 - Math.exp(-dt / (tp > walk.puddle ? K.puddleIn : K.puddleOut)));
    }
    /* the table's rain at v, wet = 1: read from WX.weatherAt (never re-derived), cached by v */
    let rainV = NaN, rainOut = 0, rainCuts = null;
    function Wrain(v) {
      if (v !== rainV || cuts !== rainCuts) { rainV = v; rainCuts = cuts; rainOut = WX.weatherAt(v, cuts, { wet: 1, bolt: 0, mist: 0, soak: 0, puddle: 0 }).rain; }
      return rainOut;
    }
    /* W only when an input moved: a reading that sits flat costs nothing */
    function weather() {
      if (walk.v !== Wkey || walk.wet !== Wwet || walk.bolt !== Wbolt || walk.mist !== Wmist ||
          walk.soak !== Wsoak || walk.puddle !== Wpuddle || cuts !== Wcuts) {
        F.W = WX.weatherAt(walk.v, cuts, walk);
        Wkey = walk.v; Wwet = walk.wet; Wbolt = walk.bolt; Wmist = walk.mist; Wsoak = walk.soak; Wpuddle = walk.puddle; Wcuts = cuts;
      }
      return F.W;
    }

    /* ── the sky ── */
    let follow = o.follow !== false, lat = typeof o.lat === "number" ? o.lat : 38, lon = typeof o.lon === "number" ? o.lon : 0;
    const cur = { A: WX.skyAt(0, 0, 0), B: WX.skyAt(0, 0, 0) };   // two samples, A at At and B at At + 1000
    let At = NaN;
    const shown = { sun: [0, 0, 1], moon: [0, 0, 1], set: false };   // ENU, as last drawn
    const tmp = { sun: [0, 0, 0], moon: [0, 0, 0] };
    const eqTmp = new Float64Array(9);
    const FIX = WX.FIXED_SKY;
    const fixed = { sun: WX.dirOf(FIX.sunEl, FIX.sunRight), moon: WX.dirOf(FIX.moonEl, FIX.moonRight) };
    const fixedPhase = Math.acos(2 * FIX.lit - 1) / RAD;
    const fixedStar = new Float32Array(9);
    WX.eqToWorld(WX.eqAt(80, 38, eqTmp), WX.heading(38), fixedStar);
    let skyNow = 0;
    D.sky = function (f, place) {
      const nf = f !== false;
      let changed = nf !== follow;
      if (place && typeof place.lat === "number" && typeof place.lon === "number" && isFinite(place.lat) && isFinite(place.lon)) {
        if (place.lat !== lat || place.lon !== lon) { lat = place.lat; lon = place.lon; At = NaN; changed = changed || nf; }
      }
      if (nf !== follow) { follow = nf; At = NaN; shown.set = false; if (D.seen) D.dissolve(K.toggleFade); }
      return changed;
    };
    D.place = () => ({ lat, lon, follow });
    const ang = (a, b) => Math.acos(U.clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1)) / RAD;
    const lerpN = (a, b, f, out) => {
      const x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f, z = a[2] + (b[2] - a[2]) * f, n = Math.hypot(x, y, z) || 1;
      out[0] = x / n; out[1] = y / n; out[2] = z / n; return out;
    };
    const copy3 = (a, b) => { a[0] = b[0]; a[1] = b[1]; a[2] = b[2]; };
    /* the sun's and moon's directions now (ENU), one skyAt a second, interpolated between two samples */
    function sample(nowMs) {
      const base = Math.floor(nowMs / 1000) * 1000;
      if (base === At + 1000) {                          // the next second: B becomes A, A's storage the new B
        const r = cur.A;
        cur.A = cur.B;
        WX.skyAt(base + 1000, lat, lon, r);
        cur.B = r;
        At = base;
      } else if (base !== At) {                          // a start, a jump in time, a new place
        At = base;
        WX.skyAt(At, lat, lon, cur.A);
        WX.skyAt(At + 1000, lat, lon, cur.B);
      }
      const f = (nowMs - At) / 1000;
      lerpN(cur.A.sun, cur.B.sun, f, tmp.sun);
      lerpN(cur.A.moon, cur.B.moon, f, tmp.moon);
      return f;
    }
    D.sunENU = (nowMs) => { sample(nowMs); return tmp.sun; };
    /* true when the sky jumped (sleep, a returning tab, a clock step, a new place): this frame keeps
       the old sky as the snapshot, and the next ones dissolve to the new one over 2 s */
    function skyStep(nowMs) {
      skyNow = nowMs;
      if (!follow) {
        F.sun.dir = fixed.sun; F.moon.dir = fixed.moon;
        F.moon.lit = FIX.lit; F.moon.E = WX.moonE(fixedPhase); F.moon.radius = WX.moonRadius(384400);
        F.moon.earthshine = WX.moonEarthshine(FIX.lit); F.moon.phase = fixedPhase;
        F.star.set(fixedStar); F.lat = lat;
        return false;
      }
      const f = sample(nowMs);
      const jump = shown.set && D.seen && !D.still && (ang(tmp.sun, shown.sun) > K.jumpDeg || ang(tmp.moon, shown.moon) > K.jumpDeg);
      copy3(shown.sun, tmp.sun); copy3(shown.moon, tmp.moon);
      shown.set = true;
      if (jump) return true;
      applySky(f);
      return false;
    }
    const sunW = [0, 0, 1], moonW = [0, 0, 1];
    function applySky(f) {
      const H = WX.heading(lat), a = cur.A, b = cur.B;
      F.sun.dir = WX.toWorld(shown.sun, H, sunW);
      F.moon.dir = WX.toWorld(shown.moon, H, moonW);
      const lit = a.lit + (b.lit - a.lit) * f, dist = a.dist + (b.dist - a.dist) * f, ph = a.phase + (b.phase - a.phase) * f;
      F.moon.lit = lit;
      F.moon.E = WX.moonE(ph) * (384400 / dist) * (384400 / dist);
      F.moon.radius = WX.moonRadius(dist);
      F.moon.earthshine = WX.moonEarthshine(lit);
      F.moon.phase = ph; F.moon.waxing = a.waxing;
      /* the stars, every frame from the sidereal time: they turn smoothly, 1 px in about 6 s */
      WX.eqToWorld(WX.eqAt(WX.lstAt(skyNow, lon), lat, eqTmp), H, F.star);
      F.lat = lat;
    }

    /* ── lightning: the shared scheduler ([1.2] WX.lightning) ── */
    const LT = WX.lightning(rnd);
    LT.hfov = D.hfov;
    let expo = 0;                                       // the exposure last given to D.frame (0: none yet, I unnormalised)
    Object.defineProperty(D, "strikes", { get: () => LT.count });
    D.view = (h) => { if (h > 0) { D.hfov = h; LT.hfov = h; } };
    /* LAB ONLY in effect (the API's strike= and the lab): a strike now, { az, km, P, kind } each optional */
    /*@lab*/ D.force = function (opt) { if (D.seen) LT.strike(scene, F.W, opt || {}); }; /*@end*/
    function lightning(dt, W) {
      const frozen = D.still || D.freeze;
      F.lockExposure = LT.step(scene, dt, W, frozen ? 0 : W.flashRate, F.flashes, expo, frozen);
    }
    D.lastEnd = () => LT.lastEnd;

    /* ── dissolves ── */
    let dPending = false, dAge = 0, dDur = 0;
    D.dissolve = function (s) { dPending = true; dDur = s || K.stillFade; dAge = 0; };
    D.dissolving = () => dPending || (dDur > 0 && dAge < dDur);

    /* ── one frame ── */
    D.frame = function (nowMs, dt, E) {
      dt = U.clamp(dt || 0, 0, 0.1);
      if (E > 0) expo = E;
      const fixedFrame = D.still || D.freeze;
      F.dt = fixedFrame ? 0 : dt;
      F.still = fixedFrame;
      F.snapshot = false;
      if (dPending) {                                    // this frame shows the old picture, kept as the snapshot
        dPending = false; dAge = 0;
        F.snapshot = true; F.dissolve = 1; F.dt = 0;
        return F;
      }
      if (!fixedFrame) scene += dt;
      if (!D.freeze || D.still) stepWalkers(dt);
      const W = weather();
      F.t.ocean = wrap(scene, WX.PERIOD.ocean); F.t.rain = wrap(scene, WX.PERIOD.rain);
      F.t.twinkle = wrap(scene, WX.PERIOD.twinkle); F.t.slow = wrap(scene, WX.PERIOD.slow);
      /* [1.2] the wind loops on the wrapped clocks (contract WX.windAt), filled in place: no allocation */
      const wn = (F.wind = WX.windAt(W, F.t, windOut));
      if (!fixedFrame) {
        const sp = wn.aloft.speed * dt / 1000, ax = wn.aloft.dir[0] * sp, az = wn.aloft.dir[1] * sp;
        const DK = WX.DRIFT_K, P = WX.PERIOD.driftKm;
        drift.weather[0] = wrap(drift.weather[0] + ax * DK.weather, P); drift.weather[1] = wrap(drift.weather[1] + az * DK.weather, P);
        drift.shape[0] = wrap(drift.shape[0] + ax * DK.shape, P); drift.shape[1] = wrap(drift.shape[1] + az * DK.shape, P);
        drift.cirrus[0] = wrap(drift.cirrus[0] + ax * DK.cirrus, P); drift.cirrus[1] = wrap(drift.cirrus[1] + az * DK.cirrus, P);
        drift.curl[0] = wrap(drift.curl[0] + ax * DK.curl, P); drift.curl[1] = wrap(drift.curl[1] + az * DK.curl, P);
        const ss = 0.03 * wn.wind.U10 * dt;
        drift.sea[0] = wrap(drift.sea[0] + wn.wind.dir[0] * ss, WX.PERIOD.seaM);
        drift.sea[1] = wrap(drift.sea[1] + wn.wind.dir[1] * ss, WX.PERIOD.seaM);
      }
      for (const k in drift) { F.drift[k][0] = drift[k][0]; F.drift[k][1] = drift[k][1]; }
      if (skyStep(nowMs)) {                              // a jump: keep last frame's sky, dissolve to the new one
        D.dissolve(K.jumpFade);
        dPending = false; F.snapshot = true; F.dissolve = 1;
        return F;
      }
      lightning(F.dt, W);
      if (dDur > 0) {
        if (!D.hold) dAge += dt;
        F.dissolve = U.clamp(dAge / dDur, 0, 1);
        if (dAge >= dDur) { dDur = 0; F.dissolve = 1; }
      } else F.dissolve = 1;
      return F;
    };
    D.scene = () => scene;
    D.setScene = (s) => { scene = s; };
    D.cuts = () => cuts;
    D.goal = () => goal;
    D.misted = () => misted;
    D.target = targets;
    return D;
  };

  /* ── pacing (DESIGN 6.3): the display rate and the frame cap ── */
  /* [r6] Two faults at refresh rates other than 60 Hz (the user's 75 Hz monitor and 240 Hz panel):
     - k = ceil(hz / 75) read a 75 Hz display as 2 whenever its measured rate came out a hair over 75: 1000 / 13.333 is
       75.00000x in floats, Chrome's rAF times step 0.1 ms (13.3, 13.3, 13.4: median 13.3, 75.19 Hz) and Firefox's
       wander +-0.3 ms. The view then drew at 37.5 fps (Chrome: the world at 18.75 Hz on T0-T1), or flipped between
       75 and 37.5 fps every 30 frames (Firefox, the floats). k now allows the measure 10 % of a step: 75.19 -> 1.
     - It drew on every k-th callback, so one vsync the browser skipped (a busy frame) moved every later draw by a
       display interval (at 240 Hz the 60 fps cadence then ran 16.7, 20.8, 16.7 ... ms, a different phase each time).
       It now draws on a grid of k display intervals by the callbacks' times: a callback within half an interval of
       the grid's next point draws and sets the next point a period after itself; one later than that (a skipped
       vsync) keeps the grid (one long frame, one short) unless it fell a whole period behind. */
  /* [r7] The Frame rate setting (P.cap): "auto" is DESIGN 6.3's cap as above (75 fps, 37.5 unfocused, Low halves it);
     30, 60 or 120 draw that many frames a second on average, and "display" every refresh; both halve when the window is
     unfocused, and Quality does not change them. A rate that divides the display's (60 on a 240 Hz panel: every 4th
     vsync) uses the grid below. One that does not (60 on a 75 Hz monitor: 1.25 vsyncs a frame) draws on a grid of the
     chosen period in time, kept from draw to draw (not restarted at each, which would draw every vsync): a callback
     within half a vsync of the grid's next point draws, so 75 Hz at 60 draws 4 vsyncs of every 5 and the long-run rate is
     the chosen one however the browser spaces its callbacks (Firefox under load: ~15 ms apart on a 75 Hz display,
     which counting vsyncs read as one each, 55 fps for 60); a stall of two periods starts the grid again. */
  WX.pacer = function () {
    const iv = new Float64Array(30), sorted = new Float64Array(30);
    let n = 0, at = 0, last = 0, lastDraw = 0, due = 0;
    const P = { hz: 60, hzFine: 0, k: 1, focused: true, low: false, cap: "auto" };
    P.reset = () => { n = 0; at = 0; last = 0; };
    P.measure = function () {
      const m = Math.min(n, 30);
      if (m < 8) return P.hz;
      for (let i = 0; i < m; i++) sorted[i] = iv[i];
      const s = sorted.subarray(0, m).sort();
      const med = s[m >> 1];
      if (med > 2 && med < 200) P.hz = 1000 / med;
      /* [r7] the mean of the intervals near the median: the median of times stepped 0.1 ms (Chrome) or 1 ms (Firefox)
         is off by up to a step (240 Hz read as 250), which a chosen rate's share would carry into its frame rate */
      let sum = 0, cnt = 0;
      for (let i = 0; i < m; i++) if (s[i] >= 0.7 * med && s[i] <= 1.3 * med) { sum += s[i]; cnt++; }
      if (cnt && med > 2 && med < 200) P.hzFine = (1000 * cnt) / sum;
      return P.hz;
    };
    /* the frame cap's divisor (DESIGN 6.3): 60 -> 1, 75 -> 1, 120 -> 2, 144 -> 2, 165 -> 3, 240 -> 4 (focused) */
    P.divisor = (hz, cap) => Math.max(1, Math.ceil(hz / cap - 0.1));
    /* [r7] vsyncs a drawn frame takes: a whole number on the grid, or a fraction (counted) */
    P.share = function (hz) {
      if (P.cap === "auto") return P.divisor(hz, P.focused ? 75 : 37.5) * (P.low ? 2 : 1);
      const fps = (P.cap === "display" ? hz : Math.min(hz, P.cap)) / (P.focused ? 1 : 2);
      const r = hz / fps, k = Math.round(r);
      return Math.abs(r - k) <= 0.1 ? Math.max(1, k) : r;      // within a tenth of a vsync, as the divisor allows
    };
    /* called on every rAF; true when this one draws. dt is the real time since the last draw */
    P.tick = function (ts) {
      const gap = last ? ts - last : 0;
      if (last) { iv[at] = gap; at = (at + 1) % 30; n++; }
      last = ts;
      if (n > 0 && n % 30 === 0) P.measure();
      const hz = P.cap === "auto" ? P.hz : P.hzFine || P.hz;
      const k = P.share(hz);
      /* a fractional share's period is the chosen rate's whatever the measure: a re-measured rate (75.19 Hz, then 74.9)
         keeps its grid */
      if (k !== P.k) { if (!(k % 1 && P.k % 1)) due = 0; P.k = k; }
      const step = 1000 / hz, period = k * step;
      if (k % 1) {
        if (due && ts < due - 0.5 * step) return false;
        due = !due || ts - due > 2 * period ? ts + period : due + period;   // a skipped vsync is caught up, a stall is not
        P.dt = lastDraw ? Math.min((ts - lastDraw) / 1000, 0.1) : 1 / 60;
        lastDraw = ts;
        return true;
      }
      if (due && ts < due - 0.5 * step) return false;
      /* on time: the grid's next point from this callback (the measured rate's error never accumulates); late by
         a skipped vsync or more, but within the period: from the point it missed */
      const late = due ? ts - due : 0;
      due = late > 0.5 * step && late < period ? due + period : ts + period;
      P.dt = lastDraw ? Math.min((ts - lastDraw) / 1000, 0.1) : 1 / 60;
      lastDraw = ts;
      return true;
    };
    P.rebase = () => { lastDraw = 0; last = 0; due = 0; };
    return P;
  };

  /* ── the governor (DESIGN 6.2, robust.md 2.6) ── */
  WX.TIER_MEMORY = "ccquota.wx";
  WX.governor = function (o) {
    const B = WX.BUDGET_MS, N = 512;
    const ms = new Float64Array(N), at = new Float64Array(N), bl = new Uint8Array(N), fl = new Uint8Array(N);
    const pat = new Float64Array(N), plate = new Uint8Array(N);       // pacing: when, and whether the frame came late
    const tmp = new Float64Array(N);
    let head = 0, count = 0, phead = 0, pcount = 0;
    /* cost[t]: what tier t cost when the governor left it for being over; ref[t]: what tier t cost in
       its first quiet window after that. A step back up is allowed when cost[t+1] scaled by how much
       cheaper tier t has become since (avg / ref[t]) is under 0.9 B ([1.3.1]; B before): a slowdown that has
       passed (another application on the GPU, a thermal limit) does not pin the tier down for the session. */
    const G = { tier: o.tier, timer: !!o.timer, max: o.timer ? 4 : 3, cost: [NaN, NaN, NaN, NaN, NaN], ref: [NaN, NaN, NaN, NaN, NaN], tooSlow: false,
                lastChange: -1e9, quiet: 0, settledFrom: 0, lastEval: 0, lowSince: -1, hiSince: -1, emerSince: -1, zeroSince: -1, pinUntil: 0, spiky: 0,
                upAt: -1e9, saved: false, avg: 0, avgClear: 0, avg6: 0, avg30: 0, p95: 0, frac: 0, log: [],
                costAt: [-1e12, -1e12, -1e12, -1e12, -1e12], pins: 0 };
    /* 3 s after a tier change or a resize; 10 s after a build or a restore, while the cove streams its
       textures in and programs finish compiling, whose stalls are not the GPU's steady cost */
    G.notice = (now, settle) => { G.quiet = Math.max(G.quiet, now + (settle ? 10000 : 3000)); };
    /* [E] the frame's pacing: late when it came more than 1.25 frame caps after the one before. A GPU
       timer alone misleads on a lightly loaded GPU: it idles at low clocks and waits on the CPU, and
       TIME_ELAPSED then reads that wall time (Arrow Lake measured 7.6 ms at T0 on the stub passes,
       4.1 ms at T0 with every pass live). [1.3.1] Much of that was the query spanning the wait for the next
       frame, which the end-of-frame flush removed (CHANGES-3 9): GPU time over the budget now steps down when
       it holds for 4 s, late frames make it at once; clean pacing for 30 s may step up when the next tier is
       expected to fit (DESIGN 6.2's rule without a timer). */
    G.pace = function (now, late) {
      pat[phead] = now; plate[phead] = late ? 1 : 0;
      phead = (phead + 1) % N; pcount = Math.min(pcount + 1, N);
    };
    /* [r4] flash: the frame was drawn while a strike's light or channel was on. Those frames are left out of the
       window's p95 (not its mean): a strike is a sub-second transient that the storm repeats every 7-25 s, so at
       96-100 % a 2 s window's p95 was the strike frames' cost, and a strike across two windows stepped the tier
       down (Intel T1 -> T0 in a 96 % storm, notes/director.md "Round 4"). [r5] The deciding mean leaves them out
       too; the 30 s mean, the late frames and the emergency rule still see them. A window with fewer than half its
       frames clear of a flash keeps them all. */
    G.sample = function (now, gpuMs, backlogged, flash) {
      ms[head] = gpuMs === null ? NaN : gpuMs; at[head] = now; bl[head] = backlogged ? 1 : 0; fl[head] = flash && !o.flashP95 ? 1 : 0;
      head = (head + 1) % N; count = Math.min(count + 1, N);
    };
    /* [r5] the last 15 windows' sums (30 s) at this tier, flash frames included: the long run a storm's strikes add to */
    const lrS = new Float64Array(15), lrN = new Float64Array(15);
    let lrHead = 0, lrCount = 0;
    /* [r5b] the deciding mean's last windows at this tier (sum, frames of the frames it counts): the mean decides over
       MW windows (6 s), not one. On Intel the iGPU's clock (i915 SLPC) follows the load and dips for 2-4 s at a time
       (1870 -> 900 MHz at T1 in a storm), and the desktop terminal's GPU runs come in bursts: a single 2 s window's
       mean then swings 4.7-7.4 ms around a T1 mean of 5.7, and two dips in a row stepped T1 down (notes/director.md
       "Round 5", 5). A sustained excess still shows at once (a constant mean decides as before). */
    const MW = Math.max(1, o.meanWindows || 3), mwS = new Float64Array(MW), mwN = new Float64Array(MW);
    let mwHead = 0, mwCount = 0;
    function window2s(now) {
      let m = 0, s = 0, b = 0, nb = 0, mc = 0, sc = 0;
      for (let i = 0; i < count; i++) {
        const k = (head - 1 - i + N) % N;
        if (now - at[k] > 2000) break;
        if (at[k] < G.settledFrom) break;                 // nothing from before the quiet period ended
        nb++; if (bl[k]) b++;
        if (ms[k] === ms[k]) { s += ms[k]; m++; if (!fl[k]) { tmp[mc++] = ms[k]; sc += ms[k]; } }
      }
      G.n = m;
      G.avg = m ? s / m : 0;
      G.flashFrac = m ? 1 - mc / m : 0;                   // [r4]
      G.avgClear = mc >= m / 2 && mc > 0 ? sc / mc : G.avg;   // [r5] the mean of the frames clear of a strike
      if (m) {                                            // [r5b] the deciding mean over the last MW windows
        const clear = mc >= m / 2 && mc > 0;
        mwS[mwHead] = clear ? sc : s; mwN[mwHead] = clear ? mc : m; mwHead = (mwHead + 1) % MW; mwCount = Math.min(mwCount + 1, MW);
      }
      let ws = 0, wn = 0;
      for (let i = 0; i < mwCount; i++) { ws += mwS[i]; wn += mwN[i]; }
      G.avg6 = wn ? ws / wn : G.avgClear;
      if (m) { lrS[lrHead] = s; lrN[lrHead] = m; lrHead = (lrHead + 1) % 15; lrCount = Math.min(lrCount + 1, 15); }
      let ls = 0, ln = 0;
      for (let i = 0; i < lrCount; i++) { ls += lrS[i]; ln += lrN[i]; }
      G.avg30 = lrCount >= 5 && ln ? ls / ln : 0;        // [r5] none until 10 s of windows
      if (mc < m / 2) {                                   // [r4] mostly flash: all frames count
        mc = 0;
        for (let i = 0; i < count && mc < m; i++) { const k = (head - 1 - i + N) % N; if (ms[k] === ms[k]) tmp[mc++] = ms[k]; }
      }
      if (mc) { const t = tmp.subarray(0, mc).sort(); G.p95 = t[Math.min(mc - 1, Math.floor(mc * 0.95))]; } else G.p95 = 0;
      G.frac = nb ? b / nb : 0;
      let np = 0, nl = 0;
      for (let i = 0; i < pcount; i++) {
        const k = (phead - 1 - i + N) % N;
        if (now - pat[k] > 2000 || pat[k] < G.settledFrom) break;
        np++; if (plate[k]) nl++;
      }
      G.np = np; G.late = np ? nl / np : 0;
      return m || nb;
    }
    function change(now, t, why) {
      const from = G.tier;
      G.tier = Math.max(0, Math.min(G.max, t));
      G.lastChange = now; G.quiet = now + 3000; G.lowSince = -1; G.hiSince = -1; G.zeroSince = -1; G.saved = false; G.spiky = 0;
      lrCount = 0; lrHead = 0;                           // [r5] the long run is this tier's
      mwCount = 0; mwHead = 0;                           // [r5b] so is the deciding mean
      if (G.tier < from) G.ref[G.tier] = NaN;          // entering from above: a new baseline for the scaling
      count = 0;
      G.log.push({ at: now, from, to: G.tier, why });
      if (G.log.length > 32) G.log.shift();
      return G.tier;
    }
    /* every frame; acts every 2 s. Returns the new tier when it changes, else -1 */
    G.evaluate = function (now, focused, moving) {
      if (now - G.lastEval < 2000) return -1;
      G.lastEval = now;
      if (!window2s(now)) return -1;
      if (o.pinned || G.tooSlow) return -1;             // pinned: the statistics are kept, nothing changes
      const timer = G.timer && G.n > 0;
      const over = timer ? G.avg > 2 * B : G.frac > 0.5;
      if (!focused) {                                     // frozen, except an emergency step down
        if (over) { if (G.emerSince < 0) G.emerSince = now; if (now - G.emerSince >= 4000 && G.tier > 0) { G.emerSince = -1; return change(now, G.tier - 1, "emergency"); } }
        else G.emerSince = -1;
        return -1;
      }
      if (!moving || now < G.quiet) { G.settledFrom = G.quiet; return -1; }
      /* [1.3.1] this tier's reference cost is its first quiet window, also at T0 under an overload: a slowdown
         that drove the tiers down and then passed makes T0 cheaper than its reference, which lets the tiers
         above be tried again (their cost scaled by that ratio) */
      if (timer && !(G.ref[G.tier] > 0)) G.ref[G.tier] = G.avg;
      if (G.tier === 0 && over) {
        if (G.hiSince < 0) G.hiSince = now;
        if (now - G.hiSince >= 10000) { G.tooSlow = true; G.log.push({ at: now, why: "too slow" }); }
        return -1;
      }
      G.hiSince = -1;
      if (timer) {
        /* [1.3.1] The budget is the GPU's, not the display's: since the frame is flushed at its end (CHANGES-3 9)
           the query reads the frame's own work, not the idle wait for the next one, so a mean over 1.15 B or a
           p95 over 2 B steps down when it holds for two windows (4 s), even with every frame on time (round 3:
           Intel held T2 at a 9.3 ms mean and a 16 ms p95 because its frames were punctual). One stall, or one
           spiky window, is not a slow GPU. Late frames with the mean over 1.15 B, or a mean over 2 B, step down
           at once. G.spiky counts the consecutive over-budget windows. */
        /* [r5] The mean that decides is the mean of the frames clear of a strike (as the p95 since round 4): a strike's
           0.8 s of dearer frames (the sky's flash taps, the halo) put two windows over 1.15 B when two strikes came
           close (Intel T1 at 96 %: windows 6.5 and 8.0 ms round strikes 2.6 s apart, then T0; the clear frames 5.0-5.5).
           What the strikes cost in the long run still counts: the 30 s mean with every frame (G.avg30) over 1.15 B
           is over too. The emergency rule (2 B) keeps every frame. p.core.govflash=0 (lab): the round-3 rule.
           [r5b] A mild excess (1.15-1.4 B) must hold in the clear mean over the last three windows (G.avg6, 6 s; MW
           above): a 2-4 s dip of the iGPU's clock or a burst of another client's GPU work is not a slow GPU. A window
           over 1.4 B (a GPU that got slow, not one that dipped) decides by itself as before: two in a row step down
           within 4 s. One window over 2 B, or late frames over 1.15 B, still step down at once. */
        const mean = o.flashP95 ? G.avg : G.avgClear;
        const meanOver = o.flashP95 ? mean > 1.15 * B : mean > 1.4 * B || G.avg6 > 1.15 * B;
        const overB = meanOver || G.p95 > 2 * B || G.avg30 > 1.15 * B;
        G.spiky = overB ? G.spiky + 1 : 0;
        const missing = G.np > 0 ? G.late > 0.1 : true;   // no pacing fed (tests): trust the timer alone
        if ((mean > 1.15 * B && missing || G.spiky >= 2 || G.avg > 2 * B) && G.tier > 0) {
          /* a step up that hurt (down again within a minute): back, and stay 10 min, then 20, 40, 80, 160 */
          if (now - G.upAt < 60000) { G.pinUntil = now + 600000 * Math.pow(2, Math.min(G.pins, 4)); G.pins++; }
          /* what this tier cost, by the measure that was over: the mean, or half the p95 (the p95's bound is 2 B) */
          G.cost[G.tier] = Math.max(G.avg, G.p95 / 2); G.costAt[G.tier] = now;
          if (!(G.ref[G.tier] > 0)) G.ref[G.tier] = G.avg;   // left before its quiet window: this is its cost then
          return change(now, G.tier - 1, "over");
        }
        if (!(G.ref[G.tier] > 0)) G.ref[G.tier] = G.avg;
        /* the hysteresis: for 10 min after a tier was left for being over, it is entered again only when its cost,
           scaled by how much cheaper this tier has become since (the weather, another application leaving the
           GPU), is under 0.9 B: 22 % under the step-down's 1.15 B. After that it may be tried again (an overload
           that has passed must not pin the tiers down for the session), and a try that hurts pins this tier for
           10 min, doubling each time: a GPU that sits between two tiers tries the upper one ever more rarely */
        const nextCost = now - G.costAt[G.tier + 1] < 600000 ? G.cost[G.tier + 1] * Math.min(1, G.avg / G.ref[G.tier]) : NaN;
        const fits = !(nextCost >= 0.9 * B);               // not measured lately (NaN): try it
        /* [r7] an idle GPU (a quarter of the budget for 30 s) may try the tier above whatever its remembered cost: when a
           slowdown ended just as the tiers reached this one, this tier's reference was taken after it, the scaling saw
           no change, and the tier above stayed shut for the 10 min of its memory (api.cjs slow on the RTX: T0 at
           0.2 ms for 2 min). Tiers cost 1.5-2x the one below, never 4.6x; a try that hurts still steps back and pins */
        const idle = G.avg < 0.25 * B && G.lowSince > 0 && now - G.lowSince >= 30000;
        if (G.avg < 0.55 * B) {
          if (G.lowSince < 0) G.lowSince = now;
          if (now - G.lowSince >= 10000 && now - G.lastChange >= 30000 && G.tier < G.max && (fits || idle) && now >= G.pinUntil) {
            G.upAt = now; return change(now, G.tier + 1, "under");
          }
        } else G.lowSince = -1;
        /* clean pacing for 30 s and 60 s since the last change, this tier within the budget and the next one
           expected to fit: up, as without a timer. A step up that hurts still steps back and pins. */
        if (G.np > 0 && G.late <= 0.03 && G.avg <= B && !overB && fits) {   // a stray late frame is jitter
          if (G.zeroSince < 0) G.zeroSince = now;
          if (now - G.zeroSince >= 30000 && now - G.lastChange >= 60000 && G.tier < G.max && now >= G.pinUntil) {
            G.upAt = now; return change(now, G.tier + 1, "clean");
          }
        } else G.zeroSince = -1;
      } else {
        if (G.frac > 0.10 && G.tier > 0) {
          if (now - G.upAt < 10000) G.pinUntil = now + 600000;
          return change(now, G.tier - 1, "backlog");
        }
        if (G.frac === 0) {
          if (G.zeroSince < 0) G.zeroSince = now;
          if (now - G.zeroSince >= 30000 && now - G.lastChange >= 60000 && G.tier < G.max && now >= G.pinUntil) {
            G.upAt = now; return change(now, G.tier + 1, "clear");
          }
        } else G.zeroSince = -1;
      }
      return -1;
    };
    /* the settled tier, remembered for this renderer and size bucket (30 days); a convenience only */
    G.settle = function (now, renderer, mp) {
      if (G.saved || o.pinned || now - G.lastChange < 60000) return false;
      G.saved = true;
      try { localStorage.setItem(WX.TIER_MEMORY, JSON.stringify({ r: renderer, s: Math.ceil(mp), t: G.tier, at: Date.now() })); } catch (_) { return false; }
      return true;
    };
    return G;
  };
  WX.tierMemory = function (renderer, mp) {
    try {
      const m = JSON.parse(localStorage.getItem(WX.TIER_MEMORY) || "null");
      if (m && m.r === renderer && m.s === Math.ceil(mp) && Date.now() - m.at < 30 * 864e5 && m.t >= 0 && m.t <= 4) return m.t | 0;
    } catch (_) { /* storage blocked or malformed: start from the renderer string */ }
    return -1;
  };
  WX.startTier = function (renderer, cssW, dpr, mp) {
    const m = WX.tierMemory(renderer, mp);
    if (m >= 0) return m;
    if (/NVIDIA|GeForce|RTX|Quadro|Radeon (RX|Pro)|Arc [AB]\d|Apple M\d (Pro|Max|Ultra)/i.test(renderer)) return 3;
    if (cssW < 900 && dpr >= 2.5) return 0;
    return 2;
  };
})();
