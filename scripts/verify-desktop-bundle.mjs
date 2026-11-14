import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
const require = createRequire(import.meta.url);
const { _electron } = require(
  process.env.QINGDAN_QA_PLAYWRIGHT || "playwright",
);
const root = fileURLToPath(new URL("..", import.meta.url));
const executable = path.resolve(process.argv[2]);
const evidence = await fs.mkdtemp(path.join(root, ".tmp/desktop-bundle-qa-"));
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const webLaunchPort = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const env = {
  ...process.env,
  QINGDAN_DESKTOP_PROFILE: path.join(evidence, "isolated-profile"),
  QINGDAN_DESKTOP_WEB_LAUNCH_PORT: String(webLaunchPort),
};
delete env.QINGDAN_DESKTOP_URL;
delete env.ELECTRON_RUN_AS_NODE;
const instance = await _electron.launch({
  executablePath: executable,
  env,
  cwd: root,
  timeout: 45000,
});
try {
  const page = await instance.firstWindow();
  // No production session is used. The isolated profile starts without cookies.
  await page.waitForURL("https://todo.zky.lol/app");
  await page.waitForFunction(() => !!window.qingdanDesktop?.getUpdateState);
  const responses = await instance.evaluate(async ({ BrowserWindow }) => {
    const session = BrowserWindow.getAllWindows()[0].webContents.session;
    const html = await session.fetch("https://todo.zky.lol/app");
    const body = await html.text();
    const scriptPath = body.match(/src="([^"]+\.js)"/)[1];
    const script = await session.fetch(
      new URL(scriptPath, "https://todo.zky.lol").href,
    );
    const api = await session.fetch("https://todo.zky.lol/api/session");
    return {
      status: html.status,
      contentType: html.headers.get("content-type"),
      csp: html.headers.get("content-security-policy"),
      body,
      scriptPath,
      script: await script.text(),
      apiStatus: api.status,
      apiSession: await api.json(),
      cookies: (await session.cookies.get({ url: "https://todo.zky.lol" }))
        .length,
    };
  });
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const web = path.join(path.dirname(executable), "resources/web");
  assert.equal(responses.status, 200);
  assert.equal(
    hash(responses.body),
    hash(await fs.readFile(path.join(web, "index.html"))),
  );
  assert.equal(
    hash(responses.script),
    hash(await fs.readFile(path.join(web, responses.scriptPath.slice(1)))),
  );
  assert.match(responses.script, /draftsPersisted/);
  assert.match(responses.csp, /script-src 'self'/);
  assert.equal(responses.apiStatus, 200);
  assert.equal(responses.apiSession.user, null);
  const update = await page.evaluate(() =>
    window.qingdanDesktop.getUpdateState(),
  );
  const probe = (origin) => fetch(`http://127.0.0.1:${webLaunchPort}/api/local-desktop/online/probe`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Qingdan-Local": "1" }, body: "{}",
  });
  const nativeBridge = await (await probe("https://todo.zky.lol")).json();
  assert.equal(nativeBridge.protocol, 1);
  assert.match(nativeBridge.instanceId, /^[a-f0-9]{32}$/);
  assert.equal((await probe("https://untrusted.example")).status, 403);
  await page.screenshot({ path: path.join(evidence, "installed-login.png") });
  const report = {
    executable,
    bundledHtmlHash: hash(responses.body),
    bundledScript: responses.scriptPath,
    bundledScriptHash: hash(responses.script),
    productionOrigin: page.url(),
    apiStatus: responses.apiStatus,
    anonymousSession: responses.apiSession.user === null,
    cookies: responses.cookies,
    update,
    independentWebLaunchBridge: true,
    foreignWebOriginRejected: true,
    evidence,
    limitation:
      "No real user credentials. Confirms bundled assets at production HTTPS origin and anonymous API forwarding, not authenticated production login.",
  };
  await fs.writeFile(
    path.join(evidence, "result.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await instance.close();
}
