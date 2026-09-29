import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { assertGroups, createHorizonGrouping, groupPlans, groupsFor, hasSavedGroups, sameGroups } from '../server/horizonGroups.mjs'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-26', TOMORROW = '2026-09-27', LATER = '2026-09-28'
const dates = [DATE, TOMORROW, LATER]
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const completion = value => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] })
const fixture = t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const act = action => db.updatePlanner(action, db.getPlanner().revision)
  for (const routine of db.getPlanner().routines) act({ type: 'delete-routine', id: routine.id })
  const add = (id, title, start, date = DATE, taskPatch = {}, blockPatch = {}) => {
    const task = db.createTask({ title, ...taskPatch })
    act({ type: 'save-block', block: { id, taskId: task.id, date, start: `${String(start).padStart(2, '0')}:00`, end: `${String(start).padStart(2, '0')}:30`, locked: false, ...blockPatch } })
    return task
  }
  add('algebra', '数学函数练习', 10, DATE, { area: 'math' })
  add('physics', '物理电路复习', 11, DATE, { area: 'physics' })
  add('geometry', '数学几何错题', 12, DATE, { area: 'math' })
  add('reading', '读小说', 10, TOMORROW)
  const snap = () => {
    const state = db.getPlanner(), tasks = db.listTasks(), taskMap = new Map(tasks.map(task => [task.id, task]))
    const items = state.blocks.filter(block => dates.includes(block.date)).sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start)).map(block => ({
      id: block.id, taskId: block.taskId, title: taskMap.get(block.taskId).title, date: block.date, start: block.start, end: block.end,
      durationMin: 30, movable: !block.locked, ...(block.id === 'algebra' ? { needsReschedule: true } : {}),
    }))
    const value = { state, taskMap, tasks, dates, goals: db.getCompanionState().freeTimeGoals ?? [], movable: items.filter(item => item.movable) }
    value.view = { date: DATE, days: 3, revision: state.revision, snapshotKey: hash({ state, tasks }), asOf: `${DATE}T09:00:00+08:00`, items }
    value.view.groups = groupsFor(value, db)
    value.view.groupingSaved = hasSavedGroups(value)
    return value
  }
  const list = () => snap().view
  const request = () => { const view = list(); return { date: DATE, expectedRevision: view.revision, snapshotKey: view.snapshotKey, requestId: randomUUID() } }
  return { db, act, add, snap, list, request }
}
const draft = snap => snap.view.groups.map(group => ({ id: group.id, title: group.title, day: group.day, itemIds: group.tasks.map(task => task.id) }))
const validSuggestion = () => ({ groups: [
  { title: '理科学习', day: 0, itemIds: ['algebra', 'physics', 'geometry'] },
  { title: '阅读', day: 1, itemIds: ['reading'] },
] })

