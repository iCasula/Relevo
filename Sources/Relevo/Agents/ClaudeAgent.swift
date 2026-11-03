import Foundation

/// Claude Code via `claude -p --input-format stream-json --output-format stream-json`
/// using the subscription login stored by Claude Code itself.
@MainActor
final class ClaudeAgent: AgentSession {
    var onEvent: ((AgentEvent) -> Void)?

    private let account: Account
    private let cwd: String
    private var model: String
    private var mode: PermissionMode
    private var resumeId: String?
    private var effort: String?
    private var restartAfterTurn = false
    private var todoSteps: [PlanStep] = []
    private var taskOrder: [String] = []
    private var tasks: [String: PlanStep] = [:]
    private var pendingTaskSubjects: [String: String] = [:]
    private var proc: LineProcess?
    private var sessionId: String?
    private var currentMessageId: String?
    private var streamedMessages = Set<String>()
    private var pendingControl: [String: (JSONObject?, String?) -> Void] = [:]
    private var controlCounter = 0
    private var turnActive = false
    private var pendingLimit: AgentFailure?
    private var closed = false
    private var gotOutput = false

    init(account: Account, cwd: String, model: String, mode: PermissionMode, resumeId: String?) {
        self.account = account
        self.cwd = cwd
        self.model = model
        self.mode = mode
        self.resumeId = resumeId
    }

    static func cliMode(_ mode: PermissionMode) -> String {
        switch mode {
        case .ask: return "manual"
        case .autoEdit: return "acceptEdits"
        case .full: return "bypassPermissions"
        case .plan: return "plan"
        }
    }

    func start() throws {
        guard let launch = Binaries.launch(for: account) else { throw AgentStartError.binaryNotFound(.claude) }
        var args = launch.prefixArgs + [
            "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--include-partial-messages", "--permission-prompt-tool", "stdio",
            "--permission-mode", Self.cliMode(mode),
        ]
        // Only makes bypassPermissions *available*: without it, switching to full access mid-session is
        // rejected ("session was not launched with --dangerously-skip-permissions"). The active mode is --permission-mode.
        args.append("--allow-dangerously-skip-permissions")
        if !model.isEmpty && model != "default" { args += ["--model", model] }
        if let effort, !effort.isEmpty { args += ["--effort", effort] }
        if let resumeId { args += ["--resume", resumeId] }
        var env = launch.environment
        // Headless Claude Code hides its task tools unless asked; they give Relevo the agent's live plan.
        env["CLAUDE_CODE_ENABLE_TODO_TOOLS"] = env["CLAUDE_CODE_ENABLE_TODO_TOOLS"] ?? "1"
        let p = LineProcess(executable: launch.executable, arguments: args, cwd: cwd, environment: env)
        p.onLine = { [weak self] line in self?.handle(line) }
        p.onExit = { [weak self, weak p] code in
            guard let self, let p, p === self.proc else { return }
            self.exited(code)
        }
        try p.start()
        proc = p
        control(["subtype": "initialize"]) { _, _ in }
    }

    var isAlive: Bool { proc != nil && !closed }

    func send(_ text: String) {
        turnActive = true
        pendingLimit = nil
        onEvent?(.status("Claude está trabajando…"))
        proc?.write(json: [
            "type": "user",
            "message": ["role": "user", "content": [["type": "text", "text": text]]],
        ])
    }

    func setModel(_ model: String) {
        self.model = model
        control(["subtype": "set_model", "model": model == "default" ? NSNull() : model]) { _, _ in }
    }

    func setMode(_ mode: PermissionMode) {
        self.mode = mode
        control(["subtype": "set_permission_mode", "mode": Self.cliMode(mode)]) { [weak self] _, error in
            guard let self, error != nil, self.proc != nil, self.sessionId != nil else { return }
            // The CLI refused the live switch: relaunch resuming the same session with the new mode.
            if self.turnActive {
                self.restartAfterTurn = true
                self.onEvent?(.notice("El modo «\(mode.label)» se aplicará al terminar este turno"))
            } else {
                self.restartResuming()
            }
        }
    }

    /// Effort is a launch flag: changing it restarts the CLI resuming the same session.
    func setEffort(_ effort: String?) {
        let changed = effort != self.effort
        self.effort = effort
        guard changed, proc != nil, sessionId != nil else { return }
        if turnActive { restartAfterTurn = true } else { restartResuming() }
    }

    private func restartResuming() {
        guard let sid = sessionId else { return }
        restartAfterTurn = false
        let old = proc
        proc = nil
        old?.closeInput()
        old?.terminate()
        resumeId = sid
        pendingControl.removeAll()
        do { try start() } catch {
            onEvent?(.failure(AgentFailure(kind: .other, message: error.localizedDescription)))
        }
    }

