import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBrowserWatchServer, prepareBrowserWatchHtml } from "../shared/browser-watch-server.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1kAAAAASUVORK5CYII=", "base64");
const shell = "<!doctype html><html><head></head><body><article id=\"preview-root\"><p>Response</p></article></body></html>";

test("Export: only a response preview offers Export HTML and Print, and its file name comes from the source", () => {
	const preview = prepareBrowserWatchHtml(shell, { revision: 2, revisions: [1, 2], sourceLabel: 'notes/<unsafe>&".md' });
	assert.match(preview, /data-watch-control="export-html" type="button" data-export-name="notes\/&lt;unsafe&gt;&amp;&quot;\.md"/);
	assert.match(preview, /<button data-watch-control="print"/);
	assert.match(preview, /window\.PiMarkdownPreviewExport = /, "The export script is on the page.");
	for (const [name, navigation] of [
		["waiting", { revision: 1, revisions: [1], isWaiting: true }],
		["Working", { revision: 1, revisions: [1], view: "working", turnDetailsUrl: "/turn", identity: "i", instance: "n" }],
		["Live", { revision: 1, revisions: [1], view: "live", liveUrl: "/live", identity: "i", instance: "n" }],
		["REPL", { revision: 1, revisions: [1], view: "repl", replUrl: "/repl", identity: "i", instance: "n" }],
	]) {
		const html = prepareBrowserWatchHtml(shell, navigation);
		assert.doesNotMatch(html, /<button data-watch-control="(?:export-html|print)"|window\.PiMarkdownPreviewExport = /, name);
	}
});

