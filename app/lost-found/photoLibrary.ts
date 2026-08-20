import type { PhotoPoint } from "./photos";

/**
 * Bridge to the native PhotoKit plugin (see shell/native/photo-library.ts and the
 * Swift `PhotoLibraryPlugin`). On iOS this reads geotag + capture time straight
 * from the photo library's metadata — no image pixels are decoded, so scanning a
 * whole day of 100+ photos is near-instant, and nothing leaves the device.
 *
 * This module imports nothing from Capacitor so it stays buildable by both the
 * Cloudflare app and the Vite shell; it reaches the plugin through the global
 * `Capacitor` object that the native shell populates at runtime. On the web the
 * plugin is absent and callers fall back to the `<input type=file>` + exifr path.
 */

export type PhotoAuthStatus =
  | "authorized"
  | "limited"
  | "denied"
  | "restricted"
  | "notDetermined";

/** One geotagged photo as returned by the native plugin. */
export interface NativePhotoPoint {
  lat: number;
  lng: number;
  time: number | null; // epoch ms from the asset's creationDate
}

export interface FetchPhotoPointsOptions {
  /** Device-local day "YYYY-MM-DD" to restrict to; omit to scan the whole library. */
  day?: string;
  /** Inclusive device-local date range. Takes precedence over `day`. */
  startDate?: string;
  endDate?: string;
  /** Or restrict to photos from the last N days. */
  sinceDays?: number;
  /** Safety cap on assets scanned (0 / omitted = no cap). */
  limit?: number;
}

export interface FetchPhotoPointsResult {
  status: PhotoAuthStatus;
  total: number; // image assets scanned
  withGps: number; // assets that carried a location
  points: NativePhotoPoint[];
}

/** The native plugin contract (implemented in Swift, stubbed on web). */
export interface PhotoLibraryPlugin {
  requestAuthorization(): Promise<{ status: PhotoAuthStatus }>;
  fetchPhotoPoints(options?: FetchPhotoPointsOptions): Promise<FetchPhotoPointsResult>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  isPluginAvailable?: (name: string) => boolean;
  Plugins?: { PhotoLibrary?: PhotoLibraryPlugin };
}

function capacitor(): CapacitorGlobal | undefined {
  return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
}

function nativePlugin(): PhotoLibraryPlugin | null {
  const cap = capacitor();
  if (!cap?.isNativePlatform?.()) return null;
  if (!cap.isPluginAvailable?.("PhotoLibrary")) return null;
  return cap.Plugins?.PhotoLibrary ?? null;
}

/** True only inside the native Capacitor shell with the plugin registered. */
export function hasNativePhotoLibrary(): boolean {
  return nativePlugin() !== null;
}

/** Ask for photo-library access; resolves the resulting authorization status. */
export async function requestPhotoAuthorization(): Promise<PhotoAuthStatus> {
  const plugin = nativePlugin();
  if (!plugin) return "denied";
  const { status } = await plugin.requestAuthorization();
  return status;
}

export interface NativeImportResult {
  status: PhotoAuthStatus;
  total: number;
  withGps: number;
  points: PhotoPoint[];
}

/**
 * Pull geotag + time points from the native photo library, shaped exactly like
 * {@link extractPhotoPoints} so the same day-grouping / de-dup / anchor pipeline
 * applies unchanged.
 */
export async function importNativePhotoPoints(
  options?: FetchPhotoPointsOptions
): Promise<NativeImportResult> {
  const plugin = nativePlugin();
  if (!plugin) {
    throw new Error("Native photo library is not available on this platform.");
  }
  const result = await plugin.fetchPhotoPoints(options);
  const points: PhotoPoint[] = result.points
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
    .map((point) => ({
      lat: point.lat,
      lng: point.lng,
      time: point.time ?? null,
    }));
  return {
    status: result.status,
    total: result.total,
    withGps: result.withGps,
    points,
  };
}
