import { FilmJournal, configured, StageFailure, artifact } from "./journal.mjs";
import { piWriting, gptDraft, directWriting } from "./writing.mjs";
import { makeImage } from "./media.mjs";
import { submitVideo, checkVideo } from "./waao.mjs";
import { piBusinessStep, probePi } from "./pi-session.mjs";
import { activeFilmTurn } from "./codex.mjs";
import { applyFilmResult, resultSchema } from "../../shared/agent/film.ts";
async function dispatch(ctx) {
  const { job } = ctx;
  const creative = (name, label, fn) => {
    if (
      activeFilmTurn(job) ||
      ctx.journal.get(ctx.key + ":native-turn") ||
      job.checkOnly
    )
      return fn(ctx);
    if (!ctx.env.DEEPSEEK_API_KEY)
      throw Error("请先为制作主控配置 DEEPSEEK_API_KEY。");
    return piBusinessStep(ctx, name, label, fn);
  };
  const business = (name, label, fn) => {
    if (job.input.direct || job.checkOnly) return fn(ctx);
    if (job.workflowVersion === 2) return creative(name, label, fn);
    return ctx.env.DEEPSEEK_API_KEY
      ? piBusinessStep(ctx, name, label, fn)
      : fn(ctx);
  };
  switch (job.stage) {
    case "probe":
      return probePi(ctx);
    case "draft":
      return job.input.writer === "gpt"
        ? business("draft_with_gpt", "GPT 初稿", gptDraft)
        : piWriting(ctx);
    case "plan":
      return piWriting(ctx);
    case "director":
      if (job.workflowVersion === 2)
        return creative(
          "refine_script",
          "委派 Codex 按导演岗位改提示词",
          directWriting,
        );
      return job.director === 0
        ? business("refine_script", "导演精修", directWriting)
        : directWriting(ctx);
    case "review":
      return job.workflowVersion === 2
        ? creative("review_script", "委派 Codex 独立质检", directWriting)
        : directWriting(ctx);
    case "image":
      return job.workflowVersion === 2
        ? creative(
            "generate_reference_image",
            "委派 Codex 生成参考图",
            makeImage,
          )
        : business("generate_reference_image", "生成参考图", makeImage);
    case "submit":
      return job.stopped || job.dispatchStarted
        ? submitVideo(ctx)
        : business("submit_waao_video", "提交整片", submitVideo);
    case "poll":
      return checkVideo(ctx);
    case "deliver":
      return checkVideo(ctx, true);
    case "codex": {
      const delegate = async () => {
        const receipt = await ctx.cloud("codex");
        if (!receipt.runId) throw Error("Codex 尚未给出专项任务编号。");
        return { kind: "codex", childId: receipt.runId };
      };
      return job.workflowVersion === 2
        ? creative("delegate_codex_draft", "委派 Codex 整理初稿", delegate)
        : delegate();
    }
    case "child": {
      const { run } = await ctx.cloud("codex");
      if (run?.runId !== job.childId) throw Error("Codex 回执与原任务不一致。");
      if (!run.terminal || !run.stopConfirmed) return { kind: "pending" };
      if (!["completed", "succeeded", "awaiting_review"].includes(run.status))
        throw Error("Codex 专项任务未成功交稿，当前状态 " + run.status + "。");
      if (!run.output?.trim() && !run.resultReadComplete)
        return { kind: "pending" };
      if (!run.output?.trim() || run.output.length > 64000)
        throw Error("Codex 未交付可读取的完整初稿。");
      return {
        kind: "draft",
        artifact: artifact(
          ctx,
          "draft",
          "Codex 专项初稿",
          run.output,
          "Codex",
          { details: { childId: job.childId, turnId: run.turnId } },
        ),
      };
    }
    default:
      throw Error("当前版本无法执行该制作阶段。");
  }
}
export class FilmRunner {
  constructor({
    request,
    stateDir,
    resolveWorkspace,
    connected,
    env = process.env,
    http = fetch,
    createCodexClient,
    inspectCodex,
    execute = dispatch,
  }) {
    Object.assign(this, {
      request,
      stateDir,
      resolveWorkspace,
      connected,
      env,
      http,
      createCodexClient,
      inspectCodex,
      execute,
    });
    this.enabled = false;
    this.busy = false;
    this.admissionsPaused = false;
  }
  start() {
    if (this.enabled) return;
    this.enabled = true;
    this.schedule(1200);
  }
  schedule(delay) {
    if (!this.enabled) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref?.();
  }
  disconnect() {
    this.current?.abort();
  }
  close() {
    this.enabled = false;
    clearTimeout(this.timer);
    this.disconnect();
    if (!this.busy) this.closeJournal();
  }
  closeJournal() {
    this.journal?.close();
    this.journal = null;
  }
  pauseAdmissions() {
    this.admissionsPaused = true;
    clearTimeout(this.timer);
  }
  resumeAdmissions() {
    this.admissionsPaused = false;
    if (this.enabled) this.schedule(0);
  }
  updateActivity() {
    return {
      tasks: this.busy
        ? [
            this.updateTask || {
              id: "film-poll",
              label: "读取制作回执",
              status: "running",
            },
          ]
        : [],
      unknown: [],
    };
  }
  async json(path, body, signal) {
    const r = await this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const result = await r.json().catch(() => ({}));
    if (!r.ok)
      throw new StageFailure(
        result.error || "设备请求失败（HTTP " + r.status + "）。",
        { temporary: r.status >= 500 || r.status === 429 },
      );
    return result;
  }
  async tick() {
    if (this.busy || !this.enabled || this.admissionsPaused) return;
    if (!this.connected()) return this.schedule(3000);
    this.busy = true;
    const abort = new AbortController();
    this.current = abort;
    let again = 5000;
    try {
      if (
        this.inspectCodex &&
        (!this.codexCapsAt || Date.now() - this.codexCapsAt > 300000)
      ) {
        this.codexCaps = await this.inspectCodex();
        this.codexCapsAt = Date.now();
      }
      const { work } = await this.json(
        "poll",
        { capabilities: configured(this.env, this.codexCaps) },
        AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]),
      );
      if (work) {
        this.journal ??= new FilmJournal(this.stateDir);
        await this.process(work, this.journal, abort);
        again = 200;
      }
    } catch {
      again = 8000;
    } finally {
      this.current = null;
      this.busy = false;
      if (this.enabled) this.schedule(again);
      else this.closeJournal();
    }
  }
  async process(work, journal, abort) {
    this.updateTask = {
      id: work.job.id,
      label: "短片制作 · " + work.job.stage,
      status: "running",
    };
    const { job, token, artifacts, binding } = work,
      key = [job.id, job.step, job.attempt].join(":");
    const payload = { jobId: job.id, token },
      cloud = (path, extra = {}) =>
        this.json(path, { ...extra, ...payload }, abort.signal);
    const signal = AbortSignal.any([
      abort.signal,
      AbortSignal.timeout(10 * 60 * 1000),
    ]);
    let renewing = false;
    const timer = setInterval(async () => {
      if (renewing) return;
      renewing = true;
      try {
        const res = await cloud("renew");
        if (!res.active) abort.abort();
      } catch {
        abort.abort();
      } finally {
        renewing = false;
      }
    }, 15000);
    timer.unref?.();
    try {
      let result = journal.get(key + ":result");
      if (!result) {
        try {
          const { root: cwd } = await this.resolveWorkspace(
            binding.workspaceId,
          );
          const ctx = {
            job,
            key,
            artifacts,
            cwd,
            signal,
            journal,
            env: this.env,
            http: this.http,
            createCodexClient: this.createCodexClient,
            codexCaps: this.codexCaps,
            cloud,
            find: (id) => {
              const a = artifacts.find((i) => i.id === id);
              if (!a) throw Error("缺少采用的产物版本。");
              return a;
            },
            media: (id, options = {}) =>
              this.request(job.filmId + "/media/" + id, {
                ...options,
                signal,
                headers: {
                  ...options.headers,
                  "X-Film-Job": job.id,
                  "X-Film-Token": token,
                },
              }),
          };
          result = await this.execute(ctx);
          if (
            !["pending", "error"].includes(result.kind) &&
            !(result.kind === "poll" && !result.ready)
          )
            journal.put(key + ":result", result);
        } catch (e) {
          result = {
            kind: "error",
            message: String(e.message || "制作步骤失败").slice(0, 1150),
            uncertain: !!e.uncertain,
            temporary: !!e.temporary,
          };
        }
      }
      const piSession = journal.get(job.id + ":pi-id");
      if (piSession && result?.artifact)
        result.artifact.details = { ...result.artifact.details, piSession };
      try {
        result = resultSchema.parse(result);
        applyFilmResult(job, result);
      } catch {
        result = {
          kind: "error",
          message: "本步回执与制作约定不一致，请核对输入和产物。",
        };
        journal.put(key + ":result", result);
      }
      if (!abort.signal.aborted)
        await this.json("report", { ...payload, result }, abort.signal);
    } finally {
      clearInterval(timer);
    }
  }
}
