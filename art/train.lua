-- train.lua: the hero family. A six-coupled locomotive, its tender and two carriages, facing right.
-- Run with: ART = "<ART>"; dofile(ART .. "/train.lua")
local P = dofile(ART .. "/px.lua")
local sheet = P.sheet("train", 512, 512)

-- One frame is a quarter turn, clockwise on screen: the top of a wheel moves forward (right).
local COS, SIN = { [0] = 1, 0, -1, 0 }, { [0] = 0, 1, 0, -1 }

-- Spoked wheel: T tyre, R rim, i interior. The two big spoke patterns are the same six spokes a
-- quarter turn apart. `weight` fills the side opposite the crank; `mark` paints one spoke, rim to hub,
-- so a small wheel with four plain spokes still shows all four phases.
local WHEEL13 = {
  spoke = "coral", hub = "skin",
  mask = {
    "....TTTTT....",
    "..TTRRRRRTT..",
    ".TRRiiiiiRRT.",
    ".TRiiiiiiiRT.",
    "TRiiiiiiiiiRT",
    "TRiiiiiiiiiRT",
    "TRiiiiiiiiiRT",
    "TRiiiiiiiiiRT",
    "TRiiiiiiiiiRT",
    ".TRiiiiiiiRT.",
    ".TRRiiiiiRRT.",
    "..TTRRRRRTT..",
    "....TTTTT....",
  },
  spokes = {
    [0] = {
      "..s...s..",
      "..s...s..",
      "...s.s...",
      "...s.s...",
      "ssssHssss",
      "...s.s...",
      "...s.s...",
      "..s...s..",
      "..s...s..",
    },
    [1] = {
      "....s....",
      "....s....",
      "ss..s..ss",
      "..sssss..",
      "....H....",
      "..sssss..",
      "ss..s..ss",
      "....s....",
      "....s....",
    },
  },
}
local WHEEL9 = {
  spoke = "red", hub = "coral", markColour = "white", handColour = "skin",
  mask = {
    "..TTTTT..",
    ".TRRRRRT.",
    "TRiiiiiRT",
    "TRiiiiiRT",
    "TRiiiiiRT",
    "TRiiiiiRT",
    "TRiiiiiRT",
    ".TRRRRRT.",
    "..TTTTT..",
  },
  spokes = {
    [0] = {
      "..s..",
      "..s..",
      "ssHss",
      "..s..",
      "..s..",
    },
  },
}
local WHEEL7 = {
  spoke = "red", hub = "coral", markColour = "white", handColour = "skin",
  mask = {
    "..TTT..",
    ".TRRRT.",
    "TRiiiRT",
    "TRiiiRT",
    "TRiiiRT",
    ".TRRRT.",
    "..TTT..",
  },
  spokes = {
    [0] = {
      ".s.",
      "sHs",
      ".s.",
    },
  },
}

