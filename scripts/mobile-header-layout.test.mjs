/** Scoped component integration: owned Chrome, virtual Vite entry, fictional API only.
 * node --test scripts/mobile-header-layout.test.mjs
 * Does not build/reload a production preview or connect to any existing browser.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const stamp = '2026-10-16T08:00:00+08:00'
const routine = (id, kind, start, end, title) => ({ id, kind, start, end, title, weekdays:[0,1,2,3,4,5,6], enabled:true, location:'', items:[] })
const planner = { revision:1, timetableConfirmed:true, routines:[routine('window','available','08:00','22:00','可用时间'), routine('class','class','09:00','10:00','虚构课程：长期项目与实验记录')], blocks:[], dayEvents:[], details:{}, checked:{} }
function companion(count = 5) {
  const dates = Array.from({length:7}, (_, i) => `2026-10-${16+i}`)
  return { freeTimeGoals:Array.from({length:count}, (_, i) => ({id:`g${i}`, title:`虚构目标 ${i+1}：复习与长期实践`, evidence:'隔离测试', priority:'normal', minPerWeek:2, sessionMin:20, sessionMax:40, status:'active', version:1})),
    wishes:count ? [{id:'w1',content:'虚构心愿：做一个小小的星图',evidence:'隔离测试',minutes:30,items:[],status:'active',version:1}] : [],
    freeTimeSessions:count ? dates.slice(0,2).map((date,i) => ({id:`s${i}`, goalId:'g0', taskId:'t0', title:'虚构学习时段', date,start:'14:00',end:'14:30',locked:false,completed:false})) : [],
    freeTimeProgress:[],freeTimeFeedback:[],freeTimeBreaks:[],opportunities:[], timeline:dates.map(date=>({date,freeMin:360})) }
}
const entry = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MobileScheduleWorkspace} from '/mobile/ui/MobileScheduleWorkspace.tsx';
import {FreeTimePanel} from '/src/xixi/FreeTimePanel.tsx';
import {DEFAULT_PREFERENCES,publishPreferences} from '/src/xixi/preferences.ts';
import '/src/prototype/prototype.css';
import '/src/home/home.css';
import '/src/home/theme.css';
import '/mobile/runtime/mobile.css';
function Harness(){
 const [page,setPage]=useState('schedule'),[theme,setTheme]=useState('dark'),[glass,setGlass]=useState('clear'),[motion,setMotion]=useState('full'),[epoch,setEpoch]=useState(0);
 window.__headers={page:setPage,appearance:(t,g)=>{setTheme(t);setGlass(g)},motion:setMotion,remount:()=>setEpoch(v=>v+1)};
 const preferences={...DEFAULT_PREFERENCES,theme,glass,effect:{...DEFAULT_PREFERENCES.effect,motion}};
 React.useEffect(()=>{publishPreferences(preferences)},[theme,glass,motion]);
 return React.createElement('div',{className:'p0'},React.createElement('div',{className:'home-workspace','data-theme':theme,'data-page':page,'data-motion':motion},
  React.createElement(MobileScheduleWorkspace,{key:'calendar'+epoch,active:page==='schedule',tasks:[],now:new Date('${stamp}'),preferences,onRefresh:()=>{},onChat:()=>{}}),
  React.createElement(FreeTimePanel,{key:'free'+epoch,active:page==='free-time',today:'2026-10-16',theme,glass,grid:false,onClarifyWish:()=>{},onRefinePlan:()=>{},onChanged:()=>{},onNotice:()=>{},onOpenStrings:()=>{}})
 ));
}
createRoot(document.getElementById('root')).render(React.createElement(Harness));
`

test('mobile headers, rounded highlights, real hits and retained transitions', {timeout:180000}, async () => {
  const output = await mkdtemp(join(tmpdir(),'astaria-mobile-headers-'))
  const profile = join(output,'chrome'); await mkdir(profile)
  const report = {scope:'isolated source components; fictional data; not production-preview acceptance', output, hits:[], geometry:[], motion:[], screenshots:[], exceptions:[]}
  let fixtureCount=5, failRead=false, child, socket, server
  const pending=new Map(); let serial=0
  const send=(method,params={})=>new Promise((yes,no)=>{
    const id=++serial,timer=setTimeout(()=>{pending.delete(id);no(Error(`CDP timeout ${method}`))},20000)
    pending.set(id,{yes,no,timer});socket.send(JSON.stringify({id,method,params}))
  })
  const evaluate=async expression=>{
    const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true})
    if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const wait=async expression=>{
    for(let i=0;i<180;i++){if(await evaluate(expression))return;await delay(40)}
    throw Error(`Timeout waiting for ${expression}`)
  }
  const hit=async selector=>{
    await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest'});true`)
    await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;const r=e.getBoundingClientRect(),t=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !e.disabled&&!e.closest('[inert],[hidden]')&&(t===e||e.contains(t))})()`)
    const target=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,t=document.elementFromPoint(x,y);return {selector:${JSON.stringify(selector)},x,y,rect:r.toJSON(),hit:!e.disabled&&!e.closest('[inert],[hidden]')&&(t===e||e.contains(t))}})()`)
    report.hits.push(target);assert.ok(target.hit,JSON.stringify(target))
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:target.x,y:target.y,button:'left',clickCount:1})
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:target.x,y:target.y,button:'left',clickCount:1})
  }
  const input=async(selector,value)=>{
    await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;const r=e.getBoundingClientRect(),t=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !e.disabled&&!e.closest('[inert],[hidden]')&&(t===e||e.contains(t))})()`)
    await hit(selector)
    await evaluate(`{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));true}`)
  }
  const shot=async name=>{
    const {data}=await send('Page.captureScreenshot',{format:'png'})
    const path=join(output,`${name}.png`);await writeFile(path,Buffer.from(data,'base64'));report.screenshots.push(path)
  }
  const geometry=async(name,selectors)=>{
    const data=await evaluate(`(()=>{const rows=${JSON.stringify(selectors)}.map(s=>{const e=document.querySelector(s),r=e.getBoundingClientRect(),cs=getComputedStyle(e);return {selector:s,rect:r.toJSON(),scroll:e.scrollWidth,client:e.clientWidth,font:cs.fontSize,weight:cs.fontWeight}});return {width:innerWidth,body:document.documentElement.scrollWidth,rows}})()`)
    report.geometry.push({name,...data});assert.ok(data.body<=data.width,JSON.stringify(data))
    for(const row of data.rows){assert.ok(row.rect.left>=0&&row.rect.right<=data.width+.5,JSON.stringify(row));assert.ok(row.scroll<=row.client+1,JSON.stringify(row))}
    return data.rows
  }
  const freeSwitch=async value=>{
    await hit(`.free-time-mobile-views button:nth-child(${({goals:1,plans:2,wishes:3})[value]})`)
    await wait(`document.querySelector('.free-time-page').dataset.mobileView==='${value}'&&document.querySelector('.free-time-mobile-content').dataset.viewPhase==='idle'`)
  }
  const settledCalendar=()=>wait("document.querySelector('.m-calendar-period-window').dataset.moving==='false'")
  try {
    server=await createServer({root,configFile:false,cacheDir:join(output,'vite-cache'),plugins:[react(),{
      name:'isolated-header-fixture',resolveId:id=>id==='virtual:headers.tsx'?'\0headers.tsx':undefined,load:id=>id==='\0headers.tsx'?entry:undefined,
      configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
        if(req.url?.startsWith('/api/')){
          res.setHeader('Content-Type','application/json')
          if(req.method!=='GET'){res.statusCode=403;res.end(JSON.stringify({error:'Fixture writes are disabled'}));return}
          if(failRead){res.statusCode=503;res.end(JSON.stringify({error:'虚构读取错误，检查重试布局'}));return}
          // Preferences are published by the fixture host; never read a user's store.
          if(req.url.startsWith('/api/preferences')){res.statusCode=503;res.end(JSON.stringify({error:'Fixture uses explicitly published preferences'}));return}
          res.end(JSON.stringify(req.url.startsWith('/api/planner')?planner:companion(fixtureCount)));return
        }
        if(req.url==='/'){
          res.setHeader('Content-Type','text/html')
          res.end(await vite.transformIndexHtml('/',`<!doctype html><html data-mobile="preview"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}.p0{background:radial-gradient(ellipse at 85% 40%,#d4b57c66,transparent 55%),#080a0e}</style><div id="root"></div><script type="module" src="/@id/virtual:headers.tsx"></script></html>`));return
        }
        next()
      })}
    }],server:{host:'127.0.0.1',port:0,hmr:false,watch:null},optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react/jsx-dev-runtime']}})
    await server.listen();const base=server.resolvedUrls.local[0]
    child=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','about:blank'],{stdio:'ignore'})
    let port
    for(let i=0;i<100;i++){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);if(port)break}catch{}await delay(80)}
    assert.ok(port,'Owned Chrome started')
    const target=(await fetch(`http://127.0.0.1:${port}/json`).then(r=>r.json())).find(t=>t.type==='page')
    socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((yes,no)=>{socket.onopen=yes;socket.onerror=no})
    socket.onmessage=event=>{
      const message=JSON.parse(event.data),request=pending.get(message.id)
      if(request){clearTimeout(request.timer);pending.delete(message.id);message.error?request.no(Error(JSON.stringify(message.error))):request.yes(message.result)}
      if(message.method==='Runtime.exceptionThrown')report.exceptions.push(message.params.exceptionDetails)
      if(message.method==='Fetch.requestPaused'){
        const {requestId,request}=message.params,allowed=request.url.startsWith(base)||/^(data|blob):/.test(request.url)
        void send(allowed?'Fetch.continueRequest':'Fetch.failRequest',{requestId,...(allowed?{}:{errorReason:'BlockedByClient'})})
      }
    }
    await send('Page.enable');await send('Runtime.enable');await send('Fetch.enable',{patterns:[{urlPattern:'*'}]})
    await send('Emulation.setFocusEmulationEnabled',{enabled:true})
    await send('Emulation.setTimezoneOverride',{timezoneId:'Asia/Shanghai'})
    await send('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/154.0.0.0 Mobile Safari/537.36'})
    await send('Emulation.setDeviceMetricsOverride',{width:320,height:844,deviceScaleFactor:1,mobile:true})
    await send('Page.navigate',{url:base})
    await wait("document.querySelectorAll('.m-calendar-week-summary').length===7")
    for(const width of [320,390])for(const theme of ['dark','light'])for(const glass of ['clear','soft']){
      await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true})
      await evaluate(`__headers.appearance('${theme}','${glass}');__headers.page('schedule');true`);await delay(500)
      const rows=await geometry(`${width}-${theme}-${glass}-calendar`,['.m-calendar-heading h1','.m-calendar-view','.m-calendar-period','.m-calendar-month-toggle','.m-calendar-content'])
      assert.ok(Math.abs((rows[0].rect.y+rows[0].rect.height/2)-(rows[1].rect.y+rows[1].rect.height/2))<2,'Calendar title/tabs share a row')
      await shot(`${width}-${theme}-${glass}-calendar`)
      await evaluate("__headers.page('free-time');true");await delay(550)
      const free=await geometry(`${width}-${theme}-${glass}-free`,['.free-time-header','.free-time-header h2','.free-time-mobile-views','.free-time-goals .free-time-pane-heading','.free-time-search'])
      assert.ok(free[0].rect.height<=42,'Single-line compact free-time header')
      assert.ok(Math.abs((free[1].rect.y+free[1].rect.height/2)-(free[2].rect.y+free[2].rect.height/2))<2,'Free-time title/tabs share a row')
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.free-time-metrics')).display"),'none')
      await shot(`${width}-${theme}-${glass}-free`)
    }
    // Compact sheets reuse the product glass/step components, never a full-screen app.
    for(const width of [320,390])for(const theme of ['dark','light'])for(const glass of ['clear','soft']){
      await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true})
      await evaluate(`__headers.appearance('${theme}','${glass}');__headers.page('schedule');true`);await delay(400)
      await hit('[aria-label="打开日程菜单"]');await wait("!!document.querySelector('.m-calendar-sheet[open]')")
      await delay(220)
      const modal=await geometry(`${width}-${theme}-${glass}-menu`,['.m-calendar-sheet','.m-calendar-sheet-heading','.m-calendar-menu'])
      assert.ok(Math.abs(modal[0].rect.width-Math.min(420,width-32))<1)
      assert.ok(modal[0].rect.height<450,'Menu is sized to its content')
      const style=await evaluate("(()=>{const d=document.querySelector('.m-calendar-sheet'),h=d.querySelector('h2'),b=d.querySelector('.m-calendar-menu button'),s=d.querySelector('.home-glass-surface'),back=d.querySelector('.home-glass-backdrop');return {radius:getComputedStyle(d).borderRadius,background:getComputedStyle(d).backgroundColor,heading:getComputedStyle(h).fontSize,weight:getComputedStyle(h).fontWeight,body:getComputedStyle(b).fontSize,rowHeight:b.getBoundingClientRect().height,rowRadius:getComputedStyle(b).borderRadius,theme:d.dataset.theme,glass:d.dataset.glass,filter:getComputedStyle(back).backdropFilter,hasGlass:!!s}})()")
      assert.equal(style.radius,'22px');assert.equal(style.background,'rgba(0, 0, 0, 0)');assert.equal(style.heading,'20px');assert.equal(style.weight,'400');assert.equal(style.body,'13px');assert.ok(style.rowHeight>=44);assert.equal(style.rowRadius,'12px');assert.equal(style.theme,theme);assert.equal(style.glass,glass);assert.ok(style.hasGlass)
      assert.equal(style.filter,glass==='soft'?'blur(6px)':'none')
      await evaluate("document.querySelector('.m-calendar-sheet h2').focus();true")
      await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
      await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
      const menuFocus=await evaluate("(()=>{const e=document.activeElement,s=getComputedStyle(e);return {class:e.closest('.m-calendar-menu')?.className,visible:e.matches(':focus-visible'),radius:s.borderRadius,padding:s.paddingLeft,outline:s.outlineWidth}})()")
      assert.ok(menuFocus.class&&menuFocus.visible);assert.equal(menuFocus.outline,'1px');assert.equal(menuFocus.radius,'12px');assert.ok(parseFloat(menuFocus.padding)>=8)
      await shot(`${width}-${theme}-${glass}-sheet-menu`)
      await hit('.m-calendar-menu button:nth-child(3)');await wait("!!document.querySelector('.m-calendar-weekly-list .m-calendar-primary')")
      await hit('.m-calendar-weekly-list .m-calendar-primary');await wait("!!document.querySelector('.m-calendar-form')")
      await delay(220)
      await geometry(`${width}-${theme}-${glass}-routine`,['.m-calendar-sheet','.m-calendar-sheet-body','.m-calendar-weekday-picks','.m-calendar-form-pair'])
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.m-calendar-form input')).fontSize"),'14px')
      assert.equal(await evaluate("document.querySelectorAll('.m-calendar-form select').length"),0,'Choices remain in-place button groups')
      await shot(`${width}-${theme}-${glass}-sheet-form`)
      await hit('.m-calendar-sheet-heading button');await wait("!!document.querySelector('.m-calendar-weekly-list')")
      await hit('.m-calendar-sheet-heading button');await wait("!!document.querySelector('.m-calendar-menu')")
      await hit('.m-calendar-sheet-heading button');await wait("!document.querySelector('.m-calendar-sheet[open]')")
    }
    await send('Emulation.setDeviceMetricsOverride',{width:320,height:844,deviceScaleFactor:1,mobile:true})
    await evaluate("__headers.page('schedule');true");await delay(450)
    const summary='.m-calendar-period-frame[data-current=true] .m-calendar-week-summary'
    await evaluate(`document.querySelector(${JSON.stringify(summary)}).focus();true`)
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,modifiers:8})
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,modifiers:8})
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
    const focus=await evaluate(`(()=>{const e=document.activeElement,s=getComputedStyle(e);return {class:e.className,visible:e.matches(':focus-visible'),radius:s.borderRadius,padding:s.paddingLeft,outline:s.outlineWidth}})()`)
    assert.match(focus.class,/week-summary/);assert.ok(focus.visible);assert.ok(parseFloat(focus.radius)>=12&&parseFloat(focus.radius)<=14);assert.ok(parseFloat(focus.padding)>=8);assert.equal(focus.outline,'1px')
    await shot('320-summary-keyboard-focus')
    await hit('.m-calendar-period [aria-label="下一周"]')
    await delay(45)
    const mid=await evaluate("[...document.querySelectorAll('.m-calendar-period-frame')].map(e=>({current:e.dataset.current,inert:e.inert,opacity:Number(getComputedStyle(e).opacity),transform:getComputedStyle(e).transform}))")
    report.motion.push({name:'calendar-middle',frames:mid});assert.equal(mid.length,2);assert.ok(mid.some(f=>!f.current||f.inert));assert.ok(mid.some(f=>f.opacity>0&&f.opacity<1))
    await shot('320-calendar-switch-middle');await settledCalendar()
    assert.equal(await evaluate("document.querySelectorAll('.m-calendar-week-summary').length"),7)
    await hit('.m-calendar-period [aria-label="上一周"]');await settledCalendar()
    await hit(summary);await settledCalendar();assert.ok(await evaluate("!!document.querySelector('.m-calendar-day-heading')"))
    const day=await evaluate("document.querySelector('.m-calendar-day-heading h2').textContent")
    await hit('.m-calendar-period [aria-label="后一天"]');await settledCalendar()
    assert.notEqual(await evaluate("document.querySelector('.m-calendar-day-heading h2').textContent"),day)
    await hit('.m-calendar-view [data-mode=month]');await settledCalendar()
    assert.ok(await evaluate("document.querySelectorAll('.m-calendar-month-grid .m-calendar-date').length>=28"))
    await hit('.m-calendar-period [aria-label="下个月"]');await settledCalendar();assert.match(await evaluate("document.querySelector('.m-calendar-month-toggle').textContent"),/11月/)
    await hit('.m-calendar-actions .m-calendar-button');await settledCalendar();assert.match(await evaluate("document.querySelector('.m-calendar-month-toggle').textContent"),/10月/)
    await hit('.m-calendar-view [data-mode=day]');await settledCalendar()
    await hit('[aria-label="新增单日活动"]');await wait("!!document.querySelector('.m-calendar-sheet[open]')")
    await evaluate("document.documentElement.dataset.mobile='ios';true")
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.m-calendar-form input')).fontSize"),'16px')
    await evaluate("document.documentElement.dataset.mobile='preview';document.documentElement.style.setProperty('--m-visible-height','360px');document.documentElement.style.setProperty('--m-visible-offset-top','100px');true")
    const keyboard=await geometry('320-keyboard-form',['.m-calendar-sheet','.m-calendar-sheet-body'])
    assert.ok(keyboard[0].rect.height<=328.5&&keyboard[0].rect.top>=116&&keyboard[0].rect.bottom<=444.5)
    assert.ok(await evaluate("(()=>{const b=document.querySelector('.m-calendar-sheet-body');return b.scrollHeight>b.clientHeight})()"),'Only the long body scrolls in a reduced visible viewport')
    await shot('320-sheet-keyboard-visible')
    await evaluate("document.documentElement.style.removeProperty('--m-visible-height');document.documentElement.style.removeProperty('--m-visible-offset-top');true")
    await input('.m-calendar-form input[maxlength="160"]','虚构活动草稿')
    await input('.m-calendar-form input[type=time]','15:20')
    await hit('.m-calendar-sheet [aria-label="返回日程"]');await wait("!document.querySelector('.m-calendar-sheet[open]')")
    await hit('[aria-label="打开日程菜单"]');await wait("!!document.querySelector('.m-calendar-sheet[open]')")
    await delay(35);await shot('320-calendar-menu-enter-middle');await delay(180)
    await shot('320-calendar-menu');await hit('.m-calendar-sheet [aria-label="返回日程"]');await delay(40)
    const leaving=await evaluate("({closing:document.querySelector('.m-calendar-sheet').dataset.closing,opacity:Number(getComputedStyle(document.querySelector('.m-calendar-sheet')).opacity)})")
    report.motion.push({name:'sheet-exit-middle',...leaving});assert.equal(leaving.closing,'true');assert.ok(leaving.opacity>0&&leaving.opacity<1)
    await shot('320-calendar-menu-exit-middle');await wait("!document.querySelector('.m-calendar-sheet[open]')")
    await evaluate("__headers.page('free-time');true");await delay(500)
    await hit('.free-time-goals .free-time-add-goal');await input('.free-time-editor input[maxlength="160"]','虚构目标草稿：切换保留')
    await hit('.free-time-mobile-views button:nth-child(2)');await delay(45)
    const exit=await evaluate("({phase:document.querySelector('.free-time-mobile-content').dataset.viewPhase,opacity:Number(getComputedStyle(document.querySelector('.free-time-goals .free-time-pane-content')).opacity)})")
    report.motion.push({name:'free-exit-middle',...exit});assert.equal(exit.phase,'exit');assert.ok(exit.opacity>0&&exit.opacity<1)
    await shot('320-free-exit-middle');await wait("document.querySelector('.free-time-mobile-content').dataset.viewPhase==='enter'")
    await delay(35);await shot('320-free-enter-middle');await wait("document.querySelector('.free-time-mobile-content').dataset.viewPhase==='idle'")
    await geometry('320-plans-header',['.free-time-plan .free-time-pane-heading','.free-time-plan .free-time-tabs'])
    await hit('.free-time-plan .free-time-tabs button:nth-child(2)');await hit('.free-time-week button:nth-child(2)')
    const planDay=await evaluate("document.querySelector('.free-time-day-heading').textContent")
    await freeSwitch('wishes');await geometry('320-wishes-header',['.free-time-wish-heading','.free-time-wish-heading button','.free-time-goals .free-time-pane-heading'])
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.free-time-add-goal')).display"),'none')
    await hit('.free-time-wish-heading button');await input('.free-time-wish-start textarea','虚构心愿草稿，稍后继续')
    await freeSwitch('goals');assert.equal(await evaluate("document.querySelector('.free-time-editor input[maxlength=\"160\"]').value"),'虚构目标草稿：切换保留')
    await freeSwitch('plans');assert.equal(await evaluate("document.querySelector('.free-time-day-heading').textContent"),planDay)
    await freeSwitch('wishes');assert.equal(await evaluate("document.querySelector('.free-time-wish-start textarea').value"),'虚构心愿草稿，稍后继续')
    await shot('320-wish-draft-retained')
    // Quick reversal must finish on the latest request, retaining the same editor.
    await hit('.free-time-mobile-views button:nth-child(1)');await delay(35);await hit('.free-time-mobile-views button:nth-child(3)')
    await wait("document.querySelector('.free-time-mobile-content').dataset.viewPhase==='idle'");assert.equal(await evaluate("document.querySelector('.free-time-page').dataset.mobileView"),'wishes')
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
    await freeSwitch('goals');assert.equal(await evaluate("document.querySelector('.free-time-mobile-content').dataset.viewPhase"),'idle')
    await evaluate("__headers.page('schedule');true");await delay(150);await hit('.m-calendar-view [data-mode=week]')
    assert.equal(await evaluate("document.querySelectorAll('.m-calendar-period-frame[data-current=false]').length"),0)
    await evaluate("__headers.page('free-time');true");await delay(150)
    fixtureCount=0;await evaluate("__headers.remount();true");await wait("document.querySelector('.free-time-pagination')?.textContent.includes('共 0 项')")
    assert.equal(await evaluate("[...document.querySelectorAll('.free-time-search,.free-time-pagination button')].filter(e=>e.getClientRects().length).length"),0)
    await geometry('320-empty-header',['.free-time-goals .free-time-pane-heading','.free-time-add-goal']);await shot('320-empty-goals')
    fixtureCount=1;await evaluate("__headers.remount();true");await wait("document.querySelector('.free-time-pagination')?.textContent.includes('共 1 项')")
    assert.equal(await evaluate("[...document.querySelectorAll('.free-time-pagination button')].filter(e=>e.getClientRects().length).length"),0)
    failRead=true;await evaluate("__headers.remount();true");await wait("!!document.querySelector('.free-time-feedback [role=alert]')");await shot('320-read-error')
    failRead=false;await hit('.free-time-feedback button');await wait("document.querySelectorAll('.free-time-goal-list li').length===1")
    // Desktop keeps its title, description, metrics and original goal tabs.
    await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false})
    await evaluate("document.documentElement.removeAttribute('data-mobile');true");await delay(200)
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.free-time-mobile-views')).display"),'none')
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.free-time-metrics')).display"),'none')
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.workspace-heading-description')).display"),'none')
    await shot('desktop-header-preserved')
    assert.deepEqual(report.exceptions,[],'No browser exceptions')
    report.status='pass'
  } catch(error) {report.status='fail';report.error=error.stack;throw error}
  finally {
    await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(`Header evidence: ${output}`)
    socket?.close();for(const p of pending.values()){clearTimeout(p.timer);p.no(Error('Browser closed'))}pending.clear()
    child?.kill('SIGTERM');await server?.close()
  }
})
