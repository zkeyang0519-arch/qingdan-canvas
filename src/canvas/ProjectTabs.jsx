import React, { useId, useLayoutEffect, useRef } from "react";
import { FileText, Plus } from "lucide-react";

export default function ProjectTabs({
  pages,
  page,
  onChoose,
  onCreate,
  readOnly,
  panelId,
}) {
  const prefix = useId(),
    list = useRef(null);
  useLayoutEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [page?.id]);
  return (
    <div className="project-navigation">
      <div
        className="project-tabs"
        role="tablist"
        aria-label="项目清单"
        ref={list}
      >
        {pages.map((project, index) => {
          const pending = project.tasks.filter(
            (task) => !task.block.done,
          ).length;
          return (
            <button
              key={project.id}
              id={`${prefix}-${project.id}`}
              role="tab"
              className="project-tab"
              aria-selected={project.id === page?.id}
              aria-controls={panelId}
              aria-label={project.title}
              title={`${project.title} · ${pending} 项未完成`}
              tabIndex={project.id === page?.id ? 0 : -1}
              onClick={(event) => {
                onChoose(project.id);
                event.currentTarget.focus({ preventScroll: true });
              }}
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? pages.length - 1
                      : (index +
                          (event.key === "ArrowRight" ? 1 : -1) +
                          pages.length) %
                        pages.length;
                onChoose(pages[next].id);
                list.current
                  .querySelectorAll('[role="tab"]')
                  [next]?.focus({ preventScroll: true });
              }}
            >
              <FileText size={15} aria-hidden="true" />
              <span className="project-tab-title">{project.title}</span>
              <span className="project-tab-count" aria-hidden="true">
                {pending}
              </span>
            </button>
          );
        })}
      </div>
      <button
        className="project-tab-add"
        aria-label="新建灵感板"
        title="新建灵感板"
        disabled={readOnly}
        onClick={onCreate}
      >
        <Plus size={18} />
      </button>
    </div>
  );
}