    func interrupt() {
        control(["subtype": "interrupt"]) { _, _ in }
    }

    func close() {
        closed = true
        proc?.closeInput()
        proc?.terminate()
        proc = nil
    }

    func refreshUsage() {
        control(["subtype": "get_usage"]) { [weak self] response, _ in
            guard let response else { return }
            let parsed = ClaudeUsage.parse(response)
            self?.onEvent?(.usage(windows: parsed.windows, plan: parsed.plan))
        }
    }

    // MARK: - Control protocol

    private func control(_ request: JSONObject, _ done: @escaping (JSONObject?, String?) -> Void) {
        controlCounter += 1
        let id = "relevo-\(controlCounter)"
        pendingControl[id] = done
        proc?.write(json: ["type": "control_request", "request_id": id, "request": request])
    }

    private func respondControl(_ requestId: String, _ response: JSONObject) {
        proc?.write(json: ["type": "control_response", "response": ["subtype": "success", "request_id": requestId, "response": response]])
    }

    // MARK: - Output handling

    private func handle(_ line: String) {
        guard let o = JSONUtil.parse(line), let type = o.str("type") else { return }
        gotOutput = true
        let isSubagent = o.has("parent_tool_use_id")
        switch type {
        case "system":
            if o.str("subtype") == "init", let sid = o.str("session_id") {
                sessionId = sid
                onEvent?(.sessionStarted(sid))
            } else if o.str("subtype") == "api_retry" {
                onEvent?(.status("Reintentando la llamada a la API…"))
            } else if o.str("subtype") == "compact_boundary" {
                onEvent?(.notice("Claude ha compactado el contexto"))
            }
        case "stream_event":
            guard !isSubagent, let ev = o.obj("event") else { return }
            switch ev.str("type") {
            case "message_start":
                currentMessageId = ev.obj("message")?.str("id")
            case "content_block_delta":
                let idx = ev.int("index") ?? 0
                let mid = currentMessageId ?? "m"
                guard let delta = ev.obj("delta") else { return }
                if delta.str("type") == "text_delta", let t = delta.str("text") {
                    streamedMessages.insert(mid)
                    onEvent?(.textDelta(key: "\(mid):\(idx)", text: t))
                } else if delta.str("type") == "thinking_delta", let t = delta.str("thinking"), !t.isEmpty {
                    onEvent?(.reasoningDelta(key: "\(mid):\(idx)", text: t))
                }
            default:
                break
            }
        case "assistant":
            guard let message = o.obj("message") else { return }
            let mid = message.str("id") ?? UUID().uuidString
            for (i, block) in message.objs("content").enumerated() {
                switch block.str("type") {
                case "text":
                    if isSubagent { continue }
                    if !streamedMessages.contains(mid), let t = block.str("text"), !t.isEmpty {
                        onEvent?(.textFinal(key: "\(mid):final\(i)", text: t))
                    }
                case "tool_use":
                    let id = block.str("id") ?? UUID().uuidString
                    let name = block.str("name") ?? "Herramienta"
                    let input = block.obj("input")
                    let title = isSubagent ? "↳ " + ToolSummary.title(name: name, input: input) : ToolSummary.title(name: name, input: input)
                    onEvent?(.toolStarted(key: id, name: name, title: title, input: input.map { JSONUtil.text($0) }))
                    if !isSubagent { trackPlan(tool: name, id: id, input: input ?? [:]) }
                default:
                    break
                }
            }
        case "user":
            guard let message = o.obj("message") else { return }
            for block in message.objs("content") where block.str("type") == "tool_result" {
                guard let id = block.str("tool_use_id") else { continue }
                let output = JSONUtil.flattenContent(block["content"])
                let failed = block.bool("is_error") ?? false
                onEvent?(.toolFinished(key: id, status: failed ? .failed : .done, output: ToolSummary.cap(output)))
                if let subject = pendingTaskSubjects.removeValue(forKey: id), !failed,
                   let match = output.range(of: #"#(\d+)"#, options: .regularExpression) {
                    let taskId = String(output[match].dropFirst())
                    tasks[taskId] = PlanStep(text: subject, status: "pending")
                    taskOrder.append(taskId)
                    emitTaskPlan()
                }
            }
        case "result":
            turnActive = false
            let isError = o.bool("is_error") ?? false
            let subtype = o.str("subtype") ?? "success"
            if isError || subtype != "success" {
                var text = o.str("result") ?? ""
                if text.isEmpty { text = o.strs("errors").joined(separator: "\n") }
                if text.isEmpty { text = "La ejecución terminó con error (\(subtype))." }
                var failure = AgentFailure(kind: LimitDetector.classify(text), message: text)
                if let pending = pendingLimit, failure.kind != .auth {
                    failure.kind = .limit
                    failure.resetsAt = pending.resetsAt
                }
                onEvent?(.failure(failure))
            } else if let limit = pendingLimit {
                onEvent?(.failure(limit))
            }
            pendingLimit = nil
            onEvent?(.turnFinished)
            refreshUsage()
            if restartAfterTurn { restartResuming() }
        case "rate_limit_event":
            guard let info = o.obj("rate_limit_info") else { return }
            var windows: [UsageWindow] = []
            if let unified = info.obj("unifiedWindows") {
                for (key, value) in unified {
                    guard let w = value as? JSONObject, let util = w.num("utilization") else { continue }
                    windows.append(UsageWindow(id: key, label: ClaudeUsage.label(forWindow: key), percent: util * 100, resetsAt: DateParse.any(w["resetsAt"])))
                }
            }
            if !windows.isEmpty { onEvent?(.usage(windows: windows.sorted { $0.id < $1.id }, plan: nil)) }
            if info.str("status") == "rejected" {
                let type = info.str("rateLimitType").map(ClaudeUsage.label(forWindow:)) ?? "uso"
                pendingLimit = AgentFailure(kind: .limit, message: "Has alcanzado el límite de \(type) de Claude.", resetsAt: DateParse.any(info["resetsAt"]))
            }
        case "control_request":
            handleControlRequest(o)
        case "control_response":
            guard let resp = o.obj("response"), let rid = resp.str("request_id"), let cb = pendingControl.removeValue(forKey: rid) else { return }
            if resp.str("subtype") == "error" {
                cb(nil, resp.str("error") ?? "error")
            } else {
                cb(resp.obj("response"), nil)
            }
        default:
            break
        }
    }

