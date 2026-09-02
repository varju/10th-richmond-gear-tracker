import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

const NAVY = "#001a70";

// The Python server owns these paths. In development Vite serves the app and
// forwards them; in production the server serves the built app itself.
const API = ["/sync", "/auth", "/users"];

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Gear Tracker",
        short_name: "Gear",
        description: "Where the gear is, and who has it",
        theme_color: NAVY,
        background_color: NAVY,
        display: "standalone",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      workbox: {
        // The app shell only. Data lives in IndexedDB, and API calls must never be answered from a cache.
        globPatterns: ["**/*.{js,css,html,png,svg,wasm}"],
        navigateFallbackDenylist: API.map((p) => new RegExp(`^${p}`)),
      },
    }),
  ],
  server: {
    proxy: Object.fromEntries(API.map((p) => [p, "http://127.0.0.1:8000"])),
  },
  test: {
    environment: "happy-dom",
    setupFiles: ["src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
