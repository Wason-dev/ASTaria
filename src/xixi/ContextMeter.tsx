import { automaticContextBudget } from './contextBudgetPolicy'
import { useId, useRef, useState } from 'react'
import type { XixiConversation } from './useXixiConversation'
import { isContextUsage } from './contextUsage'
import { ContextUsagePanel } from './ContextUsagePanel'
import './context-meter.css'

const number = new Intl.NumberFormat('zh-CN')
const modelLabels: Record<string, string> = { 'deepseek-flash': 'DeepSeek Flash', 'deepseek-v4-pro': 'DeepSeek V4 Pro' }

/** Small, passive meter for the actual model request, never a loading spinner. */
export function ContextMeter({ chat }: { chat: XixiConversation }) {
  const { status } = chat
  const stream = chat.stream
  const raw = stream && stream.conversationId === chat.conversation?.conversationId && stream.contextUsage
    ? stream.contextUsage : chat.conversation?.contextUsage
  const usage = isContextUsage(raw) && raw.modelKey === status?.contextModelKey ? raw : null
  const capacity = status?.contextCapacity ?? null
  const fraction = usage && capacity ? Math.min(1, usage.usedTokens / capacity) : 0
  const percentage = fraction > 0 && fraction < .001 ? '<0.1%' : `${(fraction * 100).toFixed(fraction < .1 ? 1 : 0)}%`
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  if (!status?.model) return null
  const label = modelLabels[status.model] ?? status.model
  const description = usage
    ? `${usage.source === 'estimate' ? '估算 ' : ''}${number.format(usage.usedTokens)} tokens${capacity ? ` / ${capacity === 1_000_000 ? '1M' : number.format(capacity)}，${percentage}` : '，模型上限未知'}`
    : '等待下一次请求统计'
  const budget = status.providerSettings?.contextBudget
  const limit = budget?.mode === 'off' ? null : budget?.mode === 'custom' ? budget.maxUnits : automaticContextBudget({ provider: status.provider }).hard
  return <div className="xixi-context-meter">
    <button ref={trigger} className="xixi-context-control" type="button" aria-label={`${label}，上下文：${description}`} title={`上下文：${description}`}
      aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <svg viewBox="0 0 20 20" aria-hidden="true" data-near-full={fraction >= .8}>
        <circle className="xixi-context-track" cx="10" cy="10" r="7" />
        <circle className="xixi-context-used" cx="10" cy="10" r="7" pathLength="100" strokeDasharray={`${fraction * 100} 100`} transform="rotate(-90 10 10)" />
      </svg><span>{label}</span>
    </button>
    {open && trigger.current && <ContextUsagePanel anchor={trigger.current} id={id} onClose={() => setOpen(false)}>
      <div className="xixi-context-heading"><strong>{usage ? `${usage.source === 'estimate' ? '约 ' : ''}${number.format(usage.usedTokens)}${capacity ? ` / ${capacity === 1_000_000 ? '1M' : number.format(capacity)}` : ''}` : '等待下一次请求统计'}</strong><span>{usage && capacity ? percentage : '—'}</span></div>
      {usage && <dl><div><dt>输入</dt><dd>{number.format(usage.inputTokens)}</dd></div><div><dt>输出</dt><dd>{stream && usage.source === 'estimate' && usage.outputTokens === 0 ? '等待输出' : number.format(usage.outputTokens)}</dd></div></dl>}
      <small>{usage?.source === 'provider' ? '本次上下文占用，来自接口返回。' : usage ? '本次上下文占用的估算值，接口返回后校正。' : '发送后统计实际交给模型的内容。'}</small>
      {usage && <small>输入包含本次带入的历史对话、资料和工具；输出为本次生成。历史压缩或读取范围变化时，占用也会变化。</small>}
      {capacity === null && <small>当前服务未提供上下文上限。</small>}
      {limit && <small>{budget?.mode === 'custom' ? '自定义输入预算' : '自动输入预算'} {number.format(limit)}；约 {number.format(budget?.mode === 'custom' ? limit * 2 / 3 : automaticContextBudget({ provider: status.provider }).soft)} 起整理历史，圆环按模型窗口显示。</small>}
    </ContextUsagePanel>}
  </div>
}
