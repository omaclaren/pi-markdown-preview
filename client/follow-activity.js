// Follow activity (off by default, like Pi Studio). On: while a turn runs, the
// latest response's Working tab shows that turn live, and the page switches to
// it; when the turn finishes and its response is retained, it returns to that
// response's Preview (only from a live page it opened itself, and only while
// the reader is at the bottom). Off: Working is the finished response's fixed
// activity and nothing switches. Older responses' Working is always fixed,
// including a page that becomes older while open.
// Remembered per preview address; Ctrl+Alt+A toggles it. Nothing is polled while off.
(function (globalObject) {
 'use strict';
 const ENABLED = 'pi-markdown-preview:follow-activity';
 const OWNED = 'pi-markdown-preview:follow-activity:owned';
 // A turn whose live page the reader left themselves: like Pi Studio, no
 // switching back until the next turn starts.
 const DECLINED = 'pi-markdown-preview:follow-activity:declined';
 const POLL_MS = 2000, REQUEST_MS = 8000;
 globalObject.PiMarkdownPreviewFollowActivity = {
  install() {
   const button = document.querySelector('[data-watch-control="follow-activity"]');
   if (!button) return;
   const view = button.getAttribute('data-view');
   const anchor = button.getAttribute('data-anchor') || '';
   const stateUrl = button.getAttribute('data-live-state');
   // Current, not initial: the watch script updates it when a newer response arrives.
   const latest = () => button.getAttribute('data-latest') === 'true';
   const read = (store, key) => { try { return store.getItem(key); } catch { return null; } };
   const write = (store, key, value) => { try { if (value === null) store.removeItem(key); else store.setItem(key, value); } catch {} };
   let enabled = read(localStorage, ENABLED) === 'on';
   // The Working tab: fixed by default; live only while following a running turn.
   const working = document.querySelector('[data-watch-control="turn-details"]');
   const fixedHref = working?.getAttribute('href') ?? null;
   const showLiveWorking = href => {
    if (!working || view === 'live') return;
    if (href) { working.setAttribute('href', href); working.setAttribute('aria-disabled', 'false'); working.setAttribute('tabindex', '0'); return; }
    if (fixedHref) working.setAttribute('href', fixedHref);
    else { working.removeAttribute('href'); working.setAttribute('aria-disabled', 'true'); working.setAttribute('tabindex', '-1'); }
   };
   let timer, request = null, failures = 0, navigating = false;
   const render = () => {
    button.hidden = false;
    // The label says the state (as in Pi Studio); on also gets the current-tab background.
    button.setAttribute('aria-pressed', String(enabled));
    button.textContent = `Follow activity: ${enabled ? 'On' : 'Off'}`;
    button.title = `Follow activity is ${enabled ? 'on' : 'off'}: switch to Live when a turn starts and back to its response when it finishes (Ctrl+Alt+A)`;
   };
   const go = (href, owned) => {
    if (navigating || !href) return;
    navigating = true;
    cancel();
    write(sessionStorage, OWNED, owned);
    window.location.assign(href);
   };
   const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80;
   const ownsThisPage = () => view === 'live' && Boolean(anchor) && read(sessionStorage, OWNED) === anchor;

   // Preview or Working of the latest response: watch for a turn starting.
   // One request at a time, with a deadline; leaving, hiding or turning it off cancels it.
   const eligible = () => enabled && !navigating && view !== 'live' && latest() && document.visibilityState === 'visible';
   function cancel() {
    clearTimeout(timer);
    request?.abort();
    request = null;
   }
   async function poll() {
    clearTimeout(timer);
    if (request || !eligible()) return;
    const current = request = new AbortController();
    const deadline = setTimeout(() => current.abort(), REQUEST_MS);
    let ok = false;
    try {
     const response = await fetch(stateUrl, { cache: 'no-store', credentials: 'same-origin', signal: current.signal });
     if (!response.ok) throw new Error(String(response.status));
     const state = await response.json();
     ok = true;
     // A stale answer (cancelled, turned off, hidden, or no longer the latest response) does nothing.
     if (request !== current || !eligible()) return;
     const running = state.status === 'running' && state.liveHref;
     showLiveWorking(running ? state.liveHref : null);
     if (running && state.anchor !== read(sessionStorage, DECLINED)) go(state.liveHref, state.anchor);
    } catch {} finally {
     clearTimeout(deadline);
     if (request === current) {
      request = null;
      failures = ok ? 0 : failures + 1;
      if (eligible()) timer = setTimeout(poll, failures ? Math.min(15000, POLL_MS * 2 ** failures) : POLL_MS);
     }
    }
   }
   // This page's response is no longer the latest: its Working stays fixed.
   document.addEventListener('pi-markdown-preview-latest-changed', () => {
    if (latest()) void poll();
    else { cancel(); showLiveWorking(null); }
   });

   // Live page: react to each update the live view publishes. A paused reader
   // (scrolled up, or holding newer cards) is never moved; it moves on at the bottom.
   document.addEventListener('pi-markdown-preview-live-update', event => {
    if (!enabled || navigating || !ownsThisPage()) return;
    const update = event.detail || {};
    if (update.paused || !atBottom()) return;
    if (update.newerHref && update.newerAnchor) { go(update.newerHref, update.newerAnchor); return; }
    if (update.status === 'completed' && update.completedHref) go(update.completedHref, null);
   });

   const toggle = () => {
    enabled = !enabled;
    write(localStorage, ENABLED, enabled ? 'on' : null);
    // Turning it on while viewing Live adopts this turn; turning it off releases it.
    write(sessionStorage, OWNED, enabled && view === 'live' ? anchor : null);
    write(sessionStorage, DECLINED, null);
    render();
    cancel();
    if (enabled) void poll(); else showLiveWorking(null);
   };
   button.addEventListener('click', toggle);
   window.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.repeat || !event.ctrlKey || !event.altKey || event.metaKey || event.shiftKey) return;
    if (event.code !== 'KeyA' && event.key.toLowerCase() !== 'a') return;
    const target = event.target;
    if (target instanceof Element && target.closest('input:not([type="checkbox"]), textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    event.preventDefault();
    toggle();
   });
   document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void poll(); else cancel(); });
   window.addEventListener('pagehide', cancel);
   if (view === 'live' && anchor) {
    // A reload is not leaving: keep following this turn.
    const reload = performance.getEntriesByType?.('navigation')?.[0]?.type === 'reload';
    if (reload && enabled && read(sessionStorage, DECLINED) === anchor) { write(sessionStorage, DECLINED, null); write(sessionStorage, OWNED, anchor); }
    // Leaving a followed live page yourself (Preview, Back, a link) ends following for this turn.
    window.addEventListener('pagehide', () => {
     if (enabled && !navigating && ownsThisPage()) { write(sessionStorage, DECLINED, anchor); write(sessionStorage, OWNED, null); }
    });
   }
   render();
   void poll();
  }
 };
})(globalThis);
