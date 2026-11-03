import Foundation

/// Read-only snapshot of a project's git state, used to tell the next agent what is on disk.
struct GitSnapshot {
    var branch: String
    var head: String
    var headSubject: String
    var status: [String]
    var diffStat: [String]
    var commitsSince: [String]

    static func head(_ path: String) async -> String? {
        await Task.detached { run(path, ["rev-parse", "HEAD"])?.trimmingCharacters(in: .whitespacesAndNewlines) }.value
    }

    static func capture(_ path: String, since base: String? = nil) async -> GitSnapshot? {
        await Task.detached { () -> GitSnapshot? in
            guard run(path, ["rev-parse", "--is-inside-work-tree"])?.contains("true") == true else { return nil }
            let branch = run(path, ["rev-parse", "--abbrev-ref", "HEAD"])?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "?"
            let log = run(path, ["log", "-1", "--format=%h%x09%s"])?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let parts = log.split(separator: "\t", maxSplits: 1).map(String.init)
            let status = lines(run(path, ["status", "--porcelain=v1", "--untracked-files=normal"]), max: 80)
            let stat = lines(run(path, ["diff", "--stat=120", "HEAD"]), max: 40)
            var commits: [String] = []
            if let base, !base.isEmpty {
                commits = lines(run(path, ["log", "--oneline", "--no-decorate", "\(base)..HEAD"]), max: 30)
            }
            return GitSnapshot(branch: branch, head: parts.first ?? "", headSubject: parts.count > 1 ? parts[1] : "",
                               status: status, diffStat: stat, commitsSince: commits)
        }.value
    }

    private static func lines(_ text: String?, max: Int) -> [String] {
        let all = (text ?? "").split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        if all.count <= max { return all }
        return Array(all.prefix(max)) + ["… (\(all.count - max) líneas más)"]
    }

    private static func run(_ path: String, _ args: [String], timeout: TimeInterval = 8) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", path] + args
        var env = ShellEnvironment.env
        env["GIT_OPTIONAL_LOCKS"] = "0"   // never fight an agent for the index lock
        env["GIT_TERMINAL_PROMPT"] = "0"
        p.environment = env
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { if p.isRunning { p.terminate() } }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { return nil }
        return String(decoding: data, as: UTF8.self)
    }
}
