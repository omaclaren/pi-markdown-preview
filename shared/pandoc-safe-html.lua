-- The last filter in every Pandoc run. Content may use Pandoc's attribute syntax,
-- but not to add event handlers: any on… attribute is removed. Link and image targets
-- with a javascript:, vbscript: or livescript: scheme are dropped; a link keeps its
-- text and an image its description. Browsers ignore whitespace and control
-- characters inside a scheme, so those are removed before the scheme is read.

local blocked = { javascript = true, vbscript = true, livescript = true }

local function script_url(url)
  local scheme = (url or ""):gsub("[%z\1-\32\127]", ""):match("^([%a][%w+.-]*):")
  return scheme ~= nil and blocked[scheme:lower()] == true
end

local function clean(el)
  if not el.attributes then return nil end
  local kept, changed = {}, false
  for i = 1, #el.attributes do
    local pair = el.attributes[i]
    if pair[1]:lower():match("^on") then changed = true else kept[#kept + 1] = { pair[1], pair[2] } end
  end
  if not changed then return nil end
  el.attributes = kept
  return el
end

function Link(el)
  if script_url(el.target) then return el.content end
  return clean(el)
end

function Image(el)
  if script_url(el.src) then return el.caption end
  return clean(el)
end

Div = clean
Span = clean
Code = clean
CodeBlock = clean
Header = clean
Table = clean
