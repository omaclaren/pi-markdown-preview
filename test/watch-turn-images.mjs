import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRecordedImageBudget, TURN_IMAGE_BYTES, TURN_IMAGE_PIXELS, TURN_IMAGES_BYTES } from '../shared/recorded-images.js';
import { createTurnDetails, turnDetailsFromRecords } from '../shared/turn-details.js';
import { readTurnDetails } from '../shared/read-turn-details.js';
import { buildTurnDetailsPage } from '../shared/turn-details-page.js';
import { createBrowserWatchServer } from '../shared/browser-watch-server.js';
const text=text=>({type:'text',text});
const p=(id,parentId,role,content,stopReason)=>({type:'message',id,parentId,message:{role,content,stopReason}});
const final=(parentId)=>p('final',parentId,'assistant',[text('Answer')],'stop');
const target={key:'pi:final',markdown:'Answer'};
// A small deterministic PNG generator, not a converter or production dependency.
const crc=b=>{let c=0xffffffff;for(const n of b){c^=n;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
function chunk(tag,data){const name=Buffer.from(tag),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);name.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc(Buffer.concat([name,data])),out.length-4);return out;}
function png(width=600,height=300,padding=0){
 const head=Buffer.alloc(13);head.writeUInt32BE(width);head.writeUInt32BE(height,4);head[8]=8;head[9]=2;
 const pixels=Buffer.alloc(height*(1+width*3));for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*(1+width*3)+1+x*3;pixels[i]=40;pixels[i+1]=x<width/2?130:180;pixels[i+2]=y<height/2?160:210;}
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',head),chunk('IDAT',deflateSync(pixels)),...(padding?[chunk('tEXt',Buffer.alloc(padding,65))]:[]),chunk('IEND',Buffer.alloc(0))]);
}
const PNG=png(),DATA=PNG.toString('base64'),IMAGE_URL=`data:image/png;base64,${DATA}`;
const img={type:'image',mimeType:'image/png',data:DATA};
const projected=()=>({mimeType:'image/png',data:DATA});
const result=d=>d.events.find(e=>e.kind==='result');

