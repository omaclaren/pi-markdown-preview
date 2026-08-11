# Multiple browser watch sources

Status: proposed implementation plan for a host-agnostic extension of completion-level watch mode.

## Goal

Allow one Pi session to keep independent browser previews open for several files while the user works in Pi, an editor, or both. A single completed-assistant-response watcher may coexist with those file watchers.

This is a watcher-state change, not a renderer change. Every source continues to use the canonical Pandoc pipeline, bounded revision history, authenticated loopback server, and existing browser-opening abstraction. cmux remains an optional opener integration; watcher identity and lifecycle must not depend on it.

## Scope

### Included

- Multiple file watchers, each identified by its normalized absolute source path.
- At most one assistant-response watcher.
- File and response watchers running at the same time.
- Independent server, token, history, resource root, font size, render generations, errors, and cleanup for each watcher.
- Source-specific browser titles and labels that distinguish several previews.
- Commands to list watchers, stop one watcher, or stop all watchers.
- A small hard limit of eight active watchers per Pi session, including the response watcher.

### Deferred

- User-assigned watcher names.
- Globs, directories, or recursive discovery.
- Watching linked images, stylesheets, includes, or other dependencies.
- Persisting or restoring watchers across Pi sessions.
- Multiple response watchers or response watchers scoped to branches.
- A shared multi-source HTTP server or dashboard.
- Streaming partial assistant responses.

## Command semantics

| Command | Behaviour |
|---|---|
| `/preview-browser -w` | Start or reopen the one response watcher. It may coexist with file watchers. |
| `/preview-browser -w <path>` | Start or reopen the watcher for that file. |
| `/preview-browser --list` | Report active and provisional watchers, their source, and whether they are starting, healthy, or retaining a last-good preview. |
| `/preview-browser --stop <path>` | Stop the watcher for that normalized file path. |
| `/preview-browser --stop --responses` | Stop the response watcher. |
| `/preview-browser --stop --all` | Stop every watcher in the Pi session. |
| `/preview-browser --stop` | Preserve the current convenient behaviour when zero or one watcher exists. If several exist, make no change and ask for a path, `--responses`, or `--all`. |

The equivalent `/preview --browser ...` forms remain supported. Quoted paths with spaces must continue to work. Repeating a start command may update that watcher's font size and reopen its existing URL, but must not create another server or history.

Parsing remains token-based and never re-enters a shell. Before a `--` delimiter, `--list`, `--responses`, and `--all` are operation flags. `--file` always consumes exactly the next token as a literal path, including a token beginning with `-`; after `--`, one remaining token is treated as a literal path. This gives reserved or dash-prefixed filenames unambiguous forms such as `--stop --file --all` and `--stop -- --responses`. More than one path is rejected.

`--responses` and `--all` are valid only with `--stop` and are mutually exclusive with each other or a file path; `--list` takes no source. Invalid combinations fail before reserving capacity or changing registry state. In particular, list/stop operations reject `--watch`, `--pick`, PDF, terminal, and unrelated font-size arguments. One-shot `/preview-browser [path]` behaviour remains unchanged, including explicit `--file` and delimiter handling.

## State model

Replace the singleton `browserWatch` with a session-scoped registry:

```typescript
type BrowserWatcherId = "responses" | `file:${string}`;

interface BrowserWatchState {
  id: BrowserWatcherId;
  server: BrowserWatchServer;
  source: ResponseBrowserWatchSource | FileBrowserWatchSource;
  sourceLabel: string;
  resourcePath: string;
  fontSizePx: number;
  lastRenderKey: string;
  pendingRenderKey?: string;
  renderGeneration: number;
  operationId: number;
  renderInFlight?: Promise<boolean>;
  renderQueued: boolean;
  forceRenderQueued: boolean;
  lastSuccessfulAt?: number;
}

const browserWatches = new Map<BrowserWatcherId, BrowserWatchState>();
```

The registry, provisional starts, monotonic operation counter, per-ID owner records, response fallback timer, and registry epoch must live inside the extension-factory closure. Do not add module-level watcher state that could cross Pi or compatible-host sessions. The existing shared headless renderer lifecycle is unchanged by this feature.

