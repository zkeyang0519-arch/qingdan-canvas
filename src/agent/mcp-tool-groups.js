const waaoGroups = [
  { id: "projects", label: "项目与画布", match: /^(project|canvas|snapshot)_/ },
  {
    id: "generation",
    label: "生成与任务",
    match:
      /^(node_generat|node_process_quote|generation_|task_|service_|event_)/,
  },
  {
    id: "assets",
    label: "素材与节点",
    match: /^(asset_|node_|image_|import_|voice_|prompt_)/,
  },
  { id: "editing", label: "剪辑与导出", match: /^edit_/ },
  {
    id: "automation",
    label: "批量与自动化",
    match: /^(macro_|workflow_|batch_)/,
  },
  {
    id: "collaboration",
    label: "协作与分享",
    match:
      /^(share_|collaborator_|invitation_|member_|team_|organization_|transfer_|suggestion_)/,
  },
  {
    id: "account",
    label: "账号与用量",
    match:
      /^(account_|approval_|handle_|namespace_|user_|credit_|cost_|budget_|notification_)/,
  },
];

export function groupMcpTools(tools, kind) {
  if (kind !== "waao")
    return tools.length ? [{ id: "tools", label: "服务工具", tools }] : [];
  const groups = [...waaoGroups, { id: "other", label: "其他工具" }].map(
    (group) => ({ ...group, tools: [] }),
  );
  for (const tool of tools) {
    const group =
      groups.find((item) => item.match?.test(tool.name)) || groups.at(-1);
    group.tools.push(tool);
  }
  return groups.filter((group) => group.tools.length);
}
