/**
 * 隔周课表（weekCycle / weekAnchor）行为契约。
 *
 * 全部使用真实内存数据库（createDatabase(':memory:')）、真实投影与容量函数
 * （src/planner/model.ts）以及固定日期 fixture；不做源码文本匹配。
 * 只创建临时内存连接，不读写用户数据库、不联网、不调用模型。
 *
 * 固定 fixture：2026-03-02 是周一（第 1 周），2026-03-09 是下一周周一，
 * 2026-03-08 是周日，2026-03-06 / 2026-03-13 分别是第 1、2 周的周五。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { dayCapacity, routinesForDay } from '../src/planner/model.ts'
import { routineOccursOn, weekCycleLabel, weekStart } from '../src/planner/weekCycle.ts'

process.env.TZ = 'Asia/Shanghai'

const MONDAY = '2026-03-02', NEXT_MONDAY = '2026-03-09', SUNDAY = '2026-03-08'
const at = (date, time = '12:00') => new Date(`${date}T${time}:00+08:00`)
const shift = (date, days) => { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10) }
const routine = (patch = {}) => ({ id: 'cycle-odd', title: '单周物理', kind: 'class', weekdays: [1], start: '08:00', end: '09:00', location: '实验室', items: [], enabled: true, ...patch })
const cycled = (cycle, patch = {}) => routine({ id: `cycle-${cycle}`, weekCycle: cycle, weekAnchor: MONDAY, ...patch })
const available = patch => routine({ id: 'cycle-available', title: '早自习空档', kind: 'available', start: '07:30', end: '12:00', location: '', ...patch })
/** 隔周 fixture 只统计 cycle-* 前缀，避免与默认「晚自习/周末可安排时间」混淆。 */
const cycleIds = (state, date) => routinesForDay(state, date).filter(item => item.id.startsWith('cycle-')).map(item => item.id).sort()
const hasWindow = (ranges, start, end) => ranges.some(range => range.start <= start && range.end >= end)
function fixture() {
  const db = createDatabase(':memory:')
  return { db, edit: action => db.updatePlanner(action, db.getPlanner().revision) }
}
const rejects = (run, pattern) => assert.throws(run, error => pattern.test(error.message) && [400, 409].includes(error.status))

test('未配置 weekCycle 的安排按每周重复，显式 weekly 也不会落库成隔周', () => {
  const { db, edit } = fixture()
  try {
    edit({ type: 'import-routines', routines: [routine({ id: 'cycle-legacy', weekCycle: undefined, weekAnchor: undefined })] })
    const legacy = db.getPlanner().routines.find(item => item.id === 'cycle-legacy')
    assert.equal(Object.hasOwn(legacy, 'weekCycle'), false, '未配置不写入 weekCycle')
    assert.equal(Object.hasOwn(legacy, 'weekAnchor'), false, '未配置不写入 weekAnchor')
    assert.deepEqual(cycleIds(db.getPlanner(), MONDAY), ['cycle-legacy'])
    assert.deepEqual(cycleIds(db.getPlanner(), NEXT_MONDAY), ['cycle-legacy'], '未配置的安排每周都出现')
    edit({ type: 'save-routine', routine: routine({ id: 'cycle-weekly', weekCycle: 'weekly', weekAnchor: MONDAY }) })
    const weekly = db.getPlanner().routines.find(item => item.id === 'cycle-weekly')
    assert.equal(Object.hasOwn(weekly, 'weekCycle'), false)
    assert.equal(weekCycleLabel(weekly), '每周')
    assert.equal(weekCycleLabel({}), '每周')
    assert.equal(routineOccursOn({ enabled: true, weekdays: [1], weekCycle: 'weekly' }, MONDAY), true)
    assert.deepEqual(cycleIds(db.getPlanner(), NEXT_MONDAY), ['cycle-legacy', 'cycle-weekly'])
  } finally { db.close() }
})

