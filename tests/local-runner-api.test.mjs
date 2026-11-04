import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createExperienceServer } from "../scripts/lib/agent-experience-server.mjs";
import { createLocalRunnerApi } from "../scripts/lib/local-runner-api.mjs";

test("local Runner controls authenticate the browser and never accept a caller-chosen owner", async () => {
  const seen = [];
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
          code: "ACCESS_DENIED",
        });
      return { paired: true, ownerId };
    },
    registerWorkspace(ownerId, input) {
      seen.push({ ownerId, ...input });
      return { workspaces: [input] };
    },
    executionContext(ownerId, workspaceId) {
      seen.push({ ownerId, workspaceId });
      return { workspaceId };
    },
  };
  const runnerApi = createLocalRunnerApi({
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
    assert.equal(
      (
        await request("/status", undefined, {
          cookie: "qd_session=bob",
          "x-qd-account": "bob",
        })
      ).status,
      403,
    );
    assert.deepEqual(await (await request("/status")).json(), {
      paired: true,
      ownerId: "alice",
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
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => worker.close(resolve));
  }
});
