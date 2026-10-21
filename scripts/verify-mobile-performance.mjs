/** Comparable production mobile runs; desktop Chrome slowdown is not phone FPS. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { preview } from 'vite'
import { createDatabase } from '../server/database.mjs'

const root = process.cwd(), dist = resolve(process.argv[2] ?? 'dist-mobile')
const output = resolve(process.argv[3] ?? 'artifacts/mobile-performance-2026-10-15/candidate')
const temporary = await mkdtemp(join(tmpdir(), 'astaria-mobile-perf-'))
const checks = [], samples = [], errors = [], network = []
const db = createDatabase(':memory:')
db.setPreference('onboarding-completed', true)
const date = '2026-10-15', at = `${date}T08:00:00+08:00`
db.setPreference('free-time-daily', { date, completedAt: at })
const act = action => db.updatePlanner(action, db.getPlanner().revision)
act({ type:'import-routines', routines:[{ id:'qa-window',title:'学习',kind:'available',weekdays:[0,1,2,3,4,5,6],start:'08:00',end:'22:00',location:'',items:[],enabled:true }] })
for (let i = 0; i < 40; i++) {
  const task = db.createTask({ title:`隔离验收事项 ${i+1}`, estimateMin:25, due:'2026-10-22', inbox:false })
  if (i < 16) act({ type:'save-block', block:{ id:`qa-slot-${i}`,taskId:task.id,date:i<8?date:'2026-10-16',start:`${String(9+i%8).padStart(2,'0')}:00`,end:`${String(9+i%8).padStart(2,'0')}:25`,locked:false } })
}
const historyTurns = process.env.MOBILE_PERF_TYPOGRAPHY_ONLY==='1' ? 1 : 60
for (let i = 0; i < historyTurns; i++) {
  const requestId=`qa-chat-${i}`
  db.appendMessage({ conversationId:'main',requestId,role:'user',content:`一起核对第 ${i+1} 项资料` })
  db.appendMessage({ conversationId:'main',requestId,role:'assistant',content:process.env.MOBILE_PERF_TYPOGRAPHY_ONLY==='1'
    ? '## 先把眼前这一件做好\n\n这节空课还剩 20 分钟，可以先核对物理作业的最后两题，留几分钟检查单位和计算。\n\n- **先做题**：遇到卡点就标出来，别在一题上耗完整段。\n- **再检查**：确认步骤、单位和答案。\n\n如果你想换个安排，告诉我，我会先核对空档再改。'
    : `## 第 ${i+1} 项安排\n\n${'这段是用于检查长对话滚动、输入与页面切换的虚构内容。'.repeat(20)}\n\n- 保留截止时间\n- 核对真实空档\n- 完成后给出回执\n\n**已有资料保持完整。**` })
}
db.selectConversation('main')
const backup = db.exportData(); db.close()
let browser, socket, server, serial=0, stopping=false
const pending = new Map(), delay = ms => new Promise(yes=>setTimeout(yes,ms))
const send = (method,params={}) => new Promise((yes,no)=>{
  const id=++serial, timer=setTimeout(()=>{pending.delete(id);no(Error(`CDP timeout ${method}`))},30000)
  pending.set(id,{yes,no,timer});socket.send(JSON.stringify({id,method,params}))
})
const evaluate = async expression => {
  const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true})
  if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value
}
const wait = async expression => {for(let i=0;i<400;i++){if(await evaluate(expression))return;await delay(50)}throw Error(`Timeout ${expression}`)}
const api = (path,input) => evaluate(`(async()=>{const r=await fetch('/api/${path}',{method:${JSON.stringify(input===undefined?'GET':'POST')},headers:{'X-ASTaria-Local':'1','Content-Type':'application/json'},${input===undefined?'':`body:JSON.stringify(${JSON.stringify(input)}),`}});const data=await r.json();if(!r.ok)throw Error(data.error);return data})()`)
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click();true`)
const nav = async label => {
  if(await evaluate("document.querySelector('#home-menu').inert"))await click('.home-brand')
  await evaluate(`{const b=[...document.querySelectorAll('#home-menu button')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing navigation');b.click()}`)
  await delay(1100)
}
const instrument = `{
 const NativeDate=Date;window.Date=class extends NativeDate{constructor(...a){super(...(a.length?a:[NativeDate.parse('${at}')]));}static now(){return NativeDate.parse('${at}')}};
 localStorage.setItem('astaria-sqlite-migration-v1','complete');
 sessionStorage.setItem('astaria-xixi-conversation-v1','main');
 const qa=window.__perf={longTasks:[],encodes:[],rects:0,workerNames:[],localCalls:0,viewportWrites:0};
 new PerformanceObserver(list=>qa.longTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});
 const encode=HTMLCanvasElement.prototype.toDataURL;HTMLCanvasElement.prototype.toDataURL=function(...a){const t=performance.now(),v=encode.apply(this,a);qa.encodes.push({width:this.width,height:this.height,ms:performance.now()-t});return v};
 const rect=Element.prototype.getBoundingClientRect;Element.prototype.getBoundingClientRect=function(...a){qa.rects++;return rect.apply(this,a)};
 const NativeWorker=Worker;window.Worker=class extends NativeWorker{constructor(u,o){super(u,o);qa.workerNames.push(o?.name??String(u))}};
 const post=NativeWorker.prototype.postMessage;NativeWorker.prototype.postMessage=function(message,...args){if(message?.kind==='call')qa.localCalls++;return post.call(this,message,...args)};
 const property=CSSStyleDeclaration.prototype.setProperty;CSSStyleDeclaration.prototype.setProperty=function(name,...args){if(name==='--mobile-viewport-height')qa.viewportWrites++;return property.call(this,name,...args)};
}`
const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).metrics.filter(m=>['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','LayoutCount','RecalcStyleCount'].includes(m.name)).map(m=>[m.name,m.value]))
const measure = async (label,action) => {
  await delay(350);const before=await metrics();await evaluate('window.__perf.encodes=[];window.__perf.longTasks=[];window.__perf.rects=0;window.__perf.localCalls=0;window.__perf.viewportWrites=0;true')
  const start=performance.now();await action();const after=await metrics()
  const data=await evaluate('({longTasks:window.__perf.longTasks,encodes:window.__perf.encodes,rects:window.__perf.rects,localCalls:window.__perf.localCalls,viewportWrites:window.__perf.viewportWrites,render:window.__ASTARIA_P0__?.getSnapshot()})')
  samples.push({label,wallMs:performance.now()-start,metrics:Object.fromEntries(Object.keys(before).map(k=>[k,after[k]-before[k]])),...data})
}
try {
  await mkdir(output,{recursive:true})
  server=await preview({root,configFile:false,build:{outDir:dist},preview:{host:'127.0.0.1',port:0,open:false}})
  const base=`http://127.0.0.1:${server.httpServer.address().port}`
  const profile=join(temporary,'chrome')
  browser=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','about:blank'],{stdio:'ignore'})
  let port;for(let i=0;i<150;i++){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);if(port)break}catch{}await delay(100)}assert.ok(port)
  const target=(await fetch(`http://127.0.0.1:${port}/json`).then(r=>r.json())).find(v=>v.type==='page')
  socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((yes,no)=>{socket.onopen=yes;socket.onerror=no})
  socket.onmessage=event=>{const m=JSON.parse(event.data),entry=pending.get(m.id);if(entry){pending.delete(m.id);clearTimeout(entry.timer);m.error?entry.no(m.error):entry.yes(m.result)}
    if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails)
    if(m.method==='Fetch.requestPaused'){const {requestId,request}=m.params;const allowed=request.url.startsWith(base)||/^(data|blob):/.test(request.url);if(!allowed)network.push(request.url);void send(allowed?'Fetch.continueRequest':'Fetch.failRequest',{requestId,...(allowed?{}:{errorReason:'BlockedByClient'})}).catch(e=>{if(!stopping)errors.push(String(e))})}}
  await send('Page.enable');await send('Runtime.enable');await send('Performance.enable');await send('Fetch.enable',{patterns:[{urlPattern:'*'}]})
  await send('Emulation.setCPUThrottlingRate',{rate:4});await send('Emulation.setTimezoneOverride',{timezoneId:'Asia/Shanghai'})
  await send('Emulation.setUserAgentOverride',{userAgent:process.env.MOBILE_PERF_UA??'Mozilla/5.0 (Linux; Android 12; wv) AppleWebKit/537.36 Chrome/154.0.0.0 Mobile Safari/537.36'})
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:Number(process.env.MOBILE_PERF_DPR??2),mobile:true})
  await send('Page.addScriptToEvaluateOnNewDocument',{source:instrument})
  await send('Page.navigate',{url:base});await wait("!!window.__ASTARIA_P0__ && !!document.querySelector('.home-brand')")
  await api('data/import',{backup,confirmed:true})
  await send('Page.reload');await wait("!!window.__ASTARIA_P0__ && !!document.querySelector('.home-brand') && !document.querySelector('.first-run')")
  await delay(1000)
  const startup=await evaluate('({navigation:performance.getEntriesByType("navigation")[0].toJSON(),longTasks:window.__perf.longTasks,workerNames:window.__perf.workerNames,render:window.__ASTARIA_P0__.getSnapshot()})')
  await writeFile(join(output,'startup.json'),JSON.stringify(startup,null,2))
  await wait(`document.querySelectorAll('#home-xixi .xixi-message').length===${historyTurns*2}`)
  await measure('open-chat',async()=>{await click('.home-launch');await wait("!document.querySelector('#home-xixi').inert && !window.__ASTARIA_P0__.getSnapshot().cameraTransition");await delay(300)})
  const typography=await evaluate(`(()=>{const selectors=['html','.home-workspace','#home-xixi .xixi-conversation','#home-xixi .xixi-markdown p','#home-compose','#home-xixi header strong'];return {width:innerWidth,dpr:devicePixelRatio,viewportScale:visualViewport.scale,items:selectors.map(s=>{const e=document.querySelector(s),c=getComputedStyle(e),r=e.getBoundingClientRect();return {selector:s,fontSize:c.fontSize,lineHeight:c.lineHeight,fontWeight:c.fontWeight,textSizeAdjust:c.webkitTextSizeAdjust,width:r.width,height:r.height}})}})()`)
  await writeFile(join(output,'typography.json'),JSON.stringify(typography,null,2));console.log(JSON.stringify({typography}))
  if(process.env.MOBILE_PERF_TYPOGRAPHY_ONLY==='1') {
    await writeFile(join(output,'typography.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'))
    process.exitCode=0
  } else {
  await measure('typing-30-updates',async()=>{
    for(let i=1;i<=30;i++) {await evaluate(`{const e=document.querySelector('#home-compose');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify('保留完整历史，检查手机输入响应'.repeat(2))}.slice(0,${i}));e.dispatchEvent(new Event('input',{bubbles:true}))}`);await delay(16)}
  })
  for(let i=0;i<2;i++) {
    await measure(`workbench-${i}`,async()=>{await nav('工作台');await wait("document.querySelector('.home-workspace').dataset.page==='workbench'")})
    await measure(`schedule-${i}`,async()=>{await nav('日程');await wait("!!document.querySelector('.planner[data-active=true] .pl-board')")})
    if(i===0){await click('.pl-segment [data-mode=month]');await delay(500)}
    await measure(`free-time-${i}`,async()=>{await nav('余时');await wait("document.querySelector('.home-workspace').dataset.page==='free-time'")})
  }
  await measure('concurrent-planner-reads',async()=>{await evaluate(`Promise.all(Array.from({length:12},()=>fetch('/api/planner',{headers:{'X-ASTaria-Local':'1'}}).then(r=>r.json())))`)})
  await measure('unchanged-viewport-burst',async()=>{await evaluate(`{for(let i=0;i<100;i++)visualViewport.dispatchEvent(new Event('resize'))}`);await delay(100)})
  await nav('首页');if(await evaluate("document.querySelector('#home-xixi').inert"))await click('.home-launch')
  await wait("!document.querySelector('#home-xixi').inert")
  await wait("!!document.querySelector('#home-xixi .xixi-message')")
  await evaluate(`document.querySelector('#home-xixi .xixi-message').scrollIntoView({block:'start'});true`);await delay(200)
  const selectedText=await evaluate(`(()=>{const e=document.querySelector('#home-xixi .xixi-message p'),r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r);const text=s.toString();s.removeAllRanges();return text})()`)
  assert.ok(selectedText.includes('一起核对'));checks.push('offscreen history remains reachable and its full text selectable')
  await evaluate(`{const log=document.querySelector('#home-xixi .xixi-conversation');log.scrollTop=log.scrollHeight}`);await delay(200)
  assert.ok(await evaluate(`(()=>{const m=[...document.querySelectorAll('#home-xixi .xixi-message')].at(-1),log=document.querySelector('#home-xixi .xixi-conversation');if(!m)return false;const r=m.getBoundingClientRect(),p=log.getBoundingClientRect();return r.top<p.bottom&&r.bottom>p.top})()`));checks.push('returning to the latest message keeps scroll and layout reachable')
  const messages=await api('conversation?id=main'),tasks=await api('tasks')
  assert.equal(tasks.length,40);assert.equal(messages.messages.length,120);checks.push('all 40 tasks and 120 original messages preserved')
  assert.deepEqual(errors,[]);assert.deepEqual(network,[]);checks.push('no page exceptions or external requests')
  if(startup.workerNames.includes('astaria-geodesics')) {
    await wait('!window.__ASTARIA_P0__.getSnapshot().cameraTransition')
    const initial=await evaluate(`{document.documentElement.dataset.mobileActive='false';document.dispatchEvent(new Event('astaria-app-activity'));window.__ASTARIA_P0__.getSnapshot().renderedFrames}`)
    await delay(350)
    assert.equal(await evaluate('window.__ASTARIA_P0__.getSnapshot().renderedFrames'),initial)
    await evaluate(`document.documentElement.dataset.mobileActive='true';document.dispatchEvent(new Event('astaria-app-activity'));true`);await delay(350)
    assert.ok(await evaluate(`window.__ASTARIA_P0__.getSnapshot().renderedFrames>${initial}`));checks.push('native inactivity signal stops actual GPU frame submissions and foreground resumes')
  }
  await evaluate(`{const e=window.__ASTARIA_P0__;e.setPaused(true);e.finishCameraTransition();e.simulationTime=42;e.nextFrameAt=0;e.frame(performance.now());e.cancelFrame()}`)
  await delay(100)
  await writeFile(join(output,'chat.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'))
  await writeFile(join(output,'result.json'),JSON.stringify({dist,cpuSlowdown:4,viewport:{width:390,height:844,dpr:2},scope:'Mac Chrome production mobile Worker; not iOS or Android hardware/FPS/power proof',checks,startup,samples,errors,network},null,2))
  console.log(JSON.stringify({output,startupMaxLongTask:Math.max(0,...startup.longTasks.map(v=>v.duration)),samples:samples.map(s=>({label:s.label,scriptMs:s.metrics.ScriptDuration*1000,taskMs:s.metrics.TaskDuration*1000,encodes:s.encodes.length,localCalls:s.localCalls,viewportWrites:s.viewportWrites,maxLongTask:Math.max(0,...s.longTasks.map(v=>v.duration))})),checks}))
  }
} catch(error) {
  const state=await evaluate("({page:document.querySelector('.home-workspace')?.dataset.page,chat:document.querySelector('#home-xixi')?.innerText})").catch(()=>null)
  await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),errors,network,state,samples},null,2))
  throw error
} finally {
 stopping=true;socket?.close();browser?.kill();for(const entry of pending.values())clearTimeout(entry.timer)
 if(server)await new Promise(yes=>server.httpServer.close(yes));await delay(300);await rm(temporary,{recursive:true,force:true})
}
