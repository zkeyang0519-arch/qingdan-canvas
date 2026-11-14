import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_EXECUTION_PERMISSION } from "../../shared/agent/permissions";

export const permissionProfiles = [
  {
    value: "full_access",
    label: "完全访问",
    description: "可读写本机文件、访问网络，执行操作无需逐次审批。",
  },
  {
    value: "read_only",
    label: "只读",
    description: "查看项目和整理结果，不修改文件。",
  },
  {
    value: "workspace_manual",
    label: "项目内编辑 · 按需人工批准",
    description: "可修改关联项目；Codex 需要审批时，在轻单询问你。",
  },
  {
    value: "workspace_auto",
    label: "项目内编辑 · 自动安全审查",
    description:
      "可修改关联项目；由自动安全审查判断审批请求，未通过时暂停处理。",
  },
];
export const permissionLabel = (profile) =>
  permissionProfiles.find((p) => p.value === profile)?.label ||
  "旧批次：权限未记录";
function readPreference(key) {
  try {
    const value = localStorage.getItem(key);
    return permissionProfiles.some((p) => p.value === value)
      ? value
      : DEFAULT_EXECUTION_PERMISSION;
  } catch {
    return DEFAULT_EXECUTION_PERMISSION;
  }
}
export function usePermissionPreference(userId, binding) {
  const key = `qingdan.execution-permissions:v2:${JSON.stringify([userId, binding.bindingId, binding.revision])}`;
  const [state, setState] = useState(() => ({
    key,
    value: readPreference(key),
  }));
  useEffect(() => setState({ key, value: readPreference(key) }), [key]);
  useEffect(() => {
    function sync(event) {
      const changedKey = event.detail?.key ?? event.key;
      if (changedKey !== key && changedKey !== null) return;
      const next = event.detail?.value ?? readPreference(key);
      if (permissionProfiles.some((profile) => profile.value === next))
        setState({ key, value: next });
    }
    window.addEventListener("qingdan:execution-permission", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("qingdan:execution-permission", sync);
      window.removeEventListener("storage", sync);
    };
  }, [key]);
  const value = state.key === key ? state.value : readPreference(key);
  return [
    value,
    (next) => {
      if (!permissionProfiles.some((p) => p.value === next)) return;
      setState({ key, value: next });
      try {
        localStorage.setItem(key, next);
      } catch {
        /* Selection still applies to this submission. */
      }
      window.dispatchEvent(new window.CustomEvent("qingdan:execution-permission", { detail: { key, value: next } }));
    },
  ];
}

export function PermissionButton({ value, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="agent-permissions">
      <button
        aria-label="设置执行权限"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        权限：{permissionLabel(value)}
      </button>
      {open && (
        <fieldset className="agent-permission-options">
          <legend>新批次的执行权限</legend>
          {permissionProfiles.map((profile) => (
            <label key={profile.value}>
              <input
                type="radio"
                name="execution-permissions"
                aria-label={profile.label}
                value={profile.value}
                checked={value === profile.value}
                disabled={disabled}
                onChange={() => onChange(profile.value)}
              />
              <span>
                <strong>{profile.label}</strong>
                <small>{profile.description}</small>
              </span>
            </label>
          ))}
          <p className="agent-note">
            默认完全访问，允许读写文件和联网，无需逐次审批；其他档位默认关闭网络。所选权限用于下一次提交，已提交的批次保留原权限。项目摘要保持只读。
          </p>
          <button disabled={disabled} onClick={() => setOpen(false)}>
            完成权限设置
          </button>
        </fieldset>
      )}
    </div>
  );
}

export function currentNativeRequests(run) {
  if (
    !run ||
    run.terminal ||
    !run.turnId ||
    !run.threadId ||
    ["cancel_requested", "cancelled", "completed"].includes(run.queue?.phase) ||
    ["cancel_requested", "cancelled"].includes(run.status)
  )
    return [];
  return (run.pendingRequests || []).filter(
    (request) =>
      request.runId === run.runId &&
      request.threadId === run.threadId &&
      request.turnId === run.turnId &&
      ["approval", "input"].includes(request.kind) &&
      ["pending", "queued"].includes(request.responseStatus),
  );
}

