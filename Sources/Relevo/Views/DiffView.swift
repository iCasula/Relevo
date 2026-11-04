import SwiftUI
import AppKit

/// What a turn (or the whole thread) changed: files, then the diff of each. Click a line to comment on it;
/// the comments go to the agent as one message. From a turn you can also put the files back as they were.
struct DiffSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let path: String
    let from: String
    /// nil = the working folder as it is now.
    let to: String?
    let runtime: ThreadRuntime
    /// The item whose turn this is, to restore the files to before it.
    var turnItem: ChatItem? = nil

    @State private var files: [DiffFile] = []
    @State private var selected: String?
    @State private var loading = true
    @State private var comments: [DiffComment] = []
    @State private var editing: (file: String, line: DiffFile.Line)?
    @State private var draft = ""
    @State private var confirmRestore = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if loading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if files.isEmpty {
                ContentUnavailableView("Sin cambios", systemImage: "checkmark.circle", description: Text("No hay diferencias en los ficheros."))
            } else {
                HSplitView {
                    fileList.frame(minWidth: 220, idealWidth: 260, maxWidth: 360)
                    diffPane.frame(minWidth: 520)
                }
            }
            if !comments.isEmpty { commentBar }
        }
        .frame(minWidth: 900, minHeight: 600)
        .task { await load() }
        .confirmationDialog("¿Restaurar los ficheros a como estaban antes de este turno?", isPresented: $confirmRestore) {
            Button("Restaurar", role: .destructive) {
                Task {
                    do {
                        if let turnItem { try await runtime.restoreBefore(turnItem) }
                        dismiss()
                    } catch { self.error = error.localizedDescription }
                }
            }
        } message: {
            Text("Se deshacen los cambios de este turno y de los siguientes en la carpeta del hilo (los ignorados por git no se tocan). Lo de ahora se guarda antes y lo puedes recuperar con «Deshacer». Al agente se le avisa con tu próximo mensaje.")
        }
        .alert("No se pudo restaurar", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK") { error = nil }
        } message: { Text(error ?? "") }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                let added = files.reduce(0) { $0 + $1.added }
                let removed = files.reduce(0) { $0 + $1.removed }
                Text("\(files.count) \(files.count == 1 ? "fichero" : "ficheros") · +\(added) −\(removed)")
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            Spacer()
            if turnItem != nil {
                Button("Restaurar a antes de este turno…", systemImage: "arrow.uturn.backward") { confirmRestore = true }
                    .disabled(runtime.isRunning)
                    .help(runtime.isRunning ? "Detén al agente antes de restaurar" : "Devuelve los ficheros a como estaban antes de este turno")
            }
            Button("Cerrar") { dismiss() }.keyboardShortcut(.cancelAction)
        }
        .padding(14)
    }

    private var fileList: some View {
        List(files, selection: $selected) { file in
            HStack(spacing: 6) {
                Text(file.change.rawValue)
                    .font(.caption.monospaced().weight(.bold))
                    .foregroundStyle(file.change == .added ? .green : file.change == .deleted ? .red : .orange)
                    .frame(width: 14)
                Text((file.path as NSString).lastPathComponent).lineLimit(1)
                Spacer(minLength: 4)
                Text("+\(file.added) −\(file.removed)").font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
            }
            .help(file.path)
            .tag(file.path)
        }
    }

    private var diffPane: some View {
        let file = files.first { $0.path == selected } ?? files.first
        return GeometryReader { geo in
            ScrollView([.vertical, .horizontal]) {
                if let file {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        Text(file.oldPath.map { "\($0) → \(file.path)" } ?? file.path)
                            .font(.callout.monospaced().weight(.semibold))
                            .padding(.horizontal, 12).padding(.vertical, 8)
                        if file.isBinary {
                            Text("Fichero binario").foregroundStyle(.secondary).padding(12)
                        }
                        ForEach(file.lines) { line in
                            DiffLineRow(line: line, comment: comments.first { $0.file == file.path && $0.line == (line.new ?? line.old ?? -1) },
                                        width: geo.size.width)
                                .onTapGesture {
                                    guard line.kind != .hunk else { return }
                                    draft = ""
                                    editing = (file.path, line)
                                }
                            if let e = editing, e.file == file.path, e.line.id == line.id {
                                commentEditor(file: file.path, line: line).frame(width: geo.size.width)
                            }
                        }
                    }
                    .padding(.bottom, 20)
                    .textSelection(.enabled)
                }
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
    }

    private func commentEditor(file: String, line: DiffFile.Line) -> some View {
        HStack(alignment: .top, spacing: 8) {
            TextField("Comentario para el agente sobre esta línea", text: $draft, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...5)
                .onSubmit { addComment(file: file, line: line) }
            Button("Añadir") { addComment(file: file, line: line) }.disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
            Button("Cancelar") { editing = nil }
        }
        .padding(10)
        .background(.quaternary.opacity(0.4))
    }

    private func addComment(file: String, line: DiffFile.Line) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        comments.append(DiffComment(file: file, line: line.new ?? line.old ?? 0, code: line.text, text: text))
        editing = nil
        draft = ""
    }

    private var commentBar: some View {
        HStack {
            Label("\(comments.count) \(comments.count == 1 ? "comentario" : "comentarios")", systemImage: "text.bubble")
            Spacer()
            Button("Descartar") { comments.removeAll() }
            Button(runtime.isRunning ? "Poner en cola para el agente" : "Enviar al agente") {
                runtime.sendReviewComments(comments)
                dismiss()
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(12)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }

    private func load() async {
        let text = await Git.diff(path, from: from, to: to)
        files = DiffParser.parse(text)
        selected = files.first?.path
        loading = false
    }
}

private struct DiffLineRow: View {
    let line: DiffFile.Line
    let comment: DiffComment?
    /// The pane's width: rows fill it so their colour runs edge to edge (longer lines scroll sideways).
    let width: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                Text(line.old.map(String.init) ?? "").frame(width: 44, alignment: .trailing).foregroundStyle(.tertiary)
                Text(line.new.map(String.init) ?? "").frame(width: 44, alignment: .trailing).foregroundStyle(.tertiary)
                Text(marker).frame(width: 18).foregroundStyle(markerColor)
                Text(line.text.isEmpty ? " " : line.text)
                    .foregroundStyle(line.kind == .hunk ? Color.secondary : Color.primary)
                    .fixedSize(horizontal: true, vertical: false)
                Spacer(minLength: 0)
            }
            .font(.system(size: 12, design: .monospaced))
            .padding(.vertical, 1)
            .frame(minWidth: width, alignment: .leading)
            .background(background)
            .contentShape(Rectangle())
            if let comment {
                Label(comment.text, systemImage: "text.bubble.fill")
                    .font(.caption)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .frame(width: width, alignment: .leading)
                    .background(Color.accentColor.opacity(0.12))
            }
        }
    }

    private var marker: String {
        switch line.kind {
        case .added: return "+"
        case .removed: return "−"
        default: return ""
        }
    }

    private var markerColor: Color { line.kind == .added ? .green : line.kind == .removed ? .red : .secondary }

    private var background: Color {
        switch line.kind {
        case .added: return Color.green.opacity(0.12)
        case .removed: return Color.red.opacity(0.12)
        case .hunk: return Color.secondary.opacity(0.08)
        case .context: return .clear
        }
    }
}

