import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { handoffSummary } from "./fixtures/project-handoff.mjs";

const { outputFiles } = await build({
  stdin: {
    contents: `
    export { projectSummarySchema } from './shared/agent/schemas';
    export { projectSummaryMessage } from './worker/agent/project-summary-message';
    export { outputSchema, runContext, runInstructions, runPrompt } from './runner/prompt';
    export { validateInspectionReferences } from './runner/project-inspection';
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { ProjectSummaryCard } from './src/agent/ProjectSummaryPanel.jsx';
    export const renderReport = summary => renderToStaticMarkup(React.createElement(ProjectSummaryCard, {state: {status:'ready',ready:true,summaryRevision:1,sourceKind:'project_current',summary}}));
  `,
    resolveDir: path.resolve("."),
  },
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});
const temp = mkdtempSync(path.resolve("node_modules/.cache/handoff-summary-"));
const bundlePath = path.join(temp, "api.mjs");
writeFileSync(bundlePath, outputFiles[0].text);
const api = await import(pathToFileURL(bundlePath));
test.after(() => rmSync(temp, { recursive: true, force: true }));
const sections = [
  "项目目标与当前状态",
  "已完成与未完成",
  "最近完成的工作",
  "当前停在哪里",
  "修改入口",
  "接手顺序与验证",
];
const project = (summary) => ({
  summary,
  summaryRevision: 3,
  sourceKind: "project_current",
});

test("handoff report survives schema parsing and requires module background", () => {
  assert.deepEqual(
    api.projectSummarySchema.parse(handoffSummary),
    handoffSummary,
  );
  assert.equal(
    api.projectSummarySchema.safeParse({
      ...handoffSummary,
      background: undefined,
      modules: undefined,
    }).success,
    false,
  );
  for (const path of [
    "../outside.ts",
    "D:/secret.ts",
    "/etc/passwd",
    "native:git",
  ]) {
    const summary = structuredClone(handoffSummary);
    summary.handoff.entryPoints[0].path = path;
    assert.equal(
      api.projectSummarySchema.safeParse(summary).success,
      false,
      path,
    );
  }
});

test("current summary requests a complete handoff without requiring complete history", () => {
  assert.ok(api.outputSchema("summary").required.includes("handoff"));
  assert.equal(
    api.outputSchema("summary", "history").properties.handoff,
    undefined,
  );
  const context = api.runContext({
    kind: "summary",
    context: { projectSummary: null, decisions: [], previousTaskNotes: [] },
  });
  assert.match(context, /修改入口/);
  assert.match(context, /验收/);
  assert.match(context, /不要求读完|无需读完/);
  assert.doesNotMatch(context, /350/);
});

test("handoff sources and modification entries must refer to delivered files", () => {
  const receipts = [{ path: "src/export.ts", kind: "read", offset: 0 }];
  assert.equal(
    api.validateInspectionReferences(handoffSummary, receipts),
    handoffSummary,
  );
  for (const field of [
    "technicalOverview",
    "recentChanges",
    "currentFocus",
    "constraints",
    "nextSteps",
  ]) {
    const summary = structuredClone(handoffSummary);
    summary.handoff[field][0].evidenceRef = "unread.ts";
    assert.throws(
      () => api.validateInspectionReferences(summary, receipts),
      /来源|文件/,
    );
  }
  for (const path of ["unread.ts", "native:git"]) {
    const summary = structuredClone(handoffSummary);
    summary.handoff.entryPoints[0].path = path;
    assert.throws(
      () => api.validateInspectionReferences(summary, receipts),
      /来源|文件/,
    );
  }
});

test("chat and summary page show all six handoff sections without duplicated modules", () => {
  for (const output of [
    api.projectSummaryMessage(project(handoffSummary)),
    api.renderReport(handoffSummary),
  ]) {
    let last = -1;
    for (const section of sections) {
      const index = output.indexOf(section);
      assert.ok(index > last, section);
      last = index;
    }
    for (const value of [
      "JSON 导出已实现",
      "CSV 尚未实现",
      "src/export.ts",
      "生成导出内容",
      "补齐 CSV 格式转换",
      "空列表、中文与引号",
      "保留 JSON 导出接口",
      "线上部署状态未检查",
    ])
      assert.ok(output.includes(value), value);
    assert.equal(output.split("JSON 导出已实现").length - 1, 1);
  }
});

test("full report keeps detail beyond 350 characters and its final acceptance", () => {
  const summary = structuredClone(handoffSummary);
  summary.handoff.recentChanges[0].text = "已确认的详细改动。".repeat(80);
  summary.handoff.nextSteps[0].acceptance = "交接尾部验收条件不能丢失";
  const text = api.projectSummaryMessage(project(summary));
  assert.ok(text.length > 350);
  assert.ok(text.includes(summary.handoff.recentChanges[0].text));
  assert.match(text, /交接尾部验收条件不能丢失/);
});

test("handoff reaches the next developer's task context", () => {
  const context = api.runContext({
    kind: "task",
    task: { text: "补齐 CSV", instruction: "完成 CSV", acceptance: [] },
    context: {
      projectSummary: handoffSummary,
      decisions: [],
      previousTaskNotes: [],
    },
  });
  for (const value of [
    "src/export.ts",
    "保留 JSON 导出接口",
    "空列表、中文与引号",
    "当前停在 CSV 导出",
  ])
    assert.ok(context.includes(value), value);
});

test("accepted mixed legacy and handoff fields retain every unique fact in all report surfaces", () => {
  const summary = structuredClone(handoffSummary);
  summary.completed = [{ text: "旧字段独有：登录已实现" }];
  summary.inProgress = [{ text: "旧字段独有：退出功能开发中" }];
  summary.pending = [{ text: "旧字段独有：补齐失效会话验收" }];
  assert.deepEqual(api.projectSummarySchema.parse(summary), summary);
  const context = api.runContext({
    kind: "task",
    task: { text: "接手", instruction: "继续", acceptance: [] },
    context: { projectSummary: summary, decisions: [], previousTaskNotes: [] },
  });
  for (const output of [
    api.projectSummaryMessage(project(summary)),
    api.renderReport(summary),
    context,
  ])
    for (const item of [
      ...summary.completed,
      ...summary.inProgress,
      ...summary.pending,
    ])
      assert.ok(output.includes(item.text), item.text);
});

test("empty evidence is reported as unknown rather than all work complete", () => {
  const summary = structuredClone(handoffSummary);
  summary.modules = [];
  for (const key of Object.keys(summary.handoff)) summary.handoff[key] = [];
  const text = api.projectSummaryMessage(project(summary));
  assert.match(text, /尚未确认|未确认/);
  assert.doesNotMatch(text, /全部完成|无需后续工作/);
});
