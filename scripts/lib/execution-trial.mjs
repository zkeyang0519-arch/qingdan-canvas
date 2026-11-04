import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, realpath, lstat, writeFile } from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);
const fail = (message) => Object.assign(Error(message), { status: 409 });
const ownerKey = (ownerId) =>
  createHash("sha256").update(ownerId).digest("hex").slice(0, 24);
const projectSection = (workspaceId) =>
  `agent-execution-project-${workspaceId}`;

export function validateProjectName(value) {
  const invalid = () =>
    Object.assign(
      Error(
        "项目名称需为 1–60 个字符，不能以点开头或结尾，也不能包含路径符号或 Windows 保留名称。",
      ),
      { status: 400 },
    );
  if (typeof value !== "string") throw invalid();
  const name = value.trim().normalize("NFC");
  if (
    !name ||
    name.length > 60 ||
    name.startsWith(".") ||
    name.endsWith(".") ||
    /[<>:"/\\|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(name) ||
    /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)$/iu.test(
      name.split(".")[0].trimEnd(),
    )
  )
    throw invalid();
  return name;
}
const pathKey = (value) =>
  process.platform === "win32"
    ? path.resolve(value).toLowerCase()
    : path.resolve(value);
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};

export async function listExecutionProjects({
  projectRoot,
  ownerId,
  workspaces = [],
}) {
  const root = await realpath(projectRoot);
  const parent = path.join(
    root,
    ".tmp",
    "execution-projects",
    ownerKey(ownerId),
  );
  return workspaces
    .flatMap((workspace) => {
      if (
        typeof workspace.displayPath !== "string" ||
        typeof workspace.workspaceId !== "string"
      )
        return [];
      if (pathKey(path.dirname(workspace.displayPath)) !== pathKey(parent))
        return [];
      try {
        validateProjectName(path.basename(workspace.displayPath));
      } catch {
        return [];
      }
      return [
        {
          workspaceId: workspace.workspaceId,
          name: workspace.name || path.basename(workspace.displayPath),
          sectionId: projectSection(workspace.workspaceId),
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

// The destination is selected by this helper, never by the browser or model.
// Reusing the trial retains files and history so the user can inspect results.
export async function prepareExecutionTrial({
  projectRoot,
  controller,
  ownerId,
  projectName,
}) {
  const state = await controller.status(ownerId);
  if (!state.paired) throw fail("请先在第 3 步绑定这台电脑。");
  if (state.connectionStatus !== "online")
    throw fail("请等电脑在线后再准备测试项目。");
  const name =
    projectName === undefined ? null : validateProjectName(projectName);
  const root = await realpath(projectRoot);
  let directory = root;
  for (const component of [
    ".tmp",
    name === null ? "execution-trial" : "execution-projects",
    ownerKey(ownerId),
    ...(name === null ? [] : [name]),
  ]) {
    const candidate = path.join(directory, component);
    try {
      await mkdir(candidate);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if ((await lstat(candidate)).isSymbolicLink())
      throw fail("测试目录已被重定向，请先检查本机目录。");
    directory = await realpath(candidate);
    if (!inside(root, directory))
      throw fail("测试目录已被重定向，请先检查本机目录。");
  }
  const gitPath = path.join(directory, ".git");
  const gitStat = await lstat(gitPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (gitStat && (!gitStat.isDirectory() || gitStat.isSymbolicLink()))
    throw fail("测试项目的 Git 目录无效。");
  const gitEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith("GIT_"),
    ),
  );
  gitEnv.GIT_CONFIG_NOSYSTEM = "1";
  gitEnv.GIT_CONFIG_GLOBAL = "/dev/null";
  const git = async (...args) =>
    run(
      "git",
      [
        `--git-dir=${gitPath}`,
        `--work-tree=${directory}`,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: directory, env: gitEnv, windowsHide: true, timeout: 15000 },
    );
  const verifyGit = async () => {
    const { stdout } = await git(
      "rev-parse",
      "--show-toplevel",
      "--absolute-git-dir",
      "--git-common-dir",
      "--is-inside-work-tree",
    );
    const [top, metadata, common, insideWorktree] = stdout
      .trim()
      .split(/\r?\n/);
    if (
      !top ||
      !metadata ||
      !common ||
      insideWorktree !== "true" ||
      pathKey(await realpath(top)) !== pathKey(directory) ||
      pathKey(await realpath(metadata)) !== pathKey(gitPath) ||
      pathKey(await realpath(common)) !== pathKey(gitPath)
    )
      throw fail("测试项目的 Git 目录不匹配，请检查本机目录。");
  };
  if (!gitStat) {
    await writeFile(
      path.join(directory, "README.md"),
      "# 轻单 MCP 独立测试项目\n\n本目录用于验证提交任务、补充说明与停止执行。\n测试内容只在本目录内修改。\n",
      { flag: "wx" },
    ).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    await git("init", "--quiet", "--template=");
    await verifyGit();
    await git("add", "--", "README.md");
    await git(
      "-c",
      "user.name=Qingdan Trial",
      "-c",
      "user.email=trial@localhost",
      "commit",
      "--quiet",
      "-m",
      "Initialize isolated dispatch trial",
    );
  }
  await verifyGit();
  const registered = await controller.registerWorkspace(ownerId, {
    root: directory,
    name: name ?? "MCP 派单测试项目",
  });
  const workspace = registered.workspaces.find(
    (item) => pathKey(item.displayPath) === pathKey(directory),
  );
  if (!workspace) throw fail("测试项目尚未完成登记，请重试。");
  const context = await controller.executionContext(
    ownerId,
    workspace.workspaceId,
  );
  return {
    runnerId: registered.runnerId,
    workspace,
    context,
    sectionId:
      name === null
        ? "agent-execution-trial"
        : projectSection(workspace.workspaceId),
  };
}
