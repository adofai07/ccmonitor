import { EventEmitter } from 'node:events';
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { accountKey } from './credentials.js';
import { cacheDir } from './paths.js';
import { FRESH_MS, readReport, reportPrefix } from './statusline.js';
import { getQuota, emptyQuota, secondsUntil, withHeld, withReport, reportConflicts, FUTURE_SLACK_MS, ROUNDING, THRESHOLDS } from './usage.js';

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

// Claude Code's status line (src/statusline.js) files a reading after every reply, read from
// the rate-limit headers of its own requests: fresher than a poll, and free. A report younger
// than this stands in for a poll, so the endpoint is asked only once at start (and once after an
// account switch), for what reports do not carry; again once Claude Code has been quiet this
// long — on claude.ai, say; and when a window passes its reset, which only a poll brings in.
const REPORT_FRESH_MS = FRESH_MS;
// The windows a report carries. Claude Code drops one from its readings once it resets.
const REPORTED_KEYS = ['session', 'weekly'];
// How often the report files are looked at: a listing and a stat each, and a read only of one
// that changed.
const REPORT_CHECK_MS = 2_000;
// A session's report file outlives the session by this long, longer than any window, so a
// session idle that long and then re-run still finds what it filed. Swept once an hour.
const REPORT_KEEP_MS = 8 * 24 * 3_600_000;
const REPORT_SWEEP_MS = 3_600_000;

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

// Two points define a line exactly and say nothing about whether it is the right one.
const MIN_SAMPLES = 3;

// The smallest fall that is a window reset rather than rounding: polls come in whole points and
// status line reports in tenths, and one usage read both ways differs by under a point.
const RESET_DROP = ROUNDING;

// The variance of rounding to the nearest integer, and the reason the segmentation below
// needs no tuned thresholds: a percent is delivered rounded, so this noise level is KNOWN
// rather than something to estimate from the data. Used as a known sigma-squared it makes a
// tread-split unable to repay its parameters (a staircase already sits at this level, so
// carving one up buys nothing) while still letting a genuine level shift pay for itself.
//
// Status line reports come in tenths, whose rounding noise is a hundredth of that, so for a run
// of them this is an upper bound rather than the known level: it errs towards fewer splits and a
// wider standard error, never towards a trend the data cannot support.
//
// Estimating the variance instead was subtly wrong: when both the one-line and two-line
// models sat at the floor their likelihoods tied, BIC took the cheaper one, and a real stop
// went unfound — the run kept ten samples of the burn that preceded it and reported 0.16 %/hr
// for someone who had put the laptop down.
const QUANT_VAR = 1 / 12;

// Parameters per model, for the BIC penalty. With sigma-squared known rather than fitted, one
// line is slope + intercept; two lines are that twice plus the split location. Nothing here is
// chosen; k·ln(n) is the criterion itself.
const PARAMS_ONE = 2;
const PARAMS_TWO = 5;

// A runaway guard, not a limit any real day reaches.
const MAX_BREAKS = 8;

