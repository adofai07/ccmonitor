/* STUB night (director stream E replaces passes/night.js; this copy in stub/ stays frozen).
   The "night" GLSL library: what lies beyond the atmosphere, seen along a direction. The sky
   pass multiplies it by the transmittance and the clouds' T and adds it under the in-scatter.
   Placeholder: a flat-albedo moon sphere lit by the sun (so phase and tilt are already right)
   and hashed stars that turn with the star matrix. */
WX.lib("night", `
/* radiance from space along d (pre-exposed, before the atmosphere): moon, earthshine, stars.
   pxRad: the angle one scene pixel spans, for anti-aliasing and star PSFs. */
vec3 wxSpace(vec3 d, float pxRad) {
  vec3 L = vec3(0.);
  float c = dot(d, uMoon.xyz), s = length(cross(d, uMoon.xyz)), r = uMoon.w;
  if (c > 0. && s < r + 2. * pxRad) {
    float q = min(s / r, .999);
    vec3 t = s > 1e-7 ? (d - uMoon.xyz * c) / s : vec3(0.);
    vec3 n = normalize(-uMoon.xyz * sqrt(1. - q * q) + t * q);
    float mu0 = max(dot(n, uSun.xyz), 0.), mu = max(dot(n, -uMoon.xyz), 1e-3);
    float ls = 2. / PI * mu0 / (mu0 + mu);
    float cover = smoothstep(r + .5 * pxRad, r - .5 * pxRad, s);
    L += (vec3(.12) * ls * uSunInfo.y / PI * 3. + uMoonInfo.w) * cover;
  }
  if (uSun.y < -.07) {
    vec3 e = transpose(mat3(uStar0.xyz, uStar1.xyz, uStar2.xyz)) * d;   // world -> equatorial
    vec3 a = abs(e);
    float face = a.x > a.y && a.x > a.z ? (e.x > 0. ? 0. : 1.) : a.y > a.z ? (e.y > 0. ? 2. : 3.) : (e.z > 0. ? 4. : 5.);
    vec2 uv = a.x > a.y && a.x > a.z ? e.yz / a.x : a.y > a.z ? e.xz / a.y : e.xy / a.z;
    vec2 cell = floor((uv * .5 + .5) * 96.);
    vec3 h = wxHash33(vec3(cell, face));
    if (h.z < .35) {
      vec2 sp = (cell + .25 + .5 * h.xy) / 96. * 2. - 1.;
      vec3 sd = a.x > a.y && a.x > a.z ? vec3(sign(e.x), sp) : a.y > a.z ? vec3(sp.x, sign(e.y), sp.y) : vec3(sp, sign(e.z));
      sd = normalize(sd);
      float th = length(cross(normalize(e), sd));
      float mag = 6.5 - 7. * pow(wxHash13(vec3(cell, face + 11.)), 3.);
      float flux = pow(10., -.4 * (mag + 26.74));
      float sg = .75 * pxRad;
      L += flux / (2. * PI * sg * sg) * exp(-.5 * th * th / (sg * sg)) * mix(vec3(1., .78, .6), vec3(.75, .85, 1.), h.x);
    }
  }
  return L * uExpo.x;
}
`);
WX.pass({ name: "night", slots: {} });
