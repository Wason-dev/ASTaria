import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'
import { routinesForDay } from '../src/planner/model.ts'

process.env.TZ = 'Asia/Shanghai'
const date = '2026-09-20', nextThursday = '2026-09-24'
const evidence = '周四下午第一节英语，心理健康、LL、物理往后延一节，最后物理两节，每周四都这样，明天也用新课表'
const answer = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const call = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const receipt = request => JSON.parse(request.messages.findLast(m => m.role === 'tool').content)
function fixture(t) {
  const db = createDatabase(':memory:'), replies = [], requests = []
  t.after(() => db.close())
  const slots = [['08:00','08:40','Phy2'],['12:45','13:25','心理健康'],['13:30','14:10','L&L'],['14:15','14:55','物理'],['15:00','15:40','空课'],['15:45','16:25','空课']]
  db.updatePlanner({ type:'import-routines', routines: slots.map(([start,end,title],i) => ({ id:`slot-${i}`,title,start,end,kind:title==='空课'?'available':'class',weekdays:[4],location:'508',items:[],enabled:true })) },db.getPlanner().revision)
  db.updatePlanner({ type:'set-day-template',date,sourceWeekday:4 },db.getPlanner().revision)
  const xixi = createXixi({ db, now:()=>new Date('2026-09-19T22:00:00+08:00'), complete:async request=>{
    requests.push(request); const value=replies.shift(); assert.ok(value,'unexpected provider dispatch')
    return typeof value==='function'?await value(request):value
  } })
  const input = (text,conversationId='main')=>({requestId:randomUUID(),conversationId,text,context:{timezone:'Asia/Shanghai',page:'timetable',date}})
  const read = ()=>call('read_weekly_timetable',{weekday:4})
  const edit = (revision,quote=evidence)=>call('edit_weekly_timetable',{weekday:4,expectedRevision:revision,evidence:quote,syncDates:[date],replacements:['英语','心理健康','L&L','物理','物理'].map((title,i)=>({routineId:`slot-${i+1}`,title,kind:'class'}))})
  const previous = (text=evidence,conversationId='main')=>{
    const requestId=randomUUID();const user=db.appendMessage({conversationId,requestId,role:'user',content:text})
    db.appendMessage({conversationId,requestId,role:'assistant',content:'12:45 英语；13:30 心理健康；14:15 L&L；15:00 物理；15:45 物理。上午不动'})
    return user
  }
  return {db,replies,requests,xixi,input,read,edit,previous}
}

test('confirmation continues weekly correction, syncs Sunday once and undo restores both',async t=>{
  const f=fixture(t); f.previous(); const before=f.db.getPlanner()
  f.replies.push(f.read(),request=>{
    const data=receipt(request);assert.equal(data.type,'weekly_timetable_read');assert.equal(data.weekday,4)
    assert.equal(data.routines.items.filter(r=>r.start>='12:45'&&r.start<'18:00').length,5)
    return f.edit(data.revision)
  },request=>{
    const data=receipt(request);assert.equal(data.ok,true)
    assert.deepEqual(data.weekly.routines.items.filter(r=>r.start>='12:45'&&r.start<'18:00').map(r=>r.title),['英语','心理健康','L&L','物理','物理'])
    return answer('周四下午五节改好了，明天同步，上午保留')
  })
  const input=f.input('是这样'),result=await f.xixi.chat(input)
  assert.equal(result.status,'completed');assert.equal(result.operations.length,1)
  const state=f.db.getPlanner();assert.deepEqual(routinesForDay(state,date),routinesForDay(state,nextThursday))
  assert.deepEqual(state.routines.find(r=>r.id==='slot-0'),before.routines.find(r=>r.id==='slot-0'))
  assert.equal((await f.xixi.chat(input)).operations.length,1)
  f.db.undoOperation(result.operations[0].id);assert.deepEqual(f.db.getPlanner().routines,before.routines);assert.deepEqual(f.db.getPlanner().dayOverrides,before.dayOverrides)
})

test('escaped double-bar textual tool is repaired invisibly before native weekly write',async t=>{
  const f=fixture(t);f.previous()
  const raw=String.raw`<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="edit\_weekly\_timetable"><｜｜DSML｜｜ parameter name="weekday" string="false">4\</｜｜DSML｜｜ parameter>\</｜｜DSML｜｜ invoke>\</｜｜DSML｜｜ calls>`
  f.replies.push(answer(raw),request=>{
    assert.doesNotMatch(JSON.stringify(request.messages),/DSML/);assert.match(request.messages.at(-1).content,/原生 tool_calls/)
    return f.read()
  },request=>f.edit(receipt(request).revision),answer('周四和明天都已更新'))
  const result=await f.xixi.chat(f.input('再试一下'))
  assert.equal(result.status,'completed');assert.equal(result.operations.length,1)
  assert.doesNotMatch(JSON.stringify(result.messages),/DSML/)
  assert.equal(f.requests.length,4)
})

