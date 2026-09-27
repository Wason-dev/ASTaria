import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { localDay } from '../home/agenda'
import { MeasuredGlassSurface } from '../home/GlassSurface'
import { setStringFlight } from '../prototype/stringFlight'
import { notifyLocalDataChange } from '../stores/migration'
import { LocalApiError, localApi } from './api'
import { usePreferences } from './preferences'
import type { Preferences } from './preferences'
import { StringCanvas } from './stringCanvas'
import type { StringPoint, StringVisualState } from './stringCanvas'
import { arrangeStringItems, moveStringItem, stringGeometry } from './stringOrder'
import type { StringItem, StringResult, StringSnapshot } from './stringOrder'
import { STRING_STYLES, readStringStyle, saveStringStyle, stringRowY } from './stringStyles'
import type { StringStyle } from './stringStyles'
import './string-studio.css'

type Props = { onReveal: () => void; onClose: () => void; onSaved: (message: string) => void }
type Selection = { id: string; row: 0 | 1 }
type Grab = { id: string; pointerId: number; x: number; y: number; pointerX: number; pointerY: number; offsetX: number; offsetY: number; startX: number; moved: boolean; original: string[] }
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
const describeError = (reason: unknown) => reason instanceof Error ? reason.message : '暂时没有完成，请重试'

