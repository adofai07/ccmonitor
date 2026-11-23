/* ═══════════════════════ Weather: the atmosphere (stream A) ═══════════════════════
   Hillaire 2020 ("A Scalable and Production Ready Sky and Atmosphere Rendering Technique") with
   Bruneton's transmittance parameterisation, in planet-centred km, per unit illuminance.

   The medium: Rayleigh (H 8 km), background Mie (H 1.2 km), ozone (a tent at 25 km), a marine haze
   (H 0.6 km, albedo 0.9) and the weather's fog layer (H = W.fogH, albedo 0.99). Visibility V sets
   haze + fog by Koschmieder: sigma = 3.912 / V - 0.016 km^-1 (Rayleigh and background Mie at 550 nm
   are the 0.016). One phase for every particle (Cornette-Shanks, g 0.8).

   LUTs (private formats, contract units 0-5):
     TRANS    256 x 64 RGBA16F  transmittance to the top of the atmosphere (Bruneton's r, mu)
     MS       32 x 32  RGBA16F  Hillaire's multiple-scattering contribution psi_ms(r, mu_s)
     SKYVIEW  192 x 108 RGBA16F the sky around the eye, per unit sun illuminance (Hillaire's latitude
                                mapping, the horizon at v = 0.5, azimuth from the light 0..pi)
     SKYMOON  192 x 108 RGBA16F the same for the moon (made only while the moon can matter)
     AP       1024 x 32 RGBA16F aerial perspective: 32 slices of 32 x 32 over the camera frustum,
                                slice depth 64 km * w^2; rgb in-scatter (sun + moon, pre-exposed),
                                a mean transmittance. Below the sea's horizon the path is mirrored in
                                the sea plane (|h|), so the cove's mirror image gets the air it crosses.
     AMBIENT  5 x 1 RGBA16F     irradiance / pi, pre-exposed: 0 the sky above a surface (clouds in it),
                                1 the light from below (the sea), 2 the clear sky above the clouds,
                                3 [round 2] the clear sky's dipole toward the sun's azimuth (the twilight
                                arch's excess light, for the clouds), 4 [round 3] half the clear horizon's
                                radiance x .65 beyond a storm's edge (the light under a rain deck, atmUnder)
   TRANS and MS are made again only when the visibility moves by > 1 % or the fog height by > 5 m,
   at most once per 4 world frames (render.md 13.3). SKYVIEW, AP and AMBIENT run every world frame.

   The clouds' shadow: below the cloud base the single scattering of the key light is multiplied by
   the cloud shadow (per sample in the AP, its mean in the sky-view) and the multiple scattering by
   mix(1, mean, 0.7), so a storm does not glow like a sunny fog (render.md 5).

   uA0 (this stream's): x haze sigma km^-1, y fog sigma km^-1, z fog scale height km (as the LUTs were
   made), w the cloud cover the ambient sees (0..1). uA1: x the share of the clear sky's multiple
   scattering that reaches the air under the deck (diffuse transmission through the cover), y [round 3]
   the storm's edge, km from the eye, z the weight of the light under a rain deck (atmUnder), w the
   moon's sky-view is live; set by clouds.js from R.priv.            */
