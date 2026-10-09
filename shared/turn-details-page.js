import { createTurnDetails } from "./turn-details.js";
import { AGENT_PAGE_STYLE } from "./agent-page-style.js";
import { IMAGE_UNAVAILABLE } from "./recorded-images.js";
import { questionInput, questionAnswers } from "./ask-user-question.js";
const escape = value => String(value ?? "").replace(/[&<>"'\r]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "\r": "&#13;" })[ch]);

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const code = (value, className) => `<pre class="${className}"><code>${escape(value)}</code></pre>`;
// A child element prevents HTML's <pre> parser from dropping a leading newline.
const literalPre = value => `<pre><span>${escape(value)}</span></pre>`;
const rawArguments = value => `<details class="recorded-arguments"><summary>Recorded arguments (JSON)</summary>${literalPre(value)}</details>`;
const description = args => typeof args.description === "string" && args.description.trim() ? `<p class="tool-description">${escape(args.description)}</p>` : "";
const stringKey = (args, keys) => keys.find(key => typeof args[key] === "string");
const filePath = value => `<div class="tool-path"><span class="field-label">File</span>${code(value, "file-path")}</div>`;
const textField = (label, value, className) => `<section class="tool-field ${className}"><h3>${label}</h3>${value === "" ? '<p class="empty-text">Empty text</p>' : ""}${code(value, "field-text")}</section>`;

function options(args, omitted = [], labels = {}) {
	const fields = Object.entries(args).filter(([key]) => !omitted.includes(key))
		// Compact nested JSON: pretty-printing arbitrarily deep input can expand
		// a bounded record quadratically. Strings keep their original line breaks.
		.map(([key, value]) => `<dt>${escape(Object.hasOwn(labels, key) ? labels[key] : key)}</dt><dd><pre>${escape(typeof value === "string" ? value : JSON.stringify(value))}</pre></dd>`).join("");
	return fields ? `<dl class="tool-options">${fields}</dl>` : "";
}

// Pretty JSON only for shallow values with bounded growth; deep or expanding
// values stay compact, so a bounded record cannot grow quadratically.
const JSON_DEPTH_LIMIT = 20;
const shallow = (value, depth = 0) => depth <= JSON_DEPTH_LIMIT && (value === null || typeof value !== "object" || Object.values(value).every(v => shallow(v, depth + 1)));
function jsonText(value) {
	const compact = JSON.stringify(value);
	if (!shallow(value)) return compact;
	const pretty = JSON.stringify(value, null, 2);
	return pretty.length <= Math.max(4096, 3 * compact.length) ? pretty : compact;
}

// Any plain JSON object as labelled literal fields: short scalars as a compact
// list, long or multi-line strings and nested values as full-width blocks.
// Strings keep their recorded text and line breaks; nothing is interpreted.
const shortScalar = v => v === null || typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 120 && !/[\r\n]/.test(v));
function fieldsView(record) {
	const entries = Object.entries(record);
	const rows = entries.filter(([, v]) => shortScalar(v)).map(([key, v]) => `<dt>${escape(key)}</dt><dd>${v === "" ? '<span class="empty-text">Empty text</span>' : `<pre>${escape(typeof v === "string" ? v : JSON.stringify(v))}</pre>`}</dd>`).join("");
	const blocks = entries.filter(([, v]) => !shortScalar(v)).map(([key, v]) => `<section class="tool-field"><h3>${escape(key)}</h3>${code(typeof v === "string" ? v : jsonText(v), "field-text")}</section>`).join("");
	return `<div class="tool-fields">${rows ? `<dl class="tool-options">${rows}</dl>` : ""}${blocks}</div>`;
}

// A result that is exactly one non-empty JSON object or array: objects as
// fields, arrays as bounded pretty JSON. The exact text stays under Raw output.
function jsonResult(text, recorded = text) {
	const source = text.trim();
	if (!/^[[{]/.test(source)) return null;
	let value;
	try { value = JSON.parse(source); } catch { return null; }
	if (value === null || typeof value !== "object" || !Object.keys(value).length) return null;
	const view = Array.isArray(value) ? code(jsonText(value), "json-output") : fieldsView(value);
	return `${view}${rawOutput(recorded)}`;
}
const rawOutput = text => `<details class="recorded-output"><summary>Raw output</summary>${literalPre(text)}</details>`;

// Terminal colour and control sequences (CSI, OSC and charset designators) are
// presentation noise in recorded tool output. The reading view hides them;
// Raw output keeps the exact recorded text.
const TERMINAL_SEQUENCE = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]/g;

function askedQuestions(args) {
	return args.questions.map(q => `<section class="asked-question"><p class="question-header">${escape(q.header)}${typeof q.multiSelect === "boolean" ? ` · ${q.multiSelect ? "Multiple selections allowed" : "Single selection"}` : ""}</p><h2>${escape(q.question)}</h2><ul class="question-options">${q.options.map(o => `<li><strong>${escape(o.label)}</strong><div class="question-prose">${escape(o.description)}</div>${o.preview === undefined ? "" : textField("Preview", o.preview, "question-preview")}${options(o, ["label", "description", "preview"])}</li>`).join("")}</ul>${options(q, ["question", "header", "options", "multiSelect"])}</section>`).join("");
}

function answeredQuestions(event) {
	let data, parsed = false;
	try { data = JSON.parse(event.questionAnswers || event.text); parsed = true; } catch { /* Prose is never delimiter-parsed. */ }
	const raw = `<details class="recorded-output"><summary>Raw output</summary>${literalPre(event.text)}</details>`;
	if (!questionAnswers(data) && (parsed || /^\s*[\[{]/.test(event.text))) return literalPre(event.text);
	if (!questionAnswers(data)) return `<div class="question-reply"><h3>Recorded reply</h3><div class="question-prose">${escape(event.text)}</div></div>${raw}`;
	const answers = Object.entries(data.answers).map(([question, answer]) => `<section class="question-reply"><h3>${escape(question)}</h3>${answer === "" ? '<p class="empty-text">Empty recorded answer</p>' : `<div class="question-prose">${escape(answer)}</div>`}</section>`).join("");
	const annotations = Object.entries(data.annotations ?? {}).map(([question, note]) => `<section class="question-reply"><h3>Annotation: ${escape(question)}</h3>${note.preview === undefined ? "" : textField("Preview", note.preview, "question-preview")}${note.notes === undefined ? "" : `<div class="question-prose">${escape(note.notes)}</div>`}</section>`).join("");
	return (answers || '<p class="question-reply">No answers in the recorded answer data.</p>') + annotations + options(data, ["answers", "annotations"]) + raw
		+ (event.questionAnswers ? `<details class="recorded-output"><summary>Recorded answers (JSON)</summary>${literalPre(event.questionAnswers)}</details>` : "");
}

// Claude's complete paste envelope is presentation metadata. Match only the
// observed same-ID form, not arbitrary XML, embedded examples or partial data.
function claudePasteBody(value) {
	const source = value.trim();
	const head = /^<pasted_content id="([A-Za-z0-9_-]{1,128})">/.exec(source);
	if (!head) return null;
	const tail = `</pasted_content id="${head[1]}">`;
	if (!source.endsWith(tail)) return null;
	const body = source.slice(head[0].length, -tail.length);
	if (!body.trim() || body.includes("<pasted_content") || body.includes("</pasted_content")) return null;
	// Remove the envelope's boundary newlines, not indentation or inner spacing.
	return body.replace(/^(?:\r\n|\r|\n)/, "").replace(/(?:\r\n|\r|\n)$/, "");
}

// Claude records a slash command as a tag-only record: each known tag at most
// once, separated only by whitespace, with no recognised tag inside a field.
// Anything else stays an ordinary prompt. Raw input keeps the exact record.
const SLASH_COMMAND_TAGS = ["command-name", "command-message", "command-args"];
function claudeSlashCommand(value) {
	const source = value.trim(), fields = new Map();
	let at = 0;
	while (at < source.length) {
		const tag = SLASH_COMMAND_TAGS.find(name => source.startsWith(`<${name}>`, at));
		if (!tag || fields.has(tag)) return null;
		const start = at + tag.length + 2, end = source.indexOf(`</${tag}>`, start);
		if (end < 0) return null;
		const field = source.slice(start, end);
		if (/<\/?command-(?:name|message|args)>/.test(field)) return null;
		fields.set(tag, field);
		at = end + tag.length + 3;
		while (at < source.length && /\s/.test(source[at])) at++;
	}
	const name = fields.get("command-name")?.trim();
	if (!name || /\s/.test(name)) return null;
	const args = (fields.get("command-args") ?? "").trim();
	return args ? `${name} ${args}` : name;
}
const slashCommand = (event, fromClaude) => fromClaude && event.kind === "prompt" ? claudeSlashCommand(event.text) : null;

// Claude records a background-task notification as one complete
// <task-notification> wrapper of simple child fields, each at most once and
// separated only by whitespace. Anything else stays an ordinary prompt.
function claudeTaskNotification(value) {
	const source = value.trim(), open = "<task-notification>", close = "</task-notification>";
	if (!source.startsWith(open) || !source.endsWith(close)) return null;
	const body = source.slice(open.length, -close.length);
	if (body.includes(open) || body.includes(close)) return null;
	const fields = new Map();
	let at = 0;
	const skip = () => { while (at < body.length && /\s/.test(body[at])) at++; };
	for (skip(); at < body.length; skip()) {
		const tag = /^<([a-z][a-z0-9-]{0,40})>/.exec(body.slice(at, at + 44))?.[1];
		if (!tag || fields.has(tag)) return null;
		const start = at + tag.length + 2, end = body.indexOf(`</${tag}>`, start);
		if (end < 0) return null;
		const field = body.slice(start, end);
		if (field.includes(`<${tag}>`)) return null;
		fields.set(tag, field);
		at = end + tag.length + 3;
	}
	return fields.has("summary") || fields.has("status") ? Object.fromEntries(fields) : null;
}
function taskNotificationView(fields) {
	const { summary, ...rest } = fields;
	return `${summary?.trim() ? `<p class="task-summary">${escape(summary.trim())}</p>` : ""}${Object.keys(rest).length ? fieldsView(rest) : ""}`;
}

// Claude-only compact views of recognised prompt envelopes. Raw input keeps
// the exact recorded text.
function claudeEnvelope(event, fromClaude) {
	if (!fromClaude || event.kind !== "prompt") return null;
	const slash = claudeSlashCommand(event.text);
	if (slash !== null) return { label: "Slash command", html: literalPre(slash) };
	const task = claudeTaskNotification(event.text);
	return task ? { label: "Task notification", html: taskNotificationView(task) } : null;
}

function resultView(text) {
	const shown = text.replace(TERMINAL_SEQUENCE, "");
	return jsonResult(shown, text) ?? (shown === text ? literalPre(text) : `${literalPre(shown)}${rawOutput(text)}`);
}

// Recognise recorded argument shapes, not code syntax. Never reindent, split
// operators, resolve file paths, infer a successful edit, or execute anything.
function eventContent(event, fromClaude = false) {
	const literal = literalPre(event.text);
	if (event.kind === "result") {
		const images = (event.images ?? []).map((image, i) => image.unavailable
			? `<p class="recorded-image-error">Recorded image unavailable: ${escape(IMAGE_UNAVAILABLE[image.unavailable])}</p>`
			: `<figure class="recorded-image"><button type="button" class="recorded-image-open" aria-expanded="false" aria-label="Recorded image ${i + 1} · ${image.width} × ${image.height}. Enlarge"><img data-recorded-src="data:${image.mimeType};base64,${image.data}" width="${image.width}" height="${image.height}" alt="Recorded tool-result image ${i + 1}" decoding="async"><span>Enlarge</span></button><figcaption>${image.width} × ${image.height} · ${escape(image.mimeType.slice(6).toUpperCase())}</figcaption><p class="recorded-image-error" role="status" hidden></p></figure>`).join('');
		const answer = fromClaude && /^Tool result:\s*(?:functions\.)?AskUserQuestion$/i.test(event.label);
		return (event.text || answer ? `<label class="output-wrap"><input type="checkbox" aria-label="Wrap lines for ${escape(event.label || "tool output")}">Wrap lines</label>${answer ? answeredQuestions(event) : resultView(event.text)}` : '') + images;
	}
	if (event.kind === "prompt") {
		const envelope = claudeEnvelope(event, fromClaude);
		if (envelope) return `${envelope.html}<details class="recorded-input"><summary>Raw input</summary>${literal}</details>`;
		// Suppress only empty leading lines in the reading view. Preserve the
		// first content line's indentation and keep the recorded input available.
		const body = (fromClaude ? claudePasteBody(event.text) : null) ?? event.text;
		const first = body.search(/\S/);
		const start = first < 0 ? 0 : Math.max(body.lastIndexOf("\n", first), body.lastIndexOf("\r", first)) + 1;
		const reading = body.slice(start);
		if (reading !== event.text) return `${literalPre(reading)}<details class="recorded-input"><summary>Raw input</summary>${literal}</details>`;
	}
	if (event.kind !== "tool") return literal;
	const name = /^Tool:\s*(?:functions\.)?(bash|exec_command|exec|codemode|read|edit|multiedit|askuserquestion)$/i.exec(event.label)?.[1].toLowerCase();
	let args;
	try { args = JSON.parse(event.text); }
	catch { return name === "codemode" ? code(event.text, "code-input") : literal; }
	if (!object(args) || !Object.keys(args).length) return literal;
	// Unrecognised tools and unrecognised shapes of known tools: literal fields.
	const fields = () => `${fieldsView(args)}${rawArguments(event.text)}`;
	try {
		if (!name) return fields();
		const descKey = typeof args.description === "string" ? ["description"] : [];
		const finish = (body, used, labels = {}) => `${body}${description(args)}${options(args, [...used, ...descKey], labels)}${rawArguments(event.text)}`;
		if (name === "askuserquestion") {
			if (fromClaude && questionInput(args)) return finish(askedQuestions(args), ["questions"]);
		} else if (["bash", "exec_command", "exec"].includes(name)) {
			const key = args.command != null ? "command" : "cmd";
			if (typeof args[key] === "string") return finish(code(args[key], "shell-command"), [key]);
		} else if (name === "codemode") {
			if (typeof args.code === "string") return finish(code(args.code, "code-input"), ["code"]);
		} else {
			const pathKey = stringKey(args, ["path", "file_path", "filePath"]);
			if (!pathKey) return fields();
			if (name === "read") return finish(filePath(args[pathKey]), [pathKey], { offset: "Start line", limit: "Line limit" });
			const batch = Object.hasOwn(args, "edits");
			const replacements = batch ? args.edits : [args];
			if (!Array.isArray(replacements) || !replacements.length) return fields();
			const pairs = replacements.map(edit => object(edit) && [["oldText", "newText"], ["old_string", "new_string"], ["oldString", "newString"]].find(pair => pair.every(key => typeof edit[key] === "string")));
			if (pairs.some(pair => !pair)) return fields();
			const body = replacements.map((edit, i) => {
				const pair = pairs[i];
				return `<section class="edit-replacement"><h2>Requested replacement${replacements.length > 1 ? ` ${i + 1}` : ""}</h2>${textField("Before", edit[pair[0]], "edit-before")}${textField("After", edit[pair[1]], "edit-after")}${batch ? options(edit, pair) : ""}</section>`;
			}).join("");
			return finish(filePath(args[pathKey]) + body, [pathKey, ...(batch ? ["edits"] : pairs[0])]);
		}
		return fields();
	} catch { /* Unexpected failures keep the literal view. */ }
	return literal;
}

/** Recorded text stays inert; only validated raster bytes become image elements. */
export function buildTurnDetailsPage(details, responseUrl, label = "", appearanceStyle = "") {
	const bounded = createTurnDetails();
	for (const e of Array.isArray(details?.events) ? details.events.slice(0, 251) : []) {
		if (["prompt", "progress", "reasoning", "tool", "result"].includes(e?.kind)) bounded.add(e.kind, e.label, e.text, e.callId, e.images, details?.sourceAgent === "claude" ? e.questionAnswers : undefined);
	}
	const { events } = bounded.result;
	const fromClaude = details?.sourceAgent === "claude";
	// Inputs open by default. Only recognised local-command history (a slash
	// command answered by local command output) starts collapsed.
	const input = e => e.kind === "prompt" || e.label === "User shell command";
	const localOutput = e => e?.kind === "result" && !e.callId && ["Command output", "Command error output"].includes(e.label);
	const localCommand = i => slashCommand(events[i], fromClaude) !== null && localOutput(events[i + 1]);
	const rows = events.map((e, i) => `<details class="event ${e.kind}"${input(e) && !localCommand(i) ? " open" : ""}><summary><span class="number"${e.callId ? ` title="Call ID: ${escape(e.callId)}"` : ""}>${i + 1}</span> ${escape(claudeEnvelope(e, fromClaude)?.label ?? (e.label || e.kind))}</summary><div class="event-content">${eventContent(e, fromClaude)}</div></details>`).join("\n");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Working</title><style>
${AGENT_PAGE_STYLE}
${appearanceStyle}
main > nav { margin-bottom:18px } main > nav a { display:inline-flex; align-items:center; min-height:32px; padding:6px 10px; border:1px solid var(--line); border-radius:6px; color:inherit; font:600 12px/1.2 system-ui; text-decoration:none } main > nav a:hover { background:var(--hover) }
.subtitle,.notices { color:var(--muted); font-size:12px } .subtitle { margin:0 0 8px; overflow-wrap:anywhere } .notices { margin:0 }
.notices-row { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px 12px; margin:0 0 18px } .working-bulk { display:flex; gap:6px } .working-bulk[hidden] { display:none }
.working-bulk button { min-height:28px; padding:4px 10px; border:1px solid var(--line); border-radius:6px; background:transparent; color:inherit; font:600 12px/1.2 system-ui; cursor:pointer } .working-bulk button:hover { background:var(--hover) } .working-bulk button:focus-visible { outline:2px solid var(--accent); outline-offset:2px }
.event { margin:12px 0; border:1px solid var(--line); border-radius:10px; background:var(--panel); overflow:hidden } summary { padding:10px 14px; cursor:pointer; overflow-wrap:anywhere; font-weight:600 } summary:hover { background:var(--hover) } summary:focus-visible { outline:2px solid var(--muted); outline-offset:-4px; border-radius:6px } a:focus-visible { outline:2px solid var(--accent); outline-offset:2px }
.number { color:var(--muted); font-variant-numeric:tabular-nums; margin-right:8px }
.event-content { border-top:1px solid var(--line) }
pre { margin:0; padding:12px 14px; background:transparent; font:0.9em/1.6 ui-monospace,Menlo,monospace; white-space:pre-wrap; overflow-wrap:anywhere; tab-size:4 } pre code { font:inherit }
.tool-description { margin:0 14px 12px; color:var(--muted); font-size:12px }
.tool-path { padding:12px 14px } .tool-path pre { padding:2px 0 0 } .field-label,.tool-field h3,.edit-replacement h2 { font:600 12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--muted); margin:0 }
.edit-replacement { padding:0 14px 14px } .edit-replacement h2 { margin:0 0 10px } .tool-field { margin:8px 0 } .tool-field pre { padding:4px 0 } .empty-text { color:var(--muted); font-size:12px; margin:4px 0 } .edit-replacement .tool-options { margin:12px 0 0 }
.tool-options { display:grid; grid-template-columns:fit-content(40%) minmax(0,1fr); gap:6px 12px; margin:0 14px 12px; font-size:12px } .tool-options dt { color:var(--muted); overflow-wrap:anywhere } .tool-options dd { margin:0; min-width:0 } .tool-options pre { padding:0; font-size:12px }
.task-summary { margin:12px 14px 0; white-space:pre-wrap; overflow-wrap:anywhere } .tool-fields { padding:12px 14px 2px } .tool-fields .tool-options { margin:0 0 10px } .tool-fields .tool-field { margin:0 0 10px } .tool-fields .empty-text { margin:0 }
.recorded-arguments,.recorded-input { border-top:1px solid var(--line) } .recorded-arguments > summary,.recorded-input > summary { color:var(--muted); font-size:12px; font-weight:400 }
.prompt pre,.progress pre,.reasoning pre { font:inherit }
.asked-question,.question-reply { margin:14px } .asked-question h2,.question-reply h3 { font-family:inherit; font-size:1em; font-weight:600; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; margin:0 0 8px } .question-header { color:var(--muted); font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere; margin:0 0 6px }
.question-options { padding-left:20px; margin:10px 0 } .question-options li { padding-left:3px; margin:10px 0 } .question-options strong,.question-prose { white-space:pre-wrap; overflow-wrap:anywhere } .question-options .question-prose { color:var(--muted); font-size:0.9em; margin-top:3px } .question-preview pre { white-space:pre-wrap; overflow-wrap:anywhere } .asked-question .tool-options { margin:8px 0 }
.recorded-output { border-top:1px solid var(--line) } .recorded-output > summary { color:var(--muted); font-size:12px; font-weight:400 }
.result { position:relative } .result > summary { padding-right:120px } .result:not(:has(.output-wrap)) > summary { padding-right:14px }
.output-wrap { position:absolute; right:10px; top:6px; display:inline-flex; align-items:center; gap:6px; min-height:28px; padding:2px 6px; color:var(--muted); font-size:12px; cursor:pointer } .output-wrap input { margin:0; accent-color:var(--muted) } .output-wrap input:focus-visible { outline:2px solid var(--muted); outline-offset:2px }
.result pre { white-space:pre; overflow-x:auto; overflow-wrap:normal } .result:has(.output-wrap input:checked) pre { white-space:pre-wrap; overflow-wrap:anywhere }
.recorded-image { margin:14px; } .recorded-image-open { display:block; background:transparent; border:1px solid var(--line); border-radius:6px; padding:6px; color:var(--muted); font:12px/1.4 system-ui; cursor:zoom-in; min-width:44px; min-height:44px; max-width:100% } .recorded-image-open:hover { background:var(--hover) } .recorded-image-open:focus-visible { outline:2px solid var(--accent); outline-offset:2px } .recorded-image-open[hidden] { display:none }
.recorded-image-open img { display:block; width:auto; height:auto; max-width:100%; max-height:220px; object-fit:contain } .recorded-image-open span { display:block; padding-top:4px } .recorded-image figcaption,.recorded-image-error { font-size:12px; color:var(--muted); overflow-wrap:anywhere } .recorded-image figcaption { margin-top:6px } .event-content > .recorded-image-error { margin:14px } .inline-expanded { cursor:zoom-out } .inline-expanded img { max-height:none }
.recorded-image-dialog { background:var(--panel); color:var(--ink); border:1px solid var(--line); border-radius:10px; padding:12px; max-width:calc(100vw - 24px); max-height:calc(100dvh - 24px); overflow:auto } .recorded-image-dialog::backdrop { background:#000a } .recorded-image-dialog-header { display:flex; align-items:center; justify-content:space-between; gap:16px; font-size:12px; margin-bottom:8px } .recorded-image-dialog button { font:inherit; color:inherit; background:var(--hover); border:1px solid var(--line); border-radius:6px; min-height:44px; min-width:44px; padding:6px 12px; cursor:pointer } .recorded-image-dialog img { display:block; width:auto; height:auto; max-width:100%; max-height:calc(100dvh - 120px); object-fit:contain }
@media print { .recorded-image-open { border:0; padding:0 } .recorded-image-open span,.recorded-image-dialog { display:none } }
@media(max-width:500px) { pre { padding:12px } } @media(pointer:coarse) { .event summary, .working-bulk button { min-height:44px } .output-wrap { min-height:44px; top:0 } } @media print { nav,.output-wrap,.working-bulk { display:none } .event { break-inside:avoid } .result pre { white-space:pre-wrap; overflow-wrap:anywhere } }
</style></head><body class="pi-preview-working"><main id="preview-root">${responseUrl ? `<nav><a href="${escape(responseUrl)}">← Preview</a></nav>` : ""}<h1>Working</h1><p class="subtitle">${escape(label)}${label ? " · " : ""}Prompt and activity for this response.</p><div class="notices-row"><p class="notices">Read-only view; some conversation content may be missing or shortened.</p>${rows ? '<div class="working-bulk" role="group" aria-label="All cards" hidden><button type="button" data-working-bulk="expand">Expand all</button><button type="button" data-working-bulk="collapse">Collapse all</button></div>' : ""}</div>${rows || "<p>No matching prompt or working details are available.</p>"}</main></body></html>`;
}
