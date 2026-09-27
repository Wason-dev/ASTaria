/** Isolated Chrome 9233: render-time injection tests long-session flow without waiting hours. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const output = new URL('../artifacts/flow/', import.meta.url)
await fs.mkdir(new URL('screenshots/', output), { recursive: true })
const target = (await fetch('http://127.0.0.1:9233/json').then(r => r.json())).find(t => t.type === 'page')
assert.ok(target, 'A dedicated temporary Chrome on port 9233 is required')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let serial = 0
const pending = new Map(), errors = [], checks = []
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params)
  if (!m.id) return
  const p = pending.get(m.id); pending.delete(m.id)
  if (m.error) p.reject(m.error); else p.resolve(m.result)
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  pending.set(++serial, { resolve, reject }); ws.send(JSON.stringify({ id: serial, method, params }))
})
const ev = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const wait = async expression => { for (let i = 0; i < 150; i++) { if (await ev(expression)) return; await sleep(100) } throw new Error(`Timeout: ${expression}`) }
const check = (name, pass, details) => { checks.push({ name, pass, details }); assert.ok(pass, name) }
const shot = async name => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  await fs.writeFile(new URL(`screenshots/${name}.png`, output), Buffer.from(r.data, 'base64'))
}
const setTime = time => ev(`new Promise(resolve=>{const e=window.__ASTARIA_P0__;e.simulationTime=${time};e.setNight(e.night,true);requestAnimationFrame(()=>resolve(true))})`)
const frame = async time => {
  await setTime(time)
  return ev(`(()=>{const e=window.__ASTARIA_P0__,r=e.resolution,p=new Uint8Array(r.x*r.y*4);e.renderer.readRenderTargetPixels(e.sceneTarget,0,0,r.x,r.y,p);const out=[];for(let y=0;y<r.y;y+=8)for(let x=0;x<r.x;x+=8){let i=(y*r.x+x)*4;out.push(p[i],p[i+1],p[i+2])}return out})()`)
}
const diff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length
let failure, performanceSamples
try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Network.setBypassServiceWorker', { bypass: true }); await send('Network.setCacheDisabled', { cacheDisabled: true })
  await send('Emulation.setEmulatedMedia', { features: [] })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false })
  await send('Page.navigate', { url: process.env.HOME_TEST_URL ?? 'http://127.0.0.1:5188/' })
  await wait('!!window.__ASTARIA_P0__')
  await ev(`document.querySelector('.home-workspace').style.display='none';window.__ASTARIA_P0__.setQuality('ultra');window.__ASTARIA_P0__.setPaused(true);window.__ASTARIA_P0__.setView('interstellar')`)
  await wait('!window.__ASTARIA_P0__.getSnapshot().cameraTransition')
  const preset = await ev('window.__ASTARIA_P0__.getSnapshot()')
  check('interstellar preset remains frozen', preset.zoom === 2.05 && preset.roll === 7 && preset.inclination === 84 && preset.centerX === .98 && preset.centerY === .51, preset)
  check('higher precision path table is active', await ev('window.__ASTARIA_P0__.geodesicsTexture.image.width===2048&&window.__ASTARIA_P0__.geodesicsTexture.image.height===1536'))
  const first = await frame(3), second = await frame(5), hours = await frame(7203), hoursNext = await frame(7205)
  check('disk visibly changes both at startup and after two simulated hours', diff(first, second) > .05 && diff(hours, hoursNext) > .05, { earlyMeanChannelChange: diff(first, second), lateMeanChannelChange: diff(hours, hoursNext) })
  check('long sessions preserve the original bounded stream detail', diff(first, hours) < 1, { meanChannelDifference: diff(first, hours), note: 'Sky positions continue to drift; disk phase repeats without accumulating shear' })
  for (const time of [12, 24, 36, 48, 7200]) {
    const before = await frame(time - 1/120), after = await frame(time + 1/120)
    check(`flow is continuous across ${time}s`, diff(before, after) < .5, { meanChannelDifference: diff(before, after) })
  }
  for (const time of [3, 18, 30, 7203]) { await setTime(time); await shot(`interstellar-${time}s`) }
  await ev('window.__ASTARIA_P0__.setNight(0,true)'); await setTime(7218); await shot('day-interstellar')
  await ev('window.__ASTARIA_P0__.setView("panorama");window.__ASTARIA_P0__.setNight(1,true)')
  await wait('!window.__ASTARIA_P0__.getSnapshot().cameraTransition')
  const panorama = await ev('window.__ASTARIA_P0__.getSnapshot()')
  check('panorama preset remains frozen', panorama.zoom === .7 && panorama.roll === 18 && panorama.inclination === 83 && panorama.centerX === .65 && panorama.centerY === .51)
  await shot('panorama-retina')
  await ev('window.__ASTARIA_P0__.setView("interstellar")')
  await wait('!window.__ASTARIA_P0__.getSnapshot().cameraTransition')
  await ev('window.__ASTARIA_P0__.simulationTime=12;window.__ASTARIA_P0__.setQuality("auto");window.__ASTARIA_P0__.setPaused(false)')
  performanceSamples = []
  for(let i=0;i<6;i++){await sleep(5000);performanceSamples.push(await ev('window.__ASTARIA_P0__.getSnapshot()'))}
  check('continuous animation clock advances in a visible tab', performanceSamples.at(-1).simulationTime - performanceSamples[0].simulationTime > 20 && performanceSamples.every(s => !s.paused && !s.visibilityPaused))
  await send('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion',value:'reduce'}] }); await sleep(100)
  const stopped = await ev('window.__ASTARIA_P0__.getSnapshot()'); await sleep(200)
  check('reduced motion still stops ambient animation', stopped.reducedMotion && stopped.simulationTime === await ev('window.__ASTARIA_P0__.getSnapshot().simulationTime'))
  check('no browser exceptions', errors.length === 0, errors)
} catch (e) { failure = String(e); throw e } finally {
  await send('Emulation.setEmulatedMedia', { features: [] })
  await fs.writeFile(new URL('browser-checks.json', output), JSON.stringify({ checks, performanceSamples, failure, limitation: 'Isolated Chrome compositor measurements; simulated timestamps are not a two-hour endurance test or physical display scanout measurement' }, null, 2))
  console.log(JSON.stringify({ passed: checks.filter(c=>c.pass).length, failure, performanceSamples }, null, 2))
  ws.close()
}
