import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'

const call = (name, args) => ({ choices: [{ message: { content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const input = text => ({ conversationId: 'questions', requestId: randomUUID(), text, context: { page: 'home', timezone: 'Asia/Shanghai' } })

test('a concrete question persists clickable choices and waits without guessing task facts', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  let requests = 0
  const xixi = createXixi({ db, complete: async () => { requests++; return call('ask_user', { prompt: '明天具体几点前交？', options: ['中午前', '下午六点前', '还没定'] }) } })
  const request = input('明天交机器人社测试')
  const result = await xixi.chat(request)
  assert.equal(result.status, 'completed')
  assert.equal(requests, 1)
  assert.equal(db.listTasks().length, 0)
  assert.deepEqual(result.messages.at(-1).question, { options: ['中午前', '下午六点前', '还没定'] })
  assert.equal(result.messages.at(-1).content, '明天具体几点前交？')
  const replay = await xixi.chat(request)
  assert.equal(replay.messages.at(-1).id, result.messages.at(-1).id)
  assert.equal(requests, 1)
})

test('the chosen answer arrives with its question and original options as conversation context', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const requests = []
  const xixi = createXixi({ db, complete: async request => {
    requests.push(request)
    return requests.length === 1 ? call('ask_user', { prompt: '先留多少时间？', options: ['先看题十分钟', '大约一小时'] }) : reply('好，先看看题目')
  } })
  await xixi.chat(input('估一下这个测试'))
  await xixi.chat(input('先看题十分钟'))
  const context = requests[1].messages
  assert.ok(context.some(message => message.role === 'assistant' && message.content.includes('先留多少时间？') && message.content.includes('大约一小时')))
  assert.equal(context.at(-1).content, '先看题十分钟')
})

test('invalid or duplicate options are rejected and can be repaired before display', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  let requests = 0
  const xixi = createXixi({ db, complete: async () => ++requests === 1
    ? call('ask_user', { prompt: '多久？', options: ['半小时', '半小时'] })
    : call('ask_user', { prompt: '大概要多久？', options: ['半小时', '一小时'] }) })
  const result = await xixi.chat(input('帮我估时'))
  assert.equal(result.status, 'completed')
  assert.equal(result.messages.filter(message => message.question).length, 1)
  assert.deepEqual(result.messages.at(-1).question.options, ['半小时', '一小时'])
  assert.equal(requests, 2)
})

test('facts can be saved before asking a missing detail, without inventing an estimate', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  let requests = 0
  const xixi = createXixi({ db, complete: async () => ++requests === 1
    ? call('create_tasks', { tasks: [{ title: '招新测试', due: '2026-09-19' }] })
    : call('ask_user', { prompt: '记好了，明天具体几点前交？', options: ['下午六点前', '还没定'] }) })
  const result = await xixi.chat(input('明天交招新测试'))
  assert.equal(result.status, 'completed')
  assert.equal(result.operations.length, 1)
  assert.equal(db.listTasks()[0].estimateMin, undefined)
  assert.ok(result.messages.at(-1).question)
})

test('concrete timetable wording cannot fall back to a new clarification question', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const requests = []
  const xixi = createXixi({ db, complete: async request => {
    requests.push(request)
    return requests.length === 1
      ? call('ask_user', { prompt: '哪种排法？', options: ['方案一', '方案二'] })
      : reply('我会先读取周一课表，再按你给出的顺序处理')
  } })
  const result = await xixi.chat(input('每周一 12:45 是英语课，后面一节是 PHY2'))
  assert.equal(result.status, 'completed')
  assert.equal(result.messages.some(message => message.question), false)
  assert.equal(requests.length, 2)
})
