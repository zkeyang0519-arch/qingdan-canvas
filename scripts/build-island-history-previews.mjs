// Prepare real release components for local screenshots. No account/storage IO.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { islandReleases } from "../src/desktop/island-releases.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(root, ".tmp/island-settings-preview/history");
await mkdir(output, { recursive: true });
for (const release of islandReleases) {
  const tag = `v${release.version}`;
  const directory = path.join(root, ".tmp/island-release-sources", tag);
  await mkdir(directory, { recursive: true });
  const archive = path.join(directory, "source.tar");
  execFileSync(
    "git",
    ["archive", "--format=tar", "-o", archive, tag, "src", "shared"],
    { cwd: root },
  );
  execFileSync("tar", ["-xf", archive, "-C", directory]);
  const styles = [
    "desktop/desktop.css",
    "desktop/jade-island.css",
    "desktop/twins-island.css",
    "ui/luma.css",
    "desktop/glass-island.css",
  ]
    .filter((file) => existsSync(path.join(directory, "src", file)))
    .map((file) => `import './src/${file}';`)
    .join("\n");
  await build({
    stdin: {
      contents: `import React from 'react';
        import { createRoot } from 'react-dom/client';
        import DynamicIsland from './src/island/DynamicIsland.jsx';
        import { createWorkspace, createObject, makeBlock } from './src/canvas/model.js';
        ${styles}
        function Sample({dock='top',expanded=false}) {
          const state=createWorkspace();
          state.objects=[{...createObject(state.boards[0].id,'note'),noteKind:'checklist',blocks:[{...makeBlock('整理本周的灵感与计划'),dueAt:new Date(new Date().setHours(14,30,0,0)).toISOString()},makeBlock('给小植物浇水')]}];
          state.preferences={views:{[state.boards[0].id]:{dynamicIsland:{enabled:true,pinned:expanded}}}};
          const workspace={state,current:{current:state},readOnly:false,status:'saved',update:()=>{},toggleBlock:()=>{}};
          return <div className="desktop-island-workspace" data-sample={dock} data-expanded={expanded}><DynamicIsland workspace={workspace} boardId={state.boards[0].id} top={0} dragHandleTitle="拖动轻岛" onDisable={()=>{}} desktop={{dock,dragging:false,supportsJade:true,supportsTwinIsland:true,supportsRetainedTwinIsland:true,handlers:{onPointerDown(){}}}} /></div>
        }
        createRoot(document.getElementById('root')).render(<main id="release-capture"><span className="release-label">轻岛 · ${tag}</span><div className="compact"><Sample/><Sample dock="right"/></div><div className="expanded"><Sample expanded/></div></main>);`,
      resolveDir: directory,
      loader: "jsx",
    },
    bundle: true,
    format: "esm",
    external: ["/fonts/*"],
    outfile: path.join(output, `${tag}.js`),
  });
  await writeFile(
    path.join(output, `${tag}.html`),
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>轻岛 ${tag} 版本预览</title><link rel="stylesheet" href="/history/${tag}.css"><style>
    *{box-sizing:border-box}body{margin:0;background:#eef3f0;font-family:'Microsoft YaHei',sans-serif}#release-capture{position:relative;width:800px;height:400px;overflow:hidden;background:radial-gradient(ellipse at 20% 80%,#d6e7de,transparent 65%),linear-gradient(125deg,#f8faf6,#ddebe5)}.release-label{position:absolute;left:28px;top:22px;font-size:12px;color:#769286;letter-spacing:1px}.desktop-island-workspace{--desktop-max-width:450px;--desktop-max-height:600px}.dynamic-island-dock{position:absolute!important;top:0!important;left:0!important;transform:none!important}.compact{position:absolute;left:25px;top:102px;width:400px}.compact [data-sample=right]{position:absolute;top:84px;left:18px}.compact [data-sample=top]{transform:scale(.85);transform-origin:top left}.expanded{position:absolute;left:420px;top:72px;width:420px;transform:scale(${Number(release.version.split(".")[2]) <= 3 ? ".72" : ".82"});transform-origin:top left}.expanded .island-panel{max-height:none!important;overflow:hidden!important}.expanded .island-twin-header{margin-left:0!important}.expanded .dynamic-island{max-height:none!important}.dynamic-island{pointer-events:none!important}
    </style></head><body><div id="root"></div><script type="module" src="/history/${tag}.js"></script></body></html>`,
  );
  console.log(
    `Prepared ${tag} from ${execFileSync("git", ["rev-parse", tag], { cwd: root, encoding: "utf8" }).trim()}`,
  );
}
