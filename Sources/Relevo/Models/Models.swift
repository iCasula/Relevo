import Foundation
import SwiftUI
import Observation

struct ModelOption: Codable, Hashable, Identifiable {
    var id: String
    var name: String
    var detail: String? = nil
    /// Reasoning effort levels this model accepts (nil = not configurable).
    var efforts: [String]? = nil
    var defaultEffort: String? = nil
}

struct Account: Codable, Identifiable, Hashable {
    var id = UUID()
    var kind: ProviderKind
    var name: String
    var configDir: String? = nil
    var enabled: Bool = true
    var binaryPath: String? = nil
    var lastModel: String? = nil
}

struct Project: Codable, Identifiable, Hashable {
    var id = UUID()
    var name: String
    var path: String
    var createdAt = Date()
    /// Commands run from the thread toolbar (builds, tests…); optional so older state files still decode.
    var actions: [QuickAction]? = nil

    var quickActions: [QuickAction] { actions ?? [] }
}

/// A thread working in its own git worktree: its own folder and branch, created from the project's branch.
struct WorktreeInfo: Codable, Equatable, Hashable {
    var path: String
    var branch: String
    var baseBranch: String?
    var baseCommit: String
    var createdAt = Date()
}

/// The pull request a thread opened, and whether Relevo watches it for checks, reviews and conflicts.
struct PullRequestInfo: Codable, Equatable, Hashable {
    var number: Int
    var url: String
    var state: String
    var watching = false
    /// What was last seen (checks, comments, reviews, mergeability), to report only what changed.
    var seen: [String]? = nil
}

/// What a turn changed on disk: snapshots of the working folder before and after it.
struct TurnChanges: Codable, Equatable, Hashable {
    var before: String
    var after: String
    var files: Int
    var added: Int
    var removed: Int
}

enum PermissionMode: String, Codable, CaseIterable, Identifiable {
    case ask, autoEdit, full, plan

    var id: String { rawValue }

    var label: String {
        switch self {
        case .ask: return "Pedir permiso"
        case .autoEdit: return "Auto-editar"
        case .full: return "Acceso total"
        case .plan: return "Solo planificar"
        }
    }

    var symbol: String {
        switch self {
        case .ask: return "hand.raised"
        case .autoEdit: return "pencil.line"
        case .full: return "bolt.shield"
        case .plan: return "list.bullet.clipboard"
        }
    }

    var help: String {
        switch self {
        case .ask: return "El agente pide aprobación antes de ejecutar comandos o editar."
        case .autoEdit: return "Edita ficheros del proyecto sin preguntar; pide permiso para comandos."
        case .full: return "Sin confirmaciones. Úsalo solo en proyectos de confianza."
        case .plan: return "Solo lectura: analiza y propone un plan sin tocar nada."
        }
    }
}

enum ToolStatus: String, Codable {
    case running, done, failed
}

struct ApprovalOption: Codable, Hashable, Identifiable {
    var id: String
    var label: String
    var isAllow: Bool
}

/// A question the agent asks (Claude Code's AskUserQuestion): options to pick, or a free answer.
struct AgentQuestion: Codable, Hashable {
    struct Option: Codable, Hashable {
        var label: String
        var description: String?
    }
    var question: String
    var header: String?
    var options: [Option]
    var multiSelect: Bool
}

struct ChatItem: Codable, Identifiable, Equatable {
    enum Kind: String, Codable { case user, assistant, reasoning, tool, notice, error, approval }

    var id: String
    var kind: Kind
    var text: String = ""
    var title: String? = nil
    var output: String? = nil
    var toolName: String? = nil
    var status: ToolStatus? = nil
    var accountId: UUID? = nil
    var model: String? = nil
    var date = Date()
    var options: [ApprovalOption]? = nil
    var resolution: String? = nil
    /// For questions: what the agent asks, and what you answered (question → answer).
    var questions: [AgentQuestion]? = nil
    var answers: [String: String]? = nil
    /// Tokens and cost of the turn this item closes.
    var usage: TurnUsage? = nil
    /// Files the turn this item closes changed.
    var changes: TurnChanges? = nil
}

