import Foundation
import Network
import Observation
import UIKit
import RelevoProtocol

/// Connection to Relevo on the Mac and the state it shares. Views never talk to the network directly:
/// view models read this state and send commands through it.
@Observable
final class CompanionClient {
    enum ConnectionState: Equatable {
        case unpaired
        case connecting
        case connected
        case offline(String)
    }

    private(set) var pairing: PairingInfo?
    private(set) var state: ConnectionState = .unpaired
    private(set) var snapshot: RemoteSnapshot?
    /// Transcripts of the threads opened on this device (the subscribed one is kept live).
    private(set) var threads: [UUID: RemoteThread] = [:]
    /// What the Live Activity shows, as computed by the Mac.
    private(set) var activityState: RelevoActivityState?
    var toast: String?
    let liveActivities = LiveActivityController()

    @ObservationIgnored private var channel: MessageChannel?
    @ObservationIgnored private var isActive = false
    @ObservationIgnored private var failures = 0
    @ObservationIgnored private var endpointIndex = 0
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    @ObservationIgnored private var subscribed: UUID?
    @ObservationIgnored private var pendingCreations: [UUID: CheckedContinuation<UUID?, Never>] = [:]
    @ObservationIgnored private var pendingImages: [UUID: CheckedContinuation<Data?, Never>] = [:]
    @ObservationIgnored private let imageCache = NSCache<NSString, NSData>()

    init() {
        pairing = PairingStore.load()
        state = pairing == nil ? .unpaired : .offline("Sin conectar")
        liveActivities.onRegistration = { [weak self] registration in
            guard let self, self.isConnected else { return }
            self.channel?.send(ClientMessage.registerLiveActivity(registration))
        }
    }

    var isConnected: Bool { state == .connected }

    // MARK: - Pairing

    func pair(with info: PairingInfo) {
        PairingStore.save(info)
        pairing = info
        snapshot = nil
        threads = [:]
        reconnect()
    }

    /// Fixed address used when the Mac can't be found on the local network (e.g. through Tailscale).
    func setManualAddress(host: String?, port: UInt16?) {
        guard var info = pairing else { return }
        let trimmed = host?.trimmingCharacters(in: .whitespaces)
        info.host = trimmed?.isEmpty == false ? trimmed : nil
        info.port = port
        PairingStore.save(info)
        pairing = info
        reconnect()
    }

    func unpair() {
        liveActivities.endAll()
        disconnect()
        PairingStore.clear()
        pairing = nil
        snapshot = nil
        threads = [:]
        state = .unpaired
    }

    // MARK: - Lifecycle

    /// Connected while the app is in the foreground; iOS suspends sockets in the background anyway.
    func setActive(_ active: Bool) {
        isActive = active
        if active {
            liveActivities.appDidEnterForeground()
            connect()
        } else {
            liveActivities.appDidLeaveForeground(pushReady: snapshot?.pushReady == true)
            disconnect()
        }
    }

    func reconnect() {
        disconnect()
        failures = 0
        endpointIndex = 0
        connect()
    }

    private func connect() {
        guard isActive, channel == nil, let pairing else { return }
        retryTask?.cancel()
        state = .connecting
        let endpoints = Self.endpoints(for: pairing)
        let endpoint = endpoints[endpointIndex % endpoints.count]
        let parameters = CompanionTransport.parameters(secret: pairing.secret, identity: pairing.serverId)
        let channel = MessageChannel(connection: NWConnection(to: endpoint, using: parameters))
        self.channel = channel

        channel.onStateChange = { [weak self, weak channel] state in
            guard let self, let channel, self.channel === channel else { return }
            switch state {
            case .ready:
                channel.send(ClientMessage.hello(device: UIDevice.current.name, version: CompanionCoding.version))
                if let subscribed = self.subscribed { channel.send(ClientMessage.subscribe(threadId: subscribed)) }
            case .failed(let error):
                self.fail(Self.describe(error))
            case .waiting(let error):
                if case .tls = error { self.fail(Self.describe(error)) }
            default:
                break
            }
        }
        channel.onClose = { [weak self, weak channel] in
            guard let self, let channel, self.channel === channel else { return }
            self.fail("El Mac ha cerrado la conexión")
        }
        channel.onMessage = { [weak self] data in self?.receive(data) }
        channel.start()

        // Bonjour lookups that never resolve just wait: give up after a few seconds and try the next address.
        Task { [weak self, weak channel] in
            try? await Task.sleep(for: .seconds(8))
            guard let self, let channel, self.channel === channel, self.state == .connecting else { return }
            self.fail(pairing.host == nil ? "No encuentro el Mac en esta red" : "No llego al Mac")
        }
    }

    private func disconnect() {
        retryTask?.cancel()
        channel?.cancel()
        channel = nil
        if pairing != nil, state != .unpaired { state = .offline("Sin conectar") }
        for continuation in pendingCreations.values { continuation.resume(returning: nil) }
        pendingCreations.removeAll()
        for continuation in pendingImages.values { continuation.resume(returning: nil) }
        pendingImages.removeAll()
    }

