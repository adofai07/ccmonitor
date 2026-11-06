-- farm.lua: the farmland between the villages. A red plank barn and its stone granary, a hay wain,
-- a herd of cows, a scarecrow, and the fields: wheat in tiling patches and a row of sunflowers.
-- Each thing that decays comes in its stages, made from its own base drawing as worn.lua and dry.lua
-- make the village's: the same boards, holes and cracks carry from one stage into the next.
local P = dofile(ART .. "/px.lua")
local S = P.sheet("farm", 512, 64)

---------------------------------------------------------------------------------------------------
-- Pixel tools (after village.lua and worn.lua)
---------------------------------------------------------------------------------------------------
local NAME = {}
for n in pairs(P.C) do NAME[P.hex(n)] = n end
local pc = app.pixelColor

-- P.map with every row checked: a row of the wrong width is a typo, not a shape.
local function map(g, x, y, rows, legend)
  for j, r in ipairs(rows) do
    if #r ~= #rows[1] then error("row " .. j .. " is " .. #r .. " wide, expected " .. #rows[1] .. ": " .. r) end
  end
  P.map(g, x, y, rows, legend)
end

-- The palette name at x, y, or nil where the sprite is clear.
local function at(g, x, y)
  if x < 0 or y < 0 or x >= g.width or y >= g.height then return nil end
  local c = g:getPixel(x, y)
  if pc.rgbaA(c) == 0 then return nil end
  return NAME[c] or "?"
end

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

