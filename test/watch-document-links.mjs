// Shared-server hook used by both Pi watch modes and agent-markdown-preview.
// Callers that don't opt in must retain the original document/link behavior.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserWatchServer, rewriteBrowserWatchLocalDocumentLinks } from "../shared/browser-watch-server.js";
import { readLinkedDocument } from "../shared/read-linked-document.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-preview-document-links-")));
const prefix = "/__pi_markdown_preview_document__/";
const html = body => `<!doctype html><html><head><title>Test</title></head><body>${body}</body></html>`;
const within = async (promise, label) => {
	let timer;
	try {
		return await Promise.race([promise, new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 5000);
		})]);
	} finally { clearTimeout(timer); }
};
const seen = [];
const rewritten = rewriteBrowserWatchLocalDocumentLinks('<a title="href=\'private.md\'" href="../report%20%26%20notes.md#details" target="_self">Report</a><a href="#local">Local</a><a href="https://example.com/x.md">Web</a><script>const example = \'<a href="secret.md">\';</script>', root, path => { seen.push(path); return "/allowed"; });
assert.deepEqual(seen, [join(root, "..", "report & notes.md")]);
assert.match(rewritten, /href="\/allowed#details" target="_blank" rel="noopener noreferrer"/);
assert.match(rewritten, /href="#local"/);
assert.match(rewritten, /href="https:\/\/example.com\/x.md"/);
assert.match(rewritten, /<script>const example = '<a href="secret.md">';<\/script>/);

const links = Array.from({ length: 5 }, (_, i) => `<a href="${i}.md">${i}</a>`).join("");
for (let i = 0; i < 5; i++) writeFileSync(join(root, `${i}.md`), `# ${i}`);
let ordinary, enabled;
let renders = 0, cancelled = 0;
try {
	const signal = new AbortController().signal;
	assert.equal(await readLinkedDocument(join(root, "0.md"), signal), "# 0");
	for (const [name, bytes, status] of [["large.md", Buffer.alloc(2 * 1024 * 1024 + 1), 413], ["binary.txt", Buffer.from([0, 1]), 415], ["invalid.txt", Buffer.from([0xff]), 415]]) {
		writeFileSync(join(root, name), bytes);
		await assert.rejects(readLinkedDocument(join(root, name), signal), error => error.statusCode === status);
	}
	const aborted = new AbortController(); aborted.abort();
	await assert.rejects(readLinkedDocument(join(root, "0.md"), aborted.signal), { name: "AbortError" });
	ordinary = await createBrowserWatchServer(html(links), root);
	assert.ok((await (await fetch(ordinary.url)).text()).includes('<a href="0.md">0</a>'), "opt-in only");
	enabled = await createBrowserWatchServer(html(links), root, {
		renderLocalDocument: (_path, signal) => {
			renders++;
			return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { cancelled++; reject(signal.reason); }, { once: true }));
		},
	});
	const first = await fetch(enabled.url);
	const headers = { cookie: first.headers.get("set-cookie").split(";")[0] };
	const body = await first.text();
	const urls = [...body.matchAll(/href="(\/__pi_markdown_preview_document__\/[^"#]+)"/g)].map(match => new URL(match[1], enabled.url));
	assert.equal(urls.length, 5);
	const unauthorized = await fetch(urls[0]);
	assert.equal(unauthorized.status, 403);
	await unauthorized.text();
	const missing = await fetch(new URL(`${prefix}${"0".repeat(64)}`, enabled.url), { headers });
	assert.equal(missing.status, 404);
	await missing.text();
	const waiting = [0, 1, 2, 3, 0].map(i => fetch(urls[i], { headers }).then(response => response.text()).catch(() => "closed"));
	const deadline = Date.now() + 3000;
	while (renders < 4 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(renders, 4, "concurrent opens of one file share a render");
	const limited = await fetch(urls[4], { headers });
	assert.equal(limited.status, 503, "limit parallel renders");
	await limited.text();
	await within(enabled.close(), "watch shutdown with linked-document requests in flight");
	await within(Promise.all(waiting), "settling cancelled HTTP requests");
	assert.equal(cancelled, 4, "closing the watcher cancels all linked-document renders");
	await within(enabled.close(), "repeated watch shutdown");
	const reopened = await createBrowserWatchServer(html("reopened"), root, { port: Number(new URL(enabled.url).port) });
	try {
		assert.match(await (await fetch(reopened.url)).text(), /reopened/);
	} finally { await within(reopened.close(), "shutdown after rebinding the same port"); }
} finally {
	await ordinary?.close();
	await enabled?.close();
	rmSync(root, { recursive: true, force: true });
}
console.log("PASS optional linked-document routes, bounded renders and cancellation");
