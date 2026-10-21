import { resolve4 } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { compatibleEndpoint } from '../src/xixi/cloudProviders.ts'

export function publicProviderIPv4(address) {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(address)) return false
  const [a,b,c,d] = address.split('.').map(Number)
  return [a,b,c,d].every(n => n <= 255) && !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113))
}

/** User-configured public HTTPS only; resolve once and pin the actual socket.
 * TLS still verifies the original hostname. No redirects, proxy credentials,
 * loopback, local services or platform metadata endpoints receive API keys. */
export function createCompatibleFetch({ lookup = resolve4, request = httpsRequest } = {}) {
  return async (rawUrl, init = {}) => {
    const url = new URL(rawUrl), suffix = '/chat/completions'
    if (!url.pathname.endsWith(suffix) || init.method !== 'POST') throw Error('不支持这个模型接口')
    compatibleEndpoint(rawUrl.slice(0, -suffix.length))
    if (init.signal?.aborted) throw init.signal.reason
    const addresses = await new Promise((resolve, reject) => {
      const cancel = () => reject(init.signal.reason ?? Error('已取消'))
      init.signal?.addEventListener('abort', cancel, { once: true })
      Promise.resolve().then(() => lookup(url.hostname)).then(resolve, reject).finally(() => init.signal?.removeEventListener('abort', cancel))
    })
    if (!addresses.length || !addresses.every(publicProviderIPv4)) throw Error('API 服务必须解析到公开网络地址')
    if (init.signal?.aborted) throw init.signal.reason
    return new Promise((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: init.headers, signal: init.signal,
        lookup: (_host, options, callback) => options.all ? callback(null, [{ address: addresses[0], family: 4 }]) : callback(null, addresses[0], 4),
      }, response => {
        if (response.statusCode >= 300 && response.statusCode < 400) { response.destroy(); reject(Error('模型服务重定向被拒绝')); return }
        try {
          const headers = new Headers()
          for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : String(value))
          const noBody = [204,205,304].includes(response.statusCode)
          if (noBody) response.resume()
          resolve(new Response(noBody ? null : Readable.toWeb(response), { status: response.statusCode, headers }))
        } catch { response.destroy(); reject(Error('模型服务响应格式不正确')) }
      })
      req.on('error', () => reject(Error('模型服务连接未完成')))
      req.end(init.body)
    })
  }
}
