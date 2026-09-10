import { EventEmitter } from 'node:events';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { accountKey } from './credentials.js';
import { getQuota, emptyQuota, secondsUntil, THRESHOLDS } from './usage.js';

// MEASURED, not guessed. At 60s this endpoint answered exactly 5 polls and refused the
// 6th, 47 times in a row, then needed ~6 minutes of silence to recover — a sustained
// ceiling near 0.83 req/min, so 60s sat just the wrong side of it and lost a poll every
// ten minutes. 120s is 0.5 req/min, comfortably under, and costs nothing: `utilization`
// is an integer percent, and one point of a 5-hour window is minutes of real work, so the
// extra minute of latency is almost always the same payload twice. Claude Code itself
// won't re-persist this data more than once every 5 minutes.
export const BASE_INTERVAL_MS = Number(process.env.CCQUOTA_INTERVAL_MS) || 120_000;
const JITTER = 0.1;
// Full-jitter exponential backoff, decorrelated so restarts do not retry in lockstep.
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];
// Hard floor between upstream requests, whatever schedules them — shared across processes,
// and what keeps a low full-jitter draw from turning a backoff into a hot loop. Derived from
// the interval rather than fixed, so tuning one cannot silently leave the other permissive
// enough for two pollers to sum back over the measured ceiling.
const MIN_REQUEST_GAP_MS = Math.round(BASE_INTERVAL_MS / 2);
// A lock is held only for the microseconds a claim takes, so anything this old is debris
// from a killed process rather than a peer mid-claim.
const SLOT_LOCK_STALE_MS = 5_000;
const RATE_LIMIT_BACKOFF_MS = 300_000;
// The edge answers 429 with `retry-after: 3600` even for a credential it simply refused to
// evaluate. Honour the header, but not blindly — an hour-long blank dashboard is worse than
// a stale badge and one wasted request.
const RATE_LIMIT_MAX_MS = 900_000;

// 12 hours at the base interval — the span the sparkline draws.
export const HISTORY_CAPACITY = 360;
const HISTORY_KEYS = ['session', 'weekly', 'fable'];
const HOUR_MS = 3_600_000;

// How long a silence may be and still count as one contiguous series. The capacity cap
// bounds the sample COUNT, not their age, so without this a fit can span a process-off gap,
// and a window that reset unseen inside that gap gets fitted together with the one before it
// as a single trend — the downward-step rule cannot see such a reset when the new window's
// first reading is already above the old window's last.
//
// Six intervals (6 minutes at the base rate) is the smallest value that does not fight the
// retry policy: BACKOFF_MS tops out at 300s, so anything tighter would shred the series
// after every transient network blip and no weekly trend would ever accumulate. A rate-limit
// backoff (300-900s) does break it, which is the right call — that is a real outage, and a
// blind spot that long deserves a fresh start.
const GAP_INTERVALS = 6;

// Fit honesty gates — see evidenceOf() for the reasoning behind the values. They govern
// both numbers derived from a fit: the rate and the projection built on it.
const MIN_SAMPLES = 3;
const MIN_SPAN_FRACTION = 1 / 48;
const MIN_DELTA_PERCENT = 2;
// The evidence gate takes time AND steps, whichever binds harder. Time alone confirms a
// slow burn on too few observations; steps alone confirm a brief flurry. For a series that
// only rises this equals a stricter delta gate, but it is counted as transitions so it
// stays meaningful if the data ever stops being monotonic.
const MIN_GATE_STEPS = 6;

