/** Isolated storage QA. Run: node scripts/verify-spatial-storage.mjs */
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

const origin = 'http://127.0.0.1:5177'
const debug = 'http://127.0.0.1:9228'
const profile = '/tmp/astaria-storage-qa-0916'
const artifacts = new URL('../artifacts/actual-functionality/', import.meta.url)
const checks = [], pages = [], output = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = value => { output.push(value); console.log(value) }
let chrome, failure

async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let serial = 0
  const pending = new Map(), listeners = new Map(), exceptions = []
  socket.onmessage = event => {
    const result = JSON.parse(event.data)
    if (result.id) {
      const callback = pending.get(result.id)
      if (!callback) return
      pending.delete(result.id)
      clearTimeout(callback.timeout)
      if (result.error) callback.reject(new Error(JSON.stringify(result.error)))
      else callback.resolve(result.result)
    } else {
      if (result.method === 'Runtime.exceptionThrown') exceptions.push(result.params)
      listeners.get(result.method)?.(result.params)
    }
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 20000)
    pending.set(id, { resolve, reject, timeout })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const wait = async expression => {
    for (let attempt = 0; attempt < 160; attempt++) {
      if (await evaluate(expression)) return
      await delay(100)
    }
    throw new Error(`Timeout: ${expression}`)
  }
  const click = async selector => {
    const point = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing ${selector}');const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    await delay(80)
  }
  const text = async (selector, value) => { await click(selector); await send('Input.insertText', { text: value }) }
  const allRows = () => evaluate(`(async()=>{const {taskStore}=await import('/src/stores/taskStore.ts');return taskStore.listTasks()})()`)
  const page = { target, socket, send, evaluate, wait, click, text, allRows, listeners, exceptions }
  pages.push(page)
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Network.setBypassServiceWorker', { bypass: true })
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  return page
}

