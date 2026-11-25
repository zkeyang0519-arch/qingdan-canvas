import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import {
  completeMcpSignIn,
  createMcpAuthProvider,
  McpOAuthAuthorizationRequiredError,
  startMcpSignIn,
} from "@earendil-works/pi-mcp/oauth";

export function mcpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error("请输入完整的 MCP 服务地址。");
  }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
  )
    throw Error("请使用 HTTPS 地址。本机回环地址也可以使用 HTTP。");
  return url.href;
}

export function authRequired(error) {
  return (
    error instanceof McpOAuthAuthorizationRequiredError ||
    error?.status === 401 ||
    error?.status === 403
  );
}

// One instance owns credentials for one immutable service URL. The model
// process gets tool definitions and results only. Token refreshes share a lock.
export function openMcpRemote(
  { id, url, authMode },
  origin,
  file,
  fetchImpl = fetch,
) {
  let refresh = Promise.resolve(),
    challenge,
    pending,
    signingIn = false,
    removed = false;
  const store = {
    load: async () => (await file.load()).oauth,
    save: (oauth) => {
      if (removed) throw Error("该连接已移除。");
      return file.save({ oauth });
    },
    withRefreshLock(fn) {
      const next = refresh.then(fn);
      refresh = next.catch(() => {});
      return next;
    },
  };
  const options = {
    serverUrl: url,
    redirectUrl: origin + "/local/mcp/callback/" + id,
    store,
    clientName: "轻单",
    settings: {},
  };
  const provider =
    authMode === "token"
      ? { token: async () => (await file.load()).token }
      : createMcpAuthProvider({
          ...options,
          settings: () => options.settings,
          onChallenge: (value) => {
            challenge = value;
          },
        });
  return {
    async setToken(token) {
      if (
        authMode !== "token" ||
        typeof token !== "string" ||
        !token.trim() ||
        token.length > 16384 ||
        /[\r\n]/.test(token)
      )
        throw Error("请输入有效的 Bearer Token。");
      await file.save({ token: token.trim() });
    },
    async connect(signal, beforeDispatch) {
      const client = new McpClient({
        name: "qingdan-pi",
        version: "1",
        requestTimeoutMs: 30000,
      });
      const transport = new StreamableHttpTransport({
        url,
        authProvider: provider,
        openGetStream: false,
        fetch(input, init) {
          if (removed) throw Error("该连接已移除。");
          const destination = mcpUrl(input);
          if (beforeDispatch && destination === url && init?.method === "POST")
            beforeDispatch(JSON.parse(init.body));
          return fetchImpl(destination, {
            ...init,
            redirect: "error",
            signal: AbortSignal.any(
              [signal, AbortSignal.timeout(60000), init?.signal].filter(
                Boolean,
              ),
            ),
          });
        },
      });
      try {
        await client.connect(transport);
        return client;
      } catch (error) {
        await client.close().catch(() => {});
        throw error;
      }
    },
    async login() {
      if (authMode !== "auto" || signingIn)
        throw Error("请稍后重新连接此服务。");
      signingIn = true;
      try {
        const start = await startMcpSignIn({
          ...options,
          challenge,
          signal: AbortSignal.timeout(45000),
        });
        pending = null;
        if (start.kind === "authorized") return {};
        const url = mcpUrl(start.authorizationUrl);
        pending = { start, until: Date.now() + 600000 };
        return { url };
      } finally {
        signingIn = false;
      }
    },
    async finish(params) {
      if (
        !pending ||
        pending.until <= Date.now() ||
        pending.start.state !== params.get("state")
      )
        throw Error("授权请求已过期，请回到轻单重新连接。");
      const { start } = pending;
      pending = null;
      if (params.has("error") || !params.get("code"))
        throw Error("本次授权已取消。");
      await completeMcpSignIn({
        ...options,
        authorization: start,
        signal: AbortSignal.timeout(45000),
        response: {
          code: params.get("code"),
          state: params.get("state"),
          iss: params.get("iss") ?? undefined,
        },
      });
    },
    async clear() {
      removed = true;
      pending = null;
      await refresh;
      await file.clear();
    },
  };
}
