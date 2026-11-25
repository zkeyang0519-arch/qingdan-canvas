import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";

const baseUrl = "https://api.xingchiapi.com/v1";
const defaultModel = "gpt-6.1-sol";
const settingsTemplate = `# 轻单本机 Pi 主模型 · 星驰。填写密钥后保存并刷新聊天页。
XINGCHI_API_KEY=""
QINGDAN_PI_MODEL="${defaultModel}"
`;

export async function openModelSettings(settingsFile, env = process.env) {
  try {
    await writeFile(settingsFile, settingsTemplate, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  async function settings() {
    try {
      return parseEnv(await readFile(settingsFile, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }
  const initial = await settings();
  const model =
    env.QINGDAN_PI_MODEL?.trim() ||
    initial.QINGDAN_PI_MODEL?.trim() ||
    defaultModel;
  const setupHint = `本机 Pi 的主模型是 ${model}。请在项目的 .dev.vars.pi 文件中填写 XINGCHI_API_KEY，保存后刷新此页。`;
  async function apiKey() {
    const key =
      env.XINGCHI_API_KEY?.trim() || (await settings()).XINGCHI_API_KEY?.trim();
    return key && /^[!-~]+$/.test(key) ? key : "";
  }
  return {
    model,
    baseUrl,
    setupHint,
    apiKey,
    async status() {
      const configured = !!(await apiKey());
      return {
        model,
        host: new URL(baseUrl).host,
        format: "responses",
        runtime: "Pi RPC 1.5.2",
        configured,
        ...(configured ? {} : { setupHint }),
      };
    },
  };
}
