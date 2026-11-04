import Foundation

/// API list prices per million tokens, kept as data: ordered `pattern → prices` rules matched against
/// "<provider> <model id> <model name>" (lowercased), first match wins. Subscriptions don't bill per token,
/// so for them these are an API equivalent to compare models; for pay-per-use APIs they estimate real spend.
/// ~/Library/Application Support/Relevo/model-prices.json can add rules (they take precedence) or replace `asOf`.
struct ModelPricing: Codable {
    struct Price: Codable {
        var match: String
        var input: Double
        var output: Double
        /// Cached prompt tokens; defaults to 10 % of `input`.
        var cacheRead: Double?
        /// Writing the prompt cache; defaults to `input` (providers that cache for free bill it as input).
        var cacheWrite: Double?
        var note: String?

        var read: Double { cacheRead ?? input * 0.1 }
        var write: Double { cacheWrite ?? input }

        func cost(_ u: TokenUsage) -> Double {
            let fresh: Double = Double(u.input) * input
            let cached: Double = Double(u.cacheRead) * read + Double(u.cacheWrite) * write
            let generated: Double = Double(u.output) * output
            return (fresh + cached + generated) / 1_000_000
        }

        /// Average price of the tokens processed without cache in this usage.
        func coldPrice(_ u: TokenUsage) -> Double {
            guard u.cold > 0 else { return input }
            return (Double(u.input) * input + Double(u.cacheWrite) * write) / Double(u.cold)
        }
    }

    var asOf: String
    var prices: [Price]

    // Claude: Anthropic list prices, cache writes at the 1-hour rate (2× input) that Claude Code uses.
    // Others: providers' published rates as of the date; intro or peak prices noted.
    static let defaultJSON = #"""
    {
      "asOf": "2026-11-04",
      "prices": [
        { "match": "fable.?5.?1", "input": 10, "output": 50, "cacheRead": 0.25, "cacheWrite": 20 },
        { "match": "fable", "input": 10, "output": 50, "cacheRead": 1, "cacheWrite": 20 },
        { "match": "opus.?5.?5", "input": 4, "output": 20, "cacheRead": 0.2, "cacheWrite": 8 },
        { "match": "opus", "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 10 },
        { "match": "sonnet.?5", "input": 2, "output": 10, "cacheRead": 0.2, "cacheWrite": 4 },
        { "match": "sonnet", "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 6 },
        { "match": "haiku.?5", "input": 0.1, "output": 0.5, "cacheRead": 0.01, "cacheWrite": 0.2 },
        { "match": "haiku", "input": 1, "output": 5, "cacheRead": 0.1, "cacheWrite": 2 },
        { "match": "astra", "input": 10, "output": 50, "cacheRead": 1 },
        { "match": "[ -]sol\\b", "input": 2, "output": 10, "cacheRead": 0.1 },
        { "match": "terra", "input": 1, "output": 5, "cacheRead": 0.05 },
        { "match": "luna", "input": 0.1, "output": 0.5, "cacheRead": 0.01 },
        { "match": "gemini.*flash", "input": 0.75, "output": 3.75, "cacheRead": 0.075, "note": "precio de lanzamiento hasta el 31-12-2026" },
        { "match": "glm.*flash", "input": 0.15, "output": 0.5, "cacheRead": 0.03 },
        { "match": "glm", "input": 1.4, "output": 4.4, "cacheRead": 0.26 },
        { "match": "deepseek.*flash", "input": 0.3, "output": 1.2, "cacheRead": 0.006, "note": "tarifa en hora punta; en horario valle cuesta la mitad" },
        { "match": "deepseek", "input": 1.32, "output": 3.96, "cacheRead": 0.044, "note": "tarifa en hora punta; en horario valle cuesta la mitad" },
        { "match": "kimi.*k3|\\bk3\\b", "input": 3, "output": 15, "cacheRead": 0.3 },
        { "match": "kimi|\\bk2", "input": 0.95, "output": 4, "cacheRead": 0.16 }
      ]
    }
    """#

    static var userFile: URL { AppStore.supportDirectory.appendingPathComponent("model-prices.json") }

    static let shared: ModelPricing = {
        var base = try! JSONDecoder().decode(ModelPricing.self, from: Data(defaultJSON.utf8))
        if let data = try? Data(contentsOf: userFile), let user = try? JSONDecoder().decode(ModelPricing.self, from: data) {
            base.prices = user.prices + base.prices
            base.asOf = user.asOf
        }
        return base
    }()

    /// Writes an empty override file (if missing) so prices can be corrected; returns its URL.
    static func exportTemplateIfNeeded() -> URL {
        if !FileManager.default.fileExists(atPath: userFile.path) {
            let template = """
            {
              "asOf": "\(shared.asOf)",
              "prices": [
                { "match": "ejemplo-modelo", "input": 1.0, "output": 4.0, "cacheRead": 0.1 }
              ]
            }
            """
            try? template.write(to: userFile, atomically: true, encoding: .utf8)
        }
        return userFile
    }

    func price(provider: ProviderKind, model: String?, name: String? = nil) -> Price? {
        let text = "\(provider.rawValue) \(model ?? "") \(name ?? "")".lowercased()
        return prices.first { text.range(of: $0.match, options: [.regularExpression, .caseInsensitive]) != nil }
    }
}
