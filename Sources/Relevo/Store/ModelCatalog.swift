import Foundation

/// How capable each model is, kept as data instead of per-model code: ordered `pattern → power (1–10)`
/// rules matched against "<provider> <model id> <model name>" (lowercased). The defaults live below;
/// ~/Library/Application Support/Relevo/model-tiers.json can override any top-level field.
struct ModelCatalog: Codable {
    struct Rule: Codable {
        var match: String
        var power: Double
    }

    /// Ideal model power for each task level (`trivial`, `normal`, `dificil`).
    var ideal: [String: Double]
    /// Reasoning levels per task level, by preference: the first one the model accepts is used.
    var efforts: [String: [String]]
    /// Models never suggested (aliases such as "default", specialised models…).
    var skip: [String]
    /// First matching rule wins.
    var power: [Rule]
    /// Words that hint at a task level, for the offline classifier.
    var hints: [String: [String]]
    /// Words that hint at the kind of task (explicar, editar, depurar…), for the offline classifier.
    var kinds: [String: [String]]

    static let defaultJSON = #"""
    {
      "ideal": { "trivial": 2, "normal": 6, "dificil": 8 },
      "efforts": {
        "trivial": ["low", "minimal", "disabled", "medium"],
        "normal": ["medium", "high"],
        "dificil": ["high", "xhigh", "max"]
      },
      "skip": ["^\\S+ default\\b", "daybreak"],
      "power": [
        { "match": "flash.*low", "power": 1 },
        { "match": "\\b(haiku|luna|nano|mini|lite)\\b", "power": 2 },
        { "match": "flash.*high", "power": 4 },
        { "match": "\\bopus 4\\.", "power": 7.5 },
        { "match": "\\bsonnet 4\\.", "power": 4.5 },
        { "match": "\\b(flash|turbo|air)\\b", "power": 3 },
        { "match": "\\b(sonnet|terra|oss)\\b", "power": 5 },
        { "match": "\\bopus\\b", "power": 8 },
        { "match": "\\b(fable|astra|ultra)\\b", "power": 9 },
        { "match": "\\b(sol|glm|kimi|k2|pro|codex)\\b", "power": 6 }
      ],
      "hints": {
        "dificil": ["arquitectura", "refactor", "migra", "disena", "rendimiento", "optimiza", "concurren",
                    "race condition", "condicion de carrera", "deadlock", "seguridad", "vulnerab", "intermitente",
                    "investiga", "escalable", "desde cero", "todo el proyecto", "toda la app", "memory leak", "fuga de memoria"],
        "trivial": ["typo", "errata", "renombra", "traduce", "formatea", "que es", "que significa", "explica brevemente",
                    "como se llama", "hola", "gracias", "una linea", "un comando"]
      },
      "kinds": {
        "depurar": ["error", "falla", "bug", "crash", "excepcion", "no funciona", "se cuelga", "depura", "debug", "intermitente", "carrera"],
        "explicar": ["explica", "que es", "por que", "como funciona", "que hace", "entender"],
        "refactorizar": ["refactor", "limpia", "reorganiza", "simplifica"],
        "diseñar": ["disena", "arquitectura", "propon", "plan"],
        "editar": ["anade", "cambia", "crea", "implementa", "modifica", "actualiza", "quita", "elimina", "corrige"]
      }
    }
    """#

    static var userFile: URL { AppStore.supportDirectory.appendingPathComponent("model-tiers.json") }

    /// Defaults with the user's file laid over them (top-level keys replace the defaults).
    static let shared: ModelCatalog = {
        var merged = (JSONUtil.parseAny(Data(defaultJSON.utf8)) as? [String: Any]) ?? [:]
        if let data = try? Data(contentsOf: userFile), let user = JSONUtil.parseAny(data) as? [String: Any] {
            for (k, v) in user { merged[k] = v }
        }
        if let data = try? JSONSerialization.data(withJSONObject: merged), let c = try? JSONDecoder().decode(ModelCatalog.self, from: data) {
            return c
        }
        return try! JSONDecoder().decode(ModelCatalog.self, from: Data(defaultJSON.utf8))
    }()

    /// Writes the defaults to the user file (if missing) so they can be edited.
    static func exportDefaultsIfNeeded() -> URL {
        if !FileManager.default.fileExists(atPath: userFile.path) {
            try? defaultJSON.trimmingCharacters(in: .whitespacesAndNewlines).write(to: userFile, atomically: true, encoding: .utf8)
        }
        return userFile
    }

    // MARK: - Lookups

    private static func haystack(_ kind: ProviderKind, _ model: ModelOption) -> String {
        "\(kind.rawValue) \(model.id) \(model.name)".lowercased()
    }

    private static func matches(_ pattern: String, _ text: String) -> Bool {
        text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// Power of a model (1 = fastest/cheapest, 10 = most capable), or nil when no rule knows it.
    func power(_ kind: ProviderKind, _ model: ModelOption) -> Double? {
        let text = Self.haystack(kind, model)
        return power.first { Self.matches($0.match, text) }?.power
    }

    func isSkipped(_ kind: ProviderKind, _ model: ModelOption) -> Bool {
        let text = Self.haystack(kind, model)
        return model.id.isEmpty || skip.contains { Self.matches($0, text) }
    }

    /// Models worth suggesting for an account: rated, not skipped, and only the newest version of each family
    /// (Opus 5.5 hides Opus 5 and 4.8; GPT-6.1-Sol hides GPT-6-Sol).
    func candidates(_ kind: ProviderKind, _ models: [ModelOption]) -> [(model: ModelOption, power: Double)] {
        var best: [String: (index: Int, model: ModelOption, power: Double, version: [Int])] = [:]
        for (i, m) in models.enumerated() where !isSkipped(kind, m) {
            guard let p = power(kind, m) else { continue }
            let key = Self.family(m.name)
            let v = Self.version(m.name)
            if let current = best[key], !current.version.lexicographicallyPrecedes(v) { continue }   // keep the newest
            best[key] = (best[key]?.index ?? i, m, p, v)
        }
        return best.values.sorted { $0.index < $1.index }.map { ($0.model, $0.power) }
    }

    /// Name without version numbers: "GPT-6.1-Sol" and "GPT-5.6-Sol" → "gpt sol".
    static func family(_ name: String) -> String {
        let noDigits = name.lowercased().replacingOccurrences(of: #"\d+(\.\d+)*"#, with: " ", options: .regularExpression)
        return noDigits.components(separatedBy: CharacterSet.letters.inverted).filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// First version number in the name: "Opus 4.8" → [4, 8].
    static func version(_ name: String) -> [Int] {
        guard let r = name.range(of: #"\d+(\.\d+)*"#, options: .regularExpression) else { return [] }
        return name[r].split(separator: ".").compactMap { Int($0) }
    }

    func ideal(_ level: TaskLevel) -> Double { ideal[level.rawValue] ?? [2, 6, 8][level.rank] }

    func effort(for level: TaskLevel, available: [String]?) -> String? {
        guard let available, !available.isEmpty else { return nil }
        return (efforts[level.rawValue] ?? []).first { available.contains($0) }
    }

    static func tierLabel(_ power: Double) -> String {
        power <= 3 ? "rápido y barato" : power <= 6.5 ? "equilibrado" : "de los más potentes"
    }
}
