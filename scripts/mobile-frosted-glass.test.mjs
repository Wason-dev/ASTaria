/** Real React/ResizeObserver/backdrop transitions on an isolated Chromium page.
 * UA selection tests routing, not Android/iOS GPU behaviour. No app data/server,
 * dependency install or production build. Set GLASS_QA_OUTPUT to retain evidence.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'vite'

const root = resolve(import.meta.dirname, '..')
const chromePath=process.env.GLASS_QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const android = 'Mozilla/5.0 (Linux; Android 12; wv) AppleWebKit/537.36 Chrome/154.0.0.0 Mobile Safari/537.36'
const webkit = 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1'
// Chrome screenshots are RGB/RGBA PNGs. Decode without installing imaging tools.
function pixels(png) {
  let at=8, width, height, channels, packed=[]
  while(at<png.length) {
    const size=png.readUInt32BE(at),type=png.toString('ascii',at+4,at+8),data=png.subarray(at+8,at+8+size);at+=size+12
    if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert.equal(data[8],8);channels=data[9]===2?3:data[9]===6?4:0;assert.ok(channels);assert.equal(data[12],0)}
    if(type==='IDAT')packed.push(data)
  }
  const raw=inflateSync(Buffer.concat(packed)),stride=width*channels,out=new Uint8Array(height*stride)
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c}
  for(let y=0;y<height;y++)for(let x=0;x<stride;x++) {
    const filter=raw[y*(stride+1)],a=x>=channels?out[y*stride+x-channels]:0,b=y?out[(y-1)*stride+x]:0,c=y&&x>=channels?out[(y-1)*stride+x-channels]:0
    out[y*stride+x]=(raw[y*(stride+1)+1+x]+[0,a,b,(a+b)>>1,paeth(a,b,c)][filter])&255
  }
  return {width,height,channels,data:out}
}
function difference(left,right) {
  assert.equal(left.data.length,right.data.length)
  let changed=0,total=0,max=0,maxChannel=0
  for(let i=0;i<left.data.length;i+=left.channels) {
    let delta=0
    for(let c=0;c<3;c++){const d=Math.abs(left.data[i+c]-right.data[i+c]);delta+=d;maxChannel=Math.max(maxChannel,d)}
    if(delta)changed++;total+=delta;max=Math.max(max,delta/3)
  }
  return {changedPixels:changed,meanChannelDelta:total/(left.width*left.height*3),maxMeanPixelDelta:max,maxChannelDelta:maxChannel}
}
const fixture = `
import React, { StrictMode, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { GlassSurface, MeasuredGlassSurface, GlassSamplingContext, GlassRenderingContext } from '/src/home/GlassSurface.tsx'
import { PlannerOverview } from '/src/planner/PlannerOverview.tsx'
import { publishSceneFrame } from '/src/stores/sceneFrames.ts'
import '/src/prototype/prototype.css'
import '/src/home/home.css'
import '/src/planner/planner.css'
import '/src/planner/planner-glass.css'
import '/src/planner/planner-motion.css'
import '/src/planner/planner-layout.css'
const root = createRoot(document.getElementById('root')), geometry = createRef()
const state = { sampling: true, rendering: 'auto', blur: 6, measured: false, settle: true, width: 280, height: 180, radius: 19, theme: 'dark', revision: 0, overview: false, menu:false, declarative:false }
const now=new Date('2026-10-15T12:00:00'), planner={revision:0,timetableConfirmed:true,details:{},checked:{},blocks:[],routines:[{id:'synthetic-available',title:'隔离可用时间',kind:'available',weekdays:[0,1,2,3,4,5,6],start:'08:00',end:'22:00',enabled:true,location:'',items:[]}]}
window.qa = { state, geometry, encodes: [], observations: 0, filters:[], frame:publishSceneFrame }
const encode = HTMLCanvasElement.prototype.toDataURL
HTMLCanvasElement.prototype.toDataURL = function(...args) { qa.encodes.push([this.width, this.height]); return encode.apply(this,args) }
const setProperty=CSSStyleDeclaration.prototype.setProperty
CSSStyleDeclaration.prototype.setProperty=function(name,value,...args){if(name==='backdrop-filter')qa.filters.push(value);return setProperty.call(this,name,value,...args)}
const NativeObserver = ResizeObserver
window.ResizeObserver = class extends NativeObserver { constructor(callback) { super(callback); qa.observations++ } }
qa.render = patch => {
  Object.assign(state,patch)
  const material = { transmission:80, blur:state.blur, rim:15, reflection:12, shadow:60 }
  flushSync(() => root.render(<StrictMode><div className="p0"><div className="p0-universe" style={{background:'repeating-linear-gradient(115deg,#0a1021 0px,#0a1021 14px,#e4c28a 16px,#354455 19px,#101624 27px)'}} /><div className="home-workspace" data-theme={state.theme}>
    <GlassRenderingContext.Provider value={state.rendering}><GlassSamplingContext.Provider value={state.sampling}>
      {state.overview ? <section className="planner" data-active="true" data-theme={state.theme} style={{'--pl-rim':.15,'--pl-inner-tint':.05,'--pl-font':'13px','--pl-radius':'19px','--pl-shadow':.6}}>
        <section id="panel" className="pl-overview pl-glass pl-day-panel" style={{position:'absolute',top:80,left:24,width:state.width,height:state.height,borderRadius:state.radius}}>
          <MeasuredGlassSurface radius={state.radius} material={material} settleResize />
          <div className="pl-glass-content"><PlannerOverview view="timetable" selected="2026-10-15" anchor={now} now={now} state={planner} tasks={[]} saving={false} error="" onMoveDay={()=>{}} onTask={()=>{}} onDayEvent={()=>{}} onCreate={()=>{}} onAct={async()=>{}} /></div>
        </section>
        <div className="pl-slot" data-kind="available" style={{position:'absolute',top:600,left:30,width:250,height:90,border:'1px solid #c5b38b',color:'#c5b38b'}}>隔离 available 槽框（相邻前景）</div>
      </section> : <div id="panel" className={state.menu?'home-menu':'home-morph'} data-open="true" style={{top:160,left:24,width:state.width,height:state.height,borderRadius:state.radius}}>
        {state.measured ? <MeasuredGlassSurface radius={state.radius} material={material} settleResize={state.settle} /> : <GlassSurface geometryRef={geometry} width={state.declarative?state.width:280} height={state.declarative?state.height:180} radius={19} material={material} />}
        <div className="qa-content">ASTaria · 玻璃专项隔离<br/>原字体 / 胶囊 / 连续动画</div>
      </div>}
    </GlassSamplingContext.Provider></GlassRenderingContext.Provider>
  </div></div></StrictMode>))
}
qa.snapshot = () => {
  const surface = document.querySelector('.home-glass-surface')
  const sample = document.querySelector('.home-glass-backdrop') ?? surface
  const image = document.querySelector('feImage'), filter = document.querySelector('filter')
  const styles = getComputedStyle(sample), panel = document.querySelector('#panel')
  return { backdrop:styles.backdropFilter, inline:sample.style.backdropFilter,
    image:!!image?.getAttribute('href'), imageSize:image && [image.getAttribute('width'),image.getAttribute('height')],
    filterSize:filter && [filter.getAttribute('x'),filter.getAttribute('y'),filter.getAttribute('width'),filter.getAttribute('height')],
    blur:document.querySelector('feGaussianBlur')?.getAttribute('stdDeviation'), scale:document.querySelector('feDisplacementMap')?.getAttribute('scale'),
    encodes:qa.encodes.slice(), observations:qa.observations, width:panel.clientWidth,height:panel.clientHeight,
    radius:getComputedStyle(panel).borderRadius,contentFilter:getComputedStyle(document.querySelector('.qa-content,.pl-glass-content')).filter,
    surfaceOpacity:getComputedStyle(surface).opacity, rimOpacity:getComputedStyle(surface,'::after').opacity, shadow:getComputedStyle(surface).boxShadow }
}
qa.animate = () => document.querySelector('#panel').animate([
  { transform:'translate3d(.25px,8px,0) scale(.98)' }, { transform:'translate3d(.75px,0,0) scale(1)' }
], {duration:260,fill:'both'})
qa.initGPU = () => {
  const canvas=document.createElement('canvas');canvas.width=innerWidth*devicePixelRatio;canvas.height=innerHeight*devicePixelRatio
  canvas.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none';document.querySelector('.p0-universe').append(canvas)
  const gl=canvas.getContext('webgl',{preserveDrawingBuffer:true});if(!gl)throw Error('WebGL unavailable')
  const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s}
  const program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,'attribute vec2 p;varying vec2 v;void main(){v=p*.5+.5;gl_Position=vec4(p,0.,1.);}'))
  gl.attachShader(program,shader(gl.FRAGMENT_SHADER,'precision highp float;varying vec2 v;uniform float phase;void main(){float s=max(0.,sin((v.x*.85+v.y*.35)*75.+phase))*.12;float g=exp(-abs(v.y-.52+.08*sin(v.x*6.+phase*.1))*90.);gl_FragColor=vec4(vec3(.03,.04,.065)+s+g*vec3(.8,.6,.3),1.);}'))
  gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));gl.useProgram(program)
  const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW)
  const p=gl.getAttribLocation(program,'p');gl.enableVertexAttribArray(p);gl.vertexAttribPointer(p,2,gl.FLOAT,false,0,0)
  const phase=gl.getUniformLocation(program,'phase');qa.draw=amount=>{gl.uniform1f(phase,amount);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);gl.finish()};qa.draw(0)
  const debug=gl.getExtension('WEBGL_debug_renderer_info')
  return {renderer:debug&&gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),vendor:debug&&gl.getParameter(debug.UNMASKED_VENDOR_WEBGL),version:gl.getParameter(gl.VERSION)}
}
qa.render({})
`

test('glass keeps its material and exact geometry across real component transitions', { timeout: 90000, skip:!existsSync(chromePath)&&'Set GLASS_QA_CHROME to a local Chrome binary for browser/GPU regressions' }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'astaria-glass-'))
  let chrome, ws, server, sequence = 0
  const pending = new Map(), errors = [], evidence = [], checks=[]
  const run=(name,fn)=>t.test(name,async()=>{try{await fn();checks.push({name,status:'passed'})}catch(error){checks.push({name,status:'failed',error:String(error)});throw error}})
  const delay = ms => new Promise(done => setTimeout(done, ms))
  const output = process.env.GLASS_QA_OUTPUT && resolve(process.env.GLASS_QA_OUTPUT)
  const send = (method, params = {}) => new Promise((done, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)) }, 10000)
    pending.set(id, {done,reject,timer}); ws.send(JSON.stringify({id,method,params}))
  })
  const evaluate = async expression => {
    const reply = await send('Runtime.evaluate', {expression,awaitPromise:true,returnByValue:true})
    if (reply.exceptionDetails) throw Error(JSON.stringify(reply.exceptionDetails))
    return reply.result.value
  }
  const waitFor=async expression=>{
    for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(20)}
    throw Error('Timed out waiting for actual component delivery: '+expression)
  }
  const snapshot = async name => { const state = await evaluate('qa.snapshot()'); evidence.push({name,...state}); return state }
  const capture = async name => {
    if (!output) return
    await writeFile(join(output, name + '.png'), Buffer.from((await send('Page.captureScreenshot', {format:'png'})).data, 'base64'))
  }
  const navigate = async (ua, width=390) => {
    await send('Emulation.setUserAgentOverride',{userAgent:ua})
    await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:2,mobile:true})
    await send('Page.navigate',{url:`http://127.0.0.1:${server.httpServer.address().port}`})
    for (let i=0;i<100;i++) { if (await evaluate('!!window.qa?.snapshot')) return; await delay(50) }
    throw Error('Fixture did not mount')
  }
  try {
    if (output) await mkdir(output,{recursive:true})
    server = await createServer({root,configFile:false,server:{host:'127.0.0.1',port:0},plugins:[{
      name:'isolated-glass-fixture',
      resolveId:id=>id==='/__glass-qa.tsx' ? id : undefined,
      load:id=>id==='/__glass-qa.tsx' ? fixture : process.env.GLASS_QA_SURFACE && id===resolve(root,'src/home/GlassSurface.tsx') ? readFile(process.env.GLASS_QA_SURFACE,'utf8') : undefined,
      configureServer(vite) { vite.middlewares.use((req,res,next)=>{
        if (req.url!=='/') return next()
        res.setHeader('Content-Type','text/html'); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:repeating-linear-gradient(115deg,#0a1021 0px,#0a1021 14px,#e4c28a 16px,#354455 19px,#101624 27px);height:100vh}.qa-content{position:relative;z-index:1;padding:24px;color:#eeeae3;font:400 13px/1.7 Inter,"Helvetica Neue","PingFang SC",sans-serif}.home-workspace[data-theme=light] .home-glass-surface{background:rgb(250 251 252 / var(--glass-tint))}</style><div id="root"></div><script type="module" src="/__glass-qa.tsx"></script>')
      }) },
    }]})
    await server.listen()
    const profile=join(temporary,'chrome')
    chrome=spawn(chromePath,[
      '--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--disable-background-networking','--disable-sync','about:blank',
    ],{stdio:'ignore'})
    let port
    for(let i=0;i<100;i++){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);if(port)break}catch{}await delay(50)}
    assert.ok(port,'Chrome remote debugging started')
    const page=(await fetch(`http://127.0.0.1:${port}/json`).then(r=>r.json())).find(x=>x.type==='page')
    ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((done,reject)=>{ws.onopen=done;ws.onerror=reject})
    ws.onmessage=event=>{const m=JSON.parse(event.data),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(m.error):p.done(m.result)}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails)}
    await send('Runtime.enable');await send('Page.enable')

    await run('Android auto and WebKit fallback keep CSS blur, without map encoding or geometry observation', async()=>{
      for(const ua of [android,webkit]) for(const width of [320,390]) {
        await navigate(ua,width)
        await evaluate('qa.render({measured:true});true');await delay(30)
        const before=await snapshot(`css-${width}-${ua===android?'android':'webkit-route'}`)
        assert.equal(before.backdrop,'blur(6px)');assert.equal(before.image,false)
        assert.deepEqual(before.encodes,[]);assert.equal(before.observations,0)
        await evaluate('qa.render({blur:0,theme:"light"});true')
        assert.equal((await snapshot('css-clear-light')).backdrop,'none')
        await evaluate('qa.render({blur:6});true')
        await evaluate('qa.render({width:260,height:240,revision:1});true');await delay(130)
        assert.equal((await snapshot('css-resize')).backdrop,'blur(6px)')
        assert.deepEqual(await evaluate('qa.encodes'),[])
        await capture(`css-${width}-${ua===android?'android':'webkit-route'}`)
      }
    })

    await run('mobile SVG repaints only for presented scene frames with numerically identical bounds', async()=>{
      await navigate(android)
      await evaluate("document.documentElement.dataset.mobile='android';qa.render({rendering:'detailed'});true")
      const before=await snapshot('scene-frame-before')
      const result=await evaluate(`(async()=>{
        const f=document.querySelector('filter'),image=document.querySelector('feImage'),href=image.getAttribute('href'),writes=[];
        const observer=new MutationObserver(records=>writes.push(...records.filter(r=>r.attributeName==='x').map(r=>r.oldValue)));
        observer.observe(f,{attributes:true,attributeOldValue:true});const samples=[];
        for(let i=0;i<60;i++){qa.frame();samples.push({raw:f.getAttribute('x'),value:f.x.baseVal.value,href:image.getAttribute('href')===href})}
        await new Promise(r=>setTimeout(r,20));const stopped=f.getAttribute('x'),count=writes.length;
        await new Promise(r=>setTimeout(r,40));const idleWrites=writes.length-count;
        document.documentElement.dataset.mobileActive='false';document.dispatchEvent(new Event('astaria-app-activity'));
        for(let i=0;i<5;i++)qa.frame();await new Promise(r=>setTimeout(r,10));const inactiveWrites=writes.length-count;
        document.documentElement.dataset.mobileActive='true';document.dispatchEvent(new Event('astaria-app-activity'));
        qa.render({sampling:false});const detachedCount=writes.length;for(let i=0;i<5;i++)qa.frame();await new Promise(r=>setTimeout(r,10));
        const detachedWrites=writes.length-detachedCount;observer.disconnect();qa.render({sampling:true,rendering:'auto'});
        for(let i=0;i<5;i++)qa.frame();return{samples,count,idleWrites,inactiveWrites,detachedWrites,cssHasFilter:!!document.querySelector('filter'),stopped};
      })()`)
      assert.equal(result.count,60,'one invalidation per actual presented scene frame')
      assert.ok(result.samples.every(s=>s.value===0&&s.href),'optical bounds and PNG stay exactly the same')
      assert.deepEqual([...new Set(result.samples.map(s=>s.raw))].sort(),['0','0.0'])
      assert.equal(result.idleWrites,0,'no independent repaint timer/RAF')
      assert.equal(result.inactiveWrites,0,'native background releases repaint work')
      assert.equal(result.detachedWrites,0,'departing/unmounted glass has no retained callback')
      assert.equal(result.cssHasFilter,false,'Android automatic CSS glass is unaffected')
      assert.deepEqual((await snapshot('scene-frame-after')).encodes,before.encodes,'frame invalidation never regenerates the map')
    })

    await run('a stale geometry handle cannot restart a departing panel sampling', async()=>{
      await navigate(android)
      await evaluate('qa.render({sampling:false});qa.geometry.current.pause();qa.geometry.current.update(300,200,19,1);true')
      assert.equal((await snapshot('departed')).backdrop,'none')
      await evaluate('qa.render({sampling:true});true')
      assert.equal((await snapshot('returned')).backdrop,'blur(6px)')
    })

    await run('measured detailed glass never encodes a placeholder and does not change filter kind during resize/reversal', async()=>{
      await navigate(android)
      await evaluate('qa.render({rendering:"detailed",measured:true});true');await delay(40)
      const initial=await snapshot('detailed-initial')
      assert.ok(initial.backdrop.includes('url('));assert.deepEqual(initial.imageSize,['280','180'])
      assert.ok(initial.encodes.every(([w,h])=>w>1&&h>1),'no 1x1 placeholder map')
      await evaluate('qa.filters=[];true')
      for(const height of [190,215,245,215,180]) {
        await evaluate(`qa.render({height:${height}});true`)
        await waitFor(`qa.snapshot().imageSize?.[1]===${JSON.stringify(String(height))}`)
        const during=await snapshot('detailed-resize-'+height)
        assert.ok(during.backdrop.includes('url('),'retain detailed optics during real ResizeObserver delivery')
        assert.deepEqual(during.imageSize,['280',String(height)])
      }
      await delay(140)
      const filters=await evaluate('qa.filters.slice()');evidence.push({name:'resize-backdrop-writes',filters})
      assert.ok(filters.every(value=>value.includes('url(')),'no CSS/SVG sampling switch at any point during observer delivery or settling')
      assert.equal((await snapshot('detailed-settled')).scale,'28','restore full detailed refraction after resize settles')
      await capture('detailed-soft')
    })

    await run('clear/soft, material rerenders, transform reversal, reduced motion and foreground restoration preserve the committed geometry', async()=>{
      await navigate(android)
      await evaluate('qa.render({rendering:"detailed"});qa.geometry.current.update(300,220,17,1);true')
      for(const blur of [0,6,0,6]) {
        await evaluate(`qa.render({blur:${blur},theme:${JSON.stringify(blur?'light':'dark')}});true`)
        const state=await snapshot('material-'+blur)
        assert.equal(state.blur,String(blur));assert.deepEqual(state.imageSize,['300','220'])
        assert.equal(state.contentFilter,'none')
      }
      const encodes=await evaluate('qa.encodes.length')
      await evaluate('window.animation=qa.animate();true');await delay(90);await capture('transform-middle')
      await evaluate('animation.reverse();true');await delay(180)
      assert.equal(await evaluate('qa.encodes.length'),encodes,'transform-only motion must not encode maps')
      await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
      await evaluate('animation.cancel();qa.render({sampling:false});true')
      assert.equal((await snapshot('reduced-departed')).backdrop,'none')
      await evaluate('qa.render({sampling:true});qa.geometry.current.update(300,220,17,1);true')
      assert.deepEqual((await snapshot('reduced-returned')).imageSize,['300','220'])
      await evaluate('document.documentElement.dataset.mobileActive="false";document.dispatchEvent(new Event("astaria-app-activity"));true')
      const hiddenEncodes=await evaluate('qa.encodes.length')
      await evaluate('qa.geometry.current.update(310,230,16,1);true')
      await delay(140)
      assert.equal(await evaluate('qa.encodes.length'),hiddenEncodes,'inactive geometry updates cannot encode PNGs')
      assert.equal((await snapshot('native-inactive')).backdrop,'none')
      await evaluate('document.documentElement.dataset.mobileActive="true";document.dispatchEvent(new Event("astaria-app-activity"));true')
      await delay(40)
      assert.deepEqual((await snapshot('foreground')).imageSize,['310','230'])
      await capture('foreground')
      await send('Emulation.setEmulatedMedia',{features:[]})
    })

    await run('steady fractional geometry on a real WebGL backdrop has repeatable corner pixels', async()=>{
      for(const rendering of ['auto','detailed']) {
        await navigate(android)
        await evaluate(`qa.render({rendering:${JSON.stringify(rendering)},width:280.25,height:180.25});qa.geometry.current.update(280.25,180.25,19,0);document.querySelector('#panel').style.left='24.25px';true`)
        const gpu=await evaluate('qa.initGPU()');evidence.push({name:'gpu-'+rendering,...gpu})
        await delay(120)
        const clip=await evaluate(`(()=>{const r=document.querySelector('#panel').getBoundingClientRect();return{x:r.right-38,y:r.bottom-38,width:42,height:42,scale:1}})()`)
        const initial=await snapshot('steady-start-'+rendering),frames=[],deltas=[]
        // Damage the GPU source with the same pixels every frame, then move it.
        // The first part distinguishes nondeterministic edge flicker from the
        // legitimate brightness change of a moving refracted background.
        for(let i=0;i<12;i++) {
          await evaluate(`qa.draw(${i<6?0:(i-5)*.25});true`);await delay(30)
          const png=Buffer.from((await send('Page.captureScreenshot',{format:'png',clip})).data,'base64')
          frames.push(pixels(png));if(i)deltas.push({frame:i,...difference(frames[i-1],frames[i])})
          if(output)await writeFile(join(output,`corner-${rendering}-${i}.png`),png)
        }
        const end=await snapshot('steady-end-'+rendering)
        evidence.push({name:'corner-deltas-'+rendering,deltas})
        assert.deepEqual(end.encodes,initial.encodes,'static optics never regenerate their map while GPU background moves')
        assert.equal(end.backdrop,initial.backdrop,'no sampling/filter kind changes in steady state')
        assert.equal(end.surfaceOpacity,initial.surfaceOpacity);assert.equal(end.rimOpacity,initial.rimOpacity);assert.equal(end.shadow,initial.shadow,'steady material shadow never animates with the background')
        // This Mac Metal path dithers a few pixels by one 8-bit level even on
        // the CSS-only control; record them rather than claim pixel identity.
        assert.ok(deltas.filter(v=>v.frame<6).every(v=>v.maxChannelDelta<=1),'identical GPU inputs stay within the measured 8-bit readback quantization')
        await capture('gpu-overview-'+rendering)
      }
    })

    await run('fractional optical bounds follow the actual box rather than the PNG integer dimensions', async()=>{
      await navigate(android)
      await evaluate('qa.render({rendering:"detailed",width:280.25,height:180.25});true')
      assert.deepEqual((await snapshot('fractional-rounded-props')).imageSize,['280.25','180.25'],'rounded React props cannot overwrite the fractional host at a camera publication boundary')
      await evaluate('qa.geometry.current.update(280.25,180.25,19,0);true')
      assert.deepEqual((await snapshot('fractional-direct')).imageSize,['280.25','180.25'])
      await evaluate('qa.render({measured:true});true');await delay(40)
      const measured=await snapshot('fractional-measured')
      assert.deepEqual(measured.imageSize,['280.25','180.25'])
      assert.deepEqual(measured.filterSize,['0','0','280.25','180.25'])
      assert.ok(measured.encodes.every(([w,h])=>Number.isInteger(w)&&Number.isInteger(h)))
    })

    await run('declarative dimensions and the actual menu reduced-motion CSS update before paint',async()=>{
      await navigate(android)
      await evaluate('qa.render({rendering:"detailed",declarative:true,width:300.5,height:210.25});true')
      assert.deepEqual((await snapshot('declarative-geometry')).imageSize,['300.5','210.25'])
      await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
      await evaluate('qa.render({menu:true,measured:true});true')
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".home-glass-surface")).animationName'),'none')
      assert.ok((await snapshot('reduced-menu')).backdrop.includes('url('))
      await send('Emulation.setEmulatedMedia',{features:[]})
    })

    await run('actual timetable overview keeps independent rounded optics across clear/soft, rapid resize and retained-page return',async()=>{
      await navigate(android)
      for(const theme of ['dark','light']) for(const blur of [0,6]) {
        await evaluate(`qa.render({overview:true,rendering:"detailed",width:280.25,height:400.25,blur:${blur},theme:${JSON.stringify(theme)}});true`);await delay(260)
        await capture('overview-'+theme+'-'+blur+'-initial')
        for(const height of [420.5,400.25,430.75]) {await evaluate(`qa.render({height:${height}});true`);await delay(25)}
        await evaluate('qa.render({sampling:false,height:410.5});true');await delay(130)
        const inactive=await snapshot('overview-inactive-'+blur);assert.equal(inactive.backdrop,'none')
        const encoded=inactive.encodes.length
        await evaluate('qa.render({height:440.75});true');await delay(130)
        assert.equal((await snapshot('overview-inactive-resize-'+blur)).encodes.length,encoded)
        await evaluate('qa.render({sampling:true});true');await delay(30)
        const state=await snapshot('overview-return-'+blur)
        assert.deepEqual(state.imageSize,['280.25','440.75']);assert.equal(state.scale,'28');assert.equal(state.blur,String(blur))
        // Decode the map actually attached to feImage. Its centre must be
        // neutral, not an obsolete scene/slot image; source displacement is
        // bounded to +/-14px per axis by the real SVG scale.
        const map=await evaluate(`(async()=>{const image=document.querySelector('feImage'),bitmap=await createImageBitmap(await (await fetch(image.getAttribute('href'))).blob()),c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);return{width:c.width,height:c.height,centre:[...ctx.getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data]}})()`)
        assert.deepEqual(map,{width:280,height:441,centre:[128,128,128,255]})
        const material=await evaluate(`(()=>{const e=document.querySelector('.pl-capacity'),c=getComputedStyle(e);return{border:c.borderTopWidth,outline:c.outlineStyle,ancestorFilters:[...document.querySelectorAll('.planner,.pl-overview,.pl-glass-content')].map(e=>({filter:getComputedStyle(e).filter,backdrop:getComputedStyle(e).backdropFilter,opacity:getComputedStyle(e).opacity}))}})()`)
        evidence.push({name:'overview-material-'+theme+'-'+blur,map,...material})
        assert.equal(material.border,'0px');assert.equal(material.outline,'none')
        await capture('overview-'+theme+'-'+blur+'-returned')
      }
    })
    assert.deepEqual(errors,[],'no React or page exceptions')
  } finally {
    if (output) {
      const surfacePath=process.env.GLASS_QA_SURFACE??join(root,'src/home/GlassSurface.tsx')
      const source=Object.fromEntries(await Promise.all([surfacePath,join(root,'src/home/glassRendering.ts'),join(root,'src/home/home.css'),import.meta.filename].map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')])))
      await writeFile(join(output,'state-transitions.json'),JSON.stringify({scope:'Mac Chromium isolated React fixture; UA routing is not native WebKit/Android evidence',status:checks.some(c=>c.status==='failed')||errors.length?'failed':'passed',source,checks,errors,evidence},null,2))
    }
    ws?.close();chrome?.kill()
    for(const p of pending.values())clearTimeout(p.timer)
    await server?.close();await delay(150)
    await rm(temporary,{recursive:true,force:true,maxRetries:3,retryDelay:100})
  }
})
