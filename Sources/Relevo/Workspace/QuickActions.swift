import Foundation
import Observation

/// A project command run from the thread toolbar (⌃1…⌃9): a build, the tests, a code generator…
struct QuickAction: Codable, Identifiable, Hashable {
    var id = UUID()
    var name: String
    var command: String
    var symbol: String = "play"
    /// Also run it when a worktree is created for a thread (e.g. `xcodegen`, `npm install`).
    var runOnWorktreeCreate = false
}

/// One run of a quick action in a thread's working folder, with its output as it arrives.
@Observable
final class ActionRun: Identifiable {
    enum State: Equatable { case running, succeeded, failed(Int32) }

    let id = UUID()
    let action: QuickAction
    let threadId: UUID
    let cwd: String
    let started = Date()
    var ended: Date?
    var output = ""
    var state: State = .running
    @ObservationIgnored var process: Process?

    init(action: QuickAction, threadId: UUID, cwd: String) {
        self.action = action
        self.threadId = threadId
        self.cwd = cwd
    }

    var isRunning: Bool { state == .running }
    var exitCode: Int32? { if case .failed(let c) = state { return c }; return state == .succeeded ? 0 : nil }
}

@MainActor
@Observable
final class QuickActionRunner {
    private(set) var runs: [ActionRun] = []

    nonisolated init() {}

    func runs(for thread: UUID) -> [ActionRun] { runs.filter { $0.threadId == thread } }

    /// Runs the command with the login shell in the thread's folder (its worktree, if it has one).
    @discardableResult
    func run(_ action: QuickAction, thread: ThreadModel, store: AppStore) -> ActionRun? {
        guard let cwd = store.workPath(thread) else { return nil }
        let run = ActionRun(action: action, threadId: thread.id, cwd: cwd)
        runs.insert(run, at: 0)
        if runs.count > 40 { runs.removeLast(runs.count - 40) }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", action.command]
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        p.environment = ShellEnvironment.env
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        p.standardInput = FileHandle.nullDevice
        pipe.fileHandleForReading.readabilityHandler = { [weak run] handle in
            let data = handle.availableData
            guard !data.isEmpty else { handle.readabilityHandler = nil; return }
            let text = String(decoding: data, as: UTF8.self)
            Task { @MainActor in
                guard let run else { return }
                run.output += text
                if run.output.count > 400_000 { run.output = "…" + String(run.output.suffix(300_000)) }
            }
        }
        p.terminationHandler = { [weak run] proc in
            let status = proc.terminationStatus
            Task { @MainActor in
                guard let run else { return }
                run.ended = Date()
                run.state = status == 0 ? .succeeded : .failed(status)
                store.notifyActionFinished(run, thread: thread)
            }
        }
        do {
            try p.run()
            run.process = p
        } catch {
            run.output = error.localizedDescription
            run.state = .failed(-1)
            run.ended = Date()
        }
        return run
    }

    func stop(_ run: ActionRun) {
        run.process?.terminate()
    }

    /// The end of the output as a message for the agent (build errors, failing tests…).
    static func message(for run: ActionRun) -> String {
        let tail = String(run.output.suffix(6000)).trimmingCharacters(in: .whitespacesAndNewlines)
        let result = run.state == .succeeded ? "terminó bien" : "falló (código \(run.exitCode ?? -1))"
        return "He ejecutado «\(run.action.name)» (`\(run.action.command)`) y \(result). Salida:\n\n```\n\(tail)\n```"
    }
}