struct Segment: Codable, Identifiable, Equatable {
    var id = UUID()
    var accountId: UUID
    var kind: ProviderKind
    var model: String
    var nativeSessionId: String? = nil
    var startItem: Int
    var startedAt = Date()
}

/// What a thread does when its agent runs out of quota (or the service isn't available): ask you, move to
/// the subscription with most quota left, move along a list you chose, or wait for the reset and carry on.
struct LimitPlan: Codable, Hashable {
    enum Mode: String, Codable, CaseIterable, Identifiable {
        case ask, mostQuota, chain, wait
        var id: String { rawValue }
        var label: String {
            switch self {
            case .ask: "Avisarme y decidir yo"
            case .mostQuota: "Pasar a la suscripción con más cuota"
            case .chain: "Pasar a las que elija, en orden"
            case .wait: "Esperar a que se reinicie y seguir"
            }
        }
    }
    var mode: Mode
    /// For `.chain`: subscriptions and models to try, in order (one that's also out of quota is skipped;
    /// when none is left the thread waits for the reset).
    var targets: [FallbackTarget] = []

    static let ask = LimitPlan(mode: .ask)
}

struct FallbackTarget: Codable, Hashable, Identifiable {
    var id = UUID()
    var accountId: UUID
    var model: String
}

struct ThreadRecord: Codable {
    var id: UUID
    var projectId: UUID
    var title: String
    var createdAt: Date
    var updatedAt: Date
    var segments: [Segment]
    var items: [ChatItem]
    var mode: PermissionMode
    var selectedAccountId: UUID?
    var selectedModel: String?
    var draft: String?
    var selectedEffort: String?
    var titleSource: TitleSource?
    var topicAttempts: Int?
    var worktree: WorktreeInfo?
    var pullRequest: PullRequestInfo?
    var comparisonId: UUID?
    var limitPlan: LimitPlan?
    var resumeAt: Date?
}

/// Where a thread title comes from: first message (provisional), AI topic, or the user.
enum TitleSource: String, Codable {
    case provisional, ai, manual
}

@Observable
final class ThreadModel: Identifiable {
    let id: UUID
    var projectId: UUID
    var title: String
    var createdAt: Date
    var updatedAt: Date
    var segments: [Segment]
    var items: [ChatItem]
    var mode: PermissionMode
    var selectedAccountId: UUID?
    var selectedModel: String?
    var selectedEffort: String?
    var draft: String
    var titleSource: TitleSource = .provisional
    var topicAttempts = 0
    var worktree: WorktreeInfo?
    var pullRequest: PullRequestInfo?
    /// Set when the thread is one of several agents doing the same task (see `Comparison`).
    var comparisonId: UUID?
    /// What to do when its agent runs out of quota; nil = the default in Settings.
    var limitPlan: LimitPlan?
    /// Waiting for the quota to reset: when to carry on (kept so it survives restarting Relevo).
    var resumeAt: Date?

    static let untitled = "Nuevo hilo"

    init(projectId: UUID, mode: PermissionMode, accountId: UUID?, model: String?) {
        self.id = UUID()
        self.projectId = projectId
        self.title = Self.untitled
        self.createdAt = Date()
        self.updatedAt = Date()
        self.segments = []
        self.items = []
        self.mode = mode
        self.selectedAccountId = accountId
        self.selectedModel = model
        self.draft = ""
    }

