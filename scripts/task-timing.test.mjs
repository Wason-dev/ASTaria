import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '../server/database.mjs'
import { taskTimingBounds, timingViolation } from '../server/taskTiming.mjs'
process.env.TZ = 'Asia/Shanghai'
const date = '2026-10-23'
const exam = { id: 'physics-exam', title: '物理考试', date, start: '13:00', end: '14:00', location: '', items: [] }
const block = (taskId, start, end, id = 'review-block') => ({ id, taskId, date, start, end, locked: false })

test('preparation remains linked to the exam identity and resolves its current start, independently from due', t => {
 const db = createDatabase(':memory:'); t.after(() => db.close())
 const task = db.createTask({ title: '物理复习', due: date, relations: [{ relation: 'before', kind: 'event', id: exam.id, date }] })
 const state = { ...db.getPlanner(), dayEvents: [exam] }
 assert.equal(taskTimingBounds(task, state, [task]).notAfter, Date.parse(date + 'T13:00:00+08:00'))
 assert.equal(timingViolation(task, block(task.id, '12:00', '12:30'), state, [task]), null)
 assert.equal(timingViolation(task, block(task.id, '15:00', '15:30'), state, [task]).cause, 'relationship_time_conflict')
 const moved = { ...state, dayEvents: [{ ...exam, start: '10:00', end: '11:00' }] }
 assert.equal(taskTimingBounds(task, moved, [task]).notAfter, Date.parse(date + 'T10:00:00+08:00'))
 assert.equal(timingViolation(task, block(task.id, '12:00', '12:30'), moved, [task]).cause, 'relationship_time_conflict')
 assert.equal(task.due, date, 'absolute DDL is not rewritten to imitate a dependency')
})
test('after a predecessor uses its actual end; unknown time and cyclic relationships cannot silently schedule', () => {
 const base = { status: 'todo', deletedAt: null }
 const a = { ...base, id: 'a', title: '整理资料' }
 const b = { ...base, id: 'b', title: '制作演示', relations: [{ relation: 'after', kind: 'task', id: 'a' }] }
 const state = { routines: [], dayEvents: [], blocks: [block('a', '09:00', '10:00')] }
 assert.equal(taskTimingBounds(b, state, [a,b]).notBefore, Date.parse(date + 'T10:00:00+08:00'))
 assert.ok(timingViolation(b, block('b', '09:30', '10:00'), state, [a,b]))
 assert.equal(timingViolation(b, block('b', '10:00', '11:00'), state, [a,b]), null)
 assert.ok(taskTimingBounds(b, { ...state, blocks: [] }, [a,b]).unresolved.length)
 a.relations = [{ relation: 'after', kind: 'task', id: 'b' }]
 assert.equal(taskTimingBounds(b, state, [a,b]).unresolved[0].cause, 'relationship_cycle')
})
test('relations survive database backup and restore and malformed identities are rejected', t => {
 const source = createDatabase(':memory:'), target = createDatabase(':memory:'); t.after(() => { source.close(); target.close() })
 const task = source.createTask({ title:'准备会议材料', relations:[{relation:'before',kind:'event',id:'meeting',date}] })
 target.importData(source.exportData())
 assert.deepEqual(target.getTask(task.id).relations, task.relations)
 assert.throws(() => source.updateTask(task.id,{relations:[{relation:'whenever',kind:'event',id:'meeting',date}]}))
})

