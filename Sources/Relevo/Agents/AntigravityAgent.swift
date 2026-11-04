import Foundation

/// Gemini through Google's Antigravity CLI (`agy -p … --output-format stream-json --conversation <id>`),
/// using the Antigravity Google login. One process per turn; the conversation id keeps the context.
@MainActor
final class AntigravityAgent: AgentSession {
    var onEvent: ((AgentEvent) -> Void)?

    private let account: Account
    private let cwd: String
    private var model: String
    private var mode: PermissionMode
    private var conversationId: String?
    private var proc: LineProcess?
    private var closed = false
    private var turnActive = false
    private var streamedSteps = Set<Int>()
    private var anyText = false
    private var failureReported = false
    private let nonce = String(UUID().uuidString.prefix(4))
    private var turn = 0
    private var effort: String?

    init(account: Account, cwd: String, model: String, mode: PermissionMode, resumeId: String?) {
        self.account = account
        self.cwd = cwd
        self.model = model
        self.mode = mode
        self.conversationId = resumeId
        self.resumedConversation = resumeId != nil
    }

    private let resumedConversation: Bool

    func start() throws {
        guard Binaries.launch(for: account) != nil else { throw AgentStartError.binaryNotFound(.gemini) }
    }

    func send(_ text: String) {
        runTurn(text, skipPermissions: mode == .full)
    }

    private func runTurn(_ text: String, skipPermissions: Bool) {
        guard let launch = Binaries.launch(for: account) else {
            onEvent?(.failure(AgentFailure(kind: .other, message: AgentStartError.binaryNotFound(.gemini).localizedDescription)))
            onEvent?(.turnFinished)
            return
        }
        turn += 1
        turnActive = true
        failureReported = false
        streamedSteps.removeAll()
        anyText = false
        onEvent?(.status("Gemini está trabajando…"))
        var args = launch.prefixArgs + ["--output-format", "stream-json"]
        if !model.isEmpty { args += ["--model", model] }
        if let effort, !effort.isEmpty { args += ["--effort", effort] }
        switch mode {
        case .autoEdit: args += ["--mode", "accept-edits"]
        case .plan: args += ["--mode", "plan"]
        case .ask, .full: break
        }
        if skipPermissions { args.append("--dangerously-skip-permissions") }
        if let conversationId { args += ["--conversation", conversationId] }
        args.append("-p=" + text)
        let p = LineProcess(executable: launch.executable, arguments: args, cwd: cwd, environment: launch.environment)
        p.onLine = { [weak self] line in self?.handle(line) }
        p.onExit = { [weak self, weak p] code in
            guard let self, let p, p === self.proc else { return }
            self.exited(code, p.stderrTail)
        }
        do {
            try p.start()
            p.closeInput()
            proc = p
        } catch {
            turnActive = false
            onEvent?(.failure(AgentFailure(kind: .other, message: error.localizedDescription)))
            onEvent?(.turnFinished)
        }
    }

    func setModel(_ model: String) { self.model = model }
    func setMode(_ mode: PermissionMode) { self.mode = mode }
    func setEffort(_ effort: String?) { self.effort = effort }
    func interrupt() { proc?.interruptSignal() }

    func close() {
        closed = true
        proc?.terminate()
        proc = nil
    }

    private func key(_ step: Int) -> String { "\(nonce)-\(turn)-\(step)" }

    private func handle(_ line: String) {
        guard let o = JSONUtil.parse(line), let event = o.str("event") else { return }
        switch event {
        case "init":
            if let id = o.str("conversation_id"), id != conversationId {
                conversationId = id
                onEvent?(.sessionStarted(id))
            }
        case "step_update":
            guard let step = o.obj("step_update") else { return }
            handleStep(step)
        case "result":
            guard let r = o.obj("result") else { return }
            if let id = r.str("conversation_id"), id != conversationId {
                conversationId = id
                onEvent?(.sessionStarted(id))
            }
            if !anyText, let response = r.str("response")?.trimmingCharacters(in: .whitespacesAndNewlines), !response.isEmpty {
                onEvent?(.textFinal(key: key(999), text: response))
            }
            if r.str("status") == "ERROR" || r.has("error") {
                let message = r.str("error") ?? "Antigravity devolvió un error."
                let lower = message.lowercased()
                if turn == 1, resumedConversation, lower.contains("not found") || lower.contains("conversation") && lower.contains("invalid") {
                    report(AgentFailure(kind: .sessionLost, message: message))
                } else {
                    report(AgentFailure(kind: LimitDetector.classify(message), message: message))
                }
            }
            let denied = r.objs("denied_actions")
            if let u = r.obj("usage") {
                // Gemini counts cached tokens inside input_tokens and thinking inside output_tokens.
                let usage = TokenUsage.normalized(model: model.isEmpty ? nil : model, input: u.int("input_tokens") ?? 0,
                                                  cacheRead: u.int("cache_read_tokens") ?? 0, output: u.int("output_tokens") ?? 0,
                                                  reasoning: u.int("thinking_tokens") ?? 0, total: u.int("total_tokens"), inputIncludesCache: true)
                if !usage.isEmpty { onEvent?(.tokens([usage])) }
            }
            turnActive = false
            onEvent?(.turnFinished)
            if !denied.isEmpty { offerRetry(denied) }
        default:
            break
        }
    }

