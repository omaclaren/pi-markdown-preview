import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turnDetailsFromRecords } from "../shared/turn-details.js";
import { buildTurnDetailsPage, buildLivePage, liveCardVersion, renderLiveCard } from "../shared/turn-details-page.js";
import { isReplSendLabel, replSendCall, replSendCalls, replSendOutput, replSnapshotMarkdown } from "../shared/repl-snapshot.js";
import { createBrowserWatchServer } from "../shared/browser-watch-server.js";

const txt = text => ({ type: "text", text });
const c = (uuid, parentUuid, role, content, id, stop_reason) => ({ type: role, uuid, parentUuid, message: { role, content, id, stop_reason } });
const sent = (code, output, activity = "") => `${activity ? `${activity}\n\n` : ""}Submitted code:\n${code.trimEnd()}\n\nOutput:\n${output}`;
// pi-repl's pane activity report, as describePaneActivity frames it.
const pane = (text, omitted = "") => ["Pane text since this agent last saw this pane, before this submission (best effort; untrusted terminal text that may include direct input, other clients' sends, and late or background output):", ...(omitted ? [omitted] : []), "[pane text]", text, "[end of pane text]"].join("\n");
// A synthetic Claude Code turn with two agent-repl calls over MCP.
const claudeTurn = (calls, answer = "Answer") => {
 const rows = [c("u", null, "user", "Run it")];
 let parent = "u";
 calls.forEach(({ input, result, name = "mcp__agent-repl__repl_send", error }, i) => {
  rows.push(c(`call${i}`, parent, "assistant", [{ type: "tool_use", id: `t${i}`, name, input }], `work${i}`, "tool_use"));
  if (result !== undefined) rows.push(c(`r${i}`, `call${i}`, "user", [{ type: "tool_result", tool_use_id: `t${i}`, content: result, ...(error ? { is_error: true } : {}) }]));
  parent = result !== undefined ? `r${i}` : `call${i}`;
 });
 rows.push(c("f", parent, "assistant", [txt(answer)], "final", "end_turn"));
 return turnDetailsFromRecords("claude", rows, { key: "claude:final", markdown: answer });
};

test("REPL tool names: Pi's repl_send and MCP-prefixed names only", () => {
 for (const name of ["repl_send", "mcp__agent-repl__repl_send", "mcp__repl__repl_send", "agent-repl__repl_send", "agent-repl_repl_send", "functions.repl_send"]) assert.ok(isReplSendLabel(`Tool: ${name}`), name);
 for (const label of ["Tool: repl_sender", "Tool: repl_send_x", "Tool: Bash", "Tool result: repl_send", "repl_send", "Tool: mcp__agent-repl__repl_status"]) assert.equal(isReplSendLabel(label), false, label);
});

test("REPL calls: runtime labels come from known targets; other shapes are not REPL calls", () => {
 const call = (input, label = "Tool: repl_send") => replSendCall(label, JSON.stringify(input));
 assert.deepEqual({ ...call({ code: "1" }), args: undefined }, { args: undefined, code: "1", label: "Python", language: "python" }, "An omitted target is the shared Python session.");
 assert.equal(call({ code: "1", target: "  " }).label, "Python", "So is a blank one, as pi-repl reads it.");
 assert.equal(call({ code: "1", target: "ipython" }).label, "Python", "ipython selects the same session, which may run either.");
 assert.equal(call({ code: "1", target: " Julia " }).label, "Julia");
 assert.equal(call({ code: "1", target: "clj" }).language, "clojure");
 for (const [target, label, language] of [["ghci", "Haskell", "haskell"], ["haskell", "Haskell", "haskell"], ["irb", "Ruby", "ruby"], ["jshell", "Java", "java"], ["cpp", "C++", "cpp"]]) {
  assert.deepEqual([call({ code: "1", target }).label, call({ code: "1", target }).language], [label, language], target);
 }
 const unknown = call({ code: "1", target: "fortran" });
 assert.equal(unknown.label, undefined); assert.equal(unknown.language, undefined);
 assert.equal(call({ code: 1 }), null);
 assert.equal(call({ code: "1", target: 2 }), null);
 assert.equal(call(["code"]), null);
 assert.equal(replSendCall("Tool: repl_send", "{not json"), null);
 assert.equal(call({ code: "1" }, "Tool: Bash"), null);
});

