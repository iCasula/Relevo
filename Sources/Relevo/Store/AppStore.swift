import Foundation
import Observation
import AppKit
import UserNotifications

@Observable
@MainActor
final class AppStore {
    static let shared = AppStore()

    var accounts: [Account] = []
    var projects: [Project] = []
    var threads: [ThreadModel] = []
    var settings = AppSettings()
    var status: [UUID: AccountStatus] = [:]
    var models: [UUID: [ModelOption]] = [:]
    var refreshing: Set<UUID> = []
    var selectedThreadId: UUID?
    var expandedProjects: Set<UUID> = []
    var showNewProject = false
    var toast: String?
    var bootstrapped = false
    var debugRequest: String?

    @ObservationIgnored let trace = TraceStore(url: AppStore.supportDirectory.appendingPathComponent("memory.sqlite"))
    @ObservationIgnored private var runtimes: [UUID: ThreadRuntime] = [:]
    @ObservationIgnored private var saveStateWork: DispatchWorkItem?
    @ObservationIgnored private var threadSaveWork: [UUID: DispatchWorkItem] = [:]
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var refreshSoonWork: [UUID: DispatchWorkItem] = [:]
    @ObservationIgnored private var toastWork: DispatchWorkItem?

    nonisolated static let supportDirectory: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        var dir = base.appendingPathComponent("Relevo", isDirectory: true)
        if let custom = ProcessInfo.processInfo.environment["RELEVO_DATA_DIR"], !custom.isEmpty {
            dir = URL(fileURLWithPath: expandTilde(custom), isDirectory: true)
        }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    private var stateURL: URL { Self.supportDirectory.appendingPathComponent("state.json") }
    private var threadsDir: URL {
        let d = Self.supportDirectory.appendingPathComponent("threads", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    private struct PersistedState: Codable {
        var accounts: [Account]
        var projects: [Project]
        var settings: AppSettings
        var models: [String: [ModelOption]]?
        var status: [String: AccountStatus]?
        var selectedThreadId: UUID?
        var expandedProjects: [UUID]?
    }

    init() {
        load()
    }

    // MARK: - Lifecycle

    func bootstrap() async {
        guard !bootstrapped else { return }
        bootstrapped = true
        await ShellEnvironment.load()
        if accounts.isEmpty { detectAccounts() }
        offerNewProviders()
        refreshAllUsage()
        scheduleTimer()
        CompanionServer.shared.attach(self)
        Task { await UsageImporter.run(store: self) }
        if Self.canNotify {
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
    }

    func shutdown() {
        for rt in runtimes.values { rt.closeSession() }
        saveStateNow()
        for t in threads { writeThread(t) }
    }

    private func scheduleTimer() {
        timer?.invalidate()
        let interval = TimeInterval(max(2, settings.refreshMinutes) * 60)
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshAllUsage() }
        }
    }

    func detectAccounts() {
        var found: [Account] = []
        for kind in ProviderKind.allCases where !kind.usesAPIKey {   // API-key providers are added by hand
            let probe = Account(kind: kind, name: kind.shortName)
            if Binaries.launch(for: probe) != nil { found.append(probe) }
        }
        if found.isEmpty {
            found = ProviderKind.allCases.map { Account(kind: $0, name: $0.shortName, enabled: false) }
        }
        accounts = found
        saveState()
    }

    /// Providers added to the registry since the last launch show up by themselves when their CLI is installed.
    private func offerNewProviders() {
        let known = Set(settings.knownProviders ?? accounts.map(\.kind.rawValue))
        for provider in ProviderRegistry.all where !known.contains(provider.kind.rawValue) && provider.info.autoDetect {
            guard !accounts.contains(where: { $0.kind == provider.kind }) else { continue }
            let account = Account(kind: provider.kind, name: provider.info.shortName)
            if Binaries.launch(for: account) != nil {
                accounts.append(account)
                refreshUsage(account.id)
            }
        }
        settings.knownProviders = ProviderRegistry.all.map(\.kind.rawValue)
        saveState()
    }

    /// Adds any installed CLI that has no subscription yet.
    func detectAccountsMerge() {
        var added = 0
        for kind in ProviderKind.allCases where !kind.usesAPIKey && !accounts.contains(where: { $0.kind == kind }) {
            let probe = Account(kind: kind, name: kind.shortName)
            if Binaries.launch(for: probe) != nil {
                accounts.append(probe)
                added += 1
                refreshUsage(probe.id)
            }
        }
        saveState()
        flash(added == 0 ? "No hay CLIs nuevas" : "Añadidas \(added) suscripciones")
    }

    // MARK: - Persistence

    private func load() {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        if let data = try? Data(contentsOf: stateURL), let s = try? decoder.decode(PersistedState.self, from: data) {
            var seenKinds = Set<ProviderKind>()
            accounts = s.accounts.filter { seenKinds.insert($0.kind).inserted }   // one per provider
            projects = s.projects
            settings = s.settings
            selectedThreadId = s.selectedThreadId
            expandedProjects = Set(s.expandedProjects ?? s.projects.map(\.id))
            for (k, v) in s.models ?? [:] { if let id = UUID(uuidString: k) { models[id] = v } }
            for (k, v) in s.status ?? [:] { if let id = UUID(uuidString: k) { status[id] = v } }
        }
        let files = (try? FileManager.default.contentsOfDirectory(at: threadsDir, includingPropertiesForKeys: nil)) ?? []
        var loaded: [ThreadModel] = []
        for f in files where f.pathExtension == "json" {
            if let data = try? Data(contentsOf: f), let r = try? decoder.decode(ThreadRecord.self, from: data) {
                loaded.append(ThreadModel(record: r))
            }
        }
        threads = loaded.sorted { $0.updatedAt > $1.updatedAt }
        if let sel = selectedThreadId, !threads.contains(where: { $0.id == sel }) { selectedThreadId = nil }
    }

    func saveState() {
        saveStateWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.saveStateNow() }
        saveStateWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: work)
    }

    private func saveStateNow() {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let s = PersistedState(
            accounts: accounts, projects: projects, settings: settings,
            models: Dictionary(uniqueKeysWithValues: models.map { ($0.key.uuidString, $0.value) }),
            status: Dictionary(uniqueKeysWithValues: status.map { ($0.key.uuidString, $0.value) }),
            selectedThreadId: selectedThreadId, expandedProjects: Array(expandedProjects)
        )
        if let data = try? encoder.encode(s) { try? data.write(to: stateURL, options: .atomic) }
    }

    func save(_ thread: ThreadModel) {
        threadSaveWork[thread.id]?.cancel()
        let work = DispatchWorkItem { [weak self, weak thread] in
            guard let self, let thread else { return }
            self.writeThread(thread)
        }
        threadSaveWork[thread.id] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: work)
    }

    private func writeThread(_ thread: ThreadModel) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let url = threadsDir.appendingPathComponent("\(thread.id.uuidString).json")
        if let data = try? encoder.encode(thread.record) { try? data.write(to: url, options: .atomic) }
    }

    // MARK: - Lookups

    func account(_ id: UUID?) -> Account? {
        guard let id else { return nil }
        return accounts.first { $0.id == id }
    }

    func project(_ id: UUID?) -> Project? {
        guard let id else { return nil }
        return projects.first { $0.id == id }
    }

    var enabledAccounts: [Account] { accounts.filter(\.enabled) }

    var selectedThread: ThreadModel? {
        guard let id = selectedThreadId else { return nil }
        return threads.first { $0.id == id }
    }

    func threads(in projectId: UUID) -> [ThreadModel] {
        threads.filter { $0.projectId == projectId }.sorted { $0.updatedAt > $1.updatedAt }
    }

    func runtime(for thread: ThreadModel) -> ThreadRuntime {
        if let rt = runtimes[thread.id] { return rt }
        let rt = ThreadRuntime(thread: thread, store: self)
        runtimes[thread.id] = rt
        return rt
    }

    func existingRuntime(_ id: UUID) -> ThreadRuntime? { runtimes[id] }

    func modelsFor(_ account: Account) -> [ModelOption] {
        if let m = models[account.id], !m.isEmpty { return m }
        return account.kind.provider.localModels() ?? account.kind.fallbackModels
    }

    func defaultModel(for account: Account) -> String {
        let list = modelsFor(account)
        if let last = account.lastModel, list.contains(where: { $0.id == last }) { return last }
        return list.first?.id ?? ""
    }

    func modelOption(_ account: Account, _ model: String) -> ModelOption? {
        modelsFor(account).first { $0.id == model }
    }

    /// Reasoning levels supported by a model (nil when the provider/model has no such setting).
    func efforts(for account: Account, model: String) -> [String]? {
        if let list = modelOption(account, model)?.efforts, !list.isEmpty { return list }
        return account.kind.provider.defaultEfforts(model: model)
    }

    func modelName(_ account: Account, _ model: String) -> String {
        if let m = modelsFor(account).first(where: { $0.id == model }) { return m.name }
        return model.isEmpty ? "predeterminado" : model
    }

    /// Account to start new work with: the default one, else the least used available one.
    func preferredAccount() -> Account? {
        if let id = settings.defaultAccountId, let a = account(id), a.enabled { return a }
        return relayCandidates(excluding: []).first?.account ?? enabledAccounts.first
    }

    /// Account + provider for utility titles: the user's choice, else the cheapest available.
    /// Pay-per-use APIs first (fractions of a cent, no subscription quota), then subscriptions.
    func topicProvider() -> (Account, Provider)? {
        let usable = enabledAccounts.filter { acc in
            acc.kind.provider.quickModelName != nil && status[acc.id]?.isUsable != false
                && (!acc.kind.usesAPIKey || Keychain.get(Keychain.apiKeyName(acc.id)) != nil)
        }
        if let id = settings.topicAccountId, let chosen = usable.first(where: { $0.id == id }) { return (chosen, chosen.kind.provider) }
        let ranked = usable.sorted { $0.kind.provider.quickPriority < $1.kind.provider.quickPriority }
        return ranked.first.map { ($0, $0.kind.provider) }
    }

    /// Other subscriptions with quota left, least used first.
    func relayCandidates(excluding: Set<UUID>) -> [(account: Account, model: String)] {
        enabledAccounts
            .filter { !excluding.contains($0.id) }
            .filter { status[$0.id]?.isUsable != false }
            .sorted { (status[$0.id]?.maxPercent ?? 50) < (status[$1.id]?.maxPercent ?? 50) }
            .map { ($0, defaultModel(for: $0)) }
    }

    // MARK: - Mutations

    func updateAccount(_ id: UUID, _ mutate: (inout Account) -> Void) {
        guard let idx = accounts.firstIndex(where: { $0.id == id }) else { return }
        mutate(&accounts[idx])
        saveState()
    }

    /// One subscription per provider: rotating several accounts of the same provider to stack
    /// limits goes against their terms, so Relevo does not support it.
    func addAccount(_ kind: ProviderKind) {
        guard !accounts.contains(where: { $0.kind == kind }) else { return }
        let account = Account(kind: kind, name: kind.shortName)
        accounts.append(account)
        saveState()
        refreshUsage(account.id)
    }

    func removeAccount(_ id: UUID) {
        accounts.removeAll { $0.id == id }
        status.removeValue(forKey: id)
        models.removeValue(forKey: id)
        saveState()
    }

    func setModels(_ accountId: UUID, _ list: [ModelOption]) {
        guard !list.isEmpty, models[accountId] != list else { return }
        models[accountId] = list
        saveState()
    }

    func mergeUsage(_ accountId: UUID, windows: [UsageWindow], plan: String?) {
        var s = status[accountId] ?? AccountStatus()
        for w in windows {
            if let i = s.windows.firstIndex(where: { $0.id == w.id || $0.label == w.label }) {
                s.windows[i].percent = w.percent
                if w.resetsAt != nil { s.windows[i].resetsAt = w.resetsAt }
            } else {
                s.windows.append(w)
            }
        }
        if let plan { s.plan = plan }
        s.loggedIn = true
        s.updatedAt = Date()
        status[accountId] = s
    }

    func markExhausted(_ accountId: UUID, until: Date?) {
        var s = status[accountId] ?? AccountStatus()
        s.exhaustedUntil = until ?? Date().addingTimeInterval(15 * 60)
        status[accountId] = s
        refreshUsageSoon(accountId)
    }

    func markNoPlan(_ accountId: UUID) {
        var s = status[accountId] ?? AccountStatus()
        s.noPlan = true
        status[accountId] = s
        saveState()
    }

    func setLoggedOut(_ accountId: UUID) {
        var s = status[accountId] ?? AccountStatus()
        s.loggedIn = false
        status[accountId] = s
    }

    func refreshAllUsage() {
        for a in enabledAccounts { refreshUsage(a.id) }
    }

    func refreshUsage(_ accountId: UUID) {
        guard let account = account(accountId), !refreshing.contains(accountId) else { return }
        refreshing.insert(accountId)
        Task {
            let probe = await UsageService.probe(account)
            var s = probe.status
            if let old = status[accountId], let until = old.exhaustedUntil, until > Date() {
                let freed = !s.windows.isEmpty && s.windows.allSatisfy { $0.percent < 99 }
                if !freed { s.exhaustedUntil = until }
            }
            if s.windows.isEmpty, s.error != nil, let old = status[accountId], s.loggedIn != false {
                s.windows = old.windows
            }
            // A lapsed plan stays flagged until the provider reports quota again.
            if status[accountId]?.noPlan == true, s.noPlan == nil, s.windows.isEmpty, s.loggedIn != false { s.noPlan = true }
            status[accountId] = s
            if let m = probe.models { setModels(accountId, m) }
            refreshing.remove(accountId)
            saveState()
        }
    }

    func refreshUsageSoon(_ accountId: UUID) {
        refreshSoonWork[accountId]?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.refreshUsage(accountId) }
        refreshSoonWork[accountId] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: work)
    }

    func login(_ account: Account) {
        UsageService.login(account, store: self)
    }

    func updateSettings(_ mutate: (inout AppSettings) -> Void) {
        let before = settings.refreshMinutes
        mutate(&settings)
        if before != settings.refreshMinutes { scheduleTimer() }
        saveState()
        if bootstrapped { CompanionServer.shared.settingsChanged() }
    }

    // MARK: - Projects & threads

    @discardableResult
    func addProject(path: String, name: String? = nil) -> Project {
        let standardized = (path as NSString).standardizingPath
        if let existing = projects.first(where: { $0.path == standardized }) { return existing }
        let p = Project(name: name ?? (standardized as NSString).lastPathComponent, path: standardized)
        projects.append(p)
        expandedProjects.insert(p.id)
        saveState()
        return p
    }

    func removeProject(_ project: Project) {
        for t in threads where t.projectId == project.id { deleteThread(t) }
        projects.removeAll { $0.id == project.id }
        saveState()
    }

    @discardableResult
    /// `select: false` creates it without changing what the Mac shows (used by the iPhone companion).
    func newThread(in project: Project? = nil, select: Bool = true) -> ThreadModel? {
        let target = project ?? self.project(selectedThread?.projectId) ?? projects.first
        guard let target else {
            if select { showNewProject = true }
            return nil
        }
        if let empty = threads.first(where: { $0.projectId == target.id && $0.items.isEmpty }) {
            if select { selectedThreadId = empty.id }
            return empty
        }
        let previous = selectedThread
        let accountId = previous?.selectedAccountId ?? preferredAccount()?.id
        let model = previous?.selectedModel ?? account(accountId).map { defaultModel(for: $0) }
        let t = ThreadModel(projectId: target.id, mode: settings.defaultMode, accountId: accountId, model: model)
        threads.insert(t, at: 0)
        expandedProjects.insert(target.id)
        if select { selectedThreadId = t.id }
        save(t)
        saveState()
        return t
    }

    func deleteThread(_ thread: ThreadModel) {
        runtimes[thread.id]?.closeSession()
        runtimes.removeValue(forKey: thread.id)
        trace.deleteThread(thread.id)
        threads.removeAll { $0.id == thread.id }
        try? FileManager.default.removeItem(at: threadsDir.appendingPathComponent("\(thread.id.uuidString).json"))
        if selectedThreadId == thread.id { selectedThreadId = threads.first?.id }
        saveState()
    }

    func select(_ id: UUID?) {
        selectedThreadId = id
        saveState()
    }

    /// Creates AGENTS.md (shared memory read by Codex, ZCode…) and imports it from CLAUDE.md / GEMINI.md.
    func setupSharedMemory(_ project: Project) {
        let fm = FileManager.default
        let agents = "\(project.path)/AGENTS.md"
        if !fm.fileExists(atPath: agents) {
            let body = """
            # \(project.name)

            Memoria compartida del proyecto para todos los agentes (Claude, Codex, Gemini, GLM).
            Anota aquí convenciones, decisiones y el estado del trabajo para que cualquier agente pueda continuar.

            ## Convenciones

            ## Estado actual

            """
            try? body.write(toFile: agents, atomically: true, encoding: .utf8)
        }
        for name in ["CLAUDE.md", "GEMINI.md"] {
            let path = "\(project.path)/\(name)"
            if !fm.fileExists(atPath: path) {
                try? "@AGENTS.md\n".write(toFile: path, atomically: true, encoding: .utf8)
            }
        }
        flash("Memoria compartida lista: AGENTS.md (+ CLAUDE.md y GEMINI.md la importan)")
    }

    // MARK: - Feedback

    func flash(_ message: String) {
        toast = message
        toastWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.toast = nil }
        toastWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: work)
    }

    func notifyApproval(thread: ThreadModel, title: String) {
        guard let app = NSApp, !app.isActive else { return }
        notify(title: "Aprobación pendiente · \(thread.title)", body: title)
    }

    func notifyTurnFinished(thread: ThreadModel) {
        guard let app = NSApp, !app.isActive else { return }
        let last = thread.items.last(where: { $0.kind == .assistant })?.text ?? "Turno terminado"
        notify(title: thread.title, body: String(last.prefix(140)))
    }

    private static var canNotify: Bool { Bundle.main.bundleIdentifier != nil && Bundle.main.bundlePath.hasSuffix(".app") }

    private func notify(title: String, body: String) {
        guard Self.canNotify else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
