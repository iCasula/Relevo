import ActivityKit
import Foundation
import Observation
import UIKit
import RelevoProtocol

/// Owns the Relevo Live Activity on this iPhone: starts it when an agent is working or needs you,
/// applies the Mac's state while the app is open, and hands the push tokens to the Mac so it can keep
/// the activity current (or start it) through APNs while the app is closed.
@Observable
final class LiveActivityController {
    var isEnabled: Bool {
        didSet {
            UserDefaults.standard.set(isEnabled, forKey: Self.enabledKey)
            if !isEnabled { endAll() }
        }
    }
    private(set) var hasActivity = false

    /// Called with the current tokens whenever they change (the client forwards them to the Mac).
    @ObservationIgnored var onRegistration: ((LiveActivityRegistration) -> Void)?
    @ObservationIgnored private var activity: Activity<RelevoActivityAttributes>?
    @ObservationIgnored private var activityToken: String?
    @ObservationIgnored private var pushToStartToken: String?
    @ObservationIgnored private var lastState: RelevoActivityState?
    @ObservationIgnored let deviceId: String

    private static let enabledKey = "liveActivitiesEnabled"
    private static let deviceKey = "companionDeviceId"

    init() {
        isEnabled = UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool ?? true
        if let id = UserDefaults.standard.string(forKey: Self.deviceKey) {
            deviceId = id
        } else {
            deviceId = UUID().uuidString
            UserDefaults.standard.set(deviceId, forKey: Self.deviceKey)
        }
        if let existing = Activity<RelevoActivityAttributes>.activities.first { adopt(existing) }
        watchSystemActivities()
    }

    var systemAllowsActivities: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    /// Development builds (Xcode) get sandbox push tokens; TestFlight / App Store ones, production.
    static var environment: String {
        #if DEBUG
        "development"
        #else
        "production"
        #endif
    }

    var registration: LiveActivityRegistration {
        LiveActivityRegistration(deviceId: deviceId, deviceName: UIDevice.current.name,
                                 activityToken: isEnabled ? activityToken : nil,
                                 pushToStartToken: isEnabled ? pushToStartToken : nil,
                                 environment: Self.environment, bundleId: Bundle.main.bundleIdentifier)
    }

    // MARK: - State from the Mac

    func apply(_ state: RelevoActivityState, macName: String) {
        guard isEnabled, systemAllowsActivities else { return }
        defer { lastState = state }
        let content = ActivityContent(state: state,
                                      staleDate: state.phase == .working ? Date().addingTimeInterval(30 * 60) : nil,
                                      relevanceScore: state.phase == .needsYou ? 100 : 50)
        if let id = activity?.id {
            if state.phase == .idle {
                let final = ActivityContent(state: lastState ?? state, staleDate: nil)
                Task { await ActivityUpdater.end(id: id, content: final, dismissal: .after(Date().addingTimeInterval(10 * 60))) }
                detach()
            } else if lastState.map({ !$0.sameContent(as: state) }) ?? true {
                Task { await ActivityUpdater.update(id: id, content: content) }
            }
        } else if [.needsYou, .working, .limit].contains(state.phase) {
            do {
                let new = try Activity.request(attributes: RelevoActivityAttributes(macName: macName), content: content, pushType: .token)
                adopt(new)
            } catch {
                // Not allowed right now (e.g. Live Activities off in Settings): nothing to show.
            }
        }
    }

    /// Leaving the app: without APNs nothing can update the activity any more, so it is marked
    /// "possibly outdated" soon instead of claiming an agent is still working.
    func appDidLeaveForeground(pushReady: Bool) {
        guard !pushReady, let id = activity?.id, let state = lastState, state.phase != .idle else { return }
        let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(120),
                                      relevanceScore: state.phase == .needsYou ? 100 : 50)
        Task { await ActivityUpdater.update(id: id, content: content) }
    }

    /// Back in the app: the next state from the Mac rewrites the activity (and its stale date) even if unchanged.
    func appDidEnterForeground() {
        lastState = nil
    }

    func endAll() {
        for id in Activity<RelevoActivityAttributes>.activities.map(\.id) {
            Task { await ActivityUpdater.end(id: id, content: nil, dismissal: .immediate) }
        }
        detach()
    }

    // MARK: - Tokens

    private func adopt(_ new: Activity<RelevoActivityAttributes>) {
        activity = new
        hasActivity = true
        Task { [weak self] in
            for await data in new.pushTokenUpdates {
                self?.activityToken = data.hexString
                self?.publish()
            }
        }
        Task { [weak self] in
            for await state in new.activityStateUpdates where state == .ended || state == .dismissed {
                guard let self, self.activity?.id == new.id else { return }
                self.detach()
            }
        }
    }

    private func detach() {
        activity = nil
        activityToken = nil
        hasActivity = false
        publish()
    }

    private func watchSystemActivities() {
        // Push-to-start: lets the Mac start the activity while the app isn't running.
        Task { [weak self] in
            for await data in Activity<RelevoActivityAttributes>.pushToStartTokenUpdates {
                self?.pushToStartToken = data.hexString
                self?.publish()
            }
        }
        // Activities started by push show up here; take them over so updates keep flowing.
        Task { [weak self] in
            for await started in Activity<RelevoActivityAttributes>.activityUpdates {
                guard let self, self.activity?.id != started.id else { continue }
                self.adopt(started)
            }
        }
    }

    private func publish() { onRegistration?(registration) }
}

private extension Data {
    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}
