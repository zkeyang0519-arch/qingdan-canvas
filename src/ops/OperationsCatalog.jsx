import React, { useMemo, useState } from "react";
import {
  ArrowLeft,
  Boxes,
  Check,
  ChevronDown,
  CircleAlert,
  ClipboardCheck,
  Package,
  Plus,
  Search,
  Server,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import {
  addDeployment,
  addOpsTask,
  addProduct,
  addServer,
  deleteProduct,
  deleteServer,
  filterProducts,
  filterServers,
  groupDeploymentsByRole,
  loadOpsState,
  saveOpsState,
  toggleOpsTask,
  updateProduct,
  updateServer,
} from "./model.js";

const STATUS_LABELS = { running: "运行中", maintenance: "维护中", retired: "已停用" };
const ENVIRONMENT_LABELS = { production: "生产", staging: "测试", development: "开发" };
const STATUS_OPTIONS = Object.entries(STATUS_LABELS);
const ENVIRONMENT_OPTIONS = Object.entries(ENVIRONMENT_LABELS);

function selectOptions(entries) {
  return entries.map(([value, label]) => <option key={value} value={value}>{label}</option>);
}

function recordTasks(state, targetType, targetId) {
  const deploymentIds = state.deployments
    .filter(item => targetType === "product" ? item.productId === targetId : item.serverId === targetId)
    .map(item => item.id);
  return state.tasks.filter(task => (
    (task.targetType === targetType && task.targetId === targetId) ||
    (task.targetType === "deployment" && deploymentIds.includes(task.targetId))
  ));
}

function displayDate(value) {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未记录";
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function FormField({ label, name, value, onChange, required = false, placeholder, children }) {
  const inputProps = onChange
    ? { value: value ?? "", onChange }
    : { defaultValue: value ?? "" };
  return (
    <label className="ops-field">
      <span>{label}{required ? " *" : ""}</span>
      {children || <input name={name} {...inputProps} placeholder={placeholder} required={required} />}
    </label>
  );
}

function EmptyState({ icon: Icon, title, description, action, disabled }) {
  return (
    <div className="ops-empty">
      <span className="ops-empty-icon"><Icon size={22} /></span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action && <button className="ops-primary" onClick={action.onClick} disabled={disabled}><Plus size={14} />{action.label || "新增记录"}</button>}
    </div>
  );
}

export default function OperationsCatalog({ onClose, readOnly = false }) {
  const [loaded] = useState(() => loadOpsState());
  const [ops, setOps] = useState(loaded.state);
  const [loadError, setLoadError] = useState(loaded.error);
  const [view, setView] = useState("products");
  const [selectedProductId, setSelectedProductId] = useState(null);
  const [selectedServerId, setSelectedServerId] = useState(null);
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState("");
  const [environment, setEnvironment] = useState("");
  const [form, setForm] = useState(null);
  const [formError, setFormError] = useState("");

  const commit = next => {
    setOps(next);
    const saved = saveOpsState(next);
    if (!saved.ok) setLoadError(saved.error);
    else setLoadError("");
  };

  const confirmDelete = (type, record) => {
    if (readOnly) return;
    const label = type === "product" ? "产品" : "服务器";
    if (typeof window.confirm === "function" && !window.confirm(`确定删除${label}“${record.name}”吗？关联的部署关系和运维待办也会删除。`)) return;
    try {
      commit(type === "product" ? deleteProduct(ops, record.id) : deleteServer(ops, record.id));
      setForm(null);
      setFormError("");
      if (type === "product") setSelectedProductId(null);
      else setSelectedServerId(null);
    } catch (error) {
      setLoadError(error.message);
    }
  };

  const products = useMemo(
    () => filterProducts(ops, { keyword, status: status || undefined, environment: environment || undefined }),
    [ops, keyword, status, environment],
  );
  const servers = useMemo(
    () => filterServers(ops, { keyword, status: status || undefined, environment: environment || undefined }),
    [ops, keyword, status, environment],
  );
  const selectedProduct = ops.products.find(item => item.id === selectedProductId);
  const selectedServer = ops.servers.find(item => item.id === selectedServerId);

  const resetFilters = () => {
    setKeyword("");
    setStatus("");
    setEnvironment("");
  };
  const openForm = (type, targetId = null) => {
    if (readOnly) return;
    setFormError("");
    setForm({ type, targetId });
  };
  const closeForm = () => {
    setForm(null);
    setFormError("");
  };
  const submitForm = event => {
    event.preventDefault();
    const data = Object.fromEntries(new window.FormData(event.currentTarget).entries());
    try {
      let next = ops;
      if (form.type === "product") {
        const input = {
          name: data["product-name"],
          summary: data["product-summary"],
          owner: data.owner,
          tags: data.tags ? data.tags.split(",").map(value => value.trim()).filter(Boolean) : [],
          status: data.status,
        };
        next = form.targetId ? updateProduct(ops, form.targetId, input) : addProduct(ops, input);
        setSelectedProductId(form.targetId || null);
        setSelectedServerId(null);
      } else if (form.type === "server") {
        const input = { ...data, name: data["server-name"] };
        next = form.targetId ? updateServer(ops, form.targetId, input) : addServer(ops, input);
        setSelectedServerId(form.targetId || null);
        setSelectedProductId(null);
      } else if (form.type === "deployment") {
        next = addDeployment(ops, data);
      } else if (form.type === "task") {
        next = addOpsTask(ops, {
          text: data.text,
          targetType: data.targetType,
          targetId: data.targetId,
        });
      }
      commit(next);
      closeForm();
    } catch (error) {
      setFormError(error.message);
    }
  };

  const goProducts = () => {
    setView("products");
    setSelectedServerId(null);
    resetFilters();
  };
  const goServers = () => {
    setView("servers");
    setSelectedProductId(null);
    resetFilters();
  };
  const toggleTask = task => {
    if (readOnly) return;
    try { commit(toggleOpsTask(ops, task.id)); } catch (error) { setLoadError(error.message); }
  };

  const renderTaskList = (targetType, targetId) => {
    const tasks = recordTasks(ops, targetType, targetId);
    return (
      <section className="ops-section">
        <div className="ops-section-head"><h2>关联待办</h2><button className="ops-quiet" onClick={() => openForm("task")} disabled={readOnly}><Plus size={13} />新建待办</button></div>
        {tasks.length === 0 ? <div className="ops-inline-empty">还没有关联待办。</div> : <div className="ops-task-list">{tasks.map(task => (
          <div className={`ops-task ${task.completed ? "is-done" : ""}`} key={task.id}>
            <button className="ops-check" aria-label={`${task.completed ? "取消完成" : "完成"}待办：${task.text}`} onClick={() => toggleTask(task)} disabled={readOnly}>{task.completed && <Check size={12} />}</button>
            <span>{task.text}</span>
            <small>{displayDate(task.createdAt)}</small>
          </div>
        ))}</div>}
      </section>
    );
  };

  const renderProductDetail = () => {
    if (!selectedProduct) return null;
    const groups = groupDeploymentsByRole(ops, selectedProduct.id);
    return (
      <>
        <div className="ops-detail-top"><button className="ops-back" aria-label="返回产品目录" onClick={() => setSelectedProductId(null)}><ArrowLeft size={14} />产品目录</button><div className="ops-detail-actions"><button className="ops-danger" aria-label={`删除产品：${selectedProduct.name}`} onClick={() => confirmDelete("product", selectedProduct)} disabled={readOnly}><Trash2 size={13} />删除</button><button onClick={() => openForm("product", selectedProduct.id)} disabled={readOnly}>编辑</button><button className="ops-primary" aria-label="新增部署" onClick={() => openForm("deployment")} disabled={readOnly}><Plus size={13} />新增部署</button></div></div>
        <div className="ops-detail-card ops-identity"><span className="ops-record-icon">{selectedProduct.name.slice(0, 1)}</span><div className="ops-grow"><h1>{selectedProduct.name}</h1><p>{selectedProduct.summary || "暂无产品说明"}</p></div><span className={`ops-status ${selectedProduct.status}`}><i />{STATUS_LABELS[selectedProduct.status]}</span></div>
        <div className="ops-fields-grid"><div><small>负责人</small><strong>{selectedProduct.owner || "未指定"}</strong></div><div><small>最近更新</small><strong>{displayDate(selectedProduct.updatedAt)}</strong></div></div>
        <section className="ops-section"><div className="ops-section-head"><h2>运行位置</h2><span>{ops.deployments.filter(item => item.productId === selectedProduct.id).length} 个部署关系</span></div>
          {groups.length === 0 ? <div className="ops-inline-empty">还没有部署关系，可以先新增一台服务器或添加部署。</div> : <div className="ops-role-groups">{groups.map(group => <div className="ops-role-group" key={group.role}><div className="ops-role-title"><span>{group.role}</span><small>{group.items.length} 个</small></div>{group.items.map(({ deployment, server }) => <div className="ops-deployment-row" key={deployment.id}><strong>{server?.name || "未知服务器"}</strong><span>{server?.provider || "未记录提供商"} · {server?.region || "未记录地域"}{deployment.version ? ` · ${deployment.version}` : ""}</span><em>{ENVIRONMENT_LABELS[deployment.environment]}</em></div>)}</div>)}</div>}
        </section>
        {renderTaskList("product", selectedProduct.id)}
        <section className="ops-section"><div className="ops-section-head"><h2>标签与链接</h2><span>{selectedProduct.tags.length ? selectedProduct.tags.join(" · ") : "暂无标签"}</span></div><div className="ops-link-pills"><span>部署文档</span><span>监控面板</span><span>域名</span></div></section>
      </>
    );
  };

  const renderServerDetail = () => {
    if (!selectedServer) return null;
    const deployments = ops.deployments.filter(item => item.serverId === selectedServer.id);
    return (
      <>
        <div className="ops-detail-top"><button className="ops-back" aria-label="返回服务器台账" onClick={() => setSelectedServerId(null)}><ArrowLeft size={14} />服务器台账</button><div className="ops-detail-actions"><button className="ops-danger" aria-label={`删除服务器：${selectedServer.name}`} onClick={() => confirmDelete("server", selectedServer)} disabled={readOnly}><Trash2 size={13} />删除</button><button onClick={() => openForm("server", selectedServer.id)} disabled={readOnly}>编辑</button></div></div>
        <div className="ops-detail-card ops-identity"><span className="ops-record-icon server"><Server size={18} /></span><div className="ops-grow"><h1>{selectedServer.name}</h1><p>{[selectedServer.provider, selectedServer.region, selectedServer.system].filter(Boolean).join(" · ") || "暂无服务器说明"}</p></div><span className={`ops-status ${selectedServer.status}`} aria-label={`服务器状态：${STATUS_LABELS[selectedServer.status]}`}><i />{STATUS_LABELS[selectedServer.status]}</span></div>
        <div className="ops-fields-grid"><div><small>环境</small><strong>{ENVIRONMENT_LABELS[selectedServer.environment] || "多环境"}</strong></div><div><small>地址</small><strong>{selectedServer.address || "未记录"}</strong></div></div>
        <section className="ops-section"><div className="ops-section-head"><h2>承载产品</h2><span>{deployments.length} 个部署关系</span></div>{deployments.length === 0 ? <div className="ops-inline-empty">还没有产品部署在这台服务器上。</div> : <div className="ops-server-products">{deployments.map(deployment => { const product = ops.products.find(item => item.id === deployment.productId); return <button key={deployment.id} onClick={() => { setSelectedServerId(null); setSelectedProductId(product?.id || null); setView("products"); }}><span>{product?.name || "未知产品"}</span><small>{deployment.role || "未分类"} · {ENVIRONMENT_LABELS[deployment.environment]}</small></button>; })}</div>}</section>
        {renderTaskList("server", selectedServer.id)}
      </>
    );
  };

  const renderProductDirectory = () => (
    <>
      <div className="ops-page-title"><div><p className="ops-breadcrumb">运维资产 / 产品目录</p><h1>产品目录</h1><p>产品、负责人和部署关系集中在一处。</p></div><button className="ops-primary" aria-label="新增产品" onClick={() => openForm("product")} disabled={readOnly}><Plus size={14} />新增产品</button></div>
      <div className="ops-metrics"><div><strong>{ops.products.length}</strong><span>产品</span></div><div><strong>{ops.servers.length}</strong><span>服务器</span></div><div><strong>{ops.tasks.filter(task => !task.completed).length}</strong><span>待处理</span></div></div>
      <div className="ops-toolbar"><label className="ops-search"><Search size={14} /><input aria-label="搜索运维资产" value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="搜索产品、服务器、域名..." /></label><label><span className="sr-only">状态</span><select value={status} onChange={event => setStatus(event.target.value)}><option value="">所有状态</option>{selectOptions(STATUS_OPTIONS)}</select></label><label><span className="sr-only">环境</span><select value={environment} onChange={event => setEnvironment(event.target.value)}><option value="">所有环境</option>{selectOptions(ENVIRONMENT_OPTIONS)}</select></label></div>
      {products.length === 0 ? <EmptyState icon={Package} title={ops.products.length ? "没有匹配的产品" : "还没有产品记录"} description={ops.products.length ? "换一个关键词或清除筛选条件。" : "先记录一个产品，再补充它运行在哪些服务器上。"} action={ops.products.length ? { label: "清除筛选", onClick: resetFilters } : { label: "新增产品", onClick: () => openForm("product") }} disabled={readOnly} /> : <div className="ops-record-list">{products.map(product => { const serverNames = [...new Set(ops.deployments.filter(item => item.productId === product.id).map(item => ops.servers.find(server => server.id === item.serverId)?.name).filter(Boolean))]; return <div className="ops-record" key={product.id}><button className="ops-record-open" aria-label={`打开产品：${product.name}`} onClick={() => setSelectedProductId(product.id)}><span className="ops-record-icon">{product.name.slice(0, 1)}</span><span className="ops-record-main"><strong>{product.name}</strong><small>{product.summary || "暂无产品说明"}</small><span className="ops-pills">{product.tags.map(tag => <em key={tag}>{tag}</em>)}{serverNames.length ? serverNames.map(serverName => <em key={serverName}>{serverName}</em>) : <em>未关联服务器</em>}</span></span><span className={`ops-status ${product.status}`}><i />{STATUS_LABELS[product.status]}</span></button><button className="ops-record-delete" aria-label={`删除产品：${product.name}`} onClick={() => confirmDelete("product", product)} disabled={readOnly}><Trash2 size={14} /></button></div>; })}</div>}
    </>
  );

  const renderServerDirectory = () => (
    <>
      <div className="ops-page-title"><div><p className="ops-breadcrumb">运维资产 / 服务器台账</p><h1>服务器台账</h1><p>盘点服务器，并反向查看它承载的产品。</p></div><button className="ops-primary" aria-label="新增服务器" onClick={() => openForm("server")} disabled={readOnly}><Plus size={14} />新增服务器</button></div>
      <div className="ops-metrics"><div><strong>{ops.servers.length}</strong><span>服务器</span></div><div><strong>{ops.servers.filter(item => item.status === "running").length}</strong><span>运行中</span></div><div><strong>{ops.servers.filter(item => item.status === "maintenance").length}</strong><span>维护中</span></div></div>
      <div className="ops-toolbar"><label className="ops-search"><Search size={14} /><input aria-label="搜索服务器" value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="搜索服务器、IP、产品..." /></label><label><span className="sr-only">状态</span><select value={status} onChange={event => setStatus(event.target.value)}><option value="">所有状态</option>{selectOptions(STATUS_OPTIONS)}</select></label><label><span className="sr-only">环境</span><select value={environment} onChange={event => setEnvironment(event.target.value)}><option value="">所有环境</option>{selectOptions(ENVIRONMENT_OPTIONS)}</select></label></div>
      {servers.length === 0 ? <EmptyState icon={Server} title={ops.servers.length ? "没有匹配的服务器" : "还没有服务器记录"} description={ops.servers.length ? "换一个关键词或清除筛选条件。" : "先记录服务器，再从产品详情中添加部署关系。"} action={ops.servers.length ? { label: "清除筛选", onClick: resetFilters } : { label: "新增服务器", onClick: () => openForm("server") }} disabled={readOnly} /> : <div className="ops-record-list">{servers.map(server => { const hosted = ops.deployments.filter(item => item.serverId === server.id).map(item => ops.products.find(product => item.productId === product.id)).filter(Boolean); return <div className="ops-record server" key={server.id}><button className="ops-record-open" aria-label={`打开服务器：${server.name}`} onClick={() => setSelectedServerId(server.id)}><span className={`ops-status ${server.status}`} aria-label={`服务器状态：${STATUS_LABELS[server.status]}`}><i />{STATUS_LABELS[server.status]}</span><span className="ops-record-main"><strong>{server.name}</strong><small>{[server.provider, server.region, server.system].filter(Boolean).join(" · ") || "暂无服务器说明"}</small><span className="ops-pills"><em>{ENVIRONMENT_LABELS[server.environment] || "多环境"}</em>{hosted.map(product => <em key={product.id}>{product.name}</em>)}</span></span><span className="ops-record-count">{hosted.length} 个产品<br /><small>{displayDate(server.updatedAt)}</small></span></button><button className="ops-record-delete" aria-label={`删除服务器：${server.name}`} onClick={() => confirmDelete("server", server)} disabled={readOnly}><Trash2 size={14} /></button></div>; })}</div>}
    </>
  );

  const renderForm = () => {
    if (!form) return null;
    const editing = form.targetId;
    const product = form.type === "product" && (editing ? ops.products.find(item => item.id === editing) : null);
    const server = form.type === "server" && (editing ? ops.servers.find(item => item.id === editing) : null);
    if (form.type === "task") {
      const targetType = selectedServerId ? "server" : "product";
      const targetId = selectedServerId || selectedProductId;
      return <div className="ops-modal-backdrop" role="presentation"><form className="ops-modal" onSubmit={submitForm}><div className="ops-modal-head"><h2>新建待办</h2><button type="button" aria-label="关闭表单" onClick={closeForm}><X size={16} /></button></div><input type="hidden" name="targetType" value={targetType} /><input type="hidden" name="targetId" value={targetId || ""} /><FormField label="待办内容" name="text" required placeholder="例如：续期 prod-api-01 证书" /><p className="ops-form-hint">待办会关联到当前打开的{targetType === "server" ? "服务器" : "产品"}。</p>{formError && <div className="ops-form-error"><CircleAlert size={14} />{formError}</div>}<div className="ops-modal-actions"><button type="button" onClick={closeForm}>取消</button><button className="ops-primary" type="submit">保存待办</button></div></form></div>;
    }
    if (form.type === "deployment") {
      const product = selectedProduct;
      return <div className="ops-modal-backdrop" role="presentation"><form className="ops-modal" onSubmit={submitForm}><div className="ops-modal-head"><h2>新增部署关系</h2><button type="button" aria-label="关闭表单" onClick={closeForm}><X size={16} /></button></div><p className="ops-form-hint">产品：{product?.name || "当前产品"}</p><input type="hidden" name="productId" value={product?.id || ""} /><FormField label="服务器" name="serverId" required><select name="serverId" defaultValue=""><option value="">选择服务器</option>{ops.servers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></FormField><FormField label="环境" name="environment" required><select name="environment" defaultValue="production">{selectOptions(ENVIRONMENT_OPTIONS)}</select></FormField><FormField label="角色" name="role" placeholder="例如 API、数据库、应用" /><FormField label="版本" name="version" placeholder="可选" />{formError && <div className="ops-form-error"><CircleAlert size={14} />{formError}</div>}<div className="ops-modal-actions"><button type="button" onClick={closeForm}>取消</button><button className="ops-primary" type="submit">保存部署</button></div></form></div>;
    }
    const isProduct = form.type === "product";
    const record = isProduct ? product : server;
    return <div className="ops-modal-backdrop" role="presentation"><form className="ops-modal" onSubmit={submitForm}><div className="ops-modal-head"><h2>{editing ? "编辑" : "新增"}{isProduct ? "产品" : "服务器"}</h2><button type="button" aria-label="关闭表单" onClick={closeForm}><X size={16} /></button></div><FormField label={isProduct ? "产品名称" : "服务器名称"} name={isProduct ? "product-name" : "server-name"} value={record?.name || undefined} onChange={undefined} required placeholder={isProduct ? "例如 轻单" : "例如 prod-api-01"} />{isProduct ? <><FormField label="产品说明" name="product-summary" value={record?.summary || undefined} placeholder="一句话说明它是什么" /><FormField label="负责人" name="owner" value={record?.owner || undefined} placeholder="可选" /><FormField label="标签" name="tags" value={record?.tags?.join(", ") || undefined} placeholder="用逗号分隔" /></> : <><FormField label="提供商" name="provider" value={record?.provider || undefined} placeholder="例如 阿里云" /><FormField label="地域" name="region" value={record?.region || undefined} placeholder="例如 杭州" /><FormField label="地址" name="address" value={record?.address || undefined} placeholder="IP、域名或控制台地址" /><FormField label="系统" name="system" value={record?.system || undefined} placeholder="例如 Ubuntu 24.04" /><FormField label="默认环境" name="environment"><select name="environment" defaultValue={record?.environment || ""}><option value="">未指定</option>{selectOptions(ENVIRONMENT_OPTIONS)}</select></FormField><FormField label="服务器状态" name="status"><select name="status" aria-label="服务器状态" defaultValue={record?.status || "running"}>{selectOptions(STATUS_OPTIONS)}</select></FormField></>}{formError && <div className="ops-form-error"><CircleAlert size={14} />{formError}</div>}<div className="ops-modal-actions"><button type="button" onClick={closeForm}>取消</button><button className="ops-primary" type="submit">保存{isProduct ? "产品" : "服务器"}</button></div></form></div>;
  };

  return (
    <div className="operations-overlay" role="dialog" aria-label="运维资产" onKeyDown={event => { if (event.key === "Escape") onClose?.(); }}>
      <div className="ops-app">
        <header className="ops-header"><div className="ops-brand"><span className="ops-brand-mark">轻</span><strong>轻单</strong><span>/ 运维资产</span></div><label className="ops-global-search"><Search size={15} /><input aria-label="搜索运维资产" value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="搜索产品、服务器、域名..." /></label><button className="ops-close" aria-label="关闭运维资产" onClick={onClose}><X size={17} /></button></header>
        <div className="ops-layout">
          <aside className="ops-sidebar"><p className="ops-sidebar-label">目录</p><button aria-label="产品目录" className={view === "products" && !selectedProductId ? "active" : ""} onClick={goProducts}><Boxes size={14} />产品目录 <span>{ops.products.length}</span></button><button aria-label="服务器台账" className={view === "servers" && !selectedServerId ? "active" : ""} onClick={goServers}><Server size={14} />服务器台账 <span>{ops.servers.length}</span></button><button disabled><ClipboardCheck size={14} />维护记录</button><p className="ops-sidebar-label second">状态</p>{STATUS_OPTIONS.map(([value, label]) => <span className="ops-sidebar-stat" key={value}><i className={`ops-mini-dot ${value}`} />{label}<b>{ops.products.filter(item => item.status === value).length}</b></span>)}</aside>
          <main className="ops-main">{loadError && <div className="ops-banner"><CircleAlert size={14} />{loadError}</div>}{selectedProduct ? renderProductDetail() : selectedServer ? renderServerDetail() : view === "products" ? renderProductDirectory() : renderServerDirectory()}</main>
        </div>
        {renderForm()}
      </div>
    </div>
  );
}
