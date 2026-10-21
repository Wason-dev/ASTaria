import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { createXixi } from '../server/xixi.mjs'
import { saveModelSettings } from '../server/modelSettings.mjs'
import { contextUnits, fitContext } from '../server/contextBudget.mjs'
import { normalizeChatAttachments, providerImageContent } from '../server/chatAttachments.mjs'
import { readAttachment, attachmentImages, conversationHasDocuments } from '../server/chatDocuments.mjs'
import { DOCUMENT_MIME, DOCUMENT_MAX_BYTES, DOCUMENT_MAX_IMAGE_BYTES, DOCUMENT_MAX_TEXT } from '../src/xixi/documentAttachment.ts'
import { CHAT_REQUEST_MAX_BYTES, localRequestLimit } from '../src/xixi/requestLimits.ts'

// Offline 2 x 3 JPEG; no real document, database, credentials or provider.
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCOiiivcPKP/9k=', 'base64')
const url = (bytes, mime) => `data:${mime};base64,${bytes.toString('base64')}`
const scan = () => ({ mime: 'image/jpeg', size: jpeg.length, data: url(jpeg, 'image/jpeg') })
const makeDocument = (sections = [{ label: '第1页', text: '合成文档正文' }], format = 'pdf', bytes = Buffer.from('%PDF-1.7\n%%EOF')) => ({
  kind: 'document', name: `合成资料.${format}`, mime: DOCUMENT_MIME[format], size: bytes.length, data: url(bytes, DOCUMENT_MIME[format]),
  document: { format, sections, warnings: [] },
})
const fixture = t => { const db = createDatabase(':memory:'); t.after(() => db.close()); return db }
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const call = (name, args, id = randomUUID()) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const toolsReply = calls => ({ choices: [{ message: { role: 'assistant', content: '', reasoning_content: '读取附件资料。', tool_calls: calls } }] })
const input = (attachments, text = '请解释附件中的内容') => ({ requestId: randomUUID(), conversationId: 'main', text, ...(attachments ? { attachments } : {}), context: { timezone: 'Asia/Shanghai' } })
const imagesIn = payload => payload.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : [])
function assertNativePairs(messages) {
  for (let i = 0; i < messages.length; i++) {
    const calls = messages[i].tool_calls
    if (!calls?.length) continue
    const results = messages.slice(i + 1, i + 1 + calls.length)
    assert.ok(results.every(result => result.role === 'tool'))
    assert.deepEqual(new Set(results.map(result => result.tool_call_id)), new Set(calls.map(call => call.id)))
  }
}

test('document wire validation checks bytes, MIME, canonical Base64, sizes and bounded sections/warnings', () => {
  for (const [format, bytes] of [['pdf', Buffer.from('%PDF-1.7\n%%EOF')], ['docx', Buffer.from([80,75,3,4,0])],
    ['xlsx', Buffer.from([80,75,3,4,0])], ['xls', Buffer.from([208,207,17,224,161,177,26,225])], ['csv', Buffer.from('a,b\n1,2')], ['tsv', Buffer.from('a\tb\n1\t2')]]) {
    const document = makeDocument(undefined, format, bytes)
    assert.deepEqual(normalizeChatAttachments([document]), [document])
  }
  const rejects = change => { const document = makeDocument(); change(document); assert.throws(() => normalizeChatAttachments([document]), { name: 'ValidationError' }) }
  rejects(d => { d.mime = 'image/jpeg' })
  rejects(d => { d.document.format = '__proto__' })
  rejects(d => { d.data = url(Buffer.from('not PDF'), d.mime); d.size = 7 })
  rejects(d => { const bytes=Buffer.from('%PDF-fake\n'); d.data=url(bytes,d.mime); d.size=bytes.length })
  rejects(d => { d.size++ })
  rejects(d => { delete d.size })
  rejects(d => { d.data = d.data.replace(';base64,', ';charset=utf-8;base64,') })
  rejects(d => { d.data = `data:${d.mime};base64,AB==`; d.size = 1 })
  rejects(d => { d.data += 'A'.repeat(Math.ceil(DOCUMENT_MAX_BYTES / 3) * 4) })
  rejects(d => { d.document.sections = [] })
  rejects(d => { d.document.sections = Array.from({length:2001}, () => ({label:'page',text:''})) })
  rejects(d => { d.document.sections[0].text = 'x'.repeat(DOCUMENT_MAX_TEXT + 1) })
  rejects(d => { d.document.sections[0].label = 'x'.repeat(201) })
  rejects(d => { d.document.sections[0].extra = true })
  rejects(d => { d.document.warnings = Array(41).fill('warning') })
  rejects(d => { d.document.warnings = ['x'.repeat(501)] })
  rejects(d => { d.document.warnings = [null] })
  rejects(d => { d.document.extra = true })
  rejects(d => { d.extra = true })
  rejects(d => { d.name = 'bad\nname.pdf' })
  for (const format of ['docx','xlsx','xls']) assert.throws(() => normalizeChatAttachments([makeDocument(undefined, format, Buffer.from('forged'))]))
})

