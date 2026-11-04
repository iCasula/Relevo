import Foundation

enum UsagePeriod: String, CaseIterable, Identifiable {
    case today, week, month, all
    var id: String { rawValue }

    var label: String {
        switch self {
        case .today: return "Hoy"
        case .week: return "7 días"
        case .month: return "30 días"
        case .all: return "Todo"
        }
    }

    var since: Date? {
        let cal = Calendar.current
        switch self {
        case .today: return cal.startOfDay(for: Date())
        case .week: return cal.date(byAdding: .day, value: -6, to: cal.startOfDay(for: Date()))
        case .month: return cal.date(byAdding: .day, value: -29, to: cal.startOfDay(for: Date()))
        case .all: return nil
        }
    }
}

/// A model that did turns a cheaper one of the same subscription could have done, and what it would have saved.
struct Downgrade: Identifiable {
    var id: String { "\(accountId?.uuidString ?? provider)|\(fromModel)|\(toModel)" }
    var provider: String
    var accountId: UUID?
    var fromModel: String
    var fromName: String
    var toModel: String
    var toName: String
    var turns: [UsageRecord]
    var actualCost: Double
    /// Includes what switching would have cost: loading the context cold and warming the original model again.
    var cheaperCost: Double
    var switchCost: Double
    var kinds: [String: Int]
    /// Turn ids a utility model agreed could have used the cheaper model (nil until reviewed).
    var confirmed: Set<String>?

    var savings: Double { max(0, actualCost - cheaperCost) }
    var share: Double { actualCost > 0 ? savings / actualCost : 0 }
    var confirmedSavings: Double? {
        guard let confirmed else { return nil }
        let picked = turns.filter { confirmed.contains($0.turn) }
        let ratio = actualCost > 0 ? cheaperCost / actualCost : 1
        return picked.reduce(0) { $0 + ($1.cost ?? 0) } * (1 - ratio)
    }
}

struct UsageReport {
    struct DayBucket: Identifiable {
        var day: Date
        var provider: String
        var tokens: Int
        var cost: Double
        var id: String { "\(day.timeIntervalSince1970)|\(provider)" }
    }

    struct HourCell: Identifiable {
        /// 1 = Monday … 7 = Sunday.
        var weekday: Int
        var hour: Int
        var tokens: Int
        var turns: Int
        var cost: Double
        var id: Int { weekday * 100 + hour }
    }

    struct ModelRow: Identifiable {
        var provider: String
        var model: String
        var name: String
        var turns: Int
        var tokens: TokenUsage
        var cost: Double
        var priced: Bool
        var ok: Int
        var finished: Int
        var switches: Int
        var id: String { provider + "|" + model }
        var okRate: Double? { finished > 0 ? Double(ok) / Double(finished) : nil }
        var costPerTurn: Double? { turns > 0 && priced ? cost / Double(turns) : nil }
    }

    struct ProviderRow: Identifiable {
        var provider: String
        var turns: Int
        var tokens: Int
        var cost: Double
        var paid: Bool
        var id: String { provider }
    }

    struct SwitchSummary: Identifiable {
        var kind: SwitchKind
        var count: Int
        var overhead: Int
        var cost: Double
        var id: String { kind.rawValue }
    }

    var records: [UsageRecord] = []
    var tokens = TokenUsage()
    var cost: Double = 0
    var paidCost: Double = 0
    var turns = 0
    var days: [DayBucket] = []
    var hours: [HourCell] = []
    var models: [ModelRow] = []
    var providers: [ProviderRow] = []
    var switches: [UsageRecord] = []
    var switchSummary: [SwitchSummary] = []
    var switchOverhead = 0
    var switchCost: Double = 0
    var downgrades: [Downgrade] = []
    /// Simple turns where a cheaper model was cheaper per token, but switching to it mid-thread would have cost more.
    var notWorthSwitching = 0
    var notWorthNaiveSavings: Double = 0
    var insights: [Insight] = []
    var firstDate: Date?
    var hasImported = false

    var isEmpty: Bool { records.isEmpty }
}

/// A conclusion drawn from the usage, with what to do about it.
struct Insight: Identifiable {
    var id: String
    var symbol: String
    var title: String
    var detail: String
    var threadId: UUID? = nil
}

@MainActor
enum UsageAnalytics {
    /// Fixed order of providers in charts (and their palette slot): colour follows the provider, never its rank.
    nonisolated static let providerOrder = ["gemini", "claude", "codex", "deepseek", "kimi", "zai"]

    nonisolated static func providerName(_ raw: String) -> String {
        ProviderRegistry.find(raw)?.info.shortName ?? raw
    }

    static func report(_ period: UsagePeriod, store: AppStore) -> UsageReport {
        build(store.trace.usageRecords(since: period.since), store: store)
    }

