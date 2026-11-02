-- px.lua: a small drawing kit for headless Aseprite. dofile() it from a family script.
-- Everything draws onto plain Images in RGBA, with hard pixels only: alpha is 0 or 255.
local P = {}

-- DawnBringer 32, by name. Base art uses these and nothing else.
P.C = {
  black="#000000", ink="#222034", plum="#45283C", bark="#663931", wood="#8F563B", rust="#DF7126",
  sand="#D9A066", skin="#EEC39A", yellow="#FBF236", lime="#99E550", grass="#6ABE30", teal="#37946E",
  moss="#4B692F", olive="#524B24", slate="#323C39", indigo="#3F3F74", navy="#306082", blue="#5B6EE1",
  sky="#639BFF", cyan="#5FCDE4", ice="#CBDBFC", white="#FFFFFF", steel="#9BADB7", stone="#847E87",
  grey="#696A6A", smoke="#595652", purple="#76428A", red="#AC3232", coral="#D95763", pink="#D77BBA",
  sage="#8F974A", ochre="#8A6F30",
}

local function hex(c)
  if type(c) ~= "string" then return c end
  c = P.C[c] or c
  local r, g, b = c:match("#(%x%x)(%x%x)(%x%x)")
  return app.pixelColor.rgba(tonumber(r, 16), tonumber(g, 16), tonumber(b, 16), 255)
end
P.hex = hex
P.CLEAR = app.pixelColor.rgba(0, 0, 0, 0)

function P.image(w, h) return Image(w, h, ColorMode.RGB) end

function P.pix(img, x, y, c)
  if x >= 0 and y >= 0 and x < img.width and y < img.height then img:drawPixel(x, y, c == nil and P.CLEAR or hex(c)) end
end
function P.rect(img, x, y, w, h, c)
  for j = y, y + h - 1 do for i = x, x + w - 1 do P.pix(img, i, j, c) end end
end
function P.hline(img, x, y, w, c) P.rect(img, x, y, w, 1, c) end
function P.vline(img, x, y, h, c) P.rect(img, x, y, 1, h, c) end
function P.frame(img, x, y, w, h, c)
  P.hline(img, x, y, w, c); P.hline(img, x, y + h - 1, w, c)
  P.vline(img, x, y, h, c); P.vline(img, x + w - 1, y, h, c)
end
-- a filled disc, or a ring when `inner` is given; aliased, centre on a pixel or between pixels
function P.disc(img, cx, cy, r, c, inner)
  for j = math.floor(cy - r - 1), math.ceil(cy + r + 1) do
    for i = math.floor(cx - r - 1), math.ceil(cx + r + 1) do
      local d = math.sqrt((i - cx) ^ 2 + (j - cy) ^ 2)
      if d <= r + 0.15 and (not inner or d >= inner) then P.pix(img, i, j, c) end
    end
  end
end
function P.line(img, x0, y0, x1, y1, c)
  local n = math.max(math.abs(x1 - x0), math.abs(y1 - y0))
  for k = 0, n do
    local t = n == 0 and 0 or k / n
    P.pix(img, math.floor(x0 + (x1 - x0) * t + 0.5), math.floor(y0 + (y1 - y0) * t + 0.5), c)
  end
end
-- ASCII art: each character of each row is a key in `legend`; space and "." are left alone
function P.map(img, x, y, rows, legend)
  for j, row in ipairs(rows) do
    for i = 1, #row do
      local k = row:sub(i, i)
      if k ~= " " and k ~= "." then
        local c = legend[k]
        if c == nil then error("legend has no '" .. k .. "' (row " .. j .. ")") end
        P.pix(img, x + i - 1, y + j - 1, c)
      end
    end
  end
end
-- copy a rectangle of src onto dst, skipping clear pixels (so sprites can be composed from parts)
function P.blit(dst, src, dx, dy, sx, sy, w, h, flip)
  sx, sy = sx or 0, sy or 0
  w, h = w or src.width, h or src.height
  for j = 0, h - 1 do for i = 0, w - 1 do
    local c = src:getPixel(sx + (flip and w - 1 - i or i), sy + j)
    if app.pixelColor.rgbaA(c) > 0 then dst:drawPixel(dx + i, dy + j, c) end
  end end
end

-- Sheet: a growing column of rows of sprites; each sprite is a strip of frames, left to right.
function P.sheet(family, width, height)
  return { family = family, base = P.image(width, height), lights = P.image(width, height),
           width = width, height = height, cx = 0, cy = 0, rowh = 0, sprites = {} }
