import Foundation
import SwiftUI
import AppKit

/// Declarative definition of a pay-per-use provider with an Anthropic-compatible API, driven through the
/// unmodified Claude Code CLI (the route DeepSeek, Kimi API, MiniMax… document for coding).
/// Built-ins live in `builtIn`; users can add more in `~/Library/Application Support/Relevo/providers.json`.
struct AnthropicAPIConfig: Codable {
    struct Balance: Codable {
        /// GET path relative to `apiRoot`, e.g. "/user/balance".
        var path: String
        /// Response format: "deepseek" ({is_available, balance_infos:[{currency,total_balance}]}).
        var format: String
    }

    var id: String
    var displayName: String
    var shortName: String
    var symbol: String = "cpu"
    var tint: String = "#5B6CFF"
    /// Anthropic-compatible base URL used by Claude Code.
    var baseURL: String
    /// Root of the provider's own REST API (for /models and balance), if any.
    var apiRoot: String?
    var keyURL: String
    var models: [ModelOption]
    var mainModel: String
    var fastModel: String
    var modelsPath: String? = nil
    var balance: Balance? = nil
    var notes: String? = nil

    static let builtIn: [AnthropicAPIConfig] = [
        AnthropicAPIConfig(
            id: "deepseek", displayName: "DeepSeek (API)", shortName: "DeepSeek", symbol: "fish.fill", tint: "#4D6BFE",
            baseURL: "https://api.deepseek.com/anthropic", apiRoot: "https://api.deepseek.com",
            keyURL: "https://platform.deepseek.com/api_keys",
            models: [ModelOption(id: "deepseek-v4-pro", name: "DeepSeek V4 Pro"), ModelOption(id: "deepseek-v4-flash", name: "DeepSeek V4 Flash")],
            mainModel: "deepseek-v4-pro", fastModel: "deepseek-v4-flash",
            modelsPath: "/models", balance: Balance(path: "/user/balance", format: "deepseek"),
            notes: "Pago por uso con API key (DeepSeek no ofrece suscripción ni OAuth)."
        ),
    ]

    static var customFile: URL { AppStore.supportDirectory.appendingPathComponent("providers.json") }

    static func loadCustom() -> [AnthropicAPIConfig] {
        guard let data = try? Data(contentsOf: customFile) else { return [] }
        return (try? JSONDecoder().decode([AnthropicAPIConfig].self, from: data)) ?? []
    }
}

final class AnthropicAPIProvider: Provider {
    let config: AnthropicAPIConfig
    let kind: ProviderKind
    let info: ProviderInfo

    init(config: AnthropicAPIConfig) {
        self.config = config
        self.kind = ProviderKind(config.id)
        self.info = ProviderInfo(
            displayName: config.displayName, shortName: config.shortName, agentName: "Claude Code + \(config.shortName)",
            symbol: config.symbol, tint: Color(hex: config.tint) ?? .indigo,
            auth: .apiKey(help: (config.notes.map { $0 + " " } ?? "") + "Relevo guarda la clave en tu Llavero y solo la envía a la API oficial del proveedor.",
                          keyURL: URL(string: config.keyURL) ?? URL(string: "https://example.com")!),
            missingBinaryHelp: "\(config.shortName) se usa a través de Claude Code: instala la CLI `claude`.",
            autoDetect: false
        )
    }

    var fallbackModels: [ModelOption] { config.models }

    var quickPriority: Int { 0 }   // fractions of a cent, no subscription quota

    var quickModelName: String? { "\(config.models.first { $0.id == config.fastModel }?.name ?? config.fastModel) · API" }

    /// Direct call to the provider's Anthropic-compatible Messages API with the fast model (thinking off).
    @MainActor func quickCompletion(account: Account, system: String, prompt: String) async -> String? {
        guard let key = Keychain.get(Keychain.apiKeyName(account.id)), let url = URL(string: config.baseURL + "/v1/messages") else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue(key, forHTTPHeaderField: "x-api-key")
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 30
        req.httpBody = JSONUtil.encode([
            "model": config.fastModel, "max_tokens": 40, "system": system,
            "thinking": ["type": "disabled"],
            "messages": [["role": "user", "content": prompt]],
        ] as JSONObject)
        guard let (data, resp) = try? await URLSession.shared.data(for: req), (resp as? HTTPURLResponse)?.statusCode == 200,
              let o = JSONUtil.parseAny(data) as? JSONObject else { return nil }
        return o.objs("content").first { $0.str("type") == "text" }?.str("text")
    }

