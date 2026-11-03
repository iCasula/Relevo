import Foundation
import SwiftUI
import CryptoKit

/// Z.ai GLM Coding Plan through the ZCode CLI bundled in ZCode.app and its browser login.
final class ZaiProvider: Provider {
    let kind = ProviderKind.zai

    let info = ProviderInfo(
        displayName: "Z.ai · GLM", shortName: "Z.ai", agentName: "ZCode",
        symbol: "bolt.fill", tint: Color(red: 0.52, green: 0.38, blue: 0.95),
        auth: .cliLogin(help: "Abre Terminal con `zcode login zai` (autorización en el navegador del GLM Coding Plan)."),
        missingBinaryHelp: "No encuentro ZCode. Instala la app ZCode de Z.ai."
    )

    var fallbackModels: [ModelOption] {
        ["GLM-5.3", "GLM-5.3-Flash", "GLM-5.2", "GLM-5-Turbo"].map { ModelOption(id: $0, name: $0) }
    }

    func localModels() -> [ModelOption]? { ZaiConfig.models() }

    func launch(for account: Account, env baseEnv: [String: String], executableOverride: String?) -> Launch? {
        if let path = resolve([ShellEnvironment.which("zcode")], override: executableOverride) {
            return Launch(executable: path, environment: baseEnv)
        }
        for app in Binaries.appBundles("ZCode.app") {
            let exe = "\(app)/Contents/MacOS/ZCode"
            let script = "\(app)/Contents/Resources/glm/zcode.cjs"
            let builtin = "\(app)/Contents/Resources/config/provider/zcode-builtin.json"
            guard FileManager.default.isExecutableFile(atPath: exe), FileManager.default.fileExists(atPath: script) else { continue }
            var env = baseEnv
            env["ELECTRON_RUN_AS_NODE"] = "1"
            var exported = ["ELECTRON_RUN_AS_NODE"]
            if FileManager.default.fileExists(atPath: builtin) {
                env["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"] = builtin
                exported.append("ZCODE_BUILTIN_PROVIDER_CONFIG_FILE")
            }
            return Launch(executable: exe, prefixArgs: [script], environment: env, exported: exported)
        }
        return nil
    }

    @MainActor func makeSession(account: Account, cwd: String, model: String, mode: PermissionMode, resumeId: String?) -> AgentSession {
        ZaiAgent(account: account, cwd: cwd, model: model, mode: mode, resumeId: resumeId)
    }

    @MainActor func login(_ account: Account, store: AppStore) {
        guard let launch = Binaries.launch(for: account) else { store.flash(info.missingBinaryHelp); return }
        TerminalLauncher.run(Binaries.commandLine(launch, extraArgs: ["login", "zai"]), title: "Iniciar sesión en Z.ai (\(account.name))")
    }

    /// GLM Coding Plan quota with the ZCode login.
    @MainActor func probe(_ account: Account) async -> AccountProbe {
        let models = ZaiConfig.models()
        guard let creds = ZaiCredentials.load() else {
            return AccountProbe(status: AccountStatus(loggedIn: false, error: "Inicia sesión en ZCode"), models: models)
        }
        var status = AccountStatus(loggedIn: true, email: creds.email)
        var req = URLRequest(url: URL(string: "https://api.z.ai/api/monitor/usage/quota/limit")!)
        req.setValue("Bearer \(creds.token)", forHTTPHeaderField: "Authorization")
        req.setValue("es-ES,en", forHTTPHeaderField: "Accept-Language")
        req.timeoutInterval = 20
        guard let (data, resp) = try? await URLSession.shared.data(for: req), let o = JSONUtil.parseAny(data) as? JSONObject else {
            status.error = "Sin conexión con Z.ai"
            return AccountProbe(status: status, models: models)
        }
        if (resp as? HTTPURLResponse)?.statusCode == 401 {
            return AccountProbe(status: AccountStatus(loggedIn: false, error: "La sesión de Z.ai ha caducado"), models: models)
        }
        let payload = o.obj("data") ?? [:]
        status.plan = payload.str("level")?.capitalized
        status.windows = payload.objs("limits").compactMap { l in
            guard let pct = l.num("percentage") else { return nil }
            let unit = l.int("unit") ?? 0
            let n = l.int("number") ?? 1
            let label: String
            switch unit {
            case 3: label = "\(n) h"
            case 4: label = n == 1 ? "Día" : "\(n) d"
            case 6: label = n == 1 ? "Semana" : "\(n) sem"
            case 5: label = n == 1 ? "Mes" : "\(n) meses"
            default: label = l.str("type") ?? "Límite"
            }
            var detail: String?
            if let used = l.num("currentValue"), let total = l.num("usage") { detail = "\(Int(used)) / \(Int(total))" }
            return UsageWindow(id: "\(unit)-\(n)", label: label, percent: pct, resetsAt: DateParse.any(l["nextResetTime"]), detail: detail)
        }
        if status.windows.isEmpty, let msg = o.str("msg"), o.int("code") != 200 {
            let expired = o.int("code") == 401 || msg.contains("令牌") || msg.lowercased().contains("token")
            status = expired
                ? AccountStatus(loggedIn: false, error: "La sesión de Z.ai ha caducado: abre ZCode o pulsa «Iniciar sesión»")
                : AccountStatus(loggedIn: true, email: creds.email, error: msg)
        }
        return AccountProbe(status: status, models: models)
    }
}

struct ZaiCredentials {
    var token: String
    var email: String?

    /// ZCode keeps its OAuth tokens in ~/.zcode/v2/credentials.json (AES-256-GCM, locally derived key).
    static func load() -> ZaiCredentials? {
        let path = "\(NSHomeDirectory())/.zcode/v2/credentials.json"
        guard let data = FileManager.default.contents(atPath: path), let o = JSONUtil.parseAny(data) as? JSONObject else { return nil }
        let provider = decrypt(o.str("oauth:active_provider")) ?? "zai"
        let family = provider.contains("bigmodel") ? "bigmodel" : "zai"
        guard let token = decrypt(o.str("oauth:\(family):access_token")), !token.isEmpty else { return nil }
        var email: String?
        if let info = decrypt(o.str("oauth:\(family):user_info")), let u = JSONUtil.parseAny(Data(info.utf8)) as? JSONObject {
            email = u.str("email")
        }
        if let exp = JWT.claim("exp", in: token).flatMap(Double.init), Date(timeIntervalSince1970: exp) < Date() { return nil }
        return ZaiCredentials(token: token, email: email)
    }

    private static func decrypt(_ value: String?) -> String? {
        guard let value else { return nil }
        let prefix = "enc:v1:"
        guard value.hasPrefix(prefix) else { return value }
        let parts = value.dropFirst(prefix.count).split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, let iv = b64url(String(parts[0])), let tag = b64url(String(parts[1])), let ct = b64url(String(parts[2])) else { return nil }
        let secret = ProcessInfo.processInfo.environment["ZCODE_CREDENTIAL_SECRET"] ?? "zcode-credential-fallback:darwin:\(NSHomeDirectory()):\(NSUserName())"
        let key = SymmetricKey(data: SHA256.hash(data: Data(secret.utf8)))
        guard let nonce = try? AES.GCM.Nonce(data: iv),
              let box = try? AES.GCM.SealedBox(nonce: nonce, ciphertext: ct, tag: tag),
              let plain = try? AES.GCM.open(box, using: key) else { return nil }
        return String(data: plain, encoding: .utf8)
    }

    private static func b64url(_ s: String) -> Data? {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        return Data(base64Encoded: b)
    }
}
