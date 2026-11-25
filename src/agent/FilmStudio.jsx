import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Clapperboard,
  Pencil,
  Plus,
  RefreshCw,
} from "lucide-react";
import { Button } from "./ui/button.jsx";
import { Card } from "./ui/card.jsx";
import { Input } from "./ui/input.jsx";
import FilmStoryboard from "./FilmStoryboard.jsx";
import FilmVersionHistory from "./FilmVersionHistory.jsx";
import WorkspaceDrawer from "./WorkspaceDrawer.jsx";
import ChatImages from "./ChatImages.jsx";
import { useWorkspaceDraft } from "./workspace-state.js";
import { mergeCanvasChecklistTasks } from "./checklist-tasks.js";
import {
  goalNames,
  stateNames,
  stageNames,
  filmUrl,
  draftFrom,
  mutateFilm,
  selectImage,
  swapImage,
} from "./film-model.js";

const services = {
  deepseek: "DeepSeek 主控与初稿",
  codexText: "Codex 改提示词与独立质检",
  codexImage: "Codex 原生生图",
  waao: "WAAO 成片",
  gpt: "GPT 初稿",
};
const codexStages = {
  director: "Codex 精修提示词",
  review: "Codex 独立质检",
  image: "Codex 生成参考图",
};
const suggestedFields = ["goal", "writer", "pauseAfter", "direct"];
const when = (n) =>
  new Date(n).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
