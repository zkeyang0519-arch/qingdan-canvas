import React, { useMemo, useRef, useState } from "react";
import {
  ArrowUpDown,
  Check,
  LayoutGrid,
  List,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Server,
  Trash2,
  X,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover.jsx";
import { productServers } from "./model.js";
import { validDeadline } from "../../shared/deadline.js";

const STATUS = { running: "运行中", maintenance: "维护中", retired: "已停用" };
const ENVIRONMENT = {
  production: "生产",
  staging: "测试",
  development: "开发",
};

export function isDueSoon(server, now) {
  if (!validDeadline(server.dueAt)) return false;
  const remaining = Date.parse(server.dueAt) - now;
  return remaining >= 0 && remaining <= 7 * 24 * 60 * 60 * 1000;
}

export function RecordActions({
  record,
  type,
  readOnly,
  onOpen,
  onEdit,
  onDelete,
  onStatusChange,
}) {
  const [open, setOpen] = useState(false);
  const opensDialog = useRef(false);
  const triggerRef = useRef(null);
  const run = (action) => {
    opensDialog.current = true;
    setOpen(false);
    action(triggerRef.current);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="ops-icon-button"
          ref={triggerRef}
          aria-label={`更多操作：${record.name}`}
        >
          <MoreHorizontal size={17} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="ops-record-menu"
        aria-label={`${record.name}的操作`}
        onKeyDown={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          if (opensDialog.current) event.preventDefault();
          opensDialog.current = false;
        }}
      >
        <button onClick={() => run(onOpen)}>查看详情</button>
        <button onClick={() => run(onEdit)} disabled={readOnly}>
          <Pencil size={13} />
          编辑信息
        </button>
        {type === "server" && (
          <div
            className="ops-server-status-switch"
            role="group"
            aria-label={`服务器状态：${record.name}`}
          >
            <span>运行状态</span>
            {Object.entries(STATUS).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={record.status === value}
                disabled={readOnly}
                onClick={() => onStatusChange(value)}
              >
                <i className={`ops-mini-dot ${value}`} />
                {value === "retired" ? "停用" : label}
                {record.status === value && <Check size={12} />}
              </button>
            ))}
          </div>
        )}
        <button
          className="ops-danger"
          aria-label={`删除${type === "product" ? "产品" : "服务器"}：${record.name}`}
          onClick={() => {
            setOpen(false);
            onDelete();
          }}
          disabled={readOnly}
        >
          <Trash2 size={13} />
          删除{type === "product" ? "产品" : "服务器"}
        </button>
      </PopoverContent>
    </Popover>
  );
}

