import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiveTurnProjector, LIVE_EVENT_WINDOW, LIVE_TURN_BYTES } from "../shared/turn-details.js";
import { renderLiveCard } from "../shared/turn-details-page.js";
import { createBrowserWatchServer } from "../shared/browser-watch-server.js";

const txt = text => ({ type: "text", text });
const user = (uuid, content, extra = {}) => ({ type: "user", uuid, message: { role: "user", content }, ...extra });
const assistant = (uuid, id, content, stop_reason = null, extra = {}) => ({ type: "assistant", uuid, message: { role: "assistant", id, content, stop_reason }, ...extra });
const call = (uuid, id, callId, name, input) => assistant(uuid, id, [{ type: "tool_use", id: callId, name, input }], "tool_use");
const result = (uuid, callId, content) => user(uuid, [{ type: "tool_result", tool_use_id: callId, content }]);
const labels = snapshot => snapshot.events.map(e => [e.id, e.kind, e.label]);

test("Live projection: one Claude turn from prompt to explicit end, with stable ids", () => {
 const live = createLiveTurnProjector("claude");
 assert.equal(live.current(), undefined);
 assert.equal(live.push(user("p", "Run the checks"), 1000), true);
 assert.equal(live.current(), "p");
 live.push(assistant("t1", "m1", [{ type: "thinking", thinking: "Plan" }]), 1100);
 live.push(call("c1", "m1", "call-1", "Bash", { command: "npm test" }), 1100);
 let snapshot = live.snapshot("p");
 assert.equal(snapshot.status, "running");
 assert.deepEqual(labels(snapshot), [["p:0", "prompt", "Prompt / input"], ["t1:0", "reasoning", "Recorded thinking / reasoning"], ["c1:0", "tool", "Tool: Bash"]]);
 assert.equal(snapshot.updatedAt, 1100, "Updated is the observation time of the newest record, not its recorded time");
 // A call without a result says so (and nothing more) until its result is recorded.
 assert.equal(snapshot.events.filter(e => e.kind === "result").length, 0);
 assert.equal(snapshot.events[2].pending, true);
 assert.match(renderLiveCard(snapshot.events[2], 3), /<summary>.*No result recorded yet<\/span><\/summary>/);
 assert.doesNotMatch(renderLiveCard(snapshot.events[2], 3), /running|in progress/i);
 const pendingVersion = snapshot.events[2].version;
 const before = snapshot.sequence;
 live.push(result("r1", "call-1", "ok"), 3000);
 live.push(assistant("a1", "m2", [txt("All green.")]), 3000);
 snapshot = live.snapshot("p");
 assert.ok(snapshot.sequence > before);
 assert.deepEqual(labels(snapshot).slice(3), [["r1:0", "result", "Tool result: Bash"], ["a1:0", "progress", "Assistant progress"]]);
 assert.equal(snapshot.events[2].pending, undefined, "the result clears the call's pending note");
 assert.notEqual(snapshot.events[2].version, pendingVersion, "so the call card is sent again");
 assert.ok(snapshot.events[2].changed > before);
 assert.doesNotMatch(renderLiveCard(snapshot.events[2], 3), /No result recorded yet/);
 assert.equal(snapshot.status, "running", "Text without a recorded end is not completion");
 const stable = Object.fromEntries(snapshot.events.map(e => [e.id, e.version]));
 live.push(assistant("a2", "m2", [txt("Done.")], "end_turn"), 5300);
 snapshot = live.snapshot("p");
 assert.equal(snapshot.status, "completed");
 assert.equal(snapshot.finalKey, "claude:m2");
 for (const e of snapshot.events) if (stable[e.id]) assert.equal(e.version, stable[e.id], "existing cards keep their versions");
 // Records after completion without a prompt never extend the finished turn.
 live.push({ type: "system", uuid: "s1", subtype: "turn_duration" }, 5400);
 assert.equal(live.snapshot("p").events.length, snapshot.events.length);
});

test("Live projection: duplicates, sidechains, injected context and system records change nothing", () => {
 const live = createLiveTurnProjector();
 live.push(user("p", "Go"), 1);
 const sequence = live.snapshot("p").sequence;
 assert.equal(live.push(user("p", "Go"), 2), false, "a record seen during backfill is not projected twice");
 assert.equal(live.push(assistant("side", "s", [txt("subagent")], null, { isSidechain: true }), 2), false);
 assert.equal(live.push(user("meta", "Caveat: local commands", { isMeta: true }), 2), false);
 assert.equal(live.push(user("sr", "<system-reminder>internal</system-reminder>"), 2), false);
 assert.equal(live.push({ type: "file-history-snapshot", messageId: "x" }, 2), false, "records without a uuid are ignored");
 assert.equal(live.snapshot("p").sequence, sequence);
 assert.match(live.snapshot("p").notices.join(" "), /harness-injected context is omitted/);
});

test("Live projection: local commands wait as context for the next turn; task notifications and interruptions bound turns", () => {
 const live = createLiveTurnProjector();
 assert.equal(live.push(user("cmd", "<command-name>/theme</command-name>\n<command-message>theme</command-message>\n<command-args></command-args>"), 1), false);
 assert.equal(live.push(user("out", "<local-command-stdout>Theme set to dark</local-command-stdout>"), 1), false);
 assert.equal(live.current(), undefined, "a lone local command is not a running turn");
 live.push(user("p", "Draft the exam"), 2);
 assert.equal(live.current(), "p", "the prompt anchors its turn; the command before it is context");
 assert.deepEqual(live.snapshot("p").events.map(e => e.label), ["Prompt / input", "Command output", "Prompt / input"]);
 live.push(assistant("a", "m1", [txt("Working on it")]), 3);
 live.push(user("stop", "[Request interrupted by user]"), 4);
 assert.equal(live.snapshot("p").status, "interrupted");
 // After a recorded end, a command again waits instead of starting a turn.
 live.push(user("cmd2", "<command-name>/cost</command-name>"), 4);
 assert.equal(live.current(), "p");
 // A task notification starts the next turn.
 const notification = "<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>";
 live.push(user("tn", notification), 5);
 assert.equal(live.current(), "tn");
 assert.equal(live.snapshot("p").newerAnchor, "tn", "an older turn points to the newer one and never becomes it");
 assert.equal(live.snapshot("tn").events[0].label, "Prompt / input", "held /cost output joins the next turn");
 live.push(assistant("err", "m3", [txt("API Error: overloaded")], "stop_sequence", { isApiErrorMessage: true }), 6);
 assert.equal(live.snapshot("tn").status, "error");
 // A third turn evicts the first: only the latest two are retained.
 live.push(user("p3", "Next"), 7);
 assert.equal(live.snapshot("p"), undefined);
 assert.equal(live.snapshot("tn").newerAnchor, "p3");
});

