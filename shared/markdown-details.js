import { collectMarkdownLiteralRanges } from "./markdown-html-comments.js";

const DETAILS_TAGS = /^<(?:details(?:\s+open)?|\/details|\/?summary)>$/i;
const OPEN = /^<details(\s+open)?>[ \t]*(?:<summary>([^<>\r\n]*)<\/summary>[ \t]*)?$/i;
const SUMMARY = /^ {0,3}<summary>([^<>\r\n]*)<\/summary>[ \t]*$/i;
const CLOSE = /^<\/details>[ \t]*$/i;

// The summary is text, as on GitHub: escape Markdown punctuation, but leave HTML
// entities (& # ;) for Pandoc to decode, escaping only a leading heading marker.
const summaryText = text => {
	const escaped = text.trim().replace(/[!"$%'()*+,\-./:<=>?@[\\\]^_`{|}~]/g, "\\$&");
	return escaped.startsWith("#") ? `\\${escaped}` : escaped;
};

/**
 * Translate GitHub-style collapsible blocks into Pandoc fenced divs with reserved
 * classes, which pandoc-details.lua turns into <details>/<summary> (HTML) or a bold
 * summary followed by the content (other formats). Raw HTML stays disabled.
 *
 * Only whole-line tags at the start of a line are interpreted: `<details>` or
 * `<details open>` (optionally followed by `<summary>…</summary>` on the same line),
 * a `<summary>…</summary>` line before the content, and `</details>`. Blocks must be
 * properly paired; code, comments, front matter and every other tag stay literal,
 * as does anything unpaired, attributed or indented into another block.
 */
export function normalizeDetailsBlocks(markdown) {
	const source = String(markdown ?? "");
	if (!/<details/i.test(source)) return source;
	const literalRanges = collectMarkdownLiteralRanges(source, DETAILS_TAGS);
	const lines = source.split(/(?<=\n)/);
	const kinds = [];
	let offset = 0;
	for (const line of lines) {
		const text = line.replace(/\r?\n$/, "");
		const start = offset;
		offset += line.length;
		// Only the tags themselves must be outside literal contexts (a code block, a
		// comment); summary text is escaped as text below, backticks included.
		const literal = (from, to) => literalRanges.some(range => range.start < start + to && range.end > start + from);
		const tagsFree = (match, ...tags) => tags.every(tag => { const at = match[0].toLowerCase().indexOf(tag); return at < 0 || !literal(match.index + at, match.index + at + tag.length); });
		let match;
		if ((match = OPEN.exec(text)) && tagsFree(match, "<details", "<summary>", "</summary>")) kinds.push({ type: "open", open: Boolean(match[1]), summary: match[2] });
		else if ((match = SUMMARY.exec(text)) && tagsFree(match, "<summary>", "</summary>")) kinds.push({ type: "summary", text: match[1] });
		else if ((match = CLOSE.exec(text)) && tagsFree(match, "</details>")) kinds.push({ type: "close" });
		else kinds.push(text.trim() ? { type: "text" } : { type: "blank" });
	}
	// Pair opens with closes; unpaired tags stay literal.
	const stack = [], closes = new Map();
	kinds.forEach((kind, i) => {
		if (kind?.type === "open") stack.push(i);
		else if (kind?.type === "close" && stack.length) closes.set(stack.pop(), i);
	});
	const closing = new Set(closes.values());
	const consumed = new Set();
	const output = lines.map((line, i) => {
		if (consumed.has(i)) return "";
		if (closing.has(i)) return "\n:::\n\n";
		if (!closes.has(i)) return line;
		const kind = kinds[i];
		let summary = kind.summary;
		if (summary === undefined) {
			// A summary line before any content, blank lines aside.
			let j = i + 1;
			while (j < closes.get(i) && kinds[j]?.type === "blank") j++;
			if (kinds[j]?.type === "summary") { summary = kinds[j].text; consumed.add(j); }
		}
		const label = summary === undefined ? "" : summaryText(summary);
		return `\n::: {.pi-preview-details${kind.open ? ' data-open="true"' : ""}}\n`
			+ (label ? `::: {.pi-preview-summary}\n${label}\n:::\n` : "")
			+ "\n";
	});
	return output.join("");
}
