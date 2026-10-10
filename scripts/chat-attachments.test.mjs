import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'
import { saveModelSettings } from '../server/modelSettings.mjs'
import { normalizeChatAttachments } from '../server/chatAttachments.mjs'
import { contextUnits } from '../server/contextBudget.mjs'

const settings = {
  provider: 'local', cloudModel: 'deepseek-flash', reasoningEffort: 'low', streamResponses: false,
  contextBudget: { mode: 'auto', maxUnits: 48_000 }, webSearch: { enabled: false, maxUses: 2 },
  local: { engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3-vl:8b' },
}
const png = `data:image/png;base64,${Buffer.from('small test image').toString('base64')}`
const attachment = { name: '课表.png', mime: 'image/png', size: Buffer.byteLength('small test image'), data: png }

test('chat attachments are validated, persisted locally, and sent as vision content', async t => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  saveModelSettings(db, settings)
  const requests = []
  const xixi = createXixi({ db, complete: async payload => {
    requests.push(payload)
    return { choices: [{ message: { role: 'assistant', content: '我看到了这张图片。' } }] }
  } })
  const result = await xixi.chat({ requestId: randomUUID(), conversationId: 'main', text: '', attachments: [attachment], context: { page: 'home', timezone: 'Asia/Shanghai' } })
  assert.equal(result.status, 'completed')
  const user = result.messages.find(message => message.role === 'user')
  assert.equal(user.attachments[0].name, '课表.png')
  const content = requests[0].messages.find(message => message.role === 'user').content
  assert.deepEqual(content, [{ type: 'text', text: '请识别这张图片' }, { type: 'image_url', image_url: { url: png } }])
})

test('image bytes use a bounded multimodal budget instead of their Base64 length', () => {
  const data = `data:image/webp;base64,${Buffer.alloc(2 * 1024 * 1024, 7).toString('base64')}`
  const units = contextUnits([{ role: 'user', content: [{ type: 'text', text: '识别图片' }, { type: 'image_url', image_url: { url: data } }] }])
  assert.ok(units < 2_000, `image budget unexpectedly grew to ${units} text units`)
  assert.equal(normalizeChatAttachments([{ name: 'large.webp', mime: 'image/webp', size: 2 * 1024 * 1024, data }])[0].size, 2 * 1024 * 1024)
})

test('unsupported or oversized images are rejected before a model request', () => {
  assert.throws(() => normalizeChatAttachments([{ name: 'x.gif', mime: 'image/gif', size: 1, data: 'data:image/gif;base64, eA==' }]), /仅支持/u)
  const data = `data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64')}`
  assert.throws(() => normalizeChatAttachments([{ name: 'large.png', mime: 'image/png', size: 2 * 1024 * 1024 + 1, data }]), /不能超过 2 MB/u)
})
