# Auto-refreshing browser preview (`--watch`)

Status: implementation scope revised to completion-level updates.

## Implemented scope

The minimal watch mode keeps one browser preview open and refreshes it after a completed agent run. It performs one canonical Pandoc render only when the latest assistant response changed. `/preview-browser` remains a one-shot preview; `/preview-browser --watch` (or `-w`) starts or reopens the watcher, and `/preview-browser --stop` stops it. The main command also accepts `/preview --browser --watch` and its short form `/preview -b -w`. The watcher is session-scoped and shuts down during `session_shutdown`.

The implementation intentionally does not render token-by-token, track tool activity, maintain a live Markdown state machine, or introduce a second Markdown renderer. A token-protected server binds only to `127.0.0.1`; SSE carries only revision notifications, while the browser fetches complete HTML documents. Relative preview resources are restricted to allowlisted image types beneath pi's current working directory. Exact absolute image paths and `file:` URLs found in retained response HTML are rewritten to opaque authenticated routes; no general absolute-filesystem route is exposed, and each route expires with the last history entry that references it.

The server retains a bounded in-memory history of the latest 20 responses rendered while the watcher is active. Revision URLs support browser Back/Forward navigation and a small **Previous / Next / Latest** control. A page auto-follows only while it is on the latest revision; historical pages remain stable and mark **Latest (new)** when another response arrives. The waiting page shown before the first response is not added to history, and `/preview --pick --browser` remains the route to responses from before the watcher started.

## Deferred streaming idea

The remainder of this note records the larger streaming design considered before the scope was reduced. It is not part of the current implementation.

A future opt-in live mode could make a persistent browser page follow the current assistant response while it is being generated.

The existing static behaviour should remain unchanged. A likely interface is:

```text
/preview-browser --watch
/preview --browser --watch
/preview-browser --stop
```

Starting watch mode while Pi is idle should show the latest assistant response, then wait for the next response. If the command can be invoked during a stream, the next cumulative `message_update` should catch the page up. The watcher should remain active until the tab closes, the user stops it, or the Pi session shuts down.

Watch mode is specifically for assistant responses. Initially, combinations such as `--watch --file`, `--watch --pick`, `--watch --pdf`, and `--watch --terminal` should be rejected rather than given ambiguous meanings.

## Why it fits

Pi exposes the required assistant lifecycle:

- `message_start` identifies a new assistant message.
- `message_update` provides both the cumulative assistant message and the token-level `assistantMessageEvent`.
- `message_end` provides the canonical completed message.
- `agent_settled` identifies the point where retries, compaction retries, and queued continuations have finished.
- `session_shutdown` provides the cleanup boundary for a local server and open connections.

The difficult part is not obtaining streamed text. It is rendering incomplete Markdown efficiently, avoiding stale Pandoc results, preserving scroll position, handling tool-use gaps, and managing a long-lived local browser resource safely.

## Current constraints in `pi-markdown-preview`

The current browser path is deliberately static:

1. Command handling waits for Pi to become idle.
2. `openPreviewInBrowser()` obtains the latest completed assistant Markdown.
3. `renderPreviewHtmlToFile()` runs Pandoc and builds a complete HTML document.
4. The content-addressed file is opened with a `file://` URL.

Watch mode therefore needs a separate branch before `ctx.waitForIdle()`.
The `/preview-browser` wrapper currently waits for idle before calling the shared command handler, and the shared handler waits again.
This should be restructured carefully so only watch start/stop/status operations bypass the idle wait; static preview, PDF, terminal, file, and picker flows should retain their existing behaviour.

The existing browser renderer already contains the desired presentation pipeline:

- Markdown/LaTeX normalization
- Pandoc conversion
- theme-derived CSS
- annotation placeholders
- diff decoration
- MathML plus selective MathJax fallback
- Mermaid rendering and icon packs
- local resource base paths

Watch mode should reuse this pipeline rather than introduce a second Markdown renderer with subtly different final output.

## Relevant ideas from `pi-studio`

Pi Studio is not already an exact implementation of this feature: its **Working** view receives live assistant deltas, while its rich **Response Preview** receives finalized responses. It nevertheless contains useful patterns that should be adapted rather than reinvented.

### Server and stream state

