/** Dedicated test Chrome only: --remote-debugging-port=9227 with a temporary profile. */
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'

const root = new URL('../artifacts/actual-functionality/', import.meta.url)
const url = process.env.SPATIAL_URL ?? 'http://127.0.0.1:5188/'
const targets = await fetch('http://127.0.0.1:9227/json').then(response => response.json())
const target = targets.find(item => item.type === 'page')
if (!target) throw new Error('Start a dedicated test Chrome on port 9227.')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
let serial = 0
const pending = new Map(), errors = [], checks = []
socket.onmessage = event => {
  const result = JSON.parse(event.data)
  if (result.id) {
    const callback = pending.get(result.id)
    pending.delete(result.id)
    if (result.error) callback.reject(result.error)
    else callback.resolve(result.result)
  } else if (result.method === 'Runtime.exceptionThrown') errors.push(result.params)
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const wait = async expression => {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await evaluate(expression)) return
    await delay(100)
  }
  throw new Error(`Timeout: ${expression}`)
}
const check = async (name, expression) => {
  const pass = await evaluate(expression)
  checks.push({ name, pass })
  assert.equal(pass, true, name)
}
const click = async selector => {
  const point = await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw Error('Missing element'); const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await delay(60)
}
const text = async (selector, value) => {
  await click(selector)
  await send('Input.insertText', { text: value })
}
const key = async (key, code = key, modifiers = 0) => {
  const windowsVirtualKeyCode = { Enter: 13, Escape: 27, Tab: 9, d: 68 }[key] ?? 0
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode, ...(key === 'Enter' ? { text: '\r' } : {}) })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode })
  await delay(50)
}
const screenshot = async name => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 880 })
  await delay(350)
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await fs.writeFile(new URL(`screenshots/${name}.png`, root), Buffer.from(data, 'base64'))
}
const database = expression => evaluate(`(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('astaria-local');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});try{return await (${expression})(db)}finally{db.close()}})()`)
const allRows = () => database(`db=>new Promise((resolve,reject)=>{const r=db.transaction('tasks').objectStore('tasks').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})`)