    init(record r: ThreadRecord) {
        id = r.id
        projectId = r.projectId
        title = r.title
        createdAt = r.createdAt
        updatedAt = r.updatedAt
        segments = r.segments
        items = r.items
        mode = r.mode
        selectedAccountId = r.selectedAccountId
        selectedModel = r.selectedModel
        selectedEffort = r.selectedEffort
        draft = r.draft ?? ""
        titleSource = r.titleSource ?? .provisional
        topicAttempts = r.topicAttempts ?? 0
        worktree = r.worktree
        pullRequest = r.pullRequest
        comparisonId = r.comparisonId
        limitPlan = r.limitPlan
        resumeAt = r.resumeAt
    }

    var record: ThreadRecord {
        ThreadRecord(id: id, projectId: projectId, title: title, createdAt: createdAt, updatedAt: updatedAt,
                     segments: segments, items: items, mode: mode, selectedAccountId: selectedAccountId,
                     selectedModel: selectedModel, draft: draft.isEmpty ? nil : draft, selectedEffort: selectedEffort,
                     titleSource: titleSource, topicAttempts: topicAttempts, worktree: worktree, pullRequest: pullRequest,
                     comparisonId: comparisonId, limitPlan: limitPlan, resumeAt: resumeAt)
    }

    var lastKind: ProviderKind? { segments.last?.kind }
}

struct UsageWindow: Codable, Hashable, Identifiable {
    var id: String
    var label: String
    var percent: Double
    var resetsAt: Date? = nil
    var detail: String? = nil
}

struct AccountStatus: Codable, Equatable {
    var loggedIn: Bool? = nil
    var plan: String? = nil
    var email: String? = nil
    var windows: [UsageWindow] = []
    var note: String? = nil
    var error: String? = nil
    var updatedAt: Date? = nil
    var exhaustedUntil: Date? = nil
    /// Signed in, but the plan doesn't include the service right now (lapsed membership).
    var noPlan: Bool? = nil

    var maxPercent: Double { windows.map(\.percent).max() ?? 0 }

    /// Can take work right now: signed in, with a plan, and quota left.
    var isUsable: Bool { loggedIn != false && noPlan != true && !isExhausted }

    var isExhausted: Bool {
        if let until = exhaustedUntil, until > Date() { return true }
        return windows.contains { $0.percent >= 99.5 && ($0.resetsAt ?? .distantFuture) > Date() }
    }
}

struct AppSettings: Codable, Equatable {
    /// Older on/off for relaying on a limit; `limitPlan` replaces it (and keeps it in step for older iPhones).
    var autoRelay: Bool = false
    /// Default for threads without their own plan.
    var limitPlan: LimitPlan? = nil
    var defaultMode: PermissionMode = .ask
    var refreshMinutes: Int = 10
    var defaultAccountId: UUID? = nil
    var newProjectsParent: String = "~/Projects"
    /// Name conversations with a cheap AI model.
    var autoTopics: Bool = true
    /// Subscription used for titles (nil = cheapest available).
    var topicAccountId: UUID? = nil
    /// Providers already offered once, so new ones appear automatically but removed ones stay removed.
    var knownProviders: [String]? = nil
    /// «Relevo sugiere»: off, suggest with one click, or apply automatically.
    var suggestMode: SuggestMode = .suggest
    /// Classify the task with the cheap utility model (otherwise an offline heuristic).
    var suggestWithAI: Bool = true
    /// Let a paired iPhone (Relevo Companion) control the app over the network. Off by default.
    var companionEnabled: Bool = false
    var companionPort: Int = 47820
    /// Optional address put in the pairing link for use outside the local network (e.g. a Tailscale IP).
    var companionHost: String? = nil
    /// APNs credentials for the iPhone Live Activity (the .p8 key itself lives in the Keychain).
    var apnsTeamId: String? = nil
    var apnsKeyId: String? = nil
    var companionBundleId: String = "app.relevo.companion"
    /// When Relevo started recording tokens per turn; earlier Claude turns are imported from its transcripts.
    var usageTrackingSince: Date? = nil
    /// Window capture with a global shortcut (⌃⌥⌘C), attached to the draft; off by default.
    var captureEnabled: Bool = false
    /// Also read the window's text and controls through Accessibility.
    var captureIncludeText: Bool = true
    /// MCP server for outside agents, on 127.0.0.1 only; off by default and read-only unless `mcpFullAccess`.
    var mcpEnabled: Bool = false
    var mcpPort: Int = 47821
    var mcpFullAccess: Bool = false

