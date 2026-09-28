/** Exercise real buttons against a temporary SQLite database, never user data.
 * Run after npm run build:desktop. CHROME_BINARY may override the browser path. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createDatabase } from '../server/database.mjs'
import { createCompanion } from '../server/companion.mjs'
import { createFreeTime } from '../server/freeTime.mjs'
import { createLocalService } from '../server/index.mjs'
import { createDesktopHandler } from '../desktop/server.mjs'
import { localDay, shiftDay } from '../src/home/agenda.ts'

const automatic = process.argv.includes('--automatic')
const directory = await mkdtemp(join(tmpdir(), 'astaria-free-time-ui-'))
const db = createDatabase(join(directory, 'test.sqlite'))
const companion = createCompanion({ db }), freeTime = createFreeTime({ db })
const today = localDay(new Date()), tomorrow = localDay(shiftDay(new Date(), 1))
const edit = action => db.updatePlanner(action, db.getPlanner().revision)
for (const routine of db.getPlanner().routines) edit({ type: 'delete-routine', id: routine.id })
edit({ type: 'save-routine', routine: { id: 'qa-free', title: '测试空档', kind: 'available', weekdays: [new Date(`${tomorrow}T12:00:00`).getDay()], start: '09:00', end: '14:00', location: '', items: [], enabled: true } })
for (const title of ['测试数学', '测试物理', '测试FRC', '测试剪辑']) companion.saveFreeTimeGoal({ title, minPerWeek: 1, sessionMin: 20, sessionMax: 30 })
const original = freeTime.schedule({ date: today })
const dropped = original.goals.filter(goal => goal.title !== '测试物理')
for (const goal of dropped) db.updateTask(goal.taskId, { status: 'dropped' })
// Occupy one released slot: recovery must find fresh space, not revive it.
const released = original.sessions.find(session => session.taskId === dropped[0].taskId)
const other = db.createTask({ title: '已有固定事项', estimateMin: 30 })
edit({ type: 'save-block', block: { id: 'qa-fixed', taskId: other.id, date: released.date, start: released.start, end: released.end, locked: true } })
const before = db.getPlanner()
if (automatic) db.setPreference('free-time-daily', { date: today, completedAt: new Date().toISOString() })
const service = createLocalService({ db, vault: { status: async () => false }, complete: async () => { throw Error('UI QA must not call a model') }, dataDirectory: directory })
const handler = createDesktopHandler({ root: resolve('dist'), service, token: 'isolated-ui-test-capability-00000000' })
const server = createServer((req, res) => { req.headers['x-astaria-desktop'] = 'isolated-ui-test-capability-00000000'; void handler(req, res) })
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const browser = spawn(process.env.CHROME_BINARY ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(directory, 'chrome')}`,
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank',
], { stdio: 'ignore' })
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))
let ws
try {
  let devtools
  for (let i = 0; i < 100; i++) {
    try { devtools = (await readFile(join(directory, 'chrome', 'DevToolsActivePort'), 'utf8')).trim().split('\n'); break } catch { await delay(100) }
  }
  assert.ok(devtools, 'isolated Chrome starts')
  ws = new WebSocket(`ws://127.0.0.1:${devtools[0]}${devtools[1]}`)
  await new Promise((yes, no) => { ws.onopen = yes; ws.onerror = no })
  let serial = 0, session
  const pending = new Map(), errors = []
  const send = (method, params = {}) => new Promise((yes, no) => {
    const id = ++serial
    pending.set(id, { yes, no })
    ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }))
  })
  ws.onmessage = event => {
    const value = JSON.parse(event.data)
    if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails)
    const callback = pending.get(value.id)
    if (callback) { pending.delete(value.id); value.error ? callback.no(value.error) : callback.yes(value.result) }
  }
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const wait = async expression => {
    for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await delay(100) }
    throw Error(`Timeout: ${expression}`)
  }
  const click = async selector => {
    await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled&&!e.closest('[inert]')})()`)
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'});true`)
    await delay(200)
    const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Button is occluded');return {x,y}})()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  const target = await send('Target.createTarget', { url: 'about:blank' })
  session = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` })
  await wait('!!document.querySelector(".home-brand")')
  await click('.home-brand')
  await wait('!!document.querySelector("#home-menu")')
  await evaluate(`[...document.querySelectorAll('#home-menu button')].find(e=>e.textContent.trim()==='余时').dataset.qaFreeTime='1';true`)
  await click('[data-qa-free-time]')
  await wait('document.querySelectorAll(".free-time-goal-list li").length===4')
  assert.equal(await evaluate('document.querySelectorAll(".free-time-goal-list li[data-status=active]").length'), 4)
  assert.equal(await evaluate('document.querySelector(".free-time-metrics dd").textContent.trim()'), '4 项')
  assert.equal(await evaluate('document.querySelector(".free-time-goal-list").textContent.includes("恢复并安排")'), false)
  if (automatic) {
    await wait('[...document.querySelectorAll(".free-time-goal-list li footer")].every(e=>e.textContent.includes("已安排 1 次"))')
    await click('.free-time-plan [aria-label="查看时间范围"] button:last-child')
    await click('.free-time-week button:nth-child(2)')
  } else {
    assert.deepEqual(db.getPlanner(), before, 'same-day automatic check respects the completed scheduling pass')
    await click('.free-time-plan-actions .free-time-primary')
    await wait('document.querySelector(".free-time-feedback").textContent.includes("已新增 3 段余时安排")')
  }
  const restored = freeTime.state({ date: today })
  assert.equal(restored.freeTimeSessions.length, 4, 'three recovered goals plus existing physics have real blocks')
  assert.ok(restored.freeTimeSessions.every(session => session.date === tomorrow))
  assert.ok(dropped.every(goal => db.getTask(goal.taskId).status === 'dropped'), 'old slots stay inactive')
  assert.deepEqual(db.getPlanner().blocks.find(block => block.id === 'qa-fixed'), before.blocks.find(block => block.id === 'qa-fixed'))
  const recoveredIds = restored.freeTimeSessions.filter(session => dropped.some(goal => goal.id === session.goalId)).map(session => session.id)
  assert.ok(recoveredIds.every(id => db.getPlanner().blocks.some(block => block.id === id)), 'UI results are persisted in planner')
  assert.equal(await evaluate('document.querySelectorAll(".free-time-sessions li").length'), 4, 'view follows the day actually scheduled')
  const revision = db.getPlanner().revision
  await click('.free-time-plan-actions .free-time-primary')
  await wait('document.querySelector(".free-time-feedback").textContent.includes("本次没有新增时段")')
  assert.equal(db.getPlanner().revision, revision, 'repeat click is idempotent')
  await send('Page.reload')
  await wait('!!document.querySelector(".home-brand")')
  await click('.home-brand')
  await wait('!!document.querySelector("#home-menu")')
  await evaluate(`[...document.querySelectorAll('#home-menu button')].find(e=>e.textContent.trim()==='余时').dataset.qaFreeTime='1';true`)
  await click('[data-qa-free-time]')
  await wait('document.querySelectorAll(".free-time-goal-list li[data-status=active]").length===4')
  const persisted = await evaluate(`fetch('/api/planner',{headers:{'X-ASTaria-Local':'1'}}).then(r=>r.json()).then(p=>p.blocks.map(b=>b.id))`)
  assert.ok(recoveredIds.every(id => persisted.includes(id)), 'planner API returns saved blocks after page reload')
  assert.deepEqual(errors, [])
  await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: true, automatic, recoveredGoals: 3, sessions: 4, duplicateWrites: 0 }, null, 2))
  await writeFile(join(directory, 'scheduled.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  console.log(JSON.stringify({ passed: true, automatic, directory, recoveredGoals: 3, sessions: 4, duplicateWrites: 0 }))
} finally {
  ws?.close(); browser.kill('SIGTERM')
  server.closeAllConnections()
  await new Promise(resolveClose => server.close(resolveClose))
  await service.close()
}
