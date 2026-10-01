import { DEFAULT_PREFERENCES } from './preferences.mjs'
import { DEFAULT_CONTEXT_BUDGET, DEFAULT_REASONING_EFFORT, DEFAULT_STREAM_RESPONSES, DEFAULT_WEB_SEARCH, LOCAL_DEFAULT, resolveContextBudget } from './modelSettings.mjs'

// Product knowledge is separate from task facts and execution policy. Keep this
// aligned with shipped screens; planned features are not available capabilities.
export const ASTARIA_PRODUCT_GUIDE = {
  name: 'ASTaria',
  navigation: '左上角 ASTaria 导航：首页、工作台、日程、余时、设置；弦轨从余时进入',
  pages: {
    home: {
      name: '首页', purpose: '和析熙交流、收下新事项、查看当天安排',
      userControls: '聊天、查看和复制回复/思考、重试未完成回复；回执查看真实变更及可用的撤销；创建事项后快捷改DDL和预估时长，具体选项见uiCapabilities.taskCreationReceipt',
      tools: ['read_tasks', 'create_tasks', 'update_task'],
    },
    workbench: {
      name: '工作台', purpose: '现在怎么做：选择任务、推进步骤、专注与休息',
      userControls: '查看近期截止、选择任务、编辑与勾选步骤、专注计时及完成任务；已完成默认最近7天，完整历史可搜索和按日期筛选',
      startable: '现在可以开始根据真实日程判断：无具体时段且没有未来开始限制的任务可开始；已排任务在开始前20分钟出现，正在进行的继续显示；所有安排已过而未完成的可继续，仍有未来安排的等下一段；余时目标不混进普通作业列表',
      tools: ['read_task_steps', 'save_task_steps', 'read_companion', 'save_handoff'],
    },
    schedule: {
      name: '日程', purpose: '现在到接下来要做什么：课程、活动、任务时段与截止',
      userControls: '月/周/日视图、选日期、记录事项、每周安排；查看与编辑具体安排、锁定计划、携带物品及提交状态',
      tools: ['read_planner', 'plan_tasks', 'remove_plan', 'save_day_events', 'remove_day_event', 'read_weekly_timetable', 'edit_weekly_timetable', 'set_day_timetable', 'restore_day_timetable', 'save_task_preparation'],
    },
    'free-time': {
      name: '余时', purpose: '未来想做什么：长期学习、复习、兴趣与愿望',
      userControls: '维护目标、优先级、最低周频率、单次时长范围和阶段目标；查看未来7天安排、学习反馈与下一步；暂停或恢复目标；“待考虑”保存原来的牵挂/心愿，可加入自动安排；“进入轨道”进入弦轨',
      behavior: '已交给余时的目标通过本地排程安排到真实空档并留休息，通常20–40分钟但可调整；你能根据反馈修改重点与配比。同一长期目标可有多次学习时段，完成一次不等于完成整个目标。暂停停止新增安排，已有时段保留；当前没有“今日休息、次日自动恢复”开关，也没有每次添加愿望必定自动发起聊天的机制',
      tools: ['read_free_time', 'save_free_time_goal', 'schedule_free_time', 'complete_free_time_session', 'remember_wish', 'update_wish'],
    },
    strings: {
      name: '弦轨', purpose: '从首页黑洞或余时进入的沉浸式真实日程排序，一次专注一天，可调整今天、明天、后天',
      userControls: '镜头停在事件视界边缘，下方金白光带持续流动。顶部切换今天、明天、后天；读取已排且未完成的事项，今天原定时间已过但仍待办的也能重排，真正进行中和锁定安排只读，不将未排期待办塞入。首次未保存分组时按实际内容和共同目标智能建议分组，每组1–6段且不跨日；已保存分组保留。“智能整理”可主动重新建议，“调整分组”支持改名、拆组、合组和跨组移动，手动改动待保存时避免智能建议覆盖。组名常驻；拖动组或方向键排序，拖到顶部日期或Alt加方向键移到目标日末尾。点开组后事项沿同一条地平线展开，可调整组内顺序；“收拢这组”返回整天。较多时分页完整保留。外观统一在设置→外观与动画→弦轨，自动保存在本机，支持复制和导入',
      behavior: '智能建议与手动调整都只改草稿；建议失败可手动，同一快照短时复用结果。“完成”先本地生成可行初排，再用当前模型的一次轻量请求微调时刻；云端分组和排程最高low，不改聊天偏好。沿地平线显示真实事项数量、用时/空档核对、模型具体建议、终检、保存和等待时间，可展开活动记录。最终重新检查日程版本、空档、固定占用、截止和重复事项，全通过才统一保存时间与分组；不擅自换日、漏项或减时长。仅改名保留原时刻，不调用排程模型；今天有过时待办，即使未拖动也会重新安排。等待模型使合法初排起点过期时按当前空档更新并复核。取消不提交。空间不足、模型失败、数据变化均说明并保留原日程；智能建议不能说成已保存。成功刷新工作台和余时，支持撤销。七日普通弦轨保留原模型排程',
      tools: [],
    },
    settings: {
      name: '设置', purpose: '用户管理析熙、模型、通知、时间安排、外观和本机数据',
      userControls: '析熙：个性低/中/高、直接执行或先提议、记忆和历史开关、查看/更正/忘记记忆；模型：DeepSeek API或本地服务、模型选择/连接测试、受支持的本地模型安装、流式输出和上下文预算；云端思考深度Max/High/Low/关闭；联网搜索默认关闭，打开后只把明确查询词发送到DeepSeek云端，本地模型正文仍留在本机；时间安排：专注/休息/缓冲；通知及免打扰、变更记录与可用撤销；外观与动画（包括弦轨地平线、光流、指针牵动和退出时长）；数据备份导入导出',
      tools: ['remember', 'forget_memory', 'search_history'],
      optionalTools: ['web_search（仅在设置中明确打开后提供）'],
    },
  },
  records: {
    task: '事项保存标题、DDL、估时、状态与步骤；没有日历时段也仍然存在。普通作业经create_tasks默认自动排期，手动只记录不等于自动排期',
    plan: '日历时段通过taskId关联事项，含日期和起止时刻；同一事项可以分段。remove_plan仅移除时段，不删除事项或DDL',
    deadline: 'DDL是最晚完成/交付时间，预估时间是所需分钟数，startAt是最早计划日期意向，具体何时做由日历时段决定；创建时scheduleDate表示用户要求必须在哪一天做，放不下会留待取舍，不自动跨天，也不凭此捏造DDL',
    timetable: '周模板是每周重复的课程/空课/休息；单日调课是某一天的副本；单日固定活动是独立占用。以读取到的enabled且kind=available窗口为准，例如已配置的空课、晚自习、宿舍，扣除窗口里已有占用；不能只按名称判断可用',
    wish: '还在考虑的愿望独立于作业；交给余时后才成为可自动排程的长期目标',
    sharedState: '首页、工作台、日程、余时读取同一本机数据库。回执是操作记录，用户可随后快捷修改或撤销；当前数据库与版本是现状，旧聊天不是现状',
  },
  boundaries: {
    execution: '只调用本轮实际提供的工具；产品里有按钮不代表你能代点。明确请求按assistantPreferences.autonomy执行；设置、安装模型、锁定/解锁、专注计时、导入导出、弦轨完成/取消目前由用户在界面操作',
    deletion: '工具update_task可把事项标为dropped，不能声称已彻底删除记录；remove_plan只是取消时间，撤销回执是回退那次操作，不能混用',
    notifications: '现有站内通知与免打扰不等于定时唤醒；你没有定时提醒工具，不能承诺到点叫用户',
    visibility: '你看到的是传入的数据与页面标识，不会自动看见屏幕、拖动草稿、未保存输入或其他软件。truncated/readMore表示还可读，不表示不存在',
    settings: '当前设置见applicationSettings；不因回复慢或上下文不足擅自改思考深度/预算。联网搜索是独立的显式开关，关闭时不会提供web_search工具；打开时只发送用户明确查询词到DeepSeek，不上传本机资料。流式展示取决于模型实际返回的内容；关闭应用上下文限制不取消模型接口上限',
  },
}

