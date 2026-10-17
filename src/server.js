import { createServer } from 'node:http';
import { open, realpath, stat } from 'node:fs/promises';
import { constants, readFileSync, realpathSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { QuotaPoller } from './poller.js';
import { getCost, stopCost } from './cost.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Resolved once, up front, because serveStatic anchors a fully resolved real path against
// this: an install reached through a symlinked parent (/home -> /mnt/home, a git worktree,
// a packaged copy) would otherwise refuse every file it owns. If public/ does not exist yet
// the plain join stands in — nothing is servable through it either way — which does mean a
// public/ that is itself made a symlink after startup fails closed.
const PUBLIC_DIR = resolveDir(join(ROOT, 'public'));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const HEARTBEAT_MS = 15_000;

// Binding to loopback does not keep a web page out: any site can point its own hostname at
// 127.0.0.1 (DNS rebinding) and then read this account's quota from the browser. The Host
// header is what distinguishes "typed into the address bar" from "rebound at evil.com".
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

// Every response, static or JSON. frame-ancestors is the part that matters: the Host-header
// guard above sees a loopback Host even when a page on the internet frames this dashboard, so
// without this a hostile origin embeds the rings and the framed page reads /api/quota happily.
// X-Frame-Options says the same thing to anything older than CSP.
//
// The rest is as tight as CSP goes because the page makes zero external requests: no script,
// style or image may be fetched from anywhere. 'unsafe-inline' twice is what the page is — an
// inline <style> and an inline <script>, no external ones to allow; `img-src data:` covers the
// data-URI favicon and the noise background (the inline SVG is markup, not an image fetch);
// connect-src 'self' is fetch()/EventSource to this same server. font-src 'self' is the
// typefaces Settings offers, bundled under public/fonts and served from the allowlist below —
// this server, never a font CDN.
const SECURITY_HEADERS = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data:',
    "connect-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
};

// The dashboard is ONE page, public/index.html, self-contained but for the typefaces its
// Settings panel offers, which are bundled rather than fetched from anywhere. So the servable
// set is an allowlist of exactly the names it needs, not a blocklist of the tricks a path can
// play. Nothing the client writes reaches the filesystem, which retires traversal,
// percent-escapes, NUL bytes, FIFOs and symlinked directories in a single rule instead of one
// guard each — a guarantee this page is small enough to simply afford.
const ASSETS = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/fonts/SourceSerif4Variable-Roman.ttf.woff2', 'fonts/SourceSerif4Variable-Roman.ttf.woff2'],
  ['/fonts/NotoSans-Latin.woff2', 'fonts/NotoSans-Latin.woff2'],
  ['/fonts/FiraCode-VF.woff2', 'fonts/FiraCode-VF.woff2'],
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

export function createQuotaServer({ poller = new QuotaPoller() } = {}) {
  const streams = new Set();

  const server = createServer(async (req, res) => {
    try {
      if (!isLocalRequest(req)) return send(res, 403, { error: 'forbidden' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });

      // URL() reads a leading // as an authority, so //evil.com/api/quota would route as
      // /api/quota and ///// would not parse at all. The request target is a path; keep it one.
      const url = new URL(req.url.startsWith('//') ? `.${req.url}` : req.url, 'http://127.0.0.1');
      if (url.pathname === '/healthz') return send(res, 200, { ok: true, version: VERSION });
      if (url.pathname === '/api/quota') return send(res, 200, poller.snapshot());
      if (url.pathname === '/api/history') return send(res, 200, history(poller));
      if (url.pathname === '/api/cost') return send(res, 200, await getCost());
      // GET only: SSE is a body that never ends, so a HEAD hangs forever holding a socket,
      // a heartbeat timer and two poller listeners, waiting for a body it may not be sent.
      if (url.pathname === '/api/stream') {
        if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
        return openStream(req, res, poller, streams);
      }
      return await serveStatic(url.pathname, res);
    } catch (err) {
      // A throw that escapes here is an uncaught exception: it kills the process, the poller
      // and every attached SSE client. No single request is worth that.
      logFailure('request failed', err);
      if (res.headersSent) return res.destroy();
      send(res, 500, { error: 'internal error' });
    }
  });

  /**
   * Tear down up front. Node emits 'close' only once every connection has already gone, so
   * an SSE response ended from that handler would be ended after server.close() had already
   * hung waiting for it.
   */
  const close = () => new Promise((done) => {
    poller.stop();
    stopCost(); // a ccusage refresh in flight outlives this process otherwise
    for (const res of streams) res.end();
    streams.clear();
    server.close(done);
    server.closeAllConnections(); // an SSE socket never goes idle by itself
  });

  return { server, poller, streams, close };
}

