import { useCallback, useEffect, useRef, useState } from 'react'
import { BlackHoleRenderer } from './BlackHoleRenderer'
import type { QualityMode, RenderStats } from './BlackHoleRenderer'
import { TaskWorkspace } from '../spatial/TaskWorkspace'
import './prototype.css'

declare global {
  interface Window { __ASTARIA_P0__?: BlackHoleRenderer }
}

const qualityNames: Record<QualityMode, string> = {
  auto: '自动', ultra: '极致 · 50,000 星', high: '高 · 20,000 星',
  low: '低 · 8,000 星', safe: '最低 · 静态星野',
}

export default function BlackHolePrototype() {
  const host = useRef<HTMLDivElement>(null)
  const renderer = useRef<BlackHoleRenderer | null>(null)
  const [panel, setPanel] = useState(false)
  const [night, setNight] = useState(1)
  const [paused, setPaused] = useState(false)
  const [quality, setQuality] = useState<QualityMode>('auto')
  const [lens, setLens] = useState(true)
  const [doppler, setDoppler] = useState(true)
  const [inclination, setInclination] = useState(83)
  const [zoom, setZoom] = useState(.7)
  const [roll, setRoll] = useState(18)
  const [view, setView] = useState<'panorama'|'interstellar'|null>('panorama')
  const [stats, setStats] = useState<RenderStats | null>(null)
  const [error, setError] = useState('')
  const [capturing, setCapturing] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const readCamera = useCallback(() => renderer.current?.getSnapshot(), [])
  const openWorkspacePanel = useCallback(() => setPanel(false), [])

  useEffect(() => {
    if (!host.current) return
    let engine: BlackHoleRenderer
    try {
      engine = new BlackHoleRenderer(host.current, setStats, setError)
      engine.setNight(1, true)
      renderer.current = engine
      window.__ASTARIA_P0__ = engine
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法初始化 WebGL。')
      return
    }
    return () => {
      engine.dispose()
      renderer.current = null
      delete window.__ASTARIA_P0__
    }
  }, [])

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (event.defaultPrevented || target.closest('[data-spatial-ui]')) return
      if (event.key === 'Escape') { setPanel(false); toggleRef.current?.focus(); return }
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return
      if (event.key.toLowerCase() === 'd' && !event.metaKey && !event.ctrlKey) setPanel(v => !v)
      if (event.key === 'Escape') { setPanel(false); toggleRef.current?.focus() }
      if (event.code === 'Space' && target.tagName !== 'BUTTON') {
        event.preventDefault()
        setPaused(v => { renderer.current?.setPaused(!v); return !v })
      }
    }
    addEventListener('keydown', keyboard)
    return () => removeEventListener('keydown', keyboard)
  }, [])

  useEffect(() => {
    if (panel) panelRef.current?.focus()
  }, [panel])

  const changeNight = (value: number) => { setNight(value); renderer.current?.setNight(value) }
  const changeView = (value:'panorama'|'interstellar') => {
    setView(value)
    setZoom(value === 'panorama' ? .7 : 2.05)
    setRoll(value === 'panorama' ? 18 : 7)
    setInclination(value === 'panorama' ? 83 : 84)
    renderer.current?.setView(value)
  }
  const changePaused = () => { setPaused(v => !v); renderer.current?.setPaused(!paused) }
  const measure = () => {
    const engine = renderer.current
    if (!engine || capturing) return
    const start = performance.now()
    const beginning = engine.getSnapshot().renderedFrames
    const initial = engine.getSnapshot()
    setCapturing(true)
    window.setTimeout(() => {
      if (renderer.current !== engine) return
      const count = engine.getSnapshot().renderedFrames-beginning
      const values = count > 0 ? engine.getFrameSamples().slice(-count) : []
      const sorted = [...values].sort((a,b) => a-b)
      const quantile = (q:number) => sorted[Math.min(sorted.length-1,Math.floor(sorted.length*q))] ?? null
      const data = {
        kind: 'ASTaria P0 requestAnimationFrame sample — not a DevTools trace',
        timestamp: new Date().toISOString(), durationMs: performance.now()-start,
        initial, final: engine.getSnapshot(), samples: values.length,
        meanMs: values.length ? values.reduce((a,b)=>a+b,0)/values.length : null,
        p50Ms: quantile(.5), p95Ms: quantile(.95), p99Ms: quantile(.99),
        over20ms: values.filter(v=>v>20).length, frameIntervalsMs: values,
        userAgent: navigator.userAgent,
      }
      const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}))
      const link = document.createElement('a')
      link.href=url; link.download=`astaria-p0-${Date.now()}.json`; link.click()
      URL.revokeObjectURL(url)
      setCapturing(false)
    }, 10000)
  }

  return <main className="p0" data-night={night > .5 ? 'true' : 'false'}>
    <div ref={host} className="p0-universe" role="img" aria-label="实时渲染的黑洞。光线在视界周围弯曲，形成吸积盘的上下影像。" />
    <h1 className="p0-sr-only">ASTaria · 视界</h1>
    <div className="p0-signature" aria-hidden="true">AST<span>aria</span><i /></div>
    <nav className="p0-views" aria-label="观测镜头"><button aria-pressed={view === 'panorama'} onClick={()=>changeView('panorama')}>全景</button><span/><button aria-pressed={view === 'interstellar'} onClick={()=>changeView('interstellar')}>星际</button></nav>
    <p className="p0-whisper">把今天交给我。</p>
    <TaskWorkspace readCamera={readCamera} cameraRevision={`${view}/${zoom}/${roll}/${inclination}/${paused}`} onOpenPanel={openWorkspacePanel} />
    <div className="p0-actions">
      <button className="p0-day-toggle" onClick={() => changeNight(night > .5 ? 0 : 1)} aria-label={night > .5 ? '进入白昼' : '进入夜晚'} title={night > .5 ? '进入白昼' : '进入夜晚'}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg>
      </button>
      <span className="p0-action-divider" />
      <button ref={toggleRef} className="p0-observe" aria-expanded={panel} aria-controls="p0-observatory" onClick={() => setPanel(v => !v)}>观测 <span>{panel ? '−' : '+'}</span></button>
    </div>
    {panel && <section ref={panelRef} id="p0-observatory" className="p0-observatory" aria-label="黑洞观测台" tabIndex={-1}>
      <header><div><small>OBSERVATORY</small><h2>观测台</h2></div><button onClick={() => {setPanel(false); toggleRef.current?.focus()}} aria-label="关闭观测台">×</button></header>
      <div className="p0-live"><strong>{stats ? (stats.paused || stats.reducedMotion ? '静止' : stats.fps.toFixed(1)) : '—'}</strong><span>{stats?.paused || stats?.reducedMotion ? '按需渲染' : 'FPS · 实时采样'}</span><span className="p0-live-dot" /></div>
      <dl className="p0-metrics"><div><dt>帧间隔 P95</dt><dd>{stats?.p95.toFixed(2) ?? '—'} ms</dd></div><div><dt>渲染分辨率</dt><dd>{stats ? `${stats.width} × ${stats.height}` : '—'}</dd></div><div><dt>当前档位</dt><dd>{stats ? qualityNames[stats.quality].split(' · ')[0] : '—'}</dd></div></dl>
      <label className="p0-slider"><span>纸与星 <output>{Math.round(night*100)}% 夜</output></span><input aria-label="昼夜" type="range" min="0" max="1" step="0.01" value={night} onChange={e => changeNight(Number(e.target.value))}/><small><span>纸白</span><span>星夜</span></small></label>
      <label className="p0-slider"><span>观测倾角 <output>{inclination}°</output></span><input aria-label="观测倾角" type="range" min="58" max="86" step="1" value={inclination} onChange={e=>{const v=Number(e.target.value);setView(null);setInclination(v);renderer.current?.setInclination(v)}}/></label>
      <label className="p0-slider"><span>黑洞远近 <output>{zoom.toFixed(2)}×</output></span><input aria-label="黑洞远近" type="range" min="0.55" max="2.2" step="0.01" value={zoom} onChange={e=>{const v=Number(e.target.value);setView(null);setZoom(v);renderer.current?.setZoom(v)}}/><small><span>远观</span><span>靠近</span></small></label>
      <label className="p0-slider"><span>画面旋转 <output>{roll}°</output></span><input aria-label="画面旋转" type="range" min="-35" max="35" step="1" value={roll} onChange={e=>{const v=Number(e.target.value);setView(null);setRoll(v);renderer.current?.setRoll(v)}}/></label>
      <label className="p0-quality"><span>画质</span><select aria-label="画质" value={quality} onChange={e=>{const v=e.target.value as QualityMode;setQuality(v);renderer.current?.setQuality(v)}}>{Object.entries(qualityNames).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label>
      <div className="p0-switches"><label><input type="checkbox" checked={lens} onChange={e=>{setLens(e.target.checked);renderer.current?.setLens(e.target.checked)}}/>引力透镜</label><label><input type="checkbox" checked={doppler} onChange={e=>{setDoppler(e.target.checked);renderer.current?.setDoppler(e.target.checked)}}/>多普勒增亮</label></div>
      <div className="p0-tools"><button onClick={changePaused}>{paused ? '继续流动' : '暂停流动'}</button><button onClick={()=>renderer.current?.emitParticles()}>投一粒星尘</button></div>
      <button className="p0-record" onClick={measure} disabled={capturing || paused || stats?.reducedMotion}>{capturing ? '正在采样 · 10 秒' : '记录 10 秒帧数据'}<span>↗</span></button>
      <p className="p0-note">{stats?.reducedMotion ? '已遵循系统减少动态效果：保留静态视界，状态即时响应。' : 'D 开合观测台 · 空格暂停 · Esc 返回视界'}</p>
    </section>}
    {error && <div className="p0-error" role="alert"><h2>视界暂时不可见</h2><p>{error}</p><button onClick={()=>location.reload()}>重新打开</button></div>}
  </main>
}
