import { useCallback, useEffect, useRef, useState } from 'react'
import { backgroundAsset } from './backgroundMedia'
import type { MediaQuality, MediaResolution } from './backgroundMedia'
import { pageIsHidden, observePageActivity } from '../stores/pageActivity'
import { publishSceneFrame } from '../stores/sceneFrames'

type Props = { mode: 'video' | 'image'; night: boolean; resolution: MediaResolution; quality: MediaQuality; suspended: boolean; reduced: boolean; onReady?: () => void }

/** Keep the previous decoded frame until its replacement is ready. Assets and
 * decoder failures never clear the glass backdrop to black for a frame. */
export function MediaBackground(props: Props) {
  const root = useRef<HTMLDivElement>(null)
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
  const identity = `${shape}:${props.night}:${props.resolution}:${props.quality}:${props.mode}`
  useEffect(() => { setFallback(false); setFailed(false) }, [identity])
  const resolution = fallback ? '1080p' : props.resolution
  const poster = backgroundAsset(shape, props.night, resolution, props.quality, 'image')
  const video = props.mode === 'video' && !props.reduced && !failed ? backgroundAsset(shape, props.night, resolution, props.quality, 'video') : undefined
  const [presented, setPresented] = useState(poster)
  const [decodedPoster, setDecodedPoster] = useState<string | null>(null)
  useEffect(() => {
    if (decodedPoster === poster) props.onReady?.()
    // A mode switch can reuse the same cached image without another load event.
  }, [identity, poster, decodedPoster])
  const failVideo = useCallback(() => {
    if (!fallback && props.resolution === '4k') setFallback(true)
    else setFailed(true)
  }, [fallback, props.resolution])
  return <div ref={root} className="p0-media-source">
    <img className="p0-media-poster" src={presented} alt="黑洞与吸积盘" />
    <img key={poster} className="p0-media-poster p0-media-next" src={poster} alt="" onLoad={() => { setPresented(poster); setDecodedPoster(poster); publishSceneFrame() }} />
    {video && <VideoLayer key={video} src={video} poster={poster} suspended={props.suspended} onError={failVideo} />}
    {(failed || fallback) && <span className="p0-media-notice" role="status">{failed ? '视频暂不可播放，已显示静态图' : '此设备无法播放 4K 视频，暂用 1080p'}</span>}
  </div>
}

function VideoLayer({ src, poster, suspended, onError }: { src: string; poster: string; suspended: boolean; onError: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const element = video.current
    if (!element) return
    let disposed = false, callback = 0
    element.src = src
    const play = () => void element.play().catch(error => {
      if (!disposed && !pageIsHidden() && !suspendedRef.current && error?.name !== 'AbortError') onError()
    })
    const frame = () => {
      callback = 0
      if (disposed || element.paused) return
      publishSceneFrame()
      if (element.requestVideoFrameCallback) callback = element.requestVideoFrameCallback(frame)
    }
    const update = () => {
      if (pageIsHidden() || suspendedRef.current) element.pause()
      else play()
    }
    const playing = () => { if (callback) element.cancelVideoFrameCallback(callback); frame() }
    element.addEventListener('playing', playing)
    const detach = observePageActivity(update)
    update()
    return () => {
      disposed = true; detach(); element.removeEventListener('playing', playing)
      if (callback && element.cancelVideoFrameCallback) element.cancelVideoFrameCallback(callback)
      element.pause(); element.removeAttribute('src'); element.load()
    }
  }, [src, onError])
  useEffect(() => {
    const element = video.current
    if (suspended) element?.pause()
    else if (!pageIsHidden()) void element?.play().catch(error => { if (error?.name !== 'AbortError' && !pageIsHidden() && !suspendedRef.current) onError() })
  }, [suspended, onError])
  return <video ref={video} className="p0-media-video" data-ready={ready} src={src} poster={poster} muted loop playsInline preload="auto" disablePictureInPicture aria-hidden="true" onLoadedData={() => { setReady(true); publishSceneFrame() }} onError={onError} />
}
