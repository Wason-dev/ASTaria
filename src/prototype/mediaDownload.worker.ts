import { MEDIA_PACK_ASSETS, MEDIA_PACK_BASE, MEDIA_PACK_PUBLISHED } from './mediaPackCatalog'
import { downloadVerifiedMedia } from './mediaPackCore'

self.onmessage = async (event: MessageEvent<{ file: string }>) => {
  if (!MEDIA_PACK_PUBLISHED && import.meta.env.MODE !== 'media-qa') {
    self.postMessage({ type: 'error', error: '4K视频资源尚未发布，当前可使用内置1080p' }); return
  }
  const asset = MEDIA_PACK_ASSETS.find(asset => asset.file === event.data.file)
  if (!asset) { self.postMessage({ type: 'error', error: '未知的4K资源' }); return }
  // An optional local-only QA build may serve the same pinned bytes on its own
  // origin. Production always uses the immutable resource commit.
  const base = import.meta.env.MODE === 'media-qa' ? '/optional-media/' : MEDIA_PACK_BASE
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 300_000)
    try {
      let last = 0
      const blob = await downloadVerifiedMedia(asset, base + asset.file, controller.signal, bytes => {
        const now = Date.now()
        if (now - last > 100 || bytes === asset.bytes) { last = now; self.postMessage({ type: 'progress', bytes }) }
      }, () => self.postMessage({ type: 'verifying' }))
      self.postMessage({ type: 'complete', blob })
    } finally { clearTimeout(timer) }
  } catch (error) { self.postMessage({ type: 'error', error: error instanceof Error ? error.message : '下载未完成，请重试' }) }
}
