import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { cleanupInstallation } from "../desktop/cleanup-installation.cjs";

test(
  "native NSIS update moves a long-path installation atomically on its own volume",
  { skip: process.platform !== "win32", timeout: 30000 },
  async (t) => {
    const cache = path.join(process.env.LOCALAPPDATA, "electron-builder/Cache");
    let compiler;
    for (const folder of (await fs.readdir(cache)).filter((name) =>
      name.startsWith("nsis-"),
    )) {
      for (const item of await fs.readdir(path.join(cache, folder))) {
        const file = path.join(cache, folder, item, "Bin/makensis.exe");
        if (
          await fs.access(file).then(
            () => true,
            () => false,
          )
        ) {
          compiler = file;
          break;
        }
      }
      if (compiler) break;
    }
    if (!compiler)
      return t.skip(
        "Run desktop packaging first to provision the NSIS compiler.",
      );
    const base = await fs.realpath(path.resolve(".tmp"));
    const root = await fs.mkdtemp(path.join(base, "nsis-atomic-"));
    t.after(async () => {
      assert.equal(path.dirname(root), base);
      await fs.rm(root, { recursive: true, force: true });
    });
    const installed = path.join(root, "installed"),
      longRelative = path.join("x".repeat(100), "y".repeat(100), "data.txt");
    await fs.mkdir(path.dirname(path.join(installed, longRelative)), {
      recursive: true,
    });
    await fs.writeFile(path.join(installed, longRelative), "preserved fixture");
    const executable = path.join(root, "native-check.exe"),
      script = path.join(root, "check.nsi");
    const content = [
      "Unicode true",
      '!include "LogicLib.nsh"',
      '!include "FileFunc.nsh"',
      '!define APP_ID "cn.zky.qingdao.beta"',
      '!define VERSION "test"',
      '!define APP_EXECUTABLE_FILENAME "QingdaoBeta.exe"',
      '!define UNINSTALL_FILENAME "Uninstall QingdaoBeta.exe"',
      '!define BUILD_RESOURCES_DIR "' + path.resolve("build") + '"',
      '!define isUpdated "1 = 1"',
      '!include "' + path.resolve("build/desktop-installer.nsh") + '"',
      "!macroundef QingdaoInstallTrace",
      "!macro QingdaoInstallTrace text",
      "Push $R9",
      'FileOpen $R9 "' + path.join(root, "native.log") + '" a',
      "FileSeek $R9 0 END",
      'FileWrite $R9 "${text}$\\r$\\n"',
      "FileClose $R9",
      "Pop $R9",
      "ClearErrors",
      "!macroend",
      'OutFile "' + executable + '"',
      "SilentInstall silent",
      "RequestExecutionLevel user",
      "Section",
      'StrCpy $INSTDIR "' + installed + '"',
      "!insertmacro customInit",
      "!insertmacro customRemoveFiles",
      "SetErrorLevel 0",
      "SectionEnd",
    ].join("\n");
    await fs.writeFile(script, content);
    const run = (file, args) =>
      new Promise((resolve, reject) => {
        const child = spawn(file, args, {
          cwd: root,
          windowsHide: true,
          stdio: "pipe",
        });
        let out = "";
        child.stdout.on("data", (v) => (out += v));
        child.stderr.on("data", (v) => (out += v));
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0
            ? resolve()
            : reject(Error("NSIS exit " + code + ": " + out)),
        );
      });
    await run(compiler, ["/V2", script]);
    await run(executable, ["/S"]);
    const names = (await fs.readdir(root)).filter((name) =>
      /^installed\.previous-\d+-[-\d]+$/.test(name),
    );
    assert.equal(
      names.length,
      1,
      await fs.readFile(path.join(root, "native.log"), "utf8"),
    );
    const backup = path.join(root, names[0]);
    assert.equal(
      await fs.readFile(path.join(backup, longRelative), "utf8"),
      "preserved fixture",
    );
    await assert.rejects(fs.access(installed));
    await cleanupInstallation(backup, installed, "cn.zky.qingdao.beta");
    await assert.rejects(fs.access(backup));
  },
);
