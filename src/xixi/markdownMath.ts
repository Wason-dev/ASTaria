/** Normalize common LaTeX delimiters for remark-math, leaving code verbatim.
 * Only complete delimiters convert; a partial streamed formula remains text. */
export function normalizeMathDelimiters(source: string): string {
  let out = '', index = 0, fence = ''
  while (index < source.length) {
    if (index === 0 || source[index - 1] === '\n') {
      const end = source.indexOf('\n', index)
      const line = source.slice(index, end < 0 ? source.length : end)
      const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (mark && (!fence || (mark[1][0] === fence[0] && mark[1].length >= fence.length && !mark[2].trim()))) {
        fence = fence ? '' : mark[1]
        out += line; index += line.length
        if (source[index] === '\n') { out += '\n'; index++ }
        continue
      }
      if (fence || /^(?: {4}|\t)/.test(line)) {
        out += line; index += line.length
        if (source[index] === '\n') { out += '\n'; index++ }
        continue
      }
    }
    if (source[index] === '`') {
      const run = /^`+/.exec(source.slice(index))![0]
      let end = source.indexOf(run, index + run.length)
      while (end >= 0 && (source[end - 1] === '`' || source[end + run.length] === '`')) end = source.indexOf(run, end + run.length)
      const next = end < 0 ? index + run.length : end + run.length
      out += source.slice(index, next); index = next; continue
    }
    if (source[index] === '\\' && source[index + 1] === '\\') {
      out += '\\\\'; index += 2; continue
    }
    if (source[index] === '\\' && ['(', '['].includes(source[index + 1])) {
      const display = source[index + 1] === '['
      const end = source.indexOf(display ? '\\]' : '\\)', index + 2)
      const formula = end < 0 ? '' : source.slice(index + 2, end)
      if (formula.trim() && (display || !formula.includes('\n')) && !formula.includes('$')) {
        out += display ? `\n$$\n${formula.trim()}\n$$\n` : `$${formula.trim()}$`
        index = end + 2; continue
      }
    }
    out += source[index++]
  }
  return out
}

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[]; position?: { end: { offset?: number } }; data?: unknown }

/** A pair of currency amounts ($5 ... $10) is ordinary prose, not math. */
export function remarkReadableMath() {
  return (tree: MarkdownNode, file: { value: unknown }) => {
    const source = String(file.value)
    const visit = (node: MarkdownNode) => {
      if (node.type === 'inlineMath' && /^\d/.test(node.value ?? '') && /\s|[，。]/u.test(node.value ?? '')
        && /^\d/.test(source.slice(node.position?.end.offset ?? source.length))) {
        node.type = 'text'; node.value = `$${node.value}$`; delete node.data
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}
