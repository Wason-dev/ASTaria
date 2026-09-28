import { homedir } from 'node:os'
import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import { createDatabase } from './database.mjs'
import { createKeychain } from './keychain.mjs'
import { createCompletion, discoverLocalModels, testLocalCompletion, MODELS, ProviderError } from './provider.mjs'
import { getModelSettings, saveModelSettings, deviceRecommendation } from './modelSettings.mjs'
import { createLocalModelInstaller } from './localModelInstall.mjs'
import { createXixi } from './xixi.mjs'
import { createCompanion } from './companion.mjs'
import { createRouteAnalysis } from './routeAnalysis.mjs'
import { createStringOrder } from './stringOrder.mjs'
import { createHorizonOrder } from './horizonOrder.mjs'
import { createHorizonGrouping } from './horizonGroups.mjs'
import { createFreeTime } from './freeTime.mjs'
import { getPreferences, savePreferences } from './preferences.mjs'
import { normalizeAssistantProtocol } from './provider-protocol.mjs'
import { toggleTaskStep } from './taskSteps.mjs'
import { publicOperation, publicOperations } from './operationReceipts.mjs'
import { ValidationError, object, identifier, knownKeys } from './validation.mjs'
import { BACKUP_IMPORT_REQUEST_MAX_BYTES, BACKUP_IMPORT_TOO_LARGE } from '../src/xixi/backupLimits.ts'

export const DATA_DIRECTORY = join(homedir(), 'Library', 'Application Support', 'ASTaria')
const localAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const hosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
const publicMessage = (raw) => {
  const { id, seq, role, content, createdAt, requestId, taskId, excludeFromContext, question, retractedAt, reasoningContent } = raw.role === 'assistant' && !raw.retractedAt ? normalizeAssistantProtocol(raw) : raw
  return ({
  id, seq, role, content: retractedAt ? '已撤回' : content, createdAt, requestId, taskId, excludeFromContext,
  ...(retractedAt ? { retractedAt } : { question, ...(role === 'assistant' && reasoningContent ? { reasoningContent } : {}) }),
}) }

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
  const importingBackup = req.url?.split('?')[0] === '/api/data/import'
  const limit = importingBackup ? BACKUP_IMPORT_REQUEST_MAX_BYTES : 4 * 1024 * 1024
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new ValidationError(importingBackup ? BACKUP_IMPORT_TOO_LARGE : '一次提交的内容过多', 413)
    chunks.push(chunk)
  }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
  catch (error) { if (error instanceof ValidationError) throw error; throw new ValidationError('JSON 内容无法读取') }
}

