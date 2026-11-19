import Foundation

// Data the Mac shares with the companion. These are transfer objects: the Mac maps its own models into them,
// and the iPhone treats them as read-only state.

public enum RemoteMode: String, Codable, CaseIterable, Identifiable, Sendable {
    case ask, autoEdit, full, plan
    public var id: String { rawValue }
}

public struct RemoteWindow: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var label: String
    public var percent: Double
    public var resetsAt: Date?
    public var detail: String?

    public init(id: String, label: String, percent: Double, resetsAt: Date?, detail: String?) {
        self.id = id
        self.label = label
        self.percent = percent
        self.resetsAt = resetsAt
        self.detail = detail
    }
}

public struct RemoteStatus: Codable, Hashable, Sendable {
    public var loggedIn: Bool?
    public var plan: String?
    public var email: String?
    public var windows: [RemoteWindow]
    public var error: String?
    public var note: String?
    public var noPlan: Bool
    public var exhausted: Bool
    public var updatedAt: Date?

    public init(loggedIn: Bool?, plan: String?, email: String?, windows: [RemoteWindow], error: String?, note: String?,
                noPlan: Bool, exhausted: Bool, updatedAt: Date?) {
        self.loggedIn = loggedIn
        self.plan = plan
        self.email = email
        self.windows = windows
        self.error = error
        self.note = note
        self.noPlan = noPlan
        self.exhausted = exhausted
        self.updatedAt = updatedAt
    }

    public var maxPercent: Double { windows.map(\.percent).max() ?? 0 }
    public var isUsable: Bool { loggedIn != false && !noPlan && !exhausted }
}

public struct RemoteModel: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var detail: String?
    public var efforts: [String]?
    public var defaultEffort: String?
    /// Hidden in the Mac's settings: kept for showing its name, left out of pickers.
    public var hidden: Bool?

    public init(id: String, name: String, detail: String?, efforts: [String]?, defaultEffort: String?, hidden: Bool? = nil) {
        self.hidden = hidden
        self.id = id
        self.name = name
        self.detail = detail
        self.efforts = efforts
        self.defaultEffort = defaultEffort
    }
}

/// A subscription (one per provider) with its limits and models.
public struct RemoteAccount: Codable, Hashable, Identifiable, Sendable {
    public var id: UUID
    public var kind: String
    public var name: String
    public var agentName: String
    /// SF Symbol name.
    public var symbol: String
    /// sRGB hex, e.g. "#D97757".
    public var tint: String
    public var usesAPIKey: Bool
    public var status: RemoteStatus?
    public var models: [RemoteModel]
    public var defaultModel: String
    public var refreshing: Bool

    public init(id: UUID, kind: String, name: String, agentName: String, symbol: String, tint: String, usesAPIKey: Bool,
                status: RemoteStatus?, models: [RemoteModel], defaultModel: String, refreshing: Bool) {
        self.id = id
        self.kind = kind
        self.name = name
        self.agentName = agentName
        self.symbol = symbol
        self.tint = tint
        self.usesAPIKey = usesAPIKey
        self.status = status
        self.models = models
        self.defaultModel = defaultModel
        self.refreshing = refreshing
    }
}

public struct RemoteProject: Codable, Hashable, Identifiable, Sendable {
    public var id: UUID
    public var name: String
    public var path: String

    public init(id: UUID, name: String, path: String) {
        self.id = id
        self.name = name
        self.path = path
    }
}

public struct RemoteThreadSummary: Codable, Hashable, Identifiable, Sendable {
    public var id: UUID
    public var projectId: UUID
    public var title: String
    public var updatedAt: Date
    public var isRunning: Bool
    public var needsApproval: Bool
    /// Subscription of the latest segment (who answered last).
    public var accountId: UUID?
    public var preview: String?
    /// Waiting for background tasks it left running (not working). Older Macs don't send it.
    public var isWaiting: Bool?
    /// Its place in a team of agents (Relevo hosts only).
    public var team: RemoteTeamRef?
    /// Something in it waits for you: the orchestrator talking to you, a question… (Relevo hosts only).
    public var attention: RemoteAttention?

