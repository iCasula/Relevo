import Foundation
import Observation
import RelevoProtocol
import RelevoMarkdown
import CoreGraphics

/// One conversation: its live transcript from the Mac, the composer and every action on it.
@Observable
final class ThreadViewModel {
    let client: CompanionClient
    let threadId: UUID

    var draft = "" {
        didSet { if draft != oldValue { scheduleDraftSync() } }
    }
    /// Tool and reasoning rows the user opened, by item id (groups use their first item's id).
    var expanded = Set<String>()
    /// Show every tool call, or fold each run of them into one summary row (default on iPhone: folded).
    var showTools = UserDefaults.standard.object(forKey: "showTools") != nil && UserDefaults.standard.bool(forKey: "showTools") {
        didSet { UserDefaults.standard.set(showTools, forKey: "showTools") }
    }

    /// Consecutive tool calls (and reasoning) shown as one row while tools are hidden.
    struct ActivityGroup: Identifiable, Hashable {
        let items: [RemoteItem]
        var id: String { "group:" + (items.first?.id ?? "") }
        var tools: [RemoteItem] { items.filter { $0.kind == .tool } }
        var failed: Int { tools.filter { $0.toolState == .failed }.count }
        var isRunning: Bool { tools.contains { $0.toolState == .running } }

        /// "4 acciones · Read, Edit, Bash"
        var summary: String {
            var names: [String] = []
            for tool in tools {
                let name = tool.toolName ?? tool.title?.split(separator: " ").first.map(String.init) ?? "Herramienta"
                if !names.contains(name) { names.append(name) }
            }
            let count = tools.count == 1 ? "1 acción" : "\(tools.count) acciones"
            let list = names.prefix(3).joined(separator: ", ") + (names.count > 3 ? "…" : "")
            return list.isEmpty ? count : "\(count) · \(list)"
        }
    }

    enum Row: Identifiable {
        case item(RemoteItem)
        case group(ActivityGroup)

        var id: String {
            switch self {
            case .item(let item): item.id
            case .group(let group): group.id
            }
        }
    }

    @ObservationIgnored private var draftTask: Task<Void, Never>?

    init(client: CompanionClient, threadId: UUID) {
        self.client = client
        self.threadId = threadId
    }

    // MARK: - State

    var thread: RemoteThread? { client.threads[threadId] }
    var summary: RemoteThreadSummary? { client.snapshot?.threads.first { $0.id == threadId } }
    var title: String { thread?.title ?? summary?.title ?? "Hilo" }
    var items: [RemoteItem] { thread?.items ?? [] }
    var runtime: RemoteRuntime? { thread?.runtime }
    var isLoading: Bool { thread == nil }
    var isRunning: Bool { runtime?.isRunning ?? false }
    var hiddenCount: Int { max(0, (thread?.totalItems ?? 0) - items.count) }
    var isConnected: Bool { client.isConnected }

    var accounts: [RemoteAccount] { client.snapshot?.accounts ?? [] }
    var selectedAccount: RemoteAccount? { client.account(runtime?.selectedAccountId) }
    var selectedModel: RemoteModel? { selectedAccount?.model(runtime?.selectedModel) }

    var efforts: [String] { selectedModel?.efforts ?? [] }
    var effortTitle: String {
        if let e = runtime?.selectedEffort { return EffortLabel.name(e) }
        if let d = selectedModel?.defaultEffort { return EffortLabel.name(d) }
        return "Auto"
    }

    var subtitle: String {
        guard let account = selectedAccount else { return "" }
        return "\(account.name) · \(account.shortModelName(runtime?.selectedModel))"
    }

    /// While the agent works, sending queues the message on the Mac for when the turn ends —
    /// only if that Mac version has a queue (older ones would drop the message).
    var canSend: Bool {
        guard isConnected, !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return !isRunning || macSupportsQueue
    }

    var macSupportsQueue: Bool { runtime?.queued != nil }

    var queued: [RemoteQueuedMessage] { runtime?.queued ?? [] }
    var queuePaused: Bool { runtime?.queuePaused ?? false }

    /// Quota windows of the selected model (the Mac already applies per-family limits).
    var usage: [RemoteWindow] { runtime?.usage ?? selectedAccount?.status?.windows ?? [] }
    var usageNote: String? { runtime?.usageNote ?? (usage.isEmpty ? selectedAccount?.status?.note : nil) }
    /// The window that will run out first.
    var tightestWindow: RemoteWindow? { usage.max { $0.percent < $1.percent } }

    var pendingApprovals: Int { items.filter { $0.kind == .approval && $0.resolution == nil }.count }

