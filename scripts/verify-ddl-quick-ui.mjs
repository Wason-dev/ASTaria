/** Uses a fresh CDP browser context; all API calls go to isolated in-memory SQLite. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { DEFAULT_PREFERENCES } from '../server/preferences.mjs'
import { localDay, shiftDay } from '../src/home/agenda.ts'

const base = process.env.DDL_TEST_URL ?? 'http://127.0.0.1:5188/'
const port = process.env.DDL_CDP_PORT ?? '9233'
const output = process.env.DDL_TEST_OUTPUT ?? '/tmp/astaria-ddl-quick-ui'
const now = new Date(), today = localDay(now), tomorrow = localDay(shiftDay(now, 1)), custom = localDay(shiftDay(now, 4))
const at = now.toISOString(), db = createDatabase(':memory:')
db.setPreference('app', { ...DEFAULT_PREFERENCES, render: { profile: 'economy' } })
db.beginTurn({ requestId: 'ddl-ui-create', conversationId: 'main', text: '物理课 1.2 单元前三道题，ddl 明天', context: {} })
const task = { id: 'ddl-ui-physics', title: '物理课 1.2 单元前三道题', area: null, source: 'ai', inbox: false, leadDays: 3, importance: 2, energy: 'deep', context: ['anywhere'], status: 'todo', due: tomorrow, createdAt: at, updatedAt: at, deletedAt: null }
db.applyOperation({ id: 'ddl-ui-created', requestId: 'ddl-ui-create', summary: '创建 1 项事项：物理课 1.2 单元前三道题', changes: [{ table: 'tasks', id: task.id, before: null, after: task }] })
db.appendMessage({ conversationId: 'main', requestId: 'ddl-ui-create', role: 'assistant', content: '记好了，物理课 1.2 单元前三道题。下面可以直接改截止时间。' })
db.finishTurn('ddl-ui-create', { status: 'completed' })
db.updatePlanner({ type: 'save-block', block: { id: 'ddl-ui-plan', taskId: task.id, date: tomorrow, start: '18:00', end: '18:30', locked: false } }, db.getPlanner().revision)
const service = createLocalService({ db, dataDirectory: ':memory:', vault: { status: async () => true }, complete: async () => { throw Error('DDL controls must not call a model') } })
const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(response => response.json())
const ws = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let serial = 0, sessionId, browserContextId
const pending = new Map(), checks = [], errors = [], requests = []
const send = (method, params = {}, session = sessionId) => new Promise((resolve, reject) => {
  const id = ++serial
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }))
})
const invoke = request => new Promise(resolve => {
  const url = new URL(request.url)
  requests.push({ path: url.pathname, method: request.method })
  const req = Readable.from(request.postData ? [Buffer.from(request.postData)] : [])
  req.url = url.pathname + url.search; req.method = request.method
  req.socket = { remoteAddress: '127.0.0.1', localPort: Number(url.port) }
  req.headers = { host: url.host, origin: url.origin, 'x-astaria-local': '1', 'content-type': 'application/json' }
  service.middleware(req, { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, body }) } }, () => resolve({ status: 404, body: '{}' }))
})
ws.onmessage = event => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
  if (message.method === 'Fetch.requestPaused') {
    void invoke(message.params.request).then(result => send('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: result.status, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }], body: Buffer.from(result.body).toString('base64') }, message.sessionId))
      .catch(reason => { errors.push(String(reason)); void send('Fetch.failRequest', { requestId: message.params.requestId, errorReason: 'Failed' }, message.sessionId) })
  }
  if (!message.id) return
  const callback = pending.get(message.id); pending.delete(message.id)
  if (message.error) callback.reject(message.error); else callback.resolve(message.result)
}
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const wait = async expression => {
  for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await delay(80) }
  throw Error(`Timed out: ${expression}`)
}
const click = async selector => {
  await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled&&!e.closest('[inert]')})()`)
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'});true`)
  await delay(150)
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();if(!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Occluded target '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await delay(80)
}
const setField = async (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
const shot = async name => writeFile(`${output}/${name}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
const open = async () => {
  await send('Page.navigate', { url: base })
  await wait('!!document.querySelector(".home-launch:not(:disabled)")')
  await click('.home-launch')
  await wait('document.querySelector(".home-morph")?.dataset.progress === "1.000"')
  await wait('!!document.querySelector(".xixi-receipt-deadline")')
}
const row = '.home-xixi .xixi-receipt-deadline'
try {
  await mkdir(output, { recursive: true })
  browserContextId = (await send('Target.createBrowserContext', {}, null)).browserContextId
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId }, null)
  sessionId = (await send('Target.attachToTarget', { targetId, flatten: true }, null)).sessionId
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Network.setBypassServiceWorker', { bypass: true })
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] })
  await send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await open()
  assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(row)}).length`), 1)
  checks.push('creation receipt shows one DDL control for its task')
  await click(`${row} .xixi-deadline-shortcuts button:first-child`)
  await wait(`document.querySelector(${JSON.stringify(row)})?.textContent.includes('已有 1 段安排晚于 DDL')`)
  assert.equal(db.getTask(task.id).due, today)
  assert.equal(db.getPlanner().blocks[0].date, tomorrow)
  checks.push('today saves immediately and clearly reports an existing later plan without moving it')
  await click(`${row} .xixi-deadline-shortcuts button:nth-child(2)`)
  await wait(`document.querySelector(${JSON.stringify(row)})?.textContent.includes('截止时间已保存')`)
  assert.equal(db.getTask(task.id).due, tomorrow)
  checks.push('tomorrow updates the same task without sending another message')
  await click(`${row} .xixi-deadline-shortcuts button:last-child`)
  await wait(`document.querySelector(${JSON.stringify(row + ' .xixi-deadline-reveal')})?.dataset.open==='true'`)
  await click(`${row} .xixi-deadline-times button:nth-child(4)`)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(row + ' input[type=time]')}).value`), '20:00')
  assert.equal(db.getTask(task.id).due, tomorrow, 'time pill updates the draft before explicit save')
  await click(`${row} button[type=submit]`)
  await wait(`document.querySelector(${JSON.stringify(row)})?.textContent.includes('20:00')`)
  assert.equal(db.getTask(task.id).due, new Date(`${tomorrow}T20:00:00+08:00`).toISOString())
  await open()
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(row)})?.textContent.includes('20:00')`), true)
  checks.push('20:00 shortcut saves tomorrow at 20:00 Shanghai time and remains after reload')
  await click(`${row} .xixi-deadline-shortcuts button:last-child`)
  await wait(`document.querySelector(${JSON.stringify(row + ' .xixi-deadline-reveal')})?.dataset.open==='true'`)
  await setField(`${row} input[type=date]`, custom); await setField(`${row} input[type=time]`, '12:30')
  await click(`${row} button[type=submit]`)
  await wait(`document.querySelector(${JSON.stringify(row)})?.textContent.includes('12:30')`)
  assert.equal(db.getTask(task.id).due, new Date(`${custom}T12:30:00+08:00`).toISOString())
  await wait(`document.querySelector('.xixi-receipt-details')?.textContent.includes(${JSON.stringify(custom.replaceAll('-', '/'))})&&document.querySelector('.xixi-receipt-details')?.textContent.includes('12:30')`)
  checks.push('custom date and optional time persist through the existing update API')
  await shot('ddl-dark-wide')
  await open()
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(row)})?.textContent.includes('12:30')`), true)
  assert.equal(db.listTasks().length, 1)
  checks.push('reload shows the saved DDL and no duplicate task is created')
  await click(`${row} .xixi-deadline-shortcuts button:nth-child(3)`)
  await wait(`document.querySelector(${JSON.stringify(row + ' .xixi-deadline-status')})?.textContent==='截止时间已保存'`)
  assert.equal(new Date(db.getTask(task.id).due).getMinutes(), 30)
  checks.push('a date shortcut preserves the explicit clock time')
  db.setPreference('app', { ...db.getPreference('app'), theme: 'light' })
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await open()
  await wait('document.querySelector(".home-workspace")?.dataset.theme==="light"')
  await click(`${row} .xixi-deadline-shortcuts button:last-child`)
  await delay(250)
  assert.equal(await evaluate(`(()=>{const root=document.querySelector(${JSON.stringify(row)}),r=root.getBoundingClientRect();return [...root.querySelectorAll('button,input')].every(e=>{const b=e.getBoundingClientRect();return b.left>=r.left-1&&b.right<=r.right+1})})()`), true)
  checks.push('narrow light-mode picker keeps all buttons and fields inside the card')
  assert.equal(await evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(row + ' button[type=submit]')}).getBoundingClientRect(),log=document.querySelector('.home-xixi .xixi-conversation').getBoundingClientRect();return b.bottom<=log.bottom&&b.top>=log.top})()`), true)
  checks.push('expanding the picker brings its save control into the visible chat area')
  await shot('ddl-light-narrow')
  db.updateTask(task.id, { notes: 'A concurrent update must survive' }, db.getTask(task.id).updatedAt)
  await click(`${row} .xixi-deadline-actions .xixi-text-button`)
  await wait(`document.querySelector(${JSON.stringify(row + ' .xixi-deadline-error')})?.textContent.includes('其他窗口更新')`)
  assert.ok(db.getTask(task.id).due)
  checks.push('stale edit shows a conflict and preserves the existing DDL while refreshing its version')
  await click(`${row} .xixi-deadline-actions .xixi-text-button`)
  await wait(`document.querySelector(${JSON.stringify(row)})?.textContent.includes('已清除截止时间')`)
  assert.equal(db.getTask(task.id).due, undefined)
  checks.push('clear DDL removes only the deadline and keeps the task')
  await click(`${row} .xixi-deadline-shortcuts button:last-child`)
  await click(`${row} .xixi-deadline-times button:nth-child(4)`)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(row + ' input[type=date]')}).value`), '')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(row + ' button[type=submit]')}).disabled`), true)
  assert.equal(db.getTask(task.id).due, undefined)
  checks.push('a time-only choice does not assume today when the task has no deadline date')
  await click(`${row} .xixi-deadline-times button:last-child`)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(row + ' input[type=time]')}).value`), '')
  checks.push('all-day shortcut clears the explicit draft time')
  assert.equal(requests.some(item => item.path === '/api/chat' || item.path === '/api/tasks/create'), false)
  assert.equal(db.listTasks().length, 1)
  assert.deepEqual(errors, [])
  await writeFile(`${output}/result.json`, JSON.stringify({ checks, requests, errors }, null, 2))
  console.log(JSON.stringify({ checks: checks.length, output, errors: errors.length }, null, 2))
} catch (reason) {
  await shot('failure').catch(() => {})
  await writeFile(`${output}/failure.json`, JSON.stringify({ error: String(reason), checks, errors, requests }, null, 2))
  throw reason
} finally {
  if (browserContextId) await send('Target.disposeBrowserContext', { browserContextId }, null)
  ws.close(); db.close()
}