export function createLocalService({ db = createDatabase(join(DATA_DIRECTORY, 'astaria.sqlite')), vault = createKeychain(DATA_DIRECTORY), complete, fetcher = fetch, dataDirectory = DATA_DIRECTORY } = {}) {
  // Capture provider selection for the full tool loop, even if another tab
  // changes settings while a reply is in flight. Never silently change where
  // an existing conversation request is sent.
  const completionScope = new AsyncLocalStorage()
  const selectedCompletion = (config = getModelSettings(db)) => createCompletion(vault, fetcher, () => config.cloudModel, () => config)
  const completion = complete ?? ((payload, options) => (completionScope.getStore() ?? selectedCompletion())(payload, options))
  const xixi = createXixi({ db, complete: completion })
  const companion = createCompanion({ db })
  const routeAnalysis = createRouteAnalysis({ db, companion, complete: completion })
  const stringOrder = createStringOrder({ db, complete: completion })
  const horizonOrder = createHorizonOrder({ db, complete: completion })
  const horizonGrouping = createHorizonGrouping({ list: horizonOrder.list, complete: completion })
  const freeTime = createFreeTime({ db })
  const localModelInstaller = createLocalModelInstaller({ fetcher })
  const state = (id = db.getActiveConversation().id, before) => {
    const raw = db.listMessages(id, { limit: 200, ...(before === undefined ? {} : { before }) })
    const oldestSeq = raw[0]?.seq ?? null
    const messages = raw.filter(message => message.role !== 'tool' && !message.toolCalls?.length && !(message.retractedAt && message.role === 'assistant'))
    const visibleRequests = new Set(messages.map(message => message.requestId))
    // A raw page can start inside a long tool round (or a withdrawn reply).
    // Keep its successful receipts attached to the original user message even
    // before a final assistant bubble exists; the raw pagination cursor stays put.
    for (const requestId of new Set(raw.map(message => message.requestId).filter(Boolean))) {
      if (visibleRequests.has(requestId)) continue
      const turn = db.getTurn(requestId)
      const anchor = turn?.conversationId === id ? db.getMessage(turn.userMessageId) : null
      if (anchor?.role === 'user') messages.push(anchor)
    }
    // A page can begin at the final reply, after all of that turn's thoughts.
    // Query only existence through the request index; fetch the full text when
    // expanded so ordinary conversation responses keep their bounded size.
    const savedReasoning = new Set(messages.filter(message => !message.retractedAt && message.requestId)
      .map(message => message.requestId).filter((requestId, index, ids) => ids.indexOf(requestId) === index)
      .filter(requestId => db.hasSavedReasoning(id, requestId)))
    return {
      conversationId: id,
      messages: messages.sort((a, b) => a.seq - b.seq).map(message => {
        const visible = { ...publicMessage(message), ...(!message.retractedAt && savedReasoning.has(message.requestId) ? { hasSavedReasoning: true } : {}) }
        if (message.role !== 'assistant' || message.retractedAt || !message.requestId) return visible
        // Bound display only. The exact full reasoning transcript remains stored
        // for subsequent provider calls, including native tool-call rounds.
        const thoughts = raw.filter(item => item.requestId === message.requestId && item.role === 'assistant' && !item.retractedAt && !item.excludeFromContext)
          .map(item => item.reasoningContent).filter(Boolean).join('\n\n')
        return thoughts ? { ...visible, reasoningContent: thoughts.length > 120_000 ? `${thoughts.slice(0, 120_000)}\n\n（思考内容较长，展示已截短）` : thoughts } : visible
      }),
      operations: publicOperations(db.listOperations().filter(operation => db.getTurn(operation.requestId)?.conversationId === id), db),
      companionActions: raw.filter(message => message.role === 'tool' && !message.retractedAt && !message.excludeFromContext).flatMap(message => {
        try {
          const value = JSON.parse(message.content)
          if (!value.ok) return []
          const kind = value.scenario ? 'scenario' : value.handoff ? 'handoff' : value.wish ? 'wish' : value.goal ? 'goal' : null
          if (!kind) return []
          const record = value[kind]
          return [{ id: message.id, requestId: message.requestId, kind, label: kind === 'scenario' ? '推演草案已生成 · 查看后再应用' : kind === 'handoff' ? '接力现场已保存' : kind === 'goal' ? '余时目标已更新' : '牵挂清单已更新', ...(kind === 'scenario' ? { targetId: record.id } : {}), createdAt: message.createdAt }]
        } catch { return [] }
      }),
      // Use the raw cursor: a full page of internal tool records still advances
      // history correctly even though it has no public chat bubbles.
      oldestSeq,
      hasOlder: oldestSeq !== null && db.listMessages(id, { limit: 1, before: oldestSeq }).length > 0,
    }
  }
  const retractedState = message => {
    const next = state(message.conversationId)
    // The target may be in a previously loaded history page. Include its
    // tombstone while keeping the latest page's raw cursor unchanged.
    if (!next.messages.some(item => item.id === message.id)) next.messages.unshift(publicMessage(message))
    return next
  }
  const status = async () => {
    const providerSettings = getModelSettings(db)
    // A broken or locked system Keychain must not prevent the settings page
    // from opening. Local mode never needs to touch the cloud secret, and in
    // cloud mode an unavailable vault simply means "not configured" until the
    // user fixes access or switches provider.
    let cloudConfigured = null
    if (providerSettings.provider !== 'local') {
      try { cloudConfigured = await vault.status() } catch { cloudConfigured = false }
    }
    return { service: 'astaria-local', provider: providerSettings.provider, providerSettings, cloudConfigured,
      configured: providerSettings.provider === 'local' ? Boolean(providerSettings.local.model) : cloudConfigured,
      model: providerSettings.provider === 'local' ? providerSettings.local.model : providerSettings.cloudModel, models: MODELS, storage: 'SQLite', dataDirectory }
  }

  async function dispatch(req, startStream) {
    validateRequest(req)
    const url = new URL(req.url, `http://${req.headers.host}`)
    const path = url.pathname.slice(4)
    const input = req.method === 'POST' ? await body(req) : null
    const decodeId = value => {
      try { return identifier(decodeURIComponent(value)) }
      catch { throw new ValidationError('记录标识不正确') }
    }
    if (input === null) {
      if (path === '/status') return status()
      if (path === '/settings/device') return deviceRecommendation()
      if (path === '/settings/local/install-options') return localModelInstaller.options(Object.fromEntries(url.searchParams))
      const localInstall = path.match(/^\/settings\/local\/install\/([^/]+)$/)
      if (localInstall) return localModelInstaller.get(decodeId(localInstall[1]))
      if (path === '/preferences') return getPreferences(db)
      if (path === '/operations') return publicOperations(db.listOperations(), db)
      if (path === '/data/export') return db.exportData()
      if (path === '/companion') return companion.listState({ ...(url.searchParams.get('date') ? { date: url.searchParams.get('date') } : {}), ...(url.searchParams.get('days') ? { days: Number(url.searchParams.get('days')) } : {}) })
      if (path === '/companion/string-order') return stringOrder.list({ date: url.searchParams.get('date') || undefined })
      if (path === '/companion/horizon-order') return horizonOrder.list({ date: url.searchParams.get('date') || undefined })
      if (path === '/planner') return db.getPlanner()
      if (path === '/conversation/reasoning') {
        const conversationId = identifier(url.searchParams.get('conversationId'), '对话标识')
        const requestId = identifier(url.searchParams.get('requestId'), '请求标识')
        const turn = db.getTurn(requestId)
        const anchor = turn?.conversationId === conversationId ? db.getMessage(turn.userMessageId) : null
        if (!anchor || anchor.role !== 'user' || anchor.conversationId !== conversationId || turn.retractedAt ||
          anchor.retractedAt || anchor.contextRetractedAt || anchor.excludeFromContext) throw new ValidationError('这次对话的思考内容不可用', 404)
        // Fetch on demand across raw history pages; the ordinary chat preview
        // stays bounded and provider transcripts are never rewritten.
        const rounds = []
        let before
        for (;;) {
          const page = db.listMessages(conversationId, { limit: 1000, ...(before === undefined ? {} : { before }) })
          rounds.push(...page.filter(item => item.requestId === requestId && item.role === 'assistant' &&
            !item.retractedAt && !item.contextRetractedAt && !item.excludeFromContext && item.reasoningContent))
          if (!page.length || page[0].seq <= anchor.seq || page.length < 1000) break
          before = page[0].seq
        }
        if (!rounds.length) throw new ValidationError('这一轮暂时没有已保存的思考内容', 404)
        rounds.sort((a, b) => a.seq - b.seq)
        return { conversationId, requestId, status: turn.status, roundCount: rounds.length,
          rounds: rounds.map(item => ({ id: item.id, content: item.reasoningContent })),
          reasoningContent: rounds.map(item => item.reasoningContent).join('\n\n') }
      }
      if (path === '/conversation') {
        const rawBefore = url.searchParams.get('before')
        const before = rawBefore === null ? undefined : Number(rawBefore)
        if (rawBefore !== null && (!/^[1-9]\d*$/u.test(rawBefore) || !Number.isSafeInteger(before))) throw new ValidationError('历史消息游标不正确')
        return state(url.searchParams.get('id') || undefined, before)
      }
      if (path === '/conversations') return db.listConversations()
      if (path === '/memories') return db.listMemories().map(memory => ({ ...memory, source: db.getMessage(memory.sourceMessageId)?.content ?? '' }))
      if (path === '/tasks') {
        let filter
        try { filter = JSON.parse(url.searchParams.get('filter') || '{}') } catch { throw new ValidationError('任务筛选格式不正确') }
        return db.listTasks(filter)
      }
      if (path.startsWith('/tasks/')) { const task = db.getTask(decodeId(path.slice(7))); return task?.deletedAt ? null : task }
      if (path === '/areas') return db.listAreas()
      if (path === '/events') return db.listEvents(url.searchParams.get('from') || undefined, url.searchParams.get('to') || undefined)
      if (path === '/availability') return db.getAvailability(url.searchParams.get('date'))
      if (path === '/assignments') return db.listAssignments()
    } else {
      if (path === '/preferences') return savePreferences(db, input)
      if (path === '/data/import') { knownKeys(input, ['backup', 'confirmed']); if (input.confirmed !== true) throw new ValidationError('请先确认恢复备份'); return db.importData(input.backup) }
      if (path === '/companion/handoff') return companion.saveHandoff(input)
      if (path === '/companion/handoff/clear') { knownKeys(input, ['taskId', 'expectedVersion']); return companion.clearHandoff(input.taskId, input.expectedVersion) }
      if (path === '/companion/wish') return companion.saveWish(input)
      if (path === '/companion/wish/update') { knownKeys(input, ['id', 'status', 'expectedVersion']); return companion.updateWish(input.id, { status: input.status, expectedVersion: input.expectedVersion }) }
      if (path === '/companion/free-time-goal' || path === '/companion/free-time') return companion.saveFreeTimeGoal(input)
      if (path === '/companion/free-time-goal/update' || path === '/companion/free-time/update') return companion.updateFreeTimeGoal(input.id, input)
      if (path === '/companion/free-time/schedule') { const result = freeTime.schedule(input); return { ...result, operation: result.operation ? publicOperation(result.operation, db) : null } }
      if (path === '/companion/free-time/resume') { const result = freeTime.resume(input); return { ...result, operation: result.operation ? publicOperation(result.operation, db) : null } }
      if (path === '/companion/free-time/ensure') { knownKeys(input, []); const result = freeTime.ensureDaily(); return { ...result, ...(result.operation ? { operation: publicOperation(result.operation, db) } : {}) } }
      if (path === '/companion/free-time/complete') return freeTime.completeSession(input)
      if (path === '/companion/scenario') return companion.previewScenario(input)
      if (path === '/companion/decision') return companion.previewDecision(input)
      if (path === '/companion/route') return completionScope.run(selectedCompletion(), () => routeAnalysis.analyze(input))
      if (path === '/companion/string-order') return completionScope.run(selectedCompletion(), () => stringOrder.apply(input))
      if (path === '/companion/horizon-order') {
        const onEvent = req.headers.accept?.includes('text/event-stream') ? startStream?.() : undefined
        return completionScope.run(selectedCompletion(), () => horizonOrder.apply(input, { onEvent }))
      }
      if (path === '/companion/horizon-groups') {
        const onEvent = req.headers.accept?.includes('text/event-stream') ? startStream?.() : undefined
        return completionScope.run(selectedCompletion(), () => horizonGrouping.suggest(input, { onEvent }))
      }
      if (path === '/companion/scenario/apply') { knownKeys(input, ['id', 'expectedVersion']); const result = companion.applyScenario(input.id, { expectedVersion: input.expectedVersion }); return { ...result, operation: result.operation ? publicOperation(result.operation, db) : null } }
      if (path === '/companion/scenario/discard') { knownKeys(input, ['id', 'expectedVersion']); return companion.discardScenario(input.id, { expectedVersion: input.expectedVersion }) }
      const correction = path.match(/^\/memories\/([^/]+)\/correct$/)
      if (correction) { knownKeys(input, ['content', 'expectedUpdatedAt']); return db.correctMemory(decodeId(correction[1]), input) }
      const cancelLocalInstall = path.match(/^\/settings\/local\/install\/([^/]+)\/cancel$/)
      if (cancelLocalInstall) { knownKeys(input, []); return localModelInstaller.cancel(decodeId(cancelLocalInstall[1])) }
      const fields = {
        '/planner': ['expectedRevision', 'action'],
        '/settings/key': ['key'], '/settings/key/remove': [], '/settings/test': [], '/settings/model': ['model'],
        '/settings/provider': ['provider', 'cloudModel', 'reasoningEffort', 'streamResponses', 'contextBudget', 'local'], '/settings/local/models': ['engine', 'baseUrl'],
        '/settings/local/install': ['baseUrl', 'model', 'confirmed'],
        '/chat': ['requestId', 'conversationId', 'text', 'context'], '/conversations': [],
        '/conversations/select': ['id'], '/conversations/rename': ['conversationId', 'title'], '/conversations/delete': ['conversationId'], '/operations/read': ['ids'],
        '/messages/retract': ['requestId', 'conversationId'],
        '/tasks/update': ['id', 'patch', 'expectedUpdatedAt'], '/tasks/delete': ['id'], '/tasks/reopen': ['id', 'expectedUpdatedAt'],
        '/tasks/steps/check': ['taskId', 'stepId', 'checked', 'expectedUpdatedAt'], '/areas/create': ['name', 'defaultEnergy'],
        '/areas/rename': ['id', 'name'], '/events/delete': ['id'], '/availability': ['date', 'until'],
      }[path]
      if (fields) knownKeys(input, fields)
      if (path === '/planner') return db.updatePlanner(input.action, input.expectedRevision)
      if (path === '/settings/key') {
        if (typeof input.key !== 'string' || !/^[\x21-\x7e]{8,512}$/u.test(input.key.trim())) throw new ValidationError('请输入有效的 API Key')
        await vault.save(input.key); return status()
      }
      if (path === '/settings/key/remove') { await vault.remove(); return status() }
      if (path === '/settings/model') { db.setModel(input.model); return status() }
      if (path === '/settings/provider') { saveModelSettings(db, input); return status() }
      if (path === '/settings/local/models') return discoverLocalModels(input, fetcher)
      if (path === '/settings/local/install') return localModelInstaller.start(input)
      if (path === '/settings/test') {
        const config = getModelSettings(db)
        let cloudConfigured = null
        if (config.provider !== 'local') {
          try { cloudConfigured = await vault.status() } catch { cloudConfigured = false }
        }
        const current = { provider: config.provider, configured: config.provider === 'local' ? Boolean(config.local.model) : cloudConfigured }
        if (!current.configured) throw new ValidationError(current.provider === 'local' ? '先保存本地模型名称再测试连接' : '先保存 API Key 再测试连接')
        const testCompletion = complete ?? createCompletion(vault, fetcher, () => config.cloudModel, () => config)
        if (current.provider === 'local') return testLocalCompletion(testCompletion)
        await testCompletion({ messages: [{ role: 'user', content: 'Reply with OK' }], max_tokens: 8 })
        return { ok: true, toolCalling: null, message: '云端连接成功，析熙准备好了' }
      }
      if (path === '/chat') {
        knownKeys(input.context ?? {}, ['timezone', 'page', 'taskId', 'date'], '页面上下文')
        if (!(await status()).configured) throw new ValidationError('请先在设置中连接模型')
        const config = getModelSettings(db)
        const onEvent = config.streamResponses !== false && req.headers.accept?.includes('text/event-stream') ? startStream?.() : undefined
        const result = await completionScope.run(selectedCompletion(config), () => xixi.chat(input, { onEvent }))
        return { ...state(result.conversationId), requestId: result.requestId, status: result.status,
          ...(result.execution ? { execution: result.execution } : {}), ...(result.error ? { error: result.error } : {}) }
      }
      if (path === '/conversations') return state(db.createConversation().id)
      if (path === '/conversations/select') return state(db.selectConversation(identifier(input.id)).id)
      if (path === '/conversations/rename') return db.renameConversation(input.conversationId, input.title)
      if (path === '/conversations/delete') {
        const result = db.deleteConversation(input.conversationId)
        return state(result.activeConversationId)
      }
      if (path === '/messages/retract') return retractedState(db.retractRequest(input))
      const retract = path.match(/^\/messages\/([^/]+)\/retract$/)
      if (retract) { knownKeys(input, []); return retractedState(db.retractMessage(decodeId(retract[1]))) }
      if (path === '/operations/read') { db.markOperationsRead(input.ids); return { ok: true } }
      const undo = path.match(/^\/operations\/([^/]+)\/undo$/)
      if (undo) { knownKeys(input, []); return publicOperation(db.undoOperation(decodeId(undo[1])), db) }
      const forget = path.match(/^\/memories\/([^/]+)\/forget$/)
      if (forget) { knownKeys(input, []); db.forgetMemory(decodeId(forget[1])); return { ok: true } }
      if (path === '/tasks/create') return db.createTask(input)
      if (path === '/tasks/update') return db.updateTask(input.id, input.patch, input.expectedUpdatedAt)
      if (path === '/tasks/delete') return db.deleteTask(input.id)
      if (path === '/tasks/reopen') return db.reopenTask(input.id, input.expectedUpdatedAt)
      if (path === '/tasks/steps/check') return toggleTaskStep(db, input)
      if (path === '/areas/create') return db.createArea(input.name, input.defaultEnergy)
      if (path === '/areas/rename') return db.renameArea(input.id, input.name)
      if (path === '/events/create') return db.createEvent(input)
      if (path === '/events/delete') { db.deleteEvent(input.id); return { ok: true } }
      if (path === '/availability') return db.saveAvailability(input.date, input.until)
      if (path === '/assignments') return db.saveAssignment(input)
      if (path === '/migration') return db.importLegacy(input)
    }
    throw new ValidationError('找不到这个本机接口', 404)
  }

  const pendingRequests = new Set()
  const middleware = (req, res, next) => {
    if (!(req.url === '/api' || req.url?.startsWith('/api/'))) return next()
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    let streaming = false, heartbeat
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
    const pending = Promise.resolve().then(() => dispatch(req, startStream)).then(result => {
      if (streaming) { send({ type: 'result', result }); res.end() }
      else res.end(JSON.stringify(result ?? null))
    }).catch(error => {
      const message = error instanceof ValidationError || error instanceof ProviderError ? error.message : '本机操作未完成，请稍后重试；密钥问题可检查系统钥匙串授权'
      if (streaming) { send({ type: 'error', error: message, status: error instanceof ValidationError ? error.status : 503 }); res.end() }
      else {
        res.statusCode = error instanceof ValidationError ? error.status : 503
        res.end(JSON.stringify({ error: message }))
      }
    }).finally(() => clearInterval(heartbeat))
    pendingRequests.add(pending)
    pending.finally(() => pendingRequests.delete(pending)).catch(() => {})
  }
  return {
    middleware,
    whenIdle: () => Promise.allSettled([...pendingRequests]),
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
