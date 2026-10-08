import { basename } from "node:path";
import { AGENT_PAGE_STYLE } from "./agent-page-style.js";

const escape = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** A path page, not a file download, notebook executor or directory browser.
 * @param {string} path @param {"file" | "directory"} kind
 */
export function buildLocalPathPage(path, kind) {
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local ${kind === "directory" ? "folder" : "file"}</title>
<style>${AGENT_PAGE_STYLE}
main { padding-top:96px; } h1 { overflow-wrap:anywhere; }
.local-path { padding:12px 14px; border:1px solid var(--line); border-radius:10px; background:var(--panel); overflow-wrap:anywhere; white-space:pre-wrap; font:13px/1.6 ui-monospace,Menlo,monospace; }
.local-path code { font:inherit; }
#pi-preview-native-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
#pi-preview-native-actions button,#pi-preview-native-actions a { position:static; padding:8px 12px; min-height:44px; box-sizing:border-box; border:1px solid var(--line); border-radius:6px; background:var(--panel); color:inherit; font:inherit; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; justify-content:center; }
#pi-preview-native-actions button:hover,#pi-preview-native-actions a:hover { background:var(--hover); }
#pi-preview-native-actions button:focus-visible,#pi-preview-native-actions a:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
#pi-preview-native-actions .pi-preview-copy-path { min-width:9em; }
#pi-preview-native-actions button[aria-disabled=true] { cursor:progress; opacity:.65; }
.local-path-note { font-size:12px; color:var(--muted); }
#pi-preview-native-result { min-height:1.5em; overflow-wrap:anywhere; }
@media(max-width:520px) { main { padding-top:140px; } }
@media print { #pi-preview-native-actions,#pi-preview-native-result { display:none; } }
</style></head><body><main id="preview-root">
<h1>${escape(basename(path) || path)}</h1><p>Local ${kind === "directory" ? "folder" : "file"}</p><p class="local-path"><code>${escape(path)}</code></p>
<div id="pi-preview-native-actions"></div><p id="pi-preview-native-result" role="status"></p>
<p class="local-path-note">These actions run on the machine hosting this preview, not necessarily the device running your browser.</p>
<p class="local-path-note">${kind === "directory" ? "Folder contents are not listed or shared by this page." : "Open in default app uses your system’s file association. Depending on the file type, the app may execute it or extract an archive. Nothing is opened automatically."}</p>
<noscript>JavaScript is required for the action buttons. You can select and copy the path above.</noscript></main></body></html>`;
}
