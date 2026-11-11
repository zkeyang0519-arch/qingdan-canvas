import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createExperienceServer } from "../scripts/lib/agent-experience-server.mjs";
import { createLocalRunnerApi } from "../scripts/lib/local-runner-api.mjs";

test("ordinary local pages can preflight, list and select sessions through the authenticated bridge; other origins stay blocked", async (t) => {
  const worker = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url !== "/api/session") {
      res.statusCode = 404;
      res.end('{"error":"接口不存在。"}');
      return;
    }
    res.end(
      JSON.stringify({
        user:
          req.headers.cookie === "qd_session=alice" ? { id: "alice" } : null,
      }),
    );
  });
  await new Promise((resolve) => worker.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => worker.close(resolve)));
  const pageOrigin = `http://127.0.0.1:${worker.address().port}`;
  const calls = [];
  const controller = {
    listCodexSessions(ownerId) {
      calls.push(["list", ownerId]);
      return {
        sessions: [{ threadId: "existing", cwd: "D:/project" }],
        nextCursor: null,
      };
    },
    selectCodexSession(ownerId, threadId) {
      calls.push(["select", ownerId, threadId]);
      return { workspace: { workspaceId: "verified" } };
    },
  };
  const server = createExperienceServer({
    service: {},
    upstream: pageOrigin,
    runnerApi: createLocalRunnerApi({
      upstream: pageOrigin,
      getController: () => controller,
    }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const bridgeOrigin = `http://127.0.0.1:${server.address().port}`;
  const preflight = (
    origin = pageOrigin,
    method = "GET",
    headers = "x-qingdan-local,x-qd-account",
    route = "/api/local-runner/codex/sessions",
  ) =>
    fetch(bridgeOrigin + route, {
      method: "OPTIONS",
      headers: {
        origin,
        "Access-Control-Request-Method": method,
        "Access-Control-Request-Headers": headers,
        "Sec-Fetch-Site": "same-site",
      },
    });
  const headers = {
    origin: pageOrigin,
    cookie: "qd_session=alice",
    "X-Qingdan-Local": "1",
    "X-QD-Account": "alice",
    "Sec-Fetch-Site": "same-site",
  };
  const allowed = await preflight();
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), pageOrigin);
  assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");
  assert.match(allowed.headers.get("vary"), /Origin/i);
  assert.equal(calls.length, 0, "preflight must not read or mutate a session");
  const listed = await fetch(
    bridgeOrigin + "/api/local-runner/codex/sessions",
    { headers },
  );
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("access-control-allow-origin"), pageOrigin);
  assert.equal((await listed.json()).sessions[0].threadId, "existing");
  assert.equal(
    (
      await preflight(
        pageOrigin,
        "POST",
        "content-type,x-qingdan-local,x-qd-account",
      )
    ).status,
    204,
  );
  const selected = await fetch(
    bridgeOrigin + "/api/local-runner/codex/select",
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ threadId: "existing" }),
    },
  );
  assert.equal(selected.status, 200);
  assert.deepEqual(await selected.json(), {
    workspace: { workspaceId: "verified" },
  });
  assert.deepEqual(calls, [
    ["list", "alice"],
    ["select", "alice", "existing"],
  ]);
  const signedOut = await fetch(
    bridgeOrigin + "/api/local-runner/codex/sessions",
    { headers: { ...headers, cookie: "" } },
  );
  assert.equal(signedOut.status, 401);
  assert.equal(
    signedOut.headers.get("access-control-allow-origin"),
    pageOrigin,
  );
  for (const origin of [
    "https://evil.test",
    "http://127.0.0.1:9999",
    `${pageOrigin}.evil.test`,
    "null",
  ]) {
    const response = await preflight(origin);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  assert.equal((await preflight(pageOrigin, "DELETE")).status, 403);
  assert.equal(
    (await preflight(pageOrigin, "GET", "authorization")).status,
    403,
  );
  assert.equal(
    (
      await preflight(
        pageOrigin,
        "GET",
        "x-qingdan-local",
        "/api/local-codex/connection",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(bridgeOrigin + "/api/local-runner/codex/sessions", {
        headers: { ...headers, "X-Qingdan-Local": "" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(bridgeOrigin + "/api/local-runner/codex/sessions", {
        headers: { ...headers, "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
    403,
  );
  assert.equal(calls.length, 2);
});
