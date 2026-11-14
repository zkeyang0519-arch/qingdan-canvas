export const handoffSummary = {
  overview: "离线清单核心功能可用，当前重点是补齐 CSV 导出。",
  background: {
    name: "离线清单",
    purpose: "管理个人项目待办",
    stage: "核心编辑可用，补齐导出",
  },
  completed: [],
  inProgress: [],
  pending: [],
  blockers: [],
  verification: [
    {
      text: "源码包含 JSON 导出测试；本轮未运行测试。",
      evidenceRef: "src/export.ts",
    },
  ],
  uncertainties: [{ text: "线上部署状态未检查。" }],
  modules: [
    {
      name: "导出",
      status: "partial",
      current: [{ text: "JSON 导出已实现", evidenceRef: "src/export.ts" }],
      remaining: [{ text: "CSV 尚未实现", evidenceRef: "src/export.ts" }],
      nextSteps: [],
    },
  ],
  handoff: {
    technicalOverview: [
      {
        text: "前端调用导出模块，转换后的内容交给下载入口。",
        evidenceRef: "src/export.ts",
      },
    ],
    recentChanges: [
      {
        text: "最新工作区已补齐 JSON 导出，尚未提交。",
        evidenceRef: "native:git",
      },
    ],
    currentFocus: [
      {
        text: "当前停在 CSV 导出；空列表与中文编码的行为仍需确认。",
        evidenceRef: "src/export.ts",
      },
    ],
    entryPoints: [
      {
        path: "src/export.ts",
        responsibility: "生成导出内容",
        changeWhen: "补齐 CSV 格式转换时从这里开始",
      },
    ],
    nextSteps: [
      {
        priority: 1,
        text: "补齐 CSV 导出并核对边界输入",
        acceptance: "空列表、中文与引号均可正确导出并重新读取。",
        evidenceRef: "src/export.ts",
      },
    ],
    constraints: [
      {
        text: "保留 JSON 导出接口，不改变已保存清单。",
        evidenceRef: "src/export.ts",
      },
    ],
  },
};
