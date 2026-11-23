/* ═══════════════════════ Weather: the night library (stream E) ═══════════════════════
   "night": vec3 wxSpace(vec3 dir, float pxRad) — the radiance from beyond the atmosphere along a
   world direction, pre-exposed and before extinction (the sky pass multiplies it by the
   transmittance and the clouds' T). render.md 8, DESIGN 3.
     the moon     a Lommel-Seeliger sphere lit from uSun (phase, terminator and tilt come free), albedo
                  0.12 with 12 maria at their selenographic places, edges broken by fBm on the moon's
                  own surface (so nothing crawls as it moves), a few bright and dark craters, Tycho's
                  rays; its face turned by the celestial pole's position angle (uStar2); earthshine on
                  the dark limb (uMoonInfo.w); 4 taps a pixel near it for its edge and its maria. Its
                  radiance is normalised so the disc carries Krisciunas-Schaefer's illuminance
                  (uMoonInfo.y) at every phase, the same light the clouds and the sea are lit with; on
                  screen the sunlit face is capped at 1.8 (pre-exposed) the way the eye adapts to it, so
                  a night view shows its face rather than a blown disc.
     the stars    one candidate a cell of a 6 x 256^2 cube map in equatorial coordinates, so they turn
                  with the real sidereal time and latitude. Magnitudes from log10 N(<m) = 0.5 m + 0.6
                  (Poisson per cell by its solid angle, so the cube's corners are not crowded), to 6.5;
                  denser toward the galactic plane; B-V-like tints; a constant-flux Gaussian PSF of
                  sigma 0.75 px (anti-aliased, the same at any resolution); scintillation by airmass on
                  the twinkle clock (periods that divide 600 s), chromatic near the horizon; skipped
                  while the sun is above -4 deg.
     the Milky Way baked once at build (GPU) into a galactic-coordinate map, 2048 x 512 over b +-48 deg:
                  the disk with its star clouds, the Sagittarius bulge, the Great Rift and the plane's
                  dust lanes, the Coalsack, the Magellanic Clouds; 1.5e-9 rel at the core. Sampled with
                  an explicit LOD (no derivatives across the l = 0 wrap).
     airglow      8e-10 rel at the zenith with van Rhijn brightening toward the horizon, and 4e-10 of zodiacal
                  light and unresolved stars: 1.4e-9 at the zenith with the Milky Way's diffuse light, a dark
                  site's 21.8 mag/arcsec2 (2e-4 cd/m2). The band itself 1.5e-9 above it, the Sagittarius star
                  cloud ~4e-9 (20.5 mag/arcsec2).
   [1.3] vec3 wxNightAmbient(): the clear night sky's mean radiance (pre-exposed), what it lights clouds and haze
         with; vec3 wxNightIn(vec3 dir, vec3 T): its light scattered into a ray of transmittance T (add it beside
         wxSpace(d, px) * T, so the horizon tends to the sky's mean instead of to black).
   uE0: x the moon's radiance per unit (albedo x Lommel-Seeliger), y the stars' visibility 0..1 ([r5] times the
        weather's gate: 0 under a closed storm deck, and the band's visibility follows it), z the Milky Way's and
        airglow's visibility 0..1 (and the night ambient's), w the band's faint stars on 1 / off 0
   uE1: x star brightness scale (1), y the Milky Way band's radiance rel, z airglow at the zenith, w the even
        zodiacal light and unresolved stars, rel */
