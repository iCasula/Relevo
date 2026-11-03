import SwiftUI
import AppKit

@main
struct RelevoApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var store: AppStore

    init() {
        SelfTest.runIfRequested()
        _store = State(initialValue: AppStore.shared)
    }

    var body: some Scene {
        WindowGroup("Relevo", id: "main") {
            MainView()
                .environment(store)
                .frame(minWidth: 960, minHeight: 620)
        }
        .windowToolbarStyle(.unified(showsTitle: true))
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Nuevo hilo") { store.newThread() }
                    .keyboardShortcut("n")
                Button("Añadir proyecto…") { store.showNewProject = true }
                    .keyboardShortcut("o")
            }
            CommandMenu("Agentes") {
                Button("Actualizar límites") { store.refreshAllUsage() }
                    .keyboardShortcut("r", modifiers: [.command, .shift])
                Divider()
                Button("Detener agente") {
                    if let t = store.selectedThread { store.runtime(for: t).stop() }
                }
                .keyboardShortcut(".", modifiers: .command)
            }
        }

        Settings {
            SettingsView()
                .environment(store)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        signal(SIGPIPE, SIG_IGN)
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        DebugSnapshot.scheduleIfRequested()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated { AppStore.shared.shutdown() }
    }
}

/// Debug aid: `RELEVO_SNAPSHOT=/path/prefix` saves PNGs of the app's own windows
/// (after RELEVO_SNAPSHOT_DELAY seconds, and again on the `app.relevo.snapshot` distributed notification).
enum DebugSnapshot {
    static var counter = 0

    static func scheduleIfRequested() {
        let env = ProcessInfo.processInfo.environment
        guard let prefix = env["RELEVO_SNAPSHOT"], !prefix.isEmpty else { return }
        let delay = Double(env["RELEVO_SNAPSHOT_DELAY"] ?? "") ?? 5
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { capture(prefix) }
        DistributedNotificationCenter.default().addObserver(forName: Notification.Name("app.relevo.snapshot"), object: nil, queue: .main) { note in
            if let action = note.object as? String { perform(action) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { capture(prefix) }
        }
    }

    static func perform(_ action: String) {
        MainActor.assumeIsolated {
            let store = AppStore.shared
            let parts = action.split(separator: ":", maxSplits: 1).map(String.init)
            switch parts.first {
            case "select" where parts.count == 2:
                if let t = store.threads.first(where: { $0.title.hasPrefix(parts[1]) }) { store.select(t.id) }
            case "new": store.newThread()
            case "limit":
                if let t = store.selectedThread, let acc = store.accounts.first {
                    store.runtime(for: t).limit = LimitNotice(accountId: acc.id, message: "demo", resetsAt: Date().addingTimeInterval(5400))
                }
            case "draft" where parts.count == 2:
                store.selectedThread?.draft = parts[1]
            case "toggle" where parts.count == 2:   // toggle:<n> opens/closes the n-th tool row
                if let t = store.selectedThread, let n = Int(parts[1]), n >= 1 {
                    let tools = t.items.filter { $0.kind == .tool }
                    if n <= tools.count { store.runtime(for: t).toggleExpanded(tools[n - 1].id) }
                }
            case "accept":
                if let t = store.selectedThread { store.runtime(for: t).suggester.accept() }
            case "trace":
                store.debugRequest = "trace"
            case "settings":
                store.debugRequest = "settings"
            default: break
            }
        }
    }

    static func capture(_ prefix: String) {
        for window in NSApp.windows where window.isVisible {
            guard let view = window.contentView?.superview ?? window.contentView else { continue }
            let bounds = view.bounds
            guard let rep = view.bitmapImageRepForCachingDisplay(in: bounds) else { continue }
            view.cacheDisplay(in: bounds, to: rep)
            counter += 1
            let url = URL(fileURLWithPath: "\(prefix)-\(counter).png")
            try? rep.representation(using: .png, properties: [:])?.write(to: url)
        }
    }
}