-- Roof courses that follow the slope (village.lua's): a soft line every third row with staggered
-- gaps, and a short highlight dash; `lean` slides the pattern sideways per row down the pitch.
local function courses(g, y0, y1, left, right, ramp, lean)
  local dash = ramp.dash or 6
  for y = y0, y1 do
    local r = y - y0
    local course = r // 3
    for x = left(y), right(y) do
      local u = x - math.floor(r * lean) + course * 3
      local c = ramp.base
      if r % 3 == 2 and u % 6 ~= 0 then c = ramp.line
      elseif r % 3 == 0 and (u % dash == 3 or u % dash == 4) then c = ramp.lite end
      P.pix(g, x, y, c)
    end
  end
  tidy(g, 0, y0, g.width, y1 - y0 + 1, ramp.line, ramp.base)
end

---------------------------------------------------------------------------------------------------
-- Wear and fire (after worn.lua): ramps that take each colour a step down its own material, and
-- the tools that lay them on: washes, cracks, holes to the rafters, boards, broken glass, soot.
---------------------------------------------------------------------------------------------------
local function remapAt(g, ramp, i, j)
  local n = at(g, i, j)
  if n and ramp[n] then P.pix(g, i, j, ramp[n]) end
end
local function remap(g, ramp, x, y, w, h)
  x, y, w, h = x or 0, y or 0, w or g.width, h or g.height
  for j = y, y + h - 1 do for i = x, x + w - 1 do remapAt(g, ramp, i, j) end end
end
-- A map whose letters are ramps rather than colours: one patch of grime or soot over any material.
local function wash(g, x, y, rows, ramps)
  for j, r in ipairs(rows) do
    if #r ~= #rows[1] then error("wash row " .. j .. " is " .. #r .. " wide, expected " .. #rows[1] .. ": " .. r) end
    for i = 1, #r do
      local k = r:sub(i, i)
      if k ~= "." and k ~= " " then
        if not ramps[k] then error("wash has no '" .. k .. "'") end
        remapAt(g, ramps[k], x + i - 1, y + j - 1)
      end
    end
  end
end
local function compose(a, b)
  local r = {}
  for k, v in pairs(a) do r[k] = b[v] or v end
  for k, v in pairs(b) do if r[k] == nil then r[k] = v end end
  return r
end
-- GRIME: dust and damp, a shade down; on red paint it is mud. CRACK: a split, two shades down.
local GRIME = { skin = "sand", sand = "ochre", white = "ice", ice = "steel", steel = "stone", stone = "grey", grey = "smoke",
                wood = "bark", red = "wood", coral = "red", yellow = "sand", blue = "navy", navy = "indigo" }
local CRACK = { skin = "wood", sand = "wood", white = "stone", ice = "stone", steel = "grey", stone = "smoke", grey = "slate",
                wood = "bark", bark = "plum", red = "plum", coral = "red", ochre = "bark", smoke = "slate" }
-- SOOT: smoke-stained, toward grey. CHAR: blackened, toward slate and ink. Red paint under smoke
-- goes down its own warm ramp, never grey.
local SOOT = { skin = "stone", sand = "grey", white = "stone", ice = "stone", steel = "grey", stone = "grey", grey = "smoke",
               wood = "smoke", bark = "slate", sage = "smoke", ochre = "smoke", red = "plum", coral = "red", navy = "slate",
               indigo = "ink", plum = "ink", olive = "slate", yellow = "sand", smoke = "slate" }
local CHAR = { skin = "smoke", sand = "smoke", white = "grey", ice = "grey", steel = "smoke", stone = "smoke", grey = "slate",
               smoke = "slate", wood = "slate", bark = "ink", sage = "slate", ochre = "slate", red = "ink", coral = "plum",
               plum = "ink", navy = "ink", indigo = "ink", slate = "ink", olive = "ink" }
local SCORCH = { g = GRIME, s = SOOT, c = compose(SOOT, CHAR), x = compose(compose(SOOT, CHAR), CHAR) }

local function crack(g, pts, ramp)
  local done = {}
  for k = 1, #pts - 2, 2 do
    local x0, y0, x1, y1 = pts[k], pts[k + 1], pts[k + 2], pts[k + 3]
    local n = math.max(math.abs(x1 - x0), math.abs(y1 - y0))
    for s = 0, n do
      local t = n == 0 and 0 or s / n
      local x, y = math.floor(x0 + (x1 - x0) * t + 0.5), math.floor(y0 + (y1 - y0) * t + 0.5)
      if not done[x .. "," .. y] then done[x .. "," .. y] = true; remapAt(g, ramp or CRACK, x, y) end
    end
  end
end
-- damp and dust along the foot of a wall: `heights` is a digit per column from x, rising from y
local function grime(g, x, y, heights, ramp)
  for i = 1, #heights do
    local h = tonumber(heights:sub(i, i))
    for j = 0, h - 1 do remapAt(g, ramp or GRIME, x + i - 1, y - j) end
  end
end
-- every colour run through `ramp` from the top down to a ragged edge: a base-36 digit per column
local function stain(g, y0, edge, ramp, x0)
  x0 = x0 or 0
  for i = 1, #edge do
    local d = tonumber(edge:sub(i, i), 36)
    for y = 0, y0 + d - 1 do remapAt(g, ramp, x0 + i - 1, y) end
  end
end

-- the same over rows y0 down to y0 + d - 1 only: a band whose lower edge is ragged
local function band(g, y0, edge, ramp, x0)
  x0 = x0 or 0
  for i = 1, #edge do
    local d = tonumber(edge:sub(i, i), 36)
    for y = y0, y0 + d - 1 do remapAt(g, ramp, x0 + i - 1, y) end
  end
end

-- What a stage places by hand, kept out of the tidying pass.
local KEEP
local function protect(x, y) P.pix(KEEP, x, y, "white") end
local function unprotect(x, y, w, h) P.rect(KEEP, x, y, w, h, nil) end
local CODE = { ["0"] = "black", k = "ink", p = "plum", b = "bark", w = "wood", r = "rust", s = "sand", S = "skin",
  y = "yellow", l = "lime", g = "grass", t = "teal", m = "moss", o = "olive", L = "slate", i = "indigo", n = "navy",
  B = "blue", K = "sky", c = "cyan", I = "ice", W = "white", e = "steel", T = "stone", G = "grey", M = "smoke",
  u = "purple", R = "red", C = "coral", P = "pink", a = "sage", O = "ochre" }
-- hand touches, one pixel at a time ("." leaves a pixel, "_" clears it); kept from tidying
local function touch(g, x, y, rows)
  for j, r in ipairs(rows) do
    for i = 1, #r do
      local k = r:sub(i, i)
      if k == "_" then P.pix(g, x + i - 1, y + j - 1, nil); protect(x + i - 1, y + j - 1)
      elseif k ~= "." then
        if not CODE[k] then error("touch has no '" .. k .. "'") end
        P.pix(g, x + i - 1, y + j - 1, CODE[k]); protect(x + i - 1, y + j - 1)
      end
    end
  end
end
-- fire glow deep in an opening: the base goes black and the light goes on the lights layer
local function embers(g, l, list)
  for _, e in ipairs(list) do P.pix(g, e[1], e[2], "black"); P.pix(l, e[1], e[2], e[3]); protect(e[1], e[2]) end
end
local function clearLights(l) P.rect(l, 0, 0, l.width, l.height, nil) end

-- A hole in a roof (worn.lua's): k marks the void; rafters cross it every `pitch` columns from
-- `phase`, leaning a column per `rise` rows (0 stands them upright), battens run level on the rows
-- in `battens`, and `rim` lights the broken tile ends along its lower edge. `void` may be clear.
local function hole(g, x, y, rows, o)
  local void, list = {}, {}
  for j, r in ipairs(rows) do
    if #r ~= #rows[1] then error("hole row " .. j .. " is " .. #r .. " wide") end
    for i = 1, #r do
      local px, py = x + i - 1, y + j - 1
      if r:sub(i, i) == "k" and at(g, px, py) then void[px .. "," .. py] = true; list[#list + 1] = { px, py } end
    end
  end
  if o.rim then
    for _, p in ipairs(list) do
      if not void[p[1] .. "," .. (p[2] + 1)] then remapAt(g, o.rim, p[1], p[2] + 1) end
    end
  end
  local batten = {}
  for _, b in ipairs(o.battens or {}) do batten[b] = true end
  for _, p in ipairs(list) do
    local i, j = p[1], p[2]
    local rise = o.rise or 2
    local u = i - (rise == 0 and 0 or (j + (o.shift or 1)) // rise) - (o.phase or 0)
    local c = o.void
    if o.pitch and u % o.pitch == 0 then c = o.rafter end
    if batten[j] then c = o.batten or o.rafter end
    P.pix(g, i, j, c)
  end
end

-- Planks nailed across an opening at x, y, w, h: the dark inside, two planks overhanging it on
-- alternate sides (on five rows or fewer they cover the top and bottom rows).
local function board(g, l, x, y, w, h, lit, dark)
  P.rect(l, x, y, w, h, nil)
  P.rect(g, x + 1, y + 1, w - 2, h - 2, "ink")
  local function plank(py, x0, x1)
    P.hline(g, x0, py, x1 - x0 + 1, lit or "sand"); P.hline(g, x0, py + 1, x1 - x0 + 1, dark or "wood")
    for i = x0, x1 do protect(i, py); protect(i, py + 1) end
  end
  if h <= 5 then plank(y, x - 1, x + w - 1); plank(y + h - 2, x, x + w) return end
  plank(y + 1, x - 1, x + w - 1)
  plank(y + h - 3, x, x + w)
end

-- A soot plume licking up from an opening whose top frame is row y: a tongue of soot, blackest
-- at its core, overhanging the opening a pixel each side.
local PLUMES = {
  [3] = { short = { ".sc..", "scxcs" }, tall = { "..c..", ".scs.", ".cxc.", "scxcs" } },
  [4] = { short = { ".scs..", "scxxcs" }, tall = { "..c...", ".scs..", ".cxcs.", "scxxcs" } },
  [5] = { short = { "..sc...", ".scxs..", "sccxccs" }, tall = { "...c...", "..scs..", "..cxc..", ".scxxs.", "scxxxcs" } },
  [6] = { short = { "..sc....", ".scxs...", "sccxxccs" }, tall = { "...c....", "..scs...", "..cxcs..", ".scxxcs.", "sccxxxcs" } },
}
local function plume(g, x, y, w, size)
  local rows = PLUMES[w][size or "short"]
  wash(g, x - 1, y - #rows + 1, rows, SCORCH)
end

-- The last pass over a stage (worn.lua's): a pixel that matches none of its eight neighbours is
-- what an overlap of washes leaves, so it takes its neighbours' commonest colour, the four beside
-- it counting double; a tie goes to the colour the base had there, or the nearest in value. Lights
-- and what `keep` marks stay as they are.
local function luma(c) return 0.299 * pc.rgbaR(c) + 0.587 * pc.rgbaG(c) + 0.114 * pc.rgbaB(c) end
local function tidyAll(g, l, keep, orig)
  for _ = 1, 4 do
    local fixes = {}
    for y = 0, g.height - 1 do for x = 0, g.width - 1 do
      local c = g:getPixel(x, y)
      if pc.rgbaA(c) > 0 and pc.rgbaA(l:getPixel(x, y)) == 0 and not (keep and pc.rgbaA(keep:getPixel(x, y)) > 0) then
        local count, same = {}, false
        for dy = -1, 1 do for dx = -1, 1 do
          local i, j = x + dx, y + dy
          if (dx ~= 0 or dy ~= 0) and i >= 0 and j >= 0 and i < g.width and j < g.height then
            local d = g:getPixel(i, j)
            if pc.rgbaA(d) > 0 then
              if d == c then same = true end
              count[d] = (count[d] or 0) + ((dx == 0 or dy == 0) and 2 or 1)
            end
          end
        end end
        if not same then
          local n = 0
          for _, k in pairs(count) do n = math.max(n, k) end
          local was = orig and orig:getPixel(x, y)
          local best, gap = nil, math.huge
          for d, k in pairs(count) do
            if k == n then
              local dist = (d == was) and -1 or math.abs(luma(d) - luma(c))
              if dist < gap or (dist == gap and d < best) then best, gap = d, dist end
            end
          end
          if best then fixes[#fixes + 1] = { x, y, best } end
        end
      end
    end end
    if #fixes == 0 then return end
    for _, f in ipairs(fixes) do g:drawPixel(f[1], f[2], f[3]) end
  end
end

-- Starts a run of stages from a base: returns the working images and a function that snapshots
-- the current state as the next stage, tidied.
local function stages(g, l)
  g, l = g:clone(), l:clone()
  local orig = g:clone()
  KEEP = P.image(g.width, g.height)
  local list = {}
  local function snap()
    local sg, sl = g:clone(), l:clone()
    tidyAll(sg, sl, KEEP, orig)
    list[#list + 1] = { sg, sl }
  end
  return g, l, snap, list
end

---------------------------------------------------------------------------------------------------
-- The barn: a gambrel gable end to the left with the big doors, the hay loft over them and a lantern
-- between; the long side to the right under the two pitches of its grey shingle roof. Deep red board
-- and batten, white trim, a fieldstone footing.
---------------------------------------------------------------------------------------------------
-- The gable end, drawn whole: R is board and batten, laid in afterwards by column, and r the doors'
-- painted infill. The loft's door stands open on the hay; the lantern hangs on a short chain from
-- the loft's sill over the big doors, its tin frame catching the light down its left side; each
-- leaf of the big doors is braced with a white X.
local BARN_GABLE = {
  ".........TTMM.........",
  ".......TTWWIIMM.......",
  ".....TTWWrrrrIIMM.....",
  "....TWWRRWWWWRRIIM....",
  "....TWRRWkkkkWRRIM....",
  "...TWRRWkkkkkkWRRIM...",
  "...TWRRWkkkkkkWRRIM...",
  "..TWRRRWkkKykkWRRRIM..",
  "..TWRRRWkKKyysWRRRIM..",
  ".TWRRRRWyyyyssWRRRRIM.",
  ".TWRRRRWyyWWWWWRRRRIM.",
  "TWRRRRRRRRRkRRRRRRRRIM",
  "TWRRRRRRRRRkRRRRRRRRIM",
  ".WRRRRRRRRMkRRRRRRRRI.",
  ".WRRRRRRRMinkRRRRRRRI.",
  ".WRRRRRRRMinkRRRRRRRI.",
  ".WRRRRRRRRMkRRRRRRRRI.",
  ".WRRRRRRRRRRRRRRRRRRI.",
  ".WRRRRRRRRRRRRRRRRRRI.",
  ".WRRRRRRRRRRRRRRRRRRI.",
  ".WRRRRRRRRRRRRRRRRRRI.",
  ".WRRRRRRRRRRRRRRRRRRI.",
  ".WRRRRRRRRRRRRRRRRRRI.",
  ".WRRRRRRRRRRRRRRRRRRI.",
  ".WRRRRRRRRRRRRRRRRRRI.",
  ".WRRRRRRRRRRRRRRRRRRI.",
  ".WRRRRRRRRRRRRRRRRRRI.",
  ".WRRRRRRRRRRRRRRRRRRI.",
  ".WRRRRRRRRRRRRRRRRRRI.",
  ".WRRRRRRRRRRRRRRRRRRI.",
  ".WRRRRRRRRRRRRRRRRRRI.",
  ".GGGGGGGGGGGGGGGGGGGG.",
}
-- the big doors, rows 19-30 of the gable at x 3: two leaves, each braced with an X over a plain
-- lower panel, a shaded gap between them
local DOOR = {
  "WWWWWWWWWWWWWWWW",
  "WWrrrrWIWWrrrrWI",
  "WrWrrWrIWrWrrWrI",
  "WrrWWrrIWrrWWrrI",
  "WrrWWrrIWrrWWrrI",
  "WrWrrWrIWrWrrWrI",
  "WWrrrrWIWWrrrrWI",
  "WWWWWWWIWWWWWWWI",
  "WrrrrrrIWrrrrrrI",
  "WrrrrrrIWrrrrrrI",
  "WrrrrrrIWrrrrrrI",
  "WrrrrrrIWrrrrrrI",
}
local BARN_KEY = { p = "plum", T = "stone", M = "smoke", W = "white", I = "ice", R = "pink", r = "red", k = "ink", K = "skin",
                   y = "yellow", s = "sand", o = "ochre", i = "indigo", n = "navy", G = "grey", e = "steel" }

-- Board and batten: three columns of red board, then a groove in shadow.
local BATTEN = { "red", "red", "red", "plum" }
local function batten(x) return BATTEN[(x + 1) % #BATTEN + 1] end

local function barnBase()
  local g, l = P.image(44, 32), P.image(44, 32)
  local LX = { 9, 7, 5, 4, 4, 3, 3, 2, 2, 1, 1, 0, 0 }
  local EAVE = #LX - 1
  local rx = function(y) return 21 - LX[y + 1] end
  map(g, 0, 0, BARN_GABLE, BARN_KEY)
  map(g, 3, 19, DOOR, BARN_KEY)
  P.rect(g, 1, 19, 2, 10, "pink"); P.rect(g, 19, 19, 2, 10, "pink")
  P.vline(g, 1, 19, 10, "white"); P.vline(g, 20, 19, 10, "ice")
  map(g, 1, 29, { "ee", "TT" }, BARN_KEY); map(g, 19, 29, { "TG", "TG" }, BARN_KEY)
  for y = 0, 31 do for x = 0, 21 do
    if at(g, x, y) == "pink" then P.pix(g, x, y, batten(x)) end
  end end
  -- the long side under its two pitches, meeting at a knee
  local KNEE, len = 2, 22
  courses(g, 0, KNEE, function(y) return rx(y) + 1 end, function(y) return rx(y) + len end,
    { base = "stone", line = "grey", lite = "steel", dash = 12 }, 2)
  courses(g, KNEE + 1, EAVE, function(y) return rx(y) + 1 end, function(y) return rx(y) + len end,
    { base = "grey", line = "smoke", lite = "stone", dash = 12 }, 0.5)
  P.hline(g, rx(0) + 1, 0, len, "steel")
  P.hline(g, rx(KNEE) + 1, KNEE, len, "smoke")
  P.hline(g, rx(EAVE) + 1, EAVE, len, "slate")
  P.pix(g, 39, 3, "grey")   -- a highlight dash the far verge cut to one pixel
  for y = EAVE + 1, 28 do for x = 22, 42 do P.pix(g, x, y, batten(x)) end end
  P.hline(g, 22, EAVE + 1, 21, "plum")
  P.vline(g, 21, EAVE + 1, 16, "white"); P.vline(g, 43, EAVE + 1, 16, "ice")
  -- fieldstone footing
  P.rect(g, 21, 29, 23, 2, "stone"); P.hline(g, 21, 31, 23, "grey")
  for _, s in ipairs { { 23, 29, 3 }, { 30, 29, 3 }, { 38, 29, 2 }, { 26, 30, 2 }, { 34, 30, 3 } } do
    P.hline(g, s[1], s[2], s[3], "steel")
  end
  P.vline(g, 43, 29, 2, "grey")
  -- two small windows on the long side
  for _, x in ipairs { 26, 36 } do
    map(g, x, 17, {
      "WWWWW",
      "WnWnW",
      "WnWnW",
      "WWWWW",
      "WkWkW",
      "WkWkW",
      "WWWWW",
    }, BARN_KEY)
  end
  -- the lantern's glass, lit
  P.rect(l, 10, 14, 2, 2, "yellow"); P.hline(l, 10, 15, 2, "sand")
  return g, l
end

-- The barn wearing down. Worn: shingles slipped, a window boarded, the paint gone to bare wood
-- where the carts rub and mud at the foot, the loft's hay gone old; the lantern still lit. Derelict:
-- the roof open to its rafters, the other window broken, a leaf of the big doors gone, the paint
-- peeling, a bargeboard down, the lantern dead. Scorched: the roof burnt through to the sky, the
-- walls black from the top, soot over every opening and the fire deep inside.
local function barnStages(base, lights)
  local g, l, snap, out = stages(base, lights)
  local ROOFRIM = { grey = "stone", smoke = "grey", stone = "steel", slate = "smoke" }
  local MUD = { red = "wood", plum = "bark", coral = "red", white = "ice", ice = "steel", stone = "grey", steel = "stone", grey = "smoke" }
  local BARE = { red = "wood", plum = "bark", coral = "sand" }
  -- worn
  hole(g, 25, 5, { "kk" }, { void = "ink", rim = ROOFRIM })
  hole(g, 35, 9, { "kk" }, { void = "ink", rim = ROOFRIM })
  hole(g, 30, 1, { "kk" }, { void = "ink", rim = ROOFRIM })
  board(g, l, 36, 17, 5, 7, "sand", "wood")
  remap(g, { yellow = "sand", skin = "sand", sand = "ochre", ochre = "olive" }, 8, 7, 6, 4)
  wash(g, 4, 27, {
    "b......bb....b..",
    "bb...bbbb..bbb.b",
    "bbbbbbbbbbbbbbbb",
  }, { b = BARE })
  -- mud splashed up the foot of the long side where the carts turn: thickest and highest at the
  -- corner by the doors, then blots of their own sizes, one bay left clean
  grime(g, 22, 28, "232100110000012210021", MUD)
  grime(g, 1, 28, "12", MUD); grime(g, 19, 28, "21", MUD)
  wash(g, 21, 29, { "..ggg..........gg......", "ggggg...ggg......gggg.g" }, { g = GRIME })
  snap()

  -- derelict
  hole(g, 25, 6, {
    "kkkkkkkkkkk..",
    "kkkkkkkkkkkk.",
    ".kkkkkkkkkkkk",
    "..kkkkkkkkkk.",
    "....kkkkkk...",
  }, { void = "ink", rafter = "wood", pitch = 4, phase = 1, battens = { 8 }, rim = ROOFRIM })
  touch(g, 26, 17, {
    "WWWWW",
    "WekkW",
    "WekkW",
    "WkkkW",
    "WkkkW",
    "WkkkW",
    "RWWWW",
  })
  -- the right leaf of the big doors gone: the dark inside, straw on its floor
  touch(g, 11, 20, {
    "kkkkkkk",
    "kkkkkkk",
    "kkkkkkk",
    "kkkkkkk",
    "kkkkkkk",
    "kkkkkkk",
    "kkkkkkk",
    "kkkkkkk",
    "kkkkkkk",
    "kkOOkkk",
    "kOOOOkk",
  })
  -- the lantern dead
  touch(g, 10, 14, { "LL", "LL" }); clearLights(l)
  -- the paint peeling to bare wood
  wash(g, 3, 13, { "bbb", "bbb", "bb.", "b.." }, { b = BARE })
  wash(g, 15, 6, { ".bb", "bbb", "bbb", "bb." }, { b = BARE })
  wash(g, 31, 24, { ".bbb", "bbbb", "bbb." }, { b = BARE })
  wash(g, 38, 14, { "bbb", "bb.", "b.." }, { b = BARE })
  -- the bargeboard down from the right verge, and a split down a board
  touch(g, 16, 6, { "R.", "RR", "RR" })
  crack(g, { 16, 12, 16, 14, 17, 16, 17, 17 })
  crack(g, { 24, 15, 24, 17, 25, 19 })
  remap(g, { sand = "ochre", ochre = "olive", olive = "bark" }, 8, 7, 6, 4)
  grime(g, 22, 28, "343211221000012332132", MUD)
  grime(g, 1, 28, "23", MUD); grime(g, 19, 28, "32", MUD)
  snap()

  -- scorched
  hole(g, 20, 0, {
    "........kkkkkkkkk.......",
    "......kkkkkkkkkkkkk.....",
    ".....kkkkkkkkkkkkkkk....",
    "....kkkkkkkkkkkkkkkkk...",
    "....kkkkkkkkkkkkkkkkkk..",
    ".....kkkkkkkkkkkkkkkkk..",
    ".....kkkkkkkkkkkkkkkkk..",
    "......kkkkkkkkkkkkkkk...",
    "......kkkkkkkkkkkkkk....",
    ".......kkkkkkkkkkk......",
    "..........kkkkkk........",
  }, { void = P.CLEAR, rafter = "ink", pitch = 4, phase = 1, battens = { 6 }, rim = { grey = "smoke", stone = "grey", smoke = "slate", slate = "smoke" } })
  remap(g, { stone = "grey", grey = "smoke", steel = "stone" }, 20, 0, 24, 13)
  -- the gable black from its peak, the long side from the eave, both to a ragged edge
  stain(g, 0, "0011234456654432110000", compose(SOOT, CHAR))
  stain(g, 0, "fghhiijjjkkkkjjiihhggf", SOOT)
  band(g, 13, "1112221112211122211121", CHAR, 22)
  band(g, 13, "899a98899aa9889a99a898", SOOT, 22)
  -- the corner boards greyed down to the footing with the trim of the doors
  for _, x in ipairs { 1, 20, 21, 43 } do remap(g, { white = "stone", ice = "stone" }, x, 13, 1, 16) end
  remap(g, { red = "plum" }, 19, 13, 1, 18)
  plume(g, 8, 4, 6, "tall")
  remap(g, SOOT, 26, 17, 5, 7); unprotect(26, 16, 5, 8)
  remap(g, SOOT, 35, 17, 7, 7); unprotect(35, 16, 7, 8)
  plume(g, 27, 17, 3)
  plume(g, 37, 17, 3)
  plume(g, 12, 20, 5, "tall")
  remap(g, SOOT, 3, 19, 16, 12)
  touch(g, 10, 13, { "kk", "kk", "kk", "kk" })
  embers(g, l, { { 10, 7, "red" }, { 11, 7, "rust" }, { 12, 8, "yellow" }, { 13, 8, "rust" },
                 { 28, 19, "rust" }, { 28, 20, "red" },
                 { 13, 26, "red" }, { 14, 26, "rust" }, { 14, 27, "yellow" }, { 15, 27, "rust" }, { 13, 28, "red" } })
  snap()
  return out
end

-- ruin3: the barn burnt out, in the colours of hell's shells. The gambrel gable still stands on its
-- lit shoulder, its peak burnt away toward the side that fell, the loft a black hole and the big
-- doorway black behind one charred leaf; the long side's roof lies fallen against it in a heap with
-- its rafters standing out, the far corner post upright, the fieldstone footing under it all.
local RUIN3 = {
  "........kk..................................",
  "......kkmk..................................",
  "....kkmmmmk.................................",
  "...kgmmmmmmk................................",
  "...kgmsmbbbbk..............kk...............",
  "..kgmmsmbbbbmkk............kk...............",
  "..kgmmsmbbbbmmsk..........kk................",
  ".kgmmmsmbbbbmmsmkk........kk.....k........kk",
  ".kgmmmsmmmsmmmsmmmkkk.....kk.....k........gk",
  ".kgmmmsmmmsmmmsmmmsskmmm.kk.....k.........gk",
  ".kgkkkkkkkkkkkkkkkksksssmkk.....k......k..gk",
  ".kgkgggmbbbbbbbbbbkskssskkmmm...k.....k...gk",
  ".kgkmmsmsbbbbbbbbbkskssskkmssmm.k.....k...gk",
  ".kgkmmsmssbbbbbbbbksksssssssssmkmm...k....gk",
  ".kgkmmsmssbbbbbbbbksksssssssssskmsmm.k....gk",
  ".kgkmmsmssbbbbbbbbkskskkkskkkkskkksskmm...gk",
  ".kgkmmsmssbbbbbbbbkskssssbbsssssssssbbmmm.gk",
  ".kgkmmsmssbbbbbbbbksksssssbssssbbsssssssssgk",
  ".kgkmmsmssbbbbbbbbksksskkkkskkkkskkkkskkksgk",
  "kgttgggggttgggggttgggggttgggggttgggggttggggk",
  "kmmmmggmmmmmggmmmmmggmmmmmggmmmmmggmmmmmgggk",
  "kkkssssskkssssskkssssskkssssskkssssskksssssk"
}
local function ruin3()
  local g, l = P.image(44, 22), P.image(44, 22)
  map(g, 0, 0, RUIN3, { k = "ink", s = "slate", m = "smoke", g = "grey", t = "stone", b = "black", p = "plum", B = "bark" })
  for _, e in ipairs { { 9, 6, "rust" }, { 10, 6, "red" }, { 12, 15, "red" }, { 13, 16, "rust" }, { 14, 16, "yellow" }, { 15, 17, "rust" },
                       { 25, 16, "rust" }, { 26, 16, "red" }, { 31, 17, "red" }, { 32, 17, "rust" }, { 37, 16, "red" } } do
    P.pix(g, e[1], e[2], "black"); P.pix(l, e[1], e[2], e[3])
  end
  return g, l
end

---------------------------------------------------------------------------------------------------
-- The granary: a round fieldstone silo under a red shingle cone, a hatch high up for the grain and
-- a low door at its foot. The stones are shaded as a drum, lit on the left.
---------------------------------------------------------------------------------------------------
-- Fieldstone, darkest to lightest; a column of the drum has its own tone, two stones in five sit a
-- step off it, and the mortar is a step under it.
local STONE = { "slate", "smoke", "grey", "stone", "steel", "ice" }
local DRUM = { 5, 5, 5, 4, 4, 4, 4, 4, 3, 3, 3, 3, 2, 2 }
-- each course: the stones' widths from the left edge, and how far each sits off its column's tone
local COURSES = {
  { { 2, 0 }, { 4, 0 }, { 3, 1 }, { 3, -1 }, { 2, 0 } },
  { { 1, 0 }, { 3, -1 }, { 4, 0 }, { 3, 0 }, { 3, 1 } },
  { { 3, 0 }, { 3, 0 }, { 4, -1 }, { 2, 0 }, { 2, 0 } },
  { { 1, 0 }, { 4, 1 }, { 3, 0 }, { 4, 0 }, { 2, -1 } },
  { { 2, 0 }, { 3, -1 }, { 4, 0 }, { 3, 1 }, { 2, 0 } },
  { { 1, 0 }, { 4, 0 }, { 3, 0 }, { 3, -1 }, { 3, 0 } },
  { { 3, 0 }, { 4, 1 }, { 3, 0 }, { 2, 0 }, { 2, -1 } },
}
-- the cone by hand: C lit, R red, p shade, its courses as short dark dashes; a wooden finial
local CONE_ART = {
  ".......sw.......",
  ".......sw.......",
  "......CRRp......",
  "......CRRp......",
  ".....CCRRpp.....",
  ".....CRppRp.....",
  "....CCRRRRpp....",
  "....CCRRRRpp....",
  "...CCRpppRRpp...",
  "..CCCRRRRRRppp..",
  ".CCRRppRRRppppp.",
  "CCRRRRRRRRRRpppp",
}
local function granaryBase()
  local g, l = P.image(16, 36), P.image(16, 36)
  local top = #CONE_ART   -- first row of the drum
  -- the drum: courses of two rows of stone over one of mortar, the joints staggered; each stone
  -- takes the tone of the column at its middle, so the drum turns in steps of whole stones
  P.hline(g, 1, top, 14, "plum")
  for k = 0, 7 do
    local y0 = top + 1 + k * 3
    local x = 0
    for _, st in ipairs(COURSES[k % #COURSES + 1]) do
      local x1 = math.min(13, x + st[1] - 1)
      local mid = (x + x1) // 2
      local tone = math.max(1, math.min(6, DRUM[mid + 1] + st[2]))
      for i = x, x1 do
        for y = y0, y0 + 1 do P.pix(g, 1 + i, y, STONE[tone]) end
        P.pix(g, 1 + i, y0 + 2, STONE[DRUM[i + 1] - 1])
      end
      x = x1 + 1
      if x <= 13 then
        for y = y0, y0 + 2 do P.pix(g, 1 + x, y, STONE[DRUM[x + 1] - 1]) end
        x = x + 1
      end
    end
  end
  -- a plinth of dressed stone
  P.hline(g, 0, 33, 16, "stone"); P.hline(g, 0, 34, 16, "stone"); P.hline(g, 0, 35, 16, "grey")
  P.hline(g, 0, 33, 3, "steel"); P.rect(g, 12, 33, 4, 2, "grey"); P.hline(g, 12, 35, 4, "smoke")
  map(g, 0, 0, CONE_ART, { C = "coral", R = "red", p = "plum", s = "sand", w = "wood" })
  -- the grain hatch under the eave, a dressed lintel over it; the door at the foot under an arch
  map(g, 5, 13, {
    "eeeTTT",
    "bwwwbb",
    "bwbwbb",
    "bwbwbb",
    "bwwwbb",
    "TTTGGG",
  }, { e = "ice", T = "steel", G = "stone", w = "wood", b = "bark" })
  map(g, 4, 26, {
    "..eeTT..",
    ".eeTTGG.",
    "eTbbbbGG",
    "Tbwwwbb.",
    "Tbwwwbb.",
    "Tbwswbb.",
    "Tbwwwbb.",
  }, { e = "ice", T = "steel", G = "stone", w = "wood", b = "bark", s = "sand" })
  return g, l
end

-- The granary wearing down. Worn: two shingles slipped off the cone, the hatch bleached, moss in
-- the shaded joints and damp at the foot. Derelict: the cone open to its rafters, the finial
-- snapped, the hatch's shutter hanging from one hinge, the door gone, a crack down the drum.
-- Scorched: the cone burnt to its ribs and black from the apex down, the drum black from the top,
-- soot up from both openings and the fire inside.

-- A cone's rafters meet at its apex: each rib is drawn from there to a point on the eave, through
-- the holes only (where the cone is `void`, or clear when `void` is nil), so the frame shows in the
-- gaps and nowhere else.
local RIBS = { { 2, 11 }, { 5, 11 }, { 10, 11 }, { 13, 11 } }
local function inCone(x, y)
  local r = CONE_ART[y + 1]
  return r ~= nil and x >= 0 and x < #r and r:sub(x + 1, x + 1) ~= "."
end
local function ribs(g, c, void)
  for _, r in ipairs(RIBS) do
    local x0, y0, x1, y1 = r[1] < 8 and 7 or 8, 1, r[1], r[2]
    local n = math.max(math.abs(x1 - x0), math.abs(y1 - y0))
    for k = 0, n do
      local x, y = math.floor(x0 + (x1 - x0) * k / n + 0.5), math.floor(y0 + (y1 - y0) * k / n + 0.5)
      if inCone(x, y) and at(g, x, y) == void then P.pix(g, x, y, c) end
    end
  end
end
local function granaryStages(base, lights)
  local g, l, snap, out = stages(base, lights)
  local CONERIM = { red = "coral", plum = "red", coral = "skin" }
  local MOSS = { grey = "moss", smoke = "olive", stone = "sage", slate = "olive" }
  -- worn
  hole(g, 6, 7, { "kk" }, { void = "ink", rim = CONERIM })
  hole(g, 10, 9, { "kk" }, { void = "ink", rim = CONERIM })
  remap(g, { wood = "sand", bark = "wood" }, 5, 14, 6, 4)
  wash(g, 11, 20, { ".mm", "mmm", "..m", "...", "...", ".mm", "mmm", "mm.", "...", "..m", ".mm" }, { m = MOSS })
  grime(g, 1, 32, "11221122111122", GRIME)
  wash(g, 0, 33, { "....gg......gg..", "gggg.....gggg..." }, { g = GRIME })
  snap()

  -- derelict
  hole(g, 8, 3, {
    "k...",
    "kk..",
    "kkk.",
    "kkkk",
    ".kkk",
    "..k.",
  }, { void = "ink", rim = CONERIM })
  ribs(g, "wood", "ink")
  touch(g, 7, 0, { "__", "ww" })
  -- the hatch open on the dark inside
  touch(g, 5, 14, {
    "kkkkkk",
    "kkkkkk",
    "kkkkkk",
    "kkkkkk",
  })
  -- the shutter hanging from its top hinge on the left jamb, edge on, bleached
  touch(g, 3, 15, {
    "sw",
    "sw",
    "sw",
    "sw",
    "sw",
    "ww",
  })
  touch(g, 5, 18, { "TTTG" })
  -- the door gone, a plank nailed across the doorway
  touch(g, 5, 28, {
    "kkkkk",
    "kkkkk",
    "sssss",
    "wwwww",
    "kkkkk",
  })
  crack(g, { 9, 19, 9, 21, 10, 23, 10, 25 })
  wash(g, 11, 26, { ".mm", "mmm", "mm.", ".m." }, { m = MOSS })
  grime(g, 1, 32, "22331111122233", GRIME)
  snap()

  -- scorched
  hole(g, 8, 2, {
    "k.....",
    "kk....",
    "kkk...",
    "kkkk..",
    "kkkkk.",
    ".kkkkk",
    ".kkkkk",
    "..kkk.",
  }, { void = P.CLEAR, rim = { red = "plum", plum = "ink", coral = "red" } })
  remap(g, { coral = "red", red = "plum", plum = "ink", sand = "smoke", wood = "slate" }, 0, 0, 16, 12)
  -- and a step further above the eave, so the cone is black from its apex down to a red rim
  remap(g, { red = "plum", plum = "ink" }, 0, 0, 16, 11)
  ribs(g, "ink", nil)
  band(g, 12, "12334555433221", CHAR, 1)
  band(g, 12, "6799aabba98776", SOOT, 1)
  plume(g, 6, 14, 4, "tall")
  remap(g, SOOT, 3, 15, 2, 6)
  plume(g, 6, 28, 3)
  -- the plank across the doorway charred with the rest: a dull sheen along its top edge
  touch(g, 5, 30, { "LLkLL", "bbkkk" })
  embers(g, l, { { 7, 16, "red" }, { 8, 16, "rust" }, { 8, 17, "yellow" }, { 6, 29, "rust" }, { 7, 29, "red" }, { 8, 32, "rust" } })
  snap()
  return out
end

---------------------------------------------------------------------------------------------------
-- The hay wain: a plank bed on two big spoked wheels, heaped with hay, its shaft let down.
---------------------------------------------------------------------------------------------------
local WHEEL = {
  "..bbbbb..",
  ".bw.w.wb.",
  "bww.w.wwb",
  "b..www..b",
  "bwwwhwwwb",
  "b..www..b",
  "bbw.w.wbb",
  ".bb.w.bb.",
  "..bbbbb..",
}
local WAIN = { K = "skin", S = "sand", O = "ochre", W = "wood", w = "wood", b = "bark", s = "sand", h = "sand", p = "plum" }
local WAIN_BED = {
  "........KKKSSS..........",
  ".....KKKSSSSSSSOO.......",
  "...KKSSSOOOSSSSSSOO...wb",
  "..KSSSSSSSSSOOSSSSOOO.wb",
  "..wsssssssssssssssssswwb",
  "..wbwwwbwwwbwwwbwwwbwwbb",
  "..bbbbbbbbbbbbbbbbbbbbbb",
}
local function cartBase()
  local g, l = P.image(24, 14), P.image(24, 14)
  map(g, 0, 0, WAIN_BED, WAIN)
  map(g, 3, 5, WHEEL, WAIN)
  map(g, 14, 5, WHEEL, WAIN)
  -- the shaft, let down to the ground
  map(g, 0, 7, { "..w", ".w.", ".w.", "w..", "w..", "w..", "w.." }, WAIN)
  return g, l
end

-- The wain left out. Weathered: the timber silvered along its top, a spoke gone from the hind
-- wheel, the load half gone and old. Abandoned: the fore wheel broken in half, so the bed has come
-- down at the front until its corner rests in the grass, on what is left of the wheel: the upper
-- half of its rim lying on its broken diameter. A board is out of the bed's side, a few straws are
-- caught on its rail, and the shaft is gone.
local WHEEL_WORN = {
  "..bbbbb..",
  ".bw.w..b.",
  "bww.w..bb",
  "b..ww...b",
  "bwwwhwwwb",
  "b..www..b",
  "bbw.w.wbb",
  ".bb.w.bb.",
  "..bbbbb..",
}
local function cartStages()
  local OLD = { K = "sand", S = "sand", O = "ochre", o = "olive", w = "wood", b = "bark", s = "stone", h = "sand", G = "grey", k = "ink" }
  local list = {}
  -- weathered
  local g = P.image(24, 14)
  map(g, 0, 0, {
    "........................",
    "........................",
    "....SSSOO.....SSOO....wb",
    "..SSOOSSSOOOSSOOOSSOOOwb",
    "..wsssssssssssssssssswwb",
    "..wbwwwbwwwbwwwbwwwbwwbb",
    "..bbbbbbbbbbbbbbbbbbbbbb",
  }, OLD)
  map(g, 3, 5, WHEEL, OLD)
  map(g, 14, 5, WHEEL_WORN, OLD)
  map(g, 0, 7, { "..w", ".w.", ".w.", "w..", "w..", "w..", "w.." }, OLD)
  list[1] = { g, P.image(24, 14) }
  -- abandoned
  g = P.image(24, 14)
  -- the bed whole, tipped down to the front a row every seven columns: the silvered rail, its side
  -- board with the joints between the planks, and the bottom board in shade
  for x = 4, 23 do
    local y = 4 + (23 - x) // 7
    P.pix(g, x, y, "stone"); P.pix(g, x, y + 1, (x - 1) % 4 == 0 and "bark" or "wood"); P.pix(g, x, y + 2, "bark")
  end
  -- its front end board, the corner of the bed come down into the grass
  map(g, 3, 7, { "ws", "wb", "wb", "bb", "bb", "bb", "bb" }, OLD)
  -- a plank out of the side with the dark of the bed behind it, straws left caught on the rail,
  -- and the tail stake
  map(g, 11, 6, { "kkk" }, OLD)
  map(g, 7, 5, { "OO" }, OLD); map(g, 14, 4, { "SS" }, OLD)
  map(g, 22, 2, { "wb", "wb" }, OLD)
  map(g, 14, 5, WHEEL_WORN, OLD)
  -- the fore wheel broken: its lower half gone, what is left of it fallen on its broken diameter
  -- under the front corner, the upper rim on its spokes
  map(g, 0, 9, {
    "..bbbbb..",
    ".bw...wb.",
    "bw..w..wb",
    "b...w...b",
    "bwwwhwwwb",
  }, OLD)
  list[2] = { g, P.image(24, 14) }
  -- tidied, all but the hubs
  for k, st in ipairs(list) do
    local keep = P.image(24, 14)
    for _, h in ipairs { { 7, 9 }, { 18, 9 }, { 4, 13 } } do P.pix(keep, h[1], h[2], "white") end
    tidyAll(st[1], st[2], keep)
  end
  return list
end

---------------------------------------------------------------------------------------------------
-- A cow, red-brown with a white face, grazing: the head dips to the grass and comes up again.
---------------------------------------------------------------------------------------------------
local COW = { M = "plum", s = "sand", w = "wood", b = "bark", W = "white", I = "ice", K = "skin", k = "ink", p = "plum", e = "steel",
              h = "sand", O = "ochre" }
local COW_BODY = {
  "................",
  ".......sssss.ss.",
  "......wwwwwwwwwb",
  ".....wwwwwwwwwwb",
  ".....wwwwwwwwwbb",
  ".....wwwwwwwwwbb",
  ".....WWbbbbbbbbb",
  ".....wb..KK.wb.b",
  ".....wb.....wb.M",
  ".....pp.....pp..",
}
-- the head and neck, at their place in each frame: a white face in profile, a pink muzzle, a horn
-- curving forward and an ear laid back
local COW_HEAD = {
  [0] = { 0, 0, {
    "..Oh...",
    ".WWWWb.",
    "WWkWWbw",
    "WWWWWww",
    "KKWWWww",
    "KKWWww.",
    "..WW...",
  } },
  [1] = { 0, 2, {
    "......w",
    ".....ww",
    "..Oh.bw",
    ".WWWWbw",
    "WWkWWW.",
    "WWWWW..",
    "KKWW...",
    "KK.....",
  } },
}
local function cowFrame(f)
  local g, l = P.image(16, 10), P.image(16, 10)
  map(g, 0, 0, COW_BODY, COW)
  local h = COW_HEAD[f]
  local rows = h[3]
  for j, r in ipairs(rows) do
    for i = 1, #r do
      local k = r:sub(i, i)
      if k ~= "." then P.pix(g, h[1] + i - 1, h[2] + j - 1, COW[k]) end
    end
  end
  return g, l
end

---------------------------------------------------------------------------------------------------
-- The scarecrow: a sack head under a brown felt hat, a patched blue coat on its crossbar, straw at
-- the collar, the cuffs and the hem, lit on top, all on one post.
---------------------------------------------------------------------------------------------------
local CROW = { b = "bark", w = "wood", s = "sand", K = "skin", k = "ink", y = "yellow", S = "sand", O = "ochre",
               B = "blue", n = "navy", C = "coral", r = "red", i = "indigo" }
local SCARECROW = {
  "....swbb....",
  "....swbb....",
  "...wwwwbbb..",
  ".wwwwwwbbbb.",
  "....KKKS....",
  "....kKkS....",
  "....KSSS....",
  "...KKBBSS...",
  "KKBBBBBBnnKK",
  "SS.BBCCBn.SS",
  "...BBCCnn...",
  "...BBBBnn...",
  "...BBBBnn...",
  "...KKOOSS...",
  ".....wb.....",
  ".....wb.....",
  ".....wb.....",
  ".....wb.....",
  ".....wb.....",
  "....wwbb....",
}
local function scarecrowBase()
  local g, l = P.image(12, 20), P.image(12, 20)
  map(g, 0, 0, SCARECROW, CROW)
  return g, l
end

-- The scarecrow left to the weather. Faded: the coat washed out to a grey blue, the patch gone
-- pink, the straw and the hat bleached. Tattered: the post leaning, the coat torn and holed, its
-- hem in rags, the far arm sagging and the straw spilling out of it into a heap at the foot.
local function scarecrowStages()
  local FADED = { b = "bark", w = "wood", s = "skin", K = "sand", k = "ink", y = "sand", S = "ochre", O = "ochre",
                  B = "steel", n = "stone", C = "pink", r = "red", i = "indigo" }
  local RAGS = { b = "bark", w = "wood", s = "sand", K = "sand", k = "ink", y = "sand", S = "ochre", O = "ochre",
                 B = "stone", n = "grey", C = "purple", r = "red", i = "indigo" }
  local list = {}
  local g = P.image(12, 20)
  map(g, 0, 0, SCARECROW, FADED)
  list[1] = { g, P.image(12, 20) }
  -- tattered: leant over on its post, the hat and head furthest, the far arm sagging
  g = P.image(12, 20)
  map(g, 0, 0, {
    "..swbb......",
    "..swbb......",
    ".wwwwbbb....",
    "wwwwwbb.....",
    "...KKKS.....",
    "...kKkS.....",
    "...KSSS.....",
    "..yyBByy....",
    "yyBBBBBnn...",
    "y.BBCCBnnn..",
    "..BkkCnnnyy.",
    "..BBBBnn.yy.",
    "..BB.kkn....",
    "..y.OOyy....",
    "..y.wb......",
    "....wb......",
    ".....wb.....",
    ".....wb.....",
    "..yy.wb.....",
    "..yywwbbOO..",
  }, RAGS)
  list[2] = { g, P.image(12, 20) }
  return list
end

---------------------------------------------------------------------------------------------------
-- Wheat, a patch of it standing in the field: a stand of sage straw on its own dark foot, so it
-- sits on the meadow as a crop and not as more of the grass, under a band of bearded ears in two
-- ranks. Its foot is a straight row, and patches set side by side run on as one field.
---------------------------------------------------------------------------------------------------
-- An ear: a 1-px awn over three rows of grain two wide, its top two rows a pixel right of the
-- third as the ears nod over; t is its tip, a the lit side and b the shaded, w the awn, and c and d
-- the lowest row where it differs from a and b.
local EAR = { "..w", ".tb", ".ab", "cd." }
local EAR_LOW = { c = "a", d = "b" }
-- The front rank, { foot column, awn row, kind }, three and four columns apart so the tops ripple;
-- the back rank in the gaps between them, in shade.
local FRONT = { { 0, 1, 1 }, { 4, 0, 2 }, { 7, 1, 3 }, { 11, 0, 1 }, { 14, 1, 2 }, { 18, 0, 3 }, { 21, 1, 1 }, { 25, 0, 2 }, { 28, 1, 3 } }
local BACK = { { 2, 1 }, { 5, 1 }, { 9, 1 }, { 12, 1 }, { 16, 1 }, { 19, 1 }, { 23, 1 }, { 26, 1 }, { 30, 1 } }
local function ear(g, x, y, key)
  for j, r in ipairs(EAR) do
    for i = 1, 3 do
      local k = r:sub(i, i)
      if k ~= "." then P.pix(g, (x + i - 1) % 32, y + j - 1, key[k] or key[EAR_LOW[k]]) end
    end
  end
end
-- The stand under the ears, by hand: m the straw, d its shade going down between the stalks into
-- the foot, o the foot where the stand goes dark into the ground, its last row its edge on the
-- field.
local STAND = {
  "mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm",
  "mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm",
  "mmdmmmmmmdmmmmmmdmmmmmmdmmmdmmmm",
  "mmddmmmmmdmmmmmddmmmmmmdmmmdmmmm",
  "oooooooooooooooooooooooooooooooo",
  "oooooooooooooooooooooooooooooooo",
}
local function stand(g, key, from)
  for j, r in ipairs(STAND) do
    if 3 + j >= (from or 0) then
      for i = 1, #r do P.pix(g, i - 1, 3 + j, key[r:sub(i, i)]) end
    end
  end
end
-- `kinds` the ears of the front rank, `back` the back rank's, `key` the stand's colours. The back
-- rank's ears go down into the stand behind the front rank's stalks, which catch the light for a
-- row or two under their ears before the stand closes over them.
local function wheatField(g, kinds, back, key)
  stand(g, key)
  for _, e in ipairs(BACK) do ear(g, e[1], e[2], back) end
  stand(g, key, 5)
  for _, e in ipairs(FRONT) do
    ear(g, e[1], e[2], kinds[e[3]])
    for y = e[2] + 4, math.min(6, e[2] + 5) do P.pix(g, e[1], y, key.l) end
  end
end
local function wheatBase()
  local g = P.image(32, 10)
  wheatField(g, {
      { t = "yellow", a = "lime", b = "sand", w = "sand" },     -- turning: lime going to sand
      { t = "yellow", a = "yellow", b = "sand", w = "sand" },   -- gold
      { t = "lime", a = "lime", b = "sage", w = "lime" },       -- still green
    },
    { t = "sage", a = "sage", b = "ochre", w = "ochre", d = "sage" },
    { m = "sage", d = "olive", o = "olive", l = "lime" })
  return g, P.image(32, 10)
end

-- Ripe: every ear gold, the stand straw. Harvested: the field cut to a short stubble, lit on its
-- left, the sheaves stood up in two stooks to dry, their ears up and their butts splayed.
local STOOK = {
  "...y.y...",
  "..ySySy..",
  ".ySSSSSO.",
  "..SSSSO..",
  "...www...",
  "..SSOOO..",
  ".SSSOOOO.",
  "SSSOSOOOO",
  "SSOSSOOOO",
}
local function wheatStages()
  local list = {}
  local g = P.image(32, 10)
  wheatField(g, {
      { t = "yellow", a = "yellow", b = "sand", w = "sand" },
      { t = "skin", a = "skin", b = "sand", w = "sand" },
      { t = "yellow", a = "sand", b = "ochre", w = "ochre" },
    },
    { t = "sand", a = "sand", b = "ochre", w = "ochre", d = "sand" },
    { m = "sand", d = "ochre", o = "ochre", l = "skin" })
  list[1] = { g, P.image(32, 10) }
  g = P.image(32, 10)
  -- stubble: a cut tuft every fourth column, lit on its left, two or three rows tall, standing in
  -- the dry grass of the field with the earth showing between
  map(g, 0, 8, {
    "sOaasOaasOoasOa.sOaosOaasOoasOa.",
    "ooaaooaaoooooOaaooaoooaaoooaooaa",
  }, { s = "sand", O = "ochre", a = "sage", o = "olive" })
  for x = 0, 31, 4 do
    local h = (x % 12 == 0) and 3 or 2
    for y = 9 - h, 8 do P.pix(g, x, y, "sand"); P.pix(g, x + 1, y, "ochre") end
  end
  map(g, 4, 1, STOOK, { y = "yellow", S = "sand", O = "ochre", w = "wood", b = "bark" })
  map(g, 20, 2, {
    "..y.y..",
    ".ySySO.",
    "..SSO..",
    "..www..",
    ".SSOOO.",
    "SSOSOOO",
    "SOSSOOO",
  }, { y = "yellow", S = "sand", O = "ochre", w = "wood", b = "bark" })
  list[2] = { g, P.image(32, 10) }
  return list
end

---------------------------------------------------------------------------------------------------
-- Sunflowers: three, a tall one in the middle, their faces turned out to the lane.
---------------------------------------------------------------------------------------------------
local SUN = { Y = "yellow", S = "sand", O = "ochre", w = "wood", b = "bark", g = "grass", l = "lime", m = "moss", p = "plum" }
-- the faces, lit on the upper left; the stalks; the leaves, each pointing away from its stalk
local HEAD = {
  L = { "..YYY..", ".YYYYS.", "YYwwbYS", "YYwbbSS", ".YbbbS.", "..SSS.." },
  M = { ".YYYS.", "YYwbbS", "YwbbbS", "YbbbSS", ".SSSS." },
}
local LEAF = {
  l = { "lll.", ".lgg", "..mm" },   -- pointing left, its stalk on its right
  r = { ".ll", "lgg", "mm." },      -- pointing right, its stalk on its left
}
-- each flower: head shape, head x, head y, stalk x; then its leaves as { side, x, y }
local FLOWERS = {
  { "L", 7, 0, 10, { { "l", 6, 8 }, { "r", 11, 11 } } },
  { "M", 1, 5, 3, { { "r", 4, 11 } } },
  { "M", 13, 7, 15, { { "l", 11, 13 } } },
}
-- The foot of the patch: a small tuft of grass round each stalk where it meets the ground, lit on
-- its left, and the field showing between them.
local TUFTS = "..lmm....lmmm.lmm..."
local function tufts(g, lit, dark)
  for i = 1, #TUFTS do
    local k = TUFTS:sub(i, i)
    if k == "l" then
      -- a blade beside the stalk, or where a leaf hangs to the ground there, the leaf's tip
      local over = at(g, i - 1, 16)
      P.pix(g, i - 1, 17, over or lit)
      if not over then P.pix(g, i - 1, 16, lit) end
    elseif k == "m" then P.pix(g, i - 1, 17, dark) end
  end
end
local function sunflowerPatch(g, key, heads, flowers)
  for _, f in ipairs(flowers) do
    local h = heads[f[1]]
    for y = f[3] + #h, 16 do P.pix(g, f[4], y, y >= 15 and key.stalkLow or key.stalk) end
  end
  for _, f in ipairs(flowers) do
    for _, lf in ipairs(f[5]) do map(g, lf[2], lf[3], LEAF[lf[1]], key) end
    map(g, f[2], f[3], heads[f[1]], key)
  end
  tufts(g, key.footLit, key.foot)
end
local function sunflowersBase()
  local g = P.image(20, 18)
  sunflowerPatch(g, { Y = "yellow", S = "sand", w = "wood", b = "bark", l = "lime", g = "grass", m = "moss",
                      stalk = "grass", stalkLow = "moss", footLit = "grass", foot = "moss" }, HEAD, FLOWERS)
  return g, P.image(20, 18)
end

-- Drooping: the heads bowed on their stalks the way they will hang when dead, the tall one and the
-- left one to the left, the right one to the right, so the dark green backs show over the faces;
-- each face keeps a ragged fringe of petals round its lower rim, yellow where the light catches it
-- and sand below, with gaps where petals have dropped; the leaves turning. Dead: the heads brown
-- and bare, hung low on stalks bent over like crooks, the leaves shrivelled and hanging.
-- A bowed head: m is its moss back, g the light on it and v its shade down the side the stalk
-- comes up to; the face below it, w and b, turned to the ground.
local DROOP = {
  L = { "..ggm..", ".Ymmmmv", "YYwbmmv", "Ywbbbmv", "YSbbbS.", ".S...S." },
  M = { ".ggm.", "Ymmmv", "Ybbmv", "YSbv.", ".S..." },
  R = { ".ggm.", "gmmmY", "vmbbY", ".vbbS", "..SS." },
}
local DEAD = {
  L = { ".ooo..", "ooooo.", "bwwbbp", ".bbbp.", "..pp.." },
  M = { ".oo..", "oooo.", "wwbbp", ".bpp." },
}
-- a turning leaf hangs from its stalk, lit along its top, its tip dropping away from the stalk
local LEAF_DRY = {
  l = { ".aa", "aoo", "o.." },
  r = { "aa.", "ooa", "..o" },
}
local LEAF_DEAD = {
  l = { "oo..", ".ovv", "...v" },
  r = { "..oo", "vvo.", "v..." },
}
local function sunflowerStages()
  local list = {}
  local g = P.image(20, 18)
  local key = { Y = "yellow", S = "sand", w = "wood", b = "bark", m = "moss", g = "grass", a = "sage", o = "ochre", v = "olive",
                stalk = "sage", stalkLow = "olive", footLit = "sage", foot = "moss" }
  -- each flower's stalk is drawn to its top, then bowed over to where its head hangs
  local function patch(g, heads, leaves, flowers, key)
    for _, f in ipairs(flowers) do
      for y = f.top, 16 do P.pix(g, f.x, y, y >= 15 and key.stalkLow or key.stalk) end
      for _, b in ipairs(f.bend) do P.pix(g, b[1], b[2], key.stalk) end
    end
    for _, f in ipairs(flowers) do
      for _, lf in ipairs(f.leaves) do map(g, lf[2], lf[3], leaves[lf[1]], key) end
      map(g, f.hx, f.hy, heads[f.head], key)
    end
    tufts(g, key.footLit, key.foot)
  end
  patch(g, DROOP, LEAF_DRY, {
    { x = 10, top = 6, bend = {}, head = "L", hx = 4, hy = 2, leaves = { { "l", 7, 9 }, { "r", 11, 11 } } },
    { x = 3, top = 10, bend = {}, head = "M", hx = 0, hy = 6, leaves = { { "r", 4, 12 } } },
    { x = 15, top = 12, bend = {}, head = "R", hx = 14, hy = 8, leaves = { { "r", 16, 13 } } },
  }, key)
  list[1] = { g, P.image(20, 18) }
  g = P.image(20, 18)
  key = { b = "bark", w = "wood", p = "plum", o = "olive", v = "bark", stalk = "ochre", stalkLow = "ochre", footLit = "ochre", foot = "olive" }
  patch(g, DEAD, LEAF_DEAD, {
    { x = 10, top = 3, bend = { { 9, 2 }, { 8, 2 }, { 7, 3 } }, head = "L", hx = 4, hy = 4, leaves = { { "r", 11, 11 } } },
    { x = 3, top = 9, bend = { { 2, 8 }, { 1, 9 } }, head = "M", hx = 0, hy = 10, leaves = { { "r", 4, 14 } } },
    { x = 15, top = 10, bend = { { 16, 9 }, { 17, 10 } }, head = "M", hx = 15, hy = 11, leaves = { { "l", 11, 14 } } },
  }, key)
  list[2] = { g, P.image(20, 18) }
  return list
end

---------------------------------------------------------------------------------------------------
-- Sheet
---------------------------------------------------------------------------------------------------
-- Lone pixels: one that matches none of its eight neighbours, outside the lights. A few are meant
-- (an eye, a nail head); ORPHANS = true lists them while drawing.
local function orphans(name, g, l)
  local list = {}
  for y = 0, g.height - 1 do for x = 0, g.width - 1 do
    local c = g:getPixel(x, y)
    if pc.rgbaA(c) > 0 and pc.rgbaA(l:getPixel(x, y)) == 0 then
      local same = false
      for dy = -1, 1 do for dx = -1, 1 do
        if (dx ~= 0 or dy ~= 0) and x + dx >= 0 and y + dy >= 0 and x + dx < g.width and y + dy < g.height and g:getPixel(x + dx, y + dy) == c then same = true end
      end end
      if not same then list[#list + 1] = x .. "," .. y .. "=" .. (NAME[c] or "?") end
    end
  end end
  if #list > 0 then print(name .. " lone: " .. table.concat(list, " ")) end
end
local function sprite(name, w, h, frames, note, list)
  local cell = P.strip(S, name, w, h, frames, note)
  for f = 0, frames - 1 do
    local g, l = list[f + 1][1], list[f + 1][2]
    assert(g.width == w and g.height == h, name .. " is " .. g.width .. "x" .. g.height)
    if rawget(_G, "ORPHANS") then orphans(name .. (frames > 1 and ("#" .. f) or ""), g, l) end
    local x, y = cell(f)
    P.blit(S.base, g, x, y)
    P.blit(S.lights, l, x, y)
  end
end

local bg, bl = barnBase()
sprite("barn", 44, 32, 1, "gambrel gable end left with the doors, long side right; lantern over the doors", { { bg, bl } })
do
  local st = barnStages(bg, bl)
  local STEP = { "worn", "derelict", "scorched" }
  for k = 1, 3 do sprite("barn_" .. k, 44, 32, 1, "barn, " .. STEP[k], { st[k] }) end
end
sprite("ruin3", 44, 22, 1, "the barn burnt out; embers in the lights", { { ruin3() } })
do
  local g, l = granaryBase()
  sprite("granary", 16, 36, 1, "fieldstone silo under a red shingle cone", { { g, l } })
  local st = granaryStages(g, l)
  local STEP = { "worn", "derelict", "scorched" }
  for k = 1, 3 do sprite("granary_" .. k, 16, 36, 1, "granary, " .. STEP[k], { st[k] }) end
end
do
  local g, l = cartBase()
  sprite("cart", 24, 14, 1, "hay wain, shaft left", { { g, l } })
  local st = cartStages()
  sprite("cart_1", 24, 14, 1, "cart, weathered and half empty", { st[1] })
  sprite("cart_2", 24, 14, 1, "cart, abandoned: a wheel broken, tipped on its axle", { st[2] })
end
sprite("cow", 16, 10, 2, "head up, then grazing; kept only", { { cowFrame(0) }, { cowFrame(1) } })
do
  local g, l = scarecrowBase()
  sprite("scarecrow", 12, 20, 1, "straw man on a post", { { g, l } })
  local st = scarecrowStages()
  sprite("scarecrow_1", 12, 20, 1, "scarecrow, faded", { st[1] })
  sprite("scarecrow_2", 12, 20, 1, "scarecrow, tattered and leaning, straw spilling", { st[2] })
end
do
  local g, l = wheatBase()
  sprite("wheat", 32, 10, 1, "green ears turning gold; repeats left-right", { { g, l } })
  local st = wheatStages()
  sprite("wheat_1", 32, 10, 1, "ripe gold; repeats left-right", { st[1] })
  sprite("wheat_2", 32, 10, 1, "stubble and stooks; repeats left-right", { st[2] })
end
do
  local g, l = sunflowersBase()
  sprite("sunflowers", 20, 18, 1, "three sunflowers", { { g, l } })
  local st = sunflowerStages()
  sprite("sunflowers_1", 20, 18, 1, "heads drooping, petals fewer", { st[1] })
  sprite("sunflowers_2", 20, 18, 1, "dead heads on bent stalks", { st[2] })
end

P.save(S, ART, 3)

---------------------------------------------------------------------------------------------------
-- Previews. farm-stages.png: each thing through its stages, left to right, untinted over the day
-- sky, then below multiplied by each stage's light over the evening sky with its lights on top.
-- farm-scene.png: the base sprites among the village's own on a run of field, by day and in the
-- late evening light.
---------------------------------------------------------------------------------------------------
local function family(name)
  local f = assert(io.open(ART .. "/" .. name .. ".json")); local json = f:read("a"); f:close()
  local fam = { base = Image { fromFile = ART .. "/" .. name .. ".png" },
                lights = Image { fromFile = ART .. "/" .. name .. "-lights.png" }, sprites = {} }
  for n, x, y, w, h, frames in json:gmatch('"name":"([%w_]+)","x":(%d+),"y":(%d+),"w":(%d+),"h":(%d+),"frames":(%d+)') do
    fam.sprites[n] = { x = tonumber(x), y = tonumber(y), w = tonumber(w), h = tonumber(h), frames = tonumber(frames) }
  end
  return fam
end
local OTHERS = { family("village"), family("ground") }
local mine = {}
for _, e in ipairs(S.sprites) do mine[e.name] = e end
-- one frame of a sprite by name, this sheet's or another family's, as base and lights
local function frameOf(name, f)
  f = f or 0
  local src, e = { base = S.base, lights = S.lights }, mine[name]
  if not e then
    for _, fam in ipairs(OTHERS) do if fam.sprites[name] then src, e = fam, fam.sprites[name] end end
  end
  if not e then return nil end
  local g, l = P.image(e.w, e.h), P.image(e.w, e.h)
  P.blit(g, src.base, 0, 0, e.x + f * e.w, e.y, e.w, e.h)
  P.blit(l, src.lights, 0, 0, e.x + f * e.w, e.y, e.w, e.h)
  return g, l
end
local function multiply(c, t)
  return pc.rgba(pc.rgbaR(c) * pc.rgbaR(t) // 255, pc.rgbaG(c) * pc.rgbaG(t) // 255, pc.rgbaB(c) * pc.rgbaB(t) // 255, 255)
end
-- a sprite at x, y as it is, and `dy` lower multiplied by light t with its lights over it
local function place(out, g, l, x, y, dy, t)
  t = P.hex(t)
  for j = 0, g.height - 1 do for i = 0, g.width - 1 do
    local p = g:getPixel(i, j)
    if pc.rgbaA(p) > 0 then
      out:drawPixel(x + i, y + j, p)
      out:drawPixel(x + i, dy + y + j, multiply(p, t))
    end
    local q = l:getPixel(i, j)
    if pc.rgbaA(q) > 0 then out:drawPixel(x + i, dy + y + j, q) end
  end end
end
local function write(out, zoom, path)
  local big = P.image(out.width * zoom, out.height * zoom)
  for j = 0, out.height - 1 do for i = 0, out.width - 1 do
    local p = out:getPixel(i, j)
    for yy = 0, zoom - 1 do for xx = 0, zoom - 1 do big:drawPixel(i * zoom + xx, j * zoom + yy, p) end end
  end end
  local spr = Sprite(big.width, big.height, ColorMode.RGB)
  spr.cels[1].image = big
  spr:saveCopyAs(path)
  spr:close()
end

do
  local LIGHT = { "#FFFFFF", "#D49989", "#AA5E66", "#B15C60", "#C35855" }
  -- each row lists { name, frame, light }; the light defaults to the stage the column stands for
  local ROWS = {
    { { "barn" }, { "barn_1" }, { "barn_2" }, { "barn_3" }, { "ruin3", 0, "#C35855" } },
    { { "granary" }, { "granary_1" }, { "granary_2" }, { "granary_3" } },
    { { "cart" }, { "cart_1" }, { "cart_2" } },
    { { "cow", 0, "#FFFFFF" }, { "cow", 1, "#FFFFFF" } },
    { { "scarecrow" }, { "scarecrow_1" }, { "scarecrow_2" } },
    { { "wheat" }, { "wheat_1" }, { "wheat_2" } },
    { { "sunflowers" }, { "sunflowers_1" }, { "sunflowers_2" } },
  }
  local cellW, gap = 48, 4
  local heights, total, cols = {}, gap, 0
  for r, row in ipairs(ROWS) do
    local h = 0
    for _, c in ipairs(row) do local g = frameOf(c[1], c[2]); if g then h = math.max(h, g.height) end end
    heights[r] = h; total = total + h + gap; cols = math.max(cols, #row)
  end
  local W = gap + cols * (cellW + gap)
  local out = P.image(W, total * 2)
  P.rect(out, 0, 0, W, total, "#72EAD0"); P.rect(out, 0, total, W, total, "#E2793C")
  local y = gap
  for r, row in ipairs(ROWS) do
    for k, c in ipairs(row) do
      local g, l = frameOf(c[1], c[2])
      if g then
        place(out, g, l, gap + (k - 1) * (cellW + gap) + (cellW - g.width) // 2, y + heights[r] - g.height, total,
              c[3] or LIGHT[(k - 1) % #LIGHT + 1])
      end
    end
    y = y + heights[r] + gap
  end
  write(out, 3, ART .. "/farm-stages.png")
end

do
  -- the scene: H rows, the rail at H - 24 as on the page; each item stands at railY - up
  local W, H = 480, 110
  local railY = H - 24
  local out = P.image(W, H * 2)
  P.rect(out, 0, 0, W, H, "#72EAD0"); P.rect(out, 0, H, W, H, "#E2793C")
  local function tile(name, y, f)
    for x = 0, W - 1, 32 do local g, l = frameOf(name, f); place(out, g, l, x, y, H, "#BF7B77") end
  end
  tile("field0", railY - 26, 0)
  for x = 64, W - 1, 160 do local g, l = frameOf("field0", 1); place(out, g, l, x, railY - 26, H, "#BF7B77") end
  local function stand(name, x, up, f)
    local g, l = frameOf(name, f)
    if g then place(out, g, l, x, railY - up - g.height, H, "#BF7B77") end
  end
  -- the back row, on the field's top edge
  for _, it in ipairs { { "poplar", 6, 24 }, { "house2", 20, 24 }, { "granary", 60, 25 }, { "barn", 78, 24 }, { "oak2", 130, 25 },
                        { "house3", 300, 24 }, { "pine", 336, 24 }, { "barn", 392, 24 }, { "poplar", 440, 25 } } do
    stand(it[1], it[2], it[3])
  end
  -- the main row, the farthest first
  for _, it in ipairs {
    { "house1", 2, 8 }, { "oak1", 38, 6 },
    { "barn", 66, 9 }, { "granary", 111, 10 }, { "cart", 130, 4 },
    { "cow", 162, 9, 0 }, { "cow", 182, 6, 1 }, { "sheep", 204, 8, 1 },
    { "scarecrow", 262, 7 }, { "wheat", 222, 6 }, { "wheat", 254, 6 }, { "wheat", 286, 6 },
    { "sunflowers", 324, 4 }, { "sunflowers", 340, 4 }, { "poplar", 364, 6 },
    { "house3", 378, 7 }, { "haystack", 410, 4 }, { "oak2", 428, 8 }, { "cow", 452, 7, 0 },
  } do stand(it[1], it[2], it[3], it[4]) end
  tile("track0", railY - 1, 0)
  -- the fence in runs, as the page lays it, with the verge between
  for x = 0, 96, 16 do stand("fence", x, 2) end
  for x = 352, 432, 16 do stand("fence", x, 2) end
  tile("front0", H - 16, 0)
  write(out, 3, ART .. "/farm-scene.png")
end
