import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { upcomingDeadlines, unconfirmedDeadlineCount } from '../src/workbench/deadlines.ts'

// Match Vite's relative TypeScript resolution while testing the real task selector.
const sourceRoot = new URL('../src/', import.meta.url).href
const resolution = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})
const { taskGroups, recommendationReason } = await import('../src/workbench/tasks.ts')
resolution.deregister()

process.env.TZ = 'Asia/Shanghai'

const task = (id, due, extra = {}) => ({
  id, title: id, due, area: null, source: 'manual', inbox: false, leadDays: 3,
  importance: 2, energy: 'deep', context: [], status: 'todo',
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', deletedAt: null,
  ...extra,
})
const now = new Date('2026-09-17T12:00:00+08:00')
const item = (due, at = now) => upcomingDeadlines([task('one', due)], at)[0]

test('date-only values preserve the entire local due day without a fabricated time', () => {
  assert.deepEqual(item('2026-09-17'), {
    task: task('one', '2026-09-17'), urgency: 'urgent', remainingLabel: '今天截止',
    dateLabel: '9月17日 · 全天', deadlineMs: new Date('2026-09-18T00:00:00+08:00').getTime(),
  })
  assert.equal(item('2026-09-17', new Date('2026-09-17T23:59:59.999+08:00')).urgency, 'urgent')
  assert.equal(item('2026-09-17', new Date('2026-09-18T00:00:00+08:00')).urgency, 'overdue')
  assert.equal(item('2026-09-17', new Date('2026-09-18T00:00:00+08:00')).remainingLabel, '刚刚到期')
  assert.equal(item('2026-09-15').remainingLabel, '逾期2天')
  assert.equal(item('2026-09-18').remainingLabel, '明天截止')
  assert.equal(item('2026-09-21').remainingLabel, '还有4天')
})

test('date-only day counts and labels cross month and year boundaries', () => {
  const endOfYear = new Date('2026-12-31T18:00:00+08:00')
  assert.equal(item('2027-01-01', endOfYear).remainingLabel, '明天截止')
  assert.equal(item('2027-01-02', endOfYear).remainingLabel, '还有2天')
  assert.equal(item('2027-01-01', endOfYear).dateLabel, '2027年1月1日 · 全天')
  assert.equal(item('2026-10-01', new Date('2026-09-30T23:00:00+08:00')).remainingLabel, '明天截止')
})

test('precise timestamps use their actual timezone and human readable remaining time', () => {
  assert.equal(item('2026-09-17T04:45:00Z').remainingLabel, '剩45分钟')
  assert.equal(item('2026-09-17T07:00:00Z').remainingLabel, '剩3小时')
  assert.equal(item('2026-09-19T12:00:00+08:00').remainingLabel, '剩2天')
  assert.equal(item('2026-09-17T03:00:00Z').remainingLabel, '逾期1小时')
  assert.equal(item('2026-09-15T12:00:00+08:00').remainingLabel, '逾期2天')
  assert.equal(item('2026-09-17T04:00:00Z').remainingLabel, '刚刚到期')
  assert.equal(item('2026-09-17T04:00:00Z').urgency, 'overdue')
  assert.equal(item('2026-09-17T04:45:00Z').dateLabel, '9月17日 · 12:45')
  assert.equal(item('2026-09-17T12:00:30+08:00').remainingLabel, '剩不到1分钟')
  assert.equal(item('2026-09-17T12:45').deadlineMs, item('2026-09-17T04:45:00Z').deadlineMs)
})

test('urgency boundaries cover 24 hours, 72 hours, one week and beyond', () => {
  const atHours = hours => item(new Date(now.getTime() + hours * 3_600_000).toISOString()).urgency
  assert.equal(atHours(-1), 'overdue')
  assert.equal(atHours(0), 'overdue')
  assert.equal(atHours(24), 'urgent')
  assert.equal(atHours(24 + 1 / 3600), 'soon')
  assert.equal(atHours(72), 'soon')
  assert.equal(atHours(72 + 1 / 3600), 'upcoming')
  assert.equal(atHours(168), 'upcoming')
  assert.equal(atHours(168 + 1 / 3600), 'later')
})

test('invalid deadlines are counted separately while closed, deleted and unscheduled tasks are omitted', () => {
  const tasks = [
    task('valid', '2026-09-18'), task('doing', '2026-09-18', { status: 'doing' }),
    task('invalid', '2026-02-30'), task('ambiguous', '明天下午'), task('bad-month', '2026-13-01'),
    task('bad-time', '2026-09-17T25:00:00Z'), task('bad-date-time', '2026-02-30T08:00:00Z'),
    task('no-date'), task('blank', ''), task('space', '   '),
    task('done', '2026-09-17', { status: 'done' }), task('dropped', '2026-09-17', { status: 'dropped' }),
    task('deleted', '2026-09-17', { deletedAt: now.toISOString() }),
    task('closed-invalid', 'unknown', { status: 'done' }),
  ]
  assert.deepEqual(upcomingDeadlines(tasks, now).map(entry => entry.task.id), ['doing', 'valid'])
  assert.equal(unconfirmedDeadlineCount(tasks), 5)
  assert.equal(item('2028-02-29').dateLabel, '2028年2月29日 · 全天')
  assert.equal(item('2027-02-29'), undefined)
  assert.deepEqual(upcomingDeadlines(tasks, new Date('invalid')), [])
})

