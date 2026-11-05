import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export class CredentialsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CredentialsError';
    this.code = code;
  }
}

/** Prefix + length only. The only representation of a token allowed to leave this module. */
export function redact(token) {
  if (typeof token !== 'string' || token.length === 0) return '<none>';
  return `${token.slice(0, 12)}…(${token.length} chars)`;
}

export function credentialsPath() {
  if (process.env.CCQUOTA_CREDENTIALS_PATH) return process.env.CCQUOTA_CREDENTIALS_PATH;
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json');
}

/**
 * macOS keeps these in the login Keychain rather than on disk, so a Mac with a perfectly
 * healthy Claude Code login has no `.credentials.json` at all.
 *
 * Service name and account are how Claude Code itself stores the item: `Claude Code` +
 * OAUTH_FILE_SUFFIX (empty in production) + `-credentials`, under $USER. A custom
 * CLAUDE_CONFIG_DIR appends a hash of that directory, which we do not reproduce — set
 * CCQUOTA_CREDENTIALS_PATH instead if you use one.
 *
 * `-w` prints the secret to stdout, so the output is returned and never logged.
 */
function readKeychain() {
  const account = process.env.USER || safeUsername();
  try {
    return execFileSync('security', ['find-generic-password', '-a', account, '-w', '-s', 'Claude Code-credentials'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'], // stderr piped, never inherited: it can echo the item
    });
  } catch (err) {
    // Exit 44 is "item not found"; a locked keychain is the other everyday case and the
    // user has to unlock it themselves, so name that action rather than the exit code.
    if (err.status === 51) {
      throw new CredentialsError('ENOCREDS', 'The login keychain is locked. Run `security unlock-keychain` and retry.');
    }
    throw new CredentialsError('ENOCREDS', 'No Claude Code credentials in the login keychain. Run `claude` and sign in.');
  }
}

function safeUsername() {
  try {
    return userInfo().username;
  } catch {
    return 'claude-code-user';
  }
}

/**
 * Read Claude Code's OAuth credentials fresh from disk.
 *
 * Deliberately re-reads on every call and never caches the token in memory.
 * Claude Code refreshes this file on demand and writes it atomically (temp + rename),
 * so an unlocked reader always sees a whole file, and re-reading is how we pick up
 * a refresh for free. See README for why we never refresh the token ourselves.
 */
export function readCredentials() {
  const path = credentialsPath();
  let source = path;

  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'EACCES') {
      throw new CredentialsError('ENOCREDS', `Cannot read ${path} (permission denied). It should be mode 0600 and owned by you.`);
    }
    if (err.code !== 'ENOENT') {
      throw new CredentialsError('ENOCREDS', `Cannot read ${path}: ${err.code || err.message}`);
    }
    // The file is authoritative wherever it exists — including on a Mac that has one — so
    // the keychain is a fallback for a missing file, not a branch taken on platform alone.
    if (process.platform !== 'darwin' || process.env.CCQUOTA_CREDENTIALS_PATH) {
      throw new CredentialsError('ENOCREDS', `No credentials at ${path}. Run \`claude\` and sign in.`);
    }
    text = readKeychain();
    source = 'the login keychain';
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CredentialsError('EBADCREDS', `${source} is not valid JSON.`);
  }

  const oauth = json.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== 'string' || oauth.accessToken.length === 0) {
    // Valid JSON with the wrong shape throws nothing on its own, so check explicitly.
    throw new CredentialsError('EBADCREDS', `${source} has no claudeAiOauth.accessToken.`);
  }

  return {
    accessToken: oauth.accessToken,
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null,
    subscriptionType: oauth.subscriptionType ?? null,
    rateLimitTier: oauth.rateLimitTier ?? null,
  };
}

/**
 * A short, stable, non-identifying handle for the logged-in account.
 *
 * Cached data is per-account, not per-machine: percentages from two accounts fitted as one
 * series produce a burn rate that describes neither. A drop at the switch would break the
 * series by accident, but only when the new account happens to be *less* used — the reverse
 * blends silently, which is the dangerous half.
 *
 * The uuid is hashed rather than used directly so nothing account-identifying lands in a
 * filename. Returns 'default' when there is no account to read, which keeps a single shared
 * cache for setups that never switch.
 */
export function accountKey() {
  // Where Claude Code keeps it: in CLAUDE_CONFIG_DIR when that is set, in the home directory
  // otherwise. This runs inside every Claude Code session as well — the status line files each
  // reading under the key — so it has to name that session's account, not a neighbour's.
  return accountIn(join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json')) ?? 'default';
}

/**
 * The account whose token the poller sends, keyed as accountKey() keys one: the cache its readings
 * are filed in, and whose status line reports stand in for its polls.
 *
 * Without CCQUOTA_CREDENTIALS_PATH that is the config's own account. With it the token is another
 * file's, and the config may be logged in as someone else. Keyed by the config, as it was, the
 * polls answered for the file's account were filed under the config's, and the reports of the
 * config's sessions were taken as the reading: two accounts' numbers on one page, jumping between
 * them, beside one account's plan.
 *
 * So the account is the one logged in beside the file, where Claude Code keeps the config of the
 * directory the file belongs to: `.claude.json` in that directory, or next to it for a directory
 * named `.claude`, whose config is `~/.claude.json` beside `~/.claude`. Beside the path as given
 * first, then beside where its links lead, so that a `~/.claude/.credentials.json` linked into a
 * dotfiles checkout is still ~/.claude.json's. Failing that, a key of the file's own: its
 * readings stay apart, and no session's report is ever taken for it, since no session can name it.
 * Not CLAUDE_CONFIG_DIR's account: nothing says the file is that account's, and a guess that is
 * wrong is the blend again.
 */
export function pollAccountKey() {
  const override = process.env.CCQUOTA_CREDENTIALS_PATH;
  if (!override) return accountKey();
  const given = resolve(override);
  const settled = settledPath(given);
  for (const dir of new Set([dirname(given), dirname(settled)])) {
    const key = accountIn(join(dir, '.claude.json'))
      ?? (basename(dir) === '.claude' ? accountIn(join(dirname(dir), '.claude.json')) : null);
    if (key) return key;
  }
  return keyOf(`credentials file ${settled}`);
}

/**
 * The path with its links followed as far as they exist: the nearest existing ancestor resolved,
 * the rest as given. A file that appears later, under /tmp on a Mac (/private/tmp) or any linked
 * directory, then keeps the key it had, where resolving only once it exists would change it.
 */
function settledPath(path) {
  const rest = [];
  for (let at = path; ; at = dirname(at)) {
    try {
      return join(realpathSync(at), ...rest);
    } catch {
      if (dirname(at) === at) return path;
      rest.unshift(basename(at));
    }
  }
}

/** The keyed account a Claude Code config file is logged in as, or null when it names none. */
function accountIn(configFile) {
  try {
    const uuid = JSON.parse(readFileSync(configFile, 'utf8'))?.oauthAccount?.accountUuid;
    return typeof uuid === 'string' && uuid ? keyOf(uuid) : null;
  } catch {
    return null; // unreadable config is not worth failing a poll over
  }
}

const keyOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);