async function newPage() {
  const target = await fetch(`${debug}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json())
  return connect(target)
}

async function ready(page) {
  await page.wait('!!window.__ASTARIA_P0__ && !!document.querySelector(".spatial-launch:not(:disabled)")')
  await page.evaluate('window.__ASTARIA_P0__.setPaused(true)')
}

async function patch(page, method, body) {
  await page.evaluate(`(async()=>{const {taskStore}=await import('/src/stores/taskStore.ts');window.__storageQA??={};const original=taskStore[${JSON.stringify(method)}];window.__storageQA[${JSON.stringify(method)}]={original,calls:0};taskStore[${JSON.stringify(method)}]=async function(...args){window.__storageQA[${JSON.stringify(method)}].calls++;${body}}})()`)
}

async function restore(page, method) {
  await page.evaluate(`(async()=>{const {taskStore}=await import('/src/stores/taskStore.ts');taskStore[${JSON.stringify(method)}]=window.__storageQA[${JSON.stringify(method)}].original})()`)
}

function pass(name, evidence) { checks.push({ name, pass: true, evidence }); log(`PASS ${name}`) }

try {
  await fs.mkdir(artifacts, { recursive: true })
  let occupied = false
  try { occupied = (await fetch(`${debug}/json/version`, { signal: AbortSignal.timeout(800) })).ok } catch {}
  assert.equal(occupied, false, '9228 must be free; never attach to another browser')
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--remote-debugging-port=9228', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank',
  ], { stdio: 'ignore' })
  chrome.on('error', error => { failure = error })
  let browserReady = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failure) throw failure
    try { browserReady = (await fetch(`${debug}/json/version`)).ok } catch {}
    if (browserReady) break
    await delay(100)
  }
  assert.ok(browserReady, 'isolated Chrome started')
  const first = await newPage()
  await first.send('Storage.clearDataForOrigin', { origin, storageTypes: 'indexeddb' })
  await first.send('Page.navigate', { url: `${origin}/` })
  await ready(first)
  const second = await newPage()
  await second.send('Page.navigate', { url: `${origin}/` })
  await ready(second)
  assert.equal((await first.allRows()).length, 0)

  await first.click('.spatial-launch')
  await first.text('#spatial-title', '跨标签同步任务')
  await first.text('#spatial-notes', '独立测试浏览器中的同步验收')
  await first.click('.spatial-submit')
  await first.wait('!document.querySelector("dialog") && document.querySelectorAll(".spatial-node").length===1')
  await second.wait('document.querySelectorAll(".spatial-node").length===1')
  const [created] = await first.allRows()
  assert.equal(await second.evaluate('document.querySelector(".spatial-node").dataset.taskId'), created.id)
  pass('same-origin second tab receives creation through liveQuery without reload', { id: created.id, title: created.title })

  await second.click('.spatial-node')
  await second.click('.spatial-status-options button:nth-child(2)')
  await second.wait('document.querySelector(".spatial-task-state")?.textContent.includes("进行中")')
  await first.wait('!!document.querySelector(".spatial-node[data-status=doing]")')
  assert.equal((await first.allRows())[0].status, 'doing')
  pass('second-tab status change reaches first-tab orbital node without reload', { status: 'doing' })

  await first.click('.spatial-launch')
  await first.text('#spatial-title', '失败后保留的任务')
  await first.text('#spatial-notes', '失败后必须保留这条备注')
  await patch(first, 'createTask', "throw new Error('QA create failure')")
  await first.click('.spatial-submit')
  await first.wait('document.querySelector(".spatial-form-error")?.textContent.includes("QA create failure")')
  const retained = await first.evaluate('({title:document.querySelector("#spatial-title").value,notes:document.querySelector("#spatial-notes").value,error:document.querySelector(".spatial-form-error").textContent})')
  assert.equal(retained.title, '失败后保留的任务')
  assert.equal(retained.notes, '失败后必须保留这条备注')
  assert.equal((await first.allRows()).length, 1)
  await restore(first, 'createTask')
  await first.click('.spatial-submit')
  await first.wait('!document.querySelector("dialog") && document.querySelectorAll(".spatial-node").length===2')
  assert.equal((await first.allRows()).length, 2)
  pass('failed create retains input, writes no row, and succeeds after retry', retained)

  const beforeUpdate = await second.evaluate('(()=>{const n=document.querySelector(".spatial-node[data-status=doing]");return{status:n.dataset.status,left:n.style.left,top:n.style.top,count:document.querySelectorAll(".spatial-node").length}})()')
  await patch(second, 'updateTask', "throw new Error('QA update failure')")
  await second.click('.spatial-status-options button:nth-child(3)')
  await second.wait('document.querySelector(".spatial-form-error")?.textContent.includes("QA update failure")')
  const afterUpdate = await second.evaluate('(()=>{const n=document.querySelector(".spatial-node[data-status=doing]");return{status:n.dataset.status,left:n.style.left,top:n.style.top,count:document.querySelectorAll(".spatial-node").length}})()')
  assert.deepEqual(afterUpdate, beforeUpdate)
  assert.equal(await second.evaluate('document.querySelector(".spatial-task-state").textContent.includes("进行中") && !document.querySelector(".spatial-completion")'), true)
  assert.equal((await first.allRows()).find(row => row.id === created.id).status, 'doing')
  await restore(second, 'updateTask')
  await second.click('.spatial-status-options button:nth-child(3)')
  await second.wait('document.querySelector(".spatial-task-state")?.textContent.includes("已完成")')
  await first.wait('!document.querySelector(".spatial-node[data-status=doing]")')
  assert.equal((await first.allRows()).find(row => row.id === created.id).status, 'done')
  pass('failed status save preserves data and orbital state; retry completes task', { before: beforeUpdate, after: afterUpdate })

  // Only this tab receives a modified dev-server response, before React first mounts.
  const third = await newPage()
  let injectionError, injectionApplied = false
  third.listeners.set('Fetch.requestPaused', params => {
    void (async () => {
      try {
        const response = await third.send('Fetch.getResponseBody', { requestId: params.requestId })
        const body = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body
        const injection = `\nconst {taskStore:qaTaskStore}=await import('/src/stores/taskStore.ts');window.__storageQA={listTasks:{original:qaTaskStore.listTasks,calls:0}};qaTaskStore.listTasks=async()=>{window.__storageQA.listTasks.calls++;throw new Error('QA initial list failure')};\n`
        await third.send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }],
          body: Buffer.from(injection + body).toString('base64') })
        injectionApplied = true
      } catch (error) { injectionError = error; await third.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {}) }
    })()
  })
  await third.send('Fetch.enable', { patterns: [{ urlPattern: `${origin}/src/main.tsx*`, requestStage: 'Response' }] })
  await third.send('Page.navigate', { url: `${origin}/` })
  await third.wait('document.querySelector(".spatial-load-error")?.textContent.includes("QA initial list failure")')
  if (injectionError) throw injectionError
  assert.equal(injectionApplied, true)
  const loadError = await third.evaluate('document.querySelector(".spatial-load-error").textContent')
  assert.equal(await third.evaluate('document.querySelectorAll(".spatial-node").length'), 0)
  await restore(third, 'listTasks')
  await third.send('Fetch.disable')
  await third.click('.spatial-load-error button')
  await third.wait('!document.querySelector(".spatial-load-error") && document.querySelectorAll(".spatial-node").length===1')
  await ready(third)
  assert.equal((await third.allRows()).length, 2)
  pass('initial read failure is visible and retry reads existing persisted tasks', { error: loadError, rowsAfterRetry: 2 })

  await first.click('.spatial-launch')
  await first.text('#spatial-title', '同步双提交唯一任务')
  await patch(first, 'createTask', 'await new Promise(resolve=>setTimeout(resolve,250));return original.apply(this,args)')
  await first.evaluate('(()=>{const form=document.querySelector("dialog form");form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));return true})()')
  await first.wait('!document.querySelector("dialog")')
  const calls = await first.evaluate('window.__storageQA.createTask.calls')
  await restore(first, 'createTask')
  const finalRows = await first.allRows()
  assert.equal(calls, 1)
  assert.equal(finalRows.filter(row => row.title === '同步双提交唯一任务').length, 1)
  assert.equal(finalRows.length, 3)
  pass('two synchronous submit events invoke one create and persist one task', { createCalls: calls, totalRows: finalRows.length })
  assert.equal(pages.reduce((sum, page) => sum + page.exceptions.length, 0), 0)
  pass('no uncaught browser runtime exceptions', { pages: pages.length })
} catch (error) {
  failure = error
  log(`FAIL ${error.stack ?? error}`)
} finally {
  for (const page of pages) {
    await page.evaluate(`(async()=>{const saved=window.__storageQA;if(!saved)return;const {taskStore}=await import('/src/stores/taskStore.ts');for(const [name,entry] of Object.entries(saved))taskStore[name]=entry.original;delete window.__storageQA})()`).catch(error => log(`Cleanup: ${error.message}`))
    page.socket.close()
  }
  if (chrome && chrome.exitCode === null) {
    chrome.kill('SIGTERM')
    for (let attempt = 0; attempt < 50 && chrome.exitCode === null; attempt++) await delay(100)
    if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGKILL')
  }
  const report = { origin, debugPort: 9228, profile, temporaryBrowserClosed: !!chrome && (chrome.exitCode !== null || chrome.signalCode !== null), checks,
    exceptions: pages.flatMap(page => page.exceptions), failure: failure ? String(failure) : undefined,
    limitations: ['Dev-server fault injection in an isolated headless Chrome profile; this does not simulate physical disk loss or quota exhaustion.'] }
  await fs.mkdir(artifacts, { recursive: true })
  await fs.writeFile(new URL('storage-checks.json', artifacts), JSON.stringify(report, null, 2) + '\n')
  await fs.writeFile(new URL('storage-output.txt', artifacts), output.join('\n') + '\n')
}
if (failure) process.exitCode = 1