    /// Claude Code keeps its plan in TodoWrite (classic) or TaskCreate/TaskUpdate (tasks).
    private func trackPlan(tool: String, id: String, input: JSONObject) {
        switch tool {
        case "TodoWrite":
            todoSteps = input.objs("todos").compactMap { t in
                guard let content = t.str("content") ?? t.str("subject") else { return nil }
                return PlanStep(text: content, status: t.str("status") ?? "pending")
            }
            if !todoSteps.isEmpty { onEvent?(.plan(todoSteps)) }
        case "TaskCreate":
            if let subject = input.str("subject") ?? input.str("description") { pendingTaskSubjects[id] = subject }
        case "TaskUpdate":
            guard let taskId = input.str("taskId") ?? input.str("id") else { return }
            var step = tasks[taskId] ?? PlanStep(text: input.str("subject") ?? "Tarea #\(taskId)", status: "pending")
            if let status = input.str("status") { step.status = status == "deleted" ? "completed" : status }
            if let subject = input.str("subject") { step.text = subject }
            if tasks[taskId] == nil { taskOrder.append(taskId) }
            tasks[taskId] = step
            emitTaskPlan()
        default:
            break
        }
    }

    /// AskUserQuestion: show the questions and return the answers the way Claude Code expects
    /// (`updatedInput.answers = { question: answer }`), or decline if you skip them.
    private func askQuestions(requestId rid: String, input: JSONObject, key: String) {
        let questions: [AgentQuestion] = input.objs("questions").map { q in
            AgentQuestion(question: q.str("question") ?? "", header: q.str("header"),
                          options: q.objs("options").map { AgentQuestion.Option(label: $0.str("label") ?? "", description: $0.str("description")) },
                          multiSelect: q.bool("multiSelect") ?? false)
        }
        let request = ApprovalRequest(
            key: key,
            title: questions.count == 1 ? questions[0].question : "\(questions.count) preguntas del agente",
            detail: "",
            options: [ApprovalOption(id: "deny", label: "Omitir", isAllow: false)],
            questions: questions
        ) { [weak self] choice in
            guard let self else { return }
            if let answers = ApprovalRequest.decodeAnswers(choice) {
                var updated = input
                updated["answers"] = answers
                self.respondControl(rid, ["behavior": "allow", "updatedInput": updated])
            } else {
                self.respondControl(rid, ["behavior": "deny", "message": "El usuario ha preferido no responder a las preguntas."])
            }
        }
        onEvent?(.approval(request))
    }

    private func emitTaskPlan() {
        let steps = taskOrder.compactMap { tasks[$0] }
        if !steps.isEmpty { onEvent?(.plan(steps)) }
    }

