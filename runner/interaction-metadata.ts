import path from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import type {
  ApprovalDetails,
  InputQuestion,
} from "../shared/agent/permissions";
import { inputQuestionSchema } from "../shared/agent/permissions";
import type { RunRecord } from "./types";
import { RunnerError } from "./errors";

/** Only display metadata travels to the cloud; no raw RPC params or patch text. */
export function safeInteractionText(value: string) {
  return value
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(
      /((?:--?)(?:api[-_]?key|access[-_]?token|token|password|secret|authorization)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:api[-_]?key|access[-_]?token|token|password|secret|authorization|private[-_]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");
}
export type NativeItemMetadata = {
  command?: string;
  cwd?: string;
  files?: string[];
};
export function approvalMetadata(
  run: RunRecord,
  method: ApprovalDetails["method"],
  params: Record<string, any>,
  item?: NativeItemMetadata,
): { description: string; details: ApprovalDetails } {
  const command =
    typeof params.command === "string" ? params.command : item?.command;
  const cwd = typeof params.cwd === "string" ? params.cwd : item?.cwd;
  const files =
    method === "item/fileChange/requestApproval" ? item?.files : undefined;
  const inside = (p: string) => {
    const root = path.resolve(run.root),
      target = path.resolve(root, p),
      rel = path.relative(root, target);
    if (
      rel.startsWith(`..${path.sep}`) ||
      rel === ".." ||
      path.isAbsolute(rel) ||
      /\0/.test(p)
    )
      return false;
    const key = (s: string) =>
      process.platform === "win32" ? s.toLowerCase() : s;
    try {
      let current = root;
      for (const part of ["", ...rel.split(path.sep).filter(Boolean)]) {
        current = path.join(current, part);
        let info;
        try {
          info = lstatSync(current);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
          throw error;
        }
        if (
          info.isSymbolicLink() ||
          key(realpathSync(current)) !== key(current)
        )
          return false;
      }
      return true;
    } catch {
      return false;
    }
  };
  let refusal = "";
  if (
    run.snapshot.kind === "summary" ||
    run.snapshot.executionPermissions?.profile === "read_only"
  )
    refusal = "当前为只读权限，不能通过审批扩大执行范围。";
  else if (
    method === "item/commandExecution/requestApproval" &&
    params.kind != null &&
    params.kind !== "command"
  )
    refusal = "此请求向已有终端发送输入，无法用父命令替代当前操作审批。";
  else if (
    params.grantRoot ||
    params.networkApprovalContext ||
    params.additionalPermissions?.network?.enabled ||
    params.additionalPermissions?.fileSystem ||
    params.proposedExecpolicyAmendment ||
    params.proposedNetworkPolicyAmendments?.length
  )
    refusal =
      "此请求包含会话、网络或额外文件权限；轻单仅支持可明确展示范围的单次审批。";
  else if (
    (command && command.length > 8000) ||
    (cwd && (cwd.length > 2000 || !inside(cwd))) ||
    (files &&
      (files.length > 30 || files.some((p) => p.length > 512 || !inside(p))))
  )
    refusal = "请求范围超出当前项目或无法完整展示，不能批准。";
  else if (
    (method === "item/commandExecution/requestApproval" &&
      (!command || !cwd)) ||
    (method === "item/fileChange/requestApproval" && !files?.length)
  )
    refusal = "未取得完整的原生命令、工作目录或文件范围，不能批准。";
  else if (
    method === "item/commandExecution/requestApproval" &&
    (!Array.isArray(params.availableDecisions) ||
      !params.availableDecisions.includes("accept"))
  )
    refusal = "Codex 未提供仅批准本次的决定。";
  const allowedDecisions: NonNullable<ApprovalDetails["allowedDecisions"]> =
    refusal ? ["decline", "cancel"] : ["accept", "decline", "cancel"];
  const metadata = {
    description: (
      refusal ||
      (method === "item/commandExecution/requestApproval"
        ? "该命令申请本次额外执行权限，批准后可能超出项目目录或默认网络限制；仅批准此命令，不修改后续权限。\n"
        : "仅批准以下文件的本次修改，不授予会话级权限。\n") +
        safeInteractionText(
          typeof params.reason === "string"
            ? params.reason
            : "Codex 请求执行审批。",
        )
    ).slice(0, 2000),
    details: {
      method,
      allowedDecisions,
      ...(command
        ? { command: safeInteractionText(command).slice(0, 8000) }
        : {}),
      ...(cwd ? { cwd: safeInteractionText(cwd).slice(0, 2000) } : {}),
      ...(files
        ? {
            files: files
              .slice(0, 30)
              .map((p) => safeInteractionText(p).slice(0, 512)),
          }
        : {}),
    },
  };
  if (Buffer.byteLength(JSON.stringify(metadata)) > 24_000)
    return {
      description:
        "审批详情过长，无法完整展示；请拒绝或取消后让 Codex 拆分操作。",
      details: { method, allowedDecisions: ["decline", "cancel"] },
    };
  return metadata;
}
export function inputMetadata(raw: unknown): InputQuestion[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 20)
    throw new RunnerError("VALIDATION_ERROR", "问题数量超出支持范围。");
  const questions = raw.map((q) => {
    if (
      q.options &&
      (!Array.isArray(q.options) ||
        q.options.some(
          (o: any) =>
            typeof o.label !== "string" ||
            safeInteractionText(o.label) !== o.label,
        ) ||
        new Set(q.options.map((o: any) => o.label)).size !== q.options.length)
    )
      throw new RunnerError(
        "VALIDATION_ERROR",
        "问题选项包含不能安全展示的标识，请重新提问。",
      );
    return inputQuestionSchema.parse({
      id: q.id,
      prompt: safeInteractionText(q.question),
      ...(q.options
        ? {
            options: q.options.map((o: any) => ({
              label: o.label,
              description: safeInteractionText(o.description ?? ""),
            })),
          }
        : {}),
      ...(typeof q.isOther === "boolean" ? { isOther: q.isOther } : {}),
      ...(typeof q.isSecret === "boolean" ? { isSecret: q.isSecret } : {}),
    });
  });
  if (
    new Set(questions.map((q) => q.id)).size !== questions.length ||
    Buffer.byteLength(JSON.stringify(questions)) > 24_000
  )
    throw new RunnerError(
      "VALIDATION_ERROR",
      "问题内容过长或标识重复，请拆分后提问。",
    );
  return questions;
}
