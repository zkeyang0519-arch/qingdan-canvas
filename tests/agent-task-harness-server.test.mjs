import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  callItem,
  textItem,
  openResponsesFixture,
} from "./fixtures/pi-local-responses.mjs";
import { start, stop } from "../scripts/pi-local/server.mjs";

test(
  "本机页面接口经 Worker 把问题身份交给 Pi，恢复后返回已验收任务卡片",
  { timeout: 60000 },
  async (t) => {
    const root = path.resolve(".tmp");
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(path.join(root, "harness-server-"));
    const fixture = await openResponsesFixture((req, n) => {
      const call = (name, args) => callItem(name, args, "server_" + n);
      if (n === 1)
        return call("update_task", {
          goal: "活动文案",
          requirements: [
            { id: "copy", description: "交付文案", check: "answer" },
          ],
        });
      if (n === 2)
        return call("ask_user", {
          question: "什么语气？",
          reason: "确定文案语气",
          options: ["温暖", "简洁"],
        });
      if (n === 3) return textItem("等用户选择");
      if (n === 4) {
        assert.match(JSON.stringify(req.body.input), /温暖/);
        return call("submit_result", {
          summary: "文案已完成",
          checks: [
            {
              requirementId: "copy",
              evidenceIds: [],
              explanation: "已提供温暖语气文案",
            },
          ],
        });
      }
      return textItem("灯光亮起，我们一起出发。");
    });
    const empty = {
      connect: async () => ({
        listTools: async () => [],
        close: async () => {},
      }),
    };
    let started = false;
    t.after(async () => {
      if (started) await stop();
      await fixture.close();
      assert.equal(path.dirname(dir), root);
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    });
    started = true;
    const { origin, launcher } = await start({
      directory: dir,
      listenPort: 0,
      settings: fixture.settings,
      environment: {},
      modelCredentialFile: () => ({ load: async () => ({}) }),
      connectorServices: { codex: empty, waao: empty },
    });
    const ticket = (await readFile(launcher, "utf8")).match(
      /#ticket=([a-f0-9]+)/,
    )[1];
    const login = await fetch(origin + "/local/session", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    async function call(route, body) {
      const response = await fetch(origin + route, {
        method: body ? "POST" : "GET",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      assert.ok(response.ok, JSON.stringify(data));
      return data;
    }
    const first = await call("/api/agent/chat/send", {
      requestId: randomUUID(),
      bindingId: "pi-local-binding",
      bindingRevision: 1,
      text: "整理活动文案",
    });
    async function settled() {
      for (let n = 0; n < 150; n++) {
        const state = await call(
          "/api/agent/chat/state?" +
            new URLSearchParams({
              bindingId: "pi-local-binding",
              chatId: first.thread.id,
            }),
        );
        if (state.job?.status === "succeeded") return state;
        assert.notEqual(state.job?.status, "failed", JSON.stringify(state.job));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail("聊天任务未在预期时间结束");
    }
    const waiting = await settled();
    assert.equal(waiting.harnessTask.status, "waiting_user");
    assert.equal(Object.hasOwn(waiting, "harnessMessageIds"), false);
    await call("/api/agent/chat/send", {
      requestId: randomUUID(),
      bindingId: "pi-local-binding",
      bindingRevision: 1,
      chatId: first.thread.id,
      text: "温暖",
      taskReply: {
        taskId: waiting.harnessTask.id,
        questionId: waiting.harnessTask.questions[0].id,
      },
    });
    const finished = await settled();
    assert.equal(finished.harnessTask.id, waiting.harnessTask.id);
    assert.equal(finished.harnessTask.status, "completed");
    assert.match(finished.harnessTask.result, /一起出发/);
  },
);
