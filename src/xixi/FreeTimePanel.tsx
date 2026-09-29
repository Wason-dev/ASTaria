import { memo, useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { agendaDate, localDay } from '../home/agenda'
import { GlassSamplingContext, MeasuredGlassSurface } from '../home/GlassSurface'
import { WorkspaceHeading } from '../ui/WorkspaceHeading'
import { minutesLabel } from '../planner/model'
import { LOCAL_DATA_CHANGE, notifyLocalDataChange } from '../stores/migration'
import { sameSnapshot } from '../stores/sameSnapshot'
import { startVisiblePolling } from '../stores/visiblePolling'
import { localApi } from './api'
import type { Preferences } from './preferences'
import type { CompanionState, FreeTimeGoal, Wish } from './companionTypes'
import { StringInvitation } from './StringStudio'
import { FREE_TIME_STATUS_LABEL, freeTimeScheduleNotice } from './freeTimeScheduleResult'
import type { FreeTimePlanResult as PlanResult } from './freeTimeScheduleResult'
import './free-time.css'

type Props = { onClarifyWish: (wish: Wish) => void; onChanged: () => void | Promise<void>; onNotice: (message: string) => void; active?: boolean; onOpenStrings: () => void; today: string; theme: Preferences['theme']; grid: boolean; glass: Preferences['glass'] }
type Draft = { title: string; priority: FreeTimeGoal['priority']; minPerWeek: string; sessionMin: string; sessionMax: string; targetDate: string; targetNote: string }
type Editing = { goal?: FreeTimeGoal; wish?: Wish; draft: Draft }
const PRIORITIES = { high: '优先', normal: '普通', low: '顺带' } as const
const PAGE_SIZE = 4
const EMPTY_DRAFT: Draft = { title: '', priority: 'normal', minPerWeek: '3', sessionMin: '20', sessionMax: '40', targetDate: '', targetNote: '' }
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : '暂时无法完成，请重试'
const dayLabel = (date: string, short = false) => new Intl.DateTimeFormat('zh-CN', short ? { weekday: 'short' } : { weekday: 'short', month: 'numeric', day: 'numeric' }).format(agendaDate(date) ?? new Date())

function Pane({ children, className = '', blur = 0 }: { children: ReactNode; className?: string; blur?: number }) {
  return <section className={`free-time-pane ${className}`}><MeasuredGlassSurface radius={20} material={{ transmission: 100, blur, rim: 40, shadow: 0 }} /><div className="free-time-pane-content">{children}</div></section>
}

// Retain editors across navigation without rerendering them for every camera
// frame or starting another preference poll/clock behind the destination page.
export const FreeTimePanel = memo(function FreeTimePanel({ onClarifyWish, onChanged, onNotice, active = true, onOpenStrings, today, theme, grid, glass }: Props) {
  const id = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const [state, setState] = useState<CompanionState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const actionLock = useRef(false)
  const readRevision = useRef(0)
  const mounted = useRef(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [tab, setTab] = useState<'goals' | 'considering'>('goals')
  const [page, setPage] = useState(0)
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState<Editing | null>(null)
  const [wishEditing, setWishEditing] = useState<Wish | null>(null)
  const [newWish, setNewWish] = useState<string | null>(null)
  const [date, setDate] = useState(today)
  const [period, setPeriod] = useState<'today' | 'week'>('today')
  const [planPage, setPlanPage] = useState(0)
  const [shortfalls, setShortfalls] = useState<PlanResult['shortfalls']>([])
  const [latestOperation, setLatestOperation] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    const revision = ++readRevision.current
    const next = await localApi<CompanionState>(`/companion?date=${today}&days=7`)
    if (mounted.current && revision === readRevision.current) setState(previous => sameSnapshot(previous, next) ? previous : next)
  }, [today])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readRevision.current++ } }, [])
  useEffect(() => {
    if (!active) return
    let current = true
    heading.current?.focus({ preventScroll: true })
    // Revisit from the current database without discarding the editor or list.
    void refresh().catch(reason => { if (current) setError(errorText(reason)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false; readRevision.current++ }
  }, [active, refresh])
  useEffect(() => {
    if (!active) return
    const reload = () => { if (!document.hidden && !actionLock.current) void refresh().catch(reason => setError(errorText(reason))) }
    const stopPolling = startVisiblePolling(reload, 15000, false)
    window.addEventListener(LOCAL_DATA_CHANGE, reload); window.addEventListener('focus', reload)
    return () => { stopPolling(); window.removeEventListener(LOCAL_DATA_CHANGE, reload); window.removeEventListener('focus', reload) }
  }, [active, refresh])
  useEffect(() => { if (period === 'today') setDate(today) }, [today, period])
  useEffect(() => { setPage(0) }, [filter, tab])
  useEffect(() => { setPlanPage(0) }, [date])

  const announce = (message: string) => { setNotice(message); onNotice(message) }
  const synchronize = async () => { notifyLocalDataChange(); await refresh(); await onChanged() }
  const schedule = async () => {
    const result = await localApi<PlanResult>('/companion/free-time/schedule', { date: today })
    setShortfalls(result.shortfalls)
    if (result.operation) setLatestOperation(result.operation.id)
    return result
  }
  const execute = async (operation: () => Promise<void>) => {
    if (actionLock.current) return
    actionLock.current = true; setBusy(true); setError('')
    try { await operation() }
    catch (reason) { setError(errorText(reason)); void refresh().catch(() => undefined) }
    finally { actionLock.current = false; if (mounted.current) setBusy(false) }
  }
  const reschedule = () => execute(async () => {
    const result = await schedule()
    showScheduleResult(result)
    try { await synchronize() } catch (reason) { setError(`安排已保存，页面同步遇到问题：${errorText(reason)}`) }
  })
  const showScheduleResult = (result: PlanResult) => {
    announce(freeTimeScheduleNotice(result))
    const firstDate = result.addedSessions.map(session => session.date).sort()[0]
    if (firstDate) { setPeriod(firstDate === today ? 'today' : 'week'); setDate(firstDate); setPlanPage(0) }
  }
  const resumeGoal = (goal: FreeTimeGoal) => execute(async () => {
    const item = state?.freeTimeProgress.find(value => value.goalId === goal.id)
    if (!item) throw new Error('目标状态尚未读取，请重新读取后再恢复')
    const result = await localApi<PlanResult>('/companion/free-time/resume', {
      id: goal.id, expectedVersion: goal.version, expectedTaskUpdatedAt: item.taskUpdatedAt, date: today,
    })
    setShortfalls(result.shortfalls)
    if (result.operation) setLatestOperation(result.operation.id)
    showScheduleResult(result)
    try { await synchronize() } catch (reason) { setError(`目标已恢复，页面同步遇到问题：${errorText(reason)}`) }
  })
  const edit = (goal: FreeTimeGoal) => setEditing({ goal, draft: { title: goal.title, priority: goal.priority, minPerWeek: String(goal.minPerWeek), sessionMin: String(goal.sessionMin), sessionMax: String(goal.sessionMax), targetDate: goal.targetDate ?? '', targetNote: goal.targetNote ?? '' } })
  const save = (draft: Draft) => execute(async () => {
    if (!editing) return
    const numeric = [draft.minPerWeek, draft.sessionMin, draft.sessionMax].map(Number)
    if (numeric.some(value => !Number.isInteger(value)) || !draft.sessionMin || !draft.sessionMax || numeric[0] < 0 || numeric[0] > 14 || numeric[1] < 5 || numeric[2] > 720 || numeric[1] > numeric[2]) throw new Error('请填写有效次数和时长，最长时间不能小于最短时间')
    const goal = editing.goal
    await localApi<FreeTimeGoal>('/companion/free-time-goal', {
      ...(goal ? { id: goal.id, expectedVersion: goal.version } : {}),
      ...(editing.wish ? { fromWishId: editing.wish.id, expectedWishVersion: editing.wish.version } : {}),
      title: draft.title.trim(), evidence: goal?.evidence ?? editing.wish?.evidence ?? draft.title.trim(), priority: draft.priority,
      minPerWeek: numeric[0], sessionMin: numeric[1], sessionMax: numeric[2], targetDate: draft.targetDate || null, targetNote: draft.targetNote.trim(), status: goal?.status ?? 'active',
    })
    setEditing(null); setTab('goals'); setFilter(''); setPage(0)
    announce(goal ? '余时目标已更新' : '已加入余时')
    if (goal?.status !== 'paused') {
      try { const result = await schedule(); if (result.shortfalls.length) setNotice('目标已保存，可用时间不足的部分已列出') }
      catch (reason) { setError(`目标已保存，自动安排尚未完成：${errorText(reason)}`) }
    }
    try { await synchronize() } catch (reason) { setError(`目标已保存，页面同步遇到问题：${errorText(reason)}`) }
  })
  const updateStatus = (goal: FreeTimeGoal, status: FreeTimeGoal['status']) => execute(async () => {
    await localApi('/companion/free-time-goal/update', { id: goal.id, expectedVersion: goal.version, status })
    setRemoving(null)
    announce(status === 'paused' ? '已暂停新增安排，已有时段继续保留' : status === 'deleted' ? '目标已移除，尚未开始且未固定的安排已取消；已开始和固定时段保留' : '已恢复自动安排')
    try { await schedule() } catch (reason) { setError(`目标状态已保存，安排尚未同步：${errorText(reason)}`) }
    try { await synchronize() } catch (reason) { setError(`目标状态已保存，页面同步遇到问题：${errorText(reason)}`) }
  })
  const undoSchedule = () => execute(async () => {
    if (!latestOperation) return
    await localApi(`/operations/${encodeURIComponent(latestOperation)}/undo`, {})
    setLatestOperation(null); setShortfalls([]); announce('这次余时排程已撤销，目标继续保留')
    try { await synchronize() } catch (reason) { setError(`已撤销，页面同步遇到问题：${errorText(reason)}`) }
  })

  const completeSession = (sessionId: string) => execute(async () => {
    await localApi('/companion/free-time/complete', { sessionId })
    announce('这次学习已完成，进度已记在目标里')
    try { await synchronize() } catch (reason) { setError(`完成记录已保存，页面同步遇到问题：${errorText(reason)}`) }
  })
  const saveFeedback = (sessionId: string, feedback: 'smooth' | 'stuck' | 'continue', nextStep: string) => execute(async () => {
    await localApi('/companion/free-time/complete', { sessionId, feedback, nextStep: nextStep.trim() })
    announce('这次的反馈和下一步已记住')
    try { await synchronize() } catch (reason) { setError(`反馈已保存，页面同步遇到问题：${errorText(reason)}`) }
  })
  const saveWish = (wish: Wish, draft: WishDraft) => execute(async () => {
    await localApi('/companion/wish', { id: wish.id, expectedVersion: wish.version, content: draft.content.trim(), evidence: draft.evidence.trim() || draft.content.trim(), minutes: Number(draft.minutes), items: draft.items.split('\n').map(item => item.trim()).filter(Boolean), expiresAt: draft.expiresAt ? new Date(`${draft.expiresAt}T23:59:59`).toISOString() : null })
    setWishEditing(null); announce('这份牵挂已更新')
    try { await synchronize() } catch (reason) { setError(`牵挂已保存，页面同步遇到问题：${errorText(reason)}`) }
  })
  const updateWishStatus = (wish: Wish) => execute(async () => {
    await localApi('/companion/wish/update', { id: wish.id, expectedVersion: wish.version, status: wish.status === 'paused' ? 'active' : 'paused' })
    announce(wish.status === 'paused' ? '已恢复留意合适的机会' : '已暂停留意，内容继续保留')
    try { await synchronize() } catch (reason) { setError(`牵挂状态已保存，页面同步遇到问题：${errorText(reason)}`) }
  })
  const startWish = () => execute(async () => {
    const content = newWish?.trim()
    if (!content) return
    const wish = await localApi<Wish>('/companion/wish', { content, evidence: content })
    setNewWish(null); setTab('considering')
    try { await synchronize() } catch { /* Saved wish remains available to the conversation. */ }
    onClarifyWish(wish)
  })

  const goals = (state?.freeTimeGoals ?? []).filter(goal => goal.status !== 'deleted')
  const wishes = (state?.wishes ?? []).filter(wish => wish.status !== 'deleted' && !goals.some(goal => goal.fromWishId === wish.id))
  const visibleGoals = goals.filter(goal => `${goal.title} ${goal.targetNote ?? ''}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
  const visibleWishes = wishes.filter(wish => wish.content.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
  const total = tab === 'goals' ? visibleGoals.length : visibleWishes.length
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const currentPage = Math.min(page, pages - 1)
  const sessions = state?.freeTimeSessions ?? []
  const weekMinutes = sessions.reduce((sum, session) => sum + minuteValue(session.end) - minuteValue(session.start), 0)
  const progress = state?.freeTimeProgress ?? []
  const isScheduling = (goal: FreeTimeGoal) => goal.status === 'active'
  const remaining = progress.reduce((sum, item) => sum + item.remainingCount, 0)
  const shownDay = state?.timeline.find(day => day.date === date)
  const shownSessions = sessions.filter(session => session.date === date)
  const sessionPages = Math.max(1, Math.ceil(shownSessions.length / 4))
  const currentPlanPage = Math.min(planPage, sessionPages - 1)
  const opportunity = state?.opportunities.find(item => item.kind === 'wish' && item.date === date)
  const migratedWish = (wish: Wish) => { setWishEditing(null); setEditing({ wish, draft: { ...EMPTY_DRAFT, title: wish.content.slice(0, 160), sessionMin: String(Math.min(wish.minutes, 20)), sessionMax: String(Math.max(wish.minutes, 40)), targetNote: wish.clarification?.firstStep ?? (wish.evidence !== wish.content ? wish.evidence : '') } }) }

  return <GlassSamplingContext.Provider value={active}><section className="free-time-page" data-active={active} data-theme={theme} data-grid={grid} aria-labelledby={`${id}-title`} aria-hidden={!active} inert={!active}>
    <div className="free-time-background" aria-hidden="true" />
    <div className="free-time-viewport workspace-page-viewport"><div className="free-time-container workspace-page-container">
      <WorkspaceHeading className="free-time-header" title="余时" description="想推进的事，在合适的空档继续" titleId={`${id}-title`} headingRef={heading}><dl className="workspace-metrics free-time-metrics"><div><dt>自动安排中</dt><dd>{goals.filter(isScheduling).length}<small> 项</small></dd></div><div><dt>未来七天已安排</dt><dd>{minutesLabel(weekMinutes).split(/(\d+)/).filter(Boolean).map((part, index) => /\d/.test(part) ? <span key={index}>{part}</span> : <small key={index}>{part}</small>)}</dd></div><div><dt>最低频率待满足</dt><dd>{remaining}<small> 次</small></dd></div></dl></WorkspaceHeading>
      <StringInvitation onEnter={onOpenStrings} glass={glass} />
      <Pane className="free-time-wish-entry" blur={glass === 'soft' ? 6 : 0}><div><h3>把心愿聊清楚</h3><p>有个想法，还不知道从哪里开始？和析熙一起理清第一步。</p></div><button className="free-time-secondary" type="button" disabled={busy} onClick={() => { setNewWish(''); setEditing(null); setWishEditing(null); setTab('considering') }}>＋ 聊聊一个心愿</button>
        {newWish !== null && <form className="free-time-wish-start" onSubmit={event => { event.preventDefault(); void startWish() }}><label>你想做什么？<textarea autoFocus required maxLength={600} value={newWish} onChange={event => setNewWish(event.target.value)} placeholder="比如：想做一款自己的小游戏，但还没想好从哪开始" disabled={busy} /></label><p>先保留为心愿。你选择「加入自动安排」后才会占用日程。</p><div><button type="button" className="free-time-secondary" disabled={busy} onClick={() => setNewWish(null)}>取消</button><button type="submit" className="free-time-primary" disabled={busy || !newWish.trim()}>保存并聊清楚</button></div></form>}
      </Pane>
      <div className="free-time-layout">
        <Pane className="free-time-goals" blur={glass === 'soft' ? 6 : 0}><header className="free-time-pane-heading"><div className="free-time-tabs" role="group" aria-label="余时目标分类"><button type="button" aria-pressed={tab === 'goals'} onClick={() => { setTab('goals'); setEditing(null); setWishEditing(null) }}>目标 <small>{goals.length}</small></button><button type="button" aria-pressed={tab === 'considering'} onClick={() => { setTab('considering'); setEditing(null); setWishEditing(null) }}>待考虑 <small>{wishes.length}</small></button></div><button className="free-time-primary" type="button" onClick={() => { setWishEditing(null); setEditing({ draft: EMPTY_DRAFT }) }} disabled={busy}>＋ 添加目标</button></header>
          {wishEditing ? <WishEditor key={wishEditing.id} wish={wishEditing} busy={busy} onCancel={() => setWishEditing(null)} onSave={saveWish} /> : editing ? <GoalEditor key={editing.goal?.id ?? editing.wish?.id ?? 'new'} editing={editing} busy={busy} onCancel={() => setEditing(null)} onSave={save} /> : <>
            <label className="free-time-search"><span className="p0-sr-only">搜索余时目标</span><input type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder={tab === 'goals' ? '搜索目标' : '搜索想做的事'} /></label>
            {tab === 'considering' && <p className="free-time-note">原来的牵挂都在这里。选「加入自动安排」后，析熙才会为它留出时间。</p>}
            <div className="free-time-list-region">{loading && !state ? <Empty title="正在读取目标" /> : !state ? <Empty title="余时暂时无法读取" detail="请用下方重试重新连接本机服务。" /> : total === 0 ? <Empty title={filter ? '没有匹配的目标' : tab === 'goals' ? '给想做的事一点时间' : '暂时没有待考虑的事'} detail={filter ? '试试别的关键词。' : tab === 'goals' ? '单词、数学复习、FRC 学习，都可以从这里开始。' : '聊天中提到的愿望可以先留在这里，准备好后再加入安排。'} /> : tab === 'goals' ? <ul className="free-time-goal-list">{visibleGoals.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(goal => {
              const item = progress.find(value => value.goalId === goal.id)
              const lastFeedback = state?.freeTimeFeedback?.find(value => value.goalId === goal.id)
              const goalState = goal.status === 'paused' ? 'paused' : 'active'
              return <li key={goal.id} data-status={goalState} data-priority={goal.priority}><div className="free-time-goal-title"><strong>{goal.title}</strong><span>{goalState === 'active' ? PRIORITIES[goal.priority] : FREE_TIME_STATUS_LABEL[goalState]}</span></div><div className="free-time-goal-meta"><span>{goal.minPerWeek ? `每周至少 ${goal.minPerWeek} 次` : '不设最低频率'}</span><span>{goal.sessionMin}–{goal.sessionMax} 分钟 / 次</span></div>{(goal.targetNote || goal.targetDate) && <p className="free-time-goal-note">{goal.targetDate && `${dayLabel(goal.targetDate)} · `}{goal.targetNote || '阶段目标日期'}</p>}{lastFeedback?.nextStep && <p className="free-time-goal-note">下次继续：{lastFeedback.nextStep}</p>}<footer><span>{item ? `已安排 ${item.scheduledCount} 次${item.completedCount ? ` · 已完成 ${item.completedCount} 次` : ''}` : '还没有安排'}</span><div className="free-time-goal-actions"><button className="free-time-primary" type="button" disabled={busy} onClick={() => edit(goal)}>调整 <span aria-hidden="true">↗</span></button><button className="free-time-secondary" type="button" disabled={busy} onClick={() => void (goalState === 'active' ? updateStatus(goal, 'paused') : resumeGoal(goal))}>{goalState === 'active' ? '暂停' : '恢复并安排'}</button>{removing === goal.id ? <><span className="free-time-remove-note">取消未开始、未固定的安排</span><button className="free-time-secondary free-time-remove-confirm" type="button" disabled={busy} onClick={() => void updateStatus(goal, 'deleted')}>确认移除</button><button className="free-time-secondary" type="button" onClick={() => setRemoving(null)}>保留</button></> : <button className="free-time-secondary" type="button" disabled={busy} onClick={() => setRemoving(goal.id)}>移除</button>}</div></footer></li>
            })}</ul> : <ul className="free-time-goal-list">{visibleWishes.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(wish => <li key={wish.id}><div className="free-time-goal-title"><strong>{wish.content}</strong><span>{wish.status === 'paused' ? '已暂停' : wish.status === 'expired' ? '已到期' : '待考虑'}</span></div>{wish.clarification?.motivation && <p className="free-time-goal-note">想做到：{wish.clarification.motivation}</p>}{wish.clarification?.firstStep && <p className="free-time-goal-note">第一小步：{wish.clarification.firstStep}</p>}{wish.items.length > 0 && <p className="free-time-goal-note">准备：{wish.items.join('、')}</p>}<footer><span>{minutesLabel(wish.minutes)}</span><div className="free-time-goal-actions"><button className="free-time-secondary" type="button" disabled={busy} onClick={() => setWishEditing(wish)}>修改</button><button className="free-time-secondary" type="button" disabled={busy} onClick={() => onClarifyWish(wish)}>聊清楚</button>{wish.status !== 'expired' && <button className="free-time-secondary" type="button" disabled={busy} onClick={() => void updateWishStatus(wish)}>{wish.status === 'paused' ? '恢复留意' : '暂停留意'}</button>}<button className="free-time-primary" type="button" disabled={busy} onClick={() => migratedWish(wish)}>加入自动安排 <span aria-hidden="true">↗</span></button></div></footer></li>)}</ul>}</div>
            <Pagination page={currentPage} pages={pages} count={total} onPage={setPage} />
          </>}
        </Pane>
        <Pane className="free-time-plan" blur={glass === 'soft' ? 6 : 0}><header className="free-time-pane-heading"><div><h3>安排与留白</h3><p>学习有落点，也留一点喘息。</p></div><div className="free-time-tabs" role="group" aria-label="查看时间范围"><button type="button" aria-pressed={period === 'today'} onClick={() => { setPeriod('today'); setDate(today) }}>今天</button><button type="button" aria-pressed={period === 'week'} onClick={() => setPeriod('week')}>未来七天</button></div></header>
          {period === 'week' && <nav className="free-time-week" aria-label="查看每天的余时">{state?.timeline.map(day => <button key={day.date} type="button" aria-pressed={date === day.date} onClick={() => setDate(day.date)}><span>{dayLabel(day.date, true)}</span><strong>{Number(day.date.slice(-2))}</strong><small>{sessions.filter(session => session.date === day.date).length || '—'}</small></button>)}</nav>}
          <div className="free-time-day-heading"><strong>{dayLabel(date)}</strong><span>{shownDay ? `尚有 ${minutesLabel(shownDay.freeMin)} 留白` : '正在读取可用时段'}</span></div>
          <div className="free-time-plan-region">{shownSessions.length ? <ol className="free-time-sessions">{shownSessions.slice(currentPlanPage * 4, (currentPlanPage + 1) * 4).map(session => {
            const rest = state?.freeTimeBreaks?.find(item => item.date === session.date && item.start === session.end)
            return <li key={session.id} data-completed={session.completed}><div className="free-time-session"><time>{session.start}<small>{session.end}</small></time><div><strong>{session.title}</strong><span>{minutesLabel(minuteValue(session.end) - minuteValue(session.start))}{session.locked ? ' · 已固定' : ''}</span></div><button type="button" className="free-time-secondary free-time-complete" disabled={busy || session.completed} onClick={() => void completeSession(session.id)} aria-label={session.completed ? `${session.title}本次已完成` : `完成这次${session.title}`}>{session.completed ? '已完成' : '完成这次'}</button></div>{session.completed && <SessionFeedback sessionId={session.id} saved={state?.freeTimeFeedback?.find(item => item.sessionId === session.id)} busy={busy} onSave={saveFeedback} />}{rest && <div className="free-time-rest"><time>{rest.start}–{rest.end}</time><span>休息与留白 · {minutesLabel(minuteValue(rest.end) - minuteValue(rest.start))}</span></div>}</li>
          })}</ol> : <Empty title={loading ? '正在读取安排' : '这一天还没有余时安排'} detail={goals.some(goal => goal.status === 'active') ? '启用的目标会持续按频率安排到未来七天；也可以点击「安排余时」补齐空档。' : '添加一个目标，或恢复已暂停的目标，就可以开始安排。'} />}</div>
          {sessionPages > 1 && <Pagination page={currentPlanPage} pages={sessionPages} count={shownSessions.length} onPage={setPlanPage} />}
          {opportunity && <details className="free-time-opportunity"><summary>一个合适的机会：{opportunity.title}</summary><p>{opportunity.start}–{opportunity.end} 有候选空档，尚未写入日程。可在「待考虑」中加入自动安排。</p></details>}
          {shortfalls.length > 0 && <details className="free-time-shortfalls" open><summary>{shortfalls.length} 项目标还有频率缺口</summary><ul>{shortfalls.map(item => <li key={item.goalId}><strong>{item.title}</strong><span>已安排 {item.scheduled} / {item.required} 次 · {item.reason}</span></li>)}</ul></details>}
          <footer className="free-time-plan-actions"><span>{latestOperation ? <button type="button" disabled={busy} onClick={() => void undoSchedule()}>撤销这次排程</button> : '课程、已占用时段与固定安排优先保留'}</span><button className="free-time-primary" type="button" disabled={busy || loading || !state || !goals.length} onClick={() => void reschedule()}>{busy ? '正在安排…' : '安排余时'}<span aria-hidden="true">↗</span></button></footer>
        </Pane>
      </div>
      <div className="free-time-feedback" aria-live="polite">{error ? <p role="alert">{error}<button type="button" disabled={busy} onClick={() => { setError(''); void refresh().catch(reason => setError(errorText(reason))) }}>重新读取</button></p> : <p>{notice || '加入目标即允许在空余时间安排；可以随时暂停或固定时段。'}</p>}</div>
    </div></div>
  </section></GlassSamplingContext.Provider>
})

function Empty({ title, detail }: { title: string; detail?: string }) { return <div className="free-time-empty"><strong>{title}</strong>{detail && <span>{detail}</span>}</div> }
function minuteValue(time: string) { const [hour, minute] = time.split(':').map(Number); return hour * 60 + minute }
function Pagination({ page, pages, count, onPage }: { page: number; pages: number; count: number; onPage: (page: number) => void }) {
  return <nav className="free-time-pagination" aria-label="列表翻页"><span>共 {count} 项</span><div><button type="button" aria-label="上一页" disabled={page === 0} onClick={() => onPage(page - 1)}>←</button><span>{page + 1} / {pages}</span><button type="button" aria-label="下一页" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>→</button></div></nav>
}
function GoalEditor({ editing, busy, onCancel, onSave }: { editing: Editing; busy: boolean; onCancel: () => void; onSave: (draft: Draft) => Promise<void> }) {
  const id = useId()
  const [draft, setDraft] = useState(editing.draft)
  const submit = (event: FormEvent) => { event.preventDefault(); if (draft.title.trim()) void onSave(draft) }
  return <form className="free-time-editor" onSubmit={submit}>
    <div className="free-time-editor-heading"><strong>{editing.goal ? '调整目标' : editing.wish ? '把这份牵挂交给余时' : '想给什么留一点时间？'}</strong><button className="free-time-secondary" type="button" onClick={onCancel} disabled={busy}>返回列表</button></div>
    <div className="free-time-editor-fields"><label htmlFor={`${id}-title`}>目标名称<input id={`${id}-title`} required maxLength={160} value={draft.title} onChange={event => setDraft(value => ({ ...value, title: event.target.value }))} disabled={busy} placeholder="例如：数学复习、SAT 单词、FRC 学习" autoFocus /></label>
      <div className="free-time-form-grid"><label>优先级<select value={draft.priority} onChange={event => setDraft(value => ({ ...value, priority: event.target.value as Draft['priority'] }))} disabled={busy}>{Object.entries(PRIORITIES).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>每周至少<span className="free-time-unit"><input type="number" required min={0} max={14} step={1} value={draft.minPerWeek} onChange={event => setDraft(value => ({ ...value, minPerWeek: event.target.value }))} disabled={busy} />次</span></label></div>
      <fieldset><legend>单次时长偏好</legend><div className="free-time-duration"><label><span className="p0-sr-only">单次最短分钟数</span><input type="number" required min={5} max={720} step={1} value={draft.sessionMin} onChange={event => setDraft(value => ({ ...value, sessionMin: event.target.value }))} disabled={busy} /></label><span>至</span><label><span className="p0-sr-only">单次最长分钟数</span><input type="number" required min={5} max={720} step={1} value={draft.sessionMax} onChange={event => setDraft(value => ({ ...value, sessionMax: event.target.value }))} disabled={busy} /></label><span>分钟</span></div></fieldset>
      <label>阶段目标 <span className="free-time-optional">可选</span><input maxLength={600} value={draft.targetNote} onChange={event => setDraft(value => ({ ...value, targetNote: event.target.value }))} disabled={busy} placeholder="例如：月考前补好函数，或学会 PID 控制" /></label><label>目标日期 <span className="free-time-optional">可选</span><input type="date" value={draft.targetDate} onChange={event => setDraft(value => ({ ...value, targetDate: event.target.value }))} disabled={busy} /></label>
    </div><footer><p>{editing.goal?.status === 'paused' ? '目标仍保持暂停，恢复后参与安排。' : '保存后会在空余时段安排，已有课程和任务优先保留。'}</p><button type="submit" className="free-time-primary" disabled={busy || !draft.title.trim()}>{busy ? '正在保存…' : editing.goal ? '保存调整' : '加入自动安排'}</button></footer>
  </form>
}


type WishDraft = { content: string; evidence: string; minutes: string; items: string; expiresAt: string }
function WishEditor({ wish, busy, onCancel, onSave }: { wish: Wish; busy: boolean; onCancel: () => void; onSave: (wish: Wish, draft: WishDraft) => Promise<void> }) {
  const [draft, setDraft] = useState<WishDraft>({ content: wish.content, evidence: wish.evidence, minutes: String(wish.minutes), items: wish.items.join('\n'), expiresAt: wish.expiresAt ? localDay(new Date(wish.expiresAt)) : '' })
  return <form className="free-time-editor" onSubmit={event => { event.preventDefault(); if (draft.content.trim()) void onSave(wish, draft) }}><div className="free-time-editor-heading"><strong>修改这份牵挂</strong><button className="free-time-secondary" type="button" onClick={onCancel} disabled={busy}>返回列表</button></div><div className="free-time-editor-fields">
    <label>想做什么<textarea rows={2} maxLength={600} required disabled={busy} value={draft.content} onChange={event => setDraft(value => ({ ...value, content: event.target.value }))} /></label>
    <div className="free-time-form-grid"><label>大概需要多久<span className="free-time-unit"><input type="number" min={5} max={720} step={1} required disabled={busy} value={draft.minutes} onChange={event => setDraft(value => ({ ...value, minutes: event.target.value }))} />分钟</span></label><label>留意到哪天<input type="date" disabled={busy} value={draft.expiresAt} onChange={event => setDraft(value => ({ ...value, expiresAt: event.target.value }))} /></label></div>
    <label>背景<textarea rows={2} maxLength={2000} disabled={busy} value={draft.evidence} onChange={event => setDraft(value => ({ ...value, evidence: event.target.value }))} /></label>
    <label>准备物品或条件<textarea rows={2} maxLength={6000} disabled={busy} value={draft.items} onChange={event => setDraft(value => ({ ...value, items: event.target.value }))} placeholder="每行一项" /></label>
  </div><footer><p>仅更新待考虑的内容，不会自动加入日程。</p><button type="submit" className="free-time-primary" disabled={busy || !draft.content.trim()}>保存牵挂</button></footer></form>
}


function SessionFeedback({ sessionId, saved, busy, onSave }: { sessionId: string; saved?: CompanionState['freeTimeFeedback'][number]; busy: boolean; onSave: (sessionId: string, feedback: 'smooth' | 'stuck' | 'continue', nextStep: string) => Promise<void> }) {
  const [feedback, setFeedback] = useState<'smooth' | 'stuck' | 'continue'>(saved?.feedback ?? 'smooth')
  const [nextStep, setNextStep] = useState(saved?.nextStep ?? '')
  useEffect(() => { setFeedback(saved?.feedback ?? 'smooth'); setNextStep(saved?.nextStep ?? '') }, [saved?.feedback, saved?.nextStep])
  return <details className="free-time-feedback-editor"><summary>{saved ? `${({ smooth: '顺利', stuck: '有点卡', continue: '下次继续' } as const)[saved.feedback]}${saved.nextStep ? ` · 下次：${saved.nextStep}` : ' · 补充下一步'}` : '留一句反馈或下一步'}</summary><div><div className="free-time-feedback-picks" role="group" aria-label="本次学习感受">{([['smooth', '顺利'], ['stuck', '有点卡'], ['continue', '下次继续']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={feedback === value} disabled={busy} onClick={() => setFeedback(value)}>{label}</button>)}</div><label>下次从哪里继续<input value={nextStep} maxLength={600} placeholder="可选，例如从定义域那题继续" disabled={busy} onChange={event => setNextStep(event.target.value)} /></label><button className="free-time-primary" type="button" disabled={busy} onClick={() => void onSave(sessionId, feedback, nextStep)}>记住这次反馈</button></div></details>
}
