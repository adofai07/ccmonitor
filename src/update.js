// Keeping a running `serve` on the newest commit of the checkout it runs from.
//
// Every couple of minutes it runs `git fetch`, and when the branch is behind its upstream and
// nothing tracked is uncommitted it fast-forwards onto it. That is the one move that cannot lose
// anything: local edits and local commits, ahead or diverged, are left exactly as they are.
// Whatever moves HEAD (that, a commit made here, a checkout) is a new version of the files, read
// from the commit itself: the open dashboards reload when the page changed, and the server
// restarts itself when its own code did. Uncommitted edits move nothing here; the files on disk
// are served as they are, so a refresh shows them, as it always has.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export const FETCH_MS = 120_000; // the upstream: at the quota poll's own pace
export const CHECK_MS = 30_000; // HEAD, which a commit made here moves as well

// What the process runs rather than what it serves, so a change to any of it needs a new process.
// The cove's file list counts too: the server reads its allowlist from it once, at start.
const SERVER_PATHS = ['bin', 'src', 'package.json'];
const LIST_PATH = 'public/weather/manifest.json';
const PAGE_PATH = 'public';

const children = new Set();

/**
 * One git command in `root`, as { ok, out, why }. Never a prompt: git runs in a session of its
 * own, with no terminal to ask on, so a credential or an ssh passphrase it would need fails it
 * instead of waiting in the terminal `serve` runs in. Never longer than `ms`.
 */
