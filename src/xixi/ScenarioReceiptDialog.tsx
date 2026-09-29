import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { Task } from '../domain/task'
import { localDay } from '../home/agenda'
import { GlassSamplingContext, MeasuredGlassSurface } from '../home/GlassSurface'
import { useLocalTime } from '../home/useLocalTime'
import { usePlanner } from '../planner/usePlanner'
import { setDecisionEffect } from '../prototype/decisionEffect'
import { LOCAL_DATA_CHANGE, notifyLocalDataChange } from '../stores/migration'
import { localApi } from './api'
import type { CompanionState } from './companionTypes'
import { DecisionStudio } from './DecisionStudio'
import { usePreferences } from './preferences'
import './companion.css'
import './scenario-receipt.css'

export type ScenarioReceiptDialogProps = {
  scenarioId: string
  tasks: Task[]
  tasksLoading: boolean
  tasksError: string
  onChanged: () => void | Promise<void>
  onClose: () => void
  onNotice: (message: string) => void
}
const explain = (reason: unknown) => reason instanceof Error ? reason.message : '暂时无法读取推演，请重试'

/** A receipt opens its saved comparison. Opening never applies or regenerates it. */
export function ScenarioReceiptDialog({ scenarioId, tasks, tasksLoading, tasksError, onChanged, onClose, onNotice }: ScenarioReceiptDialogProps) {
  const preferences = usePreferences().value
  const planner = usePlanner(true)
  const now = useLocalTime()
  const id = useId(), dialog = useRef<HTMLDialogElement>(null)
  const [date, setDate] = useState(() => localDay(now))
  const [state, setState] = useState<CompanionState | null>(null)
  const [loading, setLoading] = useState(true)
  const [readError, setReadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const actionLock = useRef(false), revision = useRef(0), mounted = useRef(false)
  const initialized = useRef<string | null>(null)
  const readController = useRef<AbortController | null>(null)
  const refresh = useCallback(async () => {
    const token = ++revision.current
    readController.current?.abort()
    const controller = new AbortController()
    readController.current = controller
    setLoading(true)
    try {
      const value = await localApi<CompanionState>(`/companion?date=${encodeURIComponent(date)}&days=7`, undefined, { signal: controller.signal })
      if (!mounted.current || token !== revision.current) return
      setState(value); setReadError('')
      const selected = value.scenarios.find(item => item.id === scenarioId)
      if (selected && initialized.current !== scenarioId) { initialized.current = scenarioId; setDate(selected.date) }
    } catch (reason) {
      if (mounted.current && token === revision.current && !controller.signal.aborted) setReadError(explain(reason))
    } finally { if (mounted.current && token === revision.current) setLoading(false) }
  }, [date, scenarioId])
  useEffect(() => {
    mounted.current = true
    const element = dialog.current!
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!element.open) element.showModal()
    return () => {
      mounted.current = false; revision.current++; readController.current?.abort()
      element.close(); setDecisionEffect({ active: false })
      if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    void refresh()
    const reload = () => { if (!actionLock.current) void refresh() }
    window.addEventListener(LOCAL_DATA_CHANGE, reload)
    window.addEventListener('focus', reload)
    return () => { revision.current++; readController.current?.abort(); window.removeEventListener(LOCAL_DATA_CHANGE, reload); window.removeEventListener('focus', reload) }
  }, [refresh])
  const selected = state?.scenarios.find(item => item.id === scenarioId)
  const expired = selected?.status === 'preview' && selected.plans.some(plan => new Date(`${plan.date}T${plan.start}:00`).getTime() <= now.getTime())
  const action = async <T,>(operation: () => Promise<T>, success: string, changed = false): Promise<T | undefined> => {
    if (actionLock.current || readError || expired) return undefined
    actionLock.current = true; setBusy(true); setActionError(''); setNotice('')
    try {
      const value = await operation()
      if (changed) notifyLocalDataChange()
      if (mounted.current) { setNotice(success); onNotice(success) }
      await refresh()
      if (changed) {
        try { await planner.refresh(); await onChanged() }
        catch (reason) { if (mounted.current) setActionError(`操作已保存，但页面尚未同步：${explain(reason)}`) }
      }
      return value
    } catch (reason) { if (mounted.current) setActionError(explain(reason)); return undefined }
    finally { actionLock.current = false; if (mounted.current) setBusy(false) }
  }
  const close = () => { if (!actionLock.current) onClose() }
  const material = { transmission: 70, blur: preferences.glass === 'soft' ? 6 : 0, rim: 40, shadow: 30 }
  return <GlassSamplingContext.Provider value={true}><dialog ref={dialog} className="xc-dialog scenario-receipt-dialog" data-theme={preferences.theme} data-glass={preferences.glass}
    aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); close() }} onKeyDown={event => event.stopPropagation()}>
    <MeasuredGlassSurface radius={24} material={material} />
    <div className="xc-shell"><header className="xc-header"><div><h2 id={`${id}-title`}>路线比较</h2><p>查看已保存的推演，采用后才会改变日历</p></div><button type="button" disabled={busy} onClick={close} aria-label="关闭路线比较">关闭</button></header>
      <div className="xc-scroll">
        {readError ? <div className="scenario-receipt-message" role="alert"><p>{readError}</p><button type="button" disabled={loading || busy} onClick={() => void refresh()}>重新读取</button></div>
          : !state ? <p role="status">正在读取这份推演和最新日程…</p>
            : !selected ? <div className="scenario-receipt-message" role="status"><h3>这份推演已不可用</h3><p>它可能已移除，或对应的消息已撤回。日历没有因此改变。</p><button type="button" disabled={loading} onClick={() => void refresh()}>重新读取</button></div>
              : <>
                {expired && <p className="scenario-receipt-message" role="status">这份推演的候选时间已过期，当前仅供查看。请回到聊天重新比较。</p>}
                <DecisionStudio key={scenarioId} tasks={tasks} tasksLoading={tasksLoading} tasksError={tasksError} state={state} date={date} onDate={setDate}
                  plannerRevision={planner.state?.revision} plannerLoading={planner.loading} plannerError={planner.error} loading={loading} busy={busy || Boolean(expired)}
                  action={action} material={material} initialScenarioId={scenarioId} />
              </>}
        {planner.error && <p className="scenario-receipt-message" role="alert">{planner.error}<button type="button" disabled={planner.loading || busy} onClick={() => void planner.refresh()}>重新读取日程</button></p>}
        {actionError && <p className="scenario-receipt-message" role="alert">{actionError}</p>}
        {notice && <p className="scenario-receipt-message" role="status">{notice}</p>}
      </div>
    </div>
  </dialog></GlassSamplingContext.Provider>
}
