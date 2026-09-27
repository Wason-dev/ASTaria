/** Local browser QA only. Chrome DevTools Protocol; no runtime dependencies. */
import fs from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
const ROOT = new URL('../artifacts/p0/', import.meta.url)
const mode = process.argv[2] ?? 'screenshot'
const testDpr = Number(process.argv[4] ?? 1)
const targets = await fetch('http://127.0.0.1:9227/json').then(r=>r.json())
const target = targets.find(t=>t.type==='page')
if(!target) throw new Error('Start a dedicated test Chrome on port 9227 first.')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject})
let id=0
const pending=new Map(), events=new Map(), errors=[]
ws.onmessage=event=>{
  const m=JSON.parse(event.data)
  if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p?.reject(m.error);else p?.resolve(m.result)}
  else {events.get(m.method)?.forEach(fn=>fn(m.params));if(m.method==='Runtime.exceptionThrown')errors.push(m.params)}
}
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))})
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw r.exceptionDetails;return r.result.value}
const waitFor=async(expression)=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await sleep(100)}throw new Error('Timeout: '+expression)}
const screenshot=async name=>{const {data}=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await fs.writeFile(new URL('screenshots/'+name+'.png',ROOT),Buffer.from(data,'base64'))}
try {
 await send('Page.enable');await send('Runtime.enable');await send('Network.enable');await send('Network.setBypassServiceWorker',{bypass:true});await send('Network.setCacheDisabled',{cacheDisabled:true})
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:testDpr,mobile:false})
 await send('Page.navigate',{url:(process.env.P0_URL ?? 'http://127.0.0.1:5177/')+'?qa='+Date.now()+'#/black-hole'})
 await waitFor('!!window.__ASTARIA_P0__')
 await sleep(1600)
 if(mode==='screenshot') {
  await evaluate('window.__ASTARIA_P0__.setPaused(true)')
  await sleep(80);await screenshot('night-1440')
  console.log(JSON.stringify(await evaluate('window.__ASTARIA_P0__.getSnapshot()'),null,2))
 }
 if(mode==='verify') {
  const results=[]
  const snap=()=>evaluate('window.__ASTARIA_P0__.getSnapshot()')
  await evaluate('window.__ASTARIA_P0__.setQuality("ultra");window.__ASTARIA_P0__.setPaused(true)')
  await sleep(100);const pause1=await snap();await sleep(500);const pause2=await snap()
  results.push({name:'pause stops idle rendering and simulation',pass:pause1.renderedFrames===pause2.renderedFrames&&pause1.simulationTime===pause2.simulationTime,details:{pause1,pause2}})
  await screenshot('night-1440')
  await evaluate('document.querySelector(".p0").dataset.night="false";window.__ASTARIA_P0__.setNight(0,true)');await sleep(150);await screenshot('day-1440')
  await evaluate('window.__ASTARIA_P0__.setNight(.5,true)');await sleep(150);await screenshot('dusk-1440')
  await evaluate('document.querySelector(".p0").dataset.night="true";window.__ASTARIA_P0__.setNight(1,true)');await sleep(150)
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true})
  await sleep(150);await screenshot('night-390')
  results.push({name:'390px viewport fits',pass:await evaluate('document.documentElement.scrollWidth <= innerWidth')})
  await evaluate('document.querySelector(".p0").dataset.night="false";window.__ASTARIA_P0__.setNight(0,true)');await sleep(150);await screenshot('day-390')
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:testDpr,mobile:false})
  await evaluate('document.querySelector(".p0").dataset.night="true";window.__ASTARIA_P0__.setNight(1,true);window.__ASTARIA_P0__.setPaused(false)')
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
  await sleep(150);const reduced1=await snap();await sleep(500);const reduced2=await snap()
  results.push({name:'reduced motion stops ambient frames',pass:reduced2.reducedMotion&&reduced1.renderedFrames===reduced2.renderedFrames&&reduced1.simulationTime===reduced2.simulationTime})
  await evaluate('window.__ASTARIA_P0__.setNight(0)');await sleep(100);await screenshot('reduced-motion-day')
  results.push({name:'reduced motion controls still render',pass:(await snap()).renderedFrames>reduced2.renderedFrames})
  await send('Emulation.setEmulatedMedia',{features:[]})
  await evaluate('document.querySelector(".p0").dataset.night="true";window.__ASTARIA_P0__.setNight(1,true);window.__ASTARIA_P0__.setQuality("safe")')
  await sleep(1500);results.push({name:'minimum tier renders',pass:(await snap()).quality==='safe',details:await snap()})
  await screenshot('minimum-tier')
  results.push({name:'no runtime exceptions',pass:errors.length===0,errors})
  await fs.writeFile(new URL('browser-checks.json',ROOT),JSON.stringify(results,null,2))
  console.log(JSON.stringify(results,null,2))
  if(results.some(x=>!x.pass)) process.exitCode=1
 }
 if(mode==='camera') {
  const results=[]
  await evaluate('window.__ASTARIA_P0__.setPaused(true);window.__ASTARIA_P0__.setView("interstellar")')
  await sleep(500);const mid=await evaluate('window.__ASTARIA_P0__.getSnapshot()')
  results.push({name:'camera continuously interpolates',pass:mid.zoom>.7&&mid.zoom<2.05,mid})
  await evaluate('window.__ASTARIA_P0__.setView("panorama")');await sleep(3500);const wide=await evaluate('window.__ASTARIA_P0__.getSnapshot()');await screenshot('panorama-1440')
  results.push({name:'panorama settles',pass:Math.abs(wide.zoom-.7)<.003&&!wide.cameraTransition,wide})
  await evaluate('window.__ASTARIA_P0__.setView("interstellar")');await sleep(500)
  const forward=await evaluate('window.__ASTARIA_P0__.getSnapshot()')
  await evaluate('window.__ASTARIA_P0__.setView("panorama")');const reverse=await evaluate('window.__ASTARIA_P0__.getSnapshot()')
  results.push({name:'camera reversal has no position jump',pass:Math.abs(forward.zoom-reverse.zoom)<.025})
  await evaluate('window.__ASTARIA_P0__.setView("interstellar")');await sleep(3500);await screenshot('interstellar-1440')
  await evaluate('window.__ASTARIA_P0__.setView("panorama")');await sleep(3300)
  await evaluate('window.__ASTARIA_P0__.setPaused(false);window.__ASTARIA_P0__.emitParticles()')
  await sleep(700);await screenshot('star-infall-early')
  await sleep(2000);await screenshot('star-infall-middle')
  await sleep(2300);await screenshot('star-infall-capture')
  const other=await send('Target.createTarget',{url:'about:blank'})
  await send('Target.activateTarget',{targetId:other.targetId});await sleep(150)
  const hidden1=await evaluate('({state:document.visibilityState,...window.__ASTARIA_P0__.getSnapshot()})')
  await sleep(500);const hidden2=await evaluate('window.__ASTARIA_P0__.getSnapshot()')
  await send('Target.closeTarget',{targetId:other.targetId});await send('Page.bringToFront');await sleep(100)
  results.push({name:'actual background tab cancels rendering',pass:hidden1.state==='hidden'&&hidden1.renderedFrames===hidden2.renderedFrames,hidden1,hidden2})
  await fs.writeFile(new URL('camera-checks.json',ROOT),JSON.stringify(results,null,2))
  console.log(JSON.stringify(results,null,2))
 }
 if(mode==='pointer') {
  await evaluate('window.__ASTARIA_P0__.setPaused(true)');await sleep(100)
  await screenshot('pointer-before')
  await evaluate('window.__ASTARIA_P0__.setPointer(.43,.37,true)');await sleep(350)
  const active=await evaluate('window.__ASTARIA_P0__.getSnapshot()');await screenshot('pointer-disc')
  await evaluate('window.__ASTARIA_P0__.setPointer(.22,.65,true)');await sleep(350);await screenshot('pointer-space')
  await evaluate('window.__ASTARIA_P0__.setPointer(.22,.65,false)');await sleep(500)
  const quiet1=await evaluate('window.__ASTARIA_P0__.getSnapshot()');await sleep(250)
  const quiet2=await evaluate('window.__ASTARIA_P0__.getSnapshot()')
  const checks={active,quiet1,quiet2,pass:active.pointerStrength>.99&&quiet2.pointerStrength===0&&quiet1.renderedFrames===quiet2.renderedFrames}
  await fs.writeFile(new URL('pointer-checks.json',ROOT),JSON.stringify(checks,null,2));console.log(JSON.stringify(checks,null,2))
 }
 if(mode==='video') {
  await evaluate('window.__ASTARIA_P0__.setQuality("ultra")')
  await sleep(600)
  const video=await evaluate(`new Promise(resolve=>{
    const canvas=document.querySelector('.p0-universe canvas');
    const stream=canvas.captureStream(30);
    const type=MediaRecorder.isTypeSupported('video/webm;codecs=vp9')?'video/webm;codecs=vp9':'video/webm';
    const recorder=new MediaRecorder(stream,{mimeType:type,videoBitsPerSecond:3500000});
    const chunks=[];recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
    recorder.onstop=()=>{const blob=new Blob(chunks,{type});const reader=new FileReader();reader.onloadend=()=>{stream.getTracks().forEach(t=>t.stop());resolve(reader.result)};reader.readAsDataURL(blob)};
    recorder.start();setTimeout(()=>recorder.stop(),30000);
  })`)
  await fs.writeFile(new URL('black-hole-30s.webm',ROOT),Buffer.from(video.split(',')[1],'base64'))
  console.log('Saved 30-second silent canvas recording: black-hole-30s.webm')
 }
 if(mode==='trace') {
  const quality=process.argv[3]??'ultra'
  const qualityLabel = quality + (testDpr > 1 ? '-retina' : '')
  await evaluate(`window.__ASTARIA_P0__.setQuality(${JSON.stringify(quality)})`)
  await sleep(2200)
  const initial=await evaluate('window.__ASTARIA_P0__.getSnapshot()')
  const startSamples=await evaluate('window.__ASTARIA_P0__.getFrameSamples().length')
  const collected=[]
  events.set('Tracing.dataCollected',[({value})=>collected.push(...value)])
  const complete=new Promise(resolve=>events.set('Tracing.tracingComplete',[resolve]))
  await send('Tracing.start',{categories:'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,toplevel,blink.user_timing',transferMode:'ReportEvents',options:'record-continuously'})
  await sleep(10000)
  await send('Tracing.end');await complete
  const trace=JSON.stringify({traceEvents:collected})
  await fs.writeFile(new URL(`trace-${qualityLabel}.json.gz`,ROOT),gzipSync(trace))
  const frames=await evaluate(`window.__ASTARIA_P0__.getFrameSamples().slice(${startSamples})`)
  const final=await evaluate('window.__ASTARIA_P0__.getSnapshot()')
  await fs.writeFile(new URL(`frames-${qualityLabel}.json`,ROOT),JSON.stringify({initial,final,frameIntervalsMs:frames,errors},null,2))
  await screenshot(`performance-${qualityLabel}`)
  console.log(JSON.stringify({initial,final,samples:frames.length,traceBytes:trace.length,errors},null,2))
 }
} finally {ws.close()}
