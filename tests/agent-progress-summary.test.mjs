import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
const { outputFiles } = await build({
  stdin: {
    contents:
      "export { projectSummarySchema } from './shared/agent/schemas'; export { projectSummaryMessage } from './worker/agent/project-summary-message'; export { outputSchema, runContext } from './runner/prompt'; export { validateSummaryReferences } from './runner/summary-evidence'; export { validateInspectionReferences } from './runner/project-inspection';",
    resolveDir: path.resolve("."),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});
const api = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);
const legacy = {
  overview: "正在补齐导出",
  completed: [],
  inProgress: [],
  pending: [],
  blockers: [],
  verification: [],
  uncertainties: [],
};
export const progress = {
  ...legacy,
  background: {
    name: "离线清单",
    purpose: "管理个人项目待办",
    stage: "核心编辑完成，导出开发中",
  },
  modules: [
    {
      name: "导出",
      status: "partial",
      current: [
        { text: "JSON 已实现", evidenceRef: "codex:thread/turn/answer" },
      ],
      remaining: [{ text: "CSV 尚未实现" }],
      nextSteps: [{ text: "P1 实现 CSV，并核对空列表与中文编码" }],
    },
  ],
};
test("progress schema accepts module reports and retains legacy summaries", () => {
  assert.deepEqual(api.projectSummarySchema.parse(legacy), legacy);
  assert.deepEqual(api.projectSummarySchema.parse(progress), progress);
  assert.equal(
    api.projectSummarySchema.safeParse({
      ...progress,
      modules: [{ ...progress.modules[0], status: "probably_done" }],
    }).success,
    false,
  );
});
test("new history report schema requires background and structured module progress", () => {
  const schema = api.outputSchema("summary");
  assert.ok(schema.required.includes("background"));
  assert.ok(schema.required.includes("modules"));
  assert.equal(
    api.outputSchema("summary", "evidence").properties.background,
    undefined,
  );
});
test("chat report presents project background and actionable module progress before coverage", () => {
  const text = api.projectSummaryMessage({
    summary: progress,
    summaryRevision: 2,
    sourceKind: "codex_history",
  });
  for (const fragment of [
    "项目进度",
    "项目背景",
    "离线清单",
    "管理个人项目待办",
    "核心编辑完成",
    "导出",
    "部分完成",
    "当前进度",
    "JSON 已实现",
    "剩余工作",
    "CSV 尚未实现",
    "下一步",
    "P1 实现 CSV",
  ])
    assert.ok(text.includes(fragment), fragment);
  assert.ok(!text.includes("暂无记录"));
});

test("current project report is delivered directly with current-read provenance", () => {
  const text = api.projectSummaryMessage({ summary: progress, summaryRevision: 1, sourceKind: "project_current" });
  assert.match(text, /本次按需读取/);
  assert.match(text, /JSON 已实现/);
  assert.match(text, /CSV 尚未实现/);
  assert.doesNotMatch(text, /根据已保存的项目摘要整理|本次未重新检查代码/);
});
test("following execution receives module background and remaining work", () => {
  const context = api.runContext({
    kind: "task",
    task: { text: "补齐 CSV", instruction: "完成 CSV", acceptance: [] },
    context: { projectSummary: progress, decisions: [], previousTaskNotes: [] },
  });
  assert.match(context, /管理个人项目待办/);
  assert.match(context, /CSV 尚未实现/);
});

test("module references cannot bypass legacy evidence validation", () => {
  assert.throws(
    () => api.validateSummaryReferences(progress, { files: [], inventory: [] }),
    /来源|文件/,
  );
  assert.throws(
    () => api.validateInspectionReferences(progress, []),
    /来源|文件/,
  );
});
