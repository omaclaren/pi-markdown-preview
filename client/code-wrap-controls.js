(function installPiMarkdownPreviewCodeWrap(globalObject) {
	"use strict";

	function getCodeText(pre) {
		const code = pre.querySelector(":scope > code");
		if (!code.querySelector(".annotation-marker[title]")) return code.textContent ?? "";
		// Diff annotations may contain rendered math. Their titles retain the
		// original marker; copy that rather than MathJax's presentation/accessibility text.
		const original = code.cloneNode(true);
		original.querySelectorAll(".annotation-marker[title]").forEach(marker => marker.replaceWith(marker.title));
		return original.textContent ?? "";
	}

	async function copyCodeText(text) {
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(text);
				return true;
			}
		} catch {
			// File previews or denied Clipboard API access may still allow a
			// user-initiated legacy copy. Never report success if both fail.
		}

		const selection = window.getSelection();
		if (!selection) return false;
		const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange());
		const activeElement = document.activeElement;
		const buffer = document.createElement("pre");
		buffer.className = "preview-code-copy-buffer";
		buffer.setAttribute("aria-hidden", "true");
		buffer.textContent = text;
		const onCopy = (event) => {
			if (!event.clipboardData) return;
			event.clipboardData.setData("text/plain", text);
			event.preventDefault();
		};
		try {
			// A non-editable selection avoids focusing a hidden textarea and
			// accidentally turning pointer focus into sticky keyboard focus.
			document.body.appendChild(buffer);
			const range = document.createRange();
			range.selectNodeContents(buffer);
			selection.removeAllRanges();
			selection.addRange(range);
			document.addEventListener("copy", onCopy, true);
			return document.execCommand("copy");
		} catch {
			return false;
		} finally {
			document.removeEventListener("copy", onCopy, true);
			buffer.remove();
			selection.removeAllRanges();
			for (const range of ranges) selection.addRange(range);
			if (activeElement?.isConnected && document.activeElement !== activeElement) activeElement.focus({ preventScroll: true });
		}
	}

	function installCodeWrapControls(root) {
		if (!root || root.dataset.codeWrapControls === "ready") return;
		// Mermaid source is replaced before this runs. Do not decorate its fallback
		// errors, inline code, or other non-code preformatted document content.
		const blocks = Array.from(root.querySelectorAll("pre")).filter((pre) => (
			pre.querySelector(":scope > code") && !pre.classList.contains("mermaid")
		));
		if (blocks.length === 0) return;
		root.dataset.codeWrapControls = "ready";

		// Only watch pages retain the global choice across navigations. The scope
		// is an independent, non-secret server ID, never an authentication token.
		// sessionStorage keeps this tab-local; one-shot documents start afresh.
		const scope = document.head.querySelector('meta[name="pi-markdown-preview-wrap-scope"]')?.content;
		const storageKey = scope ? "pi-markdown-preview:wrap-code:" + scope : null;
		if (storageKey) {
			try {
				const stored = sessionStorage.getItem(storageKey);
				if (stored === "true" || stored === "false") root.dataset.wrapCode = stored;
			} catch {
				// Disabled browser storage must not disable the controls themselves.
			}
		}

		// Watch pages provide a slot in their existing navigation bar. One-shot
		// documents keep a compact standalone control above the document.
		const watchButton = document.querySelector('body > #pi-markdown-preview-watch-nav [data-watch-control="wrap-code"]');
		const globalButton = watchButton ?? document.createElement("button");
		globalButton.type = "button";
		globalButton.dataset.codeWrapAll = "";
		globalButton.setAttribute("aria-label", "Wrap all code");
		globalButton.hidden = false;
		if (!watchButton) {
			const toolbar = document.createElement("div");
			toolbar.className = "preview-code-toolbar";
			toolbar.appendChild(globalButton);
			root.prepend(toolbar);
		}

		const isWrapped = (pre) => (pre.dataset.wrapCode ?? root.dataset.wrapCode) === "true";
		const blockButtons = [];
		const updateButtons = () => {
			const count = blocks.filter(isWrapped).length;
			const state = count === 0 ? "false" : count === blocks.length ? "true" : "mixed";
			globalButton.setAttribute("aria-pressed", state);
			globalButton.textContent = (watchButton ? "Wrap: " : "Wrap all code: ") + (state === "mixed" ? "mixed" : state === "true" ? "on" : "off");
			globalButton.title = (state === "true" ? "Unwrap" : "Wrap") + " every code block (resets individual choices)";
			blockButtons.forEach((button, index) => {
				const action = isWrapped(blocks[index]) ? "Unwrap" : "Wrap";
				button.textContent = action;
				button.setAttribute("aria-label", action + " code block " + (index + 1));
				button.title = action + " this code block";
			});
		};

		blocks.forEach((pre, index) => {
			const wrapper = document.createElement("div");
			wrapper.className = "preview-code-block";
			const controls = document.createElement("div");
			controls.className = "preview-code-block-controls";
			const button = document.createElement("button");
			button.type = "button";
			button.dataset.codeWrapBlock = String(index);
			controls.appendChild(button);
			pre.before(wrapper);
			wrapper.append(controls, pre);
			blockButtons.push(button);
			button.addEventListener("click", () => {
				pre.dataset.wrapCode = String(!isWrapped(pre));
				updateButtons();
			});

			const copyButton = document.createElement("button");
			copyButton.type = "button";
			copyButton.dataset.codeCopyBlock = String(index);
			copyButton.textContent = "Copy";
			copyButton.title = "Copy this code block";
			copyButton.setAttribute("aria-label", "Copy code block " + (index + 1));
			const copyStatus = document.createElement("span");
			copyStatus.className = "preview-code-copy-status";
			copyStatus.setAttribute("role", "status");
			controls.append(copyButton, copyStatus);
			let copying = false;
			let feedbackTimer;
			copyButton.addEventListener("click", async () => {
				if (copying) return;
				copying = true;
				clearTimeout(feedbackTimer);
				copyButton.textContent = "Copy";
				copyStatus.textContent = "";
				// aria-disabled guards repeat activation without dropping focus.
				copyButton.setAttribute("aria-disabled", "true");
				copyButton.setAttribute("aria-busy", "true");
				let copied = false;
				try {
					// textContent preserves logical lines/indentation regardless of
					// CSS wrapping; controls are outside the code and cannot leak in.
					copied = await copyCodeText(getCodeText(pre));
				} catch {
					// Clipboard/fallback failures should leave the viewer usable.
				} finally {
					copying = false;
					copyButton.removeAttribute("aria-disabled");
					copyButton.removeAttribute("aria-busy");
				}
				if (!copyButton.isConnected) return;
				copyButton.textContent = copied ? "Copied" : "Failed";
				copyButton.title = copied ? "Code copied" : "Could not copy. Select the code and copy it manually.";
				copyStatus.textContent = copied ? "Copied code block " + (index + 1) + "." : "Could not copy code block " + (index + 1) + ". Select the code and copy it manually.";
				feedbackTimer = setTimeout(() => {
					copyButton.textContent = "Copy";
					copyButton.title = "Copy this code block";
					copyStatus.textContent = "";
				}, 1800);
			});
		});

		globalButton.addEventListener("click", () => {
			// Mixed -> all wrapped. Fully wrapped -> all unwrapped. There is no
			// hidden default/override hierarchy for the reader to keep track of.
			const wrapped = !blocks.every(isWrapped);
			root.dataset.wrapCode = String(wrapped);
			for (const pre of blocks) delete pre.dataset.wrapCode;
			if (storageKey) {
				try { sessionStorage.setItem(storageKey, String(wrapped)); } catch {}
			}
			updateButtons();
		});
		updateButtons();
	}

	globalObject.PiMarkdownPreviewCodeWrap = { installCodeWrapControls };
})(typeof globalThis !== "undefined" ? globalThis : window);