/** Under a small context limit, UI detail yields before live tasks and times. */
export function compactProductGuide() {
  return {
    name: ASTARIA_PRODUCT_GUIDE.name, navigation: ASTARIA_PRODUCT_GUIDE.navigation,
    pages: Object.fromEntries(Object.entries(ASTARIA_PRODUCT_GUIDE.pages).map(([key, page]) => [key, { name: page.name, purpose: page.purpose }])),
    records: '事项、日历时段、DDL、周模板、单日活动、余时目标和待考虑愿望各自独立；各页共享本机数据。快捷修改DDL/估时不移动时段；删除时段不删除事项',
    boundaries: '工具清单决定可执行能力。设置/模型安装/计时/备份/拖弦需用户操作；无定时唤醒工具。余时暂停保留已排时段；尚无今日休息自动恢复开关',
    compact: true, readMore: { tool: 'read_product_guide', sections: ['home', 'workbench', 'schedule', 'free-time', 'strings', 'settings', 'records', 'boundaries'] },
  }
}

/** Whitelist user-facing settings; never copy connection URLs or credentials. */
export function applicationSettings(db) {
  // Context reads also support older partial preferences. Validation belongs
  // to the settings write path, not to an unrelated message dispatch.
  const preferences = db.getPreference('app') ?? {}
  const connection = db.getPreference('model-connection') ?? {}
  const model = { provider: 'deepseek', reasoningEffort: DEFAULT_REASONING_EFFORT,
    streamResponses: DEFAULT_STREAM_RESPONSES, contextBudget: DEFAULT_CONTEXT_BUDGET, webSearch: DEFAULT_WEB_SEARCH, ...connection,
    webSearch: { ...DEFAULT_WEB_SEARCH, ...(connection.webSearch ?? {}) },
    cloudModel: db.getModel(), local: { ...LOCAL_DEFAULT, ...connection.local } }
  const budget = resolveContextBudget(model)
  return {
    focus: { ...DEFAULT_PREFERENCES.focus, ...preferences.focus },
    scheduling: { ...DEFAULT_PREFERENCES.scheduling, ...preferences.scheduling },
    notifications: { ...DEFAULT_PREFERENCES.notifications, ...preferences.notifications },
    model: {
      provider: model.provider,
      name: model.provider === 'local' ? model.local.model || null : model.cloudModel,
      ...(model.provider === 'local' ? { engine: model.local.engine } : { reasoningEffort: model.reasoningEffort }),
      streamResponses: model.streamResponses,
      webSearch: model.webSearch.enabled,
      contextBudget: { mode: model.contextBudget.mode, applicationLimit: budget.enabled ? budget.hard : null },
    },
  }
}
