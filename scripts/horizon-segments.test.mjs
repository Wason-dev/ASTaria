import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createHorizonOrder } from '../server/horizonOrder.mjs'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-10-14'
const completion = value => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] })
const minutes = block => {
  const read = time => time.split(':').reduce((h, m) => h * 60 + Number(m), 0)
  return read(block.end) - read(block.start)
}
function fixture(t, { onlyFragments = false, protectedTask = false, firstShort = false } = {}) {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  let at = new Date(`${DATE}T09:39:00+08:00`)
  const act = action => db.updatePlanner(action, db.getPlanner().revision)
  for (const row of db.getPlanner().routines) act({ type: 'delete-routine', id: row.id })
  act({ type: 'save-routine', routine: { id: 'available', title: '可用', kind: 'available', weekdays: [0,1,2,3,4,5,6], start: '09:00', end: onlyFragments ? '11:15' : '18:00', location: '', items: [], enabled: true } })
  act({ type: 'save-routine', routine: { id: 'lunch', title: '午休', kind: 'break', weekdays: [0,1,2,3,4,5,6], start: '12:00', end: '13:00', location: '', items: [], enabled: true } })
  act({ type: 'save-day-event', event: { id: 'class', title: '上课', date: DATE, start: '10:00', end: onlyFragments ? '10:50' : '10:30', location: '', items: [] } })
  const long = db.createTask({ title: '物理作业', area: 'physics', ...(protectedTask ? { freeTimeGoalId: 'goal-long' } : {}) })
  const short = onlyFragments ? null : db.createTask({ title: '数学练习', area: 'math' })
  const block = (id, task, start, end) => act({ type: 'save-block', block: { id, taskId: task.id, date: DATE, start, end, locked: false } })
  block('long', long, onlyFragments ? '09:00' : firstShort ? '14:00' : '15:00', onlyFragments ? '09:45' : firstShort ? '14:45' : '15:45')
  if (short) block('short', short, firstShort ? '15:00' : '14:00', firstShort ? '15:15' : '14:15')
  if (protectedTask) db.saveCompanionState({ ...db.getCompanionState(), freeTimeGoals: [{ id: 'goal-long', title: '每日物理', taskId: long.id }] })
  const seen = { calls: 0, contexts: [] }
  let model = async () => completion({ changes: [] })
  const svc = createHorizonOrder({ db, now: () => at, complete: async (payload, options) => {
    seen.calls++; seen.contexts.push(JSON.parse(payload.messages[1].content)); return model(payload, options)
  } })
  const snap = svc.list({ date: DATE })
  const input = { date: DATE, expectedRevision: snap.revision, snapshotKey: snap.snapshotKey, requestId: randomUUID(),
    groups: snap.groups.map(group => ({ id: group.id, day: group.day, itemIds: group.tasks.map(task => task.id) })).reverse() }
  return { db, svc, seen, long, short, input, act, at: value => { at = new Date(`${DATE}T${value}:00+08:00`) }, model: fn => { model = fn } }
}
const taskBlocks = (f, task) => f.db.getPlanner().blocks.filter(block => block.taskId === task.id).sort((a, b) => a.start.localeCompare(b.start))

test('a complete task uses the current free window instead of keeping its later original window', async t => {
  const f = fixture(t, { firstShort: true })
  const result = await f.svc.apply(f.input)
  assert.equal(result.schedulingQuestion, undefined)
  assert.equal(f.seen.calls, 1)
  assert.deepEqual(taskBlocks(f, f.short).map(block => [block.start, block.end]), [['09:40', '09:55']])
  assert.equal(taskBlocks(f, f.long).length, 1)
})

