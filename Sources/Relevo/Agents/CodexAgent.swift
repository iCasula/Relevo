import Foundation

/// Codex via `codex app-server` (JSON-RPC over stdio), using the ChatGPT login stored by Codex.
@MainActor
final class CodexAgent: AgentSession {
    var onEvent: ((AgentEvent) -> Void)?

    private let account: Account
    private let cwd: String
    private var model: String
    private var mode: PermissionMode
    private let resumeId: String?
    private var rpc: RPCClient?
    private var threadId: String?
    private var turnId: String?
    private var ready = false
    private var queued: [String] = []
    private var turnActive = false
    private var closed = false
    private var turnFailureReported = false
    private var effort: String?

    init(account: Account, cwd: String, model: String, mode: PermissionMode, resumeId: String?) {
        self.account = account
        self.cwd = cwd
        self.model = model
        self.mode = mode
        self.resumeId = resumeId
    }

    private var approvalPolicy: String {
        switch mode {
        case .ask: return "untrusted"
        case .autoEdit, .plan: return "on-request"
        case .full: return "never"
        }
    }

    private var sandboxMode: String {
        switch mode {
        case .ask, .autoEdit: return "workspace-write"
        case .full: return "danger-full-access"
        case .plan: return "read-only"
        }
    }

    private var sandboxPolicy: JSONObject {
        switch mode {
        case .ask, .autoEdit: return ["type": "workspaceWrite"]
        case .full: return ["type": "dangerFullAccess"]
        case .plan: return ["type": "readOnly"]
        }
    }

    func start() throws {
        guard let launch = Binaries.launch(for: account) else { throw AgentStartError.binaryNotFound(.codex) }
        let p = LineProcess(executable: launch.executable, arguments: launch.prefixArgs + ["app-server"], cwd: cwd, environment: launch.environment)
        let client = RPCClient(process: p, includeVersion: false)
        client.onNotification = { [weak self] method, params in self?.handleNotification(method, params) }
        client.onRequest = { [weak self] id, method, params in self?.handleRequest(id, method, params) }
        client.onExit = { [weak self] code, tail in self?.exited(code, tail) }
        try client.start()
        rpc = client
        onEvent?(.status("Conectando con Codex…"))
        client.request("initialize", ["clientInfo": ["name": "relevo", "title": "Relevo", "version": "1.0"]]) { [weak self] result in
            guard let self else { return }
            if case .failure(let e) = result {
                self.fail(AgentFailure(kind: LimitDetector.classify(e.message), message: "Codex no arrancó: \(e.message)"))
                return
            }
            self.rpc?.notify("initialized")
            self.openThread()
        }
    }

    private func threadParams() -> JSONObject {
        var p: JSONObject = ["cwd": cwd, "approvalPolicy": approvalPolicy, "sandbox": sandboxMode]
        if !model.isEmpty { p["model"] = model }
        return p
    }

