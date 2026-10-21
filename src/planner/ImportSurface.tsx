import { useContext, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { ComponentPropsWithoutRef, ReactNode, Ref } from 'react'
import { GlassRenderingContext, GlassSamplingContext, MeasuredGlassSurface } from '../home/GlassSurface'
import { usePreferences } from '../xixi/preferences'
import './import-surface.css'

export type ImportSurfaceHandle = { close: () => void }
/** Keep the parent's foreground covered until onClose (after exit), including
 * while onSaved refreshes data. Never hide the root containing this dialog.
 * onOpenChange is optional: parents can instead derive coverage from mount state.
 * Mark foreground siblings data-import-underlay + data-import-covered=true. */
export type ImportSurfaceParentProps = { onOpenChange?: (open: boolean) => void }
type Props = Omit<ComponentPropsWithoutRef<'dialog'>, 'children' | 'onClose' | 'onCancel'> & ImportSurfaceParentProps & {
  surfaceRef?: Ref<ImportSurfaceHandle>; onClose: () => void; closeDisabled: boolean
  beforeClose?: () => void; onEscape?: () => boolean; children: ReactNode
}

export function ImportSurface({ surfaceRef, onClose, closeDisabled, beforeClose, onEscape, onOpenChange, className = '', children, ...props }: Props) {
  const { value: preferences } = usePreferences()
  const dialog = useRef<HTMLDialogElement>(null)
  const closingRef = useRef(false), closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const latest = useRef({ onClose, closeDisabled, beforeClose, onEscape, onOpenChange })
  latest.current = { onClose, closeDisabled, beforeClose, onEscape, onOpenChange }
  const [closing, setClosing] = useState(false)
  const reduced = preferences.effect.motion === 'reduced'
  useLayoutEffect(() => {
    const element = dialog.current!, opener = document.activeElement
    latest.current.onOpenChange?.(true)
    element.showModal()
    element.querySelector<HTMLElement>('[data-import-autofocus]')?.focus({ preventScroll: true })
    const body = element.querySelector<HTMLElement>('.import-body')
    const keepEditorVisible = () => {
      const editor = document.activeElement
      if (!body || !(editor instanceof HTMLElement) || !element.contains(editor) || !editor.matches('input:not([type=file]),textarea,[contenteditable=true]')) return
      const frame = body.getBoundingClientRect(), rect = editor.getBoundingClientRect()
      // Only scroll this foreground. The scene/layout viewport stays fixed when
      // the parent's --m-visible-height changes for the software keyboard.
      if (rect.bottom > frame.bottom - 12) body.scrollTop += rect.bottom - frame.bottom + 12
      else if (rect.top < frame.top + 12) body.scrollTop -= frame.top + 12 - rect.top
    }
    const observer = new ResizeObserver(keepEditorVisible)
    if (body) observer.observe(body)
    element.addEventListener('focusin', keepEditorVisible)
    return () => {
      observer.disconnect()
      element.removeEventListener('focusin', keepEditorVisible)
      clearTimeout(closeTimer.current)
      element.close()
      latest.current.onOpenChange?.(false)
      // Parent coverage is removed in the same commit. Restore focus afterward.
      queueMicrotask(() => {
        if (opener instanceof HTMLElement && opener.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true })
      })
    }
  }, [])
  const close = () => {
    if (latest.current.closeDisabled || closingRef.current) return
    closingRef.current = true
    latest.current.beforeClose?.()
    setClosing(true)
    const duration = reduced || matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180
    closeTimer.current = setTimeout(() => latest.current.onClose(), duration)
  }
  useImperativeHandle(surfaceRef, () => ({ close }))
  return <GlassRenderingContext.Provider value={preferences.render.glass}><GlassSamplingContext.Provider value={!closing}>
    <dialog {...props} ref={dialog} className={`import-surface ${className}`} data-theme={preferences.theme} data-glass={preferences.glass}
      data-density={preferences.density} data-reduced-motion={reduced} data-closing={closing} data-import-surface=""
      onCancel={event => { event.preventDefault(); if (!latest.current.onEscape?.()) close() }} onKeyDown={event => event.stopPropagation()}>
      <MeasuredGlassSurface radius={22} material={{ transmission: preferences.theme === 'light' ? preferences.glass === 'soft' ? 14 : 18 : preferences.glass === 'soft' ? 24 : 30, blur: preferences.glass === 'soft' ? 6 : 0, rim: 44, shadow: 30, reflection: 0 }} />
      <div className="import-surface-content" inert={closing}>{children}</div>
    </dialog>
  </GlassSamplingContext.Provider></GlassRenderingContext.Provider>
}

/** Only the active step mounts. Retain its last render during the short exit;
 * inputs within a step keep their DOM/focus while their values are edited. */
export function ImportStep({ step, children }: { step: string; children: ReactNode }) {
  const { value: preferences } = usePreferences()
  const [shown, setShown] = useState(step)
  const body = useRef<HTMLDivElement>(null), previous = useRef(children), first = useRef(true)
  const sampling = useContext(GlassSamplingContext)
  const changing = shown !== step
  useLayoutEffect(() => { if (!changing) previous.current = children }, [children, changing])
  useLayoutEffect(() => {
    if (!changing) return
    const duration = preferences.effect.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 100
    const timer = setTimeout(() => setShown(step), duration)
    return () => clearTimeout(timer)
  }, [step, changing, preferences.effect.motion])
  useLayoutEffect(() => {
    if (first.current) { first.current = false; return }
    const element = body.current
    if (!element || !sampling) return
    element.closest('.import-body')?.scrollTo({ top: 0 })
    element.querySelector<HTMLElement>('[data-step-heading]')?.focus({ preventScroll: true })
  }, [shown, sampling])
  return <div key={shown} ref={body} className="import-step" data-leaving={changing} inert={changing}>
    {changing ? previous.current : children}
  </div>
}

export function ImportCloseIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7" /></svg>
}

export function ImportBackIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m9.5 3.5-4.5 4.5 4.5 4.5" /></svg>
}

export function ImportFileIcon() {
  return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M19 4H8a2 2 0 0 0-2 2v20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V11ZM19 4v7h7M11 17h10M11 22h6" /></svg>
}

/** A small product listbox, rather than an OS select menu. Its options stay in
 * the current editor, so the body's single scroll also brings them into view. */
export function ImportSelect({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false)
  const id = useId(), host = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null)
  return <div className="import-select" ref={host} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    <span className="import-field-label" id={`${id}-label`}>{label}</span>
    <button ref={trigger} type="button" aria-labelledby={`${id}-label ${id}-value`} aria-haspopup="listbox" aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(current => !current)} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); requestAnimationFrame(() => host.current?.querySelector<HTMLElement>('[aria-selected=true]')?.focus()) } }}>
      <span id={`${id}-value`}>{options.find(option => option.value === value)?.label ?? '待补'}</span><span aria-hidden="true">⌄</span>
    </button>
    {open && <div id={id} className="import-select-options" role="listbox" aria-labelledby={`${id}-label`} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=option]')]
      const current = items.indexOf(document.activeElement as HTMLButtonElement)
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    }}>{options.map(option => <button key={option.value} type="button" role="option" aria-selected={option.value === value} onClick={() => { onChange(option.value); setOpen(false); trigger.current?.focus() }}>{option.label}</button>)}</div>}
  </div>
}
