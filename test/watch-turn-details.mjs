import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turnDetailsFromRecords, createTurnDetails, TURN_TOTAL_LIMIT, TURN_EVENT_LIMIT } from "../shared/turn-details.js";
import { readTurnDetails, TURN_RECORD_BYTES, TURN_READ_BYTES } from "../shared/read-turn-details.js";
import { buildTurnDetailsPage } from "../shared/turn-details-page.js";
import { createBrowserWatchServer } from "../shared/browser-watch-server.js";
import { createClaudeResponseAssembler } from "../shared/claude-response.js";

const p = (id, parentId, role, content, stopReason) => ({ type: "message", id, parentId, message: { role, content, stopReason } });
const txt = text => ({ type: "text", text });
const final = (id, parent, answer = "Answer") => p(id, parent, "assistant", [txt(answer)], "stop");
const target = { key: "pi:f", markdown: "Answer" };
const body = result => result.events.map(e => e.text).join("\n");
const html = "<!doctype html><html><head><title>Response</title></head><body><main id='preview-root'><h1>Answer</h1><p>Response text.</p></main></body></html>";
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), "preview-turn-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function auth(server, revision) {
 const url = new URL(server.url); if (revision) url.searchParams.set("revision", revision);
 const r = await fetch(url); assert.equal(r.status, 200);
 return { text: await r.text(), cookie: r.headers.get("set-cookie").split(";")[0], origin: url.origin };
}
const href = text => text.match(/data-watch-control="turn-details" href="([^"]+)"/)?.[1].replaceAll("&amp;", "&");

test("Turn projections: Pi exact ancestry, steering, tool/result and exposed reasoning only", () => {
 const rows = [p("s", null, "system", "SECRET SYSTEM"), p("old-u", "s", "user", "OLD PROMPT"), final("old-f", "old-u", "old"),
  p("u", "old-f", "user", "New prompt"), p("a", "u", "assistant", [txt("Working"), { type: "thinking", thinking: "Recorded summary", thinkingSignature: "SECRET SIGNATURE" }, { type: "toolCall", id: "call1", name: "read", arguments: { path: "example.md" } }], "toolUse"),
  p("branch", "old-f", "user", "WRONG BRANCH"), final("branch-f", "branch", "alternate"),
  { ...p("r", "a", "toolResult", [txt("tool output"), { type: "image", data: "SECRET IMAGE" }]), message: { ...p("r", "a", "toolResult", [txt("tool output"), { type: "image", data: "SECRET IMAGE" }]).message, toolName: "read", toolCallId: "call1" } },
  p("steer", "r", "user", "And include the version"), final("f", "steer")];
 const result = turnDetailsFromRecords("pi", rows, target);
 assert.deepEqual(result.events.map(e => e.kind), ["prompt", "progress", "reasoning", "tool", "result", "prompt"]);
 assert.match(body(result), /New prompt/); assert.doesNotMatch(JSON.stringify(result), /SECRET|WRONG BRANCH|OLD PROMPT/);
 assert.equal(result.events.find(e => e.kind === "result").callId, "call1");
 assert.match(result.notices.join(" "), /attachments are omitted/);
 assert.equal(turnDetailsFromRecords("pi", rows, { ...target, markdown: "different" }).events.length, 0);
 const partial = turnDetailsFromRecords("pi", [p("u", "missing", "user", "partial"), final("f", "u")], target);
 assert.match(partial.notices.join(" "), /parent chain is incomplete/);
 const compact = turnDetailsFromRecords("pi", [{ type: "compaction", id: "c", parentId: "old" }, final("f", "c")], target);
 assert.match(compact.notices.join(" "), /compaction\/branch/);
 const redacted = turnDetailsFromRecords("pi", [p("u", null, "user", "hi"), p("a", "u", "assistant", [{ type: "thinking", thinking: "DO NOT SHOW", redacted: true }], "toolUse"), final("f", "a")], target);
 assert.doesNotMatch(body(redacted), /DO NOT SHOW/); assert.match(redacted.notices.join(" "), /Redacted/);
});

test("Turn projections omit aborted attempts and injected context, and match blank text blocks", () => {
 const rows = [p("old", null, "user", "PREVIOUS PROMPT"), p("aborted", "old", "assistant", [txt("PREVIOUS WORK")], "aborted"),
  p("u", "aborted", "user", "Current prompt"), p("f", "u", "assistant", [txt("A"), txt(" "), txt("B")], "stop")];
 const result = turnDetailsFromRecords("pi", rows, { key: "pi:f", markdown: "A\n\nB" });
 assert.equal(result.events[0].text, "Current prompt"); assert.doesNotMatch(body(result), /PREVIOUS/);
 const c = (uuid, parentUuid, role, content, extra = {}) => ({ type: role, uuid, parentUuid, message: { role, content }, ...extra });
 const interrupted = [c("old", null, "user", "PREVIOUS PROMPT"), c("stop", "old", "user", "[Request interrupted by user]"),
  c("meta", "stop", "user", "PRIVATE INJECTED", { isMeta: true }), c("u", "meta", "user", "Current Claude prompt"),
  c("f", "u", "assistant", [], { message: { role: "assistant", id: "final", stop_reason: "end_turn", content: [txt("Answer")] } })];
 const trace = turnDetailsFromRecords("claude", interrupted, { key: "claude:final", markdown: "Answer" });
 assert.equal(trace.events.filter(e => e.kind === "prompt").length, 1); assert.doesNotMatch(body(trace), /PREVIOUS|PRIVATE/);
 const t = createTurnDetails(); t.content([txt("<environment_context>INJECTED</environment_context>"), txt("Actual question")], "user");
 assert.equal(t.result.events.length, 1); assert.equal(t.result.events[0].text, "Actual question");
});

test("Claude incomplete final-message blocks share exact assembly with the retained answer",()=>{
 const rows=[{type:'user',uuid:'u',parentUuid:null,message:{role:'user',content:'Current input'}},
  {type:'assistant',uuid:'a1',parentUuid:'u',message:{role:'assistant',id:'a',stop_reason:null,content:[txt('First'),txt(' '),txt('  Second\r\nline')]}},
  {type:'assistant',uuid:'a2',parentUuid:'a1',message:{role:'assistant',id:'a',stop_reason:'end_turn',content:[]}}];
 const read=createClaudeResponseAssembler();assert.equal(read(rows[0]),null);assert.equal(read(rows[1]),null);
 const response=read(rows[2]);assert.equal(response.markdown,'First\n\n  Second\r\nline');
 const trace=turnDetailsFromRecords('claude',rows,response);assert.deepEqual(trace.events.map(e=>e.text),['Current input']);
 assert.equal(turnDetailsFromRecords('claude',rows,{...response,markdown:'First'}).events.length,0);
});

