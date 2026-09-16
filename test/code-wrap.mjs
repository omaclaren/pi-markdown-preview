// Browser export fixture/width coverage adapted from David Lim's PR #13.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import ts from "typescript";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createBrowserWatchServer } from "../shared/browser-watch-server.js";
import { assertCodeCopy } from "./code-copy.mjs";

const scratch = await mkdtemp(join(tmpdir(), "pi-markdown-preview-code-wrap-"));
const modulePath = resolve(`.pi-markdown-preview-code-wrap-test-${process.pid}.mjs`);
const source = readFileSync(resolve("index.ts"), "utf8");
const exports = ["getPreviewStyle", "renderPreview", "buildBrowserHtmlFromPandocFragment", "MarkdownPreviewOverlay"];
const compiled = ts.transpileModule(source + `\nexport { ${exports.join(", ")} };`, {
	compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
let preview;
let browser;
const servers = [];
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
try {
	process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
	await writeFile(modulePath, compiled);
	try { preview = await import(pathToFileURL(modulePath).href); }
	finally {
		await rm(modulePath, { force: true });
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	const tools = [];
	preview.default({ on() {}, registerCommand() {}, registerTool(tool) { tools.push(tool); } });
	const exportTool = tools.find(tool => tool.name === "preview_export");
	assert.ok(exportTool);
	const fixture = [
		"Prose with a long token: " + "G".repeat(180) + " and more prose.", "",
		"```", "export fence line 1", "    export fence line 2 with spaces", "\texport fence line 3 with a tab",
		"export fence line 4 " + "H".repeat(120), "```", "",
		"```ts", 'const exportHighlighted = "' + "I".repeat(120) + '";', "```", "",
		"```diff", "- export removed " + "J".repeat(120), "+ export added " + "K".repeat(120), "```", "",
		"```text", "+----------------------+     +----------------------+",
		"|       Producer       | --> |       Consumer       |",
		"+----------------------+     +----------------------+", "```",
	].join("\n");
	const expectedText = [
		"export fence line 1\n    export fence line 2 with spaces\n    export fence line 3 with a tab\nexport fence line 4 " + "H".repeat(120),
		'const exportHighlighted = "' + "I".repeat(120) + '";',
		"- export removed " + "J".repeat(120) + "\n+ export added " + "K".repeat(120),
		"+----------------------+     +----------------------+\n|       Producer       | --> |       Consumer       |\n+----------------------+     +----------------------+",
	];
	const outputPath = join(scratch, "exported.html");
	const updates = [];
	const result = await exportTool.execute("wrap-export-test", {
		format: "html", source: "markdown", markdown: fixture, outputPath, fontSizePx: 15,
	}, undefined, update => updates.push(update.content?.[0]?.text ?? ""), { cwd: process.cwd(), ui: { theme: undefined } });
	assert.match(result.content[0].text, /Exported HTML preview from provided markdown\./);
	assert.deepEqual(result.details.paths, [outputPath]);
	assert.equal(result.details.format, "html");
	assert.equal(result.details.mimeType, "text/html");
	assert.equal(result.details.opened, false);
	assert.ok(updates.some(line => /Rendering HTML preview/.test(line)));

	const { executablePath, args } = preview.getPreviewBrowserLaunchOptions();
	browser = await puppeteer.launch({ headless: true, executablePath, args });
	const page = await browser.newPage();
	const pageErrors = [];
	page.on("pageerror", error => pageErrors.push(String(error)));
	const ready = () => page.waitForFunction(() => window.__mermaidDone === true);
	const metrics = () => page.evaluate(() => {
		const root = document.getElementById("preview-root");
		return {
			documentWidth: document.documentElement.scrollWidth,
			viewportWidth: window.innerWidth,
			paragraphText: root.querySelector("p").textContent,
			globalState: document.querySelector("[data-code-wrap-all]")?.getAttribute("aria-pressed"),
			blocks: [...root.querySelectorAll("pre")].map(pre => ({
				text: pre.textContent,
				clientWidth: pre.clientWidth,
				scrollWidth: pre.scrollWidth,
				whiteSpace: getComputedStyle(pre).whiteSpace,
				overflowWrap: getComputedStyle(pre).overflowWrap,
				override: pre.getAttribute("data-wrap-code"),
				buttons: pre.querySelectorAll("button").length,
			})),
		};
	});
	function checkText(value) {
		assert.equal(value.paragraphText, fixture.split("\n\n")[0]);
		assert.deepEqual(value.blocks.map(block => block.text), expectedText);
		assert.ok(value.blocks.every(block => block.buttons === 0), "Controls must stay outside the copyable code text.");
		assert.ok(value.documentWidth <= value.viewportWidth + 1, "Code overflow must remain inside its own scroll container.");
	}
	const controlOpacities = (target = page) => target.$$eval(".preview-code-block-controls", controls => controls.map(control => getComputedStyle(control).opacity));
	const clickBlock = async (index) => {
		const selector = `[data-code-wrap-block="${index}"]`;
		await page.hover(`.preview-code-block:has(${selector}) > pre`);
		await page.click(selector);
		await page.mouse.move(0, 0);
		assert.ok(await page.$eval(selector, button => button === document.activeElement), "Hiding pointer-clicked controls must not force a blur or disrupt keyboard navigation.");
		assert.equal((await controlOpacities())[index], "0", "A pointer-clicked button must hide on mouseleave even while it retains DOM focus.");
	};
	async function assertFloatingControls(target = page) {
		const result = await target.evaluate(() => {
			const controls = [...document.querySelectorAll(".preview-code-block-controls")];
			const geometry = controls.flatMap(control => {
				const wrapper = control.parentElement;
				const pre = wrapper.querySelector("pre");
				const box = pre.getBoundingClientRect();
				const style = getComputedStyle(pre);
				const previous = wrapper.previousElementSibling?.getBoundingClientRect();
				return [...control.querySelectorAll("button")].map(element => {
					const button = element.getBoundingClientRect();
					return {
						label: element.textContent,
						codeWidth: box.width,
						buttonLeft: button.left - box.left,
						buttonWidth: button.width,
						position: getComputedStyle(control).position,
						height: button.height,
						withinWidth: button.left >= box.left && button.right <= box.right,
						straddlesBorder: button.top < box.top && button.bottom > box.top,
						aboveCode: button.bottom <= box.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop),
						belowPrevious: !previous || button.top >= previous.bottom - 0.1,
						noRow: wrapper.getBoundingClientRect().height === box.height,
					};
				});
			});
			const positions = () => [document.getElementById("preview-root"), ...document.querySelectorAll("#preview-root pre")].map(element => {
				const box = element.getBoundingClientRect();
				return { x: box.x, y: box.y, width: box.width, height: box.height };
			});
			const withControls = positions();
			controls.forEach(control => { control.style.display = "none"; });
			const withoutControls = positions();
			controls.forEach(control => control.style.removeProperty("display"));
			return { geometry, withControls, withoutControls };
		});
		assert.ok(result.geometry.length > 0);
		assert.ok(result.geometry.every(item => item.position === "absolute" && item.height === 24 && item.withinWidth && item.straddlesBorder && item.aboveCode && item.belowPrevious && item.noRow), "Border controls must fit in the existing margins/padding without covering code or preceding content: " + JSON.stringify(result.geometry));
		assert.deepEqual(result.withControls, result.withoutControls, "Removing controls entirely must not change the document's geometry.");
	}
	for (const width of [1200, 600, 320]) {
		await page.setViewport({ width, height: 1800, deviceScaleFactor: 1 });
		await page.goto(pathToFileURL(outputPath).href, { waitUntil: "domcontentloaded" });
		await ready();
		let value = await metrics();
		checkText(value);
		assert.equal(value.globalState, "false", "Every fresh one-shot document should start unwrapped.");
		assert.ok(value.blocks.every(block => block.whiteSpace === "pre"));
		assert.ok(value.blocks[0].scrollWidth > value.blocks[0].clientWidth);
		assert.equal(await page.$$eval("[data-code-wrap-block]", buttons => buttons.length), 4);
		assert.equal(await page.$$eval("[data-code-copy-block]", buttons => buttons.length), 4);
		assert.equal(await page.$$eval("#preview-root > .preview-code-toolbar [data-code-wrap-all]", buttons => buttons.length), 1, "One-shot previews retain a standalone global control.");
		await page.mouse.move(0, 0);
		await assertFloatingControls();
		assert.deepEqual(await controlOpacities(), ["0", "0", "0", "0"], "Desktop controls should be hidden while neither hovered nor focused.");
		await page.hover('.preview-code-block:has([data-code-wrap-block="0"]) > pre');
		assert.deepEqual(await controlOpacities(), ["1", "0", "0", "0"], "Hovering a block should reveal only its own control.");
		await page.hover('[data-code-wrap-block="0"]');
		assert.equal((await controlOpacities())[0], "1", "Moving from the code onto its border button must not hide the button.");
		await assertFloatingControls();
		await page.mouse.move(0, 0);
		assert.deepEqual(await controlOpacities(), ["0", "0", "0", "0"], "Controls should disappear again when the pointer leaves.");

		await page.click("[data-code-wrap-all]");
		value = await metrics();
		checkText(value);
		assert.equal(value.globalState, "true");
		assert.ok(value.blocks.every(block => block.whiteSpace === "pre-wrap" && block.overflowWrap === "anywhere"));
		assert.ok(value.blocks.every(block => block.scrollWidth <= block.clientWidth + 1));

		await clickBlock(3);
		value = await metrics();
		checkText(value);
		assert.equal(value.globalState, "mixed");
		assert.equal(value.blocks[3].whiteSpace, "pre", "A diagram can be unwrapped without editing its source.");
		assert.ok(value.blocks.slice(0, 3).every(block => block.whiteSpace === "pre-wrap"));
		await page.click("[data-code-wrap-all]");
		value = await metrics();
		assert.equal(value.globalState, "true", "Mixed -> all wrapped.");
		assert.ok(value.blocks.every(block => block.override === null), "The global toggle clears all per-block exceptions.");
		await page.click("[data-code-wrap-all]");
		assert.equal((await metrics()).globalState, "false");
		await clickBlock(1);
		value = await metrics();
		assert.equal(value.globalState, "mixed");
		assert.equal(value.blocks[1].whiteSpace, "pre-wrap");
		assert.equal(value.blocks[0].whiteSpace, "pre");

		await page.focus("[data-code-wrap-all]");
		await page.mouse.move(0, 0);
		await page.keyboard.press("Tab");
		assert.equal((await controlOpacities())[0], "1", "Tab must reveal a hidden button without requiring a pointer hover.");
		assert.ok(await page.$eval('[data-code-wrap-block="0"]', button => button === document.activeElement && getComputedStyle(button).outlineStyle === "solid" && getComputedStyle(button).outlineWidth === "2px" && getComputedStyle(button).outlineOffset === "-2px"), "Border controls must retain a clear focus indicator inside their bounds.");
		await page.keyboard.press("Space");
		assert.equal((await metrics()).blocks[0].whiteSpace, "pre-wrap", "A keyboard user can toggle the revealed block control.");
		await page.mouse.move(5, 5);
		assert.equal((await controlOpacities())[0], "1", "Keyboard-focused controls must remain visible after activation and unrelated pointer movement.");
		await page.keyboard.down("Shift");
		await page.keyboard.press("Tab");
		await page.keyboard.up("Shift");
		assert.equal((await controlOpacities())[0], "0", "The button should hide when keyboard focus moves away.");
		await page.keyboard.press("Enter");
		assert.equal((await metrics()).globalState, "true", "Native buttons must be keyboard accessible.");
		await page.keyboard.press("w");
		assert.equal((await metrics()).globalState, "true", "The browser must not bind bare w.");
		await page.evaluate(() => window.PiMarkdownPreviewCodeWrap.installCodeWrapControls(document.getElementById("preview-root")));
		assert.equal(await page.$$eval("[data-code-wrap-all]", buttons => buttons.length), 1, "Repeated installation must not duplicate controls.");
	}
	await page.emulateMediaType("print");
	assert.ok(await page.$$eval(".preview-code-toolbar, .preview-code-block-controls", controls => controls.every(control => getComputedStyle(control).display === "none")), "Print must omit wrapping controls.");
	await page.emulateMediaType("screen");
	await page.reload({ waitUntil: "domcontentloaded" });
	await ready();
	assert.equal((await metrics()).globalState, "false", "One-shot wrapping is not a persistent preference.");

	const touchPage = await browser.newPage();
	await touchPage.setViewport({ width: 320, height: 900, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
	await touchPage.goto(pathToFileURL(outputPath).href, { waitUntil: "domcontentloaded" });
	await touchPage.waitForFunction(() => window.__mermaidDone === true);
	assert.ok(await touchPage.evaluate(() => matchMedia("(any-pointer: coarse)").matches));
	assert.deepEqual(await controlOpacities(touchPage), ["1", "1", "1", "1"], "Touch controls remain visible without hover.");
	await assertFloatingControls(touchPage);
	await touchPage.tap('[data-code-wrap-block="0"]');
	assert.equal(await touchPage.$eval("[data-code-wrap-all]", button => button.getAttribute("aria-pressed")), "mixed", "One tap should toggle a block, not merely reveal its button.");
	await touchPage.tap('[data-code-wrap-block="0"]');
	assert.equal(await touchPage.$eval("[data-code-wrap-all]", button => button.getAttribute("aria-pressed")), "false");
	assert.deepEqual(await controlOpacities(touchPage), ["1", "1", "1", "1"], "Touch controls remain visible after tapping, independently of focus-visible.");
	await touchPage.close();

	const html = await readFile(outputPath, "utf8");
	const server = await createBrowserWatchServer(html, scratch, { sourceLabel: "test/code-wrapping.md — " + "long source label ".repeat(8) });
	servers.push(server);
	await assertCodeCopy({ browser, fileUrl: pathToFileURL(outputPath).href, watchUrl: server.url, expectedText, assertFloatingControls });
	await page.goto(server.url, { waitUntil: "domcontentloaded" });
	await ready();
	assert.equal((await metrics()).globalState, "false");
	assert.equal(await page.$$eval("#preview-root > .preview-code-toolbar", toolbars => toolbars.length), 0, "Watch previews must not add a second toolbar above the document.");
	assert.equal(await page.$eval('#pi-markdown-preview-watch-nav [data-code-wrap-all]', button => button.textContent), "Wrap: off");
	for (const width of [1200, 700, 600, 320]) {
		await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
		await page.waitForFunction(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--pi-preview-watch-nav-height")) === Math.ceil(document.getElementById("pi-markdown-preview-watch-nav").getBoundingClientRect().height));
		checkText(await metrics());
		assert.ok(await page.evaluate(() => {
			const nav = document.getElementById("pi-markdown-preview-watch-nav");
			const box = nav.getBoundingClientRect();
			const items = [...nav.children].filter(item => !item.hidden).map(item => item.getBoundingClientRect());
			return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
				&& items.every(item => item.left >= box.left && item.right <= box.right && item.top >= box.top && item.bottom <= box.bottom)
				&& items.every((a, i) => items.slice(i + 1).every(b => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top));
		}), "The integrated watch toolbar must fit the viewport without overlapping controls, even with long source labels.");
		if (width <= 640) {
			await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
			assert.ok(await page.evaluate(() => document.getElementById("preview-root").getBoundingClientRect().bottom <= document.getElementById("pi-markdown-preview-watch-nav").getBoundingClientRect().top), "A multi-row bottom toolbar must not obscure the document's end.");
		}
	}
	// Exercise the real copy-link fallback without writing to the OS clipboard.
	await page.evaluate(() => {
		navigator.clipboard.writeText = async () => { throw new Error("Clipboard denied"); };
		document.execCommand = () => false;
	});
	await page.click('[data-watch-control="copy-link"]');
	await page.waitForFunction(() => !document.querySelector('[data-watch-control="share-panel"]').hidden);
	assert.ok(await page.evaluate(() => {
		const panel = document.querySelector('[data-watch-control="share-panel"]');
		const box = panel.getBoundingClientRect();
		const nav = document.getElementById("pi-markdown-preview-watch-nav").getBoundingClientRect();
		return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= nav.top
			&& [...panel.children].every(item => item.getBoundingClientRect().right <= box.right);
	}), "The share panel should remain above the multi-row toolbar and inside a narrow viewport.");
	await page.click('[data-watch-control="share-close"]');
	await page.focus("[data-code-wrap-all]");
	await page.keyboard.press("Space");
	assert.equal(await page.$eval('[data-code-wrap-all]', button => button.textContent), "Wrap: on");
	await clickBlock(3);
	assert.equal((await metrics()).globalState, "mixed");
	assert.equal(await page.$eval('[data-code-wrap-all]', button => button.textContent), "Wrap: mixed");
	await page.emulateMediaType("print");
	assert.equal(await page.$eval("#pi-markdown-preview-watch-nav", nav => getComputedStyle(nav).display), "none", "The integrated control stays out of printed output.");
	await page.emulateMediaType("screen");
	server.updateDocument(html.replace("<title>Markdown Preview</title>", "<title>Updated document</title>"));
	await page.waitForFunction(() => window.location.search === "?revision=2" && window.__mermaidDone === true);
	let value = await metrics();
	assert.equal(value.globalState, "true", "Watch revisions retain the tab's global choice, not its previous block exceptions.");
	assert.ok(value.blocks.every(block => block.override === null && block.whiteSpace === "pre-wrap"));
	await page.click("#pi-markdown-preview-watch-previous");
	await page.waitForFunction(() => window.location.search === "?revision=1" && window.__mermaidDone === true);
	assert.equal((await metrics()).globalState, "true", "Watch history uses the same tab-local global choice.");

	const anotherTab = await browser.newPage();
	await anotherTab.goto(server.url, { waitUntil: "domcontentloaded" });
	await anotherTab.waitForFunction(() => window.__mermaidDone === true);
	assert.equal(await anotherTab.$eval("[data-code-wrap-all]", button => button.getAttribute("aria-pressed")), "false", "A separate tab must not inherit a persistent global preference.");
	await anotherTab.close();
	const otherServer = await createBrowserWatchServer(html, scratch);
	servers.push(otherServer);
	await page.goto(otherServer.url, { waitUntil: "domcontentloaded" });
	await ready();
	assert.equal((await metrics()).globalState, "false", "Unrelated watchers must not inherit wrapping.");

	await page.evaluateOnNewDocument(() => {
		Storage.prototype.getItem = () => { throw new Error("Storage disabled"); };
		Storage.prototype.setItem = () => { throw new Error("Storage disabled"); };
	});
	await page.reload({ waitUntil: "domcontentloaded" });
	await ready();
	await page.click("[data-code-wrap-all]");
	assert.equal((await metrics()).globalState, "true", "Wrapping must still work with browser storage denied.");
	otherServer.updateDocument(preview.buildBrowserHtmlFromPandocFragment('<p>Only <code>inline code</code>.</p>', preview.getPreviewStyle()));
	await page.waitForFunction(() => window.location.search === "?revision=2" && window.__mermaidDone === true);
	assert.equal(await page.$$eval("[data-code-wrap-all]", buttons => buttons.length), 0, "A watch revision without code has no active global wrap control.");
	assert.ok(await page.$eval('[data-watch-control="wrap-code"]', button => button.hidden && getComputedStyle(button).display === "none"), "Unused watch-toolbar slots must stay hidden.");
	assert.deepEqual(pageErrors, []);

	const style = preview.getPreviewStyle();
	// Exercise border placement after different content and at the supported font
	// extremes, not just after a short heading in the default-size demo.
	const layoutPage = await browser.newPage();
	await layoutPage.setViewport({ width: 320, height: 1800, deviceScaleFactor: 1 });
	const layoutFragment = '<p>Paragraph before a code block, with enough text to wrap.</p><pre><code>first block</code></pre>'
		+ '<h3>A long heading that takes several lines at a narrow width</h3><pre><code>second block</code></pre>'
		+ '<pre><code>consecutive block</code></pre>'
		+ '<blockquote><p>Inside a quotation</p><pre><code>quoted block</code></pre></blockquote>'
		+ '<ul><li><p>Inside a list item</p><pre><code>listed block</code></pre></li></ul>';
	for (const fontSizePx of [10, 15, 24]) {
		await layoutPage.setContent(preview.buildBrowserHtmlFromPandocFragment(layoutFragment, style, undefined, [], fontSizePx), { waitUntil: "domcontentloaded" });
		await layoutPage.waitForFunction(() => window.__mermaidDone === true);
		await assertFloatingControls(layoutPage);
		await layoutPage.$eval("[data-code-wrap-all]", button => button.click());
		await assertFloatingControls(layoutPage);
	}
	await layoutPage.close();
	const cleanPage = await browser.newPage();
	const fragment = '<pre><code>' + "word ".repeat(100) + '</code></pre>';
	for (const wrapCode of [false, true]) {
		const screenshotHtml = preview.buildBrowserHtmlFromPandocFragment(fragment, style, undefined, [], 15, {}, false, { wrapCode, controls: false });
		await cleanPage.setContent(screenshotHtml, { waitUntil: "domcontentloaded" });
		await cleanPage.waitForFunction(() => window.__mermaidDone === true);
		assert.equal(await cleanPage.$$eval("button", buttons => buttons.length), 0, "Terminal/PNG render HTML must not create UI controls.");
		assert.equal(await cleanPage.$eval("pre", pre => getComputedStyle(pre).whiteSpace), wrapCode ? "pre-wrap" : "pre");
	}
	await cleanPage.setContent(preview.buildBrowserHtmlFromPandocFragment('<p>Only <code>inline code</code>.</p>', style), { waitUntil: "domcontentloaded" });
	await cleanPage.waitForFunction(() => window.__mermaidDone === true);
	assert.equal(await cleanPage.$$eval("[data-code-wrap-all]", buttons => buttons.length), 0, "Documents without code blocks must not gain a toolbar.");
	// Pure client fixture: Mermaid and its error output must never gain controls.
	await cleanPage.setContent('<article id="preview-root" data-wrap-code="false"><pre class="mermaid"><code>graph TD</code></pre><pre class="mermaid-error">Render failed</pre><pre><code>ordinary code</code></pre></article>');
	await cleanPage.addScriptTag({ content: readFileSync(resolve("client/code-wrap-controls.js"), "utf8") });
	await cleanPage.evaluate(() => window.PiMarkdownPreviewCodeWrap.installCodeWrapControls(document.getElementById("preview-root")));
	assert.equal(await cleanPage.$$eval("[data-code-wrap-block]", buttons => buttons.length), 1);

	const longMarkdown = "# Wrapping pagination\n\n```\n" + Array.from({ length: 24 }, (_, i) => `    line ${i} ` + "ABC123 ".repeat(80)).join("\n") + "\n```";
	const render = (wrapped) => preview.renderPreview(longMarkdown, style, undefined, undefined, undefined, false, 15, wrapped);
	const off = await render(false);
	const on = await render(true);
	assert.ok(on.pages.length > off.pages.length, "Wrapping should repaginate long code rather than clip its new height.");
	for (const result of [off, on]) for (const page of result.pages) {
		assert.equal(Buffer.from(page.base64Png, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "Cold screenshots must be valid base64 PNGs, including runtimes returning Uint8Array.");
	}
	assert.deepEqual(await render(false), off, "The no-wrap cache must not reuse wrapped images.");
	assert.deepEqual(await render(true), on, "The wrapped cache must agree with its cold render.");
	const cacheDir = join(scratch, "agent", "cache", "markdown-preview");
	const metaFiles = (await readdir(cacheDir)).filter(name => name.endsWith(".json"));
	const trailingPageMeta = await Promise.all(metaFiles.map(async name => ({ name, meta: JSON.parse(await readFile(join(cacheDir, name), "utf8")) })));
	const trailingPage = trailingPageMeta.find(({ meta }) => meta.pageCount === undefined);
	assert.ok(trailingPage);
	await rm(join(cacheDir, trailingPage.name.replace(/\.json$/, ".png")));
	assert.deepEqual(await render(true), on, "Incomplete cache recovery must preserve wrapping and pagination.");
	const pngPath = join(scratch, "exported.png");
	const pngResult = await exportTool.execute("wrap-png-test", {
		format: "png", source: "markdown", markdown: longMarkdown, outputPath: pngPath, fontSizePx: 15,
	}, undefined, undefined, { cwd: process.cwd(), ui: { theme: undefined } });
	assert.equal(pngResult.details.pageCount, off.pages.length, "Standalone PNG export must not inherit a viewer's wrapping state.");
	assert.deepEqual(await readFile(pngPath), Buffer.from(off.pages[0].base64Png, "base64"));

	initTheme("dark", false);
	const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
	const fakePreview = (count) => ({ themeMode: "dark", truncatedPages: false, pages: Array.from({ length: count }, (_, index) => ({ base64Png: pixel, truncatedHeight: false, index, total: count })) });
	const theme = { fg: (_key, text) => text, bold: text => text };
	let redraws = 0;
	let closes = 0;
	const tui = { requestRender() { redraws++; }, terminal: { write() {} } };
	const calls = [];
	const overlay = new preview.MarkdownPreviewOverlay(tui, theme, fakePreview(2), () => closes++, (wrapped, signal, skipCache) => new Promise((resolve, reject) => calls.push({ wrapped, signal, skipCache, resolve, reject })), async () => {});
	const tick = () => new Promise(resolve => setImmediate(resolve));
	assert.match(overlay.render(120).join("\n"), /w wrap code: off/);
	overlay.handleInput("\x1b[C");
	overlay.handleInput("w");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].wrapped, true);
	assert.equal(calls[0].skipCache, false);
	overlay.handleInput("w");
	overlay.handleInput("r");
	assert.equal(calls.length, 1, "Repeated keys must not start overlapping renders.");
	calls[0].resolve(fakePreview(1));
	await tick();
	assert.match(overlay.render(120).join("\n"), /w wrap code: on/);
	assert.match(overlay.render(120).join("\n"), /\(1\/1\)/, "Page selection must stay valid after repagination.");
	overlay.handleInput("r");
	assert.equal(calls[1].wrapped, true, "Refresh retains the current wrapping choice.");
	assert.equal(calls[1].skipCache, true, "Explicit refresh still bypasses cache.");
	calls[1].resolve(fakePreview(1));
	await tick();
	overlay.handleInput("w");
	assert.equal(calls[2].wrapped, false);
	calls[2].reject(new Error("test failure"));
	await tick();
	assert.match(overlay.render(120).join("\n"), /w wrap code: on/, "A failed toggle must leave the displayed setting and image unchanged.");
	assert.match(overlay.render(120).join("\n"), /test failure/);
	overlay.handleInput("w");
	assert.equal(calls[3].wrapped, false);
	calls[3].resolve(fakePreview(2));
	await tick();
	assert.match(overlay.render(120).join("\n"), /w wrap code: off/);
	overlay.handleInput("w");
	overlay.handleInput("\x1b");
	assert.equal(closes, 1);
	assert.equal(calls[4].signal.aborted, true, "Closing the viewer must cancel a pending render.");
	const beforeCompletion = redraws;
	calls[4].resolve(fakePreview(1));
	await tick();
	assert.equal(redraws, beforeCompletion, "Late render completion must not redraw a disposed viewer.");
	overlay.handleInput("w");
	assert.equal(calls.length, 5);
	overlay.dispose();
	const reopened = new preview.MarkdownPreviewOverlay(tui, theme, fakePreview(1), () => {}, async () => fakePreview(1), async () => {});
	assert.match(reopened.render(120).join("\n"), /w wrap code: off/, "Reopening a terminal preview must not inherit the last viewer's choice.");
	reopened.dispose();
	console.log("Code wrapping/copy controls, watch state, terminal lifecycle, and cache checks passed.");
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await browser?.close();
	await Promise.all(servers.map(server => server.close()));
	await preview?.closeSharedPreviewBrowser();
	await rm(modulePath, { force: true });
	await rm(scratch, { recursive: true, force: true });
}
