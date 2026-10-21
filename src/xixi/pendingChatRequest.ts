import type { ChatAttachment } from './types'
import { projectDocumentAttachment } from './documentAttachment.ts'

export type PendingChatContext = { page: 'home' | 'workbench' | 'calendar' | 'timetable'; taskId?: string; wishId?: string; freeTimeGoalId?: string; date?: string; timezone: string }
export type PendingChatRequest = { requestId: string; conversationId: string; text: string; attachments?: ChatAttachment[]; context: PendingChatContext; createdAt?: string; seq?: number }
type PendingIndex = { version: 2; requestId: string; conversationId: string; createdAt?: string; seq?: number }
export const PENDING_CHAT_INDEX_KEY = 'astaria-xixi-pending-v1'
export const PENDING_CHAT_SCOPE_KEY = 'astaria-xixi-pending-scope-v1'
export const PENDING_CHAT_DATABASE = 'astaria-pending-chat-v1'
export const PENDING_CHAT_OBJECT_STORE = 'requests'

export interface PendingChatAdapter {
  list(scopeId: string): Promise<PendingChatRequest[]>
  put(scopeId: string, request: PendingChatRequest): Promise<void>
  remove(scopeId: string, requestIds: string[]): Promise<void>
}
type IndexStorage = Pick<Storage, 'getItem' | 'setItem'>
const invalid = () => new Error('无法读取发送记录，请保留原文后重新打开页面')
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

// Project only the chat contract. Settings, provider configuration and API keys
// never enter this store, including when migrating an older session index.
function requestRecord(value: unknown): PendingChatRequest {
  if (!object(value) || typeof value.requestId !== 'string' || !value.requestId || typeof value.conversationId !== 'string' || !value.conversationId || typeof value.text !== 'string' || !object(value.context)) throw invalid()
  const context = value.context
  if (typeof context.page !== 'string' || !['home', 'workbench', 'calendar', 'timetable'].includes(context.page) || typeof context.timezone !== 'string') throw invalid()
  const cleanContext: PendingChatContext = { page: context.page as PendingChatContext['page'], timezone: context.timezone }
  for (const key of ['taskId', 'wishId', 'freeTimeGoalId', 'date'] as const) {
    if (context[key] !== undefined) {
      if (typeof context[key] !== 'string') throw invalid()
      cleanContext[key] = context[key]
    }
  }
  const clean: PendingChatRequest = { requestId: value.requestId, conversationId: value.conversationId, text: value.text, context: cleanContext }
  if (value.createdAt !== undefined) {
    if (typeof value.createdAt !== 'string') throw invalid()
    clean.createdAt = value.createdAt
  }
  if (value.seq !== undefined) {
    if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 0) throw invalid()
    clean.seq = value.seq as number
  }
  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments) || value.attachments.length > 1) throw invalid()
    clean.attachments = value.attachments.map(item => {
      if (object(item) && item.kind === 'document') return projectDocumentAttachment(item)
      if (object(item) && item.kind !== undefined && item.kind !== 'image') throw invalid()
      if (!object(item) || typeof item.name !== 'string' || typeof item.mime !== 'string' || !['image/png', 'image/jpeg', 'image/webp'].includes(item.mime) || typeof item.data !== 'string' || !Number.isSafeInteger(item.size) || (item.size as number) < 1) throw invalid()
      return { ...(item.kind === 'image' ? { kind: 'image' as const } : {}), name: item.name, mime: item.mime as 'image/png' | 'image/jpeg' | 'image/webp', size: item.size as number, data: item.data }
    })
  }
  return clean
}
const indexRecord = (request: PendingChatRequest): PendingIndex => ({ version: 2, requestId: request.requestId, conversationId: request.conversationId, ...(request.createdAt !== undefined ? { createdAt: request.createdAt } : {}), ...(request.seq !== undefined ? { seq: request.seq } : {}) })

