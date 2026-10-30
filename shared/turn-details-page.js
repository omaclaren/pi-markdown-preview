import { createTurnDetails } from "./turn-details.js";
import { AGENT_PAGE_STYLE } from "./agent-page-style.js";
import { IMAGE_UNAVAILABLE } from "./recorded-images.js";
import { questionInput, questionAnswers } from "./ask-user-question.js";
import { TERMINAL_SEQUENCE, replPaneActivity, replResultBinding, replResultSplit, replSendCall, replSendCalls } from "./repl-calls.js";
const escape = value => String(value ?? "").replace(/[&<>"'\r]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "\r": "&#13;" })[ch]);

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const code = (value, className) => `<pre class="${className}"><code>${escape(value)}</code></pre>`;
// A wrapped line of code continues 4 columns past its own indent (CSS), so it can't pass for a line of
// its own. Each line is a span with --indent: its leading columns, tabs at 4 as in `pre`, at most 32.
function lineIndent(line) {
	let columns = 0;
	for (const char of line) { if (char === " ") columns++; else if (char === "\t") columns += 4 - columns % 4; else break; }
	return columns ? ` style="--indent:${Math.min(columns, 32)}ch"` : "";
}
// Code an agent wrote or sent (REPL calls, codemode): a span per line, for wrapping (lineIndent).
const codeInput = value => `<pre class="code-input"><code>${value.split("\n").map(line => `<span${lineIndent(line)}>${escape(line)}</span>`).join("\n")}</code></pre>`;
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

// Terminal colour and control sequences (TERMINAL_SEQUENCE) are presentation
// noise in recorded tool output. The reading view hides them; Raw output keeps
// the exact recorded text.

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

// Pane text longer than this starts folded, so the output comes first.
const PANE_OPEN_LINES = 8;

// A repl_send result whose recorded text repeats its call's code exactly shows
// only the output, naming its call's card (calls made together are recorded before
// their results); anything else keeps the ordinary result view. Pane text from
// pi-repl's report is shown as terminal text, under the report's own heading.
function replResultView(event, call) {
	const split = replResultSplit(event, call);
	if (!split) return resultView(event.text);
	const pane = replPaneActivity(split.activity);
	let activity = split.activity.trim() ? `<p class="repl-activity">${escape(split.activity.trim())}</p>` : "";
	if (pane) {
		const lines = pane.text.split("\n").length;
		const report = `<p>${escape(pane.heading)}</p>${pane.omitted ? `<p>${escape(pane.omitted)}</p>` : ""}${literalPre(pane.text)}`;
		activity = lines > PANE_OPEN_LINES
			? `<details class="repl-activity"><summary>Pane activity before this submission · ${lines} lines</summary>${report}</details>`
			: `<div class="repl-activity">${report}</div>`;
	}
	const output = split.output.trim() ? literalPre(split.output) : '<p class="empty-text">No output</p>';
	return `<div class="tool-fields">${activity}<section class="tool-field"><h3>Output${call.number ? ` · for ${call.number}` : ""}</h3>${output}</section></div>${rawOutput(event.text)}`;
}

// Recognise recorded argument shapes, not code syntax. Never reindent, split
// operators, resolve file paths, infer a successful edit, or execute anything.
// `calls`: the recorded repl_send calls by call ID, for their results.
function eventContent(event, fromClaude = false, calls = new Map()) {
	const literal = literalPre(event.text);
	if (event.kind === "result") {
		const images = (event.images ?? []).map((image, i) => image.unavailable
			? `<p class="recorded-image-error">Recorded image unavailable: ${escape(IMAGE_UNAVAILABLE[image.unavailable])}</p>`
			: `<figure class="recorded-image"><button type="button" class="recorded-image-open" aria-expanded="false" aria-label="Recorded image ${i + 1} · ${image.width} × ${image.height}. Enlarge"><img data-recorded-src="data:${image.mimeType};base64,${image.data}" width="${image.width}" height="${image.height}" alt="Recorded tool-result image ${i + 1}" decoding="async"><span>Enlarge</span></button><figcaption>${image.width} × ${image.height} · ${escape(image.mimeType.slice(6).toUpperCase())}</figcaption><p class="recorded-image-error" role="status" hidden></p></figure>`).join('');
		const answer = fromClaude && /^Tool result:\s*(?:functions\.)?AskUserQuestion$/i.test(event.label);
		return (event.text || answer ? `<label class="output-wrap"><input type="checkbox" aria-label="Wrap lines for ${escape(event.label || "tool output")}">Wrap lines</label>${answer ? answeredQuestions(event) : replResultView(event, calls.get(event.callId))}` : '') + images;
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
	const repl = replSendCall(event.label, event.text);
	// An unrecognised target is shown as recorded, never mapped to a runtime.
	if (repl) return `<div class="tool-path"><span class="field-label">${escape(repl.label ? `${repl.label} REPL` : "REPL")}</span>${codeInput(repl.code)}</div>${options(repl.args, repl.label ? ["code", "target"] : ["code"])}${rawArguments(event.text)}`;
	const name = /^Tool:\s*(?:functions\.)?(bash|exec_command|exec|codemode|read|edit|multiedit|askuserquestion)$/i.exec(event.label)?.[1].toLowerCase();
	let args;
	try { args = JSON.parse(event.text); }
	catch { return name === "codemode" ? codeInput(event.text) : literal; }
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
			if (typeof args.code === "string") return finish(codeInput(args.code), ["code"]);
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

const LIVE_STYLE = `.live-omitted { color:var(--muted); font-size:12px; margin:0 0 12px } .live-status a,[data-live-status] a { color:inherit; text-underline-offset:3px }
.live-state { margin:0 0 18px } .live-state:empty { display:none } .live-pending { color:var(--muted); font-size:12px; font-weight:400 } .live-notice { color:var(--muted); display:block; margin-top:4px }
.repl-sessions { list-style:none; padding:0; margin:0 0 14px } .repl-session { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 10px; padding:10px 14px; margin:0 0 8px; border:1px solid var(--line); border-radius:10px; background:var(--panel) } .repl-session-name { font-weight:600 } .repl-session-state,.repl-session code { color:var(--muted); font-size:12px }
.repl-status-error,.repl-status-timeout { color:var(--warning, var(--muted)) } details.repl-output > summary { padding:0; font:600 12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--muted) }
.pi-preview-repl code span.kw,.pi-preview-repl code span.cf,.pi-preview-repl code span.im { color:var(--syntax-keyword, var(--accent)) } .pi-preview-repl code span.dt { color:var(--syntax-type) } .pi-preview-repl code span.fu,.pi-preview-repl code span.bu { color:var(--syntax-function) } .pi-preview-repl code span.va,.pi-preview-repl code span.ot { color:var(--syntax-variable) } .pi-preview-repl code span.st,.pi-preview-repl code span.ss,.pi-preview-repl code span.sc,.pi-preview-repl code span.ch { color:var(--syntax-string, var(--ok, inherit)) } .pi-preview-repl code span.dv,.pi-preview-repl code span.bn,.pi-preview-repl code span.fl { color:var(--syntax-number) } .pi-preview-repl code span.co { color:var(--syntax-comment, var(--muted)); font-style:italic } .pi-preview-repl code span.op { color:var(--syntax-operator) } .pi-preview-repl code span.pp,.pi-preview-repl code span.pu { color:var(--syntax-punctuation) } .pi-preview-repl code span.er,.pi-preview-repl code span.al { color:var(--syntax-error, var(--error, inherit)) } .repl-code > .sourceCode > pre { padding:2px 0 0; margin:0 } .repl-entry .tool-path pre { white-space:pre-wrap; overflow-wrap:anywhere }
.repl-files { display:flex; flex-direction:column; align-items:flex-start; gap:10px; margin:4px 0 0 } .repl-file { display:flex; flex-direction:column; gap:6px; max-width:min(100%, 640px); padding:8px; border:1px solid var(--line); border-radius:8px; background:var(--panel); color:inherit; font-size:12px; text-decoration:none } .repl-file:hover { background:var(--hover) } .repl-file:focus-visible { outline:2px solid var(--accent); outline-offset:2px } .repl-file img { display:block; max-width:100%; max-height:420px; object-fit:contain; border-radius:4px; background:#fff } .repl-file-name { color:var(--muted); overflow-wrap:anywhere } .repl-file-other { flex-direction:row; align-items:center; gap:8px; padding:8px 10px } .repl-file-other .repl-file-name { color:var(--accent); text-decoration:underline } .repl-file-format { padding:1px 5px; border:1px solid var(--line); border-radius:4px; color:var(--muted); font:600 11px/1.4 system-ui }
.repl-new-entries { position:sticky; bottom:12px; display:block; margin:8px auto 0; padding:6px 12px; border:1px solid var(--line); border-radius:16px; background:var(--panel); color:inherit; font:600 12px/1.2 system-ui; cursor:pointer } .repl-new-entries[hidden] { display:none }
.live-newer { position:fixed; left:50%; bottom:16px; transform:translateX(-50%); z-index:50; min-height:32px; padding:6px 14px; border:1px solid var(--line); border-radius:999px; background:var(--panel); color:inherit; font:600 12px/1.2 system-ui; box-shadow:0 2px 8px #0002; cursor:pointer } .live-newer[hidden] { display:none } .live-newer:focus-visible { outline:2px solid var(--accent); outline-offset:2px }
@media(pointer:coarse) { .live-newer { min-height:44px } } @media print { .live-newer { display:none } }`;

// Shared head for Working and Live pages: same tokens, cards and controls.
function pageHead(title, appearanceStyle = "") {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>
${AGENT_PAGE_STYLE}
${appearanceStyle}
main > nav { margin-bottom:18px } main > nav a { display:inline-flex; align-items:center; min-height:32px; padding:6px 10px; border:1px solid var(--line); border-radius:6px; color:inherit; font:600 12px/1.2 system-ui; text-decoration:none } main > nav a:hover { background:var(--hover) }
.subtitle,.notices { color:var(--muted); font-size:12px } .subtitle { margin:0 0 8px; overflow-wrap:anywhere } .notices { margin:0 }
.notices-row { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px 12px; margin:0 0 18px } .working-bulk[hidden] { display:none }
.working-bulk { min-height:28px; padding:4px 10px; border:1px solid var(--line); border-radius:6px; background:transparent; color:inherit; font:600 12px/1.2 system-ui; cursor:pointer } .working-bulk:hover { background:var(--hover) } .working-bulk:focus-visible { outline:2px solid var(--accent); outline-offset:2px }
.event { margin:12px 0; border:1px solid var(--line); border-radius:10px; background:var(--panel); overflow:hidden } summary { padding:10px 14px; cursor:pointer; overflow-wrap:anywhere; font-weight:600 } summary:hover { background:var(--hover) } summary:focus-visible { outline:2px solid var(--muted); outline-offset:-4px; border-radius:6px } a:focus-visible { outline:2px solid var(--accent); outline-offset:2px }
.number { color:var(--muted); font-variant-numeric:tabular-nums; margin-right:8px }
.event-content { border-top:1px solid var(--line) }
pre { margin:0; padding:12px 14px; background:transparent; font:0.9em/1.6 ui-monospace,Menlo,monospace; white-space:pre-wrap; overflow-wrap:anywhere; tab-size:4 } pre code { font:inherit } pre.code-input > code > span,.repl-code pre > code > span { display:inline-block; padding-left:calc(var(--indent, 0ch) + 4ch); text-indent:calc(-4ch - var(--indent, 0ch)) }
.tool-description { margin:0 14px 12px; color:var(--muted); font-size:12px }
.tool-path { padding:12px 14px } .tool-path pre { padding:2px 0 0 } .field-label,.tool-field h3,.edit-replacement h2 { font:600 12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--muted); margin:0 }
.edit-replacement { padding:0 14px 14px } .edit-replacement h2 { margin:0 0 10px } .tool-field { margin:8px 0 } .tool-field pre { padding:4px 0 } .empty-text { color:var(--muted); font-size:12px; margin:4px 0 } .edit-replacement .tool-options { margin:12px 0 0 }
.tool-options { display:grid; grid-template-columns:fit-content(40%) minmax(0,1fr); gap:6px 12px; margin:0 14px 12px; font-size:12px } .tool-options dt { color:var(--muted); overflow-wrap:anywhere } .tool-options dd { margin:0; min-width:0 } .tool-options pre { padding:0; font-size:12px }
.task-summary { margin:12px 14px 0; white-space:pre-wrap; overflow-wrap:anywhere } .tool-fields { padding:12px 14px 2px } .tool-fields .tool-options { margin:0 0 10px } .tool-fields .tool-field { margin:0 0 10px } .tool-fields .empty-text { margin:0 }
.recorded-arguments,.recorded-input { border-top:1px solid var(--line) } .recorded-arguments > summary,.recorded-input > summary { color:var(--muted); font-size:12px; font-weight:400 }
.prompt pre,.progress pre,.reasoning pre { font:inherit }
.asked-question,.question-reply { margin:14px } .asked-question h2,.question-reply h3 { font-family:inherit; font-size:1em; font-weight:600; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; margin:0 0 8px } .question-header { color:var(--muted); font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere; margin:0 0 6px }
.question-options { padding-left:20px; margin:10px 0 } .question-options li { padding-left:3px; margin:10px 0 } .question-options strong,.question-prose { white-space:pre-wrap; overflow-wrap:anywhere } .question-options .question-prose { color:var(--muted); font-size:0.9em; margin-top:3px } .question-preview pre { white-space:pre-wrap; overflow-wrap:anywhere } .asked-question .tool-options { margin:8px 0 }
.repl-activity { color:var(--muted); font-size:12px; margin:0 0 10px; white-space:pre-wrap; overflow-wrap:anywhere } .repl-activity p { margin:0 } .repl-activity pre { padding:4px 0 0; font-size:12px } details.repl-activity > summary { padding:0; font-weight:400 } details.repl-activity[open] > summary { margin-bottom:4px }
.recorded-output { border-top:1px solid var(--line) } .recorded-output > summary { color:var(--muted); font-size:12px; font-weight:400 }
.result { position:relative } .result > summary { padding-right:120px } .result:not(:has(.output-wrap)) > summary { padding-right:14px }
.output-wrap { position:absolute; right:10px; top:6px; display:inline-flex; align-items:center; gap:6px; min-height:28px; padding:2px 6px; color:var(--muted); font-size:12px; cursor:pointer } .output-wrap input { margin:0; accent-color:var(--muted) } .output-wrap input:focus-visible { outline:2px solid var(--muted); outline-offset:2px }
.result pre { white-space:pre; overflow-x:auto; overflow-wrap:normal } .result:has(.output-wrap input:checked) pre { white-space:pre-wrap; overflow-wrap:anywhere }
.recorded-image { margin:14px; } .recorded-image-open { display:block; background:transparent; border:1px solid var(--line); border-radius:6px; padding:6px; color:var(--muted); font:12px/1.4 system-ui; cursor:zoom-in; min-width:44px; min-height:44px; max-width:100% } .recorded-image-open:hover { background:var(--hover) } .recorded-image-open:focus-visible { outline:2px solid var(--accent); outline-offset:2px } .recorded-image-open[hidden] { display:none }
.recorded-image-open img { display:block; width:auto; height:auto; max-width:100%; max-height:220px; object-fit:contain } .recorded-image-open span { display:block; padding-top:4px } .recorded-image figcaption,.recorded-image-error { font-size:12px; color:var(--muted); overflow-wrap:anywhere } .recorded-image figcaption { margin-top:6px } .event-content > .recorded-image-error { margin:14px } .inline-expanded { cursor:zoom-out } .inline-expanded img { max-height:none }
.recorded-image-dialog { background:var(--panel); color:var(--ink); border:1px solid var(--line); border-radius:10px; padding:12px; max-width:calc(100vw - 24px); max-height:calc(100dvh - 24px); overflow:auto } .recorded-image-dialog::backdrop { background:#000a } .recorded-image-dialog-header { display:flex; align-items:center; justify-content:space-between; gap:16px; font-size:12px; margin-bottom:8px } .recorded-image-dialog button { font:inherit; color:inherit; background:var(--hover); border:1px solid var(--line); border-radius:6px; min-height:44px; min-width:44px; padding:6px 12px; cursor:pointer } .recorded-image-dialog img { display:block; width:auto; height:auto; max-width:100%; max-height:calc(100dvh - 120px); object-fit:contain }
@media print { .recorded-image-open { border:0; padding:0 } .recorded-image-open span,.recorded-image-dialog { display:none } }
@media(max-width:500px) { pre { padding:12px } } @media(pointer:coarse) { .event summary, .working-bulk { min-height:44px } .output-wrap { min-height:44px; top:0 } } @media print { nav,.output-wrap,.working-bulk { display:none } .event { break-inside:avoid } .result pre { white-space:pre-wrap; overflow-wrap:anywhere } }
${LIVE_STYLE}
</style></head>`;
}

// Inputs open by default. Only recognised local-command history (a slash
// command answered by local command output) starts collapsed. Shared by Working and Live.
const localOutput = e => e?.kind === "result" && !e.callId && ["Command output", "Command error output"].includes(e.label);
function startsOpen(event, next, fromClaude) {
	if (event.kind !== "prompt" && event.label !== "User shell command") return false;
	return !(slashCommand(event, fromClaude) !== null && localOutput(next));
}

/** Recorded text stays inert; only validated raster bytes become image elements. */
export function buildTurnDetailsPage(details, responseUrl, label = "", appearanceStyle = "") {
	const bounded = createTurnDetails();
	for (const e of Array.isArray(details?.events) ? details.events.slice(0, 251) : []) {
		if (["prompt", "progress", "reasoning", "tool", "result"].includes(e?.kind)) bounded.add(e.kind, e.label, e.text, e.callId, e.images, details?.sourceAgent === "claude" ? e.questionAnswers : undefined);
	}
	const { events } = bounded.result;
	const fromClaude = details?.sourceAgent === "claude";
	const calls = replSendCalls(events);
	const rows = events.map((e, i) => `<details class="event ${e.kind}"${startsOpen(e, events[i + 1], fromClaude) ? " open" : ""}><summary><span class="number"${e.callId ? ` title="Call ID: ${escape(e.callId)}"` : ""}>${i + 1}</span> ${escape(claudeEnvelope(e, fromClaude)?.label ?? (e.label || e.kind))}</summary><div class="event-content">${eventContent(e, fromClaude, calls)}</div></details>`).join("\n");
	return `${pageHead("Working", appearanceStyle)}<body class="pi-preview-working"><main id="preview-root">${responseUrl ? `<nav><a href="${escape(responseUrl)}">← Preview</a></nav>` : ""}<h1>Working</h1><p class="subtitle">${escape(label)}${label ? " · " : ""}Prompt and activity for this response.</p><div class="notices-row"><p class="notices">Read-only view; some conversation content may be missing or shortened.</p>${rows ? '<button type="button" class="working-bulk" hidden>Expand all</button>' : ""}</div>${rows || "<p>No matching prompt or working details are available.</p>"}</main></body></html>`;
}


// ---- Live: recorded activity of one in-progress turn ----
/** One live card, from the same escaping renderer as Working; `next` is the card after it, as in Working.
 * `fromClaude` applies Claude-only presentation, from the snapshot's source agent (never from prompt text).
 * `calls`: the snapshot's repl_send calls (replSendCalls), so a REPL result can show only its output. */
export function renderLiveCard(event, number, fromClaude = false, next, calls = new Map()) {
	const open = startsOpen(event, next, fromClaude);
	const label = claudeEnvelope(event, fromClaude)?.label ?? (event.label || event.kind);
	// Only the record's absence is stated; nothing is inferred about the call.
	const pending = event.kind === "tool" && event.pending === true ? ' <span class="live-pending">· No result recorded yet</span>' : "";
	return `<details class="event ${escape(event.kind)}" data-event-id="${escape(event.id)}" data-event-version="${escape(liveCardVersion(event, calls))}"${open ? " open" : ""}><summary><span class="number"${event.callId ? ` title="Call ID: ${escape(event.callId)}"` : ""}>${number}</span> ${escape(label)}${pending}</summary><div class="event-content">${eventContent(event, fromClaude, calls)}</div></details>`;
}

/** The version a live card carries: its event's, plus what a REPL result shows from its call. */
export function liveCardVersion(event, calls = new Map()) {
	const binding = replResultBinding(event, calls);
	return binding ? `${event.version}.${binding}` : event.version;
}

/** Status line: only what the record says. Links are server-built, same-origin. */
export function liveStatusHtml({ status, completedHref, workingHref, previewHref, newerHref, unavailable = false, expired = false, absent = false, notices = [] } = {}) {
	const parts = [];
	const back = previewHref ? ` <a href="${escape(previewHref)}">Back to Preview</a>` : "";
	if (status === "completed") parts.push(completedHref
		? `Turn completed. <a href="${escape(completedHref)}">Open its response</a>${workingHref ? ` · <a href="${escape(workingHref)}">Working</a>` : ""}`
		// The answer was recorded but exceeds what Preview keeps: say so rather than wait for it.
		: unavailable ? `Turn completed, but its answer is too large to show in Preview.${back}`
		// This preview rendered the answer and its history has since dropped it.
		: expired ? `Turn completed; this preview no longer keeps its response.${back}`
		// A later turn has started and the answer is not here: it may still be rendering, or
		// predate this preview. Its link appears if it arrives.
		: absent ? `Turn completed; its response isn't in this preview at the moment.${back}`
		// A turn that recorded no final answer (a Codex compaction task) has no response to wait for.
		: previewHref ? `Turn completed without a final answer.${back}`
		: "Turn completed; its response will appear in Preview shortly.");
	else if (status === "interrupted") parts.push("Turn interrupted.");
	else if (status === "error") parts.push("Turn ended with an error.");
	else if (status === "incomplete") parts.push(`The response stopped at the model's output limit.${completedHref ? ` <a href="${escape(completedHref)}">Open the partial response</a>` : ""}`);
	if (newerHref) parts.push(`A newer turn has started. <a href="${escape(newerHref)}">Follow it</a>`);
	// What the source knows it left out or could not interpret (limits, a staged revert).
	for (const notice of Array.isArray(notices) ? notices.slice(0, 8) : []) if (typeof notice === "string" && notice) parts.push(`<span class="live-notice">${escape(notice.slice(0, 300))}</span>`);
	return parts.join(" ");
}

/** "Loaded" is when this view read activity already recorded; "Updated" is when it saw newer activity. */
export const liveTimeLabel = loaded => loaded ? "Loaded" : "Updated";

export function buildLivePage(snapshot, { label = "", appearanceStyle = "", statusHtml = "" } = {}) {
	const fromClaude = snapshot.sourceAgent === "claude";
	const calls = replSendCalls(snapshot.events, snapshot.omitted + 1);
	const cards = snapshot.events.map((event, i) => renderLiveCard(event, snapshot.omitted + i + 1, fromClaude, snapshot.events[i + 1], calls)).join("\n");
	const omitted = snapshot.omitted;
	return `${pageHead("Working · live", appearanceStyle)}<body class="pi-preview-working pi-preview-live"><main id="preview-root" data-live-cursor="${escape(`${snapshot.generation}:${snapshot.sequence}`)}"><h1>Working · live</h1><p class="subtitle">${escape(label)}${label ? " · " : ""}<span data-live-time-label>${liveTimeLabel(snapshot.loaded)}</span> <time data-live-updated="${Number(snapshot.updatedAt) || 0}">${escape(new Date(snapshot.updatedAt).toLocaleTimeString())}</time></p><div class="notices-row"><p class="notices">Read-only view; some conversation content may be missing or shortened.</p><button type="button" class="working-bulk" hidden>Expand all</button></div><p class="notices live-state" data-live-status role="status">${statusHtml}</p><p class="live-omitted" data-live-omitted="${omitted}"${omitted ? "" : " hidden"}>${omitted} earlier event${omitted === 1 ? "" : "s"} not shown.</p><div class="live-events">${cards}</div><button type="button" class="live-newer" hidden></button></main></body></html>`;
}


// ---- REPL: pi-repl's shared sessions and their recent recorded submissions ----
// Record text is untrusted and escaped like Working's; nothing here runs or sends code.
const REPL_STATES = {
	running: "Running",
	"runtime-ended": "Runtime ended: its pane has exited",
	ended: "Session ended",
	replaced: "Replaced by a new session with the same name; this view stays on the earlier one",
	unchecked: "Couldn't check the session",
	absent: "Not running",
};
// The record's statuses are pi-repl's; these are the words shown for them. `sending` lasts until the code is done
// (pi-repl 0.11.2's settle), as `sent` does for LFortran and Pi Studio; `captured` means it finished and its output was recorded.
const REPL_STATUSES = { sending: "pending", sent: "pending", captured: "done", timeout: "timed out", error: "error", note: "note" };
// What a status doesn't say, as its tooltip. A send waiting for its code (pi-repl 0.11.2's settle) stays `sending` until it's done.
const REPL_STATUS_TITLES = {
	sending: "Written before the code was sent; not proof that it's still running or that its sender is still waiting.",
	sent: "Sent, with no result recorded yet; not proof that it's still running or that its sender is still waiting.",
	timeout: "The sender stopped waiting; the code may have kept running.",
};
const REPL_LONG_OUTPUT_LINES = 40;
/** The most one REPL update takes, as sent. A page is the same cards plus its fixed shell. */
export const REPL_RESPONSE_BYTES = 2_000_000;
// Room left for an update's version, flags, state line and notices (each bounded).
const REPL_ENVELOPE_BYTES = 16_384;
const clockTime = ms => Number.isFinite(ms) ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
const omittedNote = (what, chars) => chars > 0 ? `<p class="empty-text">${escape(`${chars.toLocaleString("en")} more characters of ${what} not shown`)}</p>` : "";

// A person's request-ID prefixes, with the origin each belongs to and how the person sent it.
const REPL_PERSON_ROUTES = [["pi:send:", "pi-repl", "Pi"], ["pi:env:", "pi-repl", "Pi"], ["cli:send:", "pi-repl", "terminal"], ["cli:env:", "pi-repl", "terminal"],
	["studio:send:", "pi-studio", "Pi Studio"], ["studio:note:", "pi-studio", "Pi Studio"]];
/**
 * Who sent an entry (design-person-sends.md, P3). An agent's entry, by its label. A person's,
 * by the name in its label when a person's prefix vouches for it, with how they sent it.
 * Otherwise `User`: older labels name a command (`/repl send`) or describe a selection, not a person.
 */
function replEntryWho(entry) {
	if (entry.mode === "agent") return entry.origin === "pi-studio" && !/studio/i.test(entry.label) ? `${entry.label} (Pi Studio)` : entry.label;
	const route = REPL_PERSON_ROUTES.find(([prefix, origin]) => entry.origin === origin && entry.requestId?.startsWith(prefix));
	if (route) return `${entry.label} · via ${route[2]}`;
	return entry.origin === "pi-studio" ? "User · via Pi Studio" : "User";
}

function replCode(code, highlighted) {
	const lines = code.split("\n");
	// Pandoc's line spans have IDs ending -1, -2, …; code text can't contain `<span id="`, as Pandoc escapes `<`.
	if (highlighted) return `<div class="repl-code">${highlighted.replace(/<span id="[^"]*-(\d+)">/g, (span, n) => `${span.slice(0, -1)}${lineIndent(lines[n - 1] ?? "")}>`)}</div>`;
	return codeInput(code);
}

/**
 * One recorded submission. `number` is its place in the shown window; `runtimeLabel` names the
 * session's runtime; `highlighted` is Pandoc's HTML for its code (repl-highlight.js), if any.
 */
export function renderReplEntryCard(entry, number, runtimeLabel, highlighted, files) {
	const status = REPL_STATUSES[entry.status] ?? entry.status;
	const who = replEntryWho(entry);
	const title = REPL_STATUS_TITLES[entry.status] ? ` title="${escape(REPL_STATUS_TITLES[entry.status])}"` : "";
	const head = `<span class="number">${number}</span> ${escape(who)} · <span class="repl-status repl-status-${escape(entry.status)}"${title}>${escape(status)}</span>${entry.mode === "literate" ? " · note" : ""} · <time>${escape(clockTime(entry.createdAt))}</time>`;
	const prose = entry.prose ? `<div class="task-summary">${escape(entry.prose)}</div>${omittedNote("prose", (entry.displayOmitted?.prose ?? 0) + (entry.proseOmittedChars ?? 0))}` : "";
	const source = entry.code ? `<div class="tool-path"><span class="field-label">${escape(`${runtimeLabel} REPL`)}</span>${replCode(entry.code, highlighted)}</div>${omittedNote("code", (entry.displayOmitted?.code ?? 0) + (entry.codeOmittedChars ?? 0))}` : "";
	const lines = entry.output ? entry.output.split("\n").length : 0;
	// Code wraps (see lineIndent); output is terminal text, wrapped only with Wrap lines, as in Working's results.
	const wrap = entry.output.trim() ? '<label class="output-wrap"><input type="checkbox" aria-label="Wrap output lines">Wrap lines</label>' : "";
	const outputBody = entry.output.trim() ? literalPre(entry.output) : `<p class="empty-text">${entry.status === "sending" || entry.status === "sent" ? "No output recorded yet" : "No output"}</p>`;
	const output = entry.status === "note" && !entry.output ? "" : `<div class="tool-fields"><section class="tool-field">${lines > REPL_LONG_OUTPUT_LINES
		? `<details class="repl-output"><summary>Output · ${lines} lines</summary>${outputBody}</details>`
		: `<h3>Output</h3>${outputBody}`}${omittedNote("output", (entry.displayOmitted?.output ?? 0) + (entry.outputOmittedChars ?? 0))}</section></div>`;
	// Image and PDF files the entry names (repl-files.js), such as a saved plot: one tile each, stacked,
	// images first, with the file's name inside the tile and the path as written on hover; a tile opens its file in a new tab.
	const name = written => written.split(/[\\/]/).pop();
	const format = written => (/\.([^.]+)$/.exec(name(written))?.[1] ?? "").toUpperCase();
	const tiles = [...(files ?? []).filter(file => file.image), ...(files ?? []).filter(file => !file.image)].map(file =>
		`<a class="repl-file${file.image ? "" : " repl-file-other"}" href="${escape(file.url)}" target="_blank" rel="noopener noreferrer" title="${escape(file.written)}">${file.image
			? `<img src="${escape(file.url)}" alt="${escape(file.written)}" loading="lazy">`
			: `<span class="repl-file-format">${escape(format(file.written))}</span>`}<span class="repl-file-name">${escape(name(file.written))}</span></a>`).join("");
	const saved = tiles ? `<div class="tool-fields"><section class="tool-field"><h3>Files</h3><div class="repl-files">${tiles}</div></section></div>` : "";
	return `<details class="event result repl-entry" open data-entry-id="${escape(entry.id)}" data-entry-version="${escape(entry.version)}"><summary>${head}</summary><div class="event-content">${wrap}${prose}${source}${output}${saved}</div></details>`;
}

/** The session view's state line, from `view` (createReplLiveSource): sent with every update. */
export function replSessionStatusHtml(view, { sessionsHref = "" } = {}) {
	const parts = [];
	const state = REPL_STATES[view.state] ?? view.state;
	parts.push(`<strong>${escape(state)}</strong>${view.state === "unchecked" && view.reason ? `: ${escape(view.reason)}` : ""}.`);
	if (view.state === "replaced" && sessionsHref) parts.push(`<a href="${escape(sessionsHref)}">Open the current sessions</a>`);
	if (view.record === "none") parts.push("No shared record yet: nothing has been sent to it through pi-repl, agent-repl or Pi Studio.");
	else if (view.record === "unsupported") parts.push("Its shared record uses a version this page doesn't read.");
	parts.push(`<span class="repl-ages" data-repl-now="${Number(view.now) || 0}" data-repl-checked="${Number(view.checkedAt) || 0}" data-repl-read="${Number(view.readAt) || 0}">Session checked <span data-repl-age="checked"></span>${view.readAt ? `; record read <span data-repl-age="read"></span>` : ""}.</span>`);
	if (view.readError) parts.push(`<span class="live-notice">${escape(`The record couldn't be read just now: ${view.readError}`)}</span>`);
	return parts.join(" ");
}

/** What the shown window leaves out: sent with its cards, and kept until the next window. */
export function replWindowNoticesHtml(view) {
	const parts = [];
	if (view.clearedAt) parts.push(`<span class="live-notice">${escape(`Cleared at ${clockTime(view.clearedAt)}; earlier submissions are gone from the record.`)}</span>`);
	if (view.droppedEntries) parts.push(`<span class="live-notice">${escape(`${view.droppedEntries.toLocaleString("en")} older ${view.droppedEntries === 1 ? "entry was" : "entries were"} dropped to keep the record within its limits.`)}</span>`);
	if (view.notShown) parts.push(`<span class="live-notice">${escape(`${view.notShown.toLocaleString("en")} older ${view.notShown === 1 ? "entry isn't" : "entries aren't"} shown here.`)}</span>`);
	return parts.join(" ");
}

/**
 * The cards for a view's window, numbered within what is shown: the newest entries whose cards fit in
 * an update of `budget` bytes as sent, counting each card's ID twice (in `ids` and the card) and
 * leaving room for the rest of the update; a card too big highlighted is tried plain. `highlighted`
 * maps entry IDs to highlighted code. Returns the cards and how many older entries aren't shown.
 */
export function replEntryCards(view, highlighted = new Map(), budget = REPL_RESPONSE_BYTES, files = new Map()) {
	// A card's version covers the files it shows too (their routes and modification times), so it updates with them.
	const entries = (view.entries ?? []).map(entry => files.has(entry.id) ? { ...entry, version: `${entry.version}.${files.get(entry.id).signature}` } : entry);
	budget -= REPL_ENVELOPE_BYTES;
	const render = (entry, number, plain) => renderReplEntryCard(entry, number, view.label, plain ? undefined : highlighted.get(entry.id), files.get(entry.id)?.items);
	// As sent: the card's HTML, its ID and version, and its ID again in `ids`.
	const size = (entry, html) => Buffer.byteLength(JSON.stringify({ id: entry.id, version: entry.version, html })) + Buffer.byteLength(JSON.stringify(entry.id)) + 2;
	const plain = new Set(), html = [];
	let bytes = 0, start = entries.length;
	for (let i = entries.length - 1; i >= 0; i--) {
		let card = render(entries[i], i + 1, false);
		if (bytes + size(entries[i], card) > budget && highlighted.has(entries[i].id)) { card = render(entries[i], i + 1, true); plain.add(entries[i].id); }
		const cardBytes = size(entries[i], card);
		if (bytes + cardBytes > budget && start < entries.length) break;
		bytes += cardBytes; start = i; html[i] = card;
	}
	// Numbers count from the first card shown, so cards left out mean rendering again.
	const cards = entries.slice(start).map((entry, i) => ({ id: entry.id, version: entry.version, html: start ? render(entry, i + 1, plain.has(entry.id)) : html[i] }));
	return { cards, notShown: (view.notShown ?? 0) + start };
}

const REPL_INTRO = "Recent recorded submissions to this shared session, from any agent, Pi Studio or project, updating as they arrive. Code typed directly into the terminal isn't recorded here.";

/** One session's page. `updatesHref` is the page's same-origin polling address. */
export function buildReplSessionPage(view, { label = "", appearanceStyle = "", updatesHref = "", sessionsHref = "", highlighted, files } = {}) {
	const shown = replEntryCards(view, highlighted, undefined, files);
	const cards = shown.cards.map(card => card.html).join("\n");
	const notices = replWindowNoticesHtml({ ...view, notShown: shown.notShown });
	return `${pageHead(`REPL · ${view.label}`, appearanceStyle)}<body class="pi-preview-working pi-preview-repl"><main id="preview-root" data-repl-updates="${escape(updatesHref)}" data-repl-version="${escape(view.version ?? "")}">${sessionsHref ? `<nav><a href="${escape(sessionsHref)}" title="All REPL sessions (Option/Alt+Left)" aria-keyshortcuts="Alt+ArrowLeft">← REPL sessions</a></nav>` : ""}<h1>REPL · ${escape(view.label)}</h1><p class="subtitle">${escape(label)}${label ? " · " : ""}${escape(view.sessionName)}</p><p class="notices">${escape(REPL_INTRO)}</p><p class="live-status repl-session-status" aria-live="polite">${replSessionStatusHtml(view, { sessionsHref })}</p><p class="live-status repl-window-notices"${notices ? "" : " hidden"}>${notices}</p><div class="repl-entries">${cards || '<p class="empty-text repl-empty">No submissions recorded yet.</p>'}</div><button type="button" class="repl-new-entries" hidden>New entries below</button></main></body></html>`;
}

/** The list of pi-repl's shared sessions. `sessionHref(name)` links a running one; `missing` names one asked for that isn't. */
export function buildReplSessionsPage(list, { label = "", appearanceStyle = "", sessionHref = () => "", missing } = {}) {
	const present = list.sessions.filter(session => session.state !== "absent");
	const gone = list.sessions.find(session => session.sessionName === missing && session.state === "absent");
	const absent = list.sessions.filter(session => session.state === "absent").map(session => session.label);
	const rows = present.map(session => {
		const record = session.record === "v1" ? "" : session.record === "none" ? " · no shared record yet" : " · record version not supported";
		const state = `${REPL_STATES[session.state] ?? session.state}${session.state === "unchecked" && session.reason ? `: ${session.reason}` : ""}${record}`;
		const link = session.state === "unchecked" ? escape(session.label) : `<a href="${escape(sessionHref(session.sessionName))}">${escape(session.label)}</a>`;
		return `<li class="repl-session"><span class="repl-session-name">${link}</span> <span class="repl-session-state">${escape(state)}</span> <code>${escape(session.sessionName)}</code></li>`;
	}).join("");
	return `${pageHead("REPL sessions", appearanceStyle)}<body class="pi-preview-working pi-preview-repl"><main id="preview-root"><h1>REPL sessions</h1><p class="subtitle">${escape(label)}${label ? " · " : ""}Checked ${escape(clockTime(list.checkedAt))}</p><p class="notices">pi-repl's shared sessions, which agents reach through pi-repl or agent-repl, and Pi Studio through its REPL pane. Open one to follow its recent recorded submissions.</p>${gone ? `<p class="live-status"><span class="live-notice">${escape(`${gone.label} (${gone.sessionName}) isn't running now.`)}</span></p>` : ""}${rows ? `<ul class="repl-sessions">${rows}</ul>` : '<p class="empty-text">No shared REPL session is running. Sessions appear here once an agent or you start one with pi-repl, agent-repl or Pi Studio; they run in tmux.</p>'}${absent.length ? `<p class="notices">Not running: ${escape(absent.join(", "))}.</p>` : ""}</main></body></html>`;
}