File IDs use the existing file's canonical `realpath()` plus deterministic path normalization. A session-local alias map retains each normalized requested path, so the same symlink or differently cased alias reuses one watcher and can still be reopened or stopped while temporarily missing. Identity remains path-based rather than inode-based, so distinct hard-link paths are not guessed equivalent. Aliases are removed only after that watcher's lifecycle and any cleanup retry have ended.

The file source owns its exact `watchFile` listener, debounce timer, refresh sequence, last content hash, last error, and stable display/source path. The response source owns its last response key; the session owns the single compatible-host fallback timer. Health reporting derives from these explicit fields and `lastSuccessfulAt`.

The response watcher keeps the existing `agent_settled` path and compatible-host `agent_end` fallback. Those hooks look up only the `"responses"` entry, and targeted response stop cancels its fallback timer. File callbacks capture their own state and verify that the registry still maps their ID to that exact state before reading, rendering, notifying, or updating history.

## Concurrency and races

The current global operation generation cannot be reused unchanged: starting file A must not cancel an overlapping start for file B.

Use per-ID operation ownership plus a registry epoch. Allocate operation IDs from one session-scoped monotonic counter so a deleted/recreated source can never reuse an old token:

- Maintain a current owner/tombstone map for every watcher ID, including IDs that do not yet have registered state.
- Every start, reopen, targeted stop, or failed-start cleanup captures a unique `{ id, operationId, registryEpoch }` token.
- After every `await`, code verifies the epoch and that the ID still maps to that exact operation ID before registering, mutating, opening, notifying, or cleaning up.
- Targeted stop installs a new operation-ID tombstone even when the watcher is only provisional, preventing a late start from registering afterward. A later start replaces it with a newer globally unique ID.
- `--stop --all` and `session_shutdown` advance the registry epoch, invalidate all per-ID work, and make in-flight starts close any server they created.
- Cleanup removes registry/provisional entries only with compare-and-delete semantics: stale work may clean up resources it owns, but must never delete or overwrite a replacement operation.
- Existing per-watcher render and file-refresh generations continue to reject stale reads, renders, and errors.
- Cleanup is idempotent and uses `Promise.allSettled()` when stopping several watchers, so one close failure cannot block the others. Failed cleanup resources remain in a retriable registry entry rather than becoming unreachable.

Track provisional starts in a map keyed by watcher ID. Reserving a new ID is a synchronous registry mutation that counts both active and provisional entries against the eight-watcher limit. A repeated start for an already provisional ID attaches to that operation's promise and records the latest requested font/open action; it never launches a second render or server. A targeted stop tombstones and cancels that provisional operation, while a later start receives a new operation ID. Starts for different sources may proceed independently.

## Lifecycle

### Start or reopen

1. Parse and normalize the requested source.
2. Derive its watcher ID and synchronously reserve capacity across active plus provisional IDs when adding a new ID.
3. If the watcher exists, claim a new per-ID operation, reconcile its latest content/style, apply a requested font-size change, and reopen its URL only while that claim still owns the ID.
4. Otherwise, register a provisional owner, render the initial document, start an isolated watch server, register file polling when applicable, reconcile once after registration to close the startup race, and atomically promote the provisional owner.
5. If browser opening fails, retain current behaviour: compare-and-delete only that operation's newly created watcher, clean up resources it owns, and report the error if it is still current.

### Stop one

1. Install a fresh operation-ID tombstone for the target first, cancelling either an active or provisional start.
2. Compare-and-delete the exact active/provisional owner before awaiting cleanup.
3. Clear its debounce timer, queued render request, and exact `watchFile` listener when it is a file watcher; cancel the fallback timer when it is the response watcher.
4. Invalidate pending work and close its server/SSE clients.
5. Leave every other watcher untouched.

### Stop all and shutdown

- Advance the registry epoch, snapshot and clear active plus provisional registries, and invalidate their owner records before awaiting anything.
- Cancel the response fallback timer and queued renders.
- Clean up all owned active/provisional resources with `Promise.allSettled()`.
- On `session_shutdown`, also close the shared headless preview browser as today.

Temporary deletion, rename, atomic save, or render failure affects only that file watcher and keeps its last good page visible. Recovery creates the next successful version in that watcher's own history.

## Presentation

Each generated document should have a stable source-specific title:

- `README.md — Markdown Preview`
- `Assistant responses — Markdown Preview`