test("Live projection: mid-turn input, compaction and activity without a retained prompt", () => {
 const live = createLiveTurnProjector();
 live.push(user("p", "Start"), 1);
 live.push(call("c", "m1", "k", "Read", { file_path: "a" }), 2);
 live.push(user("steer", "Use the other file"), 3);
 assert.equal(live.current(), "p", "input during a running turn steers it rather than starting another");
 live.push({ type: "system", uuid: "cb", subtype: "compact_boundary" }, 4);
 assert.equal(live.snapshot("p").status, "running");
 assert.match(live.snapshot("p").notices.join(" "), /compacted during this turn/);
 // A projector whose records start partway (a bounded backfill) still shows the activity it has.
 const late = createLiveTurnProjector("claude", { partialStart: true });
 late.push(call("c2", "m9", "k2", "Bash", { command: "ls" }), 1);
 assert.equal(late.current(), "c2");
 assert.match(late.snapshot("c2").notices.join(" "), /prompt is not in the retained recorded activity/);
 // Otherwise activity without a prompt never starts a turn.
 const strict = createLiveTurnProjector();
 strict.push(call("c3", "m10", "k3", "Bash", { command: "ls" }), 1);
 assert.equal(strict.current(), undefined);
});

test("Live projection: a long turn keeps a sliding window with stable ids and a count of known evictions", () => {
 const live = createLiveTurnProjector();
 live.push(user("p", "Loop"), 0);
 for (let i = 0; i < 160; i++) {
  live.push(call(`c${i}`, `m${i}`, `k${i}`, "Bash", { command: `echo ${i}` }), i);
  live.push(result(`r${i}`, `k${i}`, `out ${i}`), i);
 }
 const snapshot = live.snapshot("p");
 assert.equal(snapshot.events.length, LIVE_EVENT_WINDOW);
 assert.equal(snapshot.omitted, 1 + 320 - LIVE_EVENT_WINDOW);
 assert.equal(snapshot.events.at(-1).id, "r159:0");
 assert.equal(snapshot.events.at(-1).label, "Tool result: Bash");
 assert.ok(snapshot.events.every(e => e.changed <= snapshot.sequence));
 // Snapshots are copies: changing one does not change the projection.
 snapshot.events[0].text = "changed";
 assert.notEqual(live.snapshot("p").events[0].text, "changed");
});

// Records with Claude's recorded links (parentUuid), as written by Claude Code.
const linkedUser = (uuid, parentUuid, content, extra = {}) => user(uuid, content, { parentUuid, ...extra });
const linkedCall = (uuid, parentUuid, callId) => ({ ...call(uuid, `m-${uuid}`, callId, "Bash", { command: "echo synthetic" }), parentUuid });
const linkedResult = (uuid, parentUuid, callId) => ({ ...result(uuid, callId, "Earlier branch result"), parentUuid });
const linkedFinal = (uuid, parentUuid, text) => assistant(uuid, `m-${uuid}`, [txt(text)], "end_turn", { parentUuid });

test("Live projection: membership follows recorded links, so late results stay with their own turn and never start one", () => {
 // Pi's lateEarlierBranch: a late result for the first turn's call arrives after the second prompt.
 const branch = createLiveTurnProjector();
 branch.push(linkedUser("p1", null, "First"), 1);
 branch.push(linkedCall("c1", "p1", "k1"), 2);
 branch.push(linkedFinal("f1", "c1", "First done"), 3);
 branch.push(linkedUser("p2", "f1", "Second"), 4);
 branch.push(linkedResult("late", "c1", "k1"), 5);
 assert.equal(branch.current(), "p2");
 assert.deepEqual(branch.snapshot("p2").events.map(e => e.id), ["p2:0"], "the second turn does not receive the first turn's result");
 assert.deepEqual(branch.snapshot("p1").events.map(e => e.id), ["p1:0", "c1:0", "f1:0", "late:0"], "the result joins its own call's turn");
 assert.equal(branch.snapshot("p1").status, "completed");
 // Pi's lateResultPhantomTurn: the same result before any next prompt is not a new running turn.
 const phantom = createLiveTurnProjector();
 phantom.push(linkedUser("p1", null, "First"), 1);
 phantom.push(linkedCall("c1", "p1", "k1"), 2);
 phantom.push(linkedFinal("f1", "c1", "First done"), 3);
 phantom.push(linkedResult("late", "c1", "k1"), 4);
 assert.equal(phantom.current(), "p1");
 assert.equal(phantom.snapshot("p1").status, "completed");
 assert.equal(phantom.snapshot("late"), undefined);
 // An unlinked result after completion is not shown anywhere, rather than guessed into a turn.
 phantom.push(linkedResult("stray", "unknown-parent", "k-unknown"), 5);
 assert.equal(phantom.current(), "p1");
 assert.equal(phantom.snapshot("p1").events.some(e => e.id === "stray:0"), false);
 // Parallel calls: results can name a sibling as parent; call membership places them exactly.
 const parallel = createLiveTurnProjector();
 parallel.push(linkedUser("p", null, "Both"), 1);
 parallel.push(linkedCall("a1", "p", "k1"), 2);
 parallel.push(linkedCall("a2", "a1", "k2"), 2);
 parallel.push(linkedResult("r1", "a2", "k1"), 3);
 parallel.push(linkedFinal("f", "r1", "Done"), 4);
 parallel.push(linkedUser("q", "f", "Next"), 5);
 parallel.push(linkedResult("r2", "r1", "k2"), 6);
 assert.deepEqual(parallel.snapshot("q").events.map(e => e.id), ["q:0"]);
 assert.deepEqual(parallel.snapshot("p").events.map(e => [e.id, e.pending === true]), [["p:0", false], ["a1:0", false], ["a2:0", false], ["r1:0", false], ["f:0", false], ["r2:0", false]]);
 // A turn evicted from the projection takes its late records with it.
 parallel.push(linkedFinal("qf", "q", "Next done"), 7);
 parallel.push(linkedUser("s", "qf", "Third"), 8);
 parallel.push(linkedResult("r3", "a2", "k2"), 9);
 assert.deepEqual(parallel.snapshot("s").events.map(e => e.id), ["s:0"]);
});

