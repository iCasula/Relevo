import Foundation

/// What the iPhone Live Activity shows: the thread that matters most right now and whether you're needed.
/// The Mac computes it and sends it both over the companion connection and as the `content-state` of
/// ActivityKit push notifications, so it is plain JSON (no `Date`: timestamps are Unix seconds).
public struct RelevoActivityState: Codable, Hashable, Sendable {
    public enum Phase: String, Codable, Sendable {
        /// A permission request is waiting for you.
        case needsYou
        /// The agent stopped at a usage limit (or its plan has no access).
        case limit
        case working
        /// A turn finished recently.
        case finished
        case idle
    }

    public struct Approval: Codable, Hashable, Sendable {
        public var itemId: String
        public var title: String
        public var detail: String?
        public var options: [RemoteOption]

        public init(itemId: String, title: String, detail: String?, options: [RemoteOption]) {
            self.itemId = itemId
            self.title = title
            self.detail = detail
            self.options = options
        }
    }

    public var phase: Phase
    public var threadId: UUID?
    public var threadTitle: String
    public var accountName: String?
    /// SF Symbol and sRGB hex of the provider.
    public var symbol: String?
    public var tint: String?
    public var model: String?
    public var statusLine: String?
    public var approval: Approval?
    /// Threads with an agent working / waiting for a permission.
    public var running: Int
    public var waiting: Int
    public var updatedAt: Double

    public init(phase: Phase, threadId: UUID?, threadTitle: String, accountName: String?, symbol: String?, tint: String?,
                model: String?, statusLine: String?, approval: Approval?, running: Int, waiting: Int, updatedAt: Double) {
        self.phase = phase
        self.threadId = threadId
        self.threadTitle = threadTitle
        self.accountName = accountName
        self.symbol = symbol
        self.tint = tint
        self.model = model
        self.statusLine = statusLine
        self.approval = approval
        self.running = running
        self.waiting = waiting
        self.updatedAt = updatedAt
    }

    public static let idle = RelevoActivityState(phase: .idle, threadId: nil, threadTitle: "", accountName: nil, symbol: nil, tint: nil,
                                                 model: nil, statusLine: nil, approval: nil, running: 0, waiting: 0, updatedAt: 0)

    /// Same content apart from the timestamp (used to avoid sending identical updates).
    public func sameContent(as other: RelevoActivityState) -> Bool {
        var a = self, b = other
        a.updatedAt = 0
        b.updatedAt = 0
        return a == b
    }
}

/// Push tokens of one iPhone for Live Activities, registered with the Mac.
public struct LiveActivityRegistration: Codable, Hashable, Sendable {
    public var deviceId: String
    public var deviceName: String
    /// Token of the running activity (updates and ends it).
    public var activityToken: String?
    /// Token that lets the Mac start an activity while the app isn't running (iOS 17.2+).
    public var pushToStartToken: String?
    /// "development" (installed from Xcode) or "production" (TestFlight / App Store).
    public var environment: String
    /// Bundle id of the companion app (the APNs topic is `<bundleId>.push-type.liveactivity`).
    public var bundleId: String?

    public init(deviceId: String, deviceName: String, activityToken: String?, pushToStartToken: String?, environment: String,
                bundleId: String?) {
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.activityToken = activityToken
        self.pushToStartToken = pushToStartToken
        self.environment = environment
        self.bundleId = bundleId
    }
}
