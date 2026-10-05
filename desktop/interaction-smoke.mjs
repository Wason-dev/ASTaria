import { app, contentTracing } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Opt-in diagnostics inside the launcher's disposable database/profile only.
// Collect actual renderer frames, not just RAF callbacks or idle averages.
export async function measureDesktopInteractions(window, directory) {
  const evaluate = script => window.webContents.executeJavaScript(script)
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  const wasAlwaysOnTop = window.isAlwaysOnTop()
  window.show(); window.focus(); window.maximize()
  await delay(1500)
  const devtools = window.webContents.debugger
  devtools.attach('1.3')
  await devtools.sendCommand('Performance.enable')
  const graphics = await evaluate(`(() => {
    const engine=window.__ASTARIA_P0__, gl=engine.renderer.getContext(), info=gl.getExtension('WEBGL_debug_renderer_info');
    return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,renderer:info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):null};
  })()`)
  const gpu = await app.getGPUInfo('basic')
  await evaluate(`(() => {
    const engine=window.__ASTARIA_P0__,gl=engine.renderer.getContext(),timer=gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const probe=window.__interactionProbe={active:false,frames:[],raf:[],longTasks:[],encodes:[],gpu:[],pending:[],start:0,errors:[]};
    window.addEventListener('error',e=>probe.errors.push(e.message));
    const original=engine.frame;
    const originalDraw=engine.renderer.render;
    engine.renderer.render=function(...args){
      if(probe.active&&probe.measuring&&timer&&!probe.currentQuery){probe.currentQuery=gl.createQuery();gl.beginQuery(timer.TIME_ELAPSED_EXT,probe.currentQuery)}
      return originalDraw.apply(this,args);
    };
    engine.frame=(now)=>{
      const before=engine.renderedFrames,start=performance.now();
      probe.measuring=true;probe.currentQuery=null;
      try {original(now)} finally {
        probe.measuring=false;
        if(probe.currentQuery){gl.endQuery(timer.TIME_ELAPSED_EXT);probe.pending.push({query:probe.currentQuery,at:now-probe.start});}
        if(probe.active&&engine.renderedFrames!==before)probe.frames.push({at:now-probe.start,cpu:performance.now()-start,zoom:engine.getCameraSnapshot().zoom});
      }
    };
    const originalEncode=HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL=function(...args){const start=performance.now();const result=originalEncode.apply(this,args);if(probe.active)probe.encodes.push({at:start-probe.start,ms:performance.now()-start,width:this.width,height:this.height});return result};
    new PerformanceObserver(list=>{if(probe.active)probe.longTasks.push(...list.getEntries().filter(e=>e.startTime>=probe.start).map(e=>({at:e.startTime-probe.start,ms:e.duration}))) }).observe({type:'longtask',buffered:false});
    function tick(t){
      if(probe.active)probe.raf.push(t-probe.start);
      if(timer&&probe.pending.length){
        const disjoint=gl.getParameter(timer.GPU_DISJOINT_EXT);
        while(probe.pending.length&&gl.getQueryParameter(probe.pending[0].query,gl.QUERY_RESULT_AVAILABLE)){
          const item=probe.pending.shift();if(!disjoint)probe.gpu.push({at:item.at,ms:gl.getQueryParameter(item.query,gl.QUERY_RESULT)/1e6});gl.deleteQuery(item.query);
        }
      }
      requestAnimationFrame(tick);
    }requestAnimationFrame(tick);
  })()`)
  const navScript = page => `(() => {const menu=document.querySelector('#home-menu');if(menu.inert)document.querySelector('.home-brand').click();const button=[...menu.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(page)});if(!button)throw Error('Missing navigation');button.click()})()`
  const metrics = async () => Object.fromEntries((await devtools.sendCommand('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]))
  const distribution = values => {
    const sorted = [...values].sort((a,b)=>a-b), at = q => sorted[Math.max(0,Math.ceil(sorted.length*q)-1)] ?? 0
    return { count:sorted.length,p50:at(.5),p95:at(.95),p99:at(.99),max:at(1),over25:sorted.filter(v=>v>25).length,over50:sorted.filter(v=>v>50).length }
  }
  const gaps = times => times.slice(1).map((value,index)=>value-times[index])
  const measurements=[]
  const rounds = process.argv.includes('--interaction-repeat') ? 2 : 1
  const trace = process.argv.includes('--trace-interactions')
  if (trace) await contentTracing.startRecording({ included_categories: ['devtools.timeline', 'blink', 'cc', 'gpu', 'viz', 'toplevel'], recording_mode: 'record-until-full' })
  const configs = process.argv.includes('--interaction-quick') ? [['dark','clear','auto','full']] : [
    ['dark','clear','auto','full'],['light','soft','auto','full'],['dark','clear','detailed','full'],['dark','clear','auto','smooth120'],
  ]
  try {
    // Native occlusion intentionally suspends rendering. Keep only this opt-in
    // diagnostic window visible so another app cannot invalidate its samples;
    // never disable production background throttling or power-saving policy.
    window.setAlwaysOnTop(true)
    for(let round=1;round<=rounds;round++) for(const [theme,glass,optics,profile] of configs){
      window.show();window.moveTop();window.focus()
      await evaluate(`(async()=>{const headers={'Content-Type':'application/json','X-Astaria-Local':'1'},expected=await fetch('/api/preferences',{headers}).then(r=>r.json());const response=await fetch('/api/preferences',{method:'POST',headers,body:JSON.stringify({expected,value:{...expected,theme:${JSON.stringify(theme)},glass:${JSON.stringify(glass)},render:{profile:${JSON.stringify(profile)},quality:'ultra',glass:${JSON.stringify(optics)}},effect:{...expected.effect,motion:'full'}}})});if(!response.ok)throw Error('Preferences failed');window.dispatchEvent(new CustomEvent('astaria-preferences-change',{detail:await response.json()}));})()`)
      await evaluate(navScript('首页'));await delay(3000)
      const cases=[['chat-open',`document.querySelector('.home-launch').click()`],['chat-close',`document.querySelector('.home-collapse').click()`],['home-workbench',navScript('工作台')],['workbench-free-time',navScript('余时')],['free-time-home',navScript('首页')]]
      for(const [name,action] of cases){
        const before=await metrics()
        const cpuProfile=process.argv.includes('--profile-interactions')
        if(cpuProfile){await devtools.sendCommand('Profiler.enable');await devtools.sendCommand('Profiler.start')}
        await evaluate(`(()=>{const p=window.__interactionProbe;p.frames=[];p.raf=[];p.longTasks=[];p.encodes=[];p.gpu=[];p.start=performance.now();p.active=true;${action};return true})()`)
        await delay(name.startsWith('chat')?3600:1600)
        const raw=await evaluate(`(()=>{const p=window.__interactionProbe;p.active=false;return {frames:p.frames,raf:p.raf,longTasks:p.longTasks,encodes:p.encodes,gpu:p.gpu,errors:p.errors,elapsed:performance.now()-p.start,stats:window.__ASTARIA_P0__.getSnapshot(),camera:window.__ASTARIA_P0__.getCameraSnapshot(),morph:document.querySelector('.home-morph').getAttribute('style')}})()`)
        if(cpuProfile){const result=await devtools.sendCommand('Profiler.stop');await writeFile(join(directory,`${round}-${theme}-${glass}-${optics}-${profile}-${name}.cpuprofile`),JSON.stringify(result.profile))}
        const after=await metrics()
        const expectedTarget = profile === 'smooth120' && !['home-workbench','workbench-free-time'].includes(name) ? 120 : 60
        if(raw.stats.targetFps!==expectedTarget||raw.stats.renderProfile!==profile)throw Error(`Power policy regression: ${name}, selected ${profile}, target ${raw.stats.targetFps}, expected ${expectedTarget}`)
        const row={round,name,theme,glass,optics,profile,elapsed:raw.elapsed,firstFrameMs:Math.max(0,raw.frames[0]?.at??raw.elapsed),render:distribution(gaps(raw.frames.map(v=>v.at))),firstSecond:distribution(gaps(raw.frames.filter(v=>v.at<=1000).map(v=>v.at))),raf:distribution(gaps(raw.raf)),cpu:distribution(raw.frames.map(v=>v.cpu)),gpu:distribution(raw.gpu.map(v=>v.ms)),longTasks:raw.longTasks,encodeCount:raw.encodes.length,encodeMs:raw.encodes.reduce((a,b)=>a+b.ms,0),metrics:Object.fromEntries(['LayoutDuration','RecalcStyleDuration','ScriptDuration','TaskDuration','LayoutCount','RecalcStyleCount'].map(key=>[key,after[key]-before[key]])),quality:raw.stats.quality,width:raw.stats.width,height:raw.stats.height,errors:raw.errors}
        if(raw.stats.quality!=='ultra'||raw.errors.length||raw.frames.length<2)throw Error(`Interaction acceptance failed: ${JSON.stringify(row)}`)
        row.targetFps=raw.stats.targetFps
        measurements.push(row)
        await writeFile(join(directory,`${round}-${theme}-${glass}-${optics}-${profile}-${name}.json`),JSON.stringify(raw))
        console.log('ASTARIA_INTERACTION_SAMPLE',JSON.stringify(row))
        await delay(700)
      }
    }
    const report={graphics,gpu,features:app.getGPUFeatureStatus(),measurements,checkedAt:new Date().toISOString()}
    await writeFile(join(directory,'interactions.json'),JSON.stringify(report,null,2))
    console.log('ASTARIA_INTERACTION_REPORT',join(directory,'interactions.json'))
  } finally {
    window.setAlwaysOnTop(wasAlwaysOnTop)
    if (trace) console.log('ASTARIA_INTERACTION_TRACE', await contentTracing.stopRecording(join(directory, 'interactions-trace.json')))
    devtools.detach()
  }
}
