import { defineConfig } from "vitest/config";

// 核心层是纯逻辑（无 DOM），node 环境跑；不引 jsdom。
// 注意：本配置独立于 vite.config.ts（那边是 Tauri/dev server 配置，测试不需要 fang alias）。
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