    /// Transcript as displayed: with tools hidden, each run of tool calls becomes one expandable group.
    var rows: [Row] {
        // A reply that has started but has no text yet would only be an empty gap at the bottom.
        let items = self.items.filter { !($0.kind == .assistant && $0.usage == nil && $0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
        guard !showTools else { return items.map(Row.item) }
        var rows: [Row] = []
        var run: [RemoteItem] = []
        func flush() {
            defer { run = [] }
            guard !run.isEmpty else { return }
            let group = ActivityGroup(items: run)
            // Reasoning on its own is already a single collapsed line: no need to group it.
            guard !group.tools.isEmpty else { rows += run.map(Row.item); return }
            rows.append(.group(group))
            if expanded.contains(group.id) { rows += run.map(Row.item) }
        }
        for item in items {
            if item.kind == .tool || item.kind == .reasoning {
                run.append(item)
            } else {
                flush()
                rows.append(.item(item))
            }
        }
        flush()
        return rows
    }

    func toggle(_ group: ActivityGroup) {
        if expanded.remove(group.id) == nil { expanded.insert(group.id) }
    }

    /// First assistant item of each turn shows who answered (like the Mac).
    var authorHeaders: Set<String> {
        var result = Set<String>()
        var needsHeader = true
        for item in items {
            switch item.kind {
            case .user, .notice: needsHeader = true
            case .assistant:
                if needsHeader { result.insert(item.id); needsHeader = false }
            default: break
            }
        }
        return result
    }

    func account(_ id: UUID?) -> RemoteAccount? { client.account(id) }

    // MARK: - Files and images the agent mentions

    /// Image being shown in Quick Look (a temporary copy of the one on the Mac).
    var previewURL: URL?
    /// A non-image path the user tapped: offered to open on the Mac.
    var pathToOpenOnMac: String?
    private(set) var loadingPreview = false

    func thumbnail(_ path: String) async -> CGImage? {
        guard let data = await client.fetchImage(threadId: threadId, path: path, maxPixel: 480) else { return nil }
        return ThumbnailMaker.image(data: data, maxPixel: 480)
    }

    /// Images open here (fetched from the Mac); other paths can be shown on the Mac.
    func open(path: String) {
        guard FileReference.isImage(path) else {
            pathToOpenOnMac = path
            return
        }
        loadingPreview = true
        Task {
            defer { loadingPreview = false }
            guard let data = await client.fetchImage(threadId: threadId, path: path, maxPixel: 2400) else { return }
            let name = (path as NSString).deletingPathExtension.split(separator: "/").last.map(String.init) ?? "imagen"
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(name).jpg")
            try? data.write(to: url, options: .atomic)
            previewURL = url
        }
    }

    func openOnMac(_ path: String) {
        client.send(.openOnMac(threadId: threadId, path: path))
        client.toast = "Abierto en el Mac"
    }

    // MARK: - Lifecycle

    func onAppear() { client.subscribe(threadId) }
    func onDisappear() { client.unsubscribe(threadId) }

    // MARK: - Actions

    /// Messages sent from this screen: the transcript goes back to the last line on each one.
    private(set) var sentCount = 0

    func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend else { return }
        draftTask?.cancel()
        sentCount += 1
        client.send(.send(threadId: threadId, text: text))
        draft = ""
        draftTask?.cancel()   // the Mac clears its draft when it sends
    }

    func stop() { client.send(.stop(threadId: threadId)) }

    func dequeue(_ message: RemoteQueuedMessage) { client.send(.dequeue(threadId: threadId, messageId: message.id)) }
    func sendQueuedNow(_ message: RemoteQueuedMessage) { client.send(.sendQueuedNow(threadId: threadId, messageId: message.id)) }

    /// Interrupts the agent and sends the draft right away (redirecting it), in the same conversation.
    func sendNow() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend else { return }
        draftTask?.cancel()
        sentCount += 1
        client.send(.sendNow(threadId: threadId, text: text))
        draft = ""
        draftTask?.cancel()
    }
    func resumeQueue() { client.send(.resumeQueue(threadId: threadId)) }

    func answer(_ item: RemoteItem, answers: [String: String]) {
        client.send(.answer(threadId: threadId, itemId: item.id, answers: answers))
    }

    func approve(_ item: RemoteItem, option: RemoteOption) {
        client.send(.approve(threadId: threadId, itemId: item.id, optionId: option.id))
    }

    func select(_ account: RemoteAccount, model: RemoteModel) {
        client.send(.select(threadId: threadId, accountId: account.id, model: model.id))
    }

    func setEffort(_ effort: String?) { client.send(.setEffort(threadId: threadId, effort: effort)) }

    func setMode(_ mode: RemoteMode) { client.send(.setMode(threadId: threadId, mode: mode)) }

    func relay(to candidate: RemoteCandidate) {
        client.send(.relay(threadId: threadId, accountId: candidate.accountId, model: candidate.model))
    }

    /// nil = the Mac's default.
    func setLimitPlan(_ plan: RemoteLimitPlan?) { client.send(.setLimitPlan(threadId: threadId, plan: plan)) }

    func limitAction(_ action: LimitAction) { client.send(.limitAction(threadId: threadId, action: action)) }

    func suggestion(_ action: SuggestionAction) { client.send(.suggestion(threadId: threadId, action: action)) }

    func toggle(_ item: RemoteItem) {
        if expanded.remove(item.id) == nil { expanded.insert(item.id) }
    }

    /// The Mac classifies what you're typing («Relevo suggests»), so the draft goes over after a short pause.
    private func scheduleDraftSync() {
        draftTask?.cancel()
        let text = draft
        draftTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(700))
            guard let self, !Task.isCancelled, self.isConnected else { return }
            self.client.send(.setDraft(threadId: self.threadId, text: text))
        }
    }
}
