import test from "node:test";
import assert from "node:assert/strict";
import { parseDeployConfig } from "../scripts/deploy-config.mjs";

const config = {
  vars: { APP_ENV: "production" },
  d1_databases: [{ database_id: "07038c34-6548-48ca-aeb4-3ff47b963395" }],
};

test("部署配置支持 Wrangler JSONC 的注释和尾逗号", () => {
  const source = [
    "{",
    "// Wrangler supports comments",
    '"vars": {"APP_ENV": "production",},',
    '"d1_databases": [{"database_id": "07038c34-6548-48ca-aeb4-3ff47b963395",},],',
    "}",
  ].join("\n");
  assert.deepEqual(parseDeployConfig(source), config);
});

test("部署配置拒绝损坏的 JSONC", () => {
  assert.throws(() => parseDeployConfig('{"vars": nope}'));
});

test("部署配置仍拒绝占位 D1 和本地免口令模式", () => {
  assert.throws(
    () =>
      parseDeployConfig(
        JSON.stringify({
          ...config,
          d1_databases: [
            { database_id: "00000000-0000-0000-0000-000000000000" },
          ],
        }),
      ),
    /尚未连接真实 D1/,
  );
  assert.throws(
    () =>
      parseDeployConfig(
        JSON.stringify({ ...config, vars: { APP_ENV: "local" } }),
      ),
    /APP_ENV=production/,
  );
});
