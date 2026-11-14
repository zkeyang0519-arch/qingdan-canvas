import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { CodexSupervisor, type ProcessOptions } from "./supervisor";
import { RpcError, RunnerError } from "./errors";
import type { InitializeParams } from "./protocol/InitializeParams";
import type { InitializeResponse } from "./protocol/InitializeResponse";
import type { GetAccountParams } from "./protocol/v2/GetAccountParams";
import type { GetAccountResponse } from "./protocol/v2/GetAccountResponse";
import type { ConfigReadParams } from "./protocol/v2/ConfigReadParams";
import type { ConfigReadResponse } from "./protocol/v2/ConfigReadResponse";
import type { ModelListParams } from "./protocol/v2/ModelListParams";
import type { ModelListResponse } from "./protocol/v2/ModelListResponse";
import type { ThreadStartParams } from "./protocol/v2/ThreadStartParams";
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse";
import type { ThreadResumeParams } from "./protocol/v2/ThreadResumeParams";
import type { ThreadResumeResponse } from "./protocol/v2/ThreadResumeResponse";
import type { ThreadReadParams } from "./protocol/v2/ThreadReadParams";
import type { ThreadReadResponse } from "./protocol/v2/ThreadReadResponse";
import type { ThreadListParams } from "./protocol/v2/ThreadListParams";
import type { ThreadListResponse } from "./protocol/v2/ThreadListResponse";
import type { ThreadTurnsListParams } from "./protocol/v2/ThreadTurnsListParams";
import type { ThreadTurnsListResponse } from "./protocol/v2/ThreadTurnsListResponse";
import type { ThreadItemsListParams } from "./protocol/v2/ThreadItemsListParams";
import type { ThreadItemsListResponse } from "./protocol/v2/ThreadItemsListResponse";
import type { ThreadSetNameParams } from "./protocol/v2/ThreadSetNameParams";
import type { TurnStartParams } from "./protocol/v2/TurnStartParams";
import type { TurnStartResponse } from "./protocol/v2/TurnStartResponse";
import type { TurnSteerParams } from "./protocol/v2/TurnSteerParams";
import type { TurnSteerResponse } from "./protocol/v2/TurnSteerResponse";
import type { TurnInterruptParams } from "./protocol/v2/TurnInterruptParams";
import type { ThreadBackgroundTerminalsListParams } from "./protocol/v2/ThreadBackgroundTerminalsListParams";
import type { ThreadBackgroundTerminalsListResponse } from "./protocol/v2/ThreadBackgroundTerminalsListResponse";
import type { ThreadBackgroundTerminalsTerminateParams } from "./protocol/v2/ThreadBackgroundTerminalsTerminateParams";
import type { ThreadBackgroundTerminalsTerminateResponse } from "./protocol/v2/ThreadBackgroundTerminalsTerminateResponse";

type Methods = {
  "config/read": [ConfigReadParams, ConfigReadResponse];
  "model/list": [ModelListParams, ModelListResponse];
  "thread/backgroundTerminals/list": [
    ThreadBackgroundTerminalsListParams,
    ThreadBackgroundTerminalsListResponse,
  ];
  "thread/backgroundTerminals/terminate": [
    ThreadBackgroundTerminalsTerminateParams,
    ThreadBackgroundTerminalsTerminateResponse,
  ];
  initialize: [InitializeParams, InitializeResponse];
  "account/read": [GetAccountParams, GetAccountResponse];
  "thread/start": [ThreadStartParams, ThreadStartResponse];
  "thread/resume": [ThreadResumeParams, ThreadResumeResponse];
  "thread/read": [ThreadReadParams, ThreadReadResponse];
  "thread/list": [ThreadListParams, ThreadListResponse];
  "thread/turns/list": [ThreadTurnsListParams, ThreadTurnsListResponse];
  "thread/items/list": [ThreadItemsListParams, ThreadItemsListResponse];
  "thread/name/set": [ThreadSetNameParams, Record<string, never>];
  "turn/start": [TurnStartParams, TurnStartResponse];
  "turn/steer": [TurnSteerParams, TurnSteerResponse];
  "turn/interrupt": [TurnInterruptParams, Record<string, never>];
};
export type RpcPacket = {
  id?: string | number;
  method: string;
  params: Record<string, any>;
};
export class CodexClient extends EventEmitter {
  private supervisor: CodexSupervisor;
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  private nextId = 0;
  private disconnected = false;
  private ready = false;
  constructor(private options: ProcessOptions & { requestTimeoutMs?: number }) {
    super();
    this.supervisor = new CodexSupervisor(options);
  }
  async connect() {
    this.child = await this.supervisor.start();
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    this.child.stdout.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 8_000_000)
        return this.fail(
          new RunnerError(
            "CODEX_PROTOCOL_ERROR",
            "Codex message exceeded 8 MB",
          ),
        );
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          this.receive(JSON.parse(line));
        } catch {
          this.fail(
            new RunnerError(
              "CODEX_PROTOCOL_ERROR",
              "Malformed app-server message",
            ),
          );
        }
      }
    });
    // Drain diagnostic output without storing auth-bearing stderr in run results.
    this.child.stderr.on("data", () => {});
    this.child.once("error", (error) => this.fail(error));
    this.child.once("exit", () =>
      this.fail(
        new RunnerError(
          "CODEX_DISCONNECTED",
          "Codex 子进程已退出，运行状态需要核实。",
        ),
      ),
    );
    this.child.stdin.on("error", (error) => this.fail(error));
    const initialized = await this.request("initialize", {
      clientInfo: {
        name: "qingdan_runner",
        title: "轻单 Runner",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.write({ method: "initialized", params: {} });
    this.ready = true;
    return initialized;
  }
  private receive(message: Record<string, any>) {
    if (!message || typeof message !== "object" || Array.isArray(message))
      throw Error();
    if (typeof message.method === "string") {
      this.emit(message.id === undefined ? "notification" : "request", message);
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(message.id);
    if (message.error)
      entry.reject(new RpcError(message.error.code, message.error.message));
    else if ("result" in message) entry.resolve(message.result);
    else
      entry.reject(
        new RunnerError("CODEX_PROTOCOL_ERROR", "Missing JSON-RPC result"),
      );
  }
  private fail(error: Error) {
    if (this.disconnected) return;
    this.disconnected = true;
    this.ready = false;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.emit("disconnect", error);
  }
  private write(message: unknown) {
    if (this.disconnected || !this.child?.stdin.writable)
      throw new RunnerError("CODEX_DISCONNECTED", "Codex is not connected");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request<K extends keyof Methods>(
    method: K,
    params: Methods[K][0],
  ): Promise<Methods[K][1]> {
    if (!this.ready && method !== "initialize")
      return Promise.reject(
        new RunnerError(
          "CODEX_NOT_INITIALIZED",
          "Initialize Codex before requests",
        ),
      );
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new RunnerError(
            "CODEX_REQUEST_TIMEOUT",
            `${method} 响应超时；请求可能已执行。`,
          ),
        );
      }, this.options.requestTimeoutMs ?? 30000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as Methods[K][1]),
        reject,
        timer,
      });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  respond(id: string | number, result: unknown) {
    this.write({ id, result });
  }
  rejectRequest(id: string | number, message: string) {
    this.write({ id, error: { code: -32601, message } });
  }
  async close() {
    await this.supervisor.stop();
    this.fail(new RunnerError("CODEX_CLOSED", "Codex client closed"));
  }
}
