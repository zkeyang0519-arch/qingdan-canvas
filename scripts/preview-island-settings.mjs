import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(root, ".tmp/island-settings-preview");
await mkdir(output, { recursive: true });
await build({
  entryPoints: [path.join(root, "tests/fixtures/island-settings-preview.jsx")],
  outfile: path.join(output, "preview.js"),
  bundle: true,
  format: "esm",
  external: ["/fonts/*"],
});
await writeFile(
  path.join(output, "index.html"),
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>轻岛 · 外观与设置预览</title><link rel="stylesheet" href="/preview.css"></head><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>`,
);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};
const port = Number(process.env.QINGDAO_SETTINGS_PREVIEW_PORT || 18866);
if (process.argv.includes("--build-only")) process.exit(0);
createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    const directory = /^\/(fonts|animals|island-releases)\//.test(pathname)
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
