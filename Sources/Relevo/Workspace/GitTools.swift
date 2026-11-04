import Foundation

/// Runs a command to completion off the main thread, collecting stdout and stderr.
enum CommandRunner {
    struct Result: Sendable {
        var status: Int32
        var out: String
        var err: String
        var ok: Bool { status == 0 }
        /// The useful part of a failure, for messages.
        var message: String { (err.isEmpty ? out : err).trimmingCharacters(in: .whitespacesAndNewlines) }
    }

    static func run(_ executable: String, _ args: [String], cwd: String? = nil, env extra: [String: String] = [:],
                    input: String? = nil, timeout: TimeInterval = 60) async -> Result {
        await Task.detached(priority: .userInitiated) {
            runSync(executable, args, cwd: cwd, env: extra, input: input, timeout: timeout)
        }.value
    }

    static func runSync(_ executable: String, _ args: [String], cwd: String? = nil, env extra: [String: String] = [:],
                                    input: String? = nil, timeout: TimeInterval = 60) -> Result {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: executable)
        p.arguments = args
        if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        var env = ShellEnvironment.env
        for (k, v) in extra { env[k] = v }
        p.environment = env
        let out = Pipe(), err = Pipe(), inPipe = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = input == nil ? FileHandle.nullDevice : inPipe
        do { try p.run() } catch { return Result(status: -1, out: "", err: error.localizedDescription) }
        if let input {
            inPipe.fileHandleForWriting.write(Data(input.utf8))
            try? inPipe.fileHandleForWriting.close()
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { if p.isRunning { p.terminate() } }
        // Read both pipes at once so a full stderr buffer can't block the process.
        var errData = Data()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global().async {
            errData = err.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        let outData = out.fileHandleForReading.readDataToEndOfFile()
        group.wait()
        p.waitUntilExit()
        return Result(status: p.terminationStatus, out: String(decoding: outData, as: UTF8.self), err: String(decoding: errData, as: UTF8.self))
    }
}

struct GitError: LocalizedError {
    var message: String
    var errorDescription: String? { message }
}

/// The git operations Relevo does on a thread's working folder (worktrees, per-turn snapshots, diffs, commits).
enum Git {
    static let executable = "/usr/bin/git"

    @discardableResult
    static func run(_ path: String, _ args: [String], env: [String: String] = [:], timeout: TimeInterval = 60) async -> CommandRunner.Result {
        var e = env
        e["GIT_TERMINAL_PROMPT"] = "0"
        return await CommandRunner.run(executable, ["-C", path] + args, env: e, timeout: timeout)
    }

    static func checked(_ path: String, _ args: [String], env: [String: String] = [:], timeout: TimeInterval = 60) async throws -> String {
        let r = await run(path, args, env: env, timeout: timeout)
        guard r.ok else { throw GitError(message: r.message.isEmpty ? "git \(args.first ?? "") falló" : r.message) }
        return r.out
    }

    static func isRepo(_ path: String) async -> Bool {
        await run(path, ["rev-parse", "--is-inside-work-tree"]).out.contains("true")
    }

    static func head(_ path: String) async -> String? {
        let r = await run(path, ["rev-parse", "HEAD"])
        return r.ok ? r.out.trimmingCharacters(in: .whitespacesAndNewlines) : nil
    }

    static func branch(_ path: String) async -> String? {
        let r = await run(path, ["rev-parse", "--abbrev-ref", "HEAD"])
        let b = r.out.trimmingCharacters(in: .whitespacesAndNewlines)
        return r.ok && b != "HEAD" ? b : nil
    }

