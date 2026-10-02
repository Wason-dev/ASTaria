import { useEffect, useMemo, useRef, useState } from 'react'
import { MeasuredGlassSurface } from './GlassSurface'
import { HOME_GLASS } from './glass'
import { localApi } from '../xixi/api'
import { publishPreferences } from '../xixi/preferences'
import type { Preferences } from '../xixi/preferences'
import './first-run.css'

const TOUR = [
  { title: '首页', page: 'home', target: '.home-launch', detail: '左侧显示当前任务，析熙的对话与今天的安排在同一处。', action: '试着点「交给析熙」展开对话和今日安排，再收起。正式记录后，请核对变更回执；需要时可撤销。' },
  { title: '余时', page: 'free-time', target: '.free-time-tabs[aria-label="余时目标分类"]', detail: '长期目标、还没决定的心愿，以及已经安排的时间都在这里。', action: '试着切换「目标」与「待考虑」。心愿先聊清楚，选择加入自动安排后才会占用日程。' },
  { title: '日程', page: 'schedule', target: '.pl-segment', detail: '课程、任务和可用时段在同一条时间线上。', action: '试着切换月、周、日视图，核对今天的空档；隔周课程可在「每周安排」维护。' },
  { title: '工作台', page: 'workbench', target: '.wb-available .wb-task:first-child', detail: '正在做和即将截止的事项集中在这里。', action: '有事项时，在「现在可以开始」打开一项查看步骤，再返回；这里暂时为空的话，先从首页记录事项。' },
  { title: '弦轨', page: 'home', target: undefined, detail: '首页的黑洞通向弦轨，在这里按日期审视安排。', action: '打开弦轨，切换一次日期，再返回。预览只读取本机安排；正式使用时可以整理、调整顺序，按「完成」才会写入。' },
] as const

