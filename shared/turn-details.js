// Read-only projections of recorded turns, not reconstructions of model context.
// Never expose system/developer messages or opaque signatures. Only bounded,
// inline raster images from explicit tool results are admitted.
import { createRecordedImageBudget, recordedImage } from "./recorded-images.js";
import { questionAnswers, recordedQuestionAnswers } from "./ask-user-question.js";
import { createClaudeResponseAssembler, isClaudeFinal } from "./claude-response.js";
export const TURN_EVENT_LIMIT = 250;
export const TURN_TEXT_LIMIT = 16_384;
export const TURN_TOTAL_LIMIT = 256 * 1024;
const text = value => typeof value === "string" ? value : "";
const blocks = value => Array.isArray(value) ? value : typeof value === "string" ? [{ type: "text", text: value }] : [];
const textOf = value => blocks(value).filter(b => ["text", "input_text", "output_text"].includes(b?.type) && text(b.text).trim()).map(b => b.text).join("\n\n");
const injected = value => /^\s*(?:<(?:system-reminder|user_instructions|environment_context|permissions_instructions)\b|# AGENTS\.md instructions\b)/i.test(text(value));
const json = value => typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2);

export function createTurnDetails(notices = []) {
	/** @type {{ events: { kind: string, label: string, text: string, callId?: string, images?: object[], questionAnswers?: string }[], notices: string[], sourceAgent?: string }} */
	const result = { events: [], notices: [...notices] };
	let size = 0;
	const imageBudget = createRecordedImageBudget();
	const toolNames = new Map();
	const note = message => { if (!result.notices.includes(message)) result.notices.push(message); };
	const add = (kind, label, value, callId, images = [], answers = "") => {
		if (result.events.length >= TURN_EVENT_LIMIT) { note("Display limits reached; some recorded events are omitted."); return; }
		const admitted = kind === "result" && Array.isArray(images) ? images.slice(0, 9).flatMap(image => {
			const accepted = imageBudget.take(image); return accepted ? [accepted] : [];
		}) : [];
		if (admitted.some(image => 'unavailable' in image)) note("Some image/file attachments are omitted or unavailable.");
		const source = text(value);
		const available = Math.max(0, Math.min(TURN_TEXT_LIMIT, TURN_TOTAL_LIMIT - size));
		if (!available && source.trim()) note("Display limits reached; some recorded text is omitted.");
		const clipped = source.length > available;
		const body = !available && source.trim() ? "[… recorded text omitted: display limit reached]" : source.slice(0, available) + (clipped && available ? "\n[… truncated]" : "");
		let answerData = "";
		if (kind === "result" && typeof callId === "string" && callId.length <= 160
			&& /^(?:functions\.)?AskUserQuestion$/i.test(toolNames.get(callId) ?? "")
			&& typeof answers === "string" && answers.length <= Math.min(TURN_TEXT_LIMIT, TURN_TOTAL_LIMIT - size - body.length)) {
			try { if (questionAnswers(JSON.parse(answers))) answerData = answers; } catch { /* Keep the literal recorded output. */ }
		}
		if ((!source.trim() || !available) && !admitted.length && !answerData) return;
		if (clipped) note("Long entries are truncated. This is not the complete session transcript.");
		size += body.length + answerData.length;
		const call = text(callId).slice(0, 160);
		if (kind === "tool" && call) toolNames.set(call, text(label).replace(/^Tool:\s*/, "").slice(0, 100));
		const displayLabel = kind === "result" && toolNames.has(call) && /^Tool result(?: \(error\))?$/.test(label) ? `${label}: ${toolNames.get(call)}` : label;
		result.events.push({ kind, label: text(displayLabel).slice(0, 160), text: body, ...(call ? { callId: call } : {}), ...(admitted.length ? { images: admitted } : {}), ...(answerData ? { questionAnswers: answerData } : {}) });
	};
	const toolResult = (label, value, callId, attachments = [], answerMetadata) => {
		const images = [];
		outer: for (const source of [value, attachments]) for (const b of blocks(source)) {
			const image = recordedImage(b);
			if (image) { images.push(image); if (images.length >= 9) break outer; }
			else if (["file", "document"].includes(b?.type)) note("Non-image file attachments are omitted.");
		}
		add("result", label, textOf(value), callId, images, recordedQuestionAnswers(answerMetadata));
	};
	const content = (value, role, final = false, answerMetadata) => {
		for (const b of blocks(value)) {
			if (!b || typeof b !== "object") continue;
			if (["text", "input_text", "output_text"].includes(b.type)) {
				if (role === "user" && injected(b.text)) { note("Known harness-injected context is omitted; it is not labelled as a user prompt."); continue; }
				if (!final) add(role === "user" ? "prompt" : "progress", role === "user" ? "Prompt / input" : "Assistant progress", b.text);
			} else if (["thinking", "reasoning"].includes(b.type)) {
				if (b.redacted) note("Redacted reasoning is not available.");
				else add("reasoning", "Recorded thinking / reasoning", b.thinking ?? b.text);
			} else if (b.type === "redacted_thinking") note("Redacted reasoning is not available.");
			else if (["tool_use", "toolCall"].includes(b.type)) add("tool", `Tool: ${text(b.name)}`, json(b.input ?? b.arguments), b.id);
			else if (b.type === "tool_result") {
				toolResult(b.is_error ? "Tool result (error)" : "Tool result", b.content, b.tool_use_id, [], b.is_error ? undefined : answerMetadata);
			}
			else if (["image", "input_image", "document", "file"].includes(b.type)) note("Prompt and non-tool-result attachments are omitted.");
		}
	};
	return { result, add, note, content, toolResult };
}

