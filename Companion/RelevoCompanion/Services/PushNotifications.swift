import UIKit
import UserNotifications

/// Ordinary push notifications: the host sends them through APNs when an agent needs you (a question, a
/// permission, a command the guard held) and the app isn't open. Tapping one opens that thread.
@MainActor
final class PushNotifications: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushNotifications()

    /// This device's APNs token, as hex (sent to each host with the Live Activity registration).
    private(set) var token: String? = UserDefaults.standard.string(forKey: "apnsAlertToken")
    /// Called when the token arrives or changes, to tell the connected host.
    var onToken: (() -> Void)?
    /// A notification was tapped: the host (serverId) and the thread to open.
    var onOpen: ((String?, UUID) -> Void)?

    /// Asks once for permission and registers with APNs (each launch: the token can change).
    func start() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            Task { @MainActor in UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func didRegister(_ deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        guard hex != token else { return }
        token = hex
        UserDefaults.standard.set(hex, forKey: "apnsAlertToken")
        onToken?()
    }

    // Shown while the app is open too (it may come from another host than the one on screen).
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let raw = info["threadId"] as? String, let id = UUID(uuidString: raw) else { return }
        let server = info["serverId"] as? String
        await MainActor.run { self.onOpen?(server, id) }
    }
}

/// Receives the APNs token (SwiftUI apps get it through an app delegate).
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in PushNotifications.shared.didRegister(deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {}
}
