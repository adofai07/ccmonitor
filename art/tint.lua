-- tint.lua: new colourways of the village's five houses, so the same shapes do not always come in
-- the same colours. Each is made from the finished art, the village house and its three worn
-- stages from worn.lua, by recolouring every pixel through a map chosen by the material it lies
-- on. The material comes from where the pixel sits on the original house (roof, wall, timbers,
-- door...), so one map serves all four stages, and a faded, grimed or sooted pixel of the old
-- colour becomes the same step down the new colour's ramp. What a stage nailed or built over the
-- house (planks, rafters) keeps its own colours. Lights are copied as they are.
local P = dofile(ART .. "/px.lua")
local S = P.sheet("tint", 512, 320)
-- While drawing, AUDIT = {} gathers the colours each material's map left as they were.
local AUDIT = rawget(_G, "AUDIT")
local pc = app.pixelColor

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
local VILLAGE, WORN, GROUND = family("village"), family("worn"), family("ground")

-- One frame of a finished sprite, base and lights, as fresh images.
local function copy(name, f)
  local fam = VILLAGE.sprites[name] and VILLAGE or WORN.sprites[name] and WORN or GROUND
  local s = assert(fam.sprites[name], "no sprite " .. name)
  local g, l = P.image(s.w, s.h), P.image(s.w, s.h)
  P.blit(g, fam.base, 0, 0, s.x + (f or 0) * s.w, s.y, s.w, s.h)
  P.blit(l, fam.lights, 0, 0, s.x + (f or 0) * s.w, s.y, s.w, s.h)
  return g, l
end

-- The palette name at x, y, or nil where the sprite is clear.
local function at(g, x, y)
  if x < 0 or y < 0 or x >= g.width or y >= g.height then return nil end
  local c = g:getPixel(x, y)
  if pc.rgbaA(c) == 0 then return nil end
  return NAME[c] or "?"
end

local function set(list) local s = {} for _, k in ipairs(list) do s[k] = true end return s end
-- A map with more entries laid over it.
local function with(a, b)
  local r = {}
  for k, v in pairs(a or {}) do r[k] = v end
  for k, v in pairs(b or {}) do r[k] = v end
  return r
end
-- A map without one entry.
local function except(a, key) local r = with(a) r[key] = nil return r end
-- Only the named entries of a map.
local function pick(a, keys)
  local r = {}
  for _, k in ipairs(keys) do if a[k] then r[k] = a[k] end end
  return r
end

---------------------------------------------------------------------------------------------------
-- Materials. A house is described by `zones`, rules read top to bottom, the first that matches
-- naming the material of a pixel of the original: { zone, x, y, w, h, colours } (a nil rectangle
-- is the whole sprite, nil colours any colour). What matches none is `wall`. `over` lists what the
-- worn stages laid on the house: { stages, x, y, w, h, keep, zone, rows, on }. On those stages a
-- pixel inside it whose colour is in `keep` takes `zone`'s map instead (none: it keeps its colour);
-- `rows` narrows the rectangle to the pixels marked k, as a roof hole was cut, and `on` to the
-- pixels of the materials it names.
---------------------------------------------------------------------------------------------------
local function zoneOf(house, base, x, y)
  local c = at(base, x, y)
  if not c then return nil end
  for _, z in ipairs(house.zones) do
    local inside = not z[2] or (x >= z[2] and y >= z[3] and x < z[2] + z[4] and y < z[3] + z[5])
    if inside and (not z[6] or z[6][c]) then return z[1] end
  end
  return "wall"
end

local function overAt(house, stage, x, y, c, zone)
  for _, o in ipairs(house.over or {}) do
    if o.stages[stage] and x >= o.x and y >= o.y and x < o.x + o.w and y < o.y + o.h and o.keep[c]
       and (not o.on or o.on[zone]) then
      local hit = true
      if o.rows then hit = o.rows[y - o.y + 1]:sub(x - o.x + 1, x - o.x + 1) == "k" end
      if hit then return o.zone or "keep" end
    end
  end
end

-- A material a colourway may leave out, and the one whose map it then takes: the foot of a wall,
-- where the worn stages grime it, is wall unless a colourway paints its dirt apart.
local PARENT = { foot = "wall", footshade = "wall", ridge = "thatch" }

