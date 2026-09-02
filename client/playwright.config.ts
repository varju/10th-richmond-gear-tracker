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
  },
  // The same build at both widths (NFR-USE-10). One database and one server:
  // the projects run in order, not at the same time.
  projects: [
    {
      name: "phone",
      use: { ...devices["Pixel 7"] },
      testIgnore: /desk\.spec\.ts/,
    },
    {
      name: "desk",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
      testMatch: /(desk|a11y)\.spec\.ts/,
    },
  ],
  webServer: {
    command: "./e2e/serve.sh",
    port: PORT,
    reuseExistingServer: false,
    env: { E2E_PORT: String(PORT) },
  },
});
