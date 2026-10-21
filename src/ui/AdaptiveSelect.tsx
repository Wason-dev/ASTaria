import { createContext, forwardRef, useContext, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject, SelectHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import type { GlassMaterial } from '../home/GlassSurface'
import { FloatingGlassSurface } from './FloatingGlassSurface'
import { glassOverlayExit } from './glassOverlayExit'
import './adaptive-select.css'

type Host = { target: RefObject<HTMLElement | null>; underlayRef?: RefObject<HTMLElement | null>; material?: GlassMaterial; reducedMotion?: boolean; onOpenChange: (open: boolean) => void }
const HostContext = createContext<Host | null>(null)

/** Portal beside the foreground, retaining its original material and context. */
export function AdaptiveSelectHost({ target, underlayRef, material, reducedMotion = false, onOpenChange, children }: Host & { children: ReactNode }) {
  return <HostContext.Provider value={{ target, underlayRef, material, reducedMotion, onOpenChange }}>{children}</HostContext.Provider>
}

type Option = { value: string; label: string; disabled: boolean; selected: boolean; group: string; nativeIndex: number }
type Snapshot = { options: Option[]; label: string; disabled: boolean; value: string }
const EMPTY: Snapshot = { options: [], label: '', disabled: false, value: '' }

/** Native DOM select remains the value, form and change-event authority on both platforms. */
export const AdaptiveSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function AdaptiveSelect(props, forwardedRef) {
  const mobile = Boolean(document.documentElement.dataset.mobile) || import.meta.env.MODE === 'mobile'
  const host = useContext(HostContext)
  const reducedMotion = host?.reducedMotion ?? false
  const id = useId()
  const native = useRef<HTMLSelectElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY)
  const [phase, setPhase] = useState<'closed' | 'entering' | 'open' | 'exiting'>('closed')
  const phaseRef = useRef(phase)
  const open = phase !== 'closed'
  const composing = useRef(false)
  const material = host?.material ?? { transmission: 70, blur: 0, rim: 40, shadow: 30 }
  const [active, setActive] = useState(-1)
  const search = useRef({ text: '', time: 0 })
  const restoreFocus = useRef(false)
  useImperativeHandle(forwardedRef, () => native.current!, [])

  const sync = () => {
    const element = native.current
    if (!element || !mobile) return
    const options = Array.from(element.options).map((option, nativeIndex) => ({ option, nativeIndex })).filter(({ option }) => !option.hidden && !option.parentElement?.hidden).map(({ option, nativeIndex }) => ({
      value: option.value, label: option.label, selected: option.selected,
      nativeIndex,
      disabled: option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
      group: option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : '',
    }))
    const label = Array.from(element.labels ?? []).map(item => {
      const copy = item.cloneNode(true) as HTMLElement
      copy.querySelectorAll('select, button, .adaptive-select').forEach(control => control.remove())
      return copy.textContent?.trim() ?? ''
    }).filter(Boolean).join(' ')
    const next = { options, label, disabled: element.matches(':disabled'), value: element.value }
    setSnapshot(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
  }
  // Read the browser's normalized option/defaultValue semantics, including optgroups.
  useLayoutEffect(sync)
  useLayoutEffect(() => {
    const form = native.current?.form
    let frame = 0
    const reset = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(sync) }
    form?.addEventListener('reset', reset)
    return () => { form?.removeEventListener('reset', reset); cancelAnimationFrame(frame) }
  }, [mobile])
  const close = (restore = true) => {
    if (phaseRef.current === 'closed' || phaseRef.current === 'exiting') return
    restoreFocus.current = restore
    phaseRef.current = 'exiting'; setPhase('exiting')
  }
  useLayoutEffect(() => {
    if (!open && restoreFocus.current && trigger.current && !trigger.current.disabled && !trigger.current.closest('[inert],[hidden]') && trigger.current.getClientRects().length && getComputedStyle(trigger.current).visibility !== 'hidden') {
      trigger.current.focus({ preventScroll: true }); restoreFocus.current = false
    }
  })
  const show = () => {
    if (native.current?.matches(':disabled') || phaseRef.current !== 'closed') return
    sync()
    const selected = snapshot.options.findIndex(option => option.selected && !option.disabled)
    setActive(selected >= 0 ? selected : snapshot.options.findIndex(option => !option.disabled))
    search.current = { text: '', time: 0 }
    composing.current = false
    phaseRef.current = 'entering'; setPhase('entering')
  }
  useLayoutEffect(() => {
    if (!open) return
    const element = dialog.current
    if (!element) return
    const underlay = host?.underlayRef?.current
    const previousInert = underlay?.inert ?? false
    const top = underlay?.scrollTop ?? 0
    host?.onOpenChange(true)
    element.showModal()
    // The existing task-dialog material is a small chooser here, anchored to
    // the original settings control. It never introduces navigation or a page.
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect()
      if (!anchor) return
      const viewport = window.visualViewport
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0
      const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight
      const gap = 6, edge = 16
      element.style.width = `${Math.min(280, Math.max(220, anchor.width), width - edge * 2)}px`
      const below = Math.max(44, top + height - edge - anchor.bottom - gap)
      const above = Math.max(44, anchor.top - top - edge - gap)
      element.style.maxHeight = `${Math.min(360, Math.max(below, above))}px`
      const naturalHeight = element.offsetHeight
      const downward = naturalHeight <= below || below >= above
      element.style.maxHeight = `${Math.min(360, downward ? below : above)}px`
      element.style.left = `${Math.round(Math.max(left + edge, Math.min(anchor.right - element.offsetWidth, left + width - edge - element.offsetWidth)))}px`
      element.style.top = `${Math.round(Math.max(top + edge, Math.min(downward ? anchor.bottom + gap : anchor.top - element.offsetHeight - gap, top + height - edge - element.offsetHeight)))}px`
      element.dataset.placement = downward ? 'below' : 'above'
    }
    place()
    if (underlay) underlay.inert = true
    const reposition = place
    const observer = new ResizeObserver(reposition)
    observer.observe(element)
    if (underlay) observer.observe(underlay)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    window.visualViewport?.addEventListener('resize', reposition)
    window.visualViewport?.addEventListener('scroll', reposition)
    list.current?.focus({ preventScroll: true })
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
      window.visualViewport?.removeEventListener('resize', reposition)
      window.visualViewport?.removeEventListener('scroll', reposition)
      if (underlay) { underlay.inert = previousInert; underlay.scrollTop = top }
      if (element.open) element.close()
      host?.onOpenChange(false)
    }
  }, [open])
  useLayoutEffect(() => {
    const element = dialog.current
    if (!element || (phase !== 'entering' && phase !== 'exiting')) return
    if (phase === 'exiting') return glassOverlayExit(element, () => {
      phaseRef.current = 'closed'; setPhase('closed')
    }, 140)
    let current = true
    const style = getComputedStyle(element)
    // Keep the sampling plane opaque and stationary, as in FloatingGlassDialog.
    // Paint/content animate in CSS; the clock owns only the shell's shadow.
    const animation = reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches ? null : element.animate(
      [{ borderColor: 'transparent', boxShadow: 'none' }, { borderColor: style.borderColor, boxShadow: style.boxShadow }],
      { duration: 180, easing: 'cubic-bezier(.16,.8,.25,1)', fill: 'both' },
    )
    const finish = () => {
      if (!current) return
      animation?.cancel()
      phaseRef.current = 'open'
      setPhase(phaseRef.current)
    }
    if (animation) void animation.finished.then(finish, () => {})
    else finish()
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const reduce = () => { if (media.matches) animation?.finish() }
    media.addEventListener('change', reduce)
    return () => { current = false; animation?.cancel(); media.removeEventListener('change', reduce) }
  }, [phase, reducedMotion])
  useLayoutEffect(() => { if (open && snapshot.disabled) close(false) }, [open, snapshot.disabled])
  useLayoutEffect(() => {
    if (open && active >= 0) list.current?.querySelector<HTMLElement>(`[data-option-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])
  const choose = (index: number) => {
    const element = native.current, option = snapshot.options[index]
    if (phaseRef.current !== 'open' || composing.current || !element || element.matches(':disabled') || !option || option.disabled) return
    const selection = () => Array.from(element.options).flatMap((item, index) => item.selected ? [index] : [])
    const previous = selection()
    if (props.multiple) {
      element.options[option.nativeIndex].selected = !option.selected
    } else element.selectedIndex = option.nativeIndex
    const next = selection()
    if (JSON.stringify(previous) !== JSON.stringify(next)) element.dispatchEvent(new Event('change', { bubbles: true }))
    sync()
    if (!props.multiple) close()
  }
  if (!mobile) return <select {...props} ref={native} />
  const name = props['aria-label'] || snapshot.label || props.title || '选择'
  const selected = snapshot.options.filter(option => option.selected).map(option => option.label).join('、') || snapshot.value || '请选择'
  const move = (direction: number, edge?: 'first' | 'last') => {
    const available = snapshot.options.map((option, index) => !option.disabled ? index : -1).filter(index => index >= 0)
    if (!available.length) return
    const current = available.indexOf(active)
    setActive(edge === 'first' ? available[0] : edge === 'last' ? available.at(-1)! : available[(current + direction + available.length) % available.length])
  }
  return <span className="adaptive-select" data-disabled={snapshot.disabled || props.disabled || undefined}>
    <select {...props} ref={native} className={`${props.className ?? ''} adaptive-select-native`} aria-hidden="true" tabIndex={-1} onFocus={event => {
      props.onFocus?.(event)
      trigger.current?.focus({ preventScroll: true })
    }} onInvalid={event => { props.onInvalid?.(event); event.preventDefault(); trigger.current?.focus(); show() }} />
    <button ref={trigger} type="button" className={`adaptive-select-trigger ${props.className ?? ''}`} style={props.style} disabled={props.disabled || snapshot.disabled}
      tabIndex={props.tabIndex} title={props.title} aria-label={name} aria-labelledby={props['aria-labelledby']} aria-describedby={props['aria-describedby']}
      aria-invalid={props['aria-invalid']} aria-required={props.required || undefined} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-options` : undefined}
      onClick={show} onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); show() } }}>
      <span>{selected}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </button>
    {open && createPortal(<dialog ref={dialog} className="home-task-dialog adaptive-select-dialog" data-phase={phase} data-reduced-motion={reducedMotion} aria-labelledby={`${id}-title`} aria-describedby={props['aria-describedby']} onCancel={event => { event.preventDefault(); if (!composing.current) close() }}
      onClick={event => { if (phaseRef.current === 'open' && event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close() } }}
      onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
      onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
        if (event.key === 'Tab') {
          event.preventDefault()
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [role=listbox]')).filter(element => element.tabIndex >= 0)
          const index = controls.indexOf(document.activeElement as HTMLElement)
          controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus()
        }
      }}>
      <FloatingGlassSurface radius={19} material={material} />
      <div className="adaptive-select-title" id={`${id}-title`}>{name}</div>
      <div ref={list} id={`${id}-options`} className="adaptive-select-options" role="listbox" aria-label={name} aria-multiselectable={props.multiple || undefined} tabIndex={0} aria-activedescendant={active >= 0 ? `${id}-option-${active}` : undefined}
        onKeyDown={event => {
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
          if (phaseRef.current !== 'open') { event.preventDefault(); return }
          if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
            event.preventDefault(); event.stopPropagation()
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') move(event.key === 'ArrowDown' ? 1 : -1)
            else if (event.key === 'Home' || event.key === 'End') move(0, event.key === 'Home' ? 'first' : 'last')
            else choose(active)
          } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.nativeEvent.isComposing) {
            const now = Date.now(), query = (now - search.current.time < 700 ? search.current.text : '') + event.key.toLocaleLowerCase()
            search.current = { text: query, time: now }
            const index = snapshot.options.findIndex(option => !option.disabled && option.label.toLocaleLowerCase().startsWith(query))
            if (index >= 0) setActive(index)
          }
        }}>
        {snapshot.options.map((option, index) => <div key={`${index}:${option.value}`}>
          {option.group && option.group !== snapshot.options[index - 1]?.group && <p className="adaptive-select-group">{option.group}</p>}
          <button id={`${id}-option-${index}`} data-option-index={index} type="button" role="option" aria-selected={option.selected} data-option-disabled={option.disabled || undefined} disabled={option.disabled || phase !== 'open'} tabIndex={-1} data-active={active === index} onPointerMove={() => { if (phaseRef.current === 'open' && !option.disabled) setActive(index) }} onClick={() => choose(index)}>
            <span>{option.label}</span>{option.selected && <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg>}
          </button>
        </div>)}
      </div>
      {props.multiple && <button className="adaptive-select-done" type="button" disabled={phase !== 'open'} onClick={() => close()}>完成</button>}
    </dialog>, host?.target.current ?? document.body)}
  </span>
})
