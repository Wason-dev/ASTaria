import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { previewIcsTimetable, confirmIcsTimetable } from '../server/icsTimetableImport.mjs'

// Synthetic fixtures only. No user databases, files, models, or network.
process.env.TZ = 'Asia/Shanghai'
const calendar = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n')
const event = (extra = '', start = 'DTSTART:20261005T090000', end = 'DTEND:20261005T100000') => [
  'BEGIN:VEVENT', 'SUMMARY:物理', 'LOCATION:实验室', start, end, extra, 'END:VEVENT',
].filter(Boolean).join('\r\n')
const preview = (text = calendar(event()), timezone = 'Asia/Shanghai') => previewIcsTimetable({ text, timezone }).draft
const row = (patch = {}) => ({ id: randomUUID(), date: '2026-10-05', start: '10:00', end: '11:00', subject: '物理', location: '实验室', note: '', ...patch })
const only = rows => rows.map(({ date, start, end }) => ({ date, start, end }))
const status = expected => error => error.status === expected
function fixture(t) {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  const edit = action => db.updatePlanner(action, db.getPlanner().revision)
  const confirm = rows => confirmIcsTimetable(db, { rows, expectedRevision: db.getPlanner().revision })
  return { db, edit, confirm }
}
function unchanged(db, fn, expected) {
  const before = db.getPlanner(), operations = db.listOperations()
  assert.throws(fn, expected)
  assert.deepEqual(db.getPlanner(), before)
  assert.deepEqual(db.listOperations(), operations)
}

test('unfolds CRLF and LF, decodes escaped text, quoted TZID and preview-only notes', () => {
  const text = '\uFEFF' + calendar(event('DESCRIPTION:带好\\n笔记\\;复习\\,准备\\\\资料', 'DTSTART;TZID="Asia/Shanghai":20261005T090000', 'DTEND;TZID=Asia/Shanghai:20261005T100000'))
    .replace('SUMMARY:物理', 'SUMMARY:物\r\n 理\\,A\\;B\\\\C').replace('LOCATION:实验室', 'LOCATION:实验\n\t室:东侧')
  const result = preview(text)
  assert.equal(result.timezone, 'Asia/Shanghai')
  assert.equal(result.rows[0].subject, '物理,A;B\\C')
  assert.equal(result.rows[0].location, '实验室:东侧')
  assert.equal(result.rows[0].note, '带好\n笔记;复习,准备\\资料')
  assert.match(result.rows[0].id, /^[0-9a-f-]{36}$/u)
})

test('UTC events crossing UTC midnight retain the correct single local date', () => {
  const rows = preview(calendar(event('', 'DTSTART:20261004T233000Z', 'DTEND:20261005T003000Z'))).rows
  assert.deepEqual(only(rows), [{ date: '2026-10-05', start: '07:30', end: '08:30' }])
  assert.deepEqual(only(preview(calendar(event('', 'DTSTART:20260101T003000Z', 'DTEND:20260101T013000Z')), 'America/Los_Angeles').rows),
    [{ date: '2025-12-31', start: '16:30', end: '17:30' }])
})

test('floating values use the requested zone, independent of the host zone; half-hour offsets convert exactly', () => {
  assert.deepEqual(only(preview(calendar(event()), 'America/New_York').rows), [{ date: '2026-10-05', start: '09:00', end: '10:00' }])
  assert.deepEqual(only(preview(calendar(event('', 'DTSTART;TZID=Asia/Kolkata:20261005T090000', 'DTEND;TZID=Asia/Kolkata:20261005T100000')), 'UTC').rows),
    [{ date: '2026-10-05', start: '03:30', end: '04:30' }])
})

test('bounded weekly BYDAY COUNT counts DTSTART before applying multiple EXDATE values', () => {
  const text = calendar(event('RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5\r\nEXDATE:20261007T090000,20261014T090000\r\nEXDATE:20261012T090000'))
  assert.deepEqual(preview(text).rows.map(row => row.date), ['2026-10-05', '2026-10-19'])
})

