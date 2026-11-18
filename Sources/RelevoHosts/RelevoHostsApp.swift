import AppKit
import ServiceManagement
import SwiftUI
import UserNotifications
import WebKit

/// Relevo Hosts: the cross-platform desktop app (Host/ui, served by `relevo-host desktop`) in a native Mac shell
/// that lives in the menu bar. The window can be closed: the page stays loaded, so the agents' questions,
/// permission requests and the orchestrator's messages still arrive, as system notifications.
@main
struct RelevoHostsApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @ObservedObject private var model = HostsModel.shared

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: model)
        } label: {
            MenuLabel(model: model)
        }
        .menuBarExtraStyle(.menu)
    }
}

// MARK: - Menu bar

struct MenuLabel: View {
    @ObservedObject var model: HostsModel
    var body: some View {
        let pending = model.waiting + model.attention
        HStack(spacing: 3) {
            Image(systemName: pending > 0 ? "person.3.sequence.fill" : "person.3.sequence")
            if pending > 0 { Text("\(pending)") }
        }
    }
}

struct MenuContent: View {
    @ObservedObject var model: HostsModel
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled

    var body: some View {
        Button("Abrir Relevo") { model.showWindow() }
            .keyboardShortcut("o")
        Divider()
        Text(model.summary)
        if model.waiting > 0 { Text("\(model.waiting) esperando tu respuesta") }
        if model.attention > 0 { Text("\(model.attention) mensaje\(model.attention == 1 ? "" : "s") del equipo para ti") }
        if !model.hosts.isEmpty {
            Divider()
            ForEach(model.hosts) { host in
                Text("\(host.state == "connected" ? "●" : "○") \(host.name)")
            }
        }
        if let problem = model.problem {
            Divider()
            Text(problem)
        }
        Divider()
        Toggle("Abrir al iniciar sesión", isOn: $launchAtLogin)
            .onChange(of: launchAtLogin) { _, on in
                do { if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } } catch {
                    launchAtLogin = SMAppService.mainApp.status == .enabled
                }
            }
        Button("Salir de Relevo Hosts") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}

// MARK: - Model

struct HostRow: Identifiable, Hashable {
    let id: String
    let name: String
    let state: String
}

@MainActor
final class HostsModel: NSObject, ObservableObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate, UNUserNotificationCenterDelegate {
    static let shared = HostsModel()

    @Published var working = 0
    @Published var waiting = 0
    @Published var attention = 0
    @Published var hosts: [HostRow] = []
    @Published var problem: String?

    var summary: String {
        if hosts.isEmpty { return problem == nil ? "Sin hosts conectados" : "No disponible" }
        return working == 0 ? "Ningún agente trabajando" : "\(working) agente\(working == 1 ? "" : "s") trabajando"
    }

    private var window: NSWindow?
    private var webView: WKWebView?
    private var backend: Process?
    private let port = Int(ProcessInfo.processInfo.environment["RELEVO_DESKTOP_PORT"] ?? "") ?? 47822
    private let dataDir = (ProcessInfo.processInfo.environment["RELEVO_DESKTOP_DATA"] as NSString?)?.expandingTildeInPath
        ?? NSHomeDirectory() + "/.relevo-desktop"

    // MARK: Start

    func start() {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        Task {
            if !(await isServing()) { launchBackend() }
            for _ in 0..<60 where !(await isServing()) { try? await Task.sleep(for: .milliseconds(250)) }
            guard await isServing() else {
                problem = "No arranca la parte de fondo (mira ~/.relevo-desktop/logs/desktop.log)"
                showWindow()
                return
            }
            loadPage()
            // First run: show the window so it can be paired with a host.
            if !UserDefaults.standard.bool(forKey: "opened") { UserDefaults.standard.set(true, forKey: "opened"); showWindow() }
        }
    }