export default function OperationsDirectory({
  ops,
  view,
  records,
  keyword,
  setKeyword,
  status,
  setStatus,
  environment,
  setEnvironment,
  soonOnly,
  soonCount,
  showSoon,
  resetFilters,
  readOnly,
  onOpen,
  openForm,
  confirmDelete,
  changeServerStatus,
  productDates,
  serverDeadline,
}) {
  const [layout, setLayout] = useState("table");
  const [sort, setSort] = useState("default");
  const isProduct = view === "products";
  const type = isProduct ? "product" : "server";
  const label = isProduct ? "产品" : "服务器";
  const allRecords = isProduct ? ops.products : ops.servers;
  const related = (record) =>
    isProduct ? productServers(ops, record.id) : [record];
  const rows = useMemo(() => {
    if (sort === "default") return records;
    const deadline = (record) =>
      Math.min(
        ...(isProduct ? productServers(ops, record.id) : [record])
          .filter((server) => validDeadline(server.dueAt))
          .map((server) => Date.parse(server.dueAt)),
        Infinity,
      );
    return [...records].sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name, "zh-CN")
        : deadline(a) - deadline(b) || 0,
    );
  }, [records, ops, isProduct, sort]);

  const hostedProducts = (server) => {
    const ids = new Set(
      ops.deployments
        .filter((item) => item.serverId === server.id)
        .map((item) => item.productId),
    );
    return ops.products.filter((item) => ids.has(item.id));
  };
  const environments = (record) => [
    ...new Set([
      ...(!isProduct && record.environment ? [record.environment] : []),
      ...ops.deployments
        .filter((item) =>
          isProduct
            ? item.productId === record.id
            : item.serverId === record.id,
        )
        .map((item) => item.environment),
    ]),
  ];
  const name = (record) => (
    <button
      className="ops-record-open"
      aria-label={`打开${label}：${record.name}`}
      onClick={(event) => onOpen(type, record.id, event.currentTarget)}
    >
      <span className={`ops-record-icon ${isProduct ? "" : "server"}`}>
        {isProduct ? record.name.slice(0, 1) : <Server size={17} />}
      </span>
      <span className="ops-record-main">
        <strong>{record.name}</strong>
        {isProduct ? (
          record.summary && <small>{record.summary}</small>
        ) : (
          <small>
            {hostedProducts(record)
              .map((item) => item.name)
              .join(" / ") ||
              record.address ||
              "尚未关联产品"}
          </small>
        )}
      </span>
    </button>
  );
  const statusBadge = (record) => (
    <span
      className={`ops-status ${record.status}`}
      aria-label={`${label}状态：${STATUS[record.status]}`}
    >
      <i />
      {STATUS[record.status]}
    </span>
  );
  const resources = (record) =>
    isProduct ? (
      <div className="ops-resource-stack">
        {related(record).length ? (
          related(record).map((server) => (
            <span key={server.id}>
              <Server size={12} />
              {server.name}
            </span>
          ))
        ) : (
          <span>尚未关联</span>
        )}
      </div>
    ) : (
      <div className="ops-provider">
        <span>{record.provider || "未记录服务商"}</span>
        {record.region && <small>{record.region}</small>}
      </div>
    );
  const environmentTags = (record) => (
    <div className="ops-environments">
      {environments(record).map((value) => (
        <span key={value}>{ENVIRONMENT[value]}</span>
      ))}
      {!environments(record).length && <span>未指定</span>}
    </div>
  );
  const dates = (record) =>
    isProduct ? (
      related(record).length ? (
        productDates(record, true)
      ) : (
        <span className="ops-no-date">—</span>
      )
    ) : (
      serverDeadline(record)
    );
  const actions = (record) => (
    <RecordActions
      record={record}
      type={type}
      readOnly={readOnly}
      onOpen={(opener) => onOpen(type, record.id, opener)}
      onEdit={(opener) => openForm(type, record.id, opener)}
      onDelete={() => confirmDelete(type, record)}
      onStatusChange={(value) => changeServerStatus(record, value)}
    />
  );

  return (
    <>
      <div className="ops-page-title">
        <div>
          <p className="ops-breadcrumb">
            运维资产 / {isProduct ? "产品目录" : "服务器台账"}
          </p>
          <h1>{isProduct ? "产品目录" : "服务器台账"}</h1>
        </div>
        <div className="ops-page-actions">
          <button
            className="ops-primary"
            aria-label={`新增${label}`}
            disabled={readOnly}
            onClick={() => openForm(type)}
          >
            <Plus size={15} />
            新增{label}
          </button>
        </div>
      </div>
      <div className="ops-metrics">
        <div>
          <strong>{ops.products.length}</strong>
          <span>个产品</span>
        </div>
        <div>
          <strong>{ops.servers.length}</strong>
          <span>台服务器</span>
        </div>
        <button className="ops-upcoming-metric" onClick={showSoon}>
          <strong>{soonCount}</strong>
          <span>台即将到期</span>
        </button>
      </div>
      <div className="ops-toolbar">
        <label className="ops-search">
          <Search size={15} />
          <input
            aria-label={isProduct ? "搜索运维资产" : "搜索服务器"}
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder={
              isProduct ? "搜索产品、服务器、域名…" : "搜索服务器、IP、产品…"
            }
          />
        </label>
        <select
          aria-label="筛选状态"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">所有状态</option>
          {Object.entries(STATUS).map(([value, title]) => (
            <option value={value} key={value}>
              {title}
            </option>
          ))}
        </select>
        <select
          aria-label="筛选环境"
          value={environment}
          onChange={(event) => setEnvironment(event.target.value)}
        >
          <option value="">所有环境</option>
          {Object.entries(ENVIRONMENT).map(([value, title]) => (
            <option value={value} key={value}>
              {title}
            </option>
          ))}
        </select>
        <span className="ops-toolbar-spacer" />
        <label className="ops-sort">
          <ArrowUpDown size={13} />
          <select
            aria-label="排序方式"
            value={sort}
            onChange={(event) => setSort(event.target.value)}
          >
            <option value="default">默认排序</option>
            <option value="deadline">到期时间优先</option>
            <option value="name">名称排序</option>
          </select>
        </label>
        <div className="ops-view-switch" role="group" aria-label="列表布局">
          <button
            aria-label="表格视图"
            aria-pressed={layout === "table"}
            onClick={() => setLayout("table")}
          >
            <List size={15} />
          </button>
          <button
            aria-label="卡片视图"
            aria-pressed={layout === "cards"}
            onClick={() => setLayout("cards")}
          >
            <LayoutGrid size={15} />
          </button>
        </div>
      </div>
      {soonOnly && (
        <div className="ops-filter-note">
          未来 7 天内到期的服务器
          <button
            className="ops-icon-button"
            aria-label="清除到期筛选"
            onClick={resetFilters}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {!rows.length ? (
        <div className="ops-empty">
          <Search size={23} />
          <h2>
            {allRecords.length ? `没有匹配的${label}` : `还没有${label}记录`}
          </h2>
          <button
            className="ops-quiet"
            disabled={!allRecords.length && readOnly}
            onClick={allRecords.length ? resetFilters : () => openForm(type)}
          >
            {allRecords.length ? "清除筛选" : `新增${label}`}
          </button>
        </div>
      ) : layout === "table" ? (
        <div className="ops-table-wrap">
          <table className={`ops-table ${isProduct ? "products" : "servers"}`}>
            <thead>
              <tr>
                <th className="ops-name-column">{label}名称</th>
                <th className="ops-resource-column">
                  {isProduct ? "关联服务器" : "服务商 / 地区"}
                </th>
                <th className="ops-environment-column">环境</th>
                <th className="ops-date-column">到期时间</th>
                <th className="ops-status-column">状态</th>
                <th className="ops-actions-column">
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((record) => (
                <tr
                  className={`ops-record ${isProduct ? "product" : "server"}`}
                  key={record.id}
                  data-status={record.status}
                >
                  <td>{name(record)}</td>
                  <td className="ops-resource-cell">{resources(record)}</td>
                  <td className="ops-environment-cell">
                    {environmentTags(record)}
                  </td>
                  <td className="ops-date-cell">{dates(record)}</td>
                  <td className="ops-status-cell">{statusBadge(record)}</td>
                  <td>{actions(record)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="ops-card-grid">
          {rows.map((record) => (
            <article
              className={`ops-record ops-asset-card ${isProduct ? "product" : "server"}`}
              key={record.id}
              data-status={record.status}
            >
              <div className="ops-card-header">
                {statusBadge(record)}
                {actions(record)}
              </div>
              {name(record)}
              <div className="ops-card-resources">
                {resources(record)}
                {environmentTags(record)}
              </div>
              <div className="ops-card-dates">{dates(record)}</div>
            </article>
          ))}
        </div>
      )}
      <div className="ops-list-footer">
        <span>
          共 {rows.length} {isProduct ? "个产品" : "台服务器"}
          {(keyword || status || environment || soonOnly) && " · 已筛选"}
        </span>
        <span>到期时间来自服务器</span>
      </div>
    </>
  );
}
