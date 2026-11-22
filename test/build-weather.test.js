// The Weather theme's renderer as it ships, public/weather/wx.js, and the tool that builds it,
// tools/build-weather.mjs: the minifier only ever removes what cannot change the program, the build
// keeps nothing of the lab, and the file leaves window.WEATHER and nothing else behind.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build, cutLab, emit, lexJS, minGLSL } from '../tools/build-weather.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const min = (src) => emit(lexJS(src).toks, { glsl: 0, plain: 0, kept: [] });
/** What a script leaves in `result`, run as written and run minified: they must agree. */
const same = (src) => {
  const run = (code) => { const ctx = vm.createContext({}); vm.runInContext(code, ctx); return JSON.stringify(ctx.result); };
  const out = min(src);
  assert.equal(run(out), run(src), `${JSON.stringify(src)} became ${JSON.stringify(out)}`);
  return out;
};

test('a line break that ends a statement stays, and one that cannot goes', () => {
  same('let a = 1\nlet b = a\n+1\nresult = [a, b]');
  same('function f() { return\n42 }\nresult = f()');
  same('function f() { return /* a comment\n over two lines */ 42 }\nresult = f()');
  same('let i = 1, j = 2\ni\n++\nj\nresult = [i, j]');
  same('let y = 5\n;[1, 2].forEach((n) => y += n)\nresult = y');
  same('const o = {\n  a: 1,\n  b: [2,\n    3],\n}\nresult = o');
  const out = same('const a = 1;\nconst b = 2;\nresult = a +\n  b;');
  assert.ok(!out.includes('\n'), out);
});

test('tokens that would run together keep a space between them', () => {
  same('let a = 1; result = [a + +a, a - -a, a + ++a, a - --a]');
  same('result = [1 .toString(), 0.5.toFixed(1), typeof "x", void 0]');
  same('let a = 3, b = 1; result = a < !--b');
  same('let x = 8 / 2 / 2; result = x');
});

test('strings, regular expressions and plain templates come out exactly as written', () => {
  same('const re = /[ ]+\\/x/g; result = "a  /x b".replace(re, "-")');
  same('result = "a  // not a comment /* nor this */"');
  same('result = `a  ${1 + 1}  b // still text`');
  same("result = 'it\\'s  ' + \"x\"");
  same('result = [1, 2].map((n) => n * 2).join(" ,  ")');
});

test('GLSL in a template loses its comments and white space, never a token or a directive line', () => {
  const [out] = minGLSL([`#version 300 es
precision highp float;
#define wxEye (uCamZ.w)
// a comment
float f(float a, float b) { /* inline */ return a - -b + wxEye; }
#ifdef X
  float g = 1.;
#endif
`]).parts;
  assert.equal(out, '#version 300 es\nprecision highp float;\n#define wxEye (uCamZ.w)\nfloat f(float a,float b){return a- -b+wxEye;}\n#ifdef X\nfloat g=1.;\n#endif\n');
  // a ${...} keeps the white space around it, whatever it turns out to hold
  assert.deepEqual(minGLSL(['uniform ', ' name;\n', '\nvoid main() {}']).parts, ['uniform ', ' name;\n', '\nvoid main(){}']);
  // one in a comment goes with the comment if it only reads; otherwise the template stays as it is
  assert.deepEqual(minGLSL(['/* r0 = ', ' km */ float r;'], () => true), { parts: [' float r;'], keep: [] });
  assert.equal(minGLSL(['/* r0 = ', ' km */ float r;'], () => false), null);
});

test('a template the code searches is kept as written, and the search still finds its text', () => {
  const src = 'const S = `void main() {\n  if (flip(m)) {}\n  float x = 1.;\n}`.replace("if (flip(m)) {}", "");\nresult = S;';
  const out = same(src);
  assert.ok(out.includes('if (flip(m)) {}'), out);
});

test('lab-only spans are cut, and a broken one stops the build', () => {
  const OPEN = '/' + '*@lab*' + '/', CLOSE = '/' + '*@end*' + '/';
  assert.equal(cutLab(`a(); ${OPEN} lab(); ${CLOSE} b();`, 'x').text, 'a();  b();');
  assert.throws(() => cutLab(`a(); ${OPEN} lab();`, 'x'), /unclosed/);
  assert.throws(() => cutLab(`a(); ${CLOSE}`, 'x'), /no OPEN/);
  assert.throws(() => cutLab(`${OPEN} ${OPEN} ${CLOSE}`, 'x'), /nested/);
});

test('a build from a small lab: the modules in the lab page\'s order, nothing of the lab, one global', () => {
  const lab = mkdtempSync(join(tmpdir(), 'ccquota-build-'));
  after(() => rmSync(lab, { recursive: true, force: true }));
  const OPEN = '/' + '*@lab*' + '/', CLOSE = '/' + '*@end*' + '/';
  mkdirSync(join(lab, 'core')); mkdirSync(join(lab, 'passes'));
  writeFileSync(join(lab, 'index.html'), '<script>const CORE = ["contract", "api"]; const PASSES = ["sky"];</script>');
  writeFileSync(join(lab, 'core', 'contract.js'), '/* the contract */\nvar WX = (typeof window !== "undefined" && window.WX) || {};\n' +
    'if (typeof window !== "undefined") window.WX = WX;\nWX.order = ["contract"];\n');
  writeFileSync(join(lab, 'core', 'api.js'), `WX.order.push("api");\nWX.makeWeather = function () { ${OPEN} WX.lab = 1; ${CLOSE} return WX.order.join(); };\n`);
  writeFileSync(join(lab, 'passes', 'sky.js'), 'WX.order.push("sky");\nWX.fs = `\n  // the sky\n  void main() { o = vec4(1.); }\n`;\n');
  const { code, files } = build(lab);
  assert.deepEqual(files, ['core/contract.js', 'core/api.js', 'passes/sky.js']);
  assert.ok(!/WX\.lab/.test(code), 'the lab-only span is gone');
  const win = {}, ctx = vm.createContext({ window: win }), before = Object.getOwnPropertyNames(ctx);
  vm.runInContext(code, ctx);
  assert.deepEqual(Object.getOwnPropertyNames(ctx).filter((k) => !before.includes(k)), []);
  assert.deepEqual(Object.keys(win), ['WEATHER']);
  assert.equal(win.WEATHER.makeWeather(), 'contract,api,sky');
  // the same sources give the same bytes
  assert.equal(build(lab).code, code);
});

test('the shipped renderer parses, and leaves window.WEATHER = { makeWeather } and nothing else', () => {
  const code = readFileSync(join(ROOT, 'public', 'weather', 'wx.js'), 'utf8');
  assert.match(code, /^\/\* ccusageviz Weather: the view's renderer, \d+ modules \(sources [0-9a-f]{12}\)/);
  assert.ok(!code.includes('/' + '*@lab*' + '/') && !code.includes('/' + '*@end*' + '/'), 'no lab-only marker is left');
  const win = {}, ctx = vm.createContext({ window: win }), before = Object.getOwnPropertyNames(ctx);
  vm.runInContext(code, ctx, { filename: 'wx.js' });
  assert.deepEqual(Object.getOwnPropertyNames(ctx).filter((k) => !before.includes(k)), [], 'no global but window\'s');
  assert.deepEqual(Object.keys(win), ['WEATHER']);
  assert.ok(Object.isFrozen(win.WEATHER));
  assert.deepEqual(Object.keys(win.WEATHER), ['makeWeather']);
  // a browser without WebGL2 (this context has none) gets null at once, the page's cue for the glass page
  assert.equal(win.WEATHER.makeWeather({}, {}), null);
});
