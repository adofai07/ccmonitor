/* ═══════════════════════ Weather lab: GL helpers ═══════════════════════
   Owner after the skeleton: the director/core stream (E). Changes are additive only: no helper
   changes its signature or meaning while the other streams build on it.

   WX.gpu(gl) -> G, the helpers every pass uses through R.gpu:
     G.fmt[name]                    internal format, format, type
     G.tex2D(w, h, fmt, o)          {tex, w, h, levels, fmt, target}   o: {mips, filter, wrap, data, aniso,
                                    compare} ([v1.1] compare: true sets LEQUAL compare mode for a sampler2DShadow)
     G.tex3D(w, h, d, fmt, o)       volumes are FILLED through a 2D target + copyTexSubImage3D, never rendered to
     G.texArray(w, h, n, fmt, o)    2D arrays; their layers may be render targets
     G.fbo(colors, depth)           colors: [{tex, level, layer}] or texture objects; depth: renderbuffer or null.
                                    Throws when incomplete (the caller's build fails -> the glass page)
                                    [v1.1] depth may also be a depth texture from tex2D(w, h, "depth16"|"depth24"),
                                    and colors may be [] (a depth-only target, e.g. a shadow map)
     G.depthRB(w, h)                DEPTH_COMPONENT24 renderbuffer
     G.program(vsSrc, fsSrc, name)  {ready() -> bool, use() -> uniform map, prog}; compiles in parallel where
                                    KHR_parallel_shader_compile exists, else lazily one link per pump()
                                    [critic] once linked, p.samplers counts its active samplers; over 16 it warns
     G.pump()                       advance pending compiles (the core calls it once a frame)
     G.uniforms(P, obj)             [E] a texture made by an older G (kept across a restore) binds as none
                                    set uniforms by name; texture values {tex, target} take units 18+ ([critic] WX.PRIVATE_UNIT0 since v1.1)
                                    [E] a library's own sampler (WX.LIBTEX) is set to its fixed unit at link, and
                                    G.uniforms steps over that unit
     G.fullscreen()                 draw the fullscreen triangle (attribute 0)
     G.readback(fb, x, y, w, h, cb) async PBO + fence; cb(Float32Array) a few frames later; never stalls
     G.poll()                       resolve finished readbacks (the core calls it once a frame)
     G.counts.uploads               [1.2] the uploads that can stall a frame, counted at the GL calls on this
                                    context (R.stats.uploads; contract section 9): texImage2D/3D, texSubImage2D/3D
                                    and their compressed forms when given pixels, and bufferData with data and
                                    STATIC_DRAW. Dynamic buffer updates and readbacks do not count.
*/
/* [E] textures a GLSL library samples itself, bound by the core before every slot at fixed units from the
   top of the range down (the night library's Milky Way at 30; 31 stays the passes' scratch unit, as the stubs use
   it for generateMipmap). A pass's private textures use 18..29, and G.uniforms steps over a library's unit. */
