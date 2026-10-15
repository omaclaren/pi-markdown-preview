import { randomBytes } from "node:crypto";
import { collectMarkdownLiteralRanges, readHtmlTag } from "./markdown-html-comments.js";
import { collectMarkdownMathRanges } from "./markdown-sub-sup.js";

/**
 * Markers that pandoc-details.lua recognises carry this per-process nonce, passed to
 * Pandoc as the `pi-preview-details` metadata value, so authored text cannot spell a
 * working marker.
 */
export const DETAILS_MARKER_NONCE = randomBytes(8).toString("hex");

const OPEN_LINE = /^<details(\s+open)?>[ \t]*(?:<summary>([^<>\r\n]*)<\/summary>[ \t]*)?$/i;
const SUMMARY_LINE = /^ {0,3}<summary>([^<>\r\n]*)<\/summary>[ \t]*$/i;
const CLOSE_LINE = /^<\/details>[ \t]*$/i;
const OPEN_TAG = /^<details(\s+open)?>$/i;
const CLOSE_TAG = /^<\/details>$/i;

// The summary is text, as on GitHub: escape Markdown punctuation, but leave HTML
// character references (& # ;) for Pandoc to decode, escaping only a leading heading
// marker. pandoc-details.lua reads it with Pandoc's own Markdown reader.
const summaryText = text => {
	const escaped = text.trim().replace(/[!"$%'()*+,\-./:<=>?@[\\\]^_`{|}~]/g, "\\$&");
	return escaped.startsWith("#") ? `\\${escaped}` : escaped;
};

/**
 * Every complete tag outside code, comments and front matter, read with the same
 * grammar as the literal-range pass (quote-aware, possibly spanning lines, names with
 * `:` or `-`), so text inside any tag's attributes is never read as another tag.
 */
function scanTags(source, literalRanges) {
	const literal = at => literalRanges.some(range => range.start <= at && range.end > at);
	const tags = [];
	let index = 0;
	while (index < source.length) {
		const start = source.indexOf("<", index);
		if (start < 0) break;
		const tag = literal(start) ? undefined : readHtmlTag(source, start);
		if (!tag) { index = start + 1; continue; }
		tags.push({ start, end: tag.end, close: source[start + 1] === "/", name: tag.tagName });
		index = tag.end;
	}
	return tags;
}

/**
 * Translate GitHub-style collapsible blocks into marker code blocks, which
 * pandoc-details.lua turns into <details>/<summary> (HTML) or a bold summary
 * followed by the content (other formats). Raw HTML stays disabled. A marker is a
 * fenced code block with a reserved class, which Markdown structure around it (a
 * definition list, a `:::` line) cannot reinterpret, and the content between markers
 * is ordinary Markdown. The summary travels inside its marker as escaped text.
 *
 * Only whole-line tags at the start of a line are converted: `<details>` or
 * `<details open>` (optionally followed by `<summary>…</summary>` on the same line), a
 * `<summary>…</summary>` line before the content (blank lines aside), and
 * `</details>`. Every details tag outside code, comments, front matter and math takes
 * part in pairing (an attributed, indented, inline or multiline one too), so only a
 * pair of two convertible tags is converted, and everything else stays literal.
 */
export function normalizeDetailsBlocks(markdown, nonce = DETAILS_MARKER_NONCE) {
	const source = String(markdown ?? "");
	if (!/<\/?details/i.test(source)) return source;
	// Code, comments and front matter; tags are tokenised here instead.
	const literalRanges = collectMarkdownLiteralRanges(source, /^</);
	const tags = scanTags(source, literalRanges);
	// Math, found with each tag masked by `x` (not spaces, which would end inline math
	// such as `$<details>$`): a `$` in an attribute is not math, but a tag inside math is.
	let masked = source;
	for (const tag of tags) masked = masked.slice(0, tag.start) + source.slice(tag.start, tag.end).replace(/[^\r\n]/g, "x") + masked.slice(tag.end);
	const mathRanges = collectMarkdownMathRanges(masked, literalRanges);
	const inMath = at => mathRanges.some(range => range.start <= at && range.end > at);
	const details = tags.filter(tag => tag.name === "details" && !inMath(tag.start));
	// A summary needs both tags read as tags: not code-quoted, escaped or in math.
	const summaryTags = new Set(tags.filter(tag => tag.name === "summary" && !inMath(tag.start)).map(tag => `${tag.close ? "/" : ""}${tag.start}`));
	const summaryTagsAt = (lineStart, text) => {
		const lower = text.toLowerCase();
		return summaryTags.has(`${lineStart + lower.indexOf("<summary>")}`) && summaryTags.has(`/${lineStart + lower.lastIndexOf("</summary>")}`);
	};

	const lines = source.split(/(?<=\n)/);
	const lineStarts = [];
	let offset = 0;
	for (const line of lines) { lineStarts.push(offset); offset += line.length; }
	const lineOf = new Map(lineStarts.map((start, index) => [start, index]));
	const kinds = lines.map((line, index) => {
		const text = line.replace(/\r?\n$/, "");
		const summary = SUMMARY_LINE.exec(text);
		if (summary && summaryTagsAt(lineStarts[index], text)) return { type: "summary", text: summary[1] };
		return text.trim() ? { type: "text" } : { type: "blank" };
	});
	// A details tag is convertible only as a whole line of its own, at column 0.
	const events = details.map(tag => {
		const index = lineOf.get(tag.start);
		const text = index === undefined ? "" : lines[index].replace(/\r?\n$/, "");
		const token = source.slice(tag.start, tag.end);
		let accepted = false, open = false, summary;
		if (!tag.close && OPEN_TAG.test(token)) {
			const line = OPEN_LINE.exec(text);
			if (line && (line[2] === undefined || summaryTagsAt(tag.start, text))) { accepted = true; open = Boolean(line[1]); summary = line[2]; }
		} else if (tag.close && CLOSE_TAG.test(token)) accepted = CLOSE_LINE.test(text);
		return { index, close: tag.close, accepted, open, summary };
	});
	// Pair in source order; only a pair of two convertible tags is converted.
	const stack = [], pairs = [];
	for (const event of events) {
		if (!event.close) { stack.push(event); continue; }
		const opening = stack.pop();
		if (opening?.accepted && event.accepted) pairs.push([opening, event]);
	}
	const openAt = new Map(), closeAt = new Map();
	pairs.forEach(([opening, closing], n) => { openAt.set(opening.index, { ...opening, n, end: closing.index }); closeAt.set(closing.index, n); });

	const block = text => {
		let longest = 2;
		for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
		const fence = "`".repeat(longest + 1);
		return `\n${fence}{.pi-preview-details-marker}\n${text}\n${fence}\n\n`;
	};
	const marker = (kind, n) => `PiPreviewDetails${nonce}${kind}${n}`;
	const consumed = new Set();
	return lines.map((line, i) => {
		if (consumed.has(i)) return "";
		if (closeAt.has(i)) return block(marker("Close", closeAt.get(i)));
		const opening = openAt.get(i);
		if (!opening) return line;
		let summary = opening.summary;
		if (summary === undefined) {
			let j = i + 1;
			while (j < opening.end && kinds[j]?.type === "blank") j++;
			if (kinds[j]?.type === "summary") { summary = kinds[j].text; consumed.add(j); }
		}
		const label = summary === undefined ? "" : summaryText(summary);
		return block(marker(opening.open ? "OpenExpanded" : "Open", opening.n)) + (label ? block(`${marker("Summary", opening.n)} ${label}`) : "");
	}).join("");
}
