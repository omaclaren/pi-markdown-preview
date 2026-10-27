// REPL submissions in a turn's recorded activity: repl_send calls from pi-repl
// (Pi) or agent-repl (over MCP), paired with their recorded results. Nothing is
// executed or fetched, and the REPL session itself is never read: this is what
// the agent ran and saw at the time.

/** Terminal colour and control sequences (CSI, OSC and charset designators). */
export const TERMINAL_SEQUENCE = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]/g;

// repl_send targets, with a label and a Pandoc highlighting language. Pi names the
// tool repl_send; MCP clients prefix the server name (Claude Code and Codex:
// mcp__agent-repl__repl_send; OpenCode: agent-repl_repl_send).
const RUNTIMES = {
	python: ["Python", "python"], ipython: ["IPython", "python"], julia: ["Julia", "julia"], r: ["R", "r"],
	ghci: ["Haskell", "haskell"], clojure: ["Clojure", "clojure"], clj: ["Clojure", "clojure"], ruby: ["Ruby", "ruby"],
	java: ["Java", "java"], octave: ["Octave", "octave"], matlab: ["MATLAB", "matlab"], gnuplot: ["gnuplot", "gnuplot"], cpp: ["C++", "cpp"],
};
const REPL_SEND_TOOL = /^Tool:\s*(?:functions\.)?(?:[A-Za-z0-9_.-]*?(?:__|_))?repl_send$/;
const SUBMISSION_LIMIT = 20;

export const isReplSendLabel = label => typeof label === "string" && REPL_SEND_TOOL.test(label);

/**
 * A recorded repl_send call's arguments, or null for any other shape. An omitted
 * target is the shared Python session, as in pi-repl. An unknown target keeps no
 * label or language: it is shown, never guessed.
 */
export function replSendCall(label, argumentsText) {
	if (!isReplSendLabel(label) || typeof argumentsText !== "string") return null;
	let args;
	try { args = JSON.parse(argumentsText); } catch { return null; }
	if (args === null || typeof args !== "object" || Array.isArray(args) || typeof args.code !== "string") return null;
	if (args.target !== undefined && typeof args.target !== "string") return null;
	const runtime = RUNTIMES[(args.target ?? "python").trim().toLowerCase()];
	return { args, code: args.code, label: runtime?.[0], language: runtime?.[1] };
}

/**
 * The output part of a repl_send result, matched exactly against the recorded
 * code: "[pane activity, blank line] Submitted code: <code> (blank line) Output: <output>".
 * Anything else (a truncated response, an error, another format) returns null.
 */
export function replSendOutput(resultText, code) {
	if (typeof resultText !== "string" || typeof code !== "string") return null;
	const head = `Submitted code:\n${code.trimEnd()}\n\nOutput:\n`;
	const at = resultText.indexOf(head);
	if (at < 0 || (at > 0 && resultText.slice(at - 2, at) !== "\n\n")) return null;
	return { activity: at > 0 ? resultText.slice(0, at - 2) : "", output: resultText.slice(at + head.length) };
}

/** repl_send calls among recorded events, by call ID. */
export function replSendCalls(events) {
	const calls = new Map();
	for (const event of Array.isArray(events) ? events : []) {
		if (event?.kind !== "tool" || typeof event.callId !== "string") continue;
		const call = replSendCall(event.label, event.text);
		if (call) calls.set(event.callId, call);
	}
	return calls;
}

// A fence longer than any backtick run in the text, so recorded text stays literal.
const fenced = (value, language = "") => {
	const text = value.replace(/\r\n?/g, "\n").replace(/\n$/, "");
	const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}${language}\n${text}\n${fence}`;
};

/**
 * Markdown for a folded snapshot of a turn's REPL submissions, or "" when there
 * are none. Only fixed labels are written as Markdown; recorded code and output
 * appear only inside code fences.
 */
export function replSnapshotMarkdown(events) {
	const calls = replSendCalls(events);
	if (!calls.size) return "";
	const results = new Map();
	for (const event of Array.isArray(events) ? events : []) {
		if (event?.kind === "result" && calls.has(event.callId) && !results.has(event.callId)) {
			results.set(event.callId, { text: typeof event.text === "string" ? event.text : "", error: /\(error\)/.test(event.label ?? "") });
		}
	}
	const submissions = [...calls.entries()];
	const shown = submissions.slice(0, SUBMISSION_LIMIT);
	const labels = [...new Set(submissions.map(([, call]) => call.label ?? "REPL"))];
	const count = `${submissions.length} submission${submissions.length === 1 ? "" : "s"}`;
	const body = shown.map(([id, call], i) => {
		const heading = `**${i + 1}** · ${call.label ?? "Unrecognised target"}`;
		const result = results.get(id);
		if (!result) return `${heading}\n\n${fenced(call.code, call.language)}\n\n*No result recorded.*`;
		const text = result.text.replace(TERMINAL_SEQUENCE, "");
		const split = result.error ? null : replSendOutput(text, call.code);
		const output = split
			? `${split.activity ? `${fenced(split.activity)}\n\n` : ""}Output\n\n${fenced(split.output.trim() ? split.output : "(no output)")}`
			: `${result.error ? "Recorded result (error)" : "Recorded result"}\n\n${fenced(text.trim() ? text : "(empty)")}`;
		return `${heading}\n\n${fenced(call.code, call.language)}\n\n${output}`;
	});
	const more = submissions.length > shown.length ? [`*${submissions.length - shown.length} more in Working.*`] : [];
	return [
		`<details>`,
		`<summary>REPL · ${labels.join(", ")} · ${count} in this turn</summary>`,
		"",
		"*Recorded when this response was written; not the REPL's current state.*",
		"",
		...[...body, ...more].flatMap(part => [part, ""]),
		`</details>`,
	].join("\n");
}
