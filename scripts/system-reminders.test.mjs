/**
 * 系统提醒（desktop/reminders.mjs）行为契约。
 *
 * 只用假 native run、临时配置文件与固定时钟；不调用真实通知 helper、
 * 不申请权限、不发通知、不联网、不读写用户数据。
 *
 * 固定时钟：2026-09-29 12:00 +08:00（周二）；本周周一为 2026-09-28，
 * 因此 2026-09-29 属于第 1 周（单周），2026-10-06 属于第 2 周（双周）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { once } from 'node:events'
import { buildReminderPlan, createReminderService, handleReminderRequest } from '../desktop/reminders.mjs'

process.env.TZ = 'Asia/Shanghai'

const NOW = new Date('2026-09-29T12:00:00+08:00')
const localIso = value => new Date(value).toISOString()
const seconds = value => Math.floor(new Date(value).getTime() / 1000)
const shift = (date, days) => { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10) }

const task = (patch = {}) => ({ id: 'task-1', title: '写作业', status: 'todo', deletedAt: null, importance: 2, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...patch })
const block = (patch = {}) => ({ id: 'block-1', taskId: 'task-1', date: '2026-09-29', start: '18:00', end: '18:30', locked: false, ...patch })
const routine = (patch = {}) => ({ id: 'routine-1', title: '物理', kind: 'class', weekdays: [2], start: '08:00', end: '09:00', location: '实验室', items: [], enabled: true, ...patch })
const planner = (patch = {}) => ({ revision: 1, timetableConfirmed: true, routines: [], blocks: [], details: {}, checked: {}, ...patch })
const prefs = (patch = {}) => ({ notifications: { enabled: true, quietStart: '23:00', quietEnd: '08:00', opportunities: true }, ...patch })
const snapshot = ({ tasks = [], planner: state = planner(), preferences = prefs() } = {}) => ({ tasks, planner: state, preferences })
const plan = (input, now = NOW) => buildReminderPlan(input, now)
const titles = value => value.entries.map(entry => entry.title)
const entryOf = (value, title) => value.entries.find(entry => entry.title === title)
const datesOf = (value, label) => value.entries.filter(entry => entry.title.endsWith(label)).map(entry => new Date(entry.at * 1000 + 5 * 60_000).toLocaleDateString('en-CA'))
const allTimes = value => value.entries.map(entry => entry.at)

/** 假 native helper：记录命令，可注入授权码或失败。绝不真的发通知。 */
function nativeRun({ authorization = 2, fail = null } = {}) {
  const calls = []
  const native = {
    calls, authorization, fail,
    async run(command, input) {
      calls.push({ command, input })
      if (native.fail === true || native.fail === command) throw new Error('系统提醒服务暂不可用，请稍后重试')
      if (command === 'status') return { authorization: native.authorization, pending: 0 }
      if (command === 'authorize') return { authorization: native.authorization }
      if (command === 'replace') return { ok: true, count: Array.isArray(input) ? input.length : 0 }
      throw new Error(`未知命令 ${command}`)
    },
  }
  native.of = command => calls.filter(call => call.command === command)
  return native
}

async function fixture(t, { snapshotValue = snapshot(), native = nativeRun(), now = () => NOW } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'astaria-reminders-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stateFile = join(directory, 'system-reminders.json')
  const holder = { value: snapshotValue }
  const service = createReminderService({ stateFile, snapshot: () => holder.value, run: native.run, now })
  return { service, native, holder, stateFile, directory }
}

/** 与 desktop/update 处理同样的假 req/res 形状。 */
function httpRequest(url, { method = 'GET', body, headers = {} } = {}) {
  const payload = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(payload)
  Object.assign(req, { url, method, headers: { 'x-astaria-local': '1', 'content-type': 'application/json', ...headers } })
  return req
}
async function httpResponse(service, req) {
  const chunks = [], headers = {}
  const res = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done() } })
  res.statusCode = 200
  res.setHeader = (key, value) => { headers[key.toLowerCase()] = value }
  const finished = once(res, 'finish')
  const handled = await handleReminderRequest(service, req, res)
  await finished
  return { handled, status: res.statusCode, headers, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }
}

