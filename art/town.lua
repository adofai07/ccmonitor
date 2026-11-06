-- town.lua: more of the village, so that a screen of it is not the same five houses: a stone
-- cottage, a bakery, an inn and the town hall, each through the stages worn.lua gives the houses,
-- and two burnt-out shells for after them.
local P = dofile(ART .. "/px.lua")
local S = P.sheet("town", 512, 128)
local pc = app.pixelColor

---------------------------------------------------------------------------------------------------
-- Drawing helpers, as village.lua has them
---------------------------------------------------------------------------------------------------
local NAME = {}
for n in pairs(P.C) do NAME[P.hex(n)] = n end

-- P.map with every row checked: a row of the wrong width is a typo, not a shape.
local function map(g, x, y, rows, legend)
  for j, r in ipairs(rows) do
    if #r ~= #rows[1] then error("row " .. j .. " is " .. #r .. " wide, expected " .. #rows[1] .. ": " .. r) end
  end
  P.map(g, x, y, rows, legend)
end

-- Turns any lone pixel of colour `c` inside a rectangle into `into`: what an overlap leaves behind.
local function tidy(g, x, y, w, h, c, into)
  local want, lone = P.hex(c), {}
  local same = function(i, j)
    return i >= 0 and j >= 0 and i < g.width and j < g.height and g:getPixel(i, j) == want
  end
  for j = y, y + h - 1 do for i = x, x + w - 1 do
    if same(i, j) then
      local n = 0
      for dj = -1, 1 do for di = -1, 1 do
        if (di ~= 0 or dj ~= 0) and same(i + di, j + dj) then n = n + 1 end
      end end
      if n == 0 then lone[#lone + 1] = { i, j } end
    end
  end end
  for _, o in ipairs(lone) do P.pix(g, o[1], o[2], into) end
end

-- Roof courses that follow the slope (village.lua's): a soft line every third row with staggered
-- gaps and a short highlight dash; `lean` slides the pattern sideways per row.
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

-- A casement (village.lua's): frame, dark panes with a day glint, the same panes lit at night.
-- `single` leaves out the mullion, for a window of one light.
local function casement(g, l, x, y, w, h, frame, single)
  local rows = h - 2
  P.rect(g, x, y, w, h, frame)
  P.rect(g, x + 1, y + 1, w - 2, rows, "ink")
  P.rect(g, x + 1, y + 1, w - 2, (rows <= 3 and w <= 5 and not single) and rows or (rows + 1) // 2, "navy")
  P.rect(l, x + 1, y + 1, w - 2, rows, "yellow")
  P.rect(l, x + 1, y + h - 2, w - 2, 1, "sand")
  if w >= 5 and not single then
    P.vline(g, x + w // 2, y + 1, rows, frame)
    P.vline(l, x + w // 2, y + 1, rows, nil)
  end
  if h >= 7 then
    P.hline(g, x + 1, y + h // 2, w - 2, frame)
    P.hline(l, x + 1, y + h // 2, w - 2, nil)
  end
end

-- An arched plank door (village.lua's), in any two colours.
local function door(g, x, y, w, h, edge, plank, knob)
  edge, plank = edge or "bark", plank or "wood"
  P.rect(g, x, y + 1, w, h - 1, edge)
  P.hline(g, x + 1, y, w - 2, edge)
  P.rect(g, x + 1, y + 1, w - 2, h - 1, plank)
  for i = x + 2, x + w - 2, 2 do P.vline(g, i, y + 2, h - 2, edge) end
  P.vline(g, x + w - 2, y + h // 2, 2, knob or "sand")
end

local function sprite(name, w, h, frames, note, draw)
  local cell = P.strip(S, name, w, h, frames, note)
  for f = 0, frames - 1 do
    local g, l = draw(f)
    assert(g.width == w and g.height == h, name .. " is " .. g.width .. "x" .. g.height)
    local x, y = cell(f)
    P.blit(S.base, g, x, y)
    P.blit(S.lights, l, x, y)
  end
end

---------------------------------------------------------------------------------------------------
-- cottage: a low fieldstone cottage, a steep little gable over the door rising through a roof of
-- stone slabs, the chimney at the right end; a blue door, a rose bush at one corner, quoins up the
-- other
---------------------------------------------------------------------------------------------------
local function cottage()
  local g, l = P.image(25, 22), P.image(25, 22)
  -- walls: steel fieldstone on a stone footing
  P.rect(g, 2, 12, 22, 10, "steel")
  -- the slab roof, in courses, its top corners eased
  courses(g, 4, 11, function() return 1 end, function() return 24 end,
    { base = "grey", line = "smoke", lite = "stone", dash = 7 }, 0)
  P.hline(g, 1, 4, 24, "stone"); P.pix(g, 1, 4, nil); P.pix(g, 24, 4, nil)
  P.vline(g, 1, 5, 7, "stone"); P.vline(g, 24, 5, 7, "smoke")
  P.hline(g, 1, 11, 24, "stone"); P.pix(g, 24, 11, "grey")
  -- lichen on the slabs: a clump low on the left, a smaller one up by the chimney
  map(g, 2, 8, { ".aa", "amm" }, { a = "sage", m = "moss" })
  map(g, 20, 5, { "aa.", ".mm" }, { a = "sage", m = "moss" })
  tidy(g, 2, 4, 22, 8, "stone", "grey"); tidy(g, 2, 4, 22, 8, "smoke", "grey")
  -- the chimney at the right end
  P.rect(g, 19, 1, 4, 3, "steel"); P.rect(g, 21, 1, 2, 3, "stone")
  P.rect(g, 18, 0, 6, 1, "ice"); P.hline(g, 22, 0, 2, "steel")
  P.hline(g, 19, 1, 4, "grey")
  -- the gable over the door: fieldstone under a coping, a small square window in it
  for y = 1, 11 do
    local half = (y + 1) // 2
    local lx, rx = 13 - half, 12 + half
    P.hline(g, lx, y, rx - lx + 1, "steel")
    P.pix(g, lx, y, "ice"); P.pix(g, rx, y, "stone")
    if y >= 3 then P.pix(g, lx + 1, y, y % 2 == 1 and "ice" or "steel") end
  end
  P.rect(g, 8, 11, 10, 1, "steel"); P.pix(g, 7, 11, "ice"); P.pix(g, 18, 11, "stone")
  map(g, 12, 4, { ".T.", "iih", "hhh" }, { i = "ice", h = "steel", T = "stone" })
  map(g, 11, 7, {
    "IIII",
    "InnI",
    "IkkT",
    "TTTT",
  }, { I = "ice", n = "navy", k = "ink", T = "stone" })
  P.rect(l, 12, 8, 2, 2, "yellow"); P.hline(l, 12, 9, 2, "sand")
  -- the stonework, where the openings leave any wall to see: two big stones under the gable, joints
  -- beside the door, quoins up the corners, a footing course under the windows, and the shadow of
  -- the eave either side of the gable
  map(g, 2, 11, {
    "......iihhSiihhSS.....",
    "SSSSSShhhSShhhSSSSSSSS",
    "iiS....SS....S....SiiS",
    "hhS....hhh..hh....hhhS",
    "..S....hh....h....SSSS",
    ".......SS....h....iiiS",
    ".......hh....h....hhhS",
    ".......hh....h....SSSS",
    "........h.........SiiS",
    "...iihhSh....SiihhShhS",
    "SSSSSSSSSSSSSSSSSSSSSS",
  }, { i = "ice", h = "steel", S = "stone" })
  -- the blue door under its lintel
  P.hline(g, 11, 13, 4, "ice")
  map(g, 11, 14, {
    ".ii.",
    "iBBi",
    "iBBi",
    "iBBi",
    "iBBs",
    "iBBs",
    "iBBi",
    "iBBi",
  }, { i = "indigo", B = "blue", s = "sand" })
  -- the windows, with lintels and sills
  for _, x in ipairs { 5, 16 } do
    P.hline(g, x, 13, 4, "ice")
    casement(g, l, x, 14, 4, 5, "white")
    P.hline(g, x == 5 and 5 or 15, 19, 5, "ice")
  end
  -- a rose bush at the corner
  map(g, 0, 15, {
    ".llC.",
    "gggCC",
    "ggmmm",
    "gCCmm",
    "mCCmm",
    "mmmmm",
    "mmmmm",
  }, { g = "grass", l = "lime", m = "moss", C = "coral" })
  return g, l
end

---------------------------------------------------------------------------------------------------
-- bakery: a narrow two-storey shop in pink plaster under a tiled mansard with a dormer, a bay
-- window under a striped awning, and a gilt loaf hung from an iron bracket
---------------------------------------------------------------------------------------------------
local function bakery(V)
  V = V or {}
  local WALL, SHADE = V.wall or "pink", V.shade or "purple"
  local ROOF = V.roof or { base = "red", line = "plum", lite = "coral", dash = 8 }
  local AW = V.awning or "sky"
  local g, l = P.image(30, 38), P.image(30, 38)
  local R = 21 -- right edge of the body
  -- chimney behind the roof
  P.rect(g, 14, 1, 2, 5, "wood"); P.rect(g, 16, 1, 2, 5, "bark")
  P.rect(g, 13, 0, 6, 1, "steel"); P.hline(g, 13, 1, 6, "stone")
  -- the mansard: a shallow cap over a steep face that flares at the eave
  local cap = { [3] = { 5, 16 }, [4] = { 3, 18 }, [5] = { 2, 19 } }
  for y = 3, 5 do P.hline(g, cap[y][1], y, cap[y][2] - cap[y][1] + 1, ROOF.base) end
  P.hline(g, 5, 3, 12, ROOF.lite); P.hline(g, 3, 4, 2, ROOF.lite)
  P.hline(g, 2, 5, 18, ROOF.line)
  courses(g, 6, 12, function(y) return y >= 12 and 0 or 1 end, function(y) return y >= 12 and R or R - 1 end, ROOF, 0)
  P.vline(g, 1, 6, 6, ROOF.lite); P.vline(g, R - 1, 6, 6, ROOF.line)
  P.hline(g, 0, 12, R + 1, ROOF.line); P.hline(g, 0, 12, 3, ROOF.lite)
  -- dormer
  map(g, 7, 2, {
    "...rr...",
    "..rssw..",
    ".rsWWwb.",
    "rsWnnWwb",
    ".bWnnWb.",
    ".bWkkWb.",
    ".bWkkWb.",
    ".bWWWWb.",
    ".bbbbbb.",
  }, { r = ROOF.base, s = ROOF.lite, w = ROOF.line, b = "bark", W = "white", n = "navy", k = "ink" })
  P.rect(l, 10, 5, 2, 4, "yellow"); P.hline(l, 10, 8, 2, "sand")
  tidy(g, 0, 6, R + 1, 6, ROOF.lite, ROOF.base); tidy(g, 0, 6, R + 1, 6, ROOF.line, ROOF.base)
  tidy(g, 0, 6, R + 1, 6, ROOF.base, ROOF.line)
  -- cornice
  P.hline(g, 0, 13, R + 1, "white"); P.hline(g, 0, 14, R + 1, "ice")
  -- upper floor in plaster, lit from the left, shaded on the right
  P.rect(g, 0, 15, R + 1, 9, WALL)
  P.vline(g, R, 15, 9, SHADE); P.hline(g, 1, 15, R, SHADE)
  casement(g, l, 7, 16, 7, 7, "white")
  P.hline(g, 6, 23, 9, "ice")
  -- string course
  P.hline(g, 0, 24, R + 1, "white"); P.hline(g, 0, 25, R + 1, "ice")
  -- ground floor
  P.rect(g, 0, 26, R + 1, 12, WALL)
  P.vline(g, R, 26, 12, SHADE)
  -- the shop door, half glazed
  P.rect(g, 1, 27, 6, 11, "white")
  P.rect(g, 2, 28, 4, 10, "teal")
  P.rect(g, 3, 29, 2, 3, "ink"); P.hline(g, 3, 29, 2, "navy")
  P.rect(l, 3, 29, 2, 3, "yellow")
  P.vline(g, 5, 28, 10, "moss"); P.hline(g, 2, 33, 4, "moss"); P.vline(g, 4, 35, 2, "sand")
  -- the bay window under the awning: three lights, the side ones turned away
  P.rect(g, 9, 30, 12, 6, "white")
  P.rect(g, 10, 31, 2, 4, "ink"); P.rect(g, 13, 31, 4, 4, "ink"); P.rect(g, 18, 31, 2, 4, "ink")
  P.rect(l, 10, 31, 2, 4, "yellow"); P.rect(l, 13, 31, 4, 4, "yellow"); P.rect(l, 18, 31, 2, 4, "yellow")
  P.hline(g, 10, 31, 2, "navy"); P.hline(g, 13, 31, 4, "navy"); P.hline(g, 18, 31, 2, "navy")
  P.vline(g, 12, 30, 6, "ice"); P.vline(g, 17, 30, 6, "ice")
  -- loaves on the shelf, dark against the glow at night
  for _, b in ipairs { { 10, 33, 2 }, { 13, 33, 2 }, { 15, 33, 2 }, { 18, 33, 2 } } do
    P.hline(g, b[1], b[2], b[3], "sand"); P.hline(g, b[1], b[2] + 1, b[3], "wood")
    P.hline(l, b[1], b[2], b[3], nil); P.hline(l, b[1], b[2] + 1, b[3], nil)
  end
  P.rect(g, 9, 36, 12, 2, "wood"); P.hline(g, 9, 36, 12, "sand"); P.vline(g, 9, 36, 2, "bark")
  -- the striped awning, its valance scalloped
  for x = 8, R do
    local white = ((x - 8) // 2) % 2 == 0
    P.rect(g, x, 26, 1, 3, white and "white" or AW)
    if white then P.pix(g, x, 29, "ice") end
  end
  P.hline(g, 8, 26, R - 7, V.awningTop or "blue")
  -- the bracket, and a gilt loaf hung from it on two short chains, its crust scored twice
  map(g, R + 1, 15, V.sign or {
    "kkkkkkkk",
    "k.k..k..",
    "..k..k..",
    "..SSss..",
    ".SSswss.",
    "sSswsswb",
    "sswsswsb",
    "wwwwwwwb",
    ".bbbbbb.",
  }, { k = "ink", s = "sand", S = "skin", w = "wood", b = "bark" })
  return g, l
end

---------------------------------------------------------------------------------------------------
-- inn: a wide timber-framed inn, its upper floor jettied out over the ground floor, a front gable
-- on the right, a tall chimney on the hipped left end; a sign with a tankard hung under the jetty,
-- a lantern and a barrel by the door
---------------------------------------------------------------------------------------------------
local function inn()
  local g, l = P.image(42, 34), P.image(42, 34)
  local beam = "bark"
  -- chimney
  P.rect(g, 4, 1, 2, 8, "wood"); P.rect(g, 6, 1, 2, 8, "bark")
  P.rect(g, 3, 0, 6, 1, "steel"); P.hline(g, 3, 1, 6, "stone")
  P.hline(g, 4, 4, 2, "bark"); P.hline(g, 6, 6, 2, "plum")
  -- the long roof, hipped at the left
  courses(g, 6, 12, function(y) return 3 - (y - 6) // 2 end, function() return 30 end,
    { base = "purple", line = "plum", lite = "pink", dash = 8 }, 0)
  for y = 6, 12 do local x = 3 - (y - 6) // 2; P.pix(g, x, y, "purple"); P.pix(g, x + 1, y, "purple") end
  -- the front gable: plaster and timbers, under a purple verge
  local apex = 4
  for y = apex, 12 do
    local h = y - apex + 1
    P.hline(g, 33 - h, y, 2 * h, "sand")
  end
  P.rect(g, 32, 6, 2, 2, beam)
  P.line(g, 30, 10, 28, 12, beam); P.line(g, 35, 10, 37, 12, beam)
  casement(g, l, 31, 8, 4, 4, beam)
  for y = apex, 12 do
    local h = y - apex + 1
    local lx, rx = 33 - h, 32 + h
    P.pix(g, lx, y, "purple"); P.pix(g, lx + 1, y, "pink")
    P.pix(g, rx, y, "plum"); P.pix(g, rx - 1, y, "purple")
  end
  -- the upper floor, jettied
  P.rect(g, 0, 13, 42, 9, "sand")
  P.hline(g, 0, 13, 42, beam); P.hline(g, 0, 21, 42, beam); P.hline(g, 0, 22, 42, "plum")
  for _, x in ipairs { 0, 10, 20, 24, 41 } do P.vline(g, x, 13, 9, beam) end
  P.line(g, 1, 20, 3, 14, beam); P.line(g, 19, 20, 17, 14, beam)
  P.line(g, 21, 20, 23, 14, beam)
  casement(g, l, 4, 15, 5, 5, beam, true)
  casement(g, l, 12, 15, 5, 5, beam, true)
  casement(g, l, 27, 15, 5, 5, beam, true)
  casement(g, l, 34, 15, 5, 5, beam, true)
  -- joist ends under the jetty
  for x = 3, 39, 3 do P.pix(g, x, 22, "wood") end
  -- the ground floor, set back two pixels each side
  P.rect(g, 2, 23, 38, 11, "sand")
  P.hline(g, 2, 23, 38, "wood")
  P.vline(g, 2, 23, 11, beam); P.vline(g, 39, 23, 11, beam)
  P.vline(g, 24, 23, 11, beam)
  P.hline(g, 2, 33, 38, "plum")
  P.rect(g, 3, 31, 36, 2, "stone"); P.hline(g, 3, 32, 36, "grey")
  -- leaded windows
  casement(g, l, 8, 25, 5, 6, beam, true)
  casement(g, l, 31, 25, 7, 6, beam)
  -- the door
  door(g, 17, 25, 6, 9, "bark", "wood", "yellow")
  -- the lantern on its bracket
  map(g, 14, 24, {
    ".kk",
    ".k.",
    "kkk",
    "nnn",
    "nnn",
    "kkk",
  }, { k = "ink", n = "navy" })
  P.rect(l, 14, 27, 3, 2, "yellow"); P.hline(l, 14, 28, 3, "sand")
  -- the barrel, standing out in front of the post and the plinth
  map(g, 24, 26, {
    ".bbbb.",
    "bKswwb",
    "bKswwb",
    "bkkkkb",
    "bKswwb",
    "bKswwb",
    "bkkkkb",
    ".bbbb.",
  }, { w = "wood", b = "bark", s = "sand", K = "skin", k = "ink" })
  P.pix(g, 23, 31, "grey")
  -- the sign under the jetty: a tankard on a board
  map(g, 0, 23, {
    ".pw..p.",
    "wwwwwww",
    "wWWWppb",
    "wWWWWpb",
    "wSssspb",
    "wSsspsb",
    "wSssssb",
    "wSssppb",
    "bbbbbbb",
  }, { b = "bark", W = "white", w = "wood", s = "sand", S = "skin", p = "plum", k = "ink" })
  return g, l
end

---------------------------------------------------------------------------------------------------
-- townhall: sandstone ashlar with white dressings, a hipped slate roof, and the clock tower rising
-- from the middle to a copper cupola and a weathervane; an arched door up a flight of steps
---------------------------------------------------------------------------------------------------
-- Ashlar: sand blocks in courses, the joints short ochre dashes, staggered course by course. With
-- TOWNHALL_BRICK set before the run the hall is built in red brick instead, as it was first drawn.
local BRICK = rawget(_G, "TOWNHALL_BRICK")
local HALL = BRICK and { block = "red", joint = "plum", lit = "coral", shade = "plum", ring = "sand" }
                    or { block = "sand", joint = "ochre", lit = "skin", shade = "wood", ring = "white" }
local function ashlar(g, x, y, w, h, phase)
  P.rect(g, x, y, w, h, HALL.block)
  for j = 2, h - 1, 3 do
    local course = j // 3
    for i = 0, w - 1 do
      if (i + phase + course * 3) % 6 < 2 then P.pix(g, x + i, y + j, HALL.joint) end
    end
  end
end
local function townhall()
  local g, l = P.image(38, 56), P.image(38, 56)
  -- the main block: hipped slate roof
  courses(g, 30, 36, function(y) return 6 - (y - 30) end, function(y) return 31 + (y - 30) end,
    { base = "navy", line = "indigo", lite = "steel", dash = 18 }, 0)
  for y = 30, 36 do
    local lx, rx = 6 - (y - 30), 31 + (y - 30)
    P.pix(g, lx, y, "steel"); P.pix(g, rx, y, "indigo")
  end
  P.hline(g, 6, 30, 26, "steel")
  tidy(g, 0, 30, 38, 7, "indigo", "navy")
  P.hline(g, 0, 37, 38, "white"); P.hline(g, 0, 38, 38, "ice")
  -- walls
  ashlar(g, 0, 39, 38, 15, 0)
  P.vline(g, 37, 39, 15, HALL.shade); P.vline(g, 0, 39, 15, HALL.lit)
  P.hline(g, 0, 46, 38, "white"); P.hline(g, 0, 47, 38, "ice")
  P.rect(g, 0, 54, 38, 2, "stone"); P.hline(g, 0, 54, 38, "steel"); P.hline(g, 0, 55, 38, "grey")
  -- the wings' windows, round-headed, in white surrounds
  for _, x in ipairs { 3, 8, 26, 31 } do
    P.hline(g, x + 1, 39, 2, "white")
    casement(g, l, x, 40, 4, 6, "white")
    casement(g, l, x, 48, 4, 5, "white")
  end
  -- the tower
  local T0, T1 = 13, 24
  ashlar(g, T0, 19, 12, 35, 4)
  P.vline(g, T1, 19, 35, HALL.shade); P.vline(g, T0, 19, 35, HALL.lit)
  -- the clock stage, under a cornice
  P.hline(g, T0 - 1, 18, 14, "white"); P.hline(g, T0, 19, 12, "ice")
  P.hline(g, T0 - 1, 30, 14, "white"); P.hline(g, T0, 31, 12, "ice")
  P.rect(g, T0 + 1, 20, T1 - T0 - 1, 10, HALL.block)
  -- a dark blue face in a ring of white stone (of gilt, on brick), lit from behind at night; gilt
  -- hands at four o'clock
  P.disc(g, 18.5, 24.5, 4.5, HALL.ring)
  for _, p in ipairs { { 22, 26 }, { 22, 27 }, { 21, 28 }, { 20, 29 }, { 23, 25 }, { 23, 24 } } do
    if g:getPixel(p[1], p[2]) == P.hex("white") then P.pix(g, p[1], p[2], "ice") end
  end
  P.disc(g, 18.5, 24.5, 3.6, "navy")
  P.disc(l, 18.5, 24.5, 3.6, "skin")
  for _, p in ipairs { { 18, 22 }, { 18, 23 }, { 18, 24 }, { 19, 25 }, { 20, 26 } } do
    P.pix(g, p[1], p[2], "yellow"); P.pix(l, p[1], p[2], nil)
  end
  -- the lantern stage over the clock, with two round-headed louvres
  P.rect(g, T0 + 1, 12, 10, 6, HALL.block); P.vline(g, T1 - 1, 12, 6, HALL.shade); P.vline(g, T0 + 1, 12, 6, HALL.lit)
  P.rect(g, T0 + 1, 12, 1, 6, "white"); P.rect(g, T1 - 1, 12, 1, 6, "ice")
  for _, x in ipairs { 16, 20 } do P.rect(g, x, 13, 2, 5, "ink"); P.hline(g, x, 13, 2, "indigo") end
  P.vline(g, 18, 12, 6, HALL.block); P.vline(g, 19, 12, 6, HALL.block)
  -- the copper cupola
  map(g, 13, 3, {
    ".....cm.....",
    "....ccmm....",
    "..cctttmmm..",
    ".cctttttmmm.",
    ".ctttttttmm.",
    "ctttttttmmmm",
    "ttttttmmmmmm",
  }, { t = "teal", c = "cyan", m = "slate" })
  P.hline(g, 14, 10, 10, "ice"); P.hline(g, 13, 11, 12, "white"); P.pix(g, 24, 11, "ice")
  -- the weathervane: an arrow on a pole that runs down into the cupola's tip, its head pointing
  -- east, a fin at its tail
  map(g, 14, 0, {
    "kk....kk.",
    "kkkkkkkkk",
    "....k.kk.",
    "....k....",
    "....k....",
  }, { k = "ink" })
  -- the door up the steps
  P.rect(g, 15, 44, 8, 10, "white"); P.hline(g, 16, 43, 6, "white"); P.hline(g, 17, 42, 4, "white")
  door(g, 16, 44, 6, 10, "bark", "wood", "yellow")
  P.hline(g, 17, 43, 4, "bark")
  P.rect(g, T0 - 1, 54, 14, 2, "ice"); P.hline(g, T0 - 1, 55, 14, "steel"); P.hline(g, T0 + 1, 54, 10, "white")
  -- a window over the door
  P.hline(g, 18, 33, 2, "white")
  casement(g, l, 17, 34, 4, 7, "white")
  -- a joint the windows have cut down to one pixel goes back to plain stone
  tidy(g, 0, 0, 38, 56, HALL.joint, HALL.block)
  return g, l
end

local BASE = {}
BASE.cottage = { cottage() }
BASE.bakery = { bakery() }
BASE.inn = { inn() }
BASE.townhall = { townhall() }

---------------------------------------------------------------------------------------------------
-- The stages, made as worn.lua makes the village's: each step is the step before it with more done
-- to it, so the same boards, holes and cracks carry through. Its tools, copied, with the ramps
-- reaching the colours these buildings add (pink plaster, purple tiles, a blue door, copper).
---------------------------------------------------------------------------------------------------
local function luma(c) return 0.299 * pc.rgbaR(c) + 0.587 * pc.rgbaG(c) + 0.114 * pc.rgbaB(c) end

-- A pixel that matches none of its eight neighbours takes their commonest colour (worn.lua's last
-- pass); pixels under a light, and pixels placed on purpose (`keep`), stay as they are.
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

local function at(g, x, y)
  if x < 0 or y < 0 or x >= g.width or y >= g.height then return nil end
  local c = g:getPixel(x, y)
  if pc.rgbaA(c) == 0 then return nil end
  return NAME[c] or "?"
end
local function remap(g, m, x, y, w, h)
  x, y, w, h = x or 0, y or 0, w or g.width, h or g.height
  for j = y, y + h - 1 do for i = x, x + w - 1 do
    local n = at(g, i, j)
    if n and m[n] then P.pix(g, i, j, m[n]) end
  end end
end
local function remapAt(g, m, i, j)
  local n = at(g, i, j)
  if n and m[n] then P.pix(g, i, j, m[n]) end
end
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

-- GRIME: dust and damp, one shade down. CRACK: a fissure, two shades down.
local GRIME = { skin = "sand", sand = "ochre", white = "ice", ice = "steel", steel = "stone", stone = "grey",
                grey = "smoke", wood = "bark", teal = "moss", red = "plum", coral = "red", navy = "indigo",
                pink = "stone", purple = "plum", blue = "indigo", sky = "blue", cyan = "teal" }
local CRACK = { skin = "wood", sand = "wood", white = "stone", ice = "stone", steel = "grey", stone = "smoke",
                grey = "slate", wood = "bark", bark = "plum", teal = "slate", moss = "slate", sage = "olive",
                red = "plum", coral = "red", ochre = "bark", pink = "purple", purple = "plum", blue = "indigo" }
-- SOOT: smoke-stained, toward grey. CHAR: blackened, toward slate and ink.
local SOOT = { skin = "stone", sand = "grey", white = "stone", ice = "stone", steel = "grey", stone = "grey",
               grey = "smoke", wood = "smoke", bark = "slate", teal = "slate", moss = "slate", sage = "smoke",
               ochre = "smoke", red = "plum", coral = "red", navy = "slate", indigo = "ink", plum = "ink",
               olive = "slate", yellow = "sand", pink = "stone", purple = "plum", blue = "indigo", sky = "indigo",
               cyan = "slate", grass = "olive", lime = "sage" }
local CHAR = { skin = "smoke", sand = "smoke", white = "grey", ice = "grey", steel = "smoke", stone = "smoke",
               grey = "slate", smoke = "slate", wood = "slate", bark = "ink", teal = "ink", moss = "ink",
               sage = "slate", ochre = "slate", red = "ink", coral = "plum", plum = "ink", navy = "ink",
               indigo = "ink", slate = "ink", olive = "ink", pink = "smoke", purple = "ink", blue = "ink" }
local ROOFSOOT = { red = "plum", coral = "red", bark = "plum", plum = "ink", purple = "plum", pink = "purple" }
local function compose(a, b)
  local r = {}
  for k, v in pairs(a) do r[k] = b[v] or v end
  for k, v in pairs(b) do if r[k] == nil then r[k] = v end end
  return r
end
local SCORCH = { r = ROOFSOOT, q = compose(ROOFSOOT, ROOFSOOT), g = GRIME, s = SOOT, c = compose(SOOT, CHAR),
                 x = compose(compose(SOOT, CHAR), CHAR) }

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

local WALLGRIME = { skin = "sand", sand = "ochre", ice = "steel", steel = "stone", stone = "grey", grey = "smoke",
                    teal = "moss", pink = "stone", red = "plum", white = "ice" }
local function grime(g, x, y, heights, ramp)
  for i = 1, #heights do
    local h = tonumber(heights:sub(i, i))
    for j = 0, h - 1 do remapAt(g, ramp or WALLGRIME, x + i - 1, y - j) end
  end
end
local function streak(g, x, y, n, ramp)
  for j = 0, n - 1 do remapAt(g, ramp or GRIME, x, y + j) end
end

local KEEP
local function protect(x, y) P.pix(KEEP, x, y, "white") end

-- Planks nailed across a casement (worn.lua's board).
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

local CODE = { ["0"] = "black", k = "ink", p = "plum", b = "bark", w = "wood", r = "rust", s = "sand", S = "skin",
  y = "yellow", l = "lime", g = "grass", t = "teal", m = "moss", o = "olive", L = "slate", i = "indigo", n = "navy",
  B = "blue", K = "sky", c = "cyan", I = "ice", W = "white", e = "steel", T = "stone", G = "grey", M = "smoke",
  u = "purple", R = "red", C = "coral", P = "pink", a = "sage", O = "ochre" }
-- Hand touches, one pixel at a time ("." leaves a pixel, "_" clears it), kept from tidying. Any
-- light under a touched pixel goes out, unless `lit` is given.
local function touch(g, x, y, rows, l)
  for j, r in ipairs(rows) do
    for i = 1, #r do
      local k = r:sub(i, i)
      if k == "_" then P.pix(g, x + i - 1, y + j - 1, nil); if l then P.pix(l, x + i - 1, y + j - 1, nil) end
      elseif k ~= "." then
        if not CODE[k] then error("touch has no '" .. k .. "'") end
        P.pix(g, x + i - 1, y + j - 1, CODE[k]); protect(x + i - 1, y + j - 1)
        if l then P.pix(l, x + i - 1, y + j - 1, nil) end
      end
    end
  end
end

local function embers(g, l, list)
  for _, e in ipairs(list) do P.pix(g, e[1], e[2], "black"); P.pix(l, e[1], e[2], e[3]); protect(e[1], e[2]) end
end
local function clearLights(l) P.rect(l, 0, 0, l.width, l.height, nil) end

local function stain(g, y0, edge, ramp, x0)
  x0 = x0 or 0
  for i = 1, #edge do
    local d = tonumber(edge:sub(i, i), 36)
    for y = 0, y0 + d - 1 do remapAt(g, ramp, x0 + i - 1, y) end
  end
end
local function band(g, y0, edge, ramp, x0)
  x0 = x0 or 0
  for i = 1, #edge do
    local d = tonumber(edge:sub(i, i), 36)
    for y = y0, y0 + d - 1 do remapAt(g, ramp, x0 + i - 1, y) end
  end
end
-- The row just under a band's ragged edge, one step stained, so the soot fades out into grime
-- instead of stopping on raw plaster.
local function fringe(g, y0, edge, ramp, x0)
  x0 = x0 or 0
  for i = 1, #edge do
    local d = tonumber(edge:sub(i, i), 36)
    if d > 0 then remapAt(g, ramp, x0 + i - 1, y0 + d) end
  end
end

-- A hole in a roof (worn.lua's): k marks the void; rafters every `pitch` columns leaning a column
-- per `rise` rows (0 stands them upright; `flip` leans them down to the left, as a left verge
-- runs), battens on the rows listed, `rim` lights the broken tile ends under the void, and a
-- P.CLEAR void lets the sky through.
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
    local lean = rise == 0 and 0 or (j + (o.shift or 1)) // rise
    local u = i - (o.flip and -lean or lean) - (o.phase or 0)
    local c = o.void
    if o.pitch and u % o.pitch == 0 then c = o.rafter end
    if batten[j] then c = o.batten or o.rafter end
    P.pix(g, i, j, c)
  end
end

local function sootFrame(g, x, y, w, h) remap(g, SOOT, x - 1, y, w + 2, h) end
local PLUMES = {
  [2] = { short = { ".sc.", "scxs" }, tall = { ".c..", ".scs", "scxs" } },
  [3] = { short = { ".sc..", "scxcs" },
          tall = { "..c..", ".scs.", ".cxc.", "scxcs" } },
  [4] = { short = { ".scs..", "scxxcs" },
          tall = { "..c...", ".scs..", ".cxcs.", "scxxcs" } },
  [5] = { short = { "..sc...", ".scxs..", "sccxccs" },
          tall = { "...c...", "..scs..", "..cxc..", ".scxxs.", "scxxxcs" } },
  [6] = { short = { "..scs...", ".scxcs..", "sccxxccs" },
          tall = { "...cs...", "..scxs..", "..cxxc..", ".scxxcs.", "sccxxccs" } },
  [7] = { short = { "...sc....", "..scxcs..", "sccxxxccs" },
          tall = { "....c....", "...scs...", "..scxcs..", ".scxxxcs.", "sccxxxccs" } },
  [8] = { short = { "...sc.....", "..scxs.sc.", "sccxxcscxs" },
          tall = { "...c......", "..scs..c..", "..cxc.scs.", ".scxxscxcs", "sccxxcscxs" } },
  [10] = { short = { "...sc....cs.", "..scxs..sxcs", "sccxxcsscxcs" },
           tall = { "...c......c.", "..scs....sc.", "..cxcs..scxs", ".scxxs.scxxs", "sccxxcsscxcs" } },
}
local function plume(g, x, y, w, size)
  local rows = assert(PLUMES[w], "no plume " .. w)[size or "short"]
  wash(g, x - 1, y - #rows + 1, rows, SCORCH)
end

-- Every stage of a building, kept with what tidying must leave alone and the picture it started as.
local function snap(list, g, l, orig) list[#list + 1] = { g:clone(), l:clone(), KEEP:clone(), orig } end
---------------------------------------------------------------------------------------------------
-- cottage stages
---------------------------------------------------------------------------------------------------
local CO = {}
do
  local g, l = cottage()
  local ORIG = g:clone(); KEEP = P.image(g.width, g.height)
  local RIM = { grey = "stone", smoke = "grey", stone = "steel" }
  -- the gable over the door, row by row, as cottage() draws it
  local function gable(y) local half = (y + 1) // 2; return 13 - half, 12 + half end
  -- _1 worn: the blue door sun-faded, two slabs slipped, the right window boarded, the roses gone
  -- over, damp along the foot of the walls
  remap(g, { blue = "sky" }, 12, 15, 2, 7)
  touch(g, 13, 16, { "B", "B", "B", "B" })
  hole(g, 5, 6, { "kk" }, { void = "ink", rim = RIM })
  hole(g, 21, 9, { "kk" }, { void = "ink", rim = RIM })
  board(g, l, 16, 14, 4, 5, nil, nil, 15, 19)
  remap(g, { coral = "red", red = "plum", lime = "grass" }, 0, 15, 5, 7)
  touch(g, 3, 16, { "CC" })
  touch(g, 1, 15, { "aa" })
  streak(g, 13, 11, 1)
  grime(g, 5, 21, "1100000011000000111")
  grime(g, 2, 21, "112")
  wash(g, 2, 20, { "...gg..........gg....g" }, { g = GRIME })
  snap(CO, g, l, ORIG)

  -- _2 derelict: the slabs fallen in on the left to the rafters, the glass gone, the door gone and
  -- a plank nailed across the doorway, the chimney cap broken, cracks, the roses dead and dropping
  local LEFT = { void = "ink", rafter = "wood", pitch = 4, phase = 2, flip = true, rim = RIM }
  hole(g, 2, 5, {
    "..kkk..",
    ".kkkkk.",
    "kkkkkkk",
    ".kkkk..",
    "..kk...",
  }, LEFT)
  hole(g, 20, 8, { ".kk.", "kkkk", ".kk." }, { void = "ink", rim = RIM })
  touch(g, 5, 14, { "WWWW", "WekW", "WkkW", "WkkW", "IWWW" }, l)
  touch(g, 12, 8, { "kk", "kk" }, l)
  P.rect(g, 12, 15, 2, 7, "ink")
  P.hline(g, 10, 16, 5, "wood"); P.hline(g, 10, 17, 5, "bark")
  touch(g, 18, 0, { "...__" })
  crack(g, { 9, 15, 10, 16, 10, 17, 9, 18 })
  crack(g, { 16, 6, 16, 7, 15, 8 })
  crack(g, { 21, 2, 21, 3 })
  remap(g, { grass = "ochre", moss = "olive", plum = "bark", red = "bark", sage = "ochre", coral = "bark" }, 0, 15, 5, 7)
  touch(g, 1, 15, { "_e" })
  grime(g, 5, 21, "2211000122110000222")
  grime(g, 2, 21, "223")
  clearLights(l)
  snap(CO, g, l, ORIG)

  KEEP = P.image(g.width, g.height)
  -- _3 scorched: the timbers under the slabs burnt and the roof fallen in on both sides, open to
  -- the sky across its charred rafters; the slabs and the gable blackened to one burnt mass, the
  -- stone smoke-stained from the eave down, soot over every opening, the roses burnt to sticks
  for y = 4, 11 do
    local lx, rx = gable(y)
    for x = 0, g.width - 1 do
      if (x < lx or x > rx) and at(g, x, y) then P.pix(g, x, y, (y == 4 or x == 1) and "smoke" or "slate") end
    end
  end
  for y = 1, 11 do
    local lx, rx = gable(y)
    for x = lx, rx do if at(g, x, y) then P.pix(g, x, y, x == rx and "slate" or "smoke") end end
  end
  P.rect(g, 12, 8, 2, 2, "black")
  -- the holes stop under the top edge, which holds, and the charred rafters hang from it
  hole(g, 1, 5, {
    ".kkkkkk.",
    ".kkkkkkk",
    "kkkkkkkk",
    ".kkkkk..",
    "..kkk...",
  }, { void = P.CLEAR, rafter = "ink", pitch = 4, phase = 2, flip = true, rim = { slate = "smoke" } })
  hole(g, 19, 5, {
    "..kkk.",
    ".kkkk.",
    ".kkkkk",
    "kkkkkk",
    "kkkkk.",
    ".kkk..",
  }, { void = P.CLEAR, rafter = "ink", pitch = 4, phase = 2, rim = { slate = "smoke" } })
  remap(g, compose(SOOT, CHAR), 18, 0, 6, 4)
  band(g, 12, "233334433322223344333332", SOOT, 1)
  band(g, 12, "111111111111111111111111", CHAR, 1)
  sootFrame(g, 5, 14, 4, 5); sootFrame(g, 16, 14, 4, 5)
  plume(g, 5, 14, 4); plume(g, 16, 14, 4)
  plume(g, 11, 14, 4, "tall")
  remap(g, SOOT, 10, 16, 5, 2)
  remap(g, SOOT, 4, 19, 6, 2); remap(g, SOOT, 15, 19, 6, 2)
  remap(g, { ochre = "bark", olive = "ink", bark = "ink", sage = "smoke" }, 0, 15, 5, 7)
  embers(g, l, { { 6, 16, "red" }, { 7, 16, "rust" }, { 12, 9, "rust" }, { 13, 9, "red" }, { 17, 16, "rust" }, { 18, 16, "red" },
                 { 12, 20, "yellow" }, { 13, 20, "rust" }, { 13, 19, "red" } })
  snap(CO, g, l, ORIG)
end
---------------------------------------------------------------------------------------------------
-- bakery stages
---------------------------------------------------------------------------------------------------
local BK = {}
do
  local g, l = bakery()
  local ORIG = g:clone(); KEEP = P.image(g.width, g.height)
  local RIM = { red = "coral", plum = "red", coral = "pink" }
  -- _1 worn: the awning's blue bleached grey, two tiles slipped, the dormer boarded, the loaf's
  -- gilt gone dull, dust along the foot and rain run down from the cornice
  remap(g, { sky = "steel", blue = "indigo" }, 8, 26, 14, 4)
  hole(g, 3, 8, { "kk" }, { void = "ink", rim = RIM })
  hole(g, 16, 10, { "kk" }, { void = "ink", rim = RIM })
  board(g, l, 9, 4, 4, 6, nil, nil, 8, 13)
  remap(g, { skin = "sand" }, 22, 15, 8, 10)
  streak(g, 2, 15, 3); streak(g, 17, 15, 2)
  grime(g, 0, 37, "1"); grime(g, 7, 37, "21"); grime(g, 21, 37, "2")
  wash(g, 1, 36, { "gggggg", "gggggg" }, { g = GRIME })
  wash(g, 9, 37, { "gg....gg..gg" }, { g = GRIME })
  snap(BK, g, l, ORIG)

  -- _2 derelict: the mansard holed to its battens, the glass gone from the upper window and the
  -- shop, the door nailed up, the awning in tatters, the loaf tarnished, cracks in the plaster
  touch(g, 13, 0, { ".....__" })
  local LEFT = { void = "ink", rafter = "wood", pitch = 4, phase = 1, flip = true, rim = RIM }
  local RIGHT = { void = "ink", rafter = "wood", pitch = 4, phase = 1, rim = RIM }
  hole(g, 1, 6, {
    "..kkk.",
    ".kkkkk",
    "kkkkkk",
    ".kkkk.",
    "..k...",
  }, LEFT)
  hole(g, 15, 8, {
    ".kkk..",
    "kkkkkk",
    ".kkk..",
    "..k...",
  }, RIGHT)
  touch(g, 7, 16, {
    "WWWWWWW",
    "WeekkkW",
    "WkkkkkW",
    "WkkkkkW",
    "WkkkkkW",
    "WkkkkkW",
    "WWWWWWP",
  }, l)
  touch(g, 9, 30, {
    "WWWWWWWWWWWW",
    "WIIkkkkkkkkW",
    "WIkkkkkkkkkW",
    "WkkkkkkkkkkW",
    "WkkkkkkkkkkW",
    "WWWWWWWWWWWW",
  }, l)
  touch(g, 3, 29, { "kk", "kk", "kk" }, l)
  P.hline(g, 0, 31, 8, "wood"); P.hline(g, 0, 32, 8, "bark")
  P.hline(g, 1, 34, 6, "wood"); P.hline(g, 1, 35, 6, "bark")
  touch(g, 8, 26, {
    "iiiiiiiiiiiiii",
    "WWeePPWWeePPWW",
    "WWPePPWWPPPPWW",
    "IIPePPPPPPPPII",
  })
  remap(g, { sand = "ochre", wood = "bark" }, 22, 18, 8, 7)
  crack(g, { 3, 16, 4, 17, 4, 19, 3, 20, 3, 22 })
  crack(g, { 18, 26, 19, 27, 19, 28 })
  crack(g, { 16, 17, 17, 18, 17, 20 })
  grime(g, 0, 37, "2"); grime(g, 7, 37, "32"); grime(g, 21, 37, "3")
  clearLights(l)
  snap(BK, g, l, ORIG)

  KEEP = P.image(g.width, g.height)
  -- _3 scorched: the mansard burnt off its rafters to the sky, the plaster blackened from the
  -- cornice down, soot pouring up from every opening, the awning burnt to rags
  hole(g, 1, 3, {
    "....kk..",
    "..kkkkk.",
    ".kkkkkkk",
    "kkkkkkkk",
    "kkkkkkk.",
    "kkkkkk..",
    ".kkkk...",
    "..kk....",
  }, { void = P.CLEAR, rafter = "ink", pitch = 4, phase = 1, flip = true, battens = { 5 }, rim = RIM })
  hole(g, 15, 5, {
    "...kk.",
    ".kkkkk",
    "kkkkkk",
    "kkkkkk",
    "kkkkkk",
    ".kkkk.",
    "..k...",
  }, { void = P.CLEAR, rafter = "ink", pitch = 4, phase = 1, battens = { 5 }, rim = RIM })
  remap(g, compose(ROOFSOOT, { coral = "red" }), 0, 2, 22, 11)
  remap(g, compose(SOOT, CHAR), 7, 2, 8, 9)
  remap(g, compose(SOOT, CHAR), 13, 0, 6, 6)
  remap(g, SOOT, 0, 13, 22, 2)
  -- the plaster smoked from the cornice down: grey above, a ragged purple stain below it, so no
  -- clean pink is left upstairs
  band(g, 15, "4433444445544444434443", SOOT)
  band(g, 15, "1100111001000111001100", CHAR)
  band(g, 15, "6655775566776655775566", SOOT)
  band(g, 15, "999999999999999999999", { pink = "purple" })
  sootFrame(g, 7, 16, 7, 7)
  plume(g, 7, 16, 7, "tall")
  remap(g, SOOT, 0, 24, 22, 2)
  remap(g, { white = "smoke", steel = "slate", ice = "smoke", indigo = "ink", pink = "stone" }, 8, 26, 14, 4)
  touch(g, 14, 28, { "TT" })
  plume(g, 9, 30, 10)
  sootFrame(g, 2, 28, 4, 4)
  plume(g, 3, 29, 2, "tall")
  remap(g, SOOT, 0, 31, 8, 5)
  -- downstairs the stain reaches the piers too; clean pink is left only at their feet
  band(g, 26, "865555588", { pink = "purple" }, 0)
  -- the shopfront's white frames and the stall board smoked with the rest
  local FRAME = { white = "stone", ice = "stone", teal = "slate", sand = "grey", wood = "smoke" }
  remap(g, FRAME, 1, 27, 6, 11); remap(g, FRAME, 9, 30, 12, 8)
  remap(g, compose(SOOT, CHAR), 22, 15, 8, 10)
  embers(g, l, { { 9, 19, "red" }, { 10, 19, "rust" }, { 11, 21, "rust" }, { 12, 21, "red" }, { 12, 31, "red" }, { 13, 31, "rust" },
                 { 16, 33, "yellow" }, { 17, 33, "rust" }, { 3, 30, "red" }, { 4, 30, "rust" }, { 10, 6, "rust" }, { 11, 6, "red" },
                 { 4, 11, "red" }, { 5, 11, "rust" } })
  snap(BK, g, l, ORIG)
end
---------------------------------------------------------------------------------------------------
-- inn stages
---------------------------------------------------------------------------------------------------
local IN = {}
do
  local g, l = inn()
  local ORIG = g:clone(); KEEP = P.image(g.width, g.height)
  local RIM = { purple = "pink", plum = "purple", pink = "skin" }
  -- what stands behind the sign under the jetty's left end, for when it moves
  local function bare(img)
    for y = 23, 33 do for x = 0, 6 do
      local c
      if x == 2 then c = y == 33 and "plum" or y == 23 and "wood" or "bark"
      elseif x > 2 then
        if y == 23 then c = "wood" elseif y == 33 then c = "plum" elseif y == 31 then c = "stone" elseif y == 32 then c = "grey"
        else c = "sand" end
      end
      P.pix(img, x, y, c)
    end end
  end
  -- _1 worn: tiles slipped, an upper window boarded, the sign faded, dust along the plinth
  hole(g, 8, 8, { "kk" }, { void = "ink", rim = RIM })
  hole(g, 21, 10, { "kk" }, { void = "ink", rim = RIM })
  board(g, l, 12, 15, 5, 5, nil, nil, 11, 17)
  remap(g, { plum = "bark", white = "ice", skin = "sand" }, 1, 25, 5, 6)
  streak(g, 6, 20, 1); streak(g, 36, 20, 1)
  grime(g, 3, 30, "11221100000000000000000000112211000")
  wash(g, 3, 31, { "gg.......gg....................gg...." }, { g = GRIME })
  snap(IN, g, l, ORIG)

  -- _2 derelict: the long roof open to its rafters, the glass gone, the door gone, the lantern
  -- dead, and the sign come down off its chains
  hole(g, 9, 7, {
    ".kkkkkk..",
    "kkkkkkkkk",
    ".kkkkkkk.",
    ".kkkk....",
    "..kk.....",
  }, { void = "ink", rafter = "wood", pitch = 4, phase = 3, flip = true, rim = RIM })
  touch(g, 31, 8, { "bbbb", "bkkb", "bkkb", "bbbb" }, l)
  for _, x in ipairs { 4, 27 } do touch(g, x, 15, { "bbbbb", "bekkb", "bkkkb", "bkkkb", "bbbbb" }, l) end
  touch(g, 34, 15, { "bbbbb", "bkkeb", "bkkkb", "bkkkb", "bbbbb" }, l)
  touch(g, 8, 25, { "bbbbb", "bekkb", "bkkkb", "bkkkb", "bkkkb", "bbbbb" }, l)
  touch(g, 31, 25, { "bbbbbbb", "bkkkkeb", "bkkkkkb", "bkkkkkb", "bkkkkkb", "bbbbbbb" }, l)
  P.rect(g, 18, 26, 4, 8, "ink")
  touch(g, 14, 26, { "kkk", "LLk", "LLk", "kkk" }, l)
  grime(g, 3, 30, "22332211000000000000000000223322110")
  -- the sign: both chains hang empty from the jetty, one snapped short, and the board has come
  -- down and stands propped at the foot of the post, its face tipped back to the sky
  local board7 = Image(g, Rectangle(0, 24, 7, 8))
  bare(g)
  for k, j in ipairs { 0, 1, 4, 5, 7 } do
    for i = 0, 6 do
      local c = board7:getPixel(i, j)
      if pc.rgbaA(c) > 0 then g:drawPixel(i, 28 + k, c); protect(i, 28 + k) end
    end
  end
  touch(g, 0, 23, { ".p...k.", ".....k." })
  crack(g, { 22, 14, 22, 15, 23, 16 })
  crack(g, { 13, 24, 14, 25, 14, 26 })
  crack(g, { 26, 23, 27, 24, 27, 25 })
  clearLights(l)
  snap(IN, g, l, ORIG)

  KEEP = P.image(g.width, g.height)
  -- _3 scorched: the roof burnt off its rafters to the sky, the timbers and plaster blackened from
  -- the eave, soot from every opening; the fallen sign charred where it stands at the foot
  -- the hole stops short of the chimney, and the ridge holds: the charred rafters hang from it
  hole(g, 9, 7, {
    ".kkkkkkkkkkkkk...",
    "kkkkkkkkkkkkkkkk.",
    "kkkkkkkkkkkkkkkkk",
    "kkkkkkkkkkkkkkk..",
    ".kkkkkkkkkkkk....",
    "...kkkkkkkk......",
  }, { void = P.CLEAR, rafter = "ink", pitch = 4, phase = 3, flip = true, rim = { purple = "pink", plum = "purple" } })
  hole(g, 29, 5, {
    "..kk..",
    ".kkkk.",
    ".kk...",
  }, { void = P.CLEAR, rim = { sand = "grey", bark = "slate" } })
  remap(g, compose(ROOFSOOT, { sand = "grey" }), 0, 4, 42, 9)
  remap(g, { sand = "smoke", bark = "slate", wood = "smoke", navy = "ink" }, 24, 4, 18, 9)
  remap(g, compose(SOOT, CHAR), 3, 0, 6, 9)
  -- the upper storey: its timbers charred to slate, the plaster between smoked grey right down to
  -- the jetty beam (so none is left raw under a window to read as a lit sill), and darker under
  -- the eave; only the openings go black
  remap(g, { bark = "slate", wood = "smoke", plum = "ink" }, 0, 13, 42, 10)
  band(g, 13, string.rep("8", 42), SOOT)
  band(g, 13, "223322332222333223322222333322322333222233", { grey = "smoke" })
  band(g, 13, "110011001111000110011111000011011000111100", { smoke = "slate" })
  for _, x in ipairs { 4, 12, 27, 34 } do plume(g, x, 15, 5) end
  -- and the ground floor to a row above the plinth, which is left grimed
  band(g, 23, "00" .. string.rep("7", 38) .. "00", SOOT, 0)
  fringe(g, 23, "00" .. string.rep("7", 38) .. "00", GRIME, 0)
  remap(g, { bark = "slate" }, 2, 23, 38, 11)
  plume(g, 8, 25, 5, "tall"); plume(g, 31, 25, 7)
  plume(g, 18, 26, 4)
  remap(g, compose(SOOT, CHAR), 14, 24, 3, 6)
  remap(g, SOOT, 24, 26, 6, 8)
  -- the propped sign charred where it stands
  remap(g, compose(SOOT, CHAR), 0, 29, 7, 5)
  touch(g, 0, 23, { ".k...k.", ".....k." })
  embers(g, l, { { 6, 17, "red" }, { 7, 17, "rust" }, { 29, 16, "rust" }, { 29, 17, "red" }, { 36, 17, "rust" }, { 10, 28, "red" },
                 { 10, 29, "rust" }, { 19, 30, "rust" }, { 20, 30, "yellow" }, { 19, 31, "red" }, { 33, 28, "red" }, { 34, 28, "rust" },
                 { 32, 9, "rust" }, { 33, 10, "red" }, { 5, 32, "rust" }, { 6, 32, "red" }, { 36, 18, "red" } })
  snap(IN, g, l, ORIG)
end
---------------------------------------------------------------------------------------------------
-- townhall stages
---------------------------------------------------------------------------------------------------
local TH = {}
do
  local g, l = townhall()
  local ORIG = g:clone(); KEEP = P.image(g.width, g.height)
  local RIM = { navy = "steel", indigo = "steel" }
  local BRICKCRACK = { sand = "wood", skin = "sand", ochre = "bark", wood = "bark", white = "stone", ice = "stone",
                       red = "plum", coral = "red" }
  -- _1 worn: slates slipped, the copper streaked, a window boarded, the brick dusty at its foot
  hole(g, 6, 34, { "kk" }, { void = "ink", rim = RIM })
  hole(g, 29, 32, { "kk" }, { void = "ink", rim = RIM })
  touch(g, 16, 6, { "t", "t" }); touch(g, 21, 7, { "m", "m" })
  board(g, l, 3, 48, 4, 5, nil, nil, 2, 7)
  streak(g, 15, 32, 2, { sand = "ochre", skin = "sand", red = "plum", coral = "red" })
  streak(g, 22, 32, 2, { sand = "ochre", red = "plum" })
  grime(g, 0, 53, "1122110011221100000000000011221100112")
  grime(g, 0, 55, "11001100110011000000000000110011001100", { grey = "smoke", steel = "stone" })
  snap(TH, g, l, ORIG)

  -- _2 derelict: the roof open to its rafters on both hips, the dome holed, the vane's tail gone, the
  -- clock stopped at half past six with its glass cracked, windows broken or boarded, the door
  -- nailed shut
  hole(g, 3, 31, {
    "...kkkkk..",
    "..kkkkkkkk",
    ".kkkkkkk..",
    "...kkkkk..",
    ".....kk...",
  }, { void = "ink", rafter = "wood", pitch = 4, phase = 1, flip = true, rim = RIM })
  hole(g, 27, 32, {
    "..kkk.",
    "kkkkkk",
    ".kkkk.",
    "..k...",
  }, { void = "ink", rafter = "wood", pitch = 4, phase = 1, rim = RIM })
  hole(g, 15, 5, {
    ".kk.",
    "kkkk",
    "kkk.",
  }, { void = "ink", rafter = "teal", pitch = 3, phase = 1, rise = 0, rim = { teal = "cyan", slate = "teal" } })
  -- the vane's tail fin gone
  touch(g, 14, 0, { "__", "__" })
  -- the clock: stopped at half past six, both hands hanging straight down, the glass cracked from
  -- the rim to the middle and a chip gone out of the face by ten o'clock
  for _, p in ipairs { { 18, 22 }, { 18, 23 }, { 18, 24 }, { 19, 25 }, { 20, 26 } } do P.pix(g, p[1], p[2], "navy") end
  touch(g, 18, 24, { "s", "s", "s", "s" })
  touch(g, 19, 25, { "k..", ".k.", "..k" })
  touch(g, 16, 22, { "kk", "k." })
  -- the glass gone from the upper windows and the tower's, boards over two of the lower ones
  touch(g, 3, 40, { "WWWW", "WekW", "WkkW", "WkkW", "WkkW", "WWWW" }, l)
  touch(g, 31, 40, { "WWWW", "WkeW", "WkkW", "WkkW", "WkkW", "WWWW" }, l)
  touch(g, 8, 40, { "WWWW", "WkkW", "WkkW", "WkkW", "WkkW", "WWWW" }, l)
  touch(g, 26, 48, { "WWWW", "WekW", "WkkW", "WkkW", "WWWW" }, l)
  touch(g, 26, 40, { "WWWW", "WkeW", "WkkW", "WkkW", "WkkW", "WWWW" }, l)
  touch(g, 8, 48, { "WWWW", "WkkW", "WkkW", "WkkW", "WWWW" }, l)
  board(g, l, 31, 48, 4, 5, nil, nil, 30, 35)
  touch(g, 17, 34, { "WWWW", "WekW", "WkkW", "WkkW", "WkkW", "WkkW", "WWWW" }, l)
  P.hline(g, 14, 46, 10, "wood"); P.hline(g, 14, 47, 10, "bark")
  P.hline(g, 15, 50, 8, "wood"); P.hline(g, 15, 51, 8, "bark")
  crack(g, { 12, 41, 12, 42, 11, 43, 11, 44 }, BRICKCRACK)
  crack(g, { 23, 35, 22, 36, 22, 38 }, BRICKCRACK)
  crack(g, { 35, 49, 36, 50, 36, 52 }, BRICKCRACK)
  crack(g, { 15, 13, 15, 15, 14, 16 }, BRICKCRACK)
  grime(g, 0, 53, "2233221122332211000000000022332211223")
  clearLights(l)
  snap(TH, g, l, ORIG)

  KEEP = P.image(g.width, g.height)
  -- _3 scorched: the roof burnt off its rafters, the dome burnt open to its ribs, the tower black
  -- from the vane to the clock and smoke-stained below, the clock face gone, soot from every window
  hole(g, 1, 30, {
    "............",
    "....kkkkkkkk",
    "..kkkkkkkkkk",
    ".kkkkkkkkkk.",
    "..kkkkkkkk..",
    "....kkkkk...",
  }, { void = P.CLEAR, rafter = "ink", pitch = 4, phase = 1, flip = true, rim = RIM })
  hole(g, 25, 30, {
    "............",
    "kkkkkkkk....",
    "kkkkkkkkkk..",
    ".kkkkkkkkk..",
    "..kkkkkk....",
    "....kk......",
  }, { void = P.CLEAR, rafter = "ink", pitch = 4, phase = 1, rim = RIM })
  remap(g, { navy = "slate", indigo = "ink", steel = "grey" }, 0, 30, 38, 7)
  remap(g, compose(compose(SOOT, CHAR), CHAR), 12, 0, 14, 12)
  -- the vane burnt down to a stub of its arrow on the pole, the dome burnt to its outline and a
  -- centre rib
  touch(g, 14, 0, { "______kk_", "____kkkk_", "____k.__." })
  touch(g, 13, 3, {
    ".....kk.....",
    "....M__k....",
    "..MM_k__kk..",
    ".M___k___k..",
    ".M___k___kk.",
    "M____k____k.",
    "kkkkkkkkkkkk",
  })
  remap(g, compose(SOOT, CHAR), 12, 12, 14, 8)
  remap(g, SOOT, 12, 20, 14, 12)
  -- the clock face burnt out to a black hole inside its ring
  P.disc(g, 18.5, 24.5, 3.6, "black")
  for _, p in ipairs { { 18, 21 }, { 19, 21 }, { 15, 24 }, { 15, 25 }, { 22, 24 }, { 22, 25 } } do P.pix(g, p[1], p[2], "black") end
  touch(g, 18, 24, { "k", "k", "k" })
  P.disc(KEEP, 18.5, 24.5, 4.6, "white")
  remap(g, SOOT, 0, 37, 38, 2)
  band(g, 39, "4433443344334", SOOT, 0)
  band(g, 32, "99aa9aa9aa99", SOOT, 13)
  band(g, 39, "4334433443344", SOOT, 25)
  for _, x in ipairs { 3, 8, 26, 31 } do sootFrame(g, x, 40, 4, 6); plume(g, x, 40, 4) end
  plume(g, 17, 34, 4, "tall")
  remap(g, SOOT, 0, 46, 38, 2)
  remap(g, { white = "ice", ice = "steel" }, 0, 48, 38, 6)
  -- the ground floor smoke-stained under the cornice and grimed below, its stone left clean only in
  -- patches at the foot
  band(g, 48, "44554433554444553344554433445544335544", GRIME, 0)
  band(g, 48, "22331122332211223322112233221122332211", SOOT, 0)
  remap(g, SOOT, 13, 42, 2, 6); remap(g, SOOT, 23, 42, 2, 6)
  remap(g, SOOT, 15, 42, 8, 4)
  plume(g, 16, 44, 6, "tall")
  plume(g, 26, 48, 4)
  embers(g, l, { { 18, 23, "yellow" }, { 19, 23, "rust" }, { 17, 26, "red" }, { 17, 27, "rust" }, { 16, 15, "red" }, { 16, 16, "rust" },
                 { 21, 16, "rust" }, { 21, 17, "red" }, { 4, 43, "red" }, { 5, 43, "rust" }, { 9, 42, "rust" }, { 9, 43, "red" },
                 { 32, 43, "red" }, { 32, 44, "rust" }, { 18, 37, "red" }, { 18, 38, "rust" }, { 27, 50, "rust" }, { 28, 50, "red" },
                 { 9, 33, "red" }, { 9, 34, "rust" }, { 29, 33, "rust" }, { 29, 34, "red" } })
  snap(TH, g, l, ORIG)
end
---------------------------------------------------------------------------------------------------
-- Burnt-out shells, in hell's colours (its ruin1 and ruin2): ink outlines, a grey lit face, smoke,
-- slate in shade, black where there is nothing left inside, embers in the lights.
---------------------------------------------------------------------------------------------------
local RUINS = {}
local RU = { k = "ink", s = "slate", m = "smoke", g = "grey", t = "stone", b = "black", p = "plum", B = "bark" }
-- A wall of masonry between a ragged top and the ground: `tops` gives the top row per column from
-- x; the first column is the outline, the next lit, the last two shaded and the outline again.
local function wall(g, x, tops, bottom)
  local n = #tops
  for i = 1, n do
    local top = tops[i]
    for y = top, bottom do
      local c = "smoke"
      if i == 1 or i == n then c = "ink" elseif i == 2 then c = "grey" elseif i >= n - 2 then c = "slate" end
      P.pix(g, x + i - 1, y, c)
    end
    P.pix(g, x + i - 1, top, "ink")
    -- the broken top catches the light a row below its edge
    if i > 1 and i < n and top < bottom then P.pix(g, x + i - 1, top + 1, i >= n - 2 and "smoke" or "grey") end
  end
end
-- The ground course: dressed stones in grey and stone, a smoke course, ink at the foot.
local function plinth(g, x, y, w)
  for i = 0, w - 1 do
    P.pix(g, x + i, y, (i % 3 == 2) and "stone" or "grey")
    P.pix(g, x + i, y + 1, (i % 4 == 1) and "ink" or "slate")
  end
  P.pix(g, x, y, "ink"); P.pix(g, x + w - 1, y, "ink")
end
local function glow(g, l, list) for _, e in ipairs(list) do P.pix(g, e[1], e[2], "black"); P.pix(l, e[1], e[2], e[3]) end end

do
  -- ruin4: the town hall burnt out. Its clock tower stands as a shell, the louvres, the round
  -- hole of the clock, the window and the door all open to the black inside; of the wings only
  -- ragged stumps of wall are left either side
  local g, l = P.image(26, 46), P.image(26, 46)
  wall(g, 0, { 36, 33, 32, 34, 33, 35, 37 }, 43)
  wall(g, 19, { 38, 35, 34, 32, 33, 36, 37 }, 43)
  P.rect(g, 2, 37, 2, 4, "black"); P.pix(g, 2, 37, "ink"); P.pix(g, 3, 37, "ink")
  P.rect(g, 21, 38, 2, 4, "black"); P.pix(g, 21, 38, "ink"); P.pix(g, 22, 38, "ink")
  wall(g, 7, { 0, 0, 1, 3, 5, 6, 6, 4, 3, 2, 3, 3 }, 43)
  -- the brick dashes and the ledges of the old cornices
  for _, d in ipairs { { 9, 27 }, { 14, 33 }, { 9, 38 }, { 15, 21 } } do P.hline(g, d[1], d[2], 2, "slate") end
  for _, y in ipairs { 8, 20 } do
    P.hline(g, 6, y, 14, "grey"); P.hline(g, 6, y + 1, 14, "slate")
    P.pix(g, 6, y, "ink"); P.pix(g, 19, y, "ink"); P.pix(g, 6, y + 1, "ink"); P.pix(g, 19, y + 1, "ink")
  end
  -- the louvres, broken open at the top
  for _, x in ipairs { 10, 14 } do P.rect(g, x, 3, 2, 5, "black") end
  P.rect(g, 10, 3, 2, 1, nil); P.pix(g, 10, 4, "ink")
  -- the clock's round hole
  P.disc(g, 12.5, 14.5, 4.5, "ink")
  P.disc(g, 12.5, 14.5, 3.6, "black")
  for _, p in ipairs { { 9, 12 }, { 10, 11 }, { 9, 13 } } do P.pix(g, p[1], p[2], "grey") end
  -- the window and the door, round-headed
  P.rect(g, 11, 24, 4, 7, "black"); P.hline(g, 12, 23, 2, "black")
  P.rect(g, 10, 33, 6, 11, "black"); P.hline(g, 11, 32, 4, "black"); P.hline(g, 11, 31, 4, "ink")
  P.vline(g, 9, 32, 12, "ink"); P.vline(g, 16, 32, 12, "ink")
  -- rubble against the foot, and the ground course
  P.map(g, 0, 41, {
    "..........................",
    ".kk...................kkk.",
    "kmgk.kk.........kk...kgmsk",
  }, RU)
  plinth(g, 0, 44, 26)
  glow(g, l, { { 12, 40, "rust" }, { 13, 41, "yellow" }, { 12, 42, "red" }, { 14, 39, "red" }, { 12, 14, "red" }, { 13, 16, "rust" },
               { 12, 28, "rust" }, { 13, 29, "red" }, { 15, 5, "rust" }, { 10, 6, "red" }, { 3, 39, "red" }, { 22, 40, "rust" }, { 5, 43, "red" } })
  RUINS[#RUINS + 1] = { "ruin4", g, l, "the town hall burnt out: the tower's shell, stumps of the wings" }
end

do
  -- ruin5: a small house burnt to its chimney and a corner of wall. The chimney stands at the left
  -- to its pot, the hearth open at its foot; at the right the corner where two walls met still
  -- stands, the front face with its window hole and the side return in shade; a rafter has fallen
  -- against it from the rubble between
  local g, l = P.image(30, 20), P.image(30, 20)
  -- the chimney and its breast
  wall(g, 3, { 0, 0, 0, 0, 0 }, 10)
  wall(g, 1, { 11, 10, 10, 10, 10, 10, 10, 10, 11 }, 17)
  P.map(g, 2, 1, { "kgmmssk" }, RU)
  P.rect(g, 3, 13, 4, 5, "black"); P.hline(g, 4, 12, 2, "black"); P.pix(g, 3, 12, "ink"); P.pix(g, 6, 12, "ink")
  -- the corner: the front face, its broken top rising to the corner, then the side return
  local tops = { 14, 12, 12, 11, 9, 9, 7, 7, 5, 3 }
  for i, top in ipairs(tops) do
    local x = 15 + i
    for y = top, 17 do P.pix(g, x, y, i == 1 and "ink" or i == 2 and "grey" or "smoke") end
    P.pix(g, x, top, "ink")
    if i > 1 then P.pix(g, x, top + 1, "grey") end
  end
  for y = 4, 17 do P.pix(g, 25, y, (y // 2) % 2 == 0 and "stone" or "grey") end
  for i, top in ipairs { 3, 4, 5 } do
    local x = 25 + i
    for y = top, 17 do P.pix(g, x, y, i == 3 and "ink" or "slate") end
    P.pix(g, x, top, "ink")
  end
  P.pix(g, 25, 3, "ink"); P.pix(g, 24, 4, "ink")
  -- the window hole in the front face, its lintel still across it
  P.hline(g, 19, 10, 4, "slate")
  P.rect(g, 20, 11, 3, 4, "black")
  -- the rafter fallen against the corner from the rubble
  P.line(g, 11, 16, 18, 9, "ink"); P.line(g, 11, 15, 17, 9, "smoke")
  P.map(g, 8, 13, {
    "........",
    "..k.....",
    ".kgk...k",
    "kgmmk.kg",
    "kmmmmkgg",
  }, RU)
  plinth(g, 0, 18, 30)
  glow(g, l, { { 4, 16, "yellow" }, { 5, 16, "rust" }, { 5, 15, "red" }, { 4, 14, "rust" }, { 21, 13, "red" }, { 21, 14, "rust" },
               { 20, 14, "red" }, { 13, 17, "red" } })
  RUINS[#RUINS + 1] = { "ruin5", g, l, "a small house burnt to its chimney and a corner of wall" }
end
---------------------------------------------------------------------------------------------------
-- Sheet
---------------------------------------------------------------------------------------------------
local STEP = { "worn", "derelict", "scorched" }
local NOTE = { cottage = "stone cottage, slab roof, gable over the door", bakery = "pink bakery, mansard, loaf sign right",
               inn = "jettied timber inn, front gable right", townhall = (BRICK and "far row; brick" or "far row; sandstone") .. " town hall, clock tower" }
local function building(name, stages)
  local b = BASE[name]
  local w, h = b[1].width, b[1].height
  sprite(name, w, h, 1, NOTE[name], function() return b[1], b[2] end)
  for k = 1, #stages do
    sprite(name .. "_" .. k, w, h, 1, name .. ", " .. STEP[k], function()
      local g, l, keep, orig = table.unpack(stages[k])
      g, l = g:clone(), l:clone()
      tidyAll(g, l, keep, orig)
      return g, l
    end)
  end
end
building("townhall", TH)
building("inn", IN)
building("bakery", BK)
building("cottage", CO)
for _, r in ipairs(RUINS) do sprite(r[1], r[2].width, r[2].height, 1, r[4], function() return r[2], r[3] end) end

P.save(S, ART, 3)

---------------------------------------------------------------------------------------------------
-- Previews: town-stages.png, each building through its stages into a shell it can leave (the
-- bakery and the inn may leave any of ruin1, ruin2 and ruin5), untinted over the day sky and then
-- multiplied by each stage's light over the evening sky with its lights on top; town-scene.png, the new buildings among the village's on the field, by day
-- and in the late evening light.
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
local VILLAGE, GROUND, HELL = family("village"), family("ground"), family("hell")
local mine = {}
for _, e in ipairs(S.sprites) do mine[e.name] = e end
local function frameOf(name, f)
  local fam = mine[name] and { base = S.base, lights = S.lights, sprites = mine } or
              (VILLAGE.sprites[name] and VILLAGE or HELL)
  local s = assert(fam.sprites[name], "no sprite " .. name)
  local g, l = P.image(s.w, s.h), P.image(s.w, s.h)
  P.blit(g, fam.base, 0, 0, s.x + (f or 0) * s.w, s.y, s.w, s.h)
  P.blit(l, fam.lights, 0, 0, s.x + (f or 0) * s.w, s.y, s.w, s.h)
  return g, l
end
local function multiply(c, t)
  local tr, tg, tb = tonumber(t:sub(2, 3), 16), tonumber(t:sub(4, 5), 16), tonumber(t:sub(6, 7), 16)
  return pc.rgba(pc.rgbaR(c) * tr // 255, pc.rgbaG(c) * tg // 255, pc.rgbaB(c) * tb // 255, 255)
end
-- A sprite at x, y as it is, and `dy` lower multiplied by light t with its lights over it.
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

local LIGHTS = { "#FFFFFF", "#D49989", "#AA5E66", "#B15C60", "#C35855" }
local function stages(path, rows, zoom)
  local cellW, gap, cols = 44, 4, 0
  local heights, total = {}, gap
  for r, row in ipairs(rows) do
    local h = 0
    for _, c in ipairs(row) do h = math.max(h, (frameOf(c[1], c[2])).height) end
    heights[r] = h; total = total + h + gap
    cols = math.max(cols, #row)
  end
  local W = gap + cols * (cellW + gap)
  local out = P.image(W, total * 2)
  P.rect(out, 0, 0, W, total, "#72EAD0"); P.rect(out, 0, total, W, total, "#E2793C")
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
local function has(n) return mine[n] ~= nil end
local ROWS = {}
for _, b in ipairs { { "cottage", "ruin5" }, { "bakery", "ruin2" }, { "inn", "ruin1" }, { "townhall", "ruin4" } } do
  local row = { { b[1] } }
  for k = 1, 3 do if has(b[1] .. "_" .. k) then row[#row + 1] = { b[1] .. "_" .. k } end end
  if has(b[2]) or HELL.sprites[b[2]] then row[#row + 1] = { b[2], 0, LIGHTS[5] } end
  ROWS[#ROWS + 1] = row
end
stages(ART .. "/town-stages.png", ROWS, 3)
-- While drawing, CLOSE = { { name, frame, light }, ... } gives one row at a closer zoom.
if rawget(_G, "CLOSE") then stages(ART .. "/town-w-close.png", { CLOSE }, rawget(_G, "CLOSEZOOM") or 8) end

do
  local W, H = 420, 86
  local out = P.image(W, H * 2)
  P.rect(out, 0, 0, W, H, "#72EAD0"); P.rect(out, 0, H, W, H, "#E2793C")
  local fg = P.image(32, 26)
  for x = 0, W - 1, 32 do
    local s = GROUND.sprites.field0
    P.blit(fg, GROUND.base, 0, 0, s.x + (x // 32 % 2) * s.w, s.y, s.w, s.h)
    place(out, fg, P.image(32, 26), x, H - 26, H, "#BF7B77")
  end
  -- back row on the field's top edge, main row a few pixels further down
  local back = { { "church", 6 }, { "townhall", 120 }, { "windmill", 250 }, { "townhall", 330 } }
  for _, b in ipairs(back) do
    local g, l = frameOf(b[1]); place(out, g, l, b[2], H - 26 - g.height + 2, H, "#BF7B77")
  end
  local row = { "house1", "cottage", "oak1", "bakery", "house3", "inn", "poplar", "cottage", "house2", "sheep",
                "bakery", "oak2", "inn", "house4" }
  local x = 2
  for _, n in ipairs(row) do
    local g, l = frameOf(n)
    if x + g.width > W then break end
    place(out, g, l, x, H - 16 - g.height, H, "#BF7B77")
    x = x + g.width + 3
  end
  local fence = frameOf("fence")
  for fx = 0, W - 1, 16 do place(out, fence, P.image(16, 7), fx, H - 8, H, "#BF7B77") end
  write(out, 3, ART .. "/town-scene.png")
end