// How much better two lines must fit than one before the split counts as a change of pace
// rather than noise. Two lines can never fit worse, so without a bar every series would
// "change regime" somewhere. 0.20 is deliberately eager: the point of the fit is the rate
// you are burning at NOW, so it should follow a spree rather than average it away. The
// evidence gates are what stop an eager split from being published as fact.
const REGIME_GAIN = 0.20;
// Segments are measured in integer STEPS, not samples. The series is a staircase — an
// integer percent on a slow window sits flat between steps — and a tread is flat while the
// trend is sloped, so splitting at any tread boundary improves the fit. With a 16-minute
// minimum against a 20-minute median tread, the detector carved "regimes" out of single
// stairs and reported 0.00 %/hr mid-climb. Requiring real steps on both sides makes the
// answer stop depending on the knob: 2, 3, 4 steps all land within 0.05 %/hr of each other.
const MIN_REGIME_STEPS = 4;
// A working day realistically holds a handful of breaks; the cap is a runaway guard, not a
// limit anyone should reach.
const MAX_REGIME_DEPTH = 6;
// How many typical treads of silence mean you have stopped rather than slowed. A stop
// produces no steps at all, so the step-space search structurally cannot find it — the
// boundary is the event that never came. Detected directly instead; without this the fit
// keeps reporting the burn that has just ended, which is the failure mode this whole
// projection exists to avoid.
const STALL_TREADS = 3;

// `lastError` is served verbatim to the browser by /api/quota and /api/stream, and the
// internal messages name the credentials file — which leaks the OS username and home
// layout. Only these generic strings go over HTTP; the detailed Error still reaches the
// CLI and stderr through the 'error' event.
const PUBLIC_MESSAGES = {
  ENOCREDS: 'Credentials file is missing or unreadable.',
  EBADCREDS: 'Credentials file is malformed or has no access token.',
  EAUTH: 'Access token was rejected. Run any Claude Code command to refresh it.',
  ERATE: 'Usage endpoint is rate limited.',
  ENET: 'Cannot reach api.anthropic.com.',
  EAPI: 'Usage endpoint returned an unexpected response.',
  EUNKNOWN: 'Poll failed.',
};