    static func build(_ records: [UsageRecord], store: AppStore) -> UsageReport {
        var r = UsageReport()
        r.records = records
        r.firstDate = records.first?.ts
        r.hasImported = records.contains { $0.source == "import" }
        let cal = Calendar.current
        var days: [String: UsageReport.DayBucket] = [:]
        var hours: [Int: UsageReport.HourCell] = [:]
        var models: [String: UsageReport.ModelRow] = [:]
        var providers: [String: UsageReport.ProviderRow] = [:]
        var switchKinds: [SwitchKind: UsageReport.SwitchSummary] = [:]

        for rec in records {
            let cost = rec.cost ?? 0
            r.tokens = r.tokens + rec.tokens
            r.cost += cost
            if rec.paid { r.paidCost += cost }
            if rec.main { r.turns += 1 }

            let day = cal.startOfDay(for: rec.ts)
            let dayKey = "\(day.timeIntervalSince1970)|\(rec.provider)"
            days[dayKey, default: .init(day: day, provider: rec.provider, tokens: 0, cost: 0)].tokens += rec.tokens.total
            days[dayKey]!.cost += cost

            let weekday = (cal.component(.weekday, from: rec.ts) + 5) % 7 + 1   // Sunday=1 → Monday=1
            let hour = cal.component(.hour, from: rec.ts)
            let hourKey = weekday * 100 + hour
            hours[hourKey, default: .init(weekday: weekday, hour: hour, tokens: 0, turns: 0, cost: 0)].tokens += rec.tokens.total
            hours[hourKey]!.cost += cost
            if rec.main { hours[hourKey]!.turns += 1 }

            let modelKey = rec.provider + "|" + rec.modelName
            var row = models[modelKey] ?? .init(provider: rec.provider, model: rec.model, name: rec.modelName, turns: 0, tokens: TokenUsage(),
                                                cost: 0, priced: true, ok: 0, finished: 0, switches: 0)
            row.tokens = row.tokens + rec.tokens
            row.cost += cost
            if rec.cost == nil { row.priced = false }
            if rec.main {
                row.turns += 1
                if rec.result == "ok" { row.ok += 1 }
                if rec.result == "ok" || rec.result == "error" { row.finished += 1 }
                if rec.switchKind != nil { row.switches += 1 }
            }
            models[modelKey] = row

            var p = providers[rec.provider] ?? .init(provider: rec.provider, turns: 0, tokens: 0, cost: 0, paid: rec.paid)
            p.tokens += rec.tokens.total
            p.cost += cost
            if rec.main { p.turns += 1 }
            providers[rec.provider] = p

            if rec.main, let kind = rec.switchKind {
                r.switches.append(rec)
                var s = switchKinds[kind] ?? .init(kind: kind, count: 0, overhead: 0, cost: 0)
                s.count += 1
                s.overhead += rec.overhead ?? 0
                s.cost += rec.overheadCost ?? 0
                switchKinds[kind] = s
                r.switchOverhead += rec.overhead ?? 0
                r.switchCost += rec.overheadCost ?? 0
            }
        }
        r.days = days.values.sorted { ($0.day, order($0.provider)) < ($1.day, order($1.provider)) }
        r.hours = hours.values.sorted { $0.id < $1.id }
        r.models = models.values.sorted { $0.tokens.total > $1.tokens.total }
        r.providers = providers.values.sorted { order($0.provider) < order($1.provider) }
        r.switches.sort { ($0.overhead ?? 0) > ($1.overhead ?? 0) }
        r.switchSummary = switchKinds.values.sorted { $0.overhead > $1.overhead }
        let cheaper = downgrades(records, store: store)
        r.downgrades = cheaper.groups
        r.notWorthSwitching = cheaper.notWorth
        r.notWorthNaiveSavings = cheaper.naiveSavings
        r.insights = insights(r, store: store)
        return r
    }

    // MARK: - Insights

