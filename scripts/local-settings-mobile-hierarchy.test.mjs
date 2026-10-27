import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../', import.meta.url))
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const delay = ms => new Promise(done => setTimeout(done, ms))
// Original components/styles, isolated fake API and a temporary browser profile.
// No app bootstrap, server, user database, vault or external model is started.
const fixture = `
import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LocalSettings } from './src/xixi/LocalSettings.tsx'
import { AdaptiveSelect, AdaptiveSelectHost } from './src/ui/AdaptiveSelect.tsx'
import { GlassRenderingContext } from './src/home/GlassSurface.tsx'
import { DEFAULT_PREFERENCES, publishPreferences } from './src/xixi/preferences.ts'
import './src/prototype/prototype.css'
import './src/home/home.css'
import './src/home/theme.css'
import './mobile/runtime/mobile.css'
const f = window.fixture = { calls:[], changes:[], multiChanges:[], closed:0 }
const config={provider:'deepseek',cloudModel:'deepseek-flash',reasoningEffort:'high',streamResponses:false,contextBudget:{mode:'custom',maxUnits:96000},webSearch:{enabled:false,maxUses:4},local:{engine:'lmstudio',baseUrl:'http://127.0.0.1:1234/v1',model:'synthetic-local'}}
f.status=()=>({configured:true,cloudConfigured:true,service:'astaria-local',storage:'SQLite',model:f.config.cloudModel,provider:'deepseek',providerSettings:structuredClone(f.config),secretStorage:'合成安全存储',dataDirectory:'synthetic'})
f.api=async(path,body)=>{
 f.calls.push({path,body:structuredClone(body)})
 if(f.failPath===path&&body!==undefined)throw Error('合成保存失败；设置与草稿仍可重新核对')
 if(path==='/status')return f.status()
 if(path==='/preferences'){if(body){if(JSON.stringify(body.expected)!==JSON.stringify(f.preferences))throw Error('合成设置冲突');f.preferences=structuredClone(body.value)}return structuredClone(f.preferences)}
 if(path==='/settings/provider'){f.config=structuredClone(body);return f.status()}
 if(path==='/planner')return {revision:1,timetableConfirmed:false,routines:[],blocks:[],details:{},checked:{}}
 if(path==='/memories'||path==='/operations')return []
 if(path==='/desktop/updates')return {supported:false,status:'unavailable',automatic:false,error:null,current:{version:'synthetic',platform:'android'}}
 if(path==='/desktop/reminders')return {supported:false,platform:'web-preview',enabled:false,authorization:0,count:0,through:null,omitted:0,error:null}
 if(path==='/sync/status')return {available:false,configured:false,message:'合成环境',conflicts:[]}
 if(path==='/data/export')return {format:'astaria-backup',version:1,tables:{tasks:[]},checksum:'synthetic'}
 throw Error('未声明的合成 API '+path)
}
f.visible=e=>Boolean(e&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&!e.closest('[hidden],[inert]'))
f.button=text=>[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===text&&f.visible(e))
f.wait=async condition=>{for(let i=0;i<180;i++){if(condition())return;await new Promise(requestAnimationFrame)}throw Error('UI did not settle')}
f.input=(element,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}))}
let root
function SelectFixture(){const host=useRef(null),underlay=useRef(null),[open,setOpen]=useState(false),[value,setValue]=useState('b'),[disabled,setDisabled]=useState(false);f.disable=setDisabled;return <AdaptiveSelectHost target={host} underlayRef={underlay} onOpenChange={setOpen}><section ref={host} className="xixi-settings" data-theme="dark"><div ref={underlay} className="fixture-controls" inert={open}><form id="select-form"><label htmlFor="contract-select">契约选择</label><AdaptiveSelect id="contract-select" name="choice" required disabled={disabled} value={value} onChange={event=>{f.changes.push({value:event.target.value,id:event.target.id,isSelect:event.target instanceof HTMLSelectElement});setValue(event.target.value)}}><option value="a">Alpha</option><option value="skip" disabled>Disabled option</option><optgroup label="Second group"><option value="b">Beta</option><option value="c">Gamma</option></optgroup></AdaptiveSelect><label htmlFor="default-select">默认值选择</label><AdaptiveSelect id="default-select" name="defaultChoice" defaultValue="z"><option value="x">X</option><option value="z">Z</option></AdaptiveSelect><AdaptiveSelect id="multiple-select" name="choices" aria-label="多选契约" multiple defaultValue={['a']} onChange={event=>f.multiChanges.push([...event.target.selectedOptions].map(o=>o.value))}><option value="a">One</option><option value="b">Two</option><option value="c">Three</option></AdaptiveSelect><label htmlFor="required-select">必填契约</label><AdaptiveSelect id="required-select" name="requiredChoice" required defaultValue=""><option value="" disabled>请选择</option><option value="valid">Valid</option></AdaptiveSelect><button type="reset">重置表单</button></form></div></section></AdaptiveSelectHost>}
f.mount=async(platform='android',theme='dark',glass='clear',kind='settings',rendering='auto')=>{
 root?.unmount();f.calls=[];f.changes=[];f.multiChanges=[];f.closed=0;f.failPath=null;f.config=structuredClone(config);f.preferences=structuredClone(DEFAULT_PREFERENCES);f.preferences.theme=theme;f.preferences.glass=glass;f.preferences.render.glass=rendering;publishPreferences(f.preferences)
 if(platform==='desktop')delete document.documentElement.dataset.mobile;else document.documentElement.dataset.mobile=platform
 document.querySelector('.home-workspace').dataset.theme=theme;document.querySelector('.p0').dataset.night=String(theme==='dark');document.querySelector('.p0').style.background=theme==='dark'?'radial-gradient(ellipse at 100% 30%,#8f744b55,#050506 65%)':'radial-gradient(ellipse at 100% 30%,#fff4da,#b5b9c0 80%)'
 root=createRoot(document.querySelector('#root'));root.render(<GlassRenderingContext.Provider value={rendering}>{kind==='select'?<SelectFixture/>:<LocalSettings initialTab={platform==='desktop'?'外观与动画':'析熙'} onClose={()=>queueMicrotask(()=>{root.unmount();f.closed++})} onSaved={()=>{}}/>}</GlassRenderingContext.Provider>)
 await f.wait(()=>document.querySelector('.xixi-settings'));if(kind==='settings')await f.wait(()=>f.calls.some(c=>c.path==='/operations'));await new Promise(requestAnimationFrame)
}
f.settle=async()=>{await f.wait(()=>!document.querySelector('.adaptive-select-dialog[data-phase="entering"],.adaptive-select-dialog[data-phase="exiting"],.xixi-settings[data-navigation-phase="entering"],.xixi-settings[data-navigation-phase="exiting"]'));await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));await new Promise(requestAnimationFrame)}
f.ready=true
`

