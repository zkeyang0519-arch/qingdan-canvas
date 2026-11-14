import React from "react";
import { moduleStatusLabels } from "../../shared/agent/progress";

function Items({ items }) {
  return items.length ? (
    <ul>
      {items.map((item, index) => (
        <li key={index}>
          {item.text}
          {item.evidenceRef && (
            <details className="agent-progress-evidence">
              <summary>依据</summary>
              <small>{item.evidenceRef}</small>
            </details>
          )}
        </li>
      ))}
    </ul>
  ) : (
    <p className="agent-note">暂无明确记录</p>
  );
}

export function ProjectBackground({ background }) {
  return (
    <section className="agent-progress-background" aria-label="项目背景">
      <h5>项目背景</h5>
      <strong>{background.name}</strong>
      <p>{background.purpose}</p>
      <p>
        <span className="agent-note">当前阶段：</span>
        {background.stage}
      </p>
    </section>
  );
}

export default function ProjectProgress({ modules }) {
  return (
    <div className="agent-progress-modules">
      {modules.length ? (
        modules.map((module, index) => (
          <section
            className="agent-progress-module"
            key={index}
            aria-label={`模块：${module.name}`}
          >
            <div className="agent-progress-heading">
              <h5>{module.name}</h5>
              <span
                className="agent-progress-status"
                data-status={module.status}
              >
                {moduleStatusLabels[module.status]}
              </span>
            </div>
            <div className="agent-progress-columns">
              {[
                ["current", "当前进度"],
                ["remaining", "剩余工作"],
                ["nextSteps", "下一步"],
              ].map(([key, label]) => (
                <section key={key}>
                  <h6>{label}</h6>
                  <Items items={module[key]} />
                </section>
              ))}
            </div>
          </section>
        ))
      ) : (
        <p className="agent-note">暂无可确认的模块进度，请补充项目记录。</p>
      )}
    </div>
  );
}
