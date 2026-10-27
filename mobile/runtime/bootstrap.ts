import { Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'
import { nativeSnapshots } from './nativeSnapshots'
import { nativeSecrets } from './secrets'
import { nativeRequest } from './network'
import { createCapacitorSourceExecutor } from './webFetch'
import type { MobileSourceRequest } from './webFetch'
import { createMobileReminders } from './reminders'
import type { ReminderSnapshot } from './reminders'
import packageInfo from '../../package.json'
import './mobile.css'
import { PAGE_ACTIVITY_EVENT } from '../../src/stores/pageActivity.ts'
import { initializeMobileViewport } from './viewport'
// @ts-expect-error Shared JavaScript transport has independent contract tests.
import { mobileTransport } from './transport.mjs'
// @ts-expect-error Shared route adapter has independent contract tests.
import { mobilePlatformRequests } from './platformApi.mjs'

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void; onEvent?: (value: unknown) => void; cleanup: () => void }
type Reply = { id: string; kind: 'bridge' | 'event' | 'result' | 'error'; operation?: string; input?: unknown; event?: unknown; result?: unknown; error?: string; status?: number }
export async function startMobileRuntime() {
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios') {
    // Native WKWebView ignores this limit for user pinch gestures. It prevents
    // the automatic input-focus zoom while keeping chat text at the chosen size.
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    if (viewport) viewport.content = `${viewport.content}, maximum-scale=1`
  }
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'astaria-local-data' })
  const pending = new Map<string, Pending>(), storage = nativeSnapshots(), secrets = nativeSecrets()
  const sourceRequest = createCapacitorSourceExecutor()
  let failed = false
  const call = (kind: string, path?: string, input?: unknown, options: { onEvent?: (value: unknown) => void; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<unknown> => new Promise((resolve, reject) => {
    if (failed) { reject(new Error('本机数据服务已停止，请重启 ASTaria')); return }
    if (options.signal?.aborted) { reject(options.signal.reason); return }
    const id = crypto.randomUUID()
    const cancel = () => { worker.postMessage({ kind: 'cancel', id }); pending.get(id)?.cleanup(); pending.delete(id); reject(options.signal?.reason ?? new DOMException('已取消', 'AbortError')) }
    options.signal?.addEventListener('abort', cancel, { once: true })
    pending.set(id, { resolve, reject, onEvent: options.onEvent, cleanup: () => options.signal?.removeEventListener('abort', cancel) })
    worker.postMessage({ id, kind, path, input, headers: options.headers, platform: Capacitor.isNativePlatform() ? Capacitor.getPlatform() : 'web-preview' })
  })
  const bridge = async (message: Reply): Promise<unknown> => {
    switch (message.operation) {
      case 'storage.load': return storage.load()
      case 'storage.save': if (typeof message.input !== 'string') throw new Error('本机保存内容不正确'); return storage.save(message.input)
      case 'secrets.status': return secrets.status()
      case 'secrets.read': return secrets.read()
      case 'secrets.write': if (typeof message.input !== 'string') throw new Error('密钥内容不正确'); return secrets.write(message.input)
      case 'secrets.remove': return secrets.remove()
      case 'network.request': return nativeRequest(message.input as Parameters<typeof nativeRequest>[0])
      case 'network.source': return sourceRequest(message.input as MobileSourceRequest, { signal: new AbortController().signal })
      default: throw new Error('找不到这个设备接口')
    }
  }
  worker.onmessage = async (event: MessageEvent<Reply>) => {
    const message = event.data
    if (message.kind === 'bridge') {
      try { const result = await bridge(message); worker.postMessage({ kind: 'bridge-result', id: message.id, result }) }
      catch (reason) { worker.postMessage({ kind: 'bridge-result', id: message.id, error: reason instanceof Error ? reason.message : '设备接口暂不可用' }) }
      return
    }
    const action = pending.get(message.id); if (!action) return
    if (message.kind === 'event') { action.onEvent?.(message.event); return }
    pending.delete(message.id); action.cleanup()
    if (message.kind === 'error') action.reject(Object.assign(new Error(message.error), { status: message.status }))
    else action.resolve(message.result)
  }
  worker.onerror = () => {
    failed = true
    for (const action of pending.values()) { action.cleanup(); action.reject(new Error('本机数据服务已停止，已保存数据保留，请重启 ASTaria')) }
    pending.clear()
  }
  await call('init')
  const reminders = createMobileReminders({
    readSnapshot: async () => await call('call', '/api/platform/reminder-snapshot') as ReminderSnapshot,
    readEnabled: async () => ((await call('call', '/api/platform/reminders-enabled')) as { enabled: boolean }).enabled,
    saveEnabled: async enabled => { await call('call', '/api/platform/reminders-enabled', { enabled }) },
  })
  const fallback = window.fetch.bind(window)
  const request = mobilePlatformRequests({ call: (path: string, input: unknown, options: Parameters<typeof call>[3]) => call('call', path, input, options),
    reminders, updateStatus: () => ({ supported: false, current: { version: packageInfo.version,
      platform: Capacitor.getPlatform(), builtAt: null, commit: null }, automatic: false, status: 'unavailable', error: null,
      latest: null, download: null, canInstall: false, lastCheckedAt: null, nextCheckAt: null,
      unsupportedReason: Capacitor.getPlatform() === 'ios' ? 'iOS 测试更新通过 TestFlight 提供' : '手机端安装包更新需要重新安装并保留本机数据',
      releasesUrl: 'https://github.com/Wason-dev/ASTaria/releases' }),
  })
  window.fetch = mobileTransport({ origin: window.location.origin, fallback, request })
  if (Capacitor.isNativePlatform()) await App.addListener('appStateChange', state => {
    document.documentElement.dataset.mobileActive = String(state.isActive)
    document.dispatchEvent(new Event(PAGE_ACTIVITY_EVENT))
    if (!state.isActive) void call('flush').catch(() => {})
    else void reminders.scheduleRefresh().catch(() => {})
  })
  void reminders.scheduleRefresh().catch(() => {})
  document.documentElement.dataset.mobile = Capacitor.isNativePlatform() ? Capacitor.getPlatform() : 'preview'
  return initializeMobileViewport()
}
