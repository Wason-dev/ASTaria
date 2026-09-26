import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Task, TaskStatus } from '../domain/task'
import type { SceneCamera } from '../spatial/scene'
import { readableDate, STATUS_LABELS } from '../spatial/scene'
import { useSceneCamera } from '../spatial/useSceneCamera'
import { useSpatialTasks } from '../spatial/useSpatialTasks'
import { GlassSamplingContext, GlassSurface, MeasuredGlassSurface } from './GlassSurface'
import { HomeStatus } from './HomeStatus'
import { HomeAgenda } from './HomeAgenda'
import { HomeDeadlinePicker } from './HomeDeadlinePicker'
import { useLocalTime } from './useLocalTime'
import { Workbench } from '../workbench/Workbench'
import { useAppearance } from '../workbench/appearance'
import { useXixiConversation } from '../xixi/useXixiConversation'
import { ConversationLog } from '../xixi/ConversationLog'
import { ConversationMenu } from '../xixi/ConversationMenu'
import { useChatSubmitKey } from '../xixi/useChatSubmitKey'
import { restoreWithdrawnDraft } from '../xixi/draft'
import { selectCurrentTask } from './currentTask'
import { LocalSettings } from '../xixi/LocalSettings'
import { notifyLocalDataChange } from '../stores/migration'
import { localApi } from '../xixi/api'
import { localDay } from './agenda'
import { PlannerWorkspace } from '../planner/PlannerWorkspace'
import type { PlannerPage } from '../planner/PlannerWorkspace'
import type { ResponseEffectSettings, ResponsePhase } from '../prototype/responseEffects'
import type { RenderProfile, RenderScene } from '../prototype/renderProfile'
import { usePreferences, notificationsAllowed } from '../xixi/preferences'
import { OrbitStudio } from '../xixi/OrbitStudio'
import { FreeTimePanel } from '../xixi/FreeTimePanel'
import { useXixiNotice } from '../xixi/useXixiNotice'
import { BlackHoleEntry } from './BlackHoleEntry'
import './home.css'
import './scrollbars.css'
import './theme.css'
import '../ui/card-edges.css'

type Props = {
  readCamera: () => SceneCamera | undefined
  onViewChange: (view: 'panorama' | 'interstellar') => void
  onThemeChange: (night: boolean) => void
  sceneUnavailable: boolean
  onResponseEffect: (settings: ResponseEffectSettings) => void
  onResponsePhase: (phase: ResponsePhase) => void
  onRenderProfile: (profile: RenderProfile, scene: RenderScene) => void
}
const DRAFT_KEY = 'astaria-home-draft'
type WorkspacePage = 'home' | 'workbench' | 'settings' | 'companion' | 'free-time' | PlannerPage
function readDraft() { try { return sessionStorage.getItem(DRAFT_KEY) ?? '' } catch { return '' } }

