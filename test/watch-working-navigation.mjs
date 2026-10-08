import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserWatchServer } from '../shared/browser-watch-server.js';
import { previewAppearanceStyle } from '../shared/agent-page-style.js';

const select = key => `[data-watch-control="${key}"]`;
const fixture = n => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root {color-scheme:light;--bg:#faf8f1;--card:#fffaf4;--panel-2:#e9e1d8;--panel-border:#bcae99;--text:#332b23;--muted:#796d60;--accent:#804a28;--preview-font-size:19px;}
@media (prefers-color-scheme: dark) {:root {color-scheme:dark;--bg:#131c25;--card:#182838;--panel-2:#283e54;--panel-border:#446077;--text:#ddeeff;--muted:#9eabb8;--accent:#70aacc;--preview-font-size:19px;}}
body {margin:0;background:var(--bg);color:var(--text);font-family:Georgia,serif;}
#preview-root {max-width:700px;margin:70px auto;font-size:var(--preview-font-size)} p{margin:36px 0}
</style></head><body><main id="preview-root"><h1>Response ${n}</h1>${Array.from({length:38},(_,i)=>`<p id="p-${i}">Response ${n}, paragraph ${i}. A synthetic reading-position example.</p>`).join('')}</main><script>window.__mermaidDone=true;</script></body></html>`;
const details = n => ({ events:[{kind:'prompt',label:'Prompt',text:`Input ${n}`},{kind:'tool',label:'Tool: read',text:JSON.stringify({path:'/synthetic/example.txt'})},...Array.from({length:6},(_,i)=>({kind:'result',label:`Tool result ${i}`,text:Array.from({length:50},(_,j)=>`Result ${n}/${i}, line ${j}: `+'literal output '.repeat(15)).join('\n')}))] });
async function setup(t, options={}) {
 const dir=await mkdtemp(join(tmpdir(),'working-navigation-')), calls=[];
 const loader=n=>async()=>{calls.push(n);return details(n);};
 const server=await createBrowserWatchServer(fixture(1),dir,{historyLimit:4,initialTurnDetails:loader(1),...options});
 server.updateDocument(fixture(2),{turnDetails:loader(2)}); server.updateDocument(fixture(3),{turnDetails:loader(3)});
 t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
 return {server,calls,loader,dir};
}
async function browserFor(t) {
 if(!process.env.PUPPETEER_EXECUTABLE_PATH){t.skip('Set a dedicated headless browser');return;}
 const {default:puppeteer}=await import('puppeteer-core');
 const browser=await puppeteer.launch({executablePath:process.env.PUPPETEER_EXECUTABLE_PATH,headless:true,args:['--no-sandbox']});
 t.after(()=>browser.close());return browser;
}
async function view(page,name,n) {
 await page.waitForFunction((name,n)=>document.querySelector('h1')?.textContent===(name==='working'?'Working':`Response ${n}`) && (name!=='working'||document.querySelector('.prompt pre')?.textContent===`Input ${n}`) && document.querySelector(`[data-watch-control="${name==='working'?'turn-details':'preview'}"]`)?.getAttribute('aria-current')==='page',{},name,n);
 await page.waitForFunction(()=>window.__mermaidDone===true);
}
async function hotkey(page,key,mod='Control',shift=false) {
 await page.keyboard.down(mod); if(mod!=='Alt')await page.keyboard.down('Alt'); if(shift)await page.keyboard.down('Shift');
 try { await page.keyboard.press(key); } finally {if(shift)await page.keyboard.up('Shift');if(mod!=='Alt')await page.keyboard.up('Alt');await page.keyboard.up(mod);}
}
const settle = page => page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));

test('Working theme transfer accepts only literal presentation tokens and never document CSS',()=>{
 const style=previewAppearanceStyle(fixture(1));
 assert.match(style,/prefers-color-scheme:dark/);assert.match(style,/font-size:var\(--preview-font-size,14px\)/);assert.match(style,/font-family:Georgia,serif/);
 assert.doesNotMatch(style,/#preview-root|paragraph|script/);
 const hostile=previewAppearanceStyle('<style>:root {--bg:url(https://evil/);--text:red;--accent:</style><script>evil()</script>;--private:secret;--preview-font-size:999999px}</style>');
 assert.match(hostile,/--text:red/);assert.doesNotMatch(hostile,/url\(|https:|<|secret|999999/);
 assert.equal(previewAppearanceStyle('<p>:root {--bg:red}</p>'),'');
});

test('Working and Preview share themed controls, view/history shortcuts and tab-local reading state', {timeout:45000}, async t=>{
 const {server,calls,loader}=await setup(t);const browser=await browserFor(t);if(!browser)return;
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setViewport({width:1100,height:750});await page.goto(server.url);await view(page,'preview',3);assert.equal(calls.length,0);
 const navStyle=()=>page.$eval('#pi-markdown-preview-watch-nav',e=>{const s=getComputedStyle(e);return [s.backgroundColor,s.color,s.font,s.borderColor];});
 for(const scheme of ['light','dark']) {
  await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:scheme}]);const expected=await navStyle();
  const bodyStyle=await page.$eval('#preview-root',e=>({size:getComputedStyle(e).fontSize,font:getComputedStyle(document.body).fontFamily,bg:getComputedStyle(document.body).backgroundColor}));
  await hotkey(page,'KeyW');await view(page,'working',3);
  assert.equal(await page.$eval('.prompt pre',e=>e.textContent),'Input 3');assert.deepEqual(await navStyle(),expected);
  assert.ok(await page.$eval(select('copy-link'),e=>e.getClientRects().length&&e.parentElement.tagName==='NAV'),'Working keeps Copy visible outside the menu.');
  assert.deepEqual(await page.$eval('.prompt pre',e=>({size:getComputedStyle(e).fontSize,font:getComputedStyle(document.body).fontFamily,bg:getComputedStyle(document.body).backgroundColor})),bodyStyle);
  assert.equal(await page.$eval(select('preview'),e=>e.getAttribute('aria-keyshortcuts')),'Control+Alt+P');
  assert.equal(await page.$eval(select('turn-details'),e=>e.getAttribute('aria-keyshortcuts')),'Control+Alt+W');
  await hotkey(page,'KeyP');await view(page,'preview',3);
 }
 // A response fragment and independent Working scroll/collapse/wrap state survive round-trips.
 await page.evaluate(()=>{location.hash='p-12';});await settle(page);const previewY=await page.evaluate(()=>scrollY);assert.ok(previewY>300);
 // Physical code still works when Option changes the printable character.
 await page.evaluate(()=>document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'∑',code:'KeyW',ctrlKey:true,altKey:true,bubbles:true,cancelable:true})));await view(page,'working',3);assert.equal(new URL(page.url()).hash,'');
 await page.click('.result > summary');await page.click('.result .output-wrap input');await page.evaluate(()=>scrollTo(0,420));await settle(page);
 const workingY=await page.evaluate(()=>scrollY);assert.ok(workingY>300);
 await hotkey(page,'KeyP');await view(page,'preview',3);await page.waitForFunction(y=>Math.abs(scrollY-y)<5,{},previewY);assert.equal(new URL(page.url()).hash,'#p-12');
 await hotkey(page,'KeyW');await view(page,'working',3);await page.waitForFunction(y=>Math.abs(scrollY-y)<5,{},workingY);
 assert.ok(await page.$eval('.result',e=>e.open&&e.querySelector('input').checked));
 await page.reload();await view(page,'working',3);await page.waitForFunction(y=>Math.abs(scrollY-y)<5,{},workingY);
 assert.ok(await page.$eval('.result',e=>e.open&&e.querySelector('input').checked));
 await hotkey(page,'ArrowLeft','Alt');await view(page,'working',2);await page.waitForFunction(()=>document.querySelector('.prompt pre').textContent==='Input 2');
 await hotkey(page,'ArrowLeft','Alt',true);await page.waitForFunction(()=>document.querySelector('.prompt pre')?.textContent==='Input 1');
 assert.equal(await page.$eval(select('previous'),e=>e.getAttribute('aria-disabled')),'true');
 await hotkey(page,'ArrowRight','Alt',true);await page.waitForFunction(()=>document.querySelector('.prompt pre')?.textContent==='Input 3');
 const reads=calls.length;server.updateDocument(fixture(4),{turnDetails:loader(4)});
 await page.waitForFunction(()=>!document.querySelector('[data-watch-control="new"]').hidden);
 assert.equal(calls.length,reads,'Metadata polling must never read another trace or reload this one.');assert.equal(await page.$eval('.prompt pre',e=>e.textContent),'Input 3');
 await hotkey(page,'ArrowRight','Alt');await page.waitForFunction(()=>document.querySelector('.prompt pre')?.textContent==='Input 4');
 // Inputs, composition and already-handled keys retain their normal behaviour.
 const here=page.url();
 assert.deepEqual(await page.evaluate(()=>{
  const input=document.createElement('textarea');document.body.append(input);input.focus();
  const results=[];for(const [key,code,extra] of [['w','KeyW',{ctrlKey:true}],['ArrowLeft','ArrowLeft',{}]]) {
   const event=new KeyboardEvent('keydown',{key,code,altKey:true,...extra,bubbles:true,cancelable:true});results.push(input.dispatchEvent(event));
  }input.remove();
  for(const extra of [{isComposing:true},{repeat:true},{metaKey:true},{ctrlKey:false,metaKey:true}]){const e=new KeyboardEvent('keydown',{key:'p',code:'KeyP',ctrlKey:true,altKey:true,bubbles:true,cancelable:true,...extra});results.push(document.body.dispatchEvent(e));}
  const handled=new KeyboardEvent('keydown',{key:'p',ctrlKey:true,altKey:true,bubbles:true,cancelable:true});handled.preventDefault();document.body.dispatchEvent(handled);
  return results;
 }),[true,true,true,true,true,true]);assert.equal(page.url(),here);
 assert.ok(await page.$eval(select('preview'),e=>{
  let native=false;e.addEventListener('click',event=>{native=!event.defaultPrevented;event.preventDefault();},{once:true});
  e.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0,ctrlKey:true}));return native;
 }),'Modifier clicks stay native (the test alone cancels the default action).');
 // Mobile controls remain reachable and separate from content; no horizontal overflow.
 for(const width of [320,360]){
  await page.setViewport({width,height:760,isMobile:true,hasTouch:true});await page.reload();await view(page,'working',4);
  assert.equal(await page.evaluate(()=>innerWidth),width);
  for(const name of ['preview','turn-details','toggle','copy-link'])assert.ok(await page.$eval(select(name),e=>{const b=e.getBoundingClientRect();return b.height>=44&&b.left>=0&&b.right<=innerWidth;}),`${name} remains visible and touch-sized at ${width}px`);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 }
 assert.deepEqual(errors,[]);
});

test('A restarted watcher never silently substitutes another turn in Working', {timeout:15000}, async t=>{
 const {server,dir}=await setup(t,{token:'navigation-test-'.repeat(3)});const browser=await browserFor(t);if(!browser)return;
 const page=await browser.newPage();await page.goto(server.url);await hotkey(page,'KeyW');await view(page,'working',3);
 const oldUrl=page.url(), port=Number(new URL(server.url).port);await server.close();
 let reads=0;const next=await createBrowserWatchServer(fixture(1),dir,{port,token:'navigation-test-'.repeat(3),initialTurnDetails:async()=>{reads++;return details(1);}});t.after(()=>next.close());
 await page.waitForFunction(()=>document.querySelector('[data-watch-control="status"]')?.textContent.includes('restarted'));
 assert.equal(page.url(),oldUrl);assert.equal(await page.$eval('.prompt pre',e=>e.textContent),'Input 3');assert.equal(reads,0);
 await hotkey(page,'ArrowLeft','Alt',true);assert.equal(page.url(),oldUrl);
 await hotkey(page,'KeyP');await view(page,'preview',1);assert.equal(reads,0);
 await hotkey(page,'KeyW');await view(page,'working',1);assert.equal(reads,1);
});

test('Working links transfer to a fresh browser, stay lazy, reject expired pairs and keep storage optional', {timeout:30000},async t=>{
 const {server,calls}=await setup(t);const browser=await browserFor(t);if(!browser)return;
 const page=await browser.newPage();await page.evaluateOnNewDocument(()=>{
  Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copied=text;}}});
 });await page.goto(server.url);await view(page,'preview',3);
 const stalePreview=await page.$eval(select('preview'),e=>e.href);
 await hotkey(page,'KeyW');await view(page,'working',3);
 assert.equal(await page.$eval(select('controls'),e=>e.hidden),true);
 await page.click(select('copy-link'));await page.waitForFunction(()=>typeof window.copied==='string');
 const link=await page.evaluate(()=>window.copied);assert.equal(new URL(link).searchParams.get('view'),'working');
 const context=await browser.createBrowserContext();const other=await context.newPage();await other.goto(link);await view(other,'working',3);
 assert.equal(await other.$eval('.prompt pre',e=>e.textContent),'Input 3');
 const before=calls.length;const noStorage=await browser.newPage();await noStorage.evaluateOnNewDocument(()=>Object.defineProperty(window,'sessionStorage',{get(){throw new Error('denied');}}));
 await noStorage.goto(server.url);await hotkey(noStorage,'KeyW');await view(noStorage,'working',3);assert.equal(calls.length,before+1);
 const oldWorking=page.url();const bad=new URL(stalePreview);bad.searchParams.set('instance','stale');
 const cookie=(await page.cookies()).map(c=>`${c.name}=${c.value}`).join(';');
 assert.equal((await fetch(bad,{headers:{cookie}})).status,409);
 for(let n=4;n<=7;n++)server.updateDocument(fixture(n),{turnDetails:async()=>details(n)});
 assert.equal((await fetch(stalePreview,{headers:{cookie}})).status,404);
 assert.equal((await fetch(oldWorking,{headers:{cookie}})).status,404);
 assert.equal((await fetch(link)).status,404);
 assert.equal(calls.length,before+1,'Expired links must not invoke a loader.');
});
