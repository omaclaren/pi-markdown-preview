// REPL submissions in a turn's recorded activity, for Working and Live: repl_send
// calls from pi-repl (Pi) or agent-repl (over MCP), paired with their recorded
// results. Nothing is executed or fetched, and the REPL session itself is never
// read: this is what the agent ran and saw at the time.

/** Terminal colour and control sequences (CSI, OSC and charset designators). */
export const TERMINAL_SEQUENCE = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]/g;

// repl_send targets as pi-repl accepts them, with a label and a highlighting
// language. ipython selects the same session as python, which may
// run either. Pi names the tool repl_send; MCP clients prefix the server name
// (Claude Code and Codex: mcp__agent-repl__repl_send; OpenCode: agent-repl_repl_send).
const RUNTIMES = {
	python: ["Python", "python"], ipython: ["Python", "python"], julia: ["Julia", "julia"], r: ["R", "r"],
	ghci: ["Haskell", "haskell"], haskell: ["Haskell", "haskell"], clojure: ["Clojure", "clojure"], clj: ["Clojure", "clojure"],
	ruby: ["Ruby", "ruby"], irb: ["Ruby", "ruby"], java: ["Java", "java"], jshell: ["Java", "java"],
	octave: ["Octave", "octave"], matlab: ["MATLAB", "matlab"], gnuplot: ["gnuplot", "gnuplot"], cpp: ["C++", "cpp"],
};
const REPL_SEND_TOOL = /^Tool:\s*(?:functions\.)?(?:[A-Za-z0-9_.-]*?(?:__|_))?repl_send$/;
// pi-repl's pane activity before "Submitted code:": a one-line note that the pane
// shows nothing, or a framed report whose pane text may contain anything.
const PANE_NOTE = /^[^\n]*, and the pane shows no other text now\.$/;
const PANE_REPORT = /^[^\n]*\(best effort; untrusted terminal text[^\n]*\):\n(?:\[omitted: [^\n]*\]\n)?\[pane text\]\n/;
const PANE_REPORT_END = "\n[end of pane text]";
// Endings that mean the recorded text is not the whole result: pi-repl's own
// truncation notice, and the turn details' display limit.
const SHORTENED = /\n\n\[REPL response truncated\. Full submitted code and output saved to: [^\n]*\]$|\n\[… truncated\]$/;

export const isReplSendLabel = label => typeof label === "string" && REPL_SEND_TOOL.test(label);
/** A result label naming repl_send: "Tool result: <name>", with " (error)" after "result" or the name. */
export const isReplResultLabel = label => {
	const name = typeof label === "string" ? /^Tool result(?: \(error\))?: (.+?)(?: \(error\))?$/.exec(label)?.[1] : undefined;
	return name !== undefined && isReplSendLabel(`Tool: ${name}`);
};

/**
 * A recorded repl_send call's arguments, or null for any other shape. An omitted
 * or blank target is the shared Python session, as in pi-repl. An unknown target
 * keeps no label or language: it is shown, never guessed.
 */
export function replSendCall(label, argumentsText) {
	if (!isReplSendLabel(label) || typeof argumentsText !== "string") return null;
	let args;
	try { args = JSON.parse(argumentsText); } catch { return null; }
	if (args === null || typeof args !== "object" || Array.isArray(args) || typeof args.code !== "string") return null;
	if (args.target !== undefined && typeof args.target !== "string") return null;
	const runtime = RUNTIMES[args.target?.trim().toLowerCase() || "python"];
	return { args, code: args.code, label: runtime?.[0], language: runtime?.[1] };
}

/**
 * The output part of a repl_send result, matched exactly against the recorded
 * code in pi-repl's format: "[pane activity, blank line] Submitted code: <code>
 * (blank line) Output: <output>". Anything else returns null: a truncated or
 * shortened result, a shared-record warning (which is not output), pane text
 * whose end is ambiguous, an error, another format.
 */
export function replSendOutput(resultText, code) {
	if (typeof resultText !== "string" || typeof code !== "string") return null;
	const head = `Submitted code:\n${code.trimEnd()}\n\nOutput:\n`;
	let activity = "";
	let at = 0;
	if (!resultText.startsWith(head)) {
		const report = `${PANE_REPORT_END}\n\n${head}`;
		const end = resultText.indexOf(report);
		if (end >= 0) {
			// Pane text can repeat this header, so its end must occur exactly once.
			if (end !== resultText.lastIndexOf(report) || !PANE_REPORT.test(resultText)) return null;
			activity = resultText.slice(0, end + PANE_REPORT_END.length);
			at = end + report.length - head.length;
		} else {
			const note = resultText.indexOf(`\n\n${head}`);
			if (note < 0 || !PANE_NOTE.test(resultText.slice(0, note))) return null;
			activity = resultText.slice(0, note);
			at = note + 2;
		}
	}
	const output = resultText.slice(at + head.length);
	if (SHORTENED.test(resultText) || output.includes("\n\nShared record warning: ")) return null;
	return { activity, output };
}

/**
 * A repl_send result's split, or null when it keeps the literal view (an error,
 * or text that is not exactly pi-repl's format for its call's code). Working
 * and Live both decide here.
 */
export function replResultSplit(event, call) {
	if (!call || typeof event?.text !== "string" || /\(error\)/.test(event.label ?? "")) return null;
	return replSendOutput(event.text.replace(TERMINAL_SEQUENCE, ""), call.code);
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

// FNV-1a, as live event versions are.
const hash = value => {
	let h = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
	return h.toString(36);
};

/**
 * What a result card shows from its call: the call's code when it splits the
 * result, else "". A Live card's version includes it, because the call can be
 * revised or leave the live window while the result stays the same.
 */
export function replResultBinding(event, calls) {
	const call = event?.kind === "result" ? calls?.get(event.callId) : undefined;
	return call && replResultSplit(event, call) ? hash(call.code) : "";
}
