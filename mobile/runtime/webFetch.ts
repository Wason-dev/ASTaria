import { Capacitor, CapacitorHttp } from '@capacitor/core'
import type { parseDocument } from 'htmlparser2'

const API = 'https://api.github.com'
const TIMEOUT_MS = 8_000
const MAX_BYTES = 512 * 1024
const MAX_TEXT = 6_000
const RELEASE_LIMIT = 5
const OWNER = /^[A-Za-z\d](?:[A-Za-z\d-]{0,37}[A-Za-z\d])?$/u
const REPO = /^[A-Za-z\d_.-]{1,100}$/u
const HEADERS = {
  Accept: 'application/vnd.github+json',
  'Accept-Encoding': 'identity',
  'User-Agent': 'ASTaria source-check',
  'X-GitHub-Api-Version': '2022-11-28',
}

export interface PublicSourcePage {
  content: string
  fetchedAt: string
  fetchStatus: 'ok' | 'empty' | 'failed'
}

export interface MobileSourceRequest {
  url: string
  method: 'GET'
  headers: Record<string, string>
  disableRedirects: true
  responseType: 'text'
  connectTimeout: number
  readTimeout: number
}

export interface MobileSourceResponse {
  url: string
  status: number
  headers: Record<string, string>
  // Capacitor decodes application/json even when responseType is text.
  data: unknown
}

// Executors must enforce disableRedirects BEFORE opening any redirected URL,
// preserve normal HTTPS certificate/hostname checks, and use no credentials.
// Checking response.url afterward is only an additional consistency check.
export type MobileSourceExecutor = (
  request: MobileSourceRequest,
  options: { signal: AbortSignal },
) => Promise<MobileSourceResponse>

interface NativeBridge {
  getPlatform(): string
  isNativePlatform(): boolean
  isPluginAvailable(name: string): boolean
}

export interface MobilePageFetcherOptions {
  execute?: MobileSourceExecutor
  now?: () => Date
  timeoutMs?: number
}

interface GitHubTarget {
  owner: string
  repo: string
  kind: 'repo' | 'releases' | 'latest' | 'tag'
  tag?: string
}

function validRepo(owner: string, repo: string) {
  return OWNER.test(owner) && REPO.test(repo) && !['.', '..'].includes(repo)
}

function validTag(tag: string) {
  return /^[A-Za-z\d][A-Za-z\d._+/-]{0,199}$/u.test(tag)
    && !tag.includes('..') && tag.split('/').every(part => part && part !== '.')
}