Relevant server-side patterns in `~/Git-Working/pi-studio/index.ts` include:

- `appendStudioTraceAssistantDelta()` for small streamed updates
- `finalizeStudioTraceAssistantEntry()` for reconciliation with canonical final content
- `ensureServer()` for an on-demand localhost server with a tokenized URL
- `broadcast()` and initial state sent on client connection
- `handleRenderPreviewRequest()` for bounded, token-authenticated Pandoc rendering
- `session_shutdown` cleanup

### Browser rendering

Relevant client-side patterns in `~/Git-Working/pi-studio/client/studio-client.js` include:

- `beginPreviewRender()` and `finishPreviewRender()`, which retain meaningful old content and delay the pending indicator
- `responsePreviewRenderNonce`, which prevents older async render results replacing newer ones
- `applyRenderedMarkdown()`, which applies Pandoc output and then performs annotation, Mermaid, math, PDF/image, and decoration passes
- `renderMermaidInElement()` and the cached Mermaid module/initialization
- `shouldStickTraceToBottom()` and conditional live auto-scroll
- WebSocket reconnect plus a full state resynchronization

The watch implementation should borrow these concepts, not depend on or copy the whole Studio application. In particular, a one-way watcher probably does not need Studio's full WebSocket protocol.

## Recommended first architecture

### 1. On-demand local server

Start a server only when watch mode is requested. Do not start it from the extension factory.

- Bind to `127.0.0.1`, never all interfaces.
- Use an operating-system-selected port by default.
- Generate an unguessable per-server token.
- Require the token on the page, event stream, render, and resource routes.
- Set `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer` on sensitive responses.
- Return or print the complete tokenized URL if opening the browser fails.
- Close the server and all clients during `session_shutdown`.

Server-Sent Events (SSE) are probably sufficient because the core data flow is server-to-browser. Ordinary HTTP endpoints can handle any render or resource requests. A WebSocket remains an option if later controls require substantial browser-to-extension messaging.

### 2. Explicit watcher state

Maintain a small session-scoped state object, for example:

```typescript
interface BrowserWatchSnapshot {
  runId: string | null;
  revision: number;
  status: "waiting" | "streaming" | "tools" | "complete" | "aborted" | "error";
  markdown: string;
  renderedRevision: number;
  renderedHtml?: string;
  error?: string;
}
```

Every newly connected client should receive a complete snapshot before incremental updates. Reconnection must not depend on having observed all earlier deltas.

The cumulative text in `event.message` should be the source of truth. Token deltas may be sent for responsiveness, but `message_end` should always reconcile the state with the full finalized assistant text.

Thinking blocks should remain excluded, matching the existing browser preview.

### 3. Assistant and tool lifecycle

Suggested behaviour:

- On `agent_start`, mark the watcher active without immediately clearing the previous useful preview.
- On assistant `message_start`, create a new active message generation.
- On `message_update`, extract cumulative text blocks, update the latest revision, and schedule rendering without awaiting it in the Pi event handler.
- On assistant `message_end` with `toolUse`, retain the last visible content and show a tool/activity status.
- When subsequent assistant text arrives, replace the prior assistant message once the new text is meaningful.
- On terminal assistant `message_end`, request an immediate canonical render.
- On `agent_settled`, mark the run complete.
- On aborted/error completion, retain available text and show the corresponding status.

The initial implementation should track the latest assistant message, matching the semantics of the current static browser command. It should not concatenate every pre-tool assistant message unless testing shows that this is more useful.

### 4. Latest-wins render scheduler

Do not invoke Pandoc for every token. A pure trailing debounce is also unsuitable: a continuous stream of tokens could postpone every render until generation ends.

Use a throttled, coalescing scheduler:

- At most one Pandoc render may run at a time.
- Render no more often than roughly every 250–400 ms.
- While a render is running, record only that a newer revision is pending.
- After completion, discard the result if its revision is stale.
- If newer content is pending, render the latest snapshot next rather than every intermediate revision.
- Force or prioritize a final render on `message_end`.
- Consider adding optional `AbortSignal` support to `renderMarkdownToHtmlWithPandoc()`, so a superseded child process can be terminated; correctness must not depend on cancellation.

The Pi event handlers should only update state and schedule background work. They must not block token streaming on Pandoc.

