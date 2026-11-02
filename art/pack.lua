-- pack.lua: stacks the family sheets into the one sheet the page loads.
-- Run from Aseprite with ART (this folder) and OUT (the repository root) set:
--   ART = "..."; OUT = "..."; dofile(ART .. "/pack.lua")
-- Writes public/sprites/train.png (base art on the top half, lights at the same place on the
-- bottom half), art/train.aseprite (the same, as two layers, with a slice per sprite) and
-- art/sprites.js, the table to paste over SPR in public/index.html.
local P = dofile(ART .. "/px.lua")
local FAMILIES = { "train", "village", "hell" }
local width, total, parts = 512, 0, {}

for _, name in ipairs(FAMILIES) do
  local f = assert(io.open(ART .. "/" .. name .. ".json")); local json = f:read("a"); f:close()
  local base = Image { fromFile = ART .. "/" .. name .. ".png" }
  local lights = Image { fromFile = ART .. "/" .. name .. "-lights.png" }
  parts[#parts + 1] = { name = name, json = json, base = base, lights = lights, y = total }
  total = total + base.height + 1
end

local baseImg, lightsImg, rows, slices = P.image(width, total), P.image(width, total), {}, {}
for _, part in ipairs(parts) do
  P.blit(baseImg, part.base, 0, part.y)
  P.blit(lightsImg, part.lights, 0, part.y)
  for n, x, y, w, h, frames in part.json:gmatch('"name":"([%w_]+)","x":(%d+),"y":(%d+),"w":(%d+),"h":(%d+),"frames":(%d+)') do
    x, y, w, h, frames = tonumber(x), tonumber(y) + part.y, tonumber(w), tonumber(h), tonumber(frames)
    local lit = 0
    for j = y, y + h - 1 do for i = x, x + w * frames - 1 do
      if app.pixelColor.rgbaA(lightsImg:getPixel(i, j)) > 0 then lit = 1 end
    end end
    rows[#rows + 1] = string.format("  %s: [%d, %d, %d, %d, %d, %d],", n, x, y, w, h, frames, lit)
    slices[#slices + 1] = { name = n, x = x, y = y, w = w * frames, h = h }
  end
end

-- the file the page loads: both halves, one image
local sheet = P.image(width, total * 2)
P.blit(sheet, baseImg, 0, 0)
P.blit(sheet, lightsImg, 0, total)
local out = Sprite(width, total * 2, ColorMode.RGB)
out.cels[1].image = sheet
out:saveCopyAs(OUT .. "/public/sprites/train.png")
out:close()

-- the source: two layers and a slice per sprite, for opening in Aseprite
local src = Sprite(width, total, ColorMode.RGB)
src.layers[1].name = "base"
src.cels[1].image = baseImg
local l = src:newLayer(); l.name = "lights"
src:newCel(l, 1, lightsImg, Point(0, 0))
for _, s in ipairs(slices) do
  local slice = src:newSlice(Rectangle(s.x, s.y, s.w, s.h))
  slice.name = s.name
end
src:saveAs(OUT .. "/art/train.aseprite")
src:close()

local f = assert(io.open(OUT .. "/art/sprites.js", "w"))
f:write("const SPR = {\n" .. table.concat(rows, "\n") .. "\n};\n")
f:close()
print("packed " .. #rows .. " sprites into " .. width .. "x" .. total * 2)
