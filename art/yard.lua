-- yard.lua: the small things of village life that stand between the houses: a well, barrels and a
-- crate, a woodpile, a bench, a fingerpost, a washing line, beehives and a flowerbed. Each prop that
-- decays comes as <name>, <name>_1 weathered and <name>_2 broken (the flowerbed wilting and dead), at
-- exactly the size and bottom row of the original; the laundry and the hives are kept only. So that
-- the yards are not all the same brown wood, the bench is painted blue, the hives are white with a
-- red and a blue lid, the bed is edged with warm field stones and the well's bucket is red.
local P = dofile(ART .. "/px.lua")
local S = P.sheet("yard", 512, 64)
local pc = app.pixelColor

-- One letter per palette colour, as worn.lua's touch grids name them.
local CODE = { ["0"] = "black", k = "ink", p = "plum", b = "bark", w = "wood", r = "rust", s = "sand", S = "skin",
  y = "yellow", l = "lime", g = "grass", t = "teal", m = "moss", o = "olive", L = "slate", i = "indigo", n = "navy",
  B = "blue", K = "sky", c = "cyan", I = "ice", W = "white", e = "steel", T = "stone", G = "grey", M = "smoke",
  u = "purple", R = "red", C = "coral", P = "pink", a = "sage", O = "ochre" }
local NAME = {}
for n, v in pairs(P.C) do NAME[P.hex(v)] = n end

-- A letter grid at x, y: "." leaves a pixel as it is, "_" clears it. Rows of the wrong width are typos.
local function grid(g, x, y, rows)
  for j, r in ipairs(rows) do
    if #r ~= #rows[1] then error("row " .. j .. " is " .. #r .. " wide, expected " .. #rows[1] .. ": " .. r) end
    for i = 1, #r do
      local k = r:sub(i, i)
      if k == "_" then P.pix(g, x + i - 1, y + j - 1, nil)
      elseif k ~= "." then
        if not CODE[k] then error("no colour '" .. k .. "' (row " .. j .. ")") end
        P.pix(g, x + i - 1, y + j - 1, CODE[k])
      end
    end
  end
end

local function at(g, x, y)
  if x < 0 or y < 0 or x >= g.width or y >= g.height then return nil end
  local c = g:getPixel(x, y)
  if pc.rgbaA(c) == 0 then return nil end
  return NAME[c] or "?"
end

local function image(w, h, rows)
  local g = P.image(w, h)
  if rows then
    assert(#rows == h and #rows[1] == w, "grid is " .. #rows[1] .. "x" .. #rows .. ", sprite " .. w .. "x" .. h)
    grid(g, 0, 0, rows)
  end
  return g
end

-- Places a one-frame sprite and prints what to check: how much of its bottom row stands on the
-- ground, how many pixels match none of their neighbours, and for a stage, how far its outline
-- strays from its base's (it must be the base's size).
local BASES = {}
local function sprite(name, g, l, note, base)
  local w, h = g.width, g.height
  local cell = P.strip(S, name, w, h, 1, note)
  local x, y = cell(0)
  P.blit(S.base, g, x, y)
  if l then P.blit(S.lights, l, x, y) end
  local foot = 0
  for i = 0, w - 1 do if at(g, i, h - 1) then foot = foot + 1 end end
  local lone = 0
  for j = 0, h - 1 do for i = 0, w - 1 do
    local c = at(g, i, j)
    if c then
      local same = false
      for dj = -1, 1 do for di = -1, 1 do
        if (di ~= 0 or dj ~= 0) and at(g, i + di, j + dj) == c then same = true end
      end end
      if not same then lone = lone + 1 end
    end
  end end
  local msg = string.format("%-12s %2dx%-2d foot %2d, lone %d", name, w, h, foot, lone)
  if base then
    local b = BASES[base]
    assert(b.width == w and b.height == h, name .. " is not the size of " .. base)
    local gained, lost = 0, 0
    for j = 0, h - 1 do for i = 0, w - 1 do
      local p, q = at(b, i, j) ~= nil, at(g, i, j) ~= nil
      if q and not p then gained = gained + 1 elseif p and not q then lost = lost + 1 end
    end end
    msg = msg .. string.format(", outline +%d -%d", gained, lost)
  else
    BASES[name] = g
  end
  print(msg)
