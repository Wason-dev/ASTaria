/** Fresh isolated Chromium, in-memory database and fake provider. No personal data or paid calls. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { getPreferences } from '../server/preferences.mjs'

const output = process.env.RESPONSE_QA_OUTPUT ?? '/tmp/astaria-response-settings'
const base = process.env.RESPONSE_QA_URL ?? 'http://127.0.0.1:5179/'
const port = Number(process.env.RESPONSE_QA_PORT ?? 9250)
const debug = `http://127.0.0.1:${port}`
const renderPolicyOnly = process.argv.includes('--render-policy-only')
const db = createDatabase(':memory:')
db.createTask({title:'独立测试物理报告',due:'2026-09-22',estimateMin:45,inbox:false})
let providerMode='reply', releaseProvider, providerCalls=0, chrome, ws, failure
const service=createLocalService({db,vault:{status:async()=>true},dataDirectory:'/isolated-response-qa',complete:async()=>{
  providerCalls++
  await new Promise(resolve=>{releaseProvider=resolve})
  if(providerMode==='fail')throw Error('独立测试失败')
  return {choices:[{message:{role:'assistant',content:'**记住了**，先留一点休息时间\n\n安排可以慢慢来'}}]}
}})
const checks=[],errors=[],requests=[]
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
await mkdir(output,{recursive:true})
try {
  let occupied=false
  try{occupied=(await fetch(`${debug}/json/version`)).ok}catch{}
  assert.equal(occupied,false,'QA port must be free')
  chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
    '--headless=new',`--remote-debugging-port=${port}`,`--user-data-dir=${output}/profile-${Date.now()}`,
    '--no-first-run','--no-default-browser-check','--disable-background-timer-throttling',
    '--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','about:blank',
  ],{stdio:'ignore'})
  let target
  for(let i=0;i<100;i++){try{target=(await fetch(`${debug}/json`).then(r=>r.json())).find(t=>t.type==='page');if(target)break}catch{};await delay(100)}
  assert.ok(target)
  ws=new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject})
  let serial=0
  const pending=new Map()
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))})
  const api=request=>new Promise(resolve=>{
    const url=new URL(request.url),req=Readable.from(request.postData?[Buffer.from(request.postData)]:[])
    requests.push({path:url.pathname,method:request.method})
    req.url=url.pathname+url.search;req.method=request.method
    req.socket={remoteAddress:'127.0.0.1',localPort:Number(url.port)}
    req.headers={host:url.host,origin:url.origin,'x-astaria-local':'1','content-type':'application/json'}
    const res={statusCode:200,setHeader(){},end(body){resolve({status:this.statusCode,body})}}
    service.middleware(req,res,()=>resolve({status:404,body:'{}'}))
  })
  ws.onmessage=event=>{const m=JSON.parse(event.data)
    if(m.id){const cb=pending.get(m.id);pending.delete(m.id);m.error?cb.reject(m.error):cb.resolve(m.result)}
    else if(m.method==='Runtime.exceptionThrown')errors.push(m.params)
    else if(m.method==='Fetch.requestPaused')api(m.params.request).then(r=>send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:r.status,responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Cache-Control',value:'no-store'}],body:Buffer.from(r.body).toString('base64')})).catch(error=>errors.push(String(error)))
  }
  const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
  const wait=async expression=>{for(let i=0;i<200;i++){if(await ev(expression))return;await delay(75)}throw Error(`Timeout: ${expression}`)}
  const check=async(name,expression)=>{const pass=typeof expression==='string'?await ev(expression):expression;checks.push({name,pass});assert.equal(pass,true,name);console.log('PASS',name)}
  const probe=async(name,expression)=>{const pass=await ev(expression);checks.push({name,pass});console.log(pass?'PASS':'FAIL',name)}
  const click=async selector=>{await wait(`document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`);await ev(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'});true`);await delay(250)
    const p=await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();if(!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Occluded '+${JSON.stringify(selector)});return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});await delay(100)}
  const textClick=async(selector,text)=>{await ev(`(()=>{document.querySelectorAll('[data-qa-target]').forEach(e=>e.removeAttribute('data-qa-target'));const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing '+${JSON.stringify(text)});e.dataset.qaTarget='yes';return true})()`);await click('[data-qa-target=yes]')}
  const key=async(value)=>{await send('Input.dispatchKeyEvent',{type:'keyDown',key:value,code:value,windowsVirtualKeyCode:value==='Escape'?27:13,...(value==='Enter'?{text:'\r'}:{})});await send('Input.dispatchKeyEvent',{type:'keyUp',key:value,code:value,windowsVirtualKeyCode:value==='Escape'?27:13})}
  const field=async(selector,value)=>{await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e instanceof HTMLSelectElement?'change':'input',{bubbles:true}));return true})()`);await delay(200)}
  const shot=async name=>writeFile(`${output}/${name}.png`,Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'))
  const openSettings=async()=>{await click('.home-brand');await wait('document.querySelector("#home-menu").dataset.open==="true"');await textClick('#home-menu button','设置');await wait('!!document.querySelector("section.xixi-settings")&&!!document.querySelector("select[aria-label=默认模型]:not(:disabled)")');await delay(350)}
  const tab=async value=>{await textClick('.xixi-settings-tabs button',value);await delay(300)}
  const observeClose=()=>ev(`(()=>{window.__closeSamples=[];const sample=()=>{const d=document.querySelector('.xixi-settings');if(!d)return;const s=d.querySelector('.home-glass-surface'),css=getComputedStyle(s);window.__closeSamples.push({closing:d.dataset.closing,filter:css.backdropFilter,opacity:css.opacity,shadow:getComputedStyle(d).boxShadow,svg:Boolean(d.querySelector('.home-glass-definitions'))})};const observer=new MutationObserver(sample);observer.observe(document.querySelector('.xixi-settings'),{subtree:true,attributes:true,childList:true});window.__closeObserver=observer;return true})()`)
  const close=async()=>{await observeClose();await click('.xixi-settings-close');await wait('!document.querySelector(".xixi-settings")');await delay(250);await check('closing drops refraction and shadow in the same commit',"(()=>{window.__closeObserver.disconnect();const s=window.__closeSamples.filter(s=>s.closing==='true');return s.length>0&&s.every(v=>v.filter==='none'&&v.opacity==='0'&&v.shadow==='none'&&!v.svg)})()")}
  const phase=()=>ev('window.__ASTARIA_P0__.getSnapshot().responseEffect.phase')
  const camera=()=>ev(`(()=>{const s=window.__ASTARIA_P0__.getSnapshot();return [s.zoom,s.roll,s.inclination,s.centerX,s.centerY]})()`)
  await send('Page.enable');await send('Runtime.enable');await send('Network.enable')
  await send('Network.setBypassServiceWorker',{bypass:true});await send('Network.setCacheDisabled',{cacheDisabled:true})
  await send('Fetch.enable',{patterns:[{urlPattern:'*/api/*',requestStage:'Request'}]})
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false})
  await send('Page.navigate',{url:base})
  await wait('!!window.__ASTARIA_P0__&&!!document.querySelector(".home-current-title:not(:disabled)")')
  const baseline=await camera()
  await openSettings()
  await check('settings is a full page rather than a modal',"document.querySelector('.home-workspace').dataset.page==='settings'&&document.querySelector('.xixi-settings').tagName==='SECTION'&&!document.querySelector('dialog.xixi-settings')")
  await check('memory lives within the Xixi section',"document.querySelector('.xixi-settings-content').dataset.section==='析熙'&&!!document.querySelector('button[aria-label=使用长期记忆]')&&!!document.querySelector('.xixi-memory-manager')&&![...document.querySelectorAll('.xixi-settings-tabs button')].some(e=>e.textContent==='记忆')")
  await check('settings contents use outer page scrolling',"getComputedStyle(document.querySelector('.xixi-settings-content')).overflowY==='visible'&&getComputedStyle(document.querySelector('.xixi-settings-scroll')).overflowY==='auto'")
  await check('default glass keeps zero blur and background grid enabled',"document.querySelector('.xixi-settings feGaussianBlur').getAttribute('stdDeviation')==='0'&&document.querySelector('.home-workspace').dataset.grid==='true'")
  for (const [width, height] of [[1440,900],[1366,768],[1280,800],[1024,768]]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
    for (const section of ['通用','析熙','时间安排','通知','外观与动画','数据']) {
      await tab(section)
      // Quality and glass controls added in BetaX can require outer-page
      // scrolling. Verify reachability and horizontal fit, not the old height.
      await check(`${width}×${height} ${section}: settings and feedback remain reachable in the outer scroller`, `(()=>{
        const s=document.querySelector('.xixi-settings-scroll'),c=document.querySelector('.xixi-settings-content');
        const previous=s.scrollTop;s.scrollTop=s.scrollHeight;
        const f=document.querySelector('.xixi-settings-feedback').getBoundingClientRect(),r=s.getBoundingClientRect();
        const pass=f.top>=r.top&&f.bottom<=r.bottom+1&&s.scrollWidth<=s.clientWidth+1&&c.scrollWidth<=c.clientWidth+1&&getComputedStyle(c).overflowY==='visible';
        s.scrollTop=previous;return pass;
      })()`)
    }
    await tab('外观与动画');await shot(`fit-${width}x${height}`)
  }
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false})
  await check('exactly five FPS choices in requested order',`JSON.stringify([...document.querySelectorAll('.xixi-render-options strong')].map(e=>e.textContent))===JSON.stringify(['120 FPS','90 FPS','60 FPS','45 FPS','30 FPS'])`)
  await check('recommended quality owns the FPS choice and respects the workspace cap',"document.querySelector('select[aria-label=黑洞画质]').value==='auto'&&[...document.querySelectorAll('.xixi-render-options button')].every(e=>e.disabled)&&window.__ASTARIA_P0__.getSnapshot().targetFps===30")
  await field('select[aria-label="黑洞画质"]','ultra')
  await wait("!document.querySelector('.xixi-render-options button').disabled&&window.__ASTARIA_P0__.getSnapshot().quality==='ultra'")
  for (const [index,profile,rate] of [[1,'smooth120',30],[2,'smooth90',30],[3,'full',30],[4,'balanced',30],[5,'economy',30]]) {
    await click(`.xixi-render-options button:nth-child(${index})`)
    await wait(`window.__ASTARIA_P0__.getSnapshot().targetFps===${rate}&&window.__ASTARIA_P0__.getSnapshot().renderProfile==='${profile}'`)
    await check(`${profile}: setting persists and one choice stays selected`,getPreferences(db).render.profile===profile&&await ev(`document.querySelectorAll('.xixi-render-options button[aria-pressed=true]').length===1`))
    await check(`${profile}: FPS choice preserves manual ultra quality`,getPreferences(db).render.quality==='ultra'&&await ev("window.__ASTARIA_P0__.getSnapshot().quality==='ultra'"))
    if(rate<60) {
      await delay(500)
      const before=await ev('({frames:window.__ASTARIA_P0__.getSnapshot().renderedFrames,time:performance.now()})')
      await delay(2200)
      const after=await ev('({frames:window.__ASTARIA_P0__.getSnapshot().renderedFrames,time:performance.now()})')
      const measured=(after.frames-before.frames)*1000/(after.time-before.time)
      console.log('render cadence',profile,measured.toFixed(1))
      await check(`${profile}: renderer cadence is near ${rate} FPS`,Math.abs(measured-rate)<4)
    }
  }
  await click('.xixi-render-options button:nth-child(1)');await close()
  await wait('window.__ASTARIA_P0__.getSnapshot().targetFps===120')
  await check('120 profile gives homepage a 120 FPS target',"window.__ASTARIA_P0__.getSnapshot().renderScene==='home'")
  await click('.home-launch');await wait('!window.__ASTARIA_P0__.getSnapshot().cameraTransition')
  await check('home chat keeps 120 FPS target',"window.__ASTARIA_P0__.getSnapshot().targetFps===120")
  for (const destination of ['工作台','日程','余时','首页']) {
    await click('.home-brand');await textClick('#home-menu button',destination)
    await wait(`window.__ASTARIA_P0__.getSnapshot().targetFps===${destination==='首页'?120:30}`)
    await check(`${destination}: page-aware FPS switches without changing selected tier`,"window.__ASTARIA_P0__.getSnapshot().renderProfile==='smooth120'")
    await wait('document.querySelector("#home-menu").dataset.open==="false"&&!window.__ASTARIA_P0__.getSnapshot().cameraTransition');await delay(400)
  }
  await openSettings();await tab('外观与动画')
  await check('render selection survives leaving and reopening settings',"document.querySelector('.xixi-render-options button:first-child').getAttribute('aria-pressed')==='true'")
  if (renderPolicyOnly) {
    await close()
  } else {
  await click('.xixi-render-options button:nth-child(3)')
  for(const name of ['通用','析熙','时间安排','通知','外观与动画','数据']){
    await tab(name)
    await check(`desktop ${name} renders and remains within viewport`,`(()=>{const d=document.querySelector('.xixi-settings'),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&!!d.querySelector('section h3')})()`)
    await shot(`desktop-${name}`)
  }
  await tab('外观与动画')
  await field('select[aria-label="玻璃质感"]','soft')
  await check('soft glass applies six pixel blur',"document.querySelector('.xixi-settings feGaussianBlur').getAttribute('stdDeviation')==='6'")
  await field('select[aria-label="玻璃质感"]','clear')
  await click('button[aria-label="背景网格"]');await check('grid toggle updates shared page state',"document.querySelector('.home-workspace').dataset.grid==='false'")
  await click('button[aria-label="背景网格"]');await check('grid can return to its default state',"document.querySelector('.home-workspace').dataset.grid==='true'")
  for(const [index,style] of ['tide','filaments','stardust','off'].entries()){
    await click(`[aria-label="黑洞回应特效"] button:nth-child(${index+1})`)
    await wait(`window.__ASTARIA_P0__.getSnapshot().responseEffect.settings.style==='${style}'`)
    await check(`${style} persists to local service`,getPreferences(db).effect.style===style)
  }
  await click('[aria-label="黑洞回应特效"] button:nth-child(2)')
  await field('select[aria-label="特效强度"]','vivid');await field('select[aria-label="动态偏好"]','full')
  await check('intensity and motion persist',getPreferences(db).effect.intensity==='vivid'&&getPreferences(db).effect.motion==='full')
  await field('select[aria-label="动态偏好"]','reduced');await textClick('.xixi-settings-actions button','预览思考与回复')
  await check('manual reduced motion preview has a static response clock',"window.__ASTARIA_P0__.getSnapshot().responseEffect.reducedMotion&&window.__ASTARIA_P0__.getSnapshot().responseEffect.time===0")
  await textClick('.xixi-preview-dock button','返回设置');await delay(250);await field('select[aria-label="动态偏好"]','full')
  await textClick('.xixi-settings-actions button','预览思考与回复')
  await check('preview enters thinking',await phase()==='thinking')
  await delay(3250);await check('preview enters replying',await phase()==='replying')
  await shot('desktop-effect-preview')
  await delay(4050);await check('preview enters idle',await phase()==='idle')
  await delay(3400);await check('preview fully releases its override','document.querySelector(".xixi-settings").dataset.previewing==="false"')
  await check('preview makes zero model calls',providerCalls===0)
  await check('preview preserves frozen camera',JSON.stringify(await camera())===JSON.stringify(baseline))
  await textClick('.xixi-settings-actions button','预览思考与回复');await textClick('.xixi-preview-dock button','返回设置');await delay(250);await close();await delay(3400)
  await check('closing cancels pending preview transitions',await phase()==='idle')
  await openSettings();await tab('外观与动画')
  await click('[aria-label="黑洞回应特效"] button:nth-child(1)')
  const remote=getPreferences(db);remote.effect.style='stardust';db.setPreference('app',remote)
  await ev('document.dispatchEvent(new Event("visibilitychange"));true');await delay(500)
  await probe('remote preference refresh updates renderer while settings is open',"window.__ASTARIA_P0__.getSnapshot().responseEffect.settings.style==='stardust'")
  await probe('remote preference refresh updates open settings selected style',"document.querySelector('[aria-label=\"黑洞回应特效\"] button:nth-child(3)').getAttribute('aria-pressed')==='true'")
  const polled=getPreferences(db);polled.effect.intensity='standard';db.setPreference('app',polled)
  await wait("window.__ASTARIA_P0__.getSnapshot().responseEffect.settings.intensity==='standard'&&document.querySelector('select[aria-label=特效强度]').value==='standard'")
  await check('periodic polling updates renderer and settings without visibility events',"document.querySelector('select[aria-label=特效强度]').value==='standard'")
  await close();await check('closing settings uses refreshed stored effect',"window.__ASTARIA_P0__.getSnapshot().responseEffect.settings.style==='stardust'")
  await check('return restores homepage navigation',"document.querySelector('.home-workspace').dataset.page==='home'")
  await click('.home-brand');await textClick('#home-menu button','工作台');await wait("document.querySelector('.home-workspace').dataset.page==='workbench'")
  await openSettings();await close();await check('settings opened from workbench returns to workbench',"document.querySelector('.home-workspace').dataset.page==='workbench'")
  await click('.home-brand');await textClick('#home-menu button','首页');await wait("document.querySelector('.home-workspace').dataset.page==='home'")
  await click('.home-launch');await wait('!window.__ASTARIA_P0__.getSnapshot().cameraTransition');await delay(400)
  const chatCamera=await camera()
  const submit=async text=>{await click('#home-compose');await send('Input.insertText',{text});await key('Enter');await wait('window.__ASTARIA_P0__.getSnapshot().responseEffect.phase==="thinking"')}
  await submit('独立测试正常回复')
  await check('submitted user message is visible during thinking',"[...document.querySelectorAll('.xixi-message[data-role=user]')].some(e=>e.textContent.includes('独立测试正常回复'))")
  releaseProvider();await wait('window.__ASTARIA_P0__.getSnapshot().responseEffect.phase==="replying"')
  await check('real response enters replying with formatted text',"!!document.querySelector('.xixi-message[data-role=assistant] strong')")
  await click('.xixi-message-retract');await delay(150)
  await probe('retracting a just-completed reply stops the replying phase',"window.__ASTARIA_P0__.getSnapshot().responseEffect.phase==='idle'")
  await check('retraction restores editable draft',"document.querySelector('#home-compose').value==='独立测试正常回复'")
  await ev("document.querySelector('#home-compose').select();true");await send('Input.insertText',{text:'独立测试等待中撤回'});await key('Enter')
  await wait('window.__ASTARIA_P0__.getSnapshot().responseEffect.phase==="thinking"')
  await click('.xixi-message-retract');await check('retraction during thinking resets phase',await phase()==='idle')
  releaseProvider();await delay(500);await check('late retracted provider response never restarts effect',await phase()==='idle')
  providerMode='fail'
  await ev("document.querySelector('#home-compose').focus();document.querySelector('#home-compose').select();true");await send('Input.insertText',{text:'独立测试请求失败'});await key('Enter')
  await wait('window.__ASTARIA_P0__.getSnapshot().responseEffect.phase==="thinking"');releaseProvider()
  await wait('window.__ASTARIA_P0__.getSnapshot().responseEffect.phase==="idle"')
  await check('failed request resets effect and keeps retry UI',"!!document.querySelector('.xixi-send-error')")
  await check('chat phases preserve interstellar camera',JSON.stringify(await camera())===JSON.stringify(chatCamera))
  providerMode='reply'
  await ev("document.querySelector('#home-compose').focus();document.querySelector('#home-compose').select();true");await send('Input.insertText',{text:'保留作旧消息的独立测试'});await key('Enter')
  await wait('window.__ASTARIA_P0__.getSnapshot().responseEffect.phase==="thinking"');releaseProvider()
  await wait('window.__ASTARIA_P0__.getSnapshot().responseEffect.phase==="replying"')
  await submit('这条还在思考请勿被旧消息影响')
  await ev("(()=>{const m=[...document.querySelectorAll('.xixi-message[data-role=user]')].find(e=>e.textContent.includes('保留作旧消息的独立测试'));m.querySelector('.xixi-message-retract').dataset.oldMessage='yes';return true})()")
  await click('[data-old-message=yes]')
  await probe('withdrawing an older message does not cancel a newer thinking phase',"window.__ASTARIA_P0__.getSnapshot().responseEffect.phase==='thinking'")
  releaseProvider();await delay(4500)
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true})
  await delay(500);await openSettings()
  for(const name of ['通用','析熙','时间安排','通知','外观与动画','数据']){
    await tab(name)
    await probe(`390px ${name} has no clipping or horizontal overflow`,`(()=>{const d=document.querySelector('.xixi-settings'),r=d.getBoundingClientRect(),c=d.querySelector('.xixi-settings-content');return r.left>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1&&c.scrollWidth<=c.clientWidth+1})()`)
    await shot(`mobile-${name}`)
    if(name==='时间安排')await check('390px time range titles occupy readable full rows',"[...document.querySelectorAll('.xixi-setting-row:has(input[type=time])>div:first-child')].every(e=>e.getBoundingClientRect().width>280)")
  }
  await tab('外观与动画');await textClick('.xixi-settings-actions button','预览思考与回复');await delay(300)
  await check('mobile preview leaves most of the black hole visible',"(()=>{const d=document.querySelector('.xixi-preview-dock'),r=d.getBoundingClientRect();return r.height<=innerHeight*.4&&r.top>=innerHeight*.55&&getComputedStyle(document.querySelector('.xixi-settings-scroll')).visibility==='hidden'})()")
  await probe('effect preview hides underlying page text and chat panels',"(()=>{const e=document.querySelector('.home-scene-ui'),s=getComputedStyle(e);return s.visibility==='hidden'||s.display==='none'||s.opacity==='0'})()")
  await textClick('.xixi-preview-dock button','光潮');await check('mobile preview switches style directly',"window.__ASTARIA_P0__.getSnapshot().responseEffect.settings.style==='tide'")
  await shot('mobile-effect-preview')
  await ev("window.__settingsScrollBefore=document.querySelector('.xixi-settings-scroll').scrollTop;true")
  await ev(`(()=>{window.__dockLeave=[];const e=document.querySelector('.xixi-settings');const observer=new MutationObserver(()=>{if(e.dataset.previewState==='leaving'){const d=e.querySelector('.xixi-preview-content'),g=e.querySelector('.xixi-preview-dock .home-glass-surface');window.__dockLeave.push({animation:getComputedStyle(d).animationName,filter:getComputedStyle(g).backdropFilter,opacity:getComputedStyle(g).opacity})}});observer.observe(e,{subtree:true,attributes:true,childList:true});window.__dockLeaveObserver=observer;return true})()`)
  await textClick('.xixi-preview-dock button','返回设置');await delay(300);await check('return from mobile preview restores settings',"getComputedStyle(document.querySelector('.xixi-settings-scroll')).opacity==='1'&&document.querySelector('.xixi-settings').dataset.previewing==='false'")
  await check('preview closing animates contents while optical sampling stops immediately',"(()=>{window.__dockLeaveObserver.disconnect();return window.__dockLeave.length>0&&window.__dockLeave.every(v=>v.animation==='settings-dock-out'&&v.filter==='none'&&v.opacity==='0')})()")
  await check('preview restores page scroll position',"Math.abs(document.querySelector('.xixi-settings-scroll').scrollTop-window.__settingsScrollBefore)<2")
  await check('settings page scrolls long content without nested content scroll',"document.querySelector('.xixi-settings-scroll').scrollTop>0&&document.querySelector('.xixi-settings-content').scrollTop===0")
  await textClick('.xixi-settings-actions button','预览思考与回复')
  await key('Escape');await delay(300);await check('Escape first returns from preview to its settings page',"!!document.querySelector('.xixi-settings')&&document.querySelector('.xixi-settings').dataset.previewing==='false'");await key('Escape');await wait('!document.querySelector(".xixi-settings")');await delay(3400)
  await check('Escape on mobile releases preview and restores focus',"window.__ASTARIA_P0__.getSnapshot().responseEffect.phase==='idle'&&document.activeElement!==document.body")
  }
  await check('no browser runtime errors',errors.length===0)
}catch(error){failure=String(error);console.error(error);process.exitCode=1}
finally{releaseProvider?.();await writeFile(`${output}/results.json`,JSON.stringify({checks,errors,requests,providerCalls,failure},null,2));ws?.close();chrome?.kill('SIGTERM');db.close();if(checks.some(c=>!c.pass))process.exitCode=1;console.log(JSON.stringify({passed:checks.filter(c=>c.pass).length,failed:checks.filter(c=>!c.pass),failure}))}
