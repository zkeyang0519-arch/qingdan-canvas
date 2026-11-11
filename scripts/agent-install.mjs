import {
  install,
  start,
  stop,
  uninstall,
  diagnose,
} from "./lib/agent-install.mjs";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(
      "Local Agent: install | start | stop | restart | diagnose | uninstall\nOptions: --root <absolute-checkout> --state-dir <absolute-.tmp/agent-install[-name]>\nstop/restart: --interrupt-active explicitly permits graceful interruption.\nInstall requires Node >=24, npm ci dependencies, and the pinned Codex CLI.\nUninstall retains all project data, logs, and credentials; no autostart is registered.",
    );
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--interrupt-active") options.interruptActive = true;
    else if (["--root", "--state-dir"].includes(args[i]) && args[i + 1])
      options[args[i++] === "--root" ? "root" : "stateDir"] = args[i];
    else throw Error(`Unsupported argument: ${args[i]}`);
  }
  if (options.interruptActive && !["stop", "restart"].includes(command))
    throw Error("--interrupt-active applies only to stop or restart.");
  let result;
  if (command === "restart") {
    await stop(options);
    result = await start(options);
  } else {
    const action = { install, start, stop, diagnose, uninstall }[command];
    if (!action) throw Error(`Unsupported action: ${command}`);
    result = await action(options);
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