export function StringStudio({ onReveal, onClose, onSaved }: Props) {
  const element = useRef<HTMLDialogElement>(null), canvas = useRef<HTMLCanvasElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const engine = useRef<StringCanvas | null>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const points = useRef(new Map<string, StringPoint>()), lastPlacement = useRef(0)
  const flight = useRef(0), animation = useRef(0), leaving = useRef(false), revealed = useRef(false)
  const grab = useRef<Grab | null>(null), pan = useRef<{ x: number; scroll: number; pointerId: number } | null>(null)
  const callbacks = useRef({ onReveal, onClose, onSaved }); callbacks.current = { onReveal, onClose, onSaved }
  const mounted = useRef(true), operation = useRef(crypto.randomUUID()), saving = useRef(false)
  const [snapshot, setSnapshot] = useState<StringSnapshot | null>(null)
  const [order, setOrder] = useState<string[]>([]), orderRef = useRef(order)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [style, setStyle] = useState<StringStyle>(readStringStyle)
  const [reordering, setReordering] = useState(false), [scrollPosition, setScrollPosition] = useState(0)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [refreshNeeded, setRefreshNeeded] = useState(false), [phase, setPhase] = useState('entering')
  const [size, setSize] = useState({ width: innerWidth, height: innerHeight })
  const [hint, setHint] = useState(true), [announcement, setAnnouncement] = useState('')
  const preferences = usePreferences().value
  const reduced = preferences.effect.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches
  const visual = useRef<StringVisualState>({ upper: [], lower: [], scroll: 0, reveal: 0, pointer: null, hover: null, grabbed: null, reduced, busy, style })
  orderRef.current = order
  visual.current.upper = snapshot?.items ?? []
  visual.current.lower = arrangeStringItems(snapshot?.items ?? [], order)
  visual.current.hover = selection?.id ?? null; visual.current.reduced = reduced; visual.current.busy = busy
  visual.current.style = style
  const geometry = stringGeometry(size.width, snapshot?.items.length ?? 0)

  const refresh = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const next = await localApi<StringSnapshot>(`/companion/string-order?date=${localDay(new Date())}`)
      if (!mounted.current) return
      setSnapshot(next); setOrder(next.items.filter(item => item.movable).map(item => item.id))
      operation.current = crypto.randomUUID(); setRefreshNeeded(false); setSelection(null)
    } catch (reason) { if (mounted.current) setError(describeError(reason)) }
    finally { if (mounted.current) setLoading(false) }
  }, [])

  const travel = useCallback((exit = false) => {
    cancelAnimationFrame(animation.current)
    const from = flight.current, started = performance.now()
    const reducedMotion = visual.current.reduced
    const duration = reducedMotion ? 160 : exit ? Math.max(300, 2100 * from) : 3400
    const tick = (now: number) => {
      const fraction = Math.min(1, (now - started) / duration)
      const next = exit ? from * (1 - fraction) : from + (1 - from) * fraction
      flight.current = next; setStringFlight(next)
      const darkness = smooth(.59, .85, next), reveal = smooth(.76, .99, next)
      element.current?.style.setProperty('--string-darkness', String(darkness))
      element.current?.style.setProperty('--string-reveal', String(reveal))
      visual.current.reveal = reveal
      if (exit && next < .52 && !revealed.current) { revealed.current = true; callbacks.current.onReveal() }
      if (fraction < 1) animation.current = requestAnimationFrame(tick)
      else if (exit) { callbacks.current.onClose() }
      else { setPhase('ready'); element.current?.focus({ preventScroll: true }) }
    }
    animation.current = requestAnimationFrame(tick)
  }, [])
  const close = useCallback(() => {
    if (saving.current || leaving.current) return
    leaving.current = true; setPhase('leaving'); setSelection(null)
    grab.current = null; pan.current = null; setReordering(false)
    visual.current.pointer = null; visual.current.grabbed = null
    travel(true)
  }, [travel])

  useEffect(() => {
    mounted.current = true
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    element.current?.showModal()
    travel(); void refresh()
    return () => {
      mounted.current = false; cancelAnimationFrame(animation.current); setStringFlight(0)
      element.current?.close()
      if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true })
    }
  }, [refresh, travel])
  useEffect(() => {
    if (phase !== 'ready') return
    const timer = setTimeout(() => setHint(false), 9500)
    return () => clearTimeout(timer)
  }, [phase])
  useEffect(() => {
    if (!canvas.current) return
    let renderer: StringCanvas
    try {
      renderer = new StringCanvas(canvas.current, () => visual.current, (positions, width) => {
        points.current = positions
        const now = performance.now(), delta = lastPlacement.current ? Math.min(50, now - lastPlacement.current) : 16.67
        lastPlacement.current = now
        buttons.current.forEach((button, key) => {
          const point = positions.get(key)
          if (point) button.style.transform = `translate3d(${point.x - 24}px,${point.y - 24}px,0)`
        })
        if (grab.current && scroller.current) {
          const x = grab.current.pointerX
          const velocity = x < 65 ? -(65 - x) * .09 : x > width - 65 ? (x - width + 65) * .09 : 0
          if (velocity) scroller.current.scrollLeft += velocity * delta / 16.67
        }
      })
      engine.current = renderer
    } catch (reason) { setError(describeError(reason)); return }
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      setSize({ width, height })
    })
    if (element.current) observer.observe(element.current)
    return () => { observer.disconnect(); renderer.destroy(); engine.current = null }
  }, [])

  const reorder = (id: string, index: number) => {
    const next = moveStringItem(orderRef.current, id, index)
    if (next.every((value, i) => value === orderRef.current[i])) return
    operation.current = crypto.randomUUID(); orderRef.current = next; setOrder(next); setError('')
    visual.current.lower = arrangeStringItems(visual.current.upper, next)
    const title = snapshot?.items.find(item => item.id === id)?.title
    setAnnouncement(`${title}，已移到第 ${next.indexOf(id) + 1} 项`)
  }
  const updateDrag = (x: number, y: number) => {
    const current = grab.current
    if (!current) return
    current.pointerX = x; current.pointerY = y
    current.x = x - current.offsetX; current.y = y - current.offsetY
    if (Math.abs(x - current.startX) > 5) current.moved = true
    visual.current.grabbed = { id: current.id, x: current.x, y: current.y }
    const actualX = current.x + (scroller.current?.scrollLeft ?? 0)
    const slots = visual.current.lower.map((item, index) => ({ item, index })).filter(({ item }) => item.movable)
    let target = 0, distance = Infinity
    slots.forEach(({ index }, i) => { const d = Math.abs(geometry.x(index) - actualX); if (d < distance) { distance = d; target = i } })
    if (current.moved) reorder(current.id, target)
  }
  const pointerMove = (event: PointerEvent) => {
    visual.current.pointer = { x: event.clientX, y: event.clientY }
    if (grab.current?.pointerId === event.pointerId) updateDrag(event.clientX, event.clientY)
    else if (pan.current?.pointerId === event.pointerId && scroller.current) scroller.current.scrollLeft = pan.current.scroll + pan.current.x - event.clientX
  }
  const release = (event: PointerEvent, cancelled = false) => {
    const current = grab.current
    if (current && current.pointerId === event.pointerId) {
      if (cancelled) { orderRef.current = current.original; setOrder(current.original) }
      else engine.current?.pulse(current.x + visual.current.scroll, 1, current.moved ? 1.2 : .5)
      grab.current = null; visual.current.grabbed = null
      setReordering(false)
      element.current?.removeAttribute('data-dragging')
    }
    if (pan.current?.pointerId === event.pointerId) pan.current = null
  }
  const startGrab = (event: PointerEvent<HTMLButtonElement>, item: StringItem, row: 0 | 1) => {
    if (phase !== 'ready' || busy || event.button !== 0 || grab.current || !event.isPrimary) return
    setSelection({ id: item.id, row }); setHint(false)
    engine.current?.pulse(event.clientX + visual.current.scroll, row, .5)
    if (row === 0 || !item.movable) return
    event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); element.current?.setPointerCapture(event.pointerId)
    const point = points.current.get(`${row}:${item.id}`)
    const x = point ? point.x - visual.current.scroll : event.clientX, y = point?.y ?? event.clientY
    grab.current = { id: item.id, pointerId: event.pointerId, x, y, pointerX: event.clientX, pointerY: event.clientY,
      offsetX: event.clientX - x, offsetY: event.clientY - y, startX: event.clientX, moved: false, original: [...orderRef.current] }
    visual.current.grabbed = { id: item.id, x, y }
    setReordering(true)
    element.current?.setAttribute('data-dragging', 'true')
  }
  const keyMove = (event: KeyboardEvent<HTMLButtonElement>, item: StringItem, row: 0 | 1) => {
    if (row === 0 || !item.movable || busy || phase !== 'ready') return
    const index = orderRef.current.indexOf(item.id)
    const target = event.key === 'ArrowLeft' ? index - 1 : event.key === 'ArrowRight' ? index + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1 : null
    if (target === null) return
    event.preventDefault(); reorder(item.id, target); setHint(false); setReordering(true)
    const next = arrangeStringItems(snapshot?.items ?? [], orderRef.current).findIndex(value => value.id === item.id)
    scroller.current?.scrollTo({ left: Math.max(0, geometry.x(next) - size.width / 2), behavior: reduced ? 'instant' : 'smooth' })
    engine.current?.pulse(geometry.x(next))
  }
  const complete = async () => {
    if (saving.current || phase !== 'ready') return
    if (!snapshot || refreshNeeded) { await refresh(); return }
    const original = snapshot.items.filter(item => item.movable).map(item => item.id)
    if (original.every((id, index) => id === orderRef.current[index])) { close(); return }
    saving.current = true; setBusy(true); setError(''); setSelection(null)
    try {
      const result = await localApi<StringResult>('/companion/string-order', { date: snapshot.date, orderedIds: orderRef.current,
        expectedRevision: snapshot.revision, snapshotKey: snapshot.snapshotKey, requestId: operation.current })
      if (!mounted.current) return
      notifyLocalDataChange(); callbacks.current.onSaved(result.summary)
      saving.current = false; setBusy(false); close()
    } catch (reason) {
      if (mounted.current) { setError(describeError(reason)); setRefreshNeeded(reason instanceof LocalApiError && reason.status === 409) }
    } finally { saving.current = false; if (mounted.current) setBusy(false) }
  }
  const changeStyle = (next: StringStyle) => { setStyle(next); saveStringStyle(next) }
  const scrollByPage = (direction: number) => scroller.current?.scrollBy({ left: direction * size.width * .65, behavior: reduced ? 'instant' : 'smooth' })
  const changed = snapshot && order.some((id, index) => id !== snapshot.items.filter(item => item.movable)[index]?.id)
  const renderTrack = (items: readonly StringItem[], row: 0 | 1) => <div className="string-hit-track" role="group" aria-label={row === 0 ? '当前安排，只读' : '新的顺序，方向键可调整任务'}>
    {items.map((item, index) => <button key={item.id} type="button" className="string-node" data-movable={row === 1 && item.movable}
      data-selected={selection?.id === item.id && selection.row === row} data-item-id={item.id} data-row={row}
      ref={node => { if (node) buttons.current.set(`${row}:${item.id}`, node); else buttons.current.delete(`${row}:${item.id}`) }}
      // The canvas owns the animated position. Keep React's initial transform
      // stable while reordering, so it cannot briefly snap a spring to its end.
      style={{ transform: `translate3d(${geometry.x(snapshot?.items.findIndex(value => value.id === item.id) ?? index) - 24}px,${stringRowY(size.height, row) - 24}px,0)` }}
      disabled={busy || phase !== 'ready'} aria-label={`${row === 0 ? '原安排' : '新顺序'}第 ${index + 1} 项，${item.title}，原在 ${item.date}，${item.durationMin} 分钟${row === 0 || !item.movable ? '，只读' : '，左右方向键调整顺序'}`}
      onPointerDown={event => startGrab(event, item, row)} onKeyDown={event => keyMove(event, item, row)}
      onKeyUp={() => { if (!grab.current) setReordering(false) }}
      onPointerEnter={() => { if (!grab.current) setSelection({ id: item.id, row }) }}
      onPointerLeave={() => { if (!grab.current && document.activeElement !== buttons.current.get(`${row}:${item.id}`)) setSelection(null) }}
      onFocus={() => setSelection({ id: item.id, row })} onBlur={() => { if (!grab.current) { setSelection(null); setReordering(false) } }}>
      <span className="string-node-label" aria-hidden="true"><span className="string-node-index">{String(index + 1).padStart(2, '0')}{!item.movable ? ' · 固定' : ''}</span><strong>{item.title}</strong><small>原在 {Number(item.date.slice(5, 7))}/{Number(item.date.slice(8, 10))} · {item.durationMin} 分钟</small></span>
    </button>)}
  </div>

  return <dialog ref={element} className="string-studio" data-phase={phase} data-busy={busy} data-reordering={reordering} data-style={style} tabIndex={-1} aria-label="弦轨，重排未来七天的任务" aria-describedby="string-help"
    onCancel={event => { event.preventDefault(); close() }} onPointerMove={pointerMove} onPointerUp={event => release(event)} onPointerCancel={event => release(event, true)}
    onLostPointerCapture={event => release(event, true)}
    onPointerLeave={() => { if (!grab.current) { visual.current.pointer = null; setSelection(null) } }}
    onKeyDown={event => event.stopPropagation()}>
    <div className="string-darkness" aria-hidden="true" />
    <canvas ref={canvas} className="string-canvas" aria-hidden="true" />
    <div className="string-style-picker" role="group" aria-label="光弦样式">
      {STRING_STYLES.map(option => <button key={option.id} type="button" aria-pressed={style === option.id} aria-label={`${option.name}：${option.description}`} disabled={busy || phase !== 'ready'} onClick={() => changeStyle(option.id)}>
        <StringStylePreview style={option.id} /><span><i>{option.number}</i>{option.name}</span>
      </button>)}
      <p>{STRING_STYLES.find(option => option.id === style)?.description}</p>
    </div>
    <div className="string-track-label string-track-label-original" aria-hidden="true"><span>当前安排</span><i />ORIGINAL</div>
    <div className="string-track-label string-track-label-draft" aria-hidden="true"><span>新的顺序</span><i />{changed ? 'RECOMPOSED' : 'POSSIBILITY'}</div>
    <div ref={scroller} className="string-scroll" onScroll={event => { visual.current.scroll = event.currentTarget.scrollLeft; setScrollPosition(event.currentTarget.scrollLeft); if (grab.current) updateDrag(grab.current.pointerX, grab.current.pointerY) }}
      onWheel={event => { if (scroller.current && Math.abs(event.deltaY) > Math.abs(event.deltaX)) scroller.current.scrollLeft += event.deltaY }}
      onPointerDown={event => { if (phase === 'ready' && event.pointerType !== 'touch' && event.isPrimary && event.target instanceof HTMLElement && !event.target.closest('button') && event.button === 0) { pan.current = { x: event.clientX, scroll: event.currentTarget.scrollLeft, pointerId: event.pointerId }; event.currentTarget.setPointerCapture(event.pointerId) } }}>
      <div className="string-score" style={{ width: geometry.contentWidth }}>
        {renderTrack(snapshot?.items ?? [], 0)}{renderTrack(visual.current.lower, 1)}
      </div>
    </div>
    {geometry.contentWidth > size.width && <div className="string-browse" aria-label="横向浏览任务"><button type="button" aria-label="查看前面的任务" disabled={scrollPosition < 2 || phase !== 'ready'} onClick={() => scrollByPage(-1)}>←</button><span>横向查看 <i /> {snapshot?.items.length} 段</span><button type="button" aria-label="查看后面的任务" disabled={scrollPosition > geometry.contentWidth - size.width - 2 || phase !== 'ready'} onClick={() => scrollByPage(1)}>→</button></div>}
    <div className="string-atmosphere-copy" data-visible={hint || loading || Boolean(error) || busy || !snapshot?.items.length}>
      {error ? <p className="string-error" role="alert">{error}</p> : <p>{busy ? '析熙正在把新的顺序，放进真实的空档' : loading ? '正在取来未来七天的安排' : !snapshot?.items.length ? '未来七天还没有可排列的任务' : '拖住下弦，任务会一起浮现'}</p>}
      {!error && !busy && !loading && Boolean(snapshot?.items.length) && <span>{snapshot?.items.length} 段安排 · 未来七天{geometry.contentWidth > size.width ? ' · 横向滑动查看' : ''}</span>}
    </div>
    <p className="p0-sr-only" id="string-help">上弦是当前安排，只读。按住下弦发光的任务段，全部任务信息会一起出现；拖动改变先后顺序，松手隐藏文字。也可以聚焦任务后按左右方向键。完成后由析熙根据空档重新安排具体时间。取消不提交排序。上方四个选项只改变光弦外观，保留当前排序。</p>
    <span className="p0-sr-only" role="status" aria-live="polite">{announcement}</span>
    <footer className="string-actions"><button type="button" className="string-cancel" disabled={busy || phase === 'leaving'} onClick={close}>取消</button><button type="button" className="string-complete" disabled={busy || loading || phase !== 'ready'} onClick={() => void complete()}>{busy ? '安排中' : refreshNeeded || !snapshot ? '重新读取' : '完成'}<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10 3.5 3.5 7.5-7" /></svg></button></footer>
  </dialog>
}

