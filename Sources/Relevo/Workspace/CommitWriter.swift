import Foundation

/// Commit messages and PR descriptions written by the cheap utility model from the thread and its diff,
/// in English, without co-author lines or mentions of AI.
@MainActor
enum CommitWriter {
    static let system = """
    You write git commit messages in English. From what the user asked and the diff, reply with ONLY the message: \
    an imperative subject line of at most 72 characters, a blank line, then a short body (a few lines or bullets) \
    saying what changed and why. No co-author lines, no mention of AI, assistants or tools, no markdown headings.
    """

    static func message(for thread: ThreadModel, path: String, store: AppStore) async -> String? {
        guard let (account, provider) = store.topicProvider() else { return nil }
        let stat = await Git.run(path, ["diff", "--stat=100", "HEAD"]).out
        let untracked = await Git.run(path, ["ls-files", "--others", "--exclude-standard"]).out
        let diff = await Git.run(path, ["diff", "--no-color", "HEAD"], timeout: 30).out
        var prompt = "Thread: \(thread.title)\n\nWhat the user asked (latest last):\n"
        for item in thread.items.filter({ $0.kind == .user }).suffix(4) {
            let line: String = String(item.text.replacingOccurrences(of: "\n", with: " ").prefix(300))
            prompt += "- \(line)\n"
        }
        prompt += "\nChanged files:\n\(stat)"
        if !untracked.isEmpty { prompt += "\nNew files:\n\(untracked.split(separator: "\n").prefix(40).joined(separator: "\n"))\n" }
        prompt += "\nDiff (may be cut):\n" + String(diff.prefix(14_000))
        guard let raw = await provider.quickCompletion(account: account, system: system, prompt: prompt) else { return nil }
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("```") {
            text = text.components(separatedBy: "\n").dropFirst().filter { !$0.hasPrefix("```") }.joined(separator: "\n")
        }
        text = Git.strippingAgentAttribution(text)
        return text.isEmpty ? nil : text
    }

    /// PR title and body from a commit message, with the checks the agent ran in the thread (from the trace).
    static func pullRequest(from message: String, thread: ThreadModel, store: AppStore) -> (title: String, body: String) {
        let lines = message.components(separatedBy: "\n")
        let title = lines.first ?? thread.title
        var body = lines.dropFirst().joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        let words = ["test", "build", "lint", "check", "xcodebuild", "swift build", "npm run", "pytest", "cargo"]
        let shellTools: Set<String> = ["bash", "shell", "run_command", "exec_command", "execute_command", "terminal"]
        let commands: [String] = thread.items
            .filter { $0.kind == .tool && shellTools.contains(($0.toolName ?? "").lowercased()) && $0.status != .failed }
            .compactMap { $0.title.map(plainCommand) }
        let checks = commands.filter { command in
            let lower = command.lowercased()
            return words.contains { lower.contains($0) }
        }
        var seen = Set<String>()
        let unique = checks.filter { seen.insert($0).inserted }.suffix(6)
        if !unique.isEmpty {
            body += "\n\n## Checks run\n" + unique.map { "- `\(String($0.prefix(140)))`" }.joined(separator: "\n")
        }
        return (title, Git.strippingAgentAttribution(body))
    }

    /// `/bin/zsh -lc "cd repo && swift test"` → `swift test`.
    static func plainCommand(_ raw: String) -> String {
        var c = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let r = c.range(of: #"^/bin/(ba|z)?sh -l?c "#, options: .regularExpression) {
            c = String(c[r.upperBound...]).trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
        }
        while let r = c.range(of: #"^cd [^&;]+(&&|;)\s*"#, options: .regularExpression) { c = String(c[r.upperBound...]) }
        return c
    }
}
