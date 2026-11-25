import React from "react";
import { MessageCircleQuestion, Clock3 } from "lucide-react";
import "./human-request.css";

export default function HumanRequestCard({
  title = "需要你的选择",
  context,
  description,
  status = "等待回答",
  onLater,
  children,
  details,
  footer,
  label = title,
}) {
  return (
    <section className="agent-human-card" aria-label={label}>
      <header>
        <span className="agent-human-icon">
          <MessageCircleQuestion size={19} aria-hidden="true" />
        </span>
        <div>
          <strong>{title}</strong>
          {context && <small>{context}</small>}
        </div>
        <span className="agent-human-status">
          <Clock3 size={12} aria-hidden="true" />
          {status}
        </span>
      </header>
      {description && <p className="agent-human-description">{description}</p>}
      <div className="agent-human-content">{children}</div>
      {details && (
        <details className="agent-human-details">
          <summary>查看已尝试的步骤</summary>
          {details}
        </details>
      )}
      <footer>
        {footer}
        {onLater && (
          <button type="button" onClick={onLater}>
            稍后回答
          </button>
        )}
      </footer>
      <small className="agent-human-footnote">回答只用于这次请求。</small>
    </section>
  );
}
