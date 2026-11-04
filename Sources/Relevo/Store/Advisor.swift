import Foundation

enum TaskLevel: String, Codable, CaseIterable {
    case trivial, normal, dificil

    var rank: Int { TaskLevel.allCases.firstIndex(of: self)! }

    var label: String {
        switch self {
        case .trivial: return "Tarea sencilla"
        case .normal: return "Tarea normal"
        case .dificil: return "Tarea difícil"
        }
    }
}

struct TaskProfile: Equatable {
    var level: TaskLevel
    var kind: String?
    var byAI: Bool
}

/// A subscription + model + reasoning level for the request being written, and why.
struct Suggestion: Equatable {
    var accountId: UUID
    var model: String
    var effort: String?
    var profile: TaskProfile
    var reasons: [String]
    var score: Double
}

/// One scored option (kept separate so the self-test can print the whole ranking).
struct ScoredOption {
    var account: Account
    var model: ModelOption
    var power: Double
    var effort: String?
    var fit: Double
    var quota: Double
    var learned: Double
    var sticky: Double
    var score: Double
    var quotaReason: String
    var learnedReason: String?
}

/// «Relevo sugiere»: picks the subscription, model and reasoning level that fit the task at the lowest
/// real cost — quota that would otherwise be lost first, pay-per-use last — and learns from the trace
/// which models finished each kind of task without errors or being replaced.
@MainActor
enum Advisor {
    static var catalog: ModelCatalog { ModelCatalog.shared }

    // MARK: - Classification

    static let system = """
    Clasificas peticiones a un agente de programación según su dificultad. Responde SOLO con una línea JSON: \
    {"nivel":"trivial|normal|dificil","tipo":"explicar|editar|refactorizar|depurar|diseñar|otro"}
    trivial: pregunta breve o conceptual, explicar un fragmento concreto, renombrar, una errata, un comando sencillo.
    normal: cambio acotado en uno o pocos ficheros, añadir un test, un bug con causa clara.
    dificil: arquitectura o diseño, refactor amplio, migraciones, bug difícil o intermitente, rendimiento, concurrencia, \
    seguridad, tareas largas de varios pasos.
    """

    /// Classifies with the cheap utility model (the one used for titles). Nil if none is available or it fails.
    static func classify(_ text: String, threadTitle: String?, store: AppStore) async -> TaskProfile? {
        guard let (account, provider) = store.topicProvider() else { return nil }
        var prompt = ""
        if let threadTitle, threadTitle != ThreadModel.untitled { prompt += "Tema del hilo: \(threadTitle)\n" }
        prompt += "Petición:\n" + String(text.prefix(1500))
        guard let raw = await provider.quickCompletion(account: account, system: system, prompt: prompt) else { return nil }
        return parse(raw)
    }

    static func parse(_ raw: String) -> TaskProfile? {
        if let start = raw.firstIndex(of: "{"), let end = raw.lastIndex(of: "}"), start < end,
           let o = JSONUtil.parse(String(raw[start...end])) {
            let nivel = fold(o.str("nivel") ?? "")
            if let level = TaskLevel.allCases.first(where: { nivel.contains($0.rawValue) }) {
                let tipo = o.str("tipo").map { $0.trimmingCharacters(in: .whitespaces) }
                return TaskProfile(level: level, kind: tipo == "otro" || tipo?.isEmpty == true ? nil : tipo, byAI: true)
            }
        }
        let t = fold(raw)
        if let level = TaskLevel.allCases.reversed().first(where: { t.contains($0.rawValue) }) {
            return TaskProfile(level: level, kind: nil, byAI: true)
        }
        return nil
    }

    /// Free, instant offline guess from length, structure and the catalog's hint words.
    static func heuristic(_ text: String) -> TaskProfile {
        let t = fold(text)
        let hints = catalog.hints
        var hard = Double((hints["dificil"] ?? []).filter { t.contains($0) }.count)
        let easy = Double((hints["trivial"] ?? []).filter { t.contains($0) }.count)
        let lines = text.split(separator: "\n").count
        if text.count > 700 { hard += 1 }
        if lines >= 6 { hard += 0.5 }
        let level: TaskLevel
        if hard >= 1.5 || (hard >= 1 && text.count > 250) { level = .dificil }
        else if hard == 0 && (easy >= 1 || text.count < 60) && text.count < 300 { level = .trivial }
        else { level = .normal }
        let kind = catalog.kinds.max { a, b in
            a.value.filter { t.contains($0) }.count < b.value.filter { t.contains($0) }.count
        }.flatMap { k in k.value.contains { t.contains($0) } ? k.key : nil }
        return TaskProfile(level: level, kind: kind, byAI: false)
    }

