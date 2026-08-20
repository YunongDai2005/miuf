import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor iOS shell. The web assets are the standalone client build produced by
 * `npm run shell:build` (see vite.shell.config.ts) — the same Lost & Found wizard
 * as the Cloudflare app, rendered fully on-device. The Worker API and the review
 * backend are NOT bundled; the app calls the Worker over HTTPS (see
 * shell/native/setup.ts + app/lost-found/net.ts).
 */
const config: CapacitorConfig = {
  appId: "de.berlinlostfound.app",
  appName: "Berlin Lost & Found",
  webDir: "dist/shell",
  ios: {
    // Draw edge-to-edge. The app shell owns status-bar and home-indicator spacing.
    contentInset: "never",
  },
};

export default config;
