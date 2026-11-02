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
node bin/ccquota.js json         # one-shot JSON
node bin/ccquota.js watch        # one line per reading
node bin/ccquota.js serve        # http://127.0.0.1:8787
npm start                        # same as serve
node bin/ccquota.js statusline   # Claude Code's status line (see below); reads JSON on stdin
```

No dependencies, no install step. Node >= 20.

Environment: `PORT` (default 8787), `CLAUDE_CONFIG_DIR` (Claude Code's config directory: its
credentials, and the `settings.json` the status line is set in), `CCQUOTA_CREDENTIALS_PATH`,
`XDG_CACHE_HOME` (the history and the status line's reports, default `~/.cache`; the
directory `serve` uses is written into the status line command, so the reports land where the
server looks), `XDG_STATE_HOME` (where a status line you took out is remembered, default
`~/.local/state`), `CCQUOTA_INTERVAL_MS` (poll interval, default 120000),
`CCQUOTA_STATUSLINE=off` (never touch Claude Code's status line setting) and
`CCQUOTA_RAW=1`, which adds the raw
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
- **The backoff** is in `backoff-<account>.json` beside it, scoped the same way. A penalty that died with the process was not
  a penalty: restarting was enough to walk back into the same 429 with a clean failure count
  and an expired floor. A fresh poller now inherits the deadline and the failure count, and
  surfaces the reason on its cold start so the page can say why the first reading is late. One
  good answer clears it for every process. A corrupt file is ignored, and a deadline further
  out than the 15-minute cap is clamped, so nothing on disk can mute polling indefinitely.

`watch` sidesteps the problem entirely: if a `serve` is already listening it follows that
server's SSE feed instead of starting a second poller.

### Claude Code's status line

The better answer to a rate-limited endpoint is to ask it less. Claude Code passes a custom
status line command its session as JSON on stdin, and for Pro, Max and Ultra subscribers that
JSON carries `rate_limits.seven_day` and `rate_limits.five_hour`: `used_percentage` (0-100, in
tenths) and `resets_at` (epoch seconds), from the rate-limit headers of Claude Code's own
requests. The status line runs after every reply, so that is a reading that costs no request at
all, taken the moment the reply came in.

The input never says when its numbers were read, though. The status line also runs when nothing
new has been — on a mode, model or effort change, a vim toggle, `/clear`, a change to the
command itself, and on Claude Code's timers at a prompt cache's expiry and a window's reset —
and a reply's own run can come late: a permission dialog holds it back until it is answered,
and a newly set command runs at once in every open session on whatever that session last read.
Filed as of the run, those would pass an old reading off as a fresh one and hold polling off on
the strength of it. So a run is filed only when it follows a reply: when `prompt_cache.requests`,
the session's count of the main-conversation requests it has recorded, has moved since that
session last filed. Re-runs and background queries (a recap, a memory pass) do not move it.
Without the count the session has had no reply yet (a fresh start, or just after `/clear`) and
the numbers are the process's old ones, so nothing is filed. The reading is dated by the request
it came from — `prompt_cache.expires_at` less its TTL is when the main conversation last sent
one, or touched its cache — so a run held back by a dialog usually files an old reading as old,
which the poller passes over. A session's first sighting is filed as a baseline the poller
ignores, whatever its date: a newly set command runs at once on whatever an open session last
read. Claude Code before 2.1.251 sends no `prompt_cache`; there the session's API time
(`cost.total_api_duration_ms`) stands in for the count. One reading is news whatever the count:
in a session with replies of its own, a window it had below 100% now at 100% — the refused
request (a 429) that comes when you hit a limit. It moves no count, and its run follows it at
once.

None of this is airtight, and cannot be: the input carries no time for its numbers. A request
interrupted with Esc moves the count but brings no reading, and Claude Code's cache keepalive,
where it is on, moves `expires_at` every 30 s. So the merge below has one more rule, which holds
whatever got through: a report never brings the reading down by a point or more unless its own
session saw that fall (the report marks such a window `fell`) — a refill reaches every session
that way. A report that would bring it down otherwise is an old reading come late: it changes
nothing, and it does not stand in for polls, so the next poll settles it.

`ccquota statusline` is that command. It files each reading in
`${XDG_CACHE_HOME:-~/.cache}/ccusageviz/statusline-<account>-<session>.json` — one file per
session, so two sessions filing at once cannot undo each other — and prints a short line: the
model and the week, e.g. `Opus 4.7 · week 41% · 5d 11h left`. The poller looks at those files
every 2 s, takes the newest report as the reading, which reaches the page over SSE at once, and
sweeps files a session has not touched for 8 days. The page says `via Claude Code` while that
is where its numbers come from. While a report is under 5 minutes old the poller does not poll
at all, except for one request at start (and after an account switch) for what reports do not
carry: the plan, its thresholds, Fable. It polls again once Claude Code has been quiet for 5
minutes — when you are on claude.ai, say — when a window passes its reset, since Claude Code
drops a window from its readings the moment it resets and only a poll brings the new one in,
and to retry a failed poll once its backoff is over.

Reports and polls replace each other only when they are a point or more apart. The endpoint
gives whole points and the status line tenths, so the poll that resumes after a run of reports
can say 41 for the usage the last report called 41.2; within one window, two readings less than
a point apart are the same usage, and the higher stands, so the trace does not step down for it.
Further apart, the newer reading wins — though a report wins downwards only with `fell`, as
above: a percent only falls within a window when usage is given back — Claude Code's
`/limit-reset` refills a limit and leaves its reset day as it was — or a plan change re-scales
it, and holding the higher number would pin it there until the window reset. Where the two
describe different windows, the later window wins; a report's window that is past its reset is
dropped. A report older than 5 minutes, torn mid-write or from the future is ignored, and a busy
session's reports are sampled into the history at most once per interval, so its twelve hours
keep their shape.

A poll that fails while reports are fresh does not mark the reading stale — the reports are the
reading — but it is kept, and retried once its backoff is over: once the reports stop, the
reading is stale from that moment, with the poll's reason, even if the next poll is a backoff
away.

`ccquota serve` sets the status line in Claude Code's user settings
(`$CLAUDE_CONFIG_DIR/settings.json`, default `~/.claude/settings.json`) **only when it is
unset**, and says so on start:

- a status line of your own is never touched. *Ours* is exactly the command it writes — an
  `XDG_CACHE_HOME=` naming the server's cache directory, a node, a `bin/ccquota.js`, `statusline`
  and nothing else (or a bare `ccquota statusline`); a command that merely mentions it, such as
  a pipeline, is yours. The poller polls for you, unless your line runs ours too (below): serve
  recognises that when it is in the command itself, not inside a script it runs;
- one that is ours but points at another copy, another node or another cache directory is
  pointed at this one. The cache directory is always written into the command, so the reports
  land where the server reads them whatever Claude Code's own environment says;
- once ours is there, that is remembered (`statusline-installed.json` in
  `${XDG_STATE_HOME:-~/.local/state}/ccusageviz`, not the cache, so clearing a cache cannot undo
  it): if you take it out, it stays out, and `ccquota statusline install` puts it back;
- the file is written to a temp file, synced, and renamed over it, with its permissions, and
  only if nothing else wrote it meanwhile; a symlinked settings.json is written through, never
  replaced; invalid JSON is left alone, and a write that fails says why (`EACCES`, …);
- `CCQUOTA_STATUSLINE=off` turns all of it off, and on Windows it is not set at all: Claude Code
  runs status lines there through PowerShell unless it finds Git Bash, and the command is a
  POSIX one.

Claude Code watches its settings and runs a new status line command at once, in sessions already
open too; a session opened on an older Claude Code may not pick it up until it is restarted
(`claude --continue` picks the conversation back up). The status line only runs in a folder
whose workspace trust you have accepted, not under `disableAllHooks` (serve says so when it is in
the same settings) or a managed `allowManagedHooksOnly`, and a project or local `statusLine`
takes precedence over the user one.
And `rate_limits` is only sent to Pro, Max and Ultra plans: on others the line shows just the
model and the dashboard polls as before.

To keep a status line of your own and still feed the dashboard, hand the session JSON to both,
naming the server's cache directory the way ours does:

```sh
input=$(cat); printf '%s' "$input" | XDG_CACHE_HOME=~/.cache node /path/to/ccmonitor/bin/ccquota.js statusline >/dev/null; printf '%s' "$input" | ~/.claude/my-statusline.sh
```

With a custom status line, Claude Code stops showing some footer hints (`esc to interrupt`,
`? for shortcuts`); that is Claude Code's behaviour for any status line.

### History cache

Successful polls, and status line reports at most once an interval, are appended to
`${XDG_CACHE_HOME:-~/.cache}/ccusageviz/history-<account>.jsonl`,
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
  "source": "poll",
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

`source` says where the newest reading came from: `"poll"` (the usage endpoint),
`"statusline"` (a Claude Code status line report, see above), or `null` before either. While a
fresh report stands in for polls, a failed poll does not set `stale`, `staleSince` or
`lastError`; once the reports stop, they say so from that moment.

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

`GET /api/stream` — SSE. One `data:` frame with the same object on connect, and one per poller
update or failure: a poll, a status line report, or a tick that stood aside for one. Every 15 s
there is an `event: ping` with no reading in it — a named event rather than a comment, so a
client can see it: long quiet stretches are normal while reports stand in for polls, and the
page tells a live link from a dead one by its frames.

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
      "seRatePercentPerHour": 1.31, "etaUncertaintySeconds": 2040,
      "sampleCount": 10, "spanMs": 1080000, "deltaPercent": 4, "minSampleCount": 3 }
  ]
}
```