WX.pass((function () {
  WX.LIBTEX.sNightMW = { unit: 30 };         // 31 is the passes' scratch unit (generateMipmap, level clamps)
  WX.param("night.stars", 1, 0, 4, 0.05, "night");       // lab knobs: 1 is the design
  WX.param("night.mw", 1, 0, 4, 0.05, "night");
  WX.param("night.airglow", 1, 0, 4, 0.05, "night");
  WX.param("night.faint", 1, 0, 1, 1, "night");          // the band's faint stars (0 skips them: their cost)
  /*@lab*/ WX.param("night.gate", 1, 0, 1, 1, "night"); /*@end*/   // [r5] lab timing: 0 skips the stars' and the band's branches (and the ambient: cost only)
  const MW_W = 2048, MW_H = 512, MW_B = 48;
  WX.lib("night", `
uniform sampler2D sNightMW;
const float NGT_DEG = 0.0174532925;
float ngtAirmass(float alt) {   // Kasten & Young 1989; alt in radians
  float a = max(alt, 0.) / NGT_DEG;
  return 1. / (sin(max(alt, 0.)) + .50572 * pow(a + 6.07995, -1.6364));
}
/* the moon's sprite: drawn each world frame by the night pass into rows ${MW_H}.. of the map (64 x 64,
   N x N used, N ~ 2.5 x the disc's radius in pixels, so it is sampled ~1:1), in disc units along a
   tangent basis at the moon; rgb = (albedo x Lommel-Seeliger, albedo, coverage), 4 taps a texel */
vec3 ngtT1() { vec3 t = cross(vec3(0., 1., 0.), uMoon.xyz); return dot(t, t) > 1e-8 ? normalize(t) : vec3(1., 0., 0.); }
float ngtSpriteN() { return clamp(ceil(2.5 * uMoon.w / (2. * uCamY.w * uRes.w)), 8., 64.); }
vec3 ngtMoon(vec3 d, float pxRad, out float cover) {
  cover = 0.;
  float c = dot(d, uMoon.xyz), r = uMoon.w;
  vec3 off = d - uMoon.xyz * c;
  if (c <= 0. || dot(off, off) > 1.5 * r * r) return vec3(0.);
  vec3 T1 = ngtT1(), T2 = cross(uMoon.xyz, T1);
  vec2 q = vec2(dot(off, T1), dot(off, T2)) / r;
  float n = ngtSpriteN();
  vec2 uv = vec2((q.x + 1.25) / 2.5 * n, ${MW_H}. + (q.y + 1.25) / 2.5 * n) / vec2(${MW_W}., ${MW_H + 64}.);
  vec3 sp = textureLod(sNightMW, uv, 0.).rgb;
  cover = sp.b;
  /* the eye's local adaptation: the sunlit face is shown at most 1.8 (pre-exposed; middle grey is ~0.18),
     so a night exposure keeps its maria instead of a blown disc; by day, when the moon is dimmer than
     that, it is physical. Earthshine adapts with it but less (the factor to the power .7): ~0.6 % of the
     face at night, which AgX shows as a faint grey disc, the old moon in the new one's arms, and near
     physical in the twilight that shows it best. The moonlight the scene receives (uMoonInfo.y) stays physical. */
  float cap = min(1., 1.8 / max(uE0.x * uSunInfo.y * .5 * uExpo.x, 1e-30));
  return (sp.r * uE0.x * uSunInfo.y * cap + sp.g * uMoonInfo.w * pow(cap, .7)) * vec3(1., .955, .9);
}
/* the cube-map cell of an equatorial direction: face 0..5, uv -1..1 on it */
struct NgtCell { int ax; float face; vec2 uv; };
NgtCell ngtCube(vec3 e) {
  vec3 a = abs(e);
  NgtCell c;
  c.ax = a.x >= a.y && a.x >= a.z ? 0 : a.y >= a.z ? 1 : 2;
  c.face = c.ax == 0 ? (e.x > 0. ? 0. : 1.) : c.ax == 1 ? (e.y > 0. ? 2. : 3.) : (e.z > 0. ? 4. : 5.);
  c.uv = c.ax == 0 ? e.yz / a.x : c.ax == 1 ? e.xz / a.y : e.xy / a.z;
  return c;
}
vec3 ngtOnFace(NgtCell c, vec3 e, vec2 sp) {
  return normalize(c.ax == 0 ? vec3(sign(e.x), sp) : c.ax == 1 ? vec3(sp.x, sign(e.y), sp.y) : vec3(sp, sign(e.z)));
}
/* [r3] the magnitude a star is shown at: a photograph's (or a game's) night sky, not the naked eye's: the scale
   is compressed around mag 6 (gamma .72), so the faint ones a long exposure gathers show as a fine field and
   the bright ones keep their colour instead of all clipping to the same white dot. Bright stars still rank
   above faint ones; the light the sky casts (wxNightAmbient) is not changed by it. */
float ngtShown(float m) { return 6. + .72 * (m - 6.); }
/* one candidate star a cell, kept in the cell's middle 40 % so its PSF (sigma 0.75 px) stays inside it:
   a pixel reads its own cell only. Whatever little is clipped is clipped in the sky's frame, so it
   never pops as the sky turns. */
vec3 ngtStars(vec3 e, NgtCell c, float pxRad, float X) {
  const float NC = 256.;
  vec2 cell = floor((c.uv * .5 + .5) * NC);
  vec3 h = wxHash33(vec3(cell, c.face * 300. + 7.));
  if (h.z < .93) return vec3(0.);                          // no star brighter than 6.5 here (93 % of cells)
  vec2 sp = (cell + .3 + .4 * h.xy) / NC * 2. - 1.;
  vec3 sd = ngtOnFace(c, e, sp);
  /* the cell's solid angle, and the plane's crowding (counts at mag 6: ~3x at b = 0 than at the poles) */
  float om = (4. / (NC * NC)) / pow(1. + dot(sp, sp), 1.5);
  float sinb = dot(sd, vec3(-.8676661490, -.1980763734, .4559837762));
  float crowd = (1. + 2. * exp(-abs(sinb) / .21)) / 1.42;
  /* the brightest star in the cell, Poisson: P(none brighter than m) = exp(-n(m)) */
  float n = -log(h.z) * 4. * PI / (om * crowd);
  float mag = (log(n) * .4342945 - .6) * 2.;
  if (mag > 6.5) return vec3(0.);
  float sg = .75 * pxRad, inv = 1. / (2. * sg * sg);
  float th2 = dot(e - sd, e - sd);
  float flux = exp2(-1.3287712 * (ngtShown(mag) + 26.74)); // 10^(-0.4 (m + 26.74)), rel
  vec3 h2 = wxHash33(vec3(cell, c.face * 300. + 91.));
  /* B-V-like tints, luminance 1 */
  vec3 tint = h2.x < .22 ? vec3(.80, .89, 1.12) : h2.x < .62 ? vec3(1.02, 1., .95) : h2.x < .93 ? vec3(1.12, .97, .78) : vec3(1.25, .9, .62);
  tint /= wxLuma(tint);
  /* scintillation by airmass: three tones whose periods divide the 600 s twinkle clock, 1.2-4.8 Hz;
     1 % at the zenith, 7 % at 30 deg, 29 % at 10 deg, and low down the colours part */
  float amp = min(.06 * (X - 1.) + .01, .6);
  float t = uTime.z * 2. * PI / 600.;
  vec3 k = floor(720. + h2.yzx * 2160.);
  vec3 ph = h2.zxy * 6.2831853;
  float sc = .5 * sin(k.x * t + ph.x) + .3 * sin(k.y * t + ph.y) + .2 * sin(k.z * t + ph.z);
  vec3 tw = vec3(1. + amp * sc);
  if (X > 3.) {
    float sc2 = .5 * sin(k.y * t + ph.z) + .5 * sin(k.z * t + ph.x);
    tw = mix(tw, vec3(1. + amp * sc2, 1. + amp * sc, 1. + amp * (sc - sc2)), smoothstep(3., 8., X));
  }
  /* [r3] the eye resolves a star to ~1 arcmin, a screen pixel here spans 2-4: spread over the pixel's PSF a
     star loses that much contrast against a bright sky, so under the moon or in twilight the stars the eye
     would see vanished (~3 in a moonlit 1280 px frame). Where the sky is brighter than a dark one (the
     exposure below a dark sky's 1.4e7) the bright layer gets the contrast back, up to (pixel / 1')^2; a dark
     sky is left as it is. */
  float acu = clamp(pxRad * pxRad / 8.46e-8, 1., 12.);
  flux *= clamp(1.4e7 / max(uExpo.x, 1.), 1., acu);
  return flux * inv / PI * exp(-th2 * inv) * tint * max(tw, vec3(0.));
}
/* the faint stars that make the sky grainy and the band granular (mag 6.5-9.5, ~250 000 over the sky,
   below the naked eye's limit one by one, as a photograph or a game's night sky shows them): a finer grid
   whose density follows the band's brightness mw (0..~3) over an even floor (r3: the floor, and the stars
   outside the band's map; round 2 had them only in the band, so the sky away from it looked sparse); the
   same constant-flux PSF, one cell a pixel, no scintillation (too faint to see it) */
vec3 ngtFaint(vec3 e, NgtCell c, float pxRad, float mw) {
  const float NC = 1024.;
  vec2 cell = floor((c.uv * .5 + .5) * NC);
  vec3 h = wxHash33(vec3(cell, c.face * 300. + 53.));
  float pStar = .02 * clamp(1.5 + mw * 2.4, 1.5, 8.);      // 3 % of cells away from the band, ~15 % in its clouds
  if (h.z > pStar) return vec3(0.);
  vec2 sp = (cell + .3 + .4 * h.xy) / NC * 2. - 1.;
  vec3 sd = ngtOnFace(c, e, sp);
  float mag = 6.5 + 3.5 * sqrt(h.z / pStar);             // more faint ones than bright ones, to 10
  float sg = .75 * pxRad, inv = 1. / (2. * sg * sg);
  float th2 = dot(e - sd, e - sd);
  return exp2(-1.3287712 * (ngtShown(mag) + 26.74)) * inv / PI * exp(-th2 * inv) * mix(vec3(1.05, .98, .9), vec3(.9, .96, 1.08), h.x);
}
vec3 ngtGalaxy(vec3 d, vec3 e, NgtCell c, float pxRad) {
  /* equatorial (J2000) -> galactic: rows are the galactic x (centre), y (l = 90), z (north pole) */
  vec3 g = vec3(dot(e, vec3(-.0548755604, -.8734370902, -.4838350155)),
                dot(e, vec3(.4941094279, -.4448296300, .7469822445)),
                dot(e, vec3(-.8676661490, -.1980763734, .4559837762)));
  float b = asin(clamp(g.z, -1., 1.)) / NGT_DEG;
  vec3 L = vec3(0.);
  float mwY = 0.;
  if (abs(b) < ${MW_B}.) {
    float l = atan(g.y, g.x) / (2. * PI);
    vec2 uv = vec2(fract(l), (b + ${MW_B}.) / ${2 * MW_B}. * ${MW_H}. / ${MW_H + 64}.);
    float lod = max(0., log2(pxRad / (2. * PI / ${MW_W}.)));
    vec3 mw = textureLod(sNightMW, uv, lod).rgb * smoothstep(${MW_B}., ${MW_B - 6}., abs(b));
    L = mw * uE1.y;
    mwY = wxLuma(mw);
  }
  if (uE0.y * uE0.w > 0.) L += ngtFaint(e, c, pxRad, mwY) * uE1.x * uE0.y * uE0.w;
  /* airglow: a layer at 90 km, van Rhijn's brightening toward the horizon; and the zodiacal light and the
     unresolved stars, taken as even (uE1.w). Together 1.4e-9 rel at the zenith: a dark coast's 21.8 mag/arcsec2 */
  float sz2 = 1. - d.y * d.y, k = 6371. / 6461.;
  L += vec3(.86, 1., .82) * uE1.z / sqrt(max(1. - k * k * sz2, .02)) + vec3(.97, .98, 1.) * uE1.w;
  return L;
}
/* [1.3] the night sky's own light, for what it lights: the mean radiance of the clear night sky over the
   upper hemisphere (airglow with van Rhijn's brightening averaged, ~1.6 x the zenith's, the zodiacal light
   and unresolved stars, and the band's share), pre-exposed, 0 by day and under the moon's or twilight's
   light, which the atmosphere's LUTs carry. A surface or a cloud lit by the night sky alone reflects about
   this times its albedo (a cloud's top ~0.8 x, its base, lit from above through the cloud, ~0.3-0.5 x), so
   a moonless cloud sits at or under the sky beside it. */
vec3 wxNightAmbient() {
  return (vec3(.86, 1., .82) * 1.6 * uE1.z + vec3(.97, .98, 1.) * uE1.w + vec3(.95, .96, 1.) * .06 * uE1.y) * uE0.z * uExpo.x;
}
/* [1.3] what the air between the eye and space adds along d at night: the night sky's light scattered into the
   ray by the air and the haze, where T (the ray's transmittance to space) has taken the same share out of
   wxSpace. Low down, where T falls, the sky tends to its mean radiance instead of to black: the horizon of a
   dark coast is a little brighter than the zenith, as measured, and the sea's mirror has a horizon to show. */
vec3 wxNightIn(vec3 d, vec3 T) {
  return wxNightAmbient() * (1. - T) * .92;
}
/* radiance from space along d (pre-exposed, before the atmosphere) */
vec3 wxSpace(vec3 d, float pxRad) {
  float cover;
  vec3 L = ngtMoon(d, pxRad, cover);
  /* [r5] uE0.y is 0 by day and under a closed storm deck (it carries the weather's gate; the band follows it) */
  if (d.y < -.03 || uE0.y <= 0.) return L * uExpo.x;   // below the horizon, by day, or under a closed deck
  vec3 e = transpose(mat3(uStar0.xyz, uStar1.xyz, uStar2.xyz)) * d;   // world -> equatorial
  NgtCell c = ngtCube(e);
  L += ngtStars(e, c, pxRad, ngtAirmass(asin(clamp(d.y, -1., 1.)))) * uE1.x * uE0.y * (1. - cover);
  if (uE0.z > 0.) L += ngtGalaxy(d, e, c, pxRad) * uE0.z * uE0.y * (1. - cover);
  return L * uExpo.x;
}
`);

  /* the Milky Way's map, made on the GPU in strips at build: normalised (core ~1); uE1.y scales it */
  const BAKE = `
  uniform vec2 uSize; out vec4 o;
  float n3(vec3 p) {
    vec3 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
    float a = wxHash13(i), b = wxHash13(i + vec3(1, 0, 0)), c = wxHash13(i + vec3(0, 1, 0)), d = wxHash13(i + vec3(1, 1, 0));
    float e = wxHash13(i + vec3(0, 0, 1)), g = wxHash13(i + vec3(1, 0, 1)), h = wxHash13(i + vec3(0, 1, 1)), k = wxHash13(i + vec3(1, 1, 1));
    return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
  }
  float fbm(vec3 p, int oct) { float s = 0., a = .5, w = 0.; for (int i = 0; i < 8; i++) { if (i >= oct) break; s += a * n3(p); w += a; p = p * 2.02 + 17.3; a *= .5; } return s / w; }
  /* ridged: thin filaments, for the dust */
  float ridge(vec3 p, int oct) { float s = 0., a = .5, w = 0.; for (int i = 0; i < 8; i++) { if (i >= oct) break; s += a * (1. - abs(2. * n3(p) - 1.)); w += a; p = p * 2.07 + 5.1; a *= .55; } return s / w; }
  float bump(float l, float c, float w) { float x = mod(l - c + 180., 360.) - 180.; return exp(-.5 * x * x / (w * w)); }
  float blob(float l, float b, float lc, float bc, float wl, float wb) { float x = mod(l - lc + 180., 360.) - 180.; float y = b - bc; return exp(-.5 * (x * x / (wl * wl) + y * y / (wb * wb))); }
  void main() {
    const float DEG = 0.0174532925;
    float l = gl_FragCoord.x / uSize.x * 360.;            // galactic longitude, 0 at the centre
    float b = (gl_FragCoord.y / uSize.y * 2. - 1.) * ${MW_B}.;
    float lw = mod(l + 180., 360.) - 180.;
    vec3 g = vec3(cos(b * DEG) * cos(l * DEG), cos(b * DEG) * sin(l * DEG), sin(b * DEG));   // seamless at l = 0
    /* the disk: bright toward the centre, with its star clouds (Cygnus, Scutum, Carina, Norma, Centaurus) */
    float fl = .16 + .84 * pow(.5 + .5 * cos(lw * DEG), 2.2);
    fl += .34 * bump(l, 77., 14.) + .22 * bump(l, 27., 5.) + .30 * bump(l, 287., 9.) + .18 * bump(l, 330., 8.) + .16 * bump(l, 308., 7.) + .10 * bump(l, 130., 12.);
    float hb = mix(3.4, 6.5, smoothstep(0., 170., abs(lw)));
    float bc = -.6 * cos(lw * DEG);                         // the sun sits a little above the plane
    float clouds = fbm(g * 9., 6), fine = fbm(g * 34. + 3., 4), mid = fbm(g * 17. + 8.5, 5), knot = fbm(g * 70. + 21., 3);
    /* [r3] the star clouds mottle the band at 0.5-3 deg (photographs: knots and voids, not an even ribbon) */
    float mott = .55 + 1.2 * clouds * (.7 + .6 * fine);
    mott *= .45 + 1.2 * smoothstep(.3, .72, mid) + .35 * smoothstep(.55, .8, fine);
    mott *= .62 + .76 * smoothstep(.25, .75, knot);
    float disk = fl * (exp(-abs(b - bc) / hb) * mott + .42 * exp(-abs(b - bc) / (3. * hb)));
    /* the bulge, boxy, a little south of the plane; the Sagittarius star cloud at b ~ -4 */
    float x = lw / 10., y = (b + 2.2) / 7.;
    float bulge = 1.15 * exp(-pow(pow(abs(x), 2.4) + pow(abs(y), 2.4), 1. / 1.2)) * (.75 + .5 * clouds);
    bulge += .45 * blob(l, b, 2., -4.5, 3., 2.2) + .22 * blob(l, b, 7., -1.5, 2., 1.5);
    /* dust: a thin lane along the plane, the Great Rift from Cygnus to Sagittarius splitting the band,
       Ophiuchus' dark clouds over the bulge, the Coalsack; filaments from a warped, ridged fBm */
    vec3 wq = g * 7. + vec3(fbm(g * 5. + 1.3, 4), fbm(g * 5. + 7.1, 4), fbm(g * 5. + 4.4, 4)) * 1.6;   // a warp: dust flows
    float fil = ridge(wq * 2.6 + 9., 6), pch = fbm(wq * 1.7 + 41., 5);
    /* the lanes' centre lines wander with the filaments, so their edges are wisps, not lines */
    float wob = (fil - .5) * 1.6 + (pch - .5) * 1.2;
    float tau = 1.0 * exp(-pow((b - bc - .2 + wob * .8) / 1.0, 2.)) * (.2 + 1.2 * pch) * smoothstep(175., 40., abs(lw));
    float rift = smoothstep(-6., 4., l) * smoothstep(92., 64., l) * step(l, 120.);
    float rc = 1. + 1.8 * sin(l * DEG * 2.3) * smoothstep(5., 40., l);
    tau += 2.3 * rift * exp(-pow((b - rc + wob) / mix(1.3, 2.2, smoothstep(10., 60., l)), 2.)) * (.35 + 1.1 * fil);
    /* dark nebulae: sparse clumps where a slow mask allows (Ophiuchus, Taurus, Aquila, Vela...) */
    float clump = smoothstep(.52, .78, pch) * smoothstep(.45, .7, fbm(g * 2.6 + 11., 3)) * exp(-pow((b - bc) / 8., 2.));
    tau += 1.4 * clump * (.5 + fil);
    tau += 1.4 * smoothstep(.5, .8, pch + .25 * fil) * blob(l, b, 357., 12., 10., 8.);
    tau += 1.3 * blob(l, b, 301., -1., 2.4, 2.);
    vec3 ext = exp(-tau * vec3(.80, 1., 1.22));             // dust reddens: blue is lost first
    vec3 c = (disk * vec3(.90, .95, 1.03) + bulge * vec3(1.06, .93, .76)) * ext;
    /* the diffuse galactic light, and the Magellanic Clouds */
    c += vec3(.92, .95, 1.) * .035 * exp(-abs(b) / 22.);
    c += vec3(.95, .97, 1.) * (.42 * blob(l, b, 280.5, -32.9, 3.6, 2.6) * (.6 + .8 * fine) + .22 * blob(l, b, 302.8, -44.3, 1.8, 1.3));
    o = vec4(c * 1.55, 1.);                                  // the Sagittarius cloud ~2.5, the band ~1-1.5
  }`;
  const SPRITE = `
  out vec4 o;
  /* the moon's maria: selenographic longitude (east +), latitude, semi-axes in degrees (lon, lat) */
  const int NGT_NM = 12;
  const vec4 NGT_MARE[12] = vec4[12](
    vec4(-15.6, 32.8, 21., 17.),   // Imbrium
    vec4(17.5, 28.0, 12., 11.),    // Serenitatis
    vec4(31.4, 8.5, 15., 12.),     // Tranquillitatis
    vec4(59.1, 17.0, 9., 7.),      // Crisium
    vec4(51.3, -7.8, 10., 13.),    // Fecunditatis
    vec4(35.5, -15.2, 6., 5.5),    // Nectaris
    vec4(-16.6, -21.3, 12., 10.),  // Nubium
    vec4(-38.6, -24.4, 6.5, 6.),   // Humorum
    vec4(-57.4, 18.4, 22., 36.),   // Procellarum
    vec4(1.4, 56.0, 40., 4.5),     // Frigoris
    vec4(3.6, 13.3, 4.5, 3.5),     // Vaporum
    vec4(-23.1, -10.0, 6., 5.)     // Cognitum
  );
  /* bright (+) and dark (-) craters: lon, lat, radius deg, strength */
  const vec4 NGT_CRATER[6] = vec4[6](
    vec4(-11.2, -43.3, 1.6, .9),   // Tycho
    vec4(-20.1, 9.6, 1.6, .55),    // Copernicus
    vec4(-38.0, 8.1, 1.1, .45),    // Kepler
    vec4(-47.4, 23.7, 0.9, 1.0),   // Aristarchus
    vec4(-9.4, 51.6, 1.7, -.45),   // Plato
    vec4(-68.3, -5.5, 3.0, -.5)    // Grimaldi
  );
  float ngtNoise(vec3 p) {
    vec3 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
    float a = wxHash13(i), b = wxHash13(i + vec3(1, 0, 0)), c = wxHash13(i + vec3(0, 1, 0)), d = wxHash13(i + vec3(1, 1, 0));
    float e = wxHash13(i + vec3(0, 0, 1)), g = wxHash13(i + vec3(1, 0, 1)), h = wxHash13(i + vec3(0, 1, 1)), k = wxHash13(i + vec3(1, 1, 1));
    return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
  }
  /* fBm whose octaves fade out where they would be finer than the footprint (in the same units as p) */
  float ngtFbm(vec3 p, float foot) {
    float s = 0., a = .5, w = 0., fr = 1.;
    for (int i = 0; i < 4; i++) {
      float keep = 1. - smoothstep(.25, .6, foot * fr);
      s += a * keep * (ngtNoise(p * fr) - .5); w += a; fr *= 2.03; a *= .5;
    }
    return s / w;
  }
  /* the moon's relative albedo (near-side mean 1) at selenographic unit vector q (x east, y north,
     z toward the earth), foot the pixel's footprint in moon radii */
  float ngtAlbedo(vec3 q, float foot) {
    float lon = atan(q.x, q.z) / NGT_DEG, lat = asin(clamp(q.y, -1., 1.)) / NGT_DEG;
    float edge = ngtFbm(q * 5. + 3.1, foot * 5.);
    float mare = 0.;
    for (int i = 0; i < NGT_NM; i++) {
      vec4 m = NGT_MARE[i];
      float dl = (lon - m.x) * cos(lat * NGT_DEG), db = lat - m.y;
      float e = (dl * dl) / (m.z * m.z) + (db * db) / (m.w * m.w);
      mare = max(mare, smoothstep(1.15, .7, e + edge * 1.1));
    }
    /* the highlands are not flat either: a little low-frequency mottling */
    float A = 1.16 * mix(1., .52, mare) * (1. + .14 * ngtFbm(q * 9. + 7.7, foot * 9.));
    for (int i = 0; i < 6; i++) {
      vec4 c = NGT_CRATER[i];
      float dl = (lon - c.x) * cos(lat * NGT_DEG), db = lat - c.y;
      float r = sqrt(dl * dl + db * db) / c.z;
      A *= 1. + c.w * exp(-r * r * 1.5);
    }
    /* Tycho's rays: thin streaks along great circles out to 40 deg, faint */
    vec3 ty = vec3(cos(-43.3 * NGT_DEG) * sin(-11.2 * NGT_DEG), sin(-43.3 * NGT_DEG), cos(-43.3 * NGT_DEG) * cos(-11.2 * NGT_DEG));
    float dt = acos(clamp(dot(q, ty), -1., 1.)) / NGT_DEG;
    vec3 t1 = normalize(cross(ty, vec3(0., 1., 0.))), t2 = cross(ty, t1);
    vec3 dq = q - ty * dot(q, ty);
    float bear = atan(dot(dq, t2), dot(dq, t1));
    float ray = pow(ngtNoise(vec3(cos(bear) * 7., sin(bear) * 7., 3.)), 6.) * 3.;
    A += ray * smoothstep(40., 4., dt) * smoothstep(1.5, 4., dt) * .35 * (1. - smoothstep(.15, .5, foot));
    return A;
  }
  
  void main() {
    float n = ngtSpriteN();
    vec2 k = gl_FragCoord.xy - vec2(0., ${MW_H}.);
    if (k.x > n || k.y > n) { o = vec4(0.); return; }
    vec3 m = uMoon.xyz, T1 = ngtT1(), T2 = cross(m, T1);
    /* the disc's frame: N toward the celestial pole, W toward celestial west (selenographic east) */
    mat3 M = mat3(uStar0.xyz, uStar1.xyz, uStar2.xyz);
    vec3 e = transpose(M) * m;
    vec3 W = M * normalize(vec3(e.y, -e.x, 0.) + vec3(1e-6, 0., 0.)), N = M * normalize(vec3(0., 0., 1.) - e * e.z + vec3(0., 1e-6, 0.));
    float foot = 2.5 / n;
    const vec2 TAP[4] = vec2[4](vec2(-.125, -.375), vec2(.375, -.125), vec2(.125, .375), vec2(-.375, .125));
    vec3 acc = vec3(0.);
    for (int t = 0; t < 4; t++) {
      vec2 q = ((k + TAP[t]) / n) * 2.5 - 1.25;           // disc units
      vec3 off = q.x * T1 + q.y * T2;
      float x = dot(off, W), y = dot(off, N), rr = x * x + y * y;
      if (rr >= 1.) continue;
      float z = sqrt(1. - rr);
      vec3 nn = x * W + y * N - z * m;                    // the surface normal, toward the viewer
      float mu0 = max(dot(nn, uSun.xyz), 0.);
      float A = ngtAlbedo(vec3(x, y, z), foot);
      acc += vec3(A * mu0 / (mu0 + z + 1e-6), A, 1.);
    }
    o = vec4(acc * .25, 1.);
  }`;
  let P = {}, mw = null, baked = false;
  const RAD = Math.PI / 180;
  /* the Lommel-Seeliger sphere's phase integral, 1 at full (Hapke 1981's form) */
  const lsPhase = (a) => {
    const x = Math.min(Math.max(a, 1e-3), 179) * RAD;
    return Math.max(1e-3, 1 - Math.sin(x / 2) * Math.tan(x / 2) * Math.log(1 / Math.tan(x / 4)));
  };
  return {
    name: "night",
    *build(R) {
      baked = false;
      mw = R.gpu.tex2D(MW_W, MW_H + 64, "r11g11b10f", { mips: true, wrap: "repeat" });   // + the moon's sprite rows
      mw.fb = R.gpu.fbo([mw]);
      P.bake = R.program("night.mw", { fs: BAKE });
      P.moon = R.program("night.moon", { libs: ["night"], fs: SPRITE });
      yield* R.wait(P.bake, P.moon);
      const gl = R.gl, strips = 8, h = MW_H / strips;
      for (let k = 0; k < strips; k++) {
        R.draw(P.bake, mw.fb, { uSize: [MW_W, MW_H] }, { viewport: [0, k * h, MW_W, h] });
        yield;
      }
      gl.bindTexture(gl.TEXTURE_2D, mw.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
      R.provideLib("sNightMW", mw);
      /*@lab*/ R.debugTex("night.mw", mw, "hdr"); /*@end*/
      baked = true;
    },
    ubo(F, R, set) {
      const sunEl = Math.asin(Math.max(-1, Math.min(1, F.sun.dir[1]))) / RAD;
      /* the moon's disc carries Krisciunas-Schaefer's E at its phase: per unit of albedo x LS */
      const md = F.moon.dir, sd = F.sun.dir;
      const cosA = -(md[0] * sd[0] + md[1] * sd[1] + md[2] * sd[2]);             // from the moon: sun vs earth
      const phase = typeof F.moon.phase === "number" ? F.moon.phase : Math.acos(Math.max(-1, Math.min(1, cosA))) / RAD;
      const r = F.moon.radius, k = F.moon.E / (Math.PI * r * r * 0.5 * lsPhase(phase));
      const stars = 1 - WX.util.smooth(-6, -4, sunEl);
      const sky = baked ? 1 - WX.util.smooth(-14, -9, sunEl) : 0;
      /* [r5] under a closed storm deck (W.cov .975 -> .984: 94 -> 96 % of the default scale) nothing from space shows,
         so the stars' and the band's branches fade out and are skipped (Intel T1, storm 96 at night: the sky slot
         1.21 -> 1.01 ms). The night sky's light on the clouds and the haze (wxNightAmbient: uE0.z) and the exposure
         floor below keep the clear sky's values. A smooth function of the reading: nothing accumulates. */
      const open = 1 - WX.util.smooth(0.975, 0.984, F.W && F.W.cov >= 0 ? F.W.cov : 0);
      let gate = 1; /*@lab*/ gate = R.p("night.gate"); /*@end*/
      set("uE0", k, stars * open * gate, sky * gate, R.p("night.faint"));
      /* [1.2] post's exposure floor (contract section 9): -4.5, lowered to -6 under a dark sky (stars out, the sun
         below -14 deg), so a clear moonless sky shows the Milky Way at the default exposure. A moon, a town's glow
         on a deck or twilight keep the meter above it, so only the darkest skies reach the floor */
      R.exposure.floor = -4.5 - 1.5 * stars * sky;
      /* [r3] the band at 3e-9 (2 x the measured surface brightness): a photograph's Milky Way, which is what
         the eye expects of a night view on a screen (the airglow and the light it casts stay physical) */
      set("uE1", R.p("night.stars"), 3e-9 * R.p("night.mw"), 8e-10 * R.p("night.airglow"), 4e-10 * R.p("night.airglow"));
    },
    slots: {
      /* the moon's sprite, before the sky slot reads it (a world slot that runs ahead of it) */
      atmo(R, F) {
        if (!baked || F.moon.dir[1] < -0.04) return;
        R.draw(P.moon, mw.fb, null, { viewport: [0, MW_H, 64, 64] });
      },
    },
  };
})());
