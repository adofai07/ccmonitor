import { readCredentials, redact } from './credentials.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TIMEOUT_MS = 5000; // matches Claude Code's own budget for this call

export class UsageError extends Error {
  constructor(code, message, { status = null, retryAfterSeconds = null } = {}) {
    super(message);
    this.name = 'UsageError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const WEEKLY_PACE = [
  { percent: 75, timePct: 0.6 },
  { percent: 50, timePct: 0.35 },
  { percent: 25, timePct: 0.15 },
];

/**
 * Threshold table, ported from the Claude Code binary (symbols qZr, Dnn, reo).
 *
 * Claude Code has no percent ladder. A warning needs BOTH a utilization level and the
 * window to be under-elapsed — you warn when you are burning ahead of the clock, and the
 * warning clears once the clock catches up. `warningFloorPercent` is its hard 70% floor
 * (Dnn=0.7), which is why the 25/50 weekly tiers below can never actually surface.
 * They are kept so the table matches the source and stays tunable.
 *
 * `criticalPercent` is Claude Code's tier-dependent "wrap up" point. Upstream applies it
 * only to the 5-hour window; we apply it to all three so our contract's 'critical' state
 * has a definition everywhere.
 */
export const THRESHOLDS = {
  warningFloorPercent: 70,
  exhaustedPercent: 100,
  criticalPercent: { default_claude_max_20x: 99.75, default_claude_max_5x: 99, default: 95 },
  windows: {
    session: { windowSeconds: 18_000, pace: [{ percent: 90, timePct: 0.72 }] },
    weekly: { windowSeconds: 604_800, pace: WEEKLY_PACE },
    // Fable reports group:"weekly", so it shares the weekly cadence. Its resets_at is null
    // while the window is dormant, in which case no pace rule can fire at all.
    fable: { windowSeconds: 604_800, pace: WEEKLY_PACE },
  },
};

/**
 * The threshold table with every tier-dependent number already resolved, as plain JSON.
 *
 * The browser needs the cut points themselves, not just the `state` string: `state` is
 * pace-derived, so everything from 0% to 69% reports 'normal' and a ring coloured from it
 * would be flat green until it was nearly too late. Serving the numbers lets the UI band
 * the arc by raw percentage — calm below `warningFloorPercent`, warning up to
 * `criticalPercent`, act-now up to `exhaustedPercent` — and agree with `/usage` instead of
 * inventing its own opinion. The pace table is deliberately not exported: it is an input to
 * `state`, not a colour band, and the UI already gets the pace marker from `windowSeconds`.
 */
export function resolveThresholds(rateLimitTier = null) {
  return {
    warningFloorPercent: THRESHOLDS.warningFloorPercent,
    exhaustedPercent: THRESHOLDS.exhaustedPercent,
    criticalPercent: criticalPercentFor(rateLimitTier),
    // Same three keys in the same fixed order as `limits`, so the UI can zip them.
    windows: Object.fromEntries(
      Object.entries(THRESHOLDS.windows).map(([key, w]) => [key, { windowSeconds: w.windowSeconds }]),
    ),
  };
}

/** Tier lookup that cannot return an inherited member for a tier named e.g. "constructor". */
function criticalPercentFor(rateLimitTier) {
  const table = THRESHOLDS.criticalPercent;
  const value = typeof rateLimitTier === 'string' && Object.hasOwn(table, rateLimitTier)
    ? table[rateLimitTier]
    : table.default;
  return typeof value === 'number' ? value : table.default;
}

/**
 * Where each limit is read from.
 *
 * session/weekly: top-level `five_hour` / `seven_day`, which is what Claude Code's own
 * /usage panel reads. The matching limits[] entries agree to the microsecond, so they
 * serve as a fallback.
 * fable: limits[] ONLY. There is no top-level `seven_day_overage_included` on this
 * endpoint — that key belongs to the rate-limit *header* transport. The one top-level key
 * that currently mirrors Fable's values is a rotating server codename that appears nowhere
 * in the Claude Code binary, so it is not a source of truth.
 * `is_active` is only ever present on limits[] entries, so we look one up for all three.
 */
const LIMIT_SPECS = [
  { key: 'session', label: 'Current session', topLevel: 'five_hour', kind: 'session' },
  { key: 'weekly', label: 'Current week (all models)', topLevel: 'seven_day', kind: 'weekly_all' },
  { key: 'fable', label: 'Current week (Fable)', topLevel: null, kind: 'weekly_scoped', model: 'fable' },
];

// Claude Code's own payload sniff (yft/NZr): an HTTP 200 carrying none of these is an
// in-band error body, not usage data.
const PAYLOAD_KEYS = [
  'five_hour', 'seven_day', 'seven_day_oauth_apps', 'seven_day_opus',
  'seven_day_sonnet', 'cinder_cove', 'extra_usage', 'limits',
];

/** GET the usage endpoint and return the raw parsed JSON. */
export async function fetchUsage(creds = readCredentials()) {
  const { accessToken } = creds;

  let res;
  try {
    res = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // A timeout is an AbortError with no `cause`; check it before touching err.cause.
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new UsageError('ENET', `Request timed out after ${TIMEOUT_MS}ms.`);
    }
    throw new UsageError('ENET', networkMessage(err));
  }

