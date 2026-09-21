import test from 'node:test'
import assert from 'node:assert/strict'
import { availabilityWindows, nextSchedule } from '../server/plannerContext.mjs'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-18'
const at = time => new Date(`${DATE}T${time}+08:00`)
const state = patch => ({ revision: 1, timetableConfirmed: true, routines: [], blocks: [], details: {}, checked: {}, ...patch })
const routine = (id, kind, start, end, patch = {}) => ({ id, title: id, kind, start, end, weekdays: [5], location: '', items: [], enabled: true, ...patch })
const task = (id, patch = {}) => ({ id, title: id, status: 'todo', deletedAt: null, ...patch })
const block = (id, taskId, start, end, date = DATE) => ({ id, taskId, start, end, date, locked: false })
const units = value => {
  const text = JSON.stringify(value), cjk = (text.match(/[\u3000-\u9fff\uff00-\uffef]/gu) ?? []).length
  return Math.ceil(cjk * 1.2 + (text.length - cjk) / 3)
}

function evening(patch = {}) {
  return state({ routines: [
    routine('math', 'class', '17:00', '18:00', { title: '数学', location: 'A401' }),
    routine('study', 'available', '18:00', '20:00', { title: '晚自习', location: '学校' }),
    routine('dorm', 'available', '20:30', '22:30', { title: '宿舍', location: '宿舍' }),
  ], ...patch })
}

test('an occupied evening window carries the activity past the next math lesson', () => {
  const s = evening({ blocks: [block('robot-plan', 'robot', '18:00', '20:00')] })
  const tasks = [task('robot', { title: '机器人社新生第一次活动' })], before = structuredClone(s)
  const view = availabilityWindows(s, tasks, DATE, at('16:00:00'))
  const study = view.items.find(item => item.id === 'study')
  assert.equal(view.truncated, false)
  assert.equal(study.status, 'occupied')
  assert.equal(study.freeMinutes, 0)
  assert.equal(study.remainingMinutes, 0)
  assert.deepEqual(study.remaining, [])
  assert.equal(study.occupied.total, 1)
  assert.equal(study.occupied.truncated, false)
  assert.deepEqual(study.occupied.items[0], { id: 'robot-plan', taskId: 'robot', title: '机器人社新生第一次活动', kind: 'plan', start: '18:00', end: '20:00', location: '' })
  const preview = nextSchedule(s, tasks, DATE, { localDate: DATE, localMinute: '16:00' })
  assert.deepEqual(preview.items.map(item => item.title), ['数学', '机器人社新生第一次活动'])
  assert.equal(preview.total, 2)
  assert.equal(preview.truncated, false)
  assert.deepEqual(s, before)
})

test('classes, breaks and blocks all identify their occupancy inside a named window', () => {
  const s = state({ routines: [routine('study', 'available', '18:00', '21:00', { title: '晚自习' }),
    routine('club', 'class', '18:00', '18:30', { title: '机器人社', location: 'A422' }),
    routine('break', 'break', '19:00', '19:15', { title: '休息', location: '学校' })],
  blocks: [block('report-plan', 'report', '20:00', '20:30')] })
  const view = availabilityWindows(s, [task('report')], DATE, at('19:30:00'))
  const window = view.items[0]
  assert.equal(window.status, 'partial')
  assert.equal(window.freeMinutes, 105)
  assert.equal(window.remainingMinutes, 60)
  assert.deepEqual(window.remaining, [{ start: 1170, end: 1200 }, { start: 1230, end: 1260 }])
  assert.deepEqual(window.occupied.items.map(item => [item.kind, item.title, item.location]), [
    ['class', '机器人社', 'A422'], ['break', '休息', '学校'], ['plan', 'report', ''],
  ])
})

test('future overrides use their target day and a fully occupied class window stays occupied', () => {
  const future = '2026-09-20', routines = [routine('study', 'available', '18:00', '20:00', { title: '晚自习' }),
    routine('club', 'class', '18:00', '20:00', { title: '机器人社', location: 'A422' })]
  const s = state({ routines: [], dayOverrides: { [future]: { date: future, sourceWeekday: 5, routines } } })
  const view = availabilityWindows(s, [], future, at('21:00:00'))
  assert.equal(view.items[0].status, 'occupied')
  assert.equal(view.items[0].remainingMinutes, 0)
  assert.equal(view.items[0].occupied.items[0].title, '机器人社')
  assert.equal(view.items[0].occupied.items[0].location, 'A422')
  assert.equal(nextSchedule(s, [], future, at('21:00:00')).items[0].status, '接下来')
  assert.equal(availabilityWindows(s, [], '2026-09-21', at('21:00:00')).total, 0)
})

