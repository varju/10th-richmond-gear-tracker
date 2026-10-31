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

/** "Check gear out" becomes "check-gear-out", which is the anchor a contents link uses. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

interface Heading {
  id: string;
  text: string;
  children: Heading[];
}

interface Section {
  id: string;
  title: string;
  html: string;
  headings: Heading[];
}

function compile(file: string, markdown: string): Section {
  const headings: Heading[] = [];
  let title = file.replace(/\.md$/, "");
  // A file with h3s is grouped: its h2s are groups, its h3s the tasks. Otherwise the h2s are the tasks.
  const grouped = /^### /m.test(markdown);
  const marked = new Marked({
    renderer: {
      heading(token) {
        const text = this.parser.parseInline(token.tokens);
        // The one h1 is the section's name; the h2s and h3s are the contents.
        if (token.depth === 1) {
          title = text;
          return "";
        }
        const id = slug(token.text);
        if (token.depth === 2) headings.push({ id, text, children: [] });
        if (token.depth === 3 && grouped) headings.at(-1)?.children.push({ id, text, children: [] });
        const group = grouped && token.depth === 2 ? ' class="group"' : "";
        return `<h${token.depth + 1} id="${id}"${group}>${text}</h${token.depth + 1}>\n`;
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
      const sections = GUIDE_FILES.filter((f) => {
        const exists = existsSync(join(GUIDE_DIR, f));
        if (!exists) this.warn(`gear-guide: missing guide section "${f}" in ${GUIDE_DIR}`);
        return exists;
      }).map((f) => {
        this.addWatchFile(join(GUIDE_DIR, f));
        return compile(f, readFileSync(join(GUIDE_DIR, f), "utf8"));
      });
      if (sections.length === 0) {
        this.error(`gear-guide: no guide sections found in ${GUIDE_DIR}. Expected one of: ${GUIDE_FILES.join(", ")}.`);
      }
      return `export const sections = ${JSON.stringify(sections)};`;
    },
  };
}

// The Python server owns these paths. In development Vite serves the app and
// forwards them; in production the server serves the built app itself.
const API = ["/sync", "/auth", "/users", "/public", "/photos", "/mail", "/codes", "/mcp", "/privacy"];

// Where the app is served from. A domain root in development and for anyone
// hosting it alone; a path when it sits under an existing site. Set at build
// time, because it is baked into every asset URL. Always ends in a slash.
const base = process.env.BASE_PATH || "/";

// The commit this build is from, shown in Settings. "dev" under `npm run dev`
// and `npm test`, where nothing sets GIT_SHA.
const gitSha = process.env.GIT_SHA || "dev";

// Where the server is, for the iPhone app (NFR-DEP-11), e.g. https://example.org/gear. The app
// serves this client from its own origin, so it cannot reach the API by path. Empty for the
// web build, which is same-origin with the server. Setting it makes this the native build.
const serverUrl = (process.env.SERVER_URL || "").replace(/\/+$/, "");
const native = serverUrl !== "";
if (native && base !== "/")
  throw new Error("BASE_PATH must be / when SERVER_URL is set: the app serves the client from its root");

export default defineConfig({
  base,
  // Apart from the web build, so `make serve` never serves the app's by mistake.
  build: { outDir: native ? "dist-ios" : "dist" },
  define: {
    __GIT_SHA__: JSON.stringify(gitSha),
    __SERVER_URL__: JSON.stringify(serverUrl),
  },
  plugins: [
    react(),
    guide(),
    VitePWA({
      // The app has the shell on disk already, and WKWebView has no service worker for it.
      disable: native,
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