test('INTERVAL=2 and explicit WKST keep a finite term, never creating weekly templates', () => {
  assert.deepEqual(preview(calendar(event('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=4'))).rows.map(row => row.date),
    ['2026-10-05', '2026-10-07', '2026-10-19', '2026-10-21'])
  assert.deepEqual(preview(calendar(event('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=SU;COUNT=4', 'DTSTART:20261004T090000', 'DTEND:20261004T100000'))).rows.map(row => row.date),
    ['2026-10-04', '2026-10-05', '2026-10-18', '2026-10-19'])
})

test('UNTIL is inclusive, supports second precision boundaries, and applies TZID EXDATE', () => {
  const start = 'DTSTART;TZID=Asia/Shanghai:20261005T090000', end = 'DTEND;TZID=Asia/Shanghai:20261005T100000'
  const exact = preview(calendar(event('RRULE:FREQ=WEEKLY;UNTIL=20261019T010000Z\r\nEXDATE;TZID=Asia/Shanghai:20261012T090000', start, end)))
  assert.deepEqual(exact.rows.map(row => row.date), ['2026-10-05', '2026-10-19'])
  const before = preview(calendar(event('RRULE:FREQ=WEEKLY;UNTIL=20261019T005959Z', start, end)))
  assert.deepEqual(before.rows.map(row => row.date), ['2026-10-05', '2026-10-12'])
  assert.equal(preview(calendar(event('RRULE:FREQ=WEEKLY;UNTIL=20261005T090000'))).rows.length, 1)
})

test('weekly local clocks stay at 09:00 across DST while their UTC clock changes', () => {
  const text = calendar(event('RRULE:FREQ=WEEKLY;COUNT=3', 'DTSTART;TZID=America/New_York:20260301T090000', 'DTEND;TZID=America/New_York:20260301T100000'))
  assert.deepEqual(only(preview(text, 'UTC').rows), [
    { date: '2026-03-01', start: '14:00', end: '15:00' },
    { date: '2026-03-08', start: '13:00', end: '14:00' },
    { date: '2026-03-15', start: '13:00', end: '14:00' },
  ])
})

test('DTEND recurrence preserves elapsed duration even when an occurrence crosses DST', () => {
  const text = calendar(event('RRULE:FREQ=WEEKLY;COUNT=2', 'DTSTART;TZID=America/New_York:20260301T003000', 'DTEND;TZID=America/New_York:20260301T033000'))
  assert.deepEqual(only(preview(text, 'America/New_York').rows), [
    { date: '2026-03-01', start: '00:30', end: '03:30' },
    { date: '2026-03-08', start: '00:30', end: '04:30' },
  ])
})

test('source gaps/overlaps, target overlaps, half-hour DST and skipped dates fail explicitly', () => {
  for (const [zone, day, start, end] of [
    ['America/New_York', '20260308', '023000', '033000'],
    ['America/New_York', '20261101', '013000', '023000'],
    ['Australia/Lord_Howe', '20261004', '021500', '030000'],
    ['Australia/Lord_Howe', '20260405', '014500', '030000'],
    ['Pacific/Apia', '20111230', '090000', '100000'],
  ]) assert.throws(() => preview(calendar(event('', `DTSTART;TZID=${zone}:${day}T${start}`, `DTEND;TZID=${zone}:${day}T${end}`)), 'UTC'), /歧义|不存在/u)
  assert.throws(() => preview(calendar(event('', 'DTSTART:20261101T053000Z', 'DTEND:20261101T070000Z')), 'America/New_York'), /歧义/u)
  assert.throws(() => preview(calendar(event('RRULE:FREQ=WEEKLY;COUNT=2', 'DTSTART;TZID=America/New_York:20260301T023000', 'DTEND;TZID=America/New_York:20260301T033000')), 'UTC'), /不存在/u)
})

