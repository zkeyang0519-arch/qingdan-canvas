import React from "react";
import { Wrench, ArrowLeft } from "lucide-react";
import "./coming-soon.css";

export default function AgentComingSoon({ onBack }) {
  return (
    <section
      className="agent-coming-soon"
      role="status"
      aria-label="Agent 开发状态"
    >
      <div className="agent-coming-soon-icon" aria-hidden="true">
        <Wrench size={27} />
      </div>
      <h2>Agent 正在开发中</h2>
      <p>功能还在完善，暂时无法使用。</p>
      <p>你可以继续使用画布、排列和轻岛管理待办。</p>
      <button type="button" onClick={onBack}>
        <ArrowLeft size={16} />
        返回画布
      </button>
    </section>
  );
}
