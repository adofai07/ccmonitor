/* STUB sky (sky stream A replaces passes/sky.js; this copy in stub/ stays frozen).
   The sky slot: clears SCENE's depth, draws sky + space + sun disc, puts the clouds over it,
   adds the in-cloud glow of a flash, then fills REFL (half size, full mips) from SCENE. */
WX.pass((function () {
  let P = {};
  return {
    name: "sky",
    *build(R) {
      P.sky = R.program("sky.composite", { libs: ["atmo", "clouds", "night"], fs: `
        in vec2 vUV; out vec4 o;
        vec3 flashGlow(vec4 f, vec4 fb, vec3 d, float cloudT) {
          if (f.w <= 0.) return vec3(0.);
          float km = length(f.xyz);
          float th = acos(clamp(dot(d, f.xyz / km), -1., 1.)), s = atan(1.5 / km);
          float g = .7 * exp(-.5 * th * th / (s * s)) + .3 * exp(-.5 * th * th / (9. * s * s));
          return f.w * vec3(.75, .82, 1.) * pow(1. - cloudT, .6) * g * uExpo.x;
        }
        void main() {
          vec3 d = wxRay(vUV);
          float px = 2. * uCamY.w * uRes.w;
          vec3 Tv = wxTransmittance(R_G + wxEye * 1e-3, max(d.y, 0.));
          vec3 L = wxSky(d) + wxSpace(d, px) * Tv * step(0., d.y) + wxSunDisc(d);
          vec4 c = wxCloudAt(vUV);
          L = L * c.a + c.rgb;
          L += flashGlow(uFlash0, uFlash0b, d, c.a) + flashGlow(uFlash1, uFlash1b, d, c.a);
          o = vec4(wxGuard(L), 1.);
        }` });
      P.down = R.program("sky.refl", { fs: `
        in vec2 vUV; out vec4 o;
        void main() {
          vec2 t = .5 * uRes.zw;
          vec3 c = texture(sScene, vUV + vec2(-t.x, -t.y)).rgb + texture(sScene, vUV + vec2(t.x, -t.y)).rgb
                 + texture(sScene, vUV + vec2(-t.x, t.y)).rgb + texture(sScene, vUV + vec2(t.x, t.y)).rgb;
          o = vec4(wxGuard(c * .25), 1.);
        }` });
      yield* R.wait(P.sky, P.down);
    },
    slots: {
      sky(R) {
        const gl = R.gl;
        R.bind("scene");
        gl.clear(gl.DEPTH_BUFFER_BIT);
        R.draw(P.sky, "scene");
        R.draw(P.down, "refl");
        gl.activeTexture(gl.TEXTURE31);
        gl.bindTexture(gl.TEXTURE_2D, R.tex.REFL.tex);
        gl.generateMipmap(gl.TEXTURE_2D);
      },
    },
  };
})());
