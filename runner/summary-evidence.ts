import { lstat, opendir, realpath, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { RunnerError } from "./errors";
import type { NativeSummaryContext } from "../shared/agent/execution";
import type { ProjectSummary } from "../shared/agent/contracts";
import { summarySourceItems } from "../shared/agent/progress";

export interface SummaryEvidence {
  capturedAt: string;
  cwd: string;
  gitBaseline: NativeSummaryContext["gitBaseline"];
  inventory: string[];
  files: { path: string; sha256: string; content: string; redacted: boolean }[];
  omitted: { path: string; reason: string }[];
}
export function validateSummaryReferences(
  summary: ProjectSummary,
  evidence: SummaryEvidence,
) {
  const sources = new Set([
    "native:git",
    "native:inventory",
    ...evidence.files.map((file) => file.path),
  ]);
    for (const item of summarySourceItems(summary))
      if (item.evidenceRef && !sources.has(item.evidenceRef))
        throw new RunnerError(
          "INVALID_SUMMARY_EVIDENCE",
          "总结引用了本轮资料包未提供的文件或来源。",
        );
  return summary;
}
const excludedDirs = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  "target",
  "venv",
  "__pycache__",
]);
const sensitive =
  /(?:secret|credential|password|private[-_.]?key|api[-_.]?key)|(?:^|[-_.])(?:tokens?|env)(?:[-_.]|$)/i;
const sourceExtensions = new Set([
  ".md",
  ".txt",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".cs",
  ".css",
  ".html",
  ".vue",
  ".svelte",
]);
const manifests = new Set([
  "package.json",
  "cargo.toml",
  "pyproject.toml",
  "go.mod",
  "requirements.txt",
]);
const key = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
const inside = (root: string, target: string) => {
  const relative = path.relative(key(root), key(target));
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};
const sameFile = (
  a: { dev: number; ino: number },
  b: { dev: number; ino: number },
) => a.dev === b.dev && a.ino === b.ino;

