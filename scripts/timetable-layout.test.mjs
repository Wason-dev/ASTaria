import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const root = new URL('../src/', import.meta.url).href
const resolution = registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.startsWith(root) && specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/u.test(specifier) ? `${specifier}.ts` : specifier, context)
} })
const { visibleTimetableRoutines, timetableTimeScale, routinesForDay, dayCapacity, minuteOf } = await import('../src/planner/model.ts')
resolution.deregister()
const routine = (id, kind, start, end, weekdays = [4]) => ({ id, title:id, kind, start, end, weekdays, enabled:true, location:'508', items:[] })
const state = routines => ({ revision:1, timetableConfirmed:true, routines, blocks:[], details:{}, checked:{} })

process.env.TZ = 'Asia/Shanghai'
test('new double lesson hides both old empty-period frames without destroying shared weekly availability', () => {
  const source = state([
    routine('free1','available','15:00','15:40',[3,4]),
    routine('free2','available','15:45','16:25',[3,4]),
    routine('biology','class','15:00','16:25'),
  ])
  const before = structuredClone(source)
  const thursday = routinesForDay(source, '2026-09-24')
  assert.deepEqual(visibleTimetableRoutines(thursday).map(item => item.id), ['biology'])
  assert.equal(dayCapacity(source, [], '2026-09-24', new Date('2026-09-19T12:00:00+08:00')).totalMin, 0)
  assert.equal(visibleTimetableRoutines(routinesForDay(source, '2026-09-23')).length, 2)
  assert.deepEqual(source, before)
  source.routines = source.routines.filter(item => item.id !== 'biology')
  assert.equal(visibleTimetableRoutines(routinesForDay(source, '2026-09-24')).length, 2)
})

test('partial occupancy leaves only true free portions with editable source IDs', () => {
  const source = [routine('free','available','09:00','12:00'), routine('lesson','class','09:20','10:10'), routine('break','break','10:00','10:30')]
  const before = structuredClone(source)
  assert.deepEqual(visibleTimetableRoutines(source).filter(item => item.kind === 'available').map(({id,start,end}) => ({id,start,end})), [
    {id:'free',start:'09:00',end:'09:20'}, {id:'free',start:'10:30',end:'12:00'},
  ])
  assert.deepEqual(source, before)
})

test('ten-minute morning meeting and five-minute adjacent task get complete title rows without overlap', () => {
  const scale = timetableTimeScale(420, 1320, [{start:460,end:470}, {start:470,end:475}, {start:480,end:520}])
  assert.ok(scale.position(470)-scale.position(460) >= 28-1e-7)
  assert.ok(scale.position(475)-scale.position(470) >= 28-1e-7)
  assert.ok(scale.position(480)-scale.position(475) >= 8-1e-7)
  assert.ok(scale.position(520)-scale.position(480) >= 64-1e-7)
  for (let minute=420;minute<1320;minute++) assert.ok(scale.position(minute+1)>scale.position(minute))
  assert.equal(scale.position(420),0)
  assert.equal(scale.position(1320),scale.height)
  assert.ok(Math.abs(scale.position(462.5)-(scale.position(462)+scale.position(463))/2)<1e-7)
})

test('same clock time maps to the same cross-column position regardless of event order', () => {
  const intervals = [{start:460,end:470},{start:465,end:480},{start:480,end:520},{start:900,end:985}]
  const one = timetableTimeScale(420,1320,intervals), two = timetableTimeScale(420,1320,[...intervals].reverse())
  for (const time of ['07:40','07:45','07:50','08:00','08:40','15:00','16:25','22:00']) assert.equal(one.position(minuteOf(time)), two.position(minuteOf(time)))
  assert.equal(one.position(0),0)
  assert.equal(one.position(1440),one.height)
})
