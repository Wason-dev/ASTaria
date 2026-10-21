/** Beta12.1 regression: owned browser, in-memory data and scripted vision provider. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { DEFAULT_PREFERENCES } from '../server/preferences.mjs'
import { saveModelSettings } from '../server/modelSettings.mjs'
import { PENDING_CHAT_DATABASE, PENDING_CHAT_OBJECT_STORE, PENDING_CHAT_INDEX_KEY, PENDING_CHAT_SCOPE_KEY } from '../src/xixi/pendingChatRequest.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const flightOnly = process.argv.includes('--flight-only')
const temporary = await mkdtemp(join(tmpdir(), 'astaria-beta12-patch-'))
const output = resolve(process.env.PATCH_QA_OUTPUT ?? join(root, 'artifacts/beta12.1-ui'))
const profile = join(temporary, 'chrome-profile')
// Verified 2x3 RGB PNG (CRC-correct, inflates to 21 bytes); the previous 1x1 fixture had a corrupt IDAT CRC.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGOMatrCwMDAxAAGUAoAHaoBllxQ+i0AAAAASUVORK5CYII='
const db = createDatabase(':memory:')
const task = db.createTask({ title: '核对实验记录', estimateMin: 30, inbox: false })
db.setPreference('onboarding-completed', true)
const preferences = { ...DEFAULT_PREFERENCES, render: { profile: 'full', quality: 'ultra', glass: 'auto' } }
db.setPreference('app', preferences)
saveModelSettings(db, { provider: 'local', cloudModel: 'deepseek-flash', reasoningEffort: 'low', streamResponses: false,
  contextBudget: { mode: 'auto', maxUnits: 48_000 }, webSearch: { enabled: false, maxUses: 2 },
  local: { engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3-vl:8b' } })
const checks = [], errors = [], calls = [], budgets = [], blockedRequests = [], uploads = [], findings = [], pendingStorage = []
let chrome, vite, ws, base, stopping = false, releaseReply, holdNext = false, chooser
const service = createLocalService({ db, dataDirectory: ':memory:',
  vault: { status: async () => true, read: async () => { throw Error('QA must never read credentials') } },
  fetcher: async () => { throw Error('QA must never contact external services') },
  complete: async payload => {
    calls.push(payload)
    if (holdNext) { holdNext = false; await new Promise(resolve => { releaseReply = resolve }) }
    return { choices: [{ message: { role: 'assistant', content: '收到了，我们接着看这件事。' } }] }
  },
})
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let serial = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial
  const timeout = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)) }, 20000)
  pending.set(id, { resolve, reject, timeout }); ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
const wait = async expression => {
  for (let index = 0; index < 300; index++) {
    try { if (await evaluate(expression)) return }
    catch (error) {
      // Reload may invalidate the old execution context after Page.reload replies.
      if (!/Inspected target navigated or closed|Execution context was destroyed|Cannot find context/u.test(error.message)) throw error
    }
    await delay(100)
  }
  throw Error(`Timeout: ${expression}`)
}
const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); checks.push(name) }
const click = async selector => {
  await wait(`!!document.querySelector(${JSON.stringify(selector)})`)
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'});true`)
  await delay(100)
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();if(e.disabled||e.closest('[inert]')||!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Unavailable '+${JSON.stringify(selector)});return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await delay(100)
}
const nav = async text => {
  if (await evaluate(`document.querySelector('#home-menu').inert`)) await click('.home-brand')
  await evaluate(`(()=>{const e=[...document.querySelectorAll('#home-menu button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing navigation');e.dataset.patchClick='true'})()`)
  await click('[data-patch-click]'); await evaluate(`document.querySelectorAll('[data-patch-click]').forEach(e=>delete e.dataset.patchClick)`)
}
const shot = async name => writeFile(join(output, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
const drop = async (filesExpression, type = 'drop', extra = '') => evaluate(`(()=>{const d=new DataTransfer();for(const f of ${filesExpression})d.items.add(f);${extra}const e=new DragEvent(${JSON.stringify(type)},{bubbles:true,cancelable:true,dataTransfer:d});document.body.dispatchEvent(e);return e.defaultPrevented})()`)
const image = name => `[new File([Uint8Array.from(atob('${png}'),c=>c.charCodeAt(0))],${JSON.stringify(name)},{type:'image/png'})]`
const selected = (host, name) => `document.querySelector(${JSON.stringify(`${host} .xixi-attachment-chip`)})?.textContent.includes(${JSON.stringify(name)})`
const draft = async (selector, text) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
// Fixture bytes are generated in the page: the real 2x3 PNG plus spec-shaped tEXt chunks (correct length and CRC32)
// inserted before IEND, so large fixtures stay valid PNGs instead of fake headers or trailing garbage.
const fixtureSource = `(()=>{
  const table = Uint32Array.from({ length: 256 }, (_, value) => { for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); return value >>> 0 })
  const crc32 = bytes => { let crc = 0xffffffff; for (let index = 0; index < bytes.length; index++) crc = table[(crc ^ bytes[index]) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer); view.setUint32(0, data.length); for (let index = 0; index < 4; index++) out[4 + index] = type.charCodeAt(index); out.set(data, 8); view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length))); return out }
  const base = Uint8Array.from(atob('${png}'), character => character.charCodeAt(0))
  const head = base.subarray(0, base.length - 12), iend = base.subarray(base.length - 12)
  window.__qaFixtures = {}
  window.__qaPngBytes = (total, name) => {
    const padding = total - head.length - iend.length
    if (padding < 23) throw new Error('QA fixture target too small: ' + total)
    const count = Math.max(1, Math.ceil(padding / (1024 * 1024))), fixed = Math.floor(padding / count), parts = [head]
    for (let index = 0; index < count; index++) {
      const keyword = 'Comment' + String(index).padStart(2, '0')
      const text = index === count - 1 ? padding - fixed * (count - 1) - 22 : fixed - 22
      const data = new Uint8Array(keyword.length + 1 + text)
      for (let at = 0; at < keyword.length; at++) data[at] = keyword.charCodeAt(at)
      data[keyword.length] = 0
      data.fill(0x41, keyword.length + 1)
      parts.push(chunk('tEXt', data))
    }
    parts.push(iend)
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const part of parts) { bytes.set(part, offset); offset += part.length }
    if (offset !== total) throw new Error('QA fixture size ' + offset + ' != ' + total)
    window.__qaFixtures[name] = bytes
    return bytes
  }
  window.__qaPngFile = (total, name) => new File([window.__qaPngBytes(total, name)], name, { type: 'image/png' })
  // CRC-correct header and IDAT container with an invalid zlib payload: only the real decoder can reject it.
  window.__qaCorruptFile = name => {
    const bytes = Uint8Array.from([...head.subarray(0, 33), ...chunk('IDAT', new Uint8Array(20).fill(0xff)), ...iend])
    window.__qaFixtures[name] = bytes
    return new File([bytes], name, { type: 'image/png' })
  }
  // Header declares a 9000 pixel edge, past the 8192 rule, with a corrected IHDR CRC.
  window.__qaOverEdgeFile = name => {
    const ihdr = Uint8Array.from(head.subarray(0, 33)), view = new DataView(ihdr.buffer)
    view.setUint32(16, 9000); view.setUint32(20, 2); view.setUint32(29, crc32(ihdr.subarray(12, 29)))
    const bytes = Uint8Array.from([...ihdr, ...iend])
    window.__qaFixtures[name] = bytes
    return new File([bytes], name, { type: 'image/png' })
  }
  return true
})()`
const bigImage = (name, total) => `[window.__qaPngFile(${total},${JSON.stringify(name)})]`
const originalImageHash = name => evaluate(`(async()=>{
  const bytes=window.__qaFixtures[${JSON.stringify(name)}]
  if(!bytes)throw Error('Missing original fixture')
  const digest=await crypto.subtle.digest('SHA-256',bytes)
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')
})()`)
const assertOriginalUpload = async (name, size, originalHash) => {
  const content = calls.at(-1)?.messages.filter(message => message.role === 'user').at(-1)?.content
  assert.ok(Array.isArray(content), `${name}: scripted provider received an image message`)
  const images = content.filter(part => part.type === 'image_url')
  assert.equal(images.length, 1, `${name}: exactly one image reached the scripted provider`)
  const data = images[0].image_url.url, prefix = 'data:image/png;base64,'
  assert.ok(data.startsWith(prefix), `${name}: real PNG MIME survived the service`)
  const bytes = Buffer.from(data.slice(prefix.length), 'base64')
  assert.equal(bytes.length, size, `${name}: service did not truncate or compress the image`)
  const expected = originalHash ?? await originalImageHash(name)
  const actual = createHash('sha256').update(bytes).digest('hex')
  assert.equal(actual, expected, `${name}: provider bytes exactly match the original PNG`)
  const stored = db.listMessages(db.getActiveConversation().id).filter(message => message.role === 'user').at(-1)?.attachments
  assert.equal(stored?.length, 1, `${name}: one original image persisted in the isolated database`)
  assert.equal(stored[0].name, name); assert.equal(stored[0].mime, 'image/png'); assert.equal(stored[0].size, size)
  assert.equal(stored[0].data, data, `${name}: persisted data exactly matches the provider upload`)
  uploads.push({ name, size, sha256: actual, providerBytesExact: true, persistedBytesExact: true, decodedDimensions: [2, 3] })
}
// Promise-style File.prototype.arrayBuffer gates replace the retired FileReader stub. Only the named fixtures are
// intercepted; every other file must keep using the saved native method, which is restored in every exit path.
const gateSource = `(()=>{
  window.__qaNativeArrayBuffer = File.prototype.arrayBuffer
  window.__qaGates = {}
  window.__qaReadLog = []
  File.prototype.arrayBuffer = function () {
    const native = () => window.__qaNativeArrayBuffer.call(this)
    if (this.name === 'slow-old.png' || this.name === 'fast-new.png') {
      window.__qaReadLog.push(this.name)
      return new Promise((resolve, reject) => { window.__qaGates[this.name] = { resolve, reject, bytes: native() } })
    }
    if (this.name === 'bad-read.png') { window.__qaReadLog.push(this.name); return Promise.reject(new Error('QA injected read failure')) }
    return native()
  }
  window.__qaResolveRead = async name => {
    const gate = window.__qaGates[name]
    if (!gate) throw new Error('QA has no pending read for ' + name)
    const bytes = await gate.bytes
    gate.resolve(bytes)
    delete window.__qaGates[name]
    return bytes.byteLength
  }
  return true
})()`
const restoreArrayBufferStub = () => evaluate(`(()=>{ if (window.__qaNativeArrayBuffer) { File.prototype.arrayBuffer = window.__qaNativeArrayBuffer; delete window.__qaNativeArrayBuffer } delete window.__qaGates; return true })()`).catch(() => {})
const restoreStorageProbe = () => evaluate(`(()=>{ if(window.__qaNativeSetItem){Storage.prototype.setItem=window.__qaNativeSetItem;delete window.__qaNativeSetItem}return true})()`).catch(() => {})
// The owned browser keeps native IndexedDB transactions and native fetch. The
// observer records the actual commit before fetch begins; failures are opt-in.
function installPendingProbe(options) {
  const nativePut = IDBObjectStore.prototype.put, nativeFetch = window.fetch
  window.__qaPendingCommitted = new Set()
  window.__qaPendingNetwork = []
  window.__qaPendingWrites = []
  IDBObjectStore.prototype.put = function (value, ...args) {
    if (this.transaction.db.name === options.database && this.name === options.store) {
      if (window.__qaFailPendingWrite) {
        window.__qaFailPendingWrite = false
        const tx = this.transaction, request = nativePut.call(this, value, ...args)
        request.addEventListener('success', () => {
          window.__qaPendingWrites.push({ requestId: value.requestId, putSucceeded: true, transactionAborted: true })
          tx.abort()
        }, { once: true })
        return request
      }
      const tx = this.transaction, complete = tx.oncomplete
      tx.oncomplete = function (event) {
        window.__qaPendingCommitted.add(value.requestId)
        window.__qaPendingWrites.push({ requestId: value.requestId, committed: true, fields: Object.keys(value) })
        complete?.call(tx, event)
      }
    }
    return nativePut.call(this, value, ...args)
  }
  const records = async () => {
    const { createIndexedDBPendingChatAdapter } = await import('/src/xixi/pendingChatRequest.ts')
    const scope = sessionStorage.getItem(options.scope)
    return scope ? createIndexedDBPendingChatAdapter().list(scope) : []
  }
  const hash = async data => {
    const binary = atob(data.slice(data.indexOf(',') + 1)), bytes = Uint8Array.from(binary, value => value.charCodeAt(0))
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
  }
  const canonical = value => JSON.stringify(value, function (key, item) {
    return item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item
  })
  window.__qaPendingSnapshot = async (recover = false) => {
    const saved = await records()
    if (recover) for (const record of saved) window.__qaPendingCommitted.add(record.requestId)
    return { indexCharacters: (sessionStorage.getItem(options.index) ?? '').length, indexHasBase64: (sessionStorage.getItem(options.index) ?? '').includes('base64'),
      records: await Promise.all(saved.map(async record => ({ requestId: record.requestId, conversationId: record.conversationId, text: record.text, seq: record.seq, createdAt: record.createdAt,
        attachments: await Promise.all((record.attachments ?? []).map(async image => ({ name: image.name, size: image.size, sha256: await hash(image.data) }))),
      }))),
    }
  }
  window.fetch = async function (input, init) {
    if (new URL(typeof input === 'string' ? input : input.url, location.href).pathname === '/api/chat' && init?.method === 'POST') {
      const body = JSON.parse(init.body), committedBeforeFetch = window.__qaPendingCommitted.has(body.requestId)
      const saved = (await records()).find(record => record.requestId === body.requestId)
      const bytesExact = !!saved && saved.conversationId === body.conversationId && saved.text === body.text && canonical(saved.context) === canonical(body.context) && canonical(saved.attachments ?? []) === canonical(body.attachments ?? [])
      const observation = { requestId: body.requestId, conversationId: body.conversationId, committedBeforeFetch, bytesExact,
        hashes: await Promise.all((saved?.attachments ?? []).map(async image => ({ name: image.name, size: image.size, sha256: await hash(image.data) }))),
      }
      window.__qaPendingNetwork.push(observation)
      if (!committedBeforeFetch || !bytesExact) throw Error('QA: API called before the exact pending request committed')
      if (window.__qaFailChatTransport) { window.__qaFailChatTransport = false; observation.injectedDisconnect = true; throw new TypeError('QA injected transport disconnect') }
    }
    return nativeFetch.call(this, input, init)
  }
  window.__qaRestorePendingProbe = () => { IDBObjectStore.prototype.put = nativePut; window.fetch = nativeFetch }
}
const pendingProbeSource = `(${installPendingProbe.toString()})(${JSON.stringify({ database: PENDING_CHAT_DATABASE, store: PENDING_CHAT_OBJECT_STORE, index: PENDING_CHAT_INDEX_KEY, scope: PENDING_CHAT_SCOPE_KEY })})`
const pendingSnapshot = () => evaluate('window.__qaPendingSnapshot()')
const freshImageTopic = async () => {
  const previous = db.getActiveConversation().id
  await click('#home-xixi .xixi-topic-menu>button'); await click('#home-xixi .xixi-topic-new')
  await wait(`!document.querySelector('#home-xixi .xixi-topic-popover') && !document.querySelector('#home-xixi .xixi-message-attachments img') && !document.querySelector('#home-xixi .xixi-attachment-button').disabled`)
  assert.notEqual(db.getActiveConversation().id, previous)
}
const pendingStorageCases = async () => {
  await freshImageTopic()
  const beforeFailure = calls.length
  await draft('#home-compose', '存储失败时保留输入')
  await drop(bigImage('idb-failure.png', 10 * 1024 * 1024)); await wait(selected('#home-xixi', 'idb-failure.png'))
  await evaluate('window.__qaFailPendingWrite=true')
  await click('#home-xixi .home-capture')
  await wait(`document.querySelector('#home-xixi .xixi-send-error')?.textContent.includes('保存本机发送记录')`)
  assert.equal(calls.length, beforeFailure)
  await check('IndexedDB write failure retains 10 MiB image and text without claiming a send', `document.querySelector('#home-compose').value==='存储失败时保留输入' && ${selected('#home-xixi', 'idb-failure.png')} && !document.querySelector('#home-xixi [data-delivery=sending]')`)
  const failedWrite = await pendingSnapshot(); assert.equal(failedWrite.records.length, 0)
  const abortedWrite = await evaluate('window.__qaPendingWrites.at(-1)')
  assert.equal(abortedWrite.putSucceeded, true); assert.equal(abortedWrite.transactionAborted, true)
  pendingStorage.push({ case: 'write-failure', ...failedWrite, abortedWrite, noAPICall: true, inputRetained: true })
  await shot('pending-write-failure')
  await click('#home-xixi .home-capture')
  await wait(`!document.querySelector('#home-xixi .xixi-attachment-chip') && !document.querySelector('#home-xixi .home-capture').textContent.includes('正在')`)
  await assertOriginalUpload('idb-failure.png', 10 * 1024 * 1024)
  assert.equal((await pendingSnapshot()).records.length, 0)
  checks.push('retry after native IndexedDB write failure sends the unchanged 10 MiB original and cleans temporary records')
  pendingStorage.push({ case: 'write-failure-retry', ...uploads.at(-1), temporaryRecords: 0 })
  await freshImageTopic()
  await drop(bigImage('reload-pending.png', 10 * 1024 * 1024)); await wait(selected('#home-xixi', 'reload-pending.png'))
  await evaluate('window.__qaFailChatTransport=true')
  const beforeDisconnect = calls.length
  await click('#home-xixi .home-capture')
  await wait(`!!document.querySelector('#home-xixi [data-delivery=failed] .xixi-delivery button')`)
  assert.equal(calls.length, beforeDisconnect)
  const before = await pendingSnapshot(); assert.equal(before.records.length, 1)
  assert.equal(before.indexHasBase64, false); assert.ok(before.indexCharacters < 1024)
  const record = before.records[0], digest = record.attachments[0].sha256, originalConversation = record.conversationId
  assert.equal(digest, await originalImageHash('reload-pending.png'), 'pending record preserves the original file hash before reload')
  pendingStorage.push({ case: 'transport-failure', ...before })
  const beforeReload = await evaluate('window.__qaPendingNetwork')
  assert.ok(beforeReload.length > 0 && beforeReload.every(item => item.committedBeforeFetch && item.bytesExact))
  pendingStorage.push({ case: 'commit-before-reload', observations: beforeReload })
  await shot('pending-before-reload')
  await send('Page.reload')
  await wait(`!!window.__ASTARIA_P0__ && !!document.querySelector('.home-launch:not(:disabled)')`)
  await click('.home-launch'); await wait(`${settled} && !!document.querySelector('#home-xixi [data-delivery=failed] .xixi-delivery button')`)
  const restored = await evaluate('window.__qaPendingSnapshot(true)')
  assert.deepEqual(restored.records, before.records)
  await check('reload restores the failed image request with its original ID and decoded image', `(()=>{const message=document.querySelector('#home-xixi [data-delivery=failed]'),img=message?.querySelector('.xixi-message-attachments img');return message?.dataset.messageId==='optimistic:${record.requestId}'&&!!img&&img.complete&&img.naturalWidth===2&&img.naturalHeight===3})()`)
  pendingStorage.push({ case: 'reload', ...restored, sameRequestId: true, sameOriginalHash: true })
  await shot('pending-after-reload')
  await freshImageTopic()
  await check('a second topic does not display another conversation pending attachment', `!document.querySelector('#home-xixi [data-delivery=failed]') && !document.querySelector('#home-xixi .xixi-message-attachments img')`)
  await click('#home-xixi .xixi-topic-menu>button')
  await wait(`!!document.querySelector('#home-xixi [data-topic-id="${originalConversation}"] .xixi-topic-select')`)
  await click(`#home-xixi [data-topic-id="${originalConversation}"] .xixi-topic-select`)
  await wait(`!!document.querySelector('#home-xixi [data-delivery=failed] .xixi-delivery button')`)
  checks.push('returning to the original topic restores only its own pending image request')
  await click('#home-xixi [data-delivery=failed] .xixi-delivery button')
  await wait(`!document.querySelector('#home-xixi [data-delivery=failed]') && !document.querySelector('#home-xixi .home-capture').textContent.includes('正在')`)
  await assertOriginalUpload('reload-pending.png', 10 * 1024 * 1024, digest)
  assert.equal(uploads.at(-1).sha256, digest)
  const completed = db.listMessages(originalConversation).filter(message => message.role === 'user').at(-1)
  assert.equal(completed.requestId, record.requestId)
  const after = await pendingSnapshot(); assert.equal(after.records.length, 0)
  checks.push('reload retry uses the same requestId and original 10 MiB hash and removes the IndexedDB request')
  pendingStorage.push({ case: 'reload-retry', requestId: record.requestId, ...uploads.at(-1), temporaryRecords: 0 })
  await shot('pending-retry-complete')
  const observations = await evaluate('window.__qaPendingNetwork')
  assert.ok(observations.length > 0 && observations.every(item => item.committedBeforeFetch && item.bytesExact))
  pendingStorage.push({ case: 'commit-before-API', observations })
  await freshImageTopic()
}
const settled = `!window.__ASTARIA_P0__.getSnapshot().cameraTransition`
const observe = () => evaluate(`(()=>{window.patchBudgets=[];window.patchObserving=true;const tick=()=>{if(!window.patchObserving)return;const s=window.__ASTARIA_P0__.getSnapshot();window.patchBudgets.push({moving:s.cameraTransition,fps:s.targetFps,scene:s.renderScene,quality:s.quality});requestAnimationFrame(tick)};tick();return true})()`)
const finishObservation = async (name, rate) => {
  const samples = await evaluate(`window.patchObserving=false;window.patchBudgets`)
  assert.ok(samples.some(sample => sample.moving), `${name}: real camera moved`)
  assert.ok(samples.every(sample => !sample.moving || sample.fps === rate), `${name}: all moving frames retain ${rate}: ${JSON.stringify(samples.filter(s=>s.moving&&s.fps!==rate))}`)
  assert.ok(samples.every(sample => sample.quality === 'ultra'), `${name}: manual quality retained`)
  budgets.push({ name, rate, frames: samples.length, movingFrames: samples.filter(s=>s.moving).length, movingBudgets: [...new Set(samples.filter(s=>s.moving).map(s=>s.fps))], final: samples.at(-1) })
  checks.push(`${name}: moving camera retains ${rate} FPS and ultra quality`)
}
const observeFlight = () => evaluate(`(()=>{window.patchBudgets=[];window.patchObserving=true;const token=window.patchObservationToken=(window.patchObservationToken??0)+1;const tick=()=>{if(!window.patchObserving||window.patchObservationToken!==token)return;const s=window.__ASTARIA_P0__.getSnapshot();window.patchBudgets.push({flight:s.stringFlightProgress,moving:s.stringFlightProgress>0&&s.stringFlightProgress<1,homeCameraMoving:s.cameraTransition,fps:s.targetFps,scene:s.renderScene,quality:s.quality,renderedFrames:s.renderedFrames,simulationTime:s.simulationTime});requestAnimationFrame(tick)};tick();return true})()`)
const finishFlightObservation = async (name, rate) => {
  const samples = await evaluate(`(()=>{window.patchObserving=false;const s=window.__ASTARIA_P0__.getSnapshot();window.patchBudgets.push({flight:s.stringFlightProgress,moving:s.stringFlightProgress>0&&s.stringFlightProgress<1,homeCameraMoving:s.cameraTransition,fps:s.targetFps,scene:s.renderScene,quality:s.quality,renderedFrames:s.renderedFrames,simulationTime:s.simulationTime});return window.patchBudgets})()`), moving = samples.filter(sample => sample.moving)
  assert.ok(moving.length > 2, `${name}: real horizon camera moved`)
  assert.ok(moving.every(sample => !sample.homeCameraMoving), `${name}: independent flight, with home springs settled`)
  assert.ok(moving.every(sample => sample.fps === rate), `${name}: wrong moving budget ${JSON.stringify(moving.filter(sample=>sample.fps!==rate))}`)
  assert.ok(samples.every(sample => sample.quality === 'ultra'), `${name}: manual quality retained`)
  assert.ok(moving.at(-1).renderedFrames > moving[0].renderedFrames, `${name}: GPU renderer submitted frames during the flight`)
  assert.ok(samples.every((sample, index) => index === 0 || sample.simulationTime >= samples[index - 1].simulationTime), `${name}: ambient clock was not reset`)
  assert.equal(samples.at(-1).fps, 30, `${name}: settled workspace resumes the power cap`)
  budgets.push({name,rate,frames:samples.length,movingFrames:moving.length,movingBudgets:[...new Set(moving.map(sample=>sample.fps))],homeCameraMoving:moving.some(sample=>sample.homeCameraMoving),renderedFrames:moving.at(-1).renderedFrames-moving[0].renderedFrames,final:samples.at(-1)})
  checks.push(`${name}: independent flight retains ${rate} FPS and ultra, then resumes 30 FPS`)
}
const horizonRoundTrip = async rate => {
  await nav('余时'); await wait(`${settled} && document.querySelector('.free-time-page').dataset.active==='true' && window.__ASTARIA_P0__.getSnapshot().targetFps===30`)
  await observeFlight(); await click('.free-time-page .string-invitation')
  await wait(`document.querySelector('.horizon-studio')?.dataset.phase==='ready' && window.__ASTARIA_P0__.getSnapshot().stringFlightProgress===1`)
  await finishFlightObservation(`${rate} FPS free time to horizon`, rate)
  await shot(`horizon-${rate}-settled`)
  await observeFlight(); await click('.horizon-studio .orbit-cancel')
  await wait(`!document.querySelector('.horizon-studio') && window.__ASTARIA_P0__.getSnapshot().stringFlightProgress===0`)
  await finishFlightObservation(`${rate} FPS horizon to free time`, rate)
  await check(`${rate} FPS round trip restores free time and its power budget`, `document.querySelector('.free-time-page').dataset.active==='true' && window.__ASTARIA_P0__.getSnapshot().targetFps===30`)
  await observeFlight(); await click('.free-time-page .string-invitation')
  await wait(`window.__ASTARIA_P0__.getSnapshot().stringFlightProgress>.05 && window.__ASTARIA_P0__.getSnapshot().stringFlightProgress<.8`)
  await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await wait(`!document.querySelector('.horizon-studio') && window.__ASTARIA_P0__.getSnapshot().stringFlightProgress===0`)
  await finishFlightObservation(`${rate} FPS interrupted horizon entry and retreat`, rate)
}
const composer = async host => {
  await check(`${host}: no upload toolbar above textarea`, `!document.querySelector('${host} .home-input-shell .xixi-attachment-button,${host} .wb-input-shell .xixi-attachment-button,${host} .xixi-attachment-picker')`)
  await check(`${host}: circular plus directly left of Send`, `(()=>{const p=document.querySelector('${host} .xixi-attachment-button'),s=p.nextElementSibling,pr=p.getBoundingClientRect(),sr=s.getBoundingClientRect(),c=getComputedStyle(p);return p.parentElement.className==='xixi-send-actions'&&s.type==='submit'&&pr.right<sr.left&&Math.abs(pr.width-pr.height)<.1&&Math.abs(pr.y+pr.height/2-sr.y-sr.height/2)<1&&c.borderRadius==='50%'&&c.borderTopStyle==='solid'&&parseFloat(c.borderTopWidth)>=1&&c.borderTopColor!=='rgba(0, 0, 0, 0)'&&p.querySelector('svg')!==null})()`)
  await check(`${host}: file input hidden`, `getComputedStyle(document.querySelector('${host} input[type=file]')).display==='none'`)
}
try {
  await mkdir(output, { recursive: true })
  await writeFile(join(temporary, 'chooser.png'), Buffer.from(png, 'base64'))
  vite = await createServer({ configFile: false, root, cacheDir: join(temporary, 'vite-cache'), plugins: [react(), tailwindcss(), {
    name: 'isolated-qa-service', configureServer(server) { server.middlewares.use(service.middleware) },
  // Other agents may edit this checkout during QA. Disable live reload so one run
  // keeps its loaded frontend instead of remounting halfway through the matrix.
  }], logLevel: 'error', server: { host: '127.0.0.1', port: 0, open: false, hmr: false, watch: null } })
  await vite.listen(); base = `http://127.0.0.1:${vite.httpServer.address().port}/`
  chrome = spawn(process.env.CHROME_BINARY ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank',
  ], { stdio: 'ignore' })
  let debugPort, chromeError
  chrome.on('error', error => { chromeError = error })
  for (let i = 0; i < 150; i++) {
    if (chromeError) throw chromeError
    try { debugPort = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (debugPort) break } catch {}
    if (chrome.exitCode !== null) throw Error(`Owned Chrome exited: ${chrome.exitCode}`)
    await delay(100)
  }
  assert.ok(debugPort)
  const target = (await fetch(`http://127.0.0.1:${debugPort}/json`).then(r=>r.json())).find(item=>item.type==='page')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method === 'Page.fileChooserOpened') chooser = message.params
    if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params
      const allowed = new URL(request.url).origin === new URL(base).origin
      if (!allowed) blockedRequests.push(request.url)
      void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId } : { requestId, errorReason: 'BlockedByClient' }).catch(error=>{if(!stopping)errors.push(error.message)})
    }
    if (message.id) { const callback = pending.get(message.id); if (!callback) return; pending.delete(message.id); clearTimeout(callback.timeout); message.error ? callback.reject(message.error) : callback.resolve(message.result) }
  }
  await send('Page.enable'); await send('Runtime.enable')
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  await send('Page.setInterceptFileChooserDialog', { enabled: true })
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 960, deviceScaleFactor: 1, mobile: false })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('astaria-sqlite-migration-v1','complete')` })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: fixtureSource })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: pendingProbeSource })
  await send('Page.navigate', { url: base })
  await wait(`!!window.__ASTARIA_P0__ && !!document.querySelector('.home-launch') && !document.querySelector('.first-run')`)
  if (flightOnly) {
    await horizonRoundTrip(60)
    db.setPreference('app', { ...preferences, render: { ...preferences.render, profile: 'smooth120' } })
    await send('Page.reload')
    await wait(`!!window.__ASTARIA_P0__ && window.__ASTARIA_P0__.getSnapshot().targetFps===120 && !!document.querySelector('.home-launch')`)
    await horizonRoundTrip(120)
  } else {
  await click('.home-launch'); await wait(`${settled} && !document.querySelector('#home-xixi').inert`)
  await wait(`document.querySelector('#home-xixi .xixi-attachment-button')?.disabled===false`)
  await check('local service loaded before interaction checks', `!document.querySelector('#home-xixi .home-form-error,#home-xixi .xixi-send-error')`)
  await composer('#home-xixi')
  await check('empty home composer has no attachment strip', `!document.querySelector('#home-xixi .xixi-attachment-preview')`)
  await shot('home-dark-clear')
  await click('#home-xixi .xixi-attachment-button')
  for (let i = 0; !chooser && i < 50; i++) await delay(100)
  assert.ok(chooser, 'plus opens the native file chooser')
  await send('DOM.setFileInputFiles', { backendNodeId: chooser.backendNodeId, files: [join(temporary, 'chooser.png')] })
  await wait(selected('#home-xixi', 'chooser.png')); checks.push('plus opens chooser and attaches its selected image')
  await click('#home-xixi .xixi-attachment-remove')
  await check('remove clears attachment and empty strip', `!document.querySelector('#home-xixi .xixi-attachment-preview')`)
  assert.equal(await drop(image('拖图.png'), 'dragenter'), true)
  await check('file drag has a non-interactive drop hint', `getComputedStyle(document.querySelector('.xixi-image-drop')).pointerEvents==='none'`)
  await drop(image('拖图.png'), 'dragenter'); await drop(image('拖图.png'), 'dragleave')
  await check('nested dragleave with null relatedTarget retains hint', `!!document.querySelector('.xixi-image-drop')`)
  assert.equal(await drop(image('拖图.png')), true); await wait(selected('#home-xixi', '拖图.png'))
  await check('drop clears drag hint', `!document.querySelector('.xixi-image-drop')`)
  await click('#home-xixi .home-capture')
  await wait(`document.querySelector('#home-xixi .xixi-message-attachments img') && !document.querySelector('#home-xixi .home-capture').textContent.includes('正在')`)
  assert.ok(calls.at(-1).messages.some(m=>m.role==='user'&&Array.isArray(m.content)&&m.content.some(part=>part.type==='image_url')))
  checks.push('image-only message reaches scripted vision provider and persists in conversation')
  await drop(image('旧图.png')); await wait(selected('#home-xixi', '旧图.png'))
  await drop(`[new File(['text'],'note.txt',{type:'text/plain'})]`)
  await wait(`document.querySelector('#home-xixi .xixi-attachment-error')?.textContent.includes('仅支持')`)
  await check('invalid replacement cannot silently reuse old image', `!document.querySelector('#home-xixi .xixi-attachment-chip')`)
  await draft('#home-compose', '纯文字测试'); await click('#home-xixi .home-capture')
  await wait(`!document.querySelector('#home-xixi .home-capture').textContent.includes('正在') && document.querySelector('#home-compose').value===''`)
  assert.equal(typeof calls.at(-1).messages.filter(m=>m.role==='user').at(-1).content, 'string'); checks.push('text after failed replacement sends no previous image')
  // Real 10 MiB + 1 PNG: the rejection is the documented size boundary, not a fake header.
  await drop(bigImage('over.png', 10 * 1024 * 1024 + 1))
  await wait(`document.querySelector('#home-xixi .xixi-attachment-error')?.textContent.includes('10 MiB')`)
  await check('a real 10 MiB + 1 PNG is rejected at the size boundary', `!document.querySelector('#home-xixi .xixi-attachment-chip')`)
  await drop(`[...${image('one.png')},...${image('two.png')}]`)
  await wait(`document.querySelector('#home-xixi .xixi-attachment-error')?.textContent.includes('一张')`)
  checks.push('unsupported, oversized and multiple files use shared validation')
  // A real PNG between the retired 2 MiB ceiling and the 10 MiB rule must be read and uploaded byte-for-byte.
  await drop(bigImage('large.png', 3 * 1024 * 1024))
  await wait(selected('#home-xixi', 'large.png'))
  await wait(`(()=>{const img=document.querySelector('#home-xixi .xixi-attachment-chip img');return !!img&&img.complete&&img.naturalWidth===2&&img.naturalHeight===3})()`)
  await check('a real 3 MiB PNG above the old 2 MiB ceiling is decoded and attached', `(()=>{const chip=document.querySelector('#home-xixi .xixi-attachment-chip'),img=chip?.querySelector('img');return !!img&&chip.textContent.includes('3.0 MiB')&&window.__qaFixtures['large.png'].length===${3 * 1024 * 1024}})()`)
  await click('#home-xixi .home-capture')
  await wait(`document.querySelector('#home-xixi .xixi-message-attachments img') && !document.querySelector('#home-xixi .home-capture').textContent.includes('正在')`)
  await assertOriginalUpload('large.png', 3 * 1024 * 1024)
  checks.push('a >2 MiB image crosses the local service request body limit and reaches the scripted vision provider')
  await check('mid-size upload keeps the composer free of service errors', `!document.querySelector('#home-xixi .home-form-error,#home-xixi .xixi-send-error')`)
  // Header-clean fixtures that only a real decoder can judge: corrupt pixels and an illegal edge length.
  await drop(`[window.__qaCorruptFile('broken.png')]`)
  await wait(`document.querySelector('#home-xixi .xixi-attachment-error')?.textContent.includes('无法解码')`)
  await check('a PNG with valid headers but corrupt pixels is rejected by the real decoder', `!document.querySelector('#home-xixi .xixi-attachment-chip')`)
  await drop(`[window.__qaOverEdgeFile('huge.png')]`)
  await wait(`document.querySelector('#home-xixi .xixi-attachment-error')?.textContent.includes('8192')`)
  await check('a PNG header declaring a 9000 pixel edge is rejected before decoding', `!document.querySelector('#home-xixi .xixi-attachment-chip')`)
  await check('text dragging is left to the editor', `(()=>{const d=new DataTransfer();d.setData('text/plain','文字');const e=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:d});document.querySelector('#home-compose').dispatchEvent(e);return !e.defaultPrevented})()`)
  // Controlled arrayBuffer completion catches actual React state races against the real read path.
  await evaluate(gateSource)
  await draft('#home-compose', '读取中不得发送')
  const beforeRead = calls.length
  await drop(image('slow-old.png')); await drop(image('fast-new.png'))
  await wait(`window.__qaReadLog.length===2 && !!window.__qaGates['slow-old.png'] && !!window.__qaGates['fast-new.png']`)
  await evaluate(`document.querySelector('#home-xixi form').requestSubmit()`)
  await delay(150); assert.equal(calls.length, beforeRead, 'a pending image read must not reach the provider'); checks.push('Enter/form submission is blocked while image is reading')
  // Both resolutions carry the untouched bytes of the real file, not a fabricated data URL.
  assert.equal(await evaluate(`window.__qaResolveRead('fast-new.png')`), 77, 'the gated read must resolve with the real file bytes')
  await wait(selected('#home-xixi', 'fast-new.png'))
  assert.equal(await evaluate(`window.__qaResolveRead('slow-old.png')`), 77, 'the gated read must resolve with the real file bytes')
  await delay(250)
  await check('old read completion cannot replace latest selection', `(()=>{const chip=document.querySelector('#home-xixi .xixi-attachment-chip');return !!chip&&chip.textContent.includes('fast-new.png')&&!chip.textContent.includes('slow-old.png')&&!document.querySelector('#home-xixi .xixi-attachment-error')})()`)
  await drop(image('bad-read.png'))
  await wait(`document.querySelector('#home-xixi .xixi-attachment-error')?.textContent.includes('读取失败')`)
  await check('failed read clears previous selection', `!document.querySelector('#home-xixi .xixi-attachment-chip')`)
  await drop(image('native-check.png')); await wait(selected('#home-xixi', 'native-check.png'))
  await check('ungated files bypass the stub through the native reader', `window.__qaReadLog.join()==='slow-old.png,fast-new.png,bad-read.png'`)
  await click('#home-xixi .xixi-attachment-remove')
  await restoreArrayBufferStub(); await draft('#home-compose', '')
  await check('the arrayBuffer stub is fully restored after the read race', `typeof window.__qaNativeArrayBuffer==='undefined' && !window.__qaGates`)
  // Exactly 10 MiB is inside the rule: the untouched bytes must survive reading and stay comparable to the fixture.
  await drop(bigImage('max.png', 10 * 1024 * 1024))
  await wait(`document.querySelector('#home-xixi .xixi-attachment-chip')?.textContent.includes('10.0 MiB')`)
  await wait(`(()=>{const img=document.querySelector('#home-xixi .xixi-attachment-chip img');return !!img&&img.complete&&img.naturalWidth===2&&img.naturalHeight===3})()`)
  await check('exactly 10 MiB is accepted, decoded, and stored with the original bytes and size', `(()=>{
    const chip=document.querySelector('#home-xixi .xixi-attachment-chip'), img=chip?.querySelector('img'), source=window.__qaFixtures['max.png'], prefix='data:image/png;base64,'
    if(!img||!source||source.length!==10485760||!chip.textContent.includes('10.0 MiB')||!img.src.startsWith(prefix))return false
    const binary=atob(img.src.slice(prefix.length))
    if(binary.length!==source.length)return false
    for(let index=0;index<binary.length;index++)if(binary.charCodeAt(index)!==source[index])return false
    return true
  })()`)
  await click('#home-xixi .xixi-attachment-remove')
  await check('removing the 10 MiB image restores the empty strip', `!document.querySelector('#home-xixi .xixi-attachment-preview')`)
  // Also exercise the complete request/DB/provider path at the exact maximum, after the removal check.
  await drop(bigImage('max-send.png', 10 * 1024 * 1024)); await wait(selected('#home-xixi', 'max-send.png'))
  await wait(`(()=>{const img=document.querySelector('#home-xixi .xixi-attachment-chip img');return !!img&&img.complete&&img.naturalWidth===2&&img.naturalHeight===3})()`)
  const beforeMaximum = calls.length
  // Observe the real Storage call, forwarding it unchanged; a quota failure must remain a product finding.
  await evaluate(`(()=>{
    window.__qaNativeSetItem=Storage.prototype.setItem;window.__qaStorageErrors=[]
    Storage.prototype.setItem=function(key,value){try{return window.__qaNativeSetItem.call(this,key,value)}catch(error){window.__qaStorageErrors.push({name:error.name,message:error.message,key,valueCharacters:String(value).length,sessionStorage:this===sessionStorage});throw error}}
    return true
  })()`)
  await click('#home-xixi .home-capture')
  await wait(`!document.querySelector('#home-xixi .home-capture').textContent.includes('正在') && (!document.querySelector('#home-xixi .xixi-attachment-chip') || !!document.querySelector('#home-xixi .xixi-send-error,#home-xixi .home-form-error')?.textContent.trim())`)
  const maximumError = await evaluate(`document.querySelector('#home-xixi .xixi-send-error,#home-xixi .home-form-error')?.textContent.trim()||''`)
  const storageErrors = await evaluate('window.__qaStorageErrors')
  await restoreStorageProbe()
  if (maximumError) {
    await shot('max-size-send-failure')
    findings.push({ name: 'exact 10 MiB image-only send', image: 'max-send.png', size: 10 * 1024 * 1024, decodedDimensions: [2, 3], uiError: maximumError,
      storageErrors, providerCallsBefore: beforeMaximum, providerCallsAfter: calls.length, screenshot: 'max-size-send-failure.png',
      source: 'src/xixi/useXixiConversation.ts:173', expected: 'Original image reaches the local service and scripted provider.',
    })
    // Finish the full matrix after recording the failure, then fail the overall run at the end.
    await click('#home-xixi .xixi-attachment-remove')
    await drop(image('after-max-failure.png')); await wait(selected('#home-xixi', 'after-max-failure.png'))
    await click('#home-xixi .home-capture')
    await wait(`!document.querySelector('#home-xixi .home-capture').textContent.includes('正在') && !document.querySelector('#home-xixi .xixi-attachment-chip') && !document.querySelector('#home-xixi .home-form-error,#home-xixi .xixi-send-error')`)
    checks.push('a small valid image still sends successfully after the maximum-size send failure')
  } else {
    assert.equal(calls.length, beforeMaximum + 1, 'maximum-size image made one scripted provider call')
    assert.deepEqual(storageErrors, [])
    await assertOriginalUpload('max-send.png', 10 * 1024 * 1024)
    checks.push('an exact 10 MiB PNG reaches the scripted provider and isolated DB with every original byte intact')
    await check('maximum-size upload leaves no service error or pending attachment', `!document.querySelector('#home-xixi .home-form-error,#home-xixi .xixi-send-error') && !document.querySelector('#home-xixi .xixi-attachment-preview')`)
  }
  if (!findings.length) await pendingStorageCases()
  // Large upload evidence stays in its real conversation. Use the ordinary UI to start
  // a fresh synthetic topic so its base64 history cannot fill the fixed 48k test budget
  // and prevent the later chooser/busy/theme checks from reaching the scripted provider.
  const fixtureConversation = db.getActiveConversation().id
  await click('#home-xixi .xixi-topic-menu>button'); await click('#home-xixi .xixi-topic-new')
  await wait(`!document.querySelector('#home-xixi .xixi-topic-popover') && !document.querySelector('#home-xixi .xixi-message-attachments img') && !document.querySelector('#home-xixi .xixi-attachment-button').disabled`)
  assert.notEqual(db.getActiveConversation().id, fixtureConversation, 'later interaction matrix has a fresh isolated conversation')
  checks.push('large-image history is retained in its own topic while focus interaction uses a fresh synthetic topic')
  // The 60 FPS budget survives the expanded-chat -> workbench transition.
  await observe(); await nav('工作台'); await wait(settled); await finishObservation('home chat to workbench', 60)
  await check('settled workbench returns to 30 FPS', `window.__ASTARIA_P0__.getSnapshot().targetFps===30`)
  await click(`.wb-task[data-task-id='${task.id}']`)
  await wait(`!!document.querySelector('.wb-xixi textarea') && !document.querySelector('.wb-scroll').inert`)
  await composer('.wb-xixi'); await shot('focus-dark-clear')
  await drop(image('专注.png')); await wait(selected('.wb-xixi', '专注.png'))
  await check('focus drop stays in current task chat', `document.querySelector('.home-workspace').dataset.page==='workbench'&&!document.querySelector('#home-xixi .xixi-attachment-chip')`)
  await click('.wb-xixi .xixi-attachment-button')
  await send('DOM.setFileInputFiles', { backendNodeId: chooser.backendNodeId, files: [join(temporary, 'chooser.png')] })
  await wait(selected('.wb-xixi', 'chooser.png')); checks.push('focus plus uses its own native chooser')
  await click('.wb-xixi .xixi-send')
  await wait(`document.querySelector('.wb-xixi .xixi-message-attachments img') && !document.querySelector('.wb-xixi .xixi-send').textContent.includes('正在')`)
  assert.equal(db.listMessages(db.getActiveConversation().id).filter(m=>m.role==='user').at(-1).taskId, task.id); checks.push('focus image keeps real task context when sent')
  // Busy operation must neither replace the attachment nor navigate away.
  holdNext = true
  await draft('#wb-xixi-input', '等待回复'); await click('.wb-xixi .xixi-send')
  await wait(`document.querySelector('.wb-xixi .xixi-send').disabled`)
  assert.equal(await drop(image('busy.png')), true)
  await check('busy focus rejects drop without navigating or attaching', `document.querySelector('.home-workspace').dataset.page==='workbench'&&!document.querySelector('.wb-xixi .xixi-attachment-chip')`)
  for(let i=0;!releaseReply&&i<50;i++)await delay(50)
  assert.ok(releaseReply); releaseReply(); releaseReply = undefined
  await wait(`!document.querySelector('.wb-xixi .xixi-send').textContent.includes('正在')`)
  // Theme/material and narrow-width checks visit the same real focus and home composers.
  for (const [theme, glass, width, height] of [['light','clear',1400,960], ['light','soft',1400,960], ['dark','soft',1400,960], ['dark','clear',390,844]]) {
    const next = { ...preferences, theme, glass }
    db.setPreference('app', next)
    await evaluate(`window.dispatchEvent(new CustomEvent('astaria-preferences-change',{detail:${JSON.stringify(next)}}))`)
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width<600 }); await delay(500)
    await composer('.wb-xixi'); await shot(`focus-${theme}-${glass}-${width}`)
    await check(`focus ${theme}/${glass}/${width}: no horizontal overflow`, `document.querySelector('.wb-xixi').scrollWidth<=document.querySelector('.wb-xixi').clientWidth+1`)
    await nav('首页'); await click('.home-launch'); await wait(`${settled} && !document.querySelector('#home-xixi').inert`)
    await composer('#home-xixi'); await shot(`home-${theme}-${glass}-${width}`)
    await check(`home ${theme}/${glass}/${width}: no horizontal overflow`, `document.querySelector('#home-xixi').scrollWidth<=document.querySelector('#home-xixi').clientWidth+1`)
    await nav('工作台'); await wait(`!!document.querySelector('.wb-xixi textarea')`)
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 960, deviceScaleFactor: 1, mobile: false })
  db.setPreference('app', { ...preferences, render: { ...preferences.render, profile: 'smooth120' } })
  await send('Page.reload').catch(error => {
    if (error.message !== 'Inspected target navigated or closed') throw error
  })
  await wait(`!!window.__ASTARIA_P0__ && window.__ASTARIA_P0__.getSnapshot().targetFps===120`)
  await click('.home-launch'); await wait(settled)
  await observe(); await nav('工作台'); await wait(settled); await finishObservation('120 FPS chat to workspace', 120)
  await check('120 FPS selection settles to workspace 30', `window.__ASTARIA_P0__.getSnapshot().targetFps===30`)
  await nav('首页'); await click('.home-launch'); await wait(settled)
  await observe(); await nav('工作台'); await delay(200); await nav('首页'); await click('.home-launch'); await wait(settled)
  await finishObservation('120 FPS mid-flight reversal', 120)
  await check('reversal restores saved home frame rate', `window.__ASTARIA_P0__.getSnapshot().targetFps===120`)
  await nav('日程'); await wait(settled)
  await drop(image('从日程拖入.png'))
  await wait(`${selected('#home-xixi', '从日程拖入.png')} && ${settled} && !document.querySelector('#home-xixi').inert`)
  checks.push('dropping outside focus opens home chat with the selected image')
  }
  assert.equal(errors.length, 0, JSON.stringify(errors)); assert.equal(blockedRequests.length, 0, JSON.stringify(blockedRequests))
  await writeFile(join(output,'results.json'), JSON.stringify({status:findings.length?'failed':'passed',checks,findings,budgets,errors,blockedRequests,uploads,pendingStorage,providerCalls:calls.length,storage:':memory:',model:'scripted',scope:'Chrome UI and target frame budgets; not native OS performance'},null,2))
  if (!findings.length) await rm(join(output,'failure.json'), { force: true })
  console.log(`${findings.length?'FAIL':'PASS'} Beta12.1 UI: ${checks.length} passed checks, ${findings.length} findings (${output})`)
  assert.equal(findings.length, 0, 'Image UI product findings; inspect results.json and max-size-send-failure.png')
} catch (error) {
  await shot('failure').catch(()=>{})
  const uiFailure = await evaluate(`({alerts:[...document.querySelectorAll('#home-xixi [role=alert]')].map(element=>element.textContent),storageErrors:window.__qaStorageErrors??[]})`).catch(()=>null)
  await writeFile(join(output,'failure.json'),JSON.stringify({message:error.message,checks,findings,budgets,uploads,pendingStorage,uiFailure,errors,blockedRequests},null,2))
  throw error
} finally {
  stopping=true; releaseReply?.()
  // The page stub is restored on every exit path, including failures after the gate section.
  if(ws?.readyState===WebSocket.OPEN) await Promise.race([Promise.all([restoreArrayBufferStub(),restoreStorageProbe(),evaluate('window.__qaRestorePendingProbe?.();true').catch(()=>{})]), delay(2000)])
  if(ws?.readyState===WebSocket.OPEN)ws.close()
  if(chrome&&chrome.exitCode===null){chrome.kill('SIGTERM');await Promise.race([new Promise(resolve=>chrome.once('exit',resolve)),delay(3000)]);if(chrome.exitCode===null)chrome.kill('SIGKILL')}
  await vite?.close(); service.close(); await rm(temporary,{recursive:true,force:true})
}
