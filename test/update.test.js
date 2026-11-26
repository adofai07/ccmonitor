// serve keeping to the newest commit of its checkout (src/update.js): it fast-forwards only what
// cannot lose anything, tells a new page from new server code, and names the page on the stream.
// Every repository here is a throwaway one, upstream included; nothing reaches the network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { sandbox } from './sandbox.js';

const dir = sandbox();
// git reads neither the machine's config nor the user's, so commits and fetches are the test's alone
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES']) delete process.env[name];
writeFileSync(join(dir, 'gitconfig'), [
  '[user]', '\tname = test', '\temail = test@example.invalid',
  '[init]', '\tdefaultBranch = main',
  '[commit]', '\tgpgsign = false',
  '[advice]', '\tdetachedHead = false',
].join('\n'));
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'gitconfig') });

const { fastForward, follow, unparsable, versionOf } = await import('../src/update.js');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const read = (root, name) => readFileSync(join(root, name), 'utf8');
function put(root, files) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
}
async function until(ok, what = 'the condition', ms = 15_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

let count = 0;
/** A bare upstream, a clone that pushes to it (`there`), and the checkout under test (`here`). */
function repos() {
  const base = join(dir, `r${++count}`);
  mkdirSync(base);
  const origin = join(base, 'origin.git'), there = join(base, 'there'), here = join(base, 'here');
  git(base, 'init', '-q', '--bare', origin);
  git(base, 'init', '-q', there);
  put(there, {
    'package.json': '{"type":"module"}\n',
    'bin/run.js': 'console.log(1);\n',
    'src/a.js': 'export const a = 1;\n',
    'public/index.html': '<p>one</p>\n',
    'public/weather/manifest.json': '{"files":{}}\n',
    'README.md': 'one\n',
  });
  git(there, 'add', '-A');
  git(there, 'commit', '-qm', 'one');
  git(there, 'remote', 'add', 'origin', origin);
  git(there, 'push', '-q', '-u', 'origin', 'main');
  git(base, 'clone', '-q', origin, here);
  const commit = (cwd, files) => {
    put(cwd, files);
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-qm', 'next');
    return git(cwd, 'rev-parse', 'HEAD');
  };
  return {
    here,
    /** a commit pushed upstream; `here` has not fetched it */
    push(files) {
      git(there, 'pull', '-q', '--ff-only');
      const sha = commit(there, files);
      git(there, 'push', '-q');
      return sha;
    },
    /** a commit pushed upstream and fetched into `here`, whose HEAD stays where it was */
    upstream(files) {
      const sha = this.push(files);
      git(here, 'fetch', '-q');
      return sha;
    },
    local: (files) => commit(here, files),
    head: () => git(here, 'rev-parse', 'HEAD'),
  };
}

test('a clean checkout behind its upstream is fast-forwarded onto it', async () => {
  const r = repos();
  const from = r.head();
  const to = r.upstream({ 'public/index.html': '<p>two</p>\n' });
  assert.deepEqual(await fastForward(r.here), { moved: true, from, to, count: 1, upstream: 'origin/main' });
  assert.equal(r.head(), to);
  assert.equal(read(r.here, 'public/index.html'), '<p>two</p>\n');
  assert.equal((await fastForward(r.here)).why, 'current');
});

test('uncommitted changes are never pulled over, and untracked files are kept', async () => {
  const r = repos();
  const from = r.head();
  put(r.here, { 'src/a.js': 'export const a = 2; // mine\n' });
  r.upstream({ 'public/index.html': '<p>two</p>\n' });
  assert.deepEqual(await fastForward(r.here), { why: 'dirty', upstream: 'origin/main', count: 1 });
  git(r.here, 'add', 'src/a.js');
  assert.equal((await fastForward(r.here)).why, 'dirty', 'staged is uncommitted too');
  assert.equal(r.head(), from);
  assert.equal(read(r.here, 'src/a.js'), 'export const a = 2; // mine\n');

  // An untracked file does not hold a pull back, unless the pull would write over it: then git
  // refuses, and the file and the checkout stay as they were.
  git(r.here, 'checkout', '-q', 'HEAD', '--', 'src/a.js');
  put(r.here, { 'notes.txt': 'mine\n', 'public/new.html': 'mine\n' });
  r.upstream({ 'public/new.html': 'theirs\n' });
  const refused = await fastForward(r.here);
  assert.equal(refused.why, 'failed');
  assert.match(refused.detail, /untracked/);
  assert.equal(read(r.here, 'public/new.html'), 'mine\n');
  assert.equal(r.head(), from);
  rmSync(join(r.here, 'public/new.html'));
  assert.equal((await fastForward(r.here)).moved, true);
  assert.equal(read(r.here, 'notes.txt'), 'mine\n');
});

test('local commits are never pulled over: ahead or diverged, the checkout stays put', async () => {
  const r = repos();
  const mine = r.local({ 'README.md': 'mine\n' });
  assert.equal((await fastForward(r.here)).why, 'ahead');
  r.upstream({ 'README.md': 'theirs\n' });
  assert.equal((await fastForward(r.here)).why, 'diverged');
  assert.equal(r.head(), mine);
  assert.equal(read(r.here, 'README.md'), 'mine\n');
});

test('a branch with no upstream, or a detached HEAD, follows nothing', async () => {
  const r = repos();
  git(r.here, 'checkout', '-q', '-b', 'side');
  assert.equal((await fastForward(r.here)).why, 'no-upstream');
  git(r.here, 'checkout', '-q', '--detach');
  assert.equal((await fastForward(r.here)).why, 'detached');
});

test('the version tells a new page from new server code, and ignores the rest', async () => {
  const r = repos();
  const v1 = await versionOf(r.here);
  assert.match(v1.page, /^[0-9a-f]{40}$/);
  assert.match(v1.server, /^[0-9a-f]{16}$/);
  r.local({ 'README.md': 'two\n' });
  assert.deepEqual(await versionOf(r.here), v1, 'a commit outside the page and the server changes neither');
  r.local({ 'public/index.html': '<p>two</p>\n' });
  const v2 = await versionOf(r.here);
  assert.notEqual(v2.page, v1.page);
  assert.equal(v2.server, v1.server);
  for (const file of ['src/a.js', 'bin/run.js', 'package.json']) {
    const was = await versionOf(r.here);
    r.local({ [file]: `${read(r.here, file)}\n` });
    const now = await versionOf(r.here);
    assert.notEqual(now.server, was.server, file);
    assert.equal(now.page, was.page, file);
  }
  // the cove's list is the page's, and the server's too: its allowlist is read once, at start
  const was = await versionOf(r.here);
  r.local({ 'public/weather/manifest.json': '{"files":{"a/b.webp":{}}}\n' });
  const now = await versionOf(r.here);
  assert.notEqual(now.server, was.server);
  assert.notEqual(now.page, was.page);
  // edits not yet committed are no version: they are served as they are, on a refresh
  put(r.here, { 'src/a.js': 'export const a = 9;\n', 'public/index.html': 'x' });
  assert.deepEqual(await versionOf(r.here), now);
});

test('follow fetches by itself; a pull and a commit made here each reach onVersion', async () => {
  const r = repos();
  const seen = [], lines = [];
  const f = await follow(r.here, {
    onVersion: (next, previous) => { seen.push({ next, previous }); },
    log: (text) => lines.push(text),
    fetchMs: 0,
    checkMs: 40,
  });
  after(() => f?.stop());
  assert.equal(f.upstream, 'origin/main');
  const v0 = f.version();

  const to = r.push({ 'public/index.html': '<p>two</p>\n' }); // pushed, not fetched here
  await until(() => seen.length === 1, 'the pull');
  assert.equal(r.head(), to);
  assert.deepEqual(seen[0].previous, v0);
  assert.notEqual(seen[0].next.page, v0.page);
  assert.equal(seen[0].next.server, v0.server);
  assert.ok(lines.some((l) => l.startsWith('pulled 1 new commit from origin/main (')), lines.join('\n'));

  r.local({ 'src/a.js': 'export const a = 3;\n' });
  await until(() => seen.length === 2, 'the commit made here');
  assert.notEqual(seen[1].next.server, seen[1].previous.server);
  assert.equal(seen[1].next.page, seen[1].previous.page);

  // ahead of the upstream, then apart from it: said, never pulled
  r.push({ 'README.md': 'theirs\n' });
  await until(() => lines.some((l) => l.includes('diverged')), 'the word on diverging');
  assert.equal(read(r.here, 'src/a.js'), 'export const a = 3;\n');
  git(r.here, 'pull', '-q', '--no-rebase', '--no-edit'); // a merge that changes neither page nor server
  git(r.here, 'push', '-q');

  // a standing condition is said once, and again only when it changes
  put(r.here, { 'src/a.js': 'export const a = 4; // mine\n' });
  r.push({ 'README.md': 'two\n' });
  await until(() => lines.some((l) => l.includes('uncommitted')), 'the word on local changes');
  await sleep(300);
  assert.deepEqual(lines.filter((l) => l.includes('uncommitted')), [
    'origin/main has 1 new commit; not pulled while this checkout has uncommitted changes',
  ]);
  r.push({ 'README.md': 'three\n' });
  await until(() => lines.filter((l) => l.includes('uncommitted')).length === 2, 'the word again, with 2');
  assert.equal(read(r.here, 'src/a.js'), 'export const a = 4; // mine\n');
  assert.equal(seen.length, 2);
  f.stop();
});

test('a fetch that fails is said once, and nothing moves', async () => {
  const r = repos();
  git(r.here, 'remote', 'set-url', 'origin', join(dir, 'nowhere.git'));
  const lines = [];
  const f = await follow(r.here, {
    onVersion: () => assert.fail('no new version'),
    log: (text) => lines.push(text),
    fetchMs: 0,
    checkMs: 30,
  });
  after(() => f?.stop());
  await until(() => lines.length > 0, 'the word on the fetch');
  await sleep(300);
  f.stop();
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /^could not fetch: /);
});

