import { useSyncExternalStore } from 'react'
import { localApi } from './api'
import type { ResponseEffectSettings } from '../prototype/responseEffects'
import { normalizeResponseEffect } from '../prototype/responseEffects'
import type { RenderProfile } from '../prototype/renderProfile'
import { createPreferencesStore } from './preferencesStore.ts'

export type Preferences = {
  version: 1; startupPage: 'home' | 'workbench' | 'schedule' | 'companion'; theme: 'dark' | 'light'; grid: boolean
  glass: 'clear' | 'soft'; density: 'compact' | 'comfortable'; cardEdges: 'both' | 'left' | 'none'; effect: ResponseEffectSettings
  render: { profile: RenderProfile; quality: 'auto' | 'ultra' | 'high' | 'low' | 'safe'; glass: 'auto' | 'detailed' }
  assistant: { autonomy: 'act' | 'propose'; personality: 'low' | 'medium' | 'high'; useMemory: boolean; useHistory: boolean }
  notifications: { enabled: boolean; quietStart: string; quietEnd: string; opportunities: boolean }
  focus: { focusMin: number; restMin: number }; scheduling: { bufferMin: number }
}
export const DEFAULT_PREFERENCES: Preferences = {
  version: 1, startupPage: 'home', theme: 'dark', grid: true, glass: 'clear', density: 'compact', cardEdges: 'both',
  effect: normalizeResponseEffect(undefined), render: { profile: 'full', quality: 'auto', glass: 'auto' },
  assistant: { autonomy: 'act', personality: 'medium', useMemory: true, useHistory: true },
  notifications: { enabled: true, quietStart: '23:00', quietEnd: '08:00', opportunities: true },
  focus: { focusMin: 35, restMin: 5 }, scheduling: { bufferMin: 10 },
}
export const PREFERENCE_CHANGE = 'astaria-preferences-change'
const preferencesStore = createPreferencesStore({
  initialValue: DEFAULT_PREFERENCES,
  read: () => localApi<Preferences>('/preferences'),
  isVisible: () => document.visibilityState === 'visible',
  onVisibilityChange: listener => {
    document.addEventListener('visibilitychange', listener)
    return () => document.removeEventListener('visibilitychange', listener)
  },
  onPublish: listener => {
    const changed = (event: Event) => listener((event as CustomEvent<Preferences>).detail)
    window.addEventListener(PREFERENCE_CHANGE, changed)
    return () => window.removeEventListener(PREFERENCE_CHANGE, changed)
  },
  setTimer: (listener, delay) => window.setTimeout(listener, delay),
  clearTimer: timer => window.clearTimeout(timer),
})
export function publishPreferences(value: Preferences) {
  // Keep the cache current even while no settings consumers are mounted.
  preferencesStore.publish(value)
  window.dispatchEvent(new CustomEvent(PREFERENCE_CHANGE, { detail: value }))
}
export function usePreferences() {
  const snapshot = useSyncExternalStore(preferencesStore.subscribe, preferencesStore.getSnapshot, preferencesStore.getSnapshot)
  return { ...snapshot, refresh: preferencesStore.refresh }
}

let focusWrite = Promise.resolve()
/** Serialize slider writes and preserve unrelated preferences changed elsewhere. */
export function saveFocusPreferences(focus: Preferences['focus']): Promise<Preferences> {
  const write = focusWrite.then(async () => {
    const expected = await localApi<Preferences>('/preferences')
    const saved = await localApi<Preferences>('/preferences', { expected, value: { ...expected, focus } })
    publishPreferences(saved)
    return saved
  })
  focusWrite = write.then(() => {}, () => {})
  return write
}

export function notificationsAllowed(value: Preferences['notifications'], now: Date) {
  if (!value.enabled) return false
  const minute = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  if (value.quietStart === value.quietEnd) return true
  return value.quietStart < value.quietEnd ? !(minute >= value.quietStart && minute < value.quietEnd) : !(minute >= value.quietStart || minute < value.quietEnd)
}