test('grouping checks model units before inference and keeps existing membership intact', async t => {
  const f = fixture(t)
  f.db.setPreference('model-connection', { contextBudget: { mode: 'custom', maxUnits: 8000 } })
  const time = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
  for (let i = 0; i < 80; i++) f.add(`large-${i}`, `任务${i}${'核对内容'.repeat(35)}`, 13, DATE, {}, {
    start: time(780 + i * 5), end: time(785 + i * 5),
  })
  const before = f.db.getPlanner()
  let calls = 0
  const grouping = createHorizonGrouping({ db: f.db, list: f.list, complete: async () => { calls++; return completion(validSuggestion()) } })
  await assert.rejects(grouping.suggest(f.request()), /上下文预算/)
  assert.equal(calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
})

test('fallback groups prefer a goal over its category and keep needsReschedule, day and six-item bounds', t => {
  const f = fixture(t), algebra = f.db.getPlanner().blocks.find(block => block.id === 'algebra')
  f.db.saveCompanionState({ ...f.db.getCompanionState(), freeTimeGoals: [{ id: 'functions', taskId: algebra.taskId, title: '掌握函数' }] })
  for (let index = 0; index < 7; index++) f.add(`practice-${index}`, '数学练习', 13 + index, DATE, { area: 'math' })
  const snap = f.snap(), groups = snap.view.groups
  assert.equal(groups.find(group => group.tasks.some(task => task.id === 'algebra')).title, '掌握函数')
  assert.equal(groups.find(group => group.tasks.some(task => task.id === 'algebra')).tasks[0].needsReschedule, true)
  assert.equal(groups.flatMap(group => group.tasks).length, snap.movable.length)
  assert.ok(groups.every(group => group.tasks.length <= 6))
  assert.equal(groups.at(-1).day, 1)
  assert.deepEqual(groupsFor(snap, f.db), groups)
  assert.equal(hasSavedGroups(snap), false)
})

test('saved membership overrides categories and splits a dispersed group into stable per-day view IDs', t => {
  const f = fixture(t), state = f.db.getPlanner()
  for (const id of ['algebra', 'physics', 'reading']) {
    f.act({ type: 'save-block', block: { ...state.blocks.find(block => block.id === id), horizonGroupId: 'saved-science', horizonGroupTitle: '项目推进' } })
  }
  const snap = f.snap(), saved = snap.view.groups.filter(group => group.title === '项目推进')
  assert.equal(saved.length, 2)
  assert.notEqual(saved[0].id, saved[1].id)
  assert.deepEqual(saved[0].tasks.map(task => task.id), ['algebra', 'physics'])
  assert.deepEqual(saved[1].tasks.map(task => task.id), ['reading'])
  assert.deepEqual(groupsFor(snap, f.db), snap.view.groups)
  assert.equal(hasSavedGroups(snap), true)
  assert.equal(hasSavedGroups(snap.view), true)
})

test('manual splits, merges and member moves accept a complete unique membership; old title-less drafts remain compatible', t => {
  const f = fixture(t), snap = f.snap()
  const groups = [
    { id: 'new-a', title: '先一起做', day: 0, itemIds: ['physics', 'algebra'] },
    { id: 'new-b', title: '稍后', day: 0, itemIds: ['geometry'] },
    { id: 'new-c', title: '阅读', day: 1, itemIds: ['reading'] },
  ]
  assert.doesNotThrow(() => assertGroups({ groups }, snap))
  assert.equal(sameGroups({ groups }, snap), false)
  const original = draft(snap)
  assert.equal(sameGroups({ groups: original }, snap), true)
  assert.equal(sameGroups({ groups: original.map(({ title, ...group }) => group) }, snap), true)
  assert.equal(sameGroups({ groups: original.map((group, index) => index === 0 ? { ...group, title: '改名' } : group) }, snap), false)
  const invalid = [
    groups.slice(1), [...groups, groups[0]], groups.map((group, index) => index === 0 ? { ...group, itemIds: ['physics', 'unknown'] } : group),
    groups.map((group, index) => index === 0 ? { ...group, id: 'bad\nidentifier' } : group),
    groups.map((group, index) => index === 0 ? { ...group, title: undefined } : group),
    groups.map((group, index) => index === 0 ? { ...group, title: ' '.repeat(20) } : group),
    groups.map((group, index) => index === 0 ? { ...group, day: 3 } : group),
  ]
  for (const candidate of invalid) assert.throws(() => assertGroups({ groups: candidate }, snap))
})

test('membership-only save is atomic, undoable, preserved in backup and retained by an older calendar form', t => {
  const f = fixture(t), snap = f.snap(), before = f.db.getPlanner()
  const groups = [
    { id: 'work', title: '集中学习', day: 0, itemIds: ['algebra', 'physics', 'geometry'] },
    { id: 'reading-group', title: '小说', day: 1, itemIds: ['reading'] },
  ]
  const plans = groupPlans(before.blocks, { groups }, snap)
  const operation = f.db.applyPlannerOperation({ id: 'group-op', requestId: randomUUID(), summary: '保存分组', expectedRevision: before.revision,
    actions: plans.map(block => ({ type: 'save-block', block })) }, { scenario: true })
  assert.deepEqual(f.db.getPlanner().blocks.map(({ horizonGroupId, horizonGroupTitle, ...block }) => block), before.blocks)
  assert.equal(f.db.getPlanner().blocks[0].horizonGroupId, 'work')
  assert.equal(operation.planChanges[0].after.horizonGroupTitle, '集中学习')
  const backup = f.db.exportData(), restored = createDatabase(':memory:'); t.after(() => restored.close())
  restored.importData(backup)
  assert.deepEqual(restored.getPlanner().blocks, plans)
  f.db.undoOperation(operation.id)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
  const oldForm = { ...plans[0], start: '09:00', end: '09:30' }
  delete oldForm.horizonGroupId; delete oldForm.horizonGroupTitle
  restored.updatePlanner({ type: 'save-block', block: oldForm }, restored.getPlanner().revision)
  assert.equal(restored.getPlanner().blocks.find(block => block.id === oldForm.id).horizonGroupTitle, '集中学习')
})

test('planner and backup require paired valid group metadata, with rollback for malformed persisted content', t => {
  const f = fixture(t), before = f.db.getPlanner(), block = before.blocks[0]
  for (const patch of [{ horizonGroupId: 'only-id' }, { horizonGroupTitle: 'only-title' }, { horizonGroupId: 'ok', horizonGroupTitle: '' }, { horizonGroupId: 'bad\nvalue', horizonGroupTitle: 'ok' }]) {
    assert.throws(() => f.act({ type: 'save-block', block: { ...block, ...patch } }))
    assert.deepEqual(f.db.getPlanner(), before)
  }
  const backup = f.db.exportData(), stateRow = backup.tables.state.find(row => row.key === 'planner-v1'), value = JSON.parse(stateRow.value)
  value.blocks[0].horizonGroupId = 'missing-title'; stateRow.value = JSON.stringify(value); backup.checksum = hash(backup.tables)
  assert.throws(() => f.db.importData(backup), /组名称/)
  assert.deepEqual(f.db.getPlanner(), before)
})

test('one model call suggests semantic groups as a draft, streams concrete proposals and never writes the planner', async t => {
  const f = fixture(t); f.list()
  const before = f.db.exportData().tables, events = [], seen = []
  const svc = createHorizonGrouping({ list: f.list, complete: async (payload, options) => {
    seen.push([payload, options]); options.onDelta({ type: 'reasoning', delta: 'private thought' }); options.onDelta({ type: 'content', delta: '{' })
    return completion(validSuggestion())
  } })
  const result = await svc.suggest(f.request(), { onEvent: event => events.push(event) })
  assert.equal(seen.length, 1)
  assert.equal(seen[0][1].purpose, 'horizon-grouping')
  const context = JSON.parse(seen[0][0].messages[1].content)
  assert.equal(context.items.length, 4)
  assert.equal(context.initialGroups.length, 3)
  assert.deepEqual(result.groups.map(group => group.title), ['理科学习', '阅读'])
  assert.equal(result.groups[0].tasks[0].needsReschedule, true)
  assert.deepEqual(f.db.exportData().tables, before)
  assert.equal(events.some(event => event.type === 'phase' && event.phase === 'thinking'), true)
  assert.equal(events.some(event => event.type === 'phase' && event.phase === 'receiving'), true)
  assert.equal(events.filter(event => event.activity?.state === 'proposed').length, 2)
  assert.equal(JSON.stringify(events).includes('private thought'), false)
})

test('same request and simultaneous snapshot requests share one call; later opens use the short cache', async t => {
  const f = fixture(t); let release, calls = 0
  const gate = new Promise(resolve => { release = resolve })
  const svc = createHorizonGrouping({ list: f.list, complete: async () => { calls++; await gate; return completion(validSuggestion()) } })
  const input = f.request(), a = svc.suggest(input), b = svc.suggest(input), c = svc.suggest({ ...input, requestId: randomUUID() })
  assert.equal(a, b); assert.equal(a, c)
  await Promise.resolve(); release()
  const result = await a
  assert.deepEqual(await svc.suggest(f.request()), result)
  assert.equal(calls, 1)
  const events = []
  await svc.suggest(input, { onEvent: event => events.push(event) })
  assert.ok(events.some(event => event.activity?.state === 'proposed'))
})

test('stale snapshots are refused before calling and after receiving the model', async t => {
  const f = fixture(t); let calls = 0
  const stale = f.request()
  f.db.updateTask(f.db.getPlanner().blocks[0].taskId, { title: '已在别处改名' })
  const noCall = createHorizonGrouping({ list: f.list, complete: async () => { calls++; return completion(validSuggestion()) } })
  assert.throws(() => noCall.suggest(stale), /日程已变化/)
  assert.equal(calls, 0)
  const svc = createHorizonGrouping({ list: f.list, complete: async () => {
    f.db.updateTask(f.db.getPlanner().blocks[0].taskId, { title: '模型处理途中改名' }); return completion(validSuggestion())
  } })
  await assert.rejects(svc.suggest(f.request()), /日程已变化/)
  assert.equal(hasSavedGroups(f.snap()), false)
})

for (const [name, mutate] of [
  ['missing', value => value.groups[0].itemIds.pop()],
  ['duplicate', value => value.groups[0].itemIds.push('algebra')],
  ['invented', value => value.groups[0].itemIds[0] = 'invented'],
  ['cross-day', value => value.groups[1].day = 0],
  ['unknown-field', value => value.groups[0].reasoning = 'not allowed'],
  ['blank-title', value => value.groups[0].title = ''],
]) test(`malformed model ${name} suggestion is rejected without writes or poisoned cache`, async t => {
  const f = fixture(t), before = f.db.getPlanner(); let broken = true, calls = 0
  const svc = createHorizonGrouping({ list: f.list, complete: async () => {
    calls++; const value = validSuggestion(); if (broken) mutate(value); return completion(value)
  } })
  const input = f.request()
  await assert.rejects(svc.suggest(input))
  assert.deepEqual(f.db.getPlanner(), before)
  broken = false
  assert.equal((await svc.suggest(input)).groups.length, 2)
  assert.equal(calls, 2)
})

test('timeout aborts the provider, ignores late deltas, and permits a fresh retry', async t => {
  const f = fixture(t), events = []; let options, stuck = true
  const svc = createHorizonGrouping({ list: f.list, timeoutMs: 15, complete: async (_payload, next) => {
    options = next
    return stuck ? new Promise(() => {}) : completion(validSuggestion())
  } })
  const input = f.request()
  await assert.rejects(svc.suggest(input, { onEvent: event => events.push(event) }), /超时/)
  assert.equal(options.signal.aborted, true)
  const count = events.length; options.onDelta({ type: 'content', delta: 'late' }); assert.equal(events.length, count)
  stuck = false
  assert.equal((await svc.suggest(input)).groups.length, 2)
  assert.equal(hasSavedGroups(f.snap()), false)
})

test('empty and one-item scopes skip the model; locks remain excluded', async t => {
  const f = fixture(t)
  for (const block of f.db.getPlanner().blocks) f.act({ type: 'delete-block', id: block.id })
  let calls = 0
  const svc = createHorizonGrouping({ list: f.list, complete: async () => { calls++; throw new Error('must not run') } })
  assert.deepEqual((await svc.suggest(f.request())).groups, [])
  f.add('one', '一件事', 10)
  f.add('lock', '锁定', 11, DATE, {}, { locked: true })
  assert.equal((await svc.suggest(f.request())).groups[0].tasks[0].id, 'one')
  assert.equal(calls, 0)
})