test("Turn projections: Claude split assistant blocks and parallel sibling results stay in their turn", () => {
 const c = (uuid, parentUuid, role, content, id, stop_reason) => ({ type: role, uuid, parentUuid, message: { role, content, id, stop_reason } });
 const rows = [c("u", null, "user", "Claude prompt"),
  c("thinking", "u", "assistant", [{ type: "thinking", thinking: "Visible reasoning", signature: "SECRET" }], "work", "tool_use"),
  c("call1", "thinking", "assistant", [{ type: "tool_use", id: "one", name: "Read", input: { file_path: "a" } }], "work", "tool_use"),
  c("call2", "call1", "assistant", [{ type: "tool_use", id: "two", name: "Bash", input: { command: "pwd" } }], "work", "tool_use"),
  c("r1", "call1", "user", [{ type: "tool_result", tool_use_id: "one", content: "first output" }]),
  c("r2", "call2", "user", [{ type: "tool_result", tool_use_id: "two", content: "second output" }]),
  c("unrelated", null, "user", [{ type: "tool_result", tool_use_id: "wrong", content: "WRONG RESULT" }]),
  { ...c("side", "call1", "user", [{ type: "tool_result", tool_use_id: "one", content: "SIDECHAIN" }]), isSidechain: true },
  c("f", "r1", "assistant", [txt("Answer")], "final", "end_turn")];
 const result = turnDetailsFromRecords("claude", rows, { key: "claude:final", markdown: "Answer" });
 assert.equal(result.events.filter(e => e.kind === "tool").length, 2);
 assert.equal(result.events.filter(e => e.kind === "result").length, 2);
 assert.match(body(result), /first output[\s\S]*second output/);
 assert.doesNotMatch(JSON.stringify(result), /SECRET|SIDECHAIN|WRONG RESULT/);
 assert.deepEqual(result.notices, []);
 const repeated = structuredClone(rows); repeated[4].message.content[0].content = "ok\nok";
 const preserved = turnDetailsFromRecords("claude", repeated, { key: "claude:final", markdown: "Answer" });
 assert.equal(preserved.events.filter(e => e.kind === "result" && e.callId === "one").length, 1);
 assert.equal(preserved.events.find(e => e.kind === "result" && e.callId === "one").text, "ok\nok", "Repeated stdout lines are preserved inside a single recorded result.");
});

test("Turn projections: Claude user shell records are commands/output, not prompts or assistant tools", () => {
 const c = (uuid, parentUuid, content) => ({ type: "user", uuid, parentUuid, message: { role: "user", content } });
 const rows = [c("u", null, "<bash-input>muxy open browser --split</bash-input>"),
  c("r", "u", [txt("<bash-stdout></bash-stdout><bash-stderr>Error: is not a valid directory\n</bash-stderr>")]),
  { type: "assistant", uuid: "call", parentUuid: "r", message: { role: "assistant", id: "work", stop_reason: "tool_use",
   content: [{ type: "tool_use", id: "help", name: "Bash", input: { command: "muxy --help" } }] } },
  { type: "assistant", uuid: "f", parentUuid: "call", message: { role: "assistant", id: "final", stop_reason: "end_turn", content: [txt("Answer")] } }];
 const target = { key: "claude:final", markdown: "Answer" };
 const result = turnDetailsFromRecords("claude", rows, target);
 assert.deepEqual(result.events.map(e => [e.kind, e.label]), [["tool", "User shell command"], ["result", "Shell stderr"], ["tool", "Tool: Bash"]]);
 assert.equal(result.events[0].text, "muxy open browser --split");
 assert.match(result.events[1].text, /not a valid directory/);
 assert.doesNotMatch(body(result), /<bash-/); assert.deepEqual(result.notices, []);
 const both = structuredClone(rows); both[1].message.content = "<bash-stdout>out & <script>bad()</script></bash-stdout><bash-stderr>err</bash-stderr>";
 assert.deepEqual(turnDetailsFromRecords("claude", both, target).events.slice(1, 3).map(e => e.label), ["Shell stdout", "Shell stderr"]);
 assert.doesNotMatch(buildTurnDetailsPage(turnDetailsFromRecords("claude", both, target), "/"), /<script>/);
 const empty = structuredClone(rows); empty[1].message.content = "<bash-stdout></bash-stdout><bash-stderr></bash-stderr>";
 assert.match(turnDetailsFromRecords("claude", empty, target).notices.join(" "), /no recorded text output/);
 const question = structuredClone(rows); question[0].message.content = "Explain <bash-input>echo hi</bash-input> please.";
 assert.equal(turnDetailsFromRecords("claude", question, target).events[0].kind, "prompt");
 // The same literal XML in another harness is not a Claude shell record.
 assert.equal(turnDetailsFromRecords("pi", [p("u", null, "user", rows[0].message.content), final("f", "u")], { key: "pi:f", markdown: "Answer" }).events[0].kind, "prompt");
});

