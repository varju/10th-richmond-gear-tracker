import Capacitor
import UIKit

/// The web view, plus what WKWebView will not do on its own: `window.print()`, and links that open the app.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(PrintPlugin())
        bridge?.registerPluginInstance(LinkPlugin())
    }
}

/// Prints the page as it stands, with its print stylesheet, through the system print sheet.
/// The web client calls it in place of `window.print()` (client/src/lib/share.ts).
@objc(PrintPlugin)
class PrintPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "PrintPlugin"
    let jsName = "PrintPlugin"
    let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "print", returnType: CAPPluginReturnPromise)]

    @objc func print(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let webView = self.bridge?.webView else {
                call.reject("no web view")
                return
            }
            let printer = UIPrintInteractionController.shared
            printer.printFormatter = webView.viewPrintFormatter()
            printer.present(animated: true) { _, _, _ in call.resolve() }
        }
    }
}

/// Holds the last link the app was opened with until the page takes it (client/src/lib/links.ts).
/// The page asks when it starts, so a link that launches the app waits for it, and again on each
/// `gear:link` event. Capacitor's SceneDelegateProxy posts the link, including one that launched
/// the app, once this plugin is loaded.
@objc(LinkPlugin)
class LinkPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "LinkPlugin"
    let jsName = "LinkPlugin"
    let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "take", returnType: CAPPluginReturnPromise)]
    private var pending: URL?

    override func load() {
        NotificationCenter.default.addObserver(
            self, selector: #selector(opened(_:)), name: .capacitorOpenUniversalLink, object: nil)
        #if DEBUG
        // The simulator opens https links in Safari, so Debug builds also take
        // geartracker-debug:<link> to try this path (docs/deploy.md).
        NotificationCenter.default.addObserver(
            self, selector: #selector(opened(_:)), name: .capacitorOpenURL, object: nil)
        #endif
    }

    @objc func opened(_ notification: Notification) {
        guard let url = (notification.object as? [String: Any])?["url"] as? URL else { return }
        DispatchQueue.main.async {
            self.pending = Self.unwrap(url)
            self.bridge?.triggerWindowJSEvent(eventName: "gear:link")
        }
    }

    /// In a Debug build, geartracker-debug:<link> stands for <link>.
    private static func unwrap(_ url: URL) -> URL {
        #if DEBUG
        let prefix = "geartracker-debug:"
        if url.absoluteString.hasPrefix(prefix), let inner = URL(string: String(url.absoluteString.dropFirst(prefix.count))) {
            return inner
        }
        #endif
        return url
    }

    @objc func take(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let url = self.pending
            self.pending = nil
            call.resolve(url.map { ["url": $0.absoluteString] } ?? [:])
        }
    }
}
