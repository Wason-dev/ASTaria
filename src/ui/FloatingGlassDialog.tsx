import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { GlassRenderingContext, GlassSamplingContext } from '../home/GlassSurface'
import { HOME_GLASS } from '../home/glass'
import { usePreferences } from '../xixi/preferences'
import { glassOverlayExit } from './glassOverlayExit'
import { FloatingGlassSurface } from './FloatingGlassSurface'
import { useGlassHover } from '../workbench/useGlassHover'
import './floating-glass-dialog.css'

type Props = {
  anchor: HTMLElement; id?: string; title: string; label?: string; onClose: () => void; children: ReactNode
  className?: string; contentClassName?: string; width?: number; maxHeight?: number
  placement?: 'above' | 'below' | 'center'; align?: 'start' | 'end'
  busy?: boolean; closeRequested?: boolean; onEscape?: () => boolean
}

/** Task-detail glass and dimmed modal backdrop, with anchored/centred sizing.
 * Keep the source page visible and optically unchanged behind the popup. */
export function FloatingGlassDialog({ anchor, id, title, label = title, onClose, children, className = '', contentClassName = '', width: preferredWidth = 272, maxHeight = Infinity, placement = 'above', align = 'start', busy = false, closeRequested = false, onEscape }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)
  const hover = useGlassHover(!closing, '.floating-glass-dialog')
  const latest = useRef({ onClose, busy, onEscape })
  latest.current = { onClose, busy, onEscape }
  const { value: preferences } = usePreferences()
  const portal = anchor.closest<HTMLElement>('.home-workspace') ?? anchor.closest<HTMLElement>('.p0') ?? document.body
  useLayoutEffect(() => {
    const element = dialog.current!
    let anchorBox = anchor.getBoundingClientRect()
    element.showModal()
    const place = () => {
      // Saving can remove the original error/action row before this dialog's
      // exit finishes. Keep its last real anchor rather than jumping to (0,0).
      const nextBox = anchor.getBoundingClientRect()
      if (anchor.isConnected && nextBox.width && nextBox.height) anchorBox = nextBox
      const box = anchorBox, view = window.visualViewport
      const x = view?.offsetLeft ?? 0, y = view?.offsetTop ?? 0, width = view?.width ?? innerWidth, height = view?.height ?? innerHeight
      const snap = (value: number) => Math.round(value * devicePixelRatio) / devicePixelRatio
      element.style.width = `${Math.floor(Math.min(preferredWidth, width - 32) * devicePixelRatio) / devicePixelRatio}px`
      element.style.maxHeight = `${Math.floor(Math.min(maxHeight, height - 32) * devicePixelRatio) / devicePixelRatio}px`
      element.style.height = 'auto'
      element.style.height = `${Math.ceil(element.getBoundingClientRect().height * devicePixelRatio) / devicePixelRatio}px`
      const panelHeight = element.getBoundingClientRect().height
      const left = placement === 'center' ? x + (width - element.offsetWidth) / 2 : align === 'end' ? box.right - element.offsetWidth : box.left
      const top = placement === 'center' ? y + (height - panelHeight) / 2 : placement === 'below' ? box.bottom + 8 : box.top - panelHeight - 8
      element.style.left = `${snap(Math.max(x + 16, Math.min(left, x + width - element.offsetWidth - 16)))}px`
      element.style.top = `${snap(Math.max(y + 16, Math.min(top, y + height - panelHeight - 16)))}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(element)
    // Topics arrive after the first layout; the explicit pixel-aligned height
    // must be measured again when loading, rename or confirmation changes it.
    const content = element.querySelector('.floating-glass-content')!
    const contentObserver = new MutationObserver(place)
    contentObserver.observe(content, { childList: true, subtree: true, characterData: true })
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    window.visualViewport?.addEventListener('resize', place); window.visualViewport?.addEventListener('scroll', place)
    return () => {
      observer.disconnect(); contentObserver.disconnect()
      window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true)
      window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place)
      element.close()
      if (anchor.isConnected && !anchor.closest('[inert]')) anchor.focus({ preventScroll: true })
    }
  }, [anchor, preferredWidth, maxHeight, placement, align])
  useLayoutEffect(() => {
    if (!closing || !dialog.current) return
    return glassOverlayExit(dialog.current, () => latest.current.onClose())
  }, [closing])
  const close = () => {
    if (latest.current.busy || closingRef.current) return
    closingRef.current = true
    setClosing(true)
  }
  useLayoutEffect(() => { if (closeRequested && !busy) close() }, [closeRequested, busy])
  return createPortal(<GlassRenderingContext.Provider value={preferences.render.glass}><GlassSamplingContext.Provider value>
    <dialog ref={dialog} {...hover} id={id} className={`home-task-dialog floating-glass-dialog ${className}`} data-layered-exit="true" data-closing={closing} data-theme={preferences.theme} data-reduced-motion={preferences.effect.motion === 'reduced'} aria-label={label}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!latest.current.onEscape?.()) close() }} onKeyDown={event => event.stopPropagation()}
      onClick={event => { if (event.target === event.currentTarget) { const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close() } }}>
      <FloatingGlassSurface radius={19} material={{ transmission: HOME_GLASS.pillTransmission, blur: preferences.glass === 'soft' ? 6 : HOME_GLASS.blur, rim: HOME_GLASS.rim, shadow: HOME_GLASS.shadow, reflection: HOME_GLASS.reflection }} />
      <div className={`home-task-content floating-glass-content ${contentClassName}`} inert={closing}>
        <header><h2>{title}</h2><button type="button" className="home-task-close" disabled={busy || closing} aria-label={`关闭${label}`} onClick={close}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7" /></svg></button></header>
        {children}
      </div>
    </dialog>
  </GlassSamplingContext.Provider></GlassRenderingContext.Provider>, portal)
}
