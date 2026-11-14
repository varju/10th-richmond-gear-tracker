import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 8775);

// App Store screenshots at each display size the store asks for: `make store-shots`.
// A desktop browser's user agent, so the iPhone install prompt stays hidden as it does in the app.
export default defineConfig({
  testDir: "store",
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, hasTouch: true },
  projects: [
    { name: "ipad-13", use: { viewport: { width: 1032, height: 1376 }, deviceScaleFactor: 2 } },
    { name: "iphone-6.9", use: { viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true } },
  ],
  webServer: {
    command: "./e2e/serve.sh",
    port: PORT,
    reuseExistingServer: false,
    env: { E2E_PORT: String(PORT), E2E_SCENE: "store" },
  },
});
