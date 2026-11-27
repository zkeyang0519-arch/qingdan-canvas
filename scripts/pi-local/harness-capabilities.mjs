import { createMcpToolName } from "@earendil-works/pi-mcp";
import { z } from "zod";
import { recipeSpec } from "../../runner/harness/recipes.mjs";
import { rankSearch } from "../../runner/harness/tool-search.mjs";
import { assessPlan } from "../../runner/harness/feasibility.mjs";
import { estimateTokens } from "../../runner/harness/context-pack.mjs";
import { stepRequirements } from "../../runner/harness/proofs.mjs";
import { readySteps } from "../../runner/harness/blockers.mjs";

export class HarnessCapabilities {
  constructor(mcp, scope, localSpecs) {
    Object.assign(this, { mcp, scope, localSpecs });
    this.loaded = new Map();
    this.turns = new Set();
    this.waaoGrant = this.waaoVersion();
    this.active = new Set();
    this.maxActive = 8;
    this.maxSchemaTokens = 12000;
  }
  waaoVersion() {
    const server = this.mcp
      ?.list(this.scope.bindingId)
      .find((server) => server.kind === "waao");
    return server
      ? JSON.stringify([
          server.status,
          server.enabled ?? !!server.selected.length,
          server.serviceRevision,
          server.connectionSource,
          server.authorization?.fingerprint,
        ])
      : null;
  }
  activeSpecs() {
    return [...this.active]
      .map((name) => this.loaded.get(name)?.spec)
      .filter(Boolean);
  }
  activate(name) {
    this.active.delete(name);
    this.active.add(name);
    while (this.active.size > this.maxActive)
      this.active.delete(this.active.values().next().value);
    while (
      this.active.size > 1 &&
      estimateTokens(this.activeSpecs()) > this.maxSchemaTokens
    )
      this.active.delete(this.active.values().next().value);
  }
  assessPlan(task) {
    const result = assessPlan(task, this.catalog());
    for (const step of task.steps.filter((s) => s.execution)) {
      const check = this.validateArgs(
        step.execution.tool,
        step.execution.args,
        true,
      );
      if (check.error)
        result.issues.push({
          code: "PLAN_ARGUMENTS_INVALID",
          stepIds: [step.id],
          tool: step.execution.tool,
          message: check.error,
        });
    }
    result.ready = !result.issues.length;
    return result;
  }
  definition(name) {
    const local = this.localSpecs.find((s) => s.name === name);
    if (local) return local;
    if (this.loaded.has(name)) return this.loaded.get(name).spec;
    if (!this.currentRemote && this.mcp?.turn) {
      this.currentRemote = this.mcp.turn(this.scope);
      this.turns.add(this.currentRemote);
    }
    return this.currentRemote?.specs.find((s) => s.name === name);
  }
  validateArgs(name, args, template = false) {
    const schema = this.definition(name)?.parameters;
    if (!schema) return {};
    const ref = (value) =>
      value &&
      typeof value === "object" &&
      (Object.hasOwn(value, "$step") || Object.hasOwn(value, "$artifact"));
    const contains = (value) =>
      ref(value) ||
      (value &&
        typeof value === "object" &&
        Object.values(value).some(contains));
    if (template && contains(args)) {
      const missing = [];
      const visit = (v, s, p = "") => {
        if (ref(v) || !v || typeof v !== "object" || !s) return;
        for (const key of s.required || [])
          if (!Object.hasOwn(v, key)) missing.push(p + key);
        for (const [k, x] of Object.entries(v))
          visit(x, s.properties?.[k], p + k + ".");
      };
      visit(args, schema);
      return missing.length
        ? { error: `${name} 缺少计划参数：${missing.join("、")}` }
        : { known: true };
    }
    let parsed;
    try {
      parsed = z.fromJSONSchema(schema).safeParse(args);
    } catch {
      return { known: false };
    }
    return parsed.success
      ? { known: true }
      : {
          error:
            `${name} 参数与工具定义不符：` +
            parsed.error.issues
              .slice(0, 4)
              .map((i) => i.path.join(".") + " " + i.message)
              .join("；"),
        };
  }
  async prepare(task) {
    const ready = readySteps(task);
    const current =
      ready.find((s) => s.id === task.activeStepId && s.status !== "done") ||
      ready[0] ||
      task.steps.find((s) => s.status !== "done");
    const required = current
      ? stepRequirements(task, current)
      : task.requirements;
    const names = [
      ...new Set(
        [
          ...(required || []).flatMap(
            (r) => r.tools || (r.tool ? [r.tool] : []),
          ),
          ...(current?.tools || []),
          current?.execution?.tool,
        ].filter(Boolean),
      ),
    ];
    if (
      !names.length &&
      task.requirements.length &&
      task.requirements.every((r) => r.check === "answer")
    )
      this.active.clear();
    for (const name of names.slice(-this.maxActive))
      if (this.catalog().some((c) => c.name === name && c.state === "ready"))
        await this.request(name);
    return this.assessPlan(task);
  }
  async discover(query) {
    const found = this.find(query);
    for (const entry of found.capabilities
      .filter((c) => c.state === "ready" && !c.local && !c.recipe)
      .slice(0, 4))
      await this.request(entry.name);
    return {
      ...found,
      capabilities: found.capabilities.map((c) => ({
        ...c,
        description: c.description?.slice(0, 300),
        loaded: c.local || this.active.has(c.name),
      })),
      hint: found.hint + " loaded=true 的工具已自动加载，可直接调用。",
    };
  }
  preload(remote, query = "") {
    const all = remote?.specs || [];
    // Small catalogs retain the direct-call path; large catalogs are discovered.
    const selected =
      all.length <= this.maxActive
        ? all
        : rankSearch(all, query, (s) => s.name + " " + s.description, 6);
    for (const spec of selected) {
      this.loaded.set(spec.name, { remote, spec });
      this.activate(spec.name);
    }
  }
  catalog() {
    const used = new Set();
    const local = this.localSpecs.map((spec) => ({
      name: spec.name,
      description: spec.description,
      service: spec.label,
      state: "ready",
      local: true,
    }));
    const remote = (this.mcp?.list(this.scope.bindingId) || []).flatMap(
      (server) =>
        server.tools.map((tool) => {
          const name = createMcpToolName(
            server.kind || "s" + server.id.replaceAll("-", "").slice(0, 12),
            tool.name,
            (n) => used.has(n),
          );
          used.add(name);
          return {
            name,
            description: tool.description,
            service: server.name,
            serverId: server.id,
            state:
              server.kind === "waao" &&
              !(server.enabled ?? !!server.selected.length)
                ? "service_disabled"
                : server.kind !== "waao" && !server.selected.includes(tool.name)
                  ? "not_authorized"
                  : server.status === "ready"
                    ? "ready"
                    : server.status,
          };
        }),
    );
    return [
      ...local,
      ...remote,
      ...(this.recipes || []).map((recipe) => ({
        name: recipe.name,
        description: recipe.description,
        service: "任务工具组合",
        state: "ready",
        recipe: true,
      })),
    ];
  }
  find(query) {
    const q = query.toLowerCase().trim();
    return {
      capabilities: rankSearch(
        this.catalog(),
        q,
        (item) => [item.name, item.description, item.service].join(" "),
        12,
      ),
      total: this.catalog().length,
      hint: "ready 工具可按需加载。WAAO 的 service_disabled 表示当前项目服务开关关闭，不是官网授权失效；其他服务的 not_authorized 表示工具未启用。",
    };
  }
  async request(name) {
    let entry = this.catalog().find((item) => item.name === name);
    if (!entry)
      return {
        status: "unavailable",
        name,
        message:
          "没有已配置的此项能力。请提供服务或在工具设置添加 MCP 连接；不会凭空安装未知程序。",
      };
    if (entry.local) return { status: "ready", name };
    const cached = this.loaded.get(name);
    if (cached?.remote && entry.state === "ready") {
      try {
        cached.remote.authorize(name);
        this.activate(name);
        return {
          status: "ready",
          name,
          cached: true,
          parameters: cached.spec.parameters,
        };
      } catch {
        this.loaded.delete(name);
        this.active.delete(name);
      }
    }
    if (entry.state === "service_disabled")
      return {
        status: "service_disabled",
        name,
        service: entry.service,
        message:
          "当前项目尚未开启 WAAO 服务，请打开「在当前项目使用 WAAO」开关；无需逐项勾选工具。账号和资源权限由 WAAO 决定。",
      };
    if (entry.recipe) {
      const recipe = this.recipes.find((item) => item.name === name);
      for (const step of recipe.steps) {
        const result = await this.request(step.tool);
        if (result.status !== "ready") return result;
      }
      this.loaded.set(name, { recipe, spec: recipeSpec(recipe) });
      this.activate(name);
      return { status: "ready", name, validation: recipe.validation };
    }
    if (entry.state === "not_authorized")
      return {
        status: "waiting_auth",
        name,
        service: entry.service,
        message: "需要用户在当前项目的工具设置启用此工具。",
      };
    if (entry.state !== "ready") {
      await this.mcp.action(this.scope.bindingId, {
        id: entry.serverId,
        action: "test",
      });
      entry = this.catalog().find((item) => item.name === name);
      if (!entry || entry.state !== "ready")
        return {
          status: "waiting_auth",
          name,
          message: "连接仍不可用，请查看工具设置中的诊断或完成登录。",
        };
    }
    let remote = this.currentRemote;
    try {
      remote?.authorize(name);
    } catch {
      remote = null;
    }
    if (!remote?.specs.some((s) => s.name === name))
      remote = this.mcp.turn(this.scope);
    this.currentRemote = remote;
    this.turns.add(remote);
    const spec = remote.specs.find((item) => item.name === name);
    if (!spec)
      return {
        status: "unavailable",
        name,
        message: "工具目录已变化，请重新发现能力。",
      };
    remote.authorize(name);
    this.loaded.set(name, { remote, spec });
    this.activate(name);
    return { status: "ready", name, parameters: spec.parameters };
  }
  authorize(name) {
    if (name === "waao") {
      if (!this.localSpecs.some((s) => s.name === name))
        throw Error("当前项目未开启 WAAO 服务或连接尚未就绪。");
      if (this.waaoVersion() !== this.waaoGrant)
        throw Error("WAAO 授权或来源已变化，请重新读取当前工具状态。");
      // The business adapter checks every individual WAAO request again.
      return;
    }
    if (this.localSpecs.some((spec) => spec.name === name)) return;
    const item = this.loaded.get(name);
    if (!item) throw Error("此工具尚未加载，请先发现并加载能力。");
    if (item.recipe) {
      for (const step of item.recipe.steps) this.authorize(step.tool);
      return;
    }
    item.remote.authorize(name);
  }
  readOnly(name, args) {
    if (this.recipe(name))
      return this.recipe(name).steps.every((step) =>
        this.readOnly(step.tool, step.args),
      );
    return (
      (name === "waao" && ["targets", "status"].includes(args.action)) ||
      this.loaded.get(name)?.remote.readOnly(name) === true
    );
  }
  async execute(name, args, callId, signal, onProgress) {
    this.authorize(name);
    return this.loaded
      .get(name)
      .remote.execute(name, args, callId, signal, onProgress);
  }
  delivery(name, callId) {
    return this.loaded.get(name)?.remote?.delivery?.(callId);
  }
  recipe(name) {
    return this.loaded.get(name)?.recipe;
  }
  async close() {
    await Promise.allSettled([...this.turns].map((turn) => turn.close()));
  }
}
