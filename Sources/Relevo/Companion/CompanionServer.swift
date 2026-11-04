import Foundation
import RelevoMarkdown
import AppKit
import Network
import Observation
import RelevoProtocol

/// Lets a paired iPhone (Relevo Companion) see and drive Relevo: Bonjour on the local network,
/// TLS with a pre-shared key from the pairing secret, WebSocket + JSON messages. Off unless enabled in Settings.
@Observable
@MainActor
final class CompanionServer {
    static let shared = CompanionServer()

    struct Device: Identifiable, Hashable {
        var id: UUID
        var name: String
        var connectedAt: Date
    }

    private(set) var isListening = false
    private(set) var port: UInt16?
    private(set) var lastError: String?
    private(set) var devices: [Device] = []

    @ObservationIgnored private(set) weak var store: AppStore?
    @ObservationIgnored private var listener: NWListener?
    @ObservationIgnored private var peers: [UUID: CompanionPeer] = [:]

    func attach(_ store: AppStore) {
        self.store = store
        settingsChanged()
        LiveActivityPusher.shared.attach(store)
    }

    /// iPhones connected right now (their app keeps its Live Activity current by itself).
    var connectedDeviceIds: Set<String> { Set(peers.values.compactMap(\.deviceId)) }

    func settingsChanged() {
        guard let store else { return }
        let wantedPort = UInt16(clamping: store.settings.companionPort)
        if store.settings.companionEnabled {
            if listener == nil || (port != wantedPort && lastError == nil) { restart(port: wantedPort) }
        } else {
            stop()
        }
    }

    /// New secret: every paired iPhone has to scan the code again.
    func unpairAll() {
        CompanionCredentials.regenerate()
        guard let store, store.settings.companionEnabled else { return }
        restart(port: UInt16(clamping: store.settings.companionPort))
    }

    var pairing: PairingInfo? {
        guard let store else { return nil }
        let host = store.settings.companionHost?.trimmingCharacters(in: .whitespaces)
        return CompanionCredentials.pairing(port: port ?? UInt16(clamping: store.settings.companionPort), host: host?.isEmpty == false ? host : nil)
    }

    private func restart(port wanted: UInt16, allowFallback: Bool = true) {
        stop()
        let creds = CompanionCredentials.current()
        let parameters = CompanionTransport.parameters(secret: creds.secret, identity: creds.serverId)
        parameters.allowLocalEndpointReuse = true
        let nwPort = NWEndpoint.Port(rawValue: wanted) ?? .any
        guard let listener = try? NWListener(using: parameters, on: nwPort) else {
            lastError = "No se pudo abrir el puerto \(wanted)"
            return
        }
        listener.service = NWListener.Service(name: creds.serverId, type: CompanionTransport.serviceType)
        listener.stateUpdateHandler = { [weak self, weak listener] state in
            MainActor.assumeIsolated {
                guard let self, let listener, self.listener === listener else { return }
                switch state {
                case .ready:
                    self.isListening = true
                    self.port = listener.port?.rawValue
                    self.lastError = nil
                case .failed(let error):
                    self.isListening = false
                    if allowFallback, wanted != 0 {
                        // Port taken: any free port still works through Bonjour on the local network.
                        self.restart(port: 0, allowFallback: false)
                        self.lastError = "El puerto \(wanted) está ocupado; uso otro (solo vale en la red local)"
                    } else {
                        self.lastError = error.localizedDescription
                    }
                case .cancelled:
                    self.isListening = false
                default:
                    break
                }
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            MainActor.assumeIsolated { self?.accept(connection) }
        }
        self.listener = listener
        listener.start(queue: .main)
    }

    private func stop() {
        listener?.cancel()
        listener = nil
        isListening = false
        port = nil
        for peer in peers.values { peer.close() }
        peers.removeAll()
        devices.removeAll()
    }

    private func accept(_ connection: NWConnection) {
        guard let store else { connection.cancel(); return }
        let peer = CompanionPeer(connection: connection, store: store, server: self)
        peers[peer.id] = peer
        peer.start()
    }

    func peerIdentified(_ peer: CompanionPeer) {
        devices.removeAll { $0.id == peer.id }
        devices.append(Device(id: peer.id, name: peer.deviceName ?? "iPhone", connectedAt: Date()))
    }

    func peerClosed(_ peer: CompanionPeer) {
        peers.removeValue(forKey: peer.id)
        devices.removeAll { $0.id == peer.id }
    }
}

/// One connected iPhone: answers its commands and streams changes (snapshot + the thread it is viewing).
@MainActor
final class CompanionPeer {
    let id = UUID()
    private(set) var deviceName: String?
    /// Stable id the iPhone sends with its Live Activity tokens.
    private(set) var deviceId: String?
    private let channel: MessageChannel
    private unowned let store: AppStore
    private weak var server: CompanionServer?

