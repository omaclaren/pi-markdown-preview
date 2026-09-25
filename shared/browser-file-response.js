import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";

/** Stream a caller-authorized file, including single byte ranges for native PDF/media viewers. */
export async function sendBrowserFile(req, res, path, contentType, headers = {}) {
	const info = await stat(path);
	if (!info.isFile()) { res.writeHead(404, headers); res.end(); return; }
	if (req.aborted || res.destroyed) return;
	let start = 0, end = info.size - 1, partial = false;
	if (req.method !== "HEAD" && req.headers.range) {
		const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range.trim());
		if (range && (range[1] || range[2])) {
			start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
			end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
			if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start < 0 || start >= info.size) {
				res.writeHead(416, { ...headers, "Content-Range": `bytes */${info.size}` }); res.end(); return;
			}
			partial = true;
		}
	}
	const fallbackName = basename(path).replace(/[^\x20-\x7e]|["\\]/g, "_");
	const filename = encodeURIComponent(basename(path)).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
	res.writeHead(partial ? 206 : 200, {
		...headers, "Content-Type": contentType, "Accept-Ranges": "bytes",
		"Content-Disposition": `inline; filename="${fallbackName}"; filename*=UTF-8''${filename}`,
		"Content-Length": partial ? end - start + 1 : info.size,
		...(partial ? { "Content-Range": `bytes ${start}-${end}/${info.size}` } : {}),
	});
	if (req.method === "HEAD" || info.size === 0) { res.end(); return; }
	const stream = createReadStream(path, partial ? { start, end } : undefined);
	const abort = () => stream.destroy();
	req.once("aborted", abort);
	res.once("close", abort);
	stream.once("close", () => { req.off("aborted", abort); res.off("close", abort); });
	stream.once("error", () => res.destroy());
	stream.pipe(res);
}
