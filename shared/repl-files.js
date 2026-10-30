// Image and PDF files a REPL entry's code or output names, such as a plot it saved, so the REPL
// page can show them: thumbnails for images, links for PDFs. Only paths that appear in the
// recorded text and resolve to regular files are shown; nothing is read here but their stat.
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve } from "node:path";
import { IMAGE_CONTENT_TYPES } from "./image-page-preview.js";

const EXTENSIONS = "png|jpe?g|gif|webp|svg|pdf";
// A quoted path, as code writes one: savefig("out/fit.png"), png('plot.png').
const QUOTED = new RegExp(`(["'])([^"'\\r\\n\\0]{1,1024}?\\.(?:${EXTENSIONS}))\\1`, "gi");
// A bare path, as output prints one: "Saved to /tmp/fit.png." (a sentence's full stop isn't part of it).
const BARE = new RegExp(`(?:^|[\\s(=:,\\[])((?:~|\\.{1,2})?\\/?(?:[\\w@%+.,~-]+\\/)*[\\w@%+.,~-]+\\.(?:${EXTENSIONS}))(?=$|[\\s)\\]:;,'"]|\\.(?:\\s|$))`, "gim");
const CANDIDATES_PER_ENTRY = 20;
export const REPL_FILES_PER_ENTRY = 6;

/** The image and PDF paths an entry names, output first, as written, in order and without repeats. */
export function replFilePaths(entry) {
	const found = new Set();
	for (const text of [entry.output ?? "", entry.code ?? ""]) {
		for (const match of text.matchAll(QUOTED)) found.add(match[2]);
		for (const match of text.matchAll(BARE)) found.add(match[1]);
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