test('rejects all-day, missing DTEND, cross-day, sub-minute and malformed times rather than inventing occupancy', () => {
  for (const [from, to, message] of [
    ['DTSTART;VALUE=DATE:20261005', 'DTEND;VALUE=DATE:20261006', /全天/u],
    ['DTSTART:20261005T090000', '', /DTEND/u],
    ['DTSTART:20261005T230000', 'DTEND:20261006T010000', /跨日/u],
    ['DTSTART:20261005T150000Z', 'DTEND:20261005T170000Z', /跨日/u],
    ['DTSTART:20261005T090001', 'DTEND:20261005T100000', /分钟/u],
    ['DTSTART:20260230T090000', 'DTEND:20260230T100000', /不存在/u],
    ['DTSTART:20261005T250000', 'DTEND:20261005T260000', /超出/u],
    ['DTSTART:20261005T100000', 'DTEND:20261005T090000', /结束/u],
  ]) assert.throws(() => preview(calendar(event('', from, to))), message)
})

test('rejects unsupported/infinite recurrence and exception mechanisms for the whole input', () => {
  const rules = [
    'RRULE:FREQ=WEEKLY', 'RRULE:FREQ=DAILY;COUNT=2', 'RRULE:FREQ=MONTHLY;COUNT=2',
    'RRULE:FREQ=WEEKLY;INTERVAL=3;COUNT=2', 'RRULE:FREQ=WEEKLY;BYDAY=1MO;COUNT=2',
    'RRULE:FREQ=WEEKLY;COUNT=2;BYHOUR=9', 'RRULE:FREQ=WEEKLY;COUNT=2;BYSETPOS=1',
    'RRULE:FREQ=WEEKLY;COUNT=2;UNTIL=20261201T090000', 'RRULE:FREQ=WEEKLY;COUNT=2;COUNT=3',
    'RRULE:FREQ=WEEKLY;COUNT=0', 'RRULE:FREQ=WEEKLY;COUNT=2;BYDAY=TU',
    'RRULE:FREQ=WEEKLY;COUNT=2;BYDAY=MO,MO', 'RRULE:FREQ=WEEKLY;UNTIL=20260101T090000',
    'RDATE:20261012T090000', 'RECURRENCE-ID:20261005T090000', 'EXRULE:FREQ=WEEKLY;COUNT=2', 'DURATION:PT1H',
  ]
  for (const extra of rules) assert.throws(() => preview(calendar(event(), event(extra))), { name: 'ValidationError' }, extra)
  assert.throws(() => preview(calendar(event('RRULE:FREQ=WEEKLY;UNTIL=20261012T090000Z'))), /浮动/u)
  assert.throws(() => preview(calendar(event('EXDATE;TZID=UTC:20261005T090000'))), /EXDATE/u)
  assert.throws(() => preview(calendar(event('RRULE:FREQ=WEEKLY;COUNT=2', 'DTSTART:20261005T090000Z', 'DTEND;TZID=UTC:20261005T100000'))), /同一种/u)
})

test('invalid timezone, unsupported custom timezone, cancelled messages, invalid escape and duplicate properties fail', () => {
  for (const zone of [undefined, '', 'Mars/School', '+08:00', {}, 8]) assert.throws(() => previewIcsTimetable({ text: calendar(event()), timezone: zone }), status(400))
  assert.throws(() => preview(calendar('BEGIN:VTIMEZONE\r\nTZID:Asia/Shanghai\r\nEND:VTIMEZONE', event())), /VTIMEZONE/u)
  assert.throws(() => preview(calendar(event('STATUS:CANCELLED'))), /取消/u)
  assert.throws(() => preview(calendar(event()).replace('VERSION:2.0', 'VERSION:2.0\r\nMETHOD:CANCEL')), /取消/u)
  assert.throws(() => preview(calendar(event('SUMMARY:第二个'))), /SUMMARY/u)
  assert.throws(() => preview(calendar(event('DTSTART:20261005T090000'))), /DTSTART/u)
  assert.throws(() => preview(calendar(event()).replace('SUMMARY:物理', 'SUMMARY:bad\\q')), /转义/u)
  assert.throws(() => preview(calendar(event('UID:same'), event('UID:same'))), /UID/u)
  for (const text of ['', 'SUMMARY:物理', calendar(event()).replace('END:VEVENT', 'END:VTODO'), calendar(event()).replace('VERSION:2.0\r\n', ''), calendar(event()) + '\r\n' + calendar(event())]) assert.throws(() => preview(text), status(400))
})

