/** Isolated Chromium and in-memory service: never reads personal data or calls a model. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'

const output = process.env.PLANNER_MOTION_QA_OUTPUT ?? '/tmp/astaria-planner-motion'
const base = process.env.PLANNER_QA_URL ?? 'http://127.0.0.1:5188/'
const db = createDatabase(':memory:')
const physics = db.createTask({ title: '物理报告', due: '2026-09-21', estimateMin: 60, inbox: false })
const robot = db.createTask({ title: '机器人测试', due: '2026-09-22', estimateMin: 90, context: ['desk-mac'], inbox: false })
const words = db.createTask({ title: '英语单词', due: '2026-09-22', estimateMin: 20, inbox: false })
const moved = db.createTask({ title: '已另排的事项', startAt: '2026-09-20T08:00:00+08:00', estimateMin: 30, inbox: false })
const edit = action => db.updatePlanner(action, db.getPlanner().revision)
// Each kind gets every short duration on a separate day, with real persisted
// routines/blocks. No overlapping fixture can shrink a lane accidentally.
const shortDurations = [10,20,35,40,50]
const compactCases = []
const toTime = minute => `${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`
for (const [kind, day, weekday] of [['class','2026-09-24',4],['available','2026-09-25',5],['plan','2026-09-26',6]]) {
  for (const [index, minutes] of shortDurations.entries()) {
    const startMinute=9*60+index*60, start=toTime(startMinute), end=toTime(startMinute+minutes)
    const title=`${{class:'短课',available:'空课',plan:'计划'}[kind]} ${minutes} 分钟`
    compactCases.push({kind,day,minutes,title,start,end,startMinute})
    if (kind==='plan') {
      const task=db.createTask({title,due:day,estimateMin:minutes,inbox:false})
      edit({type:'save-block',block:{id:`qa-plan-${minutes}`,taskId:task.id,date:day,start,end,locked:false}})
    } else {
      edit({type:'save-routine',routine:{id:`qa-${kind}-${minutes}`,title,kind,weekdays:[weekday],start,end,location:'',items:[],enabled:true}})
    }
  }
}
edit({ type: 'save-routine', routine: { id: 'qa-physics', title: '物理课', kind: 'class', weekdays:[1,3], start:'08:00',end:'08:40',location:'实验室',items:['计算器'],enabled:true } })
edit({ type: 'save-routine', routine: { id: 'qa-free', title: '下午空课', kind: 'available', weekdays:[1,2,3,4,5], start:'14:00',end:'15:40',location:'学校',items:[],enabled:true } })
edit({ type: 'save-routine', routine: { id: 'qa-seconds-capacity', title: '上午空档', kind: 'available', weekdays:[1], start:'09:00',end:'11:00',location:'',items:[],enabled:true } })
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
const pending=new Map(),errors=[],checks=[],motionSamples=[],apiRequests=[],slotSamples=[]
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
const key=async value=>{const virtualKey={Enter:13,Tab:9,Escape:27,Space:32,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40}[value],nativeKey=value==='Space'?' ':value;await send('Input.dispatchKeyEvent',{type:'keyDown',key:nativeKey,code:value,windowsVirtualKeyCode:virtualKey,...(value==='Enter'?{text:'\r'}:value==='Space'?{text:' '}:{})});await send('Input.dispatchKeyEvent',{type:'keyUp',key:nativeKey,code:value,windowsVirtualKeyCode:virtualKey})}
const pointAt=async(selector,x=.5,y=.5)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return{x:r.x+r.width*${x},y:r.y+r.height*${y}}})()`)
const movePointer=async(selector,x=.5,y=.5)=>{await send('Input.dispatchMouseEvent',{type:'mouseMoved',...await pointAt(selector,x,y)});await delay(60)}
const readMaterial=async root=>evaluate(`(()=>{
  const root=document.querySelector(${JSON.stringify(root)}),background=root.querySelector('.wb-background,.pl-background'),glass=root.querySelector('.home-glass-surface'),surface=getComputedStyle(glass),veil=getComputedStyle(background),grid=getComputedStyle(background,'::after');
  return{theme:root.dataset.theme,background:veil.backgroundColor,blur:veil.backdropFilter==='blur(0px)'?'none':veil.backdropFilter,grid: grid.backgroundImage,gridSize:grid.backgroundSize,glass:surface.backgroundColor,tint:surface.getPropertyValue('--glass-tint').trim(),rim:surface.getPropertyValue('--glass-rim').trim()};
})()`)
const observeEntry=()=>evaluate(`(()=>{
  const samples=[],events=[];let start=null,finish=null;
  const snapshot=()=>{const root=document.querySelector('.planner[data-active=true]');if(!root)return;if(root.dataset.entering==='true'){
    start??=performance.now();samples.push({elapsed:performance.now()-start,panes:[...root.querySelectorAll('.pl-scroll,.pl-glass')].map(e=>({className:e.className,opacity:getComputedStyle(e).opacity,transform:getComputedStyle(e).transform}))});
  }else if(start!==null&&finish===null)finish=performance.now();};
  const observer=new MutationObserver(records=>{for(const record of records){if(record.attributeName==='data-entering')events.push({value:record.target.getAttribute('data-entering'),at:performance.now()});}snapshot()});
  observer.observe(document.body,{subtree:true,attributes:true,attributeFilter:['data-entering','data-active']});
  let frame;const tick=()=>{snapshot();frame=requestAnimationFrame(tick)};tick();
  window.__qaFinishEntry=()=>{observer.disconnect();cancelAnimationFrame(frame);snapshot();return{events,samples,duration:start!==null&&finish!==null?finish-start:null,entering:document.querySelector('.planner[data-active=true]')?.dataset.entering??null}};
  return true;
})()`)
const assertNoViewportOverflow=async name=>{
  const geometry=await evaluate(`(()=>{const targets=['html','body','.planner','.pl-scroll','.pl-container','.pl-layout','.pl-page-header','.pl-header-actions'];return{viewport:innerWidth,items:targets.map(selector=>{const e=document.querySelector(selector),r=e.getBoundingClientRect();return{selector,left:r.left,right:r.right,width:r.width,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}})}})()`)
  assert.deepEqual(geometry.items.filter(item=>item.left<-1||item.right>geometry.viewport+1||(['html','body','.pl-scroll'].includes(item.selector)&&item.scrollWidth>item.clientWidth+1)),[],`${name}: no page or header horizontal overflow`)
  motionSamples.push({name:`${name} viewport`,...geometry});checks.push(`${name}: page and toolbar stay within the viewport`)
}
const assertNavigation=async name=>{
  await evaluate('document.querySelector(".home-brand").focus({preventScroll:true});true');await key('Enter');await wait('document.querySelector("#home-menu").dataset.open==="true"');await delay(320)
  const geometry=await evaluate(`(()=>{const box=e=>{const r=e.getBoundingClientRect(),c=getComputedStyle(e);return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,visible:c.visibility!=='hidden'&&Number(c.opacity)>.05}};return{viewport:innerWidth,brand:box(document.querySelector('.home-brand')),menu:box(document.querySelector('#home-menu')),clock:box(document.querySelector('.home-clock'))}})()`)
  assert.ok(geometry.menu.left>=geometry.brand.right-1&&Math.abs(geometry.menu.top-geometry.brand.top)<=12,`${name}: navigation opens beside the brand, never below it`)
  assert.ok(geometry.menu.right<=geometry.viewport+1,`${name}: navigation fits viewport`)
  const intersects=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1
  assert.ok(!geometry.clock.visible||!intersects(geometry.menu,geometry.clock),`${name}: visible clock never overlaps menu`)
  if(geometry.viewport<=600)await check(`${name}: clock uses a compact visible date with a full accessible date`,`getComputedStyle(document.querySelector('.home-clock-short-date')).display!=='none'&&getComputedStyle(document.querySelector('.home-clock-date')).display==='none'&&document.querySelector('.home-clock').getAttribute('aria-label').includes('2026')`)
  const reached=[]
  for(let index=0;index<5;index++){
    await key('Tab');await delay(100)
    const target=await evaluate(`(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),list=document.querySelector('.home-menu-list').getBoundingClientRect();return{text:e.textContent.trim(),menu:Boolean(e.closest('#home-menu')),disabled:e.disabled,left:r.left,right:r.right,visible:r.right>list.left&&r.left<list.right&&!e.closest('[inert]')}})()`)
    assert.ok(target.menu&&!target.disabled&&target.visible,`${name}: navigation item ${index+1} is keyboard reachable and visible`);reached.push(target.text)
  }
  assert.deepEqual(reached,['首页','工作台','时间表','日历','设置'],`${name}: all navigation destinations are keyboard reachable`)
  if(geometry.viewport<=600)await shot(`navigation-${geometry.viewport}-open`)
  await key('Escape');await wait('document.querySelector("#home-menu").dataset.open==="false"');await delay(300)
  await check(`${name}: navigation closes to brand and restores readable clock`,`document.activeElement.matches('.home-brand')&&getComputedStyle(document.querySelector('.home-clock')).visibility!=='hidden'&&Number(getComputedStyle(document.querySelector('.home-clock')).opacity)>.8`)
  motionSamples.push({name:`${name} navigation`,geometry,reached});checks.push(`${name}: horizontal navigation fits beside clock and every menu item supports keyboard access`)
}
const assertNaturalBoard=async(name,kind)=>{
  const scrollBefore=await evaluate('document.querySelector(".pl-scroll").scrollTop')
  const geometry=await evaluate(`(()=>{const board=document.querySelector('.pl-board'),scroll=document.querySelector('.pl-board-scroll'),content=scroll.firstElementChild,terminal=document.querySelector(${JSON.stringify(kind==='timetable'?'.pl-timetable-ruler span:last-child':'.pl-calendar-grid .pl-calendar-day:last-child')}),b=board.getBoundingClientRect(),c=content.getBoundingClientRect(),t=terminal.getBoundingClientRect();return{board:{top:b.top,bottom:b.bottom,height:b.height},content:{top:c.top,bottom:c.bottom,height:c.height},terminal:{top:t.top,bottom:t.bottom,text:terminal.textContent},scroll:{top:scroll.scrollTop,clientHeight:scroll.clientHeight,scrollHeight:scroll.scrollHeight,overflow:getComputedStyle(scroll).overflowY}}})()`)
  assert.ok(geometry.scroll.overflow==='visible'&&geometry.scroll.scrollHeight<=geometry.scroll.clientHeight+2,`${name}: board content has no nested vertical scroll range`)
  assert.ok(geometry.board.bottom>=geometry.content.bottom-1&&geometry.content.bottom>=geometry.terminal.bottom-1,`${name}: the complete board and final row fit its natural height`)
  if(kind==='timetable'){
    assert.equal(geometry.terminal.text,'22:00',`${name}: timetable includes its complete ending hour`)
    await check(`${name}: the ending hour is not clipped by the period window`,`(()=>{const tick=document.querySelector('.pl-timetable-ruler span:last-child').getBoundingClientRect(),clip=document.querySelector('.pl-timetable-board .pl-period-window').getBoundingClientRect();return tick.bottom<=clip.bottom+1})()`)
  }
  await evaluate(`(()=>{const page=document.querySelector('.pl-scroll'),board=document.querySelector('.pl-board'),desired=page.scrollTop+board.getBoundingClientRect().top-page.getBoundingClientRect().top-35;page.scrollTop=Math.max(0,Math.min(desired,page.scrollHeight-page.clientHeight-260));return true})()`);await delay(200)
  const wheelPoint=await evaluate(`(()=>{const r=document.querySelector('.pl-board').getBoundingClientRect(),p=document.querySelector('.pl-scroll').getBoundingClientRect();return{x:Math.min(r.right-20,innerWidth-35),y:Math.min(p.bottom-80,Math.max(p.top+80,r.top+110))}})()`)
  const wheelBefore=await evaluate('document.querySelector(".pl-scroll").scrollTop')
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',...wheelPoint});await send('Input.dispatchMouseEvent',{type:'mouseWheel',...wheelPoint,deltaX:0,deltaY:240});await delay(300)
  const wheelAfter=await evaluate('({page:document.querySelector(".pl-scroll").scrollTop,inner:document.querySelector(".pl-board-scroll").scrollTop})')
  assert.ok(wheelAfter.page>wheelBefore+20&&wheelAfter.inner===0,`${name}: a wheel over the board scrolls the outer page`)
  await evaluate('document.querySelector(".pl-scroll").scrollTop=99999;true');await delay(200)
  const terminalVisible=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(kind==='timetable'?'.pl-timetable-ruler span:last-child':'.pl-calendar-grid .pl-calendar-day:last-child')}),r=e.getBoundingClientRect(),p=document.querySelector('.pl-scroll').getBoundingClientRect();return{top:r.top,bottom:r.bottom,viewportTop:p.top,viewportBottom:p.bottom}})()`)
  assert.ok(terminalVisible.top>=terminalVisible.viewportTop-1&&terminalVisible.bottom<=terminalVisible.viewportBottom+1,`${name}: final hour or date row can be read at the page bottom`)
  await shot(`${kind}-${name.split('px')[0]}-page-bottom`,false)
  if(kind==='timetable'&&await evaluate('innerWidth<768')){
    await evaluate('document.querySelector(".pl-timetable-scroll").scrollLeft=99999;true');await delay(100)
    await check(`${name}: narrow timetable keeps horizontal-only scrolling`,`document.querySelector('.pl-timetable-scroll').scrollLeft>0&&document.querySelector('.pl-timetable-scroll').scrollTop===0&&document.querySelector('.pl-board-scroll').scrollTop===0`)
    await evaluate('document.querySelector(".pl-timetable-scroll").scrollLeft=0;true')
  }
  motionSamples.push({name:`${name} natural board`,geometry,wheelBefore,wheelAfter,terminalVisible});checks.push(`${name}: complete ${kind} scrolls with its outer page through the final row`)
  await evaluate(`document.querySelector('.pl-scroll').scrollTop=${scrollBefore};true`);await delay(200)
}
const assertEntry=async name=>{
  const sample=await evaluate('window.__qaFinishEntry()');motionSamples.push({name,...sample})
  assert.ok(sample.samples.length>=2,`${name}: entry was sampled while active`)
  assert.equal(sample.entering,null,`${name}: entry marker is released`)
  // Mutation delivery/rAF can trail the 420ms timeout by a single busy frame.
  assert.ok(sample.duration!==null&&sample.duration<=470,`${name}: the 420ms entry ends without lingering`)
  assert.deepEqual(sample.samples.flatMap(frame=>frame.panes.filter(pane=>pane.opacity!=='1'||pane.transform!=='none')),[],`${name}: glass sampling ancestors stay opaque and untransformed`)
  checks.push(`${name}: entry clears after its 420ms window while glass sampling ancestors stay stable`)
}
const current='[data-period-current=true]'
const settled=()=>wait('![...document.querySelectorAll(".pl-period-window")].some(e=>e.dataset.moving==="true")')
const beginMotion=async(selector)=>evaluate(`new Promise(resolve=>{document.querySelector(${JSON.stringify(selector)}).click();requestAnimationFrame(()=>requestAnimationFrame(()=>{const w=document.querySelector('.pl-period-window[data-moving=true]'),t=w?.querySelector('.pl-period-track');if(!w||!t){resolve(null);return}window.__qaPeriodAnimations=t.getAnimations();window.__qaPeriodAnimations.forEach(a=>{a.pause();a.currentTime=140});const r=w.getBoundingClientRect();resolve({width:r.width,x:r.x,currentX:w.querySelector('[data-period-current=true]').getBoundingClientRect().x,previousX:w.querySelector('[data-period-current=false]').getBoundingClientRect().x,direction:w.dataset.direction,frames:t.children.length,previousInert:w.querySelector('[data-period-current=false]').inert,previousHidden:w.querySelector('[data-period-current=false]').getAttribute('aria-hidden')})}))})`)
const releaseMotion=()=>evaluate('(window.__qaPeriodAnimations??[]).forEach(a=>a.play());true')
// Geometry assertions are not evidence of compositor smoothness or absence
// of flicker. This samples DOM layout and computed colors only.
const sampleShortSlots=()=>evaluate(`(${function(cases) {
  const frame=document.querySelector('[data-period-current=true] .pl-timetable-page')
  const grid=frame.querySelector('.pl-timetable-grid').getBoundingClientRect()
  const ruler=[...frame.querySelectorAll('.pl-timetable-ruler span')].map(e=>e.textContent.trim())
  const minute=text=>Number(text.slice(0,2))*60+Number(text.slice(3,5))
  const start=minute(ruler[0]),end=minute(ruler.at(-1))
  const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}
  const visible=e=>e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden'
  return cases.map(item=>{
    const day=frame.querySelector(`.pl-day-column[data-date="${item.day}"]`)
    const slot=[...day.querySelectorAll('.pl-slot')].find(e=>e.dataset.kind===item.kind&&e.querySelector('strong')?.textContent===item.title)
    if(!slot)return {...item,missing:true}
    const target=slot
    const fullLabel=Boolean(target&&[target.getAttribute('aria-label'),target.getAttribute('title')].every(label=>label?.includes(item.title)&&label.includes(`${item.start}–${item.end}`)&&label.includes({class:'课程',available:'空课',plan:'任务安排'}[item.kind])))
    const rect=box(slot),children=[...slot.querySelectorAll('strong,small')].filter(visible).map(e=>({type:e.tagName,className:e.className,...box(e)}))
    const time=slot.querySelector('.pl-slot-time'),title=slot.querySelector('strong')
    const timeRect=visible(time)?box(time):null,titleRect=visible(title)?box(title):null
    const overlap=Boolean(timeRect&&titleRect&&Math.min(timeRect.right,titleRect.right)-Math.max(timeRect.left,titleRect.left)>1&&Math.min(timeRect.bottom,titleRect.bottom)-Math.max(timeRect.top,titleRect.top)>1)
    const textInside=children.every(r=>r.left>=rect.left-1&&r.right<=rect.right+1&&r.top>=rect.top-1&&r.bottom<=rect.bottom+1)
    const expectedTop=grid.top+(item.startMinute-start)/(end-start)*grid.height
    const rgb=(getComputedStyle(slot).backgroundColor.match(/[0-9]+(?:[.][0-9]+)?/g)||[]).map(Number)
    return {...item,rect,children,timeRect,titleRect,titleVisible:Boolean(titleRect&&titleRect.width>0&&titleRect.height>0),fullLabel,textInside,overlap,expectedTop,topDelta:rect.top-expectedTop,rgb}
  })
}.toString()})(${JSON.stringify(compactCases)})`)
try{
  await mkdir(output,{recursive:true})
  contextId=(await send('Target.createBrowserContext',{},null)).browserContextId
  const target=(await send('Target.createTarget',{url:'about:blank',browserContextId:contextId},null)).targetId
  session=(await send('Target.attachToTarget',{targetId:target,flatten:true},null)).sessionId
  await send('Page.enable');await send('Runtime.enable');await send('Network.setBypassServiceWorker',{bypass:true})
  await send('Fetch.enable',{patterns:[{urlPattern:'*/api/*',requestStage:'Request'}]})
  await send('Emulation.setTimezoneOverride',{timezoneId:'Asia/Shanghai'})
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false})
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`{const NativeDate=Date;window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['2026-09-21T10:00:37+08:00']))}static now(){return new NativeDate('2026-09-21T10:00:37+08:00').getTime()}};localStorage.setItem('astaria-sqlite-migration-v1','complete')}`})
  await send('Page.navigate',{url:base});await wait('!!document.querySelector(".home-brand")')
  await nav('工作台');await wait('!!document.querySelector(".workbench[data-active=true] .home-glass-surface")');await delay(600)
  const workbenchMaterial=await readMaterial('.workbench[data-active=true]');motionSamples.push({name:'workbench material reference',...workbenchMaterial});await shot('workbench-reference-dark')
  await observeEntry();await nav('日历');await wait('!!document.querySelector(".pl-calendar-day")');await delay(450)
  await assertEntry('calendar page activation')
  const plannerMaterial=await readMaterial('.planner[data-active=true]');motionSamples.push({name:'planner material comparison',...plannerMaterial})
  assert.deepEqual(plannerMaterial,workbenchMaterial,'planner shares workbench outer glass tint, veil, blur and grid')
  checks.push('planner outer material and background match the workbench reference')
  await check('calendar opens dark and black-hole theme stays dark','document.querySelector(".planner").dataset.theme==="dark"&&document.querySelector(".p0").dataset.night==="true"')
  await check('month has 42 date cells','document.querySelectorAll(".pl-calendar-day").length===42')
  await check('explicit plan replaces the older task start date',`!document.querySelector('${current} .pl-calendar-day[data-date="2026-09-20"]').textContent.includes('已另排的事项')&&document.querySelector('${current} .pl-calendar-day[data-date="2026-09-23"]').textContent.includes('已另排的事项')`)
  await check('initially completed calendar tasks do not pulse','![...document.querySelectorAll(".planner [data-done=true]")].some(e=>e.dataset.statusPulse==="true")')
  const hoverDay=`${current} .pl-calendar-day[data-date="2026-09-21"]`
  await evaluate(`document.querySelector(${JSON.stringify(hoverDay)}).scrollIntoView({block:'nearest'});true`);await delay(250)
  await movePointer(`${hoverDay} .pl-calendar-date>span`)
  await check('calendar child pointer selects only its nearest glass plate',`document.querySelector(${JSON.stringify(hoverDay)}).dataset.hovered==="true"&&document.querySelectorAll('.planner [data-hovered=true]').length===1`)
  const hoverBefore=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(hoverDay)});return{x:e.style.getPropertyValue('--pl-pointer-x'),y:e.style.getPropertyValue('--pl-pointer-y')}})()`)
  await movePointer(hoverDay,.7,.6)
  const hoverAfter=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(hoverDay)});return{x:e.style.getPropertyValue('--pl-pointer-x'),y:e.style.getPropertyValue('--pl-pointer-y')}})()`)
  assert.ok(hoverBefore.x!==hoverAfter.x&&hoverBefore.y!==hoverAfter.y,'pointer coordinates follow movement inside the same date cell')
  checks.push('hover glow follows both pointer coordinates inside a date cell');motionSamples.push({name:'calendar hover tracking',before:hoverBefore,after:hoverAfter})
  await delay(220)
  const hoverVisual=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(hoverDay)}),before=getComputedStyle(e,'::before'),after=getComputedStyle(e,'::after');return{washOpacity:Number(before.opacity),rimOpacity:Number(after.opacity),washZ:Number(before.zIndex),rimZ:Number(after.zIndex),text:[...e.querySelectorAll('.pl-calendar-date,.pl-calendar-entries,.pl-calendar-capacity')].map(t=>({name:t.className,position:getComputedStyle(t).position,z:Number(getComputedStyle(t).zIndex)}))}})()`)
  assert.ok(hoverVisual.washOpacity>.8&&hoverVisual.rimOpacity>.8,'hover paints both the soft light and edge highlight')
  assert.ok(hoverVisual.text.every(t=>t.position!=='static'&&t.z>Math.max(hoverVisual.washZ,hoverVisual.rimZ)),'readable calendar text paints above the hover wash')
  motionSamples.push({name:'calendar hover computed appearance',...hoverVisual});checks.push('hover light and edge are visibly rendered beneath readable text')
  await shot('calendar-glass-hover',false)
  await evaluate(`(()=>{const e=document.querySelector('.pl-scroll');window.__qaHoverScroll=e.scrollTop;e.scrollTop=e.scrollTop>0?e.scrollTop-16:e.scrollTop+16;return true})()`);await delay(80)
  await check('scrolling clears the previous hover and pointer coordinates',`!document.querySelector('.planner [data-hovered=true]')&&document.querySelector(${JSON.stringify(hoverDay)}).style.getPropertyValue('--pl-pointer-x')===''&&document.querySelector(${JSON.stringify(hoverDay)}).style.getPropertyValue('--pl-pointer-y')===''`)
  await evaluate('document.querySelector(".pl-scroll").scrollTop=window.__qaHoverScroll;true');await delay(100)
  await observeEntry();await click(`${current} .pl-calendar-day[data-date="2026-09-22"]`);await delay(450)
  const dateEntry=await evaluate('window.__qaFinishEntry()');assert.equal(dateEntry.samples.length,0);assert.equal(dateEntry.events.length,0);checks.push('choosing another calendar date does not restart page entry')
  const statusTarget=()=>`[...document.querySelectorAll('.pl-calendar-summary-task')].find(e=>e.textContent.includes('机器人测试'))`
  await evaluate(`(()=>{window.__qaStatusTarget=${statusTarget()};window.__qaStatusTarget.scrollIntoView({block:'nearest'});return true})()`);await delay(300)
  await check('completion fixture begins on an existing unfinished card',`window.__qaStatusTarget?.dataset.done==='false'&&window.__qaStatusTarget.isConnected`)
  db.updateTask(robot.id,{status:'done'});await evaluate("window.dispatchEvent(new Event('astaria-local-data-change'));true")
  await wait(`window.__qaStatusTarget.dataset.done==='true'`)
  await check('real task completion pulses the existing visible glass card',`window.__qaStatusTarget===${statusTarget()}&&window.__qaStatusTarget.dataset.statusPulse==='true'`)
  await delay(650);await check('completion pulse clears after 600ms','!window.__qaStatusTarget.hasAttribute("data-status-pulse")')
  db.updateTask(robot.id,{status:'todo'});await evaluate("window.dispatchEvent(new Event('astaria-local-data-change'));true");await wait("window.__qaStatusTarget.dataset.done==='false'")
  await click(`${current} .pl-calendar-day[data-date="2026-09-21"]`)
  await observeEntry();await nav('时间表');await wait('!!document.querySelector(".pl-timetable-grid")');await delay(450)
  await assertEntry('calendar to timetable switch')
  await check('capacity labels remain integral when the current time includes seconds',`(()=>{const labels=[...document.querySelectorAll('.pl-timetable-capacity,.pl-capacity-hero,.pl-capacity-detail')].map(e=>[e.textContent,e.title,e.getAttribute('aria-label')].filter(Boolean).join(' '));return new Date().getSeconds()===37&&labels.length>0&&labels.every(text=>!/[0-9]+\\.[0-9]+/.test(text))})()`)
  for (const theme of ['dark','light']) {
    if (theme==='light') { await click('.pl-header-actions .pl-icon-button'); await delay(300) }
    const samples=await sampleShortSlots()
    slotSamples.push({theme,samples})
    const missing=samples.filter(sample=>sample.missing)
    assert.deepEqual(missing,[],`${theme}: all 15 short slots exist`)
    checks.push(`${theme}: 10/20/35/40/50 minute class, available and plan fixtures all render`)
    const labelFailures=samples.filter(sample=>!sample.fullLabel)
    assert.deepEqual(labelFailures,[],`${theme}: full kind/title/time labels are accessible`)
    checks.push(`${theme}: all short slots expose complete labels`)
    const boundsFailures=samples.filter(sample=>!sample.textInside||!sample.titleVisible)
    assert.deepEqual(boundsFailures,[],`${theme}: visible slot text stays inside card bounds`)
    checks.push(`${theme}: all short slot text stays inside bounds with a visible title`)
    const overlapFailures=samples.filter(sample=>sample.overlap)
    assert.deepEqual(overlapFailures,[],`${theme}: time and title do not overlap`)
    checks.push(`${theme}: short slot titles and times do not overlap`)
    const alignmentFailures=samples.filter(sample=>Math.abs(sample.topDelta)>1)
    assert.deepEqual(alignmentFailures,[],`${theme}: slot top matches actual start time`)
    checks.push(`${theme}: each short slot top matches actual time within 1px`)
    const colorFailures=samples.filter(sample=>sample.kind==='plan'&&!(sample.rgb[2]>=sample.rgb[1]))
    assert.deepEqual(colorFailures,[],`${theme}: plan surfaces are neutral cool (B >= G)`)
    checks.push(`${theme}: every plan surface is neutral cool`)
    await check(`${theme}: covered availability label yields to a planned task while keeping full accessible details`, `(()=>{
      const day=document.querySelector('${current} .pl-day-column[data-date="2026-09-26"]'),slot=day.querySelector('button.pl-slot[data-kind=available][data-title-covered=true]');
      return Boolean(slot&&getComputedStyle(slot.querySelector('strong')).visibility==='hidden'&&slot.title.includes('空课')&&slot.title.includes('09:00')&&slot.getAttribute('aria-label')?.includes('09:00'));
    })()`)
  }
  await click('.pl-header-actions .pl-icon-button');await delay(300)
  await check('availability is one native edit button per slot without repeated pencil controls',`(()=>{const slots=[...document.querySelectorAll('${current} .pl-slot[data-kind=available]')];return slots.length>0&&slots.every(e=>e.matches('button[type=button]')&&!e.querySelector('button,svg'))&&!document.querySelector('.pl-slot-edit')})()`)
  const editAvailable=`${current} .pl-day-column[data-date="2026-09-25"] button.pl-slot[data-kind=available][data-density=medium]`
  const overlapPlan=`${current} .pl-day-column[data-date="2026-09-26"] button.pl-slot[data-kind=plan][data-density=tiny]`
  const slotScroll=await evaluate('document.querySelector(".pl-scroll").scrollTop')
  await evaluate(`document.querySelector(${JSON.stringify(editAvailable)}).scrollIntoView({block:'center'});document.activeElement.blur();true`)
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:4,y:4});await delay(300)
  const readAvailableRim=()=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(editAvailable)}),s=getComputedStyle(e);return{color:s.borderTopColor,width:parseFloat(s.borderTopWidth),style:s.borderTopStyle,shadow:s.boxShadow,outline:s.outlineColor,outlineStyle:s.outlineStyle}})()`)
  const restingRim=await readAvailableRim()
  assert.ok(restingRim.style==='solid'&&(restingRim.width>=1.5||(restingRim.width>=1&&restingRim.shadow.includes('inset')&&restingRim.shadow.includes('0px 0px 0px 1px'))),'availability uses a visibly stronger continuous edit rim without growing the slot')
  const gold=(restingRim.color.match(/[0-9]+(?:[.][0-9]+)?/g)||[]).map(Number)
  assert.ok(gold[0]>=gold[1]&&gold[1]>gold[2],'availability rim uses a warm gold tone')
  await movePointer(editAvailable);await delay(250)
  const hoverRim=await readAvailableRim();assert.notEqual(hoverRim.color,restingRim.color,'hover strengthens availability rim')
  motionSamples.push({name:'availability edit rim',resting:restingRim,hover:hoverRim});checks.push('availability has a stronger gold edit rim with visible hover feedback')
  await shot('timetable-availability-hover',false)
  await click(editAvailable);await wait('!!document.querySelector(".pl-dialog[open]")')
  const correctRoutine=`document.querySelector('.pl-dialog').getAttribute('aria-label')==='编辑每周安排'&&document.querySelector('.pl-dialog .pl-form input').value==='空课 40 分钟'&&document.querySelector('.pl-dialog select').value==='available'`
  await check('clicking the whole availability card opens its own routine editor',correctRoutine)
  await click('.pl-dialog-header button');await wait('!document.querySelector(".pl-dialog")')
  for(const activation of ['Enter','Space']){
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:4,y:4})
    await evaluate(`document.querySelector(${JSON.stringify(editAvailable)}).focus({preventScroll:true});true`)
    // Tab away/back establishes keyboard focus modality without invoking a click.
    await key('Tab');await evaluate(`document.querySelector(${JSON.stringify(editAvailable)}).focus({preventScroll:true});true`);await delay(250)
    const focusRim=await readAvailableRim()
    assert.ok(focusRim.color!==restingRim.color||focusRim.outlineStyle!=='none',`${activation}: keyboard focus exposes an edit cue`)
    await key(activation);await wait('!!document.querySelector(".pl-dialog[open]")')
    await check(`${activation} opens the focused availability card editor`,correctRoutine)
    await key('Escape');await wait('!document.querySelector(".pl-dialog")')
  }
  await click(overlapPlan);await wait('!!document.querySelector(".pl-dialog[open]")')
  await check('a plan overlapping availability remains the top clickable task',`document.querySelector('.pl-dialog').getAttribute('aria-label')==='事项与安排'&&document.querySelector('.pl-dialog-task-title').textContent==='计划 10 分钟'`)
  await click('.pl-dialog-header button');await wait('!document.querySelector(".pl-dialog")')
  await evaluate(`document.querySelector('.pl-scroll').scrollTop=${slotScroll};document.activeElement.blur();true`);await delay(200)

  const readPanes=()=>evaluate(`([...document.querySelectorAll('.pl-overview,.pl-layout>.pl-glass,.pl-chat-column>.pl-glass')].map(e=>{const r=e.getBoundingClientRect();return {kind:[...e.classList].find(c=>['pl-board','pl-day-panel','pl-calendar-summary','pl-chat'].includes(c)),x:r.x,y:r.y+document.querySelector('.pl-scroll').scrollTop,width:r.width,height:r.height,right:r.right,bottom:r.bottom+document.querySelector('.pl-scroll').scrollTop,inert:e.inert||Boolean(e.closest('[inert]')),position:getComputedStyle(e).position}}))`)
  const readScrollGeometry=()=>evaluate('(()=>{const q=s=>{const e=document.querySelector(s),r=e.getBoundingClientRect(),c=getComputedStyle(e);return {x:r.x,width:r.width,scrollLeft:e.scrollLeft,scrollTop:e.scrollTop,clientWidth:e.clientWidth,offsetWidth:e.offsetWidth,scrollWidth:e.scrollWidth,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,scrollbarGutter:c.scrollbarGutter,scrollbarWidth:c.scrollbarWidth,marginLeft:c.marginLeft,marginRight:c.marginRight,paddingLeft:c.paddingLeft,paddingRight:c.paddingRight,overflowX:c.overflowX,overflowY:c.overflowY,colorScheme:c.colorScheme}};return {scroll:q(".pl-scroll"),container:q(".pl-container"),layout:q(".pl-layout")}})()')
  const assertBoardAndChat=async name=>{
    const panes=await readPanes()
    assert.equal(panes.length,3,`${name}: overview, board and chat are present`)
    const overview=panes.find(p=>p.kind==='pl-day-panel'||p.kind==='pl-calendar-summary'),board=panes.find(p=>p.kind==='pl-board'),chat=panes.find(p=>p.kind==='pl-chat')
    assert.ok(panes.every(p=>!p.inert&&p.position!=='fixed'&&p.position!=='absolute'),`${name}: all panes participate in layout and remain interactive`)
    assert.ok(overview.bottom<=board.y+1&&board.right<=chat.x,`${name}: overview sits above non-overlapping board and chat`)
    assert.ok(Math.abs(board.y-chat.y)<1&&Math.abs(board.bottom-chat.bottom)<1,`${name}: board and chat share top and bottom edges`)
    assert.ok(Math.abs(overview.x-board.x)<1&&Math.abs(overview.right-chat.right)<1,`${name}: overview spans both lower columns`)
    assert.ok(chat.width>=260,`${name}: conversation has readable width`)
    await check(`${name}: overview stays live and legacy side switches are absent`, `!document.querySelector('.pl-overview').inert&&document.querySelector('.pl-overview').getAttribute('aria-hidden')!=='true'&&!document.querySelector('.pl-aux-switch')`)
    checks.push(`${name}: full-width overview stays above aligned board and chat columns`)
    motionSamples.push({name,panes})
  }
  const assertOverview=async name=>{
    await check(`${name}: overview is before the full-width board`, `(()=>{const overview=document.querySelector('.pl-overview'),board=document.querySelector('.pl-board'),layout=document.querySelector('.pl-layout'),o=overview.getBoundingClientRect(),b=board.getBoundingClientRect(),c=document.querySelector('.pl-container').getBoundingClientRect();return Boolean(overview.compareDocumentPosition(layout)&Node.DOCUMENT_POSITION_FOLLOWING)&&!layout.contains(overview)&&o.bottom<=b.top+1&&Math.abs(o.left-c.left)<1&&Math.abs(o.right-c.right)<1&&Math.abs(b.left-c.left)<1&&Math.abs(b.right-c.right)<1&&!overview.inert})()`)
  }
  const sameWeekMotion=await evaluate(`new Promise(resolve=>{
    document.querySelector('${current} .pl-timetable-date[data-date="2026-09-22"]').click();
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      const targets={date:document.querySelector('${current} .pl-timetable-date[data-date="2026-09-22"]'),column:document.querySelector('${current} .pl-day-column[data-date="2026-09-22"]'),header:document.querySelector('.pl-day-header h3'),details:document.querySelector('.pl-side-scroll')};
      window.__qaDateAnimations=[];
      const animations=Object.fromEntries(Object.entries(targets).map(([key,e])=>{const a=e?.getAnimations({subtree:true})??[];window.__qaDateAnimations.push(...a);return[key,a.map(animation=>({name:animation.animationName??animation.transitionProperty,duration:animation.effect?.getTiming().duration}))]}));
      window.__qaDateAnimations.forEach(a=>{a.pause();a.currentTime=100});
      resolve({animations,periodMoving:document.querySelector('.pl-period-window').dataset.moving,selected:targets.date?.getAttribute('aria-pressed'),columnSelected:targets.column?.dataset.selected,header:targets.header?.textContent});
    }));
  })`)
  motionSamples.push({name:'same-week date selection',...sameWeekMotion})
  assert.equal(sameWeekMotion.periodMoving,'false');assert.equal(sameWeekMotion.selected,'true');assert.equal(sameWeekMotion.columnSelected,'true')
  assert.ok(sameWeekMotion.header.includes('9月22日'))
  for (const [name,animations] of Object.entries(sameWeekMotion.animations)) assert.ok(animations.some(a=>typeof a.duration==='number'&&a.duration>50),`${name} has visible date-change motion`)
  checks.push('same-week date animates its header, column, date label and details without moving the week')
  await shot('timetable-date-midpoint',false)
  await evaluate('(window.__qaDateAnimations??[]).forEach(a=>a.play());true');await delay(400)
  await check('completed date change leaves one live side-content panel','document.querySelectorAll(".pl-side-scroll").length===1&&document.querySelectorAll(".pl-period-frame").length===1')
  await evaluate(`window.__qaOverviewNext=document.querySelector('.pl-overview button[aria-label="后一天"]');window.__qaOverviewNext.focus({preventScroll:true});true`)
  await key('Enter');await delay(350)
  await check('overview next-day keyboard activation preserves its navigation button',`document.activeElement===window.__qaOverviewNext&&window.__qaOverviewNext.isConnected&&document.querySelector('.pl-day-header h3').textContent.includes('9月23日')`)
  await key('Enter');await delay(350)
  await check('overview next-day supports repeated Enter without refocusing',`document.activeElement===window.__qaOverviewNext&&document.querySelector('.pl-day-header h3').textContent.includes('9月24日')`)
  await click(`${current} .pl-timetable-date[data-date="2026-09-21"]`);await delay(400)
  await wait('getComputedStyle(document.querySelector(".pl-scroll")).scrollbarGutter.includes("stable")');await delay(150)
  const before=await readPanes()
  motionSamples.push({name:'pre-chat-layout-diagnostic',panes:before,scrollDiag:await readScrollGeometry()})
  const glassResize=await evaluate(`new Promise(resolve=>{
    const layout=document.querySelector('.pl-layout'),maps={},samples=[];
    const observer=new MutationObserver(records=>{for(const record of records){if(record.type==='attributes'&&record.target.tagName.toLowerCase()==='feimage'&&record.attributeName==='href'){const panel=record.target.closest('.pl-glass'),kind=[...panel.classList].find(c=>['pl-board','pl-day-panel','pl-calendar-summary','pl-chat'].includes(c));maps[kind]=(maps[kind]??0)+1}}});
    observer.observe(layout,{attributes:true,subtree:true,attributeFilter:['href']});
    document.querySelector('.pl-header-actions .pl-primary').click();const start=performance.now();
    const tick=()=>{samples.push({elapsed:performance.now()-start,panels:[...layout.querySelectorAll('.pl-glass')].map(panel=>{const host=panel.querySelector('.home-glass-measure'),svg=host?.querySelector('svg'),r=host?.getBoundingClientRect(),s=svg?.getBoundingClientRect();return{kind:[...panel.classList].find(c=>['pl-board','pl-day-panel','pl-calendar-summary','pl-chat'].includes(c)),host:r?.width??null,svg:s?.width??null,height:r?.height??null,svgHeight:s?.height??null}})});if(performance.now()-start<650)requestAnimationFrame(tick);else{observer.disconnect();resolve({maps,samples})}};requestAnimationFrame(tick);
  })`)
  motionSamples.push({name:'glass viewport during chat expansion',...glassResize})
  assert.ok(glassResize.samples.length>=8,'sampled chat expansion across multiple frames')
  assert.deepEqual(glassResize.samples.flatMap(sample=>sample.panels.filter(panel=>panel.host>0&&(!Number.isFinite(panel.svg)||Math.abs(panel.host-panel.svg)>1||Math.abs(panel.height-panel.svgHeight)>1))),[],'SVG glass viewport follows live pane dimensions throughout resize')
  assert.ok(Object.values(glassResize.maps).every(count=>count<=3),'edge maps update only after settling, not every frame')
  checks.push('glass SVG viewport follows pane dimensions while edge maps avoid per-frame rebuilds')
  await wait('!!document.querySelector(".pl-chat")');await delay(150)
  await assertBoardAndChat('desktop timetable chat')
  const expandedSlots=await sampleShortSlots();slotSamples.push({theme:'dark-board-chat',samples:expandedSlots})
  assert.deepEqual(expandedSlots.filter(sample=>sample.missing||!sample.textInside||!sample.titleVisible||sample.overlap||Math.abs(sample.topDelta)>1),[], 'board/chat layout preserves short-slot labels and time alignment')
  checks.push('short-slot text remains readable and correctly aligned beside the open chat')
  await check('open conversation and outer pane retain active glass','document.querySelector(".pl-chat>.home-glass-measure .home-glass-surface")!==null&&getComputedStyle(document.querySelector(".pl-chat>.home-glass-measure .home-glass-surface")).backdropFilter!=="none"')
  await fill('#planner-xixi-input','帮我看看今天的空课');await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await wait('document.querySelector(".pl-chat .xixi-conversation").textContent.includes("留一点休息时间")')
  await check('settled chat keeps its outer shadow unclipped','document.querySelector(".pl-chat-column").dataset.settled==="true"&&getComputedStyle(document.querySelector(".pl-chat-column")).overflow==="visible"')
  await shot('timetable-overview-chat-dark')
  await click('.pl-header-actions .pl-icon-button');await delay(350);await shot('timetable-overview-chat-light')
  await click('.pl-header-actions .pl-icon-button');await delay(350)
  await evaluate(`new Promise(resolve=>{document.querySelector('button[aria-label="收起日程析熙"]').click();setTimeout(()=>{document.querySelector('.pl-header-actions .pl-primary').click();resolve(true)},90)})`);await delay(650)
  await assertBoardAndChat('rapid close then reopen')
  await check('rapid close then reopen retains a single active chat with live glass','document.querySelectorAll(".pl-chat").length===1&&!document.querySelector(".pl-chat").closest("[inert]")&&getComputedStyle(document.querySelector(".pl-chat .home-glass-surface")).backdropFilter!=="none"')
  const closing=await evaluate(`new Promise(resolve=>{
    document.querySelector('button[aria-label="收起日程析熙"]').click();
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      const column=document.querySelector('.pl-chat-column'),chat=document.querySelector('.pl-chat');
      if(!chat){resolve({present:false});return}
      const animations=[...column.getAnimations(),...chat.getAnimations()];
      const opacityAnimations=animations.filter(a=>a.effect?.getKeyframes().some(frame=>'opacity' in frame));
      opacityAnimations.forEach(a=>{a.pause();a.currentTime=100});
      window.__qaChatCloseAnimations=opacityAnimations;
      resolve({present:true,inert:chat.inert||Boolean(chat.closest('[inert]')),filter:[...chat.querySelectorAll('.home-glass-surface')].map(e=>getComputedStyle(e).backdropFilter),columnOpacity:Number(getComputedStyle(column).opacity),chatOpacity:Number(getComputedStyle(chat).opacity),opacityAnimations:opacityAnimations.map(a=>a.animationName??a.transitionProperty)});
    }));
  })`)
  motionSamples.push({name:'chat closing midpoint',...closing})
  assert.equal(closing.present,true,'chat remains mounted for its closing fade');assert.equal(closing.inert,true)
  assert.ok(closing.opacityAnimations.length>0&&(closing.columnOpacity<1||closing.chatOpacity<1),'outer chat glass actually fades before unmounting')
  checks.push('closing chat fades its outer glass while remaining inert until unmount')
  await check('closing chat immediately disables glass sampling','[...document.querySelectorAll(".pl-chat .home-glass-surface")].every(e=>getComputedStyle(e).backdropFilter==="none")')
  await evaluate('(window.__qaChatCloseAnimations??[]).forEach(a=>a.play());true')
  await wait('!document.querySelector(".pl-chat")');await delay(650)
  const afterClose=await readPanes(); const scrollDiag=await readScrollGeometry(); motionSamples.push({name:'post-close-layout-diagnostic',before,after:afterClose,scrollDiag}); assert.deepEqual(afterClose,before);checks.push('closed desktop chat restores the full-width board and overview geometry')
  await check('closed chat leaves no sampling layer','!document.querySelector(".pl-chat")&&document.querySelectorAll(".pl-layout>.pl-glass").length===1&&!!document.querySelector(".pl-overview")')
  await evaluate(`new Promise(resolve=>{document.querySelector('.pl-header-actions .pl-primary').click();setTimeout(()=>{document.querySelector('button[aria-label="收起日程析熙"]').click();resolve(true)},90)})`);await delay(750)
  assert.deepEqual(await readPanes(),before);await check('rapid open then close releases chat and restores layout','!document.querySelector(".pl-chat")&&document.querySelector(".pl-layout").dataset.chatOpen==="false"')

  await nav('日历');await wait('!!document.querySelector(".pl-calendar-day")');await delay(400)
  await click('.pl-header-actions .pl-primary');await wait('!!document.querySelector(".pl-chat")');await delay(650)
  await assertBoardAndChat('desktop calendar chat');await shot('calendar-overview-chat-dark')
  await click('.pl-header-actions .pl-icon-button');await delay(350);await shot('calendar-overview-chat-light')
  await click('.pl-header-actions .pl-icon-button');await delay(350)
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});await delay(650)
  await assertBoardAndChat('1280px calendar chat');await shot('calendar-overview-chat-1280')
  await evaluate(`document.querySelector('button[aria-label="收起日程析熙"]').click();true`);await wait('!document.querySelector(".pl-chat")')
  // Real message fixtures make the compact drawer's body scroll without touching
  // the user's persistent service or injecting fake visual elements.
  const conversationId=db.getActiveConversation().id
  for(let i=0;i<12;i++)db.appendMessage({conversationId,role:'assistant',content:`响应式验收 ${i+1}：先把眼前这一件安排好，剩下的留一点余地。今天的空档和课程仍然在旁边，想换个节奏就告诉我。`})
  await evaluate("document.dispatchEvent(new Event('visibilitychange'));true")
  for(const width of [1440,1280,1024,600,390,320]){
    const height=width<768?844:1000
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await delay(650)
    await nav('时间表');await wait('!!document.querySelector(".pl-timetable-grid")');await delay(450)
    const mode=width>=1280?'wide':width>=768?'medium':'narrow'
    await check(`${width}px: correct structural layout mode`,`document.querySelector('.planner[data-active=true]').dataset.layout===${JSON.stringify(mode)}`)
    await assertNoViewportOverflow(`${width}px timetable`)
    await assertOverview(`${width}px timetable`)
    if(width===1440||width===390)await assertNaturalBoard(`${width}px timetable`,'timetable')
    await check(`${width}px: timetable capacity omits fractional minutes`, `[...document.querySelectorAll('.pl-timetable-capacity,.pl-selected-summary')].every(e=>!/[0-9]+\\.[0-9]+/.test(e.textContent))`)
    await assertNavigation(`${width}px`)
    await shot(`timetable-${width}`)
    await nav('日历');await wait('!!document.querySelector(".pl-calendar-day")');await delay(450)
    await assertNoViewportOverflow(`${width}px calendar`)
    if(width===1440||width===390)await assertNaturalBoard(`${width}px calendar`,'calendar')
    await assertOverview(`${width}px calendar`)
    await evaluate('window.__qaOverview=document.querySelector(".pl-overview");true')
    await evaluate('document.querySelector(".pl-header-actions .pl-primary").focus({preventScroll:true});true')
    const pageScrollBefore=await evaluate('document.querySelector(".pl-scroll").scrollTop')
    await key('Enter');await wait('!!document.querySelector(".pl-chat")');await delay(650)
    if(mode!=='narrow'){
      await assertBoardAndChat(`${width}px responsive calendar chat`)
      await check(`${width}px: opening chat retains the live overview node`, `document.querySelector('.pl-overview')===window.__qaOverview&&!window.__qaOverview.inert&&getComputedStyle(window.__qaOverview).visibility==='visible'`)
      if(mode==='medium'){
        await fill('#planner-xixi-input','收起聊天时保留这段草稿')
        await evaluate(`document.querySelector('[data-chat-close]').focus({preventScroll:true});true`);await key('Enter');await delay(450)
        await assertOverview('1024px closed chat')
        await evaluate(`document.querySelector('.pl-header-actions .pl-primary').focus({preventScroll:true});true`);await key('Enter');await wait('!!document.querySelector(".pl-chat")');await delay(450)
        await check('1024px: reopening chat retains its draft',`document.querySelector('#planner-xixi-input').value==='收起聊天时保留这段草稿'`)
        await fill('#planner-xixi-input','')
      }
    }else{
      const drawer=await evaluate(`(()=>{const e=document.querySelector('.pl-chat-column'),r=e.getBoundingClientRect(),button=e.querySelector('[data-chat-close]'),b=button.getBoundingClientRect(),input=e.querySelector('#planner-xixi-input').getBoundingClientRect(),board=document.querySelector('.pl-board').getBoundingClientRect();return{modal:e.matches(':modal'),position:getComputedStyle(e).position,box:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},close:{top:b.top,bottom:b.bottom,hit:button.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))},input:{top:input.top,bottom:input.bottom},board:{left:board.left,right:board.right}}})()`)
      assert.equal(drawer.modal,true,`${width}px: drawer uses native modal focus semantics`);assert.equal(drawer.position,'fixed')
      assert.ok(drawer.box.left>=-1&&drawer.box.right<=width+1&&drawer.box.top>=0&&drawer.box.bottom<=height,`${width}px: drawer fits the viewport`)
      assert.ok(drawer.close.hit&&drawer.close.top>=0&&drawer.input.bottom<=height,`${width}px: close and input stay visible`)
      await evaluate(`(()=>{const log=document.querySelector('.pl-chat .xixi-conversation');log.scrollTop=0;window.__qaDrawerHeader=document.querySelector('.pl-chat-header').getBoundingClientRect().top;window.__qaDrawerInput=document.querySelector('#planner-xixi-input').getBoundingClientRect().top;return true})()`);await delay(150)
      await evaluate('document.querySelector(".pl-chat .xixi-conversation").scrollTop=99999;true');await delay(150)
      await check(`${width}px: only the drawer conversation scrolls`, `document.querySelector('.pl-chat .xixi-conversation').scrollTop>100&&Math.abs(document.querySelector('.pl-chat-header').getBoundingClientRect().top-window.__qaDrawerHeader)<1&&Math.abs(document.querySelector('#planner-xixi-input').getBoundingClientRect().top-window.__qaDrawerInput)<1`)
      await key('Tab');await check(`${width}px: keyboard focus stays in the modal drawer`,`Boolean(document.activeElement.closest('.pl-chat-column'))`)
      motionSamples.push({name:`${width}px fixed chat drawer`,...drawer});checks.push(`${width}px: chat is a viewport drawer with a stable close button and composer`)
    }
    await assertNoViewportOverflow(`${width}px open chat`)
    await shot(`calendar-chat-${width}`)
    if(mode!=='narrow'){
      await evaluate('document.querySelector("#planner-xixi-input").focus({preventScroll:true});true');await key('Escape');await delay(450)
      await check(`${width}px: Escape from the composer closes chat and restores trigger`,`document.querySelector('.pl-layout').dataset.chatOpen==='false'&&document.activeElement.matches('.pl-header-actions .pl-primary')`)
      await key('Enter');await wait('document.querySelector(".pl-layout").dataset.chatOpen==="true"');await delay(450)
    }
    const scrollAtClose=mode==='narrow'?pageScrollBefore:await evaluate('document.querySelector(".pl-scroll").scrollTop')
    await evaluate(`document.querySelector('[data-chat-close]').focus({preventScroll:true});true`);await key('Enter');await wait('document.querySelector(".pl-layout").dataset.chatOpen==="false"');await delay(450)
    await check(`${width}px: closing chat preserves the page scroll position`,`Math.abs(document.querySelector('.pl-scroll').scrollTop-${scrollAtClose})<1`)
    await check(`${width}px: closing chat returns focus without leaving a modal behind`,`document.activeElement.matches('.pl-header-actions .pl-primary')&&!document.querySelector('.pl-chat-column')?.matches(':modal')`)
    if(width===1024||width===390){
      await evaluate(`new Promise(resolve=>{document.querySelector('.pl-header-actions .pl-primary').click();setTimeout(()=>{document.querySelector('[data-chat-close]').click();resolve(true)},90)})`);await delay(500)
      await check(`${width}px: rapid open-close restores focus and releases modal state`,`document.querySelector('.pl-layout').dataset.chatOpen==='false'&&!document.querySelector('.pl-chat-column').matches(':modal')&&document.activeElement.matches('.pl-header-actions .pl-primary')`)
      await evaluate(`document.querySelector('.pl-header-actions .pl-primary').click();true`);await wait('!!document.querySelector(".pl-chat")');await delay(420)
      await evaluate(`new Promise(resolve=>{document.querySelector('[data-chat-close]').click();setTimeout(()=>{document.querySelector('.pl-header-actions .pl-primary').click();resolve(true)},90)})`);await delay(500)
      await check(`${width}px: rapid close-reopen leaves one interactive chat`,`document.querySelectorAll('.pl-chat').length===1&&document.querySelector('.pl-layout').dataset.chatOpen==='true'&&!document.querySelector('.pl-chat').closest('[inert]')&&document.querySelector('.pl-chat-column').matches(':modal')===${width<768}`)
      await evaluate(`document.querySelector('[data-chat-close]').click();true`);await delay(500)
    }
  }
  await send('Emulation.setDeviceMetricsOverride',{width:1024,height:1000,deviceScaleFactor:1,mobile:false});await delay(500)
  await evaluate('document.querySelector(".pl-header-actions .pl-primary").focus({preventScroll:true});true');await key('Enter');await wait('!!document.querySelector(".pl-chat")');await delay(450)
  await fill('#planner-xixi-input','跨尺寸继续输入')
  await evaluate('window.__qaCrossLayoutChat=document.querySelector(".pl-chat");document.querySelector("#planner-xixi-input").setSelectionRange(2,4);true')
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await delay(650)
  await check('open medium chat becomes one compact modal without remounting',`document.querySelector('.planner').dataset.layout==='narrow'&&document.querySelector('.pl-chat-column').matches(':modal')&&document.querySelectorAll('.pl-chat').length===1&&document.querySelector('.pl-chat')===window.__qaCrossLayoutChat`)
  await check('medium-to-phone resizing preserves focused composer and selection',`document.activeElement.matches('#planner-xixi-input')&&document.activeElement.selectionStart===2&&document.activeElement.selectionEnd===4`)
  await send('Emulation.setDeviceMetricsOverride',{width:1024,height:1000,deviceScaleFactor:1,mobile:false});await delay(650)
  await check('phone-to-medium resizing preserves focused composer and selection',`!document.querySelector('.pl-chat-column').matches(':modal')&&document.activeElement.matches('#planner-xixi-input')&&document.activeElement.selectionStart===2&&document.activeElement.selectionEnd===4`)
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await delay(650)
  await evaluate('document.querySelector("[data-chat-close]").focus({preventScroll:true});true');await key('Enter');await delay(500)
  await check('closing after a medium-to-phone resize releases modal and restores trigger',`!document.querySelector('.pl-chat-column').matches(':modal')&&!document.querySelector('.pl-chat')&&document.activeElement.matches('.pl-header-actions .pl-primary')`)
  await click('.pl-header-actions .pl-icon-button');await delay(350)
  await evaluate('document.querySelector(".pl-header-actions .pl-primary").focus({preventScroll:true});true');await key('Enter');await delay(650)
  await check('light compact drawer separates background text with one backdrop blur',`getComputedStyle(document.querySelector('.pl-chat-column'),'::backdrop').backdropFilter==='blur(6px)'`)
  await shot('calendar-chat-390-light')
  await evaluate('document.querySelector("#planner-xixi-input").focus({preventScroll:true});true');await key('Escape');await delay(500)
  await click('.pl-header-actions .pl-icon-button');await delay(350)
  for(const width of [767,768,1279]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await delay(500)
    await assertNoViewportOverflow(`${width}px boundary`)
    await evaluate('document.querySelector(".pl-header-actions .pl-primary").focus({preventScroll:true});true');await key('Enter');await delay(500)
    await check(`${width}px: chat follows the exact responsive boundary`,`document.querySelector('.planner').dataset.layout===${JSON.stringify(width<768?'narrow':'medium')}&&document.querySelector('.pl-chat-column').matches(':modal')===${width<768}`)
    await assertNoViewportOverflow(`${width}px open boundary chat`)
    await evaluate('document.querySelector("[data-chat-close]").click();true');await delay(450)
  }
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await nav('时间表');await delay(400)
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:630,deviceScaleFactor:1,mobile:false})
  await byText('.pl-header-actions .pl-secondary','添加时段');await wait('!!document.querySelector(".pl-dialog[open]")');await delay(300)
  const headerBefore=await evaluate('document.querySelector(".pl-dialog-header").getBoundingClientRect().y')
  const glassBefore=await evaluate('document.querySelector(".pl-dialog .home-glass-surface").getBoundingClientRect().y')
  await evaluate('document.querySelector(".pl-dialog-body").scrollTop=9999;true');await delay(200)
  await check('routine editor body really scrolls','document.querySelector(".pl-dialog-body").scrollTop>100')
  assert.equal(await evaluate('document.querySelector(".pl-dialog-header").getBoundingClientRect().y'),headerBefore);checks.push('dialog header stays fixed while body scrolls')
  assert.equal(await evaluate('document.querySelector(".pl-dialog .home-glass-surface").getBoundingClientRect().y'),glassBefore);checks.push('dialog glass stays fixed while body scrolls')
  await check('close button remains visible and hit-testable',`(()=>{const e=document.querySelector('.pl-dialog-header button'),r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`)
  await shot('routine-scroll-fixed')
  await click('.pl-dialog-header button');await delay(220);await check('dialog can close directly from scrolled bottom','!document.querySelector(".pl-dialog")')
  edit({type:'import-routines',routines:Array.from({length:20},(_,i)=>({id:`qa-long-${i}`,title:`滚动核对课程 ${i+1}`,kind:'class',weekdays:[6],start:'08:00',end:'08:40',location:'',items:[],enabled:true}))})
  await evaluate("window.dispatchEvent(new Event('astaria-local-data-change'));true");await delay(300)
  await byText('.pl-header-actions .pl-secondary','每周安排');await wait('!!document.querySelector(".pl-dialog[open]")');await delay(220)
  await check('weekly list has one persistent right close button','document.querySelectorAll(".pl-dialog-header button").length===1')
  const weeklyHeader=await evaluate('document.querySelector(".pl-dialog-header").getBoundingClientRect().y')
  await evaluate('document.querySelector(".pl-dialog-body").scrollTop=9999;true');await delay(200)
  await check('long weekly list scrolls without moving its close button',`document.querySelector('.pl-dialog-body').scrollTop>300&&document.querySelector('.pl-dialog-header').getBoundingClientRect().y===${weeklyHeader}`)
  await click('.pl-dialog-header button');await delay(220)
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false})
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await delay(100)
  await observeEntry();await nav('日历');await wait('!!document.querySelector(".pl-calendar-day")');await delay(450)
  const reducedEntry=await evaluate('window.__qaFinishEntry()');assert.equal(reducedEntry.samples.length,0);assert.equal(reducedEntry.events.length,0)
  await check('reduced motion never starts page entry','!document.querySelector(".planner[data-active=true]").hasAttribute("data-entering")')
  await evaluate(`document.querySelector('${current} .pl-calendar-day[aria-pressed=true]').focus({preventScroll:true});true`)
  await key('ArrowRight');await wait(`document.querySelector('${current} .pl-calendar-day[data-date="2026-09-22"]').getAttribute('aria-pressed')==='true'`)
  await check('reduced motion preserves keyboard date selection and focus',`document.activeElement.matches('${current} .pl-calendar-day[data-date="2026-09-22"]')&&document.querySelector('.pl-calendar-summary-header h3').textContent.includes('9月22日')`)
  const reducedHover=`${current} .pl-calendar-day[data-date="2026-09-22"]`
  await evaluate(`document.querySelector(${JSON.stringify(reducedHover)}).scrollIntoView({block:'nearest'});true`);await delay(150);await movePointer(`${reducedHover} .pl-calendar-date>span`);await delay(250)
  await check('reduced motion suppresses pointer glow markers','!document.querySelector(".planner [data-hovered=true]")')
  await check('reduced motion hover keeps the actual card stationary',`getComputedStyle(document.querySelector(${JSON.stringify(reducedHover)})).transform==='none'`)
  await evaluate(`window.__qaReducedStatusTarget=${statusTarget()};true`)
  assert.equal(await evaluate('window.__qaReducedStatusTarget.dataset.done'),'false')
  db.updateTask(robot.id,{status:'done'});await evaluate("window.dispatchEvent(new Event('astaria-local-data-change'));true");await wait("window.__qaReducedStatusTarget.dataset.done==='true'")
  await check('reduced motion renders real completion without a pulse','!document.querySelector(".planner [data-status-pulse=true]")&&window.__qaReducedStatusTarget.isConnected')
  await evaluate('document.querySelector(".pl-header-actions .pl-primary").focus({preventScroll:true});true');await key('Enter');await wait('!!document.querySelector(".pl-chat")');await delay(100)
  await check('reduced motion keyboard opens a usable chat','document.querySelector(".pl-layout").dataset.chatOpen==="true"&&!document.querySelector(".pl-chat").closest("[inert]")')
  await evaluate(`document.querySelector('button[aria-label="收起日程析熙"]').focus({preventScroll:true});true`);await key('Enter');await wait('!document.querySelector(".pl-chat")')
  await check('reduced motion keyboard closes chat and returns focus','document.querySelector(".pl-layout").dataset.chatOpen==="false"&&document.activeElement.matches(".pl-header-actions .pl-primary")')
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]})
  assert.equal(errors.length,0)
  await writeFile(`${output}/results.json`,JSON.stringify({checks,errors,motionSamples,slotSamples,apiRequests},null,2));console.log(`PASS ${checks.length} planner UI checks (${output})`)
}catch(error){await shot('failure').catch(()=>{});await writeFile(`${output}/failure.json`,JSON.stringify({message:error.message,errors,checks,motionSamples,slotSamples},null,2));throw error}
finally{if(contextId)await send('Target.disposeBrowserContext',{browserContextId:contextId},null);ws.close();service.close()}
