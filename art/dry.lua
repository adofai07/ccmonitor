-- dry.lua: the countryside drying out, from the warning floor (70% by default) to the sunset (92.5%).
-- Each plant of village.lua as _1 turning and _2 dry, the tufts also as _3 stubble, and the fence as
-- fence_1 weathered and fence_2 broken; dead1 and dead2 are hell.lua's charred trees before the fire. Every variant keeps its original's size,
-- bottom row and trunk, so the engine can swap it in place.
local P = dofile(ART .. "/px.lua")
local S = P.sheet("dry", 512, 64)

-- Draws each frame into a cell-sized image, so nothing can spill onto a neighbour.
local function sprite(name, w, h, draw, note)
  local cell = P.strip(S, name, w, h, 1, note)
  local g, l = P.image(w, h), P.image(w, h)
  draw(g, l)
  local x, y = cell(0)
  P.blit(S.base, g, x, y)
  P.blit(S.lights, l, x, y)
end

-- P.map with every row checked: a row of the wrong width is a typo, not a shape.
local function map(g, x, y, rows, legend)
  for j, r in ipairs(rows) do
    if #r ~= #rows[1] then error("row " .. j .. " is " .. #r .. " wide, expected " .. #rows[1] .. ": " .. r) end
  end
  P.map(g, x, y, rows, legend)
end

-- The finished families, read back as pixels by sprite name (as pack.lua reads them).
local function family(name)
  local f = assert(io.open(ART .. "/" .. name .. ".json")); local json = f:read("a"); f:close()
  local fam = { base = Image { fromFile = ART .. "/" .. name .. ".png" }, at = {} }
  for n, x, y, w, h in json:gmatch('"name":"([%w_]+)","x":(%d+),"y":(%d+),"w":(%d+),"h":(%d+)') do
    fam.at[n] = { x = tonumber(x), y = tonumber(y), w = tonumber(w), h = tonumber(h) }
  end
  return fam
end
local VILLAGE, HELL = family("village"), family("hell")
local function copy(fam, name)
  local a = assert(fam.at[name], name)
  local img = P.image(a.w, a.h)
  P.blit(img, fam.base, 0, 0, a.x, a.y, a.w, a.h)
  return img, a
end
local NAME = {}
for k, v in pairs(P.C) do NAME[P.hex(v)] = k end
local function at(g, x, y)
  if x < 0 or y < 0 or x >= g.width or y >= g.height then return nil end
  local c = g:getPixel(x, y)
  return app.pixelColor.rgbaA(c) > 0 and NAME[c] or nil
end

