import Foundation
import SwiftUI

/// Kimi Code membership through the official Kimi Code CLI: chat over ACP (`kimi acp`), OAuth device login
/// (`kimi login`), and plan quotas from the CLI's own local server (`kimi web` → /api/v1/oauth/usage).
final class KimiProvider: Provider {
    let kind = ProviderKind.kimi

    let info = ProviderInfo(
        displayName: "Kimi Code", shortName: "Kimi", agentName: "Kimi Code",
        symbol: "moon.stars.fill", tint: Color(red: 0.10, green: 0.10, blue: 0.12),
        auth: .cliLogin(help: "Abre Terminal con `kimi login` (código de dispositivo de tu suscripción Kimi Code)."),
        isolation: IsolationSpec(label: "Carpeta de configuración (KIMI_CODE_HOME)") { dir, env in env["KIMI_CODE_HOME"] = dir },
        missingBinaryHelp: "No encuentro Kimi Code CLI (`kimi`). Instálala con `brew install kimi-code`."
    )

    let acp = ACPConfig(args: ["acp"], loginHint: "Kimi Code necesita iniciar sesión: Ajustes › Suscripciones › Kimi › Iniciar sesión.")

    var fallbackModels: [ModelOption] { [ModelOption(id: "", name: "Predeterminado")] }

    func launch(for account: Account, env: [String: String], executableOverride: String?) -> Launch? {
        guard let path = resolve(cliCandidates("kimi"), override: executableOverride) else { return nil }
        return Launch(executable: path, environment: env)
    }

    @MainActor func makeSession(account: Account, cwd: String, model: String, mode: PermissionMode, resumeId: String?) -> AgentSession {
        ACPAgent(account: account, config: acp, cwd: cwd, model: model, mode: mode, resumeId: resumeId)
    }

    @MainActor func login(_ account: Account, store: AppStore) {
        guard let launch = Binaries.launch(for: account) else { store.flash(info.missingBinaryHelp); return }
        TerminalLauncher.run(Binaries.commandLine(launch, extraArgs: ["login"]),
                             title: "Iniciar sesión en Kimi Code (\(account.name)). Elige la región de tu suscripción y abre la URL que aparece.")
    }

    private func home(_ launch: Launch) -> String {
        launch.environment["KIMI_CODE_HOME"] ?? "\(NSHomeDirectory())/.kimi-code"
    }

    /// Plan quotas through the CLI's own local server, authenticated with the server token the CLI
    /// writes for exactly this purpose (`<home>/server.token`). No Kimi account token is read.
    @MainActor func probe(_ account: Account) async -> AccountProbe {
        guard let launch = Binaries.launch(for: account) else {
            return AccountProbe(status: AccountStatus(error: "CLI `kimi` no encontrada"))
        }
        let home = home(launch)
        let credentials = (try? FileManager.default.contentsOfDirectory(atPath: "\(home)/credentials")) ?? []
        guard !credentials.isEmpty else {
            return AccountProbe(status: AccountStatus(loggedIn: false, error: "Inicia sesión en Kimi Code"))
        }
        let port = Int.random(in: 49_500...60_500)
        let p = LineProcess(executable: launch.executable,
                            arguments: launch.prefixArgs + ["web", "--no-open", "--port", "\(port)", "--log-level", "silent"],
                            cwd: NSHomeDirectory(), environment: launch.environment)
        do { try p.start() } catch {
            return AccountProbe(status: AccountStatus(loggedIn: true, error: error.localizedDescription))
        }
        defer { p.terminate() }
        let base = "http://127.0.0.1:\(port)/api/v1"
        var healthy = false
        for _ in 0..<40 {
            try? await Task.sleep(nanoseconds: 250_000_000)
            if let (_, resp) = try? await URLSession.shared.data(from: URL(string: "\(base)/healthz")!),
               (resp as? HTTPURLResponse)?.statusCode == 200 { healthy = true; break }
        }
        guard healthy, let token = (try? String(contentsOfFile: "\(home)/server.token", encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return AccountProbe(status: AccountStatus(loggedIn: true, error: "No se pudo consultar el uso de Kimi"))
        }
        var req = URLRequest(url: URL(string: "\(base)/oauth/usage")!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 20
        guard let (data, _) = try? await URLSession.shared.data(for: req), let o = JSONUtil.parseAny(data) as? JSONObject else {
            return AccountProbe(status: AccountStatus(loggedIn: true, error: "Kimi no devolvió el uso"))
        }
        return AccountProbe(status: Self.parseUsage(o))
    }

    /// Envelope → `usages { limit5h, limit7d, monthTotal, monthCode: { usedRatio, resetAt } }`.
    static func parseUsage(_ o: JSONObject) -> AccountStatus {
        func find(_ key: String, in value: Any?, depth: Int = 0) -> JSONObject? {
            guard depth < 5, let dict = value as? JSONObject else { return nil }
            if let hit = dict.obj(key) { return hit }
            for v in dict.values { if let hit = find(key, in: v, depth: depth + 1) { return hit } }
            return nil
        }
        var status = AccountStatus(loggedIn: true, plan: "Kimi Code")
        let labels: [(String, String)] = [("limit5h", "5 h"), ("limit7d", "Semana"), ("monthCode", "Mes"), ("monthTotal", "Mes (total)")]
        for (key, label) in labels {
            guard let entry = find(key, in: o), let ratio = entry.num("usedRatio") else { continue }
            status.windows.append(UsageWindow(id: key, label: label, percent: min(100, ratio <= 1 ? ratio * 100 : ratio), resetsAt: DateParse.any(entry["resetAt"])))
        }
        if status.windows.isEmpty {
            let message = find("data", in: o)?.str("message") ?? o.str("message") ?? o.obj("error")?.str("message")
            if let m = message, LimitDetector.isNoPlan(m) {
                status.noPlan = true
                status.error = "Tu plan actual no incluye Kimi Code"
            } else if let m = message, LimitDetector.isAuth(m) {
                status.loggedIn = false
                status.error = m
            } else if find("quota", in: o)?.obj("usages")?.isEmpty == true {
                // Signed in but without any Kimi Code quota: what the server answers once the membership lapses
                // (chat then fails with 403 "Your current subscription does not have access to Kimi Code").
                status.noPlan = true
                status.error = "Tu plan actual no incluye Kimi Code"
            } else {
                status.error = message ?? "Sin datos de cuota"
            }
        }
        return status
    }
}