    private func fail(_ reason: String) {
        channel?.cancel()
        channel = nil
        state = .offline(reason)
        guard isActive, let pairing else { return }
        endpointIndex += 1
        let endpointCount = Self.endpoints(for: pairing).count
        // Try the other address right away; back off once every address failed.
        if endpointIndex % endpointCount == 0 { failures += 1 }
        let delay = endpointIndex % endpointCount == 0 ? min(20, 1.5 * pow(2, Double(min(failures, 4)))) : 0.2
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.connect()
        }
    }

    private static func endpoints(for pairing: PairingInfo) -> [NWEndpoint] {
        var list: [NWEndpoint] = [.service(name: pairing.serverId, type: CompanionTransport.serviceType, domain: "local.", interface: nil)]
        if let host = pairing.host {
            let port = NWEndpoint.Port(rawValue: pairing.port ?? CompanionTransport.defaultPort) ?? .any
            list.append(.hostPort(host: NWEndpoint.Host(host), port: port))
        }
        return list
    }

    private static func describe(_ error: NWError) -> String {
        switch error {
        case .tls: "El Mac no reconoce este iPhone. Vuelve a escanear el código en Ajustes › iPhone."
        case .dns: "No encuentro el Mac en esta red"
        case .posix(let code) where code == .ECONNREFUSED: "El Mac no acepta conexiones (¿está activado en Ajustes › iPhone?)"
        default: "Sin conexión con el Mac"
        }
    }

    // MARK: - Messages

    private func receive(_ data: Data) {
        guard let message = try? CompanionCoding.decode(ServerMessage.self, from: data) else { return }
        switch message {
        case .welcome:
            state = .connected
            failures = 0
            endpointIndex = 0
            channel?.send(ClientMessage.registerLiveActivity(liveActivities.registration))
        case .snapshot(let snapshot):
            self.snapshot = snapshot
        case .thread(let thread):
            threads[thread.id] = thread
        case .threadPatch(let patch):
            apply(patch)
        case .created(let requestId, let threadId):
            pendingCreations.removeValue(forKey: requestId)?.resume(returning: threadId)
        case .toast(let text):
            toast = text
        case .image(let requestId, let data, let error):
            if data == nil, let error { toast = error }
            pendingImages.removeValue(forKey: requestId)?.resume(returning: data)
        case .activity(let activity):
            activityState = activity
            liveActivities.apply(activity, macName: snapshot?.macName ?? pairing?.name ?? "Mac")
        }
    }

    private func apply(_ patch: RemoteThreadPatch) {
        guard var thread = threads[patch.id] else { return }   // the full transcript always arrives first
        var index = Dictionary(thread.items.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { $1 })
        for item in patch.upserts {
            if let i = index[item.id] {
                thread.items[i] = item
            } else {
                index[item.id] = thread.items.count
                thread.items.append(item)
            }
        }
        thread.title = patch.title
        thread.totalItems = patch.totalItems
        thread.runtime = patch.runtime
        threads[patch.id] = thread
    }

    func send(_ message: ClientMessage) {
        guard isConnected, let channel else {
            toast = "Sin conexión con el Mac"
            return
        }
        channel.send(message)
    }

    /// Streams this thread's transcript while it is on screen.
    func subscribe(_ threadId: UUID?) {
        subscribed = threadId
        if isConnected { channel?.send(ClientMessage.subscribe(threadId: threadId)) }
    }

    func unsubscribe(_ threadId: UUID) {
        guard subscribed == threadId else { return }
        subscribe(nil)
    }

    func createThread(in projectId: UUID) async -> UUID? {
        guard isConnected else {
            toast = "Sin conexión con el Mac"
            return nil
        }
        let requestId = UUID()
        return await withCheckedContinuation { continuation in
            pendingCreations[requestId] = continuation
            channel?.send(ClientMessage.newThread(projectId: projectId, requestId: requestId))
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(6))
                self?.pendingCreations.removeValue(forKey: requestId)?.resume(returning: nil)
            }
        }
    }

    /// An image the thread mentions, from the Mac (JPEG, downscaled to `maxPixel`). Cached per size.
    func fetchImage(threadId: UUID, path: String, maxPixel: Int) async -> Data? {
        let key = "\(maxPixel)|\(path)" as NSString
        if let cached = imageCache.object(forKey: key) { return cached as Data }
        guard isConnected else { return nil }
        let requestId = UUID()
        let data: Data? = await withCheckedContinuation { continuation in
            pendingImages[requestId] = continuation
            channel?.send(ClientMessage.fetchImage(requestId: requestId, threadId: threadId, path: path, maxPixel: maxPixel))
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(20))
                self?.pendingImages.removeValue(forKey: requestId)?.resume(returning: nil)
            }
        }
        if let data { imageCache.setObject(data as NSData, forKey: key) }
        return data
    }

    // MARK: - Lookups

    func account(_ id: UUID?) -> RemoteAccount? {
        guard let id else { return nil }
        return snapshot?.accounts.first { $0.id == id }
    }

    func project(_ id: UUID?) -> RemoteProject? {
        guard let id else { return nil }
        return snapshot?.projects.first { $0.id == id }
    }

    var pendingApprovals: Int { snapshot?.threads.filter(\.needsApproval).count ?? 0 }
}