test('只提醒真实未完成的事项与单次余时时段', () => {
  const session = plan(snapshot({ tasks: [task()], planner: planner({ blocks: [block()] }) }))
  assert.deepEqual(titles(session), ['即将开始：写作业'])
  assert.equal(session.entries[0].at, seconds('2026-09-29T17:55:00+08:00'), '事项开始前 5 分钟')
  const implicit = plan(snapshot({ tasks: [task({ startAt: '2026-09-29T18:00:00+08:00', estimateMin: 30 })] }))
  assert.deepEqual(titles(implicit), ['即将开始：写作业'], '带明确起点与预估用时的事项也算已安排')
  assert.deepEqual(titles(plan(snapshot({ tasks: [task()] }))), [], '没有任何时间信息的事项不提醒')
  // 可用与休息窗口是留白，不是活动，不能变成提醒。
  const blank = [routine({ id: 'free-window', title: '空课', kind: 'available', start: '18:00', end: '19:00' }), routine({ id: 'lunch', title: '午饭', kind: 'break', start: '12:30', end: '13:00' })]
  assert.deepEqual(titles(plan(snapshot({ planner: planner({ routines: blank }) }))), [], '可用与休息窗口不提醒')
  const goal = task({ id: 'goal-task', title: '背单词', freeTimeGoalId: 'goal-1', startAt: '2026-09-29T18:00:00+08:00', estimateMin: 30 })
  assert.deepEqual(titles(plan(snapshot({ tasks: [goal] }))), [], '未排程的余时目标不提醒')
  const goalBlock = block({ id: 'goal-block', taskId: 'goal-task' })
  const goalSession = plan(snapshot({ tasks: [goal], planner: planner({ blocks: [goalBlock] }) }))
  assert.deepEqual(titles(goalSession), ['即将开始：背单词'])
  assert.match(goalSession.entries[0].body, /本次余时/u, '单次余时标注自己的身份')
  const course = plan(snapshot({ planner: planner({ routines: [routine({ start: '09:00', end: '10:00' })] }) }))
  assert.deepEqual(datesOf(course, '物理'), ['2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27'], '每周课程各提醒一次；今天 09:00 已经开课，不再补发')
  assert.equal(course.entries[0].at, seconds('2026-10-06T08:55:00+08:00'), '开课前 5 分钟')
  assert.match(course.entries[0].body, /实验室/u)
  assert.deepEqual(titles(plan(snapshot({ planner: planner({ routines: [routine()] }) }))), [], '提醒时间落在免打扰里就不预约（默认 23:00–08:00）')
})

test('已完成、已删除、已过期与停用安排都不发', () => {
  const base = { planner: planner({ blocks: [block()] }) }
  for (const [label, patch] of [['已完成', { status: 'done' }], ['已删除', { deletedAt: '2026-09-29T00:00:00.000Z' }], ['已搁置', { status: 'dropped' }]]) {
    assert.deepEqual(titles(plan(snapshot({ ...base, tasks: [task(patch)] }))), [], label)
  }
  assert.deepEqual(titles(plan(snapshot({ tasks: [task({ due: '2026-09-28' })] }))), [], '昨天的日期截止不再提醒')
  assert.deepEqual(titles(plan(snapshot({ tasks: [task({ due: '2026-09-29T09:00:00+08:00' })] }))), [], '已过的明确截止不再提醒')
  assert.deepEqual(titles(plan(snapshot({ tasks: [task()], planner: planner({ blocks: [block({ start: '09:00', end: '09:30' })] }) }))), [], '已经开始的时段不再提醒')
  const goal = task({ id: 'goal-task', freeTimeGoalId: 'goal-1' })
  const done = planner({ blocks: [block({ id: 'goal-block', taskId: 'goal-task' })], completedFreeTimeSessions: { 'goal-block': '2026-09-29T02:00:00.000Z' } })
  assert.deepEqual(titles(plan(snapshot({ tasks: [goal], planner: done }))), [], '已完成的单次余时不提醒')
  assert.deepEqual(titles(plan(snapshot({ planner: planner({ routines: [routine({ enabled: false })] }) }))), [], '停用的固定安排不提醒')
})

