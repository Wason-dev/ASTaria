import { LocalApiError } from './api'
import type { HorizonResult } from './horizonOrder'

export const HORIZON_PHASES = ['checking', 'preparing', 'waiting', 'thinking', 'receiving', 'validating', 'saving'] as const
export type HorizonPhase = typeof HORIZON_PHASES[number]
export type HorizonActivity = {
  id: string; source: 'local' | 'model'; state: 'running' | 'done' | 'proposed'
  title: string; detail?: string; itemIds?: string[]; day?: 0 | 1 | 2
}
export type HorizonProgress = { phase: 'submitting' | HorizonPhase; completed: HorizonPhase[]; activities?: HorizonActivity[] }

const phaseCopy: Record<HorizonProgress['phase'], { current: string; completed: string }> = {
  submitting: { current: '正在提交新顺序', completed: '' },
  checking: { current: '正在核对日程与空档', completed: '日程已核对' },
  preparing: { current: '正在生成可行初排', completed: '初排已生成' },
  waiting: { current: '等待模型核对初排', completed: '模型已响应' },
  thinking: { current: '模型正在检查初排方案', completed: '初排已审阅' },
  receiving: { current: '正在接收模型的具体建议', completed: '方案已收到' },
  validating: { current: '正在校验时间与冲突', completed: '方案已校验' },
  saving: { current: '正在保存新安排', completed: '' },
}

/** Only observed server transitions can finish a step; elapsed time never advances it. */
export function advanceHorizonProgress(current: HorizonProgress, next: HorizonPhase): HorizonProgress {
  if (current.phase === next) return current
  if (current.phase !== 'submitting' && HORIZON_PHASES.indexOf(next) < HORIZON_PHASES.indexOf(current.phase)) return current
  const completed = current.phase === 'submitting' ? current.completed : [...current.completed, current.phase]
  return { ...current, phase: next, completed }
}

/** Replayed notifications update one row; activity is evidence, never a save receipt. */
export function advanceHorizonActivity(current: HorizonProgress, activity: HorizonActivity): HorizonProgress {
  const previous = current.activities ?? []
  const existing = previous.find(item => item.id === activity.id && item.source === activity.source)
  if (existing && (JSON.stringify(existing) === JSON.stringify(activity) || (existing.state === 'done' && activity.state === 'running'))) return current
  const activities = [...previous.filter(item => item.id !== activity.id || item.source !== activity.source), activity].slice(-24)
  return { ...current, activities }
}

