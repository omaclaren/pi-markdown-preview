import { createHmac, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, posix as posixPath, relative, resolve, win32 as win32Path } from "node:path";
import { fileURLToPath } from "node:url";

const EVENTS_PATH = "/__pi_markdown_preview_events__";
const RESOURCE_PREFIX = "/__pi_markdown_preview_resource__/";
const ABSOLUTE_IMAGE_PREFIX = "/__pi_markdown_preview_absolute_image__/";
const BASE_TAG_PATTERN = /<base\s+href=(?:"[^"]*"|'[^']*')\s*\/?>/i;
const DEFAULT_HISTORY_LIMIT = 20;

const RESOURCE_CONTENT_TYPES = new Map([
	[".avif", "image/avif"],
	[".bmp", "image/bmp"],
	[".gif", "image/gif"],
	[".ico", "image/x-icon"],
	[".jpeg", "image/jpeg"],
	[".jpg", "image/jpeg"],
	[".png", "image/png"],
	[".svg", "image/svg+xml"],
	[".webp", "image/webp"],
]);

function decodeHtmlImageSource(source) {
	return source.replace(/&(amp|quot|apos|#39|#x27);/gi, (entity, name) => {
		switch (String(name).toLowerCase()) {
			case "amp": return "&";
			case "quot": return '"';
			case "apos":
			case "#39":
			case "#x27": return "'";
			default: return entity;
		}
	});
}

/**
 * Resolve an image src attribute to a local absolute path without touching the
 * filesystem. Network, data, relative, and UNC URLs are deliberately ignored.
 *
 * @param {string} source
 * @param {NodeJS.Platform} [platform]
 */
