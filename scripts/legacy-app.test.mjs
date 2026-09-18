import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { recommendTask } from '../src/domain/schedule.ts'

process.env.TZ = 'Asia/Shanghai'

// Resolve extensionless TypeScript imports in the same way as Vite.
const sourceRoot = new URL('../src/', import.meta.url).href
const resolution = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})
const { calendarEventMatches, calendarTaskMatches, legacyDateHeading, legacyWeekDays, localDateKey, weekdayForDate } = await import('../src/domain/legacyApp.ts')
resolution.deregister()

test('legacy date keys use the local day before the UTC date changes', () => {
  const beforeEight = new Date('2026-09-17T16:30:00.000Z')
  assert.equal(localDateKey(beforeEight), '2026-09-18')
  assert.equal(localDateKey(new Date('2026-09-18T00:30:00+08:00')), '2026-09-18')
  for (const hour of [0, 7, 8, 23]) assert.equal(localDateKey(new Date(2026, 8, 18, hour, 59)), '2026-09-18')
  assert.equal(localDateKey(new Date(2026, 8, 19, 0, 0)), '2026-09-19')
})

test('weekend recommendations fail closed instead of indexing weekday-only subjects', () => {
  const saturday = new Date(2026, 8, 19, 10)
  const sunday = new Date(2026, 8, 20, 10)
  assert.equal(weekdayForDate(saturday), null)
  assert.equal(weekdayForDate(sunday), null)
  assert.equal(recommendTask([], '周六'), null)
  assert.equal(recommendTask([], '周日'), null)
  assert.equal(recommendTask([], weekdayForDate(saturday)), null)
  assert.equal(weekdayForDate(new Date(2026, 8, 21)), '周一')
  assert.equal(weekdayForDate(new Date(2026, 8, 18)), '周五')
})

test('legacy today heading and week labels follow the current local date', () => {
  const date = new Date(2026, 8, 18, 12)
  assert.equal(legacyDateHeading(date), '2026 年 9 月 18 日 · 周五')
  assert.deepEqual(legacyWeekDays(date).map(item => item.date), [14, 15, 16, 17, 18])
  assert.equal(legacyWeekDays(date).find(item => item.isToday)?.label, '周五')
  assert.deepEqual(legacyWeekDays(new Date(2027, 0, 1)).map(item => item.date), [28, 29, 30, 31, 1])
  assert.equal(legacyWeekDays(new Date(2026, 8, 20)).some(item => item.isToday), false)
})

test('calendar task matching includes year and preserves date-only values locally', () => {
  assert.equal(calendarTaskMatches('2025-09-18', 2026, 8, 18), false)
  assert.equal(calendarTaskMatches('2026-09-18', 2026, 8, 18), true)
  assert.equal(calendarTaskMatches('2026-09-18T23:30:00+08:00', 2026, 8, 18), true)
  assert.equal(calendarTaskMatches('2026-09-17T16:30:00Z', 2026, 8, 18), true)
  assert.equal(calendarTaskMatches('2026-09-17T16:30:00Z', 2026, 8, 17), false)
  assert.equal(calendarTaskMatches('invalid', 2026, 8, 18), false)
})

test('calendar events continue across month and year boundaries', () => {
  assert.equal(calendarEventMatches('2026-08-31', '2026-09-02', 2026, 8, 1), true)
  assert.equal(calendarEventMatches('2025-08-31', '2025-09-02', 2026, 8, 1), false)
  assert.equal(calendarEventMatches('2026-12-31', '2027-01-02', 2027, 0, 1), true)
  assert.equal(calendarEventMatches('2026-08-31', '2026-09-02', 2026, 7, 31), true)
  assert.equal(calendarEventMatches('2026-08-31', '2026-09-02', 2026, 8, 2), true)
  assert.equal(calendarEventMatches('2026-09-02', '2026-09-02', 2026, 8, 2), true)
  assert.equal(calendarEventMatches('2026-08-31', '2026-09-02', 2026, 8, 3), false)
  assert.equal(calendarEventMatches('invalid', '2026-09-02', 2026, 8, 1), false)
})
