import Foundation
import SwiftUI

/// Claude (Pro/Max/Team) through the unmodified Claude Code CLI and its own OAuth login.
final class ClaudeProvider: Provider {
    let kind = ProviderKind.claude

    let info = ProviderInfo(
        displayName: "Claude", shortName: "Claude", agentName: "Claude Code",
        symbol: "asterisk", tint: Color(red: 0.85, green: 0.47, blue: 0.34),
        auth: .cliLogin(help: "Abre Terminal con `claude auth login` (OAuth de tu suscripción Claude Pro/Max/Team)."),
        isolation: IsolationSpec(label: "Carpeta de configuración (CLAUDE_CONFIG_DIR)") { dir, env in env["CLAUDE_CONFIG_DIR"] = dir },
        missingBinaryHelp: "No encuentro la CLI de Claude Code (`claude`). Instálala con `curl -fsSL https://claude.ai/install.sh | bash`."
    )

    var fallbackModels: [ModelOption] {
        [("default", "Predeterminado"), ("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku")]
            .map { ModelOption(id: $0.0, name: $0.1, efforts: EffortLevels.standard) }
    }

    func defaultEfforts(model: String) -> [String]? { EffortLevels.standard }

    var quickModelName: String? { "Haiku 4.5 · sin razonamiento" }
    var quickPriority: Int { 10 }

    /// `claude -p` with Haiku 4.5, thinking off, no tools/MCP/skills and no saved session.
    /// "Semana · Opus" only limits Opus; the 5 h and general weekly windows limit every model.
    func usageWindows(_ windows: [UsageWindow], model: ModelOption) -> [UsageWindow] {
        let m = "\(model.id) \(model.name)".lowercased()
        return windows.filter { w in
            let id = w.id.lowercased()
            guard let family = ["opus", "sonnet", "haiku", "fable"].first(where: id.contains) else { return true }
            return m.contains(family)
        }
    }

    @MainActor func quickCompletion(account: Account, system: String, prompt: String) async -> String? {
        guard var launch = Binaries.launch(for: account) else { return nil }
        launch.environment["MAX_THINKING_TOKENS"] = "0"
        let args = ["-p", prompt, "--model", "claude-haiku-4-5-20251001", "--tools", "", "--no-session-persistence",
                    "--strict-mcp-config", "--disable-slash-commands", "--system-prompt", system, "--output-format", "json"]
        let out = await ProcessRunner.capture(launch, args, timeout: 30).out
        guard let o = JSONUtil.parse(out.split(separator: "\n").last.map(String.init) ?? out), o.bool("is_error") != true else { return nil }
        return o.str("result")
    }

    func launch(for account: Account, env: [String: String], executableOverride: String?) -> Launch? {
        guard let path = resolve(cliCandidates("claude"), override: executableOverride) else { return nil }
        return Launch(executable: path, environment: env)
    }

    @MainActor func makeSession(account: Account, cwd: String, model: String, mode: PermissionMode, resumeId: String?) -> AgentSession {
        ClaudeAgent(account: account, cwd: cwd, model: model, mode: mode, resumeId: resumeId)
    }

    @MainActor func probe(_ account: Account) async -> AccountProbe {
        guard let launch = Binaries.launch(for: account) else {
            return AccountProbe(status: AccountStatus(error: "CLI `claude` no encontrada"))
        }
        async let auth = ProcessRunner.capture(launch, ["auth", "status", "--json"], timeout: 15)
        var probe = await Self.usageAndModels(launch)
        if let o = JSONUtil.parseAny(Data((await auth).out.utf8)) as? JSONObject {
            probe.status.email = o.str("email")
            if o.bool("loggedIn") == false { probe.status.loggedIn = false }
        }
        return probe
    }

    @MainActor func login(_ account: Account, store: AppStore) {
        guard let launch = Binaries.launch(for: account) else { store.flash(info.missingBinaryHelp); return }
        TerminalLauncher.run(Binaries.commandLine(launch, extraArgs: ["auth", "login"]), title: "Iniciar sesión en Claude (\(account.name))")
    }

    /// Control requests `get_usage` + `list_models` on a short-lived headless process (no model call).
    @MainActor static func usageAndModels(_ launch: Launch) async -> AccountProbe {
        let args = launch.prefixArgs + ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
        let p = LineProcess(executable: launch.executable, arguments: args, cwd: NSHomeDirectory(), environment: launch.environment)
        var status = AccountStatus()
        var models: [ModelOption]?
        var answered = Set<String>()
        return await withCheckedContinuation { cont in
            var finished = false
            func finish() {
                guard !finished else { return }
                finished = true
                p.closeInput()
                p.terminate()
                cont.resume(returning: AccountProbe(status: status, models: models))
            }
            p.onLine = { line in
                guard let o = JSONUtil.parse(line), o.str("type") == "control_response", let resp = o.obj("response"), let rid = resp.str("request_id") else { return }
                answered.insert(rid)
                if resp.str("subtype") == "error" {
                    let err = resp.str("error") ?? "error"
                    if rid == "usage" {
                        status.error = err
                        if LimitDetector.isAuth(err) { status.loggedIn = false }
                    }
                } else if let r = resp.obj("response") {
                    if rid == "usage" {
                        let parsed = ClaudeUsage.parse(r)
                        status.windows = parsed.windows
                        status.plan = parsed.plan
                        status.loggedIn = true
                        if r.bool("rate_limits_available") == false && parsed.windows.isEmpty {
                            status.note = "Sin límites de suscripción"
                        }
                    } else if rid == "models" {
                        let list = ClaudeUsage.parseModels(r)
                        if !list.isEmpty { models = list }
                    }
                }
                if answered.isSuperset(of: ["usage", "models"]) { finish() }
            }
            p.onExit = { _ in
                if status.windows.isEmpty && status.error == nil {
                    let tail = p.stderrTail.trimmingCharacters(in: .whitespacesAndNewlines)
                    status.error = tail.isEmpty ? "No se pudo leer el uso" : String(tail.suffix(300))
                    if LimitDetector.isAuth(tail) { status.loggedIn = false }
                }
                finish()
            }
            do {
                try p.start()
                p.write(json: ["type": "control_request", "request_id": "init", "request": ["subtype": "initialize"]])
                p.write(json: ["type": "control_request", "request_id": "usage", "request": ["subtype": "get_usage"]])
                p.write(json: ["type": "control_request", "request_id": "models", "request": ["subtype": "list_models"]])
            } catch {
                status.error = error.localizedDescription
                finish()
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
                if !finished && status.windows.isEmpty && status.error == nil { status.error = "Tiempo de espera agotado" }
                finish()
            }
        }
    }
}

enum EffortLevels {
    static let standard = ["low", "medium", "high", "xhigh", "max"]
}
