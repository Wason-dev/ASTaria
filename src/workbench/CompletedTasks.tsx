import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Task } from '../domain/task'
import { localDay } from '../home/agenda'
import { completedTaskPage, completionDate } from './completionHistory'
import { WorkbenchIcon as Icon } from './WorkbenchIcon'

type Props = {
  tasks: readonly Task[]; now: Date; disabled: boolean; recentCompletion: string | null;
  reopeningId: string | null; getSpentMs: (id: string) => number; onReopen: (task: Task) => void
}

export function CompletedTasks({ tasks, now, disabled, recentCompletion, reopeningId, getSpentMs, onReopen }: Props) {
  const [mode, setMode] = useState<'recent' | 'history'>('recent')
  const [query, setQuery] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(0)
  const [leaving, setLeaving] = useState(false)
  const transition = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const headingId = useId(), contentId = useId()
  const result = useMemo(() => completedTaskPage(tasks, now, { mode, query, from, to, page }), [tasks, now, mode, query, from, to, page])
  useEffect(() => () => clearTimeout(transition.current), [])
  const move = (change: () => void) => {
    clearTimeout(transition.current)
    setLeaving(true)
    transition.current = setTimeout(() => { change(); setLeaving(false) }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 130)
  }
  const label = mode === 'history' ? '完成历史' : '近 7 天完成'
  const changeFilter = (change: () => void) => { clearTimeout(transition.current); setLeaving(false); change(); setPage(0) }
  return <section className="wb-completed" aria-labelledby={headingId} data-completed-view={mode}>
    <header className="wb-section-heading wb-completed-heading"><h3 id={headingId}>{mode === 'history' ? '完成历史' : '已完成'} <span>{result.total}</span></h3>
      <div className="wb-completed-navigation">{mode === 'recent' && <span>近 7 天</span>}<button type="button" className="wb-completed-switch" disabled={disabled || leaving} aria-controls={contentId} onClick={() => move(() => { setMode(mode === 'recent' ? 'history' : 'recent'); setPage(0) })}>{mode === 'history' ? '返回近 7 天' : '全部历史'}<Icon name={mode === 'history' ? 'back' : 'arrow'} /></button></div>
    </header>
    <div id={contentId} className="wb-completed-content" data-leaving={leaving} inert={leaving}>
      {mode === 'history' && <div className="wb-completed-filters" role="search" aria-label="筛选完成历史">
        <label className="wb-completed-search"><span className="p0-sr-only">搜索已完成事项</span><input type="search" value={query} placeholder="按标题查找" disabled={disabled} onChange={event => changeFilter(() => setQuery(event.target.value))} /></label>
        <label><span>从</span><input type="date" value={from} aria-label="完成日期起始" disabled={disabled} onChange={event => changeFilter(() => setFrom(event.target.value))} /></label>
        <label><span>至</span><input type="date" value={to} aria-label="完成日期结束" disabled={disabled} onChange={event => changeFilter(() => setTo(event.target.value))} /></label>
        {(query || from || to) && <button className="wb-completed-clear" type="button" disabled={disabled} onClick={() => changeFilter(() => { setQuery(''); setFrom(''); setTo('') })}>清除筛选</button>}
      </div>}
      {result.invalidRange && <p className="wb-error" role="alert">结束日期应不早于开始日期</p>}
      <div className="wb-completed-list" key={`${mode}-${result.page}-${query}-${from}-${to}`}>
        {result.items.map(task => {
          const date = completionDate(task), spent = getSpentMs(task.id)
          return <div className="wb-completed-row" data-task-id={task.id} data-completed-id={task.id} data-recent={task.id === recentCompletion} key={task.id}>
            <span className="wb-completed-mark" aria-hidden="true">✓</span><span>{task.title}</span>
            <small>{date ? <time dateTime={task.doneAt} title={date.toLocaleString('zh-CN')}>{completionLabel(date, now)}</time> : <span>完成时间未记录</span>}{Number.isFinite(spent) && spent > 0 && <span>累计专注 {spent < 60_000 ? '不到 1 分钟' : `${Math.floor(spent / 60_000)} 分钟`}</span>}</small>
            <button type="button" className="wb-icon-button wb-reopen" title="撤回完成" aria-label={`撤回完成：${task.title}`} disabled={disabled || leaving} onClick={() => onReopen(task)}><Icon name="undo" /><span className="wb-tooltip" role="tooltip">{reopeningId === task.id ? '正在撤回' : '撤回完成'}</span></button>
          </div>
        })}
        {!result.items.length && !result.invalidRange && <p className="wb-section-empty">{mode === 'recent' ? result.totalCompleted ? '近 7 天没有完成事项，之前的记录在全部历史中' : '完成的事项会留在这里' : query || from || to ? '没有找到符合筛选的事项' : '暂时没有完成记录'}</p>}
      </div>
      {mode === 'history' && result.unknownDateCount > 0 && !from && !to && <p className="wb-completed-note">{result.unknownDateCount} 项未记录完成时间，仍可按标题查找</p>}
    </div>
    {result.pageCount > 1 && <nav className="wb-completed-pagination" aria-label={`${label}分页`}>
      <span role="status">{result.page * result.pageSize + 1}–{Math.min((result.page + 1) * result.pageSize, result.total)} / {result.total}</span>
      <button type="button" aria-label={`${label}上一页`} disabled={disabled || leaving || result.page === 0} onClick={() => move(() => setPage(result.page - 1))}><Icon name="chevron" /></button>
      <span aria-hidden="true">{result.page + 1} / {result.pageCount}</span>
      <button type="button" aria-label={`${label}下一页`} disabled={disabled || leaving || result.page + 1 >= result.pageCount} onClick={() => move(() => setPage(result.page + 1))}><Icon name="chevron" /></button>
    </nav>}
  </section>
}

function completionLabel(date: Date, now: Date) {
  if (localDay(date) === localDay(now)) return '今天完成'
  const year = date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}年`
  return `${year}${date.getMonth() + 1}月${date.getDate()}日完成`
}