export function createIndexedDBPendingChatAdapter(factory: () => IDBFactory = () => globalThis.indexedDB): PendingChatAdapter {
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest
    let failed = false
    try { request = factory().open(PENDING_CHAT_DATABASE, 1) } catch (error) { reject(error); return }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(PENDING_CHAT_OBJECT_STORE)) {
        const store = request.result.createObjectStore(PENDING_CHAT_OBJECT_STORE, { keyPath: ['scopeId', 'requestId'] })
        store.createIndex('scope', 'scopeId')
      }
    }
    request.onerror = () => { failed = true; reject(request.error ?? invalid()) }
    request.onblocked = () => { failed = true; reject(new Error('本机发送记录暂时被占用，请关闭其他窗口后重试')) }
    request.onsuccess = () => {
      if (failed) request.result.close()
      else { request.result.onversionchange = () => request.result.close(); resolve(request.result) }
    }
  })
  const transaction = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T> | undefined): Promise<T | undefined> => {
    const db = await open()
    try {
      return await new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(PENDING_CHAT_OBJECT_STORE, mode)
        let result: T | undefined
        tx.oncomplete = () => resolve(result)
        tx.onabort = () => reject(tx.error ?? new Error('本机发送记录未能保存，请重试'))
        tx.onerror = () => { /* onabort owns the final transaction result. */ }
        try {
          const request = action(tx.objectStore(PENDING_CHAT_OBJECT_STORE))
          if (request) request.onsuccess = () => { result = request.result }
        } catch (error) { tx.abort(); reject(error) }
      })
    } finally { db.close() }
  }
  return {
    async list(scopeId) {
      const values = await transaction('readonly', store => store.index('scope').getAll(scopeId))
      if (!Array.isArray(values)) throw invalid()
      return values.map(value => {
        if (!object(value) || value.scopeId !== scopeId) throw invalid()
        return requestRecord(value)
      })
    },
    async put(scopeId, request) { await transaction('readwrite', store => store.put({ ...requestRecord(request), scopeId })) },
    async remove(scopeId, requestIds) { await transaction('readwrite', store => { for (const id of requestIds) store.delete([scopeId, id]); return undefined }) },
  }
}

export function createPendingChatRequestStore(options: { session?: IndexStorage; adapter?: PendingChatAdapter; createId?: () => string } = {}) {
  const adapter = options.adapter ?? createIndexedDBPendingChatAdapter()
  const storage = () => options.session ?? globalThis.sessionStorage
  let tail: Promise<unknown> = Promise.resolve()
  const serialized = <T>(action: () => Promise<T>): Promise<T> => {
    const result = tail.then(action)
    tail = result.catch(() => {})
    return result
  }
  const scope = () => {
    let id = storage().getItem(PENDING_CHAT_SCOPE_KEY)
    if (!id) { id = options.createId?.() ?? crypto.randomUUID(); storage().setItem(PENDING_CHAT_SCOPE_KEY, id) }
    return id
  }
  const legacyEntries = (): PendingChatRequest[] => {
    const value: unknown = JSON.parse(storage().getItem(PENDING_CHAT_INDEX_KEY) || '[]')
    if (!Array.isArray(value)) throw invalid()
    return value.filter(item => !(object(item) && item.version === 2)).map(requestRecord)
  }
  const writeIndex = (items: PendingIndex[]) => storage().setItem(PENDING_CHAT_INDEX_KEY, JSON.stringify(items))
  const load = async () => {
    const legacy = legacyEntries()
    // A new, empty window does not need a database or a scope yet.
    if (!legacy.length && !storage().getItem(PENDING_CHAT_SCOPE_KEY)) return []
    const owner = scope(), requests = (await adapter.list(owner)).map(requestRecord)
    for (const request of legacy) {
      const previous = requests.find(item => item.requestId === request.requestId)
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(request)) throw invalid()
      } else {
        await adapter.put(owner, request)
        requests.push(request)
      }
    }
    // Upgrade only after every full record has committed. A failed migration
    // retains the old retry IDs and original bytes for the next attempt.
    if (legacy.length) writeIndex(requests.map(indexRecord))
    else {
      // IndexedDB is authoritative: a stale lightweight index after a crash or
      // failed cleanup cannot resurrect a completed/deleted request.
      try { writeIndex(requests.map(indexRecord)) } catch { /* The scope still restores full records. */ }
    }
    return requests
  }
  const removeWhere = (matches: (entry: PendingChatRequest) => boolean) => serialized(async () => {
    const items = await load(), removed = items.filter(matches)
    if (!removed.length) return
    // One IndexedDB transaction removes the request and its original attachment.
    // A failed delete retains the durable retry record for the next cleanup.
    await adapter.remove(scope(), removed.map(item => item.requestId))
    try { writeIndex(items.filter(item => !matches(item)).map(indexRecord)) } catch { /* A stale index is only a cache. */ }
  })
  return {
    list: () => serialized(load),
    save: (input: PendingChatRequest) => serialized(async () => {
      const request = requestRecord(input), owner = scope()
      const pending = await load(), previous = pending.find(item => item.requestId === request.requestId)
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(request)) throw new Error('发送标识已用于不同内容，请保留原文后重试')
        writeIndex(pending.map(indexRecord))
        return
      }
      await adapter.put(owner, request)
      // An index-write failure blocks the API but retains the committed record;
      // a later retry/reload recovers the same ID from this window's scope.
      writeIndex([...pending.map(indexRecord), indexRecord(request)])
    }),
    remove: (requestIds: Iterable<string>) => { const ids = new Set(requestIds); return removeWhere(item => ids.has(item.requestId)) },
    removeConversation: (conversationId: string) => removeWhere(item => item.conversationId === conversationId),
  }
}
export type PendingChatRequestStore = ReturnType<typeof createPendingChatRequestStore>
export const pendingChatRequests = createPendingChatRequestStore()
