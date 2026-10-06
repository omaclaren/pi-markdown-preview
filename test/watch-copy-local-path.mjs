import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createBrowserWatchServer } from "../shared/browser-watch-server.js";
import { addBrowserWatchLocalPathControls } from "../shared/local-path-controls.js";

const prefix = "/__pi_markdown_preview_document__/";
const doc = body => `<!doctype html><html><head><title>Source</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;margin:24px}p{line-height:1.7}</style></head><body><main id="preview-root">${body}</main></body></html>`;
const href = (html, id) => html.match(new RegExp(`id="${id}" href="([^"]+)"`))[1].replaceAll("&amp;", "&");
const login = async url => { const response = await fetch(url); return { html: await response.text(), headers: { cookie: response.headers.get("set-cookie").split(";")[0] } }; };
const browserPath = process.env.PUPPETEER_EXECUTABLE_PATH;
const browserOptions = { skip: !browserPath && "set PUPPETEER_EXECUTABLE_PATH to a dedicated test browser", timeout: 60_000 };
const selector = id => `.pi-preview-local-link:has(#${id}) > .pi-preview-copy-path`;
const navCopy = '.pi-preview-document-nav > .pi-preview-copy-path';
const feedback = (page, button, state) => page.waitForFunction((selector, state) => document.querySelector(selector)?.dataset.copyState === state && !document.querySelector(selector).hasAttribute("aria-busy"), {}, button, state);
const copy = async (page, button, state = "copied") => { await page.click(button); await feedback(page, button, state); };

