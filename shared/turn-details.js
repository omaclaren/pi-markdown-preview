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

/**
 * Limits default to the retrospective view; live projection keeps its own
 * window and bounds the call names it remembers for labelling results.
 */
export function createTurnDetails(notices = [], { eventLimit = TURN_EVENT_LIMIT, totalLimit = TURN_TOTAL_LIMIT, toolNameLimit = Infinity } = {}) {
	/** @type {{ events: { kind: string, label: string, text: string, callId?: string, images?: object[], questionAnswers?: string }[], notices: string[], sourceAgent?: string }} */
	const result = { events: [], notices: [...notices] };
	let size = 0;
	const imageBudget = createRecordedImageBudget();
	const toolNames = new Map();
	const note = message => { if (!result.notices.includes(message)) result.notices.push(message); };
	const add = (kind, label, value, callId, images = [], answers = "") => {
		if (result.events.length >= eventLimit) { note("Display limits reached; some recorded events are omitted."); return; }
		const admitted = kind === "result" && Array.isArray(images) ? images.slice(0, 9).flatMap(image => {
			const accepted = imageBudget.take(image); return accepted ? [accepted] : [];
		}) : [];
		if (admitted.some(image => 'unavailable' in image)) note("Some image/file attachments are omitted or unavailable.");
		const source = text(value);
		const available = Math.max(0, Math.min(TURN_TEXT_LIMIT, totalLimit - size));
		if (!available && source.trim()) note("Display limits reached; some recorded text is omitted.");
		const clipped = source.length > available;
		const body = !available && source.trim() ? "[… recorded text omitted: display limit reached]" : source.slice(0, available) + (clipped && available ? "\n[… truncated]" : "");
		let answerData = "";
		if (kind === "result" && typeof callId === "string" && callId.length <= 160
			&& /^(?:functions\.)?AskUserQuestion$/i.test(toolNames.get(callId) ?? "")
			&& typeof answers === "string" && answers.length <= Math.min(TURN_TEXT_LIMIT, totalLimit - size - body.length)) {
			try { if (questionAnswers(JSON.parse(answers))) answerData = answers; } catch { /* Keep the literal recorded output. */ }
		}
		if ((!source.trim() || !available) && !admitted.length && !answerData) return;
		if (clipped) note("Long entries are truncated. This is not the complete session transcript.");
		size += body.length + answerData.length;
		const call = text(callId).slice(0, 160);
		if (kind === "tool" && call) {
			toolNames.delete(call);
			toolNames.set(call, text(label).replace(/^Tool:\s*/, "").slice(0, 100));
			if (toolNames.size > toolNameLimit) toolNames.delete(toolNames.keys().next().value);
		}
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
		if (e.type === "response_item") codexItem(t, p, p.type === "message" && p.role === "assistant" && (p.phase === "final_answer" || textOf(p.content).trim() === target.markdown.trim()));
		else if (e.type === "event_msg") {
			if (p.type === "user_message" && !userTexts.has(text(p.message).trim())) t.content(p.message, "user");
			if (p.type === "agent_message" && !assistantTexts.has(text(p.message).trim()) && text(p.message).trim() !== target.markdown.trim()) t.add("progress", "Assistant progress", p.message);
			if (p.type === "agent_reasoning" && !summaries.has(text(p.text).trim())) t.add("reasoning", "Recorded reasoning summary", p.text);
			if (["context_compacted", "thread_rolled_back"].includes(p.type)) t.note("Context was compacted or rolled back during this turn; this is recorded activity, not an exact model-input reconstruction.");
		}
	}
	if (!t.result.events.some(e => e.kind === "prompt")) t.note("The input prompt is not available in this recorded portion of the turn.");
	return t.result;
}

/** One Codex response item; `final` marks the retained answer, which Preview shows. */
function codexItem(t, p, final = false) {
	if (p.type === "message" && ["user", "assistant"].includes(p.role)) t.content(p.content, p.role, final);
	else if (p.type === "reasoning") {
		for (const b of Array.isArray(p.summary) ? p.summary : []) t.add("reasoning", "Recorded reasoning summary", b?.text);
		if (p.encrypted_content) t.note("Opaque/encrypted reasoning is not available; only recorded summaries are shown.");
	} else if (["function_call", "custom_tool_call"].includes(p.type)) t.add("tool", `Tool: ${text(p.name)}`, json(p.arguments ?? p.input), p.call_id);
	else if (["function_call_output", "custom_tool_call_output"].includes(p.type)) t.toolResult("Tool result", p.output, p.call_id);
}

