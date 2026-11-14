import type { ProjectSummary, SummaryItem } from "./contracts";

export const moduleStatusLabels = {
  completed: "已完成",
  in_progress: "进行中",
  partial: "部分完成",
  blocked: "受阻",
  not_started: "未开始",
  unknown: "待核实",
} as const;

export function progressText(summary: ProjectSummary): string[] {
  if (!summary.background || !summary.modules) return [];
  const background = summary.background;
  return [
    `项目背景\n${background.name}\n项目目标：${background.purpose}\n当前阶段：${background.stage}`,
    ...summary.modules.map((module) =>
      [
        `${module.name} · ${moduleStatusLabels[module.status]}`,
        ...(
          [
            ["current", "当前进度"],
            ["remaining", "剩余工作"],
            ["nextSteps", "下一步"],
          ] as const
        ).map(
          ([key, label]) =>
            `${label}\n${module[key].length ? module[key].map((item) => `• ${item.text}`).join("\n") : "暂无明确记录"}`,
        ),
      ].join("\n\n"),
    ),
  ];
}

export function summarySourceItems(summary: ProjectSummary): SummaryItem[] {
  return [
    summary.completed,
    summary.inProgress,
    summary.pending,
    summary.blockers,
    summary.verification,
    summary.uncertainties,
    ...(summary.modules ?? []).flatMap((module) => [
      module.current,
      module.remaining,
      module.nextSteps,
    ]),
    ...(summary.handoff ? [
      summary.handoff.technicalOverview,
      summary.handoff.recentChanges,
      summary.handoff.currentFocus,
      summary.handoff.nextSteps,
      summary.handoff.constraints,
      summary.handoff.entryPoints.map(entry => ({ text: entry.responsibility, evidenceRef: entry.path })),
    ] : []),
  ].flat();
}
