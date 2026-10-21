import { useCallback, useEffect, useRef, useState } from 'react'
import { localApi } from '../xixi/api'
import { LOCAL_DATA_CHANGE, notifyLocalDataChange } from '../stores/migration'
import { sameSnapshot } from '../stores/sameSnapshot'
import type { PlannerAction, PlannerState } from './types'

export function usePlanner(active: boolean) {
  const [state, setState] = useState<PlannerState | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const current = useRef<PlannerState | null>(null)
  const busy = useRef(false)
  const revision = useRef(0)
  const mounted = useRef(false)
  const queuedReads = useRef<((refreshed: boolean) => void)[]>([])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false; ++revision.current
      queuedReads.current.splice(0).forEach(resolve => resolve(false))
    }
  }, [])
  const refresh = useCallback(async (): Promise<boolean> => {
    if (!mounted.current) return false
    // All entry points, including reactivation, wait for the current write.
    // A GET started during a save could otherwise overwrite its POST result.
    if (busy.current) return new Promise(resolve => queuedReads.current.push(resolve))
    const token = ++revision.current
    if (!current.current) setLoading(true)
    try {
      const value = await localApi<PlannerState>('/planner')
      if (!mounted.current || token !== revision.current) return false
      // Completion history can change at the same planner revision. Compare
      // the whole projection, while retaining identity for a true no-op read.
      if (!sameSnapshot(current.current, value)) { current.current = value; setState(value) }
      setError('')
      return true
    } catch (reason) {
      if (mounted.current && token === revision.current) setError(reason instanceof Error ? reason.message : '日程暂未读取成功')
      return false
    } finally { if (mounted.current && token === revision.current) setLoading(false) }
  }, [])
  useEffect(() => {
    if (!active) return
    void refresh()
    const reload = () => { void refresh() }
    const visible = () => { if (document.visibilityState === 'visible') reload() }
    window.addEventListener(LOCAL_DATA_CHANGE, reload)
    window.addEventListener('focus', reload)
    document.addEventListener('visibilitychange', visible)
    return () => {
      ++revision.current; setLoading(false)
      window.removeEventListener(LOCAL_DATA_CHANGE, reload); window.removeEventListener('focus', reload); document.removeEventListener('visibilitychange', visible)
    }
  }, [active, refresh])
  const act = useCallback(async (action: PlannerAction, expectedRevision?: number) => {
    if (!current.current || busy.current) throw new Error('日程正在读取或保存，请稍候')
    busy.current = true; setSaving(true); ++revision.current
    let recover = false
    try {
      const value = await localApi<PlannerState>('/planner', { expectedRevision: expectedRevision ?? current.current.revision, action })
      current.current = value
      if (mounted.current) { setState(value); setError(''); setLoading(false) }
      notifyLocalDataChange()
      return value
    } catch (reason) {
      recover = true
      throw reason
    } finally {
      busy.current = false
      if (mounted.current) setSaving(false)
      const waiting = queuedReads.current.splice(0)
      // Release the write guard before recovery; a failed save must not wait
      // on its own guard. Coalesce all queued refreshes into one fresh read.
      if (recover || waiting.length) {
        const refreshed = await refresh()
        waiting.forEach(resolve => resolve(refreshed))
      }
    }
  }, [refresh])
  return { state, loading, saving, error, refresh, act }
}