export class QuotaPoller extends EventEmitter {
  constructor({ intervalMs = BASE_INTERVAL_MS, capacity = HISTORY_CAPACITY } = {}) {
    super();
    // 'error' with no listener throws; a poller must never take the process down.
    this.on('error', () => {});
    this.setMaxListeners(0); // every SSE client attaches two listeners
    this.intervalMs = intervalMs;
    this.capacity = capacity;
    this.last = null;
    // "Never polled yet" and "polled, then went stale" are different states with different
    // words in the UI, and before the first poll there is no other instant to age against.
    this.bootedAt = new Date().toISOString();
    this.staleSince = null;
    this.lastError = null;
    this.timer = null;
    this.running = false;
    this.inFlight = false;
    this.lastRequestAt = 0;
    // Cached data is per-account. The request floor deliberately is not: it protects the
    // endpoint from this machine, and a switch does not make a burst acceptable.
    this.account = accountKey();
    this.historyPath = historyPath(this.account);
    this.slotPath = join(dirname(this.historyPath), 'last-request');
    this.slotLock = `${this.slotPath}.lock`;
    this.penaltyPath = join(dirname(this.historyPath), `backoff-${this.account}.json`);
    // The slot lock needs its directory to exist before the first claim, or every claim
    // fails open and the cross-process floor silently never engages.
    try { mkdirSync(dirname(this.slotPath), { recursive: true }); } catch { /* fall back to the in-process floor */ }
    // A backoff that dies with the process is not a backoff: restarting was enough to
    // walk straight back into the 429 that caused it, with a clean failure count and a
    // floor that had long since expired. Inherit the penalty instead of starting innocent.
    const penalty = loadPenalty(this.penaltyPath);
    this.penaltyUntil = penalty.until;
    this.failures = penalty.failures;
    if (penalty.until > Date.now() && penalty.error) {
      // Say why the first reading is late, rather than sitting on "connecting" for
      // fifteen minutes with no explanation.
      this.lastError = penalty.error;
      this.staleSince = new Date(penalty.since ?? Date.now()).toISOString();
    }
    this.samples = loadHistory(this.historyPath, capacity);
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this.tick();
    return this;
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** Longest silence that still counts as one contiguous series. */
  get maxGapMs() {
    return this.intervalMs * GAP_INTERVALS;
  }

  /**
   * Last good value plus freshness. Shaped identically whether fresh, stale, or empty.
   *
   * `resetsInSeconds` is recomputed here rather than served from the cached snapshot:
   * it is a countdown, and the cached one was correct only at poll time. Served verbatim it
   * never ticks between polls, and while the poller is stale it is wrong by exactly the age
   * of the data — the one situation where the number matters most.
   */
  snapshot(now = Date.now()) {
    const quota = this.last ?? emptyQuota(now);
    // Before the first poll there is no staleSince, so age against the boot instant.
    const since = this.staleSince ?? (this.last === null ? this.bootedAt : null);
    return {
      ...quota,
      limits: quota.limits.map((limit) => ({
        ...limit,
        resetsInSeconds: secondsUntil(limit.resetsAt, now),
      })),
      stale: this.last === null || this.staleSince !== null,
      // stale:true with staleSince:null and lastError:null used to be the only signal that
      // the first poll had not landed yet — indistinguishable from a broken poller. These
      // two say which it is, and give the UI an age to show either way.
      hasData: this.last !== null,
      bootedAt: this.bootedAt,
      staleSince: this.staleSince,
      staleSeconds: since === null ? null : Math.max(0, Math.round((now - Date.parse(since)) / 1000)),
      lastError: this.lastError,
    };
  }

  /** Retained samples, oldest-first — the raw series /api/history draws as a sparkline. */
  history() {
    return this.samples.slice();
  }

  /**
   * Everything /api/history reports about one limit's trend, from a single pass over the
   * series: the fit, whether it supports a projection, and the span it was fitted over.
   * `sinceT` is what lets the UI clip the sparkline to the fitted span instead of drawing a
   * trend line across samples the fit deliberately excluded.
   *
   * The one-call form of the entry. A caller that wants the points themselves — to build the
   * same entry field by field — should use series(), whose first element and length are
   * exactly this `sinceT` and `sampleCount`.
   *
   * `spanMs`/`deltaPercent` and their `min*` counterparts are the evidence behind the two
   * nullable numbers, so a UI can say WHICH gate it is still waiting on instead of only
   * saying "measuring".
   */
  /**
   * One rate and one ETA, always from the CURRENT regime, with doubt shown rather than hidden.
   *
   * The obvious alternative — when the regime is too short, widen the basis until the gates
   * pass — is worse than it looks. A wider basis is a different behaviour, so it can flatly
   * contradict what you are doing now: after you stop, it keeps reporting the burn you have
   * just ended, and during an acceleration it reports the slow stretch that preceded it. That
   * second case is the original defect, reintroduced through the back door.
   *
   * So the basis never changes. Below MIN_SAMPLES there is nothing to fit and the answer is
   * "measuring". Above it, the numbers are published — but `provisional` is set until the
   * regime clears the span and delta gates, and the UI marks those with a trailing "?".
   * A thin reading of what you are actually doing beats a solid reading of something else.
   */
  fit(key) {
    const points = this.series(key);
    const ev = evidenceOf(points, key);
    const enough = points.length >= MIN_SAMPLES;
    return {
      key,
      burnPercentPerHour: enough ? burnRateOf(points) : null,
      projectedAt: enough ? this.projectionFrom(points, key, Date.now(), false) : null,
      provisional: enough && !ev.supported,
      sinceT: points.length ? points[0].t : null,
      sampleCount: points.length,
      spanMs: ev.spanMs,
      deltaPercent: ev.deltaPercent,
      stepCount: ev.stepCount,
      minSampleCount: MIN_SAMPLES,
      minSpanMs: ev.minSpanMs,
      minDeltaPercent: MIN_DELTA_PERCENT,
      minStepCount: ev.minStepCount,
    };
  }

  /**
   * Percent per hour for one limit, least-squares over the contiguous series. A two-point
   * difference is noise-dominated on integer percentages; the fit is not. null whenever the
   * series does not clear the honesty gates, so the UI can say "measuring" instead of
   * drawing a line it cannot support.
   */
  burnRate(key) {
    return this.fit(key).burnPercentPerHour;
  }

  /** Epoch ms at which `key` reaches 100% at the current rate, or null if it never does. */
  projection(key) {
    return this.fit(key).projectedAt;
  }

  projectionFrom(points, key, now = Date.now(), requireSupport = true) {
    const win = THRESHOLDS.windows[key]; // not `window`: shadowing a global reads as a typo
    if (!win) return null;
    if (points.length < MIN_SAMPLES) return null;
    // fit() publishes under-evidenced projections deliberately, flagged provisional; every
    // other caller still wants the gated answer.
    if (requireSupport && !evidenceOf(points, key).supported) return null;
    const rate = burnRateOf(points);
    if (!Number.isFinite(rate) || rate <= 0) return null; // NaN <= 0 is false — check finite first

    const latest = points[points.length - 1];
    // A fit whose newest sample is older than a gap describes the past, not the present.
    if (now - latest.t > this.maxGapMs) return null;

    let at = latest.t + ((100 - latest.p) / rate) * HOUR_MS;
    if (!Number.isFinite(at)) return null;
    // Anchored at the last sample, so an old anchor can put the answer behind us. "You hit
    // the cap 4 minutes ago" is not a projection; the soonest honest answer is "now".
    at = Math.max(at, now);
    // No reset instant is not "the window never clears": the samples outlive the process, so
    // a poller replaying the cache before its first good poll has a series but no snapshot.
    // Projecting past a reset we cannot see is worse than admitting we do not know yet.
    const reset = Date.parse(this.last?.limits.find((l) => l.key === key)?.resetsAt ?? '');
    if (!Number.isFinite(reset) || at > reset) return null; // the window clears first
    return Math.round(at);
  }

  /**
   * Reserve the next upstream request, returning ms to wait if the floor has not expired.
   *
   * The floor has to hold ACROSS processes, not only within one. `watch` running beside
   * `serve` is two pollers, and each honouring its own 30s gap doubles the real upstream
   * rate — which is exactly how both of them end up in a 5-minute rate-limit backoff.
   * The claim is a read-modify-write of a single timestamp, serialised by an exclusive
   * lock file so two processes cannot both read the same expired slot and take it.
   */
  claimSlot(now = Date.now()) {
    // The penalty outranks the floor: while it stands, nobody on this machine may ask.
    if (this.penaltyUntil > now) return Math.min(this.penaltyUntil - now, RATE_LIMIT_MAX_MS);
    const held = MIN_REQUEST_GAP_MS - (now - this.lastRequestAt);
    let fd;
    try {
      fd = openSync(this.slotLock, 'wx');
    } catch {
      // Either a peer holds it for the microsecond a claim takes, or a killed process
      // left it behind. Reap a demonstrably stale lock; never block on a peer, since a
      // wedged lock must not be able to stop every future poll.
      try {
        if (now - statSync(this.slotLock).mtimeMs > SLOT_LOCK_STALE_MS) unlinkSync(this.slotLock);
      } catch { /* already gone */ }
      return Math.max(0, held);
    }
    try {
      let last = 0;
      try { last = Number(readFileSync(this.slotPath, 'utf8')) || 0; } catch { /* first run */ }
      const wait = MIN_REQUEST_GAP_MS - (now - last);
      if (wait > 0) return wait;
      writeFileSync(this.slotPath, String(now));
      this.lastRequestAt = now;
      return 0;
    } finally {
      closeSync(fd);
      try { unlinkSync(this.slotLock); } catch { /* already reaped */ }
    }
  }

  /**
   * Re-point the caches if the logged-in account changed under us.
   *
   * Credentials are re-read every poll, so a switch is picked up without a restart — but the
   * cache paths were resolved once at construction, which would have quietly appended the new
   * account's samples to the old account's trace. Two accounts fitted as one series give a
   * burn rate that describes neither.
   */
  followAccount({ keepLast = false } = {}) {
    const key = accountKey();
    if (key === this.account) return false;
    this.account = key;
    this.historyPath = historyPath(key);
    this.penaltyPath = join(dirname(this.historyPath), `backoff-${key}.json`);
    this.samples = loadHistory(this.historyPath, this.capacity); // the other account's trace, or empty
    if (!keepLast) {
      this.last = null; // the held numbers belong to the account we just left
      this.staleSince = null;
      this.lastError = null;
    }
    return true;
  }

  async tick() {
    if (this.inFlight) return; // single-flight; the running tick owns the reschedule
    this.inFlight = true;
    let delay;
    let event;
    try {
      this.followAccount();
      for (let wait = this.claimSlot(); wait > 0; wait = this.claimSlot()) await sleep(wait);
      const fetched = await this.fetchOnce();
      // Checked again AFTER the fetch, because the account that owns a reading is the one
      // that answered it. A switch landing between the pre-fetch check and the response
      // filed the new account's first sample into the old account's trace — observed live.
      // `keepLast` because this reading belongs to the account we just moved to.
      this.followAccount({ keepLast: true });
      this.last = fetched;
      this.staleSince = null;
      this.lastError = null;
      this.failures = 0;
      this.penaltyUntil = 0;
      clearPenalty(this.penaltyPath); // one good answer ends it for every process
      this.record(this.last); // successful polls only: a failure must not flatten the trace
      delay = jitter(this.intervalMs);
      event = ['update', this.snapshot()];
    } catch (err) {
      this.staleSince ??= new Date().toISOString();
      const code = err.code ?? 'EUNKNOWN';
      this.lastError = { code, message: PUBLIC_MESSAGES[code] ?? PUBLIC_MESSAGES.EUNKNOWN };
      this.failures += 1;
      delay = code === 'ERATE'
        ? Math.min(RATE_LIMIT_MAX_MS, Math.max(RATE_LIMIT_BACKOFF_MS, (err.retryAfterSeconds ?? 0) * 1000))
        : fullJitter(BACKOFF_MS[Math.min(this.failures - 1, BACKOFF_MS.length - 1)]);
      this.penaltyUntil = Date.now() + delay;
      savePenalty(this.penaltyPath, {
        until: this.penaltyUntil,
        failures: this.failures,
        error: this.lastError,
        since: Date.parse(this.staleSince),
      });
      event = ['error', err, this.snapshot()];
    } finally {
      this.inFlight = false;
      // A listener that throws must not take the loop down with it: tick() is called
      // floating, so an escaping throw would skip the reschedule and the poller would die
      // silently while the server kept serving an ever-staler number. Hence the guarded
      // emit and the reschedule in `finally`.
      try {
        this.emit(...event);
      } catch (err) {
        process.emitWarning(err); // a broken listener is loud, but it is not ours to fix
      }
      if (this.running) this.timer = setTimeout(() => this.tick(), delay);
    }
  }

  async fetchOnce() {
    try {
      return await getQuota();
    } catch (err) {
      // Claude Code may have refreshed the token between our disk read and the request;
      // getQuota re-reads credentials, so one retry is enough. This is all we do about
      // auth — we never refresh the token ourselves.
      if (err.code !== 'EAUTH') throw err;
      return await getQuota();
    }
  }

  record(quota) {
    const sample = {
      t: Date.now(),
      p: HISTORY_KEYS.map((key) => quota.limits.find((l) => l.key === key)?.percent ?? null),
    };
    this.samples.push(sample);
    if (this.samples.length > this.capacity) this.samples.splice(0, this.samples.length - this.capacity);
    appendSample(this.historyPath, sample);
  }

  /**
   * One key's readable points back to the last break in the trace.
   *
   * Two things break it. A percent only ever drops on a window reset, so a downward step is
   * one. A silence longer than `maxGapMs` is the other: a reset inside a gap is invisible
   * when the new window's first reading is already above the old window's last, and fitting
   * across it reports a trend that never happened.
   */
  /** The contiguous run, cut only at a window reset and at a poller-off gap. */
  rawSeries(key) {
    const i = HISTORY_KEYS.indexOf(key);
    if (i < 0) return [];
    let points = [];
    for (const s of this.samples) {
      const p = s.p[i];
      if (!Number.isFinite(p)) continue;
      const prev = points[points.length - 1];
      if (prev && (p < prev.p || s.t - prev.t > this.maxGapMs)) points = [];
      points.push({ t: s.t, p });
    }
    return points;
  }

  /** The stretch the user is currently in — what "at the rate I am going now" means. */
  series(key) {
    return regimeChain(this.rawSeries(key), this.minSegment)[0];
  }

  /**
   * Fewest samples a regime may be made of. At the base interval this is ~16 minutes —
   * short enough to catch a real change of pace, long enough that a single quantisation
   * step cannot masquerade as one.
   */
  get minSegment() {
    return Math.max(MIN_SAMPLES, Math.round((16 * 60_000) / this.intervalMs));
  }
}

/**
 * The stretch the user is *currently* in, found by recursive change-point detection.
 *
 * A burn rate has to answer "at the rate I am going NOW", so the fit must not span a change
 * of behaviour. series() already cuts at a window reset and at a gap where the poller was
 * off; neither catches the two cases that actually distort the number — an idle stretch the
 * poller sat through, and a genuine change of pace.
 *
 * For every candidate split, compare fitting two independent lines against fitting one. Take
 * the split that explains the most variance, keep it only if it beats one line by REGIME_GAIN,
 * then recurse into the tail, because a day has more than one break in it: start work, lunch,
 * resume. What survives is the last segment.
 *
 * Why not simply grow backwards until the points stop looking linear: tolerating T points of
 * deviation always drags in T/Δrate hours of the previous regime, so a loose tolerance blurs
 * the boundary and a tight one shreds a bursty-but-real trend. Locating the boundary avoids
 * having to pick that tolerance at all. On synthetic regimes this recovers the true current
 * rate in every case tried, including three consecutive ones; growing-until-non-linear
 * recovered five of seven.
 *
 * A short regime is not silently blessed: it still has to clear the evidence gates, and a
 * 68-minute stretch will not carry a 7-day projection. That is the intended outcome — the UI
 * says "measuring" rather than extrapolating a spree across a week.
 */
function regimeChain(points, _minSegment) {
  // Boundaries are found among the STEPS, where each observation is a real event and there
  // are no plateaus to mistake for a change of pace; the rate is then fitted back over the
  // raw samples inside the chosen stretch, because a growing plateau is exactly how a stop
  // becomes visible. Fitted on steps alone the rate would never fall: no new step ever
  // arrives to say you have finished, so it would report your old burn indefinitely.
  const steps = stepsOf(points);
  const chain = [points];
  let seg = steps;
  for (let depth = 0; depth < MAX_REGIME_DEPTH; depth++) {
    const cut = bestSplit(seg, MIN_REGIME_STEPS);
    if (cut === null) break;
    seg = seg.slice(cut);
    // The behaviour changed somewhere inside the tread leading up to the first kept step,
    // so anchor at the step before it rather than clipping that tread off.
    const from = cut > 0 ? seg[0].prevT : points[0].t;
    chain.push(points.filter((pt) => pt.t >= from));
  }
  const stall = trailingStall(points, steps);
  if (stall !== null) chain.push(points.filter((pt) => pt.t >= stall));
  return chain.reverse(); // narrowest (the current regime) first, full series last
}

/**
 * Where the current stretch of silence began, if it has run long enough to be a stop rather
 * than an ordinary gap between steps. Returns null while the burn is merely slow.
 */
function trailingStall(points, steps) {
  if (steps.length < MIN_REGIME_STEPS) return null;
  const treads = [];
  for (let i = 1; i < steps.length; i++) treads.push(steps[i].t - steps[i - 1].t);
  treads.sort((a, b) => a - b);
  const typical = treads[Math.floor(treads.length / 2)]; // median: one long lunch must not set the bar
  const last = steps[steps.length - 1];
  const silence = points[points.length - 1].t - last.t;
  return typical > 0 && silence > typical * STALL_TREADS ? last.t : null;
}

/** One observation per integer transition: "it became p at t, having held prevT since". */
function stepsOf(points) {
  const steps = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i].p !== points[i - 1].p) steps.push({ t: points[i].t, p: points[i].p, prevT: points[i - 1].t });
  }
  return steps;
}

