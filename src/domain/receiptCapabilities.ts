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
    updatesExistingTask: true,
    deadline: {
      requiresChat: false,
      reschedulesCalendar: false,
      description: '截止日期/时刻直接保存到同一事项，不移动日历时段',
    },
    estimate: {
      requiresChat: true,
      reschedulesCalendar: true,
      description: '估时发回原对话，核对冲突后重排原事项；以真实回执为准',
    },
  },
} as const
