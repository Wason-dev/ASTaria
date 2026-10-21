import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { buildReminderPlan, hash } from '../server/reminderPlan.mjs'
import { buildReminderPlan as desktopPlan } from '../desktop/reminders.mjs'

test('portable hashes retain exact desktop SHA-256 bytes and the public plan export is compatible', () => {
  for (const text of ['', 'astaria.test', 'session:课堂🌙:2026-09-29', JSON.stringify(['标题', '正文', 123456789])]) {
    assert.equal(hash(text), createHash('sha256').update(text).digest('hex'))
  }
  assert.equal(desktopPlan, buildReminderPlan)
})

test('shared plan remains a pure projection, includes existing offsets and truncation without changing its input', () => {
  process.env.TZ = 'Asia/Shanghai'
  const value = {
    tasks: Array.from({ length: 70 }, (_, id) => ({ id: `t${id}`, title: `虚构事项 ${id}`, status: 'todo', deletedAt: null, due: '2026-10-01T18:00:00+08:00' })),
    planner: { revision: 1, blocks: [], routines: [], details: {}, checked: {} },
    preferences: { notifications: { quietStart: '23:00', quietEnd: '08:00' } },
  }
  const before = structuredClone(value), now = new Date('2026-09-29T12:00:00+08:00')
  const result = buildReminderPlan(value, now)
  assert.deepEqual(value, before); assert.equal(result.entries.length, 64); assert.equal(result.omitted, 6)
  assert.ok(result.entries.every(entry => entry.at === new Date('2026-10-01T17:30:00+08:00').getTime() / 1000))
  assert.ok(result.entries.every(entry => entry.id.startsWith('astaria.') && entry.body.includes('截止')))
})