end
-- Reserves a strip for `frames` frames of w×h and returns a function that hands out each frame's
-- origin: draw(frameIndexFrom0) -> x, y. Base art goes on sheet.base, emissive on sheet.lights.
function P.strip(s, name, w, h, frames, note)
  frames = frames or 1
  local total = w * frames
  if s.cx + total > s.width then s.cx = 0; s.cy = s.cy + s.rowh + 1; s.rowh = 0 end
  if s.cy + h > s.height then error("sheet too short for " .. name) end
  local x0, y0 = s.cx, s.cy
  s.sprites[#s.sprites + 1] = { name = name, x = x0, y = y0, w = w, h = h, frames = frames, note = note or "" }
  s.cx = s.cx + total + 1
  s.rowh = math.max(s.rowh, h)
  return function(f) return x0 + (f or 0) * w, y0 end
end

local function savePng(img, path)
  local spr = Sprite(img.width, img.height, ColorMode.RGB)
  spr.cels[1].image = img
  spr:saveCopyAs(path)
  spr:close()
end
-- nearest-neighbour upscale for looking at the work, over a flat backdrop
local function scaled(img, n, back)
  local out = P.image(img.width * n, img.height * n)
  local b = hex(back)
  for j = 0, img.height - 1 do for i = 0, img.width - 1 do
    local c = img:getPixel(i, j)
    if app.pixelColor.rgbaA(c) == 0 then c = b end
    for y = 0, n - 1 do for x = 0, n - 1 do out:drawPixel(i * n + x, j * n + y, c) end end
  end end
  return out
end
-- Writes <family>.png, <family>-lights.png, <family>.json and three previews: on the day sky, on a
-- sunset sky, and with the lights composited over a dark ground (how they read at dusk).
function P.save(s, dir, zoom)
  zoom = zoom or 3
  local used = s.cy + s.rowh
  local crop = function(img) return Image(img, Rectangle(0, 0, s.width, used)) end
  local base, lights = crop(s.base), crop(s.lights)
  savePng(base, dir .. "/" .. s.family .. ".png")
  savePng(lights, dir .. "/" .. s.family .. "-lights.png")
  savePng(scaled(base, zoom, "#72EAD0"), dir .. "/" .. s.family .. "-day.png")
  savePng(scaled(base, zoom, "#E2793C"), dir .. "/" .. s.family .. "-dusk.png")
  local lit = P.image(s.width, used)
  for j = 0, used - 1 do for i = 0, s.width - 1 do
    local c = base:getPixel(i, j)
    if app.pixelColor.rgbaA(c) > 0 then
      local d = function(v) return math.floor(v * 0.35) end
      lit:drawPixel(i, j, app.pixelColor.rgba(d(app.pixelColor.rgbaR(c)), d(app.pixelColor.rgbaG(c)), d(app.pixelColor.rgbaB(c)), 255))
    end
    local l = lights:getPixel(i, j)
    if app.pixelColor.rgbaA(l) > 0 then lit:drawPixel(i, j, l) end
  end end
  savePng(scaled(lit, zoom, "#2A0A12"), dir .. "/" .. s.family .. "-lit.png")
  local rows = {}
  for _, e in ipairs(s.sprites) do
    rows[#rows + 1] = string.format('  {"name":"%s","x":%d,"y":%d,"w":%d,"h":%d,"frames":%d,"note":"%s"}',
      e.name, e.x, e.y, e.w, e.h, e.frames, e.note)
  end
  local f = io.open(dir .. "/" .. s.family .. ".json", "w")
  f:write('{"family":"' .. s.family .. '","width":' .. s.width .. ',"height":' .. used .. ',"sprites":[\n' .. table.concat(rows, ",\n") .. "\n]}\n")
  f:close()
  -- the rules a sheet must keep: hard alpha, and on the base art nothing outside the palette
  local allowed = {}
  for _, v in pairs(P.C) do allowed[hex(v)] = true end
  local off, soft = 0, 0
  for j = 0, used - 1 do for i = 0, s.width - 1 do
    local c = base:getPixel(i, j)
    local a = app.pixelColor.rgbaA(c)
    if a > 0 and a < 255 then soft = soft + 1 end
    if a == 255 and not allowed[c] then off = off + 1 end
    local l = app.pixelColor.rgbaA(lights:getPixel(i, j))
    if l > 0 and l < 255 then soft = soft + 1 end
  end end
  print(s.family .. ": " .. #s.sprites .. " sprites, sheet " .. s.width .. "x" .. used ..
        ", off-palette px " .. off .. ", semi-transparent px " .. soft)
end
return P