test('odd 以锚点周一所在周为第1周，even 为下一周', () => {
  const odd = cycled('odd'), even = cycled('even')
  assert.equal(routineOccursOn(odd, MONDAY), true, '锚点所在周是第1周')
  assert.equal(routineOccursOn(odd, NEXT_MONDAY), false)
  assert.equal(routineOccursOn(odd, shift(MONDAY, 14)), true, '第3周回到单周')
  assert.equal(routineOccursOn(even, MONDAY), false)
  assert.equal(routineOccursOn(even, NEXT_MONDAY), true, 'even 的第1周是锚点的下一周')
  assert.equal(routineOccursOn(even, shift(MONDAY, 14)), false)
  assert.equal(weekCycleLabel(odd), '单周')
  assert.equal(weekCycleLabel(even), '双周')
  assert.equal(routineOccursOn({ ...odd, weekAnchor: '2026-03-04' }, MONDAY), true, '周三锚点按所在周归一到周一')
  const { db, edit } = fixture()
  try {
    edit({ type: 'save-routine', routine: cycled('odd', { title: '单周物理' }) })
    edit({ type: 'save-routine', routine: cycled('even', { title: '双周物理', start: '10:00', end: '11:00' }) })
    assert.deepEqual(db.getPlanner().routines.filter(item => item.id.startsWith('cycle-'))
      .map(item => [item.id, item.weekCycle, item.weekAnchor, item.title]).sort(),
    [['cycle-even', 'even', MONDAY, '双周物理'], ['cycle-odd', 'odd', MONDAY, '单周物理']])
    assert.deepEqual(cycleIds(db.getPlanner(), MONDAY), ['cycle-odd'])
    assert.deepEqual(cycleIds(db.getPlanner(), NEXT_MONDAY), ['cycle-even'])
  } finally { db.close() }
})

test('跨年、周日与负周差都不改变单双周', () => {
  const odd = { enabled: true, weekdays: [1], weekCycle: 'odd', weekAnchor: '2025-12-22' }
  assert.equal(routineOccursOn(odd, '2025-12-22'), true)
  assert.equal(routineOccursOn(odd, '2025-12-29'), false)
  assert.equal(routineOccursOn(odd, '2026-01-05'), true, '跨年不重置周次')
  assert.equal(routineOccursOn({ ...odd, weekCycle: 'even' }, '2026-01-05'), false)
  assert.equal(weekStart(SUNDAY), MONDAY, '周日属于上一个周一那一周')
  assert.equal(weekStart(MONDAY), MONDAY)
  assert.equal(weekStart('2026-03-01'), '2026-02-23', '3 月 1 日周日归到 2 月 23 日周一')
  const sundayOdd = { enabled: true, weekdays: [0], weekCycle: 'odd', weekAnchor: MONDAY }
  assert.equal(routineOccursOn(sundayOdd, SUNDAY), true, '第1周的周日仍按单周')
  assert.equal(routineOccursOn(sundayOdd, '2026-03-15'), false, '第2周的周日按双周')
  // 锚点周是第1周（单周）；正负周差用同一套交替，符号不改变单双周。
  const later = cycle => ({ enabled: true, weekdays: [1], weekCycle: cycle, weekAnchor: '2026-03-16' })
  assert.deepEqual([-2, -1, 0, 1, 2].map(offset => {
    const date = shift('2026-03-16', offset * 7)
    return [date, routineOccursOn(later('odd'), date), routineOccursOn(later('even'), date)]
  }), [
    ['2026-03-02', true, false], ['2026-03-09', false, true], ['2026-03-16', true, false],
    ['2026-03-23', false, true], ['2026-03-30', true, false],
  ])
  assert.equal(weekStart('2026-02-30'), undefined, '不存在的日期没有周起点')
  assert.equal(weekStart('2026-3-2'), undefined)
  assert.equal(routineOccursOn({ enabled: true, weekdays: [1], weekCycle: 'odd' }, '2026-01-05'), false, '缺锚点的隔周安排不出现')
  assert.equal(routineOccursOn({ enabled: true, weekdays: [1], weekCycle: 'odd', weekAnchor: 'not-a-date' }, MONDAY), false)
  assert.equal(routineOccursOn({ enabled: false, weekdays: [1], weekCycle: 'odd', weekAnchor: MONDAY }, MONDAY), false, '停用安排不出现')
  assert.equal(routineOccursOn({ enabled: true, weekdays: [2], weekCycle: 'odd', weekAnchor: MONDAY }, MONDAY), false, '星期不匹配不出现')
})

