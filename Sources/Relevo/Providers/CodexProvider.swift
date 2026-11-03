import Foundation
import SwiftUI
import AppKit

/// ChatGPT (Plus/Pro/Team) through the official Codex CLI `app-server` and its ChatGPT login.
final class CodexProvider: Provider {
    let kind = ProviderKind.codex

    let info = ProviderInfo(
        displayName: "ChatGPT · Codex", shortName: "Codex", agentName: "Codex",
        symbol: "hexagon", tint: Color(red: 0.07, green: 0.64, blue: 0.50),
        auth: .cliLogin(help: "Abre el navegador con el login de ChatGPT (plan Plus/Pro/Team) a través de Codex."),
        isolation: IsolationSpec(label: "Carpeta de configuración (CODEX_HOME)") { dir, env in env["CODEX_HOME"] = dir },
        missingBinaryHelp: "No encuentro la CLI de Codex. Instala la app de ChatGPT/Codex o `npm i -g @openai/codex`."
    )

    var fallbackModels: [ModelOption] { [ModelOption(id: "", name: "Predeterminado")] }

    func launch(for account: Account, env: [String: String], executableOverride: String?) -> Launch? {
        var extra: [String] = []
        for app in Binaries.appBundles("ChatGPT.app") { extra.append("\(app)/Contents/Resources/codex-cli/bin/codex") }
        for app in Binaries.appBundles("Codex.app") {
            extra += ["\(app)/Contents/Resources/codex", "\(app)/Contents/Resources/codex-cli/bin/codex"]
        }
        guard let path = resolve(cliCandidates("codex", extra: extra), override: executableOverride) else { return nil }
        return Launch(executable: path, environment: env)
    }

    @MainActor func makeSession(account: Account, cwd: String, model: String, mode: PermissionMode, resumeId: String?) -> AgentSession {
        CodexAgent(account: account, cwd: cwd, model: model, mode: mode, resumeId: resumeId)
    }

    /// app-server `account/read`, `account/rateLimits/read`, `model/list` (no model call).
    @MainActor func probe(_ account: Account) async -> AccountProbe {
        guard let launch = Binaries.launch(for: account) else {
            return AccountProbe(status: AccountStatus(error: "CLI `codex` no encontrada"))
        }
        let p = LineProcess(executable: launch.executable, arguments: launch.prefixArgs + ["app-server"], cwd: NSHomeDirectory(), environment: launch.environment)
        let rpc = RPCClient(process: p, includeVersion: false)
        var status = AccountStatus()
        var models: [ModelOption]?
        do { try rpc.start() } catch {
            return AccountProbe(status: AccountStatus(error: error.localizedDescription))
        }
        defer { rpc.terminate() }
        guard case .success = await rpc.request("initialize", ["clientInfo": ["name": "relevo", "title": "Relevo", "version": "1.0"]]) else {
            return AccountProbe(status: AccountStatus(error: "Codex no respondió"))
        }
        rpc.notify("initialized")
        if case .success(let v) = await rpc.request("account/read", [String: Any]()), let o = v as? JSONObject {
            if let acc = o.obj("account") {
                status.loggedIn = true
                status.email = acc.str("email")
                status.plan = acc.str("planType")?.capitalized
            } else {
                status.loggedIn = false
                status.error = "Sin sesión de ChatGPT"
            }
        }
        if status.loggedIn != false, case .success(let v) = await rpc.request("account/rateLimits/read"), let o = v as? JSONObject {
            let parsed = CodexUsage.parseRateLimits(o)
            status.windows = parsed.windows
            if status.plan == nil { status.plan = parsed.plan }
            if let credits = o.obj("rateLimitResetCredits")?.int("availableCount"), credits > 0 {
                status.note = credits == 1 ? "1 reinicio de límites disponible" : "\(credits) reinicios de límites disponibles"
            }
        }
        if case .success(let v) = await rpc.request("model/list", [String: Any]()), let o = v as? JSONObject {
            let list = o.objs("data").filter { $0.bool("hidden") != true }.compactMap { m -> ModelOption? in
                guard let id = m.str("model") ?? m.str("id") else { return nil }
                let efforts = m.objs("supportedReasoningEfforts").compactMap { $0.str("reasoningEffort") }
                return ModelOption(id: id, name: m.str("displayName") ?? id, detail: m.str("description"),
                                   efforts: efforts.isEmpty ? nil : efforts, defaultEffort: m.str("defaultReasoningEffort"))
            }
            if !list.isEmpty { models = list }
        }
        return AccountProbe(status: status, models: models)
    }

    @MainActor private var loginClients: [UUID: RPCClient] = [:]

    /// ChatGPT login through app-server (`account/login/start` → browser), Terminal fallback.
    @MainActor func login(_ account: Account, store: AppStore) {
        guard let launch = Binaries.launch(for: account) else { store.flash(info.missingBinaryHelp); return }
        Task { @MainActor in
            let p = LineProcess(executable: launch.executable, arguments: launch.prefixArgs + ["app-server"], cwd: NSHomeDirectory(), environment: launch.environment)
            let rpc = RPCClient(process: p, includeVersion: false)
            do { try rpc.start() } catch { store.flash(error.localizedDescription); return }
            loginClients[account.id] = rpc
            _ = await rpc.request("initialize", ["clientInfo": ["name": "relevo", "title": "Relevo", "version": "1.0"]])
            rpc.notify("initialized")
            rpc.onNotification = { [weak self] method, params in
                guard method == "account/login/completed" else { return }
                store.flash(params.bool("success") == true
                            ? "Sesión de ChatGPT iniciada en \(account.name)"
                            : "No se completó el login de ChatGPT: \(params.str("error") ?? "")")
                self?.loginClients[account.id]?.terminate()
                self?.loginClients[account.id] = nil
                store.refreshUsage(account.id)
            }
            let result = await rpc.request("account/login/start", ["type": "chatgpt"])
            if case .success(let v) = result, let o = v as? JSONObject, let urlString = o.str("authUrl"), let url = URL(string: urlString) {
                NSWorkspace.shared.open(url)
                store.flash("Completa el login de ChatGPT en el navegador…")
            } else {
                rpc.terminate()
                loginClients[account.id] = nil
                TerminalLauncher.run(Binaries.commandLine(launch, extraArgs: ["login"]), title: "Iniciar sesión en ChatGPT / Codex")
            }
        }
    }
}
