import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import {
  locations,
  pipeAddress,
  signature,
  signatureMatches,
  inspectActive,
  readControlSecret,
} from "./agent-install.mjs";

const root = process.env.QINGDAN_AGENT_PROJECT_ROOT;
const stateDir = process.env.QINGDAN_AGENT_INSTALL_DIR;
// NODE_OPTIONS is inherited through npm and build children. Only the exact
// registered launcher gets a control endpoint; no descendant is a controller.
if (
  root &&
  stateDir &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.join(root, "scripts/dev-agent.mjs")
) {
  const loc = await locations({ root, stateDir });
  const manifest = JSON.parse(
    readFileSync(path.join(stateDir, "install.json"), "utf8"),
  );
  if (
    manifest.projectRoot !== loc.projectRoot ||
    manifest.stateDir !== loc.stateDir ||
    realpathSync(process.execPath) !== realpathSync(manifest.nodePath)
  )
    throw Error("Installed launcher identity mismatch.");
  const secret = await readControlSecret(stateDir);
  const identity = {
    pid: process.pid,
    instanceId: randomUUID(),
    installationId: manifest.installationId,
    projectRoot: root,
    startedAt: new Date().toISOString(),
  };
  const runtimeFile = path.join(stateDir, "runtime.json");
  let stopping = false;
  const server = net.createServer((socket) => {
    let phase = "hello",
      challenge,
      buffer = "";
    socket.setTimeout(3000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", async (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 8192) return socket.destroy();
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const request = JSON.parse(line);
        if (phase === "hello") {
          challenge = request.challenge;
          if (
            typeof challenge !== "string" ||
            !/^[a-f0-9]{64}$/.test(challenge)
          )
            return socket.destroy();
          phase = "command";
          socket.write(
            `${JSON.stringify({ identity, proof: signature(secret, ["server", challenge, identity]) })}\n`,
          );
          return;
        }
        if (
          phase !== "command" ||
          !signatureMatches(
            secret,
            ["client", challenge, identity, request.payload],
            request.proof,
          )
        )
          return socket.destroy();
        phase = "done";
        const payload = request.payload;
        if (!["status", "stop"].includes(payload?.command))
          return socket.destroy();
        const active = await inspectActive(root);
        let result = { ...identity, active, stopping };
        let stopAfterReply = false;
        if (payload.command === "stop") {
          if (
            !payload.interruptActive &&
            (active.count || active.unknown.length)
          )
            result = {
              error:
                "Active or unknown runs prevent stop. Finish/reconcile runs first, or explicitly use --interrupt-active for graceful interruption.",
            };
          else if (process.listenerCount("SIGTERM") === 0)
            result = {
              error: "Launcher is still initializing; retry stop shortly.",
            };
          else {
            stopping = true;
            result = {
              ...result,
              stopping: true,
              interruptedActive: active.count > 0 || active.unknown.length > 0,
            };
            // Emit locally; Windows process.kill(SIGTERM) would bypass handlers.
            // Existing launcher closes its controller and only its owned children.
            stopAfterReply = true;
          }
        }
        socket.end(
          `${JSON.stringify({ result, proof: signature(secret, ["result", challenge, identity, result]) })}\n`,
          () => {
            if (stopAfterReply) process.emit("SIGTERM");
          },
        );
      } catch {
        socket.destroy();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipeAddress(manifest), resolve);
  });
  server.unref();
  const temp = `${runtimeFile}.${identity.instanceId}.tmp`;
  writeFileSync(temp, JSON.stringify(identity), { mode: 0o600 });
  renameSync(temp, runtimeFile);
  process.once("exit", () => {
    try {
      if (
        JSON.parse(readFileSync(runtimeFile, "utf8")).instanceId ===
        identity.instanceId
      )
        unlinkSync(runtimeFile);
    } catch {
      /* Retain an unreadable record for diagnosis. */
    }
  });
}
