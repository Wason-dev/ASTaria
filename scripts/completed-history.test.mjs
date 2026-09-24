import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
const root = new URL('../src/', import.meta.url).href
const hook = registerHooks({ resolve(specifier, context, nextResolve) { if (context.parentURL?.startsWith(root) && specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) return nextResolve(`${specifier}.ts`, context); return nextResolve(specifier, context) } })
const { completedTaskPage } = await import('../src/workbench/completionHistory.ts')
hook.deregister()
const now = new Date('2026-09-22T12:00:00+08:00')
const task = (id, doneAt, extra = {}) => ({ id, title: id, status: 'done', doneAt, deletedAt: null, createdAt: '2026-01-01', updatedAt: '2026-01-01', ...extra })
test('recent view is local seven-day calendar and excludes unknown dates', () => {
  const result = completedTaskPage([
    task('today', '2026-09-22T01:00:00Z'), task('first', '2026-09-16T01:00:00Z'),
    task('old', '2026-09-15T23:00:00+08:00'), task('unknown'), task('future', '2026-09-23'),
  ], now, { mode: 'recent' })
  assert.deepEqual(result.items.map(item => item.id), ['today', 'first'])
  assert.equal(result.unknownDateCount, 1)
})
test('history is title/date filterable, pages eight, and leaves unknown dates discoverable by title', () => {
  const tasks = Array.from({ length: 10 }, (_, index) => task(`item-${index}`, `2026-09-${String(10 + index).padStart(2, '0')}T12:00:00+08:00`)).concat([task('no-date')])
  const page = completedTaskPage(tasks, now, { mode: 'history', page: 1 })
  assert.equal(page.pageSize, 8); assert.equal(page.pageCount, 2); assert.equal(page.items.length, 3)
  assert.deepEqual(completedTaskPage(tasks, now, { mode: 'history', query: 'no-date' }).items.map(item => item.id), ['no-date'])
  assert.equal(completedTaskPage(tasks, now, { mode: 'history', from: '2026-09-15', to: '2026-09-12' }).invalidRange, true)
})