/** Same-origin, loopback-only. Deliberately no CORS headers: nothing else may read this. */
function isLocalRequest(req) {
  const host = req.headers.host ?? '';
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  if (!LOCAL_HOSTS.has(name)) return false;
  if (req.headers.origin === undefined) return true; // same-origin GETs and curl send none
  try {
    return LOCAL_HOSTS.has(new URL(req.headers.origin).hostname);
  } catch {
    return false; // 'null' from a sandboxed frame, or junk
  }
}

/**
 * The sparkline series, plus the fit the UI would otherwise have to redo per client.
 *
 * Everything here is the poller's own output, forwarded as given: samples keep whatever
 * fields the poller puts on them, and the per-limit numbers are read off it, never rescaled
 * or rounded on the way out.
 */
function history(poller) {
  return {
    samples: poller.history(),
    intervalMs: poller.intervalMs,
    capacity: poller.capacity,
    // fit() is the whole per-limit entry — the rate, the projection, and the sinceT /
    // sampleCount span the fit was taken over — from one pass over the series. Forwarded as
    // it comes: rebuilding it field by field here would just be a second place to get the
    // trend's provenance wrong. The key order is the snapshot's, which is fixed.
    limits: poller.snapshot().limits.map(({ key }) => poller.fit(key)),
  };
}

function openStream(req, res, poller, streams) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // stops proxies buffering the stream into uselessness
  });

  const push = () => res.write(`data: ${JSON.stringify(poller.snapshot())}\n\n`);
  push(); // clients get the current value immediately, not on the next poll

  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  poller.on('update', push);
  poller.on('error', push);
  streams.add(res);

  req.on('close', () => {
    clearInterval(heartbeat);
    poller.off('update', push);
    poller.off('error', push);
    streams.delete(res);
    res.end();
  });
}

// Opening a file can fail in far more ways than "not there", and none of them is this server
// malfunctioning: ELOOP is a symlink cycle at the asset itself, ENAMETOOLONG a segment over
// 255 bytes, and a NUL byte makes fs reject the argument before the kernel ever sees it. The
// allowlist means none of these can be steered from a request any more, but they still say
// "this file is not servable", not "this server broke": answer them as 4xx, without a log line
// each.
const BAD_PATH = new Set(['ENAMETOOLONG', 'ELOOP', 'ERR_INVALID_ARG_VALUE', 'ERR_INVALID_ARG_TYPE']);
const ROUTINE = new Set(['ENOENT', 'EISDIR', 'ENOTDIR', 'ENOTFILE', 'EESCAPE', ...BAD_PATH]);

