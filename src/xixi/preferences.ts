import { useCallback, useEffect, useRef, useState } from 'react'
import { localApi } from './api'
import type { ResponseEffectSettings } from '../prototype/responseEffects'
import type { RenderProfile } from '../prototype/renderProfile'

export type Preferences = {
  version: 1; startupPage: 'home' | 'workbench' | 'schedule' | 'companion'; theme: 'dark' | 'light'; grid: boolean
  glass: 'clear' | 'soft'; density: 'compact' | 'comfortable'; effect: ResponseEffectSettings
  render: { profile: RenderProfile }
  assistant: { autonomy: 'act' | 'propose'; useMemory: boolean; useHistory: boolean }
  notifications: { enabled: boolean; quietStart: string; quietEnd: string; opportunities: boolean }
  focus: { focusMin: number; restMin: number }; scheduling: { bufferMin: number }
}
export const DEFAULT_PREFERENCES: Preferences = {
  version: 1, startupPage: 'home', theme: 'dark', grid: true, glass: 'clear', density: 'compact',
  effect: { style: 'tide', intensity: 'gentle', motion: 'system' }, render: { profile: 'full' },
  assistant: { autonomy: 'act', useMemory: true, useHistory: true },
  notifications: { enabled: true, quietStart: '23:00', quietEnd: '08:00', opportunities: true },
  focus: { focusMin: 35, restMin: 5 }, scheduling: { bufferMin: 10 },
}
export const PREFERENCE_CHANGE = 'astaria-preferences-change'
export function publishPreferences(value: Preferences) { window.dispatchEvent(new CustomEvent(PREFERENCE_CHANGE, { detail: value })) }
export function usePreferences() {
  const [value, setValue] = useState<Preferences>(DEFAULT_PREFERENCES)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const revision = useRef(0)
  const refresh = useCallback(async () => {
    const current = ++revision.current
    try { const next = await localApi<Preferences>('/preferences'); if (mounted.current && current === revision.current) { setValue(next); setLoaded(true); setError('') } }
    catch (reason) { if (mounted.current && current === revision.current) setError(reason instanceof Error ? reason.message : '暂时无法读取设置') }
  }, [])
  useEffect(() => {
    mounted.current = true
    void refresh()
    const changed = (event: Event) => { revision.current++; setValue((event as CustomEvent<Preferences>).detail); setLoaded(true) }
    const visible = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener(PREFERENCE_CHANGE, changed)
    document.addEventListener('visibilitychange', visible)
    const poll = window.setInterval(visible, 15000)
    return () => { mounted.current = false; revision.current++; clearInterval(poll); window.removeEventListener(PREFERENCE_CHANGE, changed); document.removeEventListener('visibilitychange', visible) }
  }, [refresh])
  return { value, loaded, error, refresh }
}

export function notificationsAllowed(value: Preferences['notifications'], now: Date) {
  if (!value.enabled) return false
  const minute = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  if (value.quietStart === value.quietEnd) return true
  return value.quietStart < value.quietEnd ? !(minute >= value.quietStart && minute < value.quietEnd) : !(minute >= value.quietStart || minute < value.quietEnd)
}