test('重复的隔周课程按投影只在自己那一周提醒', () => {
  const odd = routine({ id: 'odd', title: '单周物理', start: '18:00', end: '19:00', weekCycle: 'odd', weekAnchor: '2026-09-28' })
  const even = routine({ id: 'even', title: '双周物理', start: '18:00', end: '19:00', weekCycle: 'even', weekAnchor: '2026-09-28' })
  const value = plan(snapshot({ planner: planner({ routines: [odd, even] }) }))
  assert.deepEqual(datesOf(value, '单周物理'), ['2026-09-29', '2026-10-13', '2026-10-27'], '单周只在第 1、3、5 周')
  assert.deepEqual(datesOf(value, '双周物理'), ['2026-10-06', '2026-10-20'], '双周只在第 2、4 周')
  assert.equal(entryOf(value, '即将开始：单周物理').at, seconds('2026-09-29T17:55:00+08:00'))
  const weekly = routine({ id: 'weekly', title: '每周班会', start: '18:00', end: '19:00', weekCycle: undefined, weekAnchor: undefined })
  assert.deepEqual(datesOf(plan(snapshot({ planner: planner({ routines: [weekly] }) })), '每周班会'), ['2026-09-29', '2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27'], '未配置周次的安排每周都提醒')
  const disabled = routine({ id: 'disabled', title: '停用课', start: '18:00', end: '19:00', enabled: false })
  assert.deepEqual(datesOf(plan(snapshot({ planner: planner({ routines: [disabled] }) })), '停用课'), [], '停用课程不进入提醒')
})

test('开课/事项前 5 分钟，明确截止前 30 分钟，仅日期的截止在 20:00', () => {
  const precise = plan(snapshot({ tasks: [task({ due: '2026-10-01T18:00:00+08:00' })] }))
  assert.deepEqual(titles(precise), ['即将截止：写作业'])
  assert.equal(precise.entries[0].at, seconds('2026-10-01T17:30:00+08:00'))
  const dateOnly = plan(snapshot({ tasks: [task({ due: '2026-10-01' })] }))
  assert.deepEqual(titles(dateOnly), ['今天截止：写作业'])
  assert.equal(dateOnly.entries[0].at, seconds('2026-10-01T20:00:00+08:00'), '仅日期的截止在当天 20:00')
  const soon = new Date('2026-09-29T17:57:00+08:00')
  const inside = plan(snapshot({ tasks: [task()], planner: planner({ blocks: [block()] }) }), soon)
  assert.equal(inside.entries.length, 0, '提前提醒时刻已过，不在开始时重复补发')
  const nearDue = new Date('2026-09-29T17:45:00+08:00')
  const late = plan(snapshot({ tasks: [task({ due: '2026-09-29T18:00:00+08:00' })] }), nearDue)
  assert.equal(late.entries.length, 0, '提前提醒时刻已过，不在截止时重复补发')
})

test('免打扰跨夜时段同时约束课程与截止提醒', () => {
  const routines = [
    routine({ id: 'early', title: '早课', start: '07:00', end: '08:00' }),
    routine({ id: 'evening', title: '晚自习课', start: '21:00', end: '22:00' }),
    routine({ id: 'night', title: '晚课', start: '23:30', end: '00:00' }),
  ]
  const quiet = prefs({ notifications: { enabled: true, quietStart: '23:00', quietEnd: '08:00', opportunities: true } })
  const value = plan(snapshot({ tasks: [task({ due: '2026-09-29' })], planner: planner({ routines }), preferences: quiet }))
  const kept = titles(value)
  assert.equal(kept.filter(title => title === '即将开始：晚自习课').length, 5, '21:00 的课在每个周二都提醒')
  assert.equal(kept.filter(title => title === '今天截止：写作业').length, 1, '当天 20:00 的截止提醒也在免打扰之外')
  assert.equal(kept.includes('即将开始：早课'), false, '07:00 落在跨夜免打扰里')
  assert.equal(kept.includes('即将开始：晚课'), false, '23:30 落在跨夜免打扰里')
  const daytime = prefs({ notifications: { enabled: true, quietStart: '13:00', quietEnd: '14:00', opportunities: true } })
  const dayRoutines = [routine({ id: 'noon', title: '午间课', start: '13:30', end: '14:30' }), routine({ id: 'later', title: '下午课', start: '15:00', end: '16:00' })]
  const dayValue = plan(snapshot({ planner: planner({ routines: dayRoutines }), preferences: daytime }))
  assert.equal(titles(dayValue).filter(title => title === '即将开始：下午课').length, 5, '15:00 的课每个周二都提醒')
  assert.equal(titles(dayValue).includes('即将开始：午间课'), false, '13:30 落在 13:00–14:00 免打扰里')
  const off = prefs({ notifications: { enabled: true, quietStart: '08:00', quietEnd: '08:00', opportunities: true } })
  const always = plan(snapshot({ planner: planner({ routines: [routine({ id: 'any', title: '任意课', start: '18:00', end: '19:00' })] }), preferences: off }))
  assert.equal(datesOf(always, '任意课').length, 5, '起止相同的空窗口不妨碍提醒')
})