    private var greeted = false
    private var lastSnapshot: Data?
    private var lastActivity: RelevoActivityState?
    private var snapshotPending = false
    private var subscribed: UUID?
    private var threadGeneration = 0
    private var threadPending = false
    private var sentOrder: [String] = []
    private var sentItems: [String: RemoteItem] = [:]
    private var sentRuntime: RemoteRuntime?
    private var sentTitle: String?

    init(connection: NWConnection, store: AppStore, server: CompanionServer) {
        self.channel = MessageChannel(connection: connection)
        self.store = store
        self.server = server
    }

    func start() {
        channel.onMessage = { [weak self] data in self?.receive(data) }
        channel.onClose = { [weak self] in
            guard let self else { return }
            self.server?.peerClosed(self)
        }
        channel.onStateChange = { [weak self] state in
            guard let self else { return }
            switch state {
            case .failed, .cancelled: self.server?.peerClosed(self)
            default: break
            }
        }
        channel.start()
    }

    func close() { channel.cancel() }

    private func send(_ message: ServerMessage) { channel.send(message) }

    // MARK: - Commands

    private func receive(_ data: Data) {
        guard let message = try? CompanionCoding.decode(ClientMessage.self, from: data) else { return }
        if case .hello(let device, _) = message {
            deviceName = device
            greeted = true
            server?.peerIdentified(self)
            send(.welcome(name: CompanionCredentials.macName, version: CompanionCoding.version))
            observeSnapshot()
            return
        }
        guard greeted else { return }
        handle(message)
    }

    private func thread(_ id: UUID) -> ThreadModel? { store.threads.first { $0.id == id } }

    private func handle(_ message: ClientMessage) {
        switch message {
        case .hello:
            break
        case .subscribe(let id):
            subscribed = id
            threadGeneration += 1
            sentOrder = []
            sentItems = [:]
            sentRuntime = nil
            sentTitle = nil
            if id != nil { observeThread(generation: threadGeneration) }
        case .send(let id, let text):
            guard let t = thread(id) else { return }
            t.draft = ""
            store.runtime(for: t).send(text)
        case .dequeue(let id, let messageId):
            guard let t = thread(id) else { return }
            store.runtime(for: t).removeQueued(messageId)
        case .sendNow(let id, let text):
            guard let t = thread(id) else { return }
            t.draft = ""
            store.runtime(for: t).sendNow(text)
        case .sendQueuedNow(let id, let messageId):
            guard let t = thread(id) else { return }
            store.runtime(for: t).sendQueuedNow(messageId)
        case .resumeQueue(let id):
            guard let t = thread(id) else { return }
            store.runtime(for: t).resumeQueue()
        case .stop(let id):
            guard let t = thread(id) else { return }
            store.runtime(for: t).stop(from: .iphone(deviceName ?? "iPhone"))
        case .approve(let id, let itemId, let optionId):
            guard let t = thread(id), let item = t.items.last(where: { $0.id == itemId }), item.resolution == nil,
                  let option = item.options?.first(where: { $0.id == optionId }) else { return }
            store.runtime(for: t).resolveApproval(itemId: itemId, option: option)
        case .answer(let id, let itemId, let answers):
            guard let t = thread(id) else { return }
            store.runtime(for: t).answerQuestions(itemId: itemId, answers: answers)
        case .select(let id, let accountId, let model):
            guard let t = thread(id), let account = store.account(accountId) else { return }
            t.selectedAccountId = accountId
            t.selectedModel = model
            if let e = t.selectedEffort, !(store.efforts(for: account, model: model)?.contains(e) ?? false) {
                store.runtime(for: t).setEffort(nil)
            }
            store.updateAccount(accountId) { $0.lastModel = model }
            store.save(t)
        case .setEffort(let id, let effort):
            guard let t = thread(id) else { return }
            store.runtime(for: t).setEffort(effort)
        case .setMode(let id, let mode):
            guard let t = thread(id), let m = PermissionMode(rawValue: mode.rawValue) else { return }
            store.runtime(for: t).setMode(m)
        case .setDraft(let id, let text):
            guard let t = thread(id), t.draft != text else { return }
            t.draft = text
            store.runtime(for: t).suggester.draftChanged()
            store.save(t)
        case .suggestion(let id, let action):
            guard let t = thread(id) else { return }
            let s = store.runtime(for: t).suggester
            switch action {
            case .accept: s.accept()
            case .dismiss: s.dismiss()
            case .undo: s.undo()
            }
        case .relay(let id, let accountId, let model):
            guard let t = thread(id), let account = store.account(accountId) else { return }
            store.runtime(for: t).relay(to: account, model: model)
        case .setLimitPlan(let id, let plan):
            guard let t = thread(id) else { return }
            t.limitPlan = plan.flatMap { CompanionMapper.limitPlan($0) }
            store.save(t)
        case .limitAction(let id, let action):
            guard let t = thread(id) else { return }
            let rt = store.runtime(for: t)
            switch action {
            case .relayNow: rt.relayNow()
            case .cancelRelay: rt.cancelPendingRelay()
            case .resumeNow: Task { await rt.resumeAfterReset(force: true) }
            case .cancelResume: rt.cancelResume()
            }
        case .newThread(let projectId, let requestId):
            guard let project = store.project(projectId), let t = store.newThread(in: project, select: false) else {
                send(.toast("No se pudo crear el hilo"))
                return
            }
            send(.created(requestId: requestId, threadId: t.id))
        case .refreshUsage:
            store.refreshAllUsage()
        case .fetchImage(let requestId, let threadId, let path, let maxPixel):
            guard let t = thread(threadId), FilePaths.isMentioned(path, in: t), FileReference.isImage(path),
                  let url = FilePaths.resolve(path, thread: t, projectPath: store.project(t.projectId)?.path) else {
                send(.image(requestId: requestId, data: nil, error: "Esa imagen no está disponible en el Mac"))
                return
            }
            let size = min(max(maxPixel, 64), 3000)
            Task { @MainActor [weak self] in
                let data = await Task.detached(priority: .userInitiated) { FilePaths.jpeg(url, maxPixel: size) }.value
                self?.send(.image(requestId: requestId, data: data, error: data == nil ? "No se pudo leer la imagen" : nil))
            }
        case .openOnMac(let threadId, let path):
            guard let t = thread(threadId), FilePaths.isMentioned(path, in: t) else { return }
            NSApp.activate(ignoringOtherApps: true)
            store.select(t.id)
            store.runtime(for: t).openReference(path)
        case .registerLiveActivity(let registration):
            deviceId = registration.deviceId
            LiveActivityPusher.shared.register(registration)
        }
    }