test('CSV and TSV preserve explicit UTF-16 input and reject invalid encoding or null text', () => {
  for (const format of ['csv', 'tsv']) {
    const le = Buffer.concat([Buffer.from([255, 254]), Buffer.from('名称,值\n合成,2', 'utf16le')])
    const document = makeDocument([{ label: '表 1', text: 'A1: 名称 | B1: 值' }], format, le)
    assert.deepEqual(normalizeChatAttachments([document]), [document])
    for (const bytes of [Buffer.from([0, 1, 2]), Buffer.from([255, 254, 0]), Buffer.from([255, 192])]) {
      assert.throws(() => normalizeChatAttachments([makeDocument(undefined, format, bytes)]), { name: 'ValidationError' })
    }
  }
})

test('scanned pages require real JPEG headers/dimensions and aggregate image/page limits', () => {
  const document = makeDocument([{label:'扫描页',text:'',image:scan()}])
  assert.deepEqual(normalizeChatAttachments([document]), [document])
  const reject = change => { const d = structuredClone(document); change(d); assert.throws(() => normalizeChatAttachments([d])) }
  reject(d => { d.document.sections[0].image.mime = 'image/png' })
  reject(d => { d.document.sections[0].image.size++ })
  reject(d => { d.document.sections[0].image.data = url(jpeg.subarray(0,24),'image/jpeg'); d.document.sections[0].image.size=24 })
  reject(d => { d.document.sections = Array.from({length:41},()=>structuredClone(d.document.sections[0])) })
  // Insert valid JPEG comment segments to test the actual aggregate byte cap.
  const padded = size => {
    const chunks = [jpeg.subarray(0,2)]; let remaining = size - jpeg.length
    while (remaining) { const length = Math.min(remaining, 65537); assert.ok(length >= 4); const chunk = Buffer.alloc(length); chunk[0]=255;chunk[1]=254;chunk.writeUInt16BE(length-2,2);chunks.push(chunk);remaining-=length }
    return Buffer.concat([...chunks,jpeg.subarray(2)])
  }
  const bytes = padded(DOCUMENT_MAX_IMAGE_BYTES / 2 + 1)
  const image = {mime:'image/jpeg',size:bytes.length,data:url(bytes,'image/jpeg')}
  assert.throws(() => normalizeChatAttachments([makeDocument([{label:'1',text:'',image},{label:'2',text:'',image}])]))
  assert.deepEqual(providerImageContent([document]), [], 'PDF is never an image_url')
})

test('read_attachment pages the full text including long original sections without dropping tails', t => {
  const db=fixture(t), sections=[{label:'long',text:'A'.repeat(13003)+'尾部'}, {label:'second',text:'B'.repeat(7001)}, {label:'end',text:'最后一段'}]
  const message=db.appendMessage({conversationId:'main',role:'user',content:'只读',attachments:[makeDocument(sections)]})
  let args={messageId:message.id}, loops=0; const all=sections.map(()=> '')
  do { const result=readAttachment(db,'main',args); assert.ok(result.sectionRefs.length<=2)
    for(const ref of result.sectionRefs){assert.ok(ref.text.length<=6000);all[ref.sectionIndex]+=ref.text;assert.equal(ref.messageId,message.id)}
    args=result.readMore;assert.ok(++loops<10)
  } while(args)
  assert.deepEqual(all,sections.map(s=>s.text))
  for(const patch of [{offset:-1},{offset:3},{limit:3},{charOffset:15000},{charOffset:0.1},{offset:'0'}]) assert.throws(()=>readAttachment(db,'main',{messageId:message.id,...patch}))
})

