#!/usr/bin/env node
// Builds public/weather/wx.js, the Weather theme's renderer, from its sources: the modules the
// lab loads (core and passes, in the order its index.html lists them), with every lab-only span
// cut out, then comments and redundant whitespace taken out of the JavaScript and of the GLSL in
// its template strings, wrapped as one function that leaves window.WEATHER = { makeWeather } and
// nothing else behind. The page loads that file only when the Weather theme is chosen.
//
//   node tools/build-weather.mjs --lab <dir> [--out <file>] [--check]
//
// --lab is the folder holding index.html, core/ and passes/. --out defaults to public/weather/wx.js;
// --check builds in memory and fails if the file on disk differs. Zero dependencies, and the output
// is a function of the sources alone: no dates, paths or environment end up in it, so the same
// sources give the same bytes on any machine.
//
// The minifier only removes: it renames nothing and reorders nothing. Every token it keeps is
// written as it was read, and the build re-reads its own output and fails unless the token stream
// (JavaScript and GLSL alike) is the same as the source's, so a tokenizer mistake cannot ship.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { gzipSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/* ───────────── the modules, in the lab's order ───────────── */

// What the lab's index.html loads, if it cannot be read: the order matters (contract first, the api
// after the director, the passes after the core), and every name here must exist.
const FALLBACK = {
  core: ['contract', 'gl', 'renderer', 'assets', 'astro', 'director', 'api'],
  passes: ['atmo', 'clouds', 'night', 'sky', 'coast', 'ocean', 'bolt', 'post', 'rain', 'pane'],
};

/** The module list from the lab page's own loader (its CORE and PASSES arrays), so the two agree. */
function moduleOrder(lab) {
  let html;
  try { html = readFileSync(join(lab, 'index.html'), 'utf8'); } catch { return { ...FALLBACK, from: 'built-in list' }; }
  const list = (name) => {
    const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(html);
    if (!m) throw new Error(`index.html has no ${name} array to read the module order from`);
    return [...m[1].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]);
  };
  // core/lab.js is the lab's driver; it never ships
  return { core: list('CORE').filter((n) => n !== 'lab'), passes: list('PASSES'), from: 'index.html' };
}

/* ───────────── the lab-only spans ───────────── */

// The contract's markers (WX.LAB_MARKERS): block comments whose text is exactly @lab and @end.
// Written by concatenation, as the contract asks, so this file never holds one.
const OPEN = '/' + '*@lab*' + '/', CLOSE = '/' + '*@end*' + '/';

/** Every span from an OPEN to the next CLOSE removed, both included; a stray or unclosed one is an error. */
function cutLab(src, file) {
  let out = '', i = 0, spans = 0;
  for (;;) {
    const a = src.indexOf(OPEN, i), c = src.indexOf(CLOSE, i);
    if (c >= 0 && (a < 0 || c < a)) throw new Error(`${file}: a lab-only CLOSE with no OPEN before it (offset ${c})`);
    if (a < 0) return { text: out + src.slice(i), spans };
    const b = src.indexOf(CLOSE, a + OPEN.length);
    if (b < 0) throw new Error(`${file}: an unclosed lab-only span (offset ${a})`);
    const inner = src.indexOf(OPEN, a + OPEN.length);
    if (inner >= 0 && inner < b) throw new Error(`${file}: nested lab-only spans (offset ${inner})`);
    out += src.slice(i, a);
    i = b + CLOSE.length;
    spans++;
  }
}

/* ───────────── JavaScript tokens ───────────── */

const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '<<', '>>', '**', '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~',
  '?', ':', '=', '.', '@'];
// after these words an expression starts, so a slash opens a regular expression
const BEFORE_EXPR = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case',
  'do', 'else', 'yield', 'await']);
