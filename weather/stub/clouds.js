/* STUB clouds (sky stream A replaces passes/clouds.js; this copy in stub/ stays frozen).
   Placeholder: one flat deck of 2D noise at the cloud base, a shadow map from the same noise,
   no volumes, no shafts. It keeps the "clouds" GLSL library and the CLOUD, CLOUDZ and CSHADOW
   outputs, so the sky and the sea can be built against it. */
WX.lib("clouds", `
/* the clouds seen through scene uv: rgb in-scatter (pre-exposed, air in front included), a transmittance.
   Sea pixels get the medium over the water (rain shafts), or (0, 1) */
vec4 wxCloudAt(vec2 uv) { return texture(sCloud, uv); }
/* transmittance-weighted distance of what wxCloudAt returns, km */
float wxCloudDepthAt(vec2 uv) { return texture(sCloudZ, uv).r; }
/* how much of the key light reaches a world point (m) through the clouds: 1 lit, 0 shadowed */
float wxCloudShadow(vec3 pM) {
  vec2 uv = (pM.xz * 1e-3 + 24.) / 48.;
  if (any(lessThan(uv, vec2(0.))) || any(greaterThan(uv, vec2(1.)))) return 1. - .8 * uWx0.x;
  return texture(sCShadow, uv).r;
}
float wxCloudShadowMean() { return 1. - .8 * uWx0.x; }
`);
WX.pass((function () {
  let P = {}, noise = null, nfb = null, cloud = null, cloudZ = null, cfb = null, shadow = null, sfb = null;
  /* a tiling fbm: value noise on lattices of 8..64 cells across the texture */
  const NOISE = `
    in vec2 vUV; out vec4 o;
    float vn(vec2 p, float per) {
      vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
      float a = wxHash12(mod(i, per)), b = wxHash12(mod(i + vec2(1, 0), per));
      float c = wxHash12(mod(i + vec2(0, 1), per)), d = wxHash12(mod(i + vec2(1, 1), per));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }
    void main() {
      float s = 0., w = .5;
      for (int k = 0; k < 4; k++) { float per = 8. * exp2(float(k)); s += w * vn(vUV * per, per); w *= .5; }
      o = vec4(s / .9375, 0., 0., 1.);
    }`;
  const FIELD = `
    uniform sampler2D uNoise;
    float field(vec2 km) {   // 0..1 cloud density at a point of the deck (km, world xz); the tile is 30 km
      float n = texture(uNoise, (km + uDrift0.zw) / 30.).r;
      float cov = uWx0.x;
      return smoothstep(1. - cov - .08, 1. - cov + .22, n) * mix(.55, 1., cov);
    }`;
  return {
    name: "clouds",
    *build(R) {
      cloud = cloudZ = cfb = null;   // a new context: forget the old one's objects
      P.noise = R.program("clouds.noise", { fs: NOISE });
      P.shadow = R.program("clouds.shadow", { libs: [], fs: FIELD + `
        in vec2 vUV; out vec4 o;
        void main() { vec2 km = vUV * 48. - 24.; o = vec4(1. - .85 * field(km), 0., 0., 1.); }` });
      P.trace = R.program("clouds.trace", { libs: ["atmo"], fs: FIELD + `
        in vec2 vUV; layout(location = 0) out vec4 oL; layout(location = 1) out vec4 oZ;
        void main() {
          vec3 d = wxRay(vUV);
          if (d.y < .004) { oL = vec4(0., 0., 0., 1.); oZ = vec4(1e4); return; }
          float t = (uWx0.z * 1000. - wxEye) / d.y;
          vec3 p = vec3(0., wxEye, 0.) + d * t;
          float dens = field(p.xz * 1e-3), km = t * 1e-3;
          dens *= 1. - smoothstep(40., 90., km);
          vec3 sun = wxSunLight(wxPlanet(p)) + wxMoonLight(wxPlanet(p));
          float c = dot(d, uKey.xyz);
          float ph = mix(wxHG(c, .6), wxHG(c, -.2), .3);
          vec3 Lc = sun * (.18 + 1.2 * ph) * (1. - .55 * dens) + wxAmbient(.6) * (.9 - .4 * dens);
          float T = 1. - dens;
          vec4 ap = wxAerial(d, km);
          vec3 L = (1. - T) * (Lc * ap.a + ap.rgb);
          oL = vec4(wxGuard(L), T); oZ = vec4(km);
        }` });
      yield* R.wait(P.noise, P.shadow, P.trace);
      const G = R.gpu;
      noise = G.tex2D(256, 256, "rgba8", { wrap: "repeat", mips: true });
      nfb = G.fbo([noise]);
      R.draw(P.noise, nfb);
      R.gl.activeTexture(R.gl.TEXTURE31);
      R.gl.bindTexture(R.gl.TEXTURE_2D, noise.tex);
      R.gl.generateMipmap(R.gl.TEXTURE_2D);
      shadow = G.tex2D(128, 128, "r16f");
      sfb = G.fbo([shadow]);
      R.provide("CSHADOW", shadow);
      R.debugTex("clouds.noise", noise, "r");
      R.debugTex("CSHADOW", shadow, "r");
    },
    resize(R) {
      const gl = R.gl, [w, h] = R.size.cloud;
      if (cloud) { gl.deleteTexture(cloud.tex); gl.deleteTexture(cloudZ.tex); gl.deleteFramebuffer(cfb.fb); }
      cloud = R.gpu.tex2D(w, h, "rgba16f");
      cloudZ = R.gpu.tex2D(w, h, "r16f");
      cfb = R.gpu.fbo([cloud, cloudZ]);
      R.provide("CLOUD", cloud);
      R.provide("CLOUDZ", cloudZ);
      R.debugTex("CLOUD", cloud, "hdr");
      R.debugTex("CLOUD.T", cloud, "a");
      R.debugTex("CLOUDZ", cloudZ, "depth");
    },
    slots: {
      shadow(R) { R.draw(P.shadow, sfb, { uNoise: noise }); },
      clouds(R) { R.draw(P.trace, cfb, { uNoise: noise }); },
    },
  };
})());
