import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { Task } from '../domain/task'
import { taskSteps } from '../domain/taskSteps'
import { notifyLocalDataChange } from '../stores/migration'
import { localApi } from '../xixi/api'
import './task-steps.css'

type Props = { task: Task; disabled?: boolean; onRequestSteps: () => void }
const COMPACT_PAGE = '(min-width: 1180px) and (max-height: 820px)'
type Paging = {
  taskId: string; context: string; pages: number; page: number; target: number;
  phase: 'idle' | 'leaving' | 'entering'; direction: number
}
type PageAction = { type: 'move'; delta: number } | { type: 'finish' | 'settle' }
  | { type: 'reset'; taskId: string; context: string; pages: number }

function pageTransition(state: Paging, action: PageAction): Paging {
  if (action.type === 'reset') {
    const page = action.taskId === state.taskId ? Math.min(state.page, action.pages - 1) : 0
    return { ...state, taskId: action.taskId, context: action.context, pages: action.pages,
      page, target: page, phase: 'idle' }
  }
  if (action.type === 'settle') return { ...state, page: state.target, phase: 'idle' }
  if (action.type === 'move') {
    const target = Math.max(0, Math.min(state.target + action.delta, state.pages - 1))
    if (target === state.target) return state
    return { ...state, target, ...(state.phase === 'idle'
      ? { phase: 'leaving' as const, direction: Math.sign(target - state.page) } : {}) }
  }
  if (state.phase === 'leaving') {
    return { ...state, page: state.target, phase: 'entering',
      direction: Math.sign(state.target - state.page) || -state.direction }
  }
  return { ...state, phase: state.target === state.page ? 'idle' : 'leaving',
    direction: Math.sign(state.target - state.page) || state.direction }
}

