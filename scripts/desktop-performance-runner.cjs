// Disposable Electron acceptance app. Never imported by production main.cjs.
const { app, BrowserWindow, session } = require('electron')
const { mkdtempSync, mkdirSync } = require('node:fs')
const { writeFile, mkdir } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { pathToFileURL } = require('node:url')
const { randomBytes } = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { DatabaseSync } = require('node:sqlite')
const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1]
if (!args.includes('--payload') || !args.includes('--out')) throw Error('Expected --payload and --out')
const payload = resolve(option('--payload')), output = resolve(option('--out'))
const scratch = mkdtempSync(join(tmpdir(), 'astaria-desktop-performance-'))
mkdirSync(join(scratch, 'profile')); app.setPath('userData', join(scratch, 'profile'))
let window, server, db, prepares = 0, failed = false
const startAt = performance.now(), errors = [], delay = ms => new Promise(yes => setTimeout(yes, ms))
const prepare = DatabaseSync.prototype.prepare
DatabaseSync.prototype.prepare = function (...args) { prepares++; return prepare.apply(this, args) }
const moduleAt = name => import(pathToFileURL(join(payload, name)).href)
app.whenReady().then(async () => {
  await mkdir(output, { recursive: true })
  const [{ createDatabase }, { createLocalService }, { createDesktopServer }] = await Promise.all([
    moduleAt('server/database.mjs'), moduleAt('server/index.mjs'), moduleAt('desktop/server.mjs'),
  ])
  db = createDatabase(join(scratch, 'synthetic.sqlite'))
  db.setPreference('onboarding-completed', true)
  db.setPreference('free-time-daily', { date: '2026-10-15', completedAt: '2026-10-15T08:00:00+08:00' })
  const act = action => db.updatePlanner(action, db.getPlanner().revision)
  act({ type: 'import-routines', routines: [{ id: 'qa-window', title: '学习', kind: 'available', weekdays: [0,1,2,3,4,5,6], start: '08:00', end: '22:00', location: '', items: [], enabled: true }] })
  for (let i = 0; i < 40; i++) {
    const task = db.createTask({ title: `桌面隔离事项 ${i+1}`, estimateMin: 25, due: '2026-10-22', inbox: false })
    if (i < 16) act({ type: 'save-block', block: { id: `qa-${i}`, taskId: task.id, date: i < 8 ? '2026-10-15' : '2026-10-16', start: `${String(9+i%8).padStart(2,'0')}:00`, end: `${String(9+i%8).padStart(2,'0')}:25`, locked: false } })
  }
  for (let i = 0; i < 60; i++) {
    db.appendMessage({ conversationId: 'main', requestId: `qa-${i}`, role: 'user', content: `核对第 ${i+1} 项资料` })
    db.appendMessage({ conversationId: 'main', requestId: `qa-${i}`, role: 'assistant', content: `## 第 ${i+1} 项\n\n${'用于核对长历史输入、来源与页面切换的虚构内容。'.repeat(20)}\n\n- 核对真实空档\n- 保留截止时间\n\n**已有内容完整保留。**` })
  }
  db.selectConversation('main')
  const service = createLocalService({ db, dataDirectory: scratch, vault: { status: async () => false },
    complete: async () => { throw Error('No model/network access in performance fixture') }, fetcher: async () => { throw Error('No external requests') } })
  const token = randomBytes(32).toString('hex')
  server = createDesktopServer({ root: join(payload, 'dist'), service, token, port: 0 })
  const url = await server.listen(), origin = new URL(url).origin
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (!details.url.startsWith(origin+'/')) { callback({ cancel: true }); return }
    callback({ requestHeaders: { ...details.requestHeaders, 'X-Astaria-Desktop': token } })
  })
  window = new BrowserWindow({ width: 1440, height: 900, show: true, backgroundColor: '#050608', webPreferences: { nodeIntegration: false, sandbox: true, contextIsolation: true } })
  window.setAlwaysOnTop(true); window.focus()
  // Create the initial renderer before enabling Page on Electron's debugger.
  // No production resource has loaded; document-start instrumentation below
  // still precedes the measured app navigation.
  await window.loadURL('about:blank')
  console.log('QA_PHASE fixture-and-window-ready')
  const cdp = window.webContents.debugger; cdp.attach('1.3')
  await cdp.sendCommand('Page.enable'); await cdp.sendCommand('Runtime.enable'); await cdp.sendCommand('Performance.enable')
  console.log('QA_PHASE debugger-ready')
  await cdp.sendCommand('Emulation.setCPUThrottlingRate', { rate: 4 })
  await cdp.sendCommand('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' })
  await cdp.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  if (args.includes('--windows-ua')) await cdp.sendCommand('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36' })
  cdp.on('message', (_, method, params) => { if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails.text) })
  await cdp.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `{
    const NativeDate=Date;window.Date=class extends NativeDate{constructor(...a){super(...(a.length?a:[NativeDate.parse('2026-10-15T08:00:00+08:00')]))}static now(){return NativeDate.parse('2026-10-15T08:00:00+08:00')}};
    sessionStorage.setItem('astaria-xixi-conversation-v1','main');
    const qa=window.__desktopPerf={longTasks:[],encodes:0,workers:[]};
    new PerformanceObserver(l=>qa.longTasks.push(...l.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});
    const original=HTMLCanvasElement.prototype.toDataURL;HTMLCanvasElement.prototype.toDataURL=function(...a){qa.encodes++;return original.apply(this,a)};
    ${args.includes('--canvas-upload') ? "const getContext=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,options){return getContext.call(this,type,type==='2d'&&options?.willReadFrequently===true?undefined:options)};" : ''}
    const NativeWorker=Worker;window.Worker=class extends NativeWorker{constructor(u,o){super(u,o);qa.workers.push(o?.name??String(u))}};
  }` })
  const evaluate = async expression => {
    const value = await cdp.sendCommand('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (value.exceptionDetails) throw Error(JSON.stringify(value.exceptionDetails)); return value.result.value
  }
  const wait = async expression => { for (let i = 0; i < 400; i++) { if (await evaluate(expression)) return; await delay(50) } throw Error(`Timed out ${expression}`) }
  const loadStart = performance.now(); await window.loadURL(url)
  console.log('QA_PHASE page-loaded')
  await wait('!!window.__ASTARIA_P0__ && !!document.querySelector(".home-launch")')
  await wait('document.querySelectorAll("#home-xixi .xixi-message").length===120')
  await delay(600)
  const startup = await evaluate('({longTasks:window.__desktopPerf.longTasks,workers:window.__desktopPerf.workers,render:window.__ASTARIA_P0__.getSnapshot(),paint:performance.getEntriesByType("paint").map(p=>({name:p.name,startTime:p.startTime}))})')
  startup.sceneAndHistoryReadyWallMs = performance.now()-loadStart
  const verifyCanvasPixels = () => evaluate(`(async()=>{
    const results=[];
    for(const [w,h] of [[128,38],[340,680],[1400,900],[256,256]]){
      const image=new ImageData(w,h);for(let i=0;i<image.data.length;i+=4){image.data[i]=(i/4)%256;image.data[i+1]=Math.floor(i/1024)%256;image.data[i+2]=128;image.data[i+3]=255}
      const maps=[];
      for(const hint of [true,false]){
        const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
        const c=canvas.getContext('2d',hint?{willReadFrequently:true}:undefined);c.putImageData(image,0,0);
        const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));const bitmap=await createImageBitmap(blob);
        const read=document.createElement('canvas');read.width=w;read.height=h;const ctx=read.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0);bitmap.close();
        maps.push(ctx.getImageData(0,0,w,h).data);canvas.width=0;read.width=0;
      }
      const equal=maps[0].every((v,i)=>v===maps[1][i]&&v===image.data[i]);if(!equal)throw Error('Canvas upload pixel change');results.push({width:w,height:h,equal:true});
    }return results;
  })()`)
  const metrics = async () => Object.fromEntries((await cdp.sendCommand('Performance.getMetrics')).metrics.map(m => [m.name,m.value]))
  const samples = [], measure = async (label, action) => {
    await delay(250); const before = await metrics(), beforePrepare = prepares
    await evaluate('window.__desktopPerf.longTasks=[];window.__desktopPerf.encodes=0;true')
    const at = performance.now(); await action(); const after = await metrics()
    samples.push({ label, wallMs: performance.now()-at, prepares: prepares-beforePrepare,
      metrics: Object.fromEntries(['ScriptDuration','LayoutDuration','RecalcStyleDuration','TaskDuration'].map(k => [k,(after[k]-before[k])*1000])),
      ...await evaluate('({encodes:window.__desktopPerf.encodes,longTasks:window.__desktopPerf.longTasks,render:window.__ASTARIA_P0__.getSnapshot()})') })
  }
  const nav = async name => { await evaluate(`{const m=document.querySelector('#home-menu');if(m.inert)document.querySelector('.home-brand').click();[...m.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(name)}).click()}`); await delay(1300) }
  await measure('open-chat', async () => { await evaluate('document.querySelector(".home-launch").click()'); await wait('!document.querySelector("#home-xixi").inert && !window.__ASTARIA_P0__.getSnapshot().cameraTransition'); await delay(200) })
  await measure('typing-30-updates', async () => { for (let i = 1; i <= 30; i++) { await evaluate(`{const e=document.querySelector('#home-compose');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'核对桌面长聊天输入响应与草稿保留'.repeat(2).slice(0,${i}));e.dispatchEvent(new Event('input',{bubbles:true}))}`); await delay(16) } })
  for (let i=0;i<2;i++) for (const [name,label] of [['工作台','workbench'],['日程','schedule'],['余时','free-time']]) await measure(`${label}-${i}`,()=>nav(name))
  await measure('20-conversation-reads', async () => { await evaluate(`(async()=>{for(let i=0;i<20;i++){const r=await fetch('/api/conversation?id=main',{headers:{'X-Astaria-Local':'1'}});if(!r.ok)throw Error('Conversation failed');const c=await r.json();if(c.messages.length!==120)throw Error('Lost history')}})()`) })
  const canvasPixels = await verifyCanvasPixels()
  await nav('首页')
  if (await evaluate('document.querySelector("#home-xixi").inert')) await evaluate('document.querySelector(".home-launch").click()')
  await wait('!window.__ASTARIA_P0__.getSnapshot().cameraTransition')
  await evaluate(`{const e=window.__ASTARIA_P0__;e.setPaused(true);e.finishCameraTransition();e.simulationTime=42;e.nextFrameAt=0;e.frame(performance.now());e.cancelFrame();const l=document.querySelector('#home-xixi .xixi-conversation');l.scrollTop=l.scrollHeight}`)
  await delay(100)
  await writeFile(join(output,'chat.png'),(await window.webContents.capturePage()).toPNG())
  const checks = await evaluate(`({messages:document.querySelectorAll('#home-xixi .xixi-message').length,nodeIsolated:typeof require==='undefined',hidden:document.hidden,scale:visualViewport.scale})`)
  if (checks.messages!==120 || !checks.nodeIsolated || checks.hidden || errors.length) throw Error(JSON.stringify({checks,errors}))
  const graphics=await evaluate(`(()=>{const gl=window.__ASTARIA_P0__.renderer.getContext(),i=gl.getExtension('WEBGL_debug_renderer_info');return {renderer:i?gl.getParameter(i.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),vendor:i?gl.getParameter(i.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR)}})()`)
  const report = { checkedAt:new Date().toISOString(), payload, scope:'Real Electron on Mac; 4x renderer CPU throttle; Windows UA uses the same Mac GPU, not Windows hardware.', electron:process.versions.electron,node:process.versions.node, totalWallMs:performance.now()-startAt, viewport:{width:1440,height:900,dpr:1},fixture:{tasks:40,blocks:16,messages:120},startup,samples,checks,errors,canvasPixels,graphics,gpuFeatures:app.getGPUFeatureStatus(),gpu:await app.getGPUInfo('basic') }
  await writeFile(join(output,'result.json'),JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({output,startupMaxLongTask:Math.max(0,...startup.longTasks.map(x=>x.duration)),samples:samples.map(x=>({label:x.label,scriptMs:x.metrics.ScriptDuration,prepares:x.prepares,encodes:x.encodes,longest:Math.max(0,...x.longTasks.map(t=>t.duration))})),checks}))
}).catch(async error => {
  failed = true; console.error(error.stack)
  await mkdir(output,{recursive:true}); await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),errors},null,2))
}).finally(async () => {
  if(window&&!window.isDestroyed())window.destroy()
  if(server)await server.close();else db?.close()
  app.exit(failed?1:0)
})