// The current native request is authoritative. Historical output never opens a prompt.
export function NativeRequestPrompt({
  request,
  busy,
  delivered,
  receiptStatus,
  error,
  onRespond,
}) {
  const [open, setOpen] = useState(true);
  const [answers, setAnswers] = useState({});
  const [attempt, setAttempt] = useState(null);
  const dialog = useRef(null);
  const queued = delivered || request.responseStatus === "queued";
  const title =
    request.kind === "approval" ? "Codex 请求审批" : "Codex 需要你的回答";
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    dialog.current?.focus();
    const key = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setOpen(false);
      } else if (event.key === "Tab") {
        const items = [
          ...dialog.current.querySelectorAll(
            "button:not(:disabled),input:not(:disabled),textarea:not(:disabled)",
          ),
        ];
        const first = items[0],
          last = items.at(-1);
        if (
          !items.includes(document.activeElement) ||
          (!event.shiftKey && document.activeElement === last)
        ) {
          event.preventDefault();
          first?.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        }
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      if (previous?.isConnected) previous.focus?.();
    };
  }, [open]);
  function respond(response) {
    if (busy || queued) return;
    if (
      response.decision &&
      !(request.details?.allowedDecisions ?? ["decline", "cancel"]).includes(
        response.decision,
      )
    )
      return;
    setAttempt(response);
    void onRespond(response);
  }
  const details = request.details;
  const questions = request.questions || [];
  const canAnswer =
    questions.length > 0 &&
    questions.every((question) => answers[question.id]?.trim());
  return (
    <>
      <button className="agent-pending-request" onClick={() => setOpen(true)}>
        {queued
          ? "回答已提交，查看接收状态"
          : request.kind === "approval"
            ? "处理当前审批"
            : "回答当前问题"}
      </button>
      {open &&
        createPortal(
          <div className="agent-request-backdrop">
            <section
              className="agent-request-dialog"
              ref={dialog}
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              aria-label={title}
            >
              <div className="agent-card-heading">
                <h3>{title}</h3>
                <button onClick={() => setOpen(false)}>稍后处理</button>
              </div>
              <p>{request.description || "执行正在等待你的决定。"}</p>
              {details?.cwd && (
                <p>
                  <strong>执行目录：</strong>
                  {details.cwd}
                </p>
              )}
              {details?.command && (
                <>
                  <strong>请求执行的命令</strong>
                  <pre>{details.command}</pre>
                </>
              )}
              {!!details?.files?.length && (
                <>
                  <strong>请求修改的文件</strong>
                  <ul>
                    {details.files.map((file, i) => (
                      <li key={i}>{file}</li>
                    ))}
                  </ul>
                </>
              )}
              {request.kind === "approval" ? (
                <>
                  <p className="agent-note">
                    只处理这一次请求，不更改本批次后续操作的权限。
                  </p>
                  {!details?.allowedDecisions?.includes("accept") && (
                    <p className="agent-note">
                      本批次权限下，当前操作不能批准。你可以稍后处理或停止本批次。
                    </p>
                  )}
                  <div className="agent-actions">
                    <button
                      className="primary"
                      disabled={
                        busy ||
                        queued ||
                        !!attempt ||
                        !details?.allowedDecisions?.includes("accept")
                      }
                      onClick={() => respond({ decision: "accept" })}
                    >
                      仅本次同意
                    </button>
                    <button
                      disabled={
                        busy ||
                        queued ||
                        !!attempt ||
                        !(
                          details?.allowedDecisions ?? ["decline", "cancel"]
                        ).includes("decline")
                      }
                      onClick={() => respond({ decision: "decline" })}
                    >
                      拒绝本次操作
                    </button>
                    <button
                      disabled={
                        busy ||
                        queued ||
                        !!attempt ||
                        !(
                          details?.allowedDecisions ?? ["decline", "cancel"]
                        ).includes("cancel")
                      }
                      onClick={() => respond({ decision: "cancel" })}
                    >
                      取消当前请求
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {questions.map((question) => (
                    <fieldset
                      key={question.id}
                      className="agent-native-question"
                      disabled={busy || queued || !!attempt}
                    >
                      <legend>{question.prompt}</legend>
                      {(question.options || []).map((option) => (
                        <label key={option.label}>
                          <input
                            type="radio"
                            name={`native-${request.requestId}-${question.id}`}
                            value={option.label}
                            checked={answers[question.id] === option.label}
                            onChange={() =>
                              setAnswers({
                                ...answers,
                                [question.id]: option.label,
                              })
                            }
                          />
                          <span>
                            {option.label}
                            {option.description && (
                              <small>{option.description}</small>
                            )}
                          </span>
                        </label>
                      ))}
                      {(!question.options?.length || question.isOther) &&
                        (question.isSecret ? (
                          <input
                            type="password"
                            autoComplete="off"
                            aria-label={question.prompt}
                            value={answers[question.id] || ""}
                            maxLength={4000}
                            onChange={(event) =>
                              setAnswers({
                                ...answers,
                                [question.id]: event.target.value,
                              })
                            }
                          />
                        ) : (
                          <textarea
                            aria-label={question.prompt}
                            placeholder="输入你的回答"
                            rows={2}
                            value={answers[question.id] || ""}
                            maxLength={4000}
                            onChange={(event) =>
                              setAnswers({
                                ...answers,
                                [question.id]: event.target.value,
                              })
                            }
                          />
                        ))}
                    </fieldset>
                  ))}
                  <button
                    className="primary"
                    disabled={busy || queued || !!attempt || !canAnswer}
                    onClick={() =>
                      respond({
                        answers: Object.fromEntries(
                          questions.map((question) => [
                            question.id,
                            { answers: [answers[question.id].trim()] },
                          ]),
                        ),
                      })
                    }
                  >
                    发送回答
                  </button>
                </>
              )}
              {error && (
                <p className="agent-error" role="alert">
                  {error}
                </p>
              )}
              {queued ? (
                <p role="status">
                  {receiptStatus === "expired"
                    ? "请求已过期，正在刷新当前执行。"
                    : receiptStatus === "cancelled"
                      ? "请求已取消，正在刷新当前执行。"
                      : receiptStatus === "applied"
                        ? "本机已接收回答，正在刷新执行结果。"
                        : "已提交，等待本机确认和当前操作返回结果。"}
                </p>
              ) : (
                attempt && (
                  <>
                    <p className="agent-note">
                      正在确认这次选择的发送结果。重试会复用同一次回答。
                    </p>
                    <button disabled={busy} onClick={() => respond(attempt)}>
                      重试发送选择
                    </button>
                  </>
                )
              )}
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