async function fixture(t) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "preview-copy-path-")));
	const project = join(root, "project"), other = join(root, "other");
	await mkdir(project); await mkdir(other);
	const name = "report & résumé #1 '$&' <tag>.md";
	const file = join(other, name);
	await writeFile(file, "# Report");
	await symlink(file, join(project, "alias.md"));
	await writeFile(join(other, "figure.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="white"/><text x="80" y="100" font-family="sans-serif" font-size="40">Image path controls</text><path d="M80 720 Q500 140 900 450 T1500 200" fill="none" stroke="#367dc9" stroke-width="8"/></svg>');
	await writeFile(join(other, "report.pdf"), "%PDF-1.4\ntransport fixture\n");
	await writeFile(join(other, "page.html"), '<h1>Isolated HTML</h1><a href="unrelated.md">Authored link</a>');
	const source = doc(`<h1>Copy local paths</h1><p id="selection">Selected original words</p><p><a id="relative" href="../other/${encodeURIComponent(name)}#details">Relative report</a></p><p><a id="file-url" href="${pathToFileURL(file).href}">File URL report</a></p><p><a id="alias" href="alias.md">Symlink report</a></p><p><a id="image" href="../other/figure.svg">Image</a></p><p><a id="pdf" href="../other/report.pdf#page=2">PDF</a></p><p><a id="html" href="../other/page.html">HTML</a></p><p><a id="missing" href="missing.md" data-local-path="/NOT_AUTHORIZED">Missing file</a></p><p><a id="web" href="https://example.com/report.md">Web</a> <a id="fragment" href="#selection">Section</a> <a id="unsupported" href="private.zip">Unsupported</a></p>`);
	let browser;
	const server = await createBrowserWatchServer(source, project, { historyLimit: 2, renderLocalDocument: async () => doc('<h1 id="details">Nested report</h1><p><a id="nested" href="figure.svg">Nested image</a></p>') });
	t.after(async () => { await browser?.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
	return { root, project, other, file, source, server, async page() {
		const { default: puppeteer } = await import("puppeteer-core");
		browser = await puppeteer.launch({ executablePath: browserPath, headless: true, userDataDir: join(root, "browser") });
		const page = await browser.newPage(); await page.setViewport({ width: 1000, height: 740 });
		const errors = []; page.on("pageerror", error => errors.push(String(error)));
		// Never read or write the user's clipboard. Intercept modern and legacy paths.
		await page.evaluateOnNewDocument(() => {
			const state = window.__pathCopy = { mode: "modern", modern: [], legacy: [] };
			state.clipboard = { writeText: async text => {
				state.modern.push(text);
				if (state.mode === "pending") return new Promise((resolve, reject) => { state.finish = resolve; state.reject = reject; });
				if (state.mode !== "modern") throw new Error("Clipboard denied");
			} };
			Object.defineProperty(navigator, "clipboard", { configurable: true, value: state.clipboard });
			document.execCommand = command => {
				if (command !== "copy") throw new Error("Unexpected clipboard operation");
				const record = { text: document.querySelector('.pi-preview-path-copy-buffer')?.textContent };
				state.legacy.push(record);
				if (state.mode === "throw") throw new Error("Legacy copy denied");
				const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
				document.dispatchEvent(event);
				record.plain = event.clipboardData.getData('text/plain'); record.types = [...event.clipboardData.types];
				return state.mode !== "failed";
			};
		});
		await page.goto(server.url, { waitUntil: "load" });
		return { browser, page, errors };
	} };
}

test("local path metadata is opt-in, authenticated, safely serialized and creates no file-lookup endpoint", async t => {
	const f = await fixture(t);
	const { html, headers } = await login(f.server.url);
	assert.ok(html.includes("installLocalPathControls"));
	assert.ok(!html.includes(f.file), "HTML-sensitive filename characters are escaped inside the script data");
	assert.ok(html.includes("\\u003ctag>"));
	const url = new URL(href(html, "relative"), f.server.url);
	assert.ok(url.pathname.startsWith(prefix)); assert.equal(url.hash, "#details");
	assert.ok(!url.href.includes("résumé") && !url.href.includes("/other/"), "native Copy link stays an opaque browser URL");
	const unauth = await fetch(url); assert.equal(unauth.status, 403); assert.ok(!(await unauth.text()).includes(f.file));
	const page = await (await fetch(url, { headers })).text();
	assert.ok(page.includes("installLocalPathControls"));
	assert.ok(page.includes("\\u003ctag>"));
	const unknown = await fetch(new URL('/__pi_markdown_preview_local_path__?path=private.zip', f.server.url), { headers });
	assert.equal(unknown.status, 404); await unknown.text();
	const pdf = await fetch(new URL(href(html, "pdf"), f.server.url), { headers });
	assert.equal(pdf.headers.get("content-type"), "application/pdf"); assert.equal(await pdf.text(), "%PDF-1.4\ntransport fixture\n");
	const ordinary = await createBrowserWatchServer(f.source, f.project);
	try { assert.ok(!(await login(ordinary.url)).html.includes("installLocalPathControls")); } finally { await ordinary.close(); }
	const hostile = '/work/</script><script>window.injected=true</script>/$&\u2028.md';
	const safe = addBrowserWatchLocalPathControls(doc('<a href="/known">Known</a>'), new Map([["/known", hostile]]));
	assert.equal((safe.match(/<script>/g) || []).length, 1);
	assert.ok(safe.includes('\\u003c/script>')); assert.ok(safe.includes('$&\\u2028.md'));
});

test("copy paths beside links and on nested/image/HTML pages preserves native navigation and readable text", browserOptions, async t => {
	const f = await fixture(t); const { browser, page, errors } = await f.page();
	assert.equal(await page.$$eval('.pi-preview-copy-path-inline', nodes => nodes.length), 8);
	for (const id of ['web', 'fragment']) assert.equal(await page.$(selector(id)), null);
	const originalUrl = page.url(), link = await page.$eval('#relative', node => node.href);
	const before = await page.$eval('#preview-root', root => root.textContent);
	for (const [id, path] of [['relative', f.file], ['file-url', f.file], ['alias', join(f.project, 'alias.md')], ['pdf', join(f.other, 'report.pdf')], ['missing', join(f.project, 'missing.md')], ['unsupported', join(f.project, 'private.zip')]]) {
		await copy(page, selector(id));
		assert.equal(await page.evaluate(() => window.__pathCopy.modern.at(-1)), path);
		assert.equal(page.url(), originalUrl, 'copy must not navigate');
		assert.equal(await page.$eval('#preview-root', root => root.textContent), before, 'icons/feedback must not contaminate prose or reading-position text');
	}
	assert.equal(await page.$eval('#relative', node => node.href), link);
	assert.ok(await page.$eval('#relative', node => node.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true }))), 'native context menu is not intercepted');
	await page.focus('#relative'); await page.keyboard.press('Tab');
	assert.ok(await page.$eval(selector('relative'), button => button === document.activeElement && button.matches(':focus-visible')));
	await page.keyboard.press('Enter'); await feedback(page, selector('relative'), 'copied');
	assert.equal(await page.evaluate(() => window.__pathCopy.modern.at(-1)), f.file);

	const popupPromise = browser.waitForTarget(target => target.type() === 'page' && target !== page.target() && target.url().includes(prefix));
	await page.click('#relative', { button: 'middle' });
	const popup = await (await popupPromise).page(); await popup.waitForSelector(navCopy);
	assert.equal(await popup.evaluate(() => window.opener), null); await popup.close();
	await Promise.all([page.waitForNavigation(), page.click('#alias')]);
	await copy(page, navCopy);
	assert.equal(await page.evaluate(() => window.__pathCopy.modern.at(-1)), join(f.project, 'alias.md'), 'page action copies the same authored absolute path as its source link, not the symlink target');
	await copy(page, selector('nested'));
	assert.equal(await page.evaluate(() => window.__pathCopy.modern.at(-1)), join(f.other, 'figure.svg'), 'nested links use the linked document directory');
	await Promise.all([page.waitForNavigation(), page.click('#nested')]);
	await page.waitForFunction(() => document.querySelector('#preview-image')?.naturalWidth === 1600);
	await copy(page, navCopy); assert.equal(await page.evaluate(() => window.__pathCopy.modern.at(-1)), join(f.other, 'figure.svg'));
	if (process.env.COPY_PATH_SCREENSHOT) {
		await feedback(page, navCopy, 'idle');
		await page.screenshot({ path: process.env.COPY_PATH_SCREENSHOT });
	}
	await page.setViewport({ width: 320, height: 640, isMobile: true, hasTouch: true });
	assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
	assert.ok(await page.$eval(navCopy, button => button.getBoundingClientRect().height >= 44));
	const overlaps = await page.evaluate(() => {
		const a = document.querySelector('#image-size').getBoundingClientRect(), b = document.querySelector('.pi-preview-document-nav').getBoundingClientRect();
		return a.right > b.left && a.bottom > b.top && b.right > a.left && b.bottom > a.top;
	});
	assert.equal(overlaps, false, 'image sizing and path/navigation controls must not overlap on mobile');
	await page.goBack({ waitUntil: 'load' }); assert.ok(await page.$('#details'));
	await Promise.all([page.waitForNavigation(), page.click('.pi-preview-document-nav a')]);
	assert.equal(new URL(page.url()).searchParams.get('revision'), '1');
	await Promise.all([page.waitForNavigation(), page.click('#html')]);
	await copy(page, navCopy); assert.equal(await page.evaluate(() => window.__pathCopy.modern.at(-1)), join(f.other, 'page.html'));
	const frame = await (await page.$('iframe')).contentFrame();
	assert.equal(await frame.evaluate(() => { try { return parent.document.querySelector('.pi-preview-copy-path').textContent; } catch { return 'blocked'; } }), 'blocked');
	assert.equal(await frame.$('.pi-preview-copy-path'), null, 'authored HTML is not rewritten or given outer-page path metadata');
	assert.ok(await page.evaluate(() => document.querySelector('.pi-preview-document-nav').getBoundingClientRect().bottom <= document.querySelector('iframe').getBoundingClientRect().top), 'stacked mobile controls must not cover the HTML page');
	assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
	assert.deepEqual(errors, []);
});

