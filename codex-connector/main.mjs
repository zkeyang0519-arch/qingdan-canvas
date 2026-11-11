import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Connector } from "./connector.mjs";
import { startServer } from "./server.mjs";
import { acquireInstance } from "./instance.mjs";
import { ConnectorError, problem } from "./errors.mjs";
const exec = promisify(execFile);
async function openPanel(url) {
  await exec("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
    windowsHide: true,
    timeout: 10000,
  });
}
export async function launch(args = process.argv.slice(2)) {
  if (process.platform !== "win32")
    throw new ConnectorError(
      "PLATFORM_UNSUPPORTED",
      "此便携版本面向 Windows。",
    );
  let stateDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "data",
    ),
    open = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--open") open = true;
    else if (args[i] === "--data-dir" && args[i + 1])
      stateDir = path.resolve(args[++i]);
    else throw new ConnectorError("INVALID_INPUT", "启动参数无效。");
  }
  const instance = await acquireInstance(stateDir);
  if (instance.existing) {
    if (open)
      await openPanel(
        instance.existing.url + "/#token=" + instance.existing.token,
      );
    return { reused: true };
  }
  let host, connector, stopping;
  const stop = () =>
    (stopping ??= (async () => {
      await host?.close();
      await connector?.close();
      await instance.release();
    })());
  try {
    connector = new Connector({ stateDir });
    const token = randomBytes(32).toString("hex");
    host = await startServer({
      connector,
      token,
      instanceId: instance.instanceId,
      onQuit: () => void stop(),
    });
    await instance.publish(host.url, token);
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
    void connector.inspect();
    if (open) await openPanel(host.url + "/#token=" + token);
    return { reused: false, url: host.url, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const r = await launch();
    console.log(
      JSON.stringify({ started: true, reused: r.reused, url: r.url ?? null }),
    );
  } catch (e) {
    const p = problem(e);
    console.error(JSON.stringify(p));
    process.exitCode = 1;
    if (process.argv.includes("--open"))
      await exec(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($env:QINGDAN_CONNECTOR_START_ERROR, 'Codex 连接器') | Out-Null",
        ],
        {
          windowsHide: true,
          env: {
            ...process.env,
            QINGDAN_CONNECTOR_START_ERROR: p.message + "\n" + p.action,
          },
        },
      ).catch(() => {});
  }
}