export function git(root, args, ms = 15_000) {
  return new Promise((done) => {
    let child, timer = null, settled = false, out = '', err = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      children.delete(child);
      done(result);
    };
    try {
      child = spawn('git', args, {
        cwd: root,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (e) {
      return finish({ ok: false, out: '', why: String(e.code ?? e.message) });
    }
    children.add(child);
    child.stdout.setEncoding('utf8').on('data', (c) => { if (out.length < 1 << 20) out += c; });
    child.stderr.setEncoding('utf8').on('data', (c) => { if (err.length < 1 << 14) err += c; });
    timer = setTimeout(() => halt(child), ms);
    child.on('error', (e) => finish({ ok: false, out: '', why: String(e.code ?? e.message) }));
    child.on('close', (code, signal) => finish({
      ok: code === 0,
      out: out.trim(),
      why: code === 0 ? '' : firstLine(err) || (signal ? 'timed out' : `exit ${code}`),
    }));
  });
}

/** The whole group: a fetch over https or ssh is git and a helper under it. */
function halt(child) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch { /* already gone */ }
}

/** git's first line of complaint, without its prefix, any credential in a URL, or control bytes. */
function firstLine(text) {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.replace(/^(fatal|error|warning): /, '')
    .replace(/:\/\/[^/@\s]+@/g, '://')
    .replace(/[^\x20-\x7E]/g, '.')
    .slice(0, 160);
}

/** What HEAD holds of the page and of the server, as object ids: equal ids, equal files. */
export async function versionOf(root) {
  // Two listings: given a path inside public/, ls-tree lists public/ itself entry by entry.
  const [top, list] = await Promise.all([
    git(root, ['ls-tree', 'HEAD', '--', ...SERVER_PATHS, PAGE_PATH]),
    git(root, ['ls-tree', 'HEAD', '--', LIST_PATH]),
  ]);
  if (!top.ok || !list.ok) return null;
  const ids = new Map();
  for (const line of `${top.out}\n${list.out}`.split('\n')) {
    const m = /^\d+ \w+ ([0-9a-f]+)\t(.+)$/.exec(line);
    if (m) ids.set(m[2], m[1]);
  }
  const server = createHash('sha256')
    .update([...SERVER_PATHS, LIST_PATH].map((p) => `${p} ${ids.get(p) ?? '-'}`).join('\n'))
    .digest('hex')
    .slice(0, 16);
  return { page: ids.get(PAGE_PATH) ?? null, server };
}

/**
 * Moves the checkout onto its upstream when that is a fast-forward and nothing tracked is
 * uncommitted. Returns what it did, { moved, from, to, count, upstream }, or why it did not:
 * `why` is detached, no-commit, no-upstream, current, ahead, diverged, dirty or failed.
 */
export async function fastForward(root) {
  const branch = await git(root, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (!branch.ok) return { why: 'detached' };
  const [head, up, name] = await Promise.all([
    git(root, ['rev-parse', '--verify', '-q', 'HEAD']),
    git(root, ['rev-parse', '--verify', '-q', '@{upstream}']),
    git(root, ['rev-parse', '--abbrev-ref', '@{upstream}']),
  ]);
  if (!head.ok) return { why: 'no-commit' };
  if (!up.ok) return { why: 'no-upstream', branch: branch.out };
  const upstream = name.out || 'the upstream';
  if (head.out === up.out) return { why: 'current', upstream };
  if (!(await git(root, ['merge-base', '--is-ancestor', head.out, up.out])).ok) {
    const ahead = (await git(root, ['merge-base', '--is-ancestor', up.out, head.out])).ok;
    return { why: ahead ? 'ahead' : 'diverged', upstream };
  }
  const count = Number((await git(root, ['rev-list', '--count', `${head.out}..${up.out}`])).out) || 0;
  const status = await git(root, ['status', '--porcelain', '--untracked-files=no']);
  if (!status.ok) return { why: 'failed', upstream, count, detail: status.why };
  if (status.out) return { why: 'dirty', upstream, count };
  // the commit checked above, not @{upstream} again, which a fetch elsewhere could have moved
  const merged = await git(root, ['merge', '--ff-only', '--quiet', up.out], 60_000);
  if (!merged.ok) return { why: 'failed', upstream, count, detail: merged.why };
  return { moved: true, from: head.out, to: up.out, count, upstream };
}

const commits = (n) => `${n} new commit${n === 1 ? '' : 's'}`;

/** What a fast-forward says in the terminal; null for the states that need no word. */
function describe(r) {
  if (r.moved) return `pulled ${commits(r.count)} from ${r.upstream} (${r.from.slice(0, 7)}..${r.to.slice(0, 7)})`;
  if (r.why === 'dirty') return `${r.upstream} has ${commits(r.count)}; not pulled while this checkout has uncommitted changes`;
  if (r.why === 'diverged') return `this branch and ${r.upstream} have diverged; not pulled`;
  if (r.why === 'failed') return `could not pull ${r.upstream}: ${r.detail}`;
  return null;
}

/**
 * Follows the checkout at `root`, calling onVersion(next, previous) when a new commit at HEAD
 * changes what versionOf() reads. Null when `root` is not the top of a git work tree (an npm
 * install, a copy inside another project's repository) or git is not installed.
 */
export async function follow(root, { onVersion, log, fetchMs = FETCH_MS, checkMs = CHECK_MS }) {
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (!top.ok || !samePath(top.out, root)) return null;
  const upstream = await git(root, ['rev-parse', '--abbrev-ref', '@{upstream}']);
  let version = await versionOf(root);
  let fetchedAt = 0, busy = false, stopped = false;

  // A standing condition (offline, local changes) is said once, and again only once it changes.
  const said = new Map();
  const say = (topic, text) => {
    if (said.get(topic) === text) return;
    said.set(topic, text);
    if (text) log(text);
  };

  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      if (Date.now() - fetchedAt >= fetchMs) {
        fetchedAt = Date.now();
        const fetched = await git(root, ['fetch', '--quiet'], 60_000);
        say('fetch', fetched.ok ? null : `could not fetch: ${fetched.why}`);
      }
      if (stopped) return;
      const r = await fastForward(root);
      if (r.moved) {
        said.delete('pull');
        log(describe(r));
      } else {
        say('pull', describe(r));
      }
      const next = await versionOf(root);
      if (stopped || !next) return;
      if (!version) version = next;
      else if (next.page !== version.page || next.server !== version.server) {
        const previous = version;
        version = next;
        await onVersion(next, previous);
      }
    } catch (err) {
      say('tick', `update check failed: ${String(err?.code ?? err?.message ?? err).slice(0, 120)}`);
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(tick, checkMs);
  timer.unref();
  tick(); // a fetch at once: a restarted server catches up at start

  return {
    upstream: upstream.ok ? upstream.out : null,
    version: () => version,
    stop() {
      stopped = true;
      clearInterval(timer);
      for (const child of children) halt(child);
    },
  };
}

function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** The first .js file under bin/ or src/ that does not parse, relative to `root`; null if none. */
export async function unparsable(root) {
  for (const dir of ['bin', 'src']) {
    let names;
    try {
      names = readdirSync(join(root, dir)).filter((n) => n.endsWith('.js')).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const ok = await new Promise((done) => {
        const child = spawn(process.execPath, ['--check', join(root, dir, name)], { stdio: 'ignore', windowsHide: true });
        child.on('error', () => done(false));
        child.on('close', (code) => done(code === 0));
      });
      if (!ok) return `${dir}/${name}`;
    }
  }
  return null;
}
