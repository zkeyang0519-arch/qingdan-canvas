import React, { useMemo, useState } from "react";
import { Boxes, Network, Plus, Search, Server } from "lucide-react";
import { filterDeploymentMap } from "./model.js";
import "./operations-map.css";

const STATUS = { running: "运行中", maintenance: "维护中", retired: "已停用" };
const ENVIRONMENT = {
  production: "生产",
  staging: "测试",
  development: "开发",
};
const GRAPH_WIDTH = 1000;
const TOP = 82;
const ASSET_STEP = 88;
const DEPLOYMENT_STEP = 50;
const TRACKS = {
  product: { left: 44, right: 310 },
  deployment: { left: 404, right: 596 },
  server: { left: 690, right: 956 },
};

function connect(start, startY, end, endY) {
  const bend = (end - start) * 0.55;
  return `M ${start} ${startY} C ${start + bend} ${startY}, ${end - bend} ${endY}, ${end} ${endY}`;
}

function layoutMap({ products, servers, deployments }) {
  const byProduct = new Map(products.map((product) => [product.id, []]));
  for (const link of deployments) byProduct.get(link.product.id).push(link);

  const productPositions = new Map();
  const deploymentPositions = new Map();
  const firstServerLink = new Map();
  let top = TOP;
  for (const product of products) {
    const links = byProduct.get(product.id);
    const groupSpan = Math.max(0, links.length - 1) * DEPLOYMENT_STEP;
    productPositions.set(product.id, top + groupSpan / 2);
    links.forEach(({ deployment, server }, index) => {
      const y = top + index * DEPLOYMENT_STEP;
      deploymentPositions.set(deployment.id, y);
      if (!firstServerLink.has(server.id)) firstServerLink.set(server.id, y);
    });
    top += groupSpan + ASSET_STEP;
  }

  const orderedServers = [...servers].sort(
    (left, right) =>
      (firstServerLink.get(left.id) ?? Infinity) -
        (firstServerLink.get(right.id) ?? Infinity) || 0,
  );
  const serverPositions = new Map();
  let lastServerY = TOP - ASSET_STEP;
  for (const server of orderedServers) {
    const y = Math.max(
      firstServerLink.get(server.id) ?? TOP,
      lastServerY + ASSET_STEP,
    );
    serverPositions.set(server.id, y);
    lastServerY = y;
  }
  return {
    byProduct,
    productPositions,
    deploymentPositions,
    serverPositions,
    orderedServers,
    unlinkedServers: orderedServers.filter(
      (server) => !firstServerLink.has(server.id),
    ),
    height: Math.max(320, top - ASSET_STEP + 65, lastServerY + 65),
  };
}

function AssetNode({ type, record, position, active, onOpen, onHighlight }) {
  const isProduct = type === "product";
  const description = isProduct
    ? record.summary
    : [record.provider, record.region].filter(Boolean).join(" · ") ||
      record.address;
  const label = `打开${isProduct ? "产品" : "服务器"}：${record.name}`;
  return (
    <button
      type="button"
      className={`ops-map-node ${type}`}
      style={position === undefined ? undefined : { top: position }}
      aria-label={label}
      title={record.name}
      data-active={active || undefined}
      onClick={(event) => onOpen(type, record.id, event.currentTarget)}
      onFocus={() => onHighlight?.()}
      onBlur={() => onHighlight?.(false)}
      onPointerEnter={() => onHighlight?.()}
      onPointerLeave={() => onHighlight?.(false)}
    >
      <span className="ops-map-icon" aria-hidden="true">
        {isProduct ? record.name.slice(0, 1) : <Server size={18} />}
      </span>
      <span className="ops-map-node-copy">
        <strong>{record.name}</strong>
        <small>
          <i className={`ops-mini-dot ${record.status}`} />
          {STATUS[record.status]}
          {description && ` · ${description}`}
        </small>
      </span>
    </button>
  );
}

function DeploymentNode({ link, position, active, onOpen, onHighlight }) {
  const { deployment, product, server } = link;
  const role = deployment.role || "未分类";
  const environment = ENVIRONMENT[deployment.environment];
  const label = `打开部署：${product.name} / ${environment} / ${role} / ${server.name}`;
  return (
    <button
      type="button"
      className="ops-map-node deployment"
      style={position === undefined ? undefined : { top: position }}
      aria-label={label}
      title={`${environment} / ${role}`}
      data-active={active || undefined}
      onClick={(event) =>
        onOpen("deployment", deployment.id, event.currentTarget)
      }
      onFocus={() => onHighlight?.()}
      onBlur={() => onHighlight?.(false)}
      onPointerEnter={() => onHighlight?.()}
      onPointerLeave={() => onHighlight?.(false)}
    >
      {environment} / {role}
    </button>
  );
}

