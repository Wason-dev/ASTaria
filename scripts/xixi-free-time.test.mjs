import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'
import { createCompanion } from '../server/companion.mjs'

process.env.TZ = 'Asia/Shanghai'
const NOW = new Date('2026-09-22T09:00:00+08:00')
const call = (name, args) => ({ choices: [{ message: { content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const input = text => ({ requestId: randomUUID(), conversationId: 'free-time', text, context: { page: 'home', timezone: 'Asia/Shanghai' } })
function setup(t, answers) {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const requests = []
  const xixi = createXixi({db, now: () => NOW, complete: async payload => {requests.push(payload); const answer = answers.shift(); return typeof answer === 'function' ? answer(payload) : answer ?? reply('已处理')}})
  return {db, xixi, requests, companion: createCompanion({db, now: () => NOW})}
}

test('an explicit free-time goal saves once, schedules distinct dates and returns actual receipts before replying', async t => {
  const text = '把SAT单词加入余时，每周至少三次，每次20到30分钟'
  const answers = [call('save_free_time_goal', {title:'SAT单词', evidence:text, minPerWeek:3, sessionMin:20, sessionMax:30}), reply('已安排三次')]
  const f = setup(t, answers), request = input(text)
  const result = await f.xixi.chat(request)
  assert.equal(result.status, 'completed')
  assert.equal(f.companion.listState().freeTimeGoals.length, 1)
  assert.equal(f.db.listTasks().length, 1)
  const blocks = f.db.getPlanner().blocks
  assert.equal(blocks.length, 3)
  assert.equal(new Set(blocks.map(block=>block.date)).size, 3)
  assert.equal(result.operations.length, 1)
  const outcome = result.messages.find(message=>message.role==='tool')
  assert.equal(JSON.parse(outcome.content).sessions.length, 3)
  await f.xixi.chat(request)
  assert.equal(f.db.getPlanner().blocks.length, 3)
  f.db.undoOperation(result.operations[0].id)
  assert.equal(f.db.getPlanner().blocks.length, 0)
})

test('explicit read pages through every goal and keeps real session times', async t => {
  const answers = [call('read_free_time',{date:'2026-09-22',offset:0,limit:2}), call('read_free_time',{date:'2026-09-22',offset:2,limit:2}), reply('读取完成')]
  const f = setup(t,answers)
  for(let index=0;index<3;index++) f.companion.saveFreeTimeGoal({title:`学习目标${index}`,minPerWeek:2})
  const result = await f.xixi.chat(input('看看余时进度'))
  const rows = result.messages.filter(message=>message.role==='tool').map(message=>JSON.parse(message.content))
  assert.equal(rows[0].goals.length,2)
  assert.equal(rows[0].nextOffset,2)
  assert.equal(rows[1].goals.length,1)
  assert.equal(rows[1].nextOffset,null)
  assert.ok(rows.flatMap(row=>row.goals).every(goal=>Array.isArray(goal.sessions)))
})

test('propose mode does not create an active goal or schedule', async t => {
  const text = '把数学复习加入余时'
  const f = setup(t,[call('save_free_time_goal',{title:'数学复习',evidence:text}),reply('可在余时页面加入')])
  f.db.setPreference('app',{assistant:{autonomy:'propose'}})
  await f.xixi.chat(input(text))
  assert.equal(f.companion.listState().freeTimeGoals.length,0)
  assert.equal(f.db.getPlanner().blocks.length,0)
})

test('learning feedback remains readable after completion and a second feedback save', async t => {
  const f = setup(t,[])
  const goal = f.companion.saveFreeTimeGoal({title:'数学复习',minPerWeek:1})
  const {createFreeTime} = await import('../server/freeTime.mjs')
  const scheduler = createFreeTime({db:f.db,now:()=>NOW})
  const session = scheduler.schedule().sessions[0]
  scheduler.completeSession({sessionId:session.id})
  scheduler.completeSession({sessionId:session.id,feedback:'stuck',nextStep:'下次继续定义域'})
  const model = createXixi({db:f.db,now:()=>NOW,complete:async payload => payload.messages.some(message=>message.role==='tool') ? reply('从定义域继续') : call('read_free_time',{})})
  const result = await model.chat(input('上次余时做到哪了'))
  const read = JSON.parse(result.messages.find(message=>message.role==='tool').content)
  const returned = read.goals.find(item=>item.id===goal.id)
  assert.equal(returned.feedback[0].nextStep,'下次继续定义域')
  assert.equal(returned.feedback[0].feedback,'stuck')
  assert.equal(returned.progress.completedCount,1)
})

test('chat route tool uses the model-backed preview without changing the planner', async t => {
  const db=createDatabase(':memory:');t.after(()=>db.close())
  const task=db.createTask({title:'路线验证作业',estimateMin:30})
  let routeCalls=0
  const xixi=createXixi({db,now:()=>NOW,complete:async payload=>{
    if(payload.response_format?.type==='json_object'){
      routeCalls++
      const data=JSON.parse(payload.messages[1].content), window=data.facts.availableWindows[0]
      const start=window.start, end=String(Number(start.slice(0,2))).padStart(2,'0')+':'+String(Number(start.slice(3))+30).padStart(2,'0')
      return reply(JSON.stringify({plans:[{taskId:task.id,date:window.date,start,end}],current:'原来没有安排',candidate:'在真实空档完成',benefits:['留出明确时间'],costs:['占用半小时'],risks:[],recovery:['重新比较'],observations:['实际是否够用'],assumptions:['估时仍为半小时'],trends:Object.fromEntries(['week','fourWeeks','threeMonths','oneYear'].map(key=>[key,{condition:'仅这次改变',summary:'远期不能由这一次安排判断',uncertainty:'以实际进度为准'}])),unscheduledReason:''}))
    }
    return payload.messages.some(message=>message.role==='tool') ? reply('两条路线已生成，可在平行宇宙比较') : call('preview_route',{taskId:task.id,date:'2026-09-22',question:'这项作业放空档做会怎样'})
  }})
  const before=db.getPlanner()
  const result=await xixi.chat(input('看看这项作业放到空档做的路线'))
  assert.equal(result.status,'completed')
  assert.equal(routeCalls,1)
  assert.deepEqual(db.getPlanner(),before)
  const scenario=db.getCompanionState().scenarios[0]
  assert.equal(scenario.routeAnalysis.kind,'model-judgment')
  assert.equal(scenario.source.kind,'conversation')
})

test('undoing an explicit chat schedule does not reappear on the first daily ensure', async t => {
  const text='把阅读加入余时，每周两次'
  const f=setup(t,[call('save_free_time_goal',{title:'阅读',evidence:text,minPerWeek:2}),reply('安排好了')])
  const result=await f.xixi.chat(input(text))
  f.db.undoOperation(result.operations[0].id)
  const {createFreeTime}=await import('../server/freeTime.mjs')
  const scheduler=createFreeTime({db:f.db,now:()=>NOW})
  assert.equal(scheduler.ensureDaily().ensured,false)
  assert.equal(f.db.getPlanner().blocks.length,0)
})

test('chat completion checks off one learning session without completing the durable goal task', async t => {
  const answers=[]
  const f=setup(t,answers)
  f.companion.saveFreeTimeGoal({title:'物理复习',minPerWeek:2})
  const {createFreeTime}=await import('../server/freeTime.mjs')
  const scheduler=createFreeTime({db:f.db,now:()=>NOW}), planned=scheduler.schedule()
  const session=planned.sessions[0]
  answers.push(call('complete_free_time_session',{sessionId:session.id,feedback:'continue',nextStep:'下次复习电磁感应'}),reply('本次完成了'))
  const result=await f.xixi.chat(input('这次复习完了，下次继续电磁感应'))
  assert.equal(result.status,'completed')
  assert.equal(f.db.getTask(session.taskId).status,'todo')
  const state=scheduler.state()
  assert.equal(state.freeTimeProgress[0].completedCount,1)
  assert.equal(state.freeTimeFeedback[0].nextStep,'下次复习电磁感应')
})