-- One stage of a house in a colourway: every pixel through its material's map.
local function recolour(house, way, stage)
  local name = house.name .. (stage > 0 and "_" .. stage or "")
  local src, l = copy(name)
  local base = copy(house.name)
  local g = src:clone()
  for y = 0, g.height - 1 do for x = 0, g.width - 1 do
    local c = at(src, x, y)
    if c then
      local z = zoneOf(house, base, x, y) or "wall"
      z = overAt(house, stage, x, y, c, z) or z
      local m = way.maps[z]
      if m == nil and PARENT[z] then m = way.maps[PARENT[z]] end
      local to = m and m[c]
      if to then P.pix(g, x, y, to) end
      if AUDIT and m and next(m) and not to then
        local k = name .. " " .. z .. " " .. c
        AUDIT[k] = (AUDIT[k] or 0) + 1
      end
    end
  end end
  if way.fix and way.fix[stage] then way.fix[stage](g, l) end
  return g, l, src
end

-- A pixel that matches none of its eight neighbours, where the original's pixel matched one: what
-- a map can leave at the seam of two materials. Printed, so it can be fixed by hand.
local function strays(name, g, l, src)
  local n = 0
  local function lone(img, x, y)
    local c = img:getPixel(x, y)
    for dy = -1, 1 do for dx = -1, 1 do
      local i, j = x + dx, y + dy
      if (dx ~= 0 or dy ~= 0) and i >= 0 and j >= 0 and i < img.width and j < img.height and img:getPixel(i, j) == c then
        return false
      end
    end end
    return true
  end
  for y = 0, g.height - 1 do for x = 0, g.width - 1 do
    if pc.rgbaA(g:getPixel(x, y)) > 0 and pc.rgbaA(l:getPixel(x, y)) == 0 and lone(g, x, y) and not lone(src, x, y) then
      print("  stray " .. name .. " " .. x .. "," .. y .. " " .. at(g, x, y) .. " (was " .. at(src, x, y) .. ")")
      n = n + 1
    end
  end end
  return n
end

-- P.map-style touch-ups by one-letter names, the same letters worn.lua's grids use.
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
        P.pix(g, x + i - 1, y + j - 1, CODE[k])
      end
    end
  end
end

---------------------------------------------------------------------------------------------------
-- The houses' materials, read off village.lua and worn.lua
---------------------------------------------------------------------------------------------------
local PLANK = set { "wood", "bark", "sand", "ink", "plum", "grey", "smoke", "slate" }
local HOUSE = {}

-- house1: gable end left, long tiled wall right. The stages board the far window, cut a hole to
-- the rafters and nail the door shut.
HOUSE.house1 = {
  name = "house1",
  zones = {
    { "handle", 9, 26, 1, 2, set { "sand" } },
    { "door", 4, 20, 7, 12, set { "bark", "wood", "sand" } },
    { "win", 5, 11, 5, 6, set { "white", "navy", "ink" } },
    { "win", 17, 19, 5, 7, set { "white", "navy", "ink" } },
    { "win", 26, 19, 5, 7, set { "white", "navy", "ink" } },
    { "box", 16, 26, 7, 3, set { "coral", "grass", "wood", "bark" } },
    { "box", 25, 26, 7, 3, set { "coral", "grass", "wood", "bark" } },
    { "roof", 0, 0, 34, 15, set { "red", "coral", "plum", "bark" } },
    -- the foot of the wall, which the worn stages grime: the plaster, and the shade down the corner
    { "foot", 0, 26, 34, 3, set { "skin" } },
    { "footshade", 0, 26, 34, 3, set { "sand" } },
    { "plinth", 0, 29, 34, 3, set { "stone", "steel", "grey" } },
  },
  over = {
    { stages = set { 1, 2, 3 }, x = 25, y = 20, w = 6, h = 5, keep = PLANK },
    { stages = set { 2, 3 }, x = 3, y = 24, w = 9, h = 2, keep = PLANK },
    -- the scorched door's planks darkened a pixel past its frame
    { stages = set { 3 }, x = 3, y = 26, w = 1, h = 1, keep = set { "plum" }, zone = "door" },
    { stages = set { 3 }, x = 11, y = 27, w = 1, h = 1, keep = set { "plum" }, zone = "door" },
  },
}

