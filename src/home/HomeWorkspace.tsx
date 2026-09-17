import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Task, TaskStatus } from '../domain/task'
import type { SceneCamera } from '../spatial/scene'
import { readableDate, STATUS_LABELS } from '../spatial/scene'
import { useSceneCamera } from '../spatial/useSceneCamera'
import { useSpatialTasks } from '../spatial/useSpatialTasks'
import { GlassSurface, MeasuredGlassSurface } from './GlassSurface'
import { HomeStatus } from './HomeStatus'
import { HomeAgenda } from './HomeAgenda'
import { useLocalTime } from './useLocalTime'
import { Workbench } from '../workbench/Workbench'
import './home.css'

type Props = {
  readCamera: () => SceneCamera | undefined
  onViewChange: (view: 'panorama' | 'interstellar') => void
  onThemeChange: (night: boolean) => void
  sceneUnavailable: boolean
}
const DRAFT_KEY = 'astaria-home-draft'
function readDraft() { try { return sessionStorage.getItem(DRAFT_KEY) ?? '' } catch { return '' } }

export function HomeWorkspace({ readCamera, onViewChange, onThemeChange, sceneUnavailable }: Props) {
  const data = useSpatialTasks()
  const now = useLocalTime()
  const [page, setPage] = useState<'home' | 'workbench'>('home')
  const [notification, setNotification] = useState('')
  const [deadlineRequest, setDeadlineRequest] = useState(0)
  const [chatOpen, setChatOpen] = useState(false)
  const [informationActive, setInformationActive] = useState(false)
  const camera = useSceneCamera(readCamera, String(chatOpen))
  const [cameraMissing, setCameraMissing] = useState(false)
  const progress = sceneUnavailable || cameraMissing ? Number(chatOpen) : Math.max(0, Math.min(1, (camera.zoom - .7) / (2.05 - .7)))
  const [menuOpen, setMenuOpen] = useState(false)
  const [draft, setDraft] = useState(readDraft)
  const [inputPulse, setInputPulse] = useState<number | null>(null)
  const inputPulseSequence = useRef(0)
  const [draftWarning, setDraftWarning] = useState('')
  const [saveError, setSaveError] = useState('')
  const [savedIds, setSavedIds] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [layout, setLayout] = useState({ width: innerWidth, height: innerHeight, taskBottom: innerHeight * .43 + 49 })
  const root = useRef<HTMLDivElement>(null)
  const nav = useRef<HTMLElement>(null)
  const brand = useRef<HTMLButtonElement>(null)
  const current = useRef<HTMLDivElement>(null)
  const currentButton = useRef<HTMLButtonElement>(null)
  const launch = useRef<HTMLButtonElement>(null)
  const compose = useRef<HTMLTextAreaElement>(null)
  const informationToggle = useRef<HTMLButtonElement>(null)
  const menuTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const menuOpenedByHover = useRef(false)
  const focusAfterTransition = useRef(false)
  const taskOpener = useRef<HTMLElement | null>(null)
  const taskFromAgenda = useRef(false)
  const compact = layout.width < 748

  useEffect(() => {
    if (compact && document.activeElement?.closest('.home-agenda')) setInformationActive(true)
  }, [compact])

  const currentTask = useMemo(() => data.tasks.filter(task => task.status === 'doing' || task.status === 'todo')
    .sort((a, b) => Number(b.status === 'doing') - Number(a.status === 'doing')
      || (a.due ?? '9999').localeCompare(b.due ?? '9999')
      || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0], [data.tasks])
  const selectedTask = data.tasks.find(task => task.id === selectedId)
  const receipts = savedIds.map(id => data.tasks.find(task => task.id === id)).filter((task): task is Task => Boolean(task))

  useEffect(() => {
    const measure = () => {
      if (!root.current || !current.current) return
      const box = root.current.getBoundingClientRect()
      setLayout({ width: box.width, height: box.height, taskBottom: current.current.getBoundingClientRect().bottom - box.top })
    }
    const observer = new ResizeObserver(measure)
    if (root.current) observer.observe(root.current)
    if (current.current) observer.observe(current.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => () => clearTimeout(menuTimer.current), [])
  const stopInputPulse = () => setInputPulse(null)
  const flashInput = () => setInputPulse(++inputPulseSequence.current)
  useEffect(() => { if (!chatOpen || (compact && informationActive)) stopInputPulse() }, [chatOpen, compact, informationActive])
  useEffect(() => {
    if (!menuOpen) { menuOpenedByHover.current = false; return }
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !nav.current?.contains(event.target)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [menuOpen])
  useEffect(() => {
    try { sessionStorage.setItem(DRAFT_KEY, draft); setDraftWarning('') }
    catch { setDraftWarning(draft ? '草稿暂未保存，离开页面前请复制' : '') }
  }, [draft])
  useEffect(() => {
    if (page !== 'home' || !focusAfterTransition.current || (!(sceneUnavailable || cameraMissing) && camera.cameraTransition) || (chatOpen ? progress < .99 : progress > .01)) return
    let frame = 0
    let attempts = 0
    const focus = () => {
      const target = chatOpen ? compose.current : launch.current
      // Removing inert and visibility in an immediate camera change can take an
      // additional style pass. Keep the pending focus until it actually lands.
      target?.focus()
      if (document.activeElement === target) focusAfterTransition.current = false
      else if (++attempts < 8) frame = requestAnimationFrame(focus)
    }
    frame = requestAnimationFrame(focus)
    return () => cancelAnimationFrame(frame)
  }, [page, chatOpen, camera.cameraTransition, progress, sceneUnavailable, cameraMissing])

  const changeChat = (open: boolean) => {
    clearTimeout(menuTimer.current)
    setMenuOpen(false)
    if (open === chatOpen) return
    if (open) setInformationActive(false)
    focusAfterTransition.current = true
    setCameraMissing(!readCamera())
    // Use the frozen P0 preset. The UI reads its progress; it never steers uniforms.
    onViewChange(open ? 'interstellar' : 'panorama')
    setChatOpen(open)
  }
  const changePage = (next: 'home' | 'workbench', openChat = false) => {
    clearTimeout(menuTimer.current)
    if (next === page) brand.current?.focus({ preventScroll: true })
    setMenuOpen(false)
    setSelectedId(null)
    setPage(next)
    onThemeChange(next === 'home')
    if (next === 'workbench') {
      focusAfterTransition.current = false
      setChatOpen(false)
      onViewChange('panorama')
    } else {
      focusAfterTransition.current = true
      setCameraMissing(!readCamera())
      setChatOpen(openChat)
      setInformationActive(false)
      onViewChange(openChat ? 'interstellar' : 'panorama')
    }
  }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || selectedId) return
      if (menuOpen) { event.preventDefault(); brand.current?.focus(); setMenuOpen(false) }
      else if (page === 'home' && chatOpen) { event.preventDefault(); changeChat(false) }
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  })
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!draft.trim() || data.saving || data.loading || data.loadError) return
    setSaveError('')
    const lines = draft.trim().split(/\r?\n/)
    const title = lines[0].trim()
    if (title.length > 160) { setSaveError('第一行作为事项名称，请控制在 160 字以内'); return }
    try {
      const task = await data.create({ title, notes: lines.slice(1).join('\n') })
      setSavedIds(ids => [...ids, task.id])
      setDraft('')
      stopInputPulse()
      compose.current?.focus()
    } catch (reason) { setSaveError(reason instanceof Error ? reason.message : '保存失败，请保留原文后重试') }
  }
  const openTask = (id: string) => {
    taskOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    taskFromAgenda.current = Boolean(taskOpener.current?.closest('.home-agenda'))
    setSelectedId(id)
  }
  const closeTask = () => {
    setSelectedId(null)
    requestAnimationFrame(() => {
      const previous = taskOpener.current
      const fallback = chatOpen ? taskFromAgenda.current
        ? compact && !informationActive ? informationToggle.current : root.current?.querySelector<HTMLElement>('.home-agenda-scroll')
        : compose.current : currentButton.current
      ;(previous?.isConnected && !previous.closest('[inert]') ? previous : fallback)?.focus()
    })
  }
  const startTop = layout.taskBottom + 12
  const endWidth = Math.min(340, layout.width - (layout.width <= 600 ? 44 : 68))
  const endHeight = Math.max(180, Math.min(460, layout.height - 149))
  const endTop = Math.max(84, (layout.height - endHeight) / 2)
  const width = 128 + (endWidth - 128) * progress
  // Extend only the UI surface, reading the existing camera transition.
  const extendedWidth = width + (compact ? 0 : endWidth * Math.max(0, (progress - .5) / .5))
  const height = 38 + (endHeight - 38) * progress
  const radius = 19 + (15 - 19) * progress
  const chatVisible = progress > .35

  return <div ref={root} className="home-workspace" data-spatial-ui data-chat-open={chatOpen} data-page={page}>
    <nav ref={nav} className="home-nav" aria-label="ASTaria 导航" data-menu-open={menuOpen}
      onPointerEnter={event => { if (event.pointerType !== 'touch') { clearTimeout(menuTimer.current); menuOpenedByHover.current = !menuOpen; setMenuOpen(true) } }}
      onPointerLeave={() => { menuTimer.current = setTimeout(() => { if (!nav.current?.contains(document.activeElement)) setMenuOpen(false) }, 180) }}
      onFocus={() => clearTimeout(menuTimer.current)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false) }}>
      <button ref={brand} className="home-brand" aria-expanded={menuOpen} aria-controls="home-menu" title="ASTaria 导航" onClick={event => {
        // The pointer opens a hover preview before its first click reaches us.
        // Keep that first click open; subsequent clicks and keyboard activation toggle.
        const keepOpen = event.detail > 0 && menuOpenedByHover.current
        menuOpenedByHover.current = false
        setMenuOpen(open => keepOpen || !open)
      }}>
        <span className="home-brand-wordmark">AST<span>aria</span></span>
        <svg className="home-nav-hint" viewBox="0 0 10 10" aria-hidden="true"><path d="m3.5 2 3 3-3 3" /></svg>
      </button>
      <div id="home-menu" className="home-menu" data-open={menuOpen} inert={!menuOpen} aria-hidden={!menuOpen}>
        <MeasuredGlassSurface radius={13} />
        <ul className="home-menu-list">
          <li><button aria-current={page === 'home' ? 'page' : undefined} onClick={() => changePage('home')}>首页</button></li>
          <li><button aria-current={page === 'workbench' ? 'page' : undefined} onClick={() => changePage('workbench')}>工作台</button></li>
          {['时间表', '日历'].map(label => <li key={label}><button disabled title="稍后开放">{label}<span className="p0-sr-only">，稍后开放</span></button></li>)}
          <li><button onClick={() => { changePage('workbench'); setDeadlineRequest(value => value + 1) }} title="查看工作台的截止事项">DDL</button></li>
          <li><button disabled title="稍后开放">设置<span className="p0-sr-only">，稍后开放</span></button></li>
        </ul>
      </div>
    </nav>
    <HomeStatus now={now} showClock={!sceneUnavailable} notification={notification} />

    <div className="home-scene-ui" inert={page !== 'home'} aria-hidden={page !== 'home'}>
    <div ref={current} className="home-current" style={{ opacity: Math.max(0, 1 - progress * 3), visibility: progress > .6 ? 'hidden' : 'visible' }} inert={chatOpen}>
      <span>当前任务</span>
      <button ref={currentButton} className="home-current-title" onClick={() => data.loadError ? data.retry() : currentTask ? openTask(currentTask.id) : changeChat(true)}
        disabled={data.loading} aria-label={currentTask && !data.loadError ? `${currentTask.title}，${STATUS_LABELS[currentTask.status]}，打开任务详情` : undefined}>
        {data.loading ? '正在读取事项' : data.loadError ? '读取失败，点击重试' : currentTask?.title ?? '今天还没有事项'}
      </button>
    </div>

    <div className="home-morph" style={{ top: startTop + (endTop - startTop) * progress, width: extendedWidth, height, borderRadius: radius }} data-progress={progress.toFixed(3)} data-compact={compact} data-information-active={informationActive}>
      <GlassSurface width={Math.round(extendedWidth)} height={Math.round(height)} radius={radius} progress={progress} />
      <button ref={launch} className="home-launch" onClick={() => changeChat(true)} aria-expanded={chatOpen} aria-controls="home-xixi"
        style={{ opacity: Math.max(0, 1 - progress * 4), visibility: progress > .35 ? 'hidden' : 'visible' }} disabled={chatOpen}>交给析熙</button>
      <div className="home-deck" style={{ opacity: Math.max(0, Math.min(1, (progress - .45) / .55)), visibility: chatVisible ? 'visible' : 'hidden' }}>
      <div className="home-pane-track" style={{ width: endWidth * 2, transform: `translateX(${compact && informationActive ? -endWidth : 0}px)` }}>
      <section id="home-xixi" className="home-xixi" aria-label="析熙" inert={!chatOpen || progress < .99 || (compact && informationActive)} aria-hidden={!chatOpen || (compact && informationActive)}>
        <header><div className="home-chat-title">
          <button className="home-collapse" onClick={() => changeChat(false)} aria-label="收起析熙" title="收起析熙">
            <svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" /><path d="m5 5 4 4m0-4-4 4" /></svg>
          </button>
          <strong>析熙</strong>
        </div>{compact && <button ref={informationToggle} className="home-information-toggle" onClick={() => setInformationActive(true)} aria-controls="home-agenda">日程 →</button>}</header>
        <div className="home-conversation" role="log" aria-label="事项录入记录" aria-live="polite">
          {receipts.length === 0 && <p className="home-greeting">有什么事，交给我</p>}
          {receipts.map(task => <div className="home-receipt" key={task.id}><span>已记为事项</span><button onClick={() => openTask(task.id)}>{task.title}</button></div>)}
        </div>
        <form onSubmit={event => void submit(event)}>
          <label className="p0-sr-only" htmlFor="home-compose">写下你的事情，第一行是标题，其余是备注</label>
          <div className="home-input-shell" data-pulsing={inputPulse !== null}>
          {inputPulse !== null && <span key={inputPulse} className="home-input-flash" aria-hidden="true" onAnimationEnd={event => {
            if (event.target === event.currentTarget) setInputPulse(current => current === inputPulse ? null : current)
          }}>
            <span className="home-input-glow" />
            <span className="home-input-rim" />
          </span>}
          <textarea ref={compose} id="home-compose" placeholder="写下你的事情" rows={2} maxLength={2161} value={draft} disabled={data.saving}
            onChange={event => {
              const value = event.target.value
              const inputType = (event.nativeEvent as InputEvent).inputType
              if (value !== draft && (inputType ? inputType.startsWith('insert') : value.length > draft.length)) flashInput()
              setDraft(value)
            }} onBlur={stopInputPulse} onKeyDown={event => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() }
            }} />
          </div>
          <div className="home-compose-actions"><small>对话稍后接入</small><button className="home-capture" type="submit" disabled={data.saving || data.loading || Boolean(data.loadError) || !draft.trim()}>{data.saving ? '正在保存' : '记为事项'}</button></div>
          {(saveError || draftWarning || data.loadError) && <p className="home-form-error" role="alert">{saveError || draftWarning || data.loadError}{data.loadError && <button type="button" onClick={data.retry}>重试读取</button>}</p>}
        </form>
      </section>
      <HomeAgenda tasks={data.tasks} now={now} loading={data.loading} error={data.loadError}
        active={page === 'home' && chatOpen && progress >= .99 && (!compact || informationActive)} compact={compact}
        onRetry={data.retry} onTask={openTask} onChat={() => {
          setInformationActive(false)
          requestAnimationFrame(() => informationToggle.current?.focus({ preventScroll: true }))
        }} />
      </div>
      </div>
    </div>
    </div>
    <Workbench active={page === 'workbench'} deadlineRequest={deadlineRequest} data={data} now={now} onCapture={() => changePage('home', true)} onNotice={setNotification} />
    {selectedId && <TaskDialog task={selectedTask} saving={data.saving} onClose={closeTask} onStatus={data.setStatus} />}
  </div>
}