test('最多未来 30 天内的 64 条，按时间排序并报告被省略的数量', () => {
  const day = shift('2026-09-29', 1)
  const many = Array.from({ length: 70 }, (_, index) => {
    const minutes = 10 + index * 10
    const clock = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
    return { start: clock(minutes), end: clock(minutes + 10) }
  })
  const tasks = [], blocks = []
  for (const [index, item] of many.entries()) {
    tasks.push(task({ id: `task-bulk-${index}`, title: `批量 ${index}` }))
    blocks.push(block({ id: `block-bulk-${index}`, taskId: `task-bulk-${index}`, date: day, start: item.start, end: item.end }))
  }
  // 起止相同的空免打扰窗口让全部 70 条都参与排序与截断。
  const open = prefs({ notifications: { enabled: true, quietStart: '08:00', quietEnd: '08:00', opportunities: true } })
  const value = plan(snapshot({ tasks, planner: planner({ blocks }), preferences: open }))
  assert.equal(value.entries.length, 64, '最多 64 条')
  assert.equal(value.omitted, 6, '其余条目报告为省略')
  const times = allTimes(value)
  assert.deepEqual(times, [...times].sort((a, b) => a - b), '按提醒时间升序')
  assert.equal(new Set(value.entries.map(entry => entry.id)).size, 64, '每条提醒有独立 id')
  assert.equal(times.at(-1), seconds(`${day}T10:35:00+08:00`), '截断发生在排序之后，保留最早的一批')
  assert.equal(new Date(times[0] * 1000).toISOString(), localIso(`${day}T00:05:00+08:00`))
  const horizon = plan(snapshot({ tasks: [task({ id: 'far', due: shift('2026-09-29', 31) })] }))
  assert.deepEqual(titles(horizon), [], '第 31 天之外的截止不预约')
  const near = plan(snapshot({ tasks: [task({ id: 'near', due: shift('2026-09-29', 1) })] }))
  assert.equal(near.entries.length, 1, '30 天以内的截止照常预约')
  assert.ok(allTimes(near)[0] <= Math.floor(new Date(`${shift('2026-09-29', 30)}T12:00:00+08:00`).getTime() / 1000), '全部条目都在 30 天窗口内')
})

test('关闭开关时用空 replace 取消已预约的提醒', async t => {
  const { service, native, stateFile } = await fixture(t, { snapshotValue: snapshot({ tasks: [task()], planner: planner({ blocks: [block()] }) }) })
  const opened = await service.setEnabled(true)
  assert.equal(opened.enabled, true)
  assert.equal(opened.count, 1)
  assert.deepEqual(native.of('replace').at(-1).input.map(entry => entry.title), ['即将开始：写作业'])
  const closed = await service.setEnabled(false)
  assert.equal(closed.enabled, false)
  assert.equal(closed.count, 0)
  assert.equal(closed.through, null)
  assert.deepEqual(native.of('replace').at(-1).input, [], '关闭时下发空列表取消预约')
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), { enabled: false })
})

test('权限未授权时不启用也不落盘', async t => {
  for (const authorization of [0, 1, 4, -1]) {
    const { service, native, stateFile } = await fixture(t, { native: nativeRun({ authorization }) })
    await assert.rejects(service.setEnabled(true), /请先在系统设置 → 通知中允许 ASTaria 提醒/u, `authorization=${authorization}`)
    assert.equal((await service.status()).enabled, false)
    assert.equal(native.of('replace').length, 0, '未授权不下发 replace')
    const saved = await readFile(stateFile, 'utf8').catch(() => null)
    assert.equal(saved, null, '未授权不写启用状态')
  }
  for (const authorization of [2, 3]) {
    const { service, native, stateFile } = await fixture(t, { native: nativeRun({ authorization }) })
    assert.equal((await service.setEnabled(true)).enabled, true, `authorization=${authorization} 已授权`)
    assert.equal((await service.status()).authorization, authorization)
    assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), { enabled: true })
    assert.equal(native.of('authorize').length, 1)
  }
})

