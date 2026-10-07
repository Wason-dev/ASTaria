import { app, contentTracing } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Opt-in diagnostics inside the launcher's disposable database/profile only.
// Collect actual renderer frames, not just RAF callbacks or idle averages.
export async function measureDesktopInteractions(window, directory) {
  const evaluate = script => window.webContents.executeJavaScript(script)
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  const wasAlwaysOnTop = window.isAlwaysOnTop()
  if (process.argv.includes('--chat-readiness-only')) {
    window.setAlwaysOnTop(true)
    try { await verifyChatReadiness(window, directory) }
    finally { window.setAlwaysOnTop(wasAlwaysOnTop) }
    return
  }
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
  const profileGpuPasses = process.argv.includes('--gpu-pass-breakdown')
  await evaluate(`(() => {
    const engine=window.__ASTARIA_P0__,gl=engine.renderer.getContext(),timer=gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const probe=window.__interactionProbe={active:false,frames:[],raf:[],longTasks:[],encodes:[],gpu:[],pending:[],passes:[],pendingPasses:[],start:0,errors:[],readiness:{}};
    const passBreakdown=${profileGpuPasses};
    window.addEventListener('error',e=>probe.errors.push(e.message));
    const original=engine.frame;
    const originalDraw=engine.renderer.render;
    engine.renderer.render=function(...args){
      if(probe.active&&probe.measuring&&timer&&passBreakdown){
        const material=engine.bloom.quad.material;
        const stage=args[0]===engine.scene?'scene':args[0]===engine.starScene?'stars':material===engine.bloom.prefilter?'bloom-prefilter':material===engine.bloom.blur?'bloom-blur':material===engine.bloom.composite?'composite':'other';
        const query=gl.createQuery();gl.beginQuery(timer.TIME_ELAPSED_EXT,query);
        try{return originalDraw.apply(this,args)}finally{gl.endQuery(timer.TIME_ELAPSED_EXT);probe.pendingPasses.push({query,stage,at:performance.now()-probe.start})}
      }
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
      if(probe.active&&probe.action==='chat-open'){
        const camera=engine.getCameraSnapshot(),input=document.querySelector('#home-compose');
        if((camera.zoom-.7)/(2.05-.7)>=.99&&probe.readiness.geometryReadyMs===undefined)probe.readiness.geometryReadyMs=t-probe.start;
        if(input&&!input.closest('[inert]')&&probe.readiness.interactiveMs===undefined)probe.readiness.interactiveMs=t-probe.start;
        if(input===document.activeElement&&probe.readiness.focusMs===undefined)probe.readiness.focusMs=t-probe.start;
        if(!camera.cameraTransition&&probe.readiness.settledMs===undefined)probe.readiness.settledMs=t-probe.start;
      }
      if(timer&&probe.pending.length){
        const disjoint=gl.getParameter(timer.GPU_DISJOINT_EXT);
        while(probe.pending.length&&gl.getQueryParameter(probe.pending[0].query,gl.QUERY_RESULT_AVAILABLE)){
          const item=probe.pending.shift();if(!disjoint)probe.gpu.push({at:item.at,ms:gl.getQueryParameter(item.query,gl.QUERY_RESULT)/1e6});gl.deleteQuery(item.query);
        }
      }
      if(timer&&probe.pendingPasses.length){
        const disjoint=gl.getParameter(timer.GPU_DISJOINT_EXT);
        while(probe.pendingPasses.length&&gl.getQueryParameter(probe.pendingPasses[0].query,gl.QUERY_RESULT_AVAILABLE)){
          const item=probe.pendingPasses.shift();if(!disjoint)probe.passes.push({stage:item.stage,at:item.at,ms:gl.getQueryParameter(item.query,gl.QUERY_RESULT)/1e6});gl.deleteQuery(item.query);
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
        await evaluate(`(()=>{const p=window.__interactionProbe;p.frames=[];p.raf=[];p.longTasks=[];p.encodes=[];p.gpu=[];p.passes=[];p.readiness={};p.action=${JSON.stringify(name)};p.start=performance.now();p.active=true;${action};return true})()`)
        await delay(name.startsWith('chat')?3600:1600)
        const raw=await evaluate(`(()=>{const p=window.__interactionProbe;p.active=false;return {frames:p.frames,raf:p.raf,longTasks:p.longTasks,encodes:p.encodes,gpu:p.gpu,passes:p.passes,readiness:p.readiness,errors:p.errors,elapsed:performance.now()-p.start,stats:window.__ASTARIA_P0__.getSnapshot(),camera:window.__ASTARIA_P0__.getCameraSnapshot(),morph:document.querySelector('.home-morph').getAttribute('style'),visibility:{hidden:document.hidden,focus:document.hasFocus(),windowState:window.__ASTARIA_P0__.getSnapshot().visibilityPaused}}})()`)
        if(cpuProfile){const result=await devtools.sendCommand('Profiler.stop');await writeFile(join(directory,`${round}-${theme}-${glass}-${optics}-${profile}-${name}.cpuprofile`),JSON.stringify(result.profile))}
        const after=await metrics()
        const expectedTarget = profile === 'smooth120' && !['home-workbench','workbench-free-time'].includes(name) ? 120 : 60
        if(raw.stats.targetFps!==expectedTarget||raw.stats.renderProfile!==profile)throw Error(`Power policy regression: ${name}, selected ${profile}, target ${raw.stats.targetFps}, expected ${expectedTarget}`)
        const passGroups=Object.groupBy(raw.passes,pass=>pass.stage)
        const row={round,name,theme,glass,optics,profile,elapsed:raw.elapsed,firstFrameMs:Math.max(0,raw.frames[0]?.at??raw.elapsed),render:distribution(gaps(raw.frames.map(v=>v.at))),firstSecond:distribution(gaps(raw.frames.filter(v=>v.at<=1000).map(v=>v.at))),raf:distribution(gaps(raw.raf)),cpu:distribution(raw.frames.map(v=>v.cpu)),gpu:distribution(raw.gpu.map(v=>v.ms)),gpuPasses:Object.fromEntries(Object.entries(passGroups).map(([stage,passes])=>[stage,distribution(passes.map(pass=>pass.ms))])),longTasks:raw.longTasks,encodeCount:raw.encodes.length,encodeMs:raw.encodes.reduce((a,b)=>a+b.ms,0),metrics:Object.fromEntries(['LayoutDuration','RecalcStyleDuration','ScriptDuration','TaskDuration','LayoutCount','RecalcStyleCount'].map(key=>[key,after[key]-before[key]])),quality:raw.stats.quality,width:raw.stats.width,height:raw.stats.height,errors:raw.errors}
        if(raw.stats.quality!=='ultra'||raw.errors.length||raw.frames.length<2){
          await writeFile(join(directory,`${round}-${theme}-${glass}-${optics}-${profile}-${name}-failed.json`),JSON.stringify(raw))
          await writeFile(join(directory,'interactions-partial.json'),JSON.stringify({graphics,gpu,features:app.getGPUFeatureStatus(),measurements,failed:row,visibility:raw.visibility},null,2))
          throw Error(`Interaction acceptance failed: ${JSON.stringify({...row,visibility:raw.visibility})}`)
        }
        row.targetFps=raw.stats.targetFps
        if(name==='chat-open')row.chatReadiness={...raw.readiness,extraWaitMs:raw.readiness.interactiveMs===undefined||raw.readiness.geometryReadyMs===undefined?null:Math.max(0,raw.readiness.interactiveMs-raw.readiness.geometryReadyMs)}
        measurements.push(row)
        await writeFile(join(directory,`${round}-${theme}-${glass}-${optics}-${profile}-${name}.json`),JSON.stringify(raw))
        console.log('ASTARIA_INTERACTION_SAMPLE',JSON.stringify(row))
        await delay(700)
      }
    }
    const report={graphics,gpu,features:app.getGPUFeatureStatus(),measurements,checkedAt:new Date().toISOString()}
    await writeFile(join(directory,'interactions.json'),JSON.stringify(report,null,2))
    console.log('ASTARIA_INTERACTION_REPORT',join(directory,'interactions.json'))
    if (process.argv.includes('--verify-chat-readiness')) await verifyChatReadiness(window, directory)
  } finally {
    window.setAlwaysOnTop(wasAlwaysOnTop)
    if (trace) console.log('ASTARIA_INTERACTION_TRACE', await contentTracing.stopRecording(join(directory, 'interactions-trace.json')))
    devtools.detach()
  }
}

async function verifyChatReadiness(window, directory) {
  const evaluate = script => window.webContents.executeJavaScript(script)
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  const devtools = window.webContents.debugger
  const ownsDebugger = !devtools.isAttached()
  if (ownsDebugger) devtools.attach('1.3')
  const rows = []
  const configurations = [
    ['dark', 'clear', 'full', false], ['dark', 'soft', 'full', false],
    ['light', 'clear', 'full', false], ['light', 'soft', 'full', false],
    ['dark', 'clear', 'reduced', false], ['dark', 'clear', 'system', true],
  ]
  const waitFor = async predicate => evaluate(`(async () => {
    const start = performance.now();
    while (!(${predicate})) {
      if (performance.now() - start > 8000) throw Error('Chat interaction timed out: ' + ${JSON.stringify(predicate)});
      await new Promise(resolve => setTimeout(resolve, 8));
    }
    const camera = window.__ASTARIA_P0__.getCameraSnapshot();
    return { elapsed: performance.now() - start, transition: camera.cameraTransition, reducedMotion: camera.reducedMotion };
  })()`)
  const inputReady = `document.activeElement === document.querySelector('#home-compose') && !document.activeElement.closest('[inert]')`
  const launchReady = `document.activeElement === document.querySelector('.home-launch') && !document.activeElement.closest('[inert]')`
  const click = async selector => {
    const position = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)}), rect = element.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      if (element.closest('[inert]') || !element.contains(document.elementFromPoint(x, y))) throw Error('Chat control is not clickable');
      return { x: Math.round(x), y: Math.round(y) };
    })()`)
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...position })
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...position })
  }
  const escape = () => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  }
  try {
  for (const [theme, glass, motion, systemReducedMotion] of configurations) {
    await devtools.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: systemReducedMotion ? 'reduce' : 'no-preference' }] })
    await waitFor(`window.__ASTARIA_P0__.getCameraSnapshot().reducedMotion === ${systemReducedMotion}`)
    const smallerWindow = motion !== 'full'
    window.unmaximize(); window.setSize(smallerWindow ? 1024 : 1200, smallerWindow ? 720 : 820)
    window.show(); window.moveTop(); window.focus()
    await evaluate(`(async () => {
      const headers = { 'Content-Type': 'application/json', 'X-Astaria-Local': '1' };
      const expected = await fetch('/api/preferences', { headers }).then(r => r.json());
      const response = await fetch('/api/preferences', { method: 'POST', headers, body: JSON.stringify({ expected,
        value: { ...expected, theme: ${JSON.stringify(theme)}, glass: ${JSON.stringify(glass)},
          render: { profile: 'full', quality: 'ultra', glass: 'auto' }, effect: { ...expected.effect, motion: ${JSON.stringify(motion)} } } }) });
      if (!response.ok) throw Error('Chat interaction preferences failed');
      window.dispatchEvent(new CustomEvent('astaria-preferences-change', { detail: await response.json() }));
      if (document.querySelector('#home-menu').inert) document.querySelector('.home-brand').click();
      [...document.querySelectorAll('#home-menu button')].find(button => button.textContent.trim() === '首页').click();
    })()`)
    await waitFor(`!document.querySelector('.home-launch').closest('[inert]') && getComputedStyle(document.querySelector('.home-launch')).visibility === 'visible'`)
    await waitFor(`!window.__ASTARIA_P0__.getCameraSnapshot().cameraTransition`)
    const originalDraft = await evaluate(`document.querySelector('#home-compose').value`)
    await click('.home-launch')
    const ready = await waitFor(inputReady)
    if (ready.transition === systemReducedMotion) throw Error(systemReducedMotion ? 'System reduced motion still animates the camera' : 'Chat still waits for the spring to settle')
    window.webContents.sendInputEvent({ type: 'char', keyCode: 'Z' })
    const typed = await waitFor(`document.querySelector('#home-compose').value === ${JSON.stringify(originalDraft + 'Z')}`)
    if (typed.transition === systemReducedMotion) throw Error('Chat input missed the expected camera state')
    await click('.home-collapse')
    const collapsed = await waitFor(launchReady)
    if (collapsed.transition === systemReducedMotion) throw Error(systemReducedMotion ? 'System reduced motion still animates collapse' : 'Collapsed focus still waits for the spring to settle')
    // Reopen while the closing spring is still running, then interrupt early.
    await click('.home-launch')
    await delay(100)
    escape()
    await waitFor(launchReady)
    await click('.home-launch')
    await waitFor(inputReady)
    const retainedDraft = await evaluate(`document.querySelector('#home-compose').value`)
    if (retainedDraft !== originalDraft + 'Z') throw Error('Chat reversal lost the draft')
    escape()
    await waitFor(launchReady)
    await click('.home-launch')
    await delay(100)
    await evaluate(`(() => {
      if (document.querySelector('#home-menu').inert) document.querySelector('.home-brand').click();
      [...document.querySelectorAll('#home-menu button')].find(button => button.textContent.trim() === '工作台').click();
    })()`)
    await delay(3300)
    const state = await evaluate(`(() => {
      const input = document.querySelector('#home-compose'), engine = window.__ASTARIA_P0__;
      return { page: document.querySelector('.home-workspace').dataset.page,
        inputInert: !!input.closest('[inert]'), focusInChat: !!document.activeElement.closest('#home-xixi'),
        draft: input.value, quality: engine.getSnapshot().quality, targetFps: engine.getSnapshot().targetFps,
        width: innerWidth, height: innerHeight };
    })()`)
    if (state.page !== 'workbench' || !state.inputInert || state.focusInChat || state.draft !== retainedDraft
      || state.quality !== 'ultra' || state.targetFps !== 60) throw Error('Chat navigation state failed: ' + JSON.stringify(state))
    rows.push({ theme, glass, motion, systemReducedMotion, ready, typed, collapsed, typedBeforeSettling: typed.transition, reversal: true, ...state })
    await writeFile(join(directory, 'chat-readiness.json'), JSON.stringify(rows, null, 2))
  }
  } finally {
    try { await devtools.sendCommand('Emulation.setEmulatedMedia', { features: [] }) }
    finally { if (ownsDebugger) devtools.detach() }
  }
  console.log('ASTARIA_CHAT_READINESS_PASSED', JSON.stringify(rows))
}
