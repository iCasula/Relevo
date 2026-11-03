import Foundation

/// How a provider's CLI speaks ACP.
struct ACPConfig {
    /// Arguments that start the ACP server, e.g. ["acp"].
    var args: [String]
    /// Optional launch flag for the model (nil when the agent picks models via the protocol).
    var modelFlag: String? = nil
    /// Message shown when the agent requires a login.
    var loginHint: String
    /// Keywords used to map Relevo's permission modes onto the agent's own session modes.
    var modeKeywords: [PermissionMode: [String]] = [
        .ask: ["default", "ask every", "manual", "ask"],
        .autoEdit: ["when needed", "yolo", "accept", "edit"],
        .full: ["never ask", "auto", "bypass", "full"],
        .plan: ["plan"],
    ]
}

/// Generic Agent Client Protocol client (JSON-RPC over stdio). Any ACP agent (Kimi Code, Zed-style
/// agents, …) can be plugged in by a provider with just an `ACPConfig`.
@MainActor
final class ACPAgent: AgentSession {
    var onEvent: ((AgentEvent) -> Void)?

    private let account: Account
    private let config: ACPConfig
    private let cwd: String
    private var model: String
    private var mode: PermissionMode
    private var resumeId: String?
    private var rpc: RPCClient?
    private var sessionId: String?
    private var ready = false
    private var loadingHistory = false
    private var loadSupported = false
    private var queued: [String] = []
    private var turnActive = false
    private var closed = false
    private var messageCounter = 0
    private var lastChunkKind: String?
    private var availableModes: [(id: String, name: String)] = []
    private var modelConfigId: String?
    private let nonce = String(UUID().uuidString.prefix(4))

    init(account: Account, config: ACPConfig, cwd: String, model: String, mode: PermissionMode, resumeId: String?) {
        self.account = account
        self.config = config
        self.cwd = cwd
        self.model = model
        self.mode = mode
        self.resumeId = resumeId
    }

