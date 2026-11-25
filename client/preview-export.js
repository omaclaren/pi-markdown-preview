// Export of a watched response preview: a standalone HTML file of the response as
// the page shows it, and printing (which the browser can save as PDF). Everything
// happens in this page: the file is built from what is already rendered, so the
// server gains no route, and the file carries no script and no link to the preview.
(() => {
	// Same-origin images are copied into the file, within these limits.
	const IMAGE_BYTES = 16 * 1024 * 1024;
	const TOTAL_BYTES = 64 * 1024 * 1024;
	const READY_WAIT_MS = 20_000;
	// The file renders without a server: no scripts, its images inline or remote as in the
	// preview, and the CDN that the page's maths fonts and styles may come from.
	const POLICY = "default-src 'none'; img-src data: http: https:; style-src 'unsafe-inline' https://cdn.jsdelivr.net; font-src data: https://cdn.jsdelivr.net; base-uri 'none'; form-action 'none'";

	/** Diagrams, maths and PDF figures render after load; the page says when it's done. */
	const ready = () => window.__mermaidDone === true ? Promise.resolve() : new Promise(resolve => {
		const timer = setTimeout(resolve, READY_WAIT_MS);
		window.addEventListener("pi-markdown-preview-ready", () => { clearTimeout(timer); resolve(); }, { once: true });
	});

	const sameOrigin = url => {
		try { return new URL(url, location.href).origin === location.origin; } catch { return false; }
	};
	const omitted = (document, text) => Object.assign(document.createElement("span"), { className: "preview-export-omitted", textContent: `[${text}]` });
	const readDataUrl = blob => new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});

	/** The page's document as standalone HTML. */
	async function standaloneHtml() {
		await ready();
		const html = document.documentElement.cloneNode(true);
		const root = html.querySelector("#preview-root");
		const sourceRoot = document.getElementById("preview-root");
		if (!root || !sourceRoot) throw new Error("Nothing to export.");
		// Pixels and resolved sources come from the page itself; the clone is edited in step.
		const pairs = selector => {
			const clones = [...root.querySelectorAll(selector)];
			const sources = [...sourceRoot.querySelectorAll(selector)];
			return clones.length === sources.length ? clones.map((clone, i) => [clone, sources[i]]) : [];
		};
		const canvases = pairs("canvas");
		const images = pairs("img");

		// The preview's own controls, scripts and state are not part of the response.
		for (const element of html.querySelectorAll([
			"script", "noscript", "#pi-markdown-preview-watch-nav", "#pi-markdown-preview-watch-style",
			"meta[http-equiv]", "meta[name='pi-markdown-preview-wrap-scope']", "base",
			".preview-code-toolbar", ".preview-code-block-controls", ".preview-code-copy-buffer", ".pdf-page-preview-badge",
			// Local links' copy-path and file-actions controls; a response can't contain buttons of its own.
			"button", ".pi-preview-path-status", ".pi-preview-path-copy-buffer", ".pi-preview-path-dialog",
			".pi-preview-file-actions", ".pi-preview-file-actions-inline", "#pi-preview-native-actions", "#pi-preview-native-result",
		].join(","))) element.remove();
		for (const link of html.querySelectorAll("link")) {
			if (!(link.relList.contains("stylesheet") && /^https:/i.test(link.href) && !sameOrigin(link.href))) link.remove();
		}
		html.style.removeProperty("--pi-preview-watch-nav-height");
		if (!html.getAttribute("style")) html.removeAttribute("style");

		// A rendered PDF figure is a canvas, whose pixels a copy doesn't keep.
		for (const [clone, source] of canvases) {
			let src = "";
			try { src = source.toDataURL("image/png"); } catch {}
			if (!src) { clone.replaceWith(omitted(clone.ownerDocument, "figure not included in this export")); continue; }
			const image = clone.ownerDocument.createElement("img");
			for (const { name, value } of clone.attributes) if (name !== "width" && name !== "height") image.setAttribute(name, value);
			Object.assign(image, { src, width: source.width, height: source.height });
			clone.replaceWith(image);
		}

		// Local images come from the preview's server: copy them in. Remote ones stay remote, as in the preview.
		let total = 0;
		for (const [clone, source] of images) {
			clone.removeAttribute("srcset");
			clone.removeAttribute("loading");
			const url = source.currentSrc || source.src;
			if (!url || url.startsWith("data:")) continue;
			if (!sameOrigin(url)) { clone.setAttribute("src", url); continue; }
			const label = clone.getAttribute("alt") ? `image “${clone.getAttribute("alt")}”` : "image";
			try {
				const response = await fetch(url, { credentials: "same-origin" });
				const blob = response.ok ? await response.blob() : null;
				if (!blob || !blob.type.startsWith("image/")) throw new Error("not an image");
				if (blob.size > IMAGE_BYTES || total + blob.size > TOTAL_BYTES) { clone.replaceWith(omitted(clone.ownerDocument, `${label} too large to include in this export`)); continue; }
				total += blob.size;
				clone.setAttribute("src", await readDataUrl(blob));
			} catch {
				clone.replaceWith(omitted(clone.ownerDocument, `${label} not available for this export`));
			}
		}

		// Embedded files and local links lead back to the preview's server, which the file can't
		// reach; the file's policy would refuse remote embeds.
		for (const element of root.querySelectorAll("embed, object, iframe, video, audio")) {
			element.replaceWith(omitted(element.ownerDocument, "embedded file not included in this export"));
		}
		// A link that can't lead anywhere becomes its text, so it doesn't look like one.
		for (const link of root.querySelectorAll("a[href]")) {
			const href = link.getAttribute("href") || "";
			if (!href.startsWith("#") && sameOrigin(href)) link.replaceWith(...link.childNodes);
		}

		const head = html.querySelector("head");
		const policy = Object.assign(html.ownerDocument.createElement("meta"), { httpEquiv: "Content-Security-Policy", content: POLICY });
		head?.prepend(policy);
		if (!head?.querySelector("meta[charset]")) {
			const charset = html.ownerDocument.createElement("meta");
			charset.setAttribute("charset", "utf-8");
			head?.prepend(charset);
		}
		const style = html.ownerDocument.createElement("style");
		// The watch page's spacing for a leading heading, so the file looks as the page did.
		style.textContent = ".preview-export-omitted{color:GrayText;font-style:italic}@media screen{#preview-root>:is(h1,h2,h3,h4,h5,h6):first-child{margin-top:0}}";
		head?.append(style);
		return `<!doctype html>\n${html.outerHTML}\n`;
	}

	/**
	 * A file name from what the preview shows (a session's label or a file's name, else the
	 * page title without the preview's own name), safe on any file system.
	 */
	const fileName = (label = "") => {
		const name = (label.trim() || document.title.replace(/ — [^—]*$/, ""))
			.replace(/\.(?:md|markdown|tex)$/i, "")
			.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 120).trim();
		return `${name || "preview"}.html`;
	};

	async function downloadHtml(label) {
		const text = await standaloneHtml();
		const url = URL.createObjectURL(new Blob([text], { type: "text/html;charset=utf-8" }));
		const link = Object.assign(document.createElement("a"), { href: url, download: fileName(label) });
		document.body.append(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
		return link.download;
	}

	async function print() {
		await ready();
		window.print();
	}

	window.PiMarkdownPreviewExport = { standaloneHtml, downloadHtml, print, fileName };
})();