  // The 5s signal bounds this read too, and an abort here is a DOMException whose `.code`
  // is a legacy numeric, not one of ours — so map it like any other transport failure.
  let body;
  try {
    body = await res.text();
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new UsageError('ENET', `Response body stalled and timed out after ${TIMEOUT_MS}ms.`);
    }
    throw new UsageError('ENET', networkMessage(err));
  }

  let json = null;
  try {
    json = JSON.parse(body);
  } catch { /* handled below */ }

  // The edge can answer 200 with a rate_limit_error envelope, so check the body
  // independently of the status.
  if (json?.error?.type === 'rate_limit_error') {
    throw new UsageError('ERATE', 'Usage endpoint is rate limited.', {
      status: res.status,
      retryAfterSeconds: retryAfter(res),
    });
  }
  if (res.status === 401) {
    // redact(): the only form in which a token is ever allowed out of this process.
    throw new UsageError('EAUTH', `Access token ${redact(accessToken)} was rejected. Run any Claude Code command to refresh it.`, { status: 401 });
  }
  if (res.status === 429) {
    throw new UsageError('ERATE', 'Usage endpoint is rate limited.', {
      status: 429,
      retryAfterSeconds: retryAfter(res),
    });
  }
  if (!res.ok) {
    throw new UsageError('EAPI', `Usage endpoint returned HTTP ${res.status}.`, { status: res.status });
  }
  if (!isUsagePayload(json)) {
    throw new UsageError('EAPI', 'Usage endpoint returned a body with no usage fields.', { status: res.status });
  }
  return json;
}

/** Fetch and normalize in one step, tagging the result with the plan from the credentials. */
export async function getQuota() {
  // One read for both: a second read could straddle a token refresh and tag the snapshot
  // with a plan the fetch never used.
  const creds = readCredentials();
  const raw = await fetchUsage(creds);
  return normalize(raw, { subscriptionType: creds.subscriptionType, rateLimitTier: creds.rateLimitTier });
}