### 5. Stable browser shell and fragment updates

Prefer one stable browser document over repeatedly navigating the whole page.

A clean target design is:

1. Serve a static watch shell containing the existing preview CSS and reusable post-processing functions.
2. Render the latest Markdown to a Pandoc HTML fragment on the extension side.
3. Send `{ revision, html, annotationPlaceholders, status }` to the browser.
4. Ignore payloads older than the last applied revision.
5. Replace `#preview-root` and rerun annotations, diff decoration, Mermaid, and math processing.

This requires refactoring the current one-shot script in `buildBrowserHtmlFromPandocFragment()` into reusable initialization and `applyPreviewPayload()` logic.
The same functions should continue serving static HTML, so the two modes do not drift.

A simpler prototype may rewrite a stable full HTML document and trigger reloads, but it will likely flicker, reset state, and repeatedly initialize Mermaid/MathJax. It is useful for proving the event lifecycle, not the preferred polished implementation.

### 6. Scroll behaviour

Before replacing content, determine whether the reader is near the bottom, for example within 80–120 px.

- If near the bottom, scroll to the new bottom after rendering.
- If the reader has scrolled upward, preserve their position and do not pull them down.
- Starting a genuinely new response may reset to the top, but tool-use continuations should not.
- Keep the old preview visible while Pandoc works; show a subtle delayed “updating” state rather than an immediate loading blank.

This should follow the Studio Working-view policy rather than always forcing scroll.

### 7. Local resources

Serving the watch page over HTTP changes local image behaviour compared with the current `file://` document. Browsers generally block an HTTP page from loading arbitrary `file://` resources.

The watcher therefore needs an authenticated local-resource route inspired by Studio:

- Resolve relative resources against `ctx.cwd` for assistant responses.
- Map requested paths through the tokenized localhost server.
- Normalize and validate paths before reading them.
- Bound response sizes and use an allowlist of previewable MIME types.
- Do not expose a general arbitrary-file endpoint merely because the caller knows the token.

The exact allowed-root policy is an implementation decision. It should support normal relative images without quietly broadening filesystem access.

## Proposed event protocol

The exact transport can change, but keeping explicit message types will make lifecycle tests easier.

```text
snapshot  { runId, revision, status, markdown, renderedRevision, renderedHtml? }
start     { runId, revision }
content   { runId, revision, markdown? | delta? }
activity  { runId, status: "tools" | "streaming" }
rendered  { runId, revision, html, annotationPlaceholders }
complete  { runId, revision, markdown }
error     { runId, revision, message, recoverable }
shutdown  { reason }
```

Sending cumulative Markdown snapshots is simpler and more robust.
Sending deltas is cheaper and smoother, but reconnect and final reconciliation are then mandatory.
A reasonable compromise is deltas during a healthy connection, plus periodic or lifecycle snapshots.

## Command and UX details

Suggested command behaviour:

| Command | Behaviour |
|---|---|
| `/preview-browser` | Existing static preview; unchanged |
| `/preview-browser --watch` | Start or reuse watcher and open its page |
| `/preview --browser --watch` | Same watcher entry point |
| `/preview-browser --stop` | Stop watcher and close server connections |
| `/preview-browser --status` | Optional: report URL, client count, and current state |

The watch page should display a small nonintrusive state badge:

- Waiting for response
- Live
- Running tools
- Finalizing
- Complete
- Disconnected

Repeated `--watch` calls should reuse the current server and URL rather than create multiple servers. Multiple connected tabs may be supported, but one canonical watcher is enough initially.

When the final tab disconnects, schedule shutdown after a short grace period so normal reload/reconnect does not immediately kill the server. An explicit `--stop` and `session_shutdown` should close it immediately.

## Compatibility and non-goals

### Preserve

- Static `/preview-browser` output and its content-addressed HTML cache
- `/preview --browser`
- file and picker previews
- terminal and PDF rendering
- exported `openPreviewInBrowser()` behaviour
- standard Pi and compatible-host loading

### Initial non-goals

- Watching arbitrary files for filesystem changes
- Editing Markdown from the watch page
- Exposing thinking/reasoning content
- Mirroring every tool call and result in the document
- Remote unauthenticated access
- Replacing Pi Studio
- Supporting watch mode in print/headless operation beyond returning a forwardable local URL

