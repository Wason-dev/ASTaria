import { useCallback, useEffect, useRef, useState } from 'react'
import { BlackHoleRenderer } from './BlackHoleRenderer'
import { HomeWorkspace } from '../home/HomeWorkspace'
import './prototype.css'

declare global {
  interface Window { __ASTARIA_P0__?: BlackHoleRenderer }
}

export default function BlackHolePrototype() {
  const host = useRef<HTMLDivElement>(null)
  const renderer = useRef<BlackHoleRenderer | null>(null)
  const [error, setError] = useState('')
  const [night, setNight] = useState(true)
  const changeTheme = useCallback((value: boolean) => {
    setNight(value)
    renderer.current?.setNight(Number(value))
  }, [])
  const readCamera = useCallback(() => renderer.current?.getSnapshot(), [])
  const changeView = useCallback((view: 'panorama' | 'interstellar') => {
    renderer.current?.setView(view)
  }, [])

  useEffect(() => {
    if (!host.current) return
    let engine: BlackHoleRenderer
    try {
      engine = new BlackHoleRenderer(host.current, () => undefined, setError)
      engine.setNight(1, true)
      renderer.current = engine
      window.__ASTARIA_P0__ = engine
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法初始化 WebGL')
      return
    }
    return () => {
      engine.dispose()
      renderer.current = null
      delete window.__ASTARIA_P0__
    }
  }, [])

  return <main className="p0" data-night={night}>
    <div ref={host} className="p0-universe" role="img" aria-label="实时黑洞与吸积盘" />
    <h1 className="p0-sr-only">ASTaria</h1>
    <HomeWorkspace readCamera={readCamera} onViewChange={changeView} onThemeChange={changeTheme} sceneUnavailable={Boolean(error)} />
    <p className="p0-whisper">把今天交给我</p>
    {error && <div className="p0-error" role="alert">
      <h2>视界暂时不可见</h2><p>{error}</p>
      <button onClick={() => location.reload()}>重新打开</button>
    </div>}
  </main>
}
