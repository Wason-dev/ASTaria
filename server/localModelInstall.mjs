import { randomUUID } from 'node:crypto'
import { totalmem } from 'node:os'
import { LOCAL_DEFAULT, localEndpoint } from './modelSettings.mjs'
import { ProviderError } from './provider.mjs'
import { ValidationError, identifier, knownKeys } from './validation.mjs'

// Ollama's official Qwen3 tags support tools. Actual tool reliability is still
// checked separately by the connection test after selecting the installed model.
const MODELS = [
  { id: 'qwen3:4b', label: 'Qwen3 4B · 轻量', downloadGB: 2.5, diskGB: 4, minMemoryGB: 8 },
  { id: 'qwen3:8b', label: 'Qwen3 8B · 均衡', downloadGB: 5.2, diskGB: 7, minMemoryGB: 16 },
  { id: 'qwen3:14b', label: 'Qwen3 14B · 更强', downloadGB: 9.3, diskGB: 12, minMemoryGB: 24 },
  { id: 'qwen3:32b', label: 'Qwen3 32B · 高内存', downloadGB: 20, diskGB: 24, minMemoryGB: 48 },
]
const ACTIVE = new Set(['checking', 'downloading'])
const JSON_LIMIT = 512 * 1024
const LINE_LIMIT = 16 * 1024
const STREAM_LIMIT = 16 * 1024 * 1024
const INSTALL_LIMIT_MS = 6 * 60 * 60 * 1000
const IDLE_LIMIT_MS = 90_000
const DOWNLOAD_ERROR = '模型下载未完成，请检查 Ollama、网络连接和磁盘空间后重试；已缓存的文件可由 Ollama 继续复用'
const STOP_MESSAGE = '已停止下载连接；Ollama 可能保留已缓存的部分文件，下次下载可以复用'

const snapshot = job => {
  const { controller, ...publicJob } = job
  return { ...publicJob }
}

async function smallJSON(response) {
  let reader
  try {
    if (!response.ok || !response.body) throw new Error('HTTP')
    reader = response.body.getReader()
    const chunks = []
    let size = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > JSON_LIMIT) throw new Error('LIMIT')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock() }
    else await response.body?.cancel().catch(() => {})
  }
}

