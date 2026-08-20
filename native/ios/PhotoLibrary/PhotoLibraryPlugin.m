#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Exposes PhotoLibraryPlugin (Swift) to Capacitor's runtime under the name
// "PhotoLibrary". Capacitor discovers plugins through this macro, so both this
// file and PhotoLibraryPlugin.swift must be members of the App target.
CAP_PLUGIN(PhotoLibraryPlugin, "PhotoLibrary",
    CAP_PLUGIN_METHOD(requestAuthorization, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(fetchPhotoPoints, CAPPluginReturnPromise);
)
