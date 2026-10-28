// A shared REPL session's recent recorded submissions, as Live does for a turn:
// polls only while visible, one request at a time with a deadline; reconciles
// cards by entry id and content version, keeping each card's open state. A card
// holding focus or a text selection is neither removed nor rewritten until the
// reader lets go of it. Follows the bottom only when the reader is already
// there; otherwise a button offers the newer entries.
(function (globalObject) {
 'use strict';
 globalObject.PiMarkdownPreviewRepl = {
  install(root) {
   if (!root || !document.body.classList.contains('pi-preview-repl')) return;
   const list = root.querySelector('.repl-entries');
   const status = root.querySelector('.repl-session-status');
   const notices = root.querySelector('.repl-window-notices');
   const newer = root.querySelector('.repl-new-entries');
   const updates = root.getAttribute('data-repl-updates');
   if (!list || !updates) return;
   const POLL_MS = 2000, REQUEST_MS = 8000, FOLLOW_PX = 80;
   let version = root.getAttribute('data-repl-version') || '';
   let timer, request = null, stopped = false, failures = 0, queued = null, receivedAt = Date.now();
   const lingering = new Set(), deferred = new Map();
   const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - FOLLOW_PX;
   const toBottom = () => window.scrollTo(0, document.documentElement.scrollHeight);
   const fromHtml = html => { const template = document.createElement('template'); template.innerHTML = html; return template.content.firstElementChild; };
   const cardsNow = () => Array.from(list.querySelectorAll(':scope > .repl-entry'));
   // The shown window's order, and whether a held card is still waiting for its number.
   let order = cardsNow().map(card => card.getAttribute('data-entry-id')), numbersHeld = false;
   const held = card => {
    const focused = document.activeElement;
    if (focused && focused !== document.body && card.contains(focused)) return true;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return false;
    for (let i = 0; i < selection.rangeCount; i++) if (selection.getRangeAt(i).intersectsNode(card)) return true;
    return false;
   };
   // Replace content inside the existing card: its open state, and its output fold's, stay.
   const replaceContent = (card, fresh, next) => {
    const fold = card.querySelector('details.repl-output')?.open;
    card.replaceChildren(...Array.from(fresh.childNodes));
    card.setAttribute('data-entry-version', next);
    const freshFold = card.querySelector('details.repl-output');
    if (freshFold && fold !== undefined) freshFold.open = fold;
   };
   const renumber = () => {
    const position = new Map(order.map((id, i) => [id, String(i + 1)]));
    numbersHeld = false;
    for (const card of cardsNow()) {
     const number = position.get(card.getAttribute('data-entry-id'));
     const span = card.querySelector(':scope > summary > .number');
     if (number === undefined || !span || span.textContent === number) continue;
     if (held(card)) numbersHeld = true; else span.textContent = number;
    }
   };
   // Ages are counted from the server's clock, so a skewed browser clock doesn't matter.
   const ages = () => {
    const holder = status?.querySelector('.repl-ages');
    if (!holder) return;
    const now = Number(holder.getAttribute('data-repl-now')) + (Date.now() - receivedAt);
    for (const span of holder.querySelectorAll('[data-repl-age]')) {
     const at = Number(holder.getAttribute(`data-repl-${span.getAttribute('data-repl-age')}`));
     const seconds = Math.max(0, Math.round((now - at) / 1000));
     span.textContent = !at ? 'not yet' : seconds < 2 ? 'just now' : seconds < 120 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`;
    }
   };
   setInterval(ages, 1000);
   ages();
   const settle = () => {
    let any = false;
    for (const card of lingering) if (!card.isConnected || !held(card)) { card.remove(); lingering.delete(card); any = true; }
    for (const [card, next] of deferred) {
     if (!card.isConnected) { deferred.delete(card); continue; }
     if (!held(card)) { replaceContent(card, next.fresh, next.version); deferred.delete(card); any = true; }
    }
    if (any || numbersHeld) renumber();
   };
   document.addEventListener('selectionchange', settle);
   document.addEventListener('focusout', () => setTimeout(settle, 0));

   const apply = data => {
    const cards = new Map(cardsNow().map(card => [card.getAttribute('data-entry-id'), card]));
    for (const update of data.cards || []) {
     const fresh = fromHtml(update.html);
     if (!fresh || fresh.getAttribute('data-entry-id') !== update.id) continue;
     const existing = cards.get(update.id);
     if (!existing) { cards.set(update.id, fresh); continue; }
     lingering.delete(existing);
     if (existing.getAttribute('data-entry-version') === update.version) { deferred.delete(existing); continue; }
     if (held(existing)) deferred.set(existing, { fresh, version: update.version });
     else { deferred.delete(existing); replaceContent(existing, fresh, update.version); }
    }
    const keep = new Set(data.ids);
    for (const [id, card] of cards) {
     if (keep.has(id) || !card.isConnected) continue;
     if (held(card)) lingering.add(card); else { card.remove(); deferred.delete(card); }
    }
    let previous = null;
    for (const id of data.ids) {
     const card = cards.get(id);
     if (!card) continue;
     let expected = previous ? previous.nextElementSibling : list.querySelector(':scope > .repl-entry');
     while (expected && lingering.has(expected)) expected = expected.nextElementSibling;
     if (card !== expected) { if (previous) previous.after(card); else if (expected) expected.before(card); else list.append(card); }
     previous = card;
    }
    list.querySelector(':scope > .repl-empty')?.toggleAttribute('hidden', data.ids.length > 0);
    if (notices && typeof data.noticesHtml === 'string') { notices.innerHTML = data.noticesHtml; notices.hidden = !data.noticesHtml; }
    order = data.ids.slice();
    renumber();
    version = data.version;
   };
   const newCount = data => { const shown = new Set(cardsNow().map(card => card.getAttribute('data-entry-id'))); return data.ids.filter(id => !shown.has(id)).length; };
   const release = () => { if (queued) { apply(queued); queued = null; } if (newer) newer.hidden = true; toBottom(); };
   newer?.addEventListener('click', release);
   window.addEventListener('scroll', () => { if (queued && atBottom()) release(); }, { passive: true });

   const schedule = delay => { clearTimeout(timer); if (!stopped && document.visibilityState === 'visible') timer = setTimeout(poll, delay); };
   const cancel = () => { clearTimeout(timer); request?.abort(); request = null; };
   async function poll() {
    if (request || stopped || document.visibilityState !== 'visible') return;
    const current = request = new AbortController();
    const deadline = setTimeout(() => current.abort(), REQUEST_MS);
    let ok = false;
    try {
     const url = new URL(updates, window.location.href);
     url.searchParams.set('version', version);
     const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal: current.signal });
     if (request !== current) return;
     if (response.status === 404 || response.status === 409) {
      stopped = true;
      if (status) status.textContent = 'This view is no longer available here. Open the REPL sessions again to reconnect.';
      return;
     }
     if (!response.ok) return;
     const data = await response.json();
     if (request !== current) return;
     ok = true;
     receivedAt = Date.now();
     if (status && typeof data.statusHtml === 'string') { status.innerHTML = data.statusHtml; ages(); }
     if (!data.unchanged && Array.isArray(data.ids)) {
      const following = atBottom();
      if (following || (!queued && !data.resync && newCount(data) === 0)) {
       apply(data); queued = null;
       if (newer) newer.hidden = true;
       if (following) toBottom();
      } else {
       queued = data;
       if (newer) { const count = newCount(data); newer.hidden = false; newer.textContent = count ? `${count} new entr${count === 1 ? 'y' : 'ies'} ↓` : 'Latest entries ↓'; }
      }
     }
     if (data.ended) stopped = true;
    } catch {} finally {
     clearTimeout(deadline);
     if (request === current) {
      request = null;
      failures = ok ? 0 : failures + 1;
      schedule(failures ? Math.min(15000, POLL_MS * 2 ** failures) : POLL_MS);
     }
    }
   }
   document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(0); else cancel(); });
   window.addEventListener('pagehide', () => { stopped = true; cancel(); });
   requestAnimationFrame(() => { if (!window.location.hash) toBottom(); schedule(POLL_MS); });
  }
 };
})(globalThis);