type TourPage = (typeof TOUR)[number]['page']
export function FirstRunGuide({ preferences, previewOpen, previewComplete, onStartHorizon, onPreviewThemeChange, onTourPageChange, onDone }: { preferences: Preferences; previewOpen: boolean; previewComplete: boolean; onStartHorizon: () => void; onPreviewThemeChange: (theme: 'dark' | 'light' | null) => void; onTourPageChange: (page: TourPage) => void; onDone: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [step, setStep] = useState(0)
  const [personality, setPersonality] = useState(preferences.assistant.personality)
  const [glass, setGlass] = useState(preferences.glass)
  const [theme, setTheme] = useState(preferences.theme)
  const [key, setKey] = useState('')
  const [keySaved, setKeySaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tourActions, setTourActions] = useState<Record<number, number>>({})
  const actionStage = tourActions[step] ?? 0
  const glassMaterial = useMemo(() => ({ transmission: HOME_GLASS.chatTransmission, blur: glass === 'soft' ? 6 : 0, rim: HOME_GLASS.rim, reflection: HOME_GLASS.reflection, shadow: HOME_GLASS.shadow }), [glass])
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (element.open) element.close()
    if (previewOpen) return
    if (step < 2) element.showModal()
    else element.show()
    element.querySelector<HTMLButtonElement>('.first-run-next')?.focus({ preventScroll: true })
    return () => { if (element.open) element.close() }
  }, [step >= 2, previewOpen])
  useEffect(() => {
    const target = step >= 2 ? TOUR[step - 2]?.target : undefined
    if (!target) return
    const timer = window.setTimeout(() => {
      document.querySelector(target)?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
    }, 360)
    return () => window.clearTimeout(timer)
  }, [step])
  useEffect(() => {
    if (step < 2) return
    const element = dialog.current
    const workspace = element?.parentElement
    if (!element || !workspace) return
    const observer = new ResizeObserver(() => workspace.style.setProperty('--first-run-tour-height', `${element.getBoundingClientRect().height}px`))
    observer.observe(element)
    return () => { observer.disconnect(); workspace.style.removeProperty('--first-run-tour-height') }
  }, [step >= 2])
  useEffect(() => {
    if (step < 2 || step > 5) return
    let initialPlannerMode: string | undefined
    const check = () => {
      const current = tourActions[step] ?? 0
      let reached = current
      if (step === 2) {
        const progress = document.querySelector<HTMLElement>('.home-morph')?.dataset.progress
        const open = document.querySelector<HTMLElement>('#home-xixi')?.inert === false
        if (current === 0 && progress === '1.000' && open) reached = 1
        if (current === 1 && progress === '0.000' && !open) reached = 2
      } else if (step === 3) {
        const tabs = document.querySelector('.free-time-tabs[aria-label="余时目标分类"]')
        if (current === 0 && tabs?.querySelector('button:nth-child(2)')?.getAttribute('aria-pressed') === 'true') reached = 1
        if (current === 1 && tabs?.querySelector('button:first-child')?.getAttribute('aria-pressed') === 'true') reached = 2
      } else if (step === 4) {
        const mode = document.querySelector<HTMLElement>('.planner')?.dataset.mode
        if (mode && !initialPlannerMode) initialPlannerMode = mode
        if (current === 0 && mode && mode !== initialPlannerMode) reached = 1
      } else if (step === 5) {
        const detailsOpen = Boolean(document.querySelector('.wb-back'))
        if (current === 0 && detailsOpen) reached = 1
        if (current === 1 && !detailsOpen) reached = 2
      }
      if (reached !== current) setTourActions(value => ({ ...value, [step]: reached }))
    }
    check()
    const timer = window.setInterval(check, 150)
    return () => window.clearInterval(timer)
  }, [step, tourActions])
  useEffect(() => { onPreviewThemeChange(theme) }, [theme, onPreviewThemeChange])
  useEffect(() => () => onPreviewThemeChange(null), [onPreviewThemeChange])
  const next = async () => {
    if (busy) return
    setError(''); setBusy(true)
    try {
      if (step === 0) {
        const current = await localApi<Preferences>('/preferences')
        const value: Preferences = { ...current, theme, glass, assistant: { ...current.assistant, personality } }
        if (JSON.stringify(value) !== JSON.stringify(current)) publishPreferences(await localApi<Preferences>('/preferences', { expected: current, value }))
      } else if (step === 1 && key.trim()) {
        await localApi('/settings/key', { key: key.trim() })
        setKey(''); setKeySaved(true)
      }
      if (step === TOUR.length + 1) {
        await localApi('/onboarding', { completed: true })
        onTourPageChange('home')
        onDone()
      } else {
        if (step + 1 >= 2) onTourPageChange(TOUR[step - 1].page)
        setStep(value => value + 1)
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : '暂时无法保存，请重试') }
    finally { setBusy(false) }
  }
  const tour = step >= 2 ? TOUR[step - 2] : null
  return <dialog ref={dialog} className="first-run" aria-labelledby="first-run-title" aria-describedby={tour ? 'first-run-action' : undefined} onCancel={event => event.preventDefault()} data-theme={theme} data-glass={glass} data-tour={Boolean(tour)} data-step={step}>
    <MeasuredGlassSurface radius={20} material={glassMaterial} />
    <div className="first-run-content">
      <header><span className="first-run-brand">AST<span>aria</span></span><span className="first-run-count">{String(step + 1).padStart(2, '0')} / {String(TOUR.length + 2).padStart(2, '0')}</span></header>
      <div className="first-run-progress" aria-label={`引导进度，第 ${step + 1} 步，共 ${TOUR.length + 2} 步`}>{Array.from({ length: TOUR.length + 2 }, (_, index) => <i key={index} data-current={index === step} data-complete={index < step} />)}</div>
      <main>
        {step === 0 && <><span className="first-run-eyebrow">01 / 外观与析熙</span><h2 id="first-run-title">让 ASTaria 适合你</h2>
          <fieldset><legend>析熙的个性</legend><div className="first-run-options">{([['low', '低'], ['medium', '中'], ['high', '高']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={personality === value} onClick={() => setPersonality(value)}>{label}</button>)}</div></fieldset>
          <fieldset><legend>玻璃质感</legend><div className="first-run-options">{([['soft', '磨砂玻璃'], ['clear', theme === 'dark' ? '黑色玻璃' : '通透玻璃']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={glass === value} onClick={() => setGlass(value)}>{label}</button>)}</div></fieldset>
          <fieldset><legend>背景</legend><div className="first-run-options">{([['dark', '深色'], ['light', '浅色']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={theme === value} onClick={() => setTheme(value)}>{label}</button>)}</div></fieldset>
        </>}
        {step === 1 && <><span className="first-run-eyebrow">02 / 模型连接</span><h2 id="first-run-title">连接析熙</h2><p>已有 DeepSeek API Key 可以现在导入；也可以稍后在设置中配置本地模型或密钥。</p>
          <label htmlFor="first-run-key">API Key</label><input id="first-run-key" type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} placeholder="输入后保存到本机钥匙串" />
          {keySaved && <p role="status">密钥已存入本机钥匙串。</p>}
        </>}
        {tour && <><span className="first-run-eyebrow">{String(step + 1).padStart(2, '0')} / 认识 ASTaria</span><h2 id="first-run-title">{tour.title}</h2><p>{tour.detail}</p><p id="first-run-action" className="first-run-action">{tour.action}</p>{step === 6 && <button type="button" className="first-run-preview" onClick={() => { dialog.current?.close(); onStartHorizon() }}>进入弦轨预览</button>}{step < 6 && actionStage > 0 && <p className="first-run-feedback" role="status">{actionStage === 2 || step === 4 ? '已完成这一步' : '再试一次：回到刚才的视图'}</p>}{step === 6 && previewComplete && <p className="first-run-feedback" role="status">已完成这一步</p>}</>}
      </main>
      <footer><span role="alert">{error}</span><div>{step > 0 && <button type="button" disabled={busy} onClick={() => { setError(''); if (step - 1 >= 2) onTourPageChange(TOUR[step - 3].page); else onTourPageChange('home'); setStep(value => value - 1) }}>上一步</button>}<button type="button" className="first-run-next" disabled={busy} onClick={() => void next()}>{busy ? '正在保存…' : step === TOUR.length + 1 ? previewComplete ? '开始使用' : '跳过并开始' : step === 1 && !key.trim() ? '稍后配置' : step >= 2 && step <= 5 && actionStage < (step === 4 ? 1 : 2) ? '跳过此步' : '继续'}</button></div></footer>
    </div>
  </dialog>
}
