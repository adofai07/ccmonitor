/* pane (stream C): the drops slot (CPU simulation, height map, wet film, condensation) and the "pane"
   and "paneview" GLSL: the view through the glass, which post's fused view program draws ([1.2] pane + post
   fused, contract section 4: no HDR target; the pane slot is empty).

   SIMULATION (render.md 11.1), in CSS px ([r8] 1 px = 0.41 mm of glass at the user's view: makeSim's header), y down, at
   fixed 120 Hz substeps (at most 6 a frame), seeded, no allocation per frame:
     arrivals   Poisson, rate(precip) x the onshore wind x the pane's area; log-normal radii
     beads      pinned; an arrival that touches beads merges with them (r^3 adds, centre by volume)
     sliders    a bead over the local critical radius rc x pin(x, y) runs ([r8] always: a slot is made for it): the
                static pinning field (.68-1.30 x rc, two rotated lattices of 23 and 8 px, which no longer park the drops
                in rows) makes it start, run and stop again; it meanders with a smooth noise of its own, leans with the
                wind in a storm, takes in every bead its head touches (a 16 px spatial hash), sheds beads behind, stamps
                its wet track (under a quarter of its width) into the film, and leaves at the bottom. A slider at rest
                for 0.25 s is its bead again ([r8] always)
     shrink     in rain the slow loss the steady state needs; once dry a drop flattens, then shrinks ([r8]: shrink())
     caps       knobs.beads, knobs.sliders: past the bead cap an arrival that touches nothing is not simulated ([r3]);
                [r8] a runner's trail may pass the cap by TRAIL, a runner at rest always becomes its bead
   A still (and the first frame) runs it ([r8] 90 s) ahead in one go; the last 30 s of tracks seed the film.
   HEIGHT MAP  R16F at max(CSS, S) px (<= 2048 wide) holding exp(h), h in CSS px: MAX blending keeps the
     order, and fp16 then keeps h to 1e-3 px everywhere (stored plainly, a 5 px dome kept 4e-3 px, and
     its forward-difference slopes banded the image inside a big drop). Procedural micro-drops (two cell
     layers whose lives divide the 240 s rain clock, wiped where the film is fresh), then every bead as a
     spherical cap of contact angle 60 deg ([r3]; [r8] flatter as it dries) and every running drop as a head and a tail: the head a cap a
     little wider than long, its dome leaning forward; behind it a narrow rounded rivulet that thins and
     flattens over 0.8-3.4 r.
   FILM  R16F at C/2: each frame times exp(-dt / pane.filmTau) ([r9f] 3 s, round 9 12 s), then the running drops' tracks,
     a rivulet's section (MAX). The view reads it as a water ridge of uFilmPx.z CSS px: a wet track refracts,
     so it shows as a thin line that bends the view, and drains within seconds unless runners keep feeding it.
   MIST  RG16F at C/4, ping-pong, on the inside of the glass: r eases toward
     F* = smooth(thr(x) - .25, thr(x) + .05, mist) x nucleation(x) (the edges first) with tau 6 s in
     and 4 s out, under the walked uWx3.x; g is the clear track of an inside run (1 at the run, decays
     with tau 25 s). Runs: once the mist passes .7, one drop forms and runs every 30-90 s.
   VIEW (the library's paneView)  SCENE (scaled by post's flash limit map, the far rain curtains over
     it), refracted through the drops and the tracks: a drop is a plano-convex lens, so its image is the
     world inverted and shrunk (deflection asin(1.33 sin a) - a toward the drop's centre), sampled from
     the down pyramid at the LOD its own minification asks; Fresnel, and total internal reflection past
     48.75 deg, darken the rim. In the storm a sheet of water streams down. The mist on top: the scene
     blurred and lifted, a faint speckle. */
WX.lib("pane", `
uniform sampler2D uH, uFilm, uMist, uDown, uUp, uLimK;
uniform vec4 uMapPx;            // xy height-map px per CSS px, zw 1 / height-map size
uniform vec4 uFilmPx;           // xy 1 / film size, z the wet track's ridge height CSS px
uniform vec4 uOn;               // x drops on the glass, y the film, z the mist, w post's flash limit map
uniform float uLev, uSheet, uSheetLean;     // [r3] the sheet's slant with the wind along the glass (dx / dy)
uniform vec4 uGlass;            // [r4] xy the glass in its own px (the CSS size / pane.glass scale: a small view shows the same
                                // window, so its drops are smaller on screen), z glass px per CSS px
uniform vec4 uLampP;            // [L r9] the lighthouse's lamp: xy its uv (y up), w 1 while post grades its light (night)
/* [L r9] (stream L's part of this file: the lamp's glare on the glass) the local contrast in heavy rain (uTone.w) divides by
   the 16 px-scale mean, and round the lighthouse's lamp that mean is the lamp's own core (1e4-1e5 pre-exposed px^2 at
   night): the ratio sat at its .3 floor over every texel the lamp reaches, a square ~70 px across 30 % darker round the
   lamp in every night storm, and a dark ring round its flash. Within .035-.06 of the view's height of the lamp the
   contrast fades out: there it is the lamp's halo, not the storm's murk. 1 by day and with no lighthouse */
float paneLampClear(vec2 uv) {
  if (uLampP.w < .5) return 1.;
  return smoothstep(.035, .06, length((uv - uLampP.xy) * vec2(uRes.x / uRes.y, 1.)));
}
/* the height map holds exp(h) */
float paneH(vec2 uv) { return log(max(texture(uH, uv).r, 1.)); }
float paneMist(vec2 uv) { if (uOn.z < .5) return 0.; vec2 m = texture(uMist, uv).rg; return clamp(m.r * (1. - m.g), 0., 1.); }
/* smooth value noise from the rain's noise texture (rainfar's uRainNoise), one tap: period 64 */
float paneSn(vec2 p) { vec2 i = floor(p), f = fract(p); return texture(uRainNoise, (i + f * f * (3. - 2. * f) + .5) / 64.).r; }
/* [r3] what a drop refracts: the picture, and past its top edge the sky above the window, which the frame never
   shows. Rain comes from overcast, whose luminance grows toward the zenith (CIE: (1 + 2 sin el) / 3), so the
   top row is carried on with that gradation: a bead holds the brighter sky overhead in its lower half and the
   darker sea or land below in its upper half, as every photograph of rain on a window shows */
vec3 paneWorld(vec2 uv, float lod) {
  vec3 c = textureLod(uDown, clamp(uv, vec2(.002), vec2(.998)), lod).rgb;
  if (uv.y > 1.) c *= (1. + 2. * sin(atan(min(2. * uv.y - 1., 6.) * uCamY.w))) / (1. + 2. * sin(atan(uCamY.w)));
  return c;
}
`);
/* paneView takes derivatives, which a vertex shader may not: it is no library (libraries go into both
   stages); post puts WX.libs.paneview into its fragment shaders, after the "rainfar" and "pane" libraries */