test("Live projection: each result in a record joins its own call's turn; an empty result still answers its call", () => {
 // Pi's mixedResults: one record answers a finished turn's call and the current turn's call.
 const live = createLiveTurnProjector();
 live.push(linkedUser("p1", null, "First"), 1);
 live.push(linkedCall("c1", "p1", "k1"), 2);
 live.push(linkedFinal("f1", "c1", "First done"), 3);
 live.push(linkedUser("p2", "f1", "Second"), 4);
 live.push(linkedCall("c2", "p2", "k2"), 5);
 live.push(linkedUser("mixed", "c2", [{ type: "tool_result", tool_use_id: "k1", content: "late" }, { type: "tool_result", tool_use_id: "k2", content: "current" }]), 6);
 live.push(assistant("next", "m-next", [txt("Continuing")], null, { parentUuid: "mixed" }), 7);
 assert.deepEqual(live.snapshot("p1").events.map(e => e.id), ["p1:0", "c1:0", "f1:0", "mixed:0"]);
 assert.deepEqual(live.snapshot("p2").events.map(e => [e.id, e.pending === true]), [["p2:0", false], ["c2:0", false], ["mixed:1", false], ["next:0", false]], "the current call is answered and the turn continues");
 // In either order.
 const reversed = createLiveTurnProjector();
 for (const r of [linkedUser("p1", null, "First"), linkedCall("c1", "p1", "k1"), linkedFinal("f1", "c1", "Done"), linkedUser("p2", "f1", "Second"), linkedCall("c2", "p2", "k2")]) reversed.push(r, 1);
 reversed.push(linkedUser("mixed", "c2", [{ type: "tool_result", tool_use_id: "k2", content: "current" }, { type: "tool_result", tool_use_id: "k1", content: "late" }]), 2);
 assert.deepEqual(reversed.snapshot("p1").events.map(e => e.id).at(-1), "mixed:1");
 assert.deepEqual(reversed.snapshot("p2").events.map(e => e.id).at(-1), "mixed:0");
 // Pi's emptyResults: a recorded result with nothing to show is not "No result recorded yet".
 const empty = createLiveTurnProjector();
 empty.push(user("p", "Run them"), 1);
 const contents = ["", [], [{ type: "text", text: "" }], "  \n "];
 contents.forEach((content, i) => empty.push(call(`c${i}`, `m${i}`, `k${i}`, "Bash", { command: "true" }), 2));
 const before = empty.snapshot("p");
 assert.ok(before.events.slice(1).every(e => e.pending === true));
 contents.forEach((content, i) => assert.equal(empty.push(result(`r${i}`, `k${i}`, content), 3), true));
 const after = empty.snapshot("p");
 assert.deepEqual(after.events.map(e => [e.id, e.pending === true]), [["p:0", false], ["c0:0", false], ["c1:0", false], ["c2:0", false], ["c3:0", false]]);
 assert.ok(after.sequence > before.sequence, "the change reaches the client");
});

test("Live projection: a lone slash command or ! command is context, never a running turn", () => {
 const live = createLiveTurnProjector();
 live.push(linkedUser("p", null, "Earlier"), 1);
 live.push(linkedFinal("f", "p", "Earlier done"), 2);
 // Pi's commandOnly probe: /theme and its output, then a real prompt.
 live.push(linkedUser("theme", "f", "<command-name>/theme</command-name><command-message>theme</command-message><command-args></command-args>"), 3);
 live.push(linkedUser("theme-out", "theme", "<local-command-stdout>Theme set</local-command-stdout>"), 3);
 live.push(linkedUser("bang", "theme-out", "<bash-input>ls</bash-input>"), 4);
 live.push(linkedUser("bang-out", "bang", "<bash-stdout>file.txt</bash-stdout><bash-stderr></bash-stderr>"), 4);
 assert.equal(live.current(), "p");
 assert.equal(live.snapshot("p").status, "completed", "nothing is running, so Follow activity has nothing to open");
 live.push(linkedUser("real", "bang-out", "Actual prompt"), 5);
 assert.equal(live.current(), "real", "the real prompt keeps its own anchor");
 assert.deepEqual(live.snapshot("real").events.map(e => e.id), ["theme:0", "theme-out:0", "bang:0", "bang-out:0", "real:0"]);
 // A command that expands into a prompt starts its turn when the model answers it.
 live.push(linkedFinal("rf", "real", "Answered"), 6);
 live.push(linkedUser("review", "rf", "<command-message>review</command-message>\n<command-name>/review</command-name>"), 7);
 live.push(linkedUser("expanded", "review", "Review the diff", { isMeta: true }), 7);
 assert.equal(live.current(), "real");
 live.push(assistant("x", "m-x", [txt("Reviewing")], null, { parentUuid: "expanded" }), 8);
 assert.equal(live.current(), "review");
 assert.equal(live.snapshot("review").status, "running");
 assert.deepEqual(live.snapshot("review").events.map(e => e.id), ["review:0", "x:0"]);
});

test("Live projection: Claude records are immutable; a reply's end arrives as its own record", () => {
 const live = createLiveTurnProjector();
 live.push(user("p", "First"), 1);
 live.push(assistant("a", "m", [txt("Draft")]), 2);
 // Pi's sameUuidUpdate: Claude Code never rewrites a record, so a repeated uuid is a duplicate read.
 assert.equal(live.push(assistant("a", "m", [txt("Done")], "end_turn"), 3), false);
 assert.equal(live.snapshot("p").status, "running");
 assert.equal(live.snapshot("p").events.at(-1).text, "Draft");
 // The recorded end comes as another record of the same message, with its own uuid.
 assert.equal(live.push(assistant("a2", "m", [txt("Done")], "end_turn"), 4), true);
 assert.equal(live.snapshot("p").status, "completed");
 assert.equal(live.snapshot("p").finalKey, "claude:m");
});

test("Live projection: memory is bounded by remembered links and card bytes, not only by the card count", () => {
 // Pi's long-turn probe: many calls with long (valid) ids.
 const live = createLiveTurnProjector();
 live.push(linkedUser("p", null, "Synthetic long turn"), 0);
 let parent = "p";
 for (let i = 1; i <= 30_000; i++) {
  live.push({ ...call(`c${i}`, `m${i}`, String(i).padStart(160, "x"), "SyntheticTool", { command: "echo test" }), parentUuid: parent }, i);
  parent = `c${i}`;
 }
 const stats = live.stats();
 assert.ok(stats.records <= 10_000, `remembered records ${stats.records}`);
 assert.ok(stats.calls <= 2 * LIVE_EVENT_WINDOW, `remembered calls ${stats.calls}`);
 assert.equal(stats.events, LIVE_EVENT_WINDOW);
 assert.equal(live.snapshot("p").omitted, 30_001 - LIVE_EVENT_WINDOW);
 // A late result still joins the turn through its recorded parent.
 live.push(linkedResult("late", "c29999", "x".repeat(155) + "29999"), 30_001);
 assert.equal(live.snapshot("p").events.at(-1).id, "late:0");
 // Pi's large-card probe: 16,384-character non-ASCII entries are bounded by size too.
 const big = createLiveTurnProjector();
 big.push(user("q", "Big"), 0);
 for (let i = 0; i < LIVE_EVENT_WINDOW; i++) big.push(assistant(`b${i}`, `n${i}`, [txt("é漢".repeat(8192))]), i);
 const window = big.snapshot("q");
 assert.ok(big.stats().bytes <= LIVE_TURN_BYTES, `card bytes ${big.stats().bytes}`);
 assert.ok(Buffer.byteLength(JSON.stringify(window)) < LIVE_TURN_BYTES * 1.1);
 assert.equal(window.events.length + window.omitted, LIVE_EVENT_WINDOW + 1, "cards dropped for size are counted as omitted");
 assert.equal(window.events.at(-1).id, `b${LIVE_EVENT_WINDOW - 1}:0`);
});

test("Live projection: Loaded for activity read at start, Updated for activity seen later", () => {
 const live = createLiveTurnProjector();
 live.push(user("p", "Go"), 100, true);
 assert.deepEqual([live.snapshot("p").loaded, live.snapshot("p").updatedAt], [true, 100]);
 live.push(assistant("a", "m", [txt("More")]), 200);
 assert.deepEqual([live.snapshot("p").loaded, live.snapshot("p").updatedAt], [false, 200]);
});