test("Claude slash commands present compactly with Raw input; only local-command history collapses", () => {
 const c = (uuid, parentUuid, content, extra = {}) => ({ type: "user", uuid, parentUuid, message: { role: "user", content }, ...extra });
 const answer = parentUuid => ({ type: "assistant", uuid: "f", parentUuid, message: { role: "assistant", id: "final", stop_reason: "end_turn", content: [txt("Answer")] } });
 const target = { key: "claude:final", markdown: "Answer" };
 const cards = page => [...page.matchAll(/<details class="event (\w+)"( open)?><summary><span class="number"[^>]*>\d+<\/span> ([^<]*)<\/summary>/g)].map(m => [m[1], Boolean(m[2]), m[3]]);
 const theme = "<command-name>/theme</command-name>\n            <command-message>theme</command-message>\n            <command-args></command-args>";
 const output = "<local-command-stdout>Theme set to dark</local-command-stdout>";
 const rows = [c("cmd", null, theme), c("out", "cmd", output), c("caveat", "out", "Caveat: generated by local commands.", { isMeta: true }), c("u", "caveat", "Draft the exam"), answer("u")];
 const result = turnDetailsFromRecords("claude", rows, target);
 // The projection keeps the exact recorded command; only the output envelope is unwrapped.
 assert.deepEqual(result.events.map(e => [e.kind, e.label, e.text]), [["prompt", "Prompt / input", theme], ["result", "Command output", "Theme set to dark"], ["prompt", "Prompt / input", "Draft the exam"]]);
 assert.doesNotMatch(body(result), /<local-command|Caveat/);
 const page = buildTurnDetailsPage(result, "/");
 assert.deepEqual(cards(page), [["prompt", false, "Slash command"], ["result", false, "Command output"], ["prompt", true, "Prompt / input"]]);
 assert.match(page, /<pre><span>\/theme<\/span><\/pre><details class="recorded-input"><summary>Raw input<\/summary><pre><span>&lt;command-name&gt;\/theme&lt;\/command-name&gt;/);
 // A prompt-expanding command stays open, with distinct recorded content in Raw input.
 const review = "\n<command-message>Distinct recorded content</command-message>\n<command-name>/review</command-name>\n<command-args>  file.md\n</command-args>\n";
 const expanded = turnDetailsFromRecords("claude", [c("cmd", null, review), c("x", "cmd", "Skill body", { isMeta: true }), answer("x")], target);
 assert.equal(expanded.events[0].text, review);
 const expandedPage = buildTurnDetailsPage(expanded, "/");
 assert.deepEqual(cards(expandedPage), [["prompt", true, "Slash command"]]);
 assert.match(expandedPage, /<pre><span>\/review file\.md<\/span><\/pre>/);
 assert.match(expandedPage, /Raw input<\/summary><pre><span>[\s\S]*Distinct recorded content/);
 // A real prompt followed by a local command keeps the prompt open.
 const after = turnDetailsFromRecords("claude", [c("u", null, "Write the questions."), c("cmd", "u", theme), c("out", "cmd", output), answer("out")], target);
 assert.deepEqual(cards(buildTurnDetailsPage(after, "/")).map(([, open, label]) => [label, open]), [["Prompt / input", true], ["Slash command", false], ["Command output", false]]);
 // Multipart prompts stay open in Claude and Pi.
 const parts = [txt("First instruction."), txt("Second instruction.")];
 assert.deepEqual(cards(buildTurnDetailsPage(turnDetailsFromRecords("claude", [c("u", null, parts), answer("u")], target), "/")).map(card => card[1]), [true, true]);
 assert.deepEqual(cards(buildTurnDetailsPage(turnDetailsFromRecords("pi", [p("u", null, "user", parts), final("f", "u")], { key: "pi:f", markdown: "Answer" }), "/")).map(card => card[1]), [true, true]);
 // Partial, repeated, nested, trailing or embedded wrappers stay literal, open prompts.
 for (const literal of ["Run <command-name>/theme</command-name> later", "<command-name>/a</command-name><command-name>/b</command-name>",
  "<command-args>x</command-args>", "<command-name>/theme</command-name> trailing", "<command-name>two words</command-name>",
  "<command-message>Keep <command-name>/nested</command-name> literally</command-message><command-name>/theme</command-name>",
  "<local-command-stdout>first</local-command-stdout> ordinary text <local-command-stdout>second</local-command-stdout>",
  "<bash-input>a</bash-input> and <bash-input>b</bash-input>"]) {
  const projected = turnDetailsFromRecords("claude", [c("u", null, literal), answer("u")], target);
  assert.deepEqual(projected.events.map(e => [e.label, e.text]), [["Prompt / input", literal]], literal);
  assert.deepEqual(cards(buildTurnDetailsPage(projected, "/")), [["prompt", true, "Prompt / input"]], literal);
 }
 // Later user input during the turn stays open as before.
 const steer = [c("u", null, "Original"),
  { type: "assistant", uuid: "a", parentUuid: "u", message: { role: "assistant", id: "work", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "x" } }] } },
  c("r", "a", [{ type: "tool_result", tool_use_id: "t", content: "ok" }]), c("s", "r", "Try again"), answer("s")];
 assert.deepEqual(cards(buildTurnDetailsPage(turnDetailsFromRecords("claude", steer, target), "/")).map(card => card[1]), [true, false, false, true]);
});

test("Turn projections: ordinary Claude tool failures do not end the turn", () => {
 const c = (uuid, parentUuid, role, content, id, stop_reason) => ({ type: role, uuid, parentUuid, message: { role, content, id, stop_reason } });
 const rows = [c("u", null, "user", "Original request"),
  c("a", "u", "assistant", [{ type: "tool_use", id: "read", name: "Read", input: { file_path: "missing.md" } }], "work", "tool_use"),
  c("r", "a", "user", [{ type: "tool_result", tool_use_id: "read", is_error: true, content: "File not found" }]),
  c("steer", "r", "user", "Try the other file"), c("f", "steer", "assistant", [txt("Answer")], "final", "end_turn")];
 const result = turnDetailsFromRecords("claude", rows, { key: "claude:final", markdown: "Answer" });
 assert.deepEqual(result.events.map(e => e.kind), ["prompt", "tool", "result", "prompt"]);
 assert.match(body(result), /Original request[\s\S]*File not found[\s\S]*Try the other file/);
 assert.match(result.events[2].label, /error/); assert.deepEqual(result.notices, []);
});

