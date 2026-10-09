import { defineConfig } from "@playwright/test";

// E2E 使用生产构建（next build && next start），独立数据库，不影响开发数据
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:3100", viewport: { width: 1600, height: 1000 } },
  webServer: {
    command: "pnpm build && pnpm next start -p 3100",
    url: "http://localhost:3100/api/projects",
    timeout: 240_000,
    reuseExistingServer: false,
    env: { STUDIO_DB_PATH: "data/e2e.db", JIULI_DEMO_ROOT: "/Users/chch/Desktop/九立demo", JIULI_ALLOWED_CUSTOMERS: "*", MODEL_API_KEY: "" },
  },
});
