import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Standalone client build of the Lost & Found wizard for the Capacitor shell.
 *
 * It reuses the exact same client components as the Cloudflare app (app/lost-found/*),
 * but renders fully on-device:
 *   - the page shell is plain client React — no RSC / Worker runtime required;
 *   - static data (berlin-lines / attractions / transit / channels snapshot) is
 *     served from public/ and can be bundled into the app;
 *   - the dynamic /api/* calls are optional — data.ts already falls back to the
 *     bundled channel snapshot when the API is unreachable.
 *
 * Build: `npm run shell:build`  ·  Dev: `npm run shell:dev`
 */
export default defineConfig({
  root: "shell",
  // Serve the repo's static assets at the site root, matching the absolute
  // "/berlin-*.json" fetches in app/lost-found/data.ts.
  publicDir: "../public",
  // Relative asset URLs so the bundle also loads from capacitor://localhost/.
  base: "./",
  build: {
    outDir: "../dist/shell",
    emptyOutDir: true,
    rollupOptions: {
      onwarn(warning, warn) {
        // The client components carry "use client"; harmless in a client-only bundle.
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        warn(warning);
      },
    },
  },
  plugins: [react()],
});
