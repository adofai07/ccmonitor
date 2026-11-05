#!/usr/bin/env node
// Each command loads only what it uses: Claude Code runs `statusline` after every reply, and
// it should not pay for the server, the poller and the cost reader just to print one line.

const HELP = `ccquota — live Claude Code subscription quota

  ccquota json        print the current quota as JSON and exit
  ccquota watch       print a one-line status as each reading comes in
  ccquota serve       run the local HTTP + SSE server (default port 8787); sets Claude Code's
                      status line to the command below if it is unset
  ccquota statusline  Claude Code's status line: reads the session JSON on stdin, files the
                      usage it carries for the dashboard, prints a short line
  ccquota statusline install
                      set it in Claude Code's settings even if it was taken out before
                      (never over a status line of your own)

Options
  --help           this message

Environment
  PORT                       server port (default 8787, loopback only)
  CLAUDE_CONFIG_DIR          Claude Code's config directory: its .credentials.json, and the
                             settings.json serve sets the status line in (default ~/.claude)
  CCQUOTA_CREDENTIALS_PATH   full path to the credentials file, overrides the above; its
                             account is the one in the .claude.json beside it
  XDG_CACHE_HOME             where the sample history and the status line's reports are kept
                             (default ~/.cache); set for serve, it goes into the status line
  XDG_STATE_HOME             where a status line you took out is remembered (default
                             ~/.local/state)
  CCQUOTA_INTERVAL_MS        poll interval (default 120000; the endpoint refuses
                             sustained rates much above 0.83 req/min)
  CCQUOTA_RAW=1              add the raw upstream body to \`json\` output (debug)
  CCQUOTA_STATUSLINE=off     never touch Claude Code's status line setting
`;

/* what serve says about Claude Code's status line, once, at start, and `statusline install` says */
const STATUSLINE_SAYS = {
  installed: 'set Claude Code\'s status line (it was unset) — the dashboard now updates after every Claude Code reply; a session opened on an older Claude Code may need a restart to pick it up',
  updated: 'pointed Claude Code\'s status line at this copy of ccquota and its cache directory',
  present: 'Claude Code\'s status line is ccquota\'s',
  theirs: 'Claude Code has a status line of your own, left as it is — the dashboard takes its readings if it runs `ccquota statusline`, and polls the endpoint otherwise',
  feeds: 'Claude Code has a status line of your own that also runs ccquota\'s, left as it is',
  removed: 'left out of Claude Code\'s status line, as you took it out — `ccquota statusline install` puts it back',
  invalid: 'Claude Code\'s settings.json is not valid JSON, so it was left alone — polling the endpoint instead',
  busy: 'Claude Code\'s settings.json changed while being updated; trying again next start',
  failed: 'could not update Claude Code\'s settings.json',
  off: 'CCQUOTA_STATUSLINE is off, so Claude Code\'s settings were left alone',
  'no-claude': 'found no Claude Code config directory (CLAUDE_CONFIG_DIR, or ~/.claude) to set it in',
  unsupported: 'not set on Windows, where Claude Code may run it through PowerShell — polling the endpoint instead',
};
// serve keeps quiet about these: nothing was asked of it, and nothing was done
const QUIET = new Set(['off', 'no-claude']);
const SET = new Set(['installed', 'updated', 'present', 'feeds']);

function said({ outcome, code, hooksOff }) {
  const text = STATUSLINE_SAYS[outcome] ?? outcome;
  if (outcome === 'failed' && code) return `${text} (${code})`;
  if (hooksOff) {
    const what = outcome === 'installed' ? 'set Claude Code\'s status line (it was unset)' : 'Claude Code\'s status line is ccquota\'s';
    return `${what}, but disableAllHooks is on in those settings, and with it Claude Code runs no status line of yours — polling the endpoint instead`;
  }
  return text;
}

const [command = '--help', sub] = process.argv.slice(2);

try {
  if (command === 'json') await cmdJson();
  else if (command === 'watch') await cmdWatch();
  else if (command === 'serve') await cmdServe();
  else if (command === 'statusline') await cmdStatusline(sub);
  else if (command === '--help' || command === '-h' || command === 'help') process.stdout.write(HELP);
  else fail(`unknown command: ${command}\n\n${HELP}`);
} catch (err) {
  fail(`${err.code ?? 'ERROR'}: ${err.message}`);
}

async function cmdJson() {
  const { getQuota } = await import('../src/usage.js');
  const quota = await getQuota();
  process.stdout.write(`${JSON.stringify(quota, null, 2)}\n`);
}

async function cmdWatch() {
  // A second poller beside a running `serve` is a second stream of upstream requests for
  // the same numbers. If the server is already up, read its feed instead: one request
  // rate, and the terminal shows exactly what the dashboard shows.
  const url = `http://127.0.0.1:${process.env.PORT ?? 8787}`;
  if (await streamFrom(url)) return;
  const { QuotaPoller } = await import('../src/poller.js');
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
    // SSE frames are separated by a blank line; the server's heartbeat is a named `ping`
    // event with no reading in it.
    let cut;
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      if (frame.split('\n').some((l) => l.startsWith('event:') && l.slice(6).trim() !== 'message')) continue;
      const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (!data) continue;
      try { console.log(line(JSON.parse(data))); } catch { /* a truncated frame is not worth a crash */ }
    }
  }
  console.log('feed closed — the server stopped');
  return true;
}

async function cmdServe() {
  const { serve } = await import('../src/server.js');
  const { url } = await serve();
  console.log(`ccquota serving on ${url}`);
  console.log('  /api/quota  /api/stream  /api/history  /api/cost  /healthz');
  const { ensureStatusLine } = await import('../src/statusline.js');
  const result = ensureStatusLine();
  if (!QUIET.has(result.outcome)) console.log(`  status line: ${said(result)}`);
}

async function cmdStatusline(sub) {
  const { ensureStatusLine, statusline } = await import('../src/statusline.js');
  if (sub === 'install') {
    const result = ensureStatusLine({ force: true });
    console.log(said(result));
    if (!SET.has(result.outcome)) process.exitCode = 1;
    return;
  }
  if (sub !== undefined) fail(`unknown statusline command: ${sub} (\`ccquota statusline install\`, or none)`);
  await statusline();
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