-- house2: half-timbered, slate roof, a chimney behind the ridge, a stone ground floor.
HOUSE.house2 = {
  name = "house2",
  zones = {
    { "chimney", 21, 0, 6, 2, set { "steel", "stone" } },
    { "chimney", 22, 2, 4, 7, set { "wood", "bark" } },
    { "win", 6, 13, 5, 6, set { "bark", "navy", "ink" } },
    { "win", 6, 22, 5, 6, set { "bark", "navy", "ink" } },
    { "win", 18, 22, 3, 5, set { "bark", "navy", "ink" } },
    { "win", 21, 30, 4, 4, set { "bark", "navy", "ink" } },
    { "door", 6, 29, 5, 7, set { "bark", "wood", "sand" } },
    { "roof", 0, 3, 30, 17, set { "navy", "indigo", "steel", "ink" } },
    { "timber", 0, 3, 30, 26, set { "bark", "plum" } },
    { "ground", 0, 29, 30, 7 },
  },
  over = {
    { stages = set { 1, 2, 3 }, x = 5, y = 14, w = 6, h = 2, keep = PLANK },
    { stages = set { 1, 2, 3 }, x = 6, y = 17, w = 6, h = 1, keep = PLANK },
    { stages = set { 2, 3 }, x = 20, y = 30, w = 5, h = 2, keep = PLANK },
    { stages = set { 2, 3 }, x = 21, y = 32, w = 5, h = 2, keep = PLANK },
    { stages = set { 3 }, x = 22, y = 2, w = 4, h = 16, keep = set { "smoke", "slate" } },
    -- the derelict's broken tiles round the hole, lit edges on the slate
    { stages = set { 2 }, x = 17, y = 13, w = 6, h = 3, keep = set { "steel" }, zone = "roofhole",
      rows = { "....kk", "k.....", ".kkk.." } },
  },
}

-- house3: thatched cottage with an eyebrow window in the thatch.
HOUSE.house3 = {
  name = "house3",
  zones = {
    { "eyebrow", 12, 8, 4, 2, set { "navy", "ink" } },
    { "win", 6, 16, 5, 5, set { "white", "navy", "ink" } },
    { "win", 18, 16, 5, 5, set { "white", "navy", "ink" } },
    { "handle", 15, 19, 1, 2, set { "sand" } },
    { "door", 13, 15, 3, 1, set { "bark" } },
    { "door", 12, 16, 5, 8, set { "bark", "wood", "sand" } },
    { "fringe", 0, 14, 28, 1 },
    -- the cap along the top, above the first course
    { "ridge", 0, 0, 28, 3 },
    { "thatch", 0, 0, 28, 14 },
    { "foot", 0, 21, 28, 1, set { "skin" } },
    { "plinth", 0, 22, 28, 2, set { "stone", "steel", "grey" } },
  },
  over = {
    { stages = set { 1, 2, 3 }, x = 18, y = 16, w = 5, h = 2, keep = PLANK },
    { stages = set { 1, 2, 3 }, x = 18, y = 19, w = 5, h = 2, keep = PLANK },
    { stages = set { 2, 3 }, x = 11, y = 19, w = 7, h = 2, keep = PLANK },
    { stages = set { 2 }, x = 17, y = 21, w = 1, h = 1, keep = set { "bark" }, zone = "door" },
    -- bark along the scorched eave is char, as it is in the thatch above it
    { stages = set { 3 }, x = 0, y = 14, w = 28, h = 1, keep = set { "bark" }, zone = "thatch" },
    -- before the fire, bark in the thatch is where it has thinned to the battens
    { stages = set { 1, 2 }, x = 0, y = 0, w = 28, h = 14, keep = set { "bark" }, zone = "thatchhole",
      on = set { "thatch", "ridge" } },
    { stages = set { 2 }, x = 16, y = 2, w = 6, h = 5, keep = set { "wood" }, zone = "rafter",
      rows = { "kkkkk.", "kkkkkk", "kkkkkk", ".kkkkk", "...kk." } },
  },
}

