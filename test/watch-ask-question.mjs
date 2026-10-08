import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTurnDetails, turnDetailsFromRecords, TURN_TEXT_LIMIT, TURN_TOTAL_LIMIT } from '../shared/turn-details.js';
import { buildTurnDetailsPage } from '../shared/turn-details-page.js';
import { createBrowserWatchServer } from '../shared/browser-watch-server.js';
const questions=[{header:'Storage',question:'Which storage should we use?',multiSelect:false,options:[{label:'SQLite',description:'One local file',preview:'<img src="https://never-fetch.invalid/x">\r\n  literal preview'},{label:'PostgreSQL',description:'A separate server',extra:false}]},{header:'Checks',question:'Which checks should run?',multiSelect:true,options:[{label:'Unit tests',description:'Fast checks'},{label:'Browser tests',description:'Exercise the interface'}]}];
const args={questions,extraOption:17};
const metadata={answers:{'Which storage should we use?':'SQLite, with an "archive" copy.\r\n  Preserve this indentation.','Which checks should run?':''},annotations:{'Which checks should run?':{notes:'Add <script>not executable</script> checks.',preview:'<b>literal</b>'}},unrelatedPrivateMetadata:'DO_NOT_PROJECT'};
const output='User has answered your questions: literal recorded summary, not delimiter-parsed.';
const row=(uuid,parentUuid,role,content,id,stop_reason)=>({type:role,uuid,parentUuid,message:{role,content,id,stop_reason}});
const call=(id='call',name='AskUserQuestion')=>({type:'tool_use',id,name,input:args});
const answer=(id='call',is_error=false)=>({type:'tool_result',tool_use_id:id,content:output,is_error});
function records(result=[answer()],meta=metadata,tool=call()){
 return [row('u',null,'user',[{type:'text',text:'A synthetic request.'}]),row('a','u','assistant',[tool],'a','tool_use'),{...row('r','a','user',result),toolUseResult:meta},row('f','r','assistant',[{type:'text',text:'Answer'}],'final','end_turn')];
}
const project=rows=>turnDetailsFromRecords('claude',rows,{key:'claude:final',markdown:'Answer'});

test('Claude question sidecars require an exact known call and one result; errors/unrelated metadata stay literal',()=>{
 const details=project(records()),result=details.events.find(e=>e.kind==='result');
 assert.equal(result.text,output);assert.deepEqual(JSON.parse(result.questionAnswers),{answers:metadata.answers,annotations:metadata.annotations});
 assert.doesNotMatch(JSON.stringify(details),/DO_NOT_PROJECT/);
 for(const rows of [records([answer('other')]),records([answer(),answer('other')]),records([answer('call',true)]),records([answer()],metadata,call('call','Bash')),records([answer()],{answers:{q:['not','a','string']}})]){
  assert.ok(project(rows).events.every(e=>!e.questionAnswers));
 }
 const huge=project(records([answer()],{answers:{q:'x'.repeat(TURN_TEXT_LIMIT)}}));assert.ok(huge.events.every(e=>!e.questionAnswers));
 const t=createTurnDetails();t.add('tool','Tool: AskUserQuestion','{}','call');for(let i=0;i<20;i++)t.add('progress','Progress','x'.repeat(TURN_TEXT_LIMIT));
 t.toolResult('Tool result','', 'call',[],metadata);assert.ok(t.result.events.every(e=>!e.questionAnswers));
 assert.ok(t.result.events.reduce((n,e)=>n+e.text.length+(e.questionAnswers?.length||0),0)<=TURN_TOTAL_LIMIT+32);
});

