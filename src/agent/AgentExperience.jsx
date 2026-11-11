import React, { useEffect, useState } from "react";
import { Modal } from "../canvas/Panels.jsx";
import RuleTrial from "./RuleTrial.jsx";
import CodexTrial from "./CodexTrial.jsx";
import DevicePanel from "./DevicePanel.jsx";
import ExecutionPanel from "./ExecutionPanel.jsx";
import ChecklistPanel from "./ChecklistPanel.jsx";
import ChatPanel from "./ChatPanel.jsx";
import ProjectSummaryPanel from "./ProjectSummaryPanel.jsx";
import BatchPanel from "./BatchPanel.jsx";
import PendingBatchNotice from "./PendingBatchNotice.jsx";
import "./experience.css";
export {
  RuleTrial,
  CodexTrial,
  DevicePanel,
  ExecutionPanel,
  ChecklistPanel,
  ChatPanel,
  ProjectSummaryPanel,
  BatchPanel,
  PendingBatchNotice,
};

export default function AgentExperience({
  roomId,
  userId,
  pages,
  onClose,
  initialBatchTarget = null,
  initialStep = "rules",
  onBatchTargetChange,
}) {
  const [step, setStep] = useState(initialStep);
  const [checklistId, setChecklistId] = useState("");
  const [batchTarget, setBatchTarget] = useState(initialBatchTarget);
  useEffect(() => {
    if (batchTarget) onBatchTargetChange?.(batchTarget);
  }, [batchTarget, onBatchTargetChange]);
  const preferredChecklist = pages?.find((page) => page.id === checklistId);
  return (
    <Modal
      title="Agent 验证"
      onClose={onClose}
      wide
      className="agent-experience"
    >
      <p className="agent-subtitle">每完成一步，都在这里亲手验证。</p>
      <div className="agent-tabs" role="tablist" aria-label="功能步骤">
        <button
          role="tab"
          id="agent-tab-rules"
          aria-selected={step === "rules"}
          aria-controls="agent-experience-content"
          onClick={() => setStep("rules")}
        >
          1 · 任务规则
        </button>
        <button
          role="tab"
          id="agent-tab-codex"
          aria-selected={step === "codex"}
          aria-controls="agent-experience-content"
          onClick={() => setStep("codex")}
        >
          2 · 本机 Codex
        </button>
        <button
          role="tab"
          id="agent-tab-devices"
          aria-selected={step === "devices"}
          aria-controls="agent-experience-content"
          onClick={() => setStep("devices")}
        >
          3 · 绑定电脑
        </button>
        <button
          role="tab"
          id="agent-tab-execution"
          aria-selected={step === "execution"}
          aria-controls="agent-experience-content"
          onClick={() => setStep("execution")}
        >
          4 · MCP 派单
        </button>
        <button
          role="tab"
          id="agent-tab-checklist"
          aria-selected={step === "checklist"}
          aria-controls="agent-experience-content"
          onClick={() => setStep("checklist")}
        >
          5 · 真实清单
        </button>
        <button
          role="tab"
          id="agent-tab-chat"
          aria-selected={step === "chat"}
          aria-controls="agent-experience-content"
          onClick={() => setStep("chat")}
        >
          6 · 聊天与记忆
        </button>
        <button
          role="tab"
          id="agent-tab-summary"
          aria-selected={step === "summary"}
          aria-controls="agent-experience-content"
          onClick={() => setStep("summary")}
        >
          7 · 项目总结
        </button>
        <button
          role="tab"
          id="agent-tab-batch"
          aria-selected={step === "batch"}
          aria-controls="agent-experience-content"
          onClick={() => setStep("batch")}
        >
          8 · 批次执行
        </button>
      </div>
      {step !== "batch" && batchTarget && (
        <PendingBatchNotice
          roomId={roomId}
          userId={userId}
          target={batchTarget}
          onOpen={() => setStep("batch")}
        />
      )}
      <div
        id="agent-experience-content"
        role="tabpanel"
        aria-labelledby={`agent-tab-${step}`}
      >
        {step === "rules" ? (
          <RuleTrial
            storageKey={`qingdan.agent-trial.v1.${userId}/${roomId}`}
            pages={pages}
          />
        ) : step === "codex" ? (
          <CodexTrial />
        ) : step === "devices" ? (
          <DevicePanel roomId={roomId} userId={userId} pages={pages} />
        ) : step === "execution" ? (
          <ExecutionPanel
            key={`${userId}/${roomId}`}
            roomId={roomId}
            userId={userId}
            pages={pages}
          />
        ) : step === "checklist" ? (
          <ChecklistPanel
            roomId={roomId}
            userId={userId}
            onOpenBatch={(target) => {
              setBatchTarget(target);
              setChecklistId(target.sectionId);
              setStep("batch");
            }}
            pages={
              preferredChecklist
                ? [
                    preferredChecklist,
                    ...pages.filter((page) => page.id !== checklistId),
                  ]
                : pages
            }
          />
        ) : step === "batch" ? (
          <BatchPanel
            roomId={roomId}
            userId={userId}
            pages={pages}
            initialTarget={batchTarget}
            initialPageId={checklistId}
            onSelectBatch={setBatchTarget}
            onOpenChecklist={(id) => {
              setChecklistId(id);
              setStep("checklist");
            }}
          />
        ) : step === "summary" ? (
          <ProjectSummaryPanel
            roomId={roomId}
            userId={userId}
            pages={pages}
            initialPageId={checklistId}
            onOpenChat={(id) => {
              setChecklistId(id);
              setStep("chat");
            }}
          />
        ) : (
          <ChatPanel
            roomId={roomId}
            userId={userId}
            pages={
              preferredChecklist
                ? [
                    preferredChecklist,
                    ...pages.filter((page) => page.id !== checklistId),
                  ]
                : pages
            }
            onOpenChecklist={(id) => {
              setChecklistId(id);
              setStep("checklist");
            }}
          />
        )}
      </div>
    </Modal>
  );
}