test('Recorded image projections admit only explicit tool-result bytes across Pi, Claude and Codex',()=>{
 const pi=turnDetailsFromRecords('pi',[p('u',null,'user',[text('Question'),img]),p('a','u','assistant',[{type:'toolCall',id:'call',name:'read',arguments:{path:'/never/read.png'}}],'toolUse'),{...p('r','a','toolResult',[text('Output'),img]),message:{role:'toolResult',toolName:'read',toolCallId:'call',content:[text('Output'),img]}},final('r')],target);
 assert.equal(result(pi).images.length,1);assert.equal(result(pi).text,'Output');assert.equal(result(pi).images[0].data,DATA);assert.ok(!pi.events.find(e=>e.kind==='prompt').images);
 const c=(uuid,parentUuid,role,content,id,stop_reason)=>({type:role,uuid,parentUuid,message:{role,content,id,stop_reason}});
 const claude=turnDetailsFromRecords('claude',[c('u',null,'user',[text('Question')]),c('a','u','assistant',[{type:'tool_use',id:'call',name:'Read',input:{file_path:'/never/read.png'}}],'a','tool_use'),c('r','a','user',[{type:'tool_result',tool_use_id:'call',content:[{type:'image',source:{type:'base64',media_type:'image/png',data:DATA}}]}]),c('wrong',null,'user',[{type:'tool_result',tool_use_id:'wrong',content:[img]}]),c('f','r','assistant',[text('Answer')],'answer','end_turn')],{key:'claude:answer',markdown:'Answer'});
 assert.equal(result(claude).images.length,1);assert.equal(result(claude).text,'');assert.match(result(claude).label,/Read/);
 const codex=turnDetailsFromRecords('codex',[{type:'event_msg',payload:{type:'task_started',turn_id:'one'}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_image',image_url:IMAGE_URL},text('Question')]}},{type:'response_item',payload:{type:'function_call',name:'view_image',call_id:'call',arguments:'{}'}},{type:'response_item',payload:{type:'function_call_output',call_id:'call',output:[{type:'input_image',image_url:IMAGE_URL}]}},{type:'event_msg',payload:{type:'task_complete',turn_id:'one',last_agent_message:'Answer'}}],{key:'codex:one',markdown:'Answer'});
 assert.equal(result(codex).images[0].data,DATA);assert.equal(codex.events.filter(e=>e.images).length,1);
 const t=createTurnDetails();t.toolResult('Tool result','Literal output',undefined,[{type:'file',mime:'image/png',uri:IMAGE_URL}]);assert.equal(result(t.result).images[0].data,DATA);
 t.toolResult('Tool result',[{type:'file',mime:'image/png',url:IMAGE_URL}]);assert.equal(t.result.events.at(-1).images[0].data,DATA);
 // String output is not reparsed as JSON/Markdown or interpreted as a filename.
 t.toolResult('Tool result',JSON.stringify([img]));assert.ok(!t.result.events.at(-1).images);
});

test('Recorded images reject external/path references, SVG, animation, malformed data, and excessive byte/pixel totals',()=>{
 const t=createTurnDetails();t.toolResult('Tool result',[{type:'image',source:{type:'url',url:'https://private.invalid/secret'}},{type:'input_image',image_url:'file:///private/secret.png'},{type:'input_image',file_id:'secret-id'},{type:'file',mime:'image/png',uri:'/private/secret.png'},{type:'image',mimeType:'image/svg+xml',data:Buffer.from('<svg onload="bad()"/>').toString('base64')}, {...img,data:DATA.slice(0,-1)}, {...img,data:'x'.repeat(TURN_IMAGE_BYTES*2)}]);
 assert.deepEqual(result(t.result).images.map(i=>i.unavailable),['missing','missing','missing','missing','format','invalid','size']);
 assert.doesNotMatch(JSON.stringify(t.result),/private|secret-id|bad\(\)|base64/);
 const modified=Buffer.from(PNG);modified.writeUInt32BE(8193,16);assert.equal(createRecordedImageBudget().take({...projected(),data:modified.toString('base64')}).unavailable,'pixels');
 const huge=Buffer.from(PNG);huge.writeUInt32BE(4096,16);huge.writeUInt32BE(Math.floor(TURN_IMAGE_PIXELS/4096)+1,20);assert.equal(createRecordedImageBudget().take({...projected(),data:huge.toString('base64')}).unavailable,'pixels');
 const animated=Buffer.concat([PNG.subarray(0,33),chunk('acTL',Buffer.alloc(8)),PNG.subarray(33)]);assert.equal(createRecordedImageBudget().take({...projected(),data:animated.toString('base64')}).unavailable,'format');
 const animation=Buffer.alloc(30);animation.write('RIFF');animation.writeUInt32LE(22,4);animation.write('WEBPVP8X',8);animation.writeUInt32LE(10,16);animation[20]=2;
 assert.equal(createRecordedImageBudget().take({mimeType:'image/webp',data:animation.toString('base64')}).unavailable,'format');
 for(const mimeType of ['image/png','image/jpeg','image/webp'])for(let length=0;length<64;length++)assert.doesNotThrow(()=>createRecordedImageBudget().take({mimeType,data:Buffer.alloc(length,255).toString('base64')}));
 const big=png(10,10,400000).toString('base64'),budget=createRecordedImageBudget();const accepted=Array.from({length:8},()=>budget.take({mimeType:'image/png',data:big}));
 assert.ok(accepted.some(i=>i.unavailable==='total'));assert.ok(accepted.reduce((n,i)=>n+(i.byteLength||0),0)<=TURN_IMAGES_BYTES);
 const many=createTurnDetails();many.toolResult('Tool result',Array.from({length:100},()=>img));assert.equal(result(many.result).images.length,9);assert.equal(result(many.result).images.at(-1).unavailable,'count');
 const byPixels=createRecordedImageBudget(),eightMP=Buffer.from(PNG);eightMP.writeUInt32BE(4096,16);eightMP.writeUInt32BE(2048,20);
 assert.ok(byPixels.take({...projected(),data:eightMP.toString('base64')}).data);assert.ok(byPixels.take({...projected(),data:eightMP.toString('base64')}).data);assert.equal(byPixels.take(projected()).unavailable,'total');
});

test('Working revalidates projected images, suppresses non-result images, and keeps text inert',()=>{
 const details={events:[{kind:'prompt',label:'Prompt',text:'Prompt',images:[projected()]},{kind:'result',label:'Tool result',text:'<img src="https://private.invalid/x">',images:[projected(),{mimeType:'image/png',data:'https://private.invalid/nope'}, {unavailable:'<script>bad()</script>'}]}]};
 const html=buildTurnDetailsPage(details,'#');assert.equal([...html.matchAll(/data-recorded-src=/g)].length,1);assert.ok(html.includes(IMAGE_URL));
 assert.doesNotMatch(html,/<img src=|<script>|https:\/\/private\.invalid\/nope/);assert.match(html,/&lt;img/);assert.match(html,/Recorded image unavailable/);
});

const rootHtml='<!doctype html><html><head><title>Example</title></head><body><main id="preview-root"><h1>Answer</h1></main></body></html>';
test('Recorded image bytes remain lazy and opt-in, are never file reads, and use only data: image CSP',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'preview-recorded-images-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,'session.jsonl');const rows=[p('u',null,'user',[text('Question')]),p('r','u','toolResult',[img]),final('r')];await writeFile(path,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
 let calls=0;const server=await createBrowserWatchServer(rootHtml,dir,{initialTurnDetails:async signal=>{calls++;return readTurnDetails(path,'pi',target,signal);}});t.after(()=>server.close());
 const boot=await fetch(server.url),cookie=boot.headers.get('set-cookie').split(';')[0],body=await boot.text(),route=body.match(/data-watch-control="turn-details" href="([^"]+)"/)[1].replaceAll('&amp;','&');
 assert.equal(calls,0);assert.ok(!body.includes(DATA));
 const get=(method='GET',headers={cookie})=>fetch(new URL(route,server.url),{method,headers});
 assert.equal((await get('GET',{})).status,403);await get('HEAD');assert.equal(calls,0);
 const response=await get(),html=await response.text();assert.equal(calls,1);assert.ok(html.includes(DATA));assert.match(response.headers.get('content-security-policy'),/img-src data:;/);assert.equal(response.headers.get('cache-control'),'no-store');
 assert.doesNotMatch(response.headers.get('content-security-policy'),/img-src[^;]*(https?|file:|'self'|blob:)/);
 await writeFile(path,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');assert.equal((await get()).status,200);
 server.updateDocument(rootHtml);assert.ok(!(await (await fetch(server.url)).text()).includes('<a data-watch-control="turn-details"'));
});

test('Image thumbnails decode only in expanded results; native lightbox is keyboard/mobile safe, handles errors, and never fetches references', {skip:!process.env.PUPPETEER_EXECUTABLE_PATH,timeout:60000},async t=>{
 const {default:puppeteer}=await import('puppeteer-core');const browser=await puppeteer.launch({executablePath:process.env.PUPPETEER_EXECUTABLE_PATH,headless:true,args:['--no-sandbox']});t.after(()=>browser.close());
 const page=await browser.newPage();await page.setViewport({width:1100,height:800});
 // Generate real JPEG/WebP fixtures with the test browser's encoder.
 const encoded=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=600;c.height=300;const x=c.getContext('2d');x.fillStyle='#284f87';x.fillRect(0,0,600,300);return ['image/jpeg','image/webp'].map(type=>c.toDataURL(type));});
 const details=createTurnDetails();details.toolResult('Tool result: screenshot',[text('Recorded output'),img,...encoded.map(uri=>({type:'file',mime:uri.slice(5,uri.indexOf(';')),uri}))]);
 assert.deepEqual(result(details.result).images.map(i=>i.mimeType),['image/png','image/jpeg','image/webp']);
 // Plausible size/frame headers but no JPEG components/tables: the native
 // decoder, rather than the lightweight header check, rejects this fixture.
 const corrupt=Buffer.from('ffd8ffc00008080001000100ffda0002ffd9','hex');details.toolResult('Tool result: corrupt',[{type:'image',mimeType:'image/jpeg',data:corrupt.toString('base64')}]);
 details.toolResult('Tool result: external',[{type:'input_image',image_url:'https://never-fetch.invalid/image.png'}]);
 const server=await createBrowserWatchServer(rootHtml,'/tmp',{initialTurnDetails:async()=>details.result});t.after(()=>server.close());
 const requests=[];page.on('request',r=>requests.push(r.url()));const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(server.url);await page.click('[data-watch-control="turn-details"]');await page.waitForSelector('.recorded-image-open');
 assert.equal(await page.$$eval('img[data-recorded-src]',nodes=>nodes.filter(n=>n.hasAttribute('src')).length),0);
 await page.click('.result > summary');await page.waitForFunction(()=>[...document.querySelectorAll('.result:first-of-type img')].every(i=>i.complete&&i.naturalWidth>0));
 for(const [i,type] of ['png','jpeg','webp'].entries()){
  const button=await page.$(`.result .recorded-image:nth-of-type(${i+1}) .recorded-image-open`);assert.ok(button);
  await button.focus();await page.keyboard.press('Enter');await page.waitForSelector('dialog[open]');
  await page.waitForFunction(()=>document.querySelector('dialog[open] img')?.naturalWidth>0);
  assert.ok(await page.$eval('dialog img',e=>e.src.startsWith('data:image/')),type);assert.equal(await page.$eval('dialog img',e=>e.naturalWidth),600,type);
  // Native modal Tab may visit browser chrome (body becomes active), but
  // cannot focus the inert page. Shift+Tab returns to the Close button.
  await page.keyboard.press('Tab');assert.ok(await page.evaluate(()=>document.activeElement===document.body||document.querySelector('dialog').contains(document.activeElement)));
  await page.keyboard.down('Shift');await page.keyboard.press('Tab');await page.keyboard.up('Shift');assert.ok(await page.evaluate(()=>document.querySelector('dialog').contains(document.activeElement)));
  await page.keyboard.down('Alt');await page.keyboard.press('ArrowLeft');await page.keyboard.up('Alt');assert.equal(await page.$$eval('dialog[open]',n=>n.length),1);
  // Synthetic events cannot trigger native Close Other Tabs/host commands.
  // Control+Alt stays contained; Command combinations pass through unchanged.
  const keys=await page.evaluate(()=>{
   const close=document.querySelector('dialog[open] button');
   return ['KeyP','KeyW','ArrowLeft','Escape'].map(code=>{
    const dispatch=modifiers=>{const event=new KeyboardEvent('keydown',{code,key:code.startsWith('Key')?code.slice(3).toLowerCase():code,altKey:true,bubbles:true,cancelable:true,...modifiers});close.dispatchEvent(event);return event.defaultPrevented;};
    return [dispatch({metaKey:true}),dispatch({metaKey:true,ctrlKey:true}),...(code==='Escape'?[]:[dispatch({ctrlKey:true})])];
   });
  });
  assert.deepEqual(keys,[[false,false,true],[false,false,true],[false,false,true],[false,false]]);
  assert.equal(await page.$$eval('dialog[open]',n=>n.length),1);
  await page.keyboard.press('Escape');assert.equal(await page.$$eval('dialog[open]',n=>n.length),0);assert.equal(await button.evaluate(e=>e===document.activeElement),true);
 }
 await page.$eval('.result:nth-of-type(2)',e=>e.open=true);await page.waitForFunction(()=>document.querySelector('.result:nth-of-type(2) .recorded-image-error')?.hidden===false);
 assert.equal(await page.$eval('.result:nth-of-type(2) .recorded-image-open',e=>e.hidden),true);
 assert.ok(!requests.some(url=>url.includes('never-fetch.invalid')));assert.deepEqual(errors,[]);
 await page.setViewport({width:360,height:740,isMobile:true,hasTouch:true});await page.reload();await page.waitForSelector('.recorded-image-open');
 await page.$eval('.result',e=>e.open=true);await page.waitForFunction(()=>document.querySelector('.result img')?.naturalWidth>0);
 await page.click('.recorded-image-open');await page.waitForSelector('dialog[open]');
 assert.ok(await page.$eval('dialog',e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}));
 assert.ok(await page.$eval('dialog button',e=>e.getBoundingClientRect().height>=44));await page.click('dialog button');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 // Modal and image bytes are not saved into tab-local presentation state.
 await page.click('[data-watch-control="preview"]');await page.waitForSelector('h1');assert.ok(!(await page.evaluate(()=>JSON.stringify({...sessionStorage}))).includes('base64'));
});
