export { setDecisionEffect } from './decisionEffect'
import { useCallback, useEffect, useRef, useState } from 'react'
import { BlackHoleRenderer } from './BlackHoleRenderer'
import { HomeWorkspace } from '../home/HomeWorkspace'
import type { ResponseEffectSettings, ResponsePhase } from './responseEffects'
import type { RenderProfile, RenderScene } from './renderProfile'
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
  const responseSettings = useRef<ResponseEffectSettings | null>(null)
  const responsePhase = useRef<ResponsePhase>('idle')
  const renderProfile = useRef<RenderProfile>('full')
  const renderScene = useRef<RenderScene>('home')
  const changeResponseEffect = useCallback((settings: ResponseEffectSettings) => {
    responseSettings.current = settings
    renderer.current?.setResponseEffect(settings)
  }, [])
  const changeResponsePhase = useCallback((phase: ResponsePhase) => {
    responsePhase.current = phase
    renderer.current?.setResponsePhase(phase)
  }, [])
  const changeRenderProfile = useCallback((profile: RenderProfile, scene: RenderScene) => {
    renderProfile.current = profile
    renderScene.current = scene
    renderer.current?.setRenderProfile(profile, scene)
  }, [])

  useEffect(() => {
    if (!host.current) return
    let engine: BlackHoleRenderer
    try {
      engine = new BlackHoleRenderer(host.current, undefined, setError)
      engine.setNight(1, true)
      renderer.current = engine
      if (responseSettings.current) engine.setResponseEffect(responseSettings.current)
      engine.setResponsePhase(responsePhase.current)
      engine.setRenderProfile(renderProfile.current, renderScene.current)
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
    <HomeWorkspace readCamera={readCamera} onViewChange={changeView} onThemeChange={changeTheme} onResponseEffect={changeResponseEffect} onResponsePhase={changeResponsePhase} onRenderProfile={changeRenderProfile} sceneUnavailable={Boolean(error)} />
    <p className="p0-whisper">把今天交给我</p>
    {error && <div className="p0-error" role="alert">
      <h2>视界暂时不可见</h2><p>{error}</p>
      <button onClick={() => location.reload()}>重新打开</button>
    </div>}
  </main>
}
