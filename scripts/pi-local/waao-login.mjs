import { auth } from "@modelcontextprotocol/client";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { mcpReturnPath } from "../../shared/agent/oauth-callback.mjs";
import {
  WindowsCredentialManager,
  credentialTarget,
} from "../../runner/credentials.ts";
import { stableId } from "../../runner/film/journal.mjs";
import {
  waaoIssuer,
  waaoMcpUrl,
  waaoScopes,
} from "../../runner/film/waao-mcp.mjs";

function accountFetch(url, init, fetchImpl) {
  const dest = new URL(
    typeof url === "string" || url instanceof URL ? url : url.url,
  );
  if (![waaoIssuer, new URL(waaoMcpUrl).origin].includes(dest.origin))
    throw Error("WAAO 授权服务地址与官网不符。");
  return fetchImpl(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.any(
      [init?.signal, AbortSignal.timeout(15000)].filter(Boolean),
    ),
  });
}

// Encrypt the OAuth record with a key owned by this pilot in the Windows
// credential vault. On Unix the private pilot directory and file are mode 0700/0600.
export function credentialFile(dir, filename, target) {
  const file = path.join(dir, filename);
  const vault = new WindowsCredentialManager();
  let key;
  const getKey = async (create) => {
    if (key) return key;
    let raw = await vault.read(target);
    if (!raw && create) {
      raw = randomBytes(32).toString("base64");
      await vault.write(target, raw);
    }
    if (!raw) throw Error("请重新授权，以恢复本机连接。");
    return (key = Buffer.from(raw, "base64"));
  };
  return {
    async load() {
      let bytes;
      try {
        bytes = await readFile(file);
      } catch (e) {
        if (e.code === "ENOENT") return {};
        throw e;
      }
      if (process.platform === "win32") {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          await getKey(false),
          bytes.subarray(0, 12),
        );
        decipher.setAuthTag(bytes.subarray(12, 28));
        bytes = Buffer.concat([
          decipher.update(bytes.subarray(28)),
          decipher.final(),
        ]);
      }
      return JSON.parse(bytes.toString("utf8"));
    },
    async save(state) {
      let bytes = Buffer.from(JSON.stringify(state));
      if (process.platform === "win32") {
        const nonce = randomBytes(12),
          cipher = createCipheriv("aes-256-gcm", await getKey(true), nonce);
        const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
        bytes = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
      }
      await writeFile(file + ".part", bytes, { mode: 0o600 });
      await rename(file + ".part", file);
    },
    async clear() {
      const existed = await unlink(file)
        .then(() => true)
        .catch((error) => {
          if (error.code !== "ENOENT") throw error;
          return false;
        });
      if (process.platform === "win32" && (key || existed))
        await vault.delete(target);
      key = undefined;
    },
  };
}