    /// The default plan, from the older switch when it was never set.
    var defaultLimitPlan: LimitPlan { limitPlan ?? LimitPlan(mode: autoRelay ? .mostQuota : .ask) }

    init() {}

    /// Tolerant decoding: settings saved by older versions keep working when fields are added.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = AppSettings()
        autoRelay = (try? c.decodeIfPresent(Bool.self, forKey: .autoRelay)) ?? d.autoRelay
        limitPlan = try? c.decodeIfPresent(LimitPlan.self, forKey: .limitPlan)
        defaultMode = (try? c.decodeIfPresent(PermissionMode.self, forKey: .defaultMode)) ?? d.defaultMode
        refreshMinutes = (try? c.decodeIfPresent(Int.self, forKey: .refreshMinutes)) ?? d.refreshMinutes
        defaultAccountId = try? c.decodeIfPresent(UUID.self, forKey: .defaultAccountId)
        newProjectsParent = (try? c.decodeIfPresent(String.self, forKey: .newProjectsParent)) ?? d.newProjectsParent
        autoTopics = (try? c.decodeIfPresent(Bool.self, forKey: .autoTopics)) ?? d.autoTopics
        topicAccountId = try? c.decodeIfPresent(UUID.self, forKey: .topicAccountId)
        knownProviders = try? c.decodeIfPresent([String].self, forKey: .knownProviders)
        suggestMode = (try? c.decodeIfPresent(SuggestMode.self, forKey: .suggestMode)) ?? d.suggestMode
        suggestWithAI = (try? c.decodeIfPresent(Bool.self, forKey: .suggestWithAI)) ?? d.suggestWithAI
        companionEnabled = (try? c.decodeIfPresent(Bool.self, forKey: .companionEnabled)) ?? d.companionEnabled
        companionPort = (try? c.decodeIfPresent(Int.self, forKey: .companionPort)) ?? d.companionPort
        companionHost = try? c.decodeIfPresent(String.self, forKey: .companionHost)
        apnsTeamId = try? c.decodeIfPresent(String.self, forKey: .apnsTeamId)
        apnsKeyId = try? c.decodeIfPresent(String.self, forKey: .apnsKeyId)
        companionBundleId = (try? c.decodeIfPresent(String.self, forKey: .companionBundleId)) ?? d.companionBundleId
        usageTrackingSince = try? c.decodeIfPresent(Date.self, forKey: .usageTrackingSince)
        captureEnabled = (try? c.decodeIfPresent(Bool.self, forKey: .captureEnabled)) ?? d.captureEnabled
        captureIncludeText = (try? c.decodeIfPresent(Bool.self, forKey: .captureIncludeText)) ?? d.captureIncludeText
        mcpEnabled = (try? c.decodeIfPresent(Bool.self, forKey: .mcpEnabled)) ?? d.mcpEnabled
        mcpPort = (try? c.decodeIfPresent(Int.self, forKey: .mcpPort)) ?? d.mcpPort
        mcpFullAccess = (try? c.decodeIfPresent(Bool.self, forKey: .mcpFullAccess)) ?? d.mcpFullAccess
    }
}

enum SuggestMode: String, Codable, CaseIterable, Identifiable {
    case off, suggest, auto
    var id: String { rawValue }
    var label: String {
        switch self {
        case .off: return "Desactivado"
        case .suggest: return "Sugerir (se acepta con un clic)"
        case .auto: return "Aplicar automáticamente"
        }
    }
}

struct LimitNotice: Equatable {
    var accountId: UUID
    var message: String
    var resetsAt: Date?
    var isCapacity = false
    var isNoPlan = false
}
