import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MeasuredGlassSurface } from '../home/GlassSurface'
import { groupMinutes } from './orbitGroups'
import { usePreferences } from './preferences'
import type { OrbitDay, OrbitGroup } from './orbitGroups'
import { HORIZON_GROUP_CAPACITY, HORIZON_GROUP_TITLE_LIMIT, mergeHorizonGroups, moveHorizonTaskToGroup, renameHorizonGroup, splitHorizonTask } from './horizonGrouping'
import type { HorizonGroupingResult } from './horizonGrouping'
import { createHorizonEditorTransition } from './horizonEditorTransition'
import './horizon-group-editor.css'

type Props = {
  groups: OrbitGroup[]
  disabled?: boolean
  onChange: (groups: OrbitGroup[]) => void
  onClose: () => void
}
const DAYS = ['今天', '明天', '后天'] as const

function GroupName({ group, disabled, onRename }: { group: OrbitGroup; disabled: boolean; onRename: (name: string) => boolean }) {
  const [name, setName] = useState(group.title)
  useEffect(() => setName(group.title), [group.title])
  const commit = () => { if (name !== group.title && !onRename(name)) setName(group.title) }
  return <label className="horizon-editor-name"><span>组名</span><input aria-label={`${DAYS[group.day]}的组名：${group.title}`} value={name} disabled={disabled}
    maxLength={HORIZON_GROUP_TITLE_LIMIT} onChange={event => setName(event.target.value)}
    onBlur={commit}
    onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); commit() }
      if (event.key === 'Escape' && name !== group.title) { event.preventDefault(); event.stopPropagation(); setName(group.title) }
    }} /></label>
}

