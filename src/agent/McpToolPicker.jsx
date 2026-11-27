import React, { useId, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Info,
  Search,
} from "lucide-react";
import { groupMcpTools } from "./mcp-tool-groups.js";
import {
  waaoProjectTools,
  waaoFilmCoreTools,
  waaoUploadTools,
} from "../../shared/agent/waao-endpoint.mjs";

const pageSize = 8;

function ToolRows({ items, selected, disabled, onChange, readOnly }) {
  const [expanded, setExpanded] = useState(null);
  const id = useId();
  const RowLabel = readOnly ? "div" : "label";
  return (
    <div className="qd-mcp-tool-list">
      {items.map((tool) => {
        const open = expanded === tool.name;
        const detailId = `${id}-${tool.name}`;
        return (
          <div className="qd-mcp-tool" key={tool.name}>
            <div className="qd-mcp-tool-line">
              <RowLabel className="qd-mcp-choice">
                {!readOnly && (
                  <input
                    type="checkbox"
                    value={tool.name}
                    checked={selected.includes(tool.name)}
                    disabled={disabled}
                    onChange={(event) =>
                      onChange(tool.name, event.target.checked)
                    }
                  />
                )}
                <strong title={tool.label || tool.name}>
                  {tool.label || tool.name}
                </strong>
              </RowLabel>
              <button
                type="button"
                className="qd-mcp-tool-info"
                aria-label={`查看工具说明：${tool.label || tool.name}`}
                aria-expanded={open}
                aria-controls={detailId}
                onClick={() => setExpanded(open ? null : tool.name)}
              >
                <Info size={15} aria-hidden="true" />
              </button>
            </div>
            {open && (
              <div className="qd-mcp-tool-description" id={detailId}>
                <code>{tool.name}</code>
                <p>{tool.description || "此工具暂未提供说明。"}</p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function McpToolPicker({
  server,
  disabled,
  onSelect,
  onPreset,
  readOnly = false,
}) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("all");
  const [category, setCategory] = useState(null);
  const [page, setPage] = useState(0);
  const id = useId();
  const selected = server.selected;
  const filter = query.trim().toLowerCase();
  const filtered = server.tools.filter(
    (tool) =>
      (readOnly || mode !== "selected" || selected.includes(tool.name)) &&
      [tool.name, tool.label, tool.description].some((value) =>
        value?.toLowerCase().includes(filter),
      ),
  );
  const grouped = server.kind === "waao" || server.tools.length > pageSize;
  const groups = groupMcpTools(filtered, server.kind);
  const searching = !!filter;
  const active = groups.find((group) => group.id === category);
  const items = searching || !grouped ? filtered : active?.tools || [];
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const currentItems = items.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize,
  );
  const selectedCount = server.tools.filter((tool) =>
    selected.includes(tool.name),
  ).length;
  const select = (name, checked) =>
    onSelect(
      checked
        ? [...new Set([...selected, name])]
        : selected.filter((item) => item !== name),
    );
  const presets =
    server.kind === "waao" && !readOnly
      ? [
          {
            label: "选用项目查询工具",
            detail: "查找项目与画布",
            names: waaoProjectTools,
          },
          {
            label: "选用短片制作工具",
            detail: "素材、生成与任务跟踪",
            names: [
              ...waaoProjectTools,
              ...waaoFilmCoreTools,
              ...waaoUploadTools,
              "approval_get",
            ],
            required: "node_generate",
          },
        ].filter((preset) =>
          server.tools.some((tool) =>
            preset.required
              ? tool.name === preset.required
              : preset.names.includes(tool.name),
          ),
        )
      : [];

  function list() {
    return (
      <>
        <ToolRows
          items={currentItems}
          selected={selected}
          disabled={disabled}
          onChange={select}
          readOnly={readOnly}
        />
        {totalPages > 1 && (
          <nav className="qd-mcp-pagination" aria-label="工具分页">
            <button
              type="button"
              aria-label="上一页工具"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              <ChevronLeft size={14} aria-hidden="true" />
            </button>
            <span aria-live="polite">
              第 {currentPage + 1} / {totalPages} 页 · 共 {items.length} 项
            </span>
            <button
              type="button"
              aria-label="下一页工具"
              disabled={currentPage + 1 === totalPages}
              onClick={() => setPage(currentPage + 1)}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </nav>
        )}
      </>
    );
  }

  return (
    <section
      className="qd-mcp-picker"
      data-readonly={readOnly || undefined}
      aria-label={readOnly ? "可用工具目录" : "在当前项目启用"}
    >
      {presets.length > 0 && (
        <div className="qd-mcp-presets">
          <div className="qd-mcp-section-heading">
            <strong>常用组合</strong>
            <small>添加工具，保留已有选择</small>
          </div>
          <div className="qd-mcp-preset-grid">
            {presets.map((preset) => (
              <button
                key={preset.label}
                type="button"
                aria-label={preset.label}
                disabled={disabled}
                onClick={() => onPreset(preset.names)}
              >
                <strong>
                  {preset.label.replace("选用", "").replace("工具", "")}
                </strong>
                <small>{preset.detail}</small>
              </button>
            ))}
          </div>
        </div>
      )}
      {!readOnly && server.kind === "codex" && !selectedCount && (
        <button
          type="button"
          className="qd-mcp-enable-codex"
          disabled={disabled}
          onClick={() => onPreset(["codex", "codex-reply"])}
        >
          启用 Codex 对话工具
        </button>
      )}
      <div className="qd-mcp-section-heading">
        <strong>{readOnly ? "可用工具目录" : "在当前项目启用"}</strong>
        <small aria-live="polite">
          {readOnly
            ? `已发现 ${server.tools.length} 项 · 按需加载`
            : `已启用 ${selectedCount} / ${server.tools.length}`}
        </small>
      </div>
      {!readOnly && (
        <div
          className="qd-mcp-selection-actions"
          role="group"
          aria-label="工具批量选择"
        >
          <button
            type="button"
            aria-label="全选当前服务工具"
            disabled={disabled || selectedCount === server.tools.length}
            onClick={() => onPreset(server.tools.map((tool) => tool.name))}
          >
            全选
          </button>
          <button
            type="button"
            aria-label="取消全选当前服务工具"
            disabled={disabled || selected.length === 0}
            onClick={() => onSelect([])}
          >
            取消全选
          </button>
          <small>当前服务的全部 {server.tools.length} 项</small>
        </div>
      )}
      {grouped && (
        <>
          {!readOnly && (
            <div
              className="qd-mcp-tool-filters"
              role="group"
              aria-label="工具范围"
            >
              {[
                ["all", "全部工具", server.tools.length],
                ["selected", "已启用", selectedCount],
              ].map(([value, label, count]) => (
                <button
                  key={value}
                  type="button"
                  aria-label={label}
                  aria-pressed={mode === value}
                  onClick={() => {
                    setMode(value);
                    setPage(0);
                  }}
                >
                  {label}
                  <span>{count}</span>
                </button>
              ))}
            </div>
          )}
          <label className="qd-mcp-tool-search">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              aria-label="搜索工具"
              placeholder="搜索名称或用途…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
            />
          </label>
        </>
      )}
      {!filtered.length ? (
        <p className="qd-mcp-tool-empty" role="status">
          {filter
            ? "没有匹配的工具。"
            : readOnly
              ? "当前服务未返回工具。"
              : "当前项目还未启用工具，可从「全部工具」中选择。"}
        </p>
      ) : searching || !grouped ? (
        <div className="qd-mcp-tool-results">
          {searching && (
            <small role="status">找到 {filtered.length} 个工具</small>
          )}
          {list()}
        </div>
      ) : (
        <div className="qd-mcp-tool-groups">
          {groups.map((group) => {
            const open = category === group.id;
            const count = group.tools.filter((tool) =>
              selected.includes(tool.name),
            ).length;
            return (
              <div className="qd-mcp-tool-group" key={group.id}>
                <button
                  type="button"
                  className="qd-mcp-group-toggle"
                  aria-label={group.label}
                  aria-expanded={open}
                  aria-controls={`${id}-${group.id}`}
                  onClick={() => {
                    setCategory(open ? null : group.id);
                    setPage(0);
                  }}
                >
                  <ChevronDown size={15} aria-hidden="true" />
                  <strong>{group.label}</strong>
                  <small>
                    {group.tools.length} 项
                    {!readOnly && count > 0 && ` · 已启用 ${count}`}
                  </small>
                </button>
                {open && (
                  <div
                    className="qd-mcp-group-content"
                    id={`${id}-${group.id}`}
                  >
                    {list()}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
