import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "renderer",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    // 编辑器/工具写文件时的临时目录（*.tmp、*.tmpdir）不进 watcher：
    // 否则瞬时锁定的临时文件会让 chokidar 抛 EBUSY 击穿 dev server。
    watch: {
      ignored: ["**/*.tmp", "**/tmpdir/**", "**/.*.tmpdir"],
    },
  },
});
