/* STUB atmo (sky stream A replaces passes/atmo.js; this copy in stub/ stays frozen).
   Placeholder: analytic sky and transmittance, no LUTs. It keeps every signature of the
   "atmo" GLSL library so the ocean, the clouds and the pane can be built against it. */
WX.lib("atmo", `
float atmHaze() { return max(3.912 / max(uWx1.w, 0.5) - 0.016, 0.); }   // km^-1 haze + fog at sea level
const vec3 ATM_BR = vec3(5.802, 13.558, 33.1) * 1e-3;
const float ATM_BM = 4.44e-3;
/* transmittance from radius r (km, planet-centred) along mu = cos(zenith) to space; 0 into the ground */
vec3 wxTransmittance(float r, float mu) {
  vec2 g = wxSphere(r, mu, R_G);
  if (g.y > 0.) return vec3(0.);
  float L = wxSphere(r, mu, R_T).x, haze = atmHaze();
  vec3 od = vec3(0.);
  for (int i = 0; i < 6; i++) {
    float t = (float(i) + .5) / 6. * L;
    float h = max(sqrt(r * r + t * t + 2. * r * mu * t) - R_G, 0.);
    od += ATM_BR * exp(-h / 8.) + vec3(ATM_BM * exp(-h / 1.2) + haze * exp(-h / .6));
  }
  return exp(-od * L / 6.);
}
/* sun and moon illuminance arriving at a planet-centred point (km), pre-exposed; no clouds */
vec3 wxSunLight(vec3 pKm) { float r = length(pKm); return wxTransmittance(r, dot(pKm / r, uSun.xyz)) * uSunInfo.y * uExpo.x; }
vec3 wxMoonLight(vec3 pKm) { float r = length(pKm); return wxTransmittance(r, dot(pKm / r, uMoon.xyz)) * uMoonInfo.y * uExpo.x; }
/* the clear sky's radiance along dir from the eye, pre-exposed: no sun disc, no clouds, no stars */
vec3 wxSky(vec3 d) {
  float mu = clamp(d.y, 0., 1.), sy = uSun.y;
  vec3 tint = wxTransmittance(R_G + 1., max(sy, .03)) / wxTransmittance(R_G + 1., 1.);
  float c = dot(d, uSun.xyz);
  vec3 col = mix(vec3(.075, .085, .095), vec3(.022, .042, .090), pow(mu, .5));
  col += vec3(.30, .26, .20) * pow(max(c, 0.), 10.) + vec3(.04) * pow(max(c, 0.), 2.);
  col *= tint * smoothstep(-.12, .08, sy) * (.25 + .75 * smoothstep(-.02, .25, sy));
  float haze = 1. - exp(-atmHaze() * 4.);
  col = mix(col, vec3(wxLuma(col)) * 1.1, haze * (1. - mu) * .7);
  col *= mix(1., .35, uWx0.x * uWx0.x);
  col += vec3(2.0e-8, 2.6e-8, 4.5e-8) + vec3(1.0e-7, 1.1e-7, 1.4e-7) * uMoonInfo.z * smoothstep(-.05, .3, uMoon.y);
  return col * uExpo.x;
}
/* the sun's disc along dir, pre-exposed, limb-darkened and extinguished; 0 off the disc */
vec3 wxSunDisc(vec3 d) {
  float c = dot(d, uSun.xyz), s = length(cross(d, uSun.xyz)), r = uSun.w;
  if (c <= 0. || s > r * 1.5) return vec3(0.);
  float px = 2. * uCamY.w * uRes.w;
  float mu = sqrt(max(1. - (s * s) / (r * r), 0.));
  vec3 limb = pow(vec3(max(mu, 1e-3)), vec3(.48, .62, .78));
  return 14700. * limb * smoothstep(r + px * .5, r - px * .5, s) * wxTransmittance(R_G + wxEye * 1e-3, d.y) * uSunInfo.y * uExpo.x;
}
/* the air between the eye and a point dKm along dir: rgb in-scatter (pre-exposed), a mean transmittance */
vec4 wxAerial(vec3 d, float dKm) {
  vec3 ext = ATM_BR + vec3(atmHaze() + ATM_BM);
  vec3 T = exp(-ext * dKm);
  vec3 ins = wxSky(normalize(vec3(d.x, max(d.y, .02), d.z))) * (1. - T);
  return vec4(ins, dot(T, vec3(1. / 3.)));
}
/* irradiance / pi, pre-exposed: up = 1 the sky above, up = 0 the light from below (the sea) */
vec3 wxAmbient(float up) {
  vec3 sky = .5 * (wxSky(vec3(0., 1., 0.)) + wxSky(normalize(vec3(.3, .25, .9))));
  vec3 below = sky * .08 + wxSunLight(vec3(0., R_G + .01, 0.)) * max(uSun.y, 0.) * .06 / PI;
  return mix(below, sky, up);
}
`);
WX.pass({ name: "atmo", slots: {} });
