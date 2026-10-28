// Syntax highlighting for the REPL page's code. The code goes to Pandoc as data
// (a JSON document of code blocks), never as Markdown, so nothing in it is read
// as markup. One Pandoc run highlights every block not already cached; a block
// that can't be highlighted is shown as plain code.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

// pi-repl runtimes to Pandoc's (skylighting's) language names.
const LANGUAGES = { python: "python", ipython: "python", julia: "julia", r: "r", ghci: "haskell", clojure: "clojure", ruby: "ruby", java: "java", octave: "octave", matlab: "matlab", gnuplot: "gnuplot", cpp: "cpp" };
const CACHE_ENTRIES = 400, TIMEOUT_MS = 5_000;

const runPandoc = (args, input) => new Promise((resolve, reject) => {
	const child = execFile(process.env.PANDOC_PATH || "pandoc", args, { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(String(stdout)));
	child.stdin?.end(input);
});

/**
 * Returns `highlight(items)`, where items are `{ key, code }` in one runtime's language;
 * it resolves to a Map from key to Pandoc's HTML for that block (keys it couldn't do are absent).
 */
export function createReplHighlighter({ run = runPandoc } = {}) {
	const cache = new Map();
	let api;
	const apiVersion = () => api ??= run(["-f", "markdown", "-t", "json"], "").then(out => JSON.parse(out)["pandoc-api-version"]).catch(error => { api = undefined; throw error; });
	return async function highlight(items, runtime) {
		const language = LANGUAGES[runtime];
		const result = new Map();
		if (!language) return result;
		const keyed = items.filter(item => typeof item.code === "string" && item.code).map(item => ({ ...item, hash: createHash("sha256").update(`${language}\0${item.code}`).digest("hex").slice(0, 20) }));
		const missing = [...new Map(keyed.filter(item => !cache.has(item.hash)).map(item => [item.hash, item])).values()];
		if (missing.length) {
			try {
				// Each block sits in a Div with a known ID; Pandoc escapes code text, so the markers can't occur in it.
				const blocks = missing.map((item, i) => ({ t: "Div", c: [[`h${i}`, [], []], [{ t: "CodeBlock", c: [[`repl-${item.hash}`, [language], []], item.code] }]] }));
				const html = await run(["-f", "json", "-t", "html5", "--wrap=none"], JSON.stringify({ "pandoc-api-version": await apiVersion(), meta: {}, blocks }));
				missing.forEach((item, i) => {
					const marker = `<div id="h${i}">`;
					const start = html.indexOf(marker);
					const end = i + 1 < missing.length ? html.indexOf(`<div id="h${i + 1}">`) : html.length;
					if (start < 0 || end < start) return;
					const block = html.slice(start + marker.length, end).trim().replace(/<\/div>$/, "").trim();
					if (block.startsWith("<div class=\"sourceCode\"")) cache.set(item.hash, block);
				});
				while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value);
			} catch { /* Plain code instead. */ }
		}
		for (const item of keyed) if (cache.has(item.hash)) result.set(item.key, cache.get(item.hash));
		return result;
	};
}
