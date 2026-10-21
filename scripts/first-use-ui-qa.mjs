/** Isolated production UI acceptance; synthetic credentials/images, no providers or user data. */
import assert from 'node:assert/strict'
import {spawn}from'node:child_process'
import{mkdir,mkdtemp,readFile,rm,writeFile}from'node:fs/promises'
import{tmpdir}from'node:os'
import{join,resolve}from'node:path'
import{createServer}from'node:http'
import{createDatabase}from'../server/database.mjs'
import{createLocalService}from'../server/index.mjs'
import{createDesktopHandler}from'../desktop/server.mjs'
const temporary=await mkdtemp(join(tmpdir(),'astaria-first-use-')),output=resolve('artifacts/first-use-2026-10-15/ui')
await mkdir(output,{recursive:true})
const fixtureRow=(id,weekday,period,subject,group='',extra={})=>({id,weekday,period,subject,subjectGroup:subject.replace(/\d+$/u,''),location:'A501',classGroup:group,start:'08:00',end:'08:40',weekCycle:'weekly',note:'',uncertain:false,cell:`周${weekday}第${period}节`,...extra})
const fixture={kind:'combined',rows:[fixtureRow('a',1,'1','Econ1','A'),fixtureRow('b',1,'1','Econ1','B',{location:'A502'}),fixtureRow('c',3,'1','Econ1','A'),fixtureRow('d',1,'1','Econ2'),fixtureRow('e',2,'2','Eng','分组1',{start:'09:00',end:'09:40'}),fixtureRow('f',2,'2','Eng','分组2',{start:'09:00',end:'09:40'}),fixtureRow('g',4,'2','Eng','分组1',{start:'09:00',end:'09:40'}),fixtureRow('h',4,'2','Eng','分组2',{start:'09:00',end:'09:40'}),fixtureRow('unknown',0,'','', '',{start:'',end:'',uncertain:true,cell:'周五上午，文字未清楚'})]}
let db=createDatabase(':memory:'),currentProvider,chrome,ws,server,stopping=false,serial=0
let configured=true,modelCalls=0;const vault={status:async()=>configured,read:async()=> 'synthetic-fixture-key',save:async()=>{configured=true},remove:async()=>{configured=false}}
const keys=new Map(),compatibleVault=endpoint=>({status:async()=>keys.has(endpoint),read:async()=>keys.get(endpoint),save:async key=>keys.set(endpoint,key),remove:async()=>keys.delete(endpoint)})
const complete=async payload=>{modelCalls++;if(payload.messages.some(m=>Array.isArray(m.content)))return{choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(fixture)}}]};return{choices:[{message:{role:'assistant',content:'OK'}}]}}
const service=createLocalService({db,vault,compatibleVault,complete,dataDirectory:temporary,fetcher:async()=>{throw Error('No external provider')},compatibleFetcher:async()=>{throw Error('No external provider')}})
const checks=[],errors=[],blocked=[],pending=new Map(),delay=ms=>new Promise(r=>setTimeout(r,ms))
const send=(method,params={})=>new Promise((done,reject)=>{const id=++serial,t=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method))},20000);pending.set(id,{done,reject,t});ws.send(JSON.stringify({id,method,params}))})
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
const wait=async expression=>{for(let i=0;i<300;i++){if(await evaluate(expression))return;await delay(50)}throw Error('Timeout '+expression)}
const click=async selector=>{await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'});true`);await delay(100);const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(e.disabled||e.closest('[inert]')||!e.contains(document.elementFromPoint(x,y)))throw Error('Unreachable '+${JSON.stringify(selector)});return{x,y}})()`);await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p})}
const label=async(host,text)=>{await evaluate(`{const e=[...document.querySelectorAll(${JSON.stringify(host+' button')})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing '+${JSON.stringify(text)});e.dataset.qaClick='true'}`);await click('[data-qa-click]');await evaluate(`document.querySelector('[data-qa-click]')?.removeAttribute('data-qa-click');true`)}
const shot=async name=>writeFile(join(output,name+'.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'))
const file=async(selector,path)=>{const d=await send('DOM.getDocument'),e=await send('DOM.querySelector',{nodeId:d.root.nodeId,selector});assert.ok(e.nodeId);await send('DOM.setFileInputFiles',{nodeId:e.nodeId,files:[path]})}
const value=async(selector,text)=>evaluate(`{const e=document.querySelector(${JSON.stringify(selector)}),p=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));true}`)
const api=async(path,body)=>evaluate(`(async()=>{const r=await fetch('/api'+${JSON.stringify(path)},{method:${JSON.stringify(body===undefined?'GET':'POST')},headers:{'X-ASTaria-Local':'1','Content-Type':'application/json'},${body===undefined?'':`body:JSON.stringify(${JSON.stringify(body)}),`}});const d=await r.json();if(!r.ok)throw Error(d.error);return d})()`)
try{
 const token='synthetic-isolated-first-use-capability';const handler=createDesktopHandler({root:resolve('dist'),service,token})
 server=createServer((req,res)=>{req.headers['x-astaria-desktop']=token;void handler(req,res)});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port
 const profile=join(temporary,'chrome');chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--disable-background-networking','--disable-sync','about:blank'],{stdio:'ignore'})
 let port;for(let i=0;i<150;i++){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);if(port)break}catch{}await delay(100)}assert.ok(port)
 const target=(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(x=>x.type==='page');ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j})
 ws.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.t);m.error?p.reject(m.error):p.done(m.result)}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);if(m.method==='Fetch.requestPaused'){const{requestId,request}=m.params;const allowed=request.url.startsWith(base)||/^(data|blob):/.test(request.url);if(!allowed)blocked.push(request.url);void send(allowed?'Fetch.continueRequest':'Fetch.failRequest',{requestId,...(allowed?{}:{errorReason:'BlockedByClient'})}).catch(e=>{if(!stopping)errors.push(String(e))})}}
 await send('Page.enable');await send('Runtime.enable');await send('Fetch.enable',{patterns:[{urlPattern:'*'}]});await send('Page.addScriptToEvaluateOnNewDocument',{source:"localStorage.setItem('astaria-sqlite-migration-v1','complete')"})
 const image=join(temporary,'fictional.png');await writeFile(image,await readFile('public/pwa-192x192.png'))
 const ics=join(temporary,'fictional.ics');await writeFile(ics,'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:synthetic-course\r\nDTSTART;TZID=Asia/Shanghai:20261102T100000\r\nDTEND;TZID=Asia/Shanghai:20261102T104000\r\nSUMMARY:虚构课程 ICS\r\nLOCATION:测试教室\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n')
 for(const [theme,glass,width,height]of[['dark','clear',1440,900],['light','soft',1440,900],['dark','soft',390,844],['light','clear',390,844]]){
  console.log('QA',theme,glass,width)
  const before=db.getPlanner().revision
  const prefs=db.getPreference('app');const defaults=(await import('../server/preferences.mjs')).getPreferences(db);db.setPreference('app',{...defaults,theme,glass});db.setPreference('onboarding-completed',false)
  await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await send('Emulation.setTimezoneOverride',{timezoneId:'Asia/Shanghai'});await send('Page.navigate',{url:base});await wait("!!document.querySelector('.first-run[open]') && !!window.__ASTARIA_P0__")
  await shot(`${width}-${theme}-${glass}-quick`)
  await label('.first-run','截图导入课表');await wait("!!document.querySelector('.tti-dialog[open]')");assert.equal(await evaluate("document.querySelector('.first-run').open"),false)
  await file('.tti-file',image);await wait("!document.querySelector('.tti-file').disabled && !!document.querySelector('.tti-preview img')")
  await label('.tti-dialog','识别课表');await wait("document.querySelectorAll('[data-testid=timetable-code]').length>0")
  assert.equal(db.getPlanner().revision,before);checks.push(`${width}/${theme}: recognition only drafts, no planner write`)
  assert.equal(await evaluate("!![...document.querySelectorAll('.tti-dialog label')].find(e=>e.textContent.trim()==='教师')"),false)
  for(const code of['Econ1','Eng'])await click(`[data-code="${code}"]`)
  assert.equal(await evaluate("document.querySelector('[data-code=Econ2]').getAttribute('aria-pressed')"),'false')
  await shot(`${width}-${theme}-${glass}-codes`)
  await click('[data-testid=timetable-continue-codes]');await wait("!!document.querySelector('[data-testid=timetable-groups]')")
  await label('.tti-dialog','A');await label('.tti-dialog','分组1');await shot(`${width}-${theme}-${glass}-groups`)
  await click('[data-testid=timetable-continue-groups]');await wait("!!document.querySelector('[data-testid=timetable-preview]')")
  const preview=await evaluate("[...document.querySelectorAll('[data-testid=timetable-preview] .tti-row-title')].map(e=>e.textContent)")
  await shot(`${width}-${theme}-${glass}-preview`)
  // Unreadable grid cells remain an explicit review item, never guessed into a course.
  const state=await evaluate("({text:document.querySelector('[data-testid=timetable-preview]').innerText,confirm:document.querySelector('[data-testid=timetable-confirm]').disabled,rows:document.querySelectorAll('[data-testid=timetable-preview-row]').length})")
  assert.ok(!state.text.includes('Econ2'));assert.ok(state.rows>=4);checks.push(`${width}/${theme}: exact code variants, groups reused and unknown cells visible`)
  // Unknown cells can be explicitly excluded; the four clear selected rows can save.
  if(state.confirm){const buttons=await evaluate("[...document.querySelectorAll('[data-testid=timetable-preview-row]')].filter(e=>e.dataset.uncertain==='true').map(e=>e.dataset.rowId)");await evaluate("document.querySelectorAll('[data-testid=timetable-preview-row][data-uncertain=true]').forEach(e=>{const b=[...e.querySelectorAll('button')].find(b=>b.textContent.trim()==='移除');b?.click()});true")}
  await wait("!document.querySelector('[data-testid=timetable-confirm]').disabled")
  await click('[data-testid=timetable-confirm]');await wait("!!document.querySelector('[data-testid=timetable-receipt]')")
  assert.equal(db.getPlanner().routines.filter(x=>x.kind==='class').length,4);assert.ok(db.getPlanner().routines.every(x=>x.title!=='Econ2'))
  await label('.tti-dialog','撤销导入');await wait("document.querySelector('[data-testid=timetable-receipt]').innerText.includes('已撤销')");assert.equal(db.getPlanner().routines.filter(x=>x.kind==='class').length,0);checks.push(`${width}/${theme}: confirmed four courses and durable undo`)
  await label('.tti-footer','完成');await wait("!!document.querySelector('.first-run[open]')")
  await label('.first-run','导入 ICS');await wait("!!document.querySelector('.ics-import[open]')")
  await file('.ics-import input[type=file]',ics);await wait("document.querySelectorAll('.ics-import-table-scroll tbody tr').length===1")
  await label('.ics-import','全选 1 项');await shot(`${width}-${theme}-${glass}-ics`)
  await label('.ics-import','确认导入 1 项');await wait("!!document.querySelector('.ics-import-receipt')");assert.equal(db.getPlanner().dayEvents.length,1)
  await label('.ics-import','撤销本次导入');await wait("document.querySelector('.ics-import-receipt').innerText.includes('已核对撤销')");assert.equal(db.getPlanner().dayEvents.length,0)
  await label('.ics-import-footer','完成');await wait("!!document.querySelector('.first-run[open]')");checks.push(`${width}/${theme}: ICS preview edits, save and undo`)
  await label('.first-run','保存并继续');await wait("document.querySelector('.first-run').dataset.step==='1'");await shot(`${width}-${theme}-${glass}-model-help`)
  await label('.first-run','连接其它 API 或本地模型');await wait("!!document.querySelector('.xixi-model-connection')")
  await label('.xixi-model-modes','其它 API');await value('#xixi-compatible-preset','custom');await value('#xixi-compatible-url','https://models.example.com/v1');await value('#xixi-compatible-model','synthetic-vision-tools');await value('#xixi-compatible-key','synthetic-ui-fixture-key')
  await shot(`${width}-${theme}-${glass}-compatible`)
  await label('.xixi-model-actions','保存连接与密钥');await wait("document.querySelector('.xixi-model-connection').innerText.includes('已配置')")
  assert.equal(keys.get('https://models.example.com/v1'),'synthetic-ui-fixture-key');assert.equal(db.getPreference('model-connection').compatible.model,'synthetic-vision-tools')
  assert.equal(await evaluate("document.querySelector('#xixi-compatible-key').value"),'');checks.push(`${width}/${theme}: actual compatible settings and scoped key save`)
  await value('#xixi-compatible-key','unsaved-synthetic-key');await value('#xixi-compatible-url','https://second.example.com/v1');assert.equal(await evaluate("document.querySelector('#xixi-compatible-key').value"),'');checks.push(`${width}/${theme}: address change clears unsaved secret`)
  // Returning to the DeepSeek guide must test DeepSeek even after another API was saved.
  await send('Page.navigate',{url:base});await wait("!!document.querySelector('.first-run[open]')")
  await label('.first-run','保存并继续');await wait("document.querySelector('.first-run').dataset.step==='1'")
  await value('#first-run-key','synthetic-deepseek-fixture-key');await label('.first-run','保存并测试连接')
  await wait("document.querySelector('.first-run').dataset.step==='2'")
  assert.equal(db.getPreference('model-connection').provider,'deepseek')
  assert.equal(db.getPreference('model-connection').compatible.model,'synthetic-vision-tools')
  assert.equal(keys.get('https://models.example.com/v1'),'synthetic-ui-fixture-key')
  checks.push(`${width}/${theme}: first-run DeepSeek save tests the selected DeepSeek connection and retains other API settings`)
  // Reset only synthetic configuration for next independent UI variant.
  db.setPreference('model-connection',{provider:'deepseek',cloudModel:'deepseek-flash',local:{engine:'ollama',baseUrl:'http://127.0.0.1:11434/v1',model:''}})
 }
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
 await writeFile(join(output,'result.json'),JSON.stringify({status:'passed',checks,modelCalls,errors,blocked,scope:'Production desktop build in isolated Chrome, real in-memory SQLite and local routes, synthetic provider/vault. No real model/device claims or private school image in screenshots.'},null,2));console.log(JSON.stringify({status:'passed',checks:checks.length,modelCalls}))
}catch(error){await shot('failure').catch(()=>{});await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),errors,blocked,checks},null,2));throw error}
finally{stopping=true;ws?.close();chrome?.kill();for(const p of pending.values())clearTimeout(p.t);if(server)await new Promise(r=>server.close(r));await service.close();await delay(200);await rm(temporary,{recursive:true,force:true})}
