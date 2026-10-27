import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

export type MediaPackAsset = { readonly file: string; readonly bytes: number; readonly sha256: string }
export type MediaPackMetadata = MediaPackAsset
export type MediaPackStore = {
  list(): Promise<MediaPackMetadata[]>
  read(sha256: string): Promise<Blob | undefined>
  put(asset: MediaPackAsset, blob: Blob): Promise<void>
  remove(sha256: string): Promise<void>
  clear(): Promise<void>
}
export type MediaPackState = {
  phase: 'idle' | 'checking' | 'downloading' | 'verifying' | 'ready' | 'paused' | 'removing' | 'error'
  ready: boolean; completedFiles: number; downloadedBytes: number; totalBytes: number; error: string; revision: number
}
type Downloader = (asset: MediaPackAsset, signal: AbortSignal, progress: (bytes: number) => void, verifying: () => void) => Promise<Blob>
const cancelled = (signal: AbortSignal) => { if (signal.aborted) throw signal.reason ?? new DOMException('已取消', 'AbortError') }

/** The caller supplies a pinned URL. Read/hash in a worker; no unverified file
 * reaches persistent storage, even when Content-Length is absent or dishonest. */
export async function downloadVerifiedMedia(asset: MediaPackAsset, url: string, signal: AbortSignal,
  progress: (bytes: number) => void, verifying: () => void, fetcher: typeof fetch = fetch): Promise<Blob> {
  cancelled(signal)
  const response = await fetcher(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store' })
  if (!response.ok || !response.body) throw new Error('4K 资源暂时无法下载，请稍后重试')
  const length = response.headers.get('Content-Length')
  if (length !== null && Number(length) !== asset.bytes) {
    await response.body.cancel(); throw new Error('4K 资源大小不匹配，未保存该文件')
  }
  const reader = response.body.getReader(), hash = sha256.create(), chunks: Uint8Array<ArrayBuffer>[] = []
  let bytes = 0
  try {
    while (true) {
      cancelled(signal)
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > asset.bytes) throw new Error('4K 资源超出预期大小，未保存该文件')
      hash.update(value); chunks.push(new Uint8Array(value)); progress(bytes)
    }
    cancelled(signal); verifying()
    if (bytes !== asset.bytes || bytesToHex(hash.digest()) !== asset.sha256) throw new Error('4K 资源校验未通过，请重新下载')
    return new Blob(chunks, { type: 'video/mp4' })
  } finally {
    await reader.cancel().catch(() => {}); reader.releaseLock(); hash.destroy()
  }
}

/** Cache completion is derived from verified files, never from a saved setting.
 * Completed clips survive interruption; the scene changes only after all eight
 * orientations/themes/views are available. No idle polling or network probes. */
export class MediaPackController {
  private state: MediaPackState
  private listeners = new Set<() => void>()
  private present = new Map<string, MediaPackMetadata>()
  private checked: Promise<void> | undefined
  private active: Promise<void> | undefined
  private controller: AbortController | undefined
  private assets: readonly MediaPackAsset[]
  private store: MediaPackStore
  private download: Downloader
  constructor(assets: readonly MediaPackAsset[], store: MediaPackStore, download: Downloader) {
    this.assets = assets; this.store = store; this.download = download
    this.state = { phase: 'idle', ready: false, completedFiles: 0, downloadedBytes: 0,
      totalBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0), error: '', revision: 0 }
  }
  snapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<MediaPackState>) {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 }
    this.listeners.forEach(listener => listener())
  }
  private savedBytes() { return [...this.present.values()].reduce((sum, asset) => sum + asset.bytes, 0) }
  private savedState() {
    return { ready: this.present.size === this.assets.length, completedFiles: this.present.size, downloadedBytes: this.savedBytes() }
  }
  initialize = () => this.checked ??= (async () => {
    this.publish({ phase: 'checking' })
    try {
      for (const row of await this.store.list()) {
        const asset = this.assets.find(asset => asset.sha256 === row.sha256 && asset.file === row.file && asset.bytes === row.bytes)
        if (asset) this.present.set(asset.sha256, asset)
        else await this.store.remove(row.sha256)
      }
      this.publish({ ...this.savedState(), phase: this.present.size === this.assets.length ? 'ready' : 'idle' })
    } catch { this.publish({ phase: 'error', error: '无法读取4K缓存，当前仍可使用内置1080p' }) }
  })()
  start = () => {
    if (this.active) return this.active
    const controller = new AbortController(); this.controller = controller
    this.active = (async () => {
      await this.initialize()
      try {
        for (const asset of this.assets) {
          cancelled(controller.signal)
          if (this.present.has(asset.sha256)) continue
          const saved = this.savedBytes()
          this.publish({ phase: 'downloading', error: '', downloadedBytes: saved })
          const blob = await this.download(asset, controller.signal,
            bytes => this.publish({ downloadedBytes: saved + bytes }), () => this.publish({ phase: 'verifying' }))
          cancelled(controller.signal)
          await this.store.put(asset, blob)
          this.present.set(asset.sha256, asset)
          this.publish(this.savedState())
        }
        cancelled(controller.signal)
        this.publish({ ...this.savedState(), phase: 'ready', error: '' })
      } catch (error) {
        this.publish({ ...this.savedState(), phase: controller.signal.aborted ? 'paused' : 'error',
          error: controller.signal.aborted ? '' : error instanceof Error ? error.message : '下载未完成，请重试' })
      } finally { this.active = undefined; this.controller = undefined }
    })()
    return this.active
  }
  cancel = () => { this.controller?.abort(new DOMException('已取消', 'AbortError')) }
  clear = async () => {
    this.cancel(); await this.active; await this.initialize()
    this.publish({ phase: 'removing' })
    try { await this.store.clear(); this.present.clear(); this.publish({ ...this.savedState(), phase: 'idle', error: '' }) }
    catch { this.publish({ phase: 'error', error: '4K缓存未能清理，请重试' }) }
  }
  read = async (file: string) => {
    await this.initialize()
    const asset = this.assets.find(asset => asset.file === file)
    if (!this.state.ready || !asset) return undefined
    const blob = await this.store.read(asset.sha256).catch(() => undefined)
    if (blob && blob.size === asset.bytes) return blob
    await this.store.remove(asset.sha256).catch(() => {})
    this.present.delete(asset.sha256)
    this.publish({ ...this.savedState(), phase: 'error', error: '4K缓存缺失，已恢复1080p，可重新下载' })
    return undefined
  }
}
