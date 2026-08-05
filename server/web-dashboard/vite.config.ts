/**
 * [INPUT]: 依赖 Vite/React/Tailwind 插件、LifeOS `/dashboard/` 发布路径与显式开发 API 目标。
 * [OUTPUT]: 对外提供不触碰 59418 的开发代理和 `../web/dashboard` 预构建产物。
 * [POS]: web-dashboard 的构建边界；根 index 由 build 后镜像脚本服务 history fallback。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const DEVELOPMENT_API_TARGET = process.env.LIFEOS_API_TARGET || "http://127.0.0.1:1";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/dashboard/",
  build: {
    outDir: "../web/dashboard",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules/echarts")) return "echarts";
          if (
            id.includes("node_modules/react-dom") ||
            id.includes("node_modules/react-router") ||
            id.includes("node_modules/react/")
          ) {
            return "vendor";
          }
        },
      },
    },
  },
  server: {
    port: Number(process.env.LIFEOS_DASHBOARD_PORT || 5173),
    host: "127.0.0.1",
    proxy: {
      "/v1": {
        target: DEVELOPMENT_API_TARGET,
        changeOrigin: false,
      },
    },
  },
});
