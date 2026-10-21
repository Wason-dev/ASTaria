/** Real production UI with an owned browser, in-memory DB and scripted provider. */
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { createDesktopHandler } from '../desktop/server.mjs'
import { saveModelSettings } from '../server/modelSettings.mjs'
import { DEFAULT_PREFERENCES } from '../server/preferences.mjs'

process.env.TZ = 'Asia/Shanghai'
const at = '2026-10-14T09:39:00+08:00', date = '2026-10-14'
mock.timers.enable({ apis: ['Date'], now: new Date(at).getTime() })
const temporary = await mkdtemp(join(tmpdir(), 'astaria-receipt-horizon-'))
const output = resolve('artifacts/v1-readiness/receipt-horizon')
const db = createDatabase(':memory:')
const task = { id: 'qa-physics', title: '物理作业', area: 'physics', source: 'ai', inbox: false, leadDays: 3, importance: 2, energy: 'deep', context: ['anywhere'], status: 'todo', due: '2026-10-16', estimateMin: 45, createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(), deletedAt: null }
db.beginTurn({ requestId: 'qa-creation', conversationId: 'main', text: '记下物理作业并安排', context: { timezone: 'Asia/Shanghai' } })
db.applyOperation({ id: 'qa-create', requestId: 'qa-creation', summary: '创建 1 项事项：物理作业', changes: [{ table: 'tasks', id: task.id, before: null, after: task }] })
db.finishTurn('qa-creation', { status: 'completed' })
db.appendMessage({ conversationId: 'main', requestId: 'qa-creation', role: 'assistant', content: '作业已记录，先按 45 分钟安排。' })
const short = db.createTask({ title: '数学练习', area: 'math', estimateMin: 15, inbox: false })
const act = action => db.updatePlanner(action, db.getPlanner().revision)
act({ type: 'import-routines', routines: [
  { id: 'qa-available', title: '可用时间', kind: 'available', weekdays: [0,1,2,3,4,5,6], start: '09:00', end: '18:00', location: '', items: [], enabled: true },
  { id: 'qa-lunch', title: '午休', kind: 'break', weekdays: [0,1,2,3,4,5,6], start: '12:00', end: '13:00', location: '', items: [], enabled: true },
] })
act({ type: 'save-day-event', event: { id: 'qa-class', title: '课程', date, start: '10:00', end: '10:30', location: '', items: [] } })
act({ type: 'save-block', block: { id: 'qa-long', taskId: task.id, date, start: '15:00', end: '15:45', locked: false, horizonGroupId: 'qa-physics-group', horizonGroupTitle: '物理' } })
act({ type: 'save-block', block: { id: 'qa-short', taskId: short.id, date, start: '14:00', end: '14:15', locked: false, horizonGroupId: 'qa-math-group', horizonGroupTitle: '数学' } })
db.setPreference('onboarding-completed', true)
db.setPreference('free-time-daily', { date, completedAt: at })
saveModelSettings(db, { provider: 'local', local: { engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'scripted-qa' }, streamResponses: false, webSearch: { enabled: false, maxUses: 2 }, contextBudget: { mode: 'auto', maxUnits: 48000 }, cloudModel: 'deepseek-flash', reasoningEffort: 'low' })
const checks = [], errors = [], requests = [], blocked = []
let chrome, ws, base, serial = 0, stopping = false, server
const pending = new Map()
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const tool = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `qa-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const service = createLocalService({ db, dataDirectory: temporary,
  vault: { status: async () => true, read: async () => { throw Error('No credentials in QA') } },
  fetcher: async () => { throw Error('No external requests in QA') },
  complete: async payload => {
    requests.push(payload)
    if (payload.messages[0].content.includes('三日弦轨')) return reply(JSON.stringify({ changes: [] }))
    const user = payload.messages.findLast(message => message.role === 'user').content
    const match = /预估时间改为 (\d+) 分钟/.exec(user)
    assert.ok(match, 'only receipt requests reach this scripted provider')
    const minutes = Number(match[1]), last = payload.messages.at(-1)
    if (last.role !== 'tool') return tool('read_tasks', { taskId: task.id })
    const lastName = payload.messages.flatMap(message => message.tool_calls ?? []).find(call => call.id === last.tool_call_id)?.function.name
    if (lastName === 'read_tasks') return tool('read_planner', { date })
    if (lastName === 'read_planner') return tool('update_task', { taskId: task.id, expectedUpdatedAt: db.getTask(task.id).updatedAt, patch: { estimateMin: minutes } })
    if (lastName === 'update_task') return tool('plan_tasks', { expectedRevision: db.getPlanner().revision, plans: [{ id: 'qa-long', taskId: task.id, date, start: '15:00', end: `15:${String(minutes).padStart(2, '0')}` }] })
    return reply('已核对课程与其他安排，沿用原事项调整了时长。')
  },
})
const delay = ms => new Promise(yes => setTimeout(yes, ms))
const send = (method, params = {}) => new Promise((yes, no) => {
  const id = ++serial, timeout = setTimeout(() => { pending.delete(id); no(Error(`CDP timeout ${method}`)) }, 20000)
  pending.set(id, { yes, no, timeout }); ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
const wait = async expression => {
  for (let i = 0; i < 200; i++) { if (await evaluate(expression)) return; await delay(50) }
  throw Error(`Timeout ${expression}`)
}
const check = async (name, expression) => { assert.ok(await evaluate(expression), name); checks.push(name) }
const click = async selector => {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'});true`); await delay(150)
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();if(e.disabled||e.closest('[inert]')||!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Unreachable '+${JSON.stringify(selector)});return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}
const label = async (host, value) => {
  await evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(`${host} button`)})].find(e=>e.textContent.trim()===${JSON.stringify(value)});if(!e)throw Error('Missing '+${JSON.stringify(value)});e.dataset.qaClick='true'})()`)
  await click('[data-qa-click]'); await evaluate("document.querySelectorAll('[data-qa-click]').forEach(e=>delete e.dataset.qaClick);true")
}
const nav = async value => { await click('.home-brand'); await wait("document.querySelector('#home-menu').dataset.open==='true'"); await label('#home-menu', value) }
const shot = async name => writeFile(join(output, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
const draft = async (host, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(`${host} textarea`)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
try {
  await mkdir(output, { recursive: true })
  const token = 'isolated-qa-receipt-horizon-session-capability'
  const handler = createDesktopHandler({ root: resolve('dist'), service, token })
  server = createServer((req, res) => { req.headers['x-astaria-desktop'] = token; void handler(req, res) })
  await new Promise(yes => server.listen(0, '127.0.0.1', yes)); base = `http://127.0.0.1:${server.address().port}/`
  const profile = join(temporary, 'chrome')
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-background-timer-throttling','--disable-renderer-backgrounding','about:blank'], { stdio: 'ignore' })
  let port
  for (let i = 0; i < 150; i++) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break } catch {} await delay(100) }
  assert.ok(port)
  const target = (await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json())).find(e => e.type === 'page')
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((yes, no) => { ws.onopen = yes; ws.onerror = no })
  ws.onmessage = event => {
    const value = JSON.parse(event.data), item = pending.get(value.id)
    if (item) { pending.delete(value.id); clearTimeout(item.timeout); value.error ? item.no(value.error) : item.yes(value.result) }
    if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails)
    if (value.method === 'Fetch.requestPaused') {
      const { requestId, request } = value.params
      void (request.url.startsWith(base) ? send('Fetch.continueRequest', { requestId }) : (blocked.push(request.url), send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }))).catch(error => { if (!stopping) errors.push(String(error)) })
    }
  }
  await send('Page.enable'); await send('Runtime.enable'); await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
  await send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `const NativeDate=Date;window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[NativeDate.parse('${at}')]));}static now(){return NativeDate.parse('${at}')}};localStorage.setItem('astaria-sqlite-migration-v1','complete');` })
  const variants = [['dark','clear',1440,900],['light','clear',1440,900],['dark','soft',390,844],['light','soft',390,844]]
  for (const [theme, glass, width, height] of variants) {
    console.log(`Checking ${theme}/${glass}/${width}`)
    db.setPreference('app', { ...DEFAULT_PREFERENCES, theme, glass, effect: { ...DEFAULT_PREFERENCES.effect, motion: 'reduced' } })
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
    await send('Page.navigate', { url: base }); await wait("!!document.querySelector('.home-brand') && !!window.__ASTARIA_P0__")
    await nav('余时'); await wait("document.querySelector('.home-workspace').dataset.page==='free-time'")
    await click('.string-invitation'); await wait("document.querySelector('.horizon-studio')?.dataset.phase==='ready' && document.querySelectorAll('.orbit-group').length>=1")
    const planner = structuredClone(db.getPlanner()), beforeCalls = requests.length
    if (!await evaluate("!!document.querySelector('.orbit-group[data-group-id=qa-physics-group]')")) await click('.horizon-browse [data-direction="1"]')
    await wait("!!document.querySelector('.orbit-group[data-group-id=qa-physics-group]')")
    await evaluate("document.querySelector('.orbit-group[data-group-id=qa-physics-group]').focus();true")
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 })
    await wait("document.querySelector('.orbit-group')?.dataset.groupId==='qa-physics-group'")
    await click('.orbit-select'); await wait("!!document.querySelector('.horizon-scheduling-question')")
    assert.deepEqual(db.getPlanner(), planner); assert.equal(requests.length, beforeCalls)
    checks.push(`${theme}/${glass}/${width}: question leaves the real calendar unchanged`)
    await check(`${theme}/${glass}/${width}: question and footer do not overlap`, "(()=>{const q=document.querySelector('.horizon-scheduling-question'),r=q.getBoundingClientRect(),f=document.querySelector('.orbit-footer').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=f.top&&q.scrollWidth<=q.clientWidth+1})()")
    await check(`${theme}/${glass}/${width}: keyboard focuses a real choice`, "document.activeElement.closest('.horizon-scheduling-question')!==null")
    await shot(`question-${theme}-${glass}-${width}`)
    await label('.horizon-scheduling-question', '先不改，返回调整')
    await wait("!document.querySelector('.horizon-scheduling-question') && document.activeElement.matches('.orbit-select')")
    await check(`${theme}/${glass}/${width}: cancel returns focus without saving`, "!document.querySelector('.horizon-scheduling-question') && document.activeElement.matches('.orbit-select')")
    await click('.orbit-select'); await wait("!!document.querySelector('.horizon-scheduling-question')")
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await wait("!document.querySelector('.horizon-scheduling-question') && document.activeElement.matches('.orbit-select')")
    await check(`${theme}/${glass}/${width}: Escape keeps the editable draft open`, "document.querySelector('.horizon-studio')?.dataset.phase==='ready' && document.querySelector('.orbit-group')?.dataset.groupId==='qa-physics-group'")
    assert.deepEqual(db.getPlanner(), planner); assert.equal(requests.length, beforeCalls)
    await click('.orbit-select'); await wait("!!document.querySelector('.horizon-scheduling-question')")
    await label('.horizon-scheduling-question', '先做 20 分钟，其余接到后续空档')
    await wait("!document.querySelector('.horizon-studio')")
    const fragments = db.getPlanner().blocks.filter(block => block.taskId === task.id)
    assert.deepEqual(fragments.map(block => [block.start, block.end]), [['09:40','10:00'],['10:30','10:55']])
    db.undoOperation(db.listOperations().find(operation => operation.kind === 'planner' && !operation.undoneAt).id)
    assert.deepEqual(db.getPlanner().blocks, planner.blocks)
  }
  // Actual home and focus entry points retain the same topic and composer draft.
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await nav('首页'); await click('.home-launch'); await wait("!document.querySelector('#home-xixi').inert")
  for (const [host, value, expected, screenshot] of [['#home-xixi','30分',30,'receipt-home'],['.wb-xixi','45分',45,'receipt-focus']]) {
    if (host === '.wb-xixi') { await nav('工作台'); await wait(`!!document.querySelector('.wb-task[data-task-id="${task.id}"]')`); await click(`.wb-task[data-task-id="${task.id}"]`); await wait("!!document.querySelector('.wb-xixi textarea')") }
    await draft(host, '保留我的草稿')
    const conversation = db.getActiveConversation().id
    await label(`${host} .xixi-estimate-shortcuts`, value)
    await wait(`document.querySelector(${JSON.stringify(host)}).innerText.includes('预估时间改为 ${expected} 分钟')`)
    await wait(`!document.querySelector(${JSON.stringify(`${host} .xixi-receipt-task-settings`)})?.getAttribute('aria-busy')?.includes('true')`)
    assert.equal(db.getTask(task.id).estimateMin, expected)
    assert.equal(db.getPlanner().blocks.find(block => block.id === 'qa-long').end, `15:${String(expected).padStart(2,'0')}`)
    assert.equal(db.getActiveConversation().id, conversation)
    const message = db.listMessages(conversation).filter(m => m.role === 'user').at(-1)
    assert.equal(message.taskId, task.id); assert.match(message.content, /请将已创建事项/)
    await check(`${host}: same conversation, real saved duration and preserved draft`, `document.querySelector(${JSON.stringify(`${host} textarea`)}).value==='保留我的草稿' && !document.querySelector(${JSON.stringify(`${host} .xixi-deadline-error`)})`)
    await shot(screenshot)
  }
  assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  await writeFile(join(output, 'summary.json'), JSON.stringify({ checks, errors, blocked, scriptedProviderCalls: requests.length, privateDataUsed: false, nativeHardwareValidation: false }, null, 2))
  console.log(JSON.stringify({ checks: checks.length, errors, output }))
} catch (error) {
  if (ws?.readyState === WebSocket.OPEN) {
    await shot('failure').catch(() => {})
    console.log(JSON.stringify({ checks, errors, ui: await evaluate("document.querySelector('.horizon-studio')?.innerText").catch(() => null) }))
  }
  throw error
} finally {
  stopping = true; ws?.close(); chrome?.kill(); for (const entry of pending.values()) clearTimeout(entry.timeout)
  if (server) await new Promise(yes => server.close(yes)); service.close(); mock.timers.reset()
  await delay(200); await rm(temporary, { recursive: true, force: true })
}
