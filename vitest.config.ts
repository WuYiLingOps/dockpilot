import { defineConfig } from "vitest/config";

// 只测纯函数（不引入组件测试依赖）：node 环境自带 WebCrypto，
// 不加载主 vite.config.ts（无需 react/tailwind 插件）
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 20000,
  },
});