/** Edits the caller's draft inside the existing horizon dialog. */
export function HorizonGroupEditor({ groups, disabled = false, onChange, onClose }: Props) {
  const { glass, effect } = usePreferences().value
  const [day, setDay] = useState<OrbitDay>(0), [notice, setNotice] = useState(''), [failed, setFailed] = useState(false)
  const [systemReduced, setSystemReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const reduced = systemReduced || effect.motion === 'reduced'
  const material = useMemo(() => ({ transmission: 100, blur: glass === 'soft' ? 6 : 0, rim: 40, shadow: 0, reflection: 10 }), [glass])
  const [transition] = useState(() => createHorizonEditorTransition(0))
  const panel = useRef<HTMLElement>(null), close = useRef<HTMLButtonElement>(null)
  const scroll = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null)
  const dayButtons = useRef(new Map<OrbitDay, HTMLButtonElement>())
  const currentDay = useRef<OrbitDay>(0), animatedDay = useRef<OrbitDay>(0), draft = useRef(groups)
  const groupNodes = useRef(new Map<string, HTMLElement>()), nextFocus = useRef<{ id: string; day: OrbitDay } | null>(null)
  const titleId = useId(), noteId = useId(), contentId = useId()
  const selected = groups.filter(group => group.day === day)
  useLayoutEffect(() => { draft.current = groups }, [groups])
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const changed = () => { if (media.matches) transition.cancel(); setSystemReduced(media.matches) }
    const visibilityChanged = () => { if (document.hidden) transition.cancel() }
    changed()
    media.addEventListener('change', changed)
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      media.removeEventListener('change', changed)
      document.removeEventListener('visibilitychange', visibilityChanged)
      transition.cancel()
    }
  }, [transition])
  useLayoutEffect(() => {
    if (animatedDay.current !== day && scroll.current) scroll.current.scrollTop = 0
    animatedDay.current = day
    const node = content.current
    transition.update(day, reduced || document.hidden, node && typeof node.animate === 'function' ? (frames, options) => node.animate(frames, options) : undefined)
    return transition.cancel
  }, [day, reduced, transition])
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    close.current?.focus({ preventScroll: true })
    return () => { if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true }) }
  }, [])
  useLayoutEffect(() => {
    if (!nextFocus.current || nextFocus.current.day !== day || currentDay.current !== day) return
    const node = groupNodes.current.get(nextFocus.current.id)
    if (node) { node.focus({ preventScroll: true }); node.scrollIntoView({ block: 'nearest', behavior: 'auto' }); nextFocus.current = null }
  }, [groups, day])
  const switchDay = (nextDay: OrbitDay, moveFocus = false) => {
    if (!moveFocus) nextFocus.current = null
    if (nextDay === currentDay.current) return
    // Requests can be batched back to the displayed day without a React commit.
    transition.cancel()
    // Focus before changing the day so a pending rename blurs into its source day.
    if (content.current?.contains(document.activeElement)) dayButtons.current.get(nextDay)?.focus({ preventScroll: true })
    currentDay.current = nextDay
    setDay(nextDay)
  }
  const apply = (source: OrbitGroup, edit: (current: OrbitGroup[]) => HorizonGroupingResult, message: string, moveFocus = true) => {
    // Detached controls and late blur events cannot mutate another day's draft.
    if (disabled || source.day !== currentDay.current || !draft.current.some(group => group.id === source.id && group.day === source.day)) return false
    const result = edit(draft.current)
    setFailed(!result.ok)
    if (!result.ok) { setNotice(result.reason); return false }
    setNotice(message)
    draft.current = result.groups
    if (moveFocus) {
      const target = result.groups.find(group => group.id === result.focusGroupId)
      if (target) { nextFocus.current = { id: target.id, day: target.day }; switchDay(target.day, true) }
    }
    onChange(draft.current)
    return true
  }
  return <div className="horizon-editor-layer" onPointerDown={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}>
    <section ref={panel} className="horizon-group-editor" data-reduced={reduced} aria-labelledby={titleId} aria-describedby={noteId}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
        if (event.key === 'Tab') {
          const nodes = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)') ?? [])]
          const first = nodes[0], last = nodes.at(-1)
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }
        // Group controls must not trigger the horizon's arrow-key reordering.
        event.stopPropagation()
      }}>
      <MeasuredGlassSurface radius={20} material={material} />
      <header className="horizon-editor-heading"><div><small>弦轨 · {DAYS[day]}的分组</small><h2 id={titleId}>让事情聚在一起<span className="p0-sr-only"> · {DAYS[day]}的分组</span></h2><p id={noteId}>自动分好，也可以按你的习惯微调。调整会留在当前草稿中。</p></div>
        <button ref={close} type="button" className="horizon-editor-done" onClick={onClose}>回到弦轨 <span aria-hidden="true">↗</span></button>
      </header>
      <nav className="horizon-editor-days" aria-label="选择要编辑的日期">{DAYS.map((label, index) => <button type="button" key={label} aria-pressed={day === index} aria-controls={contentId}
        ref={node => { if (node) dayButtons.current.set(index as OrbitDay, node); else dayButtons.current.delete(index as OrbitDay) }} onClick={() => switchDay(index as OrbitDay)}>
        <span>{label}</span><small>{groups.filter(group => group.day === index).length} 组</small>
      </button>)}</nav>
      <div ref={scroll} id={contentId} className="horizon-editor-scroll" role="region" aria-label={`${DAYS[day]}的分组`}>
        <div ref={content} className="horizon-editor-content" data-day={day}>
        {selected.length === 0 && <p className="horizon-editor-empty">这一天还没有组。可以从其他日期把事项移过来。</p>}
        {selected.map((group, index) => <article key={group.id} className="horizon-editor-group" tabIndex={-1} aria-label={`${DAYS[group.day]}，${group.title}`}
          ref={node => { if (node) groupNodes.current.set(group.id, node); else groupNodes.current.delete(group.id) }}>
          <div className="horizon-editor-group-head"><span className="horizon-editor-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
            <GroupName group={group} disabled={disabled} onRename={name => apply(group, current => renameHorizonGroup(current, group.id, name), '组名已更新。', false)} />
            <span className="horizon-editor-count">{group.tasks.length} 项 <i aria-hidden="true">·</i> {groupMinutes(group)} 分钟</span>
            <label className="horizon-editor-select horizon-editor-merge"><span className="p0-sr-only">把{group.title}合并到同一天的另一组</span><select value="" disabled={disabled || selected.length < 2}
              title={selected.length < 2 ? '当天只有这一组，暂时没有可合并的组。' : '保留目标组的名字，将本组事项接在目标组后。'}
              onChange={event => { const target = draft.current.find(item => item.id === event.target.value); if (target) apply(group, current => mergeHorizonGroups(current, group.id, target.id), `已合并到「${target.title}」，保留两组事项的原有顺序。`) }}>
              <option value="">合并到同日组…</option>{selected.filter(target => target.id !== group.id).map(target => <option key={target.id} value={target.id} disabled={target.tasks.length + group.tasks.length > HORIZON_GROUP_CAPACITY}>
                {target.title}{target.tasks.length + group.tasks.length > HORIZON_GROUP_CAPACITY ? '（合并后超过 6 项）' : `（合并后 ${target.tasks.length + group.tasks.length} 项）`}
              </option>)}
            </select></label>
          </div>
          <ul className="horizon-editor-tasks">{group.tasks.map(task => <li key={task.id}>
            <div className="horizon-editor-task-copy"><strong>{task.title}</strong><span>{task.minutes} 分钟</span></div>
            <div className="horizon-editor-task-actions"><label className="horizon-editor-select"><span className="p0-sr-only">将{task.title}移入另一组，跨日期会同时换天</span><select value="" disabled={disabled || groups.length < 2}
              title={groups.length < 2 ? '还没有另一组，可以先让一项独立成组。' : '选择其他日期的组，会同时将事项移到那一天。'}
              onChange={event => { const target = draft.current.find(item => item.id === event.target.value); if (target) apply(group, current => moveHorizonTaskToGroup(current, group.id, task.id, target.id), `「${task.title}」已移到${DAYS[target.day]}的「${target.title}」。`) }}>
              <option value="">移入分组…</option>{DAYS.map((label, date) => <optgroup key={label} label={label}>{groups.filter(target => target.id !== group.id && target.day === date).map(target => <option key={target.id} value={target.id} disabled={target.tasks.length >= HORIZON_GROUP_CAPACITY}>
                {label} · {target.title}{target.tasks.length >= HORIZON_GROUP_CAPACITY ? '（已满 6 项）' : ''}
              </option>)}</optgroup>)}
            </select></label>
            <button type="button" className="horizon-editor-split" disabled={disabled || group.tasks.length === 1}
              aria-label={`让${task.title}独立成组`} title={group.tasks.length === 1 ? '这项已经独立成组。' : '在当天新建一组，保留这项的时长与安排信息。'}
              onClick={() => apply(group, current => splitHorizonTask(current, group.id, task.id), `「${task.title}」已在${DAYS[group.day]}独立成组。`)}>独立成组</button></div>
          </li>)}</ul>
        </article>)}
        </div>
      </div>
      <footer className="horizon-editor-footer"><p role="status" aria-live="polite" data-error={failed}>{notice || '每组最多 6 项 · 跨天移动会同时改变安排日期'}</p><span>{groups.length} 组 / {groups.reduce((sum, group) => sum + group.tasks.length, 0)} 项</span></footer>
    </section>
  </div>
}
