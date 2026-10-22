import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'
import { publicOperations } from '../server/operationReceipts.mjs'
import { currentSchedulingExplanations } from '../server/receiptExplanations.mjs'
import { initialTaskSchedule } from '../server/autoSchedule.mjs'
process.env.TZ='Asia/Shanghai'
const DATE='2030-01-23', NOW=new Date(DATE+'T08:00:00+08:00')
const tool=(name,args)=>({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]})
const last=request=>JSON.parse(request.messages.findLast(message=>message.role==='tool').content)
const input=()=>({requestId:randomUUID(),conversationId:'main',text:'下午一点物理考试，上午复习半小时',context:{timezone:'Asia/Shanghai',date:DATE,page:'home'}})
function setup(t){const db=createDatabase(':memory:');t.after(()=>db.close());const update=action=>db.updatePlanner(action,db.getPlanner().revision)
 update({type:'save-routine',routine:{id:'morning',title:'上午自习',kind:'available',weekdays:[0,1,2,3,4,5,6],start:'09:00',end:'12:00',enabled:true,items:[],location:''}})
 update({type:'save-day-event',event:{id:'exam',title:'物理考试',date:DATE,start:'13:00',end:'14:00',items:[],location:''}})
 return db}

test('same completion round returns natural receipt explanations to home and workbench, with no extra model request',async t=>{
 const db=setup(t), requests=[];let time=NOW
 const reason='物理考试一点开始，我把半小时复习放在上午自习，留在考试前完成。'
 const xixi=createXixi({db,now:()=>time,complete:async request=>{
  requests.push(request)
  if(requests.length===1){time=new Date(DATE+'T08:05:00+08:00');return tool('create_tasks',{tasks:[{title:'物理复习',estimateMin:30,scheduleDate:DATE,relations:[{relation:'before',kind:'event',id:'exam',date:DATE}]}]})}
  assert.equal(request.tool_choice,'required')
  const clock=JSON.parse(request.messages.find(m=>m.role==='system'&&m.content.startsWith('本机实时钟表')).content.split('\n')[1]);assert.equal(clock.localMinute,'08:05')
  const result=last(request);assert.equal(result.scheduling.evidence[0].relations[0].id,'exam')
  assert.ok(result.scheduling.savedPlans.every(block=>block.end<='13:00'))
  return tool('finish_response',{content:'复习已经留在考前了。',receiptNotes:[{operationId:result.operation.id,text:reason}]})
 }})
 const request=input(), result=await xixi.chat(request)
 assert.equal(result.status,'completed');assert.equal(requests.length,2)
 assert.equal(result.messages.at(-1).content,'复习已经留在考前了。')
 assert.deepEqual(publicOperations(db.listOperations(),db)[0].explanations,[reason])
 const task=db.listTasks().find(t=>t.title==='物理复习')
 assert.deepEqual(currentSchedulingExplanations(db)[task.id],[reason])
 const restored=createDatabase(':memory:');t.after(()=>restored.close());restored.importData(db.exportData())
 assert.ok(publicOperations(restored.listOperations(),restored).some(operation=>operation.explanations?.includes(reason)))
 await xixi.chat(request);assert.equal(requests.length,2,'retry never regenerates the note or duplicates a mutation')
 db.undoOperation(publicOperations(db.listOperations(),db)[0].id)
 assert.equal(publicOperations(db.listOperations(),db)[0].explanations,undefined)
 restored.updateTask(task.id,{estimateMin:45})
 assert.equal(currentSchedulingExplanations(restored)[task.id],undefined,'stale reasoning is not a current workbench suggestion')
})

test('a full requested window triggers the real planner read in the tool layer without a separate model round',async t=>{
 const db=setup(t), requests=[]
 const xixi=createXixi({db,now:()=>NOW,complete:async request=>{
  requests.push(request)
  if(requests.length===1)return tool('create_tasks',{tasks:[{title:'复习',estimateMin:45,scheduleDate:DATE,scheduleWindow:'不存在的窗口'}]})
  const result=last(request)
  assert.equal(result.scheduling.unscheduled.length,1)
  assert.equal(result.scheduling.plannerReview.complete,true)
  assert.equal(result.scheduling.plannerReview.reads[0].type,'planner_read')
  assert.equal(result.scheduling.plannerReview.reads[0].revision,db.getPlanner().revision)
  return tool('ask_user',{prompt:'你指定的窗口没有记录。可以用上午自习，还是先补充窗口时间？',options:['用上午自习','补充窗口时间'],receiptNotes:[{operationId:result.operation.id,text:'事项先记下了；课表里没有你指定的窗口，尚未占用其他时段。'}]})
 }})
 const result=await xixi.chat({...input(),text:'在不存在的窗口复习45分钟'})
 assert.equal(result.status,'completed');assert.equal(requests.length,2)
 assert.equal(result.execution.plannerReview.pending,false)
 assert.equal(result.execution.status,'awaiting_user')
 assert.equal(db.getPlanner().blocks.length,0)
})

test('auto placement clips to a linked exam and never fills an available post-exam window',t=>{
 const db=setup(t)
 const state=db.getPlanner();state.routines=state.routines.filter(r=>r.id==='morning').map(r=>({...r,start:'12:45',end:'15:00'}))
 const task=db.createTask({title:'物理复习',due:DATE,estimateMin:45,relations:[{relation:'before',kind:'event',id:'exam',date:DATE}]})
 const result=initialTaskSchedule({state,allTasks:[task],tasks:[task],now:NOW,idForBlock:()=>randomUUID(),dateByTask:new Map([[task.id,DATE]])})
 assert.equal(result.plans.length,0);assert.equal(result.unscheduled[0].remainingMin,45)
 assert.equal(result.unscheduled[0].maxFreeMin,15)
 assert.ok(result.evidence[0].relations.some(r=>r.title==='物理考试'))
})
