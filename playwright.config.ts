import { defineConfig } from "@playwright/test";

// E2E 使用生产构建（next build && next start），独立数据库，不影响开发数据
// 端口默认 3100，被占用时可用 E2E_PORT 覆盖
const port = process.env.E2E_PORT ?? "3100";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1600, height: 1000 } },
  webServer: {
    command: `pnpm build && pnpm next start -H 127.0.0.1 -p ${port}`,
    url: `http://127.0.0.1:${port}/api/projects`,
    timeout: 240_000,
    reuseExistingServer: false,
    env: { STUDIO_DB_PATH: "data/e2e.db", STUDIO_MATERIALS_DIR: "data/e2e-materials", JIULI_DEMO_ROOT: "/Users/chch/Desktop/九立demo", JIULI_ALLOWED_CUSTOMERS: "*", MODEL_API_KEY: "" },
  },
});
