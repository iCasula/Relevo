import SwiftUI
import AppKit

/// Toolbar menu for the thread's folder: branch, changes, commit/push/PR, the PR it opened, and its worktree.
struct GitMenu: View {
    @Environment(AppStore.self) private var store
    let thread: ThreadModel
    let runtime: ThreadRuntime
    @State private var showCommit = false
    @State private var showDiff = false
    @State private var confirmRemove = false
    @State private var message: String?
    @State private var branch: String?

    var body: some View {
        Menu {
            if let w = thread.worktree {
                Text("Worktree · \(w.branch) (desde \(w.baseBranch ?? "HEAD"))")
            } else if let branch {
                Text("Rama \(branch) · carpeta del proyecto")
            }
            Button("Cambios del hilo…", systemImage: "doc.badge.ellipsis") { showDiff = true }
            Button("Commit…", systemImage: "checkmark.circle") { showCommit = true }
            if let pr = thread.pullRequest {
                Divider()
                Button("Abrir PR #\(pr.number) (\(Self.stateName(pr.state)))", systemImage: "arrow.up.right.square") {
                    if let url = URL(string: pr.url) { NSWorkspace.shared.open(url) }
                }
                Toggle("Vigilar checks y comentarios", isOn: Binding(
                    get: { thread.pullRequest?.watching ?? false },
                    set: { on in
                        thread.pullRequest?.watching = on
                        store.save(thread)
                        if on { Task { await store.prWatcher.poll(thread) } }
                    }))
                .disabled(pr.state != "OPEN")
            }
            if let w = thread.worktree {
                Divider()
                Button("Fusionar en \(w.baseBranch ?? "la rama base")", systemImage: "arrow.triangle.merge") {
                    Task {
                        do {
                            let out = try await Worktrees.merge(thread, store: store)
                            runtime.noteFromWatcher("Rama \(w.branch) fusionada en \(w.baseBranch ?? "la base")" + (out.isEmpty ? "" : " · \(out.split(separator: "\n").last ?? "")"))
                        } catch { message = error.localizedDescription }
                    }
                }
                Button("Mostrar en Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: w.path)]) }
                Button("Abrir en Terminal") { ProjectActions.openTerminal(w.path) }
                Divider()
                Button("Eliminar worktree…", role: .destructive) { confirmRemove = true }
            }
        } label: {
            Label(thread.worktree?.branch ?? branch ?? "Git", systemImage: thread.worktree == nil ? "arrow.triangle.branch" : "square.stack.3d.down.right")
        }
        .help(thread.worktree.map { "Worktree propio: \($0.path)" } ?? "Git: cambios, commit, push y PR")
        .task(id: thread.id) { branch = await store.workPath(thread).asyncMap { await Git.branch($0) } ?? nil }
        .sheet(isPresented: $showCommit) { CommitSheet(thread: thread, runtime: runtime) }
        .sheet(isPresented: $showDiff) {
            if let path = store.workPath(thread) {
                DiffSheet(title: "Cambios del hilo", path: path, from: threadBase, to: nil, runtime: runtime)
            }
        }
        .confirmationDialog("¿Eliminar el worktree de este hilo?", isPresented: $confirmRemove) {
            Button("Eliminar carpeta y rama", role: .destructive) { remove(deleteBranch: true) }
            Button("Eliminar solo la carpeta") { remove(deleteBranch: false) }
        } message: {
            Text("Lo que no esté en un commit se pierde. Si borras también la rama, sus commits sin fusionar se pierden.")
        }
        .alert("Git", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("OK") { message = nil }
        } message: { Text(message ?? "") }
    }

    /// Where the thread's changes start: its worktree's base commit, or its first turn's snapshot, or HEAD.
    private var threadBase: String {
        if let w = thread.worktree { return w.baseCommit }
        return thread.items.first(where: { $0.changes != nil })?.changes?.before ?? "HEAD"
    }

    private func remove(deleteBranch: Bool) {
        Task {
            do {
                try await Worktrees.remove(thread, store: store, deleteBranch: deleteBranch)
                runtime.noteFromWatcher("Worktree eliminado; el hilo vuelve a la carpeta del proyecto")
            } catch { message = error.localizedDescription }
        }
    }

    static func stateName(_ state: String) -> String {
        switch state {
        case "OPEN": return "abierto"
        case "MERGED": return "fusionado"
        case "CLOSED": return "cerrado"
        default: return state.lowercased()
        }
    }
}

extension Optional {
    func asyncMap<T>(_ transform: (Wrapped) async -> T) async -> T? {
        guard let self else { return nil }
        return await transform(self)
    }
}

/// Commit the thread's changes, optionally push and open a PR, with a message the utility model can write.
struct CommitSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let thread: ThreadModel
    let runtime: ThreadRuntime
    @State private var files: [Git.ChangedFile] = []
    @State private var message = ""
    @State private var generating = false
    @State private var working: String?
    @State private var error: String?
    @State private var hasRemote = false
    @State private var watch = true
    @State private var branch: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Commit").font(.title2.weight(.semibold))
                if let branch { Text(branch).font(.callout.monospaced()).foregroundStyle(.secondary) }
                Spacer()
            }
            if files.isEmpty {
                Text("No hay cambios sin commit.").foregroundStyle(.secondary)
            } else {
                List(files) { f in
                    HStack {
                        Text(f.status).font(.caption.monospaced().weight(.bold)).frame(width: 18)
                            .foregroundStyle(f.status == "A" ? .green : f.status == "D" ? .red : .orange)
                        Text(f.path).lineLimit(1).truncationMode(.middle)
                        Spacer()
                        Text("+\(f.added) −\(f.removed)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }
                }
                .frame(height: min(220, CGFloat(files.count) * 26 + 14))
            }
            HStack {
                Text("Mensaje").font(.headline)
                Spacer()
                Button {
                    generate()
                } label: {
                    if generating { ProgressView().controlSize(.small) } else { Label("Escribir con IA", systemImage: "sparkles") }
                }
                .disabled(generating || files.isEmpty || store.topicProvider() == nil)
                .help("En inglés, sin líneas de coautor ni menciones a la IA")
            }
            TextEditor(text: $message)
                .font(.body.monospaced())
                .scrollContentBackground(.hidden)
                .padding(6)
                .frame(minHeight: 120)
                .background(Color(nsColor: .textBackgroundColor), in: .rect(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
            if hasRemote {
                Toggle("Vigilar el PR (checks, comentarios y conflictos)", isOn: $watch)
                    .help("Cada dos minutos lo mira con gh y despierta al agente si algo falla o te comentan")
            }
            if let working {
                HStack { ProgressView().controlSize(.small); Text(working).foregroundStyle(.secondary) }
            }
            if let error {
                Text(error).foregroundStyle(.red).font(.callout).textSelection(.enabled)
            }
            HStack {
                Button("Cancelar") { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Commit") { perform(push: false, pr: false) }
                    .disabled(!canCommit)
                Button("Commit y push") { perform(push: true, pr: false) }
                    .disabled(!canCommit || !hasRemote)
                Button("Commit, push y crear PR") { perform(push: true, pr: true) }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canCommit || !hasRemote || thread.pullRequest?.state == "OPEN")
            }
        }
        .padding(20)
        .frame(width: 640)
        .task { await load() }
    }

    private var canCommit: Bool {
        !files.isEmpty && !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && working == nil
    }

    private func load() async {
        guard let path = store.workPath(thread) else { return }
        files = await Git.changedFiles(path)
        hasRemote = await Git.hasRemote(path)
        branch = await Git.branch(path)
    }

    private func generate() {
        guard let path = store.workPath(thread) else { return }
        generating = true
        Task {
            if let text = await CommitWriter.message(for: thread, path: path, store: store) { message = text }
            else { error = "No se pudo escribir el mensaje (¿hay un modelo de utilidad disponible?)." }
            generating = false
        }
    }

    private func perform(push: Bool, pr: Bool) {
        guard let path = store.workPath(thread) else { return }
        let text = Git.strippingAgentAttribution(message)
        error = nil
        Task {
            do {
                working = "Haciendo commit…"
                try await Git.commitAll(path, message: text)
                runtime.noteFromWatcher("Commit: \(text.components(separatedBy: "\n").first ?? "")")
                if push, let branch = await Git.branch(path) {
                    working = "Subiendo \(branch)…"
                    try await Git.push(path, branch: branch)
                    if pr {
                        working = "Creando el PR…"
                        let (title, body) = CommitWriter.pullRequest(from: text, thread: thread, store: store)
                        var info = try await GitHubCLI.createPR(path, title: title, body: body, base: thread.worktree?.baseBranch)
                        info.watching = watch
                        thread.pullRequest = info
                        store.save(thread)
                        runtime.noteFromWatcher("PR #\(info.number) creado" + (watch ? " · lo vigilo" : ""))
                        if let url = URL(string: info.url) { NSWorkspace.shared.open(url) }
                        if watch { await store.prWatcher.poll(thread) }
                    }
                }
                working = nil
                dismiss()
            } catch {
                working = nil
                self.error = error.localizedDescription
            }
        }
    }
}
