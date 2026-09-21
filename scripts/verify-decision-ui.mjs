/** Decision studio acceptance against an intercepted, in-memory local service.
 * Every /api request is paused before the page first navigates. No user data,
 * credential vault, or language-model provider is used by this script. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { localDay, shiftDay } from '../src/home/agenda.ts'

const base = process.env.DECISION_QA_URL ?? 'http://127.0.0.1:5188/'
const endpoint = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9334'
const output = process.env.DECISION_QA_OUTPUT ?? '/tmp/astaria-decision-ui'
const db = createDatabase(':memory:')
const start = localDay(shiftDay(new Date(), 1)), next = localDay(shiftDay(new Date(), 2))
const task = db.createTask({ title: '决策验证：SAT 四项练习', estimateMin: 90, due: localDay(shiftDay(new Date(), 5)), inbox: false })
const unknown = db.createTask({ title: '决策验证：尚未估时', inbox: false })
const unrelated = db.createTask({ title: '不能移动的其他事项', estimateMin: 30, inbox: false })
const edit = action => db.updatePlanner(action, db.getPlanner().revision)
for (const routine of db.getPlanner().routines) edit({ type: 'delete-routine', id: routine.id })
edit({ type: 'save-routine', routine: { id: 'qa-free', title: '明确可用时间', kind: 'available', weekdays: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '22:00', location: '', items: [], enabled: true } })
edit({ type: 'save-block', block: { id: 'qa-baseline', taskId: task.id, date: start, start: '18:00', end: '19:30', locked: false } })
edit({ type: 'save-block', block: { id: 'qa-unrelated', taskId: unrelated.id, date: next, start: '19:40', end: '20:10', locked: true } })
const original = db.getPlanner()
const service = createLocalService({ db, vault: { status: async () => true }, complete: async () => { throw Error('Decision UI QA cannot call a provider') }, dataDirectory: '/isolated-decision-qa' })
const version = await fetch(`${endpoint}/json/version`).then(response => response.json())
const ws = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let serial = 0, session, contextId
const pending = new Map(), checks = [], errors = [], requests = []
const send = (method, params = {}, sid = session) => new Promise((resolve, reject) => {
  const id = ++serial; pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }))
})
const api = request => new Promise(resolve => {
  requests.push({ path: new URL(request.url).pathname, method: request.method })
  const req = Readable.from(request.postData ? [Buffer.from(request.postData)] : [])
  req.url = new URL(request.url).pathname + new URL(request.url).search; req.method = request.method
  req.socket = { remoteAddress: '127.0.0.1', localPort: Number(new URL(base).port) }
  req.headers = { host: new URL(base).host, origin: new URL(base).origin, 'x-astaria-local': '1', 'content-type': 'application/json' }
  const res = { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, body }) } }
  service.middleware(req, res, () => resolve({ status: 404, body: '{}' }))
})
ws.onmessage = event => {
  const value = JSON.parse(event.data)
  if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails)
  if (value.method === 'Fetch.requestPaused') api(value.params.request).then(response => send('Fetch.fulfillRequest', {
    requestId: value.params.requestId, responseCode: response.status,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(response.body).toString('base64'),
  }, value.sessionId)).catch(reason => errors.push(String(reason)))
  if (!value.id) return
  const callback = pending.get(value.id); pending.delete(value.id)
  if (callback) value.error ? callback.reject(value.error) : callback.resolve(value.result)
}
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const wait = async expression => {
  for (let attempt = 0; attempt < 160; attempt++) { if (await evaluate(expression)) return; await delay(75) }
  throw Error(`Timeout: ${expression}`)
}
const check = async (label, expression) => { assert.equal(await evaluate(expression), true, label); checks.push(label) }
const point = async selector => {
  await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled&&!e.closest('[inert]')})()`)
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'});true`)
  await delay(120)
  return evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded '+${JSON.stringify(selector)});return{x,y}})()`)
}
const click = async selector => {
  const at = await point(selector)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...at })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...at })
  await delay(100)
}
const byText = async (selector, text) => {
  await wait(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(e=>e.textContent.trim()===${JSON.stringify(text)})`)
  await evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing '+${JSON.stringify(text)});e.dataset.qaClick='target';return true})()`)
  await click('[data-qa-click=target]')
  await evaluate('document.querySelectorAll("[data-qa-click]").forEach(e=>delete e.dataset.qaClick);true')
}
const setValue = async (selector, value) => {
  await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');const prototype=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
  await delay(150)
}
const shot = async name => writeFile(`${output}/${name}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
const latest = () => db.getCompanionState().scenarios.at(-1)
const generate = async strategy => {
  await click(`[data-path="${strategy}"]`)
  const count = db.getCompanionState().scenarios.length
  await click('.decision-create')
  await wait(`document.querySelector('.decision-status')?.textContent==='待采用'&&!document.querySelector('.decision-history select').disabled`)
  assert.equal(db.getCompanionState().scenarios.length, count + 1)
  return latest()
}

try {
  await mkdir(output, { recursive: true })
  contextId = (await send('Target.createBrowserContext', {}, null)).browserContextId
  const target = await send('Target.createTarget', { url: 'about:blank', browserContextId: contextId }, null)
  session = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null)).sessionId
  await send('Page.enable'); await send('Runtime.enable')
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] })
  await send('Network.setBypassServiceWorker', { bypass: true })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__qaDecisionEffect=null;window.addEventListener('astaria:decision-effect',event=>{window.__qaDecisionEffect=event.detail})` })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  // Navigation happens only after interception and service-worker bypass exist.
  await send('Page.navigate', { url: base })
  await wait('!!document.querySelector(".home-launch")')
  await click('.home-brand'); await byText('#home-menu button', '平行宇宙')
  await wait('!!document.querySelector(".decision-create")&&!document.querySelector(".decision-create").disabled')
  await setValue('[aria-label="推演起始日期"]', start)
  await setValue('[aria-label="选择推演事项"]', task.id)
  await wait('!document.querySelector(".decision-create").disabled')
  await check('single first-class page has a task choice, three paths and a year-long slider', 'document.querySelectorAll(".decision-paths button").length===3&&document.querySelector(".decision-timeline input[type=range]").max==="1000"&&!document.querySelector("dialog:modal")')
  await shot('initial')

  const today = await generate('today')
  assert.equal(today.decision.strategy, 'today')
  assert.ok(today.plans.every(plan => plan.date === start))
  assert.equal(today.metrics.scheduledMin, 90)
  assert.deepEqual(db.getPlanner(), original); checks.push('today preview uses the target task and does not modify planner')
  for (const [width, height] of [[1440, 900], [1366, 768], [1280, 800]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await delay(250)
    await check(`${width}×${height} keeps primary results and actions on one screen`, '(()=>{const s=document.querySelector(".xc-page-scroll"),a=document.querySelector(".decision-apply").getBoundingClientRect();return s.scrollHeight<=s.clientHeight+1&&s.scrollWidth<=s.clientWidth+1&&a.bottom<=s.getBoundingClientRect().bottom})()')
    await shot(`layout-${width}`)
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await click('[data-day="6"]')
  await check('one-week preview shows 90 minutes in the candidate metric', 'document.querySelector(".decision-main-metric strong").textContent==="1 小时 30 分"')
  await click('[data-day="364"]')
  await check('once-only work stays 90 minutes a year out and states its limit', 'document.querySelector(".decision-main-metric strong").textContent==="1 小时 30 分"&&document.querySelector(".decision-evidence").textContent.includes("本周以后的安排不再累加")')

  const split = await generate('split')
  assert.equal(split.decision.todayMin, 30)
  assert.equal(split.plans.filter(plan => plan.date === start).length, 1)
  assert.ok(split.plans.some(plan => plan.date === next))
  assert.deepEqual(db.getPlanner(), original); checks.push('split reserves the chosen 30-minute first segment and keeps the rest tomorrow')
  await click('[data-day="0"]')
  await check('split day metric shows the actual first 30 minutes', 'document.querySelector(".decision-main-metric strong").textContent==="30 分钟"')
  await click('[data-day="1"]')
  await check('tomorrow lists the deferred segment and cumulative total', 'document.querySelector(".decision-evidence ol li")!==null&&document.querySelector(".decision-main-metric strong").textContent==="1 小时 30 分"')

  const defer = await generate('defer')
  assert.ok(defer.plans.every(plan => plan.date > start))
  assert.deepEqual(db.getPlanner(), original); checks.push('defer leaves the first day empty without touching unrelated work')
  await click('[data-day="0"]')
  const at = await point('.decision-compare')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...at })
  await check('holding comparison restores baseline data and renderer state', 'document.querySelector(".decision-studio").dataset.comparing==="true"&&window.__qaDecisionEffect.comparing===true&&document.querySelector(".decision-main-metric strong").textContent==="1 小时 30 分"')
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...at })
  await check('releasing comparison immediately restores the candidate', 'document.querySelector(".decision-studio").dataset.comparing==="false"&&window.__qaDecisionEffect.comparing===false&&document.querySelector(".decision-main-metric strong").textContent==="0 分钟"')
  await shot('defer-compare')

  await setValue('[aria-label="选择已保存推演"]', split.id)
  await check('history restores task, strategy, and original split condition', `document.querySelector('[aria-label="选择推演事项"]').value===${JSON.stringify(task.id)}&&document.querySelector('[data-path="split"]').getAttribute('aria-pressed')==='true'&&document.querySelector('.decision-history select').value===${JSON.stringify(split.id)}`)
  await byText('.decision-recurrence button', '假如每周如此')
  await check('changing repetition invalidates the old draft before apply', '!document.querySelector(".decision-apply")&&!!document.querySelector(".decision-create")')
  await click('.decision-create'); await wait('!!document.querySelector(".decision-apply")&&!document.querySelector(".decision-apply").disabled')
  const weekly = latest()
  assert.equal(weekly.decision.recurrence, 'weekly')
  await click('[data-day="89"]')
  await check('three-month conditional total is 13 known weeks of 90 minutes', 'document.querySelector(".decision-main-metric strong").textContent==="19 小时 30 分"&&document.querySelector(".decision-evidence").textContent.includes("假定每周")')
  await click('[data-day="364"]')
  await check('year projection counts 52 whole weeks and one partial first day', 'document.querySelector(".decision-main-metric strong").textContent==="78 小时 30 分"')
  assert.deepEqual(db.getPlanner(), original); checks.push('year scrubbing is conditional arithmetic and creates no repeated tasks or blocks')
  await shot('weekly-year')

  await click('.decision-apply')
  await wait('document.querySelector(".decision-status")?.textContent==="已采用"')
  assert.ok(db.getPlanner().revision > original.revision)
  assert.deepEqual(db.getPlanner().blocks.find(block => block.id === 'qa-unrelated'), original.blocks.find(block => block.id === 'qa-unrelated'))
  assert.ok(db.getPlanner().blocks.filter(block => block.taskId === task.id).every(block => block.date <= localDay(shiftDay(new Date(`${start}T12:00:00`), 6))))
  checks.push('adopt writes only this seven-day plan and preserves unrelated locked work')
  await byText('.decision-action-row button', '撤销采用')
  await wait('document.querySelector(".decision-status")?.textContent==="已撤销"')
  assert.deepEqual(db.getPlanner().blocks, original.blocks); checks.push('undo restores the original blocks')

  const fresh = await generate('today')
  edit({ type: 'check-item', date: start, key: 'fixture-only', checked: true })
  await evaluate('window.dispatchEvent(new Event("astaria-local-data-change"));true')
  await wait('document.querySelector(".decision-action-note")?.textContent.includes("数据已变化")')
  await check('an out-of-date preview offers recompute instead of apply', '!document.querySelector(".decision-apply")&&document.querySelector(".decision-create").textContent.includes("重新推演")')
  assert.equal(db.getCompanionState().scenarios.find(item => item.id === fresh.id).status, 'preview')

  await setValue('[aria-label="选择推演事项"]', unknown.id)
  await click('.decision-create'); await wait('document.querySelector(".decision-status")?.textContent==="待采用"')
  await check('unknown effort stays explicit and cannot apply invented work', 'document.querySelector(".decision-risk").textContent.includes("用时未知")&&document.querySelector(".decision-apply").disabled')
  assert.equal(latest().decision.effortMin, null)
  assert.equal(latest().plans.length, 0)
  await shot('unknown')

  await setValue('[aria-label="推演起始日期"]', next)
  await evaluate(`window.dispatchEvent(new CustomEvent('astaria-open-companion',{detail:{tab:'scenarios',targetId:${JSON.stringify(split.id)}}}));true`)
  await wait(`document.querySelector('[aria-label="选择已保存推演"]').value===${JSON.stringify(split.id)}&&document.querySelector('[aria-label="推演起始日期"]').value===${JSON.stringify(start)}`)
  await check('opening a saved target restores its date, task, and path after asynchronous load', `document.querySelector('[aria-label="选择推演事项"]').value===${JSON.stringify(task.id)}&&document.querySelector('[data-path="split"]').getAttribute('aria-pressed')==='true'`)

  await byText('.xc-tabs button', '牵挂清单0')
  await check('leaving decisions holds the outgoing view for a staged opacity transition', 'document.querySelector(".xc-page").dataset.leaving==="true"&&!!document.querySelector(".decision-studio")&&getComputedStyle(document.querySelector(".xc-scroll")).transitionProperty==="opacity"')
  await check('black-hole strength retreats alongside the outgoing panel', '(()=>{const s=window.__ASTARIA_P0__.getSnapshot().decisionEffect;return s.exiting&&s.strength>0&&s.strength<1})()')
  await byText('.xc-section-heading button', '记下一件')
  await evaluate(`(()=>{const set=(selector,value)=>{const e=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}))};set('.xc-wish-editor textarea[id$="-content"]','验证：周末带相机散步');set('.xc-wish-editor textarea[id$="-items"]','相机\\n电池');return true})()`)
  await byText('.xc-wish-editor button', '记住这件事')
  await wait('document.querySelector(".xc-wish-list")?.textContent.includes("周末带相机散步")')
  assert.equal(db.getCompanionState().wishes[0].evidence, '验证：周末带相机散步')
  assert.deepEqual(db.getCompanionState().wishes[0].items, ['相机', '电池'])
  checks.push('wish creation retains user wording and preparation items')
  await byText('.xc-wish-actions button', '暂停'); await wait('document.querySelector(".xc-wish-list li").dataset.status==="paused"')
  await byText('.xc-wish-actions button', '恢复'); await wait('document.querySelector(".xc-wish-list li").dataset.status==="active"')
  checks.push('wish pause and resume remain operational after decision redesign')
  await byText('.xc-tabs button', '合适的时机')
  await wait('!!document.querySelector(".xc-opportunities li")')
  await check('opportunities retain a real time and the requested preparation', 'document.querySelector(".xc-opportunities").textContent.includes("周末带相机散步")&&document.querySelector(".xc-opportunities").textContent.includes("相机")&&document.querySelector(".xc-opportunities").textContent.includes("–")')
  await shot('opportunities')
  await byText('.xc-tabs button', '牵挂清单1'); await byText('.xc-wish-actions button', '移除')
  assert.equal(db.getCompanionState().wishes.length, 1); checks.push('wish deletion waits for its visible confirmation')
  await byText('.xc-wish-actions button', '确认移除'); await wait('!document.querySelector(".xc-wish-list")')
  assert.equal(db.getCompanionState().wishes.length, 0); checks.push('confirmed wish removal clears the saved record')
  await byText('.xc-tabs button', '决策推演')
  await wait('!!document.querySelector(".decision-studio")')
  checks.push('returning from auxiliary tabs restores the decision studio')
  for (const width of [390, 320]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false })
    await delay(200)
    await check(`${width}px allows vertical reading without horizontal clipping`, '(()=>{const s=document.querySelector(".xc-page-scroll");return s.scrollWidth<=s.clientWidth+1})()')
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false })
  await delay(500)
  await evaluate(`document.querySelectorAll('.xc-tabs button')[1].click();true`)
  await wait('document.querySelector(".xc-page").dataset.leaving==="true"')
  await evaluate(`document.querySelectorAll('.xc-tabs button')[0].click();true`)
  await delay(350)
  await check('a quick return cancels tab departure without losing the studio', 'document.querySelector(".xc-page").dataset.leaving==="false"&&!!document.querySelector(".decision-studio")')
  await click('.home-brand'); await byText('#home-menu button', '首页')
  await check('page navigation starts with the departing view', 'document.querySelector(".home-workspace").dataset.page==="companion"&&document.querySelector(".xc-page").dataset.exiting==="true"')
  await wait('document.querySelector(".home-workspace").dataset.page==="home"')
  await check('homepage becomes visible and interactive before the camera finishes', '(()=>{const d=window.__ASTARIA_P0__.getSnapshot().decisionEffect,e=document.querySelector(".home-launch"),r=e.getBoundingClientRect();return d.exiting&&d.strength>0&&!!document.querySelector(".xc-page")&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()')
  await shot('exit-midway')
  await click('.home-brand'); await byText('#home-menu button', '平行宇宙')
  await check('returning after the destination appears cancels the pending unmount', 'document.querySelector(".home-workspace").dataset.page==="companion"&&document.querySelector(".xc-page").dataset.exiting==="false"&&!window.__ASTARIA_P0__.getSnapshot().decisionEffect.exiting')
  await click('.home-brand'); await byText('#home-menu button', '首页')
  await wait('document.querySelector(".home-workspace").dataset.page==="home"&&!document.querySelector(".xc-page")')
  await check('departing optics do not remain on the destination page', '!document.querySelector(".xc-glass")&&window.__ASTARIA_P0__.getSnapshot().decisionEffect.strength===0')
  await click('.home-brand'); await byText('#home-menu button', '平行宇宙')
  await wait('!!document.querySelector(".decision-studio")')
  await delay(1900)
  await evaluate(`(()=>{window.__qaHandoff=[];const end=performance.now()+3000;const frame=()=>{const old=document.querySelector('.xc-scroll'),next=document.querySelector('.planner[data-active=true] .pl-board-toolbar');window.__qaHandoff.push({time:performance.now(),page:document.querySelector('.home-workspace').dataset.page,exiting:document.querySelector('.xc-page')?.dataset.exiting==='true',old:old?Number(getComputedStyle(old).opacity):0,next:next?Number(getComputedStyle(next).opacity):0});if(performance.now()<end)requestAnimationFrame(frame)};requestAnimationFrame(frame);return true})()`)
  await click('.home-brand'); await byText('#home-menu button', '日程')
  await wait('document.querySelector(".home-workspace").dataset.page==="schedule"')
  await check('calendar activates while the departing content is still visible', '(()=>{const first=window.__qaHandoff.find(frame=>frame.page==="schedule");return !!first&&first.exiting&&first.old>.02})()')
  await check('calendar controls accept input during the remaining camera exit', '(()=>{const d=window.__ASTARIA_P0__.getSnapshot().decisionEffect,e=document.querySelector(".pl-segment button[data-mode=month]"),r=e.getBoundingClientRect();return d.exiting&&d.strength>0&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()')
  await shot('calendar-exit-overlap')
  await click('.pl-segment button[data-mode=month]')
  await check('the calendar can switch modes before the old page is removed', 'document.querySelector(".planner").dataset.mode==="month"&&!!document.querySelector(".xc-page")')
  await wait('!document.querySelector(".xc-page")')
  await check('calendar handoff has no fully empty frame between the two pages', '(()=>{const frames=window.__qaHandoff.filter(frame=>frame.exiting||frame.page==="schedule");return frames.length>5&&frames.every(frame=>Math.max(frame.old,frame.next)>.02)})()')
  await click('.home-brand'); await byText('#home-menu button', '平行宇宙')
  await wait('!!document.querySelector(".decision-studio")')
  await click('.home-brand'); await byText('#home-menu button', '工作台')
  await wait('document.querySelector(".home-workspace").dataset.page==="workbench"')
  await click('.home-brand'); await byText('#home-menu button', '设置')
  await wait('!document.querySelector(".xc-page")')
  await check('the old exit callback cannot override a newer navigation', 'document.querySelector(".home-workspace").dataset.page==="settings"')
  assert.equal(db.listTasks().length, 3)
  assert.ok(!requests.some(request => request.path === '/api/chat'))
  assert.deepEqual(errors, [])
  await writeFile(`${output}/results.json`, JSON.stringify({ checks, errors, requests, fixture: { start, next, taskId: task.id, unknownId: unknown.id, weeklyId: weekly.id } }, null, 2))
  console.log(JSON.stringify({ checks: checks.length, errors: errors.length, output }))
} catch (reason) {
  await shot('failure').catch(() => {})
  await writeFile(`${output}/failure.json`, JSON.stringify({ error: String(reason), checks, errors, requests }, null, 2))
  throw reason
} finally {
  if (contextId) await send('Target.disposeBrowserContext', { browserContextId: contextId }, null)
  ws.close(); db.close()
}
