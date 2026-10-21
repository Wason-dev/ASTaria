import { taskCollectionChanges } from './taskCollections.mjs'
import { readOnboarding } from './onboarding.mjs'
import { createCompletion, discoverLocalModels, testLocalCompletion, MODELS } from './provider.mjs'
import { getModelSettings, saveModelSettings } from './modelSettingsCore.mjs'
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
import { ValidationError, identifier, knownKeys } from './validation.mjs'
import { isSourceMetadataList, uniqueSourceMetadata } from '../src/xixi/sourceMetadata.ts'
import { compatibleEndpoint } from '../src/xixi/cloudProviders.ts'
import { recognizeTimetable, confirmTimetable } from './timetableImport.mjs'
import { isReceiptEstimateMessage } from '../src/xixi/receiptTaskSettings.ts'
import { contextModel, contextMeterKey } from './contextUsage.mjs'
import { isContextUsage } from '../src/xixi/contextUsage.ts'
import { previewIcsTimetable, confirmIcsTimetable } from './icsTimetableImport.mjs'
const publicMessage = (raw) => {
  const { id, seq, role, content, createdAt, requestId, taskId, excludeFromContext, question, retractedAt, reasoningContent, attachments, executionNotice, sources } = raw.role === 'assistant' && !raw.retractedAt ? normalizeAssistantProtocol(raw) : raw
  return ({
  id, seq, role, content: retractedAt ? '已撤回' : content, createdAt, requestId, taskId, excludeFromContext,
  ...(isReceiptEstimateMessage(raw) ? { inputKind: 'receipt-estimate' } : {}),
  ...(retractedAt ? { retractedAt } : { question, ...(attachments?.length ? { attachments } : {}), ...(role === 'assistant' && reasoningContent ? { reasoningContent } : {}), ...(executionNotice ? { executionNotice } : {}), ...(role === 'assistant' && !excludeFromContext && !raw.contextRetractedAt && isSourceMetadataList(sources) ? { sources: uniqueSourceMetadata(sources) } : {}) }),
}) }


/** Platform-independent routes, using one database and one set of business
 * rules. Native adapters supply secrets, networking, device information and
 * async completion scope; HTTP access control stays in index.mjs. */