    func start() throws {
        guard let launch = Binaries.launch(for: account) else { throw AgentStartError.binaryNotFound(account.kind) }
        var args = launch.prefixArgs + config.args
        if let flag = config.modelFlag, !model.isEmpty { args += [flag, model] }
        let p = LineProcess(executable: launch.executable, arguments: args, cwd: cwd, environment: launch.environment)
        let client = RPCClient(process: p, includeVersion: true)
        client.onNotification = { [weak self] method, params in self?.handleNotification(method, params) }
        client.onRequest = { [weak self] id, method, params in self?.handleRequest(id, method, params) }
        client.onExit = { [weak self, weak client] code, tail in
            guard let self, let client, client === self.rpc else { return }
            self.exited(code, tail)
        }
        try client.start()
        rpc = client
        ready = false
        onEvent?(.status("Conectando con \(account.kind.agentName)…"))
        client.request("initialize", [
            "protocolVersion": 1,
            "clientCapabilities": ["fs": ["readTextFile": false, "writeTextFile": false], "terminal": false],
            "clientInfo": ["name": "relevo", "title": "Relevo", "version": "1.0"],
        ]) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let value):
                self.loadSupported = (value as? JSONObject)?.obj("agentCapabilities")?.bool("loadSession") ?? false
                self.openSession()
            case .failure(let e):
                self.fail(AgentFailure(kind: .other, message: "\(self.account.kind.agentName) no arrancó: \(e.message)"))
            }
        }
    }

    /// A lapsed plan is not a login problem, even when the agent wraps it in "Authentication required".
    private func isAuthError(_ e: RPCClient.RPCError) -> Bool {
        !LimitDetector.isNoPlan(e.message) && (e.message.lowercased().contains("auth") || LimitDetector.isAuth(e.message))
    }

    private func openSession() {
        let base: JSONObject = ["cwd": cwd, "mcpServers": [Any]()]
        if let resumeId, loadSupported {
            loadingHistory = true
            var params = base
            params["sessionId"] = resumeId
            rpc?.request("session/load", params) { [weak self] result in
                guard let self else { return }
                self.loadingHistory = false
                switch result {
                case .success(let value): self.sessionReady(id: resumeId, info: value as? JSONObject)
                case .failure(let e):
                    if self.isAuthError(e) { self.fail(AgentFailure(kind: .auth, message: self.config.loginHint)) }
                    else { self.onEvent?(.failure(AgentFailure(kind: .sessionLost, message: "No se pudo reanudar la sesión: \(e.message)"))) }
                }
            }
            return
        }
        if resumeId != nil && !loadSupported {
            onEvent?(.failure(AgentFailure(kind: .sessionLost, message: "\(account.kind.agentName) no permite reanudar sesiones.")))
            return
        }
        rpc?.request("session/new", base) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let value):
                guard let o = value as? JSONObject, let id = o.str("sessionId") else {
                    self.fail(AgentFailure(kind: .other, message: "Respuesta inesperada de \(self.account.kind.agentName)."))
                    return
                }
                self.sessionReady(id: id, info: o)
            case .failure(let e):
                self.fail(AgentFailure(kind: self.isAuthError(e) ? .auth : LimitDetector.classify(e.message),
                                       message: self.isAuthError(e) ? self.config.loginHint : e.message))
            }
        }
    }

    private func sessionReady(id: String, info: JSONObject?) {
        sessionId = id
        ready = true
        onEvent?(.sessionStarted(id))
        readModels(info)
        readModes(info)
        applyMode()
        applyModel()
        let pending = queued
        queued.removeAll()
        pending.forEach { prompt($0) }
    }

    /// Models come either as `models.availableModels` or as a `configOptions` entry with id "model".
    private func readModels(_ info: JSONObject?) {
        var list: [ModelOption] = []
        if let models = info?.obj("models") {
            list = models.objs("availableModels").compactMap { m in
                guard let mid = m.str("modelId") else { return nil }
                return ModelOption(id: mid, name: m.str("name") ?? mid, detail: m.str("description"))
            }
        }
        if list.isEmpty, let option = info?.objs("configOptions").first(where: { ($0.str("id") ?? "").lowercased().contains("model") }) {
            modelConfigId = option.str("id")
            list = option.objs("options").compactMap { o in
                guard let value = o.str("value") ?? o.str("id") else { return nil }
                return ModelOption(id: value, name: o.str("name") ?? o.str("label") ?? value, detail: o.str("description"))
            }
        }
        if !list.isEmpty { onEvent?(.models(list)) }
    }

    private func readModes(_ info: JSONObject?) {
        availableModes = (info?.obj("modes")?.objs("availableModes") ?? []).compactMap { m in
            guard let id = m.str("id") else { return nil }
            return (id, (m.str("name") ?? id) + " " + (m.str("description") ?? ""))
        }
    }

    private func applyMode() {
        guard let sessionId, !availableModes.isEmpty else { return }
        let keywords = config.modeKeywords[mode] ?? []
        let match = keywords.lazy.compactMap { k in
            self.availableModes.first { $0.id.lowercased().contains(k) || $0.name.lowercased().contains(k) }
        }.first
        guard let match else { return }
        rpc?.request("session/set_mode", ["sessionId": sessionId, "modeId": match.id]) { _ in }
    }

    private func applyModel() {
        guard let sessionId, !model.isEmpty else { return }
        if let configId = modelConfigId {
            rpc?.request("session/set_config_option", ["sessionId": sessionId, "configId": configId, "value": model]) { _ in }
        } else {
            rpc?.request("session/set_model", ["sessionId": sessionId, "modelId": model]) { _ in }
        }
    }

    func send(_ text: String) {
        turnActive = true
        onEvent?(.status("\(account.kind.agentName) está trabajando…"))
        if ready { prompt(text) } else { queued.append(text) }
    }

    private func prompt(_ text: String) {
        guard let sessionId else { return }
        turnActive = true
        messageCounter += 1
        lastChunkKind = nil
        rpc?.request("session/prompt", ["sessionId": sessionId, "prompt": [["type": "text", "text": text]]]) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let value):
                let reason = (value as? JSONObject)?.str("stopReason") ?? "end_turn"
                if reason == "refusal" { self.onEvent?(.notice("\(self.account.kind.agentName) rechazó la petición")) }
                if reason == "max_tokens" { self.onEvent?(.notice("Se alcanzó el máximo de tokens")) }
            case .failure(let e):
                let text = e.message + " " + JSONUtil.text(e.data)
                self.onEvent?(.failure(AgentFailure(kind: LimitDetector.classify(text), message: e.message)))
            }
            self.turnActive = false
            self.onEvent?(.turnFinished)
        }
    }

    func setModel(_ model: String) {
        self.model = model
        applyModel()
    }

    func setMode(_ mode: PermissionMode) {
        self.mode = mode
        applyMode()
    }

    func setEffort(_ effort: String?) {}

    func interrupt() {
        guard let sessionId else { return }
        rpc?.notify("session/cancel", ["sessionId": sessionId])
    }

    func close() {
        closed = true
        rpc?.terminate()
        rpc = nil
    }

    private func fail(_ failure: AgentFailure) {
        onEvent?(.failure(failure))
        if turnActive {
            turnActive = false
            onEvent?(.turnFinished)
        }
    }

    private func key(_ s: String) -> String { "\(nonce)-\(s)" }

    // MARK: - session/update

    private func handleNotification(_ method: String, _ params: JSONObject) {
        guard method == "session/update", !loadingHistory, let update = params.obj("update") else { return }
        switch update.str("sessionUpdate") ?? "" {
        case "agent_message_chunk":
            if lastChunkKind != "message" { messageCounter += 1 }
            lastChunkKind = "message"
            if let text = update.obj("content")?.str("text") { onEvent?(.textDelta(key: key("msg\(messageCounter)"), text: text)) }
        case "agent_thought_chunk":
            if lastChunkKind != "thought" { messageCounter += 1 }
            lastChunkKind = "thought"
            if let text = update.obj("content")?.str("text") { onEvent?(.reasoningDelta(key: key("th\(messageCounter)"), text: text)) }
        case "tool_call":
            lastChunkKind = "tool"
            guard let id = update.str("toolCallId") else { return }
            let title = update.str("title") ?? "Herramienta"
            let input = update.obj("rawInput")
            onEvent?(.toolStarted(key: key(id), name: update.str("kind") ?? title, title: title, input: input.map { JSONUtil.text($0) }))
            if let status = update.str("status"), status == "completed" || status == "failed" {
                onEvent?(.toolFinished(key: key(id), status: status == "failed" ? .failed : .done, output: toolContent(update)))
            }
        case "tool_call_update":
            lastChunkKind = "tool"
            guard let id = update.str("toolCallId") else { return }
            let status = update.str("status")
            let output = toolContent(update)
            if status == "completed" || status == "failed" {
                onEvent?(.toolFinished(key: key(id), status: status == "failed" ? .failed : .done, output: output))
            } else if let output, !output.isEmpty {
                onEvent?(.toolOutput(key: key(id), text: output))
            }
        case "plan":
            let steps = update.objs("entries").compactMap { e -> PlanStep? in
                guard let text = e.str("content") else { return nil }
                return PlanStep(text: text, status: e.str("status") ?? "pending")
            }
            if !steps.isEmpty { onEvent?(.plan(steps)) }
        default:
            break
        }
    }

    private func toolContent(_ update: JSONObject) -> String? {
        let parts = update.objs("content").compactMap { c -> String? in
            switch c.str("type") {
            case "content": return JSONUtil.flattenContent(c["content"])
            case "diff": return "── \(abbreviateHome(c.str("path") ?? ""))\n\(c.str("newText") ?? "")"
            default: return nil
            }
        }
        if parts.isEmpty, let raw = update["rawOutput"] { return ToolSummary.cap(JSONUtil.text(raw)) }
        return parts.isEmpty ? nil : ToolSummary.cap(parts.joined(separator: "\n"))
    }

    // MARK: - Agent → client requests

    private func handleRequest(_ id: Any, _ method: String, _ params: JSONObject) {
        guard method == "session/request_permission" else {
            rpc?.respondError(id: id, message: "Relevo no implementa \(method)")
            return
        }
        let tool = params.obj("toolCall") ?? [:]
        let options = params.objs("options").compactMap { o -> ApprovalOption? in
            guard let oid = o.str("optionId") else { return nil }
            return ApprovalOption(id: oid, label: o.str("name") ?? oid, isAllow: (o.str("kind") ?? "").hasPrefix("allow"))
        }
        let request = ApprovalRequest(
            key: tool.str("toolCallId").map(key) ?? UUID().uuidString,
            title: tool.str("title") ?? "\(account.kind.agentName) quiere usar una herramienta",
            detail: tool["rawInput"].map { String(JSONUtil.text($0).prefix(1500)) } ?? "",
            options: options.isEmpty ? [ApprovalOption(id: "cancel", label: "Cancelar", isAllow: false)] : options
        ) { [weak self] choice in
            let outcome: JSONObject = choice == "cancel" || choice == "deny"
                ? ["outcome": "cancelled"] : ["outcome": "selected", "optionId": choice]
            self?.rpc?.respond(id: id, result: ["outcome": outcome])
        }
        onEvent?(.approval(request))
    }

    private func exited(_ code: Int32, _ tail: String) {
        guard !closed else { return }
        rpc = nil
        ready = false
        if turnActive || code != 0 {
            let message = tail.isEmpty ? "\(account.kind.agentName) terminó inesperadamente (código \(code))." : String(tail.suffix(1200))
            fail(AgentFailure(kind: LimitDetector.classify(message), message: message))
        }
    }
}