const isIdStart = (c) => /[A-Za-z_$#\\]/.test(c) || c > '\x7f';
const isIdPart = (c) => /[\w$\\]/.test(c) || c > '\x7f';
const isDigit = (c) => c >= '0' && c <= '9';

/**
 * The tokens of a script, or of one ${...} inside a template (`nested`: stop at its closing brace).
 * Each is { t: 'word' | 'num' | 'punct' | 'str' | 'regex' | 'tpl', v, nl } where nl says a line
 * break (or a comment holding one) came before it; a 'tpl' has its raw text pieces in `parts` and
 * the tokens of each ${...} in `subs`.
 */
function lexJS(src, pos = 0, nested = false) {
  const toks = [];
  let nl = false, depth = 0;
  const prevAllowsRegex = () => {
    const p = toks[toks.length - 1];
    if (!p) return true;
    if (p.t === 'punct') return ![')', ']', '}'].includes(p.v);
    if (p.t === 'word') return BEFORE_EXPR.has(p.v);
    return false;
  };
  const push = (t, v, extra) => { toks.push({ t, v, nl, ...extra }); nl = false; };
  while (pos < src.length) {
    const c = src[pos], d = src[pos + 1];
    if (c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029') { nl = true; pos++; continue; }
    if (c === ' ' || c === '\t' || c === '\v' || c === '\f' || c === '\ufeff' || c === '\u00a0') { pos++; continue; }
    if (c === '/' && d === '/') { while (pos < src.length && !/[\n\r\u2028\u2029]/.test(src[pos])) pos++; continue; }
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', pos + 2);
      if (e < 0) throw new Error(`an unclosed comment at ${pos}`);
      if (/[\n\r\u2028\u2029]/.test(src.slice(pos, e))) nl = true;
      pos = e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let i = pos + 1;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') i++;
        else if (src[i] === '\n') throw new Error(`a line break in a string at ${pos}`);
        i++;
      }
      if (i >= src.length) throw new Error(`an unclosed string at ${pos}`);
      push('str', src.slice(pos, i + 1));
      pos = i + 1;
      continue;
    }
    if (c === '`') {
      const parts = [], subs = [];
      let i = pos + 1, piece = '';
      for (;;) {
        if (i >= src.length) throw new Error(`an unclosed template at ${pos}`);
        const x = src[i];
        if (x === '\\') { piece += src.slice(i, i + 2); i += 2; continue; }
        if (x === '`') { parts.push(piece); i++; break; }
        if (x === '$' && src[i + 1] === '{') {
          parts.push(piece); piece = '';
          const inner = lexJS(src, i + 2, true);
          subs.push(inner.toks);
          i = inner.pos;
          continue;
        }
        piece += x; i++;
      }
      push('tpl', src.slice(pos, i), { parts, subs });
      pos = i;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(d))) {
      const m = /^(?:0[xXoObB][\da-fA-F_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?)/.exec(src.slice(pos, pos + 64));
      push('num', m[0]);
      pos += m[0].length;
      continue;
    }
    if (isIdStart(c)) {
      let i = pos + 1;
      while (i < src.length && isIdPart(src[i])) { if (src[i] === '\\') i++; i++; }
      push('word', src.slice(pos, i));
      pos = i;
      continue;
    }
    if (c === '/' && prevAllowsRegex()) {
      let i = pos + 1, cls = false;
      for (;; i++) {
        if (i >= src.length || src[i] === '\n') throw new Error(`an unclosed regular expression at ${pos}`);
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === '[') cls = true;
        else if (src[i] === ']') cls = false;
        else if (src[i] === '/' && !cls) break;
      }
      i++;
      while (i < src.length && isIdPart(src[i])) i++;
      push('regex', src.slice(pos, i));
      pos = i;
      continue;
    }
    // ?. is optional chaining only when no digit follows (a ? .5 : b)
    const p = PUNCT.find((s) => src.startsWith(s, pos) && !(s === '?.' && isDigit(src[pos + 2])));
    if (!p) throw new Error(`an unexpected character ${JSON.stringify(c)} at ${pos}`);
    if (nested) {
      if (p === '{') depth++;
      else if (p === '}') { if (depth === 0) return { toks, pos: pos + 1 }; depth--; }
    }
    push('punct', p);
    pos += p.length;
  }
  if (nested) throw new Error('an unclosed ${ in a template');
  return { toks, pos };
}

