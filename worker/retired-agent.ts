// Cloudflare still owns namespaces created by v2/v3. Keep their exported class
// names without restoring Agent routes, bindings, execution, or storage access.
class RetiredAgent implements DurableObject {
  fetch(): Response {
    return Response.json(
      { error: "Agent functionality is disabled." },
      { status: 410 },
    );
  }

  alarm(): void {
    // Acknowledge an existing alarm without executing or scheduling more work.
  }

  webSocketMessage(socket: WebSocket): void {
    this.close(socket);
  }

  webSocketError(socket: WebSocket): void {
    this.close(socket);
  }

  webSocketClose(): void {}

  private close(socket: WebSocket): void {
    try {
      socket.close(1001, "Agent functionality is disabled.");
    } catch {
      // The peer may already have closed the retired connection.
    }
  }
}

export class RunnerHub extends RetiredAgent {}
export class AgentChatRouter extends RetiredAgent {}
