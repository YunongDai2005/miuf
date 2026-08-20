# iOS app (Capacitor shell + PhotoKit plugin)

The iOS app is a thin native shell around the **same** Lost & Found wizard the web
app runs. The UI is the standalone client build (`npm run shell:build` →
`dist/shell/`); the Worker API and the review backend stay on Cloudflare and are
reached over HTTPS. A custom PhotoKit plugin replaces the web `<input type=file>`
so the traveller can pull a whole day's geotags straight from the photo library.

## What's already in the repo

| Piece | Where |
| --- | --- |
| Standalone client build target | `vite.shell.config.ts`, `shell/` |
| Capacitor config | `capacitor.config.ts` (`webDir: dist/shell`) |
| API base + native HTTP indirection | `app/lost-found/net.ts`, wired in `app/lost-found/data.ts` |
| Native startup wiring | `shell/native/setup.ts` (points `/api/*` at the Worker via `CapacitorHttp`) |
| PhotoKit plugin — TS registration | `shell/native/photo-library.ts` |
| PhotoKit plugin — shared bridge/types | `app/lost-found/photoLibrary.ts` |
| PhotoKit plugin — Swift implementation | `native/ios/PhotoLibrary/PhotoLibraryPlugin.{swift,m}` |
| Native import UI (capability-detected) | `app/lost-found/steps/StepRetrace.tsx` |

`app/` never imports Capacitor, so the Cloudflare build is unaffected; all native
wiring lives in `shell/` and reaches the app through the runtime `Capacitor` global.

## One-time setup

1. **Generate the iOS project with Swift Package Manager** (no CocoaPods
   installation is required):
   ```bash
   npm run shell:build
   npx cap add ios --packagemanager SPM
   ```
2. **Add the PhotoKit plugin to the App target.** In Xcode
   (`ios/App/App.xcodeproj`), add both files to the `App` target:
   - `native/ios/PhotoLibrary/PhotoLibraryPlugin.swift`
   - `native/ios/PhotoLibrary/PhotoLibraryPlugin.m`

   (Choose "Reference files in place" or copy — either works. Capacitor discovers
   the plugin at runtime via the `CAP_PLUGIN` macro in the `.m` file.)
3. **Add the photo-library usage string** to `ios/App/App/Info.plist`:
   ```xml
   <key>NSPhotoLibraryUsageDescription</key>
   <string>Reads only the time and location of your photos, on this device, to work out which lost-property offices to contact. Your photos are never uploaded.</string>
   ```
4. **Set your signing team** in Xcode (Signing & Capabilities → Team).

The checked-in iOS project already references the two plugin source files and
contains the usage string. These manual steps are only needed if `ios/` is
deleted and regenerated from scratch.

## Point the app at your Worker

The packaged app can't use a relative `/api`, so set the Worker origin at build time:

```bash
VITE_WORKER_API_BASE=https://<your-worker-host> npm run shell:build
npx cap sync ios      # or: npm run cap:sync
```

Requests to `/api/*` then go to `https://<your-worker-host>/api/*` through
`CapacitorHttp` (native HTTP, so no CORS). Static data (`berlin-*.json`) is bundled
and served locally; the reviewed-channel registry falls back to the bundled
snapshot when the Worker is unreachable, so the wizard still works offline.

> **CORS note:** if you'd rather use `fetch` than `CapacitorHttp`, the Worker must
> send `Access-Control-Allow-Origin: capacitor://localhost`. `CapacitorHttp`
> avoids this entirely and is the default here.

## Everyday loop

```bash
npm run cap:sync   # shell:build + cap sync ios
npm run cap:open   # open ios/App/App.xcworkspace in Xcode, then Run
```

## The PhotoKit plugin, briefly

`PhotoLibraryPlugin` exposes two methods (contract in `app/lost-found/photoLibrary.ts`):

- `requestAuthorization()` → `{ status }` — asks for photo access (`.limited` is fine).
- `fetchPhotoPoints({ day?, sinceDays?, limit? })` → `{ status, total, withGps, points }`
  where each point is `{ lat, lng, time }`.

It reads `PHAsset.location` and `PHAsset.creationDate` only — **asset metadata, no
pixels decoded** — so a 100+ photo day returns almost instantly, and only
coordinates + timestamps cross into the WebView. `StepRetrace` feeds `points` into
the same `groupPhotoDays` / `dedupeByTime` / `reconstructPhotoAnchors` pipeline the
web path uses, so day-grouping and <1-min de-duplication behave identically.

The review workbench (`app/review/*`) is **not** part of this app; it stays a
browser app on Cloudflare.
