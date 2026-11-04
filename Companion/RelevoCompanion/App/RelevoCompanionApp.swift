import SwiftUI
import RelevoProtocol

@main
struct RelevoCompanionApp: App {
    @State private var client: CompanionClient
    @State private var router = AppRouter()

    init() {
        #if DEBUG
        // Simulator testing: launch with `-pairURL relevocompanion://pair?...` (same as opening the link).
        if let raw = UserDefaults.standard.string(forKey: "pairURL"), let url = URL(string: raw), let info = PairingInfo(url: url) {
            PairingStore.save(info)
        }
        #endif
        _client = State(initialValue: CompanionClient())
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(client)
                .environment(router)
                // The Mac's QR code opens `relevocompanion://pair?...`; the Live Activity, `relevocompanion://thread/<id>`.
                .onOpenURL { url in
                    if let info = PairingInfo(url: url) {
                        client.pair(with: info)
                    } else if let thread = DeepLink.threadId(from: url) {
                        router.open(thread: thread)
                    }
                }
                #if DEBUG
                .task {
                    DemoActivity.startIfRequested(client.liveActivities)
                    // Simulator testing: `-openThread <id>` opens that thread, like the Live Activity's link.
                    if let raw = UserDefaults.standard.string(forKey: "openThread"), let id = UUID(uuidString: raw) { router.open(thread: id) }
                }
                #endif
        }
    }
}

#if DEBUG
/// Simulator testing: `-demoActivity needsYou|working|limit|finished` starts a sample Live Activity.
enum DemoActivity {
    static func startIfRequested(_ controller: LiveActivityController) {
        guard let raw = UserDefaults.standard.string(forKey: "demoActivity"),
              let phase = RelevoActivityState.Phase(rawValue: raw) else { return }
        controller.apply(sample(phase), macName: "MacBook Pro")
    }

    static func sample(_ phase: RelevoActivityState.Phase) -> RelevoActivityState {
        let approval = phase == .needsYou ? RelevoActivityState.Approval(
            itemId: "a:demo", title: "Bash: npm test -- --runInBand", detail: "Ejecutar los tests del proyecto",
            options: [RemoteOption(id: "allow", label: "Permitir", isAllow: true), RemoteOption(id: "deny", label: "Denegar", isAllow: false)]) : nil
        let status: String? = switch phase {
        case .working: "Editando Sources/App/Login.swift"
        case .limit: "Límite alcanzado · se reinicia a las 21:00 · relévalo a otro agente"
        case .finished: "Listo: los tests pasan y el login usa ya el nuevo endpoint."
        default: "Esperando tu aprobación"
        }
        return RelevoActivityState(phase: phase, threadId: UUID(), threadTitle: "Migrar login a async/await", accountName: "Claude personal",
                                   symbol: "asterisk", tint: "#D97757", model: "Opus 5.5", statusLine: status, approval: approval,
                                   running: phase == .finished ? 0 : 2, waiting: phase == .needsYou ? 1 : 0,
                                   updatedAt: Date().timeIntervalSince1970 - 40)
    }
}
#endif