function TaskDialog({ task, saving, onClose, onStatus }: {
  task: Task | undefined; saving: boolean; onClose: () => void; onStatus: (id: string, status: TaskStatus) => Promise<Task>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [error, setError] = useState('')
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close() }, [])
  return <dialog ref={dialog} className="home-task-dialog" aria-labelledby="home-task-heading" onCancel={event => { event.preventDefault(); if (!saving) onClose() }} onKeyDown={event => event.stopPropagation()}>
    <header><h2 id="home-task-heading">任务详情</h2><button onClick={onClose} disabled={saving} aria-label="关闭任务详情">关闭</button></header>
    {task ? <>
      <p className="home-task-title">{task.title}</p>
      {task.notes && <p className="home-task-notes">{task.notes}</p>}
      <p className="home-task-meta">{readableDate(task.due)}</p>
      <div className="home-task-status" role="group" aria-label="任务状态">{(['todo', 'doing', 'done', 'dropped'] as const).map(status => <button key={status} aria-pressed={task.status === status} disabled={saving || task.status === status} onClick={async () => {
        setError(''); try { await onStatus(task.id, status) } catch (reason) { setError(reason instanceof Error ? reason.message : '状态保存失败，请重试') }
      }}>{STATUS_LABELS[status]}</button>)}</div>
      <p className="p0-sr-only" role="status">{STATUS_LABELS[task.status]}</p>
    </> : <p>这条事项已不在本地记录中</p>}
    {error && <p className="home-form-error" role="alert">{error}</p>}
  </dialog>
}
