import Dexie, { type Table } from 'dexie'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { MEDIA_PACK_ASSETS, MEDIA_PACK_ID } from './mediaPackCatalog'
import { MediaPackController } from './mediaPackCore'
import type { MediaPackAsset, MediaPackMetadata } from './mediaPackCore'
import { observePageActivity, pageIsHidden } from '../stores/pageActivity'

const db = new Dexie('ASTaria-optional-media')
db.version(1).stores({ metadata: 'sha256', files: 'sha256' })
const metadata: Table<MediaPackMetadata, string> = db.table('metadata')
const files: Table<{ sha256: string; blob: Blob }, string> = db.table('files')
function download(asset: MediaPackAsset, signal: AbortSignal, progress: (bytes: number) => void, verifying: () => void) {
  return new Promise<Blob>((resolve, reject) => {
    if (pageIsHidden()) mediaPack.cancel()
    if (signal.aborted) { reject(signal.reason); return }
    const worker = new Worker(new URL('./mediaDownload.worker.ts', import.meta.url), { type: 'module', name: 'astaria-media-download' })
    const finish = () => { worker.terminate(); signal.removeEventListener('abort', abort); detachActivity() }
    const abort = () => { finish(); reject(signal.reason ?? new DOMException('已暂停', 'AbortError')) }
    const detachActivity = observePageActivity(() => { if (pageIsHidden()) mediaPack.cancel() })
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<{ type: string; bytes: number; blob: Blob; error: string }>) => {
      const message = event.data
      if (message.type === 'progress') progress(message.bytes)
      else if (message.type === 'verifying') verifying()
      else if (message.type === 'complete') { finish(); resolve(message.blob) }
      else if (message.type === 'error') { finish(); reject(new Error(message.error)) }
    }
    worker.onerror = () => { finish(); reject(new Error('下载暂时中断，请重试')) }
    worker.postMessage({ file: asset.file })
  })
}
export const mediaPack = new MediaPackController(MEDIA_PACK_ASSETS, {
  list: () => metadata.toArray(),
  read: async sha256 => (await files.get(sha256))?.blob,
  put: (asset, blob) => db.transaction('rw', metadata, files, async () => {
    await files.put({ sha256: asset.sha256, blob }); await metadata.put({ ...asset })
  }),
  remove: sha256 => db.transaction('rw', metadata, files, async () => { await metadata.delete(sha256); await files.delete(sha256) }),
  clear: () => db.transaction('rw', metadata, files, async () => { await metadata.clear(); await files.clear() }),
}, download)

export function useMediaPack() {
  const state = useSyncExternalStore(mediaPack.subscribe, mediaPack.snapshot, mediaPack.snapshot)
  useEffect(() => { void mediaPack.initialize() }, [])
  return state
}

/** The local 1080p decoder remains usable while the optional pack is missing,
 * downloading or has been evicted. Blob URLs exist only for mounted consumers. */
export function useOptionalMedia(file: string | undefined) {
  const state = useMediaPack()
  const key = state.ready && file ? `${MEDIA_PACK_ID}:${file}` : ''
  const [value, setValue] = useState<{ key: string; url: string }>()
  useEffect(() => {
    if (!key || !file) return
    let alive = true, url: string | undefined
    void mediaPack.read(file).then(blob => {
      if (!blob || !alive) return
      url = URL.createObjectURL(blob); setValue({ key, url })
    })
    return () => { alive = false; if (url) URL.revokeObjectURL(url) }
  }, [key, file])
  return value?.key === key && key ? value.url : undefined
}
