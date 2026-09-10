import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

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
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, '..') : homedir();
    const uuid = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'))?.oauthAccount?.accountUuid;
    if (typeof uuid !== 'string' || !uuid) return 'default';
    return createHash('sha256').update(uuid).digest('hex').slice(0, 12);
  } catch {
    return 'default'; // unreadable config is not worth failing a poll over
  }
}