## Implementation phases

### Phase 1: lifecycle prototype

- Extend argument parsing with watch start/stop/status operations.
- Restructure command handling so watch operations do not call `waitForIdle()`.
- Add session-scoped watcher state.
- Subscribe to assistant lifecycle events.
- Start a tokenized localhost server on demand.
- Serve a minimal page that displays cumulative plain Markdown and status.
- Reconcile on `message_end` and clean up on `session_shutdown`.

This phase validates whether commands can attach usefully during a stream and whether the persistent “start while idle, then watch future responses” workflow feels natural.

### Phase 2: rich live rendering

- Extract reusable browser preview CSS and client post-processing.
- Add the latest-wins Pandoc scheduler.
- Push rendered fragments with revision numbers.
- Preserve old content while rendering.
- Add conditional auto-scroll.
- Force a canonical final render.

### Phase 3: parity and hardening

- Add local-resource serving.
- Verify annotation, diff, math, Mermaid, icon-pack, and image parity.
- Add reconnect snapshots and zero-client grace shutdown.
- Add request/body/resource limits and render timeouts.
- Add SSH/port-forwarding guidance if a no-open mode is introduced.
- Smoke-test standard Pi and compatible hosts.

## Testing plan

### Unit tests

- Argument combinations and help text
- Assistant text extraction with text, thinking, and tool-call blocks
- Watch state transitions
- `toolUse` continuation behaviour
- Render throttling and coalescing with a fake renderer
- No overlapping renders
- Stale revision rejection
- Immediate final flush
- Path normalization and resource-root enforcement
- Token rejection on every protected route

### Integration tests

- Start server on `127.0.0.1` with an ephemeral port
- Connect, receive initial snapshot, disconnect, and reconnect
- Stream a sequence of cumulative updates and receive the canonical final state
- Stop command and `session_shutdown` close clients and release the port
- Static preview remains unchanged

### Browser tests

Use Puppeteer with deterministic local fixtures:

- Live prose update
- An incomplete then completed code fence
- An incomplete then completed list/table
- Math and annotation finalization
- Mermaid finalization without stale diagrams
- Local relative image loading
- Stick-to-bottom behaviour
- Manual scroll-up preservation
- Delayed updating indicator without blanking existing content
- Reconnect and state recovery

### Manual smoke tests

- Start watch while idle, then submit a prompt
- Start watch during an active response if Pi permits command execution then
- Response that calls one or more tools before final text
- Abort with Escape
- Automatic retry or compaction retry
- Close and reopen the browser page
- `/reload`, `/new`, `/resume`, and Pi exit
- macOS, Linux, and Windows browser opening
- standard Pi and supported compatible hosts

## Acceptance criteria

A first releasable version should satisfy all the following:

1. Existing static preview commands behave exactly as before.
2. Watch mode starts only on explicit request and consumes no background resources otherwise.
3. The page visibly updates during a normal uninterrupted assistant stream.
4. Pandoc processes are bounded, coalesced, and never spawned per token.
5. The final page is rendered from the canonical completed assistant message.
6. In-flight stale renders cannot replace newer content.
7. Manual scrolling is respected.
8. Tool-use gaps retain useful content and display status rather than flashing blank.
9. The server binds only to localhost and all sensitive routes require the session token.
10. Session shutdown closes the server, clients, timers, and render processes.
11. Markdown, annotations, math, Mermaid, and local-image behaviour match static browser preview at completion.

## Open decisions

Resolve these after the Phase 1 prototype rather than guessing prematurely:

- Is `--watch` persistent across responses, or one-shot for the next/current response? Persistent is the current recommendation.
- Does the page track only the latest assistant message or concatenate meaningful pre-tool messages? Latest-message semantics are the current recommendation.
- Is SSE sufficient, or do browser controls justify WebSockets?
- Should rich rendering run entirely on the extension side, or should the browser request renders as Studio does?
- What render interval feels live without excessive Pandoc churn?
- What local-resource roots should be allowed?
- Should closing the final tab stop the watcher immediately or after a grace period?
- Should a future `--no-open`/`--port` mode support SSH forwarding, following Pi Studio?
