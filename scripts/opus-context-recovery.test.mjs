import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'
import { createServiceCore } from '../server/serviceCore.mjs'
import { contextUnits } from '../server/contextBudget.mjs'

const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const input = text => ({ requestId: randomUUID(), conversationId: 'main', text, context: { timezone: 'Asia/Shanghai', page: 'home' } })
const facts = request => JSON.parse(request.messages.find(message => message.content?.startsWith('当前环境与数据库资料')).content.split('\n').slice(1).join('\n'))
const tool = (name, args) => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })

test('R1 history uses a single operation scan per context and keeps early turns', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  for (let n=0;n<2000;n++) {
    const id='old-'+n
    db.appendMessage({conversationId:'main',requestId:id,role:'user',content:'历史主题 '+n})
    db.appendMessage({conversationId:'main',requestId:id,role:'assistant',content:'历史回复 '+n})
  }
  let reads=0, sent
  const measured={...db,listOperations:options=>{reads++;return db.listOperations(options)}}
  const xixi=createXixi({db:measured,complete:async request=>{sent=request;return reply('收到')}})
  assert.equal((await xixi.chat(input('继续'))).status,'completed')
  assert.ok(reads<=10, 'operation reads must not grow with historical turn count')
  assert.ok(sent.messages.some(message=>message.content==='历史主题 0'))
  assert.equal(sent.messages.filter(message=>message.content?.startsWith('历史回合，记录于')).length,1)
})

test('R8/R13 a large local history has a fully pageable range without blocking summary catch-up calls', async t => {
  const db=createDatabase(':memory:');t.after(()=>db.close())
  db.setPreference('model-connection',{provider:'local'})
  const original=[]
  for(let n=0;n<1000;n++) {
    const id='history-'+n
    original.push(db.appendMessage({conversationId:'main',requestId:id,role:'user',content:'问题'+n+'重要资料'.repeat(70)}))
    original.push(db.appendMessage({conversationId:'main',requestId:id,role:'assistant',content:'回答'+n+'已经核对'.repeat(50)}))
  }
  const requests=[]
  const xixi=createXixi({db,complete:async request=>{requests.push(request);return reply('继续')}})
  for(let i=0;i<3;i++)assert.equal((await xixi.chat(input('继续'+i))).status,'completed')
  assert.equal(requests.length,3,'no repeated synchronous summary round during backlog')
  for(const request of requests) {
    assert.ok(contextUnits(request.messages)+contextUnits(request.tools)<=24000)
    const env=facts(request),range=env.historyArchive
    assert.ok(range && range.semanticSummary===false)
    const sources=JSON.parse(request.messages.find(m=>m.content?.startsWith('以下对话的出处与发送时间：')).content.slice('以下对话的出处与发送时间：'.length))
    const sentIds=new Set(sources.map(source=>source.id))
    for(const message of original)assert.ok(sentIds.has(message.id)||(message.seq>=range.fromSeq&&message.seq<=range.throughSeq),'every original has context or explicit retrieval coverage')
    assert.equal(range.readMore.afterSeq,range.fromSeq-1)
  }
  const range=facts(requests[0]).historyArchive
  let round=0,received
  const retrieving=createXixi({db,complete:async request=>{
    if(round++===0)return tool('search_history',range.readMore)
    received=JSON.parse(request.messages.findLast(m=>m.role==='tool').content)
    return reply('已核对原文')
  }})
  // Tool schema name is metadata, not an executable argument.
  delete range.readMore.tool
  assert.equal((await retrieving.chat(input('核对最早原文'))).status,'completed')
  assert.equal(received.messages[0].id,original[0].id)
  assert.equal(received.messages.length,3)
  assert.equal(received.nextAfterSeq,original[2].seq)
  assert.equal(received.hasMore,true)
})

test('R15 failed request recovery returns original context and rejects running/completed/retracted/other-topic records', async t=>{
  const db=createDatabase(':memory:');t.after(()=>db.close())
  const request={...input('恢复我的原话'),context:{timezone:'Asia/Shanghai',page:'calendar',date:'2030-01-02'}}
  const turn=db.beginTurn(request)
  const service=createServiceCore({db,vault:{status:async()=>false},xixiFactory:()=>({})})
  const path='/api/conversation/retry?conversationId=main&requestId='+request.requestId
  await assert.rejects(service.dispatch(path),error=>error.status===409)
  db.finishTurn(request.requestId,{status:'failed'})
  const recovered=await service.dispatch(path)
  assert.deepEqual(recovered.context,request.context)
  assert.equal(recovered.requestId,request.requestId)
  assert.equal(recovered.text,request.text)
  assert.equal(recovered.seq,db.getMessage(turn.userMessageId).seq)
  assert.ok(!('progress' in recovered)&&!('ownerToken' in recovered))
  await assert.rejects(service.dispatch(path.replace('conversationId=main','conversationId=other')),error=>error.status===404)
  db.finishTurn(request.requestId,{status:'completed'})
  await assert.rejects(service.dispatch(path),error=>error.status===409)
  db.retractMessage(turn.userMessageId)
  await assert.rejects(service.dispatch(path),error=>error.status===409)
})

