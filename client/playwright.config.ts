import { defineConfig, devices } from "@playwright/test";

const PORT = 8765;

// Few, and each one earns its seconds (architecture.md, "Browser tests").
export default defineConfig({
  testDir: "e2e",
  // One server, one database: the files share them, so they run one at a time.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices["Pixel 7"],
  },
  webServer: {
    command: "./e2e/serve.sh",
    port: PORT,
    reuseExistingServer: false,
    env: { E2E_PORT: String(PORT) },
  },
});
