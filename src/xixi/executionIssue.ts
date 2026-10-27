/** Human-facing execution status only. Detailed repair instructions stay in
 * the model/tool journal and must not leak into an alert for the user. */
export function publicExecutionIssue(reason: string): string {
  if (/详细分页每次读取一天|请指定section再读取详细分页|分页起点和数量无效/u.test(reason)) return '部分日程未能读取完整，析熙还需要重新核对'
  if (reason.includes('任务只能排进已知可用窗口')) return '这段时间没有设置为可安排任务的空档，任务尚未排入日程'
  if (reason.includes('调课依据需为当前或相邻确认')) return '这次日程修改没能核对你之前的要求，因此没有保存'
  if (/先用 read_planner|必须先读取创建后/u.test(reason)) return '尚未核对当天的最新日程，安排还没有保存'
  if (reason.includes('finish_response')) return '操作结果已保留，析熙的说明还没有生成完整'
  if (reason.startsWith('安排不符合事项先后关系：')) return '这段时间与相关事项的先后顺序冲突，尚未保存；原安排保留'
  return reason.replace(/\b(?:read_planner|read_weekly_timetable|plan_tasks|save_day_events|ask_user)\b/gu, name => ({
    read_planner: '日程核对', read_weekly_timetable: '课表核对', plan_tasks: '安排日程', save_day_events: '记录活动', ask_user: '询问',
  })[name] ?? name)
}