-- house4: tall brick townhouse, crow-stepped gable, a painted shop below.
HOUSE.house4 = {
  name = "house4",
  zones = {
    { "win", 10, 5, 4, 5, set { "white", "navy", "ink" } },
    { "win", 3, 14, 5, 6, set { "white", "navy", "ink" } },
    { "win", 16, 14, 5, 6, set { "white", "navy", "ink" } },
    { "win", 3, 21, 5, 6, set { "white", "navy", "ink" } },
    { "win", 16, 21, 5, 6, set { "white", "navy", "ink" } },
    { "coping", 0, 0, 24, 13, set { "ice" } },
    { "fascia", 0, 28, 24, 1 },
    { "awning", 10, 30, 12, 3, set { "red", "white", "plum", "ice" } },
    { "shopwin", 11, 33, 10, 6, set { "skin", "navy", "ink" } },
    { "handle", 6, 35, 1, 2, set { "sand" } },
    { "door", 2, 31, 6, 9, set { "bark", "wood", "sand" } },
    { "shop", 0, 29, 24, 11 },
  },
  over = {
    { stages = set { 1, 2, 3 }, x = 2, y = 15, w = 6, h = 2, keep = PLANK },
    { stages = set { 1, 2, 3 }, x = 3, y = 18, w = 6, h = 1, keep = PLANK },
    { stages = set { 2, 3 }, x = 2, y = 22, w = 6, h = 2, keep = PLANK },
    { stages = set { 2, 3 }, x = 3, y = 25, w = 6, h = 1, keep = PLANK },
    { stages = set { 2, 3 }, x = 2, y = 34, w = 7, h = 2, keep = PLANK },
  },
}

-- house5: long farmhouse, shingled roof with a ridge ventilator, shutters, a barn door.
HOUSE.house5 = {
  name = "house5",
  zones = {
    { "vent", 19, 0, 9, 3 },
    { "win", 4, 9, 4, 5, set { "white", "navy", "ink" } },
    { "win", 5, 18, 5, 6, set { "white", "navy", "ink" } },
    { "win", 15, 18, 5, 6, set { "white", "navy", "ink" } },
    { "shutter", 3, 18, 2, 6, set { "red", "plum" } },
    { "shutter", 10, 18, 2, 6, set { "red", "plum" } },
    { "shutter", 13, 18, 2, 6, set { "red", "plum" } },
    { "shutter", 20, 18, 2, 6, set { "red", "plum" } },
    { "barndoor", 25, 17, 11, 11, set { "red", "skin" } },
    { "barn", 22, 16, 16, 12 },
    -- the shingles by what each pixel was, as the scorched stage darkens each a step: the body
    -- (wood) goes to bark, the courses (bark) to plum, the highlights (sand) to wood
    { "roof", 0, 3, 38, 13, set { "wood" } },
    { "roofline", 0, 3, 38, 13, set { "bark" } },
    { "rooflite", 0, 3, 38, 13, set { "sand" } },
    { "roofeave", 0, 3, 38, 13, set { "plum" } },
    { "plinth", 0, 25, 22, 3, set { "stone", "steel", "grey" } },
  },
  over = {
    { stages = set { 1, 2, 3 }, x = 4, y = 9, w = 4, h = 5, keep = set { "wood", "bark", "ink", "smoke", "slate", "stone" } },
    { stages = set { 2, 3 }, x = 14, y = 19, w = 6, h = 2, keep = PLANK },
    { stages = set { 2, 3 }, x = 15, y = 22, w = 5, h = 1, keep = PLANK },
    { stages = set { 3 }, x = 2, y = 22, w = 1, h = 1, keep = set { "plum" }, zone = "shutter" },
    -- scorched, the courses have gone to plum: bark left on one is a broken tile's edge, darkened
    { stages = set { 3 }, x = 0, y = 3, w = 38, h = 13, keep = set { "bark" }, on = set { "roofline" }, zone = "roof" },
    { stages = set { 2 }, x = 25, y = 6, w = 8, h = 6, keep = set { "sand" }, zone = "rafter",
      rows = { "kkkkkkk.", "kkkkkkkk", "kkkkkkkk", "kkkkkkk.", ".kkkk...", ".kkk...." } },
  },
}