test('夏令时切换不改变单双周（真实时区子进程对照）', () => {
  const dates = ['2025-12-29', '2026-01-05', '2026-03-01', '2026-03-02', '2026-03-08', '2026-03-09', '2026-03-16', '2026-11-01', '2026-11-02', '2026-11-09']
  const source = `
    const { routineOccursOn, weekStart } = await import(${JSON.stringify(new URL('../src/planner/weekCycle.ts', import.meta.url).href)})
    const odd = { enabled: true, weekdays: [0, 1, 3], weekCycle: 'odd', weekAnchor: '2026-03-02' }
    const even = { enabled: true, weekdays: [0, 1, 3], weekCycle: 'even', weekAnchor: '2026-03-02' }
    const dates = ${JSON.stringify(dates)}
    process.stdout.write(JSON.stringify(dates.map(date => [date, weekStart(date), routineOccursOn(odd, date), routineOccursOn(even, date)])))
  `
  const run = timezone => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, TZ: timezone }, encoding: 'utf8' }))
  const newYork = run('America/New_York'), sydney = run('Australia/Sydney')
  assert.deepEqual(newYork, sydney, '南北半球夏令时切换都不影响单双周')
  const odd = { enabled: true, weekdays: [0, 1, 3], weekCycle: 'odd', weekAnchor: MONDAY }
  const even = { ...odd, weekCycle: 'even' }
  assert.deepEqual(newYork, dates.map(date => [date, weekStart(date), routineOccursOn(odd, date), routineOccursOn(even, date)]), '两个时区都与本进程的判定一致')
  assert.equal(newYork.some(([, , oddValue, evenValue]) => oddValue === evenValue), false, '每一天必属单周或双周之一')
})

test('投影、空档与保存冲突校验对同一周的判断一致，停用安排不出现', () => {
  const { db, edit } = fixture()
  try {
    edit({ type: 'import-routines', routines: [
      cycled('odd'),
      available(),
      routine({ id: 'cycle-disabled', title: '已停用', start: '10:00', end: '11:00', weekCycle: 'odd', weekAnchor: MONDAY, enabled: false }),
    ] })
    const task = db.createTask({ title: '写作业', estimateMin: 30, inbox: false })
    const state = db.getPlanner(), tasks = db.listTasks()
    assert.deepEqual(cycleIds(state, MONDAY), ['cycle-available', 'cycle-odd'])
    assert.deepEqual(cycleIds(state, NEXT_MONDAY), ['cycle-available'], '双周没有单周课程，停用安排也不出现')
    assert.equal(hasWindow(dayCapacity(state, tasks, MONDAY, at(MONDAY)).available, 480, 540), false, '单周周一 08:00–09:00 被课程占用')
    assert.equal(hasWindow(dayCapacity(state, tasks, NEXT_MONDAY, at(NEXT_MONDAY)).available, 480, 540), true, '双周周一同一时段仍然空着')
    const save = (date, start, end) => db.updatePlanner({ type: 'save-block', block: { id: `block-${date}-${start}`, taskId: task.id, date, start, end, locked: false } }, db.getPlanner().revision)
    rejects(() => save(MONDAY, '08:30', '08:45'), /这个时间已有课程、休息或固定活动/u)
    assert.equal(hasWindow(dayCapacity(db.getPlanner(), tasks, MONDAY, at(MONDAY)).available, 480, 540), false)
    assert.doesNotThrow(() => save(NEXT_MONDAY, '08:30', '08:45'), '双周同一时段可以安排任务')
    assert.doesNotThrow(() => save(MONDAY, '10:30', '10:45'), '停用安排不占用时间')
    assert.doesNotThrow(() => save(MONDAY, '13:00', '13:30'))
    const conflict = { id: 'cycle-conflict', title: '周会', kind: 'class', weekdays: [1], start: '13:00', end: '13:30', location: '', items: [], enabled: true }
    rejects(() => edit({ type: 'save-routine', routine: { ...conflict, weekCycle: 'odd', weekAnchor: MONDAY } }), /固定安排与已有任务时间重叠/u)
    assert.doesNotThrow(() => edit({ type: 'save-routine', routine: { ...conflict, id: 'cycle-conflict-even', weekCycle: 'even', weekAnchor: MONDAY } }), '双周不与单周已排任务冲突')
  } finally { db.close() }
})

