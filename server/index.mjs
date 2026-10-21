import { dataDirectory } from './platform.mjs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import { createDatabase } from './database.mjs'
import { createKeychain } from './keychain.mjs'
import { ProviderError } from './provider.mjs'
import { deviceRecommendation } from './modelSettings.mjs'
import { getModelSettings } from './modelSettingsCore.mjs'
import { createWebSearch } from './webSearch.mjs'
import { createLocalModelInstaller } from './localModelInstall.mjs'
import { createXixi } from './xixi.mjs'
import { getPreferences } from './preferences.mjs'
import { ValidationError, object } from './validation.mjs'
import { createServiceCore } from './serviceCore.mjs'
import { createCompatibleFetch } from './compatibleFetch.mjs'
import { localRequestLimit } from '../src/xixi/requestLimits.ts'
export const DATA_DIRECTORY = dataDirectory()
const localAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const hosts = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function validateRequest(req) {
  if (!localAddresses.has(req.socket.remoteAddress)) throw new ValidationError('仅允许本机访问', 403)
  if (typeof req.headers.host !== 'string' || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/u.test(req.headers.host)) throw new ValidationError('请求地址无效', 403)
  let target
  try { target = new URL(`http://${req.headers.host}`) } catch { throw new ValidationError('请求地址无效', 403) }
  if (!hosts.has(target.hostname) || target.username || target.password || Number(target.port || 80) !== req.socket.localPort) throw new ValidationError('请求地址无效', 403)
  if (req.headers['x-astaria-local'] !== '1') throw new ValidationError('请从 ASTaria 页面访问', 403)
  if (req.headers.origin && req.headers.origin !== target.origin) throw new ValidationError('请求来源无效', 403)
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw new ValidationError('请求来源无效', 403)
  if (!['GET', 'POST'].includes(req.method)) throw new ValidationError('请求方式不支持', 405)
  if (req.method === 'POST' && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new ValidationError('请发送 JSON 数据', 415)
}

async function body(req) {
  let size = 0
  const chunks = []
  const limit = localRequestLimit(req.url ?? '')
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit.bytes) throw new ValidationError(limit.message, 413)
    chunks.push(chunk)
  }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
  catch (error) { if (error instanceof ValidationError) throw error; throw new ValidationError('JSON 内容无法读取') }
}

export function createLocalService({ db = createDatabase(join(DATA_DIRECTORY, 'astaria.sqlite')), vault = createKeychain(DATA_DIRECTORY), compatibleVault, compatibleFetcher = createCompatibleFetch(), complete, fetcher = fetch, dataDirectory = DATA_DIRECTORY, onMutation = () => {} } = {}) {
  const completionScope = new AsyncLocalStorage()
  const localModelInstaller = createLocalModelInstaller({ fetcher })
  const core = createServiceCore({ db, vault, complete, fetcher, compatibleVault, compatibleFetcher, dataDirectory,
    secretStorage: process.platform === 'win32' ? 'Windows 系统凭据保护' : 'macOS 钥匙串',
    deviceRecommendation, completionScope, localModelInstaller, xixiFactory: createXixi,
    webSearch: createWebSearch({ keychain: vault, fetcher, getSettings: () => getModelSettings(db) }) })
  async function dispatch(req, startStream, signal) {
    validateRequest(req)
    return core.dispatch(req.url, req.method === 'POST' ? await body(req) : undefined, { headers: req.headers, startStream, signal })
  }

  const pendingRequests = new Set()
  const middleware = (req, res, next) => {
    if (!(req.url === '/api' || req.url?.startsWith('/api/'))) return next()
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    let streaming = false, heartbeat
    // Recognition has no durable turn to recover; closing its preview should
    // cancel the upstream work. Chat keeps its existing durable continuation.
    const recognition = req.url === '/api/planner/import/recognize' ? new AbortController() : undefined
    const cancelRecognition = () => { if (!res.writableEnded) recognition?.abort() }
    if (recognition) { req.once('aborted', cancelRecognition); res.once('close', cancelRecognition) }
    const send = event => {
      if (res.destroyed || res.writableEnded) return
      // Stop buffering to a stalled client. The turn continues durably and the
      // client can recover it using the same request ID without duplicate writes.
      if (res.writableLength > 1024 * 1024) { res.destroy(); return }
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    const startStream = () => {
      streaming = true
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('X-Accel-Buffering', 'no')
      res.flushHeaders()
      heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n') }, 15_000)
      res.once('close', () => clearInterval(heartbeat))
      return send
    }
    const pending = Promise.resolve().then(() => dispatch(req, startStream, recognition?.signal)).then(result => {
      if (streaming) { send({ type: 'result', result }); res.end() }
      else res.end(JSON.stringify(result ?? null))
    }).catch(error => {
      const message = error instanceof ValidationError || error instanceof ProviderError ? error.message : '本机操作未完成，请稍后重试；密钥问题可检查系统钥匙串授权'
      if (streaming) { send({ type: 'error', error: message, status: error instanceof ValidationError ? error.status : 503 }); res.end() }
      else {
        res.statusCode = error instanceof ValidationError ? error.status : 503
        res.end(JSON.stringify({ error: message }))
      }
    }).finally(() => { clearInterval(heartbeat); if (recognition) { req.removeListener('aborted', cancelRecognition); res.removeListener('close', cancelRecognition) } if (req.method === 'POST') { try { onMutation() } catch { /* Notification failure must not change the saved operation. */ } } })
    pendingRequests.add(pending)
    pending.finally(() => pendingRequests.delete(pending)).catch(() => {})
  }
  return {
    middleware,
    syncStore: db.sync,
    windowTheme: () => getPreferences(db).theme,
    whenIdle: () => Promise.allSettled([...pendingRequests]),
    reminderSnapshot: core.reminderSnapshot,
    close: () => { localModelInstaller.close(); db.close() },
  }
}

export function localServicePlugin() {
  const attach = server => {
    // Lazy startup keeps production builds from opening a database or Keychain.
    let service
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith('/api/')) return next()
      try { service ??= createLocalService(); service.middleware(req, res, next) }
      catch { res.statusCode = 503; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: '无法打开 ASTaria 本机数据库' })) }
    })
    server.httpServer?.once('close', () => service?.close())
  }
  return { name: 'astaria-local-service', configureServer: attach, configurePreviewServer: attach }
}
