import React, { useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Circle,
  Highlighter,
  Type,
  Undo2,
  Crop,
  Maximize,
  MoreHorizontal,
  RotateCw,
  FlipHorizontal,
  StickyNote,
  Download,
  Check,
  Link2,
} from "lucide-react";
import { clamp } from "./images.js";

export default function ImageToolbar({
  rect,
  dimensions,
  mode,
  tool,
  onAction,
  disabled,
  canUndo,
  notes = [],
  menu,
  setMenu,
  viewportOffset = 0,
}) {
  const element = useRef(null),
    [size, setSize] = useState({ width: 320, height: 44 });
  useLayoutEffect(() => {
    const el = element.current;
    const measure = () => {
      if (el.offsetWidth)
        setSize({ width: el.offsetWidth, height: el.offsetHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [mode, dimensions.width, notes.length]);
  const left = clamp(
    rect.x + rect.width / 2 - size.width / 2,
    8,
    Math.max(8, dimensions.width - size.width - 8),
  );
  const top = clamp(
    rect.y - size.height - 14 >= 8
      ? rect.y - size.height - 14
      : rect.y + rect.height + 14,
    8,
    Math.max(8, dimensions.height - size.height - 8),
  );
  const btn = (action, label, Icon, props = {}) => (
    <button type="button" onClick={() => onAction(action)} {...props}>
      <Icon size={15} />
      {label}
    </button>
  );
  return (
    <div
      ref={element}
      className="image-toolbar"
      role="toolbar"
      aria-label="图片工具"
      style={{
        left,
        top: top + viewportOffset,
        maxWidth: dimensions.width - 16,
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {mode === "annotate" ? (
        <>
          {btn("back", null, ArrowLeft, {
            "aria-label": "返回图片工具",
            title: "返回图片工具",
          })}
          {[
            ["arrow", "箭头", ArrowUpRight],
            ["ellipse", "圈选", Circle],
            ["highlight", "高亮", Highlighter],
            ["text", "文字", Type],
          ].map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              aria-pressed={tool === key}
              onClick={() => onAction(`tool:${key}`)}
              disabled={disabled}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
          <i />
          {btn("undo", null, Undo2, {
            "aria-label": "撤销上一步",
            title: "撤销上一步",
            disabled: disabled || !canUndo,
          })}
        </>
      ) : mode === "crop" ? (
        <>
          {btn("cancel", null, ArrowLeft, {
            "aria-label": "取消本次裁剪",
            title: "取消本次裁剪",
          })}
          <button onClick={() => onAction("free")} disabled={disabled}>
            自由
          </button>
          <button onClick={() => onAction("square")} disabled={disabled}>
            1:1
          </button>
          <i />
          <button onClick={() => onAction("restore")} disabled={disabled}>
            还原
          </button>
          {btn("apply", "应用", Check, {
            className: "image-tool-primary",
            disabled,
          })}
        </>
      ) : (
        <>
          {btn("view", "查看", Maximize, { "aria-label": "查看大图" })}
          {btn("annotate", "标注", Type, { disabled })}
          {btn("crop", "裁剪", Crop, { disabled })}
          {notes.length === 1 &&
            btn(`locate:${notes[0].id}`, "说明", Link2, {
              title: "定位关联便签",
            })}
          <i />
          <button aria-expanded={menu} onClick={() => setMenu(!menu)}>
            <MoreHorizontal size={17} />
            更多
          </button>
        </>
      )}
      {menu && (
        <div
          className={`image-more-menu ${dimensions.height - top < 310 ? "opens-up" : ""}`}
          role="menu"
          aria-label="更多图片操作"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setMenu(false);
            }
          }}
        >
          {btn("rotate", "顺时针旋转", RotateCw, {
            disabled,
            role: "menuitem",
          })}
          {btn("flip", "水平翻转", FlipHorizontal, {
            disabled,
            role: "menuitem",
          })}
          <hr />
          {btn("link", "关联便签", StickyNote, { disabled, role: "menuitem" })}
          {notes.length > 0 && (
            <span className="image-menu-label">已有说明</span>
          )}
          {notes.map((note) => (
            <button
              role="menuitem"
              key={note.id}
              onClick={() => onAction(`locate:${note.id}`)}
            >
              <Link2 size={14} />
              <span>{note.label}</span>
            </button>
          ))}
          <hr />
          {btn("download-original", "下载原图", Download, { role: "menuitem" })}
          {btn("download-current", "下载当前图片 · PNG", Download, {
            role: "menuitem",
          })}
        </div>
      )}
      {mode && (
        <span className="image-edit-hint">
          {mode === "crop"
            ? "拖动四角调整 · 点击画布应用 · Esc 取消"
            : "在图片上绘制 · 点击画布结束"}
        </span>
      )}
    </div>
  );
}
