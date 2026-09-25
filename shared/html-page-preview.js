import { randomBytes, createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { sendBrowserFile } from "./browser-file-response.js";

const ASSETS = new Map(Object.entries({
	".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
	".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".wasm": "application/wasm",
}));
const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
export const isHtmlPagePath = path => /\.html?$/i.test(path);

/** Trusted outer shell; authored HTML is NEVER inserted into this origin's DOM. */
export function buildHtmlPagePreview(url, title, source) {
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>
*{box-sizing:border-box}html,body{margin:0;height:100%;font:15px system-ui;background:#fff;color:#222}main{height:100%;display:flex;flex-direction:column}header{padding:16px;padding-right:min(240px,65vw);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;background:#f5f6f8;border-bottom:1px solid #ddd}details{max-height:100%;overflow:auto}summary{cursor:pointer;padding:8px 16px}@media(pointer:coarse){header{padding-top:22px;padding-bottom:22px;min-height:64px}summary{min-height:44px}}pre{margin:0;padding:16px;white-space:pre;overflow:auto}details[open]{flex:1;min-height:0}details[open] .source-label,details:not([open]) .page-label{display:none}iframe{width:100%;flex:1;min-height:0;border:0}details[open]+iframe{display:none}</style></head><body><main id="preview-root"><header>${escape(title)} · isolated HTML page</header><details><summary><span class="source-label">View source</span><span class="page-label">View page</span></summary><pre><code>${escape(source)}</code></pre></details><iframe title="${escape(title)}" sandbox="allow-scripts allow-popups" referrerpolicy="no-referrer" src="${escape(url)}"></iframe></main><script>window.__mermaidDone=true;</script></body></html>`;
}

/**
 * Separate loopback origin with independent, per-document capabilities. No
 * session cookies or response APIs. HTML is sandboxed even if opened directly;
 * relative assets are restricted to its directory and an explicit type list.
 */
export async function createHtmlPageServer(parentOrigin) {
	const mounts = new Map();
	let origin = "", closed = false;
	const common = {
		"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
		"Permissions-Policy": "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()",
		// Opaque sandbox origins need CORS for JS modules/fonts/fetching assets.
		// The unguessable path capability, not a cookie, authorizes these reads.
		"Access-Control-Allow-Origin": "*",
	};
	const server = createServer(async (req, res) => {
		const text = (status, message) => { res.writeHead(status, { ...common, "Content-Type": "text/plain; charset=utf-8", "Content-Security-Policy": "default-src 'none'; sandbox" }); res.end(req.method === "HEAD" ? undefined : message); };
		try {
			if (closed || req.headers.host !== new URL(origin).host) return text(403, "Unavailable HTML preview.");
			if (!["GET", "HEAD"].includes(req.method || "GET")) return text(405, "Method not allowed.");
			const url = new URL(req.url || "/", origin);
			if (url.origin !== origin) return text(403, "Forbidden origin.");
			const match = /^\/([A-Za-z0-9_-]{32})\/(.*)$/.exec(url.pathname);
			const mount = match && mounts.get(match[1]);
			if (!mount) return text(404, "HTML preview expired or unavailable.");
			let name;
			try { name = decodeURIComponent(match[2] || mount.filename); } catch { return text(400, "Invalid path."); }
			if (name.includes("\0") || name.split(/[\\/]/).some(part => part.startsWith("."))) return text(403, "Asset is outside the preview scope.");
			// The selected document is a retained snapshot, even if its file was
			// subsequently deleted. Assets still require canonical containment.
			const path = name === mount.filename ? resolve(mount.root, name) : await realpath(resolve(mount.root, name));
			const rel = relative(mount.root, path);
			if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return text(403, "Asset is outside the preview scope.");
			if (name === mount.filename) {
				const content = mount.html;
				const policy = ["sandbox allow-scripts allow-popups", "default-src 'none'", `script-src 'unsafe-inline' 'wasm-unsafe-eval' ${origin} https: blob:`, `style-src 'unsafe-inline' ${origin} https:`, `img-src ${origin} https: data: blob:`, `font-src ${origin} https: data:`, `connect-src ${origin} https:`, "object-src 'none'", "frame-src 'none'", "form-action 'none'", `base-uri ${origin}`, `frame-ancestors ${parentOrigin}`].join("; ");
				res.writeHead(200, { ...common, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": policy, "Content-Length": Buffer.byteLength(content) });
				res.end(req.method === "HEAD" ? undefined : content);
				return;
			}
			const type = ASSETS.get(extname(path).toLowerCase());
			if (!type) return text(415, "Only the selected HTML page and supported browser assets are served here.");
			await sendBrowserFile(req, res, path, type, { ...common, "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
		} catch (error) {
			if (!res.headersSent && !res.destroyed) text([413, 415].includes(error?.statusCode) ? error.statusCode : 404, "HTML page or asset is unavailable.");
			else res.destroy();
		}
	});
	await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
	origin = `http://127.0.0.1:${server.address().port}`;
	return {
		origin,
		async register(path, html) {
			if (closed) throw new Error("HTML preview is closed.");
			if (Buffer.byteLength(html) > 2 * 1024 * 1024) throw Object.assign(new Error("HTML preview exceeds 2 MiB."), { statusCode: 413 });
			const canonical = await realpath(path).catch(() => resolve(path));
			if (!isHtmlPagePath(canonical)) throw Object.assign(new Error("Not an HTML file."), { statusCode: 415 });
			if (closed) throw new Error("HTML preview is closed.");
			const key = createHash("sha256").update(canonical).update("\0").update(html).digest("hex");
			for (const [capability, mount] of mounts) if (mount.key === key) return `${origin}/${capability}/${encodeURIComponent(mount.filename)}`;
			const capability = randomBytes(24).toString("base64url");
			mounts.set(capability, { key, root: dirname(canonical), filename: basename(canonical), html });
			let bytes = [...mounts.values()].reduce((sum, value) => sum + Buffer.byteLength(value.html), 0);
			while (mounts.size > 20 || (mounts.size > 1 && bytes > 32 * 1024 * 1024)) {
				const oldest = mounts.keys().next().value;
				bytes -= Buffer.byteLength(mounts.get(oldest).html); mounts.delete(oldest);
			}
			return `${origin}/${capability}/${encodeURIComponent(basename(canonical))}`;
		},
		async close() {
			if (closed) return;
			closed = true; mounts.clear();
			await new Promise(done => {
				if (process.versions.bun) server.closeAllConnections?.();
				server.close(() => done()); server.closeAllConnections?.();
			});
		},
	};
}
