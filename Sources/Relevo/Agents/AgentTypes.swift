import Foundation

struct ApprovalRequest {
    let key: String
    let title: String
    let detail: String
    let options: [ApprovalOption]
    /// The agent already finished its turn; choosing an allow option starts a new one.
    var resumesTurn: Bool = false
    let respond: (String) -> Void
}

struct AgentFailure: LocalizedError {
    /// noPlan: signed in, but the current plan doesn't include this service (expired or lapsed membership).
    enum Kind { case limit, unavailable, auth, noPlan, sessionLost, other }
    var kind: Kind
    var message: String
    var resetsAt: Date? = nil
    var errorDescription: String? { message }
}

enum AgentEvent {
    case sessionStarted(String)
    case textDelta(key: String, text: String)
    case textFinal(key: String, text: String)
    case reasoningDelta(key: String, text: String)
    case reasoningFinal(key: String, text: String)
    case toolStarted(key: String, name: String, title: String, input: String?)
    case toolOutput(key: String, text: String)
    case toolFinished(key: String, status: ToolStatus, output: String?)
    case approval(ApprovalRequest)
    case usage(windows: [UsageWindow], plan: String?)
    case models([ModelOption])
    case plan([PlanStep])
    case status(String?)
    case notice(String)
    case failure(AgentFailure)
    case turnFinished
}

@MainActor
protocol AgentSession: AnyObject {
    var onEvent: ((AgentEvent) -> Void)? { get set }
    func start() throws
    func send(_ text: String)
    func setModel(_ model: String)
    func setMode(_ mode: PermissionMode)
    func setEffort(_ effort: String?)
    func interrupt()
    func close()
}

enum AgentStartError: LocalizedError {
    case binaryNotFound(ProviderKind)

    var errorDescription: String? {
        switch self {
        case .binaryNotFound(let kind): return kind.info.missingBinaryHelp
        }
    }
}

@MainActor
enum AgentFactory {
    static func make(account: Account, cwd: String, model: String, effort: String?, mode: PermissionMode, resumeId: String?) -> AgentSession {
        let session = account.kind.provider.makeSession(account: account, cwd: cwd, model: model, mode: mode, resumeId: resumeId)
        session.setEffort(effort)
        return session
    }
}

enum LimitDetector {
    private static let patterns = [
        "usage limit", "rate limit", "limit reached", "hit your limit", "reached your limit", "limit exceeded",
        "quota", "resource_exhausted", "resource exhausted", "too many requests", "429",
        "out of credits", "insufficient credits", "额度", "限额", "1308", "1310", "1113",
        "weekly limit", "5-hour limit", "session limit", "usagelimitexceeded", "ratelimitexceeded",
        "insufficient balance", "insufficient_balance", "402",
    ]

    static func isLimit(_ text: String) -> Bool {
        let t = text.lowercased()
        return patterns.contains { t.contains($0) }
    }

    static func isAuth(_ text: String) -> Bool {
        let t = text.lowercased()
        return ["not logged in", "login", "log in", "unauthorized", "401", "authentication", "api key is missing", "invalid api key", "oauth", "sign in", "credentials"].contains { t.contains($0) }
    }

    static func isUnavailable(_ text: String) -> Bool {
        let t = text.lowercased()
        return ["at capacity", "overloaded", "server_overloaded", "serveroverloaded", "529", "temporarily unavailable",
                "capacity unavailable", "service unavailable", "503"].contains { t.contains($0) }
    }

    /// Checked before auth: these replies often say "authentication required" although the login is fine.
    static func isNoPlan(_ text: String) -> Bool {
        let t = text.lowercased()
        return ["does not have access", "no active subscription", "subscription has expired", "subscription expired",
                "not included in your plan", "plan does not include", "membership has expired", "membership expired"].contains { t.contains($0) }
    }

    static func classify(_ text: String) -> AgentFailure.Kind {
        if isUnavailable(text) { return .unavailable }
        if isNoPlan(text) { return .noPlan }
        if isLimit(text) { return .limit }
        if isAuth(text) { return .auth }
        return .other
    }
}

enum ToolSummary {
    static func title(name: String, input: JSONObject?) -> String {
        let i = input ?? [:]
        let lower = name.lowercased()
        switch name {
        case "TaskCreate", "TodoWrite":
            if let subject = i.str("subject") ?? i.str("description") { return "Nueva tarea: \(subject)" }
            let todos = i.objs("todos")
            if !todos.isEmpty { return "Plan actualizado (\(todos.filter { $0.str("status") == "completed" }.count)/\(todos.count) hecho)" }
        case "TaskUpdate":
            let id = i.str("taskId") ?? i.str("id") ?? "?"
            let status: String
            switch i.str("status") {
            case "in_progress": status = " → en curso"
            case "completed": status = " → completada"
            case "pending": status = " → pendiente"
            case "deleted": status = " → descartada"
            default: status = ""
            }
            return "Tarea #\(id)\(status)" + (i.str("subject").map { ": \($0)" } ?? "")
        case "TaskList", "TaskGet":
            return "Consultar tareas"
        default:
            break
        }
        if let cmd = i.str("command") ?? i.str("cmd") ?? i.str("CommandLine") { return cmd }
        if let p = i.str("file_path") ?? i.str("path") ?? i.str("filePath") ?? i.str("absolute_path") ?? i.str("TargetFile") ?? i.str("AbsolutePath") ?? i.str("DirectoryPath") ?? i.str("SearchPath") {
            return "\(name) \(abbreviateHome(p))"
        }
        if let pattern = i.str("pattern") ?? i.str("query") ?? i.str("q") ?? i.str("Query") ?? i.str("Pattern") { return "\(name) “\(pattern)”" }
        if let url = i.str("url") ?? i.str("Url") { return "\(name) \(url)" }
        if let d = i.str("description"), lower.contains("task") || lower.contains("agent") { return "\(name): \(d)" }
        if let prompt = i.str("prompt") { return "\(name): \(prompt.prefix(80))" }
        return name
    }

    static func symbol(for name: String?) -> String {
        let n = (name ?? "").lowercased()
        if n.contains("bash") || n.contains("shell") || n.contains("command") || n.contains("exec") || n.contains("terminal") { return "terminal" }
        if n.contains("edit") || n.contains("write") || n.contains("patch") || n.contains("file change") || n.contains("replace") { return "pencil" }
        if n.contains("read") || n.contains("view") || n.contains("cat") { return "doc.text" }
        if n.contains("grep") || n.contains("glob") || n.contains("search") || n.contains("find") || n.contains("list") || n.contains("ls") { return "magnifyingglass" }
        if n.contains("web") || n.contains("fetch") || n.contains("http") { return "globe" }
        if n.contains("task") || n.contains("agent") { return "person.2" }
        if n.contains("todo") || n.contains("plan") { return "checklist" }
        if n.contains("mcp") { return "puzzlepiece.extension" }
        return "wrench.and.screwdriver"
    }

    static func cap(_ s: String, _ limit: Int = 24_000) -> String {
        s.count > limit ? String(s.prefix(limit)) + "\n… (salida truncada)" : s
    }
}