test('limits raw UTF-8 bytes to 1 MiB; exactly 1000 occurrences succeed, 1001 and excessive aggregate expansion fail', () => {
  assert.throws(() => preview(calendar(event('DESCRIPTION:' + '中'.repeat(350_000)))), status(413))
  const result = preview(calendar(...Array.from({ length: 1000 }, () => event())))
  assert.equal(result.rows.length, 1000)
  assert.equal(new Set(result.rows.map(row => row.id)).size, 1000)
  assert.throws(() => preview(calendar(...Array.from({ length: 1001 }, () => event()))), status(413))
  assert.throws(() => preview(calendar(event('RRULE:FREQ=WEEKLY;COUNT=1001'))), status(413))
  assert.throws(() => preview(calendar(...Array.from({ length: 21 }, () => event('RRULE:FREQ=WEEKLY;COUNT=50')))), status(413))
})

test('366 inclusive dates are accepted; recurrence, UNTIL and global spans beyond that fail without truncation', () => {
  assert.equal(preview(calendar(event('', 'DTSTART:20260101T090000', 'DTEND:20260101T100000'), event('', 'DTSTART:20270101T090000', 'DTEND:20270101T100000'))).rows.length, 2)
  assert.throws(() => preview(calendar(event('', 'DTSTART:20260101T090000', 'DTEND:20260101T100000'), event('', 'DTSTART:20270102T090000', 'DTEND:20270102T100000'))), status(413))
  assert.equal(preview(calendar(event('RRULE:FREQ=WEEKLY;COUNT=53'))).rows.length, 53)
  assert.throws(() => preview(calendar(event('RRULE:FREQ=WEEKLY;COUNT=54'))), status(413))
  assert.throws(() => preview(calendar(event('RRULE:FREQ=WEEKLY;UNTIL=20271006T090000'))), status(413))
  assert.throws(() => preview(calendar(event('EXDATE:20261005T090000'))), /没有可导入/u)
})

test('preview does not fetch URL/ATTACH or write; VALARM metadata does not affect event timing', t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected network') })
  assert.equal(preview(calendar(event('URL:https://invalid.example/class\r\nATTACH:https://invalid.example/private\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT10M\r\nDESCRIPTION:提醒\r\nEND:VALARM'))).rows.length, 1)
  assert.equal(globalThis.fetch.mock.callCount(), 0)
})

test('real SQLite import preserves existing arrangements, advances each revision, issues real receipt and atomically undoes', t => {
  const { db, edit, confirm } = fixture(t)
  edit({ type: 'save-day-event', event: { id: randomUUID(), title: '已有活动', date: '2026-10-05', start: '08:00', end: '09:00', location: '', items: ['水杯'] } })
  const before = db.getPlanner(), tasks = db.listTasks()
  const rows = [row({ note: '这不是携带清单' }), row({ start: '11:00', end: '12:00', subject: '数学' })]
  const result = confirm(rows)
  assert.equal(result.importedCount, 2)
  assert.equal(result.state.revision, before.revision + 2)
  assert.deepEqual(result.state.dayEvents.slice(0, 1), before.dayEvents)
  assert.deepEqual(result.state.routines, before.routines)
  assert.deepEqual(db.listTasks(), tasks)
  for (const [index, id] of result.importedIds.entries()) {
    assert.notEqual(id, rows[index].id)
    assert.match(id, /^[0-9a-f-]{36}$/u)
    assert.equal(result.state.dayEvents.find(event => event.id === id).title, rows[index].subject)
    assert.deepEqual(result.state.dayEvents.find(event => event.id === id).items, [])
  }
  assert.equal(result.operation.kind, 'planner')
  assert.equal(result.operation.undoable, true)
  assert.equal(db.listOperations().find(operation => operation.id === result.operation.id).plannerAfterRevision, result.state.revision)
  const undone = db.undoOperation(result.operation.id)
  assert.ok(undone.undoneAt)
  const restored = db.getPlanner()
  assert.deepEqual({ ...restored, revision: before.revision }, before)
  assert.equal(restored.revision, result.state.revision + 1)
  db.undoOperation(result.operation.id)
  assert.deepEqual(db.getPlanner(), restored)
})

