import AppKit
import ScreenCaptureKit
import ApplicationServices
import Carbon.HIToolbox
import ImageIO
import UniformTypeIdentifiers

/// Captures the window you're looking at (the simulator, a browser, a design…) and attaches it to the message
/// you're writing: the image, plus — when allowed — its text and controls with their positions, read through
/// Accessibility, so the agent knows what each part of the screenshot is. Off by default (Ajustes › Integraciones).
@MainActor
enum WindowCapture {
    struct Capture {
        var image: URL
        var text: URL?
        var app: String
        var title: String
    }

    static var folder: URL { AppStore.supportDirectory.appendingPathComponent("captures", isDirectory: true) }
    static let shortcutLabel = "⌃⌥⌘C"

    struct Target {
        var id: CGWindowID
        var pid: pid_t
        var app: String
        var title: String
        var bounds: CGRect
    }

    /// The frontmost normal window that isn't Relevo's (from front to back).
    static func target() -> Target? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        let me = ProcessInfo.processInfo.processIdentifier
        for w in list {
            guard (w[kCGWindowLayer as String] as? Int) == 0,
                  let pid = w[kCGWindowOwnerPID as String] as? pid_t, pid != me,
                  let id = w[kCGWindowNumber as String] as? CGWindowID,
                  let b = w[kCGWindowBounds as String] as? [String: Any] else { continue }
            let rect = CGRect(x: b["X"] as? CGFloat ?? 0, y: b["Y"] as? CGFloat ?? 0,
                              width: b["Width"] as? CGFloat ?? 0, height: b["Height"] as? CGFloat ?? 0)
            guard rect.width > 80, rect.height > 60 else { continue }
            return Target(id: id, pid: pid, app: w[kCGWindowOwnerName as String] as? String ?? "App",
                          title: w[kCGWindowName as String] as? String ?? "", bounds: rect)
        }
        return nil
    }

    static func capture(includeText: Bool) async throws -> Capture {
        guard CGPreflightScreenCaptureAccess() else {
            CGRequestScreenCaptureAccess()
            throw GitError(message: "Relevo necesita permiso de Grabación de pantalla (Ajustes del Sistema › Privacidad y seguridad). Dáselo y vuelve a capturar.")
        }
        guard let target = target() else { throw GitError(message: "No hay ninguna ventana que capturar.") }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let window = content.windows.first(where: { $0.windowID == target.id }) else {
            throw GitError(message: "No se pudo acceder a la ventana de \(target.app).")
        }
        let config = SCStreamConfiguration()
        let scale = NSScreen.screens.first { $0.frame.intersects(target.bounds) }?.backingScaleFactor ?? 2
        config.width = Int(window.frame.width * scale)
        config.height = Int(window.frame.height * scale)
        config.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config)

        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let app = target.app.replacingOccurrences(of: #"[^A-Za-z0-9]+"#, with: "-", options: .regularExpression)
        let base = "\(formatter.string(from: Date()))-\(app)"
        let imageURL = folder.appendingPathComponent(base + ".png")
        guard let dest = CGImageDestinationCreateWithURL(imageURL as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw GitError(message: "No se pudo guardar la captura.")
        }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else { throw GitError(message: "No se pudo guardar la captura.") }

        var textURL: URL?
        if includeText {
            if AXIsProcessTrusted() {
                if let text = accessibilityText(target, scale: scale) {
                    let url = folder.appendingPathComponent(base + ".txt")
                    try? text.write(to: url, atomically: true, encoding: .utf8)
                    textURL = url
                }
            } else {
                // Asks once; until granted, captures carry only the image.
                let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
                _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
            }
        }
        return Capture(image: imageURL, text: textURL, app: target.app, title: target.title)
    }

    /// Captures and adds the reference to the selected thread's draft (a new thread if none is open).
    static func captureIntoDraft(store: AppStore) {
        Task {
            do {
                let c = try await capture(includeText: store.settings.captureIncludeText)
                guard let thread = store.selectedThread ?? store.newThread() else { return }
                var line = "[Captura de «\(c.app)\(c.title.isEmpty ? "" : " — \(c.title)")»: \(c.image.path)"
                if let text = c.text { line += " · texto y controles de la ventana: \(text.path)" }
                line += "]"
                thread.draft = thread.draft.isEmpty ? line + "\n" : thread.draft.trimmingCharacters(in: .newlines) + "\n" + line + "\n"
                store.save(thread)
                NSApp.activate(ignoringOtherApps: true)
                store.flash("Captura de \(c.app) añadida al mensaje" + (c.text == nil && store.settings.captureIncludeText ? " (sin texto: falta el permiso de Accesibilidad)" : ""))
            } catch {
                store.flash(error.localizedDescription)
            }
        }
    }

    // MARK: - Accessibility text

    private static let roles: [String: String] = [
        "AXButton": "Botón", "AXStaticText": "Texto", "AXTextField": "Campo", "AXTextArea": "Área de texto",
        "AXCheckBox": "Casilla", "AXRadioButton": "Opción", "AXPopUpButton": "Desplegable", "AXMenuButton": "Menú",
        "AXLink": "Enlace", "AXImage": "Imagen", "AXCell": "Celda", "AXTab": "Pestaña", "AXSlider": "Deslizador",
        "AXSwitch": "Interruptor", "AXHeading": "Título", "AXComboBox": "Combo", "AXSearchField": "Búsqueda",
    ]

    /// Text and controls of the window with their frames, in points from its top-left corner.
    static func accessibilityText(_ target: Target, scale: CGFloat) -> String? {
        let app = AXUIElementCreateApplication(target.pid)
        AXUIElementSetMessagingTimeout(app, 0.4)
        var root: AXUIElement?
        var windows: CFTypeRef?
        if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windows) == .success, let list = windows as? [AXUIElement] {
            root = list.first { string($0, kAXTitleAttribute) == target.title } ?? list.first
        }
        guard let root else { return nil }
        var lines: [String] = []
        var queue: [(AXUIElement, Int)] = [(root, 0)]
        var visited = 0
        let deadline = Date().addingTimeInterval(2.5)
        while !queue.isEmpty, visited < 2000, lines.count < 500, Date() < deadline {
            let (element, depth) = queue.removeFirst()
            visited += 1
            if let role = string(element, kAXRoleAttribute), let name = roles[role] {
                let label = [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute, kAXHelpAttribute]
                    .lazy.compactMap { string(element, $0) }.first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
                if let label, let frame = frame(element) {
                    let x = Int(frame.minX - target.bounds.minX), y = Int(frame.minY - target.bounds.minY)
                    let text = label.replacingOccurrences(of: "\n", with: " ").prefix(200)
                    lines.append("\(name) «\(text)» — x \(x), y \(y), \(Int(frame.width))×\(Int(frame.height))")
                }
            }
            if depth < 30, let kids = children(element) { queue += kids.map { ($0, depth + 1) } }
        }
        guard !lines.isEmpty else { return nil }
        let header = "Ventana «\(target.title)» de \(target.app), \(Int(target.bounds.width))×\(Int(target.bounds.height)) puntos. "
            + "Coordenadas en puntos desde su esquina superior izquierda; la imagen está a \(Int(scale))× (multiplica por \(Int(scale)) para ir a píxeles).\n\n"
        return header + lines.joined(separator: "\n")
    }

    private static func string(_ e: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, attribute as CFString, &value) == .success else { return nil }
        if let s = value as? String { return s }
        if let n = value as? NSNumber { return n.stringValue }
        return nil
    }

    private static func children(_ e: AXUIElement) -> [AXUIElement]? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &value) == .success else { return nil }
        return value as? [AXUIElement]
    }

    private static func frame(_ e: AXUIElement) -> CGRect? {
        var pos: CFTypeRef?, size: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, kAXPositionAttribute as CFString, &pos) == .success,
              AXUIElementCopyAttributeValue(e, kAXSizeAttribute as CFString, &size) == .success,
              let pos, let size, CFGetTypeID(pos) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, dims = CGSize.zero
        AXValueGetValue(pos as! AXValue, .cgPoint, &point)
        AXValueGetValue(size as! AXValue, .cgSize, &dims)
        return CGRect(origin: point, size: dims)
    }
}

/// System-wide shortcut (Carbon hot key: no Accessibility permission needed) for the window capture.
@MainActor
final class GlobalHotKey {
    static let shared = GlobalHotKey()
    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?
    var action: (() -> Void)?

    /// ⌃⌥⌘C by default.
    func register(keyCode: UInt32 = UInt32(kVK_ANSI_C), modifiers: UInt32 = UInt32(cmdKey | optionKey | controlKey)) {
        unregister()
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { GlobalHotKey.shared.action?() } }
            return noErr
        }, 1, &spec, nil, &handler)
        let id = EventHotKeyID(signature: OSType(0x524C_564F), id: 1)   // "RLVO"
        RegisterEventHotKey(keyCode, modifiers, id, GetApplicationEventTarget(), 0, &ref)
    }

    func unregister() {
        if let ref { UnregisterEventHotKey(ref) }
        if let handler { RemoveEventHandler(handler) }
        ref = nil
        handler = nil
    }
}
