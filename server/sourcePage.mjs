import { resolve4 } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { parseDocument } from 'htmlparser2'
import { abortSignalTimeout, abortSignalAny } from './abortSignal.mjs'

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

function pageText(html, rawURL) {
  const document = parseDocument(html)
  let github = false
  try { github = new URL(rawURL).hostname === 'github.com' } catch { /* Generic HTML. */ }
  const find = (nodes, predicate) => (nodes ?? []).flatMap(node => predicate(node) ? [node] : find(node.children, predicate))
  const body = find(document.children, node => node.name === 'body')[0] ?? document
  const main = find(body.children, node => node.name === 'main' || node.attribs?.role === 'main')
  const articles = find(body.children, node => node.name === 'article')
  let roots = main.length ? main : articles.length ? articles : [body]
  const extracted = new Set()
  if (github && main.length) {
    // Repository identity can sit beside main on GitHub, while README and
    // actual file/release/language information remain inside it.
    const headers = find(body.children, node => node.attribs?.id === 'repository-container-header')
    const readmes = main.flatMap(root => find(root.children, node => node.name === 'article'))
    for (const readme of readmes) extracted.add(readme)
    roots = [...headers.filter(node => !main.some(root => {
      for (let parent = node.parent; parent; parent = parent.parent) if (parent === root) return true
      return false
    })), ...readmes, ...roots]
  }
  const parts = []
  const shellText = /^(?:Skip to content|Sign in|Sign out|Sign up|Reload to refresh your session\.?|You signed (?:in|out) in another tab or window\.?|You switched accounts on another tab or window\.?|Dismiss alert|You can[’']t perform that action at this time\.?)$/iu
  const walk = (nodes, inArticle = false) => {
    for (const node of nodes ?? []) {
      if (extracted.has(node)) continue
      if (node.type === 'text') {
        if (!github || inArticle || !shellText.test(node.data.trim())) parts.push(node.data)
      } else if (node.children && !skipped.has(node.name)) {
        const attrs = node.attribs ?? {}
        if (attrs.hidden !== undefined || attrs['aria-hidden'] === 'true') continue
        if (github && !inArticle && (['button', 'dialog'].includes(node.name)
          || ['navigation', 'banner'].includes(attrs.role)
          || /(?:^|\s)(?:js-stale-session-flash|js-flash-container|flash|flash-error|skip-to-content)(?:\s|$)/u.test(`${attrs.class ?? ''} ${attrs.id ?? ''}`)
          || /^\/(?:login|logout|signup)(?:[/?#]|$)/u.test(attrs.href ?? ''))) continue
        walk(node.children, inArticle || node.name === 'article')
        if (['p', 'div', 'li', 'article', 'section', 'h1', 'h2', 'h3', 'br'].includes(node.name)) parts.push('\n')
      }
    }
  }
  for (const root of roots) walk(root.children, root.name === 'article')
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
  if (signal.aborted) throw new Error('SOURCE_ABORTED')
  const addresses = await new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('SOURCE_ABORTED'))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve().then(() => {
      if (signal.aborted) throw new Error('SOURCE_ABORTED')
      return lookup(url.hostname)
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
  const address = addresses.find(publicIPv4)
  if (!address) throw new Error('UNSAFE_ADDRESS')
  return address
}

export async function fetchSourcePage(rawURL, { lookup = resolve4, request = null, now = () => new Date(), timeoutMs = TIMEOUT_MS, signal: callerSignal } = {}) {
  const fetchedAt = now().toISOString()
  try {
    const signal = callerSignal ? abortSignalAny([callerSignal, abortSignalTimeout(timeoutMs)]) : abortSignalTimeout(timeoutMs)
    if (signal.aborted) throw new Error('SOURCE_ABORTED')
    const fetchPage = async (url, redirects) => {
      const address = await publicAddress(url, lookup, signal)
      if (signal.aborted) throw new Error('SOURCE_ABORTED')
      const client = request ?? (url.protocol === 'https:' ? httpsRequest : httpRequest)
      return new Promise((resolve, reject) => {
        let responseStream
        const onAbort = () => { responseStream?.destroy(); reject(new Error('SOURCE_ABORTED')) }
        signal.addEventListener('abort', onAbort, { once: true })
        const done = (error, result) => {
          signal.removeEventListener('abort', onAbort)
          if (error) reject(error)
          else resolve(result)
        }
        const req = client(url, {
          method: 'GET', signal,
          lookup: (_hostname, options, callback) => options.all
            ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4),
          headers: { Accept: 'text/html, text/plain;q=0.8', 'Accept-Encoding': 'identity', 'User-Agent': 'ASTaria/0.1 source-check' },
        }, response => {
          responseStream = response
          if (signal.aborted) { response.destroy(); done(new Error('SOURCE_ABORTED')); return }
          const status = response.statusCode
          const location = response.headers.location
          if ([301, 302, 303, 307, 308].includes(status)) {
            response.destroy()
            if (redirects >= MAX_REDIRECTS || typeof location !== 'string' || !location.trim()) {
              done(new Error('REDIRECT_LIMIT'))
              return
            }
            let next
            try { next = safeURL(new URL(location, url).toString()) } catch { done(new Error('UNSAFE_REDIRECT')); return }
            fetchPage(next, redirects + 1).then(result => done(null, result), done)
            return
          }
          const type = String(response.headers['content-type'] ?? '').toLowerCase()
          if (status !== 200 || !/^(text\/html|text\/plain)(;|$)/u.test(type)
            || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
            response.destroy(); done(new Error('UNREADABLE_RESPONSE')); return
          }
          const chunks = []
          let bytes = 0
          response.on('data', chunk => {
            bytes += chunk.length
            if (bytes > MAX_BYTES) { response.destroy(); done(new Error('PAGE_LIMIT')) }
            else chunks.push(chunk)
          })
          response.on('end', () => done(null, { html: Buffer.concat(chunks).toString('utf8'), url: url.toString() }))
          response.on('error', done)
          response.on('aborted', () => done(new Error('SOURCE_ABORTED')))
        })
        req.on('error', done)
        req.end()
      })
    }
    const { html, url } = await fetchPage(safeURL(rawURL), 0)
    if (signal.aborted) throw new Error('SOURCE_ABORTED')
    const content = pageText(html, url)
    return { content, fetchedAt, fetchStatus: content ? 'ok' : 'empty' }
  } catch {
    return { content: '', fetchedAt, fetchStatus: 'failed' }
  }
}

export { publicIPv4, pageText }
