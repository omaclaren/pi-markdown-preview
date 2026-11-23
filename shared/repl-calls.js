// REPL submissions in a turn's recorded activity, for Working and Live: repl_send
// calls from pi-repl (Pi) or agent-repl (over MCP), paired with their recorded
// results. Nothing is executed or fetched, and the REPL session itself is never
// read: this is what the agent ran and saw at the time.

/** Terminal colour and control sequences (CSI, OSC and charset designators). */
export const TERMINAL_SEQUENCE = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]/g;

// repl_send targets as pi-repl accepts them (and Pi Studio's shell), with a label
// and a highlighting language. ipython selects the same session as python, which
// may run either. Pi names the tool repl_send; MCP clients prefix the server name
// (Claude Code and Codex: mcp__agent-repl__repl_send; OpenCode: agent-repl_repl_send).
const RUNTIMES = {
	python: ["Python", "python"], ipython: ["Python", "python"], julia: ["Julia", "julia"], r: ["R", "r"],
	ghci: ["Haskell", "haskell"], haskell: ["Haskell", "haskell"], clojure: ["Clojure", "clojure"], clj: ["Clojure", "clojure"],
	ruby: ["Ruby", "ruby"], irb: ["Ruby", "ruby"], java: ["Java", "java"], jshell: ["Java", "java"],
	octave: ["Octave", "octave"], matlab: ["MATLAB", "matlab"], gnuplot: ["gnuplot", "gnuplot"], cpp: ["C++", "cpp"],
	shell: ["Shell", "bash"],
};
const REPL_SEND_TOOL = /^Tool:\s*(?:functions\.)?(?:[A-Za-z0-9_.-]*?(?:__|_))?repl_send$/;
// Pi Studio's studio_repl_send sends to the session it names, else to the first
// with its target's runtime, else to Studio's active session, which isn't recorded.
const STUDIO_SEND_TOOL = /^Tool:\s*(?:functions\.)?studio_repl_send$/;
// Session names as Studio reads them: pi-repl-julia, pi-studio-repl-julia[-suffix].
const SESSION_NAME = /^pi-(?:studio-)?repl-([a-z0-9-]+)$/i;
const sessionRuntime = name => {
	const raw = SESSION_NAME.exec(name)?.[1].toLowerCase();
	return raw ? Object.keys(RUNTIMES).find(key => raw === key || raw.startsWith(`${key}-`)) : undefined;
};
// pi-repl's pane activity before "Submitted code:": a one-line note that the pane
// shows nothing, or a framed report whose pane text may contain anything.
const PANE_NOTE = /^[^\n]*, and the pane shows no other text now\.$/;
const PANE_REPORT = /^([^\n]*\(best effort; untrusted terminal text[^\n]*\):)\n(?:(\[omitted: [^\n]*\])\n)?\[pane text\]\n/;
const PANE_REPORT_END = "\n[end of pane text]";
// While its record activity is on (the default from pi-repl 0.12.0, and in agent-repl),
// pi-repl names the agent's own record entry after any pane activity, just before
// "Submitted code:". The ID's characters are pi-repl's, so the line is one line.
const OWN_ENTRY = /Recorded as entry [A-Za-z0-9_.:-]{1,240}\.\n\n/y;
// Endings that mean the recorded text is not the whole result: pi-repl's own
// truncation notice (its path can be any text), and the turn details' display limit.
const SHORTENED = /\n\n\[REPL response truncated\. Full submitted code and output saved to: [^]*\]$|\n\[… truncated\]$/;

export const isReplSendLabel = label => typeof label === "string" && REPL_SEND_TOOL.test(label);
/** A result label naming repl_send: "Tool result: <name>", with " (error)" after "result" or the name. */
export const isReplResultLabel = label => {
	const name = typeof label === "string" ? /^Tool result(?: \(error\))?: (.+?)(?: \(error\))?$/.exec(label)?.[1] : undefined;
	return name !== undefined && isReplSendLabel(`Tool: ${name}`);
};

/**
 * A recorded repl_send call's arguments, or null for any other shape. An omitted
 * or blank target is the shared Python session, as in pi-repl. A Studio call takes
 * its runtime from the session it names, else its target; with neither, it has
 * none. An unknown target keeps no label or language: it is shown, never guessed.
 */
