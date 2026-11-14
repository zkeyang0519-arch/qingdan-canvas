import React from "react";
import { handoffSections } from "../../shared/agent/handoff";

export default function ProjectHandoffReport({ summary }) {
  return (
    <div className="agent-handoff-report" aria-label="项目交接报告正文">
      {handoffSections(summary).map((section, index) => (
        <section
          className="agent-progress-module"
          key={section.title}
          aria-label={section.title}
        >
          <h5>
            {index + 1}. {section.title}
          </h5>
          {section.paragraphs.map((paragraph, position) => (
            <p className="agent-chat-copy" key={position}>
              {paragraph}
            </p>
          ))}
        </section>
      ))}
    </div>
  );
}