test('ordering is deadline first, then importance, creation and ID without input mutation', () => {
  const due = '2026-09-18T10:00:00+08:00'
  const tasks = [
    task('late', '2026-10-01'), task('normal-b', due), task('normal-a', due),
    task('important', due, { importance: 3 }),
    task('created-earlier', due, { createdAt: '2026-08-01T00:00:00Z' }),
    task('recent-overdue', '2026-09-16'), task('old-overdue', '2026-09-14'),
  ]
  const before = JSON.stringify(tasks)
  tasks.forEach(Object.freeze)
  Object.freeze(tasks)
  const expected = ['old-overdue', 'recent-overdue', 'important', 'created-earlier', 'normal-a', 'normal-b', 'late']
  assert.deepEqual(upcomingDeadlines(tasks, now).map(entry => entry.task.id), expected)
  assert.deepEqual(upcomingDeadlines([...tasks].reverse(), now).map(entry => entry.task.id), expected)
  assert.equal(JSON.stringify(tasks), before)
})

test('recommendations and Upcoming both place precise deadlines before the end of that day', () => {
  const tasks = [
    task('all-day', '2026-09-17'),
    task('afternoon', '2026-09-17T15:00:00+08:00'),
    task('late-evening', '2026-09-17T23:59:00+08:00'),
    task('tomorrow-all-day', '2026-09-18'),
    task('tomorrow-morning', '2026-09-18T09:00:00+08:00'),
  ]
  const groups = taskGroups(tasks, now)
  assert.deepEqual(groups.available.map(entry => entry.id), ['afternoon', 'late-evening', 'all-day'])
  assert.deepEqual(groups.later.map(entry => entry.id), ['tomorrow-morning', 'tomorrow-all-day'])
  assert.deepEqual([...groups.available, ...groups.later].map(entry => entry.id), upcomingDeadlines(tasks, now).map(entry => entry.task.id))
  assert.equal(recommendationReason(groups.available[0], now), '截止时间更近，先留出这一段时间')
})

test('recommendation overdue boundaries agree with Upcoming and preserve active-task priority', () => {
  const midnight = new Date('2026-09-18T00:00:00+08:00')
  const allDay = task('all-day', '2026-09-17')
  const precise = task('precise', '2026-09-18T00:00:00+08:00')
  for (const entry of [allDay, precise]) {
    assert.equal(upcomingDeadlines([entry], midnight)[0].urgency, 'overdue')
    assert.equal(recommendationReason(entry, midnight), '已过截止时间，先处理这一项')
  }
  assert.equal(recommendationReason(task('invalid', '2026-09-17T24:00'), now), '从已收下的事项里，先推进这一项')
  const tasks = [task('late', '2026-09-17T15:00:00+08:00'), task('ongoing', '2026-09-17', { status: 'doing' }), task('overdue', '2026-09-16')]
  assert.deepEqual(taskGroups(tasks, now).available.map(entry => entry.id), ['overdue', 'ongoing', 'late'])
})

test('local calendar counts survive 23-hour spring and 25-hour autumn days', () => {
  const moduleUrl = new URL('../src/workbench/deadlines.ts', import.meta.url).href
  const source = `
    import { upcomingDeadlines } from ${JSON.stringify(moduleUrl)}
    const task = due => ({ id: due, title: due, due, status: 'todo', deletedAt: null, importance: 2, createdAt: '2026-01-01' })
    const read = (due, now) => upcomingDeadlines([task(due)], new Date(now))[0]
    const spring = read('2026-03-08', '2026-03-08T00:00:00-05:00')
    const autumn = read('2026-11-01', '2026-11-01T00:00:00-04:00')
    process.stdout.write(JSON.stringify({
      springLength: spring.deadlineMs - new Date('2026-03-08T00:00:00-05:00').getTime(),
      autumnLength: autumn.deadlineMs - new Date('2026-11-01T00:00:00-04:00').getTime(),
      springTomorrow: read('2026-03-09', '2026-03-08T00:00:00-05:00').remainingLabel,
      autumnTomorrow: read('2026-11-02', '2026-11-01T00:00:00-04:00').remainingLabel,
      springTwoDays: read('2026-03-10', '2026-03-08T12:00:00-04:00').remainingLabel,
      autumnTwoDays: read('2026-11-03', '2026-11-01T12:00:00-05:00').remainingLabel,
      autumnTodayUrgency: autumn.urgency,
      springTodayUrgency: spring.urgency,
    }))
  `
  const actual = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' }))
  assert.deepEqual(actual, {
    springLength: 23 * 3_600_000, autumnLength: 25 * 3_600_000,
    springTomorrow: '明天截止', autumnTomorrow: '明天截止',
    springTwoDays: '还有2天', autumnTwoDays: '还有2天',
    autumnTodayUrgency: 'urgent', springTodayUrgency: 'urgent',
  })
})