try {
  await fs.mkdir(new URL('screenshots/', root), { recursive: true })
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Network.setBypassServiceWorker', { bypass: true })
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  await send('Emulation.setEmulatedMedia', { features: [] })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  // Clears this temporary profile's test origin, never the user's browser profile.
  await send('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'indexeddb' })
  await send('Page.navigate', { url })
  await wait('!!window.__ASTARIA_P0__ && !!document.querySelector(".spatial-launch:not(:disabled)")')
  await delay(1800)
  await check('opens in immersive view without a form', 'document.querySelector(".spatial-ui").dataset.density === "immersive" && !document.querySelector("dialog")')
  await evaluate('window.__ASTARIA_P0__.setPaused(true)')
  await screenshot('immersive-1440')
  const before = await evaluate('window.__ASTARIA_P0__.getSnapshot()')
  await click('.spatial-launch')
  await check('create form receives focus', 'document.activeElement.id === "spatial-title"')
  await text('#spatial-title', '完成物理实验报告')
  await text('#spatial-notes', '复核测量数据，再整理结论。')
  await screenshot('create-1440')
  await click('.spatial-submit')
  await wait('!document.querySelector("dialog") && document.querySelectorAll(".spatial-node").length === 1')
  await check('created task owns focus and has a readable state', 'document.activeElement.matches(".spatial-node") && document.activeElement.getAttribute("aria-label").includes("待开始")')
  let rows = await allRows()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].title, '完成物理实验报告')
  assert.equal(rows[0].notes, '复核测量数据，再整理结论。')
  const taskId = rows[0].id
  checks.push({ name: 'creation persisted to original IndexedDB store', pass: true })
  await screenshot('orbit-1440')
  await key('Enter')
  await wait('!!document.querySelector(".spatial-task-title")')
  await key('Tab')
  await check('dialog keeps keyboard focus inside', 'document.activeElement.closest("dialog") !== null')
  await key('d', 'KeyD')
  await check('detail keyboard does not open P0 observatory', '!document.querySelector("#p0-observatory")')
  await click('.spatial-status-options button:nth-child(2)')
  await wait('document.querySelector(".spatial-task-state").textContent.includes("进行中")')
  await screenshot('detail-1440')
  await key('Escape')
  await wait('!document.querySelector("dialog")')
  await check('Escape restores selected node focus without opening P0 controls', 'document.activeElement.matches(".spatial-node[data-status=doing]") && !document.querySelector("#p0-observatory")')
  await click('.spatial-launch')
  await key('Escape')
  await check('canceling creation restores the launch control even after selecting a task', 'document.activeElement.matches(".spatial-launch")')
  const after = await evaluate('window.__ASTARIA_P0__.getSnapshot()')
  for (const field of ['zoom', 'roll', 'inclination', 'centerX', 'centerY']) assert.equal(after[field], before[field])
  checks.push({ name: 'task creation and status changes do not change camera', pass: true })
  await send('Page.reload', { ignoreCache: true })
  await wait('!!document.querySelector(".spatial-node[data-status=doing]")')
  await evaluate('window.__ASTARIA_P0__.setPaused(true)')
  await check('reload preserves task and resets visual density to immersive', 'document.querySelector(".spatial-ui").dataset.density === "immersive" && document.querySelector(".spatial-node").getAttribute("aria-label").includes("完成物理实验报告")')
  await click('.spatial-node')
  await click('.spatial-status-options button:nth-child(3)')
  await wait('document.querySelector(".spatial-task-state").textContent.includes("已完成")')
  rows = await allRows()
  assert.equal(rows[0].status, 'done'); assert.ok(rows[0].doneAt)
  await key('Escape')
  await wait('!document.querySelector("dialog") && !!document.querySelector(".spatial-memory")')
  await check('completion removes active node and retains a memory entry', 'document.querySelectorAll(".spatial-node").length === 0 && document.querySelector(".spatial-memory").textContent.includes("1")')
  await click('.spatial-memory')
  await wait('document.querySelector("#spatial-panel-title").textContent === "回望"')
  await screenshot('history-1440')
  await click('.spatial-task-index li button')
  await click('.spatial-status-options button:nth-child(1)')
  await wait('document.querySelector(".spatial-task-state").textContent.includes("待开始")')
  rows = await allRows()
  assert.equal(rows[0].status, 'todo'); assert.equal(rows[0].doneAt, undefined)
  assert.equal(rows[0].id, taskId); assert.equal(rows[0].notes, '复核测量数据，再整理结论。')
  checks.push({ name: 'history can reopen the same task without losing notes', pass: true })
  await key('Escape')
  await click('.spatial-density button:nth-child(3)')
  await click('.p0-day-toggle')
  await delay(1300)
  await screenshot('day-analysis-1440')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await delay(200)
  await screenshot('day-390')
  await click('.p0-day-toggle')
  await delay(1300)
  await screenshot('night-390')
  await check('390px view fits and first task remains reachable on its orbit', 'document.documentElement.scrollWidth <= innerWidth && document.querySelectorAll(".spatial-node").length === 1 && [...document.querySelectorAll(".spatial-node")].every(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})')
  await click('.spatial-node')
  await screenshot('detail-390')
  await check('390px detail panel fits viewport', '(()=>{const r=document.querySelector("dialog").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()')
  await key('Escape')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await click('.p0-views button:last-child')
  await delay(100)
  await check('interstellar preset remains intact under reduced motion', '(()=>{const s=window.__ASTARIA_P0__.getSnapshot();return s.zoom===2.05&&s.centerX===.98&&Math.abs(s.roll-7)<1e-9&&Math.abs(s.inclination-84)<1e-9})()')
  await click('.spatial-index-link button')
  await click('.spatial-task-index li button')
  await click('.spatial-status-options button:nth-child(3)')
  await wait('document.querySelector(".spatial-task-state").textContent.includes("已完成")')
  await check('reduced motion completes without infall animation', '!document.querySelector(".spatial-completion")')
  await key('Escape')
  await check('memory control stays within the interstellar viewport', '(()=>{const r=document.querySelector(".spatial-memory").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()')
  await click('.p0-views button:first-child')
  await check('panorama preset remains intact', '(()=>{const s=window.__ASTARIA_P0__.getSnapshot();return s.zoom===.7&&s.centerX===.65&&Math.abs(s.roll-18)<1e-9&&Math.abs(s.inclination-83)<1e-9})()')
  await send('Page.navigate', { url: new URL('#/app', url).href })
  await wait('location.hash === "#/app"')
  await send('Page.reload', { ignoreCache: true })
  await wait('!!document.querySelector(".app-shell")')
  await check('original business application remains reachable', '!!document.querySelector(".app-shell") && !document.querySelector(".p0")')
  await check('no runtime exceptions', JSON.stringify(errors.length === 0))
  await fs.writeFile(new URL('browser-checks.json', root), JSON.stringify({ url, checks, errors, userAgent: await evaluate('navigator.userAgent') }, null, 2))
  console.log(JSON.stringify(checks, null, 2))
} catch (error) {
  await fs.writeFile(new URL('browser-checks.json', root), JSON.stringify({ checks, errors, failure: String(error) }, null, 2))
  throw error
} finally { socket.close() }
