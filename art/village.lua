-- village.lua: the storybook village and its countryside. The ground under it is ground.lua.
local P = dofile(ART .. "/px.lua")
local S = P.sheet("village", 512, 512)

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

-- P.map with every row checked: a row of the wrong width is a typo, not a shape.
local function map(g, x, y, rows, legend)
  for j, r in ipairs(rows) do
    if #r ~= #rows[1] then error("row " .. j .. " is " .. #r .. " wide, expected " .. #rows[1] .. ": " .. r) end
  end
  P.map(g, x, y, rows, legend)
end

-- Clears the lone nubs a disc leaves at its four extremes.
local function despur(g)
  local solid = function(x, y)
    return x >= 0 and y >= 0 and x < g.width and y < g.height and app.pixelColor.rgbaA(g:getPixel(x, y)) > 0
  end
  local spurs = {}
  for y = 0, g.height - 1 do for x = 0, g.width - 1 do
    if solid(x, y) then
      local n = (solid(x + 1, y) and 1 or 0) + (solid(x - 1, y) and 1 or 0) + (solid(x, y + 1) and 1 or 0) + (solid(x, y - 1) and 1 or 0)
      if n <= 1 then spurs[#spurs + 1] = { x, y } end
    end
  end end
  for _, s in ipairs(spurs) do P.pix(g, s[1], s[2], nil) end
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

-- Roof courses that follow the slope. Each course is a soft line with staggered gaps and a short
-- highlight dash; `lean` slides the pattern sideways per row so it runs down the pitch.
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

-- A casement: frame, dark panes with a day glint, and the same panes glowing in the lights.
-- The transom only appears from 7 rows up; on anything shorter it would leave one-pixel panes. A
-- short narrow pane stays all navy: splitting it would leave a lone dark pixel at its foot.
local function casement(g, l, x, y, w, h, frame)
  local rows = h - 2
  P.rect(g, x, y, w, h, frame)
  P.rect(g, x + 1, y + 1, w - 2, rows, "ink")
  P.rect(g, x + 1, y + 1, w - 2, (rows <= 3 and w <= 5) and rows or (rows + 1) // 2, "navy")
  P.rect(l, x + 1, y + 1, w - 2, rows, "yellow")
  P.rect(l, x + 1, y + h - 2, w - 2, 1, "sand")
  if w >= 5 then
    P.vline(g, x + w // 2, y + 1, rows, frame)
    P.vline(l, x + w // 2, y + 1, rows, nil)
  end
  if h >= 7 then
    P.hline(g, x + 1, y + h // 2, w - 2, frame)
    P.hline(l, x + 1, y + h // 2, w - 2, nil)
  end
end

-- Shutters either side of a casement and a flower box under it.
local function dressed(g, l, x, y, w, h, shutter, shade)
  casement(g, l, x, y, w, h, "white")
  P.rect(g, x - 2, y, 2, h, shutter); P.vline(g, x - 2, y, h, shade)
  P.rect(g, x + w, y, 2, h, shutter); P.vline(g, x + w + 1, y, h, shade)
end

-- An arched plank door, outlined in bark, with a brass handle.
local function door(g, x, y, w, h)
  P.rect(g, x, y + 1, w, h - 1, "bark")
  P.hline(g, x + 1, y, w - 2, "bark")
  P.rect(g, x + 1, y + 1, w - 2, h - 1, "wood")
  for i = x + 2, x + w - 2, 2 do P.vline(g, i, y + 2, h - 2, "bark") end
  P.vline(g, x + w - 2, y + h // 2, 2, "sand")
end

-- A window box: two rows of planter under a row of blooms, a pair at each end with leaves between.
local function flowerbox(g, x, y, w)
  P.rect(g, x, y + 1, w, 2, "wood")
  P.hline(g, x, y + 2, w, "bark")
  for i = 0, w - 1 do P.pix(g, x + i, y, (i < 2 or i >= w - 2) and "coral" or "grass") end
end

local house1 = function(g, l)
  local apex, rise, len = 7, 14, 19
  local lx = function(y) return apex - (y + 1) // 2 end
  local rx = function(y) return apex + (y + 1) // 2 end
  P.rect(g, 1, 15, 13, 17, "skin")
  for y = 0, rise do P.hline(g, lx(y), y, rx(y) - lx(y) + 1, "skin") end
  P.rect(g, 14, 15, 19, 17, "skin")
  P.rect(g, 14, 15, 19, 3, "sand")
  P.rect(g, 14, 15, 19, 1, "wood")
  P.vline(g, 14, 15, 17, "sand")
  P.vline(g, 1, 15, 14, "wood")
  P.vline(g, 32, 15, 14, "wood")
  courses(g, 0, rise, function(y) return rx(y) + 1 end, function(y) return rx(y) + len end,
    { base = "red", line = "bark", lite = "coral" }, 0.5)
  P.hline(g, apex + 1, 0, len - 1, "coral")
  P.hline(g, 15, rise, 19, "plum")
  for y = 0, rise do
    P.pix(g, lx(y), y, "red"); P.pix(g, lx(y) + 1, y, "coral")
    P.pix(g, rx(y), y, "plum"); P.pix(g, rx(y) - 1, y, "red")
    P.pix(g, rx(y) - 2, y, "sand")
  end
  P.pix(g, apex, 0, "coral")
  P.rect(g, 1, 29, 32, 3, "stone")
  P.hline(g, 1, 31, 32, "grey")
  for _, x in ipairs { 12, 20, 28 } do P.hline(g, x, 29, 3, "steel") end
  casement(g, l, 5, 11, 5, 6, "white")
  door(g, 4, 20, 7, 12)
  casement(g, l, 17, 19, 5, 7, "white"); flowerbox(g, 16, 26, 7)
  casement(g, l, 26, 19, 5, 7, "white"); flowerbox(g, 25, 26, 7)
end
sprite("house1", 34, 32, 1, "gable end left, long wall right", house1)

local house2 = function(g, l)
  local apex, top, rise, len = 8, 3, 16, 13
  local eave = top + rise
  local half = function(y) return (y - top + 1) // 2 end
  local lx = function(y) return apex - half(y) end
  local rx = function(y) return apex + half(y) end
  local beam = "bark"
  -- chimney, behind the ridge
  P.rect(g, 22, 2, 2, 7, "wood"); P.rect(g, 24, 2, 2, 7, "bark")
  P.rect(g, 21, 0, 6, 2, "stone"); P.hline(g, 21, 0, 6, "steel")
  -- upper storey, infill first
  for y = top, eave do P.hline(g, lx(y), y, rx(y) - lx(y) + 1, "white") end
  P.rect(g, 1, eave + 1, 15, 8, "white")
  P.rect(g, 17, eave + 1, 12, 8, "ice")
  -- ground floor in stone, set back a pixel under the jetty
  P.rect(g, 2, 29, 27, 7, "steel")
  P.rect(g, 17, 29, 12, 7, "stone")
  P.hline(g, 2, 29, 27, "stone")
  P.hline(g, 2, 35, 27, "grey")
  P.vline(g, 16, 29, 7, "stone")
  for _, r in ipairs { { 3, 31, 3 }, { 12, 31, 3 }, { 4, 33, 2 }, { 12, 33, 2 }, { 18, 31, 2 }, { 26, 33, 2 } } do
    P.hline(g, r[1], r[2], r[3], r[1] > 16 and "grey" or "stone")
  end
  -- slate slope
  courses(g, top, eave, function(y) return rx(y) + 1 end, function(y) return rx(y) + len end,
    { base = "navy", line = "indigo", lite = "steel", dash = 18 }, 0.5)
  P.hline(g, apex + 1, top, len - 1, "steel")
  P.hline(g, 17, eave, 13, "ink")
  -- timbers
  P.hline(g, 0, eave + 1, 30, beam); P.hline(g, 0, 28, 30, beam)
  P.vline(g, 1, eave + 1, 8, beam); P.vline(g, 15, eave + 1, 8, beam); P.vline(g, 16, eave + 1, 8, "plum")
  P.vline(g, 28, eave + 1, 8, beam); P.vline(g, 22, eave + 1, 8, beam)
  P.vline(g, 8, top + 2, 8, beam)
  P.line(g, 2, 27, 5, 21, beam); P.line(g, 14, 27, 11, 21, beam)
  P.line(g, 23, 27, 27, 21, beam)
  -- slate verge
  for y = top, eave do
    P.pix(g, lx(y), y, "navy"); P.pix(g, lx(y) + 1, y, "steel")
    P.pix(g, rx(y), y, "ink"); P.pix(g, rx(y) - 1, y, "navy")
  end
  P.pix(g, apex, top, "steel")
  casement(g, l, 6, 13, 5, 6, beam)
  casement(g, l, 6, 22, 5, 6, beam)
  casement(g, l, 18, 22, 3, 5, beam)
  door(g, 6, 29, 5, 7)
  casement(g, l, 21, 30, 4, 4, beam)
end
sprite("house2", 30, 36, 1, "half timbered, gable end left", house2)

local house3 = function(g, l)
  P.rect(g, 3, 13, 22, 11, "skin")
  P.rect(g, 3, 13, 22, 3, "sand")
  P.vline(g, 3, 15, 9, "wood"); P.vline(g, 24, 15, 9, "wood")
  P.rect(g, 3, 22, 22, 2, "stone"); P.hline(g, 3, 23, 22, "grey")
  P.hline(g, 7, 22, 3, "steel"); P.hline(g, 19, 22, 3, "steel")
  map(g, 0, 0, {
    ".......OOOOOOOOOOOOOO.......",
    ".....OOKKKKKSSSSSSSSOOW.....",
    "....OKKKKSSSSSSSSSSSSOOW....",
    "....OOOOOOOOOOOOOOOOOOOW....",
    "...OKKSSSSSSSSSSSSSSSSOOW...",
    "...OKSSSSSSKKKKKKSSSSOOOO...",
    "..OKSSSSSSKSSSSSSKSSSOOOOW..",
    "..OSSSOSSKSOOOOOOSKSSOOOOW..",
    ".OSSSSOSSSOOnnnnOOSSSOOOOOW.",
    ".OSOSSSSSSSOkkkkOSSSOOOOOOW.",
    "OSSOSSSSOSSSOOOOSSSSOOOOOOOW",
    "OSSSSOSSOSSSSSSOSSSOOOOOOOOW",
    "OOSSOOSSOOSSOOSSOOSOOOOOOOWW",
    "WOOOOOOOOOOOOOOOOOOOOOOOOWWW",
    ".WWBBWWWBBWWWBBWWWBBWWWBBWW.",
  }, { K = "skin", S = "sand", O = "ochre", W = "wood", B = "bark", n = "navy", k = "ink" })
  P.rect(l, 12, 8, 4, 2, "yellow"); P.hline(l, 12, 9, 4, "sand")
  casement(g, l, 18, 16, 5, 5, "white")
  casement(g, l, 6, 16, 5, 5, "white")
  door(g, 12, 15, 5, 9)
end
sprite("house3", 28, 24, 1, "thatched cottage, hipped", house3)

local house4 = function(g, l)
  local steps = { { 9, 0, 6, 4 }, { 6, 4, 12, 4 }, { 3, 8, 18, 4 }, { 0, 12, 24, 28 } }
  for _, s in ipairs(steps) do P.rect(g, s[1], s[2], s[3], s[4], "wood") end
  -- brick clusters, staggered, in the wall between the windows
  for _, b in ipairs { { 11, 2 }, { 7, 6 }, { 15, 6 }, { 5, 10 }, { 16, 10 }, { 10, 15 }, { 12, 18 }, { 1, 20 }, { 21, 20 }, { 10, 22 }, { 12, 25 } } do
    P.hline(g, b[1], b[2], 2, "bark")
  end
  P.vline(g, 23, 12, 28, "bark"); P.vline(g, 20, 8, 4, "bark"); P.vline(g, 17, 4, 4, "bark"); P.vline(g, 14, 0, 4, "bark")
  for _, s in ipairs(steps) do
    P.hline(g, s[1], s[2], s[3], "ice")
  end
  casement(g, l, 10, 5, 4, 5, "white")
  casement(g, l, 3, 14, 5, 6, "white"); casement(g, l, 16, 14, 5, 6, "white")
  casement(g, l, 3, 21, 5, 6, "white"); casement(g, l, 16, 21, 5, 6, "white")
  -- painted shopfront: a door, a window, a striped awning
  P.rect(g, 0, 29, 24, 11, "teal")
  P.hline(g, 0, 28, 24, "skin")
  P.hline(g, 0, 29, 24, "moss")
  P.vline(g, 23, 29, 11, "moss")
  door(g, 2, 31, 6, 9)
  casement(g, l, 11, 33, 10, 6, "skin")
  P.hline(g, 10, 39, 12, "moss")
  for x = 10, 21 do
    local c = (x // 2) % 2 == 0 and "red" or "white"
    P.rect(g, x, 30, 1, 2, c)
    if (x // 2) % 2 == 0 then P.pix(g, x, 32, "plum") else P.pix(g, x, 32, "ice") end
  end
end
sprite("house4", 24, 40, 1, "tall narrow townhouse, crow-stepped gable", house4)

local house5 = function(g, l)
  local apex, top, rise, len = 6, 3, 12, 25
  local eave = top + rise
  local half = function(y) return (y - top + 1) // 2 end
  local lx = function(y) return apex - half(y) end
  local rx = function(y) return apex + half(y) end
  -- ridge ventilator
  P.rect(g, 20, 1, 7, 3, "skin"); P.vline(g, 26, 1, 3, "sand")
  P.rect(g, 22, 2, 3, 2, "bark")
  P.hline(g, 19, 0, 9, "bark"); P.hline(g, 19, 0, 7, "wood")
  for y = top, eave do P.hline(g, lx(y), y, rx(y) - lx(y) + 1, "skin") end
  P.rect(g, 1, eave + 1, 36, 12, "skin")
  P.vline(g, 1, eave + 1, 12, "wood")
  P.rect(g, 12, eave + 1, 25, 2, "sand")
  P.rect(g, 12, eave + 1, 25, 1, "wood")
  P.vline(g, 12, eave + 1, 12, "sand")
  -- barn end is planked
  P.rect(g, 22, eave + 1, 15, 12, "wood")
  for x = 23, 36, 3 do P.vline(g, x, eave + 2, 11, "bark") end
  P.vline(g, 36, eave + 1, 12, "bark")
  P.hline(g, 22, eave + 1, 15, "bark")
  courses(g, top, eave, function(y) return rx(y) + 1 end, function(y) return rx(y) + len end,
    { base = "wood", line = "bark", lite = "sand", dash = 12 }, 0.5)
  P.hline(g, apex + 1, top, len - 1, "sand")
  P.hline(g, 13, eave, 25, "plum")
  for y = top, eave do
    P.pix(g, lx(y), y, "wood"); P.pix(g, lx(y) + 1, y, "sand")
    P.pix(g, rx(y), y, "plum"); P.pix(g, rx(y) - 1, y, "wood")
  end
  P.pix(g, apex, top, "sand")
  P.rect(g, 1, 25, 21, 3, "stone"); P.hline(g, 1, 27, 21, "grey")
  P.hline(g, 4, 25, 3, "steel"); P.hline(g, 15, 25, 3, "steel")
  -- barn door: a square frame, so the brace is one clean X at exactly 45 degrees
  P.rect(g, 24, 16, 13, 12, "bark")
  P.rect(g, 25, 17, 11, 11, "skin")
  P.rect(g, 26, 18, 9, 9, "red")
  P.line(g, 26, 18, 34, 26, "skin"); P.line(g, 34, 18, 26, 26, "skin")
  casement(g, l, 4, 9, 4, 5, "white"); dressed(g, l, 5, 18, 5, 6, "red", "plum")
  dressed(g, l, 15, 18, 5, 6, "red", "plum")
end
sprite("house5", 38, 28, 1, "long farmhouse with a barn door", house5)

-- A pointed lancet of stained glass: dark by day, warm bands by night.
local function lancet(g, l, x, y, h)
  P.rect(g, x, y + 1, 4, h - 1, "stone")
  P.hline(g, x + 1, y, 2, "stone")
  P.rect(g, x + 1, y + 1, 2, h - 2, "indigo")
  P.hline(g, x + 1, y + 1, 2, "purple")
  -- glass in panes of two rows: one-pixel bands strobe when they scroll
  local panes = { "yellow", "rust", "coral", "yellow" }
  for j = 0, h - 3 do P.hline(l, x + 1, y + 1 + j, 2, panes[(j // 2) % #panes + 1]) end
end

local church = function(g, l)
  -- nave behind the tower
  local ridge, eave = 33, 45
  P.rect(g, 16, eave + 1, 19, 14, "ice")
  P.rect(g, 16, eave + 1, 19, 2, "steel")
  P.hline(g, 16, eave + 1, 19, "stone")
  P.hline(g, 16, 59, 19, "stone")
  courses(g, ridge, eave, function(y) return 16 end, function(y) return 29 + (y - ridge) // 2 end,
    { base = "navy", line = "indigo", lite = "steel", dash = 18 }, 0.5)
  P.hline(g, 16, ridge, 14, "steel")
  P.hline(g, 16, eave, 20, "ink")
  for _, x in ipairs { 17, 26, 34 } do
    P.rect(g, x, 50, 2, 10, "steel"); P.vline(g, x + 1, 50, 10, "stone"); P.hline(g, x, 49, 2, "stone")
  end
  lancet(g, l, 21, 48, 10); lancet(g, l, 29, 48, 10)
  -- tower
  P.rect(g, 2, 27, 14, 33, "ice")
  P.rect(g, 11, 27, 4, 33, "steel")
  P.vline(g, 15, 27, 33, "stone")
  P.vline(g, 2, 27, 33, "steel")
  P.hline(g, 2, 59, 14, "stone")
  for _, r in ipairs { { 4, 28 }, { 3, 49 }, { 3, 56 } } do P.hline(g, r[1], r[2], 2, "steel") end
  P.hline(g, 12, 51, 2, "stone")
  -- corner buttresses reach the edges of the sprite
  P.rect(g, 0, 50, 2, 10, "steel"); P.vline(g, 1, 50, 10, "ice"); P.pix(g, 1, 49, "steel")
  P.vline(g, 0, 50, 10, "stone")
  -- spire: a lit facet and a shaded one
  for y = 8, 26 do
    local half = 1 + (y - 8) // 3
    P.hline(g, 8 - half + 1, y, half, "steel")
    P.hline(g, 9, y, half, "indigo")
    if half > 1 then P.pix(g, 9, y, "navy"); P.pix(g, 8 - half + 1, y, "ice") end
  end
  P.rect(g, 1, 26, 16, 2, "ice"); P.hline(g, 1, 27, 16, "stone")
  -- cross: dark wood, so it stands on the amber sky as firmly as on the teal one
  P.rect(g, 8, 0, 2, 9, "wood"); P.rect(g, 6, 2, 6, 2, "wood")
  P.vline(g, 9, 0, 9, "bark"); P.hline(g, 10, 3, 2, "bark"); P.hline(g, 6, 3, 2, "bark")
  -- belfry: paired openings
  P.rect(g, 5, 30, 3, 7, "ink"); P.rect(g, 10, 30, 3, 7, "ink")
  P.pix(g, 5, 30, "ice"); P.pix(g, 12, 30, "steel"); P.pix(g, 7, 30, "ice"); P.pix(g, 10, 30, "ice")
  P.hline(g, 2, 38, 14, "stone")
  -- rose window
  local rose = {
    "...ssss...",
    "..sOOOOs..",
    ".sOooooOs.",
    "sOooYYooOs",
    "sOoYccYoOs",
    "sOoYccYoOs",
    "sOooYYooOs",
    ".sOooooOs.",
    "..sOOOOs..",
    "...ssss...",
  }
  map(g, 4, 40, rose, { s = "stone", O = "indigo", o = "purple", Y = "indigo", c = "navy" })
  map(l, 4, 40, rose, { s = P.CLEAR, O = "red", o = "rust", Y = "coral", c = "yellow" })
  for _, m in ipairs { { 1, 4 }, { 1, 5 }, { 8, 4 }, { 8, 5 }, { 4, 1 }, { 5, 1 }, { 4, 8 }, { 5, 8 } } do
    P.pix(g, 4 + m[1], 40 + m[2], "stone"); P.pix(l, 4 + m[1], 40 + m[2], nil)
  end
  -- west door under a pointed arch
  P.rect(g, 5, 53, 8, 7, "stone"); P.hline(g, 6, 52, 6, "stone"); P.hline(g, 7, 51, 4, "stone")
  door(g, 6, 53, 6, 7)
  tidy(g, 16, 33, 20, 13, "indigo", "navy")
end
sprite("church", 36, 60, 1, "steeple left, nave right", church)

local windmill = function(g, l)
  -- tower, tapering, shaded as a cylinder
  for y = 8, 41 do
    local half = 6 + (y - 8) // 8
    local x0, w = 11 - half, half * 2
    P.hline(g, x0, y, w, "skin")
    P.hline(g, x0 + w - 3, y, 2, "sand")
    P.pix(g, x0 + w - 1, y, "wood")
    P.pix(g, x0, y, "wood")
  end
  for _, r in ipairs { { 7, 11, 2 }, { 6, 21, 2 }, { 13, 22, 2 }, { 5, 29, 2 }, { 3, 37, 3 }, { 15, 30, 2 } } do
    P.hline(g, r[1], r[2], r[3], "sand")
  end
  -- gallery, reaching the sprite's edges
  P.rect(g, 0, 24, 22, 2, "wood"); P.hline(g, 0, 25, 22, "bark"); P.hline(g, 0, 24, 9, "sand")
  for _, x in ipairs { 1, 20 } do P.vline(g, x, 26, 2, "bark") end
  -- the cap: a slate dome with a lit crown, cool against the wooden sails that cross it
  map(g, 0, 0, {
    "........SSSSSS........",
    "......SSSWWWWWBB......",
    ".....SSWWWWWWWWBB.....",
    "....SSWWWBWWWBWWBB....",
    "....SWWWWBWWWBWBBB....",
    "....SWWWWBWWWBWBBB....",
    "....SWWWWWWWWWBBBB....",
    "....PPPPPPPPPPPPPP....",
  }, { S = "steel", W = "navy", B = "indigo", P = "ink" })
  door(g, 8, 33, 6, 9)
  casement(g, l, 9, 13, 4, 6, "wood")
  casement(g, l, 9, 27, 4, 5, "wood")
end
sprite("windmill", 22, 42, 1, "tower only; hub at 11,4 for the sails", windmill)

-- Sail lattice. Each frame leans along a whole-pixel direction (1:0, 1:2, 1:1, 2:1) and every bar is
-- tested in that direction's own integer coordinates, so bars come out as clean, identical stairs.
-- `step` is the rung spacing in those coordinates (about 4 px on screen whatever the angle). One sail
-- is rasterised and stamped by exact quarter turns, so all four match and a quarter turn is the frame
-- that follows the last one: the loop closes exactly. The strip turns anticlockwise, as real mills do,
-- so the stock leads and the lattice trails behind it. The steps are 26.6, 18.4, 18.4 and 26.6 degrees;
-- 5:2 leans would even them out but leave the rungs visibly irregular, and clean bars read better.
local SAIL_FRAMES = { { 1, 0, 4 }, { 1, 2, 10 }, { 1, 1, 6 }, { 2, 1, 10 } }
local function sailsFrame(g, frame)
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
    local c
    if U > 0 and U <= 20 * n and math.abs(V) < n then c = "bark"
    elseif U >= U0 - n / 2 and U < Ulast + n / 2 and math.abs(V - V0) < n / 2 then c = "bark"
    elseif V > 0 and V < V0 then
      for _, r in ipairs(rungs) do
        if math.abs(U - r) < n / 2 then c = "wood" end
      end
    end
    if c then
      local rx, ry = x, y
      for _ = 0, 3 do
        P.pix(g, rx, ry, c)
        rx, ry = 39 - ry, rx
      end
    end
  end end
  P.rect(g, 18, 18, 4, 4, "bark"); P.rect(g, 19, 19, 2, 2, "sand")
end
sprite("sails", 40, 40, 4, "centre 20,20; four lattice sails, a quarter turn anticlockwise in four frames", function(g, l, f)
  sailsFrame(g, SAIL_FRAMES[f + 1])
end)


-- Foliage is stacked from clumps, each lit from the top left only. The dark ones go in first, low and
-- to the right, and the lit ones last, high and to the left: the crown reads as one lit mass.
local CLUMP = {
  L = { "...aaaa...", ".aaaaaaab.", "aaaaaaaabb", "aaaaaaabbb", "baaaabbbbb", "bbbbbbbbcc", ".bbbbbccc.", "...cccc..." },
  M = { "..aaaa..", ".aaaaab.", "aaaaabbb", "baabbbbc", ".bbbbcc.", "..cccc.." },
  S = { ".aaa..", "aaaab.", "bbbbcc", ".bccc." },
}
local TONE = {
  lit = { a = "lime", b = "grass", c = "moss" },
  mid = { a = "grass", b = "grass", c = "moss" },
  low = { a = "grass", b = "moss", c = "slate" },
}
local function leaves(g, list)
  for _, c in ipairs(list) do map(g, c[2], c[3], CLUMP[c[1]], TONE[c[4]]) end
end
-- Blossom in small solid knots, so it sits among the leaves as clusters rather than dashes.
local function blossom(g, list, c)
  for _, b in ipairs(list) do P.rect(g, b[1], b[2], 2, 2, c) end
end
local TRUNK = { w = "wood", b = "bark", p = "plum" }

sprite("oak1", 22, 28, 1, "", function(g)
  map(g, 8, 16, {
    ".w..b.",
    ".w.bb.",
    ".wwbb.",
    "..wbb.",
    "..wbb.",
    "..wbb.",
    "..wbb.",
    "..wbb.",
    "..wbb.",
    "..wbb.",
    ".wwbbb",
    "wwwbbb",
  }, TRUNK)
  leaves(g, { { "L", 6, 6, "low" }, { "L", 7, 9, "low" }, { "M", 14, 11, "low" }, { "L", 0, 10, "low" }, { "M", 9, 13, "low" }, { "L", 12, 5, "low" }, { "M", 0, 7, "mid" }, { "M", 6, 9, "mid" },
              { "L", 11, 1, "mid" }, { "M", 15, 9, "mid" }, { "L", 2, 2, "lit" }, { "M", 8, 0, "lit" } })
  tidy(g, 0, 0, 22, 20, "slate", "moss")
end)
sprite("oak2", 26, 30, 1, "", function(g)
  map(g, 10, 18, {
    "b.w..b.",
    ".w.w.b.",
    ".wwwbb.",
    "..wwbb.",
    "..wbbb.",
    "..wbbb.",
    "..wbbb.",
    "..wbbb.",
    "..wbbb.",
    "..wbbb.",
    ".wwbbb.",
    "wwwbbbb",
  }, TRUNK)
  leaves(g, { { "L", 8, 7, "low" }, { "L", 12, 8, "low" }, { "M", 18, 13, "low" }, { "L", 0, 12, "low" }, { "L", 9, 14, "low" }, { "L", 16, 6, "low" }, { "M", 0, 9, "mid" }, { "L", 7, 10, "mid" },
              { "L", 13, 2, "mid" }, { "M", 18, 10, "mid" }, { "L", 3, 3, "lit" }, { "L", 8, 0, "lit" } })
  tidy(g, 0, 0, 26, 22, "slate", "moss")
end)

sprite("poplar", 10, 32, 1, "", function(g)
  map(g, 0, 0, {
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
  }, { g = "grass", L = "lime", m = "moss", w = "wood", b = "bark" })
end)

sprite("pine", 14, 28, 1, "", function(g)
  P.rect(g, 6, 22, 2, 6, "bark"); P.vline(g, 6, 22, 6, "wood")
  map(g, 0, 0, {
    "......tt......",
    "......tt......",
    ".....gttm.....",
    ".....gttm.....",
    "....ggttmm....",
    "....gtttmm....",
    ".....gtmm.....",
    "....ggttmm....",
    "...ggtttmmm...",
    "...gttttmmm...",
    "..ggtttttmmm..",
    "....gttmm.....",
    "...ggttmmm....",
    "..ggttttmmm...",
    "..gtttttmmmm..",
    ".ggtttttttmmm.",
    "...gttttmmm...",
    "..ggtttmmmm...",
    ".ggttttttmmm..",
    ".gttttttttmmm.",
    "ggttttttttmmmm",
    "gtttttmmtttmmm",
    ".gtmmttmmtmmm.",
  }, { g = "grass", t = "teal", m = "slate" })
end)

sprite("bush1", 12, 8, 1, "", function(g)
  leaves(g, { { "M", 4, 2, "low" }, { "M", 0, 2, "mid" }, { "M", 2, 0, "lit" } })
  P.hline(g, 0, 7, 12, "moss")
end)
sprite("bush2", 16, 10, 1, "", function(g)
  leaves(g, { { "M", 8, 4, "low" }, { "M", 0, 4, "mid" }, { "M", 5, 3, "mid" }, { "M", 8, 0, "mid" }, { "M", 2, 1, "lit" } })
  P.hline(g, 0, 9, 16, "moss")
  blossom(g, { { 5, 4 }, { 11, 3 }, { 8, 6 }, { 2, 6 } }, "coral")
end)

sprite("haystack", 14, 10, 1, "", function(g)
  map(g, 0, 0, {
    ".....KKSS.....",
    "...KKKSSSSO...",
    "..KKSSSSSSSO..",
    ".KKSSOOOSSSOO.",
    ".KSOOSSSOOSOO.",
    "KKSSSSSSSSOOOW",
    "KSSSOOOOSSOOOW",
    "SOOOSSSSOOOOWW",
    "SSSSSOOSSOOWWW",
    "WWWOOWWOOOWWWW",
  }, { K = "skin", S = "sand", O = "ochre", W = "wood" })
end)

sprite("tuft1", 8, 5, 1, "", function(g)
  map(g, 0, 0, {
    "..y.....",
    ".yky..g.",
    "..y.g.g.",
    ".m.gg.mg",
    "mmgggmmm",
  }, { y = "yellow", k = "sand", g = "grass", m = "moss" })
end)
sprite("tuft2", 8, 6, 1, "", function(g)
  map(g, 0, 0, {
    "....r...",
    ".g.rkr..",
    ".g..r.g.",
    "gm.g.gg.",
    "mg.gmgm.",
    "mmgmmmmm",
  }, { r = "coral", k = "yellow", g = "grass", m = "moss" })
end)
sprite("tuft3", 10, 6, 1, "", function(g)
  map(g, 0, 0, {
    ".w.....b..",
    "wkw...bkb.",
    ".w.g...bg.",
    ".m.g.g.mg.",
    "mmgmgg.mgg",
    "mmmmmgmmmm",
  }, { w = "white", k = "yellow", b = "sky", g = "grass", m = "moss" })
end)

sprite("fence", 16, 7, 1, "repeats left-right", function(g)
  map(g, 0, 0, {
    "....SW......SW..",
    "SSSSSWSSSSSSSWSS",
    "WWWWSWWWWWWWSWWW",
    "....SW......SW..",
    "SSSSSWSSSSSSSWSS",
    "WWWWSWWWWWWWSWWW",
    "....SW......SW..",
  }, { S = "sand", W = "wood" })
end)

sprite("lamp", 6, 22, 1, "", function(g, l)
  map(g, 0, 0, {
    "..kk..",
    ".kkkk.",
    "kkkkkk",
    ".kggk.",
    ".kggk.",
    ".kggk.",
    ".kggk.",
    ".kkkk.",
    "..kk..",
    "..sk..",
    "..sk..",
    "..sk..",
    "..sk..",
    "..sk..",
    "..sk..",
    "..sk..",
    "..sk..",
    "..sk..",
    "..sk..",
    ".kskk.",
    ".kskk.",
    "kkkkkk",
  }, { k = "ink", g = "navy", s = "indigo" })
  P.rect(l, 2, 3, 2, 3, "yellow"); P.hline(l, 2, 6, 2, "sand")
end)

sprite("pole", 12, 36, 1, "", function(g)
  P.rect(g, 5, 0, 2, 36, "wood"); P.vline(g, 6, 0, 36, "bark")
  P.rect(g, 0, 4, 12, 2, "wood"); P.hline(g, 0, 5, 12, "bark")
  for k = 0, 3 do P.pix(g, 2 + k, 6 + k, "bark"); P.pix(g, 9 - k, 6 + k, "bark") end
  for _, x in ipairs { 0, 3, 7, 10 } do
    P.rect(g, x, 2, 2, 2, "ice"); P.hline(g, x, 3, 2, "steel")
  end
end)

local SHEEP = { w = "white", i = "ice", p = "plum", k = "ink" }
sprite("sheep", 11, 8, 2, "head up, then grazing", function(g, l, f)
  if f == 0 then
    map(g, 0, 0, {
      ".....ww.ww.",
      ".pp.wwwwwww",
      "pkpwwwwwwwi",
      "pppwwwwwwii",
      ".p.wiwwwiii",
      "...iii.iii.",
      "...p....p..",
      "...p....p..",
    }, SHEEP)
  else
    map(g, 0, 0, {
      ".....ww.ww.",
      "....wwwwwww",
      "...wwwwwwwi",
      ".ppwwwwwwii",
      "pkpwiwwwiii",
      "pppiii.iii.",
      ".p.p....p..",
      ".p.p....p..",
    }, SHEEP)
  end
end)

-- A flat base under round puffs. Each puff is ice with white laid over it, shifted up and left, so the
-- light falls the same way on every puff and an ice crescent is left on its shaded side. The ice is
-- what keeps the cloud's shape under a tint the colour of the sky.
local function cloud(g, lobes)
  for _, b in ipairs(lobes) do P.disc(g, b[1], b[2], b[3], "ice") end
  despur(g)
  local solid = function(x, y) return app.pixelColor.rgbaA(g:getPixel(x, y)) > 0 end
  for _, y in ipairs { g.height - 1, g.height - 2 } do
    local first, last
    for x = 0, g.width - 1 do
      if solid(x, y) then first = first or x; last = x end
    end
    if first then P.hline(g, first, y, last - first + 1, "ice") end
  end
  for x = 0, g.width - 1 do
    local top, bottom
    for y = 0, g.height - 1 do
      if solid(x, y) then top = top or y; bottom = y end
    end
    if top then P.vline(g, x, top, bottom - top + 1, "ice") end
  end
  for _, b in ipairs(lobes) do
    local cx, cy, r = b[1] - 1.2, b[2] - 2, b[3] - 1.4
    for y = 0, g.height - 1 do for x = 0, g.width - 1 do
      if solid(x, y) and math.sqrt((x - cx) ^ 2 + (y - cy) ^ 2) <= r then P.pix(g, x, y, "white") end
    end end
  end
  tidy(g, 0, 0, g.width, g.height, "ice", "white")
  tidy(g, 0, 0, g.width, g.height, "white", "ice")
end
sprite("cloud1", 44, 14, 1, "", function(g)
  cloud(g, { { 5.5, 9, 5.5 }, { 15, 7.5, 7 }, { 25, 6.5, 6.5 }, { 34, 8.5, 5.5 }, { 39, 9.5, 4.6 } })
end)
sprite("cloud2", 30, 10, 1, "", function(g)
  cloud(g, { { 3.8, 6.2, 3.8 }, { 11, 4.7, 4.7 }, { 19.6, 5.4, 4.4 }, { 26, 6.5, 3.6 } })
end)
sprite("cloud3", 58, 18, 1, "", function(g)
  cloud(g, { { 6, 11.6, 6 }, { 17, 9.5, 7.8 }, { 29, 8.4, 8.4 }, { 41, 10, 7.4 }, { 51.5, 11.6, 6.1 } })
end)

P.save(S, ART, 3)