export function horizonProgressCopy(progress: HorizonProgress, seconds: number) {
  const waitingForModel = progress.phase === 'waiting' || progress.phase === 'thinking' || progress.phase === 'receiving'
  const activities = progress.activities ?? [], activity = activities.at(-1)
  return {
    current: phaseCopy[progress.phase].current,
    activity,
    activities,
    completed: progress.completed.slice(-2).map(phase => phaseCopy[phase].completed).filter(Boolean),
    reassurance: seconds >= 20 && waitingForModel ? '仍在等待模型完成，原日程还没有改动' : '',
    elapsed: seconds < 60 ? `${Math.max(0, Math.floor(seconds))} 秒` : `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`,
  }
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const text = (value: unknown): value is string => typeof value === 'string'
const optionalText = (value: unknown) => value === undefined || text(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const interrupted = () => new Error('保存结果尚未完整收到，请用原请求重试核对')
const MAX_FRAME_LENGTH = 2 * 1024 * 1024

/** Activity strings are deliberately bounded plain text; unknown/model reasoning is ignored. */
export function parseHorizonActivity(value: unknown): HorizonActivity | null {
  if (!record(value) || !text(value.id) || !value.id || value.id.length > 160
    || (value.source !== 'local' && value.source !== 'model')
    || !['running', 'done', 'proposed'].includes(String(value.state))
    || !text(value.title) || !value.title.trim() || value.title.length > 160
    || !(value.detail === undefined || (text(value.detail) && value.detail.length <= 600))
    || !(value.day === undefined || value.day === 0 || value.day === 1 || value.day === 2)
    || !(value.itemIds === undefined || (Array.isArray(value.itemIds) && value.itemIds.length <= 128 && value.itemIds.every(id => text(id) && id.length > 0 && id.length <= 160)))) return null
  return { id: value.id, source: value.source, state: value.state as HorizonActivity['state'], title: value.title,
    ...(value.detail === undefined ? {} : { detail: value.detail as string }),
    ...(value.itemIds === undefined ? {} : { itemIds: [...new Set(value.itemIds as string[])] }),
    ...(value.day === undefined ? {} : { day: value.day as 0 | 1 | 2 }) }
}

export function isHorizonResult(value: unknown): value is HorizonResult {
  if (!record(value) || value.days !== 3 || !text(value.date) || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || !text(value.snapshotKey) || !value.snapshotKey || !text(value.asOf) || !text(value.summary)
    || !(value.operation === null || (record(value.operation) && text(value.operation.id) && value.operation.id.length > 0))
    || !(value.replayed === undefined || typeof value.replayed === 'boolean')
    || !Array.isArray(value.items) || !Array.isArray(value.groups)) return false
  return value.items.every(item => record(item) && text(item.id) && text(item.taskId) && text(item.title)
    && text(item.date) && text(item.start) && text(item.end) && finite(item.durationMin)
    && typeof item.movable === 'boolean' && optionalText(item.due) && optionalText(item.reason)
    && (item.needsReschedule === undefined || typeof item.needsReschedule === 'boolean'))
    && value.groups.every(group => record(group) && text(group.id) && text(group.title)
      && (group.day === 0 || group.day === 1 || group.day === 2) && optionalText(group.project)
      && Array.isArray(group.tasks) && group.tasks.every(task => record(task) && text(task.id) && text(task.title) && finite(task.minutes)
        && (task.needsReschedule === undefined || typeof task.needsReschedule === 'boolean')))
}

/** A terminal receipt is required even if the connection already reported saving. */
export async function readHorizonEvents<T>(body: ReadableStream<Uint8Array>, isResult: (value: unknown) => value is T,
  onPhase: (phase: HorizonPhase) => void, signal?: AbortSignal, onActivity?: (activity: HorizonActivity) => void): Promise<T> {
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  const aborted = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', aborted, { once: true })
  try {
    while (true) {
      signal?.throwIfAborted()
      let chunk: ReadableStreamReadResult<Uint8Array>
      try { chunk = await reader.read() } catch {
        signal?.throwIfAborted()
        throw interrupted()
      }
      signal?.throwIfAborted()
      try { buffer += decoder.decode(chunk.value, { stream: !chunk.done }) } catch { throw interrupted() }
      let separator: RegExpExecArray | null
      while ((separator = /\r\n\r\n|\r\n\n|\n\r\n|\n\n|\r\r/.exec(buffer))) {
        if (separator.index > MAX_FRAME_LENGTH) throw interrupted()
        const frame = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator[0].length)
        const data = frame.split(/\r\n|\n|\r/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
        if (!data) continue
        let event: unknown
        try { event = JSON.parse(data) } catch { throw interrupted() }
        if (!record(event)) throw interrupted()
        if (event.type === 'result') {
          if (!isResult(event.result)) throw interrupted()
          return event.result
        }
        if (event.type === 'error') {
          if (!text(event.error) || !Number.isInteger(event.status) || (event.status as number) < 400 || (event.status as number) > 599) throw interrupted()
          throw new LocalApiError(event.error || '安排暂时未完成，请重试', event.status as number)
        }
        // No provider prose, reasoning, or tool arguments enter the UI.
        if (event.type === 'phase' && HORIZON_PHASES.some(phase => phase === event.phase)) onPhase(event.phase as HorizonPhase)
        if (event.type === 'activity') { const activity = parseHorizonActivity(event.activity); if (activity) onActivity?.(activity) }
      }
      if (chunk.done || buffer.length > MAX_FRAME_LENGTH) throw interrupted()
    }
  } finally {
    signal?.removeEventListener('abort', aborted)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function readHorizonStream(body: ReadableStream<Uint8Array>, onPhase: (phase: HorizonPhase) => void, signal?: AbortSignal, onActivity?: (activity: HorizonActivity) => void) {
  return readHorizonEvents(body, isHorizonResult, onPhase, signal, onActivity)
}

export async function requestHorizonEvents<T>(path: string, body: unknown, isResult: (value: unknown) => value is T,
  onPhase: (phase: HorizonPhase) => void, signal?: AbortSignal, onActivity?: (activity: HorizonActivity) => void): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST', headers: { 'X-ASTaria-Local': '1', 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body), cache: 'no-store', signal,
    })
  } catch (reason) {
    if (signal?.aborted) throw reason
    throw interrupted()
  }
  const contentType = response.headers.get('Content-Type') ?? ''
  if (response.ok && contentType.includes('text/event-stream') && response.body) return readHorizonEvents(response.body, isResult, onPhase, signal, onActivity)
  if (!contentType.includes('application/json')) throw interrupted()
  let result: unknown
  try { result = await response.json() } catch { throw interrupted() }
  if (!response.ok) throw new LocalApiError(record(result) && text(result.error) ? result.error : '安排暂时未完成，请重试', response.status)
  if (!isResult(result)) throw interrupted()
  return result
}

export function horizonOrderApi(body: unknown, onPhase: (phase: HorizonPhase) => void, signal?: AbortSignal, onActivity?: (activity: HorizonActivity) => void) {
  return requestHorizonEvents('/api/companion/horizon-order', body, isHorizonResult, onPhase, signal, onActivity)
}