    static func insights(_ r: UsageReport, store: AppStore) -> [Insight] {
        var out: [Insight] = []
        let pricing = ModelPricing.shared
        if r.cost > 0, r.switchCost / r.cost >= 0.03 {
            let worst = r.switchSummary.first
            out.append(Insight(id: "switch", symbol: "arrow.triangle.swap",
                               title: "Los cambios de modelo o proveedor suponen el \(TokenFormat.percent(r.switchCost / r.cost)) del coste",
                               detail: "\(r.switches.count) cambios re-procesaron \(TokenFormat.short(r.switchOverhead)) tokens sin caché (≈ \(TokenFormat.usd(r.switchCost)))"
                                   + (worst.map { ", sobre todo «\($0.kind.label.lowercased())»" } ?? "")
                                   + ". Cambia al empezar un tema nuevo, no a mitad de uno largo."))
        }
        if r.notWorthSwitching > 0 {
            out.append(Insight(id: "notworth", symbol: "scalemass",
                               title: "\(r.notWorthSwitching) tareas sencillas a mitad de hilos largos: bajar de modelo no compensaba",
                               detail: "Por tokens habrías ahorrado \(TokenFormat.usd(r.notWorthNaiveSavings)), pero re-procesar el contexto en el otro modelo (y luego volver) costaba más. "
                                   + "Para preguntas sueltas, mejor un hilo nuevo con un modelo barato."))
        }
        // Long conversations: every message pays for reading the whole context again (even cached).
        var lastByThread: [UUID: UsageRecord] = [:]
        for rec in r.records where rec.main { lastByThread[rec.threadId] = rec }
        let big = lastByThread.values.filter { ($0.context ?? 0) >= 150_000 }.sorted { ($0.context ?? 0) > ($1.context ?? 0) }
        for rec in big.prefix(2) {
            guard let kind = store.account(rec.accountId)?.kind ?? ProviderRegistry.find(rec.provider)?.kind,
                  let p = pricing.price(provider: kind, model: rec.model, name: rec.modelName), let context = rec.context else { continue }
            let perTurn = Double(context) * p.read / 1_000_000
            let title = store.threads.first { $0.id == rec.threadId }?.title ?? "un hilo"
            out.append(Insight(id: "context-\(rec.threadId)", symbol: "text.word.spacing",
                               title: "«\(title)» lleva \(TokenFormat.short(context)) tokens de contexto",
                               detail: "Cada mensaje cuesta ≈ \(TokenFormat.usd(perTurn)) solo en releerlo (aunque esté en caché), y más por cada petición del agente. "
                                   + "Compactar el contexto o seguir en un hilo nuevo con el traspaso lo abarata.",
                               threadId: rec.threadId))
        }
        // Providers whose turns barely hit the cache re-process everything on every message.
        for p in r.providers where p.turns >= 3 {
            let tokens = r.records.filter { $0.provider == p.provider }.reduce(TokenUsage()) { $0 + $1.tokens }
            if let share = tokens.cacheShare, share < 0.3, tokens.prompt > 100_000 {
                out.append(Insight(id: "cache-\(p.provider)", symbol: "bolt.slash",
                                   title: "\(providerName(p.provider)) apenas reutiliza caché (\(TokenFormat.percent(share)))",
                                   detail: "Sus turnos vuelven a procesar casi todo el contexto: en hilos largos sale más caro que un proveedor con caché."))
            }
        }
        if let idle = r.switchSummary.first(where: { $0.kind == .idle }), idle.count >= 2 {
            out.append(Insight(id: "idle", symbol: "clock.badge.exclamationmark",
                               title: "Retomar hilos tras más de una hora re-procesó \(TokenFormat.short(idle.overhead)) tokens",
                               detail: "La caché de los proveedores caduca (en Claude Code, a la hora). Al volver a un hilo largo, el primer mensaje cuesta como empezar."))
        }
        return out
    }

    nonisolated static func order(_ provider: String) -> Int { providerOrder.firstIndex(of: provider) ?? providerOrder.count }

    // MARK: - Cheaper models

