import Foundation

/// The same task given to several agents at once, each in its own worktree, to keep the best result.
struct Comparison: Codable, Identifiable, Hashable {
    var id = UUID()
    var projectId: UUID
    var prompt: String
    var createdAt = Date()
    var threadIds: [UUID]
    /// The thread it was launched from: its conversation was handed to every agent, and the winner is merged there.
    var sourceThreadId: UUID?
    var baseCommit: String
    var winnerId: UUID?
}

/// One option to launch: subscription, model and reasoning level.
struct ComparisonOption: Hashable, Identifiable {
    var id = UUID()
    var accountId: UUID
    var model: String
    var effort: String?
}

@MainActor
enum Comparisons {
    static let maxAgents = 5

    /// Default line-up: the subscriptions the Advisor would use for this task, up to three, each with its strongest
    /// model (comparing is about the best result each can give, not the cheapest), from its own family when it
    /// has one: Antigravity also offers Claude models, which another card would already cover.
    static func defaultOptions(prompt: String, thread: ThreadModel?, store: AppStore) -> [ComparisonOption] {
        let profile = Advisor.heuristic(prompt)
        let probe = thread ?? ThreadModel(projectId: UUID(), mode: .ask, accountId: nil, model: nil)
        var seen = Set<UUID>()
        var out: [ComparisonOption] = []
        for o in Advisor.rank(profile, thread: probe, store: store) where seen.insert(o.account.id).inserted {
            let models = ModelCatalog.shared.candidates(o.account.kind, store.visibleModels(for: o.account))
            let own = models.filter { isOwnFamily(o.account.kind, $0.model) }
            if let best = (own.isEmpty ? models : own).max(by: { $0.power < $1.power })?.model {
                out.append(ComparisonOption(accountId: o.account.id, model: best.id))
            } else {
                out.append(ComparisonOption(accountId: o.account.id, model: o.model.id, effort: o.effort))
            }
            if out.count == 3 { break }
        }
        return out
    }

    private static func isOwnFamily(_ kind: ProviderKind, _ m: ModelOption) -> Bool {
        guard kind == .gemini else { return true }
        return (m.id + " " + m.name).lowercased().contains("gemini")
    }

    /// Rough cost of starting each agent: it has to read the conversation being handed over (cold) plus its own
    /// system prompt; what it then does depends on the task.
    static func startCost(_ option: ComparisonOption, contextTokens: Int, store: AppStore) -> Double? {
        guard let account = store.account(option.accountId) else { return nil }
        let name = store.modelName(account, option.model)
        guard let price = ModelPricing.shared.price(provider: account.kind, model: option.model, name: name) else { return nil }
        return Double(contextTokens + 20_000) * price.write / 1_000_000
    }

    /// Creates one thread per option, each in a new worktree from the same commit, and sends them the prompt
    /// (with the source thread's conversation, if there is one).
    static func start(prompt: String, options: [ComparisonOption], source: ThreadModel?, project: Project, store: AppStore) async throws -> Comparison {
        let basePath = source?.worktree?.path ?? project.path
        guard let base = await Git.head(basePath) else { throw GitError(message: "El repositorio aún no tiene ningún commit.") }
        var comparison = Comparison(projectId: project.id, prompt: prompt, threadIds: [], sourceThreadId: source?.id, baseCommit: base)
        var created: [(ThreadModel, Account, ComparisonOption)] = []
        for option in options.prefix(maxAgents) {
            guard let account = store.account(option.accountId) else { continue }
            let t = ThreadModel(projectId: project.id, mode: source?.mode ?? store.settings.defaultMode, accountId: account.id, model: option.model)
            t.title = String(prompt.replacingOccurrences(of: "\n", with: " ").prefix(60)) + " · " + ModelNames.cleaned(store.modelName(account, option.model))
            t.titleSource = .manual
            t.selectedEffort = option.effort
            t.comparisonId = comparison.id
            if let source { t.items = source.items }
            store.threads.insert(t, at: 0)
            _ = try await Worktrees.create(for: t, project: project, store: store, from: basePath)
            comparison.threadIds.append(t.id)
            created.append((t, account, option))
        }
        store.comparisons.append(comparison)
        store.saveState()
        for (t, account, option) in created {
            store.runtime(for: t).startFork(prompt, account: account, model: option.model, sourceTitle: source?.title)
        }
        return comparison
    }

    struct Candidate: Identifiable {
        var thread: ThreadModel
        var stat: Git.DiffStat?
        var tokens: Int
        var cost: Double?
        var id: UUID { thread.id }
    }

    /// Each agent's changes so far (against the common base) and what it has consumed.
    static func candidates(_ c: Comparison, store: AppStore) async -> [Candidate] {
        var out: [Candidate] = []
        for id in c.threadIds {
            guard let t = store.threads.first(where: { $0.id == id }) else { continue }
            var stat: Git.DiffStat?
            if let w = t.worktree, let snap = await Git.snapshot(w.path, ref: "refs/relevo/\(t.id.uuidString)/compare", message: "Relevo: comparison") {
                stat = await Git.diffStat(w.path, from: c.baseCommit, to: snap)
            }
            let records = store.trace.usageRecords(since: nil, thread: t.id)
            let cost = records.compactMap(\.cost).reduce(0, +)
            out.append(Candidate(thread: t, stat: stat, tokens: records.reduce(0) { $0 + $1.tokens.total },
                                 cost: records.contains { $0.cost != nil } ? cost : nil))
        }
        return out
    }

    /// Keeps one result: commits its changes on its branch and merges it where the comparison started
    /// (the source thread's worktree, or the project's branch). The other worktrees are removed if asked.
    static func pick(_ winner: ThreadModel, in comparison: Comparison, removeOthers: Bool, store: AppStore) async throws -> String {
        guard let w = winner.worktree, let project = store.project(comparison.projectId) else { throw GitError(message: "El hilo no tiene worktree.") }
        if !(await Git.changedFiles(w.path)).isEmpty {
            let message = await CommitWriter.message(for: winner, path: w.path, store: store)
                ?? "Apply result for: \(String(comparison.prompt.prefix(60)))"
            try await Git.commitAll(w.path, message: message)
        }
        let target: String
        if let sourceId = comparison.sourceThreadId, let source = store.threads.first(where: { $0.id == sourceId }), let sw = source.worktree {
            target = sw.path
        } else {
            target = project.path
            let dirty = await Git.run(target, ["status", "--porcelain", "--untracked-files=no"]).out
            guard dirty.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw Worktrees.MergeProblem.projectDirty }
        }
        let r = await Git.run(target, ["merge", "--no-edit", w.branch], timeout: 120)
        if !r.ok {
            await Git.run(target, ["merge", "--abort"])
            throw Worktrees.MergeProblem.conflict(r.message)
        }
        if let i = store.comparisons.firstIndex(where: { $0.id == comparison.id }) { store.comparisons[i].winnerId = winner.id }
        if removeOthers {
            for id in comparison.threadIds where id != winner.id {
                guard let t = store.threads.first(where: { $0.id == id }) else { continue }
                try? await Worktrees.remove(t, store: store, deleteBranch: true)
            }
        }
        store.saveState()
        return r.out.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
