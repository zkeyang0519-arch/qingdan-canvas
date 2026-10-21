import { parse, printParseErrorCode } from "jsonc-parser";

export function parseDeployConfig(source) {
  const errors = [];
  const config = parse(source, errors, { allowTrailingComma: true });
  if (errors.length) {
    throw new Error(
      "wrangler.jsonc 配置语法错误：" +
        printParseErrorCode(errors[0].error) +
        "，位置 " +
        errors[0].offset,
    );
  }
  if (
    config.d1_databases.some(
      (db) => db.database_id === "00000000-0000-0000-0000-000000000000",
    )
  ) {
    throw new Error("尚未连接真实 D1。请先创建 D1 / R2 并填写 database_id。");
  }
  if (config.vars.APP_ENV !== "production") {
    throw new Error(
      "部署要求 APP_ENV=production，不能把本地开发配置部署到公网。",
    );
  }
  return config;
}
