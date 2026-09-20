/** Isolated CDP browser context; every /api request is mocked before it reaches the server. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const base = process.env.XIXI_TEST_URL ?? 'http://127.0.0.1:5188/'
const port = process.env.XIXI_CDP_PORT ?? '9233'
const output = process.env.XIXI_TEST_OUTPUT ?? '/tmp/astaria-xixi-ui'
const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(response => response.json())
const ws = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let serial = 0, sessionId, browserContextId
const pending = new Map(), checks = [], errors = [], requests = [], unknown = []
const send = (method, params = {}, session = sessionId) => new Promise((resolve, reject) => {
  const id = ++serial
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }))
})
const now = new Date().toISOString()
const task = { id: 'qa-task', title: '物理报告 · QA', notes: '只在隔离测试中存在', area: null, source: 'manual', inbox: false, leadDays: 3, importance: 2, energy: 'deep', context: ['anywhere'], status: 'todo', estimateMin: 35, createdAt: now, updatedAt: now, deletedAt: null }
const doneTask = { ...task, id: 'qa-done', title: '已完成的 QA 事项', status: 'done', doneAt: now }
let configured = false, active = 'qa-conversation', turnAttempts = 0, taskRows = [task, doneTask], selectedModel = 'deepseek-flash', rejectRetraction = false, rejectReopen = false
const completionStatuses = new Map([['qa-done', 'todo']])
const conversations = new Map([['qa-conversation', { conversationId: 'qa-conversation', messages: [], operations: [] }]])
const view = (id = active, before) => {
  const state = structuredClone(conversations.get(id))
  const candidates = state.messages.filter(message => before === undefined || message.seq < before)
  const messages = candidates.slice(-200)
  return { ...state, messages, oldestSeq: messages[0]?.seq ?? null, hasOlder: candidates.length > messages.length }
}
const status = () => ({ configured, service: 'astaria-local', model: selectedModel, storage: 'SQLite', dataDirectory: '/isolated-qa' })
function mock(path, method, body) {
  const url = new URL(path)
  const route = url.pathname.slice(4)
  requests.push({ route, method, ...(['/chat', '/tasks/reopen', '/tasks/update'].includes(route) ? { body } : {}) })
  if (route === '/status') return status()
  if (route === '/migration') return { tasks: 0 }
  if (route === '/tasks' && method === 'GET') return taskRows
  if (route === '/tasks/reopen') {
    const row = taskRows.find(item => item.id === body.id)
    if (!row) return { httpStatus: 404, payload: { error: '找不到这条任务' } }
    if (rejectReopen || row.updatedAt !== body.expectedUpdatedAt || row.status !== 'done') return { httpStatus: 409, payload: { error: '任务已在其他窗口修改，请刷新后重试' } }
    const reopened = { ...row, status: completionStatuses.get(row.id) ?? 'todo', updatedAt: new Date(Math.max(Date.now(), Date.parse(row.updatedAt) + 1)).toISOString() }
    delete reopened.doneAt
    taskRows = taskRows.map(item => item.id === row.id ? reopened : item)
    return reopened
  }
  if (route === '/tasks/update') {
    const previous = taskRows.find(row => row.id === body.id)
    if (body.patch.status === 'done' && previous?.status !== 'done') completionStatuses.set(body.id, previous?.status === 'doing' ? 'doing' : 'todo')
    taskRows = taskRows.map(row => row.id === body.id ? { ...row, ...body.patch, updatedAt: new Date(Math.max(Date.now(), Date.parse(row.updatedAt) + 1)).toISOString() } : row)
    return taskRows.find(row => row.id === body.id)
  }
  if (route === '/conversation') return view(url.searchParams.get('id') || active, url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined)
  if (route === '/conversations' && method === 'GET') return [...conversations.keys()].map((id, i) => ({ id, title: conversations.get(id).title ?? (i ? '新的话题' : '物理报告安排'), createdAt: now }))
  if (route === '/conversations' && method === 'POST') {
    active = `qa-conversation-${conversations.size}`
    conversations.set(active, { conversationId: active, title: '新的话题', messages: [], operations: [] })
    return view()
  }
  if (route === '/conversations/select') { active = body.id; return view() }
  if (route === '/conversations/rename') {
    const state = conversations.get(body.conversationId)
    if (!state) return { httpStatus: 404, payload: { error: '找不到这段对话' } }
    state.title = body.title
    return { id: body.conversationId, title: body.title, createdAt: now }
  }
  if (route === '/conversations/delete') {
    if (conversations.size <= 1) return { httpStatus: 409, payload: { error: '至少保留一个对话，请先另开话题' } }
    if (!conversations.has(body.conversationId)) return { httpStatus: 404, payload: { error: '找不到这段对话' } }
    conversations.delete(body.conversationId)
    if (active === body.conversationId) active = conversations.keys().next().value
    return view()
  }
  if (route === '/memories') return []
  if (route === '/settings/key') { configured = true; return status() }
  if (route === '/settings/model') { selectedModel = body.model; return status() }
  if (route === '/settings/test') return { ok: true }
  if (route === '/chat') {
    turnAttempts += 1
    const state = conversations.get(body.conversationId)
    if (!state.messages.some(message => message.requestId === body.requestId)) {
      state.messages.push({ id: `user-${turnAttempts}`, seq: state.messages.length + 1, role: 'user', content: body.text, createdAt: now, requestId: body.requestId })
      state.operations.push({ id: `operation-${turnAttempts}`, requestId: body.requestId, summary: '已记下物理报告的安排', createdAt: now, readAt: null, undoneAt: null, undoable: true })
    }
    // The operation committed, but its final response was lost in transit.
    if (turnAttempts === 1) return { httpStatus: 503, payload: { error: '模拟网络中断，原文还在' } }
    if (!state.messages.some(message => message.requestId === body.requestId && message.role === 'assistant')) {
      const markdownProbe = '**周六（9/19）** - 托福单词'
      const securityProbe = 'Markdown 安全边界 QA'
      const content = body.text === '帮我拆第一步'
        ? '想先从哪一步开始？'
        : body.text === markdownProbe
          ? '**周六（9/19）**\n\n- 托福单词\n- 整理错题'
          : body.text === securityProbe
            ? '[危险链接](javascript:alert(1))\n\n![远程图片](https://example.com/remote.png)\n\n`' + 'x'.repeat(420) + '`'
            : '记好了，先把报告的第一步放在今天\n慢慢来，我在'
      state.messages.push({ id: `assistant-${turnAttempts}`, seq: state.messages.length + 1, role: 'assistant', content, ...(body.text === '帮我拆第一步' ? { question: { options: ['整理实验数据', '先看报告要求', '我想自己描述'] } } : {}), createdAt: now, requestId: body.requestId })
    }
    return { ...view(body.conversationId), requestId: body.requestId, status: 'completed' }
  }
  if (route === '/operations/read') {
    for (const state of conversations.values()) for (const operation of state.operations) if (body.ids.includes(operation.id)) operation.readAt = now
    return { ok: true }
  }
  if (route === '/messages/retract' || /^\/messages\/.+\/retract$/.test(route)) {
    if (rejectRetraction) return { httpStatus: 409, payload: { error: '模拟撤回失败，消息仍在' } }
    const states = [...conversations.values()]
    const message = states.flatMap(state => state.messages).find(item => route === '/messages/retract' ? item.role === 'user' && item.requestId === body.requestId : item.id === decodeURIComponent(route.split('/')[2]))
    assert.ok(message, 'withdrawn QA message exists')
    const state = states.find(candidate => candidate.messages.includes(message))
    message.retractedAt = new Date().toISOString()
    message.content = '已撤回'
    state.messages = state.messages.filter(item => !(item.role === 'assistant' && item.requestId === message.requestId))
    return view(state.conversationId)
  }
  if (/^\/operations\/.+\/undo$/.test(route)) {
    const id = route.split('/')[2]
    const operation = [...conversations.values()].flatMap(state => state.operations).find(item => item.id === id)
    operation.undoneAt = now
    return operation
  }
  unknown.push({ route, method })
  return { httpStatus: 501, payload: { error: 'QA 未定义的 API，已阻止访问真实服务' } }
}
ws.onmessage = event => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
  if (message.method === 'Fetch.requestPaused') {
    const request = message.params.request
    Promise.resolve().then(async () => {
      const result = mock(request.url, request.method, request.postData ? JSON.parse(request.postData) : undefined)
      if (new URL(request.url).pathname === '/api/chat') await new Promise(resolve => setTimeout(resolve, 900))
      return send('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: result.httpStatus ?? 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }], body: Buffer.from(JSON.stringify(result.payload ?? result)).toString('base64') }, message.sessionId)
    }).catch(error => { errors.push({ mock: error.message }); void send('Fetch.failRequest', { requestId: message.params.requestId, errorReason: 'Failed' }, message.sessionId) })
  }
  if (!message.id) return
  const callback = pending.get(message.id)
  pending.delete(message.id)
  if (message.error) callback.reject(message.error)
  else callback.resolve(message.result)
}
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const wait = async expression => {
  for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await delay(80) }
  throw new Error(`Timed out: ${expression}`)
}
const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); checks.push(name) }
const click = async selector => {
  await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled&&!e.closest('[inert]')})()`)
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'});true`)
  await delay(200)
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();if(!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw new Error('UI target occluded: '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await delay(80)
}
const type = async (selector, text) => { await click(selector); await send('Input.insertText', { text }) }
const fill = async (selector, text) => { await click(selector); await evaluate(`document.querySelector(${JSON.stringify(selector)}).select();true`); await send('Input.insertText', { text }) }
const enter = async (shift = false) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: shift ? 8 : 0, text: '\r', unmodifiedText: '\r' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: shift ? 8 : 0 })
}
const shot = async name => {
  await fs.writeFile(`${output}/${name}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
}
try {
  browserContextId = (await send('Target.createBrowserContext', {}, null)).browserContextId
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId }, null)
  sessionId = (await send('Target.attachToTarget', { targetId, flatten: true }, null)).sessionId
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Network.setBypassServiceWorker', { bypass: true })
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async text=>{window.__qaCopied=text}}})' })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await send('Page.navigate', { url: base })
  await wait('!!document.querySelector(".home-launch:not(:disabled)") && document.querySelector(".home-current-title")?.textContent.includes("物理报告")')
  await click('.home-launch')
  await wait('document.querySelector(".home-morph")?.dataset.progress === "1.000"')
  await check('home chat is taller with unchanged width and centered vertically', '(()=>{const r=document.querySelector(".home-morph").getBoundingClientRect();return r.height===680&&r.width===680&&Math.abs(r.top+r.height/2-innerHeight/2)<2})()')
  await check('missing key shows settings entry', 'document.querySelector(".home-xixi .xixi-conversation")?.textContent.includes("连接 DeepSeek")')
  await type('#home-compose', '明天下午完成物理报告')
  await click('.home-capture')
  await check('missing key preserves draft', 'document.querySelector("#home-compose").value === "明天下午完成物理报告" && document.querySelector(".home-xixi .xixi-send-error")?.textContent.includes("设置")')
  assert.equal(turnAttempts, 0)
  await click('.home-xixi .xixi-send-error button')
  await wait('!!document.querySelector(".xixi-settings[open]")')
  await check('settings receives focus', 'document.querySelector(".xixi-settings").contains(document.activeElement)')
  await check('settings is compact and bounded', '(()=>{const r=document.querySelector(".xixi-settings").getBoundingClientRect();return r.width<=512&&r.right<=innerWidth&&r.height<=innerHeight-30})()')
  await check('default model is Flash and close icon is centered', 'document.querySelector("#xixi-model").value==="deepseek-flash"&&(()=>{const a=document.querySelector(".xixi-settings-close").getBoundingClientRect(),b=document.querySelector(".xixi-settings-close svg").getBoundingClientRect();return Math.abs(a.x+a.width/2-b.x-b.width/2)<1&&Math.abs(a.y+a.height/2-b.y-b.height/2)<1})()')
  await evaluate('(()=>{const e=document.querySelector("#xixi-model");e.value="deepseek-v4-pro";e.dispatchEvent(new Event("change",{bubbles:true}));return true})()')
  await wait('document.querySelector(".xixi-settings-feedback").textContent.includes("默认模型已更新")')
  await click('.xixi-settings-close')
  await click('.home-xixi .xixi-send-error button')
  await wait('document.querySelector("#xixi-model")?.value === "deepseek-v4-pro"')
  checks.push('model selection survives reopening settings')
  await fs.mkdir(output, { recursive: true })
  await shot('settings')
  await type('#deepseek-local-key', 'qa-placeholder-not-a-real-key')
  await click('.xixi-settings button[type=submit]')
  await wait('document.querySelector(".xixi-settings-feedback").textContent.includes("钥匙串")')
  await check('key clears from input and browser storage', 'document.querySelector("#deepseek-local-key").value === "" && !JSON.stringify({...localStorage,...sessionStorage}).includes("qa-placeholder-not-a-real-key")')
  await click('.xixi-settings-close')
  await check('closing settings returns keyboard focus', 'document.activeElement.closest(".home-xixi") !== null')
  await click('#home-compose')
  await enter(true)
  await check('Shift Enter inserts newline without sending', 'document.querySelector("#home-compose").value.endsWith("\\n") && !document.querySelector(".home-xixi [data-delivery=sending]")')
  assert.equal(turnAttempts, 0)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await evaluate('(()=>{const e=document.querySelector("#home-compose");e.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}));e.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",keyCode:229,isComposing:true,bubbles:true,cancelable:true}));e.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:"好"}));e.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",bubbles:true,cancelable:true}));return true})()')
  await delay(130)
  assert.equal(turnAttempts, 0, 'IME confirm and its trailing Enter never send')
  checks.push('IME confirm and trailing Enter never send')
  await enter()
  await check('Enter immediately shows optimistic user while awaiting response', 'document.querySelector(".home-xixi [data-role=user][data-delivery=sending]")?.textContent.includes("明天下午完成物理报告") && !!document.querySelector(".home-xixi .xixi-thinking")')
  await wait('document.querySelector(".home-xixi .xixi-send-error")?.textContent.includes("模拟网络中断")')
  await check('failed send remains in history with retry', '!!document.querySelector(".home-xixi [data-delivery=failed] .xixi-delivery button")')
  await check('failed send retains draft', 'document.querySelector("#home-compose").value === "明天下午完成物理报告"')
  await send('Page.reload', { ignoreCache: true })
  await wait('!!document.querySelector(".home-launch:not(:disabled)") && document.querySelector(".home-current-title")?.textContent.includes("物理报告")')
  await click('.home-launch')
  await wait('document.querySelector(".home-morph")?.dataset.progress === "1.000"')
  await check('failed request survives reload with original draft', 'document.querySelector("#home-compose").value === "明天下午完成物理报告" && JSON.parse(sessionStorage.getItem("astaria-xixi-pending-v1")).length === 1')
  await click('.home-xixi .xixi-topic-menu > button')
  await click('.home-xixi .xixi-topic-new')
  await click('.home-xixi .xixi-topic-menu > button')
  await wait('document.querySelectorAll(".home-xixi .xixi-topic-popover li").length === 2')
  await click('.home-xixi .xixi-topic-popover li:first-child button')
  await click('.home-xixi .xixi-delivery button')
  await wait('document.querySelector(".home-xixi .xixi-message[data-role=assistant]")?.textContent.includes("慢慢来")')
  await check('successful send clears draft', 'document.querySelector("#home-compose").value === ""')
  await check('persisted user replaces optimistic user without duplicates', 'document.querySelectorAll(".home-xixi .xixi-message[data-role=user]").length===1 && !document.querySelector(".home-xixi [data-delivery]")')
  await click('.home-xixi [data-role=user] .xixi-message-copy')
  await check('user message copies plain text', 'window.__qaCopied === "明天下午完成物理报告"')
  await click('.home-xixi [data-role=assistant] .xixi-message-copy')
  await check('assistant message copies plain text', 'window.__qaCopied === "记好了，先把报告的第一步放在今天\\n慢慢来，我在"')
  const turns = requests.filter(request => request.route === '/chat')
  assert.equal(turns[0].body.requestId, turns[1].body.requestId, 'network retry uses same request id')
  assert.equal(conversations.get('qa-conversation').operations.length, 1, 'retry never duplicates an already committed operation')
  checks.push('reload and history switch retain idempotent request id')
  const markdownProbe = '**周六（9/19）** - 托福单词'
  await type('#home-compose', markdownProbe)
  await enter()
  await wait('document.querySelectorAll(".home-xixi .xixi-message[data-role=assistant] .xixi-markdown").length >= 2')
  await check('assistant Markdown renders bold and list', '(()=>{const e=[...document.querySelectorAll(".home-xixi .xixi-message[data-role=assistant] .xixi-markdown")].at(-1);return !!e?.querySelector("strong")&&e.querySelector("strong")?.textContent==="周六（9/19）"&&e.querySelectorAll("ul > li").length===2&&e.textContent.includes("托福单词")&&e.textContent.includes("整理错题")})()')
  await check('user Markdown remains original text', `(()=>{const e=[...document.querySelectorAll('.home-xixi .xixi-message[data-role=user]')].at(-1);return e?.textContent.includes(${JSON.stringify(markdownProbe)})&&!e?.querySelector('.xixi-markdown')})()`)
  await type('#home-compose', 'Markdown 安全边界 QA')
  await enter()
  await wait('document.querySelectorAll(".home-xixi .xixi-message[data-role=assistant] .xixi-markdown").length >= 3')
  await check('unsafe links are not clickable and remote images are not rendered', '(()=>{const e=[...document.querySelectorAll(".home-xixi .xixi-message[data-role=assistant] .xixi-markdown")].at(-1);return !!e&&![...e.querySelectorAll("a")].some(a=>a.getAttribute("href")?.startsWith("javascript:"))&&!e.querySelector("img")&&e.querySelector(".xixi-markdown-image-alt")?.textContent.includes("远程图片")})()')
  await check('long Markdown stays inside the message width', '(()=>{const e=[...document.querySelectorAll(".home-xixi .xixi-message[data-role=assistant] .xixi-markdown")].at(-1);return !!e&&e.scrollWidth<=e.clientWidth+1})()')
  await check('completed request removes pending record', 'JSON.parse(sessionStorage.getItem("astaria-xixi-pending-v1")).length === 0')
  await wait('!!document.querySelector(".home-xixi .xixi-receipt")')
  await check('undo includes return icon and readable label', '!!document.querySelector(".home-xixi .xixi-undo svg") && document.querySelector(".home-xixi .xixi-undo").textContent === "撤销"')
  await delay(250)
  assert.ok(requests.some(request => request.route === '/operations/read'), 'visible receipt marks unread change read')
  checks.push('visible receipt marks unread change read')
  await click('.home-xixi .xixi-undo')
  await wait('document.querySelector(".home-xixi .xixi-receipt")?.textContent.includes("已撤销")')
  checks.push('operation undo updates receipt')
  await click('.home-xixi .xixi-topic-menu > button')
  await wait('document.querySelector(".home-xixi .xixi-topic-popover li")?.textContent.includes("物理报告安排")')
  await click('.home-xixi .xixi-topic-new')
  await wait('document.querySelectorAll(".home-xixi .xixi-message").length === 0')
  await click('.home-xixi .xixi-topic-menu > button')
  await wait('document.querySelectorAll(".home-xixi .xixi-topic-popover li").length === 3')
  await click('.home-xixi .xixi-topic-popover li:first-child button')
  await wait('document.querySelector(".home-xixi .xixi-message[data-role=assistant]")?.textContent.includes("慢慢来")')
  checks.push('new topic keeps selectable history')
  active = 'qa-external-window'
  conversations.set(active, { conversationId: active, messages: [{ id: 'external-message', seq: 1, role: 'user', content: '另一个窗口的事情', createdAt: now }], operations: [] })
  await evaluate('document.dispatchEvent(new Event("visibilitychange"));true')
  await delay(300)
  await check('other browser changing global topic cannot move this window', '!document.querySelector(".home-xixi .xixi-conversation").textContent.includes("另一个窗口") && sessionStorage.getItem("astaria-xixi-conversation-v1") === "qa-conversation"')
  await fs.mkdir(output, { recursive: true })
  await shot('home-conversation')
  await click('.home-collapse')
  await click('.home-brand')
  await click('.home-menu li:nth-child(2) button')
  await wait('document.querySelector(".workbench")?.dataset.active === "true"')
  await wait(`!!document.querySelector('.wb-completed-row[data-task-id="qa-done"] .wb-reopen')`)
  const initialFocusRecord = await evaluate('localStorage.getItem("astaria-focus-v1")')
  const completedVersion = taskRows.find(item => item.id === 'qa-done').updatedAt
  rejectReopen = true
  await click('.wb-completed-row[data-task-id="qa-done"] .wb-reopen')
  await wait('document.querySelector(".wb-chooser .wb-error")?.textContent.includes("其他窗口")')
  await check('failed completion withdrawal keeps the completed row and reports the conflict', '!!document.querySelector(".wb-completed-row[data-task-id=qa-done]") && !document.querySelector(".wb-task[data-task-id=qa-done]")')
  assert.equal(taskRows.find(item => item.id === 'qa-done').status, 'done')
  rejectReopen = false
  await click('.wb-completed-row[data-task-id="qa-done"] .wb-reopen')
  await wait(`!document.querySelector('.wb-completed-row[data-task-id="qa-done"]')`)
  const rowReopen = requests.filter(request => request.route === '/tasks/reopen').at(-1)
  assert.equal(rowReopen.body.id, 'qa-done')
  assert.equal(rowReopen.body.expectedUpdatedAt, completedVersion)
  assert.equal(taskRows.find(item => item.id === 'qa-done').status, 'todo')
  assert.equal(await evaluate('localStorage.getItem("astaria-focus-v1")'), initialFocusRecord)
  assert.equal(taskRows.find(item => item.id === 'qa-done').doneAt, undefined)
  checks.push('completed row reopens using the current updatedAt and preserves focus history')
  await wait(`!!document.querySelector('.wb-task[data-task-id="qa-done"]')`)
  checks.push('completed row returns to active tasks after reopen')
  await click('.wb-task[data-task-id="qa-task"]')
  await wait('!!document.querySelector(".wb-xixi .xixi-conversation")')
  await check('workbench shares home conversation', 'document.querySelector(".wb-xixi .xixi-conversation").textContent.includes("慢慢来")')
  await type('#wb-xixi-input', '帮我拆第一步')
  await enter()
  await check('focus Enter shows immediate user message', 'document.querySelector(".wb-xixi [data-delivery=sending]")?.textContent.includes("帮我拆第一步")')
  await wait('document.querySelector("#wb-xixi-input").value === ""')
  assert.equal(requests.filter(request => request.route === '/chat').at(-1).body.context.taskId, task.id)
  checks.push('focus chat sends current task context')
  await wait('document.querySelectorAll(".wb-xixi .xixi-quick-options button").length === 3')
  await click('.wb-xixi .xixi-quick-options button:first-child')
  await check('quick answer appears immediately in history', 'document.querySelector(".wb-xixi [data-delivery=sending]")?.textContent.includes("整理实验数据")')
  await wait('!document.querySelector(".wb-xixi [data-delivery=sending]")')
  assert.equal(requests.filter(request => request.route === '/chat').at(-1).body.context.taskId, task.id)
  await check('answered options disable and avoid repeated submission', '[...document.querySelectorAll(".wb-xixi .xixi-quick-options button")].every(button=>button.disabled)')
  await check('focus conversation grows vertically and panels stay equal height', '(()=>{const l=document.querySelector(".wb-focus-main").getBoundingClientRect(),r=document.querySelector(".wb-xixi").getBoundingClientRect(),c=document.querySelector(".wb-xixi .xixi-conversation").getBoundingClientRect();return c.height>=350&&c.height<=501&&Math.abs(l.height-r.height)<2&&Math.abs(l.top-r.top)<2})()')
  await check('focus chat has no horizontal overflow', '(()=>{const e=document.querySelector(".wb-xixi"),r=e.getBoundingClientRect();return e.scrollWidth<=e.clientWidth+2&&r.right<=innerWidth&&r.left>=0})()')
  await shot('focus-conversation')
  await type('#wb-xixi-input', '临时发错的一句话')
  await enter()
  await wait('!!document.querySelector(".wb-xixi [data-delivery=sending] .xixi-message-retract")')
  const withdrawnRequest = requests.filter(request => request.route === '/chat').at(-1)?.body.requestId
  await click('.wb-xixi [data-delivery=sending] .xixi-message-retract')
  await wait('!!document.querySelector(".wb-xixi [data-retracted=true]")')
  await delay(1000)
  await check('withdrawing in-flight message discards its delayed reply', '(()=>{const messages=[...document.querySelectorAll(".wb-xixi .xixi-message")],last=messages.at(-1);return last?.dataset.retracted==="true"&&last.textContent.includes("已撤回")&&!last.querySelector("button")&&!document.querySelector(".wb-xixi [data-delivery=sending]")})()')
  assert.ok(conversations.get('qa-conversation').operations.some(operation => operation.requestId === withdrawnRequest && !operation.undoneAt), 'withdrawal keeps committed operation undo independent')
  checks.push('withdrawal leaves committed operation independently undoable')
  await check('focus withdrawal restores original wording without duplicates or late clearing', 'document.querySelector("#wb-xixi-input").value === "临时发错的一句话" && document.activeElement === document.querySelector("#wb-xixi-input")')
  await fill('#wb-xixi-input', '另外的草稿')
  const focusRetractId = await evaluate('[...document.querySelectorAll(".wb-xixi [data-role=user]")].find(e=>e.querySelector("p")?.textContent==="帮我拆第一步").dataset.messageId')
  await click(`.wb-xixi [data-message-id="${focusRetractId}"] .xixi-message-retract`)
  await wait('document.querySelector("#wb-xixi-input").value === "另外的草稿\\n\\n帮我拆第一步"')
  await check('focus withdrawal appends to an existing draft and focuses input', 'document.activeElement === document.querySelector("#wb-xixi-input")')
  await check('chat keeps a scrollbar gutter and readable right padding', '(()=>{const e=document.querySelector(".wb-xixi .xixi-conversation"),s=getComputedStyle(e);return s.scrollbarGutter.includes("stable")&&parseFloat(s.paddingRight)>=12&&e.scrollWidth<=e.clientWidth+1})()')
  await click('.wb-clock-actions .wb-action')
  await wait('document.querySelector(".wb-clock-actions .wb-action")?.textContent === "暂停"')
  await delay(350)
  await click('.wb-clock-actions .wb-secondary')
  await wait('!!document.querySelector(".wb-finished .wb-reopen")')
  const focusBeforeReopen = await evaluate('JSON.parse(localStorage.getItem("astaria-focus-v1")).tasks["qa-task"]')
  assert.equal(taskRows.find(item => item.id === 'qa-task').status, 'done')
  assert.ok(focusBeforeReopen.spentMs > 0)
  const focusedVersion = taskRows.find(item => item.id === 'qa-task').updatedAt
  await click('.wb-finished .wb-reopen')
  await wait('!!document.querySelector(".wb-clock-area") && !document.querySelector(".wb-finished")')
  assert.equal(requests.filter(request => request.route === '/tasks/reopen').at(-1).body.expectedUpdatedAt, focusedVersion)
  assert.equal(taskRows.find(item => item.id === 'qa-task').status, 'doing')
  assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem("astaria-focus-v1")).tasks["qa-task"]'), focusBeforeReopen)
  await check('focus completion withdrawal restores a paused task without restarting its timer', 'document.querySelector(".wb-clock-actions .wb-action").textContent === "继续专注" && !!document.querySelector(".wb-xixi .xixi-conversation")')
  checks.push('focus completion withdrawal retains the exact accumulated time')
  await click('.wb-back')
  await wait('!!document.querySelector(".wb-chooser")')
  await click('.wb-toolbar .wb-tool:first-child')
  await wait('!!document.querySelector(".wb-preview-label")')
  await wait('document.querySelector(".wb-deadline-timeline")?.dataset.measured === "true"')
  await check('DDL evidence controls align across different card content', '(()=>{const r=[...document.querySelectorAll(".wb-ddl-item[data-offpage=false] .wb-ddl-reason-toggle")].map(e=>e.getBoundingClientRect());return r.length>1&&Math.max(...r.map(x=>x.top))-Math.min(...r.map(x=>x.top))<1.5})()')
  await click('.wb-ddl-item[data-offpage=false] .wb-ddl-reason-toggle')
  await wait('document.querySelector(".wb-ddl-item[data-offpage=false] .wb-ddl-evidence")?.dataset.open === "true"')
  await wait('(()=>{const e=document.querySelector(".wb-ddl-item[data-offpage=false] .wb-ddl-evidence").getBoundingClientRect(),p=document.querySelector(".wb-ddl-pager").getBoundingClientRect();return e.height>0&&e.bottom<=p.top})()')
  await fs.writeFile(`${output}/ddl-metrics.json`, JSON.stringify(await evaluate('(()=>{const e=document.querySelector(".wb-ddl-item[data-offpage=false]");return {toggle:e.querySelector(".wb-ddl-reason-toggle").getBoundingClientRect().toJSON(),evidence:e.querySelector(".wb-ddl-evidence").getBoundingClientRect().toJSON(),content:e.querySelector(".wb-ddl-evidence ul").getBoundingClientRect().toJSON(),pager:document.querySelector(".wb-ddl-pager").getBoundingClientRect().toJSON()}})()'), null, 2))
  await check('expanded DDL evidence stays below toggle without overlapping pager', '(()=>{const e=document.querySelector(".wb-ddl-item[data-offpage=false]"),t=e.querySelector(".wb-ddl-reason-toggle").getBoundingClientRect(),p=e.querySelector(".wb-ddl-evidence").getBoundingClientRect(),pager=document.querySelector(".wb-ddl-pager").getBoundingClientRect();return p.top>=t.bottom-1&&p.bottom<=pager.top+1&&p.width>0})()')
  await shot('ddl-evidence')
  await click('.wb-ddl-item[data-offpage=false] .wb-ddl-reason-toggle')
  await click('.wb-task')
  await wait('!!document.querySelector(".xixi-preview-message")')
  const previewReopenRequests = requests.filter(request => request.route === '/tasks/reopen').length
  const previewTaskId = await evaluate('JSON.parse(localStorage.getItem("astaria-focus-preview-v1")).selectedTaskId')
  await click('.wb-clock-actions .wb-action')
  await delay(350)
  await click('.wb-clock-actions .wb-secondary')
  await wait('!!document.querySelector(".wb-finished .wb-reopen")')
  const previewBeforeReopen = await evaluate(`JSON.parse(localStorage.getItem("astaria-focus-preview-v1")).tasks[${JSON.stringify(previewTaskId)}]`)
  await click('.wb-finished .wb-reopen')
  await wait('!!document.querySelector(".wb-clock-area") && !document.querySelector(".wb-finished")')
  assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem("astaria-focus-preview-v1")).tasks[${JSON.stringify(previewTaskId)}]`), previewBeforeReopen)
  await check('preview completion withdrawal restores the local focus view without starting it', 'document.querySelector(".wb-clock-actions .wb-action").textContent === "继续专注"')
  assert.equal(requests.filter(request => request.route === '/tasks/reopen').length, previewReopenRequests)
  checks.push('preview completion withdrawal never calls the real task API')
  await type('#wb-xixi-input', '这条示例不要发')
  await check('example mode cannot send real messages', 'document.querySelector(".wb-xixi button[type=submit]").disabled && !document.querySelector(".wb-xixi .xixi-conversation")')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  await check('narrow focus view stays within viewport', 'document.documentElement.scrollWidth<=innerWidth+1')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  conversations.set('qa-long-history', { conversationId: 'qa-long-history', messages: Array.from({ length: 250 }, (_, i) => ({ id: `history-${i + 1}`, seq: i + 1, role: i % 2 ? 'assistant' : 'user', content: `旧对话第 ${i + 1} 条`, createdAt: now })), operations: [] })
  await click('.home-brand')
  await click('.home-menu li:first-child button')
  await click('.home-launch')
  await wait('document.querySelector(".home-morph")?.dataset.progress === "1.000"')
  await click('.home-xixi .xixi-topic-menu > button')
  await wait('document.querySelectorAll(".home-xixi .xixi-topic-popover li").length === 5')
  await click('.home-xixi .xixi-topic-popover li:last-child button')
  await wait('document.querySelectorAll(".home-xixi .xixi-message").length === 200')
  await evaluate('document.querySelector(".home-xixi .xixi-conversation").scrollTop=0;true')
  const anchorBefore = await evaluate('document.querySelector(".home-xixi [data-message-id=history-51]").getBoundingClientRect().top')
  await click('.home-xixi .xixi-load-older')
  await wait('document.querySelectorAll(".home-xixi .xixi-message").length === 250')
  const anchorAfter = await evaluate('document.querySelector(".home-xixi [data-message-id=history-51]").getBoundingClientRect().top')
  assert.ok(Math.abs(anchorBefore - anchorAfter) < 2, 'prepending history retains scroll anchor')
  checks.push('older than 200 messages loads with stable scroll anchor')
  await evaluate('document.dispatchEvent(new Event("visibilitychange"));true')
  await delay(300)
  await check('polling keeps previously loaded old history', 'document.querySelectorAll(".home-xixi .xixi-message").length === 250 && !document.querySelector(".home-xixi .xixi-load-older")')
  await fill('#home-compose', '主页已有草稿')
  rejectRetraction = true
  await click('.home-xixi [data-message-id="history-249"] .xixi-message-retract')
  await wait('document.querySelector(".home-xixi .xixi-send-error")?.textContent.includes("模拟撤回失败")')
  await check('failed withdrawal leaves home draft and message unchanged', 'document.querySelector("#home-compose").value==="主页已有草稿" && document.querySelector(".home-xixi [data-message-id=history-249]").dataset.retracted==="false"')
  rejectRetraction = false
  await click('.home-xixi [data-message-id="history-249"] .xixi-message-retract')
  await wait('document.querySelector("#home-compose").value === "主页已有草稿\\n\\n旧对话第 249 条"')
  await check('home withdrawal preserves draft, restores wording and focuses input', 'document.activeElement===document.querySelector("#home-compose")')
  await click('.home-xixi .xixi-topic-menu > button')
  await wait('document.querySelectorAll(".home-xixi .xixi-topic-row").length===5')
  await click('.home-xixi [data-topic-id="qa-long-history"] .xixi-topic-rename')
  await check('rename input takes keyboard focus with the existing name selected', '(()=>{const e=document.querySelector(".home-xixi .xixi-topic-edit input");return document.activeElement===e&&e.selectionStart===0&&e.selectionEnd===e.value.length})()')
  await fill('.home-xixi .xixi-topic-edit input', '周末学习安排')
  await enter()
  await wait('document.querySelector(".home-xixi [data-topic-id=qa-long-history] .xixi-topic-select")?.textContent.includes("周末学习安排")')
  await check('rename updates immediately without changing the selected conversation', 'sessionStorage.getItem("astaria-xixi-conversation-v1")==="qa-long-history" && document.querySelector(".home-xixi [data-topic-id=qa-long-history] .xixi-topic-select").getAttribute("aria-current")==="true"')
  await click('.home-xixi .xixi-topic-menu > button')
  await click('.home-xixi .xixi-topic-menu > button')
  await wait('document.querySelector(".home-xixi [data-topic-id=qa-long-history] .xixi-topic-select")?.textContent.includes("周末学习安排")')
  checks.push('renamed title survives reopening the menu')
  await shot('conversation-menu')
  const deletesBefore = requests.filter(request=>request.route==='/conversations/delete').length
  await click('.home-xixi [data-topic-id="qa-long-history"] .xixi-topic-delete')
  await check('delete asks for confirmation and focuses the safe action', 'document.activeElement===document.querySelector(".home-xixi .xixi-topic-confirm-cancel") && !!document.querySelector(".home-xixi .xixi-topic-confirm")')
  assert.equal(requests.filter(request=>request.route==='/conversations/delete').length, deletesBefore)
  await click('.home-xixi .xixi-topic-confirm-cancel')
  await check('cancel keeps the conversation and its selected state', '!!document.querySelector(".home-xixi [data-topic-id=qa-long-history]") && sessionStorage.getItem("astaria-xixi-conversation-v1")==="qa-long-history"')
  await click('.home-xixi [data-topic-id="qa-long-history"] .xixi-topic-delete')
  await click('.home-xixi .xixi-topic-confirm-delete')
  await wait('!document.querySelector(".home-xixi [data-topic-id=qa-long-history]") && document.querySelectorAll(".home-xixi .xixi-topic-row").length===4')
  await check('deleting the selected conversation opens the server fallback', 'sessionStorage.getItem("astaria-xixi-conversation-v1")==="qa-conversation" && document.querySelector(".home-xixi [data-topic-id=qa-conversation] .xixi-topic-select").getAttribute("aria-current")==="true"')
  for (const id of [...conversations.keys()].filter(id=>id!=='qa-conversation')) {
    await click(`.home-xixi [data-topic-id="${id}"] .xixi-topic-delete`)
    await click('.home-xixi .xixi-topic-confirm-delete')
    await wait(`!document.querySelector('.home-xixi [data-topic-id="${id}"]')`)
  }
  await check('deleting unselected conversations preserves the current conversation', 'sessionStorage.getItem("astaria-xixi-conversation-v1")==="qa-conversation" && document.querySelectorAll(".home-xixi .xixi-topic-row").length===1')
  await click('.home-xixi [data-topic-id="qa-conversation"] .xixi-topic-delete')
  await click('.home-xixi .xixi-topic-confirm-delete')
  await wait('document.querySelector(".home-xixi .xixi-topic-error")?.textContent.includes("先另开话题")')
  await check('last conversation rejection preserves its record and readable confirmation', 'document.querySelectorAll(".home-xixi .xixi-topic-row").length===1 && !!document.querySelector(".home-xixi .xixi-topic-confirm") && sessionStorage.getItem("astaria-xixi-conversation-v1")==="qa-conversation"')
  assert.equal(conversations.size, 1)
  await click('.home-xixi .xixi-topic-confirm-cancel')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  await check('compact conversation manager fits the viewport', '(()=>{const e=document.querySelector(".home-xixi .xixi-topic-popover"),r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&e.scrollWidth<=e.clientWidth+1})()')
  assert.deepEqual(unknown, [], 'every API used by the UI has an explicit isolated mock')
  assert.deepEqual(errors, [], 'no browser runtime errors')
  checks.push('all APIs isolated from real service', 'no browser runtime errors')
  await fs.writeFile(`${output}/checks.json`, JSON.stringify({ checks, count: checks.length, screenshots: ['home-conversation.png', 'focus-conversation.png', 'settings.png', 'ddl-evidence.png', 'conversation-menu.png'] }, null, 2))
  console.log(`PASS ${checks.length} isolated Xixi UI checks (${output})`)
} catch (error) {
  await fs.mkdir(output, { recursive: true })
  if (sessionId) await shot('failure').catch(() => {})
  await fs.writeFile(`${output}/failure.json`, JSON.stringify({ error: error.message, checks, unknown, errors }, null, 2))
  throw error
} finally {
  if (browserContextId) await send('Target.disposeBrowserContext', { browserContextId }, null)
  ws.close()
}
