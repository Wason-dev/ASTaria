import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { localApi } from './api'
import type { LocalStatus, Memory, Operation } from './types'
import type { PlannerState } from '../planner/types'
import type { ResponseEffectSettings, ResponsePhase } from '../prototype/responseEffects'
import { DEFAULT_PREFERENCES, publishPreferences, usePreferences } from './preferences'
import type { Preferences } from './preferences'
import { notifyLocalDataChange } from '../stores/migration'
import { GlassSamplingContext, MeasuredGlassSurface } from '../home/GlassSurface'
import { WorkspaceHeading } from '../ui/WorkspaceHeading'
import { ModelConnection } from './ModelConnection'
import './settings.css'

const TABS = ['通用', '析熙', '时间安排', '通知', '外观与动画', '数据'] as const
const PERSONALITY_LEVELS = [
  { value: 'low', label: '低', description: '简洁温和' },
  { value: 'medium', label: '中', description: '自然俏皮' },
  { value: 'high', label: '高', description: '小得意，有点小腹黑，温柔认真' },
] as const
type Tab = typeof TABS[number]
type Props = {
  onClose: () => void; onSaved: () => void | Promise<void>
  onEffectChange?: (value: ResponseEffectSettings) => void; onPreviewEffect?: () => void; onStopPreview?: () => void
  previewPhase?: ResponsePhase | null; initialTab?: Tab
}
export function LocalSettings({ onClose, onSaved, onEffectChange, onPreviewEffect, onStopPreview, previewPhase, initialTab = '析熙' }: Props) {
  const page = useRef<HTMLElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const previewDock = useRef<HTMLDivElement>(null)
  const previewTrigger = useRef<HTMLElement | null>(null)
  const savedScroll = useRef(0)
  const [previewState, setPreviewState] = useState<'closed' | 'entering' | 'active' | 'leaving'>('closed')
  const [retainedPhase, setRetainedPhase] = useState<ResponsePhase>('thinking')
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const saving = useRef(false)
  const [closing, setClosing] = useState(false)
  const [tab, setTab] = useState<Tab>(initialTab)
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
    return () => { clearTimeout(closeTimer.current) }
  }, [])
  const previewVisible = previewPhase != null
  useLayoutEffect(() => {
    if (previewVisible) {
      savedScroll.current = scroll.current?.scrollTop ?? 0
      previewTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setPreviewState('entering')
      const timer = setTimeout(() => setPreviewState('active'), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 240)
      const frame = requestAnimationFrame(() => previewDock.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true }))
      return () => { clearTimeout(timer); cancelAnimationFrame(frame) }
    }
    if (previewState !== 'closed') {
      setPreviewState('leaving')
      if (scroll.current) scroll.current.scrollTop = savedScroll.current
      const timer = setTimeout(() => {
        setPreviewState('closed')
        if (scroll.current) scroll.current.scrollTop = savedScroll.current
        if (previewTrigger.current?.isConnected) previewTrigger.current.focus({ preventScroll: true })
      }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180)
      return () => clearTimeout(timer)
    }
  }, [previewVisible])
  useEffect(() => { if (previewPhase != null) setRetainedPhase(previewPhase) }, [previewPhase])
  const close = () => {
    if (saving.current || closing) return
    onStopPreview?.(); setClosing(true)
    closeTimer.current = setTimeout(onClose, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180)
  }
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return
      event.preventDefault()
      if (previewVisible) onStopPreview?.()
      else close()
    }
    window.addEventListener('keydown', keyboard)
    return () => window.removeEventListener('keydown', keyboard)
  }, [previewVisible, closing, onStopPreview, onClose])
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
  }, '设置已保存，同一台电脑的浏览器共用')
  const effect = (patch: Partial<ResponseEffectSettings>) => { const next = { ...preferences.effect, ...patch }; void savePreferences({ ...preferences, effect: next }) }
  const renderProfile = (profile: Preferences['render']['profile']) => { void savePreferences({ ...preferences, render: { profile } }) }
  const saveRoutine = (id: string, start: string, end: string) => {
    const routine = planner?.routines.find(item => item.id === id)
    if (!planner || !routine) return
    void action(async () => { await localApi('/planner', { expectedRevision: planner.revision, action: { type: 'save-routine', routine: { ...routine, start, end } } }); notifyLocalDataChange() }, '可安排时段已更新')
  }
  const exportData = () => action(async () => {
    const backup = await localApi('/data/export')
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = `ASTaria-backup-${new Date().toLocaleDateString('en-CA')}.json`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 30000)
  }, '备份已下载，不包含 API Key')
  const shownPhase = previewPhase ?? retainedPhase
  const previewing = previewVisible || previewState === 'leaving'
  const personality = preferences.assistant.personality ?? 'high'
  const memoryPageCount = Math.max(1, Math.ceil(memories.length / 3))
  const shownMemoryPage = Math.min(memoryPage, memoryPageCount - 1)
  const glass = { transmission: 70, blur: preferences.glass === 'soft' ? 6 : 0, rim: 40, shadow: 30 }
  return <section ref={page} className="xixi-settings" data-theme={preferences.theme} data-grid={preferences.grid} data-closing={closing} data-previewing={previewing} data-preview-state={previewState} aria-label="设置">
    <div className="xixi-settings-background" aria-hidden="true" />
    <div ref={scroll} className="xixi-settings-scroll workspace-page-viewport" inert={previewVisible || closing} aria-hidden={previewVisible || closing}>
    <div className="xixi-settings-container workspace-page-container">
    <WorkspaceHeading className="xixi-settings-page-header" title="设置" description="按你的节奏，照顾每一天" titleId="xixi-settings-title"><button type="button" className="xixi-settings-close" aria-label="返回上一页" disabled={busy} onClick={close}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m9.5 3-5 5 5 5M5 8h8" /></svg><span>返回</span></button></WorkspaceHeading>
    <div className="xixi-settings-panel">
    <GlassSamplingContext.Provider value={!closing && !previewVisible}><MeasuredGlassSurface radius={24} material={glass} /></GlassSamplingContext.Provider>
    <div className="xixi-settings-shell">
    <nav className="xixi-settings-tabs" aria-label="设置分区">{TABS.map(item => <button key={item} type="button" aria-current={tab === item ? 'page' : undefined} onClick={() => { setTab(item); onStopPreview?.(); scroll.current?.scrollTo({ top: 0 }) }}>{item}</button>)}</nav>
    <div className="xixi-settings-content" data-section={tab} key={tab}>
    {tab === '通用' && <section><h3>按照你的习惯打开</h3><Row title="启动页面" note="首页始终保留沉浸式黑洞"><select aria-label="启动页面" value={(['calendar', 'timetable'].includes(preferences.startupPage) ? 'schedule' : preferences.startupPage)} disabled={!ready || busy} onChange={event => void savePreferences({ ...preferences, startupPage: event.target.value as Preferences['startupPage'] })}><option value="home">首页</option><option value="workbench">工作台</option><option value="schedule">日程</option><option value="companion">余时</option></select></Row><Row title="当前日期与时区" note="日期和钟点跟随这台电脑，避免产生两套时间"><output>{Intl.DateTimeFormat().resolvedOptions().timeZone}<br />{new Date().toLocaleString('zh-CN', { hourCycle: 'h23' })}</output></Row><Row title="当前任务" note="明确的 DDL 优先，再结合进行状态和重要程度"><span>与工作台共用真实事项</span></Row></section>}
    {tab === '析熙' && <>
      <ModelConnection status={status} busy={busy} onAction={action} />
      <section className="xixi-assistant-preferences"><h3>相处与决定</h3>
        <Row title="析熙个性" note={PERSONALITY_LEVELS.find(level => level.value === personality)?.description}>
          <div className="xixi-personality-options" role="group" aria-label="析熙个性">{PERSONALITY_LEVELS.map(level => <button key={level.value} type="button" disabled={!ready || busy} aria-pressed={personality === level.value} title={level.description} onClick={() => { if (personality !== level.value) void savePreferences({ ...preferences, assistant: { ...preferences.assistant, personality: level.value } }) }}>{level.label}</button>)}</div>
        </Row>
        <p className="xixi-settings-note">只调整表达方式；出错或聊严肃话题时，仍会认真对待</p>
        <Row title="主动程度" note="推演始终先预览，应用后的真实变更保留通知和撤销"><select aria-label="析熙主动程度" disabled={!ready || busy} value={preferences.assistant.autonomy} onChange={event => void savePreferences({ ...preferences, assistant: { ...preferences.assistant, autonomy: event.target.value as 'act' | 'propose' } })}><option value="act">明确的事直接帮我做</option><option value="propose">先提出方案</option></select></Row>
      <div className="xixi-memory-settings"><h3>记忆</h3><Toggle title="使用长期记忆" checked={preferences.assistant.useMemory} disabled={!ready || busy} onChange={checked => void savePreferences({ ...preferences, assistant: { ...preferences.assistant, useMemory: checked } })} /><Toggle title="读取以前的对话" checked={preferences.assistant.useHistory} disabled={!ready || busy} onChange={checked => void savePreferences({ ...preferences, assistant: { ...preferences.assistant, useHistory: checked } })} /><p className="xixi-settings-note">关闭只影响之后的回复，本机资料不会删除</p></div>
      <details className="xixi-memory-manager"><summary><span>她记住的事</span><small>{memories.length} 条 · 查看与更正</small></summary>{memories.length === 0 ? <p>还没有长期记忆，从聊天慢慢开始</p> : <ul className="xixi-memory-list">{memories.slice(shownMemoryPage * 3, shownMemoryPage * 3 + 3).map(memory => <li key={memory.id}><div>{editMemory?.id === memory.id ? <form onSubmit={event => { event.preventDefault(); void action(async () => { await localApi(`/memories/${encodeURIComponent(memory.id)}/correct`, { content: editMemory.content, expectedUpdatedAt: memory.updatedAt }); setEditMemory(null) }, '已按你的更正更新记忆') }}><textarea aria-label="更正记忆" value={editMemory.content} maxLength={600} onChange={event => setEditMemory({ ...editMemory, content: event.target.value })} /><div className="xixi-settings-actions"><button disabled={busy || !editMemory.content.trim()}>保存</button><button type="button" onClick={() => setEditMemory(null)}>取消</button></div></form> : <p>{memory.content}</p>}<small>{memory.lifetime === 'inference' ? '待确认理解' : memory.scope === 'task' ? '任务背景' : memory.expiresAt ? '临时记忆' : '长期记忆'}{memory.expiresAt ? ` · 至 ${new Date(memory.expiresAt).toLocaleDateString('zh-CN')}` : ''}</small><details><summary>原话依据</summary><blockquote>{memory.source}</blockquote></details></div><div className="xixi-memory-actions"><button type="button" disabled={busy} onClick={() => setEditMemory({ id: memory.id, content: memory.content })}>更正</button><button type="button" disabled={busy} onClick={() => void action(() => localApi(`/memories/${encodeURIComponent(memory.id)}/forget`, {}), '已经忘记，相关原话退出后续上下文')}>忘记</button></div></li>)}</ul>}{memoryPageCount > 1 && <PageControls label="记忆" page={shownMemoryPage} pageCount={memoryPageCount} disabled={busy} onPage={value => { setMemoryPage(value); setEditMemory(null) }} />}</details></section>
    </>}
    {tab === '时间安排' && <>
      <section><h3>专注与余量</h3><NumberRow title="默认专注" value={preferences.focus.focusMin} min={5} max={120} disabled={!ready || busy} onSave={value => void savePreferences({ ...preferences, focus: { ...preferences.focus, focusMin: value } })} /><NumberRow title="默认休息" value={preferences.focus.restMin} min={1} max={30} disabled={!ready || busy} onSave={value => void savePreferences({ ...preferences, focus: { ...preferences.focus, restMin: value } })} /><NumberRow title="推演时任务之间的缓冲" value={preferences.scheduling.bufferMin} min={0} max={60} disabled={!ready || busy} onSave={value => void savePreferences({ ...preferences, scheduling: { bufferMin: value } })} /><p>时长从下一轮开始使用，正在进行的计时保持完整</p></section>
      <section><h3>固定可安排时段</h3>{['default-evening-study', 'default-weekend-availability'].map(id => { const routine = planner?.routines.find(item => item.id === id); return routine ? <TimeRange key={`${id}:${planner?.revision}`} title={routine.title} start={routine.start} end={routine.end} disabled={busy} onSave={(start, end) => saveRoutine(id, start, end)} /> : <p key={id}>{id === 'default-evening-study' ? '晚自习' : '周末'}时段已移除，可在日程重新添加</p> })}<p>课程、休息、通勤和其他固定安排，在日程的「每周安排」中维护</p></section>
    </>}
    {tab === '通知' && <>
      <section className="xixi-notification-preferences"><h3>提醒方式</h3><Toggle title="站内主动通知" checked={preferences.notifications.enabled} disabled={!ready || busy} onChange={enabled => void savePreferences({ ...preferences, notifications: { ...preferences.notifications, enabled } })} /><Toggle title="空闲与牵挂机会" checked={preferences.notifications.opportunities} disabled={!ready || busy} onChange={opportunities => void savePreferences({ ...preferences, notifications: { ...preferences.notifications, opportunities } })} /><TimeRange key={`${preferences.notifications.quietStart}:${preferences.notifications.quietEnd}`} title="免打扰时段" start={preferences.notifications.quietStart} end={preferences.notifications.quietEnd} disabled={!ready || busy} onSave={(quietStart, quietEnd) => void savePreferences({ ...preferences, notifications: { ...preferences.notifications, quietStart, quietEnd } })} /><p>免打扰期间，操作结果仍会保留在变更记录中</p></section>
      <OperationHistory operations={operations} busy={busy} onAction={action} />
    </>}
    {tab === '外观与动画' && <>
      <section className="xixi-render-section">
        <div className="xixi-settings-section-title"><h3>黑洞渲染档位</h3><small>随页面自动调整</small></div>
        <div className="xixi-effect-options xixi-render-options" role="group" aria-label="黑洞渲染档位">
          {([['smooth120', '满特效 120', '最高画质'], ['smooth90', '满特效 90', '最高画质'], ['full', '满特效 60', '最高画质'], ['balanced', '轻特效 45', '轻量画质'], ['economy', '低特效 30', '更低功耗']] as const).map(([profile, title, description]) => <button key={profile} type="button" aria-pressed={(preferences.render?.profile ?? 'full') === profile} disabled={!ready || busy} onClick={() => renderProfile(profile)}><strong>{title}</strong><small>{description}</small></button>)}
        </div>
        <p className="xixi-render-note">首页与聊天按所选帧率运行，其他页面最高 60 FPS。高刷受屏幕刷新率与设备性能限制。</p>
      </section>
      <section><h3>玻璃与空间</h3><Row title="界面外观" note="首页、聊天和工作台使用同一外观"><select aria-label="界面外观" disabled={!ready || busy} value={preferences.theme} onChange={event => void savePreferences({ ...preferences, theme: event.target.value as 'dark' | 'light' })}><option value="dark">深色</option><option value="light">浅色</option></select></Row><Toggle title="背景网格" disabled={!ready || busy} checked={preferences.grid} onChange={grid => void savePreferences({ ...preferences, grid })} /><Row title="玻璃质感"><select aria-label="玻璃质感" disabled={!ready || busy} value={preferences.glass} onChange={event => void savePreferences({ ...preferences, glass: event.target.value as 'clear' | 'soft' })}><option value="clear">通透</option><option value="soft">柔和 · 6px 磨砂</option></select></Row><Row title="卡片装饰线"><select aria-label="卡片装饰线" disabled={!ready || busy} value={preferences.cardEdges ?? 'both'} onChange={event => void savePreferences({ ...preferences, cardEdges: event.target.value as Preferences['cardEdges'] })}><option value="both">左右对称</option><option value="left">仅左侧</option><option value="none">隐藏</option></select></Row><Row title="信息密度"><select aria-label="信息密度" disabled={!ready || busy} value={preferences.density} onChange={event => void savePreferences({ ...preferences, density: event.target.value as 'compact' | 'comfortable' })}><option value="compact">小巧</option><option value="comfortable">舒展</option></select></Row></section>
      <section><h3>析熙的回应</h3><div className="xixi-effect-options" role="group" aria-label="黑洞回应特效">{([['tide', '光潮', '光在盘面里呼吸'], ['filaments', '弦光', '沿曲线舒展的光丝'], ['stardust', '引星', '星尘汇聚成光'], ['off', '关闭', '保留原本的黑洞']] as const).map(([style, title, description]) => <button key={style} type="button" aria-pressed={preferences.effect.style === style} disabled={!ready || busy} onClick={() => effect({ style })}><strong>{title}</strong><small>{description}</small></button>)}</div><Row title="光效强度"><select aria-label="光效强度" value={preferences.effect.intensity} disabled={!ready || busy} onChange={event => effect({ intensity: event.target.value as ResponseEffectSettings['intensity'] })}><option value="gentle">轻柔</option><option value="standard">标准</option><option value="vivid">鲜明</option></select></Row><Row title="动态偏好"><select aria-label="动态偏好" value={preferences.effect.motion} disabled={!ready || busy} onChange={event => effect({ motion: event.target.value as ResponseEffectSettings['motion'] })}><option value="system">跟随系统</option><option value="reduced">减弱动态</option><option value="full">完整动态</option></select></Row><div className="xixi-settings-actions"><button type="button" disabled={preferences.effect.style === 'off'} onClick={onPreviewEffect}>预览思考与回复</button>{previewPhase != null && <button type="button" onClick={onStopPreview}>结束预览</button>}<span role="status">{previewPhase === 'thinking' ? '思考 · 正在汇聚' : previewPhase === 'replying' ? '回复 · 光流舒展' : previewPhase === 'idle' ? '余光正在平息' : '无需调用 AI'}</span></div></section>
    </>}
    {tab === '数据' && <section><h3>留在你身边</h3><Row title="本机数据库" note="同一台电脑的浏览器共用，不是跨设备同步"><span>{status?.storage ?? '正在连接'}</span></Row><Row title="API Key"><span>macOS 钥匙串</span></Row><p className="xixi-settings-note">备份包含个人事项、对话与记忆，请保存在你信任的位置，密钥始终不包含在内</p><div className="xixi-settings-actions"><button type="button" disabled={busy || !ready} onClick={() => void exportData()}>导出备份</button><label className="xixi-file-label">选择备份<input aria-label="选择备份文件" type="file" accept="application/json,.json" disabled={busy} onChange={async event => { const file = event.target.files?.[0]; if (!file) return; try { if (file.size > 32 * 1024 * 1024) throw new Error('备份过大'); setImportFile({ name: file.name, value: JSON.parse(await file.text()) }); setError('') } catch { setError('无法读取该备份，请选择 ASTaria 导出的 JSON 文件') } event.target.value = '' }} /></label></div>{importFile && <div className="xixi-import-confirm"><p>{importFile.name}</p><p>恢复会替换当前数据库中的事项、对话和记忆，先导出当前备份再继续。历史变更保留但不能再撤销，旧方案需要重新推演</p><button type="button" disabled={busy} onClick={() => void action(async () => { await localApi('/data/import', { backup: importFile.value, confirmed: true }); setImportFile(null); notifyLocalDataChange(); const value = await localApi<Preferences>('/preferences'); publishPreferences(value) }, '备份已恢复，请刷新页面重新读取对话')}>确认恢复此备份</button><button type="button" onClick={() => setImportFile(null)}>取消</button></div>}<p className="xixi-settings-note">删除单段对话在对话菜单中操作；更正和遗忘记忆在「析熙」中操作</p></section>}
    </div>
    <footer className="xixi-settings-feedback" aria-live="polite">{busy ? '正在保存' : error || notice || '设置保存在这台电脑上'}{error && <button type="button" onClick={() => void action(async () => {}, '已重新读取')}>重新读取</button>}</footer>
    </div>
    </div></div></div>
    {previewing && <div ref={previewDock} className="xixi-preview-dock" inert={!previewVisible} aria-hidden={!previewVisible}>
      <GlassSamplingContext.Provider value={previewVisible && !closing}><MeasuredGlassSurface radius={24} material={glass} /></GlassSamplingContext.Provider>
      <div className="xixi-preview-content"><span role="status">{shownPhase === 'thinking' ? '思考 · 正在汇聚' : shownPhase === 'replying' ? '回复 · 光流舒展' : '余光正在平息'}</span><div>{([['tide', '光潮'], ['filaments', '弦光'], ['stardust', '引星']] as const).map(([style, label]) => <button type="button" key={style} disabled={!ready || busy} aria-pressed={preferences.effect.style === style} onClick={() => effect({ style })}>{label}</button>)}</div><button type="button" onClick={onPreviewEffect}>再看一次</button><button type="button" onClick={onStopPreview}>返回设置</button></div>
    </div>}
  </section>
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
function Toggle({ title, checked, disabled, onChange }: { title: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) { return <Row title={title}><button className="xixi-toggle" type="button" role="switch" aria-label={title} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></button></Row> }
function NumberRow({ title, value, min, max, disabled, onSave }: { title: string; value: number; min: number; max: number; disabled: boolean; onSave: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value)); useEffect(() => setDraft(String(value)), [value])
  return <Row title={title}><form className="xixi-inline-form" onSubmit={event => { event.preventDefault(); onSave(Number(draft)) }}><input type="number" aria-label={title} min={min} max={max} required value={draft} disabled={disabled} onChange={event => setDraft(event.target.value)} /><span>分钟</span><button disabled={disabled || Number(draft) === value}>保存</button></form></Row>
}
function TimeRange({ title, start, end, disabled, onSave }: { title: string; start: string; end: string; disabled: boolean; onSave: (start: string, end: string) => void }) {
  const [from, setFrom] = useState(start), [to, setTo] = useState(end)
  return <Row title={title}><form className="xixi-inline-form" onSubmit={event => { event.preventDefault(); onSave(from, to) }}><input aria-label={`${title}开始`} type="time" required value={from} disabled={disabled} onChange={event => setFrom(event.target.value)} /><span>—</span><input aria-label={`${title}结束`} type="time" required value={to} disabled={disabled} onChange={event => setTo(event.target.value)} /><button disabled={disabled || (from === start && to === end)}>保存</button></form></Row>
}