    private func handleStep(_ s: JSONObject) {
        let index = s.int("step_index") ?? 0
        let state = s.str("state") ?? ""
        switch s.str("step_type") ?? "" {
        case "agent_response":
            if let delta = s.str("text_delta"), !delta.isEmpty {
                streamedSteps.insert(index)
                anyText = true
                onEvent?(.textDelta(key: key(index), text: delta))
            } else if state == "DONE", !streamedSteps.contains(index), let text = s.str("text"), !text.isEmpty {
                anyText = true
                onEvent?(.textFinal(key: key(index), text: text))
            }
        case "tool":
            let info = s.obj("tool_info") ?? [:]
            let name = s.str("tool_name") ?? info.str("name") ?? "herramienta"
            let params = info.obj("parameters")
            let k = key(index)
            if state == "ACTIVE" || state == "PENDING" || state == "RUNNING" {
                onEvent?(.toolStarted(key: k, name: name, title: ToolSummary.title(name: name, input: params), input: params.map { JSONUtil.text($0) }))
            } else if state == "DONE" {
                onEvent?(.toolStarted(key: k, name: name, title: ToolSummary.title(name: name, input: params), input: params.map { JSONUtil.text($0) }))
                let output = JSONUtil.flattenContent(info["output"] ?? info["result"] ?? s["output"])
                onEvent?(.toolFinished(key: k, status: .done, output: ToolSummary.cap(output)))
            } else if state == "ERROR" || state == "CANCELED" {
                onEvent?(.toolStarted(key: k, name: name, title: ToolSummary.title(name: name, input: params), input: params.map { JSONUtil.text($0) }))
                let message = info.obj("error")?.str("message") ?? "Error"
                onEvent?(.toolFinished(key: k, status: .failed, output: message))
            }
        default:
            if let delta = s.str("text_delta"), !delta.isEmpty {
                onEvent?(.reasoningDelta(key: key(index), text: delta))
            }
        }
    }

    /// Headless Antigravity auto-denies actions that need a permission. Offer to re-run with permission.
    private func offerRetry(_ denied: [JSONObject]) {
        let names = denied.map { $0.str("display_name") ?? $0.str("action") ?? "acción" }.uniqued().joined(separator: ", ")
        let request = ApprovalRequest(
            key: "retry-\(nonce)-\(turn)",
            title: "Gemini necesita permiso para: \(names)",
            detail: "Antigravity no puede preguntar en modo headless y denegó la acción. Puedes permitirla y reintentar este paso.",
            options: [
                ApprovalOption(id: "retry", label: "Permitir y reintentar", isAllow: true),
                ApprovalOption(id: "deny", label: "Ignorar", isAllow: false),
            ],
            resumesTurn: true
        ) { [weak self] choice in
            guard let self, choice == "retry" else { return }
            self.runTurn("Te concedo el permiso para la acción que se denegó (\(names)). Hazla ahora y continúa con la tarea.", skipPermissions: true)
        }
        onEvent?(.approval(request))
    }

    private func report(_ failure: AgentFailure) {
        guard !failureReported else { return }
        failureReported = true
        onEvent?(.failure(failure))
    }

    private func exited(_ code: Int32, _ tail: String) {
        proc = nil
        guard !closed else { return }
        if code != 0 && code != 2 && code != 15 && !failureReported {
            let message = tail.trimmingCharacters(in: .whitespacesAndNewlines).ifEmpty("Antigravity terminó con código \(code).")
            report(AgentFailure(kind: LimitDetector.classify(message), message: String(message.suffix(1200))))
        }
        if turnActive {
            turnActive = false
            onEvent?(.turnFinished)
        }
    }
}

enum AntigravityUsage {
    /// Parses `agy -p /usage`: "<group>\t<label>\t<remaining>%\t<reset ISO>" per line.
    static func parse(_ text: String) -> [UsageWindow] {
        text.split(separator: "\n").compactMap { line in
            let cols = line.split(separator: "\t").map { $0.trimmingCharacters(in: .whitespaces) }
            guard cols.count >= 3, let remaining = Double(cols[2].replacingOccurrences(of: "%", with: "")) else { return nil }
            let group = cols[0].replacingOccurrences(of: " models", with: "").replacingOccurrences(of: " Models", with: "")
                .replacingOccurrences(of: " and ", with: "/")
            let kind = cols[1].lowercased()
            let period = kind.contains("week") ? "sem." : (kind.contains("5") || kind.contains("hour")) ? "5 h" : kind.contains("day") ? "día" : ""
            let label = period == "sem." || period.isEmpty ? group : "\(group) \(period)"
            let detail = period == "sem." ? "límite semanal" : cols[1]
            return UsageWindow(id: cols[0] + cols[1], label: label, percent: max(0, min(100, 100 - remaining)),
                               resetsAt: cols.count > 3 ? DateParse.any(cols[3]) : nil, detail: detail)
        }
    }

    static func parseModels(_ text: String) -> [ModelOption] {
        text.split(separator: "\n").compactMap { line in
            let cols = line.split(separator: "\t").map { $0.trimmingCharacters(in: .whitespaces) }
            guard cols.count >= 2, !cols[0].contains(" ") else { return nil }
            return ModelOption(id: cols[0], name: cols[1], efforts: EffortLevels.standard)
        }
    }
}
