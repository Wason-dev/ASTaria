/**
 * Offline real-root diagnostic. Never builds, changes product files, or connects
 * to an existing browser. Node 24 + installed Chrome only; no dependencies.
 * node scripts/trace-home-glass.mjs [--label=baseline] [--cpu=1,4]
 * Optional --snapshot=<previous run>/served-dist pins the exact same build.
 * --harness=hint runs a separate source-only optical-hint A/B (not root).
 * All outputs, profiles, fixtures and snapshots stay below glass-trace/.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, writeFile, cp, rm } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'
import { createDatabase } from '../server/database.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => process.argv.slice(2).find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const safe = s => s.replace(/[^a-zA-Z0-9._-]/g, '-')
const allowed = join(root, 'artifacts/mobile-detail-2026-10-16/glass-trace')
const output = join(allowed, `${safe(arg('label', 'baseline'))}-${new Date().toISOString().replaceAll(':', '-')}`)
const dist = resolve(root, arg('snapshot', 'dist-mobile')), served = join(output, 'served-dist')
assert.ok(dist === join(root, 'dist-mobile') || dist.startsWith(allowed + sep))
const rates = arg('cpu', '1,4').split(',').map(Number)
assert.ok(rates.length && rates.every(n => [1,4,6].includes(n)))
const delay = ms => new Promise(r => setTimeout(r, ms))
const hash = v => createHash('sha256').update(v).digest('hex')
const save = (file, value) => writeFile(join(output, file), JSON.stringify(value, null, 2))
const sourcePaths = ['src/home/GlassSurface.tsx','src/home/home.css','src/home/HomeWorkspace.tsx','src/spatial/useSceneCamera.ts','src/prototype/BlackHoleRenderer.ts','src/home/glass.ts','src/home/glassRendering.ts']
const report = { schema: 1, status: 'running', output, dist, startedAt: new Date().toISOString(), rates,
  contract: 'Unmodified production mobile root, real data/LUT Workers, own fictional backup/onboarding, owned isolated Chrome only',
  limitations: ['Mac headless Chromium with UA selection is not IAB, Android WebView, MateXT or a native GPU driver reproduction.',
    '100ms DOM samples and timed screenshots cannot exclude a one-display-frame compositor-only defect.',
    'CPU throttle changes scheduler load; it is not hardware equivalence. Screenshots/style reads themselves add work.',
    'Background pause uses the existing renderer setPaused(true) API only after natural steady phases; no sampling toggles, state injection or timer overrides.',
    'Source hashes describe concurrent checkout, not proof of build provenance; snapshot hashes and actual loaded DOM identify baseline.'],
  cases: [], httpApis: [], errors: [] }

async function inventory(directory) {
  const files = []
  async function walk(path) {
    for (const e of (await readdir(path, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const full = join(path,e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile()) { const b = await readFile(full); files.push({path:relative(directory,full),bytes:b.length,sha256:hash(b)}) }
      else throw Error(`Nonregular build entry: ${full}`)
    }
  }
  await walk(directory); return { hash:hash(JSON.stringify(files)),files }
}
async function sourceHashes() { return Object.fromEntries(await Promise.all(sourcePaths.map(async p => [p,hash(await readFile(join(root,p)))]))) }
function fixture() {
  const db = createDatabase(':memory:')
  try {
    db.setPreference('onboarding-completed', true)
    db.createTask({title:'虚构玻璃诊断事项',estimateMin:25,due:'2026-10-22',inbox:false})
    db.ensureConversation('main'); db.selectConversation('main')
    for (let i=0;i<3;i++) {
      db.appendMessage({conversationId:'main',requestId:`trace-fiction-${i}`,role:'user',content:`虚构诊断对话 ${i+1}`})
      db.appendMessage({conversationId:'main',requestId:`trace-fiction-${i}`,role:'assistant',content:'这是隔离生成的演示记录，用于观察真实首页玻璃，不发送请求。'})
    }
    return db.exportData()
  } finally { db.close() }
}

// Passive observers forward to the native APIs, retaining only request metadata.
// No React state hooks, timer stubs, Worker stubs or DOM sampling toggles.
const init = `(() => {
  localStorage.setItem('astaria-sqlite-migration-v1','complete');
  sessionStorage.setItem('astaria-xixi-conversation-v1','main');
  const q=window.__glassBoot={workers:[],calls:[],workerMessages:[],errors:[],longTasks:[]};
  addEventListener('error',e=>q.errors.push({at:performance.now(),message:e.message,filename:e.filename,line:e.lineno}));
  addEventListener('unhandledrejection',e=>q.errors.push({at:performance.now(),rejection:String(e.reason)}));
  new PerformanceObserver(l=>q.longTasks.push(...l.getEntries().map(e=>({at:e.startTime,ms:e.duration})))).observe({type:'longtask',buffered:true});
  const W=Worker; window.Worker=class extends W {constructor(u,o){super(u,o);q.workers.push({url:String(u),name:o?.name,at:performance.now()});this.addEventListener('message',e=>{const m=e.data;q.workerMessages.push({at:performance.now(),name:o?.name,kind:m?.kind,type:m?.type,operation:m?.operation,id:m?.id,keys:Object.keys(m??{})})})}};
  const post=W.prototype.postMessage; W.prototype.postMessage=function(m,...a){if(m?.kind==='call')q.calls.push({at:performance.now(),path:m.path,hasInput:m.input!==undefined});return post.call(this,m,...a)};
})()`

function installTrace() {
  const ids = new WeakMap(), maps = {}, phases = []; let serial=0, phase, timer, observer
  const id=e=>{if(!e)return null;if(!ids.has(e))ids.set(e,++serial);return ids.get(e)}
  const href=s=>{if(!s)return null;let n=2166136261;for(let i=0;i<s.length;i++)n=Math.imul(n^s.charCodeAt(i),16777619);const h=(n>>>0).toString(16).padStart(8,'0');maps[h]=s;return {fnv1a32:h,bytes:s.length}}
  const brief=e=>({node:id(e),tag:e?.nodeName,class:e?.getAttribute?.('class'),id:e?.getAttribute?.('id')})
  const kind=s=>!s||s==='none'?'none':s.includes('url(')?'svg-url':s.includes('blur(')?'css-blur':'other'
  const attributes=e=>e?Object.fromEntries(e.getAttributeNames().map(n=>[n,n==='href'?href(e.getAttribute(n)):e.getAttribute(n)])):null
  const css=e=>{if(!e)return null;const s=getComputedStyle(e);return {node:id(e),rect:e.getBoundingClientRect().toJSON(),width:s.width,height:s.height,display:s.display,visibility:s.visibility,opacity:s.opacity,transform:s.transform,filter:s.filter,backdrop:s.backdropFilter,backdropKind:kind(s.backdropFilter),inlineBackdrop:e.style.backdropFilter,inlineKind:kind(e.style.backdropFilter),webkit:e.style.getPropertyValue('-webkit-backdrop-filter'),willChange:s.willChange,overflow:s.overflow,borderRadius:s.borderRadius,clipPath:s.clipPath,maskImage:s.maskImage,isolation:s.isolation,contain:s.contain,animation:s.animation,transition:s.transition,visible:e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),dataSampling:e.dataset.sampling}}
  const state=()=>{
    const m=document.querySelector('.home-morph'),b=m?.querySelector('.home-glass-backdrop');const ancestors=[];let p=b?.parentElement
    while(p){ancestors.push({...brief(p),...css(p),inert:p.inert,ariaHidden:p.getAttribute('aria-hidden')});p=p.parentElement}
    return {at:performance.now(),rootCount:document.querySelectorAll('#root .p0 .home-workspace').length,home:document.querySelector('.home-workspace')?.dataset.page,chatOpen:document.querySelector('.home-workspace')?.dataset.chatOpen,visibility:document.visibilityState,hidden:document.hidden,focus:document.hasFocus(),mobileActive:document.documentElement.dataset.mobileActive,progress:m?.dataset.progress,
      morph:css(m),backdrop:css(b),surface:css(m?.querySelector('.home-glass-surface')),svg:attributes(m?.querySelector('svg.home-glass-definitions')),filter:attributes(m?.querySelector('filter')),image:attributes(m?.querySelector('feImage')),displacement:attributes(m?.querySelector('feDisplacementMap')),ancestors,
      samplingNodes:[...m?.querySelectorAll('.home-glass-backdrop,svg,filter,feImage,feDisplacementMap')??[]].map(brief),
      animations:document.getAnimations().map(a=>({target:brief(a.effect?.target),state:a.playState,time:a.currentTime,timing:a.effect?.getComputedTiming()})),render:window.__ASTARIA_P0__?.getSnapshot(),camera:window.__ASTARIA_P0__?.getCameraSnapshot()}
  }
  const pack=(n,v)=>n==='href'?href(v):v
  const receive=records=>{
    if(!phase)return
    const nextValues=new Map(),values=new Array(records.length)
    // Recover each new value, including multiple writes within one delivery.
    for(let i=records.length-1;i>=0;i--){const r=records[i];if(r.type!=='attributes')continue;const k=id(r.target)+':'+r.attributeName;values[i]=nextValues.has(k)?nextValues.get(k):r.target.getAttribute(r.attributeName);nextValues.set(k,r.oldValue)}
    records.forEach((r,i)=>{
      const m=document.querySelector('.home-morph'),inside=r.target===m||m?.contains(r.target),ancestor=m&&r.target.contains?.(m)
      if(!inside&&!ancestor)return
      const base={at:performance.now(),t:performance.now()-phase.start,...brief(r.target),type:r.type}
      if(r.type==='attributes')phase.mutations.push({...base,name:r.attributeName,old:pack(r.attributeName,r.oldValue),value:pack(r.attributeName,values[i])})
      else phase.mutations.push({...base,added:[...r.addedNodes].filter(n=>n.nodeType===1).map(brief),removed:[...r.removedNodes].filter(n=>n.nodeType===1).map(brief)})
    })
  }
  observer=new MutationObserver(receive);observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeOldValue:true,attributeFilter:['style','class','href','scale','width','height','x','y','filter','data-sampling','data-progress','data-chat-open','data-page','data-mobile-active','hidden','inert','aria-hidden']})
  const sample=()=>{if(!phase)return;const s=state();phase.samples.push({...s,t:s.at-phase.start,dt:phase.samples.length?s.at-phase.samples.at(-1).at:null})}
  window.__glassTrace={state,maps,phases,start(name){this.stop();phase={name,start:performance.now(),samples:[],mutations:[]};phases.push(phase);sample();timer=setInterval(sample,100);return phase.start},stop(){if(phase){receive(observer.takeRecords());sample();phase.end=performance.now();phase.durationMs=phase.end-phase.start}clearInterval(timer);phase=undefined;return phases.at(-1)},mark(){return {at:performance.now(),phase:phase?.name,t:performance.now()-(phase?.start??0),state:state()}},finish(){this.stop();observer.disconnect();return {phases,maps,boot:window.__glassBoot}}}
}

class CDP {
  constructor(ws) { this.ws=ws;this.pending=new Map();this.serial=0;this.events=[] }
  static async connect(url) {
    const c=new CDP(new WebSocket(url));await new Promise((y,n)=>{c.ws.onopen=y;c.ws.onerror=n})
    c.ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=c.pending.get(m.id);if(!p)return;clearTimeout(p.timer);c.pending.delete(m.id);m.error?p.n(Error(JSON.stringify(m.error))):p.y(m.result)}else{c.events.push(m);c.onEvent?.(m)}};return c
  }
  send(method,params={}) {return new Promise((y,n)=>{const id=++this.serial,timer=setTimeout(()=>{this.pending.delete(id);n(Error(`CDP timeout ${method}`))},45000);this.pending.set(id,{y,n,timer});this.ws.send(JSON.stringify({id,method,params}))})}
  async eval(expression) {const r=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
  async wait(expression,ms=60000) {const start=performance.now();while(performance.now()-start<ms){if(await this.eval(expression))return;await delay(100)}throw Error(`Timeout: ${expression}`)}
  async api(path,input) {return this.eval(`(async()=>{const r=await fetch('/api/${path}',{method:${JSON.stringify(input===undefined?'GET':'POST')},headers:{'X-ASTaria-Local':'1','Content-Type':'application/json'},${input===undefined?'':`body:JSON.stringify(${JSON.stringify(input)}),`}});const d=await r.json();if(!r.ok)throw Error(d.error);return d})()`)}
  close() {this.ws.close();for(const p of this.pending.values()){clearTimeout(p.timer);p.n(Error('closed'))}this.pending.clear()}
}

// PNG read/write for screenshot evidence, without installing imaging packages.
const crcTable=Array.from({length:256},(_,i)=>{for(let k=0;k<8;k++)i=i&1?0xedb88320^(i>>>1):i>>>1;return i>>>0})
function crc(b){let n=0xffffffff;for(const x of b)n=crcTable[(n^x)&255]^(n>>>8);return(n^0xffffffff)>>>0}
function chunk(type,data){const t=Buffer.from(type),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);t.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc(Buffer.concat([t,data])),data.length+8);return out}
function pngEncode(w,h,pixels){const head=Buffer.alloc(13);head.writeUInt32BE(w);head.writeUInt32BE(h,4);head[8]=8;head[9]=6;const rows=Buffer.alloc((w*4+1)*h);for(let y=0;y<h;y++)pixels.copy(rows,y*(w*4+1)+1,y*w*4,(y+1)*w*4);return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',head),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))])}
function pngDecode(b){let offset=8,w,h,channels;const parts=[];while(offset<b.length){const n=b.readUInt32BE(offset),type=b.toString('ascii',offset+4,offset+8),d=b.subarray(offset+8,offset+8+n);if(type==='IHDR'){w=d.readUInt32BE(0);h=d.readUInt32BE(4);assert.equal(d[8],8);assert.equal(d[12],0);channels=d[9]===6?4:d[9]===2?3:0;assert.ok(channels)}if(type==='IDAT')parts.push(d);offset+=n+12}const data=inflateSync(Buffer.concat(parts)),raw=Buffer.alloc(w*h*channels),stride=w*channels;for(let y=0;y<h;y++){const f=data[y*(stride+1)];for(let x=0;x<stride;x++){const a=x>=channels?raw[y*stride+x-channels]:0,u=y?raw[(y-1)*stride+x]:0,c=y&&x>=channels?raw[(y-1)*stride+x-channels]:0;let v=0;if(f===1)v=a;if(f===2)v=u;if(f===3)v=Math.floor((a+u)/2);if(f===4){const p=a+u-c,pa=Math.abs(p-a),pb=Math.abs(p-u),pc=Math.abs(p-c);v=pa<=pb&&pa<=pc?a:pb<=pc?u:c}raw[y*stride+x]=(data[y*(stride+1)+x+1]+v)&255}}const pixels=Buffer.alloc(w*h*4,255);for(let i=0;i<w*h;i++)for(let c=0;c<channels;c++)pixels[i*4+c]=raw[i*channels+c];return{w,h,pixels}}
function crop(image,x,y,w=128,h=128){assert.ok(x>=0&&y>=0&&x+w<=image.w&&y+h<=image.h);const pixels=Buffer.alloc(w*h*4);for(let j=0;j<h;j++)image.pixels.copy(pixels,j*w*4,((y+j)*image.w+x)*4,((y+j)*image.w+x+w)*4);return{w,h,pixels}}
function diff(a,b){assert.equal(a.pixels.length,b.pixels.length);let sum=0,max=0,changed=0,over8=0;for(let i=0;i<a.pixels.length;i+=4){let d=0;for(let k=0;k<3;k++){const n=Math.abs(a.pixels[i+k]-b.pixels[i+k]);sum+=n;max=Math.max(max,n);d=Math.max(d,n)}if(d)changed++;if(d>8)over8++}return{meanRGB:sum/(a.w*a.h*3),maxChannel:max,changedPixels:changed,over8Pixels:over8}}
function sheet(images){const cols=8,w=cols*128,h=Math.ceil(images.length/cols)*256,pixels=Buffer.alloc(w*h*4,255);images.forEach((pair,i)=>pair.forEach((im,k)=>{for(let y=0;y<128;y++)im.pixels.copy(pixels,(((Math.floor(i/cols)*256+k*128+y)*w)+(i%cols)*128)*4,y*128*4,(y+1)*128*4)}));return pngEncode(w,h,pixels)}

async function layerEvidence(c) {
  const doc=await c.send('DOM.getDocument',{depth:0}),res={}
  for(const selector of ['.home-morph','.home-morph .home-glass-backdrop','.home-morph .home-glass-surface','.home-deck','.home-scene-ui','.p0-universe canvas']) {
    const q=await c.send('DOM.querySelector',{nodeId:doc.root.nodeId,selector});if(!q.nodeId)continue
    const n=await c.send('DOM.describeNode',{nodeId:q.nodeId}),backend=n.node.backendNodeId
    const layer=(c.layers??[]).filter(l=>l.backendNodeId===backend)
    res[selector]={backendNodeId:backend,layers:await Promise.all(layer.map(async l=>({...l,reasons:await c.send('LayerTree.compositingReasons',{layerId:l.layerId}).catch(e=>({error:e.message}))})))}
  }
  return {at:performance.now(),targets:res,tree:c.layers}
}
function summarize(p,frames) {
  const distinct = fn=>[...new Set(p.samples.map(fn).map(x=>JSON.stringify(x??null)))].map(x=>JSON.parse(x))
  const deltas=p.samples.slice(1).map(s=>s.dt).sort((a,b)=>a-b)
  const attrs=p.mutations.filter(m=>m.type==='attributes'),changes=attrs.filter(m=>JSON.stringify(m.old)!==JSON.stringify(m.value))
  return {name:p.name,durationMs:p.durationMs,samples:p.samples.length,sampleDtMs:{min:deltas[0],p50:deltas[Math.floor(deltas.length*.5)],p95:deltas[Math.floor(deltas.length*.95)],max:deltas.at(-1)},
    actualKinds:distinct(s=>[s.backdrop?.inlineKind,s.backdrop?.backdropKind]),scales:distinct(s=>s.displacement?.scale),hrefs:distinct(s=>s.image?.href),geometry:distinct(s=>({rect:s.morph?.rect,svg:s.svg,filter:s.filter})),
    samplingIdentities:distinct(s=>s.samplingNodes),quality:distinct(s=>[s.render?.requestedQuality,s.render?.quality,s.render?.targetFps]),cameraTransitions:distinct(s=>s.render?.cameraTransition),paused:distinct(s=>s.render?.paused),visibility:distinct(s=>[s.visibility,s.backdrop?.visible]),renderedFrames:p.samples.at(-1).render?.renderedFrames-p.samples[0].render?.renderedFrames,
    mutations:p.mutations.length,actualAttributeChanges:changes.length,attributeCounts:Object.fromEntries([...new Set(attrs.map(m=>m.name))].map(n=>[n,attrs.filter(m=>m.name===n).length])),
    hrefChanges:changes.filter(m=>m.name==='href'),scaleChanges:changes.filter(m=>m.name==='scale'),samplingDOMReplacements:p.mutations.filter(m=>m.type==='childList'&&(m.added.length||m.removed.length)),
    screenshots:frames.length,frameTiming:frames.map(f=>({index:f.index,t:f.mark.t,captureStart:f.captureStart,captureEnd:f.captureEnd})),
    cornerDiffs:frames.slice(1).map((f,i)=>({from:i,to:i+1,dtMs:f.mark.at-frames[i].mark.at,TL:diff(frames[i].corners[0],f.corners[0]),BR:diff(frames[i].corners[1],f.corners[1])})),
    caution:p.name.includes('paused')?'Only a stable background/geometry lets these pixel differences assess temporal output; no forced filter-off comparison was made.':'Live scene brightness changes are expected; RGB differences alone do not establish glass flicker.'}
}
async function phase(c,dir,name,duration,frameCount) {
  console.log(`PHASE ${dir} ${name}`);await mkdir(join(output,dir,name),{recursive:true})
  await c.eval(`__glassTrace.start(${JSON.stringify(name)})`)
  const start=performance.now(),frames=[]
  for(let index=0;index<frameCount;index++) {
    await delay(Math.max(0,start+index*duration/(frameCount-1)-performance.now()))
    const captureStart=performance.now(),mark=await c.eval('__glassTrace.mark()')
    const shot=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true}),captureEnd=performance.now()
    const bytes=Buffer.from(shot.data,'base64'),im=pngDecode(bytes),r=mark.state.morph.rect
    const x=Math.max(0,Math.floor((r.left-8)*2)),y=Math.max(0,Math.floor((r.top-8)*2))
    const bx=Math.min(im.w-128,Math.floor((r.right+8)*2)-128),by=Math.min(im.h-128,Math.floor((r.bottom+8)*2)-128)
    const corners=[crop(im,x,y),crop(im,bx,by)],prefix=join(dir,name,String(index).padStart(3,'0'))
    await writeFile(join(output,`${prefix}-TL.png`),pngEncode(128,128,corners[0].pixels));await writeFile(join(output,`${prefix}-BR.png`),pngEncode(128,128,corners[1].pixels))
    if(index===0||index===frameCount-1)await writeFile(join(output,`${prefix}-full.png`),bytes)
    frames.push({index,mark,captureStart,captureEnd,corners,cropCSS:{TL:{x:x/2,y:y/2,width:64,height:64},BR:{x:bx/2,y:by/2,width:64,height:64}}})
  }
  const p=await c.eval('__glassTrace.stop()')
  await save(join(dir,name,'raw.json'),{...p,frames:frames.map(({corners,...f})=>f)})
  const summary=summarize(p,frames)
  await save(join(dir,name,'summary.json'),summary)
  await writeFile(join(output,dir,name,'corners-contact.png'),sheet(frames.map(f=>f.corners)))
  await save(join(dir,name,'layers.json'),await layerEvidence(c))
  console.log(`RESULT ${name} samples=${p.samples.length} mutations=${p.mutations.length} kinds=${JSON.stringify(summary.actualKinds)} frames=${summary.renderedFrames}`)
  return summary
}

async function hintHarness() {
  // Deliberately separate synthetic DOM experiment, never a real-root repro.
  report.contract='Source Vite DOM harness: optical hint A/B and inactivity controls; synthetic static background, not real-root reproduction'
  report.cases=[];report.comparisons=[]
  const harness=join(output,'hint-harness');await mkdir(harness,{recursive:true})
  await writeFile(join(harness,'index.html'),'<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/main.tsx"></script>')
  await writeFile(join(harness,'main.tsx'),`
import React from 'react';import{createRoot}from'react-dom/client';
import{GlassSurface,GlassSamplingContext,GlassRenderingContext}from'/@fs${root}/src/home/GlassSurface.tsx';
import{HOME_GLASS}from'/@fs${root}/src/home/glass.ts';
import'/@fs${root}/src/home/home.css';
const p=new URLSearchParams(location.search),small=p.get('size')==='collapsed',frac=p.get('size')==='fractional';
const w=small?128:frac?340.25:340,h=small?38:frac?680.25:680,top=small?707.390625:frac?84.25:84;
document.documentElement.dataset.hint=p.get('hint')??'on';
const style=document.createElement('style');style.textContent='html,body,#root{margin:0;width:390px;height:844px;overflow:hidden;background:#070b14;color:#ddd;font:12px Arial}.p0{position:absolute;inset:0}.synthetic-background{position:absolute;inset:0;background:repeating-linear-gradient(137deg,#010919 0px,#ae9577 9px,#f2e9db 12px,#2c3448 19px,#18222c 32px)}html[data-hint=off] .home-glass-backdrop[data-sampling=true]{transform:none!important;will-change:auto!important}.harness-text{position:absolute;inset:24px;pointer-events:none}.harness-rim{position:absolute;inset:0;pointer-events:none;border-radius:inherit}';document.head.append(style);
const material={transmission:HOME_GLASS.chatTransmission,blur:6,rim:HOME_GLASS.rim,reflection:HOME_GLASS.reflection,shadow:HOME_GLASS.shadow};window.__harnessMaterial=material;
createRoot(document.getElementById('root')!).render(<GlassRenderingContext.Provider value={p.get('mode')==='detailed'?'detailed':'auto'}><GlassSamplingContext.Provider value={p.get('sampling')!=='false'}><main className="p0"><div className="synthetic-background"/><div className="home-workspace"><div className="home-scene-ui"><div className="home-morph" style={{left:22,top,width:w,height:h,borderRadius:small?19:15}}><GlassSurface width={Math.round(w)} height={Math.round(h)} radius={small?19:15} material={material}/><div className="harness-text">虚构静态对照</div><div className="harness-rim"/></div></div></div></main></GlassSamplingContext.Provider></GlassRenderingContext.Provider>);
`)
  const {createServer:makeVite}=await import('vite'),{default:react}=await import('@vitejs/plugin-react')
  viteServer=await makeVite({configFile:false,root:harness,envDir:harness,publicDir:false,cacheDir:join(output,'vite-cache'),plugins:[react()],server:{host:'127.0.0.1',port:0,strictPort:false,fs:{allow:[root]}},optimizeDeps:{include:['react','react-dom/client','react/jsx-runtime']},logLevel:'warn'})
  await viteServer.listen();const base=`http://127.0.0.1:${viteServer.httpServer.address().port}`;report.origin=base
  const profile=join(output,'hint-chrome-profile');const chromeErrors=[]
  child=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=127.0.0.1;localhost','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost','about:blank'],{stdio:['ignore','ignore','pipe']});child.stderr.on('data',b=>chromeErrors.push(String(b)))
  let port;for(let i=0;i<150;i++){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);if(port)break}catch{}await delay(100)}assert.ok(port)
  const version=await fetch(`http://127.0.0.1:${port}/json/version`).then(r=>r.json());browser=await CDP.connect(version.webSocketDebuggerUrl);report.actualRenderGPU=await browser.send('SystemInfo.getInfo')
  const target=(await fetch(`http://127.0.0.1:${port}/json`).then(r=>r.json())).find(t=>t.type==='page');c=await CDP.connect(target.webSocketDebuggerUrl)
  c.onEvent=m=>{if(m.method==='LayerTree.layerTreeDidChange')c.layers=m.params.layers;if(m.method==='Fetch.requestPaused'){const{requestId,request}=m.params,ok=request.url.startsWith(base+'/')||/^(data|blob):/.test(request.url);void c.send(ok?'Fetch.continueRequest':'Fetch.failRequest',{requestId,...(ok?{}:{errorReason:'BlockedByClient'})}).catch(()=>{})}}
  for(const m of ['Page.enable','Runtime.enable','Network.enable'])await c.send(m)
  await c.send('Fetch.enable',{patterns:[{urlPattern:'*'}]});await c.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});await c.send('Emulation.setFocusEmulationEnabled',{enabled:true})
  const specs=[{id:'mac-auto',android:false,mode:'auto'},{id:'android-auto',android:true,mode:'auto'},{id:'android-detailed',android:true,mode:'detailed'}]
  const allFrames=new Map()
  for(const spec of specs)for(const size of ['collapsed','expanded','fractional'])for(const hint of ['off','on']) {
    const id=`${spec.id}-${size}-${hint}`;console.log(`HINT ${id}`);await mkdir(join(output,id),{recursive:true})
    await c.send('Emulation.setUserAgentOverride',{userAgent:spec.android?'Mozilla/5.0 (Linux; Android 12) Chrome/154.0.0.0 Mobile Safari/537.36':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/154.0.0.0 Safari/537.36'})
    await c.send('Page.navigate',{url:`${base}/?mode=${spec.mode}&size=${size}&hint=${hint}`});await c.wait("!!document.querySelector('.home-morph .home-glass-backdrop') && document.querySelector('.home-morph .home-glass-backdrop').style.backdropFilter!==''",30000)
    await c.send('DOM.enable');await c.send('LayerTree.disable').catch(()=>{});await c.send('LayerTree.enable');await delay(350)
    await c.eval(`(${installTrace.toString()})()`)
    const initial=await c.eval('__glassTrace.state()');const images=[],frameTimes=[]
    await c.eval("__glassTrace.start('source-hint-still')")
    for(let i=0;i<8;i++){frameTimes.push(await c.eval('__glassTrace.mark()'));const shot=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true});const bytes=Buffer.from(shot.data,'base64');await writeFile(join(output,id,`${i}.png`),bytes);images.push(pngDecode(bytes));await delay(70)}
    const trace=await c.eval('__glassTrace.stop()');await save(join(id,'still-raw.json'),{...trace,frameTimes})
    const layers=await layerEvidence(c),entry={id,spec,size,hint,initial,material:await c.eval('__harnessMaterial'),layers,traceSummary:{mutations:trace.mutations,samples:trace.samples.length,durationMs:trace.durationMs},temporal:images.slice(1).map((im,i)=>diff(images[i],im)),exceptions:c.events.filter(e=>e.method==='Runtime.exceptionThrown')}
    allFrames.set(id,images[0]);report.cases.push(entry);await save(join(id,'result.json'),entry)
    if(hint==='on') {
      const before=allFrames.get(`${spec.id}-${size}-off`),after=images[0],r=initial.morph.rect
      const corners=im=>[crop(im,Math.floor((r.x-8)*2),Math.floor((r.y-8)*2)),crop(im,Math.floor((r.right+8)*2)-128,Math.floor((r.bottom+8)*2)-128)]
      const a=corners(before),b=corners(after),comparison={id:`${spec.id}-${size}`,whole:diff(before,after),TL:diff(a[0],b[0]),BR:diff(a[1],b[1])}
      report.comparisons.push(comparison);await save(join(id,'AB-pixels.json'),comparison);await writeFile(join(output,id,'AB-corners.png'),sheet([a,b]))
      if(size==='expanded') {
        // Activity lifecycle control only; never classify as a flicker repro.
        await c.eval("document.documentElement.dataset.mobileActive='false';document.dispatchEvent(new Event('astaria-app-activity'));true");await delay(150)
        entry.appInactiveControl=await c.eval('__glassTrace.state()');await save(join(id,'inactive-control.json'),entry.appInactiveControl)
        await c.send('Page.navigate',{url:`${base}/?mode=${spec.mode}&size=${size}&hint=on&sampling=false`});await c.wait("!!document.querySelector('.home-morph .home-glass-backdrop')");await delay(200)
        await c.eval(`(${installTrace.toString()})()`);entry.samplingFalseControl=await c.eval('__glassTrace.state()');await save(join(id,'sampling-false-control.json'),entry.samplingFalseControl)
      }
    }
    await save('report.json',report)
  }
  await save('chrome-stderr.json',chromeErrors);report.status='source-hint-harness-complete-not-root-repro'
}

let server,child,c,browser,viteServer
await mkdir(output,{recursive:true})
report.runnerSHA256=hash(await readFile(fileURLToPath(import.meta.url)))
await save('report.json',report)
try {
  report.sourceHashes=await sourceHashes()
  if(arg('harness','')==='hint') {
    await hintHarness()
  } else {
  let stable=false
  for(let i=0;i<5;i++) {
    const before=await inventory(dist);await delay(600);const after=await inventory(dist);if(before.hash!==after.hash)continue
    await cp(dist,served,{recursive:true});const copied=await inventory(served),current=await inventory(dist)
    if(copied.hash===current.hash){report.build={...copied,capturedAt:new Date().toISOString()};stable=true;break}
    await rm(served,{recursive:true,force:true})
  }
  assert.ok(stable,'dist changed during snapshot')
  // Capture only explicitly named public product source, without roadmap/data.
  await mkdir(join(output,'source-at-start'),{recursive:true})
  for(const p of sourcePaths)await writeFile(join(output,'source-at-start',p.replaceAll('/','__')),await readFile(join(root,p)))
  const builtFiles=report.build.files.filter(f=>/\.(js|css)$/.test(f.path))
  report.build.opticalHintStrings=[]
  for(const f of builtFiles){const s=await readFile(join(served,f.path),'utf8');if(s.includes('data-sampling')||/will-change:backdrop-filter/.test(s))report.build.opticalHintStrings.push(f.path)}
  await save('build-manifest.json',{build:report.build,sourceHashes:report.sourceHashes})
  const backup=fixture();await save('fictional-backup.json',backup)
  report.fixture={sha256:hash(JSON.stringify(backup)),tasks:1,messages:6,onboarding:'real Worker POST after checksum-preserving import, verified GET',fictional:true}
  const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.png':'image/png','.svg':'image/svg+xml','.json':'application/json','.webmanifest':'application/manifest+json'}
  server=createServer(async(req,res)=>{try{
    const path=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname)
    if(path.startsWith('/api/')){report.httpApis.push(path);res.writeHead(500);res.end('APIs must be handled by the real mobile Worker');return}
    const file=resolve(served,`.${path==='/'?'/index.html':path}`);assert.ok(file.startsWith(served+sep))
    const bytes=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]??'application/octet-stream','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self' blob: data:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' blob: data:; worker-src 'self' blob:; img-src 'self' data: blob:; font-src 'self' data:"});res.end(bytes)
  }catch{res.writeHead(404);res.end('Not found')}})
  await new Promise(y=>server.listen(0,'127.0.0.1',y));const base=`http://127.0.0.1:${server.address().port}`;report.origin=base
  const cases=[{id:'mac-auto',ua:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',glass:'auto',expected:'svg-url'},
    {id:'android-auto',ua:'Mozilla/5.0 (Linux; Android 12; wv) AppleWebKit/537.36 Chrome/154.0.0.0 Mobile Safari/537.36',glass:'auto',expected:'css-blur'},
    {id:'android-detailed',ua:'Mozilla/5.0 (Linux; Android 12; wv) AppleWebKit/537.36 Chrome/154.0.0.0 Mobile Safari/537.36',glass:'detailed',expected:'svg-url'}]
  for(const spec of cases) {
    const result={...spec,phases:[],startedAt:new Date().toISOString()};report.cases.push(result)
    const dir=spec.id;await mkdir(join(output,dir),{recursive:true});const profile=join(output,dir,'chrome-profile')
    console.log(`CASE ${dir}`)
    child=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=127.0.0.1;localhost','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost','about:blank'],{stdio:['ignore','ignore','pipe']})
    const chromeErrors=[];child.stderr.on('data',b=>chromeErrors.push(String(b)));child.on('error',e=>chromeErrors.push(e.message))
    let port;for(let i=0;i<150;i++){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);if(port)break}catch{}await delay(100)}assert.ok(port)
    const version=await fetch(`http://127.0.0.1:${port}/json/version`).then(r=>r.json());browser=await CDP.connect(version.webSocketDebuggerUrl)
    result.browser=version;result.actualRenderGPU=await browser.send('SystemInfo.getInfo')
    const target=(await fetch(`http://127.0.0.1:${port}/json`).then(r=>r.json())).find(t=>t.type==='page');c=await CDP.connect(target.webSocketDebuggerUrl)
    c.onEvent=m=>{if(m.method==='LayerTree.layerTreeDidChange')c.layers=m.params.layers;if(m.method==='Fetch.requestPaused'){const{requestId,request}=m.params,ok=request.url.startsWith(base+'/')||/^(data|blob):/.test(request.url);void c.send(ok?'Fetch.continueRequest':'Fetch.failRequest',{requestId,...(ok?{}:{errorReason:'BlockedByClient'})}).catch(()=>{})}}
    for(const method of ['Page.enable','Runtime.enable','Network.enable','LayerTree.enable','Performance.enable'])await c.send(method)
    await c.send('Fetch.enable',{patterns:[{urlPattern:'*'}]});await c.send('Network.setBypassServiceWorker',{bypass:true})
    await c.send('Emulation.setUserAgentOverride',{userAgent:spec.ua});await c.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true})
    await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});await c.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});await c.send('Emulation.setTimezoneOverride',{timezoneId:'Asia/Shanghai'})
    await c.send('Page.addScriptToEvaluateOnNewDocument',{source:init});await c.send('Page.navigate',{url:base});await c.wait("!!window.__ASTARIA_P0__ && !!document.querySelector('.home-brand')",120000)
    await c.api('data/import',{backup,confirmed:true});await c.api('onboarding',{completed:true});assert.equal((await c.api('onboarding')).completed,true)
    const expected=await c.api('preferences');result.preferences=await c.api('preferences',{expected,value:{...expected,startupPage:'home',theme:'dark',glass:'soft',render:{...expected.render,glass:spec.glass}}})
    await c.send('Page.reload');await c.wait("!!window.__ASTARIA_P0__ && !!document.querySelector('.home-morph') && !document.querySelector('.first-run')",120000)
    await c.wait('!__ASTARIA_P0__.getSnapshot().cameraTransition');await delay(1500)
    // Re-enable after navigation so layer IDs belong to the loaded app document.
    await c.send('DOM.enable');await c.send('LayerTree.disable');await c.send('LayerTree.enable');await delay(200)
    await c.eval(`(${installTrace.toString()})()`)
    result.gl=await c.eval("(()=>{const canvas=document.querySelector('.p0-universe canvas'),g=canvas.getContext('webgl2'),e=g.getExtension('WEBGL_debug_renderer_info');return{dpr:devicePixelRatio,viewport:[innerWidth,innerHeight],vendor:g.getParameter(g.VENDOR),renderer:g.getParameter(g.RENDERER),unmaskedVendor:e&&g.getParameter(e.UNMASKED_VENDOR_WEBGL),unmaskedRenderer:e&&g.getParameter(e.UNMASKED_RENDERER_WEBGL),buffer:[g.drawingBufferWidth,g.drawingBufferHeight],context:g.getContextAttributes()}})()")
    const collapsed=await c.eval('__glassTrace.state()');assert.equal(collapsed.backdrop.backdropKind,spec.expected);result.collapsedInitial=collapsed
    result.phases.push(await phase(c,dir,'collapsed-steady-cpu1',12000,32))
    await c.eval('__ASTARIA_P0__.setPaused(true);true');await delay(700)
    result.phases.push(await phase(c,dir,'collapsed-paused-background-cpu1',4200,24))
    await c.eval('__ASTARIA_P0__.setPaused(false);true');await delay(400)
    await c.eval("__glassTrace.start('chat-opening-observation')")
    const hit=await c.eval("(()=>{const e=document.querySelector('.home-launch'),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return{x,y,hit:h===e||e.contains(h),disabled:e.disabled}})()")
    assert.ok(hit.hit&&!hit.disabled);await c.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:hit.x,y:hit.y}]});await c.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
    await c.wait("document.querySelector('.home-workspace').dataset.chatOpen==='true' && !__ASTARIA_P0__.getSnapshot().cameraTransition && !document.querySelector('#home-xixi').inert",60000)
    // Do not let an actively blinking input caret contaminate paused pixels.
    await c.eval("document.activeElement?.blur();true");await delay(1500)
    await save(join(dir,'chat-opening.json'),await c.eval('__glassTrace.stop()'))
    for(const rate of rates) {
      await c.send('Emulation.setCPUThrottlingRate',{rate});await delay(400)
      result.phases.push(await phase(c,dir,`expanded-steady-cpu${rate}`,12000,32))
      result.pauseBefore=await c.eval('__ASTARIA_P0__.getSnapshot()');await c.eval('__ASTARIA_P0__.setPaused(true);true');await delay(700)
      await c.wait('!__ASTARIA_P0__.getSnapshot().cameraTransition')
      result.phases.push(await phase(c,dir,`expanded-paused-background-cpu${rate}`,4200,24))
      await c.eval('__ASTARIA_P0__.setPaused(false);true');await delay(500)
    }
    const all=await c.eval('__glassTrace.finish()')
    const mapManifest=[];for(const [fnv,data]of Object.entries(all.maps)){const file=`${dir}/map-${fnv}.png`,bytes=Buffer.from(data.split(',')[1],'base64');await writeFile(join(output,file),bytes);mapManifest.push({fnv1a32:fnv,sha256:hash(bytes),file})}
    await save(join(dir,'boot-and-maps.json'),{boot:all.boot,maps:mapManifest});result.workerNames=all.boot.workers.map(w=>w.name);assert.ok(result.workerNames.includes('astaria-local-data'));assert.ok(all.boot.workers.some(w=>/geodesics/.test(w.url)))
    result.jsExceptions=[...all.boot.errors,...c.events.filter(e=>e.method==='Runtime.exceptionThrown')];result.blockedNetwork=c.events.filter(e=>e.method==='Fetch.requestPaused'&&!e.params.request.url.startsWith(base+'/')&&!/^(data|blob):/.test(e.params.request.url)).map(e=>e.params.request.url)
    await save(join(dir,'cdp-events.json'),c.events.filter(e=>['Runtime.exceptionThrown','Log.entryAdded','Network.loadingFailed','Network.requestWillBeSent','Fetch.requestPaused'].includes(e.method)))
    await save(join(dir,'chrome-stderr.json'),chromeErrors)
    c.close();c=undefined;browser.close();browser=undefined;child.kill('SIGTERM');await new Promise(y=>child.once('exit',y));child=undefined
    result.finishedAt=new Date().toISOString();await save('report.json',report)
  }
  assert.equal(report.httpApis.length,0,'An API escaped the real Worker')
  report.status='diagnostic-complete-no-fix-claimed'
  }
} catch(e) {report.status='diagnostic-failed';report.errors.push({message:e.message,stack:e.stack});console.error(e)}
finally {
  c?.close();browser?.close();if(child)child.kill('SIGTERM')
  if(viteServer)await viteServer.close()
  if(server){server.closeAllConnections();await new Promise(y=>server.close(y))}
  report.sourceHashesAtEnd=await sourceHashes();report.sourceDrift=Object.fromEntries(sourcePaths.map(p=>[p,report.sourceHashes?.[p]!==report.sourceHashesAtEnd[p]]))
  report.distHashAtEnd=(await inventory(dist)).hash;report.finishedAt=new Date().toISOString();await save('report.json',report)
  console.log(JSON.stringify({output,status:report.status,cases:report.cases.length,errors:report.errors}))
  if(report.status==='diagnostic-failed')process.exitCode=1
}
