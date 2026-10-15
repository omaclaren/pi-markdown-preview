# Details and limits

Reference material for [pi-markdown-preview](../README.md): what a browser watcher serves, how it updates, and the limits on what it reads and shows.

## Argument aliases

- Pick: `-p`, `pick`
- File: `-f`
- Browser: `-b`, `browser`, `--external`, `external`, `--browser-native`, `native`
- Browser watch: `--watch`, `-w`, `--stop`
- PDF: `pdf`
- Terminal: `terminal`, `--terminal` (the default)
- Font size: `--font-size <px>`, `--font-size=<px>`, `--font-size-px <px>`, `--fs <px>` (10–24 px)
- Help: `--help`, `-h`, `help`

`--pick` and `--file` cannot be used together.

## Security

Each browser watcher runs its own server on `127.0.0.1` with its own token. On first load the page exchanges the token for a browser-specific session cookie and removes it from the address bar, which is why an address copied from the address bar is rejected in another browser. **Copy link** requests a fresh authenticated URL; it copies directly when the browser allows and otherwise selects the URL for manual copying.

Document routes require the watcher's cookie and an exact link in retained history or a recently opened document. There is no directory browser or arbitrary file-path endpoint. Exact local media references in a response, including parent-relative paths such as `../figures/plot.png`, are rewritten to opaque authenticated routes, and the general relative-resource route stays beneath the preview's resource directory. Watch mode serves only allowlisted image types, explicitly referenced PDFs and supported linked documents.

Anyone with a watcher's authenticated link can follow its local links, see resolved filesystem paths and request open or reveal actions for those linked files and folders, including paths outside the project. Linked tabs share the source watcher's lifetime, do not add watchers, and may expire as retained history is pruned; reopen an expired tab from its source preview.

File actions need a deliberate click and run on the machine hosting the preview. Opening uses the operating system's file association, so a runnable file may execute or an archive may extract. **Show in folder** reveals the item in Finder on macOS and uses Explorer on Windows; on Linux it opens the containing folder with `xdg-open`, without selecting the file. A desktop and a suitable file association are required. Actions are authenticated same-origin POSTs carrying a per-run action key and a retained link ID, never an arbitrary path or shell command. Reload an old action page after restarting its watcher.

HTML files run in an opaque-origin sandbox on a separate loopback server, never inside the authenticated preview page. The selected page is a snapshot; relative CSS, JavaScript modules, images, fonts and Wasm assets are served live from its directory and subdirectories, with canonical containment checks. Dot paths, directory escapes, sibling HTML documents, PDFs and non-asset files are blocked. HTTPS resources and requests from the page's own scripts are allowed, so this is not network isolation. The viewer itself does not upload local files anywhere. Its capability URLs grant access to the page and these assets, so keep them private. The server stops with its watcher. Forms, nested frames, local storage and general web-app hosting are outside the scope of this viewer.

Rendered content can't run scripts. Raw HTML is disabled, and the last step of every render removes event-handler attributes (`onclick` and the like) that Pandoc's attribute syntax would otherwise allow, and unlinks link and image targets with a `javascript:`, `vbscript:` or `livescript:` scheme. MathJax, which renders equations Pandoc can't convert, runs with its safe extension, so a link inside math can't use a script scheme either. The script policy below is a further guard, not the only one. Watch pages also send a script policy that allows only the page's own scripts. One-shot browser previews, exported HTML and terminal renders carry the same script policy as a meta tag.

## Local links and files

- Text, Markdown, LaTeX and HTML input is limited to 2 MiB of UTF-8. Linked pages use the watcher's theme and font size, and resolve their own images and links from the file's directory. Spaces and section anchors in paths are preserved.
- PDFs stream through byte-range-capable routes to the browser's viewer, or download, depending on browser settings. Office and other non-previewable files open a path page.
- PNG, JPEG, GIF, SVG, WebP, AVIF, BMP and ICO images use the browser's own decoder, with no conversion. SVGs stay image resources, never markup in the preview page. Images stream with their original filenames for saving. Editing an image does not trigger a watcher update; refresh to see it.
- Path pages do not read or download unsupported files, do not execute notebooks and do not list folders. Pages for supported files link back to their preview.
- **Copy local path** copies the resolved absolute path on the preview host, without a URL fragment or shell quoting, keeping symlinked paths as written. If the clipboard is blocked, the path is shown for manual selection. The browser's own **Copy link** still copies the page URL.
- Linked file action, image and HTML viewer pages use their source response's palette; authored HTML inside the sandbox is not restyled.
- One-shot previews also accept absolute paths and `file:`, `http(s):` and `data:` image URLs.
- In the browser, a single-page PDF used as a Markdown image is shown as a page preview linked to the original. Multi-page PDFs, and single-page PDFs that cannot be rendered, use the browser's PDF viewer.
- Folders need an explicit Markdown link such as `[Results](results/)`; a bare path in backticks stays text.
- `/preview-browser ./page.html` starts a file watcher for an HTML file even without `--watch`. Terminal previews and exports show HTML as source.

## Updates and history

