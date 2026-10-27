import test from 'node:test'
import assert from 'node:assert/strict'
import { measureContext, contextModel, contextMeterKey } from '../server/contextUsage.mjs'
import { isContextUsage } from '../src/xixi/contextUsage.ts'
import { createCompletion } from '../server/provider.mjs'
const settings={provider:'deepseek',cloudModel:'deepseek-flash',reasoningEffort:'high',streamResponses:true}
const payload={messages:[{role:'user',content:'帮我核对日程'}],tools:[{type:'function',function:{name:'read_tasks',description:'读取已有事项'}}]}

test('the ring uses the current request, including output, without adding cached input twice',()=>{
 const usage=measureContext(payload,settings,{usage:{prompt_tokens:245000,prompt_cache_hit_tokens:200000,prompt_cache_miss_tokens:45000,completion_tokens:5000,total_tokens:250000}})
 assert.equal(usage.usedTokens,250000);assert.equal(usage.capacity,1000000);assert.equal(usage.source,'provider');assert(isContextUsage(usage))
 const next=measureContext(payload,settings,{usage:{prompt_tokens:12000,completion_tokens:80}})
 assert.equal(next.usedTokens,12080,'compaction can reduce occupancy; this is not cumulative billing')
})
test('missing or malformed usage is explicitly estimated from the actual dispatch',()=>{
 for(const result of [undefined,{usage:{prompt_tokens:-1,completion_tokens:30}},{usage:{prompt_tokens:80}},{usage:{prompt_tokens:1.2,completion_tokens:2}}]) {
  const usage=measureContext(payload,settings,result);assert.equal(usage.source,'estimate');assert(usage.inputTokens>0);assert(isContextUsage(usage))
 }
 assert(measureContext(payload,settings).usedTokens>measureContext({messages:payload.messages},settings).usedTokens,'tool schema counts toward the estimate')
 assert.equal(isContextUsage({...measureContext(payload,settings),usedTokens:-1}),false)
})
test('custom endpoints and models have distinct identities, without guessing their context window',()=>{
 const one={provider:'compatible',compatible:{baseUrl:'https://a.example/v1',model:'model-a'}}
 const two={...one,compatible:{...one.compatible,baseUrl:'https://b.example/v1'}}
 assert.notEqual(contextModel(one).modelKey,contextModel(two).modelKey)
 assert.equal(contextModel(one).capacity,null)
 assert.equal(contextModel({provider:'local',local:{baseUrl:'http://127.0.0.1:11434/v1',model:'model-a'}}).capacity,null)
 assert(contextMeterKey('x'.repeat(160)).length<160)
})
test('real provider emits estimated then actual usage, and status summary calls do not touch the ring',async()=>{
 const reports=[],requests=[]
 const complete=createCompletion({read:async()=> 'fake-test-key'},async(url,options)=>{requests.push(JSON.parse(options.body));return Response.json({choices:[{message:{role:'assistant',content:'好'},finish_reason:'stop'}],usage:{prompt_tokens:88000,completion_tokens:400}})},()=>settings.cloudModel,()=>settings)
 await complete(payload,{onContextUsage:usage=>reports.push(usage)})
 assert.deepEqual(reports.map(item=>item.source),['estimate','provider']);assert.equal(reports[1].usedTokens,88400)
 await complete(payload,{purpose:'thinking-summary',onContextUsage:usage=>reports.push(usage)})
 assert.equal(reports.length,2)
 assert.equal(requests[0].max_tokens,undefined,'context display never caps reasoning')
})
test('thinking mode removes an unsupported forced tool choice without changing the saved effort',async()=>{
 const requests=[]
 const complete=createCompletion({read:async()=> 'fake-test-key'},async(_url,options)=>{requests.push(JSON.parse(options.body));return Response.json({choices:[{message:{role:'assistant',content:'好'},finish_reason:'stop'}]})},()=>settings.cloudModel,()=>settings)
 await complete({...payload,tool_choice:'required'})
 assert.equal(requests[0].thinking.type,'enabled')
 assert.equal(requests[0].reasoning_effort,'high')
 assert.equal(requests[0].tool_choice,'auto')
})
test('a required planner read turns thinking off only for that deterministic round',async()=>{
 const requests=[], reports=[]
 const complete=createCompletion({read:async()=> 'fake-test-key'},async(_url,options)=>{requests.push(JSON.parse(options.body));return Response.json({choices:[{message:{role:'assistant',content:'好'},finish_reason:'stop'}]})},()=>settings.cloudModel,()=>settings)
 const tool_choice={type:'function',function:{name:'read_planner'}}
 await complete({...payload,tool_choice},{purpose:'planner-required-read',onContextUsage:usage=>reports.push(usage)})
 assert.equal(requests[0].thinking.type,'disabled')
 assert.equal(requests[0].reasoning_effort,'none')
 assert.deepEqual(requests[0].tool_choice,tool_choice)
 assert.ok(reports.at(-1).outputTokens>0,'required reads are part of conversation usage')
 await complete(payload)
 assert.equal(requests[1].thinking.type,'enabled','normal reasoning resumes after the forced read')
 assert.equal(requests[1].reasoning_effort,'high')
 assert.equal(requests[1].max_tokens,undefined)
})
test('broken optional observers cannot interrupt provider replies',async()=>{
 const complete=createCompletion({read:async()=> 'fake-test-key'},async()=>Response.json({choices:[{message:{content:'完整回答'},finish_reason:'stop'}]}),()=>settings.cloudModel,()=>settings)
 const result=await complete(payload,{onContextUsage:()=>{throw Error('UI disconnected')}})
 assert.equal(result.choices[0].message.content,'完整回答')
})