    func launch(for account: Account, env baseEnv: [String: String], executableOverride: String?) -> Launch? {
        guard let path = resolve(cliCandidates("claude"), override: executableOverride) else { return nil }
        var env = baseEnv
        // Own config dir: never touches the user's Claude logins, sessions or settings.
        let dir = expandTilde(account.configDir?.isEmpty == false ? account.configDir! : "~/.relevo/accounts/\(config.id)")
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        env["CLAUDE_CONFIG_DIR"] = dir
        env.removeValue(forKey: "ANTHROPIC_API_KEY")
        env["ANTHROPIC_BASE_URL"] = config.baseURL
        if let key = Keychain.get(Keychain.apiKeyName(account.id)) { env["ANTHROPIC_AUTH_TOKEN"] = key }
        env["ANTHROPIC_DEFAULT_OPUS_MODEL"] = config.mainModel
        env["ANTHROPIC_DEFAULT_SONNET_MODEL"] = config.mainModel
        env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = config.fastModel
        env["ANTHROPIC_SMALL_FAST_MODEL"] = config.fastModel
        env["CLAUDE_CODE_SUBAGENT_MODEL"] = config.fastModel
        env["API_TIMEOUT_MS"] = "600000"
        env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
        return Launch(executable: path, environment: env)
    }

    @MainActor func makeSession(account: Account, cwd: String, model: String, mode: PermissionMode, resumeId: String?) -> AgentSession {
        ClaudeAgent(account: account, cwd: cwd, model: model, mode: mode, resumeId: resumeId)
    }

    @MainActor func login(_ account: Account, store: AppStore) {
        if case .apiKey(_, let url) = info.auth { NSWorkspace.shared.open(url) }
        store.flash("Crea una API key en \(config.shortName) y pégala en Ajustes › Suscripciones › \(account.name)")
    }

    /// Balance + model list from the provider's official API with the user's key.
    @MainActor func probe(_ account: Account) async -> AccountProbe {
        guard let key = Keychain.get(Keychain.apiKeyName(account.id)), !key.isEmpty else {
            return AccountProbe(status: AccountStatus(loggedIn: false, error: "Añade tu API key de \(config.shortName) en Ajustes"))
        }
        var status = AccountStatus(loggedIn: true, plan: "Pago por uso")
        guard let root = config.apiRoot else { return AccountProbe(status: status) }
        func get(_ path: String) async -> (Int, JSONObject?) {
            guard let url = URL(string: root + path) else { return (0, nil) }
            var req = URLRequest(url: url)
            req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Accept")
            req.timeoutInterval = 20
            guard let (data, resp) = try? await URLSession.shared.data(for: req) else { return (0, nil) }
            return ((resp as? HTTPURLResponse)?.statusCode ?? 0, JSONUtil.parseAny(data) as? JSONObject)
        }
        var models: [ModelOption]?
        if let path = config.modelsPath {
            let (code, body) = await get(path)
            if code == 401 { return AccountProbe(status: AccountStatus(loggedIn: false, error: "API key de \(config.shortName) no válida")) }
            let list = (body?.objs("data") ?? []).compactMap { m -> ModelOption? in
                guard let id = m.str("id") else { return nil }
                return ModelOption(id: id, name: config.models.first { $0.id == id }?.name ?? Self.prettyName(id))
            }
            if !list.isEmpty { models = list }
        }
        if let balance = config.balance {
            let (code, body) = await get(balance.path)
            if code == 401 { return AccountProbe(status: AccountStatus(loggedIn: false, error: "API key de \(config.shortName) no válida")) }
            if let body, balance.format == "deepseek" {
                let infos = body.objs("balance_infos")
                status.note = infos.isEmpty ? nil : infos.map { info -> String in
                    let total = Double(info.str("total_balance") ?? "") ?? 0
                    return "Saldo: " + total.formatted(.number.precision(.fractionLength(2))) + " " + (info.str("currency") ?? "")
                }.joined(separator: " · ")
                if body.bool("is_available") == false {
                    status.exhaustedUntil = Date().addingTimeInterval(365 * 86_400)
                    status.error = "Sin saldo en \(config.shortName)"
                }
            } else if body == nil {
                status.error = "No se pudo consultar el saldo"
            }
        }
        return AccountProbe(status: status, models: models)
    }

    private static func prettyName(_ id: String) -> String {
        id.split(separator: "-").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }
}

extension Color {
    init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
}