WX.lib("paneview", `
/* the view through the glass at scene uv, pre-exposed. fixLod >= 0: the drops' image at that level (no
   derivatives: for a loop of taps). cover: the drops' coverage; mistF: the mist */
vec3 paneView(vec2 uv, float fixLod, out float cover, out float mistF) {
  vec2 cssPx = uv * uGlass.xy, e = uMapPx.zw, a = vec2(uGlass.x / uGlass.y, 1.);
  vec2 warp = vec2(0.);
  /* the sheet's own coordinates: sheared with the wind, so a storm's streams run diagonally (y up here, so a
     drop running right as it falls moves +x as y falls) */
  vec2 shp = vec2(cssPx.x + uSheetLean * cssPx.y, cssPx.y), shuv = shp / uGlass.xy;
  float sheet = 0., sheetEdge = 0.;
  if (uSheet > 0.) {
    /* a sheet of water streaming down: channels a few mm wide and long, sliding down by whole periods of
       their noise per 240 s; their sideways slope shifts the view sideways (a ribbed-glass look) */
    /* where it flows: fixed paths on the glass. The noise is the rain's 64 x 64 texture read with a smooth
       (C1) single tap; the streaming moves whole periods of it per 240 s (1 and 2 periods of 64 cells) */
    float m = paneSn(vec2(shuv.x * a.x * 3.3 + 1.7, shuv.y * 1.2 + 9.));
    /* [r9] more of it lower down: the water of the whole pane above runs over the lower glass (uv.y is up), where the runs
       have merged into sheets; the upper glass holds beads */
    sheet = uSheet * smoothstep(.25, .7, m + .12 - .3 * smoothstep(.15, .85, uv.y));
    if (sheet > .001) {
      vec2 sp = shp / vec2(14., 110.);
      float y1 = sp.y + uTime.y * 64. / 240., y2 = sp.y * 1.7 + uTime.y * 128. / 240., e1 = .05;
      float h0 = paneSn(vec2(sp.x, y1)) + .5 * paneSn(vec2(sp.x * 2.3 + 5., y2 + 31.));
      float hx = paneSn(vec2(sp.x + e1, y1)) + .5 * paneSn(vec2((sp.x + e1) * 2.3 + 5., y2 + 31.));
      float dhx = (hx - h0) / (e1 * 14.);
      warp = vec2(dhx * 50., 0.) * sheet / uGlass.x * uC0.x;
      sheetEdge = sheet * smoothstep(.04, .12, abs(dhx));
    }
  }
  /* the drops' height and slope (forward differences, d(h)/d(CSS px)), and the wet tracks' ridge */
  float h = 0., film = 0., edge = 0.;
  vec2 g = vec2(0.);
  if (uOn.x > .5) {
    h = paneH(uv);
    g = vec2(paneH(uv + vec2(e.x, 0.)) - h, paneH(uv + vec2(0., e.y)) - h) * uMapPx.xy;
  }
  cover = smoothstep(0., .06, h);
  float hb = h;                                                    // [r5] the beads' own height (the film's tracks come next)
  if (uOn.y > .5) {
    film = texture(uFilm, uv).r;
    if (film > .002) {
      float fx = texture(uFilm, uv + vec2(uFilmPx.x, 0.)).r, fy = texture(uFilm, uv + vec2(0., uFilmPx.y)).r;
      vec2 gf = vec2(fx - film, fy - film);
      g += gf * uFilmPx.z * .5;                                    // the film's texel is 2 CSS px
      h += film * uFilmPx.z;
      /* a rivulet's sides are steeper than the film's texels can hold: there Fresnel and total internal
         reflection turn the view dark, the thin outline every wet track shows. [r8] Only a channel still carrying water
         (film over ~.4): with every drop over its size now running, a storm's glass was ruled with pairs of dark lines
         (each track's two flanks: out/P/a2/u96-f600-x3.jpg); a single run's thin film, or an old track, only bends the view */
      edge = smoothstep(.2, .6, length(gf)) * smoothstep(.35, .9, film) * .6;   // an older track: fainter
    }
  }
  /* a lens: tilt a, the ray bends by asin(1.33 sin a) - a toward the drop's centre (up the slope); computed
     everywhere (0 outside drops) so the derivatives stay in uniform control flow */
  float sl = length(g);
  float sa = sl / sqrt(1. + sl * sl), st = 1.33 * sa;
  vec2 gd = sl > 1e-5 ? g / sl : vec2(0.);
  float tA = min(st, .998) / sqrt(1. - min(st * st, .996));
  float tD = min((tA - sl) / (1. + tA * sl), 2.6);
  vec2 uvr = uv + gd * tD * vec2(.5 / uCamX.w, .5 / uCamY.w) * uC0.x;
  float lod = fixLod;
  if (fixLod < 0.) {
    vec2 dx = dFdx(uvr) * uRes.xy, dy = dFdy(uvr) * uRes.xy;
    lod = clamp(log2(max(max(length(dx), length(dy)), 1.)) - .5 + uC0.z, 0., uLev);
  }
  vec3 outside = texture(sScene, uv + warp).rgb;
  /* with TAA the resolved picture carries the jitter's 1 px box blur: sharpen it back a little */
  if (uTaa1.x > .5 && uC0.w > 0.) {
    vec2 t = uRes.zw;
    vec3 nb = texture(sScene, uv + warp + vec2(t.x, 0.)).rgb + texture(sScene, uv + warp - vec2(t.x, 0.)).rgb
            + texture(sScene, uv + warp + vec2(0., t.y)).rgb + texture(sScene, uv + warp - vec2(0., t.y)).rgb;
    outside = max(outside + uC0.w * (outside - .25 * nb), outside * .5);
  }
  /* [r3] local contrast in heavy rain (grade's uTone.w): the air flattens what lies behind it; a little of the
     16 px-scale relief is given back, as a photographer's clarity, so the storm is not featureless murk */
  if (uTone.w > 0.) {
    float Yo = wxLuma(outside), Yl = wxLuma(textureLod(uDown, uv + warp, min(3., uLev)).rgb);
    outside *= pow(clamp((Yo + 1e-5) / (Yl + 1e-5), .3, 3.), uTone.w * paneLampClear(uv));   // [L r9] not round the lamp
  }
  /* [r3] the flash limit on the scene (the area light), then the channels on top of it, sharp */
  if (uOn.w > .5) outside *= texture(uLimK, uv + warp).r;
  /* [r4] and the light round them (the halo). [r5] Through the storm's streaming sheet the channel moves by a fifth of the
     scene's warp: a stream ~14 px wide shifted the whole picture by up to ~40 px, and the white channel's shifted copy ran
     down the stream beside the bolt as a second channel (REVIEW-4 g-cg f181; C's cgday f50); a few px of wiggle stays */
  vec2 bw = uv + .2 * warp;
  outside += boltChan(bw) + boltHalo(bw, 0., 0.);
  outside = rainCurtain(outside, uv + warp);
  vec3 c = outside;
  if (h > 1e-3) {
    vec3 wimg = paneWorld(uvr, lod);
    float wb = smoothstep(.03, .2, hb);                             // a bead (1) or only a wet track (0)
    /* [r6] a wet track refracts the scene, never the lightning channel (REVIEW-5 g-cg f181-185). The down pyramid the drops
       read holds the channel (post adds it at level 0 for the bloom), and a track's edge, bending the view ~45 px sideways,
       imaged it along the track's whole length: a thin bright line beside the bolt, a second channel (on the shipped build
       with the drops' halo off it stayed; with the tracks' ridge off it went). While a channel is drawn, what a track
       shows is held to 1.25 x the brightest of the channel-free scene round the point it sees (five taps over the lod's
       texel, through the flash limit): the glow round the bolt still shows in it, the channel does not. Beads keep it */
    if (uBoltOn.x > .5 && wb < .999) {
      vec2 o = exp2(lod) * uRes.zw, q = clamp(uvr, vec2(.002), vec2(.998));
      float Ys = max(max(wxLuma(texture(sScene, q).rgb), wxLuma(texture(sScene, q + o).rgb)), max(max(wxLuma(texture(sScene, q - o).rgb),
                 wxLuma(texture(sScene, q + vec2(o.x, -o.y)).rgb)), wxLuma(texture(sScene, q - vec2(o.x, -o.y)).rgb)));
      if (uOn.w > .5) Ys *= texture(uLimK, q).r;
      if (uvr.y > 1.) Ys *= (1. + 2. * sin(atan(min(2. * uvr.y - 1., 6.) * uCamY.w))) / (1. + 2. * sin(atan(uCamY.w)));   // paneWorld's sky overhead
      float Yw = wxLuma(wimg);
      wimg *= mix(min(1., (1.25 * Ys + 1e-5) / max(Yw, 1e-6)), 1., wb);
    }
    /* [r4] a lightning channel in the bead's field: its halo's energy at the bead's own minification (S/4's level).
       [r5] Beads only: a wet track is a long thin lens, and with the drops' gain it imaged the halo along its whole length,
       a second channel beside the bolt (REVIEW-4 g-cg f181); a track shows the glass's own halo, as the dry glass beside it */
    vec3 img = wimg + mix(boltHalo(bw, 0., 0.), boltHalo(uvr, max(lod - 2., 0.), 1.), wb);
    /* Fresnel out of the water (Schlick on the transmitted angle), the rim's total internal reflection */
    float ct = sqrt(max(1. - st * st, 0.)), Rf = .02 + .98 * pow(1. - ct, 5.);
    vec3 dark = textureLod(uDown, uv, uLev * .6).rgb * .22;
    vec3 thru = img * (1. - Rf) + dark * Rf;
    /* the outer ring sees past the screen and, at grazing exit, the room's dark: the outline every real
       drop has against a bright sky (render.md 11.3) */
    /* [r3] firmer: real beads show an outline about a fifth of their radius wide (steeper contact lines on
       dirty glass and the eye's own blur); a 1-2 px bead read as nothing with the thin physical ring */
    /* [r9] a bead's (its contact line, 60 deg); a rivulet's 40 deg edges bend the view without going dark (a wet track alone:
       hb = 0 exactly) */
    /* [r9] darker and wider, as win-gondola's beads at 1:1 (a black outline over a third of a bead, its bright refracted sky
       below): the room the rim's total internal reflection shows is a tenth of the day outside, not a third (round 8's rims
       were 12 % and 40 % darker than the view: at 1-3 px a bead read as a faint grey dot, REVIEW-8 #5) */
    thru = mix(thru, dark * .9, smoothstep(.43, .7, sa) * .72 * smoothstep(0., .02, hb));
    thru = mix(thru, dark * .4, smoothstep(.95, 1.02, st));
    c = mix(outside, thru, smoothstep(0., .06, h));
    /*@lab*/ if (uC0.y > .5) return uC0.y < 1.5 ? vec3(uvr, 0.) : uC0.y < 2.5 ? vec3(g * .5 + .5, 0.) : vec3(lod / uLev); /*@end*/
  }
  /* the film darkens a little, the sheet a little more and catches the sky */
  c *= 1. - .03 * film - .02 * sheet - .05 * sheetEdge - .06 * edge;
  /* the mist, inside: the scene blurred and lifted, the drops behind it blurred away */
  mistF = paneMist(uv);
  if (mistF > .002) {
    vec3 b = textureLod(uDown, uv, 2.2).rgb * .82 + .3 * textureLod(uUp, uv, 1.).rgb;
    b = b * .85 + .12 * wxLuma(b);
    float sp = wxHash12(floor(cssPx * 1.7)) * wxHash12(floor(cssPx * 1.7) + 3.7);
    b *= 1. + .35 * mistF * (sp * sp * 2. - .3);
    c = mix(c, b, pow(mistF, .8));
  }
  return wxGuard(c);
}
`);
WX.pass((function () {
  const D = Math.PI / 180;
  WX.param("pane.rate", 420, 0, 1500, 5, "pane");       // arrivals per s per Mpx at precip 1, wind factor 1 ([r8] 640: with the
                                                        // critical size real (a third of round 7's volume) twice the drops ran;
                                                        // 420 with the smaller arrivals of envOf)
  WX.param("pane.rc", 5.6, 3, 20, 0.1, "pane");         // [r8] critical radius px (1 px = 0.41 mm: 2.3 mm, makeSim's header)
  WX.param("pane.rmax", 7.3, 3, 20, 0.1, "pane");       // [r8] no pinned bead is wider (3.0 mm: ~6 mm across)
  WX.param("pane.refr", 1, 0, 2, 0.05, "pane");         // refraction strength (1 = physical)
  WX.param("pane.micro", 1, 0, 2, 0.05, "pane");        // micro-drop density
  WX.param("pane.lodBias", -2, -4, 4, 0.25, "pane");
  WX.param("pane.track", 1.0, 0, 3, 0.05, "pane");      // the wet track's ridge height, CSS px
  WX.param("pane.sharpen", 0.3, 0, 1, 0.05, "pane");    // the view's sharpening of the TAA-resolved picture
  WX.param("pane.sheet", 1, 0, 2, 0.05, "pane");        // the storm's streaming sheet
  WX.param("pane.microFine", 3, 0, 5, 1, "pane");       // [r3] the lowest tier that draws the finest micro-bead layer
  WX.param("pane.glass", 0.6, 0.3, 1, 0.05, "pane");    // [r4] the drops' smallest scale on a small view (a phone); 1 = CSS px everywhere
  WX.param("pane.filmTau", 3, 0.5, 20, 0.25, "pane");   // [r9f] in a storm the wet tracks' water drains with this tau, s (round 9: 12)
  WX.param("pane.filmTauCalm", 12, 0.5, 20, 0.25, "pane");   // [r9f] and in rain without a storm (round 9's)
  WX.param("pane.l2", 1, 0, 1.25, 0.05, "pane");        // [r9f] the 8 px micro layer's share of the density (round 9: .8)
  WX.param("pane.pathAge", 1, 0, 3, 0.25, "pane");      // [r9f] how fast a path in use for over 8 s stops drawing the runs (0: round 9)
  WX.param("pane.rimFix", 1, 0, 1, 1, "pane");          // [r9f] a small drop's height restored to its rim's slope at the map's texel
  WX.param("pane.lampKeep", 4, 0, 12, 0.5, "pane");     // [r9f] no micro-drop's edge within this many glass px of the lighthouse's lamp (0: off)
  const Cg = [1280, 820], glassU = new Float32Array([1280, 820, 1, 0]);
  /*@lab*/ WX.param("pane.debug", 0, 0, 3, 1, "pane"); /*@end*/   // lab: 1 the refracted uv, 2 the slope, 3 the lod

  /* ════════════════ the simulation (no GL; Node can run it: the pass's .makeSim) ════════════════ */
  /* [r8] REAL SIZES. The glass is 0.5 m from the eye, and the view's 50 deg spans the user's 1150 CSS px tall view, so 1 CSS px
     is 2 x 0.5 m x tan 25 deg / 1150 = 0.41 mm of glass (DESIGN's 0.26 mm put the eye 0.32 m from it; round 3's "0.4-0.45 mm"
     is this at 1150-1080 px tall; the glass keeps CSS px on views from 1280 x 820 up, so a taller view reads a little farther).
     Water starts to run down vertical glass when its weight passes what contact-angle hysteresis holds (Furmidge):
     rho g V = k gamma 2a (cos thR - cos thA), with V = 0.79 a^3 for a ~50 deg cap of contact radius a, so
     a_c^2 = 2 k gamma dcos / (0.79 rho g). Ordinary window glass: gamma .072 N/m, k .8-1, dcos .25-.40 (advancing 55-60 deg,
     receding 20-30 deg): a_c = 1.9-2.7 mm, about 2.3 mm = 5.6 px (pane.rc). Its dirt and scratches spread that .68-1.30x, and
     nothing pinned is ever over 3.0 mm (pane.rmax 7.3 px): a bead is at most ~6 mm across. A drop over its critical size
     always runs: the runners' cap is the tier's (40-300), and a slot goes to it before anything else (round 7's 4 + 14 x precip
     per Mpx left hundreds of over-critical beads pinned in a storm, growing to 10.5 px). Raindrops of 0.5-2.5 mm land as
     beads of contact radius 0.4-2.0 mm (log-normal round 1.9 px, 1.5 in a storm's spray, sigma .45, at most 5 px: envOf).
     NOTHING BLINKS OUT ([r8], the user: "the drops suddenly disappear instead of dropping down"). A drop leaves the glass only
     by running (the same drop, as big, starting slowly, speeding up as it takes in what lies in its path, shedding a trail of
     small ones), by being swept up by a runner, by merging, off the bottom edge, or by drying: after the rain it flattens in
     place (its lens and rim fade) and then its contact line recedes, over 16 + 7a s (a in px; [r9] 12 + 7a). Round 7 had a runner that came
     to rest vanish whenever the bead store was full (in rain it always was): 1.3-5 of the pane's biggest drops a second. */
  function makeSim(seed) {
    const NB = 6600, NS = 330, NT = 4096;
    const bx = new Float32Array(NB), by = new Float32Array(NB), br = new Float32Array(NB);
    /* [r3] a bead's contact line stays where a merge left it: elongation (0 round .. .4, [r3c]) along an angle */
    const be = new Float32Array(NB), bth = new Float32Array(NB);
    /* [r8] bf: the bead's height, 1 for the 60 deg cap, down to FR as it dries (its volume is br^3 bf); bm: over its critical
       size but no runner slot was free (it starts as soon as one is) */
    const bf = new Float32Array(NB), bm = new Uint8Array(NB);
    const sx = new Float32Array(NS), sy = new Float32Array(NS), sr = new Float32Array(NS), sv = new Float32Array(NS);
    const svx = new Float32Array(NS), sdir = new Float32Array(NS * 2), sshed = new Float32Array(NS), sgap = new Float32Array(NS);
    const srest = new Float32Array(NS), sph = new Float32Array(NS), spx = new Float32Array(NS), spy = new Float32Array(NS);
    const swet = new Float32Array(NS), tw = new Float32Array(NT);      // [r3] how wet the path ahead was; a track's weight
    const smp = new Float32Array(NS);                                 // [r9] the meander's phase: the way run over its wavelength
    const next = new Int32Array(NB);
    let head = new Int32Array(1), gw = 1, gh = 1, nb = 0, ns = 0, W = 1280, H = 820, t = 0, nextArr = 0, acc = 0;
    const CELL = 16;
    /* [r8] FR: the receding angle's share of the cap's height (~22 of 60 deg); KV: a runner's speed per its weight over what the
       receding line holds, v = KV (r^3 - rm^3) / rm^2 px/s; VMAX 200 px/s (8 cm/s); RW: a runner's head is never wider than
       this (px), more water makes it longer, not wider */
    const FR = 0.35, KV = 3, VMAX = 200, RW = 6.6;
    /* [r8] how far a runner's trail may take the beads past their cap (a full pane still gets its trails; 200, not more: the spare
       fills while the pane first wets and then drains slowly, and with 400 a heavy rain took ~3 min to settle) */
    const TRAIL = 200;
    /*@lab*/
    /* how every drop left the glass, for tests/pane/r8 (no allocation once the keys exist) */
    const EX = {};
    const ex = (k, r) => { const e = EX[k] || (EX[k] = { n: 0, big: 0, rmax: 0 }); e.n++; if (r >= 1.5) e.big++; if (r > e.rmax) e.rmax = r; };
    /*@end*/
    /* [r3] the wet channels: when a running drop last crossed each 4 px cell. Water runs where water ran (a wet
       path pins less and draws the next drops in), so the runs gather into a few long rivulets that merge and
       branch. Read as exp(-age / 30 s), so nothing has to decay per step */
    const WC = 4, WTAU = 30;
    /* [r9f] A PATH TIRES. wet0: when the cell's present wet spell began (a crossing after WGAP s dry starts a new one). A path
       in use for longer than WHOLD s draws less (its pull falls with tau WFT): in a gale the flow re-routes as the gusts and
       the arriving drops move it, and no channel is fed in one place for half a minute (REVIEW-9 2.3: one lay over the
       lighthouse's lamp for a whole clip). env.age 0 is round 9's (a path draws for as long as it is wet) */
    const WGAP = 6, WHOLD = 8, WFT = 3;
    let ww = 1, wh = 1, wetT = new Float32Array(1).fill(-1e9), wet0 = new Float32Array(1).fill(-1e9);
    function wetAt(x, y) {
      const ix = Math.floor(x / WC), iy = Math.floor(y / WC);
      if (ix < 0 || iy < 0 || ix >= ww || iy >= wh) return 0;
      const k = iy * ww + ix, a = t - wetT[k];
      const w = a <= 0 ? 1 : a > 150 ? 0 : Math.exp(-a / WTAU);
      const u = t - wet0[k] - WHOLD;
      return u > 0 && env.age > 0 ? w * Math.exp(-u * env.age / WFT) : w;
    }
    function wetMark(x, y, r) {
      const x0 = Math.max(0, Math.floor((x - r) / WC)), x1 = Math.min(ww - 1, Math.floor((x + r) / WC));
      const y0 = Math.max(0, Math.floor((y - r) / WC)), y1 = Math.min(wh - 1, Math.floor((y + r) / WC));
      for (let iy = y0; iy <= y1; iy++) for (let ix = x0; ix <= x1; ix++) { const k = iy * ww + ix; if (t - wetT[k] > WGAP) wet0[k] = t; wetT[k] = t; }
    }
    /* tracks for the film: (x0, y0, x1, y1, width, value) */
    const tracks = new Float32Array(NT * 6); let nt = 0;
    let recording = false, recT = 0;
    /* sfc32 */
    let a = seed >>> 0, b = 0x9e3779b9, c = 0x243f6a88, d = 0xb7e15162;
    function rnd() {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let t0 = (a + b) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); d = (d + 1) | 0; t0 = (t0 + d) | 0; c = (c + t0) | 0;
      return (t0 >>> 0) / 4294967296;
    }
    for (let k = 0; k < 12; k++) rnd();
    function gauss() { return Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(6.283185307 * rnd()); }
    /* static value noise on a 20 px lattice (the glass's pinning: dirt, scratches, dried film) */
    function hash2(ix, iy) {
      let h = (ix * 374761393 + iy * 668265263 + seed * 2246822519) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
      return (h >>> 0) / 4294967296;
    }
    function vnoise(x, y) {
      const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
      const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
      const v00 = hash2(ix, iy), v10 = hash2(ix + 1, iy), v01 = hash2(ix, iy + 1), v11 = hash2(ix + 1, iy + 1);
      return v00 + (v10 - v00) * ux + (v01 - v00) * uy + (v00 - v10 - v01 + v11) * ux * uy;
    }
    /* rotated lattices of incommensurate sizes: a single 20 px lattice parked the sliders in rows. [r8] .68-1.30 of pane.rc
       (round 7 .62-1.48 of 8 px: pinned beads up to 11.8 px, 4.8 mm) */
    const pin = (x, y) => 0.68 + 0.62 * (0.6 * vnoise((x * 0.80 + y * 0.60) / 23, (y * 0.80 - x * 0.60) / 23)
      + 0.4 * vnoise((x * 0.34 - y * 0.94) / 8.3 + 31.7, (y * 0.34 + x * 0.94) / 8.3 + 11.3));
    function resize(w, h) {
      w = Math.max(16, w); h = Math.max(16, h);
      if (w !== W || h !== H) {
        const kx = w / W, ky = h / H;
        for (let i = 0; i < nb; i++) { bx[i] *= kx; by[i] *= ky; }
        for (let i = 0; i < ns; i++) { sx[i] *= kx; sy[i] *= ky; spx[i] *= kx; spy[i] *= ky; }
      }
      W = w; H = h;
      gw = Math.ceil(W / CELL) + 2; gh = Math.ceil(H / CELL) + 2;
      if (ww !== Math.ceil(W / WC) || wh !== Math.ceil(H / WC)) { ww = Math.ceil(W / WC); wh = Math.ceil(H / WC); wetT = new Float32Array(ww * wh).fill(-1e9); wet0 = new Float32Array(ww * wh).fill(-1e9); }
      if (head.length < gw * gh) head = new Int32Array(gw * gh);
      rebuild();
    }
    function cellOf(x, y) {
      const cx = Math.min(gw - 1, Math.max(0, Math.floor(x / CELL) + 1)), cy = Math.min(gh - 1, Math.max(0, Math.floor(y / CELL) + 1));
      return cy * gw + cx;
    }
    function link(i) { const k = cellOf(bx[i], by[i]); next[i] = head[k]; head[k] = i; }
    /* drop the dead (r = 0), then hash the living. [r8] A bead waiting for a runner slot (bm) starts when one is free */
    function rebuild() {
      let j = 0;
      for (let i = 0; i < nb; i++) if (br[i] > 0) {
        if (bm[i] && ns < Math.min(env.capS, NS)) {
          if (br[i] > rcl(bx[i], by[i])) { /*@lab*/ ex("toRunner", br[i]); /*@end*/ addSlider(bx[i], by[i], Math.cbrt(br[i] * br[i] * br[i] * bf[i])); continue; }
          bm[i] = 0;
        }
        bx[j] = bx[i]; by[j] = by[i]; br[j] = br[i]; be[j] = be[i]; bth[j] = bth[i]; bf[j] = bf[i]; bm[j] = bm[i]; j++;
      }
      nb = j; live = j;
      head.fill(-1, 0, gw * gh);
      for (let i = 0; i < nb; i++) link(i);
    }
    let live = 0;
    /* [r3] a full pane culls nothing: a bead stays until it dries, merges or is swept (a clip showed round 2's cull
       turning the whole population over every few seconds: beads popping everywhere). Past the cap an arrival
       that touches nothing is left to the micro-beads' layer (it is never drawn: nothing pops).
       [r8] lim: how many beads this addition may fill the store to: arrivals stop at the cap, a runner's trail may pass it by
       TRAIL, and a runner coming to rest always becomes its bead (up to the store's size) */
    function addBead(x, y, r, e, th, lim) {
      if (live >= lim || nb >= NB) return -1;
      live++;
      bx[nb] = x; by[nb] = y; br[nb] = r; be[nb] = e || 0; bth[nb] = th === undefined ? rnd() * 3.1416 : th; bf[nb] = 1; bm[nb] = 0; link(nb);
      return nb++;
    }
    /* [r8] the critical radius where (x, y) is: the glass's pinning there, less on a wet path and on streaming glass, never over
       rmax (3 mm) */
    function rcl(x, y) { return Math.min(env.rmax, env.rc * env.rcK * pin(x, y) * (1 - 0.35 * wetAt(x, y))); }
    function addSlider(x, y, r) {
      if (ns >= NS) return false;
      sx[ns] = x; sy[ns] = y; sr[ns] = r; sv[ns] = 0; svx[ns] = 0; sdir[ns * 2] = 0; sdir[ns * 2 + 1] = 1;
      sshed[ns] = 0; sgap[ns] = 2 + 4 * rnd(); srest[ns] = 0; sph[ns] = rnd() * 100; spx[ns] = x; spy[ns] = y; swet[ns] = 0; smp[ns] = 0;
      ns++;
      return true;
    }
    function killSlider(i) {
      ns--;
      if (i !== ns) {
        sx[i] = sx[ns]; sy[i] = sy[ns]; sr[i] = sr[ns]; sv[i] = sv[ns]; svx[i] = svx[ns]; swet[i] = swet[ns];
        sdir[i * 2] = sdir[ns * 2]; sdir[i * 2 + 1] = sdir[ns * 2 + 1]; sshed[i] = sshed[ns]; sgap[i] = sgap[ns];
        srest[i] = srest[ns]; sph[i] = sph[ns]; spx[i] = spx[ns]; spy[i] = spy[ns]; smp[i] = smp[ns];
      }
    }
    /* [r8] a runner at rest is a bead again, the same drop where it stopped (it moves < 2 px/s, so where fill() drew it last),
       elongated along its way. Only a full store (NB) can refuse it: then it stays a runner at rest and asks again */
    function toBead(i) {
      if (addBead(sx[i], sy[i], Math.min(sr[i], env.rmax), 0.25, Math.atan2(sdir[i * 2 + 1], sdir[i * 2]), NB) < 0) return false;
      /*@lab*/ ex("toBead", sr[i]); /*@end*/
      killSlider(i);
      return true;
    }
    /* [r8] a drop over its critical size runs. If every runner slot is taken, the runner at rest the longest gives its slot
       back (it is a bead again); with none at rest the drop waits pinned (bm) and starts at the next substep a slot is free */
    function startRunner(x, y, r) {
      if (ns >= Math.min(env.capS, NS)) {
        let j = -1, best = 0.04;
        for (let i = 0; i < ns; i++) if (srest[i] > best) { best = srest[i]; j = i; }
        if (j < 0 || !toBead(j)) return false;
      }
      /*@lab*/ ex("toRunner", r); /*@end*/
      return addSlider(x, y, r);
    }
    /* merge everything that touches the drop at (x, y, r); returns the new radius in m3 and the centre, and
       [r3] the elongation the merge leaves: the contact line stays pinned where both drops were. [r8] Volumes are br^3 bf
       (a drying bead is flatter). The merged drop keeps at least the widest contact line it took in (a flattened bead that
       is hit grows taller in place, it does not shrink onto its volume): r = max(cbrt V, that), f = V / r^3; v the volume
       radius cbrt V */
    const M = { x: 0, y: 0, r: 0, e: 0, th: 0, f: 1, v: 0 };
    function mergeAt(x, y, r, skip) {
      let V = r * r * r, mx = x * V, my = y * V, vb = 0, ex0 = 0, ey0 = 0, aw = r;
      for (let pass = 0; pass < 3; pass++) {
        const R0 = Math.cbrt(V), cx = mx / V, cy = my / V, reach = R0 + 12;
        const x0 = Math.floor((cx - reach) / CELL) + 1, x1 = Math.floor((cx + reach) / CELL) + 1;
        const y0 = Math.floor((cy - reach) / CELL) + 1, y1 = Math.floor((cy + reach) / CELL) + 1;
        let any = false;
        for (let gy = Math.max(0, y0); gy <= Math.min(gh - 1, y1); gy++) for (let gx = Math.max(0, x0); gx <= Math.min(gw - 1, x1); gx++) {
          for (let i = head[gy * gw + gx]; i >= 0; i = next[i]) {
            if (i === skip || br[i] <= 0) continue;
            const dx = bx[i] - cx, dy = by[i] - cy, rr = br[i] + R0;
            if (dx * dx + dy * dy < rr * rr * 0.81) {
              const v = br[i] * br[i] * br[i] * bf[i];
              if (v > vb) { vb = v; ex0 = bx[i] - x; ey0 = by[i] - y; }
              if (br[i] > aw) aw = br[i];
              /*@lab*/ ex("merged", br[i]); /*@end*/
              V += v; mx += bx[i] * v; my += by[i] * v; br[i] = 0; live--; any = true;
            }
          }
        }
        if (!any) break;
      }
      M.x = mx / V; M.y = my / V; M.v = Math.cbrt(V); M.r = Math.max(M.v, aw); M.f = V / (M.r * M.r * M.r);
      const d = Math.hypot(ex0, ey0);
      /* [r3c] at most 0.4 (aspect 1.4; 0.7 left the storm pane a field of slugs next to win-gondola's round beads) */
      M.e = vb > 0 ? Math.min(0.4, 0.35 * d / M.r) : 0.08 * rnd(); M.th = vb > 0 ? Math.atan2(ey0, ex0) : rnd() * 3.1416;
      return M;
    }
    /* [r3] smaller drops: log-normal arrivals, so the pane holds many small beads and few big ones ([r8] the scale and the
       sizes: makeSim's header); lean: the wind's push along the glass, spread: the outflow from the wind's stagnation
       point (at stag of the width), which sends the runs diagonally in a storm */
    /* does a drop at (x, y, r) touch a bead (the merge test) */
    function touches(x, y, r) {
      const reach = r + 12, x0 = Math.max(0, Math.floor((x - reach) / CELL) + 1), x1 = Math.min(gw - 1, Math.floor((x + reach) / CELL) + 1);
      const y0 = Math.max(0, Math.floor((y - reach) / CELL) + 1), y1 = Math.min(gh - 1, Math.floor((y + reach) / CELL) + 1);
      for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) for (let i = head[gy * gw + gx]; i >= 0; i = next[i]) {
        if (br[i] <= 0) continue;
        const dx = bx[i] - x, dy = by[i] - y, rr = br[i] + r;
        if (dx * dx + dy * dy < rr * rr * 0.81) return true;
      }
      return false;
    }
    const env = { precip: 0, wind: 1, lean: 0, spread: 0, stag: 0.35, dry: 0, capB: 3000, capS: 150, rate: 400, rc: 5.6, rmax: 7.3, rcK: 1, rmed: 2.0, sig: 0.55, amax: 5, slick: 1, storm: 0, filmTau: 3, age: 1 };
    function arrive() {
      let r = Math.exp(Math.log(env.rmed) + env.sig * gauss());
      if (r < 0.9) return;                           // [r3] the finest spray is the micro-drops' (GPU) layer
      r = Math.min(env.amax, r);
      const x = rnd() * (W + 8) - 4, y = rnd() * (H + 8) - 4;
      for (let i = 0; i < ns; i++) {                 // a drop that lands on a running drop feeds it
        const dx = x - sx[i], dy = y - sy[i], rr = sr[i] + r * 0.5;
        if (dx * dx + dy * dy < rr * rr) { sr[i] = Math.cbrt(sr[i] * sr[i] * sr[i] + r * r * r); return; }
      }
      if (live >= env.capB && !touches(x, y, r)) return;
      const m = mergeAt(x, y, r, -1);
      /* [r8] over its critical size it runs, always (a slot is made for it; at worst it waits pinned for the next substep a
         slot is free, and then no wider than rmax: what would make it wider runs off with the streaming water unseen) */
      if (m.r > rcl(m.x, m.y)) {
        if (startRunner(m.x, m.y, m.v)) return;
        const k = addBead(m.x, m.y, Math.min(m.r, env.rmax), m.e, m.th, NB);
        if (k >= 0) { bm[k] = 1; bf[k] = Math.min(1, m.f); }
        return;
      }
      const k = addBead(m.x, m.y, m.r, m.e, m.th, NB);       // the merged drop (its parts left the store: it always fits)
      if (k >= 0) bf[k] = m.f;
      /* a hard landing throws a few satellite droplets */
      if (r > 1.6 && rnd() < 0.5 && live < env.capB) {
        const n = 1 + Math.floor(rnd() * 3);
        for (let k = 0; k < n; k++) {
          const ang = rnd() * 6.2832, dist = r * (1.6 + 1.6 * rnd());
          const sr0 = r * (0.18 + 0.17 * rnd());
          if (sr0 > 0.45) addBead(m.x + Math.cos(ang) * dist, m.y + Math.sin(ang) * dist, sr0, 0, undefined, env.capB);
        }
      }
    }
    function sliders(h) {
      const rc = env.rc * env.rcK;
      for (let i = ns - 1; i >= 0; i--) {
        const x = sx[i], y = sy[i], r = sr[i];
        /* [r3] a wet path ahead pins less: the drop runs on along it.
           [r8] Once its contact line moves the glass holds it less: it runs on while its weight beats the RECEDING line's
           pinning (0.7 of the static), at v = KV (r^3 - rm^3) / rm^2 (the weight over that, against the line's drag): a drop
           that just started creeps at ~20 px/s (0.8 cm/s), speeds up as it takes in the beads in its path (a heavy one
           reaches 4-8 cm/s), and stops where the glass pins it again. Eased with tau 0.2 s: it visibly starts, it lurches */
        const wa = wetAt(x, y + r * 0.8);
        swet[i] += (wa - swet[i]) * Math.min(1, h / 0.1);
        const rm = 0.7 * Math.min(env.rmax, rc * pin(x, y) * (1 - 0.35 * wa));
        /* on a wet path, and on a storm's streaming glass, it rides the water already there: up to ~4x faster (so a storm's
           runners cross the pane in seconds, as the glass streams, instead of crowding it) */
        const kv = KV * (1 + 1.5 * swet[i]) * env.slick;
        const target = Math.min(VMAX, Math.max(0, kv * (r * r * r - rm * rm * rm) / (rm * rm)));
        sv[i] += (target - sv[i]) * Math.min(1, h / 0.2);
        const sp = sv[i];
        /* the path: a smooth meander of the slider's own, the pinning field's slope, a lean with the wind.
           [r9] A RIVULET MEANDERS MORE AS IT CARRIES MORE WATER, NOT LESS (Le Grand-Piteira, Daerr & Limat 2006: a rivulet down a
           partially wetting plate runs straight at small flow rates and meanders past a critical one, over a few cm): the
           meander grows with the flow (its slope +-.25 for a creeping drop to +-.55 at 110 px/s, win-gondola's rain rivulets
           wander a few px, a storm's more) and its wavelength with it (45 -> ~110 px, 2-4.5 cm at 100 px/s), while the glass's
           local pull (the pinning slope, a wet path beside it) still eases with speed. Round 8 divided all of it by (1 + v / 80),
           so a storm's runners (75-120 px/s) ran as straight rules, every one at the wind's slant (REVIEW-8 #3) */
        const g = (pin(x + 3, y) - pin(x - 3, y)) / 6, lam = 1 + sp / 70, ma = 0.25 + 0.3 * WX.util.smooth(30, 110, sp);
        const mea = ma * (vnoise(smp[i] + sph[i], sph[i] * 3.1) - 0.5) * 2 + 0.25 * (vnoise(smp[i] * 3.75 + sph[i] * 1.7, sph[i]) - 0.5) * 2;
        /* [r3] drawn toward the wet path just ahead (the next drops follow the first), and pushed along the glass
           by the wind: its cross part and the outflow from the stagnation point.
           [r8] The glass's pull (meander, pinning slope, a wet path beside it) bends it at most 0.8 sideways a px down, and less
           as it speeds up; eased over 0.12 s: round 7's 3.6 x the wet path's pull snapped the runners sideways at up to 75 deg,
           and with many of them the tracks zigzagged like wire.
           [r9] On a wet path it follows the channel (its own meander fades: the channel already has the first run's); the wind
           pushes a drop by its area against its weight, so a small runner leans more than a heavy one (wk ~ 1 / r), and the
           wind at the glass is turbulent (a second's flutter of +-35 % in a storm, each runner its own): no two tracks are
           parallel rules */
        const ay = y + r + 3, dw = 3 + 0.25 * r, fol = swet[i];
        /* [r9] and a channel within ~2.5 widths draws it in (a second, wider probe): runs gather into the streams already there */
        const steer = 1.5 * (wetAt(x + dw, ay) - wetAt(x - dw, ay)) + 1.2 * (wetAt(x + 2.5 * dw, ay + dw) - wetAt(x - 2.5 * dw, ay + dw));
        const bend = Math.max(-0.9, Math.min(0.9, mea * (1 - 0.7 * fol) + (steer - 14 * g) / (1 + sp / 80 * (1 - fol))));
        const wk = Math.max(0.6, Math.min(1.6, 4.5 / r)) * (1 + 0.35 * env.storm * (vnoise(t / 1.7 + sph[i] * 5, sph[i] * 2.3 + 40) - 0.5) * 2);
        const vxT = sp * (bend + wk * (env.lean + env.spread * 2 * (x / W - env.stag)));
        svx[i] += (vxT - svx[i]) * Math.min(1, h / 0.12);
        const dx = svx[i] * h, dy = sp * h, dl = Math.sqrt(dx * dx + dy * dy);
        sx[i] = x + dx; sy[i] = y + dy; smp[i] += dl / (45 * lam);   // [r9] the phase runs with the way (not with y: a speed change would sweep it)
        if (dl > 0.05) wetMark(sx[i], sy[i] - r * 0.3, Math.max(1.5, r * 0.3));
        if (dl > 1e-4) { sdir[i * 2] += (dx / dl - sdir[i * 2]) * 0.3; sdir[i * 2 + 1] += (dy / dl - sdir[i * 2 + 1]) * 0.3; }
        const dn = Math.hypot(sdir[i * 2], sdir[i * 2 + 1]) || 1; sdir[i * 2] /= dn; sdir[i * 2 + 1] /= dn;
        /* take in the beads in front. [r8] The beads its drawn head touches (fill(): half-width w <= RW, length k w), not a
           circle of its volume radius: a heavy runner's head is longer, not wider, and it took beads 2-3 px clear of its sides,
           which then went in a blink (tests/pane/r8 track8) */
        if (dl > 0) {
          let V = r * r * r;
          const w = Math.min(r, RW), q3 = r / w, kh = Math.min(2.5, q3 * q3 * q3), hx = sdir[i * 2], hy = sdir[i * 2 + 1];
          const reach = kh * w + 13, cx = sx[i], cy = sy[i];
          const x0 = Math.max(0, Math.floor((cx - reach) / CELL) + 1), x1 = Math.min(gw - 1, Math.floor((cx + reach) / CELL) + 1);
          const y0 = Math.max(0, Math.floor((cy - reach) / CELL) + 1), y1 = Math.min(gh - 1, Math.floor((cy + reach) / CELL) + 1);
          for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
            for (let j = head[gy * gw + gx]; j >= 0; j = next[j]) {
              if (br[j] <= 0) continue;
              const qx = bx[j] - cx, qy = by[j] - cy, al = qx * hx + qy * hy, ac = qx * hy - qy * hx;
              if (al <= -0.35 * w) continue;                  // behind it: the trail's, not its
              const La = (al > 0 ? 0.9 : 1.06) * kh * w * 1.05 + br[j], Lc = w * 1.05 + br[j];
              if (al * al / (La * La) + ac * ac / (Lc * Lc) < 1) {
                /*@lab*/ ex("swept", br[j]); /*@end*/
                V += br[j] * br[j] * br[j] * bf[j]; br[j] = 0; live--;
              }
            }
          }
          sr[i] = Math.cbrt(V);
          /* shed beads behind. [r8] Also on a full pane (up to TRAIL past the bead cap): round 7 kept what it would have shed
             there, and in rain the pane is always full, so no runner left a trail. A drop every 4-24 px, none under 0.8 px
             (what it would shed it keeps): with every runner shedding round 7's way (every 3-17 px, down to .45 px) half the
             bead budget went to sub-pixel dust and the visible beads thinned */
          sshed[i] += dl;
          if (sshed[i] > sgap[i]) {
            sshed[i] = 0; sgap[i] = 4 + 10 * rnd() * rnd() * 2;
            const big = Math.max(0, sr[i] / (rc * pin(sx[i], sy[i])) - 1.2);     // a drop well over its critical size
            if (rnd() < 0.4 + big && sr[i] > 2.2) {                              // leaves more of itself behind
              const rb = sr[i] * Math.min(0.45, 0.09 + 0.16 * rnd() * rnd() + 0.5 * big) + 0.25;
              const V2 = sr[i] * sr[i] * sr[i] - rb * rb * rb;
              if (rb > 0.8 && V2 > 0 && live < env.capB + TRAIL) {
                sr[i] = Math.cbrt(V2);
                addBead(sx[i] - sdir[i * 2] * sr[i] * 1.2 + (rnd() - 0.5) * sr[i] * 0.9, sy[i] - sdir[i * 2 + 1] * sr[i] * 1.2, rb, 0.15 * rnd(), undefined, env.capB + TRAIL);
              }
            }
          }
        }
        if (sp < 2) srest[i] += h; else srest[i] = 0;
        if (sy[i] - sr[i] > H + 2 || sx[i] < -30 || sx[i] > W + 30) { /*@lab*/ ex("ranOff", sr[i]); /*@end*/ killSlider(i); continue; }
        if (srest[i] > 0.25) toBead(i);                // [r8] the same drop, a bead again (never dropped: round 7's blink)
      }
      /* [r9] Two running drops whose heads touch are one rivulet: the smaller joins the larger (volume adds, it runs on at the
         faster speed), so a channel carries the water of the runs that found it and a storm's streams merge into fewer, wider
         ones down the glass. Absorbed runners are marked, then removed (their water is in the other: it never vanishes) */
      let mergedAny = false;
      for (let i = 0; i < ns; i++) {
        if (sr[i] <= 0) continue;
        const wi = Math.min(sr[i], RW), ki = Math.min(2.5, Math.pow(sr[i] / wi, 3));
        for (let j = i + 1; j < ns; j++) {
          if (sr[j] <= 0) continue;
          const wj = Math.min(sr[j], RW), kj = Math.min(2.5, Math.pow(sr[j] / wj, 3));
          const qx = sx[j] - sx[i], qy = sy[j] - sy[i], hx = sdir[i * 2], hy = sdir[i * 2 + 1];
          const al = qx * hx + qy * hy, ac = qx * hy - qy * hx, La = 0.9 * (ki * wi + kj * wj), Lc = 0.8 * (wi + wj);
          if (al * al / (La * La) + ac * ac / (Lc * Lc) >= 1) continue;
          const a = sr[i] >= sr[j] ? i : j, b = a === i ? j : i, Va = sr[a] * sr[a] * sr[a], Vb = sr[b] * sr[b] * sr[b], kb = Vb / (Va + Vb);
          sx[a] += (sx[b] - sx[a]) * kb; sy[a] += (sy[b] - sy[a]) * kb;      // at their volumes' centre: a lurch of a few px at most
          sr[a] = Math.cbrt(Va + Vb); sv[a] = Math.max(sv[a], sv[b]); swet[a] = Math.max(swet[a], swet[b]);
          /*@lab*/ ex("runMerged", sr[b]); /*@end*/
          sr[b] = -1; mergedAny = true;
          if (b === i) break;
        }
      }
      if (mergedAny) for (let i = ns - 1; i >= 0; i--) if (sr[i] < 0) killSlider(i);
    }
    /* [r8] Evaporation. In rain the air is near saturation and a drop loses volume as diffusion lets it, in proportion to its
       contact radius: dr/dt = -KW / r, so the spray's tiny drops (1 px) go in about a minute (flattening under 0.8 px), and the
       beads' budget holds drops you can see (round 7's r / 90 s alone took every radius down 1 % a second: half the store was
       sub-pixel dust). A slower r / TW (120 s) stands for what a rained-on window loses that is not simulated (the streaming
       film taking beads in, splashes): without it the beads' sizes took ~5 min to settle at 85 % (growing by arrivals to
       their critical size takes ~2.5 min there); with it ~30-60 s. Once the rain has stopped (env.dry) a drop dries as one on glass does:
       its contact line stays pinned while it flattens toward the receding angle (FR of its height, 60 % of the time: its lens
       and its dark rim fade), then the line recedes (40 %), in about 12 + 7a s (a in px: 1 mm ~ 30 s, 3 mm ~ 63 s), so the
       pane is dry within 90 s of the rain's end and no drop blinks out: fill() draws a bead under 0.8 px ever flatter, and it
       is gone at 0.4 px with nothing left to see. Round 7 shrank the radius alone (tau 15 s) and dropped a bead at .4 px; a
       runner under .6 px vanished. [r9] 16 + 7a s (TD0): the fine ones too take tens of seconds (REVIEW-8 #5), as the
       micro-drops' (15 + 9r) s */
    const KW = 0.007, TW = 120, TD0 = 16;
    function shrink(dt) {
      const dry = env.dry, wet = 1 - dry, ke = Math.exp(-dt / 12);
      for (let i = 0; i < nb; i++) if (br[i] > 0) {
        let r = br[i], f = bf[i];
        if (wet > 0) r -= wet * dt * (KW / r + r / TW);
        if (dry > 0) {
          const T = TD0 + 7 * r;
          if (f > FR) f = Math.max(FR, f - dry * dt * (1 - FR) / (0.6 * T));
          else r -= dry * dt * (r + 0.6) / (0.4 * T);
        }
        if (r < 0.4) { /*@lab*/ ex("dried", 0.577 * br[i] * bf[i] * WX.util.smooth(0.4, 0.8, br[i])); /*@end*/ br[i] = 0; live--; }   // its last drawn height (px)
        else { br[i] = r; bf[i] = f; be[i] = 0.08 + (be[i] - 0.08) * ke; }   // a merged bead slowly rounds
      }
      /* a runner loses water the same way; one that has lost its run comes to rest and is a bead (sliders()) */
      for (let i = ns - 1; i >= 0; i--) sr[i] = Math.max(0.5, sr[i] - wet * dt * (KW / sr[i] + sr[i] / TW) - dry * dt * (sr[i] + 0.6) / (TD0 + 7 * sr[i]));
    }
    function record(force) {
      for (let i = 0; i < ns; i++) {
        const dx = sx[i] - spx[i], dy = sy[i] - spy[i];
        if (!force && dx * dx + dy * dy < 1) continue;
        if (nt < NT) {
          const o = nt * 6;
          tracks[o] = spx[i]; tracks[o + 1] = spy[i]; tracks[o + 2] = sx[i]; tracks[o + 3] = sy[i];
          /* [r3] a first run leaves a faint wet line; a channel that keeps carrying water reads as a rivulet. [r8] .25 for a
             first run (.4): now that drops over their size all run, a storm's glass held ~10 fresh tracks in a 640 x 400 crop,
             each a pair of dark lines; a single run's film is thin and dries, the channels stay.
             [r9] A first run .22 in rain, .12 in a storm (on a storm's sheeted glass one run's trail joins the water already
             there; on beaded glass it stands out, as win-gondola's); a path that keeps carrying water, up to 1, and wider (a
             rivulet: .45 -> .85 of the runner's radius): of a storm's ~100 tracks on the pane the channels read as the streams
             (REVIEW-8 #3: "many long parallel dark lines"). The film holds water heights (pane.seg).
             [r9f] .2 in a storm too: with the film draining in seconds (pane.filmTau) a storm's streams are its runners and
             their trails, no longer half a minute of old channels, and .12 left them a faint line for under 2 s */
          tracks[o + 4] = Math.max(1.3, sr[i] * (0.45 + 0.4 * swet[i])); tw[nt] = 0.22 - 0.02 * env.storm + (0.78 + 0.02 * env.storm) * swet[i] * Math.sqrt(swet[i]); tracks[o + 5] = recording ? t : tw[nt];
          nt++;
        }
        spx[i] = sx[i]; spy[i] = sy[i];
      }
    }
    function lambda() {
      const s = Math.min(1, Math.max(0, (env.precip - 0.05) / 0.95));
      return env.rate * Math.pow(s, 1.2) * env.wind * (W * H / 1e6);
    }
    function substep(h) {
      rebuild();
      const L = lambda();
      if (L > 1e-6) {
        acc += h;
        while (acc >= nextArr) { acc -= nextArr; arrive(); nextArr = -Math.log(1 - rnd()) / L; }
      } else { acc = 0; nextArr = 0.5; }
      sliders(h);
      t += h;
    }
    let carry = 0;
    return {
      env, resize,
      /* one frame of dt s: 120 Hz substeps, at most 6 */
      step(dt) {
        carry = Math.min(carry + dt, 6 / 120);
        let n = 0;
        while (carry >= 1 / 120 - 1e-9 && n < 6) { substep(1 / 120); carry -= 1 / 120; n++; }
        if (dt > 0) shrink(dt);
        nt = 0;
        record(false);
        return n;
      },
      /* run sec seconds ahead (a still, the first frame): 1/40 s steps; the last 30 s of tracks are kept
         with their age so the film starts in its steady state too. [r8] 1/30 s steps over 90 s (the beads now grow to their
         critical size by arrivals, ~2.5 min at 85 %: 60 s left minute 1's cover 10-17 % over minute 10's), for about the cost
         of round 7's 60 s at 1/40 */
      runAhead(sec) {
        const h = 1 / 30, n = Math.round(sec / h);
        nt = 0; recording = false;
        for (let k = 0; k < n; k++) {
          substep(h);
          if (k % 8 === 0) shrink(8 * h);
          if (k * h > sec - 30) { recording = true; if (k % 4 === 0) record(false); }
        }
        recording = false;
        for (let k = 0; k < nt; k++) tracks[k * 6 + 5] = Math.exp(-(t - tracks[k * 6 + 5]) / env.filmTau) * tw[k];   // age -> film value
        for (let i = 0; i < ns; i++) { spx[i] = sx[i]; spy[i] = sy[i]; }
        rebuild();
      },
      /* instance rows for the height map ([r8] 8 floats): x, y, r, shape, dir x, dir y, height, head length. A bead: shape
         1 - sag / 2 (sag 0..1, how near its critical size it hangs), dir its long axis x (1 + elongation), height its bf
         (drying: flatter), and under 0.8 px flatter still, so it is nothing to see when it goes at 0.4. A running drop: shape
         1.02 + its short taper's length in r, dir its heading, r its head's half-width (at most RW: more water makes the
         head longer, head length = (volume radius / RW)^3, up to 2.5). [r3] No long tail: the trail is the film's wet track */
      fill(out, cap) {
        let n = 0;
        const rc = env.rc * env.rcK;
        for (let i = 0; i < nb && n < cap; i++) {
          if (br[i] <= 0) continue;
          const o = n * 8, k = 1 + be[i], r = br[i], u = Math.min(1, Math.max(0, (r - 0.4) / 0.4));
          out[o] = bx[i]; out[o + 1] = by[i]; out[o + 2] = r;
          out[o + 3] = 1 - 0.5 * Math.min(1, Math.max(0, (r / rc - 0.35) / 0.6));
          out[o + 4] = Math.cos(bth[i]) * k; out[o + 5] = Math.sin(bth[i]) * k;
          out[o + 6] = bf[i] * u * u * (3 - 2 * u); out[o + 7] = 1; n++;
        }
        /* [r6] a running drop is drawn where it is at the frame's time, not at its last 120 Hz substep: at 75 Hz (the user's
           external monitor) a frame took one substep or two (2, 1, 2, 2, 1 ...), and the running drops lurched at 15 Hz */
        for (let i = 0; i < ns && n < cap; i++) {
          const o = n * 8, w = Math.min(sr[i], RW), q = sr[i] / w;
          out[o] = sx[i] + svx[i] * carry; out[o + 1] = sy[i] + sv[i] * carry; out[o + 2] = w;
          out[o + 3] = 1.02 + 0.2 + 0.7 * Math.min(1, sv[i] / 60); out[o + 4] = sdir[i * 2]; out[o + 5] = sdir[i * 2 + 1];
          out[o + 6] = 1; out[o + 7] = Math.min(2.5, q * q * q); n++;
        }
        return n;
      },
      /* [r3] light rain fills the pane slowly (beads leave only by drying, tau 90 s): run further ahead there, so
         minute 1 already holds the steady state (round 2's v=72 differed by 18 % from minute 10). [r8] 90 s, up to 180 */
      aheadSec: () => (env.precip < 0.5 ? 90 + 90 * (1 - env.precip / 0.5) : 90),
      tracks, nTracks: () => nt,
      speeds: () => sv.subarray(0, ns),                       // the running drops' speeds px/s (tests)
      counts: () => ({ beads: nb, sliders: ns, t }),
      /* covered area (px^2, overlaps counted once on a 2 px grid) and the bead count, for the tests */
      stats() {
        let live = 0, area = 0;
        for (let i = 0; i < nb; i++) if (br[i] > 0) { live++; area += Math.PI * br[i] * br[i]; }
        for (let i = 0; i < ns; i++) area += Math.PI * sr[i] * sr[i];
        return { beads: live, sliders: ns, cover: area / (W * H), t };
      },
      pinAt: pin, rnd,
      /*@lab*/
      /* [r8] tests/pane/r8: how drops left (EX), and the drops themselves (sizes, over-critical beads) */
      exits: () => EX,
      drops: () => ({ bx, by, br, bf, bm, nb, sx, sy, sr, sv, ns, rcl, FR, RW }),
      /*@end*/
    };
  }


  /* ════════════════ GL ════════════════ */
  /* [r8] every bead the store can hold (6600), every runner (330) and the inside runs (4): all drawn, always (round 7's 6800
     could leave the last runners out once a trail took the store past the bead cap). 8 floats a row (fill()) */
  const MAXI = 6940, IROW = 8;
  let P = {}, hmap = null, hfb = null, film = null, ffb = null, mist = [null, null], mfb = [null, null], mcur = 0;
  let ibuf = null, ivao = null, tbuf = null, tvao = null, quad = null;
  let sim = null, seeded = false, wasStill = false, stillPrecip = -1, mapScale = 1, fresh = true;
  const inst = new Float32Array(MAXI * IROW), trk = new Float32Array(4096 * 6);
  /* the inside runs' own seeded generator (mulberry32), apart from the drops' */
  let runSeed = 0x2f6b1d3;
  const rr = () => { runSeed = (runSeed + 0x6d2b79f5) >>> 0; let t = runSeed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const runs = { over: false, x: new Float32Array(4), y: new Float32Array(4), r: new Float32Array(4), v: new Float32Array(4), px: new Float32Array(4), py: new Float32Array(4), ph: new Float32Array(4), n: 0, next: 30, mistE: 0, t: 0 };
  let microN = 0, mvao = null, microE = 0, lastN = 0, filmT = 1e9, fineE = 0, microD = 0;
  /*@lab*/ const heapLog = new Float64Array(256), simMs = new Float32Array(240); let simN = 0; /*@end*/
  const U = {
    cap: { uMap: new Float32Array(4), uRimFix: 1 },
    micro: { uFilm: null, uGrid: new Float32Array(4), uFirst: new Float32Array(2), uGlass: null, uDry: 0, uMs: new Float32Array(3), uLampG: new Float32Array(4) },
    decay: { uK: 1 },
    seg: { uMap: new Float32Array(4) },
    mseg: { uMap: new Float32Array(4) },
    mist: { uPrev: null, uK: new Float32Array(2), uDecay: 0 },
  };
  const mapPx = new Float32Array(4), filmPx = new Float32Array(4), on = new Float32Array(4);
  const CAP = `
    /* the spherical cap of contact angle theta: h(rho) = (sqrt(Rs^2 - rho^2) - Rs cos(theta)) r, Rs = 1/sin(theta).
       [r3] 60 deg (rain on window glass pins at 40-90 deg; round 2's 49 left no ring past the critical angle):
       the outer eighth of every bead is past total internal reflection, the thin dark outline a photograph
       shows round each bead, and the lens bends far enough to hold the sea in its top and the sky above the
       window in its bottom */
    const float RS = 1.1547, RSC = 0.57735;
    float capH(float rho) { return rho < 1. ? sqrt(RS * RS - rho * rho) - RSC : 0.; }`;
  /* [r9f] A DROP A FEW TEXELS ACROSS IS UNDER-SAMPLED: the view takes its slope as one texel's forward difference of the height
     map, so a cap of radius rm map texels never shows the slope its rim has, and the rim's darkening (the view's outer ring and
     total internal reflection) went with it. Through the view's own sampling (tests/pane/r9f/rimsamp.py: the cap rasterised at the
     texels, read bilinearly at the user's view px, the rim's weights summed against the same drop's analytic slopes) a 5-texel
     drop kept .69 of its rim, a 2.6-texel one .34, a 2-texel one .24, a 1.2-texel one .03: the 85 % glass's 1-2 mm field (most
     of its ~125 drops per 100 x 100 CSS px) read as faint grey dots (REVIEW-9 2.5: 6-7x fewer blobs than win-gondola). The
     height is restored by rimK (its footprint unchanged: no drop is wider), which brings a 1.2-3 texel drop to ~.6-.9 of its
     analytic rim; a sub-texel droplet stays a speck */
  const RIMK = `
    float rimK(float rm) { return 2. - .3 * smoothstep(2.4, 3.6, rm) - .7 * smoothstep(.9, 1.6, rm); }`;   // 2 under .9 texels, 1 over 3.6
  /* cap and segment programs share one vertex layout: a unit quad (attr 0) and 6 floats per instance ([r8] the caps 8: attr 2
     is a vec4 there) */
  function vaoFor(gl, buf, stride, n2) {
    const v = gl.createVertexArray();
    gl.bindVertexArray(v);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, n2 || 2, gl.FLOAT, false, stride, 16); gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);
    return v;
  }
  function freeTargets(gl) {
    for (const t of [hmap, film, mist[0], mist[1]]) if (t) gl.deleteTexture(t.tex);
    for (const f of [hfb, ffb, mfb[0], mfb[1]]) if (f) gl.deleteFramebuffer(f.fb);
    hmap = film = hfb = ffb = null; mist = [null, null]; mfb = [null, null];
  }
  /* the simulation's environment from the weather and the wind (Node's tests call it too) */
  function envOf(e, W, wn, knobs, p, area) {
    e.precip = W.precip; e.storm = W.storm;
    const onshore = Math.max(0.15, -wn.wind.dir[1]), u = Math.min(1, wn.wind.U10 / 24);
    e.wind = Math.min(1.35, Math.max(0.35, 0.3 + 0.75 * wn.wind.U10 * onshore / 12));
    /* [r3] the wind along the glass: its cross part, and the outflow from the stagnation point; both grow with
       the square of the speed, so a storm runs the drops diagonally and a breeze barely bends them */
    e.lean = Math.max(-0.9, Math.min(0.9, wn.wind.dir[0] * 1.3 * u * u));
    /* [r9] .55 (.8): at 96 % the outflow slanted every run in the right third 40-50 deg, a fan of parallel rules (REVIEW-8 #3);
       the runs there now lean ~35 deg and each its own way (sliders(): wk, the flutter, the meander) */
    e.spread = onshore * 0.55 * u * u * WX.util.smooth(0.3, 0.9, W.storm + 0.3 * W.precip);
    e.dry = 1 - WX.util.smooth(0.03, 0.12, W.precip);
    e.capB = Math.min(knobs.beads, 6000);
    /* [r3] a few long rivulets, not a pane of runners: about 14 per Mpx at the cap (a storm), fewer in rain.
       [r8] The tier's cap (40-300): how many run is the physics' (a drop over its critical size runs, always); with the sizes
       real, a storm keeps ~60-120 running on the user's 2.2 Mpx (tests/pane/r8) */
    e.capS = knobs.sliders;
    e.rate = p("pane.rate"); e.rc = p("pane.rc"); e.rmax = p("pane.rmax"); /* [r9f] the storm re-routes the flow: the short drain and the tiring path come in with it (0 up to 88 %, 1 from 92.5 %, where
       the storm and its lightning begin),
       so rain without a storm keeps round 9's fed rivulets that stay where they run (REVIEW-9 2.5: "a thin wandering rivulet with
       its trail as gondola's") */
    const sg = WX.util.smooth(0.05, 0.5, W.storm);
    e.filmTau = p("pane.filmTauCalm") + (p("pane.filmTau") - p("pane.filmTauCalm")) * sg; e.age = p("pane.pathAge") * sg;
    e.rcK = 1 - 0.2 * W.storm * WX.util.smooth(0.5, 1, W.precip);      // streaming glass pins drops less
    e.slick = 1 + 0.8 * W.storm * WX.util.smooth(0.5, 1, W.precip);   // [r8] and runs them faster (sliders())
    /* [r4] a storm's spray is finer (wind-shattered drops): arrivals median 2.2 px in rain, 1.7 at the cap (x12 against
       win-gondola at 1:1: the storm's beads read a little large). [r8] 1.9 and 1.5 px (0.8 and 0.6 mm contact radius:
       raindrops of ~1 mm), sigma .45, at most 5 px (a 2.5 mm raindrop): of the drops the simulation takes (over 0.9 px,
       raindrops over ~0.5 mm) ~5 % are 2 mm raindrops or more (3.9 px), where Marshall-Palmer at 25 mm/h has ~4 %; round 7's
       2.2 / .6 made it 12 %, a big drop landing every few seconds in a 640 x 400 crop (out/P/a2/u85-start-f263.jpg) */
    e.rmed = 1.9 - 0.4 * W.storm; e.sig = 0.45; e.amax = 5;
  }
  function envFrom(F, R) {
    const W = F.W, wn = F.wind || WX.windAt(W, F.t), C = Cg;
    envOf(sim.env, W, wn, R.knobs, R.p, C[0] * C[1]);
  }
  function stampTracks(R, src, n) {
    const gl = R.gl;
    if (!n) return;
    filmT = 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, tbuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, src, 0, n * 6);
    R.bind(ffb);
    gl.enable(gl.BLEND); gl.blendEquation(gl.MAX); gl.blendFunc(gl.ONE, gl.ONE);
    P.seg.use(); R.gpu.uniforms(P.seg, U.seg);
    gl.bindVertexArray(tvao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n); gl.bindVertexArray(null);
    gl.blendEquation(gl.FUNC_ADD); gl.disable(gl.BLEND);
  }
  /* the library's uniforms, for post's view program and the rain's streaks */
  function fill(u, F, R) {
    const pyr = R.priv.pyr, lim = R.priv.lim;
    u.uH = hmap; u.uFilm = film; u.uMist = mist[mcur];
    u.uDown = pyr.down; u.uUp = pyr.up; u.uLev = pyr.levels - 1;
    u.uLimK = lim ? lim.tex : null;
    u.uMapPx = mapPx; u.uFilmPx = filmPx; u.uOn = on; u.uGlass = glassU;
    const W = F.W;
    u.uSheet = WX.util.smooth(0.6, 0.97, W.precip) * (0.35 + 0.65 * W.storm) * R.p("pane.sheet");
    u.uSheetLean = Math.max(-0.9, Math.min(0.9, sim.env.lean + sim.env.spread * 2 * (0.5 - sim.env.stag)));
    on[0] = lastN > 0 || microE > 0.002 ? 1 : 0;
    on[1] = filmT < 10 * sim.env.filmTau ? 1 : 0;       // the film decays with tau env.filmTau: e^-10 after ten of them
    on[2] = runs.mistE > 0.001 || (W.mist || 0) > 0.001 ? 1 : 0;
    on[3] = lim && lim.on ? 1 : 0;
    filmPx[2] = R.p("pane.track");
    if (R.priv.rainFill) R.priv.rainFill(u, F, R);
  }
  return {
    name: "pane",
    makeSim, envOf,
    *build(R) {
      hmap = hfb = film = ffb = null; mist = [null, null]; mfb = [null, null]; fresh = true;
      const gl = R.gl;
      P.cap = R.program("pane.cap", { vs: RIMK + `
        layout(location = 0) in vec2 aPos; layout(location = 1) in vec4 aI0; layout(location = 2) in vec4 aDir;
        uniform vec4 uMap;   // xy map px per CSS px, zw 1 / map size
        uniform float uRimFix;   // [r9f] 1: a small bead's height restored to its rim's slope (rimK)
        out vec2 vQ; flat out float vR, vS, vSeed, vF, vK; flat out vec2 vDown;
        void main() {
          float s = aI0.w, Lt = max(s - 1.02, 0.), kh = max(aDir.w, 1.);
          /* [r3] a bead: its long axis dir stretched by |aDir| (a merge's pinned contact line), its outline warped to
             ~1.3 r; a running drop: a head a little longer than wide, a short taper behind (the trail is the film's).
             [r8] aDir.z the drop's height (a drying bead flattens), aDir.w a runner's head length (more water: longer) */
          float k = s < 1.01 ? max(length(aDir.xy), 1.) : 1.;
          vec2 q = s < 1.01 ? aPos * 1.32 : vec2(mix((-1.2 - Lt) * kh, .95 * kh, aPos.x * .5 + .5), aPos.y * 1.04);
          vec2 dir = normalize(aDir.xy), nrm = vec2(-dir.y, dir.x);
          vec2 st = s < 1.01 ? vec2(sqrt(k), 1. / sqrt(k)) : vec2(1.);
          vec2 p = aI0.xy + (dir * q.x * st.x + nrm * q.y * st.y) * aI0.z;
          vQ = q; vR = aI0.z; vS = s; vSeed = fract(sin(dot(floor(aI0.xy * 4.), vec2(12.9898, 78.233))) * 43758.5453);
          vF = aDir.z * (s < 1.01 && uRimFix > .5 ? rimK(aI0.z * uMap.x) : 1.); vK = kh;
          vDown = vec2(dir.y, nrm.y);                // the glass's down (CSS +y) in the drop's own frame
          vec2 m = p * uMap.xy * uMap.zw;
          gl_Position = vec4(m.x * 2. - 1., 1. - m.y * 2., 0., 1.);
        }`, fs: CAP + `
        in vec2 vQ; flat in float vR, vS, vSeed, vF, vK; flat in vec2 vDown; out vec4 o;
        void main() {
          if (vF < .001) discard;                    // [r8] a bead that has dried flat: nothing left to see
          vec2 q = vQ;
          float s1 = vSeed * 6.283, h;
          if (vS < 1.01) {
            /* a pinned contact line is never a circle: a smooth, low warp of the drop's own coordinates (no cusp
               at the centre, so the dome stays a liquid dome), stronger on bigger beads; a bead near its critical
               size hangs: its upper half narrows, its weight sits low (a teardrop pointing up) */
            float wa = .04 + .06 * smoothstep(1.5, 6., vR), sag = (1. - vS) * 2.;
            q += wa * vec2(sin(q.y * 2.1 + s1) + .5 * sin(q.x * 3.3 + q.y * 1.7 + s1 * 2.), sin(q.x * 1.9 + s1 * 1.7) + .5 * sin(q.y * 3.1 - q.x * 1.3 + s1 * 3.));
            float dn = dot(q, vDown);
            vec2 pr = q - vDown * dn;
            q = vDown * (dn - .12 * sag) + pr / (1. - .22 * sag * smoothstep(.1, -.9, dn));
            h = capH(length(q)) * (1. + .12 * sag * clamp(dn, -1., 1.));
          } else {
            /* a running drop: the head a cap a little longer than wide (front .9 r, back 1.06 r), its dome leaning
               forward (the advancing angle is the steeper); behind it a short taper over Lt r. [r8] A heavy runner's head is
               vK times longer, never wider (its half-width r is at most RW) */
            float Lt = vS - 1.02, a = q.x / vK;
            h = capH(length(vec2(a / (a > 0. ? .9 : 1.06), q.y))) * (1. + .12 * clamp(a, -1., 1.));
            float u = -a - .55, t = clamp(u / max(Lt, .05), 0., 1.);
            float wt = mix(.48, .14, t), yt = (q.y - .05 * t * sin(u * 3. + s1)) / wt;
            if (u > 0.) h = max(h, capH(abs(yt)) * wt * .8 * (1. - t * t));
          }
          if (h <= 0.) discard;
          o = vec4(exp(min(h * vR * vF, 11.)), 0., 0., 1.);
        }` });
      /* micro-drops: one per cell of two grids (5 and 9 CSS px), made in the vertex shader from the cell's hash;
         a cell with no drop now is culled before rasterisation, so the cost follows the drops, not the screen.
         A drop never crosses its cell; it lands at a hashed time of a life that divides the 240 s rain clock,
         dries before it goes, and is wiped where the film is fresh (a slider just ran there).
         [r8] Nothing blinks out (round 7: a drop went at 40 % of its radius at the end of its life, and whenever the density
         fell, so at the end of a rain every one of them blinked out, at full size, within half a minute). Every drop now lives
         .8 of its cycle; the density sets how many cells hold one (h.y under occ0 / .8), and a drop near that line is flatter
         (a band a fifth of it wide): a falling density dries drops flat over seconds, a runner's fresh track flattens the ones
         it sweeps, and every drop flattens to nothing over the last fifth of its life. uFirst.y: the fine layer's height, eased
         over a tier change (it was there or not in one frame) */
      P.micro = R.program("pane.micro", { vs: RIMK + `
        layout(location = 0) in vec2 aPos;
        uniform sampler2D uFilm; uniform vec4 uGrid;    // x layer-1 cells, y layer-1 columns, z layer-2 columns, w density
        uniform vec4 uGlass;
        uniform vec2 uFirst;                            // [r3] x the first instance drawn (uGrid.x: the second layer only)
        uniform float uDry;                             // [r9] s since the rain ended (0 while it rains; at most 90)
        uniform vec3 uMs;                               // [r9f] x map px per glass px, y the 8 px layer's share, z the rim fix (0/1)
        uniform vec4 uLampG;                            // [r9f] the lighthouse's lamp: xy glass px (y up), z the keep-out px, w its weight
        out vec2 vQ; flat out float vR, vF;
        void main() {
          float id = float(gl_InstanceID) + uFirst.x;
          bool l2 = id >= uGrid.x;
          float cell = l2 ? 8. : 5., rmax = l2 ? 3.4 : 1.6, salt = l2 ? 7. : 3., k = l2 ? id - uGrid.x : id, cols = l2 ? uGrid.z : uGrid.y;
          vec2 c = vec2(mod(k, cols), floor(k / cols));
          vec3 h = wxHash33(vec3(c, salt)), g = fract(h.yzx * 7.919 + h.zxy * 3.137);
          const float DUTY = .8;                                         // the share of its cycle a drop lives
          float a = uGrid.w * (l2 ? uMs.y : 1.) / DUTY;                  // the share of cells that hold one ([r9] l2 .6 -> .8: win-gondola's 1-3 mm field; [r9f] 1)
          float per = 240. / (1. + floor(h.z * 3.));                     // [r3] 240, 120 or 80 s: a bead persists
          float ph = fract(h.x * 7.31 + uTime.y / per);
          /* [r3] the cheap tests first: most cells are empty, and they skip the film's fetch. [r9] And no drop lands once the rain
             has ended: a life that began less than uDry s ago is not drawn (the ones that were there dry, below) */
          if (h.y >= a || ph >= DUTY || ph * per < uDry) { gl_Position = vec4(2., 2., 2., 1.); return; }
          float r = l2 ? .9 * pow(rmax / .9, g.x) : mix(.45, rmax, g.x * g.x);   // [r3] the second layer log-uniform .9-3.4 px
          vec2 ctr = c * cell - (l2 ? 2.5 : 0.) + vec2(r) + g.yz * (cell - 2. * r);   // CSS px, y up
          /* [r8] down to the film's faint edge (its bilinear texels reach ~2 px past the track's ridge): a runner took them up
             across most of its head (.15-.5 left all but those under the ridge to show through after it); they come back
             as the track dries ([r9f] the film's drain, 3 s: a first run's ~5 s, a fed channel's ~12 s after its last feed) */
          float wipe = smoothstep(.02, .06, textureLod(uFilm, ctr / uGlass.xy, 0.).r);
          /* the band where a drop is flatter: a fifth of the density's line, at least .02 (a fixed .2 left every drop of a light
             rain's sparse layer, a under .2, at a third of its height: round 8's a3 at 75 % read as faint ghosts); the last
             fifth of its life (13-38 s) to flatten away */
          float f = clamp((a * (1. - wipe) - h.y) / max(.2 * a, .02), 0., 1.) * (1. - smoothstep(.8 * DUTY, DUTY, ph)) * (l2 ? 1. : uFirst.y);
          /* [r9] AFTER THE RAIN EACH DROP DRIES WHERE IT IS, as the simulation's beads do: its contact line stays while it flattens
             to the receding angle's height (.35, the first 60 % of its time), then the line recedes and it goes, over
             (15 + 9 r) s +-25 % (r px: a .5 px droplet ~20 s, a 3 px bead ~42 s; all gone by 57 s). Round 8 let the falling
             density take them, ~2 s each (REVIEW-8 #5: "the fine droplets fade in about 2 s") */
          float ud = uDry / ((15. + 9. * r) * (.75 + .5 * fract(h.x * 13.7 + h.y * 5.3)));
          f *= mix(1., .35, smoothstep(0., .6, ud)) * (1. - smoothstep(.6, 1., ud));
          /* [r9f] NO MICRO-DROP PARKS ON THE LIGHTHOUSE'S LAMP. With their rims shown (rimK) a 1-2 mm drop over the lamp holds only
             its minified image (dim by day: physical), and this layer has no turnover of its own (a drop lives 64-192 s), where in
             a storm a real drop there is merged, swept or run off within seconds: at the cap a micro-drop sat on the lamp for
             whole clips (out/P/r9f/g1/cap100-lamp-x3.jpg: its peak 171-186 -> 85-89). So none is drawn whose edge comes within
             the keep-out of the lamp's centre (the simulation's beads and runners still cross it); a static choice, nothing
             appears or goes */
          f *= 1. - uLampG.w * (1. - smoothstep(r + .5 * uLampG.z, r + uLampG.z, length(ctr - uLampG.xy)));
          if (f < .002) { gl_Position = vec4(2., 2., 2., 1.); return; }
          r *= 1. - .45 * smoothstep(.6, 1., ud);
          vec2 p = ctr + aPos * (r + .75);
          vQ = aPos * (r + .75) / r; vR = r; vF = f * (uMs.z > .5 ? rimK(r * uMs.x) : 1.);   // [r9f] the rim restored (RIMK)
          gl_Position = vec4(p / uGlass.xy * 2. - 1., 0., 1.);
        }`, fs: CAP + `
        in vec2 vQ; flat in float vR, vF; out vec4 o;
        void main() { float rho = length(vQ); if (rho >= 1.) discard; o = vec4(exp(capH(rho) * vR * vF), 0., 0., 1.); }` });
      P.decay = R.program("pane.decay", { fs: `uniform float uK; out vec4 o; void main() { o = vec4(0., 0., 0., uK); }` });
      /* a wet track: a rounded ridge across the segment (height 1 at its middle), MAX into the film */
      P.seg = R.program("pane.seg", { vs: `
        layout(location = 0) in vec2 aPos; layout(location = 1) in vec4 aI0; layout(location = 2) in vec2 aI1;
        uniform vec4 uMap;   // xy target px per CSS px, zw 1 / target size
        out vec2 vP; flat out vec4 vSeg; flat out vec2 vW;
        void main() {
          vec2 a = aI0.xy, b = aI0.zw, d = b - a;
          float l = length(d); vec2 dir = l > 1e-3 ? d / l : vec2(0., 1.), n = vec2(-dir.y, dir.x);
          float w = aI1.x * .5 + 1.5;
          vec2 p = mix(a - dir * w, b + dir * w, aPos.x * .5 + .5) + n * aPos.y * w;
          vP = p; vSeg = vec4(a, b); vW = aI1;
          vec2 m = p * uMap.xy * uMap.zw;
          gl_Position = vec4(m.x * 2. - 1., 1. - m.y * 2., 0., 1.);
        }`, fs: `
        in vec2 vP; flat in vec4 vSeg; flat in vec2 vW; out vec4 o;
        void main() {
          vec2 a = vSeg.xy, b = vSeg.zw, pa = vP - a, ba = b - a;
          float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0., 1.);
          float hw = vW.x * .5 + .6, x = length(pa - ba * h) / hw;
          if (x >= 1.) discard;
          /* [r9] a rivulet's section: a circular arc meeting the glass at 40 deg (water on window glass), so its height is
             hw tan 20 deg and its edges are as steep as the water's contact angle, no steeper: round 8's ellipse of height 1 px
             stood vertical at its edges, past total internal reflection, and every track was a pair of dark lines. The film now
             holds the water's height in CSS px (the view's uFilmPx.z = 1) */
          o = vec4(vW.y * hw * (sqrt(2.4203 - x * x) - 1.1918), 0., 0., 1.);
        }` });
      P.mist = R.program("pane.mist", { fs: `
        uniform sampler2D uPrev; uniform vec2 uK; uniform float uDecay; in vec2 vUV; out vec4 o;
        float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
          return mix(mix(wxHash12(i), wxHash12(i + vec2(1, 0)), f.x), mix(wxHash12(i + vec2(0, 1)), wxHash12(i + 1.), f.x), f.y); }
        void main() {
          vec2 a = vec2(uRes.x / uRes.y, 1.), p = vUV * a;
          float edge = min(min(vUV.x, 1. - vUV.x) * a.x, min(vUV.y, 1. - vUV.y) * 1.15);
          float n = .6 * vn(p * 5. + 3.1) + .3 * vn(p * 13. + 7.7) + .1 * vn(p * 37.);
          float thr = .12 + .75 * smoothstep(0., .45, edge) * (.55 + .45 * n);
          float target = smoothstep(thr - .25, thr + .05, uWx3.x) * (.86 + .14 * vn(p * 61. + 1.3));
          vec2 prev = texture(uPrev, vUV).rg;
          float k = target > prev.r ? uK.x : uK.y;
          o = vec4(prev.r + (target - prev.r) * k, prev.g * uDecay, 0., 1.);
        }` });
      P.mistSeg = R.program("pane.mistSeg", { vs: `
        layout(location = 0) in vec2 aPos; layout(location = 1) in vec4 aI0; layout(location = 2) in vec2 aI1;
        uniform vec4 uMap;
        out vec2 vP; flat out vec4 vSeg; flat out vec2 vW;
        void main() {
          vec2 a = aI0.xy, b = aI0.zw, d = b - a;
          float l = length(d); vec2 dir = l > 1e-3 ? d / l : vec2(0., 1.), n = vec2(-dir.y, dir.x);
          float w = aI1.x * .5 + 2.;
          vec2 p = mix(a - dir * w, b + dir * w, aPos.x * .5 + .5) + n * aPos.y * w;
          vP = p; vSeg = vec4(a, b); vW = aI1;
          vec2 m = p * uMap.xy * uMap.zw;
          gl_Position = vec4(m.x * 2. - 1., 1. - m.y * 2., 0., 1.);
        }`, fs: `
        in vec2 vP; flat in vec4 vSeg; flat in vec2 vW; out vec4 o;
        void main() {
          vec2 a = vSeg.xy, b = vSeg.zw, pa = vP - a, ba = b - a;
          float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0., 1.);
          float dd = length(pa - ba * h), r = vW.x * .5;
          o = vec4(0., 1. - smoothstep(r * .6, r + 1.5, dd), 0., 1.);
        }` });
      yield* R.wait(P.cap, P.micro, P.decay, P.seg, P.mist, P.mistSeg);
      quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      ibuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, ibuf);
      gl.bufferData(gl.ARRAY_BUFFER, inst.byteLength, gl.DYNAMIC_DRAW);
      tbuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, tbuf);
      gl.bufferData(gl.ARRAY_BUFFER, trk.byteLength, gl.DYNAMIC_DRAW);
      ivao = vaoFor(gl, ibuf, IROW * 4, 4);
      mvao = gl.createVertexArray();
      gl.bindVertexArray(mvao); gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      tvao = vaoFor(gl, tbuf, 24);
      if (!sim) sim = makeSim(0x5eed);
    },
    resize(R) {
      const gl = R.gl, G = R.gpu, S = R.size.S;
      /* [1.3.2] a tier change keeps the CSS size: the film (the wet trails) and the mist depend only on it and are kept,
         so the glass does not dry in one frame; the height map follows S and is restamped every frame */
      if (hmap) { gl.deleteTexture(hmap.tex); gl.deleteFramebuffer(hfb.fb); hmap = hfb = null; }
      /* [r4] the glass in its own px: a view smaller than 1280 x 820 shows the same window (the scene's field), so the
         drops shrink with it (pane.glass: the smallest scale, a phone); larger views keep CSS px (round 3's look) */
      const Cc = R.size.C, gs = Math.min(1, Math.max(R.p("pane.glass"), Math.min(Cc[0], Cc[1] * 1.56) / 1280));
      Cg[0] = Cc[0] / gs; Cg[1] = Cc[1] / gs; glassU[0] = Cg[0]; glassU[1] = Cg[1]; glassU[2] = 1 / gs;
      const C = Cg;
      mapScale = Math.min(Math.max(1, S[0] / C[0]), 2048 / C[0]);
      const mw = Math.max(16, Math.round(C[0] * mapScale)), mh = Math.max(16, Math.round(C[1] * mapScale));
      hmap = G.tex2D(mw, mh, "r16f"); hfb = G.fbo([hmap]);
      const fw = Math.max(8, Math.round(C[0] / 2)), fh = Math.max(8, Math.round(C[1] / 2));
      const qw = Math.max(8, Math.round(C[0] / 4)), qh = Math.max(8, Math.round(C[1] / 4));
      const keep = film && ffb && ffb.w === fw && ffb.h === fh && mist[0] && mfb[0] && mfb[0].w === qw && mfb[0].h === qh;
      if (!keep) {
        for (const t of [film, mist[0], mist[1]]) if (t) gl.deleteTexture(t.tex);
        for (const f of [ffb, mfb[0], mfb[1]]) if (f) gl.deleteFramebuffer(f.fb);
        film = G.tex2D(fw, fh, "r16f"); ffb = G.fbo([film]);
        for (let k = 0; k < 2; k++) { mist[k] = G.tex2D(qw, qh, "rg16f"); mfb[k] = G.fbo([mist[k]]); }
        for (const f of [ffb, mfb[0], mfb[1]]) { R.bind(f); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
      }
      sim.resize(C[0], C[1]);
      U.cap.uMap.set([mapScale, mapScale, 1 / mw, 1 / mh]);
      const c1 = Math.ceil(C[0] / 5), r1 = Math.ceil(C[1] / 5), c2 = Math.ceil(C[0] / 8) + 1, r2 = Math.ceil(C[1] / 8) + 1;
      U.micro.uGrid.set([c1 * r1, c1, c2, 0]); microN = c1 * r1 + c2 * r2;
      U.seg.uMap.set([fw / C[0], fh / C[1], 1 / fw, 1 / fh]);
      U.mseg.uMap.set([qw / C[0], qh / C[1], 1 / qw, 1 / qh]);
      mapPx.set([mapScale, mapScale, 1 / mw, 1 / mh]);
      filmPx[0] = 1 / fw; filmPx[1] = 1 / fh;
      if (!keep) fresh = true;
      R.priv.pane = { sim, hmap, film, mist, fill };
      /*@lab*/
      /* a test calls it, never the frame loop: the mist's covered mean, a synchronous read of F = r (1 - g) */
      R.priv.paneMistMean = () => {
        const f = mfb[mcur], buf = new Float32Array(f.w * f.h * 4);
        R.bind(f); gl.readPixels(0, 0, f.w, f.h, gl.RGBA, gl.FLOAT, buf);
        let sum = 0; for (let i = 0; i < f.w * f.h; i++) sum += Math.max(0, Math.min(1, buf[i * 4] * (1 - buf[i * 4 + 1])));
        return sum / (f.w * f.h);
      };
      R.debugTex("pane.height", hmap, "r");
      R.debugTex("pane.film", film, "r");
      R.debugTex("pane.mist", mist[0], "r");
      /*@end*/
    },
    ubo(F, R, set) { set("uC0", R.p("pane.refr"), R.p("pane.debug"), R.p("pane.lodBias"), R.p("pane.sharpen")); },
    slots: {
      drops(R, F) {
        const gl = R.gl, C = Cg;
        envFrom(F, R);
        /*@lab*/ const t0 = performance.now(); /*@end*/
        /* the steady state: seeded on the first frame and whenever a still asks for a new state */
        const stillNew = F.still && (!wasStill || Math.abs(F.W.precip - stillPrecip) > 0.01);
        let ahead = false;
        if (!seeded || stillNew) { sim.runAhead(sim.aheadSec()); seeded = true; ahead = true; stillPrecip = F.W.precip; microE = F.W.precip; runs.mistE = F.W.mist; }
        wasStill = !!F.still;
        const dt = F.still ? 0 : Math.min(F.dt || 0, 0.1);
        if (!ahead) sim.step(dt);
        /*@lab*/
        /* the simulation's JS time (tests/pane: drops JS p95 <= 0.8 ms) */
        simMs[simN++ % simMs.length] = performance.now() - t0;
        R.priv.paneSimMs = simMs; R.priv.paneSimN = simN;
        /* the JS heap every 60 frames, for the "no allocation per frame" test */
        if (simN % 60 === 0 && performance.memory) heapLog[(simN / 60) % heapLog.length] = performance.memory.usedJSHeapSize;
        R.priv.paneHeap = heapLog;
        /*@end*/
        /* micro-drop density eases toward the rain (tau 8 s); the film decays (tau 12 s) */
        /* [r3] the static beads carry the density: denser as the rain closes to a storm.
           [r8] It falls more slowly (by (E - target) / 20 a second, at least .012: from a storm's .8 to nothing in ~45 s), so
           as the rain eases or ends each micro-drop flattens over 4-13 s; the fine layer's height eases over a tier change.
           [r9] As the rain eases each drop at the density's line flattens over 12 s or more (the fall is at most a twelfth of the
           band a second): round 8's floor of .012 a second against a band of .02 near the end took ~2 s a drop. Once the rain
           has ended the density holds and the dryness clock (microD: s since the rain ended) dries every drop where it is over
           its own (15 + 9 r) s (the micro VS); when they have all gone (60 s) the layer goes with them, unseen. The clock runs
           back at 10 s a second when it rains again, and is 0 at once if nothing is left to re-wet */
        const microT = Math.pow(WX.util.smooth(0.05, 0.9, F.W.precip), 0.8) * R.p("pane.micro") * (0.5 + 0.3 * WX.util.smooth(0.55, 1, F.W.precip));
        if (sim.env.dry > 0.5) microD = Math.min(90, microD + dt);
        else microD = microE < 0.003 ? 0 : Math.max(0, microD - 10 * dt);
        if (microT >= microE) microE += (microT - microE) * (1 - Math.exp(-dt / 8));
        else if (microD <= 0) microE = Math.max(microT, microE - dt * Math.min(Math.max(0.2 * microE, 0.02) / 12, Math.max(0.004, (microE - microT) / 30)));
        else if (microD >= 60) microE = microT;
        const fineT = R.tier >= R.p("pane.microFine") ? 1 : 0;
        fineE += (fineT - fineE) * (1 - Math.exp(-dt / 1.5));
        if (ahead) { microE = microT; fineE = fineT; microD = sim.env.dry > 0.5 ? 90 : 0; }
        /* the film. [r9f] Its water drains with tau pane.filmTau (3 s; round 9 12 s): a rivulet no runner feeds runs down and
           dewets within seconds (its beads and droplets are the shed beads and the micro-drops, which come back as it goes); a
           channel the runners keep feeding stays, until its path tires (makeSim's wet0). With 12 s every channel was re-fed
           (every 4.6 s at the median at 96 %) long before it faded, so a channel held its place for half a minute: over the
           lighthouse's lamp for a whole clip (REVIEW-9 2.3, s3 and s7), and at the cap a pane of parallel streams
           (tests/pane/r9f/chan.cjs, 300 points of the right half over 40 s: the longest spell under a channel 29 / 27 s at 96 /
           100 % -> 9.9 / 9.7 s, none over 10 s; the film over .04 px 4.3 / 5.4 % of the pane -> 1.6 / 2.2 %) */
        const tauF = sim.env.filmTau;
        if (fresh) { R.bind(ffb); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
        filmT += dt;
        if (dt > 0 && filmT < 10 * tauF) {
          U.decay.uK = Math.exp(-dt / tauF);
          R.bind(ffb);
          gl.enable(gl.BLEND); gl.blendFunc(gl.ZERO, gl.SRC_ALPHA);
          P.decay.use(); R.gpu.uniforms(P.decay, U.decay); R.gpu.fullscreen();
          gl.disable(gl.BLEND);
        }
        stampTracks(R, sim.tracks, sim.nTracks());
        /* the height map: micro-drops, then every bead and running drop (MAX of exp(h)) */
        R.bind(hfb);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND); gl.blendEquation(gl.MAX); gl.blendFunc(gl.ONE, gl.ONE);
        if (microE > 0.002) {
          /* [r3] below pane.microFine's tier the 5 px layer (radii .45-1.6 px, mostly under a pixel's worth of
             image) is skipped: its 40k instances a megapixel cost the iGPU more than they show */
          U.micro.uFilm = film; U.micro.uGrid[3] = microE; U.micro.uGlass = glassU; U.micro.uDry = microD;
          U.micro.uMs[0] = mapScale; U.micro.uMs[1] = R.p("pane.l2"); U.micro.uMs[2] = R.p("pane.rimFix");
          /* [r9f] the lighthouse's lamp in glass px (R.beacon.uv, contract section 10: unjittered, y up), for the micro VS's keep-out */
          const B = R.beacon, lg = U.micro.uLampG, lon = B && B.uv && B.uv[0] > -0.5 ? Math.min(1, Math.max(0, B.on || 0)) : 0;
          lg[0] = lon ? B.uv[0] * C[0] : -1e4; lg[1] = lon ? B.uv[1] * C[1] : -1e4; lg[2] = R.p("pane.lampKeep"); lg[3] = lg[2] > 0 ? lon : 0;
          U.micro.uFirst[0] = fineE > 0.002 ? 0 : U.micro.uGrid[0]; U.micro.uFirst[1] = fineE;
          P.micro.use(); R.gpu.uniforms(P.micro, U.micro);
          gl.bindVertexArray(mvao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, microN - U.micro.uFirst[0]); gl.bindVertexArray(null);
        }
        const n = sim.fill(inst, MAXI);
        const nr = runs.n;
        for (let k = 0; k < nr && n + k < MAXI; k++) {
          const o = (n + k) * IROW; inst[o] = runs.x[k]; inst[o + 1] = runs.y[k]; inst[o + 2] = runs.r[k];
          inst[o + 3] = 1.02 + 0.8 + 2.6 * Math.min(1, runs.v[k] / 90); inst[o + 4] = 0; inst[o + 5] = 1; inst[o + 6] = 1; inst[o + 7] = 1;
        }
        const ni = Math.min(MAXI, n + nr);
        lastN = ni;
        if (ni) {
          gl.bindBuffer(gl.ARRAY_BUFFER, ibuf);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, inst, 0, ni * IROW);
          U.cap.uRimFix = R.p("pane.rimFix");
          P.cap.use(); R.gpu.uniforms(P.cap, U.cap);
          gl.bindVertexArray(ivao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, ni); gl.bindVertexArray(null);
        }
        gl.blendEquation(gl.FUNC_ADD); gl.disable(gl.BLEND);
        /* the mist (inside): ease, then the runs clear their tracks */
        const mistW = F.W.mist || 0;
        runs.mistE += (mistW - runs.mistE) * (1 - Math.exp(-dt / 6));
        if (ahead) runs.mistE = mistW;
        if (mistW > 0.001 || runs.mistE > 0.001 || fresh) {
          const src = mist[mcur], dst = 1 - mcur;
          U.mist.uPrev = src;
          U.mist.uK[0] = ahead || fresh ? 1 : 1 - Math.exp(-dt / 6); U.mist.uK[1] = ahead || fresh ? 1 : 1 - Math.exp(-dt / 4);
          U.mist.uDecay = Math.exp(-dt / 25);
          R.draw(P.mist, mfb[dst], U.mist);
          mcur = dst;
          /* inside runs: once the mist is over .7 one forms every 30-90 s and runs down, clearing a track */
          runs.t += dt;
          if (runs.mistE > 0.7 && !F.still && dt > 0) {
            if (!runs.over) { runs.over = true; runs.t = runs.next - 10 - 30 * rr(); }   // the first one 10-40 s in
            if (runs.t > runs.next && runs.n < 4) {
              const k = runs.n++;
              runs.x[k] = C[0] * (0.08 + 0.84 * rr()); runs.y[k] = C[1] * (0.05 + 0.35 * rr());
              runs.r[k] = 4.5 + 2.5 * rr(); runs.v[k] = 0; runs.px[k] = runs.x[k]; runs.py[k] = runs.y[k]; runs.ph[k] = rr() * 50;
              runs.t = 0; runs.next = 30 + 60 * rr();
            }
          } else if (runs.mistE <= 0.7) runs.over = false;
          let nsg = 0;
          for (let k = runs.n - 1; k >= 0; k--) {
            const pn = sim.pinAt(runs.x[k] * 1.7 + 500, runs.y[k] * 1.7);
            const tgt = Math.max(0, 30 * (runs.r[k] * 2.2 - 10 * pn));
            runs.v[k] += (tgt - runs.v[k]) * Math.min(1, dt / 0.15);
            runs.x[k] += runs.v[k] * dt * 0.25 * (Math.sin(runs.y[k] / 37 + runs.ph[k]) * 0.8);
            runs.y[k] += runs.v[k] * dt;
            runs.r[k] += dt * 0.15;                                 // it gathers the condensate as it goes
            if (nsg < 64) { const o = nsg * 6; trk[o] = runs.px[k]; trk[o + 1] = runs.py[k]; trk[o + 2] = runs.x[k]; trk[o + 3] = runs.y[k]; trk[o + 4] = runs.r[k] * 2.8; trk[o + 5] = 1; nsg++; }
            runs.px[k] = runs.x[k]; runs.py[k] = runs.y[k];
            if (runs.y[k] - runs.r[k] > C[1]) {
              const j = --runs.n;
              runs.x[k] = runs.x[j]; runs.y[k] = runs.y[j]; runs.r[k] = runs.r[j]; runs.v[k] = runs.v[j]; runs.px[k] = runs.px[j]; runs.py[k] = runs.py[j]; runs.ph[k] = runs.ph[j];
            }
          }
          if (nsg) {
            gl.bindBuffer(gl.ARRAY_BUFFER, tbuf);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, trk, 0, nsg * 6);
            R.bind(mfb[mcur]);
            gl.enable(gl.BLEND); gl.blendEquation(gl.MAX); gl.blendFunc(gl.ONE, gl.ONE);
            gl.colorMask(false, true, false, false);
            P.mistSeg.use(); R.gpu.uniforms(P.mistSeg, U.mseg);
            gl.bindVertexArray(tvao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nsg); gl.bindVertexArray(null);
            gl.colorMask(true, true, true, true);
            gl.blendEquation(gl.FUNC_ADD); gl.disable(gl.BLEND);
          }
        }
        fresh = false;
      },
    },
  };
})());
