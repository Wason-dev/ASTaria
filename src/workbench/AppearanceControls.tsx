import { useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { ADJUSTMENTS, appearanceSummary, DEFAULT_APPEARANCE } from './appearance'
import type { Appearance } from './appearance'

export function AppearanceControls({ value, onChange, warning, onClose }: {
  value: Appearance; onChange: Dispatch<SetStateAction<Appearance>>; warning: string; onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [copied, setCopied] = useState('')
  const [closing, setClosing] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    const element = dialog.current!
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    element.showModal()
    return () => { clearTimeout(closeTimer.current); element.close(); previous?.focus({ preventScroll: true }) }
  }, [])
  const close = () => {
    if (closing) return
    setClosing(true)
    closeTimer.current = setTimeout(onClose, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 170)
  }
  const update = (key: keyof Appearance, next: number | boolean) => onChange(current => ({ ...current, [key]: next }))
  return <dialog ref={dialog} className="wb-customize" data-closing={closing} aria-labelledby="wb-customize-title" onCancel={event => { event.preventDefault(); close() }} onKeyDown={event => event.stopPropagation()}>
    <header><h2 id="wb-customize-title">调整工作台</h2><button onClick={close} aria-label="关闭自定义">×</button></header>
    <p className="wb-muted">参数实时生效，找到喜欢的再定下来</p>
    <div className="wb-control-row"><span>排列</span><div className="wb-segment">{[1, 2].map(columns => <button key={columns} aria-pressed={value.columns === columns} onClick={() => update('columns', columns)}>{columns === 2 ? '双列' : '单列'}</button>)}</div></div>
    {ADJUSTMENTS.map(([key, label, min, max, step, unit]) => <label className="wb-adjustment" key={key}>
      <span>{label}</span><input type="range" min={min} max={max} step={step} value={value[key]} onChange={event => update(key, Number(event.target.value))} /><output>{value[key]}{unit}</output>
    </label>)}
    {([['progress', '进度'], ['metadata', '时间与分类'], ['completed', '已完成']] as const).map(([key, label]) => <div className="wb-control-row" key={key}><span>{label}</span><button role="switch" aria-checked={value[key]} aria-label={label} className="wb-toggle" onClick={() => update(key, !value[key])}>{value[key] ? key === 'completed' ? '保留' : '显示' : '隐藏'}</button></div>)}
    <textarea className="wb-parameters" aria-label="当前参数" rows={4} readOnly value={appearanceSummary(value)} />
    <footer><button onClick={() => onChange({ ...DEFAULT_APPEARANCE })}>恢复默认</button><button onClick={() => { void navigator.clipboard.writeText(appearanceSummary(value)).then(() => setCopied('已复制'), () => setCopied('请在参数框内全选复制')) }}>复制参数</button></footer>
    <p className="wb-muted" role="status">{warning || copied}</p>
  </dialog>
}