end

---------------------------------------------------------------------------------------------------
-- well
---------------------------------------------------------------------------------------------------
-- A round stone drum: the coping seen a little from above, the black of the shaft inside its far
-- rim and its near lip a pixel proud of the drum each side; under it two courses of three stones,
-- each a 3-4 px block lit at its top left, set in grey joints with a mortar line between the
-- courses, the whole drum going from ice at the left to smoke at the right so it reads round. A red
-- bucket on an iron hoop hangs over the shaft.
local WELL = {
  ".....Sswb.....",
  "....Ssswwb....",
  "...SOOOwbbb...",
  "..Ssssswwwwb..",
  ".SsOOOOwbbbbp.",
  "wwwwwwwbbbbbbp",
  "..wb......wb..",
  "..wbSssssswbGG",
  "..wbwwwwwwwb.G",
  "..wb..s...wb.b",
  "..wb.eTTG.wb.b",
  "..wb.CRRp.wb..",
  ".eIkk0000kkGG.",
  "eIIIIeeeeTTGGM",
  ".IIeGeeTGTTGM.",
  ".eeeGTTGGGGMM.",
  ".GGGGGGMMMMMM.",
  ".eeGeeeTGTTTM.",
  "..mmTTTGGGMM..",
}
local well = image(14, 19, WELL)
sprite("well", well, nil, "stone well, wooden roof, winch and a red bucket")
-- weathered: a shingle slipped on each slope, the bucket's paint gone dull, the coping's light
-- dulled, damp darkening the lower course, the moss at the foot going over
sprite("well_1", image(14, 19, {
  ".....Sswb.....",
  "....Ssswwb....",
  "...SOOOwbbb...",
  "..Sppsswwppb..",
  ".SsOOOOwbbbbp.",
  "wwwwwwwbbbbbbp",
  "..wb......wb..",
  "..wbSssssswbGG",
  "..wbwwwwwwwb.G",
  "..wb..s...wb.b",
  "..wb.eTTG.wb.b",
  "..wb.RRpp.wb..",
  ".eekk0000kkGG.",
  "eeIIeeeeTTTGGM",
  ".IeeGeeTGTTGM.",
  ".eeeGTTGGGGMM.",
  ".GGGGGGMMMMMM.",
  ".TTGTTTGGGGMM.",
  "..ooTTGGGMMM..",
}), nil, "well, weathered", "well")
-- broken: the slipped shingle on the right gone through to a rafter, the ridge cap and the left eave
-- knocked off, the bucket gone and its rope frayed, the crank handle gone, a stone of the near lip
-- fallen into the shaft and a crack running down the drum from the gap
sprite("well_2", image(14, 19, {
  ".....Ssw......",
  "....Ssswkb....",
  "...SOOOwwkb...",
  "..Sppsswkwkb..",
  "..SOOOOwkkwkp.",
  ".wwwwwwbbbbbbp",
  "..wb......wb..",
  "..wbSssssswbGG",
  "..wbwwwwwwwb.G",
  "..wb..s...wb..",
  "..wb..s...wb..",
  "..wb......wb..",
  ".eIkk0000kkGG.",
  "eII00eeeTTTGGM",
  ".IeeGMeTGTTGM.",
  ".eeeGMTGGGGMM.",
  ".GGGGGMMMMMMM.",
  ".TTGTMTGGGGMM.",
  "..bbTTGGGMMM..",
}), nil, "well, broken", "well")

