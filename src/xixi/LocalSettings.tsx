import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { localApi } from './api'
import type { LocalStatus, Memory, Operation } from './types'
import type { PlannerState } from '../planner/types'
import { DEFAULT_BINARY_EFFECT, normalizeBinaryEffect } from '../prototype/responseEffects'
import type { BinaryEffectSettings, ResponseEffectSettings, ResponsePhase } from '../prototype/responseEffects'
import { BackgroundMediaSettings } from './BackgroundMediaSettings'
import { DEFAULT_PREFERENCES, publishPreferences, usePreferences } from './preferences'
import type { Preferences } from './preferences'
import { notifyLocalDataChange } from '../stores/migration'
import { GlassSamplingContext, MeasuredGlassSurface } from '../home/GlassSurface'
import { WorkspaceHeading } from '../ui/WorkspaceHeading'
import { AdaptiveSelect, AdaptiveSelectHost } from '../ui/AdaptiveSelect'
import { ModelConnection } from './ModelConnection'
import { SystemReminders } from './SystemReminders'
import { AppUpdates } from './AppUpdates'
import { FolderSyncSettings } from './FolderSyncSettings'
import { BACKUP_MAX_BYTES, BACKUP_EXPORT_TOO_LARGE, BACKUP_IMPORT_TOO_LARGE, backupByteLength, serializeBackup } from './backupLimits'
import './settings.css'

