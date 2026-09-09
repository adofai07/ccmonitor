#!/usr/bin/env node
import { getQuota } from '../src/usage.js';
import { QuotaPoller } from '../src/poller.js';
import { serve } from '../src/server.js';

const HELP = `ccquota — live Claude Code subscription quota

  ccquota json     print the current quota as JSON and exit
  ccquota watch    print a one-line status on every poll
  ccquota serve    run the local HTTP + SSE server (default port 8787)

Options
  --help           this message

Environment
  PORT                       server port (default 8787, loopback only)
  CLAUDE_CONFIG_DIR          directory holding .credentials.json (default ~/.claude)
  CCQUOTA_CREDENTIALS_PATH   full path to the credentials file, overrides the above
  XDG_CACHE_HOME             where the sample history is kept (default ~/.cache)
  CCQUOTA_INTERVAL_MS        poll interval (default 120000; the endpoint refuses
                             sustained rates much above 0.83 req/min)
  CCQUOTA_RAW=1              add the raw upstream body to \`json\` output (debug)
`;

const [command = '--help'] = process.argv.slice(2);

try {
  if (command === 'json') await cmdJson();
  else if (command === 'watch') await cmdWatch();
  else if (command === 'serve') await cmdServe();
  else if (command === '--help' || command === '-h' || command === 'help') process.stdout.write(HELP);
  else fail(`unknown command: ${command}\n\n${HELP}`);
} catch (err) {
  fail(`${err.code ?? 'ERROR'}: ${err.message}`);
}

async function cmdJson() {
  const quota = await getQuota();
  process.stdout.write(`${JSON.stringify(quota, null, 2)}\n`);
}

async function cmdWatch() {
  // A second poller beside a running `serve` is a second stream of upstream requests for
  // the same numbers. If the server is already up, read its feed instead: one request
  // rate, and the terminal shows exactly what the dashboard shows.
  const url = `http://127.0.0.1:${process.env.PORT ?? 8787}`;
  if (await streamFrom(url)) return;
  const poller = new QuotaPoller();
  poller.on('update', (snapshot) => console.log(line(snapshot)));
  poller.on('error', (err, snapshot) => console.log(`${line(snapshot)}  [${err.code}: ${err.message}]`));
  poller.start();
}

/** Returns false if no server is listening, so the caller can fall back to its own poller. */
async function streamFrom(url) {
  let res;
  try {
    res = await fetch(`${url}/api/stream`, { headers: { accept: 'text/event-stream' } });
  } catch {
    return false;
  }
  if (!res.ok || !res.body) return false;
  console.log(`following ${url} — no second poller started`);
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += Buffer.from(chunk).toString('utf8');
    // SSE frames are separated by a blank line; comments (": ping") carry no data field.
    let cut;
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (!data) continue;
      try { console.log(line(JSON.parse(data))); } catch { /* a truncated frame is not worth a crash */ }
    }
  }
  console.log('feed closed — the server stopped');
  return true;
}

async function cmdServe() {
  const { url } = await serve();
  console.log(`ccquota serving on ${url}`);
  console.log('  /api/quota  /api/stream  /api/history  /api/cost  /healthz');
}

function line(snapshot) {
  const clock = new Date().toTimeString().slice(0, 8);
  const cells = snapshot.limits.map((l) => {
    const pct = l.percent === null ? '  --' : `${String(Math.floor(l.percent)).padStart(3)}%`;
    return `${l.key} ${pct} ${l.state.padEnd(8)} ${resets(l).padStart(7)}`;
  });
  return `${clock}  ${cells.join(' │ ')}${snapshot.stale ? '  (stale)' : ''}`;
}

// resetsInSeconds is null for a dormant window AND for a limit the API told us nothing
// about, which are opposite claims. state and dormant are what separate them: an unknown
// limit has no percent either, so there is nothing there to call dormant.
function resets(limit) {
  if (limit.state === 'unknown') return 'no data';
  if (limit.dormant) return 'dormant';
  if (limit.resetsInSeconds === null) return '--'; // counting, but with no reset instant given
  return duration(limit.resetsInSeconds);
}

function duration(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function fail(message) {
  process.stderr.write(`ccquota: ${message}\n`);
  process.exit(1);
}