---------------------------------------------------------------------------------------------------
-- barrels
---------------------------------------------------------------------------------------------------
-- Each barrel is six staves wide, lit in pairs (sand, wood, then bark and the plum edge), so no
-- stave is a lone column; its iron hoops end in a 2 px grey cluster on the shaded side, and the
-- end hoops sit 1 px in so the belly bulges. The lid is a 2 px sand oval inside the top hoop. The
-- crate is slatted timber: a lit sand rim and corner post, two wood slats with a dark gap between,
-- a plum edge in the shade; three apples (a skin highlight on each) heaped over its rim.
local BARRELS = {
  ".TssG............",
  "TTTTGG...........",
  "sswwbp.TssG......",
  "sswwbpTTTTGG.SC..",
  "sswwbpsswwbpSCRC.",
  "TTTTGGsswwbpssssb",
  "sswwbpsswwbpswwwp",
  "sswwbpTTTTGGsbbbp",
  ".TTGG..TTGG.swwwp",
}
local barrels = image(17, 9, BARRELS)
sprite("barrels", barrels, nil, "two barrels and a crate of apples")
-- weathered: the apples gone but one, the staves gone dull ochre, the top hoops rusting, the
-- crate's rim worn to the grain and a slat split
sprite("barrels_1", image(17, 9, {
  ".TOOG............",
  "TTbbGG...........",
  "OOwwbp.TOOG......",
  "OOwwbpTTbbGG.SC..",
  "OOwwbpOOwwbp.CR..",
  "TTTTGGOOwwbpssOOb",
  "OOwwbpOOwwbpsbwwp",
  "OOwwbpTTTTGGsbbbp",
  ".TTGG..TTGG.swwwp",
}), nil, "barrels, weathered", "barrels")
-- broken: the tall barrel stove in under its top hoop, the short one's lower hoop rusted through,
-- the crate's rim and upper slat broken out to its dark inside, half the lower slat left
sprite("barrels_2", image(17, 9, {
  ".TOOG............",
  "TTbbGG...........",
  "Okkwbp.TOOG......",
  "OkkwbpTTTTGG.....",
  "OOkkbpOOwwbp.....",
  "TTkkGGOOwwbpsskkp",
  "OOwwbpOOwwbpskkkp",
  "OOwwbpTTbbGGskkwp",
  ".TTGG..TTbbGswwwp",
}), nil, "barrels, broken", "barrels")

---------------------------------------------------------------------------------------------------
-- woodpile
---------------------------------------------------------------------------------------------------
-- Rounds stacked end-on, three, two and one: each round's end grain lit from the upper left inside a
-- wood rim with its bark in the shade, the corners between them dark. A chopping block with the axe
-- in it stands beside.
local WOODPILE = {
  ".....ww.........",
  "....wSsb........",
  "....wsOb........",
  "...wwbbww.......",
  "..wSsbwssb.....w",
  "..wsObwOOb....w.",
  ".wwbbwwbbww.eG..",
  "wSsbwSSbwSsbSssO",
  "wsObwssbwsObwwwb",
  "pbbppbbppbbpwbbb",
}
local woodpile = image(16, 10, WOODPILE)
sprite("woodpile", woodpile, nil, "split rounds stacked end-on, a chopping block and axe")
-- half used: the top round and one of the middle course burnt, the ends gone a shade duller
sprite("woodpile_1", image(16, 10, {
  "................",
  "................",
  "................",
  "...ww...........",
  "..wssb.........w",
  "..wsOb........w.",
  ".wwbbww..ww.eG..",
  "wSsbwsSbwSsbSssO",
  "wsObwssbwsObwwwb",
  "pbbppbbppbbpwbbb",
}), nil, "woodpile, half used", "woodpile")
-- scattered and grey: still wood, rims and bark as they were, only the end faces silvered (a stone
-- face, a grey or smoke heart, a smoke check). The left round of the middle course still sits on
-- the bottom two, the middle one of those rolled a pixel out from under it; the last round of the
-- bottom course toppled over in front of the block, its face tipped up over a band of bark. The axe
-- gone, the block's top dulled.
sprite("woodpile_2", image(16, 10, {
  "................",
  "................",
  "................",
  "...ww...........",
  "..wTTb..........",
  "..wTGb..........",
  ".wwbb.ww........",
  "wTTb.wTTb.TTGssO",
  "wTMb.wGMbwTGMbwb",
  "pbbp.pbbppbbbpbb",
}), nil, "woodpile, scattered and grey", "woodpile")

