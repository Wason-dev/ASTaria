import { useId, useState } from 'react'
import { DEFAULT_HORIZON_TUNING, HORIZON_LIMITS, normalizeHorizonTuning, readHorizonTuning, saveHorizonTuning } from './horizonTuning'
import type { HorizonTuning } from './horizonTuning'
import './horizon-settings.css'

const CONTROLS: Array<{ key: keyof HorizonTuning; label: string; step: number; unit?: string; percent?: boolean }> = [
  { key: 'height', label: '地平线位置', step: .01, percent: true },
  { key: 'curvature', label: '地平线弧度', step: .01, percent: true },
  { key: 'brightness', label: '光带亮度', step: .05, percent: true },
  { key: 'wave', label: '指针牵动', step: .05, percent: true },
]

function loadTuning() {
  try { return { value: readHorizonTuning({ strict: true }), error: '' } }
  catch (reason) {
    const detail = reason instanceof Error && reason.message ? `：${reason.message}` : ''
    return { value: { ...DEFAULT_HORIZON_TUNING }, error: `弦轨外观读取失败${detail}` }
  }
}

export function HorizonTuningPanel({ disabled }: { disabled: boolean }) {
  const id = useId()
  const [stored, setStored] = useState(loadTuning)
  const [feedback, setFeedback] = useState({ text: '', error: false })
  const value = stored.value, unavailable = disabled || Boolean(stored.error)
  const update = (next: HorizonTuning) => {
    if (unavailable) return
    const normalized = normalizeHorizonTuning(next)
    if (!saveHorizonTuning(normalized)) {
      setFeedback({ text: '弦轨外观未能保存，请重试', error: true })
      return
    }
    setStored({ value: normalized, error: '' })
    setFeedback({ text: '弦轨外观已保存', error: false })
  }
  return <section className="xixi-horizon-settings" aria-labelledby={`${id}-title`}>
    <div className="xixi-settings-section-title"><h3 id={`${id}-title`}>弦轨</h3><small>修改后自动保存</small></div>
    <fieldset disabled={unavailable} className="xixi-horizon-settings-fields">
      <legend className="xixi-horizon-settings-legend">地平线外观与动态</legend>
      <div className="xixi-horizon-settings-grid">{CONTROLS.map(item => {
        const multiplier = item.percent ? 100 : 1, [min, max] = HORIZON_LIMITS[item.key]
        const change = (n: number) => update({ ...value, [item.key]: n })
        return <div className="xixi-horizon-setting" key={item.key}>
          <label htmlFor={`${id}-${item.key}`}>{item.label}</label>
          <div className="xixi-horizon-setting-control">
            <input id={`${id}-${item.key}`} type="range" min={min} max={max} step={item.step} value={value[item.key]} onChange={event => change(Number(event.target.value))} />
            <output className="xixi-horizon-setting-value" htmlFor={`${id}-${item.key}`}>{Math.round(value[item.key] * multiplier * 100) / 100}{item.percent ? '%' : item.unit}</output>
          </div>
        </div>
      })}</div>
    </fieldset>
    {(stored.error || feedback.text) && <div className="xixi-horizon-settings-feedback" data-error={Boolean(stored.error) || feedback.error} role="status">
      <span>{stored.error || feedback.text}</span>
      {stored.error && <button type="button" disabled={disabled} onClick={() => { setStored(loadTuning()); setFeedback({ text: '', error: false }) }}>重新读取</button>}
    </div>}
  </section>
}
