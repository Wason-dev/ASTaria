import { ValidationError, knownKeys } from './validation.mjs'

export const DEFAULT_PREFERENCES = {
  version: 1, startupPage: 'home', theme: 'dark', grid: true, glass: 'clear', density: 'compact', cardEdges: 'both',
  effect: { style: 'tide', intensity: 'gentle', motion: 'system' },
  render: { profile: 'full' },
  assistant: { autonomy: 'act', personality: 'high', useMemory: true, useHistory: true },
  notifications: { enabled: true, quietStart: '23:00', quietEnd: '08:00', opportunities: true },
  focus: { focusMin: 35, restMin: 5 }, scheduling: { bufferMin: 10 },
}
const fail = label => { throw new ValidationError(`${label}设置不正确`) }
function option(value, choices, label) { if (!choices.includes(value)) fail(label); return value }
function bool(value, label) { if (typeof value !== 'boolean') fail(label); return value }
function integer(value, min, max, label) { if (!Number.isInteger(value) || value < min || value > max) fail(label); return value }
function clock(value) { if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('免打扰时间'); return value }
export function validatePreferences(value) {
  knownKeys(value, Object.keys(DEFAULT_PREFERENCES), '设置')
  for (const key of ['effect', 'assistant', 'notifications', 'focus', 'scheduling']) knownKeys(value[key], Object.keys(DEFAULT_PREFERENCES[key]), key)
  const render = value.render ?? DEFAULT_PREFERENCES.render
  knownKeys(render, Object.keys(DEFAULT_PREFERENCES.render), '渲染')
  return {
    version: option(value.version, [1], '设置版本'),
    startupPage: ['calendar', 'timetable'].includes(value.startupPage) ? 'schedule' : option(value.startupPage, ['home', 'workbench', 'schedule', 'companion'], '启动页面'),
    theme: option(value.theme, ['dark', 'light'], '外观'), grid: bool(value.grid, '背景网格'),
    glass: option(value.glass, ['clear', 'soft'], '玻璃'), density: option(value.density, ['compact', 'comfortable'], '信息密度'),
    cardEdges: option(value.cardEdges === undefined ? DEFAULT_PREFERENCES.cardEdges : value.cardEdges, ['both', 'left', 'none'], '卡片装饰线'),
    effect: { style: option(value.effect.style, ['tide', 'filaments', 'stardust', 'off'], '回应特效'), intensity: option(value.effect.intensity, ['gentle', 'standard', 'vivid'], '特效强度'), motion: option(value.effect.motion, ['system', 'reduced', 'full'], '动态效果') },
    render: { profile: render.profile === 'rest' ? 'economy' : option(render.profile, ['full', 'smooth90', 'smooth120', 'balanced', 'economy'], '渲染档位') },
    assistant: { autonomy: option(value.assistant.autonomy, ['act', 'propose'], '主动权限'), personality: option(value.assistant.personality === undefined ? DEFAULT_PREFERENCES.assistant.personality : value.assistant.personality, ['low', 'medium', 'high'], '个性强度'), useMemory: bool(value.assistant.useMemory, '记忆上下文'), useHistory: bool(value.assistant.useHistory, '历史上下文') },
    notifications: { enabled: bool(value.notifications.enabled, '通知'), quietStart: clock(value.notifications.quietStart), quietEnd: clock(value.notifications.quietEnd), opportunities: bool(value.notifications.opportunities, '机会提醒') },
    focus: { focusMin: integer(value.focus.focusMin, 5, 120, '专注时长'), restMin: integer(value.focus.restMin, 1, 30, '休息时长') },
    scheduling: { bufferMin: integer(value.scheduling.bufferMin, 0, 60, '排程缓冲') },
  }
}
export function getPreferences(db) {
  const saved = db.getPreference('app')
  if (!saved) return structuredClone(DEFAULT_PREFERENCES)
  return validatePreferences(saved)
}
export function savePreferences(db, input) {
  knownKeys(input, ['expected', 'value'], '设置更新')
  return db.transaction(() => {
  const current = getPreferences(db)
  if (JSON.stringify(validatePreferences(input.expected)) !== JSON.stringify(current)) throw new ValidationError('设置已在其他窗口更新，请重新打开后再保存', 409)
  const value = validatePreferences(input.value)
  db.setPreference('app', value)
  return value
  })
}
