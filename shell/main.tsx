import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import LostFound from "../app/lost-found/LostFound";
import { setupNativeShell } from "./native/setup";
import "../app/globals.css";

// Point `/api/*` at the Worker and register the PhotoKit plugin when running
// inside the native app. No-op on the web. Runs before mount so the wizard's
// initial data load already uses the native transport.
setupNativeShell();

// The Cloudflare app renders <LostFound /> through a thin RSC shell (app/page.tsx).
// Here we mount the same client component directly, proving the wizard runs with
// no server-rendered dependency — the basis for the locally-bundled Capacitor UI.
const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root is missing from index.html");
}

createRoot(container).render(
  <StrictMode>
    <LostFound />
  </StrictMode>
);