export default function OperationsMap({
  ops,
  keyword,
  setKeyword,
  status,
  setStatus,
  environment,
  setEnvironment,
  resetFilters,
  readOnly,
  onOpen,
  openForm,
}) {
  const [highlight, setHighlight] = useState(null);
  const map = useMemo(
    () => filterDeploymentMap(ops, { keyword, status, environment }),
    [ops, keyword, status, environment],
  );
  const layout = useMemo(() => layoutMap(map), [map]);
  const hasAssets = ops.products.length > 0 || ops.servers.length > 0;
  const hasResults = map.products.length > 0 || map.servers.length > 0;
  const canDeploy = ops.products.length > 0 && ops.servers.length > 0;
  const lit =
    highlight &&
    map.deployments.filter(
      ({ deployment, product, server }) =>
        ({ product, server, deployment })[highlight.type].id === highlight.id,
    );
  const isHighlighted = (type, id) =>
    (highlight?.type === type && highlight.id === id) ||
    lit?.some((link) => link[type].id === id);
  const highlightNode =
    (type, id) =>
    (active = true) =>
      setHighlight(active ? { type, id } : null);

  return (
    <>
      <div className="ops-page-title ops-map-title">
        <h1>部署地图</h1>
        <div className="ops-page-actions ops-map-actions">
          <button
            className="ops-quiet"
            aria-label="新增产品"
            disabled={readOnly}
            onClick={() => openForm("product")}
          >
            <Plus size={14} /> 新增产品
          </button>
          <button
            className="ops-quiet"
            aria-label="新增服务器"
            disabled={readOnly}
            onClick={() => openForm("server")}
          >
            <Plus size={14} /> 新增服务器
          </button>
          {canDeploy && (
            <button
              className="ops-primary"
              aria-label="新增部署"
              disabled={readOnly}
              onClick={() => openForm("deployment")}
            >
              <Plus size={14} /> 新增部署
            </button>
          )}
        </div>
      </div>
      <div className="ops-toolbar ops-map-toolbar">
        <label className="ops-search">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label="搜索运维资产"
            placeholder="搜索产品、服务器、域名或角色…"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
        </label>
        <select
          aria-label="筛选状态"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">所有状态</option>
          {Object.entries(STATUS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="筛选环境"
          value={environment}
          onChange={(event) => setEnvironment(event.target.value)}
        >
          <option value="">所有环境</option>
          {Object.entries(ENVIRONMENT).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {(keyword || status || environment) && (
          <button className="ops-quiet" onClick={resetFilters}>
            清除筛选
          </button>
        )}
      </div>
      {!hasResults ? (
        <div className="ops-map-empty" role="status">
          <Network size={23} aria-hidden="true" />
          <h2>{hasAssets ? "没有匹配的资产" : "还没有资产记录"}</h2>
          {!hasAssets && <p>新增产品和服务器后，即可建立部署关系。</p>}
        </div>
      ) : (
        <>
          <section
            className="ops-map-graph"
            aria-label="部署关系图"
            style={{ height: layout.height }}
          >
            <div className="ops-map-column-labels" aria-hidden="true">
              <span>
                产品 <small>{map.products.length}</small>
              </span>
              <span>
                部署角色 <small>{map.deployments.length}</small>
              </span>
              <span>
                服务器 <small>{map.servers.length}</small>
              </span>
            </div>
            <svg
              viewBox={`0 0 ${GRAPH_WIDTH} ${layout.height}`}
              preserveAspectRatio="none"
              aria-hidden="true"
              className="ops-map-lines"
            >
              {map.deployments.map(({ deployment, product, server }) => {
                const y = layout.deploymentPositions.get(deployment.id);
                const left = connect(
                  TRACKS.product.right,
                  layout.productPositions.get(product.id),
                  TRACKS.deployment.left,
                  y,
                );
                const right = connect(
                  TRACKS.deployment.right,
                  y,
                  TRACKS.server.left,
                  layout.serverPositions.get(server.id),
                );
                return (
                  <path
                    key={deployment.id}
                    d={`${left} ${right}`}
                    data-active={
                      isHighlighted("deployment", deployment.id) || undefined
                    }
                  />
                );
              })}
            </svg>
            {map.products.map((product) => (
              <AssetNode
                key={product.id}
                type="product"
                record={product}
                position={layout.productPositions.get(product.id)}
                active={isHighlighted("product", product.id)}
                onOpen={onOpen}
                onHighlight={highlightNode("product", product.id)}
              />
            ))}
            {map.deployments.map((link) => (
              <DeploymentNode
                key={link.deployment.id}
                link={link}
                position={layout.deploymentPositions.get(link.deployment.id)}
                active={isHighlighted("deployment", link.deployment.id)}
                onOpen={onOpen}
                onHighlight={highlightNode("deployment", link.deployment.id)}
              />
            ))}
            {layout.orderedServers.map((server) => (
              <AssetNode
                key={server.id}
                type="server"
                record={server}
                position={layout.serverPositions.get(server.id)}
                active={isHighlighted("server", server.id)}
                onOpen={onOpen}
                onHighlight={highlightNode("server", server.id)}
              />
            ))}
          </section>
          <section className="ops-map-stacked" aria-label="部署关系列表">
            {map.products.map((product) => (
              <article key={product.id} className="ops-map-stack-group">
                <AssetNode type="product" record={product} onOpen={onOpen} />
                {layout.byProduct.get(product.id).map((link) => (
                  <div className="ops-map-stack-link" key={link.deployment.id}>
                    <DeploymentNode link={link} onOpen={onOpen} />
                    <AssetNode
                      type="server"
                      record={link.server}
                      onOpen={onOpen}
                    />
                  </div>
                ))}
              </article>
            ))}
            {layout.unlinkedServers.length > 0 && (
              <section className="ops-map-stack-group">
                <h2>其他服务器</h2>
                {layout.unlinkedServers.map((server) => (
                  <AssetNode
                    key={server.id}
                    type="server"
                    record={server}
                    onOpen={onOpen}
                  />
                ))}
              </section>
            )}
          </section>
          <div className="ops-map-legend">
            <span>
              <Boxes size={13} /> {map.products.length} 个产品
            </span>
            <span>
              <Network size={13} /> {map.deployments.length} 条部署关系
            </span>
            <span>
              <Server size={13} /> {map.servers.length} 台服务器
            </span>
          </div>
        </>
      )}
    </>
  );
}
