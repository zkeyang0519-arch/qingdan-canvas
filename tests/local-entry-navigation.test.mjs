import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { createExperienceServer } from "../scripts/lib/agent-experience-server.mjs";

const navigation = {
  "Sec-Fetch-Site": "cross-site",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-User": "?1",
};

async function fixture(t) {
  let reached = 0;
  const upstream = createServer((_req, res) => {
    reached++;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>Local Qingdan</title>");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const server = createExperienceServer({
    service: {},
    upstream: `http://127.0.0.1:${upstream.address().port}`,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(async () => {
    server.closeConnections();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  });
  return {
    reached: () => reached,
    request: (pathname, headers = navigation, method = "GET") =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          { hostname: "127.0.0.1", port, path: pathname, method, headers },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () =>
              resolve({ status: res.statusCode, headers: res.headers, body }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      }),
  };
}

test("clicking the published site's local entry link opens the local app document", async (t) => {
  const f = await fixture(t);
  const response = await f.request("/app");
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /text\/html/);
  assert.match(response.body, /<title>Local Qingdan<\/title>/);
  assert.equal(f.reached(), 1);
});

test("local entry navigation does not grant foreign API, embedded, scripted or form access", async (t) => {
  const f = await fixture(t);
  for (const pathname of [
    "/api/session",
    "/api/rooms",
    "/api/local-desktop/launch",
    "/api/local-runner/status",
    "/api/local-codex/status",
    "/app?invite=untrusted",
  ]) {
    assert.equal((await f.request(pathname)).status, 403, pathname);
  }
  for (const headers of [
    { ...navigation, "Sec-Fetch-Dest": "iframe" },
    { ...navigation, "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" },
    { ...navigation, "Sec-Fetch-User": "" },
    { "Sec-Fetch-Site": "cross-site" },
  ]) {
    assert.equal((await f.request("/app", headers)).status, 403);
  }
  assert.equal((await f.request("/app", navigation, "POST")).status, 403);
  assert.equal(f.reached(), 0);
});

test("local entry navigation still rejects a forged Host or foreign Origin", async (t) => {
  const f = await fixture(t);
  for (const headers of [
    { ...navigation, Host: "foreign.invalid" },
    { ...navigation, Origin: "https://foreign.invalid" },
  ]) {
    assert.equal((await f.request("/app", headers)).status, 403);
  }
  assert.equal(f.reached(), 0);
});
