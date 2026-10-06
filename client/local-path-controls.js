(function installLocalPathControls(entries, pagePath, nativeAction) {
	"use strict";
	if (document.documentElement.dataset.previewLocalPaths === "ready") return;
	document.documentElement.dataset.previewLocalPaths = "ready";
	const paths = new Map(entries);
	let interactionVersion = 0;
	window.addEventListener("pointerdown", () => { interactionVersion++; }, true);
	window.addEventListener("keydown", () => { interactionVersion++; }, true);
	const status = document.createElement("span");
	status.className = "pi-preview-path-status";
	status.setAttribute("role", "status");
	document.body.appendChild(status);

	// Match the code-copy control's fallback: preserve selection and focus, and
	// put only plain filesystem text on the clipboard, never HTML or a file URL.
	async function copyPath(text, stillCurrent) {
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(text);
				return true;
			}
		} catch {}
		if (!stillCurrent()) return false;
		const selection = window.getSelection();
		if (!selection) return false;
		const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange());
		const activeElement = document.activeElement;
		const buffer = document.createElement("pre");
		buffer.className = "pi-preview-path-copy-buffer";
		buffer.setAttribute("aria-hidden", "true");
		buffer.textContent = text;
		const onCopy = event => {
			if (!event.clipboardData) return;
			event.clipboardData.setData("text/plain", text);
			event.preventDefault();
		};
		try {
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

	let dialog, pathField, dialogOwner;
	const closeDialog = (restoreFocus = false) => {
		if (!dialog || dialog.hidden) return;
		dialog.hidden = true;
		if (restoreFocus && dialogOwner?.isConnected) dialogOwner.focus({ preventScroll: true });
	};
	const showPath = (path, owner) => {
		if (!dialog) {
			dialog = document.createElement("div");
			dialog.className = "pi-preview-path-dialog";
			dialog.setAttribute("role", "dialog");
			dialog.setAttribute("aria-label", "Copy local path manually");
			const label = document.createElement("p");
			label.textContent = "Clipboard unavailable. Select this path and copy it:";
			pathField = document.createElement("textarea");
			pathField.readOnly = true;
			pathField.rows = 2;
			pathField.setAttribute("aria-label", "Local file path");
			const close = document.createElement("button");
			close.type = "button";
			close.textContent = "Close";
			close.addEventListener("click", () => closeDialog(true));
			dialog.append(label, pathField, close);
			document.body.appendChild(dialog);
			document.addEventListener("keydown", event => {
				if (!dialog.hidden && event.key === "Escape") { event.preventDefault(); closeDialog(true); }
			});
			document.addEventListener("pointerdown", event => {
				if (!dialog.hidden && !dialog.contains(event.target)) closeDialog();
			});
		}
		dialogOwner = owner;
		pathField.value = path;
		dialog.hidden = false;
		pathField.focus({ preventScroll: true });
		pathField.select();
	};

	function makeButton(path, inline, label) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "pi-preview-copy-path" + (inline ? " pi-preview-copy-path-inline" : "");
		button.textContent = inline ? "" : "Copy local path";
		button.dataset.copyState = "idle";
		button.title = "Copy local path";
		button.setAttribute("aria-label", label);
		let copying = false, timer;
		button.addEventListener("click", async () => {
			if (copying) return;
			copying = true;
			const copyInteraction = interactionVersion;
			clearTimeout(timer);
			closeDialog();
			status.textContent = "";
			button.setAttribute("aria-disabled", "true");
			button.setAttribute("aria-busy", "true");
			let copied = false;
			try { copied = await copyPath(path, () => copyInteraction === interactionVersion); } catch {}
			finally {
				copying = false;
				button.removeAttribute("aria-disabled");
				button.removeAttribute("aria-busy");
			}
			button.dataset.copyState = copied ? "copied" : "failed";
			if (!inline) button.textContent = copied ? "Copied" : "Copy failed";
			const current = copyInteraction === interactionVersion;
			const failure = current ? "Could not copy the local path. Select it and copy manually." : "Could not copy the local path. Try again.";
			button.title = copied ? "Local path copied" : failure;
			status.textContent = copied ? "Local path copied." : failure;
			if (!copied && current) showPath(path, button);
			timer = window.setTimeout(() => {
				button.dataset.copyState = "idle";
				if (!inline) button.textContent = "Copy local path";
				button.title = "Copy local path";
				status.textContent = "";
			}, 1600);
		});
		return button;
	}

	function fileActionsLink(href, label, inline) {
		const url = new URL(href, location.href);
		url.searchParams.set("view", "path");
		const link = document.createElement("a");
		link.href = url.href;
		link.rel = "noopener noreferrer";
		link.className = inline ? "pi-preview-file-actions-inline" : "pi-preview-file-actions";
		link.textContent = inline ? "" : "File actions";
		link.title = "File actions";
		link.setAttribute("aria-label", label);
		return link;
	}

	for (const link of document.querySelectorAll("a[href]")) {
		let url;
		try { url = new URL(link.getAttribute("href"), location.href); } catch { continue; }
		if (url.origin !== location.origin) continue;
		const path = paths.get(url.pathname);
		if (!path || link.closest(".pi-preview-local-link")) continue;
		const wrapper = document.createElement("span");
		wrapper.className = "pi-preview-local-link";
		const label = link.textContent.trim() || link.querySelector("img")?.alt || "linked file";
		link.before(wrapper);
		wrapper.append(link, makeButton(path, true, "Copy local path for " + label), fileActionsLink(url.href, "File actions for " + label, true));
	}
	if (pagePath) {
		const navigation = document.querySelector('nav[aria-label="Document navigation"]');
		navigation?.appendChild(makeButton(pagePath, false, "Copy local path"));
		if (!nativeAction) navigation?.appendChild(fileActionsLink(location.href, "File actions", false));
	}
	if (nativeAction && pagePath) {
		const container = document.getElementById("pi-preview-native-actions");
		const result = document.getElementById("pi-preview-native-result");
		if (!container || !result) return;
		let pending = false;
		const buttons = [];
		const addAction = (action, label) => {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = label;
			button.dataset.nativeAction = action;
			buttons.push(button);
			button.addEventListener("click", async event => {
				// No DOM-generated clicks, page-load actions or automatic retries.
				if (!event.isTrusted || pending) return;
				pending = true;
				buttons.forEach(item => item.setAttribute("aria-disabled", "true"));
				button.setAttribute("aria-busy", "true");
				result.textContent = "Requesting the system action…";
				try {
					const url = new URL(nativeAction.url, location.href);
					url.searchParams.set("action", action);
					const response = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "X-Preview-Action": nativeAction.key }, signal: AbortSignal.timeout(15_000) });
					if (!response.ok) {
						const message = await response.text();
						throw new Error(message || "The file action was not accepted.");
					}
					result.textContent = "Request sent to the system on the preview host.";
				} catch (error) {
					result.textContent = error.name === "TimeoutError" || error.name === "AbortError"
						? "No confirmation received. Check your desktop before trying again."
						: error instanceof TypeError ? "Could not reach the preview. Check your desktop before trying again." : error.message;
				} finally {
					pending = false;
					buttons.forEach(item => item.removeAttribute("aria-disabled"));
					button.removeAttribute("aria-busy");
				}
			});
			container.appendChild(button);
		};
		if (nativeAction.kind !== "directory") addAction("reveal", "Show in folder");
		addAction("open", nativeAction.kind === "directory" ? "Open folder" : "Open in default app");
		container.appendChild(makeButton(pagePath, false, "Copy local path"));
		if (nativeAction.previewable) {
			const preview = document.createElement("a");
			const url = new URL(location.href);
			url.searchParams.delete("view");
			preview.href = url.href;
			preview.rel = "noopener noreferrer";
			preview.textContent = "Preview";
			container.appendChild(preview);
		}
	}
})
