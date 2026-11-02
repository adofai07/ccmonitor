local P = dofile(ART .. "/px.lua")
-- hell.lua: burning hell, from the scorched outskirts to the inferno. Run with ART set.
local sheet = P.sheet("hell", 512, 512)
local B, L = sheet.base, sheet.lights
local floor, sin, pi = math.floor, math.sin, math.pi

---------------------------------------------------------------------------------------------------
-- Tools: polygons as masks, and directional stone shading so plates read as carved rock
---------------------------------------------------------------------------------------------------
local function newMask(w, h)
  local m = { w = w, h = h }
  for y = 0, h - 1 do m[y] = {} end
  return m
end

local function fillPoly(m, pts)
  local n = #pts / 2
  for y = 0, m.h - 1 do
    local sy, xs = y + 0.5, {}
    for i = 1, n do
      local j = i % n + 1
      local x0, y0, x1, y1 = pts[2 * i - 1], pts[2 * i], pts[2 * j - 1], pts[2 * j]
      if (y0 <= sy and y1 > sy) or (y1 <= sy and y0 > sy) then
        xs[#xs + 1] = x0 + (sy - y0) / (y1 - y0) * (x1 - x0)
      end
    end
    table.sort(xs)
    for k = 1, #xs - 1, 2 do
      for x = math.ceil(xs[k] - 0.5), floor(xs[k + 1] - 0.5) do
        if x >= 0 and x < m.w then m[y][x] = true end
      end
    end
  end
  return m
end

local function polyFill(img, ox, oy, pts, c)
  local maxx, maxy = -1e9, -1e9
  for i = 1, #pts, 2 do
    maxx, maxy = math.max(maxx, pts[i]), math.max(maxy, pts[i + 1])
  end
  local w, h = math.ceil(maxx) + 2, math.ceil(maxy) + 2
  local m = fillPoly(newMask(w, h), pts)
  for y = 0, h - 1 do for x = 0, w - 1 do
    if m[y][x] then P.pix(img, ox + x, oy + y, c) end
  end end
end

-- A tapered curved form from a centre line of {x, y, r}: returns a flat polygon.
local function taper(line)
  local a, b = {}, {}
  for i, p in ipairs(line) do
    local q0, q1 = line[math.max(i - 1, 1)], line[math.min(i + 1, #line)]
    local dx, dy = q1[1] - q0[1], q1[2] - q0[2]
    local d = math.sqrt(dx * dx + dy * dy)
    local nx, ny = -dy / d, dx / d
    a[#a + 1] = { p[1] + nx * p[3], p[2] + ny * p[3] }
    b[#b + 1] = { p[1] - nx * p[3], p[2] - ny * p[3] }
  end
  local pts = {}
  for _, p in ipairs(a) do pts[#pts + 1] = p[1]; pts[#pts + 1] = p[2] end
  for i = #b, 1, -1 do pts[#pts + 1] = b[i][1]; pts[#pts + 1] = b[i][2] end
  return pts
end

-- Sawtooth with uneven teeth: bands of light break into slanted facets instead of smooth contours.
local TEETH = { 7, 4, 11, 5, 9, 3, 13, 6 }
local function saw(x, seed, amp)
  local sum = 0
  for _, t in ipairs(TEETH) do sum = sum + t end
  local h = (x + seed * 13) % sum
  for _, t in ipairs(TEETH) do
    if h < t then return floor(amp * h / t) end
    h = h - t
  end
  return 0
end


-- ramp: rim, light, fill, dark, edge. Light falls from the upper left; bands break into facets.
local function plate(img, m, ramp, seed, o)
  o = o or {}
  local rimW, lightW, darkW = o.rim or 1, o.light or 2, o.dark or 2
  local function inside(x, y) return y >= 0 and y < m.h and m[y][x] end
  for y = 0, m.h - 1 do for x = 0, m.w - 1 do
    if m[y][x] then
      local dT, dB, dL, dR = 1, 1, 1, 1
      while dT < 14 and inside(x, y - dT) do dT = dT + 1 end
      while dB < 14 and inside(x, y + dB) do dB = dB + 1 end
      while dL < 14 and inside(x - dL, y) do dL = dL + 1 end
      while dR < 14 and inside(x + dR, y) do dR = dR + 1 end
      local c = ramp.fill
      if dB == 1 or dR == 1 then c = ramp.edge
      elseif dB <= darkW + saw(x, seed + 3, 3) or dR <= 1 + saw(y, seed + 5, 2) then c = ramp.dark
      elseif dT <= rimW or dL <= rimW then c = ramp.rim
      elseif dT <= lightW + saw(x, seed, 4) then c = ramp.light
      end
      P.pix(img, x, y, c)
    end
  end end
end

local ROCK = { rim = "grey", light = "smoke", fill = "slate", dark = "ink", edge = "black" }

-- P.map with its size checked, because a row one character short shifts everything silently
local function amap(img, x, y, w, h, rows, legend)
  if #rows ~= h then error("expected " .. h .. " rows, got " .. #rows) end
  for j, r in ipairs(rows) do
    if #r ~= w then error("row " .. j .. " is " .. #r .. " wide, expected " .. w .. ": " .. r) end
  end
  P.map(img, x, y, rows, legend)
end

local function chain(img, pts, c)
  for i = 1, #pts - 2, 2 do P.line(img, pts[i], pts[i + 1], pts[i + 2], pts[i + 3], c) end
end

---------------------------------------------------------------------------------------------------
-- Layout: every strip is reserved here so the sheet stays in one order
---------------------------------------------------------------------------------------------------
local S = {}
local function reserve(name, w, h, frames, note) S[name] = P.strip(sheet, name, w, h, frames, note) end
reserve("mouthBack", 152, 104, 1, "behind the train; rail at row 95")
reserve("mouthFront", 152, 104, 1, "in front of the train; rail at row 95; rock solid over rows 59-94 at columns 112-148, so clip the train there")
reserve("flameL", 20, 28, 6, "fire, loops")
reserve("ash1", 48, 14, 1, "smoke cloud")
reserve("ash2", 34, 10, 1, "smoke cloud")
reserve("spire3", 26, 44, 1, "basalt stalagmite")
reserve("charred2", 22, 30, 1, "dead burnt tree")
reserve("charred1", 18, 26, 1, "dead burnt tree")
reserve("ruin1", 32, 24, 1, "burnt-out house")
reserve("ruin2", 28, 20, 1, "burnt-out house")
reserve("spire1", 16, 32, 1, "basalt stalagmite")
reserve("spire2", 12, 22, 1, "basalt stalagmite")
reserve("flameM", 12, 16, 6, "fire, loops")
reserve("flameS", 8, 10, 6, "fire, loops")
reserve("bat", 9, 6, 3, "flaps, loops")
reserve("brazier", 10, 18, 1, "iron fire-basket; flame in lights")
reserve("skulls", 16, 8, 1, "heap of skulls")
reserve("bones", 14, 6, 1, "scattered bones")
reserve("field3", 32, 26, 4, "biome 3 land behind the track; lava loops")
reserve("front3", 32, 16, 4, "biome 3 foreground; lava loops")
reserve("track3", 32, 10, 1, "biome 3 viaduct deck")

local function blitTo(name, f, base, light)
  local x, y = S[name](f)
  if base then P.blit(B, base, x, y) end
  if light then P.blit(L, light, x, y) end
end

---------------------------------------------------------------------------------------------------
-- The mouth: a colossal horned demon skull of black rock, facing LEFT and turned a little toward
-- the viewer so both eyes burn. Sprite rows: rail at 95, train roofline at 59, so the upper jaw and
-- its teeth stop at row 58. Everything right of the mouth corner is solid and hides the train.
---------------------------------------------------------------------------------------------------
do
  local W, H = 152, 104
  local back, front = P.image(W, H), P.image(W, H)
  local lightB, lightF = P.image(W, H), P.image(W, H)
  local function mask(pts) return fillPoly(newMask(W, H), pts) end
  local function poly(img, pts, c) polyFill(img, 0, 0, pts, c) end
  -- draw freely into a scratch image, keep only what falls inside the mask
  local function part(m, draw)
    local t = P.image(W, H)
    draw(t)
    for y = 0, H - 1 do for x = 0, W - 1 do
      if m[y][x] then
        local c = t:getPixel(x, y)
        if app.pixelColor.rgbaA(c) > 0 then front:drawPixel(x, y, c) end
      end
    end end
  end
  -- broken rim on upper edges, dark edge on lower and right ones
  local function rim(m, c, edge, seed, skip)
    for y = 0, H - 1 do for x = 0, W - 1 do
      if m[y][x] then
        local up = y == 0 or not m[y - 1][x]
        local left = x == 0 or not m[y][x - 1]
        local down = y == H - 1 or not m[y + 1][x]
        local right = x == W - 1 or not m[y][x + 1]
        if down or (right and not up) then P.pix(front, x, y, edge)
        elseif (up and not right or left) and saw(x + y, seed, 3) ~= (skip or 2) then P.pix(front, x, y, c)
        end
      end
    end end
  end
  -- a molten crack: black fissure in the base; in lights it runs red at the ends, rust, yellow at its hottest
  local function fissure(pts, hot, thick)
    local path = {}
    for i = 1, #pts - 2, 2 do
      local x0, y0, x1, y1 = pts[i], pts[i + 1], pts[i + 2], pts[i + 3]
      local n = math.max(math.abs(x1 - x0), math.abs(y1 - y0))
      for k = 0, n - 1 do
        path[#path + 1] = { floor(x0 + (x1 - x0) * k / n + 0.5), floor(y0 + (y1 - y0) * k / n + 0.5) }
      end
    end
    path[#path + 1] = { pts[#pts - 1], pts[#pts] }
    for i, p in ipairs(path) do
      local t = (i - 1) / math.max(#path - 1, 1)
      local mid = 1 - math.abs(t * 2 - 1)
      local c = "rust"
      if mid < 0.22 then c = "red" elseif hot and mid > 0.62 then c = "yellow" end
      P.pix(front, p[1], p[2], "black")
      P.pix(lightF, p[1], p[2], c)
      if thick and mid > 0.4 then
        P.pix(front, p[1], p[2] + 1, "black")
        P.pix(lightF, p[1], p[2] + 1, mid > 0.75 and "rust" or "red")
      end
    end
  end

  -- THROAT ----------------------------------------------------------------------------------------
  -- A cave of ribbed rock closing on a ragged gullet. The free edge of the far cheek sags inward, so
  -- the mouth has depth at the front. Rings are wobbled by angle: round ones read as a target.
  local tm = mask({ 19, 45, 40, 44, 80, 44, 118, 42, 128, 56, 128, 84, 116, 94, 60, 96, 26, 94, 14, 92,
                    26, 86, 33, 76, 35, 66, 33, 57, 27, 50 })
  local gx, gy = 100, 69
  local function depth(x, y)
    local dx, dy = (x - gx) * 1.3, (y - gy) * 0.9
    local a = math.atan(dy, dx)
    return math.sqrt(dx * dx + dy * dy) * (1 + 0.15 * sin(3 * a + 0.7) + 0.09 * sin(7 * a + 2.1))
  end
  local RIBS = { { 11, 3, "plum" }, { 21, 3, "plum" }, { 34, 3, "slate" }, { 50, 3, "slate" }, { 71, 4, "slate" } }
  for y = 0, H - 1 do for x = 0, W - 1 do
    if tm[y][x] then
      local d = depth(x, y)
      local c = d < 4 and "red" or (d < 11 and "plum" or "ink")
      for _, r in ipairs(RIBS) do
        -- the lit face of each rib looks at the fire; its back falls into black
        if d >= r[1] and d < r[1] + r[2] then c = r[3]
        elseif d >= r[1] + r[2] and d < r[1] + r[2] + 3 then c = "black" end
      end
      P.pix(back, x, y, c)
    end
  end end
  -- the free edge of the cheek catches a little light
  for y = 1, H - 2 do for x = 1, W - 2 do
    if tm[y][x] and not tm[y][x - 1] and y > 50 and y < 92 then P.pix(back, x, y, "slate"); P.pix(back, x + 1, y, "black") end
  end end
  -- under the rail the throat goes on, out of sight behind the lower jaw
  poly(back, { 30, 92, 118, 92, 118, 104, 30, 104 }, "black")
  -- the far jaw, dim, seen across the mouth; it may hang below the roofline because the train hides it
  poly(back, { 24, 49, 112, 49, 112, 53, 70, 54, 24, 52 }, "slate")
  poly(back, { 24, 88, 104, 86, 104, 92, 24, 92 }, "slate")
  local function farTooth(x, y0, w, len, dir)
    poly(back, { x, y0, x + w, y0, x + w * 0.65, y0 + dir * len }, "ink")
    poly(back, { x, y0, x + w * 0.5, y0, x + w * 0.65, y0 + dir * len }, "slate")
  end
  for _, t in ipairs({ { 30, 52, 8, 10 }, { 42, 52, 7, 8 }, { 53, 53, 8, 9 }, { 65, 53, 7, 8 }, { 77, 53, 6, 7 }, { 89, 52, 6, 6 }, { 100, 52, 6, 5 } }) do
    farTooth(t[1], t[2], t[3], t[4], 1)
  end
  for _, t in ipairs({ { 28, 88, 8, 11 }, { 40, 88, 7, 9 }, { 52, 88, 7, 10 }, { 64, 87, 6, 8 }, { 76, 87, 6, 8 }, { 88, 86, 6, 7 } }) do
    farTooth(t[1], t[2], t[3], t[4], -1)
  end
  -- the fire at the bottom of the gullet, ragged like the rings, and the first rib it lights
  for y = gy - 16, gy + 16 do for x = gx - 16, gx + 16 do
    if tm[y][x] then
      local d = depth(x, y)
      if d < 1.6 then P.pix(lightB, x, y, "yellow")
      elseif d < 4.2 then P.pix(lightB, x, y, "rust")
      elseif d < 8 then P.pix(lightB, x, y, "red") end
    end
  end end

  -- FAR HORN ------------------------------------------------------------------------------------
  do
    local line = { { 62, 22, 6 }, { 74, 14, 6 }, { 86, 9, 5 }, { 98, 6, 3.5 }, { 108, 3, 2 }, { 116, 0, 0.6 } }
    local m = mask(taper(line))
    part(m, function(t)
      P.rect(t, 0, 0, W, H, "ink")
      poly(t, { 56, 14, 72, 6, 100, 0, 116, -2, 100, 4, 84, 8, 66, 20 }, "slate")
    end)
    rim(m, "smoke", "ink", 2)
  end

  -- SKULL ---------------------------------------------------------------------------------------
  local skullPts = {
    9, 46, 6, 40, 8, 34, 2, 20, 14, 26, 22, 26, 34, 25, 40, 22, 37, 10, 49, 16, 58, 17, 66, 14, 80, 13, 96, 14, 110, 18,
    118, 25, 125, 19, 128, 30, 135, 25, 137, 37, 145, 32, 144, 46, 150, 45, 148, 57, 152, 62, 149, 72, 152, 78, 149, 86, 152, 92, 148, 96, 151, 100, 150, 104,
    112, 104, 104, 90, 108, 76, 112, 64, 112, 54, 106, 51, 90, 50, 70, 49, 50, 47, 30, 46, 16, 46 }
  local skull = mask(skullPts)
  part(skull, function(t)
    P.rect(t, 0, 0, W, H, "slate")
    -- the snout's top plane, and the front of the muzzle
    poly(t, { 2, 20, 13, 26, 22, 25, 36, 23, 40, 26, 30, 28, 20, 28, 13, 31, 8, 34 }, "smoke")
    poly(t, { 5, 40, 9, 34, 12, 34, 13, 40, 11, 46, 8, 46 }, "smoke")
    -- cranium planes
    poly(t, { 62, 14, 80, 12, 100, 13, 88, 17, 70, 19, 58, 22 }, "smoke")
    poly(t, { 96, 12, 116, 18, 130, 32, 118, 36, 104, 28 }, "ink")
    poly(t, { 107, 46, 114, 46, 113, 54, 106, 51 }, "ink")
  end)

  -- rear mass: the neck, diagonal vertebrae of black rock going down into the ground
  for i, q in ipairs({
    { 114, 40, 117, 30, 125, 19, 128, 30, 133, 38, 124, 49 },
    { 124, 49, 133, 38, 128, 30, 135, 25, 137, 37, 143, 45, 132, 56 },
    { 132, 56, 143, 45, 137, 37, 145, 32, 144, 46, 149, 56, 138, 65 },
    { 138, 65, 149, 56, 144, 46, 150, 45, 148, 57, 152, 62, 150, 72, 143, 76 },
    { 134, 74, 143, 76, 150, 72, 152, 78, 149, 86, 139, 90 },
    { 132, 90, 139, 90, 149, 86, 152, 92, 148, 96, 151, 100, 150, 104, 134, 104 },
  }) do
    plate(front, mask(q), ROCK, i + 20, { light = 2, dark = 2 })
  end

  -- tooth roots: the ribbed bone above the teeth is what says skull
  local upper = { { 11, 45, 8, 10 }, { 21, 45, 10, 13 }, { 33, 46, 6, 7 }, { 41, 46, 7, 10 }, { 50, 47, 6, 7 }, { 58, 47, 7, 9 },
                  { 67, 48, 6, 7 }, { 75, 48, 6, 7 }, { 83, 49, 6, 6 }, { 91, 49, 6, 6 }, { 99, 50, 5, 5 } }
  local lower = { { 6, 86, 10, 20 }, { 19, 89, 7, 10 }, { 28, 90, 8, 13 }, { 38, 91, 6, 8 }, { 46, 91, 7, 10 }, { 55, 91, 6, 7 },
                  { 63, 91, 6, 7 }, { 71, 90, 6, 7 }, { 79, 89, 6, 6 }, { 87, 87, 6, 6 } }
  part(skull, function(t)
    for _, i in ipairs({ 1, 2, 4, 6 }) do
      local r = upper[i]
      local x, y0, w, h = r[1], r[2], r[3], math.min(r[4] - 1, 9)
      poly(t, { x + 1, y0, x + 3, y0, x + 3, y0 - h + 1, x + 2, y0 - h + 1 }, "smoke")
      P.line(t, x + w, y0, x + w - 2, y0 - h + 1, "ink")
    end
    -- every tooth sits in a socket
    for _, r in ipairs(upper) do P.line(t, r[1] - 1, r[2], r[1] - 1, r[2] - 3, "ink") end
  end)

  -- nasal aperture: a raked slit with a lit upper lip
  poly(front, { 14, 35, 22, 31, 27, 32, 24, 35, 18, 39, 14, 38 }, "black")
  chain(front, { 13, 35, 22, 30, 28, 32 }, "grey")
  P.line(lightF, 17, 36, 21, 34, "red")

  -- far eye socket
  poly(front, { 40, 32, 46, 30, 53, 34, 58, 41, 55, 46, 46, 46, 41, 41 }, "black")
  chain(front, { 40, 43, 45, 47, 55, 47 }, "smoke")
  -- near eye socket
  poly(front, { 64, 41, 72, 31, 86, 27, 100, 29, 106, 38, 99, 46, 83, 48, 69, 46 }, "black")
  chain(front, { 66, 46, 70, 47, 83, 49, 100, 47, 107, 38 }, "smoke")

  -- brows meet in a V over the bridge of the nose
  do
    local m = mask({ 36, 26, 38, 12, 47, 17, 55, 22, 62, 30, 61, 37, 53, 31, 44, 27 })
    part(m, function(t)
      P.rect(t, 0, 0, W, H, "smoke")
      poly(t, { 36, 27, 46, 22, 54, 26, 62, 38, 50, 34 }, "slate")
    end)
    rim(m, "stone", "black", 9)
    m = mask({ 58, 35, 62, 27, 70, 21, 84, 18, 100, 18, 112, 22, 116, 31, 102, 26, 86, 25, 73, 29, 64, 39 })
    part(m, function(t)
      P.rect(t, 0, 0, W, H, "smoke")
      poly(t, { 60, 38, 70, 27, 86, 22, 104, 23, 118, 30, 110, 34, 86, 28, 72, 32, 62, 42 }, "slate")
    end)
    rim(m, "stone", "black", 11)
  end

  rim(skull, "grey", "ink", 1)

  -- NEAR HORN -----------------------------------------------------------------------------------
  do
    local line = { { 102, 25, 9 }, { 112, 18, 10.5 }, { 122, 13, 9.5 }, { 132, 11, 7.5 }, { 140, 8, 4.5 }, { 146, 4, 2.2 }, { 149, 0, 0.5 } }
    local m = mask(taper(line))
    part(m, function(t)
      P.rect(t, 0, 0, W, H, "smoke")
      local low = {}
      for i = 1, #line - 1 do
        low[#low + 1] = line[i][1]; low[#low + 1] = line[i][2] + 1
      end
      for _, v in ipairs({ 150, 0, 150, 60, 90, 60 }) do low[#low + 1] = v end
      poly(t, low, "slate")
      -- growth rings, tighter toward the tip
      local x = 104
      local gap = 8
      while x < 148 do
        P.line(t, x + 5, 0, x - 5, 38, "ink")
        P.line(t, x + 6, 0, x - 4, 20, "grey")
        x = x + gap
        gap = math.max(gap - 0.6, 4)
      end
    end)
    rim(m, "stone", "ink", 5)
  end

  -- LOWER JAW -----------------------------------------------------------------------------------
  do
    local jawPts = { -1, 79, 6, 84, 12, 85, 20, 88, 40, 90, 64, 90, 84, 88, 94, 85, 102, 78, 108, 66, 114, 56, 126, 56, 133, 66,
                     135, 80, 131, 92, 134, 104, 18, 104, 10, 98, 4, 90 }
    local m = mask(jawPts)
    part(m, function(t)
      P.rect(t, 0, 0, W, H, "slate")
      -- a lip of bone along the teeth
      poly(t, { 0, 79, 12, 84, 20, 87, 40, 89, 64, 89, 84, 87, 96, 84, 90, 90, 64, 93, 40, 93, 20, 92, 8, 89 }, "smoke")
      -- the ramus catches light on its leading edge
      poly(t, { 102, 79, 108, 66, 114, 55, 118, 55, 112, 66, 106, 79, 100, 88 }, "smoke")
      -- the belly falls into shadow
      poly(t, { 8, 96, 40, 99, 90, 100, 112, 96, 132, 92, 136, 104, 8, 104 }, "ink")
      -- the corner of the jaw turns away from the light
      poly(t, { 122, 76, 133, 70, 135, 80, 131, 92, 120, 94 }, "ink")
      -- one crease down the ramus: a plane break where the mass would otherwise go flat
      poly(t, { 123, 57, 125, 57, 115, 78, 111, 84, 108, 92, 106, 92, 109, 82, 113, 76 }, "ink")
    end)
    rim(m, "grey", "ink", 7)
    -- sockets of the lower teeth
    for _, r in ipairs(lower) do
      P.line(front, r[1] - 1, r[2], r[1] - 1, r[2] + 3, "ink")
      P.pix(front, r[1], r[2] + 2, "grey")
    end
    -- mental foramina
    poly(front, { 32, 96, 37, 95, 37, 97, 33, 98 }, "black")
    poly(front, { 58, 96, 63, 95, 63, 97, 59, 98 }, "black")
    poly(front, { 84, 94, 89, 93, 89, 95, 85, 96 }, "black")
  end

  -- MOLTEN CRACKS -------------------------------------------------------------------------------
  fissure({ 106, 38, 111, 41, 116, 39, 119, 45, 124, 49 }, false, true)
  fissure({ 124, 49, 132, 56, 138, 65, 143, 76 }, true, true)
  fissure({ 138, 65, 134, 74, 139, 80, 134, 90, 138, 97, 134, 103 }, true, true)
  fissure({ 139, 80, 146, 83, 150, 80 }, false, false)
  fissure({ 113, 56, 118, 52, 126, 53, 132, 58 }, true, true)
  fissure({ 134, 74, 127, 78, 125, 86, 117, 91 }, false, false)
  fissure({ 125, 86, 128, 92, 126, 98 }, false, false)
  fissure({ 90, 90, 94, 94, 92, 98, 97, 103 }, false, false)
  fissure({ 44, 96, 48, 99, 54, 97, 56, 103 }, false, false)
  fissure({ 108, 20, 104, 24, 106, 27 }, false, false)

  -- chips: a dark stroke with one lit pixel under it, a few per plane, so the rock stops looking poured
  for _, c in ipairs({ { 88, 20, 92, 22 }, { 112, 28, 115, 32 }, { 110, 47, 112, 51 } }) do
    P.line(front, c[1], c[2], c[3], c[4], "black")
    P.line(front, c[1], c[2] + 1, c[3], c[4] + 1, "smoke")
  end

  -- TEETH ---------------------------------------------------------------------------------------
  local function tooth(x, y0, w, len, dir, curve, heat)
    local tip = x + w * 0.6 + curve
    local pts = { x, y0, x + w * 0.22 + curve * 0.3, y0 + dir * len * 0.62, tip, y0 + dir * (len + 0.5), x + w * 0.72 + curve * 0.6, y0 + dir * len * 0.5, x + w, y0 }
    local m = mask(pts)
    for j = 0, H - 1 do for i = 0, W - 1 do
      if m[j][i] then
        local c = "steel"
        if not m[j][i - 1] then c = "ice"
        elseif not m[j][i + 1] then c = "stone"
        elseif not m[j][i + 2] and w > 6 then c = "stone"
        end
        local down = dir > 0 and j - y0 or y0 - j
        if down < 2 then c = "grey" end
        P.pix(front, i, j, c)
        if down >= 2 and not m[j][i + 1] then
          if heat > 0.72 and down >= len * 0.45 then P.pix(lightF, i, j, "rust")
          elseif heat > 0.3 then P.pix(lightF, i, j, "red") end
        end
      end
    end end
  end
  for i, t in ipairs(upper) do tooth(t[1], t[2], t[3], t[4], 1, 2, i / #upper) end
  for i, t in ipairs(lower) do tooth(t[1], t[2], t[3], t[4], -1, 1, i / #lower) end

  -- EYES ----------------------------------------------------------------------------------------
  poly(lightF, { 68, 42, 80, 35, 96, 31, 101, 34, 94, 40, 80, 44 }, "red")
  poly(lightF, { 73, 42, 82, 36, 94, 33, 96, 35, 89, 39, 79, 43 }, "rust")
  poly(lightF, { 78, 41, 84, 37, 91, 35, 90, 37, 84, 40 }, "yellow")
  poly(lightF, { 43, 34, 50, 37, 56, 43, 49, 43, 44, 39 }, "red")
  poly(lightF, { 46, 37, 50, 39, 54, 43, 49, 42 }, "rust")
  poly(lightF, { 48, 39, 51, 41, 49, 41 }, "yellow")

  -- a pixel of rock that shares its colour with no neighbour is speckle: give it to the commonest one
  local function despeckle(img, keep)
    local out = P.image(W, H)
    out:drawImage(img)
    for y = 1, H - 2 do for x = 1, W - 2 do
      local c = img:getPixel(x, y)
      if app.pixelColor.rgbaA(c) > 0 and not keep[c] then
        local n, best, bestN, same = {}, nil, 0, false
        for dy = -1, 1 do for dx = -1, 1 do
          if dx ~= 0 or dy ~= 0 then
            local o = img:getPixel(x + dx, y + dy)
            if o == c then same = true
            elseif app.pixelColor.rgbaA(o) > 0 then
              n[o] = (n[o] or 0) + 1
              if n[o] > bestN then best, bestN = o, n[o] end
            end
          end
        end end
        if not same and best then out:drawPixel(x, y, best) end
      end
    end end
    return out
  end
  local keep = {}
  for _, n in ipairs({ "ice", "steel", "black" }) do keep[P.hex(n)] = true end
  front = despeckle(front, keep)
  P.pix(front, 2, 20, nil) -- the snout spike's tip came out detached from its point

  blitTo("mouthBack", 0, back, lightB)
  blitTo("mouthFront", 0, front, lightF)
end

---------------------------------------------------------------------------------------------------
-- Fire: tongues of flame whose sway is a wave travelling up them. Every motion term has a whole
-- number of cycles per 6 frames, so frame 6 is frame 0. Ramp from the outside in: plum, red, rust, yellow.
---------------------------------------------------------------------------------------------------
do
  local function flame(name, w, h, tongues, sparks)
    for f = 0, 5 do
      local t = f / 6
      local img = P.image(w, h)
      local function layer(c, sw, sh)
        for _, g in ipairs(tongues) do
          local hh = g.h * sh * (1 + g.p * sin(2 * pi * (g.kp * t + g.ph)))
          for y = 0, h - 1 do
            local s = y / hh
            if s < 1 then
              local cx = g.x + g.a * (s ^ 0.8) * sin(2 * pi * (g.k * t - g.c * s + g.ph))
              local hw = g.w / 2 * sw * (1 - s) ^ g.e
              local x0, x1 = math.ceil(cx - hw), floor(cx + hw)
              if x1 < x0 then x0 = floor(cx + 0.5); x1 = x0 end
              for x = x0, x1 do P.pix(img, x, h - 1 - y, c) end
            end
          end
        end
      end
      layer("plum", 1.0, 1.1)
      layer("red", 0.86, 0.96)
      layer("rust", 0.58, 0.68)
      layer("yellow", 0.28, 0.4)

      -- pinholes and little islands of colour are speckle: each goes to the colour around it
      for pass = 1, 2 do
        local seen, flat = {}, P.image(w, h)
        flat:drawImage(img)
        local function key(x, y) return y * w + x end
        for sy = 0, h - 1 do for sx = 0, w - 1 do
          if not seen[key(sx, sy)] then
            local c = img:getPixel(sx, sy)
            local clear = app.pixelColor.rgbaA(c) == 0
            local stack, cells, edge, around = { { sx, sy } }, {}, false, {}
            seen[key(sx, sy)] = true
            while #stack > 0 do
              local q = table.remove(stack)
              cells[#cells + 1] = q
              for _, d in ipairs({ { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }) do
                local nx, ny = q[1] + d[1], q[2] + d[2]
                if nx < 0 or ny < 0 or nx >= w or ny >= h then edge = true
                else
                  local o = img:getPixel(nx, ny)
                  local same = o == c or (clear and app.pixelColor.rgbaA(o) == 0)
                  if same and not seen[key(nx, ny)] then
                    seen[key(nx, ny)] = true
                    stack[#stack + 1] = { nx, ny }
                  elseif not same and app.pixelColor.rgbaA(o) > 0 then
                    around[o] = (around[o] or 0) + 1
                  end
                end
              end
            end
            local best, bestN = nil, 0
            for o, n in pairs(around) do if n > bestN then best, bestN = o, n end end
            if best and ((clear and not edge and #cells <= 8) or (not clear and #cells <= 3)) then
              for _, q in ipairs(cells) do flat:drawPixel(q[1], q[2], best) end
            end
          end
        end end
        img = flat
      end

      -- a lone pixel beside the body is noise; the sparks below are the only things that fly free
      local clean = P.image(w, h)
      for y = 0, h - 1 do for x = 0, w - 1 do
        local c = img:getPixel(x, y)
        if app.pixelColor.rgbaA(c) > 0 then
          local n = 0
          for dy = -1, 1 do for dx = -1, 1 do
            local nx, ny = x + dx, y + dy
            if (dx ~= 0 or dy ~= 0) and nx >= 0 and ny >= 0 and nx < w and ny < h
               and app.pixelColor.rgbaA(img:getPixel(nx, ny)) > 0 then n = n + 1 end
          end end
          if n > 0 then clean:drawPixel(x, y, c) end
        end
      end end

      for _, sp in ipairs(sparks) do
        local age = (f - sp.t0) % 6
        if age < sp.life then
          local x, y = sp.x + sp.dx * age, sp.y - sp.v * age
          local c = age == 0 and "rust" or (age >= sp.life - 1 and "plum" or "red")
          P.pix(clean, x, y, c)
          if age == 0 then P.pix(clean, x, y + 1, "red") end
        end
      end

      local glow = P.image(w, h)
      local Y, R = P.hex("yellow"), P.hex("rust")
      for y = 0, h - 1 do for x = 0, w - 1 do
        local c = clean:getPixel(x, y)
        if c == Y or c == R then glow:drawPixel(x, y, c) end
      end end
      blitTo(name, f, clean, glow)
    end
  end

  flame("flameL", 20, 28, {
    { x = 9.5,  w = 15, h = 25, a = 2.6, k = 1, c = 1.1, ph = 0.00, p = 0.08, kp = 2, e = 0.85 },
    { x = 3.5,  w = 8,  h = 15, a = 2.0, k = 2, c = 0.9, ph = 0.35, p = 0.16, kp = 1, e = 0.8 },
    { x = 15.5, w = 8,  h = 17, a = 2.2, k = 2, c = 1.0, ph = 0.70, p = 0.16, kp = 1, e = 0.8 },
  }, {
    { x = 11, y = 5, dx = 0, v = 2, t0 = 0, life = 3 },
    { x = 6,  y = 9, dx = -1, v = 2, t0 = 2, life = 3 },
    { x = 15, y = 7, dx = 1, v = 2, t0 = 4, life = 3 },
  })
  flame("flameM", 12, 16, {
    { x = 5.5, w = 10, h = 14, a = 1.7, k = 1, c = 1.1, ph = 0.1, p = 0.08, kp = 2, e = 0.85 },
    { x = 2.5, w = 5,  h = 8,  a = 1.2, k = 2, c = 0.9, ph = 0.4, p = 0.18, kp = 1, e = 0.8 },
    { x = 8.5, w = 6,  h = 9,  a = 1.2, k = 2, c = 1.0, ph = 0.8, p = 0.18, kp = 1, e = 0.8 },
  }, {
    { x = 6, y = 3, dx = 0, v = 1, t0 = 1, life = 3 },
    { x = 9, y = 5, dx = 1, v = 1, t0 = 4, life = 3 },
  })
  -- At 8×10 a formula gives noise, so this one is drawn: the tip leans right, whips left and a lick
  -- peels off the top as a spark.
  local legend = { y = "yellow", o = "rust", r = "red", p = "plum" }
  local frames = {
    { ".....p..",
      "....pr..",
      "....rr..",
      "...prrp.",
      ".p.rorr.",
      ".rroorr.",
      ".rooooor",
      "rooyyoor",
      "rooyyyor",
      ".ooyyyo." },
    { "........",
      "......p.",
      ".....pr.",
      "....rrr.",
      "...prorp",
      ".prroorr",
      ".rrooorr",
      ".rooyoor",
      "rooyyyor",
      ".ooyyyo." },
    { ".....r..",
      ".....p..",
      "...pp...",
      "...rr.p.",
      "..prrpr.",
      ".prorrr.",
      ".rrooor.",
      ".rooyoor",
      "rooyyyor",
      ".ooyyoo." },
    { "........",
      ".....p..",
      "..pp....",
      "..rrp...",
      "..rrr.p.",
      ".prorpr.",
      ".rroorr.",
      ".rooyoor",
      "rooyyyor",
      ".ooyyyo." },
    { "........",
      ".p......",
      ".pr.....",
      ".rrp..p.",
      ".rrrp.r.",
      ".rorrpr.",
      "prooorr.",
      "rooyyoor",
      "rooyyyor",
      ".ooyyyo." },
    { "...p....",
      "...pp...",
      "..prr...",
      ".p.rrp..",
      ".rprrr.p",
      ".rrorr.r",
      ".roooorr",
      "rooyyoor",
      "rooyyyor",
      ".ooyyyo." },
  }
  for f, rows in ipairs(frames) do
    local img, glow = P.image(8, 10), P.image(8, 10)
    amap(img, 0, 0, 8, 10, rows, legend)
    local Y, R = P.hex("yellow"), P.hex("rust")
    for y = 0, 9 do for x = 0, 7 do
      local c = img:getPixel(x, y)
      if c == Y or c == R then glow:drawPixel(x, y, c) end
    end end
    blitTo("flameS", f - 1, img, glow)
  end
end
---------------------------------------------------------------------------------------------------
-- Bat: wings up, level, down, with the body on the same pixels in every frame. Mostly silhouette.
---------------------------------------------------------------------------------------------------
do
  local legend = { k = "ink", p = "plum" }
  local frames = {
    { "p.......p",
      "kp.....pk",
      "kkp.k.pkk",
      ".kkkkkkk.",
      "...kkk...",
      "....k...." },
    { ".........",
      "...k.k...",
      ".kkkkkkk.",
      "kkpkkkpkk",
      "k...k...k",
      "........." },
    { ".........",
      "...k.k...",
      "...kkk...",
      ".kkkkkkk.",
      "kkp.k.pkk",
      "k.......k" },
  }
  for f, rows in ipairs(frames) do
    local img, glow = P.image(9, 6), P.image(9, 6)
    amap(img, 0, 0, 9, 6, rows, legend)
    local eyeY = f == 1 and 3 or 2
    P.pix(img, 3, eyeY, "black"); P.pix(img, 5, eyeY, "black")
    P.pix(glow, 3, eyeY, "red"); P.pix(glow, 5, eyeY, "red")
    blitTo("bat", f - 1, img, glow)
  end
end
---------------------------------------------------------------------------------------------------
-- Ash: dark smoke torn by the wind, a heavy head and a tail streaming away. A pale ragged belly, so
-- the light thrown up from below at run time lands on a form that already expects it.
---------------------------------------------------------------------------------------------------
do
  local legend = { k = "ink", s = "slate", m = "smoke", g = "grey" }
  local img = P.image(48, 14)
  amap(img, 0, 0, 48, 14, {
    "..........kkkkkk................................",
    "......kkkkksssskkk..kkkk........................",
    "....kkksssssssssskkkssskkk......................",
    "..kksssssssssssssssssssssskkkk..................",
    ".kssskkkssssssssssssskkssssssskkk...............",
    ".kssssssskkssssssssssssskkssssssskkk............",
    "kkssssssssssssskkkssssssssssssssssskkkk.........",
    "kssssssssssssssssssssssssssskkkssssssssskkk.....",
    "kssssmmmsssssssssssmmmssssssssssssssssssssskkkk.",
    "kkmmmmmmmmmssssmmmmmmmmmssssmmmmmsssssssmmkkkkkk",
    ".kkmmmgggmmmmmmmmmgggmmmmmmmmmmmmmmmmmmkkk......",
    "...kkmmmmmmmkkkmmmmmmmmkkkmmmmmmkkkkkkk.........",
    ".....kkmmmkk...kkmmmmkk...kkkmmk................",
    ".......kkk.......kkkk.......kkk.................",
  }, legend)
  blitTo("ash1", 0, img)
  img = P.image(34, 10)
  amap(img, 0, 0, 34, 10, {
    "......kkkk........................",
    "...kkkkssskk.kkk..................",
    ".kkssssssssskksskkk...............",
    "kkssskkssssssssssssskkkk..........",
    "ksssssssskkssssssssssssskkk.......",
    "kssmmmssssssssmmmmsssssssssskkkk..",
    "kkmmmmmmmmmsmmmmmmmmmssmmmmkkkkkkk",
    ".kkmmgggmmmmmmggmmmmmmmkkk........",
    "...kkmmmkkkmmmmmkkmmkkk...........",
    ".....kkk...kkkkk..kk..............",
  }, legend)
  blitTo("ash2", 0, img)
end
---------------------------------------------------------------------------------------------------
-- Scorched outskirts: dead burnt trees. Charcoal with ashen light on the upper left limbs.
---------------------------------------------------------------------------------------------------
do
  local legend = { k = "ink", s = "ink", m = "slate", g = "smoke", b = "black", p = "plum" }
  local function tree(name, w, h, rows, embers)
    local img, glow = P.image(w, h), P.image(w, h)
    amap(img, 0, 0, w, h, rows, legend)
    for _, e in ipairs(embers) do P.pix(img, e[1], e[2], "black"); P.pix(glow, e[1], e[2], e[3]) end
    blitTo(name, 0, img, glow)
  end
  tree("charred1", 18, 26, {
    "............k.....",
    "...k........k.....",
    "...k.......gk.....",
    "...kk......kk.....",
    "....k..k...k....k.",
    "k...kk.k...k...kk.",
    "kk...k.kk.gk..kk..",
    ".kk..kk.k.kk.gk...",
    "..kk.gk.k.ks.kk...",
    "...kk.k.kgks.k....",
    "....kkkkkmsskk....",
    ".....kgkkmskk.....",
    "......kgmmsk......",
    ".......kmmsk......",
    ".......kmssk......",
    ".......kgmsk......",
    ".......kgmsk......",
    ".......kmmsk......",
    ".......kmmssk.....",
    "......kgmmssk.....",
    "......kgmsssk.....",
    "......kgmssskk....",
    ".....kkgmsssks....",
    ".....kgmmsssskk...",
    "...kkkgmssssskkk..",
    ".kkkkkkmsskkkkkkkk",
  }, { { 9, 11, "rust" }, { 8, 19, "rust" }, { 9, 19, "red" }, { 10, 22, "red" }, { 11, 8, "red" } })
  tree("charred2", 22, 30, {
    "..............k.......",
    "....k.........k.......",
    "....k.........gk....k.",
    "....kk.........k....k.",
    ".k...k.....k...kk..gk.",
    ".kk..kk....k....k..k..",
    "..kk..k....gk...kkkk..",
    "...k..gk....k..gkkk...",
    "k..kk..k....kk.kk.....",
    "kk..k..kk...gk.ks..kk.",
    ".kk.gk..k....k.kskkk..",
    "..kk.kk.gk...kkkskk...",
    "...kk.k..k...gkssk....",
    "....kgkk.kk..kksk.....",
    ".....kkkk.k.kkssk.....",
    "......kgmkkkgmsk......",
    ".......kmmkgmmsk......",
    ".......kgmmmmssk......",
    "........kgmmssk.......",
    "........kgmsssk.......",
    "........kgmbbsk.......",
    "........kgbbbsk.......",
    "........kmbbbsk.......",
    "........kmmbssk.......",
    "........kgmsssk.......",
    ".......kkgmssskk......",
    ".......kgmmsssks......",
    "......kkgmmssssk......",
    "....kkkkgmmsssskkk....",
    "..kkkkkkkmsssskkkkkkkk",
  }, { { 11, 20, "rust" }, { 10, 21, "yellow" }, { 11, 21, "rust" }, { 11, 22, "red" }, { 10, 13, "red" }, { 13, 26, "rust" }, { 16, 13, "red" } })
end
---------------------------------------------------------------------------------------------------
-- Burnt-out shells of the village's houses: the same gable, plinth and pane windows, gone. The
-- telling touches are the soot plume above each window and rafters standing like ribs.
---------------------------------------------------------------------------------------------------
do
  local legend = { k = "ink", s = "slate", m = "smoke", g = "grey", t = "stone", b = "black", p = "plum", B = "bark" }
  local function ruin(name, w, h, rows, frame, embers)
    local img, glow = P.image(w, h), P.image(w, h)
    amap(img, 0, 0, w, h, rows, legend)
    if frame then frame(img) end
    for _, e in ipairs(embers) do P.pix(img, e[1], e[2], "black"); P.pix(glow, e[1], e[2], e[3]) end
    blitTo(name, 0, img, glow)
  end
  -- house1 gone: the gable stands, the long wall is down to its sills, the roof is bare rafters
  ruin("ruin1", 32, 24, {
    "........k.......................",
    ".......kgk......................",
    ".......kgsk.....................",
    "......kgmsk.....................",
    "......kgmsk.....................",
    ".....kgmmsk.....................",
    ".....kgkkmsk....................",
    "....kgmkbkmk....................",
    "....kgmkbkmsk...................",
    "...kgmmkkmmsk...................",
    "...kgmmmmmmssk..................",
    "..kgmmmmmmmssk..................",
    "..kgmmmmmmmsskk.......k.k.......",
    ".kgmkkkkmmmsskkk.kk.kkgkk.k.....",
    ".kgkbbbbkmmssgmkkgmkkgmkk.gk....",
    ".kgkbbbbkmmssgkbkkmsgkbkkmmk....",
    ".kgkbbbbkmmssgkbbkmsgkbbkmsk....",
    ".kgkbbbbkmsssgkbbkmsgkbbkmmk....",
    ".kgkbbbbkmsssmkkkkmsmkkkkmmsk...",
    ".kgkbbbbkmsssmmssmmsmmssmsskk...",
    ".kmkbbbbksssssssssssssssssskkkk.",
    ".kggtggtggtggtggtggtggtggtgggsk.",
    ".kmmgmmgmmgmmgmmgmmgmmgmmgmmsskk",
    "kkssskssskssskssskssskssskssskkk",
  }, function(img)
    -- ridge beam, snapped; rafters parallel to the gable's slope, and the fire took some short
    P.line(img, 9, 2, 23, 2, "ink")
    P.line(img, 10, 1, 19, 1, "slate")
    P.pix(img, 24, 1, "ink")
    P.line(img, 13, 3, 18, 13, "ink")
    P.line(img, 17, 3, 21, 11, "ink")
    P.line(img, 21, 3, 23, 7, "ink")
    P.line(img, 14, 3, 15, 5, "slate")
    P.line(img, 18, 3, 19, 5, "slate")
  end, { { 8, 8, "rust" }, { 8, 7, "red" }, { 6, 16, "red" }, { 6, 18, "rust" }, { 23, 16, "red" }, { 16, 15, "rust" }, { 29, 22, "red" }, { 12, 22, "rust" } })
  -- house2 gone: a chimney alone, and half-timbering burnt to a black lattice
  ruin("ruin2", 28, 20, {
    "...................kgmsk....",
    "..................kggmssk...",
    "...................kgmsk....",
    "...................kmmsk....",
    "...................kgmsk....",
    "......k............kmmsk....",
    ".....ksk...........kgmsk....",
    "....kk.kk..........kmmsk....",
    "...ks.k.kk.........kgmsk....",
    "..kk..k..kk........kmmsk....",
    ".ks...k...kk...k...kgmsk....",
    "kskkkkskkkkkk.kk...kmmsk....",
    "k.k..k.k...k..ks...kgmsk....",
    "k..k.k.k..kk..kk...kmmskkk..",
    "k...kk.k.k.k.kmk.k.kgmskmk..",
    "kkkkkkkkkkkkkkkkkkkkkkkkkkk.",
    "kmmgmkbbkmmgmmsmmsmmgmmsmkk.",
    "kgmmskbbkgmmssmmssmgmmssmsk.",
    "kmmgmkbbkmmgmmsmmsmmgmmsmmkk",
    "kkssskbbkssskssskssskssskkkk",
  }, nil, { { 21, 3, "red" }, { 5, 11, "rust" }, { 6, 15, "red" }, { 7, 17, "rust" }, { 6, 18, "red" }, { 24, 14, "red" } })
end
---------------------------------------------------------------------------------------------------
-- Black basalt stalagmites: clusters of broken shards. Each shard has a lit face left of its ridge
-- and a dark one right of it, and fractures step across it, so the form is planes and breaks.
---------------------------------------------------------------------------------------------------
do
  -- ridge, left and right are point lists from the tip down
  local function shard(img, sh, tones)
    local function side(a, b, c)
      local pts = {}
      for _, p in ipairs(a) do pts[#pts + 1] = p[1]; pts[#pts + 1] = p[2] end
      for i = #b, 1, -1 do pts[#pts + 1] = b[i][1]; pts[#pts + 1] = b[i][2] end
      polyFill(img, 0, 0, pts, c)
    end
    side(sh.left, sh.ridge, tones[1])
    side(sh.ridge, sh.right, tones[2])
    for i = 1, #sh.left - 1 do P.line(img, sh.left[i][1], sh.left[i][2], sh.left[i + 1][1], sh.left[i + 1][2], tones[3]) end
    for i = 1, #sh.right - 1 do P.line(img, sh.right[i][1], sh.right[i][2], sh.right[i + 1][1], sh.right[i + 1][2], tones[4]) end
  end
  local NEAR = { "slate", "ink", "smoke", "ink" }
  local HERO = { "slate", "ink", "grey", "ink" }
  local FAR = { "ink", "ink", "slate", "ink" }
  local function s(tones, ridge, left, right) return { tones = tones, ridge = ridge, left = left, right = right } end
  local function spire(name, w, h, list, facets, breaks, seam)
    local img, glow = P.image(w, h), P.image(w, h)
    for _, q in ipairs(list) do shard(img, q, q.tones) end
    -- a gap of a pixel or two between shards is a pinhole in the silhouette
    for y = 1, h - 2 do for x = 1, w - 2 do
      local function has(i, j) return app.pixelColor.rgbaA(img:getPixel(i, j)) > 0 end
      if not has(x, y) then
        local n = (has(x - 1, y) and 1 or 0) + (has(x + 1, y) and 1 or 0) + (has(x, y - 1) and 1 or 0) + (has(x, y + 1) and 1 or 0)
        if n >= 3 then P.pix(img, x, y, "ink") end
      end
    end end
    local solid = P.image(w, h)
    P.blit(solid, img, 0, 0)
    for _, f in ipairs(facets) do polyFill(img, 0, 0, f[1], f[2]) end
    -- a break is a black step across the rock with its lower lip lit
    for _, b in ipairs(breaks) do
      chain(img, b, "black")
      local lip = {}
      for i = 1, #b, 2 do lip[i] = b[i]; lip[i + 1] = b[i + 1] + 1 end
      chain(img, lip, "smoke")
    end
    -- a molten seam low in the rock, so a spire still has a telling touch once the tint has flattened it
    for _, q in ipairs(seam) do P.pix(img, q[1], q[2], "black"); P.pix(glow, q[1], q[2], q[3]) end
    -- facets and breaks may not change the silhouette
    for y = 0, h - 1 do for x = 0, w - 1 do
      if app.pixelColor.rgbaA(solid:getPixel(x, y)) == 0 then P.pix(img, x, y, nil) end
    end end
    blitTo(name, 0, img, glow)
  end
  spire("spire3", 26, 44, {
    s(FAR, { { 23, 8 }, { 22, 20 }, { 23, 44 } }, { { 23, 8 }, { 20, 16 }, { 21, 18 }, { 18, 28 }, { 16, 44 } },
      { { 23, 8 }, { 24, 17 }, { 23, 19 }, { 25, 30 }, { 25, 44 } }),
    s(FAR, { { 3, 13 }, { 4, 30 }, { 5, 44 } }, { { 3, 13 }, { 1, 25 }, { 2, 27 }, { 0, 36 }, { 0, 44 } },
      { { 3, 13 }, { 6, 23 }, { 7, 30 }, { 6, 32 }, { 10, 44 } }),
    s(HERO, { { 19, 11 }, { 17, 20 }, { 15, 30 } }, { { 19, 11 }, { 15, 18 }, { 13, 28 } }, { { 19, 11 }, { 20, 20 }, { 19, 30 } }),
    s(HERO, { { 12, 0 }, { 11, 8 }, { 13, 20 }, { 12, 32 }, { 13, 44 } },
      { { 12, 0 }, { 10, 6 }, { 8, 8 }, { 9, 12 }, { 7, 20 }, { 4, 22 }, { 6, 27 }, { 3, 38 }, { 2, 44 } },
      { { 12, 0 }, { 14, 8 }, { 13, 10 }, { 16, 18 }, { 17, 26 }, { 15, 28 }, { 19, 36 }, { 21, 44 } }),
    s(NEAR, { { 6, 29 }, { 7, 36 }, { 8, 44 } }, { { 6, 29 }, { 3, 35 }, { 4, 37 }, { 1, 44 } }, { { 6, 29 }, { 9, 34 }, { 9, 37 }, { 13, 44 } }),
    s(NEAR, { { 20, 31 }, { 18, 38 }, { 19, 44 } }, { { 20, 31 }, { 15, 38 }, { 14, 44 } }, { { 20, 31 }, { 22, 36 }, { 22, 39 }, { 25, 44 } }),
  }, {
    { { 12, 2, 10, 8, 9, 12, 11, 12, 12, 8 }, "smoke" },
    { { 10, 13, 8, 20, 11, 20, 12, 13 }, "smoke" },
    { { 8, 23, 7, 28, 10, 28, 12, 23 }, "smoke" },
    { { 17, 13, 15, 18, 15, 22, 17, 18 }, "smoke" },
    { { 6, 30, 4, 36, 6, 37, 7, 33 }, "smoke" },
    { { 19, 33, 16, 38, 17, 40, 19, 36 }, "smoke" },
  }, { { 8, 12, 11, 13 }, { 5, 22, 10, 24 }, { 8, 36, 12, 34 } },
     { { 13, 43, "red" }, { 13, 42, "red" }, { 12, 41, "rust" }, { 12, 40, "rust" }, { 13, 39, "yellow" }, { 13, 38, "rust" }, { 12, 37, "red" }, { 12, 36, "red" } })
  spire("spire1", 16, 32, {
    s(FAR, { { 13, 7 }, { 12, 18 }, { 12, 32 } }, { { 13, 7 }, { 11, 14 }, { 12, 16 }, { 9, 24 }, { 8, 32 } },
      { { 13, 7 }, { 14, 15 }, { 13, 17 }, { 15, 26 }, { 15, 32 } }),
    s(HERO, { { 2, 11 }, { 4, 17 }, { 6, 24 } }, { { 2, 11 }, { 2, 18 }, { 3, 25 } }, { { 2, 11 }, { 6, 16 }, { 9, 24 } }),
    s(HERO, { { 7, 0 }, { 6, 9 }, { 8, 19 }, { 7, 32 } },
      { { 7, 0 }, { 5, 6 }, { 4, 8 }, { 5, 12 }, { 3, 19 }, { 2, 21 }, { 3, 25 }, { 0, 32 } },
      { { 7, 0 }, { 9, 8 }, { 8, 10 }, { 11, 19 }, { 10, 22 }, { 13, 32 } }),
    s(NEAR, { { 11, 20 }, { 10, 26 }, { 11, 32 } }, { { 11, 20 }, { 8, 27 }, { 7, 32 } }, { { 11, 20 }, { 13, 25 }, { 13, 27 }, { 15, 32 } }),
  }, { { { 7, 2, 5, 8, 5, 11, 7, 11, 7, 7 }, "smoke" }, { { 5, 13, 3, 20, 6, 21, 7, 14 }, "smoke" } },
     { { 5, 12, 7, 13 }, { 3, 22, 7, 24 } },
     { { 6, 31, "red" }, { 6, 30, "rust" }, { 7, 29, "rust" }, { 7, 28, "red" } })
  spire("spire2", 12, 22, {
    s(HERO, { { 2, 7 }, { 3, 12 }, { 4, 16 } }, { { 2, 7 }, { 1, 12 }, { 2, 14 }, { 2, 17 } }, { { 2, 7 }, { 5, 12 }, { 6, 16 } }),
    s(HERO, { { 5, 0 }, { 5, 7 }, { 6, 14 }, { 5, 22 } },
      { { 5, 0 }, { 4, 5 }, { 3, 7 }, { 4, 9 }, { 2, 15 }, { 1, 17 }, { 2, 18 }, { 0, 22 } },
      { { 5, 0 }, { 7, 7 }, { 6, 9 }, { 8, 15 }, { 8, 17 }, { 9, 22 } }),
    s(NEAR, { { 9, 10 }, { 9, 16 }, { 9, 22 } }, { { 9, 10 }, { 7, 16 }, { 6, 22 } }, { { 9, 10 }, { 11, 15 }, { 10, 17 }, { 12, 22 } }),
  }, { { { 5, 2, 4, 7, 4, 9, 6, 9, 6, 6 }, "smoke" }, { { 4, 11, 3, 16, 5, 17, 6, 12 }, "smoke" } }, { { 4, 9, 6, 10 } }, {})
end
---------------------------------------------------------------------------------------------------
-- What the fire left: a heap of skulls, and two thigh bones lying crossed.
---------------------------------------------------------------------------------------------------
do
  local legend = { s = "skin", a = "sand", w = "wood", B = "bark", p = "plum", k = "ink", b = "black" }
  local img = P.image(16, 8)
  amap(img, 0, 0, 16, 8, {
    ".....assssa.....",
    "....assssssa....",
    "....sbbssbbw....",
    "....sbbssbbw....",
    ".aas.sssbssw.aas",
    "asswBswswswBasss",
    "sbsbwBwwwwBsbsbw",
    "wwswwBBBBBBwwswB",
  }, legend)
  blitTo("skulls", 0, img)
  img = P.image(14, 6)
  amap(img, 0, 0, 14, 6, {
    "as..........as",
    "sssss....sssss",
    "...wsssssssw..",
    "....wsssssw...",
    "asssw....wsssa",
    "Bw..........wB",
  }, legend)
  blitTo("bones", 0, img)
end
---------------------------------------------------------------------------------------------------
-- Brazier: an iron basket on a post. The flame and the coals live in the lights.
---------------------------------------------------------------------------------------------------
do
  local legend = { k = "ink", s = "slate", m = "smoke", g = "grey", p = "plum", b = "black" }
  local img, glow = P.image(10, 18), P.image(10, 18)
  amap(img, 0, 0, 10, 18, {
    "..........",
    "..........",
    "..........",
    "..........",
    "..........",
    "..........",
    "..........",
    "g..g..s..k",
    "g..m..s..k",
    "gmmmmmmssk",
    ".gbmbbsbk.",
    ".gbmbbsbk.",
    "..gmmssk..",
    "....mk....",
    "....mk....",
    "....mk....",
    "...gmsk...",
    "..kgmsskk.",
  }, legend)
  blitTo("brazier", 0, img)
  amap(glow, 0, 0, 10, 18, {
    "....r.....",
    "....r..r..",
    "...rrr.r..",
    "..rroorr..",
    "..roooor..",
    ".rooyyoor.",
    ".rooyyyor.",
    ".royyyyor.",
    ".ro.yy.or.",
    "..........",
    "..o..y.o..",
    "..y..o.o..",
    "..........",
    "..........",
    "..........",
    "..........",
    "..........",
    "..........",
  }, { r = "red", o = "rust", y = "yellow" })
  blitTo("brazier", 0, nil, glow)
end
---------------------------------------------------------------------------------------------------
-- Ground, biome 3. Lava motion is a wave: a pixel's colour depends on (x / 2 + frame) mod 4, so
-- bright blobs travel left 2 px a frame, and after 4 frames every pixel is back where it began. The
-- tile is 32 wide, a multiple of the wave's 8, so it also repeats without a seam.
---------------------------------------------------------------------------------------------------
local function wave(x, f, shift) return (floor((x + shift) / 2) + f) % 4 end
do
  local W, H = 32, 26
  -- o core, e edge, c cooling crust; the rest is basalt
  local rivers = {
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "....................ceoec.......",
    "...................ceoec........",
    "....................ceoec.......",
    "...........ccc......ceoec.......",
    "........cceeeeccc...ceooec......",
    "cc....cceeooooeeeccceeoooeec..cc",
    "eeccceeoooooooooeeeeoooooeeeccee",
    "oeeeeooooooooooooooooeeeeeeeeeeo",
    "oooooooooooeeeeooooeecccceeooooo",
    "oooooooooeeecccceeoeec.ceooooooo",
    "eeeeeeeeeecc....cceeooeccceooeee",
    "cccccccccc........ceeooeeeeeeecc",
    "...................cceeooeeeecc.",
    ".....................ccceeeccc..",
    "........................ccc.....",
    "................................",
    "................................",
  }
  -- the upper river wanders and narrows: its centre row and half width, column by column, wrapped
  local yc = { 8, 8, 9, 9, 9, 10, 10, 10, 9, 9, 9, 8, 8, 7, 7, 7, 6, 6, 6, 7, 7, 7, 7, 7, 8, 8, 8, 8, 8, 8, 8, 8 }
  local hw = { 2, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 2, 2, 2, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 2 }
  local RANK = { ["."] = 0, c = 1, e = 2, o = 3 }
  for y = 0, 10 do
    local row = {}
    for x = 0, W - 1 do
      local d = math.abs(y - yc[x + 1])
      local k = rivers[y + 1]:sub(x + 1, x + 1)
      local r = d <= hw[x + 1] - 1 and "o" or (d <= hw[x + 1] and "e" or (d <= hw[x + 1] + 1 and "c" or "."))
      row[x + 1] = RANK[r] > RANK[k] and r or k
    end
    rivers[y + 1] = table.concat(row)
  end
  -- black basalt plates: Voronoi cells, wrapped left-right, squashed flat for perspective
  local seeds = { { 5, 2 }, { 17, 2 }, { 27, 3 }, { 12, 12 }, { 2, 13 }, { 25, 13 }, { 6, 24 }, { 17, 25 }, { 28, 24 } }
  local tones = { "ink", "slate", "ink", "ink", "slate", "slate", "slate", "ink", "slate" }
  local function cell(x, y)
    local best, second, id = 1e9, 1e9, 1
    for i, s in ipairs(seeds) do
      local dx = math.abs(x - s[1]); dx = math.min(dx, W - dx)
      local dy = (y - s[2]) * 2.4
      local d = math.sqrt(dx * dx + dy * dy)
      if d < best then second = best; best = d; id = i elseif d < second then second = d end
    end
    return id, second - best
  end
  assert(#rivers == H)
  for _, r in ipairs(rivers) do assert(#r == W, r) end
  for f = 0, 3 do
    local img, glow = P.image(W, H), P.image(W, H)
    for y = 0, H - 1 do for x = 0, W - 1 do
      local id, gap = cell(x, y)
      local c = tones[id]
      if gap < 1.0 then c = c == "slate" and "ink" or "black"
      elseif cell(x, y - 1) ~= id and c == "slate" then c = "smoke" end
      local k = rivers[y + 1]:sub(x + 1, x + 1)
      if k == "c" then c = "plum"
      elseif k == "e" then c = "red"
      elseif k == "o" then
        local v = wave(x, f, floor(y / 2) * 3)
        if v == 0 then c = "yellow"; P.pix(glow, x, y, c)
        elseif v == 3 then c = "red"
        else c = "rust"; if v == 1 then P.pix(glow, x, y, c) end
        end
      end
      P.pix(img, x, y, c)
    end end
    blitTo("field3", f, img, glow)
  end
end
---------------------------------------------------------------------------------------------------
-- Front: the shore of a lava lake, nearer than the field, with stumps of basalt columns along it.
-- At a 32 px period any peak reads as a sawtooth, so the rock is flat-topped and the shore stays low.
---------------------------------------------------------------------------------------------------
do
  local W, H = 32, 16
  local rocks = {
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "......................gggg......",
    "......................mmmsk.....",
    "...................ggggmmsk.....",
    "...................mmmsmmssk....",
    ".gggg...........gggmmmsmmsskgg..",
    "gmmmsggg...ggg..mmmmmmsmmsskmmgg",
    "mmmsmmmsgggmmsgggmmmsssmmsskmsmm",
    "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  }
  local legend = { k = "ink", s = "ink", m = "slate", g = "smoke", b = "black" }
  local function isRock(x, y)
    if y >= H then return true end
    if y < 0 then return false end
    return rocks[y + 1]:sub(x % W + 1, x % W + 1) ~= "."
  end
  -- r is a skin of cooler lava; the rest of the lake is rust
  local skins = {
    "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr",
    "..rrrr..........rrrrrr.......rr.",
    "rrrrrrrrr....rrrrrrrrrrrr...rrrr",
    "....rrr.........rrrr...........r",
    ".............rrrr.......rrrr....",
    "..rrrrr....rrrrrrrr...rrrrrrr...",
    ".....rrr......rrr.........rr....",
    "rr.................rr........rrr",
    "................................",
    "................................",
    "................................",
  }
  -- a glint is a streak running left: born as a point, it stretches, its tail catches up, and it is
  -- gone for a frame before it is born again, so its return is never seen and the four frames loop
  local glints = { { 6, 1, 0 }, { 24, 1, 2 }, { 14, 3, 1 }, { 28, 3, 3 }, { 3, 4, 2 }, { 20, 5, 0 }, { 9, 6, 3 }, { 28, 6, 1 }, { 15, 8, 2 }, { 5, 8, 0 } }
  local STREAK = { { 0, 0 }, { -2, 0 }, { -4, -1 } }
  for f = 0, 3 do
    local img, glow = P.image(W, H), P.image(W, H)
    for y = 0, H - 1 do for x = 0, W - 1 do
      local skin = skins[y + 1] and skins[y + 1]:sub(x + 1, x + 1) == "r"
      P.pix(img, x, y, skin and "red" or "rust")
      if not skin then P.pix(glow, x, y, "rust") end
    end end
    for _, g in ipairs(glints) do
      local span = STREAK[(f + g[3]) % 4 + 1]
      if span then
        for x = span[1], span[2] do
          P.pix(img, (g[1] + x) % W, g[2], "yellow"); P.pix(glow, (g[1] + x) % W, g[2], "yellow")
        end
        for _, x in ipairs({ span[1] - 1, span[2] + 1 }) do
          P.pix(img, (g[1] + x) % W, g[2], "rust"); P.pix(glow, (g[1] + x) % W, g[2], "rust")
        end
      end
    end
    -- lava cools against the rock
    for y = 0, H - 1 do for x = 0, W - 1 do
      if isRock(x, y + 1) or isRock(x - 1, y) or isRock(x + 1, y) then P.pix(img, x, y, "plum"); P.pix(glow, x, y, nil)
      elseif isRock(x, y + 2) then P.pix(img, x, y, "red"); P.pix(glow, x, y, nil) end
    end end
    P.map(img, 0, 0, rocks, legend)
    blitTo("front3", f, img, glow)
  end
end
---------------------------------------------------------------------------------------------------
-- Track: a stone viaduct. Rails and sleepers stay exactly in step with the other biomes. Below the
-- deck a coping course and two low arches a tile, with lava under them. front3 covers row 9.
---------------------------------------------------------------------------------------------------
do
  local legend = { i = "ice", t = "stone", g = "grey", m = "smoke", s = "slate", k = "ink", b = "black", W = "wood", B = "bark", p = "plum", S = "sand", r = "red", o = "rust" }
  local img, glow = P.image(32, 10), P.image(32, 10)
  amap(img, 0, 0, 32, 10, {
    "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiigi",
    "tttttttttttttttttttttttttttttt" .. "gt",
    "SWWWWkkkSWWWWkkkSWWWWkkkSWWWWkkk",
    "BBBBBkkkBBBBBkkkBBBBBkkkBBBBBkkk",
    "pppppgggpppppgggpppppgggpppppggg",
    "tgggkgggtggkggggtgggkgggtggkgggg",
    "mmmkbbbbkmmmmgmmmmmkbbbbkmmmmgmm",
    "mmkbbbbbbkmmmgmmmmkbbbbbbkmmmgmm",
    "mkbprrrrpbkmmgmmmkbprrrrpbkmmgmm",
    "mkbprrrrpbkmmgmmmkbprrrrpbkmmgmm",
  }, legend)
  for _, x in ipairs({ 4, 5, 6, 7, 20, 21, 22, 23 }) do P.pix(glow, x, 8, "rust"); P.pix(glow, x, 9, "rust") end
  blitTo("track3", 0, img, glow)
end
---------------------------------------------------------------------------------------------------
-- The terminus: the one station in the world, burnt out, with its clock stopped at the cap. A vault
-- on cast iron, torn open, and at its right end the stone gable, the only part the stopped train
-- leaves in full view. Nothing on it is spaced evenly, and nothing reads as lettering.
---------------------------------------------------------------------------------------------------
reserve("terminus", 176, 64, 1, "the end of the line; behind the train, top at railY - 66; the nose stops at column 130")
do
  local W, H = 176, 64
  local img, glow = P.image(W, H), P.image(W, H)
  local function mask(pts) return fillPoly(newMask(W, H), pts) end
  local function poly(pts, c) polyFill(img, 0, 0, pts, c) end
  local function round(v) return floor(v + 0.5) end
  -- y of a polyline at x: the shed's long lines all sag and lift along these
  local function along(pts, x)
    for i = 1, #pts - 3, 2 do
      if x <= pts[i + 2] then
        return pts[i + 1] + (pts[i + 3] - pts[i + 1]) * (x - pts[i]) / (pts[i + 2] - pts[i])
      end
    end
    return pts[#pts]
  end
  local function clearIn(pts)
    local m = mask(pts)
    for y = 0, H - 1 do for x = 0, W - 1 do if m[y][x] then P.pix(img, x, y, nil) end end end
  end

  local EAVE = { -6, 42, 3, 35, 8, 31, 13, 29, 26, 29, 44, 28, 62, 29, 72, 30, 84, 28, 98, 26, 116, 26, 138, 25 }
  local RIDGE = { -6, 26, 8, 21, 24, 16, 44, 14, 58, 15, 72, 16, 88, 11, 98, 12, 108, 11, 118, 9, 138, 9 }
  local FARE = { -6, 36, 40, 35, 90, 37, 138, 34 }
  local PLAT = { 0, 62, 2, 60, 5, 60, 7, 57, 11, 56, 18, 55, 30, 54, 44, 55, 60, 54, 62, 55, 63, 58, 65, 57, 67, 60, 69, 58, 71, 59, 72, 55, 80, 54, 100, 55, 103, 55, 104, 57, 105, 56, 107, 59, 109, 57, 110, 55, 118, 54, 132, 53, 170, 53, 172, 56, 174, 58, 175, 63 }

  -- molten cracks, as on the mouth: thin, kinked, branching, red at the ends and hot in the middle
  local function crack(pts, hot)
    local path = {}
    for i = 1, #pts - 2, 2 do
      local x0, y0, x1, y1 = pts[i], pts[i + 1], pts[i + 2], pts[i + 3]
      local n = math.max(math.abs(x1 - x0), math.abs(y1 - y0))
      for k = 0, n - 1 do
        path[#path + 1] = { round(x0 + (x1 - x0) * k / n), round(y0 + (y1 - y0) * k / n) }
      end
    end
    path[#path + 1] = { pts[#pts - 1], pts[#pts] }
    for i, p in ipairs(path) do
      local t = (i - 1) / math.max(#path - 1, 1)
      local mid = 1 - math.abs(t * 2 - 1)
      local c = "rust"
      if mid < 0.3 then c = "red" elseif hot and mid > 0.72 then c = "yellow" end
      P.pix(img, p[1], p[2], "black")
      P.pix(glow, p[1], p[2], c)
    end
  end

  -- THE FAR SIDE ------------------------------------------------------------------------------------
  -- the inside of the far half of the vault, seen under the near eaves, and the far columns below it
  for x = 20, 138 do
    for y = round(along(EAVE, x)), round(along(FARE, x)) do P.pix(img, x, y, "ink") end
    P.pix(img, x, round(along(FARE, x)) + 1, "black")
  end
  for _, x in ipairs({ 22, 61, 88, 104, 126 }) do
    P.rect(img, x, 36, 2, 18, "ink")
  end
  clearIn({ 30, 39, 34, 41, 46, 38, 41, 30, 36, 33 })
  clearIn({ 56, 39, 60, 32, 67, 35, 76, 33, 84, 40 })

  -- THE NEAR ROOF -----------------------------------------------------------------------------------
  local skin = newMask(W, H)
  for x = 10, 138 do
    for y = round(along(RIDGE, x)), round(along(EAVE, x)) do skin[y][x] = true end
  end
  local function tear(pts)
    local m = mask(pts)
    for y = 0, H - 1 do for x = 0, W - 1 do if m[y][x] then skin[y][x] = nil end end end
  end
  -- the left end, torn away on a long ragged diagonal, then the holes, none like another
  tear({ 0, 0, 33, 0, 29, 15, 33, 19, 26, 20, 29, 24, 22, 25, 25, 29, 18, 29, 20, 34, 0, 34 })
  tear({ 38, 24, 42, 22, 46, 25, 44, 28, 39, 28 })
  tear({ 54, 0, 83, 0, 81, 11, 85, 14, 79, 19, 81, 25, 74, 23, 69, 29, 63, 24, 59, 27, 57, 19, 51, 16 })
  tear({ 90, 17, 94, 15, 99, 17, 102, 16, 101, 19, 96, 19, 94, 21 })
  tear({ 106, 0, 113, 0, 112, 10, 114, 14, 111, 20, 109, 16, 107, 18, 107, 12 })
  for y = 0, H - 1 do for x = 0, W - 1 do
    if skin[y][x] then
      local r, e = along(RIDGE, x), along(EAVE, x)
      local v = (y - r) / (e - r) + saw(x, 3, 3) * 0.03
      local c = "ink"
      if v < 0.2 then c = "smoke" elseif v < 0.48 then c = "slate" elseif v > 0.86 then c = "black" end
      P.pix(img, x, y, c)
    end
  end end
  for _, f in ipairs({ 0.36, 0.68 }) do
    for x = 10, 138 do
      local y = round(along(RIDGE, x) + (along(EAVE, x) - along(RIDGE, x)) * f)
      if skin[y][x] then P.pix(img, x, y, "black") end
    end
  end
  -- the torn plate's thickness along each hole
  for y = 1, H - 2 do for x = 1, W - 2 do
    if skin[y][x] and not skin[y + 1][x] and y < 27 then P.pix(img, x, y, "black") end
    if skin[y][x] and not skin[y - 1][x] then P.pix(img, x, y, saw(x, 5, 3) == 1 and "slate" or "grey") end
  end end
  -- the ridge beam and a purlin still cross the great hole, sagging, and plates hang from them
  chain(img, { 51, 15, 58, 17, 66, 19, 71, 19, 76, 15, 85, 12 }, "ink")
  chain(img, { 51, 16, 58, 18, 66, 20, 70, 20 }, "black")
  chain(img, { 58, 23, 62, 25, 65, 26 }, "ink")
  -- and over the narrow split, so the crown runs on unbroken to the gable
  chain(img, { 103, 9, 107, 10, 110, 11, 114, 9, 117, 8 }, "ink")
  chain(img, { 104, 10, 107, 11, 110, 12, 113, 10 }, "black")
  poly({ 67, 21, 70, 21, 71, 27, 68, 30 }, "ink")
  poly({ 67, 21, 68, 21, 69, 28, 68, 29 }, "slate")
  poly({ 76, 16, 78, 15, 79, 20, 77, 22 }, "ink")
  -- what is left of the broken end: purlin stubs and one plate, so it stays a roof and not a tree
  chain(img, { 12, 24, 17, 23, 22, 23 }, "ink")
  chain(img, { 9, 28, 14, 27 }, "ink")
  poly({ 18, 28, 23, 27, 22, 23, 19, 24 }, "ink")
  P.line(img, 19, 24, 22, 23, "slate")
  -- ribs, a little curved and leaning toward the gable; some snapped short
  local RIBS = { { 4, 0.3 }, { 10, 0.6 }, { 17, 0.86 }, { 25, 1 }, { 32, 1 }, { 41, 1 }, { 47, 1 }, { 59, 1 },
                 { 66, 0.92 }, { 73, 0.72 }, { 79, 1 }, { 91, 1 }, { 101, 1 }, { 108, 0.5 }, { 114, 1 }, { 123, 1 }, { 131, 1 } }
  for _, q in ipairs(RIBS) do
    local x0, top = q[1], q[2]
    local lean = 2 + (136 - x0) * 0.035
    local e0 = along(EAVE, x0)
    for k = 0, 24 do
      local a = k / 24 * top * pi / 2
      local x = x0 + lean * (1 - math.cos(a))
      local y = e0 + (along(RIDGE, x) - e0) * sin(a)
      P.pix(img, round(x), round(y), "smoke")
      P.pix(img, round(x) + 1, round(y), "black")
    end
  end
  -- the smoke vent along the crown, where the crown survives
  local function crown(x) return x >= 86 and x <= 134 and skin[round(along(RIDGE, x))][x] end
  for x = 86, 134 do
    local r = round(along(RIDGE, x))
    if crown(x) then
      -- it thins out wherever it ends, so a broken run does not stop in a square block
      local rows = 3
      for d = 1, 2 do if not crown(x - d) or not crown(x + d) then rows = math.min(rows, d) end end
      for k = 1, rows do
        P.pix(img, x, r - k, k == rows and "slate" or (saw(x, 2, 3) == 0 and "black" or "ink"))
      end
    end
  end

  -- THE IRON ----------------------------------------------------------------------------------------
  local function beam(x0, x1)
    for x = x0, x1 do
      local y = round(along(EAVE, x))
      P.pix(img, x, y, saw(x, 1, 3) == 0 and "grey" or "smoke")
      P.pix(img, x, y + 1, "slate")
      P.pix(img, x, y + 2, "black")
    end
  end
  beam(3, 64); beam(71, 134)
  P.rect(img, 2, 36, 2, 2, "ink"); P.pix(img, 2, 38, "black")
  local function spandrel(xc, y0, r, side)
    for a = 0, 16 do
      local t = a / 16 * pi / 2
      P.pix(img, round(xc + side * (r - r * math.cos(t))), round(y0 + r - r * sin(t)), "slate")
    end
  end
  local function column(xf, xt, top, foot)
    for y = top, foot do
      local x = round(xf + (xt - xf) * (foot - y) / (foot - top))
      P.pix(img, x - 1, y, "smoke"); P.pix(img, x, y, "slate"); P.pix(img, x + 1, y, "black")
    end
    P.rect(img, xt - 2, top, 5, 1, "smoke"); P.rect(img, xt - 1, top + 1, 3, 1, "slate")
    P.rect(img, xf - 2, foot - 3, 5, 4, "slate"); P.rect(img, xf - 2, foot - 3, 5, 1, "smoke"); P.rect(img, xf + 2, foot - 2, 1, 3, "black")
  end
  column(6, 8, 33, 57)
  column(16, 17, 32, 55)
  column(49, 51, 31, 55)
  column(61, 66, 33, 55)
  column(84, 83, 31, 54)
  column(98, 97, 29, 55)
  column(120, 121, 29, 54)
  column(131, 131, 28, 53)
  -- one has snapped: a stump below, and its head still hanging from the beam
  column(36, 36, 46, 54)
  clearIn({ 33, 44, 40, 44, 39, 47, 37, 46, 36, 48, 34, 46 })
  for y = 31, 39 do P.pix(img, 35, y, "smoke"); P.pix(img, 36, y, "slate"); P.pix(img, 37, y, "black") end
  P.rect(img, 34, 31, 5, 1, "smoke")
  P.pix(img, 36, 40, "slate"); P.pix(img, 37, 40, "black"); P.pix(img, 36, 41, "black")
  spandrel(16, 31, 7, -1); spandrel(18, 31, 7, 1)
  spandrel(50, 30, 8, -1); spandrel(52, 30, 5, 1)
  spandrel(83, 30, 7, -1); spandrel(85, 30, 8, 1)
  spandrel(96, 28, 6, -1); spandrel(98, 28, 9, 1)
  spandrel(120, 28, 7, -1); spandrel(122, 28, 4, 1)

  -- hanging lamps, on chains of no one length
  local function lamp(x, len)
    local e = round(along(EAVE, x)) + 3
    for y = e, e + len - 1 do if (y - e) % 2 == 0 then P.pix(img, x, y, "ink") else P.pix(img, x, y, "black") end end
    local y = e + len
    amap(img, x - 2, y, 5, 7, {
      "..k..",
      ".kkk.",
      "kbbbk",
      "kbbbk",
      "kbbbk",
      ".kkk.",
      "..k..",
    }, { k = "ink", b = "black" })
    amap(glow, x - 2, y, 5, 7, {
      ".....",
      ".....",
      ".ror.",
      ".oyo.",
      ".oyo.",
      ".....",
      ".....",
    }, { r = "red", o = "rust", y = "yellow" })
  end
  lamp(27, 2)
  lamp(43, 5)
  lamp(93, 0)
  lamp(110, 3)
  -- and one has gone out, hanging crooked from a broken chain
  P.line(img, 76, 32, 73, 37, "ink")
  P.map(img, 71, 38, { "kkk", "kbk", "kkk" }, { k = "ink", b = "black" })

  -- THE PLATFORM ------------------------------------------------------------------------------------
  local tops = {}
  for x = 0, W - 1 do tops[x] = round(along(PLAT, x)) end
  for x = 0, W - 1 do P.rect(img, x, tops[x], 1, H - tops[x], "ink") end
  local widths = { 9, 13, 7, 16, 6, 11, 14, 8, 10, 5 }
  local tones = { "ink", "ink", "slate", "ink", "black", "ink", "ink", "slate", "ink", "black", "slate", "ink", "ink" }
  local lighter = { ink = "slate", slate = "smoke", black = "ink" }
  for c, q in ipairs({ { 57, 3 }, { 60, 4 } }) do
    local x, i = -3 + c * 4, c * 3
    while x < W do
      local w, tone = widths[i % #widths + 1], tones[i % #tones + 1]
      for py = q[1], q[1] + q[2] - 1 do for px = x, x + w - 1 do
        if px >= 0 and px < W and py >= tops[px] + 2 then
          local p = tone
          if px == x + w - 1 or py == q[1] + q[2] - 1 then p = "black"
          elseif py == q[1] then p = lighter[tone] end
          P.pix(img, px, py, p)
        end
      end end
      x, i = x + w, i + 1
    end
  end
  -- the coping, thick and worn, with stretches fallen away
  for x = 0, W - 1 do
    local t = tops[x]
    local gone = (x >= 23 and x <= 29) or (x >= 63 and x <= 71) or (x >= 104 and x <= 109) or (x >= 148 and x <= 151)
    if not gone then
      P.pix(img, x, t, saw(x, 4, 4) == 0 and "smoke" or "grey")
      P.pix(img, x, t + 1, "slate")
      P.pix(img, x, t + 2, "black")
    else
      P.pix(img, x, t, nil); P.pix(img, x, t + 1, "smoke"); P.pix(img, x, t + 2, "ink")
    end
  end
  -- stones fallen from the wall, so it does not simply end at the ground
  local function stone(x, y, w, h)
    P.rect(img, x, y + 1, w, h - 1, "smoke")
    P.rect(img, x + 1, y, w - 2, 1, "grey")
    P.rect(img, x + w - 2, y + 1, 2, h - 1, "slate")
    P.vline(img, x + w - 1, y + 1, h - 1, "ink")
    P.hline(img, x, y + h - 1, w, "black")
  end
  for _, s in ipairs({ { 8, 60, 6, 4 }, { 13, 62, 4, 2 }, { 22, 61, 5, 3 }, { 41, 62, 3, 2 }, { 58, 60, 7, 4 }, { 66, 61, 8, 3 }, { 72, 62, 3, 2 },
                       { 96, 61, 5, 3 }, { 103, 60, 6, 4 }, { 108, 62, 5, 2 }, { 124, 62, 4, 2 }, { 133, 61, 5, 3 },
                       { 148, 62, 4, 2 }, { 165, 60, 5, 4 }, { 169, 58, 6, 6 }, { 173, 61, 3, 3 } }) do
    stone(s[1], s[2], s[3], s[4])
  end

  -- THE GABLE ---------------------------------------------------------------------------------------
  -- wall first, then the coping on its rakes, with a bite gone from the right one
  local wall = mask({ 141, 54, 141, 21, 148, 10, 153, 2, 158, 10, 166, 22, 166, 54 })
  plate(img, wall, ROCK, 7, { light = 2, dark = 1 })
  P.line(img, 142, 21, 153, 3, "stone"); P.line(img, 143, 21, 153, 4, "grey"); P.line(img, 144, 21, 153, 5, "black")
  P.line(img, 153, 3, 165, 22, "grey"); P.line(img, 153, 4, 164, 22, "smoke"); P.line(img, 153, 5, 163, 21, "black")
  -- spines along the rakes, of no one size, as on the beast's back
  local function spine(x, y, len, side)
    local tip = { x + side * len * 0.6, y - len }
    poly({ x - 1.5, y + 1, x + 1.5, y + 1, tip[1], tip[2] }, "slate")
    P.line(img, x + (side < 0 and -1 or 0), y, round(tip[1]), round(tip[2]), side < 0 and "grey" or "smoke")
    P.pix(glow, x + 1, y - 1, "red")
  end
  spine(145, 15, 4, -1); spine(149, 8, 3, -1); spine(142, 20, 3, -1)
  poly({ 151.5, 5, 154.5, 5, 154, 2, 155, 0, 153, 1 }, "ink")
  P.line(img, 152, 4, 153, 1, "grey")
  -- a slit high in the point, with the fire behind it
  P.rect(img, 152, 8, 2, 3, "black"); P.pix(img, 152, 7, "black")
  P.rect(glow, 152, 9, 2, 2, "red"); P.pix(glow, 153, 10, "rust")

  -- a turret: lit on the left, a moulding that juts a pixel at each band
  local function turret(x0, w, top, foot, bands)
    for y = top, foot do for i = 0, w - 1 do
      local c = "slate"
      if i == 0 then c = "stone" elseif i < w * 0.45 then c = "grey" elseif i == w - 1 then c = "black" elseif i >= w * 0.72 then c = "ink" end
      P.pix(img, x0 + i, y, c)
    end end
    for _, b in ipairs(bands) do
      P.hline(img, x0 - 1, b, w + 2, "stone"); P.hline(img, x0 - 1, b + 1, w + 2, "black")
    end
  end
  turret(134, 7, 22, 53, { 22, 35, 46 })
  turret(166, 6, 20, 53, { 39, 46 })
  P.rect(img, 136, 26, 2, 4, "black"); P.pix(img, 137, 25, "black")
  P.rect(img, 168, 33, 2, 5, "black"); P.pix(img, 168, 32, "black"); P.rect(glow, 168, 35, 2, 3, "red")
  for _, q in ipairs({ { 135, 32, 3 }, { 137, 41, 3 }, { 136, 50, 4 }, { 167, 42, 3 }, { 169, 49, 2 }, { 138, 37, 2 } }) do P.hline(img, q[1], q[2], q[3], "ink") end
  local function solid(x, y) return app.pixelColor.rgbaA(img:getPixel(x, y)) > 0 end
  clearIn({ 166, 19, 174, 19, 174, 35, 171.5, 29, 170, 31, 169, 26, 167.5, 28, 166.5, 24 })
  for x = 166, 171 do
    for y = 20, 36 do
      if solid(x, y) then
        P.pix(img, x, y, x % 3 == 1 and "grey" or "smoke"); P.pix(img, x, y + 1, "black")
        break
      end
    end
  end
  -- the left spire stands, the right has snapped
  local function spire(cx, base, top, half)
    for y = top, base do
      local hw = half * (y - top) / (base - top)
      for x = round(cx - hw), round(cx + hw) do
        P.pix(img, x, y, x < cx and "smoke" or (x <= cx + 1 and "slate" or "ink"))
      end
    end
  end
  spire(137, 21, 2, 3.5)
  P.pix(img, 135, 12, "grey"); P.pix(img, 139, 16, "ink"); P.pix(img, 134, 17, "grey")

  -- the clock: a rose of cut stone round old glass with the fire behind it, hottest low and to the
  -- right, as in the beast's eye. Both hands at twelve; no numerals.
  local cx, cy, ringR, rimR, faceR = 153, 25, 11.4, 9.7, 8.8
  for y = cy - 13, cy + 13 do for x = cx - 13, cx + 13 do
    local dx, dy = x - cx, y - cy
    local d = math.sqrt(dx * dx + dy * dy)
    if d <= ringR then
      local lit = -(dx + dy) / (d + 0.01)
      local c = lit > 0.5 and "stone" or (lit > -0.4 and "grey" or "smoke")
      P.pix(img, x, y, c)
    end
  end end
  for _, deg in ipairs({ 33, 78, 121, 176, 226, 281, 331 }) do
    local a = deg * pi / 180
    for r = rimR, ringR, 0.5 do P.pix(img, round(cx + r * sin(a)), round(cy - r * math.cos(a)), "ink") end
  end
  P.disc(img, cx, cy, rimR, "black")
  P.disc(img, cx, cy, faceR, "ink")
  for y = cy - 10, cy + 10 do for x = cx - 10, cx + 10 do
    if math.sqrt((x - cx) ^ 2 + (y - cy) ^ 2) <= faceR + 0.15 then
      local h = math.sqrt((x - cx - 1) ^ 2 + 1.2 * (y - cy - 1) ^ 2) + saw(x + y, 6, 3) * 0.6
      P.pix(glow, x, y, h < 6.4 and "sand" or (h < 9 and "rust" or "red"))
    end
  end end
  local function dark(x, y) P.pix(img, x, y, "black"); P.pix(glow, x, y, nil) end
  for i = 0, 11 do
    local a = i * pi / 6
    for r = (i % 3 == 0 and i > 0) and 7 or 8, 9 do dark(round(cx + r * sin(a)), round(cy - r * math.cos(a))) end
  end
  -- the glass has lost a shard, and the crack from it stops short of the hands
  for _, q in ipairs({ { 146, 31 }, { 147, 31 }, { 145, 31 }, { 146, 30 }, { 147, 30 }, { 145, 30 }, { 146, 29 }, { 145, 29 }, { 148, 32 }, { 147, 32 }, { 146, 32 }, { 149, 33 }, { 148, 33 }, { 147, 33 }, { 148, 31 }, { 145, 28 }, { 150, 32 } }) do dark(q[1], q[2]) end
  P.pix(glow, 148, 30, "rust"); P.pix(glow, 146, 28, "rust"); P.pix(glow, 149, 31, "rust"); P.pix(glow, 150, 33, "rust")
  for y = cy - 6, cy do dark(cx, y) end                        -- the long hand, from the hub up
  for _, q in ipairs({ { -4, 1 }, { -3, 2 }, { -2, 1 } }) do     -- the short one's spade
    for x = cx - q[2] + 1, cx + q[2] - 1 do dark(x, cy + q[1]) end
  end
  for x = cx - 1, cx + 1 do for y = cy - 1, cy + 1 do dark(x, y) end end

  -- the fall took the right rake in stepped courses, and a bite of the rose's own stone, so the
  -- dial hangs in the gap on its black rim
  clearIn({ 156, 4, 160, 4, 169, 14, 169, 20, 167, 20, 165, 19, 163, 19, 163, 16, 161, 15, 161, 13, 158, 13, 158, 10, 156, 9 })
  for y = cy - 13, cy do for x = cx, cx + 13 do
    local d = math.sqrt((x - cx) ^ 2 + (y - cy) ^ 2)
    local deg = math.atan(x - cx, cy - y) * 180 / pi
    if d > rimR + 0.2 and deg > 26 and deg < 62 then P.pix(img, x, y, nil) end
  end end
  for x = 156, 166 do
    for y = 6, 24 do
      if solid(x, y) then
        if math.sqrt((x - cx) ^ 2 + (y - cy) ^ 2) > ringR + 0.5 then P.pix(img, x, y, "grey"); P.pix(img, x, y + 1, "smoke") end
        break
      end
    end
  end

  -- string course and the great portal: a pointed arch of two orders, the pit shining through bars
  P.hline(img, 139, 38, 19, "stone"); P.hline(img, 139, 39, 19, "black")
  P.hline(img, 158, 40, 9, "grey"); P.hline(img, 158, 41, 9, "black")      -- east of the crack the wall has dropped
  local function arch(x, hw, apex, spring, foot)
    local pts = {}
    for k = 0, 12 do
      local u = k / 12
      pts[#pts + 1] = x - hw * (1 - u ^ 1.7); pts[#pts + 1] = spring - (spring - apex) * u
    end
    for k = 12, 0, -1 do
      local u = k / 12
      pts[#pts + 1] = x + hw * (1 - u ^ 1.7); pts[#pts + 1] = spring - (spring - apex) * u
    end
    pts[#pts + 1] = x + hw; pts[#pts + 1] = foot
    pts[#pts + 1] = x - hw; pts[#pts + 1] = foot
    return pts
  end
  poly(arch(153.5, 10, 40, 47, 54), "grey")
  poly(arch(154, 8.5, 41, 47, 54), "ink")
  poly(arch(154, 7, 43, 48, 54), "black")
  local inner = mask(arch(154, 7, 43, 48, 54))
  for y = 44, 53 do for x = 147, 161 do
    if inner[y][x] then
      local h = 53 - y - saw(x, 9, 4) * 0.9 + math.abs(x - 151) * 0.2
      P.pix(glow, x, y, h < 0.5 and "yellow" or (h < 3 and "rust" or "red"))
    end
  end end
  -- what is left of the portcullis: a few iron teeth, none alike, with the keystone slipped between
  for _, q in ipairs({ { 149, 48 }, { 151, 50 }, { 156, 49 }, { 158, 51 }, { 160, 47 } }) do
    for y = 43, q[2] do
      if inner[y][q[1]] then dark(q[1], y); if y < q[2] - 1 then dark(q[1] + 1, y) end end
    end
  end
  amap(img, 152, 41, 5, 5, {
    "sssgk",
    "sssgk",
    ".ssgk",
    ".sgk.",
    "..k..",
  }, { s = "grey", g = "slate", k = "black" })
  P.rect(glow, 152, 41, 5, 5, nil)

  -- FIRE --------------------------------------------------------------------------------------------
  crack({ 133, 56, 137, 57, 140, 56, 146, 57, 148, 59, 152, 58 }, true)
  crack({ 140, 56, 139, 59, 141, 61, 140, 63 })
  crack({ 161, 55, 160, 58, 162, 60, 161, 63 }, true)
  crack({ 162, 60, 166, 59 })
  crack({ 142, 42, 141, 45, 143, 48, 142, 52, 143, 55 })
  crack({ 166, 27, 164, 30, 165, 33, 162, 36, 160, 36, 158, 38, 159, 42 })
  crack({ 42, 56, 45, 58, 49, 57, 50, 60 })
  crack({ 110, 56, 112, 59, 116, 58 })
  crack({ 76, 58, 80, 57, 82, 60 })
  -- embers still alive on the torn edges
  for _, q in ipairs({ { 30, 24, "rust" }, { 31, 24, "red" }, { 25, 28, "red" }, { 26, 28, "rust" }, { 60, 26, "red" }, { 61, 26, "rust" }, { 62, 25, "red" },
                       { 72, 27, "rust" }, { 73, 26, "red" }, { 79, 24, "red" }, { 80, 24, "rust" }, { 116, 23, "red" }, { 117, 23, "rust" } }) do
    P.pix(glow, q[1], q[2], q[3])
  end
  -- fire baskets on iron standards, tall by the portal, low and leaning at the far end
  local function basket(x, y, foot, flame)
    local sx, sy = S.brazier(0)
    P.blit(img, B, x, y, sx, sy + 7, 10, 6)
    for py = y + 6, foot - 2 do P.pix(img, x + 4, py, "ink"); P.pix(img, x + 5, py, "black") end
    P.blit(img, B, x, foot - 1, sx, sy + 16, 10, 2)
    P.map(glow, x, y + 2 - #flame, flame, { r = "red", o = "rust", y = "yellow", c = "coral" })
    P.hline(glow, x + 3, y + 3, 2, "rust"); P.pix(glow, x + 6, y + 3, "red")
  end
  basket(133, 38, 54, {
    ".....r....",
    ".....r....",
    "....rr.r..",
    "...rrr.r..",
    "...roorr..",
    "..rroor...",
    "..roooorr.",
    ".rrooyoor.",
    ".rooyyoor.",
    ".rooyyyor.",
    "..royyyor.",
    "..rooyoor.",
  })
  -- the far one was knocked askew when the turret came down, and burns on, spilling coals
  do
    local sx, sy = S.brazier(0)
    local x, y = 162, 45
    for i = 0, 9 do P.blit(img, B, x + i, y + floor((9 - i) * 0.34), sx + i, sy + 7, 1, 6) end
    P.line(img, 171, 54, 168, 50, "ink"); P.line(img, 172, 54, 169, 50, "black")
    P.map(glow, x, y - 6, {
      "...r......",
      "...rr...r.",
      "..rrr..rr.",
      "..rroorr..",
      ".rroooor..",
      ".rooyoorr.",
      ".rooyyoor.",
      ".rooyyoo..",
      "..rooyor..",
    }, { r = "red", o = "rust", y = "yellow" })
    for i = 1, 8 do P.pix(glow, x + i, y + floor((9 - i) * 0.34), i % 3 == 1 and "rust" or "red") end
    P.rect(img, 162, 54, 5, 1, "black")
    P.map(glow, 162, 54, { "oyo.r" }, { o = "rust", y = "yellow", r = "red" })
  end
  blitTo("terminus", 0, img, glow)
end

P.save(sheet, ART, 3)
