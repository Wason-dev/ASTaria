/** Decision studio acceptance against an intercepted, in-memory local service.
 * Every /api request is paused before the page first navigates. No user data,
 * credential vault, or language-model provider is used by this script. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { createCompanion } from '../server/companion.mjs'
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
const legacyExtra = db.createTask({ title: '历史验证：另一项阅读', estimateMin: 25, inbox: false })
const legacy = createCompanion({ db }).previewScenario({ date: start, days: 3, mode: 'rebalance', taskIds: [task.id, legacyExtra.id], budgetMin: 240 })
assert.ok(new Set(legacy.plans.map(plan => plan.taskId)).size > 1, 'legacy fixture contains multiple tasks')
const modelRequests = []
const minute = time => { const [hour, value] = time.split(':').map(Number); return hour * 60 + value }
const timeOf = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
const markers = { benefit: '验证判断：先保留休息，再按真实空档继续。', cost: '验证代价：开始时间比原安排晚一天。', risk: '验证风险：明天空档若改变需要重排。', recovery: '验证恢复：保留原截止日期，可以重新比较。', observation: '验证观察：下一次开始时记录真实完成进度。' }
const question = '今天先休息，把 SAT 四项练习放到明天的空档，截止日期不变。'
// Deterministic model fixture: it only uses the actual facts supplied by the
// route service, so stale field contracts or missing availability fail here.
const complete = async payload => {
  assert.equal(payload.response_format?.type, 'json_object')
  assert.equal(payload.tools, undefined)
  const context = JSON.parse(payload.messages.find(message => message.role === 'user').content)
  const { facts, choice } = context
  assert.ok(Array.isArray(facts.availableWindows))
  assert.ok(Array.isArray(facts.timeline) && facts.timeline.length === 7)
  assert.equal(facts.task.id, choice.taskId)
  assert.ok(typeof choice.question === 'string' && choice.question.length > 0)
  modelRequests.push({ choice, facts })
  const plans = []
  let remaining = facts.remainingMin
  if (remaining !== null && remaining > 0 && !facts.exactStartProtected) {
    for (const window of facts.availableWindows.filter(window => window.date > choice.date)) {
      if (remaining === 0) break
      const size = Math.min(remaining, minute(window.end) - minute(window.start))
      if (size <= 0) continue
      plans.push({ taskId: facts.task.id, date: window.date, start: window.start, end: timeOf(minute(window.start) + size) })
      remaining -= size
    }
  }
  const judgments = {
    current: `保持「${facts.task.title}」已有的 ${facts.baseline.length} 段安排。`,
    candidate: '今天留白，使用明天起已核验的空档。', benefits: [markers.benefit], costs: [markers.cost], risks: [markers.risk],
    recovery: [markers.recovery], observations: [markers.observation], assumptions: ['验证前提：只改变这一项任务，其他安排保持。'],
    trends: Object.fromEntries(['week', 'fourWeeks', 'threeMonths', 'oneYear'].map(horizon => [horizon, {
      condition: `验证前提-${horizon}：${choice.recurrence === 'weekly' ? '假如每周维持这种选择' : '只作本次选择，不假设每周重复'}。`,
      summary: `验证趋势-${horizon}：有可用空档时可能更容易保持节奏。`,
      uncertainty: `验证未知-${horizon}：后续负荷与掌握情况仍需观察。`,
    }])),
  }
  return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ plans, ...judgments,
    unscheduledReason: remaining === 0 ? '' : remaining === null ? '预计用时尚不明确，未生成虚构安排。' : '明天之后的已知空档不足。' }) } }] }
}
const service = createLocalService({ db, vault: { status: async () => true }, complete,
  fetcher: async () => { throw Error('Decision UI QA forbids all external providers and downloads') }, dataDirectory: '/isolated-decision-qa' })

// Allows the exact stub/API/apply/undo contract to be checked without a browser.
// This branch never connects to the real local app or a CDP endpoint.
if (process.env.DECISION_QA_FIXTURE_ONLY === '1') {
  const call = (path, input) => new Promise(resolve => {
    const req = Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))])
    req.url = `/api${path}`; req.method = input === undefined ? 'GET' : 'POST'
    req.socket = { remoteAddress: '127.0.0.1', localPort: 5188 }
    req.headers = { host: '127.0.0.1:5188', origin: 'http://127.0.0.1:5188', 'x-astaria-local': '1', 'content-type': 'application/json' }
    const res = { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, value: JSON.parse(body) }) } }
    service.middleware(req, res, () => resolve({ status: 404, value: {} }))
  })
  try {
    const route = await call('/companion/route', { taskId: task.id, date: start, question, recurrence: 'once' })
    assert.equal(route.status, 200, JSON.stringify(route.value))
    assert.equal(route.value.routeAnalysis.kind, 'model-judgment')
    assert.equal(route.value.metrics.scheduledMin, 90)
    assert.ok(route.value.plans.every(plan => plan.date > start))
    assert.deepEqual(db.getPlanner(), original)
    const applied = await call('/companion/scenario/apply', { id: route.value.id, expectedVersion: route.value.version })
    assert.equal(applied.status, 200, JSON.stringify(applied.value))
    assert.notDeepEqual(db.getPlanner().blocks, original.blocks)
    const undone = await call(`/operations/${applied.value.operation.id}/undo`, {})
    assert.equal(undone.status, 200, JSON.stringify(undone.value))
    assert.deepEqual(db.getPlanner().blocks, original.blocks)
    const empty = await call('/companion/route', { taskId: unknown.id, date: start, question: '没有估时，只比较风险。', recurrence: 'once' })
    assert.equal(empty.status, 200, JSON.stringify(empty.value))
    assert.deepEqual(empty.value.plans, [])
    console.log(JSON.stringify({ fixture: 'passed', modelRequests: modelRequests.length, legacyTasks: new Set(legacy.plans.map(plan => plan.taskId)).size }))
  } finally { db.close() }
  process.exit(0)
}
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
const generate = async (taskId = task.id, text = question) => {
  await setValue('[aria-label="选择推演事项"]', taskId)
  await setValue('[aria-label="推演起始日期"]', start)
  await setValue('.route-question>input', text)
  const count = db.getCompanionState().scenarios.length
  await click('.route-question button[type=submit]')
  await wait(`document.querySelector('.route-actions>span')?.textContent==='尚未采用'&&!document.querySelector('[aria-label="选择已保存推演"]').disabled`)
  assert.equal(db.getCompanionState().scenarios.length, count + 1)
  return latest()
}
const checkOneScreen = async (width, height) => {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await delay(250)
  await check(`${width}×${height} exposes question, horizon controls and adopt without page scrolling`, `(()=>{
    const s=document.querySelector('.xc-page-scroll'), outer=s.getBoundingClientRect();
    const elements=[document.querySelector('.route-question button[type=submit]'),document.querySelector('.route-actions .xc-primary'),...document.querySelectorAll('.route-section-heading nav button')];
    return s.scrollHeight<=s.clientHeight+1&&s.scrollWidth<=s.clientWidth+1&&elements.every(e=>{
      if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.top>=outer.top&&r.bottom<=Math.min(innerHeight,outer.bottom)&&r.left>=0&&r.right<=innerWidth
    })
  })()`)
  await shot(`layout-${width}x${height}`)
}

try {
  await mkdir(output, { recursive: true })
  contextId = (await send('Target.createBrowserContext', {}, null)).browserContextId
  const target = await send('Target.createTarget', { url: 'about:blank', browserContextId: contextId }, null)
  session = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null)).sessionId
  await send('Page.enable'); await send('Runtime.enable')
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] })
  await send('Network.setBypassServiceWorker', { bypass: true })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 800, deviceScaleFactor: 1, mobile: false })
  // No page request can reach the user's real /api before interception exists.
  await send('Page.navigate', { url: base })
  await wait('!!document.querySelector(".home-launch")')
  await click('.home-brand'); await byText('#home-menu button', '平行宇宙')
  await wait('!!document.querySelector(".route-question button[type=submit]")')
  await check('one independent comparison page has a concrete question and four horizons', 'document.querySelectorAll(".route-section-heading nav button").length===4&&!!document.querySelector(".route-question>input")&&!document.querySelector("dialog:modal")&&!document.querySelector(".decision-paths")')

  const route = await generate()
  assert.equal(route.decision.strategy, 'model')
  assert.equal(route.routeAnalysis.question, question)
  assert.equal(route.routeAnalysis.kind, 'model-judgment')
  assert.deepEqual(route.routeAnalysis.facts.candidate, route.plans)
  assert.equal(route.metrics.scheduledMin, 90)
  assert.ok(route.plans.every(plan => plan.taskId === task.id && plan.date > start))
  assert.equal(modelRequests.length, 1)
  assert.equal(modelRequests[0].facts.baseline[0].id, 'qa-baseline')
  assert.deepEqual(db.getPlanner(), original)
  checks.push('fixture model reads real facts, saves a validated next-day branch and leaves the planner untouched')
  await check('current and candidate routes share seven days and mark the changed slots', 'document.querySelectorAll(".route-rail").length===2&&document.querySelectorAll(".route-rail:not([data-candidate=true]) .route-days>button").length===7&&document.querySelectorAll(".route-rail[data-candidate=true] .route-days>button").length===7&&document.querySelectorAll(".route-slot[data-changed=true]").length>=2')
  await check('both route tracks are visible one above the other', '(()=>{const a=document.querySelectorAll(".route-rail");return a[1].getBoundingClientRect().top>a[0].getBoundingClientRect().top})()')
  await check('model judgments appear in the insight panel', `document.querySelector('.route-insight-scroll').textContent.includes(${JSON.stringify(markers.benefit)})&&document.querySelector('.route-insight-scroll').textContent.includes(${JSON.stringify(markers.recovery)})`)
  await shot('model-double-rail')

  await byText('.route-insight-tabs button', '已核验')
  await check('verified facts are generated by the service rather than supplied by the model', `document.querySelector('.route-insight-scroll').textContent.includes('本次最多可安排 90 分钟')&&!document.querySelector('.route-insight-scroll').textContent.includes(${JSON.stringify(markers.benefit)})&&document.querySelector('.route-insight-scroll').textContent.includes('过去的计划不代表已完成')`)
  await byText('.route-insight-tabs button', '再观察')
  await check('observation view retains concrete next-step signals', `document.querySelector('.route-insight-scroll').textContent.includes(${JSON.stringify(markers.observation)})`)
  await byText('.route-insight-tabs button', '权衡')
  await byText('.route-section-heading nav button', '四周')
  await check('four-week projection contains its condition and uncertainty', 'document.querySelector(".route-trend").textContent.includes("验证趋势-fourWeeks")&&document.querySelector(".route-trend").textContent.includes("验证前提-fourWeeks")&&document.querySelector(".route-trend").textContent.includes("验证未知-fourWeeks")&&document.querySelector(".route-trend").textContent.includes("不会生成远期日程")')
  assert.deepEqual(db.getPlanner(), original)
  await byText('.route-section-heading nav button', '一年')
  await check('year projection stays conditional for a once-only choice', 'document.querySelector(".route-trend").textContent.includes("只作本次选择，不假设每周重复")&&document.querySelector(".route-trend").textContent.includes("验证趋势-oneYear")')
  await byText('.route-section-heading nav button', '这周')
  for (const [width, height] of [[1280, 720], [1440, 800]]) await checkOneScreen(width, height)

  await byText('.route-actions button', '采用这周的候选安排')
  await wait('document.querySelector(".route-actions>span")?.textContent==="已采用"')
  assert.ok(db.getPlanner().revision > original.revision)
  assert.equal(db.getPlanner().blocks.some(block => block.id === 'qa-baseline'), false)
  assert.deepEqual(db.getPlanner().blocks.find(block => block.id === 'qa-unrelated'), original.blocks.find(block => block.id === 'qa-unrelated'))
  assert.deepEqual(db.getPlanner().blocks.filter(block => block.taskId === task.id).map(({ date, start, end }) => ({ date, start, end })), route.plans.map(({ date, start, end }) => ({ date, start, end })))
  checks.push('adopt persists exactly the validated seven-day branch and preserves unrelated locked work')
  await byText('.route-actions button', '撤销采用')
  await wait('document.querySelector(".route-actions>span")?.textContent==="已撤销"')
  assert.deepEqual(db.getPlanner().blocks, original.blocks)
  checks.push('undo restores original planner blocks')

  await setValue('[aria-label="选择已保存推演"]', legacy.id)
  await check('legacy multi-task preview opens historical details, not invented double rails', `!document.querySelector('.route-rails')&&document.querySelector('.route-trend').textContent.includes('以前保存的排程草案')&&document.querySelector('.route-trend').textContent.includes(${JSON.stringify(task.title)})&&document.querySelector('.route-trend').textContent.includes(${JSON.stringify(legacyExtra.title)})`)
  await shot('legacy-history')
  await setValue('[aria-label="选择已保存推演"]', route.id)
  await check('restoring model history restores task, question, date and both routes', `document.querySelector('[aria-label="选择推演事项"]').value===${JSON.stringify(task.id)}&&document.querySelector('[aria-label="推演起始日期"]').value===${JSON.stringify(start)}&&document.querySelector('.route-question>input').value===${JSON.stringify(question)}&&document.querySelectorAll('.route-rail').length===2`)
  assert.deepEqual(db.getPlanner().blocks, original.blocks)

  await setValue('.route-question>input', '这周只作一次改变，明天继续。')
  await check('editing the question invalidates the saved draft before adopt', `document.querySelector('[aria-label="选择已保存推演"]').value===""&&!document.querySelector('.route-actions .xc-primary')`)
  const fresh = await generate()
  edit({ type: 'check-item', date: start, key: 'fixture-only', checked: true })
  await evaluate('window.dispatchEvent(new Event("astaria-local-data-change"));true')
  await wait('document.querySelector(".route-actions>span")?.textContent.includes("日程已变化")')
  await check('stale preview cannot be adopted after actual planner change', '!document.querySelector(".route-actions .xc-primary")')
  assert.equal(db.getCompanionState().scenarios.find(item => item.id === fresh.id).status, 'preview')

  const unknownRoute = await generate(unknown.id, '这件事还不知道需要多久，只比较可能的风险。')
  assert.equal(unknownRoute.decision.effortMin, null)
  assert.equal(unknownRoute.plans.length, 0)
  await byText('.route-insight-tabs button', '已核验')
  await check('unknown effort remains explicit without invented calendar slots', 'document.querySelector(".route-insight-scroll").textContent.includes("预计用时尚不明确")&&!document.querySelector(".route-actions .xc-primary")')

  await setValue('[aria-label="选择已保存推演"]', route.id)
  for (const width of [390, 320]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false })
    await delay(250)
    await check(`${width}px allows reading without outer horizontal overflow`, '(()=>{const s=document.querySelector(".xc-page-scroll");return s.scrollWidth<=s.clientWidth+1})()')
  }
  assert.equal(db.listTasks().length, 4)
  assert.ok(requests.some(request => request.path === '/api/companion/route' && request.method === 'POST'))
  assert.ok(!requests.some(request => request.path === '/api/chat' || request.path.startsWith('/api/settings/key')))
  assert.deepEqual(errors, [])
  await writeFile(`${output}/results.json`, JSON.stringify({ checks, errors, requests, modelCalls: modelRequests.length,
    fixture: { start, next, taskId: task.id, unknownId: unknown.id, routeId: route.id, legacyId: legacy.id } }, null, 2))
  console.log(JSON.stringify({ checks: checks.length, errors: errors.length, modelCalls: modelRequests.length, output }))
} catch (reason) {
  await shot('failure').catch(() => {})
  await writeFile(`${output}/failure.json`, JSON.stringify({ error: String(reason), checks, errors, requests }, null, 2))
  throw reason
} finally {
  if (contextId) await send('Target.disposeBrowserContext', { browserContextId: contextId }, null)
  ws.close(); db.close()
}