/** Index where a two-line fit beats one line by REGIME_GAIN, or null if none does. */
function bestSplit(points, minSegment) {
  const n = points.length;
  if (n < 2 * minSegment) return null;
  const sums = prefixSums(points);
  const whole = rssOf(sums, 0, n);
  let best = null;
  for (let k = minSegment; k <= n - minSegment; k++) {
    const total = rssOf(sums, 0, k) + rssOf(sums, k, n);
    if (best === null || total < best.total) best = { k, total };
  }
  // Two lines always fit at least as well as one, so an unconditional split would find a
  // "regime change" in perfectly steady data. Only a real improvement counts as evidence.
  return best && best.total <= whole * (1 - REGIME_GAIN) ? best.k : null;
}

/**
 * Cumulative sums that make the residual sum of squares of any range O(1).
 *
 * Time is carried as hours since the first point, not epoch ms: squaring epoch values
 * reaches 1e24 and the sums lose the precision the fit is made of.
 */
function prefixSums(points) {
  const t0 = points[0].t;
  const s = { t: [0], p: [0], tt: [0], tp: [0], pp: [0] };
  points.forEach((pt, i) => {
    const t = (pt.t - t0) / HOUR_MS;
    s.t.push(s.t[i] + t);
    s.p.push(s.p[i] + pt.p);
    s.tt.push(s.tt[i] + t * t);
    s.tp.push(s.tp[i] + t * pt.p);
    s.pp.push(s.pp[i] + pt.p * pt.p);
  });
  return s;
}