---------------------------------------------------------------------------------------------------
-- Colourways. Each material's map is a ramp laid over the original's: every step of the old
-- colour, from its highlight down through the grime, fade and soot the stages gave it, goes to the
-- same step of the new one, so the wear reads the same in the new colours.
---------------------------------------------------------------------------------------------------
-- Plaster, cream to whitewash: lit, shade, grime, outline and crack, deeper crack.
local WHITEWASH = { skin = "white", sand = "ice", ochre = "steel", wood = "stone", bark = "grey" }
-- The foot of a whitewashed wall keeps its dirt warm: grime is soil splashed up, not shadow.
local WHITEFOOT = with(WHITEWASH, { sand = "sand", ochre = "ochre" })
-- A wood door or plank painted: red, green or blue, by the same steps.
local DOOR_RED = { sand = "coral", wood = "red", bark = "plum", plum = "ink", ochre = "red" }
local DOOR_GREEN = { sand = "sage", wood = "teal", bark = "moss", plum = "slate", ochre = "teal" }
local DOOR_BLUE = { sand = "steel", wood = "navy", bark = "indigo", plum = "ink", ochre = "navy" }

local WAYS = {}

-- house1b: a slate roof, whitewashed walls, wood window frames and a red door.
WAYS.house1b = { house = "house1", maps = {
  roof = { coral = "steel", red = "navy", bark = "indigo", plum = "slate" },
  wall = WHITEWASH,
  foot = WHITEFOOT,
  footshade = { sand = "ice", ochre = "ochre" },
  win = with(pick(WHITEWASH, { "skin", "sand" }), { white = "wood" }),
  -- where the derelict's boxes are gone, the sand under them is the same dirt as the foot's
  box = pick(WHITEFOOT, { "skin", "sand" }),
  door = DOOR_RED,
  handle = except(DOOR_RED, "sand"),
}, fix = {
  -- a fleck of dirt that clung to the old corner shade joins the clump at the corner's foot
  [1] = function(g) touch(g, 15, 27, { "O" }) end,
} }

-- house1c: grey stone tiles over honey-coloured walls, a green door.
local HONEY = { skin = "sand", sand = "ochre", ochre = "wood", wood = "bark", bark = "plum" }
WAYS.house1c = { house = "house1", maps = {
  roof = { coral = "steel", red = "stone", bark = "grey", plum = "smoke" },
  wall = HONEY,
  win = pick(HONEY, { "skin", "sand" }),
  box = pick(HONEY, { "skin", "sand" }),
  door = DOOR_GREEN,
  handle = except(DOOR_GREEN, "sand"),
} }

-- house2b: dark brown tiles, the timbers a shade lighter, a stone chimney so the stack still
-- stands clear of the darker roof. The slate's ramp, highlight, body, courses, goes to the brown's:
-- wood, bark, plum.
WAYS.house2b = { house = "house2", maps = {
  roof = { steel = "wood", navy = "bark", indigo = "plum", slate = "plum", grey = "bark" },
  -- the broken tiles' edges round the derelict's hole: dark, so the rafters in it stand clear
  roofhole = { steel = "plum" },
  chimney = { wood = "steel", bark = "stone", steel = "ice", stone = "grey" },
  timber = { bark = "wood", wood = "sand", plum = "bark" },
  win = { bark = "wood", wood = "sand", plum = "bark" },
  -- the tidying in worn.lua spilt a timber's colour into the plaster and the stone in places
  wall = { bark = "wood" },
  ground = { bark = "wood" },
}, fix = {
  [3] = function(g) touch(g, 7, 10, { "T" }) end,
} }

-- house3b: an old thatch gone brown, whitewashed walls, a blue door. The thatch steps down two
-- places at a time, so its shade side and courses stay clear of the body: highlight sand, body
-- ochre, shade and courses bark, outline plum. The derelict's rot, olive on the gold, goes to the
-- dark damp green of slate, darker than the shade under the evening light and still a green under
-- its moss. Bark in the thatch is the scorched stage's char, so it stays; only the fringe along
-- the eave, bark already, goes darker.
local BROWNTHATCH = { skin = "sand", sand = "ochre", ochre = "bark", olive = "slate", wood = "plum" }
WAYS.house3b = { house = "house3", maps = {
  thatch = BROWNTHATCH,
  fringe = with(BROWNTHATCH, { wood = "bark", bark = "plum" }),
  -- a thinned patch, bark on the old straw, would sink into the new shade: a step darker
  thatchhole = { bark = "plum" },
  rafter = {},
  wall = WHITEWASH,
  foot = WHITEFOOT,
  -- white frames would vanish into the whitewash: wood, as house1b's are
  win = with(pick(WHITEWASH, { "skin", "sand" }), { white = "wood" }),
  door = DOOR_BLUE,
  handle = except(DOOR_BLUE, "sand"),
}, fix = {
  -- the eave's left tip: the outline there meets the courses, not the shaded edge
  [0] = function(g) touch(g, 0, 13, { "b" }) end,
  [1] = function(g) touch(g, 0, 13, { "b" }) end,
  [2] = function(g) touch(g, 0, 13, { "b" }) end,
} }

