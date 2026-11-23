/* ═══════════════════════ Weather: the sky composite (stream A) ═══════════════════════
   The sky slot: clears the scene's depth; draws the clear sky (sky-view LUTs), what lies beyond the
   atmosphere (E's night library: moon, stars, Milky Way, airglow) through the air's transmittance,
   the sun's disc, the cirrus sheet at 9 km with its 22-degree halo, then the clouds over it (the
   cloud buffer's sky taps only, so no medium of the cove's pixels fringes its silhouettes), and the
   in-cloud glow of a flash (render.md 9). Then REFL: SCENE at half size with full mips, the sky
   alone (without the sun's disc since round 3), before the cove and the sea.
   Below the sea's horizon (the true dip, -0.12 deg at 14 m) it draws only the sky just above the
   horizon: the cove and the sea cover all of it, and nothing there may show through them.      */
WX.pass((function () {
  const P = {};
  let dummy = null;
  const FLK = [1, 1, 1, 1];
  /* [round 5] the flash's relief: the mottle's strength in stops per unit of the base's mid octaves (lab: p.sky.rlv=) */
  let RLV = (.45).toFixed(3); /*@lab*/ { const q = new URLSearchParams(location.search).get("p.sky.rlv"); if (q) RLV = (+q).toFixed(3); } /*@end*/
  let ACB = (1).toFixed(3); /*@lab*/ { const q = new URLSearchParams(location.search).get("p.sky.acb"); if (q) ACB = (+q).toFixed(3); } /*@end*/
  /*@lab*/ WX.param("sky.sheet", 1, 0, 4, 0.05, "sky"); WX.param("sky.flDiff", 1, 0, 4, 0.05, "sky"); WX.param("sky.lump", 1, 0, 4, 0.05, "sky"); WX.param("sky.glow", 1, 0, 4, 0.05, "sky"); /*@end*/
  return {
    name: "sky",
    *build(R) {
      dummy = null;
      /* [round 3] the density field (clouds.js registers it) for the flash volume; without it (live=sky over the
         stub clouds) the flash lights the cloud without the taps */
      const field = !!WX.libs.cldfield;
      let cut = 0; /*@lab*/ cut = R.p("sky.cut") | 0; /*@end*/
      let cubic = 1; /*@lab*/ if (WX.labParam && "sky.cubic" in WX.labParam) cubic = WX.labParam["sky.cubic"] | 0; /*@end*/
      P.sky = R.program("sky.composite", { libs: ["atmo", "clouds", "night"].concat(field ? ["cldfield"] : []), fs: `
        #define CLD_FIELD ${field ? 1 : 0}
        #define SKY_NO_AC ${cut & 1}
        #define SKY_NO_CI ${(cut >> 1) & 1}
        #define SKY_ONE_TAP ${(cut >> 2) & 1}
        #define SKY_CUBIC ${cubic ? 1 : 0}
        #define SKY_CUBIC_CHECK ${cubic === 2 ? 0 : 1}
        vec3 skyNightIn(vec3 d, vec3 T) { return ${(WX.libs.night || "").indexOf("wxNightIn") >= 0 ? "wxNightIn(d, T)" : "vec3(0.)"}; }
        uniform sampler2D uCirrus; in vec2 vUV; out vec4 o;
        /* [round 4] the flash's tuning (1 = the design): x the far flash's sheet, y the deck's diffuse share, z the lit
           lump where a channel leaves the base, w the glow in the deck round the channel's top */
        uniform vec4 uFlK;
        /* [round 3] A FLASH LIGHTS THE CLOUD AND THE RAIN ROUND ITS CHANNEL, per pixel and every frame (the A/C agreement in
           notes/sky.md; the amortized trace drew it in 4x4 blocks). Two parts:
           - the lit cloud: a round glow on the screen about the channel's top, 0.3-0.8 km into the deck for a cloud-to-sea
             strike, the strike point for an in-cloud one (a lit disc on the flat base plane, seen edge-on from 14 m, drew
             the horizontal bar the reviewer named; C, 10:14). Three density taps between the point the ray reaches at that
             distance and the channel say how much cloud the light crosses, so pouches and thick cores hide it and thin
             parts glow: the deck lights from inside with its own relief. It shows on cloud and fog alike;
           - the lit rain: a column of light round a cloud-to-sea channel below the base, from the closest approach of the
             ray to it (~0.35 km).
           The strength is the area light's I (exposure-normalised; by day lifted to a visible patch, <= .6 pre-exposed, as
           C's patch was; at night 4x the capped I x E, <= 1.2), seen through the air with T^.2 (rain and haze scatter it
           forward into a halo rather than taking it out), flickering with the restrikes (B) */
        /* [round 4] the deck's relief where the ray meets its base, for the flash's light: the pouches' undersides face the
           dark sea and stay dark, the recesses between them and the thin parts take the light (1 where no deck) */
        float flashRelief(vec3 o, vec3 d, float tMax) {
        #if CLD_FIELD
          if (d.y < .004) return 1.;
          float t = min((uWx0.z - o.y) / d.y, tMax);
          CldS cs; float c = cldBase(o + d * t, 1., cs);
          /* [round 5] and the base's mid-scale mottle (its .44-.87 km octaves, as the trace's storm mottle): a lit deck keeps its
             lobes and seams under a flash (E 11:04, REVIEW-4 #4) */
          return c <= 0. ? 1. : mix(1.45, .3, smoothstep(-.4, .9, cs.lb)) * (.6 + .4 * cs.pw) * exp2(${RLV} * clamp(cs.mt, -2., 2.) - .1);
        #else
          return 1.;
        #endif
        }
        vec3 flashVol(vec4 f, vec4 fb, vec3 d) {
          if (f.w <= 0.) return vec3(0.);
          float dayK = 1. - smoothstep(300., 3000., uExpo.x);
          /* [round 4] by day <= .9 pre-exposed (.6), at night <= 1.6 (1.2): the lit base must stand out of the darker storm
             deck next to the channel (REVIEW-3 #3); post's flash limit still holds every 16 px block */
          float Iv = min(f.w * uExpo.x * mix(5., 300., dayK), mix(1.6, .9, dayK));
          vec3 o = vec3(0., wxEye * 1e-3, 0.);
          bool cg = fb.x > .5;
          float L = 0.;
          /* [round 4] A CLOUD-TO-SEA CHANNEL LEAVES THE DECK IN A LIT LUMP (REVIEW-3 #3; NOAA's night CGs: the base burns
             where the channel leaves it): C pins the channel's crossing of W.base under the flash centre, and the base glows
             round that exit, a compact core (~0.2 km, Gaussian, a little wider than tall: the base is seen at a grazing
             angle) on the base's own relief, with a faint 0.6 km skirt. A Lorentzian 0.3 km core (the first try) lit the
             whole middle of the sky by its tails and no lump stood out (r2 d-cg3: +7 % of the frame from the lump alone).
             The deck above glows wider and dimmer (0.55 km into it) */
          float km = 0.;
          if (cg) {
            vec3 X = vec3(f.x, uWx0.z + .03, f.z);
            float kx = length(X - o);
            vec3 xd = (X - o) / kx;
            float tH = (atan(d.x, d.z) - atan(xd.x, xd.z)), tV = asin(clamp(d.y, -1., 1.)) - asin(clamp(xd.y, -1., 1.));
            tH = (tH - 6.2831853 * floor(tH / 6.2831853 + .5)) * kx; tV *= kx * 1.5;
            float t2 = tH * tH + tV * tV, rx = mix(.24, .18, dayK);
            /* (post's flash limit holds every 16 px block to +.18 over its pre-flash level: a skirt or a glow that already filled
               the blocks round the exit left the core no headroom, and the lump read as a ring with a hole, r4/d-cg3 against
               d-cg3-L0. So the skirt is faint and the core alone reaches the limit) */
            /* [round 5] the skirt's Lorentzian tails (x 6 at night) lit the far deck too: a Gaussian 0.6 km skirt */
            float gx = exp(-t2 / (rx * rx)) + .035 * exp(-t2 / .36);
            /* (seen through the rain with T^.1, as C's channel itself is: through 5 km of night rain T^.2 left a seventh of it) */
            L += gx * mix(6., 2.2, dayK) * uFlK.z * mix(1., flashRelief(o, d, kx * 1.5), .5) * pow(wxAerial(d, kx).a, .1);
          }
          /* the lit cloud's centre and its size: deeper flashes light a wider, dimmer patch */
          /* (an in-cloud flash's light leaves the deck through the base under it: the patch is there, wider and dimmer the
             deeper the flash; at its own height it could sit above the frame) */
          /* [round 4] a cloud-to-sea strike's glow sits on the base round the exit (.15 km in): at .55 km into the deck its
             screen-round patch floated over the top of the frame at 3 km and lit the whole sky there (soft6-6) */
          vec3 F = vec3(f.x, uWx0.z + (cg ? .15 : .3), f.z);
          km = length(F - o);
          float dz = max(f.y - uWx0.z - .3, 0.);
          /* [round 4] by day a smaller glow with a faint halo: lifted to a visible patch, the 1.8 km halo lit the whole frame
             evenly grey round the channel, and no lump stood out (cg3-day) */
          float rc = (cg ? mix(.6, .4, dayK) : .5 + .3 * dz) * mix(1., .8, dayK), hw = mix(.1, .07, dayK);
          float th = acos(clamp(dot(d, (F - o) / km), -1., 1.)) * km;           // km across the view at the patch's distance
          /* a bright core (the NOAA night photographs: the cloud round the channel's top glows several times the rest)
             and a dim halo three times as wide */
          /* [round 5] ONLY THE CLOUD NEAR THE STRIKE GLOWS (REVIEW-4 #4: a night CG at 5 km lifted the far deck +23 levels, the
             frame from edge to edge). The glow was measured across the view at the strike's distance, so the deck overhead,
             1-2 km from the eye and 5 km from the strike, sat ~2.6 km "from" it and took its Lorentzian tails (7 % of the
             centre). It now also falls off with the true distance from the glow's centre to what the ray sees there (where it
             meets the base, or reaches the strike's range under it): the light diffusing through a deck, e^(-rho / 1.3 km)
             beyond 0.4 km, as atmFlashDeck. The deck overhead takes ~4 % of what it did; the patch round the exit all of it */
          float tS = length(F.xz) / max(length(d.xz), 1e-3), tP = d.y > 1e-3 ? (F.y - o.y) / d.y : 1e9;
          float loc = exp(-max(length(o + d * min(tS, tP) - F) - .4, 0.) / 1.3);
          float g = (rc * rc / (th * th + rc * rc) + hw * 9. * rc * rc / (th * th + 9. * rc * rc)) * sqrt(.5 / rc) * (cg ? mix(.3, .22, dayK) : 1.) * loc;
          /* [round 4] the taps' answer eases into a typical one (.45) where the glow fades: switched on at g > .02 it drew a
             hard circle round a night flash (REVIEW-3 round-4 renders, ic18-night). Taps from g > .012 (three cldBase a pixel:
             at .004 most of the sky paid for them during a flash on Intel) */
          float Td = .45;
        #if CLD_FIELD
          if (g > .012) {
            vec3 P = o + d * km;
            float od = 0.; CldS cs;
            for (int i = 0; i < 3; i++) od += cldBase(mix(F, P, (float(i) + .5) / 3.), 1., cs);
            od *= length(P - F) / 3. * 30.;
            Td = mix(.45, 1. / (1. + .03 * od) * (.55 + .45 * cs.pw), smoothstep(.012, .03, g));
          }
        #endif
          L += g * Td * pow(wxAerial(d, km).a, .2) * uFlK.w;
          /* the rain lit round a cloud-to-sea channel, below the base */
          if (cg) {
            vec3 A = vec3(f.x, 0., f.z), u = vec3(0., uWx0.z, 0.), w0 = o - A;
            float b = dot(d, u), c = dot(u, u), dd = dot(d, w0), e = dot(u, w0), den = c - b * b;
            float sg = clamp(den > 1e-6 ? (e - b * dd) / den : e / c, 0., 1.);
            float tr = max(dot(A + u * sg - o, d), 0.);
            vec3 q = o + d * tr - (A + u * sg);
            /* [round 4] ~170 m wide (was ~350 m): C's halo carries the glow next to the channel; this is the lit rain
               itself (a 0.35 km column read as a vertical stripe of light up the frame, r2 d-cg3) */
            L += .4 * .03 / (dot(q, q) + .03) * pow(wxAerial(d, tr).a, .2);
          }
          /* [round 4] A FAR FLASH IS SHEET LIGHTNING (REVIEW-3 #4: at 96 % the strikes are ~15 km out, and the air's
             transmittance, ~1e-10 over 15 km of 2.6 km visibility, erased their glow): the rain and the deck scatter its
             light many times with an albedo near 1, so it reaches the eye as a broad glow over the horizon in its azimuth
             (+-18 deg to 1/e), strongest just above the horizon and fading over ~10 deg, on the deck's own relief. It takes
             over from the glow from 3 to 9 km out; by day <= .42 pre-exposed, at night <= .4 and lower (~5 deg: on a dark
             night deck a taller sheet lit the whole sky) */
          float kh = length(f.xz), far = smoothstep(3., 9., kh);
          if (far > 0. && d.y > -.01) {
            vec2 dh = d.xz / max(length(d.xz), 1e-4);
            float lobe = exp((dot(f.xz / max(kh, 1e-3), dh) - 1.) / .05);
            if (lobe > .003) {
              float Is = min(f.w * uExpo.x * mix(2.5, 120., dayK), mix(.4, .42, dayK));
              float vp = exp(-max(d.y, 0.) / mix(.09, .17, dayK));
              L += Is / max(Iv, 1e-6) * uFlK.x * far * lobe * vp * flashRelief(o, d, kh);
            }
          }
          float flick = .7 + .45 * min(fb.z * 2., 1.);
          return WX_FLASH_RGB * Iv * L * flick * .8;
        }
        /* the cirrus sheet at 9 km: streaks along the wind aloft, lit forward (HG .6), and the 22-degree
           halo where it is thin (render.md 6.8). rgb in-scatter reaching the eye, a transmittance */
        vec4 cirrus(vec3 d, vec3 Tv) {
          float cir = uWx1.x;
          if (cir <= .01) return vec4(0., 0., 0., 1.);
          float r0 = R_G + wxEye * 1e-3, rc = R_G + 9.;
          float t = wxSphere(r0, d.y, rc).x;
          vec3 p = vec3(0., r0, 0.) + d * t;
          vec2 uv = (p.xz - uDrift1.xy) / 30.;
          vec2 warp = (textureLod(uCirrus, uv * .5 + .31, 0.).bg - .5) * .012;     // a gentle bend, not marble (alpha: the Ac cells)
          vec4 n = texture(uCirrus, uv + warp);
          /* patches of fibres over a thin veil; more of the sky as the cirrus thickens */
          float patchy = smoothstep(.4, .8, n.g + (cir - .5) * .6);
          float fib = smoothstep(.3, .88, n.r);
          float dens = patchy * mix(fib, 1., .22) * smoothstep(.02, .35, cir);
          if (dens <= 1e-3) return vec4(0., 0., 0., 1.);          // most of a clear sky: no light to look up
          float tau = dens * mix(.2, .7, cir);
          float Tc = exp(-tau);
          float mu9 = dot(normalize(p), d);
          vec3 Tf = Tv / max(wxTransmittance(rc, mu9), vec3(1e-4));
          float c = dot(d, uKey.xyz);
          float ph = mix(wxHG(c, .65), wxHG(c, -.2), .3);
          /* the halo: plate crystals refract the light 22 degrees; red inside, bluish out */
          float a = acos(clamp(dot(d, uSun.xyz), -1., 1.)) * 57.2958;
          vec3 ring = vec3(exp(-pow((a - 21.85) / .55, 2.)), exp(-pow((a - 22.1) / .6, 2.)), exp(-pow((a - 22.4) / .7, 2.)));
          ring += vec3(.08) * smoothstep(22.5, 21.5, a) * step(a, 22.);       // the darker sky inside the ring stays
          float halo = smoothstep(.45, .8, cir) * (1. - Tc) * smoothstep(1.6, .3, tau) * .045;
          vec3 amb = texelFetch(sAmbient, ivec2(2, 0), 0).rgb;
          vec3 L = (wxSunLight(p) * (ph + ring * halo / max(1. - Tc, 1e-3) * 4.) + wxMoonLight(p) * ph + amb * .7) * (1. - Tc) * .9;
          return vec4(L * Tf, Tc);
        }
        /* [round 3] ALTOCUMULUS at 4.2 km (cover ~.25-.9): patches of small rounded cloudlets (~300 m, 4-8 deg overhead) in
           rows, from the cirrus texture's alpha on a 15 km tile (28 in 420) inside patches from its mask on a 105 km tile
           (4 in 420), drifting with the weather layer. Lit by the sun at their own height, so they keep the light, and the
           after-sunset pink, after the low clouds have lost it; each cloudlet is shaded on its far side (the pattern
           looked up again 90 m toward the light). rgb in-scatter reaching the eye, a transmittance */
        vec4 altocu(vec3 d, vec3 Tv) {
          float acW = smoothstep(.22, .35, uWx0.x) * (1. - smoothstep(.82, .93, uWx0.x));
          if (acW <= 0.) return vec4(0., 0., 0., 1.);
          float r0 = R_G + wxEye * 1e-3, rc = R_G + 4.2;
          float t = wxSphere(r0, d.y, rc).x;
          vec3 p = vec3(0., r0, 0.) + d * t;
          vec2 xz = p.xz - uDrift0.xy;
          float m = texture(uCirrus, xz / 105. + .27).g;
          float patchy = smoothstep(.6, .86, m + (acW - .6) * .25) * acW;
          if (patchy <= 1e-3) return vec4(0., 0., 0., 1.);
          vec2 uv = xz / 15.;
          /* [round 4] NOT A COBBLESTONE (REVIEW-3 m-phone: a regular tiling of equal cells): the cells' pattern is bent by
             the fibre noise (~100 m), and its threshold wanders over ~5 km, so the cells merge into rows and sheets in
             some places and stand apart, smaller, in others */
          vec4 wn = texture(uCirrus, uv * (10. / 28.) + .13);       // a 42 km tile (10 in 420)
          uv += (wn.rb - .5) * .025;
          float thr = mix(.5, .76, smoothstep(.25, .75, texture(uCirrus, uv * (6. / 28.) + .61).g));   // 70 km (6 in 420)
          /* [round 6] NOT AN EVEN FIELD (REVIEW-5 #1, h): the cells clump into groups with holes between them (a 5 km tile's
             mask, ~1-2 km), and in places they are half the size (a second read at twice the frequency, a 30 km tile's choice) */
          float sz = smoothstep(.35, .65, texture(uCirrus, uv * .5 + .77).g) * ${ACB} * smoothstep(.1, .25, d.y);   // (not toward the horizon: finer cells alias there, and the sea's mirror shows them)
          float cl = mix(1., smoothstep(.22, .62, texture(uCirrus, uv * 3. + .41).g), ${ACB});
          float cA = mix(texture(uCirrus, uv).a, texture(uCirrus, uv * 2. + .19).a, sz);
          float dens = patchy * cl * smoothstep(thr, thr + .3, cA);
          if (dens <= 1e-3) return vec4(0., 0., 0., 1.);
          vec2 lk = uKey.xz / max(length(uKey.xz), 1e-3) * (.09 / 15.);
          float cB = mix(texture(uCirrus, uv + lk).a, texture(uCirrus, (uv + lk) * 2. + .19).a, sz);
          float shade = exp(-2.2 * patchy * cl * smoothstep(thr, thr + .3, cB));
          float Tc = exp(-dens * 2.6);
          float cs = dot(d, uKey.xyz), ph = mix(wxHG(cs, .6), wxHG(cs, -.2), .4);
          vec3 amb = texelFetch(sAmbient, ivec2(2, 0), 0).rgb;
          vec3 lit = wxSunLight(p); if (uA1.w > .5) lit += wxMoonLight(p);
          vec3 L = (lit * ph * (.3 + .7 * shade) * 2.2 + amb * .8) * (1. - Tc);
          vec3 Tf = Tv / max(wxTransmittance(rc, dot(normalize(p), d)), vec3(1e-4));
          return vec4(L * Tf, Tc);
        }
        /* [r7] THE CLOUD BUFFER MAGNIFIED. At T0-T3 a cloud texel covers 2-3 render px, and on a scaled panel (the user's
           2560 px at 1.333, Intel T1) the compositor doubles that: bilinear drew 8-10 device px stair steps on the cloud
           edges and a mosaic in their bodies (REVIEW-6). A cubic B-spline, from four bilinear fetches, smooths them; it is
           weighed in by the magnification, so T4 (a texel a pixel) is drawn exactly as before. Intel T1 at 1280x820, golden
           45 %: the sky slot +.1-.3 ms (the iGPU's clock made single runs differ by more); lab knob p.sky.cubic=0 (off),
           =2 (without the 4 x 4 sky check). */
        vec4 cldCubic(vec2 uv) {
          vec2 st = uv * uCloudRes.xy - .5, i = floor(st), f = st - i, f2 = f * f, f3 = f2 * f;
          vec2 w0 = (1. - 3. * f + 3. * f2 - f3) / 6., w1 = (4. - 6. * f2 + 3. * f3) / 6.,
               w2 = (1. + 3. * f + 3. * f2 - 3. * f3) / 6., w3 = f3 / 6.;
          vec2 g0 = w0 + w1, g1 = w2 + w3;
          vec2 p0 = (i - .5 + w1 / g0) * uCloudRes.zw, p1 = (i + 1.5 + w3 / g1) * uCloudRes.zw;
          return g0.y * (g0.x * texture(sCloud, p0) + g1.x * texture(sCloud, vec2(p1.x, p0.y))) +
                 g1.y * (g0.x * texture(sCloud, vec2(p0.x, p1.y)) + g1.x * texture(sCloud, p1));
        }
        /* the 4 x 4 texels the B-spline reads hold sky rays only (none ended on the sea or the cove): near the cove the
           depth-aware bilinear stays, so no surface texel bleeds into the sky round its outline */
        bool cldAllSky(vec2 uv) {
          ivec2 i0 = ivec2(floor(uv * uCloudRes.xy - .5)) - 1, mx = ivec2(uCloudRes.xy) - 1;
          float k = 0.;
          for (int j = 0; j < 16; j++) k = max(k, texelFetch(sCloudZ, clamp(i0 + ivec2(j & 3, j >> 2), ivec2(0), mx), 0).g);
          return k < .5;
        }
        void main() {
          vec3 d = wxRay(vUV);
          float r0 = R_G + wxEye * 1e-3, hz = -sqrt(max(0., 1. - R_G * R_G / (r0 * r0)));
          if (d.y < hz) {
            /* [round 3] under a rain deck the sky just above the horizon is the AP's air (lit from beyond the storm's edge),
               not the LUT's: the sea's rough mirror reads REFL here, and the LUT's horizon made a flat bright band on it */
            vec3 sk = wxSky(d);
            if (uA1.z > 0.) { vec3 dh = normalize(vec3(d.x, hz + 2e-3, d.z)); vec4 apF = wxAerial(dh, 64.); sk = mix(sk, apF.rgb + sk * apF.a, uA1.z); }
            o = vec4(wxGuard(sk), 1.); return;
          }
          /* [1.2] the cloud buffer holds the camera's own (unjittered) rays: take this frame's jitter out */
          /* [round 3] above 8.6 deg no cove can stand, so no surface texel can be among the taps: one bilinear fetch
             there instead of the depth-aware eight (the Intel budget) */
          vec2 cuv = vUV - uTaa.xy * uRes.zw;
          vec4 c;
          /* by the render px per cloud texel; off under a closed raining deck (uA1.z), which has no cumulus edges to step
             and is where Intel T1's storm budget is tight: there the branch is skipped and costs nothing */
          float cw = SKY_CUBIC == 1 ? smoothstep(1.4, 2.2, uRes.x * uCloudRes.z) * (1. - uA1.z) : 0.;
          if (d.y > .15 || SKY_ONE_TAP == 1) { c = texture(sCloud, cuv); if (cw > 0.) c = mix(c, cldCubic(cuv), cw); }
          else {
            float ws; c = cldTaps(cuv, 0., ws); c = ws > 1e-3 ? c / ws : vec4(0., 0., 0., 1.);
            if (cw > 0. && ws > .999 && (SKY_CUBIC_CHECK == 0 || cldAllSky(cuv))) c = mix(c, cldCubic(cuv), cw);
          }
          vec3 L = c.rgb;
          /* what lies behind the clouds: skipped where they hide it (most of an overcast frame) */
          if (c.a > 1e-3) {
            float px = 2. * uCamY.w * uRes.w;
            vec3 Tv = wxTransmittance(r0, d.y);
            /* the sun's disc is ~3e5 times the sky beside it: through a cloud it shows only where the cloud is
               thin (T > 2 %), fading in smoothly, so an opaque cloud never lets it through and the clouds'
               own transmittance needs no snap (a snapped T flickered at the edges of decks) */
            /* [round 3] wxNightIn (contract 1.3): the night sky's own light scattered into the low, hazy rays, so a dark
               coast's horizon is a little brighter than its zenith instead of black */
            vec3 sky = wxSky(d), back = wxSpace(d, px) * Tv + skyNightIn(d, Tv) + wxSunDisc(d) * smoothstep(.02, .25, c.a);
            /* [round 3] under a rain deck the air out to 64 km is the AP's, lit place by place (the light from beyond the
               storm's edge, atmUnder): the sky-view LUT's uniform under-deck dimming only beyond it */
            if (uA1.z > 0.) { vec4 apF = wxAerial(d, 64.); sky = mix(sky, apF.rgb + sky * apF.a, uA1.z); }
            vec4 ci = SKY_NO_CI == 1 ? vec4(0., 0., 0., 1.) : cirrus(d, Tv), ac = SKY_NO_AC == 1 ? vec4(0., 0., 0., 1.) : altocu(d, Tv);
            /* the cirrus hides what is beyond it and the little of the sky's in-scatter above 9 km; the altocumulus the
               cirrus, what lies beyond, and some of the sky's in-scatter above 4 km */
            L += ((sky * (1. - .12 * (1. - ci.a)) * mix(1., ac.a, .35) + (back * ci.a + ci.rgb) * ac.a) + ac.rgb) * c.a;
          }
          /* [round 3] the flash: the cloud lit from inside round each channel, and the whole deck by the light the
             rain and haze scatter back (AMBIENT's diffuse share, which the amortized trace leaves out) */
          if (uFlash0.w + uFlash1.w > 0.) {
            L += flashVol(uFlash0, uFlash0b, d) + flashVol(uFlash1, uFlash1b, d);
            /* [round 4] the deck's diffuse share is taken where the ray meets the base (it was the eye's, one value over the
               whole deck: the night frame lit evenly grey, REVIEW-3 #3): the deck brightens round the strike and stays
               darker away from it, with wxFlashE's one falloff */
            float tb = d.y > .02 ? min((uWx0.z * 1e3 - wxEye) / d.y, 2e4) : 2e4;
            /* [round 5] the glow that diffuses through the deck round the strike (atmFlashDeck: a few km wide), not
               wxFlashE's falloff, which lit the whole deck grey at night (REVIEW-4 #4) */
            /* [round 5] on the base's relief (flashRelief): the flash's light on a deck read as a smooth gradient with no
               structure (E 11:04): the pouches' undersides dark, the seams and recesses lit, as in the night photographs */
            L += (1. - c.a) * atmFlashDeck(vec3(0., wxEye, 0.) + d * tb) / PI * .3 * .8 * uFlK.y * flashRelief(vec3(0., wxEye * 1e-3, 0.), d, tb * 1e-3);
          }
          o = vec4(wxGuard(L), 1.);
        }` });
      /* [round 3] REFL without the sun's disc (B's request): each tap less the disc the composite drew there (through
         the same cloud transmittance), so its coarse mips hold no block and the sea needs no cap round its image */
      P.down = R.program("sky.refl", { libs: ["atmo", "clouds"], fs: `
        in vec2 vUV; out vec4 o;
        vec3 tapNoSun(vec2 uv) {
          vec3 c = texture(sScene, uv).rgb;
          vec3 d = wxRay(uv);
          if (dot(d, uSun.xyz) > cos(uSun.w * 5.)) { float T = texture(sCloud, uv - uTaa.xy * uRes.zw).a; c = max(c - wxSunDisc(d) * T * smoothstep(.02, .25, T), vec3(0.)); }
          return c;
        }
        void main() {
          vec2 t = .5 * uRes.zw;
          vec3 c = tapNoSun(vUV + vec2(-t.x, -t.y)) + tapNoSun(vUV + vec2(t.x, -t.y)) + tapNoSun(vUV + vec2(-t.x, t.y)) + tapNoSun(vUV + vec2(t.x, t.y));
          o = vec4(wxGuard(c * .25), 1.);
        }` });
      /*@lab*/ yield* (R.priv.skyWaitMark || function* (w, ps) { yield* R.wait(...Object.values(ps)); })("sky", { composite: P.sky, refl: P.down }); /*@end*/
      yield* R.wait(P.sky, P.down);
      dummy = R.gpu.tex2D(1, 1, "rgba8", { filter: "nearest" });
    },
    slots: {
      sky(R) {
        const gl = R.gl;
        R.bind("scene");
        gl.clear(gl.DEPTH_BUFFER_BIT);
        const fv = R.priv.skyField;
        let flk = FLK; /*@lab*/ flk = [R.p("sky.sheet"), R.p("sky.flDiff"), R.p("sky.lump"), R.p("sky.glow")]; /*@end*/
        R.draw(P.sky, "scene", { uCirrus: R.priv.skyCirrus || dummy, uBase: fv ? fv.base : null, uWeather: fv ? fv.weather : null, uCS: [1, 1, 1, 1], uFlK: flk });
        /*@lab*/ if (!(R.p("sky.cut") & 8)) /*@end*/ R.draw(P.down, "refl");
        gl.activeTexture(gl.TEXTURE31);
        gl.bindTexture(gl.TEXTURE_2D, R.tex.REFL.tex);
        gl.generateMipmap(gl.TEXTURE_2D);
      },
    },
  };
})());
