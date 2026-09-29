import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { blocksForDay, routinesForDay } from '../src/planner/model.ts'
import { agendaDate, localDay, shiftDay } from '../src/home/agenda.ts'

const hash = value => createHash('sha256').update(value).digest('hex')
function allowed(at, quiet) {
  const minute = at.getHours() * 60 + at.getMinutes()
  const parse = x => Number(x.slice(0, 2)) * 60 + Number(x.slice(3))
  const start = parse(quiet.quietStart), end = parse(quiet.quietEnd)
  return start === end || (start < end ? minute < start || minute >= end : minute < start && minute >= end)
}

/** Pure projection: only persisted, open work; no model, no invented deadlines. */
export function buildReminderPlan({ tasks, planner, preferences }, now = new Date()) {
  const entries = new Map(), end = shiftDay(now, 30).getTime()
  const add = (id, title, body, at) => {
    if (!Number.isFinite(at.getTime()) || at <= now || at.getTime() > end || !allowed(at, preferences.notifications)) return
    entries.set(id, { id: `astaria.${hash(id).slice(0, 40)}`, title: title.slice(0, 200), body: body.slice(0, 1000), at: Math.floor(at.getTime() / 1000) })
  }
  const persisted = new Map(planner.blocks.map(block => [block.id, block]))
  const open = tasks.filter(t => !t.deletedAt && ['todo', 'doing'].includes(t.status)), byId = new Map(open.map(t => [t.id, t]))
  for (let offset = 0; offset <= 30; offset++) {
    const date = localDay(shiftDay(now, offset))
    for (const block of blocksForDay(planner, open, date)) {
      const task = byId.get(block.taskId)
      const original = persisted.get(block.id)
      const implicitStart = !original && task?.startAt ? agendaDate(task.startAt) : null
      if ((original && original.date !== date) || (implicitStart && localDay(implicitStart) !== date)) continue
      if (!task || (task.freeTimeGoalId && (!original || (Object.hasOwn(planner.completedFreeTimeSessions ?? {}, block.id) && planner.completedFreeTimeSessions[block.id])))) continue
      const start = new Date(`${date}T${block.start}:00`), early = new Date(start.getTime() - 5 * 60_000)
      add(`session:${block.id}:${date}`, `即将开始：${task.title}`, `${block.start}–${block.end}${task.freeTimeGoalId ? ' · 本次余时' : ''}`, early)
    }
    for (const routine of routinesForDay(planner, date).filter(r => r.kind === 'class')) {
      const start = new Date(`${date}T${routine.start}:00`), early = new Date(start.getTime() - 5 * 60_000)
      add(`routine:${routine.id}:${date}`, `即将开始：${routine.title}`, `${routine.start}–${routine.end}${routine.location ? ` · ${routine.location}` : ''}`, early)
    }
  }
  for (const task of open.filter(t => t.due)) {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(task.due)
    const due = agendaDate(task.due)
    if (!due) continue
    const at = dateOnly ? new Date(`${task.due}T20:00:00`) : new Date(due.getTime() - 30 * 60_000)
    add(`deadline:${task.id}`, dateOnly ? `今天截止：${task.title}` : `即将截止：${task.title}`, dateOnly ? '今天还有这项事项待完成' : `截止 ${due.toLocaleString('zh-CN', { hour12: false })}`, at)
  }
  const all = [...entries.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  return { entries: all.slice(0, 64), omitted: Math.max(0, all.length - 64) }
}

export function nativeReminderRunner(binary) {
  return (command, input) => new Promise((yes, no) => {
    const child = execFile(binary, [command], { timeout: command === 'authorize' ? 95_000 : 20_000, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error) { no(new Error('系统提醒服务暂不可用，请稍后重试')); return }
      try { const value = JSON.parse(stdout); if (value.error) throw Error(value.error); yes(value) } catch (reason) { no(reason) }
    })
    child.stdin.end(input === undefined ? '' : JSON.stringify(input))
  })
}

export function createReminderService({ stateFile, snapshot, run, now = () => new Date() }) {
  let enabled = false, authorization = 0, count = 0, through = null, error = null, omitted = 0, fingerprint = '', timer, pending, closed = false
  const ready = readFile(stateFile, 'utf8').then(value => { enabled = JSON.parse(value).enabled === true }).catch(() => {})
  const status = () => ({ supported: true, enabled, authorization, count, through, omitted, error })
  const sync = async () => {
    await ready
    if (closed) return status()
    if (pending) { await pending; return sync() }
    pending = (async () => {
      try {
        const native = await run('status'); authorization = native.authorization
        const plan = enabled ? buildReminderPlan(snapshot(), now()) : { entries: [], omitted: 0 }
        const key = hash(JSON.stringify([plan.entries, authorization]))
        if (key !== fingerprint) {
          await run('replace', plan.entries)
          fingerprint = key
        }
        count = plan.entries.length; omitted = plan.omitted; through = plan.entries.at(-1)?.at ?? null; error = null
      } catch (reason) { error = reason instanceof Error ? reason.message : '系统提醒尚未同步' }
      return status()
    })().finally(() => { pending = null })
    return pending
  }
  const schedule = () => { if (!closed && (enabled || error)) { clearTimeout(timer); timer = setTimeout(() => void sync(), 400); timer.unref?.() } }
  return {
    initialize: sync, status: async () => { await ready; if (pending) await pending; return status() }, schedule,
    setEnabled: async value => {
      if (typeof value !== 'boolean') throw Error('提醒开关无效')
      await ready
      if (value) {
        const result = await run('authorize'); authorization = result.authorization
        if (![2, 3].includes(authorization)) throw Error('请先在系统设置 → 通知中允许 ASTaria 提醒')
      }
      enabled = value; await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 }); await writeFile(stateFile, JSON.stringify({ enabled }), { mode: 0o600 })
      return sync()
    },
    flush: async () => { clearTimeout(timer); return sync() },
    close: () => { closed = true; clearTimeout(timer) },
  }
}

export async function handleReminderRequest(service, req, res) {
  if (!req.url?.startsWith('/api/desktop/reminders')) return false
  const send = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)) }
  try {
    if (req.method === 'GET' && req.url === '/api/desktop/reminders') send(200, await service.status())
    else if (req.method === 'POST' && ['/api/desktop/reminders/enabled', '/api/desktop/reminders/refresh'].includes(req.url)) {
      if (req.headers['x-astaria-local'] !== '1') { send(403, { error: 'Forbidden' }); return true }
      let size = 0; const chunks = []
      for await (const chunk of req) { size += chunk.length; if (size > 1024) throw Error('提醒请求过大'); chunks.push(chunk) }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      send(200, req.url.endsWith('/enabled') ? await service.setEnabled(body.enabled) : await service.flush())
    } else send(405, { error: 'Method not allowed' })
  } catch (reason) { send(400, { error: reason instanceof Error && /[\u3400-\u9fff]/u.test(reason.message) ? reason.message : '系统提醒操作未完成，请重试' }) }
  return true
}
