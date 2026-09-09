import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// ccusage reads the local JSONL transcripts and prices the tokens at API list rates. That is
// token accounting, NOT subscription quota: none of it meters against the plan the rings show,
// so these numbers must never be summed with, or drawn on the same axis as, a quota percentage.
const BIN = 'ccusage'; // resolved from PATH — execFile, never a shell, so no argv quoting to get wrong
const ARGS = ['claude', 'daily', '--json', '--breakdown'];
const TIMEOUT_MS = 20_000;
const MAX_BUFFER = 32 * 1024 * 1024; // months of daily rows, each with a per-model breakdown
const TTL_MS = 300_000; // the subprocess costs seconds; the footer does not need it fresher
const WINDOW_DAYS = 7;

let cached = null; // { at, payload } from the last successful run
let inflight = null;
let child = null; // the ChildProcess behind `inflight`, so shutdown can end it

/**
 * { fetchedAt, sevenDayTotal, models: [{ name, cost }], stale, error }, models by cost desc.
 *
 * Never throws and never blocks on a second subprocess: a stale copy is served while a refresh
 * runs, and a missing binary or a broken run comes back as `error` with the last good numbers
 * still attached. Only the very first call has to wait for ccusage.
 */
export async function getCost(now = Date.now()) {
  if (cached && now - cached.at < TTL_MS) return cached.payload;
  const refresh = start();
  return cached ? { ...cached.payload, stale: true } : refresh;
}

function start() {
  if (inflight) return inflight; // the single flight: concurrent callers reuse the one subprocess
  // promisify(execFile) hangs the ChildProcess off the promise it returns. Keep it: without a
  // handle there is nothing to kill, and ccusage takes seconds — a SIGTERM arriving mid-refresh
  // would leave it running, reparented to init, long after the server it was working for is gone.
  const running = run(BIN, ARGS, { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
  child = running.child;
  inflight = running
    .then(({ stdout }) => {
      const payload = summarize(JSON.parse(stdout), Date.now());
      cached = { at: Date.now(), payload };
      return payload;
    })
    .catch(failure)
    .finally(() => { inflight = null; child = null; });
  return inflight;
}

/**
 * End a refresh that is still running, for shutdown.
 *
 * Safe to call at any time: with nothing in flight it does nothing, and a kill lands on the
 * promise as an ordinary failed run — already caught, so no unhandled rejection and no throw
 * out of close(). The caller is exiting; the stale payload it produces goes nowhere.
 */
export function stopCost() {
  child?.kill('SIGTERM');
  child = null;
}

/** Rolling 7 days ending today. ccusage's `date` is a local-time YYYY-MM-DD, so compare as one. */
function summarize(json, now) {
  const since = localDate(now - (WINDOW_DAYS - 1) * 86_400_000);
  const days = (Array.isArray(json?.daily) ? json.daily : []).filter((d) => d?.date >= since);

  const byModel = new Map();
  let total = 0;
  for (const day of days) {
    total += day.totalCost ?? 0;
    for (const model of day.modelBreakdowns ?? []) {
      byModel.set(model.modelName, (byModel.get(model.modelName) ?? 0) + (model.cost ?? 0));
    }
  }

  return {
    fetchedAt: new Date(now).toISOString(),
    sevenDayTotal: cents(total),
    models: [...byModel]
      .map(([name, cost]) => ({ name, cost: cents(cost) }))
      .sort((a, b) => b.cost - a.cost),
    stale: false,
    error: null,
  };
}

function failure(err) {
  return { ...(cached?.payload ?? empty()), stale: true, error: describe(err) };
}

function empty(now = Date.now()) {
  return { fetchedAt: new Date(now).toISOString(), sevenDayTotal: 0, models: [] };
}

function describe(err) {
  if (err.code === 'ENOENT') return { code: 'ENOCCUSAGE', message: 'ccusage is not installed or not on PATH.' };
  if (err.killed) return { code: 'ETIMEOUT', message: `ccusage did not finish within ${TIMEOUT_MS}ms.` };
  if (err instanceof SyntaxError) return { code: 'EPARSE', message: 'ccusage printed output that is not JSON.' };
  // Anything else is a subprocess that ran and failed, and execFile builds its message as
  // `Command failed: <the whole command line>\n<everything ccusage wrote to stderr>`. The
  // first line therefore always names the binary and its arguments, and the rest can be a
  // stack trace naming the operator's home directory — none of which the browser asked for
  // or needs. The operator gets it on stderr; the page gets a sentence.
  logDetail(err);
  return { code: 'ECCUSAGE', message: 'ccusage exited with an error. See the ccquota log.' };
}

let loggedAt = 0;

/**
 * The detail, at most once per TTL, and never more than a sample of it.
 *
 * Only successful runs are cached, so a page that keeps asking for /api/cost keeps
 * re-running ccusage — one log line per failure would just move the flood from the response
 * to the disk. And `err.message` carries the subprocess's whole stderr, up to MAX_BUFFER.
 */
function logDetail(err, now = Date.now()) {
  if (now - loggedAt < TTL_MS) return;
  loggedAt = now;
  const text = String(err.message ?? '');
  const sample = text.length > 2000 ? `${text.slice(0, 2000)}… (${text.length} bytes)` : text;
  process.stderr.write(`ccquota: ccusage failed: ${sample}\n`);
}

function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function cents(n) {
  return Math.round(n * 100) / 100;
}
