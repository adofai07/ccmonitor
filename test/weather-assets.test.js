// The Weather theme's cove: the files in public/weather/ are exactly what its manifest lists, each as
// listed, and the server hands out those and nothing else, with the right types and caching; without
// a usable manifest it answers an empty one, so the page shows the open sea and logs nothing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sandbox } from './sandbox.js';

const realHome = homedir();
const realUser = (() => { try { return userInfo().username; } catch { return ''; } })();
sandbox();
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, 'public', 'weather');
const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));
const listed = Object.entries(manifest.files);
const EMPTY = { v: 1, models: [], terrain: [], files: {} };
const REQUIRED_OK = new Set(['KHR_mesh_quantization', 'KHR_texture_transform', 'KHR_materials_emissive_strength', 'EXT_texture_webp']);

const walk = (dir) => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const sha8 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 8);

test('every file the manifest lists is there, at its size and sha, as a plain file', () => {
  assert.ok(listed.length > 100, 'the cove has its files');
  for (const [name, { bytes, sha }] of listed) {
    const path = join(DIR, name);
    const info = statSync(path);
    assert.ok(info.isFile(), name);
    assert.equal(info.nlink, 1, `${name} has one name (the server refuses a hard link)`);
    assert.equal(info.size, bytes, name);
    assert.equal(sha8(readFileSync(path)), sha, name);
  }
});

test('every model and texture in the folder is listed, and nothing else is in it', () => {
  const names = new Set(listed.map(([name]) => name));
  const found = walk(DIR).map((p) => relative(DIR, p).split(sep).join('/'));
  for (const f of found.filter((f) => /\.(glb|webp)$/.test(f))) assert.ok(names.has(f), `${f} is listed`);
  assert.deepEqual(found.filter((f) => !/\.(glb|webp)$/.test(f)).sort(), ['LICENSE.txt', 'README.md', 'manifest.json', 'wx.js']);
  for (const [name] of listed) assert.match(name, /^[a-z0-9_]+(\/[a-z0-9_]+)*\/[a-z0-9_.]+\.(glb|webp)$/);
});

test('the cove is at most 25 MB', () => {
  const total = listed.reduce((s, [, f]) => s + f.bytes, 0);
  assert.ok(total <= 25e6, `${(total / 1e6).toFixed(2)} MB`);
});

test('every GLB is glTF 2.0, needing nothing beyond the extensions the loader knows', () => {
  for (const [name] of listed.filter(([n]) => n.endsWith('.glb'))) {
    const b = readFileSync(join(DIR, name));
    assert.equal(b.readUInt32LE(0), 0x46546c67, `${name}: glTF magic`);
    assert.equal(b.readUInt32LE(4), 2, `${name}: version 2`);
    assert.equal(b.readUInt32LE(8), b.length, `${name}: its length`);
    const length = b.readUInt32LE(12);
    assert.equal(b.readUInt32LE(16), 0x4e4f534a, `${name}: a JSON chunk first`);
    const gltf = JSON.parse(b.subarray(20, 20 + length).toString('utf8'));
    assert.equal(gltf.asset.version, '2.0', name);
    for (const ext of gltf.extensionsRequired || []) assert.ok(REQUIRED_OK.has(ext), `${name} requires ${ext}`);
  }
});

