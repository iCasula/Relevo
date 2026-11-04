import Foundation

/// Z.ai GLM Coding Plan via the ZCode CLI (`zcode -p … --output-format stream-json`),
/// using the Z.ai browser login (`zcode login zai`). One process per turn, resumed by session id.
@MainActor
final class ZaiAgent: AgentSession {
    var onEvent: ((AgentEvent) -> Void)?

    private let account: Account
    private let cwd: String
    private var model: String
    private var mode: PermissionMode
    private var sessionId: String?
    private var proc: LineProcess?
    private var turnActive = false
    private var closed = false
    private var textSegment = 0
    private var streamedThisTurn = false
    private var lastWasTool = false
    private var failureReported = false
    private var turnCounter = 0
    private var effort: String?

    init(account: Account, cwd: String, model: String, mode: PermissionMode, resumeId: String?) {
        self.account = account
        self.cwd = cwd
        self.model = model
        self.mode = mode
        self.sessionId = resumeId
    }

    private var cliMode: String {
        switch mode {
        case .ask: return "guarded"
        case .autoEdit: return "edit"
        case .full: return "yolo"
        case .plan: return "plan"
        }
    }

    func start() throws {
        guard Binaries.launch(for: account) != nil else { throw AgentStartError.binaryNotFound(.zai) }
    }

    func send(_ text: String) {
        guard let launch = Binaries.launch(for: account) else {
            onEvent?(.failure(AgentFailure(kind: .other, message: AgentStartError.binaryNotFound(.zai).localizedDescription)))
            onEvent?(.turnFinished)
            return
        }
        ZaiConfig.applyModel(model, effort: effort)
        turnActive = true
        failureReported = false
        streamedThisTurn = false
        lastWasTool = false
        turnCounter += 1
        textSegment = 0
        onEvent?(.status("GLM está trabajando…"))
        var args = launch.prefixArgs + ["-p", text, "--output-format", "stream-json", "--cwd", cwd, "--mode", cliMode]
        if let sessionId { args += ["--resume", sessionId] }
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

    func interrupt() {
        proc?.interruptSignal()
    }

    func close() {
        closed = true
        proc?.terminate()
        proc = nil
    }

    private var textKey: String { "t\(turnCounter)-\(textSegment)" }

    private func handle(_ line: String) {
        guard let o = JSONUtil.parse(line) else { return }
        if let sid = o.str("sessionId"), sid != sessionId {
            sessionId = sid
            onEvent?(.sessionStarted(sid))
        }
        let type = o.str("type") ?? ""
        let payload = o.obj("payload") ?? [:]
        switch type {
        case "model.streaming":
            let kind = payload.str("kind") ?? ""
            let delta = payload.str("delta") ?? ""
            if kind == "text_delta", !delta.isEmpty {
                if lastWasTool { textSegment += 1; lastWasTool = false }
                streamedThisTurn = true
                onEvent?(.textDelta(key: textKey, text: delta))
            } else if kind == "reasoning_delta", !delta.isEmpty {
                onEvent?(.reasoningDelta(key: "r\(turnCounter)-\(textSegment)", text: delta))
            }
        case "tool.updated":
            handleTool(payload)
        case "message.upserted":
            let message = payload.obj("message") ?? payload
            if (message.str("role") ?? "") == "assistant", !streamedThisTurn {
                let text = JSONUtil.flattenContent(message["content"] ?? message["text"] ?? message["parts"])
                if !text.isEmpty { onEvent?(.textFinal(key: textKey, text: text)) }
            }
        case "turn.completed":
            if !streamedThisTurn, let response = payload.str("response"), !response.isEmpty {
                onEvent?(.textFinal(key: textKey, text: response))
            }
            if let usage = ZaiUsage.parse(payload, model: model) { onEvent?(.tokens([usage])) }
            finishTurn()
        case "turn.failed":
            let err = payload.obj("error")
            let message = err?.str("message") ?? payload.str("message") ?? payload.str("error") ?? "GLM devolvió un error."
            let code = err?.str("code") ?? payload.str("code") ?? ""
            report(AgentFailure(kind: LimitDetector.classify(message + " " + code), message: message))
        case "permission.requested":
            onEvent?(.notice("ZCode pidió un permiso que no puede mostrarse en modo headless; cambia a «Auto-editar» o «Acceso total» si se bloquea."))
        default:
            break
        }
    }

    private func handleTool(_ p: JSONObject) {
        let id = p.str("toolCallId") ?? p.str("callId") ?? p.str("id") ?? p.str("toolUseId")
        guard let id else { return }
        let name = p.str("toolName") ?? p.str("name") ?? p.str("tool") ?? "Herramienta"
        let input = p.obj("input") ?? p.obj("args") ?? p.obj("arguments") ?? p.obj("parameters")
        switch p.str("kind") ?? "" {
        case "scheduled", "started":
            lastWasTool = true
            onEvent?(.toolStarted(key: id, name: name, title: ToolSummary.title(name: name, input: input), input: input.map { JSONUtil.text($0) }))
        case "progress":
            if let out = p.str("output") ?? p.str("delta") ?? p.str("message") { onEvent?(.toolOutput(key: id, text: out)) }
        case "result":
            let out = JSONUtil.flattenContent(p["output"] ?? p["result"] ?? p["content"])
            let failed = p.bool("isError") ?? p.bool("is_error") ?? false
            onEvent?(.toolFinished(key: id, status: failed ? .failed : .done, output: ToolSummary.cap(out)))
        case "error":
            let out = JSONUtil.text(p["error"] ?? p["message"])
            onEvent?(.toolFinished(key: id, status: .failed, output: out))
        default:
            break
        }
    }

    private func report(_ failure: AgentFailure) {
        guard !failureReported else { return }
        failureReported = true
        onEvent?(.failure(failure))
    }

    private func finishTurn() {
        guard turnActive else { return }
        turnActive = false
        onEvent?(.turnFinished)
    }

    private func exited(_ code: Int32, _ tail: String) {
        proc = nil
        guard !closed else { return }
        if code != 0 && code != 2 && code != 15 {
            var message = tail.trimmingCharacters(in: .whitespacesAndNewlines)
            if message.isEmpty { message = "ZCode terminó con código \(code)." }
            if message.contains("Select a model") {
                message = "ZCode no tiene un modelo disponible. Inicia sesión con «zcode login zai» desde Ajustes › Suscripciones."
                report(AgentFailure(kind: .auth, message: message))
            } else {
                report(AgentFailure(kind: LimitDetector.classify(message), message: String(message.suffix(1200))))
            }
        }
        finishTurn()
    }
}

enum ZaiConfig {
    static let cliConfigPath = "\(NSHomeDirectory())/.zcode/cli/config.json"

