/* ═══════════════════════ Weather lab: the cove's asset loader (v1.1, stream F) ═══════════════════════
   Owner: the scenery stream (F). Merged into index.html after renderer.js. The API is the contract's
   (contract.js WX.ASSETS); every call the stub coast makes keeps working, because the other streams run
   the stub coast against this file:

     L = WX.assets.loader(base)          base "weather/" (relative to the page)
     L.manifest()  -> Promise<manifest>  manifest.json (WX.ASSETS.schema); null when there is none or it is empty
     L.want(ids, o)                      queue the cove's files in four stages (DESIGN 13.3, Staging):
                                           0 the coarsest LOD of every asset           (the cove can stand up)
                                           1 the terrain layers and every base colour  (it fades in on these)
                                           2 the finer LODs                            (0.5 s cross-fades)
                                           3 the normal and ORM maps, largest on screen first
                                         o: { texPx, tier, lods: { id: [lod...] } | [lod...], px: { id: on-screen px },
                                              metal: [ids whose ORM keeps its metal channel], terrainArrays: bool, terrainPx,
                                              matScale: { id: { material: factor } },
                                              wires: { id: [material names] }: [r2] packed as triangle instances }
                                         Each texture is decoded at min(shipped px, texPx, the model's tex.gpu[tier]).
                                         [r2] wires: triangle instances (triJob), not per-vertex radii
     L.step(R, ms)                       once a frame: GL uploads until ms of main thread are spent (at least one)
     L.mesh(id, lod) -> null | { parts: [{ name, node, xform, own, prims: [{ vao, count, type, offset, mat, mode, attrs, ebo, wire,
                                 tris: { buf, n, layout, alts } (a wire material's triangle instances, widest first, and
                                 their least altitudes in mesh units, [r2]) }],
                                 bounds, ownBounds }],
                                 lod, materials, bounds }    the nearest LOD that has arrived
                                         xform: the node's matrix with every parent's (mesh units -> metres);
                                         own: the same less the scene root's transform (a kit's showcase offset)
     L.has(id, lod) -> bool              that exact LOD has arrived
     L.mat(id, name) -> { base, nrm, orm, alphaScale, stamp } of whatever has arrived (null members until then)
     L.terrain()   -> [{ layer, tileSizeM, albedo, normal, orm, height }] (2D textures or null; not with terrainArrays)
     L.terrainArrays() -> null | { albedo, normal, ormh, layers: [layer names], px }   the four layers as three
                                         TEXTURE_2D_ARRAYs (albedo SRGB8_ALPHA8, normal RG8, AO/rough/height RGBA8)
     L.tex(file)   -> null | { tex, w, h, target }
     L.progress    -> { got, of, uploads, failed, stage, mem: { tex, mesh } }   (mem in bytes, for R.coast.mem)

   CSP: fetch() of base-relative names only, images through createImageBitmap(Blob). No <img>, no blob:
   URL, no worker, no WebAssembly. A failed fetch, parse or decode drops that piece (counted in
   progress.failed, one console.warn) and the cove draws without it. An empty manifest asks for nothing
   and says nothing.
   GL: every attribute is bound as stored (KHR_mesh_quantization's integer types, normalised or not),
   each buffer view goes into its own buffer (WebGL forbids one buffer as both index and vertex data),
   and the node's transform (the dequantisation) is returned as xform.                               */