test("Live projection: only Claude is supported in milestone 1", () => {
 assert.throws(() => createLiveTurnProjector("pi"), /Claude Code sessions only/);
});

const html = "<!doctype html><html><head><title>Response</title></head><body><main id='preview-root'><p>Answer</p></main></body></html>";
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), "preview-live-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function auth(server) {
 const r = await fetch(server.url); assert.equal(r.status, 200);
 return { text: await r.text(), cookie: r.headers.get("set-cookie").split(";")[0], origin: new URL(server.url).origin };
}
const attr = (text, control) => text.match(new RegExp(`data-watch-control="${control}" href="([^"]+)"`))?.[1].replaceAll("&amp;", "&");
const liveEntry = text => text.match(/data-live-state="([^"]+)"/)?.[1].replaceAll("&amp;", "&").replace(/&format=json$/, "");

test("Live routes are opt-in, authenticated, lazy for HEAD, and serve a bounded live page", async t => {
 const dir = await temp(t);
 const plain = await createBrowserWatchServer(html, dir, { initialTurnDetails: async () => ({ events: [] }) });
 t.after(() => plain.close());
 const plainSession = await auth(plain);
 assert.doesNotMatch(plainSession.text, /<button data-watch-control="follow-activity"|data-live-state=/, "no Follow activity or live state without the live option");
 assert.equal((await fetch(new URL("/__pi_markdown_preview_live__/?identity=x&instance=y", plainSession.origin), { headers: { cookie: plainSession.cookie } })).status, 404);

 const live = createLiveTurnProjector();
 let calls = 0;
 const provider = { current: async () => { calls++; return live.current(); }, snapshot: async anchor => { calls++; return live.snapshot(anchor); } };
 const server = await createBrowserWatchServer(html, dir, { live: provider, initialTurnDetails: async () => ({ events: [] }), initialResponseKey: "claude:old" });
 t.after(() => server.close());
 const session = await auth(server);
 const entry = liveEntry(session.text);
 assert.ok(entry?.startsWith("/__pi_markdown_preview_live__/?identity="), "Follow activity knows the live entry");
 assert.doesNotMatch(session.text, /<a data-watch-control="live"|>Live<\/a>|Follow current turn/, "no separate Live tab");
 assert.match(session.text, /<a data-watch-control="turn-details" href="\/__pi_markdown_preview_turn__\/1\?[^"]+" title="Working \(Ctrl\+Alt\+W\)\. With Follow activity on, Working shows the current turn live"/, "Working links the finished response's fixed view by default");
 const get = (path, extra = {}) => fetch(new URL(path, session.origin), { redirect: "manual", ...extra, headers: { cookie: session.cookie, ...(extra.headers ?? {}) } });
 assert.equal((await fetch(new URL(entry, session.origin), { redirect: "manual" })).status, 403, "cookie required");
 assert.equal((await get(entry.replace(/instance=[^&]+/, "instance=stale"))).status, 409);
 assert.equal((await get(entry, { method: "HEAD" })).status, 200);
 assert.equal(calls, 0, "HEAD neither starts a lease nor reads activity");
 assert.equal((await get(entry)).status, 404, "no turn recorded yet");

 live.push({ type: "user", uuid: "p1", message: { role: "user", content: "Run <checks>" } }, 1000);
 const redirect = await get(entry);
 assert.equal(redirect.status, 302);
 const pageUrl = redirect.headers.get("location");
 assert.match(pageUrl, /^\/__pi_markdown_preview_live__\/p1\?identity=/);
 const page = await (await get(pageUrl)).text();
 assert.match(page, /<h1>Working · live<\/h1>/);
 assert.match(page, /<p class="notices">Read-only view; some conversation content may be missing or shortened\.<\/p>/, "the Working disclaimer");
 assert.match(page, /<span data-live-time-label>Updated<\/span> <time data-live-updated="1000">/);
 assert.match(page, /data-event-id="p1:0"/);
 assert.match(page, /Run &lt;checks&gt;/);
 assert.match(page, /<a data-watch-control="turn-details"[^>]* aria-current="page"[^>]*>Working<\/a>/, "the live page is the Working view");
 assert.match(page, /data-watch-control="copy-link" type="button" disabled/);
 assert.match(page, /script-src 'nonce-|<script nonce=/);
 assert.doesNotMatch(page, /<script>(?!\s*$)/, "every script carries the page nonce");
 assert.equal((await get(pageUrl.replace("/p1?", "/bad%20id?"))).status, 404);
 assert.equal((await get(pageUrl.replace("/p1?", "/gone?"))).status, 404);

 // A host following as many sessions as it allows says so instead of failing vaguely.
 const busy = Object.assign(new Error("busy"), { code: "LIVE_BUSY" });
 const full = await createBrowserWatchServer(html, dir, { live: { current: async () => { throw busy; }, snapshot: async () => { throw busy; } } });
 t.after(() => full.close());
 const fullSession = await auth(full);
 const fullEntry = liveEntry(fullSession.text);
 const fullGet = path => fetch(new URL(path, fullSession.origin), { redirect: "manual", headers: { cookie: fullSession.cookie } });
 const busyPage = await fullGet(fullEntry);
 assert.equal(busyPage.status, 503);
 assert.match(await busyPage.text(), /Live Working is busy/);
 const busyJson = await fullGet(`${fullEntry}&format=json`);
 assert.deepEqual([busyJson.status, await busyJson.json()], [503, { error: "busy" }]);
 const busyUpdates = await fullGet(fullEntry.replace("/?", "/p1/updates?") + "&cursor=");
 assert.deepEqual([busyUpdates.status, await busyUpdates.json()], [503, { error: "busy" }]);
});

test("Live updates: unchanged cursors, new cards only, resync, completion and newer turns", async t => {
 const dir = await temp(t);
 const live = createLiveTurnProjector();
 const server = await createBrowserWatchServer(html, dir, { live: { current: async () => live.current(), snapshot: async a => live.snapshot(a) } });
 t.after(() => server.close());
 const session = await auth(server);
 const query = liveEntry(session.text).split("?")[1];
 const updates = async (anchor, cursor) => {
  const r = await fetch(new URL(`/__pi_markdown_preview_live__/${anchor}/updates?${query}&cursor=${encodeURIComponent(cursor)}`, session.origin), { headers: { cookie: session.cookie } });
  return { status: r.status, type: r.headers.get("content-type"), cache: r.headers.get("cache-control"), body: await r.json() };
 };
 live.push({ type: "user", uuid: "p", message: { role: "user", content: "Go" } }, 1);
 live.push({ type: "assistant", uuid: "c", message: { role: "assistant", id: "m1", content: [{ type: "tool_use", id: "k", name: "Bash", input: { command: "ls" } }], stop_reason: "tool_use" } }, 2);
 let first = await updates("p", "");
 assert.equal(first.status, 200); assert.match(first.type, /application\/json/); assert.match(first.cache, /no-store/);
 assert.equal(first.body.loaded, false);
 assert.equal(first.body.resync, true);
 assert.deepEqual(first.body.ids, ["p:0", "c:0"]);
 assert.deepEqual(first.body.upserts.map(u => u.id), ["p:0", "c:0"]);
 assert.match(first.body.upserts[1].html, /^<details class="event tool" data-event-id="c:0"/);
 const same = await updates("p", first.body.cursor);
 assert.equal(same.body.unchanged, true); assert.equal(same.body.upserts, undefined);
 live.push({ type: "user", uuid: "r", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "k", content: "file.txt" }] } }, 3);
 const next = await updates("p", first.body.cursor);
 assert.equal(next.body.resync, false);
 assert.match(first.body.upserts[1].html, /No result recorded yet/);
 assert.deepEqual(next.body.upserts.map(u => u.id), ["c:0", "r:0"], "only changed cards are rendered: the call loses its pending note");
 assert.doesNotMatch(next.body.upserts[0].html, /No result recorded yet/);
 assert.match(next.body.upserts[1].html, /Tool result: Bash/);
 assert.equal((await updates("p", "other:1")).body.resync, true, "a different generation resyncs");
 // Completion links to the exact retained response once the host appends it.
 live.push({ type: "assistant", uuid: "f", message: { role: "assistant", id: "m2", content: [{ type: "text", text: "Done" }], stop_reason: "end_turn" } }, 4);
 let done = await updates("p", next.body.cursor);
 assert.match(done.body.statusHtml, /its response will appear in Preview shortly/);
 const revision = server.updateDocument(html.replace("Answer", "Done"), { appendToHistory: true, responseKey: "claude:m2", turnDetails: async () => ({ events: [] }) });
 done = await updates("p", done.body.cursor);
 assert.equal(done.body.unchanged, true, "the status can change without new cards");
 assert.match(done.body.statusHtml, new RegExp(`Turn completed\\. <a href="/\\?revision=${revision}&amp;identity=`));
 assert.match(done.body.statusHtml, new RegExp(`<a href="/__pi_markdown_preview_turn__/${revision}\\?identity=`));
 // A newer turn is offered, never followed.
 live.push({ type: "user", uuid: "p2", message: { role: "user", content: "Next" } }, 5);
 done = await updates("p", done.body.cursor);
 assert.match(done.body.statusHtml, /A newer turn has started\. <a href="\/__pi_markdown_preview_live__\/p2\?identity=/);
 assert.equal((await updates("gone", "")).status, 404);
});

