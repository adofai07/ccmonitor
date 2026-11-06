-- worn.lua: the village wearing down through the evening, built from the finished village art.
-- Every building comes in three steps, each a small one from the last: _1 worn (still lived in),
-- _2 derelict (abandoned, dark), _3 scorched (the fire has reached it). After _3 come hell's
-- burnt-out shells ruin1 and ruin2. Each step is the step before it with more done to it, so the
-- same boards, holes and cracks carry through and the viewer sees one village age.
local P = dofile(ART .. "/px.lua")
local S = P.sheet("worn", 512, 256)

---------------------------------------------------------------------------------------------------
-- Reading the finished families
---------------------------------------------------------------------------------------------------
local NAME = {}
for n in pairs(P.C) do NAME[P.hex(n)] = n end

local function family(name)
  local f = assert(io.open(ART .. "/" .. name .. ".json")); local json = f:read("a"); f:close()
  local fam = { base = Image { fromFile = ART .. "/" .. name .. ".png" },
                lights = Image { fromFile = ART .. "/" .. name .. "-lights.png" }, sprites = {} }
  for n, x, y, w, h, frames in json:gmatch('"name":"([%w_]+)","x":(%d+),"y":(%d+),"w":(%d+),"h":(%d+),"frames":(%d+)') do
    fam.sprites[n] = { x = tonumber(x), y = tonumber(y), w = tonumber(w), h = tonumber(h), frames = tonumber(frames) }
  end
  return fam
end
local VILLAGE, HELL = family("village"), family("hell")

-- One frame of a finished sprite, base and lights, as fresh images.
local function copy(fam, name, f)
  local s = assert(fam.sprites[name], "no sprite " .. name)
  local g, l = P.image(s.w, s.h), P.image(s.w, s.h)
  P.blit(g, fam.base, 0, 0, s.x + (f or 0) * s.w, s.y, s.w, s.h)
  P.blit(l, fam.lights, 0, 0, s.x + (f or 0) * s.w, s.y, s.w, s.h)
  return g, l
end

local pc = app.pixelColor
local function luma(c) return 0.299 * pc.rgbaR(c) + 0.587 * pc.rgbaG(c) + 0.114 * pc.rgbaB(c) end

-- The last pass over every image: a pixel that matches none of its eight neighbours is what an
-- overlap of washes, rims and planks leaves behind, so it takes its neighbours' commonest colour,
-- the four beside it counting double. A tie goes to the colour the village drew at that spot, or
-- else to the one nearest the pixel's own value, so a stray keeps to its own material.
-- Pixels under a light are dark windows by contract, and pixels in `keep` (broken glass, drawn
-- one by one) were placed on purpose; both stay as they are.
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

local function sprite(name, w, h, frames, note, draw)
  local cell = P.strip(S, name, w, h, frames, note)
  for f = 0, frames - 1 do
    local g, l, keep, orig = draw(f)
    g, l = g:clone(), l:clone()
    tidyAll(g, l, keep, orig)
    assert(g.width == w and g.height == h, name .. " is " .. g.width .. "x" .. g.height)
    local x, y = cell(f)
    P.blit(S.base, g, x, y)
    P.blit(S.lights, l, x, y)
  end
end

---------------------------------------------------------------------------------------------------
-- Pixel tools
---------------------------------------------------------------------------------------------------
-- The palette name at x, y, or nil where the sprite is clear.
local function at(g, x, y)
  if x < 0 or y < 0 or x >= g.width or y >= g.height then return nil end
  local c = g:getPixel(x, y)
  if app.pixelColor.rgbaA(c) == 0 then return nil end
  return NAME[c] or "?"
end

-- Recolours by name inside a rectangle (the whole sprite by default); names not in `map` stay.
local function remap(g, map, x, y, w, h)
  x, y, w, h = x or 0, y or 0, w or g.width, h or g.height
  for j = y, y + h - 1 do for i = x, x + w - 1 do
    local n = at(g, i, j)
    if n and map[n] then P.pix(g, i, j, map[n]) end
  end end
end
local function remapAt(g, map, i, j)
  local n = at(g, i, j)
  if n and map[n] then P.pix(g, i, j, map[n]) end
end

-- P.map with its rows checked, and a legend that may hold P.CLEAR to knock pixels out.
local function map(g, x, y, rows, legend)
  for j, r in ipairs(rows) do
    if #r ~= #rows[1] then error("row " .. j .. " is " .. #r .. " wide, expected " .. #rows[1] .. ": " .. r) end
  end
  P.map(g, x, y, rows, legend)
end

-- A map whose letters are ramps rather than colours: each pixel is recoloured through the ramp the
-- letter names, so one patch of grime or soot can lie over plaster, timber and stone alike.
local function wash(g, x, y, rows, ramps)
  for j, r in ipairs(rows) do
    if #r ~= #rows[1] then error("row " .. j .. " is " .. #r .. " wide, expected " .. #rows[1] .. ": " .. r) end
    for i = 1, #r do
      local k = r:sub(i, i)
      if k ~= "." and k ~= " " then
        local ramp = ramps[k]
        if ramp == nil then error("wash has no '" .. k .. "'") end
        remapAt(g, ramp, x + i - 1, y + j - 1)
      end
    end
  end
end

-- Ramps, each a step down a material's own colours.
-- GRIME: dust and damp, one shade down. CRACK: a fissure, two shades down.
local GRIME = { skin = "sand", sand = "ochre", white = "ice", ice = "steel", steel = "stone", stone = "grey",
                grey = "smoke", wood = "bark", teal = "moss", red = "plum", coral = "red", navy = "indigo" }
local CRACK = { skin = "wood", sand = "wood", white = "stone", ice = "stone", steel = "grey", stone = "smoke",
                grey = "slate", wood = "bark", bark = "plum", teal = "slate", moss = "slate", sage = "olive",
                red = "plum", coral = "red", ochre = "bark" }
-- SOOT: smoke-stained, toward grey. CHAR: blackened, toward slate and ink.
local SOOT = { skin = "stone", sand = "grey", white = "stone", ice = "stone", steel = "grey", stone = "grey",
               grey = "smoke", wood = "smoke", bark = "slate", teal = "slate", moss = "slate", sage = "smoke",
               ochre = "smoke", red = "plum", coral = "red", navy = "slate", indigo = "ink", plum = "ink",
               olive = "slate", yellow = "sand" }
local CHAR = { skin = "smoke", sand = "smoke", white = "grey", ice = "grey", steel = "smoke", stone = "smoke",
               grey = "slate", smoke = "slate", wood = "slate", bark = "ink", teal = "ink", moss = "ink",
               sage = "slate", ochre = "slate", red = "ink", coral = "plum", plum = "ink", navy = "ink",
               indigo = "ink", slate = "ink", olive = "ink" }

-- Tiles under smoke: darker in their own warm ramp, never grey.
local ROOFSOOT = { red = "plum", coral = "red", bark = "plum", plum = "ink" }
-- One ramp after another: each colour taken as far as both go.
local function compose(a, b)
  local r = {}
  for k, v in pairs(a) do r[k] = b[v] or v end
  for k, v in pairs(b) do if r[k] == nil then r[k] = v end end
  return r
end
-- The letters a scorch map paints with: r tiles, s smoke-stained, c sooted, x blackened.
local SCORCH = { r = ROOFSOOT, q = compose(ROOFSOOT, ROOFSOOT), g = GRIME, s = SOOT, c = compose(SOOT, CHAR),
                 x = compose(compose(SOOT, CHAR), CHAR) }

-- A ragged line through the given points, recoloured through `ramp` (CRACK by default).
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

-- Damp and dust along the foot of a wall: `heights` is a string of digits, one per column from x.
local WALLGRIME = { skin = "sand", sand = "ochre", ice = "steel", steel = "stone", stone = "grey", grey = "smoke", teal = "moss" }
local function grime(g, x, y, heights, ramp)
  for i = 1, #heights do
    local h = tonumber(heights:sub(i, i))
    for j = 0, h - 1 do remapAt(g, ramp or WALLGRIME, x + i - 1, y - j) end
  end
end

-- A rain streak: a short run down the wall under a sill.
local function streak(g, x, y, n, ramp)
  for j = 0, n - 1 do remapAt(g, ramp or GRIME, x, y + j) end
end

-- What the current building's broken glass has placed by hand, kept out of the tidying pass.
local KEEP
local function protect(x, y) P.pix(KEEP, x, y, "white") end