test('derived timed tasks and completed tasks occupy time; due-only and dropped tasks do not', () => {
  const s = evening({ blocks: [block('done-plan', 'done', '19:00', '19:30'), block('dropped-plan', 'dropped', '19:30', '20:00')] })
  const tasks = [task('timed', { startAt: `${DATE}T18:00:00+08:00`, estimateMin: 60 }), task('done', { status: 'done' }),
    task('due', { due: DATE, estimateMin: 120 }), task('dropped', { status: 'dropped' })]
  const study = availabilityWindows(s, tasks, DATE, at('16:00:00')).items.find(item => item.id === 'study')
  assert.equal(study.freeMinutes, 30)
  assert.deepEqual(study.occupied.items.map(item => item.taskId), ['timed', 'done'])
})

test('remaining ranges retain seconds and past days cannot gain remaining availability', () => {
  const s = evening()
  const current = availabilityWindows(s, [], DATE, at('18:30:30')).items.find(item => item.id === 'study')
  assert.equal(current.freeMinutes, 120)
  assert.equal(current.remainingMinutes, 89.5)
  assert.deepEqual(current.remaining, [{ start: 1110.5, end: 1200 }])
  const past = availabilityWindows(s, [], DATE, new Date('2026-09-19T08:00:00+08:00')).items[0]
  assert.equal(past.remainingMinutes, 0)
  assert.deepEqual(past.remaining, [])
})

test('missing or disabled named windows never become inferred free time', () => {
  const s = state({ routines: [routine('dorm', 'available', '20:30', '22:30', { enabled: false }), routine('math', 'class', '17:00', '18:00')] })
  assert.deepEqual(availabilityWindows(s, [], DATE, at('16:00:00')), { items: [], total: 0, truncated: false })
  assert.equal(nextSchedule(s, [], DATE, at('18:00:00')).total, 0)
})

test('small multiday budgets retain exact occupancy with explicit nested omissions', () => {
  const tasks = Array.from({ length: 12 }, (_, index) => task(`task-${index}`, { title: `活动${index}${'很长的安排名称'.repeat(8)}` }))
  const dates = Array.from({ length: 7 }, (_, index) => `2026-09-${18 + index}`)
  const s = state({ routines: [routine('study', 'available', '18:00', '20:00', { title: '晚自习', weekdays: [0, 1, 2, 3, 4, 5, 6] })],
    blocks: dates.flatMap(date => tasks.map((item, index) => block(`${date}-${index}`, item.id, `18:${String(index * 5).padStart(2, '0')}`, '20:00', date))) })
  const views = dates.map(date => availabilityWindows(s, tasks, date, at('16:00:00'), 280))
  for (const view of views) {
    assert.ok(units(view) <= 280)
    assert.equal(view.items[0].status, 'occupied')
    assert.equal(view.items[0].freeMinutes, 0)
    assert.equal(view.items[0].occupied.total, 12)
    assert.equal(view.items[0].occupied.truncated, true)
    assert.equal(view.items[0].truncated, true)
    assert.equal(view.truncated, true)
    assert.equal(view.readMore, 'read_planner')
  }
})

test('budget is enforced even for oversized rows and dropped named windows are explicit', () => {
  const s = state({ routines: Array.from({ length: 30 }, (_, index) => routine(`window-${index}`, 'available', '18:00', '20:00', { title: '空闲'.repeat(80) })) })
  for (const budget of [64, 120, 280, 900]) {
    const view = availabilityWindows(s, [], DATE, at('16:00:00'), budget)
    assert.ok(units(view) <= budget, `${units(view)} exceeds ${budget}`)
    assert.equal(view.total, 30)
    assert.equal(view.truncated, true)
  }
})

test('upcoming evening windows take precedence over elapsed morning windows', () => {
  const s = evening()
  for (let index = 0; index < 12; index++) s.routines.unshift(routine(`old-${index}`, 'available', '08:00', '09:00'))
  const view = availabilityWindows(s, [], DATE, at('16:00:00'), 280)
  assert.ok(view.items.some(item => item.id === 'study'))
  assert.equal(view.total, 14)
  assert.equal(view.truncated, true)
})

test('schedule previews report complete counts beyond the several visible entries', () => {
  const s = state({ routines: Array.from({ length: 12 }, (_, index) => routine(`class-${index}`, index === 5 ? 'break' : 'class', '17:00', '18:00')) })
  const preview = nextSchedule(s, [], DATE, at('17:30:00'), 900)
  assert.ok(preview.items.length > 1 && preview.items.length <= 6)
  assert.ok(preview.items.every(item => item.status === '进行中'))
  assert.equal(preview.total, 12)
  assert.equal(preview.truncated, true)
  assert.equal(preview.readMore, 'read_planner')
  const tiny = nextSchedule(s, [], DATE, at('17:30:00'), 64)
  assert.ok(units(tiny) <= 64)
  assert.equal(tiny.total, 12)
  assert.equal(tiny.truncated, true)
})