const browserPath = process.env.PUPPETEER_EXECUTABLE_PATH;
test("Export: the file is the response as shown, standalone and inert; Print waits for rendering", {
	skip: !browserPath && "set PUPPETEER_EXECUTABLE_PATH to a dedicated test browser", timeout: 60_000,
}, async t => {
	const root = await mkdtemp(join(tmpdir(), "preview-export-"));
	let browser, server;
	t.after(async () => { await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); });
	await writeFile(join(root, "plot.png"), png);
	await writeFile(join(root, "notes.md"), "# Notes\n");
	await writeFile(join(root, "paper.pdf"), "%PDF-1.4\n");
	// A rendered page: a leading heading, local, missing and remote images, a drawn figure,
	// local, in-page and external links, an embedded file and code controls. Rendering ends
	// when the page says so, as the real renderer does after diagrams and maths.
	const html = `<!doctype html><html><head><title>Report</title></head><body><article id="preview-root">
<h1 id="top">Report</h1>
<p><img alt="Plot" src="plot.png"> <img alt="Gone" src="missing.png"> <img alt="Remote" src="https://example.com/remote.png"></p>
<canvas id="figure" width="20" height="10" style="width:100%;height:auto"></canvas>
<p><a href="notes.md">notes</a> <a href="#top">top</a> <a href="https://example.com/">site</a></p>
<embed src="paper.pdf" type="application/pdf">
<div class="preview-code-block"><div class="preview-code-block-controls"><button type="button">Copy</button></div><pre><code>x = 1</code></pre></div>
</article>
<script>setTimeout(() => { const c = document.getElementById('figure').getContext('2d'); c.fillStyle = '#d33'; c.fillRect(0, 0, 20, 10); window.__mermaidDone = true; dispatchEvent(new Event('pi-markdown-preview-ready')); }, 300);</script>
</body></html>`;
	server = await createBrowserWatchServer(html, root, { sourceLabel: "report.md" });
	const { default: puppeteer } = await import("puppeteer-core");
	browser = await puppeteer.launch({ executablePath: browserPath, headless: true, userDataDir: join(root, "browser") });
	const page = await browser.newPage();
	const errors = [];
	page.on("pageerror", error => errors.push(String(error)));
	// The test never reaches the network.
	await page.setRequestInterception(true);
	page.on("request", request => new URL(request.url()).hostname === "127.0.0.1" || request.url().startsWith("data:") || request.url().startsWith("blob:") ? request.continue() : request.abort());
	await page.goto(server.url, { waitUntil: "domcontentloaded" });

	// Called before rendering ends, the export waits for it: the figure has its pixels.
	const file = await page.evaluate(() => window.PiMarkdownPreviewExport.standaloneHtml());
	assert.ok(await page.evaluate(() => window.__mermaidDone === true));
	assert.match(file, /^<!doctype html>\n<html/);
	assert.match(file, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: http: https:;/);
	assert.doesNotMatch(file, /<script|<button|preview-code-block-controls"|pi-markdown-preview-watch-nav|127\.0\.0\.1|__pi_markdown_preview/);
	assert.match(file, /<img alt="Plot" src="data:image\/png;base64,/, "A local image is copied in.");
	assert.match(file, /\[image “Gone” not available for this export\]/);
	assert.match(file, /<img alt="Remote" src="https:\/\/example\.com\/remote\.png">/, "A remote image stays remote, as in the preview.");
	const figure = /<img id="figure" style="width:100%;height:auto" src="data:image\/png;base64,([^"]+)" width="20" height="10">/.exec(file);
	assert.ok(figure, "A drawn figure becomes an image of its pixels.");
	assert.notEqual(figure[1], (await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 20; c.height = 10; return c.toDataURL("image/png"); })).split(",")[1], "It isn't blank.");
	assert.match(file, /<p>notes <a href="#top">top<\/a> <a href="https:\/\/example\.com\/">site<\/a><\/p>/, "A local link, whose address is on the preview's server, becomes its text; others stay links.");
	assert.match(file, /\[embedded file not included in this export\]/);
	assert.match(file, /<pre><code>x = 1<\/code><\/pre>/);
	assert.match(file, /:first-child\{margin-top:0\}/, "A leading heading keeps the watch page's spacing.");

	// The menu: Export downloads a file named after the source; Print closes the menu and prints.
	await page.evaluate(() => {
		window.__downloads = [];
		HTMLAnchorElement.prototype.click = function () { if (this.download) window.__downloads.push({ name: this.download, href: this.href }); };
		window.__printed = 0;
		window.print = () => { window.__printed += 1; };
	});
	await page.click('[data-watch-control="toggle"]');
	await page.click('[data-watch-control="export-html"]');
	await page.waitForFunction(() => document.querySelector('[data-watch-control="export-html"]').textContent === "Exported");
	const downloads = await page.evaluate(() => window.__downloads);
	assert.equal(downloads.length, 1);
	assert.equal(downloads[0].name, "report.html");
	assert.match(downloads[0].href, /^blob:/);
	assert.equal(await page.$eval('[data-watch-control="export-html"]', button => button.hasAttribute("aria-busy")), false);
	if (await page.$eval('[data-watch-control="controls"]', panel => panel.hidden)) await page.click('[data-watch-control="toggle"]');
	await page.click('[data-watch-control="print"]');
	await page.waitForFunction(() => window.__printed === 1);
	assert.equal(await page.$eval('[data-watch-control="controls"]', panel => panel.hidden), true);
	assert.deepEqual(errors, []);
});

test("Export: file names are safe on any file system", async t => {
	if (!browserPath) return t.skip("set PUPPETEER_EXECUTABLE_PATH to a dedicated test browser");
	const root = await mkdtemp(join(tmpdir(), "preview-export-names-"));
	let browser, server;
	t.after(async () => { await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); });
	server = await createBrowserWatchServer(shell, root, { sourceLabel: "x" });
	const { default: puppeteer } = await import("puppeteer-core");
	browser = await puppeteer.launch({ executablePath: browserPath, headless: true, userDataDir: join(root, "browser") });
	const page = await browser.newPage();
	await page.goto(server.url, { waitUntil: "domcontentloaded" });
	const names = await page.evaluate(() => ["notes.md", "Paper.TEX", "a/b:c*d?\"e<f>|g\u0007h", "  ", "Claude Code · project", "x".repeat(200)].map(label => window.PiMarkdownPreviewExport.fileName(label)));
	assert.deepEqual(names.slice(0, 5), ["notes.html", "Paper.html", "a-b-c-d-e-f-g-h.html", "x.html", "Claude Code · project.html"]);
	assert.equal(names[5], `${"x".repeat(120)}.html`);
});