// ---- Live: recorded activity of one in-progress turn (Claude Code, Pi and Codex) ----
// Records are pushed in file order as they become readable. These agents append
// records and never rewrite one: an id names one record's content for good, so a
// repeated id (backfill and subscription overlap) is ignored. A Claude message's
// blocks and its recorded end arrive as separate records with their own uuids; a
// Pi message arrives whole, with its stop reason; a Codex task records its start
// and end as events around its items.
// Membership follows each record's own links, not its position: a record joins
// the turn of the call it answers or of its recorded parent, so a late result of
// a finished turn never becomes another turn's activity. A prompt or task
// notification starts a turn. Local commands and their output (/theme, !ls) wait
// as context for the next turn and never start one themselves. Completion comes
// only from an explicit recorded end; silence means nothing.
export const LIVE_EVENT_WINDOW = 250;
/** A turn's cards are bounded by UTF-8 size as well as count; two turns are kept. */
export const LIVE_TURN_BYTES = 3 * 1024 * 1024;
const LIVE_TURNS_KEPT = 2;
// Remembered uuids (dedupe and ancestry) and call ids (exact result membership).
const LIVE_RECORD_LIMIT = 10_000;
const LIVE_CALL_LIMIT = 2 * LIVE_EVENT_WINDOW;
// Local-command context waiting for the next turn.
const LIVE_HELD_EVENTS = 20;
const LIVE_HELD_BYTES = 256 * 1024;
const LIVE_HELD_LINKS = 100;
const LIVE_INTERRUPTION = /^\[Request interrupted by user(?: for tool use)?\]$/;
// Endings a recorded reply can continue from: Pi retries after an API error or
// after compacting at the output limit, without another prompt.
const LIVE_RECOVERABLE = new Set(["error", "incomplete"]);
const LIVE_CONTEXT_WRAPPER = /^<(?:command-(?:name|message|args)|bash-input|bash-stdout|local-command-stdout|local-command-stderr)>/;

// FNV-1a over the projected fields: a version changes only when a card's content does.
function liveEventVersion(event) {
	const images = (event.images ?? []).map(image => image.unavailable ?? `${image.mimeType}:${image.byteLength}:${image.data?.length}`);
	const source = JSON.stringify([event.kind, event.label, event.text, event.callId ?? "", event.questionAnswers ?? "", images, event.pending === true]);
	let hash = 0x811c9dc5;
	for (let i = 0; i < source.length; i++) { hash ^= source.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
	return hash.toString(36);
}

function utf8Bytes(value) {
	let bytes = 0;
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xdc00 ? 4 : c >= 0xdc00 && c < 0xe000 ? 0 : 3;
	}
	return bytes;
}
const liveEventBytes = event => 64 + utf8Bytes(text(event.text)) + utf8Bytes(text(event.label)) + utf8Bytes(text(event.questionAnswers))
	+ (event.images ?? []).reduce((total, image) => total + (image.data?.length ?? 0), 0);

function claudeLiveRole(e) {
	if (!e || typeof e !== "object" || e.isSidechain === true) return "skip";
	if (e.type === "assistant") return "activity";
	if (e.type === "system" && e.subtype === "compact_boundary") return "compaction";
	if (e.type !== "user") return "skip";
	if (e.isMeta === true || e.isCompactSummary === true) return "meta";
	const content = blocks(e.message?.content);
	if (content.length && content.every(b => b?.type === "tool_result")) return "activity";
	const source = textOf(e.message?.content).trim();
	if (!source || injected(source)) return "meta";
	if (LIVE_INTERRUPTION.test(source)) return "interrupted";
	if (LIVE_CONTEXT_WRAPPER.test(source)) return "context";
	return "start";
}

// Pi: whole messages with id/parentId links. A user message starts a turn; a !
// command (bashExecution) is context; extension messages are not shown.
function piLiveRole(e) {
	if (!e || typeof e !== "object") return "skip";
	if (e.type === "compaction") return "compaction";
	if (e.type !== "message") return "skip";
	const role = e.message?.role;
	if (role === "assistant" || role === "toolResult") return "activity";
	if (role === "bashExecution") return "context";
	if (role !== "user") return "skip";
	return injected(textOf(e.message.content)) ? "meta" : "start";
}

