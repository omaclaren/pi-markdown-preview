// Live recorded activity for one turn. Polls only while visible, one request at
// a time with a deadline; reconciles cards by id and version, keeping each
// card's open/wrap state. A card holding focus or a text selection is neither
// removed nor rewritten until the reader lets go of it. Follows the bottom only
// when the reader is already there; otherwise the visible cards stay put (even
// across a resync) and a button offers the newer activity.
(function (globalObject) {
 'use strict';
 globalObject.PiMarkdownPreviewLive = {
  install(root) {
   if (!root || !document.body.classList.contains('pi-preview-live')) return;
   const list = root.querySelector('.live-events');
   const status = root.querySelector('[data-live-status]');
   const updated = root.querySelector('[data-live-updated]');
   const timeLabel = root.querySelector('[data-live-time-label]');
   const omittedLine = root.querySelector('.live-omitted');
   const newer = root.querySelector('.live-newer');
   if (!list) return;
   const POLL_MS = 2000, REQUEST_MS = 8000, FOLLOW_PX = 80;
   let cursor = root.getAttribute('data-live-cursor') || '';
   let timer, request = null, stopped = false, failures = 0, queued = null;
   // Cards kept for the reader (selection/focus) after leaving the window, and
   // newer content waiting for a card the reader is holding.
   const lingering = new Set(), deferred = new Map();
   const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - FOLLOW_PX;
   const toBottom = () => window.scrollTo(0, document.documentElement.scrollHeight);
   const showTime = (ms, loaded) => {
    if (timeLabel && typeof loaded === 'boolean') timeLabel.textContent = loaded ? 'Loaded' : 'Updated';
    if (!updated) return;
    const date = new Date(Number(ms));
    if (Number.isFinite(date.getTime())) { updated.setAttribute('data-live-updated', String(ms)); updated.textContent = date.toLocaleTimeString(); }
   };
   showTime(updated?.getAttribute('data-live-updated'));
   const fromHtml = html => { const template = document.createElement('template'); template.innerHTML = html; return template.content.firstElementChild; };
   const ids = () => Array.from(list.children, card => card.getAttribute('data-event-id'));
   const newCount = data => { const shown = new Set(ids()); return data.ids.filter(id => !shown.has(id)).length; };
   const held = card => {
    const focused = document.activeElement;
    if (focused && focused !== document.body && card.contains(focused)) return true;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return false;
    for (let i = 0; i < selection.rangeCount; i++) if (selection.getRangeAt(i).intersectsNode(card)) return true;
    return false;
   };
   const replaceContent = (card, fresh, version) => {
    // Replace content inside the existing card: its open and wrap state stay.
    const wrap = card.querySelector('.output-wrap input')?.checked;
    card.replaceChildren(...Array.from(fresh.childNodes));
    card.setAttribute('data-event-version', version);
    const input = card.querySelector('.output-wrap input');
    if (input && wrap !== undefined) input.checked = wrap;
    globalObject.PiMarkdownPreviewWorkingImages?.install(card);
   };
   const changed = () => root.dispatchEvent(new CustomEvent('pi-markdown-preview-cards-changed'));
   // A card's number is its position in the turn. As the window moves (or content
   // waiting for a held card is applied), renumber the cards the window shows.
   // A card the reader is holding keeps its number until they let go (see settle).
   let windowStart = Number(omittedLine?.getAttribute('data-live-omitted')) || 0, windowIds = ids();
   const heldNumbers = new Set();
   const renumber = () => {
    const position = new Map(windowIds.map((id, i) => [id, String(windowStart + i + 1)]));
    heldNumbers.clear();
    for (const card of list.children) {
     const number = position.get(card.getAttribute('data-event-id'));
     const span = card.querySelector(':scope > summary > .number');
     if (number === undefined || !span || span.textContent === number) continue;
     if (held(card)) heldNumbers.add(card); else span.textContent = number;
    }
   };
   // The reader let go: drop cards that left the window, apply waiting content.
   const settle = () => {
    if (!lingering.size && !deferred.size && !heldNumbers.size) return;
    let any = false;
    for (const card of lingering) if (!card.isConnected || !held(card)) { card.remove(); lingering.delete(card); any = true; }
    for (const [card, next] of deferred) {
     if (!card.isConnected) { deferred.delete(card); continue; }
     if (!held(card)) { replaceContent(card, next.fresh, next.version); deferred.delete(card); any = true; }
    }
    if (any || heldNumbers.size) renumber();
    if (any) changed();
   };
   document.addEventListener('selectionchange', settle);
   document.addEventListener('focusout', () => setTimeout(settle, 0));

   const apply = data => {
    const cards = new Map(Array.from(list.children, card => [card.getAttribute('data-event-id'), card]));
    const added = [];
    for (const update of data.upserts || []) {
     const fresh = fromHtml(update.html);
     if (!fresh || fresh.getAttribute('data-event-id') !== update.id) continue;
     const existing = cards.get(update.id);
     if (!existing) { cards.set(update.id, fresh); added.push(fresh); continue; }
     lingering.delete(existing);
     if (existing.getAttribute('data-event-version') === update.version) { deferred.delete(existing); continue; }
     if (held(existing)) deferred.set(existing, { fresh, version: update.version });
     else { deferred.delete(existing); replaceContent(existing, fresh, update.version); }
    }
    const keep = new Set(data.ids);
    for (const [id, card] of cards) {
     if (keep.has(id) || !card.isConnected) continue;
     if (held(card)) lingering.add(card); else { card.remove(); deferred.delete(card); }
    }
    // Order the window's cards; lingering cards stay where the reader left them.
    let previous = null;
    for (const id of data.ids) {
     const card = cards.get(id);
     if (!card) continue;
     let expected = previous ? previous.nextElementSibling : list.firstElementChild;
     while (expected && lingering.has(expected)) expected = expected.nextElementSibling;
     if (card !== expected) { if (previous) previous.after(card); else if (expected) expected.before(card); else list.append(card); }
     previous = card;
    }
    windowStart = Number(data.omitted) || 0;
    windowIds = data.ids;
    renumber();
    for (const card of added) globalObject.PiMarkdownPreviewWorkingImages?.install(card);
    if (omittedLine) {
     const omitted = Number(data.omitted) || 0;
     omittedLine.hidden = !omitted;
     omittedLine.textContent = `${omitted} earlier event${omitted === 1 ? '' : 's'} not shown.`;
    }
    changed();
    cursor = data.cursor;
   };

   const showNewer = data => {
    const count = newCount(data);
    if (!newer) return;
    newer.hidden = false;
    newer.textContent = count ? `${count} newer event${count === 1 ? '' : 's'} ↓` : 'Latest activity ↓';
   };
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
     const url = new URL(window.location.href);
     url.pathname = `${url.pathname.replace(/\/$/, '')}/updates`;
     url.hash = '';
     url.searchParams.set('cursor', cursor);
     const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal: current.signal });
     if (request !== current) return;
     if (response.status === 404 || response.status === 409) {
      stopped = true;
      if (status) status.textContent = 'This turn is no longer available here. Use Preview to reconnect.';
      return;
     }
     if (response.status === 503 && (await response.json().catch(() => ({}))).error === 'busy') {
      if (status && request === current) status.textContent = 'Live updates are waiting: too many live sessions are open. Retrying…';
      return;
     }
     if (!response.ok) return;
     const data = await response.json();
     // Cancelled while reading (hidden or left): a stale answer changes nothing.
     if (request !== current) return;
     ok = true;
     if (status && typeof data.statusHtml === 'string') status.innerHTML = data.statusHtml;
     showTime(data.updatedAt, data.loaded);
     if (!data.unchanged) {
      const following = atBottom();
      if (following || (!queued && !data.resync && newCount(data) === 0)) {
       // Updates are cumulative from the applied cursor, so this supersedes anything queued.
       apply(data); queued = null;
       if (newer) newer.hidden = true;
       if (following) toBottom();
      } else {
       // Paused reader: keep the visible cards (also across a resync) and offer the newer activity.
       queued = data;
       showNewer(data);
      }
     }
     document.dispatchEvent(new CustomEvent('pi-markdown-preview-live-update', { detail: {
      status: data.status, completedHref: data.completedHref, previewHref: data.previewHref, newerHref: data.newerHref, newerAnchor: data.newerAnchor, paused: Boolean(queued),
     } }));
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
