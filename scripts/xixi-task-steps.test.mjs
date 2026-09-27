import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi, contextUnits, HARD_INPUT_UNITS } from '../server/xixi.mjs'
import { toggleTaskStep } from '../server/taskSteps.mjs'

const call = (name, args) => ({ choices: [{ message: { content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const reply = text => ({ choices: [{ message: { role: 'assistant', content: text } }] })
const environment = request => JSON.parse(request.messages.find(m => m.content?.startsWith('当前环境与数据库资料')).content.split('\n').slice(1).join('\n'))
const outcomes = request => request.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content))
function fixture(t, title = 'Agentic AI 开学作业') {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const task = db.createTask({ title, due: '2026-09-23', estimateMin: 90, inbox: false })
  const request = (text, extras = {}) => ({ requestId: randomUUID(), conversationId: 'steps', text, context: { page: 'workbench', taskId: task.id, timezone: 'Asia/Shanghai' }, ...extras })
  const prompts = [], responses = []
  const xixi = createXixi({ db, complete: async payload => { prompts.push(payload); const next = responses.shift(); if (next instanceof Error) throw next; return typeof next === 'function' ? next(payload) : next ?? reply('从第一步来') } })
  const save = steps => call('save_task_steps', { taskId: task.id, expectedUpdatedAt: db.getTask(task.id).updatedAt, steps })
  return { db, task, request, prompts, responses, xixi, save }
}
const assignment = [
  { title: '加入班级群', detail: '群昵称改为真实姓名-班级，保存截图' },
  { title: '加入 Google Classroom', detail: '用户名与 MB 一致，保存截图' },
  { title: '准备 Python 3.13 与 Jupyter' },
  { title: '跑通环境检查 notebook', detail: '逐个运行单元格，保存 L1_env_check.ipynb' },
  { title: '跑通 Python 基础 notebook' },
  { title: '完成 WorkBuddy 小练习', detail: '运行不超过10行的代码，截图避开Key' },
  { title: '核对并提交材料', detail: '三张截图与两份已运行的 notebook' },
]

test('focused assignment becomes durable checkable parts on the same task with receipt and undo', async t => {
  const f = fixture(t)
  f.responses.push(call('read_task_steps', { taskId: f.task.id }), () => f.save(assignment), reply('拆好了，先从第一步来'))
  const result = await f.xixi.chat(f.request('帮我把这份作业拆成几步：加入班级群、Classroom，准备Python环境，完成两份notebook和WorkBuddy练习，提交材料'))
  assert.equal(result.status, 'completed'); assert.equal(result.operations.length, 1)
  const saved = f.db.getTask(f.task.id)
  assert.equal(f.db.listTasks().length, 1)
  assert.equal(saved.subSteps.length, 7)
  assert.ok(saved.subSteps.every(s => s.id && !s.doneAt))
  assert.equal(new Set(saved.subSteps.map(s => s.id)).size, 7)
  assert.equal(saved.status, f.task.status); assert.equal(saved.due, f.task.due)
  assert.equal(environment(f.prompts[2]).selectedTask.steps.total, 7)
  f.db.undoOperation(result.operations[0].id)
  assert.equal(f.db.getTask(f.task.id).subSteps, undefined)
})

test('bound SAT details persist exactly four user-supplied parts and retain checked progress', async t => {
  const f = fixture(t, 'SAT')
  const titles = ['R0211-可汗机考阅读-2B', 'M1157-几何学-3A', 'M1107-表达和应用题-3A', 'M1169-统计学-3A']
  // Exercise the real tool loop with a scripted provider, without a paid model call.
  f.responses.push(call('read_task_steps', { taskId: f.task.id }), payload => {
    const read = outcomes(payload).at(-1)
    assert.equal(read.task.id, f.task.id); assert.equal(read.total, 0)
    return call('save_task_steps', { taskId: read.task.id, expectedUpdatedAt: read.task.updatedAt, steps: titles.map(title => ({ title })) })
  }, reply('已保存四个步骤，从 R0211 开始'))
  const result = await f.xixi.chat(f.request(`sat有这些具体任务：${titles.join(' ')}`))
  const saved = f.db.getTask(f.task.id)
  assert.equal(result.status, 'completed'); assert.equal(result.operations.length, 1)
  assert.deepEqual(saved.subSteps.map(step => step.title), titles)
  assert.equal(saved.subSteps.length, 4)
  assert.ok(saved.subSteps.every(step => !step.doneAt && step.detail === undefined))
  assert.equal(f.db.listTasks().length, 1)
  assert.equal(saved.status, 'todo'); assert.equal(saved.due, f.task.due)
  assert.ok(!result.messages.some(message => message.question))
  assert.equal(environment(f.prompts.at(-1)).selectedTask.steps.total, 4)

  const checked = toggleTaskStep(f.db, { taskId: saved.id, stepId: saved.subSteps[0].id, checked: true, expectedUpdatedAt: saved.updatedAt })
  f.responses.push(call('read_task_steps', { taskId: saved.id }), payload => {
    const read = outcomes(payload).at(-1)
    return call('save_task_steps', { taskId: read.task.id, expectedUpdatedAt: read.task.updatedAt, steps: read.steps.map(({ id, title }) => ({ id, title })) })
  }, reply('已更新，第一项的完成进度保留了'))
  await f.xixi.chat(f.request(`就是这四个具体任务：${titles.join(' ')}`))
  const repeated = f.db.getTask(saved.id)
  assert.deepEqual(repeated.subSteps, checked.subSteps)
  assert.ok(repeated.updatedAt > checked.updatedAt)
  assert.equal(repeated.status, 'todo')
})

test('fresh conversation receives saved progress; refinement preserves checked IDs and cannot undo later ticking', async t => {
  const f = fixture(t)
  f.responses.push(f.save(assignment), reply('已拆好'))
  const result = await f.xixi.chat(f.request('拆步骤'))
  let task = f.db.getTask(f.task.id)
  task = toggleTaskStep(f.db, { taskId: task.id, stepId: task.subSteps[0].id, checked: true, expectedUpdatedAt: task.updatedAt })
  assert.throws(() => f.db.undoOperation(result.operations[0].id), /更新|变化|修改/)
  await f.xixi.chat(f.request('我到哪一步了', { conversationId: 'new-conversation' }))
  const progress = environment(f.prompts.at(-1)).selectedTask.steps
  assert.equal(progress.completed, 1); assert.equal(progress.total, 7)
  assert.equal(progress.next[0].title, assignment[1].title)
  const original = task.subSteps[0]
  f.responses.push(() => f.save([{ id: original.id, title: '加入班级群并改实名' }]), reply('保留了你做完的部分'))
  await f.xixi.chat(f.request('第一步标题明确写改实名'))
  task = f.db.getTask(task.id)
  assert.equal(task.subSteps.length, 7)
  assert.equal(task.subSteps[0].id, original.id)
  assert.equal(task.subSteps[0].doneAt, original.doneAt)
  assert.equal(task.subSteps[0].detail, original.detail)
  assert.equal(task.status, 'todo')
})

test('lost reply closes saved parts and replay cannot reset a later check', async t => {
  const f = fixture(t), request = f.request('拆成七步')
  f.responses.push(f.save(assignment), new Error('provider offline'))
  const failed = await f.xixi.chat(request)
  assert.equal(failed.status, 'completed'); assert.equal(failed.operations.length, 1)
  const task = f.db.getTask(f.task.id)
  toggleTaskStep(f.db, { taskId: task.id, stepId: task.subSteps[0].id, checked: true, expectedUpdatedAt: task.updatedAt })
  f.responses.push(() => f.save(assignment), reply('步骤已经保存'))
  const retry = await f.xixi.chat(request)
  assert.equal(retry.operations.length, 1)
  assert.equal(f.db.getTask(task.id).subSteps.length, 7)
  assert.ok(f.db.getTask(task.id).subSteps[0].doneAt)
  assert.equal(f.prompts.length, 2)
})

test('stale, cross-task and fabricated completion writes are rejected without mutation', async t => {
  const f = fixture(t), other = f.db.createTask({ title: '其他任务' })
  for (const args of [
    { taskId: f.task.id, expectedUpdatedAt: '2000-01-01T00:00:00Z', steps: assignment },
    { taskId: other.id, expectedUpdatedAt: other.updatedAt, steps: assignment },
    { taskId: f.task.id, expectedUpdatedAt: f.task.updatedAt, steps: [{ title: '假装做完', doneAt: new Date().toISOString() }] },
  ]) {
    f.responses.push(call('save_task_steps', args), reply('需要核对'))
    const result = await f.xixi.chat(f.request('拆步骤'))
    assert.equal(result.operations.length, 0)
    assert.equal(outcomes(f.prompts.at(-1)).at(-1).ok, false)
  }
  assert.equal(f.db.getTask(f.task.id).subSteps, undefined)
  assert.equal(f.db.getTask(other.id).subSteps, undefined)
})

test('propose mode prevents automatic step writes and retracted provider work never lands', async t => {
  const f = fixture(t)
  f.db.setPreference('app', { assistant: { autonomy: 'propose' } })
  f.responses.push(f.save(assignment), reply('先给你一个拆分建议'))
  assert.equal((await f.xixi.chat(f.request('拆步骤'))).operations.length, 0)
  f.db.setPreference('app', { assistant: { autonomy: 'act' } })
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  f.responses.push(async () => { entered(); await new Promise(resolve => { release = resolve }); return f.save(assignment) })
  const input = f.request('发错了的拆分要求'), pending = f.xixi.chat(input)
  await started
  f.db.retractRequest({ requestId: input.requestId, conversationId: input.conversationId })
  release(); assert.equal((await pending).status, 'failed')
  assert.equal(f.db.getTask(f.task.id).subSteps, undefined)
})

test('large step lists remain bounded in automatic context and paged reads keep every ID available', async t => {
  const f = fixture(t)
  const steps = Array.from({ length: 30 }, (_, n) => ({ id: `step-${n}`, title: `第${n}步` + '标题'.repeat(60), detail: '内容'.repeat(300), ...(n < 5 ? { doneAt: '2026-09-20T00:00:00Z' } : {}) }))
  f.db.updateTask(f.task.id, { subSteps: steps })
  f.responses.push(call('read_task_steps', { taskId: f.task.id, offset: 24 }), reply('还有六步'))
  await f.xixi.chat(f.request('继续看后面的步骤'))
  const p = environment(f.prompts[0]).selectedTask.steps
  assert.equal(p.total, 30); assert.equal(p.completed, 5); assert.equal(p.next.length, 3)
  const read = outcomes(f.prompts[1]).at(-1)
  assert.equal(read.steps.length, 6); assert.equal(read.steps[0].id, 'step-24'); assert.equal(read.nextOffset, null)
  assert.ok(read.steps.every(s => s.detailTruncated && s.detail.length === 240))
  f.responses.push(call('read_task_steps', { taskId: f.task.id, stepId: 'step-24' }), reply('读到了完整要求'))
  await f.xixi.chat(f.request('第24步的完整材料要求是什么', { conversationId: 'full-step-detail' }))
  const full = outcomes(f.prompts.at(-1)).at(-1)
  assert.equal(full.steps.length, 1); assert.equal(full.steps[0].id, 'step-24')
  assert.equal(full.steps[0].detail, steps[24].detail); assert.equal(full.steps[0].detailTruncated, false)
  for (const request of f.prompts) assert.ok(contextUnits(request.messages) + contextUnits(request.tools ?? []) <= HARD_INPUT_UNITS)
  assert.equal(JSON.stringify(environment(f.prompts[0])).includes(steps[24].detail), false, 'automatic context remains a bounded progress summary')
})
