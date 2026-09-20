import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const sourceRoot = new URL('../src/', import.meta.url).href
const resolution = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/u.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})
const { selectCurrentTask } = await import('../src/home/currentTask.ts')
resolution.deregister()

process.env.TZ = 'Asia/Shanghai'
const task = (id, patch = {}) => ({
  id, title: id, area: null, source: 'manual', inbox: false, leadDays: 3,
  importance: 2, energy: 'deep', context: [], status: 'todo',
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', deletedAt: null,
  ...patch,
})

test('home chooses an explicit deadline before undated ongoing or higher-importance work', () => {
  const undatedDoing = task('doing', { status: 'doing', importance: 3 })
  const datedTodo = task('due', { due: '2026-09-19T18:00:00+08:00', importance: 1 })
  assert.equal(selectCurrentTask([undatedDoing, datedTodo]), datedTodo)
})

test('earliest actual deadline wins even when later work is ongoing and more important', () => {
  const soon = task('soon', { due: '2026-09-19T10:00:00Z', importance: 1 })
  const later = task('later', { due: '2026-09-19T19:00:00+08:00', status: 'doing', importance: 3 })
  assert.equal(selectCurrentTask([later, soon]), soon)
})

test('overdue unfinished tasks stay ahead of future deadlines', () => {
  const overdue = task('overdue', { due: '2026-09-17' })
  const future = task('future', { due: '2026-09-19T18:00:00+08:00', status: 'doing' })
  assert.equal(selectCurrentTask([future, overdue]), overdue)
})

test('date-only deadlines represent the end of the whole local day', () => {
  const allDay = task('all-day', { due: '2026-09-19', status: 'doing' })
  const evening = task('evening', { due: '2026-09-19T23:59:00+08:00' })
  const nextMorning = task('next-morning', { due: '2026-09-20T09:00:00+08:00' })
  assert.equal(selectCurrentTask([allDay, nextMorning, evening]), evening)
  assert.equal(selectCurrentTask([nextMorning, allDay]), allDay)
})

test('invalid or ambiguous dates are undated rather than normalized into a false priority', () => {
  const valid = task('valid', { due: '2026-12-31', importance: 1 })
  for (const due of ['2026-02-30', '2026-02-30T12:00:00Z', '2026-09-18T24:00:00Z', '明天', '', undefined]) {
    assert.equal(selectCurrentTask([task('invalid', { due, status: 'doing', importance: 3 }), valid]), valid)
  }
})

test('closed and deleted tasks never appear as the current homepage task', () => {
  const open = task('open')
  const excluded = [
    task('done', { due: '2026-01-01', status: 'done' }),
    task('dropped', { due: '2026-01-01', status: 'dropped' }),
    task('deleted', { due: '2026-01-01', deletedAt: '2026-09-18T00:00:00Z' }),
  ]
  assert.equal(selectCurrentTask([...excluded, open]), open)
  assert.equal(selectCurrentTask(excluded), undefined)
  assert.equal(selectCurrentTask([]), undefined)
})

test('equal deadlines use doing, importance, creation time and ID as stable tiebreakers', () => {
  const due = '2026-09-19'
  const todo = task('todo', { due, importance: 3 })
  const doing = task('doing', { due, status: 'doing', importance: 1 })
  assert.equal(selectCurrentTask([todo, doing]), doing)
  const important = task('important', { due, importance: 3 })
  const normal = task('normal', { due, importance: 2 })
  assert.equal(selectCurrentTask([normal, important]), important)
  const older = task('older', { due, createdAt: '2026-08-01T00:00:00Z' })
  assert.equal(selectCurrentTask([normal, older]), older)
  const a = task('a', { due }), b = task('b', { due })
  assert.equal(selectCurrentTask([b, a]), a)
  assert.equal(selectCurrentTask([a, b]), a)
})

test('undated fallback stays predictable and selection never mutates its input', () => {
  const tasks = [task('todo', { importance: 3 }), task('doing', { status: 'doing' })]
  const before = JSON.stringify(tasks)
  tasks.forEach(Object.freeze)
  Object.freeze(tasks)
  assert.equal(selectCurrentTask(tasks).id, 'doing')
  assert.equal(JSON.stringify(tasks), before)
})