test('follow takes only the top of a git work tree', async () => {
  const r = repos();
  const plain = join(dir, 'plain');
  mkdirSync(plain);
  const quiet = { onVersion() {}, log() {} };
  assert.equal(await follow(plain, quiet), null, 'not a checkout');
  assert.equal(await follow(join(r.here, 'src'), quiet), null, 'inside one, not its top');
});

test('unparsable names a file under bin/ or src/ that does not parse', async () => {
  const r = repos();
  assert.equal(await unparsable(r.here), null);
  put(r.here, { 'src/b.js': 'export const b = ;\n' });
  assert.equal(await unparsable(r.here), 'src/b.js');
});

test('the stream names the page version on connect and whenever it changes', async () => {
  const { createQuotaServer } = await import('../src/server.js');
  const poller = { snapshot: () => ({ limits: [] }), stop() {}, on() {}, off() {} };
  const quota = createQuotaServer({ poller });
  await new Promise((ok) => quota.server.listen(0, '127.0.0.1', ok));
  after(() => quota.close());
  const port = quota.server.address().port;
  const open = () => new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/stream' }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      ok({ text: () => text, close: () => req.destroy() });
    });
    req.on('error', fail);
    req.end();
  });
  const frame = (page) => `event: version\ndata: {"page":"${page}"}\n\n`;

  const first = await open();
  await until(() => first.text().includes('\n\n'), 'the first reading');
  assert.ok(!first.text().includes('event: version'), 'no version before one is known');
  quota.setPage('a1');
  await until(() => first.text().includes(frame('a1')), 'a1 on the open stream');
  const second = await open();
  await until(() => second.text().includes(frame('a1')), 'a1 on connect');
  quota.setPage('a1'); // the same one again: nothing to say
  quota.setPage('b2');
  await until(() => first.text().includes(frame('b2')) && second.text().includes(frame('b2')), 'b2 on both');
  assert.equal(first.text().split('event: version').length - 1, 2);
  assert.equal(second.text().split('event: version').length - 1, 2);
  first.close();
  second.close();
});