export async function waaoLogin(
  dir,
  origin,
  configuredToken,
  {
    store,
    fetchImpl = fetch,
    credentialOrigin = origin,
    clientName = "轻单 Pi",
  } = {},
) {
  origin = new URL(origin).origin;
  credentialOrigin = new URL(credentialOrigin).origin;
  const file =
    store ??
    credentialFile(
      dir,
      "waao-oauth.private",
      credentialTarget(
        new URL(waaoMcpUrl).origin,
        stableId("pi-web-oauth", dir, credentialOrigin),
      ),
    );
  const saved = await file.load();
  const configuredDigest = configuredToken
    ? createHash("sha256").update(configuredToken).digest("hex")
    : null;
  let pending = saved.pending?.until > Date.now() ? saved.pending : null,
    updating,
    refreshing,
    rejectedAccess,
    configuredRejected =
      !!configuredDigest && saved.rejectedConfigured === configuredDigest;
  const usableConfigured = () => configuredToken && !configuredRejected;
  const options = {
    serverUrl: waaoMcpUrl,
    resourceMetadataUrl: new URL(
      "https://www.waao.studio/.well-known/oauth-protected-resource/api/mcp",
    ),
    scope: waaoScopes,
    fetchFn: (url, init) => accountFetch(url, init, fetchImpl),
  };
  const provider = {
    redirectUrl: origin + "/local/waao/callback",
    clientMetadata: {
      client_name: clientName,
      redirect_uris: [origin + "/local/waao/callback"],
      scope: waaoScopes,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    state: () => pending?.nonce,
    clientInformation: () => saved.client,
    saveClientInformation: async (v) => {
      saved.client = v;
      await file.save(saved);
    },
    tokens: () => saved.tokens,
    saveTokens: async (v) => {
      saved.tokens = v;
      rejectedAccess = undefined;
      saved.expires = Date.now() + 1000 * (v.expires_in || 3600);
      await file.save(saved);
    },
    discoveryState: () => saved.discovery,
    saveDiscoveryState: async (v) => {
      saved.discovery = v;
      await file.save(saved);
    },
    saveCodeVerifier: (v) => {
      if (!pending) throw Error("请从轻单发起 WAAO 登录。");
      pending.verifier = v;
    },
    codeVerifier: () => {
      if (!pending?.verifier) throw Error("WAAO 登录已过期。");
      return pending.verifier;
    },
    redirectToAuthorization: (url) => {
      if (url.origin !== waaoIssuer || !pending)
        throw Error("请从轻单重新发起 WAAO 网页授权。");
      pending.url = url.href;
    },
    invalidateCredentials: async (scope) => {
      if (["all", "client"].includes(scope)) delete saved.client;
      if (["all", "tokens"].includes(scope)) delete saved.tokens;
      if (["all", "discovery"].includes(scope)) delete saved.discovery;
      if (pending && ["all", "verifier"].includes(scope))
        delete pending.verifier;
      await file.save(saved);
    },
  };
  async function exclusive(fn) {
    if (updating) throw Error("WAAO 连接正在更新，请稍后再试。");
    updating = Promise.resolve().then(fn);
    try {
      return await updating;
    } finally {
      updating = null;
    }
  }
  return {
    clientId: () =>
      usableConfigured() ? null : saved.client?.client_id || null,
    status: () => ({
      configured: !!(configuredToken || saved.tokens || pending),
      connected: !!(
        usableConfigured() ||
        (saved.tokens?.access_token &&
          saved.tokens.access_token !== rejectedAccess &&
          (saved.expires > Date.now() || saved.tokens.refresh_token))
      ),
      kind: "web-mcp",
    }),
    begin: (returnTo) =>
      exclusive(async () => {
        if (usableConfigured()) return { connected: true };
        if (configuredRejected) saved.rejectedConfigured = configuredDigest;
        const registered = saved.client?.redirect_uris;
        if (
          saved.client &&
          (!Array.isArray(registered) ||
            !registered.includes(provider.redirectUrl))
        ) {
          // Starting a fresh login may replace an incomplete registration, but
          // must not silently destroy a working connection owned by another entry.
          if (saved.tokens?.access_token || saved.tokens?.refresh_token)
            throw Error(
              "这份 WAAO 授权属于另一个入口，请在当前入口使用独立连接。",
            );
          delete saved.client;
          delete saved.pending;
          pending = null;
          await file.save(saved);
        }
        if (
          pending?.url &&
          new URL(pending.url).searchParams.get("redirect_uri") !==
            provider.redirectUrl
        ) {
          pending = null;
          delete saved.pending;
          await file.save(saved);
        }
        if (pending?.url && pending.until > Date.now())
          return { url: pending.url };
        pending = {
          nonce: randomBytes(32).toString("base64url"),
          until: Date.now() + 10 * 60000,
          returnTo: mcpReturnPath(returnTo),
        };
        try {
          const result = await auth(provider, {
            ...options,
            forceReauthorization: true,
          });
          if (result === "AUTHORIZED") {
            pending = null;
            delete saved.pending;
            await file.save(saved);
            return { connected: true };
          }
          if (!pending.url) throw Error("WAAO 未返回网页登录地址。");
          saved.pending = pending;
          await file.save(saved);
          return { url: pending.url };
        } catch (error) {
          pending = null;
          throw error;
        }
      }),
    finish: (params) =>
      exclusive(async () => {
        if (
          !pending ||
          pending.until < Date.now() ||
          params.get("state") !== pending.nonce
        )
          throw Error("WAAO 登录请求已过期，请从轻单重新连接。");
        const returnTo = mcpReturnPath(pending.returnTo);
        try {
          if (params.has("error") || !params.get("code"))
            throw Error("本次 WAAO 授权未完成。");
          await auth(provider, {
            ...options,
            authorizationCode: params.get("code"),
            iss: params.get("iss") || undefined,
          });
        } finally {
          pending = null;
          delete saved.pending;
          await file.save(saved);
        }
        return { returnTo };
      }),
    rejected(token) {
      if (token === configuredToken) configuredRejected = true;
      if (token === saved.tokens?.access_token) rejectedAccess = token;
    },
    async token() {
      if (usableConfigured()) return configuredToken;
      if (!saved.tokens?.access_token) return null;
      if (
        saved.expires <= Date.now() + 30000 ||
        saved.tokens.access_token === rejectedAccess
      ) {
        if (!saved.tokens.refresh_token) return null;
        if (!refreshing)
          refreshing = exclusive(() => auth(provider, options)).finally(() => {
            refreshing = undefined;
          });
        await refreshing;
      }
      return saved.tokens?.access_token === rejectedAccess
        ? null
        : saved.tokens?.access_token;
    },
  };
}
