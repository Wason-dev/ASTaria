/** Isolated focus conversation fixture; all API traffic is intercepted before reaching the service. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'

const base = process.env.XIXI_TEST_URL ?? 'http://127.0.0.1:5188/'
const port = process.env.XIXI_CDP_PORT ?? '9242'
const output = process.env.XIXI_TEST_OUTPUT ?? '/tmp/astaria-focus-reasoning-ui'
const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(response => response.json())
const ws = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let serial = 0, sessionId, browserContextId
const pending = new Map(), errors = [], apiRequests = [], checks = []
const send = (method, params = {}, session = sessionId) => new Promise((resolve, reject) => {
  const id = ++serial
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }))
})
const rounds = [{ id: 'first', content: '工具之前的完整思考\t' }, { id: 'second', content: '工具之后的思考\n核对结束' }]
const saved = { reasoningContent: rounds.map(item => item.content).join('\n\n'), rounds, status: 'completed' }
const fixture = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0}</style><body class="p0" data-night="false" style="--wb-font:13px;--wb-top:88px;background:#f5f4ef">
<div class="workbench" data-active="true"><div class="wb-scroll" data-focus="true"><div class="wb-focus-layout">
<div class="wb-focus-main"></div><div class="wb-focus-steps"></div><div class="wb-xixi"><div class="wb-glass-content">
<header><strong>析熙</strong></header><div class="wb-xixi-context"><p>隔离测试 · 专注任务</p></div><div id="fixture" style="display:contents"></div>
<form class="xixi-compose"><textarea aria-label="测试输入"></textarea></form></div></div></div></div></div>
<script type="module">
import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
const React = (await import('/node_modules/.vite/deps/react.js')).default;
const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
const { ConversationLog } = await import('/src/xixi/ConversationLog.tsx');
await import('/src/prototype/prototype.css'); await import('/src/workbench/workbench.css'); await import('/src/workbench/focus-layout.css');
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copied = text } } });
window.user = { id: 'u1', requestId: 'r1', seq: 1, role: 'user', content: '核对安排', createdAt: '', hasSavedReasoning: true };
window.rounds = ${JSON.stringify(rounds)};
window.draft = { requestId: 'r1', conversationId: 'main', round: 2, reasoningContent: ${JSON.stringify(saved.reasoningContent)}, reasoningRounds: rounds.map((part, index) => ({ ...part, round: index + 1 })), content: '', phase: 'executing', activities: [{ id: 'tool:qa', stage: 'reading', state: 'running', title: '正在核对课程与空档', detail: '读取日程' }] };
window.chat = { conversation: { conversationId: 'main', messages: [user], operations: [] }, interruptedReasoning: {}, status: { configured: true }, sending: true, stream: draft, markRead: async () => {} };
const root = createRoot(document.querySelector('#fixture'));
window.renderChat = updates => { window.chat = { ...chat, ...updates }; root.render(React.createElement(ConversationLog, { chat, active: true, context: { page: 'workbench', taskId: 'focus-test', timezone: 'Asia/Shanghai' }, onSettings() {}, onSent() {}, onRetracted() {} })) };
renderChat({});
</script>`
ws.onmessage = event => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
  if (message.method === 'Fetch.requestPaused') {
    const { request, requestId } = message.params
    const api = new URL(request.url).pathname.startsWith('/api/')
    if (api) apiRequests.push(request.url)
    const known = !api || new URL(request.url).pathname === '/api/conversation/reasoning'
    void send('Fetch.fulfillRequest', { requestId, responseCode: known ? 200 : 501,
      responseHeaders: [{ name: 'Content-Type', value: api ? 'application/json' : 'text/html' }],
      body: Buffer.from(api ? JSON.stringify(known ? saved : { error: 'Unexpected API blocked by fixture' }) : fixture).toString('base64') }).catch(error => errors.push(String(error)))
  }
  const callback = pending.get(message.id)
  if (!callback) return
  pending.delete(message.id)
  if (message.error) callback.reject(new Error(JSON.stringify(message.error)))
  else callback.resolve(message.result)
}
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
const wait = async expression => {
  for (let count = 0; count < 100; count++) {
    if (await evaluate(expression)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out: ${expression}\n${JSON.stringify(errors)}`)
}
const check = async (name, expression) => { await wait(expression); checks.push(name) }
const expanded = 'document.querySelector(".xixi-reasoning")?.dataset.expanded === "true"'
const collapsed = 'document.querySelector(".xixi-reasoning")?.dataset.expanded === "false"'
try {
  browserContextId = (await send('Target.createBrowserContext', {}, null)).browserContextId
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId }, null)
  sessionId = (await send('Target.attachToTarget', { targetId, flatten: true }, null)).sessionId
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Network.setBypassServiceWorker', { bypass: true })
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/__focus_reasoning_fixture', requestStage: 'Request' }, { urlPattern: '*/api/*', requestStage: 'Request' }] })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await send('Page.navigate', { url: new URL('__focus_reasoning_fixture', base).href })
  await check('live thinking starts collapsed and shows only the current tool', `${collapsed} && !document.querySelector('.xixi-stream-activities') && document.querySelector('.xixi-stream-status')?.textContent.includes('正在核对课程与空档') && document.querySelector('.xixi-stream-status')?.textContent.includes('读取日程')`)
  await mkdir(output, { recursive: true })
  await writeFile(`${output}/current-tool-desktop.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  await evaluate('document.querySelector(".xixi-reasoning-toggle").click()')
  await check('full reasoning remains available on demand', expanded)
  await check('focus reasoning text has visible height and opacity', '(()=>{const e=document.querySelector(".xixi-reasoning-collapse");return e.getBoundingClientRect().height>40&&getComputedStyle(e).opacity==="1"&&!e.inert})()')
  await evaluate('renderChat({stream:{...draft,phase:"replying",content:"核对完成",activities:[{...draft.activities[0],state:"done"}]}})')
  await check('reply phase keeps tool-round thinking expanded', `${expanded} && document.querySelector('.xixi-stream').textContent.includes('工具之前的完整思考')`)
  await evaluate('window.assistant={id:"a1",requestId:"r1",seq:4,role:"assistant",content:"核对完成",createdAt:"",hasSavedReasoning:true};renderChat({sending:false,stream:null,conversation:{...chat.conversation,messages:[user,assistant]}})')
  await check('live-to-saved remount preserves expansion and retrieves both complete rounds', `${expanded} && !document.querySelector('.xixi-stream') && document.querySelectorAll('.xixi-reasoning-round').length===2`)
  await evaluate('document.querySelector(".xixi-reasoning-copy button").click()')
  await check('copying the completed thinking preserves the exact full transcript', `window.copied === ${JSON.stringify(saved.reasoningContent)}`)
  await evaluate('renderChat({sending:true,stream:draft});')
  await wait('!!document.querySelector(".xixi-stream")')
  await evaluate('document.querySelector(".xixi-reasoning-toggle").click()')
  await check('manual collapse is respected during a subsequent thinking phase', collapsed)
  await evaluate('renderChat({stream:{...draft,phase:"thinking"}})')
  await check('a new thinking phase does not override manual collapse', collapsed)
  await evaluate('renderChat({sending:false,stream:null})')
  await check('completion preserves manual collapse', `${collapsed} && !document.querySelector('.xixi-stream')`)
  await evaluate('renderChat({sending:true,stream:draft});')
  await wait('!!document.querySelector(".xixi-stream")')
  await evaluate('document.querySelector(".xixi-reasoning-toggle").click()')
  await evaluate('renderChat({sending:false,stream:null,conversation:{...chat.conversation,messages:[user]},interruptedReasoning:{r1:draft}})')
  await check('interruption retains expanded thinking before and after tools', `${expanded} && document.querySelector('.xixi-reasoning').textContent.includes('回复中断') && document.querySelectorAll('.xixi-reasoning-round').length===2`)
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await evaluate('document.querySelector(".wb-xixi").scrollIntoView({block:"end"})')
  await check('narrow focus panel retains readable reasoning without horizontal overflow', '(()=>{const e=document.querySelector(".xixi-reasoning");return e.getBoundingClientRect().width>200&&e.scrollWidth<=e.clientWidth+1&&e.querySelector(".xixi-reasoning-content").getBoundingClientRect().height>40})()')
  await evaluate('renderChat({sending:true,stream:draft})')
  await check('narrow current-tool line fits without clipped helper text', '(()=>{const e=document.querySelector(".xixi-stream-status");return !!e&&e.scrollWidth<=e.clientWidth+1&&e.textContent.includes("读取日程")&&!document.querySelector(".xixi-stream-activities")})()')
  await evaluate('document.querySelector(".xixi-reasoning-toggle").click()')
  await check('narrow live thinking can return to the compact current-tool view', collapsed)
  await writeFile(`${output}/current-tool-mobile.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  assert.deepEqual(errors, [])
  assert.ok(apiRequests.length > 0 && apiRequests.every(url => new URL(url).pathname === '/api/conversation/reasoning'))
  await mkdir(output, { recursive: true })
  await writeFile(`${output}/focus-reasoning.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  await writeFile(`${output}/checks.json`, JSON.stringify({ checks, apiRequests, errors }, null, 2))
  console.log(JSON.stringify({ checks, output }, null, 2))
} finally {
  if (browserContextId) await send('Target.disposeBrowserContext', { browserContextId }, null).catch(() => {})
  ws.close()
}