/// Under the last item of a turn: what it consumed and what it changed on disk.
struct TurnFooter: View {
    let item: ChatItem
    let runtime: ThreadRuntime
    let showUsage: Bool

    var body: some View {
        let usage = showUsage ? item.usage : nil
        if usage != nil || item.changes != nil {
            HStack(spacing: 14) {
                if let usage { TurnUsageFooter(usage: usage) }
                if let changes = item.changes { TurnChangesFooter(item: item, changes: changes, runtime: runtime) }
            }
        }
    }
}

/// Under a reply: what its turn changed on disk; opens the diff.
struct TurnChangesFooter: View {
    let item: ChatItem
    let changes: TurnChanges
    let runtime: ThreadRuntime
    @Environment(AppStore.self) private var store
    @State private var show = false

    var body: some View {
        Button {
            show = true
        } label: {
            Label("\(changes.files) \(changes.files == 1 ? "fichero" : "ficheros") · +\(changes.added) −\(changes.removed)", systemImage: "doc.badge.ellipsis")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .help("Ver lo que cambió este turno, comentarlo o deshacerlo")
        .sheet(isPresented: $show) {
            if let path = store.workPath(runtime.thread) {
                DiffSheet(title: "Cambios de este turno", path: path, from: changes.before, to: changes.after, runtime: runtime, turnItem: item)
            }
        }
    }
}