    // MARK: - Streaming changes

    /// Sends the snapshot when it changes (coalesced), re-arming observation each time.
    private func observeSnapshot() {
        let (snapshot, activity) = withObservationTracking {
            (CompanionMapper.snapshot(store), CompanionMapper.activity(store))
        } onChange: { [weak self] in
            Task { @MainActor in self?.scheduleSnapshot() }
        }
        if let data = try? CompanionCoding.encode(snapshot), data != lastSnapshot {
            lastSnapshot = data
            send(.snapshot(snapshot))
        }
        if lastActivity.map({ !$0.sameContent(as: activity) }) ?? true {
            lastActivity = activity
            send(.activity(activity))
        }
    }

    private func scheduleSnapshot() {
        guard !snapshotPending else { return }
        snapshotPending = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self else { return }
            self.snapshotPending = false
            self.observeSnapshot()
        }
    }

    /// First call sends the transcript; later ones only the items that changed plus the live state.
    private func observeThread(generation: Int) {
        guard generation == threadGeneration, let id = subscribed, let t = thread(id) else { return }
        let detail = withObservationTracking {
            CompanionMapper.thread(t, store: store)
        } onChange: { [weak self] in
            Task { @MainActor in self?.scheduleThread(generation: generation) }
        }
        let order = detail.items.map(\.id)
        let previous = Set(sentOrder)
        let kept = sentOrder.filter { order.contains($0) }
        // Full resend on first view or when the window of items shifted in a way a patch can't express.
        if sentOrder.isEmpty || kept.count < sentOrder.count && order.count < CompanionMapper.transcriptLimit {
            send(.thread(detail))
        } else {
            let upserts = detail.items.filter { !previous.contains($0.id) || sentItems[$0.id] != $0 }
            if !upserts.isEmpty || detail.runtime != sentRuntime || detail.title != sentTitle {
                send(.threadPatch(RemoteThreadPatch(id: detail.id, title: detail.title, upserts: upserts,
                                                    totalItems: detail.totalItems, runtime: detail.runtime)))
            }
        }
        sentOrder = order
        sentItems = Dictionary(detail.items.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        sentRuntime = detail.runtime
        sentTitle = detail.title
    }

    private func scheduleThread(generation: Int) {
        guard generation == threadGeneration, !threadPending else { return }
        threadPending = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self else { return }
            self.threadPending = false
            self.observeThread(generation: generation)
        }
    }
}
