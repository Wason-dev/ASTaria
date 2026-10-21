import test from 'node:test'
import assert from 'node:assert/strict'
import { coalesceMobileReads } from '../mobile/runtime/readRequests.mjs'
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject} }

test('concurrent equal reads share one call, but completed reads never become a response cache', async () => {
  const pending=deferred();let calls=0
  const read=coalesceMobileReads(async()=>{calls++;await pending.promise;return {revision:calls}})
  const first=read('/api/planner'),second=read('/api/planner');pending.resolve()
  assert.deepEqual(await Promise.all([first,second]),[{revision:1},{revision:1}]);assert.equal(calls,1)
  assert.deepEqual(await read('/api/planner'),{revision:2})
})
test('query strings and headers retain separate read identities', async () => {
  let calls=0;const read=coalesceMobileReads(async()=>++calls)
  assert.deepEqual(await Promise.all([read('/api/tasks?x=1'),read('/api/tasks?x=2'),read('/api/tasks?x=1',undefined,{headers:{other:'yes'}})]),[1,2,3])
})
test('one cancelling subscriber cannot abort another subscriber or lose its response', async () => {
  const gate=deferred(),one=new AbortController(),two=new AbortController();let signal
  const read=coalesceMobileReads(async(_p,_i,o)=>{signal=o.signal;await gate.promise;return 42})
  const first=read('/api/tasks',undefined,{signal:one.signal}),second=read('/api/tasks',undefined,{signal:two.signal})
  await Promise.resolve();one.abort();await assert.rejects(first,/取消|abort/i);assert.equal(signal.aborted,false)
  gate.resolve();assert.equal(await second,42)
})
test('cancelling all subscribers stops the underlying read and a later read starts afresh', async () => {
  const gate=deferred(),a=new AbortController(),b=new AbortController();let signal,calls=0
  const read=coalesceMobileReads(async(_p,_i,o)=>{calls++;signal=o.signal;await gate.promise;return calls})
  const first=read('/api/tasks',undefined,{signal:a.signal}),second=read('/api/tasks',undefined,{signal:b.signal})
  await Promise.resolve();a.abort();b.abort();await Promise.allSettled([first,second]);assert.equal(signal.aborted,true)
  const third=read('/api/tasks');gate.resolve();await third;assert.equal(calls,2)
})
test('both sides of a write fence in-flight reads, including a failed write', async () => {
  const reads=[],write=deferred();let calls=0
  const request=coalesceMobileReads(async(_p,input)=>{if(input!==undefined)return write.promise;const d=deferred();reads.push(d);return d.promise})
  const before=request('/api/planner');await Promise.resolve()
  const saving=request('/api/planner',{action:'save'});const during=request('/api/planner');await Promise.resolve()
  write.reject(Error('failed write'));await assert.rejects(saving,/failed write/)
  const after=request('/api/planner');await Promise.resolve();assert.equal(reads.length,3)
  reads.forEach(d=>d.resolve(++calls));assert.deepEqual(await Promise.all([before,during,after]),[1,2,3])
})
test('writes, streaming reads and failed reads are never reused as successful reads', async () => {
  let calls=0;const request=coalesceMobileReads(async()=>{calls++;throw Error('failed')})
  await Promise.allSettled([request('/api/tasks/create',{}),request('/api/tasks/create',{}),request('/api/chat',undefined,{onEvent(){}}),request('/api/chat',undefined,{onEvent(){}})])
  assert.equal(calls,4)
  await assert.rejects(request('/api/tasks'),/failed/);await assert.rejects(request('/api/tasks'),/failed/);assert.equal(calls,6)
})