WX.assets = (function () {
  const MAGIC = 0x46546c67, JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;
  const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const KNOWN_EXT = ["KHR_mesh_quantization", "KHR_texture_transform", "KHR_materials_emissive_strength", "EXT_texture_webp"];
  const ATTR = { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, TANGENT: 3 };
  const LAYERS = ["rock", "cliff-top grass", "sand and pebbles", "wet rock"];      // the arrays' layer order

  /* GLB -> { json, bin } (bin: Uint8Array over the BIN chunk) */
  function parseGLB(buf) {
    const dv = new DataView(buf);
    if (buf.byteLength < 20 || dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== 2) throw new Error("not a glTF 2.0 GLB");
    let o = 12, json = null, bin = null;
    while (o + 8 <= buf.byteLength) {
      const len = dv.getUint32(o, true), type = dv.getUint32(o + 4, true);
      if (o + 8 + len > buf.byteLength) throw new Error("GLB chunk past the end");
      if (type === JSON_CHUNK && !json) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, o + 8, len)));
      else if (type === BIN_CHUNK && !bin) bin = new Uint8Array(buf, o + 8, len);
      o += 8 + ((len + 3) & ~3);
    }
    if (!json) throw new Error("GLB without JSON");
    for (const e of json.extensionsRequired || []) if (!KNOWN_EXT.includes(e)) throw new Error("GLB requires " + e);
    return { json, bin };
  }
  function accessor(g, i) {
    const a = g.json.accessors[i];
    if (!a || a.bufferView === undefined || a.sparse) throw new Error("accessor " + i + " unsupported");
    const v = g.json.bufferViews[a.bufferView];
    const n = NCOMP[a.type], b = BYTES[a.componentType];
    return { view: a.bufferView, offset: a.byteOffset || 0, stride: v.byteStride || 0, type: a.componentType, size: n,
             normalized: !!a.normalized, count: a.count, min: a.min, max: a.max, bytes: n * b };
  }
  /* column-major 4x4 helpers */
  const I4 = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const mul = (A, B) => { const C = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += A[k * 4 + r] * B[c * 4 + k]; C[c * 4 + r] = s; } return C; };
  const xf = (M, p) => [M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14]];
  function nodeMatrix(n) {
    if (n.matrix) return new Float32Array(n.matrix);
    const [x, y, z, w] = n.rotation || [0, 0, 0, 1], [sx, sy, sz] = n.scale || [1, 1, 1], [tx, ty, tz] = n.translation || [0, 0, 0];
    return new Float32Array([
      (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
      2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
      2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1]);
  }
  /* every node of the scene that carries a mesh, with the product of its parents' transforms (xform), the same
     without the scene root's own transform (own: a kit's part at its own place, less the showcase offset), and
     the name of the root it hangs from (a kit's part name, e.g. modular_wooden_pier_section_02) */
  function meshNodes(json) {
    const nodes = json.nodes || [], out = [];
    const visit = (i, P, Q, root) => {
      const n = nodes[i], L = nodeMatrix(n), M = mul(P, L), O = root === null ? I4() : mul(Q, L);
      const name = root === null ? n.name || "node" + i : root;
      if (n.mesh !== undefined) out.push({ mesh: n.mesh, xform: M, own: root === null ? (n.children && n.children.length ? I4() : L) : O, name, node: n.name || "" });
      for (const c of n.children || []) visit(c, M, root === null ? I4() : O, name);
    };
    const roots = json.scenes && json.scenes.length ? json.scenes[json.scene || 0].nodes : nodes.map((_, i) => i);
    for (const r of roots) visit(r, I4(), I4(), null);
    if (!out.length && json.meshes && json.meshes.length) out.push({ mesh: 0, xform: I4(), own: I4(), name: "mesh0", node: "" });
    return out;
  }
  /* [r2] A thin-wire primitive (the ship's rigging material: ropes, ratline ladders, masts, yards, blocks, the tops) as
     TRIANGLE INSTANCES: one instance per triangle, 28 bytes (its three corners as the GLB stores them when that is
     normalised int16, padded to 4 components, else 44 bytes of floats; and the half-float uv of its centroid). The coast draws each one as a
     screen-aligned quad round its projection and covers each pixel by the area of the pixel's box the triangle
     covers, so a rope 0.1 px wide adds 0.1 of its colour to the pixels it crosses whatever its sub-pixel position:
     it fades with distance and cannot break into dots or crawl.
     Why per triangle: the decimated LODs collapsed most rope tubes into single sliver triangles or quads (LOD2: 3278
     of 3788 pieces), whole ratline ladders are single pieces, and stays sag. Round 1 pushed vertices out along their
     normals to a 1 px minimum, which never widened a sliver; a per-piece line fit drew a ladder as one solid bar. */
  const f2h = (() => {
    const f = new Float32Array(1), u = new Uint32Array(f.buffer);
    return (x) => {
      f[0] = x; const b = u[0], sgn = (b >>> 16) & 0x8000, e = ((b >>> 23) & 0xff) - 112, m = b & 0x7fffff;
      return e <= 0 ? sgn : e >= 31 ? sgn | 0x7c00 : sgn | (e << 10) | (m >>> 13);
    };
  })();
  function triInstances(g, p) { const it = triJob(g, p); let r; while (!(r = it.next()).done); return r.value; }
  function* triJob(g, p) {
    const a = accessor(g, p.attributes.POSITION), n = a.count, ia = accessor(g, p.indices), iv = g.json.bufferViews[ia.view];
    const io = g.bin.byteOffset + (iv.byteOffset || 0) + ia.offset, idx = ia.type === 5125 ? new Uint32Array(g.bin.buffer, io, ia.count) : new Uint16Array(g.bin.buffer, io, ia.count);
    const UV = new Float32Array(n * 3);
    if (p.attributes.TEXCOORD_0 !== undefined) yield* floatsOfN(g, p.attributes.TEXCOORD_0, UV, 2);
    const nt = Math.floor(ia.count / 3), snorm = a.type === 5122 && a.normalized;
    if (snorm) {
      /* the corners as stored (normalised int16), the uv as two halves: 12 shorts a triangle */
      const v = g.json.bufferViews[a.view], base = g.bin.byteOffset + (v.byteOffset || 0) + a.offset, st = (a.stride || a.bytes) / 2;
      const src = new Int16Array(g.bin.buffer, base - (base % 2), ((n - 1) * st * 2 + 6 + (base % 2)) / 2 | 0), sh = (base % 2) / 2;
      /* 14 shorts a triangle: three 4-component corners (the 4th 0: three 16-bit components are an optional vertex
         format on Vulkan, which ANGLE converts on every draw) and the uv as two halves */
      const out = new Int16Array(nt * 14), ou = new Uint16Array(out.buffer), k = 1 / 32767;
      const ord = yield* byAltitude(nt, (t, c, q) => src[idx[t * 3 + c] * st + sh + q] * k);
      for (let o = 0; o < nt; o++) {
        const t = ord.order[o];
        let su = 0, sv = 0;
        for (let c = 0; c < 3; c++) {
          const i = idx[t * 3 + c], s0 = i * st + sh;
          out[o * 14 + c * 4] = src[s0]; out[o * 14 + c * 4 + 1] = src[s0 + 1]; out[o * 14 + c * 4 + 2] = src[s0 + 2];
          su += UV[i * 3]; sv += UV[i * 3 + 1];
        }
        ou[o * 14 + 12] = f2h(su / 3); ou[o * 14 + 13] = f2h(sv / 3);
        if ((o & 4095) === 4095) yield;
      }
      return { data: out, n: nt, layout: "snorm16", alts: ord.alts };
    }
    const P = new Float32Array(n * 3);
    yield* floatsOf(g, p.attributes.POSITION, P);
    const out = new Float32Array(nt * 11);
    const ord = yield* byAltitude(nt, (t, c, q) => P[idx[t * 3 + c] * 3 + q]);
    for (let o = 0; o < nt; o++) {
      const t = ord.order[o];
      let su = 0, sv = 0;
      for (let c = 0; c < 3; c++) { const i = idx[t * 3 + c]; out.set(P.subarray(i * 3, i * 3 + 3), o * 11 + c * 3); su += UV[i * 3]; sv += UV[i * 3 + 1]; }
      out[o * 11 + 9] = su / 3; out[o * 11 + 10] = sv / 3;
      if ((o & 4095) === 4095) yield;
    }
    return { data: out, n: nt, layout: "f32", alts: ord.alts };
  }
  /* the triangles in order of their least altitude (mesh units), widest first: a pass that wants only the spars
     (masts, yards: the coast's over-sea pass and its mirror) draws the first ones */
  function* byAltitude(nt, at) {
    const alt = new Float32Array(nt);
    for (let t = 0; t < nt; t++) {
      const ax = at(t, 0, 0), ay = at(t, 0, 1), az = at(t, 0, 2), bx = at(t, 1, 0) - ax, by = at(t, 1, 1) - ay, bz = at(t, 1, 2) - az;
      const cx = at(t, 2, 0) - ax, cy = at(t, 2, 1) - ay, cz = at(t, 2, 2) - az;
      const ar = Math.hypot(by * cz - bz * cy, bz * cx - bx * cz, bx * cy - by * cx);
      const lm = Math.max(bx * bx + by * by + bz * bz, cx * cx + cy * cy + cz * cz, (cx - bx) ** 2 + (cy - by) ** 2 + (cz - bz) ** 2);
      alt[t] = lm > 0 ? ar / Math.sqrt(lm) : 0;
      if ((t & 4095) === 4095) yield;
    }
    const order = Array.from({ length: nt }, (_, i) => i).sort((a, b) => alt[b] - alt[a]);
    yield;
    return { order, alts: Float32Array.from(order, (i) => alt[i]) };
  }
  /* an accessor's components as floats (normalised integers mapped as glTF says), yielding now and then */
  function* floatsOf(g, ai, out) {
    const a = accessor(g, ai), v = g.json.bufferViews[a.view];
    const buf = g.bin.buffer, b0 = g.bin.byteOffset, base = b0 + (v.byteOffset || 0) + a.offset, stride = a.stride || a.bytes;
    const k = a.normalized ? (a.type === 5122 ? 1 / 32767 : a.type === 5120 ? 1 / 127 : a.type === 5123 ? 1 / 65535 : a.type === 5121 ? 1 / 255 : 1) : 1;
    /* typed views over the interleaved data (each component type's size divides the offsets of a valid GLB) */
    const cb = BYTES[a.type], T = a.type === 5126 ? Float32Array : a.type === 5122 ? Int16Array : a.type === 5123 ? Uint16Array : a.type === 5120 ? Int8Array : Uint8Array;
    const n = a.count, src = new T(buf, base - (base % cb), ((n - 1) * stride + 3 * cb + (base % cb)) / cb | 0), sh = (base % cb) / cb, st = stride / cb;
    const lo = a.normalized ? -1 : -Infinity;       // a normalised signed integer maps to max(c / max, -1)
    for (let i = 0; i < n; i++) {
      const o = i * st + sh;
      out[i * 3] = Math.max(src[o] * k, lo); out[i * 3 + 1] = Math.max(src[o + 1] * k, lo); out[i * 3 + 2] = Math.max(src[o + 2] * k, lo);
      if ((i & 2047) === 2047) yield;
    }
    return n;
  }
  /* a 2-component accessor (uv): the 3-component reader would run past its stride */
  function* floatsOfN(g, ai, out, comps) {
    const a = accessor(g, ai);
    if (a.size === 3) { yield* floatsOf(g, ai, out); return; }
    const v = g.json.bufferViews[a.view], buf = g.bin.buffer, base = g.bin.byteOffset + (v.byteOffset || 0) + a.offset, stride = a.stride || a.bytes;
    const k = a.normalized ? (a.type === 5122 ? 1 / 32767 : a.type === 5120 ? 1 / 127 : a.type === 5123 ? 1 / 65535 : a.type === 5121 ? 1 / 255 : 1) : 1;
    const cb = BYTES[a.type], T = a.type === 5126 ? Float32Array : a.type === 5122 ? Int16Array : a.type === 5123 ? Uint16Array : a.type === 5120 ? Int8Array : Uint8Array;
    const n = a.count, src = new T(buf, base - (base % cb), ((n - 1) * stride + comps * cb + (base % cb)) / cb | 0), sh = (base % cb) / cb, st = stride / cb;
    for (let i = 0; i < n; i++) { const o = i * st + sh; for (let c = 0; c < comps; c++) out[i * 3 + c] = src[o + c] * k; if ((i & 4095) === 4095) yield; }
  }
  /* GPU upload of one GLB's mesh: one GL buffer per buffer view, one VAO per primitive. Each primitive also
     lists its attribute bindings (attrs, ebo), so a pass can build its own VAOs with its instance rows */
  function uploadMesh(gl, g, wires, wireJobs) {
    const bufs = {};
    let bytes = 0;
    const viewBuf = (vi, target) => {
      const key = vi + ":" + target;
      if (bufs[key]) return bufs[key];
      const v = g.json.bufferViews[vi];
      if ((v.buffer || 0) !== 0) throw new Error("external buffers unsupported");
      const b = gl.createBuffer();
      gl.bindBuffer(target, b);
      gl.bufferData(target, g.bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength), gl.STATIC_DRAW);
      bytes += v.byteLength;
      return (bufs[key] = b);
    };
    let tris = 0;
    const primsOf = {}, boxOf = {};
    const upPrim = (mesh) => (p) => {
      const vao = gl.createVertexArray(), attrs = [];
      gl.bindVertexArray(vao);
      for (const [name, loc] of Object.entries(ATTR)) {
        if (p.attributes[name] === undefined) { gl.disableVertexAttribArray(loc); continue; }
        const a = accessor(g, p.attributes[name]);
        const buf = viewBuf(a.view, gl.ARRAY_BUFFER);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.enableVertexAttribArray(loc);
        /* as stored: integer UVs and positions may be unnormalised (scaled by KHR_texture_transform or the node) */
        gl.vertexAttribPointer(loc, a.size, a.type, a.normalized, a.stride, a.offset);
        attrs.push({ loc, buf, size: a.size, type: a.type, norm: a.normalized, stride: a.stride, offset: a.offset });
        if (name === "POSITION" && a.min && a.max) {
          const k = a.normalized ? (a.type === 5122 ? 1 / 32767 : a.type === 5120 ? 1 / 127 : a.type === 5123 ? 1 / 65535 : a.type === 5121 ? 1 / 255 : 1) : 1;
          const b = (boxOf[mesh] = boxOf[mesh] || [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]]);
          for (let q = 0; q < 3; q++) { b[0][q] = Math.min(b[0][q], a.min[q] * k); b[1][q] = Math.max(b[1][q], a.max[q] * k); }
        }
      }
      let count = 0, type = 0, offset = 0, ebo = null;
      if (p.indices !== undefined) {
        const a = accessor(g, p.indices);
        ebo = viewBuf(a.view, gl.ELEMENT_ARRAY_BUFFER);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
        count = a.count; type = a.type; offset = a.offset;
      } else count = accessor(g, p.attributes.POSITION).count;
      tris += count / 3;
      gl.bindVertexArray(null);
      const mname = p.material !== undefined && g.json.materials && g.json.materials[p.material] ? g.json.materials[p.material].name : "";
      const prim = { vao, count, type, offset, ebo, attrs, wire: null, mat: p.material === undefined ? -1 : p.material, mode: p.mode === undefined ? 4 : p.mode };
      /* [r2] the thin-wire materials become triangle instances, packed in slices (wireJobs) */
      if (wires && wires.includes(mname) && p.indices !== undefined) wireJobs.push({ gen: triJob(g, p), prim });
      return prim;
    };
    /* a part's bounds in metres (its own frame), from its mesh's quantised box through the node matrix */
    const boundsOf = (mesh, M) => {
      const b = boxOf[mesh];
      if (!b) return null;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const x of [b[0][0], b[1][0]]) for (const y of [b[0][1], b[1][1]]) for (const z of [b[0][2], b[1][2]]) {
        const p = xf(M, [x, y, z]);
        for (let q = 0; q < 3; q++) { lo[q] = Math.min(lo[q], p[q]); hi[q] = Math.max(hi[q], p[q]); }
      }
      return [lo, hi];
    };
    const parts = meshNodes(g.json).map(({ mesh, xform, own, name, node }) => {
      const prims = (primsOf[mesh] = primsOf[mesh] || g.json.meshes[mesh].primitives.map(upPrim(mesh)));
      return { name, node, xform, own, prims, bounds: boundsOf(mesh, xform), ownBounds: boundsOf(mesh, own) };
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of parts) if (p.bounds) for (let q = 0; q < 3; q++) { lo[q] = Math.min(lo[q], p.bounds[0][q]); hi[q] = Math.max(hi[q], p.bounds[1][q]); }
    return { parts, bounds: [lo, hi], tris, bytes, buffers: Object.values(bufs),
             materials: (g.json.materials || []).map((x) => ({ name: x.name || "", alpha: x.alphaMode || "OPAQUE", cutoff: x.alphaCutoff === undefined ? 0.5 : x.alphaCutoff, twoSided: !!x.doubleSided,
               uv: x.pbrMetallicRoughness && x.pbrMetallicRoughness.baseColorTexture && x.pbrMetallicRoughness.baseColorTexture.extensions &&
                   x.pbrMetallicRoughness.baseColorTexture.extensions.KHR_texture_transform || null,
               factor: (x.pbrMetallicRoughness && x.pbrMetallicRoughness.baseColorFactor) || [1, 1, 1, 1],
               metal: x.pbrMetallicRoughness && x.pbrMetallicRoughness.metallicFactor !== undefined ? x.pbrMetallicRoughness.metallicFactor : 1,
               rough: x.pbrMetallicRoughness && x.pbrMetallicRoughness.roughnessFactor !== undefined ? x.pbrMetallicRoughness.roughnessFactor : 1,
               emissive: x.emissiveFactor || [0, 0, 0] })) };
  }
  /* bytes per texel on the GPU, and the share the mip chain adds */
  const BPP = { base: 4, nrm: 2, orm: 2, ormm: 4, r8: 1 };
  const chain = (w, h, levels) => { let s = 0; for (let l = 0; l < levels; l++) s += Math.max(1, w >> l) * Math.max(1, h >> l); return s; };
  function texParams(gl, G, target) {
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.REPEAT);
    if (G.ext.aniso) gl.texParameterf(target, G.ext.aniso.TEXTURE_MAX_ANISOTROPY_EXT, WX.ASSETS.gpu.aniso);
  }
  function unpack(gl) {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  }
  const FMT = (gl, kind) => kind === "base" ? [gl.SRGB8_ALPHA8, gl.RGBA] : kind === "nrm" || kind === "orm" ? [gl.RG8, gl.RG] : kind === "r8" ? [gl.R8, gl.RED] : [gl.RGBA8, gl.RGBA];
  function uploadTex(gl, G, bmp, kind) {
    const [ifmt, fmt] = FMT(gl, kind);
    const levels = Math.floor(Math.log2(Math.max(bmp.width, bmp.height))) + 1;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    unpack(gl);
    gl.texStorage2D(gl.TEXTURE_2D, levels, ifmt, bmp.width, bmp.height);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, fmt, gl.UNSIGNED_BYTE, bmp);
    gl.generateMipmap(gl.TEXTURE_2D);
    texParams(gl, G, gl.TEXTURE_2D);
    return { tex, w: bmp.width, h: bmp.height, target: gl.TEXTURE_2D, bytes: chain(bmp.width, bmp.height, levels) * BPP[kind] };
  }

  function loader(base) {
    let man = null, manP = null, inflight = 0, arrays = null, combineP = null, opts = {};
    const meshes = {}, texs = {}, queue = [], ready = [], prog = { got: 0, of: 0, uploads: 0, failed: 0, stage: 0, mem: { tex: 0, mesh: 0 }, stamp: 0, maxStepMs: 0 };
    const pend = { 0: 0, 1: 0, 2: 0, 3: 0 }, wireJobs = [];
    const url = (name) => base + name + (man && man.files && man.files[name] ? "?v=" + man.files[name].sha : "");
    const warn = (what, e) => { prog.failed++; console.warn("weather: " + what + " left out: " + (e && e.message || e)); };
    function pump() {
      while (inflight < 4 && queue.length) {
        const job = queue.shift();
        inflight++;
        fetch(url(job.file), { cache: "default" })
          .then((r) => { if (!r.ok) throw new Error(r.status + " " + job.file); return job.kind === "glb" ? r.arrayBuffer() : r.blob(); })
          .then((x) => (job.kind === "glb" ? parseGLB(x) : createImageBitmap(x, job.px ? { premultiplyAlpha: "none", colorSpaceConversion: "none",
            resizeWidth: job.px, resizeHeight: job.px, resizeQuality: "high" } : { premultiplyAlpha: "none", colorSpaceConversion: "none" })))
          .then((data) => { ready.push({ job, data }); })
          .catch((e) => { pend[job.stage]--; warn(job.file, e); })
          .finally(() => { inflight--; pump(); });
      }
    }
    /* the four terrain layers as three texture arrays; ORM and height meet on the GPU in the third */
    function arrayUpload(R, job, bmp) {
      const gl = R.gl, G = R.gpu, px = bmp.width;
      if (!arrays) {
        const levels = Math.floor(Math.log2(px)) + 1;
        const mk = (ifmt) => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D_ARRAY, t); gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, ifmt, px, px, 4); texParams(gl, G, gl.TEXTURE_2D_ARRAY); return { tex: t, target: gl.TEXTURE_2D_ARRAY, w: px, h: px }; };
        arrays = { albedo: mk(gl.SRGB8_ALPHA8), normal: mk(gl.RG8), ormh: mk(gl.RGBA8), px, levels, have: {}, tmp: {}, fbs: [], done: false, layers: LAYERS.slice() };
        prog.mem.tex += chain(px, px, levels) * 4 * (4 + 2 + 4);
      }
      if (bmp.width !== arrays.px) throw new Error("terrain layer size " + bmp.width + " != " + arrays.px);
      unpack(gl);
      const L = job.layer, A = arrays;
      if (job.map === "albedo" || job.map === "normal") {
        const t = job.map === "albedo" ? A.albedo : A.normal;
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, t.tex);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, L, px, px, 1, job.map === "albedo" ? gl.RGBA : gl.RG, gl.UNSIGNED_BYTE, bmp);
      } else {
        /* ORM (R AO, G roughness) and the height map: kept as 2D textures until both are in, then drawn into the layer */
        const t = uploadTex(gl, G, bmp, job.map === "height" ? "r8" : "orm");
        (A.tmp[L] = A.tmp[L] || {})[job.map] = t;
        if (A.tmp[L].orm && A.tmp[L].height) {
          if (!combineP) combineP = R.program("assets.ormh", { fs: `
            uniform sampler2D uOrm, uH; in vec2 vUV; out vec4 o;
            void main() { vec2 a = texture(uOrm, vUV).rg; o = vec4(a, texture(uH, vUV).r, 1.); }` });
          A.waitCombine = A.waitCombine || [];
          A.waitCombine.push(L);
        }
      }
      (A.have[L] = A.have[L] || {})[job.map] = true;
    }
    function arrayCombine(R) {
      const A = arrays, gl = R.gl;
      if (!A || !A.waitCombine || !A.waitCombine.length || !combineP || !combineP.ready()) return;
      while (A.waitCombine.length) {
        const L = A.waitCombine.shift(), t = A.tmp[L];
        /* one framebuffer, the layer attached again each time (G.fbo's status check would make the driver sync) */
        if (!A.fb) { A.fb = { fb: gl.createFramebuffer(), w: A.px, h: A.px }; gl.bindFramebuffer(gl.FRAMEBUFFER, A.fb.fb); gl.drawBuffers([gl.COLOR_ATTACHMENT0]); }
        gl.bindFramebuffer(gl.FRAMEBUFFER, A.fb.fb);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, A.ormh.tex, 0, L);
        gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
        R.draw(combineP, A.fb, { uOrm: t.orm, uH: t.height });
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteTexture(t.orm.tex); gl.deleteTexture(t.height.tex);
        A.tmp[L] = null;
        A.have[L].ormh = true;
      }
    }
    function arraysComplete() {
      const A = arrays;
      if (!A || A.done) return;
      for (let L = 0; L < 4; L++) { const h = A.have[L]; if (!h || !h.albedo || !h.normal || !h.ormh) return; }
      A.done = true;
      A.mipsPending = true;
    }
    return {
      progress: prog,
      manifest() {
        if (!manP) manP = fetch(base + WX.ASSETS.manifest, { cache: "no-cache" })
          .then((r) => (r.ok ? r.json() : null))
          .then((m) => (man = m && m.v === 1 && ((m.models && m.models.length) || (m.terrain && m.terrain.length)) ? m : null))
          .catch(() => (man = null));
        return manP;
      },
      want(ids, o = {}) {
        if (!man) return;
        opts = o;
        const texPx = o.texPx || 1024, tier = o.tier === undefined ? 2 : o.tier, metal = o.metal || [], pxOf = o.px || {};
        const models = Object.fromEntries((man.models || []).map((m) => [m.id, m]));
        const jobs = [];
        const tex = (file, kind, px, stage, size, extra) => {
          if (!file || texs[file] !== undefined) return;
          texs[file] = null; jobs.push(Object.assign({ kind, file, px, stage, size: size || 0 }, extra || {})); prog.of++; pend[stage]++;
        };
        for (const id of ids) {
          const a = models[id];
          if (!a) continue;
          const want = Array.isArray(o.lods) ? o.lods : o.lods && o.lods[id] ? o.lods[id] : null;
          const lods = a.lods.filter((l) => !want || want.includes(l.lod)).sort((x, y) => y.lod - x.lod);   // coarsest first
          lods.forEach((l, k) => { jobs.push({ kind: "glb", file: l.file, id, lod: l.lod, stage: k === 0 ? 0 : 2, size: -l.lod }); prog.of++; pend[k === 0 ? 0 : 2]++; });
          const size = pxOf[id] || 0, foot = o.px ? Math.max(128, 2 ** Math.ceil(Math.log2(Math.max(1, 2 * size * (tier >= 3 ? 2 : 1))))) : 1e9;
          const px = Math.min(a.tex.px || 1024, texPx, (a.tex.gpu && a.tex.gpu[tier]) || 1024, foot);
          for (const [mn, mt] of Object.entries(a.tex.materials || {})) {
            /* o.matScale: a material decoded smaller than its model's (the ship's thin rigging and sails) */
            const mp = Math.max(128, Math.round(px * ((o.matScale && o.matScale[id] && o.matScale[id][mn]) || 1)));
            tex(mt.basecolor, "base", mp, 1, size);
            tex(mt.normal, "nrm", mp, 3, size);
            tex(mt.orm, metal.includes(id) ? "ormm" : "orm", mp, 3, size);
          }
        }
        if (o.terrain !== false) (man.terrain || []).forEach((t) => {
          const px = Math.min(t.px || 512, texPx, o.terrainPx || 1e9), L = LAYERS.indexOf(t.layer);
          if (o.terrainArrays && L >= 0) {
            for (const map of ["albedo", "normal", "orm", "height"]) tex(t.files[map], "tlay", px, 1, 1e6, { layer: L, map });
          } else {
            tex(t.files.albedo, "base", px, 1, 1e6); tex(t.files.normal, "nrm", px, 3, 1e6); tex(t.files.orm, "orm", px, 3, 1e6); tex(t.files.height, "orm", px, 3, 1e6);
          }
        });
        /* stage first, then the largest on screen first */
        jobs.sort((a, b) => a.stage - b.stage || b.size - a.size);
        queue.push(...jobs);
        pump();
      },
      step(R, ms) {
        const t0 = performance.now(), gl = R.gl, ph = prog.phase = prog.phase || { wire: 0, combine: 0, jobs: 0, mips: 0 };
        while (wireJobs.length && performance.now() - t0 < ms) {
          const w = wireJobs[0], r = w.gen.next();
          if (!r.done) continue;
          wireJobs.shift();
          /* prim.tris: one instance per triangle (triJob), for the coast's coverage pass */
          const v = r.value, tb = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, tb); gl.bufferData(gl.ARRAY_BUFFER, v.data, gl.STATIC_DRAW); gl.bindBuffer(gl.ARRAY_BUFFER, null);
          w.prim.tris = { buf: tb, n: v.n, layout: v.layout, alts: v.alts }; w.prim.wire = tb;
          prog.mem.mesh += v.data.byteLength; prog.stamp++;
        }
        const tw = performance.now(); /*@lab*/ ph.wire = Math.max(ph.wire, tw - t0); /*@end*/
        if (wireJobs.length) { /*@lab*/ prog.maxStepMs = Math.max(prog.maxStepMs, tw - t0); /*@end*/ return false; }
        arrayCombine(R);
        const tc = performance.now(); /*@lab*/ ph.combine = Math.max(ph.combine, tc - tw); /*@end*/
        while (ready.length) {
          const { job, data } = ready.shift();
          try {
            if (job.kind === "glb") {
              const m = Object.assign(uploadMesh(gl, data, opts.wires && opts.wires[job.id], wireJobs), { lod: job.lod });
              (meshes[job.id] = meshes[job.id] || [])[job.lod] = m;
              prog.mem.mesh += m.bytes;
            } else if (job.kind === "tlay") { arrayUpload(R, job, data); data.close(); }
            else { const t = uploadTex(gl, R.gpu, data, job.kind); texs[job.file] = t; prog.mem.tex += t.bytes; data.close(); }
            prog.uploads++; prog.got++; prog.stamp++;
          } catch (e) { warn(job.file, e); if (data && data.close) data.close(); }
          pend[job.stage]--;
          const dt = performance.now() - t0;
          /*@lab*/
          if (dt > (prog.slowMs || 0)) { prog.slowMs = dt; prog.slowJob = job.file; }
          (prog.slow = prog.slow || []).push([+dt.toFixed(2), job.file]); prog.slow.sort((x, y) => y[0] - x[0]); prog.slow.length = Math.min(prog.slow.length, 5);
          /*@end*/
          if (dt >= ms) break;
        }
        const tj = performance.now(); /*@lab*/ ph.jobs = Math.max(ph.jobs, tj - tc); /*@end*/
        arrayCombine(R);
        arraysComplete();
        if (arrays && arrays.done && arrays.mipsPending && !arrays.waitCombine.length) {
          /* one array's mips a step */
          const k = arrays.mipK || 0, t = [arrays.albedo, arrays.normal, arrays.ormh][k];
          gl.bindTexture(gl.TEXTURE_2D_ARRAY, t.tex); gl.generateMipmap(gl.TEXTURE_2D_ARRAY); gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
          arrays.mipK = k + 1;
          if (arrays.mipK >= 3) { arrays.mipsPending = false; if (arrays.fb) { gl.deleteFramebuffer(arrays.fb.fb); arrays.fb = null; } prog.stamp++; }
        }
        /*@lab*/ ph.mips = Math.max(ph.mips, performance.now() - tj); /*@end*/
        prog.stage = pend[0] > 0 ? 0 : pend[1] > 0 ? 1 : pend[2] > 0 ? 2 : pend[3] > 0 ? 3 : 4;
        /*@lab*/ prog.maxStepMs = Math.max(prog.maxStepMs, performance.now() - t0); /*@end*/
        return prog.got + prog.failed >= prog.of && !ready.length && !wireJobs.length;
      },
      /* the finest LOD at or above `lod` that has arrived, else a coarser one, else null */
      mesh(id, lod) {
        const m = meshes[id];
        if (!m) return null;
        for (let l = lod; l < m.length; l++) if (m[l]) return m[l];
        for (let l = lod - 1; l >= 0; l--) if (m[l]) return m[l];
        return null;
      },
      has(id, lod) { return !!(meshes[id] && meshes[id][lod]); },
      tex(file) { return texs[file] || null; },
      mat(id, name) {
        const a = man && (man.models || []).find((m) => m.id === id), mt = a && a.tex.materials[name];
        if (!mt) return { base: null, nrm: null, orm: null, alphaScale: 1 };
        return { base: texs[mt.basecolor] || null, nrm: texs[mt.normal] || null, orm: texs[mt.orm] || null, alphaScale: mt.alphaScale || 1 };
      },
      terrain() {
        return ((man && man.terrain) || []).map((t) => ({ layer: t.layer, id: t.id, tileSizeM: t.tileSizeM, albedo: texs[t.files.albedo] || null,
          normal: texs[t.files.normal] || null, orm: texs[t.files.orm] || null, height: texs[t.files.height] || null }));
      },
      terrainArrays() {
        if (!arrays || !arrays.done || arrays.mipsPending) return null;
        if (!arrays.view) {               // made once: callers ask every frame
          const tile = {};
          for (const t of (man && man.terrain) || []) tile[t.layer] = t.tileSizeM;
          arrays.view = { albedo: arrays.albedo, normal: arrays.normal, ormh: arrays.ormh, layers: arrays.layers, px: arrays.px, tile };
        }
        return arrays.view;
      },
      man: () => man,
    };
  }
  return { loader, parseGLB, accessor, meshNodes, triInstances, LAYERS };
})();
