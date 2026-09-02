import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { Marked } from "marked";
import type { Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

const NAVY = "#001a70";

// --- The user guide (NFR-USE-11) ---------------------------------------------------------
//
// docs/guide/*.md becomes HTML here, at build time, so no markdown parser ships
// to the browser. The app imports "virtual:guide"; see src/guide.d.ts.

const GUIDE_DIR = resolve(import.meta.dirname, "../docs/guide");

// The order the sections read in. A file that is not written yet is skipped, so
// a new section is added by dropping the file in and naming it here.
const GUIDE_FILES = ["scouter.md", "quartermaster.md", "assistant.md"];

/** "Take gear out" becomes "take-gear-out", which is the anchor a contents link uses. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

interface Section {
  id: string;
  title: string;
  html: string;
  headings: { id: string; text: string }[];
}

function compile(file: string, markdown: string): Section {
  const headings: { id: string; text: string }[] = [];
  let title = file.replace(/\.md$/, "");
  const marked = new Marked({
    renderer: {
      heading(token) {
        const text = this.parser.parseInline(token.tokens);
        // The one h1 is the section's name; the h2s are its tasks, and the contents.
        if (token.depth === 1) {
          title = text;
          return "";
        }
        const id = slug(token.text);
        if (token.depth === 2) headings.push({ id, text });
        return `<h${token.depth + 1} id="${id}">${text}</h${token.depth + 1}>\n`;
      },
    },
  });
  const html = marked.parse(markdown, { async: false });
  return { id: slug(file.replace(/\.md$/, "")), title, html, headings };
}

function guide(): Plugin {
  const virtual = "virtual:guide";
  const resolved = `\0${virtual}`;
  return {
    name: "gear-guide",
    resolveId: (id) => (id === virtual ? resolved : undefined),
    load(id) {
      if (id !== resolved) return undefined;
      const sections = GUIDE_FILES.filter((f) => existsSync(join(GUIDE_DIR, f))).map((f) => {
        this.addWatchFile(join(GUIDE_DIR, f));
        return compile(f, readFileSync(join(GUIDE_DIR, f), "utf8"));
      });
      return `export const sections = ${JSON.stringify(sections)};`;
    },
  };
}

// The Python server owns these paths. In development Vite serves the app and
// forwards them; in production the server serves the built app itself.
const API = ["/sync", "/auth", "/users", "/public", "/photos", "/mail", "/codes", "/mcp"];

// Where the app is served from. A domain root in development and for anyone
// hosting it alone; a path when it sits under an existing site. Set at build
// time, because it is baked into every asset URL. Always ends in a slash.
const base = process.env.BASE_PATH || "/";

export default defineConfig({
  base,
  plugins: [
    react(),
    guide(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Gear Tracker",
        scope: base,
        start_url: base,
        short_name: "Gear",
        description: "Where the gear is, and who has it",
        theme_color: NAVY,
        background_color: NAVY,
        display: "standalone",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          {
            src: "icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        // The app shell only. Data lives in IndexedDB, and API calls must never be answered from a cache.
        globPatterns: ["**/*.{js,css,html,png,svg,wasm}"],
        navigateFallbackDenylist: API.map((p) => new RegExp(`^${base}${p.slice(1)}`)),
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