test("copy fallback preserves selection, failures offer manual copying, pending requests are guarded and touch works", browserOptions, async t => {
	const f = await fixture(t); const { page, errors } = await f.page(); const button = selector('relative');
	for (const mode of ['absent', 'denied', 'failed', 'throw']) {
		await page.evaluate(({ mode, selector }) => {
			window.__pathCopy.mode = mode;
			Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'absent' ? undefined : window.__pathCopy.clipboard });
			document.querySelector(selector).addEventListener('click', () => {
				const range = document.createRange(); range.selectNodeContents(document.querySelector('#selection'));
				const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
			}, { capture: true, once: true });
		}, { mode, selector: button });
		const success = mode === 'absent' || mode === 'denied';
		await copy(page, button, success ? 'copied' : 'failed');
		const result = await page.evaluate(() => {
			const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() }); document.dispatchEvent(event);
			return { record: window.__pathCopy.legacy.at(-1), selected: window.getSelection().toString(), buffers: document.querySelectorAll('.pi-preview-path-copy-buffer').length, leaked: event.defaultPrevented };
		});
		assert.equal(result.record.text, f.file); assert.equal(result.buffers, 0); assert.equal(result.leaked, false);
		if (mode !== 'throw') { assert.equal(result.record.plain, f.file); assert.deepEqual(result.record.types, ['text/plain']); }
		if (success) assert.equal(result.selected, 'Selected original words');
		else {
			assert.equal(await page.$eval('.pi-preview-path-dialog textarea', field => field.value), f.file);
			assert.equal(await page.$eval('.pi-preview-path-dialog textarea', field => field.readOnly && field === document.activeElement), true);
			if (mode === 'failed') await page.focus('#relative'); // Escape also dismisses a non-modal panel after focus moves out.
			await page.keyboard.press('Escape');
			assert.equal(await page.$eval('.pi-preview-path-dialog', dialog => dialog.hidden), true);
			assert.equal(await page.$eval(button, button => button === document.activeElement), true);
		}
	}
	await page.evaluate(() => { window.__pathCopy.mode = 'pending'; });
	const before = await page.evaluate(() => window.__pathCopy.modern.length);
	await page.click(button); await page.waitForSelector(button + '[aria-busy="true"]');
	await page.$eval(button, button => { button.click(); button.click(); });
	assert.equal(await page.evaluate(() => window.__pathCopy.modern.length), before + 1);
	await page.evaluate(() => window.__pathCopy.finish()); await feedback(page, button, 'copied');
	await page.click(button); await page.waitForSelector(button + '[aria-busy="true"]');
	const legacyBefore = await page.evaluate(() => window.__pathCopy.legacy.length);
	await page.keyboard.press('Tab');
	await page.evaluate(() => window.__pathCopy.reject(new Error('Denied later'))); await feedback(page, button, 'failed');
	assert.equal(await page.evaluate(() => window.__pathCopy.legacy.length), legacyBefore, 'late failures must not steal a new selection/focus');
	assert.equal(await page.$eval('.pi-preview-path-dialog', dialog => dialog.hidden), true);
	await page.setViewport({ width: 320, height: 640, isMobile: true, hasTouch: true });
	await page.reload({ waitUntil: 'load' });
	assert.equal(await page.$eval(button, button => getComputedStyle(button).opacity), '1');
	assert.ok(await page.$eval(button, button => button.getBoundingClientRect().height >= 44));
	await page.tap(button); await feedback(page, button, 'copied');
	assert.equal(await page.evaluate(() => window.__pathCopy.modern.at(-1)), f.file);
	assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
	assert.deepEqual(errors, []);
});
