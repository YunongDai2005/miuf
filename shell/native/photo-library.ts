import { registerPlugin } from "@capacitor/core";
import type { PhotoLibraryPlugin } from "../../app/lost-found/photoLibrary";

/**
 * Registers the native "PhotoLibrary" plugin so it is reachable at
 * `Capacitor.Plugins.PhotoLibrary` (which app/lost-found/photoLibrary.ts reads).
 * The iOS implementation lives in native/ios/PhotoLibrary/PhotoLibraryPlugin.swift.
 *
 * There is no web implementation on purpose: on the web the wizard uses the
 * existing `<input type=file>` + exifr path, so the web stub simply reports that
 * the plugin is unavailable.
 */
export const PhotoLibrary = registerPlugin<PhotoLibraryPlugin>("PhotoLibrary", {
  web: () => {
    const unavailable = (): never => {
      throw new Error("PhotoLibrary is only available in the native app.");
    };
    return {
      requestAuthorization: unavailable,
      fetchPhotoPoints: unavailable,
    } as PhotoLibraryPlugin;
  },
});