WX.lib("atmo", `
const vec3 ATM_RAY = vec3(5.802, 13.558, 33.1) * 1e-3;
const float ATM_MIE_S = 3.996e-3, ATM_MIE_A = .444e-3;
const vec3 ATM_OZONE = vec3(.650, 1.881, .085) * 1e-3;
const float ATM_G = .8;
/* scattering (rgb Rayleigh, a particles) and extinction at altitude h km; kF scales the weather's fog */
void atmMediumF(float h, float kF, out vec3 scR, out float scM, out vec3 ext) {
  h = max(h, 0.);
  float dR = exp(-h / 8.), dM = exp(-h / 1.2), dH = exp(-h / .6), dF = exp(-h / max(uA0.z, .05)) * kF;
  float dO = max(0., 1. - abs(h - 25.) / 15.);
  scR = ATM_RAY * dR;
  scM = ATM_MIE_S * dM + uA0.x * .9 * dH + uA0.y * .99 * dF;
  ext = scR + vec3((ATM_MIE_S + ATM_MIE_A) * dM + uA0.x * dH + uA0.y * dF) + ATM_OZONE * dO;
}
void atmMedium(float h, out vec3 scR, out float scM, out vec3 ext) { atmMediumF(h, 1., scR, scM, ext); }
/* [round 3] the rain's lost visibility moved out of the first ~0.5 km (REVIEW-2: the near storm was murk): the fog
   and the curtains thin toward the eye, by up to 60 % in a downpour; the far air keeps the table's visibility. The
   rain itself stays in view, on the glass and in the near streaks (C) */
float atmNear(float tKm) { return 1. - .75 * uWx1.y * (1. - smoothstep(.1, 1.2, tKm)); }
/* [round 3] the light under a rain deck: the open sky's light beyond the storm's edge (AMBIENT texel 4: the clear
   horizon, haze only) carried inward by the rain, fading over ~4 km (the rain scatters it forward with an albedo near
   1, but the dark sea under it drinks it), so the fog toward the horizon is lighter than the deck above it, as storm
   photographs show.
   uA1.y the edge's distance km, uA1.z its weight 0..1 (0: no rain deck); pre-exposed radiance */
vec3 atmUnder(float dKm) {
  if (uA1.z <= 0.) return vec3(0.);
  /* [round 4] fading over 3 km (was 4): the near air under the deck darker, the band under the edge as bright */
  return texelFetch(sAmbient, ivec2(4, 0), 0).rgb * uA1.z * exp(-max(uA1.y - dKm, 0.) / 3.);
}
float atmPhaseR(float c) { return 3. / (16. * PI) * (1. + c * c); }
float atmPhaseM(float c) { float g2 = ATM_G * ATM_G; return 3. / (8. * PI) * ((1. - g2) * (1. + c * c)) / ((2. + g2) * pow(max(1. + g2 - 2. * ATM_G * c, 1e-4), 1.5)); }
/* Bruneton's transmittance parameterisation */
vec2 atmTransUV(float r, float mu) {
  float H = sqrt(R_T * R_T - R_G * R_G), rho = sqrt(max(0., r * r - R_G * R_G));
  float disc = r * r * (mu * mu - 1.) + R_T * R_T, d = max(0., -r * mu + sqrt(max(disc, 0.)));
  float dmin = R_T - r, dmax = rho + H;
  vec2 uv = vec2((d - dmin) / max(dmax - dmin, 1e-6), rho / H);
  return uv * (vec2(256., 64.) - 1.) / vec2(256., 64.) + .5 / vec2(256., 64.);
}
/* transmittance to space from radius r along mu; 0 into the ground (the planet's limb is hard) */
vec3 wxTransmittance(float r, float mu) {
  r = clamp(r, R_G + 1e-4, R_T);
  float muH = -sqrt(max(0., 1. - R_G * R_G / (r * r)));
  if (mu < muH) return vec3(0.);
  return texture(sTrans, atmTransUV(r, mu)).rgb;
}
/* to a light of angular radius rad: the planet's shadow softened across the disc (twilight, the
   Earth's shadow on clouds and haze, render.md 5) */
vec3 atmLightT(float r, float mu, float rad) {
  r = clamp(r, R_G + 1e-4, R_T);
  float muH = -sqrt(max(0., 1. - R_G * R_G / (r * r)));
  rad = max(rad, 2e-4);
  float vis = smoothstep(muH - rad, muH + rad, mu);
  return texture(sTrans, atmTransUV(r, max(mu, muH))).rgb * vis;
}
vec3 wxSunLight(vec3 pKm) { float r = length(pKm); return atmLightT(r, dot(pKm / r, uSun.xyz), uSun.w) * uSunInfo.y * uExpo.x; }
vec3 wxMoonLight(vec3 pKm) { float r = length(pKm); return atmLightT(r, dot(pKm / r, uMoon.xyz), uMoon.w) * uMoonInfo.y * uExpo.x; }
/* the cosine of the eye's geometric horizon (14 m up: -0.12 deg) */
float atmHorizonMu() { float r = R_G + wxEye * 1e-3; return -sqrt(max(0., 1. - R_G * R_G / (r * r))); }
/* Hillaire's sky-view mapping: u the azimuth from the light 0..pi, v the zenith, the horizon at 0.5 */
vec2 atmSkyUV(vec3 d, vec3 l) {
  float r = R_G + wxEye * 1e-3;
  float vh = sqrt(max(r * r - R_G * R_G, 0.)), beta = acos(clamp(vh / r, -1., 1.)), zha = PI - beta;
  float vz = acos(clamp(d.y, -1., 1.)), v;
  if (vz < zha) { float c = vz / zha; c = 1. - sqrt(max(1. - c, 0.)); v = c * .5; }
  else { float c = (vz - zha) / beta; v = sqrt(max(c, 0.)) * .5 + .5; }
  vec2 dh = d.xz, lh = l.xz; float ld = length(dh), ll = length(lh);
  float cl = (ld > 1e-5 && ll > 1e-5) ? dot(dh / ld, lh / ll) : 1.;
  float u = acos(clamp(cl, -1., 1.)) / PI;
  return vec2(u, v) * (vec2(192., 108.) - 1.) / vec2(192., 108.) + .5 / vec2(192., 108.);
}
/* the clear sky along d (no sun disc, no clouds, nothing from space), pre-exposed. Below the horizon
   it gives the sky just above it, as the sea's mirror wants */
vec3 wxSky(vec3 d) {
  float hz = atmHorizonMu() + 2e-4;
  if (d.y < hz) { d.y = hz; d = normalize(d); }
  vec3 L = texture(sSkyView, atmSkyUV(d, uSun.xyz)).rgb * uSunInfo.y;
  if (uA1.w > .5) L += texture(sSkyMoon, atmSkyUV(d, uMoon.xyz)).rgb * uMoonInfo.y;
  return L * uExpo.x;
}
/* the sun's limb-darkened disc along d, extinguished by the air; pre-exposed, 0 off the disc (and its aureole).
   [round 4] THE LOW SUN (REVIEW-3: a clipped white dot at 0.25 deg). Within ~4 deg of the horizon:
   - refraction flattens it: the vertical radius .82 of the horizontal one at the horizon;
   - the turbulent, hazy air softens its limb, and the haze's forward scattering lays an aureole round it;
   - its colour is the path's transmittance (orange-red at 0-2 deg).
   [round 5] A VISIBLE SETTING SUN (REVIEW-4 #2: round 4 capped the disc at 1.6x the sky so that AgX kept its hue, and at
   0.25 deg it peaked 14 levels over a sky of 190: a glitter column ran up to no sun). The disc is again far brighter than
   the sky round it (at most ATM_SUN_CAP x the sky at the sun's own direction, still far under its physical radiance),
   and C's hue-preserving shoulder keeps its hue at the display's top (the joint acceptance with C and B: >= 40 levels
   over the sky, G/R <= .8, the glitter under it never brighter). Near the horizon:
   - it is drawn ATM_SUN_SIZE x its radius with a soft limb (the glare and the shimmer of a long, turbulent path), so it
     reads as a small ball rather than a 10 px dot at 50 deg of view; its radiance stays the physical disc's;
   - its core keeps more of the transmittance's yellow than T (linear G/R ATM_SUN_GR .4 wherever T's own is ~.1-.3, so it
     shows ~.79 through C's shoulder, an orange ball whose luma can stand over the sky; T itself, red-orange at the
     display's top, would sit at the sky's own luma), and its limb deepens by one more power of T with the limb darkening
     (a redder rim); the aureole is tight and faint (.06 of the centre at the limb: round 4's .5 lifted the sky round it).
     C's numbers (notes/sky.md, 10:05): a centre of 14-90 pre-exposed, ~5-10x the sky at the sun.
   The cap scales the whole disc by its centre's value, so the limb darkening still reddens and darkens the edge.
   Earlier the cap was per channel (6e4), which turned the reddened disc white */
const float ATM_SUN_GR = ${(function () { let v = .4; /*@lab*/ const q = new URLSearchParams(location.search).get("p.sky.sunGR"); if (q) v = +q; /*@end*/ return v.toFixed(3); })()};
const float ATM_SUN_CAP = ${(function () { let v = 12; /*@lab*/ const q = new URLSearchParams(location.search).get("p.sky.sunCap"); if (q) v = +q; /*@end*/ return v.toFixed(3); })()};
const float ATM_SUN_SIZE = ${(function () { let v = 1.7; /*@lab*/ const q = new URLSearchParams(location.search).get("p.sky.sunSize"); if (q) v = +q; /*@end*/ return v.toFixed(3); })()};
float atmSunLow() { return 1. - smoothstep(.02, .12, uSun.y); }
/* [round 5] A NIGHT STRIKE LIGHTS ITS CLOUD, NOT THE WHOLE SKY (REVIEW-4 #4: clip n, a CG at 5 km, lifted the frame mean
   25 -> 66 evenly, the deck pale grey from edge to edge). Two parts of the flash's light were spread over the whole view:
   - the deck's own glow round a strike (its diffuse share, and the sky light it throws down on the cove and the sea) took
     wxFlashE's falloff, the on-axis irradiance of a 1.5 km disc: 8 % of the exit's at 5 km, 2 % at 10 km. But light that
     enters a deck diffuses through it over about its own depth and leaves the base there: a lit patch a few km wide round
     the exit, dark beyond (NOAA's night photographs). atmFlashDeck: the irradiance at the base point pM (m) from both
     slots, e^(-rho / 1.3 km) of the exit's over the horizontal distance rho (5 km: 2 %, 10 km: .05 %);
   - the haze and the rain lit by the flash scattered it equally every way: the near air, 5 km from the strike, veiled the
     whole frame. Rain and haze scatter forward (atmFlashPh: HG .6 with a third isotropic), so the air glows toward the
     strike and stays dark away from it: a halo round the channel rather than a grey veil (1/2 of it at 90 deg from the
     strike's direction, 4.4x toward it) */
vec3 atmFlashDeck(vec3 pM) {
  float e = 0.;
  for (int k = 0; k < 2; k++) {
    vec4 f = k == 0 ? uFlash0 : uFlash1;
    if (f.w <= 0.) continue;
    float rho = length(pM.xz * 1e-3 - f.xz);
    e += f.w * uExpo.x * PI * exp(-rho / 1.3);
  }
  return e * WX_FLASH_RGB;
}
float atmFlashPh(float c) { return mix(wxHG(c, .6), 1. / (4. * PI), .35); }
/* (and in rain the flash's light reaches the air km away only by diffusing through the rain between, as through a deck:
   wxFlash's falloff has no extinction, so the veil takes e^(-(r - 1.5 km) / (.8 vis)): 13 % at 5 km in a 96 % storm,
   nothing in clear air) */
vec3 atmFlashScat(vec3 pM, vec3 rd) {
  vec3 e = vec3(0.);
  float Ld = clamp(.8 * uWx1.w, 1.5, 40.);
  for (int k = 0; k < 2; k++) {
    vec4 f = wxFlash(k, pM);
    if (f.w <= 0.) continue;
    float r = length((k == 0 ? uFlash0.xyz : uFlash1.xyz) - pM * 1e-3);
    e += f.w * atmFlashPh(dot(rd, f.xyz)) * exp(-max(r - 1.5, 0.) / Ld) * WX_FLASH_RGB;
  }
  return e;
}
/* the flash's share of AMBIENT texel 0 (the light from the sky above a surface): the deck's glow seen from the eye, a
   patch of area 2 pi (1.3 km)^2 on the base at height h, rho km away, through both cosines (the eye's up, the base's down):
   all of it straight under the strike, ~half at 1 km, a thousandth at 5 km */
vec3 atmFlashAmb() {
  float e = 0., h = max(uWx0.z, .1), h2 = h * h;
  for (int k = 0; k < 2; k++) {
    vec4 f = k == 0 ? uFlash0 : uFlash1;
    if (f.w <= 0.) continue;
    float r2 = dot(f.xz, f.xz) + h2;
    e += f.w * uExpo.x * min(1., 3.38 * h2 / (r2 * r2));
  }
  return e * .3 * WX_FLASH_RGB;
}
vec3 wxSunDisc(vec3 d) {
  float c = dot(d, uSun.xyz), low = atmSunLow(), r = uSun.w * mix(1., ATM_SUN_SIZE, low);
  if (c < cos(r * mix(1.6, 3.6, low))) return vec3(0.);
  vec3 off = d - uSun.xyz * c, up = vec3(0., 1., 0.) - uSun.xyz * uSun.y;
  float ul = length(up); up = ul > 1e-4 ? up / ul : vec3(0., 0., 1.);
  float sy = dot(off, up), sx2 = max(dot(off, off) - sy * sy, 0.);
  sy /= mix(1., .82, low * low);
  float s = sqrt(sx2 + sy * sy);
  float px = 2. * uCamY.w * uRes.w;
  float mu = sqrt(max(1. - (s * s) / (r * r), 0.));
  vec3 limb = pow(vec3(max(mu, 1e-3)), vec3(.48, .62, .78));
  float soft = px * .5 + r * .22 * low;
  float cover = smoothstep(r + soft, r - soft, s);
  float r0 = R_G + wxEye * 1e-3;
  vec3 T = wxTransmittance(r0, d.y);
  float Tm = max(max(T.r, T.g), max(T.b, 1e-12));
  vec3 Tn = max(T / Tm, vec3(1e-9));
  /* the hue: a fixed orange at the core (below), deepening by one power of T toward the limb; the aureole T^2.2 (as the
     brightest channel times the normalised hue to that power) */
  vec3 Ta = Tm * pow(Tn, vec3(mix(1., 2.2, low)));
  /* [round 5] the core's hue holds one orange from 0 to ~1 deg (linear G/R ATM_SUN_GR .4: .79-.80 on screen through C's
     shoulder, r5 w4; .5 read .84, a cream-yellow ball): T^.4 read yellow at 1 deg, where T itself is less red */
  float pc = clamp(log(ATM_SUN_GR) / log(clamp(Tn.g, 1e-4, .999)), .3, 1.2);
  T = Tm * pow(Tn, vec3(mix(1., pc + (1. - mu), low)));
  vec3 L = limb * cover * T;
  if (low > 0.) L += Ta * (1. - cover) * .06 * low * exp(-max(s - r, 0.) / (.6 * r));
  float k = uSunInfo.y / (PI * uSun.w * uSun.w) * uExpo.x;
  vec3 Tc = wxTransmittance(r0, max(uSun.y, atmHorizonMu() + 1e-4));
  float Tcm = max(max(Tc.r, Tc.g), max(Tc.b, 1e-12));
  Tc = Tcm * pow(max(Tc / Tcm, vec3(1e-9)), vec3(mix(1., .4, low)));
  vec3 sk = wxSky(uSun.xyz);
  float peak = max(max(Tc.r, Tc.g), Tc.b) * k, cap = exp2(mix(15.9, log2(max(ATM_SUN_CAP * max(max(sk.r, sk.g), sk.b), 1e-6)), low));
  return L * k * min(1., cap / max(peak, 1e-20));
}
/* [round 5] NO BANDS AT THE AP'S COLUMNS (REVIEW-4 #9: a faint vertical dark band through the golden cumulus at x~1360 in
   clip b, there since round 3; r5: a dark column in a lit lobe at 76 %). The aerial perspective has 32 columns across the
   view (62 px at 1080p); read linearly between them, the cloud shadows in the haze give a luminance with a kink at every
   column, and where the haze in front of a cloud is darker at one column than at both neighbours the eye sees a straight
   vertical band there (b40: the V's tip at x 1362 = column 22; v76: x 1115 = column 27 at 1280). Across the columns the
   atlas is read as a cubic B-spline (two linear taps, within the slice's tile): no kinks, the same low-frequency light */
vec4 atmAPx(float xs, float y, float z) {
  float x = xs - .5, i = floor(x), f = x - i, f2 = f * f, f3 = f2 * f;
  float w0 = (1. - 3. * f + 3. * f2 - f3) / 6., w1 = (4. - 6. * f2 + 3. * f3) / 6., w3 = f3 / 6., g0 = w0 + w1, g1 = 1. - g0;
  float p0 = clamp(i - .5 + w1 / g0, .5, 31.5), p1 = clamp(i + 1.5 + w3 / max(g1, 1e-6), .5, 31.5);
  return g0 * texture(sAP, vec2((p0 / 32. + z) / 32., y)) + g1 * texture(sAP, vec2((p1 / 32. + z) / 32., y));
}
/* the AP atlas at screen uv and slice coordinate w = sqrt(dKm / 64) */
vec4 atmAP(vec2 uv, float w) {
  float sz = clamp(w * 32. - .5, 0., 31.), z0 = floor(sz), z1 = min(z0 + 1., 31.), f = sz - z0;
  float xs = clamp(uv.x, 0., 1.) * 31. + .5, qy = (clamp(uv.y, 0., 1.) * 31. + .5) / 32.;
  vec4 a = atmAPx(xs, qy, z0), b = atmAPx(xs, qy, z1);
  vec4 r = mix(a, b, f);
  return w * 32. < .5 ? mix(vec4(0., 0., 0., 1.), r, w * 64.) : r;
}
/* the air between the eye and a point dKm along d: rgb in-scatter (pre-exposed, sun and moon, under
   the clouds' shadow, the fog layer and the rain's visibility included), a mean transmittance */
vec4 wxAerial(vec3 d, float dKm) {
  vec2 uv = wxUV0(d);                       // [1.2] the atlas is built with the camera's own rays (no TAA jitter)
  if (uv.x < -.5) uv = vec2(.5);
  vec4 ap = atmAP(uv, sqrt(clamp(dKm / 64., 0., 1.)));
  /* beyond the atlas, the transmittance keeps falling along the same air */
  if (dKm > 64.) ap.a *= exp(-(dKm - 64.) * (ATM_RAY.g + ATM_MIE_S + ATM_MIE_A) * .5);
  return ap;
}
/* [round 3] a small coastal town out of view lights the cloud bases at night (render.md 6.4): rel radiance.
   A full overcast throws its light back (2.5e-8, ~2.6 mcd/m2); scattered clouds under a starry sky get a
   twentieth of it, so they sit near the sky's own radiance (REVIEW-2: they were flat cut-outs, 14x the sky) */
vec3 atmTown() { return vec3(1., .8, .6) * 2.5e-8 * mix(.05, 1., smoothstep(.35, .95, uWx0.x)) * uWx3.w; }
/* irradiance / pi, pre-exposed: up = 1 the sky above (its clouds included), up = 0 the light from below */
vec3 wxAmbient(float up) {
  return mix(texelFetch(sAmbient, ivec2(1, 0), 0).rgb, texelFetch(sAmbient, ivec2(0, 0), 0).rgb, clamp(up, 0., 1.));
}
`);