/* ───────────── GLSL in template strings ───────────── */

// A template is shader source when it declares or uses what only GLSL has; anything else (a message,
// a style sheet) is kept exactly as written.
const GLSL_HINT = /#version|#define|#ifn?def|\bvoid\s+main\b|\buniform\b|\b[biu]?vec[234]\b|\bmat[234]\b|\bfloat\s+\w+\s*[(=;,]|\bsampler2D\b/;
const SUB = '\u0001';                  // stands for a ${...} while the text around it is read
const GLSL_WORD = /[\w.\u0001]/;
const GLSL_OP = '+-*/%<>=!&|^';

/** Which ${...} of a GLSL template sit inside a GLSL comment (their text never reaches the compiler). */
function commentedSubs(parts) {
  const text = parts.join(SUB), out = new Set();
  for (const m of text.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)) {
    for (let k = 0, n = 0; k < text.length; k++) if (text[k] === SUB) { if (k >= m.index && k < m.index + m[0].length) out.add(n); n++; }
  }
  return out;
}

/**
 * One GLSL template's raw pieces, minified: comments gone, every run of white space removed where
 * the tokens on its two sides cannot run together, or cut to one space (one line break where a
 * ${...} or a preprocessor line needs it). A ${...} inside a comment goes with it, if `droppable`
 * says reading it has no effect. Returns { parts, keep } (keep: the ${...} kept, by index), or
 * null to leave the template as written.
 */
function minGLSL(parts, droppable = () => false) {
  const text = parts.join(SUB);
  if (text.includes('\\')) return null;          // an escape in the raw text: not worth the risk
  const gone = commentedSubs(parts);
  for (const k of gone) if (!droppable(k)) return null;
  // 1. pieces: runs of white space (comments count as white space) and runs of anything else
  const segs = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c) || (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*'))) {
      let nl = false, j = i;
      for (;;) {
        if (j < text.length && /\s/.test(text[j])) { if (text[j] === '\n') nl = true; j++; continue; }
        if (text.startsWith('//', j)) { const e = text.indexOf('\n', j); j = e < 0 ? text.length : e; continue; }
        if (text.startsWith('/*', j)) {
          const e = text.indexOf('*/', j + 2);
          if (e < 0) throw new Error('an unclosed GLSL comment');
          if (text.slice(j, e).includes('\n')) nl = true;
          j = e + 2;
          continue;
        }
        break;
      }
      segs.push({ ws: true, nl });
      i = j;
      continue;
    }
    let j = i;
    while (j < text.length && !/\s/.test(text[j]) && !(text[j] === '/' && (text[j + 1] === '/' || text[j + 1] === '*'))) j++;
    segs.push({ ws: false, v: text.slice(i, j) });
    i = j;
  }
  // 2. which pieces belong to a preprocessor line: from a '#' first on its line to the next line break
  let line = true, inDir = false;
  for (const s of segs) {
    if (s.ws) { if (s.nl) { line = true; inDir = false; } continue; }
    if (line && s.v[0] === '#') inDir = true;
    s.dir = inDir;
    line = false;
  }
  // 3. the text again, with only the white space that matters
  let out = '';
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    if (!s.ws) { out += s.v; continue; }
    const a = segs[k - 1], b = segs[k + 1];
    if (!a || !b) { out += s.nl ? '\n' : ' '; continue; }                    // the template's own edges
    const x = a.v[a.v.length - 1], y = b.v[0];
    if (a.dir && s.nl) { out += '\n'; continue; }                             // a preprocessor line ends
    if (b.dir && !a.dir) { out += '\n'; continue; }                           // one begins
    if (a.dir) { out += ' '; continue; }                                      // inside one: as written, one space
    if (x === SUB || y === SUB) { out += s.nl ? '\n' : ' '; continue; }       // next to a ${...}: unknown text
    if (GLSL_WORD.test(x) && GLSL_WORD.test(y)) { out += ' '; continue; }
    if (GLSL_OP.includes(x) && GLSL_OP.includes(y)) { out += ' '; continue; }
  }
  const keep = [...parts.keys()].slice(1).map((k) => k - 1).filter((k) => !gone.has(k));
  const back = out.split(SUB);
  if (back.length !== keep.length + 1) throw new Error('a ${...} went missing in a GLSL template');
  return { parts: back, keep };
}