    private func openThread() {
        var params = threadParams()
        let method: String
        if let resumeId {
            params["threadId"] = resumeId
            method = "thread/resume"
        } else {
            method = "thread/start"
        }
        rpc?.request(method, params) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let value):
                guard let thread = (value as? JSONObject)?.obj("thread"), let id = thread.str("id") else {
                    self.fail(AgentFailure(kind: .other, message: "Respuesta inesperada de Codex al crear el hilo."))
                    return
                }
                self.threadId = id
                self.ready = true
                self.onEvent?(.sessionStarted(id))
                let pending = self.queued
                self.queued.removeAll()
                pending.forEach { self.startTurn($0) }
            case .failure(let e):
                if self.resumeId != nil {
                    self.onEvent?(.failure(AgentFailure(kind: .sessionLost, message: "No se pudo reanudar el hilo de Codex: \(e.message)")))
                } else {
                    self.fail(AgentFailure(kind: LimitDetector.classify(e.message), message: e.message))
                }
            }
        }
    }

    func send(_ text: String) {
        turnActive = true
        turnFailureReported = false
        onEvent?(.status("Codex está trabajando…"))
        if ready { startTurn(text) } else { queued.append(text) }
    }

    private func startTurn(_ text: String) {
        guard let threadId else { return }
        var params: JSONObject = [
            "threadId": threadId,
            "input": [["type": "text", "text": text, "text_elements": [Any]()]],
            "approvalPolicy": approvalPolicy,
            "sandboxPolicy": sandboxPolicy,
        ]
        if !model.isEmpty { params["model"] = model }
        if let effort, !effort.isEmpty { params["effort"] = effort }
        rpc?.request("turn/start", params) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let value):
                self.turnId = (value as? JSONObject)?.obj("turn")?.str("id") ?? self.turnId
            case .failure(let e):
                self.fail(AgentFailure(kind: LimitDetector.classify(e.message), message: e.message))
            }
        }
    }

    func setModel(_ model: String) { self.model = model }

    func setMode(_ mode: PermissionMode) { self.mode = mode }

    func setEffort(_ effort: String?) { self.effort = effort }

    func interrupt() {
        guard let threadId, let turnId else { return }
        rpc?.request("turn/interrupt", ["threadId": threadId, "turnId": turnId]) { _ in }
    }

    func close() {
        closed = true
        rpc?.terminate()
        rpc = nil
    }

    func refreshUsage() {
        rpc?.request("account/rateLimits/read") { [weak self] result in
            guard case .success(let value) = result, let o = value as? JSONObject else { return }
            let parsed = CodexUsage.parseRateLimits(o)
            self?.onEvent?(.usage(windows: parsed.windows, plan: parsed.plan))
        }
    }

    private func fail(_ failure: AgentFailure) {
        onEvent?(.failure(failure))
        if turnActive {
            turnActive = false
            onEvent?(.turnFinished)
        }
    }

    // MARK: - Notifications

    private func handleNotification(_ method: String, _ params: JSONObject) {
        switch method {
        case "turn/started":
            turnId = params.obj("turn")?.str("id") ?? turnId
        case "item/started":
            guard let item = params.obj("item") else { return }
            itemStarted(item)
        case "item/agentMessage/delta":
            if let id = params.str("itemId"), let delta = params.str("delta") {
                onEvent?(.textDelta(key: id, text: delta))
            }
        case "item/reasoning/summaryTextDelta", "item/reasoning/textDelta":
            if let id = params.str("itemId"), let delta = params.str("delta") {
                onEvent?(.reasoningDelta(key: id, text: delta))
            }
        case "item/commandExecution/outputDelta":
            if let id = params.str("itemId"), let delta = params.str("delta") {
                onEvent?(.toolOutput(key: id, text: delta))
            }
        case "item/completed":
            guard let item = params.obj("item") else { return }
            itemCompleted(item)
        case "turn/completed":
            let turn = params.obj("turn") ?? [:]
            if turn.str("status") == "failed", !turnFailureReported {
                let err = turn.obj("error")
                reportTurnError(err)
            }
            turnActive = false
            onEvent?(.turnFinished)
            refreshUsage()
        case "error":
            if params.bool("willRetry") == true {
                onEvent?(.status("Codex reintenta: \(params.obj("error")?.str("message") ?? "")"))
            } else {
                reportTurnError(params.obj("error"))
            }
        case "account/rateLimits/updated":
            if let rl = params.obj("rateLimits") {
                let windows = CodexUsage.windows(from: rl)
                if !windows.isEmpty { onEvent?(.usage(windows: windows, plan: rl.str("planType")?.capitalized)) }
            }
        case "turn/plan/updated":
            let steps = params.objs("plan").compactMap { p -> PlanStep? in
                guard let text = p.str("step") else { return nil }
                let status = p.str("status") ?? "pending"
                return PlanStep(text: text, status: status == "inProgress" ? "in_progress" : status)
            }
            if !steps.isEmpty { onEvent?(.plan(steps)) }
        case "thread/compacted":
            onEvent?(.notice("Codex ha compactado el contexto"))
        case "model/rerouted":
            if let to = params.str("toModel") ?? params.str("model") { onEvent?(.notice("Codex cambió al modelo \(to)")) }
        default:
            break
        }
    }

    private func reportTurnError(_ err: JSONObject?) {
        guard !turnFailureReported else { return }
        turnFailureReported = true
        let message = err?.str("message") ?? "Codex devolvió un error."
        var kind = LimitDetector.classify(message)
        let info = err?["codexErrorInfo"]
        if let s = info as? String {
            if s == "usageLimitExceeded" || s == "rateLimitExceeded" || s == "sessionBudgetExceeded" { kind = .limit }
            if s == "unauthorized" { kind = .auth }
            if s == "serverOverloaded" || s == "policyCapacityUnavailable" || s == "flexUnavailable" { kind = .unavailable }
        }
        onEvent?(.failure(AgentFailure(kind: kind, message: message)))
    }

    private func itemStarted(_ item: JSONObject) {
        guard let id = item.str("id") else { return }
        switch item.str("type") {
        case "commandExecution":
            onEvent?(.toolStarted(key: id, name: "Shell", title: item.str("command") ?? "comando", input: nil))
        case "fileChange":
            let paths = item.objs("changes").compactMap { $0.str("path") }.map(abbreviateHome)
            onEvent?(.toolStarted(key: id, name: "Edición", title: paths.isEmpty ? "Editar ficheros" : "Editar " + paths.joined(separator: ", "), input: nil))
        case "mcpToolCall":
            let name = "\(item.str("server") ?? "mcp").\(item.str("tool") ?? "tool")"
            onEvent?(.toolStarted(key: id, name: "MCP", title: name, input: JSONUtil.text(item["arguments"])))
        case "dynamicToolCall":
            onEvent?(.toolStarted(key: id, name: item.str("tool") ?? "Herramienta", title: item.str("tool") ?? "Herramienta", input: JSONUtil.text(item["arguments"])))
        case "webSearch":
            onEvent?(.toolStarted(key: id, name: "Web", title: "Buscar “\(item.str("query") ?? "")”", input: nil))
        case "imageGeneration":
            onEvent?(.toolStarted(key: id, name: "Imagen", title: "Generando imagen", input: nil))
        default:
            break
        }
    }

    private func itemCompleted(_ item: JSONObject) {
        guard let id = item.str("id") else { return }
        switch item.str("type") {
        case "agentMessage":
            if let text = item.str("text") { onEvent?(.textFinal(key: id, text: text)) }
        case "reasoning":
            let text = (item.strs("summary") + item.strs("content")).joined(separator: "\n\n")
            if !text.isEmpty { onEvent?(.reasoningFinal(key: id, text: text)) }
        case "plan":
            if let text = item.str("text") { onEvent?(.textFinal(key: id, text: text)) }
        case "commandExecution":
            let exit = item.int("exitCode")
            let status: ToolStatus = (item.str("status") == "failed" || (exit ?? 0) != 0 || item.str("status") == "declined") ? .failed : .done
            var output = item.str("aggregatedOutput") ?? ""
            if let exit, exit != 0 { output += "\n(código de salida \(exit))" }
            onEvent?(.toolFinished(key: id, status: status, output: ToolSummary.cap(output)))
        case "fileChange":
            let diff = item.objs("changes").map { c -> String in
                let path = abbreviateHome(c.str("path") ?? "")
                return "── \(path)\n\(c.str("diff") ?? "")"
            }.joined(separator: "\n")
            let failed = item.str("status") == "failed" || item.str("status") == "declined"
            onEvent?(.toolFinished(key: id, status: failed ? .failed : .done, output: ToolSummary.cap(diff)))
        case "mcpToolCall":
            let failed = item.has("error")
            let output = failed ? JSONUtil.text(item["error"]) : JSONUtil.flattenContent(item.obj("result")?["content"])
            onEvent?(.toolFinished(key: id, status: failed ? .failed : .done, output: ToolSummary.cap(output)))
        case "dynamicToolCall":
            let failed = item.bool("success") == false
            onEvent?(.toolFinished(key: id, status: failed ? .failed : .done, output: ToolSummary.cap(JSONUtil.flattenContent(item["contentItems"]))))
        case "webSearch":
            onEvent?(.toolFinished(key: id, status: .done, output: nil))
        case "imageGeneration":
            onEvent?(.toolFinished(key: id, status: item.has("failure") ? .failed : .done, output: item.str("savedPath")))
        case "contextCompaction":
            onEvent?(.notice("Codex ha compactado el contexto"))
        default:
            break
        }
    }

    // MARK: - Server requests (approvals)

    private func handleRequest(_ id: Any, _ method: String, _ params: JSONObject) {
        switch method {
        case "item/commandExecution/requestApproval":
            let command = params.str("command") ?? "comando"
            var detail: [String] = []
            if let reason = params.str("reason") { detail.append(reason) }
            if let cwd = params.str("cwd") { detail.append("En \(abbreviateHome(cwd))") }
            approval(id: id, key: params.str("approvalId") ?? params.str("itemId") ?? UUID().uuidString,
                     title: "Ejecutar: \(command)", detail: detail.joined(separator: "\n"))
        case "item/fileChange/requestApproval":
            var detail: [String] = []
            if let reason = params.str("reason") { detail.append(reason) }
            if let root = params.str("grantRoot") { detail.append("Permitir escritura en \(abbreviateHome(root))") }
            approval(id: id, key: params.str("itemId") ?? UUID().uuidString, title: "Aplicar cambios en ficheros", detail: detail.joined(separator: "\n"))
        case "execCommandApproval", "applyPatchApproval":
            // Legacy v1 approvals: answer conservatively.
            rpc?.respond(id: id, result: ["decision": "denied"])
        default:
            rpc?.respondError(id: id, message: "Relevo no soporta \(method)")
        }
    }

    private func approval(id: Any, key: String, title: String, detail: String) {
        let request = ApprovalRequest(
            key: key, title: title, detail: detail,
            options: [
                ApprovalOption(id: "accept", label: "Permitir", isAllow: true),
                ApprovalOption(id: "acceptForSession", label: "Permitir en esta sesión", isAllow: true),
                ApprovalOption(id: "decline", label: "Denegar", isAllow: false),
            ]
        ) { [weak self] choice in
            self?.rpc?.respond(id: id, result: ["decision": choice])
        }
        onEvent?(.approval(request))
    }

    private func exited(_ code: Int32, _ tail: String) {
        guard !closed else { return }
        rpc = nil
        ready = false
        if turnActive || code != 0 {
            let message = tail.isEmpty ? "Codex terminó inesperadamente (código \(code))." : String(tail.suffix(1200))
            fail(AgentFailure(kind: LimitDetector.classify(message), message: message))
        }
    }
}

enum CodexUsage {
    static func windows(from rl: JSONObject) -> [UsageWindow] {
        var result: [UsageWindow] = []
        for key in ["primary", "secondary"] {
            guard let w = rl.obj(key), let used = w.num("usedPercent") else { continue }
            let mins = w.int("windowDurationMins") ?? (key == "primary" ? 300 : 10080)
            result.append(UsageWindow(id: key, label: label(minutes: mins), percent: used, resetsAt: DateParse.any(w["resetsAt"])))
        }
        return result
    }

    static func label(minutes: Int) -> String {
        if minutes >= 10_000 && minutes <= 10_100 { return "Semana" }
        if minutes % 1440 == 0 { return "\(minutes / 1440) d" }
        if minutes % 60 == 0 { return "\(minutes / 60) h" }
        return "\(minutes) min"
    }

    static func parseRateLimits(_ o: JSONObject) -> (windows: [UsageWindow], plan: String?) {
        let rl = o.obj("rateLimits") ?? [:]
        return (windows(from: rl), rl.str("planType")?.capitalized)
    }
}
