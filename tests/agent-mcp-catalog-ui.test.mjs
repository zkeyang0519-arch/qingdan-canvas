import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { groupMcpTools } from "../src/agent/mcp-tool-groups.js";

const directory = await mkdtemp(path.resolve(".tmp/mcp-catalog-ui-"));
await build({
  entryPoints: ["src/agent/McpToolsPanel.jsx"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  loader: { ".css": "empty" },
  outfile: path.join(directory, "panel.mjs"),
});
const dom = new JSDOM('<main id="root"></main>', {
  url: "http://localhost/app",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { default: Panel } = await import(
  pathToFileURL(path.join(directory, "panel.mjs"))
);
after(async () => {
  dom.window.close();
  assert.equal(path.dirname(directory), path.resolve(".tmp"));
  await rm(directory, { recursive: true, force: true });
});

const tools = [
  ...Array.from({ length: 19 }, (_, i) => ({
    name: `project_query_${i}`,
    label: `项目查询 ${i}`,
    description: `项目说明 ${i}`,
  })),
  {
    name: "project_list",
    label: "查看项目",
    description: "列出有权限的项目。",
  },
  {
    name: "node_generate",
    label: "开始生成",
    description: "保留完整的说明与适用条件。",
  },
  { name: "task_get", label: "查询任务", description: "独特搜索词：等待回执" },
  { name: "asset_info", label: "素材信息", description: "读取素材信息。" },
  {
    name: "edit_timeline_get",
    label: "查看时间线",
    description: "读取剪辑时间线。",
  },
  { name: "macro_run", label: "运行自动化", description: "运行保存的工作流。" },
  { name: "team_list", label: "团队列表", description: "查询团队。" },
  { name: "credit_balance_get", label: "积分余额", description: "查询余额。" },
  {
    name: "future_new_capability",
    label: "未来新增工具",
    description: "未分类的新能力仍可使用。",
  },
];
const button = (host, name) =>
  [...host.querySelectorAll("button")].find(
    (item) =>
      item.getAttribute("aria-label") === name ||
      item.textContent.trim() === name,
  );
const click = (item) =>
  act(async () => {
    assert.ok(item);
    item.click();
  });
async function search(host, value) {
  await act(async () => {
    const input = host.querySelector('[aria-label="搜索工具"]');
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
async function mount(
  t,
  {
    selected = ["asset_info"],
    status = "ready",
    kind = "waao",
    connectionSource = "web",
    catalog = tools,
    enabled = selected.length > 0,
    accessIssue,
    beforeMutation,
  } = {},
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host),
    calls = [];
  let server = {
    id: "fixture",
    name: "测试服务",
    kind,
    connectionSource,
    authMode: "auto",
    url: "https://example.com/mcp",
    selected:
      kind === "waao"
        ? enabled
          ? catalog.map((tool) => tool.name)
          : []
        : selected,
    enabled,
    authorization:
      status === "ready" ? { verified: true, accountLabel: "测试账号" } : null,
    accessIssue,
    tools: catalog,
    status,
    verification: { read: true },
    diagnostic: status === "offline" ? "连接暂时失败" : undefined,
  };
  const call = async (_, options = {}) => {
    if (options.body) {
      calls.push(options.body);
      await beforeMutation?.(options.body);
      if (options.body.action === "enable")
        server = {
          ...server,
          selected: [...new Set([...server.selected, ...options.body.tools])],
        };
      if (options.body.action === "select")
        server = { ...server, selected: options.body.tools };
      if (options.body.action === "service")
        server = {
          ...server,
          enabled: options.body.enabled,
          selected: options.body.enabled
            ? catalog.map((tool) => tool.name)
            : [],
        };
    }
    return { servers: [structuredClone(server)] };
  };
  const render = () =>
    act(async () =>
      root.render(
        React.createElement(Panel, {
          bindingId: "test-project",
          call,
          initialServer: "fixture",
          embedded: true,
        }),
      ),
    );
  await render();
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return {
    host,
    calls,
    selected: () => server.selected,
    enabled: () => server.enabled,
  };
}

test("delegated WAAO returned by an older runtime is absent from the service panel", async (t) => {
  const f = await mount(t, { connectionSource: "codex" });
  assert.equal(f.host.querySelectorAll(".qd-mcp-service").length, 0);
  assert.equal(f.host.querySelectorAll('input[type="checkbox"]').length, 0);
  assert.equal(button(f.host, "选用项目查询工具"), undefined);
  assert.deepEqual(f.calls, []);
});

test("WAAO read-only directory keeps every tool reachable and never changes the service preference", async (t) => {
  const f = await mount(t);
  const grouped = groupMcpTools(tools, "waao");
  assert.deepEqual(
    grouped.flatMap((group) => group.tools.map((tool) => tool.name)).sort(),
    tools.map((tool) => tool.name).sort(),
  );
  assert.equal(f.host.querySelectorAll('input[type="checkbox"]').length, 0);
  assert.equal(f.host.querySelector(".qd-waao-catalog").open, false);
  assert.equal(f.host.querySelector(".qd-mcp-connection").open, false);
  await click(button(f.host, "项目与画布"));
  const found = [];
  for (;;) {
    const items = [...f.host.querySelectorAll(".qd-mcp-choice strong")];
    assert.ok(items.length <= 8);
    found.push(...items.map((item) => item.textContent));
    const next = button(f.host, "下一页工具");
    if (!next || next.disabled) break;
    await click(next);
  }
  assert.deepEqual(
    found,
    tools
      .filter((item) => item.name.startsWith("project_"))
      .map((item) => item.label),
  );
  await click(button(f.host, "其他工具"));
  assert.equal(
    f.host.querySelector(".qd-mcp-choice strong").textContent,
    "未来新增工具",
  );
  assert.equal(
    button(f.host, "项目与画布").getAttribute("aria-expanded"),
    "false",
  );
  assert.deepEqual(f.calls, []);
  assert.equal(f.enabled(), true);
  assert.equal(f.host.querySelectorAll('input[type="checkbox"]').length, 0);
});

test("WAAO directory search and explanations never present per-tool grants", async (t) => {
  const f = await mount(t);
  await search(f.host, "等待回执");
  assert.deepEqual(
    [...f.host.querySelectorAll(".qd-mcp-choice strong")].map(
      (item) => item.textContent,
    ),
    ["查询任务"],
  );
  await search(f.host, "FUTURE_NEW_CAPABILITY");
  assert.equal(
    f.host.querySelector(".qd-mcp-choice strong").textContent,
    "未来新增工具",
  );
  await search(f.host, "不存在的内容");
  assert.match(f.host.textContent, /没有匹配的工具/);
  await search(f.host, "");
  await click(button(f.host, "生成与任务"));
  assert.equal(f.host.querySelector(".qd-mcp-tool-description"), null);
  await click(button(f.host, "查看工具说明：开始生成"));
  assert.match(
    f.host.querySelector(".qd-mcp-tool-description").textContent,
    /node_generate.*保留完整/s,
  );
  assert.deepEqual(f.calls, []);
  assert.equal(button(f.host, "已启用"), undefined);
  assert.equal(button(f.host, "选用项目查询工具"), undefined);
  assert.equal(button(f.host, "全选当前服务工具"), undefined);
  assert.equal(f.host.querySelectorAll('input[type="checkbox"]').length, 0);
});

test("WAAO has exactly one project switch and shows the verified account separately", async (t) => {
  const f = await mount(t, { enabled: false });
  assert.match(f.host.textContent, /WAAO 服务端已确认授权 · 测试账号/);
  assert.equal(f.host.querySelectorAll('[role="switch"]').length, 1);
  assert.equal(button(f.host, "在此项目停用"), undefined);
  const toggle = () => button(f.host, "在当前项目使用 WAAO");
  assert.equal(toggle().getAttribute("aria-checked"), "false");
  await click(toggle());
  assert.equal(toggle().getAttribute("aria-checked"), "true");
  assert.deepEqual(
    f.selected(),
    tools.map((tool) => tool.name),
  );
  assert.deepEqual(f.calls[0], {
    action: "service",
    id: "fixture",
    enabled: true,
  });
  await click(toggle());
  assert.equal(f.enabled(), false);
  assert.deepEqual(f.selected(), []);
  assert.deepEqual(f.calls[1], {
    action: "service",
    id: "fixture",
    enabled: false,
  });
});

test("WAAO connection failures require login before enabling but still allow turning off", async (t) => {
  const f = await mount(t, { status: "offline", enabled: false });
  assert.equal(f.host.querySelector(".qd-mcp-connection").open, true);
  assert.match(f.host.textContent, /连接暂时失败/);
  assert.ok(button(f.host, "连接 WAAO"));
  await click(button(f.host, "生成与任务"));
  assert.equal(button(f.host, "在当前项目使用 WAAO").disabled, true);
  await click(button(f.host, "查看工具说明：开始生成"));
  assert.ok(f.host.querySelector(".qd-mcp-tool-description"));
  assert.deepEqual(f.calls, []);
  const g = await mount(t, { status: "authorization", enabled: true });
  assert.equal(button(g.host, "在当前项目使用 WAAO").disabled, false);
  await click(button(g.host, "在当前项目使用 WAAO"));
  assert.equal(g.enabled(), false);
  assert.equal(button(g.host, "在当前项目使用 WAAO").disabled, true);
});

test("WAAO permission failures show the provider reason and handling link without replacing the account status", async (t) => {
  const f = await mount(t, {
    accessIssue: {
      message: "此应用无权生成，请联系组织管理员。",
      requiredScopes: ["generate"],
      actionLabel: "在 WAAO 查看权限与资源范围",
      actionUrl: "https://www.waao.studio/projects",
    },
  });
  const issue = f.host.querySelector(".qd-waao-access-issue");
  assert.match(issue.textContent, /此应用无权生成，请联系组织管理员/);
  assert.match(issue.textContent, /generate/);
  assert.equal(
    issue.querySelector("a").href,
    "https://www.waao.studio/projects",
  );
  assert.equal(button(f.host, "连接 WAAO"), undefined);
  assert.equal(
    button(f.host, "在当前项目使用 WAAO").getAttribute("aria-checked"),
    "true",
  );
});

test("small Codex catalogs stay directly accessible and generic large catalogs are paged", async (t) => {
  const f = await mount(t, {
    kind: "codex",
    selected: [],
    catalog: [
      { name: "codex", label: "新建对话" },
      { name: "codex-reply", label: "继续对话" },
    ],
  });
  assert.equal(f.host.querySelectorAll('input[type="checkbox"]').length, 2);
  await click(button(f.host, "启用 Codex 对话工具"));
  assert.deepEqual(f.selected(), ["codex", "codex-reply"]);
  const g = await mount(t, { kind: null, selected: [] });
  await click(button(g.host, "服务工具"));
  assert.equal(g.host.querySelectorAll('input[type="checkbox"]').length, 8);
});

test("generic MCP search and enabled filter retain individual tool selection", async (t) => {
  const f = await mount(t, { kind: null });
  await search(f.host, "等待回执");
  await click(f.host.querySelector('input[value="task_get"]'));
  assert.deepEqual(f.selected(), ["asset_info", "task_get"]);
  await search(f.host, "");
  await click(button(f.host, "已启用"));
  await click(button(f.host, "服务工具"));
  await click(f.host.querySelector('input[value="asset_info"]'));
  assert.deepEqual(f.selected(), ["task_get"]);
});

test("WAAO toggle waits for persistence and does not claim enabled when saving fails", async (t) => {
  let rejectSave;
  const pending = new Promise((_, reject) => {
    rejectSave = reject;
  });
  const f = await mount(t, { enabled: false, beforeMutation: () => pending });
  const toggle = () => button(f.host, "在当前项目使用 WAAO");
  await click(toggle());
  assert.equal(toggle().disabled, true);
  await click(toggle());
  assert.equal(f.calls.length, 1);
  await act(async () => rejectSave(Error("保存失败，请重试")));
  assert.equal(toggle().getAttribute("aria-checked"), "false");
  assert.equal(toggle().disabled, false);
  assert.match(f.host.querySelector('[role="alert"]').textContent, /保存失败/);
});

test("select all includes collapsed categories and all pages even while searching", async (t) => {
  const f = await mount(t, { kind: null });
  await click(button(f.host, "服务工具"));
  await click(button(f.host, "下一页工具"));
  await search(f.host, "等待回执");
  assert.equal(f.host.querySelectorAll('input[type="checkbox"]').length, 1);
  await click(button(f.host, "全选当前服务工具"));
  assert.deepEqual(
    [...f.selected()].sort(),
    tools.map((tool) => tool.name).sort(),
  );
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], {
    action: "enable",
    id: "fixture",
    tools: tools.map((tool) => tool.name),
  });
  assert.equal(button(f.host, "全选当前服务工具").disabled, true);
  assert.equal(f.host.querySelector('input[value="task_get"]').checked, true);
  await click(button(f.host, "取消全选当前服务工具"));
  assert.deepEqual(f.selected(), []);
  assert.deepEqual(f.calls[1], { action: "select", id: "fixture", tools: [] });
  assert.equal(button(f.host, "取消全选当前服务工具").disabled, true);
  assert.equal(f.host.querySelector('input[value="task_get"]').checked, false);
});

test("bulk selection coalesces repeated clicks while saving and preserves choices on failure", async (t) => {
  let rejectSave;
  const pending = new Promise((_, reject) => {
    rejectSave = reject;
  });
  const f = await mount(t, { kind: null, beforeMutation: () => pending });
  await click(button(f.host, "全选当前服务工具"));
  assert.equal(button(f.host, "全选当前服务工具").disabled, true);
  assert.equal(button(f.host, "取消全选当前服务工具").disabled, true);
  await click(button(f.host, "全选当前服务工具"));
  assert.equal(f.calls.length, 1);
  await act(async () => rejectSave(Error("保存失败，请重试")));
  assert.deepEqual(f.selected(), ["asset_info"]);
  assert.match(f.host.querySelector('[role="alert"]').textContent, /保存失败/);
  assert.equal(button(f.host, "全选当前服务工具").disabled, false);
  assert.equal(button(f.host, "取消全选当前服务工具").disabled, false);
});

test("unavailable services disable both bulk actions without changing selections", async (t) => {
  const f = await mount(t, { kind: null, status: "offline" });
  await click(button(f.host, "全选当前服务工具"));
  await click(button(f.host, "取消全选当前服务工具"));
  assert.equal(button(f.host, "全选当前服务工具").disabled, true);
  assert.equal(button(f.host, "取消全选当前服务工具").disabled, true);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.selected(), ["asset_info"]);
});