/** Residual sum of squares of the least-squares line over [a, b). */
function rssOf(s, a, b) {
  const n = b - a;
  if (n < 3) return 0; // two points always fit a line exactly; claiming zero error is honest
  const st = s.t[b] - s.t[a];
  const sp = s.p[b] - s.p[a];
  const sxx = s.tt[b] - s.tt[a] - (st * st) / n;
  const sxy = s.tp[b] - s.tp[a] - (st * sp) / n;
  const syy = s.pp[b] - s.pp[a] - (sp * sp) / n;
  const rss = sxx > 0 ? syy - (sxy * sxy) / sxx : syy;
  return Math.max(0, rss);
}

/**
 * The evidence behind a fit, and whether it clears the honesty gates.
 *
 * A sample count bounds the NUMBER of points, not the elapsed time or the movement, so six
 * samples over 17 minutes in which weekly stepped 11% -> 12% used to produce both a confident
 * "+12.06 %/hr" on a 7-day window and, from the same one integer step, "hits 100% tomorrow
 * morning". A fit is trusted only when all three of these hold:
 *
 *   count >= 3                    a two-point difference is noise on integer percentages
 *   span  >= windowSeconds / 48   session 6m15s, weekly and Fable 3h30m
 *   delta >= 2 percentage points  twice the endpoint's 1-point quantization step
 *
 * The span scales with the window because a slope means far less on a 7-day window than on a
 * 5-hour one, and 1/48 is the largest fraction that still fits inside the 6-hour sample buffer
 * for the weekly windows. The two agree by construction: a burn at exactly full-window pace
 * covers 100/48 ≈ 2.08 points in that span, so the delta gate reads as "moving at least as
 * fast as the window itself".
 *
 * Zero delta is the one exemption, and it is not a loophole. A percent only ever drops on a
 * reset and series() cuts the run there, so points within a run never decrease: delta === 0
 * means every sample in a well-sampled span read the SAME percent. That is a measured flat
 * worth reporting as 0.00, not an absence of evidence. Only a delta between the two — a
 * single quantization step, which is exactly what noise looks like — is under-evidenced.
 */
