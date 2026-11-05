// A throwaway home, cache and state for a test file, so that nothing in it can read or write the
// real ones: Claude Code's config, the history, the status line setting.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

/** Points the environment into a new temporary directory, removed after the file's tests. */
export function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'ccquota-test-'));
  Object.assign(process.env, {
    HOME: join(dir, 'home'),
    XDG_CACHE_HOME: join(dir, 'cache'),
    XDG_STATE_HOME: join(dir, 'state'),
    CCQUOTA_STATUSLINE: 'off',
  });
  for (const name of ['CLAUDE_CONFIG_DIR', 'CCQUOTA_CREDENTIALS_PATH', 'CCQUOTA_INTERVAL_MS']) delete process.env[name];
  mkdirSync(process.env.HOME, { recursive: true });
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