export function replSendCall(label, argumentsText) {
	if (!isReplSendLabel(label) || typeof argumentsText !== "string") return null;
	let args;
	try { args = JSON.parse(argumentsText); } catch { return null; }
	if (args === null || typeof args !== "object" || Array.isArray(args) || typeof args.code !== "string") return null;
	if (args.target !== undefined && typeof args.target !== "string") return null;
	let target = args.target?.trim().toLowerCase() || "python";
	if (STUDIO_SEND_TOOL.test(label)) {
		if (args.sessionName !== undefined && typeof args.sessionName !== "string") return null;
		const session = args.sessionName?.trim();
		target = session ? sessionRuntime(session) : args.target?.trim().toLowerCase();
	}
	const runtime = target ? RUNTIMES[target] : undefined;
	return { args, code: args.code, label: runtime?.[0], language: runtime?.[1] };
}

/**
 * The output part of a repl_send result, matched exactly against the recorded
 * code in pi-repl's format: "[pane activity, blank line] [Recorded as entry <id>.,
 * blank line] Submitted code: <code> (blank line) Output: <output>". Anything
 * else returns null: a truncated or shortened result, a shared-record warning
 * (which is not output), pane text whose end is ambiguous, a report of other
 * clients' recorded activity, an error, another format.
 */
export function replSendOutput(resultText, code) {
	if (typeof resultText !== "string" || typeof code !== "string") return null;
	// Where a header starts if one follows `from`, after the own-entry line if any;
	// else -1. Whose code it names is checked once its place is settled.
	const headerAt = from => {
		OWN_ENTRY.lastIndex = from;
		const at = OWN_ENTRY.test(resultText) ? OWN_ENTRY.lastIndex : from;
		return resultText.startsWith("Submitted code:\n", at) ? at : -1;
	};
	let activity = "";
	let at = -1;
	if (PANE_REPORT.test(resultText)) {
		// Pane text and output can repeat the frame's end and a header, so the frame
		// must end before a header exactly once, whatever code that header names.
		const close = `${PANE_REPORT_END}\n\n`;
		for (let i = resultText.indexOf(close); i >= 0; i = resultText.indexOf(close, i + 1)) {
			const found = headerAt(i + close.length);
			if (found < 0) continue;
			if (at >= 0) return null;
			activity = resultText.slice(0, i + PANE_REPORT_END.length);
			at = found;
		}
	} else {
		// A one-line note, or nothing, before the header.
		const line = resultText.indexOf("\n\n");
		const note = line >= 0 && PANE_NOTE.test(resultText.slice(0, line));
		if (note) activity = resultText.slice(0, line);
		at = headerAt(note ? line + 2 : 0);
	}
	const head = `Submitted code:\n${code.trimEnd()}\n\nOutput:\n`;
	if (at < 0 || !resultText.startsWith(head, at)) return null;
	const output = resultText.slice(at + head.length);
	if (SHORTENED.test(resultText) || output.includes("\n\nShared record warning: ")) return null;
	return { activity, output };
}

/**
 * The parts of a split's framed pane report: its heading, the omitted-text note if
 * any, and the pane text between the markers. Null for a one-line note or none.
 */
export function replPaneActivity(activity) {
	const report = typeof activity === "string" && activity.endsWith(PANE_REPORT_END) ? PANE_REPORT.exec(activity) : null;
	return report ? { heading: report[1], omitted: report[2] ?? "", text: activity.slice(report[0].length, -PANE_REPORT_END.length) } : null;
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

/**
 * repl_send calls among recorded events, by call ID, each with its card's number:
 * `first` is the number of the first event (Live counts the events it omits).
 */
export function replSendCalls(events, first = 1) {
	const calls = new Map();
	(Array.isArray(events) ? events : []).forEach((event, i) => {
		if (event?.kind !== "tool" || typeof event.callId !== "string") return;
		const call = replSendCall(event.label, event.text);
		if (call) calls.set(event.callId, { ...call, number: first + i });
	});
	return calls;
}

// FNV-1a, as live event versions are.
const hash = value => {
	let h = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
	return h.toString(36);
};

/**
 * What a result card shows from its call: the call's number and code when it
 * splits the result, else "". A Live card's version includes it, because the call
 * can be revised or leave the live window while the result stays the same.
 */
export function replResultBinding(event, calls) {
	const call = event?.kind === "result" ? calls?.get(event.callId) : undefined;
	return call && replResultSplit(event, call) ? hash(`${call.number ?? ""}\n${call.code}`) : "";
}
