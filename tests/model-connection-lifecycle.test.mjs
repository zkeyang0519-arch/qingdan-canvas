import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { ModelCatalog } from "../scripts/pi-local/model-catalog.mjs";

async function fixture(t) {
  const root = path.resolve(".tmp");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "models-lifecycle-"));
  const secrets = new Map();
  let failClear = false;
  const credential = (id, url) => ({
    load: async () => secrets.get(id + url),
    save: async (value) => secrets.set(id + url, value),
    clear: async () => {
      if (failClear) throw Error("fixture storage unavailable");
      secrets.delete(id + url);
    },
  });
  const legacy = {
    model: "legacy",
    baseUrl: "https://legacy.example.com/v1",
    status: async () => ({ configured: false }),
  };
  const catalog = new ModelCatalog(directory, legacy, credential);
  t.after(async () => {
    catalog.close();
    assert.equal(path.dirname(directory), root);
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  return {
    catalog,
    secrets,
    credential,
    directory,
    legacy,
    setFailClear: (value) => {
      failClear = value;
    },
  };
}
const fields = {
  service: "测试连接",
  model: "model-one",
  baseUrl: "https://one.example.com/v1",
  apiKey: "fixture-private-one",
  apiFormat: "responses",
};

test("本机编辑连接保留旧请求配置，空密钥沿用，新请求解析为新连接且支持接口类型修改", async (t) => {
  const { catalog, secrets } = await fixture(t);
  const original = await catalog.add(fields);
  catalog.setDefault(original);
  const pinned = catalog.connection(original);
  await assert.rejects(
    catalog.update({
      ...fields,
      id: original,
      baseUrl: "https://two.example.com/v1",
      apiKey: "",
    }),
    /新密钥|现有密钥/,
  );
  const { updated, replaced } = await catalog.update({
    ...fields,
    id: original,
    baseUrl: "https://two.example.com/v1/chat/completions",
    model: "model-two",
    apiFormat: "chat_completions",
    apiKey: "",
    reuseApiKey: true,
  });
  assert.equal(replaced, original);
  assert.notEqual(updated, original);
  assert.equal(catalog.currentId(original), updated);
  assert.equal(catalog.defaultId, updated);
  assert.equal(pinned.baseUrl, fields.baseUrl);
  assert.equal(await pinned.apiKey(), fields.apiKey);
  assert.equal(catalog.connection(original).model, "model-one");
  assert.equal(
    catalog.connection(updated).baseUrl,
    "https://two.example.com/v1",
  );
  assert.equal(catalog.connection(updated).apiFormat, "chat_completions");
  assert.equal(await catalog.connection(updated).apiKey(), fields.apiKey);
  const list = await catalog.list();
  assert.equal(list.profiles.length, 2);
  assert.equal(list.profiles[1].id, updated);
  assert.doesNotMatch(JSON.stringify(list), /fixture-private|apiKey/);
  await assert.rejects(
    catalog.update({ ...fields, id: original }),
    /更新或删除/,
  );
  assert.equal(secrets.size, 2);
  const replay = await catalog.update({
    ...fields,
    id: original,
    baseUrl: "https://two.example.com/v1/chat/completions",
    model: "model-two",
    apiFormat: "chat_completions",
    apiKey: "",
    reuseApiKey: true,
  });
  assert.equal(replay.updated, updated);
  assert.equal(secrets.size, 2, "重试同一保存不会再写一份凭据");
  const next = await catalog.update({
    ...fields,
    id: updated,
    baseUrl: "https://two.example.com/v2",
    apiKey: "fixture-private-replaced",
  });
  assert.equal(
    await catalog.connection(next.updated).apiKey(),
    "fixture-private-replaced",
  );
  assert.equal(catalog.currentId(original), next.updated);
});

test("删除本机连接清理所有旧版本凭据，默认需重选，历史名称保留且清理失败可重试", async (t) => {
  const f = await fixture(t),
    catalog = f.catalog;
  const id = await catalog.add(fields);
  catalog.setDefault(id);
  const revision = await catalog.update({
    ...fields,
    id,
    model: "model-two",
    apiKey: "",
  });
  f.setFailClear(true);
  await assert.rejects(catalog.remove(revision.updated), /尚未完全清理/);
  assert.throws(() => catalog.connection(id), /找不到/);
  assert.throws(() => catalog.connection(revision.updated), /找不到/);
  assert.equal((await catalog.list()).profiles.length, 1);
  assert.equal(catalog.defaultId, "unselected");
  assert.equal((await catalog.status()).configured, false);
  f.setFailClear(false);
  assert.equal(
    (await catalog.remove(revision.updated)).deleted,
    revision.updated,
  );
  assert.equal(f.secrets.size, 0);
  assert.equal(catalog.describe(id).model, "model-one");
  assert.equal(catalog.describe(revision.updated).model, "model-two");
  assert.equal((await catalog.status(id)).configured, false);
});

test("并发编辑本机连接只接受一个新版本，失败方不留下新凭据", async (t) => {
  const { catalog, secrets } = await fixture(t);
  const id = await catalog.add(fields);
  const results = await Promise.allSettled([
    catalog.update({ ...fields, id, model: "model-a" }),
    catalog.update({ ...fields, id, model: "model-b" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await catalog.list()).profiles.length, 2);
  assert.equal(secrets.size, 2);
});