test('exam rescheduling moves preparation and its downstream task atomically, retains IDs, and undo restores the chain', t => {
 const db=createDatabase(':memory:');t.after(()=>db.close())
 const date='2030-01-23', nextDate='2030-01-24'
 const update=action=>db.updatePlanner(action,db.getPlanner().revision)
 update({type:'save-routine',routine:{id:'wide-study',title:'自习',kind:'available',weekdays:[0,1,2,3,4,5,6],start:'08:00',end:'22:00',items:[],location:'',enabled:true}})
 const event={...exam,date};update({type:'save-day-event',event})
 const prep=db.createTask({title:'复习',estimateMin:30,relations:[{relation:'before',kind:'event',id:event.id,date}]})
 update({type:'save-block',block:{id:'prep',taskId:prep.id,date,start:'12:00',end:'12:30',locked:false}})
 const follow=db.createTask({title:'复习后整理材料',estimateMin:15,relations:[{relation:'after',kind:'task',id:prep.id}]})
 update({type:'save-block',block:{id:'follow',taskId:follow.id,date,start:'12:30',end:'12:45',locked:false}})
 const before=db.getPlanner()
 const operation=db.applyPlannerOperation({id:'move-exam',requestId:crypto.randomUUID(),summary:'调整考试',expectedRevision:before.revision,actions:[{type:'save-day-event',event:{...event,date:nextDate,start:'10:00',end:'11:00'}}]})
 assert.deepEqual(db.getPlanner().blocks.filter(b=>['prep','follow'].includes(b.id)).map(b=>[b.id,b.date,b.start,b.end]),[['prep',nextDate,'09:00','09:30'],['follow',nextDate,'09:30','09:45']])
 assert.deepEqual(operation.planChanges.map(c=>c.id).sort(),['follow','prep'])
 db.undoOperation(operation.id)
 assert.deepEqual(db.getPlanner().blocks,before.blocks)
 assert.deepEqual(db.getPlanner().dayEvents,before.dayEvents)
})

test('a locked dependent rejects the whole event edit and preserves original timing', t => {
 const db=createDatabase(':memory:');t.after(()=>db.close());const date='2030-01-23'
 const event={...exam,date};db.updatePlanner({type:'save-day-event',event},db.getPlanner().revision)
 const task=db.createTask({title:'考前准备',relations:[{relation:'before',kind:'event',id:event.id,date}]})
 db.updatePlanner({type:'save-block',block:{id:'locked-prep',taskId:task.id,date,start:'12:00',end:'12:30',locked:true}},db.getPlanner().revision)
 const before=db.getPlanner()
 assert.throws(()=>db.updatePlanner({type:'save-day-event',event:{...event,start:'10:00',end:'11:00'}},before.revision),/锁定/)
 assert.deepEqual(db.getPlanner(),before)
})

test('adding a real relationship to existing work repositions its saved block, rather than only attaching metadata', t => {
 const db=createDatabase(':memory:');t.after(()=>db.close());const date='2030-01-23'
 const update=action=>db.updatePlanner(action,db.getPlanner().revision)
 update({type:'save-routine',routine:{id:'study',title:'自习',kind:'available',weekdays:[0,1,2,3,4,5,6],start:'08:00',end:'22:00',items:[],location:'',enabled:true}})
 update({type:'save-day-event',event:{...exam,date}})
 const task=db.createTask({title:'复习',kind:'task',estimateMin:30})
 update({type:'save-block',block:{id:'late-review',taskId:task.id,date,start:'15:00',end:'15:30',locked:false}})
 db.updateTask(task.id,{relations:[{relation:'before',kind:'event',id:exam.id,date}]})
 const shifted=db.getPlanner().blocks.find(b=>b.id==='late-review')
 assert.equal(shifted.taskId,task.id);assert.equal(shifted.end,'13:00')
 assert.equal(shifted.start,'12:30')
})

test('undoing an assistant relationship edit restores the prior task and placement together', t => {
 const db=createDatabase(':memory:');t.after(()=>db.close());const date='2030-01-23'
 const update=action=>db.updatePlanner(action,db.getPlanner().revision)
 update({type:'save-routine',routine:{id:'study',title:'自习',kind:'available',weekdays:[0,1,2,3,4,5,6],start:'08:00',end:'22:00',items:[],location:'',enabled:true}})
 update({type:'save-day-event',event:{...exam,date}})
 const before=db.createTask({title:'复习',kind:'task',estimateMin:30})
 update({type:'save-block',block:{id:'old-review',taskId:before.id,date,start:'15:00',end:'15:30',locked:false}})
 const original=db.getPlanner()
 const after={...before,relations:[{relation:'before',kind:'event',id:exam.id,date}]}
 const op=db.applyOperation({id:'relate-review',requestId:crypto.randomUUID(),summary:'关联考前复习',changes:[{table:'tasks',id:before.id,before,after}]})
 assert.equal(db.getPlanner().blocks.find(b=>b.id==='old-review').end,'13:00')
 db.undoOperation(op.id)
 assert.equal(db.getTask(before.id).relations,undefined)
 assert.deepEqual(db.getPlanner().blocks,original.blocks)
})
