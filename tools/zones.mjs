// The Weather theme's zone table: where each time zone's principal city is, to the nearest degree,
// so the page can guess the viewer's sky from the zone the browser reports without asking anyone.
// Built from the time zone database (public domain): zone1970.tab, then zone.tab for the
// per-country names zone1970.tab folds into one (Europe/Oslo keeps Oslo, not Berlin), then the
// links in tzdata.zi for the older names browsers still report (Asia/Calcutta, Europe/Kiev).
//
//   node tools/zones.mjs [zoneinfo directory, default /usr/share/zoneinfo]
//
// prints the two lines public/index.html holds between its wx-zones markers. Run at build time
// only: the script is neither served nor shipped.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] || '/usr/share/zoneinfo';
const read = (name) => readFileSync(join(dir, name), 'utf8');
const zi = read('tzdata.zi');
const version = (zi.match(/^# version (\S+)/m) || [])[1] || 'unknown';

// ISO 6709 as the .tab files write it: +DDMM[SS]+DDDMM[SS]
function coords(s) {
  const m = s.match(/^([+-])(\d{2})(\d{2})(\d{2})?([+-])(\d{3})(\d{2})(\d{2})?$/);
  if (!m) throw new Error(`cannot read the coordinates ${s}`);
  const deg = (sign, d, min, sec) => (sign === '-' ? -1 : 1) * (+d + +min / 60 + (+sec || 0) / 3600);
  return [deg(m[1], m[2], m[3], m[4]), deg(m[5], m[6], m[7], m[8])];
}

const at = new Map();
for (const file of ['zone1970.tab', 'zone.tab']) {
  for (const line of read(file).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [, place, name] = line.split('\t');
    if (!at.has(name)) at.set(name, coords(place).map(Math.round));
  }
}
const zones = at.size;

// Links point at a zone, and the odd one at another link, so they are followed until none is new.
// Only names with a region: the single words (GB, Japan) are not what a browser reports, and the
// Etc/ zones are offsets, which the page places by their offset.
const links = [...zi.matchAll(/^L (\S+) (\S+)$/gm)].map((m) => [m[1], m[2]])
  .filter(([, name]) => name.includes('/') && !name.startsWith('Etc/'));
for (let grew = true; grew; ) {
  grew = false;
  for (const [target, name] of links) {
    if (at.has(target) && !at.has(name)) { at.set(name, at.get(target)); grew = true; }
  }
}

// Region:City lat lon,City lat lon;Region:... (the city keeps its own slashes: Argentina/Salta)
const regions = new Map();
for (const name of [...at.keys()].sort()) {
  const cut = name.indexOf('/');
  const region = name.slice(0, cut);
  if (!regions.has(region)) regions.set(region, []);
  regions.get(region).push(`${name.slice(cut + 1)} ${at.get(name).join(' ')}`);
}
const table = [...regions].map(([region, rows]) => `${region}:${rows.join(',')}`).join(';');

process.stdout.write(`/* tzdata ${version}: ${zones} zones and ${at.size - zones} older names, each at its principal city to the ` +
  `nearest degree (tools/zones.mjs) */\nconst WX_ZONES = "${table}";\n`);
