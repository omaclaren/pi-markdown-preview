import { basename } from "node:path";
import { pathToFileURL } from "node:url";

export const IMAGE_CONTENT_TYPES = new Map([
	[".avif", "image/avif"], [".bmp", "image/bmp"], [".gif", "image/gif"], [".ico", "image/x-icon"],
	[".jpeg", "image/jpeg"], [".jpg", "image/jpeg"], [".png", "image/png"], [".svg", "image/svg+xml"], [".webp", "image/webp"],
]);

const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

/** Trusted image shell. The watch server rewrites src to a retained media route.
 * SVG stays an image resource, never authored markup in the preview's DOM. */
export function buildImagePagePreview(path) {
	const title = escape(basename(path));
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
*{box-sizing:border-box}html,body{margin:0;font:15px system-ui;color-scheme:light dark;background:Canvas;color:CanvasText}main{min-height:100vh;padding:64px 16px 16px;display:grid;place-items:center}figure{margin:0;max-width:100%;min-width:0}img{display:block;margin:auto;max-width:100%;max-height:calc(100vh - 128px);width:auto;height:auto;background:repeating-conic-gradient(#fff 0 25%,#e5e7eb 0 50%) 0 0 / 16px 16px}figcaption{text-align:center;margin-top:12px;overflow-wrap:anywhere}#image-size{position:fixed;top:8px;left:12px;z-index:200;min-height:38px;padding:4px 10px;border:1px solid ButtonBorder;border-radius:8px;background:Canvas;color:CanvasText;font:14px system-ui;cursor:pointer}body.actual-size main{display:block}body.actual-size img{max-width:none;max-height:none}#image-error{text-align:center}@media(pointer:coarse){#image-size{min-height:44px}}@media(max-width:520px){main{padding-top:120px}img{max-height:calc(100vh - 184px)}}@media print{#image-size{display:none}main{padding:0;min-height:0}body.actual-size img{max-width:100%;max-height:none}}</style></head><body><button type="button" aria-pressed="false" aria-controls="preview-image" id="image-size">Actual size</button><main id="preview-root"><figure><img id="preview-image" src="${escape(pathToFileURL(path).href)}" alt="${title}"><figcaption>${title}</figcaption><p id="image-error" role="status" hidden>Image could not be loaded. Refresh the page to try again.</p></figure></main><script>
const image = document.getElementById('preview-image');
const size = document.getElementById('image-size');
size.addEventListener('click', () => {
  const actual = document.body.classList.toggle('actual-size');
  size.setAttribute('aria-pressed', String(actual));
  size.textContent = actual ? 'Fit image' : 'Actual size';
});
// Preserve SVG view fragments without inserting authored SVG into the page.
const updateFragment = () => { image.src = image.src.split('#')[0] + location.hash; };
window.addEventListener('hashchange', updateFragment);
if (location.hash) updateFragment();
const failed = () => { document.getElementById('image-error').hidden = false; };
image.addEventListener('error', failed);
image.addEventListener('load', () => { document.getElementById('image-error').hidden = true; });
if (image.complete && !image.naturalWidth) failed();
</script></body></html>`;
}