async function serveStatic(pathname, res) {
  const name = ASSETS.get(pathname);
  if (name === undefined) return send(res, 404, { error: 'not found' });

  const file = join(PUBLIC_DIR, name); // a constant path; the client chose only which entry
  let handle;
  try {
    // O_NONBLOCK, because open() is not automatically a quick syscall: opening a FIFO for
    // reading blocks until someone opens the write end, and it blocks a libuv threadpool
    // thread rather than just this request — four such requests exhaust the default pool and
    // every later read, of any file, stops being answered. Non-blocking, the open returns
    // and the isFile() check below gets to do its job. (It is a no-op on regular files.)
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    // Open first, then stat the descriptor: an existsSync() pre-check only ever proves
    // something about a file we are not the one about to read.
    const info = await handle.stat();
    // The check above anchored a joined STRING, which cannot see a symlink: public/x ->
    // /etc/passwd still joins to a path under public/, and a symlinked directory hands over
    // a whole tree the same way. Anchor the RESOLVED path instead, and require it to name the
    // very inode already open here, so swapping the link in after the resolve buys nothing.
    const real = await realpath(file);
    const target = await stat(real);
    if (!inPublicDir(real) || target.ino !== info.ino || target.dev !== info.dev) throw failed('EESCAPE');
    // A HARD link has no target to resolve: realpath() hands back the path under public/
    // itself and the inode is trivially the one just opened, so every check above passes and
    // `ln ~/.claude/.credentials.json public/index.html` is served as the dashboard. The extra
    // name is the only trace it leaves, and nlink is where that shows. The allowlist is what
    // makes so blunt a rule safe to apply: public/ holds a few plain checked-out files, and
    // package.json does not ship public/ at all, so this never runs out of a hard-linking
    // package store (pnpm, an npm cache) where nlink > 1 would be an ordinary, honest file.
    if (info.nlink !== 1) throw failed('EESCAPE');
    if (!info.isFile()) throw failed('ENOTFILE'); // a directory, FIFO, socket or device node
  } catch (err) {
    await handle?.close().catch(() => {});
    // Only a genuinely unexpected code is worth a line, and only the code: an fs message
    // quotes the whole path it was handed, which belongs in nobody's log file.
    if (!ROUTINE.has(err.code)) logFailure('static open failed', err);
    if (err.code === 'EESCAPE') return send(res, 403, { error: 'forbidden' });
    if (BAD_PATH.has(err.code)) return send(res, 400, { error: 'bad request' });
    return send(res, 404, { error: 'not found' });
  }

  // A typeface does not change under a running dashboard, and the Settings panel draws a sample
  // in each, so every load would fetch all of them again; a day's cache ends that. The page is
  // left uncached, since it is the part that does change.
  const cache = extname(file) === '.woff2' ? { 'cache-control': 'max-age=86400' } : {};
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': MIME[extname(file)] ?? 'application/octet-stream', ...cache });
  // pipeline, not pipe: it closes the file handle whichever end fails first, including the
  // client hanging up mid-file. An unhandled stream 'error' would be rethrown and kill us.
  await pipeline(handle.createReadStream(), res).catch(() => res.destroy());
}

function inPublicDir(path) {
  return path === PUBLIC_DIR || path.startsWith(PUBLIC_DIR + sep);
}

function failed(code) {
  return Object.assign(new Error(code), { code });
}

function resolveDir(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * One bounded, single-line record of a failure.
 *
 * An fs error's `message` quotes the whole path it was given, so logging it verbatim hands
 * an anonymous local page both a disk-fill lever (20 requests carrying a 15 KB path wrote
 * 303 KB of log) and a log-injection one, since a path may contain newlines. The code is the
 * part that says what went wrong; the path is the part the client wrote.
 */
function logFailure(what, err) {
  const detail = String(err?.code ?? err?.message ?? err).replace(/[^\x20-\x7E]/g, '.');
  process.stderr.write(`ccquota: ${what}: ${detail.slice(0, 120)}\n`);
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

/** Bound to loopback only — this serves one person's account data. */
export function serve({ port = Number(process.env.PORT) || 8787, host = '127.0.0.1' } = {}) {
  const { server, poller, close } = createQuotaServer();

  return new Promise((ok, fail) => {
    // Without this, a second instance dies on an uncaught EADDRINUSE and prints a stack.
    const startupFailed = (err) => fail(err.code === 'EADDRINUSE'
      ? Object.assign(new Error(`port ${port} is already in use — another ccquota is probably running.`), { code: err.code })
      : err);

    server.once('error', startupFailed);
    server.listen(port, host, () => {
      server.off('error', startupFailed);
      server.on('error', (err) => process.stderr.write(`ccquota: server error: ${err.message}\n`));
      poller.start();

      const shutdown = async () => {
        setTimeout(() => process.exit(0), 2000).unref(); // a wedged socket must not block the exit
        await close();
        process.exit(0);
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);

      ok({ server, poller, close, url: `http://${host}:${server.address().port}` });
    });
  });
}
