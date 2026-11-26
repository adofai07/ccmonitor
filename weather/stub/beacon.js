/* STUB beacon (stream L replaces passes/beacon.js; this copy in stub/ stays frozen).
   The lighthouse (contract section 10): R.beacon and the uBeacon* fields, so a receiver (the sea's path under the lamp,
   wxBeacon) works with live= subsets. Placeholder: the lamp where WX.BEACON puts it, in the accent the API hands over
   (F.accent, taken at once; the unknown grey without one), the photocell and the turning beams as the contract has them;
   nothing is drawn. */
WX.pass((function () {
  const K = WX.BEACON, D2R = Math.PI / 180;
  const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return {
    name: "beacon",
    ubo(F, R, set) {
      const B = R.beacon || (R.beacon = WX.beaconDefaults());
      const x = K.km * 1000 * Math.sin(K.az * D2R), z = K.km * 1000 * Math.cos(K.az * D2R);
      B.pos[0] = x; B.pos[1] = K.lampM - (x * x + z * z) / (2 * WX.R_G * 1000); B.pos[2] = z;
      const t = F.accent || K.unknown, c = [lin(t[0]), lin(t[1]), lin(t[2])];
      const Y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] || 1;
      for (let i = 0; i < 3; i++) { B.rgb[i] = c[i] / Y; B.srgb[i] = t[i]; }
      const el = Math.asin(Math.max(-1, Math.min(1, F.sun.dir[1]))) / D2R, day = WX.util.smooth(K.dayEl[0], K.dayEl[1], el);
      B.I = WX.util.lerp(K.cd.lanternNight, K.cd.lanternDay, day) / 128000;
      B.Ib = WX.util.lerp(K.cd.beamNight, K.cd.beamDay, day) / 128000;
      B.angle = 2 * Math.PI * ((F.t.ocean / K.turn) % 1);
      B.sigma[0] = K.sigmaDeg[0] * D2R; B.sigma[1] = K.sigmaDeg[1] * D2R;
      let db = Math.atan2(-x, -z) - B.angle; db -= Math.PI * Math.round(db / Math.PI);
      B.eye = Math.exp((-0.5 * db * db) / (B.sigma[0] * B.sigma[0]));
      B.on = 1;
      set("uBeacon", B.pos[0], B.pos[1], B.pos[2], B.I);
      set("uBeaconC", B.rgb[0], B.rgb[1], B.rgb[2], B.Ib);
      set("uBeaconB", B.angle, B.sigma[0], B.sigma[1], 1);
    },
    slots: {},
  };
})());
