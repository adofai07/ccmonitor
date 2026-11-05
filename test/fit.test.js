// The burn rate and its projection, on synthetic readings: whole points as the endpoint gives
// them, tenths as the status line does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './sandbox.js';

sandbox();
const { QuotaPoller, HISTORY_CAPACITY } = await import('../src/poller.js');

const H = 3_600_000;
const IV = 120_000;
// where the true value sits between two rounding steps, so a case holds wherever its steps fall
const OFFSETS = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];

/** Usage over `segments` of [hours, %/hr] from `start`, read every two minutes up to now. */
function readings(segments, { start = 20, offset = 0, step = 1, now = Date.now() } = {}) {
  const hours = segments.reduce((sum, [h]) => sum + h, 0);
  const n = Math.round((hours * H) / IV) + 1;
  const usage = (h) => {
    let v = start + offset;
    let from = 0;
    for (const [d, rate] of segments) {
      v += rate * Math.min(d, Math.max(0, h - from));
      from += d;
    }
    return v;
  };
  const read = (v) => (step === 1 ? Math.round(v) : Math.round(v * 10) / 10);
  const pts = Array.from({ length: n }, (_, i) => ({ t: now - (n - 1 - i) * IV, p: [null, read(usage((i * IV) / H)), null] }));
  return { pts: pts.slice(-HISTORY_CAPACITY), truth: usage(hours), now };
}

/** The weekly fit over those readings, with the window resetting `resetInHours` from now. */
function fitOf({ pts, now }, resetInHours = 160) {
  const poller = new QuotaPoller();
  poller.samples = pts;
  poller.last = { limits: [{ key: 'weekly', percent: pts[pts.length - 1].p[1], resetsAt: new Date(now + resetInHours * H).toISOString() }] };
  return poller.fit('weekly');
}

const near = (got, want, within, what) =>
  assert.ok(Math.abs(got - want) <= within, `${what}: ${got} is not within ${within} of ${want}`);

for (const step of [1, 0.1]) {
  const unit = step === 1 ? 'whole points' : 'tenths';

  test(`a steady burn reads its rate, slow ones included (${unit})`, () => {
    for (const rate of [0.3, 0.65, 1, 1.5, 3]) {
      for (const offset of OFFSETS) {
        const f = fitOf(readings([[12, rate]], { offset, step }));
        near(f.burnPercentPerHour, rate, rate * 0.05, `${rate} %/hr, offset ${offset}`);
      }
    }
  });

  test(`a steady burn that reaches the cap before the reset projects it (${unit})`, () => {
    for (const rate of [0.65, 1, 3]) {
      for (const offset of OFFSETS) {
        const r = readings([[12, rate]], { offset, step });
        const f = fitOf(r);
        assert.notEqual(f.projectedAt, null, `${rate} %/hr, offset ${offset}: no projection`);
        const truth = (100 - r.truth) / rate;
        near((f.projectedAt - r.now) / H, truth, truth * 0.25, `cap at ${rate} %/hr, offset ${offset}, hours`);
      }
    }
  });

  test(`the rate is the current run's, after a change (${unit})`, () => {
    const cases = {
      'idle, then a burn': [[[6, 0], [3, 3]], 3],
      'slow, then fast': [[[6, 1], [3, 5]], 5],
      'fast, then slow': [[[4, 4], [5, 1]], 1],
      'burn, lunch, burn': [[[3, 3], [1, 0], [2, 3]], 3],
      'three rates': [[[3, 1], [3, 4], [3, 2]], 2],
      'idle, then a slow burn': [[[5, 0], [7, 0.8]], 0.8],
    };
    for (const [name, [segments, rate]] of Object.entries(cases)) {
      for (const offset of OFFSETS) {
        near(fitOf(readings(segments, { offset, step })).burnPercentPerHour, rate, rate * 0.06, `${name}, offset ${offset}`);
      }
    }
  });

  test(`idle reads 0.00, with no projection (${unit})`, () => {
    for (const offset of OFFSETS) {
      const f = fitOf(readings([[12, 0]], { offset, step }));
      near(f.burnPercentPerHour, 0, 0.005, `offset ${offset}`);
      assert.equal(f.projectedAt, null);
    }
  });
}

test('a stop reads 0.00 once it has lasted about two points of the burn', () => {
  const cases = [
    ['3 %/hr in whole points, 45 minutes on', [[6, 3], [0.75, 0]], 1],
    ['0.65 %/hr in whole points, 3 hours on', [[8, 0.65], [3, 0]], 1],
    ['3 %/hr in tenths, 30 minutes on', [[6, 3], [0.5, 0]], 0.1],
  ];
  for (const [name, segments, step] of cases) {
    for (const offset of OFFSETS) {
      const f = fitOf(readings(segments, { offset, step }));
      near(f.burnPercentPerHour, 0, 0.005, `${name}, offset ${offset}`);
      assert.equal(f.projectedAt, null, `${name}, offset ${offset}: projected`);
    }
  }
});

test('a fit over a full trace stays cheap, even on readings no source gives', () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const now = Date.now();
  const pts = Array.from({ length: HISTORY_CAPACITY }, (_, i) => ({
    t: now - (HISTORY_CAPACITY - 1 - i) * IV,
    p: [null, Math.round(10 * (20 + i * 0.01 + (random() - 0.5) * 0.9)) / 10, null],
  }));
  const started = performance.now();
  fitOf({ pts, now });
  const ms = performance.now() - started;
  // about 12 ms here; the bound is for a search gone quadratically worse, not for a slow machine
  assert.ok(ms < 2000, `took ${ms.toFixed(1)} ms`);
});