test('20 minutes remaining for a 45-minute task returns choices without model calls, writes or a receipt', async t => {
  const f = fixture(t), before = f.db.getPlanner()
  const journal = `horizon-order:${createHash('sha256').update(JSON.stringify(f.input.requestId)).digest('hex')}`
  for (let i = 0; i < 2; i++) {
    const result = await f.svc.apply(f.input)
    assert.equal(result.operation, null)
    assert.deepEqual(result.schedulingQuestion.options.map(option => option.value), ['split', 'whole', 'cancel'])
    assert.match(result.schedulingQuestion.prompt, /物理作业.*45 分钟.*20 分钟/)
    assert.equal(result.schedulingQuestion.sourceId, 'long')
    assert.equal(result.schedulingQuestion.snapshotKey, f.input.snapshotKey)
  }
  assert.equal(f.seen.calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
  assert.equal(f.db.getPreference(journal), null)
})

test('choosing one complete session keeps 45 minutes together in the next fitting window', async t => {
  const f = fixture(t)
  await f.svc.apply(f.input)
  const result = await f.svc.apply({ ...f.input, fragmentPolicy: 'whole' })
  assert.equal(result.schedulingQuestion, undefined)
  assert.equal(f.seen.calls, 1)
  assert.deepEqual(taskBlocks(f, f.long).map(block => [block.start, block.end]), [['10:30', '11:15']])
  assert.equal(result.operation.undoable, true)
})

test('explicit splitting saves 20 + 25 minutes atomically, inherits grouping and undoes both fragments', async t => {
  const f = fixture(t), before = f.db.getPlanner(), input = { ...f.input, fragmentPolicy: 'split' }
  const result = await f.svc.apply(input), blocks = taskBlocks(f, f.long)
  assert.deepEqual(blocks.map(block => [block.start, block.end]), [['09:40', '10:00'], ['10:30', '10:55']])
  assert.equal(blocks[0].id, 'long')
  assert.match(blocks[1].id, /^horizon-part-[a-f0-9]{32}$/)
  assert.equal(blocks.reduce((sum, block) => sum + minutes(block), 0), 45)
  const group = f.input.groups.find(group => group.itemIds.includes('long'))
  assert.ok(blocks.every(block => block.horizonGroupId === group.id && block.horizonGroupTitle === '物理' && !('sourceId' in block)))
  assert.deepEqual(f.seen.contexts[0].items.map(item => item.minutes), [20, 25, 15])
  assert.equal(f.db.listOperations().length, 1)
  assert.equal(result.operation.undoable, true)
  assert.equal((await f.svc.apply(input)).replayed, true)
  assert.equal(f.seen.calls, 1)
  f.db.undoOperation(result.operation.id)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
  assert.ok((await f.svc.apply(input)).operation.undoneAt)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
})

test('when only fragments fit, offer split and cancel without pretending a whole session fits', async t => {
  const f = fixture(t, { onlyFragments: true }), before = f.db.getPlanner()
  const question = await f.svc.apply(f.input)
  assert.deepEqual(question.schedulingQuestion.options.map(option => option.value), ['split', 'cancel'])
  await assert.rejects(f.svc.apply({ ...f.input, fragmentPolicy: 'whole' }), /连续 45 分钟.*25 分钟/)
  assert.deepEqual(f.db.getPlanner(), before)
  await f.svc.apply({ ...f.input, fragmentPolicy: 'split' })
  assert.deepEqual(taskBlocks(f, f.long).map(block => [block.start, block.end]), [['09:40', '10:00'], ['10:50', '11:15']])
})

test('goal sessions stay complete even when splitting is explicitly requested', async t => {
  const f = fixture(t, { protectedTask: true })
  const result = await f.svc.apply({ ...f.input, fragmentPolicy: 'split' })
  assert.equal(result.schedulingQuestion, undefined)
  assert.equal(taskBlocks(f, f.long).length, 1)
  assert.equal(minutes(taskBlocks(f, f.long)[0]), 45)
  assert.equal(taskBlocks(f, f.long)[0].start, '10:30')
})

test('answering after a real calendar edit rejects the stale snapshot without any model call', async t => {
  const f = fixture(t)
  await f.svc.apply(f.input)
  f.act({ type: 'save-day-event', event: { id: 'new-class', title: '临时课', date: DATE, start: '11:30', end: '12:00', location: '', items: [] } })
  const before = f.db.getPlanner()
  await assert.rejects(f.svc.apply({ ...f.input, fragmentPolicy: 'split' }), /变化|重新读取/)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.equal(f.seen.calls, 0)
})

test('clock drift while awaiting the model refits fragments after now without losing minutes', async t => {
  const f = fixture(t)
  f.model(async () => { f.at('09:41'); return completion({ changes: [] }) })
  await f.svc.apply({ ...f.input, fragmentPolicy: 'split' })
  assert.deepEqual(taskBlocks(f, f.long).map(block => [block.start, block.end]), [['09:42', '10:00'], ['10:30', '10:57']])
  assert.equal(taskBlocks(f, f.long).reduce((sum, block) => sum + minutes(block), 0), 45)
})

test('a model change overlapping a fixed class cannot be saved or excused by clock drift', async t => {
  const f = fixture(t), before = f.db.getPlanner()
  f.model(async () => { f.at('09:41'); return completion({ changes: [{ index: 0, start: '09:50' }] }) })
  await assert.rejects(f.svc.apply({ ...f.input, fragmentPolicy: 'split' }), /重叠|空档/)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
})

test('a deadline prevents offering or saving fragments that would finish too late', async t => {
  const f = fixture(t)
  f.db.updateTask(f.long.id, { due: `${DATE}T10:45:00+08:00` })
  const snap = f.svc.list({ date: DATE }), before = f.db.getPlanner()
  const input = { ...f.input, snapshotKey: snap.snapshotKey, expectedRevision: snap.revision }
  await assert.rejects(f.svc.apply(input), /截止|DDL|空档/)
  await assert.rejects(f.svc.apply({ ...input, fragmentPolicy: 'split' }), /缺少|截止/)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.equal(f.seen.calls, 0)
})

test('an explicit split choice for tomorrow leaves elapsed placements on a full today untouched', async t => {
  const f = fixture(t), tomorrow = '2026-10-15'
  for (const [id, task, start, end] of [['tomorrow-long', f.long, '15:00', '15:45'], ['tomorrow-short', f.short, '14:00', '14:15']]) {
    f.act({ type: 'save-block', block: { id, taskId: task.id, date: tomorrow, start, end, locked: false } })
  }
  f.at('17:59')
  const snap = f.svc.list({ date: DATE }), before = f.db.getPlanner()
  const input = { date: DATE, expectedRevision: snap.revision, snapshotKey: snap.snapshotKey, requestId: randomUUID(), fragmentPolicy: 'split',
    groups: [...snap.groups.filter(group => group.day === 0), ...snap.groups.filter(group => group.day === 1).reverse()]
      .map(group => ({ id: group.id, day: group.day, itemIds: group.tasks.map(task => task.id) })) }
  const result = await f.svc.apply(input)
  assert.ok(result.operation)
  const placements = blocks => blocks.filter(block => block.date === DATE).map(({ id, taskId, date, start, end, locked }) => ({ id, taskId, date, start, end, locked }))
  assert.deepEqual(placements(f.db.getPlanner().blocks), placements(before.blocks))
  assert.equal(f.seen.calls, 1)
})

test('a shorter first item does not hide the need to ask about splitting the following item', async t => {
  const f = fixture(t, { firstShort: true })
  f.act({ type: 'save-block', block: { id: 'short', taskId: f.short.id, date: DATE, start: '15:00', end: '15:05', locked: false } })
  const snap = f.svc.list({ date: DATE }), before = f.db.getPlanner()
  const result = await f.svc.apply({ ...f.input, snapshotKey: snap.snapshotKey, expectedRevision: snap.revision })
  assert.equal(result.schedulingQuestion.sourceId, 'long')
  assert.match(result.schedulingQuestion.prompt, /先做 15 分钟/)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.equal(f.seen.calls, 0)
})
