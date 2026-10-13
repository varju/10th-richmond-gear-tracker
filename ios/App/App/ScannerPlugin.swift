import AVFoundation
import Capacitor
import UIKit

/// Reads QR codes with the camera, for the scan screens (client/src/lib/scanner.ts). The web view's own camera
/// letterboxes as it opens and loses the picture after the app is left; this one comes back by itself.
///
/// The picture sits behind the whole web view, at the viewfinder's place, on a backdrop of the page's navy. While
/// scanning, the web view and the page are see-through, so the target box, hints and item card stay on top.
@objc(ScannerPlugin)
class ScannerPlugin: CAPPlugin, CAPBridgedPlugin, AVCaptureMetadataOutputObjectsDelegate {
    let identifier = "ScannerPlugin"
    let jsName = "ScannerPlugin"
    let pluginMethods: [CAPPluginMethod] = ["start", "layout", "pause", "resume", "torch", "stop"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }

    /// Starting and stopping the session blocks, so that happens here, never on the main thread.
    private let queue = DispatchQueue(label: "ScannerPlugin.session")
    private let session = AVCaptureSession()
    private let output = AVCaptureMetadataOutput()
    private var device: AVCaptureDevice?

    // The rest is main thread only.
    /// Bumped by each start and stop, so a start still waiting on the permission prompt can tell it was stopped.
    private var generation = 0
    private var scanning = false
    private var paused = false
    private var torchOn = false
    private var room: CGFloat = 1.5
    /// The same code is sent once per window; a code in view would otherwise go every frame.
    private var repeatWindow: TimeInterval = 1.5
    private var last: (text: String, at: Date)?
    /// The target box, in the preview's coordinates.
    private var target: CGRect?
    private var preview: PreviewView?
    /// Fills the screen behind the web view, so outside the viewfinder the page still looks navy.
    private var backdrop: UIView?
    private var opaque = true
    private var webBackground: UIColor?
    private var scrollBackground: UIColor?
    /// A runtime error gets one retry; after that it is reported, until the app is next left and come back to.
    private var retried = false
    private var loading: NSKeyValueObservation?

    override func load() {
        // A reload (Capacitor reloads when the web content process dies) never calls stop; the new page starts clean.
        loading = bridge?.webView?.observe(\.isLoading, options: [.new]) { [weak self] _, change in
            guard change.newValue == true else { return }
            DispatchQueue.main.async { self?.halt() }
        }
        let centre = NotificationCenter.default
        // iOS interrupts the session when the app is left. It usually resumes on its own; these make sure.
        centre.addObserver(
            self, selector: #selector(becameActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        centre.addObserver(self, selector: #selector(restart), name: .AVCaptureSessionInterruptionEnded, object: session)
        centre.addObserver(self, selector: #selector(failed(_:)), name: .AVCaptureSessionRuntimeError, object: session)
        centre.addObserver(self, selector: #selector(started), name: .AVCaptureSessionDidStartRunning, object: session)
    }

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.generation += 1
            let mine = self.generation
            self.retried = false
            self.room = CGFloat(call.getDouble("room") ?? 1.5)
            self.repeatWindow = (call.getDouble("repeatMs") ?? 1500) / 1000
            self.last = nil
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized:
                self.open(call, mine)
            case .notDetermined:
                AVCaptureDevice.requestAccess(for: .video) { granted in
                    DispatchQueue.main.async {
                        if granted { self.open(call, mine) } else { call.reject("Camera access was refused.", "denied") }
                    }
                }
            default:
                call.reject("Camera access was refused.", "denied")
            }
        }
    }

    private func open(_ call: CAPPluginCall, _ mine: Int) {
        queue.async {
            let error = self.configure()
            DispatchQueue.main.async {
                if let error { return call.reject("The camera could not start.", error) }
                guard mine == self.generation, let webView = self.bridge?.webView else {
                    return call.reject("Stopped.", "stopped")
                }
                guard self.show(in: webView) else { return call.reject("The camera could not start.", "failed") }
                self.scanning = true
                self.queue.async { self.session.startRunning() }
                call.resolve()
            }
        }
    }