export function createServiceCore({ db, vault, complete, fetcher = fetch, compatibleVault, compatibleFetcher = fetcher,
  dataDirectory, secretStorage, deviceRecommendation, webSearch,
  localModelInstaller, xixiFactory, completionScope }) {
  const selectedCompletion = (config = getModelSettings(db)) => createCompletion(vault, fetcher, () => config.cloudModel, () => config, { compatibleVault, compatibleFetcher })
  const completion = complete ?? ((payload, options) => (completionScope.getStore() ?? selectedCompletion())(payload, options))
  const xixi = xixiFactory({ db, complete: completion, webSearch })
  const companion = createCompanion({ db })
  const routeAnalysis = createRouteAnalysis({ db, companion, complete: completion })
  const stringOrder = createStringOrder({ db, complete: completion })
  const horizonOrder = createHorizonOrder({ db, complete: completion })
  const horizonGrouping = createHorizonGrouping({ db, list: horizonOrder.list, complete: completion })
  const freeTime = createFreeTime({ db })
  const state = (id = db.getActiveConversation().id, before) => {
    const meter = db.getPreference(contextMeterKey(id))
    const contextUsage = isContextUsage(meter?.usage) && meter.usage.modelKey === contextModel(getModelSettings(db)).modelKey
      && !db.getTurn(meter.requestId)?.retractedAt ? meter.usage : null
    const raw = db.listMessages(id, { limit: 200, ...(before === undefined ? {} : { before }) })
    const oldestSeq = raw[0]?.seq ?? null
    const messages = raw.filter(message => message.role !== 'tool' && !message.toolCalls?.length && !(message.retractedAt && message.role === 'assistant'))
    const visibleRequests = new Set(messages.map(message => message.requestId))
    const operations = db.listOperations()
    const rawRequests = new Set(raw.map(message => message.requestId).filter(Boolean))
    const turnReferences = new Map(db.getTurnReferences([...rawRequests, ...operations.map(operation => operation.requestId)])
      .map(turn => [turn.requestId, turn]))
    // A raw page can start inside a long tool round (or a withdrawn reply).
    // Keep its successful receipts attached to the original user message even
    // before a final assistant bubble exists; the raw pagination cursor stays put.
    for (const requestId of rawRequests) {
      if (visibleRequests.has(requestId)) continue
      const turn = turnReferences.get(requestId)
      const anchor = turn?.conversationId === id ? db.getMessage(turn.userMessageId) : null
      if (anchor?.role === 'user') messages.push(anchor)
    }
    // A page can begin at the final reply, after all of that turn's thoughts.
    // Query only existence through the request index; fetch the full text when
    // expanded so ordinary conversation responses keep their bounded size.
    const savedReasoning = new Set(messages.filter(message => !message.retractedAt && message.requestId)
      .map(message => message.requestId).filter((requestId, index, ids) => ids.indexOf(requestId) === index)
      .filter(requestId => db.hasSavedReasoning(id, requestId)))
    // Aggregate each request once, in raw-page order, including hidden native
    // tool-call rounds. This is the same bounded public preview, not a rewrite
    // of the full transcript fetched by the reasoning endpoint.
    const thoughtParts = new Map()
    for (const message of raw) {
      if (message.role !== 'assistant' || message.retractedAt || message.excludeFromContext || !message.reasoningContent) continue
      const parts = thoughtParts.get(message.requestId)
      if (parts) parts.push(message.reasoningContent)
      else thoughtParts.set(message.requestId, [message.reasoningContent])
    }
    const thoughtsByRequest = new Map([...thoughtParts].map(([requestId, parts]) => {
      const thoughts = parts.join('\n\n')
      return [requestId, thoughts.length > 120_000 ? `${thoughts.slice(0, 120_000)}\n\n（思考内容较长，展示已截短）` : thoughts]
    }))
    return {
      conversationId: id, contextUsage,
      messages: messages.sort((a, b) => a.seq - b.seq).map(message => {
        const visible = { ...publicMessage(message), ...(!message.retractedAt && savedReasoning.has(message.requestId) ? { hasSavedReasoning: true } : {}) }
        if (message.role !== 'assistant' || message.retractedAt || !message.requestId) return visible
        // Bound display only. The exact full reasoning transcript remains stored
        // for subsequent provider calls, including native tool-call rounds.
        const thoughts = thoughtsByRequest.get(message.requestId)
        return thoughts ? { ...visible, reasoningContent: thoughts } : visible
      }),
      operations: publicOperations(operations.filter(operation => turnReferences.get(operation.requestId)?.conversationId === id), db),
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
    // A local conversation does not need the cloud key. Once the user
    // explicitly enables external search, however, show whether that separate
    // DeepSeek channel is configured as well.
    if (providerSettings.provider === 'deepseek' || providerSettings.webSearch.enabled) {
      try { cloudConfigured = await vault.status() } catch { cloudConfigured = false }
    }
    let compatibleConfigured = false
    if (providerSettings.provider === 'compatible' && compatibleVault) {
      try { compatibleConfigured = await compatibleVault(providerSettings.compatible.baseUrl).status() } catch { /* Locked or unavailable storage. */ }
    }
    return { service: 'astaria-local', provider: providerSettings.provider, providerSettings, cloudConfigured, compatibleConfigured,
      contextModelKey: contextModel(providerSettings).modelKey, contextCapacity: contextModel(providerSettings).capacity,
      configured: providerSettings.provider === 'local' ? Boolean(providerSettings.local.model) : providerSettings.provider === 'compatible' ? compatibleConfigured : cloudConfigured,
      model: providerSettings.provider === 'local' ? providerSettings.local.model : providerSettings.provider === 'compatible' ? providerSettings.compatible.model : providerSettings.cloudModel, models: MODELS, storage: 'SQLite', dataDirectory,
      secretStorage: secretStorage }
  }

  async function dispatch(rawPath, suppliedInput, { startStream, headers = {}, signal } = {}) {
    const url = new URL(rawPath, 'https://astaria.invalid')
    const path = url.pathname.replace(/^\/api/u, '')
    const input = suppliedInput === undefined ? null : suppliedInput
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
      if (path === '/onboarding') return readOnboarding(db)
      if (path === '/operations') return publicOperations(db.listOperations(), db)
      if (path === '/data/export') return db.exportData()
      if (path === '/sync/status') return { available: false, configured: false, message: '同步需要 macOS 或 Windows 桌面版的系统凭据保护', conflicts: [] }
      if (path === '/companion') return companion.listState({ ...(url.searchParams.get('date') ? { date: url.searchParams.get('date') } : {}), ...(url.searchParams.get('days') ? { days: Number(url.searchParams.get('days')) } : {}) })
      if (path === '/companion/string-order') return stringOrder.list({ date: url.searchParams.get('date') || undefined })
      if (path === '/companion/horizon-order') return horizonOrder.list({ date: url.searchParams.get('date') || undefined })
      if (path === '/planner') return freeTime.plannerState()
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
      if (path === '/onboarding') {
        knownKeys(input, ['completed'], '首次引导')
        if (input.completed !== true) throw new ValidationError('首次引导状态不正确')
        db.setPreference('onboarding-completed', true)
        return { completed: true }
      }
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
      if (path === '/companion/free-time/reopen') return freeTime.reopenSession(input)
      if (path === '/companion/scenario') return companion.previewScenario(input)
      if (path === '/companion/decision') return companion.previewDecision(input)
      if (path === '/companion/route') return completionScope.run(selectedCompletion(), () => routeAnalysis.analyze(input))
      if (path === '/companion/string-order') return completionScope.run(selectedCompletion(), () => stringOrder.apply(input))
      if (path === '/companion/horizon-order') {
        const onEvent = headers.accept?.includes('text/event-stream') ? startStream?.() : undefined
        return completionScope.run(selectedCompletion(), () => horizonOrder.apply(input, { onEvent }))
      }
      if (path === '/companion/horizon-groups') {
        const onEvent = headers.accept?.includes('text/event-stream') ? startStream?.() : undefined
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
        '/settings/provider': ['provider', 'cloudModel', 'reasoningEffort', 'streamResponses', 'contextBudget', 'webSearch', 'local', 'compatible'], '/settings/local/models': ['engine', 'baseUrl'],
        '/settings/compatible/key': ['baseUrl', 'key'], '/settings/compatible/key/remove': ['baseUrl'],
        '/settings/local/install': ['baseUrl', 'model', 'confirmed'],
        '/chat': ['requestId', 'conversationId', 'text', 'attachments', 'context'], '/conversations': [],
        '/conversations/select': ['id'], '/conversations/rename': ['conversationId', 'title'], '/conversations/delete': ['conversationId'], '/operations/read': ['ids'],
        '/messages/retract': ['requestId', 'conversationId'],
        '/tasks/collection': ['tasks', 'collection', 'removeTasks', 'requestId'],
        '/tasks/update': ['id', 'patch', 'expectedUpdatedAt'], '/tasks/delete': ['id'], '/tasks/reopen': ['id', 'expectedUpdatedAt'],
        '/tasks/steps/check': ['taskId', 'stepId', 'checked', 'expectedUpdatedAt'], '/areas/create': ['name', 'defaultEnergy'],
        '/areas/rename': ['id', 'name'], '/events/delete': ['id'], '/availability': ['date', 'until'],
      }[path]
      if (fields) knownKeys(input, fields)
      if (path === '/planner/import/recognize') {
        knownKeys(input, ['images', 'split'])
        if (!(await status()).configured) throw new ValidationError('请先连接支持识图的模型，也可以直接手动录入课表')
        return recognizeTimetable(input, complete ?? selectedCompletion(), { signal })
      }
      if (path === '/planner/import/confirm') return confirmTimetable(db, input)
      if (path === '/planner/import/ics/preview') return previewIcsTimetable(input)
      if (path === '/planner/import/ics/confirm') return confirmIcsTimetable(db, input)
      if (path === '/settings/compatible/key' || path === '/settings/compatible/key/remove') {
        if (!compatibleVault) throw new ValidationError('当前环境暂不支持其它 API 的安全密钥存储', 501)
        let endpoint
        try { endpoint = compatibleEndpoint(input.baseUrl) } catch (error) { throw new ValidationError(error.message) }
        const config = getModelSettings(db)
        if (config.provider !== 'compatible' || config.compatible.baseUrl !== endpoint) throw new ValidationError('请先保存当前 API 地址，再设置对应密钥', 409)
        const scoped = compatibleVault(endpoint)
        if (path.endsWith('/remove')) await scoped.remove()
        else {
          if (typeof input.key !== 'string' || !/^[\x21-\x7e]{8,512}$/u.test(input.key.trim())) throw new ValidationError('请输入有效的 API Key')
          await scoped.save(input.key.trim())
        }
        return status()
      }
      if (path === '/planner') return freeTime.plannerState(db.updatePlanner(input.action, input.expectedRevision))
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
        if (config.provider === 'deepseek') {
          try { cloudConfigured = await vault.status() } catch { cloudConfigured = false }
        }
        const current = { provider: config.provider, configured: config.provider === 'local' ? Boolean(config.local.model) : config.provider === 'compatible' ? Boolean(compatibleVault && await compatibleVault(config.compatible.baseUrl).status()) : cloudConfigured }
        if (!current.configured) throw new ValidationError(current.provider === 'local' ? '先保存本地模型名称再测试连接' : '先保存 API Key 再测试连接')
        const testCompletion = complete ?? selectedCompletion(config)
        if (current.provider === 'local' || current.provider === 'compatible') return testLocalCompletion(testCompletion)
        await testCompletion({ messages: [{ role: 'user', content: 'Reply with OK' }], max_tokens: 8 })
        return { ok: true, toolCalling: null, message: '云端连接成功，析熙准备好了' }
      }
      if (path === '/chat') {
        knownKeys(input.context ?? {}, ['timezone', 'page', 'taskId', 'date', 'wishId', 'freeTimeGoalId'], '页面上下文')
        if (!(await status()).configured) throw new ValidationError('请先在设置中连接模型')
        const config = getModelSettings(db)
        const onEvent = config.streamResponses !== false && headers.accept?.includes('text/event-stream') ? startStream?.() : undefined
        const result = await completionScope.run(selectedCompletion(config), () => xixi.chat(input, { onEvent, signal }))
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
      if (path === '/tasks/collection') {
        const requestId = identifier(input.requestId, '请求标识')
        const previous = db.listOperations({ requestId }).find(operation => operation.id === requestId)
        if (previous) {
          const requested = [...(Array.isArray(input.tasks) ? input.tasks : []), ...(Array.isArray(input.removeTasks) ? input.removeTasks : [])]
          const collection = input.collection == null ? undefined : String(input.collection).trim()
          if (!Array.isArray(requested) || requested.length !== previous.changes.length ||
            !previous.changes.every(change => requested.some(ref => ref.id === change.id) && change.after?.collection === (input.removeTasks?.some(ref => ref.id === change.id) ? undefined : collection))) {
            throw new ValidationError('这个请求已用于其他归类，请重新提交', 409)
          }
          return { operation: publicOperation(previous, db) }
        }
        const { changes, summary } = taskCollectionChanges(db, { tasks: input.tasks, collection: input.collection, removeTasks: input.removeTasks })
        const operation = db.applyOperation({ id: requestId, requestId, changes, summary })
        return { operation: publicOperation(operation, db) }
      }
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

  return { dispatch, status, reminderSnapshot: () => ({ tasks: db.listTasks(), planner: freeTime.plannerState(), preferences: getPreferences(db) }) }
}
