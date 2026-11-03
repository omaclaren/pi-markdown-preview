// Image and PDF files a REPL entry's code or output names, such as a plot it saved, so the REPL
// page can show them: thumbnails for images, links for PDFs. Only paths that appear in the
// recorded text and resolve to regular files are shown; nothing is read here but their stat.
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve } from "node:path";
import { IMAGE_CONTENT_TYPES } from "./image-page-preview.js";

const EXTENSIONS = "png|jpe?g|gif|webp|svg|pdf";
const QUOTES = "\"'`";
// A quoted path, as code writes one: savefig("out/fit.png"), png('plot.png'). The whole of the quoted text.
const QUOTED = new RegExp(`^[^\\0]{1,1024}\\.(?:${EXTENSIONS})$`, "i");
// A bare path, as output prints one: "Saved to /tmp/fit.png." (a sentence's full stop isn't part of it).
const BARE = new RegExp(`(?:^|[\\s(=:,\\[])((?:~|\\.{1,2})?\\/?(?:[\\w@%+.,~-]+\\/)*[\\w@%+.,~-]+\\.(?:${EXTENSIONS}))(?=$|[\\s)\\]:;,'"]|\\.(?:\\s|$))`, "gim");
const CANDIDATES_PER_ENTRY = 20;
export const REPL_FILES_PER_ENTRY = 6;

/**
 * The quoted text in `text`: a quote opens a span that only the same quote closes, on its line. A
 * backslash escapes the next character and a doubled quote stands for one, so neither closes it; a
 * span with either isn't `plain`. A quote with no close on its line, such as an apostrophe, opens
 * none, nor does any later one of that quote on that line.
 */
function quotedSpans(text) {
	const spans = [];
	let unclosed = "";
	for (let i = 0; i < text.length; i++) {
		const quote = text[i];
		if (quote === "\n" || quote === "\r") { unclosed = ""; continue; }
		if (!QUOTES.includes(quote) || unclosed.includes(quote)) continue;
		let plain = true, end = -1;
		for (let j = i + 1; j < text.length && text[j] !== "\n" && text[j] !== "\r"; j++) {
			if (text[j] === "\\") {
				if (text[j + 1] === "\n" || text[j + 1] === "\r") break;
				plain = false; j++;
			} else if (text[j] === quote) {
				if (text[j + 1] !== quote) { end = j; break; }
				plain = false; j++;
			}
		}
		if (end < 0) { unclosed += quote; continue; }
		spans.push({ start: i, end: end + 1, text: text.slice(i + 1, end), plain });
		i = end;
	}
	return spans;
}

/** The image and PDF paths an entry names, output first, as written, in order and without repeats. */
export function replFilePaths(entry) {
	const found = new Set();
	for (const text of [entry.output ?? "", entry.code ?? ""]) {
		const spans = quotedSpans(text);
		for (const span of spans) if (span.plain && QUOTED.test(span.text)) found.add(span.text);
		// Quoted text is blanked before bare paths are sought, so none is found inside it: the tail
		// of "fit 2.png" isn't 2.png.
		let bare = "", at = 0;
		for (const span of spans) { bare += text.slice(at, span.start) + " ".repeat(span.end - span.start); at = span.end; }
		for (const match of (bare + text.slice(at)).matchAll(BARE)) found.add(match[1]);
	}
	return [...found].slice(0, CANDIDATES_PER_ENTRY);
}

/** A written path made absolute: against home for `~/`, else against the session's directory, if it has one. */
function resolveWritten(written, cwd) {
	if (written.startsWith("~/")) return resolve(homedir(), written.slice(2));
	if (isAbsolute(written)) return resolve(written);
	return typeof cwd === "string" && isAbsolute(cwd) ? resolve(cwd, written) : undefined;
}

/**
 * The files each entry names that exist now, by entry ID: up to REPL_FILES_PER_ENTRY of
 * `{ written, path, contentType, mtimeMs }`. `cwd` is the session's working directory, for
 * relative paths; without it only absolute and `~/` paths resolve.
 */
export async function resolveReplFiles(entries, cwd, { statFile = stat } = {}) {
	const found = new Map();
	await Promise.all(entries.map(async entry => {
		const files = [];
		for (const written of replFilePaths(entry)) {
			if (files.length >= REPL_FILES_PER_ENTRY) break;
			const extension = extname(written).toLowerCase();
			const contentType = extension === ".pdf" ? "application/pdf" : IMAGE_CONTENT_TYPES.get(extension);
			const path = resolveWritten(written, cwd);
			if (!contentType || !path || files.some(file => file.path === path)) continue;
			const info = await statFile(path).catch(() => undefined);
			if (info?.isFile()) files.push({ written, path, contentType, mtimeMs: Math.trunc(info.mtimeMs) });
		}
		if (files.length) found.set(entry.id, files);
	}));
	return found;
}