// Codex: rollout lines without record ids or parent links. A task, from
// task_started to task_complete or turn_aborted, is the turn. The records the
// running task writes about itself name it (turn_id); a late command completion
// (item_completed) can name an earlier task, so it names none here. Items carry
// no turn id: they join the running task in file order, and a tool result joins
// its call's turn. Items are read from response_item records only: item_completed
// and the older user/agent event messages repeat them. Maintenance tasks
// (compaction) have no prompt and no final answer.
const CODEX_TURN_ID = /^[A-Za-z0-9_-]{1,100}$/;
const CODEX_ITEMS = new Set(["reasoning", "function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"]);
const CODEX_TASK_EVENTS = new Set(["task_started", "task_complete", "turn_aborted", "task_aborted"]);
const codexTask = e => e?.type === "event_msg" && e.payload?.type === "task_started";
const codexTurn = e => typeof e?.payload?.turn_id === "string" && CODEX_TURN_ID.test(e.payload.turn_id) ? `turn-${e.payload.turn_id}` : undefined;
const codexNamedTask = e => (e?.type === "event_msg" ? CODEX_TASK_EVENTS.has(e.payload?.type) : ["turn_context", "token_usage_record"].includes(e?.type)) ? codexTurn(e) : undefined;
function codexLiveId(e) {
	if (!e || typeof e !== "object") return undefined;
	if (codexTask(e) && codexTurn(e)) return codexTurn(e);
	if (Number.isSafeInteger(e.ordinal) && e.ordinal >= 0) return `o${e.ordinal}`;
	// Older rollouts number no records: the record's content names it.
	const source = JSON.stringify(e);
	let a = 0x811c9dc5, b = 0x050c5d1f;
	for (let i = 0; i < source.length; i++) {
		const c = source.charCodeAt(i);
		a = Math.imul(a ^ c, 0x01000193) >>> 0; b = Math.imul(b ^ c, 0x01000193) >>> 0;
	}
	return `c${a.toString(36)}-${b.toString(36)}-${source.length.toString(36)}`;
}
function codexLiveRole(e) {
	if (!e || typeof e !== "object") return "skip";
	const p = e.payload;
	if (e.type === "compacted") return "compaction";
	if (e.type === "event_msg") {
		if (p?.type === "task_started") return "start";
		if (p?.type === "context_compacted") return "compaction";
		return ["task_complete", "turn_aborted", "task_aborted"].includes(p?.type) ? "activity" : "skip";
	}
	if (e.type !== "response_item") return "skip";
	// Developer messages are never shown.
	if (p?.type === "message") return ["user", "assistant"].includes(p.role) ? "activity" : "skip";
	return CODEX_ITEMS.has(p?.type) ? "activity" : "skip";
}