    private func isServing() async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.5
        return (try? await URLSession.shared.data(for: request)) != nil
    }

    /// `node relevo-host.mjs desktop --serve`, as installed by Host/deploy/install-mac-desktop.sh.
    private func launchBackend() {
        let support = NSHomeDirectory() + "/Library/Application Support/Relevo Desktop"
        var node = "/usr/local/bin/node", script = support + "/app/relevo-host.mjs"
        if let data = FileManager.default.contents(atPath: support + "/launcher.json"),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
            node = json["node"] ?? node
            script = json["script"] ?? script
        }
        guard FileManager.default.isExecutableFile(atPath: node), FileManager.default.fileExists(atPath: script) else {
            problem = "Falta Node o el programa: vuelve a ejecutar Host/deploy/install-mac-desktop.sh"
            return
        }
        try? FileManager.default.createDirectory(atPath: dataDir + "/logs", withIntermediateDirectories: true)
        let logPath = dataDir + "/logs/desktop.log"
        if !FileManager.default.fileExists(atPath: logPath) { FileManager.default.createFile(atPath: logPath, contents: nil) }
        let log = FileHandle(forWritingAtPath: logPath)
        log?.seekToEndOfFile()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [script, "desktop", "--serve"]
        p.standardOutput = log
        p.standardError = log
        do { try p.run(); backend = p } catch { problem = "No he podido arrancar Node: \(error.localizedDescription)" }
    }

    func stop() {
        backend?.terminate()
    }

    // MARK: Window

    private func makeWindow() {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "relevo")
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = false
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable],
                         backing: .buffered, defer: false)
        // A real title bar: the page never sits under the window buttons, and the window moves, resizes,
        // zooms (double-click or the green button) and goes full screen like any other.
        w.title = "Relevo Hosts"
        w.titleVisibility = .visible
        w.collectionBehavior.insert(.fullScreenPrimary)
        w.isReleasedWhenClosed = false
        w.minSize = NSSize(width: 820, height: 520)
        w.contentView = web
        w.center()
        w.setFrameAutosaveName("RelevoHostsWindow")
        w.delegate = self
        window = w
        webView = web
    }

    private func loadPage() {
        if webView == nil { makeWindow() }
        // The token in the link sets the page's cookie (the server only answers this machine).
        let token = (try? String(contentsOfFile: dataDir + "/desktop/ui-token", encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if let url = URL(string: "http://127.0.0.1:\(port)/?t=\(token)") { webView?.load(URLRequest(url: url)) }
    }

    func showWindow() {
        if window == nil { makeWindow(); loadPage() }
        NSApp.setActivationPolicy(.regular)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    /// Closing only hides it: the page keeps running for the notifications.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        NSApp.setActivationPolicy(.accessory)
        return false
    }

    // MARK: Page ↔ app

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        let hosts = (body["hosts"] as? [[String: Any]] ?? []).map {
            HostRow(id: $0["id"] as? String ?? UUID().uuidString, name: $0["name"] as? String ?? "Host", state: $0["state"] as? String ?? "")
        }
        let working = body["working"] as? Int ?? 0, waiting = body["waiting"] as? Int ?? 0, attention = body["attention"] as? Int ?? 0
        let title = body["title"] as? String ?? "Relevo", text = body["body"] as? String ?? ""
        let hostId = body["hostId"] as? String ?? "", threadId = body["threadId"] as? String ?? ""
        switch type {
        case "status":
            self.working = working
            self.waiting = waiting
            self.attention = attention
            self.hosts = hosts
            self.problem = nil
            NSApp.dockTile.badgeLabel = waiting + attention > 0 ? "\(waiting + attention)" : nil
        case "notify":
            notify(title: title, body: text, hostId: hostId, threadId: threadId)
        default:
            break
        }
    }

    private func notify(title: String, body: String, hostId: String, threadId: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.userInfo = ["hostId": hostId, "threadId": threadId]
        content.threadIdentifier = "\(hostId)/\(threadId)"
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let hostId = info["hostId"] as? String ?? "", threadId = info["threadId"] as? String ?? ""
        Task { @MainActor in
            self.showWindow()
            let js = "window.relevoOpen && window.relevoOpen(\(Self.jsString(hostId)), \(Self.jsString(threadId)))"
            _ = try? await self.webView?.evaluateJavaScript(js)
        }
        completionHandler()
    }

    private static func jsString(_ s: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [s])
        return String(data: data ?? Data(), encoding: .utf8).map { String($0.dropFirst().dropLast()) } ?? "\"\""
    }

    // Links (PRs, docs, sign-in pages) open in the browser, not inside the app.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        let local = url?.host == "127.0.0.1" || url?.host == "localhost" || url?.scheme == "about" || url?.scheme == "data" || url?.scheme == "blob"
        if !local, let url, navigationAction.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    /// The page reloads itself after an update; if the background part restarted, load it again.
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Task { try? await Task.sleep(for: .seconds(2)); self.loadPage() }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        Task { try? await Task.sleep(for: .seconds(2)); self.loadPage() }
    }

    // JavaScript alerts (the page uses its own sheets, but just in case).
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }
}

// MARK: - App delegate

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        NSApp.mainMenu = Self.mainMenu()
        MainActor.assumeIsolated { HostsModel.shared.start() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated { HostsModel.shared.stop() }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        MainActor.assumeIsolated { HostsModel.shared.showWindow() }
        return true
    }

    /// Without a main menu ⌘C/⌘V/⌘A don't reach the web view.
    private static func mainMenu() -> NSMenu {
        let menu = NSMenu()
        let app = NSMenuItem()
        app.submenu = NSMenu(title: "Relevo Hosts")
        app.submenu?.addItem(withTitle: "Ocultar Relevo Hosts", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.submenu?.addItem(.separator())
        app.submenu?.addItem(withTitle: "Salir de Relevo Hosts", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(app)
        let edit = NSMenuItem()
        edit.submenu = NSMenu(title: "Edición")
        edit.submenu?.addItem(withTitle: "Deshacer", action: Selector(("undo:")), keyEquivalent: "z")
        edit.submenu?.addItem(withTitle: "Rehacer", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.submenu?.addItem(.separator())
        edit.submenu?.addItem(withTitle: "Cortar", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.submenu?.addItem(withTitle: "Copiar", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.submenu?.addItem(withTitle: "Pegar", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.submenu?.addItem(withTitle: "Seleccionar todo", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        menu.addItem(edit)
        let window = NSMenuItem()
        window.submenu = NSMenu(title: "Ventana")
        window.submenu?.addItem(withTitle: "Cerrar", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        window.submenu?.addItem(withTitle: "Minimizar", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        menu.addItem(window)
        return menu
    }
}
