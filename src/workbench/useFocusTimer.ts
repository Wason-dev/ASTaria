import { useCallback, useEffect, useRef, useState } from 'react'
import {
  advanceFocusTimer, changeFocusDurations, focusTimerSession, nextFocusRound, pauseFocusTimer,
  restoreFocusTimer, selectFocusTask, startFocusRest, startFocusTimer, taskFocusSpentMs,
} from './focusTimer'
import type { FocusDurations, FocusTimerState } from './focusTimer'

function loadTimer(storageKey: string) {
  try {
    return restoreFocusTimer(window.localStorage.getItem(storageKey), Date.now())
  } catch {
    return { ...restoreFocusTimer(null, Date.now()), error: '无法读取本地专注记录，本次仍可正常计时' }
  }
}

/** Mount a separate instance/key for sample previews so they never alter real focus records. */
export function useFocusTimer(storageKey: string) {
  const [initial] = useState(() => loadTimer(storageKey))
  const model = useRef(initial.state)
  const [session, setSession] = useState(() => focusTimerSession(initial.state))
  const [durations, setCurrentDurations] = useState(initial.state.durations)
  const [storageError, setStorageError] = useState<string | null>(initial.error)
  const storageFailed = useRef(false)

  const persist = useCallback((state: FocusTimerState, report = true) => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(state))
      if (storageFailed.current && report) setStorageError(null)
      storageFailed.current = false
    } catch {
      storageFailed.current = true
      if (report) setStorageError('专注进度暂时无法保存，关闭页面后可能丢失')
    }
  }, [storageKey])

  const commit = useCallback((next: FocusTimerState, save = true) => {
    if (next !== model.current) {
      model.current = next
      setSession(focusTimerSession(next))
      setCurrentDurations(next.durations)
    }
    if (save) persist(next)
  }, [persist])

  useEffect(() => {
    // Keep the in-memory timer during StrictMode effect replay; an actual unmount
    // saves a paused checkpoint without leaving a background interval alive.
    model.current = advanceFocusTimer(model.current, Date.now())
    setSession(focusTimerSession(model.current))
    setCurrentDurations(model.current.durations)
    persist(model.current)
    const tick = () => {
      const before = model.current
      const next = advanceFocusTimer(before, Date.now())
      const finished = focusTimerSession(before)?.phase === 'running' && focusTimerSession(next)?.phase === 'finished'
      commit(next, finished)
    }
    const checkpoint = () => commit(advanceFocusTimer(model.current, Date.now()))
    const interval = window.setInterval(tick, 250)
    document.addEventListener('visibilitychange', checkpoint)
    window.addEventListener('pagehide', checkpoint)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', checkpoint)
      window.removeEventListener('pagehide', checkpoint)
      persist(pauseFocusTimer(model.current, Date.now()), false)
    }
  }, [commit, persist])

  const selectTask = useCallback((taskId: string) => commit(selectFocusTask(model.current, taskId, Date.now())), [commit])
  const start = useCallback(() => commit(startFocusTimer(model.current, Date.now())), [commit])
  const pause = useCallback(() => commit(pauseFocusTimer(model.current, Date.now())), [commit])
  const startRest = useCallback(() => commit(startFocusRest(model.current, Date.now())), [commit])
  const nextFocus = useCallback(() => commit(nextFocusRound(model.current, Date.now())), [commit])
  const getSpentMs = useCallback((taskId: string) => taskFocusSpentMs(advanceFocusTimer(model.current, Date.now()), taskId), [])
  const setDurations = useCallback((next: FocusDurations) => commit(changeFocusDurations(model.current, next)), [commit])

  return { session, selectTask, start, pause, startRest, nextFocus, getSpentMs, durations, setDurations, storageError }
}
