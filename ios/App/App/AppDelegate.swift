import UIKit
import Capacitor

/// Registers app-owned Capacitor plugins before the bundled web application
/// loads. App-target plugins are not included in Capacitor's generated
/// `packageClassList`, so relying on automatic package discovery leaves the
/// JavaScript proxy present but reports "not implemented on iOS" when called.
@objc(AppBridgeViewController)
class AppBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(PhotoLibraryPlugin())
    }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        configureWebViewScrolling()
        return true
    }

    private func configureWebViewScrolling() {
        DispatchQueue.main.async { [weak self] in
            guard let bridge = self?.window?.rootViewController as? CAPBridgeViewController,
                  let scrollView = bridge.webView?.scrollView else { return }

            self?.window?.backgroundColor = .white
            bridge.view.backgroundColor = .white
            bridge.edgesForExtendedLayout = .all
            bridge.extendedLayoutIncludesOpaqueBars = true
            bridge.webView?.isOpaque = true
            bridge.webView?.backgroundColor = .white

            // The HTML document is a fixed app shell. Prevent WKWebView's outer
            // rubber-band movement while keeping inner CSS overflow regions usable.
            scrollView.backgroundColor = .white
            scrollView.contentInsetAdjustmentBehavior = .never
            scrollView.contentInset = .zero
            scrollView.scrollIndicatorInsets = .zero
            scrollView.bounces = false
            scrollView.alwaysBounceVertical = false
            scrollView.alwaysBounceHorizontal = false
            scrollView.minimumZoomScale = 1
            scrollView.maximumZoomScale = 1
            scrollView.pinchGestureRecognizer?.isEnabled = false
        }
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        configureWebViewScrolling()
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
