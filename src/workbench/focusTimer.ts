export const FOCUS_MS = 35 * 60 * 1000
export const REST_MS = 5 * 60 * 1000

export type FocusMode = 'focus' | 'rest'
export type FocusPhase = 'ready' | 'running' | 'paused' | 'finished'
export interface FocusDurations { focusMin: number; restMin: number }

interface TaskTimer {
  mode: FocusMode
  phase: FocusPhase
  elapsedMs: number
  spentMs: number
  durationMs: number
  runningSince: number | null
}

export interface FocusTimerState {
  version: 1
  selectedTaskId: string | null
  durations: FocusDurations
  tasks: Record<string, TaskTimer>
}

export interface FocusSession {
  taskId: string
  mode: FocusMode
  phase: FocusPhase
  remainingMs: number
  elapsedMs: number
  spentMs: number
  durationMs: number
}

const validDurations = (value: FocusDurations) => Number.isInteger(value.focusMin) && value.focusMin >= 5 && value.focusMin <= 120 && value.focusMin % 5 === 0 && Number.isInteger(value.restMin) && value.restMin >= 1 && value.restMin <= 30
const taskTimer = (state: FocusTimerState, taskId: string) => Object.hasOwn(state.tasks, taskId) ? state.tasks[taskId] : undefined
const replaceTimer = (state: FocusTimerState, taskId: string, timer: TaskTimer): FocusTimerState => ({
  ...state, tasks: { ...state.tasks, [taskId]: timer },
})
const readyTimer = (durationMs: number, spentMs = 0): TaskTimer => ({ mode: 'focus', phase: 'ready', elapsedMs: 0, spentMs, durationMs, runningSince: null })

export function createFocusTimerState(): FocusTimerState {
  return { version: 1, selectedTaskId: null, durations: { focusMin: 35, restMin: 5 }, tasks: {} }
}

export function changeFocusDurations(state: FocusTimerState, durations: FocusDurations): FocusTimerState {
  if (!validDurations(durations) || (durations.focusMin === state.durations.focusMin && durations.restMin === state.durations.restMin)) return state
  return {
    ...state, durations: { ...durations },
    tasks: Object.fromEntries(Object.entries(state.tasks).map(([id, timer]) => [id,
      timer.phase === 'ready' ? { ...timer, durationMs: durations.focusMin * 60_000 } : timer,
    ])),
  }
}

/** Wall-clock checkpoints make delayed/background ticks equivalent to frequent ticks. */
export function advanceFocusTimer(state: FocusTimerState, now: number): FocusTimerState {
  const id = state.selectedTaskId
  if (!id || !Number.isFinite(now)) return state
  const timer = taskTimer(state, id)
  if (!timer || timer.phase !== 'running' || timer.runningSince === null) return state
  const delta = Math.min(timer.durationMs - timer.elapsedMs, Math.max(0, now - timer.runningSince))
  if (delta === 0) return state
  const elapsedMs = timer.elapsedMs + delta
  const finished = elapsedMs >= timer.durationMs
  return replaceTimer(state, id, {
    ...timer,
    elapsedMs,
    spentMs: timer.spentMs + (timer.mode === 'focus' ? delta : 0),
    phase: finished ? 'finished' : 'running',
    runningSince: finished ? null : now,
  })
}

export function pauseFocusTimer(state: FocusTimerState, now: number): FocusTimerState {
  const current = advanceFocusTimer(state, now)
  const id = current.selectedTaskId
  if (!id) return current
  const timer = taskTimer(current, id)
  return timer?.phase === 'running'
    ? replaceTimer(current, id, { ...timer, phase: 'paused', runningSince: null })
    : current
}

export function selectFocusTask(state: FocusTimerState, taskId: string, now: number): FocusTimerState {
  if (!taskId || taskId.length > 512) return state
  if (state.selectedTaskId === taskId) return advanceFocusTimer(state, now)
  const current = pauseFocusTimer(state, now)
  const selected = { ...current, selectedTaskId: taskId }
  return taskTimer(current, taskId) ? selected : replaceTimer(selected, taskId, readyTimer(current.durations.focusMin * 60_000))
}

export function startFocusTimer(state: FocusTimerState, now: number): FocusTimerState {
  if (!Number.isFinite(now)) return state
  const current = advanceFocusTimer(state, now)
  const id = current.selectedTaskId
  if (!id) return current
  const timer = taskTimer(current, id)
  if (!timer || (timer.phase !== 'ready' && timer.phase !== 'paused')) return current
  return replaceTimer(current, id, { ...timer, phase: 'running', runningSince: now })
}