// Above this, the ETA's own uncertainty is too wide for the number to be read as fact and the
// UI marks it "?". It is expressed in the thing the reader actually cares about — how far the
// projected instant could move — rather than in proxies for it.
const ETA_UNCERTAIN_RATIO = 0.25;

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
    // The status line's reports: the newest one taken, the state of each session's file when
    // last read, the timer for the moment the newest stops covering, and whether this account
    // has had its one poll yet (for what reports do not carry).
    this.report = null;
    this.reportSeen = new Map();
    this.sweptAt = 0;
    this.reportTimer = null;
    this.coverTimer = null;
    this.polledOnce = false;
    this.source = null;
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this.watchReports();
    this.tick();
    return this;
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    clearInterval(this.reportTimer);
    this.reportTimer = null;
    clearTimeout(this.coverTimer);
    this.coverTimer = null;
  }

  /** Look for the status line's reports from now on. Part of start(); callable alone. */
  watchReports() {
    if (this.reportTimer) return;
    this.checkReport();
    this.reportTimer = setInterval(() => this.checkReport(), REPORT_CHECK_MS);
    this.reportTimer.unref?.();
  }

  /** True while the newest status line report is recent enough to stand in for a poll. */
  reportFresh(now = Date.now()) {
    if (this.report === null) return false;
    const age = now - this.report.at;
    // A report dated ahead of this clock is from before it stepped back: no reading of now.
    return age < REPORT_FRESH_MS && age > -FUTURE_SLACK_MS;
  }

  /**
   * True while the reports can stand in for polls: one is fresh, and no window the reading
   * holds has passed its reset. Claude Code drops a window from its readings the moment it
   * resets, so a report cannot bring the new window in; only a poll can.
   */
  reportCovers(now = Date.now()) {
    if (!this.reportFresh(now)) return false;
    return !(this.last?.limits ?? []).some((l) =>
      REPORTED_KEYS.includes(l.key) && Number.isFinite(l.percent) && Date.parse(l.resetsAt ?? '') <= now);
  }

  /*
   * Every few seconds, a listing of the cache directory and a stat of each of this account's
   * report files — one per Claude Code session — and a read only of one that changed. A file's
   * state is remembered only once a read succeeds: a report caught mid-write is torn, and the
   * same mtime must not then hide the finished one. The newest report wins in ingest(), whatever
   * order the files are listed in. Files of sessions long gone are swept now and then.
   */
  checkReport() {
    try {
      // The account is followed by tick(), not here: that reads Claude Code's whole config,
      // and an account switch can wait an interval where a stat every two seconds cannot.
      const dir = cacheDir();
      const prefix = reportPrefix(this.account);
      let names;
      try { names = readdirSync(dir); } catch { return; }
      const now = Date.now();
      const sweep = now - this.sweptAt > REPORT_SWEEP_MS;
      if (sweep) this.sweptAt = now;
      for (const name of names) {
        if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
        const path = join(dir, name);
        let st;
        try { st = statSync(path); } catch { continue; }
        if (sweep && now - st.mtimeMs > REPORT_KEEP_MS) {
          try { unlinkSync(path); } catch { /* already gone */ }
          this.reportSeen.delete(name);
          continue;
        }
        const seen = `${st.mtimeMs}:${st.size}`;
        if (this.reportSeen.get(name) === seen) continue;
        const report = readReport(path);
        if (!report) continue;
        this.reportSeen.set(name, seen);
        this.ingest(report, now);
      }
    } catch (err) {
      process.emitWarning(err); // a timer must never throw; the next check tries again
    }
  }

  /**
   * Take a report as the reading. An old one says nothing about now, one older than what is
   * held adds nothing, and one dated ahead of the clock was filed before it stepped back.
   * withReport() decides each window: one window, settle() (within a point the higher, else the
   * newer); two, the later window. The trace keeps its cadence — a report is sampled at most
   * once an interval — so a busy session does not crowd twelve hours of history into one.
   */
  ingest(report, now = Date.now()) {
    if (report.at - now > FUTURE_SLACK_MS) return;
    // One held from before a step back must not outrank what comes now either.
    if (this.report && this.report.at - now > FUTURE_SLACK_MS) this.report = null;
    if (now - report.at >= REPORT_FRESH_MS) return;
    if (this.report && report.at <= this.report.at) return;
    // One that would bring the reading down with no fall its session saw is no reading of now:
    // left out, numbers and freshness both, so the next tick polls and settles it.
    if (reportConflicts(this.last, report, now)) return;
    this.report = report;
    this.last = withReport(this.last, report, now);
    // A poll's failure is kept, not cleared: snapshot() sets it aside while the reports cover,
    // and it is what the reading is held with once they stop.
    this.source = 'statusline';
    const lastSample = this.samples[this.samples.length - 1];
    if (!lastSample || report.at - lastSample.t >= this.intervalMs) this.record(this.last, report.at);
    this.armCoverEnd(now);
    try {
      this.emit('update', this.snapshot());
    } catch (err) {
      process.emitWarning(err);
    }
  }

  /*
   * When the newest report stops covering beside a failing poll, the snapshot turns stale with
   * no tick to say so — the next one may be a whole backoff away — so say it then.
   */
  armCoverEnd(now = Date.now()) {
    clearTimeout(this.coverTimer);
    this.coverTimer = setTimeout(() => {
      this.coverTimer = null;
      if (this.staleSince === null) return; // polling is healthy: the next tick asks, and says
      try {
        this.emit('update', this.snapshot());
      } catch (err) {
        process.emitWarning(err);
      }
    }, Math.max(0, this.report.at + REPORT_FRESH_MS - now) + 50);
    this.coverTimer.unref?.();
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
    // While reports stand in for polls, a poll that failed beside them does not make the
    // reading stale: the reports are the reading. Once they stop, it is stale from then on.
    const covered = this.reportCovers(now);
    let staleSince = covered ? null : this.staleSince;
    if (staleSince !== null && this.report !== null) {
      const coverEnd = Math.min(now, this.report.at + REPORT_FRESH_MS);
      if (coverEnd > Date.parse(staleSince)) staleSince = new Date(coverEnd).toISOString();
    }
    // Before the first poll there is no staleSince, so age against the boot instant.
    const since = staleSince ?? (this.last === null ? this.bootedAt : null);
    return {
      ...quota,
      limits: quota.limits.map((limit) => ({
        ...limit,
        resetsInSeconds: secondsUntil(limit.resetsAt, now),
      })),
      // where the newest reading came from: 'poll' (the usage endpoint), 'statusline'
      // (Claude Code's status line, src/statusline.js), or null before either
      source: this.last === null ? null : this.source,
      stale: this.last === null || staleSince !== null,
      // stale:true with staleSince:null and lastError:null used to be the only signal that
      // the first poll had not landed yet — indistinguishable from a broken poller. These
      // two say which it is, and give the UI an age to show either way.
      hasData: this.last !== null,
      bootedAt: this.bootedAt,
      staleSince,
      staleSeconds: since === null ? null : Math.max(0, Math.round((now - Date.parse(since)) / 1000)),
      lastError: covered ? null : this.lastError,
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
   * `seRatePercentPerHour` and `etaUncertaintySeconds` are the evidence behind the two
   * nullable numbers, so a UI can say how well resolved they are rather than only "measuring".
   */
  /**
   * One rate and one ETA over the current run, each carrying its own uncertainty.
   *
   * The run is found by penalised-likelihood segmentation, so an idle stretch, a stop and a
   * change of pace are all just splits that repay their parameters — no case is special.
   *
   * The basis never widens to meet a bar. Reaching back for a longer run means reaching into
   * different behaviour, and a wider fit can contradict the present: after a stop it reports
   * the burn just ended, during an acceleration the slow stretch before it. Instead both
   * numbers are published from the current run, and `provisional` says the ETA's own spread
   * is too wide to read as fact — the UI marks those with a trailing "?".
   */
  fit(key) {
    const points = this.series(key);
    const f = fitOf(points);
    const projectedAt = f ? this.projectionFrom(points, key) : null;
    // The ETA moves by (100 − now) / rate², so its spread follows from the rate's directly.
    const remaining = points.length ? 100 - points[points.length - 1].p : null;
    const etaSpreadMs = f && f.rate > 0 && remaining !== null
      ? (remaining / (f.rate * f.rate)) * f.seRate * HOUR_MS
      : null;
    const horizonMs = projectedAt !== null ? Math.max(1, projectedAt - Date.now()) : null;
    return {
      key,
      burnPercentPerHour: f ? f.rate : null,
      seRatePercentPerHour: f ? f.seRate : null,
      projectedAt,
      etaUncertaintySeconds: etaSpreadMs === null ? null : Math.round(etaSpreadMs / 1000),
      // Wide relative to how far ahead it is: "01:15 give or take four hours" is not a time.
      provisional: !!(etaSpreadMs !== null && horizonMs !== null
        && etaSpreadMs / horizonMs > ETA_UNCERTAIN_RATIO),
      sinceT: points.length ? points[0].t : null,
      sampleCount: points.length,
      spanMs: points.length ? points[points.length - 1].t - points[0].t : 0,
      deltaPercent: points.length ? points[points.length - 1].p - points[0].p : 0,
      minSampleCount: MIN_SAMPLES,
    };
  }

  /** Percent per hour over the current run, or null when it cannot be fitted at all. */
  burnRate(key) {
    return this.fit(key).burnPercentPerHour;
  }

  /** Epoch ms at which `key` reaches 100% at the current rate, or null if it never does. */
  projection(key) {
    return this.fit(key).projectedAt;
  }

  projectionFrom(points, key, now = Date.now()) {
    const win = THRESHOLDS.windows[key]; // not `window`: shadowing a global reads as a typo
    if (!win) return null;
    const f = fitOf(points);
    if (!f || !(f.rate > 0)) return null; // NaN > 0 is false, so this also rejects NaN

    const latest = points[points.length - 1];
    // A fit whose newest sample is older than a gap describes the past, not the present.
    if (now - latest.t > this.maxGapMs) return null;

    let at = latest.t + ((100 - latest.p) / f.rate) * HOUR_MS;
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
    // the other account's reports are its own; this one's are read from its own file, and
    // its first poll is still to come — for the plan, the thresholds and Fable, which no
    // report carries
    this.report = null;
    this.reportSeen = new Map();
    clearTimeout(this.coverTimer);
    this.coverTimer = null;
    this.polledOnce = false;
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
      // While Claude Code's status line keeps reporting, its readings are the fresher ones and
      // cost nothing: no request, no rate limit. Checked again after the wait for a slot, which
      // can be long enough for the first report of a session to arrive. But a failed poll whose
      // backoff has run out is retried all the same, reports or not: left alone, its reason
      // would come back word for word, maybe hours old, the moment they stopped.
      const reported = () => this.polledOnce && this.reportCovers()
        && !(this.staleSince !== null && this.penaltyUntil <= Date.now());
      if (!reported()) {
        for (let wait = this.claimSlot(); wait > 0 && !reported(); wait = this.claimSlot()) await sleep(wait);
      }
      if (reported()) {
        delay = jitter(this.intervalMs);
        // No request, but still a frame: the reading's age moves on, and `watch` and any page
        // older than the server's ping keep their once-an-interval line.
        event = ['update', this.snapshot()];
        return;
      }
      const fetched = await this.fetchOnce();
      // Checked again AFTER the fetch, because the account that owns a reading is the one
      // that answered it. A switch landing between the pre-fetch check and the response
      // filed the new account's first sample into the old account's trace — observed live.
      // `keepLast` because this reading belongs to the account we just moved to.
      const switched = this.followAccount({ keepLast: true });
      // The poll is the newest reading but not always the highest (withHeld), unless the
      // reading it would be held to belongs to the account just left. A report that came while
      // the request was out may hold a newer number still.
      let next = switched ? fetched : withHeld(fetched, this.last);
      if (this.reportFresh()) next = withReport(next, this.report);
      this.last = next;
      this.staleSince = null;
      this.lastError = null;
      this.failures = 0;
      this.penaltyUntil = 0;
      this.polledOnce = true;
      this.source = 'poll';
      clearPenalty(this.penaltyPath); // one good answer ends it for every process
      this.record(this.last); // successful polls only: a failure must not flatten the trace
      delay = jitter(this.intervalMs);
      event = ['update', this.snapshot()];
    } catch (err) {
      const code = err.code ?? 'EUNKNOWN';
      // Kept even beside fresh reports: snapshot() sets it aside while they cover.
      this.staleSince ??= new Date().toISOString();
      this.lastError = { code, message: PUBLIC_MESSAGES[code] ?? PUBLIC_MESSAGES.EUNKNOWN };
      this.failures += 1;
      delay = code === 'ERATE'
        ? Math.min(RATE_LIMIT_MAX_MS, Math.max(RATE_LIMIT_BACKOFF_MS, (err.retryAfterSeconds ?? 0) * 1000))
        : fullJitter(BACKOFF_MS[Math.min(this.failures - 1, BACKOFF_MS.length - 1)]);
      this.penaltyUntil = Date.now() + delay;
      savePenalty(this.penaltyPath, {
        until: this.penaltyUntil,
        failures: this.failures,
        error: { code, message: PUBLIC_MESSAGES[code] ?? PUBLIC_MESSAGES.EUNKNOWN },
        since: Date.parse(this.staleSince ?? new Date().toISOString()),
      });
      event = ['error', err, this.snapshot()];
    } finally {
      this.inFlight = false;
      // A listener that throws must not take the loop down with it: tick() is called
      // floating, so an escaping throw would skip the reschedule and the poller would die
      // silently while the server kept serving an ever-staler number. Hence the guarded
      // emit and the reschedule in `finally`.
      try {
        if (event) this.emit(...event);
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

  record(quota, t = Date.now()) {
    const sample = {
      t,
      p: HISTORY_KEYS.map((key) => quota.limits.find((l) => l.key === key)?.percent ?? null),
    };
    this.samples.push(sample);
    if (this.samples.length > this.capacity) this.samples.splice(0, this.samples.length - this.capacity);
    appendSample(this.historyPath, sample);
  }

  /**
   * One key's readable points back to the last break in the trace.
   *
   * Two things break it. A percent falls at a window reset, a refill or a re-scaled plan, and a
   * new run starts there whichever it was — at a step of a point or more: the endpoint gives
   * whole points and the status line tenths, and the same usage read both ways can differ by
   * less than one. A silence longer than
   * `maxGapMs` is the other: a reset inside a gap is invisible when the new window's first
   * reading is already above the old window's last, and fitting across it reports a trend that
   * never happened.
   */
  /** The contiguous run, cut only at a fall (a reset, a refill, a re-scale) and at a poller-off gap. */
  rawSeries(key) {
    const i = HISTORY_KEYS.indexOf(key);
    if (i < 0) return [];
    let points = [];
    for (const s of this.samples) {
      const p = s.p[i];
      if (!Number.isFinite(p)) continue;
      const prev = points[points.length - 1];
      if (prev && (prev.p - p >= RESET_DROP || s.t - prev.t > this.maxGapMs)) points = [];
      points.push({ t: s.t, p });
    }
    return points;
  }

  /** The stretch the user is currently in — what "at the rate I am going now" means. */
  series(key) {
    const points = this.rawSeries(key);
    return points.slice(runStart(points));
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
/**
 * Prefix sums over a run, so the least-squares fit of ANY sub-range costs O(1).
 *
 * Time is carried as hours since the run's first sample. Squaring epoch milliseconds reaches
 * 1e24 and the sums lose the precision the fit is made of.
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

/** Least-squares line over [a, b): slope in %/hr, residual sum of squares, and the spread of t. */
function lineOf(s, a, b) {
  const n = b - a;
  if (n < 2) return { n, slope: 0, rss: n * QUANT_VAR, sxx: 0 };
  const st = s.t[b] - s.t[a];
  const sp = s.p[b] - s.p[a];
  const sxx = s.tt[b] - s.tt[a] - (st * st) / n;
  const sxy = s.tp[b] - s.tp[a] - (st * sp) / n;
  const syy = s.pp[b] - s.pp[a] - (sp * sp) / n;
  const slope = sxx > 0 ? sxy / sxx : 0;
  const rss = Math.max(0, sxx > 0 ? syy - (sxy * sxy) / sxx : syy);
  return { n, slope, rss, sxx };
}

/**
 * Gaussian deviance of a segment under the KNOWN quantization variance, up to constants
 * shared by every model. A perfectly flat run scores 0 here, which is the honest answer and
 * needs no floor to keep it finite.
 */
const cost = (line) => line.rss / QUANT_VAR;

/**
 * Where the current run begins: the last point at which splitting the series pays for itself.
 *
 * For every candidate split, the two-line model is scored against the one-line model by BIC —
 * likelihood plus k·ln(n). A split must earn its two extra parameters out of the fit it buys,
 * so noise never justifies one and a real change of pace always does. Recursing into the tail
 * finds the most recent break of several, which is the one that describes now.
 *
 * This replaces an accumulation of hand-set thresholds — a minimum split gain, a minimum
 * segment length in steps, a separate flat-gap detector for the idle the step search could not
 * see, a stall detector for the stop that produces no steps, and a chain ordering to keep them
 * straight. Each had been added to patch a case the previous one missed. None survives: an
 * idle stretch, a stop and a change of pace are all just splits that repay their parameters.
 */
function runStart(points) {
  let from = 0;
  for (let depth = 0; depth < MAX_BREAKS; depth++) {
    const rest = points.slice(from);
    const n = rest.length;
    if (n < 2 * MIN_SAMPLES) break;
    const s = prefixSums(rest);
    const whole = cost(lineOf(s, 0, n)) + PARAMS_ONE * Math.log(n);
    let best = null;
    for (let k = MIN_SAMPLES; k <= n - MIN_SAMPLES; k++) {
      const c = cost(lineOf(s, 0, k)) + cost(lineOf(s, k, n)) + PARAMS_TWO * Math.log(n);
      if (best === null || c < best.c) best = { k, c };
    }
    if (!best || best.c >= whole) break;
    from += best.k;
  }
  return from;
}

/**
 * The fit over a run, with the uncertainty that decides whether it can be stated as fact.
 *
 * `seRate` is the standard error of the slope. It is what the old gates were reaching for:
 * "three samples", "an eighth of the window", "six integer steps" were all proxies for
 * whether the trend was resolved, and each answered the question in a unit the reader does
 * not care about. The standard error answers it directly, and carries through to the ETA.
 */
function fitOf(points) {
  if (points.length < MIN_SAMPLES) return null;
  const s = prefixSums(points);
  const line = lineOf(s, 0, points.length);
  if (!(line.sxx > 0)) return null; // every sample on one instant
  // The residual variance is floored here, where it belongs: a run that happens to sit exactly
  // on a line still cannot be known more precisely than the rounding that produced it, and an
  // SE of zero would claim otherwise.
  const resVar = Math.max(line.rss / Math.max(1, line.n - 2), QUANT_VAR);
  const seRate = Math.sqrt(resVar / line.sxx);
  return Number.isFinite(line.slope) && Number.isFinite(seRate)
    ? { rate: line.slope, seRate, n: line.n }
    : null;
}

function historyPath(account = 'default') {
  return join(cacheDir(), `history-${account}.jsonl`);
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
