import Foundation

/// Threads that work in their own git worktree: a folder and branch of their own, so several agents can work
/// on the same repository at once without stepping on each other (or on you).
@MainActor
enum Worktrees {
    static var root: URL {
        if let custom = ProcessInfo.processInfo.environment["RELEVO_WORKTREES_DIR"], !custom.isEmpty {
            return URL(fileURLWithPath: expandTilde(custom), isDirectory: true)
        }
        return URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".relevo/worktrees", isDirectory: true)
    }

    static func slug(_ thread: ThreadModel) -> String { "t-" + thread.id.uuidString.prefix(6).lowercased() }

    /// Creates the worktree from the project's current commit (uncommitted changes in the project stay there).
    static func create(for thread: ThreadModel, project: Project, store: AppStore, from base: String? = nil) async throws -> WorktreeInfo {
        guard await Git.isRepo(project.path) else { throw GitError(message: "«\(project.name)» no es un repositorio git.") }
        let baseBranch = await Git.branch(project.path)
        guard let commit = await Git.head(base ?? project.path) else { throw GitError(message: "El repositorio aún no tiene ningún commit.") }
        let safeName = project.name.replacingOccurrences(of: #"[^A-Za-z0-9._-]"#, with: "-", options: .regularExpression)
        let dir = root.appendingPathComponent(safeName, isDirectory: true).appendingPathComponent(slug(thread)).path
        let branch = "relevo/" + slug(thread)
        try await Git.addWorktree(repo: project.path, path: dir, branch: branch, base: commit)
        var fromBranch = baseBranch
        if let base { fromBranch = await Git.branch(base) }
        let info = WorktreeInfo(path: dir, branch: branch, baseBranch: fromBranch, baseCommit: commit)
        thread.worktree = info
        store.save(thread)
        for action in project.quickActions where action.runOnWorktreeCreate {
            store.actions.run(action, thread: thread, store: store)
        }
        return info
    }

    /// Removes the folder (and the branch, when asked); the thread goes back to the project folder.
    static func remove(_ thread: ThreadModel, store: AppStore, deleteBranch: Bool) async throws {
        guard let w = thread.worktree, let project = store.project(thread.projectId) else { return }
        store.existingRuntime(thread.id)?.closeSession()
        try await Git.removeWorktree(repo: project.path, path: w.path, branch: w.branch, deleteBranch: deleteBranch)
        thread.worktree = nil
        store.save(thread)
    }

    enum MergeProblem: LocalizedError {
        case uncommitted, projectDirty, wrongBranch(String, String), conflict(String)
        var errorDescription: String? {
            switch self {
            case .uncommitted: return "El worktree tiene cambios sin commit. Haz commit primero (botón Git › Commit)."
            case .projectDirty: return "La carpeta del proyecto tiene cambios sin commit: guárdalos o descártalos antes de fusionar."
            case .wrongBranch(let current, let base): return "La carpeta del proyecto está en «\(current)», no en «\(base)». Cámbiala de rama para fusionar."
            case .conflict(let detail): return "Hay conflictos al fusionar; no se ha cambiado nada.\n\(detail)"
            }
        }
    }

    /// Merges the thread's branch into the branch it came from, in the project folder. Aborts on conflicts.
    static func merge(_ thread: ThreadModel, store: AppStore) async throws -> String {
        guard let w = thread.worktree, let project = store.project(thread.projectId) else { throw GitError(message: "El hilo no tiene worktree.") }
        if !(await Git.changedFiles(w.path)).isEmpty { throw MergeProblem.uncommitted }
        let base = w.baseBranch ?? "main"
        let current = await Git.branch(project.path) ?? "HEAD"
        guard current == base else { throw MergeProblem.wrongBranch(current, base) }
        let dirty = await Git.run(project.path, ["status", "--porcelain", "--untracked-files=no"]).out
        guard dirty.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw MergeProblem.projectDirty }
        let r = await Git.run(project.path, ["merge", "--no-edit", w.branch], timeout: 120)
        if !r.ok {
            await Git.run(project.path, ["merge", "--abort"])
            throw MergeProblem.conflict(r.message)
        }
        return r.out.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
