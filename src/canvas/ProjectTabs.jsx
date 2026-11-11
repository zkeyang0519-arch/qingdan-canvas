import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { FileText, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import ContextMenu from "./ContextMenu.jsx";

export default function ProjectTabs({
  pages: allPages,
  page,
  onChoose,
  onCreate,
  onRename,
  onDelete,
  canEdit,
  menu,
  onMenuChange,
  readOnly,
  panelId,
}) {
  // Keep the model's blank input page available, without showing an empty tab.
  const pages = allPages.filter(
    (project) => project.group || project.objects.length,
  );
  const prefix = useId(),
    list = useRef(null);
  const closeMenu = useCallback(() => onMenuChange(null), [onMenuChange]);
  const menuPage = pages.find((project) => project.id === menu?.pageId);
  const menuDisabled = readOnly || (menuPage && !canEdit(menuPage));
  useEffect(() => {
    if (menu && (!menuPage || readOnly)) closeMenu();
  }, [menu, menuPage?.id, readOnly, closeMenu]);
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
            <div
              key={project.id}
              className="project-tab-shell"
              data-selected={project.id === page?.id}
              role="presentation"
            >
              <button
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
              <button
                type="button"
                className="project-tab-menu"
                aria-label={`项目标签操作：${project.title}`}
                aria-haspopup="menu"
                aria-expanded={menuPage?.id === project.id}
                title="标签操作"
                disabled={readOnly || !canEdit(project)}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.currentTarget.focus({ preventScroll: true });
                  const rect = event.currentTarget.getBoundingClientRect();
                  onMenuChange(
                    menu?.pageId === project.id
                      ? null
                      : {
                          pageId: project.id,
                          anchor: { x: rect.left, y: rect.bottom + 6 },
                          trigger: event.currentTarget,
                        },
                  );
                }}
              >
                <MoreHorizontal size={16} aria-hidden="true" />
              </button>
            </div>
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
      {menuPage &&
        createPortal(
          <ContextMenu
            anchor={menu.anchor}
            label={`${menuPage.title}标签操作`}
            onClose={closeMenu}
            returnFocus={menu.trigger}
            items={[
              {
                label: "重命名",
                icon: <Pencil size={14} />,
                disabled: menuDisabled,
                action: () => onRename(menuPage),
              },
              {
                label: "删除标签",
                icon: <Trash2 size={14} />,
                danger: true,
                disabled: menuDisabled,
                action: () => onDelete(menuPage),
              },
            ]}
          />,
          document.body,
        )}
    </div>
  );
}
