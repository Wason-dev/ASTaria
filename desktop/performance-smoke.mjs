import { app } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Only invoked inside --smoke-test's disposable profile/database. This reports
// actual hardware/cadence; it never infers GPU acceleration from WebGL support.
export async function measureDesktopPerformance(window, directory) {
  const evaluate = script => window.webContents.executeJavaScript(script)
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  window.show(); window.focus(); window.maximize()
  const gpu = await app.getGPUInfo('basic')
  const graphics = await evaluate(`(() => {
    const gl = document.createElement('canvas').getContext('webgl2'), debug = gl?.getExtension('WEBGL_debug_renderer_info');
    const result = { renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null, width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
    gl?.getExtension('WEBGL_lose_context')?.loseContext(); return result;
  })()`)
  const measurements = []
  for (const [theme, glass, optics] of [['dark', 'clear', 'auto'], ['light', 'soft', 'auto'], ['dark', 'clear', 'detailed']]) {
    await evaluate(`(async () => {
      const headers = {'Content-Type':'application/json','X-Astaria-Local':'1'};
      const expected = await fetch('/api/preferences',{headers}).then(r=>r.json());
      const value = {...expected,theme:${JSON.stringify(theme)},glass:${JSON.stringify(glass)},render:{profile:'full',quality:'ultra',glass:${JSON.stringify(optics)}}};
      const response = await fetch('/api/preferences',{method:'POST',headers,body:JSON.stringify({expected,value})});
      if(!response.ok)throw Error('Performance fixture preferences failed');
      window.dispatchEvent(new CustomEvent('astaria-preferences-change',{detail:await response.json()}));
    })()`)
    for (const page of ['首页', '工作台', '余时']) {
      await evaluate(`(() => {
        const brand=document.querySelector('.home-brand');
        if(document.querySelector('#home-menu').inert)brand.click();
        const target=[...document.querySelectorAll('#home-menu button')].find(e=>e.textContent.trim()===${JSON.stringify(page)});
        if(!target)throw Error('Missing navigation');target.click();return true;
      })()`)
      await delay(2500)
      const result = await evaluate(`new Promise(resolve => {
        const frames=[],longTasks=[],start=performance.now(),before=window.__ASTARIA_P0__.getSnapshot();let last=start;
        const observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(e=>e.duration)));
        observer.observe({type:'longtask',buffered:false});
        function tick(t){frames.push(t-last);last=t;if(t-start<8000){requestAnimationFrame(tick);return}
          observer.disconnect();const after=window.__ASTARIA_P0__.getSnapshot();frames.sort((a,b)=>a-b);
          resolve({seconds:(t-start)/1000,rafFps:frames.length*1000/(t-start),renderFps:(after.renderedFrames-before.renderedFrames)*1000/(t-start),p50:frames[Math.floor(frames.length*.5)],p95:frames[Math.floor(frames.length*.95)],over50:frames.filter(x=>x>50).length,longTasks,quality:after.quality,width:after.width,height:after.height,backdrops:[...document.querySelectorAll('.home-glass-surface')].map(e=>getComputedStyle(e).backdropFilter).filter(v=>v!=='none')});
        }requestAnimationFrame(tick);
      })`)
      measurements.push({ page, theme, glass, optics, ...result })
      console.log('ASTARIA_PERFORMANCE_SAMPLE', JSON.stringify(measurements.at(-1)))
      await writeFile(join(directory, `performance-${theme}-${glass}-${optics}-${measurements.length}.png`), (await window.webContents.capturePage()).toPNG())
    }
  }
  const report = { graphics, gpu, features: app.getGPUFeatureStatus(), measurements, checkedAt: new Date().toISOString() }
  await writeFile(join(directory, 'performance.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log('ASTARIA_PERFORMANCE_REPORT', join(directory, 'performance.json'))
}
