// Tab-local presentation only: no recorded text, paths or authenticated URLs.
(function (globalObject) {
 "use strict";
 globalObject.PiMarkdownPreviewWorkingState = {
  // A scope enables saved open/wrap/scroll state (Working). Without one (Live,
  // whose cards change), only the Expand all/Collapse all button is installed.
  install(root, scope, retainedScopes) {
   if (!root) return;
   // One button acts on event cards only, never nested raw sections. Its label
   // is always the action a click takes: Collapse all only when every card is
   // open. It stays hidden unless this script runs and there are cards.
   const bulk = root.querySelector('.working-bulk');
   const cards = () => Array.from(root.querySelectorAll('details.event')).slice(0, 1000);
   if (bulk) {
    let pending = false;
    const label = () => {
     pending = false;
     const current = cards();
     bulk.hidden = !current.length;
     bulk.textContent = current.length && current.every(card => card.open) ? 'Collapse all' : 'Expand all';
    };
    label();
    bulk.addEventListener('click', () => {
     const current = cards();
     const open = !current.every(card => card.open);
     for (const card of current) card.open = open;
     label();
    });
    // Manual opening/closing and added cards update the label, once per frame.
    const later = () => { if (!pending) { pending = true; requestAnimationFrame(label); } };
    root.addEventListener('toggle', event => { if (event.target instanceof Element && event.target.matches('details.event')) later(); }, true);
    root.addEventListener('pi-markdown-preview-cards-changed', later);
   }
   if (!scope) return;
   const prefix = 'pi-markdown-preview:working-ui:';
   const key = prefix + scope;
   const details = Array.from(root.querySelectorAll('details')).slice(0, 1000);
   const wraps = Array.from(root.querySelectorAll('.output-wrap input')).slice(0, 250);
   const outputs = Array.from(root.querySelectorAll('.result pre')).slice(0, 250);
   try {
    const keep = new Set(retainedScopes.map(s => prefix + s));
    const watcherPrefix = prefix + scope.split(':working:')[0] + ':working:';
    for (const stored of Object.keys(sessionStorage)) if (stored.startsWith(watcherPrefix) && !keep.has(stored)) sessionStorage.removeItem(stored);
    const state = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (state && Array.isArray(state.open) && state.open.length <= 1000 && state.open.every(i => Number.isInteger(i) && i >= 0 && i < details.length)) {
     const open = new Set(state.open); details.forEach((e, i) => { e.open = open.has(i); });
     if (Array.isArray(state.wrap) && state.wrap.length <= 250) wraps.forEach((e, i) => { e.checked = state.wrap.includes(i); });
     if (Array.isArray(state.left) && state.left.length <= 250) outputs.forEach((e, i) => { if (Number.isFinite(state.left[i])) e.scrollLeft = Math.max(0, state.left[i]); });
    }
   } catch { /* Storage denial must not prevent reading or navigation. */ }
   if (bulk) root.dispatchEvent(new CustomEvent('pi-markdown-preview-cards-changed'));
   window.addEventListener('pagehide', () => {
    try {
     sessionStorage.setItem(key, JSON.stringify({
      open: details.flatMap((e, i) => e.open ? [i] : []),
      wrap: wraps.flatMap((e, i) => e.checked ? [i] : []),
      left: outputs.map(e => e.scrollLeft),
     }));
    } catch {}
   }, { once: true });
  }
 };
})(globalThis);
