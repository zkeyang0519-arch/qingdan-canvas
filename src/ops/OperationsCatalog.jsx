import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Boxes,
  Check,
  CircleAlert,
  Network,
  Plus,
  Server,
  Trash2,
  X,
} from "lucide-react";
import {
  addDeployment,
  addOpsTask,
  addProduct,
  addServer,
  deleteDeployment,
  deleteProduct,
  deleteServer,
  filterProducts,
  filterServers,
  groupDeploymentsByRole,
  loadOpsState,
  productServers,
  saveOpsState,
  toggleOpsTask,
  updateProduct,
  updateDeployment,
  updateServer,
} from "./model.js";
import { validDeadline } from "../../shared/deadline.js";
import { useDeadlineTimer } from "../canvas/TaskDeadline.jsx";
import ServerDeadline, {
  DeadlineDate,
  DeadlineRing,
} from "./ServerDeadline.jsx";
import OperationsDirectory, { isDueSoon } from "./OperationsDirectory.jsx";
import OperationsMap from "./OperationsMap.jsx";

const STATUS_LABELS = {
  running: "运行中",
  maintenance: "维护中",
  retired: "已停用",
};
const ENVIRONMENT_LABELS = {
  production: "生产",
  staging: "测试",
  development: "开发",
};
const STATUS_OPTIONS = Object.entries(STATUS_LABELS);
const ENVIRONMENT_OPTIONS = Object.entries(ENVIRONMENT_LABELS);

function selectOptions(entries) {
  return entries.map(([value, label]) => (
    <option key={value} value={value}>
      {label}
    </option>
  ));
}

function restoreFocus(target) {
  if (!target?.isConnected || target.closest?.("[inert]")) return false;
  target.focus?.({ preventScroll: true });
  return document.activeElement === target;
}

function recordTasks(state, targetType, targetId) {
  if (targetType === "deployment") {
    return state.tasks.filter(
      (task) => task.targetType === targetType && task.targetId === targetId,
    );
  }
  const deploymentIds = state.deployments
    .filter((item) =>
      targetType === "product"
        ? item.productId === targetId
        : item.serverId === targetId,
    )
    .map((item) => item.id);
  return state.tasks.filter(
    (task) =>
      (task.targetType === targetType && task.targetId === targetId) ||
      (task.targetType === "deployment" &&
        deploymentIds.includes(task.targetId)),
  );
}

