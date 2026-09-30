import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { getPreferences, savePreferences } from '../server/preferences.mjs'
import { createXixi } from '../server/xixi.mjs'

test('legacy personality defaults to medium, all levels persist independently, and backups restore the chosen level', () => {
  const db = createDatabase(':memory:')
  try {
    const legacy = getPreferences(db)
    delete legacy.assistant.personality
    db.setPreference('app', legacy)
    assert.equal(getPreferences(db).assistant.personality, 'medium')
    for (const personality of ['low', 'medium', 'high']) {
      const before = getPreferences(db)
      const next = { ...before, assistant: { ...before.assistant, personality } }
      // Even a pre-upgrade client's expected version can be normalized.
      const saved = savePreferences(db, { expected: personality === 'low' ? legacy : before, value: next })
      assert.deepEqual(getPreferences(db), next)
      assert.equal(saved.assistant.autonomy, before.assistant.autonomy)
      assert.deepEqual(saved.notifications, before.notifications)
      if (personality !== 'low') assert.throws(() => savePreferences(db, { expected: before, value: next }), /其他窗口/)
    }
    const current = getPreferences(db)
    savePreferences(db, { expected: current, value: { ...current, assistant: { ...current.assistant, personality: 'medium' } } })
    const backup = db.exportData()
    db.setPreference('app', legacy)
    db.importData(backup)
    assert.equal(getPreferences(db).assistant.personality, 'medium')
    for (const personality of [null, '', 'highest', 3]) {
      const before = getPreferences(db)
      assert.throws(() => savePreferences(db, { expected: before, value: { ...before, assistant: { ...before.assistant, personality } } }), /个性强度/)
      assert.deepEqual(getPreferences(db), before)
    }
  } finally { db.close() }
})

test('same conversation picks up each newly saved voice in the actual provider request', async () => {
  const db = createDatabase(':memory:')
  const requests = []
  try {
    const xixi = createXixi({ db, now: () => new Date('2026-09-21T10:00:00+08:00'), complete: async request => {
      requests.push(request)
      return { choices: [{ message: { role: 'assistant', content: '嗯，听着呢' } }] }
    } })
    for (const [personality, label] of [['high', '高'], ['low', '低'], ['medium', '中']]) {
      const before = getPreferences(db)
      savePreferences(db, { expected: before, value: { ...before, assistant: { ...before.assistant, personality } } })
      await xixi.chat({ requestId: randomUUID(), conversationId: 'main', text: '今天事情好多呀', context: { timezone: 'Asia/Shanghai', page: 'home' } })
      const request = requests.at(-1), prompt = request.messages[0].content
      const environment = JSON.parse(request.messages.find(message => message.content?.startsWith('当前环境与数据库资料')).content.split('\n').slice(1).join('\n'))
      assert.equal(environment.assistantPreferences.personality, personality)
      assert.ok(prompt.includes(`本轮表达风格：${label}`))
      assert.equal((prompt.match(/本轮表达风格：/g) ?? []).length, 1)
      if (personality !== 'high') assert.doesNotMatch(prompt, /你在说什么胡话|嘴硬|笨蛋|可爱的挑衅/)
      if (personality === 'high') {
        assert.match(prompt, /傲娇搭档/)
        assert.match(prompt, /疲惫不等于关掉个性/)
        assert.match(prompt, /不拿用户的疲惫、能力或感受开玩笑/)
        assert.match(prompt, /用户不喜欢就收起/)
        assert.match(prompt, /不必每次额外加一句吐槽/)
        assert.doesNotMatch(prompt, /你在说什么胡话|这才发现？笨蛋|语气示例/)
        assert.doesNotMatch(prompt, /我才不喜欢你|才没有关心你/)
      } else assert.doesNotMatch(prompt, /一小时，改好了|你不用现在硬撑|我刚才可没白忙/)
      assert.ok(prompt.indexOf('本轮表达风格：') > prompt.indexOf('# 先做事，再解释'))
      assert.match(prompt, /工具回执是唯一的完成依据/)
      assert.deepEqual(request.tools, requests[0].tools)
    }
    assert.equal(requests.length, 3)
    assert.equal(db.listTasks().length, 0)
  } finally { db.close() }
})

test('high personality cannot bypass proposal-only execution permission', async () => {
  const db = createDatabase(':memory:')
  const requests = []
  try {
    const before = getPreferences(db)
    savePreferences(db, { expected: before, value: { ...before, assistant: { ...before.assistant, personality: 'high', autonomy: 'propose' } } })
    const xixi = createXixi({ db, now: () => new Date('2026-09-21T10:00:00+08:00'), complete: async request => {
      requests.push(request)
      return { choices: [{ message: requests.length === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'test-create', type: 'function', function: { name: 'create_tasks', arguments: JSON.stringify({ tasks: [{ title: '权限检查' }] }) } }] }
        : { role: 'assistant', content: '这是待你决定的方案' } }] }
    } })
    const result = await xixi.chat({ requestId: randomUUID(), conversationId: 'main', text: '整理一下今天的作业', context: { timezone: 'Asia/Shanghai', page: 'home' } })
    assert.equal(db.listTasks().length, 0)
    assert.equal(result.operations.length, 0)
    const receipt = requests[1].messages.find(message => message.role === 'tool')
    assert.equal(JSON.parse(receipt.content).ok, false)
    assert.match(receipt.content, /先提议/)
  } finally { db.close() }
})
