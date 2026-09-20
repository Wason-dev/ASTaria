import { questionOptions, text } from './validation.mjs'

export const RESPONSE_PROTOCOL_ERROR = '析熙的回复格式出了点问题，请重试这条消息'
const marker = /<\s*\/?\s*(?:[|｜]\s*)+DSML(?=\s|[|｜>]|$)/u
// Providers sometimes repeat the delimiters or Markdown-escape their control
// syntax. Unescape a detection copy and individual tags, never parameter text.
const unescapeSyntax = value => value.replace(/\\+([!-/:-@[-`{-~｜])/gu, '$1')
const containsMarker = value => marker.test(unescapeSyntax(value))
const invalid = reason => ({ kind: 'invalid', content: RESPONSE_PROTOCOL_ERROR, reason })

// Treat quoted programming examples as ordinary Markdown. Only complete fenced
// blocks/inline spans are masked; an unfinished code fence cannot conceal a
// partial provider control frame. Masking is solely for detection, never parsing.
function outsideCode(content) {
  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const open = lines[index].match(/^ {0,3}(`{3,}|~{3,})[^\n]*$/u)
    if (!open) continue
    const char = open[1][0], minimum = open[1].length
    let close = index + 1
    while (close < lines.length && !new RegExp(`^ {0,3}${char === '`' ? '`' : '~'}{${minimum},}\\s*$`, 'u').test(lines[close])) close++
    if (close >= lines.length) continue
    for (let row = index; row <= close; row++) lines[row] = ' '.repeat(lines[row].length)
    index = close
  }
  return lines.join('\n').replace(/(`+)([^`]|(?!\1)`)*?\1/gu, match => ' '.repeat(match.length))
}

function attributes(value) {
  const result = {}
  let cursor = 0
  while (cursor < value.length) {
    const match = /^\s+([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/u.exec(value.slice(cursor))
    if (!match) { if (!value.slice(cursor).trim()) break; return null }
    const name = match[1]
    if (Object.hasOwn(result, name)) return null
    result[name] = match[2] ?? match[3]
    cursor += match[0].length
  }
  return result
}

const decodeEntities = value => value.replace(/&(amp|lt|gt|quot|apos);/gu, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name])

/** Recover only the read-only ask_user presentation envelope. Textual model
 * calls never become executable tool calls, including known write tools. */
export function inspectAssistantProtocol(content) {
  if (typeof content !== 'string') return invalid('content-not-string')
  if (!containsMarker(outsideCode(content))) return { kind: 'plain', content }
  if (content.length > 64000) return invalid('protocol-too-large')
  const canonical = content.trim().replace(/\\*<[^<>]*>/gu, tag => {
    const match = /^<\s*(\/?)\s*(?:[|｜]\s*)+DSML\s*(?:[|｜]\s*)+([a-zA-Z_][\w-]*)([^<>]*)>$/u.exec(unescapeSyntax(tag))
    return match ? `<${match[1]}DSML:${match[2]}${match[3]}>` : tag
  })
  const root = /^<DSML:calls\s*>\s*<DSML:invoke([^<>]*)>([\s\S]*?)<\/DSML:invoke\s*>\s*<\/DSML:calls\s*>$/u.exec(canonical)
  if (!root) return invalid('incomplete-or-mixed-envelope')
  const invoke = attributes(root[1])
  if (!invoke || Object.keys(invoke).length !== 1 || invoke.name !== 'ask_user') return invalid('unsupported-textual-call')
  const parameters = new Map()
  let remaining = root[2].trim()
  while (remaining) {
    const match = /^<DSML:parameter([^<>]*)>([\s\S]*?)<\/DSML:parameter\s*>/u.exec(remaining)
    if (!match) return invalid('malformed-parameter')
    const attrs = attributes(match[1])
    if (!attrs || Object.keys(attrs).length !== 2 || !Object.hasOwn(attrs, 'name') || !Object.hasOwn(attrs, 'string')) return invalid('invalid-parameter-attributes')
    const name = attrs.name === 'question' ? 'prompt' : attrs.name
    if (!['prompt', 'options'].includes(name) || parameters.has(name) || attrs.string !== (name === 'prompt' ? 'true' : 'false')) return invalid('invalid-or-duplicate-parameter')
    if (/<\/?DSML:/u.test(match[2]) || containsMarker(match[2])) return invalid('nested-protocol')
    parameters.set(name, match[2].trim())
    remaining = remaining.slice(match[0].length).trim()
  }
  if (parameters.size !== 2) return invalid('missing-question-parameters')
  try {
    const prompt = text(decodeEntities(parameters.get('prompt')), '问题', 1000)
    const raw = parameters.get('options')
    let options
    try { options = JSON.parse(raw) } catch { options = JSON.parse(decodeEntities(raw)) }
    const question = questionOptions({ options })
    // Entities can reveal nested tags after decoding; never feed those control
    // strings back into the next provider round as an assistant question.
    if (containsMarker(prompt) || question.options.some(containsMarker)) return invalid('nested-protocol')
    return { kind: 'question', content: prompt, question }
  } catch { return invalid('invalid-question-content') }
}

/** Native tool_calls remain native. Mixed native/textual controls are rejected
 * so a recovered question cannot accidentally accompany a database write. */
export function normalizeAssistantProtocol(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.content !== 'string') return message
  let result = inspectAssistantProtocol(message.content)
  if (result.kind === 'plain') return message
  if (result.kind === 'question' && (message.tool_calls?.length || message.toolCalls?.length)) result = invalid('mixed-native-and-textual-calls')
  if (result.kind === 'invalid') return { ...message, content: result.content, question: undefined,
    tool_calls: undefined, toolCalls: undefined, protocolError: true, protocolReason: result.reason }
  return { ...message, content: result.content, question: result.question }
}
