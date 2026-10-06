import { basename } from "node:path";

const escape = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** A path page, not a file download, notebook executor or directory browser.
 * @param {string} path @param {"file" | "directory"} kind
 */
export function buildLocalPathPage(path, kind) {
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local ${kind === "directory" ? "folder" : "file"}</title>
<style>html{color-scheme:light dark}body{margin:0;background:Canvas;color:CanvasText;font:16px/1.5 system-ui}main{box-sizing:border-box;max-width:850px;margin:0 auto;padding:110px 24px 32px}h1{font-size:1.5rem;overflow-wrap:anywhere}.local-path{padding:16px;border:1px solid GrayText;border-radius:8px;overflow-wrap:anywhere;white-space:pre-wrap}#pi-preview-native-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}#pi-preview-native-actions button,#pi-preview-native-actions a{position:static;padding:8px 12px;min-height:28px;box-sizing:content-box;border:1px solid GrayText;border-radius:6px;background:transparent;color:inherit;font:14px system-ui;cursor:pointer;text-decoration:none}#pi-preview-native-actions .pi-preview-copy-path{min-width:9em}#pi-preview-native-actions button[aria-disabled=true]{cursor:progress;opacity:.65}.local-path-note{font-size:14px;opacity:.8}#pi-preview-native-result{min-height:1.5em;overflow-wrap:anywhere}@media(max-width:520px){main{padding-top:140px}}@media print{#pi-preview-native-actions,#pi-preview-native-result{display:none}}</style></head><body><main id="preview-root">
<h1>${escape(basename(path) || path)}</h1><p>Local ${kind === "directory" ? "folder" : "file"}</p><p class="local-path"><code>${escape(path)}</code></p>
<div id="pi-preview-native-actions"></div><p id="pi-preview-native-result" role="status"></p>
<p class="local-path-note">These actions run on the machine hosting this preview, not necessarily the device running your browser.</p>
<p class="local-path-note">${kind === "directory" ? "Folder contents are not listed or shared by this page." : "Open in default app uses your system’s file association. Depending on the file type, the app may execute it or extract an archive. Nothing is opened automatically."}</p>
<noscript>JavaScript is required for the action buttons. You can select and copy the path above.</noscript></main></body></html>`;
}