local function wheel(img, spec, cx, cy, k, opts)
  local half = (#spec.mask - 1) / 2
  local half2 = (#spec.spokes[0] - 1) / 2
  local ca, sa = COS[k], SIN[k]
  local pattern = spec.spokes[k % 2] or spec.spokes[0]
  for row, line in ipairs(spec.mask) do
    for col = 1, #line do
      local ch = line:sub(col, col)
      local dx, dy = col - 1 - half, row - 1 - half
      if ch == "T" then
        P.pix(img, cx + dx, cy + dy, "plum")
      elseif ch == "R" then
        P.pix(img, cx + dx, cy + dy, dy < -1 and "coral" or "red")
      elseif ch == "i" then
        local s = pattern[dy + half2 + 1]:sub(dx + half2 + 1, dx + half2 + 1)
        local along = dx * ca + dy * sa
        local c = "ink"
        if s == "s" then c = spec.spoke end
        if opts.weight and along <= opts.weight then c = "red" end
        if s == "H" then c = spec.hub end
        P.pix(img, cx + dx, cy + dy, c)
      end
    end
  end
  if opts.mark then
    P.pix(img, cx + opts.mark * ca, cy + opts.mark * sa, spec.markColour)
    P.pix(img, cx + (opts.mark - 1) * ca, cy + (opts.mark - 1) * sa, spec.handColour)
  end
end

local function fromBase(img, base, x, y) P.blit(img, base, x, y) end

---------------------------------------------------------------------------------------------------
-- Locomotive, 64 x 32
---------------------------------------------------------------------------------------------------
local AXLE_Y, CRANK = 25, 3
local AXLES = { 13, 27, 41 }

local function locoBody()
  local b = P.image(64, 32)
  -- frames behind the wheels, and the drawgear at the back
  P.rect(b, 2, 19, 49, 5, "ink")
  P.rect(b, 2, 24, 3, 3, "ink")
  P.rect(b, 0, 25, 2, 2, "ink")
  P.hline(b, 0, 25, 2, "stone")

  -- boiler
  local shade = { [8] = "ink", [9] = "grey", [10] = "smoke", [11] = "slate", [12] = "slate", [13] = "slate",
                  [14] = "slate", [15] = "ink", [16] = "ink", [17] = "ink" }
  for y = 8, 17 do P.hline(b, 15, y, 32, shade[y]) end
  -- firebox: a step proud of the barrel, at the cab
  P.rect(b, 15, 7, 7, 11, "slate")
  P.hline(b, 15, 7, 7, "ink")
  P.hline(b, 15, 8, 7, "grey")
  P.hline(b, 15, 9, 7, "smoke")
  P.rect(b, 15, 14, 7, 4, "ink")
  -- smokebox, darker, with a rounded nose
  for y = 8, 17 do P.hline(b, 47, y, 10, y == 8 and "ink" or (y == 9 and "smoke" or (y <= 12 and "slate" or "ink"))) end
  P.vline(b, 56, 8, 1, "ink")
  P.vline(b, 57, 9, 8, "slate")
  P.vline(b, 57, 13, 4, "ink")
  P.pix(b, 57, 9, "ink")
  P.vline(b, 58, 10, 6, "ink")
  P.vline(b, 58, 12, 2, "sand")
  -- brass bands
  for _, x in ipairs({ 21, 29, 39, 46 }) do
    P.vline(b, x, 8, 1, "wood")
    P.vline(b, x, 9, 2, "skin")
    P.vline(b, x, 11, 4, "sand")
    P.vline(b, x, 15, 3, "wood")
  end
  -- handrail
  P.hline(b, 22, 12, 34, "smoke")

  -- running board
  P.hline(b, 15, 18, 42, "red")
  P.hline(b, 15, 19, 42, "plum")

  -- cab
  P.rect(b, 2, 5, 13, 14, "red")
  P.hline(b, 2, 5, 13, "plum")
  P.vline(b, 2, 5, 14, "plum")
  P.vline(b, 14, 5, 14, "plum")
  P.hline(b, 3, 13, 11, "coral")
  P.hline(b, 2, 18, 13, "plum")
  -- roof
  P.hline(b, 3, 2, 12, "grey")
  P.hline(b, 1, 3, 15, "slate")
  P.hline(b, 0, 4, 17, "ink")
  -- cab window
  P.rect(b, 5, 7, 7, 5, "wood")
  P.rect(b, 6, 8, 5, 3, "ink")
  P.hline(b, 6, 8, 2, "navy")
  P.map(b, 9, 8, { "ss", "SS", "nn" }, { s = "steel", S = "skin", n = "navy" })
  -- number plate
  P.rect(b, 6, 15, 5, 2, "sand")
  P.hline(b, 6, 16, 5, "wood")
  -- firebox opening, low on the firebox: a grate
  P.rect(b, 15, 15, 6, 2, "black")
  P.vline(b, 17, 15, 2, "plum"); P.vline(b, 19, 15, 2, "plum")

  -- whistle
  P.vline(b, 18, 5, 2, "sand"); P.pix(b, 18, 4, "skin")

  -- stack
  P.map(b, 45, 0, {
    "HHHSSSSSWW",
    ".kggssssk.",
    "..kgsssk..",
    "..kgsssk..",
    "...kgsk...",
    "...kgsk...",
    "...kgsk...",
    "...kgsk...",
    "..kkkkkk..",
  }, { k = "ink", S = "sand", W = "wood", H = "skin", g = "grey", s = "slate" })

  -- bell
  P.map(b, 40, 4, {
    "..W..",
    ".HSS.",
    ".HSS.",
    "HSSSW",
  }, { W = "wood", H = "skin", S = "sand" })

  -- steam dome
  P.map(b, 30, 3, {
    "..WHSSW..",
    ".WHHSSSW.",
    ".WHSSSSW.",
    ".WHSSSSW.",
    "WWSSSSWWW",
  }, { W = "wood", H = "skin", S = "sand" })

  -- sand dome
  P.map(b, 22, 4, {
    "..ppp..",
    ".pcrrp.",
    ".prrrp.",
    "SSSSSSS",
  }, { p = "plum", c = "coral", r = "red", S = "sand" })

  -- headlamp
  P.map(b, 54, 2, {
    ".HSSSS.",
    "HnnkkWn",
    "HkkkkWn",
    "SkkkkWn",
    ".WWWWW.",
    "..kkk..",
  }, { k = "ink", S = "sand", H = "skin", W = "wood", n = "navy" })

  -- cylinder
  P.rect(b, 51, 20, 6, 6, "slate")
  P.hline(b, 51, 20, 6, "grey")
  P.hline(b, 51, 25, 6, "ink")
  P.vline(b, 51, 20, 6, "sand")
  P.vline(b, 56, 20, 6, "sand")

  -- pilot: buffer beam, then a wedge of slats running down to the point, lit along its slope
  P.rect(b, 57, 18, 2, 6, "red")
  P.hline(b, 57, 18, 2, "coral")
  P.vline(b, 57, 19, 5, "plum")
  for y = 24, 30 do
    local xr = math.min(63, 58 + (y - 24))
    for x = y >= 26 and 52 or 57, xr do
      local c = (x - 53) % 3 == 0 and "plum" or "red"
      if x >= xr - 1 and y < 30 then c = "coral" end
      if y == 30 then c = "plum" end
      P.pix(b, x, y, c)
    end
  end
  return b
end

local function locoLights()
  local l = P.image(64, 32)
  -- headlamp
  P.rect(l, 55, 3, 4, 3, "yellow")
  P.hline(l, 55, 5, 4, "sand")
  P.vline(l, 60, 3, 3, "yellow")
  -- cab window
  P.rect(l, 6, 8, 3, 3, "yellow")
  P.hline(l, 6, 10, 3, "sand")
  -- firebox: white heat behind the grate, falling off below it
  P.hline(l, 15, 15, 6, "yellow")
  P.hline(l, 15, 16, 6, "rust")
  P.hline(l, 15, 17, 6, "red")
  P.vline(l, 17, 15, 2, nil); P.vline(l, 19, 15, 2, nil)
  return l
end

-- Rods are white on top of steel with a dark edge under them: under the hell tint steel falls to the
-- value of the red wheels, and only the white and the dark edge keep them apart.
local function rods(img, ox, oy, k)
  local dx, dy = CRANK * COS[k], CRANK * SIN[k]
  local x1, x2, x3 = ox + AXLES[1] + dx, ox + AXLES[2] + dx, ox + AXLES[3] + dx
  local y = oy + AXLE_Y + dy
  local cx, cy = ox + 46 + dx, oy + 23
  -- guide bar, piston rod and crosshead
  P.hline(img, ox + 43, oy + 21, 8, "stone")
  P.hline(img, cx, cy, ox + 51 - cx, "white")
  P.rect(img, cx - 1, cy - 1, 3, 3, "steel")
  P.pix(img, cx, cy, "white")
  -- main rod, from the crosshead back to the middle pin, behind the coupling rod
  P.line(img, x2 + 1, y + 2, cx, cy + 2, "ink")
  P.line(img, x2 + 1, y, cx, cy, "skin")
  P.line(img, x2 + 1, y + 1, cx, cy + 1, "sand")
  -- coupling rod with a boss at each crank pin; the middle one is the main rod's big end
  P.hline(img, x1, y + 2, x3 - x1 + 1, "ink")
  P.hline(img, x1, y, x3 - x1 + 1, "white")
  P.hline(img, x1, y + 1, x3 - x1 + 1, "steel")
  for _, x in ipairs({ x1, x2, x3 }) do
    P.rect(img, x - 1, y - 1, 3, 4, x == x2 and "skin" or "steel")
    P.vline(img, x, y, 2, "white")
  end
end

local body, glow = locoBody(), locoLights()
local draw = P.strip(sheet, "loco", 64, 32, 4, "steam locomotive, one wheel revolution")
for k = 0, 3 do
  local x, y = draw(k)
  fromBase(sheet.base, body, x, y)
  fromBase(sheet.lights, glow, x, y)
  for _, ax in ipairs(AXLES) do wheel(sheet.base, WHEEL13, x + ax, y + AXLE_Y, k, { weight = -3 }) end
  rods(sheet.base, x, y, k)
end

---------------------------------------------------------------------------------------------------
-- Tender, 30 x 22
---------------------------------------------------------------------------------------------------
local function tenderBody()
  local b = P.image(30, 22)
  -- coal: a bumpy heap of lumps, each a lit face on the dark mass
  P.map(b, 5, 0, {
    "......kkkk...kkkk..kk..",
    "...kkkggskk.kggskkkgsk.",
    "..kkkkgskkkkkgskkkgskkk",
    ".kkggskkkkggskkkkkkkkkk",
    "kkkgskkkkkgskkkkggskkkk",
    "kkkkkkggskkkkkkkgskkkgs",
  }, { k = "ink", s = "slate", g = "grey" })
  -- water hatch at the back
  P.map(b, 1, 4, {
    ".WW.",
    "HSSW",
  }, { W = "wood", H = "skin", S = "sand" })
  -- tank
  P.hline(b, 0, 6, 30, "sand")
  P.hline(b, 1, 7, 28, "wood")
  P.rect(b, 1, 8, 28, 5, "red")
  P.hline(b, 2, 8, 26, "coral")
  P.vline(b, 1, 8, 5, "plum")
  P.vline(b, 28, 8, 5, "plum")
  P.hline(b, 1, 12, 28, "plum")
  P.vline(b, 6, 9, 3, "plum")
  P.vline(b, 23, 9, 3, "plum")
  P.rect(b, 12, 9, 6, 2, "sand")
  P.hline(b, 12, 10, 6, "wood")
  -- frame and drawgear
  P.hline(b, 0, 13, 30, "ink")
  P.rect(b, 2, 14, 26, 3, "ink")
  P.rect(b, 0, 15, 3, 2, "ink"); P.hline(b, 0, 15, 2, "stone")
  P.rect(b, 27, 15, 3, 2, "ink"); P.hline(b, 28, 15, 2, "stone")
  return b
end

local tb = tenderBody()
draw = P.strip(sheet, "tender", 30, 22, 4, "coal tender")
for k = 0, 3 do
  local x, y = draw(k)
  fromBase(sheet.base, tb, x, y)
  wheel(sheet.base, WHEEL9, x + 8, y + 17, k, { mark = 3 })
  wheel(sheet.base, WHEEL9, x + 21, y + 17, k, { mark = 3 })
end

---------------------------------------------------------------------------------------------------
-- Carriages, 56 x 24
---------------------------------------------------------------------------------------------------
local WINDOW_Y = 8
local function roof(b)
  P.hline(b, 10, 0, 36, "grey")
  P.hline(b, 9, 1, 38, "slate")
  for x = 12, 43, 4 do P.hline(b, x, 1, 2, "ink") end
  P.hline(b, 3, 2, 50, "grey")
  P.hline(b, 1, 3, 54, "smoke")
  P.hline(b, 0, 4, 56, "ink")
end
local function underframe(b)
  P.hline(b, 0, 16, 56, "ink")
  -- couplers
  P.rect(b, 0, 17, 3, 2, "ink"); P.hline(b, 0, 17, 2, "stone")
  P.rect(b, 53, 17, 3, 2, "ink"); P.hline(b, 54, 17, 2, "stone")
  -- bogie frames
  P.rect(b, 3, 17, 16, 2, "ink"); P.rect(b, 10, 19, 2, 3, "ink")
  P.rect(b, 37, 17, 16, 2, "ink"); P.rect(b, 44, 19, 2, 3, "ink")
  -- truss rod and battery box
  P.line(b, 19, 17, 23, 20, "slate")
  P.hline(b, 23, 20, 10, "slate")
  P.line(b, 33, 20, 37, 17, "slate")
  P.rect(b, 25, 17, 6, 3, "ink")
end

local function coachBase(windows)
  local b = P.image(56, 24)
  roof(b)
  P.rect(b, 1, 5, 54, 11, "red")
  P.hline(b, 1, 5, 54, "plum")
  P.rect(b, 2, 7, 52, 6, "skin")
  P.hline(b, 1, 13, 54, "plum")
  P.vline(b, 1, 5, 11, "plum")
  P.vline(b, 54, 5, 11, "plum")
  for _, x in ipairs(windows) do
    P.rect(b, x, WINDOW_Y, 4, 4, "ink")
    P.hline(b, x, WINDOW_Y, 2, "navy")
  end
  P.rect(b, 26, 14, 4, 1, "sand")
  underframe(b)
  return b
end

local function vanBase(windows)
  local b = P.image(56, 24)
  roof(b)
  P.rect(b, 1, 5, 54, 11, "teal")
  P.hline(b, 1, 5, 54, "slate")
  P.vline(b, 1, 5, 11, "slate")
  P.vline(b, 54, 5, 11, "slate")
  P.rect(b, 2, 12, 52, 2, "skin")
  for _, x in ipairs(windows) do
    P.rect(b, x, WINDOW_Y, 5, 3, "ink")
    P.hline(b, x, WINDOW_Y, 2, "navy")
    P.vline(b, x + 2, WINDOW_Y, 3, "stone")
  end
  -- sliding door with the mail mark
  P.rect(b, 19, 6, 18, 10, "slate")
  P.rect(b, 20, 7, 16, 9, "teal")
  P.map(b, 23, 9, {
    "WSSSSSSSSW",
    "SWSSSSSSWS",
    "SSWSSSSWSS",
    "SSSWSSWSSS",
    "SSSSWWSSSS",
    "SSSSSSSSSS",
  }, { S = "skin", W = "wood" })
  underframe(b)
  return b
end

local function windowLights(l, windows, w, h, heads)
  for i, x in ipairs(windows) do
    P.rect(l, x, WINDOW_Y, w, h, "yellow")
    P.hline(l, x, WINDOW_Y + h - 1, w, "sand")
    local head = heads[i]
    if head then
      P.rect(l, x + head, WINDOW_Y + 1, 2, 2, nil)
      for sx = x + head - 1, x + head + 2 do
        if sx >= x and sx < x + 4 then P.pix(l, sx, WINDOW_Y + 3, nil) end
      end
    end
  end
end
local function clerestoryLights(l)
  for x = 12, 43, 4 do P.hline(l, x, 1, 2, "sand") end
end

local function coachStrip(name, base, light, note)
  local d = P.strip(sheet, name, 56, 24, 4, note)
  for k = 0, 3 do
    local x, y = d(k)
    fromBase(sheet.base, base, x, y)
    fromBase(sheet.lights, light, x, y)
    for _, cx in ipairs({ 6, 15, 40, 49 }) do wheel(sheet.base, WHEEL7, x + cx, y + 20, k, { mark = 2 }) end
  end
end

local passengers = { 5, 12, 19, 26, 33, 40, 47 }
local coachLight = P.image(56, 24)
windowLights(coachLight, passengers, 4, 4, { [1] = 1, [3] = 1, [6] = 1 })
clerestoryLights(coachLight)
coachStrip("coach", coachBase(passengers), coachLight, "passenger carriage, deep red with a cream band")

local vanWindows = { 4, 11, 40, 47 }
local vanLight = P.image(56, 24)
windowLights(vanLight, vanWindows, 5, 3, {})
for _, x in ipairs(vanWindows) do P.vline(vanLight, x + 2, WINDOW_Y, 3, nil) end
clerestoryLights(vanLight)
coachStrip("coachB", vanBase(vanWindows), vanLight, "mail van, teal with a sliding door")

P.save(sheet, ART, 3)
