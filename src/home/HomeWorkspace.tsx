import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Task, TaskStatus } from '../domain/task'
import type { SceneCamera } from '../spatial/scene'
import { readableDate, STATUS_LABELS } from '../spatial/scene'
import { useSceneCamera } from '../spatial/useSceneCamera'
import { useSpatialTasks } from '../spatial/useSpatialTasks'
import { GlassSurface, MeasuredGlassSurface } from './GlassSurface'
import './home.css'

type Props = {
  readCamera: () => SceneCamera | undefined
  onViewChange: (view: 'panorama' | 'interstellar') => void
  sceneUnavailable: boolean
}
const DRAFT_KEY = 'astaria-home-draft'
function readDraft() { try { return sessionStorage.getItem(DRAFT_KEY) ?? '' } catch { return '' } }

export function HomeWorkspace({ readCamera, onViewChange, sceneUnavailable }: Props) {
  const data = useSpatialTasks()
  const [chatOpen, setChatOpen] = useState(false)
  const camera = useSceneCamera(readCamera, String(chatOpen))
  const [cameraMissing, setCameraMissing] = useState(false)
  const progress = sceneUnavailable || cameraMissing ? Number(chatOpen) : Math.max(0, Math.min(1, (camera.zoom - .7) / (2.05 - .7)))
  const [menuOpen, setMenuOpen] = useState(false)
  const [draft, setDraft] = useState(readDraft)
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
  const menuTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const focusAfterTransition = useRef(false)
  const taskOpener = useRef<HTMLElement | null>(null)

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
  useEffect(() => {
    try { sessionStorage.setItem(DRAFT_KEY, draft); setDraftWarning('') }
    catch { setDraftWarning(draft ? '草稿暂未保存，离开页面前请复制' : '') }
  }, [draft])
  useEffect(() => {
    if (!focusAfterTransition.current || (!(sceneUnavailable || cameraMissing) && camera.cameraTransition) || (chatOpen ? progress < .99 : progress > .01)) return
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
  }, [chatOpen, camera.cameraTransition, progress, sceneUnavailable, cameraMissing])

  const changeChat = (open: boolean) => {
    clearTimeout(menuTimer.current)
    setMenuOpen(false)
    if (open === chatOpen) return
    focusAfterTransition.current = true
    setCameraMissing(!readCamera())
    // Use the frozen P0 preset. The UI reads its progress; it never steers uniforms.
    onViewChange(open ? 'interstellar' : 'panorama')
    setChatOpen(open)
  }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || selectedId) return
      if (menuOpen) { event.preventDefault(); brand.current?.focus(); setMenuOpen(false) }
      else if (chatOpen) { event.preventDefault(); changeChat(false) }
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
      compose.current?.focus()
    } catch (reason) { setSaveError(reason instanceof Error ? reason.message : '保存失败，请保留原文后重试') }
  }
  const openTask = (id: string) => {
    taskOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSelectedId(id)
  }
  const closeTask = () => {
    setSelectedId(null)
    requestAnimationFrame(() => {
      const previous = taskOpener.current
      ;(previous?.isConnected && !previous.closest('[inert]') ? previous : chatOpen ? compose.current : currentButton.current)?.focus()
    })
  }
  const startTop = layout.taskBottom + 12
  const endTop = Math.max(84, layout.height * .19)
  const endWidth = Math.min(300, layout.width - (layout.width <= 600 ? 44 : 68))
  const endHeight = Math.max(180, Math.min(390, layout.height - endTop - 65))
  const width = 128 + (endWidth - 128) * progress
  const height = 38 + (endHeight - 38) * progress
  const radius = 19 + (15 - 19) * progress
  const chatVisible = progress > .35

  return <div ref={root} className="home-workspace" data-spatial-ui data-chat-open={chatOpen}>
    <nav ref={nav} className="home-nav" aria-label="ASTaria 导航"
      onPointerEnter={event => { if (event.pointerType !== 'touch') { clearTimeout(menuTimer.current); setMenuOpen(true) } }}
      onPointerLeave={() => { menuTimer.current = setTimeout(() => { if (!nav.current?.contains(document.activeElement)) setMenuOpen(false) }, 180) }}
      onFocus={() => { clearTimeout(menuTimer.current); setMenuOpen(true) }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false) }}>
      <button ref={brand} className="home-brand" aria-expanded={menuOpen} aria-controls="home-menu" onClick={() => setMenuOpen(true)}>AST<span>aria</span></button>
      <div id="home-menu" className="home-menu" hidden={!menuOpen}>
        <MeasuredGlassSurface radius={13} />
        <ul className="home-menu-list">
          <li><button aria-current="page" onClick={() => { changeChat(false); brand.current?.focus(); setMenuOpen(false) }}>首页</button></li>
          {['工作台', '时间表', '日历', 'DDL'].map(label => <li key={label}><button disabled>{label}<span>稍后</span></button></li>)}
        </ul>
      </div>
    </nav>

    <div ref={current} className="home-current" style={{ opacity: Math.max(0, 1 - progress * 3), visibility: progress > .6 ? 'hidden' : 'visible' }} inert={chatOpen}>
      <span>当前任务</span>
      <button ref={currentButton} className="home-current-title" onClick={() => data.loadError ? data.retry() : currentTask ? openTask(currentTask.id) : changeChat(true)}
        disabled={data.loading} aria-label={currentTask && !data.loadError ? `${currentTask.title}，${STATUS_LABELS[currentTask.status]}，打开任务详情` : undefined}>
        {data.loading ? '正在读取事项' : data.loadError ? '读取失败，点击重试' : currentTask?.title ?? '今天还没有事项'}
      </button>
    </div>

    <div className="home-morph" style={{ top: startTop + (endTop - startTop) * progress, width, height, borderRadius: radius }} data-progress={progress.toFixed(3)}>
      <GlassSurface width={Math.round(width)} height={Math.round(height)} radius={radius} progress={progress} />
      <button ref={launch} className="home-launch" onClick={() => changeChat(true)} aria-expanded={chatOpen} aria-controls="home-xixi"
        style={{ opacity: Math.max(0, 1 - progress * 4), visibility: progress > .35 ? 'hidden' : 'visible' }} disabled={chatOpen}>交给析熙</button>
      <section id="home-xixi" className="home-xixi" aria-label="析熙" inert={!chatOpen || progress < .96}
        style={{ opacity: Math.max(0, Math.min(1, (progress - .45) / .55)), visibility: chatVisible ? 'visible' : 'hidden' }}>
        <header><strong>析熙</strong><button className="home-collapse" onClick={() => changeChat(false)}>收起</button></header>
        <div className="home-conversation" role="log" aria-label="事项录入记录" aria-live="polite">
          {receipts.length === 0 && <p className="home-greeting">有什么事，交给我</p>}
          {receipts.map(task => <div className="home-receipt" key={task.id}><span>已记为事项</span><button onClick={() => openTask(task.id)}>{task.title}</button></div>)}
        </div>
        <form onSubmit={event => void submit(event)}>
          <label className="p0-sr-only" htmlFor="home-compose">写下你的事情，第一行是标题，其余是备注</label>
          <textarea ref={compose} id="home-compose" placeholder="写下你的事情" rows={2} maxLength={2161} value={draft} disabled={data.saving}
            onChange={event => setDraft(event.target.value)} onKeyDown={event => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() }
            }} />
          <div className="home-compose-actions"><small>对话稍后接入</small><button className="home-capture" type="submit" disabled={data.saving || data.loading || Boolean(data.loadError) || !draft.trim()}>{data.saving ? '正在保存' : '记为事项'}</button></div>
          {(saveError || draftWarning || data.loadError) && <p className="home-form-error" role="alert">{saveError || draftWarning || data.loadError}{data.loadError && <button type="button" onClick={data.retry}>重试读取</button>}</p>}
        </form>
      </section>
    </div>
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