test('attachment reads and source images reject cross-conversation, hidden/retracted and forged refs', async t => {
  const db=fixture(t), other=db.createConversation({title:'other'}), doc=makeDocument([{label:'scan',text:'',image:scan()}])
  const source=db.appendMessage({conversationId:'main',role:'user',content:'读',attachments:[doc]})
  assert.equal(conversationHasDocuments(db,'main'),true);assert.equal(conversationHasDocuments(db,other.id),false)
  assert.throws(()=>readAttachment(db,other.id,{messageId:source.id}))
  const args={messageId:source.id}, native=call('read_attachment',args), outcome=readAttachment(db,'main',args)
  const results=[{toolCallId:native.id,content:JSON.stringify(outcome)}]
  assert.equal(attachmentImages(db,'main',[native],results).role,'user')
  assert.equal(attachmentImages(db,other.id,[native],results),null)
  for (const hidden of [{excludeFromContext:true},{contextRetractedAt:'2026-10-20T00:00:00Z'}]) {
    const view={...db,getMessage:id=>({...db.getMessage(id),...hidden})}
    assert.throws(()=>readAttachment(view,'main',args))
    assert.equal(attachmentImages(view,'main',[native],results),null)
  }
  const forged=structuredClone(outcome);forged.sectionRefs[0].sectionIndex=100
  assert.equal(attachmentImages(db,'main',[native],[{toolCallId:native.id,content:JSON.stringify(forged)}]),null)
  assert.equal(attachmentImages(db,'main',[native],[{toolCallId:native.id,content:JSON.stringify({...outcome,ok:false})}]),null)
  const assistant=db.appendMessage({conversationId:'main',role:'assistant',content:'not a user document'})
  assert.throws(()=>readAttachment(db,'main',{messageId:assistant.id}))
  db.retractMessage(source.id)
  let rejected=false
  const revoked=createXixi({db,complete:async payload=>{
    if(!payload.messages.some(m=>m.role==='tool')) return toolsReply([call('read_attachment',{messageId:source.id})])
    const outcome=JSON.parse(payload.messages.findLast(m=>m.role==='tool').content)
    assert.equal(outcome.ok,false);assert.match(outcome.error,/不可见|撤回/);rejected=true
    return reply('已撤回的资料不可读取。')
  }})
  assert.equal((await revoked.chat(input([makeDocument()]))).status,'completed');assert.equal(rejected,true)
  const visibleUser=db.listMessages('main',{limit:1000}).findLast(m=>m.role==='user'&&!m.retractedAt)
  db.retractMessage(visibleUser.id)
  assert.throws(()=>readAttachment(db,'main',args));assert.equal(attachmentImages(db,'main',[native],results),null)
  assert.equal(conversationHasDocuments(db,'main'),false)
})

test('short documents enter text context with data-only instructions, raw bytes remain local and replies stay natural', async t => {
  const db=fixture(t), doc=makeDocument([{label:'正文',text:'合成材料：第一行\n第二行'}]), requests=[]
  const answer='第二行承接第一行，表达的是同一份合成材料。'
  const xixi=createXixi({db,complete:async payload=>{requests.push(payload);return reply(answer)}})
  const result=await xixi.chat(input([doc]))
  assert.equal(result.status,'completed'); assert.equal(result.messages.at(-1).content,answer)
  const user=requests[0].messages.find(m=>m.role==='user')
  assert.equal(typeof user.content,'string');assert.match(user.content,/附件正文已完整提供/);assert.match(user.content,/第一行\n第二行/)
  assert.ok(requests[0].tools.some(t=>t.function.name==='read_attachment'))
  assert.ok(requests[0].messages.some(m=>m.role==='system'&&/没有操作授权/.test(m.content)))
  assert.equal(JSON.stringify(requests).includes(doc.data),false)
  assert.deepEqual(result.messages.find(m=>m.role==='user').attachments,[doc])
})

test('mock provider retrieves all long-document pages via continuation args', async t => {
  const db=fixture(t), text='0123456789'.repeat(1500)+'END-TAIL', doc=makeDocument([{label:'long original page',text}]);let turn=0, collected=''
  const request=input([doc]), messageId=`${request.requestId}:user`
  const xixi=createXixi({db,complete:async payload=>{
    assertNativePairs(payload.messages)
    const results=payload.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content)).filter(m=>m.type==='attachment_read')
    if(!turn++)return toolsReply([call('read_attachment',{messageId})])
    const last=results.at(-1);collected+=last.sectionRefs.map(s=>s.text).join('')
    return last.readMore?toolsReply([call('read_attachment',last.readMore)]):reply('全部段落已读，保留原文意思。')
  }})
  const result=await xixi.chat(request)
  assert.equal(result.status,'completed');assert.equal(collected,text);assert.equal(turn,4)
})

