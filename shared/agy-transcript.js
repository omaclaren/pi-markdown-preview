// Antigravity CLI (agy) transcripts, as agy 1.3 writes them: one JSON step per line in
// ~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript_full.jsonl,
// appended as each step is recorded. A step has `step_index`, `source`, `type`, `status` and
// `created_at`. A typed prompt is USER_INPUT from USER_EXPLICIT; the model's steps are
// PLANNER_RESPONSE, with `content`, `thinking` and `tool_calls` ({ name, args }, no call ids); a
// tool's output is GENERIC; agy's own notices, and its subagents' replies, are SYSTEM_MESSAGE.
// No record marks the end of a turn: a finished model step with text and no tool calls ends it,
// and the model can reply again in the same turn when something wakes it (a subagent's reply).
// A step can be recorded again with a later status (a background command: RUNNING, then DONE).
// The format is internal to agy and can change; anything else is ignored.
const text = value => typeof value === "string" ? value : "";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The step, when `e` is one: an object with a step index and a type. */
export const agyStep = e => e && typeof e === "object" && !Array.isArray(e) && Number.isSafeInteger(e.step_index) && e.step_index >= 0 && typeof e.type === "string" ? e : undefined;

/** The conversation a transcript belongs to: its folder under brain/, else the last UUID in its path. */
export function agyConversation(path) {
	const folder = /[/\\]brain[/\\]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[/\\]/i.exec(text(path));
	return (folder?.[1] ?? text(path).match(UUID)?.at(-1))?.toLowerCase();
}

/** What an answer's response key names its conversation by: the conversation, else the transcript's path. */
export const agyConversationKey = path => agyConversation(path) ?? text(path);

/**
 * What the person typed, for a prompt step: the text inside agy's <USER_REQUEST>, without the
 * metadata agy adds after it (local time, settings changes). Undefined for any other step.
 */
export function agyPrompt(e) {
	if (!agyStep(e) || e.type !== "USER_INPUT" || e.source !== "USER_EXPLICIT") return undefined;
	const content = text(e.content);
	const close = content.lastIndexOf("</USER_REQUEST>");
	if (!content.startsWith("<USER_REQUEST>") || close < 0) return content;
	return content.slice("<USER_REQUEST>".length, close).replace(/^\n/, "").replace(/\n$/, "");
}

/** A model step's tool calls: `{ name, args }`. */
export const agyToolCalls = e => Array.isArray(e?.tool_calls) ? e.tool_calls.filter(call => call && typeof call === "object" && !Array.isArray(call)) : [];

/** A step that gives the model input: a prompt, agy's own context, or a notice (a subagent's reply). */
export const isAgyInput = e => Boolean(agyStep(e)) && ["USER_INPUT", "SYSTEM_MESSAGE"].includes(e.type);

/** A finished model step with text and no tool calls: an answer that ends the turn, for now. */
export const isAgyFinal = e => Boolean(agyStep(e)) && e.type === "PLANNER_RESPONSE" && e.status === "DONE" && !agyToolCalls(e).length && text(e.content).trim() !== "";

/** The response key the session reader gives an answer: unique across conversations, as step indexes aren't. */
export const agyResponseKey = (conversation, e) => `agy:${conversation}:${e.step_index}`;

/**
 * A tool step's output, without agy's leading timing lines ("Created At: <time>", "Completed At:
 * <time>"), which can be recorded more than once. Only lines with agy's timestamp are removed.
 */
export const agyOutput = content => text(content).replace(/^(?:(?:Created|Completed) At: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)(?:\r?\n|$))+/, "");
