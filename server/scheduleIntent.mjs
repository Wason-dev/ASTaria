import { localDay } from '../src/home/agenda.ts'

const rangePattern = /(?<!\d)([01]?\d|2[0-3])\s*[:：]?\s*([0-5]\d)\s*[-–—至到]\s*([01]?\d|2[0-3])\s*[:：]?\s*([0-5]\d)(?!\d)/gu
const normalized = value => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const clock = (hour, minute) => `${hour.padStart(2, '0')}:${minute}`

/** Bind only a named task and one time range in the same clause. Ambiguous
 * language remains the model's job; unrelated ranges are never interchangeable. */
export function explicitTaskSlot(text, title, today, fallbackDate) {
  let date = fallbackDate
  const matches = []
  for (const clause of text.split(/[，,。；;\n]/u)) {
    const iso = clause.match(/\b\d{4}-\d{2}-\d{2}\b/u)?.[0]
    const relative = clause.match(/后天|明天|今天|今晚|明晚/u)?.[0]
    if (iso) date = iso
    else if (relative) {
      const base = new Date(`${today}T12:00:00`)
      base.setDate(base.getDate() + (relative === '后天' ? 2 : /明/u.test(relative) ? 1 : 0))
      date = localDay(base)
    }
    const ranges = [...clause.matchAll(rangePattern)]
    const name = normalized(clause.replace(rangePattern, ''))
    if (normalized(title).length < 2 || !name.includes(normalized(title)) || ranges.length !== 1 || !date) continue
    const [, fromHour, fromMin, toHour, toMin] = ranges[0]
    const start = clock(fromHour, fromMin), end = clock(toHour, toMin)
    if (start < end) matches.push({ date, start, end })
  }
  return matches.length === 1 ? matches[0] : null
}

/** Capture unambiguous, already-existing task targets before the first write.
 * A short leading name ("数学缩到…") binds only when one live task has that
 * prefix. Ambiguous references stay with the model; this is not a scheduler. */
export function namedTaskSlots(text, tasks, today, fallbackDate) {
  const live = tasks.filter(task => !task.deletedAt && !['done', 'dropped'].includes(task.status))
  const targets = new Map()
  for (const task of live) {
    const slot = explicitTaskSlot(text, task.title, today, fallbackDate)
    if (slot) targets.set(task.id, { taskId: task.id, title: task.title, slot })
  }
  for (const clause of text.split(/[，,。；;\n]/u)) {
    const range = [...clause.matchAll(rangePattern)]
    if (range.length !== 1) continue
    const prefix = normalized(clause.slice(0, range[0].index)
      .replace(/^(?:今天|今晚|明天|明晚|后天)?\s*(?:把|将)?\s*/u, '')
      .replace(/(?:缩到|缩短到|改到|改成|调整到|安排在|安排到|挪到|放到|移到|排在|排到)\s*$/u, ''))
    if (prefix.length < 2) continue
    const candidates = live.filter(task => normalized(task.title.replace(/^完成\s*/u, '')).startsWith(prefix))
    if (candidates.length !== 1) continue
    const slot = explicitTaskSlot(text, prefix, today, fallbackDate)
    if (slot && !targets.has(candidates[0].id)) targets.set(candidates[0].id, { taskId: candidates[0].id, title: candidates[0].title, slot })
  }
  return [...targets.values()]
}