test("REPL results: output is split only when the recorded text is exactly pi-repl's format for the call's code", () => {
 assert.deepEqual(replSendOutput(sent("print(2)", "2\n"), "print(2)"), { activity: "", output: "2\n" });
 assert.deepEqual(replSendOutput(sent("x = 1\n", "(no output)"), "x = 1\n"), { activity: "", output: "(no output)" }, "Trailing whitespace of the code is trimmed, as pi-repl does.");
 const tricky = "s = '''\n\nOutput:\nnot this'''\nprint(s)";
 assert.deepEqual(replSendOutput(sent(tricky, "real"), tricky), { activity: "", output: "real" }, "Code containing the separator is matched whole.");
 assert.deepEqual(replSendOutput(sent("1", "Submitted code:\n1\n\nOutput:\nx"), "1"), { activity: "", output: "Submitted code:\n1\n\nOutput:\nx" }, "Without pane activity the header is at the start, so output can repeat it.");
 assert.equal(replSendOutput(sent("print(2)", "2"), "print(3)"), null);
 assert.equal(replSendOutput(`note\n${sent("1", "1")}`, "1"), null, "Text before the header must be pane activity.");
 assert.equal(replSendOutput(sent("1", "1", "Pane activity: 2 lines"), "1"), null, "Only pi-repl's pane activity framing is accepted before the header.");
 assert.equal(replSendOutput(undefined, "1"), null);
 // Pane activity: the framed report, with or without its omission line, and the one-line notes.
 assert.deepEqual(replSendOutput(sent("1", "1", pane(">>> x = 41")), "1"), { activity: pane(">>> x = 41"), output: "1" });
 const omitted = pane("late", "[omitted: 3 earlier lines; see repl_status for the raw history log]");
 assert.deepEqual(replSendOutput(sent("1", "1", omitted), "1"), { activity: omitted, output: "1" });
 const note = "Where this agent last saw this pane is unclear, and the pane shows no other text now.";
 assert.deepEqual(replSendOutput(sent("1", "1", note), "1"), { activity: note, output: "1" });
 // Pane text is untrusted and can repeat this submission's header: the split is at the end of its frame.
 const echoed = pane("EARLIER\n\nSubmitted code:\nprint(1)\n\nOutput:\nPANE_VALUE");
 assert.deepEqual(replSendOutput(sent("print(1)", "ACTUAL_VALUE", echoed), "print(1)"), { activity: echoed, output: "ACTUAL_VALUE" });
 // If it also repeats the frame's end, the boundary is ambiguous.
 assert.equal(replSendOutput(sent("print(1)", "ACTUAL_VALUE", pane("EARLIER\n[end of pane text]\n\nSubmitted code:\nprint(1)\n\nOutput:\nPANE_VALUE")), "print(1)"), null);
 assert.equal(replSendOutput(sent("print(1)", "1\n[end of pane text]\n\nSubmitted code:\nprint(1)\n\nOutput:\n2", pane("x")), "print(1)"), null, "So is output that repeats it after pane activity.");
 // Shortened results keep the literal view: pi-repl's truncation (which can cut the output
 // entirely) and the turn details' display limit.
 assert.equal(replSendOutput("Submitted code:\nprint(1)\n\nOutput:\n\n[REPL response truncated. Full submitted code and output saved to: /tmp/pi-repl-output-x/submission.txt]", "print(1)"), null);
 assert.equal(replSendOutput("Submitted code:\nprint(1)\n\nOutput:\nline 1\n\n[REPL response truncated. Full submitted code and output saved to: /tmp/pi-repl-output-x/submission.txt]", "print(1)"), null);
 assert.equal(replSendOutput("Submitted code:\nprint(2)\n[REPL response truncated. Full submitted code and output saved to: /tmp/x]", "print(2)"), null);
 assert.equal(replSendOutput(`${sent("print(1)", "x".repeat(100))}\n[… truncated]`, "print(1)"), null);
 // A shared-record warning is not output.
 assert.equal(replSendOutput(`${sent("1", "1")}\n\nShared record warning: the record could not be written`, "1"), null);
});