test("Turn projections: Codex task boundaries, no duplicate events or opaque reasoning", () => {
 const event = payload => ({ type: "event_msg", payload }); const item = payload => ({ type: "response_item", payload });
 const rows = [event({ type: "task_complete", turn_id: "old", last_agent_message: "old" }),
  event({ type: "task_started", turn_id: "turn" }), event({ type: "user_message", message: "Codex prompt" }),
  item({ type: "message", role: "developer", content: [txt("SECRET DEVELOPER")] }),
  item({ type: "message", role: "user", content: [txt("Codex prompt")] }),
  event({ type: "agent_reasoning", text: "Recorded summary" }), item({ type: "reasoning", summary: [{ type: "summary_text", text: "Recorded summary" }], encrypted_content: "SECRET CIPHER" }),
  item({ type: "function_call", name: "exec", arguments: '{"command":"pwd"}', call_id: "call" }), item({ type: "function_call_output", output: "output", call_id: "call" }),
  item({ type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Answer" }] }),
  event({ type: "task_complete", turn_id: "turn", last_agent_message: "Answer" })];
 const result = turnDetailsFromRecords("codex", rows, { key: "codex:turn", markdown: "Answer" });
 assert.deepEqual(result.events.map(e => e.kind), ["prompt", "reasoning", "tool", "result"]);
 assert.doesNotMatch(JSON.stringify(result), /SECRET|duplicate/);
 assert.match(result.notices.join(" "), /encrypted reasoning/);
 const steered = structuredClone(rows); steered.splice(-1, 0, event({ type: "user_message", message: "Additional steering" }), event({ type: "agent_message", message: "Event-only progress" }));
 const extra = turnDetailsFromRecords("codex", steered, { key: "codex:turn", markdown: "Answer" });
 assert.match(body(extra), /Additional steering/); assert.match(body(extra), /Event-only progress/);
 const wrong = structuredClone(rows); wrong[1].payload.turn_id = "other";
 assert.equal(turnDetailsFromRecords("codex", wrong, { key: "codex:turn", markdown: "Answer" }).events.length, 0);
});

test("Turn projections: Codex omits AGENTS.md and environment context in both record representations", () => {
 const event = payload => ({ type: "event_msg", payload }); const item = payload => ({ type: "response_item", payload });
 const question = "Explain how environment_context and AGENTS.md are used.";
 const messages = [" \n# AGENTS.md instructions for /example\n<INSTRUCTIONS>PRIVATE_AGENTS_CONTEXT</INSTRUCTIONS>",
  "\n<environment_context>PRIVATE_ENV_CONTEXT</environment_context>", question];
 const input = text => ({ type: "input_text", text });
 const variants = [
  messages.map(message => event({ type: "user_message", message })),
  messages.map(message => item({ type: "message", role: "user", content: [input(message)] })),
  [item({ type: "message", role: "user", content: messages.map(input) })],
 ];
 for (const records of variants) {
  const rows = [event({ type: "task_started", turn_id: "turn" }), ...records,
   event({ type: "task_complete", turn_id: "turn", last_agent_message: "Answer" })];
  const result = turnDetailsFromRecords("codex", rows, { key: "codex:turn", markdown: "Answer" });
  assert.deepEqual(result.events.map(e => [e.kind, e.text]), [["prompt", question]]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_AGENTS_CONTEXT|PRIVATE_ENV_CONTEXT/);
  assert.match(result.notices.join(" "), /harness-injected context is omitted/);
  assert.doesNotMatch(result.notices.join(" "), /input prompt is not available/);
 }
});

test("Turn reader and renderer bound data, tolerate damaged tails, and keep hostile text inert", async t => {
 const dir = await temp(t), path = join(dir, "session.jsonl");
 const rows = [p("u", null, "user", "Prompt <img src='https://evil.test/x'>"), final("f", "u")];
 await writeFile(path, rows.map(e => JSON.stringify(e)).join("\n") + '\n{"unfinished":');
 const result = await readTurnDetails(path, "pi", target, new AbortController().signal);
 assert.equal(result.events.length, 1); assert.match(result.notices.join(" "), /bounded/);
 const bounded = createTurnDetails();
 for (let i = 0; i < TURN_EVENT_LIMIT + 30; i++) bounded.add("tool", "test", "x".repeat(20000));
 assert.ok(bounded.result.events.length <= TURN_EVENT_LIMIT);
 assert.ok(body(bounded.result).length < TURN_TOTAL_LIMIT + 2000);
 const output = buildTurnDetailsPage(result, "/?revision=1", "</title><script>bad()</script>");
 assert.doesNotMatch(output, /<script|<img|<iframe|<form/);
 assert.match(output, /&lt;img/); assert.match(output, /&lt;script/);
 await writeFile(path, JSON.stringify({ type: "ignored", text: "x".repeat(TURN_RECORD_BYTES) }) + "\n" + rows.map(e => JSON.stringify(e)).join("\n") + "\n");
 assert.match((await readTurnDetails(path, "pi", target)).notices.join(" "), /oversized/);
 await writeFile(path, "x".repeat(TURN_READ_BYTES + 100) + "\n" + rows.map(e => JSON.stringify(e)).join("\n") + "\n");
 assert.equal((await readTurnDetails(path, "pi", target)).events.length, 1);
 await writeFile(path, "invalid\n".repeat(10_100) + rows.map(e => JSON.stringify(e)).join("\n") + "\n");
 assert.equal((await readTurnDetails(path, "pi", target)).events.length, 1, "The newest turn survives a bounded scan of malformed history.");
 const controller = new AbortController(); controller.abort();
 await assert.rejects(readTurnDetails(path, "pi", target, controller.signal), /abort/i);
 await assert.rejects(readTurnDetails(dir, "pi", target), /regular file/);
});

test("Turn routes are opt-in, lazy, authenticated and tied to the exact retained revision/instance", async t => {
 const dir = await temp(t); let calls = 0;
 const details = async () => { calls++; return { events: [{ kind: "prompt", label: "Prompt", text: "SENSITIVE PROMPT <script>bad()</script>" }], notices: [] }; };
 const off = await createBrowserWatchServer(html, dir); t.after(() => off.close());
 const offPage = await auth(off); assert.equal(href(offPage.text), undefined);
 const server = await createBrowserWatchServer(html, dir, { historyLimit: 2, initialTurnDetails: details }); t.after(() => server.close());
 const a = await auth(server), route = href(a.text); assert.ok(route); assert.equal(calls, 0); assert.doesNotMatch(a.text, /SENSITIVE PROMPT/);
 const request = (url = route, headers = { cookie: a.cookie }, method = "GET") => fetch(a.origin + url, { headers, method });
 assert.equal((await request(route, {})).status, 403);
 assert.equal((await request(route.replace(/instance=[^&]+/, "instance=stale"))).status, 409);
 assert.equal((await request(route.replace(/identity=[^&]+/, "identity=wrong"))).status, 409);
 assert.equal((await request(route, undefined, "POST")).status, 405);
 assert.equal((await request(route, undefined, "HEAD")).status, 200); assert.equal(calls, 0);
 const r = await request(); assert.equal(r.status, 200); const page = await r.text();
 assert.match(page, /SENSITIVE PROMPT/); assert.doesNotMatch(page, /<script>bad/); assert.equal(calls, 1);
 const csp=r.headers.get('content-security-policy');
 assert.match(csp, /script-src 'nonce-[^']+'; connect-src 'self'/);
 assert.match(csp, /default-src 'none'/); assert.match(csp, /base-uri 'none'; form-action 'none'; frame-ancestors 'none'/);
 assert.doesNotMatch(csp, /script-src[^;]*(unsafe-inline|unsafe-eval|https?:)/);
 const nonce=csp.match(/script-src 'nonce-([^']+)'/)[1];
 assert.ok([...page.matchAll(/<script\b[^>]*>/g)].every(m=>m[0].includes(`nonce="${nonce}"`)));
 assert.equal(r.headers.get("cache-control"), "no-store");
 server.updateDocument(html); assert.equal(href((await auth(server)).text), undefined);
 assert.equal((await request()).status, 200); // historical response still has its own loader
 server.updateDocument(html, { turnDetails: details });
 assert.equal((await request()).status, 404); assert.equal(calls, 2);
 assert.ok(href((await auth(server)).text));
});

test("Turn requests dedupe, reject overload, cancel on expiry/close, and recover after failure", async t => {
 const dir = await temp(t); let calls = 0; const pending = [];
 const loader = signal => new Promise((resolve, reject) => {
  calls++; pending.push({ resolve, signal }); signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
 });
 const server = await createBrowserWatchServer(html, dir, { historyLimit: 3, initialTurnDetails: loader }); t.after(() => server.close());
 const a = await auth(server); const first = href(a.text);
 const get = route => fetch(a.origin + route, { headers: { cookie: a.cookie } });
 const one = get(first), same = get(first);
 for (let i = 0; calls < 1 && i < 100; i++) await new Promise(r => setTimeout(r, 10));
 assert.equal(calls, 1);
 server.updateDocument(html, { turnDetails: loader }); const second = href((await auth(server)).text); const two = get(second);
 for (let i = 0; calls < 2 && i < 100; i++) await new Promise(r => setTimeout(r, 10));
 server.updateDocument(html, { turnDetails: loader }); const third = href((await auth(server)).text);
 assert.equal((await get(third)).status, 503); assert.equal(calls, 2);
 server.updateDocument(html, { turnDetails: loader }); assert.equal(pending[0].signal.aborted, true);
 assert.equal((await one).status, 404); assert.equal((await same).status, 404);
 pending[1].resolve({ events: [], notices: [] }); assert.equal((await two).status, 200);
 const last = get(href((await auth(server)).text)).catch(() => null);
 for (let i = 0; calls < 3 && i < 100; i++) await new Promise(r => setTimeout(r, 10));
 await server.close(); assert.equal(pending[2].signal.aborted, true); await last;
});

test("Turn read failures are generic and retryable, and restarts reject stale detail links", async t => {
 const dir = await temp(t); let attempts = 0;
 const server = await createBrowserWatchServer(html, dir, { token: "x".repeat(40), initialTurnDetails: async () => {
  if (++attempts === 1) throw new Error("PRIVATE /path/secret"); return { events: [], notices: [] };
 } }); t.after(() => server.close());
 const a = await auth(server), route = href(a.text);
 const first = await fetch(a.origin + route, { headers: { cookie: a.cookie } }); assert.equal(first.status, 503); assert.doesNotMatch(await first.text(), /PRIVATE|secret/);
 assert.equal((await fetch(a.origin + route, { headers: { cookie: a.cookie } })).status, 200);
 const port = Number(new URL(a.origin).port); await server.close();
 const next = await createBrowserWatchServer(html, dir, { port, token: "x".repeat(40), initialTurnDetails: async () => ({ events: [], notices: [] }) }); t.after(() => next.close());
 const b = await auth(next); assert.equal((await fetch(b.origin + route, { headers: { cookie: b.cookie } })).status, 409);
});

test("Shell presentation formats known string commands, preserves raw arguments and falls back without guessing", () => {
 const page = (text, label = "Tool: Bash", kind = "tool") => buildTurnDetailsPage({ events: [{ kind, label, text }], notices: [] }, "#");
 for (const label of ["Tool: Bash", "Tool: bash", "Tool: functions.bash", "Tool: exec_command", "Tool: functions.exec_command", "Tool: exec"]) {
  const result = page(JSON.stringify({ cmd: "echo '<script>literal</script>'", cwd: "/example", timeout: 20, dangerouslyDisableSandbox: true, run_in_background: false }), label);
  assert.match(result, /class="shell-command"/); assert.match(result, /Recorded arguments \(JSON\)/);
  assert.match(result, /<dt>dangerouslyDisableSandbox<\/dt>/); assert.match(result, /<dt>run_in_background<\/dt>/);
  assert.doesNotMatch(result, /<script>/);
 }
 for (const text of ['{"command":"unfinished', 'null', '[]', '"pwd"', '{"command":3}', '{"cmd":["bash","-lc","pwd"]}', '{}', JSON.stringify({ command: "x".repeat(20_000) })]) assert.doesNotMatch(page(text), /class="shell-command"/);
 assert.doesNotMatch(page('{"command":"pwd"}', 'Tool: unknown'), /class="shell-command"/);
 assert.doesNotMatch(page('{"command":"pwd"}', 'Tool: Bash', 'result'), /class="shell-command"/);
});

test("Codemode, read and edit use literal typed views with raw arguments and safe fallbacks", () => {
 const page = (name, args, kind = "tool") => buildTurnDetailsPage({ events: [{ kind, label: `Tool: ${name}`, text: typeof args === "string" ? args : JSON.stringify(args) }] }, "#");
 for (const name of ['codemode', 'functions.codemode']) {
  const html = page(name, { code: 'const x = "<script>literal</script>";\nreturn x;', timeout_ms: 5000 });
  assert.match(html, /class="code-input"/); assert.match(html, /<dt>timeout_ms<\/dt>/); assert.match(html, /Recorded arguments \(JSON\)/); assert.doesNotMatch(html, /<script>/);
  assert.match(page(name, 'const x = 1;\nreturn x;'), /class="code-input"/);
  assert.doesNotMatch(page(name, '"keep these quotes"'), /class="code-input"/, 'Do not decode a freeform JS string literal as an argument wrapper.');
 }
 for (const pathKey of ['path', 'file_path', 'filePath']) {
  const args = { [pathKey]: '/example/<img src=x>.txt', offset: 3, limit: 10, extra: '<script>bad()</script>' };
  const html = page('functions.Read', args);
  assert.match(html, /class="file-path"/); assert.match(html, /Start line/); assert.match(html, /Line limit/); assert.match(html, /<dt>extra<\/dt>/);
  assert.doesNotMatch(html, /<img|<script|href="\/example/);
 }
 for (const [oldKey, newKey] of [['oldText', 'newText'], ['old_string', 'new_string'], ['oldString', 'newString']]) {
  const html = page('Edit', { path: 'file.txt', [oldKey]: 'old\ntext', [newKey]: '', replace_all: true });
  assert.match(html, /Requested replacement/); assert.match(html, /class="tool-field edit-before"/); assert.match(html, /class="tool-field edit-after"/); assert.match(html, /Empty text/); assert.match(html, /<dt>replace_all<\/dt>/);
 }
 const batch = page('MultiEdit', { file_path: 'file.txt', edits: [{ old_string: 'a', new_string: 'b', replace_all: false }, { oldText: '', newText: 'c' }], dryRun: true });
 assert.equal((batch.match(/class="edit-replacement"/g) || []).length, 2); assert.match(batch, /Requested replacement 2/); assert.match(batch, /<dt>replace_all<\/dt>/); assert.match(batch, /<dt>dryRun<\/dt>/);
 for (const args of [{ path: 'f', edits: [] }, { path: 'f', edits: [{ oldText: 'a', newText: 'b' }, null] }, { path: 'f', oldText: 'a', newText: 3 }, { oldText: 'a', newText: 'b' }, '{"path":"f","edits":', { path: 'f', oldText: 'x'.repeat(20_000), newText: 'a' }]) assert.doesNotMatch(page('edit', args), /class="edit-replacement"/);
 assert.doesNotMatch(page('read', { path: 3 }), /class="file-path"/);
 assert.doesNotMatch(page('unknown', { path: 'f', oldText: 'a', newText: 'b' }), /class="edit-replacement"/);
 assert.doesNotMatch(page('codemode', { code: 'return 1;' }, 'result'), /class="code-input"/);
 // Nested option rendering must stay linear in the bounded input, not grow
 // quadratically from thousands of indentation levels.
 const deep = '{"code":"return 1;","extra":' + '['.repeat(1000) + '0' + ']'.repeat(1000) + '}';
 assert.ok(page('codemode', deep).length < 30_000);
});

test("Claude paste envelopes are presentation-only and require a complete matching wrapper", () => {
 const wrap = body => `<pasted_content id="sample-04e5">\n${body}\n</pasted_content id="sample-04e5">`;
 const render = (text, sourceAgent = 'claude', kind = 'prompt') => buildTurnDetailsPage({sourceAgent,events:[{kind,label:'Prompt',text}]}, '#');
 const original = wrap('  Literal text <img src=x>');
 const page = render(original);
 assert.match(page, /<div class="event-content"><pre><span>  Literal text &lt;img src=x&gt;<\/span><\/pre>/);
 assert.match(page, /<summary>Raw input<\/summary>/); assert.doesNotMatch(page, /<summary>Recorded input<\/summary>|<img/);
 for (const text of [
  'Explain this: ' + original, original + '\nAnother message',
  original.replace('id="sample-04e5">', 'id="other">'),
  original.replace('</pasted_content id="sample-04e5">', '</pasted_content>'),
  original.replace('id="sample-04e5">', 'id="sample-04e5" other="x">'),
  original.replace('</pasted_content id="sample-04e5">', ''),
  original + '\n' + original, wrap(wrap('nested')), wrap('   '),
  `<pasted_content id="${'x'.repeat(129)}">text</pasted_content id="${'x'.repeat(129)}">`,
  wrap('x'.repeat(20_000))
 ]) assert.doesNotMatch(render(text), /<summary>Raw input<\/summary>/, 'Ambiguous/partial envelopes remain literal.');
 for (const agent of ['pi','codex','opencode',undefined]) {
  const data={events:[{kind:'prompt',label:'Prompt',text:original}],...(agent ? {sourceAgent:agent} : {})};
  assert.doesNotMatch(buildTurnDetailsPage(data,'#','Claude Code'), /<summary>Raw input<\/summary>/, 'Do not infer Claude provenance from text or the page label.');
 }
 for (const kind of ['tool','result','progress','reasoning']) assert.doesNotMatch(render(original,'claude',kind), /<summary>Raw input<\/summary>/);
});

test("Claude reading view hides paste tags while Raw input retains the exact recorded text", async t => {
 if (!process.env.PUPPETEER_EXECUTABLE_PATH) { t.skip('Set PUPPETEER_EXECUTABLE_PATH to a dedicated headless browser'); return; }
 const { default: puppeteer } = await import('puppeteer-core');
 const dir=await temp(t), path=join(dir,'claude.jsonl');
 const inner='  Hello\r\n\r\n<script>window.bad=true</script>  ';
 const original=`\n\n<pasted_content id="04e5">\r\n${inner}\r\n</pasted_content id="04e5">\n`;
 const rows=[{type:'user',uuid:'u',parentUuid:null,message:{role:'user',content:original}}, {type:'assistant',uuid:'f',parentUuid:'u',message:{id:'f',role:'assistant',stop_reason:'end_turn',content:[txt('Answer')]}}];
 await writeFile(path,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
 const target={key:'claude:f',markdown:'Answer'};
 const recorded=await readTurnDetails(path,'claude',target);
 assert.equal(recorded.sourceAgent,'claude'); assert.equal(recorded.events[0].text,original, 'Do not rewrite the projection or stored prompt.');
 const server=await createBrowserWatchServer(html,dir,{initialTurnDetails:signal=>readTurnDetails(path,'claude',target,signal)}); t.after(()=>server.close());
 const browser=await puppeteer.launch({executablePath:process.env.PUPPETEER_EXECUTABLE_PATH,headless:true,args:['--no-sandbox']}); t.after(()=>browser.close());
 const page=await browser.newPage(); await page.goto(server.url);
 await Promise.all([page.waitForNavigation(),page.click('[data-watch-control="turn-details"]')]);
 assert.equal(await page.$eval('.prompt .event-content > pre',e=>e.textContent),inner);
 assert.equal(await page.$eval('.recorded-input > summary',e=>e.textContent),'Raw input');
 assert.equal(await page.$eval('.recorded-input',e=>e.open),false);
 await page.click('.recorded-input > summary');
 assert.equal(await page.$eval('.recorded-input pre',e=>e.textContent),original);
 assert.equal(await page.$$eval('.prompt script,.prompt img',es=>es.length),0); assert.equal(await page.evaluate(()=>window.bad),undefined);
});

test("Read text output is retained separately from the call for Pi and Claude", () => {
 const output = 'export const retries = 2;\n';
 const pi = [p('u', null, 'user', 'Read settings.js'), p('a', 'u', 'assistant', [{ type:'toolCall', name:'read', id:'read-call', arguments:{path:'settings.js'} }], 'toolUse'), {type:'message',id:'r',parentId:'a',message:{role:'toolResult',toolName:'read',toolCallId:'read-call',content:[txt(output)]}}, final('f','r')];
 const claude = [
  {type:'user',uuid:'u',parentUuid:null,message:{role:'user',content:'Read settings.js'}},
  {type:'assistant',uuid:'a',parentUuid:'u',message:{id:'a',role:'assistant',stop_reason:'tool_use',content:[{type:'tool_use',id:'read-call',name:'Read',input:{file_path:'settings.js'}}]}},
  {type:'user',uuid:'r',parentUuid:'a',message:{role:'user',content:[{type:'tool_result',tool_use_id:'read-call',content:output}]}},
  {type:'assistant',uuid:'f',parentUuid:'r',message:{id:'f',role:'assistant',stop_reason:'end_turn',content:[txt('Answer')]}}
 ];
 for(const [agent,records] of [['pi',pi],['claude',claude]]) {
  const details=turnDetailsFromRecords(agent,records,{key:`${agent}:f`,markdown:'Answer'});
  const call=details.events.find(e=>e.kind==='tool'), result=details.events.find(e=>e.kind==='result');
  assert.equal(call.callId,result.callId); assert.equal(result.text,output); assert.match(result.label,/Tool result: read/i);
  const page=buildTurnDetailsPage(details,'#'); assert.match(page,/class="file-path"/); assert.match(page,/export const retries = 2;/);
 }
});

test("Working page uses one short disclaimer instead of reader diagnostics", () => {
 const notices = ['Only a bounded portion of the session was read; earlier or oversized records may be missing.', 'A compaction/branch boundary occurs here; earlier working and the full model context are not reconstructed.', 'Image/file attachments are omitted; no attachment is loaded from this view.', 'The input prompt is not available in this recorded portion of the turn.'];
 for (const events of [[], [{ kind: 'prompt', label: 'Prompt', text: 'Hello' }]]) {
  const page = buildTurnDetailsPage({ events, notices }, '#');
  assert.equal((page.match(/class="notices"/g) || []).length, 1);
  assert.match(page, /Read-only view; some conversation content may be missing or shortened\./);
  for (const notice of notices) assert.ok(!page.includes(notice));
  assert.doesNotMatch(page, /<footer>|<aside|System\/developer|full model context/);
 }
 const clipped = buildTurnDetailsPage({ events: [{ kind: 'tool', label: 'Tool: read', text: 'x'.repeat(20_000) }] }, '#');
 assert.match(clipped, /\[… truncated\]/, 'Keep the short inline marker where actual text is clipped.');
});

test("Turn details browser view preserves normal links/Back, keyboard controls and mobile layout", async t => {
 if (!process.env.PUPPETEER_EXECUTABLE_PATH) { t.skip("Set PUPPETEER_EXECUTABLE_PATH to a dedicated headless browser"); return; }
 const { default: puppeteer } = await import("puppeteer-core");
 const dir = await temp(t); let calls = 0;
 const prompt = '\n  \r\n\t<pasted_content id="example">\nA harmless prompt\n</pasted_content id="example">';
 const command = ["printf '%s\\n' 'a && b'",  "cat <<'EOF'", '<script>window.bad=true</script>', 'EOF'].join('\n');
 const args = JSON.stringify({ command, description: 'Read <literal> text', timeout: 20, cwd: '/example', dangerouslyDisableSandbox: false, extra: { nested: '<img src=x>' } });
 const source = 'window.bad = true;\nconst literal = "<img src=x>";\nreturn literal;';
 const path = '/example/<img src=x> & file.txt';
 const edits = [{ oldText: '\r\nbefore\r\n<em>literal</em>\r\n', newText: '\nafter\n  indented\n', replace_all: true }, { old_string: 'remove', new_string: '' }];
 const toolArgs = [{ code: source, timeout_ms: 5000 }, { path, offset: 3, limit: 10 }, { path, edits, dryRun: true }].map(a => JSON.stringify(a));
 const extra = ['codemode', 'read', 'edit'].map((name, i) => ({ kind: 'tool', label: `Tool: ${name}`, text: toolArgs[i], callId: `typed-${name}` }));
 const output = '\n\t24 file.js\r\n\t14 helper.js\n1  ' + 'source text '.repeat(180) + '\n';
 extra.push({ kind: 'result', label: 'Tool result', text: output, callId: 'typed-codemode' });
 const server = await createBrowserWatchServer(html, dir, { initialTurnDetails: async () => { calls++; return { events: [{ kind: "prompt", label: "Prompt", text: prompt }, { kind: "tool", label: "Tool: read", text: "<script>window.bad=true</script>" }, { kind: "tool", label: "Tool: Bash", text: args }, ...extra], notices: [] }; } }); t.after(() => server.close());
 const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true, args: ["--no-sandbox"] });
 try {
  const page = await browser.newPage(); await page.goto(server.url); assert.equal(calls, 0);
  const link = await page.$eval('[data-watch-control="turn-details"]', e => e.href); assert.ok(link.includes("/__pi_markdown_preview_turn__/"));
  await page.focus('[data-watch-control="turn-details"]'); await Promise.all([page.waitForNavigation(), page.keyboard.press("Enter")]);
  assert.equal(await page.$eval("h1", e => e.textContent), "Working"); assert.equal(calls, 1);
  assert.equal(await page.$eval('.prompt .event-content > pre', e => e.textContent), prompt.slice(5), 'Remove blank leading lines but preserve the first content line indentation.');
  assert.equal(await page.$eval('.recorded-input', e => e.open), false);
  assert.equal(await page.$eval('.recorded-input > summary', e => e.textContent), 'Raw input');
  assert.equal(await page.$eval('.recorded-input pre', e => e.textContent), prompt, 'Exact recorded spacing remains available.');
  assert.equal(await page.$eval("details.tool", e => e.open), false);
  await page.click("details.tool summary"); assert.equal(await page.evaluate(() => window.bad), undefined);
  await page.click('.tool:has(.shell-command) > summary');
  assert.equal(await page.$eval('.shell-command code', e => e.textContent), command, 'Quotes, escapes, operators and heredoc newlines remain exact.');
  assert.equal(await page.$eval('.tool-description', e => e.textContent), 'Read <literal> text');
  assert.equal(await page.$eval('.recorded-arguments', e => e.open), false);
  assert.match(await page.$eval('.tool-options', e => e.textContent), /dangerouslyDisableSandboxfalse/);
  await page.click('.tool:has(.shell-command) .recorded-arguments > summary');
  assert.equal(await page.$eval('.tool:has(.shell-command) .recorded-arguments pre', e => e.textContent), args);
  for (const selector of ['.code-input', '.file-path', '.edit-replacement']) await page.$eval(`.event:has(${selector})`, e => e.open = true);
  assert.equal(await page.$eval('.code-input code', e => e.textContent), source);
  assert.equal(await page.$eval('.file-path code', e => e.textContent), path);
  assert.deepEqual(await page.$$eval('.edit-before code', es => es.map(e => e.textContent)), edits.map(e => e.oldText ?? e.old_string));
  assert.deepEqual(await page.$$eval('.edit-after code', es => es.map(e => e.textContent)), edits.map(e => e.newText ?? e.new_string));
  assert.match(await page.$eval('.event:has(.edit-replacement) .tool-options', e => e.textContent), /replace_alltrue/);
  for (const [i, selector] of ['.code-input', '.file-path', '.edit-replacement'].entries()) {
   const card = `.event:has(${selector})`;
   await page.click(`${card} .recorded-arguments > summary`);
   assert.equal(await page.$eval(`${card} .recorded-arguments pre`, e => e.textContent), toolArgs[i]);
  }
  assert.equal(await page.$$eval('.event-content a', es => es.length), 0, 'Recorded paths are not granted file-navigation capabilities.');
  assert.equal(await page.$eval('.event:has(.code-input) .number', e => e.title), 'Call ID: typed-codemode');
  assert.equal(await page.$eval('.event:has(.code-input) > summary', e => e.textContent.includes('typed-codemode')), false, 'Internal call IDs are not prominent header text.');
  assert.ok(await page.$eval('.event:has(.code-input) .tool-options', e => {
   const key=document.createRange(); key.selectNodeContents(e.querySelector('dt'));
   return e.querySelector('dd').getBoundingClientRect().left-key.getBoundingClientRect().right <= 16;
  }), 'A single option value sits beside its label, not in a distant fixed column.');
  assert.equal(await page.$eval('.output-wrap', e => e.checkVisibility()), false, 'The wrap control does not escape a closed details card.');
  await page.click('.result > summary');
  assert.equal(await page.$eval('.output-wrap input', e => e.checked), false);
  assert.equal(await page.$eval('.result pre', e => e.textContent), output, 'Line counts and numbered source are recorded output, not UI counters.');
  assert.ok(await page.$eval('.result pre', e => e.scrollWidth > e.clientWidth && getComputedStyle(e).whiteSpace === 'pre'), 'Wide output scrolls rather than wrapping numbered lines.');
  await page.keyboard.press('Tab'); await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
  assert.ok(await page.$eval('.result > summary', e => e.matches(':focus-visible')));
  assert.deepEqual(await page.$eval('.result > summary', e => ({ offset:getComputedStyle(e).outlineOffset, neutral:getComputedStyle(e).outlineColor===getComputedStyle(e.querySelector('.number')).color })), {offset:'-4px',neutral:true});
  assert.equal(await page.evaluate(() => window.bad), undefined);
  assert.equal(await page.$$eval('.event-content img', es => es.length), 0);
  await page.setViewport({ width: 360, height: 760, isMobile: true, hasTouch: true });
  // Switching mobile emulation reloads the document; reopen the native details
  // before checking visible controls rather than measuring skipped contents.
  await page.$$eval('details.event', es => es.forEach(e => e.open = true));
  assert.equal(await page.$eval('.output-wrap', e => e.checkVisibility()), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.ok(await page.$eval('.event:has(.code-input) .recorded-arguments > summary', e => e.getBoundingClientRect().height >= 44));
  assert.ok(await page.$eval('.output-wrap', e => e.getBoundingClientRect().height >= 44));
  assert.ok(await page.$eval('.output-wrap', e => e.getBoundingClientRect().left >= e.closest('.result').querySelector('.number').getBoundingClientRect().right), 'Wrap control leaves the result heading available on mobile.');
  await page.focus('.output-wrap input'); await page.keyboard.press('Space');
  assert.ok(await page.$eval('.output-wrap input', e => e.checked));
  assert.ok(await page.$eval('.result pre', e => e.scrollWidth <= e.clientWidth + 1 && getComputedStyle(e).whiteSpace === 'pre-wrap'));
  assert.equal(await page.$eval('.result pre', e => e.textContent), output, 'Wrapping changes presentation, not output content.');
  await page.keyboard.press('Space');
  assert.ok(await page.$eval('.result pre', e => e.scrollWidth > e.clientWidth));
  await page.goBack(); assert.ok(await page.$('[data-watch-control="turn-details"]'));
  const tab = await browser.newPage(); await tab.goto(link); assert.equal(await tab.$eval("h1", e => e.textContent), "Working");
  await Promise.all([tab.waitForNavigation(), tab.click("nav a")]); assert.ok(await tab.$('[data-watch-control="turn-details"]'));
 } finally { await browser.close(); }
});