for(const reason of ['unrelated','cancelled','other-conversation','withdrawn','history-disabled','assistant-only','fabricated-join','propose','unread','stale']){
  test(`weekly writes reject ${reason}`,async t=>{
    const f=fixture(t)
    if(reason==='assistant-only') f.db.appendMessage({conversationId:'main',role:'assistant',content:evidence})
    else {const source=f.previous(evidence,reason==='other-conversation'?'other':'main');if(reason==='withdrawn') f.db.retractMessage(source.id)}
    if(reason==='history-disabled') f.db.setPreference('app',{assistant:{useHistory:false}})
    if(reason==='propose') f.db.setPreference('app',{assistant:{autonomy:'propose'}})
    const before=f.db.getPlanner()
    if(reason!=='unread')f.replies.push(f.read())
    f.replies.push(()=>f.edit(reason==='stale'?before.revision-1:before.revision,reason==='fabricated-join'?evidence+' 是这样':evidence),request=>{
      assert.equal(receipt(request).ok,false);return answer('这次修改未执行')
    })
    const result=await f.xixi.chat(f.input(reason==='unrelated'?'你好':reason==='cancelled'?'好的，但先不要改':'是这样'))
    assert.equal(result.status,'completed');assert.equal(result.operations.length,0);assert.deepEqual(f.db.getPlanner(),before)
  })
}

test('latest manual template is readable separately from an older day snapshot and can refresh it',async t=>{
  const f=fixture(t),before=f.db.getPlanner()
  // A deliberately explicit weekly-only edit leaves the existing snapshot unchanged.
  f.db.updatePlanner({type:'edit-weekday',weekday:4,replacements:[{routineId:'slot-1',title:'英语',kind:'class'}],syncDates:[]},before.revision)
  f.previous('明天按周四的新课表上')
  f.replies.push(call('read_planner',{date}),request=>{
    assert.equal(receipt(request).days[0].dayOverride.templateChanged,true);return f.read()
  },request=>{
    const data=receipt(request);assert.equal(data.routines.items.find(r=>r.id==='slot-1').title,'英语')
    assert.equal(data.dayOverrides[0].templateChanged,true)
    return call('set_day_timetable',{date,sourceWeekday:4,expectedRevision:data.revision,evidence:'明天按周四的新课表上'})
  },request=>{assert.equal(receipt(request).day.dayOverride.templateChanged,false);return answer('已读取新周模板并同步明天')})
  const result=await f.xixi.chat(f.input('我刚刚改了'))
  assert.equal(result.status,'completed');assert.equal(result.operations.length,1)
  assert.equal(f.db.getPlanner().dayOverrides[date].routines.find(r=>r.id==='slot-1').title,'英语')
})

test('an intervening cancellation cannot be bypassed by a later bare acknowledgement',async t=>{
  const f=fixture(t);f.previous();f.previous('先不要改，等我重新确认')
  const before=f.db.getPlanner()
  f.replies.push(f.read(),request=>f.edit(receipt(request).revision),request=>{assert.equal(receipt(request).ok,false);return answer('保持现在的课表')})
  const result=await f.xixi.chat(f.input('好的'))
  assert.equal(result.status,'completed');assert.equal(result.operations.length,0);assert.deepEqual(f.db.getPlanner(),before)
})

test('31 synchronized dates produce a bounded receipt and a completed reply after the write',async t=>{
  const f=fixture(t),dates=Array.from({length:31},(_,i)=>`2026-10-${String(i+1).padStart(2,'0')}`)
  for(const date of dates)f.db.updatePlanner({type:'set-day-template',date,sourceWeekday:4},f.db.getPlanner().revision)
  f.replies.push(f.read(),request=>call('edit_weekly_timetable',{weekday:4,expectedRevision:receipt(request).revision,evidence,syncDates:dates,replacements:[{routineId:'slot-1',title:'英语',kind:'class'}]}),request=>{
    const outcome=receipt(request);assert.equal(outcome.ok,true);assert.equal(outcome.syncedDays.length,31)
    assert.ok(JSON.stringify(outcome).length<14000);return answer('已更新周四和31个调课日')
  })
  const result=await f.xixi.chat(f.input(evidence))
  assert.equal(result.status,'completed');assert.equal(result.operations.length,1)
  for(const date of dates)assert.equal(f.db.getPlanner().dayOverrides[date].routines.find(r=>r.id==='slot-1').title,'英语')
})