test('native 失败时状态里给出显式错误，恢复后清空', async t => {
  const failing = nativeRun({ fail: 'replace' })
  const { service, holder } = await fixture(t, { native: failing, snapshotValue: snapshot({ tasks: [task()], planner: planner({ blocks: [block()] }) }) })
  await service.setEnabled(true).catch(() => {})
  const failed = await service.flush()
  assert.equal(failed.error, '系统提醒服务暂不可用，请稍后重试', '失败原因必须出现在状态里供界面显示')
  assert.equal(failed.count, 0)
  failing.fail = null
  const recovered = await service.flush()
  assert.equal(recovered.error, null, '恢复后清空错误')
  assert.equal(recovered.count, 1, '恢复后重新下发真实计划')
  assert.equal(holder.value.tasks.length, 1)
  const stopped = nativeRun({ fail: 'status' })
  const second = await fixture(t, { native: stopped })
  const statusFailure = await second.service.flush()
  assert.equal(statusFailure.error, '系统提醒服务暂不可用，请稍后重试')
})

test('修改与完成后重新同步，且相同内容不重复下发', async t => {
  const { service, native, holder } = await fixture(t, { snapshotValue: snapshot({ tasks: [task()], planner: planner({ blocks: [block()] }) }) })
  const opened = await service.setEnabled(true)
  assert.equal(opened.enabled, true)
  assert.equal(opened.count, 1)
  assert.deepEqual(native.of('replace').at(-1).input.map(entry => entry.title), ['即将开始：写作业'])
  assert.equal((await service.flush()).count, 1)
  assert.equal(native.of('replace').length, 1, '内容未变化时不重复 replace')
  holder.value = snapshot({ tasks: [task({ status: 'done' })], planner: planner({ blocks: [block()] }) })
  const afterDone = await service.flush()
  assert.equal(afterDone.count, 0)
  assert.deepEqual(native.of('replace').at(-1).input, [], '完成事项后取消它的提醒')
  holder.value = snapshot({ tasks: [task({ title: '写作业（改）' })], planner: planner({ blocks: [block()] }) })
  const afterEdit = await service.flush()
  assert.equal(afterEdit.count, 1)
  assert.deepEqual(native.of('replace').at(-1).input.map(entry => entry.title), ['即将开始：写作业（改）'])
  holder.value = snapshot({ tasks: [task({ id: 'other', title: '新事项' })], planner: planner({ blocks: [block({ id: 'other-block', taskId: 'other' })] }) })
  service.schedule()
  await new Promise(resolve => setTimeout(resolve, 700))
  assert.deepEqual(native.of('replace').at(-1).input.map(entry => entry.title), ['即将开始：新事项'], 'schedule() 也会在防抖后同步')
  await service.close()
  const settled = native.of('replace').length
  service.schedule()
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(native.of('replace').length, settled, 'close() 之后不再同步')
})

test('HTTP 需要本地标记，并且限定路径、方法与体积', async t => {
  const { service } = await fixture(t)
  const status = await httpResponse(service, httpRequest('/api/desktop/reminders'))
  assert.equal(status.status, 200)
  assert.equal(status.handled, true)
  assert.equal(status.body.enabled, false)
  for (const url of ['/api/desktop/reminders/enabled', '/api/desktop/reminders/refresh']) {
    const forbidden = await httpResponse(service, httpRequest(url, { method: 'POST', body: {}, headers: { 'x-astaria-local': '0' } }))
    assert.equal(forbidden.status, 403, `${url} 缺少本地标记`)
    assert.deepEqual(forbidden.body, { error: 'Forbidden' })
  }
  const toggled = await httpResponse(service, httpRequest('/api/desktop/reminders/enabled', { method: 'POST', body: { enabled: true } }))
  assert.equal(toggled.status, 200)
  assert.equal(toggled.body.enabled, true)
  const bad = await httpResponse(service, httpRequest('/api/desktop/reminders/enabled', { method: 'POST', body: { enabled: 'yes' } }))
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error, '提醒开关无效')
  const tooLarge = await httpResponse(service, httpRequest('/api/desktop/reminders/refresh', { method: 'POST', body: 'x'.repeat(2048) }))
  assert.equal(tooLarge.status, 400)
  assert.equal(tooLarge.body.error, '提醒请求过大')
  const unknownPath = await httpResponse(service, httpRequest('/api/desktop/reminders/anything', { method: 'POST', body: {} }))
  assert.equal(unknownPath.status, 405)
  const wrongMethod = await httpResponse(service, httpRequest('/api/desktop/reminders/enabled', { method: 'PUT', body: {} }))
  assert.equal(wrongMethod.status, 405)
  const foreign = httpRequest('/api/desktop/updates')
  assert.equal(await handleReminderRequest(service, foreign, { setHeader() {}, end() {} }), false, '不接管其他路径')
})

