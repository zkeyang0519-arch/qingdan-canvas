import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";
import { RunnerHub as DevelopmentRunnerHub } from "./execution/hub";
import { AgentChatRouter as DevelopmentAgentChatRouter } from "./agent/chat-router";
import {
  agentDevelopmentEnabled,
  agentUnavailable,
} from "./agent-availability";

interface AgentRuntime {
  fetch(request: Request): Response | Promise<Response>;
  alarm?(): void | Promise<void>;
  webSocketMessage?(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): void | Promise<void>;
  webSocketClose?(
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): void | Promise<void>;
  webSocketError?(socket: WebSocket, error: unknown): void | Promise<void>;
}

function guardedAgent(
  Implementation: new (ctx: DurableObjectState, env: Env) => AgentRuntime,
) {
  return class extends DurableObject<Env> {
    protected active?: AgentRuntime;
    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);
      // Do not construct a development implementation in production: its
      // constructor can initialize storage before any HTTP route is reached.
      if (agentDevelopmentEnabled(env))
        this.active = new Implementation(ctx, env);
    }
    fetch(request: Request) {
      return this.active ? this.active.fetch(request) : agentUnavailable();
    }
    alarm() {
      return this.active?.alarm?.();
    }
    webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
      return this.active
        ? this.active.webSocketMessage?.(socket, message)
        : this.closeRetiredSocket(socket);
    }
    webSocketError(socket: WebSocket, error: unknown) {
      return this.active
        ? this.active.webSocketError?.(socket, error)
        : this.closeRetiredSocket(socket);
    }
    webSocketClose(
      socket: WebSocket,
      code: number,
      reason: string,
      wasClean: boolean,
    ) {
      return this.active?.webSocketClose?.(socket, code, reason, wasClean);
    }
    private closeRetiredSocket(socket: WebSocket) {
      try {
        socket.close(1001, "Agent is under development");
      } catch {
        /* Already closed. */
      }
    }
  };
}

// Keep deployed namespace class names and migration history unchanged.
export class RunnerHub extends guardedAgent(DevelopmentRunnerHub) {}
export class AgentChatRouter extends guardedAgent(DevelopmentAgentChatRouter) {
  piRetentionResult(
    ...args: Parameters<DevelopmentAgentChatRouter["piRetentionResult"]>
  ) {
    return this.active
      ? (this.active as DevelopmentAgentChatRouter).piRetentionResult(...args)
      : { error: "Agent 尚未在此环境开放。", status: 404 };
  }
  executionRetentionResult(
    ...args: Parameters<DevelopmentAgentChatRouter["executionRetentionResult"]>
  ) {
    return this.active
      ? (this.active as DevelopmentAgentChatRouter).executionRetentionResult(
          ...args,
        )
      : { error: "Agent 尚未在此环境开放。", status: 404 };
  }
  runtimeActivityResult(
    ...args: Parameters<DevelopmentAgentChatRouter["runtimeActivityResult"]>
  ) {
    if (!this.active)
      return { tasks: [], unknown: ["Agent 尚未在此环境开放。"] };
    return (this.active as DevelopmentAgentChatRouter).runtimeActivityResult(
      ...args,
    );
  }
  piScopeResult(
    ...args: Parameters<DevelopmentAgentChatRouter["piScopeResult"]>
  ) {
    return this.active
      ? (this.active as DevelopmentAgentChatRouter).piScopeResult(...args)
      : { error: "Agent 尚未在此环境开放。", status: 404 };
  }
  piContextResult(jobId: string) {
    return this.active
      ? (this.active as DevelopmentAgentChatRouter).piContextResult(jobId)
      : { error: "Agent 尚未在此环境开放。", status: 404 };
  }
}