test('Question formatting preserves all options, unknown fields, literal previews, exact answers and raw records',()=>{
 const details=project(records()),html=buildTurnDetailsPage(details,'#');
 assert.equal([...html.matchAll(/class="asked-question"/g)].length,2);assert.match(html,/Multiple selections allowed/);assert.match(html,/Single selection/);
 assert.match(html,/extraOption/);assert.match(html,/>17</);assert.match(html,/>false</);assert.match(html,/&lt;img/);assert.match(html,/&lt;script/);
 assert.match(html,/Empty recorded answer/);assert.match(html,/Recorded answers \(JSON\)/);assert.match(html,/Raw output/);
 assert.doesNotMatch(html,/<img |<script>|<form|<select|type="radio"|disabled/);
 assert.ok(html.includes('SQLite, with an &quot;archive&quot; copy.&#13;'));
 assert.doesNotMatch(buildTurnDetailsPage({...details,sourceAgent:'pi'},'#'),/class="asked-question"|class="question-reply"/);
 const malformed=structuredClone(details);malformed.events.find(e=>e.kind==='tool').text='{"questions":[';
 assert.doesNotMatch(buildTurnDetailsPage(malformed,'#'),/class="asked-question"/);
 const unknown=structuredClone(details);const result=unknown.events.find(e=>e.kind==='result');delete result.questionAnswers;result.text='{"answers": {"Q": ["a", "b"]}}';
 assert.doesNotMatch(buildTurnDetailsPage(unknown,'#'),/class="question-reply"/);
 const forged=structuredClone(details);forged.events.find(e=>e.kind==='result').questionAnswers=JSON.stringify({answers:{Q:'x'.repeat(TURN_TEXT_LIMIT)}});
 assert.ok(buildTurnDetailsPage(forged,'#').length<100000);
});

test('Plain recorded AskUserQuestion replies wrap as prose, without guessing selections or parsing quotes/commas',()=>{
 const details=project(records([answer()],undefined));const r=details.events.find(e=>e.kind==='result');delete r.questionAnswers;
 const html=buildTurnDetailsPage(details,'#');assert.match(html,/Recorded reply/);assert.ok(html.includes(output));assert.doesNotMatch(html,/class="asked-question"[^]*checked/);
 r.text=JSON.stringify({answers:{Q:'one, two, or "something else"'},extra:'retained'});
 const json=buildTurnDetailsPage(details,'#');assert.match(json,/one, two, or &quot;something else&quot;/);assert.match(json,/retained/);
});

test('Question view is read-only, keyboard accessible, themed, mobile-safe and makes no recorded URL requests', {skip:!process.env.PUPPETEER_EXECUTABLE_PATH,timeout:60000},async t=>{
 const {default:puppeteer}=await import('puppeteer-core');const browser=await puppeteer.launch({executablePath:process.env.PUPPETEER_EXECUTABLE_PATH,headless:true,args:['--no-sandbox']});t.after(()=>browser.close());
 const details=project(records());const server=await createBrowserWatchServer('<html><head></head><body><main id="preview-root">Answer</main></body></html>','/tmp',{initialTurnDetails:async()=>details});t.after(()=>server.close());
 const page=await browser.newPage(),requests=[],errors=[];page.on('request',r=>requests.push(r.url()));page.on('pageerror',e=>errors.push(e.message));
 await page.goto(server.url);await page.click('[data-watch-control="turn-details"]');await page.waitForSelector('.asked-question');
 await page.focus('.event.tool > summary');await page.keyboard.press('Enter');await page.$eval('.event.result',e=>e.open=true);
 assert.equal(await page.$$eval('.asked-question input,.asked-question button,.asked-question a,.asked-question select',n=>n.length),0);
 assert.equal(await page.$eval('.question-reply .question-prose',e=>e.textContent),Object.values(metadata.answers)[0]);
 assert.equal(await page.$eval('.recorded-arguments pre',e=>e.textContent),details.events.find(e=>e.kind==='tool').text);
 assert.equal(await page.$eval('.recorded-output pre',e=>e.textContent),output);
 assert.equal(await page.$eval('.recorded-output',e=>e.open),false);
 await page.focus('.recorded-output > summary');await page.keyboard.press('Enter');assert.equal(await page.$eval('.recorded-output',e=>e.open),true);
 for(const scheme of ['light','dark']){await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:scheme}]);assert.equal(await page.$eval('.question-prose',e=>getComputedStyle(e).whiteSpace),'pre-wrap');}
 await page.setViewport({width:360,height:760,isMobile:true,hasTouch:true});await page.reload();await page.waitForSelector('.asked-question');await page.$eval('.event.tool',e=>e.open=true);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.ok(!requests.some(url=>url.includes('never-fetch.invalid')));assert.deepEqual(errors,[]);
});
