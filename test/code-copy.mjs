import assert from "node:assert/strict";

// Exercise the browser's click/focus/selection paths, but intercept clipboard
// writes so the regression suite never reads or changes the user's clipboard.
export async function assertCodeCopy({ browser, fileUrl, watchUrl, expectedText, assertFloatingControls }) {
	const page = await browser.newPage();
	const errors = [];
	page.on("pageerror", error => errors.push(String(error)));
	await page.evaluateOnNewDocument(() => {
		const state = window.__copyTest = { mode: "modern", modern: [], legacy: [] };
		state.clipboard = {
			writeText: async text => {
				state.modern.push(text);
				if (state.mode === "pending") return new Promise(resolve => { state.finish = resolve; });
				if (state.mode !== "modern") throw new Error("Clipboard denied");
			},
		};
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: state.clipboard });
		document.execCommand = command => {
			if (command !== "copy") throw new Error("Unexpected clipboard command");
			const record = {
				buffer: document.querySelector(".preview-code-copy-buffer")?.textContent,
				selection: window.getSelection().toString(),
				focus: document.activeElement?.getAttribute("data-code-copy-block"),
			};
			state.legacy.push(record);
			if (state.mode === "throw") throw new Error("Legacy clipboard unavailable");
			const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
			document.dispatchEvent(event);
			record.plain = event.clipboardData.getData("text/plain");
			record.types = [...event.clipboardData.types];
			record.prevented = event.defaultPrevented;
			return state.mode !== "failed";
		};
	});
	const buttonSelector = index => `[data-code-copy-block="${index}"]`;
	const feedback = async (index, label) => page.waitForFunction((selector, label) => {
		const button = document.querySelector(selector);
		return button.textContent === label && !button.hasAttribute("aria-busy");
	}, {}, buttonSelector(index), label);
	const clickCopy = async (index, label = "Copied") => {
		await page.hover(`.preview-code-block:has(${buttonSelector(index)}) > pre`);
		await page.click(buttonSelector(index));
		if (label) await feedback(index, label);
	};
	const copiedTexts = () => page.evaluate(() => window.__copyTest.modern);
	const geometry = () => page.$$eval("#preview-root, #preview-root pre, [data-code-copy-block]", elements => elements.map(element => {
		const { x, y, width, height } = element.getBoundingClientRect();
		return { x, y, width, height };
	}));
	try {
		for (const url of [fileUrl, watchUrl]) {
			await page.setViewport({ width: 600, height: 1800, deviceScaleFactor: 1 });
			await page.goto(url, { waitUntil: "domcontentloaded" });
			await page.waitForFunction(() => window.__mermaidDone === true);
			assert.equal(await page.$$eval("[data-code-copy-block]", buttons => buttons.length), expectedText.length);
			assert.equal(await page.$eval(buttonSelector(0), button => button.getAttribute("aria-label")), "Copy code block 1");
			const unwrappedGeometry = await geometry();
			for (let index = 0; index < expectedText.length; index++) await clickCopy(index);
			assert.deepEqual(await copiedTexts(), expectedText, "Plain, highlighted, diff, and diagram blocks must copy text only, without controls.");
			assert.deepEqual(await geometry(), unwrappedGeometry, "Copy -> Copied must not move buttons or document content.");
			await page.click("[data-code-wrap-all]");
			const wrappedGeometry = await geometry();
			for (let index = 0; index < expectedText.length; index++) await clickCopy(index);
			assert.deepEqual(await copiedTexts(), [...expectedText, ...expectedText], "Visual wrapping must never add clipboard line breaks.");
			assert.deepEqual(await geometry(), wrappedGeometry);
			assert.equal(await page.$eval("[data-code-wrap-all]", button => button.getAttribute("aria-pressed")), "true", "Copying must not change wrapping.");
			await assertFloatingControls(page);
			await page.mouse.move(0, 0);
			assert.equal(await page.$eval(buttonSelector(3), button => getComputedStyle(button.parentElement).opacity), "0", "Pointer-copy feedback must not keep controls visible after mouseleave.");
			assert.equal(await page.$$eval(".preview-code-copy-buffer", buffers => buffers.length), 0);
			assert.equal(await page.evaluate(() => window.__copyTest.legacy.length), 0, "Successful Clipboard API writes must not also run a legacy copy.");

			// Native tab order: global -> Wrap -> Copy. Keep keyboard focus while
			// copying and reset feedback without changing the button's width.
			await page.focus('[data-code-wrap-block="0"]');
			await page.keyboard.press("Tab");
			assert.ok(await page.$eval(buttonSelector(0), button => button === document.activeElement && button.matches(":focus-visible")));
			await page.keyboard.press("Enter");
			await feedback(0, "Copied");
			assert.equal((await copiedTexts()).at(-1), expectedText[0]);
			assert.equal(await page.$eval(buttonSelector(0), button => getComputedStyle(button.parentElement).opacity), "1");
			assert.equal(await page.$eval('.preview-code-block:has([data-code-copy-block="0"]) [role="status"]', status => status.textContent), "Copied code block 1.");
			await feedback(0, "Copy");
			assert.deepEqual(await geometry(), wrappedGeometry);
			assert.equal(await page.$eval('.preview-code-block:has([data-code-copy-block="0"]) [role="status"]', status => status.textContent), "");

			// Guard repeat activation while an asynchronous clipboard write is pending.
			const beforePending = (await copiedTexts()).length;
			await page.evaluate(() => { window.__copyTest.mode = "pending"; });
			await clickCopy(1, null);
			assert.equal(await page.$eval(buttonSelector(1), button => button.getAttribute("aria-busy")), "true");
			await page.$eval(buttonSelector(1), button => { button.click(); button.click(); });
			assert.equal((await copiedTexts()).length, beforePending + 1);
			await page.evaluate(() => window.__copyTest.finish());
			await feedback(1, "Copied");
			assert.equal(await page.$eval(buttonSelector(1), button => button.hasAttribute("aria-disabled")), false);

			// Both absence and denial of the modern API exercise the same fallback.
			for (const mode of ["absent", "fallback", "failed", "throw"]) {
				await page.evaluate(mode => {
					window.__copyTest.mode = mode;
					Object.defineProperty(navigator, "clipboard", { configurable: true, value: mode === "absent" ? undefined : window.__copyTest.clipboard });
					// Set a selection immediately before the production click handler,
					// avoiding platform differences in what mousedown itself selects.
					document.querySelector('[data-code-copy-block="2"]').addEventListener("click", () => {
						const range = document.createRange();
						range.setStart(document.querySelector("#preview-root p").firstChild, 0);
						range.setEnd(document.querySelector("#preview-root p").firstChild, 10);
						const selection = window.getSelection();
						selection.removeAllRanges();
						selection.addRange(range);
					}, { capture: true, once: true });
				}, mode);
				const succeeded = mode === "absent" || mode === "fallback";
				await clickCopy(2, succeeded ? "Copied" : "Failed");
				const result = await page.evaluate(() => {
					const selection = window.getSelection();
					const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
					document.dispatchEvent(event);
					return {
						legacy: window.__copyTest.legacy.at(-1),
						selection: selection.toString(),
						start: selection.anchorOffset,
						end: selection.focusOffset,
						focus: document.activeElement?.getAttribute("data-code-copy-block"),
						buffers: document.querySelectorAll(".preview-code-copy-buffer").length,
						leakedListener: event.defaultPrevented,
					};
				});
				assert.equal(result.legacy.buffer, expectedText[2]);
				assert.equal(result.legacy.selection, expectedText[2]);
				if (mode !== "throw") {
					assert.equal(result.legacy.plain, expectedText[2]);
					assert.deepEqual(result.legacy.types, ["text/plain"]);
					assert.equal(result.legacy.prevented, true);
				}
				assert.equal(result.selection, "Prose with");
				assert.equal(result.start, 0);
				assert.equal(result.end, 10);
				assert.equal(result.focus, "2");
				assert.equal(result.buffers, 0);
				assert.equal(result.leakedListener, false, "Fallback copy listeners must be removed, including when copying fails.");
				if (!succeeded) {
					assert.match(await page.$eval(buttonSelector(2), button => button.title), /Select the code and copy it manually/);
					assert.match(await page.$eval('.preview-code-block:has([data-code-copy-block="2"]) [role="status"]', status => status.textContent), /Could not copy code block 3/);
				}
				await page.mouse.move(0, 0);
				assert.equal(await page.$eval(buttonSelector(2), button => getComputedStyle(button.parentElement).opacity), "0", "Legacy copying must not introduce sticky focus.");
				assert.deepEqual(await geometry(), wrappedGeometry, "Success/failure labels must not move the controls or content.");
			}
			await feedback(2, "Copy");
			await page.evaluate(() => { window.__copyTest.mode = "modern"; });
			await clickCopy(2);
			assert.equal((await copiedTexts()).at(-1), expectedText[2], "Clipboard failure must not prevent a later retry.");

			const specialText = "\tindent <tag> & 'quotes'\n\nλ → 漢字\ntrailing spaces  \n";
			await page.$eval("#preview-root pre > code", (code, text) => { code.textContent = text; }, specialText);
			await clickCopy(0);
			assert.equal((await copiedTexts()).at(-1), specialText, "Copy must not trim whitespace, expand tabs, escape characters, or drop the final newline.");
			await page.$eval("#preview-root pre > code", code => {
				const marker = document.createElement("span");
				marker.className = "annotation-marker";
				marker.title = "[an: $\\alpha$]";
				marker.innerHTML = "<span>typeset alpha</span><span>assistive math text</span>";
				code.replaceChildren("+ value = 1; // ", marker, "\n");
			});
			await clickCopy(0);
			assert.equal((await copiedTexts()).at(-1), "+ value = 1; // [an: $\\alpha$]\n", "Copy must retain original diff-annotation markers, not rendered math or duplicate assistive text.");
			assert.equal(await page.$eval("#preview-root pre > code .annotation-marker", marker => marker.textContent), "typeset alphaassistive math text", "Copying must leave the displayed annotation untouched.");
			await page.evaluate(() => window.PiMarkdownPreviewCodeWrap.installCodeWrapControls(document.getElementById("preview-root")));
			assert.equal(await page.$$eval("[data-code-copy-block]", buttons => buttons.length), expectedText.length, "Re-installing controls must not duplicate Copy buttons.");
		}

		await page.setViewport({ width: 320, height: 900, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
		await page.goto(fileUrl, { waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => window.__mermaidDone === true);
		await page.tap(buttonSelector(0));
		await feedback(0, "Copied");
		assert.deepEqual(await copiedTexts(), [expectedText[0]], "Touch copy should work with one tap.");
		assert.equal(await page.$eval(buttonSelector(0), button => getComputedStyle(button.parentElement).opacity), "1");
		await assertFloatingControls(page);
		assert.deepEqual(errors, []);
		console.log("Code copy clipboard, fallback, feedback, focus, and touch checks passed.");
	} finally {
		await page.close();
	}
}