test('original settings mobile hierarchy and native-compatible adaptive selection', { timeout: 180000 }, async t => {
  try { await access(chromePath) } catch { t.skip('Local Chrome unavailable; nothing is installed'); return }
  const temporary = await mkdtemp(join(tmpdir(), 'astaria-original-settings-'))
  let server, chrome, socket
  t.after(async () => {
    socket?.close()
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise(done => chrome.once('close', done)); chrome.kill(); await Promise.race([exited, delay(1500)])
      if (chrome.exitCode === null && chrome.signalCode === null) { chrome.kill('SIGKILL'); await exited }
    }
    if (server) await new Promise(done => server.close(done))
    await rm(temporary, { recursive:true, force:true, maxRetries:5, retryDelay:100 })
  })
  const entry = join(project, '__synthetic-original-settings__.tsx')
  const bundle = await build({ configFile:false, root:project, envDir:temporary, publicDir:false, cacheDir:join(temporary,'cache'), logLevel:'error', plugins:[react(),{
    name:'original-settings-synthetic-api', enforce:'pre', resolveId(id, importer) {
      if (id==='virtual:original-settings') return entry
      if (/(?:^|\/)api(?:\.ts)?$/u.test(id) && importer?.includes(project)) return '\0fake-api'
    }, load(id) {
      if (id===entry) return fixture
      if (id==='\0fake-api') return 'export class LocalApiError extends Error{constructor(message,status){super(message);this.status=status}}export const localApi=(path,body)=>window.fixture.api(path,body)'
    },
  }], build:{ write:false, outDir:temporary, emptyOutDir:false, minify:false, cssCodeSplit:false, rollupOptions:{ input:'virtual:original-settings', output:{entryFileNames:'app.js',assetFileNames:'app.[ext]'} } } })
  const assets = new Map((Array.isArray(bundle)?bundle:[bundle]).flatMap(result=>result.output).map(file=>[`/${file.fileName}`,file.type==='chunk'?file.code:file.source]))
  server=createServer((request,response)=>{
    if(request.url==='/'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>html,body{margin:0;height:100%}.fixture-controls{padding:100px 24px}.fixture-controls label{display:block}</style><div class="p0"><div class="home-workspace" data-page="settings"><div id="root"></div></div></div><script type="module" src="/app.js"></script>');return}
    const asset=assets.get(request.url);if(!asset){response.statusCode=404;response.end();return}response.setHeader('Content-Type',request.url.endsWith('.css')?'text/css':'text/javascript');response.end(asset)
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done))
  const profile=join(temporary,'profile')
  chrome=spawn(chromePath,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update'],{stdio:'ignore'})
  let port
  for(let i=0;i<120;i++){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break}catch{await delay(50)}}
  assert.ok(port)
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  socket=new WebSocket(targets.find(target=>target.type==='page').webSocketDebuggerUrl)
  await new Promise((done,fail)=>{socket.addEventListener('open',done,{once:true});socket.addEventListener('error',fail,{once:true})})
  let id=0;const waiting=new Map()
  socket.addEventListener('message',event=>{const result=JSON.parse(event.data);if(result.id){const pending=waiting.get(result.id);waiting.delete(result.id);if(result.error)pending.reject(Error(result.error.message));else pending.resolve(result.result)}})
  const command=(method,params={})=>new Promise((resolve,reject)=>{const requestId=++id;waiting.set(requestId,{resolve,reject});socket.send(JSON.stringify({id:requestId,method,params}))})
  const evaluate=async expression=>{const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value}
  let lastPoint
  const click=async (expression,settle=true)=>{
    const point=await evaluate(`(()=>{const e=${expression};if(!e)throw Error('Missing target '+${JSON.stringify(expression)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Covered target '+e.textContent);return{x,y}})()`)
    lastPoint=point
    await command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});await evaluate(settle?'fixture.settle()':'new Promise(requestAnimationFrame)')
  }
  const repeatPointer=async()=>{await command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:2,...lastPoint});await command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:2,...lastPoint})}
  const button=text=>click(`fixture.button(${JSON.stringify(text)})`)
  const key=async (value,settle=true)=>{await command('Input.dispatchKeyEvent',{type:'keyDown',key:value});await command('Input.dispatchKeyEvent',{type:'keyUp',key:value});await evaluate(settle?'fixture.settle()':'new Promise(requestAnimationFrame)')}
  const viewport=width=>command('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<700})
  const output=process.env.ASTARIA_ORIGINAL_SETTINGS_QA?resolve(process.env.ASTARIA_ORIGINAL_SETTINGS_QA):null
  const shot=async (name,settle=true)=>{if(!output)return;if(settle)await evaluate('Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})))');await mkdir(output,{recursive:true});const result=await command('Page.captureScreenshot',{format:'png'});await writeFile(join(output,name+'.png'),Buffer.from(result.data,'base64'))}
  const assertVisibleUnderlay=async prefix=>{
    const state=await evaluate(`(()=>{const u=document.querySelector('.xixi-settings-scroll');return {glass:window.fixture.preferences.glass,masked:[...u.querySelectorAll('[style]')].some(e=>e.style.maskImage||e.style.clipPath),visible:getComputedStyle(u).visibility,samplers:[...u.querySelectorAll('.home-glass-backdrop')].map(e=>({visible:getComputedStyle(e).visibility,filter:getComputedStyle(e).backdropFilter,sampling:e.dataset.sampling}))}})()`)
    assert.equal(state.masked,false,'TaskDialog hierarchy retains the original page, without paint cutouts')
    assert.equal(state.visible,'visible')
    assert.ok(state.samplers.length>0)
    assert.ok(state.samplers.every(e=>e.visible==='visible'&&e.sampling==='true'&&(state.glass==='clear'||e.filter!=='none')),`original glass remains active behind the chooser: ${JSON.stringify(state)}`)
    await shot(prefix+'-visible-underlay')
  }
  await command('Page.enable');await command('Runtime.enable');await viewport(390)
  await command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`})
  for(let i=0;i<120&&!await evaluate('Boolean(window.fixture?.ready)');i++)await delay(50)
  assert.equal(await evaluate('Boolean(window.fixture?.ready)'),true)
  const desktopUA=await evaluate('navigator.userAgent')
  const androidUA='Mozilla/5.0 (Linux; Android 14; Synthetic) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
  await command('Emulation.setUserAgentOverride',{userAgent:androidUA})
  const tabs=['通用','析熙','时间安排','通知','外观与动画','数据']
  for(const width of [320,390,820])for(const theme of ['dark','light'])for(const glass of ['clear','soft']){
    await viewport(width);await evaluate(`fixture.mount('android',${JSON.stringify(theme)},${JSON.stringify(glass)})`)
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".xixi-settings-directory button")].map(e=>e.textContent)'),tabs)
    await evaluate('fixture.settle()')
    const tiles=await evaluate('(()=>{const directory=document.querySelector(".xixi-settings-directory"),d=directory.getBoundingClientRect();return {width:d.width,entries:[...directory.querySelectorAll("button")].map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {x:r.x,y:r.y,w:r.width,h:r.height,radius:parseFloat(s.borderRadius),font:getComputedStyle(e.querySelector("strong")).fontSize,icon:!!e.querySelector(".xixi-settings-directory-icon svg"),arrow:!!e.querySelector(".xixi-settings-directory-arrow svg")}})}})()')
    assert.equal(new Set(tiles.entries.map(r=>r.x)).size,1,'one full-width settings row at '+width)
    assert.equal(new Set(tiles.entries.map(r=>r.y)).size,6,'six vertical settings rows at '+width)
    for(const tile of tiles.entries){assert.ok(Math.abs(tile.w-tiles.width)<1&&tile.h>=54);assert.ok(tile.radius>=12&&tile.radius<=14);assert.equal(tile.font,'13px');assert.equal(tile.icon,true);assert.equal(tile.arrow,true)}
    assert.equal(await evaluate('document.querySelector(".xixi-settings-content").hidden'),true)
    assert.equal(await evaluate('document.querySelectorAll(".xixi-settings-tabs").length'),0)
    assert.equal(await evaluate('document.querySelector(".xixi-settings-mobile-back")'),null,'directory is a top-level destination, without a redundant back button')
    await shot(`${width}-${theme}-${glass}-directory`)
    await button('外观与动画')
    assert.equal(await evaluate('document.querySelector("#xixi-settings-title").textContent'),'外观与动画')
    assert.equal(await evaluate('document.querySelector(".xixi-settings-directory").hidden'),true)
    assert.equal(await evaluate('document.querySelector(".xixi-settings-content").hidden'),false)
    await shot(`${width}-${theme}-${glass}-appearance`)
    await click('document.querySelector(".adaptive-select-trigger[aria-label=\\"黑洞画质\\"]")')
    assert.equal(await evaluate('document.querySelector(".adaptive-select-dialog").parentElement.classList.contains("xixi-settings")'),true)
    assert.deepEqual(await evaluate('({inert:document.querySelector(".xixi-settings-scroll").inert,visibility:getComputedStyle(document.querySelector(".xixi-settings-scroll")).visibility,dialog:getComputedStyle(document.querySelector(".adaptive-select-dialog")).visibility})'),{inert:true,visibility:'visible',dialog:'visible'})
    assert.equal(await evaluate('document.querySelectorAll(".adaptive-select-dialog [role=option]").length'),5)
    assert.equal(await evaluate('document.querySelector(".adaptive-select-dialog").matches(":modal")'),true)
    const chooser=await evaluate(`(()=>{const d=document.querySelector('.adaptive-select-dialog'),r=d.getBoundingClientRect(),t=document.querySelector('.adaptive-select-trigger[aria-label="黑洞画质"]').getBoundingClientRect(),s=getComputedStyle(d),title=getComputedStyle(d.querySelector('.adaptive-select-title'));return {width:r.width,height:r.height,gap:Math.min(Math.abs(r.top-t.bottom),Math.abs(t.top-r.bottom)),radius:s.borderRadius,font:s.fontSize,title:title.fontSize,weight:title.fontWeight,header:!!d.querySelector('header,.adaptive-select-close'),reused:d.classList.contains('home-task-dialog')}})()`)
    assert.equal(chooser.reused,true);assert.equal(chooser.header,false);assert.ok(chooser.width<=280&&chooser.height<=360);assert.ok(chooser.gap>=5&&chooser.gap<=7);assert.equal(chooser.radius,'19px');assert.equal(chooser.font,'13px');assert.equal(chooser.title,'13px');assert.equal(chooser.weight,'400')
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".adaptive-select-dialog")).backgroundColor'),'rgba(0, 0, 0, 0)')
    assert.equal(await evaluate('document.querySelector(".adaptive-select-dialog .home-glass-measure")!==null'),true)
    assert.match(await evaluate('getComputedStyle(document.querySelector(".adaptive-select-dialog .home-glass-backdrop")).backdropFilter'), /blur\(6px\)/, 'chooser stays frosted over both clear and frosted settings')
    const clip=await evaluate(`(()=>{const u=document.querySelector('.xixi-settings-scroll'),layers=[...u.querySelectorAll('[style]')].filter(e=>e.style.maskImage),samplers=[...u.querySelectorAll('.home-glass-backdrop')];return {root:u.style.clipPath,emptySamplingAncestors:samplers.every(e=>{for(let p=e.parentElement;p&&p!==u;p=p.parentElement)if(p.style.clipPath||p.style.maskImage)return false;return true}),layers:layers.length,isolated:samplers.every(e=>getComputedStyle(e).visibility!=='hidden'),visibleHeader:getComputedStyle(document.querySelector('.xixi-settings-page-header')).visibility}})()`)
    assert.equal(clip.root,'');assert.equal(clip.emptySamplingAncestors,true);assert.equal(clip.layers,0);assert.equal(clip.isolated,true);assert.equal(clip.visibleHeader,'visible')
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".adaptive-select-dialog"),"::backdrop").backgroundColor'),theme==='dark'?'rgba(0, 0, 0, 0.22)':'rgba(53, 64, 75, 0.09)','TaskDialog uses a slight backdrop tint while retaining context')
    const frames=await evaluate(`(()=>{const l=document.querySelector('.adaptive-select-options'),s=document.querySelector('[role=option][aria-selected=true]');return {list:getComputedStyle(l).outlineStyle,selected:getComputedStyle(s).outlineStyle,border:getComputedStyle(s).borderTopColor,shadow:getComputedStyle(s).boxShadow,active:l.getAttribute('aria-activedescendant'),check:s.querySelectorAll('svg').length}})()`)
    assert.deepEqual({list:frames.list,selected:frames.selected,border:frames.border,shadow:frames.shadow,check:frames.check},{list:'none',selected:'none',border:'rgba(0, 0, 0, 0)',shadow:'none',check:1});assert.ok(frames.active)
    await key('ArrowDown')
    assert.equal(await evaluate('document.querySelector(".adaptive-select-options").getAttribute("aria-activedescendant")===document.querySelector("[role=option][data-active=true]").id'),true)
    assert.equal(await evaluate('getComputedStyle(document.querySelector("[role=option][data-active=true]")).backgroundColor!==getComputedStyle(document.querySelector("[role=option]:not([data-active=true]):not([aria-selected=true])")).backgroundColor'),true,'real keyboard indicator is on active option')
    await shot(`${width}-${theme}-${glass}-chooser`)
    if(width===390)await assertVisibleUnderlay(`${width}-${theme}-${glass}`)
    await key('Escape')
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'),'黑洞画质')
    assert.equal(await evaluate('document.querySelector(".xixi-settings-scroll").inert'),false)
    assert.equal(await evaluate('document.querySelector(".xixi-settings-scroll").style.clipPath'),'')
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth+1'),false)
  }
  for(const theme of ['dark','light']){
    await viewport(390);await evaluate(`fixture.mount('android',${JSON.stringify(theme)},'soft','settings','detailed')`);await evaluate('fixture.settle()');await button('外观与动画')
    await click('document.querySelector(".adaptive-select-trigger[aria-label=\\"黑洞画质\\"]")')
    assert.match(await evaluate('document.querySelector(".adaptive-select-dialog .home-glass-backdrop").style.backdropFilter'), /^blur\(6px\) url\(/)
    await assertVisibleUnderlay(`390-${theme}-soft-detailed`);await shot(`390-${theme}-soft-detailed-chooser`);await key('Escape')
  }
  // Inspect every directory/section boundary with real running motion. The
  // directory and details share one fixed phone glass viewport, so only their
  // foreground content moves; sampler geometry must stay stable.
  await viewport(390);await evaluate("fixture.mount('android','dark','clear','settings','detailed')");await evaluate('fixture.settle()')
  const transitionEvidence=[]
  for(const tab of tabs) {
    for(const returning of [false,true]) {
      await evaluate(`(()=>{const p=document.querySelector('.xixi-settings-panel'),s=p.querySelector('.home-glass-surface'),b=p.querySelector('.home-glass-backdrop');window.__settingsTrack={panel:p,surface:s,backdrop:b,rows:[],done:false};const tick=()=>{const q=window.__settingsTrack,e=document.querySelector('.xixi-settings'),r=p.getBoundingClientRect(),c=getComputedStyle(p),backdrop=p.querySelector('.home-glass-backdrop');q.rows.push({at:performance.now(),phase:e.dataset.navigationPhase,view:e.dataset.mobileView,height:r.height,top:r.top,samePanel:p===q.panel,sameSurface:p.querySelector('.home-glass-surface')===q.surface,sameBackdrop:backdrop===q.backdrop,sampling:backdrop?.dataset.sampling,filter:getComputedStyle(backdrop).backdropFilter,fill:getComputedStyle(s).backgroundColor,opacity:c.opacity,transform:c.transform});if(!q.done)requestAnimationFrame(tick)};tick()})()`)
      await click(returning?'document.querySelector(".xixi-settings-mobile-back")':`fixture.button(${JSON.stringify(tab)})`)
      const trace=await evaluate('window.__settingsTrack.done=true;window.__settingsTrack.rows')
      assert.ok(trace.every(x=>x.samePanel&&x.sameSurface&&x.sameBackdrop&&x.sampling==='true'&&x.filter!=='none'&&x.opacity==='1'&&x.transform==='none'),'sampling stays on the same opaque, refracting glass plane')
      assert.equal(new Set(trace.map(x=>x.fill)).size,1,'no tint flash during navigation')
      assert.ok(Math.max(...trace.map(x=>x.top))-Math.min(...trace.map(x=>x.top))<1,`directory and section share their glass top edge: ${JSON.stringify(trace.map(x=>({phase:x.phase,view:x.view,top:x.top})))}`)
      assert.ok(Math.max(...trace.map(x=>x.height))-Math.min(...trace.map(x=>x.height))<1,'shared phone glass viewport does not resize during a section transition')
      const resting=await evaluate(`(()=>{const p=document.querySelector('.xixi-settings-panel');return {height:p.style.height,overflow:p.style.overflow,animations:p.getAnimations().filter(a=>a.playState==='running').length}})()`)
      assert.deepEqual(resting,{height:'',overflow:'',animations:0},'fixed viewport has no transient inline geometry after a transition')
      transitionEvidence.push({tab,returning,trace})
    }
  }
  if(output)await writeFile(join(output,'settings-panel-motion.json'),JSON.stringify(transitionEvidence,null,2))
  // Inspect the actual interrupted stages, rather than inferring exit from CSS.
  const stage=async(name,selector,expected)=>{
    const layeredExit=selector==='.adaptive-select-dialog'
    // The chooser keeps its dialog shell fixed so its live backdrop never
    // flashes. Its title/content carry the entering and exiting paint motion.
    const paintSelector=layeredExit?'.adaptive-select-dialog .adaptive-select-title':selector
    await evaluate(`fixture.wait(()=>{const e=document.querySelector(${JSON.stringify(paintSelector)});return e&&Number(getComputedStyle(e).opacity)>0&&Number(getComputedStyle(e).opacity)<1})`)
    const state=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(paintSelector)}),a=e?.getAnimations()[0];return {phase:document.querySelector('.xixi-settings').dataset.navigationPhase,dialog:document.querySelector('.adaptive-select-dialog')?.dataset.phase,animated:!!a,duration:a?.effect.getTiming().duration,opacity:e&&getComputedStyle(e).opacity,transform:e&&getComputedStyle(e).transform}})()`)
    assert.equal(selector==='.adaptive-select-dialog'?state.dialog:state.phase,expected)
    if(layeredExit)assert.deepEqual(await evaluate(`(()=>{const d=document.querySelector('.adaptive-select-dialog'),s=document.querySelector('.xixi-settings-panel .home-glass-backdrop');return {opacity:getComputedStyle(d).opacity,transform:getComputedStyle(d).transform,baseClip:s.style.clipPath}})()`),{opacity:'1',transform:'none',baseClip:''},'the original sampler covers the outgoing popup before it fades')
    assert.equal(state.animated,true);assert.ok(state.duration>=140&&state.duration<=360)
    assert.ok(Number(state.opacity)>0&&Number(state.opacity)<1);assert.notEqual(state.transform,'none')
    // Pause only to record an inspectable midpoint; the same running animation
    // is then resumed, and all state changes still wait for its finished promise.
    await evaluate(`document.getAnimations().forEach(a=>{a.pause();a.currentTime=a.effect.getTiming().duration/2})`)
    await shot(name,false)
    await evaluate('document.getAnimations().forEach(a=>a.play())')
  }
  await viewport(390);await evaluate("fixture.mount('android')");await evaluate('fixture.settle()')
  await click('fixture.button("外观与动画")',false)
  await repeatPointer()
  assert.equal(await evaluate('document.querySelector(".xixi-settings-directory").hidden'),false,'outgoing directory remains mounted and visible')
  assert.equal(await evaluate('[...document.querySelectorAll(".xixi-settings-directory button,.xixi-settings-mobile-back")].every(e=>e.disabled)'),true)
  await stage('390-nav-forward-exit','.xixi-settings-directory','exiting')
  await evaluate('fixture.wait(()=>document.querySelector(".xixi-settings").dataset.navigationPhase==="entering")')
  await stage('390-nav-forward-enter','.xixi-settings-content','entering');await evaluate('fixture.settle()')
  const ancestors=await evaluate(`(()=>{let e=document.querySelector('.xixi-settings-content strong');const out=[];while(e){const s=getComputedStyle(e);out.push({name:e.className,transform:s.transform,opacity:s.opacity,filter:s.filter,backdrop:s.backdropFilter});e=e.parentElement}return out})()`)
  for(const ancestor of ancestors){assert.equal(ancestor.transform,'none',String(ancestor.name));assert.equal(ancestor.opacity,'1');assert.equal(ancestor.filter,'none');assert.equal(ancestor.backdrop,'none')}
  await evaluate('document.querySelector(".xixi-settings-content").scrollTop=120')
  const sectionTop=await evaluate('document.querySelector(".xixi-settings-content").scrollTop')
  await key('Escape',false)
  await stage('390-nav-back-exit','.xixi-settings-content','exiting')
  await evaluate('fixture.wait(()=>document.querySelector(".xixi-settings").dataset.navigationPhase==="entering")')
  await stage('390-nav-back-enter','.xixi-settings-directory','entering');await evaluate('fixture.settle()')
  assert.equal(await evaluate('document.activeElement.textContent'),'外观与动画')
  await button('外观与动画')
  assert.equal(await evaluate('document.querySelector(".xixi-settings-content").scrollTop'),sectionTop)

  const qualityTrigger='document.querySelector(".adaptive-select-trigger[aria-label=\\"黑洞画质\\"]")'
  await click(qualityTrigger,false)
  await repeatPointer()
  assert.equal(await evaluate('document.querySelectorAll(".adaptive-select-dialog").length'),1)
  assert.equal(await evaluate('[...document.querySelectorAll(".adaptive-select-dialog button")].every(e=>e.disabled)'),true)
  await stage('390-select-enter','.adaptive-select-dialog','entering');await evaluate('fixture.settle()')
  await assertVisibleUnderlay('390-stage-clear')
  await viewport(820);await evaluate('new Promise(requestAnimationFrame)')
  await assertVisibleUnderlay('820-open-reposition')
  assert.equal(await evaluate(`(()=>{const r=document.querySelector('.adaptive-select-dialog').getBoundingClientRect();return r.left>=16&&r.right<=innerWidth-16&&r.top>=16&&r.bottom<=innerHeight-16})()`),true,'chooser follows the resized viewport')
  await shot('820-open-reposition');await viewport(390)
  await key('Escape',false)
  assert.equal(await evaluate('document.querySelector(".xixi-settings-scroll").inert'),true,'background stays inert until exit completes')
  await stage('390-select-cancel-exit','.adaptive-select-dialog','exiting');await evaluate('fixture.settle()')
  assert.equal(await evaluate('document.querySelector(".adaptive-select-dialog")'),null)
  await click(qualityTrigger)
  await command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:4,y:100});await command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:4,y:100})
  await evaluate('fixture.settle()')
  assert.equal(await evaluate('document.querySelector(".adaptive-select-dialog")'),null)
  assert.equal(await evaluate('document.querySelector(".xixi-settings-content").dataset.section'),'外观与动画')
  assert.equal(await evaluate('fixture.calls.filter(c=>c.path==="/preferences"&&c.body).length'),0)
  await click(qualityTrigger);await key('End');await key('Enter',false)
  await stage('390-select-chosen-exit','.adaptive-select-dialog','exiting');await evaluate('fixture.settle()')
  assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'),'黑洞画质')
  assert.equal(await evaluate('fixture.calls.filter(c=>c.path==="/preferences"&&c.body).length'),1,'one actual selection produces one save')

  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
  await click('document.querySelector(".xixi-settings-mobile-back")',false)
  assert.equal(await evaluate('document.querySelector(".xixi-settings").dataset.navigationPhase'),'idle')
  await button('外观与动画');await click(qualityTrigger,false)
  assert.equal(await evaluate('document.querySelector(".adaptive-select-dialog").dataset.phase'),'open')
  await key('Escape',false);assert.equal(await evaluate('document.querySelector(".adaptive-select-dialog")'),null)
  await command('Emulation.setEmulatedMedia',{features:[]})
  t.diagnostic('Actual enter/exit phases, disabled transition guards, clean resting text ancestors, focus/scroll retention, reduced motion and pixel-level foreground bleed probe passed. Midpoint captures are paused samples for human review.')
  t.diagnostic('Actual pointer hit tests: 320/390/820, both themes/materials, one-column six-row directory, visible dimmed context and rounded foreground glass. Fake background only; official black-hole lighting/shadows require parent review.')

  await viewport(390);await evaluate("fixture.mount('android')")
  for(const tab of tabs){await button(tab);assert.equal(await evaluate('document.querySelector(".xixi-settings-content").dataset.section'),tab);await click('document.querySelector(".xixi-settings-mobile-back")');assert.equal(await evaluate('document.activeElement.textContent'),tab)}
  await button('析熙');await click('document.querySelector(".adaptive-select-trigger[aria-label=\\"思考深度\\"]")');await button('关闭')
  assert.equal(await evaluate('document.querySelector("#xixi-reasoning-effort").value'),'off')
  assert.equal(await evaluate('fixture.calls.some(c=>c.path==="/settings/provider")'),false)
  await click('document.querySelector(".xixi-settings-mobile-back")');await button('析熙')
  assert.equal(await evaluate('document.querySelector("#xixi-reasoning-effort").value'),'off','unsaved connection draft survives directory round trip')
  await button('保存连接设置');await evaluate('fixture.wait(()=>fixture.config.reasoningEffort==="off")')
  assert.deepEqual(await evaluate('({stream:fixture.config.streamResponses,budget:fixture.config.contextBudget,search:fixture.config.webSearch,local:fixture.config.local})'),{stream:false,budget:{mode:'custom',maxUnits:96000},search:{enabled:false,maxUses:4},local:{engine:'lmstudio',baseUrl:'http://127.0.0.1:1234/v1',model:'synthetic-local'}})
  await click('document.querySelector(".xixi-settings-mobile-back")');await button('外观与动画')
  await click('document.querySelector(".adaptive-select-trigger[aria-label=\\"黑洞画质\\"]")');await key('End');await key('Enter');await evaluate('fixture.wait(()=>fixture.preferences.render.quality==="safe")')
  assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'),'黑洞画质')
  await click('document.querySelector(".adaptive-select-trigger[aria-label=\\"黑洞画质\\"]")');await evaluate('fixture.failPath="/preferences"');await button('高');await evaluate('fixture.wait(()=>document.querySelector(".xixi-settings-feedback").textContent.includes("保存失败"))')
  assert.equal(await evaluate('fixture.preferences.render.quality'),'safe')
  assert.equal(await evaluate('document.querySelector("select[aria-label=\\"黑洞画质\\"]").value'),'safe')
  await shot('390-dark-save-error')
  t.diagnostic('Original preference/provider callbacks receive real select change events; failed persistence retains the saved value; provider hidden values remain intact.')

  await command('Emulation.setUserAgentOverride',{userAgent:desktopUA})
  for(const theme of ['dark','light']){
    await viewport(1440);await evaluate(`fixture.mount('desktop',${JSON.stringify(theme)},'clear')`)
    assert.equal(await evaluate('document.querySelectorAll(".xixi-settings-mobile-back,.xixi-settings-directory,.adaptive-select-trigger").length'),0)
    assert.equal(await evaluate('document.querySelectorAll(".xixi-settings-tabs button").length'),6)
    assert.equal(await evaluate('document.querySelectorAll("select:not(.adaptive-select-native)").length>0'),true)
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".xixi-settings-content")).gridTemplateColumns.split(" ").length'),2)
    await shot(`1440-${theme}-desktop-native`)
  }

  await command('Emulation.setUserAgentOverride',{userAgent:androidUA})
  await viewport(390);await evaluate("fixture.mount('android','dark','clear','select')")
  await click('document.querySelector("#contract-select").closest(".adaptive-select").querySelector("button")')
  assert.equal(await evaluate('document.querySelector(".adaptive-select-title").textContent'),'契约选择')
  await evaluate(`(()=>{const l=document.querySelector('[role=listbox]');l.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));l.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,isComposing:true}));l.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true}));l.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,isComposing:true}));l.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))})()`)
  assert.deepEqual(await evaluate('fixture.changes'),[]);assert.equal(await evaluate('document.querySelector(".adaptive-select-dialog").dataset.phase'),'open')
  await key('Home');await key('ArrowDown');await key('Enter')
  assert.deepEqual(await evaluate('fixture.changes'),[],'moving from Alpha skips disabled and returns to selected Beta without firing change')
  await click('document.querySelector("#contract-select").closest(".adaptive-select").querySelector("button")');await key('End');await key('Enter')
  assert.deepEqual(await evaluate('fixture.changes'),[{value:'c',id:'contract-select',isSelect:true}])
  assert.equal(await evaluate('new FormData(document.querySelector("#select-form")).get("choice")'),'c')
  await evaluate('fixture.disable(true)');assert.equal(await evaluate('document.querySelector("#contract-select").closest(".adaptive-select").querySelector("button").disabled'),true)
  await click('document.querySelector("#default-select").closest(".adaptive-select").querySelector("button")');await button('X')
  assert.equal(await evaluate('document.querySelector("#default-select").value'),'x')
  await button('重置表单');await evaluate('new Promise(requestAnimationFrame)')
  assert.equal(await evaluate('document.querySelector("#default-select").closest(".adaptive-select").querySelector("button").textContent'),'Z')
  await click('document.querySelector("#multiple-select").closest(".adaptive-select").querySelector("button")');await button('Two')
  assert.equal(await evaluate('document.querySelector(".adaptive-select-dialog").dataset.phase'),'open')
  await key('End');await key('Enter');await button('完成')
  assert.deepEqual(await evaluate('new FormData(document.querySelector("#select-form")).getAll("choices")'),['a','b','c'])
  assert.deepEqual(await evaluate('fixture.multiChanges'),[['a','b'],['a','b','c']])
  assert.equal(await evaluate('document.querySelector("#required-select").reportValidity()'),false);await evaluate('fixture.settle()')
  assert.equal(await evaluate('document.querySelector(".adaptive-select-title").textContent'),'必填契约');await button('Valid')
  assert.equal(await evaluate('document.querySelector("#required-select").checkValidity()'),true)
  await evaluate('fixture.disable(false)');await click('document.querySelector("#contract-select").closest(".adaptive-select").querySelector("button")')
  await evaluate('fixture.disable(true);new Promise(requestAnimationFrame)');await evaluate('fixture.settle()')
  assert.equal(await evaluate('document.querySelector(".adaptive-select-dialog")'),null,'disabling an open native control closes its chooser')
  await evaluate("fixture.mount('android')");await evaluate('fixture.settle()')
  await key('Escape',false)
  assert.equal(await evaluate('fixture.closed'),0,'settings does not unmount before its outgoing fade')
  assert.equal(await evaluate('document.querySelector(".xixi-settings").dataset.closing'),'true')
  await shot('390-settings-close-exit',false);await evaluate('fixture.wait(()=>fixture.closed===1)')
  assert.equal(await evaluate('document.querySelector(".xixi-settings")'),null)
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
  await evaluate("fixture.mount('android')");await key('Escape',false)
  assert.equal(await evaluate('fixture.closed'),1,'reduced-motion settings close finishes directly')
  await command('Emulation.setEmulatedMedia',{features:[]})
  t.diagnostic('HTML select contract: id, label, disabled, controlled/default values, optgroups, disabled-option navigation, form serialization, form reset, Escape and focus restoration.')
})