-- Planks nailed across a casement at x, y, w, h, overhanging it on alternate sides, with the dark
-- opening between them. On 5 rows or fewer the two planks cover the frame's top and bottom rows,
-- so no strip of frame shows above them; on 6 a plank and a lath; on more, two planks. `lit` and
-- `dark` are a plank's top and underside, wood and bark unless the wall is itself wood. `lo` and
-- `hi` are the furthest columns a plank may reach, a pixel short of the building's outline.
local function board(g, l, x, y, w, h, lit, dark, lo, hi)
  P.rect(l, x, y, w, h, nil)
  P.rect(g, x + 1, y + 1, w - 2, h - 2, "ink")
  local function plank(py, x0, x1)
    x0, x1 = math.max(x0, lo or x0), math.min(x1, hi or x1)
    P.hline(g, x0, py, x1 - x0 + 1, lit or "wood"); P.hline(g, x0, py + 1, x1 - x0 + 1, dark or "bark")
  end
  if h <= 5 then plank(y, x - 1, x + w - 1); plank(y + h - 2, x, x + w) return end
  plank(y + 1, x - 1, x + w - 1)
  if h == 6 then
    local x0, x1 = x, math.min(x + w, hi or x + w)
    P.hline(g, x0, y + 4, x1 - x0 + 1, lit or "wood") return
  end
  plank(y + h - 3, x, x + w)
end

-- A casement broken, redrawn at x, y one pixel at a time, frame and all: k the dark inside, I and
-- e glass left in the frame (lit and in shade), and the frame's own colours where it still stands;
-- "." leaves a pixel alone. The light behind it goes out, and what is drawn is kept from tidying.
-- The glazing bars go with the glass, so the inside is one dark hole: a shard hangs from one top
-- corner and one corner of the frame is knocked off to the wall's colour. Bar stubs left standing
-- in the hole read as letters at scene scale.
local GLASS = { k = "ink", I = "ice", e = "steel", W = "white", T = "stone", G = "grey", w = "wood",
                b = "bark", s = "sand", S = "skin", n = "navy", p = "plum", u = "purple", i = "indigo" }
local function smash(g, l, x, y, rows)
  for j, r in ipairs(rows) do
    if #r ~= #rows[1] then error("smash row " .. j .. " is " .. #r .. " wide") end
    for i = 1, #r do
      local k = r:sub(i, i)
      if k ~= "." then
        if not GLASS[k] then error("smash has no '" .. k .. "'") end
        P.pix(g, x + i - 1, y + j - 1, GLASS[k]); protect(x + i - 1, y + j - 1)
      end
      P.pix(l, x + i - 1, y + j - 1, nil)
    end
  end
end

-- Hand touches after the washes, one pixel at a time, by the same one-letter names as the letter
-- grids the art was checked in ("." leaves a pixel, "_" clears it); kept from the tidying pass.
local CODE = { ["0"] = "black", k = "ink", p = "plum", b = "bark", w = "wood", r = "rust", s = "sand", S = "skin",
  y = "yellow", l = "lime", g = "grass", t = "teal", m = "moss", o = "olive", L = "slate", i = "indigo", n = "navy",
  B = "blue", K = "sky", c = "cyan", I = "ice", W = "white", e = "steel", T = "stone", G = "grey", M = "smoke",
  u = "purple", R = "red", C = "coral", P = "pink", a = "sage", O = "ochre" }
local function touch(g, x, y, rows)
  for j, r in ipairs(rows) do
    for i = 1, #r do
      local k = r:sub(i, i)
      if k == "_" then P.pix(g, x + i - 1, y + j - 1, nil)
      elseif k ~= "." then
        if not CODE[k] then error("touch has no '" .. k .. "'") end
        P.pix(g, x + i - 1, y + j - 1, CODE[k]); protect(x + i - 1, y + j - 1)
      end
    end
  end
end

-- Fire glow deep in an opening: the base goes black and the light is laid on the lights layer.
local function embers(g, l, list)
  for _, e in ipairs(list) do P.pix(g, e[1], e[2], "black"); P.pix(l, e[1], e[2], e[3]) end
end

local function clearLights(l) P.rect(l, 0, 0, l.width, l.height, nil) end

-- Every colour of a sprite run through `ramp` above a ragged line: `edge` is a string of base-36
-- digits, one per column from x0, giving how many rows below `y0` the stain reaches there.
local function stain(g, y0, edge, ramp, x0)
  x0 = x0 or 0
  for i = 1, #edge do
    local d = tonumber(edge:sub(i, i), 36)
    for y = 0, y0 + d - 1 do remapAt(g, ramp, x0 + i - 1, y) end
  end
end

-- The same over rows y0 down to y0 + d - 1 only: a band whose lower edge is ragged.
local function band(g, y0, edge, ramp, x0)
  x0 = x0 or 0
  for i = 1, #edge do
    local d = tonumber(edge:sub(i, i), 36)
    for y = y0, y0 + d - 1 do remapAt(g, ramp, x0 + i - 1, y) end
  end
end