The watch toolbar shows a concise display label: a path relative to `ctx.cwd` when the source is beneath it, otherwise only the basename. Do not embed an absolute local path in served HTML or transferable pages. Terminal-side `--list` output may show the full path. Labels are presentation only and must not become watcher identifiers.

Document titles, text labels, and attribute/tooltips use context-appropriate HTML text/attribute escaping; do not interpolate source strings into HTML templates directly.

Each watcher keeps its own 20-version history and transferable-link endpoint. Tokens, cookie names, absolute-image allowlists, and retained history are never shared across watchers. Preserve the existing per-server port-derived cookie name, allowing several cookies to coexist on `127.0.0.1` despite cookies not being port-scoped. Copying a link for one watcher must not authorize another.

Browser destination is orthogonal: system browsers receive ordinary tabs/windows, while an available host-specific opener may choose its own surface. The registry never stores cmux-specific state.

## Resource bounds

- Maximum eight active watchers per Pi session.
- Existing 300 ms file polling and 150 ms debounce remain per file.
- Content hashes suppress metadata-only events and duplicate renders.
- Pandoc runs only for a changed source. Each watcher is single-flight and coalescing: while one render runs, retain only a queued latest refresh (and whether it must be forced), then render that latest snapshot next. Different watchers may render concurrently; there is no session-wide render queue.
- Each watcher retains at most 20 successful documents.
- Reaching the limit reports the active sources and requires stopping one; it never silently evicts a watcher.

## Implementation sequence

1. Extend argument parsing for `--list`, `--responses`, `--all`, and stop-with-path while retaining one-shot parsing.
2. Introduce watcher IDs, path normalization, the registry, provisional-start tracking, and registry epoch.
3. Refactor start, refresh, reopen, and stop helpers to operate on an explicit state/ID rather than a singleton.
4. Point assistant lifecycle hooks only at the response watcher; keep file refreshes isolated.
5. Add list/targeted-stop/all-stop command handling and messages.
6. Add source-aware document titles and toolbar labels without changing renderer output.
7. Update README/help text and compatibility tests.

## Verification

### Deterministic tests

- Parser acceptance and rejection for list, targeted stop, response stop, all stop, quoted paths, and reserved filenames via `--file`.
- Start two files and confirm independent servers, tokens, resource roots, revisions, and histories.
- Start response plus file watchers and confirm agent events update only the response watcher.
- Repeat the same normalized path and confirm reopen rather than duplication.
- Stop one file during its provisional start and after server creation; it must never register late or delete a replacement watcher.
- Stop one file while another render is in flight; the other watcher must remain active.
- Bare stop with zero, one, and several watchers.
- Stop all and session shutdown release every timer, file listener, server, and SSE client.
- Temporary deletion/recovery and atomic-save behaviour remain isolated per file.
- Stale read/render/error suppression remains per watcher.
- Concurrent starts reserve capacity atomically; the ninth active-or-provisional ID is rejected without disturbing the first eight.
- Each watcher permits at most one Pandoc child at a time and coalesces rapid updates to the latest snapshot.
- Cross-token requests between two watch servers are rejected, and both port-derived cookies coexist in one browser cookie jar without collision.
- Browser titles and toolbar labels identify their sources, escape hostile filenames, and never expose absolute paths in served HTML.
- Non-watch browser, terminal, PDF, picker, and export flows remain unchanged.

### Host smoke tests

- Standard Pi: two file watchers plus one response watcher, targeted stop, then stop all.
- Compatible host: extension load, two file starts, list, targeted stop, and shutdown.
- macOS/Linux/Windows opener selection remains unchanged outside optional host integrations.

## Acceptance criteria

1. A Pi session can watch at least two files concurrently and update each preview independently.
2. One response watcher can coexist with file watchers without cross-updates.
3. Existing single-watcher commands retain their effective behaviour.
4. Repeating a source never creates duplicate watcher state.
5. Stopping or failing one watcher cannot stop, overwrite, authorize, or leak resources from another.
6. Stop-all and session shutdown leave no listeners, timers, servers, or pending registrations.
7. Security properties remain per-server: loopback binding, authentication, CSP, route allowlists, and bounded history.
8. Multiple previews are distinguishable without relying on a particular terminal, browser, editor, or host integration.