for (const outcome of ['notes','plain','error']) test(`R23 missing receipt notes triggers at most one bounded repair: ${outcome}`, async t=>{
  const db=createDatabase(':memory:');t.after(()=>db.close())
  let count=0, notesOperation, phase
  const original='复习已经安排在上午，考试前留出了半小时。'
  const xixi=createXixi({db,now:()=>new Date('2030-01-23T08:00:00+08:00'),complete:async (request,options)=>{
    count++
    if(count===1)return tool('create_tasks',{tasks:[{title:'复习',kind:'task',estimateMin:30}]})
    if(count===2){notesOperation=db.listOperations().find(operation=>operation.changes?.some(change=>change.table==='tasks'));return reply(original)}
    assert.equal(count,3)
    phase=options.purpose
    assert.deepEqual(request.tools.map(item=>item.function.name).sort(),['ask_user','finish_response'])
    if(outcome==='error')throw Error('synthetic failure')
    if(outcome==='plain')return reply('已保存。')
    return tool('finish_response',{content:original,receiptNotes:[{operationId:notesOperation.id,text:'按照已有的自习空档安排，保留了课程时间。'}]})
  }})
  const result=await xixi.chat(input('复习半小时'))
  assert.equal(result.status,'completed')
  assert.equal(count,3)
  assert.equal(phase,'receipt-explanation')
  assert.equal(db.listTasks().length,1)
  assert.ok(result.messages.filter(m=>m.role==='assistant').some(m=>m.content.includes(original)))
  if(outcome!=='notes')assert.ok(result.messages.some(m=>m.executionNotice?.issues.some(issue=>issue.includes('安排说明暂未生成'))))
  else {const { publicOperations }=await import('../server/operationReceipts.mjs');assert.ok(publicOperations(db.listOperations(),db).some(op=>op.explanations?.length))}
})

test('R13 short local conversations with live tasks do not summarize on the fifth turn', async t=>{
  const db=createDatabase(':memory:');t.after(()=>db.close())
  db.setPreference('model-connection',{provider:'local'})
  for(let n=0;n<10;n++)db.createTask({title:'阅读作业'+n,estimateMin:35})
  let calls=0
  const xixi=createXixi({db,complete:async request=>{calls++;assert.equal(request.response_format,undefined);return reply('这段回答已经完整保存，之后仍然可以继续核对。')}})
  for(let n=0;n<12;n++)assert.equal((await xixi.chat(input('查看回复'+n))).status,'completed')
  assert.equal(calls,12)
  assert.equal(db.getSummary('main'),null)
})

test('R8 a 1M-window reply with more than ten thousand sources saves, restores and remains retractable',async t=>{
  const db=createDatabase(':memory:');t.after(()=>db.close())
  let first
  for(let n=0;n<5500;n++) {
    const requestId='history-'+n
    const message=db.appendMessage({conversationId:'main',requestId,role:'user',content:'第'+n+'条原始资料'})
    first??=message
    db.appendMessage({conversationId:'main',requestId,role:'assistant',content:'第'+n+'条已说明'})
  }
  const xixi=createXixi({db,complete:async request=>{assert.ok(contextUnits(request.messages)+contextUnits(request.tools??[])<900000);return reply('完整核对。')}})
  const current=input('继续')
  const result=await xixi.chat(current)
  assert.equal(result.status,'completed',result.error)
  const final=result.messages.findLast(message=>message.role==='assistant')
  assert.ok(final.sourceMessageIds.length>10000)
  assert.ok(final.sourceMessageIds.includes(first.id))
  const restored=createDatabase(':memory:');t.after(()=>restored.close())
  restored.importData(db.exportData())
  assert.deepEqual(restored.getMessage(final.id).sourceMessageIds,final.sourceMessageIds)
  restored.retractMessage(first.id)
  assert.equal(restored.getMessage(final.id).excludeFromContext,true)
  assert.throws(()=>db.appendMessage({conversationId:'main',role:'assistant',content:'invalid',sourceMessageIds:Array(100001).fill(first.id)}),/来源列表/)
})
