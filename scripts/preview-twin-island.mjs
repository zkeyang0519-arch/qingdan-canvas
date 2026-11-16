import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(root, ".tmp/twin-island-preview");
await mkdir(output, { recursive: true });
await build({
  entryPoints: [path.join(root, "tests/fixtures/twin-island-preview.jsx")],
  outfile: path.join(output, "preview.js"),
  bundle: true,
  format: "esm",
  sourcemap: true,
  external: ["/fonts/*"],
});
await writeFile(
  path.join(output, "index.html"),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>轻岛 · 雾玉双岛预览</title><link rel="stylesheet" href="/preview.css"><style>
*{box-sizing:border-box}body{margin:0;background:#f5f6f1;color:#354b38;font-family:var(--font-sans);padding:32px 5vw}button{font:inherit;cursor:pointer}.preview-heading{display:flex;justify-content:space-between;align-items:center;max-width:1100px;margin:0 auto 24px}.preview-heading small{color:#84917a;font-size:12px}.preview-heading h1{font-size:27px;font-weight:500;margin:8px 0}.preview-heading p{font-size:12px;color:#8b9683}.preview-controls{max-width:1100px;margin:0 auto 18px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.preview-controls div{display:flex;gap:6px}.preview-controls button{background:transparent;color:#74836a;border:1px solid #dce3d5;border-radius:20px;padding:8px 14px;font-size:12px}.preview-controls button[aria-pressed=true]{background:#446448;color:#f4f9ee;border-color:#446448}.preview-stage{position:relative;max-width:1100px;height:520px;margin:auto;overflow:hidden;border:1px solid #dce3d5;border-radius:20px;background-color:#fbfcf8;background-image:radial-gradient(#dce4d5 1px,transparent 1px);background-size:18px 18px;--desktop-max-width:720px;--desktop-max-height:510px}.preview-guide{position:absolute;left:30px;bottom:24px;color:#a2ae98;font-size:13px}.preview-stage .dynamic-island-dock{position:absolute!important;top:48px!important;left:50%;transform:translateX(-50%)}.preview-stage[data-side=left] .dynamic-island-dock{top:120px!important;left:0;transform:none}.preview-stage[data-side=right] .dynamic-island-dock{top:120px!important;left:auto;right:0;transform:none}.preview-help{text-align:center;margin:22px auto;font-size:12px;color:#8b9683}
</style></head><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>`,
);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json",
};
const port = Number(process.env.QINGDAO_PREVIEW_PORT || 18796);
createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    const directory = /^\/(fonts|animals)\//.test(pathname)
      ? path.join(root, "public")
      : output;
    const target = path.resolve(
      directory,
      `.${pathname === "/" ? "/index.html" : pathname}`,
    );
    if (!target.startsWith(directory + path.sep)) throw Error("Invalid path");
    const data = await readFile(target);
    res.writeHead(200, {
      "Content-Type": types[path.extname(target)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}/`));
