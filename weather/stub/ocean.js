/* STUB ocean (ocean stream B replaces passes/ocean.js; this copy in stub/ stays frozen).
   Placeholder: a flat sea drawn full-screen below the horizon, normals from a few sine waves
   along the wind, the rendered sky (REFL) mirrored in it, a sun glint, a water body and the air
   in front. No FFT, no grid, no depth (the real ocean is geometry and writes depth).
   [v1.1] How the sea meets the cove, in the simplest form the real ocean must beat:
   - the cove is in front where wxSceneDist(uv) is nearer than the sea (discard), and behind
     shallow water elsewhere: the sea is blended (ONE, SRC_ALPHA) with alpha the water's
     transmittance down to the rock, so the seabed and the rocks' feet show through;
   - the swell lies down in the shallows (wxShore depth) and the lee (exposure), and foam rings
     the rocks (thin water to the cove, or the shore field's distance) with a run-up in a loop;
   - the cove's mirror image (wxCoastRefl) over the sky's (REFL), the cove's shadows on the sea
     (wxSunShadow), and no water inside the ship's hull (uShip, uShipB);
   - the "ocean" library's wxSeaProbe, and SEAPROBE written at the end of the slot from the same
     waves, for R.coast.probes (the ship and the buoy ride on it).                             */