test('scan pages become user vision input only after a complete parallel native batch', async t => {
  const db=fixture(t), doc=makeDocument([{label:'scan1',text:'',image:scan()},{label:'scan2',text:'',image:scan()}]), requests=[]
  const request=input([doc]), messageId=`${request.requestId}:user`
  const batch=[call('read_attachment',{messageId,offset:0,limit:1}),call('read_current_time',{}),call('read_attachment',{messageId,offset:1,limit:1})]
  const xixi=createXixi({db,complete:async payload=>{
    requests.push(payload);assertNativePairs(payload.messages)
    if(requests.length===1){assert.equal(imagesIn(payload).length,0);return toolsReply(batch)}
    const i=payload.messages.findIndex(m=>m.tool_calls?.length===3)
    const visual=payload.messages[i+4]
    assert.equal(visual.role,'user');assert.ok(Array.isArray(visual.content))
    assert.equal(imagesIn({messages:[visual]}).length,2)
    assert.deepEqual(imagesIn({messages:[visual]}).map(i=>i.image_url.url),[scan().data,scan().data])
    for(const result of payload.messages.slice(i+1,i+4)){assert.equal(result.role,'tool');assert.equal(result.content.includes('base64'),false)}
    return reply('图像页的内容已收到，模糊处需要核对。')
  }})
  const result=await xixi.chat(request);assert.equal(result.status,'completed')
  const persisted=db.listMessages('main',{limit:1000})
  assert.equal(persisted.filter(m=>m.role==='user').length,1,'synthetic provider images are not duplicate persisted user messages')
  for(const tool of persisted.filter(m=>m.role==='tool'&&JSON.parse(m.content).type==='attachment_read'))assert.ok(tool.sourceMessageIds.includes(messageId))
})

test('document tools deny another conversation and retracted sources through the actual tool loop', async t => {
  const db=fixture(t), source=db.appendMessage({conversationId:'main',role:'user',content:'资料',attachments:[makeDocument()]}), other=db.createConversation({title:'other'})
  let n=0
  const request={...input([makeDocument()]),conversationId:other.id}
  const xixi=createXixi({db,complete:async payload=>{
    if(!n++)return toolsReply([call('read_attachment',{messageId:source.id})])
    const outcome=JSON.parse(payload.messages.findLast(m=>m.role==='tool').content)
    assert.equal(outcome.ok,false);assert.match(outcome.error,/不可见|撤回/)
    return reply('只能读取此对话里的资料。')
  }})
  assert.equal((await xixi.chat(request)).status,'completed')
  db.retractMessage(source.id)
  let provided=false
  const ordinary=createXixi({db,complete:async payload=>{provided=payload.tools.some(t=>t.function.name==='read_attachment');return reply('普通聊天。')}})
  await ordinary.chat(input(undefined,'你好'));assert.equal(provided,false)
})

test('original attachment, failed scan retry and backup restore keep raw bytes and paired vision context', async t => {
  const db=fixture(t), doc=makeDocument([{label:'扫描',text:'',image:scan()}]), request=input([doc]);let n=0
  const xixi=createXixi({db,complete:async payload=>{
    assertNativePairs(payload.messages)
    if(!n++)return toolsReply([call('read_attachment',{messageId:`${request.requestId}:user`})])
    assert.equal(imagesIn(payload).length,1)
    if(n===2)throw Error('synthetic offline failure')
    return reply('重试后仍然读取同一份资料。')
  }})
  const failed=await xixi.chat(request);assert.equal(failed.status,'failed')
  assert.deepEqual(db.getTurn(request.requestId).attachments,[doc])
  const retried=await xixi.chat(request);assert.equal(retried.status,'completed');assert.equal(n,3)
  assert.equal(db.listMessages('main',{limit:1000}).filter(m=>m.role==='user').length,1)
  assert.deepEqual(db.getMessage(`${request.requestId}:user`).attachments,[doc])
  const backup=db.exportData(), target=fixture(t)
  assert.equal(target.importData(backup).restored,true)
  assert.deepEqual(target.getMessage(`${request.requestId}:user`).attachments,[doc])
  assert.deepEqual(target.getTurn(request.requestId).attachments,[doc])
  assert.equal(readAttachment(target,'main',{messageId:`${request.requestId}:user`}).sectionRefs[0].hasImage,true)
})

