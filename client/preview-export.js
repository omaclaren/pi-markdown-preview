// Export of a watched response preview: a standalone HTML file of the response as
// the page shows it, and printing (which the browser can save as PDF). Everything
// happens in this page: the file is built from what is already rendered, so the
// server gains no route, and the file carries no script and no link to the preview.
(() => {
	// Same-origin images and drawn figures are copied into the file, within these limits.
	const IMAGE_BYTES = 16 * 1024 * 1024;
	const TOTAL_BYTES = 64 * 1024 * 1024;
	const IMAGE_WAIT_MS = 20_000;
	// Each rendering stage has its own time limit and the page always says when it's done;
	// this only guards against a page that never does.
	const READY_WAIT_MS = 90_000;
	// The file renders without a server: no scripts, its images inline or remote as in the
	// preview, and the CDN that the page's maths fonts and styles may come from.
	const POLICY = "default-src 'none'; img-src data: http: https:; style-src 'unsafe-inline' https://cdn.jsdelivr.net; font-src data: https://cdn.jsdelivr.net; base-uri 'none'; form-action 'none'";

	/** Diagrams, maths and PDF figures render after load; true once the page says it's done. */
	const ready = () => window.__mermaidDone === true ? Promise.resolve(true) : new Promise(resolve => {
		const done = () => { clearTimeout(timer); resolve(true); };
		const timer = setTimeout(() => {
			window.removeEventListener("pi-markdown-preview-ready", done);
			resolve(window.__mermaidDone === true);
		}, READY_WAIT_MS);
		window.addEventListener("pi-markdown-preview-ready", done, { once: true });
	});
	const stillRendering = () => Object.assign(new Error("The page is still rendering."), { name: "StillRendering" });

	const sameOrigin = url => {
		try { return new URL(url, location.href).origin === location.origin; } catch { return false; }
	};
	// A reference into the page itself, written absolutely (as Mermaid's arrowMarkerAbsolute
	// does), becomes a bare fragment; any other reference to the preview's server is dropped.
	const localReference = value => {
		if (value.startsWith("#")) return value;
		try {
			const url = new URL(value, location.href);
			if (url.origin !== location.origin) return value;
			return url.hash && url.pathname === location.pathname ? url.hash : undefined;
		} catch { return value; }
	};
	const withoutLocalUrls = css => css.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (match, quote, target) => {
		const kept = localReference(target);
		return kept === undefined ? "none" : kept === target ? match : `url(${quote}${kept}${quote})`;
	});
	const omitted = (document, text) => Object.assign(document.createElement("span"), { className: "preview-export-omitted", textContent: `[${text}]` });
	const readDataUrl = blob => new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});

	/** The page's document as standalone HTML. */
	async function standaloneHtml() {
		if (!await ready()) throw stillRendering();
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
			// Each image is exported as the one the page chose.
			"picture > source",
		].join(","))) element.remove();
		for (const link of html.querySelectorAll("link")) {
			if (!(link.relList.contains("stylesheet") && /^https:/i.test(link.href) && !sameOrigin(link.href))) link.remove();
		}
		html.style.removeProperty("--pi-preview-watch-nav-height");
		if (!html.getAttribute("style")) html.removeAttribute("style");

		// A rendered PDF figure is a canvas, whose pixels a copy doesn't keep.
		let total = 0;
		for (const [clone, source] of canvases) {
			let src = "";
			try { src = source.toDataURL("image/png"); } catch {}
			if (!src) { clone.replaceWith(omitted(clone.ownerDocument, "figure not included in this export")); continue; }
			if (src.length > IMAGE_BYTES || total + src.length > TOTAL_BYTES) { clone.replaceWith(omitted(clone.ownerDocument, "figure too large to include in this export")); continue; }
			total += src.length;
			const image = clone.ownerDocument.createElement("img");
			for (const { name, value } of clone.attributes) if (name !== "width" && name !== "height") image.setAttribute(name, value);
			Object.assign(image, { src, width: source.width, height: source.height });
			clone.replaceWith(image);
		}

		// Local images come from the preview's server: copy them in. Remote ones stay remote, as in the preview.
		for (const [clone, source] of images) {
			clone.removeAttribute("srcset");
			clone.removeAttribute("sizes");
			clone.removeAttribute("loading");
			const url = source.currentSrc || source.src;
			if (!url) continue;
			if (url.startsWith("data:") || !sameOrigin(url)) { clone.setAttribute("src", url); continue; }
			const label = clone.getAttribute("alt") ? `image “${clone.getAttribute("alt")}”` : "image";
			const tooLarge = () => clone.replaceWith(omitted(clone.ownerDocument, `${label} too large to include in this export`));
			try {
				const response = await fetch(url, { credentials: "same-origin", signal: AbortSignal.timeout(IMAGE_WAIT_MS) });
				const declared = Number(response.headers.get("content-length")) || 0;
				if (response.ok && (declared > IMAGE_BYTES || total + declared > TOTAL_BYTES)) { await response.body?.cancel(); tooLarge(); continue; }
				const blob = response.ok ? await response.blob() : null;
				if (!blob || !blob.type.startsWith("image/")) throw new Error("not an image");
				if (blob.size > IMAGE_BYTES || total + blob.size > TOTAL_BYTES) { tooLarge(); continue; }
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
		// A link that can't lead anywhere becomes its text, so it doesn't look like one. One that
		// places or styles its content (a PDF figure's frame, a figure's ID) keeps that as a span.
		for (const link of root.querySelectorAll("a[href]")) {
			const href = link.getAttribute("href") || "";
			if (href.startsWith("#") || !sameOrigin(href)) continue;
			const kept = ["id", "class", "style"].filter(name => link.hasAttribute(name));
			if (!kept.length) { link.replaceWith(...link.childNodes); continue; }
			const span = link.ownerDocument.createElement("span");
			for (const name of kept) span.setAttribute(name, link.getAttribute(name));
			span.append(...link.childNodes);
			link.replaceWith(span);
		}
		// Whatever else still names the preview's server: SVG references and CSS url()s
		// (absolute markers, inline styles) and resource attributes.
		for (const element of html.querySelectorAll("*")) {
			for (const { name, value } of [...element.attributes]) {
				if (value.toLowerCase().includes("url(")) {
					const cleaned = withoutLocalUrls(value);
					if (cleaned !== value) element.setAttribute(name, cleaned);
				} else if (/^(?:href|xlink:href|src|srcset|poster|background|action|formaction|data|cite|ping)$/i.test(name)) {
					if (name.toLowerCase() === "src" && value.startsWith("data:")) continue;
					const kept = localReference(value.trim());
					if (kept === undefined) element.removeAttribute(name);
					else if (kept !== value.trim()) element.setAttribute(name, kept);
				}
			}
		}
		for (const style of html.querySelectorAll("style")) style.textContent = withoutLocalUrls(style.textContent);

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

	// Within 200 bytes, so the name with its extension fits any file system's limit.
	const byBytes = (text, limit) => {
		const encoder = new TextEncoder();
		let kept = "", size = 0;
		for (const character of text) {
			size += encoder.encode(character).length;
			if (size > limit) break;
			kept += character;
		}
		return kept;
	};
	/**
	 * A file name from what the preview shows (a session's label or a file's name, else the
	 * page title without the preview's own name), safe on any file system.
	 */
	const fileName = (label = "") => {
		let name = (label.trim() || document.title.replace(/ — [^—]*$/, ""))
			.replace(/\.(?:md|markdown|tex)$/i, "")
			.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 120);
		name = byBytes(name, 200).replace(/[. ]+$/, "").trim();
		// Names Windows reserves for devices, whatever the extension.
		if (/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(name)) name = `_${name}`;
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
		if (!await ready()) throw stillRendering();
		window.print();
	}

	window.PiMarkdownPreviewExport = { standaloneHtml, downloadHtml, print, fileName };
})();
