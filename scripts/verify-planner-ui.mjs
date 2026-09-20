/** Isolated Chromium and in-memory service: never reads personal data or calls a model. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'

const output = process.env.PLANNER_QA_OUTPUT ?? '/tmp/astaria-planner-ui'
const base = process.env.PLANNER_QA_URL ?? 'http://127.0.0.1:5188/'
const db = createDatabase(':memory:')
const physics = db.createTask({ title: '物理报告', due: '2026-09-21', estimateMin: 60, inbox: false })
const robot = db.createTask({ title: '机器人测试', due: '2026-09-22', estimateMin: 90, context: ['desk-mac'], inbox: false })
const words = db.createTask({ title: '英语单词', due: '2026-09-22', estimateMin: 20, inbox: false })
const moved = db.createTask({ title: '已另排的事项', startAt: '2026-09-20T08:00:00+08:00', estimateMin: 30, inbox: false })
const edit = action => db.updatePlanner(action, db.getPlanner().revision)
edit({ type: 'save-routine', routine: { id: 'qa-physics', title: '物理课', kind: 'class', weekdays:[1,3], start:'08:00',end:'08:40',location:'实验室',items:['计算器'],enabled:true } })
edit({ type: 'save-routine', routine: { id: 'qa-free', title: '下午空课', kind: 'available', weekdays:[1,2,3,4,5], start:'14:00',end:'15:40',location:'学校',items:[],enabled:true } })
edit({ type:'save-block', block:{id:'qa-robot-plan',taskId:robot.id,date:'2026-09-21',start:'14:00',end:'15:30',locked:false} })
edit({ type:'save-block', block:{id:'qa-moved-plan',taskId:moved.id,date:'2026-09-23',start:'14:00',end:'14:30',locked:false} })
edit({ type:'save-details',taskId:robot.id,details:{items:['电脑','充电器'],preparation:'今晚给电脑充电，下载测试资料',needsSubmission:false,submittedAt:null} })
edit({ type:'save-details',taskId:physics.id,details:{items:['纸质报告'],preparation:'提前打印实验图表',needsSubmission:true,submittedAt:null} })
db.updateTask(physics.id,{status:'done'})
const service = createLocalService({db,vault:{status:async()=>true},complete:async()=>({choices:[{message:{role:'assistant',content:'我看到了今天的空课，先留一点休息时间'}}]}),dataDirectory:'/isolated-qa'})
const version = await fetch('http://127.0.0.1:9233/json/version').then(r=>r.json())
const ws = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject})
let serial=0,session,contextId
const pending=new Map(),errors=[],checks=[],motionSamples=[],apiRequests=[]
const send=(method,params={},sid=session)=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,...(sid?{sessionId:sid}:{})}))})
function api(request) {
  apiRequests.push({path:new URL(request.url).pathname,method:request.method})
  return new Promise(resolve=>{
    const req=Readable.from(request.postData?[Buffer.from(request.postData)]:[])
    req.url=new URL(request.url).pathname+new URL(request.url).search;req.method=request.method
    req.socket={remoteAddress:'127.0.0.1',localPort:5188}
    req.headers={host:'127.0.0.1:5188',origin:'http://127.0.0.1:5188','x-astaria-local':'1','content-type':'application/json'}
    const res={statusCode:200,setHeader(){},end(body){resolve({status:this.statusCode,body})}}
    service.middleware(req,res,()=>resolve({status:404,body:'{}'}))
  })
}
ws.onmessage=event=>{
  const m=JSON.parse(event.data)
  if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails)
  if(m.method==='Fetch.requestPaused')api(m.params.request).then(r=>send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:r.status,responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Cache-Control',value:'no-store'}],body:Buffer.from(r.body).toString('base64')},m.sessionId)).catch(e=>errors.push(e.message))
  if(!m.id)return
  const cb=pending.get(m.id);pending.delete(m.id);m.error?cb.reject(m.error):cb.resolve(m.result)
}
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const wait=async expression=>{for(let i=0;i<120;i++){if(await evaluate(expression))return;await delay(75)}throw new Error(`Timeout ${expression}`)}
const check=async(name,expression)=>{assert.equal(await evaluate(expression),true,name);checks.push(name)}
const click=async selector=>{
  await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled&&!e.closest('[inert]')})()`)
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'});true`);await delay(220)
  const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();if(!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Occluded '+${JSON.stringify(selector)});return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});await delay(100)
}
const fill=async(selector,value)=>{await click(selector);await evaluate(`document.querySelector(${JSON.stringify(selector)}).select();true`);await send('Input.insertText',{text:value})}
const nav=async(label)=>{await click('.home-brand');await wait('document.querySelector("#home-menu").dataset.open === "true"');const selector=await evaluate(`(()=>{const all=[...document.querySelectorAll('#home-menu button')];const i=all.findIndex(e=>e.textContent===${JSON.stringify(label)});return '#home-menu li:nth-child('+(i+1)+') button'})()`);await click(selector)}
const shot=async(name,settle=true)=>{if(settle)await delay(600);return writeFile(`${output}/${name}.png`,Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'))}
const byText=async(selector,text)=>{
  const found=await evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing text target '+${JSON.stringify(text)});e.dataset.qaClick='target';return true})()`)
  assert.ok(found);await click('[data-qa-click=target]');await evaluate('document.querySelectorAll("[data-qa-click]").forEach(e=>delete e.dataset.qaClick);true')
}
const setField=async(selector,value)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing field');Object.getOwnPropertyDescriptor(e instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e instanceof HTMLSelectElement?'change':'input',{bubbles:true}));return true})()`)
const current='[data-period-current=true]'
const settled=()=>wait('![...document.querySelectorAll(".pl-period-window")].some(e=>e.dataset.moving==="true")')
const beginMotion=async(selector)=>evaluate(`new Promise(resolve=>{document.querySelector(${JSON.stringify(selector)}).click();requestAnimationFrame(()=>requestAnimationFrame(()=>{const w=document.querySelector('.pl-period-window[data-moving=true]'),t=w?.querySelector('.pl-period-track');if(!w||!t){resolve(null);return}window.__qaPeriodAnimations=t.getAnimations();window.__qaPeriodAnimations.forEach(a=>{a.pause();a.currentTime=140});const r=w.getBoundingClientRect();resolve({width:r.width,x:r.x,currentX:w.querySelector('[data-period-current=true]').getBoundingClientRect().x,previousX:w.querySelector('[data-period-current=false]').getBoundingClientRect().x,direction:w.dataset.direction,frames:t.children.length,previousInert:w.querySelector('[data-period-current=false]').inert,previousHidden:w.querySelector('[data-period-current=false]').getAttribute('aria-hidden')})}))})`)
const releaseMotion=()=>evaluate('(window.__qaPeriodAnimations??[]).forEach(a=>a.play());true')
try{
  await mkdir(output,{recursive:true})
  contextId=(await send('Target.createBrowserContext',{},null)).browserContextId
  const target=(await send('Target.createTarget',{url:'about:blank',browserContextId:contextId},null)).targetId
  session=(await send('Target.attachToTarget',{targetId:target,flatten:true},null)).sessionId
  await send('Page.enable');await send('Runtime.enable');await send('Network.setBypassServiceWorker',{bypass:true})
  await send('Fetch.enable',{patterns:[{urlPattern:'*/api/*',requestStage:'Request'}]})
  await send('Emulation.setTimezoneOverride',{timezoneId:'Asia/Shanghai'})
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false})
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`{const NativeDate=Date;window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['2026-09-21T10:00:00+08:00']))}static now(){return new NativeDate('2026-09-21T10:00:00+08:00').getTime()}};localStorage.setItem('astaria-sqlite-migration-v1','complete')}`})
  await send('Page.navigate',{url:base});await wait('!!document.querySelector(".home-brand")')
  await nav('日历');await wait('!!document.querySelector(".pl-calendar-day")')
  await check('calendar opens dark and black-hole theme stays dark','document.querySelector(".planner").dataset.theme==="dark"&&document.querySelector(".p0").dataset.night==="true"')
  await check('month has 42 date cells','document.querySelectorAll(".pl-calendar-day").length===42')
  await check('explicit plan replaces the older task start date',`!document.querySelector('${current} .pl-calendar-day[data-date="2026-09-20"]').textContent.includes('已另排的事项')&&document.querySelector('${current} .pl-calendar-day[data-date="2026-09-23"]').textContent.includes('已另排的事项')`)
  await check('calendar summary has no workbench capacity or carry checklist','!document.querySelector(".pl-calendar-summary .pl-capacity")&&!document.querySelector(".pl-calendar-summary .pl-checklist")&&!document.querySelector(".pl-calendar-summary .pl-submission-row")')
  await check('calendar summary shows focused day task count','document.querySelector(".pl-calendar-summary-focus")?.textContent.includes("项事项")===true')
  await shot('calendar-desktop')
  const monthMotion=await beginMotion('.pl-period button[aria-label="下个月"]');assert.ok(monthMotion);motionSamples.push({name:'next month midpoint',...monthMotion})
  assert.equal(monthMotion.frames,2);assert.equal(monthMotion.previousInert,true);assert.equal(monthMotion.previousHidden,'true')
  assert.ok(Math.abs(monthMotion.currentX-monthMotion.previousX-monthMotion.width)<1);assert.ok(monthMotion.currentX>monthMotion.x&&monthMotion.currentX<monthMotion.x+monthMotion.width)
  checks.push('month moves two complete adjacent pages with inactive old frame');await shot('calendar-motion-midpoint',false);await releaseMotion();await settled();await shot('calendar-next-month')
  await click('.pl-board-toolbar button.pl-secondary');await wait('document.querySelector(".pl-calendar-day[aria-pressed=true]")?.dataset.date==="2026-09-21"')
  await settled();await click(`${current} .pl-calendar-day[data-date="2026-09-22"]`);await check('same-month date selection does not animate the entire period','document.querySelector(".pl-period-window").dataset.moving==="false"')
  await click(`${current} .pl-calendar-day[data-date="2026-09-30"]`)
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39})
  await wait(`document.querySelector('${current} .pl-calendar-day[aria-pressed=true]')?.dataset.date==='2026-10-01'`);await check('keyboard crossing a month moves selection and focus to the new date',`document.activeElement.dataset.date==='2026-10-01'&&document.activeElement.closest('${current}')!==null`);await settled()
  await click('.pl-board-toolbar button.pl-secondary');await settled()
  await evaluate(`new Promise(resolve=>{let i=0;const step=()=>{document.querySelector('.pl-period button[aria-label="下个月"]').click();requestAnimationFrame(()=>{if(++i<3)step();else resolve(true)})};step()})`)
  await check('rapid month requests use final target with only one inert previous page',`document.querySelector('${current} [data-period-key]')?.dataset.periodKey==='month-2026-11'&&document.querySelectorAll('.pl-period-frame').length===2&&document.querySelector('[data-period-current=false]').inert`)
  await check('previous-page buttons cannot acquire keyboard focus',`(()=>{const b=document.querySelector('[data-period-current=false] button');b.focus();return document.activeElement!==b})()`);await settled()
  await check('rapid transition cleans up old frames','document.querySelectorAll(".pl-period-frame").length===1');await click('.pl-board-toolbar button.pl-secondary');await settled()
  await byText('.pl-segment button','周');await check('week view exposes seven days',`document.querySelectorAll('${current} .pl-week-day').length===7`)
  const weekMotion=await beginMotion('.pl-period button[aria-label="下一周"]');assert.ok(weekMotion);motionSamples.push({name:'next week midpoint',...weekMotion});assert.ok(Math.abs(weekMotion.currentX-weekMotion.previousX-weekMotion.width)<1);checks.push('week moves a complete seven-day page');await releaseMotion();await settled()
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await evaluate('document.querySelector(".pl-period button[aria-label=下一周]").click();true');await wait('document.querySelector(".pl-period-window").dataset.moving==="false"');await check('reduced motion swaps period immediately without an inert animation frame','document.querySelectorAll(".pl-period-frame").length===1');await send('Emulation.setEmulatedMedia',{features:[]});await click('.pl-board-toolbar button.pl-secondary');await byText('.pl-segment button','月');await settled()
  await nav('时间表');await wait('!!document.querySelector(".pl-timetable-grid")')
  await check('capacity deducts 90 minute plan from 220 known available minutes','document.querySelector(".pl-capacity-hero strong").textContent==="2 小时 10 分钟"')
  await check('carry includes sources and completed submission item','document.querySelector(".pl-checklist").textContent.includes("计算器")&&document.querySelector(".pl-checklist").textContent.includes("纸质报告")&&document.querySelector(".pl-checklist").textContent.includes("充电器")')
  await click('.pl-check[aria-label="确认已带电脑"]');await wait('document.querySelector(".pl-check[aria-label=取消确认电脑]")?.getAttribute("aria-pressed")==="true"');checks.push('carry checkbox persists in SQLite')
  assert.ok(db.getPlanner().checked['2026-09-21'].includes('电脑'))
  await click('.pl-submission-row button[aria-label="物理报告，确认已提交"]');await wait('document.querySelector(".pl-submission-row").textContent.includes("已提交")');assert.ok(db.getPlanner().details[physics.id].submittedAt);checks.push('submission persists independently from completion')
  await click('.pl-submission-row button[aria-label="物理报告，撤回提交确认"]');await wait('document.querySelector(".pl-submission-row").textContent.includes("还没确认")');checks.push('submission confirmation is reversible')
  await check('evening study appears five times','[...document.querySelectorAll(".pl-slot[data-kind=available]")].filter(e=>e.textContent.includes("晚自习")).length===5')
  await shot('timetable-desktop')
  const timetableMotion=await beginMotion('.pl-period button[aria-label="下一周"]');assert.ok(timetableMotion);motionSamples.push({name:'timetable next week midpoint',...timetableMotion});assert.ok(Math.abs(timetableMotion.currentX-timetableMotion.previousX-timetableMotion.width)<1);checks.push('timetable moves the entire seven-column page');await releaseMotion();await settled();await click('.pl-board-toolbar button.pl-secondary');await settled()
  await click(`${current} .pl-day-column[data-date="2026-09-21"] .pl-slot-edit[aria-label^="编辑空课，下午空课"]`);await wait('!!document.querySelector(".pl-dialog[open]")');await check('available edit remains clickable over a fully overlapping task','document.querySelector(".pl-dialog input").value==="下午空课"');await click('.pl-dialog header button');await delay(230)
  await byText('.pl-header-actions .pl-secondary','添加时段');await wait('!!document.querySelector(".pl-dialog[aria-label=添加每周安排]")')
  await fill('.pl-dialog input[placeholder="例如 物理课、晚自习、通勤"]','QA 晨间整理')
  await setField('.pl-dialog select','break')
  await setField('.pl-dialog .pl-form-pair label:first-child input','06:15');await setField('.pl-dialog .pl-form-pair label:last-child input','06:30')
  await fill('.pl-dialog input[placeholder="可留空"]','书桌');await fill('.pl-dialog input[placeholder="例如 电脑、充电器，用顿号分隔"]','笔记本')
  await click('.pl-dialog button[type=submit]');await wait('!document.querySelector(".pl-dialog")')
  assert.ok(db.getPlanner().routines.some(r=>r.title==='QA 晨间整理'&&r.start==='06:15'&&r.end==='06:30'&&r.kind==='break'&&r.items.includes('笔记本')));checks.push('new weekly routine form persists its time kind and carry items')
  await check('early routine automatically extends the timetable range',`[...document.querySelectorAll('${current} .pl-timetable-ruler span')].some(e=>e.textContent==='06:00')`)
  await click('.pl-disclosure');await byText('.pl-reveal .pl-day-task strong','英语单词');await wait('!!document.querySelector(".pl-dialog[aria-label=事项与安排]")')
  await fill('.pl-dialog input[placeholder="例如 电脑、充电器、纸质报告"]','英语词卡、红笔')
  await fill('.pl-dialog textarea','今晚整理词卡\n把易错词单独标出来')
  await check('preparation textarea stays inside stable dialog scroll gutter','getComputedStyle(document.querySelector(".pl-dialog-body")).scrollbarGutter==="stable"&&document.querySelector(".pl-dialog textarea").getBoundingClientRect().right<document.querySelector(".pl-dialog").getBoundingClientRect().right')
  await click('.pl-dialog form:first-of-type button[type=submit]');await wait('!document.querySelector(".pl-dialog fieldset").disabled');assert.deepEqual(db.getPlanner().details[words.id].items,['英语词卡','红笔']);checks.push('task preparation form persists carry items and multiline notes')
  await click('.pl-dialog form:last-of-type button[type=submit]');await wait('!!document.querySelector(".pl-plan-row")')
  let wordBlock=db.getPlanner().blocks.find(b=>b.taskId===words.id);assert.ok(wordBlock&&wordBlock.start==='18:00'&&wordBlock.end==='18:35');checks.push('unplanned task receives its first explicit 35 minute block')
  await check('planning deducts 35 minutes from selected-day capacity','document.querySelector(".pl-capacity-hero strong").textContent==="1 小时 35 分钟"')
  await click('.pl-plan-row button[title="编辑时段"]');await click('.pl-dialog form:last-of-type input[type=checkbox]');await click('.pl-dialog form:last-of-type button[type=submit]');await wait('document.querySelector(".pl-plan-row").textContent.includes("解锁")');assert.equal(db.getPlanner().blocks.find(b=>b.id===wordBlock.id).locked,true);checks.push('editing a block locks its existing record without creating another block')
  await byText('.pl-plan-row button','解锁');await wait('!!document.querySelector(".pl-plan-row button[title=编辑时段]")');assert.equal(db.getPlanner().blocks.find(b=>b.id===wordBlock.id).locked,false);checks.push('locked plan can be unlocked')
  await shot('task-plan-dialog');await click('.pl-dialog header button');await wait('!document.querySelector(".pl-dialog")');await check('preparation carry items appear once the task is scheduled','document.querySelector(".pl-checklist").textContent.includes("英语词卡")&&document.querySelector(".pl-checklist").textContent.includes("红笔")');await shot('timetable-after-plan')
  await byText('.pl-day-task strong','英语单词');await wait('!!document.querySelector(".pl-dialog")');await click('.pl-plan-row button[title="移除时段"]');assert.ok(db.getPlanner().blocks.some(b=>b.id===wordBlock.id));checks.push('first remove click only requests confirmation')
  await click('.pl-plan-row button[title="确认移除"]');await wait('!document.querySelector(".pl-plan-row")');assert.equal(db.getPlanner().blocks.some(b=>b.id===wordBlock.id),false);checks.push('confirmed removal releases the plan');await check('removal restores capacity','document.querySelector(".pl-capacity-hero strong").textContent==="2 小时 10 分钟"');await click('.pl-dialog header button');await wait('!document.querySelector(".pl-dialog")')
  await click('.pl-slot[data-kind=class]');await wait('!!document.querySelector(".pl-dialog[open]")');await check('routine dialog is compact and scroll track has gutter','document.querySelector(".pl-dialog").getBoundingClientRect().width<=452&&getComputedStyle(document.querySelector(".pl-dialog-body")).scrollbarGutter==="stable"')
  await shot('routine-dialog');await click('.pl-dialog header button');await delay(220);await check('routine dialog closes without a lingering sampling layer','document.querySelector(".pl-dialog")===null')
  await click(`${current} .pl-slot[data-kind=class]`);await wait('!!document.querySelector(".pl-dialog[open]")')
  await fill('.pl-dialog input[placeholder="例如 物理课、晚自习、通勤"]','旧草稿物理课')
  edit({type:'save-routine',routine:{...db.getPlanner().routines.find(r=>r.id==='qa-physics'),title:'另一窗口的物理课',items:['计算器','实验手册']}})
  await evaluate('window.dispatchEvent(new Event("astaria-local-data-change"));true');await wait('!!document.querySelector(".pl-dialog .pl-stale")')
  await check('external routine update preserves draft but blocks its form','document.querySelector(".pl-dialog input").value==="旧草稿物理课"&&document.querySelector(".pl-dialog fieldset").disabled&&document.querySelector(".pl-dialog button[type=submit]").matches(":disabled")')
  const routineConflictRevision=db.getPlanner().revision,routinePostCount=apiRequests.filter(r=>r.path==='/api/planner'&&r.method==='POST').length
  await evaluate('document.querySelector(".pl-dialog form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));true');await delay(160)
  assert.equal(db.getPlanner().revision,routineConflictRevision);assert.equal(db.getPlanner().routines.find(r=>r.id==='qa-physics').title,'另一窗口的物理课');assert.equal(apiRequests.filter(r=>r.path==='/api/planner'&&r.method==='POST').length,routinePostCount);checks.push('stale routine submission cannot overwrite another window')
  await shot('routine-stale');await click('.pl-dialog .pl-stale button');await check('routine explicitly reloads latest content and enables saving','!document.querySelector(".pl-dialog .pl-stale")&&!document.querySelector(".pl-dialog fieldset").disabled&&document.querySelector(".pl-dialog input").value==="另一窗口的物理课"&&[...document.querySelectorAll(".pl-dialog input")].find(e=>e.maxLength===500).value==="计算器、实验手册"')
  await fill('.pl-dialog input[placeholder="例如 物理课、晚自习、通勤"]','核对后的物理课');await click('.pl-dialog button[type=submit]');await wait('!document.querySelector(".pl-dialog")');assert.equal(db.getPlanner().routines.find(r=>r.id==='qa-physics').title,'核对后的物理课');assert.ok(db.getPlanner().routines.find(r=>r.id==='qa-physics').items.includes('实验手册'));checks.push('reloaded routine can save without losing another-window fields')
  await byText('.pl-reveal .pl-day-task strong','英语单词');await wait('!!document.querySelector(".pl-dialog[aria-label=事项与安排]")')
  await fill('.pl-dialog input[placeholder="例如 电脑、充电器、纸质报告"]','旧草稿词卡');await fill('.pl-dialog textarea','还没保存的旧准备')
  edit({type:'save-details',taskId:words.id,details:{items:['另一窗口词卡','橡皮'],preparation:'先下载最新词表',needsSubmission:true,submittedAt:null}})
  await evaluate('window.dispatchEvent(new Event("focus"));true');await wait('!!document.querySelector(".pl-dialog .pl-stale")')
  await check('external task preparation update blocks all draft forms and preserves local typing','document.querySelector(".pl-dialog form:first-of-type input").value==="旧草稿词卡"&&document.querySelector(".pl-dialog textarea").value==="还没保存的旧准备"&&[...document.querySelectorAll(".pl-dialog fieldset")].every(e=>e.disabled)')
  const detailsConflictRevision=db.getPlanner().revision,detailsPostCount=apiRequests.filter(r=>r.path==='/api/planner'&&r.method==='POST').length
  await evaluate('document.querySelector(".pl-dialog form:first-of-type").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));true');await delay(160)
  assert.equal(db.getPlanner().revision,detailsConflictRevision);assert.deepEqual(db.getPlanner().details[words.id].items,['另一窗口词卡','橡皮']);assert.equal(apiRequests.filter(r=>r.path==='/api/planner'&&r.method==='POST').length,detailsPostCount);checks.push('stale task preparation cannot overwrite another window')
  await shot('task-preparation-stale');await click('.pl-dialog .pl-stale button');await check('task preparation explicitly reloads all current fields','!document.querySelector(".pl-dialog .pl-stale")&&document.querySelector(".pl-dialog form:first-of-type input").value==="另一窗口词卡、橡皮"&&document.querySelector(".pl-dialog textarea").value==="先下载最新词表"&&document.querySelector(".pl-dialog form:first-of-type input[type=checkbox]").checked&&!document.querySelector(".pl-dialog fieldset").disabled')
  await fill('.pl-dialog textarea','下载最新词表后打印');await click('.pl-dialog form:first-of-type button[type=submit]');await wait('!document.querySelector(".pl-dialog fieldset").disabled');assert.equal(db.getPlanner().details[words.id].preparation,'下载最新词表后打印');assert.deepEqual(db.getPlanner().details[words.id].items,['另一窗口词卡','橡皮']);assert.equal(db.getPlanner().details[words.id].needsSubmission,true);checks.push('reloaded preparation can save while retaining latest carry and submission state');await click('.pl-dialog header button');await wait('!document.querySelector(".pl-dialog")')
  await click('.pl-header-actions .pl-primary');await wait('!!document.querySelector(".pl-chat")');await fill('#planner-xixi-input','帮我看看今天的空课');await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await wait('document.querySelector(".pl-chat .xixi-conversation").textContent.includes("留一点休息时间")');checks.push('planner chat keeps selected date context')
  await shot('planner-chat');await click('button[aria-label="收起日程析熙"]')
  await nav('日历');await wait('!!document.querySelector(".pl-calendar-day")')
  await check('desktop calendar and details panels align at both top and bottom','(()=>{const a=document.querySelector(".pl-board").getBoundingClientRect(),b=document.querySelector(".pl-calendar-summary").getBoundingClientRect();return Math.abs(a.top-b.top)<1&&Math.abs(a.bottom-b.bottom)<1})()')
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await delay(350);await check('compact page has no viewport horizontal overflow','document.documentElement.scrollWidth<=innerWidth&&document.querySelector(".pl-container").getBoundingClientRect().right<=innerWidth')
  await shot('calendar-compact')
  await byText('.pl-segment button','周');await check('compact week retains all seven columns through inner scrolling','(()=>{const e=document.querySelector(".pl-board-scroll");return e.scrollWidth>e.clientWidth&&document.querySelectorAll("[data-period-current=true] .pl-week-day").length===7&&document.documentElement.scrollWidth<=innerWidth})()');await shot('calendar-week-compact')
  await nav('时间表');await wait('!!document.querySelector(".pl-timetable-grid")');await check('compact timetable retains seven columns without document overflow','(()=>{const e=document.querySelector(".pl-timetable-scroll");return e.scrollWidth>e.clientWidth&&document.querySelectorAll("[data-period-current=true] .pl-day-column").length===7&&document.documentElement.scrollWidth<=innerWidth})()');await shot('timetable-compact')
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await evaluate('document.querySelector(".pl-period button[aria-label=下一周]").click();true');await wait('document.querySelector(".pl-period-window").dataset.moving==="false"');await check('compact reduced-motion timetable has only its final period frame','document.querySelectorAll(".pl-period-frame").length===1');await send('Emulation.setEmulatedMedia',{features:[]})
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await nav('首页');await delay(300);await check('planner stops glass sampling when returning home','document.querySelector(".planner").dataset.active==="false"&&[...document.querySelectorAll(".planner .home-glass-surface")].every(e=>getComputedStyle(e).backdropFilter==="none")')
  assert.deepEqual(errors,[])
  await writeFile(`${output}/results.json`,JSON.stringify({checks,errors,motionSamples,apiRequests},null,2));console.log(`PASS ${checks.length} planner UI checks (${output})`)
}catch(error){await shot('failure').catch(()=>{});await writeFile(`${output}/failure.json`,JSON.stringify({message:error.message,errors,checks},null,2));throw error}
finally{if(contextId)await send('Target.disposeBrowserContext',{browserContextId:contextId},null);ws.close();service.close()}
