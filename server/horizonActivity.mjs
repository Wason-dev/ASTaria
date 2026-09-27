/** Only public, structured review notes enter the activity feed. Provider
 * reasoning and partial JSON never enter the presentation layer. */
export function createHorizonActivityStream({ input, snap, prepared, activity }) {
  let buffer = '', offset = null, stopped = false
  const seen = new Set()
  const publish = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || seen.size >= 6) return
    if (Object.keys(value).some(key => !['index', 'action', 'summary'].includes(key))) return
    const { index, action, summary } = value
    if (!Number.isInteger(index) || index < 0 || index >= prepared.length || seen.has(index)
      || !['keep', 'adjust'].includes(action) || typeof summary !== 'string' || !summary.trim()
      || summary.length > 160 || /[\x00-\x1f\x7f]/u.test(summary)) return
    const plan = prepared[index], item = snap.movable.find(item => item.id === plan.id)
    seen.add(index)
    activity({ id: `model-review:${index}`, source: 'model', state: 'proposed',
      title: `${action === 'keep' ? '建议沿用' : '建议微调'}「${item.title.slice(0, 110)}」`,
      detail: summary.trim(), itemIds: [plan.id], day: snap.dates.indexOf(input.assignedDates[plan.id]) })
  }
  return {
    push(delta) {
      if (stopped || typeof delta !== 'string') return
      if (buffer.length + delta.length > 80_000) { stopped = true; buffer = ''; return }
      buffer += delta
      if (offset === null) {
        const prefix = /^\s*\{\s*"updates"\s*:\s*\[/u.exec(buffer)
        if (!prefix) return
        offset = prefix[0].length
      }
      while (offset < buffer.length && seen.size < 6) {
        while (/[\s,]/u.test(buffer[offset] ?? '') && offset < buffer.length) offset++
        if (buffer[offset] === ']') { stopped = true; return }
        if (buffer[offset] !== '{') return
        let depth = 0, quoted = false, escaped = false, end = -1
        for (let i = offset; i < buffer.length; i++) {
          const ch = buffer[i]
          if (quoted) {
            if (escaped) escaped = false
            else if (ch === '\\') escaped = true
            else if (ch === '"') quoted = false
          } else if (ch === '"') quoted = true
          else if (ch === '{' || ch === '[') depth++
          else if (ch === '}' || ch === ']') { if (--depth === 0) { end = i + 1; break } }
        }
        if (end < 0) return
        try { publish(JSON.parse(buffer.slice(offset, end))) } catch { /* Wait for the complete result to validate scheduling. */ }
        offset = end
      }
    },
    finish(result) {
      try {
        const raw = result?.choices?.[0]?.message?.content
        if (typeof raw !== 'string' || raw.length > 80_000) return
        const value = JSON.parse(raw)
        if (Array.isArray(value.updates)) value.updates.forEach(publish)
      } catch { /* A malformed final plan is rejected by the transaction validator. */ }
    },
  }
}
