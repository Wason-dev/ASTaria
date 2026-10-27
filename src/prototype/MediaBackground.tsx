import { useCallback, useEffect, useRef, useState } from 'react'
import { backgroundAsset, MEDIA_LAYOUT_EVENT } from './backgroundMedia'
import type { MediaQuality, MediaResolution, MediaView } from './backgroundMedia'
import { pageIsHidden, observePageActivity } from '../stores/pageActivity'
import { publishSceneFrame } from '../stores/sceneFrames'
import { useOptionalMedia } from './mediaPack'

type Props = { view?: MediaView; mode: 'video' | 'image'; night: boolean; resolution: MediaResolution; quality: MediaQuality; suspended: boolean; reduced: boolean; onReady?: () => void }

/** Keep the previous decoded frame until its replacement is ready. Assets and
 * decoder failures never clear the glass backdrop to black for a frame. */
export function MediaBackground(props: Props) {
  const root = useRef<HTMLDivElement>(null)
  const view = props.view ?? 'panorama'
  const [shape, setShape] = useState<'portrait' | 'landscape'>(() => innerWidth / innerHeight < .8 ? 'portrait' : 'landscape')
  useEffect(() => {
    const element = root.current
    if (!element) return
    const resize = () => setShape(element.clientWidth / element.clientHeight < .8 ? 'portrait' : 'landscape')
    const observer = new ResizeObserver(resize)
    observer.observe(element); resize()
    return () => observer.disconnect()
  }, [])
  const [fallback, setFallback] = useState(false)
  const [failed, setFailed] = useState(false)
  const identity = `${view}:${shape}:${props.night}:${props.resolution}:${props.quality}:${props.mode}`
  useEffect(() => { setFallback(false); setFailed(false) }, [identity])
  const poster = backgroundAsset(shape, props.night, '4k', 'high', 'image', view)
  const wants4k = props.resolution === '4k' && props.mode === 'video' && !props.reduced && !fallback && !failed
  const optionalFile = backgroundAsset(shape, props.night, '4k', 'high', 'video', view).split('/').pop()!.split('?')[0]
  const optionalVideo = useOptionalMedia(wants4k ? optionalFile : undefined)
  const video = props.mode === 'video' && !props.reduced && !failed
    ? optionalVideo ?? backgroundAsset(shape, props.night, '1080p', 'high', 'video', view) : undefined
  const [presented, setPresented] = useState(poster)
  const [decodedPoster, setDecodedPoster] = useState<string | null>(null)
  useEffect(() => {
    if (decodedPoster === poster) props.onReady?.()
    // A mode switch can reuse the same cached image without another load event.
  }, [identity, poster, decodedPoster])
  const failVideo = useCallback(() => {
    if (!fallback && optionalVideo) setFallback(true)
    else setFailed(true)
  }, [fallback, optionalVideo])
  return <div ref={root} className="p0-media-source" data-media-view={view}>
    <img className="p0-media-poster" src={presented} alt="黑洞与吸积盘" />
    <img key={poster} className="p0-media-poster p0-media-next" src={poster} alt="" onLoad={() => { setPresented(poster); setDecodedPoster(poster); publishSceneFrame() }} />
    {video && <VideoLayer key={video} view={view} src={video} poster={poster} suspended={props.suspended} onError={failVideo} />}
    {(failed || fallback) && <span className="p0-media-notice" role="status">{failed ? '视频暂不可播放，已显示静态图' : '此设备无法播放 4K 视频，暂用 1080p'}</span>}
  </div>
}

function VideoLayer({ src, poster, suspended, onError, view }: { view: MediaView; src: string; poster: string; suspended: boolean; onError: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const element = video.current
    if (!element) return
    const viewport = element.closest<HTMLElement>('.p0-media-viewport')
    let disposed = false, callback = 0, active = false
    element.src = src
    const wanted = () => !pageIsHidden() && !suspendedRef.current && (view === 'panorama' ? viewport?.dataset.mediaPlayback !== 'horizon' : viewport?.dataset.mediaPlayback !== 'panorama')
    const play = () => void element.play().catch(error => {
      if (!disposed && wanted() && error?.name !== 'AbortError') onError()
    })
    const frame = () => {
      callback = 0
      if (disposed || element.paused) return
      // The close-up owns notifications when both clips are visible.
      if (view === 'horizon' || viewport?.dataset.mediaPlayback === 'panorama') publishSceneFrame()
      if (element.requestVideoFrameCallback) callback = element.requestVideoFrameCallback(frame)
    }
    const update = () => {
      const next = wanted()
      if (!next) { active = false; element.pause(); return }
      if (element.readyState < 2 || !Number.isFinite(element.duration)) return
      if (!active) {
        const peer = viewport?.querySelector<HTMLVideoElement>(`[data-media-view="${view === 'panorama' ? 'horizon' : 'panorama'}"] video`)
        if (peer && peer.readyState >= 2 && Number.isFinite(element.duration) && element.duration > 0) {
          const position = peer.currentTime % element.duration
          if (Math.abs(element.currentTime - position) > 1 / 30) element.currentTime = position
        }
      }
      active = true; play()
    }
    const playing = () => { if (callback) element.cancelVideoFrameCallback(callback); frame() }
    const loaded = () => { setReady(true); update() }
    element.addEventListener('playing', playing); element.addEventListener('loadeddata', loaded)
    viewport?.addEventListener(MEDIA_LAYOUT_EVENT, update)
    const detach = observePageActivity(update)
    update()
    return () => {
      disposed = true; detach(); element.removeEventListener('playing', playing); element.removeEventListener('loadeddata', loaded)
      viewport?.removeEventListener(MEDIA_LAYOUT_EVENT, update)
      if (callback && element.cancelVideoFrameCallback) element.cancelVideoFrameCallback(callback)
      element.pause(); element.removeAttribute('src'); element.load()
    }
  }, [src, onError, view])
  useEffect(() => {
    video.current?.closest('.p0-media-viewport')?.dispatchEvent(new Event(MEDIA_LAYOUT_EVENT))
  }, [suspended])
  return <video ref={video} className="p0-media-video" data-ready={ready} src={src} poster={poster} muted loop playsInline preload="auto" disablePictureInPicture aria-hidden="true" onLoadedData={() => { setReady(true); publishSceneFrame() }} onError={onError} />
}