// How each format names, links, projects and ends its records. The turn logic is shared.
// `task`, where a format records one, is the task a record names: it is kept on the
// turn, so placement by name never depends on the bounded record memory.
const LIVE_FORMATS = {
	claude: {
		id: e => e?.uuid,
		parent: e => e.parentUuid ?? e.logicalParentUuid,
		linked: e => "parentUuid" in e || "logicalParentUuid" in e,
		role: claudeLiveRole,
		/** [block index, call id] for each tool result in the record. */
		results: e => e.type !== "user" ? [] : blocks(e.message?.content).flatMap((b, i) => b?.type === "tool_result" && typeof b.tool_use_id === "string" ? [[i, b.tool_use_id.slice(0, 160)]] : []),
		project(details, e, block) {
			const m = e.message;
			if (!m || !["user", "assistant"].includes(m.role)) return;
			// One block of a record split between turns gets no record-level sidecar.
			const content = block === undefined ? m.content : [blocks(m.content)[block]];
			claudeContent(details, content, m.role, false, block === undefined && blocks(content).filter(b => b?.type === "tool_result").length === 1 ? e.toolUseResult : undefined);
		},
		reply: e => e.type === "assistant",
		ending: e => e.isApiErrorMessage === true ? "error" : isClaudeFinal(e) ? "completed" : undefined,
		finalKey: e => `claude:${e.message?.id ?? e.uuid}`,
	},
	pi: {
		id: e => e?.id,
		parent: e => e.parentId,
		linked: e => "parentId" in e,
		role: piLiveRole,
		results: e => e.message?.role === "toolResult" && typeof e.message.toolCallId === "string" ? [[undefined, e.message.toolCallId.slice(0, 160)]] : [],
		project(details, e) {
			const m = e.message;
			if (e.type !== "message" || !m) return;
			if (m.role === "toolResult") details.toolResult(`Tool result: ${text(m.toolName)}${m.isError ? " (error)" : ""}`, m.content, m.toolCallId);
			else if (m.role === "bashExecution") { details.add("tool", "User shell command", m.command); details.add("result", "Shell output", m.output); }
			else if (["user", "assistant"].includes(m.role)) details.content(m.content, m.role);
		},
		reply: e => e.message?.role === "assistant",
		ending: e => e.message?.role !== "assistant" ? undefined : ({ stop: "completed", error: "error", aborted: "interrupted", length: "incomplete" })[e.message.stopReason],
		finalKey: e => `pi:${e.id}`,
	},
	codex: {
		id: codexLiveId,
		parent: () => undefined,
		// A task start never steers a running task.
		linked: e => codexTask(e) || codexTurn(e) !== undefined,
		task: codexNamedTask,
		role: codexLiveRole,
		results: e => e.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(e.payload?.type) && typeof e.payload.call_id === "string" ? [[undefined, e.payload.call_id.slice(0, 160)]] : [],
		project(details, e) { if (e.type === "response_item" && e.payload) codexItem(details, e.payload); },
		// No continuation after a recorded end was observed; an error stays an error.
		reply: () => false,
		ending(e) {
			const p = e.payload;
			if (e.type !== "event_msg") return undefined;
			if (p?.type === "task_complete") return p.error != null ? "error" : "completed";
			if (["turn_aborted", "task_aborted"].includes(p?.type)) return "interrupted";
		},
		// The session reader's key, only when the task recorded an answer to preview.
		finalKey(e) {
			const p = e.payload, turn = typeof p?.turn_id === "string" ? p.turn_id : e.timestamp;
			return typeof p?.last_agent_message === "string" && p.last_agent_message.trim() && turn !== undefined ? `codex:${turn}` : undefined;
		},
	},
};

/**
 * Incremental, bounded projection of the latest turns of one Claude Code, Pi or Codex session.
 * `partialStart`: the records begin partway through the session (a bounded
 * backfill), so activity before the first retained prompt forms a turn whose
 * prompt is not retained. Otherwise unlinked activity never starts a turn.
 */