/** The canonical shape the UI consumes. Always exactly three limits, always in this order. */
export function normalize(raw, plan = { subscriptionType: null, rateLimitTier: null }, now = Date.now()) {
  const entries = Array.isArray(raw?.limits) ? raw.limits : [];

  const limits = LIMIT_SPECS.map((spec) => {
    const entry = entries.find((l) =>
      l?.kind === spec.kind &&
      (!spec.model || l?.scope?.model?.display_name?.toLowerCase() === spec.model)) ?? null;
    const top = spec.topLevel ? raw?.[spec.topLevel] : null;

    // utilization and percent are the same 0-100 scale on this endpoint. (The
    // anthropic-ratelimit-unified-* headers use 0-1; do not mix the two.)
    // Number.isFinite, not typeof: JSON.parse turns an overflowing literal like 1e999 into
    // Infinity, which is a number and would poison every rate fitted over it downstream.
    const percent =
      Number.isFinite(top?.utilization) ? top.utilization
      : Number.isFinite(entry?.percent) ? entry.percent
      : null;
    const resetsAt = top?.resets_at ?? entry?.resets_at ?? null;
    const windowSeconds = THRESHOLDS.windows[spec.key].windowSeconds;

    return {
      key: spec.key,
      label: spec.label,
      percent,
      state: computeState({ key: spec.key, percent, resetsAt, rateLimitTier: plan.rateLimitTier, now }),
      // The session limit reports is_active:false while it is actively counting, so only a
      // missing reset time alongside it means the window really is dormant.
      // `percent !== null` is what makes this a statement about a real reading: without it
      // an absent payload (a cold start, a failed first poll) satisfies the other two terms
      // for all three limits at once and the dashboard opens with every ring dimmed as if
      // nothing were running. No reading is 'unknown', which is not the same as dormant.
      dormant: percent !== null && resetsAt === null && entry?.is_active !== true,
      isActive: entry?.is_active === true,
      resetsAt,
      resetsInSeconds: secondsUntil(resetsAt, now),
      // Not in the API: the fixed window length, so the UI can place the pace marker
      // (elapsed fraction) that the state rule above is computed from.
      windowSeconds,
    };
  });

  return {
    fetchedAt: new Date(now).toISOString(),
    plan: { subscriptionType: plan.subscriptionType ?? null, rateLimitTier: plan.rateLimitTier ?? null },
    limits,
    // The resolved cut points behind `state`, so the UI colours rings from real numbers.
    thresholds: resolveThresholds(plan.rateLimitTier),
    extraUsage: {
      enabled: raw?.extra_usage?.is_enabled === true,
      disabledReason: raw?.extra_usage?.disabled_reason ?? null,
    },
    // Debug aid, absent unless CCQUOTA_RAW=1 is in the environment, so the whole upstream
    // body is not in every /api/quota response and SSE frame. `serve` inherits the variable
    // like any other process would, so it is meant for a one-shot `ccquota json`.
    ...(process.env.CCQUOTA_RAW === '1' ? { raw: raw ?? null } : {}),
  };
}

/** The canonical shape with nothing in it, so a UI with no data yet still lays out. */
export function emptyQuota(now = Date.now()) {
  return normalize(null, { subscriptionType: null, rateLimitTier: null }, now);
}

// Two reset instants this close are the same window; distinct windows are hours apart.
const SAME_WINDOW_MS = 30 * 60_000;

// Two readings of one window this close are the same usage read two ways — the endpoint gives
// whole points, the status line tenths — and differ by rounding, not by anything that happened.
export const ROUNDING = 1;

// A reading dated further ahead than this is from before the clock stepped back.
export const FUTURE_SLACK_MS = 60_000;

/*
 * One window's percent from two readings of it. Within one window a percent rises but for a
 * refill or a re-scale, so where they are within ROUNDING of each other the higher stands,
 * whichever was read last: a
 * poll's 41 for a report's 41.2 is the same usage, and a trace that falls reads as a reset.
 * Further apart, the newer reading is the news — a refill (Claude Code's /limit-reset gives
 * usage back with the reset day unchanged) or a re-scaled plan — and holding the higher would
 * pin it there until the window reset, a week for the weekly one.
 */
function settle(newer, older) {
  return Math.abs(newer - older) < ROUNDING ? Math.max(newer, older) : newer;
}

