import assert from "node:assert/strict";
import { createBrowserWatchServer } from "../shared/browser-watch-server.js";

/** Open only when needed; one-shot previews have no disclosure. */
export async function openWatchControls(page) {
	const toggle = await page.$('[data-watch-control="toggle"]');
	if (toggle && await toggle.evaluate(button => button.getAttribute("aria-expanded") === "false")) await toggle.click();
}

export async function assertWatchControls({ browser, html, resourceRoot, buildHtml }) {
	const servers = [];
	const page = await browser.newPage();
	const errors = [];
	page.on("pageerror", error => errors.push(String(error)));
	await page.evaluateOnNewDocument(() => {
		window.__shareTest = { mode: "success", copies: [], legacy: 0 };
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => {
			window.__shareTest.copies.push(value);
			if (window.__shareTest.mode === "pending") return new Promise((resolve, reject) => { window.__shareTest.finish = resolve; window.__shareTest.fail = reject; });
			if (window.__shareTest.mode !== "success") throw new Error("Clipboard denied");
		} } });
		document.execCommand = () => {
			window.__shareTest.legacy += 1;
			if (window.__shareTest.mode === "throw") throw new Error("Legacy unavailable");
			return window.__shareTest.mode === "legacy";
		};
	});
	const select = name => `[data-watch-control="${name}"]`;
	const hidden = name => page.$eval(select(name), element => element.hidden);
	const ready = () => page.waitForFunction(() => window.__mermaidDone === true);
	const focusRings = target => target.$$eval('#pi-markdown-preview-watch-nav a, #pi-markdown-preview-watch-nav button', controls => controls
		.filter(control => control.matches(':focus-visible') && getComputedStyle(control).outlineStyle !== 'none' && parseFloat(getComputedStyle(control).outlineWidth) > 0)
		.map(control => control.getAttribute('data-watch-control')));
	const geometry = () => page.evaluate(() => {
		const box = element => {
			const { x, y, width, height } = element.getBoundingClientRect();
			return { x, y, width, height };
		};
		return { root: box(document.getElementById("preview-root")), toolbar: box(document.getElementById("pi-markdown-preview-watch-nav")), height: document.documentElement.scrollHeight };
	});
	async function create(html, options = {}) {
		const server = await createBrowserWatchServer(html, resourceRoot, options);
		servers.push(server);
		return server;
	}
	try {
		const server = await create(html, { sourceLabel: 'A very long source path — ' + 'folder/'.repeat(20) + 'document.md', historyLimit: 3 });
		server.updateDocument(html);
		server.updateDocument(html);
		for (const width of [1200, 700, 600, 320]) {
			await page.setViewport({ width, height: 800 });
			await page.goto(server.url, { waitUntil: "domcontentloaded" });
			await ready();
			assert.equal(await hidden("controls"), true);
			assert.equal(await page.$eval(select("toggle"), button => button.getAttribute("aria-expanded")), "false");
			assert.equal(await page.$eval(select("count"), element => element.textContent), "3/3");
			assert.equal(await page.$eval(select("toggle"), button => button.getAttribute("aria-label")), "Preview controls, revision 3 of 3");
			const before = await geometry();
			assert.ok(before.toolbar.width < Math.min(320, width), "The collapsed bar must not depend on source-label length.");
			await page.focus(select("copy-link"));
			await page.keyboard.press("Tab");
			assert.ok(await page.$eval(select("toggle"), button => button === document.activeElement));
			await page.keyboard.press("Enter");
			assert.equal(await hidden("controls"), false, "Native Enter should open the disclosure.");
			assert.equal(await page.$eval(select("toggle"), button => button.getAttribute("aria-expanded")), "true");
			assert.deepEqual(await geometry(), before, "Opening controls must not shift the document or the compact bar.");
			assert.ok(await page.$eval(select("controls"), panel => {
				const box = panel.getBoundingClientRect();
				return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
			}), "Open controls must fit the viewport.");
			await page.keyboard.press("Tab");
			assert.equal(await page.evaluate(() => document.activeElement.getAttribute("data-watch-control")), "previous", "Tab should reach enabled links, not disabled history entries.");
			await page.keyboard.press("Escape");
			assert.equal(await hidden("controls"), true);
			assert.ok(await page.$eval(select("toggle"), button => button === document.activeElement), "Escape should return focus to the disclosure button.");
			await page.keyboard.press("Space");
			assert.equal(await hidden("controls"), false);
			await page.mouse.click(width / 2, 400);
			assert.equal(await hidden("controls"), true, "Outside clicks should close without hijacking focus.");
			assert.deepEqual(await geometry(), before);
			await openWatchControls(page);
			await page.evaluate(() => {
				const link = document.createElement("a"); link.id = "outside-focus"; link.href = "#"; link.textContent = "Outside";
				document.getElementById("preview-root").append(link); link.focus({ preventScroll: true });
			});
			await page.waitForFunction(() => document.querySelector('[data-watch-control="controls"]').hidden);
			assert.equal(await page.evaluate(() => document.activeElement.id), "outside-focus", "Leaving with the keyboard must not trap focus.");
			await page.$eval("#outside-focus", element => element.remove());
		}

		// Revision buttons replace the document, but must leave the panel open
		// for repeated navigation. Restore keyboard focus without scrolling it.
		await page.setViewport({ width: 1200, height: 800 });
		await page.goto(server.url, { waitUntil: "domcontentloaded" });
		await ready();
		await openWatchControls(page);
		await page.focus(select("previous"));
		for (const revision of [2, 1]) {
			await page.keyboard.press("Enter");
			await page.waitForFunction(revision => location.search === `?revision=${revision}` && window.__mermaidDone, {}, revision);
			assert.equal(await hidden("controls"), false, "Repeated keyboard navigation must not require reopening the panel.");
			assert.equal(await page.evaluate(() => document.activeElement.getAttribute("data-watch-control")), revision === 1 ? "toggle" : "previous");
			assert.deepEqual(await focusRings(page), [revision === 1 ? "toggle" : "previous"], "Keyboard navigation must keep a visible focus ring, including at a boundary.");
		}
		for (const [action, revision] of [["next", 2], ["next", 3], ["previous", 2], ["latest", 3]]) {
			await page.click(select(action));
			await page.waitForFunction(revision => location.search === `?revision=${revision}` && window.__mermaidDone, {}, revision);
			assert.equal(await hidden("controls"), false, `${action} should leave the panel open, including at history boundaries.`);
			assert.equal(await page.$eval(select("toggle"), button => button.getAttribute("aria-expanded")), "true");
			assert.equal(await page.evaluate(() => document.activeElement.getAttribute("data-watch-control")), revision === 3 ? "toggle" : action, "Mouse navigation should retain the tab-order starting point without adding a ring.");
			assert.deepEqual(await focusRings(page), [], "A mouse click must not acquire a keyboard-looking outline after the document reloads.");
		}
		await page.click(select("previous"));
		await page.waitForFunction(() => location.search === "?revision=2" && window.__mermaidDone);
		await page.keyboard.press("Tab");
		assert.equal(await page.evaluate(() => document.activeElement.getAttribute("data-watch-control")), "next", "Switching from mouse to keyboard should continue from the restored control, not restart at the document's first link.");
		assert.deepEqual(await focusRings(page), ["next"]);
		await page.keyboard.press("Enter");
		await page.waitForFunction(() => location.search === "?revision=3" && window.__mermaidDone);
		assert.deepEqual(await focusRings(page), ["toggle"]);
		await page.click(select("previous"));
		await page.waitForFunction(() => location.search === "?revision=2" && window.__mermaidDone);
		assert.deepEqual(await focusRings(page), []);
		await page.keyboard.down("Alt"); await page.keyboard.press("ArrowRight"); await page.keyboard.up("Alt");
		await page.waitForFunction(() => location.search === "?revision=3" && window.__mermaidDone);
		assert.deepEqual(await focusRings(page), ["toggle"], "Alt navigation should retain visible keyboard focus too.");
		await page.click(select("wrap-code"));
		assert.equal(await hidden("controls"), false, "Changing wrapping should leave the panel open too.");
		await page.click(select("wrap-code"));
		await page.mouse.click(400, 400);
		assert.equal(await hidden("controls"), true);
		await page.reload({ waitUntil: "domcontentloaded" });
		await ready();
		assert.equal(await hidden("controls"), true, "Explicit dismissal must survive the next load.");

		// Copy is visible without opening anything; all writes are intercepted.
		await page.setViewport({ width: 1200, height: 800 });
		await page.goto(server.url, { waitUntil: "domcontentloaded" });
		await ready();
		const copyGeometry = await geometry();
		await page.focus(select("copy-link"));
		await page.keyboard.press("Enter");
		await page.waitForFunction(() => document.querySelector('[data-watch-control="copy-link"]').textContent === "Copied");
		assert.equal(await hidden("controls"), true);
		assert.ok(await page.$eval(select("copy-link"), button => button === document.activeElement && !button.disabled));
		assert.deepEqual(await geometry(), copyGeometry, "Copy feedback must not resize the collapsed bar.");
		assert.equal(await page.evaluate(() => window.__shareTest.legacy), 0);
		const copied = await page.evaluate(() => window.__shareTest.copies[0]);
		assert.equal(new URL(copied).searchParams.get("revision"), "3");
		assert.equal((await fetch(copied)).status, 200, "Copy must still create a transferable authenticated link.");

		for (const mode of ["legacy", "denied", "throw"]) {
			await page.evaluate(mode => { window.__shareTest.mode = mode; }, mode);
			await openWatchControls(page);
			await page.click(select("copy-link"));
			assert.equal(await hidden("controls"), true, "Sharing and history panels must not overlap.");
			if (mode === "legacy") {
				await page.waitForFunction(() => document.querySelector('[data-watch-control="copy-link"]').textContent === "Copied");
				assert.ok(await page.$eval(select("copy-link"), button => button === document.activeElement));
				continue;
			}
			await page.waitForFunction(() => !document.querySelector('[data-watch-control="share-panel"]').hidden);
			assert.ok(await page.$eval(select("share-input"), input => input === document.activeElement && input.selectionStart === 0 && input.selectionEnd === input.value.length));
			assert.deepEqual(await geometry(), copyGeometry, "Manual-copy fallback is an overlay, not a document row.");
			assert.equal(await page.$$eval("body > textarea", elements => elements.length), 0, "Legacy failures must clean up temporary textareas.");
			await page.keyboard.press("Escape");
			assert.equal(await hidden("share-panel"), true);
			assert.equal(await page.$eval(select("share-input"), input => input.value), "");
			assert.ok(await page.$eval(select("copy-link"), button => button === document.activeElement), "Escape returns to the still-visible Copy link button.");
		}
		await page.evaluate(() => { window.__shareTest.mode = "pending"; });
		await page.click(select("copy-link"));
		await page.waitForFunction(() => typeof window.__shareTest.fail === "function");
		const count = await page.evaluate(() => window.__shareTest.copies.length);
		await page.click(select("copy-link"));
		assert.equal(await page.evaluate(() => window.__shareTest.copies.length), count, "Suppress duplicate pending copy requests without disabling keyboard focus.");
		await page.mouse.click(400, 400);
		await page.evaluate(() => window.__shareTest.fail(new Error("User moved on")));
		await page.waitForFunction(() => !document.querySelector('[data-watch-control="copy-link"]').hasAttribute("aria-busy"));
		assert.equal(await hidden("share-panel"), true, "A late clipboard failure must not reopen a dismissed panel or steal focus.");

		// Hidden navigation remains available via its existing keyboard shortcuts.
		await page.keyboard.down("Alt"); await page.keyboard.press("ArrowLeft"); await page.keyboard.up("Alt");
		await page.waitForFunction(() => location.search === "?revision=2" && window.__mermaidDone);
		assert.equal(await hidden("controls"), true);
		server.updateDocument(html);
		await page.waitForFunction(() => !document.querySelector('[data-watch-control="new"]').hidden);
		assert.match(await page.$eval(select("toggle"), button => button.getAttribute("aria-label")), /new revision available/);
		assert.equal(await hidden("controls"), true, "New-version notifications should not open a panel automatically.");
		server.updateDocument(html);
		await page.waitForFunction(() => document.querySelector('[data-watch-control="count"]').textContent === "Expired");
		assert.match(await page.$eval(select("toggle"), button => button.getAttribute("aria-label")), /no longer retained/);
		await openWatchControls(page);
		await page.click(select("latest"));
		await page.waitForFunction(() => location.search === "?revision=5" && window.__mermaidDone);
		assert.equal(await hidden("new"), true);
		assert.equal(await hidden("controls"), false);
		server.updateDocument(html);
		await page.waitForFunction(() => location.search === "?revision=6" && window.__mermaidDone);
		assert.equal(await hidden("controls"), false, "An automatic update should preserve an already-open panel.");
		assert.deepEqual(await focusRings(page), [], "Automatic updates must not turn restored pointer focus into keyboard focus.");
		await page.reload({ waitUntil: "domcontentloaded" });
		await ready();
		assert.equal(await hidden("controls"), false, "Reloading should keep the current panel state too.");
		assert.deepEqual(await focusRings(page), [], "Pointer focus stays quiet through repeated reloads.");
		await page.keyboard.press("Tab");
		assert.deepEqual(await focusRings(page), ["previous"]);
		await page.reload({ waitUntil: "domcontentloaded" });
		await ready();
		assert.deepEqual(await focusRings(page), ["previous"], "Reload must preserve genuine keyboard focus visibility.");
		const isolated = await browser.newPage();
		try {
			await isolated.goto(server.url, { waitUntil: "domcontentloaded" });
			await isolated.waitForFunction(() => window.__mermaidDone);
			assert.equal(await isolated.$eval(select("controls"), panel => panel.hidden), true, "A fresh tab should not inherit the open panel.");
		} finally { await isolated.close(); }
		await page.emulateMediaType("print");
		assert.equal(await page.$eval("#pi-markdown-preview-watch-nav", element => getComputedStyle(element).display), "none");
		await page.emulateMediaType("screen");
		await page.keyboard.press("Escape");
		assert.equal(await hidden("controls"), true);
		await page.reload({ waitUntil: "domcontentloaded" });
		await ready();
		assert.equal(await hidden("controls"), true, "Escape must clear the open state, not just hide this document's panel.");
		await openWatchControls(page);
		const otherWatcher = await create(html);
		await page.goto(otherWatcher.url, { waitUntil: "domcontentloaded" });
		await ready();
		assert.equal(await hidden("controls"), true, "Another watcher in the same tab must start closed.");

		// Small coarse-pointer layouts retain labelled, >=44px touch targets.
		const touch = await browser.newPage();
		try {
			await touch.setViewport({ width: 320, height: 700, isMobile: false, hasTouch: true });
			await touch.goto(server.url, { waitUntil: "domcontentloaded" });
			await touch.waitForFunction(() => window.__mermaidDone);
			assert.ok(await touch.$$eval('#pi-markdown-preview-watch-nav > button', buttons => buttons.every(button => button.getBoundingClientRect().height >= 44)));
			await touch.tap(select("toggle"));
			assert.equal(await touch.$eval(select("controls"), element => element.hidden), false);
			for (const revision of [5, 4]) {
				await touch.tap(select("previous"));
				await touch.waitForFunction(revision => location.search === `?revision=${revision}` && window.__mermaidDone, {}, revision);
				assert.equal(await touch.$eval(select("controls"), element => element.hidden), false, "Touch navigation must also keep the panel open.");
				assert.deepEqual(await focusRings(touch), [], "Touch navigation must not introduce a keyboard focus ring.");
			}
			await touch.touchscreen.tap(160, 200);
			assert.equal(await touch.$eval(select("controls"), element => element.hidden), true);
			await touch.setViewport({ width: 320, height: 200, isMobile: false, hasTouch: true });
			await touch.tap(select("toggle"));
			await touch.focus(select("wrap-code"));
			assert.ok(await touch.$eval(select("controls"), panel => {
				const box = panel.getBoundingClientRect();
				const focused = document.activeElement.getBoundingClientRect();
				return box.top >= 0 && box.bottom <= innerHeight && panel.scrollTop > 0
					&& focused.top >= box.top && focused.bottom <= box.bottom && window.scrollY === 0;
			}), "Short viewports must scroll the panel to its focused control, not move the document.");
		} finally { await touch.close(); }

		const denied = await browser.newPage();
		denied.on("pageerror", error => errors.push(String(error)));
		try {
			await denied.evaluateOnNewDocument(() => {
				for (const method of ["getItem", "setItem", "removeItem"]) Storage.prototype[method] = () => { throw new Error("Storage disabled"); };
			});
			await denied.goto(server.url, { waitUntil: "domcontentloaded" });
			await denied.waitForFunction(() => window.__mermaidDone);
			await openWatchControls(denied);
			await denied.click(select("previous"));
			await denied.waitForFunction(() => location.search === "?revision=5" && window.__mermaidDone);
			await openWatchControls(denied);
			await denied.click(select("next"));
			await denied.waitForFunction(() => location.search === "?revision=6" && window.__mermaidDone);
		} finally { await denied.close(); }

		const headingHtml = buildHtml('<h1>First heading</h1><p>Prose</p><h2>Later heading</h2><p>More prose</p>');
		await page.setContent(headingHtml);
		await ready();
		const ordinaryMargin = await page.$eval("h1", h => parseFloat(getComputedStyle(h).marginTop));
		assert.ok(ordinaryMargin > 0);
		const headings = await create(headingHtml);
		await page.goto(headings.url, { waitUntil: "domcontentloaded" });
		await ready();
		assert.equal(await page.$eval("h1", h => parseFloat(getComputedStyle(h).marginTop)), 0);
		assert.ok(await page.$eval("h2", h => parseFloat(getComputedStyle(h).marginTop)) > 0, "Later heading spacing stays unchanged.");
		assert.equal(await page.$eval(select("wrap-code"), button => button.hidden), true, "Do not show wrapping for documents with no code.");
		await page.emulateMediaType("print");
		assert.equal(await page.$eval("h1", h => parseFloat(getComputedStyle(h).marginTop)), ordinaryMargin, "Watch title spacing must not alter printed output.");
		await page.emulateMediaType("screen");
		const waiting = await create(buildHtml('<p>Waiting for a response.</p>'), { initialDocumentIsHistory: false });
		await page.goto(waiting.url, { waitUntil: "domcontentloaded" });
		await ready();
		assert.equal(await page.$eval(select("count"), element => element.textContent), "Waiting");
		assert.match(await page.$eval(select("toggle"), button => button.getAttribute("aria-label")), /waiting for a response/);
		assert.deepEqual(errors, []);
		console.log("Compact watch controls, sharing, keyboard/touch, and title spacing checks passed.");
	} finally {
		await page.close();
		await Promise.all(servers.map(server => server.close()));
	}
}
