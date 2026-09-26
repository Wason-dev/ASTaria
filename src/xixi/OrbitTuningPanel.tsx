import { useRef, useState } from 'react'
import { DEFAULT_ORBIT_TUNING, normalizeOrbitTuning, ORBIT_TUNING_LIMITS, ORBIT_TUNING_PRESETS } from './orbitTuning'
import type { OrbitTuning } from './orbitTuning'
import { ORBIT_LOOKS } from './orbitScene'
import type { OrbitLook } from './orbitScene'

type Props = { value: OrbitTuning; onChange: (value: OrbitTuning) => void; look: OrbitLook; onLook: (look: OrbitLook) => void; disabled: boolean }
type Control = { key: keyof OrbitTuning; label: string; step: number; unit?: string; percent?: boolean }
const GEOMETRY: Control[] = [
  { key: 'arcDegrees', label: '弧度范围', step: 1, unit: '°' },
  { key: 'rotationDegrees', label: '开口朝向', step: 1, unit: '°' },
  { key: 'tiltDegrees', label: '盘面旋角', step: 1, unit: '°' },
  { key: 'flatten', label: '俯视程度', step: .01, percent: true },
  { key: 'scale', label: '整体大小', step: .01, percent: true },
  { key: 'gap', label: '三日轨距', step: .005, percent: true },
  { key: 'centerX', label: '圆心水平', step: .01, percent: true },
  { key: 'centerY', label: '圆心垂直', step: .01, percent: true },
]
const MATERIAL: Control[] = [
  { key: 'diskWidth', label: '盘面连贯度', step: .01, percent: true },
  { key: 'brightness', label: '盘面亮度', step: .05, percent: true },
  { key: 'glow', label: '边缘辉光', step: .05, percent: true },
]
const MOTION: Control[] = [
  { key: 'flow', label: '流转速度', step: .05, percent: true },
  { key: 'wave', label: '指针波动', step: .05, percent: true },
  { key: 'exitSeconds', label: '退出时长', step: .1, unit: ' 秒' },
]

function TuningNumber({ label, value, min, max, step, onCommit }: { label: string; value: number; min: number; max: number; step: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null), discard = useRef(false)
  return <input type="number" aria-label={`${label}数值`} min={min} max={max} step={step} value={draft ?? value}
    onFocus={() => setDraft(String(value))} onChange={event => setDraft(event.target.value)}
    onBlur={() => {
      if (!discard.current && draft !== null && draft.trim() !== '' && Number.isFinite(Number(draft))) onCommit(Number(draft))
      discard.current = false; setDraft(null)
    }} onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); discard.current = true; event.currentTarget.blur() }
    }} />
}

export function OrbitTuningPanel({ value, onChange, look, onLook, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const [transfer, setTransfer] = useState(false), [draft, setDraft] = useState(''), [message, setMessage] = useState('')
  const update = (key: keyof OrbitTuning, next: number) => {
    if (Number.isFinite(next)) onChange(normalizeOrbitTuning({ ...value, [key]: next }))
    setMessage('')
  }
  const controls = (items: Control[]) => items.map(item => {
    const [min, max] = ORBIT_TUNING_LIMITS[item.key], multiplier = item.percent ? 100 : 1
    const display = Math.round(value[item.key] * multiplier * 100) / 100
    return <div className="orbit-tuning-control" key={item.key}>
      <label htmlFor={`orbit-tune-${item.key}`}>{item.label}</label>
      <span className="orbit-tuning-value"><TuningNumber label={item.label} min={min * multiplier} max={max * multiplier} step={item.step * multiplier}
        value={display} onCommit={next => update(item.key, next / multiplier)} /><span>{item.percent ? '%' : item.unit}</span></span>
      <input id={`orbit-tune-${item.key}`} type="range" min={min} max={max} step={item.step} value={value[item.key]} onChange={event => update(item.key, Number(event.target.value))} />
    </div>
  })
  return <aside className="orbit-tuning" data-open={open} aria-label="外观">
    <button type="button" className="orbit-tuning-toggle" aria-expanded={open} aria-controls="orbit-tuning-controls" disabled={disabled} onClick={() => setOpen(v => !v)}>
      <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" /><path d="M7 3v4m7 1v4m-9 1v4" stroke="currentColor" strokeWidth="2" /></svg>
      外观 <span>{open ? '−' : '+'}</span>
    </button>
    {open && <div className="orbit-tuning-controls" id="orbit-tuning-controls" inert={disabled}>
      <header><strong>外观</strong><p>自动记住</p></header>
      <div className="orbit-look-options" role="group" aria-label="选择轨道风格">{ORBIT_LOOKS.map(option => <button type="button" key={option.id} aria-pressed={look === option.id} onClick={() => onLook(option.id)}>{option.name}</button>)}</div>
      <div className="orbit-tuning-presets" aria-label="盘面预设">{ORBIT_TUNING_PRESETS.map(preset => <button type="button" key={preset.id} onClick={() => { onChange({ ...preset.value }); onLook(preset.id === 'home' ? 'accretion' : 'minimal'); setMessage('') }}>{preset.name}</button>)}</div>
      <details open><summary>几何与弧度</summary><div>{controls(GEOMETRY)}</div></details>
      <details><summary>光与盘面</summary><div>{controls(look === 'minimal' ? MATERIAL.filter(item => item.key === 'brightness') : MATERIAL)}</div></details>
      <details><summary>流动与过渡</summary><div>{controls(MOTION)}</div></details>
      <footer><button type="button" onClick={() => { onChange({ ...DEFAULT_ORBIT_TUNING }); onLook('minimal'); setMessage('已恢复极简弧线') }}>恢复默认</button><button type="button" onClick={() => { setTransfer(v => !v); setDraft(JSON.stringify(value, null, 2)); setMessage('') }}>分享 / 导入参数</button></footer>
      {transfer && <div className="orbit-tuning-transfer"><textarea aria-label="盘面参数 JSON" value={draft} onChange={event => setDraft(event.target.value)} rows={5} spellCheck={false} />
        <div><button type="button" onClick={async () => { try { await navigator.clipboard.writeText(JSON.stringify(value, null, 2)); setMessage('当前参数已复制') } catch { setMessage('可在上方选中并复制参数') } }}>复制当前参数</button>
          <button type="button" onClick={() => { try {
            const parsed: unknown = JSON.parse(draft)
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.keys(ORBIT_TUNING_LIMITS).some(key => typeof (parsed as Record<string, unknown>)[key] === 'number')) throw new Error()
            onChange(normalizeOrbitTuning(parsed)); setMessage('参数已应用')
          } catch { setMessage('参数格式不正确，请粘贴导出的 JSON') } }}>应用参数</button></div></div>}
      <p className="orbit-tuning-message" role="status">{message}</p>
    </div>}
  </aside>
}