/**
 * A reading from Claude Code's status line (src/statusline.js) folded into a snapshot.
 *
 * The status line carries the 5-hour and 7-day windows' percent and reset, from the rate-limit
 * headers of Claude Code's own requests, so it is usually newer than the last poll — but not
 * always: usage on claude.ai reaches only the endpoint. Neither can simply win. Where the two
 * describe one window, settle() decides, the newer of the two being whichever was read later;
 * where they describe different windows the later window wins. A report's window that is past
 * its reset is from before it — Claude Code drops a window once it resets — and is left out.
 * Everything the status line does not carry (Fable, the plan, the thresholds) stays as the
 * snapshot had it.
 *
 * But a report never brings the reading down by a point or more unless its own session saw it
 * fall (`fell`, set by src/statusline.js when the session's previous filing was that much
 * higher): a refill reaches a session as a fall. Anything else lower is an old reading come
 * late — Claude Code's input never says when its numbers were read, and every way of telling
 * has its exceptions — and the snapshot's stands. See reportConflicts().
 */
export function withReport(quota, report, now = Date.now()) {
  const base = quota ?? emptyQuota(now);
  const baseAt = snapshotAt(quota, now);
  const limits = base.limits.map((limit) => {
    const r = report.limits[limit.key];
    if (!r || Date.parse(r.resetsAt ?? '') <= now) return limit;
    let percent = r.percent, resetsAt = r.resetsAt ?? limit.resetsAt;
    if (Number.isFinite(limit.percent)) {
      const ours = Date.parse(limit.resetsAt ?? ''), theirs = Date.parse(r.resetsAt ?? '');
      const comparable = Number.isFinite(ours) && Number.isFinite(theirs);
      if (comparable && ours - theirs > SAME_WINDOW_MS) return limit;            // the snapshot's window is the later one
      if (!comparable || Math.abs(ours - theirs) <= SAME_WINDOW_MS) {
        if (limit.percent - r.percent >= ROUNDING && !r.fell) return limit;     // lower, and not seen falling: late
        percent = report.at >= baseAt ? settle(r.percent, limit.percent) : settle(limit.percent, r.percent);
        resetsAt = limit.resetsAt ?? r.resetsAt;
      }
    }
    return {
      ...limit,
      percent,
      state: computeState({ key: limit.key, percent, resetsAt, rateLimitTier: base.plan?.rateLimitTier ?? null, now }),
      dormant: resetsAt === null && limit.isActive !== true,
      resetsAt,
      resetsInSeconds: secondsUntil(resetsAt, now),
    };
  });
  // With nothing held before it, the report's own time is the reading's: an empty base is
  // stamped with now, and a reading must not come out younger than it is.
  const fetched = quota ? Math.max(baseAt, report.at) : report.at;
  return { ...base, fetchedAt: new Date(fetched).toISOString(), limits };
}

/*
 * The snapshot's time, for telling which of two readings is newer. One dated ahead of the clock
 * was taken before it stepped back, and must not outrank everything that comes after.
 */
function snapshotAt(quota, now) {
  if (!quota) return -Infinity;
  const at = Date.parse(quota.fetchedAt ?? '') || 0;
  return at - now > FUTURE_SLACK_MS ? -Infinity : at;
}

/**
 * True when a report would bring one of the snapshot's windows down by a point or more with no
 * fall seen by its session: an old reading, or news the snapshot is behind on. Either way it is
 * no reading to stand in for polls — the next poll settles which.
 */
export function reportConflicts(quota, report, now = Date.now()) {
  if (!quota) return false;
  return quota.limits.some((limit) => {
    const r = report.limits[limit.key];
    if (!r || r.fell || !Number.isFinite(limit.percent) || Date.parse(r.resetsAt ?? '') <= now) return false;
    const ours = Date.parse(limit.resetsAt ?? ''), theirs = Date.parse(r.resetsAt ?? '');
    const same = !(Number.isFinite(ours) && Number.isFinite(theirs)) || Math.abs(ours - theirs) <= SAME_WINDOW_MS;
    return same && limit.percent - r.percent >= ROUNDING;
  });
}

// The windows Claude Code's status line reports, and so the ones a report can have raised.
const REPORTED = new Set(['session', 'weekly']);

