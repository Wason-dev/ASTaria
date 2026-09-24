import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-18', TOMORROW = '2026-09-19'
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const call = (name, args) => ({ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } })
const tools = (...toolCalls) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: toolCalls } }] })
const receipt = payload => JSON.parse(payload.messages.findLast(message => message.role === 'tool').content)
const chatInput = (text, context = {}, conversationId = 'main') => ({ requestId: randomUUID(), conversationId, text,
  context: { timezone: 'Asia/Shanghai', page: 'timetable', date: DATE, ...context } })
const placement = ({ taskId, date, start, end }) => ({ taskId, date, start, end })
const byTime = (a, b) => a.start.localeCompare(b.start)
const byId = (a, b) => a.id.localeCompare(b.id)
const pending = payload => {
  const message = payload.messages.find(message => message.content?.startsWith('本轮待完成日历事项（逐项核验）：'))
  return message ? JSON.parse(message.content.slice(message.content.indexOf('：') + 1)) : []
}

// Exercise the same request validation, JSON parsing and response projections
// as HTTP without listening on a port or opening the user's database/keychain.
function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(`${DATE}T17:00:00+08:00`).getTime() })
  const directory = mkdtempSync(join(tmpdir(), 'astaria-execution-acceptance-'))
  const filename = join(directory, 'acceptance.sqlite')
  const responses = [], requests = [], callbackErrors = []
  const complete = async payload => {
    requests.push(structuredClone(payload))
    if (!responses.length) {
      const error = new Error('the simulated provider must have an explicit response for every round')
      callbackErrors.push(error)
      throw error
    }
    const next = responses.shift()
    if (next instanceof Error) throw next
    try { return typeof next === 'function' ? await next(payload) : next }
    catch (error) { callbackErrors.push(error); throw error }
  }
  const open = () => createLocalService({ db: createDatabase(filename), complete, dataDirectory: directory,
    vault: { status: async () => true, read: async () => { throw new Error('acceptance test must not read credentials') } },
    fetcher: async () => { throw new Error('acceptance test must not make network requests') } })
  let service = open()
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }) })
  const request = async (path, payload) => {
    const result = await new Promise(resolve => {
      const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))])
      req.url = `/api${path}`
      req.method = payload === undefined ? 'GET' : 'POST'
      req.socket = { remoteAddress: '127.0.0.1', localPort: 5188 }
      req.headers = { host: '127.0.0.1:5188', origin: 'http://127.0.0.1:5188', 'x-astaria-local': '1',
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }
      const headers = {}
      const res = { statusCode: 200, setHeader(name, value) { headers[name.toLowerCase()] = value },
        end(raw) { resolve({ status: this.statusCode, value: JSON.parse(raw), headers }) } }
      service.middleware(req, res, () => resolve({ status: 404, value: null, headers }))
    })
    assert.deepEqual(callbackErrors, [], 'provider callback assertions must not be swallowed as simulated outages')
    assert.equal(result.headers['cache-control'], 'no-store')
    return result
  }
  const ok = async (path, payload) => {
    const response = await request(path, payload)
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(response.value)}`)
    return response.value
  }
  const plannerAction = async action => ok('/planner', { expectedRevision: (await ok('/planner')).revision, action })
  return { responses, requests, request, ok, plannerAction, restart() { service.close(); service = open() } }
}

async function publicState(f, chat) {
  const conversation = await f.ok(`/conversation?id=${chat.conversationId}`)
  assert.deepEqual(conversation.messages, chat.messages)
  assert.deepEqual(conversation.operations, chat.operations)
  assert.equal(new Set(chat.messages.map(message => message.id)).size, chat.messages.length)
  assert.equal(new Set(chat.operations.map(operation => operation.id)).size, chat.operations.length)
  assert.ok(chat.messages.every(message => message.role !== 'tool' && !message.toolCalls))
  assert.ok(chat.operations.every(operation => operation.changes === undefined && operation.plannerBefore === undefined))
  return { tasks: await f.ok('/tasks'), planner: await f.ok('/planner'), conversation }
}

test('HTTP flow: interrupted math/physics rescheduling survives restart and retry commits only the missing item', async t => {
  const f = fixture(t)
  const math = await f.ok('/tasks/create', { title: '数学', estimateMin: 60 })
  const physics = await f.ok('/tasks/create', { title: '物理', estimateMin: 60 })
  await f.plannerAction({ type: 'save-routine', routine: { id: 'dorm', title: '宿舍', kind: 'available',
    weekdays: [5], start: '20:00', end: '23:00', location: '宿舍', items: [], enabled: true } })
  for (const block of [
    { id: 'math-plan', taskId: math.id, date: DATE, start: '21:00', end: '22:00', locked: false },
    { id: 'physics-plan', taskId: physics.id, date: DATE, start: '20:00', end: '21:00', locked: false },
  ]) await f.plannerAction({ type: 'save-block', block })
  const input = chatInput('数学缩21–21:30，物理21:30–22:30')
  f.responses.push(tools(call('read_planner', { date: DATE })), payload => tools(call('plan_tasks', {
    expectedRevision: receipt(payload).revision,
    plans: [{ id: 'math-plan', taskId: math.id, date: DATE, start: '21:00', end: '21:30' }],
  })), new Error('simulated interruption after math was committed'))
  const first = await f.ok('/chat', input)
  assert.equal(first.status, 'failed')
  assert.equal(first.execution.status, 'partial')
  assert.equal(first.operations.length, 1)
  assert.equal(first.messages.filter(message => message.role === 'user').length, 1)
  assert.equal(first.messages.filter(message => message.role === 'assistant').length, 0)
  assert.match(first.error, /日历|重试|未完成/u)
  const states = new Map(first.execution.scheduleRequirements.map(item => [item.taskId, item.status]))
  assert.equal(states.get(math.id), 'verified')
  assert.equal(states.get(physics.id), 'pending')
  const partial = await publicState(f, first)
  assert.deepEqual(partial.tasks.toSorted(byId), [math, physics].toSorted(byId))
  assert.deepEqual(partial.planner.blocks.map(placement).sort(byTime), [
    { taskId: physics.id, date: DATE, start: '20:00', end: '21:00' },
    { taskId: math.id, date: DATE, start: '21:00', end: '21:30' },
  ])
  const mathCommit = first.operations[0]
  assert.ok(mathCommit.details.includes(`${DATE} 21:00–21:30`))

  f.restart()
  assert.deepEqual((await f.ok('/conversation?id=main')).operations, first.operations)
  assert.deepEqual(await f.ok('/planner'), partial.planner)
  const beforeRetry = f.requests.length
  f.responses.push(payload => {
    assert.deepEqual(pending(payload).map(item => item.taskId), [physics.id])
    return tools(call('read_planner', { date: DATE }))
  }, payload => tools(call('plan_tasks', { expectedRevision: receipt(payload).revision,
    plans: [{ id: 'physics-plan', taskId: physics.id, date: DATE, start: '21:30', end: '22:30' }],
  })), reply('数学已缩到21:00–21:30，物理已排21:30–22:30。'))
  const resumed = await f.ok('/chat', input)
  assert.equal(resumed.status, 'completed')
  assert.equal(resumed.execution.status, 'verified')
  assert.ok(resumed.execution.scheduleRequirements.every(item => item.status === 'verified'))
  assert.equal(f.requests.length - beforeRetry, 3)
  assert.equal(resumed.operations.length, 2)
  assert.deepEqual(resumed.operations.find(operation => operation.id === mathCommit.id), mathCommit)
  assert.equal(resumed.messages.filter(message => message.role === 'user').length, 1)
  assert.equal(resumed.messages.filter(message => message.role === 'assistant').length, 1)
  const final = await publicState(f, resumed)
  assert.deepEqual(final.tasks.toSorted(byId), [math, physics].toSorted(byId))
  assert.equal(final.planner.revision, partial.planner.revision + 1, 'retry must write only the missing physics change')
  assert.deepEqual(final.planner.blocks.map(placement).sort(byTime), [
    { taskId: math.id, date: DATE, start: '21:00', end: '21:30' },
    { taskId: physics.id, date: DATE, start: '21:30', end: '22:30' },
  ])
  const providerCount = f.requests.length
  assert.deepEqual(await f.ok('/chat', input), resumed)
  assert.equal(f.requests.length, providerCount)
  assert.deepEqual(await f.ok('/planner'), final.planner)
  assert.equal(f.responses.length, 0)
})

test('HTTP flow: PSEC creation and its first placement share one receipt while moving an existing exam remains separate; undo stays undone on replay', async t => {
  const f = fixture(t)
  const exam = await f.ok('/tasks/create', { title: '考试', estimateMin: 30 })
  await f.plannerAction({ type: 'save-block', block: { id: 'exam-plan', taskId: exam.id,
    date: TOMORROW, start: '17:30', end: '18:00', locked: false } })
  const slot = { date: TOMORROW, start: '17:15', end: '18:00' }
  const input = chatInput('明天17:15–18:00 PSEC社团活动，考试移18:30–1900', { date: TOMORROW })
  f.responses.push(tools(call('read_planner', { date: TOMORROW })), payload => tools(call('plan_tasks', {
    expectedRevision: receipt(payload).revision,
    plans: [{ id: 'exam-plan', taskId: exam.id, date: TOMORROW, start: '18:30', end: '19:00' }],
  })), tools(call('read_planner', { date: TOMORROW })), payload => tools(call('create_tasks', {
    expectedRevision: receipt(payload).revision, tasks: [{ title: 'PSEC社团活动', schedule: slot }],
  })), reply('PSEC社团活动已排17:15–18:00，考试已移18:30–19:00。'))
  const result = await f.ok('/chat', input)
  assert.equal(result.status, 'completed')
  assert.equal(result.execution.status, 'verified')
  assert.ok(result.execution.scheduleRequirements.every(item => item.status === 'verified'))
  assert.equal(result.operations.length, 2)
  const saved = await publicState(f, result)
  assert.equal(saved.tasks.length, 2)
  const activity = saved.tasks.find(task => task.title === 'PSEC社团活动')
  assert.ok(activity)
  assert.deepEqual(saved.planner.blocks.map(placement).sort(byTime), [
    { taskId: activity.id, ...slot },
    { taskId: exam.id, date: TOMORROW, start: '18:30', end: '19:00' },
  ])
  assert.ok(result.operations.some(operation => operation.details.some(detail => detail.includes(`${TOMORROW} 17:15–18:00`))))
  assert.ok(result.operations.some(operation => operation.details.includes(`${TOMORROW} 18:30–19:00`)))
  const creation = result.operations.find(operation => operation.createdTasks.some(task => task.id === activity.id))
  assert.ok(creation)
  assert.equal(creation.undoLabel, '撤销创建与安排')
  assert.equal(creation.relatedOperationIds.length, 1)
  assert.ok(creation.details.some(detail => detail.includes(`${TOMORROW} 17:15–18:00`)))
  assert.equal(result.operations.some(operation => creation.relatedOperationIds.includes(operation.id)), false)
  const undone = await f.ok(`/operations/${creation.id}/undo`, {})
  assert.ok(undone.undoneAt)
  assert.deepEqual(await f.ok('/tasks'), [exam])
  assert.equal(await f.ok(`/tasks/${activity.id}`), null)
  const afterUndo = await f.ok('/planner')
  assert.deepEqual(afterUndo.blocks.map(placement), [{ taskId: exam.id, date: TOMORROW, start: '18:30', end: '19:00' }])
  f.restart()
  const providerCount = f.requests.length
  const replay = await f.ok('/chat', input)
  assert.equal(f.requests.length, providerCount)
  assert.equal(replay.operations.length, 2)
  assert.equal(replay.operations.filter(operation => operation.undoneAt).length, 1)
  assert.ok(replay.operations.find(operation => operation.id === creation.id).undoneAt)
  assert.equal(replay.messages.filter(message => message.role === 'user').length, 1)
  const reloaded = await publicState(f, replay)
  assert.deepEqual(reloaded.tasks, [exam])
  assert.deepEqual(reloaded.planner, afterUndo)
  assert.equal(f.responses.length, 0)
})

test('HTTP flow: saved task steps, checked progress and undo survive reload without duplicate tasks or revived edits', async t => {
  const f = fixture(t)
  const task = await f.ok('/tasks/create', { title: 'SAT', due: '2026-09-23', estimateMin: 90, inbox: false })
  const context = { page: 'workbench', taskId: task.id }
  const titles = ['R0211-可汗机考阅读-2B', 'M1157-几何学-3A', 'M1107-表达和应用题-3A', 'M1169-统计学-3A']
  const input = chatInput(`SAT有这些具体任务：${titles.join(' ')}`, context)
  f.responses.push(tools(call('read_task_steps', { taskId: task.id })), payload => tools(call('save_task_steps', {
    taskId: task.id, expectedUpdatedAt: receipt(payload).task.updatedAt, steps: titles.map(title => ({ title })),
  })), reply('四个步骤已保存到SAT，可以逐项勾选。'))
  const saved = await f.ok('/chat', input)
  assert.equal(saved.status, 'completed')
  assert.equal(saved.operations.length, 1)
  const initial = await publicState(f, saved)
  assert.equal(initial.tasks.length, 1)
  assert.deepEqual(initial.tasks[0].subSteps.map(step => step.title), titles)
  assert.equal(new Set(initial.tasks[0].subSteps.map(step => step.id)).size, 4)
  const checked = await f.ok('/tasks/steps/check', { taskId: task.id, stepId: initial.tasks[0].subSteps[0].id,
    checked: true, expectedUpdatedAt: initial.tasks[0].updatedAt })
  assert.ok(checked.subSteps[0].doneAt)
  assert.equal(checked.status, 'todo')
  assert.equal(checked.due, task.due)
  assert.deepEqual(await f.ok(`/tasks/${task.id}`), checked)
  f.restart()
  assert.deepEqual(await f.ok('/tasks'), [checked])
  f.responses.push(tools(call('read_task_steps', { taskId: task.id })), payload => {
    const read = receipt(payload)
    assert.equal(read.completed, 1)
    assert.equal(read.total, 4)
    assert.equal(read.steps[0].doneAt, checked.subSteps[0].doneAt)
    assert.deepEqual(read.steps.map(step => step.id), checked.subSteps.map(step => step.id))
    return reply('第一项已完成，还剩三个步骤。')
  })
  const reread = await f.ok('/chat', chatInput('我到哪一步了', context, 'fresh-progress'))
  assert.equal(reread.status, 'completed')
  await publicState(f, reread)
  assert.equal((await f.request(`/operations/${saved.operations[0].id}/undo`, {})).status, 409,
    'an old AI save cannot erase a later manual check')
  assert.deepEqual(await f.ok(`/tasks/${task.id}`), checked)

  const refinement = chatInput('第一步标题后面补上复核，其余步骤不变', context)
  f.responses.push(tools(call('read_task_steps', { taskId: task.id })), payload => tools(call('save_task_steps', {
    taskId: task.id, expectedUpdatedAt: receipt(payload).task.updatedAt,
    steps: checked.subSteps.map(({ id, title }, index) => ({ id, title: index ? title : `${title}复核` })),
  })), reply('标题已更新，完成进度保留。'))
  const refined = await f.ok('/chat', refinement)
  assert.equal(refined.status, 'completed')
  const edit = refined.operations.find(operation => operation.requestId === refinement.requestId)
  assert.ok(edit)
  const updated = await f.ok(`/tasks/${task.id}`)
  assert.equal(updated.subSteps[0].title, `${titles[0]}复核`)
  assert.equal(updated.subSteps[0].doneAt, checked.subSteps[0].doneAt)
  assert.ok((await f.ok(`/operations/${edit.id}/undo`, {})).undoneAt)
  const restored = await f.ok(`/tasks/${task.id}`)
  assert.deepEqual(restored.subSteps, checked.subSteps)
  f.restart()
  const providerCount = f.requests.length
  const replay = await f.ok('/chat', refinement)
  assert.equal(f.requests.length, providerCount)
  assert.ok(replay.operations.find(operation => operation.id === edit.id).undoneAt)
  const state = await publicState(f, replay)
  assert.deepEqual(state.tasks, [restored])
  assert.equal(state.planner.blocks.length, 0)
  assert.equal(state.conversation.messages.filter(message => message.requestId === refinement.requestId && message.role === 'user').length, 1)
  assert.equal(f.responses.length, 0)
})
