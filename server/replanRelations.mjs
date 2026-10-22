import { dayCapacity, minuteOf, timeOf } from '../src/planner/model.ts'
import { localDay } from '../src/home/agenda.ts'
import { taskTimingBounds, timingViolation } from './taskTiming.mjs'
import { ValidationError } from './validation.mjs'
const stamp = block => new Date(`${block.date}T${block.start}:00`).getTime()
const boundaryKey = bounds => JSON.stringify([bounds.notBefore, bounds.notAfter, bounds.unresolved])

/** A calendar edit and its dependent movements form one transaction. Preserve
 * IDs/durations, locks and independent DDLs. A chain that cannot fit rejects
 * the edit with facts instead of silently leaving misleading preparation. */
export function replanRelatedTasks(before, after, tasks, now, explicitlyPlaced = new Set(), previousTasks = tasks) {
 const related = tasks.filter(task => !task.deletedAt && ['todo','doing'].includes(task.status) && task.relations?.length)
 if (!related.length) return after
 const pending = new Set(), processed = new Set()
 const changed = task => boundaryKey(taskTimingBounds(previousTasks.find(item=>item.id===task.id)??task,before,previousTasks)) !== boundaryKey(taskTimingBounds(task,after,tasks))
 for (const task of related) if (changed(task) && !explicitlyPlaced.has(task.id)) pending.add(task.id)
 for (let pass=0; pending.size && pass<=related.length; pass++) {
  const next = related.find(task => pending.has(task.id) && !task.relations.some(r => r.kind==='task' && pending.has(r.id)))
  if (!next) throw new ValidationError('关联事项存在循环，未保存本次改期',409)
  pending.delete(next.id); processed.add(next.id)
  const current = after.blocks.filter(block=>block.taskId===next.id)
  if (!current.length) continue
  const oldBounds = taskTimingBounds(previousTasks.find(item=>item.id===next.id)??next,before,previousTasks), bounds = taskTimingBounds(next,after,tasks)
  if (bounds.unresolved.length) throw new ValidationError(`${next.title}的关联对象时间未确定，未保存本次改期：${JSON.stringify(bounds.unresolved)}`,409)
  if (current.some(block=>block.locked || stamp(block)<now.getTime())) throw new ValidationError(`${next.title}已有锁定或已开始的时段，无法自动跟随改期；原安排未改`,409)
  const delta = Number.isFinite(bounds.notAfter) && Number.isFinite(oldBounds.notAfter) ? bounds.notAfter-oldBounds.notAfter
   : Number.isFinite(bounds.notBefore) && Number.isFinite(oldBounds.notBefore) ? bounds.notBefore-oldBounds.notBefore : 0
  after.blocks=after.blocks.filter(block=>block.taskId!==next.id)
  for (const old of current.sort((a,b)=>stamp(a)-stamp(b))) {
   const duration=minuteOf(old.end)-minuteOf(old.start)
   const preferred=new Date(stamp(old)+delta)
   const first=localDay(new Date(Math.max(now.getTime(),Number.isFinite(bounds.notBefore)?bounds.notBefore:preferred.getTime()-7*86400000)))
   let best, maxFreeMin=0
   for(let offset=0;offset<366 && best?.distance!==0;offset++) {
    const day=new Date(`${first}T12:00:00`);day.setDate(day.getDate()+offset);const date=localDay(day), zero=new Date(`${date}T00:00:00`).getTime()
    if(zero>=bounds.notAfter)break
    if(next.occurrence && date!==next.occurrence.date)continue
    if(next.startAt && date<next.startAt.slice(0,10))continue
    const due=next.due?new Date(next.due.length===10?`${next.due}T23:59:59.999`:next.due).getTime():Infinity
    if(zero>due)break
    for(const range of dayCapacity(after,tasks,date,now).remaining) {
     const start=Math.ceil(Math.max(range.start,(bounds.notBefore-zero)/60000)/5)*5
     const end=Math.floor(Math.min(range.end,(bounds.notAfter-zero)/60000,(due-zero)/60000))
     maxFreeMin=Math.max(maxFreeMin,end-start)
     if(end-start<duration)continue
     const desired=(preferred.getTime()-zero)/60000
     const at=Math.max(start,Math.min(end-duration,Math.round(desired/5)*5))
     const candidate={...old,date,start:timeOf(at),end:timeOf(at+duration)}
     const distance=Math.abs(stamp(candidate)-preferred.getTime())
     if(!best || distance<best.distance)best={candidate,distance}
    }
   }
   if(!best)throw new ValidationError(`${next.title}需要${duration}分钟，关联时间边界内最长可用${Math.max(0,maxFreeMin)}分钟；未保存本次改期，需调整范围、时长或锁定安排`,409)
   after.blocks.push(best.candidate)
  }
  for(const task of related) if(!processed.has(task.id)&&!explicitlyPlaced.has(task.id)&&changed(task))pending.add(task.id)
 }
 for(const task of related.filter(task=>processed.has(task.id)||explicitlyPlaced.has(task.id)))for(const block of after.blocks.filter(b=>b.taskId===task.id)) {
  if(timingViolation(task,block,after,tasks))throw new ValidationError(`${task.title}的先后关系仍冲突，未保存本次修改`,409)
 }
 return after
}