    public init(id: UUID, projectId: UUID, title: String, updatedAt: Date, isRunning: Bool, needsApproval: Bool,
                accountId: UUID?, preview: String?, isWaiting: Bool? = nil, team: RemoteTeamRef? = nil, attention: RemoteAttention? = nil) {
        self.isWaiting = isWaiting
        self.team = team
        self.attention = attention
        self.id = id
        self.projectId = projectId
        self.title = title
        self.updatedAt = updatedAt
        self.isRunning = isRunning
        self.needsApproval = needsApproval
        self.accountId = accountId
        self.preview = preview
    }
}

// MARK: - Teams of agents (sent by Relevo hosts; the Mac app has none)

public enum RemoteTeamRole: String, Codable, Hashable, Sendable {
    case orchestrator, executor, researcher, relevo, team
    public init(from decoder: Decoder) throws {
        self = RemoteTeamRole(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .team
    }
    public var label: String {
        switch self {
        case .orchestrator: "Orquestador"
        case .executor: "Ejecutor"
        case .researcher: "Investigador"
        case .relevo: "Relevo"
        case .team: "Equipo"
        }
    }
    /// SF Symbol.
    public var symbol: String {
        switch self {
        case .orchestrator: "crown.fill"
        case .executor: "wrench.and.screwdriver"
        case .researcher: "globe"
        case .relevo: "arrow.triangle.2.circlepath"
        case .team: "person.3"
        }
    }
}

/// A thread's place in a team.
public struct RemoteTeamRef: Codable, Hashable, Sendable {
    public var id: String
    public var role: RemoteTeamRole
    public var name: String
}

/// Why a thread wants you to look at it.
public struct RemoteAttention: Codable, Hashable, Sendable {
    public var kind: String
    public var text: String?
    public var at: Date?
}

/// Who sent a message that arrived in a thread: another agent of its team, or Relevo.
public struct RemoteSender: Codable, Hashable, Sendable {
    public var name: String
    public var role: RemoteTeamRole
    /// What kind of message: informe, pregunta, tarea, respuesta…
    public var label: String?
    /// The sender's thread.
    public var threadId: UUID?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        role = (try? c.decode(RemoteTeamRole.self, forKey: .role)) ?? .team
        label = try? c.decodeIfPresent(String.self, forKey: .label)
        threadId = (try? c.decodeIfPresent(String.self, forKey: .threadId)).flatMap { UUID(uuidString: $0) }
    }
}

public struct RemoteTeamMember: Codable, Hashable, Identifiable, Sendable {
    public struct Task: Codable, Hashable, Sendable {
        public var text: String?
        /// en curso, hecha, bloqueado, esperando…
        public var state: String?
        public var since: Date?
    }
    public var threadId: UUID
    public var role: RemoteTeamRole
    public var name: String
    public var notes: String?
    public var accountId: UUID?
    public var model: String?
    public var task: Task?
    /// Messages kept for it until its next task.
    public var stash: Int?
    /// What it spent today.
    public var today: RemoteSpend?
    public var id: UUID { threadId }
}

public struct RemoteTeamDecision: Codable, Hashable, Identifiable, Sendable {
    public var id: Int
    public var text: String
    /// The orchestrator's name, or "usuario".
    public var by: String?
    public var at: Date?
}

public struct RemoteTeamMilestone: Codable, Hashable, Identifiable, Sendable {
    public var id: Int
    public var text: String
    public var done: Bool
    public var doneAt: Date?
}

public struct RemoteTeamFinding: Codable, Hashable, Identifiable, Sendable {
    public var id: Int
    public var topic: String
    public var summary: String
    public var links: [String]?
    public var by: String?
    public var at: Date?
}

public struct RemoteHeldMessage: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var to: String
    public var from: String
    public var label: String?
    public var text: String
    public var at: Date?
}

/// Tokens and cost of an agent's turns today.
public struct RemoteSpend: Codable, Hashable, Sendable {
    public var tokens: Int
    public var cost: Double?
    public var estimated: Bool?
}

