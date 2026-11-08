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

    /// The host in use: a Mac or a headless Relevo host (e.g. a home server).
    private(set) var pairing: PairingInfo?
    /// Every paired host; one is in use at a time.
    private(set) var hosts: [PairingInfo] = []
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
    /// How the current connection reached the Mac ("red local" or an address).
    private(set) var connectedVia: String?
    @ObservationIgnored private var failures = 0
    @ObservationIgnored private var attempts: [MessageChannel] = []
    @ObservationIgnored private var attemptErrors: [NWError] = []
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    @ObservationIgnored private var subscribed: UUID?
    @ObservationIgnored private var pendingCreations: [UUID: CheckedContinuation<UUID?, Never>] = [:]
    @ObservationIgnored private var pendingImages: [UUID: CheckedContinuation<Data?, Never>] = [:]
    @ObservationIgnored private let imageCache = NSCache<NSString, NSData>()

    init() {
        let stored = PairingStore.loadAll()
        hosts = stored.hosts
        pairing = hosts.first { $0.serverId == stored.active } ?? hosts.first
        state = pairing == nil ? .unpaired : .offline("Sin conectar")
        liveActivities.onRegistration = { [weak self] registration in
            guard let self, self.isConnected else { return }
            self.channel?.send(ClientMessage.registerLiveActivity(registration))
        }
    }

    var isConnected: Bool { state == .connected }

    // MARK: - Pairing

    /// Adds a host (or updates one paired again) and switches to it.
    func pair(with info: PairingInfo) {
        if let i = hosts.firstIndex(where: { $0.serverId == info.serverId }) { hosts[i] = info } else { hosts.append(info) }
        use(info)
    }

    /// Switches to another paired host: its threads, limits and Live Activity replace the current one's.
    func switchHost(to serverId: String) {
        guard serverId != pairing?.serverId, let info = hosts.first(where: { $0.serverId == serverId }) else { return }
        use(info)
    }

    private func use(_ info: PairingInfo) {
        if pairing?.serverId != info.serverId { liveActivities.endAll() }
        pairing = info
        snapshot = nil
        threads = [:]
        activityState = nil
        subscribed = nil
        persist()
        reconnect()
    }

    /// Saves a change to the host in use (address set by hand, addresses learnt from it).
    private func update(_ info: PairingInfo) {
        if let i = hosts.firstIndex(where: { $0.serverId == info.serverId }) { hosts[i] = info }
        pairing = info
        persist()
    }

    private func persist() {
        PairingStore.saveAll(hosts, active: pairing?.serverId)
    }

    /// Fixed address used when the host can't be found on the local network (e.g. through Tailscale).
    func setManualAddress(host: String?, port: UInt16?) {
        guard var info = pairing else { return }
        let trimmed = host?.trimmingCharacters(in: .whitespaces)
        info.host = trimmed?.isEmpty == false ? trimmed : nil
        info.port = port
        update(info)
        reconnect()
    }

    /// Forgets the host in use; the next paired one (if any) takes over.
    func unpair() {
        liveActivities.endAll()
        disconnect()
        hosts.removeAll { $0.serverId == pairing?.serverId }
        snapshot = nil
        threads = [:]
        activityState = nil
        if let next = hosts.first {
            pairing = next
            persist()
            reconnect()
            return
        }
        PairingStore.clear()
        pairing = nil
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
        connect()
    }

    /// Tries every way to reach the Mac at once and keeps the first that answers: Bonjour on the same
    /// network, or one of its addresses through a VPN (WireGuard, Tailscale…), where Bonjour doesn't reach.
    private func connect() {
        guard isActive, channel == nil, attempts.isEmpty, let pairing else { return }
        retryTask?.cancel()
        state = .connecting
        attemptErrors = []
        generation += 1
        let thisGeneration = generation
        for (endpoint, label) in pairing.endpoints {
            let parameters = CompanionTransport.parameters(secret: pairing.secret, identity: pairing.serverId)
            let attempt = MessageChannel(connection: NWConnection(to: endpoint, using: parameters))
            attempts.append(attempt)
            attempt.onStateChange = { [weak self, weak attempt] state in
                guard let self, let attempt, self.attempts.contains(where: { $0 === attempt }) else { return }
                switch state {
                case .ready: self.adopt(attempt, via: label)
                case .failed(let error): self.drop(attempt, error: error)
                case .waiting(let error):
                    // Refused or wrong key: this address won't work. Others (no route yet…) get until the timeout.
                    if case .tls = error { self.drop(attempt, error: error) }
                    if case .posix(let code) = error, code == .ECONNREFUSED { self.drop(attempt, error: error) }
                default: break
                }
            }
            attempt.onClose = { [weak self, weak attempt] in
                guard let self, let attempt, self.attempts.contains(where: { $0 === attempt }) else { return }
                self.drop(attempt, error: nil)
            }
            attempt.start()
        }

        // Bonjour lookups that never resolve and unroutable addresses just wait: give up after a few seconds.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(8))
            guard let self, self.generation == thisGeneration else { return }
            if self.channel == nil, !self.attempts.isEmpty {
                for attempt in self.attempts { attempt.cancel() }
                self.attempts = []
                self.allAttemptsFailed()
            } else if self.channel != nil, self.state == .connecting {
                self.fail("El Mac no responde")
            }
        }
    }

    private func adopt(_ winner: MessageChannel, via label: String) {
        for attempt in attempts where attempt !== winner { attempt.cancel() }
        attempts = []
        channel = winner
        connectedVia = label
        winner.onStateChange = { [weak self, weak winner] state in
            guard let self, let winner, self.channel === winner else { return }
            if case .failed(let error) = state { self.fail(Self.describe(error)) }
        }
        winner.onClose = { [weak self, weak winner] in
            guard let self, let winner, self.channel === winner else { return }
            self.fail("El Mac ha cerrado la conexión")
        }
        winner.onMessage = { [weak self] data in self?.receive(data) }
        winner.send(ClientMessage.hello(device: UIDevice.current.name, version: CompanionCoding.version))
        if let subscribed { winner.send(ClientMessage.subscribe(threadId: subscribed)) }
    }

    private func drop(_ attempt: MessageChannel, error: NWError?) {
        attempt.cancel()
        attempts.removeAll { $0 === attempt }
        if let error { attemptErrors.append(error) }
        if attempts.isEmpty, channel == nil { allAttemptsFailed() }
    }

    /// The most telling reason among the attempts: a wrong key beats a refused connection beats "not found".
    private func allAttemptsFailed() {
        let reason: String
        if let tls = attemptErrors.first(where: { if case .tls = $0 { true } else { false } }) {
            reason = Self.describe(tls)
        } else if let refused = attemptErrors.first(where: { if case .posix(.ECONNREFUSED) = $0 { true } else { false } }) {
            reason = Self.describe(refused)
        } else {
            reason = (pairing?.endpoints.count ?? 0) > 1 ? "No llego al Mac (¿está dormido o fuera de la VPN?)" : "No encuentro el Mac en esta red"
        }
        fail(reason)
    }

    private func disconnect() {
        retryTask?.cancel()
        for attempt in attempts { attempt.cancel() }
        attempts = []
        channel?.cancel()
        channel = nil
        connectedVia = nil
        if pairing != nil, state != .unpaired { state = .offline("Sin conectar") }
        for continuation in pendingCreations.values { continuation.resume(returning: nil) }
        pendingCreations.removeAll()
        for continuation in pendingImages.values { continuation.resume(returning: nil) }
        pendingImages.removeAll()
    }

    private func fail(_ reason: String) {
        channel?.cancel()
        channel = nil
        connectedVia = nil
        state = .offline(reason)
        guard isActive, pairing != nil else { return }
        failures += 1
        let delay = min(20, 1.5 * pow(2, Double(min(failures - 1, 4))))
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.connect()
        }
    }

    /// The Mac's current addresses, so the next connection through a VPN knows where to go.
    private func learn(addresses: [String], port: UInt16) {
        guard var info = pairing else { return }
        let sorted = addresses.sorted()
        // A port typed by hand (e.g. a forwarded one) stays; otherwise follow the Mac's.
        let newPort = info.host == nil ? port : info.port
        guard info.addresses != sorted || info.port != newPort else { return }
        info.addresses = sorted
        info.port = newPort
        update(info)
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
            channel?.send(ClientMessage.registerLiveActivity(liveActivities.registration))
        case .addresses(let hosts, let port):
            learn(addresses: hosts, port: port)
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
