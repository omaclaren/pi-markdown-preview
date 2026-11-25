import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createBrowserWatchServer, prepareBrowserWatchHtml } from "../shared/browser-watch-server.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1kAAAAASUVORK5CYII=", "base64");
const shell = "<!doctype html><html><head></head><body><article id=\"preview-root\"><p>Response</p></article></body></html>";
const offers = html => /<button data-watch-control="(?:export-html|print)"|window\.PiMarkdownPreviewExport = /.test(html);

test("Export: only a rendered preview offers Export HTML and Print, and its file name comes from the source", async t => {
	const preview = prepareBrowserWatchHtml(shell, { revision: 2, revisions: [1, 2], sourceLabel: 'notes/<unsafe>&".md' });
	assert.match(preview, /data-watch-control="export-html" type="button" data-export-name="notes\/&lt;unsafe&gt;&amp;&quot;\.md"/);
	assert.match(preview, /<button data-watch-control="print"/);
	assert.match(preview, /window\.PiMarkdownPreviewExport = /, "The export script is on the page.");
	for (const [name, navigation] of [
		["waiting", { revision: 1, revisions: [1], isWaiting: true }],
		["Working", { revision: 1, revisions: [1], view: "working", turnDetailsUrl: "/turn", identity: "i", instance: "n" }],
		["Live", { revision: 1, revisions: [1], view: "live", liveUrl: "/live", identity: "i", instance: "n" }],
		["REPL", { revision: 1, revisions: [1], view: "repl", replUrl: "/repl", identity: "i", instance: "n" }],
		["not exportable", { revision: 1, revisions: [1], exportable: false }],
	]) assert.equal(offers(prepareBrowserWatchHtml(shell, navigation)), false, name);

	// A watched HTML file is shown as itself, isolated: there is nothing to export.
	const root = await mkdtemp(join(tmpdir(), "preview-export-html-"));
	const servers = [];
	t.after(async () => { for (const server of servers) await server.close(); await rm(root, { recursive: true, force: true }); });
	const page = join(root, "page.html");
	await writeFile(page, "<!doctype html><p>Page</p>");
	servers.push(await createBrowserWatchServer("<!doctype html><p>Page</p>", root, { sourceLabel: "page.html", htmlFile: page }));
	servers.push(await createBrowserWatchServer(shell, root, { sourceLabel: "notes.md" }));
	assert.equal(offers(await (await fetch(servers[0].url)).text()), false, "HTML file");
	assert.equal(offers(await (await fetch(servers[1].url)).text()), true, "Markdown file");
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
	// A rendered page: a leading heading, local, missing, remote and chosen images, a drawn
	// figure and a PDF figure as the renderer frames it, local, in-page and external links, an
	// embedded file, code controls, a diagram whose marker names the page's own address (as
	// Mermaid's arrowMarkerAbsolute writes it) and inline styles naming the preview's server.
	// Rendering ends when the page says so, as the real renderer does after diagrams and maths.
	const html = `<!doctype html><html><head><title>Report</title></head><body><article id="preview-root">
<h1 id="top">Report</h1>
<p><img alt="Plot" src="plot.png"> <img alt="Gone" src="missing.png"> <img alt="Remote" src="https://example.com/remote.png"> <img alt="Chosen" src="other.png" srcset="data:image/png;base64,${png.toString("base64")} 1x"></p>
<canvas id="figure" width="20" height="10" style="width:100%;height:auto"></canvas>
<a class="pdf-page-preview" href="paper.pdf" title="Open the original PDF" style="width: 12px;"><canvas id="pdf-figure" class="pdf-page-preview-canvas" width="20" height="10" style="width:100%;height:auto"></canvas><span class="pdf-page-preview-badge">PDF ↗</span></a>
<p><a href="notes.md">notes</a> <a href="#top">top</a> <a href="https://example.com/">site</a></p>
<embed src="paper.pdf" type="application/pdf">
<div class="preview-code-block"><div class="preview-code-block-controls"><button type="button">Copy</button></div><pre><code>x = 1</code></pre></div>
<svg id="diagram" width="10" height="10"><defs><marker id="arrow"></marker></defs><path id="edge" d="M0 0L5 5"></path></svg>
<p><span id="local-style" style="background-image:url(plot.png)">styled</span> <span id="remote-style" style="background-image:url(&quot;https://example.com/bg.png&quot;)">remote</span></p>
</article>
<script>setTimeout(() => {
	for (const id of ['figure', 'pdf-figure']) { const c = document.getElementById(id).getContext('2d'); c.fillStyle = '#d33'; c.fillRect(0, 0, 20, 10); }
	document.getElementById('edge').setAttribute('marker-end', 'url(' + location.href + '#arrow)');
	window.__mermaidDone = true; dispatchEvent(new Event('pi-markdown-preview-ready'));
}, 1500);</script>
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

	// Print, chosen while the page is still rendering, closes the menu and prints once it's done.
	await page.evaluate(() => {
		window.__printed = [];
		window.print = () => { window.__printed.push(window.__mermaidDone === true); };
	});
	await page.click('[data-watch-control="toggle"]');
	assert.equal(await page.evaluate(() => window.__mermaidDone === true), false, "Still rendering.");
	await page.click('[data-watch-control="print"]');
	assert.equal(await page.$eval('[data-watch-control="controls"]', panel => panel.hidden), true);
	await page.waitForFunction(() => window.__printed.length === 1);
	assert.deepEqual(await page.evaluate(() => window.__printed), [true], "It printed once, after rendering.");

	const file = await page.evaluate(() => window.PiMarkdownPreviewExport.standaloneHtml());
	assert.match(file, /^<!doctype html>\n<html/);
	assert.match(file, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: http: https:;/);
	assert.doesNotMatch(file, /<script|<button|preview-code-block-controls"|pdf-page-preview-badge|pi-markdown-preview-watch-nav|127\.0\.0\.1|__pi_markdown_preview|token=|identity=|revision=/);
	assert.match(file, /<img alt="Plot" src="data:image\/png;base64,/, "A local image is copied in.");
	assert.match(file, /\[image “Gone” not available for this export\]/);
	assert.match(file, /<img alt="Remote" src="https:\/\/example\.com\/remote\.png">/, "A remote image stays remote, as in the preview.");
	assert.match(file, /<img alt="Chosen" src="data:image\/png;base64,[^"]+">/, "An image is the one the page chose.");
	const figure = /<img id="figure" style="width:100%;height:auto" src="data:image\/png;base64,([^"]+)" width="20" height="10">/.exec(file);
	assert.ok(figure, "A drawn figure becomes an image of its pixels.");
	assert.notEqual(figure[1], (await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 20; c.height = 10; return c.toDataURL("image/png"); })).split(",")[1], "It isn't blank.");
	assert.match(file, /<span class="pdf-page-preview" style="width: 12px;"><img id="pdf-figure" class="pdf-page-preview-canvas" style="width:100%;height:auto" src="data:image\/png;base64,[^"]+" width="20" height="10"><\/span>/, "A PDF figure keeps its frame's size, without the link.");
	assert.match(file, /<p>notes <a href="#top">top<\/a> <a href="https:\/\/example\.com\/">site<\/a><\/p>/, "A local link, whose address is on the preview's server, becomes its text; others stay links.");
	assert.match(file, /\[embedded file not included in this export\]/);
	assert.match(file, /<pre><code>x = 1<\/code><\/pre>/);
	assert.match(file, /<path id="edge" d="M0 0L5 5" marker-end="url\(#arrow\)">/, "A diagram's reference to itself stays, without the page's address.");
	assert.match(file, /<span id="local-style" style="background-image:none">/);
	assert.match(file, /<span id="remote-style" style="background-image:url\(&quot;https:\/\/example\.com\/bg\.png&quot;\)">/);
	assert.match(file, /:first-child\{margin-top:0\}/, "A leading heading keeps the watch page's spacing.");

	// Opened from disk, the file asks nothing of the preview's server and runs nothing.
	const saved = join(root, "Report.html");
	await writeFile(saved, file);
	const opened = await browser.newPage();
	const requests = [];
	await opened.setRequestInterception(true);
	opened.on("request", request => {
		if (/^(?:data|file):/.test(request.url())) return request.continue();
		requests.push(request.url());
		request.abort();
	});
	opened.on("pageerror", error => errors.push(String(error)));
	await opened.goto(pathToFileURL(saved).href, { waitUntil: "load" });
	assert.deepEqual(requests.filter(url => !url.startsWith("https://example.com/")), [], "Only the response's own remote images.");
	assert.equal(await opened.$eval("#pdf-figure", image => image.complete && image.naturalWidth), 20);
	await opened.close();

	// The menu: Export downloads a file named after the source.
	await page.evaluate(() => {
		window.__downloads = [];
		HTMLAnchorElement.prototype.click = function () { if (this.download) window.__downloads.push({ name: this.download, href: this.href }); };
	});
	if (await page.$eval('[data-watch-control="controls"]', panel => panel.hidden)) await page.click('[data-watch-control="toggle"]');
	await page.click('[data-watch-control="export-html"]');
	await page.waitForFunction(() => document.querySelector('[data-watch-control="export-html"]').textContent === "Exported");
	const downloads = await page.evaluate(() => window.__downloads);
	assert.equal(downloads.length, 1);
	assert.equal(downloads[0].name, "report.html");
	assert.match(downloads[0].href, /^blob:/);
	assert.equal(await page.$eval('[data-watch-control="export-html"]', button => button.hasAttribute("aria-busy")), false);

	// A newer response arriving during an export is followed once the export is done.
	await page.evaluate(() => {
		window.__stayed = true;
		window.PiMarkdownPreviewExport.downloadHtml = () => new Promise(resolve => { window.__finishExport = resolve; });
	});
	await page.click('[data-watch-control="export-html"]');
	server.updateDocument(shell.replace("Response", "Newer response"), { appendToHistory: true });
	await new Promise(resolve => setTimeout(resolve, 1500));
	assert.equal(await page.evaluate(() => window.__stayed), true, "Still exporting, the page stays.");
	await Promise.all([page.waitForNavigation(), page.evaluate(() => window.__finishExport("report.html"))]);
	assert.match(await page.$eval("#preview-root", root => root.textContent), /Newer response/);
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
	const names = await page.evaluate(() => [
		"notes.md", "Paper.TEX", "a/b:c*d?\"e<f>|g\u0007h", "  ", "Claude Code · project", "x".repeat(200), "é".repeat(150), "CON.md", "lpt1.notes", "draft. ",
	].map(label => window.PiMarkdownPreviewExport.fileName(label)));
	assert.deepEqual(names.slice(0, 5), ["notes.html", "Paper.html", "a-b-c-d-e-f-g-h.html", "x.html", "Claude Code · project.html"]);
	assert.equal(names[5], `${"x".repeat(120)}.html`);
	assert.equal(names[6], `${"é".repeat(100)}.html`, "Within 200 bytes, whole characters.");
	assert.deepEqual(names.slice(7), ["_CON.html", "_lpt1.notes.html", "draft.html"]);
});
