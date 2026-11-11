import { Connector } from "../connector.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const stateDir = path.resolve(
  process.argv[2] ?? ".tmp/codex-connector-live-smoke",
);
await mkdir(stateDir, { recursive: true });
const connector = new Connector({ stateDir, autoRetry: false });
const report = { at: new Date().toISOString(), checks: [] };
try {
  let status = await connector.inspect();
  report.checks.push({
    name: "auto-discovery-and-handshake",
    status: status.status,
    version: status.version,
    errorCode: status.error?.code ?? null,
  });
  if (!["ready", "login_required"].includes(status.status))
    throw Error(status.error?.code ?? status.status);
  const page = await connector.listSessions({});
  report.checks.push({
    name: "session-list",
    count: page.sessions.length,
    hasNextPage: !!page.nextCursor,
  });
  if (page.sessions[0]) {
    const selected = await connector.readSession(page.sessions[0].threadId);
    report.checks.push({
      name: "read-project",
      matches: selected.threadId === page.sessions[0].threadId,
      directoryExists: selected.directoryExists,
    });
  }
  if (page.nextCursor) {
    const next = await connector.listSessions({ cursor: page.nextCursor });
    report.checks.push({ name: "pagination", count: next.sessions.length });
  }
  status = await connector.inspect();
  report.checks.push({ name: "reconnect", status: status.status });
  if (!["ready", "login_required"].includes(status.status))
    throw Error("reconnect failed");
  report.diagnostics = connector.diagnostics();
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.error = String(e.message);
  process.exitCode = 1;
} finally {
  await connector.close();
  await writeFile(
    path.join(stateDir, "verification.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
