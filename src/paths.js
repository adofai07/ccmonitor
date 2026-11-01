import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where this tool keeps its caches: the sample history, the backoff, the status line's reports. */
export function cacheDir() {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'ccusageviz');
}

/**
 * Where this tool keeps what it must not forget when a cache is cleared: that the reader took
 * the status line out of Claude Code's settings, so that it is not put back.
 */
export function stateDir() {
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'ccusageviz');
}

/** Claude Code's own directory: its settings.json and, unless overridden, its credentials. */
export function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}