test('weekly ICS saves only dated events and a real undo receipt', t => {
  const { db, confirm } = fixture(t)
  const before = db.getPlanner()
  const rows = preview(calendar(event('RRULE:FREQ=WEEKLY;COUNT=3'))).rows
  const result = confirm(rows)
  assert.deepEqual(result.state.routines, before.routines)
  assert.deepEqual(result.state.dayEvents.map(event => event.date), ['2026-10-05', '2026-10-12', '2026-10-19'])
  assert.equal(result.state.timetableConfirmed, before.timetableConfirmed)
})

test('existing duplicate, same-batch duplicate/overlap fail and adjacency succeeds', t => {
  const { db, confirm } = fixture(t)
  confirm([row()])
  unchanged(db, () => confirm([row()]), status(409))
  unchanged(db, () => confirm([row({ start: '10:30', end: '11:30' })]), status(409))
  unchanged(db, () => confirm([row({ start: '12:00', end: '13:00' }), row({ start: '12:30', end: '13:30' })]), status(409))
  unchanged(db, () => confirm([row({ start: '12:00', end: '13:00' }), row({ start: '12:00', end: '13:00' })]), status(409))
  assert.equal(confirm([row({ start: '09:00', end: '10:00' }), row({ start: '11:00', end: '12:00' })]).importedCount, 2)
})

test('fixed courses, dated overrides, task blocks and legacy timed tasks are conflict checked without replacing them', t => {
  const { db, edit, confirm } = fixture(t)
  const routine = { id: randomUUID(), title: '固定课', kind: 'class', weekdays: [1], start: '09:00', end: '10:00', location: '', items: [], enabled: true }
  edit({ type: 'save-routine', routine })
  unchanged(db, () => confirm([row({ start: '09:30', end: '10:30' })]), status(409))
  edit({ type: 'set-day-template', date: '2026-10-09', sourceWeekday: 1 })
  unchanged(db, () => confirm([row({ date: '2026-10-09', start: '09:00', end: '10:00' })]), status(409))
  const task = db.createTask({ title: '已锁定的任务' })
  edit({ type: 'save-block', block: { id: randomUUID(), taskId: task.id, date: '2026-10-05', start: '12:00', end: '13:00', locked: true } })
  unchanged(db, () => confirm([row({ start: '12:15', end: '12:45' })]), status(409))
  db.createTask({ title: '旧版定时任务', startAt: '2026-10-05T14:00:00+08:00', estimateMin: 60 })
  unchanged(db, () => confirm([row({ start: '14:15', end: '14:45' })]), status(409))
  assert.equal(confirm([row({ start: '18:00', end: '19:00' })]).importedCount, 1) // Availability is not fixed occupancy.
})

test('revision race rejects the whole import and preserves the competing edit', t => {
  const { db, edit } = fixture(t)
  const expectedRevision = db.getPlanner().revision
  let latest
  const racingDb = { ...db, transaction(fn) {
    edit({ type: 'save-day-event', event: { id: randomUUID(), title: '另一个窗口', date: '2026-10-05', start: '15:00', end: '16:00', location: '', items: [] } })
    latest = db.getPlanner()
    return db.transaction(fn)
  } }
  assert.throws(() => confirmIcsTimetable(racingDb, { rows: [row()], expectedRevision }), status(409))
  assert.deepEqual(db.getPlanner(), latest)
  assert.equal(db.listOperations().length, 0)
})

test('edited inputs are independently validated; malformed rows and 1001 rows do not write', t => {
  const { db, confirm } = fixture(t)
  for (const patch of [
    { date: '2026-02-30' }, { start: '10:00:00' }, { end: '24:00' }, { end: '09:00' },
    { subject: ' ' }, { location: 'x'.repeat(161) }, { note: 'x'.repeat(4001) }, { surprise: true },
  ]) unchanged(db, () => confirm([row(patch)]), status(400))
  unchanged(db, () => confirm([]), status(400))
  unchanged(db, () => confirm(Array.from({ length: 1001 }, () => row())), status(413))
  const same = row()
  unchanged(db, () => confirm([same, same]), status(400))
  unchanged(db, () => confirm([row({ date: '2026-01-01' }), row({ date: '2027-01-02' })]), status(413))
  for (const expectedRevision of [undefined, -1, '0', Number.MAX_SAFE_INTEGER + 1]) unchanged(db, () => confirmIcsTimetable(db, { rows: [row()], expectedRevision }), status(400))
})