export function createLiveTurnProjector(agent = "claude", { partialStart = false } = {}) {
	const format = LIVE_FORMATS[agent];
	if (!format) throw new Error("Live recorded activity currently supports Claude Code, Pi and Codex sessions only.");
	const generation = Math.random().toString(36).slice(2, 10);
	const turns = [];
	// Owner links: a turn's `owner` object (resolved among retained turns, so a
	// dropped turn's cards are freed), or a held-context link, adopted by the
	// turn that context joins. UNPLACED records stay unknown to their children.
	const owners = new Map(), calls = new Map();
	const UNPLACED = Object.freeze({});
	let held, fallback, started = false;
	const remember = (map, key, owner, limit) => {
		map.delete(key); map.set(key, owner);
		if (map.size > limit) map.delete(map.keys().next().value);
	};
	const lookup = owner => {
		if (!owner || owner === UNPLACED) return undefined;
		if (owner.held && !owner.adopted) return { held: owner };
		const turn = turns.find(t => t.owner === (owner.adopted ?? owner));
		return turn ? { turn } : { gone: true };
	};
	const linked = format.linked;
	// The record's own turn (which its children join) follows its recorded parent;
	// without a known parent, the turn of a call it answers. Result blocks are
	// then placed by their own calls (see push).
	const ownerOf = e => {
		const parent = format.parent(e);
		if (typeof parent === "string" && owners.has(parent)) return owners.get(parent);
		for (const [, call] of format.results(e)) if (calls.has(call)) return calls.get(call);
	};
	const touch = (turn, at) => { turn.sequence++; turn.updatedAt = at.time; turn.loaded = at.loaded; };
	const newTurn = (anchor, task) => {
		const details = createTurnDetails([], { eventLimit: Infinity, totalLimit: Infinity, toolNameLimit: LIVE_EVENT_WINDOW });
		const turn = { owner: {}, anchor, task, status: "running", finalKey: undefined, details, events: [], sizes: [], bytes: 0, omitted: 0, sequence: 0, updatedAt: 0, loaded: false };
		turns.push(turn);
		while (turns.length > LIVE_TURNS_KEPT) turns.shift();
		return turn;
	};
	const admit = (turn, event, size) => {
		turn.events.push(event); turn.sizes.push(size); turn.bytes += size;
		while (turn.events.length > LIVE_EVENT_WINDOW || (turn.bytes > LIVE_TURN_BYTES && turn.events.length > 1)) {
			turn.events.shift(); turn.bytes -= turn.sizes.shift(); turn.omitted++;
		}
	};
	const recordEvents = (details, e, block) => {
		const before = details.result.events.length;
		format.project(details, e, block);
		// The projection's own list stays empty; turns keep the bounded window. A
		// block of a split record keeps its block index as its id.
		return details.result.events.splice(before).map((event, k) => ({ ...event, id: `${format.id(e)}:${block ?? k}` }));
	};
	const pendingCall = (turn, callId) => {
		for (let i = turn.events.length - 1; i >= 0; i--) {
			const call = turn.events[i];
			if (call.kind === "tool" && call.callId === callId) return call.pending ? call : undefined;
		}
	};
	const project = (turn, e, at, block) => {
		const produced = recordEvents(turn.details, e, block);
		// A result record answers its call even when it has nothing to show (empty output).
		const answered = format.results(e).filter(([index]) => block === undefined || index === block)
			.flatMap(([, id]) => { const call = pendingCall(turn, id); return call ? [call] : []; });
		if (!produced.length && !answered.length) return false;
		touch(turn, at);
		for (const call of answered) { delete call.pending; call.changed = turn.sequence; call.version = liveEventVersion(call); }
		for (const event of produced) {
			// A call says "No result recorded yet" until its result is recorded.
			if (event.kind === "tool" && event.callId) { event.pending = true; remember(calls, event.callId, turn.owner, LIVE_CALL_LIMIT); }
			event.changed = turn.sequence;
			event.version = liveEventVersion(event);
			admit(turn, event, liveEventBytes(event));
		}
		return true;
	};
	const hold = (e, link) => {
		held ??= { details: createTurnDetails([], { eventLimit: Infinity, totalLimit: Infinity, toolNameLimit: 0 }), events: [], sizes: [], bytes: 0, links: [] };
		if (!held.links.includes(link)) { held.links.push(link); if (held.links.length > LIVE_HELD_LINKS) held.links.shift(); }
		for (const event of recordEvents(held.details, e)) {
			const size = liveEventBytes(event);
			held.events.push(event); held.sizes.push(size); held.bytes += size;
			while (held.events.length > LIVE_HELD_EVENTS || (held.bytes > LIVE_HELD_BYTES && held.events.length > 1)) { held.events.shift(); held.bytes -= held.sizes.shift(); }
		}
	};
	// A turn starts with any context held for it.
	const open = (anchor, at, task) => {
		const turn = newTurn(anchor, task);
		touch(turn, at);
		if (held) {
			for (const link of held.links) link.adopted = turn.owner;
			held.events.forEach((event, i) => { event.changed = turn.sequence; event.version = liveEventVersion(event); admit(turn, event, held.sizes[i]); });
			held = undefined;
		}
		started = true;
		return turn;
	};
	// A record naming a task joins that task's retained turn, or none: never the
	// running turn by file order. A turn without its recorded start (a partial
	// backfill) takes the first task named in it.
	const named = task => {
		const turn = turns.find(t => t.task === task);
		if (turn) return { turn };
		if (fallback && fallback === turns.at(-1) && fallback.task === undefined) { fallback.task = task; return { turn: fallback }; }
	};
	/** @returns true when the record changed what a live view shows. */
	const push = (e, observedAt = Date.now(), loaded = false) => {
		const id = typeof format.id(e) === "string" ? format.id(e) : undefined;
		if (!id || owners.has(id)) return false;
		const at = { time: observedAt, loaded };
		const role = format.role(e);
		const task = format.task?.(e);
		if (role === "start" && task !== undefined && turns.some(t => t.task === task)) return false;
		const latest = turns.at(-1);
		const running = latest?.status === "running" ? latest : undefined;
		const owner = task === undefined ? ownerOf(e) : undefined;
		let target = task === undefined ? lookup(owner) : role === "start" ? undefined : named(task);
		// Records without recorded links (other formats, fixtures) fall back to file order.
		const sameTurn = running && (target?.turn === running || (!target && !linked(e)));
		if (role === "start") {
			// Input during a running turn steers it; otherwise it starts the next turn.
			const turn = sameTurn ? running : open(id, at, task);
			remember(owners, id, turn.owner, LIVE_RECORD_LIMIT);
			if (!project(turn, e, at)) touch(turn, at);
			return true;
		}
		if (role === "context") {
			if (sameTurn) {
				remember(owners, id, running.owner, LIVE_RECORD_LIMIT);
				if (!project(running, e, at)) touch(running, at);
				return true;
			}
			const link = target?.held ?? { held: true, anchor: id, adopted: undefined };
			remember(owners, id, link, LIVE_RECORD_LIMIT);
			hold(e, link);
			return false;
		}
		if (!target && task === undefined) {
			// No link to anything retained: a gap in what was read, or a format without links.
			if (running) {
				target = { turn: running };
				if (linked(e) && !["skip", "meta"].includes(role)) running.details.note("Some recorded activity is not linked to retained records; it is shown in file order.");
			} else if (held && !linked(e)) target = { held: held.links[0] };
			else if (partialStart && !started && role !== "skip" && role !== "meta") {
				if (!fallback || !turns.includes(fallback)) {
					fallback = newTurn(id);
					fallback.details.note("This turn's prompt is not in the retained recorded activity.");
				}
				target = { turn: fallback };
			}
		}
		if (target?.held && role === "activity") target = { turn: open(target.held.anchor, at) };
		const turn = target?.turn;
		remember(owners, id, target?.held ?? turn?.owner ?? (target?.gone ? owner : UNPLACED), LIVE_RECORD_LIMIT);
		// Results in one record are placed by their own calls, so a late result
		// never takes a current turn's result with it (or the reverse).
		const results = role === "activity" ? format.results(e) : [];
		if (results.length) {
			const placed = results.map(([block, call]) => [block, calls.has(call) ? lookup(calls.get(call))?.turn ?? null : turn]);
			if (placed.some(([, t]) => t !== turn)) {
				let changed = false;
				for (const [block, t] of placed) if (t) changed = project(t, e, at, block) || changed;
				return changed;
			}
		}
		if (!turn || role === "skip") return false;
		// A recorded reply after a recoverable ending continues the latest turn (a
		// retry); the failed attempt stays shown. A late result alone never reopens it.
		if (role === "activity" && format.reply(e) && LIVE_RECOVERABLE.has(turn.status) && turn === turns.at(-1)) {
			turn.status = "running"; turn.finalKey = undefined; touch(turn, at);
		}
		const active = turn.status === "running";
		if (role === "meta") { if (active) turn.details.note("Known harness-injected context is omitted; it is not labelled as a user prompt."); return false; }
		if (role === "compaction") { if (!active) return false; turn.details.note("Context was compacted during this turn."); touch(turn, at); return true; }
		if (role === "interrupted") { if (!active) return false; turn.status = "interrupted"; touch(turn, at); return true; }
		const changed = project(turn, e, at);
		// Only an explicit recorded end changes the status: completed, error, interrupted or incomplete.
		const ending = active ? format.ending(e) : undefined;
		if (!ending) return changed;
		turn.status = ending;
		if (ending === "completed") turn.finalKey = format.finalKey(e);
		touch(turn, at);
		return true;
	};
	return {
		generation,
		push,
		/** Anchor of the latest retained turn, if any. */
		current: () => turns.at(-1)?.anchor,
		/** A copy of one retained turn's window, or undefined once it is no longer retained. */
		snapshot(anchor) {
			const turn = turns.find(t => t.anchor === anchor);
			if (!turn) return undefined;
			const latest = turns.at(-1);
			return {
				generation, anchor, sourceAgent: agent, status: turn.status, finalKey: turn.finalKey, sequence: turn.sequence, updatedAt: turn.updatedAt, loaded: turn.loaded,
				omitted: turn.omitted, notices: [...turn.details.result.notices], events: turn.events.map(event => ({ ...event })),
				...(latest !== turn ? { newerAnchor: latest.anchor } : {}),
			};
		},
		/** Retained sizes, for bounds checks. */
		stats: () => ({
			records: owners.size, calls: calls.size, turns: turns.length,
			events: turns.reduce((n, t) => n + t.events.length, 0) + (held?.events.length ?? 0),
			bytes: turns.reduce((n, t) => n + t.bytes, 0) + (held?.bytes ?? 0),
		}),
	};
}