    /// Once per app run, on `queue`. Returns why it failed, or nil.
    private func configure() -> String? {
        if device != nil { return nil }
        guard let camera = Self.backCamera() else { return "nocamera" }
        guard let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input),
              session.canAddOutput(output) else { return "failed" }
        session.beginConfiguration()
        session.addInput(input)
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        session.commitConfiguration()
        // Stickers are read close up.
        if (try? camera.lockForConfiguration()) != nil {
            if camera.isVirtualDevice {
                camera.setPrimaryConstituentDeviceSwitchingBehavior(.auto, restrictedSwitchingBehaviorConditions: [])
            }
            if camera.isAutoFocusRangeRestrictionSupported { camera.autoFocusRangeRestriction = .near }
            if camera.isSmoothAutoFocusSupported { camera.isSmoothAutoFocusEnabled = false }
            camera.videoZoomFactor = Self.wideZoom(camera)
            camera.unlockForConfiguration()
        }
        device = camera
        return nil
    }

    /// The back camera, a virtual one where the phone has it: that hands over between lenses by itself, including
    /// to the ultra-wide when a code is too close for the wide lens to focus (macro).
    private static func backCamera() -> AVCaptureDevice? {
        let types: [AVCaptureDevice.DeviceType] = [
            .builtInTripleCamera, .builtInDualWideCamera, .builtInDualCamera, .builtInWideAngleCamera,
        ]
        let found = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .video, position: .back).devices
        return types.lazy.compactMap { type in found.first { $0.deviceType == type } }.first
    }

    /// The zoom at which the wide lens, the camera app's 1x, is in use. On a virtual camera whose widest lens is
    /// the ultra-wide, zoom 1 is the ultra-wide and the wide lens starts at the first switch-over.
    private static func wideZoom(_ camera: AVCaptureDevice) -> CGFloat {
        guard camera.constituentDevices.first?.deviceType == .builtInUltraWideCamera else { return 1 }
        return camera.virtualDeviceSwitchOverVideoZoomFactors.first.map { CGFloat(truncating: $0) } ?? 1
    }

    /// Printed codes are about this wide, in millimetres.
    private static let codeSize: CGFloat = 32

    /// Zoom so a code fills the target when the phone is at the wide lens's closest focus, as Apple's barcode
    /// sample does. Without it a code fills the target only closer than the lens can focus, so it is blurred.
    /// `fill` is the target's share of the frame's long side.
    ///
    /// It starts from the wide lens, so the picture is what people expect and the macro hand-over still works,
    /// and goes no further than 3x that, and below the next switch-over: the telephoto cannot focus close.
    private static func zoom(_ camera: AVCaptureDevice, fill: CGFloat) -> CGFloat {
        let base = wideZoom(camera)
        var top = min(base * 3, camera.maxAvailableVideoZoomFactor)
        let switches = camera.virtualDeviceSwitchOverVideoZoomFactors.map { CGFloat(truncating: $0) }
        if let next = switches.first(where: { $0 > base + 0.1 }) { top = min(top, next - 0.1) }
        top = max(top, base)
        let wide = camera.constituentDevices.first { $0.deviceType == .builtInWideAngleCamera } ?? camera
        let closest = CGFloat(wide.minimumFocusDistance) // mm; -1 when unknown
        guard closest > 0, fill > 0 else { return base }
        // At zoom z the frame's long side spans 2·tan(fov/2)/z per unit of distance; the code fills `fill` of it.
        let halfAngle = CGFloat(camera.activeFormat.videoFieldOfView) * .pi / 360
        let wanted = 2 * fill * tan(halfAngle) * closest / codeSize
        return min(max(wanted, base), top)
    }

    /// Puts the backdrop and preview below the web view, as a sibling. The web view is the controller's root view,
    /// so its superview is the window's container. False when there is nowhere to put them.
    private func show(in webView: WKWebView) -> Bool {
        if preview != nil { return true }
        let back = UIView()
        back.backgroundColor = webView.backgroundColor ?? .black
        back.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        if let host = webView.superview {
            back.frame = host.bounds
            host.insertSubview(back, belowSubview: webView)
        } else if let window = webView.window {
            back.frame = window.bounds
            window.insertSubview(back, at: 0)
        } else {
            return false
        }
        let view = PreviewView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        view.backgroundColor = .black
        view.isHidden = true // until the page says where
        back.addSubview(view)
        backdrop = back
        preview = view
        opaque = webView.isOpaque
        webBackground = webView.backgroundColor
        scrollBackground = webView.scrollView.backgroundColor
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        return true
    }

    /// Where the viewfinder and target are on screen, in the web view's points (CSS pixels). Sent when they move.
    @objc func layout(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let preview = self.preview, let backdrop = self.backdrop, let webView = self.bridge?.webView
            else { return call.resolve() }
            guard let frame = Self.rect(call.getObject("view")) else {
                preview.isHidden = true
                return call.resolve()
            }
            preview.frame = webView.convert(frame, to: backdrop)
            preview.isHidden = false
            #if DEBUG
            CAPLog.print("ScannerPlugin preview \(preview.frame) hidden \(preview.isHidden)")
            #endif
            // No target while the card is up; the last one still holds.
            if let box = Self.rect(call.getObject("target")) {
                self.target = box.offsetBy(dx: -frame.minX, dy: -frame.minY)
            }
            self.orient()
            self.aim()
            call.resolve()
        }
    }

    /// Stop handing over codes, freeze the picture on the one just read, and put the torch out until resume.
    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.paused = true
            self.preview?.previewLayer.connection?.isEnabled = false
            self.applyTorch()
            call.resolve()
        }
    }

    @objc func resume(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.paused = false
            self.preview?.previewLayer.connection?.isEnabled = true
            self.applyTorch()
            call.resolve()
        }
    }

    @objc func torch(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.torchOn = call.getBool("on") ?? false
            self.applyTorch()
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.halt()
            call.resolve()
        }
    }

    /// Camera, torch and see-through web view all off. Main thread.
    private func halt() {
        generation += 1
        scanning = false
        paused = false
        torchOn = false
        target = nil
        if let backdrop {
            backdrop.removeFromSuperview()
            self.backdrop = nil
            preview = nil
            if let webView = bridge?.webView {
                webView.isOpaque = opaque
                webView.backgroundColor = webBackground
                webView.scrollView.backgroundColor = scrollBackground
            }
        }
        applyTorch()
        queue.async { self.session.stopRunning() }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection
    ) {
        guard scanning, !paused, let code = objects.first as? AVMetadataMachineReadableCodeObject,
              let text = code.stringValue else { return }
        let now = Date()
        if let last, last.text == text, now.timeIntervalSince(last.at) < repeatWindow { return }
        last = (text, now)
        notifyListeners("code", data: ["text": text])
    }

    @objc private func becameActive() {
        DispatchQueue.main.async {
            self.retried = false
            self.restart()
        }
    }

    @objc private func restart() {
        DispatchQueue.main.async {
            guard self.scanning else { return }
            self.queue.async {
                if !self.session.isRunning { self.session.startRunning() }
            }
        }
    }

    @objc private func started() {
        DispatchQueue.main.async {
            guard self.scanning else { return }
            // The output's coordinates are only known once frames flow, and the torch goes off with the session.
            self.aim()
            self.applyTorch()
            self.notifyListeners("ready", data: ["torch": self.device?.hasTorch ?? false])
        }
    }

    /// A reset of the media services restarts at once, as Apple's sample does. Any other error gets one retry a
    /// second later; a second one is reported, and coming back to the app tries again.
    @objc private func failed(_ notification: Notification) {
        let error = notification.userInfo?[AVCaptureSessionErrorKey] as? AVError
        DispatchQueue.main.async {
            guard self.scanning else { return }
            if error?.code == .mediaServicesWereReset { return self.restart() }
            if self.retried { return self.notifyListeners("error", data: [:]) }
            self.retried = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.restart() }
        }
    }

    /// Detect only around the target, with the same room as the web scanner (`TARGET_ROOM`).
    /// Focus, expose and zoom for it too. Preview and output zoom alike, so the area holds at any zoom.
    private func aim() {
        guard let layer = preview?.previewLayer else { return }
        let whole = CGRect(x: 0, y: 0, width: 1, height: 1)
        var area = whole
        var centre: CGPoint?
        var fill: CGFloat = 0
        if let box = target, !box.isEmpty {
            let w = box.width * room
            let h = box.height * room
            let region = CGRect(x: box.midX - w / 2, y: box.midY - h / 2, width: w, height: h)
            area = layer.metadataOutputRectConverted(fromLayerRect: region).intersection(whole)
            if area.isNull || area.isEmpty { area = whole }
            // Output coordinates run along the sensor, x on its long side, whichever way the screen is turned.
            fill = layer.metadataOutputRectConverted(fromLayerRect: box).width
            centre = layer.captureDevicePointConverted(fromLayerPoint: CGPoint(x: box.midX, y: box.midY))
        }
        queue.async {
            self.output.rectOfInterest = area
            guard let device = self.device, let centre, (try? device.lockForConfiguration()) != nil else { return }
            defer { device.unlockForConfiguration() }
            // The point first: setting the mode is what applies it.
            if device.isFocusPointOfInterestSupported { device.focusPointOfInterest = centre }
            if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
            if device.isExposurePointOfInterestSupported { device.exposurePointOfInterest = centre }
            if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
            if fill > 0, fill <= 1 { device.videoZoomFactor = Self.zoom(device, fill: fill) }
        }
    }

    /// Turn the picture with the screen. Interface and capture orientations share raw values.
    private func orient() {
        guard let connection = preview?.previewLayer.connection,
              let orientation = preview?.window?.windowScene?.interfaceOrientation else { return }
        if #available(iOS 17.0, *) {
            let angles: [UIInterfaceOrientation: CGFloat] = [.landscapeRight: 0, .landscapeLeft: 180, .portraitUpsideDown: 270]
            let angle = angles[orientation] ?? 90
            if connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle }
        } else if let video = AVCaptureVideoOrientation(rawValue: orientation.rawValue),
                  connection.isVideoOrientationSupported {
            connection.videoOrientation = video
        }
    }

    private func applyTorch() {
        let on = torchOn && scanning && !paused
        queue.async {
            guard let device = self.device, device.hasTorch, (try? device.lockForConfiguration()) != nil else { return }
            device.torchMode = on ? .on : .off
            device.unlockForConfiguration()
        }
    }

    private static func rect(_ object: JSObject?) -> CGRect? {
        guard let object,
              let x = (object["x"] as? NSNumber)?.doubleValue, let y = (object["y"] as? NSNumber)?.doubleValue,
              let w = (object["w"] as? NSNumber)?.doubleValue, let h = (object["h"] as? NSNumber)?.doubleValue,
              w > 0, h > 0 else { return nil }
        return CGRect(x: x, y: y, width: w, height: h)
    }
}

/// A view whose own layer is the camera preview, so it follows the view's frame with no extra layout.
class PreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}
