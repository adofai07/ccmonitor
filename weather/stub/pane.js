/* STUB pane (pane stream C replaces passes/pane.js; this copy in stub/ stays frozen).
   The drops slot (CPU simulation, height map) and the pane slot: SCENE with RAIN over it,
   seen through the glass, into HDR. Placeholder: no drops; the mist blends to the blur
   post leaves in R.priv.blur (its up-chain, [0] = half size, [2] = an eighth). */
WX.pass((function () {
  let P = null;
  return {
    name: "pane",
    *build(R) {
      P = R.program("pane.stub", { fs: `
        uniform sampler2D uBlur;
        in vec2 vUV; out vec4 o;
        void main() {
          vec4 s = texture(sScene, vUV), r = texture(sRain, vUV);
          vec3 through = s.rgb * (1. - r.a) + r.rgb;
          vec3 b = textureLod(uBlur, vUV, 0.).rgb;
          vec3 mist = b * .85 + .12 * wxLuma(b);
          o = vec4(wxGuard(mix(through, mist, pow(uWx3.x, .8))), 1.);
        }` });
      yield* R.wait(P);
    },
    slots: {
      pane(R) {
        const blur = R.priv.blur ? R.priv.blur[2] : R.tex.SCENE;
        R.draw(P, "hdr", { uBlur: blur });
      },
    },
  };
})());