public struct RemoteTeam: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var projectId: UUID
    public var goal: String
    /// active, paused…
    public var status: String
    /// Messages between agents held while paused.
    public var held: Int?
    public var members: [RemoteTeamMember]
    /// What the team decided (Relevo reminds every agent of it).
    public var decisions: [RemoteTeamDecision]?
    /// The goal's steps, in order.
    public var milestones: [RemoteTeamMilestone]?
    /// The researcher's reports, kept.
    public var findings: [RemoteTeamFinding]?
    /// Messages between agents held while the team was paused, for you to send or drop.
    public var heldList: [RemoteHeldMessage]?

    public var milestonesDone: Int { milestones?.filter(\.done).count ?? 0 }
    public var currentMilestone: RemoteTeamMilestone? { milestones?.first { !$0.done } }

    public var isPaused: Bool { status == "paused" }
    public var lead: RemoteTeamMember? { members.first { $0.role == .orchestrator } }
}

/// Everything except thread transcripts: sent on connect and whenever it changes.
public struct RemoteSnapshot: Codable, Hashable, Sendable {
    public var macName: String
    public var accounts: [RemoteAccount]
    public var projects: [RemoteProject]
    public var threads: [RemoteThreadSummary]
    public var autoRelay: Bool
    /// The Mac can update the Live Activity through APNs while the app is closed.
    public var pushReady: Bool?
    /// Teams of agents (Relevo hosts only).
    public var hostTeams: [RemoteTeam]?

    public init(macName: String, accounts: [RemoteAccount], projects: [RemoteProject], threads: [RemoteThreadSummary], autoRelay: Bool,
                pushReady: Bool?, hostTeams: [RemoteTeam]? = nil) {
        self.hostTeams = hostTeams
        self.macName = macName
        self.accounts = accounts
        self.projects = projects
        self.threads = threads
        self.autoRelay = autoRelay
        self.pushReady = pushReady
    }
}

extension RemoteSnapshot {
    /// Teams are extra: if they don't decode (a newer host), the rest of the snapshot still does.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        macName = try c.decode(String.self, forKey: .macName)
        accounts = try c.decode([RemoteAccount].self, forKey: .accounts)
        projects = try c.decode([RemoteProject].self, forKey: .projects)
        threads = try c.decode([RemoteThreadSummary].self, forKey: .threads)
        autoRelay = try c.decode(Bool.self, forKey: .autoRelay)
        pushReady = try c.decodeIfPresent(Bool.self, forKey: .pushReady)
        hostTeams = try? c.decodeIfPresent([RemoteTeam].self, forKey: .hostTeams)
    }
}

public struct RemoteOption: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var label: String
    public var isAllow: Bool

    public init(id: String, label: String, isAllow: Bool) {
        self.id = id
        self.label = label
        self.isAllow = isAllow
    }
}

/// A question the agent asks: pick option(s) or answer freely.
public struct RemoteQuestion: Codable, Hashable, Sendable {
    public struct Option: Codable, Hashable, Sendable {
        public var label: String
        public var description: String?
        public init(label: String, description: String?) {
            self.label = label
            self.description = description
        }
    }
    public var question: String
    public var header: String?
    public var options: [Option]
    public var multiSelect: Bool

    public init(question: String, header: String?, options: [Option], multiSelect: Bool) {
        self.question = question
        self.header = header
        self.options = options
        self.multiSelect = multiSelect
    }
}

/// One entry of a transcript (message, reasoning, tool call, notice, error or permission request).
public struct RemoteItem: Codable, Hashable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable { case user, assistant, reasoning, tool, notice, error, approval }
    public enum ToolState: String, Codable, Sendable { case running, done, failed }

    public var id: String
    public var kind: Kind
    public var text: String
    public var title: String?
    public var output: String?
    public var toolName: String?
    public var toolState: ToolState?
    public var accountId: UUID?
    public var model: String?
    public var date: Date
    public var options: [RemoteOption]?
    public var resolution: String?
    /// The agent's questions (kind approval) and your answers (question → answer).
    public var questions: [RemoteQuestion]?
    public var answers: [String: String]?
    /// Tokens and cost of the turn this item closes.
    public var usage: RemoteTurnUsage?
    /// A message from another agent of the team (or Relevo) instead of you (Relevo hosts only).
    public var from: RemoteSender?

    public init(id: String, kind: Kind, text: String, title: String?, output: String?, toolName: String?, toolState: ToolState?,
                accountId: UUID?, model: String?, date: Date, options: [RemoteOption]?, resolution: String?,
                questions: [RemoteQuestion]? = nil, answers: [String: String]? = nil, usage: RemoteTurnUsage? = nil) {
        self.questions = questions
        self.answers = answers
        self.usage = usage
        self.id = id
        self.kind = kind
        self.text = text
        self.title = title
        self.output = output
        self.toolName = toolName
        self.toolState = toolState
        self.accountId = accountId
        self.model = model
        self.date = date
        self.options = options
        self.resolution = resolution
    }
}

