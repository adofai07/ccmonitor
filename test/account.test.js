// Whose account a reading is filed under: the session's for the status line, the token's for the
// poller, which differ once CCQUOTA_CREDENTIALS_PATH points at another profile's file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sandbox } from './sandbox.js';

const root = sandbox();
const { accountKey, pollAccountKey } = await import('../src/credentials.js');
const { QuotaPoller } = await import('../src/poller.js');
const { reportPath } = await import('../src/statusline.js');

const UUID_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const keyOf = (uuid) => createHash('sha256').update(uuid).digest('hex').slice(0, 12);
const A = keyOf(UUID_A);
const B = keyOf(UUID_B);

const home = process.env.HOME;
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
};
const config = (uuid) => ({ oauthAccount: { accountUuid: uuid } });
const credentials = { claudeAiOauth: { accessToken: 'test-token-not-a-real-one', expiresAt: Date.now() + 3_600_000, subscriptionType: 'max', rateLimitTier: 'tier_B' } };
// the home profile, A: ~/.claude.json beside ~/.claude
write(join(home, '.claude.json'), config(UUID_A));
write(join(home, '.claude', '.credentials.json'), credentials);
// a second profile, B, in a directory of its own, config and credentials together
const profileB = join(root, 'profile-b');
write(join(profileB, '.claude.json'), config(UUID_B));
write(join(profileB, '.credentials.json'), credentials);
// a credentials file with no config beside it, and one beside a config that cannot be read
const loose = join(root, 'loose', 'credentials.json');
write(loose, credentials);
symlinkSync(loose, join(root, 'loose', 'link.json'));
const broken = join(root, 'broken');
write(join(broken, '.claude.json'), '{not json');
write(join(broken, '.credentials.json'), credentials);

/**
 * Runs `fn` with the two variables set as given (undefined: unset), then puts them back — once
 * its promise settles, if it returns one: the poller reads them again after every await.
 */
function withEnv({ override, configDir }, fn) {
  const saved = [process.env.CCQUOTA_CREDENTIALS_PATH, process.env.CLAUDE_CONFIG_DIR];
  const put = (name, value) => (value === undefined ? delete process.env[name] : (process.env[name] = value));
  const restore = () => {
    put('CCQUOTA_CREDENTIALS_PATH', saved[0]);
    put('CLAUDE_CONFIG_DIR', saved[1]);
  };
  put('CCQUOTA_CREDENTIALS_PATH', override);
  put('CLAUDE_CONFIG_DIR', configDir);
  let result;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (result && typeof result.then === 'function') return result.finally(restore);
  restore();
  return result;
}

test('with no override, the poller and the session name the same account', () => {
  withEnv({}, () => {
    assert.equal(pollAccountKey(), A);
    assert.equal(accountKey(), A);
  });
});

test("an override takes the account of the config beside it, and a session keeps its own", () => {
  withEnv({ override: join(profileB, '.credentials.json') }, () => {
    assert.equal(pollAccountKey(), B);
    assert.equal(accountKey(), A);
  });
  // the default layout: ~/.claude/.credentials.json belongs to ~/.claude.json
  withEnv({ override: join(home, '.claude', '.credentials.json') }, () => assert.equal(pollAccountKey(), A));
});

test('a linked credentials file is looked up beside the link as well as beside its target', () => {
  // ~/.claude/.credentials.json linked into a dotfiles checkout still belongs to ~/.claude.json
  const other = join(root, 'home-2');
  write(join(other, '.claude.json'), config(UUID_B));
  write(join(root, 'dotfiles', 'claude', '.credentials.json'), credentials);
  mkdirSync(join(other, '.claude'), { recursive: true });
  symlinkSync(join(root, 'dotfiles', 'claude', '.credentials.json'), join(other, '.claude', '.credentials.json'));
  withEnv({ override: join(other, '.claude', '.credentials.json') }, () => assert.equal(pollAccountKey(), B));
  // and a link to a file in a profile's directory is that profile's
  symlinkSync(join(profileB, '.credentials.json'), join(root, 'loose', 'to-b.json'));
  withEnv({ override: join(root, 'loose', 'to-b.json') }, () => assert.equal(pollAccountKey(), B));
});

test("a file with no config beside it is nobody's guess, not even CLAUDE_CONFIG_DIR's", () => {
  // the config may well be another account than the file's, and taking it would be the blend
  const own = withEnv({ override: loose }, () => pollAccountKey());
  withEnv({ override: loose, configDir: profileB }, () => {
    assert.equal(pollAccountKey(), own);
    assert.equal(accountKey(), B); // the sessions of that config are still its own
  });
});

test('failing both, a file gets a key of its own, the same however it is named', () => {
  const own = withEnv({ override: loose }, () => pollAccountKey());
  assert.match(own, /^[0-9a-f]{12}$/);
  assert.notEqual(own, A);
  assert.notEqual(own, B);
  withEnv({ override: join(root, 'loose', 'link.json') }, () => assert.equal(pollAccountKey(), own));
  const cwd = process.cwd();
  process.chdir(join(root, 'loose'));
  try {
    withEnv({ override: 'credentials.json' }, () => assert.equal(pollAccountKey(), own));
  } finally {
    process.chdir(cwd);
  }
  // a file that is not there yet keeps its key once it appears, under a linked directory too
  mkdirSync(join(root, 'real-dir'));
  symlinkSync(join(root, 'real-dir'), join(root, 'linked-dir'));
  const early = withEnv({ override: join(root, 'linked-dir', 'later.json') }, () => pollAccountKey());
  write(join(root, 'real-dir', 'later.json'), credentials);
  withEnv({ override: join(root, 'linked-dir', 'later.json') }, () => assert.equal(pollAccountKey(), early));
  // nothing to read is not a reason to throw: the poll is what reports a missing file
  withEnv({ override: join(broken, '.credentials.json') }, () => assert.match(pollAccountKey(), /^[0-9a-f]{12}$/));
  withEnv({ override: join(root, 'nowhere', 'credentials.json') }, () => assert.match(pollAccountKey(), /^[0-9a-f]{12}$/));
  withEnv({ configDir: broken }, () => assert.equal(pollAccountKey(), 'default'));
});

test("a session on the config's account does not land on the override's page", async () => {
  const reset = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const realFetch = globalThis.fetch;
  // profile B's numbers, as the endpoint would give them for B's token
  globalThis.fetch = async () => new Response(JSON.stringify({
    five_hour: { utilization: 5, resets_at: reset }, seven_day: { utilization: 20, resets_at: reset },
  }), { status: 200 });
  try {
    await withEnv({ override: join(profileB, '.credentials.json') }, async () => {
      const poller = new QuotaPoller();
      await poller.tick();
      // a Claude Code session on profile A files a reading, under its own account as it always has
      write(reportPath(accountKey(), 'a-session-on-profile-a'), {
        v: 2, at: Date.now(), mark: 'm1',
        limits: { weekly: { percent: 63.4, resetsAt: reset }, session: { percent: 40, resetsAt: reset } },
      });
      poller.checkReport();
      const snapshot = poller.snapshot();
      assert.equal(snapshot.limits.find((l) => l.key === 'weekly').percent, 20);
      assert.equal(snapshot.source, 'poll');
      assert.equal(poller.account, B);
      assert.ok(readdirSync(join(process.env.XDG_CACHE_HOME, 'ccusageviz')).includes(`history-${B}.jsonl`));
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});