-- house3c: a golden thatch under a dark ridge cap, over walls of grey stone, a red door. The body
-- keeps its straw; the courses, the shade side and the eave go a step deeper, and the cap above
-- the first course two steps, so the roof is a different make of thatch, not house3's again.
local STONEWALL = { skin = "steel", sand = "stone", ochre = "grey", wood = "grey", bark = "smoke", plum = "slate" }
local DEEPTHATCH = { ochre = "wood", wood = "bark" }
WAYS.house3c = { house = "house3", maps = {
  thatch = DEEPTHATCH,
  ridge = with(DEEPTHATCH, { skin = "sand", sand = "ochre" }),
  fringe = with(DEEPTHATCH, { wood = "bark", bark = "plum" }),
  rafter = {},
  wall = STONEWALL,
  win = pick(STONEWALL, { "skin", "sand" }),
  door = DOOR_RED,
  handle = except(DOOR_RED, "sand"),
} }

-- house4b: grey stone instead of brick, a red shopfront under a green-and-white awning.
WAYS.house4b = { house = "house4", maps = {
  -- the brick's crack (plum) a shade under the stone's own; the broken ends of the top step,
  -- light on the brick, light on the stone
  wall = { wood = "stone", bark = "grey", plum = "smoke", sand = "steel" },
  win = { wood = "stone", bark = "grey" },
  -- the copings stay pale; where one has chipped off, the wall shows through
  coping = { wood = "stone", bark = "grey" },
  shop = { teal = "red", moss = "plum", sage = "coral", olive = "red", slate = "plum" },
  awning = { red = "teal", plum = "moss", coral = "sage", teal = "red" },
  shopwin = { red = "teal", coral = "sage", teal = "red" },
} }

-- house5b: a slate roof, green shutters and a green barn door.
local GREENPAINT = { coral = "sage", red = "teal", plum = "moss" }
WAYS.house5b = { house = "house5", maps = {
  -- slate, sooted as house2's is: navy to slate, indigo to ink, steel to grey
  roof = { wood = "navy", sand = "steel", bark = "slate", plum = "ink" },
  roofline = { bark = "indigo", wood = "navy", plum = "ink", sand = "steel" },
  rooflite = { sand = "steel", wood = "grey", bark = "slate" },
  roofeave = { plum = "ink", wood = "navy", sand = "steel" },
  rafter = { sand = "wood" },
  shutter = GREENPAINT,
  barndoor = GREENPAINT,
} }

local TINT = { WHITEWASH = WHITEWASH, DOOR_RED = DOOR_RED, DOOR_GREEN = DOOR_GREEN, DOOR_BLUE = DOOR_BLUE,
         with = with, pick = pick, touch = touch }
local ORDER = { "house1b", "house1c", "house2b", "house3b", "house3c", "house4b", "house5b" }

---------------------------------------------------------------------------------------------------
-- Sheet
---------------------------------------------------------------------------------------------------
local STEP = { [0] = "", "worn", "derelict", "scorched" }
local MADE = {}
local total = 0
for _, wname in ipairs(ORDER) do
  local way = WAYS[wname]
  local house = HOUSE[way.house]
  for stage = 0, 3 do
    local g, l, src = recolour(house, way, stage)
    local name = wname .. (stage > 0 and "_" .. stage or "")
    total = total + strays(name, g, l, src)
    local cell = P.strip(S, name, g.width, g.height, 1,
      house.name .. " colourway" .. (stage > 0 and ", " .. STEP[stage] or ""))
    local x, y = cell(0)
    P.blit(S.base, g, x, y)
    P.blit(S.lights, l, x, y)
    MADE[name] = { g = g, l = l }
  end
