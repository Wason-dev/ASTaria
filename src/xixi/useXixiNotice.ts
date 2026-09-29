import { useEffect, useRef, useState } from 'react'
import { localApi } from './api'
import type { Operation } from './types'
import type { CompanionState } from './companionTypes'
import type { Preferences } from './preferences'
import { notificationsAllowed } from './preferences'
import { localDay } from '../home/agenda'
import { LOCAL_DATA_CHANGE } from '../stores/migration'
import { startVisiblePolling } from '../stores/visiblePolling'

/** Uses saved actions and explicit calendar conditions; never invents an AI reply. */
export function useXixiNotice(preferences: Preferences, enabled: boolean) {
  const [notice, setNotice] = useState('')
  const generation = useRef(0)
  useEffect(() => {
    if (!enabled) return
    let live = true
    const refresh = async () => {
      const now = new Date(), current = ++generation.current
      if (document.visibilityState !== 'visible' || !notificationsAllowed(preferences.notifications, now)) { setNotice(''); return }
      try {
        const operations = await localApi<Operation[]>('/operations')
        if (!live || generation.current !== current) return
        const unread = operations.find(item => !item.readAt && !item.undoneAt)
        if (unread) { setNotice(`有未读变更 · ${unread.summary}`); return }
        if (!preferences.notifications.opportunities) { setNotice(''); return }
        const state = await localApi<CompanionState>(`/companion?date=${localDay(now)}&days=1`)
        if (!live || generation.current !== current) return
        const minute = now.getHours() * 60 + now.getMinutes()
        const opportunity = state.opportunities.find(item => item.kind === 'carry' || (item.start && Number(item.start.slice(0, 2)) * 60 + Number(item.start.slice(3)) - minute <= 60))
        setNotice(opportunity ? `${opportunity.kind === 'carry' ? '出门前看看' : '有空时可以考虑'} · ${opportunity.title}` : '')
      } catch { /* An unavailable service must not manufacture a notification. */ }
    }
    const stopPolling = startVisiblePolling(() => void refresh(), 60000)
    const change = () => void refresh()
    const hide = () => { if (document.hidden) { generation.current++; setNotice('') } }
    window.addEventListener(LOCAL_DATA_CHANGE, change); document.addEventListener('visibilitychange', hide)
    return () => { live = false; generation.current++; stopPolling(); window.removeEventListener(LOCAL_DATA_CHANGE, change); document.removeEventListener('visibilitychange', hide) }
  }, [preferences.notifications.enabled, preferences.notifications.opportunities, preferences.notifications.quietStart, preferences.notifications.quietEnd, enabled])
  return notice
}
