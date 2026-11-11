import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
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