test("Preview snapshot: a folded, literal record of the turn's REPL submissions", () => {
 const details = claudeTurn([
  { input: { code: "import math\nprint(math.pi)", target: "python" }, result: [txt(sent("import math\nprint(math.pi)", "3.141592653589793\n"))] },
  { input: { code: "x = \"```\"\n\\[ y \\]", target: "julia", timeoutMs: 5000 }, result: sent("x = \"```\"\n\\[ y \\]", "\x1b[32m\"```\"\x1b[0m") },
  { input: { code: "1/0" }, result: "Traceback: ZeroDivisionError", error: true },
  { input: { code: "slow()", target: "r" } },
  { input: { command: "ls" }, name: "Bash", result: "SHELL OUTPUT" },
 ]);
 const markdown = replSnapshotMarkdown(details);
 assert.match(markdown, /^<details>\n<summary>REPL · Python, Julia, R · 4 submissions in this turn<\/summary>\n/);
 assert.match(markdown, /\*Recorded in this response's turn; not the REPL's current state\.\*\n\n\*\*1\*\*/);
 assert.doesNotMatch(markdown, /missing or shortened/);
 assert.match(markdown, /\*\*1\*\* · Python\n\n```python\nimport math\nprint\(math\.pi\)\n```\n\nOutput\n\n```\n3\.141592653589793\n```/);
 assert.match(markdown, /\*\*2\*\* · Julia\n\n````julia\nx = "```"\n\\\[ y \\\]\n````\n\nOutput\n\n````\n"```"\n````/, "Fences outgrow backtick runs; terminal colours are removed.");
 assert.match(markdown, /\*\*3\*\* · Python\n\n```python\n1\/0\n```\n\nRecorded result \(error\)\n\n```\nTraceback: ZeroDivisionError\n```/);
 assert.match(markdown, /\*\*4\*\* · R\n\n```r\nslow\(\)\n```\n\n\*No result recorded\.\*/);
 assert.doesNotMatch(markdown, /SHELL OUTPUT|timeoutMs/);
 assert.match(markdown, /\n<\/details>$/);
 assert.equal(replSnapshotMarkdown(claudeTurn([{ input: { command: "ls" }, name: "Bash", result: "x" }])), "", "No REPL calls, no snapshot.");
 assert.equal(replSnapshotMarkdown(undefined), "");
});

test("Preview snapshot: an unrecognised target is labelled as such, and long turns point to Working", () => {
 const unknown = replSnapshotMarkdown(claudeTurn([{ input: { code: "print *, 1", target: "fortran" }, result: sent("print *, 1", "1") }]));
 assert.match(unknown, /<summary>REPL · REPL · 1 submission in this turn<\/summary>/);
 assert.match(unknown, /\*\*1\*\* · Unrecognised target\n\n```\nprint \*, 1\n```/);
 const many = replSnapshotMarkdown(claudeTurn(Array.from({ length: 23 }, (_, i) => ({ input: { code: `${i}` }, result: sent(`${i}`, `${i}`) }))));
 assert.match(many, /23 submissions in this turn/);
 assert.match(many, /\*\*20\*\* · Python/);
 assert.doesNotMatch(many, /\*\*21\*\*/);
 assert.match(many, /\*3 more in Working\.\*/);
});

