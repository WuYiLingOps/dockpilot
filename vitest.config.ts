import { defineConfig } from "vitest/config";

// 只测 src/lib/sync/ 下的纯函数（方案第 7 节）：node 环境自带 WebCrypto，
// 不加载主 vite.config.ts（无需 react/tailwind 插件）
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/lib/sync/**/*.test.ts"],
    testTimeout: 20000,
  },
});