test('the notes beside the files describe the set that ships: each model\'s levels and textures, and the count', () => {
  const notes = readFileSync(join(DIR, 'README.md'), 'utf8');
  for (const m of manifest.models) {
    const row = notes.split('\n').find((l) => l.includes(`\`${m.id}/\``));
    assert.ok(row, `${m.id} has a row`);
    const cells = row.split('|').map((c) => c.trim());
    assert.equal(cells[5], m.lods.map((l) => l.lod).join(', '), `${m.id}: the levels shipped`);
    assert.equal(cells[6], m.tex.set, `${m.id}: the texture set`);
  }
  // and no row for a model that no longer ships
  const rows = [...notes.matchAll(/^\| \[[^\]]+\]\([^)]+\) \| `([a-z0-9_]+)\/` \| [a-z]+ \|/gm)].map((m) => m[1]);
  assert.deepEqual(rows.sort(), manifest.models.map((m) => m.id).sort());
  const glb = listed.filter(([n]) => n.endsWith('.glb')).length, total = listed.reduce((s, [, f]) => s + f.bytes, 0);
  assert.match(notes.replace(/\s+/g, ' '), new RegExp(`${listed.length} files \\(${glb} GLB, ${listed.length - glb} WebP\\), ${(total / 1e6).toFixed(1)} MB`));
});

