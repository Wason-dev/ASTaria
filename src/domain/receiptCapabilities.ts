/** The creation receipt and the assistant describe the same editable controls. */
export const TASK_RECEIPT_CAPABILITIES = {
  location: '创建事项回执下方',
  deadline: {
    dateShortcuts: ['今天', '明天', '后天'],
    timeShortcuts: ['08:00', '12:00', '18:00', '20:00'],
    customDate: true,
    customTime: true,
    allDay: true,
    clearable: true,
  },
  estimate: { minuteShortcuts: [15, 20, 30, 45, 60], customMin: 1, customMax: 1440 },
  saving: {
    requiresChat: false,
    updatesExistingTask: true,
    reschedulesCalendar: false,
    description: '用户点击后直接保存同一事项的截止日期/时刻或预估分钟数；具体日历时段另行安排',
  },
} as const
