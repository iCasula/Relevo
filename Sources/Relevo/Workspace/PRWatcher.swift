import Foundation

/// Watches the pull requests threads opened: every two minutes it checks them with `gh` and wakes the thread's
/// agent when checks fail, someone comments or reviews, or the branch gets conflicts; it tells you when checks
/// pass and stops when the PR is merged or closed.
@MainActor
final class PRWatcher {
    private weak var store: AppStore?
    private var task: Task<Void, Never>?
    static let interval: UInt64 = 120

    init(store: AppStore) { self.store = store }

    func start() {
        guard task == nil else { return }
        task = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                await self?.pollAll()
                try? await Task.sleep(nanoseconds: Self.interval * 1_000_000_000)
            }
        }
    }

    func pollAll() async {
        guard let store else { return }
        for thread in store.threads where thread.pullRequest?.watching == true && thread.pullRequest?.state == "OPEN" {
            await poll(thread)
        }
    }

    /// What a PR looks like now, as comparable markers, plus the details needed to describe changes.
    struct State {
        var markers: [String]
        var state: String
        /// Failing checks, each with a marker of that run (a re-run that fails again is new).
        var failing: [(name: String, marker: String)]
        var pending: Int
        var conflict: Bool
        var comments: [(author: String, body: String)]
        var reviews: [(author: String, state: String, body: String)]
    }

    static func state(_ o: JSONObject) -> State {
        var markers: [String] = []
        var failing: [(name: String, marker: String)] = []
        var pending = 0
        for c in o.objs("statusCheckRollup") {
            let name = c.str("name") ?? c.str("context") ?? "check"
            let conclusion = (c.str("conclusion") ?? c.str("state") ?? "").uppercased()
            let status = (c.str("status") ?? "").uppercased()
            if failures.contains(conclusion) {
                let marker = "fail:\(name)@\(c.str("completedAt") ?? c.str("startedAt") ?? "")"
                failing.append((name, marker))
                markers.append(marker)
            }
            else if conclusion.isEmpty || status == "IN_PROGRESS" || status == "QUEUED" || conclusion == "PENDING" { pending += 1 }
            markers.append("check:\(name):\(conclusion.isEmpty ? status : conclusion)")
        }
        let comments = o.objs("comments").map { (author: $0.obj("author")?.str("login") ?? "?", body: $0.str("body") ?? "") }
        let reviews = o.objs("reviews").map { (author: $0.obj("author")?.str("login") ?? "?", state: $0.str("state") ?? "", body: $0.str("body") ?? "") }
        let state = o.str("state") ?? "OPEN"
        let conflict = o.str("mergeable") == "CONFLICTING"
        markers += ["comments:\(comments.count)", "reviews:\(reviews.count)", "conflict:\(conflict)", "state:\(state)"]
        return State(markers: markers, state: state, failing: failing, pending: pending, conflict: conflict, comments: comments, reviews: reviews)
    }

    static let failures: Set<String> = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]

    func poll(_ thread: ThreadModel) async {
        guard let store, var pr = thread.pullRequest, let path = store.workPath(thread),
              let o = await GitHubCLI.view(path, number: pr.number) else { return }
        let outcome = Self.evaluate(o, pr: &pr)
        thread.pullRequest = pr
        store.save(thread)
        let runtime = store.runtime(for: thread)
        if !outcome.tellAgent.isEmpty {
            runtime.noteFromWatcher("PR #\(pr.number): " + (outcome.checksFailed ? "checks fallando" : "novedades") + "; aviso al agente")
            runtime.send("[Relevo vigila el PR #\(pr.number)]\n\n" + outcome.tellAgent.joined(separator: "\n\n") + "\n\nAtiende lo que proceda.")
            store.notifyWatcher(thread: thread, text: outcome.tellAgent.first ?? "")
        }
        for note in outcome.notes {
            runtime.noteFromWatcher(note)
            store.notifyWatcher(thread: thread, text: note)
        }
    }

    /// What changed since the last look, as messages for the agent and notes for you.
    struct Outcome {
        var tellAgent: [String] = []
        var notes: [String] = []
        var checksFailed = false
    }

    /// Compares the PR now with what was seen last time (stored in `pr.seen`) and updates `pr`.
    /// The first look only records where things are.
    static func evaluate(_ o: JSONObject, pr: inout PullRequestInfo) -> Outcome {
        let now = state(o)
        let seen = Set(pr.seen ?? [])
        let first = pr.seen == nil
        pr.seen = now.markers
        pr.state = now.state
        var outcome = Outcome()
        let allGreen = now.failing.isEmpty && now.pending == 0 && !o.objs("statusCheckRollup").isEmpty
        if allGreen { pr.seen?.append("all-green") }
        if now.state != "OPEN" { pr.watching = false }
        guard !first else { return outcome }

        let previousComments = Int(seen.first { $0.hasPrefix("comments:") }?.dropFirst("comments:".count) ?? "") ?? now.comments.count
        let previousReviews = Int(seen.first { $0.hasPrefix("reviews:") }?.dropFirst("reviews:".count) ?? "") ?? now.reviews.count
        let newlyFailing = now.failing.filter { !seen.contains($0.marker) }.map(\.name)
        if !newlyFailing.isEmpty {
            outcome.checksFailed = true
            outcome.tellAgent.append("Los checks del PR #\(pr.number) han fallado: \(newlyFailing.joined(separator: ", ")). Mira los logs (`gh pr checks \(pr.number)`, `gh run view --log-failed`), arréglalo y empuja.")
        }
        for c in now.comments.dropFirst(min(previousComments, now.comments.count)) {
            outcome.tellAgent.append("Nuevo comentario de @\(c.author) en el PR #\(pr.number):\n> " + c.body.replacingOccurrences(of: "\n", with: "\n> "))
        }
        for r in now.reviews.dropFirst(min(previousReviews, now.reviews.count)) where !r.body.isEmpty || r.state == "CHANGES_REQUESTED" {
            outcome.tellAgent.append("Revisión de @\(r.author) en el PR #\(pr.number) (\(r.state)):\n> " + r.body.replacingOccurrences(of: "\n", with: "\n> "))
        }
        if now.conflict && !seen.contains("conflict:true") {
            outcome.tellAgent.append("El PR #\(pr.number) tiene conflictos con su rama base. Resuélvelos (rebase o merge), comprueba que compila y empuja.")
        }
        if allGreen && !seen.contains("all-green") { outcome.notes.append("PR #\(pr.number): todos los checks en verde") }
        if now.state != "OPEN" { outcome.notes.append("PR #\(pr.number) \(now.state == "MERGED" ? "fusionado" : "cerrado"); dejo de vigilarlo") }
        return outcome
    }
}
