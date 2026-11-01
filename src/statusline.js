import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountKey } from './credentials.js';
import { cacheDir, claudeDir, stateDir } from './paths.js';
import { ROUNDING } from './usage.js';

/*
 * Claude Code hands a custom status line command its session as JSON on stdin, and for Pro,
 * Max and Ultra subscribers that JSON carries `rate_limits`: the 5-hour and 7-day windows'
 * `used_percentage` (0-100) and `resets_at` (epoch seconds), taken from the rate-limit headers
 * of Claude Code's own requests. The status line runs after every reply, so this is a reading
 * that costs no request at all, and it is fresher than the usage endpoint, which this tool
 * otherwise has to poll and which rate-limits.
 *
 * It also runs when nothing new has been read — on a mode, model or effort change, a vim
 * toggle, /clear, a change to the command itself, and on timers at a prompt cache's expiry and a
 * window's reset — and a reply's own run can come late, after a permission dialog. Filing every
 * run as of its own time would pass old readings off as fresh ones; fileReading() says which
 * runs carry news, and when their reading was taken.
 *
 * `ccquota statusline` is that command. It files each reading where the poller looks for it
 * and prints a short status line; the poller (src/poller.js) takes a fresh report as the
 * reading and only asks the endpoint once Claude Code has gone quiet.
 */

const MAX_INPUT = 1 << 20;        // a session's JSON is a few KB; anything this size is not one
const INPUT_WAIT_MS = 2_000;      // Claude Code closes stdin at once; a person typing never will
const WINDOWS = [['seven_day', 'weekly'], ['five_hour', 'session']];
// A report younger than this is current: it stands in for a poll (src/poller.js).
export const FRESH_MS = 300_000;
// The first Claude Code whose input carries prompt_cache, and with it a count of the session's
// own replies.
const PROMPT_CACHE_SINCE = [2, 1, 251];

/*
 * One report per session, named by a hash of its id: a session writes only its own file, so two
 * sessions filing at once cannot undo each other's. The poller reads every file of the account.
 */
export const reportPrefix = (account) => `statusline-${account}-`;
export const reportPath = (account, session) => join(cacheDir(), `${reportPrefix(account)}${sessionKey(session)}.json`);
const sessionKey = (session) => (session ? createHash('sha256').update(session).digest('hex').slice(0, 12) : 'nosession');

/** `ccquota statusline`: read the session, file the reading, print the line. Never fails. */
export async function statusline({ stdin = process.stdin, stdout = process.stdout } = {}) {
  let input = null;
  try { input = JSON.parse(await readAll(stdin)); } catch { /* not a session: print what we can */ }
  const limits = readLimits(input);
  if (limits) {
    const session = typeof input.session_id === 'string' ? input.session_id : '';
    try { fileReading(reportPath(accountKey(), session), input, limits); } catch { /* the line still prints */ }
  }
  stdout.write(`${lineOf(input, limits)}\n`);
}