/// What one turn consumed: tokens, share read from cache, cost (an API equivalent for subscriptions), and
/// what a model or provider switch made it process again.
public struct RemoteTurnUsage: Codable, Hashable, Sendable {
    public var tokens: Int
    public var cacheShare: Double?
    public var cost: Double?
    public var costEstimated: Bool
    public var paid: Bool
    public var switchLabel: String?
    public var switchDetail: String?
    public var overhead: Int?
    public var overheadCost: Double?
    public var context: Int?
    public var contextWindow: Int?

    public init(tokens: Int, cacheShare: Double?, cost: Double?, costEstimated: Bool, paid: Bool, switchLabel: String?, switchDetail: String?,
                overhead: Int?, overheadCost: Double?, context: Int?, contextWindow: Int?) {
        self.tokens = tokens
        self.cacheShare = cacheShare
        self.cost = cost
        self.costEstimated = costEstimated
        self.paid = paid
        self.switchLabel = switchLabel
        self.switchDetail = switchDetail
        self.overhead = overhead
        self.overheadCost = overheadCost
        self.context = context
        self.contextWindow = contextWindow
    }
}

public struct RemoteLimit: Codable, Hashable, Sendable {
    public var accountId: UUID
    public var message: String
    public var resetsAt: Date?
    public var isCapacity: Bool
    public var isNoPlan: Bool

    public init(accountId: UUID, message: String, resetsAt: Date?, isCapacity: Bool, isNoPlan: Bool) {
        self.accountId = accountId
        self.message = message
        self.resetsAt = resetsAt
        self.isCapacity = isCapacity
        self.isNoPlan = isNoPlan
    }
}

public struct RemoteSuggestion: Codable, Hashable, Sendable {
    public var accountId: UUID
    public var model: String
    public var effort: String?
    public var reasons: [String]
    public var autoApplied: Bool
    public var byAI: Bool

    public init(accountId: UUID, model: String, effort: String?, reasons: [String], autoApplied: Bool, byAI: Bool) {
        self.accountId = accountId
        self.model = model
        self.effort = effort
        self.reasons = reasons
        self.autoApplied = autoApplied
        self.byAI = byAI
    }
}

public struct RemoteCandidate: Codable, Hashable, Sendable {
    public var accountId: UUID
    public var model: String

    public init(accountId: UUID, model: String) {
        self.accountId = accountId
        self.model = model
    }
}

/// A message waiting for the current turn to finish.
public struct RemoteQueuedMessage: Codable, Hashable, Identifiable, Sendable {
    public var id: UUID
    public var text: String

    public init(id: UUID, text: String) {
        self.id = id
        self.text = text
    }
}

/// Live state of a thread on the Mac: the agent, the banner, the suggestion and the composer selection.
public struct RemoteRuntime: Codable, Hashable, Sendable {
    /// The host can wait for this model's quota and carry on there (the «Esperar aquí» option).
    public var canWait: Bool?
    /// Waiting with no known reset time: the host checks every few minutes.
    public var resumeUnknown: Bool?
    public var isRunning: Bool
    public var statusLine: String?
    public var limit: RemoteLimit?
    public var suggestion: RemoteSuggestion?
    public var mode: RemoteMode
    public var selectedAccountId: UUID?
    public var selectedModel: String?
    public var selectedEffort: String?
    /// Other subscriptions with quota left, best first (for handoffs).
    public var relayCandidates: [RemoteCandidate]
    /// Messages sent while the agent works; they go out one per finished turn.
    public var queued: [RemoteQueuedMessage]?
    /// The queue stopped because the last turn failed, hit a limit or was stopped.
    public var queuePaused: Bool?
    /// Quota windows the selected model consumes (already filtered per model family by the Mac).
    public var usage: [RemoteWindow]?
    /// Pay-per-use balance or other note when there are no windows (e.g. "Saldo: 28,52 USD").
    public var usageNote: String?
    /// What the agent left running after its turn (tests, a build…): it isn't working, it's waiting,
    /// and picks up on its own when they finish. Older Macs don't send it.
    public var backgroundTasks: [RemoteBackgroundTask]?
    /// The thread's own plan for running out of quota (nil = the Mac's default, described in `defaultLimitPlan`).
    public var limitPlan: RemoteLimitPlan?
    public var defaultLimitPlan: RemoteLimitPlan?
    /// Out of quota and about to move to another subscription at `at` (can be stopped).
    public var pendingRelay: RemotePendingRelay?
    /// Waiting for the quota to reset; the same agent carries on at this time.
    public var resumeAt: Date?

