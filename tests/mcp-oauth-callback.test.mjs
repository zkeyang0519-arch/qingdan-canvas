import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createExperienceServer } from "../scripts/lib/agent-experience-server.mjs";
import { navigationRequest } from "./fixtures/http-navigation.mjs";
import {
  isMcpOAuthNavigation,
  mcpReturnPath,
  mcpCallbackPage,
} from "../shared/agent/oauth-callback.mjs";

const navigation = {
  "sec-fetch-site": "cross-site",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
};
const callback = "/local/waao/callback?state=fixture-state&code=fixture-code";

test("OAuth 只允许回调页面导航，普通接口和脚本请求继续拒绝", async (t) => {
  const seen = [];
  const upstream = createServer((req, res) => {
    seen.push(req.url);
    res.end("callback handler reached");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = createExperienceServer({
    service: {},
    upstream: `http://127.0.0.1:${upstream.address().port}`,
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    proxy.closeConnections();
    await new Promise((r) => proxy.close(r));
    await new Promise((r) => upstream.close(r));
  });
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  assert.equal(
    (await navigationRequest(origin + callback, { headers: navigation }))
      .status,
    200,
  );
  assert.equal(
    (
      await navigationRequest(
        origin + "/local/mcp/callback/server-id?state=state&code=code",
        { headers: navigation },
      )
    ).status,
    200,
  );
  for (const [pathname, headers, method = "GET"] of [
    ["/local/mcp?bindingId=private", navigation],
    ["/api/agent/chat/send", navigation, "POST"],
    [
      callback,
      { ...navigation, "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
    ],
    [callback, { ...navigation, "sec-fetch-dest": "iframe" }],
    [callback, { ...navigation, origin: "https://foreign.invalid" }],
    [callback, navigation, "POST"],
    ["/local/waao/callback", navigation],
    [callback + "&state=other", navigation],
  ])
    assert.equal(
      (await navigationRequest(origin + pathname, { headers, method })).status,
      403,
      pathname,
    );
  assert.equal(seen.length, 2);
});

test("Worker 兼容 Headers 输入，项目返回地址不能变成外部跳转或携带授权码", async () => {
  assert.equal(
    isMcpOAuthNavigation(
      new Request("http://127.0.0.1" + callback, { headers: navigation }),
    ),
    true,
  );
  assert.equal(
    mcpReturnPath("/app?room=project-1&code=private#anything"),
    "/app?room=project-1#mcp=waao",
  );
  for (const value of [
    "https://evil.invalid",
    "//evil.invalid",
    "javascript:alert(1)",
    "/api/delete",
  ])
    assert.equal(mcpReturnPath(value), "/app#mcp=waao");
  const page = await mcpCallbackPage("/app?room=project-1&code=private", true);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.match(
    page.headers.get("content-security-policy"),
    /script-src 'sha256-/,
  );
  assert.match(html, /href="\/app\?room=project-1#mcp=waao"/);
  assert.doesNotMatch(html, /private|fixture-code/);
});
