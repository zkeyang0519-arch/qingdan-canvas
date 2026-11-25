import { createMcpToolName } from "@earendil-works/pi-mcp";
import { recipeSpec } from "../../runner/harness/recipes.mjs";

export class HarnessCapabilities {
  constructor(mcp, scope, localSpecs) {
    Object.assign(this, { mcp, scope, localSpecs });
    this.loaded = new Map();
    this.turns = new Set();
    this.waaoGrant = this.waaoVersion();
  }
  waaoVersion() {
    const server = this.mcp
      ?.list(this.scope.bindingId)
      .find((server) => server.kind === "waao");
    return server
      ? JSON.stringify([
          server.status,
          server.selected,
          server.connectionSource,
        ])
      : null;
  }
  activeSpecs() {
    return [...this.loaded.values()].map((item) => item.spec);
  }
  preload(remote) {
    for (const spec of remote?.specs || [])
      this.loaded.set(spec.name, { remote, spec });
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
            state: !server.selected.includes(tool.name)
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
      capabilities: this.catalog()
        .filter(
          (item) =>
            !q ||
            [item.name, item.description, item.service]
              .join(" ")
              .toLowerCase()
              .includes(q),
        )
        .slice(0, 30),
      hint: "ready 工具可用 request_capability 加载；not_authorized 需要用户在当前项目工具设置启用。目录来自实际配置。",
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
    if (entry.recipe) {
      const recipe = this.recipes.find((item) => item.name === name);
      for (const step of recipe.steps) {
        const result = await this.request(step.tool);
        if (result.status !== "ready") return result;
      }
      this.loaded.set(name, { recipe, spec: recipeSpec(recipe) });
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
    const remote = this.mcp.turn(this.scope);
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
    return { status: "ready", name, parameters: spec.parameters };
  }
  authorize(name) {
    if (name === "waao") {
      if (!this.localSpecs.some((s) => s.name === name))
        throw Error("当前项目尚未授权 WAAO 工具。");
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
  async execute(name, args, callId, signal) {
    this.authorize(name);
    return this.loaded.get(name).remote.execute(name, args, callId, signal);
  }
  delivery(name, callId) {
    return this.loaded.get(name)?.remote?.delivery(callId);
  }
  recipe(name) {
    return this.loaded.get(name)?.recipe;
  }
  async close() {
    await Promise.allSettled([...this.turns].map((turn) => turn.close()));
  }
}
