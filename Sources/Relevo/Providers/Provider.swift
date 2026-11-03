import Foundation
import SwiftUI

/// Identifier of a provider, persisted as its raw string ("claude", "codex", …).
/// Everything else about a provider lives in its `Provider` definition, looked up in `ProviderRegistry`.
struct ProviderKind: RawRepresentable, Codable, Hashable, Identifiable {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    init(_ rawValue: String) { self.rawValue = rawValue }

    init(from decoder: Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }

    var id: String { rawValue }

    static let claude = ProviderKind("claude")
    static let codex = ProviderKind("codex")
    static let gemini = ProviderKind("gemini")
    static let zai = ProviderKind("zai")
    static let kimi = ProviderKind("kimi")

    var provider: Provider { ProviderRegistry.provider(for: self) }
    var info: ProviderInfo { provider.info }

    // Convenience pass-throughs used across the UI.
    var displayName: String { info.displayName }
    var shortName: String { info.shortName }
    var agentName: String { info.agentName }
    var symbol: String { info.symbol }
    var tint: Color { info.tint }
    var usesAPIKey: Bool { info.usesAPIKey }
    var fallbackModels: [ModelOption] { provider.fallbackModels }

    static var allCases: [ProviderKind] { ProviderRegistry.all.map(\.kind) }
}

enum ProviderAuth {
    /// OAuth / subscription login performed by the provider's official CLI.
    case cliLogin(help: String)
    /// Pay-per-use API key, stored by Relevo in the macOS Keychain.
    case apiKey(help: String, keyURL: URL)
}

/// Optional folder that isolates Relevo's session of a provider from the CLI you use elsewhere.
struct IsolationSpec {
    var label: String
    var apply: (_ dir: String, _ env: inout [String: String]) -> Void
}

struct ProviderInfo {
    var displayName: String
    var shortName: String
    var agentName: String
    var symbol: String
    var tint: Color
    var auth: ProviderAuth
    var isolation: IsolationSpec? = nil
    var missingBinaryHelp: String
    /// Added automatically on first launch when its CLI is installed.
    var autoDetect: Bool = true

    var usesAPIKey: Bool { if case .apiKey = auth { return true } else { return false } }

    var authHelp: String {
        switch auth {
        case .cliLogin(let help), .apiKey(let help, _): return help
        }
    }
}

/// A provider = metadata + how to find/launch its official CLI + which protocol adapter talks to it
/// + how to read its limits + how to sign in. One type per provider, registered in `ProviderRegistry`.
protocol Provider: AnyObject {
    var kind: ProviderKind { get }
    var info: ProviderInfo { get }
    var fallbackModels: [ModelOption] { get }

    /// Resolves the executable and environment. `env` already has the shell environment and isolation applied.
    func launch(for account: Account, env: [String: String], executableOverride: String?) -> Launch?
    @MainActor func makeSession(account: Account, cwd: String, model: String, mode: PermissionMode, resumeId: String?) -> AgentSession
    @MainActor func probe(_ account: Account) async -> AccountProbe
    @MainActor func login(_ account: Account, store: AppStore)
    /// Reasoning levels for a model when the model list does not declare them.
    func defaultEfforts(model: String) -> [String]?
    /// Models known locally without asking the provider (e.g. from a bundled config).
    func localModels() -> [ModelOption]?
    /// Cheapest model for tiny utility tasks (titles…), or nil if the provider can't do one-shot calls.
    var quickModelName: String? { get }
    /// Lower = preferred for utility calls (cheaper / faster).
    var quickPriority: Int { get }
    /// One-shot completion with that cheap model, no tools and no reasoning.
    @MainActor func quickCompletion(account: Account, system: String, prompt: String) async -> String?
    /// Usage windows a model consumes, when a provider has separate quotas per model family.
    func usageWindows(_ windows: [UsageWindow], model: ModelOption) -> [UsageWindow]
}

extension Provider {
    func defaultEfforts(model: String) -> [String]? { nil }
    func localModels() -> [ModelOption]? { nil }
    var quickModelName: String? { nil }
    var quickPriority: Int { 100 }
    @MainActor func quickCompletion(account: Account, system: String, prompt: String) async -> String? { nil }
    func usageWindows(_ windows: [UsageWindow], model: ModelOption) -> [UsageWindow] { windows }

    /// Helper: first existing executable among candidates (or the user override).
    func resolve(_ candidates: [String?], override: String?) -> String? {
        if let o = override.map(expandTilde), FileManager.default.isExecutableFile(atPath: o) { return o }
        return candidates.compactMap { $0 }.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    func cliCandidates(_ name: String, extra: [String] = []) -> [String?] {
        [ShellEnvironment.which(name), "\(NSHomeDirectory())/.local/bin/\(name)", "/opt/homebrew/bin/\(name)", "/usr/local/bin/\(name)"] + extra.map { Optional($0) }
    }
}

/// The list of providers Relevo knows. Add or remove a provider here.
enum ProviderRegistry {
    static let builtIn: [Provider] = [
        ClaudeProvider(),
        CodexProvider(),
        AntigravityProvider(),
        KimiProvider(),
        ZaiProvider(),
    ] + AnthropicAPIConfig.builtIn.map { AnthropicAPIProvider(config: $0) }

    /// Extra Anthropic-compatible API providers declared by the user in providers.json (no code needed).
    static let custom: [Provider] = AnthropicAPIConfig.loadCustom()
        .filter { c in !builtIn.contains { $0.kind.rawValue == c.id } }
        .map { AnthropicAPIProvider(config: $0) }

    static let all: [Provider] = builtIn + custom

    static func find(_ raw: String) -> Provider? { all.first { $0.kind.rawValue == raw } }

    static func provider(for kind: ProviderKind) -> Provider {
        find(kind.rawValue) ?? UnknownProvider(kind: kind)
    }
}

/// Placeholder for accounts whose provider was removed: keeps old threads readable.
final class UnknownProvider: Provider {
    let kind: ProviderKind
    init(kind: ProviderKind) { self.kind = kind }
    var info: ProviderInfo {
        ProviderInfo(displayName: kind.rawValue, shortName: kind.rawValue, agentName: kind.rawValue, symbol: "questionmark",
                     tint: .gray, auth: .cliLogin(help: "Proveedor no disponible en esta versión de Relevo."),
                     missingBinaryHelp: "Proveedor «\(kind.rawValue)» no disponible.", autoDetect: false)
    }
    var fallbackModels: [ModelOption] { [] }
    func launch(for account: Account, env: [String: String], executableOverride: String?) -> Launch? { nil }
    @MainActor func makeSession(account: Account, cwd: String, model: String, mode: PermissionMode, resumeId: String?) -> AgentSession {
        UnavailableSession(message: info.missingBinaryHelp)
    }
    @MainActor func probe(_ account: Account) async -> AccountProbe { AccountProbe(status: AccountStatus(error: info.missingBinaryHelp)) }
    @MainActor func login(_ account: Account, store: AppStore) { store.flash(info.missingBinaryHelp) }
}

@MainActor
final class UnavailableSession: AgentSession {
    var onEvent: ((AgentEvent) -> Void)?
    let message: String
    init(message: String) { self.message = message }
    func start() throws { throw AgentFailure(kind: .other, message: message) }
    func send(_ text: String) {}
    func setModel(_ model: String) {}
    func setMode(_ mode: PermissionMode) {}
    func setEffort(_ effort: String?) {}
    func interrupt() {}
    func close() {}
}
