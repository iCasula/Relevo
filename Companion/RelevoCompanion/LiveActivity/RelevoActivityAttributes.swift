import ActivityKit
import Foundation
import RelevoProtocol

/// The Relevo Live Activity. Its name must match `attributes-type` in the Mac's push-to-start payload.
nonisolated struct RelevoActivityAttributes: ActivityAttributes {
    typealias ContentState = RelevoActivityState

    var macName: String
}

nonisolated enum DeepLink {
    /// `relevocompanion://thread/<uuid>` opens that conversation.
    static func thread(_ id: UUID?) -> URL? {
        guard let id else { return nil }
        return URL(string: "\(PairingInfo.scheme)://thread/\(id.uuidString)")
    }

    static func threadId(from url: URL) -> UUID? {
        guard url.scheme == PairingInfo.scheme, url.host == "thread" else { return nil }
        return UUID(uuidString: url.lastPathComponent)
    }
}

/// Updates/ends activities by id: `Activity` isn't Sendable, so it never crosses actors.
nonisolated enum ActivityUpdater {
    static func update(id: String, content: ActivityContent<RelevoActivityState>) async {
        guard let activity = Activity<RelevoActivityAttributes>.activities.first(where: { $0.id == id }) else { return }
        await activity.update(content)
    }

    static func end(id: String, content: ActivityContent<RelevoActivityState>?, dismissal: ActivityUIDismissalPolicy) async {
        guard let activity = Activity<RelevoActivityAttributes>.activities.first(where: { $0.id == id }) else { return }
        await activity.end(content, dismissalPolicy: dismissal)
    }
}
