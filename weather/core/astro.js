/* ═══════════════════════ Weather: astronomy (stream E) ═══════════════════════
   Where the sun, the moon and the stars are, for an instant and a place (DESIGN 3, robust.md 3.1,
   measured there and again in tests/director/astro.test.mjs).

   WX.skyAt(ms, latDeg, lonDeg[, out]) -> { sun, sunRaw, moon, lit, waxing, dist, eq, lst, phase }
     sun, moon   unit vectors east-north-up after refraction (Saemundsson); the moon topocentric
     sunRaw      the geocentric sun, unrefracted: what lights the moon's sphere
     lit         illuminated fraction 0..1     waxing   true from new to full
     dist        the moon's distance from the observer, km (topocentric); distGeo from the centre
     geo         the geocentric moon, unrefracted     dl  its ecliptic longitude less the sun's, deg
     phase       the phase angle sun-moon-earth, degrees (0 full, 180 new)
     eq          Float64Array(9), column-major: equatorial unit vectors -> east-north-up
     lst         local sidereal time, degrees 0..360
     The sun to NOAA's (Meeus ch. 25), the moon to Meeus ch. 47's largest terms (26 in longitude, 13 in latitude, 5 in distance); terrestrial time
     is taken as universal time (69 s apart). Pass `out` (an earlier result) to allocate nothing.
   WX.toWorld(enu, headingDeg[, out]) -> the world-frame unit vector (contract.js: +z the heading,
     +x right, +y up): east = (cos H, 0, sin H), north = (-sin H, 0, cos H), up = (0, 1, 0).
   WX.eqToWorld(eq, headingDeg, out9)  the star matrix: equatorial -> world, column-major (Float32Array(9))
   WX.lstAt(ms, lonDeg)                local sidereal time, degrees, for the stars every frame
   WX.eqAt(lstDeg, latDeg, out9)       equatorial -> east-north-up for that sidereal time and latitude
   WX.moonE(phaseDeg)                  the moon's illuminance at the top of the atmosphere, rel
                                       (Krisciunas & Schaefer 1991: m = -12.73 + 0.026|a| + 4e-9 a^4)
   WX.moonRadius(distKm)               its angular radius, rad (0.2595 deg at 384 400 km)
   WX.moonEarthshine(lit)              the dark limb's radiance from earthshine, rel: 2.5e-4 x the full
                                       moon's mean radiance x (1 - lit)                                  */
