/**
 * API base + transport indirection.
 *
 * On the Cloudflare web app the front-end and the API share an origin, so
 * `/api/*` is fetched with a relative path and the default `fetch`. The
 * locally-bundled Capacitor shell loads from `capacitor://localhost`, where the
 * API lives on a different origin (the Worker) and a cross-origin `fetch` would
 * hit CORS — so the native shell calls {@link configureApi} at startup to point
 * `/api/*` at an absolute Worker URL and to route requests through a native HTTP
 * transport (Capacitor's `CapacitorHttp`) that is not subject to CORS.
 *
 * This module deliberately imports nothing from Capacitor: shared app code stays
 * buildable by both vinext (Cloudflare) and Vite (shell). The shell injects its
 * transport at runtime.
 */

/** Fetches a URL and resolves the parsed JSON body, or throws on HTTP error. */
export type JsonTransport = (url: string) => Promise<unknown>;

const defaultTransport: JsonTransport = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
};

let apiBase = "";
let transport: JsonTransport = defaultTransport;

/** Called once by the native shell to redirect `/api/*` and swap the transport. */
export function configureApi(options: {
  /** Absolute origin of the Worker API, e.g. "https://api.example.com". No trailing slash. */
  baseUrl?: string;
  /** Native HTTP transport (e.g. CapacitorHttp) used for `/api/*` requests. */
  transport?: JsonTransport;
}): void {
  if (options.baseUrl !== undefined) {
    apiBase = options.baseUrl.replace(/\/$/, "");
  }
  if (options.transport) {
    transport = options.transport;
  }
}

/** Absolute URL for an API path; static (non-`/api/`) paths are returned unchanged. */
export function apiUrl(path: string): string {
  return path.startsWith("/api/") ? `${apiBase}${path}` : path;
}

/** GET JSON from an `/api/*` endpoint via the configured transport. */
export function apiGetJson(path: string): Promise<unknown> {
  return transport(apiUrl(path));
}