---------------------------------------------------------------------------------------------------
-- bench
---------------------------------------------------------------------------------------------------
-- A painted park bench: a backrest board between the iron back posts, the seat in front of it seen
-- a little from above and sticking out past the backrest, the iron ends curling into the arms and
-- splaying at the feet.
local BENCH = {
  ".k........k.",
  ".kBBBBBBBBk.",
  "kknnnnnnnnkk",
  "kKKKKKKKKKKk",
  ".BBBBBBBBBB.",
  ".knnnnnnnnk.",
  ".k........k.",
  "kk........kk",
}
local bench = image(12, 8, BENCH)
sprite("bench", bench, nil, "painted garden bench on cast-iron ends")
-- weathered: the paint sun-faded and peeling to the wood in two places, rust at both iron feet
sprite("bench_1", image(12, 8, {
  ".k........k.",
  ".kBBBBssBBk.",
  "kknnnnwwnnkk",
  "kKKeeKKKKKKk",
  ".BBwwBBBBBB.",
  ".knnnnnnnnk.",
  ".b........k.",
  "bb........bb",
}), nil, "bench, weathered", "bench")
-- broken: the backrest snapped, its left half sagging onto the seat and the break showing raw
-- wood, the paint peeled further
sprite("bench_2", image(12, 8, {
  ".k........k.",
  ".kBBB...wBk.",
  "kknnnB..wnkk",
  "kKKeenKKeeKk",
  ".BBwwBBBwwB.",
  ".knnnnnnnnk.",
  ".b........b.",
  "bb........bb",
}), nil, "bench, a slat broken", "bench")

---------------------------------------------------------------------------------------------------
-- signpost
---------------------------------------------------------------------------------------------------
-- Two fingers on a post, each fixed by its square end just past the post and reaching out the way
-- it points, its tip tapering over the board's three rows: a white one pointing on, a bare wood
-- one pointing back.
local SIGNPOST = {
  "....wb....",
  "...wwbb...",
  "...WWWWW..",
  "...WWWWWWW",
  "...IIIII..",
  "....wb....",
  "..SSSSw...",
  "ssssssw...",
  "..wwwwb...",
  "....wb....",
  "....wb....",
  "....wb....",
  "....wb....",
  "....wb....",
  "....wb....",
  "...wwbb...",
}
local signpost = image(10, 16, SIGNPOST)
sprite("signpost", signpost, nil, "fingerpost with two arrow boards")
-- weathered: the white paint peeling to the wood, the other board split along its grain, the post cracked
sprite("signpost_1", image(10, 16, {
  "....wb....",
  "...wbbb...",
  "...WWWss..",
  "...WWWssWW",
  "...IIIII..",
  "....wb....",
  "..SSssw...",
  "sswwwsw...",
  "..wwwwb...",
  "....wb....",
  "....wb....",
  "....bb....",
  "....bb....",
  "....wb....",
  "....wb....",
  "...wwbb...",
}), nil, "signpost, weathered", "signpost")
-- broken: leaning, the cap split, the white board riding over with the post; the back board
-- fallen across the foot, no longer than it hung, its tip in the grass, its square end on a stone
sprite("signpost_2", image(10, 16, {
  "..wb......",
  ".wbbb.....",
  ".WWWss....",
  ".WWWssWW..",
  ".IIIII....",
  "..wb......",
  "...wb.....",
  "...wb.....",
  "...wb.....",
  "...wb.....",
  "...wb.....",
  "....bb....",
  "....wb....",
  "....wbSSw.",
  "...SSswwb.",
  ".sswwbbTTG",
}), nil, "signpost, leaning, a board fallen", "signpost")

