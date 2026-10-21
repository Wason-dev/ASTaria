import test from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { prepareMobileGeodesics } from '../src/prototype/geodesicLoader.ts'
import { createGeodesicLut } from '../src/prototype/geodesics.ts'

const fingerprint = array => createHash('sha256').update(new Uint8Array(array.buffer,array.byteOffset,array.byteLength)).digest('hex')
test('failed startup frees its worker and allows a later explicit retry', async () => {
  let stopped=0
  const worker={terminate(){stopped++},postMessage(){queueMicrotask(()=>worker.onmessage({data:{error:'failed'}}))}}
  await assert.rejects(prepareMobileGeodesics(()=>worker),/场景准备/)
  assert.equal(stopped,1)
})
test('a real startup worker transfers the exact full-resolution integration once without cloning or reducing samples', async () => {
  const url=new URL('../src/prototype/geodesics.ts',import.meta.url).href
  const source=readFileSync(new URL('../src/prototype/geodesics.worker.ts',import.meta.url),'utf8').replace("from './geodesics'",`from '${url}'`)
  let created=0,terminated=0,adapter
  const factory=()=>{
    created++
    const worker=new Worker(`const {parentPort}=require('node:worker_threads');global.self={postMessage:(data,options)=>parentPort.postMessage(data,options?.transfer)};import(${JSON.stringify('data:text/javascript,'+encodeURIComponent(source.replace(/:\s*GeodesicLut/g,'')))}).then(()=>parentPort.on('message',data=>self.onmessage({data})));`,{eval:true})
    adapter={postMessage:data=>worker.postMessage(data),terminate(){terminated++;worker.terminate()}}
    worker.on('message',data=>adapter.onmessage({data}));worker.on('error',error=>adapter.onerror(error));return adapter
  }
  const first=prepareMobileGeodesics(factory),second=prepareMobileGeodesics(factory)
  assert.equal(first,second);assert.equal(created,1)
  const actual=await first,expected=createGeodesicLut({cameraRadius:30,maxImpact:24,width:2048,height:1536})
  assert.equal(terminated,1)
  assert.equal(fingerprint(actual.inverseRadius),fingerprint(expected.inverseRadius))
  assert.equal(fingerprint(actual.termination),fingerprint(expected.termination))
  for(const field of ['width','height','maxPhi','cameraRadius','maxImpact','maxRelativeEnergyError','unterminatedRays'])assert.equal(actual[field],expected[field])
  assert.equal(await prepareMobileGeodesics(()=>{throw Error('should reuse completed table')}),actual)
})