test("Live browser view: appends while following, holds a paused reader, keeps open/wrap state, links completion", { timeout: 90_000 }, async t => {
 if (!process.env.PUPPETEER_EXECUTABLE_PATH) { t.skip("Set PUPPETEER_EXECUTABLE_PATH to a dedicated headless browser"); return; }
 const { default: puppeteer } = await import("puppeteer-core");
 const dir = await temp(t);
 const live = createLiveTurnProjector();
 const server = await createBrowserWatchServer(html, dir, { live: { current: async () => live.current(), snapshot: async a => live.snapshot(a) } });
 t.after(() => server.close());
 let n = 0;
 const step = (text, long = false) => {
  n++;
  live.push({ type: "assistant", uuid: `c${n}`, message: { role: "assistant", id: `m${n}`, content: [{ type: "tool_use", id: `k${n}`, name: "Bash", input: { command: `echo ${n}` } }], stop_reason: "tool_use" } }, Date.now());
  live.push({ type: "user", uuid: `r${n}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `k${n}`, content: long ? `${text}\n`.repeat(40) : text }] } }, Date.now());
 };
 live.push({ type: "user", uuid: "p", message: { role: "user", content: "Start the long job" } }, Date.now());
 const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true, args: ["--no-sandbox"] });
 try {
  const page = await browser.newPage(); await page.setViewport({ width: 900, height: 700 });
  await page.goto(server.url);
  await page.goto(new URL(liveEntry(await page.content()), server.url).href);
  assert.equal(await page.$eval("h1", e => e.textContent), "Working · live");
  assert.equal(await page.$eval('[data-watch-control="copy-link"]', e => e.disabled), true);
  const count = () => page.$$eval(".live-events > details.event", cards => cards.length);
  const bottom = () => page.evaluate(() => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80);
  assert.equal(await count(), 1);
  // Following: new cards arrive and the page stays at the bottom.
  for (let i = 0; i < 6; i++) step(`line ${i}`, true);
  await page.waitForFunction(() => document.querySelectorAll(".live-events > details.event").length === 13, { timeout: 10_000 });
  for (const card of await page.$$(".live-events > details.event.result > summary")) await card.click();
  await page.waitForFunction(() => window.innerHeight + window.scrollY < document.documentElement.scrollHeight, { timeout: 5000 });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  assert.equal(await bottom(), true);
  // Reader state: an opened result with wrapping on keeps both across updates.
  await page.$eval(".live-events > details.event.result .output-wrap input", e => e.click());
  step("after-open");
  await page.waitForFunction(() => document.querySelectorAll(".live-events > details.event").length === 15, { timeout: 10_000 });
  assert.equal(await page.$eval(".live-events > details.event.result", e => e.open && e.querySelector(".output-wrap input").checked), true);
  assert.equal(await bottom(), true, "a following reader stays at the bottom");
  // Paused: scrolled up, new cards are held behind a button.
  await page.evaluate(() => window.scrollTo(0, 0));
  step("held 1"); step("held 2");
  await page.waitForFunction(() => !document.querySelector(".live-newer").hidden, { timeout: 10_000 });
  assert.equal(await page.$eval(".live-newer", e => e.textContent), "4 newer events ↓");
  assert.equal(await count(), 15, "the visible cards stay put while paused");
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  await page.click(".live-newer");
  await page.waitForFunction(() => document.querySelectorAll(".live-events > details.event").length === 19, { timeout: 5000 });
  assert.equal(await bottom(), true);
  // Expand all covers appended cards.
  await page.click(".working-bulk");
  assert.equal(await page.$$eval(".live-events > details.event", cards => cards.every(c => c.open)), true);
  assert.equal(await page.$eval(".working-bulk", e => e.textContent), "Collapse all");
  // Completion appears only from the recorded end, then links the exact response.
  live.push({ type: "assistant", uuid: "f", message: { role: "assistant", id: "final", content: [{ type: "text", text: "Done" }], stop_reason: "end_turn" } }, Date.now());
  await page.waitForFunction(() => /its response will appear in Preview shortly/.test(document.querySelector("[data-live-status]").textContent), { timeout: 10_000 });
  server.updateDocument(html.replace("Answer", "Done"), { appendToHistory: true, responseKey: "claude:final" });
  await page.waitForFunction(() => document.querySelector("[data-live-status] a")?.textContent === "Open its response", { timeout: 10_000 });
  assert.match(await page.$eval("[data-live-updated]", e => e.textContent), /\d/);
  // Narrow layout without horizontal page scroll.
  await page.setViewport({ width: 360, height: 760 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
 } finally { await browser.close(); }
});

test("Follow activity state: JSON current turn and machine-readable live status", async t => {
 const dir = await temp(t);
 const live = createLiveTurnProjector();
 const server = await createBrowserWatchServer(html, dir, { live: { current: async () => live.current(), snapshot: async a => live.snapshot(a) } });
 t.after(() => server.close());
 const session = await auth(server);
 const toggle = session.text.match(/<button data-watch-control="follow-activity"[^>]*>/)?.[0];
 assert.ok(toggle, "the toolbar has a Follow activity toggle when Live is available");
 assert.match(session.text, /<button data-watch-control="follow-activity"[^>]*>Follow activity: Off<\/button>/);
 assert.match(toggle, /aria-pressed="false" hidden/); assert.match(toggle, /data-view="preview"/); assert.match(toggle, /data-latest="true"/);
 const state = toggle.match(/data-live-state="([^"]+)"/)[1].replaceAll("&amp;", "&");
 const json = async path => (await fetch(new URL(path, session.origin), { headers: { cookie: session.cookie } })).json();
 assert.deepEqual(await json(state), { anchor: null });
 live.push({ type: "user", uuid: "p", message: { role: "user", content: "Go" } }, 1);
 const current = await json(state);
 assert.equal(current.anchor, "p"); assert.equal(current.status, "running"); assert.match(current.liveHref, /^\/__pi_markdown_preview_live__\/p\?identity=/);
 live.push({ type: "assistant", uuid: "f", message: { role: "assistant", id: "m1", content: [{ type: "text", text: "Done" }], stop_reason: "end_turn" } }, 2);
 const revision = server.updateDocument(html, { appendToHistory: true, responseKey: "claude:m1" });
 const updates = await json(`${current.liveHref.replace("?", "/updates?")}&cursor=`);
 assert.equal(updates.status, "completed");
 assert.match(updates.completedHref, new RegExp(`^/\\?revision=${revision}&identity=`));
 live.push({ type: "user", uuid: "p2", message: { role: "user", content: "Next" } }, 3);
 const later = await json(`${current.liveHref.replace("?", "/updates?")}&cursor=`);
 assert.equal(later.newerAnchor, "p2"); assert.match(later.newerHref, /\/__pi_markdown_preview_live__\/p2\?/);
 // The live page's toggle knows its anchor.
 const livePage = await (await fetch(new URL(current.liveHref, session.origin), { headers: { cookie: session.cookie } })).text();
 assert.match(livePage, /data-view="live"[^>]*data-anchor="p"/);
});

test("Follow activity browser view: Live when a turn starts, back to its Preview when it finishes, only when it owns the page", { timeout: 120_000 }, async t => {
 if (!process.env.PUPPETEER_EXECUTABLE_PATH) { t.skip("Set PUPPETEER_EXECUTABLE_PATH to a dedicated headless browser"); return; }
 const { default: puppeteer } = await import("puppeteer-core");
 const dir = await temp(t);
 const live = createLiveTurnProjector();
 const server = await createBrowserWatchServer(html, dir, { live: { current: async () => live.current(), snapshot: async a => live.snapshot(a) } });
 t.after(() => server.close());
 const user = (uuid, text) => live.push({ type: "user", uuid, message: { role: "user", content: text } }, Date.now());
 const work = (uuid, id, tall = false) => {
  live.push({ type: "assistant", uuid: `${uuid}-c`, message: { role: "assistant", id: `${id}-c`, content: [{ type: "tool_use", id: `${uuid}-k`, name: "Bash", input: { command: "ls" } }], stop_reason: "tool_use" } }, Date.now());
  live.push({ type: "user", uuid: `${uuid}-r`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `${uuid}-k`, content: tall ? "line\n".repeat(400) : "ok" }] } }, Date.now());
 };
 const done = (uuid, id, text) => {
  live.push({ type: "assistant", uuid, message: { role: "assistant", id, content: [{ type: "text", text }], stop_reason: "end_turn" } }, Date.now());
  return server.updateDocument(html.replace("Answer", text), { appendToHistory: true, responseKey: `claude:${id}`, turnDetails: async () => ({ events: [] }) });
 };
 const finish = (uuid, id, text) => { work(uuid, id); return done(uuid, id, text); };
 const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true, args: ["--no-sandbox"] });
 try {
  const page = await browser.newPage(); await page.setViewport({ width: 900, height: 700 });
  await page.goto(server.url);
  const heading = () => page.$eval("h1, main p", e => e.textContent).catch(() => "");
  const onLive = () => page.waitForFunction(() => document.querySelector("h1")?.textContent === "Working · live", { timeout: 15_000 });
  const onPreview = text => page.waitForFunction(t => location.pathname === "/" && document.body.textContent.includes(t), { timeout: 15_000 }, text);
  // Off by default; turning it on is remembered for this preview address.
  await page.$eval('[data-watch-control="follow-activity"]', e => e.click());
  assert.equal(await page.$eval('[data-watch-control="follow-activity"]', e => `${e.textContent}|${e.getAttribute("aria-pressed")}|${e.hidden}`), "Follow activity: On|true|false");
  assert.equal(await page.$eval('[data-watch-control="follow-activity"]', e => getComputedStyle(e).backgroundColor === getComputedStyle(document.querySelector('[data-watch-control="preview"][aria-current="page"]')).backgroundColor), true, "on looks like the current view tab");
  assert.equal(await page.evaluate(() => localStorage.getItem("pi-markdown-preview:follow-activity")), "on");
  user("p1", "First");
  await onLive();
  assert.match(page.url(), /\/__pi_markdown_preview_live__\/p1\?/);
  finish("f1", "m1", "First done");
  await onPreview("First done");
  // The next turn is followed too.
  user("p2", "Second");
  await onLive();
  // A paused reader (scrolled up) is not moved until back at the bottom.
  work("f2", "m2", true);
  await page.waitForFunction(() => document.querySelectorAll(".live-events > details.event").length >= 3, { timeout: 10_000 });
  await page.$$eval(".live-events > details.event.result", cards => cards.forEach(c => { c.open = true; }));
  await page.evaluate(() => window.scrollTo(0, 0));
  done("f2", "m2", "Second done");
  await page.waitForFunction(() => /Open its response/.test(document.querySelector("[data-live-status]")?.textContent ?? ""), { timeout: 10_000 });
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.match(page.url(), /\/__pi_markdown_preview_live__\/p2\?/, "a reader scrolled up stays on Live");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await onPreview("Second done");
  // Leaving live Working yourself (Ctrl+Alt+P) is respected for the rest of that turn.
  user("p2b", "Side question");
  await onLive();
  await Promise.all([page.waitForNavigation(), (async () => { await page.keyboard.down("Control"); await page.keyboard.down("Alt"); await page.keyboard.press("KeyP"); await page.keyboard.up("Alt"); await page.keyboard.up("Control"); })()]);
  await new Promise(resolve => setTimeout(resolve, 3500));
  assert.equal(new URL(page.url()).pathname, "/", "following does not pull the reader back during that turn");
  assert.match(await page.$eval('[data-watch-control="turn-details"]', e => e.getAttribute("href")), /\/__pi_markdown_preview_live__\/p2b\?/, "Working still leads to the live turn");
  finish("f2b", "m2b", "Side done");
  await onPreview("Side done");
  // The next turn is followed again.
  user("p2c", "Back to work");
  await onLive();
  finish("f2c", "m2c", "Work done");
  await onPreview("Work done");
  // Off: a new turn moves nothing and Working stays the finished response's fixed view.
  const toggleKeys = async () => { await page.keyboard.down("Control"); await page.keyboard.down("Alt"); await page.keyboard.press("KeyA"); await page.keyboard.up("Alt"); await page.keyboard.up("Control"); };
  await toggleKeys();
  assert.equal(await page.$eval('[data-watch-control="follow-activity"]', e => `${e.textContent}|${e.getAttribute("aria-pressed")}`), "Follow activity: Off|false");
  user("p3", "Third");
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.equal(new URL(page.url()).pathname, "/", "with Follow activity off, a new turn does not move the page");
  assert.match(await page.$eval('[data-watch-control="turn-details"]', e => e.getAttribute("href")), /^\/__pi_markdown_preview_turn__\//, "Working is fixed while off");
  // An older response's Working stays fixed even while following.
  await page.goto(new URL("/?revision=1", server.url).href);
  await toggleKeys();
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.equal(new URL(page.url()).searchParams.get("revision"), "1", "an older response is never moved");
  // On the latest response, following opens the running turn as live Working.
  await Promise.all([page.waitForNavigation(), page.click('[data-watch-control="latest"]', { delay: 10 }).catch(() => page.goto(new URL("/", server.url).href))]);
  await onLive();
  assert.match(page.url(), /\/__pi_markdown_preview_live__\/p3\?/);
  assert.equal(await page.$eval('[data-watch-control="turn-details"]', e => e.getAttribute("aria-current")), "page");
  // Turning it off on the live page stays put at completion.
  await toggleKeys();
  finish("f3", "m3", "Third done");
  await page.waitForFunction(() => document.querySelector("[data-live-status] a")?.textContent === "Open its response", { timeout: 10_000 });
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.match(page.url(), /\/__pi_markdown_preview_live__\/p3\?/, "with following turned off, the live page stays put");
 } finally { await browser.close(); }
});

test("Live browser view: a paused reader keeps their cards across a resync; selected or focused cards are not removed or rewritten", { timeout: 120_000 }, async t => {
 if (!process.env.PUPPETEER_EXECUTABLE_PATH) { t.skip("Set PUPPETEER_EXECUTABLE_PATH to a dedicated headless browser"); return; }
 const { default: puppeteer } = await import("puppeteer-core");
 const dir = await temp(t);
 // The host can recreate its projection (a new generation), as after a lease expiry.
 let live = createLiveTurnProjector();
 const rows = [];
 const push = record => { rows.push(record); live.push(record, Date.now()); };
 const regenerate = () => { live = createLiveTurnProjector(); for (const record of rows) live.push(record, Date.now()); };
 const server = await createBrowserWatchServer(html, dir, { live: { current: async () => live.current(), snapshot: async a => live.snapshot(a) } });
 t.after(() => server.close());
 const text = i => push({ type: "assistant", uuid: `a${i}`, message: { role: "assistant", id: `m${i}`, content: [{ type: "text", text: `Synthetic ${i}` }] } });
 push({ type: "user", uuid: "p", message: { role: "user", content: "Synthetic prompt" } });
 for (let i = 0; i < LIVE_EVENT_WINDOW - 1; i++) text(i);
 const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true, args: ["--no-sandbox"] });
 try {
  const page = await browser.newPage(); await page.setViewport({ width: 900, height: 700 });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(server.url);
  await page.goto(new URL(liveEntry(await page.content()), server.url).href);
  assert.match(await page.$eval("main", e => e.innerText), /Read-only view; some conversation content may be missing or shortened\./);
  const count = () => page.$$eval(".live-events > details.event", cards => cards.length);
  // Pi's selection_eviction: text selected in the first card, reader at the bottom, window advances.
  const before = await page.evaluate(() => {
   window.firstCard = document.querySelector(".live-events > details");
   const range = document.createRange(); range.selectNodeContents(firstCard.querySelector("summary"));
   getSelection().removeAllRanges(); getSelection().addRange(range);
   window.scrollTo(0, document.documentElement.scrollHeight);
   return getSelection().toString();
  });
  for (let i = 249; i < 259; i++) text(i);
  await page.waitForSelector('[data-event-id="a258:0"]', { timeout: 10_000 });
  assert.deepEqual(await page.evaluate(() => [getSelection().toString(), firstCard.isConnected]), [before, true], "the selected card stays while selected");
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.waitForFunction(() => !firstCard.isConnected, { timeout: 5000 });
  assert.equal(await count(), LIVE_EVENT_WINDOW, "once released, it leaves like any card outside the window");

  // Pi's paused_resync: scrolled up when the generation changes and the window moves on.
  await page.evaluate(() => { window.firstCard = document.querySelector(".live-events > details"); window.scrollTo(0, 0); });
  for (let i = 259; i < 269; i++) text(i);
  regenerate();
  await page.waitForFunction(() => !document.querySelector(".live-newer").hidden, { timeout: 10_000 });
  const paused = await page.evaluate(() => ({ connected: firstCard.isConnected, first: document.querySelector(".live-events > details").dataset.eventId, newer: document.querySelector(".live-newer").textContent, y: scrollY }));
  assert.deepEqual(paused, { connected: true, first: paused.first, newer: "10 newer events ↓", y: 0 });
  assert.equal(paused.first, await page.evaluate(() => firstCard.dataset.eventId));
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.equal(await page.evaluate(() => firstCard.isConnected && scrollY === 0), true, "later polls keep holding the resync");
  await page.click(".live-newer");
  await page.waitForSelector('[data-event-id="a268:0"]', { timeout: 5000 });
  assert.equal(await page.evaluate(() => firstCard.isConnected), false);
  assert.equal(await count(), LIVE_EVENT_WINDOW);

  // A card whose content changes (a call's result arrives) is not rewritten under the reader's focus.
  push({ type: "assistant", uuid: "call", message: { role: "assistant", id: "mc", content: [{ type: "tool_use", id: "k", name: "Bash", input: { command: "sleep 1" } }], stop_reason: "tool_use" } });
  await page.waitForSelector('[data-event-id="call:0"]', { timeout: 10_000 });
  await page.evaluate(() => { window.focusedSummary = document.querySelector('[data-event-id="call:0"] > summary'); focusedSummary.focus(); });
  push({ type: "user", uuid: "res", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "k", content: "done" }] } });
  await page.waitForSelector('[data-event-id="res:0"]', { timeout: 10_000 });
  assert.deepEqual(await page.evaluate(() => [document.activeElement === focusedSummary, focusedSummary.isConnected, /No result recorded yet/.test(focusedSummary.textContent)]), [true, true, true]);
  await page.evaluate(() => focusedSummary.blur());
  await page.waitForFunction(() => !/No result recorded yet/.test(document.querySelector('[data-event-id="call:0"] > summary').textContent), { timeout: 5000 });
  assert.deepEqual(errors, []);
 } finally { await browser.close(); }
});

test("Follow activity: Working that becomes older stays fixed; a scrolled-up reader is not moved; one bounded request at a time", { timeout: 150_000 }, async t => {
 if (!process.env.PUPPETEER_EXECUTABLE_PATH) { t.skip("Set PUPPETEER_EXECUTABLE_PATH to a dedicated headless browser"); return; }
 const { default: puppeteer } = await import("puppeteer-core");
 const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true, args: ["--no-sandbox"] });
 const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
 const user = (uuid, content) => ({ type: "user", uuid, message: { role: "user", content } });
 const reply = (uuid, text, stop_reason = null) => ({ type: "assistant", uuid, message: { role: "assistant", id: `m-${uuid}`, content: [{ type: "text", text }], stop_reason } });
 const run = async fn => {
  const dir = await temp(t);
  const live = createLiveTurnProjector();
  const server = await createBrowserWatchServer(html, dir, { live: { current: async () => live.current(), snapshot: async a => live.snapshot(a) }, initialTurnDetails: async () => ({ events: [] }), initialResponseKey: "initial" });
  const context = await browser.createBrowserContext();
  try {
   const page = await context.newPage(); await page.setViewport({ width: 900, height: 700 });
   await fn({ page, server, push: record => live.push(record, Date.now()) });
  } finally { await context.close(); await server.close(); }
 };
 try {
  // Pi's working_becomes_historical: Working of the latest response, following on; a short turn
  // completes between polls, so this Working becomes 1/2; the next turn must not take it over.
  await run(async ({ page, server, push }) => {
   push(user("p0", "Original prompt")); push(reply("f0", "Original completed", "end_turn"));
   await page.goto(server.url);
   await Promise.all([page.waitForNavigation(), page.click('[data-watch-control="turn-details"]')]);
   await page.click('[data-watch-control="follow-activity"]');
   const fixed = await page.$eval('[data-watch-control="turn-details"]', e => e.getAttribute("href"));
   push(user("p1", "Short next turn")); push(reply("f1", "Short turn completed", "end_turn"));
   server.updateDocument(html, { responseKey: "claude:m-f1", turnDetails: async () => ({ events: [] }) });
   await page.waitForFunction(() => document.querySelector('[data-watch-control="count"]').textContent === "1/2", { timeout: 5000 });
   assert.equal(await page.$eval('[data-watch-control="follow-activity"]', e => e.dataset.latest), "false");
   const path = new URL(page.url()).pathname;
   push(user("p2", "Next long turn"));
   await sleep(4500);
   assert.equal(new URL(page.url()).pathname, path, "older Working is never moved to a live turn");
   assert.equal(await page.$eval('[data-watch-control="turn-details"]', e => e.getAttribute("href")), fixed, "and its Working stays the fixed view");
  });
  // Pi's paused_next_turn: an owned live page, scrolled up, when the next turn starts.
  await run(async ({ page, server, push }) => {
   push(user("p", "Synthetic prompt"));
   for (let i = 0; i < 80; i++) push(reply(`a${i}`, `Synthetic ${i}`));
   await page.goto(server.url);
   await page.goto(new URL(liveEntry(await page.content()), server.url).href);
   await page.click('[data-watch-control="follow-activity"]');
   await page.evaluate(() => window.scrollTo(0, 0));
   push(reply("final", "Synthetic end", "end_turn")); push(user("p2", "Synthetic next turn"));
   await page.waitForFunction(() => /A newer turn has started/.test(document.querySelector("[data-live-status]").textContent), { timeout: 10_000 });
   await sleep(2500);
   assert.match(new URL(page.url()).pathname, /\/p$/, "a scrolled-up reader stays on their turn");
   await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
   await page.waitForFunction(() => location.pathname.endsWith("/p2"), { timeout: 10_000 });
  });
  // Pi's follow_request_overlap, plus recovery from a request that never answers.
  await run(async ({ page, server }) => {
   await page.goto(server.url);
   const pending = new Set(); let most = 0; const seen = []; let hold = true;
   await page.setRequestInterception(true);
   page.on("request", request => {
    if (!request.url().includes("/__pi_markdown_preview_live__/") || !request.url().includes("format=json")) { request.continue().catch(() => {}); return; }
    seen.push(Date.now()); pending.add(request); most = Math.max(most, pending.size);
    if (!hold) request.continue().catch(() => {});
   });
   const done = request => pending.delete(request);
   page.on("requestfailed", done); page.on("requestfinished", done);
   await page.click('[data-watch-control="follow-activity"]');
   await sleep(100);
   await page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); document.dispatchEvent(new Event("visibilitychange")); });
   await sleep(300);
   assert.equal(most, 1, "visibility events do not start overlapping requests");
   // Turning following off and on cancels the held request instead of adding to it.
   await page.keyboard.down("Control"); await page.keyboard.down("Alt"); await page.keyboard.press("KeyA"); await page.keyboard.press("KeyA"); await page.keyboard.up("Alt"); await page.keyboard.up("Control");
   await sleep(300);
   assert.equal(most, 1);
   assert.equal(seen.length, 2, "one request per enable");
   // The held request reaches its deadline; polling recovers on its own.
   hold = false;
   await page.waitForFunction(() => true);
   const started = seen.length;
   await sleep(14_000);
   assert.ok(seen.length > started, "a request with no answer is abandoned and polling continues");
   assert.equal(most, 1);
  });
 } finally { await browser.close(); }
});

test("Live browser view: a remembered Expand all opens the live cards, including ones that arrive later", { timeout: 60_000 }, async t => {
 if (!process.env.PUPPETEER_EXECUTABLE_PATH) { t.skip("Set PUPPETEER_EXECUTABLE_PATH to a dedicated headless browser"); return; }
 const { default: puppeteer } = await import("puppeteer-core");
 const dir = await temp(t);
 const live = createLiveTurnProjector();
 const server = await createBrowserWatchServer(html, dir, { live: { current: async () => live.current(), snapshot: async a => live.snapshot(a) } });
 t.after(() => server.close());
 live.push(user("p", "Go"), Date.now());
 live.push(call("c1", "m1", "k1", "Bash", { command: "ls" }), Date.now());
 const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true, args: ["--no-sandbox"] });
 try {
  const page = await browser.newPage();
  await page.goto(server.url);
  const entry = new URL(liveEntry(await page.content()), server.url).href;
  await page.goto(entry);
  assert.deepEqual(await page.$$eval(".live-events > details.event", cards => cards.map(c => c.open)), [true, false], "the default without a remembered choice");
  await page.click(".working-bulk");
  await page.goto(entry);
  assert.deepEqual(await page.$$eval(".live-events > details.event", cards => cards.map(c => c.open)), [true, true]);
  live.push(result("r1", "k1", "file.txt"), Date.now());
  await page.waitForSelector('[data-event-id="r1:0"]', { timeout: 10_000 });
  assert.equal(await page.$eval('[data-event-id="r1:0"]', card => card.open), true, "an arriving card starts open");
  assert.equal(await page.$eval(".working-bulk", e => e.textContent), "Collapse all");
 } finally { await browser.close(); }
});
