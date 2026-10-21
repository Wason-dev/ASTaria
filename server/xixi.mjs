import { readFileSync } from 'node:fs'
import { createXixi as createXixiCore } from './xixiCore.mjs'

// The assistant body is portable; only the prompt files are read here.
export * from './xixiCore.mjs'

const PERSONA = readFileSync(new URL('./prompts/persona.md', import.meta.url), 'utf8')
const WORKING = readFileSync(new URL('./prompts/working.md', import.meta.url), 'utf8')

export function createXixi(options) {
  return createXixiCore({ persona: PERSONA, working: WORKING, ...options })
}