    public init(isRunning: Bool, statusLine: String?, limit: RemoteLimit?, suggestion: RemoteSuggestion?, mode: RemoteMode,
                selectedAccountId: UUID?, selectedModel: String?, selectedEffort: String?, relayCandidates: [RemoteCandidate],
                queued: [RemoteQueuedMessage]? = nil, queuePaused: Bool? = nil, usage: [RemoteWindow]? = nil, usageNote: String? = nil,
                backgroundTasks: [RemoteBackgroundTask]? = nil, limitPlan: RemoteLimitPlan? = nil, defaultLimitPlan: RemoteLimitPlan? = nil,
                pendingRelay: RemotePendingRelay? = nil, resumeAt: Date? = nil, canWait: Bool? = nil, resumeUnknown: Bool? = nil) {
        self.canWait = canWait
        self.resumeUnknown = resumeUnknown
        self.backgroundTasks = backgroundTasks
        self.limitPlan = limitPlan
        self.defaultLimitPlan = defaultLimitPlan
        self.pendingRelay = pendingRelay
        self.resumeAt = resumeAt
        self.queued = queued
        self.queuePaused = queuePaused
        self.usage = usage
        self.usageNote = usageNote
        self.isRunning = isRunning
        self.statusLine = statusLine
        self.limit = limit
        self.suggestion = suggestion
        self.mode = mode
        self.selectedAccountId = selectedAccountId
        self.selectedModel = selectedModel
        self.selectedEffort = selectedEffort
        self.relayCandidates = relayCandidates
    }
}

/// What a thread does when its agent runs out of quota: `ask`, `mostQuota`, `chain` (through `targets` in
/// order) or `wait` (for the reset, then the same agent carries on).
public struct RemoteLimitPlan: Codable, Hashable, Sendable {
    public var mode: String
    public var targets: [RemoteCandidate]
    /// Described by the Mac ("Codex · GPT-6-Astra, luego …").
    public var summary: String?

    public init(mode: String, targets: [RemoteCandidate] = [], summary: String? = nil) {
        self.mode = mode
        self.targets = targets
        self.summary = summary
    }
}

public struct RemotePendingRelay: Codable, Hashable, Sendable {
    public var accountId: UUID
    public var model: String
    public var at: Date

    public init(accountId: UUID, model: String, at: Date) {
        self.accountId = accountId
        self.model = model
        self.at = at
    }
}

/// A command or agent the CLI keeps running in the background after its turn.
public struct RemoteBackgroundTask: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var description: String
    public var startedAt: Date

    public init(id: String, description: String, startedAt: Date) {
        self.id = id
        self.description = description
        self.startedAt = startedAt
    }
}

/// The transcript tail of a thread plus its live state.
public struct RemoteThread: Codable, Hashable, Sendable {
    public var id: UUID
    public var title: String
    public var items: [RemoteItem]
    /// Items in the whole thread (the transcript may be truncated to the newest ones).
    public var totalItems: Int
    public var runtime: RemoteRuntime

    public init(id: UUID, title: String, items: [RemoteItem], totalItems: Int, runtime: RemoteRuntime) {
        self.id = id
        self.title = title
        self.items = items
        self.totalItems = totalItems
        self.runtime = runtime
    }
}

/// Incremental update of the subscribed thread: new or changed items (in transcript order) and the live state.
public struct RemoteThreadPatch: Codable, Hashable, Sendable {
    public var id: UUID
    public var title: String
    public var upserts: [RemoteItem]
    public var totalItems: Int
    public var runtime: RemoteRuntime

    public init(id: UUID, title: String, upserts: [RemoteItem], totalItems: Int, runtime: RemoteRuntime) {
        self.id = id
        self.title = title
        self.upserts = upserts
        self.totalItems = totalItems
        self.runtime = runtime
    }
}
