import Foundation

/// iPhone → Mac.
public enum ClientMessage: Codable, Sendable {
    case hello(device: String, version: Int)
    /// The thread the companion is looking at (nil = none). The Mac then streams its transcript.
    case subscribe(threadId: UUID?)
    /// Sent while the agent works, it is queued on the Mac and goes out when the turn ends.
    case send(threadId: UUID, text: String)
    case dequeue(threadId: UUID, messageId: UUID)
    /// Interrupt the agent and send this now, in the same conversation (to redirect it).
    case sendNow(threadId: UUID, text: String)
    case sendQueuedNow(threadId: UUID, messageId: UUID)
    case resumeQueue(threadId: UUID)
    case stop(threadId: UUID)
    case approve(threadId: UUID, itemId: String, optionId: String)
    /// Answers to the agent's questions (question → chosen option(s) or free text).
    case answer(threadId: UUID, itemId: String, answers: [String: String])
    case select(threadId: UUID, accountId: UUID, model: String)
    case setEffort(threadId: UUID, effort: String?)
    case setMode(threadId: UUID, mode: RemoteMode)
    /// Lets the Mac classify the request being typed («Relevo suggests»).
    case setDraft(threadId: UUID, text: String)
    case suggestion(threadId: UUID, action: SuggestionAction)
    case relay(threadId: UUID, accountId: UUID, model: String)
    case newThread(projectId: UUID, requestId: UUID)
    case refreshUsage
    /// Live Activity push tokens of this iPhone, so the Mac can update it through APNs.
    case registerLiveActivity(LiveActivityRegistration)
    /// An image the thread mentions, downscaled to `maxPixel` (the Mac only serves files named in that thread).
    case fetchImage(requestId: UUID, threadId: UUID, path: String, maxPixel: Int)
    /// Show a path the thread mentions on the Mac (Quick Look for files, Finder for folders).
    case openOnMac(threadId: UUID, path: String)
}

public enum SuggestionAction: String, Codable, Sendable {
    /// Use the suggested subscription/model/effort.
    case accept
    /// Hide it until the next message.
    case dismiss
    /// Revert a suggestion that was applied automatically.
    case undo
}

/// Mac → iPhone.
public enum ServerMessage: Codable, Sendable {
    case welcome(name: String, version: Int)
    case snapshot(RemoteSnapshot)
    case thread(RemoteThread)
    case threadPatch(RemoteThreadPatch)
    case created(requestId: UUID, threadId: UUID)
    case toast(String)
    /// State for the Live Activity (sent whenever it changes).
    case activity(RelevoActivityState)
    /// Answer to `fetchImage`: JPEG data, or why it isn't available.
    case image(requestId: UUID, data: Data?, error: String?)
}

public enum CompanionCoding {
    public static let version = 1

    public static func encode<T: Encodable>(_ value: T) throws -> Data {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .secondsSince1970
        return try e.encode(value)
    }

    public static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .secondsSince1970
        return try d.decode(type, from: data)
    }
}