test('partially persisted native tool batches recover all results before scan image insertion', async t => {
  const db=fixture(t), doc=makeDocument([{label:'scan',text:'',image:scan()}]), request=input([doc])
  const turn=db.beginTurn(request), messageId=turn.userMessageId
  const batch=[call('read_attachment',{messageId}),call('read_current_time',{})]
  const assistant=db.appendMessage({conversationId:'main',requestId:request.requestId,role:'assistant',content:'',
    reasoningContent:'按原始附件继续。',toolCalls:batch,sourceMessageIds:[messageId]})
  db.appendMessage({conversationId:'main',requestId:request.requestId,role:'tool',toolCallId:batch[0].id,
    content:JSON.stringify(readAttachment(db,'main',{messageId})),sourceMessageIds:[messageId,assistant.id]})
  db.finishTurn(request.requestId,{status:'failed',error:'synthetic interrupted batch'})
  let count=0
  const xixi=createXixi({db,complete:async payload=>{
    count++;assertNativePairs(payload.messages)
    const index=payload.messages.findIndex(m=>m.tool_calls?.length===2)
    assert.equal(payload.messages[index+3].role,'user')
    assert.equal(imagesIn({messages:[payload.messages[index+3]]}).length,1)
    const sourceIndex=payload.messages.find(m=>m.role==='system'&&m.content.startsWith('以下对话的出处与发送时间：'))
    const sources=JSON.parse(sourceIndex.content.slice('以下对话的出处与发送时间：'.length))
    assert.equal(sources.length,payload.messages.filter(m=>m.role!=='system').length)
    assert.ok(sources.some(s=>s.documentImages===true))
    return reply('已恢复原附件的读取结果。')
  }})
  assert.equal((await xixi.chat(request)).status,'completed');assert.equal(count,1)
  assert.equal(db.listMessages('main',{limit:1000}).filter(m=>m.role==='tool').length,2)
})

test('ordinary JPEG keeps the original vision path without the document schema or PDF payload', async t => {
  const db=fixture(t), image={name:'ordinary.jpg',...scan()};let payload
  const xixi=createXixi({db,complete:async p=>{payload=p;return reply('看到了图片。')}})
  assert.equal((await xixi.chat(input([image],''))).status,'completed')
  assert.equal(payload.tools.some(t=>t.function.name==='read_attachment'),false)
  assert.deepEqual(payload.messages.find(m=>m.role==='user').content,[{type:'text',text:'请识别这张图片'},{type:'image_url',image_url:{url:image.data}}])
  assert.deepEqual(providerImageContent([makeDocument(),image]),[{type:'image_url',image_url:{url:image.data}}])
})

test('document availability scans once per request after append, and later requests refresh it', async t => {
  const db=fixture(t), listMessages=db.listMessages.bind(db)
  let scans=0, expectedId, rounds=0, documentsAvailable=true
  const wrapped={...db,listMessages(conversationId,options){
    if(options?.limit===1000&&options.forContext){
      scans++
      assert.ok(db.getMessage(expectedId),'availability must be initialized after current user append')
    }
    return listMessages(conversationId,options)
  }}
  const request=input([makeDocument()]);expectedId=`${request.requestId}:user`
  const xixi=createXixi({db:wrapped,complete:async payload=>{
    if(!documentsAvailable){
      assert.equal(scans,2)
      assert.equal(payload.tools.some(t=>t.function.name==='read_attachment'),false)
      return reply('普通回答。')
    }
    assert.equal(scans,1,'multiple tools/context budget computations reuse this request cache')
    assert.ok(payload.tools.some(t=>t.function.name==='read_attachment'))
    if(!rounds++)return toolsReply([call('read_attachment',{messageId:expectedId}),call('read_current_time',{})])
    return reply('读取完成。')
  }})
  assert.equal((await xixi.chat(request)).status,'completed');assert.equal(scans,1)
  db.retractMessage(expectedId)
  documentsAvailable=false
  const next=input(undefined,'再聊一个普通问题');expectedId=`${next.requestId}:user`
  assert.equal((await xixi.chat(next)).status,'completed');assert.equal(scans,2)
})

