import Foundation

/// Tokens one model spent in a turn, normalized across CLIs: `input` is the prompt read without cache,
/// `cacheRead` / `cacheWrite` the cached parts, and `output` includes reasoning (`reasoning` is part of it).
struct TokenUsage: Codable, Hashable {
    /// Model id the CLI reports (e.g. `claude-opus-5-5`), when it says.
    var model: String?
    var input = 0
    var cacheRead = 0
    var cacheWrite = 0
    var output = 0
    var reasoning = 0
    /// Cost the CLI reports at list prices (Claude Code does), in USD.
    var costUSD: Double?

    var prompt: Int { input + cacheRead + cacheWrite }
    var total: Int { prompt + output }
    /// Prompt tokens processed without cache: what a model or provider switch makes you pay again.
    var cold: Int { input + cacheWrite }
    var cacheShare: Double? { prompt > 0 ? Double(cacheRead) / Double(prompt) : nil }
    var isEmpty: Bool { total == 0 }

    static func + (a: TokenUsage, b: TokenUsage) -> TokenUsage {
        TokenUsage(model: a.model ?? b.model, input: a.input + b.input, cacheRead: a.cacheRead + b.cacheRead,
                   cacheWrite: a.cacheWrite + b.cacheWrite, output: a.output + b.output, reasoning: a.reasoning + b.reasoning,
                   costUSD: a.costUSD.map { $0 + (b.costUSD ?? 0) } ?? b.costUSD)
    }

    static func - (a: TokenUsage, b: TokenUsage) -> TokenUsage {
        TokenUsage(model: a.model, input: max(0, a.input - b.input), cacheRead: max(0, a.cacheRead - b.cacheRead),
                   cacheWrite: max(0, a.cacheWrite - b.cacheWrite), output: max(0, a.output - b.output),
                   reasoning: max(0, a.reasoning - b.reasoning),
                   costUSD: a.costUSD.map { max(0, $0 - (b.costUSD ?? 0)) })
    }

    /// From counts where `input` may or may not include the cached part (OpenAI and Gemini include it,
    /// Anthropic doesn't). A reported `total` settles which; otherwise `inputIncludesCache` decides.
    static func normalized(model: String?, input: Int, cacheRead: Int, cacheWrite: Int = 0, output: Int,
                           reasoning: Int = 0, total: Int? = nil, inputIncludesCache: Bool) -> TokenUsage {
        var includes = inputIncludesCache
        if let total, total > 0 {
            if abs(total - (input + output)) <= 2, cacheRead + cacheWrite > 0 { includes = true }
            else if abs(total - (input + cacheRead + cacheWrite + output)) <= 2 { includes = false }
        }
        let uncached = includes ? max(0, input - cacheRead - cacheWrite) : input
        return TokenUsage(model: model, input: uncached, cacheRead: cacheRead, cacheWrite: cacheWrite, output: output, reasoning: reasoning)
    }
}

/// Why a turn started with a cold context (most of it had to be processed again instead of read from cache).
enum SwitchKind: String, Codable, CaseIterable {
    case model, provider, effort, resume, idle

    var label: String {
        switch self {
        case .model: return "Cambio de modelo"
        case .provider: return "Relevo a otro agente"
        case .effort: return "Cambio de razonamiento"
        case .resume: return "Agente reabierto"
        case .idle: return "Caché caducada tras una pausa"
        }
    }

    var symbol: String {
        switch self {
        case .model: return "arrow.triangle.swap"
        case .provider: return "arrow.left.arrow.right.circle"
        case .effort: return "brain"
        case .resume: return "arrow.clockwise.circle"
        case .idle: return "clock.badge.exclamationmark"
        }
    }
}

/// What one turn consumed, kept on the turn's last item so every reply shows its cost.
struct TurnUsage: Codable, Hashable {
    /// One entry per model (Claude Code may use a second one for subagents).
    var parts: [TokenUsage]
    /// USD: reported by the CLI or estimated with Relevo's price table; nil when no price is known.
    var cost: Double?
    var costEstimated = false
    /// Pay-per-use API (real money) instead of a subscription, where the cost is only an API equivalent.
    var paid = false
    var switchKind: SwitchKind?
    var switchDetail: String?
    /// Tokens processed again because of the switch (they would have been cache reads).
    var overhead: Int?
    var overheadCost: Double?
    /// Context size at the end of the turn, and the model's window.
    var context: Int?
    var contextWindow: Int?
    var durationMs: Int?
    var tools = 0