`t` is epoch ms and `p` is `[session, weekly, fable]` — the same fixed order as `limits`, each
entry a percent or `null`. `burnPercentPerHour` is a least-squares slope over the current run,
`null` only when there is nothing to fit at all. `seRatePercentPerHour` is its standard error
and `etaUncertaintySeconds` the spread that propagates to the projection, so a client can show
`13:16 ± 6 min` instead of an unqualified time. `sinceT` is the timestamp of the run's first
sample (`null` when there is no run) and `sampleCount` its length, so a client can clip the
sparkline to the fitted span.

The run restarts at any downward step of a point or more, since a percent only falls at a
window reset, a refill or a re-scaled plan, and a new run starts there whichever it was — a
smaller dip is the same usage read in whole points by the endpoint and in tenths by the status
line — and also at any gap longer than six poll intervals — a reset inside a gap is invisible when the new
window's first reading is already above the old window's last, and fitting across it reports a
trend that never happened.

### Finding the current run

A burn rate has to answer "at the rate I am going *now*", so the fit must not span a change of
behaviour. Fitting the whole retained trace does exactly that: 4.6 idle overnight hours inside a
12-hour buffer pulled a measured 2.7 %/hr down to 1.93 and pushed the projected cap 2.9 hours
late. Optimistic is the wrong direction for this number to be wrong in — it reports runway that
is not there. The same fault on the 5-hour window averaged 28 points burned in 12 minutes
against 30 flat minutes before them, and published a rate four times too low.

