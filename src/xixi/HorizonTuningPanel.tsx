import { useRef, useState } from 'react'
import { DEFAULT_HORIZON_TUNING, HORIZON_LIMITS, normalizeHorizonTuning } from './horizonTuning'
import type { HorizonTuning } from './horizonTuning'

const CONTROLS: Array<{ key: keyof HorizonTuning; label: string; step: number; unit?: string; percent?: boolean }> = [
  { key: 'height', label: '地平线位置', step: .01, percent: true },
  { key: 'curvature', label: '地平线弧度', step: .01, percent: true },
  { key: 'thickness', label: '光带厚度', step: 1, unit: 'px' },
  { key: 'brightness', label: '光带亮度', step: .05, percent: true },
  { key: 'glow', label: '光晕范围', step: .05, percent: true },
  { key: 'flow', label: '光流速度', step: .05, percent: true },
  { key: 'wave', label: '指针牵动', step: .05, percent: true },
  { key: 'exitSeconds', label: '退出时长', step: .1, unit: '秒' },
]
function NumberField({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null), discarded = useRef(false)
  return <input type="number" aria-label={`${label}数值`} min={min} max={max} step={step} value={draft ?? value}
    onFocus={() => setDraft(String(value))} onChange={event => setDraft(event.target.value)}
    onBlur={() => { if (!discarded.current && draft?.trim() && Number.isFinite(Number(draft))) onChange(Number(draft)); discarded.current = false; setDraft(null) }}
    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); discarded.current = true; event.currentTarget.blur() } }} />
}
export function HorizonTuningPanel({ value, onChange, disabled }: { value: HorizonTuning; onChange: (value: HorizonTuning) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false), [transfer, setTransfer] = useState(false), [draft, setDraft] = useState(''), [message, setMessage] = useState('')
  return <aside className="orbit-tuning horizon-tuning" aria-label="外观与调试">
    <button type="button" className="orbit-tuning-toggle" aria-expanded={open} aria-controls="horizon-tuning-controls" disabled={disabled} onClick={() => setOpen(v => !v)}>外观与调试 <span>{open ? '−' : '+'}</span></button>
    {open && <div className="orbit-tuning-controls" id="horizon-tuning-controls" inert={disabled}>
      <header><strong>事件视界</strong><p>实时预览 · 自动记住</p></header>
      <div className="horizon-tuning-fields">{CONTROLS.map(item => {
        const multiplier = item.percent ? 100 : 1, [min, max] = HORIZON_LIMITS[item.key]
        const update = (n: number) => { onChange(normalizeHorizonTuning({ ...value, [item.key]: n })); setMessage('') }
        return <div className="orbit-tuning-control" key={item.key}>
          <label htmlFor={`horizon-${item.key}`}>{item.label}</label>
          <span className="orbit-tuning-value"><NumberField label={item.label} value={Math.round(value[item.key] * multiplier * 100) / 100} min={min * multiplier} max={max * multiplier} step={item.step * multiplier} onChange={n => update(n / multiplier)} /><span>{item.percent ? '%' : item.unit}</span></span>
          <input id={`horizon-${item.key}`} type="range" min={min} max={max} step={item.step} value={value[item.key]} onChange={event => update(Number(event.target.value))} />
        </div>
      })}</div>
      <footer><button type="button" onClick={() => { onChange({ ...DEFAULT_HORIZON_TUNING }); setMessage('已恢复默认外观') }}>恢复默认</button><button type="button" onClick={() => { setTransfer(v => !v); setDraft(JSON.stringify(value, null, 2)); setMessage('') }}>分享 / 导入参数</button></footer>
      {transfer && <div className="orbit-tuning-transfer"><textarea aria-label="地平线参数 JSON" rows={5} spellCheck={false} value={draft} onChange={event => setDraft(event.target.value)} />
        <div><button type="button" onClick={async () => { try { await navigator.clipboard.writeText(JSON.stringify(value, null, 2)); setMessage('参数已复制') } catch { setMessage('可以选中上方参数复制') } }}>复制当前参数</button>
          <button type="button" onClick={() => { try { const parsed = JSON.parse(draft); if (!parsed || Array.isArray(parsed) || !Object.keys(HORIZON_LIMITS).some(key => typeof parsed[key] === 'number')) throw new Error(); onChange(normalizeHorizonTuning(parsed)); setMessage('参数已应用') } catch { setMessage('请粘贴有效的地平线参数 JSON') } }}>应用参数</button></div>
      </div>}
      <p className="orbit-tuning-message" role="status">{message}</p>
    </div>}
  </aside>
}