export function startFocusRest(state: FocusTimerState, now: number): FocusTimerState {
  if (!Number.isFinite(now)) return state
  const current = advanceFocusTimer(state, now)
  const id = current.selectedTaskId
  if (!id) return current
  const timer = taskTimer(current, id)
  if (!timer || timer.mode !== 'focus' || timer.phase !== 'finished') return current
  return replaceTimer(current, id, { ...timer, mode: 'rest', phase: 'running', elapsedMs: 0, durationMs: current.durations.restMin * 60_000, runningSince: now })
}

export function nextFocusRound(state: FocusTimerState, now: number): FocusTimerState {
  const current = advanceFocusTimer(state, now)
  const id = current.selectedTaskId
  if (!id) return current
  const timer = taskTimer(current, id)
  if (!timer || (timer.mode !== 'rest' && timer.phase !== 'finished')) return current
  return replaceTimer(current, id, readyTimer(current.durations.focusMin * 60_000, timer.spentMs))
}

export function focusTimerSession(state: FocusTimerState): FocusSession | null {
  const taskId = state.selectedTaskId
  if (!taskId) return null
  const timer = taskTimer(state, taskId)
  return timer ? {
    taskId, mode: timer.mode, phase: timer.phase,
    elapsedMs: timer.elapsedMs, remainingMs: timer.durationMs - timer.elapsedMs, spentMs: timer.spentMs, durationMs: timer.durationMs,
  } : null
}

export function taskFocusSpentMs(state: FocusTimerState, taskId: string): number {
  return taskTimer(state, taskId)?.spentMs ?? 0
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const millis = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Reject inconsistent data as a whole instead of silently resuming a different timer. */
export function restoreFocusTimer(raw: string | null, now: number): { state: FocusTimerState; error: string | null } {
  if (raw === null) return { state: createFocusTimerState(), error: null }
  try {
    const value: unknown = JSON.parse(raw)
    if (!object(value) || value.version !== 1 || !object(value.tasks)) throw new Error('invalid state')
    if (!object(value.durations) || !validDurations(value.durations as unknown as FocusDurations)) throw new Error('invalid durations')
    const entries = Object.entries(value.tasks)
    if (entries.length > 10000) throw new Error('too many timers')
    if (value.selectedTaskId !== null && (typeof value.selectedTaskId !== 'string' || !Object.hasOwn(value.tasks, value.selectedTaskId))) throw new Error('invalid selection')
    const tasks: Record<string, TaskTimer> = {}
    for (const [id, timer] of entries) {
      if (!id || id.length > 512 || !object(timer)) throw new Error('invalid task')
      if (timer.mode !== 'focus' && timer.mode !== 'rest') throw new Error('invalid mode')
      if (typeof timer.phase !== 'string' || !['ready', 'running', 'paused', 'finished'].includes(timer.phase)) throw new Error('invalid phase')
      const limit = timer.durationMs
      if (!millis(limit) || (timer.mode === 'focus' ? limit < 5 * 60_000 || limit > 120 * 60_000 || limit % (5 * 60_000) !== 0 : limit < 60_000 || limit > 30 * 60_000 || limit % 60_000 !== 0)) throw new Error('invalid round duration')
      if (!millis(timer.elapsedMs) || timer.elapsedMs > limit || !millis(timer.spentMs) || timer.spentMs > Number.MAX_SAFE_INTEGER - 120 * 60_000) throw new Error('invalid duration')
      if (timer.mode === 'focus' && timer.spentMs < timer.elapsedMs) throw new Error('invalid total')
      if (timer.phase === 'finished' ? timer.elapsedMs !== limit : timer.elapsedMs >= limit) throw new Error('invalid completion')
      if (timer.phase === 'ready' && (timer.elapsedMs !== 0 || timer.mode !== 'focus')) throw new Error('invalid ready state')
      if (timer.phase === 'running') {
        if (id !== value.selectedTaskId || !millis(timer.runningSince)) throw new Error('invalid running timer')
      } else if (timer.runningSince !== null) throw new Error('invalid checkpoint')
      Object.defineProperty(tasks, id, { value: { ...timer } as unknown as TaskTimer, enumerable: true, writable: true, configurable: true })
    }
    return {
      state: advanceFocusTimer({ version: 1, selectedTaskId: value.selectedTaskId as string | null, durations: value.durations as unknown as FocusDurations, tasks }, now),
      error: null,
    }
  } catch {
    return { state: createFocusTimerState(), error: '上次的专注记录无法读取，已重置计时器' }
  }
}