const isFinal = (agent, e) => agent === "pi" ? e.type === "message" && e.message?.role === "assistant" && e.message.stopReason === "stop"
	: isClaudeFinal(e);
const isBoundary = (agent, e) => agent === "pi"
	? e.type === "message" && e.message?.role === "assistant" && ["stop", "length", "error", "aborted"].includes(e.message.stopReason)
	: isFinal(agent, e) || e.isApiErrorMessage === true || (e.type === "user" && /^\[Request interrupted by user(?: for tool use)?\]$/.test(textOf(e.message?.content).trim()));
const keyOf = (agent, e) => agent === "pi" ? `pi:${e.id ?? e.timestamp ?? ""}` : `claude:${e.message?.id ?? e.uuid ?? ""}`;

// Claude records user-entered ! commands and local command output as user
// messages. Match only one complete, unambiguous wrapper per record: a repeated
// or nested copy of the same tag leaves the whole record literal. Do not
// interpret arbitrary embedded XML or confuse these with assistant Bash calls.
// Slash-command records stay prompts; the page presents them compactly.
function claudeContent(t, value, role, final, answerMetadata) {
	const unwrap = (source, tag) => {
		if (!source.startsWith(`<${tag}>`) || !source.endsWith(`</${tag}>`)) return null;
		const inner = source.slice(tag.length + 2, -(tag.length + 3));
		return inner.includes(`<${tag}>`) || inner.includes(`</${tag}>`) ? null : inner;
	};
	for (const block of blocks(value)) {
		const source = role === "user" && ["text", "input_text"].includes(block?.type) ? text(block.text).trim() : "";
		const command = unwrap(source, "bash-input");
		// Literal bounded scans avoid regex backtracking on large malformed output.
		const split = source.indexOf("</bash-stdout>");
		const stdout = split < 0 ? null : unwrap(source.slice(0, split + "</bash-stdout>".length), "bash-stdout");
		const stderr = split < 0 ? null : unwrap(source.slice(split + "</bash-stdout>".length).trim(), "bash-stderr");
		const localStdout = unwrap(source, "local-command-stdout"), localStderr = unwrap(source, "local-command-stderr");
		if (command !== null) t.add("tool", "User shell command", command);
		else if (stdout !== null && stderr !== null) {
			t.add("result", "Shell stdout", stdout); t.add("result", "Shell stderr", stderr);
			if (!stdout.trim() && !stderr.trim()) t.note("A user shell command has no recorded text output.");
		} else if (localStdout !== null) t.add("result", "Command output", localStdout);
		else if (localStderr !== null) t.add("result", "Command error output", localStderr);
		else t.content([block], role, final, answerMetadata);
	}
}

