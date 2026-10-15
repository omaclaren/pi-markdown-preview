-- Collapsible blocks marked by markdown-details.js: fenced divs with the reserved
-- classes pi-preview-details and pi-preview-summary. HTML output gets
-- <details>/<summary>; other formats (PDF via LaTeX) get the summary in bold
-- followed by the content. Raw HTML input stays disabled: only these elements,
-- generated here, are written as raw HTML.

local function summary_of(block)
  if block and block.t == "Div" and block.classes:includes("pi-preview-summary") then
    return pandoc.utils.blocks_to_inlines(block.content)
  end
  return nil
end

local function inline_html(inlines)
  if pandoc.write then
    local html = pandoc.write(pandoc.Pandoc({ pandoc.Plain(inlines) }), "html")
    return (html:gsub("%s+$", ""))
  end
  local text = pandoc.utils.stringify(inlines)
  text = text:gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;")
  return text
end

function Div(el)
  if not el.classes:includes("pi-preview-details") then return nil end
  local summary = summary_of(el.content[1])
  local first = summary and 2 or 1
  summary = summary or { pandoc.Str("Details") }
  local blocks = {}
  if FORMAT:match("html") then
    local open = el.attributes["data-open"] == "true" and " open" or ""
    blocks[1] = pandoc.RawBlock("html", '<details class="pi-preview-details"' .. open .. "><summary>" .. inline_html(summary) .. "</summary>")
  else
    blocks[1] = pandoc.Para({ pandoc.Strong(summary) })
  end
  for i = first, #el.content do blocks[#blocks + 1] = el.content[i] end
  if FORMAT:match("html") then blocks[#blocks + 1] = pandoc.RawBlock("html", "</details>") end
  return blocks
end
