import assert from "node:assert/strict";
import { test } from "node:test";
import { turnDetailsFromRecords } from "../shared/turn-details.js";
import { buildTurnDetailsPage, buildLivePage, renderLiveCard } from "../shared/turn-details-page.js";
import { isReplSendLabel, replSendCall, replSendCalls, replSendOutput, replSnapshotMarkdown } from "../shared/repl-snapshot.js";

const txt = text => ({ type: "text", text });
const c = (uuid, parentUuid, role, content, id, stop_reason) => ({ type: role, uuid, parentUuid, message: { role, content, id, stop_reason } });
const sent = (code, output, activity = "") => `${activity ? `${activity}\n\n` : ""}Submitted code:\n${code.trimEnd()}\n\nOutput:\n${output}`;
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
 assert.equal(call({ code: "1", target: " Julia " }).label, "Julia");
 assert.equal(call({ code: "1", target: "clj" }).language, "clojure");
 assert.equal(call({ code: "1", target: "ghci" }).language, "haskell");
 const unknown = call({ code: "1", target: "fortran" });
 assert.equal(unknown.label, undefined); assert.equal(unknown.language, undefined);
 assert.equal(call({ code: 1 }), null);
 assert.equal(call({ code: "1", target: 2 }), null);
 assert.equal(call(["code"]), null);
 assert.equal(replSendCall("Tool: repl_send", "{not json"), null);
 assert.equal(call({ code: "1" }, "Tool: Bash"), null);
});

test("REPL results: output is split only when the recorded text repeats the call's code exactly", () => {
 assert.deepEqual(replSendOutput(sent("print(2)", "2\n"), "print(2)"), { activity: "", output: "2\n" });
 assert.deepEqual(replSendOutput(sent("x = 1\n", "(no output)"), "x = 1\n"), { activity: "", output: "(no output)" }, "Trailing whitespace of the code is trimmed, as pi-repl does.");
 assert.deepEqual(replSendOutput(sent("1", "1", "Pane activity: 2 lines"), "1"), { activity: "Pane activity: 2 lines", output: "1" });
 const tricky = "s = '''\n\nOutput:\nnot this'''\nprint(s)";
 assert.deepEqual(replSendOutput(sent(tricky, "real"), tricky), { activity: "", output: "real" }, "Code containing the separator is matched whole.");
 assert.equal(replSendOutput(sent("print(2)", "2"), "print(3)"), null);
 assert.equal(replSendOutput("Submitted code:\nprint(2)\n[REPL response truncated. Full submitted code and output saved to: /tmp/x]", "print(2)"), null);
 assert.equal(replSendOutput(`note\n${sent("1", "1")}`, "1"), null, "Text before the header must end with a blank line.");
 assert.equal(replSendOutput(undefined, "1"), null);
});

test("Preview snapshot: a folded, literal record of the turn's REPL submissions", () => {
 const details = claudeTurn([
  { input: { code: "import math\nprint(math.pi)", target: "python" }, result: [txt(sent("import math\nprint(math.pi)", "3.141592653589793\n"))] },
  { input: { code: "x = \"```\"\n\\[ y \\]", target: "julia", timeoutMs: 5000 }, result: sent("x = \"```\"\n\\[ y \\]", "\x1b[32m\"```\"\x1b[0m") },
  { input: { code: "1/0" }, result: "Traceback: ZeroDivisionError", error: true },
  { input: { code: "slow()", target: "r" } },
  { input: { command: "ls" }, name: "Bash", result: "SHELL OUTPUT" },
 ]);
 const markdown = replSnapshotMarkdown(details.events);
 assert.match(markdown, /^<details>\n<summary>REPL · Python, Julia, R · 4 submissions in this turn<\/summary>\n/);
 assert.match(markdown, /\*Recorded when this response was written; not the REPL's current state\.\*/);
 assert.match(markdown, /\*\*1\*\* · Python\n\n```python\nimport math\nprint\(math\.pi\)\n```\n\nOutput\n\n```\n3\.141592653589793\n```/);
 assert.match(markdown, /\*\*2\*\* · Julia\n\n````julia\nx = "```"\n\\\[ y \\\]\n````\n\nOutput\n\n````\n"```"\n````/, "Fences outgrow backtick runs; terminal colours are removed.");
 assert.match(markdown, /\*\*3\*\* · Python\n\n```python\n1\/0\n```\n\nRecorded result \(error\)\n\n```\nTraceback: ZeroDivisionError\n```/);
 assert.match(markdown, /\*\*4\*\* · R\n\n```r\nslow\(\)\n```\n\n\*No result recorded\.\*/);
 assert.doesNotMatch(markdown, /SHELL OUTPUT|timeoutMs/);
 assert.match(markdown, /\n<\/details>$/);
 assert.equal(replSnapshotMarkdown(claudeTurn([{ input: { command: "ls" }, name: "Bash", result: "x" }]).events), "", "No REPL calls, no snapshot.");
 assert.equal(replSnapshotMarkdown(undefined), "");
});

test("Preview snapshot: an unrecognised target is labelled as such, and long turns point to Working", () => {
 const unknown = replSnapshotMarkdown(claudeTurn([{ input: { code: "print *, 1", target: "fortran" }, result: sent("print *, 1", "1") }]).events);
 assert.match(unknown, /<summary>REPL · REPL · 1 submission in this turn<\/summary>/);
 assert.match(unknown, /\*\*1\*\* · Unrecognised target\n\n```\nprint \*, 1\n```/);
 const many = replSnapshotMarkdown(claudeTurn(Array.from({ length: 23 }, (_, i) => ({ input: { code: `${i}` }, result: sent(`${i}`, `${i}`) }))).events);
 assert.match(many, /23 submissions in this turn/);
 assert.match(many, /\*\*20\*\* · Python/);
 assert.doesNotMatch(many, /\*\*21\*\*/);
 assert.match(many, /\*3 more in Working\.\*/);
});

test("Working: a REPL call shows its runtime and code; its result shows only the output", () => {
 const details = claudeTurn([
  { input: { code: "print('<b>hi</b>')", target: "python", echoMode: "off" }, result: sent("print('<b>hi</b>')", "<b>hi</b>\n", "Pane activity: typed directly") },
  { input: { code: "2 + 2", target: "julia" }, result: "Session not running", error: true },
 ]);
 const page = buildTurnDetailsPage({ ...details, sourceAgent: "claude" }, "/");
 assert.match(page, /<span class="field-label">Python REPL<\/span><\/div><pre class="code-input"><code>print\(&#39;&lt;b&gt;hi&lt;\/b&gt;&#39;\)<\/code><\/pre>/);
 assert.match(page, /<dt>echoMode<\/dt><dd><pre>off<\/pre><\/dd>/);
 assert.doesNotMatch(page, /<dt>target<\/dt>/, "A recognised target is the heading, not an option.");
 assert.match(page, /<p class="repl-activity">Pane activity: typed directly<\/p><section class="tool-field"><h3>Output<\/h3><pre><span>&lt;b&gt;hi&lt;\/b&gt;\n<\/span><\/pre><\/section>/);
 assert.match(page, /<summary>Raw output<\/summary><pre><span>Pane activity: typed directly\n\nSubmitted code:/, "The exact recorded result stays available.");
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
});