function gitHubTarget(rawURL: string): GitHubTarget | null {
  // Check the original spelling: URL normalization must not erase credentials,
  // ports, backslashes or traversal before this allowlist is applied.
  if (typeof rawURL !== 'string' || rawURL.length > 2_000 || /[\s\\\u0000-\u001f\u007f]/u.test(rawURL)) return null
  const match = /^https:\/\/github\.com\/([^?#]*)(?:#[^\s]*)?$/i.exec(rawURL)
  if (!match) return null
  const parts = match[1].replace(/\/$/u, '').split('/')
  const [owner, repo] = parts
  if (!owner || !repo || !validRepo(owner, repo)) return null
  if (parts.length === 2) return { owner, repo, kind: 'repo' }
  if (parts[2] !== 'releases') return null
  if (parts.length === 3) return { owner, repo, kind: 'releases' }
  if (parts.length === 4 && parts[3] === 'latest') return { owner, repo, kind: 'latest' }
  if (parts.length === 5 && parts[3] === 'tag') {
    try {
      const tag = decodeURIComponent(parts[4])
      if (validTag(tag)) return { owner, repo, kind: 'tag', tag }
    } catch { /* Malformed tag encoding is unsupported. */ }
  }
  return null
}

function allowedAPIEndpoint(rawURL: string) {
  const prefix = /^https:\/\/api\.github\.com\/repos\/([^/?#]+)\/([^/?#]+)(.*)$/u.exec(rawURL)
  if (!prefix || !validRepo(prefix[1], prefix[2])) return false
  const suffix = prefix[3]
  if (['', '/readme', `/releases?per_page=${RELEASE_LIMIT}`, '/releases/latest'].includes(suffix)) return true
  if (!suffix.startsWith('/releases/tags/')) return false
  const encoded = suffix.slice('/releases/tags/'.length)
  try {
    const tag = decodeURIComponent(encoded)
    return validTag(tag) && encodeURIComponent(tag) === encoded
  } catch { return false }
}

function checkSignal(signal: AbortSignal) {
  if (signal.aborted) throw new Error('SOURCE_ABORTED')
}

function boundedTimeout(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.ceil(value), TIMEOUT_MS) : TIMEOUT_MS
}

/**
 * The installed Capacitor 8.5.3 native implementations both honor
 * disableRedirects: iOS CapacitorUrlRequest rejects URLSession redirects;
 * Android CapacitorHttpUrlConnection disables instanceFollowRedirects.
 * Neither exposes DNS/IP pinning, so this is deliberately a GitHub API reader,
 * not a native proxy for arbitrary public websites. Web fallbacks are disabled.
 */
export function createCapacitorSourceExecutor({
  capacitor = Capacitor,
  http = CapacitorHttp,
}: { capacitor?: NativeBridge; http?: Pick<typeof CapacitorHttp, 'request'> } = {}): MobileSourceExecutor {
  return async (request, { signal }) => {
    checkSignal(signal)
    if (!capacitor.isNativePlatform() || !['ios', 'android'].includes(capacitor.getPlatform())
      || !capacitor.isPluginAvailable('CapacitorHttp') || !allowedAPIEndpoint(request.url)
      || request.method !== 'GET' || request.disableRedirects !== true) throw new Error('UNSUPPORTED_SOURCE_TRANSPORT')
    // Construct the native request ourselves; callers cannot supply credentials,
    // bodies, URL parameters, a redirect policy or additional endpoints.
    return withSignal(() => http.request({
      url: request.url, method: 'GET', headers: { ...HEADERS },
      disableRedirects: true, responseType: 'text',
      connectTimeout: boundedTimeout(request.connectTimeout), readTimeout: boundedTimeout(request.readTimeout),
    }), signal)
  }
}

async function withSignal<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
  checkSignal(signal)
  let onAbort: (() => void) | undefined
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => { checkSignal(signal); return action() }),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('SOURCE_ABORTED'))
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
    checkSignal(signal)
    return result
  } finally { if (onAbort) signal.removeEventListener('abort', onAbort) }
}

function header(response: MobileSourceResponse, name: string) {
  return Object.entries(response.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1] ?? ''
}

function jsonData(response: MobileSourceResponse): unknown {
  const type = header(response, 'content-type').split(';')[0].trim().toLowerCase()
  if (!/^application\/(?:json|[a-z\d.+-]+\+json)$/u.test(type)
    || Number(header(response, 'content-length')) > MAX_BYTES) throw new Error('UNREADABLE_RESPONSE')
  // Native HTTP fully buffers responses before bridging. This bounds parsing
  // and retained source text, not the native layer's download allocation.
  const serialized = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
  if (typeof serialized !== 'string' || serialized.length > MAX_BYTES
    || new TextEncoder().encode(serialized).byteLength > MAX_BYTES) throw new Error('PAGE_LIMIT')
  if (!serialized.trim()) return null
  return JSON.parse(serialized)
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_RESPONSE')
  return value as Record<string, unknown>
}

function text(value: unknown, limit = MAX_TEXT) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim().slice(0, limit) : ''
}

