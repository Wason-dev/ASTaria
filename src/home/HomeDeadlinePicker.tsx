import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

type Draft = { owner: string; title: string; date: string; time: string; busy: boolean; token: number }
type Picker = {
  draft: Draft | null
  presentedDraft: Draft | null
  host: HTMLDivElement | null
  setHost: (node: HTMLDivElement | null) => void
  open: (value: Omit<Draft, 'token' | 'busy'>, trigger: HTMLButtonElement | null) => void
  update: (owner: string, patch: Partial<Pick<Draft, 'date' | 'time' | 'busy'>>) => void
  close: (owner: string, restoreFocus?: boolean) => void
  isCurrent: (owner: string, token: number) => boolean
}
const Context = createContext<Picker | null>(null)
export const useHomeDeadlinePicker = () => useContext(Context)

/** One temporary editor shared by the receipt and the existing home calendar.
 * The form is portalled from its receipt, keeping persistence and version checks
 * with the task that owns them. Selecting a day never writes to the database. */
export function HomeDeadlinePicker({ children, active, conversationId, onOpen, onClose }: {
  children: ReactNode; active: boolean; conversationId?: string; onOpen: () => void; onClose: () => void
}) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [presentedDraft, setPresentedDraft] = useState<Draft | null>(null)
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const current = useRef(draft)
  const sequence = useRef(0)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const departure = useRef<{ owner: string; token: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const focusFrame = useRef(0)
  const available = useRef(active)
  available.current = active
  const callbacks = useRef({ onOpen, onClose })
  callbacks.current = { onOpen, onClose }
  const update = useCallback<Picker['update']>((owner, patch) => {
    if (current.current?.owner !== owner) return
    current.current = { ...current.current, ...patch }
    setDraft(current.current)
    setPresentedDraft(current.current)
  }, [])
  const clearDeparture = useCallback(() => {
    if (departure.current) clearTimeout(departure.current.timer)
    departure.current = null
    cancelAnimationFrame(focusFrame.current)
  }, [])
  const close = useCallback<Picker['close']>((owner, restoreFocus = true) => {
    const closing = current.current
    if (closing?.owner !== owner) {
      // The receipt can disappear after it has already begun leaving.
      if (!restoreFocus && departure.current?.owner === owner) {
        clearDeparture()
        setPresentedDraft(null)
      }
      return
    }
    clearDeparture()
    current.current = null
    setDraft(null)
    if (!restoreFocus) { setPresentedDraft(null); return }
    const opener = trigger.current
    const closingFocus = document.activeElement
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || opener?.closest('[data-motion="reduced"]')
    // Keep the portal's last frame while CSS collapses it. Editing permission is
    // already gone, and a new open cancels this departure before taking over.
    const timer = setTimeout(() => {
      if (departure.current?.token !== closing.token) return
      departure.current = null
      setPresentedDraft(null)
      callbacks.current.onClose()
      focusFrame.current = requestAnimationFrame(() => {
        const focused = document.activeElement
        const focusWasReleased = !focused || focused === document.body || focused === closingFocus || focused.closest('[inert]')
        if (focusWasReleased && !current.current && available.current && opener?.isConnected && !opener.disabled && !opener.closest('[inert]')) opener.focus({ preventScroll: true })
      })
    }, reduced ? 100 : 360)
    departure.current = { owner, token: closing.token, timer }
  }, [clearDeparture])
  const open = useCallback<Picker['open']>((value, opener) => {
    if (!available.current || current.current?.busy) return
    clearDeparture()
    trigger.current = opener
    current.current = { ...value, busy: false, token: ++sequence.current }
    setDraft(current.current)
    setPresentedDraft(current.current)
    callbacks.current.onOpen()
  }, [clearDeparture])
  const isCurrent = useCallback<Picker['isCurrent']>((owner, token) => current.current?.owner === owner && current.current.token === token, [])
  useEffect(() => {
    if (active) return
    clearDeparture()
    current.current = null
    setDraft(null)
    setPresentedDraft(null)
  }, [active, clearDeparture])
  useEffect(() => {
    clearDeparture()
    current.current = null
    setDraft(null)
    setPresentedDraft(null)
  }, [conversationId, clearDeparture])
  useEffect(() => clearDeparture, [clearDeparture])
  return <Context value={{ draft, presentedDraft, host, setHost, open, update, close, isCurrent }}>{children}</Context>
}
