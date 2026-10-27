export { setDecisionEffect } from './decisionEffect'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BlackHoleRenderer } from './BlackHoleRenderer'
import { HomeWorkspace } from '../home/HomeWorkspace'
import type { ResponseEffectSettings, ResponsePhase } from './responseEffects'
import type { RenderProfile, RenderScene, RenderQuality } from './renderProfile'
import { usePreferences } from '../xixi/preferences'
import { MediaBackground } from './MediaBackground'
import { MediaSceneCamera } from './backgroundMedia'
import { MediaSceneRenderer } from './MediaSceneRenderer'
import { portraitCameraOffset } from './portraitComposition'
import { observeSceneFrames } from '../stores/sceneFrames'
import './prototype.css'

declare global { interface Window { __ASTARIA_P0__?: BlackHoleRenderer } }

export default function BlackHolePrototype() {
  const host = useRef<HTMLDivElement>(null), media = useRef<HTMLDivElement>(null)
  const mediaViewport = useRef<HTMLDivElement>(null), closeMedia = useRef<HTMLDivElement>(null), mediaEffects = useRef<HTMLCanvasElement>(null)
  const mediaRenderer = useRef<MediaSceneRenderer | null>(null)
  const [mediaReady, setMediaReady] = useState(false)
  const renderer = useRef<BlackHoleRenderer | null>(null)
  const mediaCamera = useRef(new MediaSceneCamera())
  const preferences = usePreferences()
  const mode = preferences.value.render.background ?? 'realtime'
  const lastMediaMode = useRef<'image' | 'video'>('image')
  if (mode !== 'realtime') lastMediaMode.current = mode
  const [mediaPresented, setMediaPresented] = useState('')
  const [closePresented, setClosePresented] = useState('')
  const [error, setError] = useState('')
  const [night, setNight] = useState(true), nightTarget = useRef(true)
  const [liveReady, setLiveReady] = useState(false)
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const cameraView = useRef<'panorama' | 'interstellar'>('panorama')
  const responseSettings = useRef<ResponseEffectSettings | null>(null)
  const responsePhase = useRef<ResponsePhase>('idle')
  const renderProfile = useRef<RenderProfile>('full'), renderQuality = useRef<RenderQuality | undefined>(undefined), renderScene = useRef<RenderScene>('home')
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)'), update = () => setReduced(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  const changeTheme = useCallback((value: boolean) => {
    nightTarget.current = value; setNight(value); renderer.current?.setNight(Number(value)); mediaRenderer.current?.setNight(Number(value))
    if (['android', 'ios'].includes(document.documentElement.dataset.mobile ?? '')) void import('../../mobile/runtime/systemAppearance').then(({ setNativeAppearance }) => setNativeAppearance(value)).catch(() => undefined)
  }, [])
  const readCamera = useCallback(() => {
    if (mode !== 'realtime' && mediaRenderer.current) return mediaRenderer.current.getCameraSnapshot()
    if (liveReady && renderer.current) return renderer.current.getCameraSnapshot()
    const camera = mediaCamera.current.snapshot(reduced)
    if (document.documentElement.dataset.mobile) camera.centerX += portraitCameraOffset(host.current?.clientWidth ?? innerWidth, host.current?.clientHeight ?? innerHeight, camera.zoom)
    return camera
  }, [liveReady, mediaReady, reduced, mode])
  const changeView = useCallback((view: 'panorama' | 'interstellar') => {
    cameraView.current = view; renderer.current?.setView(view)
    mediaCamera.current.setView(view); mediaRenderer.current?.setView(view)
  }, [])
  const changeResponseEffect = useCallback((settings: ResponseEffectSettings) => { responseSettings.current = settings; renderer.current?.setResponseEffect(settings); mediaRenderer.current?.setResponseEffect(settings) }, [])
  const changeResponsePhase = useCallback((value: ResponsePhase) => { responsePhase.current = value; renderer.current?.setResponsePhase(value); mediaRenderer.current?.setResponsePhase(value) }, [])
  const changeRenderProfile = useCallback((profile: RenderProfile, scene: RenderScene, quality?: RenderQuality) => {
    renderProfile.current = profile; renderScene.current = scene; renderQuality.current = quality
    renderer.current?.setRenderProfile(profile, scene, quality); mediaRenderer.current?.setRenderProfile(profile, scene)
  }, [])
  // Media interactions stay on the decoded video/image. Only an explicit
  // background-mode change may create or dispose the live black-hole renderer.
  const mediaIdentity = `${mode}:${night}:${preferences.value.render.mediaResolution}:${preferences.value.render.mediaQuality}`
  const liveWanted = preferences.loaded && mode === 'realtime'
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
    if (!preferences.loaded || mode === 'realtime' || !mediaViewport.current || !media.current || !closeMedia.current || !mediaEffects.current) return
    const pose = renderer.current?.getCameraSnapshot() ?? mediaCamera.current.snapshot(reduced)
    if (renderer.current && document.documentElement.dataset.mobile) pose.centerX -= portraitCameraOffset(mediaViewport.current.clientWidth, mediaViewport.current.clientHeight, pose.zoom)
    const engine = new MediaSceneRenderer(mediaViewport.current, media.current, closeMedia.current, mediaEffects.current, pose)
    mediaRenderer.current = engine
    engine.setView(cameraView.current); engine.setNight(Number(nightTarget.current))
    if (responseSettings.current) engine.setResponseEffect(responseSettings.current)
    engine.setResponsePhase(responsePhase.current)
    engine.setRenderProfile(renderProfile.current, renderScene.current)
    setMediaReady(true)
    return () => {
      mediaCamera.current.setPose(engine.getCameraSnapshot())
      engine.dispose(); mediaRenderer.current = null; setMediaReady(false)
    }
  }, [preferences.loaded, mode === 'realtime'])

  return <main className="p0" data-night={night} data-background={mode}>
    <div className="p0-universe" role="img" aria-label={mode === 'realtime' ? '实时黑洞与吸积盘' : mode === 'video' ? '视频黑洞与吸积盘' : '静态黑洞与吸积盘'}>
      <div className="p0-media-viewport" ref={mediaViewport}>
        <div className="p0-media" ref={media}>{(mode !== 'realtime' || (!liveReady && mediaPresented)) && <MediaBackground mode={mode === 'realtime' ? lastMediaMode.current : mode} night={night} resolution={preferences.value.render.mediaResolution ?? '1080p'} quality={preferences.value.render.mediaQuality ?? 'high'} suspended={liveVisible} reduced={preferences.value.effect.motion === 'reduced' || (preferences.value.effect.motion === 'system' && reduced)} onReady={() => setMediaPresented(mediaIdentity)} />}</div>
        <div className="p0-media-horizon" data-ready={closePresented === mediaIdentity}><div className="p0-media" ref={closeMedia}>{mode !== 'realtime' && <MediaBackground view="horizon" mode={mode} night={night} resolution={preferences.value.render.mediaResolution ?? '1080p'} quality={preferences.value.render.mediaQuality ?? 'high'} suspended={liveVisible} reduced={preferences.value.effect.motion === 'reduced' || (preferences.value.effect.motion === 'system' && reduced)} onReady={() => setClosePresented(mediaIdentity)} />}</div></div>
        <canvas ref={mediaEffects} className="p0-media-effects" aria-label="思考数字与回应光效" />
      </div>
      <div ref={host} className="p0-live" data-ready={liveReady} data-visible={liveVisible} />
    </div>
    <h1 className="p0-sr-only">ASTaria</h1>
    <HomeWorkspace readCamera={readCamera} onViewChange={changeView} onThemeChange={changeTheme} onResponseEffect={changeResponseEffect} onResponsePhase={changeResponsePhase} onRenderProfile={changeRenderProfile} sceneUnavailable={Boolean(error) && mode === 'realtime'} />
    <p className="p0-whisper">让时间有引力</p>
    {error && <div className="p0-error" role="alert"><h2>视界暂时不可见</h2><p>{error}</p><button onClick={() => location.reload()}>重新打开</button></div>}
  </main>
}
