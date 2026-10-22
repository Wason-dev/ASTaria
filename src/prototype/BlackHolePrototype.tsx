export { setDecisionEffect } from './decisionEffect'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BlackHoleRenderer } from './BlackHoleRenderer'
import { HomeWorkspace } from '../home/HomeWorkspace'
import type { ResponseEffectSettings, ResponsePhase } from './responseEffects'
import type { RenderProfile, RenderScene, RenderQuality } from './renderProfile'
import { usePreferences } from '../xixi/preferences'
import { MediaBackground } from './MediaBackground'
import { MediaSceneCamera } from './backgroundMedia'
import { portraitCameraOffset } from './portraitComposition'
import { pageIsHidden, observePageActivity } from '../stores/pageActivity'
import { observeSceneFrames, publishSceneFrame } from '../stores/sceneFrames'
import { getStringFlight, STRING_FLIGHT_EVENT } from './stringFlight'
import { getDecisionEffect, DECISION_EFFECT_EVENT, DECISION_EXIT_EVENT, DECISION_EXIT_MS } from './decisionEffect'
import './prototype.css'

declare global { interface Window { __ASTARIA_P0__?: BlackHoleRenderer } }

export default function BlackHolePrototype() {
  const host = useRef<HTMLDivElement>(null), media = useRef<HTMLDivElement>(null)
  const renderer = useRef<BlackHoleRenderer | null>(null)
  const mediaCamera = useRef(new MediaSceneCamera())
  const preferences = usePreferences()
  const mode = preferences.value.render.background ?? 'realtime'
  const lastMediaMode = useRef<'image' | 'video'>('image')
  if (mode !== 'realtime') lastMediaMode.current = mode
  const [mediaPresented, setMediaPresented] = useState('')
  const [error, setError] = useState('')
  const [night, setNight] = useState(true), nightTarget = useRef(true)
  const [liveReady, setLiveReady] = useState(false)
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [viewRevision, setViewRevision] = useState(0)
  const cameraView = useRef<'panorama' | 'interstellar'>('panorama')
  const responseSettings = useRef<ResponseEffectSettings | null>(null)
  const [phase, setPhase] = useState<ResponsePhase>('idle'), responsePhase = useRef<ResponsePhase>('idle')
  const renderProfile = useRef<RenderProfile>('full'), renderQuality = useRef<RenderQuality | undefined>(undefined), renderScene = useRef<RenderScene>('home')
  const [interaction, setInteraction] = useState(false)
  useEffect(() => {
    let retreat = false, timer = 0
    const update = () => setInteraction(retreat || getStringFlight() > 0 || getDecisionEffect().active)
    const exit = () => { retreat = true; update(); clearTimeout(timer); timer = window.setTimeout(() => { retreat = false; update() }, DECISION_EXIT_MS) }
    window.addEventListener(STRING_FLIGHT_EVENT, update); window.addEventListener(DECISION_EFFECT_EVENT, update); window.addEventListener(DECISION_EXIT_EVENT, exit)
    update()
    return () => { clearTimeout(timer); window.removeEventListener(STRING_FLIGHT_EVENT, update); window.removeEventListener(DECISION_EFFECT_EVENT, update); window.removeEventListener(DECISION_EXIT_EVENT, exit) }
  }, [])
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)'), update = () => setReduced(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  const changeTheme = useCallback((value: boolean) => {
    nightTarget.current = value; setNight(value); renderer.current?.setNight(Number(value))
    if (document.documentElement.dataset.mobile === 'android') void import('../../mobile/runtime/systemAppearance').then(({ setAndroidAppearance }) => setAndroidAppearance(value)).catch(() => undefined)
  }, [])
  const readCamera = useCallback(() => {
    if (liveReady && renderer.current) return renderer.current.getCameraSnapshot()
    const camera = mediaCamera.current.snapshot(reduced)
    if (document.documentElement.dataset.mobile) camera.centerX += portraitCameraOffset(host.current?.clientWidth ?? innerWidth, host.current?.clientHeight ?? innerHeight, camera.zoom)
    return camera
  }, [liveReady, reduced])
  const changeView = useCallback((view: 'panorama' | 'interstellar') => {
    cameraView.current = view; renderer.current?.setView(view)
    mediaCamera.current.setView(view); setViewRevision(value => value + 1)
  }, [])
  const changeResponseEffect = useCallback((settings: ResponseEffectSettings) => { responseSettings.current = settings; renderer.current?.setResponseEffect(settings) }, [])
  const changeResponsePhase = useCallback((value: ResponsePhase) => { responsePhase.current = value; setPhase(value); renderer.current?.setResponsePhase(value) }, [])
  const changeRenderProfile = useCallback((profile: RenderProfile, scene: RenderScene, quality?: RenderQuality) => {
    renderProfile.current = profile; renderScene.current = scene; renderQuality.current = quality
    renderer.current?.setRenderProfile(profile, scene, quality)
  }, [])
  // No shader/LUT startup for a saved media mode. Live optics are temporary for
  // interactions that actually need them; the setting itself never changes.
  const mediaIdentity = `${mode}:${night}:${preferences.value.render.mediaResolution}:${preferences.value.render.mediaQuality}`
  const liveWanted = preferences.loaded && (mode === 'realtime' || phase !== 'idle' || interaction)
  const [retainLive, setRetainLive] = useState(false)
  useEffect(() => {
    if (liveWanted) { setRetainLive(true); return }
    if (mediaPresented !== mediaIdentity) return
    // Keep the outgoing optical surface alive through its full crossfade.
    const timer = window.setTimeout(() => setRetainLive(false), reduced ? 0 : 320)
    return () => clearTimeout(timer)
  }, [liveWanted, mediaIdentity, mediaPresented, reduced])
  const liveRequired = liveWanted || retainLive
  const liveVisible = liveReady && (liveWanted || mediaPresented !== mediaIdentity)
  useEffect(() => {
    if (!liveRequired || !host.current) return
    let engine: BlackHoleRenderer | undefined, cancelled = false, stop = () => {}
    setLiveReady(false); setError('')
    void (async () => { try {
      const [{ BlackHoleRenderer }, { prepareSceneGeodesics }] = await Promise.all([import('./BlackHoleRenderer'), import('./geodesicLoader')])
      const table = await prepareSceneGeodesics()
      if (cancelled || !host.current) return
      engine = new BlackHoleRenderer(host.current, undefined, message => { if (!cancelled) setError(message) }, table)
      engine.setNight(Number(nightTarget.current), true)
      if (mode !== 'realtime' || cameraView.current !== 'panorama') engine.setCameraPose(mediaCamera.current.snapshot(reduced))
      engine.setView(cameraView.current)
      if (responseSettings.current) engine.setResponseEffect(responseSettings.current)
      engine.setResponsePhase(responsePhase.current)
      engine.setRenderProfile(renderProfile.current, renderScene.current, renderQuality.current)
      renderer.current = engine; window.__ASTARIA_P0__ = engine
      stop = observeSceneFrames(() => { if (engine && engine.getSnapshot().renderedFrames > 0) { setLiveReady(true); stop() } })
    } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : '无法初始化 WebGL') } })()
    return () => { cancelled = true; stop(); engine?.dispose(); renderer.current = null; delete window.__ASTARIA_P0__; setLiveReady(false) }
  }, [liveRequired])
  useEffect(() => {
    let frame = 0, previous = 0
    const update = (now: number) => {
      frame = 0
      if (pageIsHidden()) return
      mediaCamera.current.advance(previous ? Math.min(1, (now - previous) / 1000) : 1 / 60, reduced)
      previous = now
      const camera = mediaCamera.current.snapshot(reduced), element = media.current
      if (element) {
        const width = element.clientWidth, height = element.clientHeight, portrait = width / height < .8
        const offset = document.documentElement.dataset.mobile ? portraitCameraOffset(width, height, camera.zoom) : 0
        const baseOffset = document.documentElement.dataset.mobile ? portraitCameraOffset(width, height, .7) : 0
        const baseX = portrait ? .5 + (.65 + baseOffset - .5) * .34 : .65
        const x = portrait ? .5 + (camera.centerX + offset - .5) * .34 : camera.centerX
        element.style.transformOrigin = `${baseX * 100}% 49%`
        element.style.transform = `translate(${(x - baseX) * width}px,0px) rotate(${18 - camera.roll}deg) scale(${camera.zoom / .7})`
      }
      if (mode !== 'realtime') publishSceneFrame()
      if (camera.cameraTransition) frame = requestAnimationFrame(update)
    }
    const refresh = () => { cancelAnimationFrame(frame); previous = 0; frame = pageIsHidden() ? 0 : requestAnimationFrame(update) }
    const detach = observePageActivity(refresh)
    window.addEventListener('resize', refresh); refresh()
    return () => { cancelAnimationFrame(frame); detach(); window.removeEventListener('resize', refresh) }
  }, [viewRevision, reduced, mode])

  return <main className="p0" data-night={night} data-background={mode}>
    <div className="p0-universe" role="img" aria-label={mode === 'realtime' ? '实时黑洞与吸积盘' : mode === 'video' ? '视频黑洞与吸积盘' : '静态黑洞与吸积盘'}>
      <div className="p0-media" ref={media}>{(mode !== 'realtime' || (!liveReady && mediaPresented)) && <MediaBackground mode={mode === 'realtime' ? lastMediaMode.current : mode} night={night} resolution={preferences.value.render.mediaResolution ?? '1080p'} quality={preferences.value.render.mediaQuality ?? 'high'} suspended={liveVisible} reduced={preferences.value.effect.motion === 'reduced' || (preferences.value.effect.motion === 'system' && reduced)} onReady={() => setMediaPresented(mediaIdentity)} />}</div>
      <div ref={host} className="p0-live" data-ready={liveReady} data-visible={liveVisible} />
    </div>
    <h1 className="p0-sr-only">ASTaria</h1>
    <HomeWorkspace readCamera={readCamera} onViewChange={changeView} onThemeChange={changeTheme} onResponseEffect={changeResponseEffect} onResponsePhase={changeResponsePhase} onRenderProfile={changeRenderProfile} sceneUnavailable={Boolean(error) && mode === 'realtime'} />
    <p className="p0-whisper">让时间有引力</p>
    {error && <div className="p0-error" role="alert"><h2>视界暂时不可见</h2><p>{error}</p><button onClick={() => location.reload()}>重新打开</button></div>}
  </main>
}
