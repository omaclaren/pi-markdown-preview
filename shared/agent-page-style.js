// Neutral fallback for utility pages. Live pages inherit their source's tokens.
// Full-window HTML wrappers reuse the theme without the reading-column layout.
export const AGENT_PAGE_THEME = `:root {
 --bg: #f7f6f3; --panel: #ffffff; --ink: #1d1d1b; --muted: #6b6a66; --line: #e3e1db; --accent: #2f5fd0;
 --work: #b86e00; --hover: #f0eee8; color-scheme: light;
 --card: var(--panel); --text: var(--ink); --panel-border: var(--line); --link: var(--accent);
}
@media (prefers-color-scheme: dark) {
 :root { --bg: #161615; --panel: #1f1f1d; --ink: #ecebe6; --muted: #9c9a93; --line: #34332f; --accent: #7aa2ff; --work: #f0b458; --hover: #2a2926; color-scheme: dark; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body .pi-preview-document-nav, body .pi-preview-path-dialog { font-family: inherit; }
`;
// Copy only known, literal design tokens from the canonical rendered response.
// Never carry document selectors, URLs, scripts or recorded trace content over.
export function previewAppearanceStyle(html, { textSize = true } = {}) {
 const head = String(html).slice(0, 65536).split(/<\/head>/i)[0];
 const match = /<style>\s*:root\s*\{([^{}]*)\}\s*(?:@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^{}]*)\}\s*\})?/.exec(head);
 if (!match) return "";
 const colors = new Set(['--bg','--card','--panel-2','--panel-border','--text','--muted','--accent','--warn','--error','--link']);
 const block = source => String(source || '').split(';').flatMap(declaration => {
  const colon = declaration.indexOf(':');
  const key = declaration.slice(0, colon).trim(), value = declaration.slice(colon + 1).trim();
  const valid = key === 'color-scheme' ? /^(light|dark)$/.test(value)
   : key === '--preview-font-size' ? /^(?:[1-9]\d?)(?:\.\d+)?px$/.test(value)
   : colors.has(key) && /^(?:#[\da-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d\s.,%/+\-]+\)|[a-z]+)$/i.test(value);
  return valid ? [`${key}:${value};`] : [];
 }).join('');
 const light = block(match[1]);
 if (!light) return "";
 const dark = block(match[2]);
 const family = /\bbody\s*\{[^{}]*\bfont-family:\s*([^;{}]+);/.exec(head)?.[1];
 const font = family && /^[\w\s,"'-]{1,256}$/.test(family) ? `font-family:${family};` : '';
 return `:root{${light}}${dark ? `@media(prefers-color-scheme:dark){:root{${dark}}}` : ''}
 :root{--panel:var(--card);--ink:var(--text);--line:var(--panel-border);--hover:var(--panel-2,rgba(127,127,127,.16));--work:var(--warn,#b86e00)}
 body{${font}${textSize ? 'font-size:var(--preview-font-size,14px)' : ''}}`;
}

// Only the shell is styled; authored HTML and its isolated origin stay intact.
export function applyPreviewAppearance(html, sourceHtml) {
 const style = previewAppearanceStyle(sourceHtml, { textSize: false });
 return style ? html.replace(/<\/head>/i, () => `<style>${style}</style>\n</head>`) : html;
}

export const AGENT_PAGE_STYLE = `${AGENT_PAGE_THEME}
main { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 18px; margin: 0 0 2px; }
`;