    private func handleControlRequest(_ o: JSONObject) {
        guard let rid = o.str("request_id"), let req = o.obj("request") else { return }
        guard req.str("subtype") == "can_use_tool" else {
            proc?.write(json: ["type": "control_response", "response": ["subtype": "error", "request_id": rid, "error": "No soportado por Relevo"]])
            return
        }
        let toolName = req.str("tool_name") ?? "Herramienta"
        let display = req.str("display_name") ?? toolName
        let input = req.obj("input") ?? [:]
        if toolName == "AskUserQuestion" {
            askQuestions(requestId: rid, input: input, key: req.str("tool_use_id") ?? rid)
            return
        }
        let suggestions = req.objs("permission_suggestions")
        var detailParts: [String] = []
        if let d = req.str("description") { detailParts.append(d) }
        if let reason = req.str("decision_reason"), !reason.isEmpty { detailParts.append(reason) }
        if let blocked = req.str("blocked_path") { detailParts.append("Ruta: \(abbreviateHome(blocked))") }
        var options = [ApprovalOption(id: "allow", label: "Permitir", isAllow: true)]
        if !suggestions.isEmpty { options.append(ApprovalOption(id: "session", label: "Permitir en esta sesión", isAllow: true)) }
        options.append(ApprovalOption(id: "deny", label: "Denegar", isAllow: false))
        let key = req.str("tool_use_id") ?? rid
        let request = ApprovalRequest(
            key: key,
            title: "\(display): \(ToolSummary.title(name: toolName, input: input))",
            detail: detailParts.joined(separator: "\n"),
            options: options
        ) { [weak self] choice in
            guard let self else { return }
            switch choice {
            case "allow":
                self.respondControl(rid, ["behavior": "allow", "updatedInput": input])
            case "session":
                let scoped = suggestions.map { s -> JSONObject in
                    var copy = s
                    copy["destination"] = "session"
                    return copy
                }
                self.respondControl(rid, ["behavior": "allow", "updatedInput": input, "updatedPermissions": scoped])
            default:
                self.respondControl(rid, ["behavior": "deny", "message": "El usuario ha denegado esta acción desde Relevo."])
            }
        }
        onEvent?(.approval(request))
    }

    private func exited(_ code: Int32) {
        guard !closed else { return }
        let tail = proc?.stderrTail ?? ""
        proc = nil
        if resumeId != nil, !gotOutput || tail.lowercased().contains("no conversation found") {
            onEvent?(.failure(AgentFailure(kind: .sessionLost, message: "No se pudo reanudar la sesión de Claude.")))
        } else if turnActive || code != 0 {
            let message = tail.isEmpty ? "Claude Code terminó inesperadamente (código \(code))." : String(tail.suffix(1200))
            onEvent?(.failure(AgentFailure(kind: LimitDetector.classify(message), message: message)))
        }
        if turnActive {
            turnActive = false
            onEvent?(.turnFinished)
        }
    }
}

enum ClaudeUsage {
    static func label(forWindow key: String) -> String {
        switch key {
        case "five_hour", "session": return "5 h"
        case "seven_day", "weekly_all": return "Semana"
        case "seven_day_opus": return "Semana · Opus"
        case "seven_day_sonnet": return "Semana · Sonnet"
        default: return key.replacingOccurrences(of: "_", with: " ")
        }
    }

    static func parse(_ response: JSONObject) -> (windows: [UsageWindow], plan: String?) {
        var windows: [UsageWindow] = []
        let limits = response.objs("limits")
        if !limits.isEmpty {
            for l in limits {
                guard let kind = l.str("kind"), let percent = l.num("percent") else { continue }
                var label = label(forWindow: kind)
                var id = kind
                if kind == "weekly_scoped" {
                    let model = l.obj("scope")?.obj("model")?.str("display_name") ?? "modelo"
                    label = "Semana · \(model)"
                    id = "weekly_\(model)"
                }
                windows.append(UsageWindow(id: id, label: label, percent: percent, resetsAt: DateParse.any(l["resets_at"])))
            }
        } else if let rl = response.obj("rate_limits") {
            for key in ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] {
                guard let w = rl.obj(key), let util = w.num("utilization") else { continue }
                windows.append(UsageWindow(id: key, label: label(forWindow: key), percent: util, resetsAt: DateParse.any(w["resets_at"])))
            }
        }
        let plan = response.str("subscription_type").map { $0.capitalized }
        return (windows, plan)
    }

    static func parseModels(_ response: JSONObject) -> [ModelOption] {
        response.objs("models").compactMap { m in
            guard let value = m.str("value") else { return nil }
            var name = m.str("displayName") ?? value
            if value == "default", let desc = m.str("description"), let first = desc.split(separator: "·").first {
                name = "Predeterminado (\(first.trimmingCharacters(in: .whitespaces)))"
            }
            let efforts = m.strs("supportedEffortLevels")
            return ModelOption(id: value, name: name, detail: m.str("description"), efforts: efforts.isEmpty ? nil : efforts)
        }
    }
}
