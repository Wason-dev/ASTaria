import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { transformSync } from 'rolldown/utils'

const sourceRoot = new URL('../src/', import.meta.url).href
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      for (const extension of ['.ts', '.tsx']) {
        if (existsSync(fileURLToPath(new URL(`${specifier}${extension}`, context.parentURL)))) return next(`${specifier}${extension}`, context)
      }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot) && url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    if (url.startsWith(sourceRoot) && /\.tsx?$/.test(url)) return {
      format: 'module', shortCircuit: true,
      source: transformSync(fileURLToPath(url), readFileSync(new URL(url), 'utf8'), { jsx: { runtime: 'automatic' } }).code,
    }
    return next(url, context)
  },
})
const { ConversationLog } = await import('../src/xixi/ConversationLog.tsx')
hook.deregister()

const user = { id: 'u1', seq: 1, role: 'user', content: '记录作业', createdAt: '', requestId: 'r1', hasSavedReasoning: true }
const rounds = [{ id: 'live:1', round: 1, content: '工具之前的思考' }, { id: 'live:2', round: 2, content: '工具之后的思考' }]
const draft = { requestId: 'r1', conversationId: 'main', round: 2, reasoningRounds: rounds, reasoningContent: rounds.map(item => item.content).join('\n\n'), content: '', phase: 'thinking' }
const render = overrides => renderToStaticMarkup(createElement(ConversationLog, {
  chat: { conversation: { conversationId: 'main', messages: [user], operations: [] }, interruptedReasoning: {}, status: { configured: true }, ...overrides },
  active: true, context: { page: 'workbench', taskId: 'focus-task', timezone: 'Asia/Shanghai' }, onSettings() {}, onSent() {}, onRetracted() {},
}))

test('live transcript shows previous and current reasoning once in a single expandable block', () => {
  const html = render({ stream: draft, sending: true })
  assert.equal(html.match(/工具之前的思考/g)?.length, 1)
  assert.equal(html.match(/工具之后的思考/g)?.length, 1)
  assert.equal(html.match(/class="xixi-reasoning"/g)?.length, 1)
  assert.match(html, /第 1 段 · 已结束/)
  assert.match(html, /第 2 段 · 思考中/)
  assert.match(html, /复制本次全部思考/)
})

test('tool execution keeps all thoughts accessible without calling them active thinking', () => {
  const html = render({ stream: { ...draft, phase: 'executing' }, sending: true })
  assert.match(html, /工具之前的思考/)
  assert.match(html, /工具之后的思考/)
  assert.equal(html.match(/段 · 已结束/g)?.length, 2)
  assert.match(html, /正在处理安排/)
  assert.match(html, /class="xixi-reasoning" data-expanded="false"/)
})

test('opening the focus conversation during reply keeps preceding thoughts available but collapsed', () => {
  const html = render({ stream: { ...draft, phase: 'replying', content: '安排已核对' }, sending: true })
  assert.match(html, /class="xixi-reasoning" data-expanded="false"/)
  assert.match(html, /工具之前的思考/)
  assert.match(html, /工具之后的思考/)
  assert.match(html, /安排已核对/)
})

test('live status names only the current tool and fits in one compact row', () => {
  const activities = [
    { id: 'tool:old', stage: 'reading', state: 'done', title: '上一步已完成', detail: '这段长说明不应显示' },
    { id: 'tool:current', stage: 'reading', state: 'running', title: '正在核对课程与空档', detail: '读取日程' },
  ]
  const html = render({ stream: { ...draft, activities }, sending: true })
  assert.match(html, /正在核对课程与空档/)
  assert.match(html, /读取日程/)
  assert.doesNotMatch(html, /上一步已完成|这段长说明不应显示|xixi-stream-activities/)
  assert.match(html, /class="xixi-reasoning" data-expanded="false"/)
})

test('failed live turns retain received thoughts and refresh offers expansion of saved thoughts', () => {
  const failed = render({ interruptedReasoning: { r1: draft } })
  assert.match(failed, /工具之前的思考/)
  assert.match(failed, /工具之后的思考/)
  assert.match(failed, /回复中断/)
  assert.equal(failed.match(/class="xixi-reasoning"/g)?.length, 1)
  const refreshed = render({})
  assert.match(refreshed, /aria-expanded="false"/)
  assert.match(refreshed, /思考过程/)
  assert.match(refreshed, /复制完整思考/)
})

