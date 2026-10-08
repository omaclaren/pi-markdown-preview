// A small, read-only lightbox. Sources are server-validated inline raster bytes;
// never interpret paths, accept arbitrary URLs, persist images or fetch resources.
(function (globalObject) {
 'use strict';
 globalObject.PiMarkdownPreviewWorkingImages = {
  install(root) {
   if (!root) return;
   const images = Array.from(root.querySelectorAll('img[data-recorded-src]')).slice(0,8);
   if (!images.length) return;
   let dialog, large, opener, caption;
   const closeImage = () => {
    large?.remove(); large = undefined;
    dialog?.close();
    opener?.setAttribute('aria-expanded','false');
    const target = opener?.hidden ? opener.closest('.event')?.querySelector('summary') : opener;
    if (target?.isConnected) target.focus({preventScroll:true});
   };
   const fail = img => {
    const figure = img.closest('.recorded-image');
    const message = figure?.querySelector('.recorded-image-error');
    if (message) { message.hidden = false; message.textContent = 'Recorded image unavailable: the browser could not decode it.'; }
    const button = figure?.querySelector('.recorded-image-open');
    if (button) button.hidden = true;
    if (dialog?.open && opener === button) closeImage();
    img.removeAttribute('src'); img.removeAttribute('data-recorded-src');
   };
   for (const img of images) img.addEventListener('error', () => fail(img), { once: true });
   const hydrate = () => {
    for (const img of images) {
     if (img.getAttribute('src') || !img.closest('.event')?.open) continue;
     const src = img.getAttribute('data-recorded-src');
     // A second defensive check; the only caller inserts canonical base64.
     if (src && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(src)) img.src = src;
    }
   };
   root.addEventListener('toggle', hydrate, true);
   hydrate();
   root.addEventListener('click', event => {
    const button = event.target.closest?.('.recorded-image-open');
    if (!button || !root.contains(button)) return;
    const img = button.querySelector('img');
    if (!img?.getAttribute('src')) return;
    if (typeof HTMLDialogElement === 'undefined' || !HTMLDialogElement.prototype.showModal) {
     const expanded = button.classList.toggle('inline-expanded');
     button.setAttribute('aria-expanded', String(expanded));
     button.querySelector('span').textContent = expanded ? 'Shrink' : 'Enlarge'; return;
    }
    if (!dialog) {
     dialog = document.createElement('dialog'); dialog.className = 'recorded-image-dialog';
     dialog.setAttribute('aria-label','Recorded tool-result image');
     const header = document.createElement('div'); header.className = 'recorded-image-dialog-header';
     caption = document.createElement('span');
     const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close'; close.autofocus = true;
     close.addEventListener('click', closeImage);
     header.append(caption,close); dialog.append(header); document.body.append(dialog);
     dialog.addEventListener('cancel', e => { e.preventDefault(); closeImage(); });
     dialog.addEventListener('click', e => {
      const box = dialog.getBoundingClientRect();
      if (e.target === dialog && (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom)) closeImage();
     });
     dialog.addEventListener('keydown', e => {
      // Command combinations belong to the browser/terminal host, even in a modal.
      if (e.metaKey) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeImage(); }
      // Keep the watcher's navigation keys out of the modal. Native Tab focus
      // containment, browser zoom and other ordinary browser keys are unchanged.
      else if (e.altKey && (['ArrowLeft','ArrowRight'].includes(e.key) || (e.ctrlKey && ['KeyP','KeyW'].includes(e.code)))) { e.preventDefault(); e.stopPropagation(); }
     });
    }
    opener = button; caption.textContent = button.getAttribute('aria-label').replace(/\. Enlarge$/, '');
    large?.remove();
    const enlargement = document.createElement('img'); enlargement.alt = 'Enlarged recorded tool-result image';
    // A detached previous image can finish/error after Close. It must not
    // change the next image's state or close a subsequently opened dialog.
    enlargement.addEventListener('error', () => { if (dialog.open && enlargement.isConnected) fail(img); });
    enlargement.src = img.src; large = enlargement; dialog.append(enlargement);
    dialog.showModal(); button.setAttribute('aria-expanded','true');
   });
  }
 };
})(globalThis);
