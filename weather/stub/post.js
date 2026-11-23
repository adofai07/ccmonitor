/* STUB post (pane stream C replaces passes/post.js; this copy in stub/ stays frozen).
   bloom slot (world stage): a blur pyramid from SCENE (down chain, then an up chain that is an
   energy-preserving blur, left in R.priv.blur for the pane), the exposure meter and the scrim
   meter, both read back asynchronously.
   post slot (every frame): HDR + a little bloom, AgX (Wrensch's fit), TPDF dither, to the canvas.
   Exposure: R.exposure = {E, prev, EV}; the core puts it in uExpo for the next frame.
   Scrim: R.meter.grid = Float32Array(32), display luminance of a 4 x 8 grid (row 0 at the top).
   Placeholder: plain box filters, no dissolve, no scotopic shift. */
WX.pass((function () {
  let P = {}, down = [], up = [], meter = null, grid = null, busy = { m: false, g: false };
  const AGX = `
    vec3 agxCurve(vec3 x) { vec3 x2 = x * x, x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + .4298 * x2 + .1191 * x - .00232; }
    vec3 agx(vec3 v) {
      const mat3 M = mat3(.842479062253094, .0423282422610123, .0423756549057051, .0784335999999992, .878468636469772, .0784336, .0792237451477643, .0791661274605434, .879142973793104);
      const mat3 Mi = mat3(1.19687900512017, -.0528968517574562, -.0529716355144438, -.0980208811401368, 1.15190312990417, -.0980434501171241, -.0990297440797205, -.0989611768448433, 1.15107367264116);
      const float lo = -12.47393, hi = 4.026069;
      v = M * max(v, vec3(1e-10)); v = clamp(log2(v), lo, hi); v = (v - lo) / (hi - lo);
      return Mi * agxCurve(v);
    }`;
  return {
    name: "post",
    *build(R) {
      down = []; up = []; busy = { m: false, g: false };   // a new context: forget the old one's objects
      P.down = R.program("post.down", { fs: `
        uniform sampler2D uSrc; uniform vec2 uTexel; in vec2 vUV; out vec4 o;
        vec3 s(vec2 uv) { return wxGuard(texture(uSrc, uv).rgb); }
        void main() {
          vec2 t = uTexel;
          o = vec4((s(vUV + vec2(-t.x, -t.y)) + s(vUV + vec2(t.x, -t.y)) + s(vUV + vec2(-t.x, t.y)) + s(vUV + t)) * .25, 1.);
        }` });
      P.up = R.program("post.up", { fs: `
        uniform sampler2D uCoarse, uFine; in vec2 vUV; out vec4 o;
        void main() { o = vec4(mix(texture(uFine, vUV).rgb, texture(uCoarse, vUV).rgb, .5), 1.); }` });
      P.meter = R.program("post.meter", { fs: `
        uniform sampler2D uSrc; out vec4 o;
        void main() {
          float s = 0.;
          for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++)
            s += log(max(wxLuma(texture(uSrc, (vec2(x, y) + .5) / 8.).rgb) / uExpo.x, 1e-12));
          o = vec4(exp(s / 64.), 0., 0., 1.);
        }` });
      P.grid = R.program("post.grid", { fs: AGX + `
        uniform sampler2D uSrc; out vec4 o;
        void main() {
          vec2 cell = floor(gl_FragCoord.xy);
          float s = 0.;
          for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
            vec2 uv = (cell + (vec2(x, y) + .5) / 4.) / vec2(4., 8.);
            vec3 c = clamp(agx(texture(uSrc, uv).rgb), 0., 1.);
            s += wxLuma(pow(c, vec3(2.2)));
          }
          o = vec4(s / 16., 0., 0., 1.);
        }` });
      P.tone = R.program("post.tone", { fs: AGX + `
        uniform sampler2D uBloom; in vec2 vUV; out vec4 o;
        void main() {
          vec3 c = mix(texture(sHDR, vUV).rgb, texture(uBloom, vUV).rgb, .03);
          vec3 d = agx(c);
          vec2 px = gl_FragCoord.xy + uJitter.xy * 64.;
          float n = wxIGN(px) + wxIGN(px.yx * 1.37 + 17.) - 1.;
          o = vec4(clamp(d, 0., 1.) + n / 255., 1.);
        }` });
      yield* R.wait(P.down, P.up, P.meter, P.grid, P.tone);
      meter = R.gpu.fbo([R.gpu.tex2D(1, 1, "rgba32f", { filter: "nearest" })]);
      grid = R.gpu.fbo([R.gpu.tex2D(4, 8, "rgba32f", { filter: "nearest" })]);
    },
    resize(R) {
      const gl = R.gl;
      for (const t of down.concat(up)) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb.fb); }
      down = []; up = [];
      let [w, h] = R.size.S;
      for (let k = 0; k < 6; k++) {
        w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
        const a = R.gpu.tex2D(w, h, "r11g11b10f"), b = R.gpu.tex2D(w, h, "r11g11b10f");
        a.fb = R.gpu.fbo([a]); b.fb = R.gpu.fbo([b]);
        down.push(a); up.push(b);
      }
      R.priv.blur = up;
      R.debugTex("post.blur0", up[0], "hdr");
      R.debugTex("post.blur2", up[2], "hdr");
    },
    slots: {
      bloom(R, F) {
        let src = R.tex.SCENE, tw = R.size.S[0], th = R.size.S[1];
        for (const d of down) { R.draw(P.down, d.fb, { uSrc: src, uTexel: [0.5 / tw, 0.5 / th] }); src = d; tw = d.w; th = d.h; }
        R.draw(P.up, up[5].fb, { uCoarse: down[5], uFine: down[5] });
        for (let k = 4; k >= 0; k--) R.draw(P.up, up[k].fb, { uCoarse: up[k + 1], uFine: down[k] });
        if (!busy.m && !F.lockExposure) {
          R.draw(P.meter, meter, { uSrc: down[4] });
          busy.m = R.gpu.readback(meter.fb, 0, 0, 1, 1, (px) => {
            busy.m = false;
            const L = Math.max(px[0], 1e-12) * 128000;                  // cd/m2
            const EV = Math.log2(L * 100 / 12.5);
            const EVc = Math.max(EV + 2.6 * (1 - WX.util.smooth(-2, 10, EV)), -3.5);
            const target = 128000 / (1.2 * Math.pow(2, EVc));
            const ex = R.exposure, k = F.still ? 1 : 1 - Math.exp(-0.25 / (target > ex.E ? 2.5 : 1.0));
            ex.prev = ex.E;
            ex.E = Math.exp(Math.log(ex.E) + (Math.log(target) - Math.log(ex.E)) * k);
            ex.EV = EVc;
          });
        }
        if (!busy.g) {
          R.draw(P.grid, grid, { uSrc: down[3] });
          busy.g = R.gpu.readback(grid.fb, 0, 0, 4, 8, (px) => {
            busy.g = false;
            const g = new Float32Array(32);
            for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) g[(7 - y) * 4 + x] = px[(y * 4 + x) * 4];
            R.meter.grid = g; R.meter.at = performance.now();
          });
        }
      },
      post(R) { R.draw(P.tone, null, { uBloom: up[0] }); },
    },
  };
})());