    static func fold(_ s: String) -> String {
        s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "es")).lowercased()
    }

    // MARK: - Ranking

    /// All usable options, best first.
    static func rank(_ profile: TaskProfile, thread: ThreadModel, store: AppStore) -> [ScoredOption] {
        let stats = store.trace.outcomeStats()
        let current = thread.segments.last
        let ideal = catalog.ideal(profile.level)
        // A switch makes the new model process the whole context again: the longer the thread, the less it pays.
        let context = store.existingRuntime(thread.id)?.context ?? 0
        var options: [ScoredOption] = []
        for account in store.enabledAccounts {
            let status = store.status[account.id]
            guard status?.loggedIn != false, status?.noPlan != true else { continue }
            if account.kind.usesAPIKey, Keychain.get(Keychain.apiKeyName(account.id)) == nil { continue }
            var models = catalog.candidates(account.kind, store.modelsFor(account))
            if models.isEmpty, let fallback = store.modelOption(account, store.defaultModel(for: account)) ?? store.modelsFor(account).first {
                models = [(fallback, 5.5)]   // provider without a model list yet: assume a mid-range default
            }
            for (model, power) in models {
                let windows = account.kind.provider.usageWindows(status?.windows ?? [], model: model)
                guard let (quota, quotaReason) = quotaScore(account: account, status: status, windows: windows, level: profile.level) else { continue }
                let fit = fitScore(power: power, ideal: ideal, level: profile.level)
                if profile.level == .dificil && fit < 0.2 { continue }   // never hand hard work to a light model
                var learned = 0.0
                var learnedReason: String?
                if let s = stats[TraceStore.outcomeKey(account.kind.rawValue, model.id, profile.level.rawValue)], s.total >= 3 {
                    let rate = Double(s.ok) / Double(s.total)
                    learned = (rate - 0.75) * 0.4
                    learnedReason = "resolvió \(s.ok) de \(s.total) tareas parecidas"
                }
                var sticky = 0.0
                if let current {
                    if current.accountId == account.id { sticky += 0.2; if current.model == model.id { sticky += 0.1 } }   // no handoff needed
                    if !(current.accountId == account.id && current.model == model.id), context > 20_000 {
                        sticky -= min(0.25, Double(context) / 2_000_000)
                    }
                } else if thread.selectedAccountId == account.id {
                    sticky += 0.03   // tie-breaker: don't flip between equivalent options
                }
                let score = 0.55 * fit + 0.45 * quota + learned + sticky
                let effort = catalog.effort(for: profile.level, available: store.efforts(for: account, model: model.id))
                options.append(ScoredOption(account: account, model: model, power: power, effort: effort, fit: fit, quota: quota,
                                            learned: learned, sticky: sticky, score: score, quotaReason: quotaReason, learnedReason: learnedReason))
            }
        }
        return options.sorted { $0.score > $1.score }
    }

    /// Too strong wastes quota; too weak risks a bad result (steeper, except for simple tasks).
    static func fitScore(power: Double, ideal: Double, level: TaskLevel) -> Double {
        let d = power - ideal
        return d >= 0 || level == .trivial ? max(0, 1 - abs(d) / 6) : max(0, 1 - (-d) / 3.5)
    }

    /// Free quota only matters when it is scarce: from half the window free on, there's plenty.
    static func headroomValue(_ free: Double) -> Double {
        free >= 0.5 ? 0.85 + 0.15 * (free - 0.5) / 0.5 : 0.85 * free / 0.5
    }

    /// 0…1: how much quota is free for this model, plus a bonus for weekly quota that resets soon and would be lost.
    /// Nil when the model can't be used now (exhausted).
    static func quotaScore(account: Account, status: AccountStatus?, windows: [UsageWindow], level: TaskLevel) -> (Double, String)? {
        if let until = status?.exhaustedUntil, until > Date() { return nil }
        if account.kind.usesAPIKey { return (0.3, "pago por uso: no gasta cuota de tus suscripciones") }
        let now = Date()
        let live = windows.map { w -> UsageWindow in
            var w = w
            if let r = w.resetsAt, r <= now { w.percent = 0 }   // already reset
            return w
        }
        guard !live.isEmpty else { return (0.5, "sin datos de cuota") }
        if live.contains(where: { $0.percent >= 99.5 }) { return nil }
        let tightest = live.max { $0.percent < $1.percent }!
        var score = headroomValue((100 - tightest.percent) / 100)
        // Long windows (they reset in more than 6 h) that reset within 48 h with quota left: use it or lose it.
        var bonus = 0.0
        var losing: UsageWindow?
        for w in live {
            guard let r = w.resetsAt else { continue }
            let hours = r.timeIntervalSince(now) / 3600
            guard hours > 6, hours <= 48 else { continue }
            let b = (100 - w.percent) / 100 * (1 - hours / 48) * 0.35
            if b > bonus { bonus = b; losing = w }
        }
        score += bonus
        let needed = level == .dificil ? 0.3 : 0.15
        if (100 - tightest.percent) / 100 < needed { score *= 0.5 }   // could run out mid-task
        let reason: String
        if let losing, bonus >= 0.03 {
            reason = "le queda un \(Int((100 - losing.percent).rounded())) % de «\(losing.label)» que se reinicia \(Formatters.reset(losing.resetsAt) ?? "pronto")"
        } else {
            reason = "le sobra cuota (\(tightest.label): \(Int((100 - tightest.percent).rounded())) % libre"
                + (Formatters.reset(tightest.resetsAt).map { ", se reinicia \($0)" } ?? "") + ")"
        }
        return (min(1.1, score), reason)
    }

    // MARK: - Suggestion

    /// Best option if it is worth changing the current selection; nil when the current one is already right.
    static func suggest(_ profile: TaskProfile, thread: ThreadModel, store: AppStore) -> Suggestion? {
        let ranked = rank(profile, thread: thread, store: store)
        guard let best = ranked.first else { return nil }
        let selectedAccount = store.account(thread.selectedAccountId) ?? store.preferredAccount()
        let selectedModel = selectedAccount.map { thread.selectedModel ?? store.defaultModel(for: $0) }
        let midThread = !thread.segments.isEmpty
        let current = ranked.first { $0.account.id == selectedAccount?.id && $0.model.id == selectedModel }
        let sameModel = best.account.id == selectedAccount?.id && best.model.id == selectedModel

        if sameModel {
            // Only the reasoning level would change: worth it for clearly easy or clearly hard work.
            guard profile.level != .normal, let effort = best.effort, let account = selectedAccount, let model = selectedModel else { return nil }
            let currentEffort = thread.selectedEffort ?? store.modelOption(account, model)?.defaultEffort
            guard currentEffort != effort else { return nil }
            return makeSuggestion(best, profile: profile, store: store, selected: selectedAccount, current: current, midThread: midThread, onlyEffort: true)
        }
        if let current, best.score - current.score < (midThread ? 0.12 : 0.04) { return nil }
        return makeSuggestion(best, profile: profile, store: store, selected: selectedAccount, current: current, midThread: midThread, onlyEffort: false,
                              context: store.existingRuntime(thread.id)?.context ?? 0)
    }

    private static func makeSuggestion(_ o: ScoredOption, profile: TaskProfile, store: AppStore, selected: Account?, current: ScoredOption?,
                                       midThread: Bool, onlyEffort: Bool, context: Int = 0) -> Suggestion {
        var reasons = [profile.level.label + (profile.kind.map { " (\($0))" } ?? "")]
        if onlyEffort {
            reasons.append(profile.level == .dificil ? "conviene que piense más" : "no hace falta razonar mucho")
        } else {
            reasons.append("\(o.model.name) es \(ModelCatalog.tierLabel(o.power))")
            reasons.append("a \(o.account.name) \(o.quotaReason)")
        }
        if let l = o.learnedReason { reasons.append(l) }
        if current == nil, !onlyEffort, let selected, selected.id != o.account.id, store.status[selected.id]?.isExhausted == true {
            reasons.append("\(selected.name) no tiene cuota ahora")
        }
        if midThread, current?.account.id != o.account.id, !onlyEffort { reasons.append("Relevo le pasará el contexto") }
        if midThread, !onlyEffort, context >= 20_000 {
            let cost = ModelPricing.shared.price(provider: o.account.kind, model: o.model.id, name: o.model.name)
                .map { Double(context) * $0.write / 1_000_000 }
            reasons.append("cambiar ahora re-procesa hasta \(TokenFormat.short(context)) tokens de contexto" + (cost.map { " (≈ \(TokenFormat.usd($0)))" } ?? ""))
        }
        return Suggestion(accountId: o.account.id, model: o.model.id, effort: o.effort, profile: profile, reasons: reasons, score: o.score)
    }
}

