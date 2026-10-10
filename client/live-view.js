// Live recorded activity for one turn. Polls only while visible; reconciles
// cards by id and version, keeping each card's open/wrap state and focus.
// Follows the bottom only when the reader is already there; otherwise the
// visible cards stay put and a button offers the newer activity.
(function (globalObject) {
 'use strict';
 globalObject.PiMarkdownPreviewLive = {
  install(root) {
   if (!root || !document.body.classList.contains('pi-preview-live')) return;
   const list = root.querySelector('.live-events');
   const status = root.querySelector('[data-live-status]');
   const updated = root.querySelector('[data-live-updated]');
   const omittedLine = root.querySelector('.live-omitted');
   const newer = root.querySelector('.live-newer');
   if (!list) return;
   const POLL_MS = 2000, FOLLOW_PX = 80;
   let cursor = root.getAttribute('data-live-cursor') || '';
   let timer, inFlight = false, stopped = false, failures = 0, queued = null;
   const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - FOLLOW_PX;
   const toBottom = () => window.scrollTo(0, document.documentElement.scrollHeight);
   const showTime = ms => {
    if (!updated) return;
    const date = new Date(Number(ms));
    if (Number.isFinite(date.getTime())) { updated.setAttribute('data-live-updated', String(ms)); updated.textContent = date.toLocaleTimeString(); }
   };
   showTime(updated?.getAttribute('data-live-updated'));
   const fromHtml = html => { const template = document.createElement('template'); template.innerHTML = html; return template.content.firstElementChild; };
   const ids = () => Array.from(list.children, card => card.getAttribute('data-event-id'));
   const newCount = data => data.ids.filter(id => !ids().includes(id)).length;

   const apply = data => {
    const cards = new Map(Array.from(list.children, card => [card.getAttribute('data-event-id'), card]));
    const added = [];
    for (const update of data.upserts || []) {
     const fresh = fromHtml(update.html);
     if (!fresh || fresh.getAttribute('data-event-id') !== update.id) continue;
     const existing = cards.get(update.id);
     if (!existing) { cards.set(update.id, fresh); added.push(fresh); continue; }
     if (existing.getAttribute('data-event-version') === update.version) continue;
     // Replace content inside the existing card: its open and wrap state stay.
     const wrap = existing.querySelector('.output-wrap input')?.checked;
     existing.replaceChildren(...Array.from(fresh.childNodes));
     existing.setAttribute('data-event-version', update.version);
     const input = existing.querySelector('.output-wrap input');
     if (input && wrap !== undefined) input.checked = wrap;
     added.push(existing);
    }
    const keep = new Set(data.ids);
    const focused = document.activeElement;
    for (const [id, card] of cards) if (!keep.has(id) && card.isConnected && !card.contains(focused)) card.remove();
    let previous = null;
    for (const id of data.ids) {
     const card = cards.get(id);
     if (!card) continue;
     const expected = previous ? previous.nextElementSibling : list.firstElementChild;
     if (card !== expected) { if (previous) previous.after(card); else list.prepend(card); }
     previous = card;
    }
    for (const card of added) globalObject.PiMarkdownPreviewWorkingImages?.install(card);
    if (omittedLine) {
     const omitted = Number(data.omitted) || 0;
     omittedLine.hidden = !omitted;
     omittedLine.textContent = `${omitted} earlier event${omitted === 1 ? '' : 's'} not shown.`;
    }
    root.dispatchEvent(new CustomEvent('pi-markdown-preview-cards-changed'));
    cursor = data.cursor;
   };

   const showNewer = data => {
    const count = newCount(data);
    if (!newer) return;
    newer.hidden = !count;
    newer.textContent = `${count} newer event${count === 1 ? '' : 's'} ↓`;
   };
   newer?.addEventListener('click', () => {
    if (queued) { apply(queued); queued = null; }
    newer.hidden = true;
    toBottom();
   });
   window.addEventListener('scroll', () => {
    if (queued && atBottom()) { apply(queued); queued = null; if (newer) newer.hidden = true; toBottom(); }
   }, { passive: true });

   const schedule = delay => { clearTimeout(timer); if (!stopped && document.visibilityState === 'visible') timer = setTimeout(poll, delay); };
   async function poll() {
    if (inFlight || stopped || document.visibilityState !== 'visible') return;
    inFlight = true;
    try {
     const url = new URL(window.location.href);
     url.pathname = `${url.pathname.replace(/\/$/, '')}/updates`;
     url.hash = '';
     url.searchParams.set('cursor', cursor);
     const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
     if (response.status === 404 || response.status === 409) {
      stopped = true;
      if (status) status.textContent = 'This turn is no longer available here. Use Preview to reconnect.';
      return;
     }
     if (!response.ok) throw new Error(String(response.status));
     const data = await response.json();
     failures = 0;
     if (status && typeof data.statusHtml === 'string') status.innerHTML = data.statusHtml;
     showTime(data.updatedAt);
     const publish = () => document.dispatchEvent(new CustomEvent('pi-markdown-preview-live-update', { detail: {
      status: data.status, completedHref: data.completedHref, newerHref: data.newerHref, newerAnchor: data.newerAnchor, paused: Boolean(queued),
     } }));
     if (!data.unchanged) {
      const following = atBottom();
      const growing = newCount(data) > 0;
      if (following || !growing || data.resync) {
       apply(data); queued = null;
       if (newer) newer.hidden = true;
       if (following) toBottom();
      } else {
       // Paused reader: keep the visible cards and offer the newer activity.
       queued = data;
       showNewer(data);
      }
     }
     publish();
    } catch {
     failures++;
    } finally {
     inFlight = false;
     schedule(failures ? Math.min(15000, POLL_MS * 2 ** failures) : POLL_MS);
    }
   }
   document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(0); else clearTimeout(timer); });
   requestAnimationFrame(() => { if (!window.location.hash) toBottom(); schedule(POLL_MS); });
  }
 };
})(globalThis);
