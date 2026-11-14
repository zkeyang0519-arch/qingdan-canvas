import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createExperienceServer } from "../scripts/lib/agent-experience-server.mjs";
import { createLocalRunnerApi } from "../scripts/lib/local-runner-api.mjs";

test("local Runner controls authenticate the browser and never accept a caller-chosen owner", async () => {
  const seen = [];
  let diagnosticReads = 0;
  let connectionStatus = "online";
  const worker = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        user:
          req.headers.cookie === "qd_session=alice"
            ? { id: "alice" }
            : req.headers.cookie === "qd_session=bob"
              ? { id: "bob" }
              : null,
      }),
    );
  });
  await new Promise((resolve) => worker.listen(0, "127.0.0.1", resolve));
  const upstream = `http://127.0.0.1:${worker.address().port}`;
  const controller = {
    status(ownerId) {
      seen.push(ownerId);
      if (ownerId !== "alice")
        throw Object.assign(Error("电脑已绑定另一个账号"), {
          code: "OWNER_MISMATCH",
        });
      return { paired: true, ownerId, connectionStatus };
    },
    registerWorkspace(ownerId, input) {
      seen.push({ ownerId, ...input });
      return { workspaces: [input] };
    },
    executionContext(ownerId, workspaceId) {
      seen.push({ ownerId, workspaceId });
      return { workspaceId };
    },
    listCodexSessions(ownerId, query) {
      this.status(ownerId);
      return {
        sessions: [{ threadId: "a", cwd: "D:/project" }],
        nextCursor: query.cursor || null,
        search: query.searchTerm,
      };
    },
    listCodexModels(ownerId, scope) {
      this.status(ownerId);
      return { models: [], scope };
    },
    verifyWorkspace(ownerId, scope) {
      this.status(ownerId);
      return { runnerId: scope.runnerId, workspace: { workspaceId: scope.workspaceId } };
    },
    selectCodexSession(ownerId, threadId) {
      this.status(ownerId);
      return {
        session: { threadId },
        workspace: { workspaceId: "verified-project" },
      };
    },
  };
  const runnerApi = createLocalRunnerApi({
    getDiagnostics: async () => {
      diagnosticReads++;
      connectionStatus = "offline";
      return {
        service: { version: "test", nodeVersion: process.versions.node },
        codex: { available: true, authenticated: true, version: "test" },
      };
    },
    getController: () => controller,
    upstream,
    prepareTrial: ({ ownerId, projectName }) => ({
      preparedFor: ownerId,
      ...(projectName === undefined ? {} : { projectName }),
    }),
    listTrials: ({ ownerId, state }) => {
      assert.equal(ownerId, "alice");
      assert.equal(state.ownerId, "alice");
      return [
        {
          workspaceId: "named",
          name: "个人网站",
          sectionId: "agent-execution-project-named",
        },
      ];
    },
  });
  const server = createExperienceServer({ service: {}, upstream, runnerApi });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    "x-qingdan-local": "1",
    "x-qd-account": "alice",
    cookie: "qd_session=alice",
    origin,
  };
  const request = (route, body, extra = {}) =>
    fetch(`${origin}/api/local-runner${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const diagnostics = await request("/diagnostics");
    assert.equal(diagnostics.status, 200);
    assert.equal(diagnostics.headers.get("cache-control"), "no-store");
    const result = await diagnostics.json();
    assert.equal(result.connectionStatus, "offline");
    assert.equal(result.codex.authenticated, true);
    assert.equal(result.service.nodeVersion, process.versions.node);
    assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
    assert.equal(diagnosticReads, 1);
    assert.equal(
      (
        await request("/diagnostics", undefined, {
          "x-qd-account": "bob",
          cookie: "qd_session=bob",
        })
      ).status,
      403,
    );
    assert.equal(
      (await request("/diagnostics", undefined, { cookie: "" })).status,
      401,
    );
    assert.equal((await request("/diagnostics", {})).status, 404);
    assert.equal(diagnosticReads, 1);
    seen.length = 0;
    assert.equal(
      (
        await request("/status", undefined, {
          origin: "https://foreign.invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (await request("/status", undefined, { "x-qingdan-local": "" })).status,
      403,
    );
    assert.equal(
      (
        await request("/pair", {
          pairingCode: "abcd",
          deviceName: "x".repeat(101),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/workspaces", {
          root: "D:/project",
          name: "x".repeat(101),
        })
      ).status,
      400,
    );
    assert.equal(
      (await request("/status", undefined, { cookie: "" })).status,
      401,
    );
    assert.equal(
      (await request("/status", undefined, { "x-qd-account": "bob" })).status,
      401,
    );
    assert.equal(seen.length, 0);
    for (const route of ["/codex/models", "/workspaces/verify"]) {
      const query = "?runnerId=runner&workspaceId=project";
      const response = await request(route + query);
      assert.equal(response.status, 200);
      const view = await response.json();
      assert.equal(view.scope?.workspaceId ?? view.workspace?.workspaceId, "project");
      assert.equal((await request(route + query + "&root=D:/arbitrary")).status, 400);
      assert.equal((await request(route + query + "&runnerId=other")).status, 400);
      assert.equal((await request(route + query, undefined, {
        "x-qd-account": "bob",
        cookie: "qd_session=bob",
      })).status, 403);
    }
    const mismatched = await request("/status", undefined, {
      cookie: "qd_session=bob",
      "x-qd-account": "bob",
    });
    assert.equal(mismatched.status, 403);
    assert.deepEqual(await mismatched.json(), {
      error: "电脑已绑定另一个账号",
      code: "OWNER_MISMATCH",
    });
    assert.deepEqual(await (await request("/status")).json(), {
      paired: true,
      ownerId: "alice",
      connectionStatus: "offline",
      executionProjects: [
        {
          workspaceId: "named",
          name: "个人网站",
          sectionId: "agent-execution-project-named",
        },
      ],
    });
    assert.equal(
      (await request("/workspaces", { root: "D:/project", ownerId: "bob" }))
        .status,
      400,
    );
    assert.equal(
      (
        await request("/workspaces", {
          root: "D:/project",
          command: "arbitrary",
        })
      ).status,
      400,
    );
    assert.equal(
      (await request("/workspaces", { root: "D:/project", name: "当前项目" }))
        .status,
      200,
    );
    assert.deepEqual(seen.at(-1), {
      ownerId: "alice",
      root: "D:/project",
      name: "当前项目",
    });
    assert.equal(
      (
        await request("/execution/context", {
          workspaceId: "project",
          ownerId: "bob",
        })
      ).status,
      400,
    );
    assert.equal(
      (await request("/execution/trial", { root: "D:/arbitrary" })).status,
      400,
    );
    assert.equal(
      (await request("/execution/context", { workspaceId: "project" })).status,
      200,
    );
    assert.deepEqual(seen.at(-1), { ownerId: "alice", workspaceId: "project" });
    assert.deepEqual(await (await request("/execution/trial", {})).json(), {
      preparedFor: "alice",
    });
    assert.deepEqual(
      await (
        await request("/execution/trial", { projectName: "  个人网站  " })
      ).json(),
      { preparedFor: "alice", projectName: "个人网站" },
    );
    assert.equal(
      (await request("/execution/trial", { projectName: "a".repeat(61) }))
        .status,
      400,
    );
    assert.deepEqual(
      await (
        await request("/codex/sessions?cursor=next&searchTerm=site")
      ).json(),
      {
        sessions: [{ threadId: "a", cwd: "D:/project" }],
        nextCursor: "next",
        search: "site",
      },
    );
    assert.equal(
      (await request("/codex/sessions", undefined, { cookie: "" })).status,
      401,
    );
    assert.equal(
      (
        await request("/codex/sessions", undefined, {
          cookie: "qd_session=bob",
          "x-qd-account": "bob",
        })
      ).status,
      403,
    );
    assert.equal((await request("/codex/sessions?ownerId=bob")).status, 400);
    assert.equal(
      (await request("/codex/sessions?searchTerm=" + "x".repeat(201))).status,
      400,
    );
    assert.equal(
      (await request("/codex/sessions?cursor=" + "x".repeat(4097))).status,
      400,
    );
    assert.equal(
      (await request("/codex/select", { threadId: "a", root: "D:/arbitrary" }))
        .status,
      400,
    );
    assert.equal(
      (await request("/codex/select", { threadId: "a", ownerId: "bob" }))
        .status,
      400,
    );
    assert.equal(
      (await request("/codex/select", { threadId: "" })).status,
      400,
    );
    assert.deepEqual(
      await (await request("/codex/select", { threadId: "a" })).json(),
      {
        session: { threadId: "a" },
        workspace: { workspaceId: "verified-project" },
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => worker.close(resolve));
  }
});

test("device reset obtains revocation evidence from the fixed authenticated upstream", async (t) => {
  let deviceStatus = "revoked",
    deviceOwner = "alice",
    status = 200,
    requested = [];
  const worker = createServer((req, res) => {
    requested.push({
      url: req.url,
      cookie: req.headers.cookie,
      account: req.headers["x-qd-account"],
    });
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/session")
      return res.end(
        JSON.stringify({
          user: {
            id: req.headers.cookie === "qd_session=bob" ? "bob" : "alice",
          },
        }),
      );
    res.statusCode = status;
    res.end(
      JSON.stringify({
        enabled: true,
        devices: [
          {
            runnerId: "old-device",
            ownerId: deviceOwner,
            status: deviceStatus,
            authEpoch: 2,
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => worker.listen(0, "127.0.0.1", resolve));
  const upstream = "http://127.0.0.1:" + worker.address().port;
  let targetOrigin = upstream;
  const controller = {
    async reset(ownerId, expectedRunnerId, verify) {
      if (ownerId !== "alice")
        throw Object.assign(Error("wrong owner"), { code: "OWNER_MISMATCH" });
      assert.equal(expectedRunnerId, "old-device");
      const proof = await verify({
        runnerId: expectedRunnerId,
        ownerId,
        serverOrigin: targetOrigin,
        authEpoch: 1,
      });
      assert.deepEqual(proof, {
        runnerId: "old-device",
        ownerId: "alice",
        serverOrigin: upstream,
        status: "revoked",
        authEpoch: 2,
      });
      return { paired: false };
    },
  };
  const server = createExperienceServer({
    service: {},
    upstream,
    runnerApi: createLocalRunnerApi({
      upstream,
      getController: () => controller,
    }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => worker.close(resolve));
  });
  const origin = "http://127.0.0.1:" + server.address().port;
  const request = (body, headers = {}) =>
    fetch(origin + "/api/local-runner/reset", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-qingdan-local": "1",
        "x-qd-account": "alice",
        cookie: "qd_session=alice",
        origin,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  assert.equal((await request({ expectedRunnerId: "old-device" })).status, 200);
  assert.deepEqual(requested.at(-1), {
    url: "/api/agent/devices",
    cookie: "qd_session=alice",
    account: "alice",
  });
  for (const extra of [
    { ownerId: "bob" },
    { proof: { status: "revoked" } },
    { upstream: "https://foreign.invalid" },
    { revoked: true },
  ])
    assert.equal(
      (await request({ expectedRunnerId: "old-device", ...extra })).status,
      400,
    );
  assert.equal(
    (
      await request(
        { expectedRunnerId: "old-device" },
        { "x-qd-account": "bob" },
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await request(
        { expectedRunnerId: "old-device" },
        { "x-qd-account": "bob", cookie: "qd_session=bob" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        { expectedRunnerId: "old-device" },
        { origin: "https://foreign.invalid" },
      )
    ).status,
    403,
  );
  targetOrigin = "https://different-device-server.invalid";
  assert.equal((await request({ expectedRunnerId: "old-device" })).status, 403);
  targetOrigin = upstream;
  status = 503;
  assert.equal((await request({ expectedRunnerId: "old-device" })).status, 503);
  status = 200;
  deviceOwner = "bob";
  assert.equal((await request({ expectedRunnerId: "old-device" })).status, 409);
});