/// Per-thread «Relevo sugiere» state: watches the draft, classifies it (heuristic at once, AI after a pause)
/// and offers — or, in automatic mode, applies — the best subscription/model/effort for it.
@Observable
@MainActor
final class Suggester {
    var suggestion: Suggestion?
    /// Set when automatic mode changed the selection, so it can be undone.
    var autoApplied = false

    @ObservationIgnored unowned let thread: ThreadModel
    @ObservationIgnored unowned let store: AppStore
    @ObservationIgnored weak var runtime: ThreadRuntime?
    @ObservationIgnored private var work: DispatchWorkItem?
    @ObservationIgnored private var aiInFlight = false
    @ObservationIgnored private var lastAI: (text: String, profile: TaskProfile)?
    @ObservationIgnored private var lastProfile: (text: String, profile: TaskProfile)?
    @ObservationIgnored private var dismissed = false
    @ObservationIgnored private var previous: (account: UUID?, model: String?, effort: String?)?
    @ObservationIgnored private var appliedSelection: (account: UUID?, model: String?, effort: String?)?
    /// The selection for the next send came from a suggestion (so it is not a sign the last model fell short).
    @ObservationIgnored private(set) var selectionFromSuggestion = false

    init(thread: ThreadModel, store: AppStore) {
        self.thread = thread
        self.store = store
    }

