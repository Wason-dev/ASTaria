import { DEFAULT_PREFERENCES } from './preferences.mjs'
import { DEFAULT_CONTEXT_BUDGET, DEFAULT_REASONING_EFFORT, DEFAULT_STREAM_RESPONSES, LOCAL_DEFAULT, resolveContextBudget } from './modelSettings.mjs'

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
      name: '弦轨', purpose: '从余时打开的独立沉浸界面，当前是事件视界地平线视觉原型，一次专注一天',
      userControls: '镜头靠近黑洞事件视界边缘停住，下方一条有厚度的金白光带持续流动。顶部切换今天、明天、后天；组属于当天，长期项目可关联不同天的组。当前使用明确标记的示例组，组名常驻；拖动光带或组名排序，拿起后顶部日期浮现玻璃边缘，放到日期即移到目标日末尾并切换过去。点开组后，事项沿同一条地平线展开，拖动或方向键调整组内先后；“收拢这组”或Escape返回整天。方向键排序，Alt加方向键换天，Escape取消拖动。右上角“外观与调试”可调整地平线位置、弧度、光带厚度、亮度、光晕、流速、指针牵动和退出时长，参数自动保存在本机，可复制/导入。“保留外观”不改真实日程',
      behavior: '自动整理真实任务成组及按三日分组重排尚未接入，不能声称示例代表真实任务或已经保存日历。“现有日程排序”可进入保留的七天双弦版本：拖动下弦只改草稿，完成后模型提出具体时段并校验固定占用、锁定和DDL才保存；取消不提交。旧preview_route/preview_scenario也不等价于新交互',
      tools: [],
    },
    settings: {
      name: '设置', purpose: '用户管理析熙、模型、通知、时间安排、外观和本机数据',
      userControls: '析熙：个性低/中/高、直接执行或先提议、记忆和历史开关、查看/更正/忘记记忆；模型：DeepSeek API或本地服务、模型选择/连接测试、受支持的本地模型安装、流式输出和上下文预算；云端思考深度Max/High/Low/关闭；时间安排：专注/休息/缓冲；通知及免打扰、变更记录与可用撤销；外观与动画；数据备份导入导出',
      tools: ['remember', 'forget_memory', 'search_history'],
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
    settings: '当前设置见applicationSettings；不因回复慢或上下文不足擅自改思考深度/预算。流式展示取决于模型实际返回的内容；关闭应用上下文限制不取消模型接口上限',
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
    streamResponses: DEFAULT_STREAM_RESPONSES, contextBudget: DEFAULT_CONTEXT_BUDGET, ...connection,
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
      contextBudget: { mode: model.contextBudget.mode, applicationLimit: budget.enabled ? budget.hard : null },
    },
  }
}
