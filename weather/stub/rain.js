/* STUB rain (pane stream C replaces passes/rain.js; this copy in stub/ stays frozen).
   The rain slot owns RAIN: it clears it every frame and draws the near streaks into it,
   premultiplied. Placeholder: cleared only. */
WX.pass({
  name: "rain",
  slots: {
    rain(R) {
      const gl = R.gl;
      R.bind("rain");
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
  },
});
