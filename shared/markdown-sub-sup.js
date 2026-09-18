import { collectMarkdownLiteralRanges } from "./markdown-html-comments.js";
import { readInlineMathTokenAt } from "./annotation-scanner.js";

/**
 * Translate bare, paired HTML sup/sub tags containing plain inline text into
 * Pandoc's native notation. Keep raw HTML disabled and literal/code contexts
 * byte-for-byte intact. Attributes and nested markup are not supported.
 */
export function normalizeSubSupTags(markdown) {
	const source = String(markdown ?? "");
	if (!/<(?:sup|sub)>/i.test(source)) return source;
	const literalRanges = collectMarkdownLiteralRanges(source);
	const overlaps = (ranges, start, end) => ranges.some(range => range.start < end && range.end > start);
	const mathRanges = [];
	const mathStarts = /[$\\]/g;
	let start;
	while ((start = mathStarts.exec(source))) {
		// Micromark sees Pandoc's backslash math delimiters as character escapes.
		// Accept that two-character range, but never math starts inside code.
		const escapedMathDelimiter = source[start.index] === "\\" && ["(", "["].includes(source[start.index + 1]);
		if (literalRanges.some(range => range.start <= start.index && range.end > start.index
			&& !(escapedMathDelimiter && range.start === start.index && range.end === start.index + 2))) continue;
		const closing = escapedMathDelimiter
			? source.indexOf(source[start.index + 1] === "(" ? "\\)" : "\\]", start.index + 2)
			: -1;
		const token = escapedMathDelimiter
			? (closing >= 0 ? { end: closing + 2 } : null)
			: readInlineMathTokenAt(source, start.index);
		if (token) {
			mathRanges.push({ start: start.index, end: token.end });
			mathStarts.lastIndex = token.end;
		}
	}
	const protectedRanges = [...literalRanges, ...mathRanges];
	const stack = [];
	const tags = /<(\/?)(sup|sub)>/gi;
	let tag;
	let cursor = 0;
	let output = "";
	while ((tag = tags.exec(source))) {
		if (overlaps(protectedRanges, tag.index, tags.lastIndex)) continue;
		const name = tag[2].toLowerCase();
		if (!tag[1]) {
			stack.push({ name, start: tag.index, contentStart: tags.lastIndex });
			continue;
		}
		const opening = stack.pop();
		if (!opening || opening.name !== name) { stack.length = 0; continue; }
		if (stack.length) continue;
		const content = source.slice(opening.contentStart, tag.index);
		if (!/^[^<>\r\n]+$/.test(content) || overlaps(protectedRanges, opening.start, tags.lastIndex)) continue;
		// Treat the contents as text, not another opportunity to introduce Markdown
		// structure. Leave HTML entities intact for Pandoc to decode normally.
		const text = content.replace(/[\\`*_[\]{}()!#$~^]/g, "\\$&").replace(/[ \t]/g, "\\ ");
		const delimiter = name === "sup" ? "^" : "~";
		output += source.slice(cursor, opening.start) + delimiter + text + delimiter;
		cursor = tags.lastIndex;
	}
	return output + source.slice(cursor);
}
