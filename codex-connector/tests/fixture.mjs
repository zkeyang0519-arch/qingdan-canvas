import readline from "node:readline";
import { appendFileSync } from "node:fs";
const mode = process.env.TEST_CODEX_MODE || "normal";
if (process.argv.includes("--version")) {
  if (process.env.TEST_VERSION_SIGNAL) {
    appendFileSync(process.env.TEST_VERSION_SIGNAL, String(process.pid));
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.log(
    "codex-cli " + (mode === "version" ? "99.0.0" : "0.167.0-alpha.3.2"),
  );
  process.exit(0);
}
if (process.env.TEST_CODEX_LOG)
  appendFileSync(
    process.env.TEST_CODEX_LOG,
    JSON.stringify({ pid: process.pid }) + "\n",
  );
const send = (packet) => {
  const data = Buffer.from(JSON.stringify(packet) + "\n");
  if (mode === "fragment") {
    const n = data.indexOf(Buffer.from("中文")) + 1;
    process.stdout.write(data.subarray(0, n));
    setTimeout(() => process.stdout.write(data.subarray(n)), 5);
  } else process.stdout.write(data);
};
const thread = (id = "thread-1") => ({
  id,
  name: "中文会话",
  preview: "PRIVATE HISTORY BODY",
  cwd: process.cwd(),
  updatedAt: 1790000000,
  ephemeral: false,
  parentThreadId: null,
  turns: [],
});
for await (const line of readline.createInterface({ input: process.stdin })) {
  const p = JSON.parse(line);
  if (process.env.TEST_CODEX_LOG)
    appendFileSync(
      process.env.TEST_CODEX_LOG,
      JSON.stringify({ method: p.method, params: p.params }) + "\n",
    );
  if (p.id === undefined) continue;
  if (mode === "hang") continue;
  if (mode === "malformed") {
    process.stdout.write("broken json\n");
    continue;
  }
  let result;
  if (p.method === "initialize")
    result = {
      userAgent: "fixture/1",
      codexHome: process.cwd(),
      platformOs: "windows",
    };
  else if (p.method === "account/read")
    result =
      mode === "invalid"
        ? { account: 42 }
        : {
            account:
              mode === "logged-out"
                ? null
                : {
                    type: "chatgpt",
                    email: "private@example.com",
                    planType: "plus",
                  },
            requiresOpenaiAuth: true,
          };
  else if (p.method === "thread/list") {
    if (mode === "crash") process.exit(9);
    if (mode === "slow") await new Promise((r) => setTimeout(r, 100));
    result = {
      data:
        mode === "empty"
          ? []
          : [thread(p.params.cursor ? "thread-2" : "thread-1")],
      nextCursor: p.params.cursor ? null : "page-2",
    };
  } else if (p.method === "thread/read")
    result = {
      thread: thread(mode === "wrong-id" ? "other-thread" : p.params.threadId),
    };
  else {
    send({ id: p.id, error: { code: -32601, message: "unsupported" } });
    continue;
  }
  send({ id: p.id, result });
}