export function TaskSteps({ task, disabled = false, onRequestSteps }: Props) {
  const id = useId()
  const [saved, setSaved] = useState<Task | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [pageSize, setPageSize] = useState(() => matchMedia(COMPACT_PAGE).matches ? 4 : 6)
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const viewport = useRef<HTMLDivElement>(null)
  const lock = useRef(false)
  const mounted = useRef(false)
  const latest = useRef(task)
  latest.current = task
  // A successful write is immediately visible while the shared task list reloads.
  // A newer shared snapshot always wins, including edits made from another tab.
  const current = saved?.id === task.id && saved.updatedAt > task.updatedAt ? saved : task
  const steps = taskSteps(current)
  const completed = steps.filter(step => step.doneAt).length
  const next = steps.find(step => !step.doneAt)
  const pages = Math.max(1, Math.ceil(steps.length / pageSize))
  // Completion/title updates preserve the page and checkbox nodes. Only a new
  // task, page size or step order invalidates an in-flight page transition.
  const context = JSON.stringify([task.id, pageSize, steps.map(step => step.id)])
  const [paging, paginate] = useReducer(pageTransition, {
    taskId: task.id, context, pages, page: 0, target: 0, phase: 'idle', direction: 1,
  })
  const currentPage = task.id === paging.taskId ? Math.min(paging.page, pages - 1) : 0
  const targetPage = Math.min(paging.target, pages - 1)

  useLayoutEffect(() => {
    paginate({ type: 'reset', taskId: task.id, context, pages })
  }, [task.id, context, pages])

  useLayoutEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(media.matches || Boolean(viewport.current?.closest('[data-motion=reduced]')))
    const observer = new MutationObserver(update)
    // Watch only ancestor preferences, not the checklist's own state changes.
    for (let parent = viewport.current?.parentElement; parent; parent = parent.parentElement) {
      observer.observe(parent, { attributes: true, attributeFilter: ['data-motion'] })
    }
    update()
    media.addEventListener('change', update)
    return () => { media.removeEventListener('change', update); observer.disconnect() }
  }, [Boolean(steps.length)])

  useLayoutEffect(() => {
    if (paging.context !== context || paging.phase === 'idle') return
    const list = viewport.current?.querySelector<HTMLOListElement>('[data-active=true]')
    if (!list || reducedMotion || list.closest('[data-motion=reduced]') || typeof list.animate !== 'function') {
      paginate({ type: 'settle' })
      return
    }
    // CompletedTasks' 130ms exit, with Workbench's focus-entry easing. Only
    // checklist content moves; the glass shell and pagination stay stationary.
    const leaving = paging.phase === 'leaving'
    const offset = paging.direction * 12
    const animation = list.animate(leaving
      ? [{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: `translateX(${-offset}px)` }]
      : [{ opacity: 0, transform: `translateX(${offset}px)` }, { opacity: 1, transform: 'translateX(0)' }],
    { duration: leaving ? 130 : 220, easing: 'cubic-bezier(.16,.8,.25,1)', fill: 'both' })
    let cancelled = false
    void animation.finished.then(() => { if (!cancelled) paginate({ type: 'finish' }) },
      () => { if (!cancelled) paginate({ type: 'settle' }) })
    return () => { cancelled = true; animation.cancel() }
  }, [context, paging.context, paging.page, paging.phase, paging.direction, reducedMotion])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    const media = matchMedia(COMPACT_PAGE)
    const change = () => setPageSize(media.matches ? 4 : 6)
    change()
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])

  const check = async (stepId: string, checked: boolean) => {
    if (disabled || lock.current) return
    lock.current = true
    setPending(stepId)
    setError('')
    const taskId = current.id
    try {
      const result = await localApi<Task>('/tasks/steps/check', {
        taskId, stepId, checked, expectedUpdatedAt: current.updatedAt,
      })
      if (mounted.current && latest.current.id === taskId) setSaved(result)
      notifyLocalDataChange()
    } catch (reason) {
      if (mounted.current && latest.current.id === taskId) {
        setError(reason instanceof Error ? reason.message : '步骤尚未保存，请重试')
      }
      // Also refresh on conflicts: the server may have newer steps or task state.
      notifyLocalDataChange()
    } finally {
      lock.current = false
      if (mounted.current && latest.current.id === taskId) setPending(null)
    }
  }

  return <section className="wb-task-steps" aria-labelledby={`${id}-title`}>
    <header className="wb-steps-heading"><h3 id={`${id}-title`}>任务步骤</h3>{steps.length > 0 && <output aria-live="polite" aria-atomic="true"><span className="p0-sr-only">已完成 </span>{completed}<span> / {steps.length}</span><span className="p0-sr-only"> 步</span></output>}</header>
    {steps.length ? <>
      <div className="wb-steps-progress" role="progressbar" aria-label="任务步骤完成进度" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={completed}>
        <span style={{ transform: `scaleX(${completed / steps.length})` }} />
      </div>
      <div className="wb-steps-next" data-complete={!next}>
        <span>{next ? '下一步' : '每一步，都走到了'}</span>
        <p>{next ? next.title : '步骤完成，可以核对提交'}</p>
      </div>
      <div className="wb-steps-window" ref={viewport}>
        {Array.from({ length: pages }, (_, listPage) => {
          const start = listPage * pageSize
          const active = listPage === currentPage
          return <ol key={listPage} className="wb-steps-list" start={start + 1} data-active={active} inert={!active} aria-hidden={!active} aria-label="可勾选的任务步骤" aria-busy={Boolean(pending)}>
            {steps.slice(start, start + pageSize).map((step, index) => {
              const inputId = `${id}-step-${start + index}`
              const detailId = `${inputId}-detail`
              return <li key={step.id} data-completed={Boolean(step.doneAt)} data-saving={pending === step.id}>
                <label htmlFor={inputId}>
                  <input id={inputId} type="checkbox" checked={Boolean(step.doneAt)} disabled={disabled || Boolean(pending)} aria-labelledby={`${inputId}-title`} aria-describedby={step.detail ? detailId : undefined} onChange={event => void check(step.id, event.target.checked)} />
                  <span className="wb-step-copy"><span className="wb-step-title"><span className="wb-step-number" aria-hidden="true">{String(start + index + 1).padStart(2, '0')}</span><strong id={`${inputId}-title`}>{step.title}</strong></span>{step.detail && <span id={detailId} className="wb-step-detail">{step.detail}</span>}</span>
                </label>
              </li>
            })}
          </ol>
        })}
      </div>
      <footer className="wb-steps-footer">
        {pages > 1 ? <nav className="wb-steps-pages" aria-label="任务步骤分页"><button type="button" aria-disabled={targetPage === 0} onClick={() => paginate({ type: 'move', delta: -1 })}>上一页</button><span aria-live="polite">{currentPage + 1} / {pages}</span><button type="button" aria-disabled={targetPage === pages - 1} onClick={() => paginate({ type: 'move', delta: 1 })}>下一页</button></nav> : <span>一小步，也算向前</span>}
        <span className="wb-steps-save" role="status">{pending ? '正在保存…' : error ? '这次修改未保存' : '进度已保存'}</span>
      </footer>
    </> : <div className="wb-steps-empty">
      <span className="wb-steps-empty-mark" aria-hidden="true">✧</span>
      <p>把作业交给析熙，<br />一起拆成能开始的小步骤。</p>
      <small>在右侧聊天粘贴作业要求，或补充想完成的内容。</small>
      <button type="button" className="wb-action" disabled={disabled} onClick={onRequestSteps}>让析熙拆步骤</button>
    </div>}
    {error && <p className="wb-steps-error" role="alert">{error}</p>}
  </section>
}