/** Bounded records supplied by the host; target is a retained completed response. */
export function turnDetailsFromRecords(agent, records, target, incomplete = false) {
	const t = createTurnDetails(incomplete ? ["Only a bounded portion of the session was read; earlier or oversized records may be missing."] : []);
	// Presentation hints come from the selected reader, never from prompt text.
	if (["pi", "claude", "codex"].includes(agent)) t.result.sourceAgent = agent;
	if (agent === "codex") return codexDetails(records, target, t);
	if (!["pi", "claude"].includes(agent)) { t.note("Turn details are unavailable for this session format."); return t.result; }
	const rows = records.filter(e => e && typeof e === "object" && e.isSidechain !== true);
	let end = -1;
	for (let i = 0; i < rows.length; i++) if (isFinal(agent, rows[i]) && keyOf(agent, rows[i]) === target.key) end = i;
	if (end < 0) { t.note("This response is no longer available in the bounded session history."); return t.result; }
	let finalText = agent === "pi" ? textOf(rows[end].message.content) : undefined;
	if (agent === "claude") {
		const assemble = createClaudeResponseAssembler();
		for (let i = 0; i <= end; i++) {
			const response = assemble(rows[i]);
			if (i === end) finalText = response?.key === target.key ? response.markdown : undefined;
		}
	}
	if (finalText === undefined || finalText.trim() !== target.markdown.trim()) { t.note("The recorded answer has changed; details cannot be matched to this preview snapshot."); return t.result; }
	const idField = agent === "pi" ? "id" : "uuid", parentField = agent === "pi" ? "parentId" : "parentUuid";
	const ids = new Map(rows.slice(0, end + 1).map((e, i) => [e[idField], i]).filter(([id]) => typeof id === "string"));
	const selected = new Set();
	let index = end, boundary = false;
	while (index >= 0 && !selected.has(index)) {
		const e = rows[index];
		if (index !== end && isBoundary(agent, e) && keyOf(agent, e) !== target.key) {
			if (!isFinal(agent, e)) t.note("Earlier activity before a recorded interruption/failure is omitted.");
			boundary = true; break;
		}
		selected.add(index);
		if (e.type === "compaction" || e.type === "branch_summary" || e.subtype === "compact_boundary") {
			t.note("A compaction/branch boundary occurs here; earlier working and the full model context are not reconstructed."); boundary = true; break;
		}
		if (e[parentField] === null) { boundary = true; break; }
		if (typeof e[parentField] !== "string" || !ids.has(e[parentField])) break;
		index = ids.get(e[parentField]);
	}
	if (!boundary) t.note("The recorded parent chain is incomplete; unrelated branches have not been included.");
	// Claude parallel results can be siblings rather than parents of the final
	// answer. Include only results for calls belonging to this exact ancestry.
	if (agent === "claude") {
		const messageIds = new Set([...selected].filter(i => rows[i].type === "assistant").map(i => rows[i].message?.id).filter(Boolean));
		for (let i = Math.min(...selected); i <= end; i++) if (rows[i].type === "assistant" && messageIds.has(rows[i].message?.id)) selected.add(i);
		const calls = new Set([...selected].flatMap(i => blocks(rows[i].message?.content).filter(b => b?.type === "tool_use").map(b => b.id)));
		const start = Math.min(...selected);
		for (let i = start; i <= end; i++) if (rows[i].type === "user" && blocks(rows[i].message?.content).some(b => b?.type === "tool_result" && calls.has(b.tool_use_id))) selected.add(i);
	}
	for (const i of [...selected].sort((a, b) => a - b)) {
		const e = rows[i], m = e.message;
		if (e.isMeta === true || e.isCompactSummary === true) { t.note("Known harness-injected context is omitted; it is not labelled as a user prompt."); continue; }
		if (e.type === "context_edit") { t.note("Context edits were recorded. This view shows recorded activity, not the exact edited model input."); continue; }
		if (!m || !["user", "assistant", "toolResult", "bashExecution"].includes(m.role)) continue;
		if (m.role === "toolResult") {
			t.toolResult(`Tool result: ${text(m.toolName)}${m.isError ? " (error)" : ""}`, m.content, m.toolCallId);
		} else if (m.role === "bashExecution") {
			t.add("tool", "User shell command", m.command); t.add("result", "Shell output", m.output);
		} else if (agent === "claude") claudeContent(t, m.content, m.role, m.role === "assistant" && keyOf(agent, e) === target.key,
			// A record-level sidecar cannot be assigned among multiple results.
			blocks(m.content).filter(b => b?.type === "tool_result").length === 1 ? e.toolUseResult : undefined);
		else t.content(m.content, m.role, m.role === "assistant" && keyOf(agent, e) === target.key);
	}
	if (!t.result.events.some(e => e.kind === "prompt" || e.label === "User shell command")) t.note("The input prompt is not available in this recorded portion of the turn.");
	return t.result;
}

