import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import ts from "typescript";
import { normalizeSubSupTags } from "../shared/markdown-sub-sup.js";
import { createBrowserWatchServer } from "../shared/browser-watch-server.js";
import { openWatchControls } from "./watch-controls.mjs";

const affiliation = "Alan Li<sup>1</sup>, Oliver Maclaren<sup>1,2</sup>\n\n<sup>1</sup> Department\n\nH<sub>2</sub>O";
assert.equal(normalizeSubSupTags(affiliation), "Alan Li^1^, Oliver Maclaren^1,2^\n\n^1^ Department\n\nH~2~O");
assert.equal(normalizeSubSupTags("<SUP>1, 2</SUP>"), "^1,\\ 2^");
const literalCases = [
	"`<sup>1</sup>`", "``<sub>2</sub> ` example``", "    <sup>1</sup>\n", "\t<sub>2</sub>\n",
	"```html\n<sup>1</sup>\n```", "~~~html\n<sub>2</sub>\n~~~", "```\n<sup>1</sup>",
	"> ```html\n> <sup>1</sup>\n> ```", "- ```html\n  <sup>1</sup>\n  ```",
	"\\<sup>1</sup>", "<sup>1\\</sup>", "&lt;sup&gt;1&lt;/sup&gt;", "<!-- <sup>1</sup> -->",
	'<a title="<sup>1</sup>">link</a>', '[link](target "<sup>1</sup>")', '[link]: target "<sup>1</sup>"',
	"<sup onclick='alert(1)'>1</sup>", "<sup><em>1</em></sup>", "<sup><sub>1</sub></sup>", "<sup>line\nbreak</sup>",
	"<sup>unclosed", "<sup>1</sub>", "<sup></sup>", "$<sup>1</sup>$", "$$\n<sub>2</sub>\n$$",
	String.raw`\(<sup>1</sup>\)`, String.raw`\[<sub>2</sub>\]`,
	'---\ntitle: "<sup>1</sup>"\n---\n', '\uFEFF---\r\ntitle: "<sup>1</sup>"\r\n---\r\n',
];
for (const literal of literalCases) assert.equal(normalizeSubSupTags(literal), literal, "Preserve literal: " + literal);
assert.equal(normalizeSubSupTags('`<sup>1</sup>` next <sup>2</sup>'), '`<sup>1</sup>` next ^2^');
assert.equal(normalizeSubSupTags('<div>\n`<sup>1</sup>` next <sup>2</sup>\n</div>'), '<div>\n`<sup>1</sup>` next ^2^\n</div>');
assert.equal(normalizeSubSupTags('Prose\r\n\r\n<sup>1</sup>\r\n'), 'Prose\r\n\r\n^1^\r\n');
const pandoc = (source, format) => {
	const result = spawnSync(process.env.PANDOC_PATH || "pandoc", ["-f", "markdown+tex_math_dollars-raw_html-raw_attribute", "-t", format, "--wrap=none"], { input: source, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
};
const latex = pandoc(normalizeSubSupTags(affiliation), "latex");
assert.match(latex, /Li\\textsuperscript\{1\}/);
assert.match(latex, /Maclaren\\textsuperscript\{1,2\}/);
assert.match(latex, /H\\textsubscript\{2\}O/);
assert.match(pandoc(normalizeSubSupTags('<sup>1, 2</sup>'), 'html5'), /<sup>1,\s2<\/sup>/);

const scratch = await mkdtemp(join(tmpdir(), "pi-markdown-preview-document-updates-"));
const modulePath = resolve(`.pi-markdown-preview-document-updates-${process.pid}.mjs`);
const source = readFileSync(resolve("index.ts"), "utf8");
const compiled = ts.transpileModule(source + '\nexport { getPreviewStyle, prepareBrowserPreviewMarkdown, renderPreviewHtmlDocument, renderPreview };', {
	compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let preview;
let browser;
const servers = [];
try {
	process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
	await writeFile(modulePath, compiled);
	try { preview = await import(pathToFileURL(modulePath).href); }
	finally {
		await rm(modulePath, { force: true });
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	const style = preview.getPreviewStyle(undefined);
	const html = async markdown => (await preview.renderPreviewHtmlDocument(markdown, style, scratch)).html.replace('</head>', '<style>html { overflow-anchor: none; }</style></head>');
	const prepared = preview.prepareBrowserPreviewMarkdown(affiliation);
	assert.equal(prepared.normalizedMarkdown, normalizeSubSupTags(affiliation));
	assert.equal(preview.prepareBrowserPreviewMarkdown(affiliation, true).normalizedMarkdown, affiliation, 'Do not normalize LaTeX source.');
	const { executablePath, args } = preview.getPreviewBrowserLaunchOptions();
	browser = await puppeteer.launch({ headless: true, executablePath, args });
	const page = await browser.newPage();
	await page.setViewport({ width: 1000, height: 700 });
	const errors = [];
	page.on("pageerror", error => errors.push(String(error)));
	const ready = () => page.waitForFunction(() => window.__mermaidDone === true);
	const fixture = affiliation + '\n\n`<sup>literal</sup>`\n\n```html\n<sub>literal</sub>\n```\n\n<sup onclick="window.bad = true">unsafe</sup>\n\n<script>window.bad = true</script>';
	await page.setContent(await html(fixture));
	await ready();
	assert.deepEqual(await page.$$eval('#preview-root sup', elements => elements.map(e => e.textContent)), ['1', '1,2', '1']);
	assert.equal(await page.$eval('#preview-root sub', e => e.textContent), '2');
	assert.deepEqual(await page.$$eval('#preview-root code', elements => elements.map(e => e.textContent.trim())), ['<sup>literal</sup>', '<sub>literal</sub>']);
	assert.equal(await page.evaluate(() => Boolean(window.bad)), false);
	assert.equal(await page.$eval('sup', e => getComputedStyle(e).verticalAlign), 'super');
	const punctuated = '<sup>* _ ^ ~ $ [1] &amp; ²</sup>';
	await page.setContent(await html(punctuated));
	await ready();
	assert.equal(await page.$eval('sup', e => e.textContent.replace(/\u00a0/g, ' ')), '* _ ^ ~ $ [1] & ²');
	const png = await preview.renderPreview(affiliation, style, undefined, scratch, true);
	assert.equal(Buffer.from(png.pages[0].base64Png, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

	const document = (prefix = '', label = 'Section') => prefix + '\n\n' + Array.from({ length: 65 }, (_, index) =>
		`## ${label} ${index}\n\nParagraph ${index}: ` + 'A stable reading anchor with enough prose to wrap over several lines. '.repeat(8)
		+ (index === 4 ? '\n\n```text\n' + 'long code '.repeat(100) + '\n```' : ''),
	).join('\n\n');
	const baseHtml = await html(document());
	const updatedHtml = await html(document('## Added above\n\n' + 'Inserted material above the reading position. '.repeat(100)));
	async function serverFor(content, options = {}) {
		const server = await createBrowserWatchServer(content, scratch, options);
		servers.push(server);
		return server;
	}
	const file = await serverFor(baseHtml, { preserveReadingPosition: true, sourceLabel: 'document.md' });
	const navigateUpdate = async (server, content) => {
		const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
		server.updateDocument(content);
		await navigation;
		await ready();
	};
	const target = '#section-35';
	const top = () => page.$eval(target, element => element.getBoundingClientRect().top);
	const scrollToTarget = async () => page.$eval(target, element => window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 60));
	const assertPosition = async (expected, message) => {
		try {
			await page.waitForFunction((selector, offset) => Math.abs(document.querySelector(selector).getBoundingClientRect().top - offset) < 4, { timeout: 5000 }, target, expected);
		} catch (cause) {
			throw new Error(`${message || 'Reading position'}: expected ${expected}, got ${await top()} on ${new URL(page.url()).search}`, { cause });
		}
		assert.ok(Math.abs(await top() - expected) < 4, message); // Allow cumulative CSS-pixel rounding across revisions.
	};
	await page.goto(file.url, { waitUntil: 'domcontentloaded' });
	await ready();
	await openWatchControls(page);
	await page.click('[data-watch-control="wrap-code"]');
	await scrollToTarget();
	const initialTop = await top();
	await navigateUpdate(file, updatedHtml);
	await assertPosition(initialTop, 'Insertions above the viewport must not displace the reading anchor.');
	assert.equal(await page.$eval('#preview-root', e => e.dataset.wrapCode), 'true', 'Restore after applying persisted wrapping.');
	await navigateUpdate(file, updatedHtml.replace('Paragraph 35:', 'Edited paragraph 35:'));
	await assertPosition(initialTop, 'A nearby unchanged anchor should handle edits to the paragraph being read.');
	await page.reload({ waitUntil: 'domcontentloaded' });
	await ready();
	await assertPosition(initialTop, 'Manual reload of the same file should also preserve position.');
	// Previous/Next are still the same file; history browsing must not auto-follow.
	await openWatchControls(page);
	await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('[data-watch-control="previous"]')]);
	await ready();
	await assertPosition(initialTop, 'Same-file revision navigation should retain the reading position.');
	const olderUrl = page.url();
	file.updateDocument(baseHtml);
	await page.waitForFunction(() => document.querySelector('[data-watch-control="latest"]').textContent.includes('(new)'));
	assert.equal(page.url(), olderUrl);
	await assertPosition(initialTop, 'A new revision must not disturb an older page being read.');
	await openWatchControls(page);
	await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('[data-watch-control="latest"]')]);
	await ready();
	await assertPosition(initialTop);

	// Simulate delayed math/PDF layout without relying on a CDN. The real render
	// completion signal is used; even changes after initial paint must settle first.
	const delayed = baseHtml.replace("window.__mermaidDone = true;", `window.finishLayout = () => {
		const block = document.createElement('div'); block.style.height = '650px'; document.getElementById('preview-root').prepend(block);
		window.__mermaidDone = true; window.dispatchEvent(new Event('pi-markdown-preview-ready'));
	};`);
	let navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
	file.updateDocument(delayed);
	await navigation;
	await page.waitForFunction(() => typeof window.finishLayout === 'function');
	await page.evaluate(() => window.finishLayout());
	await assertPosition(initialTop, 'Late rendering should preserve the same anchor.');
	// If another revision arrives before that restoration finishes, forward the
	// original snapshot rather than saving a half-rendered page's position.
	navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
	file.updateDocument(delayed);
	await navigation;
	await navigateUpdate(file, updatedHtml);
	await assertPosition(initialTop, 'Rapid updates must carry the original reading position forward.');

	// Ordinary images can finish after the renderer's completion event.
	let releaseImage;
	await page.setRequestInterception(true);
	page.on('request', request => {
		if (request.resourceType() === 'image' && !request.url().startsWith('data:')) {
			releaseImage = () => request.respond({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="grey"/></svg>' });
		} else void request.continue();
	});
	const withImage = await html(document('![Delayed image](late.svg)'));
	navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
	file.updateDocument(withImage);
	await navigation;
	for (let attempt = 0; !releaseImage && attempt < 100; attempt += 1) await new Promise(resolve => setTimeout(resolve, 20));
	assert.ok(releaseImage, 'The delayed image request must reach the test interceptor.');
	assert.equal(await page.$eval('#preview-root img', image => image.complete), false);
	await releaseImage();
	await ready();
	await page.waitForFunction(() => document.querySelector('#preview-root img').complete);
	await assertPosition(initialTop, 'Images loading after canonical rendering must not move the reading anchor.');
	await navigateUpdate(file, baseHtml);
	await assertPosition(initialTop);
	await page.setRequestInterception(false);
	page.removeAllListeners('request');

	// User interaction cancels late restoration; do not snap back after scrolling.
	navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
	file.updateDocument(delayed);
	await navigation;
	await page.waitForFunction(() => typeof window.finishLayout === 'function');
	await page.evaluate(() => {
		window.dispatchEvent(new WheelEvent('wheel', { deltaY: 400 }));
		window.scrollBy(0, 400);
		window.finishLayout();
	});
	await new Promise(resolve => setTimeout(resolve, 200));
	assert.ok(Math.abs(await top() - initialTop) > 100, 'Late rendering must not undo user scrolling.');

	// A whole-document replacement with no matching anchors falls back to ratio.
	await scrollToTarget();
	const ratio = await page.evaluate(() => window.scrollY / (document.documentElement.scrollHeight - innerHeight));
	const replacement = await html(document('', 'Replacement').replaceAll('Paragraph', 'Changed text'));
	await navigateUpdate(file, replacement);
	const newRatio = await page.evaluate(() => window.scrollY / (document.documentElement.scrollHeight - innerHeight));
	assert.ok(Math.abs(ratio - newRatio) < 0.002, 'Missing anchors should fall back to relative scroll position.');

	const otherFile = await serverFor(baseHtml, { preserveReadingPosition: true, sourceLabel: 'document.md' });
	await page.goto(otherFile.url, { waitUntil: 'domcontentloaded' });
	await ready();
	assert.equal(await page.evaluate(() => window.scrollY), 0, 'An independent watcher must not inherit another document position.');
	await navigateUpdate(otherFile, updatedHtml);
	assert.equal(await page.evaluate(() => window.scrollY), 0, 'A reader at the beginning should stay at the beginning when material is inserted.');
	await scrollToTarget();
	const responses = await serverFor(baseHtml, { sourceLabel: 'Assistant responses' });
	await page.goto(responses.url, { waitUntil: 'domcontentloaded' });
	await ready();
	await scrollToTarget();
	await navigateUpdate(responses, updatedHtml);
	assert.equal(await page.evaluate(() => window.scrollY), 0, 'A new assistant response still starts at the top.');
	assert.equal(await page.evaluate(() => typeof window.PiMarkdownPreviewReadingPosition), 'object', 'Response watchers can restore Back navigation within a revision without carrying position into a new response.');

	// Explicit fragments take priority over a stored position at another fragment.
	await page.goto(otherFile.url + '#section-10', { waitUntil: 'domcontentloaded' });
	await ready();
	await page.waitForFunction(() => Math.abs(document.querySelector('#section-10').getBoundingClientRect().top) < 2);
	await scrollToTarget();
	await navigateUpdate(otherFile, updatedHtml);
	await assertPosition(initialTop, 'An unchanged carried hash must not pin every refresh to an old heading.');

	const denied = await browser.newPage();
	await denied.evaluateOnNewDocument(() => { Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('Storage denied'); } }); });
	denied.on('pageerror', error => errors.push(String(error)));
	await denied.goto(otherFile.url, { waitUntil: 'domcontentloaded' });
	await denied.waitForFunction(() => window.__mermaidDone === true);
	await denied.evaluate(() => window.scrollTo(0, 1500));
	await Promise.all([denied.waitForNavigation({ waitUntil: 'domcontentloaded' }), Promise.resolve(otherFile.updateDocument(baseHtml))]);
	await denied.waitForFunction(() => window.__mermaidDone === true);
	assert.equal(await denied.evaluate(() => window.scrollY), 0, 'Storage denial degrades to normal navigation without crashing.');
	await denied.close();
	assert.deepEqual(errors, []);
	console.log('Document reading-position and safe sub/sup rendering checks passed.');
} finally {
	await browser?.close();
	await Promise.all(servers.map(server => server.close()));
	await preview?.closeSharedPreviewBrowser();
	await rm(modulePath, { force: true });
	await rm(scratch, { recursive: true, force: true });
}