The run is found by penalised-likelihood segmentation. For every candidate split, a two-line
model is scored against one line by **BIC** — log-likelihood plus `k·ln(n)` — and the split is
taken only if it repays its two extra parameters out of the fit it buys. Recursing into the tail
finds the most recent break of several, which is the one that describes now. Prefix sums make
any sub-range fit O(1), so a full pass over 360 samples costs about 0.2 ms.

Nothing here is tuned, and the reason is that the noise level is **known** rather than
estimated: a percent arrives rounded, so its variance is 1/12, the variance of rounding to the
nearest integer. Scoring against a known sigma-squared is what lets a genuine level shift repay
its parameters while a split that merely carves up a staircase tread cannot — a staircase
already sits at exactly that noise level, so dividing one buys nothing. Quantization, which is
what makes a slow series look flat between steps and defeated several earlier attempts at this,
is exactly what makes the criterion work unaided. Status line reports come in tenths, whose
rounding noise is a hundredth of that; for a run of them 1/12 is an upper bound rather than the
known level, which errs towards fewer splits and a wider standard error, never towards a trend
the data cannot support.

Estimating the variance from the data instead was subtly wrong, and the symptom was precise:
when both the one-line and two-line models sat at the floor their likelihoods tied, BIC took the
cheaper one, and a real stop went unfound. The run kept ten samples of the burn preceding it and
reported 0.16 %/hr for someone who had put the laptop down. With the variance known, the same
case finds the stop exactly and reports 0.00, within half an hour of it happening.

