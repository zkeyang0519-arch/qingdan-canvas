// User-facing activity names. Tool identifiers remain in receipts for diagnostics.
export function activityTitle(name, args = {}) {
  const tool = String(name).replace(/^mcp__[^_]+__/, "");
  if (tool === "codex" || tool === "codex_reply" || tool === "codex-reply")
    return args.action === "images" ? "生成参考图片" : "生成与整理稿件";
  if (name === "waao")
    return args.action === "submit"
      ? "提交生成任务"
      : args.action === "status"
        ? "查看生成结果"
        : "查找项目与可用资源";
  if (/account|credit|organization|invitation/.test(tool))
    return "核对账号与可用预算";
  if (/project.*list|canvas_list|targets/.test(tool)) return "查找项目与画布";
  if (/service|model.*list/.test(tool)) return "选择生成服务";
  if (/canvas_apply_changes/.test(tool))
    return args.changes?.some((c) => c.op === "create")
      ? "创建本次任务的节点"
      : "更新画布内容";
  if (/node.*create/.test(tool)) return "创建本次任务的节点";
  if (/node_generate$/.test(tool)) return "提交图片或视频生成";
  if (/task_get|generation_status|status/.test(tool)) return "查看生成结果";
  if (/canvas_load|elements_get|node_get/.test(tool))
    return "读取画布与节点内容";
  if (/asset.*preview|asset.*info/.test(tool)) return "检查生成的素材";
  if (/search_context|read_context/.test(tool)) return "查阅已有资料";
  if (/find_capabilities|request_capability/.test(tool))
    return "查找并加载所需工具";
  if (/search|query|read|get|list/.test(tool)) return "查询项目资料";
  if (/write|revise|draft/.test(tool)) return "生成与保存成果";
  return "执行项目操作";
}

export const activityStatus = {
  pending: "待处理",
  running: "进行中",
  waiting: "等待中",
  done: "已完成",
  failed: "未完成",
  cancelled: "已停止",
};

export function activityLine(value) {
  return String(value || "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/Bearer\s+[^\s",]+|sk-[A-Za-z0-9_-]{12,}/gi, "[凭据已隐藏]")
    .replace(
      /(--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|token)(?:\s*=\s*|\s+)["']?)[^\s"',&}]+/gi,
      "$1[已隐藏]",
    )
    .replace(
      /((?:access_token|refresh_token|api_key|password|authorization)["']?\s*[=:]\s*["']?)[^\s"',&}]+/gi,
      "$1[已隐藏]",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

export function activityCommand(name, args = {}) {
  const match = name.match(/^mcp__([^_]+)__(.+)$/);
  return activityLine(
    match
      ? `${match[1].toUpperCase()} · ${match[2]}`
      : `${name}${args.action ? " · " + args.action : ""}`,
  );
}

// Only operational notifications become activity lines. Reasoning and model
// messages are never interpreted as commands or tool progress.
export function nativeActivityLine({ method, params }) {
  const item = params?.item;
  if (!["item/started", "item/completed"].includes(method) || !item) return "";
  const prefix = method === "item/started" ? "正在" : "已结束：";
  if (item.type === "commandExecution")
    return activityLine(prefix + "运行 " + (item.command || "命令"));
  if (item.type === "fileChange")
    return activityLine(
      prefix + "修改文件 " + (item.changes || []).map((c) => c.path).join("、"),
    );
  if (item.type === "mcpToolCall")
    return activityLine(
      prefix + "调用 " + [item.server, item.tool].filter(Boolean).join(" · "),
    );
  if (item.type === "imageGeneration") return prefix + "生成图片";
  if (item.type === "webSearch") return prefix + "检索资料";
  return "";
}