/** The windows a session reports, keyed as the poller keys its limits, or null for none. */
export function readLimits(input) {
  const rl = input && typeof input === 'object' ? input.rate_limits : null;
  if (!rl || typeof rl !== 'object') return null;
  const out = {};
  for (const [from, key] of WINDOWS) {
    const w = rl[from];
    // typeof, not Number(): Number(null) is 0, and a null reading is not an empty window
    if (!w || typeof w.used_percentage !== 'number' || !Number.isFinite(w.used_percentage) || w.used_percentage < 0) continue;
    const resets = typeof w.resets_at === 'number' && Number.isFinite(w.resets_at) && w.resets_at > 0
      ? new Date(w.resets_at * 1000).toISOString()
      : null;
    out[key] = { percent: w.used_percentage, resetsAt: resets };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * File a reading if it is news, dated when it was read. Returns whether it filed one the poller
 * will take as current.
 *
 * News is a reply: the session's own count of main-conversation responses
 * (prompt_cache.requests) has moved since this session last filed. Nothing else moves it — not a
 * re-run on a timer or a toggle, which repeats the reading already filed, and not a background
 * query (a recap, a memory pass), which no run follows. Absent, the count says this session has
 * had no reply yet — a fresh start, or just after /clear — and what the input carries is the
 * process's last reading, from whenever that was. A Claude Code older than PROMPT_CACHE_SINCE
 * has no count; there the session's API time stands in, which moves for every response,
 * background ones too.
 *
 * A reply's run can come long after the reply: a permission dialog unmounts the status line
 * until it is answered. So the reading is dated by the request it came from —
 * prompt_cache.expires_at less its TTL is when the main conversation last sent one, or touched
 * its cache (Claude Code's keepalive, where it is on, does that every 30 s) — and the poller
 * takes it only while that is recent. And a session's first sighting is a baseline the poller
 * ignores, whatever its date: a command newly set in an open session runs at once on whatever
 * that session last read, hours ago perhaps. News is then the next reply.
 *
 * None of this is airtight — the count also moves for a request interrupted with Esc, which
 * brings no reading — so a report also says which windows its session saw fall (`fell`): the
 * poller lets a report lower the reading only then (src/usage.js withReport).
 *
 * And one more kind of news: in a session with replies of its own, a window it had below 100%
 * now at 100% — the refused request (a 429) that comes when a limit is hit. It moves no count,
 * and its run follows it at once, so it is dated now.
 */
export function fileReading(path, input, limits, now = Date.now()) {
  const prev = readReport(path);
  const mark = markOf(input);
  if (mark !== null && mark !== prev?.mark) {
    const at = prev ? readAt(input, now) ?? now : 0;
    writeReport(path, { v: 2, at, limits: withFalls(limits, prev), mark });
    return at > 0 && now - at < FRESH_MS;
  }
  const hit = mark !== null && prev !== null && Object.entries(limits).some(([key, w]) => {
    const was = prev.limits[key];
    return w.percent >= 100 && was && was.resetsAt === w.resetsAt && was.percent < 100;
  });
  if (!hit) return false;
  writeReport(path, { v: 2, at: now, limits: withFalls(limits, prev), mark: prev.mark });
  return true;
}

/* the windows marked that this session saw fall by a point or more since it last filed */
function withFalls(limits, prev) {
  const out = {};
  for (const [key, w] of Object.entries(limits)) {
    const was = prev?.limits[key];
    out[key] = was && was.resetsAt === w.resetsAt && was.percent - w.percent >= ROUNDING ? { ...w, fell: true } : w;
  }
  return out;
}

/*
 * How far this session's own replies have got, or null for none yet. The count restarts with
 * the process (and on /clear, /resume): the cache it has written so far goes with it, so a
 * resumed session's first reply is not mistaken for the last one its earlier process filed.
 */
function markOf(input) {
  const pc = input?.prompt_cache;
  if (pc && typeof pc === 'object') {
    if (!Number.isInteger(pc.requests) || pc.requests <= 0) return null;
    return Number.isFinite(pc.cache_write_tokens) ? `r${pc.requests}:${pc.cache_write_tokens}` : `r${pc.requests}`;
  }
  if (versionAtLeast(input?.version, PROMPT_CACHE_SINCE)) return null;
  const api = input?.cost?.total_api_duration_ms;
  return Number.isFinite(api) && api > 0 ? `a${api}` : null;
}

const TTL_MS = { '5m': 300_000, '1h': 3_600_000 };

/* when the main conversation last sent a request, as the prompt cache's expiry says, or null */
function readAt(input, now) {
  const pc = input?.prompt_cache;
  const ttl = TTL_MS[pc?.ttl];
  if (!ttl || !Number.isFinite(pc?.expires_at) || pc.expires_at <= 0) return null;
  return Math.min(now, pc.expires_at * 1000 - ttl);
}

function versionAtLeast(version, [major, minor, patch]) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(typeof version === 'string' ? version : '');
  if (!m) return false;
  const [a, b, c] = m.slice(1).map(Number);
  return a !== major ? a > major : b !== minor ? b > minor : c >= patch;
}

function sameLimits(a, b) {
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (a[k]?.percent !== b[k]?.percent || (a[k]?.resetsAt ?? null) !== (b[k]?.resetsAt ?? null)) return false;
  }
  return true;
}

/**
 * Written in one call rather than through a temp file and a rename: Claude Code cancels a
 * status line that is still running when the next update comes, and a cancelled rename leaves
 * a temp file behind every time, while a cancelled write leaves at worst a torn report — which
 * the reader rejects, and the next reply overwrites.
 */
export function writeReport(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report));
}

