// Image and PDF files a REPL entry's code or output names and that it wrote, such as a plot it
// saved, so the REPL page can show them: thumbnails for images, links for PDFs. Only paths that
// appear in the recorded text and resolve to regular files written while the entry ran are shown;
// nothing is read here but their stat.
import { createHash } from "node:crypto";
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
const WRITE_SLACK_MS = 2_000;
const PENDING = new Set(["sending", "sent"]);

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

/** The content type the page serves a file of this name as, if it shows that kind of file. */
export function replFileContentType(path) {
	const extension = extname(path).toLowerCase();
	return extension === ".pdf" ? "application/pdf" : IMAGE_CONTENT_TYPES.get(extension);
}

/**
 * A file's version: it changes when the file is written or replaced, even by a copy that keeps its
 * modification time (cp -p), which changes its inode or change time.
 */
export function replFileVersion(info) {
	return createHash("sha256").update([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":")).digest("hex").slice(0, 16);
}

/** A written path made absolute: against home for `~/`, else against the session's directory, if it has one. */
function resolveWritten(written, cwd) {
	if (written.startsWith("~/")) return resolve(homedir(), written.slice(2));
	if (isAbsolute(written)) return resolve(written);
	return typeof cwd === "string" && isAbsolute(cwd) ? resolve(cwd, written) : undefined;
}

/**
 * When an entry's code could have written a file: from when the entry was recorded, before its code
 * was sent, to WRITE_SLACK_MS after it was done, or after now while it's pending.
 */
function writeWindow(entry, now) {
	return { from: entry.createdAt, to: (PENDING.has(entry.status) ? now : entry.completedAt ?? entry.updatedAt) + WRITE_SLACK_MS };
}

/** When an entry finished: its completion, or for a finished status without one its last update; none while it's pending. */
const finishOf = entry => entry.completedAt ?? (PENDING.has(entry.status) ? undefined : entry.updatedAt);

/**
 * When each entry with code had its session to itself, by entry ID: `{ start, before }`. Sends to a
 * session take turns, but not in the order they were recorded (Pi Studio records a send before it
 * waits for its turn, an agent's tool once it has it), so turns go in the order entries finished. A
 * turn starts when its entry was recorded or when the one before finished, whichever is later, and a
 * file written once the next turn has started is the next entry's. While entries are pending, the
 * last to finish keeps no grace, as one of them may have started then. Notes don't count. (Pi
 * Studio's studioReplSessionRunBounds, which Sol and Astra reviewed in its candidate 116.)
 */
export function replSessionTurns(entries) {
	const finished = [], pending = [];
	for (const entry of entries) {
		if (entry.status === "note" || !entry.code?.trim()) continue;
		const finish = finishOf(entry);
		if (finish != null) finished.push({ entry, finish });
		else pending.push(entry);
	}
	finished.sort((a, b) => a.finish - b.finish);
	let last = -Infinity;
	const starts = finished.map(({ entry, finish }) => { const start = Math.max(entry.createdAt, last); last = finish; return start; });
	const turns = new Map(finished.map(({ entry, finish }, i) => [entry.id, { start: starts[i], before: i + 1 < finished.length ? starts[i + 1] : pending.length ? finish : Infinity }]));
	for (const entry of pending) turns.set(entry.id, { start: Math.max(entry.createdAt, last), before: Infinity });
	return turns;
}

/**
 * The files each of a session's entries names that it wrote, by entry ID: up to REPL_FILES_PER_ENTRY
 * of `{ written, path, contentType, version }`. `cwd` is the session's working directory, for
 * relative paths; without it only absolute and `~/` paths resolve. A file shows only if it was last
 * written while the entry ran, within its turn (replSessionTurns), so one that was already there
 * never does, however its name was read from the text, and a file a later entry rewrites shows
 * under that entry instead. Modification times and inferred turns aren't proof of which code wrote
 * a file: a copy that keeps its time (cp -p) shows under the entry whose time it carries.
 */
export async function resolveReplFiles(entries, cwd, { statFile = stat, now = Date.now } = {}) {
	const found = new Map();
	const at = now(), turns = replSessionTurns(entries);
	await Promise.all(entries.map(async entry => {
		const files = [];
		const { from, to } = writeWindow(entry, at);
		const turn = turns.get(entry.id), start = Math.max(from, turn?.start ?? -Infinity), before = turn?.before ?? Infinity;
		for (const written of replFilePaths(entry)) {
			if (files.length >= REPL_FILES_PER_ENTRY) break;
			const contentType = replFileContentType(written);
			const path = resolveWritten(written, cwd);
			if (!contentType || !path || files.some(file => file.path === path)) continue;
			const info = await statFile(path).catch(() => undefined);
			if (info?.isFile() && info.mtimeMs >= start && info.mtimeMs <= to && info.mtimeMs < before) files.push({ written, path, contentType, version: replFileVersion(info) });
		}
		if (files.length) found.set(entry.id, files);
	}));
	return found;
}
