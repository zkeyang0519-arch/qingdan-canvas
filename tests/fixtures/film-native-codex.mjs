import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const [, , dir, ...args] = process.argv;
if (args.includes("--version")) {
  console.log("codex-cli 0.169.0-alpha.11.1");
} else if (args.includes("features")) {
  console.log("image_generation stable true");
} else {
  const dbPath = path.join(dir, "native.json");
  let db;
  try {
    db = JSON.parse(readFileSync(dbPath, "utf8"));
  } catch {
    db = { turnsStarted: 0, threads: {} };
  }
  const save = () => writeFileSync(dbPath, JSON.stringify(db));
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const { method, id, params: p } = JSON.parse(line);
    if (id === undefined) continue;
    const entry = db.threads[p.threadId];
    let result;
    switch (method) {
      case "initialize":
        result = { codexHome: dir };
        break;
      case "account/read":
        result = { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
        break;
      case "thread/start": {
        const thread = { id: randomUUID(), cwd: p.cwd };
        db.threads[thread.id] = { thread };
        save();
        result = { thread, model: "codex-fixture" };
        break;
      }
      case "turn/start": {
        const scenario = process.env.FILM_TEST_CASE;
        const turnId = randomUUID();
        const items = [
          { type: "userMessage", id: "u", clientId: p.clientUserMessageId },
        ];
        db.turnsStarted++;
        db.inputs = p.input.map((x) =>
          x.type === "localImage"
            ? readFileSync(x.path).toString("base64")
            : x.text,
        );
        if (scenario === "text") {
          items.push({
            type: "agentMessage",
            id: "partial",
            phase: "commentary",
            text: "过程文字",
          });
          items.push({
            type: "agentMessage",
            id: "final",
            phase: "final_answer",
            text: "正式稿件",
          });
        } else if (scenario === "text-only") {
          items.push({
            type: "agentMessage",
            id: "msg",
            phase: "final_answer",
            text: "图片做好了，相对路径 ./other.png",
          });
        } else {
          const root = path.join(dir, "generated_images", p.threadId);
          mkdirSync(root, { recursive: true });
          const target =
            scenario === "outside"
              ? path.join(dir, "outside.png")
              : path.join(root, "native.png");
          writeFileSync(target, readFileSync(path.join(dir, "source.png")));
          items.push({
            type: "imageGeneration",
            id: "native-image",
            generationId: "ig-1",
            status: "completed",
            failure: null,
            savedPath: target,
            fileId: "file-1",
          });
        }
        entry.turn = { id: turnId, items, status: "completed" };
        save();
        if (scenario === "lose-ack") process.exit(0);
        result = { turn: { id: turnId, status: "inProgress" } };
        break;
      }
      case "thread/read":
        result = { thread: entry.thread };
        break;
      case "thread/turns/list":
        if (process.env.FILM_TEST_CASE === "text" && !entry.historyReady) {
          entry.historyReady = true;
          save();
          process.stdout.write(
            JSON.stringify({
              id,
              error: {
                code: -32600,
                message: "list_turns is not supported yet",
              },
            }) + "\n",
          );
          continue;
        }
        result = { data: entry.turn ? [entry.turn] : [], nextCursor: null };
        break;
      case "thread/items/list":
        result = {
          data: entry.turn.items.map((item) => ({
            turnId: entry.turn.id,
            item,
          })),
          nextCursor: null,
        };
        break;
      default:
        throw Error(method);
    }
    process.stdout.write(JSON.stringify({ id, result }) + "\n");
  }
}
