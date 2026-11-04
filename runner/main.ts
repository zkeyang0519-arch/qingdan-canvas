import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { RunnerDeviceController } from "./device-controller";
/** The local launcher embeds the same controller; this entry also runs it headlessly. */
export async function startRunner(
  options: { stateDir?: string; serverOrigin?: string } = {},
) {
  const controller = new RunnerDeviceController({
    stateDir:
      options.stateDir ??
      path.join(
        process.env.LOCALAPPDATA ?? os.homedir(),
        "QingdanRunner",
        "device",
      ),
    serverOrigin: options.serverOrigin ?? "http://127.0.0.1:8788",
  });
  await controller.start();
  return controller;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const controller = await startRunner();
  const keepAlive = setInterval(() => {}, 60000);
  const stop = async () => {
    clearInterval(keepAlive);
    await controller.close();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}
