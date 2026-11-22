// Where the Weather theme puts the viewer's sky, from the time zone alone: the page's own wxPlace()
// and its zone table, read out of public/index.html between their markers and run as they are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const page = readFileSync(`${ROOT}public/index.html`, 'utf8');
const between = (from, to) => {
  const a = page.indexOf(from), b = page.indexOf(to);
  assert.ok(a >= 0 && b > a, `the page marks ${from} … ${to}`);
  return page.slice(a + from.length, b);
};
const PLACE = between('/* wx-place:begin */', '/* wx-place:end */');
const ZONES = between('/* wx-zones:begin */\n', '/* wx-zones:end */');

/** The page's place code in a fresh context; `run` is an expression over its names. Its answer comes
    back as JSON, so it is a plain value of this realm. */
const evaluate = (run) => JSON.parse(vm.runInNewContext(`${PLACE}\n;JSON.stringify(${run})`, { Intl, Date, Math, Number, Map, RegExp, String, JSON }));
const place = (zone) => evaluate(`wxPlace(${JSON.stringify(zone)})`);

const GREENWICH = { lat: 51, lon: 0 };
const UTC_LIKE = /^(Etc\/)?(UTC|UCT|GMT|GMT[+-]?0|Greenwich|Universal|Zulu)$/;

test('every zone this runtime knows resolves through the table, at its principal city', () => {
  const zones = Intl.supportedValuesOf('timeZone');
  assert.ok(zones.length > 300);
  const missing = zones.filter((z) => !UTC_LIKE.test(z) && evaluate(`wxZone(${JSON.stringify(z)})`) === null);
  assert.deepEqual(missing, []);
  for (const z of zones) {
    const p = place(z);
    assert.equal(p.from, 'zone', z);
    assert.equal(p.zone, z);
  }
});

test('the older names browsers report are in it too', () => {
  const at = (z) => { const p = place(z); return [p.lat, p.lon]; };
  assert.deepEqual(at('Asia/Seoul'), [38, 127]);
  assert.deepEqual(at('Asia/Calcutta'), at('Asia/Kolkata'));
  assert.deepEqual(at('Europe/Kiev'), at('Europe/Kyiv'));
  assert.deepEqual(at('Asia/Saigon'), at('Asia/Ho_Chi_Minh'));
  assert.deepEqual(at('America/Buenos_Aires'), at('America/Argentina/Buenos_Aires'));
  assert.deepEqual(at('America/Argentina/Buenos_Aires'), [-35, -58]);
  // zone.tab keeps the per-country names zone1970.tab folds together: Oslo stays Oslo
  assert.deepEqual(at('Europe/Oslo'), [60, 11]);
});

test('UTC, GMT and +00:00 go to Greenwich', () => {
  for (const z of ['UTC', 'GMT', 'Etc/UTC', 'Etc/GMT', 'Etc/Universal', 'Etc/Zulu', 'Greenwich', '+00:00', '-00:00', '+0000']) {
    const p = place(z);
    assert.deepEqual({ lat: p.lat, lon: p.lon }, GREENWICH, z);
    assert.equal(p.from, 'zone', z);
  }
});

test('an unknown zone goes on its standard meridian at 40° N', () => {
  // Etc/GMT+5 is five hours behind UTC, and not in the table (its name is an offset)
  assert.deepEqual(place('Etc/GMT+5'), { lat: 40, lon: -75, zone: 'Etc/GMT+5', from: 'offset' });
  assert.deepEqual(place('Etc/GMT-9'), { lat: 40, lon: 135, zone: 'Etc/GMT-9', from: 'offset' });
  // an offset zone, as newer browsers may report: 82.5° to the nearest degree
  assert.deepEqual(place('+05:30'), { lat: 40, lon: 83, zone: '+05:30', from: 'offset' });
  // past the date line the meridian wraps into [-180, 180)
  assert.equal(place('Etc/GMT-14').lon, -150);
});

test('a zone the browser cannot name is placed by its own clock, at 35° S where summer is in January', () => {
  // a child process, so its clock can be put in another zone: Sydney keeps +10:00 in July, +11:00 in January
  const run = (tz) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import vm from 'node:vm';
    const place = ${JSON.stringify(PLACE)};
    process.stdout.write(JSON.stringify(vm.runInNewContext(place + ';wxPlace("Nowhere/Atlantis")', { Intl, Date, Math, Number, Map, RegExp, String })));
  `], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }));
  assert.deepEqual(run('Australia/Sydney'), { lat: -35, lon: 150, zone: 'Nowhere/Atlantis', from: 'offset' });
  assert.deepEqual(run('America/Chicago'), { lat: 40, lon: -90, zone: 'Nowhere/Atlantis', from: 'offset' });
});

test('the table is whole degrees on the globe, and says which tzdata it came from', () => {
  const version = /^\/\* tzdata (\S+): (\d+) zones and (\d+) older names/.exec(ZONES);
  assert.ok(version, 'the comment names the tzdata release');
  const table = /const WX_ZONES = "([^"]*)";/.exec(ZONES)[1];
  let rows = 0;
  for (const group of table.split(';')) {
    const [region, list] = [group.slice(0, group.indexOf(':')), group.slice(group.indexOf(':') + 1)];
    assert.match(region, /^[A-Za-z_]+$/);
    for (const row of list.split(',')) {
      const m = /^([A-Za-z0-9_+\-/]+) (-?\d+) (-?\d+)$/.exec(row);
      assert.ok(m, `${region}: ${row}`);
      assert.ok(Math.abs(+m[2]) <= 90 && Math.abs(+m[3]) <= 180, row);
      rows++;
    }
  }
  assert.equal(rows, +version[2] + +version[3]);
  assert.ok(table.length < 12000, 'about 8 KB');
  assert.doesNotMatch(ZONES, /\/usr\/|\/home\/|zoneinfo\//, 'no paths in what ships');
});

test('tools/zones.mjs makes this very table from the same tzdata', (t) => {
  const zi = '/usr/share/zoneinfo/tzdata.zi';
  const theirs = existsSync(zi) ? (/^# version (\S+)/m.exec(readFileSync(zi, 'utf8')) || [])[1] : null;
  const ours = /tzdata (\S+):/.exec(ZONES)[1];
  if (theirs !== ours) return t.skip(`this machine has tzdata ${theirs ?? 'none'}, the table ${ours}`);
  assert.equal(execFileSync(process.execPath, [`${ROOT}tools/zones.mjs`], { encoding: 'utf8' }), ZONES);
});