WX.lib("ocean", `
/* the sea at probe i of R.coast.probes, as the ocean slot left it last frame:
   x height m, y dh/dx, z dh/dz (averaged over the probe's radius), w 0 */
vec4 wxSeaProbe(int i) { return texelFetch(sSeaProbe, ivec2(i, 0), 0); }
`);
WX.pass((function () {
  let P = null, Pp = null, probe = null, probeFb = null;
  /* the stub's waves, shared by the sea and its probes: a swell and four wind waves */
  const WAVES = `
    vec3 ocnWaves(vec2 xz, float t, float r) {     // height m, dh/dx, dh/dz; r: averaging radius m
      vec2 w = uWind.xy, q = vec2(-w.y, w.x);
      vec3 s = vec3(0.);
      {
        float lam = 9.81 * uSwell.z * uSwell.z / (2. * PI), kk = 2. * PI / lam, om = 2. * PI / uSwell.z;
        float A = .5 * uSwell.w * exp(-.5 * kk * kk * r * r), ph = dot(uSwell.xy, xz) * kk - om * t;
        s += vec3(A * sin(ph), A * kk * cos(ph) * uSwell.xy);
      }
      for (int k = 0; k < 4; k++) {
        float fk = float(k), lam = 40. / pow(1.9, fk);
        vec2 dir = normalize(w + q * (fk - 1.5) * .35);
        /* [critic] omega quantised to 2 pi / 1024 (DESIGN 0.1 #9), so the stub's waves, and the ship and buoy
           riding them through SEAPROBE, loop with uTime.x instead of jumping at its wrap */
        float kk = 2. * PI / lam, om = floor(sqrt(9.81 * kk) * 1024. / (2. * PI) + .5) * 2. * PI / 1024.;
        float A = (.02 + .012 * uWx2.x) * lam / (2. * PI) / (1. + fk) * exp(-.5 * kk * kk * r * r);
        float ph = dot(dir, xz) * kk - om * t + fk * 1.7;
        s += vec3(A * sin(ph), A * kk * cos(ph) * dir);
      }
      return s;
    }`;
  return {
    name: "ocean",
    *build(R) {
      probe = probeFb = null;
      P = R.program("ocean.stub", { libs: ["atmo", "clouds", "coast"], fs: WAVES + `
        in vec2 vUV; out vec4 o;
        void main() {
          vec3 d = wxRay(vUV);
          if (d.y > -2e-4) discard;
          float t = wxEye / -d.y;
          vec3 p = vec3(0., wxEye, 0.) + d * t;
          float zc = wxSceneDist(vUV);
          if (zc < t - .05) discard;                                   // the cove stands in front of the water here
          if (uShipB.w > .5) {                                         // no water inside the hull
            vec2 rel = p.xz - uShip.xz, f = vec2(sin(uShip.w), cos(uShip.w));
            vec2 lq = vec2(dot(rel, vec2(f.y, -f.x)) / uShipB.y, dot(rel, f) / uShipB.x);
            if (dot(lq, lq) < .92) discard;
          }
          vec4 sh = wxShore(p.xz);
          float depth = max(sh.y, 0.), calm = mix(.25, 1., sh.z) * smoothstep(0., 5., depth);
          vec3 g3 = ocnWaves(p.xz, uTime.x, 0.);
          vec2 g = g3.yz * mix(.35, 1., calm);
          float rough = .02 + .03 * uWx2.x / 26. + .06 * uWx1.y + min(t / 4000., 1.) * .05;
          vec3 n = normalize(vec3(-g.x, 1., -g.y));
          vec3 v = -d;
          float F = .02 + .98 * pow(1. - max(dot(n, v), 0.), 5.);
          vec3 r = reflect(d, n); r.y = abs(r.y);
          vec2 ruv = wxUV(r);
          float lod = clamp(log2(1. + rough * 400.), 0., 7.);
          vec3 refl = all(greaterThan(ruv, vec2(0.))) && all(lessThan(ruv, vec2(1.))) ? textureLod(sRefl, ruv, lod).rgb : wxSky(r);
          vec4 cr = wxCoastRefl(vUV + n.xz * vec2(.6, 1.2) * 12. / max(t, 30.), lod * .6);   // the cove in the mirror, wobbled by the waves
          refl = refl * (1. - cr.a) + cr.rgb;
          vec3 h = normalize(uSun.xyz + v);
          float m = 2. / (rough * rough) - 2.;
          vec3 sun = wxSunLight(wxPlanet(p)) * wxCloudShadow(p) * wxSunShadow(p);
          vec3 glint = sun * (m + 8.) / (8. * PI) * pow(max(dot(n, h), 0.), m) * F * max(dot(n, uSun.xyz), 0.);
          vec3 body = (1. - F) * vec3(.0025, .014, .022) * (sun * max(uSun.y, 0.) + wxAmbient(1.) * PI) / PI;
          /* foam: where the water thins out against the cove, and a run-up band at the waterline in a loop */
          float thick = zc - t, swell = sin(dot(uSwell.xy, p.xz) * 2. * PI / (9.81 * uSwell.z * uSwell.z / (2. * PI)) - 2. * PI * uTime.x / uSwell.z);
          float run = .6 + .5 * swell + .4 * uWx2.w;
          float foam = (1. - smoothstep(.0, 1.2 + 1.5 * uWx2.w, thick)) * .8;
          foam = max(foam, (1. - smoothstep(0., 2. + 6. * run * sh.z, sh.x)) * step(-.5, sh.x) * (.35 + .5 * sh.z) * sh.w);
          foam = max(foam, smoothstep(2.5, .6, depth) * smoothstep(.2, .9, sh.z) * (.5 + .5 * swell) * .6 * step(.5, sh.x));
          foam *= uCoast.x * (.75 + .25 * wxHash12(floor(p.xz * 1.5)));
          vec3 foamL = vec3(.75) * (sun * max(uSun.y, 0.) / PI + wxAmbient(1.));
          vec3 c = refl * F + min(glint, vec3(3000. * uExpo.x)) + body;
          c = mix(c, foamL, foam);
          float Tw = exp(-max(thick, 0.) * .35) * (1. - F) * (1. - foam);   // seeing the rock through the water
          vec4 ap = wxAerial(d, t * 1e-3);
          o = vec4(wxGuard((c * ap.a + ap.rgb) * (1. - Tw)), Tw);
        }` });
      Pp = R.program("ocean.probe", { libs: [], fs: WAVES + `
        uniform vec4 uProbe[16]; out vec4 o;
        void main() {
          int i = int(gl_FragCoord.x);
          vec4 q = uProbe[i];
          o = q.w > .5 ? vec4(ocnWaves(q.xy, uTime.x, q.z), 0.) : vec4(0.);
        }` });
      yield* R.wait(P, Pp);
      probe = R.gpu.tex2D(WX.SEAPROBES, 1, "rgba16f", { filter: "nearest" });
      probeFb = R.gpu.fbo([probe]);
      R.provide("SEAPROBE", probe);
    },
    slots: {
      ocean(R) {
        const gl = R.gl;
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.SRC_ALPHA);
        R.draw(P, "scene");
        gl.disable(gl.BLEND);
        R.draw(Pp, probeFb, { uProbe: R.coast.probes });
      },
    },
  };
})());
