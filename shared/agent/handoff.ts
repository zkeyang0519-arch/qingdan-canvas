import type { ProjectSummary, SummaryItem } from "./contracts";
import { moduleStatusLabels } from "./progress";

export type HandoffSection = { title: string; paragraphs: string[] };

const itemText = (item: SummaryItem) =>
  `${item.text}${item.evidenceRef ? `\n  依据：${item.evidenceRef}` : ""}`;
const itemsText = (items: SummaryItem[], empty: string) =>
  items.length ? items.map((item) => `• ${itemText(item)}`).join("\n") : empty;

// One ordered report for the summary page, durable chat message and next task.
export function handoffSections(summary: ProjectSummary): HandoffSection[] {
  const handoff = summary.handoff;
  if (!handoff || !summary.background || !summary.modules) return [];
  const background = summary.background;
  const moduleProgress = summary.modules.length
    ? summary.modules.map((module) =>
        [
          `${module.name} · ${moduleStatusLabels[module.status]}`,
          `已实现 / 当前进展\n${itemsText(module.current, "尚未确认，不能据此认定已完成。")}`,
          `未完成 / 待核实\n${itemsText(module.remaining, "本次未确认剩余事项，不代表全部完成。")}`,
        ].join("\n\n"),
      )
    : ["尚未确认模块进度，接手前需检查相关实现。"];
  // These fields remain accepted for old clients and mixed reports. Preserve
  // their independent facts even though new prompts prefer module fields.
  for (const [key, label] of [
    ["completed", "补充已完成"],
    ["inProgress", "补充进行中"],
    ["pending", "补充待处理"],
  ] as const)
    if (summary[key].length)
      moduleProgress.push(`${label}\n${itemsText(summary[key], "")}`);
  const remainingContext = [
    itemsText(
      handoff.currentFocus,
      "当前具体停点尚未确认，接手前需核对最新需求。",
    ),
    ...(summary.blockers.length
      ? [`阻碍\n${itemsText(summary.blockers, "")}`]
      : []),
    ...(summary.uncertainties.length
      ? [`待核实\n${itemsText(summary.uncertainties, "")}`]
      : []),
  ];
  return [
    {
      title: "项目目标与当前状态",
      paragraphs: [
        `${background.name}\n项目目标：${background.purpose}\n当前阶段：${background.stage}`,
        summary.overview,
        itemsText(handoff.technicalOverview, "技术结构与运行范围尚未确认。"),
      ],
    },
    {
      title: "已完成与未完成",
      paragraphs: moduleProgress,
    },
    {
      title: "最近完成的工作",
      paragraphs: [
        itemsText(
          handoff.recentChanges,
          "本次未确认近期改动，不从旧报告推断新增完成。",
        ),
      ],
    },
    { title: "当前停在哪里", paragraphs: remainingContext },
    {
      title: "修改入口",
      paragraphs: handoff.entryPoints.length
        ? handoff.entryPoints.map(
            (entry) =>
              `${entry.path}\n负责：${entry.responsibility}\n何时修改：${entry.changeWhen}`,
          )
        : ["尚未确认具体修改入口，接手前需先定位并读取相关文件。"],
    },
    {
      title: "接手顺序与验证",
      paragraphs: [
        ...(handoff.nextSteps.length
          ? [...handoff.nextSteps]
              .sort((a, b) => a.priority - b.priority)
              .map(
                (step, index) =>
                  `${index + 1}. P${step.priority} · ${itemText(step)}\n验收：${step.acceptance}`,
              )
          : ["下一步工作尚未确认；先核对目标与当前停点，再决定实施顺序。"]),
        ...(summary.modules.flatMap((module) => module.nextSteps).length
          ? [
              `模块补充建议\n${itemsText(
                summary.modules.flatMap((module) => module.nextSteps),
                "",
              )}`,
            ]
          : []),
        `已有验证与局限\n${itemsText(summary.verification, "本次未确认已有验证结果，不代表测试通过。")}`,
        ...(handoff.constraints.length
          ? [`接手约束\n${itemsText(handoff.constraints, "")}`]
          : []),
      ],
    },
  ];
}

export function handoffReportText(summary: ProjectSummary): string {
  return handoffSections(summary)
    .map(
      (section, index) =>
        `${index + 1}. ${section.title}\n\n${section.paragraphs.join("\n\n")}`,
    )
    .join("\n\n");
}