function StringStylePreview({ style }: { style: StringStyle }) {
  return <svg className="string-style-preview" viewBox="0 0 76 26" aria-hidden="true" data-kind={style}>
    {style === 'ribbon' ? <><path d="M1 17C22-9 50 35 75 9" strokeWidth="4" opacity=".25" /><path d="M1 16C22 1 50 25 75 10" strokeWidth="1.6" /></> :
      style === 'filament' ? <>{[0, 1, 2, 3].map(i => <path key={i} d={`M1 ${9 + i * 2}C22 ${26 - i * 5} 47 ${i * 5 - 1} 75 ${17 - i * 2}`} opacity={.35 + i * .18} />)}</> :
      style === 'current' ? <><path d="M1 15C24 7 43 20 75 11" strokeWidth="6" opacity=".16" /><path d="M1 15C24 7 43 20 75 11" strokeWidth="2" /><path d="M4 10C24 5 43 23 72 16" strokeDasharray="1 5" opacity=".6" /></> :
      <><path d="M1 18Q38-9 75 18" /><path d="M1 18Q38 1 75 18" opacity=".45" /><path d="M1 18Q38 25 75 18" opacity=".2" /></>}
  </svg>
}

/** An invitation inside 余时, not another item in the global navigation. */
export function StringInvitation({ onEnter, glass }: { onEnter: () => void; glass: Preferences['glass'] }) {
  const paint = useId().replaceAll(':', '')
  return <button type="button" className="string-invitation" onClick={onEnter} aria-label="进入弦轨，事件视界">
    <MeasuredGlassSurface radius={20} material={{ transmission: 100, blur: glass === 'soft' ? 6 : 0, rim: 40, shadow: 0, reflection: 10 }} />
    <span className="string-invitation-art string-invitation-orbits" aria-hidden="true"><svg viewBox="0 0 240 100">
      <defs>
        <linearGradient id={`${paint}-light`} x1="15%" y1="0%" x2="75%" y2="100%"><stop stopColor="#c5a269" stopOpacity="0" /><stop offset=".36" stopColor="#b89052" stopOpacity=".15" /><stop offset=".63" stopColor="#e9c68f" stopOpacity=".68" /><stop offset=".8" stopColor="#fff0cd" /><stop offset="1" stopColor="#9e7337" stopOpacity=".1" /></linearGradient>
        <radialGradient id={`${paint}-haze`}><stop stopColor="#d0a76b" stopOpacity=".14" /><stop offset="1" stopColor="#d0a76b" stopOpacity="0" /></radialGradient>
        <filter id={`${paint}-bloom`} x="-50%" y="-150%" width="200%" height="400%"><feGaussianBlur stdDeviation="2.6" /></filter>
      </defs>
      <g className="string-invitation-disk" transform="rotate(-14 120 50)">
        <ellipse cx="120" cy="53" rx="114" ry="35" fill={`url(#${paint}-haze)`} />
        {[.56, .78, 1].map(radius => <g key={radius} fill="none" stroke={`url(#${paint}-light)`}>
          <ellipse cx="120" cy="50" rx={104 * radius} ry={29 * radius} strokeWidth="7" opacity=".24" filter={`url(#${paint}-bloom)`} />
          {Array.from({ length: 9 }, (_, index) => <ellipse key={index} cx="120" cy="50" rx={104 * radius + (index - 4) * .9} ry={29 * radius + (index - 4) * .32} strokeWidth={index === 4 ? .85 : .3} opacity={index === 4 ? 1 : .55} />)}
        </g>)}
      </g>
    </svg></span>
    <span className="string-invitation-copy"><span>弦轨 <small>事件视界</small></span><span>沿着光，让今天慢慢展开</span></span>
    <span className="string-invitation-link">进入轨道 <span aria-hidden="true">↗</span></span>
  </button>
}
