import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
const buildVersion =
  process.env.QINGDAO_BUILD_VERSION ||
  JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
    .version;

export default defineConfig({
  plugins: [
    {
      name: "qingdan-build-version",
      transformIndexHtml: () => [
        {
          tag: "meta",
          attrs: { name: "qingdan-build-version", content: buildVersion },
          injectTo: "head",
        },
      ],
    },
    react(),
    tailwindcss(),
  ],
  server: {
    watch: { ignored: ["**/.tmp/**", "**/.wrangler/**", "**/output/**"] },
    port: 5178,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8788",
        ws: true,
        changeOrigin: true,
        configure(proxy) {
          const localOrigin = (proxyRequest, request) => {
            if (request.headers.origin === "http://127.0.0.1:5178")
              proxyRequest.setHeader("origin", "http://127.0.0.1:8788");
          };
          proxy.on("proxyReq", localOrigin);
          proxy.on("proxyReqWs", localOrigin);
        },
      },
    },
  },
});
