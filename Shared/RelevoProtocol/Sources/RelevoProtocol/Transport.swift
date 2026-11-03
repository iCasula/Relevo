import Foundation
import Network
import CryptoKit

/// Network setup shared by both ends: Bonjour discovery, TLS with a pre-shared key derived from the pairing
/// secret (only a paired device can complete the handshake, and all traffic is encrypted), and WebSocket
/// framing for JSON messages.
public enum CompanionTransport {
    public static let serviceType = "_relevo._tcp"
    public static let defaultPort: UInt16 = 47820

    public static func parameters(secret: Data, identity: String) -> NWParameters {
        let tls = NWProtocolTLS.Options()
        let key = SymmetricKey(data: secret)
        let psk = Data(HMAC<SHA256>.authenticationCode(for: Data("relevo-companion-v1".utf8), using: key))
        let sec = tls.securityProtocolOptions
        sec_protocol_options_add_pre_shared_key(sec, dispatchData(psk) as __DispatchData, dispatchData(Data(identity.utf8)) as __DispatchData)
        sec_protocol_options_append_tls_ciphersuite(sec, tls_ciphersuite_t(rawValue: UInt16(TLS_PSK_WITH_AES_128_GCM_SHA256))!)
        // Network.framework offers PSK cipher suites on TLS 1.2.
        sec_protocol_options_set_min_tls_protocol_version(sec, .TLSv12)
        sec_protocol_options_set_max_tls_protocol_version(sec, .TLSv12)

        let tcp = NWProtocolTCP.Options()
        tcp.enableKeepalive = true
        tcp.keepaliveIdle = 5
        tcp.connectionTimeout = 8

        let parameters = NWParameters(tls: tls, tcp: tcp)
        parameters.includePeerToPeer = true
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        ws.maximumMessageSize = 32 << 20
        parameters.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        return parameters
    }

    private static func dispatchData(_ data: Data) -> DispatchData {
        data.withUnsafeBytes { DispatchData(bytes: $0) }
    }
}

/// One encrypted WebSocket connection carrying JSON messages, delivered on the main actor.
@MainActor
public final class MessageChannel {
    public let connection: NWConnection
    public var onMessage: ((Data) -> Void)?
    public var onStateChange: ((NWConnection.State) -> Void)?
    private var cancelled = false

    public init(connection: NWConnection) {
        self.connection = connection
    }

    public func start() {
        connection.stateUpdateHandler = { [weak self] state in
            MainActor.assumeIsolated { self?.onStateChange?(state) }
        }
        connection.start(queue: .main)
        receive()
    }

    public var onClose: (() -> Void)?

    private func receive() {
        connection.receiveMessage { [weak self] data, context, _, error in
            MainActor.assumeIsolated {
                guard let self, !self.cancelled else { return }
                let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
                if error != nil || metadata?.opcode == .close {
                    // The other end went away: drop the connection instead of waiting for a timeout.
                    self.cancel()
                    self.onClose?()
                    return
                }
                if let data, !data.isEmpty { self.onMessage?(data) }
                self.receive()
            }
        }
    }

    public func send<T: Encodable>(_ message: T) {
        guard !cancelled, let data = try? CompanionCoding.encode(message) else { return }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .binary)
        let context = NWConnection.ContentContext(identifier: "message", metadata: [metadata])
        connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
    }

    public func cancel() {
        cancelled = true
        connection.cancel()
    }
}
