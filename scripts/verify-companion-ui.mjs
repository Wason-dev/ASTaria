/** Isolated browser + SQLite service: no user database, credentials, or provider calls. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { localDay, shiftDay } from '../src/home/agenda.ts'

const base = process.env.COMPANION_QA_URL ?? 'http://127.0.0.1:5180/'
const endpoint = process.env.COMPANION_QA_CDP ?? 'http://127.0.0.1:9241'
const output = process.env.COMPANION_QA_OUTPUT ?? '/tmp/astaria-companion-ui'
const db = createDatabase(':memory:')
// Inspect a full upcoming day so layout fixtures do not grow stale warnings as
// the wall clock passes their morning slots during an evening QA run.
const today = localDay(shiftDay(new Date(), 1)), tomorrow = localDay(shiftDay(new Date(), 2)), later = localDay(shiftDay(new Date(), 5))
const task = db.createTask({ title: '接力测试：机器人实验', due: later, estimateMin: 45, inbox: false, energy: 'light' })
const another = db.createTask({ title: '物理报告', due: later, estimateMin: 30, inbox: false, energy: 'light' })
const edit = action => db.updatePlanner(action, db.getPlanner().revision)
edit({ type: 'save-routine', routine: { id: 'qa-free', title: '自主时间', kind: 'available', weekdays: [0,1,2,3,4,5,6], start: '09:00', end: '22:00', location: '', items: [], enabled: true } })
edit({ type: 'save-block', block: { id: 'qa-plan', taskId: task.id, date: tomorrow, start: '11:00', end: '11:45', locked: false } })
edit({ type: 'save-details', taskId: task.id, details: { items: ['电脑'], preparation: '先充电', needsSubmission: false, submittedAt: null } })
for (const [index, title] of ['整理物理实验数据', '英语阅读', '数学练习', '准备机器人测试'].entries()) {
  const item = db.createTask({ title, due: later, estimateMin: 30, inbox: false, energy: 'light' })
  const stamp = minutes => `${Math.floor(minutes / 60)}`.padStart(2, '0') + ':' + `${minutes % 60}`.padStart(2, '0')
  edit({ type: 'save-block', block: { id: `qa-day-${index}`, taskId: item.id, date: today, start: stamp(540 + index * 30), end: stamp(570 + index * 30), locked: true } })
}
const service = createLocalService({ db, vault: { status: async () => true }, complete: async () => { throw Error('UI verification must not invoke the model') }, dataDirectory: '/isolated-companion-qa' })
const version = await fetch(`${endpoint}/json/version`).then(response => response.json())
const ws = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let serial = 0, session, contextId
const pending = new Map(), checks = [], errors = [], requests = []
const send = (method, params = {}, sid = session) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) })) })
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
  if (value.method === 'Fetch.requestPaused') api(value.params.request).then(response => send('Fetch.fulfillRequest', { requestId: value.params.requestId, responseCode: response.status, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(response.body).toString('base64') }, value.sessionId)).catch(reason => errors.push(String(reason)))
  if (!value.id) return
  const callback = pending.get(value.id); pending.delete(value.id)
  value.error ? callback.reject(value.error) : callback.resolve(value.result)
}
const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const wait = async expression => { for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await delay(75) } throw Error(`Timeout: ${expression}`) }
const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); checks.push(name) }
const click = async selector => {
  await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled&&!e.closest('[inert]')})()`)
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'});true`); await delay(150)
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();if(!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Occluded '+${JSON.stringify(selector)});return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }); await delay(90)
}
const byText = async (selector, text) => {
  await evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing '+${JSON.stringify(text)});e.dataset.qaClick='target';return true})()`)
  await click('[data-qa-click=target]'); await evaluate('document.querySelectorAll("[data-qa-click]").forEach(e=>delete e.dataset.qaClick);true')
}
const fill = async (selector, value) => { await click(selector); await evaluate(`document.querySelector(${JSON.stringify(selector)}).select();true`); await send('Input.insertText', { text: value }) }
const key = async value => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code: value, windowsVirtualKeyCode: value === 'Escape' ? 27 : value === 'Enter' ? 13 : 9 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code: value }) }
const shot = async name => writeFile(`${output}/${name}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))

try {
  await mkdir(output, { recursive: true })
  contextId = (await send('Target.createBrowserContext', {}, null)).browserContextId
  const target = await send('Target.createTarget', { url: 'about:blank', browserContextId: contextId }, null)
  session = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null)).sessionId
  await send('Page.enable'); await send('Runtime.enable'); await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: base })
  await wait('!!document.querySelector(".home-launch")&&!document.querySelector(".home-current-title").disabled')
  await click('.home-brand'); await byText('#home-menu button', '平行宇宙')
  await wait('!!document.querySelector(".xc-day-selector button")')
  await evaluate(`(()=>{const input=document.querySelector('.xc-date-row input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(today)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
  await wait('document.querySelectorAll(".xc-day-column li").length===4')
  await check('parallel universe is a first-class page without modal focus trapping', 'document.querySelector(".home-workspace").dataset.page==="companion"&&!document.querySelector("dialog:modal")&&document.activeElement.closest(".xc-page")!==null')
  await check('page content uses the outer page scroller', 'getComputedStyle(document.querySelector(".xc-scroll")).overflowY==="visible"&&getComputedStyle(document.querySelector(".xc-page-scroll")).overflowY==="auto"')
  await check('seven actual dates and slider available', 'document.querySelectorAll(".xc-day-selector button").length===7&&document.querySelector(".xc-timeline-range input").max==="6"')
  await check('page has no return button or giant glass wrapper', '!document.querySelector(".xc-header .xc-icon-button")&&!document.querySelector(".xc-dialog>.home-glass-measure")&&getComputedStyle(document.querySelector(".xc-dialog")).boxShadow==="none"')
  await check('controls, date overview and task columns sample their own glass', 'document.querySelectorAll(".xc-scenario-start>.home-glass-measure,.xc-overview>.home-glass-measure,.xc-day-column>.home-glass-measure").length===3')
  await check('glass sampling parent remains untransformed', 'getComputedStyle(document.querySelector(".xc-dialog")).transform==="none"&&getComputedStyle(document.querySelector(".xc-dialog")).opacity==="1"')
  const desktopLayout = async label => {
    for (const [width, height] of [[1440, 900], [1280, 800], [1366, 768]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await delay(300)
      await evaluate('document.querySelector(".xc-page-scroll").scrollTop=0;true')
      await check(`${label} ${width}×${height}: controls and timeline use horizontal space`, '(()=>{const a=document.querySelector(".xc-scenario-start").getBoundingClientRect(),b=document.querySelector(".xc-lens").getBoundingClientRect();return a.width>=240&&a.width<=280&&b.left>a.right&&Math.abs(a.top-b.top)<2&&b.width>680})()')
      await check(`${label} ${width}×${height}: four tasks and main actions fit one page`, '(()=>{const s=document.querySelector(".xc-page-scroll"),button=document.querySelector(".xc-apply-row .xc-primary")??document.querySelector(".xc-scenario-actions .xc-primary"),r=button.getBoundingClientRect();return s.scrollHeight<=s.clientHeight+1&&s.scrollWidth<=s.clientWidth+1&&r.top>=s.getBoundingClientRect().top&&r.bottom<=s.getBoundingClientRect().bottom})()')
      await shot(`${label}-${width}x${height}`)
    }
  }
  await desktopLayout('current')
  const before = JSON.stringify(db.getPlanner())
  await evaluate(`window.dispatchEvent(new CustomEvent('astaria-preferences-change',{detail:{version:1,startupPage:'home',theme:'light',grid:false,glass:'soft',density:'compact',effect:{style:'tide',intensity:'gentle',motion:'reduced'},assistant:{autonomy:'act',useMemory:true,useHistory:true},notifications:{enabled:true,quietStart:'23:00',quietEnd:'08:00',opportunities:true},focus:{focusMin:35,restMin:5},scheduling:{bufferMin:10}}}));true`)
  await check('parallel-universe page follows shared light/glass/motion preferences', 'document.querySelector(".xc-page").dataset.theme==="light"&&document.querySelector(".xc-page").dataset.grid==="false"&&getComputedStyle(document.querySelector(".xc-shell")).animationName==="none"')
  await evaluate(`window.dispatchEvent(new CustomEvent('astaria-preferences-change',{detail:{version:1,startupPage:'home',theme:'dark',grid:true,glass:'clear',density:'compact',effect:{style:'tide',intensity:'gentle',motion:'system'},assistant:{autonomy:'act',useMemory:true,useHistory:true},notifications:{enabled:true,quietStart:'23:00',quietEnd:'08:00',opportunities:true},focus:{focusMin:35,restMin:5},scheduling:{bufferMin:10}}}));true`)
  await byText('.xc-scenario-actions button', '看看会怎样'); await wait('!!document.querySelector(".xc-scenario-status")')
  assert.equal(JSON.stringify(db.getPlanner()), before, 'preview leaves planner unchanged'); checks.push('preview leaves planner unchanged')
  await check('preview has distinct current and candidate columns', 'document.querySelectorAll(".xc-day-column").length===2&&document.querySelector(".xc-scenario-status").textContent.includes("尚未应用")')
  await desktopLayout('comparison')
  await check('comparison keeps all glass ancestors untransformed', '([...document.querySelectorAll(".xc-glass>.home-glass-measure")].every(e=>{for(let p=e;p&&!p.matches(".xc-page");p=p.parentElement){const s=getComputedStyle(p);if(s.transform!=="none"||s.opacity!=="1")return false}return true}))')
  await byText('.xc-modes button', '轻一点拆成短段，留出缓冲和休息')
  await check('daily budget remains visible beside the timeline', '(()=>{const r=document.querySelector(".xc-budget input").getBoundingClientRect(),s=document.querySelector(".xc-page-scroll");return r.top>=s.getBoundingClientRect().top&&r.bottom<=s.getBoundingClientRect().bottom&&s.scrollHeight<=s.clientHeight+1})()')
  await byText('.xc-modes button', '重新梳理按截止时间，找合适的空闲')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await delay(300)
  await shot('scenario-desktop')
  await click('.xc-space-toggle'); await wait('document.querySelector(".xc-dialog").dataset.spatial==="true"')
  await check('space preview overlays actual current black-hole canvas', '!!document.querySelector(".p0-universe canvas")&&document.querySelector(".xc-space-node[data-candidate=true]")!==null&&document.querySelector(".xc-shell").getBoundingClientRect().width<=425')
  await check('space preview releases the underlying chat sampling', 'getComputedStyle(document.querySelector(".home-morph")).opacity==="0"&&getComputedStyle(document.querySelector(".home-morph .home-glass-surface")).backdropFilter==="none"')
  await click('.xc-space-node[data-candidate=true]'); await check('spatial node resolves to its readable task row', 'document.activeElement.hasAttribute("data-lens-task")&&document.activeElement.dataset.selected==="true"')
  await shot('space-desktop')
  await click('.xc-day-selector button:nth-child(2)'); await check('spatial date and nodes follow selected real day', `document.querySelector('.xc-space').dataset.date===${JSON.stringify(tomorrow)}&&document.querySelector('.xc-space').textContent.includes('11:00–11:45')`)
  await click('.xc-day-selector button:nth-child(1)'); await key('Escape'); await wait('document.querySelector(".xc-page").dataset.spatial==="false"');checks.push('Escape leaves spatial preview and keeps the parallel-universe page')
  await byText('.xc-apply-row button', '就这样安排'); await wait('document.querySelector(".xc-scenario-status").textContent.includes("已应用")')
  assert.ok(db.getPlanner().revision > JSON.parse(before).revision); checks.push('explicit apply persists verified scenario')
  await byText('.xc-apply-row button', '撤销这次调整'); await wait('document.querySelector(".xc-scenario-status").textContent.includes("已撤销")')
  assert.deepEqual(db.getPlanner().blocks, JSON.parse(before).blocks); checks.push('undo restores original blocks')
  for (let index = 0; index < 12; index++) {
    const stamp = minutes => `${Math.floor(minutes / 60)}`.padStart(2, '0') + ':' + `${minutes % 60}`.padStart(2, '0')
    edit({ type: 'save-block', block: { id: `qa-long-${index}`, taskId: task.id, date: today, start: stamp(720 + index * 20), end: stamp(735 + index * 20), locked: false } })
  }
  await evaluate(`(()=>{const input=document.querySelector('.xc-date-row input');const set=value=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))};set(${JSON.stringify(tomorrow)});return true})()`)
  await wait(`document.querySelector('.xc-day-metrics')?.textContent.includes(${JSON.stringify(new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',weekday:'short'}).format(new Date(`${tomorrow}T12:00:00`)))})`)
  await evaluate(`(()=>{const input=document.querySelector('.xc-date-row input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(today)});input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
  await wait('document.querySelectorAll(".xc-day-column li").length===16')
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false }); await delay(300)
  await check('long actual days scroll the page without clipped task rows or inner scrolling', '(()=>{const s=document.querySelector(".xc-page-scroll"),c=document.querySelector(".xc-scroll");return s.scrollHeight>s.clientHeight&&getComputedStyle(c).overflowY==="visible"&&document.querySelectorAll(".xc-day-column li").length===16})()')
  await evaluate('document.querySelector(".xc-page-scroll").scrollTop=1e6;true')
  await check('last task of a long day can be reached', '(()=>{const s=document.querySelector(".xc-page-scroll"),r=document.querySelector(".xc-day-column li:last-child").getBoundingClientRect();return r.top>=s.getBoundingClientRect().top&&r.bottom<=s.getBoundingClientRect().bottom})()')
  for (let index = 0; index < 12; index++) edit({ type: 'delete-block', id: `qa-long-${index}` })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await delay(300)
  await evaluate('document.querySelector(".xc-page-scroll").scrollTop=0;true')
  await byText('.xc-tabs button', '牵挂清单0'); await byText('.xc-section-heading button', '记下一件')
  await check('wishes have an independent glass content panel', '!!document.querySelector(".xc-auxiliary>.home-glass-measure")&&!document.querySelector(".xc-dialog>.home-glass-measure")')
  await fill('.xc-wish-editor textarea[id$="-content"]', '周末拍夕阳')
  await fill('.xc-wish-editor textarea[id$="-items"]', '相机\n电池')
  await byText('.xc-wish-editor button', '记住这件事'); await wait('document.querySelector(".xc-wish-list")?.textContent.includes("周末拍夕阳")')
  assert.equal(db.getCompanionState().wishes[0].evidence, '周末拍夕阳'); checks.push('wish persists direct-user evidence and conditions')
  await byText('.xc-wish-actions button', '暂停'); await wait('document.querySelector(".xc-wish-list li").dataset.status==="paused"')
  await byText('.xc-wish-actions button', '恢复'); await wait('document.querySelector(".xc-wish-list li").dataset.status==="active"')
  checks.push('wish pause and resume persist')
  await byText('.xc-tabs button', '合适的时机'); await wait('!!document.querySelector(".xc-opportunities li")')
  await check('opportunity has a real date/time and explicit condition', 'document.querySelector(".xc-opportunities").textContent.includes("周末拍夕阳")&&document.querySelector(".xc-opportunities").textContent.includes("相机")')
  await byText('.xc-tabs button', '牵挂清单1'); await byText('.xc-wish-actions button', '移除')
  assert.equal(db.getCompanionState().wishes.length, 1); checks.push('deleting a wish requires explicit inline confirmation')
  await byText('.xc-wish-actions button', '确认移除'); await wait('!document.querySelector(".xc-wish-list")')
  assert.equal(db.getCompanionState().wishes.length, 0); checks.push('confirmed delete removes the content')
  for (const width of [390, 320]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false }); await delay(300)
    await byText('.xc-tabs button', '平行宇宙')
    await check(`${width}px page and content stay within viewport`, '(()=>{const d=document.querySelector(".xc-dialog"),s=document.querySelector(".xc-page-scroll"),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&s.scrollWidth<=s.clientWidth+1})()')
    await check(`${width}px spatial controls yield to readable timeline`, '!document.querySelector(".xc-space-toggle")&&!document.querySelector(".xc-space")')
    await shot(`scenario-${width}`)
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await delay(300)
  await click('.home-brand'); await byText('#home-menu button', '首页')
  await wait('!document.querySelector(".xc-dialog")')
  await wait('document.querySelector(".home-workspace").dataset.page==="home"')
  await check('back returns to prior page with usable focus', '!document.activeElement.closest("[inert]")&&document.activeElement!==document.body')
  await click('.home-brand'); await byText('#home-menu button', '平行宇宙'); await wait('!!document.querySelector(".xc-day-selector button")')
  await evaluate("window.dispatchEvent(new CustomEvent('astaria-open-companion',{detail:{tab:'opportunities'}}));true")
  await wait('document.querySelector(".xc-tabs [aria-current=page]").textContent==="合适的时机"');checks.push('navigation target can change while parallel-universe page remains mounted')
  await evaluate('document.querySelector(".xc-header h2").focus();true');await key('Escape');await check('Escape on the regular page does not navigate away', '!!document.querySelector(".xc-page")')
  await click('.home-brand'); await byText('#home-menu button', '工作台')
  await wait('!!document.querySelector(".wb-task")'); await click(`.wb-task[data-task-id="${task.id}"]`)
  await wait('!!document.querySelector(".xc-handoff textarea")&&!document.querySelector(".xc-handoff textarea").disabled')
  await fill('.xc-handoff textarea[id$="-progress"]', '左轮已经校准')
  await fill('.xc-handoff textarea[id$="-nextStep"]', '先检查右轮接线')
  await byText('.xc-handoff button', '保存接力'); await wait('document.querySelector(".xc-handoff").textContent.includes("接力现场已保存")')
  assert.equal(db.getCompanionState().handoffs[0].nextStep, '先检查右轮接线'); checks.push('task handoff persists progress and next step')
  await fill('.xc-handoff textarea[id$="-obstacle"]', '未保存的接线备注')
  await click('.wb-back'); await wait('!!document.querySelector(".wb-task")'); await click(`.wb-task[data-task-id="${task.id}"]`)
  await wait(`document.querySelector('.xc-handoff textarea[id$="-obstacle"]')?.value==='未保存的接线备注'`)
  await check('reopening restores saved and unsaved handoff context', `document.querySelector('.xc-handoff textarea[id$="-progress"]')?.value==='左轮已经校准'`)
  await byText('.xc-focus-checkout button', '卡住了')
  await check('blocked-task action prepares a contextual draft without sending', `document.activeElement.matches('.wb-xixi textarea')&&document.activeElement.value.includes('机器人实验')&&document.activeElement.value.includes('卡在：')`)
  assert.ok(!requests.some(request=>request.path==='/api/chat'));checks.push('help draft waits for user to send')
  await byText('.xc-focus-checkout button', '今天先到这')
  await check('finishing today returns focus to handoff without marking task complete', 'document.activeElement.matches(".xc-handoff textarea")')
  assert.notEqual(db.getTask(task.id).status,'done');checks.push('ending a session does not falsely complete the task')
  await shot('handoff-desktop')
  assert.deepEqual(errors, [])
  await writeFile(`${output}/results.json`, JSON.stringify({ checks, errors, requests, fixture: { today, tomorrow, taskId: task.id, anotherTaskId: another.id } }, null, 2))
  console.log(JSON.stringify({ checks: checks.length, errors: errors.length, output }))
} catch (reason) {
  await shot('failure').catch(() => {})
  await writeFile(`${output}/failure.json`, JSON.stringify({ error: String(reason), checks, errors, requests }, null, 2))
  throw reason
} finally {
  if (contextId) await send('Target.disposeBrowserContext', { browserContextId: contextId }, null)
  ws.close(); db.close()
}
