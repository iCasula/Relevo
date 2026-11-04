import Foundation

/// Fills the stats with the turns made before Relevo recorded tokens, read from the transcripts Claude Code keeps
/// for each session Relevo started (only accounts with their own config folder; nothing is modified).
@MainActor
enum UsageImporter {
    struct ParsedTurn: Sendable {
        var ts: Date
        var end: Date
        var request: String
        var handoff: Bool
        var parts: [String: TokenUsage]
        var tools: Int
        /// Prompt + output of the turn's last request: the context size when it ended.
        var context: Int
    }

    static func run(store: AppStore) async {
        if store.settings.usageTrackingSince == nil {
            store.settings.usageTrackingSince = Date()
            store.saveState()
        }
        guard let cutoff = store.settings.usageTrackingSince else { return }
        var jobs: [(thread: ThreadModel, segment: Segment, account: Account, file: URL)] = []
        for thread in store.threads {
            for segment in thread.segments where segment.kind == .claude && segment.startedAt < cutoff {
                guard let sid = segment.nativeSessionId, !store.trace.isImported(session: sid),
                      let account = store.account(segment.accountId), let dir = account.configDir,
                      let file = transcript(sid, configDir: expandTilde(dir)) else { continue }
                jobs.append((thread, segment, account, file))
            }
        }
        guard !jobs.isEmpty else { return }
        for job in jobs {
            let url = job.file
            let turns = await Task.detached(priority: .utility) { parse(url, before: cutoff) }.value
            let rows = records(turns, thread: job.thread, segment: job.segment, account: job.account, store: store)
            store.trace.importUsage(session: job.segment.nativeSessionId ?? url.lastPathComponent, rows: rows)
        }
    }

    nonisolated static func transcript(_ sessionId: String, configDir: String) -> URL? {
        let projects = URL(fileURLWithPath: configDir).appendingPathComponent("projects")
        guard let dirs = try? FileManager.default.contentsOfDirectory(at: projects, includingPropertiesForKeys: nil) else { return nil }
        for dir in dirs {
            let file = dir.appendingPathComponent(sessionId + ".jsonl")
            if FileManager.default.fileExists(atPath: file.path) { return file }
        }
        return nil
    }

    /// Turns of a Claude Code transcript: each real prompt opens one; every API request until the next one adds
    /// its usage (once per request id) to the model that answered.
    nonisolated static func parse(_ url: URL, before cutoff: Date) -> [ParsedTurn] {
        guard let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8) else { return [] }
        var turns: [ParsedTurn] = []
        var current: ParsedTurn?
        var requests: [String: (model: String, usage: TokenUsage)] = [:]
        var lastRequest: String?

