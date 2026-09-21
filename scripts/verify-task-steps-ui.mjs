/**
 * Self-contained UI verification: temporary Vite + Chrome, in-memory SQLite and
 * a scripted provider. Never connects to a running browser, personal database,
 * Keychain or paid provider. All /api requests are intercepted through CDP.
 * Run: node scripts/verify-task-steps-ui.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { getPreferences } from '../server/preferences.mjs'
import { toggleTaskStep } from '../server/taskSteps.mjs'
import { createCompanion } from '../server/companion.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'astaria-task-steps-ui-runtime-'))
const output = process.env.TASK_STEPS_QA_OUTPUT ?? await mkdtemp(join(tmpdir(), 'astaria-task-steps-ui-results-'))
const profile = join(temporary, 'chrome-profile')
const db = createDatabase(':memory:')
const task = db.createTask({ title: 'Agentic AI 开学作业', notes: '完成环境准备、两份 notebook 与练习，再核对提交材料。', estimateMin: 90, inbox: false })
const other = db.createTask({ title: '下一项独立任务', inbox: false })
const assignment = [
  { title: '加入班级群', detail: '群昵称改为真实姓名-班级，保存截图' },
  { title: '加入 Google Classroom', detail: '用户名与 MB 一致，保存截图' },
  { title: '准备 Python 3.13 与 Jupyter', detail: '打开 Jupyter，确认解释器版本' },
  { title: '跑通环境检查 notebook', detail: '逐个运行单元格，保存 L1_env_check.ipynb' },
  { title: '跑通 Python 基础 notebook', detail: '完成所有单元格并保存运行结果' },
  { title: '完成 WorkBuddy 小练习', detail: '运行不超过 10 行的代码，截图避开 Key' },
  { title: '核对并提交材料', detail: '三张截图与两份已运行的 notebook' },
]
const toolReply = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const checks = [], errors = [], requests = [], layouts = [], providerRequests = [], blockedRequests = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let chrome, vite, ws, send, evaluate, shot, failure, checkMode = null, releaseCheck, heldCheck = false, stopping = false
const service = createLocalService({
  db, dataDirectory: ':memory:',
  vault: { status: async () => true, read: async () => { throw Error('QA must never read credentials') } },
  complete: async payload => {
    providerRequests.push(payload)
    const number = providerRequests.length
    if (number === 1) return toolReply('read_task_steps', { taskId: task.id })
    if (number === 2) {
      const read = JSON.parse(payload.messages.filter(message => message.role === 'tool').at(-1).content)
      assert.equal(read.error, undefined, 'read_task_steps executed through the real tool loop')
      assert.equal(read.task.id, task.id)
      assert.equal(read.total, 0)
      return toolReply('save_task_steps', { taskId: task.id, expectedUpdatedAt: read.task.updatedAt, steps: assignment })
    }
    assert.equal(number, 3, 'no unexpected model calls')
    if (db.getTask(task.id).subSteps?.length !== 7) console.error('save_task_steps outcome', db.listMessages().filter(message => message.role === 'tool').at(-1)?.content)
    return { choices: [{ message: { role: 'assistant', content: '拆好了，先从加入班级群开始。每完成一小步，就在任务步骤里勾一下。' } }] }
  },
})

const invoke = async request => {
  const url = new URL(request.url)
  const record = { path: url.pathname, method: request.method }
  requests.push(record)
  if (url.pathname === '/api/tasks/steps/check') {
    if (checkMode === 'hold') {
      checkMode = null; heldCheck = true
      await new Promise(resolve => { releaseCheck = resolve })
      heldCheck = false
    } else if (checkMode === 'fail') {
      checkMode = null
      record.status = 503
      return { status: 503, body: JSON.stringify({ error: '隔离测试：步骤尚未保存，请重试' }) }
    } else if (checkMode === 'conflict') {
      checkMode = null
      const current = db.getTask(task.id)
      toggleTaskStep(db, { taskId: task.id, stepId: current.subSteps[1].id, checked: true, expectedUpdatedAt: current.updatedAt })
    }
  }
  return new Promise(resolve => {
    const req = Readable.from(request.postData ? [Buffer.from(request.postData)] : [])
    req.url = url.pathname + url.search
    req.method = request.method
    req.socket = { remoteAddress: '127.0.0.1', localPort: Number(url.port) }
    req.headers = { host: url.host, origin: url.origin, 'x-astaria-local': '1', 'content-type': 'application/json' }
    const res = { statusCode: 200, setHeader() {}, end(body) { record.status = this.statusCode; resolve({ status: this.statusCode, body }) } }
    service.middleware(req, res, () => resolve({ status: 404, body: '{}' }))
  })
}

try {
  await mkdir(output, { recursive: true })
  // configFile:false is essential: the app's normal Vite config installs the
  // local service plugin, which is intentionally absent from this server.
  vite = await createServer({
    configFile: false, root, cacheDir: join(temporary, 'vite-cache'),
    plugins: [react(), tailwindcss()], logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
  })
  vite.middlewares.use((req, res, next) => {
    if (!req.url?.startsWith('/api/')) return next()
    res.statusCode = 503
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: 'QA API request escaped interception' }))
  })
  await vite.listen()
  const address = vite.httpServer.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}/`
  chrome = spawn(process.env.TASK_STEPS_QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', 'about:blank',
  ], { stdio: 'ignore' })
  let chromeError
  chrome.on('error', reason => { chromeError = reason })
  let debugPort
  for (let count = 0; count < 150; count++) {
    if (chromeError) throw chromeError
    try { debugPort = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (debugPort) break } catch {}
    if (chrome.exitCode !== null) throw Error(`Temporary Chrome exited: ${chrome.exitCode}`)
    await delay(100)
  }
  assert.ok(debugPort, 'temporary Chrome writes its own debugging port')
  const target = (await fetch(`http://127.0.0.1:${debugPort}/json`).then(response => response.json())).find(item => item.type === 'page')
  assert.ok(target, 'fresh temporary browser has a page')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let serial = 0
  const pending = new Map()
  send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial
    const timeout = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)) }, 15000)
    pending.set(id, { resolve, reject, timeout })
    ws.send(JSON.stringify({ id, method, params }))
  })
  ws.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const callback = pending.get(message.id)
      if (!callback) return
      pending.delete(message.id); clearTimeout(callback.timeout)
      message.error ? callback.reject(Error(JSON.stringify(message.error))) : callback.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    else if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params
      const url = new URL(request.url)
      const handle = async () => {
        if (url.origin !== new URL(base).origin) {
          blockedRequests.push(request.url)
          await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
        } else if (url.pathname.startsWith('/api/')) {
          const response = await invoke(request)
          await send('Fetch.fulfillRequest', { requestId, responseCode: response.status,
            responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }],
            body: Buffer.from(response.body).toString('base64') })
        } else await send('Fetch.continueRequest', { requestId })
      }
      void handle().catch(reason => { if (!stopping) errors.push(String(reason)) })
    }
  }
  evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const wait = async expression => {
    for (let count = 0; count < 180; count++) { if (await evaluate(expression)) return; await delay(75) }
    throw Error(`Timeout: ${expression}`)
  }
  const waitNode = async condition => {
    for (let count = 0; count < 180; count++) { if (condition()) return; await delay(75) }
    throw Error('Timeout waiting for isolated service state')
  }
  const check = async (name, expression) => {
    const pass = typeof expression === 'string' ? await evaluate(expression) : expression
    checks.push({ name, pass }); assert.equal(pass, true, name); console.log('PASS', name)
  }
  const click = async selector => {
    await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled&&!e.closest('[inert]')})()`)
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'});true`)
    await wait(`(async()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||e.closest('[inert]'))return false;const a=e.getBoundingClientRect();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const b=e.getBoundingClientRect();return b.width>0&&b.height>0&&Math.abs(a.x-b.x)<.1&&Math.abs(a.y-b.y)<.1&&e.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))})()`)
    const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    await delay(90)
  }
  const byText = async (selector, text) => {
    await evaluate(`(()=>{document.querySelectorAll('[data-qa-click]').forEach(e=>e.removeAttribute('data-qa-click'));const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing '+${JSON.stringify(text)});e.dataset.qaClick='target';return true})()`)
    await click('[data-qa-click=target]')
  }
  const fill = async (selector, value) => {
    await click(selector)
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).select();true`)
    await send('Input.insertText', { text: value })
    await wait(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(value)}`)
  }
  const key = async (value, code = value, modifiers = 0) => {
    const windowsVirtualKeyCode = { Escape: 27, Enter: 13, Tab: 9, ' ': 32 }[value] ?? 0
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code, modifiers, windowsVirtualKeyCode, ...(value === 'Enter' ? { text: '\r' } : {}) })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code, modifiers, windowsVirtualKeyCode })
  }
  const menu = async name => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
    await delay(250)
    await evaluate('document.querySelector(".home-brand").focus({preventScroll:true});true')
    if (await evaluate('document.querySelector("#home-menu").dataset.open!=="true"')) await key('Enter')
    await wait('document.querySelector("#home-menu").dataset.open==="true"&&!document.querySelector("#home-menu").inert')
    await byText('#home-menu button', name)
    await delay(350)
  }
  const focus = async id => {
    await click(`.wb-task[data-task-id="${id}"]`)
    await wait('!!document.querySelector(".wb-task-steps")&&!document.querySelector(".wb-stage").inert')
    await delay(200)
  }
  const firstPage = async () => {
    while (await evaluate('!!document.querySelector(".wb-steps-pages button:first-child:not(:disabled)")')) await click('.wb-steps-pages button:first-child')
  }
  const inputAt = index => `.wb-steps-list li:nth-child(${index}) input[type=checkbox]`
  const checkedAt = index => `document.querySelector(${JSON.stringify(inputAt(index))})?.checked===true`
  const uncheckedAt = index => `document.querySelector(${JSON.stringify(inputAt(index))})?.checked===false`
  const settledSave = () => wait('!document.querySelector(".wb-steps-list").getAttribute("aria-busy")||document.querySelector(".wb-steps-list").getAttribute("aria-busy")==="false"')
  const snapshot = () => db.getTask(task.id)
  const handoffField = name => `.wb-focus-main .wb-focus-handoff textarea[name="${name}"]`
  const handoffRecord = () => db.getCompanionState().handoffs.find(record => record.taskId === task.id)
  const timerState = () => evaluate(`JSON.parse(localStorage.getItem('astaria-focus-v1')).tasks[${JSON.stringify(task.id)}]`)
  const focusMode = mode => wait(`document.querySelector('.wb-focus-main .wb-focus-modes')?.dataset.mode===${JSON.stringify(mode)}&&document.querySelector('.wb-focus-view[data-view=${mode}]')?.getAttribute('aria-hidden')==='false'&&!document.querySelector('.wb-focus-view[data-view=${mode}]')?.inert`)
  const verifyViews = async (name, mode) => {
    await focusMode(mode)
    await check(name, `(()=>{const main=document.querySelector('.wb-focus-main'),views=[...main.querySelectorAll('.wb-focus-view')];return views.length===2&&views.every(view=>view.inert===(view.dataset.view!==${JSON.stringify(mode)})&&view.getAttribute('aria-hidden')===String(view.dataset.view!==${JSON.stringify(mode)}))})()`)
  }
  const rememberHandoffNodes = () => evaluate(`(()=>{const main=document.querySelector('.wb-focus-main');window.__qaHandoffNodes={main,glass:main.querySelector('.home-glass-surface'),focus:main.querySelector('.wb-focus-view[data-view=focus]'),handoff:main.querySelector('.wb-focus-view[data-view=handoff]'),steps:document.querySelector('.wb-task-steps')};return true})()`)
  const sameHandoffNodes = `(()=>{const n=window.__qaHandoffNodes,main=document.querySelector('.wb-focus-main');return n.main===main&&n.glass===main.querySelector('.home-glass-surface')&&n.focus===main.querySelector('.wb-focus-view[data-view=focus]')&&n.handoff===main.querySelector('.wb-focus-view[data-view=handoff]')&&n.steps===document.querySelector('.wb-task-steps')&&main.querySelectorAll('.home-glass-surface').length===1})()`
  const visibleSteps = `(()=>{const steps=document.querySelector('.wb-task-steps'),list=steps.querySelector('.wb-steps-list');return getComputedStyle(steps).display!=='none'&&getComputedStyle(steps).visibility!=='hidden'&&!steps.closest('[inert]')&&list.getBoundingClientRect().height>0&&!document.querySelector('.wb-focus-steps .xc-handoff')})()`
  const alignedFocusActions = `(()=>{const row=document.querySelector('.wb-focus-primary-actions'),buttons=[...row.querySelectorAll('button')],box=row.getBoundingClientRect();if(buttons.length!==2||!buttons[0].classList.contains('wb-action')||!buttons[1].classList.contains('wb-handoff-trigger'))return false;const[a,b]=buttons.map(button=>button.getBoundingClientRect());return Math.abs(a.top-b.top)<=1&&Math.abs(a.height-b.height)<=1&&a.right<=b.left&&[a,b].every(rect=>rect.left>=box.left-1&&rect.right<=box.right+1&&rect.height>=36)})()`
  const openHandoff = async (label, field) => {
    await byText('.wb-focus-view[data-view=focus] .wb-handoff-trigger', label)
    await focusMode('handoff')
    await wait(`document.activeElement.matches(${JSON.stringify(handoffField(field))})`)
  }
  const backToFocus = async () => {
    await click('.wb-focus-main .wb-handoff-back')
    await focusMode('focus')
  }
  shot = async name => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
    await delay(150)
    await writeFile(join(output, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  }

  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Network.setBypassServiceWorker', { bypass: true }); await send('Network.setCacheDisabled', { cacheDisabled: true })
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  await send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('astaria-sqlite-migration-v1','complete')` })
  await send('Page.navigate', { url: base })
  await wait('!!document.querySelector(".home-brand")&&!!document.querySelector(".home-current-title:not(:disabled)")')
  await menu('工作台'); await focus(task.id)
  await check('return arrow keeps its round button and accessible label without a hover tooltip', `(()=>{const back=document.querySelector('.wb-back');return !!back.querySelector('svg')&&back.getAttribute('aria-label')==='重新选择'&&!back.querySelector('[role=tooltip],.wb-tooltip')&&!back.hasAttribute('data-tooltip')&&!back.hasAttribute('title')&&getComputedStyle(back).borderRadius==='50%'})()`)
  await check('start focus and the single handoff pill share a row and equal height', alignedFocusActions)
  await check('empty task offers a draft-only step request', '!!document.querySelector(".wb-steps-empty")&&!document.querySelector(".wb-steps-list")')
  await check('legacy preview and customize controls are removed', '!document.querySelector(".wb-customize-trigger,.wb-customize")&&![...document.querySelectorAll(".wb-toolbar button")].some(e=>/示例预览|自定义/.test(e.textContent))')
  await byText('.wb-steps-empty button', '让析熙拆步骤')
  await check('step request fills and focuses the right chat draft', 'document.activeElement.id==="wb-xixi-input"&&document.activeElement.value.includes("拆成可以逐项勾选")')
  await check('draft action makes no provider request', providerRequests.length === 0)
  await shot('empty-step-draft')
  await send('Input.insertText', { text: '加入班级群并改实名、加入 Classroom、准备 Python/Jupyter、运行两份 notebook、完成 WorkBuddy 小练习、核对提交。' })
  await click('.wb-xixi .xixi-send')
  await wait('document.querySelector(".wb-steps-progress")?.getAttribute("aria-valuemax")==="7"')
  await check('real AI tool loop saved seven parts on the selected task', providerRequests.length === 3 && snapshot().subSteps.length === 7 && db.listTasks().length === 2)
  await check('AI-created steps start unchecked and preserve task status', snapshot().subSteps.every(step => !step.doneAt) && snapshot().status === 'todo')

  checkMode = 'hold'
  await click(inputAt(1)); await waitNode(() => heldCheck)
  await check('pending save never shows a completed checkbox', uncheckedAt(1))
  await check('pending save prevents concurrent checkbox writes', '[...document.querySelectorAll(".wb-steps-list input")].every(e=>e.disabled)')
  releaseCheck(); await wait(checkedAt(1)); await settledSave()
  await check('checkbox completion is durable in SQLite', Boolean(snapshot().subSteps[0].doneAt))
  await click(inputAt(1)); await wait(uncheckedAt(1)); await settledSave()
  await check('checkbox supports undoing completion', !snapshot().subSteps[0].doneAt)
  await evaluate(`document.querySelector(${JSON.stringify(inputAt(1))}).focus();true`); await key(' ', 'Space')
  await wait(checkedAt(1)); await settledSave()
  await check('native checkbox supports keyboard Space', Boolean(snapshot().subSteps[0].doneAt))
  await click('.wb-steps-pages button:last-child')
  await check('pagination reaches the last part', 'document.querySelector(".wb-steps-list").textContent.includes("核对并提交材料")')
  const pageBefore = await evaluate('document.querySelector(".wb-steps-pages>span").textContent')
  await click(inputAt(1)); await wait(checkedAt(1)); await settledSave()
  await check('completion never automatically changes pages', await evaluate('document.querySelector(".wb-steps-pages>span").textContent') === pageBefore)
  await firstPage()
  await click('.wb-back'); await focus(task.id)
  await check('leaving and reopening retains progress', checkedAt(1))
  await send('Page.reload', { ignoreCache: true })
  await wait('!!document.querySelector(".home-brand")&&!!document.querySelector(".home-current-title:not(:disabled)")')
  await menu('工作台'); await focus(task.id)
  await check('full refresh reloads durable progress', checkedAt(1))

  checkMode = 'fail'
  await click(inputAt(3)); await wait('document.querySelector(".wb-steps-error")?.textContent.includes("隔离测试")')
  await check('failed save never presents fake completion', uncheckedAt(3))
  await check('failed save preserves stored progress', !snapshot().subSteps[2].doneAt && Boolean(snapshot().subSteps[0].doneAt))
  await check('failed save clearly reports not saved', 'document.querySelector(".wb-steps-save").textContent.includes("未保存")')
  await shot('failed-step-save')
  checkMode = 'conflict'
  const readsBeforeConflict = requests.filter(request => request.path === '/api/tasks').length
  await click(inputAt(3)); await wait('!!document.querySelector(".wb-steps-error")&&document.querySelector(".wb-steps-list li:nth-child(2) input").checked')
  await check('409 triggers a refresh of newer shared progress', requests.some(request => request.path === '/api/tasks/steps/check' && request.status === 409) && requests.filter(request => request.path === '/api/tasks').length > readsBeforeConflict)
  await check('conflicted step stays unchecked while external completion appears', await evaluate(uncheckedAt(3)) && await evaluate(checkedAt(2)))
  await click(inputAt(3)); await wait(checkedAt(3)); await settledSave()
  await check('retry uses refreshed task version', Boolean(snapshot().subSteps[2].doneAt) && await evaluate('!document.querySelector(".wb-steps-error")'))

  checkMode = 'hold'
  await click(inputAt(4)); await waitNode(() => heldCheck)
  await click('.wb-back'); await focus(other.id)
  releaseCheck(); await waitNode(() => Boolean(snapshot().subSteps[3].doneAt)); await delay(200)
  await check('late save cannot replace another selected task', 'document.querySelector(".wb-focus-main h2").textContent==="下一项独立任务"&&!!document.querySelector(".wb-steps-empty")')
  await click('.wb-back'); await focus(task.id)
  await check('late successful save remains durable on its original task', checkedAt(4))

  // Complete all remaining parts through the UI, including the next page.
  for (let page = 0; page < 2; page++) {
    const count = await evaluate('document.querySelectorAll(".wb-steps-list input").length')
    for (let index = 1; index <= count; index++) {
      if (await evaluate(uncheckedAt(index))) { await click(inputAt(index)); await wait(checkedAt(index)); await settledSave() }
    }
    if (await evaluate('!!document.querySelector(".wb-steps-pages button:last-child:not(:disabled)")')) await click('.wb-steps-pages button:last-child')
  }
  await check('all completed parts suggest a final submission check', 'document.querySelector(".wb-steps-next").textContent.includes("步骤完成，可以核对提交")')
  await check('checking every part does not complete the whole task', snapshot().status === 'todo' && !snapshot().doneAt)
  await firstPage()
  await click(inputAt(4)); await wait(uncheckedAt(4)); await settledSave()
  await check('next step follows a completion undo', 'document.querySelector(".wb-steps-next p").textContent==="跑通环境检查 notebook"')

  // The left glass keeps both views mounted. The middle glass remains a step
  // list throughout the handoff flow, including its current pagination state.
  await verifyViews('focus view is active and the mounted handoff view is inert', 'focus')
  await check('handoff retains all four fields inside the left glass', `JSON.stringify([...document.querySelectorAll('.wb-focus-main .wb-focus-handoff textarea')].map(e=>e.name).sort())===JSON.stringify(['materials','nextStep','obstacle','progress'])`)
  await rememberHandoffNodes()
  await click('.wb-steps-pages button:last-child')
  const handoffPage = await evaluate('document.querySelector(".wb-steps-pages>span").textContent')
  const handoffStepSnapshot = JSON.stringify(snapshot().subSteps)
  await click('.wb-focus-view[data-view=focus] .wb-clock-actions .wb-action')
  await wait(`JSON.parse(localStorage.getItem('astaria-focus-v1')).tasks[${JSON.stringify(task.id)}].phase==='running'`)
  await delay(150)
  await openHandoff('留个接力', 'progress')
  await verifyViews('opening handoff makes the timer view inert and aria-hidden', 'handoff')
  await check('leave-a-handoff pauses the running focus timer', (await timerState()).phase === 'paused')
  await check('handoff opens inside the existing single glass surface', sameHandoffNodes)
  await check('handoff leaves the middle task-step list visible', visibleSteps)
  await check('handoff keeps the selected step page', await evaluate('document.querySelector(".wb-steps-pages>span").textContent') === handoffPage)
  await check('hidden timer controls cannot receive focus', `(()=>{document.querySelector('.wb-focus-view[data-view=focus] .wb-clock-actions button').focus();return document.activeElement.matches(${JSON.stringify(handoffField('progress'))})})()`)
  await key('Tab')
  await check('keyboard navigation stays out of the hidden focus view', '!document.activeElement.closest(".wb-focus-view[data-view=focus]")')
  const handoffDraft = {
    progress: '已运行环境检查，前面的准备工作已经完成。',
    obstacle: '基础 notebook 的循环题还需要再核对一次。',
    nextStep: '从循环题开始，检查输出后再整理提交材料。',
    materials: 'L1_env_check.ipynb\nPython_basics.ipynb',
  }
  await fill(handoffField('progress'), handoffDraft.progress)
  await backToFocus()
  await verifyViews('returning to focus makes the handoff view inert and aria-hidden', 'focus')
  await check('returning does not restart the paused timer', (await timerState()).phase === 'paused')
  await check('returning preserves the mounted handoff field and its unsaved draft', sameHandoffNodes)
  await check('handoff draft is not silently saved by returning', handoffRecord() === undefined)
  await check('unsaved handoff remains in the current-window draft', `JSON.parse(sessionStorage.getItem('astaria-handoff-draft:${task.id}')).progress===${JSON.stringify(handoffDraft.progress)}`)
  await openHandoff('留个接力', 'progress')
  await check('one handoff entry provides the obstacle field without changing the chat draft', `document.querySelectorAll('.wb-handoff-trigger').length===1&&!!document.querySelector('.wb-focus-handoff textarea[name=obstacle]')&&document.querySelector('#wb-xixi-input').value===''`)
  await check('re-entering restores the unsaved progress field', `document.querySelector(${JSON.stringify(handoffField('progress'))}).value===${JSON.stringify(handoffDraft.progress)}`)
  await fill(handoffField('obstacle'), handoffDraft.obstacle)
  await backToFocus()
  await openHandoff('留个接力', 'progress')
  await click(handoffField('nextStep'))
  await check('the same handoff editor provides the next-step field', 'document.activeElement.name==="nextStep"')
  await fill(handoffField('nextStep'), handoffDraft.nextStep)
  await fill(handoffField('materials'), handoffDraft.materials)
  await shot('left-handoff-draft')
  await click('.wb-focus-main .xc-handoff button[type=submit]')
  await focusMode('focus')
  await wait('!!document.querySelector(".wb-handoff-summary")')
  await check('save returns to focus with a readable handoff summary', `document.querySelector('.wb-handoff-summary').textContent.includes(${JSON.stringify(handoffDraft.progress)})||document.querySelector('.wb-handoff-summary').textContent.includes(${JSON.stringify(handoffDraft.nextStep)})`)
  const savedHandoff = handoffRecord()
  await check('save persists all four handoff fields', Boolean(savedHandoff) && ['progress', 'obstacle', 'nextStep'].every(field => savedHandoff[field] === handoffDraft[field]) && JSON.stringify(savedHandoff.materials) === JSON.stringify(handoffDraft.materials.split('\n')))
  await check('saving clears the unsaved window draft', `sessionStorage.getItem('astaria-handoff-draft:${task.id}')===null`)
  await check('saving does not restart focus or rebuild the glass', (await timerState()).phase === 'paused' && await evaluate(sameHandoffNodes))
  const pausedTimer = await timerState()
  await delay(350)
  await check('paused elapsed time stays fixed after save', JSON.stringify(await timerState()) === JSON.stringify(pausedTimer))
  await check('handoff edits preserve all step progress and the current page', JSON.stringify(snapshot().subSteps) === handoffStepSnapshot && await evaluate('document.querySelector(".wb-steps-pages>span").textContent') === handoffPage)
  await openHandoff('留个接力', 'progress')
  await check('re-entering after save shows the saved fields', `Object.entries(${JSON.stringify(handoffDraft)}).every(([name,value])=>document.querySelector('.wb-focus-main .wb-focus-handoff textarea[name="'+name+'"]').value===value)`)
  await backToFocus()
  await click('.wb-back'); await focus(task.id)
  await wait('!!document.querySelector(".wb-handoff-summary")')
  await check('reopening the task restores its saved handoff summary', `document.querySelector('.wb-handoff-summary').textContent.includes(${JSON.stringify(handoffDraft.progress)})||document.querySelector('.wb-handoff-summary').textContent.includes(${JSON.stringify(handoffDraft.nextStep)})`)
  await openHandoff('留个接力', 'progress')
  await check('reopening the task loads persisted handoff fields', `Object.entries(${JSON.stringify(handoffDraft)}).every(([name,value])=>document.querySelector('.wb-focus-main .wb-focus-handoff textarea[name="'+name+'"]').value===value)`)
  await backToFocus()
  await rememberHandoffNodes()

  for (const [width, height] of [[1440, 900], [1366, 768], [1280, 800], [390, 844]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await delay(400); await firstPage()
    await evaluate('document.querySelector(".wb-scroll").scrollTop=0;true'); await delay(200)
    const layout = await evaluate(`(()=>{
      const rect=e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}
      const scroll=document.querySelector('.wb-scroll'),list=document.querySelector('.wb-steps-list'),cards=[...document.querySelector('.wb-focus-layout').children]
      return{viewport:{width:innerWidth,height:innerHeight},scroll:{client:scroll.clientHeight,total:scroll.scrollHeight},list:{client:list.clientHeight,total:list.scrollHeight,items:list.children.length},cards:cards.map(rect),scrollRect:rect(scroll),horizontal:document.documentElement.scrollWidth>innerWidth||scroll.scrollWidth>scroll.clientWidth+1}
    })()`)
    layouts.push(layout)
    await check(`${width}×${height}: no horizontal overflow`, !layout.horizontal)
    await check(`${width}×${height}: focus and handoff pills stay aligned without overflowing`, alignedFocusActions)
    await check(`${width}×${height}: normal step list needs no inner scroll`, layout.list.total <= layout.list.client + 1)
    if (width >= 1180) {
      await check(`${width}×${height}: three glass panels share one row`, layout.cards.length === 3 && layout.cards.every(card => Math.abs(card.top - layout.cards[0].top) < 1))
      await check(`${width}×${height}: focus fits the page without scrolling`, layout.scroll.total <= layout.scroll.client + 1 && layout.cards.every(card => card.bottom <= layout.scrollRect.bottom + 1))
    } else await evaluate('document.querySelector(".wb-focus-steps").scrollIntoView({block:"start"});true')
    await shot(`dark-${width}x${height}`)
    await openHandoff('留个接力', 'progress')
    await verifyViews(`${width}×${height}: handoff is the active accessible view`, 'handoff')
    await delay(250)
    const handoffLayout = await evaluate(`(()=>{
      const rect=e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}
      const scroll=document.querySelector('.wb-scroll'),left=document.querySelector('.wb-focus-main'),middle=document.querySelector('.wb-focus-steps'),editor=left.querySelector('.wb-focus-view[data-view=handoff]')
      return{viewport:{width:innerWidth,height:innerHeight},mode:'handoff',left:rect(left),middle:rect(middle),scroll:{client:scroll.clientHeight,total:scroll.scrollHeight},horizontal:document.documentElement.scrollWidth>innerWidth||scroll.scrollWidth>scroll.clientWidth+1,fields:[...editor.querySelectorAll('textarea,button')].map(rect)}
    })()`)
    layouts.push(handoffLayout)
    await check(`${width}×${height}: handoff does not widen or increase the left panel`, !handoffLayout.horizontal && Math.abs(handoffLayout.left.width - layout.cards[0].width) <= 1 && handoffLayout.left.height <= layout.cards[0].height + 1)
    await check(`${width}×${height}: handoff does not move or resize the middle panel`, Math.abs(handoffLayout.middle.width - layout.cards[1].width) <= 1 && Math.abs(handoffLayout.middle.height - layout.cards[1].height) <= 1 && Math.abs(handoffLayout.middle.top - handoffLayout.left.top - (layout.cards[1].top - layout.cards[0].top)) <= 1)
    await check(`${width}×${height}: task steps stay visible while editing the handoff`, visibleSteps)
    await check(`${width}×${height}: both views and the glass keep their DOM identity`, sameHandoffNodes)
    if (width >= 1180) {
      await check(`${width}×${height}: handoff fits without adding page scroll`, handoffLayout.scroll.total <= handoffLayout.scroll.client + 1)
      await check(`${width}×${height}: all handoff fields fit within the left glass`, handoffLayout.fields.every(field => field.left >= handoffLayout.left.left && field.right <= handoffLayout.left.right + 1 && field.top >= handoffLayout.left.top && field.bottom <= handoffLayout.left.bottom + 1))
    } else await evaluate('document.querySelector(".wb-focus-main").scrollIntoView({block:"start"});true')
    await shot(`left-handoff-${width}x${height}`)
    await backToFocus()
    await check(`${width}×${height}: returning keeps the timer paused`, (await timerState()).phase === 'paused')
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }); await delay(300)
  // A clean editor follows shared changes; a manually edited draft wins over
  // background refresh and uses the existing version conflict protection.
  const handoffService = createCompanion({ db })
  const remoteHandoff = nextStep => {
    const { progress, obstacle, materials, version } = handoffRecord()
    return handoffService.saveHandoff({ taskId: task.id, progress, obstacle, materials, nextStep, expectedVersion: version }, { kind: 'user' })
  }
  remoteHandoff('析熙更新：先核对提交清单')
  await evaluate('window.dispatchEvent(new Event("astaria-local-data-change"));true')
  await wait('document.querySelector(".wb-handoff-summary").textContent.includes("析熙更新：先核对提交清单")')
  await openHandoff('留个接力', 'progress')
  await check('clean handoff editor receives shared updates without remounting', 'document.querySelector(".wb-focus-handoff textarea[name=nextStep]").value==="析熙更新：先核对提交清单"')
  await fill(handoffField('nextStep'), '我正在手写的下一步')
  remoteHandoff('其他窗口更新的下一步')
  await evaluate('window.dispatchEvent(new Event("astaria-local-data-change"));true'); await delay(300)
  await check('shared refresh preserves the unsaved handwritten draft', 'document.querySelector(".wb-focus-handoff textarea[name=nextStep]").value==="我正在手写的下一步"')
  await click('.wb-focus-main .xc-handoff button[type=submit]')
  await wait('!!document.querySelector(".xc-handoff-error")')
  await check('a stale handoff save stays editable and cannot overwrite shared data', handoffRecord().nextStep === '其他窗口更新的下一步' && await evaluate('document.querySelector(".wb-focus-modes").dataset.mode==="handoff"&&document.querySelector(".wb-focus-handoff textarea[name=nextStep]").value==="我正在手写的下一步"'))
  await backToFocus()
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  const reducedMotion = await evaluate('({matches:matchMedia("(prefers-reduced-motion: reduce)").matches,progress:getComputedStyle(document.querySelector(".wb-steps-progress>span")).transitionDuration,input:getComputedStyle(document.querySelector(".wb-steps-list input")).transitionDuration})')
  await check('step animations respect reduced motion', reducedMotion.matches && [reducedMotion.progress, reducedMotion.input].every(value => value.split(',').every(part => parseFloat(part) <= 0.001)))
  await send('Emulation.setEmulatedMedia', { features: [] })

  await menu('设置'); await byText('.xixi-settings-tabs button', '外观与动画')
  await wait('!!document.querySelector("select[aria-label=界面外观]:not(:disabled)")')
  await evaluate(`(()=>{const e=document.querySelector('select[aria-label=界面外观]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'light');e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
  await wait('document.querySelector(".xixi-settings").dataset.theme==="light"&&!document.querySelector("select[aria-label=界面外观]").disabled')
  await check('global light appearance remains available in Settings', getPreferences(db).theme === 'light')
  await check('card decoration defaults to symmetrical edges', getPreferences(db).cardEdges === 'both')
  await check('Settings offers both, left and hidden card-edge modes', `JSON.stringify([...document.querySelectorAll('select[aria-label="卡片装饰线"] option')].map(option=>({value:option.value,label:option.textContent})))===JSON.stringify([{value:'both',label:'左右对称'},{value:'left',label:'仅左侧'},{value:'none',label:'隐藏'}])`)
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false }); await delay(300)
  await check('1366×768: the extra card-edge setting fits the appearance page', '(()=>{const e=document.querySelector(".xixi-settings-scroll");return e.scrollHeight<=e.clientHeight+1&&e.scrollWidth<=e.clientWidth+1})()')
  await shot('light-appearance-card-edge-setting')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }); await delay(250)
  const settingsColors = await evaluate(`(()=>{const e=document.querySelector('.xixi-settings');return{ink:getComputedStyle(e).color,select:getComputedStyle(e.querySelector('select[aria-label=界面外观]')).color,theme:e.dataset.theme}})()`)
  layouts.push({ settingsColors })
  await check('light Settings uses dark readable control text', settingsColors.theme === 'light' && settingsColors.select === 'rgb(48, 52, 58)')
  await shot('light-settings')
  await click('.xixi-settings-close'); await wait('!document.querySelector(".xixi-settings")')
  await check('global light appearance reaches task steps', 'document.querySelector(".workbench").dataset.theme==="light"&&getComputedStyle(document.querySelector(".wb-step-title")).color!=="rgb(238, 234, 227)"')
  await shot('light-task-steps')
  // Seed only the isolated in-memory planner so every run has one card of each
  // relevant kind, even on weekends. Gold availability frames are the control.
  const qaDate = await evaluate('new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date())')
  const editPlanner = action => db.updatePlanner(action, db.getPlanner().revision)
  editPlanner({ type: 'import-routines', routines: [
    { id: 'qa-edge-class', title: '装饰线测试课程', kind: 'class', start: '09:00', end: '09:40', weekdays: [0, 1, 2, 3, 4, 5, 6], location: '508', items: [], enabled: true },
    { id: 'qa-edge-break', title: '装饰线测试课间', kind: 'break', start: '09:40', end: '09:50', weekdays: [0, 1, 2, 3, 4, 5, 6], location: '', items: [], enabled: true },
    { id: 'qa-edge-available', title: '装饰线测试空课', kind: 'available', start: '10:00', end: '12:00', weekdays: [0, 1, 2, 3, 4, 5, 6], location: '', items: [], enabled: true },
  ] })
  editPlanner({ type: 'save-block', block: { id: 'qa-edge-plan', taskId: other.id, date: qaDate, start: '10:00', end: '10:30', locked: false } })
  await evaluate('window.dispatchEvent(new Event("astaria-local-data-change"));true')
  await menu('日程'); await wait('document.querySelector(".planner").dataset.active==="true"')
  await check('schedule no longer exposes the duplicate sun/theme control', '![...document.querySelectorAll(".planner button")].some(e=>/切换.*[深浅]|切换主题|界面外观|☀|☾/.test((e.getAttribute("aria-label")||"")+e.textContent))')
  await click('.pl-segment button[data-mode=day]')
  await wait('document.querySelector(".planner").dataset.mode==="day"')
  const dayColumn = `.planner [data-period-current=true] .pl-day-column[data-date="${qaDate}"]`
  await wait(`['class','break','plan','available'].every(kind=>document.querySelector(${JSON.stringify(dayColumn)}+' .pl-slot[data-kind="'+kind+'"]'))`)
  const edgeStyles = () => evaluate(`(()=>{const column=document.querySelector(${JSON.stringify(dayColumn)}),result={};for(const kind of ['class','break','plan','available']){const s=getComputedStyle(column.querySelector('.pl-slot[data-kind="'+kind+'"]'));result[kind]={left:s.borderLeftWidth,right:s.borderRightWidth,leftColor:s.borderLeftColor,rightColor:s.borderRightColor,top:s.borderTopWidth,bottom:s.borderBottomWidth,topColor:s.borderTopColor,bottomColor:s.borderBottomColor}}return result})()`)
  for (const theme of ['light', 'dark']) {
    let availableFrame
    for (const edges of ['both', 'left', 'none']) {
      await menu('设置'); await byText('.xixi-settings-tabs button', '外观与动画')
      await wait('!!document.querySelector("select[aria-label=界面外观]:not(:disabled)")&&!!document.querySelector("select[aria-label=卡片装饰线]:not(:disabled)")')
      if (getPreferences(db).theme !== theme) {
        await evaluate(`(()=>{const e=document.querySelector('select[aria-label=界面外观]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(theme)});e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
        await wait(`document.querySelector('.xixi-settings').dataset.theme===${JSON.stringify(theme)}&&!document.querySelector('select[aria-label=界面外观]').disabled`)
      }
      await evaluate(`(()=>{const e=document.querySelector('select[aria-label=卡片装饰线]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(edges)});e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
      await wait(`document.querySelector('.home-workspace').dataset.cardEdges===${JSON.stringify(edges)}&&!document.querySelector('select[aria-label=卡片装饰线]').disabled`)
      await check(`${theme} ${edges}: card-edge choice persists in local preferences`, getPreferences(db).cardEdges === edges)
      await click('.xixi-settings-close'); await wait('!document.querySelector(".xixi-settings")')
      await wait(`document.querySelector('.planner').dataset.theme===${JSON.stringify(theme)}&&!!document.querySelector(${JSON.stringify(dayColumn)}+' .pl-slot[data-kind=plan]')`)
      const styles = await edgeStyles()
      layouts.push({ theme, cardEdges: edges, styles })
      if (edges === 'both') availableFrame = styles.available
      await check(`${theme} ${edges}: availability keeps its complete gold frame`, JSON.stringify(styles.available) === JSON.stringify(availableFrame))
      for (const kind of ['class', 'break', 'plan']) {
        const value = styles[kind]
        await check(`${theme} ${edges}: ${kind} uses the requested side widths`, value.left === (edges === 'none' ? '1px' : '2px') && value.right === (edges === 'both' ? '2px' : '1px'))
        if (edges === 'both') await check(`${theme} both: ${kind} accents match on both sides`, value.leftColor === value.rightColor && value.leftColor !== 'rgba(0, 0, 0, 0)')
        if (edges === 'none') await check(`${theme} none: ${kind} keeps matching base rims`, value.leftColor === value.rightColor)
        if (kind !== 'plan' && edges !== 'both') await check(`${theme} ${edges}: ${kind} has no right accent`, value.rightColor === 'rgba(0, 0, 0, 0)')
      }
      if (edges === 'both' || edges === 'none') {
        await evaluate(`document.querySelector(${JSON.stringify(dayColumn)}+' .pl-slot[data-kind=class]').scrollIntoView({block:'center'});true`)
        await shot(`${theme}-schedule-card-edges-${edges}`)
      }
    }
  }
  await menu('设置'); await byText('.xixi-settings-tabs button', '外观与动画')
  await check('reopening Settings retains the last card-edge choice', 'document.querySelector("select[aria-label=卡片装饰线]").value==="none"')
  await click('.xixi-settings-close'); await wait('!document.querySelector(".xixi-settings")')
  await check('all model requests used only the scripted three-call provider', providerRequests.length === 3)
  await check('no credential writes or provider-test endpoint was called', !requests.some(request => /\/settings\/(?:key|test)/.test(request.path)))
  await check('browser raised no runtime exceptions', errors.length === 0)
  await writeFile(join(output, 'results.json'), JSON.stringify({ checks, errors, layouts, requests, blockedRequests, providerCalls: providerRequests.length }, null, 2))
  console.log(`PASS ${checks.length} isolated task-step UI checks\nArtifacts: ${output}`)
} catch (reason) {
  failure = reason
  await shot?.('failure').catch(() => {})
  const page = await evaluate?.('({text:document.body.innerText,url:location.href})').catch(() => null)
  await writeFile(join(output, 'failure.json'), JSON.stringify({ message: reason.message, stack: reason.stack, checks, errors, layouts, requests, blockedRequests, providerCalls: providerRequests.map(payload => payload.messages?.filter(message => message.role === 'tool').map(message => message.content)), page }, null, 2))
  console.error(`FAIL ${reason.message}\nArtifacts: ${output}`)
} finally {
  stopping = true
  releaseCheck?.()
  if (ws?.readyState === WebSocket.OPEN) ws.close()
  if (chrome && chrome.exitCode === null) {
    chrome.kill('SIGTERM')
    await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), delay(3000)])
    if (chrome.exitCode === null) { chrome.kill('SIGKILL'); await delay(150) }
  }
  await vite?.close()
  service.close()
  await rm(temporary, { recursive: true, force: true })
}
if (failure) throw failure