test('scan images and document excerpts are budgeted with an aligned source index at provider dispatch', async t => {
  const db=fixture(t), text='中文资料'.repeat(1600), request=input([makeDocument([{label:'scan',text,image:scan()}])])
  let round=0
  const xixi=createXixi({db,complete:async payload=>{
    const index=payload.messages.find(m=>m.role==='system'&&m.content.startsWith('以下对话的出处与发送时间：'))
    const sources=JSON.parse(index.content.slice('以下对话的出处与发送时间：'.length))
    const conversation=payload.messages.filter(m=>m.role!=='system')
    assert.equal(sources.length,conversation.length)
    for(let i=0;i<sources.length;i++)assert.equal(sources[i].role,conversation[i].role)
    const excerpt=payload.messages.find(m=>m.role==='user'&&typeof m.content==='string').content
    assert.ok(contextUnits(excerpt)>5500,'6k Chinese excerpt consumes the text budget')
    assert.ok(contextUnits(excerpt)<8000,'unread full document and original bytes are not counted as prose')
    if(!round++)return toolsReply([call('read_attachment',{messageId:`${request.requestId}:user`,limit:1})])
    const imageMessage=payload.messages.find(m=>m.role==='user'&&Array.isArray(m.content))
    assert.ok(imageMessage)
    assert.ok(contextUnits(imageMessage)>1200&&contextUnits(imageMessage)<1600,'vision input reserves its bounded image budget')
    const budget=contextUnits(payload.messages)+contextUnits(payload.tools)
    const fitted=fitContext(payload.messages,payload.tools,budget)
    assert.deepEqual(fitted,payload.messages);assertNativePairs(fitted)
    const imageIndex=conversation.indexOf(imageMessage)
    assert.equal(sources[imageIndex].documentImages,true)
    assert.equal(sources[imageIndex-1].id,db.listMessages('main',{limit:1000}).findLast(m=>m.role==='tool').id)
    return reply('已读取本段。')
  }})
  assert.equal((await xixi.chat(request)).status,'completed');assert.equal(round,2)
})

test('chat uses an explicit 32 MiB wire cap independently of normalized document limits', () => {
  assert.equal(CHAT_REQUEST_MAX_BYTES,32*1024*1024)
  assert.equal(localRequestLimit('/api/chat?stream=1').bytes,CHAT_REQUEST_MAX_BYTES)
  assert.equal(localRequestLimit('/api/tasks').bytes,4*1024*1024)
})

test('HTTP chat accepts the exact body cap and rejects larger chunked JSON atomically without truncation', async t => {
  const db=fixture(t), requests=[]
  saveModelSettings(db,{provider:'local',cloudModel:'deepseek-flash',reasoningEffort:'low',streamResponses:false,
    contextBudget:{mode:'auto',maxUnits:48000},webSearch:{enabled:false,maxUses:2},
    local:{engine:'ollama',baseUrl:'http://127.0.0.1:11434/v1',model:'mock-vision'}})
  const forbidden=()=>{throw Error('must not access credentials or a real provider')}
  const service=createLocalService({db,vault:{status:forbidden,read:forbidden},complete:async payload=>{requests.push(payload);return reply('完整接收。')}})
  t.after(()=>service.close())
  const invoke=raw=>new Promise(resolve=>{
    const bytes=Buffer.from(raw)
    const req=Readable.from((function*(){for(let at=0;at<bytes.length;at+=65537)yield bytes.subarray(at,at+65537)})())
    req.url='/api/chat';req.method='POST';req.socket={remoteAddress:'127.0.0.1',localPort:5188}
    req.headers={host:'127.0.0.1:5188',origin:'http://127.0.0.1:5188','x-astaria-local':'1','content-type':'application/json'}
    const res={statusCode:200,setHeader(){},end(body){resolve({status:this.statusCode,body:JSON.parse(body)})}}
    service.middleware(req,res,()=>resolve({status:404}))
  })
  const document=makeDocument([{label:'正文',text:'中文原文与尾部\n完整保留'}]), request=input([document])
  const json=JSON.stringify(request), exact=json+' '.repeat(CHAT_REQUEST_MAX_BYTES-Buffer.byteLength(json))
  const accepted=await invoke(exact)
  assert.equal(accepted.status,200);assert.equal(accepted.body.status,'completed');assert.equal(requests.length,1)
  assert.deepEqual(db.getMessage(`${request.requestId}:user`).attachments,[document])
  const next=input([document]), nextJSON=JSON.stringify(next)
  const rejected=await invoke(nextJSON+' '.repeat(CHAT_REQUEST_MAX_BYTES+1-Buffer.byteLength(nextJSON)))
  assert.equal(rejected.status,413);assert.match(rejected.body.error,/聊天内容过多/)
  assert.equal(requests.length,1);assert.equal(db.getTurn(next.requestId),null)
})