        func close() {
            guard var t = current else { return }
            for (_, r) in requests { t.parts[r.model] = (t.parts[r.model] ?? TokenUsage(model: r.model)) + r.usage }
            if let last = lastRequest, let r = requests[last] { t.context = r.usage.prompt + r.usage.output }
            if !t.parts.isEmpty, t.ts < cutoff { turns.append(t) }
            current = nil
            requests = [:]
            lastRequest = nil
        }

        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let o = JSONUtil.parse(String(line)), let type = o.str("type") else { continue }
            let ts = DateParse.any(o["timestamp"]) ?? current?.end ?? Date.distantPast
            switch type {
            case "user":
                guard o.bool("isMeta") != true, o.bool("isSidechain") != true, let message = o.obj("message") else { continue }
                var prompt: String?
                if let s = message.str("content") { prompt = s }
                else {
                    let blocks = message.objs("content")
                    if blocks.contains(where: { $0.str("type") == "tool_result" }) { continue }
                    prompt = blocks.compactMap { $0.str("type") == "text" ? $0.str("text") : nil }.joined(separator: "\n")
                }
                guard var request = prompt, !request.isEmpty else { continue }
                close()
                let handoff = request.hasPrefix("<relevo_handoff>")
                if let end = request.range(of: "</relevo_handoff>") {
                    request = String(request[end.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
                    for prefix in ["Nuevo mensaje del usuario:", "La última petición del usuario quedó sin terminar. Continúa con ella desde donde se quedó:"] where request.hasPrefix(prefix) {
                        request = String(request.dropFirst(prefix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
                    }
                }
                current = ParsedTurn(ts: ts, end: ts, request: request, handoff: handoff, parts: [:], tools: 0, context: 0)
            case "assistant":
                guard let message = o.obj("message"), let usage = message.obj("usage"), current != nil else { continue }
                let model = message.str("model") ?? "?"
                guard model != "<synthetic>" else { continue }
                let id = o.str("requestId") ?? message.str("id") ?? UUID().uuidString
                let u = TokenUsage(model: model, input: usage.int("input_tokens") ?? 0, cacheRead: usage.int("cache_read_input_tokens") ?? 0,
                                   cacheWrite: usage.int("cache_creation_input_tokens") ?? 0, output: usage.int("output_tokens") ?? 0,
                                   reasoning: usage.obj("output_tokens_details")?.int("thinking_tokens") ?? 0)
                // The same request is written once per content block: keep its most complete usage.
                if let seen = requests[id], seen.usage.output >= u.output { } else { requests[id] = (model, u) }
                if o.bool("isSidechain") != true { lastRequest = id }
                current?.tools += message.objs("content").filter { $0.str("type") == "tool_use" }.count
                current?.end = ts
            default:
                continue
            }
        }
        close()
        return turns
    }

    static func records(_ turns: [ParsedTurn], thread: ThreadModel, segment: Segment, account: Account, store: AppStore) -> [UsageRecord] {
        let pricing = ModelPricing.shared
        let colds = turns.compactMap { t in t.parts.values.max { $0.total < $1.total }?.cold }.sorted()
        let baseline = colds.isEmpty ? 0 : colds[colds.count / 2]
        let hadPrevious = thread.segments.first?.id != segment.id
        var rows: [UsageRecord] = []
        var previous: ParsedTurn?
        for (index, t) in turns.enumerated() {
            let main = t.parts.values.max { $0.total < $1.total }
            let profile = Advisor.heuristic(t.request)
            let turnId = "import:" + (segment.nativeSessionId ?? "") + ":\(index)"
            var kind: SwitchKind?
            var detail: String?
            if t.handoff || (index == 0 && hadPrevious) {
                kind = .provider
                detail = "→ \(account.name)"
            } else if let previous, let pm = previous.parts.values.max(by: { $0.total < $1.total })?.model, let mm = main?.model, pm != mm {
                kind = .model
                detail = "\(ModelNames.display(pm, account: account, store: store)) → \(ModelNames.display(mm, account: account, store: store))"
            } else if let previous, let main, t.ts.timeIntervalSince(previous.end) > 3600, (main.cacheShare ?? 1) < 0.5, main.cold > 20_000 {
                kind = .idle
                detail = "Pausa de \(Int(t.ts.timeIntervalSince(previous.end) / 3600)) h"
            }
            var overhead: Int?
            var overheadCost: Double?
            if kind != nil, let main {
                var extra = max(0, main.cold - baseline)
                if let previous, kind != .provider { extra = min(extra, previous.context) }
                overhead = extra
                if let p = pricing.price(provider: account.kind, model: main.model) {
                    overheadCost = Double(extra) * max(0, p.coldPrice(main) - p.read) / 1_000_000
                }
            }
            for (model, usage) in t.parts {
                let isMain = usage == main
                let cost = pricing.price(provider: account.kind, model: model)?.cost(usage)
                rows.append(UsageRecord(threadId: thread.id, turn: turnId, ts: t.ts, provider: account.kind.rawValue, accountId: account.id,
                                        model: model, modelName: ModelNames.display(model, account: account, store: store), main: isMain,
                                        tokens: usage, cost: cost, costEstimated: true, paid: account.kind.usesAPIKey,
                                        switchKind: isMain ? kind : nil, switchDetail: isMain ? detail : nil,
                                        overhead: isMain ? overhead : nil, overheadCost: isMain ? overheadCost : nil,
                                        level: profile.level.rawValue, task: profile.kind, result: "ok", tools: isMain ? t.tools : 0,
                                        durationMs: isMain ? Int(t.end.timeIntervalSince(t.ts) * 1000) : nil,
                                        request: isMain ? String(t.request.prefix(300)) : nil, source: "import",
                                        context: isMain ? t.context : nil))
            }
            previous = t
        }
        return rows
    }
}