    static func hasRemote(_ path: String) async -> Bool {
        !(await run(path, ["remote"]).out.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    // MARK: - Snapshots

    /// A commit holding the whole working folder as it is now (tracked and untracked files, not ignored ones),
    /// built with a scratch index so the agent's index, branch and stash are never touched. It's kept alive by a
    /// ref under `refs/relevo/` so it can be diffed or restored later.
    static func snapshot(_ path: String, ref: String, message: String) async -> String? {
        let gitIndex = await run(path, ["rev-parse", "--git-path", "index"]).out.trimmingCharacters(in: .whitespacesAndNewlines)
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("relevo-index-\(UUID().uuidString)").path
        defer { try? FileManager.default.removeItem(atPath: scratch) }
        let source = gitIndex.hasPrefix("/") ? gitIndex : (path as NSString).appendingPathComponent(gitIndex)
        // Starting from the real index, only changed files are hashed again.
        if FileManager.default.fileExists(atPath: source) { try? FileManager.default.copyItem(atPath: source, toPath: scratch) }
        let env = ["GIT_INDEX_FILE": scratch]
        guard await run(path, ["add", "-A"], env: env, timeout: 120).ok else { return nil }
        let tree = await run(path, ["write-tree"], env: env).out.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !tree.isEmpty else { return nil }
        var args = ["commit-tree", tree, "-m", message]
        if let parent = await head(path) { args += ["-p", parent] }
        let commit = await run(path, args, env: ["GIT_AUTHOR_NAME": "Relevo", "GIT_AUTHOR_EMAIL": "relevo@localhost",
                                                 "GIT_COMMITTER_NAME": "Relevo", "GIT_COMMITTER_EMAIL": "relevo@localhost"])
            .out.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !commit.isEmpty else { return nil }
        await run(path, ["update-ref", ref, commit])
        return commit
    }

    struct DiffStat: Codable, Hashable, Sendable {
        var files: Int
        var added: Int
        var removed: Int
        var isEmpty: Bool { files == 0 }
    }

    static func diffStat(_ path: String, from a: String, to b: String) async -> DiffStat {
        let out = await run(path, ["diff", "--numstat", a, b]).out
        var stat = DiffStat(files: 0, added: 0, removed: 0)
        for line in out.split(separator: "\n") {
            let cols = line.split(separator: "\t", maxSplits: 2)
            guard cols.count == 3 else { continue }
            stat.files += 1
            stat.added += Int(cols[0]) ?? 0
            stat.removed += Int(cols[1]) ?? 0
        }
        return stat
    }

    static func diff(_ path: String, from a: String, to b: String?) async -> String {
        var args = ["diff", "--no-color", "--no-ext-diff", "-M", a]
        if let b { args.append(b) }
        return await run(path, args, timeout: 60).out
    }

    /// Puts the working folder back as it was in `snapshot`: its files restored, the ones created after it deleted.
    /// Ignored files (builds, dependencies) are left alone. The branch and its commits don't move.
    static func restore(_ path: String, to snapshot: String) async throws {
        let created = try await checked(path, ["diff", "--name-only", "--diff-filter=A", snapshot, "--"], env: [:])
        // Files untracked now that the snapshot didn't have also count as created.
        let untracked = await run(path, ["ls-files", "--others", "--exclude-standard"]).out
        let inSnapshot = Set((await run(path, ["ls-tree", "-r", "--name-only", snapshot]).out).split(separator: "\n").map(String.init))
        var remove = Set(created.split(separator: "\n").map(String.init))
        for f in untracked.split(separator: "\n").map(String.init) where !inSnapshot.contains(f) { remove.insert(f) }
        _ = try await checked(path, ["restore", "--source", snapshot, "--worktree", "--", "."])
        for f in remove where !f.isEmpty && !f.contains("..") {
            try? FileManager.default.removeItem(atPath: (path as NSString).appendingPathComponent(f))
        }
    }

    // MARK: - Worktrees

    static func addWorktree(repo: String, path: String, branch: String, base: String) async throws {
        try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        _ = try await checked(repo, ["worktree", "add", "-b", branch, path, base], timeout: 180)
    }

    static func removeWorktree(repo: String, path: String, branch: String?, deleteBranch: Bool) async throws {
        _ = try await checked(repo, ["worktree", "remove", "--force", path], timeout: 120)
        if deleteBranch, let branch { await run(repo, ["branch", "-D", branch]) }
    }

    // MARK: - Commits

    struct ChangedFile: Identifiable, Hashable, Sendable {
        var path: String
        var status: String
        var added: Int
        var removed: Int
        var id: String { path }
    }

    static func changedFiles(_ path: String) async -> [ChangedFile] {
        let status = await run(path, ["status", "--porcelain=v1", "--untracked-files=all"]).out
        let numstat = await run(path, ["diff", "--numstat", "HEAD"]).out
        var counts: [String: (Int, Int)] = [:]
        for line in numstat.split(separator: "\n") {
            let cols = line.split(separator: "\t", maxSplits: 2)
            if cols.count == 3 { counts[String(cols[2])] = (Int(cols[0]) ?? 0, Int(cols[1]) ?? 0) }
        }
        return status.split(separator: "\n").compactMap { line in
            guard line.count > 3 else { return nil }
            let code = String(line.prefix(2)).trimmingCharacters(in: .whitespaces)
            var file = String(line.dropFirst(3))
            if let arrow = file.range(of: " -> ") { file = String(file[arrow.upperBound...]) }
            var c = counts[file] ?? (0, 0)
            if code == "??" { c = (lineCount((path as NSString).appendingPathComponent(file)), 0) }   // untracked: not in the diff
            return ChangedFile(path: file, status: code == "??" ? "A" : code, added: c.0, removed: c.1)
        }
    }

    /// Lines of a new text file (0 for binaries and anything over 2 MB).
    private static func lineCount(_ file: String) -> Int {
        guard let size = (try? FileManager.default.attributesOfItem(atPath: file))?[.size] as? Int, size < 2_000_000,
              let data = FileManager.default.contents(atPath: file), !data.contains(0) else { return 0 }
        let newlines = data.reduce(0) { $0 + ($1 == 10 ? 1 : 0) }
        return newlines + (data.last.map { $0 == 10 ? 0 : 1 } ?? 0)
    }

    static func commitAll(_ path: String, message: String) async throws {
        _ = try await checked(path, ["add", "-A"], timeout: 120)
        _ = try await checked(path, ["commit", "-q", "-F", "-"], env: [:], timeout: 120, input: message)
    }

    static func checked(_ path: String, _ args: [String], env: [String: String], timeout: TimeInterval, input: String) async throws -> String {
        var e = env
        e["GIT_TERMINAL_PROMPT"] = "0"
        let r = await CommandRunner.run(executable, ["-C", path] + args, env: e, input: input, timeout: timeout)
        guard r.ok else { throw GitError(message: r.message) }
        return r.out
    }

    static func push(_ path: String, branch: String) async throws {
        _ = try await checked(path, ["push", "-u", "origin", branch], timeout: 180)
    }

    /// Lines like "Co-Authored-By: Claude …" or "🤖 Generated with …" that agents add to commit messages.
    static func strippingAgentAttribution(_ message: String) -> String {
        message.components(separatedBy: "\n").filter { line in
            let l = line.lowercased()
            return !(l.hasPrefix("co-authored-by:") && ["claude", "anthropic", "codex", "openai", "gemini", "copilot", "cursor", "noreply"].contains { l.contains($0) })
                && !l.contains("generated with [claude code]") && !l.contains("generated with claude code")
        }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// GitHub through the `gh` CLI (signed in by the user).
enum GitHubCLI {
    static var executable: String? {
        ShellEnvironment.which("gh") ?? ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    static func run(_ path: String, _ args: [String], timeout: TimeInterval = 60) async -> CommandRunner.Result {
        guard let gh = executable else { return CommandRunner.Result(status: -1, out: "", err: "No encuentro el CLI de GitHub (gh). Instálalo con «brew install gh» e inicia sesión con «gh auth login».") }
        return await CommandRunner.run(gh, args, cwd: path, env: ["GH_PROMPT_DISABLED": "1", "NO_COLOR": "1"], timeout: timeout)
    }

    static func createPR(_ path: String, title: String, body: String, base: String?, draft: Bool = false) async throws -> PullRequestInfo {
        var args = ["pr", "create", "--title", title, "--body", body]
        if let base { args += ["--base", base] }
        if draft { args.append("--draft") }
        let r = await run(path, args, timeout: 120)
        guard r.ok else { throw GitError(message: r.message) }
        let url = r.out.split(separator: "\n").last.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        let number = Int(url.split(separator: "/").last ?? "") ?? 0
        return PullRequestInfo(number: number, url: url, state: "OPEN")
    }

    /// State, checks, reviews and comments of a PR, as `gh pr view --json` returns them.
    static func view(_ path: String, number: Int) async -> JSONObject? {
        let fields = "number,url,state,mergeable,statusCheckRollup,reviews,comments,reviewDecision,title"
        let r = await run(path, ["pr", "view", "\(number)", "--json", fields], timeout: 60)
        return r.ok ? JSONUtil.parse(r.out.trimmingCharacters(in: .whitespacesAndNewlines)) : nil
    }
}

/// Lets exactly one of several racing callers through.
final class OnceGate: @unchecked Sendable {
    private let lock = NSLock()
    private var opened = false

    func open() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if opened { return false }
        opened = true
        return true
    }
}