    private var mode: SuggestMode { store.settings.suggestMode }
    private var draft: String { thread.draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    func draftChanged() {
        work?.cancel()
        guard mode != .off, draft.count >= 12 else {
            if !autoApplied { suggestion = nil }
            return
        }
        let w = DispatchWorkItem { [weak self] in self?.evaluate() }
        work = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9, execute: w)
    }

    /// The user changed provider/model/effort by hand.
    func selectionChanged() {
        let now = (thread.selectedAccountId, thread.selectedModel, thread.selectedEffort)
        if let a = appliedSelection, a.account == now.0, a.model == now.1, a.effort == now.2 { return }
        if autoApplied { autoApplied = false; dismissed = true; suggestion = nil; return }
        selectionFromSuggestion = false
        if let p = lastProfile, p.text == draft { show(Advisor.suggest(p.profile, thread: thread, store: store)) }
    }

    private func evaluate() {
        let text = draft
        guard mode != .off, text.count >= 12, runtime?.isRunning != true else { return }
        let reuse = lastAI.flatMap { close($0.text, text) ? $0.profile : nil }
        update(text, reuse ?? Advisor.heuristic(text))
        guard reuse == nil, store.settings.suggestWithAI, text.count >= 30, !aiInFlight else { return }
        aiInFlight = true
        let title = thread.titleSource == .ai ? thread.title : nil
        let store = self.store
        Task { @MainActor [weak self] in
            let profile = await Advisor.classify(text, threadTitle: title, store: store)
            guard let self else { return }
            self.aiInFlight = false
            guard let profile else { return }
            self.lastAI = (text, profile)
            if self.close(text, self.draft) { self.update(self.draft, profile) } else { self.draftChanged() }
        }
    }

    /// Same request, give or take a few words: reuse its classification instead of asking again.
    private func close(_ a: String, _ b: String) -> Bool {
        guard a.prefix(30) == b.prefix(30) else { return false }
        return abs(a.count - b.count) < max(40, a.count / 4)
    }

    private func update(_ text: String, _ profile: TaskProfile) {
        lastProfile = (text, profile)
        guard !dismissed else { return }
        let s = Advisor.suggest(profile, thread: thread, store: store)
        if mode == .auto, let s, runtime?.isRunning != true {
            apply(s, automatic: true)
        } else if !autoApplied {
            show(s)
        }
    }

    private func show(_ s: Suggestion?) {
        if suggestion != s { suggestion = s }
    }

    func accept() {
        guard let s = suggestion else { return }
        apply(s, automatic: false)
        suggestion = nil
    }

    func dismiss() {
        dismissed = true
        suggestion = nil
        autoApplied = false
    }

    func undo() {
        if let p = previous {
            thread.selectedAccountId = p.account
            thread.selectedModel = p.model
            runtime?.setEffort(p.effort)
        }
        selectionFromSuggestion = false
        dismiss()
    }

    private func apply(_ s: Suggestion, automatic: Bool) {
        guard let account = store.account(s.accountId) else { return }
        if !autoApplied { previous = (thread.selectedAccountId, thread.selectedModel, thread.selectedEffort) }
        thread.selectedAccountId = s.accountId
        thread.selectedModel = s.model
        appliedSelection = (s.accountId, s.model, s.effort)
        runtime?.setEffort(s.effort)
        store.updateAccount(account.id) { $0.lastModel = s.model }
        store.save(thread)
        selectionFromSuggestion = true
        if automatic { autoApplied = true; suggestion = s }
    }

    /// Classification of the request being sent (for the trace), then a clean slate for the next draft.
    func didSend(_ text: String) -> TaskProfile? {
        work?.cancel()
        defer {
            suggestion = nil
            autoApplied = false
            dismissed = false
            previous = nil
            appliedSelection = nil
            selectionFromSuggestion = false
        }
        guard mode != .off else { return nil }
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let p = lastProfile, close(p.text, t) { return p.profile }
        if let p = lastAI, close(p.text, t) { return p.profile }
        return Advisor.heuristic(t)
    }
}
