# ccusageviz

Live view of your Claude Code **subscription quota** — how much of the session, weekly and
Fable limits you have burned — served over HTTP and SSE on localhost.

This is quota, not spend. `ccusage` and friends read the local JSONL transcripts and price
the tokens at API list rates; that number is useful but it is *not* what your subscription
meters against, and it cannot tell you how close you are to being cut off. Only the server
knows that, and it will tell you if you ask it.

## Where the number comes from

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <accessToken from ~/.claude/.credentials.json>
anthropic-beta: oauth-2025-04-20
```

The same endpoint Claude Code's own `/usage` panel falls back to. It returns integer
percentages per limit window plus an ISO-8601 reset instant.

Field sources, which are not uniform:

| limit | read from | why |
| --- | --- | --- |
| session | top-level `five_hour.utilization` | what Claude Code's `/usage` panel reads; the matching `limits[]` entry agrees to the microsecond and is the fallback |
| weekly | top-level `seven_day.utilization` | same |
| Fable | `limits[]` where `kind === "weekly_scoped"` and `scope.model.display_name === "Fable"` | **there is no top-level key for it.** `seven_day_overage_included` belongs to the `anthropic-ratelimit-unified-*` response headers, a different transport. One rotating server codename currently mirrors Fable's values but appears nowhere in the Claude Code binary, so it is not trusted. |

`is_active` is only present on `limits[]` entries, so an entry is looked up for all three.
It is reported, never filtered on: which limits carry it flips between polls — session
`false` / weekly `true` one hour, the reverse the next, at unchanged percentages — so
filtering on it would drop the headline number at random. See `dormant` below.

Scale: on this endpoint `utilization` and `limits[].percent` are the same **0–100** scale.
(The `anthropic-ratelimit-unified-*` headers use 0–1. Do not mix them.)

## Auth: read-only, never refresh

The service reads Claude Code's existing OAuth credentials fresh on every poll and never
caches the token in memory, never writes them, and never sends the token anywhere but
`api.anthropic.com`. You do not log in to this app; it borrows the login you already have.

| platform | where the credentials come from |
| --- | --- |
| Linux | `~/.claude/.credentials.json` |
| macOS | the login Keychain — `security find-generic-password -a "$USER" -s "Claude Code-credentials"`. Most Macs have **no** `.credentials.json`, so the file is tried first and the Keychain is the fallback. A locked keychain reports itself; unlock it with `security unlock-keychain`. |

If you run Claude Code with a custom `CLAUDE_CONFIG_DIR`, macOS appends a hash of that
directory to the Keychain service name, which this app does not reproduce — point
`CCQUOTA_CREDENTIALS_PATH` at the file instead.

It deliberately does **not** refresh the OAuth token. Refresh rotates the refresh token, and
Claude Code coordinates its own refreshes behind two lock files and a compare-and-swap. An
unlocked extra writer that loses that race gets `invalid_grant`, at which point Claude Code
zeroes the credentials on disk and every running instance needs an interactive re-login.

The tradeoff: the access token lives 8 hours and Claude Code only refreshes it on demand, so
if you do not touch Claude Code for the rest of a token's life the dashboard goes stale and
shows `EAUTH`. It recovers by itself within milliseconds of your next prompt. Trading a
"stale" badge for a possible broken login is the right way round.

## Run

```sh
node bin/ccquota.js json     # one-shot JSON
node bin/ccquota.js watch    # one line per poll
node bin/ccquota.js serve    # http://127.0.0.1:8787
npm start                    # same as serve
```

No dependencies, no install step. Node >= 20.

Environment: `PORT` (default 8787), `CLAUDE_CONFIG_DIR`, `CCQUOTA_CREDENTIALS_PATH`,
`XDG_CACHE_HOME` (history cache, default `~/.cache`), `CCQUOTA_INTERVAL_MS` (poll interval,
default 120000) and `CCQUOTA_RAW=1`, which adds the raw
upstream body to `ccquota json`. `raw` is absent by default so the whole body is not in every
response and SSE frame; `serve` inherits the variable like any process would, so it is meant
for a one-shot `json`.

## Polling

120 s base interval with ±10% jitter. The numbers are integer percents and Claude Code itself
refuses to re-persist this data more than once every 5 minutes, so faster polling returns the
same payload.

| rule | value |
| --- | --- |
| floor | 60 s minimum between upstream requests, whatever schedules them (half the interval) |
| single flight | one request at a time; a tick arriving while one is open returns |
| backoff on failure | full jitter over 30 → 60 → 120 → 300 s, sticky at the last rung |
| rate limit | straight to 300 s, or `Retry-After` if longer, capped at 15 min |

The 120 s interval is measured, not chosen for politeness. At 60 s this endpoint answered
exactly five polls and refused the sixth, 47 times consecutively, then wanted ~6 minutes of
silence to recover — a sustained ceiling near **0.83 req/min**. 60 s sat just over it and lost
a poll every ten minutes to a five-minute backoff, which is strictly worse than asking less
often. 120 s is 0.50 req/min. Override with `CCQUOTA_INTERVAL_MS`; the shared floor is
derived as half the interval, so the two cannot drift apart.

The last good value keeps being served throughout. Every browser tab shares one upstream
request — the poller lives in the server process and fans out over SSE.

The floor and the backoff are both shared across processes, because the endpoint rate-limits
hard and neither guard is worth much on its own:

- **The floor** is a timestamp in `${XDG_CACHE_HOME:-~/.cache}/ccusageviz/last-request`,
  claimed under an exclusive lock file so two processes cannot take the same expired slot. A
  lock older than 5 s is debris from a killed process and gets reaped. It only covers requests
  that go *through* a poller — anything else on the machine hitting the endpoint is invisible
  to it.
- **The backoff** is in `backoff.json` beside it. A penalty that died with the process was not
  a penalty: restarting was enough to walk back into the same 429 with a clean failure count
  and an expired floor. A fresh poller now inherits the deadline and the failure count, and
  surfaces the reason on its cold start so the page can say why the first reading is late. One
  good answer clears it for every process. A corrupt file is ignored, and a deadline further
  out than the 15-minute cap is clamped, so nothing on disk can mute polling indefinitely.

`watch` sidesteps the problem entirely: if a `serve` is already listening it follows that
server's SSE feed instead of starting a second poller.

### History cache

Successful polls are appended to `${XDG_CACHE_HOME:-~/.cache}/ccusageviz/history-<account>.jsonl`,
one JSON object per line, and reloaded at startup so a restart does not blank the sparkline. The
last 360 (12 h at the base interval) are kept, and the file is compacted to that on load,
which is what bounds it. Failed polls are never recorded — a failure must not flatten the
trace. An unwritable or half-written cache is ignored, never an error.

`<account>` is a hash of the logged-in `accountUuid`, so each account keeps its own trace and
switching between them does not blend two histories into one meaningless burn rate. The account
is re-checked before *and after* every fetch, because the account that owns a reading is the one
that answered it: checking only beforehand files the first sample after a switch under the
account you just left. Switch back and the old trace returns. The rate-limit penalty is scoped
the same way; the request floor deliberately is not, since switching accounts does not make a
burst acceptable to the endpoint.

## API

`GET /api/quota` — always 200, always this shape, even when stale or empty.

```json
{
  "fetchedAt": "2026-09-04T08:09:33.083Z",
  "plan": { "subscriptionType": "max", "rateLimitTier": "default_claude_max_20x" },
  "limits": [
    {
      "key": "session",
      "label": "Current session",
      "percent": 11,
      "state": "normal",
      "dormant": false,
      "isActive": true,
      "resetsAt": "2026-09-04T11:39:59.863730+00:00",
      "resetsInSeconds": 12627,
      "windowSeconds": 18000
    }
  ],
  "thresholds": {
    "warningFloorPercent": 70,
    "exhaustedPercent": 100,
    "criticalPercent": 99.75,
    "windows": {
      "session": { "windowSeconds": 18000 },
      "weekly": { "windowSeconds": 604800 },
      "fable": { "windowSeconds": 604800 }
    }
  },
  "extraUsage": { "enabled": false, "disabledReason": null },
  "stale": false,
  "hasData": true,
  "bootedAt": "2026-09-04T08:54:58.703Z",
  "staleSince": null,
  "staleSeconds": null,
  "lastError": null
}
```

`resetsInSeconds` is recomputed on every response rather than served from the cached poll, so
the countdown ticks between polls and stays correct while the poller is stale.

`hasData` separates "the first poll has not landed yet" (`hasData: false`, `lastError: null`)
from "we had data and it went stale" — both set `stale: true`, and before this they were
indistinguishable. `staleSeconds` is the age of whichever condition applies, measured from
`staleSince`, or from `bootedAt` when there has never been a reading. It is `null` when fresh.

`limits` is **always** exactly three entries in the order `session`, `weekly`, `fable`. A
limit the API omits comes back with `percent: null` and `state: "unknown"` rather than
disappearing, so the UI never reflows.

`dormant` is `percent !== null && resetsAt === null && is_active !== true`. `is_active` on its
own is not a dormancy signal — live, the session limit reports `is_active: false` while it is
actively counting, so a missing reset instant *and* nothing claiming to count is what means the
window really is idle. The `percent !== null` term is what makes it a statement about a real
reading: without it a cold start satisfies the other two terms for all three limits at once and
the dashboard opens with every ring dimmed as if nothing were running. Having no reading is
`state: "unknown"`, which is not the same thing as dormant.

`windowSeconds` is the fixed window length (18000 / 604800), needed to place the pace marker
described below.

`thresholds` is the threshold table with the tier-dependent numbers already resolved, so the UI
can colour each ring by raw percentage instead of guessing. It is served on every snapshot
because `state` cannot carry this: `state` is pace-derived, so everything from 0% to
`warningFloorPercent` reports `normal`. Before the first poll the tier is not known yet and
`criticalPercent` is the `default` (95), so read it from the snapshot in hand rather than
caching the first one seen.

`GET /api/stream` — SSE. One `data:` frame with the same object on connect, one per poller
update or failure, and a `: ping` comment every 15 s.

`GET /api/history` — the sparkline series, plus the fit, so no client has to redo it.

```json
{
  "samples": [{ "t": 1788509381782, "p": [11, 11, 0] }],
  "intervalMs": 60000,
  "capacity": 360,
  "limits": [
    { "key": "session", "burnPercentPerHour": 1.8, "projectedAt": 1788530000000, "sinceT": 1788509381782,
      "sampleCount": 41, "spanMs": 2400000, "deltaPercent": 3, "minSampleCount": 3, "minSpanMs": 375000, "minDeltaPercent": 2 },
    { "key": "weekly", "burnPercentPerHour": null, "projectedAt": null, "sinceT": 1788509381782,
      "sampleCount": 41, "spanMs": 2400000, "deltaPercent": 1, "minSampleCount": 3, "minSpanMs": 12600000, "minDeltaPercent": 2 },
    { "key": "fable", "burnPercentPerHour": null, "projectedAt": null, "sinceT": null,
      "sampleCount": 0, "spanMs": 0, "deltaPercent": 0, "minSampleCount": 3, "minSpanMs": 12600000, "minDeltaPercent": 2 }
  ]
}
```

`t` is epoch ms and `p` is `[session, weekly, fable]` — the same fixed order as `limits`, each
entry a percent or `null`. `burnPercentPerHour` is a least-squares slope over the fitted run of
samples, `null` whenever the run fails the honesty gates below — the rate and the projection
are held to the same evidence, so the API never publishes a precise-looking rate it has just
refused to extrapolate from. `sinceT` is the timestamp of that run's first sample (`null` when
there is no run) and `sampleCount` its length, so a client can clip the sparkline to the fitted
span and tell a 40-sample trend from a 3-sample guess. `spanMs` and `deltaPercent` are the run's
elapsed time and total movement, and `minSampleCount` / `minSpanMs` / `minDeltaPercent` the
thresholds they are measured against, so a client can say WHICH gate it is still waiting on.

The run restarts at any downward step, since a percent only ever drops on a window reset, and
also at any gap longer than six poll intervals — a reset inside a gap is invisible when the new
window's first reading is already above the old window's last, and fitting across it reports a
trend that never happened.

### Finding the current run

A burn rate has to answer "at the rate I am going *now*", so the fit must not span a change of
behaviour. Fitting the whole retained trace does exactly that: 4.6 idle overnight hours inside a
12-hour buffer pulled a measured 2.7 %/hr down to 1.93 and pushed the projected cap 2.9 hours
late — optimistic, which is the wrong direction for this number to be wrong in.

Boundaries are found by recursive change-point detection. For every candidate split, a two-line
fit is compared against one line; the best split is kept only if it beats one line by 20%, and
the search then recurses into the tail, because a day holds more than one break — start work,
lunch, resume. What survives is the last segment.

Two representations are used, because the series is a **staircase**: an integer percent on a
7-day window sits flat between steps, median tread ~20 minutes.

- **Boundaries are found among the steps.** A tread is flat while the trend is sloped, so a split
  at any tread boundary improves the fit — RSS-based detection on quantized data will otherwise
  find the quantization, carving "regimes" out of single stairs and reporting 0.00 %/hr mid-climb.
  Each segment must contain at least 4 real integer steps.
- **The rate is fitted over the raw samples** inside the chosen stretch, because a growing plateau
  is how a stop becomes visible. Fitted on steps alone the rate would never fall: no new step
  arrives to say you have finished, so it would report the old burn indefinitely.

A stop produces no steps at all, so the step search structurally cannot find one — the boundary
is the event that never came. It is detected directly instead: a trailing silence longer than
three median treads means the run starts at the last step, and the fit then sees the plateau.

### Honesty gates

`burnPercentPerHour` and `projectedAt` are held to the same evidence, so the API never publishes
a precise-looking rate it has just refused to extrapolate from. Both need at least 3 samples, a
run at least `windowSeconds / 48` long (6m15s session, 3h30m weekly), **and** at least 6 integer
steps — time and steps, whichever binds harder. Time alone confirms a slow burn on too few
observations; steps alone confirm a brief flurry. Percentages arrive as integers, so a single
step is indistinguishable from quantization noise; without these, six samples over 17 minutes in
which weekly stepped 11% → 12% produced both a confident "+12.06 %/hr" on a 7-day window and,
from the same one step, "hits 100% tomorrow morning".

The basis never widens to meet the gates. Reaching back for a longer run means reaching into
different behaviour, and a wider fit can flatly contradict what you are doing now: after you stop
it keeps reporting the burn you have just ended, and during an acceleration it reports the slow
stretch that preceded it — the original defect, reintroduced through the back door. Instead the
numbers are published from the current run either way, with `provisional: true` until the gates
clear, and the UI marks those with a trailing `?`. A thin reading of what you are actually doing
beats a solid reading of something else.

Zero movement is the one exemption to the delta gate: a percent only ever drops on a reset and
the run is cut there, so `deltaPercent === 0` means every sample across a long, well-populated
run read the same percent. That is a measured flat, and it reports `0` — a real `0.00 %/hr` is
distinguishable from `null`. A run that is merely too short to have moved yet is not flat, it is
unmeasured, and reports `null`.

`projectedAt` is the epoch ms at which the limit reaches 100% at that rate. Beyond the gates it
is deliberately conservative, because a confident wrong date is worse than no date: it is `null`
when the rate is flat or falling, when the window resets first, when there is no reset instant
to check it against, and when the newest sample is older than a gap (the fit describes the past,
not the present). A `null` on either number means "still measuring", and the UI should say
exactly that.

`GET /api/cost` — the footer number, from `ccusage claude daily --json --breakdown`.

```json
{
  "fetchedAt": "2026-09-04T08:11:05.921Z",
  "sevenDayTotal": 2338.82,
  "models": [{ "name": "claude-opus-5", "cost": 1919.04 }],
  "stale": false,
  "error": null
}
```

**This is not quota.** `ccusage` prices local transcript tokens at API list rates and the
subscription does not meter against it, so it must never be summed with, or drawn on the same
axis as, a quota percentage.

Rolling 7 days ending today, `models` sorted by cost descending, cached 5 minutes. An expired
cache is served at once with `stale: true` while a single refresh runs behind it, so only the
very first call waits for the subprocess. It never throws: a missing binary comes back as
`error.code` `ENOCCUSAGE`, a slow one `ETIMEOUT`, unparseable output `EPARSE`, anything else
`ECCUSAGE` — each with the last good numbers still attached. `ccusage` is not a dependency of
this package; without it the footer just says so.

`GET /healthz` — `{"ok":true,"version":"0.1.0"}`.

Static files under `public/` are served if the directory exists.

### Access

The server binds `127.0.0.1` only — this is personal account data — and then checks `Host`,
plus `Origin` when one is present, against loopback, because binding to loopback does not stop
a web page from pointing its own hostname at 127.0.0.1. Anything else gets 403. No CORS
headers are sent. `GET` and `HEAD` only, and `/api/stream` is `GET` only.

### Errors

| code | meaning |
| --- | --- |
| `ENOCREDS` | credentials file missing or unreadable |
| `EBADCREDS` | present but not valid JSON, or no `claudeAiOauth.accessToken` |
| `EAUTH` | HTTP 401 — token rejected; run any Claude Code command to refresh it |
| `ERATE` | HTTP 429, or a 200 carrying a `rate_limit_error` envelope |
| `ENET` | DNS, TLS, connection or 5 s timeout |
| `EAPI` | other non-2xx, or a 200 with no usage fields in it |

A failure never blanks the response. It sets `stale: true`, `staleSince` and `lastError`
while the last good numbers keep being served. `lastError.message` over HTTP is a generic
string keyed by code: the internal messages name the credentials file, which would hand the
browser the home path. The detailed message goes to the CLI and stderr instead.

## The `state` field

Ported from Claude Code's own rule (binary symbols `qZr`, `Dnn`, `reo`), which is not a
percent ladder: a warning needs the utilization to be high **and** the window to be
under-elapsed. You are warned for burning ahead of the clock, and the warning clears once
the clock catches up — 95% of a 5-hour window with 80% of the window gone is fine, because
you will land roughly on time. Under 70% no warning is possible at all.

```
session   90% used before 72% of the 5h window has elapsed
weekly    75% used before 60% of the 7d window has elapsed
critical  99.75% on max_20x, 99% on max_5x, 95% otherwise
exhausted 100%
```

Thresholds live in one exported constant, `THRESHOLDS` in `src/usage.js`. The 25%/50% weekly
tiers are in there to match the source but can never fire — the 70% floor kills them.

The elapsed fraction is worth surfacing on its own; `elapsedFraction()` is exported for it.
A ring reading 9% is still in trouble if only 3% of the window has gone.

## Layout

```
src/credentials.js   read the token from disk, redact it everywhere else
src/usage.js         fetch, normalize, thresholds, typed errors
src/poller.js        interval + backoff + last-good cache + sample history, EventEmitter
src/server.js        http, SSE, static, loopback guard
src/cost.js          ccusage subprocess, cached — the footer number, not quota
bin/ccquota.js       json | watch | serve
```
