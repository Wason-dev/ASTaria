import { createWebSearch as createPortableWebSearch } from './webSearchCore.mjs'
import { fetchSourcePage } from './sourcePage.mjs'

export * from './webSearchCore.mjs'

/** Desktop keeps DNS pinning and public-address checks in its page adapter. */
export function createWebSearch(options = {}) {
  return createPortableWebSearch({ pageFetcher: fetchSourcePage, ...options })
}
