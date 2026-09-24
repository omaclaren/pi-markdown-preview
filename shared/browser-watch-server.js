import { createHmac, randomBytes } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, posix as posixPath, relative, resolve, win32 as win32Path } from "node:path";
import { fileURLToPath } from "node:url";

const EVENTS_PATH = "/__pi_markdown_preview_events__";
const SHARE_PATH = "/__pi_markdown_preview_share__";
const RESOURCE_PREFIX = "/__pi_markdown_preview_resource__/";
const ABSOLUTE_IMAGE_PREFIX = "/__pi_markdown_preview_absolute_image__/";
const BASE_TAG_PATTERN = /<base\s+href=(?:"[^"]*"|'[^']*')\s*\/?>/i;
const READING_POSITION_SOURCE = readFileSync(new URL("../client/watch-reading-position.js", import.meta.url), "utf8").replace(/<\/script/gi, "<\\/script");
const WATCH_CONTROLS_STYLE = readFileSync(new URL("../client/watch-controls.css", import.meta.url), "utf8");
const DEFAULT_HISTORY_LIMIT = 20;
const DEFAULT_HISTORY_BYTE_LIMIT = 32 * 1024 * 1024;

function escapeBrowserWatchHtmlText(value) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function escapeBrowserWatchHtmlAttribute(value) {
	return escapeBrowserWatchHtmlText(value)
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

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
			if (windowsPath.includes("\0") || windowsPath.startsWith("\\\\") || !/^[a-zA-Z]:[\\/]/.test(windowsPath)) return undefined;
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
		if (pathSource.startsWith("\\\\") || !/^[a-zA-Z]:[\\/]/.test(pathSource)) return undefined;
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

/**
 * Resolve an explicitly referenced local media source against the preview's
 * resource directory. Unlike the general resource route, this may resolve a
 * parent-relative path because only its opaque HMAC route is exposed.
 *
 * @param {string} source
 * @param {string} resourceRoot
 * @param {NodeJS.Platform} [platform]
 */
export function getBrowserWatchLocalMediaPath(source, resourceRoot, platform = process.platform) {
	const absolutePath = getBrowserWatchAbsoluteImagePath(source, platform);
	if (absolutePath) return absolutePath;

	const decodedSource = decodeHtmlImageSource(source.trim());
	if (!decodedSource || decodedSource.includes("\0") || decodedSource.startsWith("//") || decodedSource.startsWith("\\\\")) return undefined;
	if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(decodedSource)) return undefined;

	let pathSource = decodedSource.split(/[?#]/, 1)[0];
	try {
		pathSource = decodeURIComponent(pathSource);
	} catch {
		return undefined;
	}
	if (!pathSource || pathSource.includes("\0") || pathSource.startsWith("//") || pathSource.startsWith("\\\\")) return undefined;
	if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(pathSource) && !/^[a-zA-Z]:[\\/]/.test(pathSource)) return undefined;

	const pathApi = platform === "win32" ? win32Path : posixPath;
	if (!pathApi.isAbsolute(resourceRoot)) return undefined;
	if (platform === "win32") {
		pathSource = pathSource.replace(/\//g, "\\");
		if (pathSource.startsWith("\\\\")) return undefined;
	}
	return pathApi.normalize(pathApi.resolve(resourceRoot, pathSource));
}

/**
 * Rewrite exact local image and Pandoc PDF-embed references to opaque,
 * authenticated routes. Network/data sources and unsupported media types are
 * left unchanged.
 *
 * @param {string} html
 * @param {string} resourceRoot
 * @param {(absolutePath: string, contentType: string) => string} routeForMedia
 * @param {NodeJS.Platform} [platform]
 */
export function rewriteBrowserWatchLocalMediaSources(html, resourceRoot, routeForMedia, platform = process.platform) {
	return html.replace(/(<(img|embed)\b[^>]*?\s+src\s*=\s*)(["'])([^"']*)\3/gi, (match, prefix, tagName, quote, source) => {
		const absolutePath = getBrowserWatchLocalMediaPath(source, resourceRoot, platform);
		if (!absolutePath) return match;
		const extension = extname(absolutePath).toLowerCase();
		const contentType = String(tagName).toLowerCase() === "embed"
			? (extension === ".pdf" ? "application/pdf" : undefined)
			: RESOURCE_CONTENT_TYPES.get(extension);
		if (!contentType) return match;
		const decodedSource = decodeHtmlImageSource(String(source));
		const suffixIndex = decodedSource.search(/[?#]/);
		const suffix = suffixIndex < 0 ? "" : escapeBrowserWatchHtmlAttribute(decodedSource.slice(suffixIndex));
		return `${prefix}${quote}${routeForMedia(absolutePath, contentType)}${suffix}${quote}`;
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
			"frame-src 'self'",
			"img-src 'self' data: http: https:",
			"object-src 'self'",
			`script-src 'nonce-${scriptNonce}' 'strict-dynamic' 'wasm-unsafe-eval' https://cdn.jsdelivr.net`,
			"style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
			"worker-src 'self' blob: https://cdn.jsdelivr.net",
		].join("; "),
	};
}

/**
 * Add bounded-response navigation and completion notifications to a canonical
 * preview document.
 *
 * @param {string} html
 * @param {{ revision: number, revisions: number[], isWaiting?: boolean, sourceLabel?: string, wrapScope?: string, preserveReadingPosition?: boolean }} navigation
 * @param {string} [scriptNonce]
 */
export function prepareBrowserWatchHtml(html, navigation, scriptNonce) {
	let watchedHtml = BASE_TAG_PATTERN.test(html) ? html.replace(BASE_TAG_PATTERN, "") : html;
	if (!/<link\s+[^>]*rel=(?:"icon"|'icon')[^>]*>/i.test(watchedHtml)) {
		watchedHtml = watchedHtml.replace(/<\/head>/i, '<link rel="icon" href="data:," />\n</head>');
	}

	if (navigation.wrapScope) {
		const wrapScopeMeta = `<meta name="pi-markdown-preview-wrap-scope" content="${escapeBrowserWatchHtmlAttribute(navigation.wrapScope)}" />`;
		watchedHtml = /<\/head>/i.test(watchedHtml)
			? watchedHtml.replace(/<\/head>/i, `${wrapScopeMeta}\n</head>`)
			: `${wrapScopeMeta}\n${watchedHtml}`;
	}

	const preserveReadingPosition = navigation.preserveReadingPosition === true && Boolean(navigation.wrapScope);
	const revision = String(navigation.revision);
	const revisions = navigation.revisions.map(String);
	const isWaiting = navigation.isWaiting === true;
	const sourceLabel = navigation.sourceLabel?.trim();
	if (sourceLabel) {
		const escapedTitle = escapeBrowserWatchHtmlText(`${sourceLabel} — ${navigation.titleSuffix || "Markdown Preview"}`);
		watchedHtml = /<title\b[^>]*>[\s\S]*?<\/title>/i.test(watchedHtml)
			? watchedHtml.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, `<title>${escapedTitle}</title>`)
			: watchedHtml.replace(/<\/head>/i, `<title>${escapedTitle}</title>\n</head>`);
	}
	const currentIndex = Math.max(0, revisions.indexOf(revision));
	const previousRevision = revisions[currentIndex - 1];
	const nextRevision = revisions[currentIndex + 1];
	const latestRevision = revisions[revisions.length - 1] ?? revision;
	const linkAttributes = (targetRevision) => targetRevision === undefined
		? 'aria-disabled="true" tabindex="-1"'
		: `href="/?revision=${encodeURIComponent(targetRevision)}" aria-disabled="false" tabindex="0"`;

	const watchStyle = `<style id="pi-markdown-preview-watch-style">${WATCH_CONTROLS_STYLE}</style>`;
	watchedHtml = /<\/head>/i.test(watchedHtml)
		? watchedHtml.replace(/<\/head>/i, `${watchStyle}\n</head>`)
		: `${watchStyle}\n${watchedHtml}`;

	const sourceControl = sourceLabel
		? `<span id="pi-markdown-preview-watch-source" data-watch-control="source" title="${escapeBrowserWatchHtmlAttribute(sourceLabel)}">${escapeBrowserWatchHtmlText(sourceLabel)}</span>`
		: "";
	const watchNavigation = `<nav id="pi-markdown-preview-watch-nav" aria-label="Preview controls">
  <span id="pi-markdown-preview-watch-status" data-watch-control="status" role="status" hidden></span>
  <button id="pi-markdown-preview-watch-copy-link" data-watch-control="copy-link" type="button" title="Copy an authenticated link for another browser">Copy link</button>
  <button id="pi-markdown-preview-watch-toggle" data-watch-control="toggle" type="button" aria-expanded="false" aria-controls="pi-markdown-preview-watch-controls" aria-label="${isWaiting ? "Preview controls, waiting for a response" : `Preview controls, revision ${currentIndex + 1} of ${revisions.length}`}" title="Show preview controls">
    <span>Preview ·</span>
    <span id="pi-markdown-preview-watch-count" data-watch-control="count" aria-live="polite">${isWaiting ? "Waiting" : `${currentIndex + 1}/${revisions.length}`}</span>
    <span id="pi-markdown-preview-watch-new" data-watch-control="new" hidden>New</span>
    <span class="pi-preview-watch-chevron" aria-hidden="true">▾</span>
  </button>
  <div id="pi-markdown-preview-watch-controls" data-watch-control="controls" role="group" aria-label="Preview history and wrapping" hidden>
    ${sourceControl}
    <div class="pi-preview-watch-actions">
      <a id="pi-markdown-preview-watch-previous" data-watch-control="previous" title="Previous revision (Option/Alt+Left; add Shift for the oldest)" aria-keyshortcuts="Alt+ArrowLeft" ${linkAttributes(isWaiting ? undefined : previousRevision)}>← Previous</a>
      <a id="pi-markdown-preview-watch-next" data-watch-control="next" title="Next revision (Option/Alt+Right)" aria-keyshortcuts="Alt+ArrowRight" ${linkAttributes(isWaiting ? undefined : nextRevision)}>Next →</a>
      <a id="pi-markdown-preview-watch-latest" data-watch-control="latest" title="Latest revision (Option/Alt+Shift+Right)" aria-keyshortcuts="Alt+Shift+ArrowRight" ${linkAttributes(isWaiting || revision === latestRevision ? undefined : latestRevision)}>Latest</a>
      <button data-watch-control="wrap-code" type="button" hidden></button>
    </div>
  </div>
  <div id="pi-markdown-preview-watch-share-panel" data-watch-control="share-panel" role="dialog" aria-label="Transferable preview link" hidden>
    <span>Copy this link:</span>
    <input data-watch-control="share-input" aria-label="Authenticated preview link" readonly />
    <button data-watch-control="share-close" type="button">Close</button>
  </div>
</nav>`;

	const watchScript = `<script>
(() => {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  if (!window.location.hash) window.scrollTo(0, 0);
  const readingPosition = ${preserveReadingPosition ? `window.PiMarkdownPreviewReadingPosition.install(document.getElementById('preview-root'), ${JSON.stringify(navigation.wrapScope)})` : "undefined"};
  const revision = ${JSON.stringify(revision)};
  let revisions = ${JSON.stringify(revisions)};
  // Identifies this server run: revision numbers restart when a server does.
  const instance = ${JSON.stringify(String(navigation.instance ?? ""))};
  const followingLatest = revision === revisions[revisions.length - 1];
  const navigation = document.currentScript?.previousElementSibling;
  // Measure only the compact bar. Absolutely positioned panels never reserve
  // document space or move the bar; narrow/touch layouts still need clearance.
  const updateNavigationHeight = () => {
    if (navigation) document.documentElement.style.setProperty('--pi-preview-watch-nav-height', Math.ceil(navigation.getBoundingClientRect().height) + 'px');
  };
  const navigationResizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(updateNavigationHeight) : null;
  if (navigation) navigationResizeObserver?.observe(navigation);
  updateNavigationHeight();
  window.addEventListener('resize', updateNavigationHeight);
  window.addEventListener('load', updateNavigationHeight, { once: true });
  const previousLink = navigation?.querySelector('[data-watch-control="previous"]');
  const countLabel = navigation?.querySelector('[data-watch-control="count"]');
  const nextLink = navigation?.querySelector('[data-watch-control="next"]');
  const latestLink = navigation?.querySelector('[data-watch-control="latest"]');
  const copyLinkButton = navigation?.querySelector('[data-watch-control="copy-link"]');
  const sharePanel = navigation?.querySelector('[data-watch-control="share-panel"]');
  const shareInput = navigation?.querySelector('[data-watch-control="share-input"]');
  const shareCloseButton = navigation?.querySelector('[data-watch-control="share-close"]');
  const controlsToggle = navigation?.querySelector('[data-watch-control="toggle"]');
  const controlsPanel = navigation?.querySelector('[data-watch-control="controls"]');
  const newBadge = navigation?.querySelector('[data-watch-control="new"]');
  // One-shot, tab-local handoff across this watcher's document navigations.
  // Never carry the sharing dialog or authenticated URLs into saved UI state.
  const controlsStateKey = ${navigation.wrapScope ? JSON.stringify("pi-markdown-preview:watch-controls:" + navigation.wrapScope) : "null"};
  let savedControls;
  try {
    if (controlsStateKey) {
      savedControls = JSON.parse(sessionStorage.getItem(controlsStateKey) || 'null');
      sessionStorage.removeItem(controlsStateKey);
    }
  } catch { /* Storage denial must not break navigation or the controls. */ }
  let navigating = false;
  const pointerFocusAttribute = 'data-watch-restored-pointer-focus';
  let restoredPointerFocus;
  const clearRestoredPointerFocus = () => {
    restoredPointerFocus?.removeAttribute(pointerFocusAttribute);
    restoredPointerFocus = undefined;
  };
  const saveControls = (focusControl, keyboard = false) => {
    if (!controlsStateKey) return;
    try {
      if (controlsPanel && !controlsPanel.hidden) {
        const focused = focusControl || (navigation.contains(document.activeElement) ? document.activeElement : null);
        sessionStorage.setItem(controlsStateKey, JSON.stringify({
          open: true,
          focus: focused?.getAttribute('data-watch-control'),
          focusVisible: keyboard || Boolean(focused?.matches(':focus-visible') && !focused.hasAttribute(pointerFocusAttribute)),
          scrollTop: controlsPanel.scrollTop,
        }));
      } else sessionStorage.removeItem(controlsStateKey);
    } catch {}
  };
  let interactionVersion = 0;
  const openControls = () => {
    if (!controlsPanel || !controlsToggle) return;
    controlsPanel.hidden = false;
    controlsToggle.setAttribute('aria-expanded', 'true');
    controlsToggle.title = 'Hide preview controls';
  };
  const closeControls = () => {
    if (controlsPanel) controlsPanel.hidden = true;
    controlsToggle?.setAttribute('aria-expanded', 'false');
    if (controlsToggle) controlsToggle.title = 'Show preview controls';
  };
  const closeShare = () => {
    if (sharePanel) sharePanel.hidden = true;
    if (shareInput) shareInput.value = '';
  };
  const dismissPanels = (returnFocus = false) => {
    const trigger = sharePanel && !sharePanel.hidden ? copyLinkButton : controlsPanel && !controlsPanel.hidden ? controlsToggle : null;
    interactionVersion += 1;
    closeControls();
    closeShare();
    if (returnFocus) trigger?.focus({ preventScroll: true });
  };
  controlsToggle?.addEventListener('click', () => {
    const open = controlsPanel?.hidden;
    dismissPanels();
    if (open) openControls();
  });
  const onOutsidePointer = (event) => {
    if (!navigation?.contains(event.target)) dismissPanels();
  };
  const onPanelEscape = (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || (controlsPanel?.hidden && sharePanel?.hidden)) return;
    event.preventDefault();
    dismissPanels(true);
  };
  window.addEventListener('pointerdown', onOutsidePointer);
  window.addEventListener('keydown', onPanelEscape);
  navigation?.addEventListener('focusout', () => {
    // A microtask can run before native Tab focus reaches its destination.
    // Defer one task, also allowing the synchronous copy fallback to restore focus.
    window.setTimeout(() => { if (!navigating && !navigation.contains(document.activeElement)) dismissPanels(); }, 0);
  });
  if (savedControls?.open === true) {
    openControls();
    if (savedControls.focus) {
      const control = [previousLink, nextLink, latestLink, controlsToggle].find(element =>
        element?.getAttribute('data-watch-control') === savedControls.focus && element.getAttribute('aria-disabled') !== 'true');
      // A boundary can disable the button just used; keep keyboard access via
      // the trigger instead. preventScroll leaves document restoration alone.
      const target = control || controlsToggle;
      if (target && savedControls.focusVisible === false) {
        // A new document treats programmatic focus as keyboard focus. Retain
        // the tab-order position without inventing a ring after a mouse/touch
        // click. Only this restored control is affected; real keyboard input
        // or blur immediately returns it to the browser's native styling.
        restoredPointerFocus = target;
        target.setAttribute(pointerFocusAttribute, '');
        target.addEventListener('blur', clearRestoredPointerFocus, { once: true });
        window.addEventListener('keydown', clearRestoredPointerFocus, true);
      }
      target?.focus({ preventScroll: true });
    }
    if (controlsPanel && Number.isFinite(savedControls.scrollTop)) controlsPanel.scrollTop = savedControls.scrollTop;
  }
  const revisionUrl = (value) => '/?revision=' + encodeURIComponent(value);
  const latestUrl = () => '/' + window.location.hash;
  const withCurrentHash = (value) => {
    const target = new URL(value, window.location.href);
    target.hash = window.location.hash;
    return target.href;
  };
  const copyWithFallback = (value) => {
    const activeElement = document.activeElement;
    const selection = window.getSelection();
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    try {
      document.body.appendChild(textarea);
      textarea.select();
      return document.execCommand('copy');
    } catch { return false; }
    finally {
      textarea.remove();
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
      if (activeElement?.isConnected && document.activeElement !== activeElement) activeElement.focus({ preventScroll: true });
    }
  };
  const showTransferableLink = (value) => {
    if (!sharePanel || !shareInput) return;
    closeControls();
    shareInput.value = value;
    sharePanel.hidden = false;
    shareInput.focus({ preventScroll: true });
    shareInput.select();
  };
  shareCloseButton?.addEventListener('click', () => dismissPanels(true));
  let copying = false;
  let copyFeedbackTimer;
  copyLinkButton?.addEventListener('click', async () => {
    if (copying) return;
    dismissPanels();
    const copyInteraction = interactionVersion;
    copying = true;
    clearTimeout(copyFeedbackTimer);
    copyLinkButton.textContent = 'Copy link';
    copyLinkButton.setAttribute('aria-disabled', 'true');
    copyLinkButton.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(${JSON.stringify(SHARE_PATH)} + '?revision=' + encodeURIComponent(revision));
      if (!response.ok) throw new Error('Could not create a transferable preview link');
      const transferableUrl = new URL(await response.text());
      transferableUrl.hash = window.location.hash;
      let copied = false;
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(transferableUrl.href);
          copied = true;
        } catch {}
      }
      if (!copied && copyInteraction === interactionVersion) copied = copyWithFallback(transferableUrl.href);
      if (copied) copyLinkButton.textContent = 'Copied';
      else if (copyInteraction === interactionVersion) {
        showTransferableLink(transferableUrl.href);
        copyLinkButton.textContent = 'Select link';
      } else copyLinkButton.textContent = 'Copy failed';
    } catch {
      copyLinkButton.textContent = 'Copy failed';
    } finally {
      copying = false;
      copyLinkButton.removeAttribute('aria-disabled');
      copyLinkButton.removeAttribute('aria-busy');
      copyFeedbackTimer = window.setTimeout(() => { copyLinkButton.textContent = 'Copy link'; }, 1400);
    }
  });
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
      if (countLabel) countLabel.textContent = 'Expired';
    } else {
      setLink(previousLink, revisions[currentIndex - 1]);
      setLink(nextLink, revisions[currentIndex + 1]);
      if (countLabel) countLabel.textContent = (currentIndex + 1) + '/' + revisions.length;
    }
    const hasNewRevision = hasNewResponse && revision !== latestRevision;
    if (newBadge) newBadge.hidden = !hasNewRevision;
    const position = currentIndex < 0 ? 'revision no longer retained' : 'revision ' + (currentIndex + 1) + ' of ' + revisions.length;
    controlsToggle?.setAttribute('aria-label', 'Preview controls, ' + position + (hasNewRevision ? ', new revision available' : ''));
    setLink(latestLink, revision === latestRevision ? undefined : latestRevision);
    if (latestLink) {
      latestLink.textContent = hasNewResponse && revision !== latestRevision ? 'Latest (new)' : 'Latest';
      latestLink.classList.toggle('pi-markdown-preview-watch-new', hasNewResponse && revision !== latestRevision);
    }
  };
  // A server started on a fixed port can come back after a restart, so its
  // pages keep trying to reconnect. Other servers never return once stopped.
  const reconnectAfterStop = ${navigation.reconnectAfterStop === true ? "true" : "false"};
  const statusLine = navigation?.querySelector('[data-watch-control="status"]');
  const setStatus = (text) => {
    if (!statusLine) return;
    statusLine.textContent = text || '';
    statusLine.hidden = !text;
  };
  let events;
  let reconnectTimer;
  let reconnectDelay = 1000;
  const eventsUrl = () => ${JSON.stringify(`${EVENTS_PATH}?revision=`)} + encodeURIComponent(revision) + '&latest=' + encodeURIComponent(revisions[revisions.length - 1] || revision) + '&instance=' + encodeURIComponent(instance);
  const scheduleReconnect = () => {
    if (!reconnectAfterStop || navigating) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connectEvents, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };
  const connectEvents = () => {
    if (navigating) return;
    const source = new EventSource(eventsUrl());
    events = source;
    source.addEventListener('open', () => {
      reconnectDelay = 1000;
      setStatus('');
    });
    source.addEventListener('error', () => {
      if (navigating || events !== source) return;
      // CONNECTING: the browser retries by itself. CLOSED: it has given up.
      if (source.readyState === EventSource.CLOSED) {
        setStatus(reconnectAfterStop ? 'Disconnected · retrying…' : 'Disconnected · this page no longer updates');
        scheduleReconnect();
      } else setStatus('Disconnected · retrying…');
    });
    source.addEventListener('reload', onReload);
    source.addEventListener('stopped', () => {
      source.close();
      if (events !== source) return;
      setStatus(reconnectAfterStop ? 'Preview stopped · reconnects when it restarts' : 'Preview stopped · this page no longer updates');
      scheduleReconnect();
    });
  };
  const navigateTo = (value, replace = false, focusControl, keyboard = false) => {
    if (navigating) return false;
    navigating = true;
    saveControls(focusControl, keyboard);
    readingPosition?.save();
    clearTimeout(reconnectTimer);
    events?.close();
    if (replace) window.location.replace(value);
    else window.location.assign(value);
    return true;
  };
  const navigateToLink = (link, keyboard = false) => {
    const href = link?.getAttribute('href');
    return href ? navigateTo(withCurrentHash(href), false, link, keyboard) : false;
  };
  previousLink?.addEventListener('click', (event) => {
    if (!previousLink.getAttribute('href')) return;
    event.preventDefault();
    navigateToLink(previousLink, event.detail === 0);
  });
  nextLink?.addEventListener('click', (event) => {
    if (!nextLink.getAttribute('href')) return;
    event.preventDefault();
    navigateToLink(nextLink, event.detail === 0);
  });
  latestLink?.addEventListener('click', (event) => {
    if (!latestLink.getAttribute('href')) return;
    event.preventDefault();
    navigateTo(latestUrl(), false, latestLink, event.detail === 0);
  });
  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || !event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    if (event.shiftKey) {
      // Shift jumps to the ends of the retained history.
      if (event.key === 'ArrowRight') {
        if (latestLink?.getAttribute('href')) navigateTo(latestUrl(), false, latestLink, true);
        return;
      }
      const oldest = revisions[0];
      if (oldest !== undefined && oldest !== revision && !${JSON.stringify(isWaiting)}) navigateTo(withCurrentHash(revisionUrl(oldest)), false, previousLink, true);
      return;
    }
    navigateToLink(event.key === 'ArrowLeft' ? previousLink : nextLink, true);
  });
  function onReload(event) {
    let state;
    try { state = JSON.parse(event.data); } catch { return; }
    if (!state || !Array.isArray(state.revisions) || state.revisions.length === 0) return;
    if (state.instance && instance && state.instance !== instance) {
      // A restarted server: this page's revision numbers belong to the old run.
      if (!navigating) navigateTo(latestUrl(), true);
      return;
    }
    const nextRevisions = state.revisions.map(String);
    const nextLatestRevision = nextRevisions[nextRevisions.length - 1];
    if (nextLatestRevision === revision) {
      updateNavigation(nextRevisions, false);
      return;
    }
    if (followingLatest) {
      if (!navigating) navigateTo(latestUrl(), !nextRevisions.includes(revision));
      return;
    }
    updateNavigation(nextRevisions, true);
  }
  connectEvents();
  window.addEventListener('pagehide', () => {
    if (!navigating) saveControls();
    navigating = true;
    clearTimeout(reconnectTimer);
    events?.close();
    navigationResizeObserver?.disconnect();
    window.removeEventListener('resize', updateNavigationHeight);
    window.removeEventListener('pointerdown', onOutsidePointer);
    window.removeEventListener('keydown', onPanelEscape);
    window.removeEventListener('keydown', clearRestoredPointerFocus, true);
    clearTimeout(copyFeedbackTimer);
  }, { once: true });
  window.addEventListener('pageshow', (event) => { if (event.persisted) window.location.reload(); });
})();
</script>`;

	const readingPositionScript = preserveReadingPosition ? `<script>${READING_POSITION_SOURCE}</script>\n` : "";
	const watchUi = `${readingPositionScript}${watchNavigation}\n${watchScript}`;
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
 * Start the local-only server used by response and file browser watch modes.
 *
 * @param {string} initialHtml
 * @param {string} resourceRoot
 * Optional `port` and `token` let a caller restart a watch at the same address:
 * open pages then reconnect by themselves instead of going stale. `port`
 * failing to bind rejects (e.g. EADDRINUSE) so the caller can fall back to 0.
 *
 * @param {{ historyByteLimit?: number, historyLimit?: number, initialDocumentIsHistory?: boolean, sourceLabel?: string, preserveReadingPosition?: boolean, port?: number, token?: string, titleSuffix?: string, expiredHint?: string }} [options]
 */
export async function createBrowserWatchServer(initialHtml, resourceRoot, options = {}) {
	const fixedPort = options.port ?? 0;
	if (!Number.isInteger(fixedPort) || fixedPort < 0 || fixedPort > 65535) {
		throw new Error("Browser preview watch port must be an integer from 0 to 65535.");
	}
	if (options.token !== undefined && (typeof options.token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(options.token))) {
		throw new Error("Browser preview watch token must be 32-256 URL-safe characters.");
	}
	const token = options.token ?? randomBytes(24).toString("base64url");
	// Public UI-state scope, deliberately unrelated to the authentication token:
	// random, or a one-way derivation when a caller reuses a token across restarts
	// (so wrapping and reading-position state survive the restart too).
	const wrapScope = options.token === undefined
		? randomBytes(16).toString("hex")
		: createHmac("sha256", token).update("ui-state-scope").digest("hex").slice(0, 32);
	const instance = randomBytes(8).toString("hex");
	const expiredHint = typeof options.expiredHint === "string" ? options.expiredHint.trim() : "Re-run /preview-browser --watch.";
	const lexicalResourceRoot = resolve(resourceRoot);
	const resolvedResourceRoot = await realpath(lexicalResourceRoot);
	const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
	if (!Number.isInteger(historyLimit) || historyLimit < 1) {
		throw new Error("Browser preview watch history limit must be a positive integer.");
	}
	const historyByteLimit = options.historyByteLimit ?? DEFAULT_HISTORY_BYTE_LIMIT;
	if (!Number.isSafeInteger(historyByteLimit) || historyByteLimit < 1) {
		throw new Error("Browser preview watch history byte limit must be a positive safe integer.");
	}
	/** @type {Set<import("node:http").ServerResponse>} */
	const eventClients = new Set();
	const buildDocument = (documentRevision, html) => {
		const absoluteImages = new Map();
		const rewrittenHtml = rewriteBrowserWatchLocalMediaSources(html, lexicalResourceRoot, (absolutePath, contentType) => {
			const imageId = createHmac("sha256", token)
				.update("absolute-image\0")
				.update(absolutePath)
				.digest("hex");
			absoluteImages.set(imageId, { path: absolutePath, contentType });
			return `${ABSOLUTE_IMAGE_PREFIX}${imageId}`;
		});
		return {
			revision: documentRevision,
			html: rewrittenHtml,
			absoluteImages,
			byteSize: Buffer.byteLength(rewrittenHtml, "utf8"),
		};
	};
	let documents = [buildDocument(1, initialHtml)];
	let historyBytes = documents[0].byteSize;
	const pruneHistory = () => {
		while (documents.length > historyLimit) documents.shift();
		historyBytes = documents.reduce((total, document) => total + document.byteSize, 0);
		while (documents.length > 1 && historyBytes > historyByteLimit) {
			historyBytes -= documents[0].byteSize;
			documents.shift();
		}
	};
	let revision = 1;
	let hasHistoryDocument = options.initialDocumentIsHistory !== false;
	let port = 0;
	let closed = false;
	let cookieName = "";

	const getRevisionState = () => ({
		instance,
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
				respondText(res, 403, `Invalid or expired preview watch token.${expiredHint ? ` ${expiredHint}` : ""}`);
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
				isWaiting: !hasHistoryDocument,
				sourceLabel: options.sourceLabel,
				titleSuffix: options.titleSuffix,
				wrapScope,
				preserveReadingPosition: options.preserveReadingPosition,
				reconnectAfterStop: fixedPort !== 0,
				instance,
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

		if (requestUrl.pathname === SHARE_PATH) {
			const requestedRevision = Number(requestUrl.searchParams.get("revision"));
			const selectedRevision = Number.isInteger(requestedRevision)
				&& documents.some((document) => document.revision === requestedRevision)
				? requestedRevision
				: documents[documents.length - 1].revision;
			const transferableUrl = new URL(`http://127.0.0.1:${port}/`);
			transferableUrl.searchParams.set("token", token);
			transferableUrl.searchParams.set("revision", String(selectedRevision));
			res.writeHead(200, {
				...NON_HTML_SECURITY_HEADERS,
				"Content-Type": "text/plain; charset=utf-8",
			});
			res.end(method === "HEAD" ? undefined : transferableUrl.href);
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
			// Reconnect promptly after a restart on the same port.
			res.write("retry: 1500\n\n");
			eventClients.add(res);
			const removeClient = () => eventClients.delete(res);
			req.once("close", removeClient);
			res.once("close", removeClient);

			const clientLatestRevision = Number(requestUrl.searchParams.get("latest"));
			if (!Number.isInteger(clientLatestRevision) || clientLatestRevision !== documents[documents.length - 1].revision
				|| requestUrl.searchParams.get("instance") !== instance) {
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
		if (req.aborted || res.destroyed || res.writableEnded) return;
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
		if (req.aborted || res.destroyed || res.writableEnded) return;
		const stream = createReadStream(resourcePath);
		const destroyStream = () => {
			if (!stream.destroyed) stream.destroy();
		};
		const removeStreamAbortListeners = () => {
			req.off("aborted", destroyStream);
			res.off("close", destroyStream);
		};
		req.once("aborted", destroyStream);
		res.once("close", destroyStream);
		stream.once("close", removeStreamAbortListeners);
		stream.once("error", () => {
			removeStreamAbortListeners();
			res.destroy();
		});
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
		server.listen(fixedPort, "127.0.0.1");
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
		get historyBytes() {
			return historyBytes;
		},
		updateDocument(html, { appendToHistory = true } = {}) {
			if (closed) return documents[documents.length - 1].revision;
			revision += 1;
			const nextDocument = buildDocument(revision, html);
			if (appendToHistory && hasHistoryDocument) {
				documents.push(nextDocument);
			} else {
				documents[documents.length - 1] = nextDocument;
			}
			if (appendToHistory) hasHistoryDocument = true;
			pruneHistory();
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