type HTMLNode = ReturnType<typeof parseDocument>['children'][number]
const skipped = new Set(['script', 'style', 'noscript', 'svg', 'nav', 'footer', 'header', 'aside', 'form', 'button', 'dialog'])
const shellText = /^(?:Skip to content|Sign in|Sign out|Sign up|Reload to refresh your session\.?|You signed (?:in|out) in another tab or window\.?|You switched accounts on another tab or window\.?|Dismiss alert|You can[’']t perform that action at this time\.?)$/iu

async function bodyText(raw: string) {
  if (!/<\/?[a-z][^>]*>/iu.test(raw)) return text(raw)
  // Parsing belongs to the database Worker on demand. The native HTTP bridge
  // imports this module too, so a static parser import bloats UI startup.
  const { parseDocument } = await import('htmlparser2')
  const document = parseDocument(raw)
  const find = (nodes: HTMLNode[], predicate: (node: HTMLNode) => boolean): HTMLNode[] => nodes.flatMap(node =>
    predicate(node) ? [node] : 'children' in node ? find(node.children, predicate) : [])
  const body = find(document.children, node => 'attribs' in node && node.name === 'body')[0] ?? document
  const nodes = 'children' in body ? body.children : []
  const mains = find(nodes, node => 'attribs' in node && (node.name === 'main' || node.attribs.role === 'main'))
  const articles = find(mains.length ? mains : nodes, node => 'attribs' in node && node.name === 'article')
  const roots = articles.length ? articles : mains.length ? mains : [body]
  const page = /<(?:html|body|main|article|nav|header|footer)\b/iu.test(raw)
  const parts: string[] = []
  const walk = (children: HTMLNode[], inArticle: boolean) => {
    for (const node of children) {
      if (node.type === 'text') {
        if (inArticle || !shellText.test(node.data.trim())) parts.push(node.data)
      } else if ('attribs' in node && !skipped.has(node.name)) {
        const attrs = node.attribs
        if (attrs.hidden !== undefined || attrs['aria-hidden'] === 'true'
          || ['navigation', 'banner'].includes(attrs.role)
          || /(?:^|\s)(?:js-stale-session-flash|js-flash-container|flash|flash-error|skip-to-content)(?:\s|$)/u.test(`${attrs.class ?? ''} ${attrs.id ?? ''}`)
          || !inArticle && /^\/(?:login|logout|signup)(?:[/?#]|$)/u.test(attrs.href ?? '')) continue
        walk(node.children, inArticle || node.name === 'article')
        if (['p', 'div', 'li', 'article', 'section', 'h1', 'h2', 'h3', 'br', 'pre'].includes(node.name)) parts.push('\n')
      }
    }
  }
  for (const root of roots) if ('children' in root) walk(root.children, !page || 'name' in root && root.name === 'article')
  return text(parts.join(' ').replace(/[\t\r ]+/gu, ' ').replace(/\s*\n\s*/gu, '\n'))
}

async function readmeText(value: unknown) {
  if (value === null) return ''
  const file = object(value)
  if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('UNREADABLE_README')
  const encoded = file.content.replace(/\s/gu, '')
  if (!/^(?:[a-z\d+/]{4})*(?:[a-z\d+/]{2}==|[a-z\d+/]{3}=)?$/iu.test(encoded)) throw new Error('UNREADABLE_README')
  const binary = atob(encoded)
  if (binary.length > MAX_BYTES) throw new Error('PAGE_LIMIT')
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  return bodyText(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

function repoText(repo: Record<string, unknown>, readme: string) {
  const fields = [text(repo.description, 1_200)]
  for (const [key, label] of [['default_branch', '默认分支'], ['language', '语言']] as const) {
    const value = text(repo[key], 200)
    if (value) fields.push(`${label}：${value}`)
  }
  if (repo.license && typeof repo.license === 'object') {
    const value = text((repo.license as Record<string, unknown>).name, 200)
    if (value) fields.push(`许可：${value}`)
  }
  for (const [key, label] of [['stargazers_count', 'Stars'], ['forks_count', 'Forks']] as const) {
    const value = repo[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) fields.push(`${label}：${value}`)
  }
  return [`仓库：${text(repo.full_name, 150)}`, readme, ...fields].filter(Boolean).join('\n\n').slice(0, MAX_TEXT)
}

async function releaseText(value: unknown) {
  const rows = value === null ? [] : Array.isArray(value) ? value : [value]
  const parts: string[] = []
  for (const row of rows.slice(0, RELEASE_LIMIT)) {
    const release = object(row)
    if (release.draft === true) continue
    if (release.draft !== false || !text(release.tag_name, 200)) throw new Error('INVALID_RELEASE')
    const tag = text(release.tag_name, 200), name = text(release.name, 400)
    const section = [name && name !== tag ? `${name} (${tag})` : tag]
    const published = text(release.published_at, 100)
    if (published && Number.isFinite(Date.parse(published))) section.push(`发布时间：${published}`)
    if (release.prerelease === true) section.push('预发布')
    const body = await bodyText(text(release.body, MAX_BYTES))
    if (body) section.push(body)
    parts.push(section.join('\n'))
  }
  return parts.join('\n\n').slice(0, MAX_TEXT)
}

/**
 * Inject this function as webSearchCore.createWebSearch({ pageFetcher }).
 * Supported inputs: https://github.com/<owner>/<repo> and releases[/latest|/tag/<tag>].
 * Query strings, arbitrary pages, raw URLs, non-HTTPS URLs and all redirects
 * fail closed. Only anonymous fixed api.github.com endpoints are requested;
 * returned download_url, asset URLs and pagination links are never followed.
 */
export function createMobilePageFetcher({
  execute = createCapacitorSourceExecutor(), now = () => new Date(), timeoutMs = TIMEOUT_MS,
}: MobilePageFetcherOptions = {}) {
  return async (rawURL: string, { signal: callerSignal }: { signal?: AbortSignal } = {}): Promise<PublicSourcePage> => {
    const fetchedAt = now().toISOString()
    const failed: PublicSourcePage = { content: '', fetchedAt, fetchStatus: 'failed' }
    const target = gitHubTarget(rawURL)
    if (!target || callerSignal?.aborted) return failed
    const controller = new AbortController(), signal = controller.signal
    const onAbort = () => controller.abort()
    callerSignal?.addEventListener('abort', onAbort, { once: true })
    if (callerSignal?.aborted) controller.abort()
    const duration = boundedTimeout(timeoutMs), deadline = Date.now() + duration
    const timer = setTimeout(onAbort, duration)
    const checkActive = () => {
      if (Date.now() >= deadline) controller.abort()
      checkSignal(signal)
    }
    try {
      const requestJSON = async (url: string, allowMissing = false): Promise<unknown> => {
        checkActive()
        if (!allowedAPIEndpoint(url)) throw new Error('UNSAFE_ENDPOINT')
        const remaining = Math.max(1, deadline - Date.now())
        const response = await withSignal(() => execute({
          url, method: 'GET', headers: { ...HEADERS }, disableRedirects: true, responseType: 'text',
          connectTimeout: remaining, readTimeout: remaining,
        }, { signal }), signal)
        checkActive()
        // Redirects are disabled in the executor; reject both redirect responses
        // and unexpected final URLs. Never open a Location ourselves.
        if (response.url !== url || header(response, 'location') || response.status >= 300 && response.status < 400) throw new Error('SOURCE_REDIRECT')
        if (allowMissing && response.status === 404) return null
        if (response.status !== 200) throw new Error('SOURCE_HTTP_ERROR')
        const data = jsonData(response)
        checkActive()
        return data
      }
      const base = `${API}/repos/${target.owner}/${target.repo}`
      const repo = object(await requestJSON(base))
      if (repo.private !== false || repo.visibility !== undefined && repo.visibility !== 'public'
        || text(repo.full_name, 150).toLowerCase() !== `${target.owner}/${target.repo}`.toLowerCase()) throw new Error('NON_PUBLIC_REPO')
      let content: string
      if (target.kind === 'repo') {
        const readme = await readmeText(await requestJSON(`${base}/readme`, true))
        content = repoText(repo, readme)
      } else {
        const suffix = target.kind === 'releases' ? `releases?per_page=${RELEASE_LIMIT}`
          : target.kind === 'latest' ? 'releases/latest' : `releases/tags/${encodeURIComponent(target.tag!)}`
        content = await releaseText(await requestJSON(`${base}/${suffix}`))
      }
      checkActive()
      return { content, fetchedAt, fetchStatus: content ? 'ok' : 'empty' }
    } catch { return failed }
    finally { clearTimeout(timer); callerSignal?.removeEventListener('abort', onAbort) }
  }
}

export const fetchPublicSource = createMobilePageFetcher()
