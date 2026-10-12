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

// ---- Live: recorded activity of one in-progress turn (milestone 1: Claude) ----
// Records are pushed in file order as they become readable. Claude Code appends
// records and never rewrites one: a uuid names one record's content for good, so
// a repeated uuid (backfill and subscription overlap) is ignored, and a message's
// blocks and its recorded end arrive as separate records with their own uuids.
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
	if (e.type === "assistant") return e.isApiErrorMessage === true ? "error" : "activity";
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

/**
 * Incremental, bounded projection of the latest turns of one Claude session.
 * `partialStart`: the records begin partway through the session (a bounded
 * backfill), so activity before the first retained prompt forms a turn whose
 * prompt is not retained. Otherwise unlinked activity never starts a turn.
 */
export function createLiveTurnProjector(agent = "claude", { partialStart = false } = {}) {
	if (agent !== "claude") throw new Error("Live recorded activity currently supports Claude Code sessions only.");
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
	const linked = e => "parentUuid" in e || "logicalParentUuid" in e;
	const ownerOf = e => {
		// Exact call membership first: parallel results can name a sibling as parent.
		if (e.type === "user") for (const b of blocks(e.message?.content)) {
			if (b?.type === "tool_result" && typeof b.tool_use_id === "string" && calls.has(b.tool_use_id.slice(0, 160))) return calls.get(b.tool_use_id.slice(0, 160));
		}
		const parent = e.parentUuid ?? e.logicalParentUuid;
		return typeof parent === "string" ? owners.get(parent) : undefined;
	};
	const touch = (turn, at) => { turn.sequence++; turn.updatedAt = at.time; turn.loaded = at.loaded; };
	const newTurn = anchor => {
		const details = createTurnDetails([], { eventLimit: Infinity, totalLimit: Infinity, toolNameLimit: LIVE_EVENT_WINDOW });
		const turn = { owner: {}, anchor, status: "running", finalKey: undefined, details, events: [], sizes: [], bytes: 0, omitted: 0, sequence: 0, updatedAt: 0, loaded: false };
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
	const recordEvents = (details, e) => {
		const m = e.message;
		if (!m || !["user", "assistant"].includes(m.role)) return [];
		const before = details.result.events.length;
		claudeContent(details, m.content, m.role, false, blocks(m.content).filter(b => b?.type === "tool_result").length === 1 ? e.toolUseResult : undefined);
		// The projection's own list stays empty; turns keep the bounded window.
		return details.result.events.splice(before).map((event, k) => ({ ...event, id: `${e.uuid}:${k}` }));
	};
	const project = (turn, e, at) => {
		const produced = recordEvents(turn.details, e);
		if (!produced.length) return false;
		touch(turn, at);
		for (const event of produced) {
			// A call says "No result recorded yet" until its result is recorded.
			if (event.kind === "tool" && event.callId) { event.pending = true; remember(calls, event.callId, turn.owner, LIVE_CALL_LIMIT); }
			if (event.kind === "result" && event.callId) {
				for (let i = turn.events.length - 1; i >= 0; i--) {
					const call = turn.events[i];
					if (call.kind !== "tool" || call.callId !== event.callId) continue;
					if (call.pending) { delete call.pending; call.changed = turn.sequence; call.version = liveEventVersion(call); }
					break;
				}
			}
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
	const open = (anchor, at) => {
		const turn = newTurn(anchor);
		touch(turn, at);
		if (held) {
			for (const link of held.links) link.adopted = turn.owner;
			held.events.forEach((event, i) => { event.changed = turn.sequence; event.version = liveEventVersion(event); admit(turn, event, held.sizes[i]); });
			held = undefined;
		}
		started = true;
		return turn;
	};
	/** @returns true when the record changed what a live view shows. */
	const push = (e, observedAt = Date.now(), loaded = false) => {
		const id = typeof e?.uuid === "string" ? e.uuid : undefined;
		if (!id || owners.has(id)) return false;
		const at = { time: observedAt, loaded };
		const role = claudeLiveRole(e);
		const latest = turns.at(-1);
		const running = latest?.status === "running" ? latest : undefined;
		const owner = ownerOf(e);
		let target = lookup(owner);
		// Records without recorded links (other formats, fixtures) fall back to file order.
		const sameTurn = running && (target?.turn === running || (!target && !linked(e)));
		if (role === "start") {
			// Input during a running turn steers it; otherwise it starts the next turn.
			const turn = sameTurn ? running : open(id, at);
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
		if (!target) {
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
		if (target?.held && (role === "activity" || role === "error")) target = { turn: open(target.held.anchor, at) };
		const turn = target?.turn;
		remember(owners, id, target?.held ?? turn?.owner ?? (target?.gone ? owner : UNPLACED), LIVE_RECORD_LIMIT);
		if (!turn || role === "skip") return false;
		const active = turn.status === "running";
		if (role === "meta") { if (active) turn.details.note("Known harness-injected context is omitted; it is not labelled as a user prompt."); return false; }
		if (role === "compaction") { if (!active) return false; turn.details.note("Context was compacted during this turn."); touch(turn, at); return true; }
		if (role === "interrupted") { if (!active) return false; turn.status = "interrupted"; touch(turn, at); return true; }
		const changed = project(turn, e, at);
		if (active && role === "error") { turn.status = "error"; touch(turn, at); return true; }
		if (active && isClaudeFinal(e)) { turn.status = "completed"; turn.finalKey = `claude:${e.message?.id ?? e.uuid}`; touch(turn, at); return true; }
		return changed;
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
				generation, anchor, status: turn.status, finalKey: turn.finalKey, sequence: turn.sequence, updatedAt: turn.updatedAt, loaded: turn.loaded,
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
