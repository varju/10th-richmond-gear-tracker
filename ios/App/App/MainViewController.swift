import Capacitor
import UIKit

/// The web view, plus the one thing WKWebView will not do on its own: `window.print()`.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(PrintPlugin())
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
