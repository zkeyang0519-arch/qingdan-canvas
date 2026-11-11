import { mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { ConnectorError } from "./errors.mjs";
import pin from "./protocol.json" with { type: "json" };
const source = path.dirname(fileURLToPath(import.meta.url));
const files = [
  "main.mjs",
  "instance.mjs",
  "server.mjs",
  "connector.mjs",
  "discovery.mjs",
  "rpc.mjs",
  "errors.mjs",
  "protocol.json",
  "public/index.html",
  "public/app.js",
  "public/style.css",
];
export async function packageWindows(
  destination,
  { runtimePath = process.execPath } = {},
) {
  if (process.platform !== "win32")
    throw Error("Windows packaging requires Windows runtime");
  await mkdir(path.dirname(path.resolve(destination)), { recursive: true });
  try {
    await mkdir(destination);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new ConnectorError(
      "PACKAGE_DESTINATION_EXISTS",
      "打包目录已经存在。为防止混入账号或运行数据，请使用一个全新的输出目录。",
      "选择新的输出目录；保留已有运行数据",
    );
  }
  await mkdir(path.join(destination, "app/public"), { recursive: true });
  for (const f of files)
    await copyFile(path.join(source, f), path.join(destination, "app", f));
  await copyFile(runtimePath, path.join(destination, "node.exe"));
  await copyFile(
    path.join(source, "NODE-LICENSE"),
    path.join(destination, "NODE-LICENSE"),
  );
  const launcher = [
    "Option Explicit",
    "Dim shell, fso, root, command",
    'Set shell = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    "root = fso.GetParentFolderName(WScript.ScriptFullName)",
    'command = Chr(34) & root & "\\node.exe" & Chr(34) & " " & Chr(34) & root & "\\app\\main.mjs" & Chr(34) & " --open --data-dir " & Chr(34) & root & "\\data" & Chr(34)',
    "shell.Run command, 0, False",
    "",
  ].join("\r\n");
  await writeFile(
    path.join(destination, "启动 Codex 连接器.vbs"),
    Buffer.concat([Buffer.from([255, 254]), Buffer.from(launcher, "utf16le")]),
  );
  await writeFile(
    path.join(destination, "start.cmd"),
    '@echo off\r\ncd /d "%~dp0"\r\n"%~dp0node.exe" "%~dp0app\\main.mjs" --open --data-dir "%~dp0data"\r\nif errorlevel 1 pause\r\n',
  );
  await writeFile(
    path.join(destination, "README.txt"),
    `Codex 连接器 ${pin.connectorVersion}

解压到可写文件夹，双击“启动 Codex 连接器.vbs”。若系统禁用脚本，请运行 start.cmd。
自带 Node 运行时，无需 npm 或轻单服务器；需要本机已有兼容 Codex。
当前已验证版本：${pin.testedVersions.join("、")}。其他版本会明确提示不兼容。

只做连接检查、登录状态与会话/项目读取，不创建或执行任务。
退出请使用面板“退出连接器”；关闭网页不等于退出后台。
配置与访问凭证只保存在本文件夹 data 中。移动前先退出；分享时不要携带 data。
不注册开机启动，不修改轻单账号、Codex 登录或项目文件。

若自动查找失败，在面板填写 codex.exe 的完整路径；若未登录，请在 Codex 中登录后重试。
诊断导出不包含访问凭证、原始路径或会话正文。
此包未做发行签名；仅当前 Windows 真机验证，不代表其他电脑和版本已验证。
`.replace(/\n/g, "\r\n"),
  );
  const runtime = await readFile(runtimePath);
  await writeFile(
    path.join(destination, "manifest.json"),
    JSON.stringify(
      {
        version: pin.connectorVersion,
        runtime: process.version,
        runtimeSha256: createHash("sha256").update(runtime).digest("hex"),
        files: [
          "node.exe",
          "NODE-LICENSE",
          ...files.map((f) => "app/" + f),
          "启动 Codex 连接器.vbs",
          "start.cmd",
          "README.txt",
        ],
      },
      null,
      2,
    ),
  );
  return destination;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!process.argv[2]) throw Error("Specify a new output directory");
  console.log(await packageWindows(path.resolve(process.argv[2])));
}