function evidenceOf(points, key) {
  const win = THRESHOLDS.windows[key];
  const minSpanMs = win ? Math.round(win.windowSeconds * 1000 * MIN_SPAN_FRACTION) : null;
  const first = points[0];
  const latest = points[points.length - 1];
  const spanMs = points.length ? latest.t - first.t : 0;
  const deltaPercent = points.length ? latest.p - first.p : 0;
  const stepCount = stepsOf(points).length;
  // A flat run is the one case that clears on no movement at all: zero steps over a long
  // enough span is a measurement, not a shortage of evidence, and it must stay tellable
  // apart from "we do not know yet".
  const flat = deltaPercent === 0 && stepCount === 0;
  return {
    spanMs,
    deltaPercent,
    stepCount,
    minSpanMs,
    minStepCount: MIN_GATE_STEPS,
    supported: points.length >= MIN_SAMPLES
      && minSpanMs !== null && spanMs >= minSpanMs
      && (flat || (deltaPercent >= MIN_DELTA_PERCENT && stepCount >= MIN_GATE_STEPS)),
  };
}

/** Least-squares percent-per-hour over `points`, or null when they cannot support one. */
function burnRateOf(points) {
  if (points.length < MIN_SAMPLES) return null;
  const meanT = points.reduce((s, q) => s + q.t, 0) / points.length;
  const meanP = points.reduce((s, q) => s + q.p, 0) / points.length;
  let cov = 0;
  let varT = 0;
  for (const q of points) {
    cov += (q.t - meanT) * (q.p - meanP);
    varT += (q.t - meanT) ** 2;
  }
  if (varT === 0) return null; // every sample landed on the same millisecond
  const rate = (cov / varT) * HOUR_MS;
  return Number.isFinite(rate) ? rate : null;
}