test('单日活动与单日调课进入提醒，只有时长或截止才算已安排', () => {
  const event = { id: 'evt-1', title: '年级大会', date: '2026-10-01', start: '14:00', end: '15:00', location: '礼堂', items: [] }
  const eventPlan = plan(snapshot({ planner: planner({ dayEvents: [event] }) }))
  assert.deepEqual(titles(eventPlan), ['即将开始：年级大会'])
  assert.equal(eventPlan.entries[0].at, seconds('2026-10-01T13:55:00+08:00'), '单日固定活动提前 5 分钟')
  const thursday = routine({ id: 'thu-class', title: '周四化学', weekdays: [4], start: '10:00', end: '11:00' })
  const override = plan(snapshot({ planner: planner({ dayOverrides: { '2026-10-01': { date: '2026-10-01', sourceWeekday: 4, routines: [thursday] } } }) }))
  assert.deepEqual(titles(override), ['即将开始：周四化学'], '单日调课快照替代周模板')
  assert.equal(override.entries[0].at, seconds('2026-10-01T09:55:00+08:00'))
  assert.deepEqual(titles(plan(snapshot({ tasks: [task({ startAt: '2026-10-01T18:00:00+08:00' })] }))), [], '只有起点没有时长的事项不算已安排')
  const offset = plan(snapshot({ tasks: [task({ due: '2026-10-01T10:00:00Z' })] }))
  assert.deepEqual(titles(offset), ['即将截止：写作业'])
  assert.equal(offset.entries[0].at, seconds('2026-10-01T17:30:00+08:00'), '带时区的截止按当地时间提前 30 分钟')
  // 记录到的边界：长期目标的关联事项若自带截止，与普通事项一样按截止提醒。
  assert.deepEqual(titles(plan(snapshot({ tasks: [task({ freeTimeGoalId: 'goal-1', due: '2026-10-01' })] }))), ['今天截止：写作业'])
})

test('提醒 id 由来源稳定生成，标题与正文保持有界', () => {
  const long = 'x'.repeat(400)
  const value = plan(snapshot({ tasks: [task({ title: long })], planner: planner({ blocks: [block()] }) }))
  const again = plan(snapshot({ tasks: [task({ title: long })], planner: planner({ blocks: [block()] }) }))
  assert.equal(value.entries[0].id, again.entries[0].id, '相同来源得到相同 id')
  assert.match(value.entries[0].id, /^astaria\.[a-f0-9]{40}$/u)
  assert.ok(value.entries[0].title.length <= 200, `标题有上限，实际 ${value.entries[0].title.length}`)
  assert.ok(value.entries[0].body.length <= 1000, `正文有上限，实际 ${value.entries[0].body.length}`)
  assert.ok(value.entries[0].title.startsWith('即将开始：'))
  const renamed = plan(snapshot({ tasks: [task({ title: '改名后的事项' })], planner: planner({ blocks: [block()] }) }))
  assert.equal(value.entries[0].id, renamed.entries[0].id, '同一来源换标题仍复用同一条提醒 id')
  const other = plan(snapshot({ tasks: [task()], planner: planner({ blocks: [block({ id: 'other-block' })] }) }))
  assert.notEqual(value.entries[0].id, other.entries[0].id, '不同来源得到不同 id')
})

test('提醒触发后刷新不再在开始时重复预约，跨夜延续也不生成第二条', async t => {
  let clock = new Date('2026-09-29T17:50:00+08:00')
  const f = await fixture(t, { now: () => clock, snapshotValue: snapshot({ tasks: [task()], planner: planner({ blocks: [block()] }) }) })
  await f.service.setEnabled(true)
  assert.equal(f.native.of('replace').at(-1).input[0].at, seconds('2026-09-29T17:55:00+08:00'))
  clock = new Date('2026-09-29T17:56:00+08:00')
  await f.service.flush()
  assert.deepEqual(f.native.of('replace').at(-1).input, [], '不能把已触发的提醒推迟到 18:00 再发')
  const overnight = plan(snapshot({ tasks: [task({ startAt: '2026-09-29T23:30:00+08:00', estimateMin: 90 })], preferences: prefs({ notifications: { quietStart: '00:00', quietEnd: '00:00' } }) }))
  assert.equal(overnight.entries.length, 1, '跨午夜的同一任务只提醒一次')
  assert.equal(overnight.entries[0].at, seconds('2026-09-29T23:25:00+08:00'))
})

test('关闭提醒后的普通数据变化不唤醒 native helper', async t => {
  const f = await fixture(t)
  await f.service.initialize()
  const count = f.native.calls.length
  f.service.schedule()
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(f.native.calls.length, count)
})
