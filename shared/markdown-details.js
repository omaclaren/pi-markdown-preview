import { randomBytes } from "node:crypto";
import { collectMarkdownLiteralRanges } from "./markdown-html-comments.js";
import { collectMarkdownMathRanges } from "./markdown-sub-sup.js";

/**
 * Markers that pandoc-details.lua recognises carry this per-process nonce, passed to
 * Pandoc as the `pi-preview-details` metadata value. Content never sees it, so it
 * can neither forge a marker nor close one.
 */
export const DETAILS_MARKER_NONCE = randomBytes(8).toString("hex");

// Every details tag is visible to pairing (so an attributed one keeps its partner);
// only the exact forms below are ever converted.
const DETAILS_TAGS = /^<(?:\/?details\b[^>]*|\/?summary)>$/i;
const OPEN = /^<details(\s+open)?>[ \t]*(?:<summary>([^<>\r\n]*)<\/summary>[ \t]*)?$/i;
const SUMMARY = /^ {0,3}<summary>([^<>\r\n]*)<\/summary>[ \t]*$/i;
const CLOSE = /^<\/details>[ \t]*$/i;
// Any other opening or closing details tag on a line still takes part in pairing.
const ANY_OPEN = /<details\b[^>]*>/gi;
const ANY_CLOSE = /<\/details\s*>/gi;

// The summary is text, as on GitHub: escape Markdown punctuation, but leave HTML
// entities (& # ;) for Pandoc to decode, escaping only a leading heading marker.
const summaryText = text => {
	const escaped = text.trim().replace(/[!"$%'()*+,\-./:<=>?@[\\\]^_`{|}~]/g, "\\$&");
	return escaped.startsWith("#") ? `\\${escaped}` : escaped;
};

/**
 * Translate GitHub-style collapsible blocks into marker paragraphs, which
 * pandoc-details.lua turns into <details>/<summary> (HTML) or a bold summary
 * followed by the content (other formats). Raw HTML stays disabled, and the
 * content between the markers is ordinary Markdown: nothing in it can end the
 * block early.
 *
 * Only whole-line tags at the start of a line are interpreted: `<details>` or
 * `<details open>` (optionally followed by `<summary>…</summary>` on the same line),
 * a `<summary>…</summary>` line before the content (blank lines aside), and
 * `</details>`. Every details tag outside code, comments, front matter and math
 * takes part in pairing, so an indented or attributed tag keeps its own partner;
 * only a pair of two interpreted tags is converted, and everything else stays literal.
 */
export function normalizeDetailsBlocks(markdown, nonce = DETAILS_MARKER_NONCE) {
	const source = String(markdown ?? "");
	if (!/<details/i.test(source)) return source;
	const literalRanges = collectMarkdownLiteralRanges(source, DETAILS_TAGS);
	const protectedRanges = [...literalRanges, ...collectMarkdownMathRanges(source, literalRanges)];
	const lines = source.split(/(?<=\n)/);
	const kinds = [];
	const events = [];
	let offset = 0;
	lines.forEach((line, index) => {
		const text = line.replace(/\r?\n$/, "");
		const start = offset;
		offset += line.length;
		const literal = (from, to) => protectedRanges.some(range => range.start < start + to && range.end > start + from);
		const tagsFree = (match, ...tags) => tags.every(tag => { const at = match[0].toLowerCase().indexOf(tag); return at < 0 || !literal(match.index + at, match.index + at + tag.length); });
		let match;
		if ((match = OPEN.exec(text)) && tagsFree(match, "<details", "<summary>", "</summary>")) {
			kinds.push({ type: "open", open: Boolean(match[1]), summary: match[2] });
			events.push({ index, open: true, accepted: true });
			return;
		}
		if ((match = CLOSE.exec(text)) && tagsFree(match, "</details>")) {
			kinds.push({ type: "close" });
			events.push({ index, open: false, accepted: true });
			return;
		}
		if ((match = SUMMARY.exec(text)) && tagsFree(match, "<summary>", "</summary>")) kinds.push({ type: "summary", text: match[1] });
		else kinds.push(text.trim() ? { type: "text" } : { type: "blank" });
		// Tags this pass won't convert still pair with each other, in line order.
		const found = [];
		for (const pattern of [ANY_OPEN, ANY_CLOSE]) for (const tag of text.matchAll(pattern)) {
			if (!literal(tag.index, tag.index + tag[0].length)) found.push({ at: tag.index, open: pattern === ANY_OPEN });
		}
		for (const tag of found.sort((a, b) => a.at - b.at)) events.push({ index, open: tag.open, accepted: false });
	});
	// Pair opens with closes; only a pair of two interpreted tags is converted.
	const stack = [], closes = new Map();
	for (const event of events) {
		if (event.open) stack.push(event);
		else {
			const opening = stack.pop();
			if (opening?.accepted && event.accepted) closes.set(opening.index, event.index);
		}
	}
	const closing = new Map([...closes].map(([open, close], n) => [close, n]));
	const ids = new Map([...closes.keys()].map((open, n) => [open, n]));
	const marker = (kind, n) => `PiPreviewDetails${nonce}${kind}${n}`;
	const consumed = new Set();
	return lines.map((line, i) => {
		if (consumed.has(i)) return "";
		if (closing.has(i)) return `\n${marker("Close", closing.get(i))}\n\n`;
		if (!closes.has(i)) return line;
		const kind = kinds[i], n = ids.get(i);
		let summary = kind.summary;
		if (summary === undefined) {
			let j = i + 1;
			while (j < closes.get(i) && kinds[j]?.type === "blank") j++;
			if (kinds[j]?.type === "summary") { summary = kinds[j].text; consumed.add(j); }
		}
		const label = summary === undefined ? "" : summaryText(summary);
		return `\n${marker(kind.open ? "OpenExpanded" : "Open", n)}\n\n${label ? `${marker("Summary", n)} ${label}\n\n` : ""}`;
	}).join("");
}
