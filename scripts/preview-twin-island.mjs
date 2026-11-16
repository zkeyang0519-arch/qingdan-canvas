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
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>轻岛 · 青透双岛预览</title><link rel="stylesheet" href="/preview.css"><style>
*{box-sizing:border-box}body{margin:0;background:#0e171b;color:#ebf4f3;font-family:var(--font-sans);padding:32px 5vw}button{font:inherit;cursor:pointer}
.preview-heading{display:flex;justify-content:space-between;align-items:center;max-width:1100px;margin:0 auto 24px}.preview-heading small{color:#7daba5;font-size:12px}.preview-heading h1{font-size:27px;font-weight:500;margin:8px 0}.preview-heading p{font-size:12px;color:#91a6aa}
.preview-controls{max-width:1100px;margin:0 auto 18px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.preview-controls div{display:flex;gap:6px}.preview-controls button{background:transparent;color:#aac7c5;border:1px solid #365054;border-radius:20px;padding:8px 14px;font-size:12px}.preview-controls button[aria-pressed=true]{background:#234846;color:#e3f8f5;border-color:#558980}
.preview-stage{position:relative;max-width:1100px;height:520px;margin:auto;overflow:hidden;border:1px solid #395159;border-radius:20px;background:#274b57;background-image:radial-gradient(ellipse at 18% 92%,#67a59b88,transparent 55%),radial-gradient(ellipse at 92% 6%,#7869b588,transparent 65%),linear-gradient(145deg,transparent 35%,#8ac3bf38 36%,transparent 62%);--desktop-max-width:720px;--desktop-max-height:510px}
.preview-stage[data-backdrop=light]{background-color:#d7e5e1;background-image:radial-gradient(ellipse at 18% 92%,#75b6a980,transparent 55%),radial-gradient(ellipse at 92% 6%,#bab2d980,transparent 65%),linear-gradient(145deg,transparent 35%,#ffffff80 36%,transparent 62%)}
.preview-guide{position:absolute;left:30px;bottom:24px;color:#b1cbc9;font-size:13px}.preview-stage[data-backdrop=light] .preview-guide{color:#486d68}
.preview-stage .dynamic-island-dock{position:absolute!important;top:24px!important;left:50%;transform:translateX(-50%)}.preview-stage[data-side=left] .dynamic-island-dock{left:0;transform:none}.preview-stage[data-side=right] .dynamic-island-dock{left:auto;right:0;transform:none}.preview-stage[data-side=left] .preview-guide{left:auto;right:30px}.preview-help{text-align:center;margin:22px auto;font-size:12px;color:#91a6aa}
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