function codexDetails(rows, target, t) {
	let end = -1;
	for (let i = 0; i < rows.length; i++) {
		const e = rows[i], p = e?.payload;
		if (e?.type === "event_msg" && p?.type === "task_complete" && `codex:${p.turn_id ?? e.timestamp ?? ""}` === target.key) end = i;
	}
	if (end < 0 || rows[end].payload.last_agent_message?.trim() !== target.markdown.trim()) { t.note("The completed turn cannot be matched to this preview snapshot in the bounded history."); return t.result; }
	let start = end;
	while (start > 0) {
		const e = rows[start - 1], p = e?.payload;
		if (e?.type === "event_msg" && ["task_complete", "task_aborted", "turn_aborted"].includes(p?.type)) break;
		start--;
		if (e?.type === "event_msg" && p?.type === "task_started") {
			if (p.turn_id && `codex:${p.turn_id}` !== target.key) { t.note("The recorded turn boundary does not match this response."); return t.result; }
			break;
		}
	}
	const slice = rows.slice(start, end);
	if (slice[0]?.payload?.type !== "task_started") t.note("The turn-start marker is missing; only recorded activity after the preceding completion is shown.");
	const responseItems = slice.filter(e => e?.type === "response_item").map(e => e.payload);
	const recordedText = role => new Set(responseItems.filter(p => p?.type === "message" && p.role === role).map(p => textOf(p.content).trim()));
	const userTexts = recordedText("user"), assistantTexts = recordedText("assistant");
	const summaries = new Set(responseItems.filter(p => p?.type === "reasoning").flatMap(p => Array.isArray(p.summary) ? p.summary.map(b => text(b?.text).trim()) : []));
	for (const e of slice) {
		const p = e?.payload;
		if (!p) continue;
		if (e.type === "response_item") {
			if (p.type === "message" && ["user", "assistant"].includes(p.role)) t.content(p.content, p.role, p.role === "assistant" && (p.phase === "final_answer" || textOf(p.content).trim() === target.markdown.trim()));
			else if (p.type === "reasoning") {
				for (const b of Array.isArray(p.summary) ? p.summary : []) t.add("reasoning", "Recorded reasoning summary", b.text);
				if (p.encrypted_content) t.note("Opaque/encrypted reasoning is not available; only recorded summaries are shown.");
			} else if (["function_call", "custom_tool_call"].includes(p.type)) t.add("tool", `Tool: ${text(p.name)}`, json(p.arguments ?? p.input), p.call_id);
			else if (["function_call_output", "custom_tool_call_output"].includes(p.type)) t.toolResult("Tool result", p.output, p.call_id);
		} else if (e.type === "event_msg") {
			if (p.type === "user_message" && !userTexts.has(text(p.message).trim())) t.content(p.message, "user");
			if (p.type === "agent_message" && !assistantTexts.has(text(p.message).trim()) && text(p.message).trim() !== target.markdown.trim()) t.add("progress", "Assistant progress", p.message);
			if (p.type === "agent_reasoning" && !summaries.has(text(p.text).trim())) t.add("reasoning", "Recorded reasoning summary", p.text);
			if (["context_compacted", "thread_rolled_back"].includes(p.type)) t.note("Context was compacted or rolled back during this turn; this is recorded activity, not an exact model-input reconstruction.");
		}
	}
	if (!t.result.events.some(e => e.kind === "prompt")) t.note("The input prompt is not available in this recorded portion of the turn.");
	return t.result;
}
