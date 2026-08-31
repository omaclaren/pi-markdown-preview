(function installPiMarkdownPreviewPdfFigures(globalObject) {
	"use strict";

	const DEFAULT_RENDER_TIMEOUT_MS = 15000;
	const DEFAULT_TOTAL_RENDER_TIMEOUT_MS = 30000;
	const MAX_RENDER_SCALE = 3;
	const MAX_CANVAS_DIMENSION = 16384;
	const MAX_CANVAS_PIXELS = 8 * 1024 * 1024;
	const SAFE_CANVAS_PIXEL_RATIO = 0.98;
	const MAX_TOTAL_CANVAS_PIXELS = 32 * 1024 * 1024;

	function getSafePdfUrl(element) {
		const source = (element.getAttribute("src") || "").trim();
		if (!source) return null;
		try {
			const pathCandidate = decodeURIComponent(source.split(/[?#]/, 1)[0]);
			if (/^[\\/]{2}/.test(pathCandidate)) return null;
			if (/^[a-zA-Z]:[\\/]/.test(source)) {
				const suffixIndex = source.search(/[?#]/);
				const pathPart = suffixIndex < 0 ? source : source.slice(0, suffixIndex);
				const suffix = suffixIndex < 0 ? "" : source.slice(suffixIndex);
				return new URL(`file:///${pathPart.replace(/\\/g, "/")}${suffix}`);
			}
			let url;
			try {
				url = new URL(source, document.baseURI);
			} catch {
				if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(source)) return null;
				url = new URL(source, "https://pi-markdown-preview.invalid/");
			}
			if (!["http:", "https:", "file:", "data:", "blob:"].includes(url.protocol)) return null;
			if (url.protocol === "file:") {
				if (url.hostname && url.hostname !== "localhost") return null;
				if (/^[\\/]{2}/.test(decodeURIComponent(url.pathname))) return null;
			}
			return url;
		} catch {
			return null;
		}
	}

	function isPdfEmbed(element) {
		if (!(element instanceof HTMLElement) || element.tagName !== "EMBED") return false;
		const url = getSafePdfUrl(element);
		if (!url) return false;
		if (element.dataset.piMarkdownPreviewPdf === "true") return true;
		if ((element.getAttribute("type") || "").toLowerCase() === "application/pdf") return true;
		return url.protocol === "data:"
			? /^data:application\/pdf(?:[;,])/i.test(element.getAttribute("src") || "")
			: url.pathname.toLowerCase().endsWith(".pdf");
	}

	function decodeBase64Bytes(value) {
		const binary = atob(value);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
		return bytes;
	}

	function getFigureLabel(embed) {
		const figure = embed.closest("figure");
		const caption = figure && figure.querySelector("figcaption");
		const captionText = caption && typeof caption.textContent === "string" ? caption.textContent.trim() : "";
		if (captionText) return captionText;
		const title = (embed.getAttribute("title") || "").trim();
		if (title) return title;
		const source = embed.getAttribute("src") || "PDF figure";
		try {
			const pathname = new URL(source, document.baseURI).pathname;
			const filename = pathname.split("/").filter(Boolean).pop();
			return filename ? decodeURIComponent(filename) : "PDF figure";
		} catch {
			return "PDF figure";
		}
	}

	function now() {
		return globalObject.performance?.now?.() ?? Date.now();
	}

	function getStageTimeout(timeoutMs, deadlineAt) {
		const remaining = deadlineAt - now();
		if (remaining <= 0) throw new Error("PDF figure rendering time budget exhausted.");
		return Math.max(1, Math.min(timeoutMs, remaining));
	}

	function withTimeout(promise, timeoutMs, message, onTimeout) {
		let timer;
		return Promise.race([
			promise,
			new Promise((_resolve, reject) => {
				timer = setTimeout(() => {
					try { onTimeout?.(); } catch {}
					reject(new Error(message));
			}, timeoutMs);
			}),
		]).finally(() => clearTimeout(timer));
	}

	function getRenderScale(viewport, pixelLimit) {
		if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)
			|| viewport.width <= 0 || viewport.height <= 0) {
			throw new Error("PDF page dimensions are invalid.");
		}
		const deviceScale = Math.max(1, Math.min(MAX_RENDER_SCALE, globalObject.devicePixelRatio || 1));
		const boundedPixelLimit = Math.max(1, Math.min(MAX_CANVAS_PIXELS, pixelLimit));
		const scale = Math.min(
			deviceScale,
			Math.sqrt((boundedPixelLimit * SAFE_CANVAS_PIXEL_RATIO) / (viewport.width * viewport.height)),
			MAX_CANVAS_DIMENSION / viewport.width,
			MAX_CANVAS_DIMENSION / viewport.height,
		);
		if (!Number.isFinite(scale) || scale <= 0) throw new Error("PDF page is too large to render safely.");
		return scale;
	}

	function normalizeCssDimension(value, property) {
		const trimmed = String(value || "").trim();
		if (!trimmed) return "";
		const candidate = /^\d+(?:\.\d+)?$/.test(trimmed) ? `${trimmed}px` : trimmed;
		return globalObject.CSS?.supports?.(property, candidate) ? candidate : "";
	}

	function preserveEmbedPresentation(embed, link, canvas) {
		if (embed.id) link.id = embed.id;
		for (const className of embed.classList) link.classList.add(className);
		const width = normalizeCssDimension(embed.style.width || embed.getAttribute("width"), "width");
		const maxWidth = normalizeCssDimension(embed.style.maxWidth, "max-width");
		const height = normalizeCssDimension(embed.style.height || embed.getAttribute("height"), "height");
		const maxHeight = normalizeCssDimension(embed.style.maxHeight, "max-height");
		if (width) link.style.width = width;
		if (maxWidth) link.style.maxWidth = maxWidth;
		if (height) canvas.style.height = height;
		if (maxHeight) canvas.style.maxHeight = maxHeight;
		if (height && !width) {
			link.style.width = "fit-content";
			canvas.style.width = "auto";
		}
	}

	function buildRenderedFigure(embed, canvas, viewport) {
		const source = embed.getAttribute("src") || embed.src;
		const safeUrl = getSafePdfUrl(embed);
		const label = getFigureLabel(embed);
		const authoredTitle = (embed.getAttribute("title") || "").trim();
		const existingLink = embed.closest("a");
		const link = document.createElement(existingLink ? "span" : "a");
		link.className = "pdf-page-preview";
		if (!existingLink) {
			link.href = /^[a-zA-Z]:[\\/]/.test(source) && safeUrl ? safeUrl.href : source;
			link.target = "_blank";
			link.rel = "noopener";
			link.title = authoredTitle ? `${authoredTitle} — Open the original PDF` : "Open the original PDF";
			link.setAttribute("aria-label", `Open PDF: ${label}`);
		} else if (authoredTitle) {
			link.title = authoredTitle;
		}
		link.style.width = `${Math.ceil(viewport.width)}px`;

		canvas.className = "pdf-page-preview-canvas";
		canvas.style.width = `${Math.ceil(viewport.width)}px`;
		canvas.style.height = "auto";
		canvas.setAttribute("role", "img");
		canvas.setAttribute("aria-label", label);
		preserveEmbedPresentation(embed, link, canvas);
		link.appendChild(canvas);

		const badge = document.createElement("span");
		badge.className = "pdf-page-preview-badge";
		badge.setAttribute("aria-hidden", "true");
		badge.textContent = "PDF ↗";
		link.appendChild(badge);
		return link;
	}

	async function renderOnePdfFigure(embed, inlineBase64, pdfjs, timeoutMs, deadlineAt, sharedDocumentOptions, pixelLimit) {
		let loadingTask;
		let documentProxy;
		let page;
		let renderTask;
		try {
			const source = embed.getAttribute("src") || embed.src;
			const safeUrl = getSafePdfUrl(embed);
			if (!safeUrl) throw new Error("PDF figure source uses an unsupported URL scheme.");
			const documentOptions = inlineBase64
				? { ...sharedDocumentOptions, data: decodeBase64Bytes(inlineBase64), isEvalSupported: false }
				: {
					...sharedDocumentOptions,
					url: safeUrl.href,
					isEvalSupported: false,
					withCredentials: safeUrl.origin === globalObject.location.origin,
				};
			loadingTask = pdfjs.getDocument(documentOptions);
			documentProxy = await withTimeout(
				loadingTask.promise,
				getStageTimeout(timeoutMs, deadlineAt),
				`Timed out loading PDF figure: ${source}`,
				() => loadingTask?.destroy?.(),
			);
			if (documentProxy.numPages !== 1) return { status: "multi-page" };

			page = await withTimeout(
				documentProxy.getPage(1),
				getStageTimeout(timeoutMs, deadlineAt),
				`Timed out reading PDF figure: ${source}`,
				() => loadingTask?.destroy?.(),
			);
			const baseViewport = page.getViewport({ scale: 1 });
			const renderScale = getRenderScale(baseViewport, pixelLimit);
			const renderViewport = page.getViewport({ scale: renderScale });
			const canvas = document.createElement("canvas");
			canvas.width = Math.max(1, Math.ceil(renderViewport.width));
			canvas.height = Math.max(1, Math.ceil(renderViewport.height));
			const canvasContext = canvas.getContext("2d", { alpha: false });
			if (!canvasContext) throw new Error("Canvas rendering is unavailable.");
			renderTask = page.render({ canvas, canvasContext, viewport: renderViewport });
			await withTimeout(
				renderTask.promise,
				getStageTimeout(timeoutMs, deadlineAt),
				`Timed out rendering PDF figure: ${source}`,
				() => renderTask?.cancel?.(),
			);
			embed.replaceWith(buildRenderedFigure(embed, canvas, baseViewport));
			return { status: "rendered", pixels: canvas.width * canvas.height };
		} finally {
			try { page?.cleanup?.(); } catch {}
			try {
				const cleanup = loadingTask?.destroy?.() ?? documentProxy?.destroy?.();
				if (cleanup) {
					await withTimeout(Promise.resolve(cleanup), Math.max(1, Math.min(250, deadlineAt - now())), "Timed out cleaning up PDF rendering.");
				}
			} catch {}
		}
	}

	async function renderSinglePagePdfFigures(root, options) {
		const embeds = root
			? Array.from(root.querySelectorAll("embed")).filter(isPdfEmbed)
			: [];
		const result = {
			status: embeds.length === 0 ? "skipped" : "pending",
			total: embeds.length,
			rendered: 0,
			multiPage: 0,
			failed: 0,
		};
		if (embeds.length === 0) return result;

		const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
			? options.timeoutMs
			: DEFAULT_RENDER_TIMEOUT_MS;
		const totalTimeoutMs = Number.isFinite(options.totalTimeoutMs) && options.totalTimeoutMs > 0
			? options.totalTimeoutMs
			: DEFAULT_TOTAL_RENDER_TIMEOUT_MS;
		const deadlineAt = now() + totalTimeoutMs;
		const remainingTime = () => deadlineAt - now();

		let pdfjs;
		try {
			pdfjs = await withTimeout(
				Promise.resolve().then(() => options.loadPdfJs()),
				getStageTimeout(timeoutMs, deadlineAt),
				"Timed out loading the PDF figure renderer.",
			);
		} catch (error) {
			result.status = "failed";
			result.failed = embeds.length;
			console.warn("PDF page previews are unavailable; retaining native PDF embeds.", error);
			return result;
		}

		const inlinePdfData = options.inlinePdfData && typeof options.inlinePdfData === "object"
			? options.inlinePdfData
			: {};
		const documentOptions = options.documentOptions && typeof options.documentOptions === "object"
			? options.documentOptions
			: {};
		const outcomes = [];
		let renderedPixels = 0;
		for (let index = 0; index < embeds.length; index += 1) {
			try {
				const remainingMs = remainingTime();
				if (remainingMs <= 0) throw new Error("PDF figure rendering time budget exhausted.");
				const remainingPixels = MAX_TOTAL_CANVAS_PIXELS - renderedPixels;
				if (remainingPixels <= 0) throw new Error("PDF figure canvas budget exhausted.");
				const embed = embeds[index];
				const dataIndex = embed.dataset.piMarkdownPreviewPdfIndex || "";
				const inlineBase64 = Object.prototype.hasOwnProperty.call(inlinePdfData, dataIndex)
					? inlinePdfData[dataIndex]
					: null;
				const outcome = await renderOnePdfFigure(
					embed,
					inlineBase64,
					pdfjs,
					timeoutMs,
					deadlineAt,
					documentOptions,
					remainingPixels,
				);
				if (outcome.status === "rendered") renderedPixels += outcome.pixels;
				outcomes.push(outcome);
			} catch (error) {
				console.warn("A PDF figure could not be rendered; retaining its native PDF embed.", error);
				outcomes.push({ status: "failed" });
			}
		}

		for (const outcome of outcomes) {
			if (outcome.status === "rendered") result.rendered += 1;
			else if (outcome.status === "multi-page") result.multiPage += 1;
			else result.failed += 1;
		}
		result.status = result.failed === result.total
			? "failed"
			: result.failed > 0
				? "partial"
				: "success";
		return result;
	}

	globalObject.PiMarkdownPreviewPdfFigures = Object.freeze({
		isPdfEmbed,
		renderSinglePagePdfFigures,
	});
})(typeof window !== "undefined" ? window : globalThis);
