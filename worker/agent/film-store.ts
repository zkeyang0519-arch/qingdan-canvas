import { check } from "../http";
import { canonicalJson } from "../mcp/room-storage";
import {
  applyFilmResult,
  artifactSchema,
  filmId,
  filmSpecSchema,
  newFilmJob,
  type FilmArtifact,
  type FilmJob,
  type FilmTurn,
  type WaaoSubmission,
  type FilmResult,
  type FilmSpec,
} from "../../shared/agent/film";
import type { ExecutionPrincipal } from "../execution/execution-auth";

export interface FilmBinding extends ExecutionPrincipal {
  workspaceId: string;
}
export interface FilmCard {
  id: string;
  canvas: string;
  section: string;
  rev: number;
  spec: FilmSpec;
  binding: FilmBinding | null;
  created: number;
  updated: number;
}
export type FilmScope = {
  canvas: string;
  section: string;
  binding: FilmBinding | null;
};
export class FilmStore {
  constructor(
    private sql: SqlStorage,
    private tx: <T>(fn: () => T) => T,
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS film_cards(id TEXT PRIMARY KEY,canvas TEXT NOT NULL,section TEXT NOT NULL,updated INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS film_project ON film_cards(canvas,section,updated);
      CREATE TABLE IF NOT EXISTS film_card_revisions(film TEXT NOT NULL,rev INTEGER NOT NULL,updated INTEGER NOT NULL,spec TEXT NOT NULL,PRIMARY KEY(film,rev));
      CREATE TABLE IF NOT EXISTS film_jobs(id TEXT PRIMARY KEY,film TEXT NOT NULL,runner TEXT NOT NULL,state TEXT NOT NULL,due INTEGER NOT NULL,token TEXT,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS film_due ON film_jobs(runner,state,due);
      CREATE INDEX IF NOT EXISTS film_versions ON film_jobs(film);
      CREATE TABLE IF NOT EXISTS film_artifacts(id TEXT NOT NULL,film TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(film,id));
      CREATE TABLE IF NOT EXISTS film_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,film TEXT NOT NULL,job TEXT,at INTEGER NOT NULL,message TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS film_events_by_card ON film_events(film,seq);
      CREATE TABLE IF NOT EXISTS film_receipts(id TEXT PRIMARY KEY,payload TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS film_capabilities(runner TEXT PRIMARY KEY,at INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS film_checks(runner TEXT NOT NULL,service TEXT NOT NULL,at INTEGER NOT NULL,stage TEXT NOT NULL,ok INTEGER NOT NULL,PRIMARY KEY(runner,service));`);
  }
  private data<T>(query: string, ...args: (string | number)[]): T | null {
    const row = this.sql.exec<{ data: string }>(query, ...args).toArray()[0];
    return row ? JSON.parse(row.data) : null;
  }
  card(id: string) {
    return this.data<FilmCard>("SELECT data FROM film_cards WHERE id=?", id);
  }
  job(id: string) {
    return this.data<FilmJob>("SELECT data FROM film_jobs WHERE id=?", id);
  }
  artifact(film: string, id: string) {
    return this.data<FilmArtifact>(
      "SELECT data FROM film_artifacts WHERE film=? AND id=?",
      film,
      id,
    );
  }
  imagesForVersion(job: FilmJob) {
    if (!job.refs.length) return [];
    return this.sql
      .exec<{ id: string; title: string; position: number }>(
        `SELECT json_extract(a.data,'$.mediaId') AS id, json_extract(a.data,'$.title') AS title,
              CAST(r.key AS INTEGER)+1 AS position
       FROM json_each(?) r JOIN film_artifacts a ON a.film=? AND a.id=r.value
       WHERE json_extract(a.data,'$.kind')='image' AND json_extract(a.data,'$.mediaId') IS NOT NULL
       ORDER BY CAST(r.key AS INTEGER)`,
        JSON.stringify(job.refs),
        job.filmId,
      )
      .toArray()
      .map(({ id, title, position }) => ({
        filmId: job.filmId,
        id,
        title,
        label: "图 " + position + " · " + title,
      }));
  }
  revisions(id: string, before: number) {
    return this.sql
      .exec<{ rev: number; updated: number }>(
        "SELECT rev,updated FROM film_card_revisions WHERE film=? AND rev<? ORDER BY rev DESC LIMIT 51",
        id,
        before,
      )
      .toArray();
  }
  revision(card: FilmCard, rev: number) {
    if (card.rev === rev)
      return { rev, updated: card.updated, spec: card.spec };
    const row = this.sql
      .exec<{ updated: number; spec: string }>(
        "SELECT updated,spec FROM film_card_revisions WHERE film=? AND rev=?",
        card.id,
        rev,
      )
      .toArray()[0];
    return row
      ? { rev, updated: row.updated, spec: JSON.parse(row.spec) as FilmSpec }
      : null;
  }
  private saveCard(f: FilmCard) {
    // Archive the last committed spec in the same transaction as the new revision.
    // This also captures an existing card the first time it is edited after upgrade.
    this.sql.exec(
      "INSERT OR IGNORE INTO film_card_revisions(film,rev,updated,spec) SELECT id,json_extract(data,'$.rev'),updated,json_extract(data,'$.spec') FROM film_cards WHERE id=? AND json_extract(data,'$.rev')<?",
      f.id,
      f.rev,
    );
    this.sql.exec(
      "INSERT OR REPLACE INTO film_cards VALUES(?,?,?,?,?)",
      f.id,
      f.canvas,
      f.section,
      f.updated,
      JSON.stringify(f),
    );
  }
  private saveJob(
    j: FilmJob,
    runner: string,
    due = Date.now(),
    token: string | null = null,
  ) {
    this.sql.exec(
      "INSERT INTO film_jobs VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,due=excluded.due,token=excluded.token,data=excluded.data",
      j.id,
      j.filmId,
      runner,
      j.state,
      due,
      token,
      JSON.stringify(j),
    );
  }
  private event(film: string, job: string | null, message: string) {
    this.sql.exec(
      "INSERT INTO film_events(film,job,at,message) VALUES(?,?,?,?)",
      film,
      job,
      Date.now(),
      message,
    );
  }
  addArtifact(film: string, a: FilmArtifact) {
    const old = this.artifact(film, a.id);
    check(
      !old || canonicalJson(old) === canonicalJson(a),
      "产物版本已被使用。",
      409,
    );
    if (!old)
      this.sql.exec(
        "INSERT INTO film_artifacts VALUES(?,?,?)",
        a.id,
        film,
        JSON.stringify(a),
      );
  }
  list(scope: FilmScope, before: number, offsetId: string) {
    return this.sql
      .exec<{ data: string }>(
        "SELECT data FROM film_cards WHERE canvas=? AND section=? AND (updated<? OR (updated=? AND id<?)) ORDER BY updated DESC,id DESC LIMIT 51",
        scope.canvas,
        scope.section,
        before,
        before,
        offsetId,
      )
      .toArray()
      .map(({ data }) => {
        const f = JSON.parse(data) as FilmCard;
        const j = this.data<FilmJob>(
          "SELECT data FROM film_jobs WHERE film=? AND json_extract(data,'$.stage')!='probe' ORDER BY rowid DESC LIMIT 1",
          f.id,
        );
        return {
          id: f.id,
          title: f.spec.title,
          goal: f.spec.goal,
          chatId: f.spec.chatId,
          updated: f.updated,
          state: j?.state ?? "draft",
          stage: j?.stage ?? null,
          ...(j?.refs.length ? { media: this.imagesForVersion(j) } : {}),
        };
      });
  }
  detail(f: FilmCard) {
    const read = (table: "film_jobs" | "film_artifacts") =>
      this.sql
        .exec<{ data: string }>(
          `SELECT data FROM ${table} WHERE film=? ORDER BY rowid`,
          f.id,
        )
        .toArray()
        .map((r) => JSON.parse(r.data));
    const jobs = (read("film_jobs") as FilmJob[]).sort(
      (a, b) => b.created - a.created,
    );
    return {
      card: f,
      jobs,
      artifacts: read("film_artifacts"),
      events: this.events(f.id, 0, true),
      capabilities: this.capabilities(f.binding?.runnerId),
    };
  }
  events(id: string, after: number, recent = false) {
    const rows = this.sql
      .exec(
        `SELECT seq,job,at,message FROM film_events WHERE film=? AND seq>? ORDER BY seq ${recent ? "DESC" : "ASC"} LIMIT 100`,
        id,
        after,
      )
      .toArray();
    return recent ? rows.reverse() : rows;
  }
  capabilities(runner?: string) {
    if (!runner) return null;
    const r = this.sql
      .exec<{ at: number; data: string }>(
        "SELECT at,data FROM film_capabilities WHERE runner=?",
        runner,
      )
      .toArray()[0];
    return r
      ? {
          at: r.at,
          ...JSON.parse(r.data),
          checks: this.sql
            .exec(
              "SELECT service,at,stage,ok FROM film_checks WHERE runner=? ORDER BY service",
              runner,
            )
            .toArray(),
        }
      : null;
  }
  advertise(runner: string, data: unknown) {
    const value = JSON.stringify(data),
      old = this.sql
        .exec<{ data: string; at: number }>(
          "SELECT data,at FROM film_capabilities WHERE runner=?",
          runner,
        )
        .toArray()[0];
    if (!old || old.data !== value || Date.now() - old.at > 60000)
      this.sql.exec(
        "INSERT OR REPLACE INTO film_capabilities VALUES(?,?,?)",
        runner,
        Date.now(),
        value,
      );
  }
  private once(id: string, input: unknown, fn: () => unknown) {
    check(filmId.safeParse(id).success, "操作编号无效。");
    const payload = canonicalJson(input);
    return this.tx(() => {
      const old = this.sql
        .exec<{ payload: string; result: string }>(
          "SELECT payload,result FROM film_receipts WHERE id=?",
          id,
        )
        .toArray()[0];
      if (old) {
        check(old.payload === payload, "相同操作编号对应不同输入。", 409);
        return JSON.parse(old.result);
      }
      const result = fn();
      this.sql.exec(
        "INSERT INTO film_receipts VALUES(?,?,?)",
        id,
        payload,
        JSON.stringify(result),
      );
      return result;
    });
  }
  private spec(input: unknown, film: string) {
    const result = filmSpecSchema.safeParse(input);
    check(result.success, "制作要求或参考图格式无效。");
    const s = result.data;
    if (s.scriptId)
      check(
        ["draft", "director", "final"].includes(
          this.artifact(film, s.scriptId)?.kind ?? "",
        ),
        "所选稿件不属于本片。",
        409,
      );
    for (const id of [...s.refs, ...s.inspiration])
      check(
        this.artifact(film, id)?.kind === "image",
        "参考图不存在或不属于本片。",
        409,
      );
    if (s.replaceRef)
      check(
        this.artifact(film, s.replaceRef)?.kind === "image",
        "要替换的参考图不属于本片。",
        409,
      );
    return s;
  }
  private startVersion(card: FilmCard, binding: FilmBinding | null) {
    check(
      binding && canonicalJson(card.binding) === canonicalJson(binding),
      "设备绑定已变化，请重新关联。",
      409,
    );
    const spec = card.spec;
    check(spec.brief.trim() || spec.scriptId, "请填写制作要求或选择稿件。");
    if (spec.goal === "image")
      check(spec.brief.trim(), "请填写要生成的静态参考图描述。");
    const script = spec.scriptId ? this.artifact(card.id, spec.scriptId) : null;
    if (spec.direct && spec.goal === "video")
      check(script?.kind === "final", "直接出片需要已采用的定稿。");
    const job = newFilmJob(
      crypto.randomUUID(),
      card.id,
      card.rev,
      spec,
      script ?? undefined,
    );
    job.binding = structuredClone(binding);
    this.saveJob(job, binding.runnerId);
    this.event(card.id, job.id, "已开始本版制作");
    return { id: card.id, jobId: job.id, revision: card.rev };
  }
  create(scope: FilmScope, input: any) {
    return this.once(
      input.requestId,
      { scope: [scope.canvas, scope.section], input },
      () => {
        const id = crypto.randomUUID(),
          now = Date.now();
        const f: FilmCard = {
          id,
          canvas: scope.canvas,
          section: scope.section,
          rev: 1,
          spec: this.spec(input.spec, id),
          binding: scope.binding,
          created: now,
          updated: now,
        };
        this.saveCard(f);
        this.event(id, null, "已保存制作简报");
        if (input.start === true) return this.startVersion(f, scope.binding);
        return { id, revision: f.rev };
      },
    );
  }
  act(scope: FilmScope, id: string, input: any) {
    return this.once(input.requestId, { id, input }, () => {
      const f = this.card(id);
      check(
        f && f.canvas === scope.canvas && f.section === scope.section,
        "制作卡不存在。",
        404,
      );
      const action = input.action;
      if (action === "revise_director") {
        check(
          input.baseRevision === f.rev &&
            scope.binding &&
            canonicalJson(scope.binding) === canonicalJson(f.binding),
          "工作版或设备已变化，请刷新。",
          409,
        );
        const previous = this.job(input.jobId),
          i = input.index;
        check(
          previous &&
            previous.filmId === id &&
            Number.isInteger(i) &&
            i >= 0 &&
            i < previous.directors.length,
          "请选择本版已有的导演岗位。",
        );
        const from = this.artifact(id, previous.directors[0])?.parents[0],
          script = from && this.artifact(id, from);
        check(script, "缺少最初的导演输入稿。", 409);
        const spec = this.spec(
          {
            ...previous.input,
            ...(input.spec ?? {}),
            scriptId: script.id,
            scriptAction: "refine",
            direct: false,
          },
          id,
        );
        check(
          spec.goal === "prompt" || spec.goal === "video",
          "导演修订需要选择提示词或成片目标。",
        );
        f.rev++;
        f.spec = spec;
        f.updated = Date.now();
        const j = newFilmJob(crypto.randomUUID(), id, f.rev, spec, script);
        j.stage = "director";
        j.director = i;
        j.directors = previous.directors.slice(0, i);
        j.binding = structuredClone(scope.binding);
        this.saveCard(f);
        this.saveJob(j, scope.binding.runnerId);
        this.event(id, j.id, "从指定导演岗位重新修订");
        return { id, jobId: j.id, revision: f.rev };
      }
      if (action === "probe") {
        check(
          scope.binding &&
            f.binding &&
            canonicalJson(scope.binding) === canonicalJson(f.binding),
          "请先关联制作设备。",
          409,
        );
        const j = newFilmJob(crypto.randomUUID(), id, f.rev, f.spec);
        j.state = "queued";
        j.stage = "probe";
        j.binding = structuredClone(scope.binding);
        this.saveJob(j, scope.binding.runnerId);
        this.event(id, j.id, "已安排 Pi 只读工具验证");
        return { id, jobId: j.id, revision: f.rev };
      }
      if (["start", "save", "import_script", "rebind"].includes(action)) {
        if (action === "start") {
          const prior = this.data<FilmJob>(
            "SELECT data FROM film_jobs WHERE film=? AND json_extract(data,'$.stage')!='probe' ORDER BY rowid DESC LIMIT 1",
            id,
          );
          const spec = this.spec(input.spec ?? f.spec, id);
          if (
            prior &&
            prior.edit === f.rev &&
            canonicalJson(prior.binding) === canonicalJson(scope.binding) &&
            ((input.baseRevision === prior.edit - 1 &&
              canonicalJson(prior.input) === canonicalJson(spec)) ||
              (input.baseRevision === f.rev &&
                !(input.newAttempt === true && prior.state === "uncertain") &&
                ["working", "queued", "uncertain", "waiting"].includes(
                  prior.state,
                ) &&
                canonicalJson(f.spec) === canonicalJson(spec)))
          )
            return { id, jobId: prior.id, revision: f.rev };
        }
        check(
          input.baseRevision === f.rev,
          "制作卡已有新版本，请刷新后查看。",
          409,
        );
        if (action === "rebind") {
          check(scope.binding, "请先绑定制作设备。", 409);
          f.binding = scope.binding;
        }
        if (action === "import_script") {
          if (input.spec) f.spec = this.spec(input.spec, id);
          const a = artifactSchema.safeParse({
            id: crypto.randomUUID(),
            kind: input.final ? "final" : "draft",
            title: input.final ? "用户定稿" : "用户初稿",
            text: input.text,
            source: "用户",
            parents: f.spec.scriptId ? [f.spec.scriptId] : [],
            details: { referenceOrder: [...f.spec.refs] },
          });
          check(a.success && a.data.text.trim(), "请输入完整稿件。");
          this.addArtifact(id, a.data);
          f.spec.scriptId = a.data.id;
        } else if (action !== "rebind")
          f.spec = this.spec(input.spec ?? f.spec, id);
        f.rev++;
        f.updated = Date.now();
        this.saveCard(f);
        if (action === "start") return this.startVersion(f, scope.binding);
        this.event(
          id,
          null,
          action === "rebind" ? "已重新关联设备" : "已保存工作版本",
        );
        return { id, revision: f.rev };
      }
      const j = this.job(input.jobId);
      check(j && j.filmId === id, "制作版本不存在。", 404);
      const row = this.sql
        .exec<{ runner: string; token: string | null; due: number }>(
          "SELECT runner,token,due FROM film_jobs WHERE id=?",
          j.id,
        )
        .one();
      if (action === "stop") {
        if (j.state === "done" || j.state === "stopped")
          return { id, jobId: j.id };
        j.stopped = true;
        if (j.remote) {
          j.message = "后续制作已停，继续查询已提交的原片。";
        } else if (j.stage === "submit" && j.dispatchStarted) {
          j.checkOnly = true;
          j.state = row.token ? "working" : "queued";
          j.message = "后续制作已停，正在核对原提交。";
        } else {
          j.state = "stopped";
          j.message = "后续制作已停止";
        }
      } else {
        check(
          scope.binding &&
            canonicalJson(scope.binding) === canonicalJson(f.binding) &&
            row.runner === scope.binding.runnerId,
          "原设备授权已变化。",
          409,
        );
        if (action === "refresh") {
          check(
            j.stage === "poll" || j.stage === "child" || j.stage === "deliver",
            "该版本没有待查询的任务。",
          );
          if (row.token || j.state === "done") return { id, jobId: j.id };
        } else if (action === "continue") {
          check(j.state === "waiting", "当前版本没有待确认的预览。", 409);
        } else if (action === "resume") {
          check(
            j.state === "stopped" && !j.remote && !j.dispatchStarted,
            "当前版本不能恢复。",
            409,
          );
          j.stopped = false;
          row.token = null;
        } else if (action === "retry") {
          check(j.state === "blocked", "请先核对当前步骤。", 409);
          j.checkOnly = false;
          j.attempt++;
        } else if (action === "reconcile") {
          check(j.state === "uncertain", "无需核对。", 409);
          j.checkOnly = true;
        } else check(false, "无效的制作操作。");
        j.state = "queued";
        j.message = "";
      }
      j.updated = Date.now();
      this.saveJob(j, row.runner, row.token ? row.due : Date.now(), row.token);
      this.event(id, j.id, j.message || "已安排继续处理");
      return { id, jobId: j.id };
    });
  }
  candidate(runner: string, protocol: number) {
    return this.data<FilmJob>(
      "SELECT data FROM film_jobs WHERE runner=? AND state IN ('queued','working') AND due<=? AND COALESCE(json_extract(data,'$.workflowVersion'),1)<=? ORDER BY due,rowid LIMIT 1",
      runner,
      Date.now(),
      protocol,
    );
  }
  block(j: FilmJob, runner: string, msg: string) {
    this.tx(() => {
      const row = this.sql
        .exec<{ data: string }>(
          "SELECT data FROM film_jobs WHERE id=? AND runner=? AND state IN ('working','queued') AND due<=?",
          j.id,
          runner,
          Date.now(),
        )
        .toArray()[0];
      if (!row) return;
      const current: FilmJob = JSON.parse(row.data);
      current.state = "blocked";
      current.message = msg;
      this.saveJob(current, runner);
      this.event(j.filmId, j.id, msg);
    });
  }
  claim(id: string, runner: string) {
    return this.tx(() => {
      const r = this.sql
        .exec<{ data: string; due: number; runner: string }>(
          "SELECT data,due,runner FROM film_jobs WHERE id=?",
          id,
        )
        .one();
      const j: FilmJob = JSON.parse(r.data);
      if (
        r.runner !== runner ||
        r.due > Date.now() ||
        !["queued", "working"].includes(j.state)
      )
        return null;
      const token = crypto.randomUUID(),
        f = this.card(j.filmId)!;
      j.state = "working";
      this.saveJob(j, runner, Date.now() + 90000, token);
      const ids = new Set(
        [
          j.adopted,
          j.input.replaceRef,
          ...j.refs,
          ...j.input.inspiration,
          ...j.directors,
        ].filter((v): v is string => !!v),
      );
      return {
        job: j,
        token,
        binding: j.binding,
        artifacts: [...ids].map((a) => this.artifact(f.id, a)).filter(Boolean),
      };
    });
  }
  held(runner: string, id: string, token: string, expired = false) {
    const r = this.sql
      .exec<{ data: string; due: number }>(
        "SELECT data,due FROM film_jobs WHERE id=? AND runner=? AND token=?",
        id,
        runner,
        token,
      )
      .toArray()[0];
    check(r && (expired || r.due > Date.now()), "制作执行权已变化。", 409);
    return JSON.parse(r.data) as FilmJob;
  }
  renew(runner: string, id: string, token: string) {
    const j = this.held(runner, id, token);
    if (j.state === "working")
      this.sql.exec(
        "UPDATE film_jobs SET due=? WHERE id=? AND token=?",
        Date.now() + 90000,
        id,
        token,
      );
    return { active: j.state === "working" };
  }
  codexCheckpoint(
    runner: string,
    id: string,
    token: string,
    proposed: FilmTurn,
  ) {
    return this.tx(() => {
      const job = this.held(runner, id, token);
      check(
        job.state === "working" &&
          !job.stopped &&
          job.workflowVersion === 2 &&
          ["director", "review", "image"].includes(job.stage),
        "本步骤不允许派给 Codex。",
        409,
      );
      const prior = job.codexTurn;
      if (prior && prior.step === job.step && prior.attempt === job.attempt) {
        if (!proposed.turnId) return { checkpoint: prior, dispatch: false };
        check(
          prior.threadId === proposed.threadId &&
            prior.requestId === proposed.requestId &&
            (!prior.turnId || prior.turnId === proposed.turnId),
          "Codex 回执与原轮次不一致。",
          409,
        );
        job.codexTurn = { ...prior, turnId: proposed.turnId };
      } else {
        check(
          !proposed.turnId && !job.checkOnly,
          "只能核对先前登记的 Codex 轮次。",
          409,
        );
        job.codexTurn = { ...proposed, step: job.step, attempt: job.attempt };
      }
      this.saveJob(job, runner, Date.now() + 90000, token);
      return { checkpoint: job.codexTurn, dispatch: !proposed.turnId };
    });
  }
  beginSubmit(
    runner: string,
    id: string,
    token: string,
    submission?: WaaoSubmission,
  ) {
    return this.tx(() => {
      const j = this.held(runner, id, token);
      check(
        j.state === "working" &&
          j.stage === "submit" &&
          !j.stopped &&
          !j.checkOnly &&
          !j.dispatchStarted,
        "提交状态已变化，请核对原操作。",
        409,
      );
      if (submission) {
        check(
          submission.scriptId === j.adopted &&
            submission.imports.length === j.refs.length &&
            submission.imports.every(
              (ref, index) =>
                ref.id === j.refs[index] && ref.position === index + 1,
            ),
          "WAAO 节点中的定稿或素材顺序与本版不一致。",
          409,
        );
        j.waaoSubmission = submission;
      } else {
        check(
          j.workflowVersion !== 2,
          "缺少本版 WAAO 节点上的实际提示词与素材记录。",
          409,
        );
      }
      j.dispatchStarted = true;
      this.saveJob(j, runner, Date.now() + 90000, token);
      return { accepted: true };
    });
  }
  report(runner: string, id: string, token: string, r: FilmResult) {
    return this.once("report-" + token, { id, runner, r }, () => {
      const j = this.held(runner, id, token, true),
        f = this.card(j.filmId)!;
      if (j.state === "stopped" && r.kind !== "submit") {
        this.saveJob(j, runner);
        return { ok: true };
      }
      if (
        j.workflowVersion === 2 &&
        "artifact" in r &&
        ["director", "review", "image"].includes(j.stage)
      ) {
        const ref = r.artifact.details.codex as
          (Partial<FilmTurn> & { itemId?: string }) | undefined;
        const turn = j.codexTurn;
        check(
          turn &&
            turn.step === j.step &&
            turn.turnId &&
            ref &&
            ref.threadId === turn.threadId &&
            ref.turnId === turn.turnId &&
            ref.requestId === turn.requestId &&
            typeof ref.itemId === "string" &&
            ref.itemId.length > 0,
          "创作回执缺少本次 Codex 轮次与产物编号。",
          409,
        );
      }
      if (j.workflowVersion === 2 && r.kind === "submit")
        check(
          j.dispatchStarted &&
            r.operation === j.id &&
            (!j.waaoSubmission || r.node === j.waaoSubmission.node),
          "WAAO 任务回执与本版提交节点不一致。",
          409,
        );
      const next = applyFilmResult(j, r);
      const service =
        j.stage === "draft"
          ? j.input.writer
          : (
              {
                probe: "deepseek",
                director: j.workflowVersion === 2 ? "codexText" : "director",
                review: j.workflowVersion === 2 ? "codexText" : "director",
                plan: "deepseek",
                image: j.workflowVersion === 2 ? "codexImage" : "gemini",
                submit: "waao",
                poll: "waao",
                deliver: "waao",
                codex: "codex",
                child: "codex",
              } as Record<string, string>
            )[j.stage];
      if (service && r.kind !== "pending" && !(r.kind === "poll" && !r.ready))
        this.sql.exec(
          "INSERT OR REPLACE INTO film_checks VALUES(?,?,?,?,?)",
          runner,
          service,
          Date.now(),
          j.stage,
          r.kind === "error" ? 0 : 1,
        );
      if (j.stage === "submit" && r.kind === "error" && !r.uncertain)
        next.dispatchStarted = false;
      if ("artifact" in r) {
        this.addArtifact(f.id, r.artifact);
      }
      if (f.rev === j.edit) {
        if (next.adopted) f.spec.scriptId = next.adopted;
        if (r.kind === "image") {
          f.spec.refs = [...next.refs];
          if (next.state === "done") f.spec.replaceRef = null;
        }
      }
      f.updated = Date.now();
      this.saveCard(f);
      const delay =
        r.kind === "pending" || (r.kind === "poll" && !r.ready)
          ? 12000
          : r.kind === "error" && r.temporary
            ? 20000
            : 0;
      this.saveJob(next, runner, Date.now() + delay);
      if (r.kind !== "pending" && !(r.kind === "poll" && !r.ready))
        this.event(
          f.id,
          id,
          next.message ||
            (
              {
                draft: "初稿已保存",
                director: "导演稿已保存",
                review: "文字质检已回传",
                plan: "素材清单已保存",
                image: "参考图已就绪",
                submit: "平台已受理",
                poll: "已取得成片",
                deliver: "原片已验证",
                codex: "已委派 Codex",
              } as Record<string, string>
            )[r.kind] ||
            "已更新制作状态",
        );
      return { ok: true };
    });
  }
}