end
if total > 0 then print("tint: " .. total .. " strays") end
if AUDIT then
  local keys = {}
  for k in pairs(AUDIT) do keys[#keys + 1] = k end
  table.sort(keys)
  for _, k in ipairs(keys) do print("  kept " .. k .. " x" .. AUDIT[k]) end
end

P.save(S, ART, 3)

---------------------------------------------------------------------------------------------------
-- Previews
---------------------------------------------------------------------------------------------------
local function frameOf(name, f)
  if MADE[name] then return MADE[name].g, MADE[name].l end
  return copy(name, f)
end
local function multiply(c, t)
  local tr, tg, tb = tonumber(t:sub(2, 3), 16), tonumber(t:sub(4, 5), 16), tonumber(t:sub(6, 7), 16)
  return pc.rgba(pc.rgbaR(c) * tr // 255, pc.rgbaG(c) * tg // 255, pc.rgbaB(c) * tb // 255, 255)
end
-- A sprite at x, y as it is, and `dy` lower in light t with its lights over it.
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

-- tint-stages.png: each colourway through its stages, untinted over the day sky, then multiplied
-- by each stage's light over the evening sky with its lights on.
local LIGHTS = { "#FFFFFF", "#D49989", "#AA5E66", "#B15C60" }
local function stages(path, rows, zoom)
  local cellW, gap = 40, 4
  local heights, total, cols = {}, gap, 0
  for r, row in ipairs(rows) do
    local h = 0
    for _, n in ipairs(row) do h = math.max(h, (frameOf(n)).height) end
    heights[r] = h; total = total + h + gap
    cols = math.max(cols, #row)
  end
  local out = canvas(gap + cols * (cellW + gap), total)
  local y = gap
  for r, row in ipairs(rows) do
    for k, n in ipairs(row) do
      local g, l = frameOf(n)
      place(out, g, l, gap + (k - 1) * (cellW + gap) + (cellW - g.width) // 2, y + heights[r] - g.height, total,
        LIGHTS[(k - 1) % 4 + 1])
    end
    y = y + heights[r] + gap
  end
  write(out, zoom, path)
end
local rows = {}
for _, w in ipairs(ORDER) do rows[#rows + 1] = { w, w .. "_1", w .. "_2", w .. "_3" } end
stages(ART .. "/tint-stages.png", rows, 3)
-- While drawing: a row of stages for each name in COMPARE (an original, a colourway, or a candidate
-- from TRY, a table of colourways by name, or a function of TINT returning one, made only for this).
if rawget(_G, "COMPARE") then
  local try = rawget(_G, "TRY") or {}
  if type(try) == "function" then try = try(TINT) end
  for wname, way in pairs(try) do
    WAYS[wname] = way
    for stage = 0, 3 do
      local g, l, src = recolour(HOUSE[way.house], way, stage)
      local name = wname .. (stage > 0 and "_" .. stage or "")
      strays(name, g, l, src)
      MADE[name] = { g = g, l = l }
    end
  end
  local rows = {}
  for _, w in ipairs(COMPARE) do rows[#rows + 1] = { w, w .. "_1", w .. "_2", w .. "_3" } end
  stages(ART .. "/tint-w-compare.png", rows, COMPAREZOOM or 4)
end

-- tint-scene.png: the new colourways standing among the village's own sprites on the green field,
-- as the main row stands, by day and in the late evening light.
do
  local row = { "oak1", "house1", "house1b", "fence", "house3b", "poplar", "house2", "house1c", "sheep",
                "house4b", "house3", "oak2", "house5b", "house3c", "pine", "house2b", "house1", "bush2" }
  local W, gap = 8, 3
  for _, n in ipairs(row) do W = W + (frameOf(n)).width + gap end
  local fieldTop, H = 50, 50 + 26
  local out = canvas(W, H)
  local dusk = "#BF7B77"
  for x = 0, W - 1, 32 do
    local fg = copy("field0", (x // 32) % 2)
    place(out, fg, P.image(32, 26), x, fieldTop, H, dusk)
  end
  local x = 6
  for _, n in ipairs(row) do
    local g, l = frameOf(n)
    place(out, g, l, x, fieldTop + 5 - g.height, H, dusk)
    x = x + g.width + gap
  end
  write(out, 3, ART .. "/tint-scene.png")
end