/** Native, bounded project data. No command execution and no caller-chosen file paths. */
export async function readSummaryEvidence(
  root: string,
  gitBaseline: NativeSummaryContext["gitBaseline"],
): Promise<SummaryEvidence> {
  const initial = await lstat(root),
    resolved = await realpath(root);
  if (
    !initial.isDirectory() ||
    initial.isSymbolicLink() ||
    key(path.resolve(root)) !== key(resolved)
  )
    throw new RunnerError(
      "WORKSPACE_CHANGED",
      "项目目录不是稳定的已授权真实目录。",
    );
  const evidence: SummaryEvidence = {
    capturedAt: new Date().toISOString(),
    cwd: resolved,
    gitBaseline,
    inventory: [],
    files: [],
    omitted: [],
  };
  const rootStable = async () => {
    const now = await lstat(root);
    if (
      now.isSymbolicLink() ||
      !sameFile(initial, now) ||
      key(await realpath(root)) !== key(resolved)
    )
      throw new RunnerError(
        "WORKSPACE_CHANGED",
        "读取资料期间项目目录发生变化。",
      );
  };
  const omit = (relative: string, reason: string) => {
    const item = {
      path: relative.length <= 256 ? relative : "<路径过长>",
      reason,
    };
    if (
      evidence.omitted.length < 64 &&
      Buffer.byteLength(JSON.stringify([...evidence.omitted, item])) <= 8192 &&
      Buffer.byteLength(
        JSON.stringify({ ...evidence, omitted: [...evidence.omitted, item] }),
      ) <= 49152
    )
      evidence.omitted.push(item);
  };
  const inventory = (relative: string) => {
    if (
      evidence.inventory.length < 200 &&
      Buffer.byteLength(JSON.stringify([...evidence.inventory, relative])) <=
        16384
    )
      evidence.inventory.push(relative);
  };
  const queue = [{ dir: resolved, depth: 0 }],
    candidates: { absolute: string; relative: string; priority: number }[] = [];
  let scanned = 0;
  while (queue.length && scanned < 400) {
    const { dir, depth } = queue.shift()!;
    const ds = await lstat(dir);
    if (ds.isSymbolicLink() || !inside(resolved, await realpath(dir))) continue;
    const entries = await opendir(dir);
    for await (const entry of entries) {
      if (++scanned > 400) {
        omit(".", "目录项超过400项，仅提供有限清单");
        break;
      }
      const absolute = path.join(dir, entry.name),
        relative = path.relative(resolved, absolute).split(path.sep).join("/");
      if (relative.length > 256) {
        omit(relative, "相对路径过长");
        continue;
      }
      if (entry.name.startsWith(".") || sensitive.test(entry.name)) {
        omit(relative, "隐藏或凭据相关名称");
        continue;
      }
      const stat = await lstat(absolute).catch(() => null);
      if (!stat || stat.isSymbolicLink()) {
        omit(relative, "链接或不可读取项");
        continue;
      }
      if (!inside(resolved, await realpath(absolute))) {
        omit(relative, "超出项目目录");
        continue;
      }
      if (stat.isDirectory()) {
        if (excludedDirs.has(entry.name.toLowerCase())) {
          omit(relative, "依赖或构建目录");
          continue;
        }
        inventory(relative + "/");
        if (depth < 2) queue.push({ dir: absolute, depth: depth + 1 });
        else omit(relative, "达到目录深度上限");
        continue;
      }
      if (!stat.isFile() || stat.nlink > 1) {
        omit(relative, "不是普通独立文件");
        continue;
      }
      inventory(relative);
      const name = entry.name.toLowerCase();
      if (!sourceExtensions.has(path.extname(name)) && !manifests.has(name))
        continue;
      const priority =
        depth * 10 +
        (/^(?:readme|agents)(?:\.|$)/i.test(name)
          ? 0
          : manifests.has(name)
            ? 1
            : /^(?:status|spec|todo|plan)(?:\.|$)/i.test(name)
              ? 2
              : 5);
      candidates.push({ absolute, relative, priority });
    }
  }
  candidates.sort(
    (a, b) => a.priority - b.priority || a.relative.localeCompare(b.relative),
  );
  let total = 0;
  for (const file of candidates) {
    if (evidence.files.length >= 16) {
      omit(file.relative, "达到16个文件上限");
      continue;
    }
    await rootStable();
    const before = await lstat(file.absolute).catch(() => null);
    if (
      !before ||
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink > 1 ||
      !inside(resolved, await realpath(file.absolute))
    ) {
      omit(file.relative, "文件路径变化");
      continue;
    }
    if (before.size > 8192 || total + before.size > 32768) {
      omit(file.relative, "文件或总字节数超过上限，未截取内容");
      continue;
    }
    const handle = await open(file.absolute, "r");
    try {
      const opened = await handle.stat();
      if (!sameFile(before, opened) || opened.nlink > 1 || !opened.isFile()) {
        omit(file.relative, "文件读取身份变化");
        continue;
      }
      const buffer = Buffer.alloc(8193),
        { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const after = await handle.stat();
      if (
        bytesRead > 8192 ||
        bytesRead !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        !sameFile(after, await lstat(file.absolute)) ||
        !inside(resolved, await realpath(file.absolute))
      ) {
        omit(file.relative, "文件在读取中变化或超过上限");
        continue;
      }
      await rootStable();
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.includes(0)) {
        omit(file.relative, "二进制内容");
        continue;
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        omit(file.relative, "不是UTF-8文本");
        continue;
      }
      if (/-----BEGIN .*PRIVATE KEY-----/.test(content)) {
        omit(file.relative, "私钥内容");
        continue;
      }
      const safe = content
        .split("\n")
        .map((line) =>
          /(?:api[_-]?key|(?:access|refresh)[_-]?token|token|private[_-]?key|password|secret|authorization)\s*["']?\s*[:=]|\bbearer\s+[A-Za-z0-9._~+/-]{12,}|\bsk-[A-Za-z0-9_-]{16,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(
            line,
          )
            ? "[凭据相关行已省略]"
            : line,
        )
        .join("\n");
      const record = {
        path: file.relative,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        content: safe,
        redacted: safe !== content,
      };
      if (
        Buffer.byteLength(
          JSON.stringify({ ...evidence, files: [...evidence.files, record] }),
        ) > 49152
      ) {
        omit(file.relative, "达到资料包大小上限");
        continue;
      }
      evidence.files.push(record);
      total += bytesRead;
    } finally {
      await handle.close();
    }
  }
  await rootStable();
  return evidence;
}