---------------------------------------------------------------------------------------------------
-- laundry
---------------------------------------------------------------------------------------------------
-- Two T-topped posts and a line sagging between them, a wooden peg over each thing on it: a red
-- frock (puffed sleeves, a narrow bodice, a white sash at the waist, a bell skirt flaring to a dark
-- hem), a sheet pegged at both corners, a blue shirt with its short sleeves.
local LAUNDRY = {
  "wwwb..w............w..wwwb",
  ".wbTTTwTTTw....wTTTwTTTwb.",
  ".wb.CC.RR.wTTTTw.KKKKB.wb.",
  ".wb..CCR..WWWWWI.KKKKB.wb.",
  ".wb..WWR..WWWWWI..KKB..wb.",
  ".wb..CCR..WWWWII..KKB..wb.",
  ".wb.CCCCR.WWIWII..KKB..wb.",
  ".wb.CCCCR.WWIWII..BBB..wb.",
  ".wb.RRRRR.WWIWII.......wb.",
  ".wb.......WWIWII.......wb.",
  ".wb.......IWIIIe.......wb.",
  ".wb....................wb.",
  ".wb....................wb.",
  ".wb....................wb.",
}
local laundry = image(26, 14, LAUNDRY)
sprite("laundry", laundry, nil, "washing line between two posts; kept only")

---------------------------------------------------------------------------------------------------
-- beehives
---------------------------------------------------------------------------------------------------
-- Two white box hives on a plank stand, straight-sided boxes under low gabled lids (one red, one
-- blue, each with a darker eave line), so they read as hives and not as hats: the tall one of two
-- lifts with a shaded seam between, each with its entrance slot over a sand landing board that
-- juts past its front. A bee coming in to the tall hive's board, another out in the air.
local BEEHIVES = {
  "...CCRR...........",
  "..CCCRRR......yk..",
  "..RRpppp..........",
  "..WWWWIe....KKBB..",
  "..IIIIee...KKKBBB.",
  "..WWWWIe...BBnnnn.",
  "y.WWWWIe...WWWWIe.",
  "k.WWWWIe...WWWWIe.",
  "..WkkkIe...WkkkIe.",
  "sssswwwb.sssswwwb.",
  "wwwwwwwwwwwwwwwwwb",
  ".wb.............wb",
}
local beehives = image(18, 12, BEEHIVES)
sprite("beehives", beehives, nil, "two white box hives on a stand; kept only")