(function () {
  const RAD = Math.PI / 180;
  const S = (x) => Math.sin(x * RAD), C = (x) => Math.cos(x * RAD);
  const wrap360 = (x) => ((x % 360) + 360) % 360;

  /* ecliptic (l, b) -> east-north-up into o[k..k+2], for obliquity eps, sidereal time lst, latitude lat */
  function enu(l, b, eps, lst, lat, o, k) {
    const x = C(b) * C(l), y = C(eps) * C(b) * S(l) - S(eps) * S(b), z = S(eps) * C(b) * S(l) + C(eps) * S(b);
    const ra = Math.atan2(y, x) / RAD, h = lst - ra, cd = Math.hypot(x, y);   // hour angle; z = sin dec
    o[k] = -cd * S(h);
    o[k + 1] = z * C(lat) - cd * C(h) * S(lat);
    o[k + 2] = z * S(lat) + cd * C(h) * C(lat);
  }
  /* lifted by refraction (Saemundsson), down to the horizon and a degree below it; in place */
  function lift(v) {
    const a = Math.asin(Math.max(-1, Math.min(1, v[2]))) / RAD;
    if (a < -1) return;
    const b = a + 1.02 / Math.tan((a + 10.3 / (a + 5.11)) * RAD) / 60;
    const k = C(b) / Math.max(1e-9, Math.hypot(v[0], v[1]));
    v[0] *= k; v[1] *= k; v[2] = S(b);
  }
  WX.lstAt = (ms, lon) => wrap360(280.46061837 + 360.98564736629 * (ms / 864e5 - 10957.5) + lon);
  WX.eqAt = function (lst, lat, o) {
    const sl = S(lst), cl = C(lst), sp = S(lat), cp = C(lat);
    o[0] = -sl; o[1] = -sp * cl; o[2] = cp * cl;
    o[3] = cl; o[4] = -sp * sl; o[5] = cp * sl;
    o[6] = 0; o[7] = cp; o[8] = sp;
    return o;
  };
  WX.skyAt = function (ms, lat, lon, out) {
    const o = out || { sun: [0, 0, 1], sunRaw: [0, 0, 1], moon: [0, 0, 1], geo: [0, 0, 1], lit: 0, waxing: true,
                       dist: 384400, phase: 90, lst: 0, eq: new Float64Array(9) };
    const d = ms / 864e5 - 10957.5, T = d / 36525;              // days and centuries from J2000.0
    const om = 125.04 - 1934.136 * T;                           // the moon's node, for nutation
    const eps = 23.439291 - 0.0130042 * T + 0.00256 * C(om);
    const Ms = 357.52911 + 35999.05029 * T;
    const ls = 280.46646 + 36000.76983 * T + (1.914602 - 0.004817 * T) * S(Ms) + 0.019993 * S(2 * Ms) +
               0.000289 * S(3 * Ms) - 0.00569 - 0.00478 * S(om);
    const D = 297.8501921 + 445267.1114034 * T, Mm = 134.9633964 + 477198.8675055 * T,
          F = 93.272095 + 483202.0175233 * T;
    const Lm = 218.3164477 + 481267.88123421 * T, A1 = 119.75 + 131.849 * T, A3 = 313.45 + 481266.484 * T;
    const lm = Lm + 6.288774 * S(Mm) + 1.274027 * S(2 * D - Mm) + 0.658314 * S(2 * D) +
      0.213618 * S(2 * Mm) - 0.185116 * S(Ms) - 0.114332 * S(2 * F) + 0.058793 * S(2 * D - 2 * Mm) +
      0.057066 * S(2 * D - Ms - Mm) + 0.053322 * S(2 * D + Mm) + 0.045758 * S(2 * D - Ms) - 0.040923 * S(Ms - Mm) -
      0.03472 * S(D) - 0.030383 * S(Ms + Mm) + 0.015327 * S(2 * D - 2 * F) - 0.012528 * S(Mm + 2 * F) +
      0.01098 * S(Mm - 2 * F) + 0.010675 * S(4 * D - Mm) + 0.010034 * S(3 * Mm) + 0.008548 * S(4 * D - 2 * Mm) -
      0.007888 * S(2 * D + Ms - Mm) - 0.006766 * S(2 * D + Ms) - 0.005163 * S(D - Mm) + 0.004987 * S(D + Ms) +
      0.004036 * S(2 * D - Ms + Mm) + 0.003994 * S(2 * D + 2 * Mm) + 0.003958 * S(A1) + 0.001962 * S(Lm - F) - 0.00478 * S(om);
    const bm = 5.128122 * S(F) + 0.280602 * S(Mm + F) + 0.277693 * S(Mm - F) + 0.173237 * S(2 * D - F) +
      0.055413 * S(2 * D - Mm + F) + 0.046271 * S(2 * D - Mm - F) + 0.032573 * S(2 * D + F) + 0.017198 * S(2 * Mm + F) +
      0.009266 * S(2 * D + Mm - F) + 0.008822 * S(2 * Mm - F) + 0.008216 * S(2 * D - Ms - F) + 0.004324 * S(2 * D - 2 * Mm - F) +
      0.0042 * S(2 * D + Mm + F) - 0.002235 * S(Lm) + 0.000382 * S(A3) + 0.000175 * S(A1 - F) + 0.000175 * S(A1 + F);
    const dist = 385000.56 - 20905.355 * C(Mm) - 3699.111 * C(2 * D - Mm) - 2955.968 * C(2 * D) - 569.925 * C(2 * Mm);
    const lst = wrap360(280.46061837 + 360.98564736629 * d + lon);   // local sidereal time, degrees
    enu(ls, 0, eps, lst, lat, o.sunRaw, 0);
    enu(lm, bm, eps, lst, lat, o.geo, 0);
    o.sun[0] = o.sunRaw[0]; o.sun[1] = o.sunRaw[1]; o.sun[2] = o.sunRaw[2];
    lift(o.sun);
    const g = o.geo, m = o.moon;
    m[0] = g[0] * dist; m[1] = g[1] * dist; m[2] = g[2] * dist - 6371;   // seen from the ground
    const n = Math.hypot(m[0], m[1], m[2]);
    m[0] /= n; m[1] /= n; m[2] /= n;
    lift(m);
    const cosE = o.sunRaw[0] * g[0] + o.sunRaw[1] * g[1] + o.sunRaw[2] * g[2];   // elongation
    o.lit = (1 - cosE) / 2;
    /* the phase angle: the sun is 389 times farther than the moon, so it is the elongation's supplement
       less the moon's parallax as the sun sees it (at most 0.15 deg) */
    const E = Math.acos(Math.max(-1, Math.min(1, cosE)));
    o.phase = Math.atan2(149597870 * Math.sin(E), dist - 149597870 * cosE) / RAD;
    o.dist = n;
    o.distGeo = dist;
    o.dl = wrap360(lm - ls);                            // the moon's ecliptic longitude less the sun's
    o.waxing = o.dl < 180;
    o.lst = lst;
    WX.eqAt(lst, lat, o.eq);
    return o;
  };

  WX.toWorld = function (v, H, out) {
    const o = out || [0, 0, 0], c = C(H), s = S(H);
    const e = v[0], n = v[1], u = v[2];
    o[0] = e * c - n * s; o[1] = u; o[2] = e * s + n * c;
    return o;
  };
  WX.eqToWorld = function (eq, H, out) {
    const o = out || new Float32Array(9), c = C(H), s = S(H);
    for (let k = 0; k < 9; k += 3) {
      const e = eq[k], n = eq[k + 1], u = eq[k + 2];
      o[k] = e * c - n * s; o[k + 1] = u; o[k + 2] = e * s + n * c;
    }
    return o;
  };

  /* at the mean distance; the director scales it by (384 400 / dist)^2 */
  WX.moonE = (a) => Math.pow(10, -0.4 * (-12.73 + 0.026 * Math.abs(a) + 4e-9 * Math.pow(a, 4) + 26.74));
  WX.moonRadius = (dist) => 0.2595 * RAD * 384400 / dist;
  /* a surface radiance, so independent of the distance: the full moon's mean radiance is its illuminance
     at the mean distance over the disc's solid angle there */
  WX.moonEarthshine = (lit) => 2.5e-4 * (WX.moonE(0) / (Math.PI * Math.pow(0.2595 * RAD, 2))) * (1 - lit);
})();