test('单日调课快照按目标日期所在周的单双周取来源星期', () => {
  const { db, edit } = fixture()
  try {
    edit({ type: 'import-routines', routines: [
      cycled('odd', { id: 'cycle-mon-odd', title: '单周周一' }),
      cycled('even', { id: 'cycle-mon-even', title: '双周周一', start: '10:00', end: '11:00' }),
      cycled('odd', { id: 'cycle-fri-odd', title: '单周周五', weekdays: [5], start: '14:00', end: '15:00' }),
      available(),
    ] })
    const template = (date, weekday) => { edit({ type: 'set-day-template', date, sourceWeekday: weekday }); return db.getPlanner().dayOverrides[date] }
    /** 快照按来源星期收录当天全部安排；这里只比较课程，另外单独断言可用窗口也在快照里。 */
    const templateClasses = (date, weekday) => template(date, weekday).routines
      .filter(item => item.id.startsWith('cycle-') && item.kind === 'class').map(item => [item.id, item.start])
    assert.equal(db.getPlanner().dayOverrides[NEXT_MONDAY], undefined)
    assert.deepEqual(templateClasses(NEXT_MONDAY, 1), [['cycle-mon-even', '10:00']], '双周周一取双周课表')
    assert.deepEqual(template(NEXT_MONDAY, 1).routines.map(item => item.id).sort(), ['cycle-available', 'cycle-mon-even', 'default-evening-study'], '快照收录来源星期的全部安排（含默认晚自习）')
    assert.deepEqual(templateClasses(MONDAY, 1), [['cycle-mon-odd', '08:00']], '单周周一取单周课表')
    assert.deepEqual(templateClasses('2026-03-06', 5).map(item => item[0]), ['cycle-fri-odd'])
    rejects(() => edit({ type: 'set-day-template', date: '2026-03-13', sourceWeekday: 5 }), /还没有已启用的课程/u)
    const state = db.getPlanner(), tasks = db.listTasks()
    assert.equal(hasWindow(dayCapacity(state, tasks, MONDAY, at(MONDAY)).available, 600, 660), true, '单周快照里没有双周 10:00 的课')
    assert.equal(hasWindow(dayCapacity(state, tasks, MONDAY, at(MONDAY)).available, 480, 540), false, '单周快照保留 08:00 的课')
    assert.equal(hasWindow(dayCapacity(state, tasks, NEXT_MONDAY, at(NEXT_MONDAY)).available, 600, 660), false, '双周快照里 10:00 被占用')
    assert.equal(hasWindow(dayCapacity(state, tasks, NEXT_MONDAY, at(NEXT_MONDAY)).available, 480, 540), true)
  } finally { db.close() }
})