    static func providerId() -> String {
        // Team / start plans use other provider ids; individual plan is the common case.
        "account:zai-individual-coding-plan"
    }

    /// The ZCode CLI reads its default model from ~/.zcode/cli/config.json ("provider/model").
    static func applyModel(_ model: String, effort: String? = nil) {
        guard !model.isEmpty else { return }
        var value = model.contains("/") ? model : "\(providerId())/\(model)"
        if let effort, !effort.isEmpty { value += "$" + effort }
        var config: JSONObject = [:]
        if let data = FileManager.default.contents(atPath: cliConfigPath), let o = JSONUtil.parseAny(data) as? JSONObject {
            config = o
        }
        guard config.str("model") != value else { return }
        config["model"] = value
        try? FileManager.default.createDirectory(atPath: (cliConfigPath as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) {
            try? data.write(to: URL(fileURLWithPath: cliConfigPath))
        }
    }

    /// Models included in the user's Z.ai plan, read from ZCode's bundled provider config.
    static func models() -> [ModelOption] {
        for app in Binaries.appBundles("ZCode.app") {
            let path = "\(app)/Contents/Resources/config/provider/zcode-builtin.json"
            guard let data = FileManager.default.contents(atPath: path), let o = JSONUtil.parseAny(data) as? JSONObject else { continue }
            let modelConfig = o.obj("config")?.obj("modelConfigRules")
            let rules = modelConfig?.objs("builtinProviderModelRules") ?? []
            let levelRules = modelConfig?.objs("modelRules") ?? []
            let ids = rules.filter { $0.str("providerId") == providerId() }.compactMap { $0.str("modelId") }
            if !ids.isEmpty {
                return ids.map { id in
                    // Most specific matching rule wins (rules go from generic to specific).
                    var levels: [String]?
                    for rule in levelRules {
                        guard let pattern = rule.str("modelMatch"),
                              id.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil,
                              let values = rule.obj("config")?.obj("optionSpecs")?.obj("reasoningLevel")?.strs("values"), !values.isEmpty else { continue }
                        levels = values
                    }
                    return ModelOption(id: id, name: id.replacingOccurrences(of: "-Flash", with: " Flash").replacingOccurrences(of: "-Turbo", with: " Turbo"),
                                       efforts: levels, defaultEffort: levels?.last)
                }
            }
        }
        return ProviderKind.zai.fallbackModels
    }
}


enum ZaiUsage {
    /// `turn.completed` carries `usage` (camelCase or OpenAI-style keys) and, as a fallback, `tokenCount`.
    static func parse(_ payload: JSONObject, model: String) -> TokenUsage? {
        let id = model.isEmpty ? nil : model
        if let u = payload.obj("usage") {
            let details = u.obj("prompt_tokens_details")
            let input = u.int("inputTokens") ?? u.int("prompt_tokens") ?? u.int("input_tokens") ?? 0
            let cached = u.int("cacheReadTokens") ?? details?.int("cached_tokens") ?? u.int("cache_read_input_tokens")
                ?? payload.obj("cacheStats")?.int("cacheReadTokens") ?? 0
            let output = u.int("outputTokens") ?? u.int("completion_tokens") ?? u.int("output_tokens") ?? 0
            let usage = TokenUsage.normalized(model: id, input: input, cacheRead: cached, cacheWrite: u.int("cacheWriteTokens") ?? 0,
                                              output: output, reasoning: u.int("reasoningTokens") ?? 0,
                                              total: u.int("totalTokens") ?? u.int("total_tokens"), inputIncludesCache: true)
            if !usage.isEmpty { return usage }
        }
        // Only a total: count it as uncached input so it still shows up (cost is then an upper bound).
        if let total = payload.int("tokenCount"), total > 0 { return TokenUsage(model: id, input: total) }
        return nil
    }
}
