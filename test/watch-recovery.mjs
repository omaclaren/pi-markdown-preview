import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserWatchServer } from '../shared/browser-watch-server.js';
import { buildWatchRecoveryPage } from '../shared/watch-recovery-page.js';
const fixture=n=>`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--bg:#faf8f1;--card:#fffaf4;--text:#332b23;}@media(prefers-color-scheme:dark){:root{--bg:#131c25;--card:#182838;--text:#ddeeff;}}</style></head><body><main id="preview-root"><h1>Response ${n}</h1></main></body></html>`;
const href=(html,name)=>html.match(new RegExp(`data-(?:watch-control|recovery-action)="${name}"[^>]*href="([^"]+)"`))?.[1].replaceAll('&amp;','&');
async function setup(t){const root=await mkdtemp(join(tmpdir(),'watch-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function auth(server){const r=await fetch(server.url);return {html:await r.text(),origin:new URL(server.url).origin,headers:{cookie:r.headers.get('set-cookie').split(';')[0]}};}
const get=(a,path,extra={})=>fetch(new URL(path,a.origin),{headers:a.headers,...extra});
const details=n=>({events:[{kind:'prompt',label:'Prompt',text:`Input ${n}`}]});

test('Recovery pages are inert, escape text, constrain links and inherit only safe presentation tokens',()=>{
 const html=buildWatchRecoveryPage('<img src=x>','<script>bad()</script>',[
  {name:'preview',label:'A < B',href:'/?revision=2&identity=x'},
  {name:'bad',label:'Bad',href:'javascript:alert(1)'},{name:'bad',label:'Bad',href:'//external.invalid/'},
 ],fixture(1));
 assert.match(html,/&lt;script&gt;/);assert.match(html,/A &lt; B/);assert.match(html,/--bg:#faf8f1/);
 assert.doesNotMatch(html,/<script|<img|javascript:|external.invalid|Response 1/);
 assert.match(html,/href="\/\?revision=2&amp;identity=x"/);
});

test('Mixed Working history offers the exact Preview on 404; expiry offers only explicit current-preview recovery',async t=>{
 const root=await setup(t);let calls=0;const load=async()=>{calls++;return details(3);};
 const server=await createBrowserWatchServer(fixture(1),root,{initialTurnDetails:load,historyLimit:3});t.after(()=>server.close());
 server.updateDocument(fixture(2));server.updateDocument(fixture(3),{turnDetails:load});
 const a=await auth(server),route=href(a.html,'turn-details');const working=await (await get(a,route)).text();assert.equal(calls,1);
 const unavailable=href(working,'previous');assert.ok(unavailable);
 const head=await get(a,unavailable,{method:'HEAD'});assert.equal(head.status,404);assert.equal(await head.text(),'');assert.equal(calls,1);
 const r=await get(a,unavailable),html=await r.text();assert.equal(r.status,404);assert.match(html,/<h1>Working unavailable/);
 assert.match(r.headers.get('content-type'),/text\/html/);assert.equal(r.headers.get('cache-control'),'no-store');assert.match(r.headers.get('content-security-policy'),/default-src 'none'/);
 assert.doesNotMatch(html,/<script|Input 3|http-equiv="refresh"/);assert.equal(calls,1);
 const exact=href(html,'preview');assert.equal(new URL(exact,a.origin).searchParams.get('revision'),'2');
 assert.match(await (await get(a,exact)).text(),/<h1>Response 2<\/h1>/);
 server.updateDocument(fixture(4));server.updateDocument(fixture(5));
 const expired=await get(a,unavailable);assert.equal(expired.status,404);const expiredHtml=await expired.text();
 assert.equal(href(expiredHtml,'preview'),undefined);assert.ok(href(expiredHtml,'current-preview'));assert.equal(calls,1);
 const denied=await fetch(new URL(unavailable,a.origin));assert.equal(denied.status,403);assert.doesNotMatch(await denied.text(),/data-recovery-action/);
 const wrong=new URL(unavailable,a.origin);wrong.searchParams.set('identity','wrong');
 const mismatch=await fetch(wrong,{headers:a.headers});assert.equal(mismatch.status,409);assert.doesNotMatch(await mismatch.text(),/data-recovery-action/);
});

test('Stale Preview/Working links keep 409, never read a replacement turn, and bootstrap explicit recovery in a fresh browser',async t=>{
 const root=await setup(t),token='synthetic-recovery-'.repeat(3);let calls=0;
 const first=await createBrowserWatchServer(fixture(1),root,{token,initialTurnDetails:async()=>details(1)});t.after(()=>first.close());
 const a=await auth(first),preview=href(a.html,'preview'),working=href(a.html,'turn-details');
 const boot=new URL(first.url);for(const [key,value] of new URL(preview,a.origin).searchParams)boot.searchParams.set(key,value);boot.searchParams.set('view','working');
 await first.close();
 const next=await createBrowserWatchServer(fixture(99),root,{token,port:Number(new URL(a.origin).port),initialTurnDetails:async()=>{calls++;return details(99);}});t.after(()=>next.close());
 for(const path of [preview,working]){
  const r=await get(a,path),html=await r.text();assert.equal(r.status,409);assert.match(r.headers.get('content-type'),/text\/html/);
  assert.ok(href(html,'current-preview'));assert.equal(href(html,'preview'),undefined);assert.doesNotMatch(html,/Response 99|Input 99|<script|http-equiv="refresh"/);
  const head=await get(a,path,{method:'HEAD'});assert.equal(head.status,409);assert.equal(await head.text(),'');
 }
 assert.equal(calls,0);
 const fresh=await fetch(boot),html=await fresh.text();assert.equal(fresh.status,409);const cookie=fresh.headers.get('set-cookie').split(';')[0];
 const chosen=await fetch(new URL(href(html,'current-preview'),a.origin),{headers:{cookie}});assert.equal(chosen.status,200);assert.match(await chosen.text(),/<h1>Response 99<\/h1>/);assert.equal(calls,0);
 const bad=new URL(boot);bad.searchParams.set('identity','different-watcher');const denied=await fetch(bad);assert.equal(denied.status,409);assert.equal(denied.headers.get('set-cookie'),null);assert.doesNotMatch(await denied.text(),/data-recovery-action/);
});

test('Failed reads offer an exact retry without disclosing error details',async t=>{
 const root=await setup(t);let calls=0;
 const server=await createBrowserWatchServer(fixture(1),root,{initialTurnDetails:async()=>{if(++calls===1)throw new Error('SECRET /private/path');return details(1);}});t.after(()=>server.close());
 const a=await auth(server),route=href(a.html,'turn-details'),r=await get(a,route),html=await r.text();assert.equal(r.status,503);
 assert.doesNotMatch(html,/SECRET|\/private\/path/);assert.equal(href(html,'retry'),route);
 assert.equal((await get(a,href(html,'retry'))).status,200);assert.equal(calls,2);
});

test('Recovery links support keyboard, Back, light/dark and mobile without running page scripts', {timeout:30000},async t=>{
 if(!process.env.PUPPETEER_EXECUTABLE_PATH){t.skip('Set a dedicated headless browser');return;}
 const root=await setup(t);const server=await createBrowserWatchServer(fixture(1),root,{initialTurnDetails:async()=>details(1)});t.after(()=>server.close());
 server.updateDocument(fixture(2));server.updateDocument(fixture(3),{turnDetails:async()=>details(3)});
 const {default:puppeteer}=await import('puppeteer-core');const browser=await puppeteer.launch({executablePath:process.env.PUPPETEER_EXECUTABLE_PATH,headless:true,args:['--no-sandbox']});t.after(()=>browser.close());
 const page=await browser.newPage();await page.goto(server.url);await page.click('[data-watch-control="turn-details"]');await page.waitForSelector('.prompt');
 await page.click('[data-watch-control="toggle"]');await page.click('[data-watch-control="previous"]');await page.waitForSelector('[data-recovery-action="preview"]');
 assert.equal(await page.$eval('h1',e=>e.textContent),'Working unavailable');assert.equal(await page.evaluate(()=>document.scripts.length),0);
 const recovery=page.url();
 for(const [scheme,color] of [['light','rgb(250, 248, 241)'],['dark','rgb(19, 28, 37)']]){await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:scheme}]);assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor),color);}
 await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.dataset.recoveryAction),'preview');
 await Promise.all([page.waitForNavigation(),page.keyboard.press('Enter')]);assert.equal(await page.$eval('h1',e=>e.textContent),'Response 2');
 await page.goBack();assert.equal(page.url(),recovery);assert.equal(await page.$eval('h1',e=>e.textContent),'Working unavailable');
 await page.setViewport({width:320,height:700,isMobile:true,hasTouch:true});await page.goto(recovery);
 assert.ok(await page.$$eval('.recovery-actions a',links=>links.every(e=>{const b=e.getBoundingClientRect();return b.height>=44&&b.left>=0&&b.right<=innerWidth;})));
 assert.equal(await page.evaluate(()=>innerWidth),320);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
});