test('手动编辑按各自周次刷新未来快照，过去快照保留', () => {
  const today = (() => { const value = new Date(); const pad = number => String(number).padStart(2, '0'); return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` })()
  const anchor = weekStart(today)
  const pastDate = shift(anchor, -7), nextDate = shift(anchor, 7), laterDate = shift(anchor, 14)
  const { db, edit } = fixture()
  try {
    edit({ type: 'import-routines', routines: [
      routine({ id: 'cycle-weekly', title: '每周物理', weekCycle: undefined, weekAnchor: undefined }),
      cycled('odd', { id: 'cycle-odd', title: '单周加课', start: '10:00', end: '11:00', weekAnchor: anchor }),
    ] })
    for (const date of [pastDate, nextDate, laterDate]) edit({ type: 'set-day-template', date, sourceWeekday: 1 })
    const snapshot = date => db.getPlanner().dayOverrides[date]
    const titles = date => snapshot(date).routines.filter(item => item.id.startsWith('cycle-')).map(item => `${item.id}:${item.title}`).sort()
    assert.deepEqual(titles(pastDate), ['cycle-weekly:每周物理'], `${pastDate} 是锚点前一周（双周）`)
    assert.deepEqual(titles(nextDate), ['cycle-weekly:每周物理'], `${nextDate} 是第2周（双周）`)
    assert.deepEqual(titles(laterDate), ['cycle-odd:单周加课', 'cycle-weekly:每周物理'], `${laterDate} 是第3周（单周）`)
    const pastBefore = JSON.stringify(snapshot(pastDate))
    edit({ type: 'edit-weekday', weekday: 1, replacements: [{ routineId: 'cycle-weekly', title: '每周物理（改）', kind: 'class' }], syncDates: [nextDate, laterDate] })
    assert.deepEqual(titles(nextDate), ['cycle-weekly:每周物理（改）'], '双周快照同步后仍不含单周加课')
    assert.deepEqual(titles(laterDate), ['cycle-odd:单周加课', 'cycle-weekly:每周物理（改）'], '单周快照同步后保留单周加课')
    assert.equal(JSON.stringify(snapshot(pastDate)), pastBefore, '过去快照不被同步改写')
    // 直接保存周模板也会刷新未来快照，同样只按各自周次，并且不动过去的快照。
    const weekly = db.getPlanner().routines.find(item => item.id === 'cycle-weekly')
    edit({ type: 'save-routine', routine: { ...weekly, title: '每周物理（再改）' } })
    assert.deepEqual(titles(nextDate), ['cycle-weekly:每周物理（再改）'])
    assert.deepEqual(titles(laterDate), ['cycle-odd:单周加课', 'cycle-weekly:每周物理（再改）'])
    assert.equal(JSON.stringify(snapshot(pastDate)), pastBefore, '过去快照仍然保留')
  } finally { db.close() }
})

test('备份导出与恢复保留单双周，非法锚点被拒绝', () => {
  const { db, edit } = fixture()
  try {
    edit({ type: 'save-routine', routine: cycled('odd', { title: '单周物理' }) })
    edit({ type: 'save-routine', routine: cycled('even', { title: '双周物理', start: '10:00', end: '11:00' }) })
    const backup = db.exportData()
    const exported = JSON.parse(backup.tables.state.find(row => row.key === 'planner-v1').value).routines.find(item => item.id === 'cycle-odd')
    assert.deepEqual([exported.weekCycle, exported.weekAnchor, exported.title], ['odd', MONDAY, '单周物理'], '导出 JSON 保留 cycle 与锚点')
    const restored = createDatabase(':memory:')
    try {
      restored.importData(backup)
      const state = restored.getPlanner()
      const odd = state.routines.find(item => item.id === 'cycle-odd'), even = state.routines.find(item => item.id === 'cycle-even')
      assert.deepEqual([odd.weekCycle, odd.weekAnchor], ['odd', MONDAY])
      assert.deepEqual([even.weekCycle, even.weekAnchor], ['even', MONDAY])
      assert.deepEqual(cycleIds(state, MONDAY), ['cycle-odd'], '恢复后单双周投影不变')
      assert.deepEqual(cycleIds(state, NEXT_MONDAY), ['cycle-even'])
    } finally { restored.close() }
    const tamper = patch => {
      const tables = structuredClone(backup.tables)
      const row = tables.state.find(item => item.key === 'planner-v1')
      const state = JSON.parse(row.value)
      Object.assign(state.routines.find(item => item.id === 'cycle-odd'), patch)
      row.value = JSON.stringify(state)
      return { ...backup, tables, checksum: createHash('sha256').update(JSON.stringify(tables)).digest('hex') }
    }
    for (const [patch, pattern] of [
      [{ weekAnchor: undefined }, /隔周安排需要明确第1周的周一日期/u],
      [{ weekAnchor: '2026-03-04' }, /隔周安排需要明确第1周的周一日期/u],
      [{ weekCycle: 'fortnightly' }, /重复周次不正确/u],
    ]) {
      const target = createDatabase(':memory:')
      try { rejects(() => target.importData(tamper(patch)), pattern) } finally { target.close() }
    }
    for (const [patch, pattern] of [
      [{ weekCycle: 'odd', weekAnchor: undefined }, /隔周安排需要明确第1周的周一日期/u],
      [{ weekCycle: 'even', weekAnchor: '2026-03-04' }, /隔周安排需要明确第1周的周一日期/u],
      [{ weekCycle: 'weekly', weekAnchor: '2026-03-04' }, /基准周需要有效的周一日期/u],
      [{ weekCycle: 'fortnightly', weekAnchor: MONDAY }, /重复周次不正确/u],
    ]) {
      const invalid = fixture()
      try { rejects(() => invalid.edit({ type: 'save-routine', routine: routine({ id: 'cycle-bad', ...patch }) }), pattern) } finally { invalid.db.close() }
    }
  } finally { db.close() }
})