WX.LIBTEX = WX.LIBTEX || {};                 // [1.2] declared in the contract (section 4); kept here for old loaders
WX.LIBTEX_UNIT0 = 30;
WX.gpu = function (gl) {
  /* [E] every texture object made here carries this G: one from an older context (a pass that kept it
     across a restore or a Quality swap) binds as none instead of as a foreign object */
  const self = {};
  let staleNoted = false;
  const ext = {
    cbf: gl.getExtension("EXT_color_buffer_float"),
    flin: gl.getExtension("OES_texture_float_linear"),
    aniso: gl.getExtension("EXT_texture_filter_anisotropic"),
    timer: gl.getExtension("EXT_disjoint_timer_query_webgl2"),
    par: gl.getExtension("KHR_parallel_shader_compile"),
    fblend: gl.getExtension("EXT_float_blend"),
    dbg: gl.getExtension("WEBGL_debug_renderer_info"),
  };
  const renderer = String(gl.getParameter(ext.dbg ? ext.dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || "");
  /* [1.2] count uploads where they happen, so no pass has to remember to (the context's own methods are
     wrapped once; a second WX.gpu on the same context, as after a restore, reuses the first wrap) */
  const counts = gl.__wxCounts || (gl.__wxCounts = { uploads: 0 });
  if (!gl.__wxWrapped) {
    gl.__wxWrapped = true;
    const pixels = (args) => { for (let i = 5; i < args.length; i++) { const a = args[i]; if (a !== null && typeof a === "object") return true; } return false; };
    for (const k of ["texImage2D", "texSubImage2D", "texImage3D", "texSubImage3D", "compressedTexImage2D", "compressedTexSubImage2D",
                     "compressedTexImage3D", "compressedTexSubImage3D"]) {
      const f = gl[k];
      if (typeof f !== "function") continue;
      gl[k] = function () { if (pixels(arguments)) counts.uploads++; return f.apply(gl, arguments); };
    }
    const bd = gl.bufferData;
    gl.bufferData = function (target, data, usage) {
      if (data !== null && typeof data === "object" && usage === gl.STATIC_DRAW) counts.uploads++;
      return bd.apply(gl, arguments);
    };
  }
  const fmt = {
    rgba8: [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE],
    rg8: [gl.RG8, gl.RG, gl.UNSIGNED_BYTE],
    r8: [gl.R8, gl.RED, gl.UNSIGNED_BYTE],
    rgba16f: [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT],
    rg16f: [gl.RG16F, gl.RG, gl.HALF_FLOAT],
    r16f: [gl.R16F, gl.RED, gl.HALF_FLOAT],
    rgba32f: [gl.RGBA32F, gl.RGBA, gl.FLOAT],
    r32f: [gl.R32F, gl.RED, gl.FLOAT],
    r11g11b10f: [gl.R11F_G11F_B10F, gl.RGB, gl.HALF_FLOAT],
    /* [v1.1] */
    srgba8: [gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE],
    rg32f: [gl.RG32F, gl.RG, gl.FLOAT],
    depth16: [gl.DEPTH_COMPONENT16, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT],
    depth24: [gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT],
  };
  const levelsOf = (w, h) => Math.floor(Math.log2(Math.max(w, h, 1))) + 1;
  function params(target, o, levels) {
    const lin = o.filter !== "nearest";
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, levels > 1 ? (lin ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST) : lin ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, lin ? gl.LINEAR : gl.NEAREST);
    const wrap = o.wrap === "repeat" ? gl.REPEAT : o.wrap === "mirror" ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, wrap);
    if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, wrap);
    if (o.aniso && ext.aniso) gl.texParameterf(target, ext.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(o.aniso, 16));
    if (o.compare) {
      gl.texParameteri(target, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
      gl.texParameteri(target, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    }
  }
  function tex2D(w, h, f, o = {}) {
    const [i, F, T] = fmt[f];
    const levels = o.mips ? (o.levels || levelsOf(w, h)) : 1;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, levels, i, w, h);
    if (o.data) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, F, T, o.data);
    params(gl.TEXTURE_2D, o, levels);
    return { tex, w, h, levels, fmt: f, target: gl.TEXTURE_2D, g: self };
  }
  function tex3D(w, h, d, f, o = {}) {
    const [i] = fmt[f];
    const levels = o.mips ? levelsOf(Math.max(w, h), d) : 1;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texStorage3D(gl.TEXTURE_3D, levels, i, w, h, d);
    params(gl.TEXTURE_3D, o, levels);
    return { tex, w, h, d, levels, fmt: f, target: gl.TEXTURE_3D, g: self };
  }
  function texArray(w, h, n, f, o = {}) {
    const [i] = fmt[f];
    const levels = o.mips ? levelsOf(w, h) : 1;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, i, w, h, n);
    params(gl.TEXTURE_2D_ARRAY, o, levels);
    return { tex, w, h, n, levels, fmt: f, target: gl.TEXTURE_2D_ARRAY, g: self };
  }
  function depthRB(w, h) {
    const rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    return rb;
  }
  function fbo(colors, depth) {
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const list = colors.map((c) => (c.tex && c.tex.tex ? c : { tex: c }));
    list.forEach((c, k) => {
      const t = c.tex;
      if (t.target === gl.TEXTURE_2D_ARRAY || t.target === gl.TEXTURE_3D)
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, t.tex, c.level || 0, c.layer || 0);
      else gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, gl.TEXTURE_2D, t.tex, c.level || 0);
    });
    if (depth && depth.tex) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth.tex, 0);
    else if (depth) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.drawBuffers(list.length ? list.map((_, k) => gl.COLOR_ATTACHMENT0 + k) : [gl.NONE]);
    if (!list.length) gl.readBuffer(gl.NONE);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (st !== gl.FRAMEBUFFER_COMPLETE && !gl.isContextLost()) throw new Error("framebuffer incomplete 0x" + st.toString(16));
    const t0 = list[0] ? list[0].tex : depth && depth.tex ? depth : null, lv = list[0] ? list[0].level || 0 : 0;
    return { fb, w: t0 ? Math.max(1, t0.w >> lv) : 0, h: t0 ? Math.max(1, t0.h >> lv) : 0, colors: list.length };
  }

  /* ── programs ── */
  const pending = [];
  function shader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  }
  function fail(p, name) {
    const log = (gl.getShaderInfoLog(p.vs) || "") + (gl.getShaderInfoLog(p.fs) || "") + (gl.getProgramInfoLog(p.prog) || "");
    const m = /0:(\d+)/.exec(log), src = (gl.getShaderInfoLog(p.vs) ? p.vsSrc : p.fsSrc).split("\n");
    const ln = m ? +m[1] : 0;
    const ctx = ln ? "\n" + src.slice(Math.max(0, ln - 3), ln + 2).map((l, k) => ln - 2 + k + ": " + l).join("\n") : "";
    throw new Error("program " + name + " failed: " + log + ctx);
  }
  function finish(p) {
    if (!gl.getProgramParameter(p.prog, gl.LINK_STATUS) && !gl.isContextLost()) fail(p, p.name);
    const u = {};
    const n = gl.getProgramParameter(p.prog, gl.ACTIVE_UNIFORMS) || 0;
    for (let k = 0; k < n; k++) {
      const a = gl.getActiveUniform(p.prog, k);
      const name = a.name.replace(/\[0\]$/, "");
      u[name] = { loc: gl.getUniformLocation(p.prog, a.name), type: a.type, size: a.size };
    }
    /* [critic] WebGL2 guarantees only 16 texture units per shader stage (MAX_TEXTURE_IMAGE_UNITS): Chrome
       on macOS and most phones report 16, the lab's GPUs 32, so a program over 16 would pass here and fail
       to link there. Count the active samplers (both stages together, contract ones included) and warn. */
    let ns = 0;
    for (const k in u) if (TEXT[u[k].type] !== undefined) ns += u[k].size;
    p.samplers = ns;
    if (ns > 16) console.warn("program " + p.name + " uses " + ns + " samplers; WebGL2 guarantees 16 per stage");
    const bi = gl.getUniformBlockIndex(p.prog, "WxFrame");
    if (bi !== gl.INVALID_INDEX) gl.uniformBlockBinding(p.prog, bi, 0);
    gl.useProgram(p.prog);
    for (const t of Object.values(WX.TEX)) if (u[t.s]) gl.uniform1i(u[t.s].loc, t.unit);
    for (const s in WX.LIBTEX) if (u[s]) gl.uniform1i(u[s].loc, WX.LIBTEX[s].unit);   // [E] library textures
    p.u = u;
    p.done = true;
  }
  function program(vsSrc, fsSrc, name) {
    const p = { name, vsSrc, fsSrc, prog: null, done: false, issued: false, u: null };
    const issue = () => {
      p.vs = shader(gl.VERTEX_SHADER, vsSrc);
      p.fs = shader(gl.FRAGMENT_SHADER, fsSrc);
      p.prog = gl.createProgram();
      gl.attachShader(p.prog, p.vs);
      gl.attachShader(p.prog, p.fs);
      gl.bindAttribLocation(p.prog, 0, "aPos");
      gl.linkProgram(p.prog);
      p.issued = true;
    };
    if (ext.par) issue(); else pending.push({ p, issue });
    p.ready = () => {
      if (p.done) return true;
      if (!p.issued) return false;
      if (ext.par && !gl.getProgramParameter(p.prog, ext.par.COMPLETION_STATUS_KHR)) return false;
      finish(p);
      return true;
    };
    p.use = () => { if (!p.done && !p.ready()) throw new Error("program " + name + " used before ready"); gl.useProgram(p.prog); return p.u; };
    return p;
  }
  /* without the parallel extension: one program per frame, so no frame blocks for long */
  function pump() { const job = pending.shift(); if (job) job.issue(); }

  const TEXT = {};
  TEXT[gl.SAMPLER_2D] = gl.TEXTURE_2D; TEXT[gl.SAMPLER_3D] = gl.TEXTURE_3D; TEXT[gl.SAMPLER_2D_ARRAY] = gl.TEXTURE_2D_ARRAY;
  TEXT[gl.INT_SAMPLER_2D] = gl.TEXTURE_2D; TEXT[gl.UNSIGNED_INT_SAMPLER_2D] = gl.TEXTURE_2D;
  TEXT[gl.SAMPLER_2D_SHADOW] = gl.TEXTURE_2D;   // [v1.1]
  const libUnit = {};
  function uniforms(P, obj) {
    for (const s in WX.LIBTEX) libUnit[WX.LIBTEX[s].unit] = true;
    let unit = WX.PRIVATE_UNIT0;
    const u = P.u;
    for (const k in obj) {
      const f = u[k];
      if (!f) continue;
      const v = obj[k], L = f.loc;
      switch (f.type) {
        case gl.FLOAT: (typeof v === "number" ? gl.uniform1f(L, v) : gl.uniform1fv(L, v)); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(L, v); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(L, v); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(L, v); break;
        case gl.INT: case gl.BOOL: (typeof v === "number" ? gl.uniform1i(L, v) : gl.uniform1iv(L, v)); break;
        case gl.INT_VEC2: gl.uniform2iv(L, v); break;
        case gl.INT_VEC4: gl.uniform4iv(L, v); break;            // [v1.1]
        case gl.FLOAT_MAT3: gl.uniformMatrix3fv(L, false, v); break;
        case gl.FLOAT_MAT4: gl.uniformMatrix4fv(L, false, v); break;
        default: {
          const tgt = TEXT[f.type];
          if (tgt === undefined || WX.LIBTEX[k]) break;
          while (libUnit[unit]) unit++;
          gl.activeTexture(gl.TEXTURE0 + unit);
          let t = v && v.tex ? v.tex : v;
          if (v && v.g && v.g !== self) {
            t = null;
            if (!staleNoted) { staleNoted = true; console.info("weather: " + P.name + "'s " + k + " is from an older context; bound as none"); }
          }
          gl.bindTexture(tgt, t);
          gl.uniform1i(L, unit);
          unit++;
        }
      }
    }
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  function fullscreen() { gl.bindVertexArray(vao); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null); }

  /* ── async readback: PBO + fence, polled; never a stall ── */
  const reads = [];
  function readback(fb, x, y, w, h, cb) {
    if (reads.length > 6) return false;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, w * h * 16, gl.STREAM_READ);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, 0);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    reads.push({ buf, sync, w, h, cb });
    return true;
  }
  function poll() {
    for (let k = reads.length - 1; k >= 0; k--) {
      const r = reads[k];
      const st = gl.clientWaitSync(r.sync, 0, 0);
      if (st !== gl.ALREADY_SIGNALED && st !== gl.CONDITION_SATISFIED) continue;
      const out = new Float32Array(r.w * r.h * 4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, r.buf);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteSync(r.sync);
      gl.deleteBuffer(r.buf);
      reads.splice(k, 1);
      try { r.cb(out); } catch (e) { console.error(e); }
    }
  }

  return { gl, ext, renderer, fmt, tex2D, tex3D, texArray, depthRB, fbo, program, pump, uniforms, fullscreen,
           readback, poll, pendingPrograms: () => pending.length, counts };
};