// A ${...} that only reads (names, numbers, dots, arithmetic: no call, no assignment) can be dropped
// with the comment it sits in.
const PURE = new Set(['.', '?.', '+', '-', '*', '/', '%']);
const pure = (toks) => toks.every((t) => t.t === 'num' || (t.t === 'word' && !BEFORE_EXPR.has(t.v)) || (t.t === 'punct' && PURE.has(t.v)));

/** GLSL's tokens, for the check that minifying kept every one: words, numbers, operators, directive lines. */
function glslTokens(parts) {
  const text = parts.join(SUB).replace(/\/\*[\s\S]*?\*\//g, (m) => (m.includes('\n') ? '\n' : ' ')).replace(/\/\/[^\n]*/g, '');
  const out = [];
  for (const raw of text.split('\n')) {
    const ln = raw.trim();
    if (!ln) continue;
    if (ln[0] === '#') { out.push(ln.replace(/\s+/g, ' ')); continue; }
    for (const m of ln.matchAll(/[\w.\u0001]+|[+\-*/%<>=!&|^]+|\S/g)) out.push(m[0]);
  }
  return out;
}

/* ───────────── JavaScript out ───────────── */

// After these a line break can never end a statement (nothing can be inserted there), so it can go.
const OPEN_AFTER = new Set(['{', '(', '[', ',', ';', ':', '?', '?.', '.', '=>', '...', '!', '~',
  '=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=',
  '==', '!=', '===', '!==', '<', '>', '<=', '>=', '&&', '||', '??', '+', '-', '*', '/', '%', '**',
  '&', '|', '^', '<<', '>>', '>>>']);
// Before these a line break changes nothing either: none can begin a statement ('}' ends one anyway).
const CLOSE_BEFORE = new Set([')', ']', '}', ',', ';', ':', '?', '.', '?.', '=>', '=', '==', '!=', '===', '!==',
  '&&', '||', '??', '*', '%', '**', '<', '>', '<=', '>=', '&', '|', '^', '<<', '>>', '>>>',
  '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=']);
// A line break after these words is part of the grammar (return \n x returns nothing).
const RESTRICTED = new Set(['return', 'throw', 'break', 'continue', 'yield', 'async', 'let', 'get', 'set', 'static']);
const isWordy = (c) => /[\w$\\#]/.test(c) || c > '\x7f';

/** Between two tokens on one line: a space only where the two would otherwise read as one. */
function needSpace(a, b) {
  const x = a.v[a.v.length - 1], y = b.v[0];
  if (isWordy(x) && isWordy(y)) return true;
  if (a.t === 'num' && y === '.') return true;
  if ((x === '+' && y === '+') || (x === '-' && y === '-')) return true;
  if (x === '/' && (y === '/' || y === '*')) return true;
  if ((x === '<' && y === '!') || (x === '-' && y === '>')) return true;
  return false;
}
function gap(a, b) {
  if (!a) return '';
  if (b.nl) {
    const free = (a.t === 'punct' && OPEN_AFTER.has(a.v)) || (b.t === 'punct' && CLOSE_BEFORE.has(b.v));
    const fixed = (a.t === 'word' && RESTRICTED.has(a.v)) || (b.t === 'punct' && (b.v === '++' || b.v === '--'));
    if (!free || fixed) return '\n';
  }
  return needSpace(a, b) ? ' ' : '';
}

// Code that searches shader text (`...`.replace("if (x) {}", "")) would no longer find what it looks
// for once the white space is gone: a template such a call can match is kept exactly as written.
const SEARCH = new Set(['replace', 'replaceAll', 'includes', 'indexOf', 'lastIndexOf', 'split', 'startsWith', 'endsWith',
  'match', 'matchAll', 'search']);
/** The string and regex literals a module hands to a string search, as tests on a template's text. */
function searches(toks, out = []) {
  toks.forEach((t, k) => {
    if (t.t === 'tpl') t.subs.forEach((s) => searches(s, out));
    const [a, b, c] = toks.slice(k - 3, k);
    if (k < 3 || a.v !== '.' || b.t !== 'word' || !SEARCH.has(b.v) || c.v !== '(') return;
    if (t.t === 'str') {
      const v = new Function('return ' + t.v)();          // a string literal's value; the build's own process, never the page
      if (v.trim() && /\s|\/\/|\/\*/.test(v)) out.push({ what: t.v, hits: (x) => x.includes(v) });
    } else if (t.t === 'regex') {
      const m = /^\/([\s\S]*)\/(\w*)$/.exec(t.v), re = new RegExp(m[1], m[2].replace(/[gy]/g, ''));
      out.push({ what: t.v, hits: (x) => { const r = re.exec(x); return !!r && /\s|\/\/|\/\*/.test(r[0]); } });
    }
  });
  return out;
}

/** Minified JavaScript from tokens; counts what it did in `stats`. */
function emit(toks, stats, found = searches(toks)) {
  let out = '', prev = null;
  for (const tk of toks) {
    let v = tk.v;
    if (tk.t === 'tpl') {
      const text = tk.parts.join(SUB), hit = found.find((f) => f.hits(text));
      if (hit) stats.kept.push(hit.what);
      const glsl = GLSL_HINT.test(text) && !hit ? minGLSL(tk.parts, (k) => pure(tk.subs[k])) : null;
      const parts = glsl ? glsl.parts : tk.parts, subs = glsl ? glsl.keep.map((k) => tk.subs[k]) : tk.subs;
      if (glsl) stats.glsl++; else stats.plain++;
      v = '`' + parts.map((p, k) => (k ? '${' + emit(subs[k - 1], stats, found) + '}' : '') + p).join('') + '`';
    }
    const cur = { ...tk, v };
    out += gap(prev, cur) + v;
    prev = cur;
  }
  return out;
}

/** The shape the check compares: every JS token, with each template's GLSL (or raw text) and its subs. */
function shape(toks, glsl, found = searches(toks)) {
  const out = [];
  for (const tk of toks) {
    if (tk.t !== 'tpl') { out.push(tk.t + ':' + tk.v); continue; }
    const isGL = glsl && GLSL_HINT.test(tk.parts.join('')) && !found.some((f) => f.hits(tk.parts.join(SUB)));
    const gone = isGL ? commentedSubs(tk.parts) : new Set();
    out.push('tpl', ...(isGL ? glslTokens(tk.parts).map((g) => 'glsl:' + g) : tk.parts.map((p) => 'raw:' + JSON.stringify(p))));
    // a ${...} in a GLSL comment is not part of the shader: the minified side has dropped it
    tk.subs.forEach((s, k) => { if (!gone.has(k)) out.push('${', ...shape(s, glsl, found), '}'); });
  }
  return out;
}

/* ───────────── the bundle ───────────── */

// The contract's first statements make WX a global for the lab's separate scripts; in the bundle it
// is a constant of the wrapper's scope instead (contract.js says so in its merge note).
const CONTRACT_HEAD = /^var WX = \(typeof window !== "undefined" && window\.WX\) \|\| \{\};\nif \(typeof window !== "undefined"\) window\.WX = WX;\n/m;

export function build(labDir, { expose = false } = {}) {
  const lab = resolve(labDir);
  const order = moduleOrder(lab);
  const files = [...order.core.map((n) => `core/${n}.js`), ...order.passes.map((n) => `passes/${n}.js`)];
  const stats = { glsl: 0, plain: 0, spans: 0, raw: 0, stripped: 0, kept: [] };
  const hash = createHash('sha256');
  const bodies = [];
  for (const f of files) {
    const src = readFileSync(join(lab, f), 'utf8');
    hash.update(f + '\0' + src + '\0');
    stats.raw += Buffer.byteLength(src);
    let { text, spans } = cutLab(src, f);
    stats.spans += spans;
    if (f === 'core/contract.js') {
      if (!CONTRACT_HEAD.test(text)) throw new Error('core/contract.js no longer starts with the global WX it is expected to declare');
      text = text.replace(CONTRACT_HEAD, 'const WX = {};\n');
    }
    stats.stripped += Buffer.byteLength(text);
    try { new Script(text, { filename: f }); } catch (e) { throw new Error(`${f} does not parse once its lab-only spans are cut: ${e.message}`); }
    const toks = lexJS(text).toks;
    const n0 = stats.kept.length;
    const min = emit(toks, stats);
    for (let k = n0; k < stats.kept.length; k++) stats.kept[k] = `${f}: ${stats.kept[k]}`;
    // the check: the same tokens back, the same GLSL tokens in every shader
    const again = lexJS(min).toks;
    const A = shape(toks, true), B = shape(again, true);
    if (A.length !== B.length || A.some((x, k) => x !== B[k])) {
      const k = A.findIndex((x, n) => x !== B[n]), near = (L) => L.slice(Math.max(0, k - 4), k + 3).join(' ');
      throw new Error(`${f}: minifying changed token ${k}: ${near(A)}  became  ${near(B)}`);
    }
    bodies.push(min);
  }
  const id = hash.digest('hex').slice(0, 12);
  const head = `/* ccusageviz Weather: the view's renderer, ${files.length} modules (sources ${id}), made by tools/build-weather.mjs.\n` +
    '   Generated: edit the sources and build again. Loaded only by the Weather theme. */\n';
  const tail = expose ? 'window.WEATHER={makeWeather:WX.makeWeather};window.WX=WX;' : 'window.WEATHER=Object.freeze({makeWeather:WX.makeWeather});';
  const code = head + '(function(){\n' + bodies.join(';\n') + ';\n' + tail + '\n})();\n';
  try { new Script(code, { filename: 'wx.js' }); } catch (e) { throw new Error(`the bundle does not parse: ${e.message}`); }
  return { code, files, order, stats, id };
}

/* ───────────── command line ───────────── */

function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const labDir = arg('--lab');
  if (!labDir) { process.stderr.write('usage: node tools/build-weather.mjs --lab <dir> [--out <file>] [--check] [--expose]\n'); return 2; }
  const out = resolve(arg('--out') || join(ROOT, 'public', 'weather', 'wx.js'));
  const { code, files, order, stats, id } = build(labDir, { expose: argv.includes('--expose') });
  const size = Buffer.byteLength(code), gz = gzipSync(code, { level: 9 }).length;
  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  process.stdout.write(`${files.length} modules (order from ${order.from}), sources ${id}\n` +
    `  raw ${kb(stats.raw)}, lab-only spans cut ${stats.spans} -> ${kb(stats.stripped)}, minified ${kb(size)}, gzip ${kb(gz)}\n` +
    `  GLSL templates minified ${stats.glsl}, other templates kept as written ${stats.plain}\n` +
    stats.kept.map((k) => `  kept as written, since the code searches its text: ${k}\n`).join(''));
  if (argv.includes('--check')) {
    let now = '';
    try { now = readFileSync(out, 'utf8'); } catch { /* missing: differs */ }
    if (now !== code) { process.stderr.write(`${out} is not what these sources build\n`); return 1; }
    process.stdout.write('  the file on disk matches\n');
    return 0;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, code);
  process.stdout.write(`  wrote ${out.startsWith(ROOT) ? out.slice(ROOT.length) : out}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { process.stderr.write(`build-weather: ${e.message}\n`); process.exitCode = 1; }
}

export { cutLab, lexJS, minGLSL, emit };
