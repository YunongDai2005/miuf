import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

const D1_BINDING_KEY = Symbol.for("berlin-lost-found.d1");

type RuntimeGlobal = typeof globalThis & {
  [D1_BINDING_KEY]?: D1Database;
};

/**
 * Install the request runtime binding before handing control to Vinext. Keeping
 * only the database handle avoids importing `cloudflare:workers` in Node-based
 * server-rendering tests.
 */
export function installD1Binding(database: D1Database | undefined): void {
  (globalThis as RuntimeGlobal)[D1_BINDING_KEY] = database;
}

export function getDb() {
  const database = (globalThis as RuntimeGlobal)[D1_BINDING_KEY];
  if (!database) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return drizzle(database, { schema });
}