function displayDate(value) {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未记录";
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function FormField({
  label,
  name,
  value,
  onChange,
  required = false,
  placeholder,
  children,
}) {
  const inputProps = onChange
    ? { value: value ?? "", onChange }
    : { defaultValue: value ?? "" };
  return (
    <label className="ops-field">
      <span>
        {label}
        {required ? " *" : ""}
      </span>
      {children || (
        <input
          name={name}
          {...inputProps}
          placeholder={placeholder}
          required={required}
        />
      )}
    </label>
  );
}

export default function OperationsCatalog({ onClose, readOnly = false }) {
  const [loaded] = useState(() => loadOpsState());
  const [ops, setOps] = useState(loaded.state);
  const [loadError, setLoadError] = useState(loaded.error);
  const [view, setView] = useState("map");
  const [selectedProductId, setSelectedProductId] = useState(null);
  const [selectedServerId, setSelectedServerId] = useState(null);
  const [selectedDeploymentId, setSelectedDeploymentId] = useState(null);
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState("");
  const [environment, setEnvironment] = useState("");
  const [soonOnly, setSoonOnly] = useState(false);
  const [form, setForm] = useState(null);
  const [formError, setFormError] = useState("");
  const [deadlineDraft, setDeadlineDraft] = useState({
    dueAt: null,
    dueStartAt: null,
  });
  const deadlines = useMemo(
    () =>
      ops.servers
        .filter((server) => validDeadline(server.dueAt))
        .map((server) => Date.parse(server.dueAt)),
    [ops.servers],
  );
  const now = useDeadlineTimer(deadlines);
  const drawerRef = useRef(null);
  const formLayerRef = useRef(null);
  const detailOpenerRef = useRef(null);
  const formOpenerRef = useRef(null);

  const commit = (next) => {
    const saved = saveOpsState(next);
    if (!saved.ok) {
      setLoadError(saved.error);
      return saved.error;
    }
    setOps(next);
    setLoadError("");
    return "";
  };

  const confirmDelete = (type, record) => {
    if (readOnly) return;
    const label = { product: "产品", server: "服务器", deployment: "部署关系" }[
      type
    ];
    const message =
      type === "deployment"
        ? "确定删除此部署关系吗？关联的运维待办也会删除。"
        : `确定删除${label}“${record.name}”吗？关联的部署关系和运维待办也会删除。`;
    if (typeof window.confirm === "function" && !window.confirm(message))
      return;
    try {
      const remove = {
        product: deleteProduct,
        server: deleteServer,
        deployment: deleteDeployment,
      }[type];
      if (commit(remove(ops, record.id))) return;
      setForm(null);
      setFormError("");
      closeDetails();
    } catch (error) {
      setLoadError(error.message);
    }
  };

  const products = useMemo(
    () =>
      filterProducts(ops, {
        keyword,
        status: status || undefined,
        environment: environment || undefined,
      }),
    [ops, keyword, status, environment],
  );
  const servers = useMemo(
    () =>
      filterServers(ops, {
        keyword,
        status: status || undefined,
        environment: environment || undefined,
      }).filter((server) => !soonOnly || isDueSoon(server, now)),
    [ops, keyword, status, environment, soonOnly, now],
  );
  const selectedProduct = ops.products.find(
    (item) => item.id === selectedProductId,
  );
  const selectedServer = ops.servers.find(
    (item) => item.id === selectedServerId,
  );
  const selectedDeployment = ops.deployments.find(
    (item) => item.id === selectedDeploymentId,
  );
  const hasDetail = Boolean(
    selectedProduct || selectedServer || selectedDeployment,
  );
  const detailLabel = selectedProduct
    ? "产品详情"
    : selectedServer
      ? "服务器详情"
      : "部署详情";
  const hasForm = Boolean(form);
  const soonCount = ops.servers.filter((server) =>
    isDueSoon(server, now),
  ).length;
  useEffect(() => {
    if (hasForm) return;
    if (hasDetail) {
      drawerRef.current
        ?.querySelector('button[aria-label="关闭资产详情"]')
        ?.focus({ preventScroll: true });
    } else if (detailOpenerRef.current) {
      if (!restoreFocus(detailOpenerRef.current))
        document
          .querySelector(".ops-main .ops-search input")
          ?.focus({ preventScroll: true });
      detailOpenerRef.current = null;
    }
  }, [
    hasDetail,
    selectedProductId,
    selectedServerId,
    selectedDeploymentId,
    hasForm,
  ]);

  useEffect(() => {
    if (hasForm) {
      const scope = formLayerRef.current;
      (
        scope?.querySelector('input:not([type="hidden"]),select,textarea') ||
        scope?.querySelector("button:not(:disabled)")
      )?.focus({ preventScroll: true });
    } else if (formOpenerRef.current) {
      if (!hasDetail || drawerRef.current?.contains(formOpenerRef.current))
        restoreFocus(formOpenerRef.current);
      formOpenerRef.current = null;
    }
  }, [hasForm, hasDetail]);

  useEffect(() => {
    const scope = hasForm
      ? formLayerRef.current?.querySelector(".ops-modal")
      : hasDetail
        ? drawerRef.current
        : null;
    if (!scope) return;
    const selector =
      'button:not(:disabled),input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]';
    const trapTab = (event) => {
      if (
        event.key !== "Tab" ||
        event.defaultPrevented ||
        event.target.closest?.(".task-deadline-popover, .ops-record-menu")
      )
        return;
      const items = [...scope.querySelectorAll(selector)];
      const first = items[0],
        last = items.at(-1);
      if (!scope.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", trapTab);
    return () => {
      document.removeEventListener("keydown", trapTab);
    };
  }, [hasDetail, hasForm]);

  const closeDetails = () => {
    setSelectedProductId(null);
    setSelectedServerId(null);
    setSelectedDeploymentId(null);
  };
  const openDetails = (type, id, opener = document.activeElement) => {
    if (!hasDetail) detailOpenerRef.current = opener;
    setSelectedProductId(type === "product" ? id : null);
    setSelectedServerId(type === "server" ? id : null);
    setSelectedDeploymentId(type === "deployment" ? id : null);
  };

  const resetFilters = () => {
    setKeyword("");
    setStatus("");
    setEnvironment("");
    setSoonOnly(false);
  };
  const openForm = (type, targetId = null, opener = document.activeElement) => {
    if (readOnly) return;
    formOpenerRef.current = opener;
    const server =
      type === "server"
        ? ops.servers.find((item) => item.id === targetId)
        : null;
    setDeadlineDraft({
      dueAt: server?.dueAt ?? null,
      dueStartAt: server?.dueStartAt ?? null,
    });
    setFormError("");
    setForm({ type, targetId });
  };
  const closeForm = () => {
    setForm(null);
    setFormError("");
  };
  const submitForm = (event) => {
    event.preventDefault();
    if (readOnly) return;
    const data = Object.fromEntries(
      new window.FormData(event.currentTarget).entries(),
    );
    try {
      let next = ops;
      if (form.type === "product") {
        const input = {
          name: data["product-name"],
          summary: data["product-summary"],
          owner: data.owner,
          tags: data.tags
            ? data.tags
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean)
            : [],
          status: data.status,
        };
        next = form.targetId
          ? updateProduct(ops, form.targetId, input)
          : addProduct(ops, input);
      } else if (form.type === "server") {
        const input = { ...data, ...deadlineDraft, name: data["server-name"] };
        next = form.targetId
          ? updateServer(ops, form.targetId, input)
          : addServer(ops, input);
      } else if (form.type === "deployment") {
        next = form.targetId
          ? updateDeployment(ops, form.targetId, data)
          : addDeployment(ops, data);
      } else if (form.type === "task") {
        next = addOpsTask(ops, {
          text: data.text,
          targetType: data.targetType,
          targetId: data.targetId,
        });
      }
      const saveError = commit(next);
      if (saveError) {
        setFormError(saveError);
        return;
      }
      if ((form.type === "product" || form.type === "server") && form.targetId)
        openDetails(form.type, form.targetId, formOpenerRef.current);
      closeForm();
    } catch (error) {
      setFormError(error.message);
    }
  };

  const goToView = (nextView) => {
    setView(nextView);
    closeDetails();
    resetFilters();
  };
  const showSoon = () => {
    goToView("servers");
    setSoonOnly(true);
  };
  const toggleTask = (task) => {
    if (readOnly) return;
    try {
      commit(toggleOpsTask(ops, task.id));
    } catch (error) {
      setLoadError(error.message);
    }
  };

  const serverDeadline = (server) => (
    <ServerDeadline
      server={server}
      now={now}
      upcoming={isDueSoon(server, now)}
      readOnly={readOnly}
      onSave={(dueAt, dueStartAt) => {
        if (readOnly) return "这台服务器当前无法编辑。";
        try {
          return commit(updateServer(ops, server.id, { dueAt, dueStartAt }));
        } catch (error) {
          return error.message;
        }
      }}
    />
  );

  const changeServerStatus = (server, status) => {
    if (readOnly || server.status === status) return;
    try {
      commit(updateServer(ops, server.id, { status }));
    } catch (error) {
      setLoadError(error.message);
    }
  };

  const productDates = (product, compact = false) => (
    <span className={`ops-product-dates${compact ? " compact" : ""}`}>
      {productServers(ops, product.id).map((server) => (
        <span
          className="ops-product-deadline"
          key={server.id}
          data-upcoming={isDueSoon(server, now) || undefined}
        >
          <span className="ops-product-deadline-copy">
            <span
              className={`ops-deadline-server-name${compact ? " sr-only" : ""}`}
            >
              {server.name}
            </span>
            <DeadlineDate {...server} />
          </span>
          <DeadlineRing server={server} now={now} />
        </span>
      ))}
    </span>
  );

  const renderTaskList = (targetType, targetId) => {
    const tasks = recordTasks(ops, targetType, targetId);
    return (
      <section className="ops-section">
        <div className="ops-section-head">
          <h2>关联待办</h2>
          <button
            className="ops-quiet"
            onClick={() => openForm("task")}
            disabled={readOnly}
          >
            <Plus size={13} />
            新建待办
          </button>
        </div>
        {tasks.length === 0 ? (
          <div className="ops-inline-empty">暂无待办</div>
        ) : (
          <div className="ops-task-list">
            {tasks.map((task) => (
              <div
                className={`ops-task ${task.completed ? "is-done" : ""}`}
                key={task.id}
              >
                <button
                  className="ops-check"
                  aria-label={`${task.completed ? "取消完成" : "完成"}待办：${task.text}`}
                  onClick={() => toggleTask(task)}
                  disabled={readOnly}
                >
                  {task.completed && <Check size={12} />}
                </button>
                <span>{task.text}</span>
                <small>{displayDate(task.createdAt)}</small>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  };

  const renderProductDetail = () => {
    if (!selectedProduct) return null;
    const groups = groupDeploymentsByRole(ops, selectedProduct.id);
    return (
      <>
        <div className="ops-detail-top">
          <button
            className="ops-back"
            aria-label={view === "map" ? "返回部署地图" : "返回产品目录"}
            onClick={closeDetails}
          >
            <ArrowLeft size={14} />
            {view === "map" ? "部署地图" : "产品目录"}
          </button>
          <div className="ops-detail-actions">
            <button
              className="ops-danger"
              aria-label={`删除产品：${selectedProduct.name}`}
              onClick={() => confirmDelete("product", selectedProduct)}
              disabled={readOnly}
            >
              <Trash2 size={13} />
              删除
            </button>
            <button
              onClick={() => openForm("product", selectedProduct.id)}
              disabled={readOnly}
            >
              编辑
            </button>
            <button
              className="ops-primary"
              aria-label="新增部署"
              onClick={() => openForm("deployment")}
              disabled={readOnly}
            >
              <Plus size={13} />
              新增部署
            </button>
          </div>
        </div>
        <div className="ops-detail-card ops-identity">
          <span className="ops-record-icon">
            {selectedProduct.name.slice(0, 1)}
          </span>
          <div className="ops-grow">
            <h1>{selectedProduct.name}</h1>
            {selectedProduct.summary && <p>{selectedProduct.summary}</p>}
          </div>
          <span className={`ops-status ${selectedProduct.status}`}>
            <i />
            {STATUS_LABELS[selectedProduct.status]}
          </span>
        </div>
        <div className="ops-fields-grid">
          <div>
            <small>负责人</small>
            <strong>{selectedProduct.owner || "未指定"}</strong>
          </div>
          <div>
            <small>最近更新</small>
            <strong>{displayDate(selectedProduct.updatedAt)}</strong>
          </div>
        </div>
        <section className="ops-section">
          <div className="ops-section-head">
            <h2>运行位置</h2>
            <span>
              {
                ops.deployments.filter(
                  (item) => item.productId === selectedProduct.id,
                ).length
              }{" "}
              个部署关系
            </span>
          </div>
          {groups.length === 0 ? (
            <div className="ops-inline-empty">暂无部署</div>
          ) : (
            <div className="ops-role-groups">
              {groups.map((group) => (
                <div className="ops-role-group" key={group.role}>
                  <div className="ops-role-title">
                    <span>{group.role}</span>
                    <small>{group.items.length} 个</small>
                  </div>
                  {group.items.map(({ deployment, server }) => (
                    <div className="ops-deployment-row" key={deployment.id}>
                      <button
                        className="ops-related-link"
                        onClick={() =>
                          server && openDetails("server", server.id)
                        }
                        disabled={!server}
                      >
                        {server?.name || "未知服务器"}
                      </button>
                      <span>
                        {[server?.provider, server?.region, deployment.version]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      <em>{ENVIRONMENT_LABELS[deployment.environment]}</em>
                      <DeadlineDate {...server} />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>
        {renderTaskList("product", selectedProduct.id)}
        {selectedProduct.tags.length > 0 && (
          <section className="ops-section">
            <div className="ops-section-head">
              <h2>标签</h2>
              <span>{selectedProduct.tags.join(" · ")}</span>
            </div>
          </section>
        )}
      </>
    );
  };

  const renderServerDetail = () => {
    if (!selectedServer) return null;
    const deployments = ops.deployments.filter(
      (item) => item.serverId === selectedServer.id,
    );
    return (
      <>
        <div className="ops-detail-top">
          <button
            className="ops-back"
            aria-label={view === "map" ? "返回部署地图" : "返回服务器台账"}
            onClick={closeDetails}
          >
            <ArrowLeft size={14} />
            {view === "map" ? "部署地图" : "服务器台账"}
          </button>
          <div className="ops-detail-actions">
            <button
              className="ops-danger"
              aria-label={`删除服务器：${selectedServer.name}`}
              onClick={() => confirmDelete("server", selectedServer)}
              disabled={readOnly}
            >
              <Trash2 size={13} />
              删除
            </button>
            <button
              onClick={() => openForm("server", selectedServer.id)}
              disabled={readOnly}
            >
              编辑
            </button>
          </div>
        </div>
        <div className="ops-detail-card ops-identity">
          <span className="ops-record-icon server">
            <Server size={18} />
          </span>
          <div className="ops-grow">
            <h1>{selectedServer.name}</h1>
            {[
              selectedServer.provider,
              selectedServer.region,
              selectedServer.system,
            ].some(Boolean) && (
              <p>
                {[
                  selectedServer.provider,
                  selectedServer.region,
                  selectedServer.system,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
          </div>
          <span
            className={`ops-status ${selectedServer.status}`}
            aria-label={`服务器状态：${STATUS_LABELS[selectedServer.status]}`}
          >
            <i />
            {STATUS_LABELS[selectedServer.status]}
          </span>
        </div>
        <div className="ops-server-deadline-detail">
          {serverDeadline(selectedServer)}
        </div>
        <div className="ops-fields-grid">
          <div>
            <small>环境</small>
            <strong>
              {ENVIRONMENT_LABELS[selectedServer.environment] || "多环境"}
            </strong>
          </div>
          <div>
            <small>地址</small>
            <strong>{selectedServer.address || "未记录"}</strong>
          </div>
        </div>
        <section className="ops-section">
          <div className="ops-section-head">
            <h2>承载产品</h2>
            <span>{deployments.length} 个部署关系</span>
          </div>
          {deployments.length === 0 ? (
            <div className="ops-inline-empty">暂无产品</div>
          ) : (
            <div className="ops-server-products">
              {deployments.map((deployment) => {
                const product = ops.products.find(
                  (item) => item.id === deployment.productId,
                );
                return (
                  <button
                    key={deployment.id}
                    onClick={() => {
                      if (product) openDetails("product", product.id);
                    }}
                  >
                    <span>{product?.name || "未知产品"}</span>
                    <small>
                      {deployment.role || "未分类"} ·{" "}
                      {ENVIRONMENT_LABELS[deployment.environment]}
                    </small>
                  </button>
                );
              })}
            </div>
          )}
        </section>
        {renderTaskList("server", selectedServer.id)}
      </>
    );
  };

  const renderDeploymentDetail = () => {
    const { id, productId, serverId, environment, role, version } =
      selectedDeployment;
    const product = ops.products.find((item) => item.id === productId);
    const server = ops.servers.find((item) => item.id === serverId);
    return (
      <>
        <div className="ops-detail-top">
          <button className="ops-back" onClick={closeDetails}>
            <ArrowLeft size={14} /> 部署地图
          </button>
          <div className="ops-detail-actions">
            <button
              className="ops-danger"
              aria-label="删除部署关系"
              onClick={() => confirmDelete("deployment", selectedDeployment)}
              disabled={readOnly}
            >
              <Trash2 size={13} /> 删除
            </button>
            <button
              aria-label="编辑部署关系"
              onClick={() => openForm("deployment", id)}
              disabled={readOnly}
            >
              编辑
            </button>
          </div>
        </div>
        <div className="ops-detail-card ops-identity">
          <span className="ops-record-icon">
            <Network size={18} />
          </span>
          <div className="ops-grow">
            <h1>{role || "未分类"}</h1>
            <p>
              {ENVIRONMENT_LABELS[environment]}
              {version && ` · ${version}`}
            </p>
          </div>
        </div>
        <div className="ops-fields-grid">
          <div>
            <small>产品</small>
            <button
              className="ops-related-link"
              onClick={() => openDetails("product", productId)}
            >
              {product.name}
            </button>
          </div>
          <div>
            <small>服务器</small>
            <button
              className="ops-related-link"
              onClick={() => openDetails("server", serverId)}
            >
              {server.name}
            </button>
          </div>
        </div>
        {renderTaskList("deployment", id)}
      </>
    );
  };

  const renderForm = () => {
    if (!form) return null;
    const editing = form.targetId;
    const product =
      form.type === "product" &&
      (editing ? ops.products.find((item) => item.id === editing) : null);
    const server =
      form.type === "server" &&
      (editing ? ops.servers.find((item) => item.id === editing) : null);
    if (form.type === "task") {
      const targetType = selectedDeploymentId
        ? "deployment"
        : selectedServerId
          ? "server"
          : "product";
      const targetId =
        selectedDeploymentId || selectedServerId || selectedProductId;
      return (
        <div className="ops-modal-backdrop" role="presentation">
          <form
            className="ops-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ops-form-title"
            onSubmit={submitForm}
          >
            <div className="ops-modal-head">
              <h2 id="ops-form-title">新建待办</h2>
              <button type="button" aria-label="关闭表单" onClick={closeForm}>
                <X size={16} />
              </button>
            </div>
            <input type="hidden" name="targetType" value={targetType} />
            <input type="hidden" name="targetId" value={targetId || ""} />
            <FormField
              label="待办内容"
              name="text"
              required
              placeholder="例如：续期 prod-api-01 证书"
            />
            {formError && (
              <div className="ops-form-error">
                <CircleAlert size={14} />
                {formError}
              </div>
            )}
            <div className="ops-modal-actions">
              <button type="button" onClick={closeForm}>
                取消
              </button>
              <button className="ops-primary" type="submit">
                保存待办
              </button>
            </div>
          </form>
        </div>
      );
    }
    if (form.type === "deployment") {
      const product = selectedProduct;
      const deployment = editing ? selectedDeployment : null;
      return (
        <div className="ops-modal-backdrop" role="presentation">
          <form
            className="ops-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ops-form-title"
            onSubmit={submitForm}
          >
            <div className="ops-modal-head">
              <h2 id="ops-form-title">{editing ? "编辑" : "新增"}部署关系</h2>
              <button type="button" aria-label="关闭表单" onClick={closeForm}>
                <X size={16} />
              </button>
            </div>
            <FormField label="产品" name="productId" required>
              <select
                name="productId"
                defaultValue={deployment?.productId || product?.id || ""}
                required
              >
                <option value="">选择产品</option>
                {ops.products.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="服务器" name="serverId" required>
              <select
                name="serverId"
                defaultValue={deployment?.serverId || ""}
                required
              >
                <option value="">选择服务器</option>
                {ops.servers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="环境" name="environment" required>
              <select
                name="environment"
                defaultValue={deployment?.environment || "production"}
              >
                {selectOptions(ENVIRONMENT_OPTIONS)}
              </select>
            </FormField>
            <FormField
              label="角色"
              name="role"
              value={deployment?.role}
              placeholder="例如 API、数据库、应用"
            />
            <FormField
              label="版本"
              name="version"
              value={deployment?.version}
              placeholder="可选"
            />
            {formError && (
              <div className="ops-form-error">
                <CircleAlert size={14} />
                {formError}
              </div>
            )}
            <div className="ops-modal-actions">
              <button type="button" onClick={closeForm}>
                取消
              </button>
              <button className="ops-primary" type="submit">
                保存部署
              </button>
            </div>
          </form>
        </div>
      );
    }
    const isProduct = form.type === "product";
    const record = isProduct ? product : server;
    return (
      <div className="ops-modal-backdrop" role="presentation">
        <form
          className="ops-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ops-form-title"
          onSubmit={submitForm}
        >
          <div className="ops-modal-head">
            <h2 id="ops-form-title">
              {editing ? "编辑" : "新增"}
              {isProduct ? "产品" : "服务器"}
            </h2>
            <button type="button" aria-label="关闭表单" onClick={closeForm}>
              <X size={16} />
            </button>
          </div>
          <FormField
            label={isProduct ? "产品名称" : "服务器名称"}
            name={isProduct ? "product-name" : "server-name"}
            value={record?.name || undefined}
            onChange={undefined}
            required
            placeholder={isProduct ? "例如 轻单" : "例如 prod-api-01"}
          />
          {isProduct ? (
            <>
              <FormField
                label="产品说明"
                name="product-summary"
                value={record?.summary || undefined}
                placeholder="一句话说明它是什么"
              />
              <FormField
                label="负责人"
                name="owner"
                value={record?.owner || undefined}
                placeholder="可选"
              />
              <FormField
                label="标签"
                name="tags"
                value={record?.tags?.join(", ") || undefined}
                placeholder="用逗号分隔"
              />
            </>
          ) : (
            <>
              <FormField
                label="提供商"
                name="provider"
                value={record?.provider || undefined}
                placeholder="例如 阿里云"
              />
              <FormField
                label="地域"
                name="region"
                value={record?.region || undefined}
                placeholder="例如 杭州"
              />
              <FormField
                label="地址"
                name="address"
                value={record?.address || undefined}
                placeholder="IP、域名或控制台地址"
              />
              <FormField
                label="系统"
                name="system"
                value={record?.system || undefined}
                placeholder="例如 Ubuntu 24.04"
              />
              <FormField label="默认环境" name="environment">
                <select
                  name="environment"
                  defaultValue={record?.environment || ""}
                >
                  <option value="">未指定</option>
                  {selectOptions(ENVIRONMENT_OPTIONS)}
                </select>
              </FormField>
              <div className="ops-field">
                <span>DDL</span>
                <ServerDeadline
                  server={{ name: record?.name || "服务器", ...deadlineDraft }}
                  now={now}
                  readOnly={readOnly}
                  onSave={(dueAt, dueStartAt) => {
                    setDeadlineDraft({ dueAt, dueStartAt });
                    return "";
                  }}
                />
              </div>
            </>
          )}
          <FormField
            label={isProduct ? "产品状态" : "服务器状态"}
            name="status"
          >
            <select name="status" defaultValue={record?.status || "running"}>
              {selectOptions(STATUS_OPTIONS)}
            </select>
          </FormField>
          {formError && (
            <div className="ops-form-error">
              <CircleAlert size={14} />
              {formError}
            </div>
          )}
          <div className="ops-modal-actions">
            <button type="button" onClick={closeForm}>
              取消
            </button>
            <button className="ops-primary" type="submit">
              保存{isProduct ? "产品" : "服务器"}
            </button>
          </div>
        </form>
      </div>
    );
  };

  return (
    <div
      className="operations-overlay"
      role="dialog"
      aria-label="运维资产"
      onKeyDown={(event) => {
        if (
          event.key !== "Escape" ||
          event.defaultPrevented ||
          event.isComposing
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        if (form) closeForm();
        else if (hasDetail) closeDetails();
        else onClose?.();
      }}
    >
      <div className="ops-app">
        <div
          className={`ops-layout${view === "map" ? " ops-map-layout" : ""}`}
          inert={hasDetail || hasForm || undefined}
        >
          <aside className="ops-sidebar">
            <p className="ops-sidebar-label">资产空间</p>
            <button
              aria-label="部署地图"
              aria-current={view === "map" ? "page" : undefined}
              className={view === "map" ? "active" : ""}
              onClick={() => goToView("map")}
            >
              <Network size={16} />
              部署地图<span>{ops.deployments.length}</span>
            </button>
            <button
              aria-label="产品目录"
              aria-current={view === "products" ? "page" : undefined}
              className={view === "products" ? "active" : ""}
              onClick={() => goToView("products")}
            >
              <Boxes size={16} />
              产品目录<span>{ops.products.length}</span>
            </button>
            <button
              aria-label="服务器台账"
              aria-current={
                view === "servers" && !soonOnly ? "page" : undefined
              }
              className={view === "servers" && !soonOnly ? "active" : ""}
              onClick={() => goToView("servers")}
            >
              <Server size={16} />
              服务器台账<span>{ops.servers.length}</span>
            </button>
            <p className="ops-sidebar-label second">快速查看</p>
            <button
              aria-label="7 天内到期"
              aria-current={soonOnly ? "page" : undefined}
              className={soonOnly ? "ops-upcoming active" : "ops-upcoming"}
              onClick={showSoon}
            >
              <i className="ops-mini-dot maintenance" />7 天内到期
              <span>{soonCount}</span>
            </button>
          </aside>
          <main className="ops-main">
            <button
              className="ops-close"
              aria-label="关闭运维资产"
              title="返回原界面"
              onClick={onClose}
            >
              <X size={17} />
            </button>
            {loadError && (
              <div className="ops-banner" role="alert">
                <CircleAlert size={14} />
                {loadError}
              </div>
            )}
            {view === "map" ? (
              <OperationsMap
                ops={ops}
                keyword={keyword}
                setKeyword={setKeyword}
                status={status}
                setStatus={setStatus}
                environment={environment}
                setEnvironment={setEnvironment}
                resetFilters={resetFilters}
                readOnly={readOnly}
                onOpen={openDetails}
                openForm={openForm}
              />
            ) : (
              <OperationsDirectory
                ops={ops}
                view={view}
                records={view === "products" ? products : servers}
                keyword={keyword}
                setKeyword={setKeyword}
                status={status}
                setStatus={setStatus}
                environment={environment}
                setEnvironment={setEnvironment}
                soonOnly={soonOnly}
                soonCount={soonCount}
                showSoon={showSoon}
                resetFilters={resetFilters}
                readOnly={readOnly}
                onOpen={openDetails}
                openForm={openForm}
                confirmDelete={confirmDelete}
                changeServerStatus={changeServerStatus}
                productDates={productDates}
                serverDeadline={serverDeadline}
              />
            )}
          </main>
        </div>
        {hasDetail && (
          <div
            className="ops-detail-backdrop"
            inert={hasForm || undefined}
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) closeDetails();
            }}
          >
            <section
              className="ops-detail-drawer"
              role="dialog"
              aria-modal="true"
              aria-label="资产详情"
              ref={drawerRef}
            >
              <header className="ops-drawer-header">
                <span>运维资产 / {detailLabel}</span>
                <button
                  className="ops-icon-button"
                  aria-label="关闭资产详情"
                  onClick={closeDetails}
                >
                  <X size={17} />
                </button>
              </header>
              <div className="ops-drawer-content">
                {loadError && (
                  <div className="ops-banner" role="alert">
                    <CircleAlert size={14} />
                    {loadError}
                  </div>
                )}
                {selectedProduct
                  ? renderProductDetail()
                  : selectedServer
                    ? renderServerDetail()
                    : renderDeploymentDetail()}
              </div>
            </section>
          </div>
        )}
        {form && <div ref={formLayerRef}>{renderForm()}</div>}
      </div>
    </div>
  );
}
