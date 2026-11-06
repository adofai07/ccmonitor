-- ground.lua: the land the village stands on, as tiles: the field behind the track, the track's
-- ballast and the bank in front of it. Seven stages short of hell (which is hell.lua's), each a
-- small step further gone than the one before: 0 green, 1 turning, 2 dry grass, 3 drought,
-- 4 parched, 5 scorched, 6 ash. Stages 0, 3 and 6 are the three grounds there were at first.
local P = dofile(ART .. "/px.lua")
local S = P.sheet("ground", 512, 256)

-- Draws each frame into a cell-sized image, so nothing can spill onto a neighbour.
local function sprite(name, w, h, frames, note, draw)
  local cell = P.strip(S, name, w, h, frames, note)
  for f = 0, frames - 1 do
    local g, l = P.image(w, h), P.image(w, h)
    draw(g, l, f)
    local x, y = cell(f)
    P.blit(S.base, g, x, y)
    P.blit(S.lights, l, x, y)
  end
end

-- Ground tiles. Every tile is opaque and wraps at 32, so any two can sit side by side.
local function wrapper(g)
  return function(x, y, c) P.pix(g, x % 32, y, c) end
end
-- Stamps a shape from PATCH; every shape is asymmetric, so the ground stops looking stamped.
local PATCH = {
  a = { "..xxxx..", "xxxxxxxx", "...xxx.." },
  b = { ".xxx....", "xxxxxxx.", "..xxxxxx" },
  c = { "...xxx", "xxxxxx" },
  d = { "xxxx....", ".xxxxxxx" },
  e = { ".xxxxx.....", "xxxxxxxxxxx", "....xxxx..." },
  tick = { "x.x", ".x." },
  lump = { ".x.", "xxx" },
  crackA = { "xx..........", ".xxx........", "...xxxx..x..", "......xxxx..", "..........xx" },
  crackB = { "........xx.", "......xxx..", "..xxxxx....", "xxx..x.....", ".....xx...." },
  -- a crack's fork, for the parched earth
  crackY = { "xx....x", ".xxx.xx", "...xxx.", "...x...", "..xx..." },
}
local function stamp(put, shape, x, y, c)
  for j, row in ipairs(PATCH[shape]) do
    for i = 1, #row do
      if row:sub(i, i) == "x" then put(x + i - 1, y + j - 1, c) end
    end
  end
end

-- { shape, x, y, tone }: thin and light up the field, broader and darker near the track.
local FIELDS = {
  { { "c", 2, 1, 1 }, { "d", 18, 1, 1 }, { "b", 7, 7, 1 }, { "a", 22, 8, 1 }, { "e", 11, 14, 2 } },
  { { "d", 21, 2, 1 }, { "e", 5, 4, 1 }, { "c", 25, 11, 1 }, { "a", 2, 15, 2 }, { "e", 15, 16, 2 } },
}
local FIELD_TUFTS = {
  { { "tick", 13, 3 }, { "lump", 4, 12 }, { "tick", 27, 13 }, { "tick", 3, 20 }, { "lump", 25, 19 } },
  { { "lump", 16, 9 }, { "tick", 2, 9 }, { "tick", 28, 15 }, { "lump", 10, 20 } },
}
local function field(g, v, ramp)
  local put = wrapper(g)
  P.rect(g, 0, 0, 32, 26, ramp.base)
  for _, p in ipairs(FIELDS[v + 1]) do stamp(put, p[1], p[2], p[3], ramp[p[4]]) end
  if ramp.tuft then
    for _, t in ipairs(FIELD_TUFTS[v + 1]) do stamp(put, t[1], t[2], t[3], ramp.tuft) end
  end
  local edge = v == 0 and "10012100011000210010012100001100" or "00121000100021001100012100010010"
  for x = 0, 31 do
    local h = tonumber(edge:sub(x + 1, x + 1))
    for y = 24 - h, 25 do put(x, y, ramp.foot) end
  end
end
-- A flower far off: a two-pixel head on a one-pixel stem.
local function flowers(put, list, c, stem)
  for _, d in ipairs(list) do put(d[1], d[2], c); put(d[1] + 1, d[2], c); put(d[1], d[2] + 1, stem) end
end

local function track(g, v, ramp)
  local put = wrapper(g)
  P.rect(g, 0, 0, 32, 10, ramp.base)
  -- ballast
  local stones = v == 0
    and { { 2, 6 }, { 9, 7 }, { 15, 5 }, { 21, 7 }, { 27, 6 }, { 5, 8 }, { 24, 8 }, { 12, 8 } }
    or { { 4, 7 }, { 11, 6 }, { 18, 8 }, { 25, 5 }, { 30, 7 }, { 7, 5 }, { 14, 8 }, { 21, 6 } }
  for _, s in ipairs(stones) do
    put(s[1], s[2], ramp.lite); put(s[1] + 1, s[2], ramp.lite); put(s[1], s[2] + 1, ramp.dark); put(s[1] + 1, s[2] + 1, ramp.dark)
  end
  -- sleepers, one every 8, all tiles in step
  P.rect(g, 0, 2, 32, 2, ramp.gap)
  for x = 0, 31, 8 do
    for i = 0, 4 do put(x + i, 2, "wood"); put(x + i, 3, "bark"); put(x + i, 4, "plum") end
    put(x, 2, "sand"); put(x + 1, 2, "sand")
  end
  -- rail, the same everywhere so biomes meet cleanly
  P.hline(g, 0, 0, 32, "ice")
  P.hline(g, 0, 1, 32, "stone")
  P.rect(g, 30, 0, 1, 2, "grey")
end

-- The bank in front of the track. Its top rows are ballast colour, so the grass has a jagged edge
-- against the stones although the tile itself is opaque. Each string is a height per column.
local BANK = {
  { "00130000231000013200002310000130", "11100011222111000011112221110000", "01111000011100001111111000001110" },
  { "01300013200002310000130000132000", "00111122211000011111000112221100", "11100011110001111100001110000111" },
}
local function front(g, v, ramp)
  local put = wrapper(g)
  P.rect(g, 0, 0, 32, 16, ramp.back)
  local tier = function(heights, floor, c, tip)
    for x = 0, 31 do
      local h = tonumber(heights:sub(x + 1, x + 1))
      for y = floor - h, 15 do put(x, y, c) end
      if tip and h >= 2 then put(x, floor - h, tip) end
      if tip and h >= 3 then put(x, floor - h + 1, tip) end
    end
  end
  tier(BANK[v + 1][1], 4, ramp.mid, ramp.lite)
  tier(BANK[v + 1][2], 9, ramp.base)
  tier(BANK[v + 1][3], 13, ramp.dark)
end

---------------------------------------------------------------------------------------------------
-- The tools of the stages between. Each between-stage is made of the stages beside it, pixel by
-- pixel, after a map drawn over the whole tile: a stage keeps the shapes of the ones beside it and
-- only which of them shows moves, so the seam between two stages reads as the same ground going
-- over. A map stays off a tile's first and last columns, or comes to the same pixels there in both
-- variants (the bank's map differs at its foot, where the dark band ignores it), so any variant sits
-- beside any (the track's sleeper gaps aside: a sleeper stands between them).
---------------------------------------------------------------------------------------------------
local NAME = {}
for n in pairs(P.C) do NAME[P.hex(n)] = n end
-- reads a map drawn in ASCII over a whole tile; returns key(x, y), its character there
local function ascii(rows, w, h)
  if #rows ~= h then error("map has " .. #rows .. " rows, not " .. h) end
  for j, row in ipairs(rows) do if #row ~= w then error("map row " .. j .. " is " .. #row .. " wide") end end
  return function(x, y) return (y >= 0 and y < h) and rows[y + 1]:sub(x % w + 1, x % w + 1) or "." end
end
-- each pixel from `b` where `at` says, and from `a` elsewhere
local function mix(g, a, b, at)
  for y = 0, a.height - 1 do for x = 0, a.width - 1 do
    g:drawPixel(x, y, (at(x, y) and b or a):getPixel(x, y))
  end end
end
-- draws a stage's tile into fresh images, to build another stage from
local function drawn(draw, w, h, v)
  local g, l = P.image(w, h), P.image(w, h)
  draw(g, l, v)
  return g, l
end
-- recolours every pixel of g by `map`, colour name to colour name
local function swap(g, map)
  for y = 0, g.height - 1 do for x = 0, g.width - 1 do
    local to = map[NAME[g:getPixel(x, y)]]
    if to then P.pix(g, x, y, to) end
  end end
end
-- A burn, after a map: '.' is still the parched ground, '#' (or '+') has burnt and is the ash tile,
-- '*' is the grey heart of a spot that has burnt out and '@' the black where it still smoulders.
-- With `char`, the fire's line is a shade blacker: the top `char` rows of each burnt run.
local CHAR = { smoke = "slate", grey = "slate" }
local function burn(g, parched, ash, key, char)
  local burnt = function(x, y) return y < 0 or key(x, y) ~= "." end
  for y = 0, parched.height - 1 do for x = 0, parched.width - 1 do
    local k = key(x, y)
    if k == "." then
      g:drawPixel(x, y, parched:getPixel(x, y))
    else
      g:drawPixel(x, y, ash:getPixel(x, y))
      local edge = false
      for i = 1, char or 0 do edge = edge or not burnt(x, y - i) end
      local to = edge and CHAR[NAME[ash:getPixel(x, y)]]
      if k == "*" then to = "grey" elseif k == "@" then to = "ink" end
      if to then P.pix(g, x, y, to) end
    end
  end end
end

---------------------------------------------------------------------------------------------------
-- Fields
---------------------------------------------------------------------------------------------------
-- The summer's map: 't' yellows first (stage 1), '.' next (2), and 'h' is the green that holds on
-- until the drought (3). Each is about a third of the tile, and the light patches of the green
-- inside a 't' or an 'h' go with it, so they dry as one.
local SUMMER_FIELD = {
  {
    ".ttttttttt...hhhhhhhhhhhhh......",
    ".tttttttttt..hhhhhhhhhhhhhhh....",
    ".ttttttttttt..hhhhhhhhhhhhhhh...",
    "..tttttttttt.hhhhhhhhhhhhhh.....",
    "...tttttttt...hhhhhhhhhhhh......",
    ".....tttt.....hhhhhhhhh.....tt..",
    "..hhhh..........hhhh....ttttt...",
    ".hhhhhhhhhh..........ttttttttt..",
    ".hhhhhhhhhhhhh.....tttttttttttt.",
    ".hhhhhhhhhhhhhh....tttttttttttt.",
    "..hhhhhhhhhhhhh....ttttttttttt..",
    "..hhhhhhhhhhhh......tttttttttt..",
    ".hhhhhhhhhhh..........tttttt....",
    ".hhhhhhhh....tttttt.....tt......",
    "..hhhhh...tttttttttttt..........",
    "........tttttttttttttttt........",
    ".........ttttttttttttttt........",
    "..........tttttttttttt..........",
    "...tt.........ttttt.....hhhh....",
    "..ttttt.............hhhhhhhhh...",
    ".tttttttttt.......hhhhhhhhhhhh..",
    ".ttttttttttttt...hhhhhhhhhhhhhh.",
    ".tttttttttttttt..hhhhhhhhhhhhhh.",
    ".ttttttttttttttt.hhhhhhhhhhhhhh.",
    "..tttttttttttttt..hhhhhhhhhhhhh.",
    "..tttttttttttttt..hhhhhhhhhhhhh.",
  },
  {
    "...hhhhhhhhhhhh.....ttttttttt...",
    "..hhhhhhhhhhhhhh...ttttttttttt..",
    "....hhhhhhhhhhh...tttttttttttt..",
    "..tt..........ttttttttttttttt...",
    ".ttttttttttttttttt...tttttt.....",
    ".tttttttttttttttttt.............",
    "..ttttttttttttttttt.............",
    "....tttttttttttt.....hhhh.......",
    ".hhh....tttt....hhhhhhhhhhh.....",
    ".hhhhhh....hhhhhhhhhhhhhhhh.....",
    ".hhhhhh...hhhhhhhhhhhhhhhh...tt.",
    "..hhhh....hhhhhhhhhhhhhhhtttttt.",
    "...........hhhhhhhhhhhhtttttttt.",
    "..............hhhhhhh...ttttttt.",
    "..ttttt.................ttttttt.",
    ".ttttttttt..............ttttttt.",
    ".tttttttttt...............tttt..",
    "..tttttttttt....................",
    "...ttttttttt....................",
    "...ttttttttt....hhhhhhhhhhh.....",
    "..tttttttttttt.hhhhhhhhhhhhh....",
    ".ttttttttttttt.hhhhhhhhhhhhhh...",
    ".tttttttttttt..hhhhhhhhhhhhhhh..",
    "..tttttttttttt.hhhhhhhhhhhhhhh..",
    "..tttttttttttt.hhhhhhhhhhhhhhh..",
    "..tttttttttttt.hhhhhhhhhhhhhhh..",
  },
}
-- What the drought leaves of its grass in the parched earth (4): low runs of dead blades on a
-- broken shadow, small up the field and broader near the track. The cracks open in the bare earth
-- between them, where the ash's cracks will be, and never come within a pixel of a run.
local CLUMP = {
  s1 = { ".a..a.a",
         ".aa.aaa",
         "ooo.oo." },
  s2 = { "a..a.a.",
         "aa.aaa.",
         ".oo.ooo" },
  m1 = { "..a.a..a.",
         "a.aaa.aaa",
         "aaaaaaaaa",
         ".oo.oooo." },
  m2 = { ".a..a.a.a.",
         ".aa.aaa.aa",
         "aaaaaaaaaa",
         "aooo.ooo.a" },
  m3 = { "..a..a..",
         "a.aa.aaa",
         "aaaaaaaa",
         ".ooo.oo." },
  l1 = { ".a..a...a.a..",
         ".aa.a.a.a.aa.",
         "aaaaaaaaaaaaa",
         "aooo.oooo.ooa" },
  l2 = { "........a...",
         ".a..a...a.a.",
         ".aa.aa.aa.aa",
         "aaaaaaaaaaaa",
         "aa.ooo.oooa." },
}
local CLUMP_INK = { a = "sage", o = "olive" }
local CLUMPS = {
  { { "s1", 8, 2 }, { "s2", 17, 5 }, { "m2", 13, 10 }, { "m1", 1, 11 }, { "l1", 1, 18 }, { "l2", 18, 18 } },
  { { "s1", 3, 1 }, { "s2", 24, 5 }, { "m2", 2, 7 }, { "m1", 16, 9 }, { "m3", 23, 14 }, { "l1", 15, 19 } },
}
local CRACKS = {
  { { "crackA", 3, 4 }, { "crackB", 18, 13 }, { "crackY", 24, 1 } },
  { { "crackB", 15, 2 }, { "crackA", 1, 15 }, { "crackY", 8, 12 } },
}
-- calls fn(x, y) at each pixel of a run of grass placed as { shape, x, y }
local function blades(c, fn)
  for j, row in ipairs(CLUMP[c[1]]) do for i = 1, #row do
    if row:sub(i, i) ~= "." then fn(c[2] + i - 1, c[3] + j - 1) end
  end end
end
-- The fire comes up from the track, where the sparks fall, and has caught in a spot or two above,
-- a little over half the tile in all. The fire's line is a shade blacker. Each spot is flat and
-- wide, '+', burnt out to a grey heart low in its middle, '*', and smoulders at one end, '@'. A
-- run of dead grass has either burnt whole or stands whole: the fire's line steps round it.
local BURN_FIELD = {
  {
    "................................",
    "........++++..+++...............",
    "......+++++++++++++.............",
    ".....+++++***+++++@@............",
    ".......++++++++++...............",
    "................................",
    "................................",
    "................................",
    "........................++++.++.",
    "......................@@+++++++.",
    "....####................++**+...",
    "..#########.....................",
    "###########..............#######",
    "#############..........#########",
    "#############..........#########",
    "################################",
    "################################",
    "################################",
    "################################",
    "################################",
    "################################",
    "################################",
    "################################",
    "################################",
    "################################",
    "################################",
  },
  {
    "................................",
    "................................",
    "................+++..++++.......",
    "..............++++++++++++......",
    "...........@@++++***++++........",
    "...............++++++++.........",
    "....++...+++....................",
    "..+++++++++++...................",
    "..++++++++++++..................",
    "..@@++***++++++.................",
    "..++++++++++++..................",
    ".....+++++......................",
    "##............................##",
    "##.......................#######",
    "####............################",
    "#####.......####################",
    "################################",
    "################################",
    "################################",
    "################################",
    "################################",
    "################################",
    "################################",
    "################################",
    "################################",
    "################################",
  },
}

local FIELD = {}
FIELD[0] = function(g, l, v)
  field(g, v, { base = "grass", "lime", "sage", tuft = "moss", foot = "moss" })
  local put = wrapper(g)
  if v == 1 then
    flowers(put, { { 3, 8 }, { 7, 11 } }, "white", "moss")
    flowers(put, { { 23, 8 }, { 27, 7 } }, "yellow", "moss")
    flowers(put, { { 19, 12 }, { 11, 21 } }, "coral", "moss")
  end
end
FIELD[3] = function(g, l, v)
  field(g, v, { base = "sage", "sand", "ochre", tuft = "ochre", foot = "olive" })
end
FIELD[6] = function(g, l, v)
  field(g, v, { base = "smoke", "grey", "slate", foot = "slate" })
  local put = wrapper(g)
  if v == 0 then
    stamp(put, "crackA", 3, 4, "ink"); stamp(put, "crackB", 18, 13, "ink")
    P.hline(l, 7, 6, 2, "rust"); P.hline(l, 21, 15, 2, "rust"); P.pix(l, 22, 15, "red")
  else
    stamp(put, "crackB", 15, 2, "ink"); stamp(put, "crackA", 1, 15, "ink")
    P.hline(l, 18, 4, 2, "rust"); P.pix(l, 19, 4, "red"); P.hline(l, 5, 17, 2, "rust")
  end
end
-- the green of stage 0 without its flowers, for the stages between to take theirs from
local function green(g, l, v) field(g, v, { base = "grass", "lime", "sage", tuft = "moss", foot = "moss" }) end
-- the drought's grass before its light patches have dried to sand, for the first patches to turn
local function yellowing(g, l, v) FIELD[3](g, l, v); swap(g, { sand = "sage" }) end
FIELD[1] = function(g, l, v)
  local key = ascii(SUMMER_FIELD[v + 1], 32, 26)
  mix(g, drawn(green, 32, 26, v), drawn(yellowing, 32, 26, v), function(x, y) return key(x, y) == "t" end)
  if v == 1 then flowers(wrapper(g), { { 27, 7 } }, "yellow", "moss") end
end
FIELD[2] = function(g, l, v)
  local key = ascii(SUMMER_FIELD[v + 1], 32, 26)
  mix(g, drawn(FIELD[3], 32, 26, v), drawn(green, 32, 26, v), function(x, y) return key(x, y) == "h" end)
end
-- the brown earth, cracked in its own darker shade, and the dead grass standing on it
FIELD[4] = function(g, l, v)
  field(g, v, { base = "ochre", "sand", "wood", foot = "olive" })
  local crack = P.image(32, 26)
  for _, c in ipairs(CRACKS[v + 1]) do
    stamp(wrapper(g), c[1], c[2], c[3], "bark")
    stamp(wrapper(crack), c[1], c[2], c[3], "bark")
  end
  local cracked = function(x, y) return y >= 0 and y < 26 and app.pixelColor.rgbaA(crack:getPixel(x % 32, y)) > 0 end
  for _, c in ipairs(CLUMPS[v + 1]) do
    blades(c, function(x, y)
      for dy = -1, 1 do for dx = -1, 1 do
        if cracked(x + dx, y + dy) then error("field4 v" .. v .. ": the " .. c[1] .. " touches a crack at " .. x .. "," .. y) end
      end end
    end)
    P.map(g, c[2], c[3], CLUMP[c[1]], CLUMP_INK)
  end
end
FIELD[5] = function(g, l, v)
  local ash, embers = drawn(FIELD[6], 32, 26, v)
  local key = ascii(BURN_FIELD[v + 1], 32, 26)
  for _, c in ipairs(CLUMPS[v + 1]) do
    local burnt, standing = 0, 0
    blades(c, function(x, y)
      if key(x, y) == "." then standing = standing + 1 else burnt = burnt + 1 end
    end)
    if burnt > 0 and standing > 0 then error("field5 v" .. v .. ": the fire cuts the " .. c[1] .. " at " .. c[2] .. "," .. c[3]) end
  end
  -- a spot that caught on its own, '+', is plain ash, without the cracks the main fire leaves
  for y = 0, 25 do for x = 0, 31 do if key(x, y) == "+" then P.pix(ash, x, y, "smoke") end end end
  burn(g, drawn(FIELD[4], 32, 26, v), ash, key, 2)
  for y = 0, 25 do for x = 0, 31 do
    local c = embers:getPixel(x, y)
    if key(x, y) == "#" and app.pixelColor.rgbaA(c) > 0 then l:drawPixel(x, y, c) end
  end end
  -- and an ember wherever it still smoulders, over each '@'
  for y = 0, 25 do for x = 0, 31 do
    if key(x, y) == "@" then P.pix(l, x, y, key(x - 1, y) == "@" and "red" or "rust") end
  end end
end

local FIELD_NOTE = {
  [0] = "green; variant 1 has wildflowers", "turning: a third of the grass gone sage, one flower left",
  "dry grass: two thirds sage, the green holding on in patches", "dry summer drought",
  "parched: brown cracked earth round clumps of dead grass", "scorched: the fire spreading up from the track; embers in the lights",
  "ash, with a few dark cracks and embers in the lights",
}
for s = 0, 6 do sprite("field" .. s, 32, 26, 2, FIELD_NOTE[s], FIELD[s]) end

---------------------------------------------------------------------------------------------------
-- Tracks: the ballast goes dusty, then dry, then bleached, then burns. The rails never change.
---------------------------------------------------------------------------------------------------
-- The summer's map of the ballast, as the field's: 't' dusts over first (1), 'h' holds its grey
-- stones until the drought (3), and two of the four sleeper gaps go each way. The dust drifts in:
-- a 't' is narrow on top and broad at its foot, so an 'h' is broad on top and pinched below. Row 8,
-- the last above the bank, is '.' and turns with the bank's ballast; so is any stone that row 8
-- cuts, so a stone never turns by halves.
local SUMMER_TRACK = {
  {
    "................................",
    "................................",
    ".....ttt.....hhh.....ttt.....hhh",
    ".....ttt.....hhh.....ttt.....hhh",
    ".....ttt.....hhh.....ttt.....hhh",
    "...tttthhhhhhhhhhhhhtttthhhhhhh.",
    "..tttttthhhhhhhhhhhtttttttthhhh.",
    "..tt.tttt..hhhhhhhttt..tttthhhh.",
    "................................",
    "................................",
  },
  {
    "................................",
    "................................",
    ".....hhh.....ttt.....hhh.....ttt",
    ".....hhh.....ttt.....hhh.....ttt",
    ".....hhh.....ttt.....hhh.....ttt",
    ".hhhhhhhhhhhh.ttttthhhhhhtttt...",
    ".thhhhhhhhhhhtttttttthhhtttttt..",
    ".ttt..hhhhhhhtttt.ttthhttttttt..",
    "................................",
    "................................",
  },
}
-- where the sun has bleached the dust in the ballast (4), in short dashes between the stones: a
-- bleached pixel keeps two pixels clear of a stone's top beside it and one above or below, as the
-- top is the same sand, so every stone stays a stone
local BLEACH = {
  {
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "......xxxx.........xxxx.........",
    "................................",
    "...............xxx..............",
    "................................",
    "................................",
  },
  {
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    ".xxx...........xxxx.............",
    "................................",
    "........................xxxx....",
    "................................",
    "................................",
  },
}
-- the burnt ballast (5): the bottom rows all gone, as the bank's ballast, and runs above with
-- islands of the dry ballast between, and a sleeper gap or two burnt through; the edges burnt in
-- both, so any two join, and no stone burnt by halves
local BURN_TRACK = {
  {
    "................................",
    "................................",
    ".....###.....................###",
    ".....###.....................###",
    ".....###.....................###",
    "##............................##",
    "####.......................#####",
    "#####...####........####...#####",
    "################################",
    "################################",
  },
  {
    "................................",
    "................................",
    ".............###.............###",
    ".............###.............###",
    ".............###.............###",
    "##............................##",
    "###........................#####",
    "######........######......######",
    "################################",
    "################################",
  },
}
local TRACK = {}
TRACK[0] = function(g, l, v) track(g, v, { base = "stone", lite = "steel", dark = "grey", gap = "smoke" }) end
TRACK[3] = function(g, l, v) track(g, v, { base = "ochre", lite = "sand", dark = "wood", gap = "olive" }) end
TRACK[6] = function(g, l, v) track(g, v, { base = "slate", lite = "grey", dark = "ink", gap = "ink" }) end
TRACK[1] = function(g, l, v)
  local key = ascii(SUMMER_TRACK[v + 1], 32, 10)
  mix(g, drawn(TRACK[0], 32, 10, v), drawn(TRACK[3], 32, 10, v), function(x, y) return key(x, y) == "t" end)
end
TRACK[2] = function(g, l, v)
  local key = ascii(SUMMER_TRACK[v + 1], 32, 10)
  mix(g, drawn(TRACK[3], 32, 10, v), drawn(TRACK[1], 32, 10, v), function(x, y) return key(x, y) == "h" end)
end
TRACK[4] = function(g, l, v)
  track(g, v, { base = "ochre", lite = "sand", dark = "bark", gap = "olive" })
  local key = ascii(BLEACH[v + 1], 32, 10)
  local top = function(x, y) return NAME[g:getPixel(x % 32, y)] == "sand" end
  local clear = function(x, y)
    for j = -1, 1 do for i = -1, 1 do if top(x + i, y + j) then return false end end end
    return not (top(x - 2, y) or top(x + 2, y))
  end
  local bleached = {}
  for y = 5, 7 do for x = 0, 31 do
    if key(x, y) == "x" and NAME[g:getPixel(x, y)] == "ochre" and clear(x, y) then bleached[#bleached + 1] = { x, y } end
  end end
  for _, p in ipairs(bleached) do P.pix(g, p[1], p[2], "sand") end
end
TRACK[5] = function(g, l, v)
  burn(g, drawn(TRACK[4], 32, 10, v), drawn(TRACK[6], 32, 10, v), ascii(BURN_TRACK[v + 1], 32, 10))
end
for s = 0, 6 do sprite("track" .. s, 32, 10, 2, "", TRACK[s]) end

---------------------------------------------------------------------------------------------------
-- Banks. A stage's 'back' is its track's ballast.
---------------------------------------------------------------------------------------------------
-- which of the bank's bands a pixel is in
local function band(v, x, y)
  local h = function(t) return tonumber(BANK[v + 1][t]:sub(x % 32 + 1, x % 32 + 1)) end
  if y >= 13 - h(3) then return "dark" elseif y >= 9 - h(2) then return "base"
  elseif y >= 4 - h(1) then return "mid" else return "back" end
end
-- The summer's map of the bank, as the field's, laid like bricks: runs in the tall grass, runs
-- under them in the low grass, and runs under those in the earth at the foot. Its ballast, the
-- 'back' band, turns with the track's row 8 (2) whatever the map says there.
local SUMMER_FRONT = {
  {
    "................................",
    "...t.....t......h......t........",
    "...t....tt......hh....tt........",
    "..tt....ttt....hhh....ttt.......",
    ".ttttttttttt.hhhhhh.tttttttt....",
    ".tttttttttttt.hhhhh.tttttttt....",
    "..ttttttttttt.hhhhhh.ttttttt....",
    "..tttttt.ttttt.hhhhh.thhhttt....",
    ".hhttthh.ttttt.hhh.hhhhhh.tt....",
    ".hhhhhhh.tttttttt..hhhhhh.ttttt.",
    ".hhhhhh..tttttttt..hhhhh..ttttt.",
    ".hhhhhh.ttttttttt.hhhhhh.tttttt.",
    ".httthh.t...tttthhttttth.ttthhh.",
    "hhtttttt.....hhhhhttttt.....hhhh",
    "hhtttttt.....hhhhhttttt.....hhhh",
    "hhhhtttttt.....hhhhhttttt.....hh",
  },
  {
    "................................",
    "..h....t......t......h.....t....",
    "..h....tt....tt......h.....tt...",
    ".hh...ttt....ttt....hh....ttt...",
    ".hhhh.ttttttttttt..hhhhh.tttttt.",
    ".hhhh.ttttttttttt..hhhhh.tttttt.",
    ".hhhh.tttttttttttt.hhhhh.tttttt.",
    ".hhh..t..ttttttttt..hhhh..hhttt.",
    ".httttt..hhtttth.ttthhhtt.hhhht.",
    ".tttttt..hhhhhhh.tttttttt.hhhhh.",
    ".tttttt.hhhhhhhh.ttttttt..hhhhh.",
    ".ttttt..hhhhhhh..ttttttt.hhhhhh.",
    "hhhttt..tthhhthhhhtttt..thhhhthh",
    "hhh.....tttttthhhhh.....tttttthh",
    "hhh.....tttttthhhhh.....tttttthh",
    "hhhhh.....tttttthhhhh.....tttthh",
  },
}
-- The bank burns (5) from the top: all its ballast, as the track's, and all its tall grass but a
-- low run of it, long in one variant and short in the other (`stand`, a digit per column, the row
-- the grass still stands from, or '.' where it has burnt), singed slate where the fire cut it and
-- keeping a tip or two where it did not. The earth
-- under the burnt grass has burnt down to a floor that steps along the tile in flat runs (`floor`,
-- a row per column, 0-9 and a-d for 10-13: the earth above it has burnt), in one run down to the
-- dark foot, and leaves two rows of earth or none. Both variants say the same at the tile's edges,
-- so any two join.
local BURN_FRONT = {
  { stand = "......66555655665456654556......", floor = "aaaaaa00000000000000000000bbccca" },
  { stand = "...................66556554556..", floor = "aaaabbccccdddccccaa00000000000aa" },
}
local FRONT = {}
FRONT[0] = function(g, l, v)
  front(g, v, { back = "stone", mid = "grass", lite = "lime", base = "moss", dark = "slate" })
  if v == 1 then
    local put = wrapper(g)
    flowers(put, { { 6, 6 }, { 22, 7 } }, "white", "moss")
    flowers(put, { { 14, 5 } }, "yellow", "moss")
  end
end
FRONT[3] = function(g, l, v)
  front(g, v, { back = "ochre", mid = "sage", lite = "sand", base = "olive", dark = "bark" })
end
FRONT[6] = function(g, l, v)
  front(g, v, { back = "slate", mid = "smoke", lite = "grey", base = "slate", dark = "ink" })
end
local function greenBank(g, l, v) front(g, v, { back = "stone", mid = "grass", lite = "lime", base = "moss", dark = "slate" }) end
-- The earth at the foot, the 'dark' band, warms by layers rather than by the map: its bottom row
-- in stage 1 and the rest in stage 2.
FRONT[1] = function(g, l, v)
  local key = ascii(SUMMER_FRONT[v + 1], 32, 16)
  mix(g, drawn(greenBank, 32, 16, v), drawn(FRONT[3], 32, 16, v), function(x, y)
    local at = band(v, x, y)
    if at == "dark" then return y == 15 end
    return at ~= "back" and key(x, y) == "t"
  end)
  if v == 1 then flowers(wrapper(g), { { 20, 5 } }, "yellow", "moss") end
end
FRONT[2] = function(g, l, v)
  local key = ascii(SUMMER_FRONT[v + 1], 32, 16)
  mix(g, drawn(FRONT[3], 32, 16, v), drawn(greenBank, 32, 16, v), function(x, y)
    local at = band(v, x, y)
    return at ~= "back" and at ~= "dark" and key(x, y) == "h"
  end)
end
-- The tufts that have died off to the earth (4).
local BARE = {
  { { "b", 1, 6 }, { "a", 22, 6 } },
  { { "b", 1, 6 }, { "e", 10, 6 }, { "c", 9, 7 } },
}
-- Recolours the pixels under each { shape, x, y } by `map`, colour name to colour name, once each.
local function recolour(g, marks, map)
  local done = {}
  local put = function(x, y)
    x = x % 32
    if y < 0 or y >= g.height or done[y * 32 + x] then return end
    done[y * 32 + x] = true
    local to = map[NAME[g:getPixel(x, y)]]
    if to then P.pix(g, x, y, to) end
  end
  for _, m in ipairs(marks) do stamp(put, m[1], m[2], m[3]) end
end
-- The low grass still standing on the bare earth (4): a digit per column, how many rows of the
-- earth's top it keeps, so its foot steps with the bank's, ragged; sage down to a shadow in olive
-- at the foot of each column.
local LOW = { "00000000000112221122110000001210", "00000012210000000000000012212110" }
FRONT[4] = function(g, l, v)
  front(g, v, { back = "ochre", mid = "sage", lite = "sand", base = "wood", dark = "bark" })
  recolour(g, BARE[v + 1], { sage = "wood" })
  for x = 0, 31 do
    local top = 0
    while band(v, x, top) ~= "base" do top = top + 1 end
    local h = tonumber(LOW[v + 1]:sub(x + 1, x + 1))
    for y = top, top + h - 2 do P.pix(g, x, y, "sage") end
    if h > 0 then P.pix(g, x, top + h - 1, "olive") end
  end
end
FRONT[5] = function(g, l, v)
  local b = BURN_FRONT[v + 1]
  local burnt = P.image(32, 16)
  front(burnt, v, { back = "slate", mid = "smoke", lite = "grey", base = "bark", dark = "plum" })
  burn(g, drawn(FRONT[4], 32, 16, v), burnt, function(x, y)
    local at, i = band(v, x, y), x % 32 + 1
    if at == "back" then return "#" end
    if at == "mid" then
      local from = tonumber(b.stand:sub(i, i))
      return (from and y >= from) and "." or "#"
    end
    return y < tonumber(b.floor:sub(i, i), 16) and "#" or "."
  end)
  for x = 0, 31 do
    local from = tonumber(b.stand:sub(x + 1, x + 1))
    if from then
      if band(v, x, from) ~= "mid" then error("front5 v" .. v .. ": the stand at column " .. x .. " is not in the tall grass") end
      if band(v, x, from - 1) == "mid" then P.pix(g, x, from, "slate") end
    end
  end
end
for s = 0, 6 do sprite("front" .. s, 32, 16, 2, "", FRONT[s]) end

P.save(S, ART, 3)

---------------------------------------------------------------------------------------------------
-- ground-stages.png: the scene's ground for stages 0 to 6, left to right, laid out as the engine
-- lays it (the bank's top on the track's row 9), each as variant 0, variant 1 and the engine's
-- seam into the next stage; above, untinted on the day sky, below, multiplied by each stage's
-- light on the evening sky, with the lights over it.
---------------------------------------------------------------------------------------------------
do
  local LIGHT = { "#FFFFFF", "#EAB69A", "#D49989", "#BF7B77", "#AA5E66", "#B15C60", "#C35855" }
  local BAYER = { 0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5 }
  local rgba, R, G, B, A = app.pixelColor.rgba, app.pixelColor.rgbaR, app.pixelColor.rgbaG, app.pixelColor.rgbaB, app.pixelColor.rgbaA
  local find = {}
  for _, e in ipairs(S.sprites) do find[e.name] = e end
  local function frame(img, name, f)
    local e = find[name]
    return Image(img, Rectangle(e.x + f * e.w, e.y, e.w, e.h))
  end
  local function seam(a, b)
    local out = Image(a)
    for y = 0, a.height - 1 do for x = 0, 31 do
      if (BAYER[((y >> 1) & 3) * 4 + ((x >> 1) & 3) + 1] + 0.5) / 16 < (x + 0.5) / 32 then out:drawPixel(x, y, b:getPixel(x, y)) end
    end end
    return out
  end
  local function rgb(hexs)
    local c = P.hex(hexs)
    return { R(c), G(c), B(c) }
  end
  local SKY, TALL = 5, 50
  -- each column: a stage and the variant of its field, track and bank, or "seam"
  local cols = {}
  for s = 0, 6 do
    cols[#cols + 1] = { s, { 0, 0, 0 } }
    cols[#cols + 1] = { s, { 1, 1, 1 } }
    if s < 6 then cols[#cols + 1] = { s, "seam" } end
  end
  local W, rowH = #cols * 32, SKY + TALL
  local out = P.image(W, rowH * 2)
  P.rect(out, 0, 0, W, rowH, "#72EAD0")
  P.rect(out, 0, rowH, W, rowH, "#E2793C")
  for i, c in ipairs(cols) do
    local s, f = c[1], c[2]
    local x0 = (i - 1) * 32
    local base, lights = P.image(32, TALL), P.image(32, TALL)
    for k, part in ipairs({ { "field", 0 }, { "track", 25 }, { "front", 34 } }) do
      local name = part[1] .. s
      local b, l
      if f == "seam" then
        local nxt = part[1] .. (s + 1)
        b = seam(frame(S.base, name, 0), frame(S.base, nxt, 0))
        l = seam(frame(S.lights, name, 0), frame(S.lights, nxt, 0))
      else
        b, l = frame(S.base, name, f[k]), frame(S.lights, name, f[k])
      end
      for y = 0, b.height - 1 do for x = 0, 31 do
        base:drawPixel(x, part[2] + y, b:getPixel(x, y))
        lights:drawPixel(x, part[2] + y, l:getPixel(x, y))
      end end
    end
    local lt = rgb(LIGHT[s + 1])
    if f == "seam" then
      local nt = rgb(LIGHT[s + 2])
      lt = { (lt[1] + nt[1]) // 2, (lt[2] + nt[2]) // 2, (lt[3] + nt[3]) // 2 }
    end
    for y = 0, TALL - 1 do for x = 0, 31 do
      local c = base:getPixel(x, y)
      out:drawPixel(x0 + x, SKY + y, c)
      local t = rgba(R(c) * lt[1] // 255, G(c) * lt[2] // 255, B(c) * lt[3] // 255, 255)
      local e = lights:getPixel(x, y)
      out:drawPixel(x0 + x, rowH + SKY + y, A(e) > 0 and e or t)
    end end
    -- a mark in the sky where each stage begins
    if f ~= "seam" and f[1] == 0 then
      P.rect(out, x0, 0, 2, 3, "ink"); P.rect(out, x0, rowH, 2, 3, "ink")
    end
  end
  local zoom = 3
  local big = P.image(W * zoom, rowH * 2 * zoom)
  for y = 0, rowH * 2 - 1 do for x = 0, W - 1 do
    local c = out:getPixel(x, y)
    for j = 0, zoom - 1 do for i = 0, zoom - 1 do big:drawPixel(x * zoom + i, y * zoom + j, c) end end
  end end
  local spr = Sprite(big.width, big.height, ColorMode.RGB)
  spr.cels[1].image = big
  spr:saveCopyAs(ART .. "/ground-stages.png")
  spr:close()
  print("ground-stages.png " .. big.width .. "x" .. big.height)
end
