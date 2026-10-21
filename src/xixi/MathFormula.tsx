import { createContext, memo, useContext, useEffect, useMemo, useState } from 'react'
export const MathTableContext = createContext(false)
type Typesetter = typeof import('./mathTypesetting')['typesetMath']
let ready: Typesetter | undefined
let loading: Promise<Typesetter> | undefined
function loadTypesetter() {
  return loading ??= import('./mathTypesetting').then(module => ready = module.typesetMath).catch(error => { loading = undefined; throw error })
}

/** Ordinary replies never load the math engine. Each changed formula alone is
 * typeset; unchanged formulas in a streamed table keep their memoized markup. */
export const MathFormula = memo(function MathFormula({ source, display = false }: { source: string; display?: boolean }) {
  const inTable = useContext(MathTableContext)
  const [typeset, setTypeset] = useState<Typesetter | undefined>(() => ready)
  useEffect(() => {
    if (typeset) return
    let active = true
    void loadTypesetter().then(renderer => { if (active) setTypeset(() => renderer) }).catch(() => { /* Keep readable source if an offline chunk is missing. */ })
    return () => { active = false }
  }, [typeset])
  const markup = useMemo(() => typeset?.(inTable ? `\\displaystyle ${source}` : source, display) ?? null, [typeset, source, display, inTable])
  const className = `xixi-math${display ? ' xixi-math-display' : ''}`
  return markup
    ? <span className={className} tabIndex={display ? 0 : undefined} role={display ? 'region' : undefined} aria-label={display ? '数学公式' : undefined} dangerouslySetInnerHTML={{ __html: markup }} />
    : <span className={`${className} xixi-math-pending`}>{source}</span>
})