function Status({ job }) {
  return (
    <span>
      {stateNames[job?.state] || "简报草稿"}
      {job &&
      ["working", "queued", "blocked", "waiting", "uncertain"].includes(
        job.state,
      )
        ? " · " +
          ((job.workflowVersion === 2 && codexStages[job.stage]) ||
            stageNames[job.stage]) +
          (job.stage === "director" ? " " + (job.director + 1) + "/5" : "")
        : ""}
    </span>
  );
}
export function FilmLinks({ scope, call, revision, onOpen, chatId }) {
  const [rows, set] = useState([]);
  const url = filmUrl(scope);
  const active = rows.some(
    (r) => r.state === "queued" || r.state === "working",
  );
  useEffect(() => {
    let valid = true,
      reading = false;
    const read = async () => {
      if (reading || document.visibilityState === "hidden") return;
      reading = true;
      try {
        const r = await call(url);
        if (valid) set(r.films || []);
      } catch {
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = active ? setInterval(read, 8000) : null;
    document.addEventListener("visibilitychange", read);
    return () => {
      valid = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, [url, call, revision, active]);
  const films = rows
    .filter((r) => r.chatId === chatId || (!r.chatId && !chatId))
    .slice(0, 3);
  return films.length ? (
    <div className="agent-film-links" aria-label="对话中的制作卡">
      {films.map((r) => (
        <div key={r.id} className="agent-linked-film">
          <button onClick={() => onOpen(r.id)}>
            <Clapperboard size={14} />
            <strong>{r.title}</strong>
            <span>{stateNames[r.state]}</span>
          </button>
          <ChatImages media={r.media} scope={scope} />
        </div>
      ))}
    </div>
  ) : null;
}
export function FilmButton({ onClick }) {
  return (
    <button type="button" onClick={onClick}>
      <Clapperboard size={13} aria-hidden="true" />
      短片制作
    </button>
  );
}
function ServiceStatus({ caps, onProbe }) {
  return (
    <details className="film-block">
      <summary>设备制作服务</summary>
      {caps ? (
        <>
          <p>设备上次报告于 {when(caps.at)}。</p>
          {caps.protocol === 1 && (
            <p>
              此设备仍运行旧版制作协议。新卡可先保存或排队，请更新 Runner
              后执行。
            </p>
          )}
          <dl>
            {Object.entries(
              caps.protocol === 1
                ? {
                    deepseek: "DeepSeek",
                    director: "旧版导演台",
                    gemini: "旧版 Gemini",
                    waao: "WAAO 成片",
                    gpt: "GPT 初稿",
                  }
                : services,
            ).map(([key, name]) => {
              const check = caps.checks?.find((c) => c.service === key);
              return (
                <React.Fragment key={key}>
                  <dt>{name}</dt>
                  <dd>
                    {caps.services?.[key] ? "已配置" : "待配置"}
                    {check &&
                      " · " +
                        (check.ok ? "已验证" : "最近失败") +
                        "　" +
                        when(check.at)}
                  </dd>
                </React.Fragment>
              );
            })}
          </dl>
          {onProbe && (
            <button onClick={onProbe}>验证 Pi 只读工具（调用 DeepSeek）</button>
          )}
        </>
      ) : (
        <p>等待已绑定的 Runner 报告制作能力。可以先保存简报。</p>
      )}
    </details>
  );
}
function Brief({
  spec,
  setSpec,
  project,
  memories,
  saveStyle,
  binding,
  tasks,
  caps,
  newCard,
  manualChoices,
  inline,
  outputOnly = false,
}) {
  function change(field, value) {
    const next = { ...spec, [field]: value };
    if (field === "brief" && newCard) {
      const suggestion = draftFrom(value);
      for (const key of suggestedFields) {
        if (!manualChoices.includes(key)) next[key] = suggestion[key];
      }
    }
    if (
      spec.scriptId &&
      !spec.direct &&
      ["brief", "ratio", "character", "dialogue", "style", "context"].includes(
        field,
      )
    ) {
      next.scriptAction = "refine";
    }
    setSpec(next, suggestedFields.includes(field) ? field : undefined);
  }
  const target = spec.target,
    styleMemory = memories?.find(
      (m) =>
        m.scope === "project" &&
        m.bindingId === binding?.bindingId &&
        m.key === "短片风格",
    );
  const [targetExpanded, setTargetExpanded] = useState(
    () => !spec.target?.project,
  );
  const targetFields = (
    <details
      className="film-block"
      open={outputOnly ? targetExpanded : undefined}
      onToggle={
        outputOnly
          ? (event) => setTargetExpanded(event.currentTarget.open)
          : undefined
      }
    >
      <summary>WAAO 出片设置 · 30 秒</summary>
      {caps?.target && (
        <button onClick={() => change("target", { ...caps.target })}>
          采用已绑定设备的出片目标
        </button>
      )}
      <div className="film-two">
        {Object.entries({
          team: "团队编号",
          project: "项目编号",
          canvas: "画布编号",
          model: "视频模型",
        }).map(([key, name]) => (
          <label key={key}>
            {name}
            <input
              value={target[key]}
              onChange={(e) =>
                change("target", { ...target, [key]: e.target.value })
              }
            />
          </label>
        ))}
        <label>
          计费来源
          <select
            aria-label="计费来源"
            value={target.billing === "org" ? "team" : target.billing}
            onChange={(e) =>
              change("target", { ...target, billing: e.target.value })
            }
          >
            <option value="">请选择</option>
            <option value="team">所选团队额度</option>
            <option value="personal">个人额度</option>
          </select>
        </label>
      </div>
      <label className="film-check">
        <input
          type="checkbox"
          checked={spec.direct}
          onChange={(e) => change("direct", e.target.checked)}
        />
        用已采用的定稿和所选原图直接出片
      </label>
    </details>
  );
  if (outputOnly) return targetFields;
  return (
    <>
      <label>
        片名
        <input
          maxLength={120}
          value={spec.title}
          onChange={(e) => change("title", e.target.value)}
          placeholder="例如，车站的红伞"
        />
      </label>
      <label>
        故事或制作要求
        <textarea
          rows={4}
          maxLength={64000}
          value={spec.brief}
          onChange={(e) => change("brief", e.target.value)}
          placeholder="写下创意、已有素材和希望拿到的成果"
        />
      </label>
      <details className="film-block studio-options">
        <summary>画幅、角色与制作偏好</summary>
        <div className="film-two">
          <label>
            交付目标
            <select
              value={spec.goal}
              onChange={(e) => change("goal", e.target.value)}
            >
              {Object.entries(goalNames).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            画幅
            <select
              value={spec.ratio}
              onChange={(e) => change("ratio", e.target.value)}
            >
              {["9:16", "16:9", "1:1", "4:3", "3:4", "21:9"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
        </div>
        <label>
          角色设定
          <textarea
            value={spec.character}
            onChange={(e) => change("character", e.target.value)}
            maxLength={8000}
          />
        </label>
        <label>
          必须保留的对白（每行一句）
          <textarea
            value={spec.dialogue}
            onChange={(e) => change("dialogue", e.target.value)}
            maxLength={8000}
          />
        </label>
        <label>
          本片风格
          <input
            value={spec.style}
            onChange={(e) => change("style", e.target.value)}
            maxLength={3000}
          />
        </label>
        <div className="agent-actions">
          {styleMemory && (
            <button onClick={() => change("style", styleMemory.value)}>
              采用项目风格
            </button>
          )}
          {binding && spec.style && saveStyle && (
            <button
              onClick={() =>
                saveStyle({
                  action: "save",
                  scope: "project",
                  bindingId: binding.bindingId,
                  key: "短片风格",
                  value: spec.style,
                  ...(styleMemory
                    ? {
                        id: styleMemory.id,
                        expectedRevision: styleMemory.revision,
                      }
                    : {}),
                })
              }
            >
              保存为项目风格
            </button>
          )}
        </div>
        <label>
          已采用的项目背景
          <textarea
            value={spec.context}
            onChange={(e) =>
              setSpec({
                ...spec,
                context: e.target.value,
                summaryRevision: null,
              })
            }
            maxLength={24000}
          />
        </label>
        {project?.summary && (
          <button
            onClick={() =>
              setSpec({
                ...spec,
                context: (
                  project.summary.overview ||
                  JSON.stringify(project.summary, null, 2)
                ).slice(0, 24000),
                summaryRevision: project.summaryRevision,
              })
            }
          >
            引用项目摘要第 {project.summaryRevision} 版
          </button>
        )}
        {spec.summaryRevision != null && (
          <small>引用的摘要版本　{spec.summaryRevision}</small>
        )}
        {!!tasks.length && (
          <label>
            关联待办
            <select
              value={
                spec.sourceTodo
                  ? JSON.stringify([
                      spec.sourceTodo.noteId,
                      spec.sourceTodo.taskId,
                    ])
                  : ""
              }
              onChange={(e) => {
                const t = tasks.find(
                  (t) =>
                    JSON.stringify([t.noteId, t.taskId]) === e.target.value,
                );
                setSpec({
                  ...spec,
                  sourceTodo: t
                    ? { noteId: t.noteId, taskId: t.taskId, text: t.text }
                    : null,
                  ...(!spec.brief && t ? { brief: t.text } : {}),
                });
              }}
            >
              <option value="">选择待办</option>
              {tasks.map((t) => (
                <option
                  key={JSON.stringify([t.noteId, t.taskId])}
                  value={JSON.stringify([t.noteId, t.taskId])}
                >
                  {t.text.slice(0, 90)}
                </option>
              ))}
            </select>
          </label>
        )}
        {spec.goal !== "image" && (
          <div className="film-two">
            <label>
              初稿来源
              <select
                value={spec.writer}
                onChange={(e) => change("writer", e.target.value)}
              >
                <option value="deepseek">DeepSeek</option>
                <option value="gpt">GPT</option>
                <option value="codex">Codex 整理项目文稿</option>
              </select>
            </label>
            {spec.goal === "video" && (
              <label>
                预览停点
                <select
                  value={spec.pauseAfter}
                  onChange={(e) => change("pauseAfter", e.target.value)}
                >
                  <option value="none">连续制作</option>
                  <option value="script">先看定稿</option>
                  <option value="images">先看参考图</option>
                </select>
              </label>
            )}
          </div>
        )}
      </details>
      {!inline && spec.goal === "video" && targetFields}
    </>
  );
}
function FilmSection({ inline, title, children }) {
  return inline ? (
    <section className="film-block studio-film-section">
      <h3>{title}</h3>
      {children}
    </section>
  ) : (
    <details className="film-block">
      <summary>{title}</summary>
      {children}
    </details>
  );
}
const filmTabs = [
  ["brief", "简报"],
  ["script", "分镜"],
  ["assets", "素材"],
  ["delivery", "出片与回执"],
];
function FilmEditor({
  inline,
  visible,
  entryTab,
  detail,
  scope,
  call,
  caps,
  project,
  memories,
  saveStyle,
  binding,
  execution,
  chatId,
  seed,
  run,
  refresh,
  openId,
  onChange,
  onQuote,
  initialVersion,
  initialTodo,
  initialMessageId,
  onClose,
}) {
  const card = detail?.card,
    id = card?.id || "",
    rev = card?.rev || 0;
  const sourceKey = initialTodo
    ? ["todo", initialTodo.noteId, initialTodo.taskId]
    : initialMessageId
      ? ["reply", initialMessageId]
      : null;
  const [edits, setEdits] = useWorkspaceDraft(
    JSON.stringify(
      id
        ? ["film", ...scope, id, rev]
        : ["film", ...scope, "new", chatId, sourceKey],
    ),
    {},
    true,
  );
  const { manualChoices = [], ...fields } = edits;
  const base = card?.spec || {
      ...draftFrom(seed || "", chatId, caps?.target),
      sourceTodo: initialTodo || null,
    },
    spec = { ...base, ...fields };
  const setSpec = (next, explicitChoice) =>
    setEdits({
      ...Object.fromEntries(
        Object.entries(next).filter(
          ([key, value]) => JSON.stringify(value) !== JSON.stringify(base[key]),
        ),
      ),
      manualChoices:
        explicitChoice && !manualChoices.includes(explicitChoice)
          ? [...manualChoices, explicitChoice]
          : manualChoices,
    });
  const tasks = mergeCanvasChecklistTasks(execution?.page, []);
  const artifacts = detail?.artifacts || [],
    jobs = (detail?.jobs || []).filter((j) => j.stage !== "probe");
  const [scriptDraft, setScriptDraft, scriptStorage] = useWorkspaceDraft(
    JSON.stringify(["film-script", ...scope, id]),
    { text: "", final: false, file: "" },
    !!id,
    {
      validate: (value) =>
        value &&
        typeof value.text === "string" &&
        value.text.length <= 64000 &&
        typeof value.final === "boolean" &&
        typeof value.file === "string",
    },
  );
  const { text: script, final } = scriptDraft;
  const [view, setView] = useState(initialVersion || null);
  const [tab, setTab] = useState(entryTab);
  const [editingBrief, setEditingBrief] = useState(!id);
  const show = (key) => !inline || tab === key;
  const [canvasImages, setCanvasImages] = useState(null),
    [imageQuery, setImageQuery] = useState("");
  const [roleIndex, setRoleIndex] = useState(0);
  const current = view ? jobs.find((j) => j.id === view) : jobs[0],
    a = (id) => artifacts.find((x) => x.id === id);
  const submission =
    current?.waaoSubmission ?? a(current?.produced)?.details?.submission;
  const media = (x) => filmUrl(scope, "/" + id + "/media/" + x.mediaId);
  const action = (name, body = {}) =>
    mutateFilm(call, scope, "/" + id + "/actions", {
      action: name,
      baseRevision: rev,
      ...body,
    });
  async function commit(start, goal = spec.goal) {
    const submitted = { ...spec, goal };
    if (!spec.title.trim() || (!spec.brief.trim() && !spec.scriptId))
      throw Error("请填写片名，以及故事或已有稿件。");
    if (!id) {
      const created = await mutateFilm(call, scope, "", {
        spec: submitted,
        ...(start ? { start: true } : {}),
      });
      setEdits({});
      await openId(created.id, start ? "delivery" : "brief");
      onChange();
      return;
    }
    const res = await action(start ? "start" : "save", { spec: submitted });
    setEdits({});
    if (start) {
      setView(res.jobId);
      if (inline) setTab("delivery");
    } else setEditingBrief(false);
    await refresh(id);
    onChange();
  }
  const act = (name, body) =>
    run(async () => {
      await action(name, body);
      await refresh(id);
      onChange();
    });
  async function importText() {
    if (!script.trim()) throw Error("请先填写稿件正文。");
    await action("import_script", { text: script, final, spec });
    setScriptDraft((current) =>
      current.text === script && current.final === final
        ? { text: "", final: false, file: "" }
        : current,
    );
    setEdits({});
    await refresh(id);
    onChange();
  }
  async function upload(file) {
    if (!file) return;
    if (file.size > 16 * 1024 * 1024) throw Error("图片需在 16 MiB 以内。");
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file).catch(() => {
        throw Error("图片无法解码，请检查原文件。");
      });
      bitmap.close();
    }
    const imageId = crypto.randomUUID();
    await call(
      filmUrl(scope, "/" + id + "/media/" + imageId, { name: file.name }),
      { method: "PUT", rawBody: file },
    );
    const fresh = await refresh(id);
    if (fresh) setSpec({ ...spec, refs: [...spec.refs, imageId] });
    onChange();
  }
  const images = artifacts.filter((x) => x.kind === "image"),
    scripts = artifacts.filter((x) =>
      ["draft", "director", "final"].includes(x.kind),
    );
  const source = current?.input.sourceTodo,
    live =
      source &&
      tasks.find(
        (t) => t.noteId === source.noteId && t.taskId === source.taskId,
      );
  async function acceptTodo() {
    if (!live || live.text !== source.text || live.locked)
      throw Error("来源待办已有变化，请回待办栏核对。");
    if (source.generation != null || source.specRevision != null) {
      const state = await call("/api/agent/execution/checklist", {
        method: "POST",
        body: { bindingId: binding?.bindingId, action: "list" },
      });
      const t = state.tasks?.find(
        (t) => t.noteId === source.noteId && t.taskId === source.taskId,
      );
      if (
        !t ||
        t.text !== source.text ||
        (source.generation != null && t.generation !== source.generation) ||
        (source.specRevision != null && t.specRevision !== source.specRevision)
      )
        throw Error("制作期间待办验收条件已变化，请先核对新旧要求。");
    }
    if (
      !(await execution.onSetTodoDone(
        execution.page.id,
        { noteId: source.noteId, taskId: source.taskId },
        true,
      ))
    )
      throw Error("来源待办已变化，请核对。");
  }
  const selectedImages = spec.refs.map(a).filter((image) => image?.mediaId);
  const briefProps = {
    inline,
    newCard: !id,
    manualChoices,
    spec,
    setSpec,
    project,
    memories,
    saveStyle,
    binding,
    tasks,
    caps,
  };
  const runGoal =
    !inline || !id
      ? spec.goal
      : {
          brief: spec.goal,
          script: spec.goal === "draft" ? "draft" : "prompt",
          assets: "image",
          delivery: "video",
        }[tab];
  return (
    <div className="film-editor">
      {inline && id && (
        <div className="studio-film-bar">
          <div className="studio-tabs" role="group" aria-label="制作阶段">
            {filmTabs.map(([key, label]) => (
              <button
                type="button"
                key={key}
                aria-pressed={tab === key}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <FilmVersionHistory
            card={card}
            scope={scope}
            call={call}
            artifacts={artifacts}
            media={media}
            restore={(old) => {
              setSpec(old);
              setTab("brief");
              setEditingBrief(true);
            }}
          />
        </div>
      )}
      {inline && id && Object.keys(fields).length > 0 && (
        <p className="studio-draft-indicator" role="status">
          本机草稿有改动，保存后会形成工作版本。
        </p>
      )}
      {show("brief") &&
        (inline && id && !editingBrief ? (
          <>
            <FilmStoryboard
              key={JSON.stringify(spec.refs)}
              images={selectedImages}
              media={media}
              text={a(spec.scriptId)?.text}
              ratio={spec.ratio}
              visible={visible}
            />
            <section className="studio-brief">
              <div>
                <h3>制作简报</h3>
                <p>{spec.brief || "已采用项目文稿。"}</p>
                <small>
                  {goalNames[spec.goal]} · {spec.ratio} ·{" "}
                  {selectedImages.length} 张参考图
                </small>
              </div>
              <button type="button" onClick={() => setEditingBrief(true)}>
                <Pencil size={15} />
                编辑简报
              </button>
            </section>
            <div className="studio-next">
              <div>
                <strong>{spec.scriptId ? "已采用分镜" : "准备分镜稿"}</strong>
                <small>{scripts.length} 份稿件</small>
              </div>
              <button
                type="button"
                className="primary"
                onClick={() => setTab("script")}
              >
                查看分镜 <ArrowRight size={15} />
              </button>
            </div>
          </>
        ) : (
          <Brief {...briefProps} />
        ))}
      {inline && show("delivery") && (
        <>
          <section className="studio-surface studio-delivery">
            <h3>出片前核对</h3>
            <div>
              <span>采用稿件</span>
              <strong>{a(spec.scriptId)?.title || "由制作流程准备"}</strong>
              <button type="button" onClick={() => setTab("script")}>
                查看分镜
              </button>
            </div>
            <div>
              <span>参考素材</span>
              <strong>{spec.refs.length} 张 · 按选定顺序</strong>
              <button type="button" onClick={() => setTab("assets")}>
                查看素材
              </button>
            </div>
            <div>
              <span>出片目标</span>
              <strong>
                {spec.target.project && spec.target.canvas
                  ? spec.target.project + " / " + spec.target.canvas
                  : "待设置"}
              </strong>
            </div>
          </section>
          <Brief {...briefProps} outputOnly />
        </>
      )}
      {!!id && (
        <>
          {show("script") && (
            <FilmSection
              inline={inline}
              title={`分镜与提示词 · ${scripts.length} 份`}
            >
              <label>
                本版采用的稿件
                <select
                  value={spec.scriptId || ""}
                  onChange={(e) =>
                    setSpec({ ...spec, scriptId: e.target.value || null })
                  }
                >
                  <option value="">根据简报起草</option>
                  {scripts.map((x, i) => (
                    <option key={x.id} value={x.id}>
                      第 {i + 1} 份 · {x.title}
                    </option>
                  ))}
                </select>
              </label>
              {spec.scriptId && spec.goal !== "image" && !spec.direct && (
                <label>
                  已有稿件的用法
                  <select
                    value={spec.scriptAction || "use"}
                    onChange={(e) =>
                      setSpec({ ...spec, scriptAction: e.target.value })
                    }
                  >
                    <option value="use">沿用采用的稿件</option>
                    <option value="refine">按本次要求交导演重修</option>
                  </select>
                </label>
              )}
              {scripts.map((x, i) => (
                <details key={x.id}>
                  <summary>
                    {i + 1}. {x.title} · {x.source}
                  </summary>
                  <pre>{x.text}</pre>
                  {x.details?.output?.changes?.map((c, k) => (
                    <p key={k}>
                      {c.location} · {c.reason}
                    </p>
                  ))}
                  <div className="agent-actions">
                    <button
                      onClick={() =>
                        run(() => navigator.clipboard.writeText(x.text))
                      }
                    >
                      复制全文
                    </button>
                    <button
                      onClick={() => {
                        setScriptDraft({
                          text: x.text,
                          final: x.kind === "final",
                          file: "",
                        });
                      }}
                    >
                      基于这版修改
                    </button>
                  </div>
                </details>
              ))}
              <label>
                导入或编辑完整文稿
                <textarea
                  rows={5}
                  value={script}
                  maxLength={64000}
                  onChange={(e) =>
                    setScriptDraft({ ...scriptDraft, text: e.target.value })
                  }
                />
              </label>
              <label className="film-check">
                <input
                  type="checkbox"
                  checked={final}
                  onChange={(e) =>
                    setScriptDraft({ ...scriptDraft, final: e.target.checked })
                  }
                />
                采用为用户定稿
              </label>
              <label>
                从本机文本文件导入
                <input
                  type="file"
                  accept=".txt,.md,text/plain,text/markdown"
                  onChange={(e) => {
                    const file = e.target.files[0];
                    e.target.value = "";
                    if (file)
                      void run(async () => {
                        if (file.size > 256000)
                          throw Error("文稿过大，请选取本次短片的正文。");
                        const text = await file.text();
                        if (
                          !text.trim() ||
                          text.length > 64000 ||
                          text.includes("\u0000")
                        )
                          throw Error(
                            "请导入可读取的 Markdown 或纯文本文稿，最多 64,000 字符。",
                          );
                        setScriptDraft({ text, final, file: file.name });
                      });
                  }}
                />
              </label>
              {scriptDraft.file && <small>源文件 · {scriptDraft.file}</small>}
              {scriptStorage.warning && (
                <p role="alert" className="agent-error">
                  {scriptStorage.warning}
                </p>
              )}
              <button disabled={!script.trim()} onClick={() => run(importText)}>
                保存并采用稿件
              </button>
            </FilmSection>
          )}
          {show("assets") && (
            <FilmSection
              inline={inline}
              title={`参考图 · 已选 ${spec.refs.length} 张`}
            >
              <label>
                上传原图
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  onChange={(e) => {
                    const file = e.target.files[0];
                    e.target.value = "";
                    void run(() => upload(file));
                  }}
                />
              </label>
              <label>
                当前画布图片
                <input
                  value={imageQuery}
                  placeholder="按图片名称查找"
                  onChange={(e) => setImageQuery(e.target.value)}
                />
              </label>
              <button
                onClick={() =>
                  run(async () =>
                    setCanvasImages(
                      (
                        await call(
                          filmUrl(scope, "/" + id + "/canvas-images", {
                            search: imageQuery,
                          }),
                        )
                      ).images,
                    ),
                  )
                }
              >
                从画布选图
              </button>
              {canvasImages && (
                <div className="agent-actions">
                  {!canvasImages.length && <small>没有匹配的画布图片。</small>}
                  {canvasImages.map((x) => (
                    <button
                      key={x.id}
                      onClick={() =>
                        run(async () => {
                          const a = await call(
                            filmUrl(scope, "/" + id + "/canvas-images"),
                            { method: "POST", body: { assetId: x.id } },
                          );
                          await refresh(id);
                          setSpec({
                            ...spec,
                            refs: [...new Set([...spec.refs, a.id])],
                          });
                        })
                      }
                    >
                      采用 {x.name}
                    </button>
                  ))}
                </div>
              )}
              {images.map((x) => (
                <div className="film-asset" key={x.id}>
                  <a href={media(x)} target="_blank" rel="noreferrer">
                    <img src={media(x)} alt={x.title} loading="lazy" />
                  </a>
                  <span>
                    {x.title}
                    <small>{x.source}</small>
                  </span>
                  <select
                    aria-label={x.title + " 的用途"}
                    value={
                      spec.refs.includes(x.id)
                        ? "ref"
                        : spec.inspiration.includes(x.id)
                          ? "inspiration"
                          : "candidate"
                    }
                    onChange={(e) =>
                      setSpec(selectImage(spec, x.id, e.target.value))
                    }
                  >
                    <option value="ref">本版必用</option>
                    <option value="inspiration">仅作灵感</option>
                    <option value="candidate">候选图</option>
                  </select>
                  <button
                    onClick={() =>
                      setSpec({
                        ...spec,
                        goal: "image",
                        replaceRef: x.id,
                        brief: x.details.description || spec.brief || x.title,
                      })
                    }
                  >
                    重做这张
                  </button>
                </div>
              ))}
              {spec.refs.map((id, i) => (
                <div className="film-order" key={id}>
                  <span>
                    @图片{i + 1}　{a(id)?.title}
                  </span>
                  <button
                    aria-label={"将第 " + (i + 1) + " 张上移"}
                    disabled={!i}
                    onClick={() =>
                      setSpec({ ...spec, refs: swapImage(spec.refs, i, -1) })
                    }
                  >
                    ↑
                  </button>
                  <button
                    aria-label={"将第 " + (i + 1) + " 张下移"}
                    disabled={i === spec.refs.length - 1}
                    onClick={() =>
                      setSpec({ ...spec, refs: swapImage(spec.refs, i, 1) })
                    }
                  >
                    ↓
                  </button>
                </div>
              ))}
            </FilmSection>
          )}
        </>
      )}
      {runGoal === "video" && (show("delivery") || !id) && (
        <small>
          本版提交整条 30 秒短片 · {spec.refs.length} 张已选原图 ·{" "}
          {["team", "org"].includes(spec.target.billing)
            ? "使用团队 " + spec.target.team + " 的额度"
            : spec.target.billing === "personal"
              ? "使用个人额度"
              : "计费目标待选择"}
        </small>
      )}
      {(!inline ||
        !id ||
        tab !== "brief" ||
        editingBrief ||
        Object.keys(fields).length > 0) && (
        <div className="agent-actions film-actions">
          <button
            className={binding ? "" : "primary"}
            onClick={() => run(() => commit(false))}
          >
            {id ? "保存工作版" : "保存制作卡"}
          </button>
          {(id || binding) && (
            <button
              className="primary"
              disabled={
                !binding ||
                (!!id &&
                  (!card.binding ||
                    card.binding.bindingId !== binding.bindingId ||
                    card.binding.bindingRevision !== binding.revision)) ||
                (!id && runGoal === "video" && spec.direct)
              }
              onClick={() => run(() => commit(true, runGoal))}
            >
              {runGoal === "video" && jobs.some((j) => j.input.goal === "video")
                ? "生成新版成片"
                : goalNames[runGoal]}
            </button>
          )}
          {id &&
            binding &&
            (!card.binding ||
              card.binding.bindingId !== binding.bindingId ||
              card.binding.bindingRevision !== binding.revision) && (
              <button onClick={() => act("rebind")}>关联当前设备</button>
            )}
        </div>
      )}
      {id && !binding && (
        <p className="agent-note">简报已保存。绑定设备后可开始制作。</p>
      )}
      {!id && spec.goal === "video" && spec.direct && (
        <p>先保存制作卡，再导入本版定稿和参考图。</p>
      )}
      {show("delivery") && view && !current && (
        <p>
          当前制作卡没有这个版本。
          <button onClick={() => setView(null)}>查看最近版本</button>
        </p>
      )}
      {show("delivery") && current && (
        <section className="film-block">
          <h3>制作版本</h3>
          <label>
            查看版本
            <select
              value={current.id}
              onChange={(e) => setView(e.target.value)}
            >
              {jobs.map((j, i) => (
                <option key={j.id} value={j.id}>
                  V{jobs.length - i} · {goalNames[j.input.goal]} ·{" "}
                  {when(j.created)}
                </option>
              ))}
            </select>
          </label>
          <p role="status">
            <Status job={current} />
            {current.message && "　" + current.message}
          </p>
          {current.childId && (
            <p>
              Codex 专项任务　<code>{current.childId}</code>　
              {execution?.onSelectBatch && (
                <button
                  onClick={() => {
                    execution.onSelectBatch({
                      runId: current.childId,
                      sectionId: scope[2],
                      bindingId: current.binding.bindingId,
                      bindingRevision: current.binding.bindingRevision,
                    });
                    onClose();
                  }}
                >
                  查看专项执行
                </button>
              )}
            </p>
          )}
          {current.codexTurn && (
            <details>
              <summary>最近一次 Codex 制作派单</summary>
              <p>
                会话　<code>{current.codexTurn.threadId}</code>
              </p>
              {current.codexTurn.turnId && (
                <p>
                  轮次　<code>{current.codexTurn.turnId}</code>
                </p>
              )}
            </details>
          )}
          <div className="agent-actions">
            {current.state === "waiting" && (
              <button onClick={() => act("continue", { jobId: current.id })}>
                采用并继续
              </button>
            )}
            {current.state === "blocked" && (
              <button onClick={() => act("retry", { jobId: current.id })}>
                从本步重试
              </button>
            )}
            {current.state === "uncertain" && (
              <button onClick={() => act("reconcile", { jobId: current.id })}>
                核对原提交
              </button>
            )}
            {["poll", "deliver", "child"].includes(current.stage) &&
              current.state !== "done" && (
                <button onClick={() => act("refresh", { jobId: current.id })}>
                  查原任务进度
                </button>
              )}
            {current.state === "stopped" &&
              !current.remote &&
              !current.dispatchStarted && (
                <button onClick={() => act("resume", { jobId: current.id })}>
                  恢复后续制作
                </button>
              )}
            {current.state === "uncertain" && (
              <button onClick={() => act("start", { spec, newAttempt: true })}>
                另建一版重新生成（可能再次计费）
              </button>
            )}
            {["working", "queued", "waiting", "blocked", "uncertain"].includes(
              current.state,
            ) &&
              !current.stopped && (
                <button onClick={() => act("stop", { jobId: current.id })}>
                  停止后续制作
                </button>
              )}
          </div>
          {a(current.adopted) && (
            <details>
              <summary>本版采用的稿件 · {a(current.adopted).title}</summary>
              <pre>{a(current.adopted).text}</pre>
            </details>
          )}
          {a(current.reviewId) && (
            <details>
              <summary>
                独立文字质检 ·{" "}
                {a(current.reviewId).kind === "final" ? "通过" : "待修"}
              </summary>
              {a(current.reviewId).details.output?.summary && (
                <p>{a(current.reviewId).details.output.summary}</p>
              )}
              {a(current.reviewId).details.output?.issues?.map((i, index) => (
                <p key={index}>
                  <strong>{i.location || "全片"}</strong>　{i.reason}　
                  {i.required_fix}
                </p>
              ))}
            </details>
          )}
          {current.plan.length > 0 && (
            <details>
              <summary>镜头与素材清单</summary>
              {current.plan.map((n) => (
                <p key={n.key}>
                  <strong>{n.name}</strong>　{n.shots.join("、")}　
                  {n.description}
                </p>
              ))}
            </details>
          )}
          {!!current.directors?.length && (
            <details>
              <summary>从某个导演岗位修订</summary>
              <label>
                重新开始的岗位
                <select
                  value={Math.min(roleIndex, current.directors.length - 1)}
                  onChange={(e) => setRoleIndex(Number(e.target.value))}
                >
                  {current.directors.map((id, i) => (
                    <option key={id} value={i}>
                      {a(id)?.title || "第 " + (i + 1) + " 岗"}
                    </option>
                  ))}
                </select>
              </label>
              <button
                onClick={() =>
                  act("revise_director", {
                    jobId: current.id,
                    index: Math.min(roleIndex, current.directors.length - 1),
                    spec,
                  })
                }
              >
                保存为新的修订版本
              </button>
            </details>
          )}
          {!!current.refs.length && (
            <div className="film-thumbs">
              {current.refs.map((ref, i) => {
                const x = a(ref);
                return x?.mediaId ? (
                  <a key={ref} href={media(x)} target="_blank" rel="noreferrer">
                    <img src={media(x)} alt={x.title} />
                    <small>
                      @图片{i + 1} · {x.title}
                    </small>
                  </a>
                ) : null;
              })}
            </div>
          )}
          {a(current.produced)?.kind === "video" && (
            <>
              <video
                controls
                preload="metadata"
                src={media(a(current.produced))}
              />
              <p>
                实测 {a(current.produced).details.duration} 秒 ·{" "}
                <a
                  href={media(a(current.produced))}
                  download={current.input.title + ".mp4"}
                >
                  下载原片
                </a>
              </p>
            </>
          )}
          {current.remote && (
            <small>
              WAAO 任务 {current.remote.task} · 视频节点 {current.remote.node}
            </small>
          )}
          {submission && (
            <details>
              <summary>WAAO 节点上的提示词与素材顺序</summary>
              <pre>{submission.prompt}</pre>
              {submission.imports.map((i) => (
                <p key={i.id}>
                  @图片{i.position}　{a(i.id)?.title}　平台素材 {i.assetId}
                </p>
              ))}
            </details>
          )}
          {onQuote && (
            <button
              onClick={() =>
                onQuote(
                  card.spec.title +
                    " · " +
                    goalNames[current.input.goal] +
                    " · " +
                    stateNames[current.state] +
                    "\n[轻单制作 " +
                    id +
                    "/" +
                    current.id +
                    "]",
                )
              }
            >
              引用此版本到聊天
            </button>
          )}
          {source && current.state === "done" && current.stage !== "probe" && (
            <p>
              {live?.done ? (
                "来源待办已完成"
              ) : live?.text !== source.text ? (
                "来源待办内容已有变化，请回待办栏核对。"
              ) : (
                <button
                  disabled={!execution?.onSetTodoDone || live?.locked}
                  onClick={() => run(acceptTodo)}
                >
                  验收并完成来源待办
                </button>
              )}
            </p>
          )}
        </section>
      )}
      {show("delivery") && !!detail?.events?.length && (
        <details className="film-block">
          <summary>制作过程与回执</summary>
          {detail.events
            .slice()
            .reverse()
            .map((e) => (
              <p key={e.seq}>
                {when(e.at)}　{e.message}
              </p>
            ))}
        </details>
      )}
      {show("delivery") && (
        <ServiceStatus
          caps={detail?.capabilities || caps}
          onProbe={id && binding ? () => act("probe", {}) : undefined}
        />
      )}
    </div>
  );
}
export default function FilmStudio({
  inline = false,
  visible = true,
  scope,
  call,
  initialId,
  initialText = "",
  createFirst = false,
  initialVersion,
  initialTodo,
  initialMessageId,
  chatId,
  binding,
  project,
  memories,
  saveStyle,
  execution,
  onClose,
  onChange,
  onQuote,
}) {
  const [mode, setMode] = useState(
      initialId ? "detail" : createFirst ? "new" : "list",
    ),
    [detail, setDetail] = useState(null),
    [rows, setRows] = useState([]),
    [caps, setCaps] = useState(null),
    [search, setSearch] = useState(""),
    [day, setDay] = useState(() => {
      if (!/昨天/.test(initialText)) return "";
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return d.toLocaleDateString("sv-SE");
    }),
    [stateFilter, setFilter] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [more, setMore] = useState(false);
  const live = useRef(true),
    selected = useRef(initialId || ""),
    lock = useRef(false),
    sequence = useRef(0);
  const baseUrl = filmUrl(scope);
  const [entryContext, setEntryContext] = useState(true);
  const run = async (fn) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (e) {
      if (live.current) setError(e.message);
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  };
  async function refresh(id) {
    const seq = ++sequence.current;
    const next = await call(filmUrl(scope, "/" + id));
    if (live.current && selected.current === id && seq === sequence.current) {
      setDetail(next);
      return next;
    }
    return null;
  }
  const [entryTab, setEntryTab] = useState(
    initialVersion ? "delivery" : "brief",
  );
  async function openId(id, nextTab = "brief") {
    setEntryTab(nextTab);
    selected.current = id;
    setMode("detail");
    setDetail(null);
    return refresh(id);
  }
  async function list(append = false) {
    const cursor = append && rows.at(-1);
    const out = await call(
      filmUrl(
        scope,
        "",
        cursor ? { before: cursor.updated, cursor: cursor.id } : {},
      ),
    );
    if (live.current) {
      const items = out.films || [];
      setMore(items.length > 50);
      setRows((old) =>
        append ? [...old, ...items.slice(0, 50)] : items.slice(0, 50),
      );
      return items;
    }
  }
  useEffect(() => {
    live.current = true;
    call(filmUrl(scope, "/capabilities"))
      .then((r) => {
        if (live.current) setCaps(r.capabilities);
      })
      .catch(() => {});
    void run(async () => {
      const items = await list();
      if (!live.current) return;
      if (initialId)
        await openId(initialId, initialVersion ? "delivery" : "brief");
      else if (inline && !createFirst && items?.length === 1)
        await openId(items[0].id);
    });
    return () => {
      live.current = false;
    };
  }, [baseUrl]);
  const polling = detail?.jobs.some((j) =>
    ["queued", "working"].includes(j.state),
  );
  useEffect(() => {
    if (!visible || !polling || mode !== "detail") return;
    const timer = setInterval(() => {
      if (!lock.current && selected.current)
        void refresh(selected.current).catch(() => {});
    }, 4000);
    return () => clearInterval(timer);
  }, [visible, mode, detail?.card.id, polling]);
  function back() {
    setEntryContext(false);
    selected.current = "";
    setMode("list");
    setDetail(null);
    void run(() => list());
  }
  const matches = rows.filter(
    (row) =>
      row.title.toLowerCase().includes(search.toLowerCase()) &&
      (!stateFilter || row.state === stateFilter) &&
      (!day || new Date(row.updated).toLocaleDateString("sv-SE") === day),
  );
  const title =
    mode === "detail" && detail
      ? detail.card.spec.title
      : mode === "new"
        ? "新建制作卡"
        : "短片制作";
  const Frame = inline ? "section" : WorkspaceDrawer;
  const frameProps = inline
    ? { className: "studio-film-page", "aria-label": "短片制作" }
    : { title, size: "wide", onClose };
  return (
    <Frame {...frameProps}>
      {inline && (
        <header className="studio-page-heading">
          <div>
            <small>{mode === "list" ? "项目工作区" : "短片制作"}</small>
            <h2>{title}</h2>
          </div>
          {mode !== "list" && (
            <button type="button" onClick={back}>
              <ArrowLeft size={15} /> 制作卡列表
            </button>
          )}
        </header>
      )}
      <div className="film-studio">
        {!inline && mode !== "list" && (
          <button type="button" onClick={back}>
            ‹ 项目制作记录
          </button>
        )}
        {error && (
          <p className="agent-error" role="alert">
            {error}
          </p>
        )}
        {mode === "list" ? (
          <>
            <div className="agent-actions film-library-toolbar">
              <Button
                className="primary"
                onClick={() => {
                  selected.current = "";
                  setEntryContext(false);
                  setMode("new");
                }}
              >
                <Plus size={15} aria-hidden="true" />
                新建制作卡
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label="刷新"
                title="刷新"
                onClick={() => run(() => list())}
              >
                <RefreshCw size={15} />
              </Button>
            </div>
            {!!rows.length && (
              <div className="film-filters">
                <Input
                  aria-label="查找片名"
                  placeholder="查找片名"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <input
                  type="date"
                  aria-label="制作日期"
                  value={day}
                  onChange={(e) => setDay(e.target.value)}
                />
                <select
                  aria-label="制作状态"
                  value={stateFilter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="">全部状态</option>
                  {Object.entries(stateNames).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {!matches.length && !busy && (
              <Card className="film-library-empty qd:items-center qd:gap-3 qd:rounded-3xl qd:shadow-none">
                <span className="film-empty-icon">
                  <Clapperboard size={26} aria-hidden="true" />
                </span>
                <h3>
                  {rows.length
                    ? "没有匹配的制作卡。"
                    : "从一个想法，开始一支短片。"}
                </h3>
                <p>
                  {rows.length
                    ? "试试其他片名、日期或制作状态。"
                    : "这个项目还没有制作卡。"}
                </p>
                {!rows.length && (
                  <small>把故事、分镜、素材和出片记录收在一起。</small>
                )}
              </Card>
            )}
            {matches.map((row) => (
              <button
                type="button"
                className="film-row"
                key={row.id}
                onClick={() => run(() => openId(row.id))}
              >
                <strong>{row.title}</strong>
                <span>
                  {goalNames[row.goal]} · {stateNames[row.state]} ·{" "}
                  {when(row.updated)}
                </span>
              </button>
            ))}
            {more && (
              <button onClick={() => run(() => list(true))}>
                更早的制作卡
              </button>
            )}
            <ServiceStatus caps={caps} />
          </>
        ) : mode === "new" || detail ? (
          <fieldset className="film-fields" disabled={busy}>
            <FilmEditor
              key={detail?.card.id || "new"}
              {...{
                detail,
                inline,
                visible,
                entryTab,
                scope,
                call,
                caps,
                project,
                memories,
                saveStyle,
                binding,
                execution,
                chatId,
                seed: entryContext ? initialText : "",
                run,
                refresh,
                openId,
                onChange,
                onQuote,
                initialVersion:
                  detail?.card.id === initialId ? initialVersion : null,
                initialTodo: entryContext ? initialTodo : null,
                initialMessageId: entryContext ? initialMessageId : null,
                onClose,
              }}
            />
          </fieldset>
        ) : (
          <p>正在读取制作卡…</p>
        )}
      </div>
    </Frame>
  );
}