- Active watch tabs check for a new revision every 200 ms with small requests that finish immediately. Background tabs check less often and check again when brought to the foreground, so several tabs do not hold open permanent connections.
- A response watcher renders once per settled agent run, and only for a new or changed latest response. A file watcher debounces changes and hashes the file, rendering only real changes. Changes to linked assets alone do not trigger a render.
- History keeps up to 20 responses or file versions, within a 32 MiB HTML total per watcher; the newest is always kept.
- A file watcher restores your position from a nearby unchanged paragraph or heading, so edits above it do not move you. If those anchors disappear, it falls back to the relative scroll position. It allows for late image and math layout and stops adjusting as soon as you interact with the page. Positions are kept per tab and per watcher, in browser storage.
- A disconnected page retries with a short backoff. A host that reuses the same port and token can reconnect existing pages after a restart.
- The counter panel overlays the document, stays open while you navigate, and closes with `Escape` or a click outside.

## Working

Details are read only when requested, for the exact retained response. Reads are limited to an 8 MiB JSONL tail, 1 MiB per record and 10,000 records. Display limits are 250 events, 16K characters of recorded text per entry and 256K overall. Clipped entries are marked; missing material is not reconstructed. System and developer entries, known harness-injected context, opaque signatures and prompt or non-image attachments are omitted.

Commands, paths and URLs stay literal: they do not execute or become file links. Known Bash, codemode, read and edit calls show commands or code, requested paths and ranges, and Before/After replacement text. Other options and unknown or malformed argument shapes keep their literal view. Calls and results stay separate. Raw input keeps the prompt's original text when the reading view removes leading blank lines.

Images come only from recorded inline bytes, never from current files, URLs or attachment IDs. Static PNG, JPEG and WebP are supported; missing, unsupported or oversized images show an unavailable message. Thumbnails decode when their result card opens. Limits are eight candidates per turn, 512 KiB and 8 Mi pixels per image, 2 MiB and 16 Mi pixels overall, and 8192 pixels per dimension. Record and read limits still apply, so an oversized source record may be absent altogether. Nothing is converted or stored.

Working inherits its response's palette and text size. Each view remembers its reading position, and expanded cards and wrapping choices survive refreshes within the tab. Missing data offers a link to the same response in Preview, and expired links offer a way to reconnect.

## Rendering

- Pandoc HTML conversion is limited to 30 seconds, 50 MiB of output and 5 MiB of diagnostics. Stopping a watcher cancels its Pandoc process tree.
- PDF export uses optional LaTeX styling packages when they are installed (for example `framed` for light code-block backgrounds) and simpler output otherwise.
- Terminal previews render in a 1200 px Chromium viewport at device scale 2.
- Annotation markers outside code show only the note text, without the `[an: ]` wrapper. Long notes wrap in PDF.
- `<sup>` and `<sub>` support covers plain inline text. Code examples, escaped tags and YAML front matter are left alone, and attributed or nested HTML is not enabled.
- `<details>` blocks are recognised when `<details>` (or `<details open>`) and `</details>` each stand alone at the start of a line, properly paired, with an optional `<summary>…</summary>` on the opening line or on the next nonblank line before the content. Blocks can nest, and nothing in the content (a `:::` line, for example) ends a block early. Indented, attributed, inline, multiline, unpaired or code- or math-quoted tags stay literal, and each of them keeps its own closing tag. The summary is plain text: common character references such as `&amp;` are decoded, and Markdown is not. Other HTML stays literal text, so a pair inside a literal `<div>` or `<pre>` line is still recognised. The browser starts a block closed unless it is marked `open`; terminal images and PNG export show it expanded, breaking pages between its blocks, and PDF shows the summary in bold followed by the content.
- Browser previews load a pinned PDF.js from jsDelivr only when a PDF figure is present; if it cannot load, the native PDF embed remains.
- Mermaid icon packs are loaded only for the prefixes a diagram uses. Icon and label colours are adjusted for contrast against their shapes, keeping their hues. PDF export passes the same packs to Mermaid CLI 11.6+ when a supported icon is present.
- Figure cross-references handle standalone captioned images and exact single references. Missing, duplicate, compound or qualified references stay visibly unresolved. Subfigures, project filters and chapter-aware numbering are not emulated.
- `preview_export` PNG output writes one file per page, named `-1-of-N`, `-2-of-N` and so on. By default the tool only writes files and returns their paths.
- On Windows, standard system and per-user Chrome, Edge, Brave and Chromium installations are found from `ProgramW6432`, `PROGRAMFILES`, `PROGRAMFILES(X86)` and `LOCALAPPDATA`, with the common `C:` locations as fallbacks.

## Code wrapping

- In the terminal, `w` wraps every code block until that preview closes; if re-rendering fails, the previous images and setting stay, and `Esc` cancels a render in progress.
- In the browser, per-block **Wrap** and **Copy** buttons appear on hover or keyboard focus and stay visible on touch devices. **Copy** copies the plain code, including indentation and line breaks, however it is wrapped, and shows **Copied** or **Failed**.
- In watch mode the overall choice survives refreshes and moving between responses in the same tab; per-block exceptions reset with each revision. Separate watchers and new one-shot previews start unwrapped.
- Wrapping changes presentation only. The buttons are left out of terminal and PNG rendering and printing, and PDF and PNG exports use the unwrapped layout.
