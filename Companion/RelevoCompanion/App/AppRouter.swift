import Foundation
import Observation

enum AppTab: String {
    case threads, limits, settings
}

/// App-wide navigation that deep links (Live Activity, pairing link) can drive.
@Observable
final class AppRouter {
    var tab: AppTab = .threads
    /// Thread to open next in the Threads tab.
    var threadToOpen: UUID?

    init() {
        #if DEBUG
        // Simulator screenshots: `-tab limits`, `-openThread <uuid>`.
        if let raw = UserDefaults.standard.string(forKey: "tab"), let tab = AppTab(rawValue: raw) { self.tab = tab }
        threadToOpen = UserDefaults.standard.string(forKey: "openThread").flatMap(UUID.init)
        #endif
    }

    func open(thread id: UUID) {
        tab = .threads
        threadToOpen = id
    }
}