---------------------------------------------------------------------------------------------------
-- Trees and bushes. The crowns are village.lua's: the same clumps in the same places and order, lit
-- from the top left, so each tree keeps its outline while its leaves turn. Each colour moves one
-- step a stage along the same ramp: lime -> lime -> sage on the sunlit cap, grass -> sage -> ochre
-- in the body, moss -> olive in the shade, slate -> bark underneath. Turning, the shaded half of the
-- crown goes first and the sunlit cap and the heart stay green; dry, the outer clumps fall away,
-- the rest is straw, and the last of the green lingers in the shade of the heart and low on the left.
---------------------------------------------------------------------------------------------------
local CLUMP = {
  L = { "...aaaa...", ".aaaaaaab.", "aaaaaaaabb", "aaaaaaabbb", "baaaabbbbb", "bbbbbbbbcc", ".bbbbbccc.", "...cccc..." },
  M = { "..aaaa..", ".aaaaab.", "aaaaabbb", "baabbbbc", ".bbbbcc.", "..cccc.." },
  S = { ".aaa..", "aaaab.", "bbbbcc", ".bccc." },
}
local TONE = {
  lit = { a = "lime", b = "grass", c = "moss" },
  mid = { a = "grass", b = "grass", c = "moss" },
  low = { a = "grass", b = "moss", c = "slate" },
  -- turning: the shaded clumps first, each a step down the ramp
  sallow = { a = "sage", b = "sage", c = "moss" },
  sallowLow = { a = "sage", b = "olive", c = "slate" },
  yellowing = { a = "sage", b = "ochre", c = "olive" },
  ripening = { a = "sage", b = "ochre", c = "moss" },
  litTurning = { a = "lime", b = "sage", c = "moss" },
  -- dry: lit, mid and low a step down the ramp each, so the light still falls from the top left as
  -- it does in summer: only the sunlit cap is sage, the body ochre, the shade olive, bark beneath
  dryLit = { a = "sage", b = "ochre", c = "olive" },
  dry = { a = "ochre", b = "ochre", c = "olive" },
  dryHeart = { a = "ochre", b = "ochre", c = "moss" },
  dryLow = { a = "ochre", b = "olive", c = "bark" },
  dryLowGreen = { a = "ochre", b = "olive", c = "moss" },
}
-- Turns any lone pixel of colour `c` inside a rectangle into `into`: what an overlap leaves behind.
local function tidy(g, x, y, w, h, c, into)
  local lone = {}
  for j = y, y + h - 1 do for i = x, x + w - 1 do
    if at(g, i, j) == c then
      local n = 0
      for dj = -1, 1 do for di = -1, 1 do
        if (di ~= 0 or dj ~= 0) and at(g, i + di, j + dj) == c then n = n + 1 end
      end end
      if n == 0 then lone[#lone + 1] = { i, j } end
    end
  end end
  for _, o in ipairs(lone) do P.pix(g, o[1], o[2], into) end
end
-- A selective outline where a crown stands against the field: each pixel of colour `c` in rows
-- y0..y1 that borders the clear on one of `sides` ("l", "r", "t", "b") takes `into`. Dry, the
-- crowns are as ochre as the field behind them, so their shaded edges need a darker line.
local function rim(g, y0, y1, c, into, sides)
  local D = { l = { -1, 0 }, r = { 1, 0 }, t = { 0, -1 }, b = { 0, 1 } }
  local edge = {}
  for j = y0, y1 do for i = 0, g.width - 1 do
    if at(g, i, j) == c then
      for k in sides:gmatch(".") do
        if not at(g, i + D[k][1], j + D[k][2]) then edge[#edge + 1] = { i, j }; break end
      end
    end
  end end
  for _, e in ipairs(edge) do P.pix(g, e[1], e[2], into) end
end
-- A crown is a list of { shape, x, y } clumps; a stage gives each a tone, or false to leave it out,
-- or { tone, shape, dx, dy } to swap it for a smaller clump nudged inwards. A pinhole that a left-out
-- clump leaves between the corners of its neighbours takes the colour above it.
local function crown(g, clumps, stage)
  for i, c in ipairs(clumps) do
    local t = stage[i]
    if t then
      if type(t) == "string" then t = { t } end
      map(g, c[2] + (t[3] or 0), c[3] + (t[4] or 0), CLUMP[t[2] or c[1]], TONE[t[1]])
    end
  end
  for j = 1, g.height - 2 do for i = 1, g.width - 2 do
    if not at(g, i, j) and at(g, i - 1, j) and at(g, i + 1, j) and at(g, i, j - 1) and at(g, i, j + 1) then P.pix(g, i, j, at(g, i, j - 1)) end
  end end
end
-- Draws a sprite as village.lua does at day and checks it against village.png, so a change to the
-- village's art shows up here instead of quietly leaving the stages a different tree.
local function same(name, draw)
  local mine, theirs = P.image(VILLAGE.at[name].w, VILLAGE.at[name].h), copy(VILLAGE, name)
  draw(mine)
  local off = 0
  for j = 0, mine.height - 1 do for i = 0, mine.width - 1 do
    if mine:getPixel(i, j) ~= theirs:getPixel(i, j) then off = off + 1 end
  end end
  if off > 0 then print("dry: " .. name .. " differs from village.png in " .. off .. " px; redraw its stages") end
end
local function blossom(g, list, c)
  for _, b in ipairs(list) do P.rect(g, b[1], b[2], 2, 2, c) end
end
local TRUNK = { w = "wood", b = "bark", p = "plum" }

-- The oaks. Clumps by place: 3 low right, 4 low left, 5 bottom, 6 right shoulder, 7 left, 8 heart,
-- 9 top right, 10 right, 11 top left (sunlit), 12 crown top; 1 and 2 are all but hidden.
local OAK1 = {
  trunk = { ".w..b.", ".w.bb.", ".wwbb.", "..wbb.", "..wbb.", "..wbb.", "..wbb.", "..wbb.", "..wbb.", "..wbb.", ".wwbbb", "wwwbbb" },
  clumps = { { "L", 6, 6 }, { "L", 7, 9 }, { "M", 14, 11 }, { "L", 0, 10 }, { "M", 9, 13 }, { "L", 12, 5 }, { "M", 0, 7 }, { "M", 6, 9 },
             { "L", 11, 1 }, { "M", 15, 9 }, { "L", 2, 2 }, { "M", 8, 0 } },
}
local OAK2 = {
  trunk = { "b.w..b.", ".w.w.b.", ".wwwbb.", "..wwbb.", "..wbbb.", "..wbbb.", "..wbbb.", "..wbbb.", "..wbbb.", "..wbbb.", ".wwbbb.", "wwwbbbb" },
  clumps = { { "L", 8, 7 }, { "L", 12, 8 }, { "M", 18, 13 }, { "L", 0, 12 }, { "L", 9, 14 }, { "L", 16, 6 }, { "M", 0, 9 }, { "L", 7, 10 },
             { "L", 13, 2 }, { "M", 18, 10 }, { "L", 3, 3 }, { "L", 8, 0 } },
}
local OAK_DAY = { "low", "low", "low", "low", "low", "low", "mid", "mid", "mid", "mid", "lit", "lit" }
local OAK_TURNING = { "low", "low", "sallowLow", "sallowLow", "sallowLow", "sallowLow", "sallow", "mid", "ripening", "yellowing", "lit", "lit" }
local OAK_DRY = { "dryLow", "dryLow", "dryLow", { "dryLowGreen", "M", 1, 1 }, "dryLow", false, false, "dryHeart", { "dry", "M", 2, 1 }, false,
                  "dryLit", "dryLit" }
-- oak1's left clump and right clumps stand at the same height, so losing all three would pinch the
-- crown into a waist from both sides: on oak1 the left clump only shrinks, and the bite is all right
local OAK1_DRY = { "dryLow", "dryLow", "dryLow", { "dryLowGreen", "M", 1, 1 }, "dryLow", false, { "dryLow", "S", 1, 2 }, "dryHeart",
                   { "dry", "M", 2, 1 }, false, "dryLit", "dryLit" }
same("oak1", function(g) map(g, 8, 16, OAK1.trunk, TRUNK); crown(g, OAK1.clumps, OAK_DAY); tidy(g, 0, 0, 22, 20, "slate", "moss") end)
same("oak2", function(g) map(g, 10, 18, OAK2.trunk, TRUNK); crown(g, OAK2.clumps, OAK_DAY); tidy(g, 0, 0, 26, 22, "slate", "moss") end)

sprite("oak1_1", 22, 28, function(g)
  map(g, 8, 16, OAK1.trunk, TRUNK)
  crown(g, OAK1.clumps, OAK_TURNING)
  tidy(g, 0, 0, 22, 20, "slate", "moss")
  tidy(g, 0, 0, 22, 20, "moss", "olive")
end)
sprite("oak2_1", 26, 30, function(g)
  map(g, 10, 18, OAK2.trunk, TRUNK)
  crown(g, OAK2.clumps, OAK_TURNING)
  tidy(g, 0, 0, 26, 22, "slate", "moss")
  tidy(g, 0, 0, 26, 22, "moss", "olive")
end)
-- Dry, the shoulder and side clumps have fallen, and the notches they leave make the crown ragged;
-- oak1 shows a dead limb in its notch. The low clumps stand in front of the field, as ochre as
-- they are, so their sides and undersides take an olive outline.
sprite("oak1_2", 22, 28, function(g)
  map(g, 8, 16, OAK1.trunk, TRUNK)
  crown(g, OAK1.clumps, OAK1_DRY)
  tidy(g, 0, 0, 22, 20, "bark", "olive")
  rim(g, 12, 17, "ochre", "olive", "lrb")
  P.pix(g, 16, 10, "bark"); P.pix(g, 17, 9, "bark")
end)
sprite("oak2_2", 26, 30, function(g)
  map(g, 10, 18, OAK2.trunk, TRUNK)
  crown(g, OAK2.clumps, OAK_DRY)
  tidy(g, 0, 0, 26, 22, "bark", "olive")
  rim(g, 14, 19, "ochre", "olive", "lrb")
end)

-- The poplar turns from the outside in, the lime glints still catching the light and the shade edge
-- going olive all the way down: the second tuft and the hearts of the third and fourth stay green.
-- Dry, every tuft is lit alike, a sage glint on ochre where the lime was, the shade olive with the
-- last moss in the second tuft; the waists pinch in, each lower tuft's underside curls olive on
-- the left so the stack still reads against the straw of the field, and the foot of the crown goes
-- brown.
local POPLAR = {
  "....gg....",
  "...gLgm...",
  "...gLgm...",
  "..ggggmm..",
  "..gLLgmm..",
  "..gLggmm..",
  "..ggggmmm.",
  ".ggLgggmm.",
  ".gLLggmmm.",
  ".gLgggmmm.",
  ".ggggmmmm.",
  ".gggggmmm.",
  "ggLLggmmmm",
  "gLLgggmmmm",
  "gLgggmmmmm",
  "ggggmgmmmm",
  "gggggmmmmm",
  "ggLggmmmmm",
  "gLLgggmmmm",
  "gLggmmmmmm",
  "ggggmmmmmm",
  ".gggmgmmm.",
  ".gLggmmmm.",
  ".gLgmmmmm.",
  ".gggmmmmm.",
  ".ggmmmmmm.",
  "..ggmmmm..",
  "..gmmmmm..",
  "...mmmm...",
  "....wb....",
  "....wb....",
  "....wb....",
}
local LEAF = { a = "sage", g = "grass", L = "lime", m = "moss", o = "ochre", v = "olive", w = "wood", b = "bark" }
same("poplar", function(g) map(g, 0, 0, POPLAR, LEAF) end)
sprite("poplar_1", 10, 32, function(g)
  map(g, 0, 0, {
    "....aa....",
    "...aLav...",
    "...aLav...",
    "..aaaamv..",
    "..aLLamv..",
    "..aLaamv..",
    "..aaaammv.",
    ".ggLgggmv.",
    ".gLLggmmv.",
    ".aLgggmmv.",
    ".agggmmmv.",
    ".aagggmmv.",
    "aaLLaammmv",
    "aLLaaammmv",
    "aLaggmmmmv",
    "aaggmgmmmv",
    "aaaaammmmv",
    "aaLaammmmv",
    "aLLaggmmmv",
    "aLagmmmmmv",
    "aaaammmmmv",
    ".aaamammv.",
    ".aLaammmv.",
    ".aLammmmv.",
    ".aaammmmv.",
    ".aammmmmv.",
    "..aammmv..",
    "..ammmmv..",
    "...mmmv...",
    "....wb....",
    "....wb....",
    "....wb....",
  }, LEAF)
end)
sprite("poplar_2", 10, 32, function(g)
  map(g, 0, 0, {
    "....oo....",
    "...oaov...",
    "...oaov...",
    "..oooovv..",
    "..oaaovv..",
    "..oaoovv..",
    "...ooovv..",
    ".ooaoomvv.",
    ".oaaoomvv.",
    ".oaooomvv.",
    ".oooomvv..",
    "..oooovv..",
    ".oaaoovvv.",
    "oaaooovvvv",
    "oaooovvvvv",
    ".voovvvvv.",
    "..voovvv..",
    ".oaoovvvv.",
    "oaaooovvvv",
    "oaoovvvvvv",
    ".voovvvvb.",
    "..vovvvb..",
    ".oaoovvvb.",
    ".oaovvvbb.",
    ".voovvvbb.",
    "..vovvbb..",
    "..vvvbbb..",
    "...vbbb...",
    "...bbbb...",
    "....wb....",
    "....wb....",
    "....wb....",
  }, LEAF)
end)

-- The pine is evergreen: drought only dulls it, then browns it and thins each whorl back to the
-- trunk. Its shade side stays slate throughout, so it keeps its form under the evening light.
local PINE = {
  "......tt......",
  "......tt......",
  ".....gtts.....",
  ".....gtts.....",
  "....ggttss....",
  "....gtttss....",
  ".....gtss.....",
  "....ggttss....",
  "...ggtttsss...",
  "...gttttsss...",
  "..ggtttttsss..",
  "....gttss.....",
  "...ggttsss....",
  "..ggttttsss...",
  "..gtttttssss..",
  ".ggtttttttsss.",
  "...gttttsss...",
  "..ggtttssss...",
  ".ggttttttsss..",
  ".gttttttttsss.",
  "ggttttttttssss",
  "gtttttsstttsss",
  ".gtssttsstsss.",
}
-- thinned: the top of each whorl is bare trunk, and the tips are gone
local PINE_THIN = {
  "......tt......",
  "......tt......",
  ".....gtts.....",
  ".....gtts.....",
  "....ggttss....",
  "....gtttss....",
  "......wb......",
  "....ggwbss....",
  "...ggtttsss...",
  "...gttttss....",
  "...gtttttss...",
  "......wb......",
  "...ggtwbss....",
  "..ggttttsss...",
  "..gtttttsss...",
  "...gtttttss...",
  "......wb......",
  "..ggttwbsss...",
  ".ggttttttsss..",
  ".gttttttttsss.",
  "..gtttttttss..",
  "...gttwbttss..",
  "....tt....ss..",
}
local function pine(g, rows, legend)
  P.rect(g, 6, 22, 2, 6, "bark"); P.vline(g, 6, 22, 6, "wood")
  map(g, 0, 0, rows, legend)
end
same("pine", function(g) pine(g, PINE, { g = "grass", t = "teal", s = "slate" }) end)
sprite("pine_1", 14, 28, function(g) pine(g, PINE, { g = "sage", t = "moss", s = "slate" }) end)
sprite("pine_2", 14, 28, function(g) pine(g, PINE_THIN, { g = "ochre", t = "olive", s = "slate", w = "wood", b = "bark" }) end)

-- The bushes: village.lua's clumps, turning as the oaks do, the blossom going first. Dry, they
-- stand on straw as pale as sage, so they go darker than it rather than paler: an ochre top, ragged
-- and lit from the left, over an olive body, one small sage glint where the light falls, and a dead
-- twig where a clump has died back. By the sunset they stand on field4, the parched earth, as ochre
-- as their tops, so the whole crown is outlined in olive, and bark under the right shoulder parts the mound
-- from its shadow at the darkest light.
local BUSH1 = { { "M", 4, 2 }, { "M", 0, 2 }, { "M", 2, 0 } }
local BUSH2 = { { "M", 8, 4 }, { "M", 0, 4 }, { "M", 5, 3 }, { "M", 8, 0 }, { "M", 2, 1 } }
same("bush1", function(g) crown(g, BUSH1, { "low", "mid", "lit" }); P.hline(g, 0, 7, 12, "moss") end)
same("bush2", function(g)
  crown(g, BUSH2, { "low", "mid", "mid", "mid", "lit" }); P.hline(g, 0, 9, 16, "moss")
  blossom(g, { { 5, 4 }, { 11, 3 }, { 8, 6 }, { 2, 6 } }, "coral")
end)
local SHRUB = { a = "sage", o = "ochre", v = "olive", b = "bark", w = "wood" }
sprite("bush1_1", 12, 8, function(g)
  crown(g, BUSH1, { "sallowLow", "ripening", "litTurning" }); P.hline(g, 0, 7, 12, "moss")
end)
sprite("bush1_2", 12, 8, function(g)
  map(g, 0, 0, {
    ".........b.b",
    "...vv.v...b.",
    "..vaavovv.b.",
    ".vvaoooovvvv",
    "voooooovooov",
    "vooovvvvvvvb",
    ".vvvvvvvbbb.",
    "vvvvvvvvvvvv",
  }, SHRUB)
end)
sprite("bush2_1", 16, 10, function(g)
  crown(g, BUSH2, { "sallowLow", "mid", "ripening", "yellowing", "lit" }); P.hline(g, 0, 9, 16, "moss")
  blossom(g, { { 5, 4 }, { 2, 6 } }, "coral")
  tidy(g, 0, 0, 16, 10, "sage", "ochre")
end)
sprite("bush2_2", 16, 10, function(g)
  map(g, 0, 0, {
    "................",
    "...........w..b.",
    "....vv.v...w.b..",
    "...vaavov...b...",
    "..vooooovvvvbvv.",
    ".vooooovvoooooov",
    "voooovvvvoooovvv",
    "voovvvvvvvvvvvvb",
    ".vvvvvvvvvvvvbb.",
    "vvvvvvvvvvvvvvvv",
  }, SHRUB)
end)

---------------------------------------------------------------------------------------------------
-- The dead trees: hell's charred trees as they stood before the fire, limb for limb. The charcoal
-- reads back as dead wood: the ashen light on the upper left limbs is lit wood, the char is bark,
-- the trunk's far edge is plum, and the burnt-out hollows are knotholes. Nothing glows yet.
---------------------------------------------------------------------------------------------------
local function dead(from)
  local img = copy(HELL, from)
  local w, h = img.width, img.height
  local out = P.image(w, h)
  local hollow = function(x, y)
    if at(img, x, y) ~= "black" then return false end
    for _, d in ipairs({ { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }) do
      if at(img, x + d[1], y + d[2]) == "black" then return true end
    end
    return false
  end
  for y = 0, h - 1 do
    local x = 0
    while x < w do
      if at(img, x, y) then
        local x1 = x
        while at(img, x1 + 1, y) do x1 = x1 + 1 end
        for i = x, x1 do
          local c = at(img, i, y)
          local tone = "bark"
          if c == "smoke" or c == "slate" then tone = "wood"
          elseif hollow(i, y) then tone = "plum"
          elseif i == x1 and x1 - x >= 2 and (at(img, i, y - 1) or at(img, i - 1, y - 1)) then tone = "plum" end
          P.pix(out, i, y, tone)
        end
        x = x1 + 1
      else
        x = x + 1
      end
    end
  end
  -- a glint of one pixel runs on down its limb, so the light lies along the wood in pairs
  local glints = {}
  for y = 0, h - 1 do for x = 0, w - 1 do
    if at(out, x, y) == "wood" then
      local lone = true
      for dy = -1, 1 do for dx = -1, 1 do
        if (dx ~= 0 or dy ~= 0) and at(out, x + dx, y + dy) == "wood" then lone = false end
      end end
      if lone then
        for _, dx in ipairs({ 0, -1, 1 }) do
          if at(out, x + dx, y + 1) == "bark" then glints[#glints + 1] = { x + dx, y + 1 }; break end
        end
      end
    end
  end end
  for _, p in ipairs(glints) do P.pix(out, p[1], p[2], "wood") end
  return out
end
-- charred1's and charred2's upper left limbs carry no ash, so the light along their upper edges is
-- put in by hand, the same on both trees
sprite("dead1", 18, 26, function(g)
  P.blit(g, dead("charred1"), 0, 0)
  for _, p in ipairs({ { 3, 1 }, { 3, 2 }, { 3, 3 }, { 0, 5 }, { 1, 6 }, { 2, 7 }, { 3, 8 } }) do P.pix(g, p[1], p[2], "wood") end
  tidy(g, 0, 0, 18, 26, "plum", "bark")
end, "charred1 before the fire")
sprite("dead2", 22, 30, function(g)
  P.blit(g, dead("charred2"), 0, 0)
  for _, p in ipairs({ { 4, 1 }, { 4, 2 }, { 4, 3 }, { 1, 4 }, { 2, 5 }, { 3, 6 }, { 3, 7 } }) do P.pix(g, p[1], p[2], "wood") end
  tidy(g, 0, 0, 22, 30, "plum", "bark")
end, "charred2 before the fire")

---------------------------------------------------------------------------------------------------
-- Tufts: the flowers go first, then the green, then the height.
---------------------------------------------------------------------------------------------------
local TUFT = { y = "yellow", k = "sand", K = "skin", g = "grass", m = "moss", a = "sage", o = "ochre", v = "olive", b = "bark", w = "wood",
               r = "coral", W = "white", s = "sky" }
-- turning: the flowers gone to seed heads but for tuft3's daisy, the grass yellowing at the tips
sprite("tuft1_1", 8, 5, function(g)
  map(g, 0, 0, {
    "..k.....",
    "..o...a.",
    "..a.g.a.",
    ".m.gg.ma",
    "mmgggmmm",
  }, TUFT)
end)
sprite("tuft1_2", 8, 5, function(g)
  map(g, 0, 0, {
    "........",
    "..o...a.",
    "..o.a.a.",
    ".v.aa.va",
    "vvaaavvv",
  }, TUFT)
end)
-- stubble: short cut stalks, lit on the left, on a plain olive foot with bark only where they stand
sprite("tuft1_3", 8, 5, function(g)
  map(g, 0, 0, {
    "........",
    "........",
    "..w...w.",
    ".vwb..wb",
    "vvbbvvbb",
  }, TUFT)
end)
sprite("tuft2_1", 8, 6, function(g)
  map(g, 0, 0, {
    "........",
    ".a..k...",
    ".a..o.a.",
    "gm.g.ga.",
    "mg.gmgm.",
    "mmgmmmmm",
  }, TUFT)
end)
sprite("tuft2_2", 8, 6, function(g)
  map(g, 0, 0, {
    "........",
    ".o......",
    ".a....o.",
    "av.a.aa.",
    "va.avav.",
    "vvavvvvv",
  }, TUFT)
end)
sprite("tuft2_3", 8, 6, function(g)
  map(g, 0, 0, {
    "........",
    "........",
    "......w.",
    "..w...w.",
    ".vwbv.wb",
    "vvbbvvbb",
  }, TUFT)
end)
sprite("tuft3_1", 10, 6, function(g)
  map(g, 0, 0, {
    ".W........",
    "WyW....a..",
    ".W.a...aa.",
    ".m.g.a.mg.",
    "mmgmgg.mgg",
    "mmmmmgmmmm",
  }, TUFT)
end)
sprite("tuft3_2", 10, 6, function(g)
  map(g, 0, 0, {
    "..........",
    ".o........",
    ".o.a...aa.",
    ".v.a.a.va.",
    "vvavaa.vaa",
    "vvvvvavvvv",
  }, TUFT)
end)
sprite("tuft3_3", 10, 6, function(g)
  map(g, 0, 0, {
    "..........",
    "..........",
    "..........",
    "..w.....w.",
    ".vwbv.v.wb",
    "vvbbvvvvbb",
  }, TUFT)
end)

---------------------------------------------------------------------------------------------------
-- Fences. A tile's end boards (columns 0-3 and 14-15) run on into its neighbour, so their shade
-- rows keep village.lua's wood and any of the three tiles meets any other. The weathering is spread
-- over every board alike: a split along the grain of each lit side, a short grey run on each shade
-- side between the posts, and the posts gone grey down their shaded face.
---------------------------------------------------------------------------------------------------
local FENCE = { S = "sand", w = "wood", M = "smoke" }
-- weathered
sprite("fence_1", 16, 7, function(g)
  map(g, 0, 0, {
    "....SM......SM..",
    "SSwwSMSSwwSSSMwS",
    "wwwwSMwwMMwwSMww",
    "....SM......SM..",
    "SwSSSMSSSSwSSMwS",
    "wwwwSMwwMMMwSMww",
    "....SM......SM..",
  }, FENCE)
end, "repeats left-right; meets fence and fence_2")
-- broken: the left post leans over in two steps, and the top board has come off it to rest on the
-- one below
sprite("fence_2", 16, 7, function(g)
  map(g, 0, 0, {
    "......SM....SM..",
    "SwwSSSSM....SMwS",
    "wwwwwSM...SSSMww",
    ".....SM.SSMMSM..",
    "SwSSSMSSMMSSSMwS",
    "wwwwSMwwMMwwSMww",
    "....SM......SM..",
  }, FENCE)
end, "meets fence and fence_1 at either end")

P.save(S, ART, 3)

---------------------------------------------------------------------------------------------------
-- dry-stages.png: every plant in the order the story shows it, at zoom 3. On top, the art untinted
-- over the day sky; below, each stage multiplied by the light it appears under, over the amber sky.
---------------------------------------------------------------------------------------------------
do
  local LIGHT = { [0] = "#FFFFFF", "#EAB69A", "#BF7B77", "#AA5E66", "#B15C60" }
  local function find(name)
    for _, e in ipairs(S.sprites) do
      if e.name == name then
        local img = P.image(e.w, e.h)
        P.blit(img, S.base, 0, 0, e.x, e.y, e.w, e.h)
        return img
      end
    end
    if VILLAGE.at[name] then return (copy(VILLAGE, name)) end
    if HELL.at[name] then return (copy(HELL, name)) end
    error("dry-stages: no sprite " .. name)
  end
  -- { name, stage }; a row's items stand on one ground line, `joined` rows touch end to end
  local ROWS = {
    { { "oak1", 0 }, { "oak1_1", 1 }, { "oak1_2", 2 }, { "dead1", 3 }, { "charred1", 4 } },
    { { "oak2", 0 }, { "oak2_1", 1 }, { "oak2_2", 2 }, { "dead2", 3 }, { "charred2", 4 } },
    { { "poplar", 0 }, { "poplar_1", 1 }, { "poplar_2", 2 }, { "dead1", 3 }, { "charred1", 4 } },
    { { "pine", 0 }, { "pine_1", 1 }, { "pine_2", 2 } },
    { { "bush1", 0 }, { "bush1_1", 1 }, { "bush1_2", 2 } },
    { { "bush2", 0 }, { "bush2_1", 1 }, { "bush2_2", 2 } },
    { { "tuft1", 0 }, { "tuft1_1", 1 }, { "tuft1_2", 2 }, { "tuft1_3", 3 }, { "tuft2", 0 }, { "tuft2_1", 1 }, { "tuft2_2", 2 }, { "tuft2_3", 3 },
      { "tuft3", 0 }, { "tuft3_1", 1 }, { "tuft3_2", 2 }, { "tuft3_3", 3 } },
    -- every pair of fences meets somewhere along this run
    { joined = true, { "fence", 0 }, { "fence", 0 }, { "fence_1", 1 }, { "fence_1", 1 }, { "fence_2", 2 }, { "fence_1", 1 }, { "fence_2", 2 },
      { "fence_2", 2 }, { "fence", 0 }, { "fence_2", 2 }, { "fence_1", 1 }, { "fence", 0 }, { "fence", 0 } },
  }
  local GAP, PAD = 4, 4
  local width, rowH = 0, {}
  for r, row in ipairs(ROWS) do
    local w, h = PAD, 0
    for _, it in ipairs(row) do
      local img = find(it[1])
      it.img = img
      if img then w = w + img.width + (row.joined and 0 or GAP); h = math.max(h, img.height) end
    end
    width = math.max(width, w + PAD); rowH[r] = h
  end
  local blockH = PAD
  for r = 1, #ROWS do blockH = blockH + rowH[r] + GAP end
  local out = P.image(width, blockH * 2)
  P.rect(out, 0, 0, width, blockH, "#72EAD0")
  P.rect(out, 0, blockH, width, blockH, "#E2793C")
  local rgba, R, G, B = app.pixelColor.rgba, app.pixelColor.rgbaR, app.pixelColor.rgbaG, app.pixelColor.rgbaB
  local y = PAD
  for r, row in ipairs(ROWS) do
    local x = PAD
    for _, it in ipairs(row) do
      local img = it.img
      if img then
        local top = y + rowH[r] - img.height
        P.blit(out, img, x, top)
        local light = P.hex(LIGHT[it[2]])
        for j = 0, img.height - 1 do for i = 0, img.width - 1 do
          local c = img:getPixel(i, j)
          if app.pixelColor.rgbaA(c) > 0 then
            out:drawPixel(x + i, blockH + top + j, rgba(R(c) * R(light) // 255, G(c) * G(light) // 255, B(c) * B(light) // 255, 255))
          end
        end end
        x = x + img.width + (row.joined and 0 or GAP)
      end
    end
    y = y + rowH[r] + GAP
  end
  local zoom = 3
  local big = P.image(width * zoom, blockH * 2 * zoom)
  for j = 0, blockH * 2 - 1 do for i = 0, width - 1 do
    local c = out:getPixel(i, j)
    for v = 0, zoom - 1 do for u = 0, zoom - 1 do big:drawPixel(i * zoom + u, j * zoom + v, c) end end
  end end
  local spr = Sprite(big.width, big.height, ColorMode.RGB)
  spr.cels[1].image = big
  spr:saveCopyAs(ART .. "/dry-stages.png")
  spr:close()
end