test('no home path or user name in the manifest or the notes beside it', () => {
  for (const file of ['manifest.json', 'README.md', 'LICENSE.txt']) {
    const text = readFileSync(join(DIR, file), 'utf8');
    assert.doesNotMatch(text, /(^|["'\s(])(\/home\/|\/Users\/|\/root\/|\/tmp\/|[A-Za-z]:\\)/m, file);
    assert.ok(!text.includes(realHome), `${file} names no home directory`);
    if (realUser.length >= 3) assert.ok(!new RegExp(`\\b${realUser}\\b`, 'i').test(text), `${file} names no user`);
  }
});

/* ── the server ── */

const poller = { snapshot: () => ({ limits: [] }), stop() {}, on() {}, off() {} };

/** A server from a copy of server.js under `root` (the repo, or a temporary one), on a free port. */
async function serve(root) {
  const { createQuotaServer } = await import(pathToFileURL(join(root, 'src', 'server.js')).href + `?root=${encodeURIComponent(root)}`);
  const quota = createQuotaServer({ poller });
  await new Promise((ok) => quota.server.listen(0, '127.0.0.1', ok));
  after(() => quota.close());
  const port = quota.server.address().port;
  /** GET with the path sent as written: fetch() would resolve the dots before they left */
  return (path) => new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', fail);
    req.end();
  });
}

test('the server hands out the cove by its manifest, with types and caching to match', async () => {
  const get = await serve(ROOT);
  const list = await get('/weather/manifest.json');
  assert.equal(list.status, 200);
  assert.match(list.headers['content-type'], /^application\/json/);
  assert.equal(list.headers['cache-control'], 'no-cache');
  assert.deepEqual(JSON.parse(list.body), manifest);

  const glb = listed.find(([n]) => n.endsWith('.glb'));
  const one = await get(`/weather/${glb[0]}`);
  assert.equal(one.status, 200);
  assert.equal(one.headers['content-type'], 'model/gltf-binary');
  assert.equal(one.headers['cache-control'], 'max-age=31536000, immutable');
  assert.equal(one.body.length, glb[1].bytes);
  assert.ok(one.headers['content-security-policy'], 'with the security headers');

  const webp = listed.find(([n]) => n.endsWith('.webp'));
  const tex = await get(`/weather/${webp[0]}`);
  assert.equal(tex.status, 200);
  assert.equal(tex.headers['content-type'], 'image/webp');
  assert.equal(tex.headers['cache-control'], 'max-age=31536000, immutable');
  assert.equal(sha8(tex.body), webp[1].sha);

  // the page asks for <name>?v=<sha>; the router reads only the path
  const versioned = await get(`/weather/${webp[0]}?v=${webp[1].sha}`);
  assert.equal(versioned.status, 200);
  assert.equal(sha8(versioned.body), webp[1].sha);

  for (const path of ['/weather/x.glb', '/weather/../src/server.js', '/weather/%2e%2e/package.json', '/weather/',
                      '/weather', '/weather/README.md', '/weather/LICENSE.txt', `/weather/${glb[0].toUpperCase()}`,
                      `/weather//${glb[0]}`, `/weather/${glb[0]}%00`]) {
    assert.equal((await get(path)).status, 404, path);
  }
  // and the page is still the page
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.match(home.headers['content-type'], /^text\/html/);
});

test('the renderer is served from the allowlist as a script, never sniffed or cached stale, and the CSP lets the page load it', async () => {
  const get = await serve(ROOT);
  const home = await get('/');
  const csp = home.headers['content-security-policy'].split('; ');
  assert.ok(csp.includes("script-src 'self' 'unsafe-inline'"), home.headers['content-security-policy']);
  for (const d of ["default-src 'none'", "style-src 'unsafe-inline'", 'img-src data:', "connect-src 'self'", "font-src 'self'",
                   "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) assert.ok(csp.includes(d), d);
  const wx = await get('/weather/wx.js');
  assert.equal(wx.status, 200);
  assert.equal(wx.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(wx.headers['x-content-type-options'], 'nosniff');
  assert.equal(wx.headers['cache-control'], 'no-cache');
  assert.equal(wx.headers['content-security-policy'], home.headers['content-security-policy']);
  assert.ok(wx.body.equals(readFileSync(join(DIR, 'wx.js'))));
  assert.equal((await get('/weather/wx.js?v=1')).status, 200);
  for (const path of ['/weather/WX.js', '/weather/wx.js/', '/weather/wx.mjs', '/wx.js', '/weather/wx.js%00']) {
    assert.equal((await get(path)).status, 404, path);
  }
});

/** A temporary checkout: the server's code and the page, with public/weather/ as `weather` says. */
function checkout(weather) {
  const dir = mkdtempSync(join(tmpdir(), 'ccquota-weather-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
  mkdirSync(join(dir, 'public'));
  cpSync(join(ROOT, 'public', 'index.html'), join(dir, 'public', 'index.html'));
  if (weather !== null) {
    mkdirSync(join(dir, 'public', 'weather'));
    writeFileSync(join(dir, 'public', 'weather', 'manifest.json'), weather);
  }
  return dir;
}

for (const [what, weather] of [['missing', null], ['malformed', '{"v":1,"files":'], ['not a list of files', '{"v":1,"files":[]}']]) {
  test(`with the manifest ${what}, the server still serves the page, and an empty manifest`, async () => {
    const get = await serve(checkout(weather));
    const list = await get('/weather/manifest.json');
    assert.equal(list.status, 200);
    assert.match(list.headers['content-type'], /^application\/json/);
    assert.equal(list.headers['cache-control'], 'no-cache');
    assert.deepEqual(JSON.parse(list.body), EMPTY);
    assert.equal((await get('/')).status, 200);
    assert.equal((await get(`/weather/${listed[0][0]}`)).status, 404);
    // no renderer in this checkout either: a plain 404, on which the page keeps the glass page
    assert.equal((await get('/weather/wx.js')).status, 404);
  });
}

test('a manifest that names a file outside the pattern lets only the good names in', async () => {
  const good = listed.find(([n]) => n.endsWith('.webp'));
  const dir = checkout(JSON.stringify({ v: 1, files: {
    [good[0]]: good[1], '../src/server.js': { bytes: 1 }, 'x/../../package.json': { bytes: 1 }, 'Upper/Case.webp': { bytes: 1 },
    'a/b.js': { bytes: 1 }, 'top.webp': { bytes: 1 },
  } }));
  mkdirSync(join(dir, 'public', 'weather', ...good[0].split('/').slice(0, -1)), { recursive: true });
  cpSync(join(DIR, good[0]), join(dir, 'public', 'weather', good[0]));
  const get = await serve(dir);
  assert.equal((await get(`/weather/${good[0]}`)).status, 200);
  for (const path of ['/weather/../src/server.js', '/weather/x/../../package.json', '/weather/Upper/Case.webp', '/weather/a/b.js', '/weather/top.webp']) {
    assert.equal((await get(path)).status, 404, path);
  }
});
