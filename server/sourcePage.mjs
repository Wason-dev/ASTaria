import { resolve4 } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { parseDocument } from 'htmlparser2'

const MAX_BYTES = 512 * 1024
const TIMEOUT_MS = 8_000
const MAX_REDIRECTS = 3
const skipped = new Set(['script', 'style', 'noscript', 'svg', 'nav', 'footer', 'header', 'aside', 'form'])

function publicIPv4(address) {
  if (isIP(address) !== 4) return false
  const [a, b, c] = address.split('.').map(Number)
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113))
}

function pageText(html) {
  const document = parseDocument(html)
  const parts = []
  const walk = nodes => {
    for (const node of nodes ?? []) {
      if (node.type === 'text') parts.push(node.data)
      else if (node.children && !skipped.has(node.name)) {
        walk(node.children)
        if (['p', 'div', 'li', 'article', 'section', 'h1', 'h2', 'h3', 'br'].includes(node.name)) parts.push('\n')
      }
    }
  }
  const body = document.children.find(node => node.name === 'html')?.children?.find(node => node.name === 'body')
  walk(body?.children ?? document.children)
  return parts.join(' ').replace(/[\t\r ]+/gu, ' ').replace(/\s*\n\s*/gu, '\n').trim().slice(0, 6000)
}

function safeURL(rawURL) {
  const url = new URL(rawURL)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname
    || isIP(url.hostname) || url.hostname === 'localhost' || url.hostname.endsWith('.localhost')
    || !['', '80', '443'].includes(url.port)) throw new Error('UNSAFE_URL')
  return url
}

async function publicAddress(url, lookup, signal) {
  const addresses = await new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('SOURCE_TIMEOUT'))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve().then(() => lookup(url.hostname)).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
  const address = addresses.find(publicIPv4)
  if (!address) throw new Error('UNSAFE_ADDRESS')
  return address
}

export async function fetchSourcePage(rawURL, { lookup = resolve4, request = null, now = () => new Date(), timeoutMs = TIMEOUT_MS, signal: callerSignal } = {}) {
  const fetchedAt = now().toISOString()
  try {
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
    if (signal.aborted) throw new Error('SOURCE_ABORTED')
    const fetchPage = async (url, redirects) => {
      const address = await publicAddress(url, lookup, signal)
      const client = request ?? (url.protocol === 'https:' ? httpsRequest : httpRequest)
      return new Promise((resolve, reject) => {
        const req = client(url, {
          method: 'GET', signal,
          lookup: (_hostname, options, callback) => options.all
            ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4),
          headers: { Accept: 'text/html, text/plain;q=0.8', 'Accept-Encoding': 'identity', 'User-Agent': 'ASTaria/0.1 source-check' },
        }, response => {
          const status = response.statusCode
          const location = response.headers.location
          if ([301, 302, 303, 307, 308].includes(status)) {
            response.destroy()
            if (redirects >= MAX_REDIRECTS || typeof location !== 'string' || !location.trim()) {
              reject(new Error('REDIRECT_LIMIT'))
              return
            }
            let next
            try { next = safeURL(new URL(location, url).toString()) } catch { reject(new Error('UNSAFE_REDIRECT')); return }
            fetchPage(next, redirects + 1).then(resolve, reject)
            return
          }
          const type = String(response.headers['content-type'] ?? '').toLowerCase()
          if (status !== 200 || !/^(text\/html|text\/plain)(;|$)/u.test(type)
            || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
            response.destroy(); reject(new Error('UNREADABLE_RESPONSE')); return
          }
          const chunks = []
          let bytes = 0
          response.on('data', chunk => {
            bytes += chunk.length
            if (bytes > MAX_BYTES) { response.destroy(); reject(new Error('PAGE_LIMIT')) }
            else chunks.push(chunk)
          })
          response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
          response.on('error', reject)
        })
        req.on('error', reject)
        req.end()
      })
    }
    const html = await fetchPage(safeURL(rawURL), 0)
    const content = pageText(html)
    return { content, fetchedAt, fetchStatus: content ? 'ok' : 'empty' }
  } catch {
    return { content: '', fetchedAt, fetchStatus: 'failed' }
  }
}

export { publicIPv4, pageText }
