import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compatibleEndpoint } from '../src/xixi/cloudProviders.ts'
import { validateModelSettings, LOCAL_DEFAULT } from '../server/modelSettingsCore.mjs'
import { createCompletion } from '../server/provider.mjs'
import { createCompatibleFetch } from '../server/compatibleFetch.mjs'
import { createSecretStore } from '../desktop/secretStore.mjs'
import { createDatabase } from '../server/database.mjs'
import { createServiceCore } from '../server/serviceCore.mjs'

const config = (baseUrl = 'https://models.example.com/v1') => validateModelSettings({ provider:'compatible',cloudModel:'deepseek-flash',local:LOCAL_DEFAULT,compatible:{preset:'custom',baseUrl,model:'vision-tools-model'} })
const json = value => new Response(JSON.stringify(value), { headers:{'content-type':'application/json'} })
test('cloud base URLs reject credential-bearing, loopback, non-HTTPS, query and completion URLs', () => {
  assert.equal(compatibleEndpoint('https://models.example.com/v1/'),'https://models.example.com/v1')
  for(const url of ['http://models.example.com/v1','https://127.0.0.1/v1','https://localhost/v1','https://x.local/v1','https://models.example.com:444/v1','https://secret@models.example.com/v1','https://models.example.com/v1?key=secret','https://models.example.com/v1/chat/completions','https://[::1]/v1']) assert.throws(()=>compatibleEndpoint(url))
  assert.throws(()=>validateModelSettings({...config(),compatible:{...config().compatible,preset:'openai'}}),/地址/)
  assert.equal(config().compatible.model,'vision-tools-model')
})
test('compatible requests use only endpoint-scoped credentials and omit DeepSeek controls', async () => {
  const calls=[],settings=config()
  const complete=createCompletion({read:()=>assert.fail('DeepSeek credential must not be read')},()=>assert.fail('wrong transport'),()=>assert.fail('wrong model'),()=>settings,{
    compatibleVault: endpoint => {assert.equal(endpoint,settings.compatible.baseUrl);return{read:async()=> 'synthetic-compatible-key'}},
    compatibleFetcher:async(url,init)=>{calls.push({url,...init,body:JSON.parse(init.body)});return json({choices:[{message:{role:'assistant',content:'OK'}}]})},
  })
  await complete({messages:[{role:'assistant',content:'earlier',reasoning_content:'private provider syntax'},{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,synthetic'}}]}],tools:[{type:'function'}],max_tokens:64})
  assert.equal(calls[0].url,'https://models.example.com/v1/chat/completions')
  assert.equal(calls[0].headers.Authorization,'Bearer synthetic-compatible-key')
  assert.equal(calls[0].body.model,'vision-tools-model')
  assert.equal(calls[0].body.max_tokens,64)
  assert.ok(!('thinking' in calls[0].body)&&!('reasoning_effort' in calls[0].body)&&!('reasoning_content' in calls[0].body.messages[0]))
  assert.equal(calls[0].body.messages[1].content[0].type,'image_url')
})
test('endpoint-bound secrets cannot be reused for another service and never persist plaintext', async t => {
  const directory=mkdtempSync(join(tmpdir(),'astaria-compatible-vault-'));t.after(()=>rmSync(directory,{recursive:true,force:true}))
  const store=createSecretStore({platform:'darwin',directory,safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s).reverse(),decryptString:b=>Buffer.from(b).reverse().toString()}})
  const a=store.providerVault('https://a.example.com/v1'), b=store.providerVault('https://b.example.com/v1')
  await a.save('synthetic-a-key');await store.apiVault.save('synthetic-deepseek-key')
  assert.equal(await a.read(),'synthetic-a-key');assert.equal(await b.status(),false)
  assert.equal(await store.providerVault('https://a.example.com/v1/').read(),'synthetic-a-key')
  for(const file of readdirSync(directory))assert.ok(!readFileSync(join(directory,file)).includes(Buffer.from('synthetic-')))
  await a.remove();assert.equal(await store.apiVault.read(),'synthetic-deepseek-key')
})
function transport({addresses=['93.184.216.34'],status=200}={}) {
  const calls=[]
  const request=(url,options,onResponse)=>{
    calls.push({url:String(url),options});const req=new EventEmitter()
    req.end=body=>{calls.at(-1).body=body;queueMicrotask(()=>{const response=Readable.from([Buffer.from('{"ok":true}')]);response.statusCode=status;response.headers={'content-type':'application/json'};onResponse(response)})}
    return req
  }
  return {calls,fetcher:createCompatibleFetch({lookup:async()=>addresses,request})}
}
test('compatible HTTPS transport pins public DNS and rejects mixed/private answers before sending keys', async () => {
  const t=transport();const result=await t.fetcher('https://models.example.com/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer test'},body:'{}'})
  assert.deepEqual(await result.json(),{ok:true})
  let pinned;t.calls[0].options.lookup('models.example.com',{all:true},(error,answer)=>{assert.equal(error,null);pinned=answer})
  assert.deepEqual(pinned,[{address:'93.184.216.34',family:4}])
  for(const addresses of [['127.0.0.1'],['10.0.0.1'],['169.254.169.254'],['93.184.216.34','192.168.1.2'],[]]){
    const x=transport({addresses});await assert.rejects(x.fetcher('https://models.example.com/v1/chat/completions',{method:'POST',headers:{Authorization:'must not send'}}),/公开/);assert.equal(x.calls.length,0)
  }
  await assert.rejects(transport({status:302}).fetcher('https://models.example.com/v1/chat/completions',{method:'POST'}),/重定向/)
  const noContent=await transport({status:204}).fetcher('https://models.example.com/v1/chat/completions',{method:'POST'});assert.equal(noContent.status,204)
})
test('service requires saving the endpoint before its own key and reports actual configuration without returning secrets', async t => {
  const db=createDatabase(':memory:');t.after(()=>db.close());const secrets=new Map()
  const compatibleVault=endpoint=>({status:async()=>secrets.has(endpoint),read:async()=>secrets.get(endpoint),save:async key=>secrets.set(endpoint,key),remove:async()=>secrets.delete(endpoint)})
  const service=createServiceCore({db,vault:{status:async()=>false},compatibleVault,xixiFactory:()=>({}),deviceRecommendation:()=>({})})
  await assert.rejects(service.dispatch('/api/settings/compatible/key',{baseUrl:'https://models.example.com/v1',key:'synthetic-key'}),/先保存/)
  await service.dispatch('/api/settings/provider',config())
  let status=await service.dispatch('/api/settings/compatible/key',{baseUrl:'https://models.example.com/v1',key:'synthetic-key'})
  assert.equal(status.configured,true);assert.ok(!JSON.stringify(status).includes('synthetic-key'))
  await service.dispatch('/api/settings/provider',config('https://other.example.com/v1'))
  status=await service.dispatch('/api/status');assert.equal(status.configured,false)
  assert.equal(db.getPreference('model-connection').compatible.baseUrl,'https://other.example.com/v1')
})