/**
 * A fresh poll folded over the reading it replaces, so that rounding cannot step the trace down.
 *
 * The poll that resumes after a run of reports can say 41 for the usage the last report called
 * 41.2; settle() keeps the 41.2, with the poll as the newer reading. Where the two describe
 * different windows the later one wins, even the held one — a reset Claude Code has already
 * seen may not have reached the endpoint yet. A poll without a reset instant says its window is
 * dormant, and is taken as it is. Everything but those two windows' numbers is the poll's.
 */
export function withHeld(quota, held, now = Date.now()) {
  if (!held) return quota;
  const limits = quota.limits.map((limit) => {
    const h = held.limits?.find((l) => l.key === limit.key);
    if (!REPORTED.has(limit.key) || !h || !Number.isFinite(h.percent) || !Number.isFinite(limit.percent)) return limit;
    const ours = Date.parse(limit.resetsAt ?? ''), theirs = Date.parse(h.resetsAt ?? '');
    if (!Number.isFinite(ours) || !Number.isFinite(theirs) || ours - theirs > SAME_WINDOW_MS || theirs <= now) return limit;
    const later = theirs - ours > SAME_WINDOW_MS; // the held window is the later one
    const percent = later ? h.percent : settle(limit.percent, h.percent);
    if (percent === limit.percent && !later) return limit;
    const resetsAt = later ? h.resetsAt : limit.resetsAt;
    return {
      ...limit,
      percent,
      state: computeState({ key: limit.key, percent, resetsAt, rateLimitTier: quota.plan?.rateLimitTier ?? null, now }),
      dormant: false,
      resetsAt,
      resetsInSeconds: secondsUntil(resetsAt, now),
    };
  });
  return { ...quota, limits };
}

export function computeState({ key, percent, resetsAt, rateLimitTier, now = Date.now() }) {
  if (!Number.isFinite(percent)) return 'unknown';
  if (percent >= THRESHOLDS.exhaustedPercent) return 'exhausted';
  if (percent >= criticalPercentFor(rateLimitTier)) return 'critical';
  if (percent < THRESHOLDS.warningFloorPercent) return 'normal';

  const elapsed = elapsedFraction(resetsAt, THRESHOLDS.windows[key].windowSeconds, now);
  if (elapsed === null) return 'normal';
  const ahead = THRESHOLDS.windows[key].pace.some((t) => percent >= t.percent && elapsed <= t.timePct);
  return ahead ? 'warning' : 'normal';
}

/** Fraction of the current quota window already elapsed, 0-1. The pace marker. */
export function elapsedFraction(resetsAt, windowSeconds, now = Date.now()) {
  const reset = Date.parse(resetsAt ?? '');
  if (!Number.isFinite(reset)) return null;
  const start = reset - windowSeconds * 1000;
  return Math.max(0, Math.min(1, (now - start) / (windowSeconds * 1000)));
}

/**
 * Seconds from `now` until an ISO instant, or null if there isn't one.
 *
 * Exported because it is a derived clock, not a stored value: the poller recomputes it at
 * serve time so a cached snapshot's countdown ticks instead of freezing at poll time.
 */
export function secondsUntil(iso, now = Date.now()) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((t - now) / 1000)); // clamped: a past reset means "resetting now"
}

function isUsagePayload(json) {
  return typeof json === 'object' && json !== null && !Array.isArray(json) &&
    PAYLOAD_KEYS.some((k) => k in json);
}

function retryAfter(res) {
  const n = Number(res.headers.get('retry-after'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function networkMessage(err) {
  const code = err.cause?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Cannot resolve api.anthropic.com — offline?';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return 'Connection to api.anthropic.com failed.';
  if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'CERT_HAS_EXPIRED' || code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return `TLS verification failed (${code}) — a proxy may be intercepting HTTPS.`;
  }
  return `Network request failed${code ? ` (${code})` : ''}.`;
}
