import { readFileSync } from "node:fs";

const SCRIPT = readFileSync(new URL("../client/local-path-controls.js", import.meta.url), "utf8").replace(/<\/script/gi, "<\\/script");
const STYLE = readFileSync(new URL("../client/local-path-controls.css", import.meta.url), "utf8");
const scriptJson = value => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/** Attach only server-authorized path metadata to cookie-protected pages.
 * URLs remain opaque browser routes; this adds no filesystem lookup endpoint.
 * @param {string} html
 * @param {Map<string, string>} paths Route pathname -> resolved authored path.
 * @param {string} [pagePath] The linked file itself, without its URL fragment.
 */
export function addBrowserWatchLocalPathControls(html, paths, pagePath) {
	if (!paths.size && !pagePath) return html;
	let style = `<style>${STYLE}</style>`;
	if (/<\/head>/i.test(html)) {
		html = html.replace(/<\/head>/i, () => `${style}</head>`);
		style = "";
	}
	const ui = `${style}<script>${SCRIPT}(${scriptJson([...paths])}, ${scriptJson(pagePath ?? null)});</script>`;
	// A filename can contain "$&" or "$'": never use it as a replacement string.
	return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, () => `${ui}</body>`) : `${html}\n${ui}`;
}
