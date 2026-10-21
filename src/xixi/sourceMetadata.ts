/** Public source records never contain page bodies, snippets or model claims. */
export type SourceMetadata = { url: string; title: string; fetchStatus: 'ok' | 'empty' | 'failed'; fetchedAt: string }

const controls = /[\u0000-\u001f\u007f]/u
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u
const isTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string' || !isoTime.test(value) || !Number.isFinite(Date.parse(value))) return false
  // Date.parse normalizes impossible calendar days and 24:00; source times
  // must denote an actual ISO calendar date and ordinary clock time.
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`).toISOString().slice(0, 10) === value.slice(0, 10)
    && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60
}

export function sourceURL(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 2048 || controls.test(value)) return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : null
  } catch { return null }
}

export function isSourceMetadataList(value: unknown): value is SourceMetadata[] {
  return Array.isArray(value) && value.length <= 6 && value.every(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    return Object.keys(item).length === 4 && Object.keys(item).every(key => ['url', 'title', 'fetchStatus', 'fetchedAt'].includes(key))
      && sourceURL(item.url) !== null
      && typeof item.title === 'string' && Boolean(item.title.trim()) && item.title.length <= 1200 && !controls.test(item.title)
      && ['ok', 'empty', 'failed'].includes(item.fetchStatus)
      && isTimestamp(item.fetchedAt)
  })
}

/** A successful adapter status requires actual usable text before it is public. */
export function sourcesFromPages(value: unknown, fetchedAt: string): SourceMetadata[] {
  if (!Array.isArray(value)) return []
  const sources: SourceMetadata[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const url = sourceURL(item.url)
    if (!url) continue
    const title = typeof item.title === 'string' ? item.title.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 1200) : ''
    const time = isTimestamp(item.fetchedAt) ? item.fetchedAt : fetchedAt
    const fetchStatus = item.fetchStatus === 'ok' ? (typeof item.content === 'string' && item.content.trim() ? 'ok' : 'empty')
      : item.fetchStatus === 'empty' ? 'empty' : 'failed'
    sources.push({ url, title: title || url, fetchStatus, fetchedAt: time })
  }
  return uniqueSourceMetadata(sources)
}

/** Latest attempt wins for a repeated URL; duplicate titles are still valid. */
export function uniqueSourceMetadata(sources: readonly SourceMetadata[]): SourceMetadata[] {
  const byURL = new Map<string, SourceMetadata>()
  for (const { url, title, fetchStatus, fetchedAt } of sources) {
    byURL.set(new URL(url).toString(), { url, title, fetchStatus, fetchedAt })
  }
  return [...byURL.values()].slice(0, 6)
}
