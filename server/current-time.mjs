/** One system-clock sample supplies every representation of the same instant. */
export function readCurrentTime(clock, timezone) {
  const value = clock()
  const instant = new Date(value instanceof Date ? value.getTime() : value)
  if (!Number.isFinite(instant.getTime())) throw new Error('INVALID_SYSTEM_CLOCK')
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant).map(part => [part.type, part.value]))
  return {
    source: 'local_system_clock', capturedAt: instant.toISOString(), timezone,
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localMinute: `${parts.hour}:${parts.minute}`,
    localDateTime: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
    displayDate: new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, dateStyle: 'full' }).format(instant),
    displayTime: new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, dateStyle: 'full', timeStyle: 'long' }).format(instant),
  }
}

/** Standalone clock questions, including greetings; mixed requests stay intact. */
export function directTimeRequest(text) {
  const request = text
    .trim()
    .replace(/^析熙[\s，,:：]*/u, '')
    .replace(/[？?。.!！]+$/u, '')
    .trim()
  const question = request.replace(/^(?:请问|请告诉我|告诉我|能告诉我|可以告诉我)[\s，,]*/u, '')
  if (/^(?:(?:现在)?几点(?:钟)?(?:了)?|(?:现在|当前)(?:的)?时间(?:是多少)?|现在是什么时间|现在钟点)(?:吗|呢|呀|啊)?$/u.test(question)) return 'time'
  if (/^(?:(?:现在|今天)(?:的)?日期(?:是几号)?|今天(?:是)?(?:几号|星期几|周几)|现在(?:是)?几号)(?:吗|呢|呀|啊)?$/u.test(question)) return 'date'
  return null
}

export function clockMessage(current) {
  return { role: 'system', content: `本机实时钟表（本次调用前由 ASTaria 读取）\n${JSON.stringify(current)}\n这是当前时刻的权威来源，localMinute 是用户时区下此刻的钟点。回答“现在”采用这次读数；历史发言、记忆、摘要与旧工具读数各自属于当时。需要再次核对时调用 read_current_time，按新读数自然回答` }
}
