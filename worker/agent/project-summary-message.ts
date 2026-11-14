import type { ProjectContext } from "../../shared/agent/project";
import { progressText } from "../../shared/agent/progress";
import { handoffReportText } from "../../shared/agent/handoff";

export function projectSummaryMessage(project: ProjectContext) {
  const history = project.sourceKind === "codex_history";
  if (project.summary?.handoff)
    return [
      `项目交接报告 · 第 ${project.summaryRevision} 版`,
      project.sourceKind === "project_current" ? "根据本次按需读取的项目文件和相关记录整理。" : "根据已保存的项目交接资料整理。",
      ...(project.capturedAt ? [`报告时间：${project.capturedAt}`] : []),
      ...(project.cwd ? [`项目目录：${project.cwd}`] : []),
      handoffReportText(project.summary),
    ].join("\n\n");
  const parts = [
    `${project.summary?.modules ? "项目进度" : "项目摘要"} · 第 ${project.summaryRevision} 版`,
    history
      ? "根据所选项目的 Codex 历史任务总结整理，本次未重新检查代码或运行测试。"
      : project.sourceKind === "project_current"
        ? "根据本次按需读取的项目文件和相关记录整理。"
        : "根据已保存的项目摘要整理。",
    ...(project.capturedAt ? [`摘要时间：${project.capturedAt}`] : []),
    project.summary!.overview,
    ...progressText(project.summary!),
  ];
  for (const [key, label] of [
    ["completed", "已完成"],
    ["inProgress", "进行中"],
    ["pending", "下一步待办"],
    ["blockers", "阻碍"],
    ["verification", history ? "历史验证记录" : "验证记录"],
    ["uncertainties", "待核实"],
  ] as const) {
    const items = project.summary![key];
    if (items.length)
      parts.push(
        `${label}\n${items.map((item) => `• ${item.text}`).join("\n")}`,
      );
  }
  const coverage = project.summary!.coverage;
  if (coverage)
    parts.push(
      `数据覆盖：已提供 ${coverage.deliveredRecords}/${coverage.totalRecords} 条历史，${coverage.threadCount} 个会话${coverage.cachedRecords ? `，复用 ${coverage.cachedRecords} 条，本次新读取 ${coverage.deliveredRecords - coverage.cachedRecords} 条` : ""}${coverage.partial ? "，存在覆盖缺口" : ""}。读取失败 ${coverage.failedThreadCount}，排除来源不明分叉 ${coverage.excludedForkCount}，缺少最终答复 ${coverage.missingFinalCount}，非完成轮次 ${coverage.incompleteTurnCount}。`,
    );
  const text = parts.join("\n\n");
  return project.summary?.modules
    ? text
    : text.length > 16000
      ? text.slice(0, 15950) + "\n\n摘要较长，完整内容可在项目摘要中查看。"
      : text;
}