    var tokens: TokenUsage { parts.reduce(TokenUsage(), +) }
    var hasTokens: Bool { parts.contains { !$0.isEmpty } }
}

enum TokenFormat {
    /// 950 → "950", 12_300 → "12,3k", 4_200_000 → "4,2M".
    static func short(_ n: Int) -> String {
        let v = Double(n)
        if n < 1000 { return "\(n)" }
        if n < 1_000_000 { return (v / 1000).formatted(.number.precision(.fractionLength(v < 10_000 ? 1 : 0))) + "k" }
        return (v / 1_000_000).formatted(.number.precision(.fractionLength(1))) + "M"
    }

    /// "$0,042", "$1,25", "$120".
    static func usd(_ v: Double) -> String {
        let digits = v < 0.1 ? 3 : v < 100 ? 2 : 0
        return "$" + v.formatted(.number.precision(.fractionLength(digits)))
    }

    static func percent(_ v: Double) -> String { (v * 100).formatted(.number.precision(.fractionLength(0))) + "\u{00A0}%" }

    /// 42 → "42 s", 185 → "3 min 5 s", 3900 → "1 h 5 min".
    static func duration(_ seconds: Double) -> String {
        let s = Int(seconds.rounded())
        if s < 60 { return "\(s) s" }
        if s < 3600 { return "\(s / 60) min" + (s % 60 > 0 ? " \(s % 60) s" : "") }
        return "\(s / 3600) h" + ((s % 3600) / 60 > 0 ? " \((s % 3600) / 60) min" : "")
    }
}

@MainActor
enum ModelNames {
    /// Display name for a model id a CLI reports: the provider's own name when it lists the id,
    /// otherwise a tidy version of the id ("claude-opus-5-5" → "Opus 5.5").
    static func display(_ id: String, account: Account?, store: AppStore) -> String {
        if let account, let m = store.modelsFor(account).first(where: { $0.id == id }) { return cleaned(m.name) }
        var s = id.lowercased()
        if s.hasPrefix("claude-") { s.removeFirst("claude-".count) }
        s = s.replacingOccurrences(of: #"-\d{8}$"#, with: "", options: .regularExpression)
        // Version digits joined by dashes become dotted: "opus-5-5" → "opus 5.5".
        s = s.replacingOccurrences(of: #"(\d+)-(\d+)"#, with: "$1.$2", options: .regularExpression)
        s = s.replacingOccurrences(of: "-", with: " ")
        return s.split(separator: " ").map { part in
            part.first?.isLetter == true && part.count > 2 ? part.prefix(1).uppercased() + part.dropFirst() : String(part).uppercased()
        }.joined(separator: " ")
    }

    /// "Predeterminado (Opus 5.5)" → "Opus 5.5": for stats, the model that actually answered.
    nonisolated static func cleaned(_ name: String) -> String {
        if let open = name.firstIndex(of: "("), let close = name.lastIndex(of: ")"), open < close, name.hasPrefix("Predeterminado") {
            return String(name[name.index(after: open)..<close])
        }
        return name
    }
}

/// One row of the usage table: a turn's tokens for one model, with what's needed for the stats.
struct UsageRecord: Identifiable {
    var id: Int64 = 0
    var threadId: UUID
    var turn: String
    var ts: Date
    var provider: String
    var accountId: UUID?
    var model: String
    var modelName: String
    /// The model that did most of the turn (the others are e.g. subagents).
    var main: Bool
    var tokens: TokenUsage
    var cost: Double?
    var costEstimated: Bool
    var paid: Bool
    var switchKind: SwitchKind?
    var switchDetail: String?
    var overhead: Int?
    var overheadCost: Double?
    var level: String?
    var task: String?
    /// ok | error | limit | stopped
    var result: String?
    var tools: Int
    var durationMs: Int?
    var request: String?
    /// live | import
    var source: String
    /// Context size when the turn ended (main row).
    var context: Int? = nil
}
