import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { build as bundle } from "esbuild";
const root = fileURLToPath(new URL("..", import.meta.url));
await fs.mkdir(path.join(root, "src-tauri/generated"), { recursive: true });
await bundle({
  entryPoints: [path.join(root, "desktop/tauri-bridge.js")],
  bundle: true,
  platform: "browser",
  format: "iife",
  outfile: path.join(root, "src-tauri/generated/bridge.js"),
});
await build({
  root,
  build: {
    outDir: ".tmp/tauri-web",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: path.join(root, "index.html"),
        preview: path.join(root, "tauri-preview.html"),
        transition: path.join(root, "tauri-transition.html"),
      },
    },
  },
});
