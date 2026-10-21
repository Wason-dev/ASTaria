/// <reference lib="webworker" />
import initSQLJs from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import persona from '../../server/prompts/persona.md?raw'
import working from '../../server/prompts/working.md?raw'
import { createMobilePageFetcher } from './webFetch'
import type { MobileSourceResponse } from './webFetch'
// @ts-expect-error Portable services are JavaScript shared with Node.
import { createMobileSession } from './session.mjs'
// @ts-expect-error Browser storage shares its checks with runtime tests.
import { indexedSnapshots } from './snapshots.mjs'
// @ts-expect-error Snapshot codecs share their checks with bridge contract tests.
import { decodeSnapshot, encodeSnapshot } from './snapshotCodec.mjs'

type Request = { id: string; kind: string; path?: string; input?: unknown; headers?: Record<string, string>; platform?: string; result?: unknown; error?: string }
const bridges = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; cleanup: () => void }>()
const bridge = (operation: string, input?: unknown, signal?: AbortSignal): Promise<unknown> => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason ?? new DOMException('已取消', 'AbortError')); return }
  const id = crypto.randomUUID()
  const cancel = () => { bridges.delete(id); reject(signal?.reason ?? new DOMException('已取消', 'AbortError')) }
  signal?.addEventListener('abort', cancel, { once: true })
  bridges.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener('abort', cancel) })
  self.postMessage({ kind: 'bridge', id, operation, input })
})
let session: Awaited<ReturnType<typeof createMobileSession>>
let starting: Promise<void> | undefined
const controllers = new Map<string, AbortController>()
self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data
  if (request.kind === 'cancel') { controllers.get(request.id)?.abort(); return }
  if (request.kind === 'bridge-result') {
    const pending = bridges.get(request.id); if (!pending) return
    bridges.delete(request.id); pending.cleanup(); request.error ? pending.reject(new Error(request.error)) : pending.resolve(request.result); return
  }
  try {
    if (request.kind === 'init') {
      starting ??= (async () => {
        const SQL = await initSQLJs({ locateFile: () => wasmUrl })
        const storage = request.platform === 'web-preview' ? indexedSnapshots() : {
          load: async () => {
            const base64 = await bridge('storage.load')
            return base64 === undefined ? undefined : decodeSnapshot(base64)
          },
          save: (bytes: Uint8Array) => bridge('storage.save', encodeSnapshot(bytes)),
        }
        const vault = {
          status: () => bridge('secrets.status'), read: () => bridge('secrets.read'),
          save: (key: string) => bridge('secrets.write', key), remove: () => bridge('secrets.remove'),
        }
        const fetcher = async (url: string, options: RequestInit = {}) => {
          const response = await bridge('network.request', { url, method: options.method ?? 'GET', headers: options.headers, body: options.body }, options.signal ?? undefined) as { status: number; headers: Record<string, string>; body: string }
          return new Response(response.body, { status: response.status, headers: response.headers })
        }
        const pageFetcher = createMobilePageFetcher({ execute: async (input, options) =>
          await bridge('network.source', input, options.signal) as MobileSourceResponse })
        session = await createMobileSession({ SQL, storage, serviceOptions: { vault, fetcher, pageFetcher, platform: request.platform, persona, working } })
      })()
      await starting; self.postMessage({ kind: 'result', id: request.id, result: { ready: true } }); return
    }
    await starting
    if (!session) throw new Error('本机数据尚未就绪')
    const controller = new AbortController(); controllers.set(request.id, controller)
    const result = request.kind === 'flush' ? await session.flush() : await session.call(request.path, request.input, {
      headers: request.headers, signal: controller.signal, startStream: () => (value: unknown) => self.postMessage({ kind: 'event', id: request.id, event: value }),
    })
    self.postMessage({ kind: 'result', id: request.id, result })
  } catch (error) {
    const issue = error as { message?: string; status?: number }
    self.postMessage({ kind: 'error', id: request.id, error: issue.message ?? '本机操作暂未完成', status: issue.status ?? 503 })
  } finally { controllers.delete(request.id) }
}
