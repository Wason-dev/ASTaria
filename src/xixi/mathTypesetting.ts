import katex from 'katex'

/** Only KaTeX-generated markup enters the DOM. No trusted URLs, raw HTML,
 * persistent macros, remote fonts or model-defined CSS are enabled. */
export function typesetMath(source: string, displayMode: boolean): string | null {
  if (!source.trim() || source.length > 8000) return null
  try {
    return katex.renderToString(source, {
      displayMode, output: 'htmlAndMathml', throwOnError: true,
      trust: false, strict: 'ignore', maxExpand: 200, maxSize: 12,
      macros: {}, globalGroup: false,
    })
  } catch { return null }
}
