-- Collapsible blocks marked by markdown-details.js: marker code blocks (class
-- pi-preview-details-marker) carrying a per-process nonce, which arrives as the
-- `pi-preview-details` metadata value. HTML output gets <details>/<summary>; other
-- formats (PDF via LaTeX) get the summary in bold followed by the content. Raw HTML
-- input stays disabled: only these elements, generated here, are written as raw
-- HTML. Markers are paired within one list of blocks; one left unpaired (its
-- partner landed in another container) is shown as the literal tag it replaced.

local prefix

local function escape_html(text)
  return (text:gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;"):gsub('"', "&quot;"))
end

-- Plain text as inlines: words and spaces.
local function text_inlines(text)
  local inlines = {}
  for space, word in text:gmatch("(%s*)(%S+)") do
    if space ~= "" and #inlines > 0 then inlines[#inlines + 1] = pandoc.Space() end
    inlines[#inlines + 1] = pandoc.Str(word)
  end
  return inlines
end

-- kind ("Open", "OpenExpanded", "Summary", "Close"), id and summary text of a marker block.
local function marker(block)
  if block.t ~= "CodeBlock" or not block.classes:includes("pi-preview-details-marker") then return nil end
  local text = block.text
  if text:sub(1, #prefix) ~= prefix then return nil end
  local kind, id, rest = text:sub(#prefix + 1):match("^(%a+)(%d+)(.*)$")
  if not kind then return nil end
  return kind, id, (rest:gsub("^ ", ""))
end

local function details(frame)
  local summary = frame.summary or "Details"
  local out = {}
  if FORMAT:match("html") then
    out[1] = pandoc.RawBlock("html", '<details class="pi-preview-details"' .. (frame.open and " open" or "") .. "><summary>" .. escape_html(summary) .. "</summary>")
    for _, block in ipairs(frame.blocks) do out[#out + 1] = block end
    out[#out + 1] = pandoc.RawBlock("html", "</details>")
  else
    out[1] = pandoc.Para({ pandoc.Strong(text_inlines(summary)) })
    for _, block in ipairs(frame.blocks) do out[#out + 1] = block end
  end
  return out
end

-- What an unpaired marker stood for, as literal text.
local function literal(frame)
  local out = { pandoc.Para({ pandoc.Str(frame.open and "<details open>" or "<details>") }) }
  if frame.summary then out[2] = pandoc.Para({ pandoc.Str("<summary>" .. frame.summary .. "</summary>") }) end
  for _, block in ipairs(frame.blocks) do out[#out + 1] = block end
  return out
end

local process

local function recurse(block)
  if block.t == "Div" or block.t == "BlockQuote" then
    block.content = process(block.content)
  elseif block.t == "BulletList" or block.t == "OrderedList" then
    for i, item in ipairs(block.content) do block.content[i] = process(item) end
  end
  return block
end

process = function(blocks)
  local root = { blocks = {} }
  local stack = { root }
  for _, block in ipairs(blocks) do
    local top = stack[#stack]
    local kind, id, text = marker(block)
    if kind == "Open" or kind == "OpenExpanded" then
      stack[#stack + 1] = { id = id, open = kind == "OpenExpanded", blocks = {} }
    elseif kind == "Summary" and top.id == id and not top.summary and #top.blocks == 0 then
      top.summary = text
    elseif kind == "Close" and top.id == id then
      stack[#stack] = nil
      local parent = stack[#stack]
      for _, out in ipairs(details(top)) do parent.blocks[#parent.blocks + 1] = out end
    elseif kind == "Close" then
      top.blocks[#top.blocks + 1] = pandoc.Para({ pandoc.Str("</details>") })
    else
      top.blocks[#top.blocks + 1] = recurse(block)
    end
  end
  while #stack > 1 do
    local frame = stack[#stack]
    stack[#stack] = nil
    local parent = stack[#stack]
    for _, out in ipairs(literal(frame)) do parent.blocks[#parent.blocks + 1] = out end
  end
  return root.blocks
end

function Pandoc(doc)
  local nonce = doc.meta["pi-preview-details"]
  if not nonce then return nil end
  prefix = "PiPreviewDetails" .. pandoc.utils.stringify(nonce)
  doc.meta["pi-preview-details"] = nil
  doc.blocks = process(doc.blocks)
  return doc
end