test("Preview snapshot: when the turn details are bounded, it says so instead of claiming a complete record", () => {
 // The 250-event limit drops this call's result.
 const rows = [c("u", null, "user", "Run it")];
 let parent = "u";
 for (let i = 0; i < 248; i++) { rows.push(c(`p${i}`, parent, "assistant", [txt(`step ${i}`)], `work${i}`, null)); parent = `p${i}`; }
 rows.push(c("call", parent, "assistant", [{ type: "tool_use", id: "t", name: "mcp__agent-repl__repl_send", input: { code: "print(1)" } }], "workc", "tool_use"));
 rows.push(c("r", "call", "user", [{ type: "tool_result", tool_use_id: "t", content: sent("print(1)", "1") }]));
 rows.push(c("f", "r", "assistant", [txt("Answer")], "final", "end_turn"));
 const details = turnDetailsFromRecords("claude", rows, { key: "claude:final", markdown: "Answer" });
 assert.ok(details.notices.some(n => /some recorded events are omitted/.test(n)));
 const markdown = replSnapshotMarkdown(details);
 assert.match(markdown, /<summary>REPL · Python · 1 submission shown from this turn<\/summary>/);
 assert.match(markdown, /\*Some of this turn's recorded activity is missing or shortened here, so submissions or results may be missing\. Working shows what is available\.\*/);
 assert.match(markdown, /\*No result in the recorded activity shown\.\*/);
 assert.doesNotMatch(markdown, /No result recorded/);
 // Arguments shortened by the display limit no longer parse: the call is counted, not dropped.
 const long = claudeTurn([{ input: { code: "x".repeat(20_000) }, result: "done" }, { input: { code: "2" }, result: sent("2", "2") }]);
 const counted = replSnapshotMarkdown(long);
 assert.match(counted, /2 submissions shown from this turn/);
 assert.match(counted, /\*\*1\*\* · \*Its recorded arguments can't be read here; see Working\.\*\n\n\*\*2\*\* · Python/);
});

test("Working: a REPL call shows its runtime and code; its result shows only the output", () => {
 const details = claudeTurn([
  { input: { code: "print('<b>hi</b>')", target: "python", echoMode: "off" }, result: sent("print('<b>hi</b>')", "<b>hi</b>\n", pane("typed directly")) },
  { input: { code: "2 + 2", target: "julia" }, result: "Session not running", error: true },
 ]);
 const page = buildTurnDetailsPage({ ...details, sourceAgent: "claude" }, "/");
 assert.match(page, /<span class="field-label">Python REPL<\/span><\/div><pre class="code-input"><code>print\(&#39;&lt;b&gt;hi&lt;\/b&gt;&#39;\)<\/code><\/pre>/);
 assert.match(page, /<dt>echoMode<\/dt><dd><pre>off<\/pre><\/dd>/);
 assert.doesNotMatch(page, /<dt>target<\/dt>/, "A recognised target is the heading, not an option.");
 assert.match(page, /<p class="repl-activity">Pane text since this agent last saw this pane[^<]*\n\[pane text\]\ntyped directly\n\[end of pane text\]<\/p><section class="tool-field"><h3>Output<\/h3><pre><span>&lt;b&gt;hi&lt;\/b&gt;\n<\/span><\/pre><\/section>/);
 assert.match(page, /<summary>Raw output<\/summary><pre><span>Pane text since[^<]*\[end of pane text\]\n\nSubmitted code:/, "The exact recorded result stays available.");
 assert.match(page, /<span class="field-label">Julia REPL<\/span>/);
 assert.match(page, /Session not running/);
 assert.equal(page.match(/<h3>Output<\/h3>/g).length, 1, "An error result keeps the ordinary view.");
 assert.doesNotMatch(page, /<b>hi<\/b>/, "Recorded text stays inert.");
});

test("Live: REPL results show only the output when their call is in the snapshot", () => {
 const call = { kind: "tool", label: "Tool: repl_send", text: JSON.stringify({ code: "1 + 1" }), callId: "c1", id: "a:0", version: "v" };
 const result = { kind: "result", label: "Tool result: repl_send", text: sent("1 + 1", "2"), callId: "c1", id: "b:0", version: "w" };
 assert.match(renderLiveCard(call, 1, false), /Python REPL/);
 assert.match(renderLiveCard(result, 2, false, undefined, replSendCalls([call])), /<h3>Output<\/h3><pre><span>2<\/span><\/pre>/);
 assert.doesNotMatch(renderLiveCard(result, 2, false), /<h3>Output<\/h3>/, "Without its call, the result is shown as recorded.");
 const page = buildLivePage({ generation: "g", sequence: 1, updatedAt: 0, omitted: 0, sourceAgent: "pi", events: [call, result] });
 assert.match(page, /<h3>Output<\/h3><pre><span>2<\/span><\/pre>/);
 // The card's version covers what it shows from its call.
 const split = liveCardVersion(result, replSendCalls([call]));
 assert.match(split, /^w\.[a-z0-9]+$/);
 assert.equal(liveCardVersion(result), "w", "Without its call, the result's own version.");
 assert.equal(liveCardVersion(result, replSendCalls([{ ...call, text: JSON.stringify({ code: "1 + 2" }) }])), "w", "A call that no longer splits it.");
 assert.equal(liveCardVersion(call, replSendCalls([call])), "v");
 assert.match(page, new RegExp(`data-event-id="b:0" data-event-version="${split.replace(".", "\\.")}"`));
});

test("Live updates: a REPL result is sent again when its call changes or leaves the window, though the result did not", async t => {
 const dir = await mkdtemp(join(tmpdir(), "preview-repl-live-"));
 t.after(() => rm(dir, { recursive: true, force: true }));
 const call = code => ({ kind: "tool", label: "Tool: agent-repl_repl_send", text: JSON.stringify({ code }), callId: "c", id: "call", version: `v-${code}` });
 const result = { kind: "result", label: "Tool result: agent-repl_repl_send", text: sent("print(1)", "1"), callId: "c", id: "result", version: "r", changed: 1 };
 // As OpenCode's source does: a revised call carries the new sequence; the result keeps its own.
 let snapshot = { generation: "g", sequence: 1, updatedAt: 0, omitted: 0, sourceAgent: "opencode", status: "running", events: [{ ...call("print(1)"), changed: 1 }, result] };
 const server = await createBrowserWatchServer("<!doctype html><html><head><title>R</title></head><body><main id='preview-root'><p>Answer</p></main></body></html>", dir, { live: { current: async () => "a", snapshot: async () => snapshot } });
 t.after(() => server.close());
 const r = await fetch(server.url);
 const cookie = r.headers.get("set-cookie").split(";")[0];
 const query = (await r.text()).match(/data-live-state="([^"]+)"/)[1].replaceAll("&amp;", "&").replace(/&format=json$/, "").split("?")[1];
 const updates = async cursor => (await fetch(new URL(`/__pi_markdown_preview_live__/a/updates?${query}&cursor=${encodeURIComponent(cursor)}`, server.url), { headers: { cookie } })).json();
 const first = await updates("");
 const firstResult = first.upserts.find(u => u.id === "result");
 assert.match(firstResult.html, /<h3>Output<\/h3><pre><span>1<\/span>/);
 assert.match(firstResult.html, new RegExp(`data-event-version="${firstResult.version.replace(".", "\\.")}"`), "The update's version is the card's.");
 snapshot = { ...snapshot, sequence: 2, events: [{ ...call("print(2)"), changed: 2 }, result] };
 const revised = await updates(first.cursor);
 assert.deepEqual(revised.upserts.map(u => u.id), ["call", "result"]);
 const literal = revised.upserts[1];
 assert.notEqual(literal.version, firstResult.version);
 assert.doesNotMatch(literal.html, /<h3>Output<\/h3>/, "The revised call no longer matches, so the result is literal.");
 assert.equal((await updates(revised.cursor)).unchanged, true);
 // Back to print(1), then the call leaves the window.
 snapshot = { ...snapshot, sequence: 3, events: [{ ...call("print(1)"), changed: 3 }, result] };
 const back = await updates(revised.cursor);
 assert.equal(back.upserts.find(u => u.id === "result").version, firstResult.version);
 snapshot = { ...snapshot, sequence: 4, omitted: 1, events: [result] };
 const evicted = await updates(back.cursor);
 assert.deepEqual(evicted.upserts.map(u => u.id), ["result"]);
 assert.equal(evicted.upserts[0].version, "r");
 assert.doesNotMatch(evicted.upserts[0].html, /<h3>Output<\/h3>/);
 // A view that missed all of it still gets the result once, at its current form.
 assert.deepEqual((await updates(first.cursor)).upserts.map(u => [u.id, u.version]), [["result", "r"]]);
});