export function HomeWorkspace({ readCamera, onViewChange, onThemeChange, onResponseEffect, onResponsePhase, onRenderProfile, sceneUnavailable }: Props) {
  const data = useSpatialTasks()
  const now = useLocalTime()
  const today = localDay(now)
  useEffect(() => {
    let current = true
    void localApi<{ operation: { id: string } | null }>('/companion/free-time/ensure', {}).then(result => {
      if (current && result.operation) notifyLocalDataChange()
    }).catch(() => undefined)
    return () => { current = false }
  }, [today])
  const [page, setPage] = useState<WorkspacePage>('home')
  const [freeTimeMounted, setFreeTimeMounted] = useState(false)
  useEffect(() => { if (page === 'free-time') setFreeTimeMounted(true) }, [page])
  const appearance = useAppearance()
  const preferences = usePreferences()
  const started = useRef(false)
  const [stringsOpen, setStringsOpen] = useState(false)
  const stringsOpener = useRef<HTMLElement | null>(null)
  const [stringCovered, setStringCovered] = useState(false)
  const [previewPhase, setPreviewPhase] = useState<ResponsePhase | null>(null)
  useEffect(() => {
    onThemeChange(appearance.value.theme === 'dark')
  }, [appearance.value.theme, onThemeChange])
  const [notification, setNotification] = useState('')
  const proactiveNotice = useXixiNotice(preferences.value, preferences.loaded)
  useEffect(() => { if (!notification) return; const timer = setTimeout(() => setNotification(''), 12000); return () => clearTimeout(timer) }, [notification])
  const chat = useXixiConversation(() => { data.retry(); notifyLocalDataChange() }, setNotification)
  useEffect(() => { onResponseEffect(preferences.value.effect) }, [preferences.value.effect, onResponseEffect])
  useEffect(() => { onRenderProfile(preferences.value.render?.profile ?? 'full', page === 'home' ? 'home' : 'workspace') }, [preferences.value.render?.profile, page, onRenderProfile])
  useEffect(() => { onResponsePhase(page === 'settings' ? previewPhase ?? chat.responsePhase : chat.responsePhase) }, [page, previewPhase, chat.responsePhase, onResponsePhase])
  useEffect(() => () => onResponsePhase('idle'), [onResponsePhase])
  useEffect(() => { if (page !== 'settings') setPreviewPhase(null) }, [page])
  useEffect(() => {
    if (!preferences.loaded) return
    const value = preferences.value
    appearance.setValue(current => ({ ...current, theme: value.theme, ...(value.glass === 'soft' ? { blur: 6 } : { blur: 0 }), font: value.density === 'comfortable' ? 14 : 13, gap: value.density === 'comfortable' ? 12 : 8 }))
    if (!started.current) { started.current = true; setPage(value.startupPage === 'companion' ? 'free-time' : value.startupPage) }
  }, [preferences.loaded, preferences.value.theme, preferences.value.glass, preferences.value.density])
  const stopPreview = useCallback(() => setPreviewPhase(null), [])
  const previewEffect = useCallback(() => setPreviewPhase('thinking'), [])
  const changePreviewPhase = useCallback((phase: ResponsePhase) => setPreviewPhase(current => current === null ? null : phase), [])
  // Old scenario receipts lead to the new home for optional plans.
  useEffect(() => {
    const open = () => changePage('free-time')
    window.addEventListener('astaria-open-companion', open)
    return () => window.removeEventListener('astaria-open-companion', open)
  })
  const settingsReturn = useRef<{ page: Exclude<WorkspacePage, 'settings'>; chat: boolean }>({ page: 'home', chat: false })
  const settingsOpen = page === 'settings'
  const [settingsTab, setSettingsTab] = useState<'析熙' | '通知'>('析熙')
  const settingsOpener = useRef<HTMLElement | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [informationActive, setInformationActive] = useState(false)
  const camera = useSceneCamera(readCamera, `${page}:${chatOpen}:${stringsOpen}`)
  const [cameraMissing, setCameraMissing] = useState(false)
  const progress = sceneUnavailable || cameraMissing ? Number(chatOpen) : Math.max(0, Math.min(1, (camera.zoom - .7) / (2.05 - .7)))
  const [menuOpen, setMenuOpen] = useState(false)
  const [draft, setDraft] = useState(readDraft)
  const draftRevision = useRef(0)
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
  const menuList = useRef<HTMLUListElement>(null)
  const current = useRef<HTMLDivElement>(null)
  const currentButton = useRef<HTMLButtonElement>(null)
  const launch = useRef<HTMLButtonElement>(null)
  const compose = useRef<HTMLTextAreaElement>(null)
  const submitKeys = useChatSubmitKey(() => compose.current?.form?.requestSubmit())
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

  const currentTask = useMemo(() => selectCurrentTask(data.tasks), [data.tasks])
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
    const list = menuList.current
    if (!list) return
    const updateEdges = () => {
      list.dataset.overflowStart = String(list.scrollLeft > 1)
      list.dataset.overflowEnd = String(list.scrollWidth - list.clientWidth - list.scrollLeft > 1)
    }
    const observer = new ResizeObserver(updateEdges)
    observer.observe(list)
    list.addEventListener('scroll', updateEdges, { passive: true })
    updateEdges()
    return () => { observer.disconnect(); list.removeEventListener('scroll', updateEdges) }
  }, [])
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
  const commitPage = (next: WorkspacePage, openChat = false) => {
    if (page === 'settings' && next !== 'settings') stopPreview()
    clearTimeout(menuTimer.current)
    if (next === page) brand.current?.focus({ preventScroll: true })
    setMenuOpen(false)
    setSelectedId(null)
    setPage(next)
    if (next !== 'home') {
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
  const changePage = (next: WorkspacePage, openChat = false) => {
    const destination = next === 'companion' ? 'free-time' : next
    if (destination === 'free-time') setFreeTimeMounted(true)
    commitPage(destination, openChat)
  }
  const openStrings = useCallback(() => {
    // Both entry surfaces already show the panorama. Preserve its actual
    // camera position rather than starting a second preset transition.
    focusAfterTransition.current = false
    clearTimeout(menuTimer.current)
    stringsOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setMenuOpen(false); setStringCovered(true); setStringsOpen(true)
  }, [])
  const closeStrings = useCallback(() => {
    setStringsOpen(false); setStringCovered(false)
    // The dialog unmounts before its original homepage control leaves inert.
    requestAnimationFrame(() => {
      const opener = stringsOpener.current
      if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true })
    })
  }, [])
  const freeTimeChanged = useCallback(() => { data.retry(); void chat.refresh() }, [data.retry, chat.refresh])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || selectedId || settingsOpen) return
      if (menuOpen) { event.preventDefault(); brand.current?.focus(); setMenuOpen(false) }
      else if (page === 'home' && chatOpen) { event.preventDefault(); changeChat(false) }
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  })
  const capture = async () => {
    if (!draft.trim() || data.saving || data.loading || data.loadError || chat.busy) return
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
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!draft.trim() || data.saving || data.loading || data.loadError || chat.busy) return
    setSaveError('')
    const sent = draft
    const revision = draftRevision.current
    const accepted = await chat.send(sent, { page: 'home', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
    if (accepted && revision === draftRevision.current) {
      setDraft(value => value === sent ? '' : value)
      stopInputPulse()
      compose.current?.focus()
    }
  }
  const restoreDraft = (text: string) => {
    draftRevision.current += 1
    setDraft(value => restoreWithdrawnDraft(value, text))
    requestAnimationFrame(() => {
      compose.current?.focus({ preventScroll: true })
      if (compose.current) compose.current.setSelectionRange(compose.current.value.length, compose.current.value.length)
    })
  }
  const openSettings = () => {
    setSettingsTab('析熙')
    if (page === 'settings') { setMenuOpen(false); return }
    settingsReturn.current = { page, chat: chatOpen }
    settingsOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    clearTimeout(menuTimer.current)
    setMenuOpen(false)
    changePage('settings')
  }
  const closeSettings = () => {
    stopPreview()
    changePage(settingsReturn.current.page, settingsReturn.current.chat)
    requestAnimationFrame(() => {
      const previous = settingsOpener.current
      const fallback = page === 'home' && chatOpen ? compose.current : brand.current
      ;(previous?.isConnected && !previous.closest('[inert]') ? previous : fallback)?.focus({ preventScroll: true })
    })
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
  const endHeight = Math.max(180, Math.min(680, layout.height - 149))
  const endTop = Math.max(84, (layout.height - endHeight) / 2)
  const width = 128 + (endWidth - 128) * progress
  // Extend only the UI surface, reading the existing camera transition.
  const extendedWidth = width + (compact ? 0 : endWidth * Math.max(0, (progress - .5) / .5))
  const height = 38 + (endHeight - 38) * progress
  const radius = 19 + (15 - 19) * progress
  const chatVisible = progress > .35

  return <div ref={root} className="home-workspace" data-spatial-ui data-string-covered={stringCovered} data-theme={appearance.value.theme} data-chat-open={chatOpen} data-page={page} data-grid={preferences.value.grid} data-card-edges={preferences.value.cardEdges ?? 'both'} data-motion={preferences.value.effect.motion} data-effect-preview={previewPhase !== null}>
    <nav ref={nav} className="home-nav" aria-label="ASTaria 导航" data-menu-open={menuOpen} inert={previewPhase !== null} aria-hidden={previewPhase !== null}
      onPointerEnter={event => { if (event.pointerType !== 'touch') { clearTimeout(menuTimer.current); menuOpenedByHover.current = !menuOpen; setMenuOpen(true) } }}
      onPointerLeave={() => { menuTimer.current = setTimeout(() => { if (!nav.current?.contains(document.activeElement)) setMenuOpen(false) }, 180) }}
      onFocus={() => clearTimeout(menuTimer.current)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false) }}>
      <button ref={brand} className="home-brand" aria-expanded={menuOpen} aria-controls="home-menu" aria-label="ASTaria 导航" onKeyDown={event => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowDown') return
        event.preventDefault()
        menuOpenedByHover.current = false
        setMenuOpen(true)
        requestAnimationFrame(() => menuList.current?.querySelector('button')?.focus({ preventScroll: true }))
      }} onClick={event => {
        // The pointer opens a hover preview before its first click reaches us.
        // Keep that first click open; subsequent clicks and keyboard activation toggle.
        const keepOpen = event.detail > 0 && menuOpenedByHover.current
        menuOpenedByHover.current = false
        setMenuOpen(open => keepOpen || !open)
      }}>
        <span className="home-brand-wordmark" aria-hidden="true">AST<span>aria</span></span>
        <span className="home-brand-mark" aria-hidden="true">A</span>
        <svg className="home-nav-hint" viewBox="0 0 10 10" aria-hidden="true"><path d="m3.5 2 3 3-3 3" /></svg>
      </button>
      <div id="home-menu" className="home-menu" data-open={menuOpen} inert={!menuOpen} aria-hidden={!menuOpen}>
        <GlassSamplingContext.Provider value={menuOpen}><MeasuredGlassSurface radius={13} settleResize /></GlassSamplingContext.Provider>
        <ul ref={menuList} className="home-menu-list" onFocusCapture={event => {
          const list = event.currentTarget, target = event.target as HTMLElement
          const listBox = list.getBoundingClientRect(), targetBox = target.getBoundingClientRect()
          if (targetBox.left < listBox.left + 12) list.scrollLeft -= listBox.left + 12 - targetBox.left
          else if (targetBox.right > listBox.right - 12) list.scrollLeft += targetBox.right - listBox.right + 12
        }} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          const items = Array.from(event.currentTarget.querySelectorAll('button'))
          const currentIndex = items.indexOf(event.target as HTMLButtonElement)
          if (currentIndex < 0) return
          event.preventDefault()
          const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length
          items[nextIndex]?.focus({ preventScroll: true })
        }}>
          <li><button aria-current={page === 'home' ? 'page' : undefined} onClick={() => changePage('home')}>首页</button></li>
          <li><button aria-current={page === 'workbench' ? 'page' : undefined} onClick={() => changePage('workbench')}>工作台</button></li>
          <li><button aria-current={page === 'schedule' ? 'page' : undefined} onClick={() => changePage('schedule')}>日程</button></li>
          <li><button aria-current={page === 'free-time' ? 'page' : undefined} onClick={() => changePage('free-time')}>余时</button></li>
          <li><button aria-current={page === 'settings' ? 'page' : undefined} onClick={openSettings}>设置</button></li>
        </ul>
      </div>
    </nav>
    <HomeStatus now={now} showClock={!sceneUnavailable} notification={notificationsAllowed(preferences.value.notifications, now) ? notification || proactiveNotice : notification || '免打扰 · 变更记录已保留'} onNotification={() => {
      if (proactiveNotice.startsWith('有未读变更') || notification) { openSettings(); setSettingsTab('通知') }
      else changePage('free-time')
    }} />

    <GlassSamplingContext.Provider value={page === 'home' && previewPhase === null && !stringCovered}>
    <div className="home-scene-ui" inert={page !== 'home' || stringsOpen} aria-hidden={page !== 'home' || stringCovered}>
    <BlackHoleEntry
      camera={camera}
      width={layout.width}
      height={layout.height}
      visible={page === 'home' && !chatOpen && !stringCovered && !stringsOpen && !sceneUnavailable && !camera.cameraTransition && progress < .08}
      onEnter={openStrings}
    />
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
      <HomeDeadlinePicker active={page === 'home' && chatOpen} conversationId={chat.conversation?.conversationId}
        onOpen={() => { if (compact) setInformationActive(true) }} onClose={() => setInformationActive(false)}>
      <section id="home-xixi" className="home-xixi" aria-label="析熙" inert={!chatOpen || progress < .99 || (compact && informationActive)} aria-hidden={!chatOpen || (compact && informationActive)}>
        <header><div className="home-chat-title">
          <button className="home-collapse" onClick={() => changeChat(false)} aria-label="收起析熙" title="收起析熙">
            <svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" /><path d="m5 5 4 4m0-4-4 4" /></svg>
          </button>
          <strong>析熙</strong>
        </div><div className="xixi-header-actions"><ConversationMenu chat={chat} />{compact && <button ref={informationToggle} className="home-information-toggle" onClick={() => setInformationActive(true)} aria-controls="home-agenda">日程 →</button>}</div></header>
        <ConversationLog chat={chat} active={page === 'home' && chatOpen && progress >= .99 && (!compact || !informationActive)} onSettings={openSettings}
          context={{ page: 'home', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }} onSent={sent => setDraft(value => value.trim() === sent ? '' : value)} onRetracted={restoreDraft}>
          {receipts.map(task => <div className="home-receipt" key={task.id}><span>已记为事项</span><button onClick={() => openTask(task.id)}>{task.title}</button></div>)}
        </ConversationLog>
        <form onSubmit={event => void submit(event)}>
          <label className="p0-sr-only" htmlFor="home-compose">写下你的事情，发送给析熙，或手动记为事项</label>
          <div className="home-input-shell" data-pulsing={inputPulse !== null}>
          {inputPulse !== null && <span key={inputPulse} className="home-input-flash" aria-hidden="true" onAnimationEnd={event => {
            if (event.target === event.currentTarget) setInputPulse(current => current === inputPulse ? null : current)
          }}>
            <span className="home-input-glow" />
            <span className="home-input-rim" />
          </span>}
          <textarea ref={compose} id="home-compose" placeholder="写下你的事情" rows={2} maxLength={4000} value={draft} disabled={data.saving || chat.busy}
            onChange={event => {
              const value = event.target.value
              const inputType = (event.nativeEvent as InputEvent).inputType
              if (value !== draft && (inputType ? inputType.startsWith('insert') : value.length > draft.length)) flashInput()
              setDraft(value)
            }} onBlur={stopInputPulse} {...submitKeys} />
          </div>
          <div className="home-compose-actions"><button className="xixi-text-button xixi-manual" type="button" disabled={data.saving || chat.busy || data.loading || Boolean(data.loadError) || !draft.trim()} onClick={() => void capture()}>{data.saving ? '正在保存' : '只记为事项'}</button><button className="home-capture" type="submit" disabled={data.saving || data.loading || Boolean(data.loadError) || chat.busy || chat.loading || !draft.trim()}>{chat.sending ? '正在想' : '发给析熙'}</button></div>
          {chat.error && <p className="xixi-send-error" role="alert">{chat.error}{!chat.status?.configured && <button type="button" className="xixi-text-button" onClick={openSettings}>打开设置</button>}</p>}
          {(saveError || draftWarning || data.loadError) && <p className="home-form-error" role="alert">{saveError || draftWarning || data.loadError}{data.loadError && <button type="button" onClick={data.retry}>重试读取</button>}</p>}
        </form>
      </section>
      <HomeAgenda tasks={data.tasks} now={now} loading={data.loading} error={data.loadError}
        active={page === 'home' && chatOpen && progress >= .99 && (!compact || informationActive)} compact={compact}
        onRetry={data.retry} onTask={openTask} onChat={() => {
          setInformationActive(false)
          requestAnimationFrame(() => informationToggle.current?.focus({ preventScroll: true }))
        }} />
      </HomeDeadlinePicker>
      </div>
      </div>
    </div>
    </div>
    </GlassSamplingContext.Provider>
    <Workbench active={page === 'workbench'} appearance={appearance} data={data} now={now} onCapture={() => changePage('home', true)} onNotice={setNotification} chat={chat} onSettings={openSettings} />
    <PlannerWorkspace active={page === 'schedule'} tasks={data.tasks} tasksLoading={data.loading} tasksError={data.loadError} now={now} appearance={appearance} onNotice={setNotification} onRefresh={data.retry} />
    {(freeTimeMounted || page === 'free-time') && <FreeTimePanel active={page === 'free-time' && !stringCovered} today={today} theme={preferences.value.theme} grid={preferences.value.grid} glass={preferences.value.glass} onOpenStrings={openStrings} onChanged={freeTimeChanged} onNotice={setNotification} />}
    {settingsOpen && <LocalSettings initialTab={settingsTab} onClose={closeSettings} onSaved={chat.refreshStatus} onPreviewEffect={previewEffect} onPreviewPhaseChange={changePreviewPhase} onStopPreview={stopPreview} previewPhase={previewPhase} />}
    {stringsOpen && <OrbitStudio onReveal={() => setStringCovered(false)} onClose={closeStrings} onSaved={message => { data.retry(); void chat.refresh(); setNotification(message) }} />}
    {selectedId && <TaskDialog task={selectedTask} saving={data.saving} onClose={closeTask} onStatus={data.setStatus} />}
  </div>
}

