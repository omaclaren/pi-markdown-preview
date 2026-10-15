-- Collapsible blocks marked by markdown-details.js: marker paragraphs carrying a
-- per-process nonce, which arrives as the `pi-preview-details` metadata value.
-- HTML output gets <details>/<summary>; other formats (PDF via LaTeX) get the
-- summary in bold followed by the content. Raw HTML input stays disabled: only
-- these elements, generated here, are written as raw HTML. Markers are paired
-- within one list of blocks; one left unpaired (its partner landed in another
-- container) is shown as the literal tag it replaced.

local prefix

local function inline_html(inlines)
  if pandoc.write then
    local html = pandoc.write(pandoc.Pandoc({ pandoc.Plain(inlines) }), "html")
    return (html:gsub("%s+$", ""))
  end
  local text = pandoc.utils.stringify(inlines)
  text = text:gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;")
  return text
end

-- kind ("Open", "OpenExpanded", "Summary", "Close") and id of a marker paragraph.
local function marker(block)
  if block.t ~= "Para" or not block.content[1] or block.content[1].t ~= "Str" then return nil end
  local text = block.content[1].text
  if text:sub(1, #prefix) ~= prefix then return nil end
  return text:sub(#prefix + 1):match("^(%a+)(%d+)$")
end

local function summary_inlines(block)
  local inlines = {}
  for i = 2, #block.content do inlines[#inlines + 1] = block.content[i] end
  while inlines[1] and (inlines[1].t == "Space" or inlines[1].t == "SoftBreak") do table.remove(inlines, 1) end
  return inlines
end

local function details(frame)
  local summary = frame.summary or { pandoc.Str("Details") }
  local out = {}
  if FORMAT:match("html") then
    out[1] = pandoc.RawBlock("html", '<details class="pi-preview-details"' .. (frame.open and " open" or "") .. "><summary>" .. inline_html(summary) .. "</summary>")
    for _, block in ipairs(frame.blocks) do out[#out + 1] = block end
    out[#out + 1] = pandoc.RawBlock("html", "</details>")
  else
    out[1] = pandoc.Para({ pandoc.Strong(summary) })
    for _, block in ipairs(frame.blocks) do out[#out + 1] = block end
  end
  return out
end

-- What an unpaired marker stood for, as literal text.
local function literal(frame)
  local out = { pandoc.Para({ pandoc.Str(frame.open and "<details open>" or "<details>") }) }
  if frame.summary then
    local inlines = { pandoc.Str("<summary>") }
    for _, inline in ipairs(frame.summary) do inlines[#inlines + 1] = inline end
    inlines[#inlines + 1] = pandoc.Str("</summary>")
    out[2] = pandoc.Para(inlines)
  end
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
    local kind, id = marker(block)
    if kind == "Open" or kind == "OpenExpanded" then
      stack[#stack + 1] = { id = id, open = kind == "OpenExpanded", blocks = {} }
    elseif kind == "Summary" and top.id == id and not top.summary and #top.blocks == 0 then
      top.summary = summary_inlines(block)
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
