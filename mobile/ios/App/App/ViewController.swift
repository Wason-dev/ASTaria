import Capacitor
import WebKit

private let sceneThemeKey = "astaria.scene-theme"

private func applySceneBackground(_ theme: String, to webView: WKWebView?) {
    let color = theme == "light"
        ? UIColor(red: 248 / 255, green: 246 / 255, blue: 242 / 255, alpha: 1)
        : UIColor(red: 5 / 255, green: 5 / 255, blue: 6 / 255, alpha: 1)
    // UIKit may reveal these layers before WebKit repaints an enlarged window.
    // Keep the native backing in the scene's theme, not the OS's default white.
    webView?.backgroundColor = color
    webView?.scrollView.backgroundColor = color
    if #available(iOS 15.0, *) { webView?.underPageBackgroundColor = color }
    webView?.window?.backgroundColor = color
}

@objc(ASTariaAppearancePlugin)
final class ASTariaAppearancePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "ASTariaAppearancePlugin"
    let jsName = "ASTariaAppearance"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setTheme", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getViewport", returnType: CAPPluginReturnPromise)
    ]
    private weak var marker: UIView?
    private var displayLink: CADisplayLink?
    private var lastSample: [String: Any]?
    private var revision = 0
    private var finishAt: CFTimeInterval = 0
    private var layoutSamplePending = false

    func installKeyboardGuide(in webView: WKWebView) {
        let marker = UIView()
        marker.isUserInteractionEnabled = false
        marker.backgroundColor = .clear
        marker.translatesAutoresizingMaskIntoConstraints = false
        webView.addSubview(marker)
        NSLayoutConstraint.activate([
            marker.topAnchor.constraint(equalTo: webView.keyboardLayoutGuide.topAnchor),
            marker.leadingAnchor.constraint(equalTo: webView.leadingAnchor),
            marker.widthAnchor.constraint(equalToConstant: 1),
            marker.heightAnchor.constraint(equalToConstant: 1)
        ])
        self.marker = marker
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillChange(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardDidChange), name: UIResponder.keyboardDidChangeFrameNotification, object: nil)
    }
    deinit { displayLink?.invalidate(); NotificationCenter.default.removeObserver(self) }

    private func viewport() -> [String: Any]? {
        guard let webView = bridge?.webView, webView.window != nil, webView.bounds.width > 0 else { return nil }
        let bounds = webView.bounds, safe = webView.safeAreaInsets
        let top = displayLink != nil
            ? (marker?.layer.presentation()?.frame.minY ?? webView.keyboardLayoutGuide.layoutFrame.minY)
            : webView.keyboardLayoutGuide.layoutFrame.minY
        // The layout guide rests at the bottom safe area when there is no IME.
        // It follows docked keyboards only, so floating iPad keyboards do not
        // collapse the whole page or reuse a rectangle from another window.
        let inset = max(0, min(bounds.height, bounds.height - top))
        let occupied = inset > safe.bottom + 1 ? inset : 0
        return ["layoutWidth": bounds.width, "layoutHeight": bounds.height,
                "visibleHeight": max(1, bounds.height - occupied), "keyboardInset": occupied,
                "keyboardVisible": occupied > 0,
                "safeArea": ["top": safe.top, "right": safe.right, "bottom": safe.bottom, "left": safe.left]]
    }
    private func sample() -> [String: Any]? {
        guard var value = viewport() else { return nil }
        if let last = lastSample, NSDictionary(dictionary: last).isEqual(to: value) {
            value["revision"] = revision
            return value
        }
        lastSample = value; revision += 1
        value["revision"] = revision
        notifyListeners("viewportChanged", data: value)
        return value
    }
    @objc func getViewport(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            if let value = self?.sample() { call.resolve(value) }
            else { call.reject("Window not ready") }
        }
    }
    @objc private func keyboardWillChange(_ notification: Notification) {
        guard bridge?.webView?.window != nil else { return }
        let duration = (notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.35
        finishAt = CACurrentMediaTime() + min(2, max(0.1, duration)) + 0.15
        if displayLink == nil {
            let link = CADisplayLink(target: self, selector: #selector(keyboardFrame))
            link.add(to: .main, forMode: .common)
            displayLink = link
        }
        _ = sample()
    }
    @objc private func keyboardDidChange() {
        finishAt = min(finishAt, CACurrentMediaTime() + 0.1)
        _ = sample()
    }
    @objc private func keyboardFrame() {
        _ = sample()
        if CACurrentMediaTime() >= finishAt { displayLink?.invalidate(); displayLink = nil; _ = sample() }
    }
    func layoutChanged() {
        guard !layoutSamplePending else { return }
        layoutSamplePending = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            // Window resizing may finish the keyboard guide's layout after the
            // controller callback. Read its settled frame, not an old layer.
            self.bridge?.webView?.layoutIfNeeded()
            self.layoutSamplePending = false
            _ = self.sample()
        }
    }

    @objc func setTheme(_ call: CAPPluginCall) {
        guard let theme = call.getString("theme"), ["dark", "light"].contains(theme) else {
            call.reject("Unknown appearance")
            return
        }
        DispatchQueue.main.async { [weak self] in
            UserDefaults.standard.set(theme, forKey: sceneThemeKey)
            applySceneBackground(theme, to: self?.bridge?.webView)
            call.resolve()
        }
    }
}

/// The scene is a fixed application canvas. Nested DOM scrollers own content
/// scrolling; WebKit's automatic focus pan must not move this root canvas.
private final class SceneWebView: WKWebView {
    private var offsetObservation: NSKeyValueObservation?
    private var restoringOffset = false

    override init(frame: CGRect, configuration: WKWebViewConfiguration) {
        super.init(frame: frame, configuration: configuration)
        scrollView.showsVerticalScrollIndicator = false
        scrollView.showsHorizontalScrollIndicator = false
        offsetObservation = scrollView.observe(\.contentOffset, options: [.new]) { [weak self] scroll, _ in
            guard let self, !self.restoringOffset, abs(scroll.zoomScale - 1) < 0.001,
                  scroll.contentOffset != .zero else { return }
            self.restoringOffset = true
            scroll.setContentOffset(.zero, animated: false)
            self.restoringOffset = false
        }
    }
    required init?(coder: NSCoder) { fatalError("Created by Capacitor") }
}

final class ViewController: CAPBridgeViewController {
    private let appearancePlugin = ASTariaAppearancePlugin()
    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        // Capacitor debug logging can include plugin arguments/results containing the key.
        descriptor.loggingBehavior = .none
        return descriptor
    }

    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        // Keep user-controlled magnification available even when the document
        // limits automatic focus zoom for small editable text.
        configuration.ignoresViewportScaleLimits = true
        return configuration
    }

    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        SceneWebView(frame: frame, configuration: configuration)
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        applySceneBackground(UserDefaults.standard.string(forKey: sceneThemeKey) ?? "dark", to: webView)
        bridge?.registerPluginInstance(ASTariaSecretsPlugin())
        bridge?.registerPluginInstance(appearancePlugin)
        if let webView { appearancePlugin.installKeyboardGuide(in: webView) }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        applySceneBackground(UserDefaults.standard.string(forKey: sceneThemeKey) ?? "dark", to: webView)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        appearancePlugin.layoutChanged()
    }
}
