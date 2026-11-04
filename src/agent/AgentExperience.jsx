import React, { useState } from "react";
import { Modal } from "../canvas/Panels.jsx";
import RuleTrial from "./RuleTrial.jsx";
import CodexTrial from "./CodexTrial.jsx";
import DevicePanel from "./DevicePanel.jsx";
import ExecutionPanel from "./ExecutionPanel.jsx";
import "./experience.css";
export { RuleTrial, CodexTrial, DevicePanel, ExecutionPanel };

export default function AgentExperience({ roomId, userId, pages, onClose }) {
  const [step, setStep] = useState("rules");
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
      </div>
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
        ) : (
          <ExecutionPanel
            key={`${userId}/${roomId}`}
            roomId={roomId}
            userId={userId}
            pages={pages}
          />
        )}
      </div>
    </Modal>
  );
}
