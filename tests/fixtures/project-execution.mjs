export const savedProjectSummary = {
  overview: "当前项目提供团队待办协作。",
  completed: [{ text: "已有登录入口" }],
  inProgress: [],
  pending: [{ text: "导出能力待补齐" }],
  blockers: [],
  verification: [],
  uncertainties: [{ text: "还未验证移动端" }],
};

export function projectItems(canvasId = "canvas") {
  return [
    {
      taskId: "task-export",
      text: "实现导出",
      instruction: "为当前列表增加 CSV 导出。",
      acceptance: [{ id: "export-review", kind: "human", required: true, description: "空列表也能导出" }],
      source: { taskRef: { canvasId, noteId: "note", taskId: "task-export" }, generation: 2, specRevision: 3 },
    },
    {
      taskId: "task-mobile",
      text: "适配移动端",
      instruction: "修复小屏幕上的按钮溢出。",
      acceptance: [{ id: "mobile-review", kind: "human", required: true, description: "320px 宽度没有横向滚动" }],
      source: { taskRef: { canvasId, noteId: "note", taskId: "task-mobile" }, generation: 4, specRevision: 2 },
    },
  ];
}
