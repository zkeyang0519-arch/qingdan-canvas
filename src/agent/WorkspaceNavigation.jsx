import React, { useEffect, useLayoutEffect, useRef } from "react";
import {
  BookMarked,
  ChevronDown,
  ChevronsUpDown,
  Clapperboard,
  FolderOpen,
  Inbox,
  ListChecks,
  MessagesSquare,
  Monitor,
  NotebookText,
  Plus,
  Settings2,
} from "lucide-react";
import { Button } from "./ui/button.jsx";
import { Badge } from "./ui/badge.jsx";
import { Separator } from "./ui/separator.jsx";

const primary = [
  ["chat", "项目对话", MessagesSquare, "项目聊天"],
  ["tasks", "待办与执行", ListChecks],
  ["film", "短片制作", Clapperboard],
];
const resources = [["summary", "项目资料", NotebookText, "打开项目资料"]];
const settings = ["settings", "设置", Settings2];

export default function WorkspaceNavigation({
  pages,
  page,
  pane,
  countsFor,
  selectProject,
  onCreate,
  navigate,
  openDevices,
  pendingCount,
  connection,
  connectionText,
}) {
  const projectMenu = useRef(null);
  const moreMenu = useRef(null);
  const menu = useRef(null);
  const marker = useRef(null);
  const closeMenus = () => {
    for (const ref of [projectMenu, moreMenu])
      if (ref.current) ref.current.open = false;
  };
  useEffect(() => {
    const dismiss = (event) => {
      for (const ref of [projectMenu, moreMenu]) {
        const el = ref.current;
        if (!el?.open) continue;
        if (event.type === "keydown") {
          if (event.key !== "Escape" || !el.contains(document.activeElement))
            continue;
          el.open = false;
          el.querySelector("summary")?.focus();
        } else if (!el.contains(event.target)) el.open = false;
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, []);
  useLayoutEffect(() => {
    const place = () => {
      const item = [
        ...menu.current.querySelectorAll('[aria-current="page"]'),
      ].find((el) => el.offsetWidth);
      const active = marker.current;
      if (!active) return;
      if (!item || !item.offsetWidth) {
        active.hidden = true;
        return;
      }
      active.hidden = false;
      const itemBounds = item.getBoundingClientRect();
      const menuBounds = menu.current.getBoundingClientRect();
      active.style.width = item.offsetWidth + "px";
      active.style.height = item.offsetHeight + "px";
      active.style.transform = `translate(${itemBounds.left - menuBounds.left + menu.current.scrollLeft}px, ${itemBounds.top - menuBounds.top + menu.current.scrollTop}px)`;
    };
    place();
    if (!window.ResizeObserver) return;
    const observer = new window.ResizeObserver(place);
    observer.observe(menu.current);
    return () => observer.disconnect();
  }, [pane]);
  function visit(view) {
    closeMenus();
    navigate(view);
  }
  function link([key, label, Icon, accessibleName]) {
    return (
      <Button
        variant="ghost"
        key={key}
        type="button"
        className="studio-link qd:h-10 qd:w-full qd:justify-start qd:gap-3 qd:rounded-xl qd:max-[760px]:justify-center qd:max-[760px]:gap-0 qd:max-[760px]:px-1 qd:max-[760px]:text-xs"
        aria-label={accessibleName || label}
        aria-current={
          pane === key || (pane === "memory" && key === "summary")
            ? "page"
            : undefined
        }
        onClick={() => visit(key)}
      >
        <Icon size={17} aria-hidden="true" />
        {key === "chat" || key === "film" ? (
          <>
            <span className="studio-wide-label">{label}</span>
            <span className="studio-compact-label">
              {key === "chat" ? "对话" : "短片"}
            </span>
          </>
        ) : (
          <span>{label}</span>
        )}
        {key === "tasks" && page && (
          <Badge
            variant="secondary"
            className="studio-nav-count qd:max-[760px]:hidden"
            aria-label="未完成待办"
          >
            {countsFor(page).pending}
          </Badge>
        )}
      </Button>
    );
  }
  function inbox() {
    return (
      <Button
        variant="ghost"
        type="button"
        className="studio-inbox qd:w-full qd:justify-start qd:gap-3 qd:rounded-xl"
        data-pending={pendingCount > 0}
        aria-current={pane === "inbox" ? "page" : undefined}
        onClick={() => visit("inbox")}
      >
        <Inbox size={16} aria-hidden="true" />
        <span>待处理请求</span>
        <small aria-live="polite">{pendingCount}</small>
      </Button>
    );
  }
  function devices() {
    return (
      <Button
        variant="ghost"
        type="button"
        className="studio-device qd:h-auto qd:w-full qd:justify-start qd:gap-3 qd:rounded-xl qd:py-3"
        aria-label="绑定 agent"
        onClick={() => {
          closeMenus();
          openDevices();
        }}
      >
        <Monitor size={17} aria-hidden="true" />
        <span>
          <b>设备与绑定</b>
          <small
            className={`agent-connection-chip ${connection === "online" ? "is-online" : ""}`}
          >
            <i />
            {connectionText}
          </small>
        </span>
      </Button>
    );
  }
  return (
    <aside className="studio-rail" aria-label="Agent 项目导航">
      <div className="studio-identity">
        <span className="brand-mark" aria-hidden="true" />
        <b>轻单</b>
        <Badge variant="outline">Agent</Badge>
      </div>
      <details className="studio-project-switch" ref={projectMenu}>
        <summary aria-label="切换当前项目">
          <FolderOpen size={18} aria-hidden="true" />
          <span>
            <small>当前项目</small>
            <b title={page?.title || "选择项目"}>{page?.title || "选择项目"}</b>
          </span>
          <ChevronsUpDown size={13} />
        </summary>
        <div className="studio-menu">
          {pages.map((item) => (
            <button
              type="button"
              className="agent-project-item"
              key={item.id}
              aria-label={`选择项目：${item.title || "未命名项目"}`}
              aria-current={item.id === page?.id ? "page" : undefined}
              onClick={() => {
                closeMenus();
                selectProject(item.id);
                projectMenu.current?.querySelector("summary")?.focus();
              }}
            >
              <span>{item.title || "未命名项目"}</span>
              <small aria-label={`${countsFor(item).pending} 项未完成`}>
                {countsFor(item).pending}
              </small>
            </button>
          ))}
          {onCreate && (
            <button
              type="button"
              onClick={() => {
                closeMenus();
                onCreate();
              }}
            >
              <Plus size={15} />
              新建项目
            </button>
          )}
        </div>
      </details>
      <nav ref={menu} className="studio-nav" aria-label="Agent 工作区内容">
        <i
          className="studio-nav-marker"
          ref={marker}
          aria-hidden="true"
          hidden
        />
        <p className="studio-group-name">工作区</p>
        {primary.map(link)}
        <div className="studio-desktop-links">
          <p className="studio-group-name">项目资料</p>
          {resources.map(link)}
        </div>
        <details ref={moreMenu} className="studio-more">
          <summary
            aria-label="更多项目功能"
            aria-current={
              ["memory", "summary", "inbox", "settings"].includes(pane)
                ? "page"
                : undefined
            }
          >
            更多 <ChevronDown size={13} />
          </summary>
          <div className="studio-menu">
            {resources.map(link)}
            {link(settings)}
            {inbox()}
            {devices()}
          </div>
        </details>
      </nav>
      <div className="studio-rail-foot">
        <Separator className="studio-rail-divider" />
        {link(settings)}
        {inbox()}
        {devices()}
      </div>
      {pendingCount > 0 && <div className="studio-mobile-alert">{inbox()}</div>}
    </aside>
  );
}
