import { useState } from 'react'
import type { Preferences } from './preferences'
import { AdaptiveSelect } from '../ui/AdaptiveSelect'
import { mediaPack, useMediaPack } from '../prototype/mediaPack'
import { MEDIA_PACK_ASSETS, MEDIA_PACK_PUBLISHED } from '../prototype/mediaPackCatalog'
import './AppUpdates.css'

type Props = { preferences: Preferences; disabled: boolean; save: (value: Preferences) => Promise<void> }
const size = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MiB`

/** Reuse LocalSettings rows/selectors and the existing AppUpdates progress
 * component styles. No additional modal, page or competing glass material. */
export function BackgroundMediaSettings({ preferences, disabled, save }: Props) {
  const state = useMediaPack(), [removing, setRemoving] = useState(false)
  const video = preferences.render.background === 'video'
  const downloadable = MEDIA_PACK_PUBLISHED || import.meta.env.MODE === 'media-qa'
  const selected4k = preferences.render.mediaResolution === '4k'
  const transferring = ['checking', 'downloading', 'verifying', 'removing'].includes(state.phase) || removing
  const percent = Math.min(100, state.downloadedBytes / state.totalBytes * 100)
  const changeResolution = (mediaResolution: '4k' | '1080p') => save({ ...preferences,
    render: { ...preferences.render, mediaResolution, mediaQuality: 'high' } })
  const remove = async () => {
    setRemoving(true)
    try { await mediaPack.clear() }
    finally { setRemoving(false) }
  }
  return <>
    <div className="xixi-setting-row"><div><strong>{video ? '视频清晰度' : '静态图清晰度'}</strong>
      <small>{video ? '内置1080p高码率 · 20 Mbps · 30 FPS；4K下载后可离线使用。' : '内置4K高质量静态图，按屏幕尺寸显示；无需下载。'}</small></div>
      <div>{video ? <AdaptiveSelect aria-label="视频清晰度" disabled={disabled || removing}
        value={selected4k ? '4k' : '1080p'} onChange={event => void changeResolution(event.target.value as '4k' | '1080p')}>
        <option value="1080p">1080p · 已内置</option>
        <option value="4k" disabled={!downloadable && !state.ready}>{state.ready ? '4K · 已下载' : downloadable ? '4K · 需下载' : '4K · 资源待发布'}</option>
      </AdaptiveSelect> : <span>4K · 已内置</span>}</div>
    </div>
    {video && <div className="xixi-media-pack" data-state={state.phase}>
      <div className="xixi-setting-row"><div><strong>4K 视频资源</strong>
        <small>{state.ready ? `${size(state.totalBytes)} · 45 Mbps · 已保存在本机` : `${size(state.totalBytes)} · 45 Mbps · 含横竖屏、深浅主题与弦轨近景`}</small>
        {selected4k && !state.ready && <small>4K资源尚未就绪，当前播放内置1080p。</small>}
      </div><div className="xixi-settings-actions">
        {state.ready ? <button type="button" disabled={disabled || transferring} onClick={() => void remove()}>移除4K缓存</button>
          : !downloadable ? <span>资源尚未发布</span>
          : state.phase === 'downloading' || state.phase === 'verifying'
            ? <button type="button" onClick={mediaPack.cancel}>取消下载</button>
            : <button type="button" disabled={disabled || transferring} onClick={() => void mediaPack.start()}>
              {state.phase === 'error' ? '重试下载' : state.completedFiles ? '继续下载4K' : '下载4K资源'}</button>}
        {!state.ready && state.completedFiles > 0 && !transferring && <button type="button" disabled={disabled} onClick={() => void remove()}>清理已下载部分</button>}
      </div></div>
      {['downloading', 'verifying'].includes(state.phase) && <div className="xixi-update-progress" aria-live="polite">
        <span>{state.phase === 'verifying' ? '正在校验资源' : '正在下载4K资源'}</span>
        <small>{Math.floor(percent)}% · {state.completedFiles}/{MEDIA_PACK_ASSETS.length}</small>
        <progress className="xixi-update-progress-native" aria-label="4K资源下载进度" value={state.downloadedBytes} max={state.totalBytes} />
        <div className="xixi-update-progress-track" aria-hidden="true"><span style={{ width: `${percent}%` }} /></div>
        <small>{size(state.downloadedBytes)} / {size(state.totalBytes)}</small>
      </div>}
      {state.phase === 'paused' && <p role="status">下载已暂停，已校验的文件会保留；继续时无需重新下载。</p>}
      {state.error && <p role="status">{state.error}</p>}
      {!state.ready && !transferring && state.phase !== 'paused' && <p className="xixi-settings-note">{downloadable ? '仅在你点击下载后联网；下载中仍可使用1080p。离开应用到后台会暂停下载。' : '当前版本已内置1080p高码率视频与4K静态图，可直接离线使用。'}</p>}
    </div>}
  </>
}
