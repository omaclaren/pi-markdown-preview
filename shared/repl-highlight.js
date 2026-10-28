// Syntax highlighting for the REPL page's code. The code goes to Pandoc as data
// (a JSON document of code blocks), never as Markdown, so nothing in it is read
// as markup. One Pandoc run highlights every block not already cached; a block
// that can't be highlighted is shown as plain code.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

// pi-repl runtimes to Pandoc's (skylighting's) language names.
const LANGUAGES = { python: "python", ipython: "python", julia: "julia", r: "r", ghci: "haskell", clojure: "clojure", ruby: "ruby", java: "java", octave: "octave", matlab: "matlab", gnuplot: "gnuplot", cpp: "cpp" };
const CACHE_ENTRIES = 400, CACHE_CHARS = 8_000_000, QUEUE_RUNS = 4, QUEUE_CHARS = 2_000_000, WAITING = 32, TIMEOUT_MS = 5_000;

const runPandoc = (args, input) => new Promise((resolve, reject) => {
	const child = execFile(process.env.PANDOC_PATH || "pandoc", args, { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(String(stdout)));
	child.stdin?.end(input);
});

/**
 * Returns `highlight(items, runtime, { signal })`, where items are `{ key, code, id }` in one
 * runtime's language; it resolves to a Map from key to Pandoc's HTML for that block (keys it
 * couldn't do are absent), with the block's element IDs starting `id`, so that the same code twice
 * on a page doesn't share them. A block already being highlighted waits for that run; Pandoc runs
 * one at a time, behind at most QUEUE_RUNS waiting runs (QUEUE_CHARS of code), and at most WAITING
 * requests wait at once. When any of these is full, code stays plain. A request that has gone
 * (`signal`) stops waiting and holds nothing; a run nobody waits for any more is skipped, but one
 * that has started finishes (within TIMEOUT_MS) and is cached.
 */
export function createReplHighlighter({ run = runPandoc } = {}) {
	const cache = new Map(); // code hash -> HTML, oldest use first
	const pending = new Map(); // code hash -> the waiting or running job that will highlight it
	let cachedChars = 0, queuedRuns = 0, queuedChars = 0, waiting = 0;
	let queue = Promise.resolve();
	let api;
	const apiVersion = () => api ??= run(["-f", "markdown", "-t", "json"], "").then(out => JSON.parse(out)["pandoc-api-version"]).catch(error => { api = undefined; throw error; });
	const remember = (hash, html) => {
		cache.set(hash, html);
		cachedChars += html.length;
		while (cache.size > CACHE_ENTRIES || cachedChars > CACHE_CHARS) {
			const [oldest, value] = cache.entries().next().value;
			cache.delete(oldest);
			cachedChars -= value.length;
		}
	};
	const schedule = (language, items, chars) => {
		const job = { waiters: new Set() }; // a callback for each request waiting for it
		queuedRuns++;
		queuedChars += chars;
		job.done = queue.then(async () => {
			queuedRuns--;
			queuedChars -= chars;
			if (!job.waiters.size) return;
			const version = await apiVersion();
			// Its requests can go while Pandoc's version is found.
			if (!job.waiters.size) return;
			// Each block sits in a Div with a known ID; Pandoc escapes code text, so the markers can't occur in it.
			const blocks = items.map((item, i) => ({ t: "Div", c: [[`h${i}`, [], []], [{ t: "CodeBlock", c: [[`repl-${item.hash}`, [language], []], item.code] }]] }));
			const html = await run(["-f", "json", "-t", "html5", "--wrap=none"], JSON.stringify({ "pandoc-api-version": version, meta: {}, blocks }));
			items.forEach((item, i) => {
				const marker = `<div id="h${i}">`;
				const start = html.indexOf(marker);
				const end = i + 1 < items.length ? html.indexOf(`<div id="h${i + 1}">`) : html.length;
				if (start < 0 || end < start) return;
				const block = html.slice(start + marker.length, end).trim().replace(/<\/div>$/, "").trim();
				if (block.startsWith("<div class=\"sourceCode\"")) remember(item.hash, block);
			});
		}).catch(() => { /* Plain code instead. */ }).finally(() => {
			for (const item of items) if (pending.get(item.hash) === job) pending.delete(item.hash);
			for (const settled of [...job.waiters]) settled();
		});
		queue = job.done;
		for (const item of items) pending.set(item.hash, job);
		return job;
	};
	return async function highlight(items, runtime, { signal } = {}) {
		const language = LANGUAGES[runtime];
		const result = new Map();
		if (!language) return result;
		const keyed = items.filter(item => typeof item.code === "string" && item.code).map(item => ({ ...item, hash: createHash("sha256").update(`${language}\0${item.code}`).digest("hex").slice(0, 20) }));
		if (!signal?.aborted && waiting < WAITING) {
			const jobs = new Set(keyed.flatMap(item => pending.has(item.hash) ? [pending.get(item.hash)] : []));
			const missing = [...new Map(keyed.filter(item => !cache.has(item.hash) && !pending.has(item.hash)).map(item => [item.hash, item])).values()];
			const chars = missing.reduce((sum, item) => sum + item.code.length, 0);
			if (missing.length && queuedRuns < QUEUE_RUNS && queuedChars + chars <= QUEUE_CHARS) jobs.add(schedule(language, missing, chars));
			if (jobs.size) {
				// Until its jobs settle or its signal aborts; leaving takes its callback off every job.
				waiting++;
				await new Promise(resolve => {
					let left = jobs.size;
					const settled = () => { if (--left === 0) leave(); };
					const leave = () => { for (const job of jobs) job.waiters.delete(settled); signal?.removeEventListener("abort", leave); resolve(); };
					for (const job of jobs) job.waiters.add(settled);
					signal?.addEventListener("abort", leave, { once: true });
				});
				waiting--;
			}
		}
		for (const item of keyed) {
			const html = cache.get(item.hash);
			if (html === undefined) continue;
			cache.delete(item.hash);
			cache.set(item.hash, html);
			const id = item.id ?? `repl-${item.hash}`;
			// Pandoc writes the IDs only in these attributes; code text has its quotes escaped.
			result.set(item.key, html.replace(new RegExp(`(id="|href="#)repl-${item.hash}`, "g"), (_, attribute) => attribute + id));
		}
		return result;
	};
}
