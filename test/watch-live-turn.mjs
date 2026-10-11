import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiveTurnProjector, LIVE_EVENT_WINDOW } from "../shared/turn-details.js";
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
 // A call without a result has no result card until one is recorded.
 assert.equal(snapshot.events.filter(e => e.kind === "result").length, 0);
 const before = snapshot.sequence;
 live.push(result("r1", "call-1", "ok"), 3000);
 live.push(assistant("a1", "m2", [txt("All green.")]), 3000);
 snapshot = live.snapshot("p");
 assert.ok(snapshot.sequence > before);
 assert.deepEqual(labels(snapshot).slice(3), [["r1:0", "result", "Tool result: Bash"], ["a1:0", "progress", "Assistant progress"]]);
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

test("Live projection: local commands join the next turn; task notifications and interruptions bound turns", () => {
 const live = createLiveTurnProjector();
 live.push(user("cmd", "<command-name>/theme</command-name>\n<command-message>theme</command-message>\n<command-args></command-args>"), 1);
 live.push(user("out", "<local-command-stdout>Theme set to dark</local-command-stdout>"), 1);
 live.push(user("p", "Draft the exam"), 2);
 assert.equal(live.current(), "cmd", "context before the prompt belongs to the same turn");
 assert.deepEqual(live.snapshot("cmd").events.map(e => e.label), ["Prompt / input", "Command output", "Prompt / input"]);
 live.push(assistant("a", "m1", [txt("Working on it")]), 3);
 live.push(user("stop", "[Request interrupted by user]"), 4);
 assert.equal(live.snapshot("cmd").status, "interrupted");
 // A task notification starts the next turn.
 const notification = "<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>";
 live.push(user("tn", notification), 5);
 assert.equal(live.current(), "tn");
 assert.equal(live.snapshot("cmd").newerAnchor, "tn", "an older turn points to the newer one and never becomes it");
 live.push(assistant("err", "m3", [txt("API Error: overloaded")], "stop_sequence", { isApiErrorMessage: true }), 6);
 assert.equal(live.snapshot("tn").status, "error");
 // A third turn evicts the first: only the latest two are retained.
 live.push(user("p3", "Next"), 7);
 assert.equal(live.snapshot("cmd"), undefined);
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
 // A projector started mid-turn (backfill cut) still shows the activity it has.
 const late = createLiveTurnProjector();
 late.push(call("c2", "m9", "k2", "Bash", { command: "ls" }), 1);
 assert.equal(late.current(), "c2");
 assert.match(late.snapshot("c2").notices.join(" "), /prompt is not in the retained recorded activity/);
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

test("Live routes are opt-in, authenticated, lazy for HEAD, and serve a bounded live page", async t => {
 const dir = await temp(t);
 const plain = await createBrowserWatchServer(html, dir, { initialTurnDetails: async () => ({ events: [] }) });
 t.after(() => plain.close());
 const plainSession = await auth(plain);
 assert.doesNotMatch(plainSession.text, /<a data-watch-control="live"|<button data-watch-control="follow-activity"/, "no Live tab or Follow activity without the live option");
 assert.equal((await fetch(new URL("/__pi_markdown_preview_live__/?identity=x&instance=y", plainSession.origin), { headers: { cookie: plainSession.cookie } })).status, 404);

 const live = createLiveTurnProjector();
 let calls = 0;
 const provider = { current: async () => { calls++; return live.current(); }, snapshot: async anchor => { calls++; return live.snapshot(anchor); } };
 const server = await createBrowserWatchServer(html, dir, { live: provider, initialTurnDetails: async () => ({ events: [] }), initialResponseKey: "claude:old" });
 t.after(() => server.close());
 const session = await auth(server);
 const entry = attr(session.text, "live");
 assert.ok(entry?.startsWith("/__pi_markdown_preview_live__/?identity="), "the toolbar offers a Live view");
 assert.match(session.text, /<a data-watch-control="live" href="[^"]+" title="Live: the current turn's recorded activity \(Ctrl\+Alt\+L\)" aria-keyshortcuts="Control\+Alt\+L">Live<\/a>/);
 assert.doesNotMatch(session.text, /Follow current turn/);
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
 assert.match(page, /<h1>Live · recorded activity<\/h1>/);
 assert.match(page, /data-event-id="p1:0"/);
 assert.match(page, /Run &lt;checks&gt;/);
 assert.match(page, /<a data-watch-control="live" href="[^"]+" aria-current="page"[^>]*>Live<\/a>/);
 assert.match(page, /data-watch-control="copy-link" type="button" disabled/);
 assert.match(page, /script-src 'nonce-|<script nonce=/);
 assert.doesNotMatch(page, /<script>(?!\s*$)/, "every script carries the page nonce");
 assert.equal((await get(pageUrl.replace("/p1?", "/bad%20id?"))).status, 404);
 assert.equal((await get(pageUrl.replace("/p1?", "/gone?"))).status, 404);
});

test("Live updates: unchanged cursors, new cards only, resync, completion and newer turns", async t => {
 const dir = await temp(t);
 const live = createLiveTurnProjector();
 const server = await createBrowserWatchServer(html, dir, { live: { current: async () => live.current(), snapshot: async a => live.snapshot(a) } });
 t.after(() => server.close());
 const session = await auth(server);
 const query = attr(session.text, "live").split("?")[1];
 const updates = async (anchor, cursor) => {
  const r = await fetch(new URL(`/__pi_markdown_preview_live__/${anchor}/updates?${query}&cursor=${encodeURIComponent(cursor)}`, session.origin), { headers: { cookie: session.cookie } });
  return { status: r.status, type: r.headers.get("content-type"), cache: r.headers.get("cache-control"), body: await r.json() };
 };
 live.push({ type: "user", uuid: "p", message: { role: "user", content: "Go" } }, 1);
 live.push({ type: "assistant", uuid: "c", message: { role: "assistant", id: "m1", content: [{ type: "tool_use", id: "k", name: "Bash", input: { command: "ls" } }], stop_reason: "tool_use" } }, 2);
 let first = await updates("p", "");
 assert.equal(first.status, 200); assert.match(first.type, /application\/json/); assert.match(first.cache, /no-store/);
 assert.equal(first.body.resync, true);
 assert.deepEqual(first.body.ids, ["p:0", "c:0"]);
 assert.deepEqual(first.body.upserts.map(u => u.id), ["p:0", "c:0"]);
 assert.match(first.body.upserts[1].html, /^<details class="event tool" data-event-id="c:0"/);
 const same = await updates("p", first.body.cursor);
 assert.equal(same.body.unchanged, true); assert.equal(same.body.upserts, undefined);
 live.push({ type: "user", uuid: "r", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "k", content: "file.txt" }] } }, 3);
 const next = await updates("p", first.body.cursor);
 assert.equal(next.body.resync, false);
 assert.deepEqual(next.body.upserts.map(u => u.id), ["r:0"], "only the new card is rendered");
 assert.match(next.body.upserts[0].html, /Tool result: Bash/);
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
  await Promise.all([page.waitForNavigation(), (async () => { await page.keyboard.down("Control"); await page.keyboard.down("Alt"); await page.keyboard.press("KeyL"); await page.keyboard.up("Alt"); await page.keyboard.up("Control"); })()]);
  assert.equal(await page.$eval("h1", e => e.textContent), "Live · recorded activity", "Ctrl+Alt+L opens Live");
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
  return server.updateDocument(html.replace("Answer", text), { appendToHistory: true, responseKey: `claude:${id}` });
 };
 const finish = (uuid, id, text) => { work(uuid, id); return done(uuid, id, text); };
 const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true, args: ["--no-sandbox"] });
 try {
  const page = await browser.newPage(); await page.setViewport({ width: 900, height: 700 });
  await page.goto(server.url);
  const heading = () => page.$eval("h1, main p", e => e.textContent).catch(() => "");
  const onLive = () => page.waitForFunction(() => document.querySelector("h1")?.textContent === "Live · recorded activity", { timeout: 15_000 });
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
  // Ctrl+Alt+A turns it off: a turn opened by hand in Live is not left automatically.
  await page.keyboard.down("Control"); await page.keyboard.down("Alt"); await page.keyboard.press("KeyA"); await page.keyboard.up("Alt"); await page.keyboard.up("Control");
  assert.equal(await page.$eval('[data-watch-control="follow-activity"]', e => `${e.textContent}|${e.getAttribute("aria-pressed")}`), "Follow activity: Off|false");
  user("p3", "Third");
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.equal(new URL(page.url()).pathname, "/", "with Follow activity off, a new turn does not move the page");
  await page.$eval('[data-watch-control="live"]', e => e.click());
  await onLive();
  finish("f3", "m3", "Third done");
  await page.waitForFunction(() => document.querySelector("[data-live-status] a")?.textContent === "Open its response", { timeout: 10_000 });
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.match(page.url(), /\/__pi_markdown_preview_live__\/p3\?/, "Live opened by hand stays put at completion");
 } finally { await browser.close(); }
});