test('edited DST gap/overlap clocks cannot bypass preview validation', t => {
  const { db, confirm } = fixture(t)
  const previous = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    unchanged(db, () => confirm([row({ date: '2026-03-08', start: '02:15', end: '03:30' })]), /不存在/u)
    unchanged(db, () => confirm([row({ date: '2026-11-01', start: '01:15', end: '02:30' })]), /歧义/u)
  } finally { process.env.TZ = previous }
})

test('exactly 1000 selected rows use the real chunked helper and persist every returned UUID', t => {
  const { db, confirm } = fixture(t)
  const clocks = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  const rows = Array.from({ length: 1000 }, (_, index) => row({ start: clocks(420 + index), end: clocks(421 + index) }))
  const before = db.getPlanner().revision
  const result = confirm(rows)
  assert.equal(result.state.revision, before + 1000)
  assert.equal(result.importedCount, 1000)
  assert.equal(new Set(result.importedIds).size, 1000)
  assert.ok(result.importedIds.every(id => result.state.dayEvents.some(event => event.id === id)))
  db.undoOperation(result.operation.id)
  assert.equal(db.getPlanner().dayEvents.length, 0)
})

test('real receipt helper failure after 128 writes rolls back every event and receipt', t => {
  const { db } = fixture(t)
  const apply = db.applyCalendarImport
  const clocks = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  const rows = Array.from({ length: 129 }, (_, index) => row({ start: clocks(540 + index), end: clocks(541 + index) }))
  db.applyCalendarImport = (events, revision) => apply(events.map((event, index) => index === 128 ? { ...event, title: '' } : event), revision)
  unchanged(db, () => confirmIcsTimetable(db, { rows, expectedRevision: db.getPlanner().revision }), status(400))
})

test('outer transaction rolls back a committed helper savepoint and receipt if post-save validation fails', t => {
  const { db, confirm } = fixture(t)
  const apply = db.applyCalendarImport
  db.applyCalendarImport = (events, revision) => {
    const result = apply(events, revision)
    db.updatePlanner({ type: 'delete-day-event', id: events[0].id }, result.state.revision)
    return result
  }
  unchanged(db, () => confirm([row()]), status(409))
})

test('missing/non-undoable helper never falls back to an unreceipted write', t => {
  const { db, confirm } = fixture(t)
  const apply = db.applyCalendarImport
  db.applyCalendarImport = undefined
  unchanged(db, () => confirm([row()]), status(503))
  db.applyCalendarImport = (events, revision) => {
    const result = apply(events, revision)
    return { ...result, operation: { ...result.operation, undoable: false } }
  }
  unchanged(db, () => confirm([row()]), status(409))
})

test('later edits make undo conflict instead of removing newer arrangements', t => {
  const { db, confirm } = fixture(t)
  const imported = confirm([row()])
  confirm([row({ start: '12:00', end: '13:00' })])
  unchanged(db, () => db.undoOperation(imported.operation.id), status(409))
})

test('real SQLite capacity permits 3000 existing events total and rejects 3001 before any new write', t => {
  const { db, confirm } = fixture(t)
  for (let batch = 0; batch < 3; batch++) {
    db.applyCalendarImport(Array.from({ length: batch === 2 ? 999 : 1000 }, () => ({ id: randomUUID(), title: '合成历史记录', date: '2026-10-01', start: '07:00', end: '08:00', location: '', items: [] })), db.getPlanner().revision)
  }
  assert.equal(confirm([row()]).importedCount, 1)
  assert.equal(db.getPlanner().dayEvents.length, 3000)
  unchanged(db, () => confirm([row()]), status(413))
})
