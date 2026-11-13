// Presentation only: the column width of Working, Live and the REPL pages.
(function (globalObject) {
 'use strict';
 // Wide is remembered in this browser until Narrow. A cookie, not storage: a cookie isn't tied to the
 // port, so the choice outlasts a watcher's restart on a new address and holds for every preview here.
 // It says only "wide", and the server never reads it.
 const COOKIE = 'pi_markdown_preview_width';
 const WIDE = 'pi-preview-wide';
 const remembered = () => { try { return document.cookie.split(';').some(part => part.trim() === `${COOKIE}=wide`); } catch { return false; } };
 const remember = wide => { try { document.cookie = `${COOKIE}=${wide ? 'wide' : ''}; Path=/; Max-Age=${wide ? 31536000 : 0}; SameSite=Strict`; } catch {} };
 // This script runs at the top of <body>, so a wide page is never laid out narrow first.
 document.documentElement.classList.toggle(WIDE, remembered());
 globalObject.PiMarkdownPreviewPageWidth = {
  // The button stays hidden unless this script runs; its label says the current width.
  install(root) {
   const button = root?.querySelector('.page-width');
   if (!button) return;
   const wide = () => document.documentElement.classList.contains(WIDE);
   const label = () => {
    button.hidden = false;
    button.setAttribute('aria-pressed', String(wide()));
    button.textContent = `Width: ${wide() ? 'Wide' : 'Narrow'}`;
    button.title = wide()
     ? 'The page uses the window, up to 1100 pixels. Click for a narrow column; remembered in this browser'
     : 'The page is a narrow column. Click to use the window, up to 1100 pixels; remembered in this browser';
   };
   label();
   button.addEventListener('click', () => {
    // The button stays where it was on screen while the page reflows around it.
    const before = button.getBoundingClientRect().top;
    const next = !wide();
    document.documentElement.classList.toggle(WIDE, next);
    remember(next);
    label();
    window.scrollBy(0, button.getBoundingClientRect().top - before);
   });
  }
 };
})(globalThis);
