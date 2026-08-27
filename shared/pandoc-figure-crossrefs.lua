local function is_figure_identifier(identifier)
  if type(identifier) ~= "string" then return false end
  return identifier:match("^fig%-[%w][%w_.:%-]*$") ~= nil
    or identifier:match("^fig:[%w][%w_.:%-]*$") ~= nil
end

local function is_exact_figure_cite(cite)
  if #cite.citations ~= 1 then return false end
  local item = cite.citations[1]
  return is_figure_identifier(item.id)
    and #item.prefix == 0
    and #item.suffix == 0
    and tostring(item.mode) ~= "SuppressAuthor"
end

local function walk_document(document, filter)
  if type(document.walk) == "function" then return document:walk(filter) end
  local wrapper = pandoc.Div(document.blocks)
  wrapper = pandoc.walk_block(wrapper, filter)
  document.blocks = wrapper.content
  return document
end

local function append_inlines(target, source)
  for _, inline in ipairs(source) do table.insert(target, inline) end
end

local function prefixed_caption_inlines(caption, number)
  local prefixed = {
    pandoc.Str("Figure"),
    pandoc.Space(),
    pandoc.Str(tostring(number) .. ":"),
  }
  if #caption > 0 then
    table.insert(prefixed, pandoc.Space())
    append_inlines(prefixed, caption)
  end
  return prefixed
end

local function prefixed_caption_blocks(blocks, number)
  local prefixed = {
    pandoc.Str("Figure"),
    pandoc.Space(),
    pandoc.Str(tostring(number) .. ":"),
  }
  if #blocks == 0 then
    table.insert(blocks, pandoc.Plain(prefixed))
    return blocks
  end

  local first = blocks[1]
  if first.t == "Plain" or first.t == "Para" then
    if #first.content > 0 then table.insert(prefixed, pandoc.Space()) end
    append_inlines(prefixed, first.content)
    first.content = prefixed
  else
    table.insert(blocks, 1, pandoc.Plain(prefixed))
  end
  return blocks
end

local function collect_identifier_counts(document, uses_figure_elements)
  local counts = {}
  local function record(element)
    local identifier = element.identifier
    if type(identifier) == "string" and identifier ~= "" then
      counts[identifier] = (counts[identifier] or 0) + 1
    end
    return nil
  end

  local filter = {
    Code = record,
    CodeBlock = record,
    Div = record,
    Header = record,
    Image = record,
    Link = record,
    Span = record,
    Table = record,
  }
  if uses_figure_elements then filter.Figure = record end
  walk_document(document, filter)
  return counts
end

local function collect_numbered_figures_from_blocks(blocks, uses_figure_elements, occurrences)
  for _, block in ipairs(blocks) do
    if uses_figure_elements and block.t == "Figure" then
      table.insert(occurrences, { element = block, identifier = block.identifier, kind = "Figure" })
    elseif not uses_figure_elements and block.t == "Para" and #block.content == 1 then
      local image = block.content[1]
      if image.t == "Image" and image.title:match("^fig:") then
        table.insert(occurrences, { element = image, identifier = image.identifier, kind = "Image" })
      end
    elseif block.t == "BlockQuote" or block.t == "Div" then
      collect_numbered_figures_from_blocks(block.content, uses_figure_elements, occurrences)
    elseif uses_figure_elements and (block.t == "BulletList" or block.t == "OrderedList") then
      for _, item in ipairs(block.content) do
        collect_numbered_figures_from_blocks(item, uses_figure_elements, occurrences)
      end
    elseif uses_figure_elements and block.t == "DefinitionList" then
      for _, entry in ipairs(block.content) do
        for _, definition in ipairs(entry[2]) do
          collect_numbered_figures_from_blocks(definition, uses_figure_elements, occurrences)
        end
      end
    end
  end
end

local function collect_numbered_figures(document, uses_figure_elements)
  local occurrences = {}
  collect_numbered_figures_from_blocks(document.blocks, uses_figure_elements, occurrences)
  return occurrences
end

function Pandoc(document)
  local has_exact_figure_reference = false
  walk_document(document, {
    Cite = function(cite)
      if is_exact_figure_cite(cite) then has_exact_figure_reference = true end
      return nil
    end,
  })
  if not has_exact_figure_reference then return document end

  local uses_figure_elements = pandoc.Figure ~= nil
  local identifier_counts = collect_identifier_counts(document, uses_figure_elements)
  local occurrences = collect_numbered_figures(document, uses_figure_elements)
  local figures = {}

  for number, occurrence in ipairs(occurrences) do
    local identifier = occurrence.identifier
    if is_figure_identifier(identifier) then
      local figure = figures[identifier]
      if figure then
        figure.count = figure.count + 1
      else
        figures[identifier] = { count = 1, number = number }
      end
    end
  end

  for identifier, figure in pairs(figures) do
    if figure.count > 1 or identifier_counts[identifier] ~= 1 then
      io.stderr:write("pi-markdown-preview: duplicate figure identifier: ", identifier, "\n")
    end
  end

  if not tostring(FORMAT):match("latex") then
    for number, occurrence in ipairs(occurrences) do
      if occurrence.kind == "Figure" then
        local caption = occurrence.element.caption
        if caption.short then caption.short = prefixed_caption_inlines(caption.short, number) end
        caption.long = prefixed_caption_blocks(caption.long, number)
        occurrence.element.caption = caption
      else
        occurrence.element.caption = prefixed_caption_inlines(occurrence.element.caption, number)
      end
    end
  end

  local unresolved = {}
  local result = walk_document(document, {
    Cite = function(cite)
      if not is_exact_figure_cite(cite) then return nil end
      local item = cite.citations[1]
      local figure = figures[item.id]
      if not figure or figure.count ~= 1 or identifier_counts[item.id] ~= 1 then
        unresolved[item.id] = true
        return nil
      end
      return pandoc.Link(
        {
          pandoc.Str("Figure"),
          pandoc.Space(),
          pandoc.Str(tostring(figure.number)),
        },
        "#" .. item.id
      )
    end,
  })

  for identifier in pairs(unresolved) do
    io.stderr:write("pi-markdown-preview: unresolved figure reference: ", identifier, "\n")
  end
  return result
end
