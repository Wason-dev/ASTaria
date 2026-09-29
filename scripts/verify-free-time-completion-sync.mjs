/** Real cross-page clicks against disposable SQLite/Chrome. Never uses user
 * data, credentials, a model, the running preview, or external resources.
 * Run after npm run build:desktop.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createDatabase } from '../server/database.mjs'
import { createCompanion } from '../server/companion.mjs'
import { createFreeTime } from '../server/freeTime.mjs'
import { createLocalService } from '../server/index.mjs'
import { createDesktopHandler } from '../desktop/server.mjs'
import { localDay, shiftDay } from '../src/home/agenda.ts'

const artifacts = resolve('artifacts/verification/free-time-completion-sync')
await mkdir(artifacts, { recursive: true })
const directory = await mkdtemp(join(tmpdir(), 'astaria-completion-sync-'))
const db = createDatabase(join(directory, 'test.sqlite'))
const today = localDay(new Date()), tomorrow = localDay(shiftDay(new Date(), 1))
const fixtureNow = new Date(`${today}T09:05:00`)
const companion = createCompanion({ db, now: () => fixtureNow })
const freeTime = createFreeTime({ db, now: () => fixtureNow })
const edit = action => db.updatePlanner(action, db.getPlanner().revision)
for (const routine of db.getPlanner().routines) edit({ type: 'delete-routine', id: routine.id })
edit({ type: 'save-routine', routine: { id: 'qa-completion-space', title: '独立验收空档', kind: 'available', weekdays: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '18:00', location: '', items: [], enabled: true } })
const goalTitle = '独立验收：持续阅读目标'
const createdGoal = companion.saveFreeTimeGoal({ title: goalTitle, minPerWeek: 3, sessionMin: 20, sessionMax: 20 })
const scheduled = freeTime.schedule({ date: today })
const goal = scheduled.goals.find(item => item.id === createdGoal.id)
assert.ok(goal.taskId, 'fixture has a real backing task')
for (const block of db.getPlanner().blocks) edit({ type: 'delete-block', id: block.id })
const sessions = [
  { id: 'free-time:qa-completion-today-a', taskId: goal.taskId, date: today, start: '09:00', end: '09:20', locked: false },
  { id: 'free-time:qa-completion-today-b', taskId: goal.taskId, date: today, start: '10:00', end: '10:20', locked: false },
  { id: 'free-time:qa-completion-tomorrow', taskId: goal.taskId, date: tomorrow, start: '09:00', end: '09:20', locked: false },
]
for (const block of sessions) edit({ type: 'save-block', block })
const ordinary = db.createTask({ title: '独立验收：普通待办事项', estimateMin: 20, inbox: false })
edit({ type: 'save-block', block: { id: 'qa-completion-ordinary', taskId: ordinary.id, date: today, start: '11:00', end: '11:20', locked: false } })
// The real service clock can be later than the fixture morning. Do not let its
// daily scheduler add slots merely because today's test slots are now in past.
db.setPreference('free-time-daily', { date: today, completedAt: fixtureNow.toISOString(), policyVersion: 2 })

let modelCalls = 0
const service = createLocalService({
  db, vault: { status: async () => false }, dataDirectory: directory,
  complete: async () => { modelCalls += 1; throw Error('Completion sync QA must not call a model') },
  fetcher: async () => { throw Error('Completion sync QA must not access an external provider') },
})
const root = resolve(process.env.COMPLETION_QA_DIST ?? 'dist')
const index = await readFile(join(root, 'index.html'), 'utf8')
const buildAssets = await Promise.all([...index.matchAll(/(?:src|href)="(\/assets\/[^\"]+\.(?:js|css))"/g)].map(async ([, path]) => ({
  path, sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex'),
})))
const token = 'isolated-completion-sync-capability-00000000'
const handler = createDesktopHandler({ root, service, token })
const server = createServer((req, res) => { req.headers['x-astaria-desktop'] = token; void handler(req, res) })
await new Promise(yes => server.listen(0, '127.0.0.1', yes))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = spawn(process.env.CHROME_BINARY ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--disable-sync', '--remote-debugging-port=0',
  `--user-data-dir=${join(directory, 'chrome')}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank',
], { stdio: 'ignore' })
const delay = ms => new Promise(yes => setTimeout(yes, ms))
const checks = [], errors = [], externalRequests = [], writes = []
let ws, session, screenshot
const result = { passed: false, buildAssets, fixture: { today, tomorrow, now: fixtureNow.toISOString(), sessions }, checks, errors, externalRequests, writes }

function checkGoal(expectedCompleted, label) {
  assert.equal(db.getTask(goal.taskId).status, 'todo', `${label}: backing task remains todo`)
  const saved = db.getCompanionState()
  assert.equal(saved.freeTimeGoals.find(item => item.id === goal.id).status, 'active', `${label}: goal remains active`)
  assert.deepEqual(saved.freeTimeHistory.map(item => item.sessionId).sort(), [...expectedCompleted].sort(), `${label}: only intended sessions are completed`)
  assert.deepEqual(db.getPlanner().blocks.filter(block => block.taskId === goal.taskId).map(block => block.id).sort(), sessions.map(block => block.id).sort(), `${label}: all other sessions survive`)
  checks.push(label)
}

try {
  let devtools
  for (let i = 0; i < 100; i++) {
    try { devtools = (await readFile(join(directory, 'chrome', 'DevToolsActivePort'), 'utf8')).trim().split('\n'); break } catch { await delay(100) }
  }
  assert.ok(devtools, 'isolated Chrome starts')
  ws = new WebSocket(`ws://127.0.0.1:${devtools[0]}${devtools[1]}`)
  await new Promise((yes, no) => { ws.onopen = yes; ws.onerror = no })
  let serial = 0
  const pending = new Map()
  const send = (method, params = {}, targetSession = session) => new Promise((yes, no) => {
    const id = ++serial
    pending.set(id, { yes, no })
    ws.send(JSON.stringify({ id, method, params, ...(targetSession ? { sessionId: targetSession } : {}) }))
  })
  ws.onmessage = event => {
    const value = JSON.parse(event.data)
    if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails)
    if (value.method === 'Fetch.requestPaused') {
      const request = value.params.request
      const allowed = request.url.startsWith(`${origin}/`) || request.url.startsWith('data:') || request.url.startsWith('blob:')
      if (!allowed) externalRequests.push(request.url)
      if (request.method === 'POST') writes.push({ path: new URL(request.url).pathname, body: request.postData ? JSON.parse(request.postData) : null })
      void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
        requestId: value.params.requestId, ...(!allowed ? { errorReason: 'BlockedByClient' } : {}),
      }, value.sessionId).catch(reason => errors.push(String(reason)))
    }
    const callback = pending.get(value.id)
    if (callback) { pending.delete(value.id); value.error ? callback.no(value.error) : callback.yes(value.result) }
  }
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails))
    return response.result.value
  }
  const wait = async expression => {
    for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await delay(100) }
    throw Error(`Timeout: ${expression}`)
  }
  const click = async selector => {
    await wait(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e && !e.disabled && !e.closest('[inert]'); })()`)
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'}); true`)
    // Navigation pills animate even with reduced motion. Wait for the actual
    // hit target instead of clicking a still-clipped menu label.
    await wait(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })()`)
    const point = await evaluate(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)}), r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (!e.contains(document.elementFromPoint(x, y))) throw Error('Occluded: ' + ${JSON.stringify(selector)});
      return { x, y };
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  const clickText = async (selector, text) => {
    await wait(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(e => e.textContent.trim() === ${JSON.stringify(text)} && !e.disabled && !e.closest('[inert]'))`)
    await evaluate(`(() => { document.querySelectorAll('[data-qa-click]').forEach(e => e.removeAttribute('data-qa-click')); const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(text)} && !e.disabled && !e.closest('[inert]')); e.dataset.qaClick = 'true'; return true; })()`)
    await click('[data-qa-click]')
  }
  const navigate = async name => {
    await click('.home-brand')
    await clickText('#home-menu button', name)
    await wait(`document.querySelector(${JSON.stringify(name === '余时' ? '.free-time-page' : name === '工作台' ? '.workbench' : '.planner')})?.dataset.active === 'true'`)
  }
  const freeRow = start => `.free-time-sessions > li:nth-child(${start === '09:00' ? 1 : 2})`
  const verifyFreeRow = async (start, completed) => {
    const selector = freeRow(start)
    await wait(`document.querySelector(${JSON.stringify(selector)})?.dataset.completed === ${JSON.stringify(String(completed))}`)
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(`${selector} .free-time-session > time`)}).textContent.startsWith(${JSON.stringify(start)})`), `expected free-time row ${start}`)
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${selector} .free-time-complete`)}).disabled`), completed)
  }
  const planSlot = (date, start, title = goalTitle) => `[data-period-current="true"] .pl-day-column[data-date="${date}"] .pl-slot[data-kind="plan"][aria-label*="${title}"][aria-label*="${start}–"]`
  const verifyPlanSlot = async (date, start, completed, title = goalTitle) => {
    await wait(`document.querySelector(${JSON.stringify(planSlot(date, start, title))})?.dataset.done === ${JSON.stringify(String(completed))}`)
  }
  const closeDialog = async () => {
    await click('.pl-dialog[open] .pl-dialog-header button')
    await wait('!document.querySelector(".pl-dialog[open]")')
  }
  const plannerMap = () => evaluate(`fetch('/api/planner', { headers: { 'X-ASTaria-Local': '1' } }).then(response => response.json()).then(state => state.completedFreeTimeSessions)`)
  screenshot = async name => writeFile(join(artifacts, name), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  const target = await send('Target.createTarget', { url: 'about:blank' })
  session = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Network.setBypassServiceWorker', { bypass: true })
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const NativeDate = Date, started = performance.now(), base = ${fixtureNow.getTime()};
    class FixtureDate extends NativeDate {
      constructor(...args) { if (args.length) super(...args); else super(base + performance.now() - started); }
      static now() { return base + performance.now() - started; }
    }
    window.Date = FixtureDate;
    localStorage.setItem('astaria-sqlite-migration-v1', 'complete');
  })();` })
  await send('Page.navigate', { url: origin })
  await send('Page.bringToFront')
  await wait('!!document.querySelector(".home-brand")')

  await navigate('工作台')
  const goalCard = `.wb-task[data-task-id="${goal.taskId}"]`
  await click(goalCard)
  await wait('!!document.querySelector(".wb-focus")')
  await clickText('.wb-clock-actions button', '完成本次')
  await wait('!!document.querySelector(".wb-finished")')
  checkGoal([sessions[0].id], 'Workbench completes the pinned session without ending the ongoing goal')
  await screenshot('workbench-session-completed.png')
  await click('.wb-reopen')
  await wait('!document.querySelector(".wb-finished")')
  checkGoal([], 'Workbench undo restores only the selected session')
  edit({ type: 'save-block', block: { ...sessions[0], start: '09:25', end: '09:45' } })
  await evaluate("window.dispatchEvent(new Event('focus'))")
  await wait('document.querySelector(".wb-empty")?.textContent.includes("安排已变更")')
  assert.equal(db.getCompanionState().freeTimeHistory.length, 0)
  checks.push('Moving the selected session invalidates focus and cannot complete the moved session silently')
  edit({ type: 'save-block', block: sessions[0] })
  await navigate('余时')
  await wait('document.querySelectorAll(".free-time-sessions > li").length === 2')
  await verifyFreeRow('09:00', false)
  await verifyFreeRow('10:00', false)
  await click(`${freeRow('09:00')} .free-time-complete`)
  await verifyFreeRow('09:00', true)
  await verifyFreeRow('10:00', false)
  checkGoal([sessions[0].id], 'Completing the first free-time row completes only that session')

  await navigate('日程')
  await click('.pl-segment button[data-mode="day"]')
  await verifyPlanSlot(today, '09:00', true)
  await verifyPlanSlot(today, '10:00', false)
  assert.deepEqual(Object.keys(await plannerMap()), [sessions[0].id])
  await screenshot('planner-one-session-completed.png')
  await click('.pl-day-arrows button[aria-label="后一天"]')
  await verifyPlanSlot(tomorrow, '09:00', false)
  checks.push('Planner shows completion only on the matching date and block, not the next same-day or next-day session')
  await click('.pl-day-arrows button[aria-label="前一天"]')
  await click(planSlot(today, '09:00'))
  await clickText('.pl-dialog[open] button', '撤回本次完成')
  await wait(`[...document.querySelectorAll('.pl-dialog[open] button')].some(e => e.textContent.trim() === '完成本次')`)
  await closeDialog()
  checkGoal([], 'Reopening from planner removes just the matching completion record')
  assert.deepEqual(await plannerMap(), {})

  await navigate('余时')
  await verifyFreeRow('09:00', false)
  await verifyFreeRow('10:00', false)
  checks.push('Returning to free time restores the completed row’s enabled completion button without reload')
  await navigate('日程')
  await click(planSlot(today, '10:00'))
  await clickText('.pl-dialog[open] button', '完成本次')
  await wait(`[...document.querySelectorAll('.pl-dialog[open] button')].some(e => e.textContent.trim() === '撤回本次完成')`)
  await closeDialog()
  await verifyPlanSlot(today, '09:00', false)
  await verifyPlanSlot(today, '10:00', true)
  checkGoal([sessions[1].id], 'Completing the second session in planner preserves the first and next-day sessions')

  await navigate('余时')
  await verifyFreeRow('09:00', false)
  await verifyFreeRow('10:00', true)
  await screenshot('free-time-planner-change-synced.png')
  await clickText('.free-time-plan [aria-label="查看时间范围"] button', '未来七天')
  await click('.free-time-week button:nth-child(2)')
  await wait('document.querySelectorAll(".free-time-sessions > li").length === 1')
  await verifyFreeRow('09:00', false)
  checks.push('Free time reflects the planner completion and leaves tomorrow’s session available')

  await navigate('日程')
  await clickText('.pl-board-toolbar button', '今天')
  await click(planSlot(today, '11:00', ordinary.title))
  await clickText('.pl-dialog[open] button', '标记完成')
  await wait(`[...document.querySelectorAll('.pl-dialog[open] button')].some(e => e.textContent.trim() === '撤回完成')`)
  assert.equal(db.getTask(ordinary.id).status, 'done', 'ordinary task still completes the whole task')
  checkGoal([sessions[1].id], 'Ordinary task completion does not alter free-time goals or history')
  await clickText('.pl-dialog[open] button', '撤回完成')
  await wait(`[...document.querySelectorAll('.pl-dialog[open] button')].some(e => e.textContent.trim() === '标记完成')`)
  assert.equal(db.getTask(ordinary.id).status, 'todo', 'ordinary task still reopens to its previous status')
  await closeDialog()
  checkGoal([sessions[1].id], 'Ordinary task reopen preserves existing per-session completion')
  assert.deepEqual(Object.keys(await plannerMap()), [sessions[1].id])

  await send('Page.reload')
  await wait('!!document.querySelector(".home-brand")')
  await navigate('余时')
  await verifyFreeRow('09:00', false)
  await verifyFreeRow('10:00', true)
  checkGoal([sessions[1].id], 'Per-session completion persists after reload with the goal still active')
  assert.equal(writes.filter(write => write.path === '/api/companion/free-time/complete').length, 3)
  assert.equal(writes.filter(write => write.path === '/api/companion/free-time/reopen').length, 2)
  assert.equal(modelCalls, 0)
  assert.deepEqual(errors, [])
  assert.deepEqual(externalRequests, [])
  result.passed = true
  result.modelCalls = modelCalls
  result.final = { taskStatus: db.getTask(goal.taskId).status, goalStatus: db.getCompanionState().freeTimeGoals.find(item => item.id === goal.id).status, completed: Object.keys(await plannerMap()), ordinaryStatus: db.getTask(ordinary.id).status }
} catch (error) {
  result.error = error.stack ?? String(error)
  await screenshot?.('failure.png').catch(() => {})
  throw error
} finally {
  ws?.close()
  const stopped = new Promise(yes => browser.once('exit', yes))
  browser.kill('SIGTERM')
  await Promise.race([stopped, delay(5000)])
  if (browser.exitCode === null && browser.signalCode === null) {
    browser.kill('SIGKILL')
    await Promise.race([stopped, delay(5000)])
  }
  server.closeAllConnections()
  await new Promise(yes => server.close(yes))
  await service.close()
  await rm(directory, { recursive: true, force: true })
  result.cleanup = { browserExited: browser.exitCode !== null || browser.signalCode !== null, serverClosed: !server.listening, serviceClosed: true, temporaryProfileAndDatabaseRemoved: true, existingPreviewTouched: false }
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ passed: result.passed, checks, cleanup: result.cleanup, result: join(artifacts, 'result.json') }))
}