export function createLocalModelInstaller({ fetcher = fetch, memoryGB = Math.round(totalmem() / 1024 ** 3) } = {}) {
  const jobs = new Map()
  let activeId = null
  let closed = false
  const origin = baseUrl => new URL(baseUrl).origin
  const touch = (job, patch) => Object.assign(job, patch, { updatedAt: new Date().toISOString() })
  const fetchJSON = async (url, signal) => smallJSON(await fetcher(url, { redirect: 'error', signal }))
  const version = async (baseUrl, signal) => {
    const value = await fetchJSON(`${origin(baseUrl)}/api/version`, signal)
    if (typeof value?.version !== 'string' || !/^\d+\.\d+\.\d+(?:[.-][a-zA-Z0-9.-]+)?$/u.test(value.version) || value.version.length > 64) throw new Error('NOT_OLLAMA')
    return value.version
  }
  const installed = async (baseUrl, signal) => {
    const value = await fetchJSON(`${origin(baseUrl)}/api/tags`, signal)
    if (!Array.isArray(value?.models)) throw new Error('TAGS')
    return new Set(value.models.slice(0, 1000).flatMap(model => [model?.name, model?.model].filter(id => typeof id === 'string' && id.length <= 200)))
  }
  const options = async (input = {}) => {
    knownKeys(input, ['baseUrl'])
    const baseUrl = localEndpoint(input.baseUrl ?? LOCAL_DEFAULT.baseUrl)
    let runtimeAvailable = false, runtimeVersion = null, present = new Set()
    let message = '请先安装并打开 Ollama，再检测；ASTaria 不会替你安装运行时'
    const signal = AbortSignal.timeout(10_000)
    try {
      runtimeVersion = await version(baseUrl, signal)
      runtimeAvailable = true
      message = 'Ollama 已连接。下载体积和磁盘需求为估算；模型下载由 Ollama 从其模型仓库完成'
      try { present = await installed(baseUrl, signal) }
      catch { message = 'Ollama 已连接，但暂时无法读取已安装模型；请重新检测后再下载' }
    } catch { /* A missing local runtime is a setup state, not a cloud fallback. */ }
    const recommendedId = MODELS.filter(model => model.minMemoryGB <= memoryGB).at(-1)?.id ?? null
    if (recommendedId === null) message += '；本机内存低于这些模型的建议配置，暂不推荐安装，建议使用 API'
    const matching = [...jobs.values()].filter(job => job.baseUrl === baseUrl)
    return { baseUrl, runtimeAvailable, runtimeVersion, message,
      options: MODELS.map(model => ({ ...model, installed: present.has(model.id), recommended: model.id === recommendedId })),
      activeJob: matching.find(job => ACTIVE.has(job.status)) ? snapshot(matching.find(job => ACTIVE.has(job.status))) : null,
      latestJob: matching.length ? snapshot(matching.at(-1)) : null }
  }

  const pull = async job => {
    const timeout = setTimeout(() => job.controller.abort(new Error('TIMEOUT')), INSTALL_LIMIT_MS)
    timeout.unref?.()
    let reader, idleTimeout
    const resetIdle = () => {
      clearTimeout(idleTimeout)
      idleTimeout = setTimeout(() => job.controller.abort(new Error('IDLE_TIMEOUT')), IDLE_LIMIT_MS)
      idleTimeout.unref?.()
    }
    try {
      const signal = job.controller.signal
      await version(job.baseUrl, AbortSignal.any([signal, AbortSignal.timeout(10_000)]))
      const existing = await installed(job.baseUrl, AbortSignal.any([signal, AbortSignal.timeout(10_000)]))
      if (signal.aborted) throw new Error('ABORTED')
      if (existing.has(job.model)) {
        touch(job, { status: 'succeeded', message: '模型已经安装，无需重复下载，可以选择使用并测试工具调用', percent: 100 })
        return
      }
      touch(job, { status: 'downloading', message: '正在连接 Ollama 模型仓库' })
      resetIdle()
      const response = await fetcher(`${origin(job.baseUrl)}/api/pull`, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: job.model, stream: true, insecure: false }),
      })
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('HTTP') }
      reader = response.body.getReader()
      let buffer = '', size = 0, lines = 0, succeeded = false
      const decoder = new TextDecoder('utf-8', { fatal: true }), layers = new Map()
      const consume = line => {
        if (!line.trim()) return
        if (line.length > LINE_LIMIT || ++lines > 100_000) throw new Error('LIMIT')
        const value = JSON.parse(line)
        if (!value || typeof value !== 'object' || Array.isArray(value) || value.error || typeof value.status !== 'string' || value.status.length > 200) throw new Error('PROTOCOL')
        if (value.status === 'success') { succeeded = true; return }
        if (value.total !== undefined || value.completed !== undefined) {
          const { total, completed = 0 } = value
          if (!Number.isSafeInteger(total) || total <= 0 || total > 100 * 1024 ** 3 || !Number.isSafeInteger(completed) || completed < 0 || completed > total) throw new Error('PROGRESS')
          const digest = value.digest ?? 'model'
          if (typeof digest !== 'string' || digest.length > 200 || (layers.size >= 64 && !layers.has(digest))) throw new Error('LAYERS')
          layers.set(digest, { total, completed })
          const totalBytes = [...layers.values()].reduce((sum, layer) => sum + layer.total, 0)
          const completedBytes = [...layers.values()].reduce((sum, layer) => sum + layer.completed, 0)
          touch(job, { totalBytes, completedBytes, percent: Math.min(99, Math.floor(completedBytes / totalBytes * 100)) })
        }
        touch(job, { message: /^verifying|^writing|^removing/u.test(value.status) ? '文件已下载，正在由 Ollama 校验和安装' : '正在下载模型文件' })
      }
      while (!succeeded) {
        if (signal.aborted) throw new Error('ABORTED')
        const { value, done } = await reader.read()
        if (signal.aborted) throw new Error('ABORTED')
        resetIdle()
        if (done) {
          buffer += decoder.decode()
          if (buffer.trim()) consume(buffer)
          break
        }
        size += value.length
        if (size > STREAM_LIMIT) throw new Error('LIMIT')
        buffer += decoder.decode(value, { stream: true })
        let newline
        while ((newline = buffer.indexOf('\n')) !== -1 && !succeeded) {
          consume(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
        }
        if (buffer.length > LINE_LIMIT && !succeeded) throw new Error('LIMIT')
      }
      await reader.cancel().catch(() => {})
      reader.releaseLock(); reader = null
      clearTimeout(idleTimeout)
      if (!succeeded || signal.aborted) throw new Error('INCOMPLETE')
      touch(job, { message: '正在确认模型已安装' })
      const present = await installed(job.baseUrl, AbortSignal.any([signal, AbortSignal.timeout(10_000)]))
      if (!present.has(job.model) || signal.aborted) throw new Error('NOT_INSTALLED')
      touch(job, { status: 'succeeded', message: '模型已安装，可以选择使用并测试工具调用', percent: 100,
        ...(job.totalBytes ? { completedBytes: job.totalBytes } : {}) })
    } catch {
      if (job.status !== 'cancelled') touch(job, { status: 'failed', message: DOWNLOAD_ERROR, error: DOWNLOAD_ERROR })
    } finally {
      clearTimeout(timeout); clearTimeout(idleTimeout)
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock() }
      if (activeId === job.id) activeId = null
    }
  }

  const start = input => {
    knownKeys(input, ['baseUrl', 'model', 'confirmed'])
    if (input.confirmed !== true) throw new ValidationError('请先确认模型名称、下载体积和本机磁盘占用')
    const baseUrl = localEndpoint(input.baseUrl)
    if (!MODELS.some(model => model.id === input.model)) throw new ValidationError('请选择列表中的受支持模型')
    if (closed) throw new ProviderError('本机服务正在关闭，请重新打开设置')
    if (activeId) throw new ValidationError('已有一个模型下载正在进行或结束，请等待或先取消', 409)
    // Keep only a small in-memory history; no private conversations, keys or
    // durable jobs are written. Restarted services honestly return a lost job.
    while (jobs.size >= 20) jobs.delete(jobs.keys().next().value)
    const now = new Date().toISOString()
    const job = { id: randomUUID(), baseUrl, model: input.model, status: 'checking', message: '正在检查本机 Ollama',
      completedBytes: 0, totalBytes: null, percent: null, createdAt: now, updatedAt: now, error: null,
      controller: new AbortController() }
    jobs.set(job.id, job); activeId = job.id
    void pull(job)
    return snapshot(job)
  }
  const getJob = id => {
    const job = jobs.get(identifier(id, '下载标识'))
    if (!job) throw new ValidationError('下载记录不存在或本机服务已重启；请重新检测已安装模型，未完成的下载可再次开始', 404)
    return job
  }
  const get = id => snapshot(getJob(id))
  const cancel = id => {
    const job = getJob(id)
    if (ACTIVE.has(job.status)) {
      touch(job, { status: 'cancelled', message: STOP_MESSAGE })
      job.controller.abort(new Error('USER_CANCELLED'))
    }
    return snapshot(job)
  }
  const close = () => { closed = true; for (const job of jobs.values()) if (ACTIVE.has(job.status)) cancel(job.id) }
  return { options, start, get, cancel, close }
}