const TABS = ['通用', '析熙', '时间安排', '通知', '外观与动画', '数据'] as const
const PERSONALITY_LEVELS = [
  { value: 'low', label: '低', description: '简洁温和' },
  { value: 'medium', label: '中', description: '自然俏皮' },
  { value: 'high', label: '高', description: '有主见，嘴硬一点，做事认真' },
] as const
type Tab = typeof TABS[number]
function SettingsDirectoryIcon({ tab }: { tab: Tab }) {
  const glyph = tab === '通用' ? <><path d="M3 6h4m4 0h10M3 12h10m4 0h4M3 18h4m4 0h10" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="9" cy="18" r="2" /></>
    : tab === '析熙' ? <><ellipse cx="12" cy="12" rx="9" ry="5" transform="rotate(-32 12 12)" /><circle cx="12" cy="12" r="3" /><circle cx="19" cy="6" r="1" /></>
      : tab === '时间安排' ? <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2M9 3h6" /></>
        : tab === '通知' ? <><path d="M6 10a6 6 0 0 1 12 0c0 6 2 6 2 8H4c0-2 2-2 2-8M10 21h4" /></>
          : tab === '外观与动画' ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>
            : <><ellipse cx="12" cy="5" rx="7" ry="3" /><path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5m-14 7v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" /></>
  return <span className="xixi-settings-directory-icon" aria-hidden="true"><svg viewBox="0 0 24 24">{glyph}</svg></span>
}
type Props = {
  onClose: () => void; onSaved: () => void | Promise<void>
  onEffectChange?: (value: ResponseEffectSettings) => void; onPreviewEffect?: () => void; onStopPreview?: () => void
  onPreviewPhaseChange?: (phase: ResponsePhase) => void; previewPhase?: ResponsePhase | null; initialTab?: Tab
  onExportBackup?: (value: unknown, name: string) => Promise<void>
}
export function LocalSettings({ onClose, onSaved, onEffectChange, onPreviewEffect, onStopPreview, onPreviewPhaseChange, previewPhase, initialTab = '析熙', onExportBackup }: Props) {
  const mobile = Boolean(document.documentElement.dataset.mobile) || import.meta.env.MODE === 'mobile'
  const mobilePreview = document.documentElement.dataset.mobile === 'preview'
  const nativeMobile = mobile && !mobilePreview
  const page = useRef<HTMLElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const sectionViewport = useRef<HTMLDivElement>(null)
  const previewDock = useRef<HTMLDivElement>(null)
  const previewTrigger = useRef<HTMLElement | null>(null)
  const savedScroll = useRef(0)
  const wasPreviewing = useRef(false)
  const saving = useRef(false)
  const [closing, setClosing] = useState(false)
  const [tab, setTab] = useState<Tab>(initialTab)
  const [mobileDirectory, setMobileDirectory] = useState(true)
  const [selectOpen, setSelectOpen] = useState(false)
  const [navigationPhase, setNavigationPhase] = useState<'idle' | 'exiting' | 'entering'>('idle')
  const navigation = useRef<{ directory: boolean; tab: Tab; top: number } | null>(null)
  const navigating = navigationPhase !== 'idle'
  const directoryTrigger = useRef<HTMLButtonElement | null>(null)
  const directoryScroll = useRef(0)
  const sectionScroll = useRef(0)
  const directoryFocus = useRef<{ trigger: HTMLButtonElement | null; scrollTop: number } | null>(null)
  useEffect(() => { setTab(initialTab) }, [initialTab])
  const [status, setStatus] = useState<LocalStatus | null>(null)
  const [memories, setMemories] = useState<Array<Memory & { source: string }>>([])
  const [operations, setOperations] = useState<Operation[]>([])
  const [planner, setPlanner] = useState<PlannerState | null>(null)
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES)
  const sharedPreferences = usePreferences()
  useEffect(() => { if (sharedPreferences.loaded && !saving.current) setPreferences(sharedPreferences.value) }, [sharedPreferences.value, sharedPreferences.loaded])
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [editMemory, setEditMemory] = useState<{ id: string; content: string } | null>(null)
  const [memoryPage, setMemoryPage] = useState(0)
  const [importFile, setImportFile] = useState<{ name: string; value: unknown } | null>(null)
  const refresh = async () => {
    const [next, remembered, value, schedule, changes] = await Promise.all([
      localApi<LocalStatus>('/status'), localApi<Array<Memory & { source: string }>>('/memories'),
      localApi<Preferences>('/preferences'), localApi<PlannerState>('/planner'), localApi<Operation[]>('/operations'),
    ])
    setStatus(next); setMemories(remembered); setPreferences(value); setPlanner(schedule); setOperations(changes); setReady(true)
  }
  useEffect(() => {
    void refresh().catch(reason => setError(reason instanceof Error ? reason.message : '本机服务暂时无法连接'))
    page.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
  }, [])
  const previewVisible = previewPhase != null
  useLayoutEffect(() => {
    if (navigating) return
    if (!mobile || !mobileDirectory || closing || previewVisible || selectOpen) { directoryFocus.current = null; return }
    const pending = directoryFocus.current
    if (!pending) return
    let frame = 0, attempts = 0
    const restore = () => {
      if (directoryFocus.current !== pending) return
      const target = pending.trigger, viewport = scroll.current
      // A newer foreground owns focus. Never resume this request after it closes.
      const modal = Array.from(document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"][aria-modal="true"]')).some(element =>
        element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible' && !element.closest('[hidden],[inert]'))
      if (modal || !page.current?.isConnected || !target?.isConnected || !viewport) { directoryFocus.current = null; return }
      const visible = target.getClientRects().length > 0 && getComputedStyle(target).visibility === 'visible'
        && !target.closest('[hidden],[inert],[aria-hidden="true"]') && !target.disabled
      if (visible) {
        viewport.scrollTop = pending.scrollTop
        target.focus({ preventScroll: true })
        // Touch-driven updates can need another style pass in the real root.
        if (document.activeElement === target) { directoryFocus.current = null; return }
      }
      if (++attempts < 8) frame = requestAnimationFrame(restore)
      else directoryFocus.current = null
    }
    frame = requestAnimationFrame(restore)
    return () => cancelAnimationFrame(frame)
  }, [mobile, mobileDirectory, closing, previewVisible, selectOpen, navigating])
  useLayoutEffect(() => {
    if (wasPreviewing.current === previewVisible) return
    wasPreviewing.current = previewVisible
    if (previewVisible) previewDock.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
    else {
      if (scroll.current) scroll.current.scrollTop = savedScroll.current
      if (previewTrigger.current?.isConnected) previewTrigger.current.focus({ preventScroll: true })
    }
  }, [previewVisible])
  const close = () => {
    if (saving.current || closing || navigation.current || selectOpen) return
    directoryFocus.current = null
    onStopPreview?.(); setClosing(true)
  }
  useLayoutEffect(() => {
    if (!closing) return
    let current = true
    const animations = page.current?.getAnimations({ subtree: true }) ?? []
    const finish = () => { if (current) onClose() }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !animations.length) finish()
    else void Promise.allSettled(animations.map(animation => animation.finished)).then(finish)
    return () => { current = false }
  }, [closing, onClose])
  // Keep the outgoing view mounted until its actual animation finishes. The
  // synchronous ref also guards two pointer/key events in the same React turn.
  const backToDirectory = () => {
    if (saving.current || closing || navigation.current || selectOpen) return
    sectionScroll.current = sectionViewport.current?.scrollTop ?? 0
    if (scroll.current) scroll.current.scrollTop = 0
    navigation.current = { directory: true, tab, top: directoryScroll.current }
    setNavigationPhase('exiting')
  }
  const openSection = (item: Tab, trigger: HTMLButtonElement) => {
    if (saving.current || closing || navigation.current || selectOpen) return
    directoryFocus.current = null
    directoryTrigger.current = trigger
    directoryScroll.current = 0
    if (scroll.current) scroll.current.scrollTop = 0
    navigation.current = { directory: false, tab: item, top: item === tab ? sectionScroll.current : 0 }
    onStopPreview?.()
    setNavigationPhase('exiting')
  }
  useLayoutEffect(() => {
    const destination = navigation.current
    if (!destination || navigationPhase === 'idle') return
    let current = true
    const entering = navigationPhase === 'entering'
    const viewport = destination.directory ? scroll.current : sectionViewport.current
    if (entering && viewport) viewport.scrollTop = destination.top
    const direction = destination.directory ? -1 : 1
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || preferences.effect.motion === 'reduced'
    // Mobile directory and details share a fixed viewport-sized glass host.
    // Only foreground content moves; the sampler never resizes per section.
    const elements = [page.current?.querySelector('.xixi-settings-page-header'), page.current?.querySelector(mobileDirectory ? '.xixi-settings-directory' : '.xixi-settings-content'), page.current?.querySelector('.xixi-settings-feedback')]
    const animations = reduced ? [] : elements.flatMap(element => element ? [element.animate(
      entering ? [{ opacity: 0, transform: `translateX(${direction * 6}px)` }, { opacity: 1, transform: 'none' }]
        : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${-direction * 6}px)` }],
      { duration: entering ? 360 : 140, easing: 'cubic-bezier(.16,.8,.25,1)', fill: 'both' },
    )] : [])
    const finish = () => {
      if (!current) return
      if (!entering) {
        // Retain the outgoing last frame until React commits the hidden view.
        // Cancelling here exposes its unanimated copy before the next commit.
        setTab(destination.tab); setMobileDirectory(destination.directory); setNavigationPhase('entering')
      } else {
        animations.forEach(animation => animation.cancel())
        if (viewport) viewport.scrollTop = destination.top
        if (scroll.current) scroll.current.scrollTop = 0
        if (destination.directory) directoryFocus.current = { trigger: directoryTrigger.current, scrollTop: destination.top }
        navigation.current = null
        setNavigationPhase('idle')
      }
    }
    if (animations.length) void Promise.allSettled(animations.map(animation => animation.finished)).then(finish)
    else finish()
    const reduce = () => { if (matchMedia('(prefers-reduced-motion: reduce)').matches) animations.forEach(animation => animation.finish()) }
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    media.addEventListener('change', reduce)
    return () => { current = false; animations.forEach(animation => animation.cancel()); media.removeEventListener('change', reduce) }
  }, [navigationPhase, mobileDirectory, preferences.effect.motion])
  useLayoutEffect(() => {
    if (mobile && !mobileDirectory && !navigating && !selectOpen && !previewVisible && !closing) page.current?.querySelector<HTMLElement>('#xixi-settings-title')?.focus({ preventScroll: true })
  }, [mobileDirectory, navigating])
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return
      event.preventDefault()
      if (previewVisible) onStopPreview?.()
      else if (mobile && !mobileDirectory) backToDirectory()
      else close()
    }
    window.addEventListener('keydown', keyboard)
    return () => window.removeEventListener('keydown', keyboard)
  }, [previewVisible, closing, mobile, mobileDirectory, selectOpen, onStopPreview, onClose])
  const action = async (operation: () => Promise<unknown>, message: string) => {
    if (saving.current) return
    saving.current = true; setBusy(true); setError(''); setNotice('')
    try { await operation(); await refresh(); await onSaved(); setNotice(message) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '暂时没有完成，请重试') }
    finally { saving.current = false; setBusy(false) }
  }
  const savePreferences = (value: Preferences) => action(async () => {
    const saved = await localApi<Preferences>('/preferences', { expected: preferences, value })
    setPreferences(saved); publishPreferences(saved); onEffectChange?.(saved.effect)
  }, mobile ? '设置已保存在这台设备上' : '设置已保存，同一台电脑的浏览器共用')
  const effect = (patch: Partial<ResponseEffectSettings>) => { const next = { ...preferences.effect, ...patch }; void savePreferences({ ...preferences, effect: next }) }
  const binary = normalizeBinaryEffect(preferences.effect.binary)
  const changeBinary = (patch: Partial<BinaryEffectSettings>) => effect({ binary: { ...binary, ...patch } })
  const renderProfile = (profile: Preferences['render']['profile']) => { void savePreferences({ ...preferences, render: { ...preferences.render, profile } }) }
  const saveRoutine = (id: string, start: string, end: string) => {
    const routine = planner?.routines.find(item => item.id === id)
    if (!planner || !routine) return
    void action(async () => { await localApi('/planner', { expectedRevision: planner.revision, action: { type: 'save-routine', routine: { ...routine, start, end } } }); notifyLocalDataChange() }, '可安排时段已更新')
  }
  const exportData = () => action(async () => {
    const backup = await localApi('/data/export')
    const json = serializeBackup(backup)
    if (backupByteLength(json) > BACKUP_MAX_BYTES) throw new Error(BACKUP_EXPORT_TOO_LARGE)
    const name = `ASTaria-backup-${new Date().toLocaleDateString('en-CA')}.json`
    if (onExportBackup) { await onExportBackup(backup, name); return }
    if (nativeMobile) {
      const { shareMobileBackup } = await import('../../mobile/runtime/backupShare')
      await shareMobileBackup(backup, name)
      return
    }
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = name; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 30000)
  }, onExportBackup || nativeMobile ? '备份分享已结束，请在所选位置确认保存，不包含 API Key' : '备份已下载，不包含 API Key')
  const selectBackup = async (file: File) => {
    setImportFile(null); setNotice('')
    try {
      if (file.size > BACKUP_MAX_BYTES) throw new Error(BACKUP_IMPORT_TOO_LARGE)
      let value: unknown
      try { value = JSON.parse(await file.text()) }
      catch { throw new Error('无法读取该备份，请选择 ASTaria 导出的 JSON 文件') }
      if (backupByteLength(serializeBackup(value)) > BACKUP_MAX_BYTES) throw new Error(BACKUP_IMPORT_TOO_LARGE)
      setImportFile({ name: file.name, value }); setError('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法读取该备份，请选择 ASTaria 导出的 JSON 文件') }
  }
  const beginPreview = () => {
    savedScroll.current = scroll.current?.scrollTop ?? 0
    previewTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    onPreviewEffect?.()
  }
  const personality = preferences.assistant.personality ?? 'medium'
  const memoryPageCount = Math.max(1, Math.ceil(memories.length / 3))
  const shownMemoryPage = Math.min(memoryPage, memoryPageCount - 1)
  const glass = { transmission: 70, blur: preferences.glass === 'soft' ? 6 : 0, rim: 40, shadow: 30 }
  return <AdaptiveSelectHost target={page} underlayRef={scroll} material={glass} reducedMotion={preferences.effect.motion === 'reduced'} onOpenChange={setSelectOpen}><section ref={page} className="xixi-settings" data-theme={preferences.theme} data-navigation-phase={navigationPhase} data-grid={preferences.grid} data-closing={closing} data-previewing={previewVisible} data-mobile-models={mobile || undefined} data-mobile-view={mobile ? mobileDirectory ? 'directory' : 'section' : undefined} data-select-open={selectOpen || undefined} aria-label="设置">
    {mobile && <style>{'.xixi-settings[data-mobile-models=true] .xixi-model-modes{grid-template-columns:minmax(0,1fr)}.xixi-settings[data-mobile-models=true] .xixi-model-modes > button:nth-child(2){display:none}'}</style>}
    <div className="xixi-settings-background" aria-hidden="true" />
    <div ref={scroll} className="xixi-settings-scroll workspace-page-viewport" inert={previewVisible || closing || selectOpen || navigating} aria-hidden={previewVisible || closing || selectOpen}>
    <div className="xixi-settings-container workspace-page-container">
    <WorkspaceHeading className="xixi-settings-page-header" title={mobile && !mobileDirectory ? tab : '设置'} description={mobile ? undefined : '按你的节奏，照顾每一天'} titleId="xixi-settings-title">{mobile && !mobileDirectory && <button className="xixi-settings-mobile-back" type="button" disabled={busy || closing || navigating} aria-label="返回设置目录" onClick={backToDirectory}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m10 3-5 5 5 5" /></svg></button>}</WorkspaceHeading>
    <div ref={panel} className="xixi-settings-panel">
    <GlassSamplingContext.Provider value={!closing && !previewVisible}><MeasuredGlassSurface radius={mobile ? 20 : 24} material={glass} /></GlassSamplingContext.Provider>
    <div className="xixi-settings-shell">
    {mobile ? <nav className="xixi-settings-directory" aria-label="设置分区" hidden={!mobileDirectory}>{TABS.map(item => <button className="xixi-settings-directory-entry" key={item} type="button" disabled={busy || closing || navigating} onClick={event => openSection(item, event.currentTarget)}><span className="xixi-settings-directory-copy"><SettingsDirectoryIcon tab={item} /><strong>{item}</strong></span><span className="xixi-settings-directory-arrow"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg></span></button>)}</nav> : <nav className="xixi-settings-tabs" aria-label="设置分区">{TABS.map(item => <button key={item} type="button" aria-current={tab === item ? 'page' : undefined} onClick={() => { setTab(item); onStopPreview?.(); scroll.current?.scrollTo({ top: 0 }) }}>{item}</button>)}</nav>}
    <div ref={sectionViewport} className="xixi-settings-content" data-section={tab} key={tab} hidden={mobile && mobileDirectory} inert={mobile && mobileDirectory}>
    {tab === '通用' && <section><h3>按照你的习惯打开</h3><Row title="启动页面" note="首页始终保留沉浸式黑洞"><AdaptiveSelect aria-label="启动页面" value={(['calendar', 'timetable'].includes(preferences.startupPage) ? 'schedule' : preferences.startupPage)} disabled={!ready || busy} onChange={event => void savePreferences({ ...preferences, startupPage: event.target.value as Preferences['startupPage'] })}><option value="home">首页</option><option value="workbench">工作台</option><option value="schedule">日程</option><option value="companion">余时</option></AdaptiveSelect></Row><Row title="当前日期与时区" note="日期和钟点跟随这台设备，避免产生两套时间"><output>{Intl.DateTimeFormat().resolvedOptions().timeZone}<br />{new Date().toLocaleString('zh-CN', { hourCycle: 'h23' })}</output></Row><Row title="当前任务" note="明确的 DDL 优先，再结合进行状态和重要程度"><span>与工作台共用真实事项</span></Row></section>}
    {tab === '通用' && <AppUpdates visible={!previewVisible && !closing && (!mobile || !mobileDirectory)} />}
    {tab === '数据' && (mobile ? <section><h3>本机数据与备份</h3><p className="xixi-settings-note">事项、日程和对话保存在这台设备上。可在下方导出备份，导入时会替换当前设备的数据。手机端暂未接入桌面的共享文件夹与 Syncthing 目录同步。</p></section> : <FolderSyncSettings />)}
    {tab === '析熙' && <>
      {mobile ? <section className="xixi-model-connection">
        <p className="xixi-settings-note">手机端不安装或运行本地模型，也不连接电脑的本地模型地址。离线可管理事项与日程；使用析熙需联网并配置 DeepSeek，相关对话与事项会发送给该服务。{mobilePreview ? '浏览器手机预览不连接云端模型，请在原生 App 中配置。' : '联网搜索默认关闭，开启后仅发送查询词。'}</p>
        {status?.provider && status.provider !== 'deepseek' ? <><h3>当前连接在手机上暂不可用</h3><p>手机端目前使用 DeepSeek，请切换后配置手机连接。本地模型与其它 API 仍可在桌面使用。</p><div className="xixi-settings-actions"><button type="button" disabled={busy} onClick={() => void action(() => localApi('/settings/provider', { ...status.providerSettings, provider: 'deepseek' }), '已切换到 DeepSeek，请配置手机连接')}>切换到 DeepSeek</button></div></> : <ModelConnection status={status} busy={busy} onAction={action} />}
      </section> : <ModelConnection status={status} busy={busy} onAction={action} />}
      <section className="xixi-assistant-preferences"><h3>相处与决定</h3>
        <Row title="析熙个性" note={PERSONALITY_LEVELS.find(level => level.value === personality)?.description}>
          <div className="xixi-personality-options" role="group" aria-label="析熙个性">{PERSONALITY_LEVELS.map(level => <button key={level.value} type="button" disabled={!ready || busy} aria-pressed={personality === level.value} title={level.description} onClick={() => { if (personality !== level.value) void savePreferences({ ...preferences, assistant: { ...preferences.assistant, personality: level.value } }) }}>{level.label}</button>)}</div>
        </Row>
        <p className="xixi-settings-note">只调整表达方式；出错或聊严肃话题时，仍会认真对待</p>
        <Row title="主动程度" note="推演始终先预览，应用后的真实变更保留通知和撤销"><AdaptiveSelect aria-label="析熙主动程度" disabled={!ready || busy} value={preferences.assistant.autonomy} onChange={event => void savePreferences({ ...preferences, assistant: { ...preferences.assistant, autonomy: event.target.value as 'act' | 'propose' } })}><option value="act">明确的事直接帮我做</option><option value="propose">先提出方案</option></AdaptiveSelect></Row>
      <div className="xixi-memory-settings"><h3>记忆</h3><Toggle title="使用长期记忆" checked={preferences.assistant.useMemory} disabled={!ready || busy} onChange={checked => void savePreferences({ ...preferences, assistant: { ...preferences.assistant, useMemory: checked } })} /><Toggle title="读取以前的对话" checked={preferences.assistant.useHistory} disabled={!ready || busy} onChange={checked => void savePreferences({ ...preferences, assistant: { ...preferences.assistant, useHistory: checked } })} /><p className="xixi-settings-note">关闭只影响之后的回复，本机资料不会删除</p></div>
      <details className="xixi-memory-manager"><summary><span>她记住的事</span><small>{memories.length} 条 · 查看与更正</small></summary>{memories.length === 0 ? <p>还没有长期记忆，从聊天慢慢开始</p> : <ul className="xixi-memory-list">{memories.slice(shownMemoryPage * 3, shownMemoryPage * 3 + 3).map(memory => <li key={memory.id}><div>{editMemory?.id === memory.id ? <form onSubmit={event => { event.preventDefault(); void action(async () => { await localApi(`/memories/${encodeURIComponent(memory.id)}/correct`, { content: editMemory.content, expectedUpdatedAt: memory.updatedAt }); setEditMemory(null) }, '已按你的更正更新记忆') }}><textarea aria-label="更正记忆" value={editMemory.content} maxLength={600} onChange={event => setEditMemory({ ...editMemory, content: event.target.value })} /><div className="xixi-settings-actions"><button disabled={busy || !editMemory.content.trim()}>保存</button><button type="button" onClick={() => setEditMemory(null)}>取消</button></div></form> : <p>{memory.content}</p>}<small>{memory.lifetime === 'inference' ? '待确认理解' : memory.scope === 'task' ? '任务背景' : memory.expiresAt ? '临时记忆' : '长期记忆'}{memory.expiresAt ? ` · 至 ${new Date(memory.expiresAt).toLocaleDateString('zh-CN')}` : ''}</small><details><summary>原话依据</summary><blockquote>{memory.source}</blockquote></details></div><div className="xixi-memory-actions"><button type="button" disabled={busy} onClick={() => setEditMemory({ id: memory.id, content: memory.content })}>更正</button><button type="button" disabled={busy} onClick={() => void action(() => localApi(`/memories/${encodeURIComponent(memory.id)}/forget`, {}), '已经忘记，相关原话退出后续上下文')}>忘记</button></div></li>)}</ul>}{memoryPageCount > 1 && <PageControls label="记忆" page={shownMemoryPage} pageCount={memoryPageCount} disabled={busy} onPage={value => { setMemoryPage(value); setEditMemory(null) }} />}</details></section>
    </>}
    {tab === '时间安排' && <>
      <section><h3>专注与余量</h3><NumberRow title="默认专注" value={preferences.focus.focusMin} min={5} max={120} disabled={!ready || busy} onSave={value => void savePreferences({ ...preferences, focus: { ...preferences.focus, focusMin: value } })} /><NumberRow title="默认休息" value={preferences.focus.restMin} min={1} max={30} disabled={!ready || busy} onSave={value => void savePreferences({ ...preferences, focus: { ...preferences.focus, restMin: value } })} /><NumberRow title="推演时任务之间的缓冲" value={preferences.scheduling.bufferMin} min={0} max={60} disabled={!ready || busy} onSave={value => void savePreferences({ ...preferences, scheduling: { bufferMin: value } })} /><p>时长从下一轮开始使用，正在进行的计时保持完整</p></section>
      <section><h3>固定可安排时段</h3>{['default-evening-study', 'default-weekend-availability'].map(id => { const routine = planner?.routines.find(item => item.id === id); return routine ? <TimeRange key={`${id}:${planner?.revision}`} title={routine.title} start={routine.start} end={routine.end} disabled={busy} onSave={(start, end) => saveRoutine(id, start, end)} /> : <p key={id}>{id === 'default-evening-study' ? '晚自习' : '周末'}时段已移除，可在日程重新添加</p> })}<p>课程、休息、通勤和其他固定安排，在日程的「每周安排」中维护</p></section>
    </>}
    {tab === '通知' && <>
      <div className="xixi-notification-options">
      <section className="xixi-notification-preferences"><h3>提醒方式</h3><Toggle title="站内主动通知" checked={preferences.notifications.enabled} disabled={!ready || busy} onChange={enabled => void savePreferences({ ...preferences, notifications: { ...preferences.notifications, enabled } })} /><Toggle title="空闲与牵挂机会" checked={preferences.notifications.opportunities} disabled={!ready || busy} onChange={opportunities => void savePreferences({ ...preferences, notifications: { ...preferences.notifications, opportunities } })} /><TimeRange key={`${preferences.notifications.quietStart}:${preferences.notifications.quietEnd}`} title="免打扰时段" start={preferences.notifications.quietStart} end={preferences.notifications.quietEnd} disabled={!ready || busy} onSave={(quietStart, quietEnd) => void savePreferences({ ...preferences, notifications: { ...preferences.notifications, quietStart, quietEnd } })} /><p>免打扰期间，操作结果仍会保留在变更记录中</p></section>
      <SystemReminders />
      </div>
      <OperationHistory operations={operations} busy={busy} onAction={action} />
    </>}
    {tab === '外观与动画' && <>
      <section className="xixi-render-section">
        <div className="xixi-settings-section-title"><h3>背景与画质</h3><small>保留同一片视界</small></div>

        <Row title="黑洞背景" note="内置1080p视频与4K静态图；思考数字、回应与弦轨光效叠加在原背景上。"><AdaptiveSelect aria-label="黑洞背景" disabled={!ready || busy} value={preferences.render.background ?? 'realtime'} onChange={event => void savePreferences({ ...preferences, render: { ...preferences.render, background: event.target.value as Preferences['render']['background'] } })}><option value="realtime">实时渲染</option><option value="video">视频</option><option value="image">静态图</option></AdaptiveSelect></Row>
        {preferences.render.background !== 'realtime' && <BackgroundMediaSettings preferences={preferences} disabled={!ready || busy} save={savePreferences} />}
        <Row title="黑洞画质" note="推荐以 60 FPS 为目标，按负载调整并恢复画质；手动选择保持固定。"><AdaptiveSelect aria-label="黑洞画质" disabled={!ready || busy || preferences.render.background !== 'realtime'} value={preferences.render.quality} onChange={event => { const quality = event.target.value as Preferences['render']['quality']; void savePreferences({ ...preferences, render: { ...preferences.render, quality, ...(quality === 'auto' ? { profile: 'full' } : {}) } }) }}><option value="auto">ASTaria 推荐 · 自动</option><option value="ultra">最高</option><option value="high">高</option><option value="low">轻量</option><option value="safe">兼容</option></AdaptiveSelect></Row>
        <div className="xixi-effect-options xixi-render-options" role="group" aria-label="黑洞渲染档位">
          {([['smooth120', '120 FPS', '高刷新率'], ['smooth90', '90 FPS', '高刷新率'], ['full', '60 FPS', '标准流畅'], ['balanced', '45 FPS', '较低频率'], ['economy', '30 FPS', '更低频率']] as const).map(([profile, title, description]) => <button key={profile} type="button" aria-pressed={(preferences.render?.profile ?? 'full') === profile} disabled={!ready || busy || preferences.render.background !== 'realtime' || preferences.render.quality === 'auto'} onClick={() => renderProfile(profile)}><strong>{title}</strong><small>{description}</small></button>)}
        </div>
        <p className="xixi-render-note">选择手动画质后可独立调整帧率。首页与聊天使用所选帧率，工作台、余时等工作区背景为省电最高 30 FPS。高刷受屏幕与设备性能限制。</p>
      </section>
      <div className="xixi-appearance-columns">
        <div className="xixi-appearance-space">
          <section><h3>玻璃与空间</h3><Row title="玻璃渲染" note="自动在 Windows 和 Android 使用系统玻璃，保留通透、磨砂与高光；精细折射保留边缘扭曲，会增加显卡负担，不支持的引擎使用系统玻璃。"><AdaptiveSelect aria-label="玻璃渲染" disabled={!ready || busy} value={preferences.render?.glass ?? 'auto'} onChange={event => void savePreferences({ ...preferences, render: { ...preferences.render, glass: event.target.value as 'auto' | 'detailed' } })}><option value="auto">自动 · 系统适配</option><option value="detailed">精细折射</option></AdaptiveSelect></Row><Row title="界面外观" note="首页、聊天和工作台使用同一外观"><AdaptiveSelect aria-label="界面外观" disabled={!ready || busy} value={preferences.theme} onChange={event => void savePreferences({ ...preferences, theme: event.target.value as 'dark' | 'light' })}><option value="dark">深色</option><option value="light">浅色</option></AdaptiveSelect></Row><Toggle title="背景网格" disabled={!ready || busy} checked={preferences.grid} onChange={grid => void savePreferences({ ...preferences, grid })} /><Row title="玻璃质感"><AdaptiveSelect aria-label="玻璃质感" disabled={!ready || busy} value={preferences.glass} onChange={event => void savePreferences({ ...preferences, glass: event.target.value as 'clear' | 'soft' })}><option value="clear">通透</option><option value="soft">柔和 · 6px 磨砂</option></AdaptiveSelect></Row>{mobile && <Row title="玻璃深浅" note="调整玻璃底色浓淡；界面主题与通透／磨砂单独设置。"><AdaptiveSelect aria-label="玻璃深浅" disabled={!ready || busy} value={preferences.glassTone ?? 'light'} onChange={event => void savePreferences({ ...preferences, glassTone: event.target.value as Preferences['glassTone'] })}><option value="light">淡 · 较少底色</option><option value="dark">深 · 较多底色</option></AdaptiveSelect></Row>}<Row title="卡片装饰线"><AdaptiveSelect aria-label="卡片装饰线" disabled={!ready || busy} value={preferences.cardEdges ?? 'both'} onChange={event => void savePreferences({ ...preferences, cardEdges: event.target.value as Preferences['cardEdges'] })}><option value="both">左右对称</option><option value="left">仅左侧</option><option value="none">隐藏</option></AdaptiveSelect></Row><Row title="信息密度"><AdaptiveSelect aria-label="信息密度" disabled={!ready || busy} value={preferences.density} onChange={event => void savePreferences({ ...preferences, density: event.target.value as Preferences['density'] })}><option value="compact">小巧</option><option value="comfortable">舒展</option></AdaptiveSelect></Row></section>
        </div>
        <section className="xixi-appearance-response"><h3>析熙的回应</h3><div className="xixi-effect-options" role="group" aria-label="黑洞回应特效">{([['tide', '光潮', '光在盘面里呼吸'], ['filaments', '弦光', '沿曲线舒展的光丝'], ['stardust', '引星', '星尘汇聚成光'], ['off', '关闭', '保留原本的黑洞']] as const).map(([style, title, description]) => <button key={style} type="button" aria-pressed={preferences.effect.style === style} disabled={!ready || busy} onClick={() => effect({ style })}><strong>{title}</strong><small>{description}</small></button>)}</div>
        <div className="xixi-appearance-response-controls">
          <Row title="特效强度"><AdaptiveSelect aria-label="特效强度" value={preferences.effect.intensity} disabled={!ready || busy} onChange={event => effect({ intensity: event.target.value as ResponseEffectSettings['intensity'] })}><option value="gentle">轻柔</option><option value="standard">标准</option><option value="vivid">鲜明</option></AdaptiveSelect></Row><Row title="动态偏好"><AdaptiveSelect aria-label="动态偏好" value={preferences.effect.motion} disabled={!ready || busy} onChange={event => effect({ motion: event.target.value as ResponseEffectSettings['motion'] })}><option value="system">跟随系统</option><option value="reduced">减弱动态</option><option value="full">完整动态</option></AdaptiveSelect></Row>
          <Toggle title="思考时显示数字" note="只在析熙思考时出现，回答开始后淡出" checked={binary.enabled} disabled={!ready || busy} onChange={enabled => changeBinary({ enabled })} />
          <BinaryBrightnessRow value={binary.brightness} disabled={!ready || busy || !binary.enabled} onSave={brightness => changeBinary({ brightness })} />
        </div>
        </section>
      </div>
      <div className="xixi-settings-actions xixi-appearance-preview"><button type="button" disabled={!ready || busy || (preferences.effect.style === 'off' && !binary.enabled)} onClick={beginPreview}>预览思考与回复</button><span>无需调用 AI</span></div>
    </>}
    {tab === '数据' && <section><h3>留在你身边</h3><Row title="本机数据库" note={mobile ? '保存在当前设备；可导出备份或恢复数据' : '本机保存；跨设备同步在旁边单独配置'}><span>{status?.storage ?? '正在连接'}</span></Row><Row title="API Key"><span>{status?.secretStorage ?? '系统凭据存储'}</span></Row><p className="xixi-settings-note">备份包含个人事项、对话与记忆，请保存在你信任的位置，密钥始终不包含在内</p><div className="xixi-settings-actions"><button type="button" disabled={busy || !ready} onClick={() => void exportData()}>导出备份</button><label className="xixi-file-label">选择备份<input aria-label="选择备份文件" type="file" accept="application/json,.json" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void selectBackup(file) }} /></label></div>{importFile && <div className="xixi-import-confirm"><p>{importFile.name}</p><p>恢复会替换当前数据库中的事项、对话和记忆，先导出当前备份再继续。历史变更保留但不能再撤销，旧方案需要重新推演</p><button type="button" disabled={busy} onClick={() => void action(async () => { await localApi('/data/import', { backup: importFile.value, confirmed: true }); setImportFile(null); notifyLocalDataChange(); const value = await localApi<Preferences>('/preferences'); publishPreferences(value) }, '备份已恢复，请刷新页面重新读取对话')}>确认恢复此备份</button><button type="button" onClick={() => setImportFile(null)}>取消</button></div>}<p className="xixi-settings-note">删除单段对话在对话菜单中操作；更正和遗忘记忆在「析熙」中操作</p></section>}
    </div>
    <footer className="xixi-settings-feedback" aria-live="polite">{busy ? '正在保存' : error || notice || (mobile ? '设置保存在这台设备上' : '设置保存在这台电脑上')}{error && <button type="button" onClick={() => void action(async () => {}, '已重新读取')}>重新读取</button>}</footer>
    </div>
    </div></div></div>
    <div ref={previewDock} className="xixi-preview-dock" inert={!previewVisible || closing} aria-hidden={!previewVisible || closing}>
      <GlassSamplingContext.Provider value={!closing && previewVisible}><MeasuredGlassSurface radius={mobile ? 20 : 24} material={glass} /></GlassSamplingContext.Provider>
      <div className="xixi-preview-content"><div className="xixi-personality-options" role="group" aria-label="预览回应状态">{([['thinking', '思考'], ['replying', '回复'], ['idle', '静止']] as const).map(([phase, label]) => <button type="button" key={phase} aria-pressed={previewPhase === phase} onClick={() => onPreviewPhaseChange?.(phase)}>{label}</button>)}</div><button type="button" onClick={onStopPreview}>返回设置</button></div>
    </div>
  </section></AdaptiveSelectHost>
}

type SettingsAction = (operation: () => Promise<unknown>, message: string) => Promise<void>
const OPERATION_FILTERS = ['全部', '未读', '已读', '已撤销'] as const
type OperationFilter = typeof OPERATION_FILTERS[number]
function operationStatus(operation: Operation): Exclude<OperationFilter, '全部'> {
  return operation.undoneAt ? '已撤销' : operation.readAt ? '已读' : '未读'
}
function OperationHistory({ operations, busy, onAction }: { operations: Operation[]; busy: boolean; onAction: SettingsAction }) {
  const [filter, setFilter] = useState<OperationFilter>('全部')
  const [page, setPage] = useState(0)
  const filtered = operations.filter(operation => filter === '全部' || operationStatus(operation) === filter)
  const pageCount = Math.max(1, Math.ceil(filtered.length / 4))
  const shownPage = Math.min(page, pageCount - 1)
  const unread = operations.filter(operation => !operation.readAt)
  return <section className="xixi-operation-history" aria-label="变更记录">
    <div className="xixi-settings-section-title"><h3>变更记录</h3><button type="button" disabled={busy || !unread.length} onClick={() => void onAction(() => localApi('/operations/read', { ids: unread.slice(0, 1000).map(operation => operation.id) }), '已标为已读')}>全部已读</button></div>
    <div className="xixi-operation-filters" role="group" aria-label="筛选变更记录">{OPERATION_FILTERS.map(value => <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value); setPage(0) }}>{value}<span>{value === '全部' ? operations.length : operations.filter(operation => operationStatus(operation) === value).length}</span></button>)}</div>
    {filtered.length === 0 ? <div className="xixi-operation-empty"><strong>{operations.length === 0 ? '还没有变更' : `没有${filter}的变更`}</strong><p>析熙完成的操作会显示在这里</p></div> : <ul className="xixi-operation-list">{filtered.slice(shownPage * 4, shownPage * 4 + 4).map(operation => {
      const state = operationStatus(operation)
      const details = operation.details ?? []
      return <li key={operation.id} data-state={state}>
        <div className="xixi-operation-meta"><span className="xixi-operation-state">{state}</span><time dateTime={operation.createdAt} title={new Date(operation.createdAt).toLocaleString('zh-CN')}>{new Date(operation.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</time></div>
        <div className="xixi-operation-body"><p title={operation.summary}>{operation.summary}</p><details><summary>查看详情{details.length ? ` · ${details.length} 项` : ''}</summary><div><p>{operation.summary}</p>{details.length > 0 && <ul>{details.map((detail, index) => <li key={`${index}:${detail}`}>{detail}</li>)}</ul>}{operation.undoneAt && <small>撤销于 {new Date(operation.undoneAt).toLocaleString('zh-CN')}</small>}{!operation.undoneAt && operation.undoable === false && <small>这条记录当前不可撤销</small>}</div></details></div>
        {!operation.undoneAt && operation.undoable !== false && <button className="xixi-operation-undo" type="button" disabled={busy} aria-label={`${operation.undoLabel ?? '撤销'}：${operation.summary}`} onClick={() => void onAction(async () => { await localApi(`/operations/${encodeURIComponent(operation.id)}/undo`, {}); notifyLocalDataChange() }, '变更已撤销')}>{operation.undoLabel ?? '撤销'}</button>}
      </li>
    })}</ul>}
    {filtered.length > 0 && <PageControls label="变更记录" page={shownPage} pageCount={pageCount} disabled={busy} onPage={setPage} />}
  </section>
}
function PageControls({ label, page, pageCount, disabled, onPage }: { label: string; page: number; pageCount: number; disabled: boolean; onPage: (page: number) => void }) {
  return <nav className="xixi-settings-pagination" aria-label={`${label}翻页`}><span aria-live="polite">{page + 1} / {pageCount}</span><button type="button" disabled={disabled || page === 0} aria-label={`${label}上一页`} onClick={() => onPage(page - 1)}>上一页</button><button type="button" disabled={disabled || page + 1 >= pageCount} aria-label={`${label}下一页`} onClick={() => onPage(page + 1)}>下一页</button></nav>
}
function Row({ title, note, children }: { title: string; note?: string; children: ReactNode }) { return <div className="xixi-setting-row"><div><strong>{title}</strong>{note && <small>{note}</small>}</div><div>{children}</div></div> }
function Toggle({ title, note, checked, disabled, onChange }: { title: string; note?: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) { return <Row title={title} note={note}><button className="xixi-toggle" type="button" role="switch" aria-label={title} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></button></Row> }
function NumberRow({ title, value, min, max, disabled, onSave }: { title: string; value: number; min: number; max: number; disabled: boolean; onSave: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value)); useEffect(() => setDraft(String(value)), [value])
  return <Row title={title}><form className="xixi-inline-form" onSubmit={event => { event.preventDefault(); onSave(Number(draft)) }}><input type="number" aria-label={title} min={min} max={max} required value={draft} disabled={disabled} onChange={event => setDraft(event.target.value)} /><span>分钟</span><button disabled={disabled || Number(draft) === value}>保存</button></form></Row>
}
function BinaryBrightnessRow({ value, disabled, onSave }: { value: number; disabled: boolean; onSave: (value: number) => void }) {
  const id = useId()
  const [draft, setDraft] = useState(Math.round(value * 100))
  useEffect(() => setDraft(Math.round(value * 100)), [value])
  const defaultPercent = DEFAULT_BINARY_EFFECT.brightness * 100
  return <Row title="思考数字亮度" note="只调整数字，保存后可预览">
    <form className="xixi-binary-brightness" onSubmit={event => { event.preventDefault(); if (!disabled && draft !== Math.round(value * 100)) onSave(draft / 100) }}>
      <div className="xixi-settings-range-control">
        <input id={id} aria-label="思考数字亮度" aria-valuetext={`${draft}%`} type="range" min={50} max={300} step={5} value={draft} disabled={disabled} onChange={event => setDraft(Number(event.target.value))} />
        <output htmlFor={id}>{draft}%</output>
      </div>
      <div className="xixi-inline-form">
        <button type="submit" disabled={disabled || draft === Math.round(value * 100)}>保存</button>
        <button type="button" disabled={disabled || (draft === defaultPercent && value === DEFAULT_BINARY_EFFECT.brightness)} onClick={() => { setDraft(defaultPercent); if (value !== DEFAULT_BINARY_EFFECT.brightness) onSave(DEFAULT_BINARY_EFFECT.brightness) }}>恢复默认</button>
      </div>
    </form>
  </Row>
}
function TimeRange({ title, start, end, disabled, onSave }: { title: string; start: string; end: string; disabled: boolean; onSave: (start: string, end: string) => void }) {
  const [from, setFrom] = useState(start), [to, setTo] = useState(end)
  return <Row title={title}><form className="xixi-inline-form" onSubmit={event => { event.preventDefault(); onSave(from, to) }}><input aria-label={`${title}开始`} type="time" required value={from} disabled={disabled} onChange={event => setFrom(event.target.value)} /><span>—</span><input aria-label={`${title}结束`} type="time" required value={to} disabled={disabled} onChange={event => setTo(event.target.value)} /><button disabled={disabled || (from === start && to === end)}>保存</button></form></Row>
}
