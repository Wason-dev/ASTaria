/** Use only the dedicated temporary QA Chrome on CDP 9233, never a user profile. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const url = new URL(process.env.LEGACY_TEST_URL ?? 'http://127.0.0.1:5188/')
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Only local preview URLs are allowed')
url.hash = '/app'
const output = new URL('../artifacts/legacy-app/browser-checks.json', import.meta.url)
const targets = await fetch('http://127.0.0.1:9233/json').then(r => r.json())
const target = targets.find(item => item.type === 'page')
assert.ok(target, 'Start the dedicated temporary QA Chrome on port 9233 first')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let serial = 0
const pending = new Map(), checks = [], errors = []
ws.onmessage = event => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
  if (!message.id) return
  const callback = pending.get(message.id)
  if (!callback) return
  pending.delete(message.id)
  clearTimeout(callback.timer)
  if (message.error) callback.reject(new Error(JSON.stringify(message.error)))
  else callback.resolve(message.result)
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 15_000)
  pending.set(id, { resolve, reject, timer })
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const wait = async expression => {
  for (let i = 0; i < 120; i++) {
    if (await evaluate(expression)) return
    await delay(80)
  }
  throw new Error(`Timed out: ${expression}`)
}
const check = async (name, expression) => {
  const pass = await evaluate(expression)
  checks.push({ name, pass })
  assert.equal(pass, true, name)
}
const click = async selector => {
  await wait(`!!document.querySelector(${JSON.stringify(selector)})`)
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await delay(60)
}
const rows = (database, store) => evaluate(`(async()=>{
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(${JSON.stringify(database)});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})
  try{return await new Promise((resolve,reject)=>{const r=db.transaction(${JSON.stringify(store)}).objectStore(${JSON.stringify(store)}).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}finally{db.close()}
})()`)
const put = (database, store, values) => evaluate(`(async()=>{
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(${JSON.stringify(database)});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})
  try{await new Promise((resolve,reject)=>{const tx=db.transaction(${JSON.stringify(store)},'readwrite');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);for(const value of ${JSON.stringify(values)})tx.objectStore(${JSON.stringify(store)}).put(value)});return true}finally{db.close()}
})()`)
let clockScript, failure
const openAt = async iso => {
  await send('Page.navigate', { url: 'about:blank' })
  await wait('location.href==="about:blank"')
  if (clockScript) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: clockScript })
  const source = `(()=>{
    const NativeDate=Date,fixed=${JSON.stringify(Date.parse(iso))};
    globalThis.Date=new Proxy(NativeDate,{
      construct(target,args){return Reflect.construct(target,args.length?args:[fixed])},
      apply(){return new NativeDate(fixed).toString()},
      get(target,key){return key==='now'?()=>fixed:Reflect.get(target,key)}
    });
  })()`
  clockScript = (await send('Page.addScriptToEvaluateOnNewDocument', { source })).identifier
  await send('Page.navigate', { url: url.href })
  await wait('!!document.querySelector(".app-shell .page-heading")')
}
const calendar = async () => {
  await click('.nav-list .nav-item:nth-child(3)')
  await wait('!!document.querySelector(".calendar-grid")')
}
const month = async (year, number) => {
  for (let i = 0; i < 30; i++) {
    const current = await evaluate('document.querySelector(".calendar-controls strong").textContent.match(/\\d+/g).map(Number)')
    if (current[0] === year && current[1] === number) return
    await click(`.calendar-controls button:${current[0] * 12 + current[1] < year * 12 + number ? 'last-child' : 'first-child'}`)
  }
  throw new Error(`Could not reach ${year}-${number}`)
}
const eventDays = title => `([...document.querySelectorAll('.calendar-cell')].filter(e=>[...e.querySelectorAll('.calendar-event')].some(n=>n.textContent===${JSON.stringify(title)})).map(e=>Number(e.querySelector('b').textContent)))`
try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Network.setBypassServiceWorker', { bypass: true })
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  await send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: 'about:blank' }); await wait('location.href==="about:blank"')
  await send('Storage.clearDataForOrigin', { origin: url.origin, storageTypes: 'indexeddb,local_storage' })
  await openAt('2026-09-18T00:30:00+08:00')
  await check('Shanghai 00:30 renders the current local date and weekday', 'document.querySelector(".page-heading .overline").textContent.includes("2026 年 9 月 18 日 · 周五")&&new Date().getHours()===0')
  await evaluate(`(()=>{const e=document.querySelector('.availability-controls input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'23:15');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
  await click('.availability-controls button')
  await wait('document.querySelector(".availability-card small").textContent.includes("23:15")')
  const availability = await rows('astaria-schedule', 'availability')
  const correctDay = availability.length === 1 && availability[0].date === '2026-09-18' && availability[0].until === '23:15'
  checks.push({ name: 'availability persists only under the local current day before 08:00', pass: correctDay })
  assert.equal(correctDay, true)

  for (const [iso, label] of [['2026-09-19T10:00:00+08:00', '周六'], ['2026-09-20T10:00:00+08:00', '周日']]) {
    await openAt(iso)
    await check(`${label} renders the legacy app without weekday-table crashes`, `!!document.querySelector('.app-shell')&&document.querySelector('.heading-mark').textContent===${JSON.stringify(label)}&&document.querySelector('.recommendation-card').textContent.includes('还没有可安排的建议')`)
  }

  await openAt('2026-09-18T00:30:00+08:00')
  const timestamp = '2026-09-17T16:30:00.000Z'
  const task = (id, year) => ({ id, title: `QA task ${year}`, area: null, source: 'manual', inbox: false, due: `${year}-09-18T12:00:00+08:00`, leadDays: 3, importance: 2, estimateMin: 25, energy: 'deep', context: ['anywhere'], status: 'todo', createdAt: timestamp, updatedAt: timestamp, deletedAt: null })
  await put('astaria-local', 'tasks', [task('qa-2025', 2025), task('qa-2026', 2026)])
  await calendar() // Ensure Dexie has initialized the calendar schema before seeding.
  await rows('astaria-calendar', 'events')
  const event = (id, startDate, endDate) => ({ id, title: id, startDate, endDate, kind: 'other', allDay: true, source: 'manual', affectsScheduling: false, updatedAt: timestamp, deletedAt: null })
  await put('astaria-calendar', 'events', [event('QA cross-month', '2026-08-31', '2026-09-02'), event('QA single-day', '2026-09-18', '2026-09-18'), event('QA cross-year', '2026-12-31', '2027-01-02')])
  await openAt('2026-09-18T00:30:00+08:00'); await calendar()
  await wait('document.querySelector(".calendar-grid").textContent.includes("QA single-day")')
  await check('September 2026 excludes a task with the same month/day in 2025', '(()=>{const texts=[...document.querySelectorAll(".calendar-task")].map(e=>e.textContent);return texts.includes("QA task 2026")&&!texts.includes("QA task 2025")})()')
  await check('today is highlighted in the actual current year', 'document.querySelectorAll(".calendar-cell--today").length===1&&document.querySelector(".calendar-cell--today b").textContent==="18"')
  await check('cross-month events include September first and ending day', `JSON.stringify(${eventDays('QA cross-month')})==='[1,2]'`)
  await check('single-day events appear exactly on their day', `JSON.stringify(${eventDays('QA single-day')})==='[18]'`)
  await month(2026, 8)
  await wait(`${eventDays('QA cross-month')}.length===1`)
  await check('cross-month events include their August starting day', `JSON.stringify(${eventDays('QA cross-month')})==='[31]'`)
  await month(2025, 9)
  await wait('document.querySelector(".calendar-grid").textContent.includes("QA task 2025")')
  await check('a different year does not highlight today or include current-year tasks', '!document.querySelector(".calendar-cell--today")&&![...document.querySelectorAll(".calendar-task")].some(e=>e.textContent==="QA task 2026")')
  await month(2026, 12)
  await wait(`${eventDays('QA cross-year')}.length===1`)
  await check('cross-year events include December start', `JSON.stringify(${eventDays('QA cross-year')})==='[31]'`)
  await month(2027, 1)
  await wait(`${eventDays('QA cross-year')}.length===2`)
  await check('cross-year events include both January days and the ending day', `JSON.stringify(${eventDays('QA cross-year')})==='[1,2]'`)
  checks.push({ name: 'all legacy pages render without uncaught runtime exceptions', pass: errors.length === 0 })
  assert.equal(errors.length, 0, JSON.stringify(errors))
} catch (error) {
  failure = error
} finally {
  try {
    if (clockScript) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: clockScript })
    await send('Page.navigate', { url: 'about:blank' })
    await wait('location.href==="about:blank"')
    await send('Emulation.setTimezoneOverride', { timezoneId: '' })
    await send('Emulation.clearDeviceMetricsOverride')
    await send('Network.setBypassServiceWorker', { bypass: false })
    await send('Network.setCacheDisabled', { cacheDisabled: false })
  } catch (error) { failure ??= error }
  await fs.mkdir(new URL('.', output), { recursive: true })
  await fs.writeFile(output, JSON.stringify({ checkedAt: new Date().toISOString(), url: url.href, timezone: 'Asia/Shanghai', checks, runtimeErrors: errors, failure: failure ? String(failure.stack ?? failure) : null }, null, 2) + '\n')
  ws.close()
}
console.log(`${checks.filter(item => item.pass).length}/${checks.length} legacy browser checks passed`)
if (failure) throw failure
