import Foundation
import SwiftUI

/// Gemini through Google's official Antigravity CLI (`agy`). Relevo never reads or refreshes Google tokens
/// for API calls; limits come from `agy -p=/usage`. Persisted id stays "gemini".
final class AntigravityProvider: Provider {
    let kind = ProviderKind.gemini

    let info = ProviderInfo(
        displayName: "Gemini", shortName: "Gemini", agentName: "Antigravity",
        symbol: "sparkle", tint: Color(red: 0.27, green: 0.52, blue: 0.96),
        auth: .cliLogin(help: "Abre Terminal con Antigravity CLI (`agy`) para iniciar sesión con tu cuenta de Google."),
        // agy keeps its login in the keychain under a fixed name; with its own HOME it can't see it,
        // so a second (e.g. personal) login stays inside this folder.
        isolation: IsolationSpec(label: "Carpeta aislada para agy (HOME propio)") { dir, env in
            for (k, v) in AntigravityHome.prepare(dir) { env[k] = v }
        },
        missingBinaryHelp: "No encuentro Antigravity CLI (`agy`). Instala Antigravity desde https://antigravity.google."
    )

    var fallbackModels: [ModelOption] {
        ["high", "medium", "low"].map {
            ModelOption(id: "gemini-3.8-flash-\($0)", name: "Gemini 3.8 Flash (\($0.capitalized))", efforts: EffortLevels.standard)
        }
    }

    func defaultEfforts(model: String) -> [String]? { EffortLevels.standard }

    var quickModelName: String? { "Gemini 3.8 Flash (Low)" }
    var quickPriority: Int { 20 }

    /// Antigravity has separate quotas for Gemini models and for Claude/GPT models.
    func usageWindows(_ windows: [UsageWindow], model: ModelOption) -> [UsageWindow] {
        let isGemini = "\(model.id) \(model.name)".lowercased().contains("gemini")
        let scoped = windows.filter { $0.label.lowercased().contains("gemini") == isGemini }
        return scoped.isEmpty ? windows : scoped
    }

    @MainActor func quickCompletion(account: Account, system: String, prompt: String) async -> String? {
        guard let launch = Binaries.launch(for: account) else { return nil }
        let args = ["--output-format", "stream-json", "--model", "gemini-3.8-flash-low",
                    "--mode", "plan", "--disable-slash-commands", "-p=\(system)\n\n\(prompt)"]
        guard case .output(let out, _) = await AntigravityRuns.background(account, launch, args, timeout: 45) else { return nil }
        return out.split(separator: "\n").compactMap { JSONUtil.parse(String($0)) }
            .last { $0.str("event") == "result" }?.obj("result")?.str("response")
    }

    func launch(for account: Account, env: [String: String], executableOverride: String?) -> Launch? {
        guard let path = resolve(cliCandidates("agy"), override: executableOverride) else { return nil }
        return Launch(executable: path, environment: env)
    }

    @MainActor func makeSession(account: Account, cwd: String, model: String, mode: PermissionMode, resumeId: String?) -> AgentSession {
        AntigravityAgent(account: account, cwd: cwd, model: model, mode: mode, resumeId: resumeId)
    }

    /// `agy -p=/usage` (no model call), then `agy models`. One after the other: two agy processes refreshing
    /// an expired token at once corrupt the saved login.
    @MainActor func probe(_ account: Account) async -> AccountProbe {
        guard let launch = Binaries.launch(for: account) else {
            return AccountProbe(status: AccountStatus(error: "Antigravity CLI (`agy`) no encontrada"))
        }
        let signedOut = AccountProbe(status: AccountStatus(loggedIn: false, error: "Inicia sesión en Antigravity"))
        let home = AntigravityRuns.home(of: launch)
        guard case .output(let usageOut, let usageErr) = await AntigravityRuns.background(account, launch, ["-p=/usage"]) else {
            return signedOut
        }
        var status = AccountStatus(loggedIn: true, plan: "Antigravity", email: Self.email(home: home))
        status.windows = AntigravityUsage.parse(usageOut)
        if status.windows.isEmpty {
            let err = (usageErr + usageOut).trimmingCharacters(in: .whitespacesAndNewlines)
            if err.lowercased().contains("sign in") || err.lowercased().contains("not logged") || LimitDetector.isAuth(err) {
                return signedOut
            }
            status.error = err.isEmpty ? "No se pudo leer el uso" : String(err.suffix(200))
        }
        var list: [ModelOption] = []
        if case .output(let modelsOut, _) = await AntigravityRuns.background(account, launch, ["models"]) {
            list = AntigravityUsage.parseModels(modelsOut)
        }
        return AccountProbe(status: status, models: list.isEmpty ? nil : list)
    }

    @MainActor func login(_ account: Account, store: AppStore) {
        guard let launch = Binaries.launch(for: account) else { store.flash(info.missingBinaryHelp); return }
        let isolated = account.configDir?.isEmpty == false
        TerminalLauncher.run(Binaries.commandLine(launch, extraArgs: []),
                             title: "Iniciar sesión en Antigravity (Gemini)\(isolated ? " · cuenta aislada de Relevo; tu agy de siempre no se toca" : ""). Cuando veas el prompt, sal con /exit o Ctrl+C.")
    }

    /// Account email from the local session file (`id_token_email`, or the email claim of `id_token`).
    static func email(home: String) -> String? {
        let dir = "\(home)/.gemini/antigravity-cli"
        var candidates = ["\(dir)/antigravity-oauth-token"]
        if let files = try? FileManager.default.contentsOfDirectory(atPath: dir) {
            candidates += files.filter { ["auth", "token", "cred"].contains(where: $0.lowercased().contains) }.map { "\(dir)/\($0)" }
        }
        for path in candidates {
            guard let attrs = try? FileManager.default.attributesOfItem(atPath: path), (attrs[.size] as? Int ?? 0) < 64_000,
                  let data = FileManager.default.contents(atPath: path), let o = JSONUtil.parseAny(data) as? JSONObject else { continue }
            if let email = o.str("id_token_email") ?? o.obj("token")?.str("id_token_email") { return email }
            if let idToken = o.str("id_token") ?? o.obj("token")?.str("id_token"), let email = JWT.claim("email", in: idToken) { return email }
        }
        return nil
    }
}

enum JWT {
    static func claim(_ name: String, in token: String) -> String? {
        let parts = token.split(separator: ".")
        guard parts.count >= 2 else { return nil }
        var b = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        guard let payload = Data(base64Encoded: b), let claims = JSONUtil.parseAny(payload) as? JSONObject else { return nil }
        return claims.str(name)
    }
}
