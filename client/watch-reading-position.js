(function installPiMarkdownPreviewReadingPosition(globalObject) {
	"use strict";

	const SELECTOR = "h1,h2,h3,h4,h5,h6,p,pre,table,figure,li";
	function hashText(text) {
		let hash = 2166136261;
		for (let index = 0; index < text.length; index += 1) {
			hash ^= text.charCodeAt(index);
			hash = Math.imul(hash, 16777619);
		}
		return (hash >>> 0).toString(36);
	}

	// Same strategy as the document watchers in pandoc-glance and Pi Studio:
	// stable content/ID + duplicate occurrence + viewport offset, then ratio.
	function anchors(root) {
		const occurrences = new Map();
		return Array.from(root.querySelectorAll(SELECTOR)).map(element => {
			const text = (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 180);
			const key = element.id ? "id:" + element.id : element.tagName.toLowerCase() + ":" + hashText(text);
			const occurrence = occurrences.get(key) || 0;
			occurrences.set(key, occurrence + 1);
			return { element, key, occurrence };
		});
	}

	function capture(root) {
		const candidates = anchors(root);
		const targetLine = Math.max(20, Math.min(window.innerHeight * 0.22, 140));
		let selected = 0;
		for (let index = 0; index < candidates.length; index += 1) {
			if (candidates[index].element.getBoundingClientRect().top > targetLine) break;
			selected = index;
		}
		const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
		return {
			hash: window.location.hash,
			ratio: maxScroll > 0 ? Math.max(0, Math.min(1, window.scrollY / maxScroll)) : 0,
			// Neighbours help when the paragraph currently being edited changes.
			anchors: [selected, selected - 1, selected + 1].filter(index => candidates[index]).map(index => {
				const { element, key, occurrence } = candidates[index];
				return { key, occurrence, offset: element.getBoundingClientRect().top };
			}),
		};
	}

	function restore(root, snapshot) {
		if (snapshot.ratio === 0) {
			window.scrollTo({ top: 0, behavior: "instant" });
			return;
		}
		const candidates = anchors(root);
		for (const saved of snapshot.anchors) {
			const target = candidates.find(candidate => candidate.key === saved.key && candidate.occurrence === saved.occurrence);
			if (!target) continue;
			window.scrollTo({ top: Math.max(0, window.scrollY + target.element.getBoundingClientRect().top - saved.offset), behavior: "instant" });
			return;
		}
		const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
		window.scrollTo({ top: maxScroll * snapshot.ratio, behavior: "instant" });
	}

	function validSnapshot(value) {
		return value && typeof value.hash === "string" && Number.isFinite(value.ratio) && value.ratio >= 0 && value.ratio <= 1
			&& Array.isArray(value.anchors) && value.anchors.length <= 3
			&& value.anchors.every(anchor => anchor && typeof anchor.key === "string" && anchor.key.length <= 1024
				&& Number.isInteger(anchor.occurrence) && anchor.occurrence >= 0 && Number.isFinite(anchor.offset));
	}

	function install(root, scope) {
		if (!root || !scope) return undefined;
		// Public per-server identity, not a path or authentication token. Tab-local
		// one-shot handoff covers reloads and same-file revision navigation only.
		const key = "pi-markdown-preview:reading-position:" + scope;
		let pending;
		try {
			const saved = JSON.parse(sessionStorage.getItem(key) || "null");
			sessionStorage.removeItem(key);
			if (validSnapshot(saved) && saved.hash === window.location.hash) pending = saved;
		} catch { /* Storage denial must not break watch navigation. */ }
		let savedForNavigation = false;
		let frame;
		let timer;
		let deadline;
		let observer;
		let restoring = Boolean(pending);
		const stopRestoring = () => {
			restoring = false;
			cancelAnimationFrame(frame);
			clearTimeout(timer);
			clearTimeout(deadline);
			observer?.disconnect();
			window.removeEventListener("pi-markdown-preview-ready", scheduleRestore);
			window.removeEventListener("load", scheduleRestore, true);
			for (const event of ["wheel", "touchstart", "pointerdown", "keydown", "hashchange"]) window.removeEventListener(event, cancelRestore, true);
		};
		const cancelRestore = () => {
			pending = undefined;
			stopRestoring();
		};
		const applyRestore = () => {
			if (!restoring) return;
			restore(root, pending);
			// __mermaidDone includes math, PDF figures, wrapping and fonts. Ordinary
			// images may settle later. Bound retries and stop immediately on input;
			// late assets must never wrestle with the reader's own scrolling.
			if (window.__mermaidDone === true && Array.from(root.querySelectorAll("img")).every(image => image.complete)) {
				pending = undefined;
				stopRestoring();
			}
		};
		const scheduleRestore = () => {
			if (!restoring) return;
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(applyRestore);
		};
		const save = () => {
			if (savedForNavigation) return;
			savedForNavigation = true;
			// A second update can arrive while the first page is still rendering.
			// Carry the original anchor forward instead of capturing its loading state.
			try { sessionStorage.setItem(key, JSON.stringify(pending || capture(root))); } catch {}
			stopRestoring();
		};
		window.addEventListener("pagehide", save, { once: true });
		if (restoring) {
			for (const event of ["wheel", "touchstart", "pointerdown", "keydown", "hashchange"]) window.addEventListener(event, cancelRestore, { capture: true, passive: true });
			window.addEventListener("pi-markdown-preview-ready", scheduleRestore);
			window.addEventListener("load", scheduleRestore, true);
			observer = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleRestore) : null;
			observer?.observe(root);
			// Also handles hosts whose animation frames pause while a tab is hidden.
			const poll = () => { applyRestore(); if (restoring) timer = setTimeout(poll, 100); };
			deadline = setTimeout(cancelRestore, 10000);
			poll();
		}
		return { save };
	}

	globalObject.PiMarkdownPreviewReadingPosition = { install };
})(typeof globalThis !== "undefined" ? globalThis : window);