function TaskDialog({ task, saving, onClose, onStatus }: {
  task: Task | undefined; saving: boolean; onClose: () => void; onStatus: (id: string, status: TaskStatus) => Promise<Task>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [error, setError] = useState('')
  const [closing, setClosing] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const closingRef = useRef(false)
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => { clearTimeout(closeTimer.current); element.close() }
  }, [])
  const requestClose = () => {
    if (saving || closingRef.current) return
    closingRef.current = true
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { onClose(); return }
    setClosing(true)
    closeTimer.current = setTimeout(onClose, 180)
  }
  return <GlassSamplingContext.Provider value={!closing}><dialog ref={dialog} className="home-task-dialog" data-closing={closing} aria-labelledby="home-task-heading" onCancel={event => { event.preventDefault(); requestClose() }} onKeyDown={event => event.stopPropagation()}>
    <MeasuredGlassSurface radius={19} />
    <div className="home-task-content">
    <header><h2 id="home-task-heading">任务详情</h2><button className="home-task-close" type="button" onClick={requestClose} disabled={saving || closing} aria-label="关闭任务详情"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7" /></svg></button></header>
    {task ? <>
      <p className="home-task-title">{task.title}</p>
      {task.notes && <p className="home-task-notes">{task.notes}</p>}
      <p className="home-task-meta">{readableDate(task.due)}</p>
      <div className="home-task-status" role="group" aria-label="任务状态">{(['todo', 'doing', 'done', 'dropped'] as const).map(status => <button key={status} data-status={status} data-task-status={status} aria-pressed={task.status === status} disabled={saving || closing} onClick={async () => {
        if (task.status === status) return
        setError(''); try { await onStatus(task.id, status) } catch (reason) { setError(reason instanceof Error ? reason.message : '状态保存失败，请重试') }
      }}>{STATUS_LABELS[status]}</button>)}</div>
      <p className="p0-sr-only" role="status">{STATUS_LABELS[task.status]}</p>
    </> : <p>这条事项已不在本地记录中</p>}
    {error && <p className="home-form-error" role="alert">{error}</p>}
    </div>
  </dialog></GlassSamplingContext.Provider>
}
