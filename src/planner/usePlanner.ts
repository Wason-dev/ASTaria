import { useCallback, useEffect, useRef, useState } from 'react'
import { localApi } from '../xixi/api'
import { LOCAL_DATA_CHANGE, notifyLocalDataChange } from '../stores/migration'
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
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const refresh = useCallback(async () => {
    const token = ++revision.current
    setLoading(true)
    try {
      const value = await localApi<PlannerState>('/planner')
      if (!mounted.current || token !== revision.current) return
      current.current = value; setState(value); setError('')
    } catch (reason) {
      if (mounted.current && token === revision.current) setError(reason instanceof Error ? reason.message : '日程暂未读取成功')
    } finally { if (mounted.current && token === revision.current) setLoading(false) }
  }, [])
  useEffect(() => {
    if (!active) return
    void refresh()
    const reload = () => { if (!busy.current) void refresh() }
    const visible = () => { if (document.visibilityState === 'visible') reload() }
    window.addEventListener(LOCAL_DATA_CHANGE, reload)
    window.addEventListener('focus', reload)
    document.addEventListener('visibilitychange', visible)
    return () => { window.removeEventListener(LOCAL_DATA_CHANGE, reload); window.removeEventListener('focus', reload); document.removeEventListener('visibilitychange', visible) }
  }, [active, refresh])
  const act = useCallback(async (action: PlannerAction, expectedRevision?: number) => {
    if (!current.current || busy.current) throw new Error('日程正在读取或保存，请稍候')
    busy.current = true; setSaving(true); ++revision.current
    try {
      const value = await localApi<PlannerState>('/planner', { expectedRevision: expectedRevision ?? current.current.revision, action })
      current.current = value
      if (mounted.current) { setState(value); setError(''); setLoading(false) }
      notifyLocalDataChange()
      return value
    } catch (reason) {
      await refresh()
      throw reason
    } finally { busy.current = false; if (mounted.current) setSaving(false) }
  }, [refresh])
  return { state, loading, saving, error, refresh, act }
}