-- A hole in a roof. In `rows` (at x, y) k marks the void; draw it with a straight top edge along
-- a course and a stepped lower one, as tiles break. Rafters cross it every `pitch` columns from
-- `phase`, leaning a column per `rise` rows like the roof's verge (`shift` lines the steps up with
-- the verge's; `rise` 0 stands them upright), and battens run level across it on the rows listed in
-- `battens`, all in the sprite's own coordinates, so a bigger hole later shows the same timbers.
-- The broken tile ends along the lower edge catch the light, so `rim` recolours the pixel under
-- each void column. `void` may be P.CLEAR: then the sky shows through.
local function hole(g, x, y, rows, o)
  local void, list = {}, {}
  for j, r in ipairs(rows) do
    if #r ~= #rows[1] then error("hole row " .. j .. " is " .. #r .. " wide") end
    for i = 1, #r do
      local px, py = x + i - 1, y + j - 1
      if r:sub(i, i) == "k" and at(g, px, py) then
        void[px .. "," .. py] = true; list[#list + 1] = { px, py }
      end
    end
  end
  local isVoid = function(i, j) return void[i .. "," .. j] end
  if o.rim then
    for _, p in ipairs(list) do
      if not isVoid(p[1], p[2] + 1) then remapAt(g, o.rim, p[1], p[2] + 1) end
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

-- A casement's frame and anything nailed over it, smoke-stained: the step before its plume.
local function sootFrame(g, x, y, w, h) remap(g, SOOT, x - 1, y, w + 2, h) end

-- A soot plume licking up from an opening: a tongue of soot, blackest at its core, whose foot
-- lies on the opening's top frame (row y) and overhangs it a pixel each side. One shape per width,
-- short or tall; s, c and x are one, two and three steps of soot, as in a scorch map.
local PLUMES = {
  [3] = { short = { ".sc..", "scxcs" },
          tall = { "..c..", ".scs.", ".cxc.", "scxcs" } },
  [4] = { short = { ".scs..", "scxxcs" },
          tall = { "..c...", ".scs..", ".cxcs.", "scxxcs" } },
  [5] = { short = { "..sc...", ".scxs..", "sccxccs" },
          tall = { "...c...", "..scs..", "..cxc..", ".scxxs.", "scxxxcs" } },
  [10] = { short = { "...sc....cs.", "..scxs..sxcs", "sccxxcsscxcs" },
           tall = { "...c......c.", "..scs....sc.", "..cxcs..scxs", ".scxxs.scxxs", "sccxxcsscxcs" } },
}
local function plume(g, x, y, w, size)
  local rows = PLUMES[w][size or "short"]
  wash(g, x - 1, y - #rows + 1, rows, SCORCH)
end

---------------------------------------------------------------------------------------------------
-- house1: gable end left, long red-tiled wall right
---------------------------------------------------------------------------------------------------
local H1 = {}
do
  local g, l = copy(VILLAGE, "house1")
  local ORIG = g:clone(); KEEP = P.image(g.width, g.height)
  -- _1 worn: tiles slipped, the door's planks bleached by the sun, dust at the foot of the walls,
  -- the far window boarded, flowers gone over
  remap(g, { wood = "sand", sand = "wood" }, 4, 21, 7, 11)
  map(g, 21, 6, { "ppp", "bbb" }, { p = "plum", b = "bark" })
  map(g, 27, 9, { "pp", "bb" }, { p = "plum", b = "bark" })
  map(g, 14, 3, { "pp" }, { p = "plum" })
  board(g, l, 26, 19, 5, 7, nil, nil, nil, 30)
  for _, x in ipairs { 16, 25 } do map(g, x, 26, { "OOoooOO" }, { O = "ochre", o = "olive" }) end
  streak(g, 6, 17, 2)
  grime(g, 1, 28, "1122111001111222")
  grime(g, 14, 28, "21")
  grime(g, 23, 28, "12")
  grime(g, 32, 28, "2")
  wash(g, 1, 29, {
    "..............................gg",
    "..ggg........gg.......ggg.......",
  }, { g = GRIME })
  H1[1] = { g:clone(), l:clone(), KEEP:clone(), ORIG }

  -- _2 derelict: a hole through the tiles to the rafters, the glass gone, the door boarded
  local RIM = { red = "coral", bark = "red", plum = "red" }
  hole(g, 19, 6, {
    "kkkkkkk..",
    "kkkkkkkk.",
    ".kkkkkkk.",
    "..kkkkkk.",
    "....kkk..",
  }, { void = "ink", rafter = "wood", pitch = 5, phase = 1, battens = { 8 }, rim = RIM })
  smash(g, l, 5, 11, {
    "WWWWW",
    "WekkW",
    "WekkW",
    "WkkkW",
    "WkkkW",
    "WWWWS",
  })
  smash(g, l, 17, 19, {
    "WWWWW",
    "WkkeW",
    "WkkkW",
    "WkkkW",
    "WkkkW",
    "WkkkW",
    "SWWWW",
  })
  for _, x in ipairs { 16, 25 } do P.hline(g, x, 26, 7, "skin") end
  -- the door nailed shut
  P.hline(g, 3, 24, 9, "wood"); P.hline(g, 3, 25, 9, "bark")
  wash(g, 2, 17, {
    "..c",
    ".cc",
    ".c.",
    "cc.",
    "c..",
  }, { c = CRACK })
  wash(g, 22, 15, {
    "...c",
    "..cc",
    "..c.",
    ".cc.",
    "c...",
  }, { c = CRACK })
  grime(g, 1, 28, "2233221112222333")
  grime(g, 14, 28, "32")
  grime(g, 23, 28, "23")
  grime(g, 32, 28, "3")
  clearLights(l)
  H1[2] = { g:clone(), l:clone(), KEEP:clone(), ORIG }

  -- _3 scorched: the derelict hole burnt through to the sky, its rafters and batten charred; smoke
  -- has blackened the walls from the eave two thirds of the way down and poured up out of every
  -- window, so only the foot of the plaster keeps its colour
  hole(g, 17, 3, {
    ".kkkkkkkkk....",
    ".kkkkkkkkkk...",
    ".kkkkkkkkkkk..",
    ".kkkkkkkkkkkk.",
    "..kkkkkkkkkkk.",
    "..kkkkkkkkkkkk",
    "...kkkkkkkkkk.",
    "...kkkkkkkkk..",
    "....kkkkk.....",
    "......kkk.....",
  }, { void = P.CLEAR, rafter = "ink", pitch = 5, phase = 1, battens = { 8 }, rim = { red = "coral", plum = "red", bark = "red", wood = "red" } })
  wash(g, 0, 0, {
    ".....srrrrrrrrrrrrrrrrrrrrr.......",
    "......srrrrrrrrrrrrrrrrrrrrr......",
    "......srrrrrrrrrrrrqqrrrrrrr......",
    ".....rrsrrrrrrrrrrrrrrrrrrrrr.....",
    ".....rrsrrrrrrrrrrrrrrrrrrrrr.....",
    "....rrcccrrrrrrrrrrrrrrrrrrrrr....",
    "....rrcccrrrrrrrrrrrrrrrrrrrrr....",
    "...rrscccsrrrrrrrrrrrrrrrrrrrrr...",
    "...rrscxcsrrrrrrrrrrrrrrrrrrrrr...",
    "..rrsscxcssrrrrrrrrrrrrrrrrrrrrr..",
    "..rrsccxccsrrrrrrrrrrrrrrrrrrrrr..",
    ".rrsscccccssrrrrrrrrrrrrrrrrrrrrr.",
    ".rrsssssssssrrrrrrrrrrrrrrrrrrrrr.",
    "rrsssssssssssrrrrrrrrrrrrrrrrrrrrr",
    "rrsssssssssssrrrrrrrrrrrrrrrrrrrrr",
    ".sssssssssssssscccccccccccccccccc.",
    ".sssssssssssssccccccccccccccccccc.",
    ".sssssssssssssccccxxxccccccxxxccc.",
    ".sssssssssssssscccxxxccssccxxxccc.",
    ".ssssssssssssssscccxccssssccxccsc.",
    ".sss.......sssssss...ssssss...sss.",
    ".sss.......sssssss...ssssss...sss.",
    ".gss.......sgsgsss...ssgsss...ssg.",
    "..gs.......g...gss...sg.gss...sg..",
    "...g............gs...s...gs...g...",
    ".................g...g....g.......",
    ".................ggggggg.ggggggg..",
  }, SCORCH)
  -- the batten burnt through short of the far rafter
  for x = 27, 29 do P.pix(g, x, 8, nil) end
  -- the window frames and the boards over the far one smoke-stained, the door and the plinth a
  -- step darker, the flower boxes dull
  sootFrame(g, 17, 19, 5, 7); sootFrame(g, 26, 19, 5, 7)
  remap(g, { sand = "wood", wood = "bark", bark = "plum" }, 3, 20, 9, 12)
  remap(g, { stone = "grey", steel = "stone", grey = "smoke" }, 0, 29, 34, 3)
  remap(g, { wood = "bark", bark = "plum" }, 16, 27, 7, 2); remap(g, { wood = "bark", bark = "plum" }, 25, 27, 7, 2)
  embers(g, l, { { 8, 13, "red" }, { 8, 14, "rust" }, { 18, 20, "rust" }, { 18, 21, "red" },
                 { 28, 22, "yellow" }, { 29, 22, "rust" }, { 23, 13, "red" }, { 24, 13, "rust" }, { 29, 10, "rust" }, { 30, 10, "red" } })
  H1[3] = { g:clone(), l:clone(), KEEP:clone(), ORIG }
end

---------------------------------------------------------------------------------------------------
-- house2: half-timbered, slate roof, chimney behind the ridge
---------------------------------------------------------------------------------------------------
local H2 = {}
do
  local g, l = copy(VILLAGE, "house2")
  local ORIG = g:clone(); KEEP = P.image(g.width, g.height)
  local RIM = { navy = "steel", indigo = "steel" }
  -- _1 worn: the timbers of the sunlit gable end bleached a shade, two slates gone, damp under
  -- the jetty, the attic window boarded
  remap(g, { bark = "wood" }, 0, 6, 16, 14); remap(g, { bark = "wood" }, 0, 21, 16, 7)
  hole(g, 15, 9, { "kk" }, { void = "ink", rim = RIM })
  hole(g, 23, 15, { "kk" }, { void = "ink", rim = RIM })
  board(g, l, 6, 13, 5, 6, "sand", "wood")
  wash(g, 2, 26, {
    "g.........g..........gg..g",
    "ggg.....gggg......gggg..gg",
  }, { g = GRIME })
  streak(g, 4, 29, 2); streak(g, 13, 29, 3); streak(g, 27, 29, 2)
  grime(g, 2, 34, "112211001122110011221100112")
  H2[1] = { g:clone(), l:clone(), KEEP:clone(), ORIG }

  -- _2 derelict: the chimney cracked, slates gone to the rafters, glass gone, the door gone
  P.pix(g, 25, 0, nil); P.pix(g, 26, 0, nil); P.pix(g, 26, 1, nil)
  crack(g, { 23, 2, 23, 3, 22, 4, 22, 5 })
  hole(g, 16, 9, {
    "kkkkkk.",
    "kkkkkkk",
    "kkkkkkk",
    ".kkkkkk",
    ".kkkk..",
    "..kkk..",
  }, { void = "ink", rafter = "wood", pitch = 4, phase = 1, shift = 0, battens = { 11 }, rim = RIM })
  smash(g, l, 6, 22, {
    "wwwww",
    "wkkew",
    "wkkew",
    "wkkkw",
    "wkkkw",
    "Wwwww",
  })
  smash(g, l, 18, 22, { "bbb", "bkb", "bkb", "beb", "bbb" })
  board(g, l, 21, 30, 4, 4, "sand", "wood")
  P.rect(g, 7, 30, 3, 6, "ink")
  crack(g, { 14, 29, 15, 30, 15, 31, 14, 32, 14, 33 })
  crack(g, { 28, 30, 27, 31, 27, 32 })
  wash(g, 2, 21, {
    "gg.",
    "g..",
    "...",
    "...",
    "g..",
  }, { g = GRIME })
  grime(g, 2, 34, "223322112233221122332211223")
  clearLights(l)
  H2[2] = { g:clone(), l:clone(), KEEP:clone(), ORIG }

  -- _3 scorched: the roof open between charred rafters, the timbers going black from the top
  hole(g, 12, 3, {
    "....kkkkkk......",
    ".kkkkkkkkkk.....",
    ".kkkkkkkkkk.....",
    "..kkkkkkkkkk....",
    "...kkkkkkkkk....",
    "...kkkkkkkkkk...",
    "..kkkkkkkkkkkk..",
    "...kkkkkkkkkkkk.",
    "...kkkkkkkkkkkk.",
    "....kkkkkkkkkkk.",
    "....kkkkkkkkkk..",
    ".....kkkkkkkkk..",
    "......kkkkkkk...",
    "........kkk.....",
  }, { void = P.CLEAR, rafter = "ink", pitch = 4, phase = 1, shift = 0, battens = { 11 }, rim = { navy = "steel", indigo = "steel" } })
  local SLATE = { navy = "slate", indigo = "ink", steel = "grey", ink = "ink" }
  remap(g, SLATE, 0, 3, 30, 17)
  remap(g, compose(SOOT, CHAR), 21, 0, 6, 2)
  remap(g, SOOT, 22, 2, 4, 3)
  remap(g, { bark = "ink", wood = "ink", white = "stone", plum = "ink" }, 0, 3, 16, 12)
  remap(g, { white = "ice" }, 0, 15, 16, 5)
  stain(g, 20, "3322223333223322333322333322", { bark = "ink", wood = "ink", plum = "ink", white = "stone", ice = "stone" }, 1)
  sootFrame(g, 6, 13, 5, 6); sootFrame(g, 6, 22, 5, 6); sootFrame(g, 18, 22, 3, 5); sootFrame(g, 21, 30, 4, 4)
  plume(g, 6, 13, 5, "tall")
  plume(g, 6, 22, 5)
  plume(g, 18, 22, 3)
  plume(g, 21, 30, 4)
  -- with the roof in front of it gone, the whole chimney stack shows, standing alone
  remap(g, { wood = "smoke", bark = "slate" }, 22, 2, 4, 7)
  for y = 2, 17 do for x = 22, 25 do
    if not at(g, x, y) then P.pix(g, x, y, x < 24 and "smoke" or "slate") end
  end end
  embers(g, l, { { 9, 25, "red" }, { 9, 26, "rust" }, { 19, 24, "red" }, { 19, 25, "rust" },
                 { 8, 34, "rust" }, { 8, 35, "red" }, { 22, 31, "yellow" }, { 23, 31, "rust" } })
  H2[3] = { g:clone(), l:clone(), KEEP:clone(), ORIG }
end

---------------------------------------------------------------------------------------------------
-- house3: thatched cottage with an eyebrow window in the thatch
---------------------------------------------------------------------------------------------------
local H3 = {}
do
  local g, l = copy(VILLAGE, "house3")
  local ORIG = g:clone(); KEEP = P.image(g.width, g.height)
  -- _1 worn: the thatch thinning in patches, straws hanging from the eave, a window boarded, rain
  -- run down from the other's sill
  remap(g, { skin = "sand" }, 9, 1, 3, 1); remap(g, { skin = "sand" }, 4, 4, 2, 2)
  map(g, 6, 10, { "ww" }, { w = "wood" })
  map(g, 18, 4, { "ww" }, { w = "wood" })
  map(g, 22, 9, { "ww" }, { w = "bark" })
  P.pix(g, 5, 14, "ochre"); P.pix(g, 20, 14, "ochre")
  board(g, l, 18, 16, 5, 5, nil, nil, 18, 22)
  grime(g, 4, 21, "1122110")
  grime(g, 17, 21, "0112211")
  wash(g, 3, 22, { "gg......g............gg" }, { g = GRIME })
  streak(g, 8, 21, 2)
  H3[1] = { g:clone(), l:clone(), KEEP:clone(), ORIG }

  -- _2 derelict: the thatch gone dark and mossy, fallen in to the rafters, the eyebrow dark. Each
  -- slope goes down a shade and keeps its strokes: sand with ochre strokes in the sun, ochre with
  -- olive strokes and sand lights in the shade, split along a ragged line clear of the eyebrow
  local SHADE = { 15, 14, 15, 14, 13, 14, 15, 18, 18, 18, 18, 14, 15, 14 }
  for y = 0, 13 do
    remap(g, { skin = "sand" }, 0, y, SHADE[y + 1], 1)
    remap(g, { skin = "sand", sand = "ochre", ochre = "olive" }, SHADE[y + 1], y, 28 - SHADE[y + 1], 1)
  end
  map(g, 2, 9, { ".oo", "ooo" }, { o = "olive" })
  map(g, 9, 11, { "oo" }, { o = "olive" })
  map(g, 22, 5, { "mm.", "mmm" }, { m = "moss" })
  hole(g, 16, 2, {
    "kkkkk.",
    "kkkkkk",
    "kkkkkk",
    ".kkkkk",
    "...kk.",
  }, { void = "ink", rafter = "wood", pitch = 3, phase = 0, battens = { 4 }, rim = { ochre = "sand", olive = "ochre", sand = "skin", moss = "sage" } })
  P.rect(g, 12, 8, 4, 1, "ink"); P.rect(l, 0, 0, 28, 14, nil)
  smash(g, l, 6, 16, {
    "WWWWS",
    "WekkW",
    "WkkkW",
    "WkkkW",
    "WWWWW",
  })
  P.hline(g, 11, 19, 7, "sand"); P.hline(g, 11, 20, 7, "wood")
  crack(g, { 5, 15, 4, 16, 4, 17, 5, 18, 5, 19 })
  crack(g, { 23, 16, 23, 17, 22, 18 })
  grime(g, 4, 21, "2233221")
  grime(g, 17, 21, "1223322")
  -- the foot of the wall under the broken window: grime fading out toward the door
  touch(g, 4, 21, { "OOOOOOss" })
  clearLights(l)
  H3[2] = { g:clone(), l:clone(), KEEP:clone(), ORIG }

  -- _3 scorched: the thatch charred where it lies, two values still: smoke with bark strokes in
  -- the sun, bark with smoke strokes in the shade. The crown has burnt black under the ridge pole,
  -- and around the derelict hole the thatch has burnt through to the sky between the same rafters;
  -- the hips still hold the cottage's outline
  for y = 0, 13 do
    remap(g, { skin = "grey", sand = "smoke", ochre = "bark", olive = "bark", moss = "slate", sage = "smoke",
               wood = "ink", bark = "ink" }, 0, y, SHADE[y + 1], 1)
    remap(g, { skin = "grey", sand = "grey", ochre = "smoke", olive = "bark", moss = "slate", sage = "smoke",
               wood = "ink", bark = "ink" }, SHADE[y + 1], y, 28 - SHADE[y + 1], 1)
  end
  for y = 0, 12 do
    local x0, x1, p0, p1
    for x = 0, 27 do if at(g, x, y) then x0 = x0 or x; x1 = x end end
    for x = 0, 27 do if y > 0 and at(g, x, y - 1) then p0 = p0 or x; p1 = x end end
    P.rect(g, x0, y, math.max(1, (p0 or x0) - x0), 1, "ink")
    P.rect(g, math.min(x1, (p1 or x1) + 1), y, math.max(1, x1 - (p1 or x1)), 1, "ink")
  end
  P.hline(g, 7, 0, 14, "slate"); P.hline(g, 7, 1, 14, "ink")
  wash(g, 4, 2, {
    "cccxcccc.....cccxcc.",
    ".cc.ccxcc.....ccc...",
    "..c...cc.........c..",
  }, { c = { smoke = "slate", bark = "ink", grey = "smoke" }, x = { smoke = "ink", bark = "ink", grey = "slate" } })
  hole(g, 14, 2, {
    "..kkkkk..",
    ".kkkkkkk.",
    ".kkkkkkkk",
    "..kkkkkkk",
    "..kkkkkk.",
    "....kkkk.",
    ".....kk..",
  }, { void = P.CLEAR, rafter = "ink", pitch = 3, phase = 0, battens = { 4 }, rim = { smoke = "grey", bark = "smoke", ink = "slate", slate = "smoke" } })
  wash(g, 3, 14, {
    "sscccssscccccccsscccss",
    ".sssccsssccsssccsscss.",
  }, SCORCH)
  remap(g, SOOT, 6, 16, 5, 5); remap(g, SOOT, 17, 16, 7, 5)
  plume(g, 6, 16, 5)
  plume(g, 18, 16, 5)
  remap(g, SOOT, 11, 19, 7, 2)
  embers(g, l, { { 9, 18, "red" }, { 9, 19, "rust" }, { 20, 18, "rust" }, { 21, 18, "red" },
                 { 13, 8, "rust" }, { 14, 8, "red" }, { 15, 9, "yellow" }, { 16, 9, "rust" }, { 6, 4, "red" }, { 7, 4, "rust" } })
  H3[3] = { g:clone(), l:clone(), KEEP:clone(), ORIG }
end

---------------------------------------------------------------------------------------------------
-- house4: tall brick townhouse with a crow-stepped gable and a shop below
---------------------------------------------------------------------------------------------------
local H4 = {}
do
  local g, l = copy(VILLAGE, "house4")
  local ORIG = g:clone(); KEEP = P.image(g.width, g.height)
  local BRICKCRACK = { wood = "plum", bark = "plum" }
  -- _1 worn: the awning sun-bleached, copings chipped, an upper window boarded, rain run down
  -- the brick from a sill
  remap(g, { red = "coral", plum = "red" }, 10, 30, 12, 3)
  P.pix(g, 16, 4, "wood"); P.pix(g, 17, 4, "wood")
  P.pix(g, 3, 8, "wood"); P.pix(g, 4, 8, "wood")
  board(g, l, 3, 14, 5, 6, "sand", "wood")
  grime(g, 0, 38, "1100000011100000000000110")
  wash(g, 8, 37, { "gg", "gg" }, { g = GRIME })
  streak(g, 18, 27, 2)
  H4[1] = { g:clone(), l:clone(), KEEP:clone(), ORIG }

  -- _2 derelict: the top step crumbling, the awning in tatters, the shop window smashed
  P.rect(g, 12, 0, 3, 1, nil); P.pix(g, 14, 1, nil)
  P.pix(g, 12, 1, "sand"); P.pix(g, 13, 1, "sand")
  smash(g, l, 10, 5, { "WWWW", "WeeW", "WkeW", "WkkW", "WWWW" })
  smash(g, l, 16, 14, {
    "WWWWW",
    "WekkW",
    "WekkW",
    "WkkkW",
    "WkkkW",
    "WWWWw",
  })
  board(g, l, 3, 21, 5, 6, "sand", "wood")
  smash(g, l, 16, 21, {
    "wWWWW",
    "WkkeW",
    "WkkkW",
    "WkkkW",
    "WkkkW",
    "WWWWW",
  })
  smash(g, l, 11, 33, {
    "SSSSSSSSSS",
    "SeeekSkeeS",
    "SekkkkkkeS",
    "SkkkkSkkkS",
    "SkkkkSkkkS",
    "SSSSSSSSSS",
  })
  -- the awning: stripes torn short or hanging loose over the window
  P.rect(g, 10, 30, 12, 3, "teal")
  map(g, 10, 30, {
    "WWCCWWCCWWCC",
    "WWCCttCCWWCt",
    "IIrrtt.rWWrt",
    "II...t.rII..",
    "I.......I...",
  }, { W = "white", I = "ice", C = "coral", r = "red", t = "teal" })
  P.hline(g, 2, 34, 7, "sand"); P.hline(g, 2, 35, 7, "wood")
  wash(g, 0, 29, {
    "......................",
    "aa..................a.",
    "aw..................aa",
    "....................a.",
    "......................",
    "........aa............",
    "........aw............",
  }, { a = { teal = "sage", moss = "olive" }, w = { teal = "wood", moss = "bark" } })
  crack(g, { 15, 20, 14, 21, 14, 22, 13, 23 }, BRICKCRACK)
  crack(g, { 9, 9, 8, 10, 8, 11 }, BRICKCRACK)
  grime(g, 0, 38, "2211000022200000000000221")
  clearLights(l)
  H4[2] = { g:clone(), l:clone(), KEEP:clone(), ORIG }

  -- _3 scorched: soot pouring up the brick from every window, the awning burnt to rags
  P.rect(g, 9, 0, 3, 1, nil); P.pix(g, 9, 1, nil)
  P.pix(g, 6, 4, nil); P.pix(g, 7, 4, nil)
  stain(g, 0, "000000000444444000000000", compose(SOOT, CHAR))
  stain(g, 0, "dddddddddddddddddddddddd", SOOT)
  band(g, 13, "110022110011001100221100", SOOT)
  for _, w in ipairs { { 3, 14, 5, 6 }, { 16, 14, 5, 6 }, { 3, 21, 5, 6 }, { 16, 21, 5, 6 } } do sootFrame(g, w[1], w[2], w[3], w[4]) end
  for _, w in ipairs { { 10, 5, 4, "short" }, { 3, 14, 5, "tall" }, { 16, 14, 5, "tall" }, { 3, 21, 5 }, { 16, 21, 5 } } do
    plume(g, w[1], w[2], w[3], w[4])
  end
  map(g, 10, 30, {
    "kkSSkkSSkkSS",
    "kkSSttSSkkSt",
    "SStttt.SkkSt",
    "S....t.S....",
    "............",
  }, { k = "ink", S = "slate", t = "teal" })
  remap(g, SOOT, 0, 28, 24, 3)
  plume(g, 11, 33, 10)
  remap(g, SOOT, 2, 34, 7, 2)
  -- the smoke has stained the top of the shop front too, and sooted the green plinth below it:
  -- slate where it was painted, ink where grime had already darkened it (its foot, and a ragged
  -- edge under the stain); the door has gone a shade darker
  band(g, 31, "33" .. "222222" .. "3333333333333333", SOOT)
  band(g, 34, "21" .. "000000" .. "121" .. "0000000000" .. "121", GRIME)
  remap(g, { teal = SOOT.teal, moss = compose(SOOT, CHAR).moss }, 0, 34, 24, 6)
  remap(g, { wood = "bark", bark = "plum" }, 2, 36, 6, 4)
  -- the shop window's lintel blackened in two tongues under the plume, its mullion stub sooted with
  -- it, the last rag of awning over the glass gone
  touch(g, 11, 33, { "MMLLMMMLLM", ".....T.ee." })
  embers(g, l, { { 11, 6, "red" }, { 11, 7, "rust" }, { 19, 18, "rust" }, { 19, 17, "red" }, { 17, 24, "red" }, { 17, 25, "rust" },
                 { 13, 37, "rust" }, { 14, 37, "yellow" }, { 18, 37, "red" }, { 19, 37, "rust" } })
  H4[3] = { g:clone(), l:clone(), KEEP:clone(), ORIG }
end

---------------------------------------------------------------------------------------------------
-- house5: long farmhouse, shingled roof with a ridge ventilator, barn door at the far end
---------------------------------------------------------------------------------------------------
local H5 = {}
do
  local g, l = copy(VILLAGE, "house5")
  local ORIG = g:clone(); KEEP = P.image(g.width, g.height)
  local RIM = { wood = "sand", bark = "wood", plum = "wood" }
  local SHUTTERS = { { 3, 18 }, { 10, 18 }, { 13, 18 }, { 20, 18 } }
  -- _1 worn: shingles lost, the shutters sun-bleached, the gable window boarded
  hole(g, 17, 7, { "kk" }, { void = "ink", rim = RIM })
  hole(g, 29, 10, { "kk" }, { void = "ink", rim = RIM })
  for _, sh in ipairs(SHUTTERS) do remap(g, { red = "coral", plum = "red" }, sh[1], sh[2], 2, 6) end
  -- the gable window is as wide as the gable at its head, so a level plank would run into the
  -- verges: one board is nailed corner to corner instead
  P.rect(l, 4, 9, 4, 5, nil); P.rect(g, 5, 10, 2, 3, "ink")
  touch(g, 4, 9, { "ww..", "bww.", ".bww", "..bw", "...b" })
  streak(g, 5, 14, 2)
  grime(g, 2, 24, "1122110011")
  grime(g, 13, 24, "011221100")
  wash(g, 1, 25, { "..g........gg.......", "gggg......gggg....gg" }, { g = GRIME })
  H5[1] = { g:clone(), l:clone(), KEEP:clone(), ORIG }

  -- _2 derelict: the ventilator broken, the shingles fallen in, a shutter gone, a barn board out
  P.rect(g, 24, 0, 4, 1, nil); P.rect(g, 22, 2, 3, 1, "ink")
  hole(g, 25, 6, {
    "kkkkkkk.",
    "kkkkkkkk",
    "kkkkkkkk",
    "kkkkkkk.",
    ".kkkk...",
    ".kkk....",
  }, { void = "ink", rafter = "sand", pitch = 4, phase = 3, shift = 0, battens = { 8 }, rim = RIM })
  smash(g, l, 5, 18, {
    "SWWWW",
    "WkkeW",
    "WkkeW",
    "WkkkW",
    "WkkkW",
    "WWWWW",
  })
  board(g, l, 15, 18, 5, 6)
  P.rect(g, 20, 18, 2, 6, "skin")
  P.rect(g, 31, 18, 2, 9, "ink")
  crack(g, { 8, 14, 7, 15, 7, 16, 8, 17 })
  crack(g, { 2, 18, 2, 19, 3, 20 })
  grime(g, 2, 24, "2233221122")
  grime(g, 13, 24, "122332211")
  clearLights(l)
  H5[2] = { g:clone(), l:clone(), KEEP:clone(), ORIG }

  -- _3 scorched: the shingles burnt off the rafters, soot along the eave and up the gable
  hole(g, 14, 4, {
    ".....kkkkkkkkkkkk.....",
    "....kkkkkkkkkkkkkkk...",
    "....kkkkkkkkkkkkkkkk..",
    ".....kkkkkkkkkkkkkkkk.",
    ".....kkkkkkkkkkkkkkkk.",
    "......kkkkkkkkkkkkkkk.",
    "......kkkkkkkkkkkkkk..",
    ".......kkkkkkkkkkkk...",
    "........kkkkkkkkk.....",
  }, { void = P.CLEAR, rafter = "ink", pitch = 4, phase = 3, shift = 0, battens = { 8 }, rim = RIM })
  -- the shingles and both verges charred; the gable's plaster left to the scorch map
  local SHINGLE = { wood = "bark", sand = "wood", bark = "plum", plum = "ink" }
  for y = 3, 15 do
    local lx, rx = 6 - (y - 2) // 2, 6 + (y - 2) // 2
    remap(g, SHINGLE, rx - 1, y, 38, 1)
    remap(g, SHINGLE, lx, y, 2, 1)
  end
  remap(g, compose(SOOT, CHAR), 19, 0, 9, 3)
  wash(g, 0, 6, {
    "......x...............................",
    "......x...............................",
    ".....cxc..............................",
    "....cxxc..............................",
    "...ssssss.............................",
    "...ssssss.............................",
    "...ss..ss.............................",
    "...ssssss.............................",
    "....s..s..............................",
    "......................................",
    "...ssccxcss.scccxxcccc...cccccccccccc.",
    "....ssccs...sssccxcss...sss.ssccss.ss.",
    "...ssscccsss.ssscccss.....ssscs..ss...",
    "...sssssssss.ssssssss......sss...s....",
    "...sssssssss.ssssssss.......s.........",
    "...sssssssss.ssssssss.................",
    "...sssssssss.ssssssss.................",
    "...sssssssss.ssssssss.................",
  }, SCORCH)
  -- the board over the gable window charred with it: smoke on top, slate underneath
  touch(g, 4, 9, { "MMLL", "LMMT", "TLMM", "TkLM", "TTTL" })
  -- the gable end sooted down its whole height and the barn door from the top, the plinth a shade
  -- darker: only the foot of the walls keeps its colour
  band(g, 12, "bbaabbaabbab" .. "bbbbbbbbbb" .. "999aa9998aa999a" .. "0",
       { skin = "stone", sand = "grey", white = "stone", red = "plum", coral = "red", wood = "smoke" })
  remap(g, { stone = "grey", steel = "stone", grey = "smoke" }, 0, 25, 22, 3)
  embers(g, l, { { 8, 21, "red" }, { 8, 22, "rust" }, { 17, 21, "yellow" }, { 18, 21, "rust" }, { 5, 12, "rust" },
                 { 31, 24, "rust" }, { 31, 25, "red" }, { 32, 22, "red" }, { 32, 23, "rust" }, { 25, 13, "rust" }, { 26, 13, "red" } })
  H5[3] = { g:clone(), l:clone(), KEEP:clone(), ORIG }
end

---------------------------------------------------------------------------------------------------
-- church: steeple left, slate-roofed nave right
---------------------------------------------------------------------------------------------------
local CH = {}
do
  local g, l = copy(VILLAGE, "church")
  local ORIG = g:clone(); KEEP = P.image(g.width, g.height)
  local RIM = { navy = "steel", indigo = "steel" }
  -- _1 worn: the door's planks bleached by the sun, slates lost from the nave, the far lancet
  -- boarded, damp under the rose window
  remap(g, { wood = "sand", sand = "wood" }, 6, 54, 6, 6)
  hole(g, 19, 37, { "kk" }, { void = "ink", rim = RIM })
  hole(g, 27, 40, { "kk" }, { void = "ink", rim = RIM })
  P.rect(l, 29, 48, 4, 10, nil); P.rect(g, 30, 49, 2, 8, "ink")
  P.hline(g, 28, 51, 5, "sand"); P.hline(g, 28, 52, 5, "wood")
  P.hline(g, 29, 54, 5, "sand"); P.hline(g, 29, 55, 5, "wood")
  touch(g, 29, 53, { "T..T" })
  streak(g, 5, 50, 2)
  grime(g, 2, 58, "1122111")
  grime(g, 16, 58, "11221100112211001122")
  CH[1] = { g:clone(), l:clone(), KEEP:clone(), ORIG }

  -- _2 derelict: the cross knocked askew, the nave open to its rafters, the glass gone
  P.rect(g, 5, 0, 8, 9, nil)
  map(g, 5, 0, {
    ".....wb.",
    ".....wb.",
    "....wbww",
    ".wwwwbbb",
    ".bbbwb..",
    "...wb...",
    "...wb...",
    "...wb...",
    "...wb...",
  }, { w = "wood", b = "bark" })
  hole(g, 20, 36, {
    "kkkkkkkkk.",
    "kkkkkkkkkk",
    "kkkkkkkkkk",
    "kkkkkkkk..",
    "..kkkkkk..",
    "..kkk.....",
  }, { void = "ink", rafter = "wood", pitch = 4, phase = 0, battens = { 38 }, rim = RIM })
  remap(g, { purple = "ink", navy = "ink" }, 4, 40, 10, 10)
  remap(g, { indigo = "ink" }, 9, 45, 4, 4)
  P.pix(g, 7, 42, "purple"); P.pix(g, 8, 42, "purple")
  P.rect(l, 4, 40, 10, 10, nil)
  smash(g, l, 21, 49, { "TuuT", "TukT", "TkkT", "TkkT", "TkkT", "TkkT", "TkkT", "TkeT" }); P.rect(l, 21, 48, 4, 10, nil)
  P.hline(g, 5, 55, 8, "wood"); P.hline(g, 5, 56, 8, "bark")
  crack(g, { 13, 37, 14, 38, 14, 39, 13, 40 })
  crack(g, { 3, 31, 3, 32, 4, 33, 4, 34 })
  crack(g, { 33, 48, 33, 49, 34, 50 })
  grime(g, 2, 58, "2233222")
  grime(g, 16, 58, "22332211223322112233")
  clearLights(l)
  CH[2] = { g:clone(), l:clone(), KEEP:clone(), ORIG }

  -- _3 scorched: the spire blackened, the nave roof burnt to its rafters, soot from every opening
  P.rect(g, 5, 0, 8, 9, nil)
  map(g, 5, 0, {
    ".....Sk.",
    ".....Sk.",
    "....Sk..",
    ".SSSSk..",
    ".kkkSk..",
    "...Sk...",
    "...Sk...",
    "...Sk...",
    "...Sk...",
  }, { k = "ink", S = "slate" })
  hole(g, 16, 34, {
    "...kkkkkkkk.....",
    "..kkkkkkkkkkk...",
    ".kkkkkkkkkkkkk..",
    ".kkkkkkkkkkkkkk.",
    "..kkkkkkkkkkkkk.",
    "..kkkkkkkkkkkkkk",
    "...kkkkkkkkkkkk.",
    "....kkkkkkkkkk..",
    ".....kkkkkkk....",
  }, { void = P.CLEAR, rafter = "ink", pitch = 4, phase = 0, battens = { 38 }, rim = RIM })
  remap(g, { navy = "slate", indigo = "ink", steel = "grey" }, 16, 33, 20, 13)
  remap(g, { steel = "grey", indigo = "ink", navy = "slate", ice = "stone" }, 0, 9, 16, 17)
  remap(g, compose(SOOT, CHAR), 0, 9, 16, 7)
  stain(g, 26, "0445566554455665", SOOT)
  plume(g, 5, 30, 3, "tall"); plume(g, 10, 30, 3, "tall")
  plume(g, 4, 40, 10)
  sootFrame(g, 21, 48, 4, 10); sootFrame(g, 29, 48, 4, 10)
  plume(g, 21, 48, 4); plume(g, 29, 48, 4)
  remap(g, SOOT, 5, 55, 8, 2)
  plume(g, 6, 53, 5)
  -- the tower below the belfry and the nave wall a step further, from the top down to a ragged
  -- line a few rows above the ground, and the door a shade darker
  band(g, 31, "mnonmnonmnommnon", SOOT)
  band(g, 46, "989a89a98a98a9a989a9", SOOT, 16)
  remap(g, { sand = "wood", wood = "bark", bark = "plum" }, 5, 53, 8, 7)
  embers(g, l, { { 8, 44, "yellow" }, { 9, 44, "rust" }, { 22, 56, "red" }, { 23, 56, "rust" }, { 30, 53, "rust" }, { 31, 53, "red" },
                 { 5, 36, "rust" }, { 6, 36, "red" }, { 11, 36, "red" }, { 12, 36, "rust" } })
  CH[3] = { g:clone(), l:clone(), KEEP:clone(), ORIG }
end

---------------------------------------------------------------------------------------------------
-- windmill: the tower and its cap; the sails are their own sprites
---------------------------------------------------------------------------------------------------
local WM = {}
do
  local g, l = copy(VILLAGE, "windmill")
  local ORIG = g:clone(); KEEP = P.image(g.width, g.height)
  local RIM = { navy = "steel", indigo = "steel" }
  -- _1 worn: the cap's paint faded on its sunlit side, two slates off it (one high on the left,
  -- one low on the right), a gallery post gone, the lower window boarded
  remap(g, { steel = "ice" }, 4, 1, 4, 6)
  hole(g, 6, 2, { "kk" }, { void = "ink", rim = RIM })
  hole(g, 14, 4, { "k", "k" }, { void = "ink", rim = RIM })
  P.rect(g, 20, 26, 1, 2, nil)
  board(g, l, 9, 27, 4, 5)
  streak(g, 10, 19, 2)
  grime(g, 2, 41, "122110")
  grime(g, 14, 41, "011221")
  WM[1] = { g:clone(), l:clone(), KEEP:clone(), ORIG }

  -- _2 derelict: the cap holed, the gallery snapped and hanging, the door gone
  hole(g, 6, 2, {
    "kkkkk",
    "kkkkk",
    "kkkkk",
    "kkkk.",
    ".kk..",
  }, { void = "ink", rafter = "wood", pitch = 3, phase = 1, rise = 0, battens = { 4 }, rim = RIM })
  P.rect(g, 0, 24, 4, 2, nil); P.rect(g, 1, 26, 1, 2, nil)
  map(g, 0, 25, {
    "...wb",
    "..wb.",
    ".wb..",
    ".b...",
  }, { w = "wood", b = "bark" })
  smash(g, l, 9, 13, { "wwww", "weew", "wekw", "wkkw", "wkkw", "wwww" })
  P.rect(g, 9, 34, 4, 8, "ink")
  map(g, 4, 19, { "sss.", "wbww", "wwbw", ".ss." }, { s = "sand", w = "wood", b = "bark" })
  crack(g, { 14, 9, 15, 10, 15, 11, 14, 12 })
  crack(g, { 6, 29, 5, 30, 5, 31, 6, 32 })
  grime(g, 2, 41, "233221")
  grime(g, 14, 41, "122332")
  clearLights(l)
  WM[2] = { g:clone(), l:clone(), KEEP:clone(), ORIG }

  -- _3 scorched: the cap charred black, burnt through to the sky around the derelict hole between
  -- the same ribs; soot from under the cap down past the gallery on both faces of the tower
  remap(g, { navy = "slate", indigo = "ink", steel = "grey", ice = "grey", wood = "ink" }, 0, 0, 22, 7)
  hole(g, 6, 2, {
    "kkkkkkkk.",
    "kkkkkkkkk",
    "kkkkkkkkk",
    ".kkkkkk..",
  }, { void = P.CLEAR, rafter = "ink", pitch = 3, phase = 1, rise = 0, battens = { 4 }, rim = { slate = "grey", ink = "slate" } })
  local reach = "kk" .. "ts" .. "tutstsuttsutst" .. "st" .. "kk"
  band(g, 8, reach, SOOT)
  -- and a row of grime under the stain's ragged edge on the lower tower, so it fades out
  for i = 3, #reach - 2 do remapAt(g, GRIME, i - 1, 8 + tonumber(reach:sub(i, i), 36)) end
  sootFrame(g, 9, 13, 4, 6); sootFrame(g, 9, 27, 4, 5)
  -- smoke from the burning cap has blackened the top of the tower, and the window's plume meets it
  wash(g, 0, 8, {
    ".....cccxxcccxccc.....",
    ".....scccccxccccs.....",
    ".....sscsccccscss.....",
    "......ss.scccs.s......",
    ".........scxcs........",
    "........sccccs........",
  }, SCORCH)
  plume(g, 9, 27, 4)
  plume(g, 9, 33, 4, "tall")
  embers(g, l, { { 11, 16, "red" }, { 11, 17, "rust" }, { 10, 30, "rust" }, { 11, 30, "red" },
                 { 10, 40, "rust" }, { 11, 40, "yellow" }, { 10, 41, "red" }, { 11, 41, "rust" } })
  WM[3] = { g:clone(), l:clone(), KEEP:clone(), ORIG }
end

---------------------------------------------------------------------------------------------------
-- Sails, rasterised exactly as village.lua's: one sail in its frame's own whole-pixel direction,
-- stamped by quarter turns. Here each quarter q is stamped through `keep(q, part, u, v, rung)`, so
-- damage can be laid on in the sail's own terms: `part` is stock, bar or rung, u and v are pixels
-- along and across the sail from the hub, `rung` counts from the hub out. Damage that is the same
-- for every quarter keeps the strip four-fold symmetric, and so it loops exactly as the sails do.
---------------------------------------------------------------------------------------------------
local SAIL_FRAMES = { { 1, 0, 4 }, { 1, 2, 10 }, { 1, 1, 6 }, { 2, 1, 10 } }
local function sailsFrame(g, frame, keep, hub)
  local a, b, step = frame[1], frame[2], frame[3]
  local n = math.sqrt(a * a + b * b)
  local U0 = math.floor(6.2 * n / step) * step + 0.5
  local rungs = {}
  for U = U0, 20 * n, step do rungs[#rungs + 1] = U end
  local Ulast = rungs[#rungs]
  local V0 = math.floor(5.6 * n) + 0.5
  for y = 0, 39 do for x = 0, 39 do
    local px, py = x - 19.5, y - 19.5
    local U, V = a * px + b * py, -b * px + a * py
    local c, part, rung
    if U > 0 and U <= 20 * n and math.abs(V) < n then c, part = "bark", "stock"
    elseif U >= U0 - n / 2 and U < Ulast + n / 2 and math.abs(V - V0) < n / 2 then c, part = "bark", "bar"
    elseif V > 0 and V < V0 then
      for i, r in ipairs(rungs) do
        if math.abs(U - r) < n / 2 then c, part, rung = "wood", "rung", i end
      end
    end
    if c then
      local rx, ry = x, y
      for q = 0, 3 do
        local k, col = true, nil
        if keep then k, col = keep(q, part, U / n, V / n, rung) end
        if k then P.pix(g, rx, ry, col or c) end
        rx, ry = 39 - ry, rx
      end
    end
  end end
  if hub then hub(g) else P.rect(g, 18, 18, 4, 4, "bark"); P.rect(g, 19, 19, 2, 2, "sand") end
end

-- The same images village.lua makes: proof that the rasteriser here is the one there.
do
  for f = 0, 3 do
    local mine, theirs = P.image(40, 40), copy(VILLAGE, "sails", f)
    sailsFrame(mine, SAIL_FRAMES[f + 1])
    for y = 0, 39 do for x = 0, 39 do
      if mine:getPixel(x, y) ~= theirs:getPixel(x, y) then error("sails frame " .. f .. " differs at " .. x .. "," .. y) end
    end end
  end
end

-- Worn: the third rung gone from every sail, the second snapped short, the outer bar broken off
-- past the third. The same in all four, so the quarter turn still closes the loop.
local function wornSail(q, part, u, v, rung)
  if part == "rung" and rung == 3 then return false end
  if part == "rung" and rung == 2 and v > 3 then return false end
  if part == "bar" and u > 14.5 and u < 16 then return false end
  return true
end

-- Derelict: stopped, in the X. The two upper sails are left whole, the lower right one is
-- snapped off near the hub and the lower left one is gone to a stub. (In the (1, 1) frame quarter
-- 0 points down-right, 1 down-left, 2 up-left, 3 up-right.)
local function brokenSail(q, part, u, v, rung)
  if q == 2 or q == 3 then return wornSail(q, part, u, v, rung) end
  if q == 0 then
    if part == "stock" then return u <= 9 + (v > 0 and 1 or 0) end
    if part == "rung" then return rung == 1 and v <= 4 end
    return u <= 7
  end
  return part == "stock" and u <= 3.5
end

-- Scorched: the stocks burnt to stumps, black with a smoke-grey lit edge, one rung end left. The
-- lit edge is found afterwards, in the picture: the village is lit from the left, so it is each
-- stump's left-hand pixel on every row, whichever way the stump points.
local STUMPS = { [0] = 6, [1] = 3.5, [2] = 9, [3] = 12 }
local function charredSail(q, part, u, v, rung)
  if part == "stock" then return u <= STUMPS[q] + (v > 0 and 1 or 0), "ink" end
  if part == "rung" then return q == 3 and rung == 1 and v <= 3, "slate" end
  return false
end
local function litFromLeft(g)
  local ink = P.hex("ink")
  for y = 0, g.height - 1 do for x = g.width - 1, 0, -1 do
    local hub = x >= 18 and x <= 21 and y >= 18 and y <= 21
    if not hub and g:getPixel(x, y) == ink and (x == 0 or app.pixelColor.rgbaA(g:getPixel(x - 1, y)) == 0) then
      P.pix(g, x, y, "smoke")
    end
  end end
end
local function charredHub(g) P.rect(g, 18, 18, 4, 4, "ink"); P.rect(g, 19, 19, 2, 2, "smoke") end

local SAILS = { [1] = {}, [2] = {}, [3] = {} }
for f = 0, 3 do
  local g = P.image(40, 40); sailsFrame(g, SAIL_FRAMES[f + 1], wornSail); SAILS[1][f] = g
end
SAILS[2][0] = P.image(40, 40); sailsFrame(SAILS[2][0], SAIL_FRAMES[3], brokenSail)
SAILS[3][0] = P.image(40, 40); sailsFrame(SAILS[3][0], SAIL_FRAMES[3], charredSail, function() end)
litFromLeft(SAILS[3][0]); charredHub(SAILS[3][0])
-- the lower left stock burnt off at the hub: a stub two pixels thick, lit on its left
P.pix(SAILS[3][0], 18, 22, nil)
P.map(SAILS[3][0], 15, 21, { "..M", ".Mk", "Mk." }, { M = "smoke", k = "ink" })

---------------------------------------------------------------------------------------------------
-- lamp: the street lamp gone dead, its glass cracked and dark
---------------------------------------------------------------------------------------------------
local LAMP2
do
  local g = copy(VILLAGE, "lamp")
  map(g, 2, 3, { "SS", "eS", "Se", "00" }, { S = "slate", e = "steel", ["0"] = "black" })
  LAMP2 = g
end

---------------------------------------------------------------------------------------------------
-- Sheet
---------------------------------------------------------------------------------------------------
local STEP = { "worn", "derelict", "scorched" }
for _, b in ipairs {
  { "house1", 34, 32, H1 }, { "house2", 30, 36, H2 }, { "house3", 28, 24, H3 }, { "house4", 24, 40, H4 },
  { "house5", 38, 28, H5 }, { "church", 36, 60, CH }, { "windmill", 22, 42, WM },
} do
  for k = 1, 3 do
    local note = b[1] .. ", " .. STEP[k] .. (b[1] == "windmill" and "; hub at 11,4 for the sails" or "")
    sprite(b[1] .. "_" .. k, b[2], b[3], 1, note, function() return table.unpack(b[4][k]) end)
  end
end
sprite("sails_1", 40, 40, 4, "centre 20,20; worn lattice, the same quarter-turn loop as sails", function(f) return SAILS[1][f], P.image(40, 40) end)
sprite("sails_2", 40, 40, 1, "centre 20,20; stopped: two sails, a snapped one, a stub", function() return SAILS[2][0], P.image(40, 40) end)
sprite("sails_3", 40, 40, 1, "centre 20,20; charred stumps", function() return SAILS[3][0], P.image(40, 40) end)
sprite("lamp_2", 6, 22, 1, "dead, no light", function() return LAMP2, P.image(6, 22) end)

P.save(S, ART, 3)

---------------------------------------------------------------------------------------------------
-- Previews. worn-stages.png: each building through its steps into the ruin that follows it,
-- untinted over the day sky, then multiplied by each step's light over the evening sky with its
-- lights on top. worn-mill.png: the windmill at each step with its sails on the hub, the same way.
---------------------------------------------------------------------------------------------------
local pc = app.pixelColor
local mine = {}
for _, e in ipairs(S.sprites) do mine[e.name] = e end
-- One frame of any sprite by name: this sheet's, the village's or hell's.
local function frameOf(name, f)
  local e = mine[name]
  if not e then return copy(VILLAGE.sprites[name] and VILLAGE or HELL, name, f) end
  local g, l = P.image(e.w, e.h), P.image(e.w, e.h)
  P.blit(g, S.base, 0, 0, e.x + (f or 0) * e.w, e.y, e.w, e.h)
  P.blit(l, S.lights, 0, 0, e.x + (f or 0) * e.w, e.y, e.w, e.h)
  return g, l
end
local function multiply(c, t)
  local tr, tg, tb = tonumber(t:sub(2, 3), 16), tonumber(t:sub(4, 5), 16), tonumber(t:sub(6, 7), 16)
  return pc.rgba(pc.rgbaR(c) * tr // 255, pc.rgbaG(c) * tg // 255, pc.rgbaB(c) * tb // 255, 255)
end
-- A sprite at x, y on the day half of `out` as it is, and `dy` lower, on the evening half, in light t.
local function place(out, g, l, x, y, dy, t)
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
local function canvas(w, h)
  local out = P.image(w, h * 2)
  P.rect(out, 0, 0, w, h, "#72EAD0"); P.rect(out, 0, h, w, h, "#E2793C")
  return out
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

-- Each row lists { name, frame, light }; the light defaults to the step the column stands for.
local LIGHTS = { "#FFFFFF", "#D49989", "#AA5E66", "#B15C60", "#C35855" }
local function stages(path, rows, zoom)
  local cellW, gap, cols = 40, 4, 0
  local heights, total = {}, gap
  for r, row in ipairs(rows) do
    local h = 0
    for _, c in ipairs(row) do h = math.max(h, (frameOf(c[1], c[2])).height) end
    heights[r] = h; total = total + h + gap
    cols = math.max(cols, #row)
  end
  local out = canvas(gap + cols * (cellW + gap), total)
  local y = gap
  for r, row in ipairs(rows) do
    for k, c in ipairs(row) do
      local g, l = frameOf(c[1], c[2])
      place(out, g, l, gap + (k - 1) * (cellW + gap) + (cellW - g.width) // 2, y + heights[r] - g.height, total,
        c[3] or LIGHTS[(k - 1) % #LIGHTS + 1])
    end
    y = y + heights[r] + gap
  end
  write(out, zoom, path)
end

stages(ART .. "/worn-stages.png", {
  { { "house1" }, { "house1_1" }, { "house1_2" }, { "house1_3" }, { "ruin1" } },
  { { "house2" }, { "house2_1" }, { "house2_2" }, { "house2_3" }, { "ruin2" } },
  { { "house3" }, { "house3_1" }, { "house3_2" }, { "house3_3" }, { "ruin1" } },
  { { "house4" }, { "house4_1" }, { "house4_2" }, { "house4_3" }, { "ruin2" } },
  { { "house5" }, { "house5_1" }, { "house5_2" }, { "house5_3" }, { "ruin1" } },
  { { "church" }, { "church_1" }, { "church_2" }, { "church_3" }, { "ruin1" } },
  { { "windmill" }, { "windmill_1" }, { "windmill_2" }, { "windmill_3" }, { "ruin2" } },
  { { "sails" }, { "sails_1" }, { "sails_2" }, { "sails_3" }, { "lamp", 0, "#FFFFFF" }, { "lamp_2", 0, "#AA5E66" } },
}, 3)
-- While drawing, CLOSE = { { name, frame, light }, ... } gives one row at a closer zoom.
if rawget(_G, "CLOSE") then stages(ART .. "/worn-close.png", { CLOSE }, 14) end

do
  local W, H = 4 + 4 * 44, 66
  local out = canvas(W, H)
  local steps = { { "windmill", "sails" }, { "windmill_1", "sails_1" }, { "windmill_2", "sails_2" }, { "windmill_3", "sails_3" } }
  for k, st in ipairs(steps) do
    local x, y = 4 + (k - 1) * 44 + 9, 4 + 16
    local tg, tl = frameOf(st[1]); local sg, sl = frameOf(st[2])
    place(out, tg, tl, x, y, H, LIGHTS[k])
    place(out, sg, sl, x - 9, y - 16, H, LIGHTS[k])
  end
  write(out, 6, ART .. "/worn-mill.png")
end
