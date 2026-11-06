-- flora.lua: new trees for the village and its fields, and the things that line the track.
-- Each comes as the engine stages it: a tree as <name>, _1 turning, _2 dry (then the engine shows
-- dry.lua's dead1/dead2), a wall or a gate as <name>, _1 weathered, _2 broken, the hedge _1
-- turning and _2 dry and gappy, the wildflowers down to _3 dead stalks, and a stone's moss _1 dry
-- and _2 burnt off. Every stage keeps its base's size and bottom row, so the engine can swap it
-- in place.
local P = dofile(ART .. "/px.lua")
local S = P.sheet("flora", 512, 32)

local NAME = {}
for k, v in pairs(P.C) do NAME[P.hex(v)] = k end
local function at(g, x, y)
  if x < 0 or y < 0 or x >= g.width or y >= g.height then return nil end
  local c = g:getPixel(x, y)
  return app.pixelColor.rgbaA(c) > 0 and NAME[c] or nil
end

-- Lone pixels: a pixel none of whose eight neighbours shares its colour. Printed, not fixed, so
-- every one left in is one looked at.
local LONE = {}
local function lone(name, g)
  local n, where = 0, {}
  for y = 0, g.height - 1 do for x = 0, g.width - 1 do
    local c = at(g, x, y)
    if c then
      local same = false
      for dy = -1, 1 do for dx = -1, 1 do
        if (dx ~= 0 or dy ~= 0) and at(g, x + dx, y + dy) == c then same = true end
      end end
      if not same then n = n + 1; where[#where + 1] = c .. "@" .. x .. "," .. y end
    end
  end end
  if n > 0 then LONE[#LONE + 1] = name .. " " .. n .. (FLORA_WHERE and (" [" .. table.concat(where, " ") .. "]") or "") end
end

-- Draws each frame into a cell-sized image, so nothing can spill onto a neighbour.
local function sprite(name, w, h, draw, note)
  local cell = P.strip(S, name, w, h, 1, note)
  local g, l = P.image(w, h), P.image(w, h)
  draw(g, l)
  lone(name, g)
  -- the bottom row is where it stands, and nothing pads it above
  for _, row in ipairs({ 0, h - 1 }) do
    local any = false
    for x = 0, w - 1 do if at(g, x, row) then any = true end end
    if not any then error(name .. ": row " .. row .. " is empty") end
  end
  local x, y = cell(0)
  P.blit(S.base, g, x, y)
  P.blit(S.lights, l, x, y)
end

-- P.map with every row checked: a row of the wrong width is a typo, not a shape.
-- A legend may map a letter to false, to leave those pixels out.
local function map(g, x, y, rows, legend)
  for j, r in ipairs(rows) do
    if #r ~= #rows[1] then error("row " .. j .. " is " .. #r .. " wide, expected " .. #rows[1] .. ": " .. r) end
  end
  local keep = {}
  for j, r in ipairs(rows) do keep[j] = r:gsub(".", function(k) return legend[k] == false and "." or k end) end
  P.map(g, x, y, keep, legend)
end

-- A selective outline: each pixel in rows y0..y1 whose colour is in `from` and that borders the
-- clear on one of `sides` ("l", "r", "t", "b") takes `into`. Where a crown stands in front of the
-- field, its lit greens are the field's own, so its shaded edges need a darker line.
local function rim(g, y0, y1, from, into, sides, x0, x1)
  local D = { l = { -1, 0 }, r = { 1, 0 }, t = { 0, -1 }, b = { 0, 1 } }
  local edge = {}
  for j = y0, y1 do for i = x0 or 0, x1 or g.width - 1 do
    local c = at(g, i, j)
    if c and from[c] then
      for k in sides:gmatch(".") do
        if not at(g, i + D[k][1], j + D[k][2]) then edge[#edge + 1] = { i, j }; break end
      end
    end
  end end
  for _, e in ipairs(edge) do P.pix(g, e[1], e[2], into) end
end

---------------------------------------------------------------------------------------------------
-- Birch. The crown is five loose lumps hung off the trunk (top, upper left and right, lower left
-- and right), lime more than grass, so it is a yellower green than the oaks, with two sunlit tips
-- in yellow on the upper left; shaded only along its right and foot, and hanging in tips; where
-- the lower lumps stand in front of the field their left edges are lined in moss. Between the
-- lumps a window shows the white trunk. The trunk is white on its lit side and ice on its shaded
-- one, banded by three dark dashes, and goes grey and rough at its foot. Birches turn early:
-- turning, the right half of the crown has gone gold; dry, each lump has thinned to a ragged tuft
-- of straw hanging in olive tips, and the bare plum twigs show between them and over the top.
---------------------------------------------------------------------------------------------------
-- from row 15 down: white and ice, two dark dashes across it, then grey and rough at the foot
local BIRCH_TRUNK = {
  "Wi", "Wi", "Wi", "kk", "Wi", "Wi", "Wi", "Wi", "kk", "Wi", "Wi", "hG", "hG", "hd",
}
local BIRCH_FOOT = { ".hhdd." }
local BARK = { W = "white", i = "ice", k = "ink", h = "steel", G = "grey", d = "smoke" }
local BIRCH_CROWN = {
  "......LL......",
  ".....YYLL.....",
  "....YYLLLg....",
  "...LLLLLLgg...",
  "...LLLLLggLL..",
  "..YLLLLggLLLgm",
  ".YYLLLLgLLLggm",
  "LYLLLLggLLLggm",
  "LLLLLggggLggm.",
  "mLLLggWiggmm..",
  ".mLLLgWiLLgm..",
  ".mLLLgkkLLggm.",
  ".mLLLLgggLLggm",
  ".mLLLggggLggmm",
  "..mLggmgggggm.",
  "..mgmmWi.gm.m.",
  "..m..mWi..m...",
}
local BIRCH_DAY = { Y = "yellow", L = "lime", g = "grass", m = "moss", W = "white", i = "ice", k = "ink" }
-- turning: the same crown, gold from GOLD_FROM[row] rightwards, and sallowing to the left of it
local GOLD_FROM = { 8, 8, 8, 8, 7, 7, 8, 7, 7, 8, 8, 8, 8, 7, 7, 7, 7 }
local BIRCH_GOLD = { Y = "yellow", L = "yellow", g = "sand", m = "ochre" }
local BIRCH_SALLOW = { Y = "yellow", L = "lime", g = "sage", m = "moss" }
-- dry: each lump thinned to a ragged tuft, sand where the sun catches it, ochre, and olive in the
-- tips it hangs in; the plum twigs bare between the tufts and over the top, and the white trunk
-- showing up to where it forks
local BIRCH_DRY = {
  "......pp......",
  ".....pnnp.....",
  "....nnoon.....",
  "....noooov....",
  "...p.v.o.vp...",
  "..nnp.vo.pnn..",
  ".nnoop...pooo.",
  "nooovpWipovvo.",
  ".v.v..Wi..v.vv",
  ".v..v.Wi..v..v",
  "..p..pWi.pnn..",
  ".pnnp.kkpooon.",
  ".nooovWipvoov.",
  "..v.v.Wi.v.v..",
  "..v.v.Wi.v.v..",
  "..p...Wi...p..",
  "..p...Wi...p..",
}
local BIRCH_STRAW = { n = "sand", o = "ochre", v = "olive", W = "white", i = "ice", k = "ink", p = "plum" }
local function birch(g, crown, legend)
  map(g, 6, 15, BIRCH_TRUNK, BARK)
  map(g, 4, 29, BIRCH_FOOT, BARK)
  map(g, 0, 0, crown, legend)
end
sprite("birch", 14, 30, function(g) birch(g, BIRCH_CROWN, BIRCH_DAY) end, "silver birch")
sprite("birch_1", 14, 30, function(g)
  local crown = {}
  for j, r in ipairs(BIRCH_CROWN) do
    crown[j] = r:gsub("()(.)", function(i, k)
      if k == "." or k == "W" or k == "i" or k == "k" then return k end
      local t = i >= GOLD_FROM[j] + 1 and BIRCH_GOLD or BIRCH_SALLOW
      return ({ yellow = "Y", lime = "L", sage = "a", moss = "m", sand = "n", ochre = "o" })[t[k]]
    end)
  end
  birch(g, crown, { Y = "yellow", L = "lime", a = "sage", m = "moss", n = "sand", o = "ochre", W = "white", i = "ice", k = "ink" })
end, "turning: the right of the crown gone gold")
sprite("birch_2", 14, 30, function(g) birch(g, BIRCH_DRY, BIRCH_STRAW) end, "dry: ragged tufts on bare twigs")

---------------------------------------------------------------------------------------------------
-- Apple. village.lua's clumps, laid as a low round dome over a short forked trunk, in a deeper,
-- bluer green than the oaks; red apples hang on the lower half. The two sunlit top clumps are
-- stacked on the rest with a moss line under each, and the crown is lined in moss where it stands
-- in front of the field, whose greens are its lit ones. Turning, the shaded clumps go first and
-- only four apples are left, two fallen in the grass; dry, the fruit has gone and the shoulders
-- have thinned, the crown is straw lined with olive, and the sun still catches the top left tips
-- in sand. The two limbs reach up into the crown's underside in every stage.
---------------------------------------------------------------------------------------------------
local CLUMP = {
  L = { "...aaaa...", ".aaaaaaab.", "aaaaaaaabb", "aaaaaaabbb", "baaaabbbbb", "bbbbbbbbcc", ".bbbbbccc.", "...cccc..." },
  M = { "..aaaa..", ".aaaaab.", "aaaaabbb", "baabbbbc", ".bbbbcc.", "..cccc.." },
  S = { ".aaa..", "aaaab.", "bbbbcc", ".bccc." },
}
local TONE = {
  lit = { a = "lime", b = "grass", c = "moss" },
  mid = { a = "grass", b = "grass", c = "teal" },
  low = { a = "grass", b = "teal", c = "slate" },
  sallowLow = { a = "sage", b = "olive", c = "slate" },
  yellowing = { a = "sage", b = "ochre", c = "olive" },
  litTurning = { a = "lime", b = "sage", c = "moss" },
  dryLit = { a = "sage", b = "ochre", c = "olive" },
  dryHeart = { a = "ochre", b = "ochre", c = "moss" },
  dryLow = { a = "ochre", b = "olive", c = "bark" },
  dryLowGreen = { a = "ochre", b = "olive", c = "moss" },
}
-- A stage gives each clump a tone, false to leave it out, or { tone, shape, dx, dy } to swap it
-- for a smaller clump nudged inwards. A pinhole between the corners of clumps takes the colour
-- above it.
local function crown(g, clumps, stage)
  for i, c in ipairs(clumps) do
    local t = stage[i]
    if t then
      if type(t) == "string" then t = { t } end
      local x, y, shape = c[2] + (t[3] or 0), c[3] + (t[4] or 0), CLUMP[t[2] or c[1]]
      -- a clump stacked on the ones before it casts a line of their shade under itself
      if stage.contour and stage.contour[i] then map(g, x, y + 1, shape, { a = stage.contour[i], b = stage.contour[i], c = stage.contour[i] }) end
      map(g, x, y, shape, TONE[t[1]])
    end
  end
  for j = 1, g.height - 2 do for i = 1, g.width - 2 do
    if not at(g, i, j) and at(g, i - 1, j) and at(g, i + 1, j) and at(g, i, j - 1) and at(g, i, j + 1) then P.pix(g, i, j, at(g, i, j - 1)) end
  end end
end
-- the two limbs reach up into the underside of the crown, so no sky shows between them
local APPLE_TRUNK = {
  ".ww...bb",
  "..ww.bb.",
  "...wbb..",
  "...wbb..",
  "...wbb..",
  "...wbb..",
  "...wbb..",
  "...wbb..",
  "..wwbbb.",
  ".wwwbbbb",
}
-- clumps by place: 1 low left, 2 low right, 3 right shoulder, 4 left, 5 heart, 6 top right,
-- 7 top left (sunlit), 8 crown top
local APPLE = { { "L", 3, 6 }, { "L", 10, 6 }, { "L", 12, 4 }, { "L", 0, 4 }, { "L", 6, 3 }, { "M", 14, 2 }, { "L", 2, 0 }, { "M", 8, 0 } }
local function apple(g, stage, fruit)
  map(g, 7, 14, APPLE_TRUNK, { w = "wood", b = "bark" })
  crown(g, APPLE, stage)
  for _, a in ipairs(fruit) do P.rect(g, a[1], a[2], 2, 2, "red"); P.pix(g, a[1], a[2], "coral") end
  -- the corner of the left clump left showing beside the low left apple joins the heart's green
  if at(g, 6, 9) == "teal" then P.pix(g, 6, 9, "grass") end
end
sprite("apple", 22, 24, function(g)
  apple(g, { "low", "low", "low", "low", "mid", "mid", "lit", "lit", contour = { [7] = "moss", [8] = "moss" } },
    { { 4, 9 }, { 9, 11 }, { 15, 9 }, { 18, 6 }, { 12, 5 }, { 6, 4 }, { 1, 7 } })
  rim(g, 2, 15, { lime = true, grass = true }, "moss", "lbt")
end, "orchard apple tree")
sprite("apple_1", 22, 24, function(g)
  apple(g, { "sallowLow", "low", "sallowLow", "low", "mid", "yellowing", "lit", "litTurning", contour = { [7] = "moss", [8] = "moss" } },
    { { 4, 9 }, { 15, 9 }, { 12, 5 }, { 6, 4 }, { 3, 22 }, { 16, 22 } })
  P.pix(g, 16, 8, "olive") -- a sallow corner left showing between two clumps
  rim(g, 2, 15, { lime = true, grass = true, sage = true }, "moss", "lbt")
end, "turning: four apples left, two fallen")
sprite("apple_2", 22, 24, function(g)
  apple(g, { "dryLow", "dryLow", { "dryLow", "M", 1, 1 }, "dryLowGreen", "dryHeart", { "dryLit", "S", 1, 1 }, "dryLit", "dryLit" }, {})
  rim(g, 9, 14, { ochre = true }, "olive", "lrb")
  -- the sun still catches the tips of the top left clumps
  rim(g, 0, 6, { sage = true }, "sand", "t", 0, 11)
  P.pix(g, 19, 10, "bark")
end, "dry: no fruit, the shoulders thinned")

---------------------------------------------------------------------------------------------------
-- Willow. The curtain is one mass, grass in the light and moss in the shade, the dome lit on top;
-- on it hang strands, lit lines and grooves of different lengths (on the shaded side two deep
-- slate ones and the rest teal, so it keeps its strands at dusk), and its foot is a fringe, lined
-- in a darker green on its lit side where it stands against the field. Under the cap it is hollow
-- and dark, the trunk forks up into it, and two strands hang in front of it. Turning, the shaded
-- side and the fringe go yellow; dry, the curtain is straw and has thinned to bare hanging whips
-- in places.
---------------------------------------------------------------------------------------------------
local WILLOW_TOP = { 10, 7, 5, 4, 3, 2, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 2, 3, 4, 5, 7, 10 }
local WILLOW_BOT = { 20, 23, 21, 25, 24, 22, 26, 24, 19, 17, 14, 11, 10, 10, 10, 15, 18, 22, 25, 23, 21, 26, 24, 25, 22, 19 }
-- { x, from, to, tone }: lines laid over the mass, a lit strand or a dark groove
local WILLOW_LINES = {
  { 1, 9, 20, "lit" }, { 3, 6, 23, "lit" }, { 4, 13, 23, "lit" }, { 6, 4, 17, "lit" }, { 7, 15, 23, "lit" }, { 9, 6, 16, "lit" },
  { 12, 2, 6, "lit" }, { 15, 3, 7, "lit" },
  { 17, 5, 15, "glint" }, { 18, 13, 25, "glint" }, { 21, 7, 20, "glint" }, { 24, 10, 20, "glint" },
  { 2, 10, 20, "groove" }, { 5, 8, 21, "groove" }, { 8, 7, 18, "groove" }, { 10, 7, 8, "groove" },
  { 16, 8, 18, "groove" }, { 19, 6, 23, "deep" }, { 20, 14, 21, "dark" }, { 22, 9, 23, "deep" }, { 23, 18, 24, "dark" },
}
-- strands hanging in front of the hollow and the trunk
local WILLOW_FRONT = { { 12, 8, 19, "light" }, { 14, 10, 17, "groove" } }
local WILLOW_TRUNK = {
  "b.....b.",
  ".b...b..",
  ".wb.bb..",
  "..wbb...",
  "..wbb...",
  "..wbb...",
  "..wbb...",
  "..wbb...",
  "..wbb...",
  "..wbb...",
  "..wbb...",
  "..wbb...",
  "..wbb...",
  "..wbb...",
  "..wbb...",
  "..wbb...",
  "..wbbb..",
  ".wwbbb..",
  ".wwbbbb.",
  "wwwbbbbb",
}
local WILLOW_DAY = { light = "grass", shade = "moss", top = "lime", topR = "grass", lit = "lime", glint = "grass", groove = "moss", deep = "slate", dark = "teal",
                     hollow = "slate", trunk = "bark", wood = "wood", rim = "moss" }
local WILLOW_TURNING = { light = "grass", shade = "olive", top = "lime", topR = "sage", lit = "lime", glint = "sage", groove = "moss", deep = "slate", dark = "moss",
                         hollow = "slate", trunk = "bark", wood = "wood", rim = "moss", tip = "sage", alt = { lit = "sage" } }
local WILLOW_DRY = { light = "ochre", shade = "olive", top = "sage", topR = "ochre", lit = "sage", glint = "ochre", groove = "olive", deep = "bark", dark = "bark",
                     hollow = "plum", trunk = "bark", wood = "wood", rim = "olive", alt = { lit = "ochre" } }
-- dry: under the cap the curtain has thinned to single strands, shortened, with bare whips and
-- gaps between them
local WILLOW_BOT_DRY = { 18, 9, 9, 22, 9, 9, 23, 9, 9, 16, 13, 11, 10, 10, 10, 14, 9, 9, 23, 9, 9, 23, 9, 9, 21, 17 }
local WILLOW_WHIPS = { { 2, 10, 19, "bark" }, { 5, 10, 20, "bark" }, { 8, 10, 17, "bark" }, { 17, 10, 19, "bark" }, { 20, 10, 20, "bark" },
                       { 23, 10, 22, "bark" } }
local function willow(g, T, bot, whips)
  bot = bot or WILLOW_BOT
  for x = 0, 25 do
    for y = WILLOW_TOP[x + 1], bot[x + 1] do
      local c = x < 17 and T.light or T.shade
      if y < WILLOW_TOP[x + 1] + 2 then c = x < 15 and T.top or T.topR end
      P.pix(g, x, y, c)
    end
  end
  for i, l in ipairs(WILLOW_LINES) do
    local tone = T[l[4]]
    if T.alt and T.alt[l[4]] and i % 2 == 0 then tone = T.alt[l[4]] end
    for y = math.max(l[2], WILLOW_TOP[l[1] + 1]), math.min(l[3], bot[l[1] + 1]) do P.pix(g, l[1], y, tone) end
  end
  if T.tip then
    for x = 0, 25 do
      if (x < 11 or x > 14) and bot[x + 1] > 12 then P.vline(g, x, bot[x + 1] - 1, 2, T.tip) end
    end
  end
  for x = 11, 14 do for y = 8, bot[x + 1] do P.pix(g, x, y, T.hollow) end end
  map(g, 9, 8, WILLOW_TRUNK, { w = T.wood, b = T.trunk })
  for _, w in ipairs(whips or {}) do P.vline(g, w[1], w[2], w[3] - w[2] + 1, w[4]) end
  for _, f in ipairs(T.front or WILLOW_FRONT) do P.vline(g, f[1], f[2], f[3] - f[2] + 1, T[f[4]] or f[4]) end
  rim(g, 9, 27, { [T.light] = true, [T.lit] = true }, T.rim, "lb", 0, 9)
  -- a strand that ends in a single pixel of its own colour takes the pixel above it too, so every
  -- strand ends in a tip of two
  local short = {}
  for y = 1, g.height - 1 do for x = 0, g.width - 1 do
    local c = at(g, x, y)
    if c and not at(g, x, y + 1) then
      local alone = true
      for dy = -1, 1 do for dx = -1, 1 do
        if (dx ~= 0 or dy ~= 0) and at(g, x + dx, y + dy) == c then alone = false end
      end end
      if alone then short[#short + 1] = { x, y - 1, c } end
    end
  end end
  for _, t in ipairs(short) do P.pix(g, t[1], t[2], t[3]) end
end
sprite("willow", 26, 28, function(g) willow(g, WILLOW_DAY) end, "weeping willow")
sprite("willow_1", 26, 28, function(g)
  willow(g, WILLOW_TURNING)
  P.pix(g, 1, 21, "sage") -- the outermost strand yellows a pixel higher, so its rim does not sit alone
end, "turning: the shade side and the fringe yellowing")
sprite("willow_2", 26 , 28, function(g) willow(g, WILLOW_DRY, WILLOW_BOT_DRY, WILLOW_WHIPS) end, "dry: straw, thinned to bare whips")

---------------------------------------------------------------------------------------------------
-- Cypress: a tall dark column, straight-sided, on a full rounded foot, drawn up at the top into a
-- long point. Its foliage is layered upswept sprays: on the lit side each spray juts out in a
-- flame tuft and is grooved under in slate, the grooves running down into the shade like the
-- barbs of a feather; on the shaded side the slate is cut by moss sprays rising the other way.
-- It is the darkest tree and keeps lime out, which is the poplar's. Evergreen, it only dulls,
-- then browns from the tip down, the green holding in the lower column.
---------------------------------------------------------------------------------------------------
local CYPRESS = {
  "....m..",
  "...gm..",
  "...gms.",
  "...gms.",
  "..ggHs.",
  "..gmms.",
  "..Hmmss",
  ".ggHmss",
  "gggmHms",
  "ggmmmHs",
  ".gmmmss",
  ".Hmmmms",
  ".mHmmHs",
  ".ggHmss",
  "gggmHms",
  "ggmmmHs",
  ".gmmmms",
  ".Hmmmss",
  ".mHmmHs",
  ".ggHmss",
  "gggmHms",
  "ggmmmHs",
  ".gmmmss",
  ".Hmmmms",
  ".mHmmss",
  ".mmHmss",
  ".mmmsss",
  "..msss.",
  "...wb..",
  "...wb..",
}
local CYPRESS_TRUNK = { w = "wood", b = "bark" }
-- each stage gives the column's tones, and optionally the tones of its top rows down to `upto`
local function cypress(g, tones, top, upto)
  for j, r in ipairs(CYPRESS) do
    local t = (top and j - 1 <= upto) and top or tones
    map(g, 0, j - 1, { r }, { g = t.lit, m = t.body, H = t.groove, s = t.shade, w = "wood", b = "bark" })
  end
end
sprite("cypress", 7, 30, function(g)
  cypress(g, { lit = "grass", body = "moss", groove = "slate", shade = "slate" })
end, "Italian cypress")
sprite("cypress_1", 7, 30, function(g)
  cypress(g, { lit = "sage", body = "moss", groove = "slate", shade = "slate" })
end, "duller")
sprite("cypress_2", 7, 30, function(g)
  cypress(g, { lit = "sage", body = "olive", groove = "slate", shade = "slate" },
    { lit = "ochre", body = "wood", groove = "bark", shade = "bark" }, 5)
end, "browning from the tip, the last green low in the column")

---------------------------------------------------------------------------------------------------
-- Dry-stone wall: a course of coping stones over a course of footing stones, each lit on its top
-- and left, set in dark joints. The footing stone that crosses the tile's seam (columns 13-15 and
-- 0-1) and the coping joint at column 15 are the same in every stage, so any wall meets any other.
-- Weathered, moss pads and sage lichen have spread and grime has gathered along the foot; tumbled,
-- the middle coping stone has come down: one stone has slipped into the breach, and the one that
-- fell lies at the foot in front of the footing, its shadow under it.
---------------------------------------------------------------------------------------------------
local STONE = { h = "steel", S = "stone", g = "grey", d = "smoke", k = "slate", m = "moss", G = "grass", a = "sage" }
sprite("wall", 16, 6, function(g)
  map(g, 0, 0, {
    ".hS...hhGG..hS..",
    "hhSgdhhhmmgdhSgd",
    "SgggkSgggggkSggk",
    "SSdhhSSSdhhSdhhS",
    "SgdSSSggdSSgdSSS",
    "gdkggggdkggdkggg",
  }, STONE)
end, "dry-stone wall; repeats left-right")
sprite("wall_1", 16, 6, function(g)
  map(g, 0, 0, {
    ".GG...hhGG..hS..",
    "SmmgdhhhmmgdhSgd",
    "SgggkSggaagkSggk",
    "SSdaaSSSdaaSdhhS",
    "SgdSSSdddSSddSSS",
    "gdkdddddkdddkggg",
  }, STONE)
end, "weathered; meets wall and wall_2")
sprite("wall_2", 16, 6, function(g)
  map(g, 0, 0, {
    ".GG.........hS..",
    "Smmgdhh.hhh.hSgd",
    "SgggkSggggg.Sggk",
    "SSdaaSSSkaaSdhhS",
    "SgdSSSdkhhhhdSSS",
    "gdkddddkkkkkdggg",
  }, STONE)
end, "tumbled; meets wall and wall_1 at either end")

---------------------------------------------------------------------------------------------------
-- Hedge: clipped flat, its top three leaf lumps each lit on its upper left, its face in small leaf
-- clusters over a dark foot where the stems show. Both ends are full, so hedges meet. Turning,
-- patches go sage and olive; dry, it is straw over olive and has opened to one ragged hole, a tuft
-- hanging into it from the left and a short dead stem forking up from its foot.
---------------------------------------------------------------------------------------------------
local HEDGE = { L = "lime", g = "grass", m = "moss", k = "slate", b = "bark", a = "sage", o = "ochre", v = "olive", w = "wood" }
sprite("hedge", 16, 8, function(g)
  map(g, 0, 0, {
    "LLLLL.LLLLL..LLL",
    "LLLggLLLLLgg.LLL",
    "LLgggggLLgggggLL",
    "mggmmmgggmmmggmm",
    "mmgmmmmgmmmggmmm",
    "mmmkkmmmmmmmkkmm",
    "kmmbkmmmkmbmmkmm",
    "kkkbkkkkkkbkkkkk",
  }, HEDGE)
end, "clipped hedge; repeats left-right")
sprite("hedge_1", 16, 8, function(g)
  map(g, 0, 0, {
    "LLaaa.LLaaa..aaL",
    "Laavvaaaavvv.aLL",
    "aavvvvaaavvvvvaa",
    "mvvmmmvvvmmmvvmm",
    "mmvmmmmvvmmvvmmm",
    "mmmkkmmmmmmmkkmm",
    "kmmbkmmmkmbmmkmm",
    "kkkbkkkkkkbkkkkk",
  }, HEDGE)
end, "turning; meets hedge and hedge_2")
sprite("hedge_2", 16, 8, function(g)
  map(g, 0, 0, {
    "aaoo.aaoo....aao",
    "oooovoooov...oov",
    "vovvovvovv...vvo",
    "vvovv.vv.....vvv",
    "vvvb...v..b..bvv",
    "vvvbk....bb.kbkv",
    "kvvbkk...b..kkvk",
    "kkkbkkkkkbkkkkkk",
  }, HEDGE)
end, "dry and gappy; meets hedge and hedge_1 at either end")

---------------------------------------------------------------------------------------------------
-- Gate: a white-painted field gate, four bars between a heel and a head and a brace running up
-- from the foot of the heel to the head, crossing the bars, hung between two posts taller than the
-- fence, which meets it on either side as the wall does. Weathered, the paint has flaked to grey
-- wood from the foot up, with a bare patch on the top rail; broken, it has dropped off its top
-- hinge and swung open into the field: seen at a slant, its two rails left, white along their
-- tops, draw together towards the head, which has come down on the grass; the brace and the
-- bottom rail are gone but for a stub, and the latch post stands alone across the opening.
---------------------------------------------------------------------------------------------------
local GATE = { w = "wood", b = "bark", W = "white", h = "steel", S = "stone", n = "sand", c = "sand" }
sprite("gate", 16, 9, function(g)
  map(g, 0, 0, {
    "cb............cb",
    "wbWWWWWWWWWWW.wb",
    "wbW.......hhW.wb",
    "wbWWWWWWhhWWW.wb",
    "wbW...hh....W.wb",
    "wbWWhhWWWWWWW.wb",
    "wbWhh.......W.wb",
    "wbWWWWWWWWWWW.wb",
    "wb............wb",
  }, GATE)
end, "field gate; meets fence and wall at either end")
sprite("gate_1", 16, 9, function(g)
  map(g, 0, 0, {
    "cb............cb",
    "wbWWWWWnnWWWW.wb",
    "wbW.......SSW.wb",
    "wbWWWhhhSSWWW.wb",
    "wbW...SS....W.wb",
    "wbWWSShhhWWWh.wb",
    "wbhSS.......h.wb",
    "wbhhhhWWhhhhh.wb",
    "wb............wb",
  }, GATE)
end, "weathered")
sprite("gate_2", 16, 9, function(g)
  map(g, 0, 0, {
    "cb............cb",
    "wbWW..........wb",
    "wbWWWW........wb",
    "wbW..hhWW.....wb",
    "wbWWh..hhS....wb",
    "wbhhhWW..S....wb",
    "wbh..hhhhS....wb",
    "wbhSS....S....wb",
    "wbh......SS...wb",
  }, GATE)
end, "broken, swung open, its head on the ground")

---------------------------------------------------------------------------------------------------
-- Wildflowers: poppies, cornflowers and a daisy over a leafy foot. They go to fewer, then to
-- seed heads on straw, then to dead stalks: a poppy's seed head on its stalk, and a broken one.
---------------------------------------------------------------------------------------------------
local FLOWER = { c = "coral", r = "red", W = "white", y = "yellow", s = "sky", b = "blue", g = "grass", m = "moss", a = "sage", o = "ochre",
                 v = "olive", K = "skin", B = "bark", w = "wood" }
sprite("flowers", 10, 6, function(g)
  map(g, 0, 0, {
    "..cr...W..",
    "..rr..WyWs",
    "sbggsbgWbb",
    "bbggbbgcrm",
    "mmmggmgrrm",
    "mmgmmmmmmm",
  }, FLOWER)
end, "poppies, cornflowers and a daisy")
sprite("flowers_1", 10, 6, function(g)
  map(g, 0, 0, {
    "..cr...W..",
    "..rr..WyWg",
    "agggsbgWgg",
    "gaggbbgaag",
    "mmaggmgggm",
    "mmgmmmmmmm",
  }, FLOWER)
end, "fewer flowers")
sprite("flowers_2", 10, 6, function(g)
  map(g, 0, 0, {
    "..ao...K..",
    "..oo..KoKa",
    "oaaaoaaKaa",
    "oaaaooaoaa",
    "avaaavaooa",
    "vvavvvvvvv",
  }, FLOWER)
end, "dry: seed heads")
sprite("flowers_3", 10, 6, function(g)
  map(g, 0, 0, {
    "...BB.....",
    "...BB.....",
    "B...w...w.",
    "Bw..w..w..",
    ".wv.wv.wvv",
    "vvvBBvvBBv",
  }, FLOWER)
end, "dead stalks")

---------------------------------------------------------------------------------------------------
-- Rocks: grey field boulders with a cushion of moss. Stone does not burn, but its moss does: _1
-- the moss dried brown, _2 burnt off, leaving soot where it was.
---------------------------------------------------------------------------------------------------
local ROCK = { "...GGhh...", "..hmmSSS..", ".hhSSSSgg.", "hSSSSgSggd", "SSSSgggggd", "ggggggdddd" }
local PEBBLE = { "..GG..", ".mmSg.", "hhSggd", "ggggdd" }
local MOSS = { [0] = STONE, { G = "sage", m = "olive" }, { G = "smoke", m = "slate" } }
for k = 0, 2 do
  local pal = {}
  for c, v in pairs(STONE) do pal[c] = MOSS[k][c] or v end
  local tail = k == 0 and "" or "_" .. k
  local what = ({ [0] = "; kept", "; its moss dry", "; its moss burnt off" })[k]
  sprite("rock" .. tail, 10, 6, function(g) map(g, 0, 0, ROCK, pal) end, "field boulder" .. what)
  sprite("rock2" .. tail, 6, 4, function(g) map(g, 0, 0, PEBBLE, pal) end, "pebble" .. what)
end

P.save(S, ART, 3)
if #LONE > 0 then print("flora: lone pixels: " .. table.concat(LONE, FLORA_WHERE and "\n" or ", ")) end

---------------------------------------------------------------------------------------------------
-- Previews
---------------------------------------------------------------------------------------------------
local rgba, R, G, B, A = app.pixelColor.rgba, app.pixelColor.rgbaR, app.pixelColor.rgbaG, app.pixelColor.rgbaB, app.pixelColor.rgbaA
local function family(name)
  local f = assert(io.open(ART .. "/" .. name .. ".json")); local json = f:read("a"); f:close()
  local fam = { base = Image { fromFile = ART .. "/" .. name .. ".png" }, at = {} }
  local lf = io.open(ART .. "/" .. name .. "-lights.png")
  if lf then lf:close(); fam.lights = Image { fromFile = ART .. "/" .. name .. "-lights.png" } end
  for n, x, y, w, h in json:gmatch('"name":"([%w_]+)","x":(%d+),"y":(%d+),"w":(%d+),"h":(%d+)') do
    fam.at[n] = { x = tonumber(x), y = tonumber(y), w = tonumber(w), h = tonumber(h) }
  end
  return fam
end
local MINE = { base = S.base, lights = S.lights, at = {} }
for _, e in ipairs(S.sprites) do MINE.at[e.name] = e end
local VILLAGE, GROUND, DRY = family("village"), family("ground"), family("dry")
-- a sprite's base and lights, frame f, from whichever family has it
local function get(name, f)
  for _, fam in ipairs({ MINE, VILLAGE, GROUND, DRY }) do
    local a = fam.at[name]
    if a then
      local g, l = P.image(a.w, a.h), P.image(a.w, a.h)
      P.blit(g, fam.base, 0, 0, a.x + (f or 0) * a.w, a.y, a.w, a.h)
      if fam.lights then P.blit(l, fam.lights, 0, 0, a.x + (f or 0) * a.w, a.y, a.w, a.h) end
      return g, l
    end
  end
  error("flora preview: no sprite " .. name)
end
-- art multiplied by a light (nil: as drawn), and the lights laid over it untinted
local function stamp(out, g, l, x, y, light)
  local k = light and P.hex(light)
  for j = 0, g.height - 1 do for i = 0, g.width - 1 do
    local c = g:getPixel(i, j)
    if A(c) > 0 then
      if k then c = rgba(R(c) * R(k) // 255, G(c) * G(k) // 255, B(c) * B(k) // 255, 255) end
      out:drawPixel(x + i, y + j, c)
    end
    if light and l and A(l:getPixel(i, j)) > 0 then out:drawPixel(x + i, y + j, l:getPixel(i, j)) end
  end end
end
local function zoomSave(img, n, path)
  local big = P.image(img.width * n, img.height * n)
  for j = 0, img.height - 1 do for i = 0, img.width - 1 do
    local c = img:getPixel(i, j)
    for v = 0, n - 1 do for u = 0, n - 1 do big:drawPixel(i * n + u, j * n + v, c) end end
  end end
  local spr = Sprite(big.width, big.height, ColorMode.RGB)
  spr.cels[1].image = big
  spr:saveCopyAs(path)
  spr:close()
end

-- flora-stages.png: a row per thing, its stages left to right; on top as drawn over the day sky,
-- below each stage multiplied by its light over the amber sky. A tree's row ends, after a gap,
-- with the dead tree the engine shows next.
do
  local LIGHT = { [0] = "#FFFFFF", "#D49989", "#AA5E66", "#B15C60" }
  local ROWS = {
    { "birch", "birch_1", "birch_2", after = "dead1" },
    { "apple", "apple_1", "apple_2", after = "dead1" },
    { "willow", "willow_1", "willow_2", after = "dead2" },
    { "cypress", "cypress_1", "cypress_2", after = "dead1" },
    { "wall", "wall_1", "wall_2", joined = { "wall", "wall_1", "wall_2", "wall", "wall_2", "wall_2", "wall_1", "gate", "fence", "fence", "gate", "wall" } },
    { "hedge", "hedge_1", "hedge_2", joined = { "hedge", "hedge_1", "hedge_2", "hedge", "hedge_2", "hedge_2", "hedge_1", "gate", "hedge" } },
    { "gate", "gate_1", "gate_2", joined = { "fence", "gate", "fence", "wall", "gate_1", "wall", "fence_1", "gate_2", "fence_2" } },
    { "flowers", "flowers_1", "flowers_2", "flowers_3" },
    { "rock", "rock_1", "rock_2", "rock2", "rock2_1", "rock2_2" },
  }
  local GAP, PAD = 6, 4
  local items, width, y = {}, 0, PAD
  for _, row in ipairs(ROWS) do
    local x, h, list = PAD, 0, {}
    for k, n in ipairs(row) do
      if MINE.at[n] then
        local stage = (n:match("_(%d)$") and tonumber(n:match("_(%d)$"))) or 0
        list[#list + 1] = { n, x, stage }
        x = x + MINE.at[n].w + GAP; h = math.max(h, MINE.at[n].h)
      end
    end
    if row.after then
      x = x + GAP
      local g = get(row.after)
      list[#list + 1] = { row.after, x, 3 }; x = x + g.width + GAP; h = math.max(h, g.height)
    end
    if row.joined then
      x = x + GAP * 2
      for _, n in ipairs(row.joined) do
        if not (MINE.at[n] or VILLAGE.at[n] or DRY.at[n]) then goto skip end
        local g = get(n)
        local stage = (n:match("_(%d)$") and tonumber(n:match("_(%d)$"))) or 0
        list[#list + 1] = { n, x, stage }; x = x + g.width; h = math.max(h, g.height)
        ::skip::
      end
    end
    for _, it in ipairs(list) do it[4] = y + h end
    for _, it in ipairs(list) do items[#items + 1] = it end
    width = math.max(width, x + PAD); y = y + h + GAP
  end
  local blockH = y
  local out = P.image(width, blockH * 2)
  P.rect(out, 0, 0, width, blockH, "#72EAD0")
  P.rect(out, 0, blockH, width, blockH, "#E2793C")
  for _, it in ipairs(items) do
    local g, l = get(it[1])
    stamp(out, g, l, it[2], it[4] - g.height, nil)
    stamp(out, g, l, it[2], blockH + it[4] - g.height, LIGHT[it[3]])
  end
  zoomSave(out, 3, ART .. "/flora-stages.png")
end

-- flora-scene.png: the new things standing among the village's, on the field, by the track, as
-- the scene shows them; by day, and multiplied by the late evening light over the amber sky.
do
  local W, H = 420, 110
  local railY = H - 24
  local function scene(light, sky)
    local out = P.image(W, H)
    P.rect(out, 0, 0, W, H, sky)
    local function tile(name, y, f)
      for x = 0, W - 1, 32 do local g, l = get(name, f); stamp(out, g, l, x, y, light) end
    end
    -- main row bottoms at railY - up - 1, up 4..10; side row up 2; tufts up -14..-20
    local function put(name, x, up)
      local g, l = get(name)
      stamp(out, g, l, x, railY - up - g.height, light)
      return x + g.width
    end
    for x = 0, W - 1, 32 do
      local g, l = get("field0", (x // 32) % 2); stamp(out, g, l, x, railY - 26, light)
    end
    local main = {
      { "oak1", 2, 8 }, { "house3", 22, 6 }, { "birch", 52, 9 }, { "apple", 66, 5 }, { "house1", 92, 7 }, { "cypress", 128, 9 },
      { "willow", 140, 5 }, { "sheep", 170, 6 }, { "poplar", 186, 9 }, { "house5", 198, 6 }, { "apple", 240, 8 }, { "cypress", 266, 6 },
      { "cypress", 276, 9 }, { "house2", 290, 6 }, { "birch", 322, 7 }, { "birch", 334, 10 }, { "oak2", 352, 6 }, { "willow", 382, 8 },
    }
    for _, m in ipairs(main) do put(m[1], m[2], m[3]) end
    local x = 0
    for _, n in ipairs({ "wall", "wall", "wall", "gate", "fence", "fence", "fence", "rock" }) do
      x = put(n, x, 2)
    end
    x = x + 6
    for _, n in ipairs({ "hedge", "hedge", "hedge", "hedge", "gate", "wall", "wall", "rock2" }) do x = put(n, x, 2) end
    x = x + 10
    for _, n in ipairs({ "fence", "fence", "gate", "hedge", "hedge", "hedge" }) do x = put(n, x, 2) end
    x = x + 8
    put("rock", x, 2); put("wall", x + 14, 2); put("wall", x + 30, 2); put("wall", x + 46, 2)
    for x = 0, W - 1, 32 do
      local g, l = get("track0", (x // 32) % 2); stamp(out, g, l, x, railY - 1, light)
    end
    for x = 0, W - 1, 32 do
      local g, l = get("front0", (x // 32) % 2); stamp(out, g, l, x, H - 16, light)
    end
    local front = { { "flowers", 6, -16 }, { "tuft1", 30, -18 }, { "flowers", 60, -14 }, { "tuft3", 92, -19 }, { "flowers", 130, -17 },
                    { "tuft2", 160, -15 }, { "flowers", 205, -19 }, { "flowers", 250, -15 }, { "tuft1", 290, -17 }, { "flowers", 330, -16 },
                    { "tuft3", 370, -14 }, { "flowers", 400, -18 } }
    for _, f in ipairs(front) do put(f[1], f[2], f[3]) end
    return out
  end
  local day, eve = scene(nil, "#72EAD0"), scene("#BF7B77", "#E2793C")
  local out = P.image(W, H * 2 + 4)
  P.rect(out, 0, 0, W, H * 2 + 4, "#000000")
  P.blit(out, day, 0, 0); P.blit(out, eve, 0, H + 4)
  zoomSave(out, 3, ART .. "/flora-scene.png")
end