test('completed and retried turns render a single owner for the same request reasoning', () => {
  const assistant = { id: 'a1', seq: 2, role: 'assistant', content: '记好了', reasoningContent: draft.reasoningContent, createdAt: '', requestId: 'r1' }
  const completed = render({ conversation: { conversationId: 'main', messages: [user, assistant], operations: [] } })
  assert.equal(completed.match(/class="xixi-reasoning"/g)?.length, 1)
  assert.equal(completed.match(/工具之前的思考/g)?.length, 1)
  const retrying = render({ stream: draft, sending: true, interruptedReasoning: { r1: draft } })
  assert.equal(retrying.match(/工具之前的思考/g)?.length, 1)
})

test('history loaded across a tool boundary keeps the saved thoughts reachable on the final reply', () => {
  const assistant = { id: 'a1', seq: 4, role: 'assistant', content: '工具处理完成', createdAt: '', requestId: 'r1' }
  const html = render({ conversation: { conversationId: 'main', messages: [user, assistant], operations: [] } })
  assert.equal(html.match(/class="xixi-reasoning"/g)?.length, 1)
  const finalReply = html.slice(html.indexOf('data-message-id="a1"'))
  assert.match(finalReply, /思考过程/)
  assert.match(finalReply, /复制完整思考/)
})

test('withdrawn request markers never resurrect reasoning on a tombstone', () => {
  const html = render({ conversation: { conversationId: 'main', messages: [{ ...user, retractedAt: '2026-09-24T00:00:00Z' }], operations: [] } })
  assert.doesNotMatch(html, /class="xixi-reasoning"/)
})

test('partial execution preserves model prose and renders unfinished issues apart from a single time list', () => {
  const assistant = { id: 'a1', seq: 2, role: 'assistant', content: '能安排的三段放好了，剩下一段需要另找空档。',
    executionNotice: { issues: ['这段时间已经过去，请从当前时刻之后安排'] }, requestId: 'r1', createdAt: '' }
  const times = ['2026-10-10 08:55–09:25', '2026-10-10 09:35–10:05', '2026-10-10 14:15–14:45']
  const operation = { id: 'op1', requestId: 'r1', summary: '安排 3 段任务时间', details: times, createdAt: '', readAt: null, undoneAt: null }
  const html = render({ conversation: { conversationId: 'main', messages: [user, assistant], operations: [operation] } })
  assert.match(html, /能安排的三段放好了，剩下一段需要另找空档。/)
  assert.match(html, /class="xixi-execution-notice" role="status" aria-label="执行状态"/)
  assert.equal(html.match(/尚未完成/g)?.length, 1)
  assert.equal(html.match(/这段时间已经过去/g)?.length, 1)
  assert.doesNotMatch(html, /已保存的部分/)
  assert.match(html, /安排 3 段任务时间/)
  for (const time of times) assert.equal(html.split(time).length - 1, 1)
  assert.match(html, /撤销/)
})

test('reply failure is a system notice with a receipt, not a fabricated or copyable model reply', () => {
  const assistant = { id: 'a1', seq: 2, role: 'assistant', content: '', executionNotice: { issues: [], replyUnavailable: true }, requestId: 'r1', createdAt: '' }
  const html = render({ conversation: { conversationId: 'main', messages: [user, assistant], operations: [
    { id: 'op1', requestId: 'r1', summary: '安排 1 段任务时间', details: ['2026-10-10 08:55–09:25'], createdAt: '', readAt: null, undoneAt: null },
  ] } })
  assert.match(html, /回复生成中断，已保存的操作见下方回执。/)
  assert.match(html, /2026-10-10 08:55–09:25/)
  assert.doesNotMatch(html, /尚未完成|复制析熙的消息/)
})

test('withdrawal hides an execution notice while leaving its receipt available for undo', () => {
  const html = render({ conversation: { conversationId: 'main', messages: [
    { ...user, retractedAt: '2026-10-10T01:00:00Z' },
    { id: 'a1', seq: 2, role: 'assistant', content: '已安排', executionNotice: { issues: ['未完成的旧操作'] }, requestId: 'r1', retractedAt: '2026-10-10T01:00:00Z' },
  ], operations: [{ id: 'op1', requestId: 'r1', summary: '安排 1 段任务时间', readAt: null, undoneAt: null }] } })
  assert.doesNotMatch(html, /未完成的旧操作|xixi-execution-notice/)
  assert.match(html, /安排 1 段任务时间/)
  assert.match(html, /撤销/)
})
