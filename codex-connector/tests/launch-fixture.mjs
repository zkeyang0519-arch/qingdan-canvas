import { fileURLToPath } from "node:url";
import { Connector } from "../connector.mjs";
import { ReadonlyCodex } from "../rpc.mjs";
import { launch } from "../main.mjs";

// Install synthetic discovery before launch can inspect any real installation.
// This process has its own data directory and never opens a browser.
const fixture = fileURLToPath(new URL("./fixture.mjs", import.meta.url));
const originalLoad = Connector.prototype.load;
Connector.prototype.load = function () {
  this.options.discover = async () => ({
    candidates: [
      { command: process.execPath, args: [fixture], source: "test" },
    ],
    warnings: [],
  });
  this.options.createClient = (candidate) =>
    new ReadonlyCodex(candidate, {
      env: {
        ...process.env,
        TEST_CODEX_MODE: "normal",
        TEST_CODEX_LOG: process.argv[3],
      },
      timeoutMs: 2000,
      shutdownMs: 100,
    });
  return originalLoad.call(this);
};
const result = await launch(["--data-dir", process.argv[2]]);
const output = JSON.stringify({ ready: true, reused: result.reused });
process.stdout.write(output.slice(0, 5));
await new Promise((resolve) => setTimeout(resolve, 40));
console.log(output.slice(5));
