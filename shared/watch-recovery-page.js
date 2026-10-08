import { AGENT_PAGE_STYLE, applyPreviewAppearance } from "./agent-page-style.js";

const escape = text => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** An inert error page, never an automatic redirect or a replacement response.
 * Actions are server-built, root-relative preview links, without credentials.
 */
export function buildWatchRecoveryPage(title, message, actions, sourceHtml = "") {
 const links = actions.filter(action => /^(?:\/\?|\/__pi_markdown_preview_turn__\/\d+\?)[^\r\n]*$/.test(action.href)).map(action =>
  `<a data-recovery-action="${escape(action.name)}" href="${escape(action.href)}">${escape(action.label)}</a>`).join("\n");
 const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><link rel="icon" href="data:,"><style>${AGENT_PAGE_STYLE}
main { padding-top:64px; } p { overflow-wrap:anywhere; }
.recovery-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:20px; }
.recovery-actions a { display:inline-flex; align-items:center; justify-content:center; min-height:44px; padding:8px 12px; border:1px solid var(--line); border-radius:6px; background:var(--panel); color:inherit; text-decoration:none; }
.recovery-actions a:hover { background:var(--hover); }
.recovery-actions a:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
</style></head><body><main id="preview-root"><h1>${escape(title)}</h1><p>${escape(message)}</p><nav class="recovery-actions" aria-label="Preview recovery">${links}</nav></main></body></html>`;
 return applyPreviewAppearance(html, sourceHtml);
}
