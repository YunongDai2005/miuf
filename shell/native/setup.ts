/// <reference types="vite/client" />
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { configureApi, type JsonTransport } from "../../app/lost-found/net";
import "./photo-library"; // side-effect: registers the PhotoLibrary plugin

/**
 * Origin of the Worker API for the packaged app, e.g.
 * "https://berlin-lost-and-found.<account>.workers.dev". Set at build time with
 * `VITE_WORKER_API_BASE=... npm run shell:build`. Empty falls back to same-origin,
 * which only resolves inside a browser preview, not the packaged app.
 */
const WORKER_API_BASE = (import.meta.env.VITE_WORKER_API_BASE as string | undefined) ?? "";

/**
 * Native HTTP transport for `/api/*`. `CapacitorHttp` issues the request from the
 * native layer, so it is not subject to the WebView's CORS policy (the WebView
 * origin is capacitor://localhost, a different origin from the Worker).
 */
const nativeJsonTransport: JsonTransport = async (url) => {
  const response = await CapacitorHttp.get({
    url,
    headers: { Accept: "application/json" },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}`);
  }
  // CapacitorHttp parses JSON responses; some servers still hand back a string.
  return typeof response.data === "string" ? JSON.parse(response.data) : response.data;
};

/**
 * Wire the shared app networking to the native environment. No-op on the web,
 * where `/api/*` stays a same-origin relative fetch. Synchronous up to the
 * configureApi call so the API base is set before the wizard mounts and loads.
 */
export function setupNativeShell(): void {
  if (!Capacitor.isNativePlatform()) return;
  // The web preview draws a lightweight iPhone frame so the layout can be
  // reviewed on desktop. A real iOS WebView already owns the status bar,
  // Dynamic Island and home indicator, so mark the document before React mounts
  // and let CSS remove only those preview-only chrome elements.
  document.documentElement.dataset.native = "ios";
  configureApi({ baseUrl: WORKER_API_BASE, transport: nativeJsonTransport });
}