function historyPath(account = 'default') {
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cache, 'ccusageviz', `history-${account}.jsonl`);
}

/**
 * Never throws, and never trusts the file further than it can be checked: a corrupt or
 * hand-edited penalty must not be able to mute polling forever, so the deadline is
 * clamped to the longest backoff the code would ever choose on its own.
 */
function loadPenalty(path) {
  const none = { until: 0, failures: 0, error: null, since: null };
  let saved;
  try {
    saved = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return none; // absent on a first run, and unreadable is the same as absent
  }
  if (!saved || typeof saved !== 'object') return none;
  const until = Number(saved.until);
  if (!Number.isFinite(until) || until <= Date.now()) return none; // already served
  const failures = Number(saved.failures);
  return {
    until: Math.min(until, Date.now() + RATE_LIMIT_MAX_MS),
    failures: Number.isFinite(failures) && failures > 0 ? Math.floor(failures) : 0,
    error: saved.error && typeof saved.error === 'object' ? saved.error : null,
    since: Number.isFinite(Number(saved.since)) ? Number(saved.since) : null,
  };
}

function savePenalty(path, penalty) {
  writeCache(path, () => writeFileSync(path, JSON.stringify(penalty)));
}

function clearPenalty(path) {
  try { unlinkSync(path); } catch { /* nothing to clear */ }
}