The floor still appears once more, in the right place: the residual variance behind the standard
error is floored at 1/12 too. A run that happens to sit exactly on a line still cannot be known
more precisely than the rounding that produced it, and a standard error of zero would claim
otherwise.

An idle stretch, a full stop and a change of pace are all the same thing to it: a split that
pays for itself. An earlier version needed a minimum split gain, a minimum segment length
counted in integer steps, a change-point search moved into step space to dodge the treads, a
separate flat-gap detector for the leading idle that step space could not see, a stall detector
for the stop that produces no steps at all, and an ordering fix to keep the candidates straight
— six constants and four mechanisms, each added to patch what the last one missed. All of it is
gone.

Against seven synthetic regimes — idle-then-burn, burn-then-stop, slow-to-fast, steady, pure
idle, burn/lunch/burn, and three consecutive rates — this recovers the true current rate in all
seven. Exponentially weighted least squares managed six and a Gamma-Poisson filter with
forgetting four; both assume the rate drifts, and this one changes abruptly.

### Uncertainty, not gates

The rate carries the standard error of its slope, and the projection carries the spread that
follows from it. `provisional` is set when that spread is wide relative to how far ahead the
projection sits, and the UI marks those with a trailing `?` — "01:15 give or take four hours" is
not a time.

This replaced three gates (at least 3 samples, a run at least `windowSeconds / 48` long, and
movement of at least 2 percentage points, later joined by a minimum step count). Every one was a
proxy for *is this trend resolved yet*, asked in a unit the reader does not care about. The
standard error asks it directly, and unlike a gate it can be shown: `± 6 min` on the session
window and `± 34 min` on the weekly one say what a bare `?` could not.

A well-sampled flat run is still distinguishable from an absent one. A percent only falls at a
reset, a refill or a re-scale, and the run is cut there, so a flat run reports a real `0.00 %/hr` with a small
standard error, while too little data to fit reports `null` and the UI says "measuring".

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

Static files are the dashboard page, `public/index.html`, the typefaces it uses, in
`public/fonts/` (their licences sit beside them and are not served), and the Train theme's sprite
sheet, `public/sprites/train.png`. Only those exact files are served — an allowlist in `src/server.js`,
not the directory — and the page's CSP lets it load fonts from this server alone. The page draws the weekly limit alone — the session limit is gone upstream
and Fable is not used — while the API above keeps reporting all three.

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
src/statusline.js    Claude Code's status line: file its usage reports; set it if unset
src/paths.js         the cache and Claude Code directories
src/cost.js          ccusage subprocess, cached — the footer number, not quota
bin/ccquota.js       json | watch | serve | statusline
public/index.html    the dashboard: one page, inline style and script
public/fonts/        bundled typefaces, with their licences and provenance
public/sprites/      the Train theme's sprite sheet, built from art/
art/                 the sprites' sources: Aseprite Lua and the packer; not served or shipped
```

### Colour across the warning band

The arc's colour ramps from `--warning` at the served warning floor all the way to
`--exhausted` at the cap, rather than stopping at `--critical`. On a `default_claude_max_20x`
tier the critical cut is 99.75 — a quarter-point from the cap — so an amber→orange ramp had to
cover 70 → 99.75 with only 0.138 of relative luminance to spend, and 75% and 95% came out a
hundredth apart. Amber→red covers the same span with 0.241 and measures better on both counts:
wider range, and a larger worst-case gap between two readings someone would actually compare.

Reparametrising was tried first and cannot help. Every easing tested (exponents 0.85 down to
0.5) made the worst adjacent gap *smaller* than linear, because the constraint is the range
available, not how it is distributed. Linear over the wider range wins outright.

The band boundaries are unchanged — they are still exactly what the API serves, and
`--critical` keeps its own mark at its served position. What changes is only the colour
partway up.

Marks on the track are all *ahead* of the arc; drawing the ones behind it answers a question
already settled. A **served** cut point is drawn full strength, a **station** — a quarter point
of the band, where the colour steps but nothing official happens — is drawn lighter. Marks
closer together than they can be drawn apart collapse to the higher, which folds the 99.75 cut
into the cap. At 100% nothing is drawn, because nothing is ahead. The Matrix terminal draws
every mark, the passed ones too: they have a row of their own above its bar, where nothing
covers them, and read as the bar's scale.
