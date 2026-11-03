import ActivityKit
import AppIntents
import Foundation
import Network
import RelevoProtocol

/// "Permitir" / "Denegar" on the Live Activity. As a `LiveActivityIntent` it runs in the app's process
/// (launched in the background if needed), which sends the answer to the Mac over a one-off connection.
struct ApprovalIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Responder a un permiso"
    static let isDiscoverable = false

    @Parameter(title: "Hilo") var threadId: String
    @Parameter(title: "Permiso") var itemId: String
    @Parameter(title: "Opción") var optionId: String

    init() {}

    init(threadId: UUID, itemId: String, optionId: String) {
        self.threadId = threadId.uuidString
        self.itemId = itemId
        self.optionId = optionId
    }

    func perform() async throws -> some IntentResult {
        guard let id = UUID(uuidString: threadId) else { return .result() }
        try await QuickCommand.send(.approve(threadId: id, itemId: itemId, optionId: optionId))
        // Show the answer right away; the Mac's next update confirms what the agent does next.
        for activity in Activity<RelevoActivityAttributes>.activities where activity.content.state.approval?.itemId == itemId {
            var state = activity.content.state
            state.phase = .working
            state.approval = nil
            state.statusLine = "Respuesta enviada al Mac"
            state.updatedAt = Date().timeIntervalSince1970
            await ActivityUpdater.update(id: activity.id, content: ActivityContent(state: state, staleDate: nil))
        }
        return .result()
    }
}

/// Connects to the paired Mac just long enough to deliver one command.
@MainActor
enum QuickCommand {
    enum Failure: LocalizedError {
        case unpaired, unreachable
        var errorDescription: String? {
            switch self {
            case .unpaired: "Este iPhone no está emparejado con ningún Mac"
            case .unreachable: "No llego al Mac. Abre Relevo para reconectar."
            }
        }
    }

    static func send(_ message: ClientMessage) async throws {
        guard let pairing = PairingStore.load() else { throw Failure.unpaired }
        var endpoints: [NWEndpoint] = [.service(name: pairing.serverId, type: CompanionTransport.serviceType, domain: "local.", interface: nil)]
        if let host = pairing.host {
            endpoints.append(.hostPort(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: pairing.port ?? CompanionTransport.defaultPort) ?? .any))
        }
        for endpoint in endpoints {
            if await OneShot(message: message, endpoint: endpoint, pairing: pairing).run() { return }
        }
        throw Failure.unreachable
    }
}

/// hello → wait for welcome → send the command → close. Gives up after a few seconds.
@MainActor
private final class OneShot {
    private let channel: MessageChannel
    private var result: Bool?

    init(message: ClientMessage, endpoint: NWEndpoint, pairing: PairingInfo) {
        let parameters = CompanionTransport.parameters(secret: pairing.secret, identity: pairing.serverId)
        channel = MessageChannel(connection: NWConnection(to: endpoint, using: parameters))
        channel.onStateChange = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready: self.channel.send(ClientMessage.hello(device: "Relevo · Live Activity", version: CompanionCoding.version))
            case .failed: self.result = false
            default: break
            }
        }
        channel.onMessage = { [weak self] data in
            guard let self, case .welcome? = try? CompanionCoding.decode(ServerMessage.self, from: data) else { return }
            self.channel.send(message)
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(500))   // let the message leave before closing
                self?.result = true
            }
        }
    }

    func run() async -> Bool {
        channel.start()
        let deadline = Date().addingTimeInterval(6)
        while result == nil, Date() < deadline { try? await Task.sleep(for: .milliseconds(100)) }
        channel.cancel()
        return result ?? false
    }
}