/** Never throws: a missing or half-written cache just means no trace to draw yet. */
function loadHistory(path, capacity) {
  let lines;
  try {
    lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }

  const samples = [];
  for (const line of lines) {
    try {
      const s = JSON.parse(line);
      if (!Number.isFinite(s?.t) || !Array.isArray(s?.p)) continue;
      // Number.isFinite, not typeof: a torn or doctored line carrying 1e999 parses to
      // Infinity, which passes a typeof check and turns the next fit's slope into NaN.
      samples.push({ t: s.t, p: HISTORY_KEYS.map((_, i) => (Number.isFinite(s.p[i]) ? s.p[i] : null)) });
    } catch { /* one torn line, keep the rest */ }
  }

  const kept = samples.slice(-capacity);
  // Writes are append-only during a run, so compacting here is what bounds the file.
  if (kept.length < lines.length) writeHistory(path, kept);
  return kept;
}

function appendSample(path, sample) {
  writeCache(path, () => appendFileSync(path, `${JSON.stringify(sample)}\n`));
}

function writeHistory(path, samples) {
  writeCache(path, () => writeFileSync(path, samples.map((s) => `${JSON.stringify(s)}\n`).join('')));
}

/** The cache is a convenience; an unwritable one must never fail a poll. */
function writeCache(path, write) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    write();
  } catch { /* no trace across restarts, nothing worse */ }
}

function jitter(ms) {
  return Math.round(ms * (1 + (Math.random() * 2 - 1) * JITTER));
}

function fullJitter(ms) {
  return Math.round(Math.random() * ms);
}

function sleep(ms) {
  return new Promise((ok) => { setTimeout(ok, ms); });
}