WX.pass((function () {
  const P = {};
  let T = null;                       // { trans, ms, sky, moon, ap, amb } and their FBOs
  const lut = { vis: -1, fogH: -1, precip: -1, age: 99, haze: 0.03, fog: 0, H: 0.5, fresh: 0, moonWas: 0 };
  let moonOn = 0;
  /* [round 5] AMBIENT holds a frame made from a valid cloud buffer */
  let ambOK = false;
  /*@lab*/ WX.param("sky.flAP", 1, 0, 4, 0.05, "sky"); WX.param("sky.flAmb", 1, 0, 4, 0.05, "sky"); WX.param("sky.apShadow", 1, 0, 1, 0.05, "sky"); /*@end*/

  /* sigma split: the marine haze takes up to 0.03 km^-1 (render.md 13.2), the fog the rest */
  function medium(W) {
    const tot = Math.max(3.912 / Math.max(W.vis, 0.3) - 0.016, 0.004);
    const haze = Math.min(0.03, tot);
    /* [round 2] in rain the drops carry about half of the lost visibility themselves, in curtains (clouds.js
       cldRain): the uniform fog keeps the rest, so the cloud base shows between the shafts */
    /* [round 3] .75 (was .65): the curtains carry more of it, with clearer air between them (REVIEW-2) */
    return { haze, fog: Math.max(0, tot - haze) * (1 - 0.75 * W.precip), H: W.fogH };
  }

  /* [round 3] the night library's own light (contract 1.3, E): the clear night sky's mean radiance lights the haze and,
     through AMBIENT, the clouds and the cove when no moon or twilight does. Optional: a stub night has none */
  const nightLib = () => (WX.libs.night || "").indexOf("wxNightAmbient") >= 0;
  const NIGHT = () => nightLib() ? "#define WX_NIGHT_AMB 1\nvec3 atmNightAmb() { return wxNightAmbient(); }\n" : "vec3 atmNightAmb() { return vec3(0.); }\n";
  const LUTS = `
    float atmSph(vec3 ro, vec3 rd, float R) {      // far hit, or -1
      float b = dot(ro, rd), c = dot(ro, ro) - R * R, d = b * b - c;
      return d < 0. ? -1. : -b + sqrt(d);
    }
    float atmSphNear(vec3 ro, vec3 rd, float R) {  // near hit in front, or -1
      float b = dot(ro, rd), c = dot(ro, ro) - R * R, d = b * b - c;
      if (d < 0.) return -1.;
      float t = -b - sqrt(d);
      return t > 0. ? t : -1.;
    }
    vec3 atmMS(float r, float muS) {
      vec2 uv = vec2(muS * .5 + .5, (r - R_G - .01) / (R_T - R_G - .02));
      return texture(sMS, uv * 31. / 32. + .5 / 32.).rgb;
    }`;

  return {
    name: "atmo",
    *build(R) {
      T = null; lut.vis = -1; lut.age = 99; lut.fresh = 0; lut.moonWas = 0; ambOK = false;
      /* lab: when each of this stream's programs became ready, ms from the first build step: R.priv.skyBuild */
      /*@lab*/ R.priv.skyBuild = { t0: performance.now(), ready: {} };
      R.priv.skyWaitMark = function* (who, ps) {
        const rec = R.priv.skyBuild;
        for (;;) {
          let all = true;
          for (const k in ps) { if (ps[k].ready()) { if (rec.ready[who + "." + k] === undefined) rec.ready[who + "." + k] = Math.round(performance.now() - rec.t0); } else all = false; }
          if (all) return;
          yield;
        }
      }; /*@end*/
      P.trans = R.program("atmo.trans", { libs: ["atmo"], fs: LUTS + `
        uniform int uN; out vec4 o;
        void main() {
          vec2 uv = (gl_FragCoord.xy - .5) / vec2(255., 63.);
          float H = sqrt(R_T * R_T - R_G * R_G), rho = H * uv.y, r = sqrt(rho * rho + R_G * R_G);
          float dmin = R_T - r, dmax = rho + H, d = dmin + uv.x * (dmax - dmin);
          float mu = d == 0. ? 1. : (H * H - rho * rho - d * d) / (2. * r * d);
          mu = clamp(mu, -1., 1.);
          vec3 ro = vec3(0., r, 0.), rd = vec3(sqrt(1. - mu * mu), mu, 0.);
          float tMax = atmSph(ro, rd, R_T);
          vec3 od = vec3(0.); vec3 sR, e; float sM;
          tMax = max(tMax, 0.);
          for (int i = 0; i < uN; i++) {
            float f0 = float(i) / float(uN), f1 = float(i + 1) / float(uN);   // denser near the start, where the fog is
            float t = tMax * .5 * (f0 * f0 + f1 * f1), dt = tMax * (f1 * f1 - f0 * f0);
            atmMedium(length(ro + rd * t) - R_G, sR, sM, e);
            od += e * dt;
          }
          o = vec4(exp(-od), 1.);
        }` });
      P.ms = R.program("atmo.ms", { libs: ["atmo"], fs: LUTS + `
        uniform int uNd, uNs; out vec4 o;
        void main() {
          vec2 uv = (gl_FragCoord.xy - .5) / 31.;
          float muS = uv.x * 2. - 1., r = R_G + .01 + uv.y * (R_T - R_G - .02);
          vec3 sd = vec3(sqrt(max(0., 1. - muS * muS)), muS, 0.), ro = vec3(0., r, 0.);
          vec3 L2 = vec3(0.), fms = vec3(0.);
          for (int i = 0; i < uNd; i++) for (int j = 0; j < uNd; j++) {
            float th = 2. * PI * (float(i) + .5) / float(uNd), ct = 1. - 2. * (float(j) + .5) / float(uNd), st = sqrt(1. - ct * ct);
            vec3 rd = vec3(st * cos(th), ct, st * sin(th));
            float g = atmSphNear(ro, rd, R_G); bool hit = g > 0.;
            float tMax = hit ? g : atmSph(ro, rd, R_T);
            float dt = tMax / float(uNs); vec3 Tr = vec3(1.), Lp = vec3(0.), fp = vec3(0.);
            for (int s = 0; s < uNs; s++) {
              vec3 p = ro + rd * (float(s) + .3) * dt; float pr = length(p);
              vec3 sR, e; float sM; atmMedium(pr - R_G, sR, sM, e);
              vec3 sc = sR + vec3(sM), stT = exp(-e * dt), k = (1. - stT) / max(e, vec3(1e-7));
              vec3 Ts = atmLightT(pr, dot(p / pr, sd), 0.);
              Lp += Tr * sc * (1. / (4. * PI)) * Ts * k;
              fp += Tr * sc * k;
              Tr *= stT;
            }
            if (hit) { vec3 p = ro + rd * tMax; float mu = dot(normalize(p), sd); Lp += Tr * atmLightT(R_G, mu, 0.) * max(mu, 0.) * .1 / PI; }
            float nn = float(uNd * uNd);
            L2 += Lp / nn; fms += fp / nn;
          }
          o = vec4(L2 / (1. - min(fms, vec3(.999))), 1.);
        }` });
      /* the sky around the eye, per unit illuminance of the light at elevation uLightMu; below the
         cloud base the light is shadowed by the mean cloud shadow */
      P.sky = R.program("atmo.skyview", { libs: ["atmo", "clouds"], fs: LUTS + `
        uniform float uLightMu; uniform int uN; out vec4 o;
        void main() {
          vec2 uv = (gl_FragCoord.xy - .5) / vec2(191., 107.);
          float r = R_G + wxEye * 1e-3;
          float vh = sqrt(r * r - R_G * R_G), beta = acos(vh / r), zha = PI - beta, vz;
          if (uv.y < .5) { float c = 1. - 2. * uv.y; c = 1. - c * c; vz = zha * c; }
          else { float c = uv.y * 2. - 1.; vz = zha + beta * c * c; }
          float lon = uv.x * PI;
          vec3 sd = vec3(sqrt(max(0., 1. - uLightMu * uLightMu)), uLightMu, 0.);
          vec3 rd = vec3(sin(vz) * cos(lon), cos(vz), sin(vz) * sin(lon)), ro = vec3(0., r, 0.);
          float g = atmSphNear(ro, rd, R_G);
          float tMax = g > 0. ? g : atmSph(ro, rd, R_T);
          tMax = min(tMax, 400.);
          float c = dot(rd, sd), pR = atmPhaseR(c), pM = atmPhaseM(c);
          float smean = cldShadowRef(), baseKm = uWx0.z, topKm = uWx0.w;
          vec3 Tr = vec3(1.), L = vec3(0.);
          for (int i = 0; i < uN; i++) {
            float f0 = float(i) / float(uN), f1 = float(i + 1) / float(uN);
            float t0 = tMax * f0 * f0, t1 = tMax * f1 * f1, dt = t1 - t0, t = .5 * (t0 + t1);
            vec3 p = ro + rd * t; float pr = length(p), h = pr - R_G;
            vec3 sR, e; float sM; atmMedium(h, sR, sM, e);
            float mu = dot(p / pr, sd);
            float up = smoothstep(baseKm, topKm, h);
            float sv = mix(smean, 1., up), deck = mix(uA1.x, 1., up);
            vec3 S = (sR * pR + sM * pM) * atmLightT(pr, mu, .0047) * sv + (sR + sM) * atmMS(pr, mu) * deck;
            vec3 stT = exp(-e * dt);
            L += Tr * S * (1. - stT) / max(e, vec3(1e-7));
            Tr *= stT;
          }
          o = vec4(L, 1.);
        }` });
      /* aerial perspective: 32 slices of 32 x 32 over the frustum; per sample the cloud shadow at that
         point; below the sea's horizon the path beyond the water is the mirror's (|h|, y flipped) */
      P.ap = R.program("atmo.ap", { libs: ["atmo", "clouds"].concat(nightLib() ? ["night"] : []), fs: NIGHT() + LUTS + `
        uniform int uN; uniform vec4 uFlK; out vec4 o;
        void main() {
          float slice = floor(gl_FragCoord.x / 32.);
          vec2 uv = vec2(mod(gl_FragCoord.x, 32.), gl_FragCoord.y) / 32.;
          uv = (uv * 32. - .5) / 31.;
          vec3 rd = wxRay0(uv);
          float w = (slice + .5) / 32., dMax = 64. * w * w;
          vec3 eyeM = vec3(0., wxEye, 0.);
          float cS = dot(rd, uSun.xyz), cM = dot(rd, uMoon.xyz);
          float pRs = atmPhaseR(cS), pMs = atmPhaseM(cS), pRm = atmPhaseR(cM), pMm = atmPhaseM(cM);
          vec3 rdm = vec3(rd.x, -rd.y, rd.z);
          float cSm = dot(rdm, uSun.xyz), cMm = dot(rdm, uMoon.xyz);
          float pRsm = atmPhaseR(cSm), pMsm = atmPhaseM(cSm), pRmm = atmPhaseR(cMm), pMmm = atmPhaseM(cMm);
          float sE = uSunInfo.y * uExpo.x, mE = uMoonInfo.y * uExpo.x;
          bool moon = uA1.w > .5;
          vec3 Tr = vec3(1.), L = vec3(0.);
          for (int i = 0; i < uN; i++) {
            float f0 = float(i) / float(uN), f1 = float(i + 1) / float(uN);
            float t0 = dMax * f0 * f0, t1 = dMax * f1 * f1, dt = t1 - t0, t = .5 * (t0 + t1);
            vec3 pM = eyeM + rd * (t * 1e3);
            vec3 pk = wxPlanet(pM); float pr = length(pk), h = pr - R_G;
            bool mir = h < 0.;
            vec3 up = pk / pr;
            if (mir) { h = -h; pr = R_G + h; pM.y = -pM.y; }
            /* [round 3] the fog thins toward the eye (atmNear); under a rain deck the light of the open sky beyond
               the storm's edge lights the air (atmUnder), and past the edge the clear sky's own light returns */
            float dK = length(pM.xz) * 1e-3, below = 1. - smoothstep(uWx0.z, uWx0.w, h);
            vec3 sR, e; float sM; atmMediumF(h, atmNear(t), sR, sM, e);
            float muS = dot(up, uSun.xyz), muM = dot(up, uMoon.xyz);
            float sv = mix(1., wxCloudShadow(pM), uFlK.z), deck = mix(uA1.x, 1., 1. - below);
            deck = mix(deck, 1., smoothstep(.3, .6, uWx2.w) * smoothstep(uA1.y, uA1.y + 4., dK));
            vec3 Ss = (sR * (mir ? pRsm : pRs) + sM * (mir ? pMsm : pMs)) * atmLightT(pr, muS, .0047) * sv + (sR + sM) * atmMS(pr, muS) * deck;
            vec3 S = Ss * sE;
            if (moon) S += ((sR * (mir ? pRmm : pRm) + sM * (mir ? pMmm : pMm)) * atmLightT(pr, muM, .0045) * sv + (sR + sM) * atmMS(pr, muM) * deck) * mE;
            /* [1.2] a flash lights the haze and the rain's fog round it (wxFlashE: one falloff for every receiver,
               pre-exposed and bounded by WX.FLASH.cap): in rain the whole sky flickers, as it does, instead of a
               glow 5 km off that the fog erases */
            S += (sR + vec3(sM)) * atmFlashScat(pM, mir ? rdm : rd) * uFlK.x;
            S += (sR + vec3(sM)) * (atmUnder(dK) * below + atmNightAmb());
            vec3 stT = exp(-e * dt);
            L += Tr * S * (1. - stT) / max(e, vec3(1e-7));
            Tr *= stT;
          }
          o = vec4(wxGuard(L), dot(Tr, vec3(1. / 3.)));
        }` });
      /* ambient texels (irradiance / pi, pre-exposed): 0 the sky above a surface with its clouds,
         1 the light from below (the sea, albedo 0.08), 2 the clear sky (for the clouds' tops) */
      P.amb = R.program("atmo.amb", { libs: ["atmo", "clouds"].concat(nightLib() ? ["night"] : []), fs: NIGHT() + LUTS + `
        uniform sampler2D uCloudPrev; uniform float uCloudValid; uniform vec4 uFlK; out vec4 o;
        vec3 skyAt(vec3 d) {
          vec3 L = texture(sSkyView, atmSkyUV(d, uSun.xyz)).rgb * uSunInfo.y;
          if (uA1.w > .5) L += texture(sSkyMoon, atmSkyUV(d, uMoon.xyz)).rgb * uMoonInfo.y;
          return L;
        }
        void main() {
          int k = int(gl_FragCoord.x);
          if (k == 4) {
            /* [round 3] texel 4: the clear sky just above the horizon beyond a storm (haze only, no cloud shadow), the
               mean of four azimuths; .65 of it reaches in under the deck's edge (atmUnder).
               [round 4] .9: next to sc-milton the band under the edge read grey and thin; the base itself takes less of it
               now (clouds.js), so the band lightens without the deck */
            vec3 H = vec3(0.);
            for (int a = 0; a < 4; a++) {
              float ph = 1.5707963 * float(a) + .7854;
              vec3 rd = normalize(vec3(cos(ph), .035, sin(ph))), ro = vec3(0., R_G + .02, 0.);
              float cS = dot(rd, uSun.xyz), pR = atmPhaseR(cS), pMs = atmPhaseM(cS);
              vec3 Tr = vec3(1.), Ls = vec3(0.);
              for (int i = 0; i < 10; i++) {
                float f0 = float(i) / 10., f1 = float(i + 1) / 10.;
                float t0 = 60. * f0 * f0, t1 = 60. * f1 * f1, dt = t1 - t0, t = .5 * (t0 + t1);
                vec3 p = ro + rd * t; float pr = length(p), h = pr - R_G;
                vec3 sR, e; float sM; atmMediumF(h, 0., sR, sM, e);
                float mu = dot(p / pr, uSun.xyz);
                vec3 S = (sR * pR + sM * pMs) * atmLightT(pr, mu, .0047) + (sR + sM) * atmMS(pr, mu);
                vec3 stT = exp(-e * dt);
                Ls += Tr * S * (1. - stT) / max(e, vec3(1e-7)); Tr *= stT;
              }
              H += Ls * .25;
            }
            o = vec4(wxGuard(H * uSunInfo.y * uExpo.x * .9), 1.);
            return;
          }
          vec3 E = vec3(0.), Ed = vec3(0.);
          /* the sun's azimuth, horizontal: the twilight arch's side */
          vec2 az = length(uSun.xz) > 1e-4 ? normalize(uSun.xz) : vec2(0., 1.);
          for (int i = 0; i < 8; i++) for (int j = 0; j < 4; j++) {
            float ph = 2. * PI * (float(i) + .5) / 8., ct = sqrt((float(j) + .5) / 4.), st = sqrt(1. - ct * ct);
            vec3 w = vec3(st * cos(ph), ct, st * sin(ph));
            vec3 Ls = skyAt(w);
            E += Ls;
            Ed += Ls * dot(w.xz, az) / ct;
          }
          E /= 32.;                                          // the cosine-weighted mean radiance = E / pi
          E += atmNightAmb() / max(uExpo.x, 1e-30);          // [round 3] the night sky's own light (airglow, zodiacal, the band)
          /* the sky's dipole toward the sun's side (E_toward - E_away) / pi: after sunset the bright arch over
             the sun lights the clouds long after the sun itself has left them (texel 3) */
          Ed = max(Ed / 32., vec3(0.));
          /* [round 3] the arch is gone by the end of nautical twilight (sun -12 deg): nothing of it may light a
             moonless night's clouds */
          Ed *= smoothstep(-.2079, -.1045, uSun.y);
          float r0 = R_G + .02;
          vec3 keyDir = uKey.xyz; float keyE = uKey.w;
          float base = R_G + uWx0.z;
          vec3 Tkey = atmLightT(base, keyDir.y, .0047) * keyE;
          /* the clouds' own light seen from below: the mean of what the clouds trace drew last frame
             (radiance per unit cloud cover), else a diffuse-transmission estimate of the deck */
          float thick = max(uWx0.w - uWx0.z, .2);
          float tau = 40. * thick * mix(.25, .6, uWx0.x);
          float Td = 1. / (1. + .75 * (1. - .85) * tau);
          vec3 Lbase = (Tkey * max(keyDir.y, 0.) / PI + E * .5) * Td;
          if (uCloudValid > .5) {
            vec3 sL = vec3(0.); float sw = 0.;
            for (int y = 0; y < 6; y++) for (int x = 0; x < 8; x++) {
              vec2 uv = vec2((float(x) + .5) / 8., .5 + (float(y) + .5) / 12.);
              vec3 d = wxRay0(uv);
              if (d.y < .02) continue;
              vec4 c = texture(uCloudPrev, uv);
              float a = 1. - c.a;
              sL += c.rgb; sw += a;
            }
            if (sw > .3) Lbase = mix(Lbase, sL / sw / max(uExpo.x, 1e-30), .75);
          }
          float cov = uA0.w;
          float smean = cldShadowRef();
          vec3 Eclear = E * mix(1., smean, .5);
          vec3 above = mix(Eclear, Lbase, cov);
          /* a coastal town out of view lights the cloud bases at night (render.md 6.4) */
          vec3 town = atmTown() * cov;
          vec3 sunG = atmLightT(r0, uSun.y, .0047) * uSunInfo.y * max(uSun.y, 0.) / PI;
          vec3 moonG = atmLightT(r0, uMoon.y, .0045) * uMoonInfo.y * max(uMoon.y, 0.) / PI;
          vec3 below = ((sunG + moonG) * smean + above) * .08 + town * .3;
          vec3 v = k == 0 ? above + town * .2 : k == 1 ? below : k == 2 ? E : Ed;
          /* [1.2] a flash: its diffuse share, .3: the light the haze and rain scatter back from the sky. The patch's own
             direct light is the receivers' wxFlash (B's sea, F's cove), so it is not counted twice. [round 5] The deck's
             glow above the eye (atmFlashDeck), not wxFlashE's falloff: a strike 5 km out no longer lights the cove and
             the sea from a sky that stays dark */
          vec3 fl = atmFlashAmb() * uFlK.y;
          o = vec4(wxGuard(v * uExpo.x + (k == 0 ? fl : k == 1 ? fl * .08 : vec3(0.))), 1.);
        }` });
      /*@lab*/ yield* R.priv.skyWaitMark("atmo", { trans: P.trans, ms: P.ms, sky: P.sky, ap: P.ap, amb: P.amb }); /*@end*/
      yield* R.wait(P.trans, P.ms, P.sky, P.ap, P.amb);
      const G = R.gpu, mk = (w, h, o) => { const t = G.tex2D(w, h, "rgba16f", o || {}); t.fb = G.fbo([t]); return t; };
      T = {
        trans: mk(256, 64), ms: mk(32, 32), sky: mk(192, 108), moon: mk(192, 108), ap: mk(1024, 32),
        amb: mk(5, 1, { filter: "nearest" }),
      };
      /*@lab*/ R.priv.skyAtmo = T; /*@end*/
      R.provide("TRANS", T.trans); R.provide("MS", T.ms); R.provide("SKYVIEW", T.sky);
      R.provide("SKYMOON", T.moon); R.provide("AP", T.ap); R.provide("AMBIENT", T.amb);
      R.debugTex("TRANS", T.trans, "raw"); R.debugTex("MS", T.ms, "hdr");
      R.debugTex("SKYVIEW", T.sky, "hdr"); R.debugTex("SKYMOON", T.moon, "hdr");
      R.debugTex("AP", T.ap, "hdr"); R.debugTex("AP.T", T.ap, "a"); R.debugTex("AMBIENT", T.amb, "hdr");
    },
    ubo(F, R, set) {
      if (F.world) {
        const m = medium(F.W);
        lut.age++;
        const moved = lut.vis < 0 || Math.abs(F.W.vis / lut.vis - 1) > 0.01 || Math.abs(F.W.fogH - lut.fogH) > 0.005 ||
          Math.abs(F.W.precip - lut.precip) > 0.01;
        if (moved && lut.age >= 4) {
          lut.vis = F.W.vis; lut.fogH = F.W.fogH; lut.precip = F.W.precip; lut.haze = m.haze; lut.fog = m.fog; lut.H = m.H;
          lut.dirty = true; lut.age = 0;
        }
        const sunEl = Math.asin(Math.max(-1, Math.min(1, F.sun.dir[1]))) * 180 / Math.PI;
        const moonEl = Math.asin(Math.max(-1, Math.min(1, F.moon.dir[1]))) * 180 / Math.PI;
        moonOn = moonEl > -6 && sunEl < 10 ? 1 : 0;
      }
      set("uA0", lut.haze, lut.fog, lut.H, F.W.cov);
      R.priv.skyMoonOn = moonOn;
      /* the light under the deck: the clear sky's multiple scattering reaches the air below the clouds only
         through their gaps and by diffuse transmission, Td = 1 / (1 + .75 (1 - g) tau) (g .85); a storm
         must not glow like a sunny fog (render.md 5) */
      const W = F.W, thick = Math.max(W.top - W.base, 0.2), tau = 40 * thick * (0.25 + 0.35 * W.cov);
      const Td = 1 / (1 + 0.75 * 0.15 * tau), c = Math.pow(W.cov, 1.5);
      R.priv.skyDeck = 1 - c * (1 - Td);
    },
    slots: {
      atmo(R, F) {
        if (!T) return;
        const gl = R.gl, sunMu = F.sun.dir[1], moonMu = F.moon.dir[1];
        /* [round 3 close] below T3 the sky-view LUTs and the AP atlas take turns, one each world frame (the Intel budget):
           both change slowly (the sun, the drifting weather, an exposure that eases), so a 30 Hz refresh does not show.
           Every frame while a flash is live (the AP carries its light on the haze), after the base LUTs were rebuilt,
           and for the first two frames. Nothing accumulates: each draw replaces its texture */
        let both = R.tier >= 3 || lut.dirty || lut.fresh < 2 || (moonOn && !lut.moonWas) || F.flashes[0].I > 0 || F.flashes[1].I > 0;
        /*@lab*/ if (R.p("sky.cut") & 16) both = true; /*@end*/
        const odd = (R.worldIndex & 1) === 1;
        if (lut.dirty) {
          R.draw(P.trans, T.trans.fb, { uN: 48 });
          R.draw(P.ms, T.ms.fb, { uNd: 8, uNs: 20 });
          lut.dirty = false;
        }
        lut.fresh++; lut.moonWas = moonOn;
        if (both || !odd) {
          R.draw(P.sky, T.sky.fb, { uLightMu: sunMu, uN: 24 });      // [round 3] 24 steps (was 32): the Intel budget
          if (moonOn) R.draw(P.sky, T.moon.fb, { uLightMu: moonMu, uN: 24 });
        }
        let flk = [1, 1, 1, 1]; /*@lab*/ flk = [R.p("sky.flAP"), R.p("sky.flAmb"), R.p("sky.apShadow"), 1]; /*@end*/
        if (both || odd) R.draw(P.ap, T.ap.fb, { uN: 12, uFlK: flk });      // [round 3] 12 steps (was 16): the Intel budget; quadratic spacing keeps the near slices fine
        const prev = R.priv.skyCloudPrev, cv = !!(prev && R.priv.skyCloudValid);
        /* [round 5] NO WARM FRAME AT A TIER CHANGE (REVIEW-4 #7, B's diagnosis): a resize invalidates the cloud buffer for a frame,
           and AMBIENT then took the deck's light from the diffuse-transmission estimate (the sun's warm light through the deck)
           instead of the trace's grey mean, and the sea's foam, the bursts and the cove went tan for one frame. While the
           buffer is invalid AMBIENT keeps its last valid frame (it is not size-dependent); before any, it is made as before */
        if (cv || !ambOK) { R.draw(P.amb, T.amb.fb, { uCloudPrev: prev || T.ms, uCloudValid: cv ? 1 : 0, uFlK: flk }); if (cv) ambOK = true; }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      },
    },
  };
})());