    /// Finished turns of simple tasks done with a model well above what the task needed, regrouped by the
    /// cheapest sufficient model of the same subscription, with what they would really have cost there: the same
    /// tokens at its price, plus the context it would have had to load cold, plus warming the original model again
    /// when the thread went on with it. Mid-thread, in long conversations, that switch usually eats the saving.
    static func downgrades(_ records: [UsageRecord], store: AppStore) -> (groups: [Downgrade], notWorth: Int, naiveSavings: Double) {
        var notWorth = 0
        var naiveSavings: Double = 0
        let catalog = ModelCatalog.shared
        let pricing = ModelPricing.shared
        var groups: [String: Downgrade] = [:]
        let mains = records.filter(\.main)
        var startContext: [String: Int] = [:]
        var continues = Set<String>()
        for (_, turns) in Dictionary(grouping: mains, by: \.threadId) {
            let sorted = turns.sorted { $0.ts < $1.ts }
            for (i, t) in sorted.enumerated() {
                startContext[t.turn] = i > 0 ? (sorted[i - 1].context ?? 0) : 0
                if i + 1 < sorted.count, sorted[i + 1].model == t.model, sorted[i + 1].provider == t.provider { continues.insert(t.turn) }
            }
        }
        for rec in mains where rec.result == "ok" {
            guard let account = store.account(rec.accountId) ?? store.accounts.first(where: { $0.kind.rawValue == rec.provider }) else { continue }
            let kind = account.kind
            let used = ModelOption(id: rec.model, name: rec.modelName)
            guard let usedPower = catalog.power(kind, used) else { continue }
            let level = TaskLevel(rawValue: rec.level ?? "") ?? Advisor.heuristic(rec.request ?? "").level
            guard level != .dificil else { continue }
            // Signals the turn really was small: few tool calls and a short answer.
            let simple = rec.tools <= (level == .trivial ? 6 : 3) && rec.tokens.output <= 6000
            guard simple else { continue }
            // Simple turns of "normal" tasks rarely need the full ideal power.
            let need = level == .trivial ? catalog.ideal(.trivial) : catalog.ideal(.normal) - 1
            guard usedPower - need >= 1.5 else { continue }
            let usedPrice = pricing.price(provider: kind, model: rec.model, name: rec.modelName)
            guard let actual = rec.cost ?? usedPrice?.cost(rec.tokens), actual > 0 else { continue }
            let options = catalog.candidates(kind, store.visibleModels(for: account)).filter { $0.power >= need && $0.power < usedPower }
            let context = startContext[rec.turn] ?? 0
            let priced = options.compactMap { option -> (ModelOption, Double, Double)? in
                guard let p = pricing.price(provider: kind, model: option.model.id, name: option.model.name) else { return nil }
                // The cached prompt would have been written cold on a model that never saw this conversation…
                var switching = Double(min(context, rec.tokens.cacheRead)) * max(0, p.write - p.read) / 1_000_000
                // …and the next turn, back on the original model, would have had to warm its cache again.
                if continues.contains(rec.turn), let usedPrice {
                    switching += Double(rec.context ?? context) * max(0, usedPrice.write - usedPrice.read) / 1_000_000
                }
                return (option.model, p.cost(rec.tokens) + switching, switching)
            }
            guard let best = priced.min(by: { $0.1 < $1.1 }) else { continue }
            guard best.1 < actual * 0.8 else {
                if best.1 - best.2 < actual * 0.8 {
                    notWorth += 1
                    naiveSavings += actual - (best.1 - best.2)
                }
                continue
            }
            let key = "\(account.id)|\(rec.modelName)|\(best.0.id)"
            var g = groups[key] ?? Downgrade(provider: rec.provider, accountId: account.id, fromModel: rec.model, fromName: rec.modelName,
                                             toModel: best.0.id, toName: ModelNames.cleaned(best.0.name), turns: [], actualCost: 0,
                                             cheaperCost: 0, switchCost: 0, kinds: [:], confirmed: nil)
            g.turns.append(rec)
            g.actualCost += actual
            g.cheaperCost += best.1
            g.switchCost += best.2
            g.kinds[rec.task ?? Advisor.heuristic(rec.request ?? "").kind ?? "otro", default: 0] += 1
            groups[key] = g
        }
        return (groups.values.filter { $0.savings > 0.0005 }.sorted { $0.savings > $1.savings }, notWorth, naiveSavings)
    }

    static let reviewSystem = """
    Revisas peticiones que se hicieron a un agente de programación con un modelo potente y caro. Para cada una, decide si \
    un modelo más barato y menos capaz la habría resuelto igual de bien (preguntas breves, comandos sencillos, cambios \
    pequeños y claros). Sé prudente: ante la duda, no. Responde SOLO con una línea JSON: {"si":["id",...]} con los ids \
    que sí podían hacerse con el modelo barato.
    """

    /// Asks the cheap utility model which of the group's turns could really have used the cheaper model.
    static func review(_ d: Downgrade, store: AppStore) async -> Set<String>? {
        guard let (account, provider) = store.topicProvider() else { return nil }
        let sample = d.turns.sorted { ($0.cost ?? 0) > ($1.cost ?? 0) }.prefix(30)
        var prompt = "Modelo usado: \(d.fromName). Modelo barato: \(d.toName).\n"
        for (i, t) in sample.enumerated() {
            let text = (t.request ?? "").replacingOccurrences(of: "\n", with: " ")
            prompt += "\(i + 1) | herramientas: \(t.tools) | respuesta: \(t.tokens.output) tokens | \(String(text.prefix(220)))\n"
        }
        guard let raw = await provider.quickCompletion(account: account, system: reviewSystem, prompt: prompt),
              let start = raw.firstIndex(of: "{"), let end = raw.lastIndex(of: "}"), start < end,
              let o = JSONUtil.parse(String(raw[start...end])) else { return nil }
        let picked = (o["si"] as? [Any] ?? []).compactMap { v -> Int? in
            if let n = v as? Int { return n }
            if let s = v as? String { return Int(s.trimmingCharacters(in: .whitespaces)) }
            return nil
        }
        return Set(picked.compactMap { $0 >= 1 && $0 <= sample.count ? Array(sample)[$0 - 1].turn : nil })
    }
}