/** A report, checked as far as it can be, or null for a torn or foreign one. */
export function readReport(path) {
  let r;
  try { r = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  // One dated ahead of the clock is still read: whether it is current is for the reader to say.
  if (!r || r.v !== 2 || !Number.isFinite(r.at)) return null;
  if (!r.limits || typeof r.limits !== 'object') return null;
  const limits = {};
  for (const [, key] of WINDOWS) {
    const w = r.limits[key];
    if (!w || !Number.isFinite(w.percent) || w.percent < 0) continue;
    limits[key] = { percent: w.percent, resetsAt: typeof w.resetsAt === 'string' && Number.isFinite(Date.parse(w.resetsAt)) ? w.resetsAt : null };
    if (w.fell === true) limits[key].fell = true;
  }
  if (!Object.keys(limits).length) return null;
  return { at: r.at, limits, mark: typeof r.mark === 'string' ? r.mark : null };
}

/* the line Claude Code shows: the model, and the week's share and time left */
function lineOf(input, limits) {
  const parts = [];
  const model = input?.model?.display_name;
  if (typeof model === 'string' && model) parts.push(model.replace(/[\x00-\x1f\x7f]/g, ''));
  const week = limits?.weekly;
  if (week) {
    const left = timeLeft(week.resetsAt);
    parts.push(`week ${Math.floor(week.percent)}%${left ? ` · ${left} left` : ''}`);
  }
  return parts.join(' · ');
}

function timeLeft(iso) {
  const s = Math.round((Date.parse(iso ?? '') - Date.now()) / 1000);
  if (!Number.isFinite(s) || s <= 0) return null;
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/* stdin to the end, or as far as it gets in INPUT_WAIT_MS; nothing at all from a terminal */
function readAll(stdin) {
  if (stdin.isTTY) return Promise.resolve('');
  return new Promise((done) => {
    let text = '';
    const finish = () => { clearTimeout(timer); stdin.pause(); done(text); };
    const timer = setTimeout(finish, INPUT_WAIT_MS);
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => { text += chunk; if (text.length > MAX_INPUT) { text = ''; finish(); } });
    stdin.on('end', finish);
    stdin.on('error', finish);
  });
}

/* ── putting the command in Claude Code's settings ───────────────────── */

const BIN = fileURLToPath(new URL('../bin/ccquota.js', import.meta.url));
// In the state directory, not the cache: clearing a cache must not bring back a status line
// the reader took out. Where it used to be is still read, for a removal recorded there.
const MARK = () => join(stateDir(), 'statusline-installed.json');
const OLD_MARK = () => join(cacheDir(), 'statusline-installed.json');

/**
 * Set Claude Code's status line to `ccquota statusline` when it is unset.
 *
 * Only ever when it is unset: a status line of the reader's own is never touched (the poller
 * polls for them, unless their line runs ours too). One that is ours but points at an old copy of this tool is
 * pointed at this one. And once ours is there, that is remembered: if the reader takes it out
 * again, it stays out — re-adding it on every start would be arguing with them. `force` (from
 * `ccquota statusline install`) sets it even then; CCQUOTA_STATUSLINE=off turns all of this off.
 *
 * Returns what happened, for the caller to say: { outcome } with 'installed', 'updated',
 * 'present', 'theirs', 'feeds' (theirs, and it runs ours too), 'removed', 'off', 'no-claude',
 * 'unsupported' (Windows), 'invalid', 'busy' or 'failed', with a `code` saying why for
 * 'failed', and `hooksOff` when the settings' disableAllHooks will keep Claude Code from running
 * it.
 */
export function ensureStatusLine({ force = false } = {}) {
  if (/^(0|off|no|false)$/i.test(process.env.CCQUOTA_STATUSLINE ?? '')) return { outcome: 'off' };
  // Claude Code on Windows runs a status line through PowerShell unless it finds Git Bash, and
  // the command written here is a POSIX one; nothing it cannot run goes into the settings.
  if (process.platform === 'win32') return { outcome: 'unsupported' };
  const dir = claudeDir();
  try { if (!statSync(dir).isDirectory()) return { outcome: 'no-claude' }; } catch { return { outcome: 'no-claude' }; }

  // A settings.json that is a symlink (dotfiles kept in a repo) is written through, never
  // replaced: renaming over the link would quietly cut it loose from the file it points at.
  // The path is resolved even while the file is absent, through its directory, so that it is
  // the same string before and after the file exists: it is what the marker remembers.
  const link = join(dir, 'settings.json');
  let file;
  try {
    file = realpathSync(link);
  } catch {
    // Not there yet, which is fine: it is created below. A link to nowhere is not fine — the
    // reader's dotfiles are broken, and filling the gap with a file of ours would hide that.
    try { if (lstatSync(link).isSymbolicLink()) return { outcome: 'failed', code: 'a dangling symlink' }; } catch { /* truly absent */ }
    try { file = join(realpathSync(dir), 'settings.json'); } catch { file = link; }
  }

  let text = null;
  try { text = readFileSync(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') return { outcome: 'failed', code: err.code }; }
  let settings = {};
  if (text !== null && text.trim()) {
    try { settings = JSON.parse(text); } catch { return { outcome: 'invalid' }; }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { outcome: 'invalid' };
  }

  const want = ourCommand();
  const have = settings.statusLine;
  // set all the same, as asked, but said: with this, Claude Code runs no status line of the user's
  const hooksOff = settings.disableAllHooks === true;
  if (have !== undefined) {
    if (!isOurs(have)) return { outcome: feedsOurs(have) ? 'feeds' : 'theirs' };
    if (have.command !== want) {
      const wrote = writeSettings(file, text, { ...settings, statusLine: { ...have, command: want } });
      if (wrote !== 'written') return wrote === 'changed' ? { outcome: 'busy' } : { outcome: 'failed', code: wrote };
    }
    // Remembered here too, not only on install: ours may have been set by hand, or the
    // marker lost, and a removal must stick either way.
    rememberInstalled(file);
    return { outcome: have.command === want ? 'present' : 'updated', hooksOff };
  }
  if (!force && installedBefore(file)) return { outcome: 'removed' };
  const wrote = writeSettings(file, text, { ...settings, statusLine: { type: 'command', command: want } });
  if (wrote !== 'written') return wrote === 'changed' ? { outcome: 'busy' } : { outcome: 'failed', code: wrote };
  rememberInstalled(file);
  return { outcome: 'installed', hooksOff };
}

/**
 * The command line for this copy of the tool, quoted for the shell Claude Code runs it in.
 *
 * It names the cache directory this process reads reports from, always: Claude Code runs the
 * command in its own environment, and a server and a Claude Code that disagree about
 * XDG_CACHE_HOME — either way round — would otherwise never meet. Always, too, so that one
 * directory is one command, however each environment spells it.
 */
export function ourCommand() {
  return `XDG_CACHE_HOME=${shellQuote(resolve(dirname(cacheDir())))} ${shellQuote(stableNode())} ${shellQuote(BIN)} statusline`;
}

/*
 * The node running this, by a name that outlives an upgrade. Where the binary lives in a
 * versioned place an upgrade deletes — a Homebrew Cellar keg, the Nix or Guix store, a snap
 * revision — the same binary
 * under a stable name is the same program: the name this process was started by, a node on PATH
 * (a service manager's PATH may have none), or Homebrew's opt/ link for the formula. Anywhere
 * else the binary's own path is the stable one: a version manager's installation lasts as long
 * as that version is installed, while the link on PATH it gives each shell (fnm's) is re-pointed
 * by `fnm use` and gone at logout.
 */
function stableNode() {
  let self;
  try { self = realpathSync(process.execPath); } catch { return process.execPath; }
  const fleeting = (path) => path.includes('/Cellar/') || /^\/(nix|gnu)\/store\//.test(path) || /^\/snap\/[^/]+\/[^/]+\//.test(path);
  if (!fleeting(self)) return process.execPath;
  // a snap's revision directory goes at the next refresh; its launcher stays
  const snap = /^\/snap\/([^/]+)\//.exec(self);
  if (snap && existsSync(`/snap/bin/${snap[1]}`)) return `/snap/bin/${snap[1]}`;
  const keg = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(self);
  const candidates = [
    isAbsolute(process.argv0) ? process.argv0 : null,
    ...(process.env.PATH ?? '').split(delimiter).filter((dir) => dir && isAbsolute(dir)).map((dir) => join(dir, 'node')),
    keg ? `${keg[1]}/opt/${keg[2]}/bin/node` : null,
  ];
  for (const candidate of candidates) {
    if (!candidate || fleeting(candidate)) continue;
    try { if (realpathSync(candidate) === self) return candidate; } catch { /* not here */ }
  }
  return process.execPath;
}

/*
 * Ours only when it is exactly the command ourCommand() writes, give or take the copy it names:
 * a node (by any name with node in it: nodejs, node22), a bin/ccquota.js, `statusline`, and
 * nothing else — or a `ccquota statusline` on PATH. Not `bun …`, and not a line switched off
 * with `: …` or `echo …`. A command that merely mentions ours (a
 * pipeline feeding it, a script calling it beside the reader's own line) is theirs: re-pointing
 * it would replace all of it with ours.
 */
function isOurs(statusLine) {
  if (!statusLine || typeof statusLine !== 'object' || typeof statusLine.command !== 'string') return false;
  const words = shellWords(statusLine.command);
  if (!words) return false;
  if (/^XDG_CACHE_HOME=./.test(words[0] ?? '')) words.shift();
  const [a, b, c] = words;
  // either separator: on Windows the paths are backslashed
  if (words.length === 3) return /(^|[\\/])[^\\/]*node[^\\/]*$/i.test(a) && /(^|[\\/])bin[\\/]ccquota\.js$/i.test(b) && c === 'statusline';
  if (words.length === 2) return /(^|[\\/])ccquota(\.cmd)?$/i.test(a) && b === 'statusline';
  return false;
}

/*
 * A status line of the reader's own that hands its input to ours in the command itself, as the
 * README shows. One that does it inside a script it runs cannot be seen from here.
 */
function feedsOurs(statusLine) {
  return typeof statusLine?.command === 'string' && /(^|[^\w.-])ccquota(\.js|\.cmd)?['"]?\s+statusline\b/.test(statusLine.command);
}

/*
 * A command line's words, for the plain kind shellQuote() writes: bare words and single-quoted
 * runs. Null for anything else — an operator, a substitution, a double quote — since a command
 * with any of those in it does more than run one program.
 */
function shellWords(command) {
  const words = [];
  let i = 0;
  while (i < command.length) {
    if (command[i] === ' ' || command[i] === '\t') { i++; continue; }
    let word = '';
    while (i < command.length && command[i] !== ' ' && command[i] !== '\t') {
      const ch = command[i];
      if (ch === "'") {
        const end = command.indexOf("'", i + 1);
        if (end < 0) return null;
        word += command.slice(i + 1, end);
        i = end + 1;
      } else if (ch === '\\' && command[i + 1] === "'") {
        word += "'"; // the escaped quote in shellQuote's '\''
        i += 2;
      } else if (/[\w@%+=:,./~-]/.test(ch)) {
        word += ch;
        i++;
      } else {
        return null;
      }
    }
    words.push(word);
  }
  return words;
}

function shellQuote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/*
 * Written to a temp file beside it and renamed over it, so Claude Code never reads a half
 * file, with the original's permissions. Synced before the rename: a rename can reach the disk
 * ahead of the data it points at, and a crash in between would leave an empty settings.json —
 * every permission, hook and plugin of the reader's gone. Read again just before the rename: if
 * anything else wrote it meanwhile (Claude Code's /config, an editor), this one steps back and
 * leaves theirs.
 *
 * Returns 'written', 'changed' (stepped back), or the error code that stopped it.
 */
function writeSettings(file, before, settings) {
  const tmp = `${file}.ccquota-${process.pid}.tmp`;
  let fd = null;
  try {
    mkdirSync(dirname(file), { recursive: true });
    let mode = 0o644;
    try { mode = statSync(file).mode & 0o777; } catch { /* a new file */ }
    fd = openSync(tmp, 'w', mode);
    writeFileSync(fd, `${JSON.stringify(settings, null, 2)}\n`);
    // as Claude Code's own writer does: a filesystem with no fsync for files is no reason to refuse
    try { fsyncSync(fd); } catch (err) { if (!['EINVAL', 'ENOTSUP', 'EPERM', 'ENOSYS'].includes(err.code)) throw err; }
    closeSync(fd);
    fd = null;
    chmodSync(tmp, mode); // the mode given to open is cut down by the umask
    let now = null;
    try { now = readFileSync(file, 'utf8'); } catch { /* still absent */ }
    if (now !== before) { unlinkSync(tmp); return 'changed'; }
    renameSync(tmp, file);
    return 'written';
  } catch (err) {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
    try { unlinkSync(tmp); } catch { /* never made */ }
    return err.code ?? 'an unknown error';
  }
}

function installedBefore(file) {
  return [MARK(), OLD_MARK()].some((mark) => {
    try { return JSON.parse(readFileSync(mark, 'utf8'))?.files?.includes(file) === true; } catch { return false; }
  });
}

function rememberInstalled(file) {
  let files = [];
  try { files = JSON.parse(readFileSync(MARK(), 'utf8'))?.files ?? []; } catch { /* first time */ }
  if (!Array.isArray(files)) files = [];
  if (files.includes(file)) return;
  files.push(file);
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(MARK(), JSON.stringify({ files }));
  } catch { /* unremembered, a removal is not honoured: the line comes back next start */ }
}