export function getBrowserWatchAbsoluteImagePath(source, platform = process.platform) {
	const decodedSource = decodeHtmlImageSource(source.trim());
	if (!decodedSource || decodedSource.includes("\0")) return undefined;

	if (/^file:/i.test(decodedSource)) {
		try {
			const fileUrl = new URL(decodedSource);
			if (fileUrl.protocol !== "file:" || (fileUrl.hostname && fileUrl.hostname !== "localhost")) return undefined;
			fileUrl.search = "";
			fileUrl.hash = "";
			if (platform !== "win32") {
				const filePath = fileURLToPath(fileUrl);
				return filePath.includes("\0") ? undefined : filePath;
			}
			let windowsPath = decodeURIComponent(fileUrl.pathname).replace(/^\/([a-zA-Z]:[\\/])/, "$1").replace(/\//g, "\\");
			if (windowsPath.includes("\0") || windowsPath.startsWith("\\\\") || !win32Path.isAbsolute(windowsPath)) return undefined;
			return win32Path.normalize(windowsPath);
		} catch {
			return undefined;
		}
	}

	if (decodedSource.startsWith("//") || decodedSource.startsWith("\\\\")) return undefined;
	const windowsDrivePath = /^[a-zA-Z]:[\\/]/.test(decodedSource);
	if (!windowsDrivePath && /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(decodedSource)) return undefined;

	let pathSource = decodedSource.split(/[?#]/, 1)[0];
	try {
		pathSource = decodeURIComponent(pathSource);
	} catch {
		return undefined;
	}
	if (pathSource.includes("\0")) return undefined;
	if (platform === "win32") {
		pathSource = pathSource.replace(/^\/([a-zA-Z]:[\\/])/, "$1").replace(/\//g, "\\");
		if (pathSource.startsWith("\\\\") || !win32Path.isAbsolute(pathSource)) return undefined;
		return win32Path.normalize(pathSource);
	}
	return posixPath.isAbsolute(pathSource) ? posixPath.normalize(pathSource) : undefined;
}

/**
 * Rewrite only explicitly referenced absolute local images to authenticated
 * server routes. Other sources are left byte-for-byte unchanged.
 *
 * @param {string} html
 * @param {(absolutePath: string, contentType: string) => string} routeForImage
 * @param {NodeJS.Platform} [platform]
 */
export function rewriteBrowserWatchAbsoluteImageSources(html, routeForImage, platform = process.platform) {
	return html.replace(/(<img\b[^>]*?\s+src\s*=\s*)(["'])([^"']*)\2/gi, (match, prefix, quote, source) => {
		const absolutePath = getBrowserWatchAbsoluteImagePath(source, platform);
		if (!absolutePath) return match;
		const contentType = RESOURCE_CONTENT_TYPES.get(extname(absolutePath).toLowerCase());
		if (!contentType) return match;
		return `${prefix}${quote}${routeForImage(absolutePath, contentType)}${quote}`;
	});
}

const COMMON_SECURITY_HEADERS = {
	"Cache-Control": "no-store",
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
};

const NON_HTML_SECURITY_HEADERS = {
	...COMMON_SECURITY_HEADERS,
	"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

/** @param {string} scriptNonce */
function getHtmlSecurityHeaders(scriptNonce) {
	return {
		...COMMON_SECURITY_HEADERS,
		"Content-Security-Policy": [
			"default-src 'none'",
			"base-uri 'self'",
			"connect-src 'self' https://cdn.jsdelivr.net https://unpkg.com",
			"font-src 'self' data: https://cdn.jsdelivr.net",
			"frame-ancestors 'none'",
			"img-src 'self' data: http: https:",
			`script-src 'nonce-${scriptNonce}' 'strict-dynamic' https://cdn.jsdelivr.net`,
			"style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
		].join("; "),
	};
}

/**
 * Add bounded-response navigation and completion notifications to a canonical
 * preview document.
 *
 * @param {string} html
 * @param {{ revision: number, revisions: number[], isWaiting?: boolean }} navigation
 * @param {string} [scriptNonce]
 */
export function prepareBrowserWatchHtml(html, navigation, scriptNonce) {
	let watchedHtml = BASE_TAG_PATTERN.test(html) ? html.replace(BASE_TAG_PATTERN, "") : html;
	if (!/<link\s+[^>]*rel=(?:"icon"|'icon')[^>]*>/i.test(watchedHtml)) {
		watchedHtml = watchedHtml.replace(/<\/head>/i, '<link rel="icon" href="data:," />\n</head>');
	}

	const revision = String(navigation.revision);
	const revisions = navigation.revisions.map(String);
	const isWaiting = navigation.isWaiting === true;
	const currentIndex = Math.max(0, revisions.indexOf(revision));
	const previousRevision = revisions[currentIndex - 1];
	const nextRevision = revisions[currentIndex + 1];
	const latestRevision = revisions[revisions.length - 1] ?? revision;
	const linkAttributes = (targetRevision) => targetRevision === undefined
		? 'aria-disabled="true" tabindex="-1"'
		: `href="/?revision=${encodeURIComponent(targetRevision)}" aria-disabled="false"`;

	const watchStyle = `<style id="pi-markdown-preview-watch-style">
#pi-markdown-preview-watch-nav {
  align-items: center;
  background: var(--card, Canvas);
  border: 1px solid var(--panel-border, ButtonBorder);
  border-radius: 999px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
  color: var(--text, CanvasText);
  display: flex;
  font: 600 12px/1.2 system-ui, sans-serif;
  gap: 0.15rem;
  max-width: calc(100vw - 1rem);
  padding: 0.3rem 0.4rem;
  position: fixed;
  right: 0.6rem;
  top: 0.6rem;
  z-index: 2147483647;
}
#pi-markdown-preview-watch-nav a,
#pi-markdown-preview-watch-nav span {
  border-radius: 999px;
  color: inherit;
  padding: 0.3rem 0.5rem;
  text-decoration: none;
  white-space: nowrap;
}
#pi-markdown-preview-watch-nav a:hover { background: var(--panel-2, rgba(127, 127, 127, 0.16)); }
#pi-markdown-preview-watch-nav a[aria-disabled="true"] { opacity: 0.38; pointer-events: none; }
#pi-markdown-preview-watch-latest.pi-markdown-preview-watch-new { color: var(--accent, LinkText); }
#pi-markdown-preview-watch-count { color: var(--muted, GrayText); font-variant-numeric: tabular-nums; }
@media (max-width: 640px) {
  #pi-markdown-preview-watch-nav { bottom: 0.5rem; left: 0.5rem; right: auto; top: auto; }
  #pi-markdown-preview-watch-nav a,
  #pi-markdown-preview-watch-nav span { padding-inline: 0.38rem; }
}
@media print { #pi-markdown-preview-watch-nav { display: none; } }
</style>`;
	watchedHtml = /<\/head>/i.test(watchedHtml)
		? watchedHtml.replace(/<\/head>/i, `${watchStyle}\n</head>`)
		: `${watchStyle}\n${watchedHtml}`;

	const watchNavigation = `<nav id="pi-markdown-preview-watch-nav" aria-label="Rendered response history">
  <a id="pi-markdown-preview-watch-previous" data-watch-control="previous" ${linkAttributes(isWaiting ? undefined : previousRevision)}>← Previous</a>
  <span id="pi-markdown-preview-watch-count" data-watch-control="count" aria-live="polite">${isWaiting ? "Waiting" : `${currentIndex + 1} of ${revisions.length}`}</span>
  <a id="pi-markdown-preview-watch-next" data-watch-control="next" ${linkAttributes(isWaiting ? undefined : nextRevision)}>Next →</a>
  <a id="pi-markdown-preview-watch-latest" data-watch-control="latest" ${linkAttributes(isWaiting || revision === latestRevision ? undefined : latestRevision)}>Latest</a>
</nav>`;

	const watchScript = `<script>
(() => {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);
  const revision = ${JSON.stringify(revision)};
  let revisions = ${JSON.stringify(revisions)};
  const followingLatest = revision === revisions[revisions.length - 1];
  const navigation = document.currentScript?.previousElementSibling;
  const previousLink = navigation?.querySelector('[data-watch-control="previous"]');
  const countLabel = navigation?.querySelector('[data-watch-control="count"]');
  const nextLink = navigation?.querySelector('[data-watch-control="next"]');
  const latestLink = navigation?.querySelector('[data-watch-control="latest"]');
  const revisionUrl = (value) => '/?revision=' + encodeURIComponent(value);
  const canonicalUrl = revisionUrl(revision) + window.location.hash;
  if (window.location.pathname + window.location.search + window.location.hash !== canonicalUrl) {
    history.replaceState(null, '', canonicalUrl);
  }
  const setLink = (link, target) => {
    if (!link) return;
    if (target === undefined) {
      link.removeAttribute('href');
      link.setAttribute('aria-disabled', 'true');
      link.tabIndex = -1;
      return;
    }
    link.setAttribute('href', revisionUrl(target));
    link.setAttribute('aria-disabled', 'false');
    link.tabIndex = 0;
  };
  const updateNavigation = (nextRevisions, hasNewResponse) => {
    revisions = nextRevisions.map(String);
    const currentIndex = revisions.indexOf(revision);
    const latestRevision = revisions[revisions.length - 1];
    if (currentIndex < 0) {
      setLink(previousLink, undefined);
      setLink(nextLink, revisions[0]);
      if (countLabel) countLabel.textContent = 'History expired';
    } else {
      setLink(previousLink, revisions[currentIndex - 1]);
      setLink(nextLink, revisions[currentIndex + 1]);
      if (countLabel) countLabel.textContent = (currentIndex + 1) + ' of ' + revisions.length;
    }
    setLink(latestLink, revision === latestRevision ? undefined : latestRevision);
    if (latestLink) {
      latestLink.textContent = hasNewResponse && revision !== latestRevision ? 'Latest (new)' : 'Latest';
      latestLink.classList.toggle('pi-markdown-preview-watch-new', hasNewResponse && revision !== latestRevision);
    }
  };
  const initialLatestRevision = revisions[revisions.length - 1] || revision;
  const events = new EventSource(${JSON.stringify(`${EVENTS_PATH}?revision=`)} + encodeURIComponent(revision) + '&latest=' + encodeURIComponent(initialLatestRevision));
  let navigating = false;
  events.addEventListener('reload', (event) => {
    let state;
    try { state = JSON.parse(event.data); } catch { return; }
    if (!state || !Array.isArray(state.revisions) || state.revisions.length === 0) return;
    const nextRevisions = state.revisions.map(String);
    const nextLatestRevision = nextRevisions[nextRevisions.length - 1];
    if (nextLatestRevision === revision) {
      updateNavigation(nextRevisions, false);
      return;
    }
    if (followingLatest && !navigating) {
      navigating = true;
      events.close();
      if (nextRevisions.includes(revision)) window.location.assign(revisionUrl(nextLatestRevision));
      else window.location.replace(revisionUrl(nextLatestRevision));
      return;
    }
    updateNavigation(nextRevisions, true);
  });
  events.addEventListener('stopped', () => events.close());
  window.addEventListener('pagehide', () => events.close(), { once: true });
  window.addEventListener('pageshow', (event) => { if (event.persisted) window.location.reload(); });
})();
</script>`;

	const watchUi = `${watchNavigation}\n${watchScript}`;
	const completeHtml = /<\/body>/i.test(watchedHtml)
		? watchedHtml.replace(/<\/body>/i, `${watchUi}\n</body>`)
		: `${watchedHtml}\n${watchUi}`;
	return scriptNonce
		? completeHtml.replace(/<script(?=[\s>])/gi, `<script nonce="${scriptNonce}"`)
		: completeHtml;
}

/**
 * @param {string} rootPath
 * @param {string} requestedPath
 */
export async function resolveBrowserWatchResource(rootPath, requestedPath) {
	let decodedPath;
	try {
		decodedPath = decodeURIComponent(requestedPath);
	} catch {
		return undefined;
	}
	if (!decodedPath || decodedPath.includes("\0")) return undefined;

	const root = await realpath(rootPath).catch(() => undefined);
	if (!root) return undefined;
	const candidate = await realpath(resolve(root, decodedPath.replace(/^[/\\]+/, ""))).catch(() => undefined);
	if (!candidate) return undefined;

	const relativePath = relative(root, candidate);
	if (relativePath === ".." || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relativePath)) {
		return undefined;
	}

	const fileStat = await stat(candidate).catch(() => undefined);
	if (!fileStat?.isFile()) return undefined;
	return candidate;
}

/**
 * Start the local-only server used by completion-level browser watch mode.
 *
 * @param {string} initialHtml
 * @param {string} resourceRoot
 * @param {{ historyLimit?: number, initialDocumentIsResponse?: boolean }} [options]
 */
export async function createBrowserWatchServer(initialHtml, resourceRoot, options = {}) {
	const token = randomBytes(24).toString("base64url");
	const resolvedResourceRoot = await realpath(resourceRoot);
	const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
	if (!Number.isInteger(historyLimit) || historyLimit < 1) {
		throw new Error("Browser preview watch history limit must be a positive integer.");
	}
	/** @type {Set<import("node:http").ServerResponse>} */
	const eventClients = new Set();
	const buildDocument = (documentRevision, html) => {
		const absoluteImages = new Map();
		const rewrittenHtml = rewriteBrowserWatchAbsoluteImageSources(html, (absolutePath, contentType) => {
			const imageId = createHmac("sha256", token)
				.update("absolute-image\0")
				.update(absolutePath)
				.digest("hex");
			absoluteImages.set(imageId, { path: absolutePath, contentType });
			return `${ABSOLUTE_IMAGE_PREFIX}${imageId}`;
		});
		return { revision: documentRevision, html: rewrittenHtml, absoluteImages };
	};
	let documents = [buildDocument(1, initialHtml)];
	let revision = 1;
	let hasResponseDocument = options.initialDocumentIsResponse !== false;
	let port = 0;
	let closed = false;
	let cookieName = "";

	const getRevisionState = () => ({
		revision: documents[documents.length - 1].revision,
		revisions: documents.map((document) => document.revision),
	});

	/** @param {import("node:http").ServerResponse} client */
	const sendRevisionState = (client) => {
		client.write(`event: reload\ndata: ${JSON.stringify(getRevisionState())}\n\n`);
	};

	/** @param {import("node:http").IncomingMessage} req */
	const hasWatchCookie = (req) => {
		const expected = `${cookieName}=${token}`;
		return (req.headers.cookie ?? "").split(";").some((part) => part.trim() === expected);
	};

	/** @param {import("node:http").ServerResponse} res @param {number} status @param {string} message */
	const respondText = (res, status, message) => {
		res.writeHead(status, {
			...NON_HTML_SECURITY_HEADERS,
			"Content-Type": "text/plain; charset=utf-8",
		});
		res.end(message);
	};

	/** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
	const handleRequest = async (req, res) => {
		const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
		const method = req.method ?? "GET";
		if (method !== "GET" && method !== "HEAD") {
			respondText(res, 405, "Method not allowed");
			return;
		}

		if (requestUrl.pathname === "/") {
			const queryToken = requestUrl.searchParams.get("token") ?? "";
			if (queryToken !== token && !hasWatchCookie(req)) {
				respondText(res, 403, "Invalid or expired preview watch token. Re-run /preview-browser --watch.");
				return;
			}

			const requestedRevisionRaw = requestUrl.searchParams.get("revision");
			const requestedRevision = requestedRevisionRaw === null ? undefined : Number(requestedRevisionRaw);
			let documentIndex = documents.length - 1;
			if (Number.isInteger(requestedRevision)) {
				const exactIndex = documents.findIndex((document) => document.revision === requestedRevision);
				const nearestIndex = documents.findIndex((document) => document.revision >= requestedRevision);
				documentIndex = exactIndex >= 0 ? exactIndex : nearestIndex >= 0 ? nearestIndex : documents.length - 1;
			}
			const selectedDocument = documents[documentIndex];
			const scriptNonce = randomBytes(18).toString("base64url");
			const html = prepareBrowserWatchHtml(selectedDocument.html, {
				revision: selectedDocument.revision,
				revisions: documents.map((document) => document.revision),
				isWaiting: !hasResponseDocument,
			}, scriptNonce);
			res.writeHead(200, {
				...getHtmlSecurityHeaders(scriptNonce),
				"Content-Type": "text/html; charset=utf-8",
				...(queryToken === token
					? { "Set-Cookie": `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/` }
					: {}),
			});
			res.end(method === "HEAD" ? undefined : html);
			return;
		}

		if (!hasWatchCookie(req)) {
			respondText(res, 403, "Invalid or expired preview watch token.");
			return;
		}

		if (requestUrl.pathname === EVENTS_PATH) {
			if (method === "HEAD") {
				res.writeHead(405, NON_HTML_SECURITY_HEADERS);
				res.end();
				return;
			}
			res.writeHead(200, {
				...NON_HTML_SECURITY_HEADERS,
				"Content-Type": "text/event-stream; charset=utf-8",
				Connection: "keep-alive",
			});
			res.write(": connected\n\n");
			eventClients.add(res);
			const removeClient = () => eventClients.delete(res);
			req.once("close", removeClient);
			res.once("close", removeClient);

			const clientLatestRevision = Number(requestUrl.searchParams.get("latest"));
			if (!Number.isInteger(clientLatestRevision) || clientLatestRevision !== documents[documents.length - 1].revision) {
				sendRevisionState(res);
			}
			return;
		}

		let resourcePath;
		let contentType;
		if (requestUrl.pathname.startsWith(ABSOLUTE_IMAGE_PREFIX)) {
			const imageId = requestUrl.pathname.slice(ABSOLUTE_IMAGE_PREFIX.length);
			let allowedImage;
			if (/^[a-f\d]{64}$/.test(imageId)) {
				for (let index = documents.length - 1; index >= 0; index--) {
					allowedImage = documents[index].absoluteImages.get(imageId);
					if (allowedImage) break;
				}
			}
			resourcePath = allowedImage ? await realpath(allowedImage.path).catch(() => undefined) : undefined;
			contentType = allowedImage?.contentType;
		} else {
			const requestedResourcePath = requestUrl.pathname.startsWith(RESOURCE_PREFIX)
				? requestUrl.pathname.slice(RESOURCE_PREFIX.length)
				: requestUrl.pathname.slice(1);
			resourcePath = await resolveBrowserWatchResource(resolvedResourceRoot, requestedResourcePath);
			contentType = resourcePath ? RESOURCE_CONTENT_TYPES.get(extname(resourcePath).toLowerCase()) : undefined;
		}
		if (!resourcePath) {
			respondText(res, 404, "Preview resource not found.");
			return;
		}
		if (!contentType) {
			respondText(res, 415, "Unsupported preview resource type.");
			return;
		}
		const resourceStat = await stat(resourcePath).catch(() => undefined);
		if (!resourceStat?.isFile()) {
			respondText(res, 404, "Preview resource not found.");
			return;
		}
		res.writeHead(200, {
			"Cache-Control": "no-store",
			"Content-Length": String(resourceStat.size),
			"Content-Security-Policy": "default-src 'none'; sandbox",
			"Content-Type": contentType,
			"Cross-Origin-Resource-Policy": "same-origin",
			"X-Content-Type-Options": "nosniff",
		});
		if (method === "HEAD") {
			res.end();
			return;
		}
		const stream = createReadStream(resourcePath);
		stream.once("error", () => res.destroy());
		stream.pipe(res);
	};

	const server = createServer((req, res) => {
		void handleRequest(req, res).catch((error) => {
			if (res.headersSent) {
				res.destroy(error instanceof Error ? error : undefined);
				return;
			}
			respondText(res, 500, "Preview watch server error.");
		});
	});

	await new Promise((resolvePromise, rejectPromise) => {
		const onError = (error) => {
			server.off("listening", onListening);
			rejectPromise(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolvePromise();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(0, "127.0.0.1");
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Failed to determine browser preview watch port.");
	}
	port = address.port;
	cookieName = `pi_markdown_preview_watch_${port}`;

	return {
		get url() {
			return `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
		},
		get revision() {
			return documents[documents.length - 1].revision;
		},
		get revisions() {
			return documents.map((document) => document.revision);
		},
		get historySize() {
			return documents.length;
		},
		updateDocument(html, { appendToHistory = true } = {}) {
			if (closed) return documents[documents.length - 1].revision;
			revision += 1;
			const nextDocument = buildDocument(revision, html);
			if (appendToHistory && hasResponseDocument) {
				documents.push(nextDocument);
			} else {
				documents[documents.length - 1] = nextDocument;
			}
			if (appendToHistory) hasResponseDocument = true;
			if (documents.length > historyLimit) documents = documents.slice(-historyLimit);
			for (const client of eventClients) {
				if (client.writableEnded || client.destroyed) {
					eventClients.delete(client);
					continue;
				}
				sendRevisionState(client);
			}
			return revision;
		},
		async close() {
			if (closed) return;
			closed = true;
			for (const client of eventClients) {
				if (!client.writableEnded && !client.destroyed) {
					client.write("event: stopped\ndata: stopped\n\n");
					client.end();
				}
			}
			eventClients.clear();
			await new Promise((resolvePromise) => {
				server.close(() => resolvePromise());
				server.closeAllConnections?.();
			});
		},
	};
}