---------------------------------------------------------------------------------------------------
-- flowerbed
---------------------------------------------------------------------------------------------------
-- A cottage bed: a foxglove and a delphinium spike at the ends, marigolds, a daisy and a rose
-- between, each bloom a 2 px cluster shaded lower right, set in a mound of leaves lit on top; a
-- course of warm field stones along the front, each lit sand on its upper left and stone below,
-- with soil between them and the leaves spilling over the ends. Warm, so it is not flora's wall.
local EDGE = { "mssTTwssTTwssTTm", "TTTGGwTTGGwTTGGG" }
local function bed(rows, edge)
  rows[#rows + 1] = (edge or EDGE)[1]; rows[#rows + 1] = (edge or EDGE)[2]
  return rows
end
local FLOWERBED = bed({
  ".P.....WW....K..",
  ".Pu.yylWIlCC.KB.",
  "gPugyrlgglCRgKBg",
  "gmmgmmmgmmmmgmmg",
})
local flowerbed = image(16, 6, FLOWERBED)
sprite("flowerbed", flowerbed, nil, "cottage garden bed edged with warm field stones")
-- wilting: the blooms a shade duller and the spikes' tips drooping, but the marigolds gone to rust
-- and the rose still red so the bed reads as flowers into the evening; the leaves going sage and
-- olive, the moss at the ends going over
sprite("flowerbed_1", image(16, 6, bed({
  "..u.....II....B.",
  ".up.rraIeaCR.Bi.",
  "aupaOraaaaRpaBia",
  "aooaoooaooooaooa",
}, { "ossTTwssTTwssTTo", "TTTGGwTTGGwTTGGG" })), nil, "flowerbed, wilting", "flowerbed")
-- dead: a dry mound of sage, olive and ochre, no two stalks alike: the foxglove a leaning spike of
-- seed pods, the marigolds a low dry clump, the daisy a seed head sunk in the mound, the delphinium
-- bent at its foot and flopped over to the right, its pods drooping onto the leaves
sprite("flowerbed_2", image(16, 6, bed({
  ".O..............",
  ".bO.........bOO.",
  "..bO.OO.wb.b...O",
  "aaabawwaaaobaaoo",
}, { "ossTTwssTTwssTTo", "TTTGGwTTGGwTTGGG" })), nil, "flowerbed, dead", "flowerbed")

P.save(S, ART, 3)

---------------------------------------------------------------------------------------------------
-- Previews
---------------------------------------------------------------------------------------------------
local function family(name)
  local f = assert(io.open(ART .. "/" .. name .. ".json")); local json = f:read("a"); f:close()
  local fam = { base = Image { fromFile = ART .. "/" .. name .. ".png" },
                lights = Image { fromFile = ART .. "/" .. name .. "-lights.png" }, at = {} }
  for n, x, y, w, h in json:gmatch('"name":"([%w_]+)","x":(%d+),"y":(%d+),"w":(%d+),"h":(%d+),"frames":(%d+)') do
    fam.at[n] = { x = tonumber(x), y = tonumber(y), w = tonumber(w), h = tonumber(h) }
  end
  return fam
end
local MINE = { base = S.base, lights = S.lights, at = {} }
for _, e in ipairs(S.sprites) do MINE.at[e.name] = e end
local VILLAGE, GROUND, WORN, DRY = family("village"), family("ground"), family("worn"), family("dry")
-- One frame of a sprite by name, base and lights, from this sheet or a finished family.
local function frameOf(name, f)
  local fam
  for _, f in ipairs { MINE, VILLAGE, GROUND, WORN, DRY } do fam = fam or (f.at[name] and f) end
  if not fam then error("no sprite " .. name) end
  local e = fam.at[name]
  local g, l = P.image(e.w, e.h), P.image(e.w, e.h)
  P.blit(g, fam.base, 0, 0, e.x + (f or 0) * e.w, e.y, e.w, e.h)
  P.blit(l, fam.lights, 0, 0, e.x + (f or 0) * e.w, e.y, e.w, e.h)
  return g, l
end
local function multiply(c, t)
  t = P.hex(t)
  return pc.rgba(pc.rgbaR(c) * pc.rgbaR(t) // 255, pc.rgbaG(c) * pc.rgbaG(t) // 255, pc.rgbaB(c) * pc.rgbaB(t) // 255, 255)
end
-- A sprite at x, y as it is, and `dy` lower multiplied by light t with its lights over it.
local function place(out, g, l, x, y, dy, t)
  for j = 0, g.height - 1 do for i = 0, g.width - 1 do
    local p = g:getPixel(i, j)
    if pc.rgbaA(p) > 0 then
      out:drawPixel(x + i, y + j, p)
      if dy then out:drawPixel(x + i, dy + y + j, multiply(p, t)) end
    end
    local q = l:getPixel(i, j)
    if dy and pc.rgbaA(q) > 0 then out:drawPixel(x + i, dy + y + j, q) end
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

-- yard-stages.png: a row per thing, its stages left to right; untinted over the day sky, then each
-- stage multiplied by its light over the evening sky.
local STAGE_LIGHT = { "#FFFFFF", "#D49989", "#AA5E66", "#B15C60" }
local function stages(path, rows, zoom, lights)
  local cellW, gap, cols = 26, 4, 0
  local heights, total = {}, gap
  for r, row in ipairs(rows) do
    local h = 0
    for _, n in ipairs(row) do h = math.max(h, (frameOf(n)).height) end
    heights[r] = h; total = total + h + gap
    cols = math.max(cols, #row)
  end
  local W = gap + cols * (cellW + gap)
  local out = P.image(W, total * 2)
  P.rect(out, 0, 0, W, total, "#72EAD0"); P.rect(out, 0, total, W, total, "#E2793C")
  local y = gap
  for r, row in ipairs(rows) do
    for k, n in ipairs(row) do
      local g, l = frameOf(n)
      place(out, g, l, gap + (k - 1) * (cellW + gap) + (cellW - g.width) // 2, y + heights[r] - g.height, total,
        (lights or STAGE_LIGHT)[k])
    end
    y = y + heights[r] + gap
  end
  write(out, zoom, path)
end
local ROWS = {}
local names = {}
for _, e in ipairs(S.sprites) do names[e.name] = true end
for _, e in ipairs(S.sprites) do
  if not e.name:find("_%d$") then
    local row = { e.name }
    for k = 1, 3 do if names[e.name .. "_" .. k] then row[#row + 1] = e.name .. "_" .. k end end
    ROWS[#ROWS + 1] = row
  end
end
stages(ART .. "/yard-stages.png", ROWS, 3)
-- while drawing, STAGEZOOM writes the same at a closer zoom, ONLY picking the rows
if rawget(_G, "STAGEZOOM") then
  local pickRows = {}
  for _, r in ipairs(ROWS) do if not rawget(_G, "ONLY") or ONLY[r[1]] then pickRows[#pickRows + 1] = r end end
  stages(ART .. "/yard-w-stages.png", pickRows, STAGEZOOM)
end

-- yard-scene.png: the yard among the village on a row of field0, by day and in the late light.
-- Each strip is { field, light, sky, stage }: the field tile, the light everything is multiplied by,
-- the sky behind, and the stage each staged thing is drawn at.
local function staged(name, k)
  if k == 0 then return name end
  for kk = k, 1, -1 do
    local n = name .. "_" .. kk
    if MINE.at[n] or WORN.at[n] or DRY.at[n] then return n end
  end
  return name
end
local function scene(path, strips)
  local W, H = 400, 70
  local fieldTop = H - 26
  local out = P.image(W, H * #strips)
  local BACK = { { "house2", 20 }, { "poplar", 62 }, { "house3", 150 }, { "oak2", 250 }, { "house2", 330 } }
  local MAIN = { { "house1", 2, 19 }, { "well", 38, 21 }, { "oak1", 52, 18 }, { "barrels", 76, 20 }, { "house3", 94, 19 },
                 { "flowerbed", 96, 22 }, { "laundry", 121, 18 }, { "poplar", 150, 19 }, { "bench", 161, 21 },
                 { "house5", 176, 20 }, { "woodpile", 216, 21 }, { "signpost", 236, 19 }, { "pine", 248, 18 },
                 { "beehives", 266, 21 }, { "house4", 284, 19 }, { "flowerbed", 310, 21 }, { "sheep", 330, 20 },
                 { "haystack", 346, 19 }, { "barrels", 364, 21 }, { "lamp", 384, 20 } }
  for s, st in ipairs(strips) do
    local y0 = (s - 1) * H
    local strip, lit = P.image(W, H), P.image(W, H)
    P.rect(strip, 0, 0, W, H, st.sky)
    for x = 0, W - 1, 32 do place(strip, (frameOf(st.field, (x // 32) % 2)), P.image(32, 26), x, fieldTop) end
    local function stand(name, x, bottom)
      local kept = { laundry = true, beehives = true, sheep = true }
      if st.stage >= 2 and kept[name] then return end
      local n = staged(name, st.stage)
      if st.stage >= 2 and name == "lamp" then n = "lamp_2" end
      local g, l = frameOf(n)
      place(strip, g, l, x, bottom - g.height + 1)
      if st.lights then P.blit(lit, l, x, bottom - g.height + 1) end
    end
    for _, b in ipairs(BACK) do stand(b[1], b[2], fieldTop + 1) end
    for _, m in ipairs(MAIN) do stand(m[1], m[2], fieldTop + m[3]) end
    local sky = P.hex(st.sky)
    for j = 0, H - 1 do for i = 0, W - 1 do
      local c = strip:getPixel(i, j)
      if not (j < fieldTop and c == sky) then c = multiply(c, st.light) end
      if pc.rgbaA(lit:getPixel(i, j)) > 0 then c = lit:getPixel(i, j) end
      out:drawPixel(i, y0 + j, c)
    end end
  end
  write(out, 3, path)
end
scene(ART .. "/yard-scene.png", {
  { field = "field0", light = "#FFFFFF", sky = "#72EAD0", stage = 0 },
  { field = "field0", light = "#BF7B77", sky = "#E2793C", stage = 0, lights = true },
})
-- while drawing, LIGHTS writes every sprite under each of the page's lights, over the amber sky
if rawget(_G, "LIGHTS") then
  local L = { "#FFFFFF", "#EAB69A", "#D49989", "#BF7B77", "#AA5E66", "#B15C60", "#C35855" }
  local rows = {}
  for _, e in ipairs(S.sprites) do rows[#rows + 1] = { e.name, e.name, e.name, e.name, e.name, e.name, e.name } end
  local cellW, gap = 26, 3
  local H = gap
  for _, r in ipairs(rows) do H = H + MINE.at[r[1]].h + gap end
  local out = P.image(gap + #L * (cellW + gap), H)
  P.rect(out, 0, 0, out.width, H, "#E2793C")
  local y = gap
  for _, r in ipairs(rows) do
    for k, n in ipairs(r) do
      local g = frameOf(n)
      for j = 0, g.height - 1 do for i = 0, g.width - 1 do
        local p = g:getPixel(i, j)
        if pc.rgbaA(p) > 0 then out:drawPixel(gap + (k - 1) * (cellW + gap) + i, y + j, multiply(p, L[k])) end
      end end
    end
    y = y + MINE.at[r[1]].h + gap
  end
  write(out, 3, ART .. "/yard-w-lights.png")
end
if rawget(_G, "SCENES") then
  scene(ART .. "/yard-w-scene-stages.png", {
    { field = "field1", light = "#EAB69A", sky = "#E2793C", stage = 1, lights = true },
    { field = "field2", light = "#D49989", sky = "#E2793C", stage = 1, lights = true },
    { field = "field3", light = "#AA5E66", sky = "#E2793C", stage = 2 },
    { field = "field4", light = "#AA5E66", sky = "#E2793C", stage = 2 },
  })
end

-- while drawing, CLOSE writes every sprite (or the ONLY ones and their stages) at that zoom
if rawget(_G, "CLOSE") then
  local list = {}
  local only = rawget(_G, "ONLY")
  for _, e in ipairs(S.sprites) do
    if not only or only[e.name] or only[e.name:gsub("_%d$", "")] then list[#list + 1] = e end
  end
  local W, H = 2, 0
  for _, e in ipairs(list) do W = W + e.w + 2; H = math.max(H, e.h) end
  local out = P.image(W, H + 4)
  P.rect(out, 0, 0, W, H + 4, "#72EAD0")
  local x = 2
  for _, e in ipairs(list) do
    P.blit(out, S.base, x, 2 + H - e.h, e.x, e.y, e.w, e.h)
    x = x + e.w + 2
  end
  write(out, CLOSE, ART .. "/yard-w-close.png")
end
